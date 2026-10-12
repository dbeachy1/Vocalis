// ✅ CHECKED SINCE 8.8-m8.
//
// 🔴 THE FIRST THING m8 TRIED HERE WAS WRONG, AND IT IS WORTH KNOWING WHY. This file exports a
// `playStream`, and so does `src/webui/vocalis_stream_player.js` — so the obvious move was to
// reuse the web UI's `VocalisStreamOpts`. The two contracts genuinely differ:
//
//   - this one takes `serverBase` + `token` and builds its URLs; the web UI's is handed
//     `registerUrl`/`streamUrl`/`statusUrl` already made;
//   - `onPlaying` here receives the <audio> element; there it takes nothing;
//   - `onError` here receives a second `info` argument, which is how §6.2 tells "set your token"
//     apart from "the vault is shut".
//
// ⚠️ THAT LAST ONE IS LOAD-BEARING. A locked vault must never render as an auth problem — the
// token may be perfectly right and merely unverifiable — and widening the web UI's callback to
// carry `info` would put a parameter on something nothing there passes, while narrowing this one
// would delete the distinction. Two contracts, so `VocalisExtStreamOpts` is declared beside
// `VocalisStreamOpts` rather than either being bent to fit.
//
// ⚠️ `wire()` takes the element as a parameter rather than closing over the nullable `audio`
// slot — narrowing does not survive into a callback. Same fix, same reason, as
// nomi/chrome_extension/content.js.
//
// ⚠️ The count of silenced files only ever goes DOWN; tests/test_webui_types.py pins it, and it
// counts a bare mention of the directive in prose as well as a real one.
'use strict';
/*
 * Streaming player for the SillyTavern extension. Register and play progressive MP3 through
 * MediaSource, then check status for interrupted generation. Resolve cross-origin URLs against
 * Vocalis and authenticate `/v1/*` with the pairing bearer. Stream/status capability URLs carry
 * credentials in their paths. Keep document transfer on `/pair/*`. Optional trailing token
 * parameters preserve existing call-site and test-stub signatures.
 */

//: How long a run REPORT may take before we stop waiting for it (`pushDone` / `sweepDone`).
//:
//: Generous on purpose — it is not a latency budget, it is a wedge stop. These two fire after the
//: real work is finished, so the only thing waiting on them is the extension's own single-run
//: lease; a report that is merely slow should still be delivered, and only one that will never
//: arrive should be abandoned.
export const REPORT_TIMEOUT_MS = 20000;

/** Build the bearer header used by the gated API families. Empty tokens are sent and rejected by the server; an unpaired client receives the normal authentication failure.
 * @param {string} [token] absent is normal - the helper coerces to '' and the server 401s,
 *    which is the honest outcome for an unpaired install.
 * @param {Record<string, string>} [extra]
 */
function authHeader(token, extra) {
  return { ...extra, 'Authorization': `Bearer ${String(token || '')}` };
}

/**
 * @param {VocalisExtStreamOpts} opts
 */
export function playStream(opts) {
  const base = String(opts.serverBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  /** @type {HTMLAudioElement|null} */
  let audio = null;
  /** @type {string|null} */
  let blobUrl = null;
  let stopped = false;

  function teardown() {
    if (audio) {
      try {
        audio.pause();
      } catch (e) {
        /* already detached */
      }
      audio.src = '';
      audio = null;
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  }

  /**
   * @param {string} msg
   * @param {Record<string, unknown>} [info] carries the locked/unauthorized distinction
   */
  function fail(msg, info) {
    if (stopped) return;
    stopped = true;
    ctrl.abort();
    teardown();
    // `info` is optional and additive: { status, locked, auth }. `auth: true` means a 401 that
    // is NOT the lock gate — i.e. the pairing token is missing or wrong — which is what lets the
    // caller show §6.2's "set your token" guidance instead of a raw error line. A locked vault
    // must never read as an auth problem: the token may be perfectly right and unverifiable.
    if (opts.onError) opts.onError(msg, info || {});
  }

  (async () => {
    let reg;
    try {
      const resp = await fetch(`${base}/v1/audio/stream`, {
        method: 'POST',
        headers: authHeader(opts.token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(opts.body || {}),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        // Two error shapes land here. /v1/* speaks OpenAI's {"error": {"message": …}} —
        // since 7.0-m6 that includes the gate's own 401 for a missing/rejected token.
        // But 5.0's lock gate answers BEFORE the blueprint with a flat
        // {"error": "locked", "message": "Vocalis is locked. Log in to unlock."} —
        // where the half worth showing is the SIBLING `message`. Reading only
        // `error` there produced a bare "locked" toast and dropped the instruction.
        const e = err.error;
        const msg = (e && e.message) || err.message || (e && String(e)) || `register failed (${resp.status})`;
        const locked = e === 'locked' || err.error === 'locked';
        return fail(msg, { status: resp.status, locked, auth: resp.status === 401 && !locked });
      }
      reg = await resp.json();
    } catch (e) {
      const ex = /** @type {ErrLike} */ (e);
      if (ex.name !== 'AbortError') fail(ex.message ?? 'the request failed');
      return;
    }
    if (stopped) return;

    const streamUrl = new URL(reg.stream_url, base + '/').href;
    const statusUrl = new URL(reg.status_url, base + '/').href;

    let media;
    try {
      media = await fetch(streamUrl, { signal: ctrl.signal });
    } catch (e) {
      const ex = /** @type {ErrLike} */ (e);
      if (ex.name !== 'AbortError') fail(ex.message ?? 'the request failed');
      return;
    }
    if (!media.ok) return fail(`stream failed (${media.status})`);
    if (stopped) return;

    const finishByStatus = async () => {
      // Truncation check: did the stream end because it finished, or broke?
      /** @type {{ state: string, error?: string }} */
      let st = { state: 'unknown' };
      try {
        const r = await fetch(statusUrl, { signal: ctrl.signal });
        if (r.ok) st = await r.json();
      } catch (e) {
        /* can't verify — treat as complete */
      }
      teardown();
      if (st.state === 'error') {
        if (opts.onTruncated) opts.onTruncated(() => playStream(opts));
        else if (opts.onError) opts.onError('playback was truncated: ' + (st.error || 'server error'));
      } else if (opts.onEnded) {
        opts.onEnded();
      }
    };

    // Takes the element rather than closing over the nullable slot — narrowing does not
    // survive into a callback. Same reason as nomi/chrome_extension/content.js's wireAudio.
    /** @param {HTMLAudioElement} a */
    const wire = a => {
      a.addEventListener('playing', () => {
        if (!stopped && opts.onPlaying) opts.onPlaying(a);
      });
      a.addEventListener(
        'ended',
        () => {
          if (!stopped) finishByStatus();
        },
        { once: true },
      );
      a.addEventListener(
        'error',
        e => {
          // 🔴 THE GUARD IS ON `audio`, NOT ON THE EVENT TARGET, AND THE DIFFERENCE IS A TOAST
          // AFTER EVERY NARRATION. `teardown()` sets `audio.src = ''`, which makes the element
          // fire a real `error` (code 4, "Empty src attribute") asynchronously — and
          // `finishByStatus()` is the one teardown caller that does NOT set `stopped` first, so
          // on the ordinary play-to-the-end path this `{ once: true }` listener is still armed
          // when that spurious error lands. `audio` is already `null` by then, which is exactly
          // what the old guard was reading. `e.target` is the element and is ALWAYS truthy, so
          // guarding on it swallows nothing: every completed message called `fail()`, which
          // reaches `toastr.error` in index.js — a red error toast immediately after `onEnded`
          // reported success. 8.8-m10 moved the guard onto the hoisted local while the sibling
          // `src/webui/vocalis_stream_player.js` kept it on `audio`; the two files had been
          // identical here, and that divergence is the whole bug.
          const el = /** @type {HTMLMediaElement} */ (e.target);
          if (!stopped && audio) fail('audio error: ' + (el.error && el.error.message));
        },
        { once: true },
      );
    };

    const ctype = media.headers.get('Content-Type') || '';
    if (ctype.includes('audio/wav') || !window.MediaSource || !MediaSource.isTypeSupported('audio/mpeg')) {
      const blob = await media.blob().catch(() => null);
      if (!blob || stopped) return;
      blobUrl = URL.createObjectURL(blob);
      audio = new Audio(blobUrl);
      wire(audio);
      audio.play().catch(e => fail(/** @type {ErrLike} */ (e).message ?? 'playback failed'));
      return;
    }

    const ms = new MediaSource();
    blobUrl = URL.createObjectURL(ms);
    audio = new Audio(blobUrl);
    wire(audio);
    ms.addEventListener(
      'sourceopen',
      () => {
        const sb = ms.addSourceBuffer('audio/mpeg');
        // Nullable per spec (HEAD, synthesized responses); this is a live streaming GET.
        const reader = /** @type {ReadableStream<Uint8Array<ArrayBuffer>>} */ (media.body).getReader();
        (async () => {
          let got = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (stopped) {
                reader.cancel().catch(() => {});
                return;
              }
              if (done) break;
              got += value.length;
              sb.appendBuffer(value);
              await new Promise((res, rej) => {
                sb.addEventListener('updateend', res, { once: true });
                sb.addEventListener('error', () => rej(new Error('SourceBuffer error')), {
                  once: true,
                });
              });
            }
            if (!got) throw new Error('stream ended with no audio');
            if (ms.readyState === 'open') ms.endOfStream();
          } catch (err) {
            const ex = /** @type {ErrLike} */ (err);
            if (!stopped && ex.name !== 'AbortError') fail(ex.message ?? 'the stream failed');
          }
        })();
      },
      { once: true },
    );
    audio.play().catch(e => {
      if (!stopped) fail(e.message);
    });
  })();

  return {
    stop() {
      stopped = true;
      ctrl.abort(); // aborts register/stream fetch → server cancels the render
      teardown();
    },
  };
}

/** Quick reachability probe for the settings UI: GET /health (CORS-open).
 * @param {string} serverBase
 * @param {number} [timeoutMs]
 */
export async function probeHealth(serverBase, timeoutMs = 4000) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/health`, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, info: await r.json().catch(() => ({})) };
  } catch (e) {
    return { ok: false, error: /** @type {ErrLike} */ (e).message };
  } finally {
    clearTimeout(t);
  }
}

/** Check pairing status through `/pair/ping`. Document transfers remain on `/pair/*`; speech requests use `/v1/*`. A locked vault is inconclusive, not proof that pairing failed. Return a plain result for settings-panel rendering.

 * @param {string} serverBase
 * @param {string} token
 * @param {number} [timeoutMs]
 */
export async function pairPing(serverBase, token, timeoutMs = 4000) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/pair/ping`, {
      signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${String(token || '')}` },
    });
    // 🔴 A LOCKED VAULT ALSO ANSWERS 401, AND IT IS NOT "WRONG TOKEN". `_require_unlocked` is an
    // app-level before_request, so it runs BEFORE this family's bearer gate and 401s every
    // /pair/* call with `{"error":"locked"}` while the vault is shut — whatever token was sent.
    // Reading that as unpaired is the one misread this whole feature is written to avoid: it
    // could lead a user to re-copy a correct token and press Generate,
    // which ROTATES the secret and revokes a pairing that was working. Distinguish on the body.
    if (r.status === 401) {
      const body = await r.json().catch(() => ({}));
      if (body.error === 'locked') return { ok: false, locked: true };
      return { ok: true, paired: false };
    }
    if (r.status === 423) return { ok: false, locked: true }; // wbedit's shape, if it ever moves
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = await r.json().catch(() => ({}));
    return { ok: true, paired: body.paired === true };
  } catch (e) {
    // 🔴 The exception's MESSAGE, never a response body. This one is a network/abort error and
    // carries no server content — but this file's other handlers parse bodies, and the rule that
    // keeps a lorebook window out of a UI string has to be the habit, not the exception.
    return { ok: false, error: /** @type {ErrLike} */ (e).message };
  } finally {
    clearTimeout(t);
  }
}

/** Fetch the canonical server-owned SillyTavern extension settings.
 *
 * This is deliberately a pairing-channel read: the prompt is private configuration, not a
 * document to include in the polling doorbell. Callers receive the body only on a successful
 * authenticated response; failures expose status/error class and never response text.
 * @param {string} serverBase
 * @param {string} token
 * @param {number} [timeoutMs]
 */
export async function fetchExtensionSettings(serverBase, token, timeoutMs = 8000) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/pair/extension-settings`, {
      signal: ctrl.signal,
      headers: authHeader(token),
    });
    if (response.status === 401) {
      const body = await response.json().catch(() => ({}));
      if (body.error === 'locked') return { ok: false, locked: true };
      return { ok: false, paired: false };
    }
    if (response.status === 423) return { ok: false, locked: true };
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const settings = await response.json().catch(() => null);
    if (
      !settings ||
      typeof settings !== 'object' ||
      typeof settings.enabled !== 'boolean' ||
      typeof settings.immediate_send !== 'boolean' ||
      typeof settings.prompt !== 'string' ||
      !settings.prompt.trim() ||
      typeof settings.revision !== 'string'
    ) {
      return { ok: false, error: 'invalid settings response' };
    }
    return {
      ok: true,
      settings: {
        schema_version: Number(settings.schema_version) || 1,
        enabled: settings.enabled,
        immediate_send: settings.immediate_send,
        prompt: settings.prompt,
        revision: settings.revision,
      },
    };
  } catch (error) {
    return { ok: false, error: /** @type {ErrLike} */ (error).name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** 7.0-m2j — the heartbeat, and the channel the Vocalis Library's button arrives through.
 *
 * 🔴 TWO JOBS IN ONE REQUEST, DELIBERATELY. Vocalis has to know whether a SillyTavern tab is open
 * at all — that is the difference between rendering "importing…" and "no SillyTavern tab is open",
 * and only one of those directs users to investigate a problem that is not there. Since we are polling for
 * liveness regardless, the pending-sweep answer rides along rather than costing a second endpoint.
 *
 * `{ ok: true, sweep: true }` means Vocalis handed US the sweep — the server clears the flag in
 * the same lock, so two open tabs cannot both take it.

 * @param {string} serverBase
 * @param {string} token
 * @param {number} [timeoutMs]
 */
export async function pairPoll(serverBase, token, timeoutMs = 8000, build = '', self = '') {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // 🔴 9.5.17 — THE BUILD STAMP RIDES THE HEARTBEAT, which is the only message this side sends
    // unconditionally. A stale tab keeps whatever JS it loaded, and until now neither side could
    // tell: Vocalis saw a healthy poll while the send appeared to do nothing. It is a version
    // string and nothing else — no document, no name, no prose — so it does not widen what this
    // 5 s heartbeat carries (see the note below about `push` never being a document).
    //
    // ⚠️ OPTIONAL BY CONSTRUCTION. An older extension omits it and the server records "" rather
    // than refusing the poll: a staleness signal that BREAKS the stale client would be a fine way
    // to make the problem worse.
    //
    // 🔴 9.7.3 — AND `self` IS THE TAB'S OWN VERDICT, WHICH IS THE ONLY ONE WORTH HAVING. Vocalis
    // used to decide staleness by hashing `sillytavern/extension/` in its OWN repo — a directory
    // SillyTavern never reads, kept in step by hand. The tab compares what it is running against
    // what SillyTavern actually served it (`checkOwnBuild` in index.js) and sends the answer:
    // "current", "stale", or "unknown" when it could not find out. Three states, not a boolean,
    // because "I could not check" must never read as "you are fine".
    const params = new URLSearchParams();
    if (build) params.set('build', String(build));
    if (self) params.set('self', String(self));
    const q = params.toString() ? `?${params}` : '';
    const r = await fetch(`${base}/pair/poll${q}`, {
      signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${String(token || '')}` },
    });
    if (!r.ok) return { ok: false, sweep: false, push: null };
    const body = await r.json().catch(() => ({}));
    // 7.0-m3: `push` is a JOB — { id, revision, kind, name } — never a document. The content is
    // fetched over `fetchPlan` below, so this 5s heartbeat never carries document prose.
    //
    // ⚠️ And that claim is exact rather than approximate: `dropped` — the one field on this wire
    // that names a document — rides on the PLAN, not on the poll.
    //
    // 🔴 B.7: the server hands out a sweep and a send exclusively while a sweep is RUNNING, not
    // merely within one answer. This used to say "never both in one answer", which was true and
    // not enough — two tabs each polled and each got one, and they ran at the same time.
    const push = body.push && typeof body.push === 'object' ? body.push : null;
    return { ok: true, sweep: body.sweep === true, push };
  } catch (e) {
    // Silent by design: this fires every 5s, and a locked vault or a shut laptop would otherwise
    // paint an error over a UI the user is not even looking at.
    return { ok: false, sweep: false, push: null };
  } finally {
    clearTimeout(t);
  }
}

/** 7.0-m3 — fetch WHAT to write for a claimed send. The plan is Vocalis's, not ours.
 *
 * 🔴 THIS SIDE DECIDES NOTHING. Which endpoint a kind uses, which fields may be written, and that
 * a mirrored `character_book` is never sent are all rules about user data, and they live in
 * `wbedit/formats/st_write.py` so there is one copy of them. Everything here is execution.
 *
 *   { ok: true, kind, target, dropped: [...], book | merge | persona, id, revision }
 *   { ok: false, locked: true }              the vault is shut — NOT a rejected token
 *   { ok: false, reason }                    a sentence from Vocalis, safe to render

 * @param {string} serverBase
 * @param {string} token
 * @param {string} docId
 * @param {number} revision
 * @param {number} [timeoutMs]
 */
export async function fetchPlan(serverBase, token, docId, revision, timeoutMs = 30000) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const q = Number.isInteger(revision) ? `?revision=${revision}` : '';
    const r = await fetch(`${base}/pair/plan/${encodeURIComponent(docId)}${q}`, {
      signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${String(token || '')}` },
    });
    if (r.status === 401) {
      const body = await r.json().catch(() => ({}));
      if (body.error === 'locked') return { ok: false, locked: true };
      return { ok: false, reason: 'the pairing token was rejected' };
    }
    if (r.status === 423) return { ok: false, locked: true };
    if (r.status === 400) {
      // 🔴 VOCALIS'S OWN SENTENCE, and the one case in this file where a response body IS the
      // message. `Unsendable` is a fact about the document's shape, and
      // it never quotes content — that guarantee is on the Python side, in the raising code.
      const body = await r.json().catch(() => ({}));
      return { ok: false, reason: String(body.error || 'this document cannot be sent') };
    }
    if (!r.ok) return { ok: false, reason: `Vocalis answered HTTP ${r.status}` };
    const body = await r.json().catch(() => ({}));
    if (!body || typeof body !== 'object' || !body.kind) {
      return { ok: false, reason: 'Vocalis sent an unreadable plan' };
    }
    return { ok: true, ...body };
  } catch (e) {
    return { ok: false, reason: /** @type {ErrLike} */ (e).message };
  } finally {
    clearTimeout(t);
  }
}

/** m4o — fetch the card picture for a send whose plan says `avatar: true`.
 *
 * Returns `{ ok: true, blob }` or `{ ok: false, reason }`. The bytes are Vocalis's stored original
 * and go straight into a FormData for `/api/characters/edit-avatar`; nothing on this side decodes
 * or crops them. The face square is NOT baked in — it travels as the taproom fork's own
 * `taproom_avatar_focus` rect in the merge payload, which is why his full picture survives.

 * @param {string} serverBase
 * @param {string} token
 * @param {string} docId
 * @param {number} [timeoutMs]
 */
export async function fetchAvatar(serverBase, token, docId, timeoutMs = 30000) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/pair/avatar/${encodeURIComponent(docId)}`, {
      signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${String(token || '')}` },
    });
    if (r.status === 401) {
      const body = await r.json().catch(() => ({}));
      if (body.error === 'locked') return { ok: false, reason: 'the Vocalis vault is locked' };
      return { ok: false, reason: 'the pairing token was rejected' };
    }
    if (!r.ok) return { ok: false, reason: `Vocalis answered HTTP ${r.status}` };
    return { ok: true, blob: await r.blob() };
  } catch (e) {
    return { ok: false, reason: /** @type {ErrLike} */ (e).message };
  } finally {
    clearTimeout(t);
  }
}

/** 7.0-m3 — report how the write went. Ends the run on the Vocalis side either way.
 *
 * 🔴 `ok` MEANS THE WRITE WAS ACCEPTED BY SILLYTAVERN, not that we made the call. A confirmation
 * that only means "something was sent" is untrustworthy and worse than none.
 *
 * ⚠️ `reason` IS ONE OF OURS, NEVER A CAUGHT MESSAGE. `merge-attributes` answers a validation
 * failure with the validator's own string and a 500 with `exception.toString()`; either can carry
 * a slice of the card. Callers pass a phrase from `PUSH_REASONS` and the specifics stay in the
 * browser console for local diagnostics.

 * @param {string} serverBase
 * @param {string} token
 * @param {any} result
 */
export async function pushDone(serverBase, token, result) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  // Bound this report request so it cannot retain the single-run lease indefinitely.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REPORT_TIMEOUT_MS);
  try {
    await fetch(`${base}/pair/push`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${String(token || '')}`,
      },
      body: JSON.stringify({
        ok: result.ok === true,
        reason: String(result.reason || ''),
        id: String(result.id || ''),
        revision: Number.isInteger(result.revision) ? result.revision : null,
        created: result.created === true,
        // §9a.33 — the key SillyTavern filed a newly-created card under, so the NEXT send merges
        // into it instead of creating a second character. 🔴 Reported even when the send is
        // otherwise a failure: `createCard` returns `{ok:false, reason:'picture', created, ref}`
        // for a character that DID land and whose image did not, and losing the ref there is what
        // would turn his retry into a duplicate.
        ref: String(result.ref || ''),
        reloaded: result.reloaded === true,
        // m4o — whether the PICTURE went too. Vocalis clears `avatar_dirty` on this and only on
        // this, so reporting it for a send that did not carry the image would leave SillyTavern
        // showing the old face with nothing ever trying again.
        avatar: result.avatar === true,
        // 🔴 9.5.17 — THE DISPLAY NAME OF WHAT WAS WRITTEN, AND ITS ABSENCE HERE IS WHY 9.5.14
        // SHIPPED BROKEN. `writePersona` computed it correctly, `pair.py` accepted it, `wb/st.js`
        // rendered it, and a test pinned the route's handling of it — but THIS function builds the
        // body field by field, so a field nobody added here never leaves the browser at all. Every
        // layer was right about a value the wire silently dropped.
        //
        // ⚠️ `push.last.wrote` came back empty on a live merge while the harness returned a name;
        // reading `pu.personas[target]`
        // in the real page on BOTH sides of the send showed the value present throughout. That
        // ruled out the read and left only the transmission — which is the one layer no test
        // covered, because each test held the object it was checking.
        wrote: String(result.wrote || ''),
      }),
    });
  } catch (e) {
    // Nothing useful to do — the write itself already happened or did not, and Vocalis times the
    // run out. Retrying could double-apply it. An abort lands here too, which is the point.
  } finally {
    clearTimeout(t);
  }
}

/** Report what a claimed sweep managed. Ends the run on the Vocalis side either way.
 * @param {string} serverBase
 * @param {string} token
 * @param {any} tally
 */
export async function sweepDone(serverBase, token, tally) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController(); // bounded, for the reason `pushDone` explains
  const t = setTimeout(() => ctrl.abort(), REPORT_TIMEOUT_MS);
  try {
    await fetch(`${base}/pair/sweep`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${String(token || '')}`,
      },
      // 🔴 COUNTS AND DOCUMENT NAMES ONLY. Never a caught exception's text: a parse failure on the
      // SillyTavern side can quote a window of a lorebook into its message (their own b7350db26),
      // and this body is rendered into the Vocalis UI.
      // 🔴 EVERY KIND THE SWEEP COUNTS HAS TO BE HERE. `personas` was missing from this body for
      // the whole of §8.3's life: `runSweep` incremented `tally.personas`, the drawer said "sent
      // N persona(s)", the documents really were in the vault — and the Vocalis Library reported
      // 0 personas imported, every time, because the key never crossed. `pair.py` reads it and
      // has done since the read side landed. Silent, and it looks exactly like an import that
      // did not happen, which is the failure that end's own comment warns about.
      body: JSON.stringify({
        books: tally.books | 0,
        cards: tally.cards | 0,
        personas: tally.personas | 0,
        unchanged: tally.unchanged | 0,
        errors: (tally.errors || []).slice(0, 20),
      }),
    });
  } catch (e) {
    // Nothing useful to do — the sweep itself already happened, and Vocalis times the run out.
  } finally {
    clearTimeout(t);
  }
}

/** 7.0-m2i — push one worldbook or character card into the Vocalis Library.
 *
 * Sends a worldbook or character card from SillyTavern to the Vocalis Library without a manual
 * export and upload.
 *
 * `stRef` is SillyTavern's own key for the document — a book's NAME, or a card's AVATAR FILENAME
 * — and it is what makes a second press land on the row it belongs to instead of filing a
 * duplicate. The server refuses an empty one rather than quietly minting a new document per
 * press, so do not "helpfully" default it.
 *
 * 🔴 THE KIND IS NOT SENT. Vocalis detects it from the document (§4.2); a kind declared here
 * would be a second answer to a question it already answers by looking, and this side is the one
 * more likely to be wrong about it.
 *
 * Returns a plain shape rather than throwing, exactly like `pairPing` above and for the same
 * reason — one caller renders it into a status line:
 *   { ok: true,  created, id, revision, avatar }   filed: `created` false means revision N+1;
 *                                                  `avatar` false means Vocalis has no picture yet
 *   { ok: false, paired: false }            401 with a token the server rejected
 *   { ok: false, locked: true }             the vault is shut — NOT a rejected token
 *   { ok: false, error }                    unreachable, refused, timed out, too large

 * @param {string} serverBase
 * @param {string} token
 * @param {string} stRef
 * @param {any} document
 * @param {string} [avatarRef]
 * @param {number} [timeoutMs]
 */
export async function pushDocument(serverBase, token, stRef, document, avatarRef = '', timeoutMs = 30000) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/pair/documents`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${String(token || '')}`,
      },
      // 🔴 7.3.9 — `avatar_ref` IS SILLYTAVERN'S STAMP FOR THE PICTURE AS IT STANDS RIGHT NOW, and
      // it is what turns the reply's `avatar` from "do you have a picture" into "do you have THIS
      // picture". Without it a changed image never reached Vocalis: `created` was false, a picture
      // was present, and the caller skipped the fetch on every press for ever. Omitted (empty) is
      // a valid state and means the old answer — see `_avatar_is_current` on the server.
      body: JSON.stringify({
        st_ref: String(stRef || ''),
        document,
        avatar_ref: String(avatarRef || ''),
      }),
    });
    // 🔴 A LOCKED VAULT ALSO ANSWERS 401 AND IT IS NOT "WRONG TOKEN" — the same trap `pairPing`
    // documents at length. Telling the user a correct token was rejected could lead them to press Generate, which
    // rotates the secret and revokes a pairing that was working. Distinguish on the body.
    if (r.status === 401) {
      const body = await r.json().catch(() => ({}));
      if (body.error === 'locked') return { ok: false, locked: true };
      return { ok: false, paired: false };
    }
    if (r.status === 423) return { ok: false, locked: true };
    if (r.status === 413) return { ok: false, error: 'the document is too large' };
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = await r.json().catch(() => ({}));
    // `avatar` is Vocalis saying whether it already holds this card's CURRENT picture (item 12,
    // tightened in 7.3.9 — it used to mean "any picture", which is why a changed image never
    // traveled). Older servers omit it; `!== false` therefore means "assume present", so an
    // extension talking to one never re-uploads every picture on every press.
    // ⚠️ `avatarDirty` DEFAULTS FALSE, the opposite way round from `avatar`, and both defaults are
    // "behave as before". An older server omits it; treating that as dirty would make the persona
    // sweep skip every picture for ever, which is the bug this field exists to avoid, inverted.
    return {
      ok: true,
      created: body.created === true,
      id: body.id,
      revision: body.revision,
      avatar: body.avatar !== false,
      avatarDirty: body.avatar_dirty === true,
    };
  } catch (e) {
    // The exception's MESSAGE, never a response body — this file's standing rule (I16).
    return { ok: false, error: /** @type {ErrLike} */ (e).message };
  } finally {
    clearTimeout(t);
  }
}

/** 7.0-m2i — the card PNG for a document already filed by `pushDocument`.
 *
 * 🔴 SENT AS RAW BYTES, NOT BASE64 IN A JSON FIELD. A card is ~700 KB at p50 and 1.25 MB at the
 * observed max (§4.3); base64 inflates that by a third for nothing, and a JSON round trip is one
 * more place the bytes could be normalized. The picture must arrive byte-identical — an animated
 * PNG has to survive, and so do foreign chunks like ComfyUI's generation metadata.
 *
 * Failure is NON-FATAL to the caller by design: the card itself is already in the Library and the
 * Library renders an avatar-less card correctly, so a failed picture is a note, not a rollback.

 * @param {string} serverBase
 * @param {string} token
 * @param {string} docId
 * @param {Blob} blob
 * @param {string} [avatarRef]
 * @param {number} [timeoutMs]
 */
export async function pushAvatar(serverBase, token, docId, blob, avatarRef = '', timeoutMs = 30000) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/pair/documents/${encodeURIComponent(docId)}/avatar`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'image/png',
        'Authorization': `Bearer ${String(token || '')}`,
        // 7.3.9 — a HEADER because the body is the picture. Vocalis stores it beside the bytes and
        // compares it on the next push; a send with no stamp simply clears it, which is honest.
        'X-Vocalis-Avatar-Ref': String(avatarRef || ''),
      },
      body: blob,
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: /** @type {ErrLike} */ (e).message };
  } finally {
    clearTimeout(t);
  }
}

/** Voice stems the server offers (GET /v1/audio/voices — bearer-gated since 7.0-m6, CORS'd).
 * @param {string} serverBase
 * @param {string} token
 */
export async function fetchVoices(serverBase, token) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/audio/voices`, { headers: authHeader(token) });
  if (!r.ok) throw new Error(`voices failed (${r.status})`);
  const body = await r.json();
  return body.voices || [];
}

/** Ask the server to render this text NOW, speculatively, so the user's eventual
 * click is a cache hit (Vocalis 5.2). Body is deliberately IDENTICAL to what
 * playStream posts to /v1/audio/stream — the two must derive the same cache key
 * server-side or the pre-render can never be claimed, and nothing anywhere would
 * report that it wasn't. See DESIGN_5_2_PRERENDER §4.4.
 *
 * Resolves to {cache_key, state, queued}; `state` may be "declined" (queue full,
 * switched off, or the model is cold), which is not an error — it just means the
 * click will cost what it costs today.
 * @param {string} serverBase
 * @param {any} body
 * @param {string} token
 */
export async function prerender(serverBase, body, token) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/audio/prerender`, {
    method: 'POST',
    headers: authHeader(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`prerender failed (${r.status})`);
  return r.json();
}

/** Drop speculative work whose reason to exist went away — the message was swiped,
 * deleted, or the chat changed. `{cache_key}` for one, `{all: true}` for the lot.
 * @param {string} serverBase
 * @param {{ cache_key?: string, all?: boolean }} what the cancel body
 * @param {string} token
 */
export async function cancelPrerender(serverBase, what, token) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/audio/prerender/cancel`, {
    method: 'POST',
    headers: authHeader(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(what || {}),
  });
  if (!r.ok) throw new Error(`prerender cancel failed (${r.status})`);
  return r.json();
}

/** What the server HAS for these messages — read-only and batched (Vocalis 5.4).
 *
 * `items` is an array of the SAME bodies playStream/prerender post, because the answer is
 * only useful if it is about the cache key a click would actually look up (the server
 * derives it through one shared resolver; see DESIGN_5_4_BUTTON_STATE.md §5.3).
 *
 * Resolves to an array of {cache_key, state, detail} in REQUEST ORDER, one per item, where
 * state is cached | playable | rendering | queued | none. Strictly read-only: unlike
 * `prerender` below, this never queues a render, which is what makes it safe to point at a
 * whole chat on load.
 *
 * 🔴 The server caps a request at 200 items. Callers CHUNK to it — a chat with
 * `chat_truncation` switched off paints every message at once, and one oversized batch
 * would 400 the lot instead of coloring the 200 the user can see. */
export const MAX_STATE_ITEMS = 200;

/**
 * @param {string} serverBase
 * @param {any[]} items
 * @param {string} token
 */
export async function fetchStates(serverBase, items, token) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const out = [];
  for (let i = 0; i < items.length; i += MAX_STATE_ITEMS) {
    const r = await fetch(`${base}/v1/audio/state`, {
      method: 'POST',
      headers: authHeader(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ items: items.slice(i, i + MAX_STATE_ITEMS) }),
    });
    if (!r.ok) throw new Error(`state failed (${r.status})`);
    const body = await r.json();
    out.push(...(body.states || []));
  }
  return out;
}

/** Push characters to the server's ST registry (POST /v1/st/characters — bearer-gated since
 * 7.0-m6, CORS'd) so they're assignable in the Vocalis web UI before their first narration.
 * Upsert-only; best-effort (errors are the caller's call).
 *
 * 7.0-m5b — each entry is `{name, avatar}` or a bare name string. The server accepts both, so this
 * function passes through whatever the caller built and an un-reinstalled copy of the extension
 * keeps working. The avatar distinguishes characters that share a name.
 * @param {string} serverBase
 * @param {(string | { name: string, avatar: string })[]} names - BOTH shapes are
 *    accepted by the server on purpose, so an extension copy that has not been
 *    re-installed keeps working; see index.js's note above its caller.
 * @param {string} token
 */
export async function registerCharacters(serverBase, names, token) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/st/characters`, {
    method: 'POST',
    headers: authHeader(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ characters: names }),
  });
  if (!r.ok) throw new Error(`character registration failed (${r.status})`);
  return (await r.json()).registered || 0;
}

/* ── 6.0: audio scenes ────────────────────────────────────────────────────────
 * A scene is a contiguous range of chat messages assembled into ONE file
 * (DESIGN_6_0_AUDIO_SCENES). All four calls take `items` — and every one
 * of those entries must be `bodyFor()` output BYTE FOR BYTE.
 *
 * 🔴 That is the 5.4 landmine restated for a fourth and fifth route.
 * /v1/audio/stream, /v1/audio/prerender, /v1/audio/state and now these must all
 * derive the SAME cache key from the same message, and they can only do that if
 * handed the same bytes. An item that differs by one field describes audio
 * nothing will ever find: the scene renders everything from scratch, silently,
 * the estimate says "0 cached" when the whole range is warm, and the buttons
 * stay orange. Nothing errors and nothing logs. So these helpers take the
 * bodies as given and add nothing to them. */

/** What a range would cost, before committing to it (§2.3). Returns
 * {total, cached, uncached, est_audio_s, est_render_s, render_rate, …}, where a
 * null estimate means THIS BOX HAS NEVER BEEN MEASURED and the bar must say so
 * rather than invent a number.
 * @param {string} serverBase
 * @param {any[]} items
 * @param {number} gapS
 * @param {string} token
 */
export async function estimateScene(serverBase, items, gapS, token) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/audio/scene/estimate`, {
    method: 'POST',
    headers: authHeader(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ items, gap_s: gapS }),
  });
  if (!r.ok) throw new Error(`estimate failed (${r.status})`);
  return r.json();
}

/** Start a build. 202 -> {job_id, items, skipped}.
 * 409 means one is already running on that box; the running job's id is in the
 * error body so the caller can offer to show it instead.
 *
 * 6.3: the `enhance` request field and the `enhance` / `enhance_unavailable` reply fields are
 * GONE. A build lands the scene and stops; enhancing it is a verb on its row in the Clips tab.
 * The 409 STAYS — the render-phase one-at-a-time rule is unchanged.
 * @param {string} serverBase
 * @param {any} payload
 * @param {string} token
 */
export async function createScene(serverBase, payload, token) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/audio/scene`, {
    method: 'POST',
    headers: authHeader(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Same shape as util/http.js's HttpError: the Error carries the fields the caller
    // branches on. Declared inline because this file is loaded by SillyTavern and does not
    // import the web UI's types.
    const err = /** @type {Error & { status?: number, jobId?: string }} */ (
      new Error((body.error && body.error.message) || `scene failed (${r.status})`)
    );
    err.status = r.status;
    err.jobId = body.error && body.error.job_id;
    throw err;
  }
  return body;
}

/** Poll a build. `ref` appears as soon as the raw scene lands — BEFORE status
 * leaves "enhancing" (§3.5a) — so a caller that waits for "done" to offer the
 * file throws away the whole point of landing it early.
 * @param {string} serverBase
 * @param {string} jobId
 * @param {string} token
 */
export async function sceneStatus(serverBase, jobId, token) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/audio/scene/${encodeURIComponent(jobId)}`, {
    headers: authHeader(token),
  });
  if (!r.ok) throw new Error(`scene status failed (${r.status})`);
  return r.json();
}

/** Stop a build. Canceling during the ENHANCE is not a failure and discards
 * nothing: the scene already landed and stays (§9).
 * @param {string} serverBase
 * @param {string} jobId
 * @param {string} token
 */
export async function cancelScene(serverBase, jobId, token) {
  const base = String(serverBase || '').replace(/\/+$/, '');
  const r = await fetch(`${base}/v1/audio/scene/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    headers: authHeader(token),
  });
  if (!r.ok) throw new Error(`scene cancel failed (${r.status})`);
  return r.json();
}
