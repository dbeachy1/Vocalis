// Runs in SillyTavern's page and uses its globals and jQuery. Here `$` is a collection selector;
// do not confuse it with the web UI helper of the same name.
// The narration-player-bar import is an ST-owned runtime dependency with a local type stub.
// Keep `VocalisExtStreamOpts` separate from the web UI's `VocalisStreamOpts` (see vocalis-stream.js).
'use strict';
/* SillyTavern extension for Vocalis streaming narration. The extension sends speaker
 * identity; Vocalis resolves the assigned voice and per-speaker settings. It uses
 * SillyTavern's `getContext()` API and page-provided jQuery/toastr globals. If stream
 * status reports an interrupted generation after playback, the user can retry. */
import {
  playStream,
  probeHealth,
  registerCharacters,
  prerender,
  cancelPrerender,
  fetchStates,
  pairPing,
  pushDocument,
  pushAvatar,
  pairPoll,
  sweepDone,
  fetchPlan,
  pushDone,
  fetchAvatar,
} from './vocalis-stream.js';
import { initializePolishSend } from './polish-send.js';
import { showNarrationPlayerBar, hideNarrationPlayerBar } from '/scripts/narration-player-bar.js';
// 6.0 — audio scenes (§3.1). Same module, same rule about byte-identical bodies.
import { estimateScene, createScene, sceneStatus, cancelScene } from './vocalis-stream.js';

const MODULE = 'vocalis';

// The deployed extension is copied into SillyTavern, and an open tab can keep an older script.
// This stamp identifies the code running in that tab; the stamping script excludes this line and
// hashes the extension files. It is independent of `tts_utils.VERSION`.
const EXT_BUILD = '7b73b7169b45';

/** Compare the extension stamp loaded by this tab with the file served from the same
 * extension URL. Report stale only when both stamps are available and differ; fetch or
 * parse failures are inconclusive and must not accuse the running tab of being stale. */
const EXT_SELF_CHECK_MS = 120000;
/** @type {'unknown'|'current'|'stale'} */
let extSelfCheck = 'unknown';
let extSelfCheckedAt = 0;

async function checkOwnBuild(now = Date.now()) {
  if (extSelfCheckedAt && now - extSelfCheckedAt < EXT_SELF_CHECK_MS) return extSelfCheck;
  extSelfCheckedAt = now;
  try {
    const url = new URL(import.meta.url);
    // Cache-busted AND `no-store`: the whole point is the bytes SillyTavern is serving right now,
    // and this is one small file on a two-minute timer, not a cost anyone pays per page load.
    url.search = `vocalis_build_check=${now}`;
    const response = await fetch(url.href, { cache: 'no-store' });
    if (!response.ok) {
      console.warn('[Vocalis] build self-check: SillyTavern answered', response.status, 'for my own file');
      return extSelfCheck;
    }
    const served = /^const EXT_BUILD = '([^']*)';/m.exec(await response.text());
    if (!served) {
      console.warn('[Vocalis] build self-check: no stamp line in the file SillyTavern served');
      return extSelfCheck;
    }
    const next = served[1] === EXT_BUILD ? 'current' : 'stale';
    if (next !== extSelfCheck) {
      console.log('[Vocalis] build self-check:', next, `(running ${EXT_BUILD}, served ${served[1]})`);
    }
    extSelfCheck = next;
  } catch (error) {
    console.warn('[Vocalis] build self-check: could not read my own file', error);
  }
  return extSelfCheck;
}
const DEFAULTS = Object.freeze({
  enabled: true,
  autoNarrate: false,
  preRender: true,
  serverUrl: '',
  // Pasted from Vocalis pairing settings. Empty means unpaired; both /pair/* and /v1/* routes fail
  // closed without this token, so narration also requires pairing.
  pairToken: '',
});

/**
 * This extension's slice of ST's `extension_settings`. The shape is `DEFAULTS` above, which is
 * what `init()` merges into it — so the five keys are always present by the time anything reads
 * them, and none of them is optional.
 * @typedef {object} VocalisStSettings
 * @property {boolean} enabled
 * @property {boolean} autoNarrate
 * @property {boolean} preRender
 * @property {string} serverUrl
 * @property {Record<string, string>} [voiceMap] - PRE-M4b client-side map, deleted by init()
 * @property {string} [defaultVoice] - likewise; voices are assigned server-side since M4b
 * @property {string} pairToken - empty means UNPAIRED, which is the correct default; /pair/* and
 *    (since 7.0-m6) /v1/* both fail closed rather than waving a blank token through.
 */

/** @type {VocalisStSettings} */
let settings; // live reference inside extension_settings
/** @type {() => void} */
let saveSettings; // context.saveSettingsDebounced, captured at init
/** @type {{ refresh: () => Promise<any>, onRendered: () => void }|null} */
let polishRuntime = null;
/** @type {{ handle: VocalisStreamHandle, mesId: number, audio?: HTMLAudioElement }|null} */
let current = null; // { handle, mesId } — the one active playback
let lastHandled = ''; // dedup guard: RENDERED can re-fire for one message
/** @type {Map<number, { raw: string, text: string }>} */
const cleaned = new Map(); // mesId -> { raw, text } — see messageText()
/** @type {Map<number, string>} */
const preKeys = new Map(); // mesId -> cache_key of a pre-render we asked for

const ctx = () => SillyTavern.getContext();

// ── text cleaning ──────────────────────────────────────────────────────────────
// chat[i].mes is raw markdown. Same approach as ST's built-in TTS extension
// (there is no shared helper): macros in, then strip the unspeakable parts.
// Asterisks are deliberately NOT touched here: *action* handling is the
// SERVER's narrate_actions filter (default: spoken, markup stripped there) —
// pre-stripping client-side would blind it.
// Line breaks are KEPT, for the same reason: the server takes a line with no words in it
// ("***", "---") out as a scene break, and ends a heading that sits in a paragraph of its own
// as a sentence. Flattened to one line, "0900 the next morning" ran straight into the paragraph
// after it. (Doug, 2026-10-12; tts_utils.drop_unspeakable_markup has the measurements.)
/**
 * @param {string} raw
 */
function cleanText(raw) {
  let t = ctx().substituteParams(raw || '');
  t = t
    .replace(/```[\s\S]*?```/g, '') // code fences
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/!\[.*?\]\([^)]*\)/g, '') // embedded images
    .replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, '') // html tag pairs + contents
    .replace(/<[^>]*>/g, '') // stray tags
    .replace(/[^\S\n]+/g, ' ') // runs of spaces and tabs
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n') // at most one blank line
    .trim();
  return t;
}

// 🔴 Clean each message ONCE and remember it. cleanText() runs substituteParams,
// and {{random}} / {{roll}} / {{time}} are non-deterministic: clean the same message
// twice and you can get two different strings, two different cache keys, and a
// pre-render that can never be claimed. Nothing would report that — the audio would
// simply render twice, for every message, forever. Keyed on the RAW text so editing
// a message invalidates the memo. (DESIGN_5_2_PRERENDER §3.2)
/**
 * @param {number} mesId
 */
function messageText(mesId) {
  const msg = ctx().chat[mesId];
  if (!msg) return '';
  const memo = cleaned.get(mesId);
  if (memo && memo.raw === msg.mes) return memo.text;
  const text = cleanText(msg.mes);
  cleaned.set(mesId, { raw: msg.mes, text });
  return text;
}

// ── pre-render ─────────────────────────────────────────────────────────────────
// Speculation: tell the server about a message the moment it exists, so that when
// the user gets round to clicking ▶ the audio is already rendered. The server does
// the throttling — it only starts when the box has nothing real to do, and a click
// for other text preempts it. All of it is fire-and-forget: a pre-render that
// doesn't happen costs the user nothing but the latency they have today.

// 🔴 ONE body shape for all three routes. /v1/audio/stream, /v1/audio/prerender and
// /v1/audio/state must derive the same cache key from the same message, and the server can
// only do that if it is handed the same bytes: a probe that differs by one field describes an
// entry nothing will ever look up, so the button reads orange and the click renders anyway —
// no error, no log. Returns null for a message with nothing speakable in it.
/** Return the exact persona avatar filename SillyTavern persisted on a user message.
 *
 * `sendMessageAsUser()` stores `getThumbnailUrl('persona', avatar)` in `force_avatar`, whose
 * stable contract is `/thumbnail?type=persona&file=<encoded filename>`. The filename — not the
 * display name — is the persona identity Character Voices uses to keep duplicate names apart.
 * An unrecognized URL deliberately yields no avatar so old/forked clients keep their historical
 * name-only fallback instead of binding a message to the wrong persona.
 * @param {Record<string, any>} msg
 */
function personaAvatarForMessage(msg) {
  if (!msg || !msg.is_user || !msg.force_avatar) return '';
  try {
    const page = new URL(window.location.href);
    const url = new URL(String(msg.force_avatar), page);
    if (url.origin !== page.origin || url.pathname !== '/thumbnail' || url.searchParams.get('type') !== 'persona') {
      return '';
    }
    return String(url.searchParams.get('file') || '');
  } catch {
    return '';
  }
}

/**
 * @param {number} mesId
 */
function bodyFor(mesId) {
  const c = ctx();
  const msg = c.chat[mesId];
  if (!msg || msg.is_system) return null;
  const text = messageText(mesId);
  // 🔴 NOTHING TO SPEAK MEANS NO LETTER AND NO DIGIT, NOT "EMPTY". The server refuses such text with
  // a 400 ("no speakable text"): a reply that is only "...", "?!", an emoji or a "---" rule. Asked
  // anyway, that 400 looked like a lost connection to "Preload from here on" (five retries, then
  // "Could not reach Vocalis" and nothing after that message was ever preloaded) and stopped an
  // autoplay walk at that message with a red toast. So the question is answered here, with the
  // server's own rule (`_HAS_WORDS` in tts_utils.py), and every caller skips the message the way
  // it already skips an empty one. (2026-10-12, found in review of the scene-break fix, which is
  // what made the server refuse "..." where it used to hand it to the model.)
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return null;
  // 🔴 7.0-m5b — `character_avatar` IS PART OF THE ONE BODY SHAPE, deliberately, so all three
  // routes derive the same cache key, and distinct avatars remain distinct even when names match.
  //
  // ⚠️ GROUP CHATS ARE BEST-EFFORT AND SAY SO. `original_avatar` is what ST stamps on a group
  // message, and it is exact when present. A solo chat resolves from the selected card, which is
  // exact by construction. What is NOT attempted is matching a group member BY NAME — that is
  // the very bug this fixes, and a wrong avatar is worse than none: none falls back to the name
  // and behaves as it always has, while a wrong avatar can bind a voice to another character.
  let avatar = personaAvatarForMessage(msg);
  if (!avatar) avatar = String(msg.original_avatar || '');
  if (!avatar && !c.groupId && !msg.is_user) {
    const me = (c.characters || [])[Number(c.characterId ?? -1)];
    if (me && me.avatar && !msg.is_user) avatar = String(me.avatar);
  }
  return { input: text, character: msg.name || '', character_avatar: avatar };
}

// `force` bypasses the conservative guards used by automatic pre-rendering when the user requests
// a specific message.
// 🔴 IT BYPASSES THE TWO GUARDS THAT MAKE THE AUTOMATIC PATH CONSERVATIVE, AND ONLY THOSE.
// `settings.preRender` is "speculate on new messages for me"; a man pressing a menu item has
// already decided. `is_user` is "his own lines are rarely clicked", which is an argument about
// what to GUESS at and says nothing about what he just asked for. `settings.enabled` and a
// server URL still hold — without them there is nothing to ask.
//
// ⚠️ It cannot interrupt anything, and that is the server's doing rather than a promise made
// here: `PrerenderQueue.submit` appends to a FIFO behind whatever is running (`prerender.py`),
// so this is a queue entry and never a preemption.
/**
 * @param {number} mesId
 * @param {Record<string, unknown>} [opts]
 */
function prerenderMessage(mesId, opts) {
  const force = !!(opts && opts.force);
  if (!settings.enabled || !settings.serverUrl) return;
  if (!force && !settings.preRender) return;
  const msg = ctx().chat[mesId];
  if (!msg || (msg.is_user && !force)) return; // AI replies only: the user's
  const body = bodyFor(mesId); // own lines are rarely clicked
  if (!body) return;
  prerender(settings.serverUrl, body, settings.pairToken)
    .then(r => {
      if (r && r.cache_key) preKeys.set(mesId, r.cache_key);
      // The state it comes back with is free and current — take it rather than
      // waiting for the next poll to discover the same thing.
      if (r && r.state) applyState(mesId, r.state === 'declined' ? 'none' : r.state);
    })
    .catch(() => {});
}

/** ⬇ Preload, from the shift-click menu — 7.4 §18.
 *
 * 🔴 IT SAYS WHAT HAPPENED, because the honest outcomes are not all "yes". The server answers
 * `cached` (there already), `queued`/`rendering`/`playable` (on its way) or `declined` (the queue
 * is full, or pre-rendering is switched off server-side), and the button's color only
 * distinguishes the first two. A menu item that silently does nothing on `declined` is the dead control this extension has
 * a comment about in three other places.

 * @param {number} mesId
 */
function preloadMessage(mesId) {
  if (!settings.enabled || !settings.serverUrl) {
    toastr.warning('Set the server URL in the Vocalis TTS settings first.', 'Vocalis');
    return;
  }
  const body = bodyFor(mesId);
  if (!body) {
    toastr.info('There is nothing speakable in that message.', 'Vocalis');
    return;
  }
  prerender(settings.serverUrl, body, settings.pairToken)
    .then(r => {
      const state = r && r.state;
      if (r && r.cache_key) preKeys.set(mesId, r.cache_key);
      if (state) applyState(mesId, state === 'declined' ? 'none' : state);
      if (state === 'cached') toastr.success('Already rendered — it will play instantly.', 'Vocalis');
      else if (state === 'declined')
        toastr.warning('Vocalis declined it — the pre-render queue is full, or pre-rendering is off on the server.', 'Vocalis');
      else toastr.info('Preloading… the speaker turns green when it is ready.', 'Vocalis');
    })
    .catch(() => toastr.error('Could not reach Vocalis.', 'Vocalis'));
}

// ── §18b: autoplay from here on ────────────────────────────────────────────────
//
// 🔴 NOT THE SAME THING AS THE `autoNarrate` CHECKBOX, which is why it is a menu item on a
// MESSAGE. That setting is temporal — "speak new replies as they arrive" — and knows nothing
// about where the user is in the chat. This is positional: start at the selected message, walk
// forward through what is already there, and keep going into new replies when it reaches the end.
// One control covers both readings of "from here on", which is the honest way to resolve the
// ambiguity rather than picking one and being wrong half the time.
//
// Automatic playback remains limited to character messages, matching `autoNarrate` and pre-render.
// A direct click may still play the selected message.
let autoChain = false;

/**
 * @param {number} mesId
 */
function autoplayable(mesId) {
  const msg = ctx().chat[mesId];
  return !!msg && !msg.is_user && !msg.is_system && !!bodyFor(mesId);
}

/**
 * @param {number} after
 */
function nextAutoplay(after) {
  const chat = ctx().chat || [];
  for (let i = after + 1; i < chat.length; i++) if (autoplayable(i)) return i;
  return -1;
}

/**
 * @param {number} mesId
 */
function startAutoplay(mesId) {
  autoChain = true;
  paintAutoplayRail();
  const id = autoplayable(mesId) ? mesId : nextAutoplay(mesId - 1);
  if (id < 0) {
    toastr.info('Nothing to play from there — autoplay is armed for the next reply.', 'Vocalis');
    return;
  }
  narrateMessage(id);
}

/** 🔴 EVERY WAY OUT IS THIS ONE FUNCTION. A mode with no visible off switch is a trap, and a mode
 *  that only some of the stop paths clear is worse: pressing ⏹ would fall silent for four seconds
 *  and then start the next message, which reads as the button not working. */
function stopAutoplay() {
  if (!autoChain) return;
  autoChain = false;
  paintAutoplayRail();
}

/** The chain's only visible state: the messages it will read are marked. Without it "autoplay is
 *  on" is a fact he has to remember, and the only evidence is audio that starts by itself. */
function paintAutoplayRail() {
  $('#chat .mes').toggleClass('vocalis_autoplay', false);
  if (!autoChain) return;
  const from = current ? current.mesId : -1;
  $('#chat .mes').each(function () {
    const id = Number($(this).attr('mesid'));
    if (!Number.isNaN(id) && id >= from) $(this).toggleClass('vocalis_autoplay', true);
  });
}

// ── 9.5.10 §18d: preload from here on ────────────────────────────────
//
// 🔴 THE PACING IS THE FEATURE, AND IT IS DONE AGAINST THE SERVER'S OWN ANSWER. The queue holds
// four waiting jobs plus one running (`prerender.py` MAX_QUEUE), so firing thirty POSTs at it gets
// five accepted and twenty-five `declined` — a "preload the rest of the chat" that silently
// preloads five messages and stops. This walks the chat ONE submit at a time and treats `declined`
// as back-pressure rather than as a refusal: wait, ask again, and never advance past a message
// that was not taken. The server keeps the bound it already had; nothing there changes.
//
// 🔴 AND `declined` HAS TWO MEANINGS, WHICH `queued` SPLITS. `submit` declines when the queue is
// full OR when pre-rendering is switched off server-side, and those want opposite responses: the
// first is "wait, it frees up", the second is "nothing you send will ever be accepted". The queue
// is only ever full AT MAX_QUEUE, so `declined` alongside an EMPTY queue can only be the switch —
// and the chain stops and says so instead of polling a server that has already said no, forever.
//
// ⚠️ IT STAYS ARMED AT THE END OF THE CHAT, for the reason §18b's chain does: "from here on" reads
// both ways at once. The temporal half is the "Pre-render new messages" checkbox — which is OFF
// for anyone who needs this row, because that is what leaves a chat full of orange — so a chain
// that quietly expired at the newest message would answer only half of what was asked. A new
// reply is picked up in `onCharacterMessageRendered`.
const PRELOAD_RETRY_MS = 4000; // the queue is full: how long before asking it again
const PRELOAD_MAX_FAILS = 5; // consecutive transport failures before the chain calls it a dead server

/** @type {{ next: number, done: number, fails: number, inflight: boolean, timer: ReturnType<typeof setTimeout>|null }|null} */
let preChain = null;

/** The same question `autoplayable` asks — "would the automatic path speak this?" — plus the one
 *  thing that makes a submit pointless. A chat whose older half is already rendered would
 *  otherwise be a round trip per message to be told `cached` a hundred times; the color we were
 *  last told is the cheap oracle for that, and a stale one costs a submit, never a wrong render.
 * @param {number} mesId
 */
function preloadWanted(mesId) {
  return autoplayable(mesId) && states.get(mesId) !== 'cached';
}

/** What the chain still has to send — counted from `chat`, NOT from the DOM, because SillyTavern
 *  paints a window and most of the run is scrolled out of it. This is the number on the menu row,
 *  which is the only place the mode is visible. */
function preloadRemaining() {
  if (!preChain) return 0;
  const chat = ctx().chat || [];
  let n = 0;
  for (let i = preChain.next; i < chat.length; i++) if (preloadWanted(i)) n++;
  return n;
}

/**
 * @param {number} mesId
 */
function startPreloadChain(mesId) {
  if (!settings.enabled || !settings.serverUrl) {
    toastr.warning('Set the server URL in the Vocalis TTS settings first.', 'Vocalis');
    return;
  }
  stopPreloadChain(true); // a second "from here on" re-anchors rather than running two walks
  preChain = { next: mesId, done: 0, fails: 0, inflight: false, timer: null };
  const n = preloadRemaining();
  toastr.info(
    n
      ? `Preloading ${n} message${n === 1 ? '' : 's'} from here — each speaker turns green as it lands.`
      : 'Nothing left to preload from there — armed for the next reply.',
    'Vocalis',
  );
  pumpPreload();
}

/** 🔴 EVERY WAY OUT IS THIS ONE FUNCTION — §18b's rule, for the same reason. A mode with two
 *  half-stops is one that keeps submitting after he pressed the thing that says Stop.
 * @param {boolean} [quiet] the chat changed, or a delete moved every index: the mode is over, but
 *                          he did not end it and a toast about it would be noise on top of that.
 */
function stopPreloadChain(quiet) {
  if (!preChain) return;
  clearTimeout(preChain.timer ?? undefined);
  const done = preChain.done;
  preChain = null;
  if (!quiet) toastr.info(done ? `Preloading stopped — ${done} sent.` : 'Preloading stopped.', 'Vocalis');
}

/** One submit, then the next when the server has answered. Never two in flight: the whole point is
 *  to hand the queue exactly as much as it will take, and no more. */
function pumpPreload() {
  const chain = preChain;
  if (!chain || chain.inflight) return;
  clearTimeout(chain.timer ?? undefined);
  chain.timer = null;
  const chat = ctx().chat || [];
  let id = chain.next;
  while (id < chat.length && !preloadWanted(id)) id++;
  chain.next = id;
  if (id >= chat.length) return; // the end of the chat, still armed — a new reply wakes it
  const body = bodyFor(id);
  if (!body) {
    // Belt and braces: `preloadWanted` already demanded one, so this is a message whose text
    // changed under the walk. Step over it rather than stalling the whole run on it.
    chain.next = id + 1;
    pumpPreload();
    return;
  }
  chain.inflight = true;
  prerender(settings.serverUrl, body, settings.pairToken)
    .then(r => {
      // ⚠️ The chain that started this request may have been stopped or re-anchored while it was
      // on the wire. Advancing `preChain` from here would step the NEW walk past a message it
      // never sent, which is the one failure this feature cannot have: a silent hole in the run.
      if (chain !== preChain) return;
      chain.inflight = false;
      const state = r && r.state;
      if (r && r.cache_key) preKeys.set(id, r.cache_key);
      if (state) applyState(id, state === 'declined' ? 'none' : state);
      if (state !== 'declined') {
        chain.fails = 0;
        chain.done++;
        chain.next = id + 1;
        pumpPreload();
        return;
      }
      // 🔴 `-1` IS "THE SERVER DID NOT SAY", AND IT IS NOT ZERO. Only an explicit 0 proves the
      // decline was the switch rather than a full queue; a response without the field at all is a
      // server this client cannot interrogate, and reading that as "disabled" would end the run on
      // a box that was merely busy.
      const depth = r && typeof r.queued === 'number' ? r.queued : -1;
      if (depth === 0) {
        stopPreloadChain(true);
        toastr.warning('Vocalis is not pre-rendering — switch it on there, then start this again.', 'Vocalis');
        return;
      }
      chain.timer = setTimeout(pumpPreload, PRELOAD_RETRY_MS);
    })
    .catch(() => {
      if (chain !== preChain) return;
      chain.inflight = false;
      // 🔴 A DEAD SERVER MUST NOT BECOME A REQUEST EVERY FOUR SECONDS FOR THE REST OF THE SESSION.
      // One failure is a transient — a timeout, a 401 while the vault re-locks — and is worth
      // retrying; a run of them is the server being gone, and the chain says so and ends. Same
      // argument as the probe latch further down this file, with the opposite conclusion, because
      // this one SENDS rather than reads.
      chain.fails++;
      if (chain.fails >= PRELOAD_MAX_FAILS) {
        stopPreloadChain(true);
        toastr.error('Could not reach Vocalis — preloading stopped.', 'Vocalis');
        return;
      }
      chain.timer = setTimeout(pumpPreload, PRELOAD_RETRY_MS);
    });
}

// Returns a promise so a caller can re-probe AFTER the server has actually stood the job
// down — re-asking while the cancel is still on the wire gets the pre-cancel answer back.
/**
 * @param {number} mesId
 */
function cancelPrerenderFor(mesId) {
  const key = preKeys.get(mesId);
  if (!key || !settings.serverUrl) return Promise.resolve();
  preKeys.delete(mesId);
  return cancelPrerender(settings.serverUrl, { cache_key: key }, settings.pairToken).catch(() => {});
}

// 🔴 RETURNS THE STAND-DOWN, because `onChatChanged` has to queue work BEHIND it — see §18f.
// `PrerenderQueue.cancel(None)` takes the whole queue AND the running job (prerender.py), so
// anything submitted while this is still on the wire can be swept away by it.
function cancelAllPrerenders() {
  const had = preKeys.size;
  preKeys.clear();
  cleaned.clear();
  if (had && settings.serverUrl) {
    return cancelPrerender(settings.serverUrl, { all: true }, settings.pairToken).catch(() => {});
  }
  return Promise.resolve();
}

// ── what the button knows (5.4) ────────────────────────────────────────────────
// The button carries two independent things: its COLOR is what the server has for that
// message, its GLYPH is playback. Orange nothing, yellow pre-rendering, blue past the buffer
// governor (playing now plays through), green cached. DESIGN_5_4_BUTTON_STATE.

const SWEEP_DEBOUNCE_MS = 250; // collapses a chat load's 100 messages into one request
const POLL_MS = 1000; // only while something on screen is still moving

/** @type {Record<string, string>} */
const CLASS_FOR = {
  // orange is the ABSENCE of a class — see style.css
  cached: 'vocalis_cached', // green
  playable: 'vocalis_ready', // blue
  rendering: 'vocalis_pending', // yellow
  queued: 'vocalis_pending', // yellow
};
const ALL_CLASSES = 'vocalis_pending vocalis_ready vocalis_cached';
const ACTIVE = ['queued', 'rendering', 'playable']; // states that can still change on their own

// 🔴 9.0.16 — THE SERVER HAD TWO WORDS FOR ONE CONDITION AND THIS TABLE ONLY EVER KNEW ONE.
//
// `/v1/audio/state` answers `rendering`/`playable`; `/v1/audio/prerender` answered `running`,
// straight out of `PrerenderQueue.submit`, whenever the message it was asked to speculate on was
// ALREADY the job on the card. `prerenderMessage` handed that to `applyState`, and every branch
// below then did the wrong thing at once: `CLASS_FOR['running']` is undefined so the button was
// painted ORANGE, `ACTIVE` does not list it so the 1 s poll never armed, and `states` recorded it
// so the sweep's reconcile skipped it forever. The render finished and cached normally — hence a
// gray button over audio that plays instantly, and hence "flaky", because you only get `running`
// back when the POST lands inside the render it is asking about.
//
// 📌 THE ROUTE IS FIXED TOO (vocalis_stream_http.py: `running` → `state_of`, which splits it by
// the buffer governor). This alias is the half that protects an extension copy talking to a
// server that has not been updated — the two ends of this wire are installed separately.
/** @type {Record<string, string>} */
const STATE_ALIAS = { running: 'rendering' };

// 🔴 AND THE REAL LESSON IS THE HANDLING, NOT THE WORD. An unrecognized state used to be
// recorded as a TERMINAL one, which is the worst of the available options: it silences the
// poll AND the sweep, so nothing is left that would ever correct it. Anything not on this list
// is treated as "we do not know yet" — see `applyState`.
const KNOWN_STATES = ['none', 'cached', 'playable', 'rendering', 'queued'];

const states = new Map(); // mesId -> state, absent = never probed
/** @type {ReturnType<typeof setTimeout>|null} */
let sweepTimer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let pollTimer = null;
// One failed probe stops the polling. Otherwise a server that is down — or a vault that is
// LOCKED, which 401s every /v1/* — means the whole visible chat is re-requested every second
// for as long as the tab is open. Cleared by a chat change, a settings edit, or a green Test.
//
// 🔴 8.1 — IT WAS A LATCH, AND THAT IS THE "SOMETIMES YELLOW NEVER GOES GREEN" BUG.
//
// Yellow means "rendering, not far enough along to stream" and it is only ever LEFT by asking
// again. `runProbe`'s catch set this flag on ONE failed request and nothing but a chat change, a
// settings edit or the Test button ever cleared it — so a single transient (a timeout, a 500, a
// 401 while the vault re-locked for a moment) permanently stopped every color on screen from
// advancing. The render carried on and finished; nothing was left that would ever ask. Pressing
// play still worked, because playback does not go through here: the audio was ready while the
// button still disagreed.
//
// 📌 THE PROTECTION WAS REAL AND IS KEPT. Re-requesting the whole visible chat every second
// against a server that is down is the thing the flag exists to prevent. What was wrong was that
// "stop asking for a bit" was implemented as "stop asking". So: back off, and recover.
const PROBE_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];
let probeStopped = false;
let probeFailures = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
let probeRetry = null;

function probeFailed() {
  probeStopped = true;
  const wait = PROBE_BACKOFF_MS[Math.min(probeFailures, PROBE_BACKOFF_MS.length - 1)];
  probeFailures++;
  clearTimeout(probeRetry ?? undefined);
  // ⚠️ The timer is the ONLY thing that clears the flag on its own, and it must survive the
  // failure that armed it — hence `clearTimeout` first rather than an `if (probeRetry) return`,
  // which would let the first (shortest) backoff win forever.
  probeRetry = setTimeout(() => {
    probeRetry = null;
    probeStopped = false;
    scheduleSweep();
  }, wait);
}

function probeSucceeded() {
  probeFailures = 0;
}

function probeResume() {
  clearTimeout(probeRetry ?? undefined);
  probeRetry = null;
  probeStopped = false;
  probeFailures = 0;
  scheduleSweep();
}

/**
 * @param {string} state
 * @param {string} [detail]
 */
function titleFor(state, detail) {
  const base = 'Vocalis: play this message';
  const hold = ' (hold to re-render)';
  if (state === 'cached') return `${base} — cached, plays instantly${hold}`;
  if (state === 'playable') return `${base} — pre-rendering, far enough along to play` + ' (hold to cancel)';
  if (state === 'rendering') return `${base} — pre-rendering${detail ? `, ${detail}` : ''}` + ' (hold to cancel)';
  if (state === 'queued') return `${base} — queued to pre-render${detail ? ` (${detail})` : ''}` + ' (hold to cancel)';
  return base + hold;
}

/**
 * @param {number} mesId
 * @param {string} state
 * @param {string} [detail]
 */
function paint(mesId, state, detail) {
  const b = btn(mesId);
  if (!b.length) return;
  b.removeClass(ALL_CLASSES);
  if (CLASS_FOR[state]) b.addClass(CLASS_FOR[state]);
  b.attr('title', titleFor(state, detail));
  // 🔴 7.4 §18c — AND THE GLYPH, WHICH IS A DIFFERENT AXIS WITH A DIFFERENT SOURCE OF TRUTH.
  //
  // GREEN speaker is the whole diagnosis in two words. This function had just run — that is
  // where the green comes from — on a button element that was created after playback started,
  // so its glyph was never `fa-stop`. The color is reconciled from `states` on every repaint;
  // the glyph was written once, by `setBtnState`, onto an element that no longer exists.
  //
  // ⚠️ THE SWEEP'S RECONCILE IS NOT ENOUGH ON ITS OWN, and this is why the fix lives here as
  // well. That one fires on a `#chat` childList mutation, and a re-render that replaces the
  // buttons INSIDE an existing row mutates nothing this extension observes — but it is always
  // followed by a repaint, because every color the button wears comes through this line.
  // Reasserting here means the glyph is restored in the same turn as the color rather than
  // at the mercy of a mutation that may not come.
  //
  // 📌 It is `current`, not a class test: "is this the message making sound" is a fact about
  // the audio handle, and a button that has just been rebuilt is precisely the case where the
  // DOM cannot answer it.
  if (current && current.mesId === mesId) setBtnState(mesId, 'playing');
}

// 🔴 Arming the poll lives HERE, not at the call sites, because this is the one place every
// state change goes through — the batched probe, the poll itself, and `prerenderMessage`'s own
// response. It used to be armed only at the end of `runProbe`, and a new AI reply never goes
// through `runProbe`: `CHARACTER_MESSAGE_RENDERED` calls `prerenderMessage`, whose 202 comes
// back with `queued` in a few milliseconds and paints the button yellow directly. Nothing then
// polled it. The button sat yellow through a full 122-second satellite render and never went
// blue or green — while a hard refresh showed green immediately, because that path is
// `CHAT_LOADED` → sweep → `runProbe`, which did arm it. §14a.
/**
 * @param {number} mesId
 * @param {string} state
 * @param {string} [detail]
 */
function applyState(mesId, state, detail) {
  const s = STATE_ALIAS[state] || state;
  if (!KNOWN_STATES.includes(s)) {
    // A word this file has no color for is a QUESTION, not an answer. Painting from it would
    // assert orange ("nothing here") on no evidence, and recording it would drop the message
    // out of both the poll and the sweep's reconcile — the exact freeze described above. So:
    // leave the button wearing what it has, remember nothing, and make the sweep ask again
    // through the one route whose vocabulary is authoritative.
    states.delete(mesId);
    scheduleSweep();
    return;
  }
  states.set(mesId, s);
  paint(mesId, s, detail);
  if (ACTIVE.includes(s)) schedulePoll();
}

/**
 * @param {number} mesId
 */
function forgetState(mesId) {
  states.delete(mesId);
  paint(mesId, 'none');
}

function forgetAllStates() {
  states.clear();
  $('#chat .vocalis_narrate').removeClass(ALL_CLASSES).attr('title', titleFor('none'));
}

// Every `.mes` currently in the DOM, newest first. SillyTavern does NOT hold the whole chat
// on screen: `printMessages` paints `power_user.chat_truncation` messages (100 by default) and
// each "Show more messages" prepends another batch — so this is the set the user can actually
// see, and it grows as they scroll back. Newest first because the bottom of the viewport is
// where they are looking; on a long scrollback nobody is waiting for the message 4,800 rows up.
function domMesIds() {
  /** @type {number[]} */
  const ids = [];
  $('#chat .mes').each(function () {
    const id = Number($(this).attr('mesid'));
    if (!Number.isNaN(id)) ids.push(id);
  });
  return ids.sort((a, b) => b - a);
}

/**
 * @param {number[]} ids
 */
async function runProbe(ids) {
  if (probeStopped || !settings.enabled || !settings.serverUrl) return;
  // 🔴 "Nothing to ASK about" is not "nothing is MOVING". These two returns used to be bare,
  // and that is what made the bug above unrecoverable: the sweep filters to messages with no
  // state yet, so once `prerenderMessage` had painted the only new message yellow the sweep's
  // list was empty, `runProbe` returned before its `schedulePoll()`, and the last path that
  // could have started the poll silently didn't. Re-arm on every exit — `schedulePoll` is
  // already a no-op when nothing on screen is active, so an idle chat still makes no traffic.
  if (!ids.length) {
    schedulePoll();
    return;
  }
  const bodies = [];
  /** @type {number[]} */
  const asked = [];
  for (const id of ids) {
    const body = bodyFor(id);
    if (!body) {
      applyState(id, 'none');
      continue;
    } // system message, or nothing speakable
    bodies.push(body);
    asked.push(id);
  }
  if (!bodies.length) {
    schedulePoll();
    return;
  }
  let got;
  try {
    got = await fetchStates(
      settings.serverUrl,
      bodies, // chunks to the server's cap
      settings.pairToken,
    );
  } catch (e) {
    probeFailed(); // back off and RECOVER — see the note on probeStopped
    return;
  }
  probeSucceeded();
  got.forEach((s, i) => {
    const mesId = asked[i];
    applyState(mesId, s.state, s.detail);
    // Remember the key only while it names something CANCELLABLE. Filling preKeys from
    // every probe would have swipe-cancel firing at keys nothing ever queued.
    if (s.cache_key && ACTIVE.includes(s.state)) preKeys.set(mesId, s.cache_key);
  });
  schedulePoll();
}

// Probe what has no color yet. Idempotent and debounced, so the four render events can all
// call it without coordinating: a chat load, a scroll-back batch and a new reply landing in
// the same 250 ms become one request.
function scheduleSweep() {
  if (probeStopped || !settings.enabled || !settings.serverUrl) return;
  clearTimeout(sweepTimer ?? undefined);
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    // 🔴 `states.has(id)` used to mean "this button is already colored". The fork's chat
    // windowing broke that: messages now leave the DOM when
    // you scroll away, and the row that comes back is a NEW element wearing no class at
    // all. We still remembered its state, so it was filtered out of the probe and stayed
    // orange — a message we KNEW was cached, going gray the moment it left the window and
    // came back. Their handoff put it exactly right: reconcile, do not re-scan and diff.
    //
    // Repainting from memory is free and needs no request, so it happens first; only
    // genuinely unknown messages cost a probe.
    // ⚠️ 8.1: RECONCILE AGAINST WHAT THE CLASS SHOULD BE, NOT AGAINST "has any class".
    // The old test repainted only a button wearing NO color, which covers the case it was
    // written for (a row that left the DOM and came back bare) and misses the one where the
    // button is wearing the WRONG color — a yellow left over from a pre-render that has
    // since finished, say. `states` is the source of truth for this axis, so the honest
    // question is "does the element match it", and a repaint that already matches is a
    // no-op anyway.
    // 🔴 8.1 — AND A REMEMBERED *ACTIVE* STATE IS NOT KNOWLEDGE, IT IS A STALE GUESS.
    //
    // `queued`, `rendering` and
    // `playable` are the three states that change BY THEMSELVES, on the server, with nothing
    // here told about it — that is what `schedulePoll` exists for, and it only polls messages
    // that are on screen. So a yellow message that scrolls out of the window while its render
    // finishes drops out of the poll; when the user scrolls back, this loop found it in
    // `states`, repainted it yellow FROM MEMORY, and never asked again. It stayed yellow over
    // a finished, cached song for as long as the tab was open.
    //
    // ⚠️ Terminal states are still free. `cached` and `none` cannot change on their own — only
    // an edit, a swipe or a regenerate changes them, and each of those forgets the state
    // itself — so they are repainted from memory and cost nothing, which is what keeps a
    // 2,000-message chat load to one request.
    const ask = [];
    for (const id of domMesIds()) {
      if (!states.has(id)) {
        ask.push(id);
        continue;
      }
      const state = states.get(id);
      if (ACTIVE.includes(state)) ask.push(id); // re-ask: it may have finished off-screen
      // …and the row gets a button before the color is reconciled onto it, because a row with
      // no button used to be skipped here and never looked at again — see `ensureBtn`.
      const b = ensureBtn(id);
      if (!b.length) continue;
      const want = CLASS_FOR[state] || '';
      const has = ['vocalis_pending', 'vocalis_ready', 'vocalis_cached'].find(c => b.hasClass(c)) || '';
      if (has !== want) paint(id, state); // repainted from what we already know
    }
    // 6.0 §2.3: the rail rides the same reconciliation as the color, and for the same
    // reason — a row that left the window and came back is a NEW element wearing no class,
    // so a selection that spans it would visibly lose its left rail on a scroll.
    paintRangeRails();
    // 🔴 7.4 §18c — AND SO DOES THE GLYPH, WHICH IS THE HALF NOBODY RECONCILED.
    //
    // The fork's chat windowing removes rows from the DOM when they leave the viewport, and
    // windowing removes a row from the DOM when it leaves the viewport, and the row that
    // comes back is a NEW element built from `#message_template` — wearing `fa-volume-high`,
    // because `setBtnState` painted an element that no longer exists.
    //
    // The COLOR was reconciled here from `states` and the RAIL from `range`; the only axis
    // with no line was the one whose truth lives in `current`. Three axes, two reconciled; the
    // missing one is the control that means "stop".
    //
    // ⚠️ One button, unconditionally, rather than a hasClass test first: `toggleClass` on a
    // button that is already correct is a no-op, and the alternative is a condition that has
    // to stay in step with `setBtnState`'s three-class shape.
    if (current) setBtnState(current.mesId, 'playing');
    paintAutoplayRail();
    runProbe(ask);
  }, SWEEP_DEBOUNCE_MS);
}

// Re-ask about the messages that can still change by themselves. When everything on screen is
// terminal — green or orange — this stops dead: a chat that is not rendering makes no traffic.
function schedulePoll() {
  if (pollTimer || probeStopped) return;
  if (!domMesIds().some(id => ACTIVE.includes(states.get(id)))) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    // ⚠️ Recomputed HERE, at fire time, not captured when the timer was set. It used to
    // close over the list, which was safe only while the sole caller was the tail of
    // `runProbe`. Now that any `applyState` can arm it — including one inside a probe's
    // own forEach, before the rest of the batch has been recorded — a captured list would
    // freeze a partial view of the screen for that cycle and drop messages out of the poll.
    runProbe(domMesIds().filter(id => ACTIVE.includes(states.get(id))));
  }, POLL_MS);
}

// ── playback ───────────────────────────────────────────────────────────────────
/**
 * @param {number} mesId
 */
function btn(mesId) {
  return $(`#chat .mes[mesid="${mesId}"] .vocalis_narrate`);
}

/** Return the narrate button for `mesId`, adding one if the row lacks it. This
 * idempotent fallback covers rows not cloned from the primed message template.
 * @param {number} mesId
 */
function ensureBtn(mesId) {
  const existing = btn(mesId);
  if (existing.length) return existing;
  // ⚠️ No `.first()` — the row has exactly one slot, and `prepend` on the set is the same call
  // `injectButtons` always made. (It is also the half of jQuery the DOM shim implements.)
  const slot = $(`#chat .mes[mesid="${mesId}"] .extraMesButtons`);
  if (slot.length) slot.prepend(NARRATE_BTN);
  return btn(mesId);
}

// ── 9.1 §1: which message is loaded, visible from across the page ───────────────
//
// The stop square is one 1.25em glyph in a strip of eight identical 1.25em glyphs, so finding it
// means reading each row rather than scanning past it — and users may scroll quickly
// through a chat he has just added to. So the marker moves onto the one full-width element the
// row has: ST's `.ch_name`, the header strip above the message text carrying the speaker's name.
// style.css paints it yellow; this decides which row wears it.
//
// 🔴 IT IS DERIVED FROM `current`, WHICH IS "LOADED", NOT "MAKING SOUND".
// The marker follows `current`, which represents the loaded item rather than whether it is
// currently audible. A landmark that vanished on pause would be gone at
// exactly the moment he goes looking for it, because pausing is what you do BEFORE you wander
// off. `current` is set for precisely as long as the stop square shows, so the band and the
// glyph cannot drift apart — they are two renderings of one fact.
//
// ⚠️ THE RED SQUARE IS A THIRD AXIS, STRICTLY NARROWER, AND NOT A BRIGHTER BAND.
// Band = "this is the one that is loaded". Red = "…and it is making sound right now". Paused is
// band-without-red, which is the state he described. Pause and resume happen on SillyTavern's
// own transport bar, which pauses the ELEMENT — so `audio.paused` is the only source of truth
// for it, and `onPlaying` binds this to the element's own play/pause events.
//
// 📌 RECOMPUTED FROM `current` ON EVERY REPAINT, never pushed at a row and left there. The
// fork's chat windowing DESTROYS a row that scrolls out of the viewport and builds a NEW one
// from `#message_template` when it comes back — wearing no class anyone set. That is the whole
// of the 7.4 §18c bug ("if it isn't on screen and I scroll up, there isn't a stop button"), and a
// band painted once at playback start would reproduce it exactly, in the one feature whose
// entire purpose is to survive a scroll. Hanging it off `setBtnState` means it rides every path
// that already reasserts the glyph, including the sweep's reconcile.
function paintSpeakingRow() {
  const id = current ? current.mesId : -1;
  // `current.audio` is set by `onPlaying` and only there — it is the element that is known to
  // exist AND to be the one making sound. Absent during the click-to-first-audio gap, which is
  // correct: there is no stop square yet either.
  const audible = !!(current && current.audio && !current.audio.paused);
  $('#chat .mes').each(function () {
    const row = $(this);
    const on = Number(row.attr('mesid')) === id;
    row.toggleClass('vocalis_speaking', on);
    row.find('.vocalis_narrate').toggleClass('vocalis_audible', on && audible);
  });
}

// The narrate button has three states: idle (speaker), generating (spinner — the gap between the
// click and the first audio, which is real because Vocalis streams), and playing (stop).
/**
 * @param {number} mesId
 * @param {string} state
 */
function setBtnState(mesId, state) {
  btn(mesId)
    .toggleClass('fa-volume-high', state === 'idle')
    .toggleClass('fa-spinner fa-spin', state === 'generating')
    .toggleClass('fa-stop vocalis_playing', state === 'playing');
  // 9.1 §1 — the band rides EVERY glyph change rather than being painted at the three call
  // sites, because this is the one function all of them go through: the click, `onPlaying`,
  // `restoreBtn`, `paint`'s re-assert, and the sweep's reconcile. It reads `current` rather than
  // `state`, so a `setBtnState(other, 'idle')` — which `restoreBtn` does issue on a message that
  // is not the one playing — cannot strip the band off the row that IS.
  paintSpeakingRow();
}

/** Stop playback and, by default, cancel the autoplay chain. `keepChain` is used only
 * when `narrateMessage` replaces the current item while advancing that chain.
 * @param {boolean} [keepChain]
 */
function stopCurrent(keepChain) {
  if (!keepChain) stopAutoplay();
  if (!current) return;
  current.handle.stop();
  setBtnState(current.mesId, 'idle');
  current = null;
  hideNarrationPlayerBar();
  // ⚠️ AFTER `current = null`, and that is the whole reason this line exists separately: the
  // `setBtnState` three lines up already called `paintSpeakingRow`, but `current` was still set
  // at that moment, so it repainted the band ON. Same shape in `clearIfCurrent`.
  paintSpeakingRow();
}

// ── ← / → seek, 6.1 ────────────────────────────────────────────────────────────
// 🔴 That last clause is what makes this safe, and it is not a detail. SillyTavern binds the
// bare arrow keys to SWIPE the last message, so a handler that grabbed them whenever the chat
// had focus would take swiping away from him. This one only claims them while Vocalis is
// audibly playing — `current.audio` exists and is not paused — and hands them back when playback
// finishes.
const SEEK_STEP_S = 5;

/** Seek by `delta` seconds. Forward seeking is limited to the buffered end because
 * streamed media beyond it is not available yet; backward seeking stays within played data.
 * @param {HTMLAudioElement} audio
 * @param {number} delta
 */
function seekBy(audio, delta) {
  const dur = Number.isFinite(audio.duration) ? audio.duration : null;
  let limit = dur;
  try {
    const b = audio.buffered;
    if (b && b.length) {
      const end = b.end(b.length - 1);
      limit = limit === null ? end : Math.min(limit, end);
    }
  } catch (e) {
    /* buffered throws on a torn-down element; the duration clamp still applies */
  }
  let t = audio.currentTime + delta;
  if (t < 0) t = 0;
  // A quarter-second short of the edge: landing exactly on the buffer boundary is the same
  // stall, and on the end of the file it just fires `ended`, which stops the playback he was
  // trying to scrub through.
  if (limit !== null && t > limit - 0.25) t = Math.max(0, limit - 0.25);
  audio.currentTime = t;
}

/**
 * @param {KeyboardEvent} e
 */
function onSeekKey(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return; // ST and the browser own these
  const audio = current && current.audio;
  if (!audio || audio.paused) return; // "if anything is playing"
  // Never while he is typing: the arrows are cursor movement in the message box, the edit
  // field, the search box and every popup input.
  const t = e.target;
  const te = /** @type {HTMLElement|null} */ (t);
  if (te && (te.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(te.tagName || ''))) return;
  e.preventDefault();
  // 🔴 stopPropagation as well, or ST swipes the message AND we seek it. Registered with
  // `capture` below so this runs before ST's own document-level handler.
  e.stopPropagation();
  seekBy(audio, e.key === 'ArrowLeft' ? -SEEK_STEP_S : SEEK_STEP_S);
}

/**
 * @param {VocalisStreamHandle} handle
 * @param {number} mesId
 */
function clearIfCurrent(handle, mesId) {
  if (current && current.handle === handle) {
    setBtnState(mesId, 'idle');
    current = null;
    paintSpeakingRow(); // ⚠️ after the clear — see `stopCurrent`
  }
}

/**
 * @param {number} mesId
 */
async function offerRetry(mesId) {
  const c = ctx();
  const res = await c.callGenericPopup(
    'Vocalis: playback stopped early — the server hit an error mid-generation.',
    c.POPUP_TYPE.CONFIRM,
    '',
    { okButton: 'Retry', cancelButton: 'OK' },
  );
  if (res === c.POPUP_RESULT.AFFIRMATIVE) narrateMessage(mesId);
}

// Explain a rejected or missing token only after a narration attempt. The locked-vault 401 is
// handled separately by playStream; suggesting a token reset there could rotate a valid secret.
// This guides users to the existing settings field instead of collecting a second copy.
function guideToken() {
  toastr.warning(
    settings.pairToken
      ? 'Vocalis rejected the pairing token. Re-copy it from the Vocalis web UI ' +
          '(Settings → SillyTavern extension) into Extensions → Vocalis TTS, then press Test.'
      : 'Narration needs the pairing token now. Copy it from the Vocalis web UI ' +
          '(Settings → SillyTavern extension) into Extensions → Vocalis TTS, then press Test.',
    'Vocalis',
    { timeOut: 10000 },
  );
}

// `force` (long-press, below) re-renders instead of replaying the cache. It is NOT part
// of the cache key — the key is voice+params+text — so the forced render overwrites the
// entry it replaces, and the body a pre-render sent stays key-identical either way.
/**
 * @param {number} mesId
 * @param {boolean} [force]
 */
function narrateMessage(mesId, force) {
  if (!settings.enabled) return;
  if (!settings.serverUrl) {
    toastr.warning('Set the server URL in the Vocalis TTS settings first.', 'Vocalis');
    return;
  }
  const msg = ctx().chat[mesId];
  const body = bodyFor(mesId); // the SAME bytes any pre-render or probe sent
  if (!msg || !body) return;

  // §18b — `true`: the chain advances THROUGH here, so this is the one stop that must not end
  // it. Every other stop path takes the default and clears it.
  stopCurrent(true);
  setBtnState(mesId, 'generating'); // spinner during the click → first-audio gap
  const handle = playStream({
    serverBase: settings.serverUrl,
    token: settings.pairToken, // 7.0-m6 — /v1/* is bearer-gated now
    body: force ? { ...body, force: true } : body,
    onPlaying: audioEl => {
      setBtnState(mesId, 'playing');
      // What ← / → seek. Recorded here rather than kept in playStream because this is the
      // one moment the element is known to exist and to be the one making sound.
      if (current && current.handle === handle) current.audio = audioEl;
      // 9.1 §1 — and what the RED stop square is, which is a narrower thing than the band.
      // Pause and resume are SillyTavern's transport bar's doing, not ours: it pauses this
      // element directly and never tells us, so the element's own events are the only notice
      // there is. Nothing to unbind — Vocalis mints one `new Audio()` per clip and drops it when
      // the clip ends, so the listeners go with it.
      audioEl.addEventListener('play', paintSpeakingRow);
      audioEl.addEventListener('pause', paintSpeakingRow);
      // ⚠️ And repaint NOW: `setBtnState` at the top of this callback ran one line before
      // `current.audio` was assigned, so it could only have seen "not audible".
      paintSpeakingRow();
      // ⚠️ And ask again here, because the probe fired at click time can lose a race:
      // the server registers the live render on the stream GET, and the POST that hands
      // back the token comes first. This moment cannot lose it — audio is arriving, so
      // the render is in flight and has shipped a byte, which is exactly `playable`.
      runProbe([mesId]);
      // Dock the shared pause/seek bar on the element Vocalis is actually playing.
      showNarrationPlayerBar(audioEl, { speaker: msg.name || '', onStop: stopCurrent });
    },
    onEnded: () => {
      clearIfCurrent(handle, mesId);
      hideNarrationPlayerBar();
      // A live render tees into the cache as it plays, so this message is green now.
      // Re-ask rather than assume it: a truncated or canceled render is not cached.
      //
      // ⚠️ 8.1: RE-ASK WITHOUT BLANKING FIRST. This was `forgetState` + `scheduleSweep`,
      // which does re-ask — so it self-healed and was never the "stuck orange" fault —
      // but `forgetState` PAINTS ORANGE on the way past, so every message he listened to
      // flashed orange for a round trip before going green. Same complaint, smaller
      // version: the button asserting "nothing here" about audio that is in the cache.
      // `runProbe` asks the same question and applies only the answer, so the color
      // changes once, when it is known, instead of twice.
      runProbe([mesId]);
      // §18b — …and on to the next one. 🔴 ONLY FROM `onEnded`: an error, a truncation or
      // a stop must not advance the chain, or a server that is failing reads the whole
      // chat aloud one silent failure at a time. Those paths have their own handlers and
      // none of them calls this.
      if (autoChain) {
        const next = nextAutoplay(mesId);
        // Off the end is not the end of the mode: he asked for "from here ON", and the
        // next reply has not been written yet. `onCharacterMessageRendered` picks it up.
        if (next >= 0) narrateMessage(next);
        else paintAutoplayRail();
      }
    },
    onError: (m, info) => {
      clearIfCurrent(handle, mesId);
      hideNarrationPlayerBar();
      // §6.2 — a 401 that is NOT the lock gate means the token is missing or wrong, and
      // the guidance beats a raw error line. A locked vault keeps the server's own
      // sentence ("log in to unlock"), which is the correct instruction for it.
      if (info && info.auth) {
        guideToken();
        return;
      }
      toastr.error(m, 'Vocalis');
    },
    onTruncated: () => {
      // retry = a fresh register, so just re-narrate
      clearIfCurrent(handle, mesId);
      hideNarrationPlayerBar();
      offerRetry(mesId);
    },
  });
  current = { handle, mesId };
  // §18b — the rail follows the chain's position, so "what is left to read" stays true as it
  // walks. Cheap: one class toggle per visible row, on a message change and nothing else.
  if (autoChain) paintAutoplayRail();
  // 🔴 Ask what the server has NOW, because this click just changed it. The color axis is
  // "is a render in progress and how far along", and a click starts one — but nothing here
  // used to re-probe, so the button kept whatever it was wearing (orange, for an uncached
  // message) through the whole render while the audio played. The answer comes back
  // `rendering` then `playable`, and `applyState` arms the poll from there.
  runProbe([mesId]);
  // Trigger 2: they are listening to this one, so the next one is what they will
  // click next. Queue it now — the server holds it behind THIS render and starts
  // the moment the card is free.
  if (mesId + 1 < ctx().chat.length) prerenderMessage(mesId + 1);
}

// ── events ─────────────────────────────────────────────────────────────────────
/**
 * @param {number} mesId
 */
function onCharacterMessageRendered(mesId) {
  if (!settings.enabled) return;
  const msg = ctx().chat[mesId];
  if (!msg || msg.is_system || msg.is_user) return;
  const key = `${mesId}:${(msg.mes || '').length}:${(msg.mes || '').slice(0, 40)}`;
  if (key === lastHandled) return;
  lastHandled = key;
  // 🔴 This message's text is NEW, so whatever color it is wearing describes audio of the
  // text it used to hold. On a regenerate that color is green, and green means "click this
  // and it plays instantly" — of a line that no longer exists. Drop stale green immediately, and
  // let the answer put a color back. Orange for a few milliseconds is not a claim; a stale
  // green is. (MESSAGE_SWIPED covers the swipe gesture, but a regenerate does not
  // necessarily arrive as one — this is the path that always runs.)
  //
  // ── 8.1: …BUT ONLY WHEN THE TEXT REALLY DID CHANGE, AND NEVER WITHOUT A RE-ASK. ──────
  //
  // He is describing TWO faults in the three lines above, and the unconditional forget is
  // both of them.
  //
  // 🔴 ONE: NOTHING RE-ASKED. ST fires this event on re-renders of messages that are not the
  // newest, and the only recovery below is `prerenderMessage`, guarded on
  // `mesId === chat.length - 1`. Every OTHER forget in this file — `onMessageSwiped`,
  // `onMessageEdited`, `cancelGesture`, `onEnded` — is followed by `scheduleSweep()` for
  // exactly this reason. This one was not. So the color was stripped and nothing was ever
  // going to put it back: the sweep probes ids it has no state for, this id now had no
  // state, and no sweep was scheduled. It sat orange until a chat load happened to run one,
  // which is why it read as permanent and why it hit "all the older ones".
  //
  // 🔴 TWO: THE PREMISE WAS UNCHECKED. The justification above is "this message's text is
  // NEW" — but the event fires on re-renders that change nothing at all, and there the green
  // is still TRUE at the instant it is thrown away. That is the same lie as a stale green,
  // pointing the other way: the button says "I have nothing for this" about audio that is
  // sitting in the cache and will play instantly if clicked.
  //
  // 📌 `cleaned` IS THE RIGHT ORACLE and it is already maintained. It memoizes per message
  // keyed on the RAW text precisely because `substituteParams` is non-deterministic, so
  // `known.raw !== msg.mes` is exactly "the words changed since we last derived audio for
  // this row". It is cleared alongside `states` on every path that invalidates both
  // (`cancelAllPrerenders` clears it; `forgetAllStates` clears them), so the two cannot drift
  // apart into a green with no memo behind it.
  const known = cleaned.get(mesId);
  if (!known || known.raw !== msg.mes) {
    forgetState(mesId);
    // ⚠️ UNCONDITIONALLY, and not only in the `chat.length - 1` branch below. A forget with
    // no re-ask is the bug; `scheduleSweep` is debounced and a no-op when nothing is
    // unknown, so paying it here costs nothing in the common case.
    scheduleSweep();
  }
  // §18d — an armed preload chain that has run off the end of the chat picks the new reply up
  // here. It is NOT an else-branch of the narrate test below: a chat can be autoplaying and
  // preloading at once, and `pumpPreload` is a no-op when the walk has nothing to send. It is also
  // the only path that reaches a new message when the "Pre-render new messages" checkbox is off —
  // which is the state this row exists for.
  if (preChain) pumpPreload();
  // §18b — an armed chain that has run off the end of the chat picks the new reply up here,
  // which is the "on" half of "from here on". Same branch as `autoNarrate` because it is the
  // same act; `autoChain` is simply the scoped way to have asked for it.
  if (settings.autoNarrate || autoChain) {
    narrateMessage(mesId);
    return;
  }
  // Trigger 1: auto-narrate is off, so this reply is sitting there waiting to be
  // clicked. Render it while the user reads it. Last message only — a backfill
  // sweep would queue the whole chat. (ST does not fire this per-message on chat
  // load, verified in the fork's printMessages; the guard is belt-and-braces.)
  if (mesId === ctx().chat.length - 1) prerenderMessage(mesId);
}

/**
 * @param {number} mesId
 */
function onMessageSwiped(mesId) {
  stopCurrent();
  cleaned.delete(mesId);
  cancelPrerenderFor(mesId); // that text is gone; the render is waste
  cancelEditPreloads(mesId); // and so is a re-preload still waiting to be sent for it
  forgetState(mesId);
  scheduleSweep();
}

// 🔴 An EDIT changes the text, so the old cache key describes audio that is no longer on
// screen — and a stale green would be the button advertising instant playback of a line the
// user just rewrote. This is the only way in 5.4 that the color can lie, and nothing used to
// listen for either event. (The `cleaned` memo is keyed on the raw text and self-invalidates;
// the color is keyed on mesId and does not.)
// ── 9.5.21 §18e: an edit re-preloads the message it changed ────────────────────
//
// The invalidation above is right and was never enough. An edit throws the old render away —
// the text it described is gone — so with pre-rendering ON, the one message he had just touched
// became the only message in the chat that was NOT ready. Exactly inverted, and the fix for it
// was a shift-click he should not have had to make.
//
// 🔴 DEBOUNCED, BECAUSE ONE EDIT IS TWO EVENTS. SillyTavern's `messageEditDone` emits
// MESSAGE_EDITED and then MESSAGE_UPDATED for a single edit (script.js:9774 and :9800, read on
// the live fork), and this file listens to both because either arrives alone from other paths —
// `/sendas` and friends emit the pair too. Submitting on each would send the same text twice
// AND let the second event's `cancelPrerenderFor` cancel the render the first had just queued.
//
// 🔴 AND THE TEXT IS ALREADY THE NEW ONE WHEN THE FIRST EVENT FIRES. `updateMessage()` writes
// `mes.mes = text` before the emit (script.js:9548), so `bodyFor()` here reads what he typed
// rather than what he replaced. Verified in the fork's source rather than assumed, because
// preloading the OLD text would be silent, cached under a key nothing will ask for, and
// indistinguishable from working.
const EDIT_PRELOAD_MS = 250;
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const editPreloads = new Map();

/** Drop pending edit re-preloads — one message's, or all of them.
 *
 * 🔴 THE TIMER IS KEYED ON AN INDEX, AND INDICES MOVE. A delete shifts every id after it and a
 * chat change invalidates all of them, so a timer that survived either would preload a message
 * nobody edited. Same reasoning as `onMessageDeleted`'s existing `stopPreloadChain`.
 * @param {number} [mesId] - omit to drop every pending one
 */
function cancelEditPreloads(mesId) {
  if (mesId === undefined) {
    for (const t of editPreloads.values()) clearTimeout(t);
    editPreloads.clear();
    return;
  }
  const t = editPreloads.get(mesId);
  if (t) clearTimeout(t);
  editPreloads.delete(mesId);
}

/** Is this edited message one that preloading has already promised to cover?
 *
 * TWO ways to have said yes, and they are the two meanings of "preloading is on":
 *
 *   · the **Pre-render new messages** checkbox — the general, temporal answer;
 *   · an armed **Preload from here on** chain that has ALREADY WALKED PAST this message. What
 *     is ahead of the cursor the chain will reach on its own; what is behind it is the half
 *     nothing else will ever come back for, which is precisely where an edit lands.
 *
 * A one-off shift-click is not a preload promise. With the checkbox off,
 * `cancelAllPrerenders()` cancels that render, so an edit must not revive it.
 * @param {number} mesId
 */
function editPreloadWanted(mesId) {
  if (!settings.enabled || !settings.serverUrl) return false;
  if (settings.preRender) return autoplayable(mesId);
  return !!preChain && mesId < preChain.next && autoplayable(mesId);
}

/**
 * @param {number} mesId
 */
function schedulePreloadAfterEdit(mesId) {
  cancelEditPreloads(mesId);
  if (!editPreloadWanted(mesId)) return;
  editPreloads.set(
    mesId,
    setTimeout(() => {
      editPreloads.delete(mesId);
      // Re-asked rather than remembered: the 250 ms is long enough for the checkbox to have been
      // unticked, or for the chain to have been stopped, between the edit and this firing.
      if (!editPreloadWanted(mesId)) return;
      // `force` only where the CHAIN is the reason. It bypasses `settings.preRender`, which is
      // the whole point when the checkbox is off — and `editPreloadWanted` has already applied
      // `autoplayable`, so the `is_user` guard it also bypasses is not being lost.
      prerenderMessage(mesId, settings.preRender ? undefined : { force: true });
    }, EDIT_PRELOAD_MS),
  );
}

/**
 * @param {number} mesId
 */
function onMessageEdited(mesId) {
  cleaned.delete(mesId);
  cancelPrerenderFor(mesId);
  forgetState(mesId);
  scheduleSweep();
  schedulePreloadAfterEdit(mesId);
}

function onMessageDeleted() {
  // Every index after the deleted one just shifted, so all three maps now describe the
  // wrong messages. Forget the lot rather than cancel the wrong key or color the wrong row.
  stopCurrent();
  cancelAllPrerenders();
  cancelEditPreloads(); // §18e — every one of those is keyed on an index that just shifted
  // §18d — the cursor is an index, and `cancelAllPrerenders` above has just stood down everything
  // the chain had queued. Carrying on from `next` would submit against messages that are no longer
  // the ones it walked to, which is the same wrongness as the selection two lines down.
  stopPreloadChain(true);
  forgetAllStates();
  // 6.0: and the SELECTION is indices too. #412 → #598 now spans a different conversation,
  // and silently building the wrong 74 messages is worse than making him click twice again.
  // (The MANIFEST is safe from this by construction — §4 keys it on the cache key, precisely
  // because mesid shifts. The live selection has no such protection.)
  closeSceneMenu();
  clearRange();
  scheduleSweep();
}

// A chat load or a "Show more messages" click paints a whole batch at once, and neither fires
// any per-message event. Without these, every message the user scrolls back to would keep its
// buttons and never get a color — permanently orange on exactly the older messages most
// likely to be cached. §6.1.
function onMessagesPainted() {
  scheduleSweep();
  preloadGreetingWhenReady();
}

// 🔴 AND THE EVENTS ARE NOT ENOUGH. A measured page load produced **zero** /v1/audio/state requests
// and every already-cached message stayed orange. Firing CHAT_LOADED by hand immediately
// produced one. So the handler was right and never ran — an extension is loaded with
// `await import(url)`, and ST emits CHAT_LOADED (script.js:8101) on its own schedule, so
// whether the listener exists yet is a race. Init's own trailing `scheduleSweep()` was meant
// to cover that, and it loses the other half of the race: at init `#chat` is often still
// empty, so the sweep asks about nothing.
//
// It is a race: initialization order can make the same code produce different visible states.
//
// The DOM cannot be raced. Every path that puts a message on screen ends in a row being added
// to `#chat`, including paths nobody enumerated, so that is what we watch. `childList` without
// `subtree`: rows are direct children, while our own button injection and every color change
// happen deeper and must not re-trigger this. The 250 ms sweep debounce still collapses a
// 100-message paint into one request.
function watchChat() {
  const chat = document.getElementById('chat');
  if (!chat) {
    setTimeout(watchChat, 500);
    return;
  } // ST builds #chat late on a cold load
  new MutationObserver(() => {
    scheduleSweep();
    preloadGreetingWhenReady();
  }).observe(chat, { childList: true });
  scheduleSweep(); // and whatever is already there
}

function pushCurrentCharacter() {
  // Best-effort: the chat's character(s) become assignable in the Vocalis web
  // UI before their first narration. Failures are silent (server may be down;
  // narration requests auto-register anyway). Group chats push every member
  // (avatar key -> name, the same resolution the built-in TTS uses).
  if (!settings.enabled || !settings.serverUrl) return;
  const c = ctx();
  // 🔴 7.0-m5b — THE AVATAR RIDES ALONG, BECAUSE THE NAME IS NOT UNIQUE.
  //
  // The avatar filename is SillyTavern's own key and is unique because the filesystem makes it
  // so. The group branch below already had it in hand (`ch.avatar == member`) and threw it away.
  //
  // 📌 The server accepts BOTH shapes, so an extension copy that has not been re-installed keeps
  // working exactly as it did — this is additive on the wire, not a version bump.
  /** @type {{ name: string, avatar: string }[]} */
  let names = [];
  if (c.groupId) {
    const group = (c.groups || []).find(g => g.id == c.groupId);
    for (const member of (group && group.members) || []) {
      const char = (c.characters || []).find(ch => ch.avatar == member);
      if (char && char.name) names.push({ name: char.name, avatar: char.avatar || '' });
    }
  } else if (c.name2) {
    // Solo chat: `name2` is the name on screen; the avatar comes from the selected card.
    // ⚠️ `characterId` can be a string index, so `?.[]` rather than a lookup by name — a
    // by-name lookup here could select the wrong card when names are duplicated.
    const me = (c.characters || [])[Number(c.characterId ?? -1)];
    names = [{ name: c.name2, avatar: (me && me.avatar) || '' }];
  }
  if (names.length) {
    registerCharacters(settings.serverUrl, names, settings.pairToken).catch(() => {});
  }
}

// ── 9.6.4 §18f: a new chat's greeting is preloaded like any other new message ──────────────
//
// 🔴 THE GREETING WAS BEING SUBMITTED AND THEN CANCELED BY THE CHAT CHANGE THAT INTRODUCED
// IT, which is why nothing looked broken: the request went out, the server took it, and a
// second request from the same tab threw it away a moment later.
//
//   · SOLO — `getChatResult` emits CHAT_CHANGED and *then* CHARACTER_MESSAGE_RENDERED(0,
//     'first_message') (script.js:9057, :9063). `onChatChanged` fires `cancel({all:true})`;
//     the greeting's `prerender` leaves microseconds later on a DIFFERENT request. Two
//     concurrent POSTs have no ordering, and `PrerenderQueue.cancel(None)` takes the queue
//     AND the running job, so whichever lands second wins. A coin toss, per new chat.
//   · GROUP — not a race at all: `getGroupChat` emits CHARACTER_MESSAGE_RENDERED for every
//     member's greeting (group-chats.js:304) and CHAT_CHANGED only afterward (:319), so the
//     cancel ALWAYS lands last and the greetings are ALWAYS stood down.
//   · AND A GREETING THAT ARRIVES WITH NO PER-MESSAGE EVENT reached nothing at all.
//
// 📌 The fix is ordering plus a pending handoff: submit the newest message once the stand-down
// has been ACKNOWLEDGED, so the request that could destroy it has already been served. If
// CHAT_CHANGED arrives before SillyTavern has populated `ctx().chat`, keep the handoff pending
// until CHAT_LOADED/a rendered row/the chat observer says the greeting now exists. A duplicate is
// free — `PrerenderQueue.submit` is idempotent per cache key and answers queued/running/cached for
// one it already holds (prerender.py:231).
//
// ⚠️ IT READS THE CHAT AT CALLBACK TIME, AND THERE IS DELIBERATELY NO "IS THIS STILL MY CHAT?"
// GUARD. I wrote one — an epoch counter — and a mutation run showed it could not fail, then a
// second look showed it was WORSE than nothing. Two chats in quick succession: the first one's
// stand-down is still on the wire when the second arrives, and the second has nothing of its own
// to cancel, so it submits its greeting immediately — into the path of a cancel that has not
// landed yet. What repairs that is precisely the FIRST chat's callback firing late and
// re-submitting whatever is newest NOW. An epoch guard turns that repair off and leaves the
// greeting dead. So the callback is deliberately about "the newest message, whenever this
// resolves", not about the chat that scheduled it, and a duplicate costs nothing.
//
// ⚠️ ONE MESSAGE, THE NEWEST, and every other guard stays where it is: `prerenderMessage`
// still applies `settings.preRender`, `settings.enabled`, a server URL, and is_user/is_system.
// This is the same rule as Trigger 1 in `onCharacterMessageRendered`, reached by the one path
// that always runs. A group's EARLIER greetings stay orange, exactly as older messages always
// have — a backfill of the whole chat is what "Preload messages from here on" is for.
let greetingPreloadPending = false;
let greetingStandDown = Promise.resolve();

/**
 * Submit the newest greeting after every chat-change cancel issued so far has finished. With
 * `force` true, this is the callback owned by CHAT_CHANGED itself and deliberately re-submits the
 * newest chat after rapid consecutive switches. Without it, this is a later "the greeting now
 * exists" signal and only acts while the handoff is pending.
 * @param {boolean} [force]
 */
function preloadGreetingWhenReady(force) {
  const barrier = greetingStandDown;
  barrier.then(() => {
    if (!force && !greetingPreloadPending) return;
    const chat = ctx().chat || [];
    if (!chat.length) {
      // No message text, names or ids: only the sequencing fact needed to diagnose this race.
      if (force) console.debug('[Vocalis] chat changed before its greeting was populated; waiting for the rendered row');
      return; // CHAT_CHANGED can precede population; a later paint retries.
    }
    greetingPreloadPending = false;
    prerenderMessage(chat.length - 1);
  });
}

function onChatChanged() {
  stopCurrent();
  const stoodDown = cancelAllPrerenders(); // a different chat: none of it is wanted now
  // Include every outstanding cancel, not only the newest call. A second rapid chat change may
  // have nothing left in `preKeys` and therefore resolve immediately while the first cancel is
  // still on the wire; submitting behind only that second promise would put the greeting back in
  // front of the first cancel and lose it again.
  greetingStandDown = Promise.all([greetingStandDown, stoodDown]).then(() => {});
  greetingPreloadPending = true;
  cancelEditPreloads(); // §18e — and so are the pending re-preloads, for the same reason
  stopPreloadChain(true); // §18d — and its cursor is an index into the chat that just went away
  forgetAllStates();
  closeSceneMenu(); // §2.2 — dismissed on a chat change
  clearRange(); // indices mean nothing in another chat
  lastHandled = '';
  pushCurrentCharacter();
  probeResume(); // a new chat is a fair chance to try the server again
  // §18f — and NOW the greeting, once every server stand-down has been acknowledged. `force`
  // preserves the rapid-switch repair described above; if the greeting is not populated yet,
  // the pending flag is consumed by onMessagesPainted/watchChat when it arrives.
  preloadGreetingWhenReady(true);
}

// ── settings UI ────────────────────────────────────────────────────────────────
const SETTINGS_HTML = `
<div class="vocalis-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Vocalis TTS (streaming)</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label" for="vocalis_enabled">
        <input type="checkbox" id="vocalis_enabled"><span>Enabled</span>
      </label>
      <label class="checkbox_label" for="vocalis_auto">
        <input type="checkbox" id="vocalis_auto"><span>Auto-narrate new AI replies</span>
      </label>
      <label class="checkbox_label" for="vocalis_prerender">
        <input type="checkbox" id="vocalis_prerender"><span>Pre-render new messages</span>
      </label>
      <div class="vocalis-row">
        <input type="text" id="vocalis_url" class="text_pole" placeholder="https://vocalis.example:18770">
        <div id="vocalis_test" class="menu_button" title="Check the server connection">Test</div>
      </div>
      <div id="vocalis_status" class="vocalis-status"></div>
      <!-- Mask the pairing token because settings may be shared on screen. SillyTavern stores
           it as plaintext in each user's settings.json; masking does not encrypt storage. -->
      <div class="vocalis-row">
        <input type="password" id="vocalis_token" class="text_pole" autocomplete="off"
               placeholder="pairing token (Vocalis → Settings → SillyTavern extension)">
      </div>
      <div class="vocalis-note"><b>Pairing</b> is required: narration and worldbooks both
        authenticate with this token (it is your Vocalis API key). Generate it in the Vocalis
        web UI under Settings → SillyTavern extension, paste it here, then press Test.</div>
      <!-- Import begins in the Vocalis Library; this extension handles SillyTavern's response.
           Keeping controls there avoids per-document, per-chat imports. -->
      <div id="vocalis_send_status" class="vocalis-status"></div>
      <div class="vocalis-note">Voices and per-character settings are assigned in the
        Vocalis web UI (SillyTavern tab). Characters appear there when you open their
        chat here.</div>
      <div class="vocalis-note"><b>Pre-render</b> renders each new reply as soon as it
        lands, so clicking ▶ plays instantly instead of waiting. It never plays anything
        by itself, and the server only renders while it has nothing else to do — but it
        does spend GPU on messages you might never listen to. Turn it off if the box is
        busy.</div>
    </div>
  </div>
</div>`;

async function testServer() {
  const st = $('#vocalis_status');
  if (!settings.serverUrl) {
    // placeholder text is not a value: an empty
    st.text('enter the server URL first (e.g. https://vocalis.example:18770)') // base would
      .removeClass('ok')
      .addClass('fail'); // probe ST itself (404)
    return;
  }
  st.text('checking…').removeClass('ok fail');
  const r = await probeHealth(settings.serverUrl);
  if (!r.ok) {
    st.text(`unreachable: ${r.error}`).addClass('fail');
    return;
  }
  const v = r.info.version ? ` v${r.info.version}` : '';
  // 5.0: /health stays open while the vault is LOCKED — it is the one endpoint
  // that does. So a reachable server is NOT a working one: locked, every /v1/*
  // call 401s and no message will ever narrate. Reporting a green OK here (which
  // is what this did before) sends the user hunting for a TTS bug that is really
  // a shut vault. `locked` is absent on pre-5.0 servers, hence the truthiness test.
  if (r.info.locked) {
    st.text(
      `${r.info.product || 'Vocalis'}${v} is LOCKED — unlock it by logging in to ` +
        `the Vocalis web UI. Narration stays unavailable until you do.`,
    ).addClass('fail');
    return;
  }
  const m = r.info.model_ready ? 'model ready' : 'model cold (loads on first use)';
  st.text(`OK — ${r.info.product || 'Vocalis'}${v}, ${m}${await pairingSuffix()}`).addClass('ok');
  pushCurrentCharacter();
  probeResume(); // a green Test is the user telling us to try again
}

/** Pairing detail for a reachable server. Keep it in the green Test result: pairing status is
 * distinct from server availability, and a locked vault means pairing cannot be checked. */
async function pairingSuffix() {
  if (!settings.pairToken) return ' · not paired — narration needs the token (see above)';
  const p = await pairPing(settings.serverUrl, settings.pairToken);
  // A locked vault makes pairing unknowable; do not prompt for a token reset that could revoke a
  // valid pairing.
  if (p.locked) return ' · vault locked, cannot check pairing';
  if (!p.ok) return ` · pairing unchecked (${p.error})`;
  // Distinguish a rejected token from an absent token so the user knows to re-copy it.
  return p.paired ? ' · paired' : ' · token rejected — re-copy it from the Vocalis web UI';
}

// ── 7.0-m2j: "Import from SillyTavern" ────────────────────────────────────────
// The import is initiated in Vocalis. This extension exposes no picker or send button; it polls
// for a requested sweep, reads character data through SillyTavern's API, and posts it to Vocalis.
//
// ⚠️ The extension runs in SillyTavern's authenticated page. Its API uses the logged-in browser
// session (`enableUserAccounts: true`, `basicAuthMode: false`), so the server cannot perform this
// read without separately handling SillyTavern credentials.

// Keep import polling names distinct from the narration and message-sweep timers in this module;
// duplicate module-scope `const` declarations prevent the extension from loading.
const SWEEP_POLL_MS = 5000;
/** @type {ReturnType<typeof setTimeout>|null} */
let stImportTimer = null;
let sweeping = false;
// ⚠️ `pushing`, not `sending` — `vocalis_send_status` and the m2i-era `send*` names are already
// this drawer's, and a module-scope collision is a SyntaxError that stops `index.js` loading
// entirely (see the note above; `node --check` catches it, the browser specs caught it first).
let pushing = false;

/** Closed set of sanitized failure reasons sent to Vocalis. SillyTavern error bodies can contain
 * document text, so keep raw details in the local console and send only allow-listed messages. */
const PUSH_REASONS = {
  refused: 'SillyTavern refused the write',
  // The persona panel lists avatar files, not settings keys; report a missing picture so a persona
  // whose settings landed without its file is not reported as a visible success.
  unseen: 'the persona was written but its picture is not in SillyTavern, so it would not appear',
  invalid: 'SillyTavern rejected the document as invalid',
  missing: 'that document is not in SillyTavern any more',
  unreachable: 'SillyTavern did not answer',
  unsupported: 'this extension does not know how to write that kind of document',
  picture: 'the text was saved, but the picture did not go through',
};

/** Return a safe exception class name, never exception text. Parse errors can quote document
 * contents, and sweep errors are sent to Vocalis; preserve only the actionable failure class.
 * Thrown values and `name` are untrusted, so accept only a bounded identifier.

 * @param {unknown} e - a caught value; the body is what narrows it
 */
function errClass(e) {
  const ex = /** @type {ErrLike} */ (e);
  const name = ex && ex.name ? String(ex.name) : '';
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : 'Error';
}

// These failures apply to the remaining sweep, so report the actionable cause once and stop.
const PUSH_FAIL = {
  locked: 'the Vocalis vault is locked — unlock it and import again',
  rejected: 'the pairing token was rejected — re-copy it from the Vocalis web UI',
};

/** Record a failed `pushDocument` against `name`. Returns true when the sweep must STOP.
 * @param {SweepTally} tally
 * @param {string} name
 * @param {Record<string, any>} r
 */
function notePushFailure(tally, name, r) {
  if (r && r.locked) {
    tally.errors.push(PUSH_FAIL.locked);
    tally.stop = PUSH_FAIL.locked;
    return true;
  }
  if (r && r.paired === false) {
    tally.errors.push(PUSH_FAIL.rejected);
    tally.stop = PUSH_FAIL.rejected;
    return true;
  }
  // `error` is Vocalis's own status line ("the document is too large", "HTTP 500") or a network
  // message — never a SillyTavern response body, which is what B.5 is about.
  tally.errors.push(r && r.error ? `${name} (${r.error})` : name);
  return false;
}

// Per-tab flags cannot prevent tabs from overlapping a sweep and send. This best-effort
// localStorage lease reduces overlap on this origin; the server-side claim remains authoritative
// across browsers and devices. Claim before /pair/poll, which transfers the job. Refresh during
// work rather than on a timer because hidden-tab timers are throttled.
//: The last reason `pollForSweep` skipped a poll, so its trace prints TRANSITIONS rather than
//: a line every five seconds. `''` means the last decision was to poll.
//: ⚠️ DECLARED HERE, INSIDE THE PAIRING-CHANNEL BLOCK, because `st_doorbell_reopen_spec.mjs`
//: brace-matches that block out and evaluates it: a name `pollForSweep` reads from OUTSIDE
//: it is a ReferenceError at call time, which takes the whole spec out before it can report
//: a single check. The spec found this within a minute of the trace being added.
let stPollSkip = '';

const RUN_LOCK_KEY = 'vocalis_st_run_lock';
const RUN_LOCK_MS = 30000;
const RUN_LOCK_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function runLockStore() {
  // Storage can be absent (a sandboxed frame) or throw on ACCESS (third-party cookie blocking),
  // which is why this is a call and not a captured reference.
  try {
    return globalThis.localStorage || null;
  } catch (e) {
    return null;
  }
}

/** Take the cross-tab lock, or re-stamp it when this tab already holds it. False means another
 *  tab holds a live one. No storage means no lock: fall back to the per-tab guards alone.
 * @param {number} now
 */
function claimRunLock(now) {
  const ls = runLockStore();
  if (!ls) return true;
  try {
    const raw = ls.getItem(RUN_LOCK_KEY);
    const held = raw ? JSON.parse(raw) : null;
    if (held && held.id !== RUN_LOCK_ID && Number(held.until) > now) return false;
    ls.setItem(RUN_LOCK_KEY, JSON.stringify({ id: RUN_LOCK_ID, until: now + RUN_LOCK_MS }));
    // ⚠️ WRITE, THEN READ BACK. The doorbell is a BROADCAST: two tabs are woken by the same
    // frame in the same millisecond, and a `localStorage` read-modify-write is not atomic
    // across them, so both can find the slot free. Re-reading makes it last-writer-wins with
    // both sides agreeing on who won, which is the difference between a lock and a wish.
    const back = ls.getItem(RUN_LOCK_KEY);
    return !!back && JSON.parse(back).id === RUN_LOCK_ID;
  } catch (e) {
    return true; // a quota error or junk in the slot must not stop the feature
  }
}

/** Re-stamp the lease. Called as work happens — see the throttling note above. */
function refreshRunLock() {
  claimRunLock(Date.now());
}

/** 🔴 ONLY EVER RELEASES THIS TAB'S OWN LEASE. Removing another tab's would be worse than never
 *  having taken one, because it would look like exclusion while providing none. */
function releaseRunLock() {
  const ls = runLockStore();
  if (!ls) return;
  try {
    const raw = ls.getItem(RUN_LOCK_KEY);
    const held = raw ? JSON.parse(raw) : null;
    if (!held || held.id === RUN_LOCK_ID) ls.removeItem(RUN_LOCK_KEY);
  } catch (e) {
    /* nothing useful to do; the lease expires on its own */
  }
}

/** Say what is happening in the drawer too. The authoritative status is the Vocalis Library's,
 *  because that is where he is looking; this is for when he happens to be on this tab.
 * @param {string} msg
 * @param {string} [cls]
 */
function sweepSay(msg, cls) {
  $('#vocalis_send_status')
    .text(msg)
    .removeClass('ok fail')
    .addClass(cls || '');
}

/** Poll Vocalis for a pending sweep. Also the heartbeat that tells Vocalis a SillyTavern tab is
 *  open at all — which is what lets the Library say "no SillyTavern tab is open" instead of
 *  spinning forever over a request nobody will ever collect. */
async function pollForSweep() {
  // The enabled setting gates all pairing-channel work, including exports and writes. Log poll
  // skip reasons only when they change; the five-second poll must not flood the console.
  const why =
    sweeping || pushing
      ? 'busy: a sweep or send from this tab is still running'
      : !settings.enabled
        ? 'the Vocalis extension is switched off in its settings'
        : !settings.serverUrl || !settings.pairToken
          ? 'not paired: serverUrl or pairing token is empty'
          : !claimRunLock(Date.now())
            ? 'another SillyTavern tab holds the run lock — this tab will not poll while it does'
            : '';
  if (why !== stPollSkip) {
    stPollSkip = why;
    console.log('[Vocalis] poll:', why || 'polling Vocalis again');
  }
  if (why) return;
  // A degraded poll is also a settings refresh trigger. The runtime coalesces overlapping reads;
  // no prompt or response body crosses this doorbell path.
  if (stImportTimer) void polishRuntime?.refresh();
  try {
    // Throttled inside; this is a no-op on all but one poll in twenty-four.
    const self = await checkOwnBuild();
    const r = await pairPoll(settings.serverUrl, settings.pairToken, undefined, EXT_BUILD, self);
    // The job itself, named the moment it arrives — the gap between "collected" and "written" was
    // unobservable, so a plan fetch that 400s and a write that failed looked identical.
    if (r.ok && (r.sweep || r.push)) {
      console.log('[Vocalis] collected:', JSON.stringify({ sweep: !!r.sweep, push: r.push || null }));
    }
    if (r.ok && r.sweep) {
      await runSweep();
      return;
    }
    // 7.0-m3. The server never hands out both in one answer, so this is an `else` in effect —
    // but it is written as a separate check rather than an `else if` so that a future server
    // that DID send both would run the sweep and leave the send pending for the next poll,
    // which is the safe way round.
    if (r.ok && r.push) await runPush(r.push);
  } finally {
    // Held for the whole run, not just the claim: the point is that the OTHER tab's sweep
    // cannot read a card between this send's two writes.
    releaseRunLock();
  }
}

// The event stream is the primary wake-up path; the timer is degraded-mode polling. Events only
// signal that work may be available. `/pair/poll` performs the single-winner claim because tabs
// can wake concurrently and writes include read-modify-write operations.
/** @type {EventSource|null} */
let stStreamSrc = null;

// A non-200 response closes EventSource without automatic reconnection; a transport drop leaves it
// CONNECTING while the browser retries. Reopen only CLOSED sources to preserve native retries.
const ES_CLOSED = 2;
const STREAM_RETRY_BASE_MS = 5000;
const STREAM_RETRY_MAX_MS = 300000; // 5 min: a server that is down does not deserve a poll a
const STREAM_RETRY_STEPS = 6; // second, and this is well inside a vault's lock timeout
let stStreamBackoff = 0; // consecutive failed re-opens
let stStreamRetryAt = 0; // epoch ms the next re-open is due; 0 = none pending

/** Close the stream if one is open. Safe to call when there is not. */
function stopStream() {
  if (stStreamSrc) {
    try {
      stStreamSrc.close();
    } catch (e) {
      /* already gone */
    }
  }
  stStreamSrc = null;
}

/** How long before the Nth consecutive re-open attempt. Exponential from 5 s to a 5 min ceiling.
 *
 * Backoff limits repeated 401/503 reconnects while a vault remains locked or the stream limit is
 * full. Each attempt includes the pairing token in the URL.
 * @param {number} attempt
 */
function streamRetryDelayMs(attempt) {
  const n = Math.max(0, Math.min(Number(attempt) || 0, STREAM_RETRY_STEPS));
  return Math.min(STREAM_RETRY_BASE_MS * Math.pow(2, n), STREAM_RETRY_MAX_MS);
}

/** Arm the next re-open. Idempotent: repeated errors must not push the deadline out. */
function scheduleStreamRetry() {
  if (stStreamRetryAt) return;
  stStreamRetryAt = Date.now() + streamRetryDelayMs(stStreamBackoff);
}

/** The fallback tick's other job: put the doorbell back. Collecting work is not enough — a tab
 *  that only ever polls is the degraded mode, and staying there is the bug. */
function reopenStreamIfDue() {
  if (!settings.enabled || !settings.serverUrl || !settings.pairToken) return;
  if (stStreamSrc && stStreamSrc.readyState !== ES_CLOSED) return; // live, or reconnecting
  if (!stStreamRetryAt || Date.now() < stStreamRetryAt) return;
  stStreamRetryAt = 0;
  stStreamBackoff = Math.min(stStreamBackoff + 1, STREAM_RETRY_STEPS);
  openStream();
}

/** 🔴 THE TOKEN RIDES IN THE QUERY STRING BECAUSE `EventSource` CANNOT SET HEADERS.
 *  There is no API for it — not Authorization, not X-anything. Vocalis's `_check_pairing` has a
 *  branch for exactly this route, and logs `request.path` (never `full_path`) so the token does
 *  not reach its log. It is still URL-logged wherever else URLs are logged; rotate accordingly. */
function openStream() {
  stopStream();
  if (!settings.enabled || !settings.serverUrl || !settings.pairToken) return;
  const base = String(settings.serverUrl).replace(/\/+$/, '');
  const url = `${base}/pair/stream?token=${encodeURIComponent(settings.pairToken)}`;
  let src;
  try {
    src = new EventSource(url);
  } catch (e) {
    // A malformed serverUrl. The fallback timer collects work meanwhile — and it also has to
    // come back and try this again, or a URL fixed by hand in settings.json never reconnects.
    scheduleStreamRetry();
    startFallbackPoll();
    return;
  }
  stStreamSrc = src;
  src.addEventListener('work', () => {
    void polishRuntime?.refresh();
    pollForSweep();
  });
  src.addEventListener('open', () => {
    // The open stream replaces the fallback poll; clear its interval to avoid duplicate retries.
    if (stImportTimer) {
      clearInterval(stImportTimer ?? undefined);
      stImportTimer = null;
    }
    // A working connection is what makes the NEXT failure a fresh one rather than the tail of
    // an old streak — otherwise a tab up for a week retries at the 5 min ceiling forever.
    stStreamBackoff = 0;
    stStreamRetryAt = 0;
    // A stream that (re)opens means Vocalis is answering again — typically after a restart,
    // during which every settings read was refused and Polish's snapshot went null. Read it
    // now rather than waiting for a doorbell that may not ring for hours.
    void polishRuntime?.refresh();
  });
  src.onerror = () => {
    // ⚠️ `onerror` IS NOT FATAL FOR A TRANSPORT DROP — EventSource reconnects by itself (it is
    // in the spec, not a library feature), which is what makes a frozen-then-thawed tab
    // self-healing. A non-200 RESPONSE is a different event wearing the same handler: the spec
    // fails the connection, `readyState` goes CLOSED, and nothing will ever retry it. So the
    // timer comes back either way, and a CLOSED source additionally arms a re-open (B.2).
    if (stStreamSrc !== src) return; // superseded by a later openStream
    if (src.readyState === ES_CLOSED) scheduleStreamRetry();
    startFallbackPoll();
  };
}

/** The degraded channel: only while the stream is not up. Slower than m4w's 5s because it is no
 *  longer carrying liveness for a healthy client — a stream open on Vocalis's side IS the liveness
 *  answer now (`doorbell.count()`), and this exists to collect work, not to prove we are here. */
function startFallbackPoll() {
  if (stImportTimer) return; // already degraded; do not stack timers
  if (!settings.enabled || !settings.serverUrl || !settings.pairToken) return;
  stImportTimer = setInterval(() => {
    pollForSweep();
    // 🔴 AND CLIMB BACK OUT. This tick is the only thing still running once the stream has
    // failed, so it is the only thing that can restore it — B.2.
    reopenStreamIfDue();
  }, SWEEP_POLL_MS);
}

function startPolling() {
  if (stImportTimer) {
    clearInterval(stImportTimer ?? undefined);
    stImportTimer = null;
  }
  // A settings edit (or unticking and re-ticking Enabled) is the user telling us to try now.
  stStreamBackoff = 0;
  stStreamRetryAt = 0;
  // ⚠️ Only while there is something to reach Vocalis WITH, and only while the extension is
  // switched on (B.3). An unpaired user never touches this feature, and a stream or timer
  // against an empty URL logs a failure per attempt forever.
  if (!settings.enabled || !settings.serverUrl || !settings.pairToken) {
    stopStream();
    return;
  }
  openStream();
  // 📌 AND POLL ONCE, NOW. The stream only reports work that arrives AFTER it connects; a job
  // requested while this tab was closed is already pending and no event will ever be sent for
  // it. Without this, re-opening SillyTavern would leave an Import queued in the Library and
  // apparently ignored — which is m4w's complaint wearing a different hat.
  pollForSweep();
}

// Hidden-tab timers are throttled, so poll immediately when the page becomes visible. Keep this
// wake-up for both timer and stream modes: a suspended EventSource may not deliver until the tab
// resumes. This supplements, but does not replace, the normal polling path.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (stImportTimer || stStreamSrc) pollForSweep();
  // And foregrounding is a fair chance to get the doorbell back at once rather than waiting out
  // whatever is left of the backoff — the tab is in front of him, so a request now is one he is
  // waiting for rather than one nobody asked for (B.2).
  if (stStreamRetryAt) {
    stStreamRetryAt = 1;
    reopenStreamIfDue();
  }
});

/** Everything, in one pass: every worldbook and every character.
 *
 * 🔴 THE SUMMARY IS POSTED EVEN WHEN THIS THROWS. Vocalis marks a sweep "running" the moment it
 * hands it over, and only this call ends it — so a sweep that died halfway without reporting
 * leaves the Library spinning until a five-minute timeout over something that already stopped.
 */
async function runSweep() {
  if (sweeping) return;
  sweeping = true;
  /**
   * ⚠️ ANNOTATED BECAUSE `errors: []` INFERS `never[]`, so every `tally.errors.push(...)` in
   * the sweep was an error. `stop` is a SENTENCE (`PUSH_FAIL.locked` and friends are strings),
   * not a flag — it is what the run reports as the reason it gave up.
   * @type {SweepTally}
   */
  const tally = { books: 0, cards: 0, personas: 0, unchanged: 0, errors: [], stop: '' };
  try {
    sweepSay('importing into Vocalis…');
    // 🔴 `tally.stop` IS A LOCKED VAULT OR A REJECTED TOKEN — B.4. Neither clears by itself,
    // so the remaining phases would file one identical sentence per document.
    await sweepBooks(tally);
    if (!tally.stop) await sweepCards(tally);
    if (!tally.stop) await sweepPersonas(tally);
    if (tally.stop) sweepSay(`import stopped: ${tally.stop}`, 'fail');
    else sweepSay(`sent ${tally.books} book(s), ${tally.cards} character(s) and ` + `${tally.personas} persona(s) to Vocalis`, 'ok');
  } catch (e) {
    // 🔴 THE CLASS, NEVER THE MESSAGE — B.5. This `catch` used to say "our exception is safe",
    // and the exception that actually reaches it is SillyTavern's: `loadWorldInfo` runs
    // `JSON.parse` over a book, and V8 builds a SyntaxError by quoting a window of the source
    // it choked on. That string was going into `tally.errors`, across the wire, into the vault
    // and onto the screen. The whole thing goes to the console instead.
    console.error('[Vocalis] sweep stopped', e);
    tally.errors.push(`the import stopped (${errClass(e)}) — the browser console has why`);
    sweepSay(`import stopped (${errClass(e)}) — see the browser console`, 'fail');
  } finally {
    sweeping = false;
    await sweepDone(settings.serverUrl, settings.pairToken, tally);
  }
}

// ── 7.0-m3: "Send to SillyTavern" ─────────────────────────────────────────────
// The write half of the pairing flow. A user edits a book or a card in Vocalis and presses Send;
// Vocalis cannot perform the write (no SillyTavern session, see
// the note above), so it records a job, this poll collects it, and the write happens here.
//
// 🔴 THIS FILE DECIDES NOTHING ABOUT WHAT IS WRITTEN. `fetchPlan` returns a plan built by
// `wbedit/formats/st_write.py` — which endpoint, which fields, and the rule that a MIRRORED
// `character_book` is never sent. Those are rules about user data; a copy of them here would be
// a second opinion two codebases could drift apart on.

/** Execute one claimed send. Reports to Vocalis whatever happens, including when it throws.
 *
 * 🔴 THE RESULT IS POSTED IN A `finally`. Vocalis marks a send "running" the moment it hands it
 * over and only this call ends it, so a send that died without reporting blocks every later send
 * until a timeout — one document at a time is the rule on that side.

 * @param {Record<string, any>} job
 */
async function runPush(job) {
  if (pushing) return;
  pushing = true;
  /**
   * ⚠️ ANNOTATED, NOT INFERRED. The first assignment always carries `reason`, so inference
   * made it REQUIRED — and the `writePlan` spread below legitimately may not have one. This
   * object is what gets posted back in the `finally`, so its shape is the wire contract, not
   * whatever the initial value happened to look like.
   * @type {{ ok: boolean, reason?: string, id: any, revision: any, [k: string]: any }}
   */
  let result = { ok: false, reason: PUSH_REASONS.unreachable, id: job.id, revision: job.revision };
  try {
    sweepSay('sending to SillyTavern…');
    const plan = await fetchPlan(settings.serverUrl, settings.pairToken, job.id, job.revision);
    refreshRunLock(); // B.7 — the lease is re-stamped as work happens, never on a timer
    if (!plan.ok) {
      // `locked` has no sentence of its own from Vocalis; everything else already carries
      // one written for the user to read.
      result.reason = plan.locked ? 'the Vocalis vault is locked' : String(plan.reason || '');
      return;
    }
    result = { ...(await writePlan(plan)), id: job.id, revision: job.revision };
  } catch (e) {
    // OUR exception's message would be safe, but the habit is what keeps a lorebook window out
    // of a UI string — so the detail goes to the console and a fixed phrase goes across.
    console.error('[Vocalis] send failed', e);
    result = { ok: false, reason: PUSH_REASONS.unreachable, id: job.id, revision: job.revision };
  } finally {
    pushing = false;
    sweepSay(result.ok ? 'sent from Vocalis' : `send failed: ${result.reason}`, result.ok ? 'ok' : 'fail');
    await pushDone(settings.serverUrl, settings.pairToken, result);
  }
}

// Bound calls to SillyTavern so a stalled request cannot permanently block polling or writes.
// The timeout is a deadlock guard, not a latency target.
const ST_CALL_TIMEOUT_MS = 60000;

/** `fetch` with a ceiling. An abort rejects with `AbortError`, which every caller here already
 *  maps to `PUSH_REASONS.unreachable` — "SillyTavern did not answer" is exactly true.
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} timeoutMs
 */
async function stFetch(url, init, timeoutMs = ST_CALL_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t ?? undefined);
  }
}

/** Bound a SillyTavern promise that cannot be aborted. A timeout ends only our wait;
 * the operation may still complete, so callers must report an unknown outcome.
 * @param {any} promise - wrapped in Promise.resolve, so a bare value is fine
 * @param {number} timeoutMs
 */
function withTimeout(promise, timeoutMs = ST_CALL_TIMEOUT_MS) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let t = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t ?? undefined)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error('SillyTavern did not answer')), timeoutMs);
    }),
  ]);
}

/** Dynamically load SillyTavern's own `script.js`, which this extension does not ship.
 * Keep optional repaint integration isolated so a moved module cannot prevent pairing or
 * narration features from loading.
 */
async function stScript() {
  return await import('/script.js');
}

/** SillyTavern's own persona module, on exactly the terms in {@link stScript}. */
async function stPersonas() {
  return await import('/scripts/personas.js');
}

/** Refresh displayed copies of an avatar after its file is written. SillyTavern's
 * `bustAvatarThumbnails` owns thumbnail URL construction; also prime the full-size image
 * used by its zoom and focus controls. This is best-effort and runs after the write lands.
 * @param {'character'|'persona'} kind Which entity the file belongs to
 * @param {string} file SillyTavern's own avatar filename, `<something>.png`
 */
async function bustAvatar(kind, file) {
  if (!file) return;
  try {
    // `getUserAvatar` rather than a hand-built `User Avatars/<file>`: their constant is not
    // exported, and a prime that lands on a different string is a cache entry nobody reads.
    const full = kind === 'persona' ? (await stPersonas()).getUserAvatar(file) : `/characters/${encodeURIComponent(file)}`;
    await withTimeout(fetch(full, { method: 'GET', cache: 'reload' }));
  } catch (e) {
    console.warn('[Vocalis] could not re-prime the full-size avatar; the zoomed view needs a refresh', e);
  }
  try {
    const script = await stScript();
    if (typeof script.bustAvatarThumbnails !== 'function') {
      console.warn('[Vocalis] script.js has no bustAvatarThumbnails — the new picture needs a refresh');
      return;
    }
    await withTimeout(script.bustAvatarThumbnails(kind, file));
  } catch (e) {
    console.warn('[Vocalis] could not repaint the avatar; the new picture needs a refresh', e);
  }
}

/** Dispatch on the plan's kind. Each branch returns `{ ok, reason?, created?, reloaded? }`.
 * @param {Record<string, any>} plan
 */
async function writePlan(plan) {
  if (plan.kind === 'worldbook') return await writeBook(plan);
  if (plan.kind === 'card') return await writeCard(plan);
  if (plan.kind === 'persona') return await writePersona(plan);
  return { ok: false, reason: PUSH_REASONS.unsupported };
}

/** A World Book, through the fork's own front-end path.
 *
 * 🔴 `immediately = true`, AND THE RETURN IS CHECKED. The default is debounced and returns `true`
 * unconditionally — it has not talked to the server yet, so its answer is about nothing. §6.3.2
 * means a confirmation is needed when it was applied, and a confirmation that only means
 * "we queued something" is one he would have to learn to distrust.
 *
 * ⚠️ THE OPEN EDITOR IS REFRESHED, NOT FORCED OPEN. `reloadWorldInfoEditor(name)` reloads only if
 * that book is the one currently selected — so a Send lands visibly when he is looking at it and
 * does not yank his editor onto a different book when he is not. That is §6.3.2's "if it is cheap,
 * the open ST editor picks up the new content in place".

 * @param {Record<string, any>} plan
 */
async function writeBook(plan) {
  const known = typeof ctx().getWorldInfoNames === 'function' ? ctx().getWorldInfoNames() : [];
  const created = !known.includes(plan.target);
  let ok;
  try {
    // 🔴 BOUNDED — B.6. Their call carries its own un-abortable request, so all we can do is
    // stop waiting on it; doing nothing left `pushing` true for the life of the page.
    ok = await withTimeout(ctx().saveWorldInfo(plan.target, plan.book, true));
  } catch (e) {
    console.error('[Vocalis] saveWorldInfo', e);
    return { ok: false, reason: PUSH_REASONS.unreachable };
  }
  if (ok === false) return { ok: false, reason: PUSH_REASONS.refused };

  // A book SillyTavern has never seen is not in the dropdown until the list is refetched, and a
  // book he cannot select is, to him, a send that did nothing.
  if (created && typeof ctx().updateWorldInfoList === 'function') {
    try {
      await withTimeout(ctx().updateWorldInfoList());
    } catch (e) {
      console.warn('[Vocalis]', e);
    }
  }
  let reloaded = false;
  if (typeof ctx().reloadWorldInfoEditor === 'function') {
    try {
      ctx().reloadWorldInfoEditor(plan.target);
      reloaded = true;
    } catch (e) {
      console.warn('[Vocalis]', e);
    }
  }
  return { ok: true, created, reloaded };
}

/** Import a new character card with SillyTavern's native importer.
 *
 * `/api/characters/import` accepts the complete V2 card, including `data.character_book`, and
 * returns `{file_name}` (the avatar filename without `.png`). Use the returned `ref` as the
 * identity: `getPngName` disambiguates collisions, such as `Sample Character` and
 * `Sample Character2`.
 *
 * After import, upload any supplied picture through `/edit-avatar`. That endpoint re-embeds the
 * current card data into the image, so it must run after the card exists. Report picture failure
 * separately because the character may already have been created; retrying the whole send could
 * create a duplicate.

 * @param {Record<string, any>} plan
 */
async function createCard(plan) {
  const name = String(plan.name || (plan.card && plan.card.data && plan.card.data.name) || 'card');
  const form = new FormData();
  // ⚠️ The FILENAME's extension is not decoration — their front end derives `file_type` from it
  // and we send the same value explicitly. `.json` and `file_type: 'json'` have to agree, or
  // `formatImportFunctions[format]` picks the wrong reader.
  form.append('avatar', new Blob([JSON.stringify(plan.card)], { type: 'application/json' }), `${name}.json`);
  form.append('file_type', 'json');
  // Their own caller sends this (`script.js:11417`); it is the user's persona name, used by the
  // importers that substitute {{user}}. Absent, some of them build a card that says "undefined".
  form.append('user_name', String(ctx().name1 || ''));
  let r;
  try {
    r = await stFetch('/api/characters/import', {
      method: 'POST',
      headers: ctx().getRequestHeaders({ omitContentType: true }),
      body: form,
    });
  } catch (e) {
    console.error('[Vocalis] characters/import', e);
    return { ok: false, reason: PUSH_REASONS.unreachable };
  }
  if (!r.ok) {
    console.error('[Vocalis] characters/import refused the card', await r.text().catch(() => ''));
    return { ok: false, reason: r.status === 400 ? PUSH_REASONS.invalid : PUSH_REASONS.refused };
  }
  // 🔴 A 200 IS NOT A SUCCESS HERE. Their handler catches its own errors and answers
  // `{error: true}` with status 200 (`characters.js:1903`), and returns `{file_name: ''}` when
  // the writer failed. Reporting "created" off the status alone would tell the user their character is
  // in SillyTavern when nothing was written — the exact class of cheerful lie §6.3.2 exists to
  // prevent.
  /** @type {Record<string, any>} */
  let body = {};
  try {
    body = await r.json();
  } catch (e) {
    body = {};
  }
  const fileName = String(body && body.file_name ? body.file_name : '');
  if (!fileName || body.error) {
    console.error('[Vocalis] characters/import answered without a filename', body);
    return { ok: false, reason: PUSH_REASONS.refused };
  }
  const ref = `${fileName}.png`;

  // Refresh as soon as the importer confirms that the card exists. The optional avatar transfer
  // below can fail after the card has landed; returning from either picture-error branch before
  // this refresh left a newly-created character absent from SillyTavern until a hard reload.
  if (typeof ctx().getCharacters === 'function') {
    try {
      await withTimeout(ctx().getCharacters());
    } catch (e) {
      console.warn('[Vocalis]', e);
    }
  }

  let sentAvatar = false;
  if (plan.avatar) {
    const got = await fetchAvatar(settings.serverUrl, settings.pairToken, plan.id);
    if (!got.ok) {
      console.error('[Vocalis] could not fetch the avatar from Vocalis', got.reason);
      return { ok: false, reason: PUSH_REASONS.picture, created: true, ref };
    }
    const img = new FormData();
    img.append('avatar', /** @type {Blob} */ (got.blob), 'avatar.png');
    img.append('avatar_url', ref);
    try {
      const a = await stFetch('/api/characters/edit-avatar', {
        method: 'POST',
        headers: ctx().getRequestHeaders({ omitContentType: true }),
        body: img,
      });
      if (!a.ok) {
        console.error('[Vocalis] edit-avatar refused the image', await a.text().catch(() => ''));
        return { ok: false, reason: PUSH_REASONS.picture, created: true, ref };
      }
      sentAvatar = true;
    } catch (e) {
      console.error('[Vocalis] edit-avatar', e);
      return { ok: false, reason: PUSH_REASONS.picture, created: true, ref };
    }
  }

  // ⚠️ A CREATE IS NOT EXEMPT FROM THE STALE CACHE, AND IT IS THE ONE CASE THAT LOOKS LIKE IT
  // SHOULD BE. Their importer writes the gray placeholder face, and the `getCharacters()` above
  // has already painted it under this exact filename — so by the time `/edit-avatar` lands, the
  // browser is holding a picture of a card that is one second old. See {@link bustAvatar}.
  if (sentAvatar) await bustAvatar('character', ref);

  return { ok: true, created: true, ref, wrote: name, reloaded: true, avatar: sentAvatar };
}

/** A character card, through `merge-attributes` and nothing else.
 *
 * 🔴 NOT `/api/characters/edit`: it runs `charaFormatData` on the way in, which stamps the linked
 * World Book over whatever `character_book` the request carried and needs the whole form, so a
 * partial edit blanks every field we did not send. NOT `/create`: it writes a gray placeholder
 * face. `merge-attributes` deep-merges into the raw PNG chunk and leaves the other forty fields
 * alone — it is the only endpoint that can do what this button promises.

 * @param {Record<string, any>} plan
 */
async function writeCard(plan) {
  // §9a.33 — no card over there to merge into, so make one. The SERVER decides which it is
  // (`st_write._card_plan` keys it on `st_ref`); this branch never guesses from the roster,
  // because a name that happens to match is not the same character.
  if (plan.create) return await createCard(plan);
  // 🔴 "IT IS NOT THERE" IS NOT "IT IS INVALID", AND THEIR ERROR CANNOT TELL THEM APART.
  // `mergeCharacterUpdate` reads the PNG first and answers `{ok: false, error: 'Invalid
  // character file'}` for a file that does not exist — a 400, indistinguishable from a card that
  // failed validation. Deleting a character in SillyTavern and then pressing Save in
  // Vocalis is the ordinary way to reach this, and "SillyTavern rejected the document as
  // invalid" would send him looking for a fault in a card that is simply gone. The roster is
  // already in memory, so the check costs nothing.
  const roster = ctx().characters;
  if (Array.isArray(roster) && roster.length && !roster.some(c => c && c.avatar === plan.target)) {
    return { ok: false, reason: PUSH_REASONS.missing };
  }
  let r;
  try {
    // 🔴 `stFetch`, NOT `fetch` — B.6. A hung merge left `pushing` true forever.
    r = await stFetch('/api/characters/merge-attributes', {
      method: 'POST',
      headers: ctx().getRequestHeaders(),
      body: JSON.stringify(plan.merge),
    });
  } catch (e) {
    console.error('[Vocalis] merge-attributes', e);
    return { ok: false, reason: PUSH_REASONS.unreachable };
  }
  if (r.status === 400) {
    // Their body carries the validator's own string and the avatar filename. It goes to the
    // console; a fixed phrase goes to Vocalis.
    console.error('[Vocalis] merge-attributes rejected the card', await r.text().catch(() => ''));
    return { ok: false, reason: PUSH_REASONS.invalid };
  }
  if (!r.ok) return { ok: false, reason: PUSH_REASONS.refused };

  // m4o — the picture, when Vocalis says its copy is the newer one. AFTER the merge, never
  // before: `/edit-avatar` reads the card data out of the CURRENT PNG and re-embeds it into the
  // new image, so doing it first would copy the pre-edit text into the new file and the merge
  // would then have to land on top of that. This order means the fields are already right when
  // the image is swapped, and — the part that makes this safe — we never send a text field at
  // all. Their endpoint carries them across itself.
  let sentAvatar = false;
  if (plan.avatar) {
    const got = await fetchAvatar(settings.serverUrl, settings.pairToken, plan.id);
    if (!got.ok) {
      console.error('[Vocalis] could not fetch the avatar from Vocalis', got.reason);
      // Text changes already landed; report the missing avatar separately so the partial result is clear.
      return { ok: false, reason: PUSH_REASONS.picture };
    }
    const form = new FormData();
    form.append('avatar', /** @type {Blob} */ (got.blob), 'avatar.png');
    form.append('avatar_url', plan.target);
    try {
      // ⚠️ `omitContentType` — a FormData must set its own multipart boundary, and their
      // own caller does exactly this (`slash-commands.js:5139`).
      const a = await stFetch('/api/characters/edit-avatar', {
        method: 'POST',
        headers: ctx().getRequestHeaders({ omitContentType: true }),
        body: form,
      });
      if (!a.ok) {
        console.error('[Vocalis] edit-avatar refused the image', await a.text().catch(() => ''));
        return { ok: false, reason: PUSH_REASONS.picture };
      }
      sentAvatar = true;
    } catch (e) {
      console.error('[Vocalis] edit-avatar', e);
      return { ok: false, reason: PUSH_REASONS.picture };
    }
  }

  // The roster holds a parsed copy of every card; without this the Vocalis edit is on disk and
  // the character panel in front of him still shows the old text until a reload.
  if (typeof ctx().getCharacters === 'function') {
    try {
      await withTimeout(ctx().getCharacters());
    } catch (e) {
      console.warn('[Vocalis]', e);
    }
  }
  // AFTER the roster refetch, never before: a bust repaints the `<img>` elements that exist at
  // the moment it runs, and `getCharacters()` replaces them. Running it first is not WRONG — the
  // canonical URLs it primes are what the new markup asks for — but it leaves the outcome resting
  // on the prime alone, and there is no reason to spend that. See {@link bustAvatar}.
  if (sentAvatar) await bustAvatar('character', plan.target);
  // Report the name from the outgoing card, which is what this merge writes.
  const merged = plan.merge || {};
  const wrote = String((merged.data && merged.data.name) || merged.name || plan.name || '');
  return { ok: true, wrote, reloaded: true, avatar: sentAvatar };
}

/** Wait for the debounced settings write and verify the result from `/api/settings/get`.
 * Poll rather than sleeping for the debounce interval, which can restart after other writes.
 * Keep `saveSettingsDebounced` as the commit path; a direct save could overwrite concurrent
 * in-memory settings.

 * @param {(pus: Record<string, any>) => boolean} check
 */
async function settingsLanded(check) {
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const s = await stFetch('/api/settings/get', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({}),
      });
      if (!s.ok) continue;
      const body = await s.json();
      const saved = JSON.parse(String(body && body.settings ? body.settings : '{}'));
      if (check((saved && saved.power_user) || {})) return true;
    } catch (e) {
      /* keep polling; the ceiling is what ends this */
    }
  }
  return false;
}

/** Check whether the avatar filename is available to the persona panel. A failed fetch
 * is inconclusive and must not be treated as confirmation of a successful write.
 * @param {string} ref
 */
async function avatarFiled(ref) {
  try {
    const r = await stFetch('/api/avatars/get', {
      method: 'POST',
      headers: ctx().getRequestHeaders({ omitContentType: true }),
    });
    if (!r.ok) return false;
    const list = await r.json();
    return Array.isArray(list) && list.some(f => String(f) === ref);
  } catch (e) {
    console.error('[Vocalis] avatars/get', e);
    return false;
  }
}

/** Create a persona using SillyTavern's `power_user` identity map and descriptor shape.
 * Check for key collisions before writing. Store both keys before uploading the avatar so
 * `addMissingPersonas` cannot adopt an unclaimed file; roll back the keys if upload fails.
 * Upload a supplied avatar or SillyTavern's default image because its UI requires one.
 * Descriptor defaults mirror `initPersona`: position 0, depth 2, role 0, empty lorebook.

 * @param {Record<string, any>} plan
 */
async function createPersona(plan) {
  const pu = ctx().powerUserSettings;
  if (!pu || !pu.personas || !pu.persona_descriptions) {
    return { ok: false, reason: PUSH_REASONS.unsupported };
  }
  const name = String(plan.name || '').trim() || 'Persona';
  const base = `${Date.now()}-${name.replace(/[^a-zA-Z0-9]/g, '')}`;
  let ref = `${base}.png`;
  for (let i = 2; Object.prototype.hasOwnProperty.call(pu.personas, ref); i++) {
    ref = `${base}-${i}.png`;
  }

  // Ours if we have one, theirs if we do not. A fetch that fails is NOT fatal here — the
  // persona is worth creating with the default face, and `avatar: false` in the answer is what
  // tells the user the picture did not travel.
  let blob = null;
  if (plan.avatar) {
    const got = await fetchAvatar(settings.serverUrl, settings.pairToken, plan.id);
    if (got.ok) blob = got.blob;
    else console.error('[Vocalis] could not fetch the persona avatar from Vocalis', got.reason);
  }
  if (!blob) {
    try {
      const d = await stFetch('/img/user-default.png');
      if (d.ok) blob = await d.blob();
    } catch (e) {
      console.error('[Vocalis] default avatar', e);
    }
  }
  if (!blob) return { ok: false, reason: PUSH_REASONS.picture };

  // ── the two keys, BEFORE the picture — see the note above for why this order ─────────────
  const fields = plan.persona || {};
  pu.personas[ref] = name;
  pu.persona_descriptions[ref] = {
    description: String(fields.description || ''),
    title: String(fields.title || ''),
    position: 0, // persona_description_positions.IN_PROMPT
    depth: 2, // DEFAULT_DEPTH
    role: 0, // DEFAULT_ROLE
    lorebook: '',
  };
  // ⚠️ NOT COMMITTED YET. `saveSettingsDebounced` waits until the picture is known to have
  // landed, so a failed upload can be rolled back without a write of the doomed state ever
  // having been scheduled.
  const rollback = () => {
    delete pu.personas[ref];
    delete pu.persona_descriptions[ref];
  };

  const form = new FormData();
  form.append('avatar', new File([blob], 'avatar.png', { type: 'image/png' }));
  // Their `uploadUserAvatar` sends this to pin the stored filename; without it the server names
  // the file itself and the ref we just keyed would point at nothing.
  form.append('overwrite_name', ref);
  let up;
  try {
    up = await stFetch('/api/avatars/upload', {
      method: 'POST',
      headers: ctx().getRequestHeaders({ omitContentType: true }),
      cache: 'no-cache',
      body: form,
    });
  } catch (e) {
    console.error('[Vocalis] avatars/upload', e);
    rollback();
    return { ok: false, reason: PUSH_REASONS.unreachable };
  }
  if (!up.ok) {
    console.error('[Vocalis] avatars/upload refused the image', await up.text().catch(() => ''));
    rollback();
    return { ok: false, reason: up.status === 400 ? PUSH_REASONS.invalid : PUSH_REASONS.refused };
  }
  // 🔴 THE SERVER GETS THE LAST WORD ON THE FILENAME. `overwrite_name` is a request, and their
  // handler answers with the path it actually wrote. Keeping the name we ASKED for, when it
  // answered with another, is how a persona ends up keyed to a file that is not its own — so
  // when they differ the keys are MOVED rather than left behind, which also closes the same
  // `addMissingPersonas` window on the name their server actually chose.
  /** @type {Record<string, any>} */
  let updBody = {};
  try {
    updBody = await up.json();
  } catch (e) {
    updBody = {};
  }
  const served = updBody && updBody.path ? String(updBody.path) : '';
  if (served && served !== ref) {
    pu.personas[served] = pu.personas[ref];
    pu.persona_descriptions[served] = pu.persona_descriptions[ref];
    delete pu.personas[ref];
    delete pu.persona_descriptions[ref];
    ref = served;
  }
  ctx().saveSettingsDebounced();
  // Their own `initPersona` emits this and other extensions listen for it. Guarded: the event
  // is not worth failing a create that has already landed in `power_user`.
  try {
    const e = ctx().eventSource,
      t = ctx().event_types;
    if (e && t && t.PERSONA_CREATED) {
      await withTimeout(
        e.emit(t.PERSONA_CREATED, {
          avatarId: ref,
          name,
          description: String(fields.description || ''),
          title: String(fields.title || ''),
        }),
      );
    }
  } catch (e) {
    console.warn('[Vocalis] PERSONA_CREATED', e);
  }

  // `createPersona` schedules a debounced settings write. Confirm it landed before returning the
  // ref, or Vocalis may adopt a persona that a later merge cannot find.
  const landed = await settingsLanded(pus => Boolean(pus.personas && pus.personas[ref]));
  // 🔴 9.5.16 — AND THE FILE, BECAUSE THE PANEL IS BUILT FROM THE FILES AND NOT FROM THE KEYS.
  // `settingsLanded` proves `power_user.personas[ref]` reached settings.json, which is what this
  // function has always checked — and it is the WRONG STORE for the question a person asks, which
  // is "is my persona there". `getUserAvatars()` fetches `/api/avatars/get` and renders one row
  // per FILE; `addMissingPersonas` then adds a key for any file that lacks one. Nothing runs the
  // other way. So a key with no file is a persona that exists, verifies, and never appears — and
  // reporting "created in SillyTavern" over it is the cheerful lie this whole path is built to
  // avoid.
  const filed = landed ? await avatarFiled(ref) : false;
  console.log('[Vocalis] persona create:', JSON.stringify({ ref, landed, filed, servedDiffered: served !== '' && served !== ref }));
  if (landed && !filed) {
    // 🔴 ROLLED BACK, NOT LEFT HALF-MADE. Two keys pointing at a file that is not there is a
    // persona nothing can render and nothing will clean up, and he would have no way to see it in
    // order to delete it. Undo them and say what happened, so pressing Save again is a clean
    // retry rather than a second invisible entry.
    console.error('[Vocalis] the persona landed in settings.json but its picture is not in /api/avatars/get', ref);
    rollback();
    ctx().saveSettingsDebounced();
    return { ok: false, reason: PUSH_REASONS.unseen };
  }
  if (!landed) {
    // 🔴 NO `ref` IN THIS ANSWER, and that is the whole point of the branch. `pair.py` adopts
    // any ref it is given — deliberately, since `createCard` reports one for a character that
    // landed without its picture. Reporting one here would be adopting a persona that is not
    // in settings.json, which is precisely the dead end above. Say it failed and let him press
    // Save again: the document still has no st_ref, so the retry is another CREATE.
    console.error('[Vocalis] the persona never reached settings.json', ref);
    return { ok: false, reason: PUSH_REASONS.refused };
  }
  // Register only after BOTH durable landing checks, and use the final filename returned by
  // SillyTavern rather than the one we requested. This makes a Vocalis-imported persona
  // assignable in Character Voices before any narration while preserving the registry's
  // avatar-based duplicate-name identity. Registration is availability-only: the persona is
  // already safely landed, so a temporarily unreachable Vocalis must not turn the import into
  // a failure. Keep diagnostics to the operation and error class — never persona prose/token.
  try {
    await withTimeout(registerCharacters(settings.serverUrl, [{ name, avatar: ref }], settings.pairToken), 5000);
  } catch (e) {
    console.warn('[Vocalis] persona landed but Character Voices registration failed', errClass(e));
  }
  // 🔴 9.5.19 — REPAINT THE PANEL AND PAGE TO THE NEW PERSONA.
  //
  // ⚠️ AND NO `bustAvatar` HERE, WHICH IS A DECISION AND NOT AN OMISSION. Its three siblings all
  // write over a filename the page has already rendered; `ref` was minted from `Date.now()` a few
  // lines up and checked against `power_user.personas`, so no cache on either side of the wire has
  // ever been asked for it. A bust here could not do anything, and a call that can never do
  // anything reads as cover.
  //
  // `getUserAvatars(true, ref)` re-fetches `/api/avatars/get`, re-renders `#user_avatar_block`,
  // and navigates to the page containing `ref` — which is both halves of what went wrong today,
  // since the list paginates at FIVE and a sixth persona rendered one page across. SillyTavern's
  // own `createDummyPersona` calls exactly this.
  //
  // ⚠️ DYNAMIC AND CAUGHT. The top of this file already imports from `/scripts/narration-player-
  // bar.js`, so reaching into their scripts is established here — but a STATIC import that 404s
  // takes the whole extension down, and this is a repaint. A SillyTavern that moves `personas.js`
  // must cost a refresh, never the pairing channel.
  //
  // ⚠️ AFTER the landing checks above, never before: those are what make the success report true,
  // and repainting first would put a row on screen for a persona about to be rolled back.
  try {
    const personas = await stPersonas();
    if (typeof personas.getUserAvatars === 'function') {
      await withTimeout(personas.getUserAvatars(true, ref));
    } else {
      console.warn('[Vocalis] personas.js has no getUserAvatars — the list needs a refresh');
    }
  } catch (e) {
    console.warn('[Vocalis] could not repaint the persona list; it needs a refresh', e);
  }
  return { ok: true, created: true, ref, wrote: name, avatar: Boolean(plan.avatar && blob) };
}

/** Update only persona keys managed by Vocalis, preserving other descriptor fields.
 * A null title means delete that key, matching SillyTavern's editor. Do not recreate a
 * persona removed from SillyTavern. Commit with `saveSettingsDebounced`, which avoids
 * replacing the full settings document and racing other tab interactions.

 * @param {Record<string, any>} plan
 */
async function writePersona(plan) {
  // Log routing facts for diagnosis, but never persona text; console output may be shared.
  console.log(
    '[Vocalis] persona write:',
    JSON.stringify({
      create: plan.create === true,
      target: plan.target || '',
      name: plan.name || '',
      picture: plan.avatar === true,
      fields: Object.keys(plan.persona || {}),
      // No sentinel: an empty target is simply not a key, and the placeholder that stood here
      // put a RAW NUL in this file - which makes grep and ripgrep treat the whole thing as
      // binary and silently skip it. `test_source_bytes.py` caught it; the answer is not to
      // escape the byte but to stop needing one.
      known: Boolean(plan.target) && Object.prototype.hasOwnProperty.call((ctx().powerUserSettings || {}).personas || {}, plan.target),
    }),
  );
  // §9a.11 — no persona over there to edit, so make one. The SERVER decides which it is
  // (`st_write._persona_plan` keys it on `st_ref`); this branch never guesses from
  // `power_user.personas`, because a display name that happens to match is not the same persona
  // — the avatar filename is the identity and a name is not.
  if (plan.create) return await createPersona(plan);
  const pu = ctx().powerUserSettings;
  if (!pu || !pu.personas || !pu.persona_descriptions) {
    return { ok: false, reason: PUSH_REASONS.unsupported };
  }
  if (!(plan.target in pu.personas) || !pu.persona_descriptions[plan.target]) {
    return { ok: false, reason: PUSH_REASONS.missing };
  }
  const d = pu.persona_descriptions[plan.target];
  // 🔴 CAPTURED BEFORE THE WRITE — it is how we recognize the ACTIVE persona. See below.
  const wasDescription = d.description ?? '';
  for (const [k, v] of Object.entries(plan.persona || {})) {
    if (v === null) delete d[k];
    else d[k] = v;
  }
  syncActivePersona(plan.target, wasDescription, pu);
  ctx().saveSettingsDebounced();

  // 🔴 THE SAME SMALL LIE ABOUT SUCCESS THE CREATE BRANCH TOLD, and it is fixed the same way.
  // Lower stakes than a create — no `st_ref` is adopted off a merge, so there is no dead end,
  // only an edit the user is told landed and would have to notice was gone and redo. A confirmation
  // must never do that, and §6.3.2 requires a confirmation
  // that means something.
  //
  // 🔴 THE PREDICATE IS THE FIELDS WE WROTE, NOT THE KEY'S EXISTENCE. On a create, `personas[ref]`
  // appearing at all is proof, because it was not there before. On a merge the key was ALREADY
  // there and already saved, so checking for it would pass against the pre-edit settings.json and
  // make this whole wait vacuous — it has to be the values.
  //
  // ⚠️ `null` MEANS THE KEY IS GONE, matching `_persona_plan`'s delete convention. A landed
  // delete is an ABSENT key, so testing `saved[k] === v` against `null` would wait out the full
  // ceiling on every send that clears a title and then report a failure that did not happen.
  const wrote = Object.entries(plan.persona || {});
  const ok = await settingsLanded(pus => {
    const d2 = pus.persona_descriptions && pus.persona_descriptions[plan.target];
    if (!d2) return false;
    return wrote.every(([k, v]) => (v === null ? !Object.prototype.hasOwnProperty.call(d2, k) : d2[k] === v));
  });
  console.log('[Vocalis] persona merge:', JSON.stringify({ target: plan.target, landed: ok }));
  if (!ok) {
    console.error('[Vocalis] the persona edit never reached settings.json', plan.target);
    return { ok: false, reason: PUSH_REASONS.refused };
  }
  // 🔴 9.5.14 — AND THE PICTURE, WHICH THIS BRANCH HAS NEVER SENT. `⬆ Upload PNG` on a persona
  // SillyTavern already knows, then Save, reported "saved to SillyTavern" and dropped the image:
  // there was no `avatar` flag on the merge plan and not one line about a picture down here. It
  // was unreachable until 9.5.12 made that button visible on a pictureless document, and it
  // became the ordinary path the same day.
  //
  // 🔴 AFTER the descriptor, not before. The text is the thing he edited and it is already
  // committed by the time this runs, so a refused upload costs the picture and nothing else —
  // `PUSH_REASONS.picture` says exactly that ("the text was saved, but the picture did not go
  // through") and `pair.py` leaves `avatar_dirty` SET on that answer, so the next Save carries
  // the image again rather than silently forgetting it.
  //
  // ⚠️ `overwrite_name` IS THE EXISTING REF, WHICH IS THE WHOLE POINT: their handler writes
  // `sanitize(overwrite_name)` and busts the thumbnail, so the persona keeps its identity and its
  // face changes underneath it. Minting a new filename here would orphan the persona.
  let sentAvatar = false;
  if (plan.avatar) {
    const got = await fetchAvatar(settings.serverUrl, settings.pairToken, plan.id);
    if (!got.ok) {
      console.error('[Vocalis] could not fetch the persona picture from Vocalis', got.reason);
      return { ok: false, reason: PUSH_REASONS.picture, wrote: String(pu.personas[plan.target] || '') };
    }
    const form = new FormData();
    form.append('avatar', new File([/** @type {Blob} */ (got.blob)], 'avatar.png', { type: 'image/png' }));
    form.append('overwrite_name', plan.target);
    try {
      const up = await stFetch('/api/avatars/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
        body: form,
      });
      if (!up.ok) {
        console.error('[Vocalis] avatars/upload refused the persona picture', await up.text().catch(() => ''));
        return { ok: false, reason: PUSH_REASONS.picture, wrote: String(pu.personas[plan.target] || '') };
      }
      sentAvatar = true;
    } catch (e) {
      console.error('[Vocalis] avatars/upload', e);
      return { ok: false, reason: PUSH_REASONS.picture, wrote: String(pu.personas[plan.target] || '') };
    }
    // 🔴 NO REFETCH HERE, AND THE OBVIOUS ONE WOULD HAVE BEEN DEAD CODE. `getUserAvatars` is what
    // repaints the persona panel, and it is NOT on `getContext()` — a
    // `typeof ctx().getUserAvatars === 'function'` guard around it is permanently false, so it
    // would have read as a refresh and never run once. tsc caught the name; the guard would have
    // hidden it at runtime. There is no PERSONA_UPDATED event to emit either. The refetch this
    // paragraph rejected is below, reached through `stPersonas()` rather than through `ctx()`.
    //
    // ⚠️ THE SECOND HALF OF THIS PARAGRAPH USED TO SAY THAT NOTHING WAS INVISIBLE WITHOUT IT —
    // *"their upload handler calls `invalidateThumbnail` and busts the cache itself, so it is
    // correct on the next paint"*. THAT IS WRONG, and it was wrong about which cache. 9.5.19
    // already contradicted its first half; the browser may still reuse the unchanged URL until it
    // is explicitly busted.
    // `invalidateThumbnail` drops the server's crop of the picture, so the next REQUEST is
    // correct — but the URL never changes, so the browser does not make one. See
    // {@link bustAvatar}, which is what makes the next paint true.
  }
  // 🔴 WHICH PERSONA. A merge changes one that already exists, and the pane's line used to say
  // only "saved to SillyTavern" — indistinguishable from a create to anyone reading it, including
  // its author. `pu.personas[target]` is SillyTavern's own display name for the row he will go
  // and look at, so it is the one string that makes the message checkable.
  // The same repaint, and only when the PICTURE changed: a merge edits a row that is already on
  // screen, so its text is not what goes stale — the face is. 9.5.15 is what made a merge able to
  // carry one at all, so this is that fix finishing its own job.
  if (sentAvatar) {
    try {
      const personas = await stPersonas();
      if (typeof personas.getUserAvatars === 'function') await withTimeout(personas.getUserAvatars(true));
    } catch (e) {
      console.warn('[Vocalis] could not repaint the persona list; its picture needs a refresh', e);
    }
    // 🔴 AND THE REPAINT IS ONLY HALF OF IT. The row above comes back from `/api/avatars/get`
    // carrying the same URL it had before, so on its own it re-renders the old face into new
    // markup — the persona panel, the chat, and every message this persona has ever spoken in.
    // AFTER the refetch, for the reason in `writeCard`.
    await bustAvatar('persona', plan.target);
  }
  return { ok: true, wrote: String(pu.personas[plan.target] || ''), avatar: sentAvatar };
}

/** Mirror a changed descriptor into SillyTavern's active-persona fields and textarea.
 * The prompt reads the flat fields, while the input handler reads the textarea; updating
 * both prevents stale UI state from overwriting the descriptor. Detect the active persona
 * from its current description because `user_avatar` and `setPersonaDescription` are not
 * exposed through `getContext()`. The caller owns the settings commit.

 * @param {string} target
 * @param {boolean} wasDescription
 * @param {Record<string, any>} pu
 */
function syncActivePersona(target, wasDescription, pu) {
  if ((pu.persona_description ?? '') !== wasDescription) return; // not the active persona
  const d = pu.persona_descriptions[target] || {};
  pu.persona_description = d.description ?? '';
  if ('position' in d) pu.persona_description_position = d.position;
  if ('depth' in d) pu.persona_description_depth = d.depth;
  if ('role' in d) pu.persona_description_role = d.role;
  if ('lorebook' in d) pu.persona_description_lorebook = d.lorebook ?? '';
  // The visible box, if the Persona panel is open. Guarded rather than assumed: this reaches
  // into SillyTavern's DOM, and a renamed id must degrade to "the prompt is right and the
  // panel is stale until he reopens it", never to a thrown exception mid-send.
  try {
    const box = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('persona_description'));
    if (box && box.value !== pu.persona_description) box.value = pu.persona_description;
  } catch {
    /* the panel is not open, or the id moved — the flat field above still holds */
  }
}

/**
 * @param {SweepTally} tally
 */
async function sweepBooks(tally) {
  const names = typeof ctx().getWorldInfoNames === 'function' ? ctx().getWorldInfoNames() : [];
  for (const name of names) {
    refreshRunLock(); // B.7 — see the cross-tab lock above
    let doc;
    try {
      // 🔴 Guard this `await`; it used to sit outside any try, and
      // `loadWorldInfo` runs `JSON.parse` on the book: a truncated or half-written file
      // makes V8 throw a SyntaxError whose message QUOTES A WINDOW OF THAT BOOK. It
      // propagated to `runSweep`, landed in `tally.errors`, was POSTed to Vocalis, clamped
      // to 200 characters, stored in the vault and rendered — user content crossing the one
      // boundary contract §9 exists to hold. One unreadable book is also not a reason to
      // abandon the other twelve, which is the second thing the bare `await` got wrong.
      //
      // ⚠️ AND BOUNDED (B.6, extended to the read path): `loadWorldInfo` owns its own
      // request, so a fork that stops answering mid-sweep would otherwise leave
      // `sweeping = true` for the life of the page and this tab deaf from then on.
      doc = await withTimeout(ctx().loadWorldInfo(name));
    } catch (e) {
      console.error('[Vocalis] loadWorldInfo', name, e);
      tally.errors.push(`${name} (unreadable: ${errClass(e)})`);
      continue;
    }
    // 🔴 NULL IS A REFUSED READ, NOT AN EMPTY BOOK, AND THE DIFFERENCE IS HIS CONTENT.
    // `loadWorldInfo` returns null when /api/worldinfo/get answers 409 — the fork's storage
    // provider saying it cannot read the file (world-info.js:2068). Pushing {} on that answer
    // files a plausible empty book over a real one. In a SWEEP this matters more than it did
    // one-at-a-time: an unreadable provider would blank every book in one press.
    if (!doc) {
      tally.errors.push(name);
      continue;
    }
    const r = await pushDocument(settings.serverUrl, settings.pairToken, name, doc);
    if (!r.ok) {
      if (notePushFailure(tally, name, r)) return;
      continue;
    }
    if (r.created || r.revision > 0) tally.books++;
    else tally.unchanged++;
  }
}

// §8.3 — PERSONAS. This runs from the same one press as books and cards (§8.2a).
//
// SillyTavern stores personas in `power_user.personas` and `persona_descriptions`, keyed by avatar
// filename; that stable filename is the Vocalis `st_ref`. This path reads those maps only.
// `/api/settings/save` replaces the full in-memory settings object, so persona writes must use the
// dedicated persona API rather than race unrelated settings changes.
/**
 * @param {SweepTally} tally
 */
async function sweepPersonas(tally) {
  const pu = ctx().powerUserSettings || {};
  const names = pu.personas || {};
  const descs = pu.persona_descriptions || {};
  const avatars = Object.keys(names);
  if (!avatars.length) return;

  for (const avatar of avatars) {
    refreshRunLock(); // B.7 — see the cross-tab lock above
    /** @type {Record<string, any>} */
    const d = descs[avatar] || {};
    // Every field is optional on their side: `title` and `focus` are DELETED rather than
    // blanked when empty, and onboarding writes descriptors carrying only `description` and
    // `position`. So absent stays absent rather than becoming "".
    /** @type {Record<string, any>} */
    const doc = { spec: 'vocalis_persona_v1', avatar, name: String(names[avatar] || '') };
    for (const k of ['description', 'title', 'position', 'depth', 'role', 'lorebook']) {
      if (d[k] !== undefined && d[k] !== null) doc[k] = d[k];
    }
    // A persona with nothing written in it is not worth a Library row — it is the empty
    // placeholder `addMissingPersonas` creates for an orphan PNG.
    if (!String(doc.description || '').trim() && !String(doc.title || '').trim()) continue;

    const sent = await pushDocument(settings.serverUrl, settings.pairToken, avatar, doc);
    if (!sent.ok) {
      if (notePushFailure(tally, names[avatar] || avatar, sent)) return; // B.4
      continue;
    }
    if (sent.created || sent.revision > 0) tally.personas++;
    else tally.unchanged++;

    // Persona images are loose files, so their metadata has no change stamp. Re-fetch on explicit
    // import; `put_avatar` avoids writes for unchanged bytes. Preserve `avatar_dirty` when Vocalis
    // has a newer Library image; this path has no `avatar_ref` comparison like the card path.
    if (!sent.created && sent.avatarDirty) continue;
    try {
      // ⚠️ RELATIVE, exactly as their own `getUserAvatar` builds it
      // (personas.js:139 -> `User Avatars/<file>`). A leading slash would break the day
      // SillyTavern is served under a subpath, which is how their <img> tags already work.
      const r = await stFetch(`User Avatars/${encodeURIComponent(avatar)}`, {
        headers: ctx().getRequestHeaders(),
      });
      if (!r.ok) {
        tally.errors.push(`${names[avatar] || avatar} (picture: HTTP ${r.status})`);
        continue;
      }
      const up = await pushAvatar(settings.serverUrl, settings.pairToken, sent.id, await r.blob());
      if (!up.ok) tally.errors.push(`${names[avatar] || avatar} (picture)`);
    } catch (e) {
      // The CLASS, never the message — B.5. `e.message` here is SillyTavern's, and this
      // string is POSTed to Vocalis and rendered there.
      console.error('[Vocalis] persona picture', avatar, e);
      tally.errors.push(`${names[avatar] || avatar} (picture: ${errClass(e)})`);
    }
  }
}

/**
 * @param {SweepTally} tally
 */
async function sweepCards(tally) {
  let rows;
  try {
    const r = await stFetch('/api/characters/all', {
      method: 'POST',
      headers: ctx().getRequestHeaders(),
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      tally.errors.push(`character list (HTTP ${r.status})`);
      return;
    }
    rows = await r.json();
  } catch (e) {
    // 🔴 THE CLASS, NEVER THE MESSAGE — B.5. `r.json()` is a `JSON.parse` over SillyTavern's
    // response, and V8's SyntaxError quotes a window of what it was parsing: a truncated
    // `/api/characters/all` body would have put a slice of a card into this string,
    // which is POSTed to Vocalis, stored and rendered.
    console.error('[Vocalis] character list', e);
    tally.errors.push(`character list (${errClass(e)})`);
    return;
  }
  if (!Array.isArray(rows)) return;

  for (const row of rows) {
    refreshRunLock(); // B.7 — see the cross-tab lock above
    const avatar = row && row.avatar;
    if (!avatar || avatar === 'none') continue;
    // ⚠️ A `storage.unavailable` row is the fork saying it could not read that card. Sending it
    // would file a stub over a real one — the same 409 rule as the books above (§8.1).
    if (row.storage && row.storage.unavailable) {
      tally.errors.push(row.name || avatar);
      continue;
    }

    // 🔴 READ EACH CARD BACK FROM /get. Under `performance.lazyLoadCharacters` the rows from
    // /all are SHALLOW — no description, no first_mes, no character_book — and sending one
    // files a card that looks complete and is missing most of what a pass edits.
    const card = await fetchCard(avatar);
    if (!card.ok) {
      tally.errors.push(row.name || avatar);
      continue;
    }

    // `date_added` comes from the character file's ctime and changes when `/api/characters/edit-avatar`
    // rewrites it, so it can serve as the avatar change stamp. The import sends it with the card so
    // hand already, with no extra request and no card content in it.
    //
    // ⚠️ IT IS DELIBERATELY LOOSER THAN THE PICTURE. ctime also moves for edits that leave the
    // image alone, so this over-reports change — the cost of which is one re-fetch that
    // Vocalis then discards as identical bytes (`put_avatar`'s same-bytes guard), NOT a
    // spurious `avatar_dirty`. Loose in the safe direction was the whole design choice: the
    // alternative, `has_asset`, was tight in the direction that loses a newly uploaded face.
    const stamp = String(row.date_added || '');
    const sent = await pushDocument(settings.serverUrl, settings.pairToken, avatar, card.doc, stamp);
    if (!sent.ok) {
      if (notePushFailure(tally, row.name || avatar, sent)) return; // B.4
      continue;
    }
    if (sent.created || sent.revision > 0) tally.cards++;
    else tally.unchanged++;

    // §4.3 — the card PNG IS the avatar. Fetched when the card is NEW, **or when Vocalis
    // says it has no picture for it**. The picture is ~700 KB at p50, so re-sending eight of
    // them on every press to overwrite bytes that did not change is minutes of transfer for
    // nothing — that half of the rule stands.
    //
    // Retry when Vocalis lacks the picture, even if the card was created earlier; otherwise one
    // failed avatar POST would make the missing image permanent. The stamp also detects changed
    // images when Vocalis already has an older copy.
    if (!sent.created && sent.avatar) continue;
    const img = await fetchCardPng(avatar);
    // 🔴 SAY WHY. "could not import picture" with no reason is unactionable; a user cannot tell
    // a missing file from a locked vault from a
    // size limit, and it reads as an intermittent bug because it is one row among several.
    // `/api/characters/export` 404s when the avatar file is not in the user's characters
    // directory, which is exactly the case for a permanent assistant whose avatar ships
    // nowhere; a 413 is our own size cap; a 401 is the pairing.
    // ⚠️ I16-SAFE: `fetchCardPng` returns the STATUS and never the body, deliberately — a
    // SillyTavern error body can quote a slice of a card.
    if (!img.ok) {
      tally.errors.push(`${row.name || avatar} (picture: ${img.error || 'failed'})`);
      continue;
    }
    const up = await pushAvatar(settings.serverUrl, settings.pairToken, sent.id, /** @type {Blob} */ (img.blob), stamp);
    if (!up.ok) tally.errors.push(`${row.name || avatar} (picture)`);
  }
}

/** One whole card, preferring the verbatim PNG chunk. */
// 🔴 SILLYTAVERN'S BOOKKEEPING IS NOT PART OF THE CARD, AND IT CHANGES WHEN NOTHING DID.
//
// `/api/characters/get` returns the card WITH fields their server computes per request
// (`processCharacter`, characters.js:519-527): `date_added` and `create_date` from the file's
// ctime, and `chat_size` / `date_last_chat` from the chat directory — which move the moment you
// say anything to that character. Pushing them makes the document differ from the stored revision
// on every sweep, so ONE card mints a pointless revision each press.
//
// The active character's `date_last_chat` and `chat_size` change as the chat changes; omit these
// volatile bookkeeping fields so an unchanged card does not create a new revision on each sweep.
//
// ⚠️ ONLY ON THE FALLBACK PATH. `json_data` is the verbatim PNG chunk and carries none of this;
// §5b's identity test is written against those exact bytes, so it is left strictly alone.
const ST_BOOKKEEPING = ['json_data', 'avatar', 'chid', 'shallow', 'date_added', 'create_date', 'date_last_chat', 'chat_size', 'data_size'];

/**
 * @param {Record<string, any>} row
 */
function withoutBookkeeping(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const k of ST_BOOKKEEPING) delete out[k];
  return out;
}

/**
 * @param {string} avatar
 */
async function fetchCard(avatar) {
  try {
    const r = await stFetch('/api/characters/get', {
      method: 'POST',
      headers: ctx().getRequestHeaders(),
      body: JSON.stringify({ avatar_url: avatar }),
    });
    if (!r.ok) return { ok: false }; // the STATUS only, and we do not even keep it
    const row = await r.json();
    // 🔴 PREFER `json_data` — the verbatim chunk out of the PNG (§8.1). The reconstructed
    // object silently up-converts a V1 card to V2, and §5b's identity test is written against
    // the bytes SillyTavern would export, not against its idea of them.
    if (row && row.json_data) return { ok: true, doc: JSON.parse(row.json_data) };
    return { ok: true, doc: withoutBookkeeping(row) };
  } catch (e) {
    return { ok: false };
  }
}

/** The card PNG as SillyTavern itself would export it.
 *
 * 🔴 `/api/characters/export` WITH `format: 'png'`, NOT the static avatar file. This is the path
 * their own Export button uses, so the bytes are the ones §5b's identity test is written against,
 * and it is the only one that unsets their private fields on the way out. Their writer passes an
 * animated PNG through untouched, which a re-encode on either side would not.

 * @param {string} avatar
 */
async function fetchCardPng(avatar) {
  try {
    const r = await stFetch('/api/characters/export', {
      method: 'POST',
      headers: ctx().getRequestHeaders(),
      body: JSON.stringify({ format: 'png', avatar_url: avatar }),
    });
    // The STATUS, never the body.
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, blob: await r.blob() };
  } catch (e) {
    // …and the CLASS, never the message — B.5. The caller interpolates this into `tally.errors`.
    console.error('[Vocalis] characters/export', e);
    return { ok: false, error: errClass(e) };
  }
}

function wireSettings() {
  $('#extensions_settings2').append(SETTINGS_HTML);
  $('#vocalis_enabled')
    .prop('checked', settings.enabled)
    .on(
      'change',
      /** @this {HTMLElement} */ function () {
        settings.enabled = $(this).prop('checked');
        if (!settings.enabled) {
          stopCurrent();
          cancelAllPrerenders();
          forgetAllStates();
        } else probeResume();
        // 🔴 AND THE PAIRING CHANNEL GOES WITH IT. `pollForSweep` now
        // refuses while disabled, but the stream and the fallback timer would otherwise stay up
        // until the next reload: the doorbell would ring into a tab that answers nothing, and
        // Vocalis would keep counting this tab as a live listener. `startPolling` shuts both when
        // the flag is off and brings both back when it goes on again.
        //
        // ⚠️ Non-fatal for the same reason `wireSettings` wraps its own call: a throw in here must
        // not take the checkbox's narration half — the job this extension exists for — down with
        // a feature the user may never touch.
        try {
          startPolling();
          void polishRuntime?.refresh();
        } catch (e) {
          console.warn('[vocalis] pairing channel:', /** @type {ErrLike} */ (e).message);
        }
        $('body').toggleClass('vocalis-disabled', !settings.enabled);
        saveSettings();
      },
    );
  $('#vocalis_auto')
    .prop('checked', settings.autoNarrate)
    .on(
      'change',
      /** @this {HTMLElement} */ function () {
        settings.autoNarrate = $(this).prop('checked');
        saveSettings();
      },
    );
  $('#vocalis_prerender')
    .prop('checked', settings.preRender)
    .on(
      'change',
      /** @this {HTMLElement} */ function () {
        settings.preRender = $(this).prop('checked');
        if (!settings.preRender) cancelAllPrerenders(); // stop what is already queued
        saveSettings();
      },
    );
  $('#vocalis_url')
    .val(settings.serverUrl)
    .on(
      'change',
      /** @this {HTMLElement} */ function () {
        settings.serverUrl = String($(this).val()).trim().replace(/\/+$/, '');
        $(this).val(settings.serverUrl);
        saveSettings();
        forgetAllStates(); // a different server has a different cache
        probeResume();
        startPolling(); // 7.0-m2j — a different server to answer
        void polishRuntime?.refresh();
      },
    );
  // Trim pasted whitespace before storing the token. Changing credentials does not invalidate
  // narration state, which is keyed by text and voice.
  $('#vocalis_token')
    .val(settings.pairToken)
    .on(
      'change',
      /** @this {HTMLElement} */ function () {
        settings.pairToken = String($(this).val()).trim();
        $(this).val(settings.pairToken);
        saveSettings();
        startPolling(); // 7.0-m2j — pasting the token is what enables the poll
        void polishRuntime?.refresh();
      },
    );
  $('#vocalis_test').on('click', testServer);
  // 7.0-m2j. No controls to bind — the button is in Vocalis. All this starts is the poll that
  // lets Vocalis reach us.
  //
  // 🔴 NON-FATAL ON PURPOSE, AND THE BLAST RADIUS IS WHY. `wireSettings` runs during init, so
  // anything that throws in here stops the REST of init — the narration buttons, the auto-play
  // hooks, the player bar — over a feature the user may never touch. The same ordering the Test
  // line follows (narration is the job; pairing is a note on it). The spec suite proved the
  // shape: one missing DOM method in here failed every unrelated check in three browser specs.
  try {
    startPolling();
  } catch (e) {
    console.warn('[vocalis] import-from-SillyTavern polling unavailable:', /** @type {ErrLike} */ (e).message);
  }
  $('body').toggleClass('vocalis-disabled', !settings.enabled);
}

// ── 6.0 §2: selecting a range, and building a scene out of it ──────────────────
// Select messages and play them back together as a scene.
// 🔴 §2.4 IS THE SINGLE MOST IMPORTANT FACT IN THE DESIGN, and everything below rests on it:
// `getContext().chat` is the ENTIRE chat array regardless of `power_user.chat_truncation` and
// regardless of the fork's message window. So the extension can read message #4's text while
// only #900–1000 are on screen. Selecting a range 4,000 messages back therefore costs nothing,
// "Start of chat → here" is one array slice rather than a scroll, and every count in the bar is
// computed from `chat` and NEVER from the DOM. A count taken off the DOM would silently mean
// "the part of the range you happen to have scrolled into view", which is not a thing anyone
// wants to know.

/** @type {{ start: number, end: number }|null} */
let range = null; // the SPAN's message INDICES, unordered as clicked

// 9.2 §2.5 — THE SELECTION IS A SET, and the span is only the fast way to fill it.
//
// 🔴 THE TWO SETS SURVIVE A MOVE OF THE SPAN, and that is the whole point of them. Removing
// #15 from #12 → #20 and then re-pointing the end at #25 has to leave #15 out; a model that
// re-filled the span from its anchors on every endpoint change would silently put it back, which
// is the one thing the feature exists to prevent. Only "Clear selection" empties them.
//
// ⚠️ WHICH IS EXACTLY WHY THE BAR COUNTS WHAT IT SKIPS (`renderRangeBar`). A hole punched
// a thousand messages back is off screen and therefore invisible, and a sticky exclusion nobody
// can see is a scene that quietly misses a message. The count is the only honest place for it —
// the same argument §2.4 makes about never counting the DOM.
/** @type {Set<number>} indices added one at a time — inside the span or nowhere near it */
const sceneAdds = new Set();
/** @type {Set<number>} indices removed one at a time; beats both the span and `sceneAdds` */
const sceneDrops = new Set();
/** @type {{ id: string, timer: ReturnType<typeof setTimeout>|null, lo: number, hi: number }|null} */
let sceneJob = null; // while a build is running
/** @type {(HTMLElement & { _teardown?: () => void })|null} */
let sceneMenuEl = null;

// §2.1 — CHARACTER MESSAGES ONLY, in the first cut.
//
// ⚠️ Written as a PREDICATE OVER THE WALK rather than as a hardcode, deliberately: §11 records
// "narrate my side too" as considered and set aside, not refused, and when it arrives it should
// be a checkbox rather than a rewrite of the selection, the bar, and the payload builder.
/**
 * @param {Record<string, any>} msg
 */
function inScene(msg) {
  return !!msg && !msg.is_user && !msg.is_system;
}

/**
 * Is this message in the selection? The span, plus the ones added by hand, minus the ones taken
 * out by hand — and the drops are tested FIRST, because a hole has to beat the span it was
 * punched in.
 * @param {number} i
 */
function selected(i) {
  if (sceneDrops.has(i)) return false;
  if (sceneAdds.has(i)) return true;
  if (!range) return false;
  return i >= Math.min(range.start, range.end) && i <= Math.max(range.start, range.end);
}

// The OUTER EDGES OF THE SELECTION, which since 9.2 is not the same thing as the anchors:
// dropping the first message of a span moves the low edge up, and adding one a thousand rows back
// moves it down. The bar prints these as `#lo → #hi`, so reading them off `range` would name a
// first message that is not in the scene — and null here is what hides the bar, so a span whose
// every message has been removed has to report empty rather than report its anchors.
function rangeBounds() {
  let lo = Infinity;
  let hi = -Infinity;
  if (range) {
    let a = Math.min(range.start, range.end);
    let b = Math.max(range.start, range.end);
    while (a <= b && sceneDrops.has(a)) a++;
    while (b >= a && sceneDrops.has(b)) b--;
    if (a <= b) {
      lo = a;
      hi = b;
    }
  }
  for (const i of sceneAdds) {
    if (sceneDrops.has(i)) continue;
    lo = Math.min(lo, i);
    hi = Math.max(hi, i);
  }
  return lo <= hi ? { lo, hi } : null;
}

// The messages a build would actually send, in order — AND the count of the ones between the
// same two edges that it would not. `bodyFor` returns null for anything with nothing speakable in
// it, and those are dropped HERE as well as counted by the server (§9), so the number in the bar
// is the number that will be rendered, not the number of rows spanned.
//
// ⚠️ ONE PASS FOR BOTH FIGURES, DELIBERATELY. `bodyFor` is the expensive part of this walk,
// and a second walk to count the holes would double the cost of a "Start of chat → here" over
// four thousand messages — a walk that runs again on every endpoint move.
function selectionScan() {
  const b = rangeBounds();
  if (!b) return { items: [], skipped: 0 };
  const chat = ctx().chat;
  const items = [];
  let skipped = 0;
  for (let i = b.lo; i <= b.hi && i < chat.length; i++) {
    if (!inScene(chat[i])) continue;
    const body = bodyFor(i);
    if (!body) continue;
    if (!selected(i)) {
      skipped++; // a message that WOULD have been in the scene and has been taken out of it
      continue;
    }
    items.push({ ...body, mesid: i }); // mesid is a HINT for jumping back (§4), never identity
  }
  return { items, skipped };
}

function rangeItems() {
  return selectionScan().items;
}

/**
 * @param {number} seconds
 */
function fmtDuration(seconds) {
  if (seconds == null) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// 🔴 THE ONE PLACE THE HOLES GO AWAY. Everything else preserves them on purpose (§2.5), so
// if this forgot either set, a "Clear selection" would be followed by a fresh span still missing
// the message removed from the last one — with nothing on screen to explain it.
function clearRange() {
  range = null;
  sceneAdds.clear();
  sceneDrops.clear();
  renderRangeBar();
  paintRangeRails();
}

/**
 * @param {'start'|'end'} which
 * @param {number} mesId
 */
function setRangeEnd(which, mesId) {
  if (!range) range = { start: mesId, end: mesId };
  else range[which] = mesId;
  renderRangeBar();
  paintRangeRails();
}

// 9.2 §2.5 — the two per-MESSAGE selection verbs. Neither one touches the span: a hole stays a
// hole and an extra stays an extra, so the endpoints can go on being moved afterward and the
// hand-made edits ride along. The two sets are kept mutually exclusive here rather than resolved
// later, so "add, remove, add" ends where a human would expect and not two entries deep.
/**
 * @param {number} mesId
 */
function addToSelection(mesId) {
  // ⚠️ REFUSED, not accepted-and-ignored. A user or system message can go into the set
  // perfectly happily and then vanish at the first `inScene` filter (§2.1) — the count would not
  // move, the rail would not paint, and nothing on screen would say why. Say it.
  if (!inScene(ctx().chat[mesId])) {
    toastr.warning('Scenes are character messages only.', 'Vocalis');
    return;
  }
  sceneDrops.delete(mesId);
  sceneAdds.add(mesId);
  renderRangeBar();
  paintRangeRails();
}

/**
 * @param {number} mesId
 */
function removeFromSelection(mesId) {
  const was = selected(mesId);
  sceneAdds.delete(mesId);
  sceneDrops.add(mesId);
  // Recorded even when it was not in the selection, because the drop means "keep this one out"
  // and a span drawn across it later must still miss it. That is not what a silent no-op looks
  // like, so say which of the two just happened.
  if (!was) toastr.info('That one was not in the selection — it will stay out.', 'Vocalis');
  renderRangeBar();
  paintRangeRails();
}

// §2.3 — "The painted messages inside the range get a left rail so the selection is visible
// where he is looking. Messages in range but not painted simply are not on screen — the count
// in the bar is the truth."
//
// 🔴 KEYED ON `selected()`, NOT ON THE BOUNDS. A message removed from the middle of a span
// is between the edges and out of the scene, and painting the rail from `lo`/`hi` would go on
// showing it as in — the rail is the only per-message evidence there is.
function paintRangeRails() {
  $('#chat .mes').each(function () {
    const id = Number($(this).attr('mesid'));
    const on = !Number.isNaN(id) && selected(id) && inScene(ctx().chat[id]);
    $(this).toggleClass('vocalis_in_scene', !!on);
  });
}

const RANGE_BAR_ID = 'vocalis_scene_bar';

// Native DOM, like the menu and for the same two reasons: the bar is OURS and lives on `body`
// (§2.2 — anything inside ST's chat furniture is clipped), and it must not depend on which
// slice of jQuery this SillyTavern build ships.
function sceneBar() {
  let bar = document.getElementById(RANGE_BAR_ID);
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = RANGE_BAR_ID;
  bar.className = 'vocalis_scene_bar';
  bar.addEventListener('click', e => {
    const hit = /** @type {HTMLElement|null} */ (e.target)?.closest('[data-act]');
    if (!hit) return;
    const act = hit.getAttribute('data-act');
    if (act === 'create') promptCreateScene();
    else if (act === 'clear') clearRange();
    else if (act === 'cancel') cancelSceneJob();
  });
  document.body.appendChild(bar);
  return bar;
}

function removeSceneBar() {
  const bar = document.getElementById(RANGE_BAR_ID);
  if (bar) bar.remove();
}

// The cost is the only part of the bar that changes as an estimate lands, so it is written on
// its own rather than by re-rendering — a re-render would rebuild the buttons under the pointer.
/**
 * @param {string} text
 */
function setSceneCost(text) {
  const el = document.querySelector(`#${RANGE_BAR_ID} .vocalis_scene_cost`);
  if (el) el.textContent = text;
}

function renderRangeBar() {
  const b = rangeBounds();
  if (!b) {
    removeSceneBar();
    return;
  }
  if (sceneJob) return; // a running build owns the bar — see pollSceneJob
  const { items, skipped } = selectionScan();
  sceneBar().innerHTML =
    `<span class="vocalis_scene_what">Scene · #${b.lo} → #${b.hi} · ` +
    `${items.length} character message${items.length === 1 ? '' : 's'}` +
    // 🔴 9.2 — the ONLY place a removed message can be seen once it scrolls away. "#0
    // → #39 · 37 messages" reads as "all of it" to anyone who is not counting, and the rail
    // that would have said otherwise is on a row that is not in the DOM.
    (skipped ? ` · ${skipped} skipped` : '') +
    `<span class="vocalis_scene_cost"> · measuring…</span></span>` +
    '<div class="menu_button" data-act="create">Create</div>' +
    '<div class="menu_button" data-act="clear">Clear</div>';
  refreshEstimate(items);
}

// 🔴 §2.3 — THE DURATION ESTIMATE IS NOT DECORATION. "It is the difference between committing
// the box to four minutes of work and to six hours."
//
// Debounced, because every shift-click moves an endpoint and the server has to stat one file
// per cached message to answer. Two quantities, reported separately and never added together:
// how LONG the scene is (speech) and how long it takes to BUILD (wall clock). A null figure
// means this box has never been measured, and the bar SAYS SO rather than inventing one —
// `enhance_rate.py`'s rule.
/** @type {ReturnType<typeof setTimeout>|null} */
let estimateTimer = null;
let estimateSeq = 0;
/**
 * @param {any[]} items
 */
function refreshEstimate(items) {
  clearTimeout(estimateTimer ?? undefined);
  const seq = ++estimateSeq;
  if (!items.length || !settings.serverUrl) return;
  estimateTimer = setTimeout(async () => {
    let est;
    try {
      est = await estimateScene(settings.serverUrl, items, SCENE_GAP_S, settings.pairToken);
    } catch (e) {
      setSceneCost(' · estimate unavailable');
      return;
    }
    if (seq !== estimateSeq || !rangeBounds()) return; // the selection moved under the request
    const bits = [];
    bits.push(`${est.cached} cached`);
    const len = fmtDuration(est.est_audio_s);
    bits.push(len ? `~${len}` : 'length unknown until some of it is rendered');
    if (est.est_render_s === null) bits.push('build time unknown — this box has never been timed');
    else if (est.est_render_s <= 0) bits.push('nothing left to render');
    else bits.push(`build ~${fmtDuration(est.est_render_s)}`);
    setSceneCost(` · ${bits.join(' · ')}`);
  }, 250);
}

// ── the shift-click menu (§2.2) ────────────────────────────────────────────────
// Plain click narrates or stops; long-press became cancel-or-force in 5.4-m3.
// Shift-click is free.
//
// ⚠️ THE MENU IS APPENDED TO `body`, NOT TO `.mes_buttons`. The button lives inside ST's message
// button row, which CLIPS — a menu built there is cut off at the row's edge and mostly
// invisible. Positioned absolutely against the button's bounding rect instead, and dismissed on
// outside-click, Escape, or a chat change.
function closeSceneMenu() {
  if (!sceneMenuEl) return;
  // 🔴 Tear the two DOCUMENT listeners down, not just the element. They are on `document`, not
  // on the menu, because a click ANYWHERE has to dismiss it — so removing the node alone
  // leaves both alive, and every menu ever opened keeps a keydown handler that swallows the
  // number keys 1–9 for the rest of the session. In SillyTavern that means typing a digit
  // into the message box stops working, which is a bug nobody would trace back to a menu.
  if (sceneMenuEl._teardown) sceneMenuEl._teardown();
  sceneMenuEl.remove();
  sceneMenuEl = null;
}

/** §18d — the row is the mode's ONLY visible state, so it carries the count. "Stop preloading"
 *  alone cannot tell a run with forty messages left from one that has reached the end of the chat
 *  and is sitting armed for the next reply, and those are different enough to act on. */
function preloadStopLabel() {
  const n = preloadRemaining();
  return n ? `Stop preloading (${n} left)` : 'Stop preloading';
}

/**
 * @param {number} mesId
 * @param {HTMLElement} anchorEl
 */
function openSceneMenu(mesId, anchorEl) {
  closeSceneMenu();
  // 🔴 THE SELECTION, NOT THE ANCHORS. A span whose every message has been removed one at a
  // time has a `range` and nothing to build, and offering "Create audio scene…" there would open
  // the title prompt for a scene `promptCreateScene` then refuses as empty.
  const has = !!rangeBounds();
  // 7.4 §18 — the two per-MESSAGE actions come first, and the scene rows (which are about a
  // RANGE) keep their order below them. 🔴 Shift-click was already this menu, so "preload from
  // the speaker" is a row here rather than a second meaning for the same gesture: two things on
  // one modifier is how a scene selection gets built by someone who wanted a pre-render.
  const rows = [
    ['preload', 'Preload this message'],
    ['autoplay', autoChain ? 'Stop autoplay' : 'Autoplay from here on'],
    ['start', 'Set scene start here'],
    ['end', 'Set scene end here'],
    // 9.2 §2.5 — 5 and 6, immediately under the two span rows. They are per-message verbs below
    // the span rows rather than up with Preload
    // because they are about the SCENE: the reading order is "set the ends, then fix the middle".
    // ⚠️ Both rows are always present, never conditional on whether this message is in the
    // selection. The digits are the keyboard shortcut, and a menu whose numbering shifts with the
    // row under the pointer is one where 6 means something different every time.
    ['add', 'Add to current scene'],
    ['remove', 'Remove from current scene'],
    // §18d — BELOW `remove`, NOT NEXT TO `Preload this message`, AND THAT IS DELIBERATE.
    // Every row above is one somebody has a
    // key for by now, and the reading-order argument for grouping the two preload rows together is
    // worth less than a menu whose numbers still mean what he was told they mean. New rows go
    // after the numbered ones.
    ['preload-on', preChain ? preloadStopLabel() : 'Preload from here on'],
    ['from-top', 'Start of chat → here'],
    ...(has ? [['create', 'Create audio scene…']] : []),
    ['clear', 'Clear selection'],
  ];
  const el = /** @type {HTMLDivElement & { _teardown?: () => void }} */ (document.createElement('div'));
  el.className = 'vocalis_scene_menu';
  // Numbered for keyboard, one line each — §2.2's shape exactly.
  el.innerHTML = rows
    .map(
      ([act, label], i) =>
        `<div class="vocalis_scene_menu_item" data-act="${act}">` +
        // The tenth row's key is 0, and the badge says 0 — see `onKey`. A menu that prints a
        // number no keypress can produce is worse than one with no numbers at all.
        `<span class="vocalis_scene_menu_n">${i === 9 ? '0' : i + 1}</span>${label}</div>`,
    )
    .join('');
  document.body.appendChild(el);
  sceneMenuEl = el;

  const r = anchorEl.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, r.left))}px`;
  // Above the button when there is no room below, so the last item of a nine-row menu is
  // never off the bottom of a phone.
  const below = r.bottom + 4;
  el.style.top = below + el.offsetHeight > window.innerHeight ? `${Math.max(4, r.top - el.offsetHeight - 4)}px` : `${below}px`;

  /** @param {string} act */
  const run = act => {
    closeSceneMenu();
    if (act === 'preload') preloadMessage(mesId);
    else if (act === 'preload-on') {
      if (preChain) stopPreloadChain();
      else startPreloadChain(mesId);
    } else if (act === 'autoplay') {
      if (autoChain) stopAutoplay();
      else startAutoplay(mesId);
    } else if (act === 'start') setRangeEnd('start', mesId);
    else if (act === 'end') setRangeEnd('end', mesId);
    else if (act === 'add') addToSelection(mesId);
    else if (act === 'remove') removeFromSelection(mesId);
    else if (act === 'from-top') {
      range = { start: 0, end: mesId };
      renderRangeBar();
      paintRangeRails();
    } else if (act === 'create') promptCreateScene();
    else if (act === 'clear') clearRange();
  };
  // Native listeners, not jQuery: this element is ours and never passes through ST's DOM
  // helpers, so delegating through jQuery would buy nothing and would tie the menu to
  // whatever subset of jQuery is present.
  el.addEventListener('click', e => {
    const item = /** @type {HTMLElement|null} */ (e.target)?.closest('.vocalis_scene_menu_item');
    if (item) run(item.getAttribute('data-act') || '');
  });
  /** @param {KeyboardEvent} e */
  const onKey = e => {
    if (e.key === 'Escape') {
      closeSceneMenu();
      return;
    }
    // 🔴 TEN ROWS, TEN KEYS. `create` already made this menu nine rows long and §18d's
    // "Preload from here on" makes it ten — and `1..rows.length` cannot reach a tenth row from one
    // keypress, so the LAST row (Clear selection) would have silently lost its shortcut to a change
    // that has nothing to do with it. 0 is the tenth key, exactly as the badge on that row says.
    if (e.key === '0' && rows.length >= 10) {
      e.preventDefault();
      run(rows[9][0]);
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= Math.min(9, rows.length)) {
      e.preventDefault();
      run(rows[n - 1][0]);
    }
  };
  /** @param {MouseEvent} e */
  const onDown = e => {
    if (!el.contains(/** @type {Node|null} */ (e.target))) closeSceneMenu();
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  el._teardown = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDown, true);
  };
}

// §11 — 0.7 s gap between adjacent messages in a scene.
const SCENE_GAP_S = 0.7;

async function promptCreateScene() {
  const items = rangeItems();
  if (!items.length) {
    toastr.warning('Nothing speakable in that range.', 'Vocalis');
    return;
  }
  const c = ctx();
  // §5.1: the scene's filename comes from THIS string and never from message content, so it
  // has to be asked for rather than derived. Defaulted to the chat's name, which is the thing
  // he would type anyway.
  const title = await c.callGenericPopup(
    `Name this scene (${items.length} message${items.length === 1 ? '' : 's'}):`,
    c.POPUP_TYPE.INPUT,
    c.name2 || 'Scene',
  );
  if (!title) return;
  let started;
  try {
    started = await createScene(
      settings.serverUrl,
      {
        title: String(title).trim(),
        items,
        gap_s: SCENE_GAP_S,
        source: 'st',
        chat: c.getCurrentChatId ? String(c.getCurrentChatId() || '') : '',
      },
      settings.pairToken,
    );
  } catch (e) {
    toastr.error(
      /** @type {ErrLike} */ (e).status === 409
        ? 'This box is already building a scene. Wait for it to finish.'
        : `Could not start the scene: ${/** @type {ErrLike} */ (e).message}`,
      'Vocalis',
    );
    return;
  }
  // 🔴 The bounds are captured HERE, not read back off `range` in the poll. `clearRange()`
  // runs the moment the build finishes, and a poll that read the live selection would lose
  // the messages it is meant to be watching at the exact tick they all went green.
  const b = rangeBounds();
  sceneJob = { id: started.job_id, timer: null, lo: b ? b.lo : 0, hi: b ? b.hi : -1 };
  pollSceneJob();
}

/**
 * @param {string} html
 */
function sceneBarBusy(html) {
  sceneBar().innerHTML = html;
}

async function pollSceneJob() {
  if (!sceneJob) return;
  let st;
  try {
    st = await sceneStatus(settings.serverUrl, sceneJob.id, settings.pairToken);
  } catch (e) {
    sceneBarBusy(
      '<span class="vocalis_scene_what">Lost contact with the scene build.</span>' +
        '<div class="menu_button" data-act="clear">Dismiss</div>',
    );
    sceneJob = null;
    return;
  }
  // 9.8: `cancelled` is the pre-sweep spelling. The extension and Vocalis are separate
  // deploys, so accept either — an extension that only knows one of them leaves the scene
  // job spinning for ever against a server that has already finished with it.
  if (st.status === 'done' || st.status === 'failed' || st.status === 'canceled' || st.status === 'cancelled') {
    sceneJob = null;
    if (st.status === 'done') {
      // 6.3: `done` means done. There is no second artifact arriving minutes later, so
      // there is no branch here any more — enhancing is something he asks for from the
      // Clips tab, on a scene that already exists.
      toastr.success('Scene built — find it in Vocalis under SillyTavern → Scene Clips.', 'Vocalis');
      if (st.error) toastr.warning(st.error, 'Vocalis');
    } else if (st.status === 'failed') {
      toastr.error(st.error || 'The scene build failed.', 'Vocalis');
    }
    clearRange();
    scheduleSweep(); // the range just went green (§3.2)
    return;
  }
  // 6.3: the `enhancing` branch and its "cancel keeps the un-enhanced one" copy are gone
  // with the phase they described. A build renders and assembles, and that is all it does.
  const what = `Building scene · ${st.done}/${st.total} messages` + (st.cached ? ` · ${st.cached} were cached` : '');
  sceneBarBusy(`<span class="vocalis_scene_what">${what}</span>` + '<div class="menu_button" data-act="cancel">Cancel</div>');
  probeSceneRange();
  sceneJob.timer = setTimeout(pollSceneJob, 1000);
}

// 🔴 6.2 — the buttons in the range go green AS the build caches them, not all at once at the
// end. Update each message's speaker icon as the scene builder adds it to the cache.
// Why nothing else did this. `schedulePoll` deliberately re-asks only about messages in ACTIVE
// (queued / rendering / playable) — "when everything on screen is terminal, this stops dead: a
// chat that is not rendering makes no traffic". An UNCACHED message is terminal by that rule,
// because nothing the extension knows about is going to change it. During a build that is
// exactly wrong: the server is rendering those messages one at a time and promoting each into
// the speech cache (`scene_build.render_through_the_real_path` → `nomi.promote_temp`), and the
// extension is the only thing on the box that does not know it. The single `scheduleSweep()`
// on completion is what painted them, all in one go, minutes late.
//
// It costs one probe per second while a build runs, and it shrinks as it goes: a message that
// has gone green is never asked about again, so the last tick of a 74-message scene asks about
// nothing. ⚠️ It deliberately does NOT go through `scheduleSweep`, whose whole job is to filter
// down to messages with no state yet — every message here already has one (uncached), which is
// precisely the state that has to be re-asked.
// 🔴 Two things this must NOT do, both reachable only since 6.2 started calling it once a second
// for the whole length of a build (~600 times, where it used to run a handful).
//
//   1. Overlap itself. A range chunks into several sequential /v1/audio/state requests, so a slow
//      probe can answer AFTER a later one and repaint a message that has already gone green back
//      to gray — a flickering icon, which is the very symptom this feature exists to fix.
//
//   2. Latch `probeStopped` for the session. `runProbe` sets it on ONE failed request, and at 600
//      attempts per build a single blip (a restart, a momentary vault lock) is likely. Every later
//      probe then returned immediately — INCLUDING the final sweep — so the toast said "Scene
//      built" while every icon in the range stayed gray and nothing said why. A scene probe is
//      best-effort decoration and must not disable the mechanism the click path relies on.
let probeInFlight = false;

async function probeSceneRange() {
  if (!sceneJob || probeInFlight) return;
  // Captured: `sceneJob` is nullable and this reads it inside a callback, where narrowing
  // does not survive.
  const job = sceneJob;
  const ids = domMesIds().filter(id => !!job && id >= job.lo && id <= job.hi && states.get(id) !== 'cached');
  if (!ids.length) return;
  const wasStopped = probeStopped;
  probeInFlight = true;
  try {
    probeStopped = false; // this call may fail; that must not disable everything else
    await runProbe(ids);
  } catch {
    /* best effort — the next tick asks again */
  } finally {
    probeStopped = wasStopped; // whatever the click path decided, restored untouched
    probeInFlight = false;
  }
}

async function cancelSceneJob() {
  if (!sceneJob) return;
  try {
    await cancelScene(settings.serverUrl, sceneJob.id, settings.pairToken);
  } catch {
    /* it may have finished */
  }
}

// ── message buttons ────────────────────────────────────────────────────────────
const NARRATE_BTN =
  '<div title="Vocalis: play this message (hold to re-render)" class="mes_button vocalis_narrate fa-solid fa-volume-high interactable" tabindex="0"></div>';

// Hold the button, then release. WHAT it does depends on the color (5.4-m3):
//
//   orange / green  -> re-render. Renders are unseeded — identity is voice+params+text — so a
//                      forced render is simply a different take of the same line.
//   yellow / blue   -> CANCEL the speculation, and stop playback if you are listening to it.
//                      This lets the user cancel one speculative render and continue to the next.
//
// The armed feedback differs with it, because a spinner under your finger promises a render:
// on a cancellable button the color drops to orange instead, which is a preview of the
// outcome. Release before it appears, or slide off the button, and it stays an ordinary click.
// Same gesture and same 600 ms as the Nomi extension's button (nomi/chrome_extension/content.js).
//
// DELEGATED, where Nomi binds to its one button directly: ST creates and destroys .mes
// nodes constantly, so there is no element to hang state on. One press object is enough
// because a pointer can only be down on one button at a time.
//
// Pointer events, not mouse events, for the same reason ST is usable on a phone at all —
// a touch fires no mousedown until after the tap completes, which is far too late to arm
// anything. Keyboard activation (the button is `interactable tabindex="0"`, so ST turns
// Enter/Space into a click) therefore plays normally and has no force route: fine, it is
// a gesture, and the ordinary click is the safe outcome.
const LONG_PRESS_MS = 600;
/** @type {{ mesId: number, armed: boolean, timer: ReturnType<typeof setTimeout>|null }|null} */
let press = null; // while a button is held
let pressHandled = false; // a long press already acted: swallow the click still coming

// A long press on a yellow or blue button cancels the speculation behind it.
/**
 * @param {number} mesId
 */
function cancellable(mesId) {
  return ACTIVE.includes(states.get(mesId));
}

// Put the button back the way it was found. 🔴 NOT simply "idle": since m3 the gesture can
// arm on a message that is PLAYING, and forcing the speaker glyph back under a live stream
// would leave a stop button that is not a stop button. Color is restored from the last
// state we were told, so an un-arm never invents one.
/**
 * @param {number} mesId
 */
function restoreBtn(mesId) {
  setBtnState(mesId, current && current.mesId === mesId ? 'playing' : 'idle');
  paint(mesId, states.get(mesId) || 'none');
}

/**
 * @param {boolean} [restore]
 */
function endPress(restore) {
  if (!press) return;
  clearTimeout(press.timer ?? undefined);
  if (restore && press.armed) restoreBtn(press.mesId);
  press = null;
}

// The long press landed on a yellow or blue button: stand the speculation down and give the
// box back. Playback stops with it — a click on a blue message FOLLOWS the producer's spool,
// so canceling the producer necessarily ends the stream. Stopping the listener FIRST is what
// keeps that clean: the handle is marked stopped before the bytes dry up, so the truncation
// check never runs and a deliberate skip cannot surface as "playback stopped early — Retry?".
/**
 * @param {number} mesId
 */
function cancelGesture(mesId) {
  if (current && current.mesId === mesId) stopCurrent();
  // Orange immediately — the gesture has to feel like it landed — but marked UNKNOWN, not
  // asserted as none. A cancel that the server refused (or that raced a promote) must not
  // leave the button permanently lying: the sweep re-asks once the POST comes back.
  forgetState(mesId);
  cancelPrerenderFor(mesId).then(scheduleSweep);
}

function injectButtons() {
  // Template: every message rendered from here on gets the button…
  $('#message_template .mes_buttons .extraMesButtons').prepend(NARRATE_BTN);
  // …and any message already in the DOM gets one too, through the same helper the sweep uses so
  // there is one description of what "this row has a button" means.
  for (const id of domMesIds()) ensureBtn(id);

  $(document).on('pointerdown', '.vocalis_narrate', function (e) {
    if (e.button > 0) return; // primary button only; touch has no button
    const mesId = Number($(this).closest('.mes').attr('mesid'));
    if (Number.isNaN(mesId)) return;
    // 🔴 SHIFT-CLICK IS THE SCENE MENU (§2.2), and it must be caught HERE rather than in the
    // `click` handler below. Arming the long-press first would start a timer that the menu's
    // own pointerdown-capture dismissal never clears, so a shift-click that opened the menu
    // would ALSO paint a spinner (or an armed-cancel preview) on the button behind it.
    if (e.shiftKey) {
      e.preventDefault();
      pressHandled = true; // and swallow the click that follows
      openSceneMenu(mesId, this);
      return;
    }
    endPress(true);
    pressHandled = false;
    // 🔴 A playing button used to refuse to arm at all ("it means Stop right now"). It
    // still does when a Stop is all the gesture could achieve — but a BLUE message that is
    // playing is one the user is listening to *while it renders*, and canceling that is
    // exactly the skip m3 exists for. So the refusal now applies only where the color
    // says there is nothing to cancel.
    if (current && current.mesId === mesId && !cancellable(mesId)) return;
    press = { mesId, armed: false, timer: null };
    press.timer = setTimeout(() => {
      if (!press) return;
      press.armed = true;
      // The armed preview is the OUTCOME, not a generic "held": a spinner on a button
      // whose long press cancels would promise the opposite of what is about to happen.
      if (cancellable(mesId)) paint(mesId, 'none');
      else setBtnState(mesId, 'generating');
    }, LONG_PRESS_MS);
  });

  // Sliding off the button cancels — the only way out of an arm you did not mean.
  $(document).on('pointerleave pointercancel', '.vocalis_narrate', () => endPress(true));

  // On the document, not the button: a release anywhere has to clear the timer, or a
  // drag-off-and-release leaves a spinner spinning on a message nothing is rendering.
  $(document).on('pointerup', function (e) {
    if (!press) return;
    const { mesId, armed } = press;
    // Read the color BEFORE endPress: an armed cancel has already painted the button
    // orange as its preview, and `states` still holds the truth it was armed against.
    const cancel = cancellable(mesId);
    endPress(false);
    if (!armed) return;
    if (!$(e.target).closest('.vocalis_narrate').length) {
      // released off the button
      restoreBtn(mesId);
      return;
    }
    pressHandled = true;
    if (cancel) cancelGesture(mesId);
    else narrateMessage(mesId, true);
  });

  // A long press on a touchscreen is also the gesture for the OS text-selection callout.
  // The CSS kills the callout; this kills the menu Android raises through contextmenu.
  $(document).on('contextmenu', '.vocalis_narrate', e => e.preventDefault());

  $(document).on('click', '.vocalis_narrate', function () {
    if (pressHandled) {
      pressHandled = false;
      return;
    } // the long press already ran
    const mesId = Number($(this).closest('.mes').attr('mesid'));
    if (Number.isNaN(mesId)) return;
    if (current && current.mesId === mesId) {
      stopCurrent(); // same message: toggle = stop
      return;
    }
    narrateMessage(mesId);
  });
}

// ── init ───────────────────────────────────────────────────────────────────────
jQuery(async () => {
  const c = ctx();
  c.extensionSettings[MODULE] = Object.assign({}, DEFAULTS, c.extensionSettings[MODULE]);
  settings = c.extensionSettings[MODULE];
  delete settings.voiceMap; // pre-M4b client-side map: server owns it now
  delete settings.defaultVoice;
  saveSettings = c.saveSettingsDebounced;

  wireSettings();
  injectButtons();
  // Polish is an independent composer action. It owns only its button and refreshes the
  // server-owned snapshot on initialization/click; failures must not affect narration startup.
  try {
    polishRuntime = initializePolishSend({
      getContext: ctx,
      getSettings: () => ({
        enabled: settings.enabled,
        serverUrl: settings.serverUrl,
        pairToken: settings.pairToken,
      }),
    });
  } catch (e) {
    console.warn('[vocalis] polish control unavailable:', /** @type {ErrLike} */ (e).message);
  }

  // ← / → seek, while a message is playing. `capture: true` so it lands before ST's own
  // document handler, which binds the bare arrows to swiping the last message — see onSeekKey
  // for why taking them is safe.
  document.addEventListener('keydown', onSeekKey, true);

  const { eventSource, event_types } = c;
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
  eventSource.on(event_types.GROUP_UPDATED, pushCurrentCharacter); // membership changed
  eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
  eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
  // 5.4 — every path that puts a message on screen, and every path that changes its text.
  eventSource.on(event_types.CHAT_LOADED, onMessagesPainted); // the opening window
  eventSource.on(event_types.MORE_MESSAGES_LOADED, onMessagesPainted); // a scroll-back batch
  eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessagesPainted); // the user's own line
  eventSource.on(event_types.USER_MESSAGE_RENDERED, () => polishRuntime?.onRendered());
  eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
  eventSource.on(event_types.MESSAGE_UPDATED, onMessageEdited);

  pushCurrentCharacter(); // a chat may already be open at load
  watchChat(); // …and its messages may arrive before OR after
}); //    this line — see watchChat()
