// This content script runs in Nomi's page, so DOM selectors are external inputs and may disappear
// when the site changes. Nullable DOM results and playback state reflect those runtime lifetimes.
// Chrome's callback-based extension APIs are declared in `types/host-chrome.d.ts`.
'use strict';

// Vocalis unified server (2.1): /speak lives here alongside the web UI and the
// SillyTavern endpoint — one process, one model in VRAM (was the standalone
// nomi_server on :8765). The base URL is configurable via the extension's Options
// page (right-click the extension ▸ Options), stored in chrome.storage.sync and
// kept live below; it defaults to a local server. speak/health fetches happen on
// click, by which point the stored value has loaded.
let SERVER = 'http://127.0.0.1:7870';
// Gated speech endpoints require the Vocalis pairing token. It is independent from the
// SillyTavern token and updates live when extension storage changes.
let TOKEN = '';
chrome.storage.sync.get({ server: SERVER, token: '' }, ({ server, token }) => {
  if (server) SERVER = server;
  TOKEN = token || '';
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.server) SERVER = changes.server.newValue || SERVER;
  // ⚠️ THE GUARD IS ON THE CHANGE RECORD, NOT ON ITS VALUE: clearing the token to unpair is a
  // legitimate edit and must reach the live value, which `changes.token.newValue || TOKEN` would
  // silently discard. `|| ''` below is what carries an intentional clear through.
  //
  // ⚠️ A LOCAL, BECAUSE `'token' in changes` DOES NOT NARROW. The bag only carries the keys
  // that actually changed, which the type now says (`ChromeStorageChange | undefined`), and the
  // `in` operator does not remove `undefined` from an index signature's value type. Binding it
  // first is the same test — the record is either absent or an object, never falsy-but-present.
  const tok = changes.token;
  if (tok) TOKEN = tok.newValue || '';
});

/** Headers for a POST that Vocalis gates. ⚠️ NOT for the stream GET — see `speakHeaders` use. */
function speakHeaders() {
  // `HeadersInit` accepts this string map, including the optional Authorization header below.
  /** @type {Record<string, string>} */
  const h = { 'Content-Type': 'application/json' };
  // Omitted entirely when unset, rather than sent empty: `Bearer ` with nothing after it is a
  // malformed credential, and the server's 401 should mean "not paired", not "sent garbage".
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

/**
 * Vocalis answered, and refused this one request. `shown` is the sentence for the button.
 *
 * 2026-10-12: every failure put "Start Vocalis first" on the button, including the ones where
 * Vocalis was running and had said exactly what was wrong: a message with nothing to speak in it
 * (only "...", an emoji, or all *actions* with action narration off, which the server refuses
 * with a 400) and a wrong pairing token (401). The server's own reason is shown instead.
 */
class Refused extends Error {
  /**
   * @param {string} message
   * @param {string} shown
   */
  constructor(message, shown) {
    super(message);
    this.shown = shown;
  }
}

/**
 * The server's own sentence for a request it refused with a 400 (`{"error": "..."}`), or ''.
 * @param {Response} resp
 * @returns {Promise<string>}
 */
async function refusalReason(resp) {
  if (resp.status !== 400) return '';
  try {
    const body = await resp.json();
    return body && typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

/**
 * A 401 means one specific, fixable thing. Say which, once, rather than `server 401`.
 * @param {number} status
 * @param {string} [reason] what `refusalReason` read from a 400 answer
 * @returns {Error}
 */
function speakError(status, reason) {
  if (status === 401) {
    const what = TOKEN
      ? 'this pairing token is not the one Vocalis expects. It may have been ' +
        'rotated, or it may be the SillyTavern token: copy the one from the Vocalis Nomi tab ' +
        "into this extension's Options page. (If Vocalis is locked, unlock it first.)"
      : 'no pairing token set. Open the Vocalis web UI, Nomi tab, copy the pairing ' +
        "token, and paste it into this extension's Options page.";
    return new Refused(`server 401 — ${what}`, `Vocalis refused: ${what}`);
  }
  if (status === 400 && reason) {
    return new Refused(`server 400 — ${reason}`, `Vocalis did not speak this message: ${reason}`);
  }
  return new Error(`server ${status}`);
}
const LONG_PRESS_MS = 600;

// Client-side chunking (2.2): long messages are split into ~paragraph segments and
// sent as separate /speak requests, all fired up front. The server queues them at
// INTERACTIVE priority and its per-GPU workers drain them in parallel, so playback
// starts as soon as the FIRST segment's audio lands instead of after the whole
// message renders. Generation runs faster than realtime, so segment N+1 is ready
// before segment N finishes playing — each segment's playback time is the buffer.
const SEG_MAX = 400; // chars; mirrors the server's CHUNK_SIZE so 1 segment ≈ 1 GPU chunk

/**
 * Break a reply into segments the server can render one GPU chunk at a time.
 * @param {string} text
 * @returns {string[]}
 */
function splitSegments(text) {
  const paras = text
    .split(/\n+/)
    .map(/** @param {string} p */ p => p.trim())
    .filter(Boolean);

  // 1) Greedily merge adjacent paragraphs while the combination stays ≤ SEG_MAX —
  //    keeps roleplay one-liners ("*smiles*") from becoming their own requests.
  /** @type {string[]} */
  const groups = [];
  for (const p of paras) {
    const last = groups[groups.length - 1];
    if (last && last.length + 2 + p.length <= SEG_MAX) {
      groups[groups.length - 1] = `${last}\n\n${p}`;
    } else {
      groups.push(p);
    }
  }

  // 2) Split any oversize group at sentence boundaries into ≤ SEG_MAX pieces.
  //    (A single sentence longer than SEG_MAX passes through whole; the server's
  //    chunker clause-splits it.)
  const segs = [];
  for (const g of groups) {
    if (g.length <= SEG_MAX) {
      segs.push(g);
      continue;
    }
    const sentences = g.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [g];
    let cur = '';
    for (const s of sentences) {
      const t = s.trim();
      if (!t) continue;
      if (cur && cur.length + 1 + t.length > SEG_MAX) {
        segs.push(cur);
        cur = t;
      } else cur = cur ? `${cur} ${t}` : t;
    }
    if (cur) segs.push(cur);
  }
  return segs;
}

const SVG_PLAY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm14.024-.983a1.125 1.125 0 0 1 0 1.966l-5.603 3.113A1.125 1.125 0 0 1 9 15.113V8.887c0-.857.921-1.4 1.671-.983l5.603 3.113Z"/></svg>`;
const SVG_STOP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm6-2.438c0-.724.588-1.312 1.313-1.312h4.874c.725 0 1.313.588 1.313 1.313v4.874c0 .725-.588 1.313-1.313 1.313H9.564a1.312 1.312 0 0 1-1.313-1.313V9.564Z"/></svg>`;
const SVG_WARN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"/></svg>`;

/**
 * @param {HTMLElement} btn
 * @returns {string|null} the Nomi's id, or null when neither the URL nor the avatar yields one
 */
function getNomiId(btn) {
  // 1:1 chat: ID is in the URL.
  const urlMatch = location.pathname.match(/\/nomis\/(\d+)/);
  if (urlMatch) return urlMatch[1];

  // Group chat: avatar background is set via CSS class, not inline style.
  // The avatar div lives at nomiPictureWrapper > div > div[size="56"].
  let node = btn.parentElement;
  for (let i = 0; i < 10 && node && node !== document.body; i++, node = node.parentElement) {
    const pictureWrapper = node.querySelector('[class*="nomiPictureWrapper"]');
    if (!pictureWrapper) continue;
    const avatarEl = pictureWrapper.querySelector('[size="56"]');
    if (!avatarEl) continue;
    const m = getComputedStyle(avatarEl).backgroundImage.match(/\/api\/nomis\/(\d+)\//);
    if (m) return m[1];
  }
  console.warn('[Vocalis] getNomiId: avatar not found');
  return null;
}

/**
 * @param {HTMLElement} btn
 * @returns {string} the display name, or `'unknown'` when neither lookup matches
 */
function getNomiName(btn) {
  // Group chat: walk up until we find an ancestor that contains the name element.
  let node = btn.parentElement;
  for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
    const p = node.querySelector('[class*="nomiName"] p');
    if (p?.textContent?.trim()) return p.textContent.trim();
  }
  // 1:1 chat: name is in the sidebar nav link for the current URL.
  return document.querySelector(`a[href="${location.pathname}"] h3`)?.textContent?.trim() ?? 'unknown';
}

/** @param {HTMLElement} sideInfo the per-message side panel this button is added to */
function injectButton(sideInfo) {
  if (sideInfo.dataset.chatterboxInjected) return;
  sideInfo.dataset.chatterboxInjected = '1';

  const btn = document.createElement('button');
  btn.className = 'nomi-cb-btn nomi-cb-idle';
  btn.innerHTML = SVG_PLAY;
  btn.title = '';

  let state = 'idle';
  /** @type {AbortController|null} */
  let abortCtrl = null;
  /** @type {HTMLAudioElement|null} */
  let audio = null;
  /** @type {string|null} */
  let blobUrl = null;

  // Long-press state
  /** @type {ReturnType<typeof setTimeout>|null} */
  let pressTimer = null;
  let longPressArmed = false; // threshold reached, spinner started
  let longPressHandled = false; // mouseup triggered force-speak, suppress click

  function setIdle() {
    state = 'idle';
    btn.className = 'nomi-cb-btn nomi-cb-idle';
    btn.innerHTML = SVG_PLAY;
    btn.title = '';
    console.log('[Vocalis] → idle');
  }

  /**
   * @param {string} nomiName
   * @param {string|null} nomiId
   */
  function setGenerating(nomiName, nomiId) {
    state = 'generating';
    btn.className = 'nomi-cb-btn nomi-cb-generating';
    btn.innerHTML = SVG_PLAY;
    btn.title = 'generating…';
    console.log('[Vocalis] → generating', nomiName, `[${nomiId}]`);
  }

  /**
   * @param {string} cacheKey the server's X-Cache-Key, or '' when it did not send one
   * @param {string} nomiName
   */
  function setPlaying(cacheKey, nomiName) {
    state = 'playing';
    btn.className = 'nomi-cb-btn nomi-cb-playing';
    btn.innerHTML = SVG_STOP;
    btn.title = cacheKey ? `${cacheKey}.wav` : '';
    console.log('[Vocalis] → playing', cacheKey ? `(${cacheKey.slice(0, 8)}… | ${nomiName})` : `(${nomiName})`);
  }

  /** @param {string} [shown] the sentence for the button when Vocalis answered and refused */
  function setError(shown) {
    state = 'error';
    btn.className = 'nomi-cb-btn nomi-cb-error';
    btn.innerHTML = SVG_WARN;
    btn.title = shown || 'Start Vocalis first';
    console.log('[Vocalis] → error');
  }

  // The one true audio teardown: pause + detach (aborts any MediaSource/stream
  // the element is pulling), revoke the object URL, drop both refs. Safe to call
  // from any state; every exit path MUST use this rather than inlining pieces.
  function teardownAudio() {
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

  /** @param {boolean} force long-press: bypass the server's cache and re-render */
  async function doSpeak(force) {
    if (force) {
      console.log('[Vocalis] force-regenerating — bypassing cache (long-press)');
    }

    // Health check (state='checking' so concurrent clicks are no-ops)
    state = 'checking';
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3000);
      let hResp;
      try {
        hResp = await fetch(`${SERVER}/health`, { signal: ctrl.signal });
      } finally {
        clearTimeout(tid);
      }
      if (!hResp.ok) throw new Error(`health returned ${hResp.status}`);
    } catch (err) {
      console.error('[Vocalis] health check failed:', /** @type {ErrLike} */ (err).message ?? err);
      setError();
      return;
    }

    // 1:1 chat: content is inside the message wrapper ancestor.
    // Group chat: sideInfo is a sibling of the content — walk up to find it.
    let contentEl = btn.closest('[class*="NomiChatContainer_messageWrapper"]')?.querySelector('[class*="MessageBubble_content"]');
    if (!contentEl) {
      let node = btn.parentElement;
      for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
        contentEl = node.querySelector('[class*="GroupChatMessageBubble_content"]');
        if (contentEl) break;
      }
    }
    const text = /** @type {HTMLElement|null} */ (contentEl)?.innerText?.trim();
    if (!text) {
      setIdle();
      return;
    }

    const nomiId = getNomiId(btn);
    const nomiName = getNomiName(btn);
    setGenerating(nomiName, nomiId);
    const session = new AbortController(); // doubles as the "this run is live" token
    abortCtrl = session;

    try {
      // 3.0 streaming first; falls back to 2.2 segment playback on older servers.
      if (await tryStreamSpeak(session, nomiId, nomiName, text, force)) return;
      await chunkedSpeak(session, nomiId, nomiName, text, force);
    } catch (err) {
      if (abortCtrl !== session || /** @type {ErrLike} */ (err).name === 'AbortError') return; // user stop
      console.error('[Vocalis]', err);
      session.abort();
      teardownAudio();
      setError(err instanceof Refused ? err.shown : '');
    }
  }

  // ── 3.0 streaming (server 3.x+): ONE continuous progressive stream ──────────
  // POST /speak/stream registers the request and returns a one-time stream URL;
  // the <audio> element pulls it and starts playing ~2s in, while the rest of the
  // message is still rendering server-side. Returns false if the server doesn't
  // have the endpoint yet (pre-3.0), so the caller can use segment playback.
  /**
   * @param {AbortController} session doubles as the "this run is still live" token
   * @param {string|null} nomiId
   * @param {string} nomiName
   * @param {string} text
   * @param {boolean} force
   * @returns {Promise<boolean>}
   */
  async function tryStreamSpeak(session, nomiId, nomiName, text, force) {
    const resp = await fetch(`${SERVER}/speak/stream`, {
      method: 'POST',
      headers: speakHeaders(),
      body: JSON.stringify({ nomi_id: nomiId, nomi_name: nomiName, text, force }),
      signal: session.signal,
    });
    if (resp.status === 404 || resp.status === 405) {
      console.log('[Vocalis] no /speak/stream on this server — using segment playback');
      return false;
    }
    // 🔴 A 401 is NOT a "this server is too old" signal — do not fall back to the segment
    // path on it. Both paths are gated, so the fallback would fail identically and bury the one
    // message that says how to fix it.
    if (!resp.ok) throw speakError(resp.status, await refusalReason(resp));
    const { stream_url, cached, cache_key } = await resp.json();
    if (abortCtrl !== session) return true; // stopped while registering
    console.log(`[Vocalis] streaming${cached ? ' (cached)' : ''}`, `(${cache_key.slice(0, 8)}… | ${nomiName})`);

    // nomi.ai's CSP (media-src 'self' blob: …) forbids <audio src="https://your-server…">,
    // but allows fetch() + blob: URLs. So: fetch the stream (allowed) and feed it
    // through a MediaSource (a blob: URL) — playback is still progressive.
    const t0 = performance.now();
    const media = await fetch(`${SERVER}${stream_url}`, { signal: session.signal });
    if (!media.ok) {
      // e.g. 503 while the model warms (token stays retryable server-side) —
      // the segment path has its own handling for all of these.
      console.warn(`[Vocalis] stream GET ${media.status} — falling back to segment playback`);
      return false;
    }
    const ctype = media.headers.get('Content-Type') || '';

    // WARNING: TAKES THE ELEMENT RATHER THAN CLOSING OVER IT. `audio` is nullable (it is
    // cleared between plays), so reading it through the closure is possibly-null at every use
    // even though both call sites run one line after `audio = new Audio(...)`. Passing it in
    // lets the narrowing at those call sites do the work, with no assertion anywhere.
    /** @param {HTMLAudioElement} a */
    const wireAudio = a => {
      a.addEventListener('playing', () => {
        if (abortCtrl !== session) return;
        console.log('[Vocalis] first audio in', ((performance.now() - t0) / 1000).toFixed(2), 's');
        setPlaying(cache_key, nomiName);
      });
      a.addEventListener(
        'ended',
        () => {
          if (abortCtrl !== session) return;
          teardownAudio();
          setIdle();
        },
        { once: true },
      );
      a.addEventListener(
        'error',
        e => {
          if (abortCtrl !== session || !audio) return;
          console.error('[Vocalis] stream audio error:', /** @type {HTMLAudioElement|null} */ (e.target)?.error?.message);
          session.abort(); // stop the fetch/reader → server cancels generation
          teardownAudio();
          setError();
        },
        { once: true },
      );
    };

    if (ctype.includes('audio/wav') || !window.MediaSource || !MediaSource.isTypeSupported('audio/mpeg')) {
      // Cached whole file (WAV) — or no MSE: play as a plain blob.
      const blob = await media.blob();
      if (abortCtrl !== session) return true;
      blobUrl = URL.createObjectURL(blob);
      audio = new Audio(blobUrl);
      wireAudio(audio);
      await audio.play();
      return true;
    }

    // Live progressive MP3 → MediaSource pump.
    const ms = new MediaSource();
    blobUrl = URL.createObjectURL(ms);
    audio = new Audio(blobUrl);
    wireAudio(audio);
    ms.addEventListener(
      'sourceopen',
      () => {
        const sb = ms.addSourceBuffer('audio/mpeg');
        // `Response.body` is nullable per spec (HEAD, synthesized responses); this is a live
        // GET whose Content-Type was read above, so it has one.
        const reader = /** @type {ReadableStream<Uint8Array<ArrayBuffer>>} */ (media.body).getReader();
        (async () => {
          let got = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (abortCtrl !== session) {
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
            if (abortCtrl !== session || /** @type {ErrLike} */ (err).name === 'AbortError') return;
            console.error('[Vocalis] stream pump failed:', err);
            session.abort(); // stop the fetch → server cancels generation
            teardownAudio();
            setError();
          }
        })();
      },
      { once: true },
    );
    await audio.play();
    return true;
  }

  // ── 2.2 fallback: per-segment /speak requests, sequential playback ──────────
  /**
   * @param {AbortController} session doubles as the "this run is still live" token
   * @param {string|null} nomiId
   * @param {string} nomiName
   * @param {string} text
   * @param {boolean} force
   * @returns {Promise<void>}
   */
  async function chunkedSpeak(session, nomiId, nomiName, text, force) {
    // Fire every segment's /speak NOW — the server fans them across its GPU
    // workers — then play them in order as they land.
    const segments = splitSegments(text);
    if (segments.length > 1) {
      console.log(`[Vocalis] ${segments.length} segments (${text.length} chars)`);
    }
    const t0 = performance.now();
    const fetches = segments.map(seg =>
      fetch(`${SERVER}/speak`, {
        method: 'POST',
        headers: speakHeaders(),
        body: JSON.stringify({ nomi_id: nomiId, nomi_name: nomiName, text: seg, force }),
        signal: session.signal,
      }).then(async resp => {
        if (!resp.ok) throw speakError(resp.status, await refusalReason(resp));
        return { cacheKey: resp.headers.get('X-Cache-Key') ?? '', blob: await resp.blob() };
      }),
    );
    // Failures surface via the ordered awaits below; this only silences
    // "Uncaught (in promise)" for segments never reached after an early exit.
    fetches.forEach(f => f.catch(() => {}));

    for (let i = 0; i < fetches.length; i++) {
      const { cacheKey, blob } = await fetches[i];
      if (abortCtrl !== session) return; // stopped while fetching
      console.log(
        `[Vocalis] segment ${i + 1}/${fetches.length} ready in`,
        ((performance.now() - t0) / 1000).toFixed(2),
        's',
        `(${cacheKey.slice(0, 8)}… | ${nomiName})`,
      );

      blobUrl = URL.createObjectURL(blob);
      audio = new Audio(blobUrl);
      // Captured, not read through the closure: narrowing does not survive into a callback, so
      // `audio` is possibly-null inside the Promise body however close the assignment is.
      const el = audio;
      const done = new Promise((resolve, reject) => {
        el.addEventListener('ended', resolve, { once: true });
        el.addEventListener('pause', resolve, { once: true }); // explicit stop
        el.addEventListener(
          'error',
          e => reject(new Error(/** @type {HTMLAudioElement|null} */ (e.target)?.error?.message ?? 'audio decode error')),
          { once: true },
        );
      });
      setPlaying(cacheKey, nomiName);
      await audio.play();
      await done;
      if (abortCtrl !== session) return; // stopped during playback
      teardownAudio();
    }
    setIdle();
  }

  // ── Long-press detection ───────────────────────────────────────────────────
  // Hold 600 ms: spinner starts immediately as feedback that force-regen is armed.
  // Release after spinner starts → force-regenerate (bypass cache).
  // Release before spinner starts, or mouse leaves → normal click / canceled.
  btn.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (state !== 'idle' && state !== 'error') return;
    longPressArmed = false;
    longPressHandled = false;
    pressTimer = setTimeout(() => {
      longPressArmed = true;
      setGenerating(getNomiName(btn), getNomiId(btn));
      console.log('[Vocalis] long-press armed — release to force-regenerate');
    }, LONG_PRESS_MS);
  });

  btn.addEventListener('mouseup', () => {
    clearTimeout(pressTimer ?? undefined);
    pressTimer = null;
    if (longPressArmed) {
      longPressArmed = false;
      longPressHandled = true;
      doSpeak(true);
    }
  });

  btn.addEventListener('mouseleave', () => {
    clearTimeout(pressTimer ?? undefined);
    pressTimer = null;
    if (longPressArmed) {
      longPressArmed = false;
      setIdle();
    }
  });

  // ── Click (normal play / stop) ─────────────────────────────────────────────
  btn.addEventListener('click', async () => {
    // Suppress the click that fires after a long-press mouseup
    if (longPressHandled) {
      longPressHandled = false;
      return;
    }

    if (state === 'generating') {
      abortCtrl?.abort(); // cancels the register POST / in-flight segment fetches
      abortCtrl = null; // invalidates the session token (see doSpeak's loop)
      // A 3.0 stream may already be buffering: tearing the element down (and
      // aborting the fetch above) cancels generation server-side.
      teardownAudio();
      setIdle();
      return;
    }

    if (state === 'playing') {
      // Invalidate the session FIRST: the playback loop's pause-resolve then sees
      // a dead token and exits without touching the (already cleaned) shared vars.
      abortCtrl?.abort(); // cancels any still-fetching segments
      abortCtrl = null;
      teardownAudio();
      setIdle();
      return;
    }

    if (state === 'checking') return;

    // idle / error → normal speak
    doSpeak(false);
  });

  const existingPlay = sideInfo.querySelector('button[aria-label="Play message"]');
  if (existingPlay) {
    const row = document.createElement('div');
    row.className = 'nomi-cb-row';
    existingPlay.after(row);
    row.appendChild(existingPlay);
    row.appendChild(btn);
  } else {
    sideInfo.appendChild(btn);
  }
}

function scanAndInject() {
  /** @type {NodeListOf<HTMLElement>} */ (
    document.querySelectorAll('[class*="MessageBubble_sideInfo"]:not([data-chatterbox-injected])')
  ).forEach(injectButton);
}

// ── MutationObserver ───────────────────────────────────────────────────────
const observer = new MutationObserver(scanAndInject);
observer.observe(document.body, { subtree: true, childList: true });
scanAndInject();

// ── SPA navigation ─────────────────────────────────────────────────────────
const _push = history.pushState.bind(history);
history.pushState = (...args) => {
  _push(...args);
  setTimeout(scanAndInject, 500);
};
window.addEventListener('popstate', () => setTimeout(scanAndInject, 500));
