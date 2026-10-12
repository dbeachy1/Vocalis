import { lookupCharacterId } from './character-ids.js';
import { log, LogClass } from './logger.js';

/**
 * The ambient identity that rides on every request to a plugin's router.
 *
 * Capability 7 sends `chatId` on the panel and status routes (§14.4) because a readout of "what happened on
 * the last turn" is meaningless without knowing which conversation is being looked at. Interactive panels
 * need more than that: a panel offering to filter a store by *whose*
 * memories they are needs the same scoping axes the generation path already supplies — `charId` and
 * `personaId` (§22).
 *
 * `personaId` the client can send, because it IS `user_avatar` and nothing is minted from it (§22.7).
 *
 * ## 🔴 Why `charId` cannot simply be sent the same way
 *
 * **The client cannot look up a `charId`** (§22.8.2). `character-ids.json` is a server-owned map at the user
 * root; the browser holds avatar filenames and nothing else. So the split here is the one the prompt path
 * already uses, for the same reason: **the client attaches the avatar key, the server resolves it.**
 *
 * 🔴 **And the avatar key is REMOVED before the plugin sees it.** §25.8 refused to hand plugins a way to get
 * an avatar filename back, on the grounds that a filename is a renameable, guessable handle to a file on
 * disk and the whole point of `charId` is that it is neither. Letting one ride through to a plugin route in a
 * query string would reintroduce exactly that, through a door nobody was watching. `resolveIdentity` in
 * `generation-interceptors.js` strips it on the prompt path; this strips it on the HTTP path.
 *
 * ⚠️ **LOOK UP, NEVER MINT.** The prompt path calls `getOrMintCharacterId` because a generation is proof the
 * character is real and in use. Opening a panel is not: minting here would write a row into
 * `character-ids.json` for every character a user merely *looked at* a panel next to. A character with no id
 * has never generated, so it has no memories either, and `null` is the honest answer.
 */

/**
 * Query parameters the host owns. A plugin's fragment may not set them — the client strips them from
 * fragment-supplied params before building a URL, and {@link resolvePanelIdentity} discards `charId` again
 * on arrival, because the client's stripping protects only requests the host itself made.
 */
export const RESERVED_QUERY_KEYS = Object.freeze(['chatId', 'tz', 'personaId', 'charId']);

/**
 * Is this plausibly an avatar filename, rather than something that could never name a character?
 *
 * A lighter version of the check `generation-interceptors.js` applies to the same header, and lighter for a
 * stated reason: that path calls `getOrMintCharacterId`, so a junk value there **writes a row** and rewrites
 * the whole map. This path only ever reads, so the growth attack does not exist here and the check is doing
 * one smaller job — keeping a value that could not be a filename from being used as a map key at all.
 *
 * @param {unknown} avatar
 * @returns {boolean}
 */
function isPlausibleAvatar(avatar) {
    return typeof avatar === 'string'
        && avatar !== ''
        && avatar.length <= 255
        && avatar !== '.'
        && avatar !== '..'
        && !/[/\\]/.test(avatar);
}

/**
 * Resolve `charAvatar` into `charId` for every request reaching a plugin's router.
 *
 * Mounted in front of each plugin's router in `plugin-loader.js`, so it covers panel fetches, status polls
 * and action requests alike — an action goes to a route the plugin named, not to `/panel`, and it needs the
 * same identity.
 *
 * 🔴 `charId` ARRIVING FROM THE CLIENT IS DISCARDED BEFORE ANYTHING ELSE. The fork is the only authority on
 * character identity. A panel fragment can put arbitrary text in an action's `data-panel-params`, and while
 * the host strips reserved keys on its side (`plugin-panels.js`), a plugin's routes are also reachable by
 * anything else the user's browser runs. Trusting a `charId` from the query would let a forged one steer a
 * memory store's scoping — writing one character's durable facts into another's partition, which is the
 * failure §22 exists to prevent. Deleted unconditionally, then set only from a resolved lookup.
 *
 * ⚠️ Degrades rather than fails, exactly as `resolveIdentity` does. An unreadable map (a locked vault, most
 * often) means the request carries no `charId`, and a plugin treats that as "no character" — the same state
 * as a group chat. A panel that renders slightly less is a better outcome than a 500 on a button click.
 *
 * @param {import('express').Request} request
 * @param {import('express').Response} _response
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 */
export async function resolvePanelIdentity(request, _response, next) {
    // Express 4 gives a plain mutable object here. Before any early return below, so a request that resolves
    // nothing still arrives clean rather than carrying whatever the caller claimed.
    if (request.query) {
        delete request.query.charId;
    }

    // 🔴 A HEADER, NOT A QUERY PARAMETER, and the same header the generation path already uses
    // (`generation-interceptors.js`). One name for one thing — and it keeps the avatar key entirely out of
    // the query string, where a plugin's own `data-panel-params` live and where stripping it would be one
    // more rule to remember. Percent-encoded by the client because a header value is latin-1.
    const raw = request.get?.('X-ST-Char-Avatar');
    let avatar = raw;

    try {
        avatar = raw === undefined ? undefined : decodeURIComponent(raw);
    } catch {
        // A malformed percent-sequence is not worth failing a panel over — take it raw and let the lookup miss.
    }

    if (!isPlausibleAvatar(avatar)) {
        next();
        return;
    }

    // Absent behind `setUserDataMiddleware` in practice; guarded because a plugin router can be mounted in a
    // test harness without one, and inventing a root would be worse than resolving nothing.
    const root = request.user?.directories?.root;

    if (!root) {
        next();
        return;
    }

    try {
        const charId = await lookupCharacterId(root, avatar);

        if (charId) {
            request.query.charId = charId;
        }
    } catch (error) {
        // Named, because the symptom otherwise is a panel that silently shows the wrong scope's contents and
        // a user who reports that "my memories disappeared" with nothing in the log to explain it. The avatar
        // key is user-authored content and stays out of the NORMAL line.
        log.error(LogClass.NORMAL, 'A plugin request could not resolve its character id, so it carries none. A panel will treat it as no character.');
        log.error(LogClass.SENSITIVE, 'That resolution failed for avatar %s:', avatar, error);
    }

    next();
}
