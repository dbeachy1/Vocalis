"""The UPS reader emits a status line only when a fresh NUT sample is complete and meaningful.

`ups.status: OB` alone does not prove the unit is powering a load: a zero-load, zero-output sample must be suppressed. Missing NUT services or devices, stale or incomplete samples, and command failures also produce no line rather than fabricated values.

The fixtures are synthetic protocol examples for these cases and for derived live and peak readings.
"""
import subprocess

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from vocalis.runtime import ups


#: Synthetic NUT fields for a unit reporting on-battery status with output switched off and the
#: battery full. The `OB` status with zero load and output voltage must not produce a line.
#: Only fields used by these tests are included.
BENCH_DUMP = {
    "battery.charge": "100", "battery.charge.low": "10", "battery.charge.warning": "20",
    "battery.runtime": "31325", "battery.runtime.low": "300", "battery.voltage": "24.0",
    "device.mfr": 'Sample Vendor', "device.model": 'Sample UPS', "device.serial": 'TEST-UPS-SERIAL',
    "driver.name": "usbhid-ups", "input.frequency": "60.0", "input.voltage": "123.3",
    "input.voltage.nominal": "120", "output.frequency": "0.0", "output.voltage": "0.0",
    "ups.beeper.status": "enabled", "ups.firmware": 'TEST-FIRMWARE', "ups.load": "0",
    "ups.mfr": 'Sample Vendor', "ups.model": 'Sample UPS', "ups.realpower.nominal": "1500",
    "ups.status": "OB", "ups.test.result": "No test initiated",
}

#: A corresponding synthetic sample for the same unit carrying a load.
#: `OL`, live output, and a nonzero load.
LIVE_DUMP = dict(BENCH_DUMP, **{
    "ups.status": "OL", "ups.load": "12", "output.voltage": "122.9",
    "input.voltage": "122.9", "battery.runtime": "3575",
})


@pytest.fixture(autouse=True)
def _clean_module_state():
    """Reset module state around every test. `_NAME` is a resolve-once cache, so tests must not let `_ups_name` run `upsc -l` against the executing host. `_PEAK` persists for the process lifetime and must also be cleared to prevent order-dependent readings.
    """
    ups._CACHE.update(t=None, fields=None)
    ups._NAME[:] = ["testups"]
    ups._FAILS[0] = 0
    # 🔴 `_PEAK` IS PROCESS-LIFETIME BY DESIGN, WHICH MAKES IT THE WORST KIND OF TEST LEAK: it
    # only ever goes UP, so one test priming a heavy load silently raises the floor for every
    # test after it in the same worker — and the failure lands on whichever test happens to run
    # later, not on the one that caused it.
    ups._PEAK[0] = None
    yield
    ups._CACHE.update(t=None, fields=None)
    ups._NAME[:] = []
    ups._FAILS[0] = 0
    ups._PEAK[0] = None


def _prime(monkeypatch, fields, age=0.0):
    """Put `fields` in the cache as though a poll had just read them `age` seconds ago."""
    import time
    monkeypatch.setattr(ups, "read_ups", lambda *a, **k: dict(fields))
    ups.sample_once()
    if age:
        ups._CACHE["t"] = time.monotonic() - age


# ── the trap ─────────────────────────────────────────────────────────────────────────────────

def test_bench_fixture_renders_nothing(monkeypatch):
    """`OB` with zero load describes a unit that is not powering a load, not an outage. The reader should not draw a line for this fixture.
    """
    _prime(monkeypatch, BENCH_DUMP)
    assert ups.snapshot() is None


def test_zero_load_hides_the_line_even_when_the_status_is_healthy(monkeypatch):
    """And `OL` at zero load goes too, which is BROADER than the spec's rule — deliberately.

    `battery.runtime` at zero load is the unit's estimate of how long it could power nothing:
    31325 s here, 8.7 hours. A line reading `batt 100% · 8 h 42 min` beside `0 W` describes a
    UPS that is not carrying this box. One rule kills both halves.
    """
    _prime(monkeypatch, dict(BENCH_DUMP, **{"ups.status": "OL", "output.voltage": "122.9"}))
    assert ups.snapshot() is None


def test_the_live_dump_renders(monkeypatch):
    """For this fixture, 12% of 1500 W is 180 W, with a 15 W step.
    """
    _prime(monkeypatch, LIVE_DUMP)
    snap = ups.snapshot()
    assert snap is not None
    assert snap["status"] == "OL"
    assert snap["load_pct"] == 12
    assert snap["w"] == 180                       # 12 % × 1500 W, derived — never reported
    assert snap["batt_pct"] == 100
    assert snap["runtime_s"] == 3575
    assert snap["nominal_w"] == 1500
    assert snap["model"] == 'Sample UPS'
    assert snap["replace_batt"] is False
    assert snap["peak_w"] == 180                  # one poll in, so the peak IS the live figure


# ── peak reading ─────────────────────────────────────────────────────────────────────────────
#
# The peak is the highest valid load sample observed since the process started.


def test_the_peak_is_the_worst_poll_not_the_last_one(monkeypatch):
    """🔴 THE WHOLE POINT. The live figure follows the last reading down; the peak does not."""
    _prime(monkeypatch, LIVE_DUMP)                                  # 12 % -> 180 W
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.load": "41"}))      # 41 % -> 615 W
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.load": "9"}))       #  9 % -> 135 W
    snap = ups.snapshot()
    assert snap["w"] == 135, "the live figure must follow the latest reading"
    assert snap["peak_w"] == 615, "the peak must remember the worst poll, not the last one"


def test_the_peak_is_recorded_by_the_POLLER_not_by_the_render(monkeypatch):
    """The poller runs whether or not a browser is open; `snapshot()` runs only when a client requests the reading. Folding the peak at render time would miss load spikes between requests.

    This test takes three polls and one final snapshot; the middle spike must remain in the peak.
    """
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.load": "10"}))
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.load": "55"}))      # nobody looked
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.load": "10"}))
    assert ups.snapshot()["peak_w"] == 825                          # 55 % x 1500 W


def test_a_reading_the_line_would_refuse_never_sets_the_peak(monkeypatch):
    """The zero-load fixture is rejected by `snapshot()`. It must not contribute a peak value that the same reader refuses to display.
    """
    _prime(monkeypatch, BENCH_DUMP)               # load 0 — snapshot() returns None
    assert ups.snapshot() is None
    assert ups._PEAK[0] is None, "a zero-load reading set the peak"
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.load": "20"}))
    assert ups.snapshot()["peak_w"] == 300        # only the real reading counted


def test_a_reading_missing_a_required_field_never_sets_the_peak(monkeypatch):
    """The other half of the same gate. A dump without `battery.charge` is a UPS this display was
    not written for; its load percent is not evidence about anything."""
    partial = {k: v for k, v in LIVE_DUMP.items() if k != "battery.charge"}
    _prime(monkeypatch, dict(partial, **{"ups.load": "90"}))
    assert ups._PEAK[0] is None, "a dump the line refuses to draw set the peak anyway"


def test_the_peak_is_never_below_the_live_figure(monkeypatch):
    """⚠️ `snapshot` takes the max of the stored peak and the reading it is about to print. The
    poller is the only writer of `_PEAK`, so a cache filled by any other route — a test, a future
    caller, a `sample_once` whose peak fold is edited away — could otherwise produce the one
    display state that makes both numbers look invented: `615 W · peak 180 W`."""
    _prime(monkeypatch, LIVE_DUMP)                # peak 180
    ups._CACHE["fields"] = dict(LIVE_DUMP, **{"ups.load": "41"})    # 615 W, behind the poller
    snap = ups.snapshot()
    assert snap["w"] == 615
    assert snap["peak_w"] == 615, "the peak printed below the live figure it sits beside"


def test_no_poll_yet_means_no_peak_rather_than_zero(monkeypatch):
    """⚠️ OMITTED, NEVER ZEROED. `peak 0 W` in the seconds before the first reading would be a
    measurement claim about a poll that has not happened — and the client omits the slot on null
    for exactly that reason."""
    assert ups._PEAK[0] is None
    assert ups.snapshot() is None                 # nothing read at all -> no line, no peak


# ── ups.status is a LIST ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,want", [
    ("OL", "OL"),
    ("OB", "OB"),
    ("LB", "LB"),
    ("OL CHRG", "OL"),                            # online AND charging — the state after any outage
    ("OB DISCHRG", "OB"),
    ("OB LB", "LB"),                              # both true, and the worse one owns the slot
    ("OL LB", "LB"),
    ("OL CHRG RB", "OL"),                         # RB does not compete for the status slot
    ("", None),
    ("ALARM", None),                              # tokens with no state among them
])
def test_status_token_priority(raw, want):
    """🔴 `ups.status` IS SPACE-SEPARATED AND `== "OL"` IS A BUG. `OL CHRG` is a UPS that is
    online and topping its battery up, which is its state for hours after every outage — a
    whole-string comparison calls that "not online"."""
    assert ups._status_token(raw) == want


def test_charging_and_replace_battery_are_surfaced_separately(monkeypatch):
    """They qualify the state rather than being one, so they ride alongside it."""
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.status": "OL CHRG RB"}))
    snap = ups.snapshot()
    assert snap["status"] == "OL"
    assert snap["charging"] is True
    assert snap["replace_batt"] is True


# ── watts are DERIVED ─────────────────────────────────────────────────────────────────────────

def test_watts_come_from_the_units_own_rating_not_a_constant(monkeypatch):
    """A different UPS changes the arithmetic without changing the code.

    ⚠️ THE FAILURE THIS PREVENTS IS SILENT. A hardcoded 1500 against a 1000 W unit reports 50%
    more draw than the box takes, and nothing about the number looks wrong.
    """
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.realpower.nominal": "1000", "ups.load": "50"}))
    snap = ups.snapshot()
    assert snap["w"] == 500
    assert snap["nominal_w"] == 1000


def test_watts_step_by_fifteen_on_the_real_unit(monkeypatch):
    """1% of 1500 W = 15 W, so every figure this can produce is a multiple of 15. The UI must
    not print a decimal, and there is no reading between 180 and 195."""
    for pct in range(1, 101):
        _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.load": str(pct)}))
        assert ups.snapshot()["w"] == pct * 15


def test_the_warning_threshold_is_sent_rather_than_hardcoded_in_the_ui(monkeypatch):
    """The warning threshold is a proportion of the unit's rating, not a guessed wattage. Include it in the snapshot with `nominal_w` so the header has no separate value to drift from.
    """
    _prime(monkeypatch, LIVE_DUMP)
    assert ups.snapshot()["warn_pct"] == ups.WARN_LOAD_PCT


def test_realpower_is_not_read_because_it_does_not_exist(monkeypatch):
    """The fixture exposes `ups.realpower.nominal`, not `ups.realpower`. The displayed wattage is derived from the rating and load even if another unit also reports `ups.realpower`.
    """
    assert "ups.realpower" not in BENCH_DUMP
    # And if some future unit DOES report it, the derived figure is still what is drawn — the
    # day that changes is the day this test is the thing that says so.
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.realpower": "999"}))
    assert ups.snapshot()["w"] == 180


# ── every way to be absent ────────────────────────────────────────────────────────────────────

def test_nothing_ever_read():
    assert ups.snapshot() is None


def test_a_stale_reading_is_dropped(monkeypatch):
    """USB pulled mid-session, or `upsd` went away: the last good figure must not sit frozen."""
    _prime(monkeypatch, LIVE_DUMP, age=ups.STALE_S + 1)
    assert ups.snapshot() is None


def test_a_reading_inside_the_stale_window_survives(monkeypatch):
    """⚠️ The tolerance is not slack, it is the SELF-TEST. The UPS drops off USB while it tests
    its own battery; a tighter window would blank the segment every time it did, which reads as
    a fault. The line must ride over that."""
    _prime(monkeypatch, LIVE_DUMP, age=ups.STALE_S - 5)
    assert ups.snapshot() is not None


@pytest.mark.parametrize("missing", ups.REQUIRED)
def test_any_missing_required_field_hides_the_line(monkeypatch, missing):
    """A UPS that answers but not with these is a model this display was not written for."""
    dump = {k: v for k, v in LIVE_DUMP.items() if k != missing}
    _prime(monkeypatch, dump)
    assert ups.snapshot() is None


@pytest.mark.parametrize("bad", ["", "n/a", "unknown", "--"])
def test_an_unparseable_load_hides_the_line(monkeypatch, bad):
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.load": bad}))
    assert ups.snapshot() is None


def test_a_failed_read_does_not_clear_a_good_one(monkeypatch):
    """One dropped poll is not a reason to blank the header — STALE_S decides that, and it is
    six polls wide. This is what stops the line flickering during a self-test."""
    _prime(monkeypatch, LIVE_DUMP)
    monkeypatch.setattr(ups, "read_ups", lambda *a, **k: None)
    assert ups.sample_once() is None
    assert ups.snapshot() is not None             # the previous reading is still inside its window


# ── read_ups: the subprocess ──────────────────────────────────────────────────────────────────

class _Done:
    def __init__(self, out="", code=0):
        self.stdout, self.stderr, self.returncode = out, "", code


def test_stderr_is_captured_separately_from_stdout(monkeypatch):
    """🔴 `upsc` WRITES TO STDERR ON EVERY SINGLE INVOCATION and it is not an error: `Init SSL
    without certificate database`, on any build with no cert store. Merging the streams puts
    that line into the parse. It has no `": "` today; the point is that nothing guarantees the
    next such line will not."""
    seen = {}

    def fake_run(cmd, **kw):
        seen.update(kw)
        return _Done("ups.status: OL\nups.load: 12\n")

    monkeypatch.setattr(subprocess, "run", fake_run)
    fields = ups.read_ups("testups")
    assert fields == {"ups.status": "OL", "ups.load": "12"}
    assert seen.get("capture_output") is True     # separate pipes, never stderr=STDOUT
    assert "stderr" not in seen


def test_values_containing_a_colon_survive_the_parse(monkeypatch):
    """`partition(": ")` on the FIRST separator, not `split(":")`. `ups.test.result` and the
    driver's own version strings routinely contain colons."""
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Done(
        'driver.version.data: Sample Vendor HID 0.84\n'
        "ups.test.result: No test initiated: aborted\n"))
    fields = ups.read_ups("testups")
    assert fields["ups.test.result"] == "No test initiated: aborted"
    assert fields["driver.version.data"] == 'Sample Vendor HID 0.84'


@pytest.mark.parametrize("boom", [
    OSError("no such binary"),
    subprocess.TimeoutExpired("upsc", 3),
    subprocess.SubprocessError("something else"),
])
def test_every_subprocess_failure_is_none_not_a_traceback(monkeypatch, boom):
    def fake_run(*a, **k):
        raise boom
    monkeypatch.setattr(subprocess, "run", fake_run)
    assert ups.read_ups("testups") is None


def test_a_nonzero_exit_is_none(monkeypatch):
    """`upsd` down, or a UPS name that does not exist."""
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Done("", code=1))
    assert ups.read_ups("testups") is None


def test_empty_output_is_none(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Done(""))
    assert ups.read_ups("testups") is None


# ── name discovery ────────────────────────────────────────────────────────────────────────────

def test_the_env_var_wins(monkeypatch):
    ups._NAME[:] = []
    monkeypatch.setenv("VOCALIS_UPS", "chosen")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Done("listed\n"))
    assert ups._ups_name() == "chosen"


def test_the_name_is_discovered_from_upsc_l(monkeypatch):
    """Name discovery comes from `upsc -l`, so it survives a UPS swap and works when the configured NUT section uses another identifier."""
    ups._NAME[:] = []
    monkeypatch.delenv("VOCALIS_UPS", raising=False)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Done('sample-ups\n'))
    assert ups._ups_name() == 'sample-ups'


def test_a_failed_discovery_is_not_cached(monkeypatch):
    """⚠️ AT BOOT THIS RUNS BEFORE `nut-driver@.service` IS NECESSARILY UP. A name cached as
    None then would keep the segment dark until the next restart — the exact class of bug
    `_cpu_power_w` documents for RAPL and `_amdgpu_hwmons` for the cards."""
    ups._NAME[:] = []
    monkeypatch.delenv("VOCALIS_UPS", raising=False)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Done("", code=1))
    assert ups._ups_name() is None
    assert ups._NAME == []                        # nothing pinned
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Done('sample-ups\n'))
    assert ups._ups_name() == 'sample-ups'        # and it finds it once the driver comes up


# ── the poller ────────────────────────────────────────────────────────────────────────────────

def test_start_returns_none_without_upsc(monkeypatch):
    """Every box that never had NUT — which is every Windows dev box. No thread, no line."""
    monkeypatch.delenv("VOCALIS_UPS", raising=False)
    monkeypatch.setattr(ups.shutil, "which", lambda _: None)
    assert ups.start() is None


# ── a NUT server over the network (`VOCALIS_UPS=name@host`) ────────────────────────────────────────
# The Docker package has no `upsc` in its image and cannot run the host's, so the header's UPS line had silently gone
# there (October 11, 2026). Named with a host, the UPS is read by speaking NUT's own protocol to its server.

class _FakeNut:
    """A NUT server on 127.0.0.1 for one test: answers LIST UPS and LIST VAR from `variables`, records what it was
    asked, and can be told to misbehave. One thread, closed by the fixture."""

    def __init__(self, variables, name="rackups", mode="ok"):
        import socket
        import threading
        self.variables, self.name, self.mode, self.asked = variables, name, mode, []
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(4)
        self.port = self._listener.getsockname()[1]
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self):
        while True:
            try:
                conn, _ = self._listener.accept()
            except OSError:
                return
            with conn:
                stream = conn.makefile("rwb")
                for raw in stream:
                    command = raw.decode("ascii").strip()
                    self.asked.append(command)
                    if command == "LOGOUT":
                        stream.write(b"OK Goodbye\n")
                        stream.flush()
                        break
                    if command == "LIST UPS":
                        stream.write(f'BEGIN LIST UPS\nUPS {self.name} "the one in the rack"\nEND LIST UPS\n'.encode())
                    elif command.startswith("LIST VAR "):
                        asked_name = command.split(" ", 2)[2]
                        if self.mode == "unknown" or asked_name != self.name:
                            stream.write(b"ERR UNKNOWN-UPS\n")
                        else:
                            stream.write(f"BEGIN LIST VAR {self.name}\n".encode())
                            for key, value in self.variables.items():
                                quoted = value.replace("\\", "\\\\").replace('"', '\\"')
                                stream.write(f'VAR {self.name} {key} "{quoted}"\n'.encode())
                            if self.mode == "cut-off":
                                stream.flush()
                                break                         # the connection ends before the END line
                            stream.write(f"END LIST VAR {self.name}\n".encode())
                    else:
                        stream.write(b"ERR UNKNOWN-COMMAND\n")
                    stream.flush()

    def close(self):
        self._listener.close()
        self._thread.join(timeout=5)


@pytest.fixture
def nut_server():
    made = []

    def make(variables, **kwargs):
        server = _FakeNut(variables, **kwargs)
        made.append(server)
        return server

    yield make
    for server in made:
        server.close()


@pytest.mark.parametrize("value, want", [
    ("rackups", ("rackups", None, 3493)),
    ("", (None, None, 3493)),
    ("rackups@nas", ("rackups", "nas", 3493)),
    ("rackups@nas.example:3500", ("rackups", "nas.example", 3500)),
    ("@192.0.2.7", (None, "192.0.2.7", 3493)),
    (" rackups @ nas ", ("rackups", "nas", 3493)),
])
def test_the_setting_names_a_local_ups_or_a_ups_on_a_server(monkeypatch, value, want):
    monkeypatch.setenv("VOCALIS_UPS", value)
    assert ups._target() == want


def test_a_ups_on_a_server_is_read_over_the_network_without_upsc(monkeypatch, nut_server):
    """The whole reading, as `upsc` would give it, including a value with spaces, a quote and a backslash; and no
    `upsc` anywhere: none is looked for and none is run."""
    server = nut_server(dict(LIVE_DUMP, **{"device.model": 'Rack "Pro" 1500\\LCD'}))
    monkeypatch.setenv("VOCALIS_UPS", f"rackups@127.0.0.1:{server.port}")
    monkeypatch.setattr(ups.shutil, "which", lambda _: None)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("upsc must not be run for a network UPS"))
    ups._NAME[:] = []

    assert ups._available() is True, "naming a server is enough to start the poller; no upsc is needed"
    assert ups.source_text() == f"NUT server 127.0.0.1:{server.port}"
    fields = ups.sample_once()
    assert fields == dict(LIVE_DUMP, **{"device.model": 'Rack "Pro" 1500\\LCD'})
    snap = ups.snapshot()
    assert snap["status"] == "OL" and snap["w"] == 180 and snap["model"] == 'Rack "Pro" 1500\\LCD'
    assert server.asked == ["LIST VAR rackups", "LOGOUT"], "the name was given, so the server is not asked for a list"


def test_without_a_name_the_first_ups_the_server_lists_is_taken(monkeypatch, nut_server):
    server = nut_server(dict(LIVE_DUMP), name="cellar")
    monkeypatch.setenv("VOCALIS_UPS", f"@127.0.0.1:{server.port}")
    ups._NAME[:] = []
    assert ups._ups_name() == "cellar"
    assert ups.read_ups()["ups.load"] == "12"


@pytest.mark.parametrize("mode", ["unknown", "cut-off"])
def test_a_server_that_refuses_or_stops_mid_answer_gives_no_reading(monkeypatch, nut_server, mode):
    """An answer that does not reach its END line is not a reading: half a variable list could pass for a UPS with
    fields missing. An error answer and a dropped connection both hide the line, like a failed `upsc`."""
    server = nut_server(dict(LIVE_DUMP), mode=mode)
    monkeypatch.setenv("VOCALIS_UPS", f"rackups@127.0.0.1:{server.port}")
    ups._NAME[:] = []
    assert ups.read_ups() is None


@pytest.mark.parametrize("value, want", [
    ("rackups@nas:99999", ("rackups", "nas:99999", 3493)),      # not a port: more than 65535
    ("rackups@nas:0", ("rackups", "nas:0", 3493)),
    ("rackups@nas:²³", ("rackups", "nas:²³", 3493)),   # superscript digits pass isdigit() and break int()
    ("rackups@[2001:db8::7]:3500", ("rackups", "2001:db8::7", 3500)),
    ("rackups@", ("rackups", None, 3493)),
])
def test_a_port_is_one_to_65535_in_plain_digits_and_anything_else_is_not_a_port(monkeypatch, value, want):
    monkeypatch.setenv("VOCALIS_UPS", value)
    assert ups._target() == want


@pytest.mark.parametrize("field, bad", [
    ("ups.load", "nan"), ("ups.load", "inf"), ("battery.charge", "inf"), ("battery.runtime", "-inf"),
    ("input.voltage", "nan"),
])
def test_a_reading_that_is_not_a_finite_number_hides_the_line_and_never_raises(monkeypatch, field, bad):
    """`float()` accepts "nan" and "inf"; `int()` and `round()` then raise, and this function is called while the whole
    hardware strip is built, so one such value from a NUT server would have taken every readout down with it."""
    _prime(monkeypatch, dict(LIVE_DUMP, **{field: bad}))
    assert ups.snapshot() is None


@pytest.mark.parametrize("rating", ["nan", "inf", "0", "-1500", "a lot"])
def test_a_nonsense_rating_falls_back_to_the_default_instead_of_raising(monkeypatch, rating):
    _prime(monkeypatch, dict(LIVE_DUMP, **{"ups.realpower.nominal": rating}))
    snap = ups.snapshot()
    assert snap["nominal_w"] == ups.NOMINAL_W_DEFAULT and snap["w"] == 180


def test_a_server_that_trickles_its_answer_does_not_hold_a_poll_open(monkeypatch):
    """Each read has a time limit, and so has the whole exchange: a server sending one line every half second would
    pass the first and keep the poll open for ever."""
    import socket
    import threading
    import time

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    stop = threading.Event()

    def trickle():
        try:
            conn, _ = listener.accept()
        except OSError:
            return
        with conn:
            try:
                conn.sendall(b"BEGIN LIST VAR rackups\n")
                while not stop.wait(0.3):
                    conn.sendall(b'VAR rackups ups.load "12"\n')
            except OSError:
                pass

    thread = threading.Thread(target=trickle, daemon=True)
    thread.start()
    monkeypatch.setenv("VOCALIS_UPS", f"rackups@127.0.0.1:{listener.getsockname()[1]}")
    ups._NAME[:] = []
    started = time.monotonic()
    try:
        assert ups.read_ups(timeout=1) is None
        assert time.monotonic() - started < 5, "the whole exchange is bounded, not just each line"
    finally:
        stop.set()
        listener.close()
        thread.join(timeout=5)


def test_a_server_that_is_not_there_gives_no_reading_and_no_traceback(monkeypatch):
    import socket
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()                                             # nothing listens on this port now
    monkeypatch.setenv("VOCALIS_UPS", f"rackups@127.0.0.1:{port}")
    ups._NAME[:] = []
    assert ups.read_ups(timeout=2) is None
    assert ups.sample_once() is None and ups._FAILS[0] == 1


def test_start_is_idempotent_and_stop_cleans_up(monkeypatch):
    """The suite must not leave a thread forking `upsc` against the host under every test
    after it — the same rule `power.stop` exists for."""
    monkeypatch.setattr(ups.shutil, "which", lambda _: "/usr/bin/upsc")
    monkeypatch.setattr(ups, "read_ups", lambda *a, **k: dict(LIVE_DUMP))
    try:
        t1 = ups.start(interval=0.01)
        t2 = ups.start(interval=0.01)
        assert t1 is t2 and t1.is_alive()
    finally:
        ups.stop()
    assert not t1.is_alive()
    assert ups._THREAD == []
