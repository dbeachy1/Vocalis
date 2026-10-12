// sys/kobold.js — the KoboldCpp tab and its ⚙ Settings panel (7.3-m4).
//
// A remote control for a model server Vocalis does not own: load a config, unload it, say what
// is holding the cards. Moved verbatim from index.html; every comment below is unedited, because
// most of them record a measurement (the listening socket dies with the model child; Kobold
// answers a wrong password with an empty list and a 200) that the code would otherwise look
// arbitrary without.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THIS AREA WAS FILED IN **THREE** PIECES, NOT THE TWO §2.1 PREDICTED.
//
//   `── KoboldCpp tab (4.7-m1) ──`        the tab: kob, kobLoadAll, kobPoll, the buttons
//   `── ⚙ Settings ▸ KoboldCpp ──`        kobRenderSettings and the password masking
//   (no banner at all)                     kobShowTest + the #kobSave / #kobClear wiring
//
// The first two were already adjacent, which is what the design doc noticed. The third was not:
// it sat ~130 lines further down, INSIDE the `── Nomi pairing (7.2-m4) ──` banner's territory,
// directly after the `#nomiPairCopy` handler and with no banner of its own to say it had ended.
// Nothing marked it as Kobold code except its identifiers. It is here now, and the whole area is
// one file for the first time since 4.7.
//
// ⚠️ THE LESSON IS ABOUT THE METHOD, NOT THIS AREA. A banner is a claim about where an area
// ENDS as well as where it starts, and an unbannered block inherits the previous banner by
// accident. Enumerate an area by its IDENTIFIERS (`grep -n '\bkob'`) before believing the
// banners — this block would have been left behind by anyone cutting on boundaries alone, and
// `kobShowTest` would then have been a module-private name with an inline-only caller.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — five of fifteen, and every one of them has a named inline caller.
//
//   kobLoadAll · kobPollStop      switchTab, on entering and leaving the Kobold tab
//   kobRenderSettings             loadAppSettings, which paints the ⚙ panel from /settings/app
//   kobErrHtml · kobDropWarnHtml  the RENDER flow: when a render finds Kobold holding the cards
//                                 it offers to unload, and reuses this tab's warning and its
//                                 error prose rather than writing a second, softer copy
//
// 📌 kobDropWarnHtml having a caller outside this file is the point of it, not a leak. Its own
// comment says so: two copies would drift, and the copy that drifts is the one that gets softer.
//
// 🔴 `kob` IS NOT EXPORTED. It would in fact be legal — it is a `const` that is only ever mutated
// (`kob.info=…`, `kob.status=…`), the same shape as FILT and `enh` — but nothing outside this
// file names it, and the eligibility rule is a ceiling on what MAY be published, not a
// suggestion of what should be. No spec drives any name in this file either, so unlike
// js/sys/devices.js there is no spec-caller half to the public surface here.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE STILL REACHES FOR AS AN INLINE GLOBAL — two names, both at call time.
//
//   switchTab   the ⚙-Settings link handler, which jumps to the panel and focuses #kobToken
//   UIS         the account-local UI state store, holding `vocalis-kob-cfg`
//
// ⚠️ `switchTab` is a PARSE-TIME name elsewhere in index.html, which is why js/ui/tabs.js has not
// moved. It is safe here because this file only ever names it inside a click handler.

import { $, esc } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.3-m13
import { jget, jpost, jput } from '../util/http.js';
import { modal } from '../ui/modal.js';
import { switchTab } from '../ui/tabswitch.js'; // 7.3-m13: was a shim read (call-time cycle, see header)
import { DOCKER } from './modelstate.js'; // the Docker-package flag, from /health

// ── the wire shapes `/kobold/*` actually carry (8.3) ──────────────────────────
/**
 * `kobold.parse_kcpps()` — one config file, LOCAL ONLY (a remote row carries no `detail` at
 * all — see `KoboldConfigRow`). `{error}` alone on a corrupt/missing/escaping file; every other
 * field is present once it parses, though `model_exists`/`models_all_missing` only exist when
 * `model_param` is set.
 * @typedef {object} KoboldConfigDetail
 * @property {string} [error]
 * @property {boolean} [unreadable_here]  The .kcpps folder is not visible to the process Vocalis
 *   runs in (normal in the Docker image) — alone in the object, and shown neutrally, not as an error.
 * @property {string} [model_param]
 * @property {number|null} [contextsize]
 * @property {number|null} [gpulayers]
 * @property {number[]|null} [usevulkan]   Device indices, from koboldcpp's own `--usevulkan`.
 * @property {boolean} [model_exists]
 * @property {boolean} [models_all_missing]  Set when EVERY config's model vanished at once —
 *   the tell for a locked vault rather than four deleted files (`exists()` on a locked/routed
 *   store answers `False` and never raises).
 */
/**
 * One row of `/kobold/configs`'s `configs` — `web/kobold.py`'s `_kobold_configs_body()`.
 * @typedef {object} KoboldConfigRow
 * @property {string} name
 * @property {string} label
 * @property {KoboldConfigDetail} [detail]  LOCAL only — remote configs live on the other box.
 */
/**
 * `/kobold/info`. The `available:false` branches (network failure, or the route's own
 * `error`) never carry `host`/`local`/`adminpassword_set` — `kobLoadAll`'s catch synthesizes a
 * bare `{available,url,error}` on a fetch failure, and those three fields are honestly optional
 * for that reason, even though a reachable route always sends them.
 * @typedef {object} KoboldInfo
 * @property {boolean} available
 * @property {string} url
 * @property {string} [host]
 * @property {boolean} [local]
 * @property {boolean} [adminpassword_set]
 * @property {string} [error]
 * @property {string} [version]
 * @property {boolean} [admin]
 * @property {boolean} [admin_on]
 * @property {boolean} [llm]
 */
/** Successful response shape for `/kobold/status`. Non-2xx auth or connectivity failures throw and use the `HttpErrorBody` path.
 * @typedef {object} KoboldStatus
 * @property {boolean} local
 * @property {string} host
 * @property {string} url
 * @property {boolean} loaded
 * @property {string|null} model
 * @property {string|null} [config]      Present once `loaded` — which config, if `reconcile` named one.
 * @property {string} [how]              'derived'·'learned'·'ambiguous'·'outside'·'none'.
 * @property {string[]} [candidates]     Present on a tie: 'ambiguous', or a learned tie.
 * @property {number} [other_vram_gb]    Present when `local`.
 * @property {boolean} [vram_measurable] `false`, present only when NOT `local`.
 * @property {{id: string, label: string}[]} [vocalis_gpus]  This box's cards TICKED in
 *   the Devices panel. Present only when `local` — a remote KoboldCpp does not load onto
 *   these cards, so the question does not arise there (see the route's own note).
 * @property {boolean} [warn_gpus]       The Settings > KoboldCpp checkbox. Present with
 *   `vocalis_gpus` and only there; absent reads as "do not warn", which is what a remote
 *   KoboldCpp means.
 */
/**
 * `/kobold/test`'s always-200 verdict. `reason`/`message` are absent on `ok:true`; `version` is
 * absent only on the very first failure (Kobold unreachable before the version probe ran).
 * @typedef {object} KoboldTestResult
 * @property {string} url
 * @property {boolean} local
 * @property {boolean} ok
 * @property {string} [version]
 * @property {'unreachable'|'no_password'|'admin_off'|'bad_password'} [reason]
 * @property {string} [message]
 * @property {number} [configs]
 */
/**
 * The slice of `/settings/app` this panel reads and writes. The route's real payload is the
 * WHOLE settings file (`kobRenderSettings` is called from `loadAppSettings()` elsewhere with
 * the full object); this names only the two fields this file ever touches.
 * @typedef {object} KoboldSettingsSlice
 * @property {string} [kobold_url]
 * @property {boolean} [kobold_adminpassword_set]
 */

// ── KoboldCpp tab (4.7-m1) ──────────────────────────────────────────────────
// A remote control, not a config editor. Everything here goes through /kobold/*; the tab
// never learns where Kobold's files are.
/**
 * `status` and `unloading` are never in the initializer — they arrive the first time a poll
 * lands / an unload starts, the same "declared for the typo, not the oversight" reasoning
 * `AppState` gives for its own late-created fields (types/vocalis.d.ts).
 * @typedef {object} KobState
 * @property {KoboldConfigRow[]} configs
 * @property {KoboldInfo|null} info
 * @property {ReturnType<typeof setInterval>|null} timer
 * @property {boolean} loading
 * @property {boolean} [unloading]
 * @property {KoboldStatus|null} [status]
 */
/** @type {KobState} */
const kob = { configs: [], info: null, timer: null, loading: false };

export function kobPollStop() {
  if (kob.timer) {
    clearInterval(kob.timer);
    kob.timer = null;
  }
}

// A live link to ⚙ Settings ▸ KoboldCpp. Every failure this tab can have is fixed in that
// one panel, so every message that names a cause also carries the way to fix it — the
// alternative is an SSH session, which is the clunk this whole tab exists to delete.
// Wired on click rather than inline onclick so it survives the CSP the rest of the app uses.
/** @param {string} [text] */
function kobSettingsLink(text) {
  return `<a href="#" data-kobsettings="1">${text || '⚙ Settings ▸ KoboldCpp'}</a>`;
}
document.addEventListener('click', e => {
  if (e.target && /** @type {HTMLElement} */ (e.target).dataset && /** @type {HTMLElement} */ (e.target).dataset.kobsettings) {
    e.preventDefault();
    switchTab('settings');
    /** @type {VEl} */ ($('kobToken')).focus();
  }
});
// Send users to ⚙ Settings ▸ Devices, a different panel from the one above, rather than landing
// on the password field and requiring them to scroll to the setting they need.
//
// 🔴 NOT A LINK INSIDE THE DIALOG. `modal()` closes on its own buttons, on Esc and on the
// backdrop, and on nothing else: an <a> in the body would switch the tab BEHIND a modal that is
// still up, over a panel he cannot reach. It is a modal BUTTON for that reason — see
// `kobConfirmGpus`.
function kobOpenDevices() {
  switchTab('settings');
  // Devices is the first panel of the tab, so this is a no-op on a fresh switch and the real
  // thing when the panel was already open and scrolled elsewhere.
  const el = $('devList');
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
}

// Turns a route's machine-readable code into an actionable sentence.
//
// The codes (kobold_auth / kobold_unreachable) are for the CODE to branch on. They must
// never reach the screen — they did, because jget dropped the body, and "kobold_auth" in red
// tells you nothing about what to do. Each branch names the cause AND the fix.
/** @param {ErrLike} e */
export function kobErrHtml(e) {
  const b = (e && e.body) || {};
  const url = b.url ? `<code>${esc(b.url)}</code>` : 'the configured URL';
  if (b.error === 'kobold_auth')
    return (
      `<b>Can't sign in to KoboldCpp's admin.</b> The admin password is missing or wrong, ` +
      `so KoboldCpp won't list its models.<div style="margin-top:6px">Set it in ${kobSettingsLink()} — ` +
      `it's the <code>--adminpassword</code> from KoboldCpp's own launch settings.</div>` +
      // Kobold answers a wrong password with an empty list and a 200, so "wrong password",
      // "admin mode off" and "admindir missing" are one response. Say so rather than
      // asserting the most likely one as if it were known.
      `<div class="muted" style="margin-top:6px">KoboldCpp reports all of these the same way, so it could also be that admin mode is off (<code>--admin</code>) or its <code>--admindir</code> is missing.</div>`
    );
  if (b.error === 'kobold_unreachable')
    return (
      `<b>KoboldCpp isn't answering at ${url}.</b>` +
      `<div style="margin-top:6px">Either it isn't running, or the URL is wrong — check it in ${kobSettingsLink()}.</div>` +
      `<div class="muted" style="margin-top:6px">${esc(b.message || e.message || '')}</div>`
    );
  if (b.error === 'unknown_config')
    return (
      `<b>${esc(b.message || 'That config no longer exists.')}</b>` +
      `<div style="margin-top:6px">It may have been renamed or removed since this list was loaded.</div>`
    );
  return `<b>${esc(b.message || e.message || 'Something went wrong talking to KoboldCpp.')}</b>`;
}

/** The sentence shown when the KoboldCpp address is not treated as this machine. "another box" was
 * wrong in the Docker package, where a server on the SAME machine as the container is reached as
 * `host.docker.internal` and so looks remote; the way to say "it is here" is the environment
 * setting, which the Docker user puts in compose.local.yaml (release audit 2026-10-11, item 8).
 * Exported for the specs. @returns {string} */
export function kobNotLocalNote() {
  return DOCKER
    ? 'Vocalis is not treating this server as being on this machine, so load and unload work but VRAM is not measured here. If it is on this machine, add VOCALIS_KOBOLD_LOCAL=1 for Vocalis in compose.local.yaml and restart Vocalis.'
    : 'Vocalis is not treating this server as being on this machine, so load and unload work but VRAM is not measured here. If it is on this machine, set VOCALIS_KOBOLD_LOCAL=1.';
}

export async function kobLoadAll() {
  kobPollStop();
  let info;
  try {
    info = await jget('/kobold/info');
  } catch (e) {
    info = { available: false, url: '?', error: /** @type {ErrLike} */ (e).message };
  }
  kob.info = info;
  if (!info.available) {
    // NAME THE URL IT TRIED and put the fix one click away. "no KoboldCpp at
    // https://127.0.0.1:5001", never "no KoboldCpp on this host" — the URL is the first thing
    // to suspect, and the alternative to a link here is an SSH session.
    /** @type {VEl} */ ($('kobMain')).style.display = 'none';
    /** @type {VEl} */ ($('kobUnavail')).style.display = '';
    if (!info.url) {
      // Docker image: there is deliberately no built-in address (127.0.0.1 would be the container
      // itself), so an empty URL means "never set up", which is not a server that is down.
      /** @type {VEl} */ ($('kobUnavailMsg')).innerHTML =
        `<b>KoboldCpp is not set up yet.</b>` +
        `<div style="margin-top:8px">Enter its address in ${kobSettingsLink()} (for a KoboldCpp on this machine: <code>http://host.docker.internal:&lt;port&gt;</code>).</div>` +
        `<div class="muted" style="margin-top:8px">Nothing here is needed unless you run KoboldCpp and want to load its models from Vocalis.</div>`;
      return;
    }
    /** @type {VEl} */ ($('kobUnavailMsg')).innerHTML =
      `<b>KoboldCpp isn't answering at <code>${esc(info.url)}</code>.</b>` +
      `<div style="margin-top:8px">Either it isn't running on <b>${esc(info.host || 'that host')}</b>, or the URL is wrong — check it in ${kobSettingsLink()}.</div>` +
      `<div class="muted" style="margin-top:6px">${esc(info.error || '')}</div>` +
      `<div class="muted" style="margin-top:8px">Nothing here is needed unless you run KoboldCpp and want to load its models from Vocalis.</div>`;
    return;
  }
  /** @type {VEl} */ ($('kobUnavail')).style.display = 'none';
  /** @type {VEl} */ ($('kobMain')).style.display = '';
  /** @type {VEl} */ ($('kobHostLine')).innerHTML = info.local
    ? `KoboldCpp ${esc(info.version || '')} on <b>this box</b> — <code>${esc(info.url)}</code>`
    : // Stated plainly rather than degraded silently: the tab says which box it is driving, so
      // the missing VRAM figure below reads as "can't see it from here" rather than as nothing.
      `KoboldCpp ${esc(info.version || '')} on <b>${esc(info.host)}</b> — <code>${esc(info.url)}</code>` +
      ` · <span class="muted">${esc(kobNotLocalNote())}</span>`;
  await kobLoadConfigs();
  kobPoll();
  kob.timer = setInterval(kobPoll, 4000);
}

async function kobLoadConfigs() {
  const sel = /** @type {HTMLSelectElement} */ ($('kobSel'));
  try {
    const r = await jget('/kobold/configs');
    kob.configs = r.configs || [];
    // The label is the FILENAME, verbatim. Vocalis reads no meaning into it — a previous
    // version pinned "★" names to the top on an implicit sorting rule (see kobold.sort_key).
    // The subdirectory prefix is kept because it is NOT noise: Kobold's list descends one
    // level, so two rows can be the same config from different folders, and the prefix is
    // the only thing telling a live one from a stale backup copy.
    sel.innerHTML = kob.configs.map(c => `<option value="${esc(c.name)}">${esc(c.label)}</option>`).join('');
    // The user's selection wins over the server default. This drop-down is an
    // INPUT, not a status read-out — the box below says what is actually loaded. Preserve the
    // selected config when switching tabs rather than resetting to the first row.
    //
    // The pick lives in the account-local UI state, so it is server-side and encrypted
    // (5.0-M8): it survives a restart of Vocalis and follows the account across browsers. This
    // avoids tying the selection to a single browser profile.
    //
    // Only a pick Kobold still offers: a renamed or deleted config falls through to r.default
    // (loaded config -> last_config -> first) exactly as before, never an empty select.
    const pick = UIS.getItem('vocalis-kob-cfg');
    if (pick && kob.configs.some(c => c.name === pick)) sel.value = pick;
    else if (r.default) sel.value = r.default;
    kobRenderDetail();
  } catch (e) {
    // [] from Kobold is a 200 and means wrong password / admin off / missing admindir /
    // genuinely empty — indistinguishable. Never render it as "no configs found".
    sel.innerHTML = '';
    /** @type {VEl} */ ($('kobDetail')).innerHTML = `<div style="color:var(--err)">${kobErrHtml(/** @type {ErrLike} */ (e))}</div>`;
  }
  kobButtons();
}

function kobRenderDetail() {
  const c = kob.configs.find(x => x.name === /** @type {HTMLSelectElement} */ ($('kobSel')).value);
  if (!c) {
    /** @type {VEl} */ ($('kobDetail')).textContent = '—';
    return;
  }
  const d = c.detail;
  if (!d) {
    // remote: degraded to what list_options gave us, deliberately, not by accident
    /** @type {VEl} */ ($('kobDetail')).innerHTML =
      `<code>${esc(c.name)}</code> · <span class="muted">details live on ${esc((kob.info && kob.info.host) || 'the other box')}</span>`;
    return;
  }
  if (d.unreadable_here) {
    // Normal in the container (the .kcpps folder is on the host): neutral, never red.
    /** @type {VEl} */ ($('kobDetail')).innerHTML =
      `<code>${esc(c.name)}</code> · <span class="muted">details of this config are not readable from here</span>`;
    return;
  }
  if (d.error) {
    /** @type {VEl} */ ($('kobDetail')).innerHTML = `<code>${esc(c.name)}</code> · <span style="color:var(--err)">${esc(d.error)}</span>`;
    return;
  }
  const bits = [];
  if (d.contextsize) bits.push(`ctx <b>${d.contextsize.toLocaleString()}</b>`);
  if (d.gpulayers != null) bits.push(`gpulayers <b>${d.gpulayers}</b>`);
  if (Array.isArray(d.usevulkan) && d.usevulkan.length) bits.push(`cards <b>${d.usevulkan.join(', ')}</b>`);
  let miss = '';
  if (d.model_param && d.model_exists === false) {
    // "missing" must distinguish not-there from can't-see-it. When EVERY config's model is
    // missing at once that is a locked 5.x vault (exists() on a routed store answers False
    // and never raises), not four deleted models.
    miss = d.models_all_missing
      ? ` · <span style="color:var(--warn)">model not visible — every config's model is unreadable at once, which usually means a locked vault rather than a missing file</span>`
      : ` · <span style="color:var(--err)">model file missing</span>`;
  }
  /** @type {VEl} */ ($('kobDetail')).innerHTML =
    bits.join(' · ') + (d.model_param ? ` · <code class="muted">${esc(d.model_param)}</code>` : '') + miss;
}
// The pick is PERSISTED here and nowhere else — only a human choosing a row writes it, so
// nothing the server preselects can masquerade as a user choice. (Writing it back from
// kobLoadConfigs would freeze the first day's default in place forever.)
/** @type {VEl} */ ($('kobSel')).addEventListener('change', () => {
  UIS.setItem('vocalis-kob-cfg', /** @type {HTMLSelectElement} */ ($('kobSel')).value);
  kobRenderDetail();
  kobButtons();
});

// The buttons must READ the live state, not just fire actions at it. They didn't: with a
// model loaded the tab said "● Loaded" at the bottom while the only button still said Load
// and sat there enabled, offering to reload a model that was already loaded.
//
// So: Load acts on the SELECTED config and goes quiet when that one is already in; Unload
// exists only when there is something to unload. Two buttons rather than one that changes
// its verb, because with a model loaded there are two DIFFERENT things you might want —
// swap to another config, or give the cards back — and one button can only offer one.
function kobButtons() {
  const sel = /** @type {HTMLSelectElement} */ ($('kobSel')),
    name = sel.value,
    loadedName = (kob.status && kob.status.config) || null;
  const loaded = !!(kob.status && kob.status.loaded);
  // !! because `loaded&&loadedName&&…` yields null when nothing named the config, and
  // assigning null to .disabled only works by coercion. Say what is meant.
  const isLoaded = !!(loaded && loadedName && loadedName === name);
  /** @type {HTMLButtonElement} */ ($('kobLoad')).disabled = !!(!sel.options.length || kob.loading || kob.unloading || isLoaded);
  /** @type {VEl} */ ($('kobLoad')).textContent = kob.loading ? 'Loading…' : isLoaded ? 'Loaded' : 'Load';
  /** @type {VEl} */ ($('kobLoad')).title = isLoaded
    ? 'This config is already loaded. Pick a different one to swap, or press Unload to free the cards.'
    : 'Load this config into KoboldCpp.';
  const u = /** @type {HTMLButtonElement} */ ($('kobUnload'));
  u.style.display = loaded ? '' : 'none';
  u.disabled = !!(kob.loading || kob.unloading);
  u.textContent = kob.unloading ? 'Unloading…' : 'Unload';
}

async function kobPoll() {
  try {
    const s = await jget('/kobold/status');
    kob.status = s;
    if (s.loaded) {
      let who;
      if (s.how === 'derived' || s.how === 'learned') {
        const c = kob.configs.find(x => x.name === s.config);
        who = `<b>${esc(c ? c.label : s.config)}</b>`;
      } else if (s.how === 'ambiguous')
        // A tie is not a license to pick one.
        who = `<b>loaded outside Vocalis</b> <span class="muted">(more than one config names this model)</span>`;
      else who = `<b>loaded outside Vocalis</b>`;
      /** @type {VEl} */ ($('kobStatus')).innerHTML =
        `● Loaded — ${who}<div class="muted" style="margin-top:2px"><code>${esc(s.model)}</code></div>`;
      if (kob.loading) {
        kob.loading = false;
        kobLoadConfigs();
      }
    } else if (kob.loading) {
      // No ETA. A 40-55 GB load off the array takes real time and no run has been cleanly
      // timed, so this stays indeterminate rather than shipping a guessed duration.
      /** @type {VEl} */ ($('kobStatus')).innerHTML =
        `◌ <b>Loading…</b> <span class="muted">this takes a while for a large model — the tab updates when it lands</span>`;
    } else {
      /** @type {VEl} */ ($('kobStatus')).innerHTML = '○ No model loaded — KoboldCpp is idle (admin/switcher only).';
    }
    if (s.local) {
      // A LABEL on a number Vocalis already measures, not a new estimate. Never a file-size
      // estimate: a sharded model_param undercounts by 15 GB and the stack under-attributes
      // ~20 GB anyway. And Kobold cannot be cleanly separated from ComfyUI — both are
      // "other" — so say so rather than inventing an attribution.
      /** @type {VEl} */ ($('kobVram')).innerHTML =
        `Non-Vocalis VRAM on the cards: <b>${s.other_vram_gb} GB</b>` +
        ` <span class="muted">— measured whole-card usage minus Vocalis's own share. If ComfyUI is also up, this is the two of them combined.</span>`;
    } else {
      // Not a zero, and not a blank. A blank invites a question; a zero answers it falsely.
      /** @type {VEl} */ ($('kobVram')).innerHTML =
        `<span class="muted">KoboldCpp is on <b>${esc(s.host)}</b> — VRAM not measurable from here.</span>`;
    }
  } catch (e) {
    // Mid-load/unload this is EXPECTED, not an error: the swap kills Kobold's model child,
    // which is the process holding the listening socket, so the port refuses connections —
    // measured at ~16 s of an 18 s load. Saying "unreachable" there would be a lie.
    if (kob.loading || kob.unloading)
      /** @type {VEl} */ ($('kobStatus')).innerHTML =
        `◌ <b>${kob.unloading ? 'Unloading' : 'Loading'}…</b> <span class="muted">KoboldCpp is restarting its model process — it stops answering for a few seconds here</span>`;
    else {
      kob.status = null;
      /** @type {VEl} */ ($('kobStatus')).innerHTML = `<div style="color:var(--err)">${kobErrHtml(/** @type {ErrLike} */ (e))}</div>`;
    }
  }
  kobButtons();
}

/** @type {VEl} */ ($('kobLoad')).addEventListener('click', async () => {
  const name = /** @type {HTMLSelectElement} */ ($('kobSel')).value;
  if (!name) return;
  // 9.3 — '' unless the setting is on, KoboldCpp is local, and something is actually ticked.
  // ONE dialog either way: with a model already in, this rides inside the swap warning rather
  // than opening a second modal behind it. Two modals for one click is a nag, and the second
  // one gets dismissed unread.
  const gpus = kobGpuWarnHtml();
  // Swapping while a model is in kills whatever that model is doing — same consequence as an
  // Unload, so it gets the same warning rather than being the quiet path to the same place.
  if (kob.status && kob.status.loaded) {
    if (
      !(await kobConfirmDrop(
        'Load a different model?',
        'KoboldCpp can only hold one model at a time, so this unloads the current one first.',
        gpus,
      ))
    )
      return;
  } else if (gpus && !(await kobConfirmGpus(gpus))) return;
  kob.loading = true;
  kobButtons();
  /** @type {VEl} */ ($('kobStatus')).innerHTML = '◌ <b>Loading…</b>';
  try {
    await jpost('/kobold/load', { filename: name });
  } catch (e) {
    kob.loading = false;
    kobButtons();
    await modal('Could not load', kobErrHtml(/** @type {ErrLike} */ (e)), [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  kobPoll();
});

// The one warning that IS the safety: Kobold exposes no queue endpoint, so there is no cheap
// way to know whether a reply is in flight. Until there is, this sentence is all that stands
// between a click and a dropped chat.
//
// It says the CONNECTION drops, not just the reply. The design claimed the HTTP listener
// survives an unload and that was measured false — the listening socket belongs to the model
// child that gets killed, so SillyTavern loses the connection itself for a few seconds. A
// warning that undersells the consequence is worse than none: it gets trusted.
//
// It lives in ONE function because it now has two callers — the Unload/Load buttons here, and
// m3's pre-render offer, which drops a model just as dead. Two copies would drift, and the
// copy that drifts is the one that gets softer.
export function kobDropWarnHtml() {
  return (
    `<div style="margin-top:8px">If SillyTavern (or anything else) is mid-reply on KoboldCpp right now, <b>that reply dies</b> — and KoboldCpp stops answering entirely for a few seconds while it restarts its model process, so open connections drop too.</div>` +
    `<div class="small muted" style="margin-top:8px">Vocalis can't tell whether KoboldCpp is busy — it exposes no way to ask.</div>`
  );
}
// 🔴 CANCEL IS FIRST, AND IT HAS TO BE. `modal()` resolves `actions[0].value` on Esc AND on a
// backdrop click — "the first action, which is the cancel by convention", as its own comment
// says. With Continue first, tapping Esc on *Unload the model and free the cards?* resolved 1
// and went ahead and dropped the model: the destructive default, reachable by the key everyone
// presses to back out. Every other modal in the tree already orders it this way — the
// pre-render offer in js/book/job.js included — and this one did not. The VALUES are unchanged,
// so both callers still read `1` as go.
/**
 * @param {string} title
 * @param {string} why
 * @param {string} [extra] - an extra warning block (9.3's ticked cards), placed above the drop
 *   warning: it is about what happens BEFORE the load, and the drop warning is the last word
 *   because it is the one that costs someone a reply.
 */
function kobConfirmDrop(title, why, extra) {
  return modal(title, why + (extra || '') + kobDropWarnHtml(), [
    { label: 'Cancel', value: 0 },
    { label: 'Continue', class: 'primary', value: 1 },
  ]);
}

// ── the ticked-cards warning (9.3) ────────────────────────────────────────
// Warn when KoboldCpp is about to load a model while Vocalis still has selected GPU cards.
//
// 🔴 IT NAMES THE CARDS. "Some cards are in use" is a sentence you can only act on by going and
// looking; `cuda:0 — NVIDIA GeForce RTX 4090` is the row to untick. The route sends the list for
// exactly that reason rather than sending a boolean it had already decided.
//
// ⚠️ AND IT SAYS WHAT UNTICKING ACTUALLY DOES, because a warning that only says "don't" gets
// dismissed. Unticking a card in ⚙ Settings ▸ Devices drops the pool and gives the VRAM back
// there and then — unless a render is in flight, in which case the change is saved and applies at
// the next build (`/devices`' PUT: `changed and model_ready() and GPUS.acquire(timeout=0.1)`).
//
// 📌 EMPTY STRING WHEN THERE IS NOTHING TO SAY, so the caller can concatenate it unconditionally.
// Three ways to get one and they are the same answer: the setting is off, KoboldCpp is on another
// box (the route sends neither field), or nothing is ticked.
function kobGpuWarnHtml() {
  const s = kob.status;
  if (!s || !s.warn_gpus) return '';
  const cards = s.vocalis_gpus || [];
  if (!cards.length) return '';
  const rows = cards.map(c => `<li><code>${esc(c.id)}</code> — ${esc(c.label)}</li>`).join('');
  return (
    `<div style="margin-top:8px"><b>Vocalis still has ${cards.length === 1 ? 'a card' : cards.length + ' cards'} ticked on this box</b>, and KoboldCpp runs here too — so the model is about to load onto hardware Vocalis is holding:</div>` +
    `<ul style="margin:6px 0 0 18px">${rows}</ul>` +
    `<div class="small muted" style="margin-top:8px">Untick them in ⚙ Settings ▸ Devices to give the memory back — that drops Vocalis's model straight away, or at the end of a render if one is running. <b>⏏ Free Vocalis VRAM</b> in the header releases the rest; it restarts the engine, and the web UI stays up.</div>` +
    `<div class="small muted" style="margin-top:6px">Vocalis can't tell how much KoboldCpp is about to want, so this asks rather than deciding for you. Turn it off under <b>Devices</b> in ⚙ Settings — the same box that warns you the other way round.</div>`
  );
}
// The standalone dialog — used when nothing is loaded, so there is no drop to confirm. Three
// buttons, because "go and untick them" is the outcome the warning is for: making a user cancel,
// find the tab and scroll is how a warning becomes a thing you click past.
// Cancel first, for the reason `kobConfirmDrop` gives above.
/** @param {string} html @returns {Promise<boolean>} true = load anyway */
async function kobConfirmGpus(html) {
  const v = await modal('Vocalis still has cards ticked', html, [
    { label: 'Cancel', value: 0 },
    { label: 'Open ⚙ Settings ▸ Devices', value: 2 },
    { label: 'Load anyway', class: 'primary', value: 1 },
  ]);
  if (v === 2) kobOpenDevices();
  return v === 1;
}

/** @type {VEl} */ ($('kobUnload')).addEventListener('click', async () => {
  if (
    !(await kobConfirmDrop(
      'Unload the model and free the cards?',
      'KoboldCpp stays running as an admin/switcher — it just stops holding the model.',
    ))
  )
    return;
  kob.unloading = true;
  kobButtons();
  /** @type {VEl} */ ($('kobStatus')).innerHTML = '◌ <b>Unloading…</b>';
  try {
    const r = await jpost('/kobold/unload', {});
    // A MEASURED delta, not a self-report and never a file-size estimate: the freed figure is
    // the whole-card before/after, taken once the model actually reads as gone.
    if (r.freed_gb != null)
      /** @type {VEl} */ ($('kobVram')).innerHTML =
        `<b style="color:var(--ok)">Freed ${r.freed_gb} GB.</b> <span class="muted">Measured on the cards, before vs after.</span>`;
  } catch (e) {
    await modal('Could not unload', kobErrHtml(/** @type {ErrLike} */ (e)), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    kob.unloading = false;
    kobPoll();
    kobLoadConfigs();
  }
});

// ── ⚙ Settings ▸ KoboldCpp ──────────────────────────────────────────────────
// The password is WRITE-ONLY. The GET returns kobold_adminpassword_set (a bool) and never
// the value, so this renders STATE — "set — Change / Clear" — and the input is EMPTY except
// while the user is typing into it. That is why the field is safe, and
// it is what makes the Show checkbox safe too: it cannot reveal a stored or autofilled
// credential, because there isn't one to reveal. The moment the GET returns the string to
// pre-populate this input, the secret is in the DOM, in every settings fetch, and in
// whatever Chrome decides to remember.
/** @param {KoboldSettingsSlice} s */
export function kobRenderSettings(s) {
  if (!s) return;
  /** @type {HTMLInputElement} */ ($('kobUrl')).value = s.kobold_url || '';
  /** @type {HTMLInputElement} */ ($('kobToken')).value = ''; // never pre-populated — see above
  const set = !!s.kobold_adminpassword_set;
  /** @type {HTMLInputElement} */ ($('kobToken')).placeholder = set ? '•••••••• (set — type to change)' : 'not set';
  /** @type {VEl} */ ($('kobPwState')).textContent = set
    ? 'Password is set. Type a new one and press Save to change it, or press Clear to remove it.'
    : 'No password set — loading and unloading are disabled until you set one.';
  /** @type {HTMLButtonElement} */ ($('kobClear')).disabled = !set;
}
// 🔴 NO `#kobWarnGpus` HERE ANY MORE (9.5.9). The ticked-cards warning is governed by ONE
// checkbox, `#devWarnLlm` in ⚙ Settings ▸ Devices, because it is one condition asked from either
// end — tick a card with a model in, or load a model with a card ticked. This panel painted and
// saved a second switch over
// that same fact, so turning it off silenced the load side while the Devices box still said
// warnings were on. `/kobold/status` reads `devices_warn_llm_loaded` for its `warn_gpus` now, and
// `kobGpuWarnHtml` below is unchanged: it still just believes the route.
// The mask is non-standard (-webkit-text-security). Where it is unsupported the value is
// VISIBLE rather than broken — acceptable, since the field is empty except while typing —
// but then an unchecked "Show password" box sitting beside a plainly visible secret is a
// control reporting the opposite of what is on screen. Hide it instead: degrade, don't mislead.
if (!(window.CSS && CSS.supports && CSS.supports('-webkit-text-security', 'disc'))) {
  /** @type {VEl} */ ($('kobShowWrap')).style.display = 'none';
  /** @type {VEl} */ ($('kobToken')).classList.remove('masked');
}
// Toggles the CLASS, never el.type. `el.type='text'` is the obvious one-liner and it is the
// wrong one: identical on screen, but it re-arms spell-jacking (text inputs are not excluded
// from spellcheck telemetry, and this field's spellcheck="false" is scoped to a type that
// never moves) AND hands the field back to Chrome's password manager — undoing both
// decisions invisibly. The type is `text` permanently; only the mask moves.
/** @type {VEl} */ ($('kobShow')).addEventListener('change', () => {
  /** @type {VEl} */ ($('kobToken')).classList.toggle('masked', !(/** @type {HTMLInputElement} */ ($('kobShow')).checked));
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE THIRD PIECE — kobShowTest and the #kobSave / #kobClear wiring. It had no banner and sat
// inside the Nomi pairing area, ~130 lines below the panel it belongs to. Verbatim, and now
// directly under the kobRenderSettings it has always worked with.
// Saving TESTS the connection and says what happened. Without it, a wrong password is
// invisible here and only surfaces two tabs away — and Kobold reports a wrong password as an
// empty list with a 200, so the tab can't say for certain what went wrong either. The test
// asks the one endpoint that answers honestly (the unauthenticated version probe) and can
// therefore tell "wrong password" apart from "admin mode is off".
/** @param {KoboldTestResult} r */
function kobShowTest(r) {
  const el = /** @type {VEl} */ ($('kobTestResult'));
  el.style.display = '';
  if (r.ok) {
    el.innerHTML = `<span style="color:var(--ok)">✓ Connected to KoboldCpp ${esc(r.version || '')} at <code>${esc(r.url)}</code> — admin accepted, ${r.configs} config${r.configs === 1 ? '' : 's'} available.</span>`;
    return;
  }
  const fix =
    {
      unreachable: 'Nothing answered there. Check that KoboldCpp is running and that the URL (and port) are right.',
      no_password: 'Set the admin password above — it is the <code>--adminpassword</code> KoboldCpp was started with.',
      admin_off: 'Start KoboldCpp with <code>--admin</code> and <code>--admindir</code> so it can switch models.',
      bad_password: 'That password was rejected. Check the <code>--adminpassword</code> KoboldCpp was started with.',
    }[/** @type {'unreachable'|'no_password'|'admin_off'|'bad_password'} */ (r.reason)] || '';
  el.innerHTML =
    `<span style="color:var(--err)">✗ ${esc(r.message || 'Could not reach KoboldCpp.')}</span>` +
    (fix ? `<div class="muted" style="margin-top:4px">${fix}</div>` : '');
}
/** @type {VEl} */ ($('kobSave')).addEventListener('click', async () => {
  // Omitted != empty. The URL is always sent; the password is sent only when the user typed one,
  // so saving a URL edit leaves the stored password intact rather than silently wiping it.
  /** @type {{kobold_url: string, kobold_adminpassword?: string}} */
  const body = { kobold_url: /** @type {HTMLInputElement} */ ($('kobUrl')).value.trim() };
  if (/** @type {HTMLInputElement} */ ($('kobToken')).value)
    body.kobold_adminpassword = /** @type {HTMLInputElement} */ ($('kobToken')).value;
  /** @type {HTMLButtonElement} */ ($('kobSave')).disabled = true;
  /** @type {VEl} */ ($('kobTestResult')).style.display = 'none';
  try {
    kobRenderSettings(await jput('/settings/app', body));
    /** @type {HTMLInputElement} */ ($('kobShow')).checked = false;
    /** @type {VEl} */ ($('kobToken')).classList.add('masked'); // showing is a deliberate act each time
    /** @type {VEl} */ ($('kobTestResult')).style.display = '';
    /** @type {VEl} */ ($('kobTestResult')).innerHTML = '<span class="muted">Testing…</span>';
    kobShowTest(await jpost('/kobold/test', {})); // test what was SAVED, not what was typed
  } catch (e) {
    await modal('Could not save', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    /** @type {HTMLButtonElement} */ ($('kobSave')).disabled = false;
  }
});
/** @type {VEl} */ ($('kobClear')).addEventListener('click', async () => {
  if (
    !(await modal(
      'Clear the KoboldCpp admin password?',
      'Vocalis will not be able to load or unload models until you set it again. KoboldCpp itself is unaffected.',
      [
        { label: 'Clear', class: 'primary', value: 1 },
        { label: 'Cancel', value: 0 },
      ],
    ))
  )
    return;
  // An explicit empty string CLEARS — distinct from omitting the key, which leaves it alone.
  try {
    kobRenderSettings(await jput('/settings/app', { kobold_adminpassword: '' }));
    /** @type {VEl} */ ($('kobTestResult')).style.display = 'none'; // the verdict is about a password that's gone
  } catch (e) {}
});
