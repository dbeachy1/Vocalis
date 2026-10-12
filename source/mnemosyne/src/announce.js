import { notifyAdded } from './activity.js';
import { noteIngest } from './session-state.js';

/**
 * Memories landed — tell the user, once, however they got there.
 *
 * There are exactly two doors into the store: a curated memory posted by hand (`POST /memory`), and automatic
 * ingest extracting from the conversation. They differ completely in how they *decide* what to write — the
 * manual route stores what it is given, ingest runs a whole dedup/supersession pipeline — and they were
 * identical in what they do afterward, in two copies:
 *
 *   1. record the pass so the panel can show it, then
 *   2. push a notification so the client comes and looks.
 *
 * 🔴 **ORDER IS PART OF THE CONTRACT, WHICH IS WHY IT IS NOW IN ONE PLACE.** The record is written before the
 * push, because the push is what makes the client fetch — and a client that arrives fast must find the record
 * already there. Written twice, that ordering was two things that happened to agree.
 *
 * 🔴 **The color precedence rides on call order too, one level up.** The host treats the most recent
 * notification per plugin as the dominant one, so retrieval's green must be raised BEFORE this function's
 * purple for a turn that both recalls and remembers to end purple. That is the whole precedence rule — there
 * is no priority table anywhere — and it lives at the call sites, not here. See `activity.js`.
 *
 * ⚠️ **They had already drifted, in a small and instructive way.** The manual path passed `replaced: 0`
 * unconditionally because it has no supersession stage; ingest counted its own. Computing `replaced` from the
 * items themselves makes both correct by the same rule, and a future manual path that *does* supersede gets
 * the right badge without anyone remembering to update a literal.
 */

/**
 * Record a completed write and raise the UI notification for it.
 *
 * @param {import('./host/context.js').HostContext} host The fork, as we are allowed to see it
 * @param {{ handle: string, chatId: string|null, epoch?: number,
 *          items: Array<{ text: string, replaced?: string|null }> }} pass
 *        Everything written in this one pass. `replaced` carries the retired statement on a supersession and
 *        is absent or null on a plain addition.
 *
 *        🔒 `epoch` is OPTIONAL and the two callers differ on it deliberately, which is why it is documented
 *        here rather than assumed: ingest captures a lock generation before its awaits and passes it, so a
 *        pass finishing after a logout is dropped by `noteIngest`. `POST /memory` has crossed no await
 *        between its store call and this line and passes none, and a record with no epoch is written
 *        unconditionally — which is correct for it and would be a hole for ingest. See `locked()` in
 *        session-state.js.
 * @returns {void}
 */
export function announceWrites(host, { handle, chatId, items, epoch }) {
    // ⚠️ Guarded on what was actually WRITTEN, never on a tally that counts drops. A pass whose every candidate
    // deduped away wrote nothing, and lighting the icon for it would tell the user something was remembered
    // when the honest answer is that it was already known.
    if (!items.length) {
        return;
    }

    // 🔴 Record first, push second. See the module header — this is the ordering, and it is load-bearing.
    // 🔒 `epoch` is the lock generation captured before the extraction's awaits: `noteIngest` drops the record
    // if the vault closed in the meantime, so a pass that finishes after logout cannot deposit the user's
    // memory statements into a map the lock has already emptied.
    noteIngest(handle, { chatId, items, epoch });
    notifyAdded(host, {
        handle,
        chatId,
        // Shape only. The statements themselves stay behind GET /panel and its locked-vault gate; a count and
        // a replacement count measure the event without reconstructing any of it (activity.js).
        count: items.length,
        replaced: items.filter(item => item.replaced).length,
    });
}
