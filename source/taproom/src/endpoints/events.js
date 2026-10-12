import express from 'express';

import { addStream, removeStream } from '../event-stream.js';

export const router = express.Router();

/**
 * The open end of the server→client event channel. See `event-stream.js` for what it is for.
 *
 * 🔴 MOUNTED BELOW `requireLoginMiddleware`, AND IT HAS TO BE. The events name a user's World Books and
 * character avatars. Above the auth boundary this would be a live feed of what the box's users are
 * editing, readable by anyone who can reach the port.
 *
 * ⚠️ THIS ROUTE IS IN `NOT_ACTIVITY`, AND THAT IS NOT AN OPTIMISATION. The browser reconnects this stream
 * BY ITSELF — that is the whole point of `retry:`, and it fires on every network blip, every proxy idle
 * close, and every laptop resume, with nobody at the keyboard. If those reconnects reached
 * `recordUserActivity`, an open tab would postpone the idle lock indefinitely and the encrypted store
 * would never re-lock while a browser window sat forgotten on another desktop. The rule the existing
 * exclusions state — *a machine asking a question is not the user being present* — covers a machine
 * re-establishing a socket at least as strongly.
 */
router.get('/stream', (request, response) => {
    // ⚠️ ALL FOUR OF THESE ARE LOAD-BEARING, AND OMITTING ANY ONE FAILS THE SAME INVISIBLE WAY: the
    // connection opens, the client reports it healthy, and events never arrive.
    //
    // `no-transform` is the one that is easy to miss and impossible to guess from the symptom. The global
    // `compression()` middleware in server-main.js buffers a response until it has enough bytes to be
    // worth compressing, and an event stream never produces that much at once — so the stream is held in
    // a compressor's buffer for ever. `compression` honours `no-transform` and steps aside; there is no
    // per-route way to opt out of it once it is mounted globally.
    //
    // `X-Accel-Buffering` says the same thing to nginx, which does the same thing for the same reason and
    // is what sits in front of this on the box.
    response.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    // Commit the headers now. Without this the client's `onopen` does not fire until the first event,
    // which can be hours away, and a caller cannot distinguish "connected and quiet" from "still dialling".
    response.flushHeaders();

    // Node's socket timeout would close an idle connection out from under us. Keepalives make that
    // unlikely rather than impossible, and a stream is precisely the case the default was not written for.
    request.socket.setTimeout(0);
    request.socket.setNoDelay(true);
    request.socket.setKeepAlive(true);

    const handle = request.user.profile.handle;
    const stream = addStream(handle, response, request.get('Last-Event-ID'));

    // 🔴 BOTH EVENTS, NOT JUST `close`. A response that errors — a client that vanished mid-write, a proxy
    // that reset — may never emit `close`, and a stream left in the registry is written to for ever: a
    // slow leak that presents months later as a server holding thousands of dead sockets.
    request.on('close', () => removeStream(stream));
    response.on('error', () => removeStream(stream));
});
