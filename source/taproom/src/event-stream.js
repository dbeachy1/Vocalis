import crypto from 'node:crypto';

import { log, LogClass } from './logger.js';

/**
 * The server→client event channel: how the fork tells an OPEN TAB that its data moved underneath it.
 *
 * ⚠️ NOT `server-events.js`, WHICH IS A DIFFERENT THING WITH A CONFUSINGLY SIMILAR NAME. That module is an
 * in-process `EventEmitter` carrying server lifecycle signals (`SERVER_STARTED`) between parts of the
 * server itself, and nothing it emits ever leaves the process. This one is the outbound HTTP channel to a
 * browser. They share a noun and nothing else; keep them apart.
 *
 * ## The problem this exists for
 *
 * Every write path in this application assumed the browser that made the write is the only thing that
 * needs to know about it. That was true while the browser was the only writer. It stopped being true the
 * moment anything else could edit a World Book or a card — the Vocalis editors, a plugin, a second tab,
 * a script — and the symptom is silent: the tab shows what it loaded, the user clicks into it, and edits
 * a copy of something that changed an hour ago. Nothing errors. He just loses the newer version.
 *
 * ## 🔴 WHY SSE AND NOT A POLL
 *
 * A poll is a timer, and **a browser throttles timers in a hidden tab** — `setInterval` drops to once a
 * minute, and after ~5 minutes of being hidden, worse than that. A poll-based freshness check therefore
 * stops working in exactly the case it is needed: the tab the user is NOT looking at, which is the one
 * accumulating staleness.
 *
 * Incoming stream events are not timers. They are I/O, delivered on arrival, and a hidden tab dispatches
 * them normally. That asymmetry is the entire reason this module exists rather than a `/api/changes?since=`
 * endpoint, which would have been less code and would not have worked.
 *
 * ## ⚠️ THE THREE THINGS THAT SILENTLY BREAK AN SSE STREAM
 *
 * All three are configured at the connection in `endpoints/events.js`, and all three fail the same way —
 * the stream connects, reports healthy, and delivers nothing:
 *
 * 1. **`compression()`** is mounted globally in `server-main.js` and buffers a response until it has
 *    enough to be worth compressing. An event stream never produces that much at once.
 * 2. **A reverse proxy** does the same thing for the same reason.
 * 3. **An idle connection** gets closed by a proxy or a NAT table that sees no traffic for a minute.
 */

/**
 * How many events per handle are retained for `Last-Event-ID` replay.
 *
 * ⚠️ NOT A HISTORY, AND DELIBERATELY SMALL. This buffer exists to cover the seconds a reconnect takes,
 * not to let a client catch up on a session it slept through. A client whose last id has fallen off the
 * end is told to {@link RESYNC} — reload everything — which is always correct and never stale. Growing
 * this would trade a bounded, obviously-correct answer for an unbounded one that is only PROBABLY
 * complete, which is the wrong direction for a freshness mechanism.
 */
const REPLAY_BUFFER_SIZE = 100;

/**
 * Milliseconds between keepalive comments.
 *
 * ⚠️ SHORTER THAN THE SHORTEST IDLE TIMEOUT WE MIGHT SIT BEHIND. nginx's default `proxy_read_timeout` is
 * 60 s and many NAT tables are shorter still; 20 s clears both with room for a missed one. This is a
 * SERVER-side timer on purpose — putting it in the client would reintroduce exactly the throttling
 * problem this module was built to avoid.
 */
const KEEPALIVE_MS = 20_000;

/**
 * What the client is told to wait before reconnecting, in milliseconds.
 *
 * Sent once per connection as the SSE `retry:` field. The browser's automatic reconnect honours it, so
 * this is the only knob controlling how hard a client hammers us while the server is restarting.
 */
const RETRY_MS = 3_000;

/**
 * Sent when a reconnecting client's `Last-Event-ID` is older than {@link REPLAY_BUFFER_SIZE} allows.
 *
 * 🔴 THE CLIENT MUST TREAT THIS AS "YOU KNOW NOTHING", NOT AS AN ERROR. A partial replay would be worse
 * than no replay: the client would apply some updates, believe it was current, and be silently wrong
 * about everything that fell off the buffer.
 */
export const RESYNC = 'resync';

/**
 * The header a writer uses to name itself, so it can recognise and ignore its own echo.
 *
 * 🔴 THE ECHO PROBLEM IS NOT COSMETIC. Without it, a tab saves a World Book, receives its own
 * `worldinfo.updated`, and reloads the editor the user is still typing in — destroying unsaved work in
 * response to the act of saving. Any client that both writes and listens MUST send this.
 *
 * ⚠️ ADVISORY, NEVER AUTHENTICATION. It is a caller-supplied string echoed back verbatim in `source`; a
 * client can send anyone's. It exists to answer "was this me?" for a cooperating client, and it must never
 * be used to answer "who is allowed to do this?" — {@link emit} is already scoped by handle, which is the
 * control that actually keeps one user's events off another's wire.
 */
export const CLIENT_ID_HEADER = 'X-ST-Client-Id';

/**
 * One connected client.
 * @typedef {object} EventStream
 * @property {string} handle The user this stream belongs to
 * @property {string} clientId This connection's identity, sent to it in `hello`
 * @property {import('express').Response} response The open response to write into
 */

/** @type {Set<EventStream>} Every currently-open stream, across all users. */
const streams = new Set();

/**
 * Per-handle monotonic event counter and replay buffer.
 * @type {Map<string, { nextId: number, buffer: Array<{ id: number, payload: string }> }>}
 */
const histories = new Map();

/** @type {NodeJS.Timeout | null} The single shared keepalive timer. */
let keepaliveTimer = null;

/**
 * Get (or create) the replay history for a handle.
 * @param {string} handle
 */
function getHistory(handle) {
    let history = histories.get(handle);

    if (!history) {
        // Ids start at 1 so that a falsy id is never a valid one — `Number(lastEventId)` on a junk header
        // yields 0 or NaN, and both must read as "no usable position" rather than as "the first event".
        history = { nextId: 1, buffer: [] };
        histories.set(handle, history);
    }

    return history;
}

/**
 * Serialise one event into the SSE wire format.
 *
 * 🔴 `id` IS OPTIONAL, AND OMITTING IT IS A DELIBERATE ACT WITH A SPECIFIC MEANING. An SSE client updates
 * its stored `Last-Event-ID` from every event that carries one, and sends that value on the next reconnect.
 * So an event with an id MOVES THE CLIENT'S POSITION — which is wrong for anything that is not itself a
 * change the client has now seen.
 *
 * The case that bites: `hello` is written before the replay that follows it. Given an id, it would advance
 * the client to *current* while the events it missed are still queued behind it, and a disconnect during
 * replay would mean those events are never delivered and never asked for again. Silent, permanent data
 * staleness caused by the reconnect that was supposed to fix it. `hello` therefore carries no id.
 * @param {number|null} id Monotonic per-handle event id, or null to leave the client's position alone
 * @param {string} event Event name
 * @param {object} data JSON-serialisable payload
 * @returns {string}
 */
function formatEvent(id, event, data) {
    const idLine = id === null ? '' : `id: ${id}\n`;

    // The blank line terminates the event; without it the client buffers indefinitely and the stream looks
    // connected-but-silent, which is the same symptom as all three failure modes in the header comment.
    return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Start the shared keepalive timer, if it is not already running.
 *
 * ⚠️ ONE TIMER FOR ALL STREAMS, NOT ONE PER STREAM. Per-connection timers are the obvious shape and they
 * leak: a timer whose `close` handler did not fire keeps a reference to a dead response alive for ever.
 * A single timer that walks the live set has nothing to leak, and `unref()` keeps it from holding the
 * process open during a shutdown.
 */
function startKeepalive() {
    if (keepaliveTimer) {
        return;
    }

    keepaliveTimer = setInterval(() => {
        for (const stream of streams) {
            // A comment line. It costs two bytes on the wire, is ignored by every SSE client, and is the
            // only thing distinguishing "idle" from "dead" to everything in between us and the browser.
            writeOrDrop(stream, ': keepalive\n\n');
        }
    }, KEEPALIVE_MS);

    keepaliveTimer.unref?.();
}

/**
 * Stop the shared keepalive timer when the last stream goes away.
 */
function stopKeepaliveIfIdle() {
    if (streams.size === 0 && keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
    }
}

/**
 * Write to a stream, dropping it if the write fails.
 *
 * ⚠️ A DEAD SOCKET DOES NOT ALWAYS FIRE `close` BEFORE THE NEXT WRITE. A client that vanished — laptop
 * lid, dropped wifi, killed browser — can leave a response whose `write` throws while the `close` event
 * is still queued. Catching here means one dead client cannot take down the emit loop for every other
 * connected tab, which is what an uncaught throw inside {@link emit} would do.
 * @param {EventStream} stream
 * @param {string} payload
 */
function writeOrDrop(stream, payload) {
    try {
        stream.response.write(payload);
    } catch {
        removeStream(stream);
    }
}

/**
 * Register an open response as an event stream and replay anything it missed.
 * @param {string} handle The authenticated user's handle
 * @param {import('express').Response} response An open response, already configured for SSE
 * @param {string|undefined} lastEventId The client's `Last-Event-ID` header, if it is reconnecting
 * @returns {EventStream} The registered stream, for the caller to release on close
 */
export function addStream(handle, response, lastEventId) {
    /** @type {EventStream} */
    const stream = { handle, clientId: crypto.randomUUID(), response };

    streams.add(stream);
    startKeepalive();

    // Tell the client how long to wait before reconnecting, before anything else can fail.
    response.write(`retry: ${RETRY_MS}\n\n`);

    const history = getHistory(handle);
    const since = Number(lastEventId);

    // ⚠️ `hello` GOES OUT ON EVERY CONNECTION, INCLUDING A RECONNECT, because the client id is
    // per-connection and a reconnecting client would otherwise keep filtering its echo against an identity
    // the server has forgotten — which reads as "none of these events are mine" and brings the render loop
    // back on the first save after a network blip.
    writeOrDrop(stream, formatEvent(null, 'hello', {
        apiVersion: 1,
        clientId: stream.clientId,
    }));

    if (since > 0) {
        replay(stream, history, since);
    }

    return stream;
}

/**
 * Send a reconnecting client everything it missed, or tell it to start over.
 * @param {EventStream} stream
 * @param {{ nextId: number, buffer: Array<{ id: number, payload: string }> }} history
 * @param {number} since The last id the client actually received
 */
function replay(stream, history, since) {
    // 🔴 A POSITION AHEAD OF OURS IS FROM A PREVIOUS SERVER, NOT FROM THE FUTURE. The gap test below guards
    // the bottom of the range and nothing guarded the top, so an id minted by an earlier process was read as
    // "you are current". That is not exotic — it happens on EVERY restart, i.e. every deploy: EventSource
    // keeps `lastEventId` across its own automatic reconnects, so a tab holding id 57 meets a new process
    // whose counter restarts at 1. If anything is written in the seconds before the tab reconnects, the
    // buffer holds ids 1-2, `since + 1 < oldestHeld` is false, `missed` is empty, and the tab is told
    // nothing changed at the exact moment two World Books did. Same failure the comment below describes,
    // entered through the other end.
    if (since >= history.nextId) {
        writeOrDrop(stream, formatEvent(history.nextId - 1, RESYNC, { reason: 'epoch' }));
        return;
    }

    const missed = history.buffer.filter(entry => entry.id > since);
    const oldestHeld = history.buffer.length ? history.buffer[0].id : history.nextId;

    // 🔴 THE GAP TEST IS AGAINST THE OLDEST EVENT WE STILL HOLD, NOT AGAINST WHETHER WE FOUND ANY.
    //
    // An empty `missed` is ambiguous on its own: it means either "you are current" or "everything you
    // missed has already been evicted". Reading it as the first is the bug that makes this whole channel
    // untrustworthy — the client would be told it was up to date at the exact moment it was furthest
    // behind. Comparing against `oldestHeld` distinguishes them: the client is current only if its
    // position is at or after the oldest thing we could still have told it about.
    if (since + 1 < oldestHeld) {
        // ⚠️ THIS ONE *DOES* CARRY AN ID, UNLIKE `hello`, AND FOR THE OPPOSITE REASON. A client that has been
        // told to reload everything is current once it has, so its position must advance to now. Leaving it
        // behind would mean the same client is told to resync on every subsequent reconnect for the rest of
        // the session — a full reload on every network blip, for ever.
        writeOrDrop(stream, formatEvent(history.nextId - 1, RESYNC, { reason: 'gap' }));
        return;
    }

    for (const entry of missed) {
        writeOrDrop(stream, entry.payload);
    }
}

/**
 * Unregister a stream.
 * @param {EventStream} stream
 */
export function removeStream(stream) {
    streams.delete(stream);
    stopKeepaliveIfIdle();
}

/**
 * Publish an event to every open stream belonging to a handle.
 *
 * 🔴 SCOPED BY HANDLE, AND THAT IS THE ONLY THING KEEPING ONE USER'S ACTIVITY OFF ANOTHER'S WIRE. The
 * payloads here name World Books and character avatars — a filename is not nothing, and on a multi-user
 * install broadcasting them would tell every logged-in user what everyone else is editing, in real time.
 * Never widen this to "all streams" for convenience.
 *
 * ⚠️ SAFE TO CALL WITH NOBODY LISTENING. The common case is that no tab is open; the event is recorded
 * for replay and nothing is written. Callers must not guard on whether anyone is connected, because a
 * caller that checks first will eventually check wrongly.
 * @param {string} handle The user whose data changed
 * @param {string} event Event name, e.g. `worldinfo.updated`
 * @param {object} data JSON-serialisable payload. Include `source` so a writer can ignore its own echo.
 */
export function emit(handle, event, data) {
    if (!handle) {
        // Nothing to scope the event to. A write with no user attached is either a test harness or a bug
        // elsewhere; either way, silently broadcasting it would be the wrong repair.
        log.warn(LogClass.NORMAL, 'A server event was raised with no user to deliver it to, and was dropped.');
        return;
    }

    const history = getHistory(handle);
    const id = history.nextId++;
    const payload = formatEvent(id, event, data);

    history.buffer.push({ id, payload });

    if (history.buffer.length > REPLAY_BUFFER_SIZE) {
        history.buffer.shift();
    }

    for (const stream of streams) {
        if (stream.handle === handle) {
            writeOrDrop(stream, payload);
        }
    }
}

/**
 * Emit an event for the user who made a request, if there is one.
 *
 * The convenience wrapper every endpoint actually wants: it reads the handle off `request.user` and does
 * nothing at all when there is not one, so a route can announce a change on one line without first
 * establishing whether it is running under a session, a test, or something new.
 * @param {import('express').Request} request
 * @param {string} event Event name
 * @param {object} data JSON-serialisable payload
 */
export function emitForRequest(request, event, data) {
    const handle = request?.user?.profile?.handle;

    if (!handle) {
        return;
    }

    emit(handle, event, { ...data, source: request.get?.(CLIENT_ID_HEADER) ?? null });
}

/**
 * How many streams are currently open. Exposed for tests and diagnostics.
 * @returns {number}
 */
export function getStreamCount() {
    return streams.size;
}

/**
 * 🔑 Drop everything this channel is holding for a handle.
 *
 * 🔴 THE REPLAY BUFFER IS DECRYPTED CONTENT, NOT BOOKKEEPING. Up to a hundred payloads per handle, each
 * naming a World Book or a character avatar — and nothing cleared them on lock, logout or account deletion,
 * while the sibling map on the very same code path (`notifications.clearFor`) is cleared for exactly the
 * reason `storage.lock()` writes down: the provider has this instant made those strings unreadable on disk,
 * and a plaintext copy in a live map puts them back within reach of the next request. For a PURGED account
 * they outlived every file the user had.
 *
 * The open streams go too. Leaving them registered meant the keepalive kept writing to connections
 * belonging to a vault that is shut — or to an account that no longer exists.
 * @param {string} handle User handle
 * @returns {void}
 */
export function clearFor(handle) {
    histories.delete(handle);

    for (const stream of streams) {
        if (stream.handle === handle) {
            streams.delete(stream);

            // End it rather than just forgetting it: the socket is still open, and a client that is
            // reconnected rather than abandoned goes back through auth, which is what should decide
            // whether it may listen again.
            try {
                stream.response.end();
            } catch {
                // Already torn down at the other end. Nothing to do, and nothing worth logging.
            }
        }
    }

    stopKeepaliveIfIdle();
}

/**
 * Drop all state. Tests only — a module-level registry otherwise leaks between cases.
 */
export function resetForTests() {
    streams.clear();
    histories.clear();

    if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
    }
}
