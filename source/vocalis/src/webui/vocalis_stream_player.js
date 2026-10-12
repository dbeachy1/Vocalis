'use strict';
/* Same-origin streaming audio helper. Register or adopt a stream, play progressive MP3 chunks through MediaSource, and check status at end so interrupted generation can be retried. Optional visible-player mode exposes native playback controls; pausing does not pause rendering, and `startAt` begins playback once that offset is buffered. */
/** State meanings are distinct: `done` completed, `error` indicates interrupted generation, and `unknown` means completion could not be verified.
 * @typedef {object} StreamStatus
 * @property {'new'|'live'|'done'|'error'|'canceled'|'unknown'} state
 * @property {string|null} [error] - the server's sentence when `state === 'error'`.
 */

(function () {
  /** Register or adopt a stream and play it. This is the module's public entry point. Types are ambient because the helper is loaded as a global script before the module bundle.
 * @param {VocalisStreamOpts} opts
 * @returns {VocalisStreamHandle}
 */
  function play(opts) {
    const registerUrl = opts.registerUrl || '/webui/stream';
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
        try {
          audio.removeAttribute('src');
        } catch (e) {
          /* headless */
        }
        audio = null; // caller-provided elements stay in the DOM (caller hides them)
      }
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }
    }

    /**
     * @param {string} url
     * @returns {HTMLAudioElement}
     */
    function mkAudio(url) {
      // Caller-provided element = visible native controls over the stream;
      // otherwise a headless Audio (the extensions' original behavior).
      if (opts.audioEl) {
        // Declared `HTMLAudioElement|VEl` (types/vocalis.d.ts) because callers reach it through
        // `$()`. It is an `<audio>` — the caller passed one — and this is where that is known.
        const el = /** @type {HTMLAudioElement} */ (opts.audioEl);
        el.src = url;
        return el;
      }
      return new Audio(url);
    }

    /** @param {string} msg */
    function fail(msg) {
      if (stopped) return;
      stopped = true;
      ctrl.abort();
      teardown();
      if (opts.onError) opts.onError(msg);
    }

    (async () => {
      let reg;
      if (opts.streamUrl) {
        reg = { stream_url: opts.streamUrl, status_url: opts.statusUrl };
      } else {
        try {
          const resp = await fetch(registerUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts.body || {}),
            signal: ctrl.signal,
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            return fail(err.error || `register failed (${resp.status})`);
          }
          reg = await resp.json();
        } catch (e) {
          if (/** @type {ErrLike} */ (e).name !== 'AbortError') fail(/** @type {ErrLike} */ (e).message || 'the stream failed');
          return;
        }
      }
      if (stopped) return;

      let media;
      try {
        media = await fetch(reg.stream_url, { signal: ctrl.signal });
      } catch (e) {
        if (/** @type {ErrLike} */ (e).name !== 'AbortError') fail(/** @type {ErrLike} */ (e).message || 'the stream failed');
        return;
      }
      if (!media.ok) return fail(`stream failed (${media.status})`);
      if (stopped) return;

      const finishByStatus = async () => {
        // Truncation check: did the stream end because it finished, or broke?
        /** @type {StreamStatus} */
        let st = { state: 'unknown' };
        try {
          const r = await fetch(reg.status_url, { signal: ctrl.signal });
          if (r.ok) st = await r.json();
        } catch (e) {
          /* can't verify — treat as complete */
        }
        teardown();
        if (st.state === 'error') {
          if (opts.onTruncated) opts.onTruncated(() => play(opts));
          else if (opts.onError) opts.onError('playback was truncated: ' + (st.error || 'server error'));
        } else if (opts.onEnded) {
          opts.onEnded();
        }
      };

      const wire = () => {
        /** @type {HTMLAudioElement} */ (audio).addEventListener('playing', () => {
          if (!stopped && opts.onPlaying) opts.onPlaying();
        });
        /** @type {HTMLAudioElement} */ (audio).addEventListener(
          'ended',
          () => {
            if (!stopped) finishByStatus();
          },
          { once: true },
        );
        /** @type {HTMLAudioElement} */ (audio).addEventListener(
          'error',
          e => {
            // ⚠️ `MediaError` LIVES ON THE MEDIA ELEMENT, NOT ON `EventTarget`, and this is cast at
            // the site rather than widened in `types/dom-permissive.d.ts`. That file's header sets
            // the test: a new member there is a lie paid for by every EventTarget in the tree, and
            // this is ONE site whose element type is known for certain — `wire()` only ever runs
            // against the `<audio>` this function just built.
            const el = /** @type {HTMLMediaElement} */ (e.target);
            if (!stopped && audio) fail('audio error: ' + (el.error && el.error.message));
          },
          { once: true },
        );
      };

      const ctype = media.headers.get('Content-Type') || '';
      if (ctype.includes('audio/wav') || !window.MediaSource || !MediaSource.isTypeSupported('audio/mpeg')) {
        const blob = await media.blob().catch(() => /** @type {Blob|null} */ (null));
        if (!blob || stopped) return;
        blobUrl = URL.createObjectURL(blob);
        audio = mkAudio(blobUrl);
        wire();
        if (Number(opts.startAt) > 0) {
          audio.addEventListener(
            'loadedmetadata',
            () => {
              try {
                const dur = /** @type {HTMLAudioElement} */ (audio).duration || 0;
                /** @type {HTMLAudioElement} */ (audio).currentTime = Math.min(/** @type {number} */ (opts.startAt), Math.max(0, dur - 1));
              } catch (e) {
                /* best effort */
              }
            },
            { once: true },
          );
        }
        audio.play().catch(e => fail(e.message));
        return;
      }

      const ms = new MediaSource();
      blobUrl = URL.createObjectURL(ms);
      audio = mkAudio(blobUrl);
      wire();
      // startAt (resume-behind): hold playback until that point is buffered, then
      // seek + play. The banked prefix streams far faster than realtime (disk ->
      // ffmpeg), so the wait is typically a second or two.
      let pendingSeek = Number(opts.startAt) > 0 ? Number(opts.startAt) : null;
      ms.addEventListener(
        'sourceopen',
        () => {
          const sb = ms.addSourceBuffer('audio/mpeg');
          const reader = /** @type {ReadableStream<Uint8Array<ArrayBuffer>>} */ (media.body).getReader();
          const grow = () => {
            // Native controls' seek range = the buffered end, growing per append —
            // "scrub up to how far we've gotten". Never shrinks; safe while open.
            try {
              if (ms.readyState === 'open' && !sb.updating && sb.buffered.length) {
                const end = sb.buffered.end(sb.buffered.length - 1);
                if (!(ms.duration >= end)) ms.duration = end;
              }
            } catch (e) {
              /* transient InvalidState during teardown — ignore */
            }
          };
          const maybeSeek = () => {
            if (pendingSeek === null || !sb.buffered.length) return;
            if (sb.buffered.end(sb.buffered.length - 1) >= pendingSeek + 0.5) {
              const t = pendingSeek;
              pendingSeek = null;
              try {
                /** @type {HTMLAudioElement} */ (audio).currentTime = t;
              } catch (e) {
                /* best effort */
              }
              /** @type {HTMLAudioElement} */ (audio).play().catch(e => {
                if (!stopped) fail(e.message);
              });
            }
          };
          // MediaSource SourceBuffers have a finite quota; a long render eventually
          // overflows it and appendBuffer throws QuotaExceededError. Rather than tear
          // the stream down, drop already-played audio behind the playhead and retry;
          // if there's nothing yet to drop, wait for playback to drain (which also
          // backpressures the server through the still-unread stream). KEEP_BEHIND_S
          // of played audio stays scrubbable.
          // Keep as much scrubback as the quota allows: on overflow drop only the
          // OLDEST slice (and never within SAFE_BEHIND_S of the playhead), NOT
          // everything behind the head. Below the quota nothing is evicted — the whole
          // clip stays scrubbable; only a render longer than the browser's SourceBuffer
          // quota (~tens of minutes of audio) trims at all, and then it retains ~the
          // full quota window, losing only its oldest audio (unavoidable — MSE cannot
          // hold more than the quota).
          const SAFE_BEHIND_S = 30; // never evict audio this close behind the playhead
          const EVICT_STEP_S = 60; // drop at most this much of the oldest audio per overflow
          /** @returns {Promise<Event>} resolves on `updateend`, rejects if the buffer errors. */
          const afterUpdate = () =>
            new Promise((res, rej) => {
              sb.addEventListener('updateend', res, { once: true });
              sb.addEventListener('error', () => rej(new Error('SourceBuffer error')), {
                once: true,
              });
            });
          const evictOldest = async () => {
            if (ms.readyState !== 'open' || sb.updating || !sb.buffered.length) return false;
            const start = sb.buffered.start(0);
            const now = /** @type {HTMLAudioElement} */ (audio).currentTime || 0;
            const end = Math.min(start + EVICT_STEP_S, now - SAFE_BEHIND_S);
            if (end <= start + 0.1) return false; // nothing safely removable yet
            sb.remove(start, end);
            await afterUpdate();
            return true;
          };
          /** @param {BufferSource} chunk - one `reader.read()` value, appended whole. */
          const appendChunk = async chunk => {
            while (true) {
              try {
                sb.appendBuffer(chunk);
                await afterUpdate();
                return;
              } catch (e) {
                if (/** @type {ErrLike} */ (e).name !== 'QuotaExceededError') throw e;
                if (!(await evictOldest())) {
                  if (stopped) return;
                  await new Promise(res => setTimeout(res, 200)); // let playback drain, then retry
                }
              }
            }
          };
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
                await appendChunk(value);
                grow();
                maybeSeek();
              }
              if (!got) throw new Error('stream ended with no audio');
              if (ms.readyState === 'open') ms.endOfStream();
              if (pendingSeek !== null) {
                // stream shorter than the seek target — play it all
                pendingSeek = null;
                /** @type {HTMLAudioElement} */ (audio).play().catch(e => {
                  if (!stopped) fail(e.message);
                });
              }
            } catch (err) {
              if (!stopped && /** @type {ErrLike} */ (err).name !== 'AbortError')
                fail(/** @type {ErrLike} */ (err).message || 'the stream failed');
            }
          })();
        },
        { once: true },
      );
      if (!(Number(opts.startAt) > 0))
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

  window.VocalisStreamPlayer = { play };
})();
