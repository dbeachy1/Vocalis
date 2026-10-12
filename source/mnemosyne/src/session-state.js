import { normal, sensitive } from './logging.js';

/**
 * Holds per-user recall, ingest, and gate records in memory. Every registered map is cleared when its
 * account locks, so sensitive statements do not outlive the vault session. Record shapes are defined by
 * `panel-view.js`; the encrypted store remains the durable source.
 */

/**
 * Maps holding per-user state, registered so {@link dropForHandle} can clear them all.
 *
 * The registry lets lock cleanup clear every registered per-user map.
 * @type {Set<Map<string, any>>}
 */
const perUser = new Set();

/**
 * Declare a map as holding per-user state. Returns it, so the registration and the declaration are one
 * expression and a map cannot be created without joining the lock path.
 *
 * Other modules may register maps here. Key each map by account handle so {@link dropForHandle} can clear it;
 * nest chat- or character-specific state inside that account's value.
 *
 * @template T
 * @param {Map<string, T>} map
 * @returns {Map<string, T>}
 */
export function registerPerUserState(map) {
    perUser.add(map);
    return map;
}

/**
 * Latest recall shown by the panel and status routes. This in-memory view is as sensitive as the store and is
 * cleared when the account locks.
 * @type {Map<string, import('./panel-view.js').RecallRecord>}
 */
const lastRecall = registerPerUserState(new Map());

/**
 * Latest memory write shown by the panel and status routes. Cleared on lock; durable data remains in the
 * encrypted store.
 *
 * @type {Map<string, import('./panel-view.js').IngestRecord>}
 */
const lastIngest = registerPerUserState(new Map());

/**
 * The last {@link RECALL_HISTORY} recall records per handle, newest first — what the panel pages back through.
 *
 * Bounded recall history for panel paging. Kept separate so {@link lastRecall} continues to mean only the
 * current turn. Records contain memory text, so they are registered for lock cleanup and capped per account.
 *
 * @type {Map<string, import('./panel-view.js').RecallRecord[]>}
 */
const recallHistory = registerPerUserState(new Map());

/**
 * How many turns back the panel can look.
 *
 * Keep the in-memory diagnostic history bounded; it is not an audit log.
 */
export const RECALL_HISTORY = 20;

/**
 * Record what retrieval just did for a user.
 *
 * `epoch` is an optional lock token used by {@link locked}; it is not part of the renderer's record shape.
 * Synchronous decline paths may omit it.
 *
 * @param {string} handle
 * @param {import('./panel-view.js').RecallRecord & { epoch?: number }} record
 * @returns {void}
 */
export function setRecall(handle, record) {
    // 🔒 A record that belongs to a vault which has since locked is not written. See {@link locked}.
    if (locked(handle, record?.epoch)) {
        return;
    }

    lastRecall.set(handle, record);

    // Append through the same lock check as the current record, including decline paths.
    const history = recallHistory.get(handle) ?? [];

    history.unshift(record);
    history.length = Math.min(history.length, RECALL_HISTORY);
    recallHistory.set(handle, history);
}

/**
 * The last recall record for a handle, or undefined.
 * @param {string} handle
 * @returns {import('./panel-view.js').RecallRecord|undefined}
 */
export function getRecall(handle) {
    return lastRecall.get(handle);
}

/**
 * Every recall record still held for a handle, newest first.
 *
 * Returns a new array; its records are shared and treated as immutable after insertion.
 *
 * @param {string} handle
 * @returns {import('./panel-view.js').RecallRecord[]}
 */
export function getRecalls(handle) {
    return [...(recallHistory.get(handle) ?? [])];
}

/**
 * Record that memories were written for a user, for the panel to read.
 *
 * Store one record per pass, deduplicating identical text written for multiple characters in a group chat.
 *
 * @param {string} handle The user whose memory was written
 * @param {{ chatId?: string|null, items: Array<{ text: string, replaced?: string|null }>, epoch?: number }} pass
 *   `epoch` is the lock token, for the same reason and with the same meaning as in {@link setRecall}.
 * @returns {void}
 */
export function noteIngest(handle, { chatId = null, items, epoch }) {
    try {
        // Discard results from an ingest pass that resumed after the account locked.
        if (locked(handle, epoch)) {
            return;
        }

        const seen = new Set();
        const unique = [];

        for (const item of items ?? []) {
            if (typeof item?.text !== 'string' || seen.has(item.text)) {
                continue;
            }
            seen.add(item.text);
            unique.push({ text: item.text, replaced: item.replaced ?? null });
        }

        if (unique.length === 0) {
            return;
        }

        lastIngest.set(handle, {
            active: true,
            count: unique.length,
            chatId: chatId ?? null,
            at: Date.now(),
            items: unique,
        });
    } catch (error) {
        // Never throws into a caller: this runs off the ingest path, which promises never to take a reply down.
        // A failed record is a blind panel, which is worth saying, and nothing more.
        normal().error('[Mnemosyne] Failed to record a write for the panel. Details suppressed.');
        // ⚠️ `{ message?: string }` rather than `Error`: a `catch` binding is `unknown` because JavaScript can
        // throw anything, and an optional message is the true statement — this line already prints
        // `undefined` for a thrown value that carries none, and the annotation now says so instead of
        // promising a string that is always there.
        sensitive().error('[Mnemosyne] That failure was for %s: %s', handle,
            /** @type {{ message?: string }|null|undefined} */ (error)?.message);
    }
}

/**
 * The last write record for a handle, or undefined.
 * @param {string} handle
 * @returns {{ active: boolean, count: number, chatId: string|null, at: number, items: Array<{ text: string, replaced: string|null }> }|undefined}
 */
export function getIngest(handle) {
    return lastIngest.get(handle);
}

/**
 * Latest ingest-gate decision shown by the panel. The panel cannot recompute fresh-turn counts because it has
 * no generation window. This record contains counts and a chat id, and is registered for lock cleanup.
 *
 * @type {Map<string, import('./panel-view.js').GateRecord>}
 */
const lastGate = registerPerUserState(new Map());

/**
 * Record what the trigger gate decided this turn.
 *
 * @param {string} handle
 * @param {{ fresh: number, needed: number, chatId?: string|null, at?: number }} decision
 * @returns {void}
 */
export function noteGate(handle, { fresh, needed, chatId = null, at = Date.now() }) {
    lastGate.set(handle, { fresh, needed, chatId, at });
}

/**
 * The last gate decision for a handle, or undefined.
 * @param {string} handle
 * @returns {import('./panel-view.js').GateRecord|undefined}
 */
export function getGate(handle) {
    return lastGate.get(handle);
}

/**
 * Latest ingest result shown by the panel, including failures that do not advance the gate's high-water mark.
 * Store only content-free reasons from `describeFailure`, never raw error messages or chat content. This
 * per-user record is cleared on lock.
 *
 * @type {Map<string, import('./panel-view.js').OutcomeRecord>}
 */
const lastOutcome = registerPerUserState(new Map());

/**
 * Record the last ingest result. `consecutive` counts failures since the last success and is computed here so
 * callers cannot leave the panel's failure state stale. Callers that cross an `await` must pass the captured
 * epoch; stale results are discarded after a lock.
 *
 * @param {string} handle
 * @param {{ ok: boolean, reason?: string|null, fix?: string|null, chatId?: string|null, at?: number,
 *          epoch?: number }} outcome
 * @returns {void}
 */
export function noteOutcome(handle, { ok, reason = null, fix = null, chatId = null, at = Date.now(), epoch }) {
    if (epoch !== undefined && locked(handle, epoch)) {
        return;
    }

    const previous = lastOutcome.get(handle);
    const consecutive = ok ? 0 : (previous && !previous.ok ? previous.consecutive : 0) + 1;

    lastOutcome.set(handle, { ok, reason, fix, chatId, at, consecutive });
}

/**
 * How the last ingest pass ended for a handle, or undefined if none has run since unlock.
 * @param {string} handle
 * @returns {import('./panel-view.js').OutcomeRecord|undefined}
 */
export function getOutcome(handle) {
    return lastOutcome.get(handle);
}

/**
 * Drop this user's registered state when `closeFor` locks or logs out the account.
 *
 * @param {string} handle
 * @returns {void}
 */
export function dropForHandle(handle) {
    // Invalidate in-flight writers before clearing their records.
    epochs.set(handle, (epochs.get(handle) ?? 0) + 1);

    for (const map of perUser) {
        map.delete(handle);
    }
}

/**
 * Lock generations survive state cleanup so asynchronous writers can detect that their session is stale.
 * @type {Map<string, number>}
 */
const epochs = new Map();

/**
 * Take the current lock generation for a handle — a token to hand back to {@link locked} later.
 *
 * @param {string} handle
 * @returns {number}
 */
export function epochOf(handle) {
    return epochs.get(handle) ?? 0;
}

/**
 * Return whether a lock occurred after the writer captured `epoch`. Clearing maps alone is insufficient because
 * work suspended at an `await` can resume after cleanup; writers use this check to discard stale results.
 *
 * @param {string} handle
 * @param {number|undefined} epoch The generation taken before the await
 * @returns {boolean} true if the record should be discarded
 */
export function locked(handle, epoch) {
    return epoch !== undefined && epoch !== epochOf(handle);
}

/**
 * Drop registered state for every user.
 * @returns {void}
 */
export function dropAll() {
    for (const map of perUser) {
        map.clear();
    }
}
