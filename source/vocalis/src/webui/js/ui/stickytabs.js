// ui/stickytabs.js — the tab bar stays put under the header while the page scrolls (9.0.8).
//
// Keep the primary tab row available while scrolling long pages.
//
// 🔴 THIS FILE EXISTS BECAUSE CSS CANNOT MEASURE ANOTHER ELEMENT, AND THE HEADER'S HEIGHT IS NOT
// A CONSTANT. `header` is already `position:sticky;top:0` (header.css), so the tab bar has to
// stick BELOW it — and how far below changes while the page is open: the GPU cards arrive after
// the first sample, the CPU line, CPU MEM, swap, memory-pressure, board-temp, power and UPS rows
// each appear only on a box that can report them, and any of them can come or go at runtime. A
// hard-coded `top:` would be right on one box, on one day, and silently wrong everywhere else —
// either overlapping the header or floating a band of page background under it that content
// scrolls through. So the height is MEASURED and published as `--hdr-h`.
//
// 🔴 9.0.10 — THE SAME PROBLEM ONE ROW DOWN, AND THE TOP ROW WAS NEVER GONE. Every sub-tab bar
// carries the `.tabs` class, so 9.0.8's rule
// pinned Voice Studio's Stems | Speech | Voice Training | Voice Swap row at the SAME `top` as
// `#tabs`, at the same z-index and later in the document — so it painted OVER the row it was
// supposed to sit under. Fixing it needs the height of `#tabs`, and that is no more a constant
// than the header's: the row wraps to a second line on a narrow window, and `Create a voice` is
// unhidden at runtime when VoxCPM2 turns out to be installed. So it is measured too, and
// published as `--tabs-h`.
//
// ⚠️ NO IMPORTS AND NO EXPORTS, DELIBERATELY — the `ui/filesafe.js` shape. The listener IS the
// feature, so there is nothing to export, and importing nothing keeps it out of the module graph's
// interior where `test_webui_bundle.py`'s cycle detector lives. Dropping its line from `main.js`
// does not produce a ReferenceError; it produces a tab bar that scrolls away, silently.
//
// ⚠️ AND THAT IS WHY A TAB SWITCH IS OBSERVED RATHER THAN SUBSCRIBED TO. `ui/tabswitch.js` exports
// an `onTabSwitch` hook, and importing it would be the obvious way to learn that a different
// sub-tab bar is now the visible one — at the cost of putting this file inside the graph it is
// deliberately outside of. It does not need to: `switchTab()` toggles `section.style.display`,
// which takes the old row's border box to 0×0 and brings the new one back, and a ResizeObserver
// over both rows is exactly what sees that.
//
// 📌 A `type="module"` script is deferred, so `<header>` and `.tabs` are both parsed by the time
// this runs. Every partial is assembled server-side into one document (`page_markup()`), so there
// is no later injection to wait for either.

const root = document.documentElement;

/** How much of the viewport the pinned chrome may take before pinning stops being a kindness. */
const MAX_HEADER_SHARE = 0.6;

/** Select panel navigation bars with `section[data-panel] > .tabs`; Bulk's inner `.tabs` is a card control and must remain in normal flow.
 */
const SUB_TABS = 'section[data-panel] > .tabs';

/** Height of whichever sub-tab bar is on screen, or 0 when the open panel has none. */
function visibleSubHeight() {
  // A `display:none` section reports 0×0 for everything inside it, so this needs no notion of
  // which tab is open: the one row with a height IS the open panel's row.
  for (const el of document.querySelectorAll(SUB_TABS)) {
    const h = el.getBoundingClientRect().height;
    if (h > 0) return h;
  }
  return 0;
}

function measure() {
  const h = document.querySelector('header');
  if (!h) return;
  const px = h.getBoundingClientRect().height;
  // ⚠️ THE RAW FRACTIONAL HEIGHT, NEVER ROUNDED. Round down and a sliver of scrolling content
  // shows above the tabs; round up and the tabs sit a pixel low, leaving a band of page
  // background between them and the header. The `- 1px` in the stylesheet then laps the tabs
  // under the header's own border, and the header's higher z-index paints over the overlap — so
  // no seam can exist at any zoom level or device pixel ratio.
  root.style.setProperty('--hdr-h', px + 'px');

  // 🔴 A HEADER TALLER THAN THE WINDOW WOULD PIN THE TABS OFF-SCREEN. On a short window (or a
  // box reporting every optional sensor row at once) `top` can exceed the viewport, and a sticky
  // element offset past the bottom is simply gone — the control would become unreachable.
  // Below the threshold it pins; above it, the tab bar
  // goes back to scrolling with the page, which is the pre-9.0.8 behavior and always usable.
  const room = window.innerHeight * MAX_HEADER_SHARE;
  const tabs = document.getElementById('tabs');
  const pinned = px <= room;
  const tabsH = pinned && tabs ? tabs.getBoundingClientRect().height : 0;
  root.style.setProperty('--tabs-pos', pinned ? 'sticky' : 'static');
  root.style.setProperty('--tabs-h', tabsH + 'px');

  // 🔴 AND THE SECOND ROW STANDS DOWN ON ITS OWN BUDGET, ONE ROW LATER — measured against
  // `header + #tabs` rather than the header alone, because that is what its own `top` is. The two
  // thresholds are deliberately not one: a window with room for one row but not two keeps the row
  // that navigates the whole app pinned and lets the sub-tabs scroll, rather than dropping both.
  const pinSub = pinned && px + tabsH <= room;
  const subH = pinSub ? visibleSubHeight() : 0;
  root.style.setProperty('--subtabs-pos', pinSub ? 'sticky' : 'static');

  // 🔴 `--stick-h` IS THE WHOLE PINNED BAND — header PLUS every tab row that is actually pinned —
  // and it exists because `scrollIntoView({block:'start'})` puts a target flush at the viewport
  // top, which is behind all of it. Paging the Voice Swap Sources list did that before 9.0.8 (the
  // header has always been sticky) and 9.0.8 made it worse by ~40px, 9.0.10 by another row.
  // `util/dom.js` spends it in `stickTop()` and `scrollUnderStick()`, which every pager and every
  // scroll nudge goes through.
  // ⚠️ It follows `--tabs-pos` and `--subtabs-pos`: with a bar stood down on a short window those
  // tabs scroll away like anything else, so counting their height would push every scroll target
  // too far down.
  root.style.setProperty('--stick-h', px + tabsH + subH + 'px');
}

measure();

// The header changes height for reasons that are not window resizes — a sensor row appearing, a
// second GPU card arriving with the first sample, the edition tag on an encrypted install. A
// ResizeObserver is what sees those; `resize` alone would leave the offset stale until the next
// time the window moved, which on a desktop is never. The tab rows go through the same observer
// for the same reason: a tab switch hides one sub-tab bar and shows another without the window
// ever moving, and `#tabs` grows a line when the window is narrow enough to wrap it.
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(measure);
  const watched = [document.querySelector('header'), document.getElementById('tabs'), ...document.querySelectorAll(SUB_TABS)];
  for (const el of watched) if (el) ro.observe(el);
}
window.addEventListener('resize', measure);
