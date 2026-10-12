"""Browser checks pin the hardware strip layout across representative viewport widths. They verify aligned metrics, stacked GPU cards, button placement, and bounded height."""
import json
import re
import subprocess
from pathlib import Path

import pytest

from conftest import REPO_ROOT, page_css  # noqa: F401  (sys.path side effect)

INDEX = REPO_ROOT / "src" / "webui" / "index.html"

# The widest each row can ever be. CPU: a 32-thread box pinned (max = cores*100), a 4-digit
# clock, 3-digit package power and temperature. CPU MEM: the parenthesized ZFS-ARC split at
# a large synthetic memory value exercises the widest expected row.
_ROWS = {
    "cpuBusy": ('<span class="ulab">CPU</span>'
                '<div class="ubar"><div class="ufill"></div></div>'
                '<span class="upct" style="min-width:42px">3200%</span>'
                '<span class="usep">|</span><span class="ustat">5800 <b>MHz</b></span>'
                '<span class="usep">|</span><span class="ustat">999 <b>W</b></span>'
                '<span class="usep">|</span><span class="ustat">100 <b>C</b></span>'),
    # The SAME row a moment later, idle. This is the "jumps way out" case: every readout is
    # narrower, and before the fix the trough grew by 19.4px to swallow the difference.
    "cpuIdle": ('<span class="ulab">CPU</span>'
                '<div class="ubar"><div class="ufill"></div></div>'
                '<span class="upct" style="min-width:42px">3%</span>'
                '<span class="usep">|</span><span class="ustat">800 <b>MHz</b></span>'
                '<span class="usep">|</span><span class="ustat">45 <b>W</b></span>'
                '<span class="usep">|</span><span class="ustat">38 <b>C</b></span>'),
    "cpuMem": ('<span class="ulab">CPU MEM</span>'
               '<div class="ubar"><div class="ufill mem"></div></div>'
               '<span class="upct" style="min-width:72px">100% '
               '<span class="ureal">(100%)</span></span>'
               '<span class="usep">|</span><span class="ustat">123.4 '
               '<span class="ureal">(98.7)</span> / 251.9 <b>GB</b></span>'),
}

# Include a narrow layout and progressively wider viewports.
_WIDTHS = (520, 700, 900, 1200, 1600)

_PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>%(css)s</style></head><body>
<div id="vram" style="width:1200px">%(rows)s</div><pre id="out"></pre><script>
const strip=document.getElementById('vram'), out=[];
for(const w of %(widths)s){
  strip.style.width=w+'px';
  const row={};
  for(const r of strip.children){
    if(r.id==='out'||!r.classList.contains('ubar-row'))continue;
    const bar=r.querySelector('.ubar'), kids=r.children;
    row[r.id]={bar:bar.getBoundingClientRect().width,
               // did anything spill past the row's right edge, i.e. did the reserve run out?
               fits:kids[kids.length-1].getBoundingClientRect().right
                    <= r.getBoundingClientRect().right+0.5};
  }
  out.push({w,row});
}
document.getElementById('out').textContent=JSON.stringify(out);
</script></body></html>"""


def _chrome():
    """Reused verbatim from test_ui_font_browser.py — same lookup, same CHROME_PATH override."""
    import os
    import shutil
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for c in ("chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(c)
        if found:
            return found
    for c in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              "/usr/bin/google-chrome", "/usr/bin/chromium"):
        if Path(c).exists():
            return c
    return None


def _measure(tmp_path):
    css = page_css()
    rows = "".join(f'<div class="ubar-row" id="{k}">{v}</div>' for k, v in _ROWS.items())
    page = tmp_path / "strip.html"
    page.write_text(_PAGE % {"css": css, "rows": rows, "widths": list(_WIDTHS)},
                    encoding="utf-8")
    r = subprocess.run([_chrome(), "--headless", "--disable-gpu", "--no-sandbox",
                        f"--user-data-dir={tmp_path / 'profile'}", "--virtual-time-budget=4000",
                        "--dump-dom", page.as_uri()],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=120)
    dom = re.search(r'<pre id="out">(.*?)</pre>', r.stdout, re.S)
    assert dom, f"Chrome rendered nothing measurable:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}"
    return json.loads(dom.group(1).replace("&quot;", '"').replace("&amp;", "&"))


@pytest.mark.timeout(180)
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_cpu_and_cpu_mem_troughs_are_the_same_length(tmp_path):
    """CPU and memory bars must have the same width at every tested viewport."""
    for sample in _measure(tmp_path):
        bars = {k: v["bar"] for k, v in sample["row"].items()}
        spread = max(bars.values()) - min(bars.values())
        assert spread <= 0.5, (
            f"the strip's troughs differ by {spread:.1f}px at a {sample['w']}px strip: {bars}. "
            "The trough must not depend on the readouts beside it — see the '🔴 THE TROUGH IS A "
            "FIXED SHARE OF THE ROW' comment on `#vram>.ubar-row>.ubar` in index.html. If the "
            "readouts genuinely grew, the 275px reserve is what to raise, NOT this tolerance.")


#: Two GPU cards, the shape `buildVram` emits — the cap line plus the GPU MEM row is enough to
#: give each card real width and height. ⚠️ If `buildVram` changes the card's wrapper class or
#: its container id, update this fixture; the test cannot see that happen.
_CARDS = ('<div class="card" data-g="0"><div class="cap"><span>cuda:0 AMD Radeon Graphics</span>'
          '<span>5.0 / 31.9 GB</span></div><div class="brow"><span class="ulab">GPU MEM</span>'
          '<div class="bar"><div class="vvoc"></div><div class="vused"></div></div></div></div>'
          '<div class="card" data-g="1"><div class="cap"><span>cuda:1 AMD Radeon Graphics</span>'
          '<span>5.1 / 31.9 GB</span></div><div class="brow"><span class="ulab">GPU MEM</span>'
          '<div class="bar"><div class="vvoc"></div><div class="vused"></div></div></div></div>')

_CARDS_PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>%(css)s</style></head><body>
<div id="vram" style="width:1200px"><div id="vramCards">%(cards)s</div></div>
<pre id="out"></pre><script>
const host=document.getElementById('vramCards'), wrap=document.getElementById('vram'), out=[];
for(const w of %(widths)s){
  wrap.style.width=w+'px';
  const r=[...host.children].map(c=>{const b=c.getBoundingClientRect();
    return {left:Math.round(b.left), top:Math.round(b.top), width:Math.round(b.width)};});
  out.push({w, cards:r});
}
document.getElementById('out').textContent=JSON.stringify(out);
</script></body></html>"""

#: Include widths where a wrapping row could fit both cards and verify stacking still wins.
_CARD_WIDTHS = (700, 900, 1200, 1600, 2560)


def _measure_cards(tmp_path):
    css = page_css()
    page = tmp_path / "cards.html"
    page.write_text(_CARDS_PAGE % {"css": css, "cards": _CARDS,
                                   "widths": list(_CARD_WIDTHS)}, encoding="utf-8")
    r = subprocess.run([_chrome(), "--headless", "--disable-gpu", "--no-sandbox",
                        f"--user-data-dir={tmp_path / 'profile'}", "--virtual-time-budget=4000",
                        "--dump-dom", page.as_uri()],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=120)
    dom = re.search(r'<pre id="out">(.*?)</pre>', r.stdout, re.S)
    assert dom, f"Chrome rendered nothing measurable:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}"
    return json.loads(dom.group(1).replace("&quot;", '"').replace("&amp;", "&"))


@pytest.mark.timeout(180)
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_gpu_cards_are_always_stacked_never_side_by_side(tmp_path):
    """GPU cards remain vertically stacked across the tested viewport widths."""
    for sample in _measure_cards(tmp_path):
        cards = sample["cards"]
        assert len(cards) == 2, f"fixture lost a card at {sample['w']}px: {cards}"
        a, b = cards
        assert a["left"] == b["left"], (
            f"the two GPU cards do not share a left edge at a {sample['w']}px strip "
            f"({a['left']} vs {b['left']}) — they are side by side. `#vramCards` must stay "
            "`flex-direction:column`; see the '🔴 ONE CARD PER ROW, ALWAYS' comment in index.html.")
        assert b["top"] > a["top"], (
            f"cuda:1 is not below cuda:0 at a {sample['w']}px strip "
            f"(tops {a['top']} and {b['top']}) — the cards are on one line.")


@pytest.mark.timeout(180)
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_readouts_still_fit_beside_the_trough(tmp_path):
    """The other half: a reserve that is too SMALL passes the equality test above and still looks
    broken, because every row silently wraps onto a second line. 275px was measured against the
    widest content either row can hold — this is the check that keeps it honest when someone adds
    a sensor to the CPU line or the box grows a terabyte of RAM."""
    for sample in _measure(tmp_path):
        if sample["w"] < 700:
            continue          # genuinely too narrow for the readouts; wrapping is correct there
        bad = [k for k, v in sample["row"].items() if not v["fits"]]
        assert not bad, (
            f"{bad} overflowed the row at a {sample['w']}px strip — the 275px reserve in "
            "index.html is now smaller than the readouts it has to hold, so the row wraps. "
            "Measure the widest content each row can reach and raise the reserve to match.")


# ── the two system lines in the header's first column (7.3.2) ────────────────────────────────
#
# The markup alone cannot prove alignment. The swap line must sit level with the CPU row and
# the memory-pressure line level with CPU MEM — in the OPPOSITE
# column, and the two columns are separate flex subtrees with no shared grid holding them in
# step. The alignment is an emergent consequence of four independent facts: `#sysMem` is
# bottom-anchored to the same flex line as `#vram`, both stacks use `gap:3px`, both kinds of row
# carry `margin-top:3px`, and a `.sysrow` is exactly as tall as a `.ubar-row` because both are
# one line of the same 12px text. Break any one — a padding, a font size, a `min-height`, the
# trough growing taller than its own text — and the lines drift by a few pixels, which no test
# that greps for a CSS rule could ever see. So: measure it.
#
# The fixture is the REAL header subtree (brand, both button rows, #sysMem, #vram) carrying the
# widest content each part can hold, against the SHIPPED stylesheet.
_HDR = """<header>
  <div class="hdr-brand"><h1>Vocalis</h1><span class="ver">v7.3.2 — Studio</span>
    <span class="edition">Encrypted Edition</span>
    <!-- ⚠️ 8.0: Log out lives HERE now, not in the button grid below, and this fixture is a COPY
         of index.html's header — so when it drifts, every measurement below silently describes a
         header that no longer ships. It drifted for exactly one commit and passed the whole
         time. -->
    <button id="logoutBtn" class="sm">⎋ Log out</button></div>
  <div class="hdr-stack">
    <!-- ⚠️ id="ready", not class alone. The shipped rule that places this in the grid is an ID
         selector (#ready), so a fixture carrying only the class silently opts out of the
         placement it is here to measure and lets the item auto-flow instead. -->
    <div class="hdr-row hdr-row1"><span class="ready" id="ready">Ready — Chatterbox loaded</span>
      <button id="cbBtn" class="sm">⏏ Unload Chatterbox</button>
      <button id="voxBtn" class="sm">⏏ Unload VoxCPM2</button></div>
    <div class="hdr-row hdr-row2"><button id="freeBtn" class="sm vram">⏏ Free Vocalis VRAM</button>
      <button id="comfyBtn" class="sm vram">⏹ Stop ComfyUI (2)</button>
      <button id="aceBtn" class="sm vram">⏹ Stop ACE-Step ×2</button></div>
    <!-- Inside .hdr-stack as rows 3-5, mirroring index.html. It was previously a sibling of the
         stack, creating a third column. If this
         fixture drifts back out, the tests below still pass while measuring the wrong thing. -->
    <div id="sysMem">
      <div class="sysrow" id="swapLine"><span class="ulab">uptime</span><span class="ustat">124 <b>days,</b> 13:47</span><span class="usep">·</span><span class="ulab">load</span><span class="ustat">128.44 96.10 64.02</span><span class="usep">·</span><span class="ulab">swap</span><span class="ustat">241.3 <b>/</b> 264.0 <b>GB</b></span></div>
      <div class="sysrow" id="psiLine"><span class="ulab">mem pressure</span><span class="ustat">18.4<b>%%</b> <b>·</b> 2 <b>d</b> 3 <b>h</b> 15 <b>min</b> <b>stalled since boot</b></span></div>
      <div class="sysrow" id="powerLine"><span class="ulab">power</span><span class="ustat">1488 <b>W</b></span><span class="usep">·</span><span class="ulab">avg</span><span class="ustat">1420 1385 1102 <b>W</b></span><span class="usep">·</span><span class="ulab">peak</span><span class="ustat">1611 <b>W</b></span></div>
      <!-- 🔴 THE TWO LEFT-OVERFLOW LINES, MISSING FROM THIS FIXTURE UNTIL 8.0. #upsLine and
           #boardTemp are the only rows that occupy column 1 rather than spanning, and they are
           the ones that decide how many ROWS this stack has — which is precisely what the
           header-growth budget below is about. Without them that budget was measuring a
           three-row stack while the test fixture contains five. -->
      <div class="sysrow" id="upsLine"><span class="ulab">wall</span><span class="ustat">1488 <b>W</b></span><span class="usep">·</span><span class="ulab">batt</span><span class="ustat">100<b>%%</b></span></div>
      <div class="sysrow" id="boardTemp"><span class="ulab">board</span><span class="ustat">42 <b>C</b></span><span class="usep">·</span><span class="ulab">RAM</span><span class="ustat">38 <b>C</b></span><span class="usep">·</span><span class="ulab">VRM</span><span class="ustat">54 <b>C</b></span></div>
    </div>
  </div>
  <div id="vram"><div id="vramCards">%(cards)s</div>
    <div class="ubar-row" id="cpuLine">%(cpu)s</div>
    <div class="ubar-row" id="cpuMemLine">%(cpumem)s</div></div>
</header>"""

_HDR_PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>%(css)s</style></head><body>
<div id="shell" style="width:1600px">%(hdr)s</div><pre id="out"></pre><script>
const shell=document.getElementById('shell'), sys=document.getElementById('sysMem'), out=[];
const box=el=>{const b=el.getBoundingClientRect();
               return {mid:(b.top+b.bottom)/2, top:b.top, bottom:b.bottom,
                       right:b.right, left:b.left, w:b.width, h:b.height};};
for(const w of %(widths)s){
  shell.style.width=w+'px';
  const g=id=>box(document.getElementById(id));
  // The strip and header WITHOUT these lines, for the "they cost the strip nothing" claim.
  sys.style.display='none';
  const vramOff=g('vram'), hdrOff=box(document.querySelector('header')), cpuOff=g('cpuLine');
  sys.style.display='contents';
  out.push({w, swap:g('swapLine'), psi:g('psiLine'), pow:g('powerLine'),
            cpu:g('cpuLine'), cpuMem:g('cpuMemLine'),
            vram:g('vram'), stack:box(document.querySelector('.hdr-stack')),
            logout:g('logoutBtn'), hdr:box(document.querySelector('header')),
            ready:g('ready'), cb:g('cbBtn'), vox:g('voxBtn'),
            free:g('freeBtn'), comfy:g('comfyBtn'), ace:g('aceBtn'),
            vramOff, hdrOff, cpuOff,
            // flush right INSIDE the block? (.sysrow{justify-content:flex-end})
            // ⚠️ The LAST .ustat on each line, not the first: the top line carries three
            // readouts now, and querySelector would measure uptime's right edge instead of the
            // line's — which would pass while the lines were visibly ragged.
            swapEnd:box([...document.querySelectorAll('#swapLine .ustat')].pop()).right,
            psiEnd:box([...document.querySelectorAll('#psiLine .ustat')].pop()).right,
            powEnd:box([...document.querySelectorAll('#powerLine .ustat')].pop()).right,
            // 🔴 THE CONDITION THE EXPLICIT COLUMNS EXIST FOR, WITHOUT WHICH EVERY COLUMN
            // ASSERTION ABOVE IS VACUOUS. With every button visible, auto-flow puts the 1st,
            // 2nd and 3rd items in columns 1, 2 and 3 anyway — so the measurements agree with
            // the rule for a reason that has nothing to do with the rule, and deleting
            // a control from the grid-column list changes not one pixel. The failure is only
            // reachable when an EARLIER control is hidden, which is the normal state of this
            // header: #voxBtn needs VoxCPM2 and #comfyBtn needs a controllable ComfyUI, and
            // most boxes have neither. Measured here by hiding that pair.
            hidden:(()=>{const v=document.getElementById('voxBtn'),
                               c=document.getElementById('comfyBtn');
                         v.style.display='none';c.style.display='none';
                         const r={ready:g('ready'), ace:g('aceBtn'), free:g('freeBtn')};
                         v.style.display='';c.style.display='';return r;})()});
}
document.getElementById('out').textContent=JSON.stringify(out);
</script></body></html>"""

#: Exercise a range of header widths around the current layout's breakpoints.
_HDR_WIDTHS = (1100, 1280, 1600, 1920, 2560)

#: One GPU card, the shape `buildVram` emits. The COUNT is what decides whether these lines cost
#: the header any HEIGHT: with two or more, the strip is already taller than the stack.
_ONE_CARD = ('<div class="card" data-g="%d"><div class="cap"><span>cuda:%d AMD Radeon Graphics'
             '</span><span>5.0 / 31.9 GB</span></div><div class="brow">'
             '<span class="ulab">GPU MEM</span><div class="bar"><div class="vvoc"></div>'
             '<div class="vused"></div></div></div></div>')


def _measure_header(tmp_path, cards=1):
    css = page_css()
    hdr = _HDR % {"cards": "".join(_ONE_CARD % (i, i) for i in range(cards)),
                  "cpu": _ROWS["cpuBusy"], "cpumem": _ROWS["cpuMem"]}
    page = tmp_path / "header.html"
    page.write_text(_HDR_PAGE % {"css": css, "hdr": hdr,
                                 "widths": list(_HDR_WIDTHS)}, encoding="utf-8")
    r = subprocess.run([_chrome(), "--headless", "--disable-gpu", "--no-sandbox",
                        f"--user-data-dir={tmp_path / 'profile'}",
                        # Wide window, narrow #shell: the loop varies the element, not the
                        # viewport. Kept from when a media query keyed on the viewport and a
                        # default 800px window silently measured a hidden block — the query is
                        # gone, but a fixture that measures zero-sized rects is worth not
                        # re-learning.
                        "--window-size=2600,1000",
                        "--virtual-time-budget=4000", "--dump-dom", page.as_uri()],
                       capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=120)
    dom = re.search(r'<pre id="out">(.*?)</pre>', r.stdout, re.S)
    assert dom, f"Chrome rendered nothing measurable:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}"
    out = json.loads(dom.group(1).replace("&quot;", '"').replace("&amp;", "&"))
    assert all(s["swap"]["w"] > 0 and s["psi"]["w"] > 0 and s["pow"]["w"] > 0 for s in out), (
        "a system line measured zero-width — it is hidden, so nothing below this is a real "
        "measurement. Check the fixture and the --window-size above.")
    return out


@pytest.mark.timeout(180)
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
@pytest.mark.parametrize("cards", [1, 2, 3])
def test_the_system_lines_are_rows_of_the_button_stack_not_a_third_column(tmp_path, cards):
    """System readouts remain rows in the button stack rather than creating a third header column."""
    for s in _measure_header(tmp_path, cards):
        # ⚠️ 8.0: was Log out's bottom edge — it left .hdr-stack for .hdr-brand, so measuring it
        # here would compare against a button in a DIFFERENT grid and pass for the wrong reason.
        # #aceBtn is what occupies row 2 column 3 now.
        assert s["swap"]["top"] >= s["ace"]["bottom"] - 0.5, (
            f"the top system line starts at y={s['swap']['top']:.1f}, above the ACE-Step "
            f"button's bottom edge at {s['ace']['bottom']:.1f} ({s['w']}px, {cards} card(s)) — "
            "it is beside the buttons, not under them. #swapLine belongs in grid-row 3 of "
            ".hdr-stack.")
        assert s["psi"]["top"] >= s["swap"]["bottom"] - 0.5, (
            f"the mem pressure line is not below the swap line at {s['w']}px — grid rows 3 "
            "and 4 of .hdr-stack, in that order.")
        assert s["pow"]["top"] >= s["psi"]["bottom"] - 0.5, (
            f"the power line is not below the mem pressure line at {s['w']}px — the required position is "
            "it as a line BELOW those two (7.3.6), which is grid row 5.")
        assert abs(s["swap"]["right"] - s["stack"]["right"]) <= 0.5, (
            f"the top system line ends {s['swap']['right'] - s['stack']['right']:.1f}px from "
            f"the stack's right edge at {s['w']}px — `justify-self:end` on #swapLine is what "
            "right-justifies it, and grid-column:1/-1 is what gives it the full stack to do it "
            "in. A third column would show up here as a mismatch too.")
        assert abs(s["psi"]["right"] - s["stack"]["right"]) <= 0.5, (
            f"the mem pressure line ends {s['psi']['right'] - s['stack']['right']:.1f}px from "
            f"the stack's right edge at {s['w']}px.")
        assert abs(s["pow"]["right"] - s["stack"]["right"]) <= 0.5, (
            f"the power line ends {s['pow']['right'] - s['stack']['right']:.1f}px from the "
            f"stack's right edge at {s['w']}px.")


@pytest.mark.timeout(180)
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_the_five_buttons_form_a_block_not_an_L(tmp_path):
    """The five header buttons form a compact block with consistent alignment."""
    for s in _measure_header(tmp_path):
        assert abs(s["cb"]["left"] - s["free"]["left"]) <= 0.5, (
            f"Unload Chatterbox starts at x={s['cb']['left']:.1f} and Free Vocalis VRAM at "
            f"{s['free']['left']:.1f} ({s['w']}px) — column 1 of .hdr-stack must hold #cbBtn "
            "over #freeBtn.")
        assert abs(s["vox"]["left"] - s["comfy"]["left"]) <= 0.5, (
            f"Load VoxCPM2 starts at x={s['vox']['left']:.1f} and Stop ComfyUI at "
            f"{s['comfy']['left']:.1f} ({s['w']}px) — column 2 must hold #voxBtn over #comfyBtn.")
        assert abs(s["ready"]["left"] - s["ace"]["left"]) <= 0.5, (
            f"the status text starts at x={s['ready']['left']:.1f} and the ACE-Step button at "
            f"{s['ace']['left']:.1f} ({s['w']}px) — the text belongs in column 3, directly "
            "above the button that holds it.")
        assert s["cb"]["left"] < s["vox"]["left"] < s["ready"]["left"], (
            f"the columns are out of order at {s['w']}px: Unload Chatterbox "
            f"{s['cb']['left']:.1f}, Load VoxCPM2 {s['vox']['left']:.1f}, status text "
            f"{s['ready']['left']:.1f}. Buttons own 1 and 2; the text is pushed right to 3.")


@pytest.mark.timeout(180)
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_a_hidden_control_does_not_drag_the_survivors_leftwards(tmp_path):
    """Hiding one control must not shift the remaining controls into a different column."""
    for s in _measure_header(tmp_path):
        h = s["hidden"]
        # October 11, 2026 (Doug): with the ComfyUI button hidden, ACE-Step takes ITS slot, column 2,
        # under Load VoxCPM2, so the header has no hole. That is still an explicit column: it is the
        # same x Load VoxCPM2 starts at when everything is visible, whether or not #voxBtn is showing.
        assert abs(h["ace"]["left"] - s["vox"]["left"]) <= 0.5, (
            f"with #voxBtn and #comfyBtn hidden, the ACE-Step button is at x={h['ace']['left']:.1f} "
            f"but column 2 starts at {s['vox']['left']:.1f} ({s['w']}px) — with no ComfyUI button "
            "#aceBtn belongs in column 2 (the `#comfyBtn[style*=\"none\"] ~ #aceBtn` rule in "
            "css/header.css), not in column 3 and not wherever auto-placement puts it.")
        assert h["ready"]["left"] > h["ace"]["left"] + 0.5, (
            f"with the ComfyUI button hidden, the status text at x={h['ready']['left']:.1f} is not "
            f"right of the ACE-Step button at {h['ace']['left']:.1f} ({s['w']}px) — the text keeps "
            "column 3.")
        assert h["ace"]["left"] > h["free"]["left"] + 0.5, (
            f"with the ComfyUI pair hidden, ACE-Step at x={h['ace']['left']:.1f} landed on top "
            f"of or left of Free Vocalis VRAM at {h['free']['left']:.1f} ({s['w']}px) — the "
            "survivors collapsed leftwards, which is exactly what the explicit columns prevent.")


@pytest.mark.timeout(180)
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
@pytest.mark.parametrize("cards", [1, 2])
def test_the_system_lines_take_no_width_from_the_strip(tmp_path, cards):
    """Adding system readouts must not increase the strip width."""
    for s in _measure_header(tmp_path, cards):
        assert abs(s["vram"]["w"] - s["vramOff"]["w"]) <= 0.5, (
            f"the strip is {s['vramOff']['w'] - s['vram']['w']:.1f}px narrower with the system "
            f"lines drawn ({s['w']}px, {cards} card(s)) — they are taking width from it, which "
            "means they are a column again. #sysMem must be display:contents and its children "
            "grid items of .hdr-stack.")
        assert s["cpu"]["h"] <= s["cpuOff"]["h"] + 0.5, (
            f"the CPU row grew from {s['cpuOff']['h']}px to {s['cpu']['h']}px when the system "
            f"lines were drawn at {s['w']}px — it has wrapped onto two lines.")


@pytest.mark.timeout(180)
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
@pytest.mark.parametrize("cards,budget_px", [(2, 8.0), (3, 0.5)])
def test_the_system_lines_mostly_fit_in_height_the_header_already_had(tmp_path, cards,
                                                                      budget_px):
    """The system readouts should fit within the existing header height with a small bounded increase."""
    for s in _measure_header(tmp_path, cards=cards):
        grew = s["hdr"]["h"] - s["hdrOff"]["h"]
        assert grew <= budget_px, (
            f"the header grew {grew:.1f}px at {s['w']}px on a {cards}-card box, past the "
            f"{budget_px}px this layout is allowed. The system lines are pushing the button "
            "stack past the strip — a new one has to earn that, or go on an existing row.")


HWSTRIP = REPO_ROOT / "src" / "webui" / "js" / "sys" / "hwstrip.js"

#: (seconds, rendered text). Minutes floor at every step, and SECONDS NEVER APPEAR.
_DURATIONS = [
    (0,            "0 min"),
    (59,           "0 min"),          # 59 s of stall is not "1 min" — floor, never round
    (60,           "1 min"),
    (2005,         "33 min"),         # long-duration formatting case
    (3599,         "59 min"),
    (3600,         "1 h 0 min"),
    (11700,        "3 h 15 min"),
    (86400,        "1 d 0 h 0 min"),  # the hours term stays: "1 d 0 min" would read as 1 d 0 h
    (184500,       "2 d 3 h 15 min"),
    (-5,           "0 min"),          # a counter that went backward is not a negative duration
]


@pytest.mark.skipif(not __import__("shutil").which("node"), reason="node is not installed")
def test_the_stall_figure_prints_days_hours_and_minutes_but_never_seconds():
    """The stall duration uses days, hours, and minutes, omitting seconds for long waits."""
    import shutil
    src = HWSTRIP.read_text(encoding="utf-8")
    m = re.search(r"\nfunction fmtDur\(s\)\s*\{.*?\n\}", src, re.S)
    assert m, ("fmtDur is gone or reshaped in hwstrip.js — if the duration is now formatted "
               "somewhere else, point this test at it rather than deleting it.")
    cases = json.dumps([c[0] for c in _DURATIONS])
    script = f"{m.group(0)}\nconsole.log(JSON.stringify({cases}.map(fmtDur)));"
    out = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                         capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert out.returncode == 0, f"node could not run fmtDur:\n{out.stderr[-1000:]}"
    got = [re.sub(r"</?b>", "", s) for s in json.loads(out.stdout)]

    for (secs, want), have in zip(_DURATIONS, got):
        assert have == want, f"fmtDur({secs}) printed {have!r}, expected {want!r}"
    assert not any(re.search(r"\bs\b|sec", g) for g in got), (
        f"a duration printed seconds: {got}. Days, hours and minutes only.")


#: (seconds, rendered text) — procps `uptime`, whose logic is: a "N day(s), " prefix when there
#: are days at all, then "H:MM" if there is an hour and "M min" if there is not.
_UPTIMES = [
    (0,        "0 min"),
    (59,       "0 min"),
    (300,      "5 min"),
    (3540,     "59 min"),
    (3600,     "1:00"),          # the hour arrives and the format changes with it
    (58980,    "16:23"),         # long-duration formatting case
    # 🔴 EXACTLY ONE DAY IS "1 day, 0 min", NOT "1 day, 0:00", and that is not a quirk — procps
    # takes the minutes branch whenever the HOUR count is zero, days or no days. I wrote 0:00
    # here first and the extracted function said otherwise; the rule is one line of uptime.c
    # (`if (uphours) "%2d:%02d" else "%d min"`), and the 173700 case below is the same branch.
    (86400,    "1 day, 0 min"),    # singular
    (87300,    "1 day, 15 min"),   # 1 d 0 h 15 m — still no hour, still the minutes branch
    (90900,    "1 day, 1:15"),     # 1 d 1 h 15 m — the hour arrives and the format flips
    (173700,   "2 days, 15 min"),
    (10763220, "124 days, 13:47"),
]


@pytest.mark.skipif(not __import__("shutil").which("node"), reason="node is not installed")
def test_uptime_is_formatted_the_way_uptime_prints_it():
    """Uptime uses compact human-readable units and matches the expected formatting at each boundary."""
    import shutil
    src = HWSTRIP.read_text(encoding="utf-8")
    m = re.search(r"\nfunction fmtUptime\(s\)\s*\{.*?\n\}", src, re.S)
    assert m, "fmtUptime is gone or reshaped in hwstrip.js — re-point this test, don't delete it."
    cases = json.dumps([c[0] for c in _UPTIMES])
    script = f"{m.group(0)}\nconsole.log(JSON.stringify({cases}.map(fmtUptime)));"
    out = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                         capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert out.returncode == 0, f"node could not run fmtUptime:\n{out.stderr[-1000:]}"
    got = [re.sub(r"</?b>", "", s) for s in json.loads(out.stdout)]
    for (secs, want), have in zip(_UPTIMES, got):
        assert have == want, f"fmtUptime({secs}) printed {have!r}, expected {want!r}"


def test_the_stall_figure_says_what_the_time_was_spent_doing():
    """The wording half of the same fix, checked against the source that renders it: the duration
    must be labeled `stalled since boot`, never a bare `since boot` — which is what read as
    uptime. Cheap and blunt on purpose; the browser tests above cannot see WORDS."""
    src = HWSTRIP.read_text(encoding="utf-8")
    # WARNING: `\)?` and `\s*` ABSORB A JSDoc CAST, NOT ANY OLD RENDERER. 8.8-m6 deleted the
    # global `Element` widening, so `querySelector` is honestly `Element | null` and this line now
    # reads `/** @type {HTMLElement} */ (psiEl.querySelector('.ustat')).innerHTML = ...`. Every
    # cast form inserts a `)` between the call and the property, and no placement avoids it. The
    # CLAIM is unchanged: this still pins the `.ustat` element's own innerHTML assignment.
    render = re.search(
        r"psiEl\.querySelector\('\.ustat'\)\)?\s*\.innerHTML\s*=\s*`(.*?)`;", src, re.S)
    assert render, "the mem-pressure line's renderer moved — re-point this test at it."
    assert "stalled since boot" in render.group(1), (
        f"the mem pressure line renders {render.group(1)!r}. A duration next to a boot reference "
        "reads as uptime unless the sentence says what the time was spent doing. Keep the verb.")


def test_the_power_line_never_calls_itself_the_whole_box(tmp_path):
    """🔴 THE ONE CLAIM THIS READOUT MUST NOT MAKE. It sums the CPU package and the cards, which
    is everything on this box that can report watts and nothing like everything that draws them:
    RAM, the disks, the fans, the board and the PSU's own losses are not in it and cannot be read
    from inside the machine at all. So the figure is a FLOOR, the tooltip has to say so, and the
    number a smart plug shows will always be higher.

    Blunt and word-level on purpose — the browser tests above measure boxes, and a rewording that
    quietly promoted this to "total system power" would move no pixel."""
    src = HWSTRIP.read_text(encoding="utf-8")
    block = re.search(r"if\s*\(pow\)\s*\{(.*?)\n  \}", src, re.S)
    assert block, "the power line's renderer moved — re-point this test at it, don't delete it."
    body = block.group(1)
    assert "NOT wall draw" in body, (
        "the power tooltip no longer says the figure excludes everything that cannot report "
        "itself. Without that sentence it reads as the number on a plug meter, which it is not.")
    for readout in ('data-r="now"', 'data-r="avg"', 'data-r="peak"'):
        assert readout in body, f"the power line lost its {readout} slot"
    # 7.3.4's lesson, applied before it can be re-learned: three readouts on one row need three
    # titles. A row-level tooltip would answer "what is this?" with the wrong paragraph for two
    # of the three things under the cursor.
    # ⚠️ COUNTED WITH A REGEX SINCE 8.3.2 — Prettier writes `.title = `. A substring count of
    # `.title=` reads 0 against three perfectly good tooltips, which is the reformat masquerading
    # as a missing feature. Still counts ASSIGNMENTS to `.title`, so a row-level tooltip standing
    # in for three still fails.
    assert len(re.findall(r"\.title\s*=", body)) >= 3, (
        "the power row's three readouts do not each own a tooltip — hovering the peak would "
        "explain the live figure.")


def test_the_page_quotes_the_sample_rate_the_sampler_actually_runs_at():
    """🔴 THE RATE IS A NUMBER IN TWO PLACES, AND IT DRIFTED WITHIN ONE EVENING.

    7.3.6 shipped at 1 Hz with "once a second" in the tooltip; 7.3.6c moved the sampler to 4 Hz
    because RAPL is a ~1 kHz energy counter and a 200 ms CPU burst was being averaged down to a
    quarter of its height. The tooltip is what a user reads to know how much to trust the figure,
    so a stale one is not cosmetic — it is the readout lying about its own resolution.

    Pinned as the NUMBER, parsed out of the shipped tooltip and compared to the constant, rather
    than as a form of words: rewording is fine, disagreeing is not.
    """
    from vocalis.runtime import power
    src = HWSTRIP.read_text(encoding="utf-8")
    m = re.search(r"the server's (\d+) Hz power series", src)
    assert m, ("the averages tooltip no longer states the sample rate. It is the only place the "
               "user is told how sharp this figure is — say it, and say the real number.")
    assert int(m.group(1)) == power.SAMPLE_HZ, (
        f"the page tells the user the series is {m.group(1)} Hz and the sampler runs at "
        f"{power.SAMPLE_HZ} Hz. Update hwstrip.js's power tooltips with the constant, not from "
        "memory of what it used to be.")
