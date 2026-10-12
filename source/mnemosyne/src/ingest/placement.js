import { INGEST_DEFAULTS } from '../config.js';
import { normal, sensitive } from '../logging.js';
import { TIER_SCENARIO, TIER_USER, scopeKey } from '../schema.js';
import { cosineToL2, l2ToCosine } from '../similarity.js';

import { hasStateChangeMarker } from './quality.js';

/**
 * Where a surviving candidate actually goes: which tier it belongs to, which characters learn it, whether it
 * is already known, and whether it retires something older (§5.3 tiers 4–5).
 *
 * 🔴 This is the WRITE side, and the scoping rules here are stricter than retrieval's for a reason stated in
 * full on {@link placeInPartition}: a mis-scoped read surfaces the wrong memory, whereas a mis-scoped
 * dedup search can `supersede()` — retiring another character's memory because this one happened to look
 * similar. Correct-looking recall over a store that is quietly destroying itself.
 *
 * ⚠️ **`placeInPartition` logs `type` / `importance` / `subject` on the NORMAL channel.** That is safe only
 * because each comes from a closed alternation in `extraction.js`'s `LINE_RE`. See that module's header: if
 * the regex is loosened, this becomes SENSITIVE in the same commit.
 */

/**
 * Who a memory is about and how long it lives: the three scoping axes plus the display name, exactly as the
 * fork handed them to `maybeIngest` (the "Identity" section of src/schema.js).
 *
 * 🔴 **`charName` travels with them and keys NOTHING.** It is here because the extraction prompt wants a
 * human-readable name and `memories.char_name` is a display cache rewritten on every write. Every partition
 * decision made from this object is made from the other three — see {@link speakersIn}, which is where the
 * temptation to key on a name is strongest and is refused at length.
 *
 * ⚠️ **Every axis is nullable, and a `null` is a real partition rather than a wildcard**: `scopeKey` composes
 * one from `''`, meaning "no character" or "no persona", and it matches only other memories with none. The
 * exception is `chatId`, whose absence stops ingest before a write is ever attempted — there is nowhere to keep
 * a high-water mark — so anything reached from `placeCandidate` has one.
 *
 * @typedef {object} IngestIdentity
 * @property {string|null} charId
 * @property {string|null} personaId
 * @property {string|null} chatId
 * @property {string|null} charName
 */

/**
 * A candidate that was WRITTEN into a partition, and what it stood on if anything.
 *
 * 🔴 **Two shapes rather than one with optional fields, because `text` is present exactly when something was
 * written.** ingest pushes `{ text, replaced }` into the panel record for every outcome that is not
 * `duplicate`, and splitting the type is what makes that a deduction the checker follows rather than an
 * optional field and a hope. `replaced` is the RETIRED statement and exists only on a supersession, so a
 * reader can always tell a replacement from an addition by whether it is there.
 *
 * @typedef {{ outcome: 'stored'|'superseded', text: string, replaced: string|null }} PlacementWrite
 */

/** Already known: nothing was written, so there is nothing to show the user. @typedef {{ outcome: 'duplicate' }} PlacementDuplicate */

/**
 * Stored, but straight into the version history of a NEWER memory — a rescan found an older state of a fact the
 * store already holds a later state of. Written and retired in one step, so it is not live and is not shown as
 * just remembered. See {@link originOrder}.
 * @typedef {{ outcome: 'history' }} PlacementHistory
 */

/** @typedef {PlacementWrite|PlacementDuplicate|PlacementHistory} PlacementResult */

/**
 * Which messages a memory was read from — kept on every memory ingest writes, as `metadata.origin`.
 *
 * Extraction time cannot order memories found by a rescan, because rescans process old messages later. Use the
 * source turns' send times when available.
 *
 * ⚠️ It is the range of turns the PASS read, not the one turn a statement came from: the extractor reads a
 * window and does not say which line produced which memory. `chatId` repeats the column deliberately — a
 * search hit does not carry the identity columns (`SearchHit`), and an index range means nothing without the
 * chat it indexes into.
 *
 * @typedef {object} MemoryOrigin
 * @property {string} chatId The chat the indices below index into
 * @property {number} from `chat`-relative index of the first new turn the pass read
 * @property {number} to `chat`-relative index of the last turn the pass read
 * @property {number|null} sentFrom Earliest send time among those turns, epoch ms — null when none had one
 * @property {number|null} sentTo Latest send time among those turns, epoch ms — null when none had one
 */

/**
 * The origin record for a set of turns, or null when there are none.
 *
 * @param {string} chatId
 * @param {ForkRecentMessage[]} turns The new turns a pass read, in chat order
 * @returns {MemoryOrigin|null}
 */
export function originOf(chatId, turns) {
    if (turns.length === 0) {
        return null;
    }

    // `sendDate` is absent below fork apiVersion 7 and null on a message with no readable time. Either way it
    // contributes nothing, and a range built from the turns that do have one is still a true bound.
    const times = turns.map(t => t.sendDate).filter(t => typeof t === 'number' && Number.isFinite(t));

    return {
        chatId,
        from: turns[0].index,
        to: turns[turns.length - 1].index,
        sentFrom: times.length ? Math.min(...times) : null,
        sentTo: times.length ? Math.max(...times) : null,
    };
}

/**
 * Whether a rescan candidate's messages come BEFORE or AFTER those of the memory it would replace.
 *
 * Rescans use this comparison because they can revisit older turns. Live placement currently treats a candidate
 * as newer, so correctness depends on extraction distinguishing fresh evidence from processed context; origin
 * timestamps for the whole fresh window cannot prove which turns support an individual candidate. Without this
 * check, an older rescan candidate could retire a newer state.
 *
 * Three sources of order, strongest first:
 *   1. Both memories carry send times: compare the ranges.
 *   2. Both carry index ranges into the SAME chat: compare those. Indices in different chats mean nothing
 *      relative to each other, which is why a user-tier memory from another chat falls through.
 *   3. The stored memory predates origins but has `extractedAt`: its messages were sent no later than that.
 *      So a candidate sent AFTER it is newer. Sent before, it proves nothing.
 *
 * Overlapping ranges, or no usable fact, are `unknown`. The caller then keeps both memories live rather than
 * guessing which one to retire.
 *
 * @param {MemoryOrigin|null} origin The candidate's
 * @param {import('../schema.js').MemoryMetadata|null} existing The stored memory's metadata
 * @returns {'newer'|'older'|'unknown'} The candidate's position relative to the stored memory
 */
export function originOrder(origin, existing) {
    if (!origin) {
        return 'unknown';
    }

    const theirs = /** @type {Partial<MemoryOrigin>|undefined} */ (existing?.origin);

    /**
     * @param {number} ourFrom @param {number} ourTo @param {number} theirFrom @param {number} theirTo
     * @returns {'newer'|'older'|'unknown'}
     */
    const compare = (ourFrom, ourTo, theirFrom, theirTo) => {
        if (ourFrom > theirTo) return 'newer';
        if (ourTo < theirFrom) return 'older';
        return 'unknown';
    };
    const num = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);

    if (theirs && num(origin.sentFrom) && num(origin.sentTo) && num(theirs.sentFrom) && num(theirs.sentTo)) {
        return compare(/** @type {number} */ (origin.sentFrom), /** @type {number} */ (origin.sentTo),
            /** @type {number} */ (theirs.sentFrom), /** @type {number} */ (theirs.sentTo));
    }

    if (theirs && theirs.chatId === origin.chatId && num(theirs.from) && num(theirs.to)) {
        return compare(origin.from, origin.to, /** @type {number} */ (theirs.from), /** @type {number} */ (theirs.to));
    }

    const extractedAt = existing?.extractedAt;

    if (num(extractedAt) && num(origin.sentFrom) && /** @type {number} */ (origin.sentFrom) > /** @type {number} */ (extractedAt)) {
        return 'newer';
    }

    return 'unknown';
}

/**
 * Which tier an extracted memory belongs to — how long it lives, and therefore what it is keyed on.
 *
 * 🔴 **This is the classification the fork explicitly left to us** (fork §22.4: "the fork supplies stable
 * identity on three axes and decides nothing about what a memory is"). It is decided here, from the `subject`
 * the extractor already attributes every line with, and that reuse is the point rather than a shortcut:
 * `subject` has always asked *whose durable truth this is*, which is the same question the tier answers.
 * Inventing a second, parallel axis for the model to reason about would give two answers to disagree.
 *
 * The line is **durability, not fiction-vs-reality**:
 *
 *   - `user` → {@link TIER_USER}. A property of the person on the other side of the screen, as they present
 *     through this persona. Still true in a completely different story, so it crosses every chat with this
 *     character. "The user is afraid of heights."
 *   - `char` / `world` → {@link TIER_SCENARIO}. Something true inside *this* story — events, revelations, the
 *     world, how things stand. Includes the character's own revealed backstory, which reads like a durable
 *     fact and is not one: backstory revealed while playing in ancient Egypt was invented for ancient Egypt,
 *     and carrying it into the next chat set in space is exactly the nonsense the second tier exists to stop.
 *
 * Anything unrecognized falls to `scenario`, which is the conservative direction: an unclassifiable memory
 * stays in the chat it came from rather than being promoted into every future conversation.
 *
 * @param {string} [subject] Optional, and 🔴 **this function's own doc block above promises**
 *        "anything unrecognized falls to `scenario`" — a promise the old `@param {string}` contradicted, and
 *        one a caller reading only the tag would not know it could rely on. The extractor's attribution — `user`, `char` or `world`
 * @returns {string} TIER_USER or TIER_SCENARIO
 */
export function tierFor(subject) {
    return subject === 'user' ? TIER_USER : TIER_SCENARIO;
}

/**
 * The one confirm call for an uncertain near-duplicate (§5.3 tier 4, Smart-Memory's method B). Returns true for
 * UPDATE (supersede) and false for INDEPENDENT — and false if the call fails, because storing a redundant fact
 * is cheaper than losing one.
 *
 * @param {{ handle: string, context: import('../host/context.js').HostContext, existingText: string,
 *           newText: string }} ask `context` is the WRAPPER, not a raw fork context: `generate` is called on it
 *        below with no guard, and `HostContext` is what turns a fork that lacks it into a stated error instead
 *        of a `TypeError`. `src/index.js` passes the wrapper into ingest for exactly that reason.
 * @returns {Promise<boolean>} true for UPDATE
 */
export async function confirmUpdate({ handle, context, existingText, newText }) {
    const prompt = `Existing memory: ${existingText}
New memory: ${newText}
Does the new memory UPDATE or REPLACE the existing one, or are both INDEPENDENTLY true? Answer with one word: UPDATE or INDEPENDENT.`;

    try {
        // 🔴 `wrap: true` (R4): put the instruct envelope round this. Without it we hand a bare question to an
        // RP-tuned model, which tends to CONTINUE it as prose rather than answer it — see the note on the
        // extraction call below, which has the full reasoning. 🔴 Never add `stop` alongside it.
        const { text } = await context.generate({
            handle, prompt, wrap: true,
            maxTokens: INGEST_DEFAULTS.confirmMaxTokens, temperature: INGEST_DEFAULTS.confirmTemperature,
        });
        // 🔴 INDEPENDENT WINS TIES, AND THE BARE `\bupdate\b` TEST COULD NOT EXPRESS THAT.
        //
        // The old test was `/\bupdate\b/i.test(text)` — true for the NEGATIVE answer ("the new memory does not
        // update the existing one") and true for a model that echoes the question it was asked ("UPDATE or
        // INDEPENDENT? INDEPENDENT."), which is the documented habit of the RP-tuned models this runs against
        // and the reason `wrap: true` is above. Both readings retire a memory that is independently true.
        //
        // The asymmetry is deliberate and matches the `catch` below: a false negative stores one memory too
        // many, which the user can see and delete. A false positive retires a true memory, which leaves
        // `search()` silently and is only undone by finding it in the panel. So an answer that mentions both
        // words, or neither, is not an update.
        const answer = String(text ?? '');
        return /\bupdates?\b/i.test(answer) && !/\bindependent(ly)?\b/i.test(answer);
    } catch {
        return false;
    }
}

/**
 * Everyone who was in the room for the extracted window — the characters a user-tier memory is written for.
 *
 * ## The bug this exists to fix
 *
 * Ingest batches per CHAT: the high-water mark keys on `chatId`, the trigger counts 12 messages and the window
 * spans up to 40. In a group chat that window covers many members' turns — but every memory it yields used to
 * be attributed to whichever character happened to be speaking when the counter tripped. So which character
 * learned a durable fact about the user was decided by **turn order**, arbitrarily and invisibly: from the
 * outside it looks like a deliberate characterization choice rather than an off-by-one in a counter.
 *
 * **Being drafted to speak is what it means to be in the room.** A character missing a fact
 * because they were genuinely absent is correct. A character missing it because a counter landed on someone
 * else's turn is not. So user-tier memories are written for every character who spoke in the window.
 *
 * The triggering character is always included even if they have not spoken in it — they are being drafted
 * right now, which is the same claim to presence.
 *
 * 🔴 **Keyed on a per-turn `charId`, never on `name`.** This is the one place it would be tempting to use the
 * display name that already rides on every turn, and it is the write path — the half where getting identity
 * wrong does not merely fail to recall a memory but files it into the wrong character's partition, or lets it
 * `supersede()` a stranger's. Two cards can share a name and a rename changes it; that is the entire bug
 * schema v4 exists to end, and reintroducing it here would be reintroducing it in the worse place.
 *
 * ⚠️ **Dormant until the fork puts `charId` on each turn.** No turn carries one today, so this collapses to
 * "the triggering character alone" — exactly the current behavior, with no group fan-out. It goes live the
 * moment the field arrives, with no further change here. Same pattern R2/R3 followed.
 *
 * ⚠️ **`recentMessages` may be `undefined`, but it may not be OMITTED**, which is not the same thing and is what
 * the annotation here used to say — an optional parameter in front of a required one describes a call nobody
 * can make. The window genuinely can arrive as nothing (a caller with no slice, and `ingest.test.js` passes
 * `undefined` on purpose), and `identity` has always been required: it is the fallback the whole function
 * returns when no turn carries an id.
 *
 * @param {ForkRecentMessage[]|undefined} recentMessages The fork's window
 * @param {IngestIdentity} identity The triggering generation's own identity
 * @returns {IngestIdentity[]} One identity per character to write for — never empty
 */
export function speakersIn(recentMessages, identity) {
    /** @type {Map<string, string>} charId → the freshest display name seen for it. Ids key; names ride. */
    const byId = new Map();

    for (const message of recentMessages ?? []) {
        if (typeof message?.charId === 'string' && message.charId) {
            // Last name wins: it is the display cache, and the most recent spelling is the freshest guess.
            byId.set(message.charId, typeof message.name === 'string' ? message.name : '');
        }
    }

    if (identity.charId && !byId.has(identity.charId)) {
        byId.set(identity.charId, identity.charName ?? '');
    }

    if (byId.size === 0) {
        return [identity];      // no per-turn ids (today's fork), or no character at all — attribute to the trigger
    }

    return [...byId].map(([charId, charName]) => ({ ...identity, charId, charName }));
}

/**
 * Run one candidate into ONE partition: the dedup/supersession decision and the write that follows from it.
 *
 * Split out of {@link placeCandidate} so the fan-out above can run it once per character without any of the
 * decision logic knowing that fan-out exists. Each target's partition is judged independently, and that is
 * deliberate — the same statement landing in two characters' partitions is two characters knowing the same
 * thing, which is the point rather than a duplicate to be collapsed.
 *
 * @param {object} args
 * @param {import('./extraction.js').Candidate} args.candidate The line the extractor produced
 * @param {MemoryOrigin|null} [args.origin] Which messages the pass read — stored on the memory
 * @param {boolean} [args.rescan] True on a rescan of old messages, which must not let an older state of a
 *        fact retire a newer one. See {@link originOrder}.
 * @param {string} args.tier {@link TIER_USER} or {@link TIER_SCENARIO}, decided by {@link tierFor}
 * @param {IngestIdentity} args.target The identity of the ONE partition being written. For a user-tier memory
 *        this is one of {@link speakersIn}'s fan-out and is not necessarily the character who triggered the pass.
 * @param {number[]} args.vector The candidate's embedding, from the batch `context.embed` returned
 * @param {string} args.model The embedding model's id, verbatim from the fork — never inferred (fork §13.3)
 * @param {string} args.handle
 * @param {import('../store.js').MemoryStore} args.store
 * @param {import('../host/context.js').HostContext} args.context The wrapper — see {@link confirmUpdate}
 * @param {number} args.now Epoch ms for this pass, injected so the clock in `metadata.extractedAt` is the
 *        caller's rather than this function's
 * @param {import('../config.js').IngestDefaults} args.defaults
 * @returns {Promise<PlacementResult>} what happened — the verb for logging, and for the two writing outcomes
 *          the statement itself, so the panel can show the user what was just remembered without re-reading
 *          the store.
 */
export async function placeInPartition({ candidate, origin = null, rescan = false, tier, target, vector, model, handle, store, context, now, defaults }) {
    const registered = store.registerModel(model, vector.length);
    const identity = target;
    const scope = scopeKey({ tier, ...identity });

    // 🔴 The dedup search is scoped for a STRONGER reason than retrieval is. An unscoped neighbor search does
    // not merely surface the wrong character's memory — it can `supersede()` it, retiring another character's
    // memory because this one's happened to look similar. Read-side scoping with write-side leakage is the
    // worst of both: correct-looking recall over a store that is quietly destroying itself.
    //
    // 🔴 And it is ONE partition, this candidate's own — never both tiers. A durable fact about the user must
    // not be able to retire a scene from some chat it happens to resemble, nor the reverse: the two tiers have
    // different lifetimes, so a memory in one is never a stale version of a memory in the other. Supersession
    // only means anything between memories that live equally long.
    const hits = store.search(registered.id, vector, 1, { scopes: [scope] });
    const top = hits[0];

    const duplicateL2 = cosineToL2(defaults.duplicateCosine);
    const supersedeL2 = cosineToL2(defaults.supersedeCosine);
    const marker = hasStateChangeMarker(candidate.statement);

    // What the extractor said, kept as the extractor said it. Identity is NOT duplicated in here any more —
    // it is four real columns now, and a second copy in a JSON blob is a second copy to disagree.
    const metadata = {
        type: candidate.type,
        importance: candidate.importance,
        subject: candidate.subject,
        extractedAt: now,
        // Omitted rather than null when unknown, so a memory from a pass with no turns reads exactly like one
        // written before origins existed — `originOrder` treats both the same way.
        ...(origin ? { origin } : {}),
    };

    // ⚠️ `indexLine` rides alongside the text rather than replacing it: `text` is injected, `indexLine` is
    // embedded, and `vector` above is the embedding OF the index line (see ingest/index.js, which calls
    // `embedText` to decide that). A write that stored one and embedded the other would put the memory at
    // coordinates search never visits — and nothing downstream could detect it.
    const written = { text: candidate.statement, indexLine: candidate.indexLine, vector, model, source: 'auto', metadata, tier, ...identity };

    // 🔴 Every line below logs the memory's SHAPE and never its statement (see the logging note at the top of
    // this file). `nearest` is the debugging gold: it is the number the duplicate/supersede thresholds are
    // compared against, so a log full of "stored, nearest cos 0.83" beside a duplicateCosine of 0.85 is what
    // tells you the first-cut thresholds are wrong — which is the whole reason those numbers are marked ⚠.
    const nearest = top ? l2ToCosine(top.distance).toFixed(3) : 'n/a';
    // 🔴 `tier` and `scope` earn their place in every line: which partition a memory landed in is the fact that
    // decides whether it is ever seen again, and a scoping bug is otherwise invisible until someone notices a
    // character has forgotten them. The scope string is composed of opaque ids, never memory text.
    //
    // 🔴 `tag` is publishable (NORMAL) and that rests entirely on LINE_RE. Every field in it comes out of a
    // closed alternation in that regex — `fact|relationship|preference|event`, `[1-3]`, `user|char|world` — and
    // `tier` is derived from the third. The model cannot put arbitrary text in any of them; only group 4, the
    // statement, is free, and the statement is never in `tag`. **If LINE_RE is ever loosened to accept a freer
    // type or subject, this becomes SENSITIVE in the same commit** — that is the coupling, stated where the
    // claim is made rather than left for someone to rediscover.
    const tag = `tier=${tier} type=${candidate.type} importance=${candidate.importance} subject=${candidate.subject}`;

    // The scope key and the character name are the user-authored half of every line below: `scope` is composed
    // from charId/personaId/chatId, and a person typed the name. They travel together, one line down.
    const who = () => sensitive().debug(
        '[Mnemosyne] ...that memory was for %s, scope %s, character %s.',
        handle, JSON.stringify(scope), JSON.stringify(identity.charName ?? ''),
    );

    /**
     * @param {string} why The band this landed in, for the log line — never the statement
     * @returns {PlacementWrite}
     */
    const storeNew = (why) => {
        const id = store.remember(written);
        normal().info('[Mnemosyne] Stored memory %d — auto, %s, nearest cos %s (%s).', id, tag, nearest, why);
        who();
        return { outcome: 'stored', text: candidate.statement, replaced: null };
    };

    /**
     * A replacement, checked against message order first when this is a rescan. See {@link originOrder}.
     *
     * 🔴 An older state never retires a newer one. It is stored and retired BEHIND the newer memory, so it
     * lands in that memory's version history — nothing is discarded, and "Show replaced" shows it. When the
     * order cannot be told, both stay live: a redundant memory the user can delete beats a true one silently
     * retired.
     *
     * @param {string} why Which rule adjudicated it, for the log line — never the statement
     * @returns {PlacementResult}
     */
    const replace = (why) => {
        const order = rescan ? originOrder(origin, top.metadata) : 'newer';

        if (order === 'newer') {
            return supersede(why);
        }

        if (order === 'older') {
            const id = store.remember(written);
            store.retireMemory(id, top.id);
            normal().info(
                '[Mnemosyne] Stored memory %d — auto, %s — as HISTORY of memory %d: it would replace it (nearest ' +
                'cos %s, %s), but its messages are older, so the newer memory stays live.',
                id, tag, top.id, nearest, why,
            );
            who();
            return { outcome: 'history' };
        }

        return storeNew(`${why}, but message order is unknown, so both stay live`);
    };

    /**
     * @param {string} why Which rule adjudicated it, for the log line — never the statement
     * @returns {PlacementWrite}
     */
    const supersede = (why) => {
        const id = store.remember(written);
        store.retireMemory(top.id, id);
        normal().info(
            '[Mnemosyne] Stored memory %d — auto, %s; it SUPERSEDES memory %d (nearest cos %s, %s). The old ' +
            'one is retired, not deleted.',
            id, tag, top.id, nearest, why,
        );
        who();
        // 🔴 The retired statement rides back so the panel can say what this replaced. "A memory was added" is
        // only half of a supersession, and the half that misleads: shown alone, a corrected fact reads as a
        // second, contradictory one. The old text is no more sensitive than the new — both come out of the same
        // store, both die with it — but it exists ONLY on this path, so a reader of the record can always tell a
        // replacement from an addition by whether it is there.
        return { outcome: 'superseded', text: candidate.statement, replaced: top.text };
    };

    // No neighbor at all → nothing to be a duplicate of.
    if (!top) {
        return storeNew('first of its kind');
    }

    // Remember: smaller distance = more similar. Tiers run cheap-first.
    //
    // 🔴 A MARKER ALONE NEVER RETIRES ANYTHING. It used to: the old shape was `distance <= supersedeL2 && marker
    // → supersede()`, which reached all the way down to `supersedeCosine` (0.60) with no adjudication at all,
    // because the confirm below was only reachable when `marker` was FALSE. So the wide, uncertain band — the
    // one where the two memories are merely *related* — was the band with no check in it, and the narrow,
    // near-identical band was the careful one. That is backward, and it cost true memories: at 0.60 a sentence
    // embedder is saying "vaguely on the same topic", and `hasStateChangeMarker` was matching the word "left" in
    // "her left forearm". Retirement is invisible to the user (a retired row leaves `search()`) and is only
    // undone by finding it in the panel, so a false positive here is silent, permanent data loss.
    //
    // The bands now read the way their names always claimed:
    //   ≥ duplicateCosine (0.85): near-identical. A marker here is a correction of THIS fact → supersede.
    //                             No marker → the same fact again → drop.
    //   ≥ supersedeCosine (0.60): related but not the same. ASK, marker or not.
    //   below:                    genuinely new.
    if (top.distance <= duplicateL2) {
        if (marker) {
            // Near-identical AND the model flagged a change: this is a restatement of the same fact with a new
            // value, which is exactly what supersession is for. No confirm needed at this similarity.
            return replace('near-identical, with a state-change marker');
        }
        normal().info(
            '[Mnemosyne] Dropped a duplicate — %s, already known as memory %d (cos %s ≥ %s, no state-change ' +
            'marker).',
            tag, top.id, nearest, defaults.duplicateCosine,
        );
        who();
        return { outcome: 'duplicate' };                      // already known, no claim of change → drop
    }
    if (top.distance <= supersedeL2) {
        // The uncertain band. One tiny confirm, unless configured off (then treat as independent). A marker
        // makes this MORE likely to be an update, not certain enough to skip the question — so it rides into
        // the confirm as context rather than around it.
        if (defaults.confirmUncertain && await confirmUpdate({ handle, context, existingText: top.text, newText: candidate.statement })) {
            return replace(marker ? 'uncertain band with a marker, confirmed by the model' : 'confirmed by the model');
        }
        return storeNew(defaults.confirmUncertain ? 'uncertain band, model said independent' : 'uncertain band, confirm disabled');
    }
    return storeNew('no near neighbor');                     // far enough to be genuinely new
}

/**
 * Run one candidate through the pipeline, into every partition it belongs in (§5.3 tiers 4–5).
 *
 * **Scenario-tier memories go to exactly one partition** — `s:<chatId>`, which has no character axis at all,
 * so there is nothing to fan out to. Group members share one `chat` array in SillyTavern and therefore share
 * the scene, which is why the scenario key is `chatId` alone.
 *
 * **User-tier memories go to one partition per character in the room** — see {@link speakersIn}.
 *
 * @param {object} args
 * @param {import('./extraction.js').Candidate} args.candidate
 * @param {MemoryOrigin|null} [args.origin] Which messages the pass read — see {@link placeInPartition}
 * @param {boolean} [args.rescan] Whether this is a rescan of old messages — see {@link placeInPartition}
 * @param {number[]} args.vector
 * @param {string} args.model
 * @param {string} args.handle
 * @param {IngestIdentity} args.identity The triggering generation's identity — the fan-out's starting point
 *        for a user-tier memory, and the whole answer for a scenario-tier one
 * @param {ForkRecentMessage[]|undefined} args.windowMessages The turns this pass actually read, NOT the full
 *        window: who was in the room is decided from the same slice the extractor saw (`runExtraction`).
 * @param {import('../store.js').MemoryStore} args.store
 * @param {import('../host/context.js').HostContext} args.context
 * @param {number} args.now
 * @param {import('../config.js').IngestDefaults} args.defaults
 * @returns {Promise<PlacementResult[]>} one result per partition written
 */
export async function placeCandidate({ candidate, origin = null, rescan = false, vector, model, handle, identity, windowMessages, store, context, now, defaults }) {
    const tier = tierFor(candidate.subject);
    const targets = tier === TIER_USER ? speakersIn(windowMessages, identity) : [identity];

    if (targets.length > 1) {
        normal().info(
            '[Mnemosyne] ingest: a user-tier memory is being written for %d characters who spoke in the ' +
            'window — presence, not turn order, decides who learns it.',
            targets.length,
        );
        sensitive().debug('[Mnemosyne] That fan-out was for %s.', handle);
    }

    const outcomes = [];
    for (const target of targets) {
        // Sequential, not Promise.all: each target's dedup search must see what the previous ones wrote, and
        // the uncertain-band confirm is a generation call — one GPU, the same reason extraction is serialized.
        outcomes.push(await placeInPartition({
            candidate, origin, rescan, tier, target, vector, model, handle, store, context, now, defaults,
        }));
    }

    return outcomes;
}
