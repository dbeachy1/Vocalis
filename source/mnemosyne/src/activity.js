import { HostContext } from './host/context.js';
import { normal, sensitive } from './logging.js';

/**
 * Telling the host that something happened — the push channel, and nothing else.
 *
 * The panel (capability 7) shows what was recalled and what was written; both records live in
 * `src/session-state.js`, which owns everything held per-user and drops it on lock. **This module holds no
 * state at all.** It is the wire, not the record.
 *
 * 🔴 That separation is deliberate and it protects a rule. The records hold memory statements and are governed
 * by NFR1; a notification holds counts and is governed by the stricter rule below — nothing that carries
 * content may go in one. Keeping them in one module made the two rules neighbors, and the weaker one is the
 * easy mistake: reaching for the statements that were right there to make a notification more useful. They are
 * no longer right there.
 *
 * ## 🔴 Why a push and not the status poll
 *
 * The fork's client re-polls `statusPath` on `GENERATION_ENDED` and `CHAT_CHANGED` only. Ingest is deliberately
 * fire-and-forget (src/ingest.js) so a reply never waits on an embedding, so a memory lands *seconds after* the
 * generation ended — after the only poll that would have seen it. Left to the poll the icon lights one turn late,
 * describing the previous turn. `context.notify()` (fork capability 18, §26) exists for exactly this: the plugin
 * speaks at the moment the event happens and the host holds it until a client collects it.
 *
 * ⚠️ **The fix is never "await the ingest".** Blocking a user's reply on an embedding so an icon can be prompt is
 * a worse product than a late icon, and the fork says so in §26.0.
 *
 * ## 🔴 What does NOT go in a notification
 *
 * `data` is handed back to the client and lives in host memory. Memory text is therefore deliberately **absent**
 * from it: a count and a summary are shape, and shape reconstructs nothing. The text itself is served only by
 * `GET /panel`, which goes through `storeForRequest` and so cannot answer at all while the vault is locked. Two
 * channels, one of them gated — so the gate is worth something. If a future change wants richer notifications,
 * that is the property to weigh, not the convenience.
 */

/**
 * Either thing {@link HostContext.from} will take: the wrapper, or the fork's bare context.
 *
 * ⚠️ **Both, on purpose, and not as a convenience.** `HostContext` is duck-type compatible with the raw
 * context, so a caller may hold either — `announce.js` and `retrieval.js` pass the wrapper, and a suite builds
 * a bare object literal. `from()` normalizes, and this typedef is what stops that seam from being spelled
 * `any` at three call sites in this file.
 *
 * @typedef {HostContext | ForkContext} HostLike
 */

/**
 * Tell the host something happened, if this fork can hear it.
 *
 * 🔴 GUARDED ON THE VERSION, NOT JUST THE METHOD, and with `>=` rather than `===`. `apiVersion` is a monotonic
 * integer (fork §26.7) currently at 2; pinning to an exact value would break on the next addition the fork makes.
 * A host with no `apiVersion` predates the notion entirely, hence the `?? 0`. The `typeof` check stays too: an
 * older fork must degrade to a button that never changes color, never to a throw.
 *
 * 🔴 CAUGHT. A bad spec throws at the call site by design (fork §26), which is right for a mistake found in
 * development and wrong as a way to take down an ingest pass or a user's reply in production. So it is reported
 * and swallowed — the notification is the least important thing either caller is doing.
 *
 * @param {HostLike} context
 * @param {{ handle: string, action: string, data?: object, chatId?: string|null, color?: string, summary?: string }} spec
 *        ⚠️ `chatId` is `string|null` HERE and `string|undefined` on the fork's own `notify` — the widening is
 *        the whole point of this function's one interesting line. Callers have a null when there is no chat;
 *        the fork validates the field it is given and a null is not a chat id, so the key is dropped rather
 *        than forwarded. Declaring both sides the same would delete the distinction the code exists to make.
 * @returns {void}
 */
export function notifyHost(context, spec) {
    // The method check AND the version gate both live in the capability table now (src/host/capabilities.js),
    // where `notify` declares `minApiVersion: 2` — so this call site no longer has to remember that this is one
    // of the two capabilities needing both. `HostContext#notify` no-ops and returns false on a fork that
    // cannot hear us, which is the same degradation this function used to implement by hand.
    const host = HostContext.from(context);

    if (!host.has('notify')) {
        // 🔴 Return BEFORE touching `spec`, exactly as the hand-written guard did. `host.notify()` would
        // no-op on its own, so this looks redundant — it is not: without it a malformed spec would be
        // destructured below and throw into the catch, turning "this fork has no push channel" (a silent,
        // expected degradation) into an error line on every notification for ever.
        return;
    }

    try {
        // `chatId` is omitted rather than sent null when there is none: without it the host reports the
        // notification in EVERY chat, which is the staleness bug §14.4 exists to prevent — but a null is not a
        // chat id either, and the fork validates the field it is given.
        const { chatId, ...rest } = spec;
        host.notify(chatId ? { ...rest, chatId } : rest);
    } catch (error) {
        normal().error('[Mnemosyne] Failed to raise a UI notification. Memory itself is unaffected. Details suppressed.');
        sensitive().error(
            '[Mnemosyne] That failure was for %s: %s',
            spec?.handle,
            /** @type {import('./logging.js').Thrown} */ (error)?.message,
        );
    }
}

/**
 * Push "memories were written", in purple.
 *
 * 🔴 The colors are Mnemosyne's UI contract and are implemented HERE, not in the fork — "green means recalled" is a
 * fact about Mnemosyne, not about SillyTavern (§26.2). The host keeps the most recent notification per plugin as
 * the dominant one, so ordering the calls in the order the work happens gives the precedence for free: retrieval
 * notifies green, the write notifies purple second, and purple wins whenever a turn does both. That is exactly
 * the rule asked for, with no priority table anywhere and nothing to special-case.
 *
 * @param {HostLike} context
 * @param {{ handle: string, chatId?: string|null, count: number, replaced: number }} event
 * @returns {void}
 */
export function notifyAdded(context, { handle, chatId, count, replaced }) {
    const noun = count === 1 ? 'memory' : 'memories';
    const summary = replaced > 0
        ? `Remembered ${count} new ${noun} (${replaced} replacing something older)`
        : `Remembered ${count} new ${noun}`;

    notifyHost(context, {
        handle,
        action: 'memory.added',
        // Shape only — see the header. `count` and `replaced` are integers that measure the event; the
        // statements themselves stay behind the panel route and its locked-vault gate.
        data: { count, replaced },
        chatId,
        color: 'purple',
        summary,
    });
}

/**
 * Push "memories were recalled", in green. Raised before the write notification, which is what makes purple win
 * a turn that does both — see notifyAdded.
 *
 * @param {HostLike} context
 * @param {{ handle: string, chatId?: string|null, count: number }} event
 * @returns {void}
 */
export function notifyRecalled(context, { handle, chatId, count }) {
    const noun = count === 1 ? 'memory' : 'memories';

    notifyHost(context, {
        handle,
        action: 'memory.recalled',
        data: { count },
        chatId,
        color: 'green',
        summary: `Recalled ${count} long-term ${noun}`,
    });
}
