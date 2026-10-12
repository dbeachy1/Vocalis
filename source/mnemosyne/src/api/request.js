import { storeFor } from '../session.js';

/**
 * What every memory route has to settle before it can do anything: who is asking, whether their vault is
 * open, and how to read the few query parameters the surface accepts.
 *
 * 🔴 THE HANDLE IS ALWAYS THE AUTHENTICATED CALLER AND NEVER THE REQUEST BODY. That rule is the reason this
 * module exists as one place rather than a habit each route keeps on its own — see {@link storeForRequest}.
 *
 * Nothing here renders, and nothing here touches a memory. The parsing helpers live beside the auth gate
 * because they share one property: they turn an untrusted request into values the rest of the code may assume
 * are sane, and every one of them fails closed.
 */

/**
 * The authenticated caller's open store, or null after this function has already sent the right refusal.
 *
 * Every memory route begins here, because every one needs the same two things settled first: who is asking,
 * and is their vault open. 🔴 The handle is the AUTHENTICATED caller — `req.user.profile.handle` — and NEVER
 * the request body. The routes sit behind the fork's setUserDataMiddleware and requireLoginMiddleware, so that
 * field is the logged-in user, the very one the fork itself reads to route a generation (chat-completions.js).
 * A handle taken from the body would let any logged-in user reach into another user's memory; no caller has
 * business naming a user but its own, so we never offer the option. That the store is per-caller is also what
 * makes memory ids safe to accept from the URL: an id only ever addresses the caller's own store.
 *
 * 401 nobody is logged in; 409 the vault is locked or no Vault is installed, so there is nowhere to read or
 * write yet — not our error, the same reason retrieve() simply declines.
 *
 * 🔴 **A NON-NULL RETURN IS ALSO A PROOF ABOUT `req.user`**, and the routes rely on it: past this gate,
 * `req.user.profile.handle` is a non-empty string, because the only path that reaches the store is the one
 * that read a truthy handle out of it. `types/express.d.ts` declares all three levels optional on purpose —
 * that optionality is what forces the check above to stay written — so TypeScript cannot carry the proof
 * across the call boundary, and each route records it with a one-word cast instead (see `VouchedCaller` in
 * `api/memories.js`). The cast is the proof written down; this function is where it is actually made.
 *
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response — a 401 or 409 is sent through it when this returns null
 * @returns {import('../store.js').MemoryStore|null}
 */
export function storeForRequest(req, res) {
    const handle = req.user?.profile?.handle;

    if (!handle) {
        // Behind requireLoginMiddleware this should be unreachable. If it is reached anyway, refuse rather than
        // guess a user — the wrong store is worse than none.
        res.status(401).json({ error: 'not authenticated' });
        return null;
    }

    const store = storeFor(handle);

    if (!store) {
        res.status(409).json({ error: 'memory is locked — unlock the vault, or install SillyTavern-Vault' });
        return null;
    }

    return store;
}

/**
 * Parse a query-string integer, falling back to a default and clamping to a range. A bad one must never reach
 * a LIMIT as NaN.
 *
 * ⚠️ **`value` IS UNCONSTRAINED, AND THE `string` CAST BELOW DESCRIBES `parseInt` RATHER THAN THE ARGUMENT.**
 * Express hands back a string, an array of strings, or a nested object depending on what the client sent
 * (`types/express.d.ts` says why it is declared that way), and `parseInt`'s first specified step is
 * `ToString(argument)` — `lib.es5.d.ts` narrows its parameter to `string` because that is the only case worth
 * writing down, not because the rest are illegal. Everything that is not a leading run of digits arrives as
 * NaN and takes `fallback`: `?limit=%7B%7D` stringifies to `[object Object]`, and `?limit[]=1&limit[]=2`
 * stringifies to `1,2` and clamps to 1. Neither reaches SQL as anything but a number in range.
 *
 * @param {unknown} value Whatever the query string or the JSON body carried under that name
 * @param {number} fallback The value to use when nothing numeric arrived
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, fallback, min, max) {
    const n = Number.parseInt(/** @type {string} */ (value), 10);
    return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

/** The chat the client is looking at, which the fork appends to both panel routes.
 * @param {import('express').Request} req Express request
 * @returns {string|null} */
export function chatIdOf(req) {
    return typeof req.query?.chatId === 'string' && req.query.chatId ? req.query.chatId : null;
}

/**
 * The identity axes the host appends to a panel request, each present only if it actually arrived.
 *
 * 🔴 **Absent is not the same as empty, and the difference decides whether a filter may be offered at all.**
 * `''` is a real, distinct partition component meaning "no character" (schema.js `part`), so a route cannot
 * tell "this chat has no character" from "the host never told us" by looking at the value — only by looking
 * at whether the parameter was sent. `undefined` here means the second, and the toolbar answers it by not
 * drawing the button rather than by drawing one that filters on a guess.
 *
 * ⚠️ Reconstructing identity from session state instead was considered and is wrong: the recall record is
 * per-handle and one deep, so after a chat switch it names whoever the user was talking to *before*, and the
 * panel would filter by that silently. The host is the only thing that knows what is on screen now.
 *
 * @param {import('express').Request} req Express request
 * @returns {{ chatId: string|null, charId: string|undefined, personaId: string|undefined }}
 */
export function identityOf(req) {
    // ⚠️ The `typeof` IS the proof, and the cast only carries it one line further. TypeScript narrows an
    // element access through a literal key and not through a variable one, so `req.query[name]` is `unknown`
    // again on the very next expression — the check has been made, it just cannot be seen from there.
    const sent = (/** @type {string} */ name) =>
        (typeof req.query?.[name] === 'string' ? /** @type {string} */ (req.query[name]) : undefined);

    return { chatId: chatIdOf(req), charId: sent('charId'), personaId: sent('personaId') };
}

/**
 * A non-empty string from the query or the body, whichever carried it, or null.
 *
 * ⚠️ **Both, deliberately, and it is not laziness.** The fork's interactive-panel protocol says an action's
 * collected inputs ride in the query for `GET`/`DELETE` and in a form-encoded body for `POST`/`PUT` (panel
 * design §6.3) — but `getRequestHeaders()` hardcodes `Content-Type: application/json` for every request it
 * builds, and a form-encoded body arriving under that header is rejected by `bodyParser.json` with a 400
 * before any plugin handler runs. That contradiction is the fork's to resolve and has been reported; reading
 * from either place means whichever way they settle it, the value lands and the user's edit is saved.
 *
 * @param {import('express').Request} req Express request
 * @param {string} name Parameter name
 * @returns {string|null}
 */
export function stringParam(req, name) {
    for (const source of [req.body, req.query]) {
        const value = source?.[name];

        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return null;
}

/**
 * Whether this request wants an HTML fragment rather than the route's ordinary JSON.
 *
 * 🔴 **JSON is the default and an absent `Accept` must never mean HTML.** These routes are Mnemosyne's
 * management API (FR7) *and* the targets of the panel's actions, which is two callers wanting two media
 * types from one URL. `req.accepts(['json', 'html'])` with no `Accept` header returns the FIRST listed type,
 * so ordering json first is what makes "said nothing" mean "the API contract, unchanged" — the opposite
 * ordering would quietly start answering every scripted caller with markup.
 *
 * `?as=html` is the belt to that braces, and it is the one this build actually relies on: the panel puts it
 * in the `data-panel-params` of every action it renders, so the fragment branch is selected by markup this
 * module's own panel wrote, with no dependency on a header the host does not currently send. If the fork
 * adds `Accept: text/html` to action requests, this keeps working and the parameter becomes redundant.
 *
 * @param {import('express').Request} req Express request
 * @returns {boolean}
 */
export function wantsFragment(req) {
    return stringParam(req, 'as') === 'html' || req.accepts?.(['json', 'html']) === 'html';
}
