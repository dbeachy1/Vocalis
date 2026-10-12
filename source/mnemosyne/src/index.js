import { mountRoutes } from './api/routes.js';
import { CHAT_INGEST_NEEDS_FORK, INGEST_DEFAULTS } from './config.js';
import { HostContext } from './host/context.js';
import { forgetChatRetries, maybeIngest, _resetIngest } from './ingest/index.js';
import { resetTape } from './log-tape.js';
import { adoptLogger, normal, sensitive } from './logging.js';
import { identityFrom, noteInjection, retrieve, _resetRetrieval } from './retrieval.js';
import { asRuntimeDefaults, declaredReserveTokens, readSettings } from './settings.js';
import {
    closeFor, declareForeignStore, forgetChatFor, openFor, rekeyChatFor, storeFor, _resetSessions,
} from './session.js';
import { dropAll, getOutcome, noteOutcome } from './session-state.js';

/**
 * Mnemosyne plugin entry point. The host supplies all SillyTavern APIs through `context`; plugin code must
 * not import the fork's internal `src/` modules. The memory key comes from the user's vault, and per-user
 * memory state must be cleared when that vault locks.
 */

export const info = {
    id: 'mnemosyne',
    name: 'Mnemosyne',
    description: 'Encrypted, unbounded long-term memory. Requires SillyTavern-Vault.',
};


/**
 * Generation types that must skip both retrieval and ingest. `impersonate` represents the user's own line;
 * using character memories there could alter the user's voice and misattribute generated text to them.
 * Missing `genType` remains eligible for older hosts and ordinary generations. `quiet`, and anything that
 * carries no window, is left alone by {@link isBackground} rather than by this set (settled as a product rule
 * on 2026-10-10; it lives apart because an impersonation is something the user did in the chat and the panel
 * says why memory sat it out, while a background request is not a turn of the chat and must leave no trace).
 * @type {Set<string|undefined>}
 */
const DECLINED_GEN_TYPES = new Set(['impersonate']);

/**
 * Is this generation a background request rather than a reply in the chat?
 *
 * 🔴 THE RULE (product decision, 2026-10-10): memories are created from, and injected into, the character's real
 * replies only. Not Polish passes, not summaries, not image prompts. Until then Mnemosyne recalled into anything
 * it could identify, so on Chat Completion a summary request, an image prompt and a Polish pass each had the
 * user's memories pasted into them, and a `quiet` generation carrying the chat's window could start an
 * extraction.
 *
 * Two tests, because background requests arrive three ways and no single signal covers them:
 *
 *   1. **Labeled `quiet`.** SillyTavern's own background generations (`generateQuietPrompt`: Polish, `/gen`, an
 *      extension asking the main model something) on every backend, and `generateRaw` (summaries, image
 *      prompts, expression picks) on every backend as of Taproom 1.8 (before that, Chat Completion only).
 *   2. **No window.** Only the fork's `Generate()` builds `recentMessages`, and it builds it for every reply: a
 *      send, a regenerate, a swipe, a continue, each member of a group chat. So a generation with no window is
 *      one `Generate()` did not issue: a third-party extension calling the backend its own way (no label, no
 *      window), a `generateRaw` on a fork older than 1.8, a direct POST. An EMPTY window is still a window; a
 *      chat with no turns yet is a new chat.
 *
 * ⚠️ Test 2 costs something, knowingly: a real reply on a fork that failed to attach the window gets no memory.
 * That happened (streamed Kobold Classic and NovelAI, until Taproom 1.7). It is not silent: a labeled
 * generation with no window is recorded for the panel as `no-window`, and ingest's own say-once fault fires
 * (`windowlessRuns` in src/ingest/index.js).
 *
 * @param {ForkOutgoingPrompt} outgoing
 * @returns {boolean}
 */
function isBackground(outgoing) {
    return outgoing.genType === 'quiet' || !Array.isArray(outgoing.recentMessages);
}


/**
 * Start automatic ingest after retrieval. It is fire-and-forget so extraction cannot delay the reply. Ingest
 * uses the host's declared `recentMessages` window and checks capabilities for optional card and backend data.
 * @param {ForkOutgoingPrompt} outgoing
 * @param {HostContext} context The detected-capability wrapper. ⚠️ Named `context` and NOT `host` because it
 *        is forwarded under that key into `maybeIngest`, whose whole ingest tree calls it `context` — the two
 *        names are one seam and renaming half of it here would be worse than the inconsistency. It is the
 *        wrapper either way; `HostContext.from` makes the distinction moot for anything downstream.
 * @returns {void}
 */
function ingestFrom(outgoing, context) {
    const store = storeFor(outgoing.handle);

    if (!store) {
        return; // locked, or no vault — the same reason retrieve() declines; there is nowhere to ingest into.
    }

    // 🔴 THE ONE PATH EXTRACTION CANNOT TAKE ON AN OLDER FORK, DECLINED HERE AND SAID SO. Below plugin API 8
    // `context.generate` can only replay a text-completion connection, and the fork's chat route never
    // captures one — so on a Chat Completion generation the extraction call would throw ("no active backend
    // captured", or "not supported yet") on every turn, or, if this user had generated on a text backend
    // earlier in the process, quietly run the extraction against THAT backend instead of the one they are
    // talking to. Neither is a pass worth firing. See the `chatGenerate` row in host/capabilities.js.
    //
    // ⚠️ Declined THROUGH `noteOutcome`, not silently, and recorded ONCE rather than per turn. A silent skip
    // leaves the panel header promising "Next check on your next reply" for ever, which is the exact failure
    // the outcome record was added to end; and re-recording the same decline every turn would have the alert
    // banner count "N failed attempts in a row" for something that never attempted anything. So the record is
    // written only when it is not already the current outcome, and one pass that succeeds after a fork update
    // clears it the ordinary way.
    //
    // ⚠️ ONLY FOR A GENERATION THAT CARRIES A WINDOW. A window-less one reaches this function too, for
    // `maybeIngest`'s fault count and nothing else (`isBackground`); it is a background request that was not
    // recalled into, so the line below would be false about it and the outcome would put a banner on the panel
    // for a pass that was never going to run.
    if (Array.isArray(outgoing.recentMessages) && outgoing.backend === 'chat' && !context.has('chatGenerate')) {
        const chatId = identityFrom(outgoing).chatId ?? null;

        if (getOutcome(outgoing.handle)?.reason !== CHAT_INGEST_NEEDS_FORK.reason) {
            normal().info(
                '[Mnemosyne] ingest: a Chat Completion generation was recalled into but not learned from — this ' +
                'fork\'s context.generate cannot drive a chat backend (plugin API 8 adds it). Recall is unaffected.',
            );
            sensitive().debug('[Mnemosyne] That chat-mode ingest decline was for %s.', outgoing.handle);
            noteOutcome(outgoing.handle, {
                ok: false, chatId, reason: CHAT_INGEST_NEEDS_FORK.reason, fix: CHAT_INGEST_NEEDS_FORK.fix,
            });
        }
        return;
    }

    // `void`: the promise is deliberately not awaited. maybeIngest never rejects (its body is wrapped), so this
    // cannot become an unhandled rejection.
    // 🔴 THE USER'S SETTINGS, RESOLVED PER PASS. `maybeIngest` defaults to INGEST_DEFAULTS when given
    // nothing, which is what a store with no saved settings still gets — `asRuntimeDefaults` folds the
    // saved values over exactly those constants, so an unconfigured user's behavior is unchanged.
    const tuned = asRuntimeDefaults(readSettings(store));

    void maybeIngest({
        defaults: tuned.ingest,
        handle: outgoing.handle,
        identity: identityFrom(outgoing),
        // 🔴 Its own argument, NOT folded into `identity`. That object is the three scoping axes and feeds
        // `scopeKey`/`retrievalScopes`; a generation kind is not an identity and putting it there would make it
        // look like one. Ingest uses it for reporting only, and only in the POSITIVE direction — a genType that
        // is present proves `Generate()` issued the generation, so a window missing from it is a fault on the
        // spot. Absence proves nothing (fork §18.2: an ordinary turn is unlabeled too), which is why ingest
        // does not decline on it. See `windowlessRuns` in src/ingest/index.js.
        genType: outgoing.genType,
        recentMessages: outgoing.recentMessages,
        store,
        context,
    });
}


/** What the boot warm-up embeds. The text is irrelevant and its vector is thrown away — the call exists only
 * to make the pipeline load (and, on a cold cache, download) the model now, so no user's first prompt does. */
const WARMUP_TEXT = 'mnemosyne embedding warm-up';

/**
 * Pay the embedding model's load cost at boot, not on a user's first prompt.
 *
 * The first `context.embed()` call loads the model — and on a cold cache downloads ~100MB first — and whoever
 * makes that call waits for all of it (fork's DESIGN_MEMORY_PLUGIN_API.md §13.1). Left to chance that is a
 * user, mid-conversation, whose first message hangs for the length of a download. So we make the first call
 * ourselves, here, the moment the plugin registers.
 *
 * 🔴 Fire-and-forget, and it must stay that way. The fork `await`s init() inside its plugin-boot loop
 * (`plugin-loader.js:429`), so awaiting the embed here would stall the whole server's boot behind a model
 * download. Kick it off; let it settle on its own time.
 *
 * ✅ Safe at init even though openFor is not. The model is a GLOBAL, in-process resource — `embed` forwards to
 * the same transformers pipeline the fork itself uses and needs no user, no vault and no key (§13.1). That is
 * exactly why this can run before anyone has logged in, while the per-user store cannot. Do not read this
 * function's presence at boot as license for anything key-shaped up here beside it — see the ⚠️ on init.
 *
 * A failure is not fatal and must not look it: warming is an optimization, not a precondition. If autoDownload
 * is off or the network is down the embed throws — we warn and carry on, and the real embed at retrieval time
 * surfaces the same fault where it actually blocks someone. This promise must never reject unhandled.
 *
 * ⚠️ This tag used to read `@param {any} context`, describing the raw fork context — a parameter this
 * function has never had. It takes the WRAPPER, and it has to: the first line of the body asks
 * `host.has('embed')`, which only the wrapper can answer. The comment was written when the guard was a bare
 * `typeof context.embed === 'function'` and was never moved when the capability table took that over.
 *
 * @param {HostContext} host The detected-capability wrapper
 * @returns {void}
 */
function warmUpEmbeddings(host) {
    if (!host.has('embed')) {
        // A fork with storage but without the embedding capability (§13 came later than the rest). Retrieval
        // would fail later too; there is nothing to warm and no point announcing it at boot.
        return;
    }

    const startedAt = Date.now();
    normal().info('[Mnemosyne] Warming the embedding model in the background — the first prompt should not wait for it.');

    // No await (see the 🔴 above); wrapped through Promise.resolve so that even a synchronous throw from embed
    // becomes a handled rejection rather than one escaping into the boot.
    Promise.resolve()
        .then(() => host.embed([WARMUP_TEXT]))
        .then(
            // A model identifier is a config value from a fixed list and a duration is a number — this whole
            // line is NORMAL, and it is the one that tells an operator the embedder actually loaded.
            ({ model }) => normal().info('[Mnemosyne] Embedding model ready (%s) in %dms.', model ?? 'unknown', Date.now() - startedAt),
            (error) => {
                normal().warn(
                    '[Mnemosyne] Could not warm the embedding model. Not fatal — the model will load on the ' +
                    'first real embed instead, the very cost this was meant to move off a user\'s request. If ' +
                    'autoDownload is off in config.yaml, the model must already be present for memory to work. ' +
                    'Details suppressed.',
                );
                sensitive().warn('[Mnemosyne] The warm-up failure was: %s', error.message);
            },
        );
}

/**
 * The fork calls this once, at boot, long before anyone has logged in.
 *
 * ⚠️ Nothing here may ask for a key, and nothing may cache the answer to a question about a user. At init
 * there are no users, no unlocked vaults and no keys. Everything real happens in the handlers. (Two things
 * do run eagerly, and neither touches a user: warmUpEmbeddings, which loads the global model — see its note;
 * and declareForeignStore, which states where our files go, a fact that is the same in every account and
 * true before anyone logs in. That last one MUST be eager; its own note says why.)
 *
 * @param {import('express').Router} router This plugin's router, mounted at /api/plugins/mnemosyne
 * @param {ForkContext|null|undefined} context The fork's plugin context.
 *        🔴 **NULLABLE, AND AN EARLIER VERSION OF THIS TAG ARGUED THE OPPOSITE.** It read "declared
 *        non-nullable because that is what a fork with the seam passes, and the very first statement below is
 *        what handles the host that does not". The second half of that sentence refutes the first: stock
 *        SillyTavern calls `init(router)`, this reads `undefined`, and the `if (!context)` immediately below
 *        is the single most important line in the file — it is what turns "installs cleanly, logs nothing and
 *        never works" into a loud refusal.
 *
 *        A tag that forbids the one input the function exists to defend against does two bad things: it makes
 *        `plugin.test.js`'s stock-SillyTavern case unstatable without a cast, and it hands the next reader an
 *        argument for deleting the guard as unreachable. `adoptLogger` carried exactly this and was corrected
 *        in `5a12506`; the fix is the same one, for the same reason. **Describe what the function ACCEPTS,
 *        not what a well-behaved caller sends.**
 * @returns {Promise<void>}
 */
export async function init(router, context) {
    if (!context) {
        // 🔴 The one failure that cannot be recovered from and is completely silent if unhandled. An old
        // fork, or stock SillyTavern, calls init(router) and this reads undefined. Without this line
        // Mnemosyne would install cleanly, log nothing, and never work.
        // 🔴 Deliberately NOT normal(): there is no context, so there is no context.logger either, and
        // adoptLogger has not run. normal() would resolve to the console fallback and work — but writing it as
        // console.error says why out loud, at the one call site where the classified channel provably cannot
        // exist. This is also the line most likely to be read on stock SillyTavern, which has no seam at all.
        console.error(
            '[Mnemosyne] REFUSING TO START: this SillyTavern does not provide a plugin context. Mnemosyne ' +
            'requires Taproom\'s storage-provider support (Taproom is the SillyTavern fork shipped with ' +
            'Vocalis) and cannot run on stock SillyTavern. Memory is DISABLED.',
        );
        return;
    }

    // 🔴 FIRST, before anything that might log. Until this runs every line falls back to bare console.*, which
    // on a fork with the seam means SENSITIVE and therefore invisible — including whatever went wrong during
    // the rest of init. Adopting first costs nothing and buys the boot path a voice. See src/logging.js.
    const classified = adoptLogger(context);

    if (classified) {
        normal().info('[Mnemosyne] Classified logging enabled (plugin API §23) — operational lines will appear in st.log.');
    }

    // 🔴 Detect what this fork can do ONCE, here, and hand the wrapper to everything downstream. Its verdict
    // for the logger is `classified` rather than a second guess at the same question — see HostContext#detect.
    // `announce()` is what tells an operator which capabilities are missing and what each absence costs; it
    // runs immediately after adoptLogger so the report itself is publishable. (A fork with no §23 is told so
    // by that report, in the same words this function used to say it — see capabilities.js. It is deliberately
    // emitted even though such a fork will suppress it: a suppressed placeholder beats a silence that looks
    // identical to a plugin which never loaded, and in debug mode it explains the quiet.)
    const host = new HostContext(context, { classifiedLogging: classified });
    host.announce();

    // 🔴 EVERYTHING THAT CAN THROW RUNS FIRST, AND NOTHING IRREVERSIBLE IS REGISTERED UNTIL IT HAS.
    //
    // `onPrompt` and `registerPanel` are VALIDATED BY THE FORK and throw a TypeError on a bad value —
    // `reservesTokens` must be a positive integer ≤ 8192 (config.js says so itself: "a typo here throws at
    // registration"), and registerPanel checks its icon, paths and label. init used to register the storage,
    // chat-deleted and chat-renamed handlers ABOVE those calls, and that ordering was the whole bug:
    //
    // The fork catches a throw from init, logs "Plugin 'mnemosyne' threw while initializing. It is not loaded,
    // and its id stays reserved", and does NOT mount the router — the mount is after its try. But the handlers
    // already in its registries STAY there for the life of the process. So the operator is told the plugin is
    // not loaded, while every login still derives `kMemoryDb`, creates `memory/store.db` and opens a SQLCipher
    // connection. If the throw came from `registerPanel`, the interceptor is live too: memories get written
    // with the ENTIRE HTTP surface absent — no list, no edit, no delete, no panel. A store the user cannot
    // see, cannot manage, and was told does not exist.
    //
    // That is exactly the silent-death class §1 of this file exists to refuse, so the order is now: do the
    // things that can fail, THEN take on responsibilities that outlive a failure.
    // 🔴 And it says so in its OWN name before it dies. The fork's catch logs "Plugin 'mnemosyne' threw while
    // initializing", which names the plugin but not the reason, and the reason is the only actionable part —
    // `reservesTokens` out of range reads identically to a bad panel icon from outside. Rethrown, because the
    // fork's refusal to mount a plugin that could not start is correct and this must not swallow it.
    try {
        mountRoutes(router, host);
        registerInterceptor(context, host);
        registerPanelButton(host);
        registerSettingsScreen(host);
    } catch (error) {
        normal().error(
            '[Mnemosyne] REFUSING TO START: the fork rejected one of this plugin\'s registrations, so memory ' +
            'is DISABLED. Nothing has been left half-registered. The fork rejected it because: %s',
            /** @type {import('./logging.js').Thrown} */ (error)?.message ?? error,
        );
        throw error;
    }

    // From here down, every call hands the fork a callback it will keep for ever. Nothing below may throw.
    declareForeignStore(host);

    host.onStorageReady(async (handle) => openFor(handle, host));
    host.onStorageLock(async (handle) => closeFor(handle));

    // §24: the other half of "scenario memories die with the chat". See forgetChatFor.
    //
    // Guarded — by HostContext, which no-ops on a fork without the signal and has already said what that costs
    // — because this capability is newer than the set init() otherwise assumes, and its absence is invisible
    // by construction: memory keeps working, deletions keep succeeding, and scenario rows quietly accumulate
    // for ever with nothing to attribute the growth to. That is precisely the failure mode §1 of this file
    // exists to refuse, so an old fork gets told rather than silently leaking.
    host.onChatDeleted((handle, chatId) => {
        forgetChatFor(handle, chatId);
        // 🔴 The in-memory half of the same cleanup. MemoryStore.forgetChat drops the chat's high-water mark
        // inside its transaction, for a reason it states — a later chat reusing the id must not start life
        // already "extracted" — and ingest's retry counter needs dropping for exactly that reason, but lives
        // in memory where that transaction cannot reach it. Wired HERE rather than inside session.js so the
        // store lifecycle does not have to know ingest exists. See forgetChatRetries.
        forgetChatRetries(handle, chatId);
    });

    // §24.4: the other way a chatId stops matching what memories were written under — and the one that strands
    // them on a LIVE conversation rather than a dead one. See rekeyChatFor.
    //
    // Guarded like §24 above, and for a worse failure: an unhandled rename does not merely leak disk, it makes
    // a character forget everything mid-conversation with nothing raised anywhere. the host's fork predates this
    // capability and will keep predating it until someone deploys.
    host.onChatRenamed((handle, oldChatId, newChatId) => {
        rekeyChatFor(handle, oldChatId, newChatId);
        // The counter is dropped rather than moved, and that asymmetry is deliberate: rekeyChat MOVES the
        // high-water mark because losing it would re-extract the whole conversation, whereas losing a retry
        // count costs at most one retry. Dropping is always safe here; carrying a stale count to a new id is not.
        forgetChatRetries(handle, oldChatId);
        forgetChatRetries(handle, newChatId);
    });

    normal().info('[Mnemosyne] Registered. Memory opens when a vault unlocks.');

    // Load the embedding model now, at boot, so no user's first prompt pays the ~100MB download. Fire-and-
    // forget — this must never block init; see warmUpEmbeddings.
    warmUpEmbeddings(host);
}

/**
 * Register retrieval and automatic ingest on the prompt hook. Keep this separate from {@link init}, since
 * the host validates the options and can throw. `recentMessages` enables ingest and `reservesTokens` keeps
 * injected text within the prompt budget; both are required declarations. `onPrompt` is part of the required
 * host contract, so it is called on the raw context.
 *
 * @param {ForkContext} context The fork's plugin context
 * @param {HostContext} host The detected-capability wrapper
 * @returns {void}
 */
function registerInterceptor(context, host) {
    /** @type {import('./host/context.js').PresentForkContext} */ (context).onPrompt(async (outgoing) => {
        // Decline unsupported generation types before retrieval or ingest, and record the reason for the panel.
        if (DECLINED_GEN_TYPES.has(outgoing.genType)) {
            noteInjection(outgoing, { active: false, reason: `declined-${outgoing.genType}` });
            return undefined;
        }

        // 🔴 Background requests get nothing: no memories in, no memories out. See `isBackground`.
        //
        // 🔴 AND NO RECALL RECORD EITHER. The record is one deep and means "the last reply" (the panel and the
        // status light both read it that way), so writing one here would have a Polish pass or an expression pick
        // replace what the panel says about the reply the user is actually looking at. The log line is the
        // trace; the record stays the reply's.
        if (isBackground(outgoing)) {
            const labeled = outgoing.genType !== undefined && outgoing.genType !== 'quiet';

            if (labeled) {
                // The one case that is not routine: the fork named this a reply (only `Generate()` labels a
                // generation `normal`, `swipe`, `continue`, ...) and sent no window with it. That is a fork fault,
                // memory is off for the turn because of it, and the user is owed the reason on screen.
                noteInjection(outgoing, { active: false, reason: 'no-window' });
            } else {
                normal().info(
                    '[Mnemosyne] Left a background request alone — %s. Memory is recalled into, and learned ' +
                    'from, replies in a chat only.',
                    outgoing.genType === 'quiet' ? 'it was labeled quiet' : 'it carried no conversation',
                );
            }

            // ⚠️ Ingest is still told about a generation with no window, and only that one: it extracts nothing
            // from it, but it owns the count that decides whether a missing window is a fork that never sends
            // one. A `quiet` generation is skipped outright: its window is real, and reading it would be
            // learning from a background request.
            if (outgoing.genType !== 'quiet') {
                ingestFrom(outgoing, host);
            }
            return undefined;
        }

        // Retrieval works across backends; extraction checks its required host capability at the call site.
        const injected = await retrieve(outgoing, host);
        ingestFrom(outgoing, host);
        return injected;
    }, {
        recentMessages: INGEST_DEFAULTS.recentMessages,
        // This declaration is global, so reserve for the largest block allowed by the settings schema.
        reservesTokens: declaredReserveTokens(),
    });
}

/**
 * Register the optional UI panel button. Older hosts omit this capability; when present, host validation can
 * throw, so {@link init} calls it before registering handlers that cannot be removed.
 *
 * @param {HostContext} host The detected-capability wrapper
 * @returns {void}
 */
function registerPanelButton(host) {
    host.registerPanel({
        // Use a bundled Font Awesome icon so host status colors can be applied.
        icon: 'fa-solid fa-lightbulb',
        label: 'Memories',
        tooltip: 'Memories recalled for the last reply, and anything newly remembered',
        panelPath: '/panel',
        statusPath: '/status',
        // Older hosts ignore this optional field; the panel remains functional without styling.
        stylesheetPath: '/panel.css',
    });
}

/**
 * Register the settings view in the host's Extensions dialog. Both entry points use the same renderer. The
 * settings route stays query-free; locked accounts receive the read-only locked view, with no editable form.
 * Older hosts may omit this optional capability, so {@link init} registers it before non-removable handlers.
 *
 * @param {HostContext} host The detected-capability wrapper
 * @returns {void}
 */
function registerSettingsScreen(host) {
    host.registerSettings({
        label: 'Mnemosyne',
        // Describe the settings screen rather than repeating the plugin summary shown above it.
        description: 'Memory size, how often extraction runs, the prompt it uses, and saved presets.',
        settingsPath: '/panel/settings',
        // The host scopes styles by container, so the panel and settings view each receive their own style tag.
        stylesheetPath: '/panel.css',
    });
}

/**
 * The store for an unlocked user, or null.
 *
 * 🔴 RE-EXPORTED, NOT REDEFINED. The lifecycle moved to src/session.js, but this name is part of the surface
 * `tests/plugin.test.js` imports from this module, and the refactor's rule is that the fork's and the suite's
 * entry points do not move while it is in progress. One line here costs nothing and keeps that promise.
 */
export { storeFor };

/** Test seam. Not part of the plugin contract. @returns {void} */
export function _reset() {
    // Each module resets the state it owns; this is the one seam a suite has to remember.
    _resetSessions();
    _resetRetrieval();
    // Every registered per-user record, by the same mechanism closeFor uses — so a suite cannot be left
    // depending on a record that a future cache forgot to clear here.
    dropAll();
    // Ingest keeps module state of its own (say-once faults, retry counters, the in-flight set). Reset it from
    // here so a suite has one seam to remember rather than two.
    _resetIngest();
    // 🔴 The log tape is PROCESS-global — it deliberately survives a vault lock, so nothing else in this
    // function reaches it. That makes it the one piece of state a suite can silently inherit from whichever
    // tests ran before it, which is precisely what "the one seam a suite has to remember" is meant to prevent.
    resetTape();
}
