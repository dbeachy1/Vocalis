"""Read sustained wall-power and battery status from the configured UPS through NUT.

The value comes from an integer load percentage multiplied by the UPS rating, so displayed wattage
has 15 W resolution for a 1500 W unit. This is a sustained reading, not a peak: NUT refreshes it
on its own schedule. Zero load means the UPS output is not powering the running server, so omit
the segment instead of reporting an outage from an idle or disconnected unit.

Two ways to reach NUT, chosen by `VOCALIS_UPS`:

- `VOCALIS_UPS` unset, or just a name (`cyberpower`): the local `upsc` program, as always. This is the natively
  installed Vocalis on a machine that runs NUT.
- `VOCALIS_UPS=name@host` or `name@host:port` (or `@host` to take the first UPS that server lists): Vocalis speaks
  NUT's own network protocol to that server (`upsd`, port 3493 by default). Added October 11, 2026 for the Docker
  package, where the readout had silently gone: the image has no `upsc`, so the poller never started, and a
  container cannot run the host's. Nothing needs installing in the image this way, and the UPS can be on another
  machine. The server must listen on an address the container can reach; `upsd` often listens on 127.0.0.1 only.
"""
import os
import shutil
import socket
import subprocess
import threading
import time

from loguru import logger

#: Poll every 5 seconds. NUT refreshes the integer load percentage less frequently, so a faster
#: poll would mostly repeat the same value and add unnecessary requests.
POLL_S = 5.0

#: A reading older than this is not shown at all.
#:
#: Allow a brief USB disconnect during a UPS battery self-test while still hiding stale readings
#: promptly if the device remains unavailable.
STALE_S = 30.0

#: Fields the header cannot be drawn without. Any one missing hides the segment — a UPS that
#: answers `upsc` but not with these is a model this display was not written for, and inventing
#: a dash for the gap would be worse than the line not being there.
REQUIRED = ("ups.status", "ups.load", "battery.charge", "battery.runtime", "input.voltage")

#: Fallback rating in watts for units that do not publish `ups.realpower.nominal`.
NOMINAL_W_DEFAULT = 1500

#: Amber threshold as a proportion of the UPS rating rather than a fixed wattage.
WARN_LOAD_PCT = 85

_LOCK = threading.Lock()
_CACHE: dict = {"t": None, "fields": None}     # t is monotonic; fields is the last good parse
_NAME: list = []                               # the UPS's name in NUT, resolved once
_THREAD: list = []
_STOP = threading.Event()
#: Consecutive failed reads. Logged on the first one and then every 100th, same as power.py's
#: counters: a segment that silently vanishes is indistinguishable from a box that never had a
#: UPS, and the log line is the only evidence when the device is unavailable.
_FAILS = [0]

#: Highest wattage observed by the background poller since this process started. Sampling in the
#: poller preserves readings when no browser is open. This process-lifetime value resets on restart.
_PEAK = [None]


#: NUT's registered port.
NUT_PORT = 3493


def _target():
    """`VOCALIS_UPS` taken apart: (name or None, host or None, port). No host means the local `upsc` program."""
    raw = (os.environ.get("VOCALIS_UPS") or "").strip()
    name, at, where = raw.partition("@")
    if not at:
        return (name or None, None, NUT_PORT)
    host, colon, port = where.strip().rpartition(":")
    # A port is one to five plain digits naming 1 to 65535; anything else after the last colon is part of the host.
    if not colon or not (port.isascii() and port.isdigit() and len(port) <= 5 and 1 <= int(port) <= 65535):
        host, port = where.strip(), str(NUT_PORT)
    return (name.strip() or None, host.strip("[]") or None, int(port))


def _number(text) -> float:
    """A reading as a finite number. Raises ValueError for anything else, including "nan" and "inf", which
    `float()` accepts and which would otherwise travel into rounding and the page."""
    value = float(text)
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"not a finite number: {text!r}")
    return value


def _nominal_w(fields) -> float:
    """The unit's rating in watts as it reports it, or the fallback when it reports none or nonsense."""
    try:
        rating = _number(fields.get("ups.realpower.nominal", NOMINAL_W_DEFAULT))
    except (ValueError, TypeError):
        return float(NOMINAL_W_DEFAULT)
    return rating if rating > 0 else float(NOMINAL_W_DEFAULT)


def source_text() -> str:
    """Where readings come from, for the log: the server's address, or the `upsc` program."""
    _name, host, port = _target()
    return f"NUT server {host}:{port}" if host else "upsc"


def _unquote(text: str) -> str:
    """The value of a NUT protocol line: in double quotes, with `\\"` and `\\\\` escaped."""
    text = text.strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        text = text[1:-1]
    out, escaped = [], False
    for ch in text:
        if escaped:
            out.append(ch)
            escaped = False
        elif ch == "\\":
            escaped = True
        else:
            out.append(ch)
    return "".join(out)


def _network_exchange(host, port, name, timeout):
    """Ask a NUT server for one UPS's variables. Returns (name, fields), or None for any failure.

    The protocol is plain text lines. `LIST UPS` answers `UPS <name> "<description>"` lines and is used only when no
    name was configured (the first one listed is taken, as `upsc -l` does locally). `LIST VAR <name>` answers
    `VAR <name> <variable> "<value>"` lines between `BEGIN LIST VAR` and `END LIST VAR`; an answer that does not
    reach its END line is not a reading. Reading variables needs no login on a NUT server. One connection per poll,
    closed with LOGOUT: the server is small and a poll is every five seconds."""
    try:
        with socket.create_connection((host, port), timeout=timeout) as conn:
            conn.settimeout(timeout)
            stream = conn.makefile("rwb")
            # One limit for the whole exchange as well as for each read: a server that sends a byte every few seconds
            # must not hold a poll open for ever.
            deadline = time.monotonic() + timeout

            def ask(command, end):
                stream.write((command + "\n").encode("ascii", "replace"))
                stream.flush()
                lines = []
                for _ in range(4000):                           # a UPS has about a hundred variables
                    left = deadline - time.monotonic()
                    if left <= 0:
                        return None
                    conn.settimeout(left)
                    raw = stream.readline(65536)
                    if not raw:
                        return None                             # the server closed before the END line
                    line = raw.decode("utf-8", "replace").rstrip("\r\n")
                    if line.startswith("ERR"):
                        return None
                    if line.startswith(end):
                        return lines
                    lines.append(line)
                return None

            if not name:
                listed = ask("LIST UPS", "END LIST UPS")
                for line in listed or []:
                    parts = line.split(" ", 2)
                    if len(parts) >= 2 and parts[0] == "UPS" and parts[1]:
                        name = parts[1]
                        break
                if not name:
                    return None
            answer = ask(f"LIST VAR {name}", "END LIST VAR")
            try:
                stream.write(b"LOGOUT\n")
                stream.flush()
            except OSError:
                pass
            if answer is None:
                return None
            fields = {}
            for line in answer:
                parts = line.split(" ", 3)
                if len(parts) == 4 and parts[0] == "VAR":
                    fields[parts[2]] = _unquote(parts[3])
            return (name, fields)
    except (OSError, ValueError):
        return None


def _ups_name():
    """The UPS's name in NUT — the name in `VOCALIS_UPS` if set, else whatever `upsc -l` (or the server) lists first.

    Discovered rather than hardcoded so this survives a UPS swap and works on a box that
    called its section something other than `cyberpower`. Cached once found, NOT cached
    empty: at boot this can easily run before `nut-driver@.service` has finished starting,
    and a name cached as None then would keep the segment dark until the next restart.
    """
    if _NAME:
        return _NAME[0]
    env, host, port = _target()
    if env:
        _NAME.append(env)
        return env
    if host:
        found = _network_exchange(host, port, None, 3)
        if found and found[0]:
            _NAME.append(found[0])
            return found[0]
        return None
    try:
        p = subprocess.run(["upsc", "-l"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=3)
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode != 0:
        return None
    for line in p.stdout.splitlines():
        name = line.strip()
        if name:
            _NAME.append(name)
            return name
    return None


def read_ups(name=None, timeout=3):
    """Return parsed NUT variables, or None when the device cannot be read.

    Parse stdout only. Some NUT builds write informational SSL setup messages to stderr, which
    must not be merged into the variable stream.

    All read failures produce the same display behavior: hide the segment.
    """
    name = name or _ups_name()
    if not name:
        return None
    _configured, host, port = _target()
    if host:
        got = _network_exchange(host, port, name, timeout)
        return (got[1] or None) if got else None
    try:
        p = subprocess.run(["upsc", name], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None                                  # no binary, no upsd, or it hung
    if p.returncode != 0:
        return None
    fields = {}
    for line in p.stdout.splitlines():
        key, sep, val = line.partition(": ")
        if sep:
            fields[key.strip()] = val.strip()
    return fields or None


def _derive_w(fields):
    """Derive watts from the reported load percentage and nominal rating.

    NUT may report the rating without a live wattage field. Using the device's published rating
    allows the calculation to adapt when the UPS is replaced.
    """
    try:
        load = _number(fields["ups.load"])
    except (KeyError, ValueError, TypeError):
        return None
    return round(load / 100.0 * _nominal_w(fields))


def _status_token(raw):
    """Return the highest-priority status token from NUT's space-separated status list.

    `LB` outranks `OB`, which outranks `OL`; charging and discharging qualify a state but do not
    compete for the header's single status slot. `RB` is reported separately by `snapshot()`.
    """
    toks = set((raw or "").split())
    for t in ("LB", "OB", "OL"):
        if t in toks:
            return t
    return None


def sample_once():
    """Read the UPS and cache what came back. Returns the fields, or None.

    The cache holds the LAST GOOD parse and its timestamp, and a failed read does not clear
    it — `snapshot` ages it out via STALE_S instead. That is what rides over the USB dropout
    during a battery self-test without the segment flickering; a read that fails twice in a
    row for thirty seconds still goes dark, which is the case that matters.
    """
    fields = read_ups()
    if fields is None:
        _FAILS[0] += 1
        if _FAILS[0] == 1 or _FAILS[0] % 100 == 0:
            logger.info(f"ups: no reading from {source_text()} (failure #{_FAILS[0]}) — segment hidden")
        return None
    if _FAILS[0]:
        logger.info(f"ups: reading again after {_FAILS[0]} failed poll(s)")
        _FAILS[0] = 0
    with _LOCK:
        _CACHE.update(t=time.monotonic(), fields=fields)
        _record_peak(fields)
    return fields


def _record_peak(fields):
    """Fold one eligible reading into `_PEAK`. Called under `_LOCK`, from the poller only.

    Apply the same required-field and positive-load checks as `snapshot()` so an unrelated or
    non-powering UPS cannot set the displayed peak.
    """
    if any(k not in fields for k in REQUIRED):
        return
    w = _derive_w(fields)
    if w is None or w <= 0:
        return                                       # 0 W is "not our UPS", never a peak
    if _PEAK[0] is None or w > _PEAK[0]:
        _PEAK[0] = w


def snapshot():
    """Return the UPS values for the header, or None when the reading is unavailable or stale.

    Hide the segment when there is no valid reading, required fields are missing, load is invalid,
    or the UPS reports zero load. At zero load, runtime estimates describe a unit that is not
    powering this server and would be misleading beside the wattage.
    """
    with _LOCK:
        t, fields, peak_w = _CACHE["t"], _CACHE["fields"], _PEAK[0]
    if t is None or fields is None:
        return None
    age = time.monotonic() - t
    if age > STALE_S:
        return None
    if any(k not in fields for k in REQUIRED):
        return None
    try:
        load = int(_number(fields["ups.load"]))
        batt = int(_number(fields["battery.charge"]))
        runtime_s = int(_number(fields["battery.runtime"]))
        volts = _number(fields["input.voltage"])
    except (ValueError, TypeError):
        return None                                  # includes "nan" and "inf": this builds the whole hardware strip
    if load <= 0:
        return None                                  # the UPS is not powering this server
    status = _status_token(fields.get("ups.status"))
    if status is None:
        return None                                  # a status with no state token in it at all
    w = _derive_w(fields)
    # The worst draw any poll has seen since the process started, printed beside the live figure
    # so a spike nobody was watching for is still on record.
    # Keep the peak at least as high as the current reading in case this snapshot runs before the
    # poller has recorded it.
    peak = w if peak_w is None else (w if w is not None and w > peak_w else peak_w)
    return {"status": status,
            "load_pct": load,
            "w": w,
            "peak_w": peak,
            "batt_pct": batt,
            "runtime_s": runtime_s,
            "input_v": round(volts, 1),
            # For the tooltip. `nominal_w` is what the watts figure was derived FROM, and it is
            # sent rather than assumed so the UI never has to hardcode the rating either.
            "nominal_w": int(_nominal_w(fields)),
            # Sent for the same reason as `nominal_w`: the header decides its own amber off this
            # rather than off a literal 85 typed into the JS, so the threshold has ONE home. A
            # copy in the stylesheet's language is a copy that drifts.
            "warn_pct": WARN_LOAD_PCT,
            "model": fields.get("device.model") or fields.get("ups.model"),
            # Qualifiers that do not get the status slot but are worth a sentence: a UPS on
            # mains with a partly-charged battery is CHRG, and RB means the battery is done.
            "charging": "CHRG" in (fields.get("ups.status") or "").split(),
            "replace_batt": "RB" in (fields.get("ups.status") or "").split(),
            "age_s": round(age, 1)}


def _available() -> bool:
    """Is there an `upsc` on this box at all? The one condition that stops the poller starting.

    Unlike `power.start`'s `/sys` check this is a PATH lookup, and it is deliberately the only
    thing checked here. A UPS that is unplugged, an `upsd` that is down or a driver that has
    not come up yet must NOT stop the thread — all three are states the box recovers from
    without a restart, and a poller that had given up would leave the segment dark until
    somebody noticed. Only "NUT was never installed" is static enough to decide on once.

    A NUT server named in `VOCALIS_UPS` (`name@host`) is asked directly and needs no `upsc`: naming one is the
    owner saying there is a UPS, and a server that is down for now is one of the states above.
    """
    return _target()[1] is not None or shutil.which("upsc") is not None


def _loop(interval):
    """Poll forever. Never dies, never bursts.

    Paced against the clock and RESYNCED rather than caught up when it falls behind, for the
    reason power.py's `_loop` documents at length: repaying missed ticks back-to-back is a
    burst, and here it would mean several `upsc` forks landing in the same instant against a
    daemon that is explicitly not built to be hammered. A gap in the series is honest.

    Every exception is swallowed. A poller that dies on one bad read leaves the header frozen
    on a stale figure, which is the failure this whole file is arranged to avoid.
    """
    nxt = time.monotonic()
    announced = False
    while not _STOP.is_set():
        try:
            fields = sample_once()
            # Log the first successful poll so the server log distinguishes a working poller
            # from a segment that is correctly hidden by snapshot validation.
            if fields is not None and not announced:
                announced = True
                snap = snapshot()
                logger.info(f"ups: {fields.get('device.model', '?')} on "
                            f"{_NAME[0] if _NAME else '?'} — status "
                            f"{fields.get('ups.status', '?')}, load {fields.get('ups.load', '?')}%"
                            + (f", {snap['w']} W" if snap else " (segment hidden — see snapshot)"))
        except Exception:                                      # noqa: BLE001
            pass
        nxt += interval
        now = time.monotonic()
        if nxt < now - interval:
            nxt = now + interval          # `now + interval`, not `now` — see power.py's note
        _STOP.wait(max(0.0, nxt - now))


def start(interval=POLL_S):
    """Start the poller once. Returns the thread, or None where there is no `upsc` to run.

    Called from main(), NOT create_app(), for the reason power.start() gives: the suite builds
    hundreds of apps and not one of them should fork a subprocess against the host's UPS.
    """
    if not _available():
        return None
    with _LOCK:
        if _THREAD:
            return _THREAD[0]
        _STOP.clear()
        t = threading.Thread(target=_loop, args=(interval,), daemon=True, name="ups-poller")
        _THREAD.append(t)
    t.start()
    return t


def stop(timeout=2.0):
    """Stop the poller and forget it. For the suite; production never calls it."""
    _STOP.set()
    with _LOCK:
        threads, _THREAD[:] = list(_THREAD), []
    for t in threads:
        t.join(timeout=timeout)
