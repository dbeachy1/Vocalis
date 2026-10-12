/**
 * The client end of the server→client event channel. See `src/event-stream.js` for what it is for.
 *
 * ## What this does, and the one thing it deliberately does NOT do
 *
 * It keeps the LISTS fresh — the World Book dropdown, the character list — when something outside this tab
 * changes them. That is the staleness that actually costs the user something: a name that is not there any
 * more, or a book that was created in another window and cannot be selected here until a reload.
 *
 * 🔴 IT NEVER RELOADS AN OPEN EDITOR. A World Book editor with unsaved changes in it is the user's work,
 * and an incoming event is not permission to discard it. Refreshing an editor on a remote write would mean
 * that the more actively the user is editing, the more likely they are to lose it — and the loss would be
 * silent, triggered by someone else's action, and impossible to attribute. A stale editor is a much smaller
 * problem than a destroyed one, and the change token on the write path already catches the collision at the
 * point where it can still be resolved.
 */

/**
 * This connection's identity, assigned by the server in `hello`.
 *
 * 🔴 THE ECHO FILTER DEPENDS ON THIS, AND ON IT BEING SENT WITH EVERY WRITE. `getRequestHeaders` attaches it
 * as `X-ST-Client-Id`; the server echoes it back as `source`; this module drops any event whose `source`
 * matches. Without that loop a save in this tab triggers a refresh in this tab, on every save.
 *
 * ⚠️ NULL UNTIL `hello` ARRIVES, AND NULL AGAIN IF THE STREAM IS DOWN. A write made before the stream
 * connects carries no client id, so its echo cannot be recognised and this tab refreshes its lists once.
 * That is the correct failure: a redundant list refresh is invisible, and the alternative — assuming an
 * unattributed event is ours — would silently swallow real changes.
 * @type {string|null}
 */
let clientId = null;

/** @type {EventSource|null} */
let source = null;

/** Backoff floor for re-arming a stream the browser has given up on. See the `error` handler. */
const BASE_RECONNECT_DELAY_MS = 2000;

/** Backoff ceiling, so a long outage settles at one attempt every half minute rather than growing forever. */
const MAX_RECONNECT_DELAY_MS = 30000;

/** @type {number} Current backoff, reset by a successful `open`. */
let reconnectDelay = BASE_RECONNECT_DELAY_MS;

/**
 * The client id to attach to outgoing requests, if the stream has told us one yet.
 * @returns {string|null}
 */
export function getEventClientId() {
    return clientId;
}

/**
 * Coalesce bursts of refreshes.
 *
 * ⚠️ A SINGLE LOGICAL ACTION ELSEWHERE IS OFTEN SEVERAL EVENTS HERE. A rename emits `character.updated` and
 * `character.deleted`; a Vocalis push of several books emits one per book. Refreshing per event would run
 * the same full list reload three or four times in a few milliseconds, and on a large card collection that
 * is visible as a stutter.
 * @type {Map<string, number>}
 */
const pendingRefreshes = new Map();

/**
 * Run a refresh at most once per burst.
 * @param {string} key Identifies the refresh, so two kinds do not cancel each other
 * @param {() => Promise<void>|void} fn
 */
function debounceRefresh(key, fn) {
    clearTimeout(pendingRefreshes.get(key));

    pendingRefreshes.set(key, setTimeout(async () => {
        pendingRefreshes.delete(key);

        try {
            await fn();
        } catch (error) {
            // A failed refresh leaves the list stale, which is where it already was. Never surface this to
            // the user: the event is background housekeeping they did not ask for and cannot act on.
            console.debug('[Events] A background refresh failed; the list stays as it was.', error);
        }
    }, 250));
}

/**
 * Refresh the character list.
 *
 * ⚠️ IMPORTED LAZILY, AND THAT IS NOT STYLE. This module is imported BY `script.js` (for the client id), so
 * a static import of `getCharacters` back out of it is a cycle that resolves to `undefined` at module-eval
 * time — the symptom being a `TypeError` on the first event rather than at load, hours into a session.
 */
async function refreshCharacters() {
    const script = await import('../script.js');

    // 🔴 `getCharacters()` CAN RELOAD THE PAGE, AND A BACKGROUND EVENT MUST NEVER REACH THAT BRANCH.
    //
    // It captures the open character's avatar, refetches, and if that avatar is no longer in the list it
    // shows a popup and calls `location.reload()`. From a user action that is reasonable. Delivered by this
    // channel it is a catastrophe with no attribution: rename a character in Vocalis or a second tab and
    // THIS tab reloads unprompted, taking a half-typed message and any unsaved editor state with it — the
    // rename path emits `character.deleted` for the old avatar precisely so the lists can update, and that
    // is the event that would arm it. Even when the avatar IS still there, `getCharacters` goes on to call
    // `selectCharacterById(..., { switchMenu: false })`, repainting the character editor from disk over
    // whatever the user had typed into it.
    //
    // So with a character open, refresh the LIST and nothing else. That is the module's stated invariant —
    // "it never reloads an open editor" — which was honoured for World Books and broken here. With nothing
    // open there is no editor to protect and no avatar to lose, so the upstream path is used unchanged; it
    // also refreshes groups, which is worth having whenever it is safe.
    if (script.this_chid === undefined) {
        await script.getCharacters();
        return;
    }

    const response = await fetch('/api/characters/all', {
        method: 'POST',
        headers: script.getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        return;
    }

    const fresh = await response.json();
    const openAvatar = script.characters[script.this_chid]?.avatar;

    // ⚠️ IF THE OPEN CHARACTER IS GONE, LEAVE EVERYTHING ALONE. Rewriting the array under a `this_chid` that
    // no longer addresses the same card is how the open editor starts describing a different character. A
    // stale list is the smaller problem, and the user finds out at their next deliberate action.
    if (openAvatar && !fresh.some(character => character.avatar === openAvatar)) {
        console.debug('[Events] The open character is no longer in the list; leaving this tab as it is.');
        return;
    }

    script.characters.splice(0, script.characters.length, ...fresh);

    // ⚠️ THROUGH THE SETTER, NOT BY ASSIGNMENT. `this_chid` is an imported binding and imported bindings are
    // read-only — `script.this_chid = …` is a TypeError in a module, and it would fire here on a background
    // event rather than anywhere a test would look. The index can move even though the avatar did not: the
    // list is rebuilt from the server's ordering, so a card added or removed above this one shifts it.
    script.setCharacterId(script.characters.findIndex(character => character.avatar === openAvatar));

    await script.printCharacters(true);
}

/**
 * Refresh the World Book list. Lazily imported for the same reason as {@link refreshCharacters}.
 */
async function refreshWorldInfo() {
    const { updateWorldInfoList } = await import('./world-info.js');
    await updateWorldInfoList();
}

/**
 * 🔴 A REMOTE WRITE MUST INVALIDATE THE CACHED BOOK, NOT JUST THE LIST.
 *
 * `refreshWorldInfo` rebuilds the dropdown, which is what a tab needs to LEARN a book exists. It does
 * nothing about `worldInfoCache`, and that cache is what `loadWorldInfo` answers from — so after
 * someone else wrote a book, this tab went on serving the copy it happened to hold, indefinitely.
 * That is not only an editor problem: `getSortedEntries` reads the same cache, so the PROMPT was
 * built from lore that is not on disk.
 *
 * ⚠️ INVALIDATE, NEVER RELOAD. `src/event-stream.js` is explicit that reloading the editor on a
 * `worldinfo.updated` destroys unsaved work in the tab that is typing. `payloadOf` already drops this
 * tab's own echo, but a genuine remote write can still land while the user is mid-edit here, and
 * throwing their draft away to show someone else's version is the worse failure. Dropping the cache
 * costs them nothing and makes the next deliberate read — Refresh, selecting the book, the next
 * prompt build — go to the server.
 *
 * @param {string} [name] The book that changed; every book when the server could not say which.
 * @returns {Promise<void>}
 */
async function forgetWorldInfo(name) {
    try {
        const { worldInfoCache } = await import('./world-info.js');
        if (name) {
            worldInfoCache.delete(name);
        } else {
            worldInfoCache.clear();
        }
    } catch (error) {
        // Same posture as debounceRefresh: this is background housekeeping the user did not ask for.
        console.debug('[Events] Could not drop the cached World Book.', error);
    }
}

/**
 * Should this event be acted on, or is it the echo of something this tab just did?
 * @param {MessageEvent} event
 * @returns {object|null} The parsed payload, or null if it should be ignored
 */
function payloadOf(event) {
    let data;

    try {
        data = JSON.parse(event.data);
    } catch {
        // A payload we cannot parse is a version skew, not a crash. Ignoring it degrades to today's
        // behaviour — a tab that finds out on the next reload.
        console.debug('[Events] Ignoring an event whose payload did not parse.');
        return null;
    }

    if (clientId && data?.source === clientId) {
        return null;
    }

    return data;
}

/**
 * Open the event stream and keep the lists fresh for as long as the page lives.
 *
 * ⚠️ NO RECONNECT LOGIC HERE, ON PURPOSE. `EventSource` reconnects by itself — automatic retry is in the
 * spec, and the server sends a `retry:` interval to tune it. Hand-rolled reconnection on top of that is how
 * you end up with two streams open and every event handled twice.
 */
export function initServerEvents() {
    if (source) {
        return;
    }

    source = new EventSource('/api/events/stream');

    source.addEventListener('hello', (event) => {
        try {
            clientId = JSON.parse(event.data)?.clientId ?? null;
        } catch {
            clientId = null;
        }
    });

    source.addEventListener('worldinfo.updated', (event) => {
        const payload = payloadOf(event);
        if (!payload) return;
        // Not debounced, and deliberately so: dropping a cache entry is cheap and idempotent, and two
        // books changing in the same 250ms window must not collapse into one forgotten name.
        void forgetWorldInfo(payload.name);
        debounceRefresh('worldinfo', refreshWorldInfo);
    });

    source.addEventListener('worldinfo.deleted', (event) => {
        const payload = payloadOf(event);
        if (!payload) return;
        void forgetWorldInfo(payload.name);
        debounceRefresh('worldinfo', refreshWorldInfo);
    });

    source.addEventListener('character.updated', (event) => {
        if (payloadOf(event)) debounceRefresh('characters', refreshCharacters);
    });

    source.addEventListener('character.deleted', (event) => {
        if (payloadOf(event)) debounceRefresh('characters', refreshCharacters);
    });

    // 🔴 A GAP IS NOT "NOTHING HAPPENED". The server sends this when it can no longer say exactly what was
    // missed, which is precisely when assuming the lists are current is most wrong. Refresh everything.
    source.addEventListener('resync', () => {
        // "You know nothing" reaches the cache too: with no name to go on, every book we hold may be
        // the stale one.
        void forgetWorldInfo();
        debounceRefresh('worldinfo', refreshWorldInfo);
        debounceRefresh('characters', refreshCharacters);
    });

    source.addEventListener('error', () => {
        // Fires on every disconnect, including the ordinary ones the browser is about to recover from by
        // itself. Not a user-facing condition — saying anything here would mean a toast on every laptop
        // resume. The client id is dropped because the next connection gets a new one.
        clientId = null;

        // 🔴 CLOSED IS NOT "RECONNECTING", AND THE HEADER'S "EventSource RECONNECTS BY ITSELF" DOES NOT
        // COVER IT. Automatic retry applies to a connection that opened; if the very first GET answers
        // anything that is not 200 text/event-stream — a 401 after an idle relock, a 502 mid-deploy — the
        // spec requires the UA to FAIL the connection, and EventSource goes to CLOSED for good. `source`
        // stayed assigned, so `initServerEvents` early-returned for the life of the page and the tab
        // silently lost list freshness until the user reloaded, never knowing it had.
        //
        // ⚠️ Re-armed on a BACKOFF, never immediately. The common cause is a server that is not ready, and
        // a tight retry loop against a restarting box is a denial of service written by us.
        if (source?.readyState === EventSource.CLOSED) {
            source.close();
            source = null;
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
            setTimeout(initServerEvents, reconnectDelay);
        }
    });

    // A stream that delivered anything at all is healthy, so the next hard failure starts from the floor
    // rather than from however long the last outage had backed off to.
    source.addEventListener('open', () => {
        reconnectDelay = BASE_RECONNECT_DELAY_MS;
    });
}
