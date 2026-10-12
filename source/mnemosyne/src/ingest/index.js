import { announceWrites } from '../announce.js';
import { INGEST_DEFAULTS } from '../config.js';
import { readPromptTemplate } from '../settings.js';
import { normal, sensitive } from '../logging.js';
import { embedText, retrievalScopes } from '../schema.js';
import { epochOf, locked, noteGate, noteOutcome, registerPerUserState } from '../session-state.js';

import { readBaseline } from './baseline.js';
import { HostContext } from '../host/context.js';
import { buildExtractionGrammar, buildWindowText, describeUnparsed, parseExtraction, renderExtractionPrompt, windowSlice } from './extraction.js';
import { _resetFaults, reportOnce } from './faults.js';
import { describeFailure } from './diagnose.js';
import { originOf, placeCandidate } from './placement.js';
import { fitLength, normalize, passesQuality } from './quality.js';

/**
 * Automatic ingest — turning a conversation into curated long-term memories, on its own.
 *
 * The manual write route (`POST .../memory`) is a curated memory arriving by hand. This is the same
 * destination reached without a hand: on a trigger, read the recent conversation, ask the model which few facts
 * are worth remembering months from now, and store the survivors after checking they are neither already known
 * nor a stale version of something known. The evidence behind every number here is recorded in the design.
 *
 * Three properties this module must never violate, because each was learned the hard way (see the design's
 * landmines):
 *
 *  1. 🔴 It is OFF the critical path. `maybeIngest` is called fire-and-forget from the prompt interceptor and is
 *     never awaited; it must therefore never throw into its caller and never block a user's reply. Everything
 *     below runs inside a try/catch that degrades to "did nothing".
 *  2. 🔴 The high-water mark advances ONLY on a successful extraction. A failed or lost run leaves the mark
 *     where it was, and the conversation history is the durable queue that the next tick re-reads. There is no
 *     flush on lock and there must never be one — a lost race is caught up after the next unlock.
 *  3. 🔴 The extractor is the RP-tuned chat model, the model most prone to continuing the story instead of
 *     extracting from it. Garbage output is a RETRIED FAILURE, not an empty result: it does not advance the
 *     mark. Only an explicit `NONE` means "nothing durable here".
 */

/** In-flight extraction per user handle — one GPU, so extraction is serialized per user (§4.1, landmine 5). */
const inFlight = new Set();

/**
 * Garbage-retry counters: handle → (chatKey → { atHighWater, count }).
 *
 * In memory, and losing one is always SAFE — a dropped counter means the next garbage extraction is retried
 * from zero, which is the conservative direction. Keeping a STALE one is not safe, and that asymmetry is the
 * whole reason for the shape below.
 *
 * 🔴 **REGISTERED PER-USER, so a vault lock drops it.** It used to be a flat `Map` keyed by chat, which meant
 * it belonged to no user and was therefore cleared by nothing: chat ids — user-authored, however opaque they
 * look (`logging.js`) — stayed resident after logout, and the map grew for the life of the process.
 *
 * 🔴 **And dropped when a chat is deleted or renamed** — see {@link forgetChatRetries}. `MemoryStore.forgetChat`
 * already deletes the chat's `ingest_state` for a stated reason: *"leaving it would make a later chat reusing
 * the id start life already 'extracted'."* The identical argument applies here and was not being honored,
 * because this map lives in memory where a database transaction cannot reach it. A chat whose first extraction
 * returned garbage, deleted and recreated under the same id, met a stale `{ atHighWater: -1, count: 1 }` that
 * matches a brand-new chat's starting mark — so one more garbage pass hit `maxFailedAttempts` and
 * force-advanced, and the new chat silently lost its first window. Same failure the database-side deletion
 * exists to prevent, arriving through the in-memory door.
 *
 * @type {Map<string, Map<string, { atHighWater: number, count: number }>>}
 */
const failureCounts = registerPerUserState(new Map());

/**
 * Forget the retry counters for one chat.
 *
 * 🔴 Called when a chat is DELETED or RENAMED (wired in `src/index.js`, beside the store's own handling), so a
 * counter can never outlive the chat it counts. Dropping one costs at most a retry; keeping a stale one costs
 * a new chat its first window, silently. See {@link failureCounts}.
 *
 * ⚠️ Takes the chat id **exactly as `OutgoingPrompt.chatId` spells it**, the same contract
 * `MemoryStore.forgetChat` and `rekeyChat` keep — a differently-spelled id clears nothing and says so nowhere.
 *
 * @param {string} handle The user whose chat it was
 * @param {string} chatId The chat id, byte-identical to the one memories were written under
 * @returns {void}
 */
export function forgetChatRetries(handle, chatId) {
    failureCounts.get(handle)?.delete(chatId);
}

/**
 * Test seam. Not part of the plugin contract — called by src/index.js's `_reset()`, so a suite gets one reset
 * rather than several to remember.
 *
 * 🔴 The say-once fault set above all (now `faults.js`): without clearing it a test asserting that a broken
 * install warns would pass alone and fail after any earlier test on the same handle had already consumed the
 * warning. The in-flight and failure counters go for the same reason — module state that outlives a test is a
 * test that depends on its neighbors.
 *
 * 🔴 {@link windowlessRuns} is the same hazard wearing a subtler hat, and it bit immediately. Its `everSawWindow`
 * latch is DESIGNED to be permanent — one real window disarms the no-window fault for that handle for the life of
 * the process — so any earlier test that ingested normally as `u` silently disarms every later test asserting
 * that `u` warns. Registering it as per-user state is not enough: that clears on vault LOCK, and a test suite
 * never locks.
 *
 * @returns {void}
 */
export function _resetIngest() {
    _resetFaults();
    failureCounts.clear();
    inFlight.clear();
    windowlessRuns.clear();
}

/**
 * How many window-less generations an *unlabeled* handle may accumulate before the missing window is called a
 * fault. See {@link windowlessRuns} for why a threshold is needed at all, and why this number is not tuned.
 *
 * Small enough that a genuinely broken fork is reported within a minute or two of use; large enough that a
 * background extension chattering away before the user's first real turn cannot reach it on its own.
 */
const WINDOWLESS_BEFORE_FAULT = 10;

/**
 * How far the wire ceiling is raised for the ONE retry a starved thinking model earns, and the hard stop on it.
 *
 * ⚠️ Constants rather than settings, deliberately. This is a repair for a ceiling that was set too low, not a
 * budget anybody should be tuning: the fix for a model that repeatedly needs it is to raise
 * `extractCeilingTokens` itself, which is exactly what the warning at the retry says. A knob here would let a
 * user turn a one-off repair into a standing allowance and stop seeing the line telling them why they keep
 * paying for it.
 *
 * 🔴 `CEILING_RETRY_MAX` is what stops a raise from becoming a runaway's second wind. The retry is already
 * gated on an EMPTY answer, which a runaway never has — this is the belt to that pair of braces.
 */
const CEILING_RETRY_FACTOR = 2;
/** @see CEILING_RETRY_FACTOR */
const CEILING_RETRY_MAX = 32000;

/**
 * Track window-less generations until a handle has delivered a window. Missing `recentMessages` is ambiguous on
 * ordinary generations because both user turns and third-party utility requests may omit `genType`; a labeled
 * generation is known to come from `Generate()` and faults immediately, while unlabeled ones fault only after a
 * sustained run. One observed window disarms the warning for that handle. Per-user registration lets vault lock
 * clear this process-local state, as it does {@link failureCounts}.
 *
 * @type {Map<string, { runs: number, everSawWindow: boolean }>}
 */
const windowlessRuns = registerPerUserState(new Map());

/**
 * Record that a generation carried a real window, disarming the no-window fault for this handle for ever.
 *
 * Idempotent and called on the hot path, so it returns early once latched rather than rewriting the entry.
 *
 * @param {string} handle
 * @returns {void}
 */
function noteWindowSeen(handle) {
    const seen = windowlessRuns.get(handle);
    if (seen?.everSawWindow) {
        return;
    }
    windowlessRuns.set(handle, { runs: seen?.runs ?? 0, everSawWindow: true });
}

/**
 * Count a window-less generation and say whether it is now enough to call the missing window a fault.
 *
 * @param {string} handle
 * @returns {boolean} True exactly once, on the run that crosses {@link WINDOWLESS_BEFORE_FAULT}
 */
function windowlessRunIsFault(handle) {
    const seen = windowlessRuns.get(handle) ?? { runs: 0, everSawWindow: false };
    if (seen.everSawWindow) {
        return false;                                         // proven working — this is utility traffic
    }
    const runs = seen.runs + 1;
    windowlessRuns.set(handle, { runs, everSawWindow: false });
    return runs >= WINDOWLESS_BEFORE_FAULT;
}

/**
 * The trigger gate and the extraction run (§4.1 → §5.3). Called fire-and-forget from the prompt interceptor
 * after retrieval; never awaited, so it owns its own failure and never lets one reach the caller.
 *
 * Declines silently (does nothing) when: the fork handed over no window (`recentMessages` undefined — routine on
 * anything `Generate()` did not issue, see {@link windowlessRuns}) or an empty one; there is no per-chat key to
 * track against; too few new turns, or the previous attempt failed and its retry backoff has not elapsed; or an
 * extraction for this user is already in
 * flight.
 *
 * @param {object} args
 * @param {string} args.handle The user this generation belongs to
 * @param {import('./placement.js').IngestIdentity} args.identity
 *        The generation's three scoping axes plus the display name (src/schema.js). `chatId` doubles as the
 *        high-water mark's key; absent → decline.
 * @param {string} [args.genType] The fork's verbatim generation kind (fork §18). 🔴 NOT on `identity` — that
 *        object is the scoping axes and feeds `scopeKey`/`retrievalScopes`, and a generation kind is not an
 *        identity. Its only job here is reporting: PRESENT proves `Generate()` issued this, so a missing window
 *        is a fault immediately. Absent proves nothing either way — see {@link windowlessRuns}.
 * @param {ForkRecentMessage[]} [args.recentMessages] The fork's window. Absent is routine, not an error — see
 *        {@link windowlessRuns} — and is the FIRST thing tested below.
 * @param {import('../store.js').MemoryStore} args.store The caller's open store.
 * @param {import('../host/context.js').HostContext} args.context The fork, as we are allowed to see it.
 *        🔴 The WRAPPER, not a raw plugin context: `generate` and `embed` are called on it below with no guard
 *        of their own, and `HostContext` is what turns a fork that lacks one into a stated error rather than a
 *        `TypeError` reported as "Details suppressed" (see `capabilities.js`). `src/index.js` hands ingest
 *        `host` for exactly that reason.
 * @param {number} [args.now] Injectable clock, for tests.
 * @param {import('../config.js').IngestDefaults} [args.defaults]
 * @returns {Promise<void>}
 */
export async function maybeIngest({ handle, identity, genType, recentMessages, store, context, now = Date.now(), defaults = INGEST_DEFAULTS }) {
    // 🔴 DECLARED OUT HERE BECAUSE THE `catch` NEEDS IT AND `fresh` IS SCOPED TO THE `try`. The backoff
    // records HOW MANY fresh turns there were when the attempt failed, so the retry can require a further
    // `retryBackoffTurns` on top — and a `catch` that could not see that number would have to fall back to a
    // clock, which is the thing this design exists to avoid. 0 until the count is known, which is also the
    // right value for a failure that happened before there was anything to count.
    let freshTurns = 0;

    // 🔒 READ BEFORE THE FIRST `await`, for the same reason `runExtraction` reads one: the only `await` on this
    // path is `runExtraction`, and the `catch` below runs after it — so a user who logs out mid-extraction
    // reaches `noteOutcome` with the vault already locked and its per-user maps already cleared. The epoch taken
    // here is the one the lock invalidates, which is what lets that write be refused instead of resurrecting a
    // locked user's chat id. See {@link locked} in session-state.js.
    const epoch = epochOf(handle);

    try {
        const chatKey = identity?.chatId;

        // The fork's declared window (fork §17.3), built by `Generate()` and riding only the generations that
        // path issues. `undefined` means none arrived; `[]` means a chat with no turns. Both decline — the only
        // question below is whether the absence is worth spending this handle's one say-once report on.
        if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
            // `[]` is never a fault: a chat with no turns yet is a new chat, not a broken fork. `undefined` is a
            // fault only once something proves a window was actually owed — either this generation is LABELED,
            // which only `Generate()` does, or enough unlabeled ones have gone by with no window ever appearing.
            // A labeled generation faults immediately; unlabeled requests use the per-handle sustained-run check.
            if (recentMessages === undefined && (genType !== undefined || windowlessRunIsFault(handle))) {
                // ⚠️ "...and retrieval are unaffected" stood here until 1.8.0. It stopped being true then: a
                // generation with no window is treated as a background request and is not recalled into
                // either (`isBackground`, src/index.js).
                reportOnce(handle, 'no-window', '[Mnemosyne] ingest declined a generation that should have ' +
                    'carried a recentMessages window and did not. Nothing is recalled into or extracted from ' +
                    'a generation that arrives this way — if every generation does, memory will never run at ' +
                    'all, though manual POSTs are unaffected. Said once per user.');
            }
            return;
        }

        // Once this handle has delivered a window, later window-less requests are not a fork-wide regression.
        noteWindowSeen(handle);

        if (!chatKey) {
            // Without a chat key there is no per-chat high-water mark. Reaching this branch also proves the
            // request carried a window, which only chat generations provide.
            reportOnce(handle, 'no-chat-id', '[Mnemosyne] ingest cannot run: a chat generation carried no ' +
                'chatId, so there is no per-chat high-water mark to advance. Nothing will be extracted for that ' +
                'user until it does, though manual POSTs and retrieval are unaffected. Said once per user.');
            return;
        }
        if (inFlight.has(handle)) {
            normal().info('[Mnemosyne] ingest: an extraction is already running for this user — skipping this turn.');
            sensitive().debug('[Mnemosyne] That skip was for %s.', handle);
            return;                                           // one GPU: serialize extraction per user
        }

        // `chat` indexes are zero-based; -1 means no turn has been extracted. Persisted marks are real indexes.
        const persisted = store.getIngestState(chatKey);
        const state = persisted ?? { highWater: -1, lastRun: 0, failedAtTurns: 0 };
        const lastIndex = recentMessages[recentMessages.length - 1].index;

        // Message deletion can shift indexes below the saved high-water mark and leave no fresh turns. Clamp to
        // the available window end so ingestion loses some coverage rather than stalling indefinitely.
        if (lastIndex < state.highWater) {
            normal().warn(
                '[Mnemosyne] ingest: a chat\'s high-water mark is ahead of the conversation (%d > %d) — ' +
                'messages were deleted. Clamping to the end of the window and resuming from there; some history ' +
                'will not be extracted.',
                state.highWater, lastIndex,
            );
            sensitive().debug('[Mnemosyne] That clamp was for chat %s.', chatKey);
            // `failedAtTurns` carried through: a clamp is not a failure, and it is not a success either,
            // so it must neither start a backoff nor clear one that is already running.
            store.setIngestState(chatKey, { highWater: lastIndex, lastRun: state.lastRun, failedAtTurns: state.failedAtTurns });
            return;
        }

        // 🔴 A WINDOW WITH NO NUMERIC `index` WEDGES INGEST FOR EVER AND BLAMES THE CONVERSATION.
        //
        // Everything below compares `m.index > highWater`, and `undefined > -1` is FALSE — so a fork build that
        // renamed or omitted `index` makes `fresh` permanently empty, and the only line emitted is
        // "0/12 fresh turns — waiting." on every generation, which reads as a quiet chat rather than a broken
        // contract. The analogous missing-WINDOW case has `windowlessRuns`/`reportOnce` precisely because a
        // silent structural break is the worst kind; this one had nothing.
        if (!recentMessages.some(m => typeof m.index === 'number')) {
            reportOnce(handle, 'no-index',
                '[Mnemosyne] ingest: this fork\'s conversation window carries no numeric `index` on its ' +
                'messages, so no turn can ever be counted as fresh and automatic memory will never fire. ' +
                'This is a fork contract break, not an empty chat. Update the fork to fix it.');
            return;
        }

        // 🔴 COUNT the fresh turns — never subtract indices. `index` is sparse (hidden and system messages leave
        // gaps), so `lastIndex - highWater` over-counts wherever anything is hidden and would fire early.
        const fresh = recentMessages.filter(m => m.index > state.highWater);

        freshTurns = fresh.length;

        // 🔴 THE ABSENCE OF AN INGEST_STATE ROW IS THE "SCENARIO STARTED" SIGNAL, and it is the only one
        // available to a server-side plugin. `getIngestState` returned null, so this is the first generation
        // this chat has ever produced — the opening — and the opening is exactly the part that a
        // twelve-message gate can never record. See `firstPassMessages`.
        const opening = persisted === null;
        const needed = opening ? defaults.firstPassMessages : defaults.triggerMessages;

        // 🔴 Recorded whether or not the gate opens, because the panel's whole job is to explain a SILENCE
        // (fork panel design §14.8). This count used to be computed here and thrown away — it reached the log
        // line below and nothing else — and the panel cannot recompute it, having no window of its own.
        noteGate(handle, { fresh: fresh.length, needed, chatId: chatKey, at: now });

        if (fresh.length < needed) {
            // Logged every turn, deliberately. This counter ticking upward is the only proof from outside that the
            // gate is alive and counting the right thing — and if it is counting the WRONG thing (the sparse-index
            // trap in buildWindowText's note), watching it move is how that shows up.
            normal().info('[Mnemosyne] ingest: %d/%d fresh turns — waiting.%s', fresh.length, needed,
                opening ? ' (first pass for this chat)' : '');
            sensitive().debug('[Mnemosyne] That count was for chat %s (%s).', chatKey, handle);
            return;                                           // not enough new conversation yet
        }
        // 🔴 THE ONLY GATE BESIDES THE TURN COUNT, AND IT MEASURES IN TURNS TOO — THERE IS NO CLOCK HERE.
        //
        // `failedAtTurns` is 0 unless the PREVIOUS attempt actually threw, so typing quickly can never land
        // here; that is a property of the condition rather than of the number. What it stops is a hot loop:
        // the trigger is a fresh-turn count and a failure does not advance the mark, so that count only
        // grows — a persistent fault (backend down, a fork without `generate`) would otherwise fire a full
        // extraction on every single generation, for ever.
        //
        // ⚠️ Ten minutes of silence changes nothing; ten more messages do. That is the point of counting
        // turns rather than seconds, and it is why an idle chat is never quietly "ready" again.
        // 🔴 CLAMPED TO WHAT `fresh` CAN ACTUALLY REACH, OR THE BACKOFF BECOMES A DEATH SENTENCE.
        //
        // `fresh` is `recentMessages` filtered, and `recentMessages` is the window we declare to the fork —
        // 50. So `fresh.length` SATURATES at 50 and cannot grow past it however long the conversation runs.
        // The threshold, meanwhile, ratcheted: stamped at the fresh count of each failure and 12 added on top.
        // With a backend that is simply down, that reads
        //
        //     fail at 12 → retry at 24 → fail at 24 → retry at 36 → fail at 36 → retry at 48
        //     → fail at 48 → **retry at 60**, which a 50-message window can never produce
        //
        // and `failedAtTurns` is cleared only by `advance()`, which only a pass that actually RAN can reach.
        // So after four failures automatic ingest was dead for that chat for ever — silently, on a log line
        // that says "retrying at 60" every single generation, and fixing the backend did not bring it back.
        // That is the exact "wedge" the docblock beside `retryBackoffTurns` claims this design prevents, and
        // it wedges a step earlier than the arithmetic suggests: a chat with hidden or system messages never
        // reaches 48 either. Found by two independent reviews of the same branch.
        //
        // ⚠️ **THE RESIDUAL, STATED RATHER THAN PAPERED OVER.** Once `fresh` saturates against a still-broken
        // backend, this clamp retries on every generation — the hot loop the backoff exists to prevent. That
        // is a deliberate trade in the direction this file already chose everywhere else: *lose coverage,
        // never wedge*. A wasted call per turn on a backend that is already failing is recoverable the moment
        // it comes back; "never again, silently" is not. The clean fix is to count the backoff on an axis that
        // does not saturate — the message INDEX rather than the fresh COUNT — which changes what the stored
        // `failed_at_turns` column means and is therefore a schema decision, not a drive-by.
        const retryAt = Math.min(state.failedAtTurns + defaults.retryBackoffTurns, defaults.recentMessages);

        if (state.failedAtTurns > 0 && fresh.length < retryAt) {
            normal().info(
                '[Mnemosyne] ingest: %d fresh turns, but the last attempt FAILED at %d — retrying at %d.',
                fresh.length, state.failedAtTurns, retryAt,
            );
            sensitive().debug('[Mnemosyne] That retry backoff was for chat %s (%s).', chatKey, handle);
            return;                                           // backing off a failing extraction
        }

        inFlight.add(handle);
        try {
            // The cast is `chatKey`'s guard, restated: this line is unreachable unless `identity.chatId` was a
            // non-empty string, and everything past here keys a high-water mark on it. See ExtractingIdentity.
            await runExtraction({ handle, identity: /** @type {ExtractingIdentity} */ (identity), recentMessages, store, context, now, defaults, highWater: state.highWater });
        } finally {
            inFlight.delete(handle);
        }
    } catch (error) {
        // 🔴 Never throws into the caller. A failed ingest is a missing memory, never a failed reply.
        //
        // 🔴 AND IT MUST NOT BECOME A HOT LOOP. This catch used to leave the timestamps untouched, which reads
        // as harmless — nothing was extracted, so nothing is marked done. But the trigger gate is a
        // fresh-turn count, and after a failure that count only grows. So a PERSISTENT fault — the backend
        // down, `--nomodel`, a fork without `generate` — fires a full extraction on every single generation,
        // for ever, each one burning a GPU pass that competes with the user's own reply. The `garbage` path
        // has `maxFailedAttempts` for exactly this; the exception path had nothing.
        //
        // 🔴 **STAMPING `failedAtTurns` — HOW MANY FRESH TURNS THERE WERE WHEN IT FAILED, NOT WHEN.** This
        // used to write `lastRun` so the pacing cooldown would throttle the retry, which worked and welded
        // the backoff to a wall-clock gate that also throttled users for typing quickly. Schema v6 gives the
        // failure its own field, and that field counts turns, so no clock survives anywhere in ingest.
        //
        // ⚠️ `highWater` is deliberately NOT advanced, so no conversation is marked processed and the turns
        // are still there when the fault clears. And the next SUCCESSFUL run clears `failedAtTurns` back to 0
        // by omission (see `setIngestState`), so one good pass ends the backoff outright.
        try {
            const chatId = identity?.chatId;
            // 🔴 ONLY WHERE A ROW ALREADY EXISTS. The ABSENCE of an `ingest_state` row is the "this chat is
            // opening" signal — the only one a server-side plugin gets — and it is what makes the first pass
            // fire at `firstPassMessages` instead of `triggerMessages`. Creating a row here to throttle a
            // retry would spend that signal on a pass that extracted NOTHING, so a chat whose very first
            // attempt hit a transient fault would silently lose its opening for ever: exactly the history the
            // first pass exists to capture, dropped by the error handler.
            //
            // ⚠️ The residual, stated rather than papered over: a chat with no row yet still retries on every
            // generation while the fault persists. That is the narrow case (one chat, only until its first
            // successful pass) and it is the safe direction — the alternative trades a permanent, silent loss
            // of a scenario's opening for some wasted calls on a backend that is already failing.
            const existing = (store && chatId) ? store.getIngestState(chatId) : null;

            if (existing) {
                // The cast is the line above, restated: `existing` is non-null only on the branch that already
                // proved `chatId` is a non-empty string, and a `null` here would key a chat's progress under
                // nothing. The checker cannot carry that narrowing across the two statements; it holds anyway.
                store.setIngestState(/** @type {string} */ (chatId), {
                    highWater: existing.highWater,
                    lastRun: existing.lastRun,
                    failedAtTurns: freshTurns,
                });
            }
        } catch {
            // The store is locked or gone. Nothing to throttle against, and this is a catch block — it does
            // not get to fail.
        }

        // 🔴 THE REASON ON THE NORMAL CHANNEL, NOT THE CLASS. This used to report `error.name` alone, reasoning
        // that a name is not user content but a message can be. Both halves of that are true and the result was
        // still useless: every throw on this path is a plain `Error`, so an install where extraction had NEVER
        // ONCE SUCCEEDED reported itself as `(Error)` on every turn for ever. `describeFailure` is what closes
        // that gap without conceding the rule — it translates the fork's own authored messages into
        // content-free sentences and refuses to quote anything it does not recognize. See ingest/diagnose.js,
        // and note especially why the HTTP branch keeps the status and drops everything after it.
        //
        // ⚠️ `Partial<Error>` is the whole claim being made about a caught value: `throw` takes anything, so
        // both fields are read as possibly-absent — which is what the `??` on the sensitive line is for.
        const { reason, fix } = describeFailure(error);

        // 🔴 RECORDED BEFORE IT IS LOGGED, because the panel is the surface the user actually looks at. A log
        // line nobody reads is how this failure stayed invisible for the life of an install.
        noteOutcome(handle, { ok: false, reason, fix, chatId: identity?.chatId ?? null, at: now, epoch });

        normal().error(
            '[Mnemosyne] ingest declined: %s. No memories from this turn, and the next attempt waits for the ' +
            'retry backoff.%s',
            reason,
            fix ? ` ${fix}` : '',
        );
        sensitive().error('[Mnemosyne] That decline was for %s: %s', handle, /** @type {Partial<Error>} */ (error)?.message ?? error);
    }
}

/**
 * An `IngestIdentity` (placement.js) that has been past the trigger gate, where a missing `chatId` is the one
 * axis that declines outright: there is nowhere to keep a high-water mark, so the pass could only ever re-read
 * the same turns for ever.
 *
 * 🔴 Its own type rather than a `??` at each use, because `chatKey` is what every `ingest_state` read and write
 * below is keyed on — and a `null` reaching one of those would not fail, it would silently key a chat's
 * progress under nothing.
 *
 * @typedef {import('./placement.js').IngestIdentity & { chatId: string }} ExtractingIdentity
 */

/**
 * One extraction pass, from the window the gate approved to the memories it produced.
 *
 * @param {object} args
 * @param {string} args.handle
 * @param {ExtractingIdentity} args.identity
 * @param {ForkRecentMessage[]} args.recentMessages The fork's window, in full — {@link windowSlice} decides
 *        which part of it the extractor reads
 * @param {import('../store.js').MemoryStore} args.store
 * @param {import('../host/context.js').HostContext} args.context The wrapper — see {@link maybeIngest}
 * @param {number} args.now
 * @param {import('../config.js').IngestDefaults} args.defaults
 * @param {number} args.highWater The `chat`-relative index of the last extracted turn, or -1 for a chat that
 *        has never been extracted. 🔴 -1 and not 0 — see the note at its source in {@link maybeIngest}.
 * @returns {Promise<void>}
 */
async function runExtraction({ handle, identity, recentMessages, store, context, now, defaults, highWater }) {
    // 🔒 The lock generation BEFORE any await in this function. An extraction is seconds long — a card read, a
    // generation, an embed batch — and the user can log out inside it. `announceWrites` hands this to
    // `noteIngest`, which refuses to write a record for a vault that has closed since. Without it, a pass
    // finishing after logout deposits that user's memory statements into a map the lock has already emptied,
    // where they stay until the next lock or for ever. See `locked()` in session-state.js.
    const epoch = epochOf(handle);

    const { chatId: chatKey } = identity;

    /**
     * Mark this window processed.
     *
     * @param {{ recordOutcome?: boolean }} [opts] `recordOutcome: false` advances the mark WITHOUT stamping a
     *   success — for the give-up path, which has already recorded the failure the user needs to see.
     */
    const advance = ({ recordOutcome = true } = {}) => {
        // 🔴 The mark is the last turn's `chat`-relative INDEX, never a count of messages. A length would wedge
        // the gate the moment the window filled up, since a bounded window's length stops growing (fork §17.8).
        store.setIngestState(chatKey, { highWater: recentMessages[recentMessages.length - 1].index, lastRun: now });
        failureCounts.get(handle)?.delete(chatKey);
        // 🔴 THE ONLY PLACE THE PANEL'S RED BANNER IS CLEARED, and it is here rather than at each caller for the
        // same reason `failureCounts` is: advancing the mark is what "this window is done with" MEANS. Every
        // path that reaches it has genuinely finished a window — stored rows, an honest NONE, a window of empty
        // messages — and every path that has not, has not called it.
        //
        // ⚠️ The give-up-after-`maxFailedAttempts` path also lands here, and clearing the RETRY COUNTER on it
        // is correct: the pass is over and coverage was lost. What it must NOT do is stamp a success.
        //
        // 🔴 IT DID, AND IT OVERWROTE THE ONLY REPORT OF THE WORST FAILURE THERE IS. This comment used to end
        // "…it is `noteOutcome` at that call site which has already recorded the failure the user needs to
        // see" — and then the very next line replaced it. `noteOutcome` REPLACES the whole record and resets
        // `consecutive` to 0 (session-state.js), so the give-up path recorded `ok: false`, called `advance()`,
        // and stamped `ok: true` over it in the same synchronous breath. A user whose model cannot follow the
        // extraction instruction at all — the fault most likely to be the model's fitness rather than a broken
        // install — saw a green panel over a store that never gained a memory, and `consecutive` could never
        // climb past 1 to say how long it had been happening. A comment that argues against the line beside it
        // is a bug report, not documentation.
        if (recordOutcome) {
            noteOutcome(handle, { ok: true, chatId: chatKey, at: now, epoch });
        }
    };

    const windowMessages = windowSlice(recentMessages, highWater, defaults);

    // 🔴 SAY WHAT IS BEING MARKED PROCESSED WITHOUT BEING READ. `advance()` moves the mark to the LAST turn in
    // the window, so every turn between the old mark and the start of the window is declared extracted having
    // never been shown to the extractor. Two ways that happens, both silent until now:
    //
    //   • Installing Mnemosyne into an existing chat. The first pass sees the fork's window (up to
    //     `recentMessages`), `windowSlice` trims it to `windowMax`, and everything before that — potentially
    //     hundreds of turns of history — is marked done. This is the common case, not an edge one.
    //   • A backlog. If `inFlight` or a fault parked the mark while more than `windowMax` turns accumulated,
    //     the excess is skipped the same way.
    //
    // Nothing is wrong with the behavior — a bounded window is the whole design, and re-reading history the
    // model has already forgotten is not free. What was wrong was doing it in silence, so a user whose first
    // months of a chat produced no memories had nothing anywhere to explain why. Counts and indices only.
    const fresh = recentMessages.filter(m => m.index > highWater);

    if (fresh.length > windowMessages.length) {
        normal().warn(
            '[Mnemosyne] ingest: %d turns are past the mark but only the newest %d fit the window — the other ' +
            '%d are being marked processed WITHOUT being read, and will never be extracted. This is normal on ' +
            'the first pass in a pre-existing chat; it is a backlog otherwise.',
            fresh.length, windowMessages.length, fresh.length - windowMessages.length,
        );
        sensitive().debug('[Mnemosyne] Those skipped turns were in chat %s (%s).', chatKey, handle);
    }

    // The other half, and the one no count above can see: history the fork's window never reached at all. If
    // the oldest turn we were handed is not the start of the conversation, everything before it is invisible
    // here and is about to be marked done by an `advance()` that has no idea it exists.
    if (highWater < 0 && recentMessages.length > 0 && recentMessages[0].index > 0) {
        normal().warn(
            '[Mnemosyne] ingest: this chat already had %d turns before Mnemosyne first saw it. They are not in ' +
            'the fork\'s window, so they cannot be extracted, and the mark is about to move past them.',
            recentMessages[0].index,
        );
    }

    // 🔴 `guardDeletedChat` is `highWater >= 0`: the opening pass has no `ingest_state` row yet, so a missing
    // row proves nothing there. See the deleted-chat check in {@link extractWindow}.
    const result = await extractWindow({
        handle, identity, recentMessages, store, context, now, defaults, highWater, epoch,
        rescan: false, guardDeletedChat: highWater >= 0,
    });

    if (result.kind === 'discarded') {
        return;                                               // 🔴 nothing to mark — see extractWindow
    }

    if (result.kind === 'garbage') {
        // A failed attempt on this window. Count it; force past the window only after it has repeatedly failed,
        // so a persistently confused model loses coverage rather than re-burning the GPU on it for ever.
        const record = failureCounts.get(handle)?.get(chatKey);
        const count = (record && record.atHighWater === highWater ? record.count : 0) + 1;
        const { shape } = result;

        // ⚠️ THE ONE PLACE THE NO-TEXT RULE COSTS REAL DIAGNOSTIC POWER, and it is a deliberate trade. What you
        // would most like to see here is what the model actually said — but a model that ignored the extraction
        // task and continued the roleplay instead has returned *conversation*, which is the very thing that must
        // not land in a plaintext log. So we log its shape: enough to tell "empty reply" from "wrote a paragraph"
        // from "emitted lines that just missed the format", which is the distinction that decides what to fix.
        //
        // 🔴 **The classification call this task was warned about, so here is the reasoning rather than the
        // verdict alone.** The metrics below are computed FROM conversation text, and a strict reading of
        // "anything derived from a chat is SENSITIVE" would suppress them. That reading is wrong, and following
        // it would empty the capability of all content: `%d stored, %d superseded` is equally "derived from a
        // chat", and the fork's own worked example (§23.5.1) publishes exactly that. **The rule distinguishes
        // values that CARRY content from values that MEASURE it.** A character count and a line count are
        // measurements — two integers, reconstructing nothing, at a granularity that cannot distinguish one
        // sentence from another of the same size.
        //
        // What must never cross is the payload itself, and it does not appear here in any form: not quoted, not
        // truncated, not sampled, not a first line, not a hash. `text` is not interpolated into either half of
        // this split. **If a future change wants the output visible, the answer is debug mode, never a NORMAL
        // line with a "short" excerpt in it** — an excerpt of a roleplay continuation is a roleplay
        // continuation.
        // ⚠️ AND THE SHAPE IS NOW SPECIFIC ENOUGH TO ACT ON, WHICH TWO INTEGERS WERE NOT. "N carried a tag,
        // M opened with one" separates the two failures that both used to print as "1035 chars, 3 lines": a
        // model that ignored the task (tagged 0) from a model that did the job and then decorated it
        // (tagged 3, leading 0 — one bullet character out of reach). Those call for opposite fixes and the
        // old line could not tell them apart. See {@link describeUnparsed} for why each of these numbers is
        // publishable when the text itself is not.
        normal().warn(
            '[Mnemosyne] ingest: the extractor returned unparseable output — %d chars, %d lines, attempt %d ' +
            'of %d. Of those lines %d carried a memory tag and %d opened with one; %d carried the index ' +
            'separator, %d opened with the tag vocabulary but no brackets, %d began with a bullet or a ' +
            'number, %d held a code fence; the longest was %d chars. ' +
            'Not NONE, so this is a FAILED attempt: the high-water mark stays put and the same turns ' +
            'are retried. (Output withheld — it is conversation text.)',
            shape.chars, shape.lines, count, defaults.maxFailedAttempts,
            shape.tagged, shape.leading, shape.separated, shape.bare, shape.bulleted, shape.fenced, shape.longest,
        );
        sensitive().debug('[Mnemosyne] That failed extraction was for chat %s (%s).', chatKey, handle);

        // 🔴 A PARSE FAILURE IS A FAILURE THE USER MUST SEE. It is the one fault with no exception behind it,
        // so nothing else on this path would ever reach the panel — and it is the fault most likely to be the
        // model's fitness for the job rather than a broken install, which is exactly the distinction a user
        // staring at an empty panel cannot draw on their own.
        noteOutcome(handle, {
            ok: false, chatId: chatKey, at: now, epoch,
            reason: `the extractor returned output that could not be parsed (attempt ${count} of ${defaults.maxFailedAttempts})`,
            fix: 'The chat model is continuing the conversation instead of following the extraction instruction. A model with stronger instruction-following, or a backend that honors the decoding grammar, fixes this.',
        });

        if (count >= defaults.maxFailedAttempts) {
            normal().warn(
                '[Mnemosyne] ingest: giving up on a window after %d failed extractions — forcing the mark ' +
                'past it. Coverage is lost for those turns rather than wedging the loop on them.',
                count,
            );
            sensitive().debug('[Mnemosyne] That window was in chat %s.', chatKey);
            // 🔴 The mark moves; the outcome does NOT. The `ok: false` recorded eleven lines above is the
            // whole point of this branch reaching the panel, and `advance()` used to overwrite it with a
            // success. See `advance` for what that looked like to a user.
            advance({ recordOutcome: false });
        } else {
            const forHandle = failureCounts.get(handle) ?? new Map();
            forHandle.set(chatKey, { atHighWater: highWater, count });
            failureCounts.set(handle, forHandle);
        }
        return;
    }

    if (result.kind === 'written') {
        // 🔴 The UI half of the same event, and the reason it is HERE rather than beside each `store.remember`:
        // one pass is one thing that happened to the user, and notifying per row would flash the button three
        // times for one statement written to three characters. The ordering rule (record, then push) and the
        // empty-pass guard both live in announceWrites now — see src/announce.js.
        announceWrites(context, { handle, chatId: chatKey, items: result.written, epoch });
    }

    advance();                                                // empty, NONE, or lines processed → done with this window
}

/**
 * What one {@link extractWindow} pass came to.
 *
 *   - `empty`     every turn in the window was blank; nothing was asked.
 *   - `garbage`   the extractor's answer could not be parsed. `shape` measures it without quoting it.
 *   - `none`      the extractor said NONE — nothing durable here.
 *   - `discarded` memories were extracted but not written: the embedder answered wrongly, the vault closed or
 *                 memory was reset, or the chat was deleted mid-pass. The caller must not mark anything done.
 *   - `written`   the survivors were placed. `tally` counts writes per outcome; `written` is what the panel
 *                 shows as just remembered.
 *
 * @typedef {{ kind: 'empty' } | { kind: 'none' } | { kind: 'discarded' }
 *   | { kind: 'garbage', shape: ReturnType<typeof describeUnparsed> }
 *   | { kind: 'written', tally: { stored: number, superseded: number, duplicate: number, history: number },
 *       written: Array<{ text: string, replaced: string|null }> }} WindowResult
 */

/**
 * One extraction over one window: read the turns past `highWater`, ask the model, filter, embed, and place.
 *
 * 🔴 **SHARED BY LIVE INGEST AND THE RESCAN, AND IT OWNS NEITHER'S BOOKKEEPING.** It never moves the
 * high-water mark, never counts retries, and never records the panel's outcome — each caller decides what a
 * result means for its own state. Live ingest ({@link runExtraction}) advances its mark and counts failures;
 * the rescan ({@link rescanTurns}) does neither per pass, because the passes it runs are over old turns.
 *
 * @param {object} args
 * @param {string} args.handle
 * @param {ExtractingIdentity} args.identity
 * @param {ForkRecentMessage[]} args.recentMessages The turns, in chat order, ending at the last one to read
 * @param {import('../store.js').MemoryStore} args.store
 * @param {import('../host/context.js').HostContext} args.context
 * @param {number} args.now
 * @param {import('../config.js').IngestDefaults} args.defaults
 * @param {number} args.highWater The index of the last turn NOT to extract; turns after it are the new ones
 * @param {number} args.epoch The caller's lock generation, taken before its first await
 * @param {boolean} args.rescan Whether these are old turns being read again — see `originOrder` in placement.js
 * @param {boolean} args.guardDeletedChat Whether an absent `ingest_state` row means the chat was deleted
 *        mid-pass. True only when the caller knows a row existed when it started.
 * @returns {Promise<WindowResult>}
 */
async function extractWindow({ handle, identity, recentMessages, store, context, now, defaults, highWater, epoch, rescan, guardDeletedChat }) {
    const { chatId: chatKey, charName, charId } = identity;

    // Both partitions, for the "already known" list alone — a fact the extractor should not raise again is one
    // it should not raise again in EITHER tier. The dedup/supersession search is the opposite and deliberately
    // so: it runs per-candidate against that candidate's own partition only. See placeCandidate.
    const scopes = retrievalScopes(identity);

    // 🔴 ONE slice, used for both the text the extractor reads and the speaker set its user-tier memories are
    // attributed to. Two derivations of "the window" would be two things free to disagree about who was there.
    const windowMessages = windowSlice(recentMessages, highWater, defaults);
    const window = buildWindowText(recentMessages, highWater, defaults);

    // The origin range covers fresh turns only; processed context is not assigned a second time. It is a window
    // range, not per-candidate provenance, so live placement also relies on the extractor's context/evidence rules.
    const origin = originOf(chatKey, windowMessages.filter(m => m.index > highWater));

    if (!window) {
        normal().info('[Mnemosyne] ingest: nothing but empty messages past index %d — marking processed.', highWater);
        sensitive().debug('[Mnemosyne] That was chat %s (%s).', chatKey, handle);
        return { kind: 'empty' };                             // nothing but empty messages — treat as processed
    }

    // 🔴 `window.length` is a CHARACTER COUNT of conversation text, not the text — the distinction the whole
    // §5.6 rule turns on. A size is shape; it reconstructs nothing.
    normal().info(
        '[Mnemosyne] ingest: extracting — %d chars of conversation past index %d.',
        window.length, highWater,
    );
    sensitive().debug(
        '[Mnemosyne] That extraction is for %s — chat %s, character %s, scopes [%s].',
        handle, chatKey, JSON.stringify(charName ?? ''), scopes.join(', '),
    );

    // 🔴 Scoped: this list is shown to the extractor as "already known" AND becomes the exact-dedup set below.
    // Unscoped, it would put one character's memories verbatim into another character's extraction prompt.
    const existing = store.listMemories({ limit: defaults.existingContextK, scopes });

    // The user's extraction template, read from the same store the memories came from. `''` means they
    // have never edited it (or reset it), and `renderExtractionPrompt` takes the built-in for both.
    const template = readPromptTemplate(store);

    // 🔴 AWAITED BEFORE THE EXTRACTION, AND NOT WRAPPED IN A CATCH. A locked vault or a broken store throws out
    // of here, `maybeIngest` declines the whole ingest, and the high-water mark stays where it was — which is
    // the correct outcome, because extracting with a silently-empty baseline is the one failure mode this
    // feature exists to prevent. See readBaseline for why the parse, and only the parse, is caught.
    const baseline = await readBaseline(handle, charId, context);

    const prompt = renderExtractionPrompt({
        charName: charName || 'the character',
        existing,
        window,
        maxMemories: defaults.maxMemories,
        // 🔴 THE USER'S MEMORY SIZE, NOT THE CONSTANT. The prompt STATES this limit to the model and the
        // quality filter ENFORCES it; if they come from different places the knob silently does nothing —
        // the filter widens and the model, still told the old number, keeps writing to it.
        maxLength: defaults.maxLength,
        // The user's own template when they have edited one, '' otherwise — see readPromptTemplate for
        // why empty and never-set are deliberately the same state.
        template,
        baseline,
    });

    // 🔴 `wrap: true` (R4). This prompt is an INSTRUCTION ("extract the facts worth remembering"), and the model
    // on the other end is tuned for roleplay. Sent bare it gets continued as story rather than followed, which
    // lands in parseExtraction's garbage path — so some of what looked like a flaky extractor was probably this.
    // The fork never reads an instruct template: the client computes a single-turn envelope with ST's own
    // formatters and the server concatenates opaque strings (fork §19.2). Fails LOUD — `wrap: true` with no
    // envelope captured throws rather than quietly sending bare, and maybeIngest's catch turns that into a
    // declined ingest, never a failed reply. An all-empty envelope just means instruct mode is off: a no-op.
    //
    // 🔴 NEVER pass `stop` with this. Stops cap at 4, the envelope's go first, and on ChatML the envelope uses
    // all four by itself — so ours would be silently dropped. Measured in a browser, not reasoned about (§21.3).
    //
    // Constrained decoding when the fork offers it (plugin API v3): the grammar makes the format valid by
    // construction instead of parsed-and-hoped-for. Feature-detected, not assumed — an older fork ignores an
    // unknown `grammar` param, but gating on `apiVersion` keeps the request byte-identical there rather than
    // relying on that. `wrap` still frames the prompt; the grammar only shapes the reply. See
    // buildExtractionGrammar for why this and LINE_RE are one contract.
    const constrained = HostContext.from(context).has('grammar');
    const grammar = constrained ? buildExtractionGrammar(defaults.maxMemories, defaults.maxLength) : undefined;
    /**
     * One extraction call at a given wire ceiling.
     *
     * ⚠️ `finishReason` is the fork's apiVersion-5 addition and is OPTIONAL at every version — an older fork
     * omits it and a backend may never send one, so every read of it below has to treat absence as "no
     * information", never as "not truncated". See types/fork-host.d.ts, which was verified against the fork's
     * `plugin-loader.js` rather than against its changelog.
     *
     * @param {number} ceiling
     * @returns {Promise<{ text: string, finishReason?: string }>}
     */
    const askOnce = (ceiling) => context.generate({
        handle, prompt, wrap: true,
        // 🔴 THE CEILING, NOT THE ANSWER BUDGET. `extractMaxTokens` is how long the ANSWER may be and is what
        // `parseExtraction` measures against below; what goes on the wire has to cover the reasoning a thinking
        // model spends first, which is billed here and never handed back. See extractCeilingTokens.
        maxTokens: ceiling, temperature: defaults.extractTemperature,
        ...(grammar ? { grammar, repPen: defaults.extractRepPen } : {}),
    });

    let { text, finishReason } = await askOnce(defaults.extractCeilingTokens);

    // 🔴 AN EMPTY ANSWER THAT RAN OUT OF ROOM IS NOT A MODEL THAT HAD NOTHING TO SAY, AND RETRYING IT
    // UNCHANGED CANNOT EVER WORK.
    //
    // A thinking model spends its reasoning first and is billed for it against the same ceiling — measured on
    // Pro, 1,200–1,900 tokens before a character of the answer. When the ceiling runs out mid-thought the call
    // resolves with `text: ''` and `finishReason: 'length'`, which is byte-identical in `text` to an abstain.
    // `parseExtraction` correctly calls it garbage, ingest counts a failed attempt, and the NEXT attempt makes
    // the identical call under the identical ceiling and fails identically — burning `maxFailedAttempts` GPU
    // passes to arrive at the same place and then force-advancing past a window that was never read. The fork
    // returns this field (apiVersion 5) specifically so we can tell the two apart; their reply says so in as
    // many words, and their ask-3 note calls it "load-bearing for you".
    //
    // 🔴 **ONLY WHEN THE ANSWER IS EMPTY, AND THAT CONDITION IS THE WHOLE SAFETY OF IT.** A runaway — the case
    // `extractCeilingTokens` exists to bound at all, since the fork drops `grammar` for every OpenAI-schema
    // backend — ALSO ends in `finishReason: 'length'`, and raising the ceiling for one of those would feed the
    // loop it is supposed to stop. A runaway has written a great deal of text by then; a starved reasoner has
    // written none. So the empty answer is the discriminator, and a non-empty truncated answer takes the
    // untouched path below, where `looksGuillotined` drops its half-finished last line as it always has.
    //
    // ⚠️ Once, and bounded. This is a repair for a mis-sized ceiling, not an open-ended budget.
    // ⚠️ `text ?? ''` because this is the one read of it that is not already guarded. `parseExtraction` and
    // `describeUnparsed` both open with `(text ?? '')`; a fork that answers `{ finishReason }` with no `text`
    // threw a TypeError here instead, which `describeFailure` cannot classify and reports as "an unrecognized
    // TypeError" — the exact opaque line `diagnose.js` was added to end.
    if ((text ?? '').trim() === '' && finishReason === 'length') {
        const raised = Math.min(defaults.extractCeilingTokens * CEILING_RETRY_FACTOR, CEILING_RETRY_MAX);

        // 🔴 **A RETRY AT THE SAME CEILING IS THE THING THIS BRANCH EXISTS TO REFUSE.** `CEILING_RETRY_MAX` and
        // `extractCeilingTokens`'s schema maximum are both 32000, so a user who dragged that slider to the top —
        // which is exactly what the warning below tells them to do — got `raised === extractCeilingTokens`, and
        // the code then logged "retrying it at the same ceiling could only fail the same way" immediately before
        // making the identical call. Degenerate from 16000 up: a second full extraction pass, billed, guaranteed
        // to fail the same way. When there is no headroom left the honest move is to say so and stop.
        if (raised <= defaults.extractCeilingTokens) {
            normal().warn(
                '[Mnemosyne] ingest: the extractor spent its entire %d-token ceiling before writing any answer, ' +
                'and that is already the highest ceiling this build will ask for — so there is no larger retry ' +
                'to make. This model needs more room to think than the ceiling can give it; a smaller extraction ' +
                'window (fewer memories per pass, or a shorter memory size) is the lever that is left.',
                defaults.extractCeilingTokens,
            );
        } else {
            normal().warn(
                '[Mnemosyne] ingest: the extractor spent its entire %d-token ceiling before writing any answer — ' +
                'that is a thinking model being starved, not a model with nothing to say, so retrying it at the ' +
                'same ceiling could only fail the same way. Retrying once at %d. If this recurs, raise ' +
                'extractCeilingTokens: the reasoning is billed against it and is never handed back.',
                defaults.extractCeilingTokens, raised,
            );

            ({ text, finishReason } = await askOnce(raised));
        }
    }

    const parsed = parseExtraction(text, defaults);

    if (parsed.kind === 'garbage') {
        // What the caller logs and counts — its shape, never its text. See the note at the live caller.
        return { kind: 'garbage', shape: describeUnparsed(text ?? '') };
    }

    if (parsed.kind === 'none') {
        normal().info('[Mnemosyne] ingest: the extractor found nothing durable — NONE.');
        sensitive().debug('[Mnemosyne] That was chat %s (%s).', chatKey, handle);
        return { kind: 'none' };                              // a genuine "nothing durable here"
    }

    // Well-formed lines. Quality-filter and exact-dedup cheaply, then embed the survivors in ONE batched call
    // (🔴 embed takes an ARRAY), and run each through the similarity pipeline.
    const existingNormalized = new Set(existing.map(m => normalize(m.text)));
    // 🔴 THE SURVIVORS DEDUP AGAINST EACH OTHER, NOT ONLY AGAINST THE STORE.
    //
    // This loop compared each candidate to `existingNormalized` and to nothing else, so two identical lines in
    // ONE pass both survived and both got embedded and stored. That is not hypothetical: `config.js` says so
    // itself — `repPen` exists to "trim the shorter repeats a `line{1,N}` grammar can produce" — and `repPen`
    // rides only with the grammar, so an unconstrained backend has no protection at all.
    //
    // The damage is worse than a wasted row. i=0 stores id=1; i=1 searches its partition, finds id=1 at
    // distance 0, and if the statement carries a state-change marker it takes the near-identical branch and
    // SUPERSEDES it — retiring a byte-identical memory. The pass then reports a "replacement" whose old and
    // new text are the same, and the panel shows the user a correction that corrected nothing.
    const seenThisPass = new Set();
    const dropped = { quality: 0, alreadyKnown: 0, repeated: 0 };
    const survivors = [];

    for (const raw of parsed.candidates) {
        if (!passesQuality(raw.statement, defaults)) {
            dropped.quality++;
            continue;
        }

        // 🔴 OVER THE SIZE LIMIT IS CLIPPED AND STORED, NEVER DISCARDED. This loop used to reject it through
        // `passesQuality`, permanently and with only a count to show for it. Each clip is logged with both
        // lengths so the panel's log says which memory was shortened and by how much. See `fitLength`.
        const fitted = fitLength(raw.statement, defaults);
        const candidate = fitted.clipped ? { ...raw, statement: fitted.text } : raw;

        if (fitted.clipped) {
            normal().info(
                '[Mnemosyne] ingest: a %d-char memory was over the %d-char memory size, so it was clipped to %d ' +
                'chars and stored. Edit it in the panel, or raise Memory size, if the cut lost something.',
                raw.statement.trim().length, defaults.maxLength, fitted.text.length,
            );
        }

        const key = normalize(candidate.statement);
        if (existingNormalized.has(key)) {
            dropped.alreadyKnown++;
            continue;                                         // free exact-duplicate skip (§5.3 tier 1)
        }
        if (seenThisPass.has(key)) {
            dropped.repeated++;
            continue;                                         // the model said it twice in one answer
        }

        seenThisPass.add(key);
        survivors.push(candidate);
    }

    // 🔴 THE REASONS, NOT JUST THE TOTAL. A drop is PERMANENT (the pass returns `lines`, the mark advances, the
    // window is never read again), so every one is counted by cause. Counts are measurements, never content.
    // Length and hedging are no longer causes — over-long is clipped (above) and hedges are kept (quality.js).
    if (dropped.quality || dropped.alreadyKnown || dropped.repeated) {
        normal().info(
            '[Mnemosyne] ingest: dropped %d as too short (under %d chars), %d already known, ' +
            '%d repeated within the same answer.',
            dropped.quality, defaults.minLength, dropped.alreadyKnown, dropped.repeated,
        );
    }

    // 🔴 OVER THE PER-PASS COUNT IS KEPT, NOT DISCARDED. `parseExtraction` used to slice to `maxMemories`, so
    // lines 7..N of an unconstrained answer were thrown away and the window marked done. The count is what the
    // model is ASKED for; what it returns anyway is still memory. Said, so the setting's effect is visible.
    if (parsed.candidates.length > defaults.maxMemories) {
        normal().info(
            '[Mnemosyne] ingest: the extractor returned %d memories against a request for at most %d — all of ' +
            'them are kept.',
            parsed.candidates.length, defaults.maxMemories,
        );
    }

    // 🔴 Lines the model wrote without the `[type:importance:subject]` tag. These used to make the whole pass
    // "unparseable", and two in a row force-advanced the mark past the window with nothing stored. They are now kept under the
    // default tag; this line says how many, so a model that keeps dropping the tag is visible.
    if (parsed.untagged > 0) {
        normal().info(
            '[Mnemosyne] ingest: %d of %d lines came back without a proper [type:importance:subject] tag and ' +
            'were kept anyway, filed as this-story facts.',
            parsed.untagged, parsed.candidates.length,
        );
    }

    if (parsed.truncated) {
        normal().warn(
            '[Mnemosyne] ingest: the extractor filled its %d-token ceiling and its last line was cut off, so ' +
            'that line was clipped back to its last whole sentence and stored. Raise the extraction token ' +
            'ceiling if this recurs.',
            defaults.extractMaxTokens,
        );
    }

    normal().info(
        '[Mnemosyne] ingest: the extractor returned %d memor%s; %d survived the quality and exact-duplicate ' +
        'filters.',
        parsed.candidates.length, parsed.candidates.length === 1 ? 'y' : 'ies', survivors.length,
    );
    sensitive().debug('[Mnemosyne] That extraction was for chat %s (%s).', chatKey, handle);

    const tally = { stored: 0, superseded: 0, duplicate: 0, history: 0 };
    /** @type {Array<{ text: string, replaced: string|null }>} */
    const written = [];

    if (survivors.length > 0) {
        // 🔴 THE INDEX LINE IS WHAT GETS EMBEDDED, NOT THE STATEMENT — schema.js v5, {@link embedText}.
        //
        // This one line is the entire retrieval fix. A rich multi-topic paragraph embeds to the average of its
        // topics and can match none well. The distilled line names the subjects and nothing else, so it
        // embeds to a direction rather than a centroid. `renderBlock` still injects `text`, so what the model
        // READS is unchanged and only what it is FOUND BY has moved.
        //
        // ⚠️ `embedText` falls back to the statement when there is no distillation, so an unconstrained
        // backend that ignored the instruction lands exactly on the old behavior rather than on nothing.
        const { vectors, model } = await context.embed(survivors.map(c => embedText({ indexLine: c.indexLine, text: c.statement })));

        // 🔴 A NULL MODEL NAME IS AN ANSWER, NOT AN ANOMALY, AND INGEST WAS THE ONE PATH THAT DID NOT READ IT.
        //
        // `context.embed` returns `{ vectors, model: string|null }` and the null is the fork's own declared
        // answer: `vectors/embedding.js` hands back `getLoadedModelForTask(TASK)`, which is null when no
        // pipeline is loaded for the task. `retrieve()` has always read it — `if (!model || !vectors.length)`
        // declines the turn with reason `no-embedding`, and its comment says why: it will not file vectors
        // under a guessed name, because the model name IS the vector table (schema.js).
        //
        // This path did not. `model` went straight to `placeCandidate` -> `placeInPartition` ->
        // `store.registerModel(model, ...)`, which refuses a falsy identifier with a TypeError — thrown inside
        // `maybeIngest`'s catch, which stamps `lastRun` and leaves `highWater` where it was. So on an install
        // whose embedder answers this way, automatic memory NEVER RUNS, every generation past the retry backoff
        // burns a full extraction pass to fail identically, and the only published line is "ingest declined
        // after an error (TypeError) ... Details suppressed." Which is the silent-failure shape this whole
        // subsystem's logging exists to refuse.
        //
        // ⚠️ Declining here and not at the top is deliberate: the extraction has already happened and its
        // candidates are still worth reporting, so the pass ends the same way any other unwritable pass ends
        // rather than pretending it never ran. `advance()` is NOT called, so the window is re-read next time —
        // an embedder that comes back finds the same turns waiting.
        // ⚠️ **THE ARITY IS PART OF THE SAME ANSWER AND WENT UNCHECKED.** `model` was validated and
        // `vectors.length` was not, so an embedder that returned fewer vectors than it was given texts — a
        // partial batch, a provider that silently drops an input it could not encode — made `vectors[i]`
        // `undefined` partway through the loop below. `placeCandidate` then throws AFTER some rows are already
        // written, so `advance()` never runs and the window is re-extracted; tier-1 dedup absorbs the repeats,
        // so it eventually self-heals, but every pass costs a full extraction and the published cause is once
        // again an unrecognized TypeError. Checked here, it is the same orderly decline as a missing name.
        if (!model || vectors.length !== survivors.length) {
            normal().warn(
                '[Mnemosyne] ingest: the embedder returned %s, so %d extracted memor%s cannot be ' +
                'filed and this pass is dropped. The model name keys the vector table, and a guessed one ' +
                'would put these vectors where nothing will ever look for them.',
                model ? `${vectors.length} vectors for ${survivors.length} memories` : 'no model name',
                survivors.length, survivors.length === 1 ? 'y' : 'ies',
            );
            sensitive().debug('[Mnemosyne] That drop was for chat %s (%s).', chatKey, handle);
            return { kind: 'discarded' };
        }

        // 🔴 THE USER ERASED EVERYTHING WHILE THIS EXTRACTION WAS RUNNING.
        //
        // An extraction is seconds long — a card read, a generation, an embed batch — and `POST /memory/reset`
        // takes microseconds. Send a message, open the settings screen, press "Reset all memories" while the
        // model is still working, and without this the pass finishes afterward and writes its memories into
        // the store that was just emptied. The user is told "erased 412 memories" and then finds three, which
        // reads as the reset having failed rather than as a race.
        //
        // ⚠️ `locked()` rather than a flag of ingest's own, because `dropForHandle` already bumps the lock
        // generation for exactly this reason, and `epoch` was taken at the top of this function for the
        // mid-flight LOGOUT case. One signal, one meaning: "the per-user generation moved under you, so
        // everything you computed is about a state that no longer exists." A reset is that, and so is a lock.
        //
        // 🔴 **ABOVE THE CHAT-DELETED CHECK, AND THE ORDER IS THE WHOLE POINT OF HAVING TWO.** `clearMemories`
        // empties `ingest_state` as well, so after a reset the check below ALSO fires — and reports that the
        // chat was deleted, which is false. Both discard, so the behavior was right and only the explanation
        // was wrong; in a plugin whose log is the only window onto what it did, an explanation that names the
        // wrong event is the defect. Broadest cause first: "everything is gone" before "this chat is gone".
        if (locked(handle, epoch)) {
            normal().warn(
                '[Mnemosyne] ingest: memory was reset (or the vault closed) while this extraction was ' +
                'running, so the %d memor%s it produced are being discarded rather than written into a store ' +
                'that has since been emptied.',
                survivors.length, survivors.length === 1 ? 'y' : 'ies',
            );
            sensitive().debug('[Mnemosyne] That discarded extraction was for %s.', handle);
            return { kind: 'discarded' };                     // 🔴 The caller must mark nothing.
        }

        // 🔴 A CHAT DELETED MID-EXTRACTION MUST NOT BE RESURRECTED BY THE WRITE THAT LANDS AFTER IT.
        //
        // `runExtraction` captured `chatKey` and has since awaited a card read, a generation and an embed
        // batch — seconds. If the user deleted the chat in that window, `forgetChat` already removed its
        // memories AND its `ingest_state` row inside a transaction. This code then writes fresh memories into
        // the dead chat's scenario partition and `advance()` re-inserts an `ingest_state` row for it, so the
        // deletion is quietly half-undone and the rows are stranded in a partition nothing will query.
        //
        // The in-memory counterpart of this exact hazard is already guarded — `forgetChatRetries` exists so a
        // stale retry counter cannot outlive its chat — and the store-side one was not. `forgetChat` deleting
        // the state row is what makes this checkable: its absence, when we know we had one, means the chat
        // went away underneath us. (The opening pass has no row either, which is why the check is on having HAD
        // one — `guardDeletedChat`, which live ingest sets from `highWater >= 0` and a rescan sets because it
        // makes sure a row exists before its first pass.)
        if (guardDeletedChat && store.getIngestState(chatKey) === null) {
            normal().warn(
                '[Mnemosyne] ingest: the chat was deleted while its extraction was running, so the %d ' +
                'memor%s it produced are being discarded rather than written back into a conversation that ' +
                'no longer exists.',
                survivors.length, survivors.length === 1 ? 'y' : 'ies',
            );
            sensitive().debug('[Mnemosyne] That deleted chat was %s (%s).', chatKey, handle);
            return { kind: 'discarded' };                     // 🔴 The caller must mark nothing.
        }

        for (let i = 0; i < survivors.length; i++) {
            // One candidate can now yield several outcomes — a user-tier memory is written once per character
            // who was in the room (see placeCandidate). The tally counts WRITES, not candidates, which is why
            // "6 stored" can exceed maxMemories in a group chat and is not a cap being breached.
            const results = await placeCandidate({
                candidate: survivors[i], origin, rescan, vector: vectors[i], model,
                handle, identity, windowMessages, store, context, now, defaults,
            });
            for (const result of results) {
                tally[result.outcome]++;
                // Only live writes are shown as just remembered. A duplicate wrote nothing, and a history row
                // went straight into another memory's version chain.
                if (result.outcome === 'stored' || result.outcome === 'superseded') {
                    written.push({ text: result.text, replaced: result.replaced });
                }
            }
        }
        // 🔴 THE line this whole capability was worth adopting for — the one an operator reads to know memory is
        // working at all, and the exact case the fork worked through in §23.5.1. Ingest has no UI and runs
        // fire-and-forget, so without this it is indistinguishable from a plugin that is switched off.
        normal().info(
            '[Mnemosyne] ingest: done — %d stored, %d superseded, %d dropped as duplicates, %d kept as history ' +
            'of a newer memory. The store now holds %d memories.',
            tally.stored, tally.superseded, tally.duplicate, tally.history, store.memoryCount(),
        );
        sensitive().debug('[Mnemosyne] That was chat %s for %s.', chatKey, handle);
    }

    // Lines were processed (some may have deduped away) → the caller is done with this window. The exact
    // matches dropped before embedding are duplicates too, and a rescan reports them as "already known".
    return { kind: 'written', tally: { ...tally, duplicate: tally.duplicate + dropped.alreadyKnown }, written };
}

/**
 * What a rescan did, for the panel to say and the API to return.
 *
 * @typedef {object} RescanSummary
 * @property {boolean} busy True when another extraction for this user was already running, so nothing ran
 * @property {number} turns How many turns were handed in
 * @property {number} passes How many extraction passes ran
 * @property {number} failed Passes whose answer could not be parsed, or that threw
 * @property {number} readTurns Turns in passes that completed — what the user is told was read
 * @property {number} skippedTurns Turns in passes whose answer could not be parsed — worth a second rescan
 * @property {string|null} stopped Why the rescan stopped early, in a content-free sentence; null if it did not
 * @property {string|null} fix What to do about `stopped`, when there is a known answer
 * @property {{ stored: number, superseded: number, duplicate: number, history: number }} tally Writes, summed
 * @property {boolean} advanced Whether the chat's high-water mark moved forward past the rescanned turns
 */

/**
 * Extract memories again from turns that were already read — the panel's **Rescan** button.
 *
 * Rescanning lets users recover memories missed by an earlier extraction pass without reprocessing them through
 * a separate implementation.
 *
 * The turns come from `context.readChat` (fork §29) and are read in passes of `windowMax - windowContextTail`
 * new turns each, so every pass sees the same four turns of context above it that a live pass would. Each pass
 * is {@link extractWindow} — the live pipeline, unchanged — with `rescan: true`.
 *
 * 🔴 **NOTHING IS DELETED OR REPLACED BY AGE.** A memory the store already holds is dropped as a duplicate by
 * the same checks live ingest runs. A statement that would replace a memory from NEWER messages is stored as
 * that memory's history instead (`originOrder` in placement.js). Only what is actually missing becomes a new,
 * live memory.
 *
 * ⚠️ **Serialized with live ingest through `inFlight`**, the same one-GPU rule. A rescan does not wait for a
 * running extraction; it returns `busy` and the panel says to try again in a moment. While a rescan runs, live
 * ingest skips its turns and logs that it did — its mark does not move, so nothing is lost.
 *
 * ⚠️ **The mark moves forward only when it is safe.** If every pass succeeded and the rescan covered everything
 * after the mark, the mark moves to the last rescanned turn, so live ingest does not read those turns a second
 * time. Otherwise it is left alone and live ingest reads what it has not read yet, as it always would.
 *
 * @param {object} args
 * @param {string} args.handle
 * @param {ExtractingIdentity} args.identity The panel request's identity, with `chatId` present
 * @param {ForkRecentMessage[]} args.turns What `readChat` returned, in chat order
 * @param {import('../store.js').MemoryStore} args.store
 * @param {import('../host/context.js').HostContext} args.context
 * @param {number} [args.now]
 * @param {import('../config.js').IngestDefaults} [args.defaults]
 * @returns {Promise<RescanSummary>}
 */
export async function rescanTurns({ handle, identity, turns, store, context, now = Date.now(), defaults = INGEST_DEFAULTS }) {
    /** @type {RescanSummary} */
    const summary = {
        busy: false, turns: turns.length, passes: 0, failed: 0, readTurns: 0, skippedTurns: 0, stopped: null, fix: null,
        tally: { stored: 0, superseded: 0, duplicate: 0, history: 0 }, advanced: false,
    };

    if (inFlight.has(handle)) {
        normal().info('[Mnemosyne] rescan: an extraction is already running for this user — not starting.');
        return { ...summary, busy: true };
    }

    if (turns.length === 0) {
        normal().info('[Mnemosyne] rescan: the chat has no turns to read.');
        return summary;
    }

    // 🔒 Before the first await, for the reason `runExtraction` gives: a reset or a logout mid-rescan bumps it.
    const epoch = epochOf(handle);
    const chatKey = identity.chatId;
    const step = Math.max(1, defaults.windowMax - defaults.windowContextTail);

    inFlight.add(handle);
    try {
        // 🔴 A ROW BEFORE THE FIRST PASS, so a chat deleted mid-rescan is detected by `extractWindow`'s guard
        // exactly as it is for live ingest. `highWater: -1` keeps every turn unread from live ingest's point of
        // view. It does spend the "chat is opening" signal, which only lowers live ingest's first threshold —
        // and a chat being rescanned has already been read.
        if (store.getIngestState(chatKey) === null) {
            store.setIngestState(chatKey, { highWater: -1, lastRun: 0 });
        }

        normal().info(
            '[Mnemosyne] rescan: reading %d turns again (indices %d–%d) in passes of up to %d.',
            turns.length, turns[0].index, turns[turns.length - 1].index, step,
        );
        sensitive().debug('[Mnemosyne] That rescan is chat %s for %s.', chatKey, handle);

        /** @type {Array<{ text: string, replaced: string|null }>} */
        const written = [];

        for (let start = 0; start < turns.length; start += step) {
            if (locked(handle, epoch)) {
                summary.stopped = 'memory was reset or the vault closed while it ran';
                normal().warn('[Mnemosyne] rescan: %s — stopping after %d passes.', summary.stopped, summary.passes);
                break;
            }

            // The turns up to the end of this pass, and the mark just before its first new turn. Everything
            // before the mark is only context: `windowSlice` keeps `windowContextTail` of it, which is why the
            // step is `windowMax` minus that tail.
            const highWater = start === 0 ? turns[0].index - 1 : turns[start - 1].index;
            const size = Math.min(step, turns.length - start);   // the new turns this pass reads
            summary.passes++;

            /** @type {WindowResult} */
            let result;
            try {
                result = await extractWindow({
                    handle, identity, recentMessages: turns.slice(0, start + step), store, context, now, defaults,
                    highWater, epoch, rescan: true, guardDeletedChat: true,
                });
            } catch (error) {
                // A thrown pass is the backend or the embedder, and the next pass would meet the same fault. Stop,
                // keep what the earlier passes wrote, and say why.
                const { reason, fix } = describeFailure(error);
                summary.failed++;
                summary.stopped = reason;
                summary.fix = fix;
                normal().error('[Mnemosyne] rescan: pass %d failed — %s. Stopping; earlier passes are kept.%s',
                    summary.passes, reason, fix ? ` ${fix}` : '');
                sensitive().error('[Mnemosyne] That rescan failure was for %s: %s', handle, /** @type {Partial<Error>} */ (error)?.message ?? error);
                break;
            }

            if (result.kind === 'garbage') {
                // One unreadable answer costs one pass, not the rescan: the next window is different text.
                const { shape } = result;
                summary.failed++;
                summary.skippedTurns += size;
                normal().warn(
                    '[Mnemosyne] rescan: pass %d returned unparseable output — %d chars, %d lines, %d tagged. ' +
                    'Those turns were not read; the rescan continues. (Output withheld — it is conversation text.)',
                    summary.passes, shape.chars, shape.lines, shape.tagged,
                );
                continue;
            }

            if (result.kind === 'discarded') {
                // The pass logged its own cause. The one worth naming to the user is a reset or a logout.
                summary.stopped = locked(handle, epoch)
                    ? 'memory was reset or the vault closed while it ran'
                    : 'extracted memories could not be written (see the log)';
                break;
            }

            summary.readTurns += size;                         // empty, NONE, or written: these turns were read

            if (result.kind === 'written') {
                for (const key of /** @type {const} */ (['stored', 'superseded', 'duplicate', 'history'])) {
                    summary.tally[key] += result.tally[key];
                }
                written.push(...result.written);
            }
        }

        const state = store.getIngestState(chatKey);
        const last = turns[turns.length - 1].index;

        // `turns[0].index <= highWater + 1` is "nothing unread sits between the mark and the rescan". Indices are
        // sparse, so this can decline when a hidden message sits in that gap — declining only costs live ingest
        // a second read, which dedup absorbs.
        if (state && summary.failed === 0 && summary.stopped === null && turns[0].index <= state.highWater + 1 && last > state.highWater) {
            store.setIngestState(chatKey, { highWater: last, lastRun: now });
            failureCounts.get(handle)?.delete(chatKey);
            summary.advanced = true;
        }

        // One announcement for the whole rescan — see the note at the live call.
        announceWrites(context, { handle, chatId: chatKey, items: written, epoch });

        normal().info(
            '[Mnemosyne] rescan: done — %d turns in %d passes (%d failed): %d stored, %d superseded, %d already ' +
            'known, %d kept as history.%s',
            summary.turns, summary.passes, summary.failed, summary.tally.stored, summary.tally.superseded,
            summary.tally.duplicate, summary.tally.history, summary.advanced ? ' The chat\'s mark moved to the last rescanned turn.' : '',
        );
    } finally {
        inFlight.delete(handle);
    }

    return summary;
}
