"""Browser half of the satellite acceptance check: one subcommand per step a user takes in the real Vocalis
Settings page and Playground, in headless Chromium with audio muted. It proves, through the page and not around
it, that a satellite set up by the satellite package (satellite-setup.sh / satellite-setup.ps1) works end to
end: it can be added and shows its secret once, takes a pinned certificate whose fingerprint matches the one
the setup script printed, loads as soon as its cards are ticked, renders a short and a multi-chunk text (the
latter through the satellite's batch path), shows up in the header strip, is released again, survives "New
secret...", and can be removed.

Proof items covered: the satellite package (one command per operating system; the "Live, through the real Settings
page" item) and the whole-card memory readings (`card-stats` gives the main server's own per-card readings so two of them, taken before
and during a memory hold, can be compared). Written October 10, 2026; reviewed and revised the same day.

The satellite setup scripts are run between these steps by whoever drives the proof, so each subcommand does
ONE browser-side step, writes a small JSON result file (also on failure, with a `failure` string) and exits 0
or 1:

  add          --url https://IP:PORT --secret-out FILE [--force] [--keep-on-failure]   Add satellite
  new-secret   --secret-out FILE [--force] [--keep-on-failure]                         the row's "New secret..."
  upload-cert  --cert FILE (--fingerprint AA:BB:... | --setup-result setup-result.txt)  "Upload certificate..."
               (the setup program's result file, October 11, 2026: its FINGERPRINT key is the expected value, so a
               test that ran the setup program need not read it off the screen)
  status       --expect reachable|unreachable [--timeout S]                           what Settings reports
  load         [--only-satellite] [--timeout S]                                       tick its cards, wait for load
  render       --text-file FILE [--expect-chunks-min N] [--expect-batch] [--allow-local]
               [--allow-resume] [--timeout S]                                         Playground
  strip        [--require name,vram,...] [--timeout S]                                header strip rows for its cards
  card-stats                                                                          main server's per-card readings
  unload       [--timeout S]                                                          untick its cards, wait for release
  restore-local [--from RESULT.json]                                                  re-tick the local cards `load` unticked
  remove       [--allow-absent]                                                       Remove, confirm it is gone

Common arguments: --vocalis URL, --secrets DIR (holds `vocalis-password`, the same folder the other acceptance
scripts take), --name SATELLITE_NAME (every subcommand but card-stats), --out RESULT.json.

Secrets: the 64-hex shared secret Vocalis shows once is written to the --secret-out file, which must be inside
--secrets DIR (anything else, a path in the repository included, is refused). It is created with an exclusive
create and the tightest permissions the platform allows, and is never printed, logged, put in the result JSON
(only its length) or in an exception message; every line that is printed or saved is scrubbed of any 64-hex run
as a second guard. No screenshots are taken, because the secret is on screen while it is shown. The tool keeps
a small state file `satellite-acceptance-state.json` in --secrets DIR holding, per satellite name, the PATHS of
the secret files it wrote (never their content) and the local cards `load --only-satellite` unticked; `remove`
deletes the secret files and the state file when nothing is left in it. If the secret was written but the dialog
could not be dismissed cleanly, the file is deleted before the failure is reported, unless --keep-on-failure.

Audio: Chromium is launched headless with --mute-audio, so nothing can reach the speakers and no window opens
(Doug, October 9, 2026: test narration reached his speakers from a visible browser).

What is driven through the page and what through its API, and why:
  * Page controls: Add satellite (#satName, #satUrl, #satAdd), the secret dialog, "New secret...", "Upload
    certificate..." (the page's own file chooser), the device tick boxes (#devList .devchk), the row's
    reconnect button, Check now, Remove, and in the Playground the text box and Generate. The page has no
    "Load" button for devices: a tick saves and loads by itself. `load` and `unload` therefore wait for the
    result of the TICK ALONE and record `applied: "tick"`; they press the reconnect button only when no tick
    changed (a rerun) and record `applied: "reconnect"`, so the user documentation's claim "they load as soon
    as you tick them" is what gets proven.
  * Read-only API calls from inside the page, with its session: GET /devices and GET /system/stats (what the
    page itself polls) for state the DOM only shows as prose, and GET of the finished clip's audio. Every one has
    an abort timeout and a timeout is reported as a plain failure. Completion is waited for on real signals:
    the page's own requests (a fetch hook records the status of every non-GET call), the render job's
    server-sent events (an EventSource hook records them), and /devices state.
  * Nothing is written through the API; every change goes through a page control.

Usage (run Python WITHOUT -I so it finds Playwright):
    python acceptance_satellite.py add --vocalis URL --secrets DIR --name NAME --out R.json --url https://IP:7880 --secret-out DIR/NAME.secret
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import acceptance_browser as ab  # noqa: E402
from acceptance_browser import Failed, wait_until  # noqa: E402

REPO = HERE.parents[2]

# Every wait is bounded; these are the safety deadlines in seconds (a timeout is a failure, never the signal).
DEFAULT_WAIT_S = 60
LOAD_S = 900            # a Chatterbox model off a cold disk on the satellite
UNLOAD_S = 300
RENDER_S = 900
STRIP_S = 30

HEX64 = re.compile(r"[0-9a-fA-F]{64}")
STATE_NAME = "satellite-acceptance-state.json"

# Installed before any page script runs. Two hooks, both read-only observers:
#  * every non-GET fetch is recorded with its status (path only, never a body or a header), so "the save
#    landed" and "the reconnect returned" are signals, not sleeps;
#  * the Playground's job event stream (/book/events/...) is recorded, minus the high-rate strip samples, so a
#    render's chunks, devices and end are read from the same events the page draws its log from. Each event
#    carries the time it reached the page (`__t`, milliseconds), so a chunk can be matched against the
#    satellite's own log.
HOOKS = """(() => {
  window.__calls = [];
  const orig = window.fetch.bind(window);
  window.fetch = async (...a) => {
    const req = a[0], init = a[1] || {};
    const method = String(init.method || (req && req.method) || 'GET').toUpperCase();
    const url = String(typeof req === 'string' ? req : (req && req.url) || req).split('?')[0];
    let rec = null;
    if (method !== 'GET') { rec = {n: window.__calls.length, method, url, status: null, done: false}; window.__calls.push(rec); }
    try { const r = await orig(...a); if (rec) rec.status = r.status; return r; }
    finally { if (rec) rec.done = true; }
  };
  window.__events = [];
  const Orig = window.EventSource;
  window.EventSource = class extends Orig {
    constructor(u, o) {
      super(u, o);
      if (String(u).includes('/book/events/')) this.addEventListener('message', ev => {
        try { const d = JSON.parse(ev.data); if (d && d.type && d.type !== 'vram') { d.__t = Date.now(); window.__events.push(d); } } catch (e) {}
      });
    }
  };
})();"""

# A GET with an abort timer. Every fetch this script makes in the page goes through it, so a wedged server ends
# as a plain "timed out" failure instead of a wait that never returns.
TF = """const tf = async (u, ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(u, {signal: c.signal}); } finally { clearTimeout(t); } };
const why = (e) => (e && e.name === 'AbortError') ? 'timed out' : String((e && e.message) || e);"""
# GET /devices probes every satellite (5 s each when one is down), hence the longer limit.
DEVICES_JS = "async () => { " + TF + """
  try { const r = await tf('/devices', 60000); let b = null; try { b = await r.json(); } catch (e) {}
    return {status: r.status, body: b}; } catch (e) { return {status: 0, error: why(e)}; } }"""
STATS_JS = "async () => { " + TF + """
  try { const r = await tf('/system/stats', 30000); let b = null; try { b = await r.json(); } catch (e) {}
    return {status: r.status, body: b}; } catch (e) { return {status: 0, error: why(e)}; } }"""
# Reads /devices (the page's own data) once every 1.5 s, inside the page, until the satellite is reachable, not
# loading, and every ticked row holds a worker (mode "loaded") or every row holds none (mode "released").
# Returns the state seen, null when the bounded time is up, or {unreachable, error} when Vocalis reports the
# satellite unreachable on two polls in a row (it is not coming back by itself within seconds; the error text is
# Vocalis's own). It loops in the page because Playwright's wait_for_function does not poll an async predicate:
# it takes the Promise as truthy and returns at once (seen October 10, 2026: it handed back `false` immediately).
LOADED_JS = "async ([name, mode, seconds]) => { " + TF + """
  const end = Date.now() + seconds * 1000;
  let down = 0;
  for (;;) {
    try {
      const r = await tf('/devices', 60000);
      if (r.ok) {
        const b = await r.json();
        const s = (b.satellites || []).find(x => x.name === name);
        const rows = (b.devices || []).filter(d => d.satellite === name);
        down = (s && !s.reachable) ? down + 1 : 0;
        if (down >= 2) return {unreachable: true, error: String(s.error || '')};
        if (s && s.reachable && !s.loading && rows.length) {
          const seen = {ready: s.ready, rows: rows.map(d => ({id: d.id, enabled: d.enabled, loaded: d.loaded}))};
          if (mode === 'loaded') { const on = rows.filter(d => d.enabled); if (on.length && on.every(d => d.loaded >= 1)) return seen; }
          else if (rows.every(d => d.loaded === 0)) return seen;
        }
      }
    } catch (e) { /* a timed-out read is retried until the bounded time is up */ }
    if (Date.now() > end) return null;
    await new Promise(res => setTimeout(res, 1500));
  }
}"""
# Waits (bounded) until Vocalis reports the satellite reachable (want "reachable") or not (want "unreachable").
REACH_JS = "async ([name, want, seconds]) => { " + TF + """
  const end = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const r = await tf('/devices', 60000);
      if (r.ok) {
        const s = ((await r.json()).satellites || []).find(x => x.name === name);
        if (s && s.reachable === (want === 'reachable')) return true;
      }
    } catch (e) { /* retried until the bounded time is up */ }
    if (Date.now() > end) return false;
    await new Promise(res => setTimeout(res, 1500));
  }
}"""

OVERLAY_ON = "document.getElementById('overlay').classList.contains('on')"

# How a user answers the dialogs these flows can raise, by title. A dialog not listed here and not an error
# is left open and the step fails naming it. Every dialog answered is recorded in the result.
MODAL_ANSWERS = {
    "An LLM is holding the GPUs": "Enable anyway",
    # Answered for a LOCAL card only. For a satellite card it must not appear (a satellite cannot run ACE-Step;
    # the product is being fixed so that the prompt is gone there), so `pump` fails on it instead.
    "Stop ACE-Step on these cards?": "Save and stop",
    "Rendering on the CPU now": "OK",
    "Replace the take you already have?": "Replace",
}
MODAL_ERRORS = ("Devices not saved", "Reconnect failed", "Satellite not reachable", "Generation failed",
                "Certificate not accepted", "Certificate not stored", "Could not save")

STRIP_READOUTS = ("name", "vram", "busy", "temperature", "power", "clocks", "fan")


def scrub(text: str) -> str:
    """Second guard: whatever is printed or saved never contains a 64-hex run (the shape of the secret)."""
    return HEX64.sub("<64-hex>", str(text))


def say(text: str) -> None:
    ab.log(scrub(text))


class Ctx:
    """One run: the page, the Vocalis base URL, the satellite name, the result being built and the deadline helper."""

    def __init__(self, page, base: str, args, result: dict):
        self.page, self.base, self.args, self.R = page, base, args, result
        self.name = (args.name or "").strip().lower()
        self.R.setdefault("modals", [])

    def deadline(self, seconds: float) -> float:
        return time.monotonic() + seconds


def is_satellite_device(device_id: str) -> bool:
    return ":" in device_id and not device_id.startswith("cuda")


# ---------------------------------------------------------------------------------------------------------
# State file (paths and ids only, never secret content)
# ---------------------------------------------------------------------------------------------------------

def state_path(c: Ctx) -> Path:
    return Path(c.args.secrets) / STATE_NAME


def read_state(c: Ctx) -> dict:
    path = state_path(c)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise Failed(f"cannot read {path.name}: {type(exc).__name__}") from None
    return data if isinstance(data, dict) else {}


def write_state(c: Ctx, state: dict) -> None:
    """Write the state atomically; names with nothing left are dropped and an empty state removes the file."""
    path = state_path(c)
    state = {name: {k: v for k, v in entry.items() if v} for name, entry in state.items()}
    state = {name: entry for name, entry in state.items() if entry}
    if not state:
        if path.exists():
            path.unlink()
            say(f"state file: {path.name} removed (nothing left in it)")
        return
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    os.replace(temp, path)


def state_entry(state: dict, name: str) -> dict:
    return state.setdefault(name, {})


def record_secret_file(c: Ctx, path: Path) -> None:
    state = read_state(c)
    files = state_entry(state, c.name).setdefault("secretFiles", [])
    if str(path) not in files:
        files.append(str(path))
    write_state(c, state)


def forget_secret_file(c: Ctx, path: Path) -> None:
    state = read_state(c)
    entry = state_entry(state, c.name)
    entry["secretFiles"] = [f for f in entry.get("secretFiles", []) if f != str(path)]
    write_state(c, state)


# ---------------------------------------------------------------------------------------------------------
# The secret file
# ---------------------------------------------------------------------------------------------------------

def secret_path(c: Ctx) -> Path:
    """The --secret-out path, which must be inside --secrets DIR and outside the repository."""
    root = Path(c.args.secrets).resolve()
    path = Path(c.args.secret_out).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise Failed(f"--secret-out must be inside --secrets ({root}); {path.name} is not") from None
    try:
        path.relative_to(REPO.resolve())
    except ValueError:
        pass
    else:
        raise Failed("--secret-out must not be inside the repository")
    if path == root or path.name == STATE_NAME or path.name == "vocalis-password":
        raise Failed(f"--secret-out may not be {path.name}")
    return path


def restrict_to_owner(path: Path) -> str:
    """Make the file readable by its owner only, as far as the platform allows; returns what was done.
    POSIX: mode 600 (verified). Windows has no modes, so the inherited permissions are removed and only the
    current user is granted access (icacls)."""
    if os.name == "nt":
        user = os.environ.get("USERNAME", "")
        domain = os.environ.get("USERDOMAIN", "")
        who = f"{domain}\\{user}" if domain and user else user
        if not who:
            raise Failed("could not work out the current Windows user to restrict the secret file to")
        done = subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"{who}:F"],
                              capture_output=True, text=True, timeout=30)
        if done.returncode != 0:
            raise Failed(f"icacls could not restrict the secret file (exit {done.returncode})")
        return "icacls: inheritance removed, full control for the current user only"
    os.chmod(path, 0o600)
    mode = os.stat(path).st_mode & 0o777
    if mode & 0o077:
        raise Failed(f"the secret file has mode {oct(mode)} after chmod 600")
    return f"mode {oct(mode)}"


def reserve_secret_file(path: Path, force: bool) -> None:
    """Create the (empty) secret file BEFORE the secret exists, exclusively and restricted, so a secret shown
    once always has somewhere safe to go. An existing file is refused unless --force."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() or path.is_symlink():
        if not force:
            raise Failed(f"{path} already exists; pass --force to replace it")
        path.unlink()
        say(f"secret file: replaced the existing {path.name} (--force)")
    os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
    say(f"secret file: created {path.name}, {restrict_to_owner(path)}")


def store_secret(path: Path, value: str) -> int:
    if not HEX64.fullmatch(value or ""):
        raise Failed(f"the secret Vocalis showed is not 64 hex characters (length {len(value or '')})")
    with open(path, "w", encoding="ascii", newline="\n") as handle:
        handle.write(value + "\n")
    return len(value)


# ---------------------------------------------------------------------------------------------------------
# Page helpers
# ---------------------------------------------------------------------------------------------------------

def get_json(c: Ctx, script: str, what: str) -> dict:
    got = c.page.evaluate(script)
    if got["status"] == 0:
        raise Failed(f"{what} {got.get('error') or 'failed'}")
    if got["status"] != 200 or not isinstance(got["body"], dict):
        raise Failed(f"{what} answered HTTP {got['status']}")
    return got["body"]


def login(page, base: str, secrets_dir: Path) -> None:
    page.goto(base + "/", wait_until="domcontentloaded")  # the login fetch below is relative to this origin
    ab.vocalis_login(page, base, ab.read_secret(secrets_dir, "vocalis-password"))
    page.wait_for_selector('#tabs button[data-tab="settings"]', timeout=30000)
    # The page's boot ends by switching to the tab the account last used (js/main.js sets __bootDone just before
    # it); a tab clicked earlier is switched away from again (seen October 10, 2026: Settings clicked, then the
    # page restored SillyTavern and the Devices controls were hidden).
    wait_until(page, "() => window.__bootDone === true", time.monotonic() + 60, "the page to finish booting")
    got = page.evaluate(DEVICES_JS)
    if got["status"] != 200:
        raise Failed(f"Vocalis login did not give a usable session (GET /devices: HTTP {got['status']} {got.get('error') or ''})".strip())


def open_tab(c: Ctx, tab: str) -> None:
    c.page.click(f'#tabs button[data-tab="{tab}"]')
    if tab == "settings":
        wait_until(c.page, """() => { const d = document.getElementById('devList'), s = document.getElementById('satList');
            return !!d && !!s && d.textContent.trim() !== 'detecting…' && s.textContent.trim() !== '—'; }""",
                   c.deadline(DEFAULT_WAIT_S), "the Settings device and satellite lists to load")
        if "could not read the device list" in c.page.inner_text("#devList"):
            raise Failed("Settings could not read the device list")


def calls_mark(c: Ctx) -> int:
    return c.page.evaluate("() => window.__calls.length")


def call_done(method: str, path_suffix: str, mark: int) -> str:
    """A page condition: a non-GET fetch to a path ending in `path_suffix` has completed since `mark`."""
    return (f"() => window.__calls.slice({mark}).some(x => x.done && x.method === '{method}' "
            f"&& x.url.endsWith({json.dumps(path_suffix)}))")


def call_status(c: Ctx, method: str, path_suffix: str, mark: int):
    return c.page.evaluate(f"""() => {{ const x = window.__calls.slice({mark}).find(x => x.done && x.method === '{method}'
        && x.url.endsWith({json.dumps(path_suffix)})); return x ? x.status : null; }}""")


def all_of(*arrows: str) -> str:
    """A page condition that is true when every given arrow-function condition is."""
    return "() => " + " && ".join(f"({a})()" for a in arrows)


def read_modal(page) -> dict:
    """The open dialog's title, buttons and (for anything but a secret dialog) its text."""
    return page.evaluate("""() => { const t = document.getElementById('mTitle').textContent;
        return {title: t, actions: [...document.querySelectorAll('#mActs button')].map(b => b.textContent),
                body: t.startsWith('Shared secret') ? '' : document.getElementById('mBody').innerText.trim().slice(0, 400)}; }""")


def press_modal(c: Ctx, label: str, deadline: float) -> None:
    c.page.locator("#mActs button", has_text=label).first.click()
    wait_until(c.page, f"() => !({OVERLAY_ON})", deadline, f"the '{label}' dialog to close")


def answered_since(c: Ctx, count: int, title: str) -> bool:
    return any(m["title"] == title for m in c.R["modals"][count:])


def pump(c: Ctx, done_js: str, what: str, deadline: float, device_id: str | None = None) -> None:
    """Wait for `done_js` (a page condition) while answering the dialogs a user would answer on the way. A dialog
    that reports an error fails the step with its text; one that is neither known nor an error fails naming it.
    `device_id` is the card being ticked or unticked, when there is one: the ACE-Step stop prompt is answered for
    a local card and is a failure for a satellite card."""
    while True:
        wait_until(c.page, f"() => ({OVERLAY_ON}) || ({done_js})()", deadline, what)
        if not c.page.evaluate(f"() => {OVERLAY_ON}"):
            return
        info = read_modal(c.page)
        title = info["title"]
        if title in MODAL_ERRORS:
            press_modal(c, "OK", deadline)
            raise Failed(f"Vocalis showed '{title}': {info['body']}")
        if title == "Stop ACE-Step on these cards?" and device_id and is_satellite_device(device_id):
            c.R["modals"].append({"title": title, "answered": "Cancel", "device": device_id})
            press_modal(c, "Cancel", deadline)
            raise Failed(f"Vocalis asked to stop ACE-Step while {device_id} was unticked; a satellite card cannot "
                         f"run ACE-Step, so this prompt must not appear for it: {info['body']}")
        label = MODAL_ANSWERS.get(title)
        if label is None or label not in info["actions"]:
            raise Failed(f"an unexpected dialog is open while waiting for {what}: '{title}' with buttons {info['actions']}")
        say(f"dialog '{title}' answered with '{label}'")
        c.R["modals"].append({"title": title, "answered": label})
        press_modal(c, label, deadline)


def expect_modal(c: Ctx, title: str, deadline: float) -> None:
    """Wait for one dialog that is certain to come (the "nothing is ticked" notice) and answer it."""
    wait_until(c.page, f"() => {OVERLAY_ON}", deadline, f"the '{title}' dialog")
    info = read_modal(c.page)
    if info["title"] != title:
        raise Failed(f"expected the '{title}' dialog, found '{info['title']}'")
    say(f"dialog '{title}' answered with '{MODAL_ANSWERS[title]}'")
    c.R["modals"].append({"title": title, "answered": MODAL_ANSWERS[title]})
    press_modal(c, MODAL_ANSWERS[title], deadline)


def devices_state(c: Ctx) -> dict:
    body = get_json(c, DEVICES_JS, "GET /devices")
    sats = body.get("satellites") or []
    devs = body.get("devices") or []
    return {"sat": next((s for s in sats if s.get("name") == c.name), None),
            "rows": [d for d in devs if d.get("satellite") == c.name],
            "local": [d for d in devs if not d.get("satellite")],
            "all": devs,
            "satellites": [s.get("name") for s in sats]}


def sat_summary(sat: dict | None) -> dict | None:
    if sat is None:
        return None
    return {"url": sat.get("url"), "reachable": bool(sat.get("reachable")), "error": sat.get("error") or "",
            "ready": bool(sat.get("ready")), "loading": bool(sat.get("loading")), "version": sat.get("version") or "",
            "certificate": sat.get("cert") or "", "pinned": bool(sat.get("verified")), "note": sat.get("note") or "",
            "secretSet": bool(sat.get("secret_set")), "vramCapGb": sat.get("vram_cap_gb"),
            "vramCapLive": sat.get("vram_cap_live"), "vramReservedGb": sat.get("vram_reserved_gb")}


def row_summary(rows: list) -> list:
    return [{"id": d.get("id"), "label": d.get("label"), "ticked": bool(d.get("enabled")), "workers": d.get("loaded"),
             "reachable": bool(d.get("reachable"))} for d in rows]


def require_satellite(c: Ctx) -> dict:
    st = devices_state(c)
    if st["sat"] is None:
        raise Failed(f"Vocalis has no satellite named '{c.name}' (it has: {st['satellites']})")
    return st


def sat_row(c: Ctx):
    return c.page.locator(f'#satList .satrow[data-name="{c.name}"]')


def set_tick(c: Ctx, device_id: str, want: bool, deadline: float) -> bool:
    """Tick or untick one device row through its own check box, wait for the page's save to land, and confirm
    from a fresh read that the saved tick is what was asked. Returns whether anything changed."""
    box = c.page.locator(f'#devList .dev[data-id="{device_id}"] .devchk')
    if box.count() != 1:
        raise Failed(f"the Devices list has no row for {device_id}")
    if box.is_checked() == want:
        say(f"tick {device_id}: already {'ticked' if want else 'unticked'}")
        return False
    mark = calls_mark(c)
    box.set_checked(want, timeout=15000)
    pump(c, call_done("PUT", "/devices", mark), f"the save after {'ticking' if want else 'unticking'} {device_id}",
         deadline, device_id)
    status = call_status(c, "PUT", "/devices", mark)
    if status != 200:
        raise Failed(f"the page's save of {device_id} answered HTTP {status}")
    saved = next((d for d in devices_state(c)["all"] if d.get("id") == device_id), None)
    if saved is None or bool(saved.get("enabled")) != want:
        raise Failed(f"after saving, Vocalis reports {device_id} as "
                     f"{'missing' if saved is None else ('ticked' if saved.get('enabled') else 'unticked')}, not "
                     f"{'ticked' if want else 'unticked'}")
    say(f"tick {device_id}: {'ticked' if want else 'unticked'}, saved (HTTP {status}) and confirmed")
    return True


def reconnect(c: Ctx, deadline: float) -> None:
    """The satellite row's reconnect button: tells the satellite to hold exactly the ticked cards. It is the
    page's explicit apply, pressed only when no tick changed. It is finished when the request has returned AND
    the button is back (the page restores it after the "Satellite not reachable" dialog is dismissed), so that
    dialog is always seen and fails the step with its text at once."""
    selector = f'#devList .devSync[data-sat="{c.name}"]'
    button = c.page.locator(selector).first
    if not button.count():
        raise Failed(f"the Devices list has no reconnect button for '{c.name}' (the satellite has no card rows yet)")
    mark = calls_mark(c)
    button.click()
    suffix = f"/satellites/{c.name}/reconnect"
    back = (f"() => {{ const b = document.querySelector({json.dumps(selector)}); "
            f"return !!b && !b.disabled && b.textContent.trim() === '⟳'; }}")
    pump(c, all_of(call_done("POST", suffix, mark), back), f"the reconnect of '{c.name}'", deadline)
    status = call_status(c, "POST", suffix, mark)
    say(f"reconnect '{c.name}': HTTP {status}")
    if status != 200:
        raise Failed(f"the reconnect of '{c.name}' answered HTTP {status}")


def wait_state(c: Ctx, mode: str, seconds: float) -> dict:
    """Wait, with a bounded deadline, until /devices says the satellite's cards are loaded or released."""
    started = time.monotonic()
    seen = c.page.evaluate(LOADED_JS, [c.name, mode, seconds])
    if seen is None:
        st = devices_state(c)
        raise Failed(f"timed out after {seconds:.0f} s waiting for '{c.name}' to be {mode}; last seen: "
                     f"{json.dumps({'satellite': sat_summary(st['sat']), 'rows': row_summary(st['rows'])})}")
    if seen.get("unreachable"):
        raise Failed(f"Vocalis reports '{c.name}' unreachable while waiting for it to be {mode}: {seen.get('error')}")
    say(f"'{c.name}' {mode} after {time.monotonic() - started:.1f} s: {json.dumps(seen)}")
    return seen


# ---------------------------------------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------------------------------------

def reveal_secret(c: Ctx, expected_title: str, secret_file: Path, deadline: float) -> None:
    """Read the secret out of the page's one-time dialog into the reserved file and dismiss the dialog. If
    anything fails after the file was written, the file is deleted before the failure is reported (unless
    --keep-on-failure): a secret whose dialog could not be closed cleanly is not to be left lying about."""
    written = False
    try:
        wait_until(c.page, f"() => {OVERLAY_ON} && document.getElementById('mTitle').textContent === {json.dumps(expected_title)}",
                   deadline, f"the '{expected_title}' dialog")
        value = c.page.locator("#mBody input[readonly]").input_value()
        length = store_secret(secret_file, value)
        written = True
        record_secret_file(c, secret_file)
        c.R["secretLength"] = length
        c.R["secretFile"] = str(secret_file)
        say(f"secret received ({length} characters) and written to {secret_file.name}")
        press_modal(c, "Done", deadline)
        # The page blanks the dialog body on the way out ("shown once has to mean GONE"); confirm it did.
        cleared = c.page.evaluate("() => !document.querySelector('#mBody input')")
        c.R["secretClearedFromPage"] = bool(cleared)
        if not cleared:
            raise Failed("the secret dialog was closed but its secret field is still in the page")
    except BaseException:
        if written:
            if c.args.keep_on_failure:
                say(f"secret file {secret_file.name} kept after a failure (--keep-on-failure)")
            else:
                secret_file.unlink(missing_ok=True)
                forget_secret_file(c, secret_file)
                c.R.pop("secretFile", None)
                say(f"secret file {secret_file.name} deleted after a failure")
        raise


def drop_empty_secret_file(path: Path) -> None:
    if path.exists() and path.stat().st_size == 0:
        path.unlink()
        say(f"secret file: removed the empty {path.name} (no secret was received)")


def cmd_add(c: Ctx) -> None:
    a = c.args
    if not a.url.startswith("https://"):
        raise Failed("--url must start with https://")
    path = secret_path(c)
    reserve_secret_file(path, a.force)
    try:
        open_tab(c, "settings")
        if sat_row(c).count():
            raise Failed(f"a satellite named '{c.name}' is already listed; run `remove` first")
        c.page.fill("#satName", c.name)
        c.page.fill("#satUrl", a.url)
        c.page.click("#satAdd")
        # Either the secret dialog opens or the page shows its error line.
        wait_until(c.page, f"""() => ({OVERLAY_ON}) || (document.getElementById('satErr').style.display !== 'none'
            && document.getElementById('satErr').textContent.trim() !== '')""", c.deadline(DEFAULT_WAIT_S),
                   "the secret dialog after Add satellite")
        if not c.page.evaluate(f"() => {OVERLAY_ON}"):
            raise Failed("Vocalis refused the satellite: " + c.page.inner_text("#satErr").strip()[:300])
        reveal_secret(c, f"Shared secret for {c.name}", path, c.deadline(DEFAULT_WAIT_S))
        wait_until(c.page, f"() => !!document.querySelector('#satList .satrow[data-name={json.dumps(c.name)}]')",
                   c.deadline(DEFAULT_WAIT_S), "the new satellite row")
        c.R["url"] = a.url
        c.R["rowText"] = re.sub(r"\s+", " ", sat_row(c).inner_text()).strip()[:400]
        say(f"satellite '{c.name}' added at {a.url}")
    finally:
        drop_empty_secret_file(path)


def cmd_new_secret(c: Ctx) -> None:
    a = c.args
    path = secret_path(c)
    reserve_secret_file(path, a.force)
    try:
        open_tab(c, "settings")
        require_satellite(c)
        sat_row(c).locator(".satRot").click()
        wait_until(c.page, f"() => ({OVERLAY_ON}) && document.getElementById('mTitle').textContent === "
                           f"{json.dumps(f'Generate a new secret for {c.name}?')}",
                   c.deadline(DEFAULT_WAIT_S), "the confirmation dialog")
        press_modal(c, "Generate", c.deadline(DEFAULT_WAIT_S))
        reveal_secret(c, f"Shared secret for {c.name}", path, c.deadline(DEFAULT_WAIT_S))
        st = devices_state(c)
        c.R["satellite"] = sat_summary(st["sat"])
    finally:
        drop_empty_secret_file(path)


def fingerprint_digits(text: str) -> str:
    return re.sub(r"[^0-9a-f]", "", str(text).lower())


def result_file_value(path: Path, key: str) -> str:
    """The value of `key` in a setup-result.txt (UTF-8 KEY=VALUE lines, as satellite-setup writes them), '' when absent.
    Only the fingerprint is ever read from it; the file never holds the secret."""
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() == key:
            return value.strip()
    return ""


def cmd_upload_cert(c: Ctx) -> None:
    a = c.args
    cert = Path(a.cert)
    if not cert.is_file():
        raise Failed(f"certificate file not found: {cert}")
    if bool(a.fingerprint) == bool(a.setup_result):
        raise Failed("give exactly one of --fingerprint and --setup-result")
    if a.setup_result:
        result_path = Path(a.setup_result)
        if not result_path.is_file():
            raise Failed(f"setup result file not found: {result_path}")
        a.fingerprint = result_file_value(result_path, "FINGERPRINT")
        if not a.fingerprint:
            raise Failed(f"{result_path.name} has no FINGERPRINT value")
        say(f"fingerprint read from {result_path.name} (FINGERPRINT key)")
    wanted = fingerprint_digits(a.fingerprint)
    if len(wanted) != 64:
        raise Failed(f"--fingerprint is not a SHA-256 fingerprint (got {len(wanted)} hex digits, need 64)")
    open_tab(c, "settings")
    require_satellite(c)
    mark = calls_mark(c)
    with c.page.expect_file_chooser(timeout=30000) as chooser:
        sat_row(c).locator(".satCert").click()
    chooser.value.set_files(str(cert))
    say(f"certificate {cert.name} handed to the page's file chooser")
    wait_until(c.page, f"() => ({OVERLAY_ON})", c.deadline(DEFAULT_WAIT_S), "the page's answer to the certificate upload")
    info = read_modal(c.page)
    status = call_status(c, "POST", f"/satellites/{c.name}/cert", mark)
    c.R["dialog"] = info["title"]
    if info["title"] != "Certificate pinned":
        press_modal(c, "OK", c.deadline(DEFAULT_WAIT_S))
        raise Failed(f"Vocalis did not pin the certificate (HTTP {status}): '{info['title']}': {info['body']}")
    shown = c.page.locator("#mBody pre.fp").inner_text().strip()
    press_modal(c, "OK", c.deadline(DEFAULT_WAIT_S))
    c.R["fingerprintShown"] = shown
    # Written as AA:BB:... so that it is also recognizably a fingerprint, not a 64-hex run, to the scrubber.
    expected = ":".join(wanted[i:i + 2] for i in range(0, 64, 2)).upper()
    c.R["fingerprintExpected"] = expected
    c.R["fingerprintMatches"] = fingerprint_digits(shown) == wanted
    say(f"fingerprint shown {shown}; expected {expected}; match: {c.R['fingerprintMatches']}")
    st = devices_state(c)
    c.R["satellite"] = sat_summary(st["sat"])
    if not c.R["fingerprintMatches"]:
        raise Failed(f"the fingerprint Vocalis shows ({shown}) is not the one given ({expected})")


def cmd_status(c: Ctx) -> None:
    want = c.args.expect
    open_tab(c, "settings")
    if c.args.timeout > 0:
        # Waits on the API's own answer, so a satellite that is coming back (Docker Desktop restarting) is
        # caught the moment Vocalis can reach it.
        started = time.monotonic()
        reached = c.page.evaluate(REACH_JS, [c.name, want, c.args.timeout])
        c.R["waitedSeconds"] = round(time.monotonic() - started, 1)
        say(f"waited {c.R['waitedSeconds']} s for '{c.name}' to be {want}: {'yes' if reached else 'no (time is up)'}")
    # Check now forces a fresh probe of every satellite; wait for its handler to return the button.
    c.page.click("#devRefresh")
    wait_until(c.page, "() => { const b = document.getElementById('devRefresh'); return !b.disabled && b.textContent.trim() === 'Check now'; }",
               c.deadline(DEFAULT_WAIT_S), "Check now to finish probing")
    st = require_satellite(c)
    sat = sat_summary(st["sat"])
    c.R["satellite"] = sat
    c.R["devices"] = row_summary(st["rows"])
    c.R["pageText"] = re.sub(r"\s+", " ", sat_row(c).inner_text()).strip()[:500]
    say(f"'{c.name}': reachable={sat['reachable']} ready={sat['ready']} loading={sat['loading']} "
        f"error={sat['error']!r} devices={json.dumps(c.R['devices'])}")
    if want == "reachable" and not sat["reachable"]:
        raise Failed(f"expected '{c.name}' to be reachable; Vocalis says: {sat['error'] or 'not running'}")
    if want == "unreachable" and sat["reachable"]:
        raise Failed(f"expected '{c.name}' to be unreachable, but Vocalis reports it running")


def saved_local_ticks(c: Ctx) -> list:
    return list(read_state(c).get(c.name, {}).get("previousLocalTicks") or [])


def cmd_load(c: Ctx) -> None:
    a = c.args
    deadline = c.deadline(a.timeout)
    open_tab(c, "settings")
    st = require_satellite(c)
    if not st["rows"]:
        raise Failed(f"'{c.name}' has no device rows yet: Vocalis has not reached it "
                     f"({st['sat'].get('error') or 'no error text'})")
    local_ticked = [d["id"] for d in st["local"] if d.get("enabled")]
    if a.only_satellite:
        # Written once: a non-empty saved list is never overwritten (a rerun sees the local cards already
        # unticked, and a partial list would lose a card for good).
        state = read_state(c)
        saved = state_entry(state, c.name).get("previousLocalTicks") or []
        if saved:
            say(f"local ticks already saved as {saved}; keeping them (currently ticked: {local_ticked})")
            c.R["previousLocalTicksKept"] = True
        elif local_ticked:
            state[c.name]["previousLocalTicks"] = local_ticked
            write_state(c, state)
            say(f"local ticks {local_ticked} saved in {STATE_NAME}")
            saved = local_ticked
        c.R["previousLocalTicks"] = saved
    c.R["previousSatelliteTicks"] = [d["id"] for d in st["rows"] if d.get("enabled")]
    say(f"before: local ticked {local_ticked}, satellite ticked {c.R['previousSatelliteTicks']}, "
        f"satellite rows {[d['id'] for d in st['rows']]}")
    # The satellite's cards first, so that unticking the local ones never leaves nothing ticked (which would raise
    # the CPU-fallback notice and ask the server to release satellite memory).
    changed = [set_tick(c, d["id"], True, deadline) for d in st["rows"]]
    if a.only_satellite:
        for device_id in local_ticked:
            set_tick(c, device_id, False, deadline)
    if any(changed):
        # The claim to prove: ticking alone loads. Nothing else is pressed.
        c.R["applied"] = "tick"
        say("applied by the tick alone; the reconnect button is not pressed")
    else:
        c.R["applied"] = "reconnect"
        say("no tick changed (a rerun); pressing the satellite row's reconnect button")
        reconnect(c, deadline)
    seen = wait_state(c, "loaded", max(deadline - time.monotonic(), 1))
    st = devices_state(c)
    c.R["ticked"] = [d["id"] for d in st["rows"] if d.get("enabled")]
    c.R["localTickedNow"] = [d["id"] for d in st["local"] if d.get("enabled")]
    c.R["devices"] = row_summary(st["rows"])
    c.R["satellite"] = sat_summary(st["sat"])
    c.R["seenWhenLoaded"] = seen


def cmd_unload(c: Ctx) -> None:
    deadline = c.deadline(c.args.timeout)
    open_tab(c, "settings")
    st = require_satellite(c)
    ticked = [d["id"] for d in st["rows"] if d.get("enabled")]
    others_ticked = [d["id"] for d in st["all"] if d.get("enabled") and d["id"] not in ticked]
    say(f"before: satellite ticked {ticked}, other devices ticked {others_ticked}")
    answered = len(c.R["modals"])
    changed = [set_tick(c, device_id, False, deadline) for device_id in ticked]
    if any(changed):
        # The page opens the "nothing is ticked" notice a moment after its save, so the answer may already have
        # been given by `pump` while it waited for the save; only wait for it when it has not.
        if not others_ticked and not answered_since(c, answered, "Rendering on the CPU now"):
            expect_modal(c, "Rendering on the CPU now", deadline)
        c.R["applied"] = "tick"
        say("applied by the tick alone; the reconnect button is not pressed")
    else:
        c.R["applied"] = "reconnect"
        say("no tick changed (a rerun); pressing the satellite row's reconnect button")
        reconnect(c, deadline)
    c.R["seenWhenReleased"] = wait_state(c, "released", max(deadline - time.monotonic(), 1))
    st = devices_state(c)
    c.R["unticked"] = ticked
    c.R["devices"] = row_summary(st["rows"])
    c.R["localTickedNow"] = [d["id"] for d in st["local"] if d.get("enabled")]


def cmd_restore_local(c: Ctx) -> None:
    source = c.args.from_file
    from_state = source is None
    if from_state:
        wanted = saved_local_ticks(c)
        if not wanted:
            raise Failed(f"{STATE_NAME} holds no saved local ticks for '{c.name}' (`load --only-satellite` writes them); "
                         f"pass --from RESULT.json to use a result file's list")
    else:
        try:
            wanted = json.loads(Path(source).read_text(encoding="utf-8")).get("previousLocalTicks")
        except (OSError, ValueError) as exc:
            raise Failed(f"cannot read {Path(source).name}: {type(exc).__name__}") from None
        if not isinstance(wanted, list):
            raise Failed(f"{Path(source).name} has no previousLocalTicks list (it is the result of `load`)")
    deadline = c.deadline(DEFAULT_WAIT_S)
    open_tab(c, "settings")
    st = devices_state(c)
    present = {d["id"] for d in st["local"]}
    missing = [d for d in wanted if d not in present]
    if missing:
        raise Failed(f"local cards {missing} recorded by load are not in the Devices list now ({sorted(present)})")
    say(f"restoring local ticks {wanted} (from {'the state file' if from_state else Path(source).name})")
    for device_id in wanted:
        set_tick(c, device_id, True, deadline)
    st = devices_state(c)
    c.R["restored"] = wanted
    c.R["localTickedNow"] = [d["id"] for d in st["local"] if d.get("enabled")]
    if sorted(c.R["localTickedNow"]) != sorted(wanted):
        raise Failed(f"after restoring, local ticks are {c.R['localTickedNow']} but {wanted} were recorded")
    if from_state:
        state = read_state(c)
        state_entry(state, c.name)["previousLocalTicks"] = []
        write_state(c, state)
        say("saved local ticks used and cleared from the state file")


def cmd_remove(c: Ctx) -> None:
    deadline = c.deadline(DEFAULT_WAIT_S)
    open_tab(c, "settings")
    st = devices_state(c)
    if st["sat"] is None:
        if not c.args.allow_absent:
            raise Failed(f"satellite '{c.name}' is not listed (pass --allow-absent if that is expected)")
        c.R["alreadyAbsent"] = True
        say(f"satellite '{c.name}' is not listed; nothing to remove (--allow-absent)")
    else:
        mark = calls_mark(c)
        sat_row(c).locator(".satDel").click()
        wait_until(c.page, f"() => ({OVERLAY_ON}) && document.getElementById('mTitle').textContent === {json.dumps(f'Remove {c.name}?')}",
                   deadline, "the Remove confirmation")
        press_modal(c, "Remove", deadline)
        wait_until(c.page, call_done("DELETE", f"/satellites/{c.name}", mark), deadline, "the DELETE to finish")
        status = call_status(c, "DELETE", f"/satellites/{c.name}", mark)
        if status != 200:
            raise Failed(f"removing '{c.name}' answered HTTP {status}")
        wait_until(c.page, f"() => !document.querySelector('#satList .satrow[data-name={json.dumps(c.name)}]')", deadline,
                   "the satellite row to disappear")
        st = devices_state(c)
        c.R["goneFromVocalis"] = st["sat"] is None and not st["rows"]
        c.R["remainingSatellites"] = st["satellites"]
        say(f"remove '{c.name}': HTTP {status}; satellites left: {st['satellites']}")
        if not c.R["goneFromVocalis"]:
            raise Failed(f"'{c.name}' is still listed after Remove")
    # The secret files this tool wrote for the name go with it (the paths are in the state file; never content).
    state = read_state(c)
    entry = state_entry(state, c.name)
    root = Path(c.args.secrets).resolve()
    deleted = []
    for recorded in entry.get("secretFiles") or []:
        target = Path(recorded)
        try:
            target.resolve().relative_to(root)
        except ValueError:
            say(f"state file lists {target.name} outside the secrets folder; left alone")
            continue
        if target.is_file() or target.is_symlink():
            target.unlink()
            deleted.append(target.name)
    entry["secretFiles"] = []
    write_state(c, state)
    c.R["secretFilesDeleted"] = deleted
    left = (read_state(c).get(c.name) or {}).get("previousLocalTicks")
    if left:
        c.R["savedLocalTicksStillInState"] = left
        say(f"note: saved local ticks {left} are still in {STATE_NAME}; run restore-local")
    say(f"secret files deleted: {deleted}")


def cmd_card_stats(c: Ctx) -> None:
    body = get_json(c, STATS_JS, "GET /system/stats")
    cards = [{"index": g.get("index"), "name": g.get("name"), "total_gb": g.get("total_gb"), "used_gb": g.get("used_gb"),
              "free_gb": g.get("free_gb"), "busy_pct": g.get("util_pct"), "temp_c": g.get("temp_c"),
              "power_w": g.get("power_w"), "fan_pct": g.get("fan_pct"), "vocalis_gb": g.get("vocalis_gb")}
             for g in body.get("gpus") or []]
    c.R["takenAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    c.R["cards"] = cards
    if not cards:
        raise Failed("the main server reports no cards")


STRIP_JS = """(name) => {
  const text = (el) => el ? el.textContent.trim() : null;
  return [...document.querySelectorAll('#vramCards .card')].map(card => {
    const key = card.dataset.g, cap = card.querySelector('.cap span');
    const read = (sel) => { const el = card.querySelector(sel); return el ? text(el) : null; };
    // The memory readout reads "<used> / <total> GB" (then the Vocalis share); it counts only as a VRAM readout
    // when both are numbers and the total is above zero.
    const mem = read('[data-r="cap"]') || '';
    const m = mem.match(/(\\d+(?:\\.\\d+)?)\\s*\\/\\s*(\\d+(?:\\.\\d+)?)\\s*GB/);
    const used = m ? parseFloat(m[1]) : null, total = m ? parseFloat(m[2]) : null;
    return {key, satellite: !!(name && key.startsWith(name + ':')),
      caption: text(cap), memory: mem, vramUsedGb: used, vramTotalGb: total,
      has: {vram: !!card.querySelector('.brow .bar') && used !== null && total !== null && total > 0,
            busy: !!card.querySelector('.upct'), temperature: !!card.querySelector('[data-r="temp"]'),
            power: !!card.querySelector('[data-r="pw"]'),
            clocks: !!(card.querySelector('[data-r="sclk"]') || card.querySelector('[data-r="mclk"]')),
            fan: !!card.querySelector('[data-r="fan"]')},
      values: {busy: read('.upct'), temperature: read('[data-r="temp"]'), power: read('[data-r="pw"]'),
               coreClock: read('[data-r="sclk"]'), memoryClock: read('[data-r="mclk"]'), fan: read('[data-r="fan"]')}};
  });
}"""


def cmd_strip(c: Ctx) -> None:
    a = c.args
    required = [r for r in (a.require or "").split(",") if r]
    bad = [r for r in required if r not in STRIP_READOUTS]
    if bad:
        raise Failed(f"--require names unknown readouts {bad}; choose from {list(STRIP_READOUTS)}")
    deadline = c.deadline(a.timeout)
    # The satellite's card appears only once the strip has been read and the satellite has answered a stats poll,
    # so this waits for the page's own strip to show it.
    try:
        c.page.wait_for_function("(name) => !!document.querySelector(`#vramCards .card[data-g^=\"${name}:\"]`)",
                                 arg=c.name, timeout=max(deadline - time.monotonic(), 0.001) * 1000)
        # Sensor numbers are written a moment after the card is built; give them the remaining bounded time.
        c.page.wait_for_function("""(name) => { const cards = [...document.querySelectorAll(`#vramCards .card[data-g^="${name}:"]`)];
            return cards.length > 0 && cards.every(card => { const m = card.querySelector('[data-r="cap"]');
              return m && m.textContent.trim() !== '' && [...card.querySelectorAll('.ustat')].every(s => s.textContent.trim() !== ''); }); }""",
                                 arg=c.name, timeout=max(min(deadline - time.monotonic(), 8), 0.001) * 1000)
    except PlaywrightTimeout:
        pass  # recorded below from what the strip shows; the assertion is made on that, not on the wait
    rows = c.page.evaluate(STRIP_JS, c.name)
    mine = [r for r in rows if r["satellite"]]
    stats = get_json(c, STATS_JS, "GET /system/stats")
    sample = next((s for s in stats.get("satellites") or [] if s.get("name") == c.name), None)
    # The name readout: the stats sample must carry a non-empty CARD name for the strip's row, and the row's
    # caption must show that card name (the satellite's own name is in every caption and proves nothing).
    cards = {f"{c.name}:{g.get('device')}": str(g.get("name") or "").strip() for g in (sample or {}).get("gpus") or []}
    for r in mine:
        card_name = cards.get(r["key"], "")
        r["cardName"] = card_name
        r["has"]["name"] = bool(card_name) and card_name in (r["caption"] or "")
    c.R["stripCards"] = [{"key": r["key"], "caption": r["caption"]} for r in rows]
    c.R["satelliteCards"] = mine
    c.R["statsSample"] = sample
    say(f"strip: {len(rows)} card rows, {len(mine)} for '{c.name}': "
        f"{json.dumps([{'key': r['key'], 'has': r['has']} for r in mine])}")
    if not mine:
        raise Failed(f"the header strip has no row for a card of '{c.name}' (rows: {[r['key'] for r in rows]})")
    for want in required:
        absent = [r["key"] for r in mine if not r["has"][want]]
        if absent:
            raise Failed(f"the strip row(s) {absent} of '{c.name}' lack the required readout '{want}'")


PLAUSIBLE_CHARS_PER_SECOND = 60  # speech runs roughly 12-18 characters per second; this only catches an empty clip
BATCH_LABEL = re.compile(r"\[batch of (\d+)\]")


def cmd_render(c: Ctx) -> None:
    a = c.args
    text = Path(a.text_file).read_text(encoding="utf-8")
    chars = len(text)
    if not text.strip():
        raise Failed(f"{a.text_file} is empty")
    deadline = c.deadline(a.timeout)
    open_tab(c, "playground")
    st = devices_state(c)
    c.R["enabledDevices"] = [d["id"] for d in st["local"] + st["rows"] if d.get("enabled")]
    c.R["textCharacters"] = chars
    say(f"render: {chars} characters; devices enabled: {c.R['enabledDevices']}")
    page = c.page
    original = page.evaluate("() => ({text: document.getElementById('pgText').value, enhance: document.getElementById('pgEnh').checked, "
                             "enhanceDisabled: document.getElementById('pgEnh').disabled})")
    try:
        page.fill("#pgText", text)
        # Enhancement runs afterwards on this machine's own cards; the point here is the satellite's render.
        if original["enhance"] and not original["enhanceDisabled"]:
            page.set_checked("#pgEnh", False)
        c.R["enhance"] = False
        page.evaluate("() => { window.__events.length = 0; }")
        started = time.monotonic()
        page.click("#pgGen", timeout=15000)
        terminal = "() => window.__events.some(e => e.type === 'job_done' || e.type === 'error' || e.type === 'canceled')"
        pump(c, terminal, "the render to finish", deadline)
        seconds = round(time.monotonic() - started, 1)
        events = page.evaluate("() => window.__events.slice()")
    finally:
        # Put the editor back as it was (the page saves both as account state).
        page.evaluate("""(o) => { const t = document.getElementById('pgText'); t.value = o.text; t.dispatchEvent(new Event('input', {bubbles: true}));
            t.dispatchEvent(new Event('blur')); const e = document.getElementById('pgEnh');
            if (!o.enhanceDisabled && e.checked !== o.enhance) e.click(); }""", original)
    done = next((e for e in events if e["type"] == "job_done"), None)
    problems = [e for e in events if e["type"] in ("error", "canceled", "chunk_failed", "device_dropped")]
    chunk_done = [e for e in events if e["type"] == "chunk_done"]
    devices = sorted({str(e.get("device")) for e in chunk_done})
    distinct = len({e.get("chunk") for e in chunk_done})
    # The batch size is not a field of the job's events; the chunk_done event's `log` line (the one the server
    # writes to its own log) ends in "[batch of N]" for a chunk rendered in a batch of N on a satellite, and has
    # no such label for a chunk rendered alone. The records keep the per-chunk device and times so they can also
    # be matched against the satellite's own log.
    records = []
    for e in sorted(chunk_done, key=lambda e: e["__t"]):
        found = BATCH_LABEL.search(e.get("log") or "")
        stats = e.get("stats") or {}
        records.append({"chunk": e.get("chunk"), "device": e.get("device"), "batchOf": int(found.group(1)) if found else None,
                        "renderSeconds": stats.get("s"), "audioPerSecond": stats.get("render"),
                        "doneAt": datetime.fromtimestamp(e["__t"] / 1000).isoformat(timespec="milliseconds")})
    c.R["renderSeconds"] = seconds
    c.R["chunksRendered"] = distinct
    c.R["chunksTotal"] = max([e.get("total") or 0 for e in chunk_done + [e for e in events if e["type"] == "chunk_start"]] or [0])
    c.R["devicesUsed"] = devices
    c.R["chunkRecords"] = records
    c.R["batchSizeInEvents"] = any(r["batchOf"] for r in records)
    c.R["problemEvents"] = [{"type": e["type"], "device": e.get("device"), "reason": e.get("reason"),
                             "message": scrub(e.get("message") or "")[:300]} for e in problems]
    say(f"render finished in {seconds} s: chunks {distinct}/{c.R['chunksTotal']} on {devices}; "
        f"batch labels {[r['batchOf'] for r in records]}; problem events: {len(problems)}")
    if any(e["type"] in ("error", "canceled") for e in problems) or done is None:
        raise Failed("the render did not finish: " + json.dumps(c.R["problemEvents"]))
    duration = float(done.get("duration_s") or 0)
    c.R["audioSeconds"] = round(duration, 2)
    clip = done.get("clip") or ""
    got = page.evaluate("async (ref) => { " + TF + """
        try { const r = await tf('/playground/clips/' + ref.split('/').map(encodeURIComponent).join('/') + '/audio', 60000);
          const b = r.ok ? await r.arrayBuffer() : null;
          return {status: r.status, type: r.headers.get('content-type'), bytes: b ? b.byteLength : 0}; }
        catch (e) { return {status: 0, type: null, bytes: 0, error: why(e)}; } }""", clip)
    c.R["clip"] = {"ref": clip, "httpStatus": got["status"], "contentType": got["type"], "bytes": got["bytes"]}
    need = max(0.5, chars / PLAUSIBLE_CHARS_PER_SECOND)
    say(f"audio: {duration:.1f} s, clip {got['bytes']} bytes (HTTP {got['status']}, {got['type']}); at least {need:.1f} s expected")
    if got["status"] != 200 or got["bytes"] < 1000:
        raise Failed(f"no audio was produced: the clip answered HTTP {got['status']} with {got['bytes']} bytes"
                     + (f" ({got['error']})" if got.get("error") else ""))
    if duration < need:
        raise Failed(f"the clip is {duration:.1f} s for {chars} characters, shorter than the {need:.1f} s that even fast speech needs")
    # A resumed render only renders the chunks that were missing, so it can pass with fewer chunks than the
    # text has; unless that is wanted, the run must have rendered every chunk of the job itself.
    if distinct != c.R["chunksTotal"] and not a.allow_resume:
        raise Failed(f"this run rendered {distinct} of the job's {c.R['chunksTotal']} chunks (a resumed render?); "
                     f"change the text, or pass --allow-resume")
    if a.expect_chunks_min is not None and distinct < a.expect_chunks_min:
        raise Failed(f"{distinct} chunks were rendered, expected at least {a.expect_chunks_min}")
    if not a.allow_local:
        off = [d for d in devices if not d.startswith(c.name + ":")]
        if off or not devices:
            raise Failed(f"chunks were rendered on {devices}, expected only cards of '{c.name}' (--allow-local permits others)")
    if a.expect_batch:
        if c.R["chunksTotal"] < 3:
            raise Failed(f"--expect-batch needs a text of at least 3 chunks; this one made {c.R['chunksTotal']}")
        batched = [r for r in records if (r["batchOf"] or 0) >= 2 and str(r["device"]).startswith(c.name + ":")]
        c.R["batchedChunksOnSatellite"] = len(batched)
        if not batched:
            raise Failed("no chunk was rendered on the satellite as part of a batch of 2 or more; labels seen: "
                         f"{[(r['device'], r['batchOf']) for r in records]}")


COMMANDS = {"add": cmd_add, "new-secret": cmd_new_secret, "upload-cert": cmd_upload_cert, "status": cmd_status,
            "load": cmd_load, "render": cmd_render, "strip": cmd_strip, "card-stats": cmd_card_stats,
            "unload": cmd_unload, "restore-local": cmd_restore_local, "remove": cmd_remove}


# ---------------------------------------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--vocalis", required=True, help="base URL of the Vocalis under test")
    common.add_argument("--secrets", required=True, type=Path, help="folder holding vocalis-password; secret files and the state file live here")
    common.add_argument("--name", help="the satellite's name in Vocalis (every subcommand but card-stats)")
    common.add_argument("--out", required=True, type=Path, help="result JSON path")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("add", parents=[common], help="add the satellite; write its one-time secret to a file")
    p.add_argument("--url", required=True, help="https://IP:PORT the satellite answers on")
    p.add_argument("--secret-out", required=True, type=Path, help="inside --secrets")
    p.add_argument("--force", action="store_true", help="replace an existing secret file")
    p.add_argument("--keep-on-failure", action="store_true", help="keep the secret file if the dialog could not be dismissed cleanly")

    p = sub.add_parser("new-secret", parents=[common], help="press New secret... and write the new secret to a file")
    p.add_argument("--secret-out", required=True, type=Path, help="inside --secrets")
    p.add_argument("--force", action="store_true", help="replace an existing secret file")
    p.add_argument("--keep-on-failure", action="store_true", help="keep the secret file if the dialog could not be dismissed cleanly")

    p = sub.add_parser("upload-cert", parents=[common], help="upload the certificate; the fingerprint shown must match")
    p.add_argument("--cert", required=True, type=Path)
    p.add_argument("--fingerprint", help="AA:BB:... as the setup script printed it")
    p.add_argument("--setup-result", type=Path, help="alternative to --fingerprint: the setup-result.txt whose FINGERPRINT key is the expected value")

    p = sub.add_parser("status", parents=[common], help="record what Vocalis reports about the satellite")
    p.add_argument("--expect", required=True, choices=["reachable", "unreachable"], help="fail unless Vocalis reports this")
    p.add_argument("--timeout", type=float, default=0, help="wait up to this many seconds for the expected state")

    p = sub.add_parser("load", parents=[common], help="tick the satellite's cards and wait for them to load")
    p.add_argument("--only-satellite", action="store_true", help="first untick every local card (saved in the state file)")
    p.add_argument("--timeout", type=float, default=LOAD_S)

    p = sub.add_parser("render", parents=[common], help="render a text in the Playground")
    p.add_argument("--text-file", required=True, type=Path)
    p.add_argument("--expect-chunks-min", type=int)
    p.add_argument("--expect-batch", action="store_true",
                   help="require a chunk rendered on the satellite in a batch of 2 or more (needs a text of 3+ chunks)")
    p.add_argument("--allow-local", action="store_true", help="do not require every chunk to run on the satellite's cards")
    p.add_argument("--allow-resume", action="store_true", help="accept a resumed render that rendered fewer chunks than the text has")
    p.add_argument("--timeout", type=float, default=RENDER_S)

    p = sub.add_parser("strip", parents=[common], help="record the header strip's rows for the satellite's cards")
    p.add_argument("--require", help="comma list of readouts that must be present: " + ",".join(STRIP_READOUTS))
    p.add_argument("--timeout", type=float, default=STRIP_S)

    sub.add_parser("card-stats", parents=[common], help="record the main server's own per-card readings")

    p = sub.add_parser("unload", parents=[common], help="untick the satellite's cards and wait for release")
    p.add_argument("--timeout", type=float, default=UNLOAD_S)

    p = sub.add_parser("restore-local", parents=[common], help="re-tick the local cards recorded by load --only-satellite")
    p.add_argument("--from", dest="from_file", type=Path, help="override: a result file `load` wrote (default: the state file)")

    p = sub.add_parser("remove", parents=[common], help="remove the satellite, confirm it is gone, delete its secret files")
    p.add_argument("--allow-absent", action="store_true", help="succeed when the name is not listed")
    return parser


def run(args) -> int:
    started = time.monotonic()
    result: dict = {"command": args.command, "satellite": (args.name or "").strip().lower() or None, "vocalis": args.vocalis,
                    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "passed": False, "failure": None}
    code = 1
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=["--mute-audio", "--autoplay-policy=no-user-gesture-required"])
            try:
                context = browser.new_context(ignore_https_errors=False)
                context.add_init_script(HOOKS)
                page = context.new_page()
                login(page, args.vocalis.rstrip("/"), args.secrets)
                COMMANDS[args.command](Ctx(page, args.vocalis.rstrip("/"), args, result))
                result["passed"], result["failure"], code = True, None, 0
            finally:
                browser.close()
    except Failed as exc:
        result["failure"] = scrub(exc)
        say("FAILED: " + result["failure"])
    except Exception as exc:  # noqa: BLE001 - anything else is recorded as this step's failure, scrubbed
        result["failure"] = scrub(f"{type(exc).__name__}: {str(exc)[:400]}")
        say("FAILED: " + result["failure"])
    result["seconds"] = round(time.monotonic() - started, 1)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(json.loads(scrub(json.dumps(result))), indent=1), encoding="utf-8")
    return code


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - a stdout that cannot be reconfigured is only a console-encoding nuisance
        pass
    parser = build_parser()
    args = parser.parse_args()
    if args.command != "card-stats" and not (args.name or "").strip():
        parser.error(f"{args.command} needs --name")
    if args.command == "card-stats":
        # Prints nothing but the result path, so a caller can capture it directly.
        with contextlib.redirect_stdout(io.StringIO()):
            code = run(args)
        print(args.out)
        return code
    code = run(args)
    say(f"results: {args.out}")
    return code


if __name__ == "__main__":
    sys.exit(main())
