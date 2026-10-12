// sys/hwstrip.js — the hardware strip: VRAM cards, the CPU line, CPU MEM (7.3-m3), plus the
// two system lines in the header's first column (7.3.2) — swap and memory pressure. Those two
// draw OUTSIDE the strip, in the opposite column, but they are fed by the same `/system/stats`
// sample and gated by the same `strip.numDue`, so splitting them out would mean a second copy
// of that machinery to keep in step with this one.
//
// THIS IS ONE SENSOR PANEL, NOT THREE, AND THAT IS WHY IT MOVES AS ONE FILE. The three
// banners it spans — the cards, the CPU line, CPU MEM — draw different quantities but they
// are one instrument: one sample of `/system/stats` feeds all three, `renderStrip` is the
// single entry point that fans it out, and every row shares the same four decisions about
// how a live figure is made readable. `POLL_MS` (the sample rate), `NUM_MS` (how often the
// NUMBERS are rewritten), `sm` (the rolling mean that turns a jittery instantaneous reading
// into something the eye can hold) and `strip.numDue` (the gate that halves the redraw rate
// of every printed figure at once) are shared by all three rows. Split them into three files
// and each copy of that machinery starts drifting, which is precisely the failure the
// comments below spend most of their length preventing — a bar and the number beside it
// telling you two different things.
//
// 🔴 FOUR EXPORTS, AND THE OTHER FOURTEEN DEFINITIONS STOP BEING GLOBALS ENTIRELY.
// `renderStrip`, `startIdleVram`, `stopIdleVram` and `pollVram` are the whole outside surface:
// the strip is either being polled (idle) or being pushed a sample off a running job's SSE
// stream, and those four are how the rest of the page says which. `sm`, `r0`, `f1`, `uSlot`,
// `strip`, `_win`, `renderVram`, `buildVram`, `updateVram`, `gpuSensorTitle`, `renderCpu`,
// `renderCpuMem`, `fmtDur` and `renderSysMem` had no caller outside this range and are now
// module-private.
//
// 🔴 `startIdleVram` MUST STAY PUBLISHED BY THE SHIM'S `Object.assign`. `js/main.js` — the boot
// sequence — calls it, and it reaches it as a global resolved at CALL time (§11.3's
// module → inline direction). Drop it from the assign list and the boot sequence throws
// `startIdleVram is not a function` after `switchTab`, which leaves the page up but with the
// strip permanently blank and no error anywhere near the cause. The same holds for `pollVram`
// and `stopIdleVram`, which the still-inline model buttons, ComfyUI buttons and the book
// render's `openStream`/`endJob` reach the same way, and for `renderStrip`, which both SSE
// event handlers call on every `vram` frame.
//
// ⚠️ NOTHING HERE IS PARSE-TIME REACHABLE, WHICH IS WHY IT COULD MOVE WHOLE. Checked by hand
// and transitively: the range contains no top-level executing statement at all — it is
// twenty-one declarations and nothing else. Outside it, every reference sits inside a function
// body or inside a handler passed to `addEventListener`/`.onclick`, and registering is not
// calling (§3.1). The two multi-line top-level statements that LOOK dangerous — the
// `$('freeBtn').onclick=async()=>{…}` and `$('comfyBtn').onclick=async()=>{…}` blocks, exactly
// blind spot (b) of §3.1a — name `pollVram` only inside the async arrow they install, so it
// cannot run before there is a user.

import { $, esc } from '../util/dom.js';
import { state } from '../util/appstate.js'; // 7.3-m12d: was the page's last shared global
import { jget } from '../util/http.js';

// ── the wire shapes `/system/stats` actually carries (8.3) ───────────────────
// 🔴 NOT `GpuCard`. `/gpus` (types/vocalis.d.ts) is the permission-gated registry with `allows`;
// this is `runtime/gpu.py`'s `strip_sample()` — telemetry sampled 4x/s, no `allows` anywhere in
// it. Reusing GpuCard here would either grow it fields no picker needs or let a permission row be
// read for a sensor value it was never given. Two different questions, two types.

/** One GPU sample from `/system/stats`; unavailable sensor fields are null.
 * * @typedef {object} GpuSample
 * @property {number} index
 * @property {string} name
 * @property {number} total_gb
 * @property {number} free_gb
 * @property {number} used_gb        Whole-card, from the sysfs sensor — not torch's own view.
 * @property {number} vocalis_gb     This process's own share, always `<= used_gb`.
 * @property {number|null} util_pct
 * @property {number|null} temp_c
 * @property {number|null} power_w
 * @property {number|null} sclk_mhz  Core clock — 0 is a real reading (clock-gated, i.e. idle).
 * @property {number|null} mclk_mhz  VRAM clock.
 * @property {number|null} fan_pct   Fan duty cycle, 0-100 (10.21) — `tts_utils.gpu_fan_pct()`'s
 *   `pwm1 / pwm1_max` on AMD cards, and NVML's `nvmlDeviceGetFanSpeed` on a satellite's NVIDIA
 *   card: the SAME quantity on both vendors (the fan's commanded target, never a measured RPM).
 *   `0` is a real reading — an idle 4090 stops its fans entirely — and is shown, never hidden,
 *   same rule as `sclk_mhz`'s 0.
 */

/** GPU sample reported by a satellite, with remote identity and sensor values.
 * * @typedef {object} SatelliteGpuSample
 * @property {number} index
 * @property {string} device    e.g. `"cuda:0"` — printed verbatim, not reconstructed from index.
 * @property {string} name
 * @property {number|null} total_gb   `null` (or absent) when the satellite cannot read its card
 *   (October 10, 2026: an AMD satellite, or one without nvidia-ml-py) — never a stand-in for 0.
 * @property {number|null} free_gb
 * @property {number|null} used_gb
 * @property {number|null} vocalis_gb
 * @property {number|null} util_pct
 * @property {number|null} temp_c
 * @property {number|null} power_w
 * @property {number|null} sclk_mhz
 * @property {number|null} mclk_mhz
 * @property {number|null} fan_pct
 */

/**
 * One configured satellite, as folded into `/system/stats`'s top-level `satellites` key — design
 * doc §6.2's "3-second rule". The key is ALWAYS present on a 10.21+ server (possibly `[]`); an
 * entry drops out of the array within 3 s of that satellite going silent and reappears on its
 * next good poll — this file never has to guess staleness, the absence already means "not now".
 * @typedef {object} SatelliteSample
 * @property {string} name
 * @property {SatelliteGpuSample[]} gpus
 */

/** CPU sample; fields other than core count may be null on unsupported systems.
 * * @typedef {object} CpuSample
 * @property {number|null} pct        top-style load; 100 = one logical core.
 * @property {number|null} mhz
 * @property {number|null} power_w    Needs the RAPL udev rule; absent when it is not configured.
 * @property {number|null} temp_c
 * @property {"hwinfo"|"lhm"|null} temp_src  Which app supplied `temp_c` on Windows — `null` on
 *   Linux (`temp_c` there comes straight off hwmon, not a monitoring app) and on Windows itself
 *   whenever neither HWiNFO nor LibreHardwareMonitor is currently running.
 * @property {string} [temp_hint]  Windows only, and only when `temp_c` is `null` — how to get a
 *   real reading. Its mere PRESENCE is the platform signal `renderCpu` folds into the row's
 *   tooltip; this file never checks the OS itself (`tts_utils._win_cpu_stats`).
 * @property {number} cores
 * @property {number|null} mem_used_gb
 * @property {number|null} mem_total_gb
 * @property {number|null} mem_reclaimable_gb  ZFS ARC above its floor. `null` off ZFS.
 * @property {number|null} swap_used_gb
 * @property {number|null} swap_total_gb
 * @property {MemPsi|null} mem_psi
 * @property {number|null} uptime_s
 * @property {number[]|null} loadavg  [1min, 5min, 15min].
 */

/**
 * `/proc/pressure/memory`'s `some` line — `tts_utils._mem_psi()`.
 * @typedef {object} MemPsi
 * @property {number} avg10
 * @property {number} avg60
 * @property {number} avg300
 * @property {number} total_s   Monotonic since boot — never decays, unlike the three averages.
 */

/** Power sample; null indicates that no readable sensor is available.
 * * @typedef {object} PowerSample
 * @property {number} w
 * @property {number|null} cpu_w
 * @property {number|null} gpu_w
 * @property {number} gpus
 * @property {(number|null)[]} avg  1/5/15-minute means; `null` where the window is wider than
 *   the sampler has been running.
 * @property {number} span_s        Age of the oldest sample still held.
 * @property {number|null} peak_w
 * @property {number|null} peak_ago_s
 * @property {number|null} peak_cpu_w
 * @property {number|null} peak_gpu_w
 * @property {number} since_s
 * @property {number} n
 */

/** UPS sample; null indicates unavailable or stale telemetry.
 * * @typedef {object} UpsSample
 * @property {string} status
 * @property {number} load_pct
 * @property {number|null} w    Derived from load% against `nominal_w` — this unit has no real
 *   wattage field at all.
 * @property {number|null} peak_w  The worst draw ANY poll has seen since the server started —
 *   `runtime/ups.py`'s `_PEAK`, folded in by the poller rather than at render time, so a spike
 *   during an unattended overnight render is on record even though no tab was open for it.
 * @property {number} batt_pct
 * @property {number} runtime_s
 * @property {number} input_v
 * @property {number} nominal_w
 * @property {number} warn_pct
 * @property {string|null} model
 * @property {boolean} charging
 * @property {boolean} replace_batt
 * @property {number} age_s
 */

/**
 * The board/VRM/RAM temperatures — `runtime/temps.py`'s `snapshot()`. `null` on any box with no
 * board sensor; a PARTIAL object (missing `vrm`, say) is a real reading, not an error.
 * @typedef {object} TempsSample
 * @property {number} [mb]
 * @property {number} [vrm]
 * @property {number} [ram]
 * @property {number} [dimms]  Module count — what a RAM reading is the hottest OF.
 * @property {{mb?: number, vrm?: number, ram?: number}} warn  The server's own thresholds.
 */

/** System strip sample used to update GPU, CPU, power, and UPS readouts.
 * * @typedef {object} StripSample
 * @property {GpuSample[]} gpus
 * @property {CpuSample} cpu
 * @property {PowerSample|null} power
 * @property {UpsSample|null} ups
 * @property {TempsSample|null} temps
 * @property {SatelliteSample[]} [satellites]  The server's satellites (10.21) — ALWAYS present on a
 *   10.21+ server, possibly `[]`. Optional here only so a sample from an OLDER server (no key at
 *   all) still type-checks; every reader treats a missing key exactly like an empty array — see
 *   `renderVram`'s `satellites || []`.
 */

// ── the hardware strip ──────────────────────────────────────────────────────
// Four rows, one column of labels: GPU MEM / GPU / CPU / CPU MEM. Each row is
// <label> <bar> <stats>, so the eye reads down the labels and across each row, and the bars
// all start at the same x.
//
// Sampled 4x/s. One measurement found ~2 ms of sysfs reads per sample; at
// 4 Hz that is 0.8% of ONE core out of 32. So the rate is set by what reads well, not by
// what the box can afford. While a job runs, samples arrive PUSHED on that job's SSE
// stream at the same rate instead of being polled (design §5.0b).
const POLL_MS = 250;
// The BARS move at that rate. The NUMBERS are redrawn half as often, because a figure that
// changes 4x/s can be watched but not read.
//
// Redrawing less often is only half of it, though, and it's the half that doesn't matter:
// decimating the samples would show every other snapshot, so the number would still jump
// between arbitrary instantaneous readings — just half as often. The rate was never the
// problem, the VARIANCE was (an idle box genuinely reads 0%, then 41%, then 8% over three
// consecutive 250 ms windows). So each number is the MEAN over its own refresh window —
// which is exactly why Task Manager is readable at 1 Hz: its CPU% is already an average
// over that second, not the sample that happened to land on the tick.
//
// The bar shows that SAME mean, just redrawn every sample so it still glides — it is the
// same rolling series, running at most one sample ahead of the figure printed next to it.
// If the bar tracked the RAW signal while the number showed an average, a gauge and its own
// number would be telling you two different things — two readings that look like one.
const NUM_MS = 500;
/** @type {Record<string, [number,number][]>} */
const _win = {}; // key -> [[t, v], …] over the last NUM_MS
/**
 * Rolling mean over the last `NUM_MS`; null in, null out (an absent sensor stays absent).
 * @param {string} key
 * @param {number|null} v
 * @param {number} now
 * @returns {number|null}
 */
function sm(key, v, now) {
  if (v == null) return null;
  const a = _win[key] || (_win[key] = []);
  a.push([now, v]);
  while (a.length > 1 && a[0][0] <= now - NUM_MS) a.shift(); // <=, so "the last 0.5 s" is 2 samples, not 3
  return a.reduce((s, x) => s + x[1], 0) / a.length;
}
/** @param {number|null} v @returns {number|null} */
const r0 = v => (v == null ? null : Math.round(v));

// Rows are built ONCE and then updated in place. Re-rendering innerHTML 4x/s would be the
// one thing guaranteed to stop the bars looking smoother: a brand-new element has no prior
// width, so its CSS transition has nothing to animate FROM and it snaps. Same reason the
// skeleton is rebuilt only when the SHAPE changes (a card appears, or a sensor starts
// reporting) — enabling the RAPL udev rule makes CPU watts available mid-session, and that
// has to grow a new slot without a reload.
//
// The three element bags below are the DOM refs each `build*` wires once; `sclk`/`mclk`/`pw`/
// `temp` are optional because `buildVram` only builds the `uSlot` a sensor actually has (same
// rule the CPU line and CPU MEM row follow) and every write site already guards with `if(e.sclk)`.
/**
 * @typedef {object} VramCardEls
 * @property {VEl} cap
 * @property {VEl} used
 * @property {VEl} voc
 * @property {VEl} brow
 * @property {VEl} [urow]
 * @property {VEl} [fill]
 * @property {VEl} [pct]
 * @property {VEl} [sclk]
 * @property {VEl} [mclk]
 * @property {VEl} [fan]
 * @property {VEl} [pw]
 * @property {VEl} [temp]
 */
/**
 * @typedef {object} CpuEls
 * @property {VEl} fill
 * @property {VEl} pct
 * @property {VEl} [mhz]
 * @property {VEl} [pw]
 * @property {VEl} [temp]
 */
/**
 * @typedef {object} CpuMemEls
 * @property {VEl} fill
 * @property {VEl} pct
 * @property {VEl} arc
 * @property {VEl} mem
 */
/** Cached DOM references and signatures used by `renderStrip` to avoid unnecessary rebuilds.
 * * @typedef {object} StripCache
 * @property {string} sig                       The VRAM cards' shape signature — local cards
 *   AND every satellite's name + card list (10.21), so either one appearing or disappearing rebuilds.
 * @property {Record<string, VramCardEls>} cards  Keyed by CUDA index (as a string) for local
 *   cards, `"<satellite name>:<device>"` (e.g. `"test-satellite:cuda:0"`) for a satellite — namespaced so
 *   local `cuda:0` and a satellite's `cuda:0` never share a DOM row or smoothing slot (§7).
 * @property {string} cpuSig
 * @property {CpuEls|null} cpu
 * @property {CpuMemEls|null} cpuMem
 * @property {string} sysSig
 * @property {number} numAt    `performance.now()` of the last figure redraw.
 * @property {boolean} numDue  This tick redraws the printed numbers, not just the bars.
 */
/** @type {StripCache} */
const strip = {
  sig: '',
  cards: {},
  cpuSig: '',
  cpu: null,
  cpuMem: null,
  sysSig: '',
  numAt: 0,
  numDue: true,
};

/**
 * One sample of the whole strip, from the poll or from a job's SSE stream.
 * @param {StripSample} s
 */
export function renderStrip(s) {
  const now = performance.now();
  strip.numDue = now - strip.numAt >= NUM_MS - 20; // -20ms: don't let timer jitter skip a beat
  renderVram(s.gpus, s.satellites, now);
  renderCpu(s.cpu, now);
  renderCpuMem(s.cpu);
  // `s.power` and `s.ups` are SECOND AND THIRD sources in the same sample: the CPU block is read
  // at request time, while those two are the last thing their background samplers saw. Passed
  // separately rather than folded into `s.cpu` because neither is the CPU's — power is the whole
  // box, cards included, and the UPS is the whole box plus everything with no sensor in it.
  // `s.temps` is a FOURTH, and it is the odd one out twice over: read at request time like the
  // CPU block (no sampler — a board temperature has nothing sub-second to miss), and painted
  // OUTSIDE #sysMem, beside Log out.
  renderSysMem(s.cpu, s.power, s.ups, s.temps);
  if (strip.numDue) strip.numAt = now;
}
/** @param {string} k @param {string} cls @param {string} title @returns {string} */
const uSlot = (k, cls, title) => `<span class="usep">|</span><span class="${cls}" data-r="${k}" title="${esc(title)}"></span>`;
/** @param {number} x @returns {string} */
const f1 = x => (+x || 0).toFixed(1); // always one decimal — "5.0 GB", never a bare "5"
/** @param {unknown} x @returns {boolean} a real reading: a finite number, 0 included (null/undefined/NaN are not) */
const isNum = x => typeof x === 'number' && Number.isFinite(x);

/** @param {GpuSample|SatelliteGpuSample} g @returns {string} which sensors this card is reporting — the shape half of a signature, never the values. */
const sensorBits = g => [g.util_pct, g.sclk_mhz, g.mclk_mhz, g.fan_pct, g.power_w, g.temp_c].map(v => (v == null ? 0 : 1)).join('');

/**
 * @param {GpuSample[]} [gpus]
 * @param {SatelliteSample[]} [satellites]
 * @param {number} [now]
 */
function renderVram(gpus, satellites, now) {
  gpus = gpus || [];
  // 🔴 10.21: `satellites` is ALWAYS PRESENT on a current server, possibly `[]` — but this file
  // is also handed samples from OLDER servers (a stale cache, a test fixture, the fallback poll's
  // own `/system/stats` mid-upgrade), where the key is simply absent. `|| []` is what makes an
  // absent key behave exactly like an empty array everywhere below, per the design doc's own rule.
  satellites = satellites || [];
  now = now || performance.now();
  // Shape, not values: card set + which sensors are reporting. Changes here rebuild.
  // 🔴 THE SATELLITE HALF IS IN THIS SAME SIGNATURE, NOT A SECOND ONE (design doc §7). Each
  // satellite contributes its NAME plus its own card list, so a satellite appearing, disappearing,
  // or changing its card set all rebuild — the same "shape, not values" rule local cards use,
  // extended to the thing that can now appear and vanish at runtime the way a UPS line already does.
  const sig =
    gpus.map(g => `${g.index}:${g.name}:${sensorBits(g)}`).join('|') +
    '||' +
    satellites.map(s => `${s.name}:` + s.gpus.map(g => `${g.device}:${g.name}:${sensorBits(g)}`).join(',')).join('|');
  if (sig !== strip.sig) {
    buildVram(gpus, satellites);
    strip.sig = sig;
    strip.numDue = true;
  } // a fresh slot must not sit blank
  gpus.forEach(g => updateVram(g, now, String(g.index)));
  // Namespaced by satellite name, not just device (§7): `<name>:cuda:0` and local `0` never
  // collide, and two satellites that both happen to report `cuda:0` don't collide with each other.
  satellites.forEach(s => s.gpus.forEach(g => updateVram(g, now, `${s.name}:${g.device}`)));
}
// The sensor row: load | core clock | VRAM clock | fan | power | temperature — all from AMD's
// sysfs hwmon (one tiny file each; no rocm-smi subprocess on a timer) on local AMD cards, and NVML on a
// satellite's NVIDIA card (10.21, design doc §5.2). A sensor the card doesn't expose comes back
// null and is OMITTED rather than shown blank, which is what keeps this working on the Windows
// dev box (where there are none).
// An idle AMD card genuinely reports a core clock of 0 — that's clock gating, not a
// missing reading, so 0 MHz is shown as 0 MHz. Fan duty follows the identical rule (10.21): an
// idle 4090 genuinely stops its fans, so `FAN 0 %` is shown rather than the slot disappearing.
// The row is labeled GPU, so the GPU's own clock needs no prefix and the odd one out —
// video memory — carries it. Same rule as the CPU row below. What isn't allowed is two
// bare "MHz" side by side, which makes the two clock readings ambiguous:
//     GPU [bar] 0% | 0 MHz | MEM 96 MHz | FAN 20 % | 13 W | 37 C
/**
 * One card's markup — the local host's cards and a satellite's use this same function, differing
 * only in the key used
 * to find the row again and the text on the cap line.
 * @param {string} key    DOM/cache key — `String(index)` locally, `"<sat>:<device>"` for a satellite.
 * @param {string} capHtml  Already-escaped cap text, e.g. `cuda:0 AMD Radeon Graphics` or
 *   `host · cuda:0 NVIDIA GeForce RTX 4090`.
 * @param {GpuSample|SatelliteGpuSample} g
 * @returns {string}
 */
function cardHtml(key, capHtml, g) {
  return `<div class="card" data-g="${key}">
      <div class="cap"><span>${capHtml}</span><span data-r="cap"></span></div>
      <div class="brow"><span class="ulab">GPU MEM</span>
        <div class="bar"><div class="vvoc"></div><div class="vused"></div></div></div>
      ${
        g.util_pct == null
          ? ''
          : `<div class="ubar-row" data-r="urow"><span class="ulab">GPU</span>
        <div class="ubar"><div class="ufill"></div></div><span class="upct"></span>
        ${g.sclk_mhz == null ? '' : uSlot('sclk', 'ustat', 'GPU core clock — 0 means the core is clock-gated, i.e. idle')}
        ${g.mclk_mhz == null ? '' : uSlot('mclk', 'ustat', 'Video memory clock')}
        ${g.fan_pct == null ? '' : uSlot('fan', 'ustat', 'Fan duty cycle — the commanded target, the same quantity on both vendors, never a measured RPM')}
        ${g.power_w == null ? '' : uSlot('pw', 'ustat', 'Board power draw')}
        ${g.temp_c == null ? '' : uSlot('temp', 'ustat utemp', 'Card temperature')}</div>`
      }
    </div>`;
}
/**
 * @param {GpuSample[]} gpus
 * @param {SatelliteSample[]} [satellites]
 */
function buildVram(gpus, satellites) {
  const host = /** @type {VEl} */ ($('vramCards'));
  strip.cards = {};
  satellites = satellites || [];
  if (!gpus.length && !satellites.length) {
    host.innerHTML = '<span class="small muted">no CUDA devices</span>';
    return;
  }
  const keiHtml = gpus.map(g => cardHtml(String(g.index), `cuda:${g.index} ${esc(g.name)}`, g)).join('');
  // 🔴 THE SECTION THAT VANISHES ELEGANTLY (design doc §1.4/§7). There is no wrapper, no heading
  // and no reserved slot for "satellites" as a concept — a satellite's cards are just MORE cards
  // appended to the same `#vramCards` flex column as the local cards. So when
  // `satellites` is `[]`, `satHtml` is `''`, `host.innerHTML` is exactly what it was before this
  // milestone, and there is nothing left in the DOM to hide: no empty heading, no reserved height,
  // and local cards keep the same left edge and the same top edge they always had (the flex column
  // only grows DOWN when a row is appended below the ones already there).
  //
  // ⚠️ AND THAT GROWTH IS WHAT PUT THE CPU ROWS AT THE TOP OF THE STRIP (11.2.4). While every
  // card here belonged to this box, "the CPU rows come after the cards" was unambiguous. A
  // satellite's card appended to this same column landed BETWEEN local cards and the CPU rows,
  // so the CPU line drew under the 4090's card and read as the satellite's CPU. The rows now come
  // FIRST, ahead of every card — see `#vramCards` in css/strip.css for the whole account.
  const satHtml = satellites
    .flatMap(s => s.gpus.map(g => cardHtml(`${s.name}:${g.device}`, `${esc(s.name)} · ${g.device} ${esc(g.name)}`, g)))
    .join('');
  host.innerHTML = keiHtml + satHtml;
  // `Element`, not `VEl`: this is a bare `querySelector` result, and `VEl` is what `$`/`wbEl`
  // stand for specifically (see dom-permissive's own header). The cast at each call below is
  // the L4 two-step — VEl and a concrete/generic element type are mutually non-assignable.
  /** @param {Element} c @param {string} s @returns {VEl} */
  const q = (c, s) => /** @type {VEl} */ (/** @type {unknown} */ (c.querySelector(s)));
  /** @param {string} key @param {GpuSample|SatelliteGpuSample} g */
  const wire = (key, g) => {
    const c = q(host, `.card[data-g="${key}"]`);
    strip.cards[key] = {
      cap: q(c, '[data-r="cap"]'),
      used: q(c, '.vused'),
      voc: q(c, '.vvoc'),
      brow: q(c, '.brow'), // the whole GPU MEM row — the bar's two greens need naming somewhere
      urow: q(c, '[data-r="urow"]'),
      fill: q(c, '.ufill'),
      pct: q(c, '.upct'),
      sclk: q(c, '[data-r="sclk"]'),
      mclk: q(c, '[data-r="mclk"]'),
      fan: q(c, '[data-r="fan"]'),
      pw: q(c, '[data-r="pw"]'),
      temp: q(c, '[data-r="temp"]'),
    };
  };
  gpus.forEach(g => wire(String(g.index), g));
  satellites.forEach(s => s.gpus.forEach(g => wire(`${s.name}:${g.device}`, g)));
}
/**
 * @param {GpuSample|SatelliteGpuSample} g
 * @param {number} now
 * @param {string} key  `strip.cards`/smoothing key — `String(index)` for a local card,
 *   `"<sat>:<device>"` for a satellite's (§7). Passed in rather than derived from `g.index` here,
 *   because a satellite's index is not unique across satellites and can collide with a local index.
 */
function updateVram(g, now, key) {
  const e = strip.cards[key];
  if (!e) return;
  // VRAM is a LEVEL, not a noisy signal — it isn't averaged, and its bar tracks it every
  // sample, so a model loading shows up the moment it happens instead of being smeared.
  // October 10, 2026: a card whose whole-card figures are unknown (`total_gb` or `used_gb` null or
  // absent — a satellite that cannot read its card) prints no numbers it does not have and draws no
  // bar: an empty bar and "0.0 / 0.0 GB" both read as a measurement of an idle card. A real 0 IS a
  // number and is shown as 0.0.
  const known = isNum(g.total_gb) && isNum(g.used_gb);
  // Only meaningful when `known`; the casts are safe for that reason and no other.
  const totalGb = known ? /** @type {number} */ (g.total_gb) : 0,
    usedGb = known ? /** @type {number} */ (g.used_gb) : 0;
  const t = totalGb || 1,
    voc = isNum(g.vocalis_gb) ? /** @type {number} */ (g.vocalis_gb) : 0,
    other = known ? Math.max(0, usedGb - voc) : 0;
  // Vocalis appears first, matching the order of the CPU MEM bar below.
  // Clamp in that order too: Vocalis takes what it needs of the 100%, "other" gets the remainder,
  // so the pair can never overrun the trough no matter what the driver reports.
  const vocPct = known ? Math.min(100, (100 * voc) / t) : 0,
    otherPct = known ? Math.min(100 - vocPct, (100 * other) / t) : 0;
  e.voc.style.left = '0%';
  e.voc.style.width = vocPct + '%';
  e.used.style.left = vocPct + '%';
  e.used.style.width = otherPct + '%';
  // `visibility`, not `display`: the trough keeps its place so this row lines up with the others.
  if (e.voc.parentElement) e.voc.parentElement.style.visibility = known ? '' : 'hidden';
  // Two greens in one bar and nothing anywhere saying which is which — the colors are the
  // whole point of splitting it, and they were only legible to whoever wrote the CSS. This
  // one is NOT behind strip.numDue: that gate halves the rate of the NUMERIC readout, and a
  // tooltip that doesn't exist for the first second or two of every page load reads exactly
  // like a tooltip that was never added.
  // "other apps" was inaccurate: vocalis_gb included the allocator arena, so the runtime and a
  // VoxCPM2 worker's memory footprint could be reported there as well.
// Fixed at the source — gpu_stats now reads amdgpu's per-process accounting for processes that
// end with Vocalis. Dark green is what ⏏ Free Vocalis VRAM frees.
// What is left is real co-tenants (including a TRAINING, which survives that restart by design —
  // see tts_utils.vocalis_pids) plus ~0.2 GB of driver overhead belonging to no process at all.
  // `free_gb` can be null on its own (the other two known): then the "free" clause is left out
  // rather than printed as 0.0.
  const freeNote = isNum(g.free_gb) ? ` · free ${f1(/** @type {number} */ (g.free_gb))} GB` : '';
  if (e.brow)
    e.brow.title = known
      ? `GPU memory — dark green: Vocalis ${f1(voc)} GB · ` +
        `light green: other processes + driver ${other.toFixed(1)} GB${freeNote} ` +
        `(${f1(usedGb)} of ${f1(totalGb)} GB used)`
      : `GPU memory — this card does not report how much is used or free` +
        (voc ? `. Vocalis holds ${f1(voc)} GB (dark green figure).` : '.');
  if (strip.numDue) {
    e.cap.title = known
      ? `total used ${f1(usedGb)} GB — other + driver ${other.toFixed(1)} GB · Vocalis ${f1(voc)} GB${freeNote}`
      : `whole-card memory is not reported by this card${voc ? ` — Vocalis holds ${f1(voc)} GB` : ''}`;
    // The unknown whole-card figure is the strip's usual "no value" dash (as the board temperatures and
    // UPS watts show it); the Vocalis share keeps its look.
    e.cap.innerHTML =
      (known ? `${f1(usedGb)} / ${f1(totalGb)} GB` : '— GB') +
      (voc ? ` · <span style="color:var(--ok)">${f1(voc)}</span>` : '');
  }
  if (!e.urow) return;
  // EVERY sensor is fed the sample on EVERY tick — the window has to see all of them or the
  // mean is a mean of one. It's only the writing-out that happens half as often.
  // Namespace by the full card key, not `g.index`: satellite `<name>:cuda:0` and local `0` never
  // share a `sm()` slot.
  const k = 'g' + key;
  /** @type {GpuReadout} */
  const d = {
    util_pct: sm(k + 'u', g.util_pct, now),
    sclk_mhz: sm(k + 's', g.sclk_mhz, now),
    mclk_mhz: sm(k + 'm', g.mclk_mhz, now),
    fan_pct: sm(k + 'f', g.fan_pct, now),
    power_w: sm(k + 'p', g.power_w, now),
    temp_c: sm(k + 't', g.temp_c, now),
  };
  /** @type {VEl} */ (e.fill).style.width = (d.util_pct || 0) + '%'; // the bar: every sample, so it glides
  if (!strip.numDue) return; // the numbers: half as often, so they can be READ
  // Cast to `keyof GpuReadout` rather than leaving the literal array as `string[]` — that is what
  // lets `d[f]` below stay checked against the typedef instead of widening to an implicit `any`.
  for (const f of /** @type {(keyof GpuReadout)[]} */ (['util_pct', 'sclk_mhz', 'mclk_mhz', 'fan_pct', 'power_w', 'temp_c']))
    d[f] = r0(d[f]);
  e.urow.title = gpuSensorTitle(d);
  /** @type {VEl} */ (e.pct).textContent = d.util_pct + '%';
  if (e.sclk) e.sclk.innerHTML = `${d.sclk_mhz} <b>MHz</b>`;
  if (e.mclk) e.mclk.innerHTML = `<b>MEM</b> ${d.mclk_mhz} <b>MHz</b>`;
  // Fan is shown after memory clock. `d.fan_pct` can legitimately be `0` (an idle GPU may stop its fans, and `r0(0)` is
  // `0`, not falsy) — the template literal prints it either way, so it is never silently dropped.
  if (e.fan) e.fan.innerHTML = `<b>FAN</b> ${d.fan_pct} <b>%</b>`;
  if (e.pw) e.pw.innerHTML = `${d.power_w} <b>W</b>`;
  if (e.temp) {
    e.temp.innerHTML = `${d.temp_c} <b>C</b>`;
    e.temp.classList.toggle('hot', /** @type {number} */ (d.temp_c) >= 80);
  }
}
/**
 * The strip's readout for one card, after `sm()`'s rolling mean — every field independently
 * `null` where that sensor is absent (same rule as `GpuSample`, just six keys of it).
 * @typedef {object} GpuReadout
 * @property {number|null} util_pct
 * @property {number|null} sclk_mhz
 * @property {number|null} mclk_mhz
 * @property {number|null} fan_pct
 * @property {number|null} power_w
 * @property {number|null} temp_c
 */
/** @param {GpuReadout} g @returns {string} */
function gpuSensorTitle(g) {
  const p = [`GPU compute utilization ${g.util_pct}%`];
  if (g.sclk_mhz != null) p.push(`GPU core clock ${g.sclk_mhz} MHz${g.sclk_mhz === 0 ? ' (clock-gated — idle)' : ''}`);
  if (g.mclk_mhz != null) p.push(`video memory clock ${g.mclk_mhz} MHz`);
  if (g.fan_pct != null) p.push(`fan ${g.fan_pct}% (duty cycle)`);
  if (g.power_w != null) p.push(`board power draw ${g.power_w} W`);
  if (g.temp_c != null) p.push(`temperature ${g.temp_c} °C`);
  // Say which signal this is. A figure presented bare reads as "right now", and these aren't.
  p.push(`each figure is the mean over the last ${NUM_MS / 1000} s — the bar shows that same mean, sampled ${1000 / POLL_MS}x/s`);
  return p.join(' · ');
}

// ── the CPU line: one row under the cards, spanning the whole strip ──────────
// top-style load: 100% = ONE logical core, so this 16-core/32-thread box saturates at
// 3200%. (top counts LOGICAL cpus, and so do we — a thread at 100% is a thread at 100%.)
// The bar is scaled to that ceiling, so "full bar" means "the whole CPU is pinned".
// Power is usually absent: the kernel made RAPL's energy counter root-only after the
// PLATYPUS side-channel, so it needs a udev rule the operator has to opt into.
/**
 * The strip's readout for the CPU line, after `sm()`'s rolling mean — same shape as
 * `GpuReadout`, one row instead of per-card.
 * @typedef {object} CpuReadout
 * @property {number|null} pct
 * @property {number|null} mhz
 * @property {number|null} power_w
 * @property {number|null} temp_c
 */
/**
 * @param {CpuSample} c
 * @param {number} [now]
 */
function renderCpu(c, now) {
  const el = /** @type {VEl} */ ($('cpuLine'));
  if (!c || c.pct == null) {
    el.style.display = 'none';
    strip.cpuSig = '';
    return;
  } // non-Linux: omit the row
  now = now || performance.now();
  el.style.display = 'flex';
  const sig = [c.cores, c.mhz != null, c.power_w != null, c.temp_c != null].join(':');
  if (sig !== strip.cpuSig) {
    el.innerHTML =
      `<span class="ulab">CPU</span>` +
      `<div class="ubar"><div class="ufill"></div></div><span class="upct" style="min-width:42px"></span>` +
      (c.mhz != null ? uSlot('mhz', 'ustat', 'Average core clock') : '') +
      (c.power_w != null ? uSlot('pw', 'ustat', 'Package power draw') : '') +
      (c.temp_c != null ? uSlot('temp', 'ustat utemp', 'Package temperature') : '');
    /** @param {string} s @returns {VEl} */
    const q = s => /** @type {VEl} */ (/** @type {unknown} */ (el.querySelector(s)));
    strip.cpu = {
      fill: q('.ufill'),
      pct: q('.upct'),
      mhz: q('[data-r="mhz"]'),
      pw: q('[data-r="pw"]'),
      temp: q('[data-r="temp"]'),
    };
    strip.cpuSig = sig;
    strip.numDue = true; // a fresh slot must not sit blank for half a second
  }
  const e = /** @type {CpuEls} */ (strip.cpu),
    max = (c.cores || 1) * 100;
  /** @type {CpuReadout} */
  const d = {
    pct: sm('cp', Math.max(0, Math.min(max, c.pct)), now),
    mhz: sm('cm', c.mhz, now),
    power_w: sm('cw', c.power_w, now),
    temp_c: sm('ct', c.temp_c, now),
  };
  e.fill.style.width = ((100 * /** @type {number} */ (d.pct)) / max).toFixed(1) + '%'; // the bar: every sample
  if (!strip.numDue) return; // the numbers: half as often
  for (const f of /** @type {(keyof CpuReadout)[]} */ (['pct', 'mhz', 'power_w', 'temp_c'])) d[f] = r0(d[f]);
  el.title = [
    `CPU load ${d.pct}% — 100% = one logical core, and this box has ${c.cores}` + ` (so ${max}% is every thread pinned)`,
    d.mhz != null ? `average core clock ${d.mhz} MHz` : null,
    d.power_w != null ? `package power ${d.power_w} W` : null,
    d.temp_c != null ? `package temperature ${d.temp_c} °C` : null,
    // Windows has no temperature sensor of its own (tts_utils.cpu_stats's Windows branch):
    // `temp_c` there comes from HWiNFO or LibreHardwareMonitor while one of them happens to be
    // running, and `temp_src` says which. Naming the source when a reading IS showing, and
    // explaining how to get one when it ISN'T, both belong in this same tooltip — the row has no
    // second place to put either one.
    d.temp_c != null && c.temp_src ? `temperature from ${c.temp_src === 'hwinfo' ? 'HWiNFO' : 'LibreHardwareMonitor'}` : null,
    c.temp_hint || null,
    `each figure is the mean over the last ${NUM_MS / 1000} s — the bar shows that same mean, sampled ${1000 / POLL_MS}x/s`,
  ]
    .filter(Boolean)
    .join(' · ');
  e.pct.textContent = d.pct + '%';
  if (e.mhz) e.mhz.innerHTML = `${d.mhz} <b>MHz</b>`;
  if (e.pw) e.pw.innerHTML = `${d.power_w} <b>W</b>`;
  if (e.temp) {
    e.temp.innerHTML = `${d.temp_c} <b>C</b>`;
    e.temp.classList.toggle('hot', /** @type {number} */ (d.temp_c) >= 90);
  }
}
// ── CPU MEM: system RAM, under the CPU line ─────────────────────────────────
// Shaped like the GPU MEM row above it — bar, percentage, used / total — because it is the
// same quantity for the other chip, and the eye should not have to learn a second layout.
//
// Like VRAM and unlike load, this is a LEVEL, not a noisy signal: it is NOT run through the
// rolling mean, and the bar follows every sample. A model loading into RAM should show up
// when it happens, not smeared over half a second. Only the printed figures are gated on
// numDue, and for the same reason as everywhere else — a number that changes 4x/s can be
// watched but not read.
//
// `used` here is total-available, not total-free: see tts_utils._cpu_mem(). Linux keeps the
// page cache full on purpose, so total-free would show this box at 95% while it sits idle.
/** @param {CpuSample} c */
function renderCpuMem(c) {
  const el = /** @type {VEl} */ ($('cpuMemLine'));
  if (!c || c.mem_total_gb == null) {
    el.style.display = 'none';
    strip.cpuMem = null;
    return;
  } // non-Linux: omit
  el.style.display = 'flex';
  if (!strip.cpuMem) {
    el.innerHTML =
      `<span class="ulab">CPU MEM</span>` +
      `<div class="ubar"><div class="ufill mem"><div class="memarc"></div></div></div>` +
      `<span class="upct" style="min-width:72px"></span>` +
      uSlot('mem', 'ustat', 'System RAM in use — the page cache is NOT counted as used');
    /** @param {string} s @returns {VEl} */
    const q = s => /** @type {VEl} */ (/** @type {unknown} */ (el.querySelector(s)));
    strip.cpuMem = {
      fill: q('.ufill'),
      pct: q('.upct'),
      arc: q('.memarc'),
      mem: q('[data-r="mem"]'),
    };
    strip.numDue = true; // a fresh slot must not sit blank
  }
  const e = strip.cpuMem,
    used = c.mem_used_gb || 0,
    total = c.mem_total_gb || 1;
  const pct = Math.max(0, Math.min(100, (100 * used) / total));
  e.fill.style.width = pct.toFixed(1) + '%'; // the bar: every sample
  // 🔴 THE SPLIT, NOT AN EXTENSION. `mem_reclaimable_gb` is ZFS ARC minus its floor — memory the
  // kernel would hand straight back, which MemAvailable does not know exists and therefore bills
  // as used. It is expressed as a share OF THE FILL, so the bar's total length never moves.
  // ⚠️ null on every non-ZFS box (and on Windows, where the whole row is hidden above) — the
  // segment collapses to zero width and this is one solid dark green bar, exactly as before.
  const arc = c.mem_reclaimable_gb;
  const arcShare = arc != null && used > 0 ? Math.max(0, Math.min(100, (100 * arc) / used)) : 0;
  if (e.arc) e.arc.style.width = arcShare.toFixed(1) + '%';
  el.title =
    `System RAM — ${f1(used)} GB in use of ${f1(total)} GB, ` +
    `${f1(Math.max(0, total - used))} GB available. Cached file data is not counted as used: ` +
    `Linux hands it back the moment anything needs it.` +
    (arc != null && arc > 0
      ? `\n\nDark green: ${f1(Math.max(0, used - arc))} GB genuinely in use.` +
        `\nLight green: ${f1(arc)} GB of ZFS disk cache (ARC) — counted as used because the` +
        ` kernel's own estimate cannot see it, but evictable the moment anything needs it.`
      : '');
  if (!strip.numDue) return; // the numbers: half as often, so they can be READ
  // Show both the total used memory and the non-reclaimable portion represented by the dark bar.
  //
  // ⚠️ THE PLAIN NUMBER IS UNCHANGED, DELIBERATELY. It still reports `MemTotal - MemAvailable`, so
  // it keeps agreeing with `free`, `top` and GNOME — which is what makes it checkable. The
  // parenthesized figure is the extra fact those tools cannot tell him, not a correction of them.
  const real = arc != null ? Math.max(0, used - arc) : null;
  const realPct = real != null && total > 0 ? (100 * real) / total : null;
  e.pct.innerHTML = Math.round(pct) + '%' + (realPct != null ? ` <span class="ureal">(${Math.round(realPct)}%)</span>` : '');
  e.mem.innerHTML = `${f1(used)}` + (real != null ? ` <span class="ureal">(${f1(real)})</span>` : '') + ` / ${f1(total)} <b>GB</b>`;
  // Both readouts explain themselves on hover — the strip has no room for a legend.
  const why =
    real != null
      ? `${f1(used)} GB is what the kernel calls used, and what free/top/GNOME report.\n` +
        `${f1(real)} GB is what is genuinely in use — the rest is ZFS disk cache (ARC), ` +
        `evictable the moment anything needs it.`
      : '';
  e.pct.title = why;
  e.mem.title = why;
}
// ── the three system lines in the header's first column ──────────────────────
// Uptime/load/swap, the kernel's own memory-pressure figure, and what the box is drawing in
// watts. NOT rows of the strip: they are numbers rather than graphs, and they are facts about
// the box rather than about a device, so they live with the box-level buttons opposite (see the
// #sysMem CSS note for the rows-not-a-column layout rule).
//
// 🔴 TWO FACTS, AND NEITHER IS SUFFICIENT ALONE — that is why this is two lines and not one.
// PSI's `avg10` is the only direct measure of pressure (percentage of the last 10 s in which
// something was stalled waiting on memory) but it decays within seconds, so it reads 0.00 on a
// box that was thrashing a minute ago. Swap in use is the CONSEQUENCE and it persists for as
// long as those pages stay out, but it is silent while the squeeze is actually happening. The
// live figure says "it hurts now"; the swap figure and PSI's since-boot total say "it has hurt".
//
// ⚠️ NONE OF THEM IS RUN THROUGH `sm()`, unlike every other figure in this file. The rolling
// mean exists to tame instantaneous readings that jump between samples; these are all already
// levels — `avg10` is a ten-second average computed by the kernel, swap moves in slow ramps, and
// every power figure is a 1 Hz server-side series that this page only reads. Averaging them
// again would add lag and nothing else. They do respect `strip.numDue`, because a figure
// rewritten 4x/s cannot be read no matter how steady it is.
// "0 min" · "15 min" · "3 h 15 min" · "2 d 3 h 15 min". Days, hours and minutes; NEVER seconds
// Numbers are bright and units muted, matching the other strip figures.
// FLOOR, not round, at every step: this figure sits beside a live percentage, and a duration
// that rounds UP claims a minute of stall that has not happened yet.
/** @param {number|null|undefined} s @returns {string} */
function fmtDur(s) {
  const m = Math.floor(Math.max(0, s || 0) / 60),
    d = Math.floor(m / 1440),
    h = Math.floor((m % 1440) / 60);
  const out = [];
  if (d) out.push(`${d} <b>d</b>`);
  if (d || h) out.push(`${h} <b>h</b>`); // "2 d 0 h 5 min", never "2 d 5 min" — that reads as 2 d 5 h
  out.push(`${m % 60} <b>min</b>`);
  return out.join(' ');
}
// Match the familiar `uptime(1)` format: "5 min", "1:23", "1 day, 3:24", "2 days,
// 15 min". Under an hour it is minutes; from an hour it is H:MM with a zero-padded minute;
// days are pluralized and prefixed. Anything cleverer would be a different format that merely
// looked like this one.
/** @param {number|null|undefined} s @returns {string} */
function fmtUptime(s) {
  const t = Math.max(0, Math.floor(s || 0)),
    d = Math.floor(t / 86400),
    h = Math.floor((t % 86400) / 3600),
    m = Math.floor((t % 3600) / 60);
  const days = d ? `${d} <b>day${d > 1 ? 's' : ''},</b> ` : '';
  return days + (h ? `${h}:${String(m).padStart(2, '0')}` : `${m} <b>min</b>`);
}
// A duration for a TOOLTIP, where fmtDur's markup would print as literal tags. Same function,
// same floor-at-every-step rule — the <b> that mutes the units in the header is simply dropped.
/** @param {number|null|undefined} s @returns {string} */
const plainDur = s => fmtDur(s).replace(/<\/?b>/g, '');
/**
 * @param {CpuSample} c
 * @param {PowerSample|null} p
 * @param {UpsSample|null} u
 * @param {TempsSample|null} t
 */
function renderSysMem(c, p, u, t) {
  const box = $('sysMem'),
    swapEl = /** @type {VEl} */ ($('swapLine')),
    psiEl = /** @type {VEl} */ ($('psiLine')),
    powEl = $('powerLine');
  const upsEl = $('upsLine'),
    tempEl = $('boardTemp');
  if (!box) return; // a page that predates the markup
  const swap = c && c.swap_total_gb != null,
    psi = !!(c && c.mem_psi);
  const up = c && c.uptime_s != null,
    load = !!(c && c.loadavg);
  // The power block is absent on a box with no readable sensor, and for the first second of
  // every box's life — the sampler has to take a sample before there is anything to print.
  const pow = !!(powEl && p && p.w != null);
  // 🔴 THE SERVER DECIDES WHETHER THERE IS A UPS LINE, NOT THIS FILE. runtime/ups.py answers
  // None for every one of six separate conditions — no NUT, upsd down, stale reading, missing
  // field, unparseable load, and a UPS reporting zero load because its output is switched off
  // (which this unit reports as `OB`, indistinguishable from a real outage without the load).
  // Re-deriving any of that here would be a second copy of a rule that has already been wrong
  // once. A block arrives or it does not.
  const ups = !!(upsEl && u && u.status);
  // The board's own sensors — and the DIMMs', which come from a different chip entirely. Any one
  // of the three carries the row, because a box can publish RAM without a board sensor or the
  // reverse. Server decides whether each exists, same as the UPS line.
  const temp = !!(tempEl && t && (t.mb != null || t.vrm != null || t.ram != null));
  // 🔴 LINE ONE IS THREE READOUTS NOW, AND ANY OF THEM CAN CARRY IT. Uptime, load average and
  // swap all come off /proc, but not off the same file — a box can report one and not another,
  // and the line exists if ANY of them answers. Keying its visibility off swap alone (as it did
  // when swap was all it held) would blank uptime and load on a box with swap turned off.
  const row1 = up || load || swap;
  // 🔴 `contents`, NOT `flex`. #sysMem is a pass-through wrapper: its children are grid items
  // of .hdr-stack (rows 3-5), and giving it a box of its own would take them out of that grid
  // and re-create a third column. It exists solely so one toggle hides them all.
  box.style.display = row1 || psi || pow || ups || temp ? 'contents' : 'none'; // Windows: none, block gone
  swapEl.style.display = row1 ? 'flex' : 'none';
  psiEl.style.display = psi ? 'flex' : 'none';
  if (powEl) powEl.style.display = pow ? 'flex' : 'none';
  if (upsEl) upsEl.style.display = ups ? 'flex' : 'none';
  if (tempEl) tempEl.style.display = temp ? 'flex' : 'none';
  if (!row1 && !psi && !pow && !ups && !temp) return;
  // The SHAPE (which readouts exist) can change when a box gains swap; the values change constantly.
  // Power's shape can change TWICE in a session: the line appears a second after boot when the
  // sampler takes its first sample, and its `avg` slot appears with it.
  // ⚠️ THE UPS BIT IS IN THE SIGNATURE AND HAS TO BE. Its line appears and disappears at
  // runtime — when the UPS is connected or its output is switched off — so unlike swap (fixed at
  // boot) this shape genuinely changes in a
  // live session, and a cached signature that ignored it would leave the slot un-built.
  // ⚠️ THE THREE TEMPERATURE BITS ARE IN THE SIGNATURE INDIVIDUALLY, not as one "there are temps"
  // flag: they come from two different chips, so a box can publish any subset of them, and each
  // subset is a different row to build.
  const sig =
    `${up ? 1 : 0}${load ? 1 : 0}${swap ? 1 : 0}${psi ? 1 : 0}${pow ? 1 : 0}` +
    `${pow && p.avg && p.avg[0] != null ? 1 : 0}${pow && p.peak_w != null ? 1 : 0}${ups ? 1 : 0}` +
    `${temp && t.mb != null ? 1 : 0}${temp && t.vrm != null ? 1 : 0}${temp && t.ram != null ? 1 : 0}`;
  // 📌 NO BIT FOR THE UPS PEAK, DELIBERATELY, AND THE ASYMMETRY WITH `power` IS REAL. The power
  // line builds a `data-r="peak"` SLOT that has to exist before a value can be written into it,
  // so its arrival is a shape change; the UPS line has one `.ustat` whose innerHTML is rewritten
  // whole on every render, so the peak appearing changes nothing about the markup. A bit here
  // would rebuild all five rows once, for nothing.
  if (sig !== strip.sysSig) {
    if (row1)
      swapEl.innerHTML =
        (up ? `<span class="ulab">uptime</span><span class="ustat" data-r="up"></span>` : '') +
        (load ? `<span class="usep">·</span><span class="ulab">load</span>` + `<span class="ustat" data-r="load"></span>` : '') +
        (swap ? `<span class="usep">·</span><span class="ulab">swap</span>` + `<span class="ustat" data-r="swap"></span>` : '');
    if (psi) psiEl.innerHTML = `<span class="ulab">mem pressure</span><span class="ustat"></span>`;
    if (pow)
      powEl.innerHTML =
        `<span class="ulab">power</span><span class="ustat" data-r="now"></span>` +
        (p.avg && p.avg[0] != null
          ? `<span class="usep">·</span><span class="ulab">avg</span>` + `<span class="ustat" data-r="avg"></span>`
          : '') +
        (p.peak_w != null ? `<span class="usep">·</span><span class="ulab">peak</span>` + `<span class="ustat" data-r="peak"></span>` : '');
    if (ups) upsEl.innerHTML = `<span class="ulab">UPS</span><span class="ustat"></span>`;
    // Built from a list so the separators cannot get out of step with the readouts — with three
    // optional figures the hand-written `a?sep:''` chain has six ways to leave a leading "·".
    // board · RAM · VRM. The order is a display choice, not a property of the sensors: the two
    // board figures are not a pair that has to sit together, and RAM between them reads better.
    if (temp)
      tempEl.innerHTML =
        /** @type {[('mb'|'vrm'|'ram'), string][]} */
        ([
          ['mb', 'board'],
          ['ram', 'RAM'],
          ['vrm', 'VRM'],
        ])
          .filter(([k]) => t[k] != null)
          .map(
            ([k, lab], i) =>
              (i ? `<span class="usep">·</span>` : '') + `<span class="ulab">${lab}</span><span class="ustat utemp" data-r="${k}"></span>`,
          )
          .join('');
    strip.sysSig = sig;
    strip.numDue = true; // a fresh slot must not sit blank
  }
  if (!strip.numDue) return;
  // 🔴 EVERY READOUT ON THIS ROW OWNS ITS OWN TOOLTIP AND ITS OWN AMBER. Both used to hang off
  // the ROW, which was right while the row held one figure and is wrong now: a row-level `warn`
  // would turn uptime amber because swap is high, and a row-level title would answer "what is
  // this?" with the wrong paragraph for two of the three things under the cursor.
  if (up) {
    const el = /** @type {HTMLElement} */ (swapEl.querySelector('[data-r="up"]'));
    el.innerHTML = fmtUptime(c.uptime_s);
    el.title =
      `Time since this box booted, in the format uptime(1) prints. It is the denominator ` +
      `for the stall figure below: 33 minutes of stall in sixteen hours is a working fileserver, ` +
      `and the same 33 minutes in twenty is a box in trouble.`;
  }
  if (load) {
    const l = /** @type {number[]} */ (c.loadavg),
      el = /** @type {HTMLElement} */ (swapEl.querySelector('[data-r="load"]'));
    el.innerHTML = l.map(v => v.toFixed(2)).join(' ');
    // Against CORES, not against 1: load 8 is idle on a 32-thread box and desperate on a 4-thread
    // one. Amber at 1 task queued per thread, which is where waiting starts.
    el.classList.toggle('warn', !!c.cores && l[0] >= c.cores);
    el.title =
      `Load average over 1, 5 and 15 minutes — tasks running OR waiting to run, which is ` +
      `why it can exceed the CPU percentage on the row opposite. This box has ${c.cores || '?'} ` +
      `logical cores, so anything under ${c.cores || '?'}.00 has never had a task queued. The three ` +
      `figures are a trend: 1-minute above 15-minute means it is getting busier.`;
  }
  if (swap) {
    const u = c.swap_used_gb || 0,
      t = c.swap_total_gb || 1,
      pct = (100 * u) / t;
    const el = /** @type {HTMLElement} */ (swapEl.querySelector('[data-r="swap"]'));
    el.innerHTML = `${f1(u)} <b>/</b> ${f1(t)} <b>GB</b>`;
    // 25%: swap in use is NORMAL on a fileserver — the kernel pages out idle anonymous memory
    // whether or not anything is short — so the amber has to mean "enough of it to matter".
    el.classList.toggle('warn', pct >= 25);
    el.title =
      `${f1(u)} GB of ${f1(t)} GB swap in use (${Math.round(pct)}%). Pages the kernel ` +
      `pushed out to disk to make room. They cost a disk read to touch again, so a box can sit ` +
      `at a comfortable RAM figure and still be paying for memory it ran out of hours ago.`;
  }
  if (psi) {
    const p = /** @type {MemPsi} */ (c.mem_psi);
    // "Stalled" distinguishes memory-pressure time from uptime. The figure counts time LOST:
    // 33 minutes of those 16 hours had something blocked waiting on memory. A duration next to a
    // boot reference reads as uptime unless the sentence says what was happening for it.
    /** @type {HTMLElement} */ (psiEl.querySelector('.ustat')).innerHTML =
      `${p.avg10.toFixed(1)}<b>%</b> <b>·</b> ${fmtDur(p.total_s)} <b>stalled since boot</b>`;
    // 5% of wall-clock lost to memory stalls is already a box you can feel typing on.
    psiEl.classList.toggle('warn', p.avg10 >= 5);
    psiEl.title =
      `${p.avg10.toFixed(2)}% of the last 10 s was spent with at least one task ` +
      `stalled waiting on memory (${p.avg60.toFixed(2)}% over 60 s, ${p.avg300.toFixed(2)}% over ` +
      `300 s).\n\nThe second figure is the TOTAL time this box has spent stalled on memory since ` +
      `it booted — time lost, not time up. It only ever grows, which is why it is here: the ` +
      `averages decay to zero within seconds of the pressure ending, so on their own they cannot ` +
      `tell you it ever happened.`;
  }
  if (pow) {
    // 🔴 THE NUMBERS ARE THE SERVER'S, NOT THIS PAGE'S — and that is the feature, not a detail
    // of where the arithmetic runs. Sample power on the server continuously rather than only when
    // the UI polls, so brief spikes are retained. A mean this tab computed from its own polls would cover only the minutes a
    // browser was open on a visible tab, and would have a hole in it for the whole of every
    // render — the exact stretch worth measuring. So nothing here is run through `sm()`: these
    // three figures are already a 1 Hz series' current value, its windowed means and its peak.
    const parts = [];
    if (p.cpu_w != null) parts.push(`the CPU package (${p.cpu_w} W)`);
    if (p.gpu_w != null) parts.push(`${p.gpus || ''} GPU${p.gpus === 1 ? '' : 's'} (${p.gpu_w} W)`.trim());
    const el = /** @type {HTMLElement} */ (powEl.querySelector('[data-r="now"]'));
    el.innerHTML = `${p.w} <b>W</b>`;
    el.title =
      `What this box is drawing right now, summed over the parts of it that can report ` +
      `watts: ${parts.join(' and ') || 'no sensor'}. Sampled by the server four times a second ` +
      `whether or not this page is open; this line redraws twice a second, so what you are ` +
      `reading is never more than half a second old.\n\nIt is NOT wall draw. ` +
      `RAM, the disks, the fans, the board and the PSU's own losses cannot be read from inside ` +
      `the machine and are not in this figure, so treat it as a floor and compare it against ` +
      `itself rather than against a bill.`;
    const a = powEl.querySelector('[data-r="avg"]');
    if (a) {
      a.innerHTML = p.avg.map(v => (v == null ? '—' : v)).join(' ') + ' <b>W</b>';
      // ⚠️ THE THIRD FIGURE COVERS `span_s`, NOT ALWAYS 15 MINUTES. Unlike load average, whose
      // series is the kernel's and starts at boot, this one starts when Vocalis does — so for
      // the first quarter of an hour after a restart the widest window is a mean over less than
      // it is labeled. Saying so is cheaper than the figure being quietly wrong.
      /** @type {HTMLElement} */ (a).title =
        `Mean draw over the last 1, 5 and 15 minutes — load average's own windows, over ` +
        `the server's 4 Hz power series.\n\n` +
        (p.span_s < 900
          ? `That series is Vocalis's own and it has been running for ${plainDur(p.since_s)}, so ` +
            `the longer figures cover only what exists so far.`
          : `The three together are a trend: 1-minute above 15-minute means the box is ramping.`);
    }
    const pk = powEl.querySelector('[data-r="peak"]');
    if (pk) {
      pk.innerHTML = `${p.peak_w} <b>W</b>`;
      // 🔴 THE PEAK SAYS WHAT IT WAS MADE OF, AND THE OTHER TWO READOUTS DO NOT NEED TO. This is
      // the only figure on the line that is permanent — the live one is replaced 4x/s and the
      // means wash anything out within fifteen minutes — so it is the only one where a single
      // lying sensor stays on screen for the life of the process. Include sensor provenance so an
      // implausible value can be traced to its source without inspecting sysfs by hand.
      const pkParts = [];
      if (p.peak_cpu_w != null) pkParts.push(`CPU ${p.peak_cpu_w} W`);
      if (p.peak_gpu_w != null) pkParts.push(`GPUs ${p.peak_gpu_w} W`);
      /** @type {HTMLElement} */ (pk).title =
        `The highest QUARTER SECOND seen since Vocalis started sampling ` +
        `(${plainDur(p.since_s)} ago), which was ${plainDur(p.peak_ago_s)} ago.` +
        (pkParts.length ? ` At that moment: ${pkParts.join(' + ')}.` : '') +
        `\n\nThis is what ` +
        `the continuous sampling is FOR, and why it runs at 4 Hz rather than 1: a spike that ` +
        `lands between two of this page's polls — or while no browser is open at all — never ` +
        `reaches the live figure, and is still caught here. A short CPU burst averaged over a ` +
        `whole second would arrive at a quarter of its real height.`;
    }
  }
  if (ups) {
    // 🔴 THE ONE FIGURE IN THIS HEADER THAT IS ACTUAL WALL DRAW, and it is directly under the
    // `power` line for exactly that contrast. That line's own tooltip says what it is not:
    // "RAM, the disks, the fans, the board and the PSU's own losses cannot be read from inside
    // the machine and are not in this figure". They can be read from outside it. The gap
    // between the two numbers IS those things, which is why separating them is worth a row.
    const st = u.status,
      mins = fmtDur(u.runtime_s);
    /** @type {HTMLElement} */ (upsEl.querySelector('.ustat')).innerHTML =
      `${st} <b>·</b> ${u.load_pct}<b>%</b> <b>·</b> ${u.w} <b>W</b> <b>·</b> ` +
      // Show the peak beside the live figure, not in a tooltip. It is
      // the same reasoning as the power line's own `peak_w`, one row up: the sustained number
      // answers "what is it drawing", and only the peak answers "did it ever come near the
      // rating" — which is the question a UPS is bought to settle.
      // ⚠️ OMITTED, NEVER ZEROED, when the server has no peak yet. `peak_w` is null for the few
      // seconds between the process starting and the UPS poller's first reading, and `peak 0 W`
      // in that window would be a measurement claim about a poll that has not happened.
      (u.peak_w != null ? `<b>peak</b> ${u.peak_w} <b>W</b> <b>·</b> ` : '') +
      `<b>batt</b> ${u.batt_pct}<b>%</b> <b>·</b> ${mins}`;
    // ⚠️ ROW-LEVEL, LIKE mem pressure AND UNLIKE THE TOP ROW. This line is one readout about
    // one state — a UPS on battery is not "the runtime figure is concerning", it is the whole
    // line being urgent — so the emphasis belongs to the row. `crit` outranks `warn`: on LB
    // both conditions are true and the worse one has to win.
    // The threshold is the SERVER'S (runtime/ups.py's WARN_LOAD_PCT), not a literal typed here.
    // `??` rather than `||` so a future 0 means zero rather than falling through to 85.
    upsEl.classList.toggle('warn', st === 'OB' || u.load_pct >= (u.warn_pct ?? 85));
    upsEl.classList.toggle('crit', st === 'LB');
    const what =
      st === 'OL'
        ? `on mains${u.charging ? ', battery charging' : ''}`
        : st === 'OB'
          ? `ON BATTERY — mains is gone and a 300-second countdown to poweroff is running`
          : `ON BATTERY, LOW — the UPS is about to cut out`;
    upsEl.title =
      `${u.model || 'UPS'}: ${what}. Drawing ${u.load_pct}% of its ${u.nominal_w} W ` +
      `rating, and holding ${u.batt_pct}% charge — about ${plainDur(u.runtime_s)} at this load.` +
      `\n\nTHIS IS WALL DRAW, and it is the only figure here that is. The power line above ` +
      `reads the CPU package and the cards from inside the box; this reads the meter the box ` +
      `is plugged into, so it includes RAM, the disks, the fans, the board and the PSU's own ` +
      `losses. The difference between the two is everything with no sensor of its own.` +
      `\n\nDerived, not measured: this UPS reports load as a whole percent and no wattage at ` +
      `all, so the figure steps in ${Math.round(u.nominal_w / 100)} W increments. It is also a ` +
      `SUSTAINED reading refreshed every few seconds — the sub-second spikes the power line ` +
      `is sampled at 4 Hz to catch cannot appear here at any poll rate.`;
  }
  if (temp) {
    // 🔴 THE ONLY TEMPERATURES IN THIS HEADER THAT ARE NOT A CHIP REPORTING ON ITSELF. The strip
    // prints the CPU's die and each card's, and all of those say "this silicon is hot" — none of
    // them can say "the case is hot". The board sensor sits out in the airflow, the VRM sensor on
    // the stage feeding the socket, and the DIMM sensors inside the modules the airflow is
    // supposed to reach. Together they answer whether the box is getting rid of its heat.
    // ⚠️ THE THRESHOLDS ARE THE SERVER'S (runtime/temps.py's WARN_C, and for RAM the module's own
    // published `temp1_max`), never literals typed here — the same rule the UPS line follows, and
    // the reason `warn` is in the payload at all.
    /** @type {{mb?: number, vrm?: number, ram?: number}} */
    const warn = t.warn || {};
    for (const k of /** @type {('mb'|'vrm'|'ram')[]} */ (['mb', 'vrm', 'ram'])) {
      const el = t[k] != null && tempEl.querySelector(`[data-r="${k}"]`);
      if (!el) continue;
      el.innerHTML = `${t[k]} <b>°C</b>`;
      // Per-READOUT, not per-row: a warm VRM must not turn the board figure amber beside it. Same
      // correction the top system row already carries in its own comment.
      el.classList.toggle('warn', warn[k] != null && /** @type {number} */ (t[k]) >= warn[k]);
    }
    /** @param {'mb'|'vrm'|'ram'} k @returns {string} */
    const deg = k => (t[k] != null ? `${t[k]} °C` : '—');
    tempEl.title =
      `Where the HEAT is, measured outside the silicon: the motherboard ` +
      `(${deg('mb')}), the RAM (${deg('ram')}) and the VRM (${deg('vrm')}).` +
      `\n\nEvery other temperature in this header is a die reporting on itself, which says the ` +
      `silicon is hot but never whether the CASE is. These do. The board sensor sits in the ` +
      `airflow; the VRM is the converter stage feeding the CPU socket, so it carries the whole ` +
      `of the core current and runs hottest of the three under load — well above the board is ` +
      `NORMAL, and the two being close and both high is the case failing to exhaust.` +
      (t.ram != null
        ? `\n\nRAM is the hottest of the ${t.dimms || 1} module` +
          `${(t.dimms || 1) > 1 ? 's' : ''}, not their average — an average is the one figure a single ` +
          `overheating stick cannot move. Its amber is the module's OWN published limit.`
        : '') +
      `\n\nAmber past ${warn.mb ?? '—'} °C board, ${warn.vrm ?? '—'} °C VRM, ${warn.ram ?? '—'} °C RAM.`;
  }
}
// ───────────────────────────────────────────────────────────────────────────────
// 🔴 THE IDLE SAMPLER IS ONE HELD CONNECTION NOW, NOT FOUR REQUESTS A SECOND (9.0.8).
//
// The idle sampler uses one held connection rather than four requests per second. It is cheap
// because the server already had
// every part of it: `gpu.strip_sample()` is a shared, TTL'd read, and `jobs.vram_ticker` has been
// pushing that same sample down a job's SSE stream at this same 4 Hz since 8.0. All
// `/system/stream` does is offer it to a tab that is NOT running a job.
//
// ⚠️ THE POLL IS STILL HERE AND STILL LOAD-BEARING, in three roles that are easy to mistake
// for one:
//   1. `pollVram()` — the ONE-SHOT poke. After a model load, after a ComfyUI bounce, on becoming
//      visible again. It has always been a single fetch and is unchanged.
//   2. the FALLBACK. Past the server's `MAX_STRIP_STREAMS` the stream answers 503, and a browser
//      with no `EventSource` never had one; both land on the old `setInterval`. A tab refused a
//      slot loses the efficiency, never the strip.
//   3. the STALL ESCAPE. A stream can connect and then go quiet — a wedged worker, a proxy
//      holding the body. `STALL_MS` below turns that into a fallback instead of a strip frozen on
//      its last sample, which is the one failure a poll cannot have.
//
// 📌 WHAT THE HELD CONNECTION COSTS THE BOOT: NOTHING MEASURABLE, and that was worth
// checking rather than assuming. `tools/build_webui.mjs` records the constraint this tree already
// knows about — the boot's requests queue behind SIX HTTP/1.1 connections — and this stream takes
// one of them permanently, in boot phase 1, ahead of the eleven boot fetches. Measurements over
// alternating loads per arm showed that when
// `EventSource` existed:
//
//     navigate -> __bootDone   stream 140/141/171 ms      poll 139/140/141/174 ms
//     queueing stall, summed   stream 117/123/137 ms      poll 123/126/126/149 ms
//
// The distributions overlap; there is no effect to see. (The first stream round, 217 ms, was the
// cold one and is excluded — it is Chrome warming up, not the transport.) The one real difference
// is that the POLL arm issues two to three MORE requests during boot, which is the feature.
//
// ⚠️ AND THE MULTI-TAB CASE IS ALREADY CLOSED BY THE `visibilitychange` HANDLER BELOW: a hidden
// tab closes its stream, so background tabs hold nothing and six visible windows would be needed
// to exhaust the pool. Do not add leader election for a problem that shape.

// 🔴 AND THE FALLBACK IS EXACTLY WHY `window.__stripTransport` EXISTS. With it, "the strip shows
// numbers" no longer proves the stream works — the fallback paints identical numbers off an
// identical sample, so a spec that waits for a figure to appear passes over a completely dead SSE
// path. Assert the transport, not the pixels.

// ⚠️ `ReturnType<typeof setInterval>` RATHER THAN `number`: see util/uistate.js's own note on the
// DOM-lib-vs-@types/node split — pinning `number` here is the annotation that goes red on a
// devDependency bump rather than on a change to this file.
/** @type {ReturnType<typeof setInterval>|null} */
let vramTimer = null;
let vramBusy = false;
/** @type {EventSource|null} */
let vramStream = null;
/** @type {ReturnType<typeof setInterval>|null} */
let stallTimer = null;
/** When the open stream last delivered a frame. `0` while no stream is open. */
let lastFrameAt = 0;
/** The page WANTS the idle sampler running — distinct from whether one is open right now, which a
 *  hidden tab suspends. Without it, returning to a tab could resurrect the sampler mid-render, and
 *  two sources driving the strip make the numbers flicker between them. */
let idleWanted = false;

// A stream that has delivered nothing for this long is treated as dead and the poll takes over.
// Twelve frames' worth: long enough that a GC pause or a slow sample cannot trip it, short enough
// that a wedged stream costs a few seconds of stale numbers rather than the rest of the session.
const STALL_MS = 3000;

/** @param {'stream'|'poll'|'off'} t */
function setTransport(t) {
  window.__stripTransport = t;
}

/** The poll path, unchanged from 7.3 — and now also the fallback. */
function startPolling() {
  if (vramTimer) return;
  pollVram();
  vramTimer = setInterval(pollVram, POLL_MS);
  setTransport('poll');
}

function stopPolling() {
  if (vramTimer) {
    clearInterval(vramTimer);
    vramTimer = null;
  }
}

function closeStream() {
  if (stallTimer) {
    clearInterval(stallTimer);
    stallTimer = null;
  }
  if (vramStream) {
    vramStream.close();
    vramStream = null;
  }
  lastFrameAt = 0;
}

/** Give up on the push channel for the rest of this sampler's life and poll instead. */
function fallBackToPolling() {
  closeStream();
  if (idleWanted && !document.hidden) startPolling();
}

function openStream() {
  if (vramStream) return;
  // 🔴 STOPS THE POLL ITSELF RATHER THAN TRUSTING ITS CALLERS TO. All three current callers do
  // stop it first, so this changes nothing today — but that is an invariant held by CONVENTION
  // across three sites, and tonight's two worst test bugs were both "known hazard, handled
  // per-site, someone eventually forgets". A fourth caller that missed it would leave a stream
  // AND a 4 Hz poll running at once: strictly worse than before this milestone, and silent.
  // `power_line_browser_spec` counts requests and would catch the symptom; this removes the way in.
  stopPolling();
  if (typeof EventSource === 'undefined') {
    startPolling(); // no push channel in this browser at all — role 2 above
    return;
  }
  // ⚠️ Paint immediately rather than waiting a round trip for the first frame. `startIdleVram`
  // used to do this with its own `pollVram()`, and without it the strip sits blank through the
  // stream's handshake — the most visible moment of the whole page load.
  pollVram();
  const es = new EventSource('/system/stream');
  vramStream = es;
  lastFrameAt = Date.now();
  setTransport('stream');
  es.onmessage = (/** @type {MessageEvent} */ ev) => {
    lastFrameAt = Date.now();
    try {
      renderStrip(JSON.parse(String(ev.data)));
    } catch (e) {
      // A malformed frame is not a reason to tear the stream down — the next one is 250 ms away.
    }
  };
  es.onerror = () => {
    // 🔴 TWO DIFFERENT FAILURES ARRIVE ON THIS ONE HANDLER AND THEY WANT OPPOSITE ANSWERS.
    // `CLOSED` means the browser has GIVEN UP — a 503 past the server's stream cap, or a
    // non-SSE response — and it will never retry on its own, so that is the fallback's cue.
    // `CONNECTING` means it is already retrying (the server's `retry: 3000`), and closing the
    // stream here would convert a three-second blip into a permanent downgrade.
    if (es.readyState === EventSource.CLOSED) fallBackToPolling();
  };
  // The stall escape — role 3 above. Cheap: one comparison a second against a timestamp.
  stallTimer = setInterval(() => {
    if (vramStream === es && lastFrameAt && Date.now() - lastFrameAt > STALL_MS) fallBackToPolling();
  }, 1000);
}

export function startIdleVram() {
  idleWanted = true;
  stopPolling();
  closeStream();
  if (document.hidden) {
    // 📌 Nothing starts on a hidden tab, and this one is not an optimization: a stream to a
    // hidden tab is the 4 Hz cost this milestone exists to remove, paid for pixels nobody sees.
    // The visibility listener at the foot of this file opens it when the tab is looked at.
    setTransport('off');
    return;
  }
  openStream();
}

export function stopIdleVram() {
  idleWanted = false;
  stopPolling();
  closeStream();
  setTransport('off');
}
// The in-flight guard matters at 4 Hz and didn't at 1: a sample that takes longer than the
// interval (a hiccup over TLS on the LAN) would otherwise stack requests on the server.
export async function pollVram() {
  if (document.hidden || vramBusy) return;
  vramBusy = true;
  try {
    renderStrip(await jget('/system/stats'));
  } catch (e) {
  } finally {
    vramBusy = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE VISIBILITY LISTENER ARRIVED AT 7.3-m12c — one line, and index.html had named this file as
// its home since m3. It sat in the middle of the Audition banner, which never owned it.
//
// It is the other half of `pollVram`'s own `if(document.hidden)return`: the poll declines to run
// on a hidden tab, so coming BACK to the tab leaves the strip showing a sample up to POLL_MS old
// and possibly minutes old. This takes one immediately, so the numbers are right the moment they
// are looked at rather than a quarter-second later.
//
// ⚠️ `state.running` IS A PAGE GLOBAL and stays one until m12d moves `state` into its own module.
// It resolves at CALL time on the global scope chain, which a module may always do (§3.1's
// asymmetry). The guard is not an optimization: during a render `handleEvent` is already driving
// the strip off the SSE stream, and a second sampler racing it makes the numbers flicker between
// two sources.
//
// ⚠️ SO THIS MODULE WIRES AT LOAD NOW, and the import is load-bearing beyond its four exports.
//
// ⚠️ AND SINCE 9.0.8 IT ALSO SUSPENDS AND RESUMES THE STREAM. A held connection to a hidden tab
// keeps the server sampling and writing 4x/s for a strip nobody is looking at — the exact cost this
// milestone removed, re-introduced by the one case the old `if(document.hidden)return` covered for
// free. `idleWanted` is what stops the resume firing during a render: a job's own SSE stream drives
// the strip then, and a second source makes the numbers flicker between the two.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (idleWanted) {
      stopPolling();
      closeStream();
      setTransport('off');
    }
    return;
  }
  if (state.running) return;
  pollVram();
  if (idleWanted) openStream();
});
