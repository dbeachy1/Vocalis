"""5.3-m3 — `/devices`, the route the ⚙ Settings rows read and write.

Until this route existed the per-device settings were readable and honored but unreachable
from the UI: `devices:` had four readers and no writer, so a satellite could only be used by
hand-editing app_settings.yaml.

The failures guarded here are the quiet ones. A save that drops the satellite rows loses the
worker count for a machine that merely happens to be asleep; a `devices:` write that leaves
`gpus:` stale unticks a card for Chatterbox while VoxCPM and the enhancer keep loading onto it.

Design: DESIGN_5_3_SATELLITES §3.5.
"""
import threading

import pytest

import vocalis_server as vs
import vocalis.runtime.gpu as gpu_mod
import vocalis.runtime.satellites as sat_mod
import vocalis.runtime.settings as rt_settings
from vocalis.runtime import pool as pool_mod


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture
def settings_file(monkeypatch, tmp_path):
    """Never write the repo's real app_settings.yaml."""
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    return tmp_path / "app_settings.yaml"


@pytest.fixture(autouse=True)
def two_local_cards(monkeypatch):
    """🔴 The suite must not read the host. Host GPU inventories vary; the answer must come
    from this fixture rather than the developer machine."""
    monkeypatch.setattr(gpu_mod, "gpu_registry",
                        lambda: [{"index": 0, "name": "Test Card A"},
                                 {"index": 1, "name": "Test Card B"}])


@pytest.fixture(autouse=True)
def never_probe_the_network(monkeypatch):
    """🔴 Stub `health`, NOT `snapshot`. Stubbing the whole snapshot would hide the registry from
    every test below — they would assert against the stub instead of the code, which is the
    pass-for-the-wrong-reason shape. This way the real `snapshot` runs and only the round trip
    to a machine that is not there is replaced. A satellite reads as down, which is its normal
    steady state anyway."""
    monkeypatch.setattr(sat_mod, "health",
                        lambda name: {"reachable": False, "error": "not running",
                                      "devices": [], "ready": False})


# ── GET: the rows ────────────────────────────────────────────────────────────

def test_get_lists_every_local_card(client, settings_file):
    rows = client.get("/devices").get_json()["devices"]
    assert [d["id"] for d in rows] == ["cuda:0", "cuda:1"]
    assert rows[0]["label"] == "Test Card A"
    assert all(d["satellite"] is None for d in rows)


def test_get_offers_cpu_only_when_there_is_no_card(client, settings_file, monkeypatch):
    """Mirrors parse_devices('all'), which falls back to ['cpu'] on a box with no GPU. Offering
    cpu ALONGSIDE real cards would only invite a pointlessly slow render."""
    monkeypatch.setattr(gpu_mod, "gpu_registry", lambda: [])
    rows = client.get("/devices").get_json()["devices"]
    assert [d["id"] for d in rows] == ["cpu"]


def test_get_migrates_the_legacy_keys_without_writing_them(client, settings_file):
    """Migration is READ-ONLY until the user saves — a config that half-migrates is a pool that
    loads the wrong number of replicas, and nothing says so."""
    rt_settings.save_app_settings({"gpus": "0", "workers_per_card": 3})
    rows = {d["id"]: d for d in client.get("/devices").get_json()["devices"]}
    assert rows["cuda:0"]["enabled"] is True
    assert rows["cuda:1"]["enabled"] is False
    # 5.4.1: the legacy count is not migrated onto the row and not echoed to the page.
    assert all("workers" not in r for r in rows.values()), rows
    assert "devices" not in rt_settings.load_app_settings(), "GET wrote settings"


def test_get_reports_a_sleeping_satellites_cards_grayed_not_missing(client, settings_file,
                                                                    monkeypatch):
    monkeypatch.setattr(sat_mod, "snapshot", lambda remembered=None: {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880",
                        "reachable": False, "error": "asleep",
                        "ready": False, "loading": False}],
        "devices": [{"id": "test-satellite:cuda:0", "satellite": "test-satellite",
                     "device": "cuda:0", "reachable": False}]})
    body = client.get("/devices").get_json()
    row = [d for d in body["devices"] if d["satellite"] == "test-satellite"][0]
    assert row["reachable"] is False
    assert body["satellites"][0]["reachable"] is False


def test_a_satellite_card_says_it_is_a_satellite_in_its_LABEL_not_its_ID(client, settings_file,
                                                                        monkeypatch):
    """A remote card's label identifies it as a satellite, while its ID remains the parseable
`<satellite>:<device>` form. The ID must not start with `cuda`: `WorkerPool` uses that prefix to
select local-device setup, memory checks, and cache clearing. Splitting only at the first colon
also keeps the satellite name and device name routed correctly."""
    monkeypatch.setattr(sat_mod, "snapshot", lambda remembered=None: {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880", "reachable": True,
                        "error": "", "ready": True, "loading": False}],
        "devices": [{"id": "test-satellite:cuda:0", "satellite": "test-satellite",
                     "device": "cuda:0", "reachable": True}]})
    row = [d for d in client.get("/devices").get_json()["devices"]
           if d["satellite"] == "test-satellite"][0]
    assert "satellite" in row["label"].lower(), "a remote card must say so on its row"
    assert row["id"] == "test-satellite:cuda:0", "the id must stay <satellite>:<device>, unprefixed"
    assert not row["id"].startswith("cuda"), "a remote id that looks local re-enables the " \
                                             "local-VRAM path for a card in another machine"


# ── PUT: the write nothing used to do ────────────────────────────────────────

def test_put_writes_the_devices_list(client, settings_file):
    r = client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True},
        {"id": "cuda:1", "enabled": False}]})
    assert r.status_code == 200
    assert rt_settings.load_app_settings()["devices"] == [
        {"id": "cuda:0", "enabled": True},
        {"id": "cuda:1", "enabled": False}]


def test_a_saved_selection_governs_the_pool_the_next_render_builds(client, settings_file):
    """The whole point of the panel: the ⚙ rows are what every render path reads, not a
    cosmetic display."""
    client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True},
        {"id": "cuda:1", "enabled": False}]})
    assert pool_mod.default_devices() == ["cuda:0"]
    assert pool_mod.default_workers() == {"cuda:0": 1}


def test_saving_devices_also_moves_default_gpus(client, settings_file):
    """🔴 The half-migration running the other way. default_gpus() feeds VoxCPM, the
    resemble-enhance card list, books and playground — none of them Chatterbox. If it kept
    reading the stale `gpus:` string, unticking a card would stop Chatterbox using it while
    those four carried on loading onto it, and nothing would report the disagreement."""
    rt_settings.save_app_settings({"gpus": "all", "workers_per_card": 1})
    client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True},
        {"id": "cuda:1", "enabled": False}]})
    assert pool_mod._local_gpus_string() == "0"


def test_a_satellite_row_survives_a_save_while_it_is_asleep(client, settings_file, monkeypatch):
    """A satellite can be configured while offline. Saving its row must preserve the requested worker
count so that connectivity state does not erase the operator's saved intent."""
    monkeypatch.setattr(sat_mod, "snapshot", lambda remembered=None: {
        "satellites": [{"name": "test-satellite", "url": "https://test-satellite.invalid:7880",
                        "reachable": False, "error": "asleep",
                        "ready": False, "loading": False}],
        "devices": [{"id": "test-satellite:cuda:0", "satellite": "test-satellite",
                     "device": "cuda:0", "reachable": False}] if remembered else []})
    client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True},
        {"id": "test-satellite:cuda:0", "enabled": True}]})
    rows = {d["id"]: d for d in client.get("/devices").get_json()["devices"]}
    assert rows["test-satellite:cuda:0"]["enabled"] is True
    assert rows["test-satellite:cuda:0"]["reachable"] is False


def test_a_stale_tab_sending_a_worker_count_is_ignored_not_refused(client, settings_file):
    """🔴 5.4.1 removed the field. A browser left open across the upgrade still sends it, and a
    400 would break the whole panel for that user until they reloaded — so it is dropped on the
    floor. The value must not survive into the saved row, or it would reach the satellite plan.
    """
    r = client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True, "workers": 64}]})
    assert r.status_code == 200
    assert rt_settings.load_app_settings()["devices"] == [{"id": "cuda:0", "enabled": True}]
    assert pool_mod.default_workers() == {"cuda:0": 1}


def test_a_duplicate_device_id_is_a_400(client, settings_file):
    """Two rows for one device is a client bug, and last-write-wins would hide it behind a
    saved state that silently is not what the page shows."""
    r = client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True},
        {"id": "cuda:0", "enabled": False}]})
    assert r.status_code == 400


def test_a_non_list_body_is_a_400(client, settings_file):
    assert client.put("/devices", json={"devices": "cuda:0"}).status_code == 400


def test_an_unchanged_save_does_not_drop_the_pool(client, settings_file, monkeypatch):
    """The drop releases VRAM, but it also costs the next render a full model load. A no-op
    save — the UI re-POSTs every row on every change — must not pay that."""
    dropped = []
    monkeypatch.setattr(pool_mod, "model_ready", lambda: True)
    monkeypatch.setattr(pool_mod, "drop_pool", lambda: dropped.append(1))
    body = {"devices": [{"id": "cuda:0", "enabled": True}]}
    client.put("/devices", json=body)
    dropped.clear()
    client.put("/devices", json=body)
    assert dropped == [], "an identical save rebuilt the pool"


def test_removing_a_satellite_prunes_its_device_rows(client, settings_file, monkeypatch):
    """A left-behind row is a checkbox for a machine Vocalis no longer knows how to reach: it
    looks configurable, counts toward the pool signature, and does nothing."""
    monkeypatch.setattr(sat_mod, "APP_SETTINGS", settings_file, raising=False)
    client.post("/satellites", json={"name": "test-satellite", "url": "https://test-satellite.invalid:7880"})
    client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True},
        {"id": "test-satellite:cuda:0", "enabled": True}]})
    assert client.delete("/satellites/test-satellite").status_code == 200
    left = [d["id"] for d in rt_settings.load_app_settings()["devices"]]
    assert left == ["cuda:0"]
    assert rt_settings.load_app_settings().get("satellites") == []


# ── the registry: the secret is shown ONCE ───────────────────────────────────

def test_adding_a_satellite_returns_the_secret_exactly_once(client, settings_file):
    """🔴 The one-time contract. It is displayed for pasting into that machine's setup and never
    served again — anything that re-serves it puts it in the DOM and in every settings fetch the
    browser decides to remember."""
    r = client.post("/satellites", json={"name": "test-satellite", "url": "https://test-satellite.invalid:7880"})
    assert r.status_code == 200
    secret = r.get_json()["secret"]
    assert len(secret) == 64 and int(secret, 16) >= 0        # 32 bytes of hex

    body = client.get("/devices").get_data(as_text=True)
    assert secret not in body, "the secret came back on a later read"
    sats = client.get("/devices").get_json()["satellites"]
    assert sats[0]["secret_set"] is True                     # a BOOL, never the value
    assert "secret" not in sats[0]


def test_two_adds_do_not_produce_the_same_secret(client, settings_file):
    """A vacuous version of the test above would pass on a hardcoded constant."""
    a = client.post("/satellites", json={"name": "one", "url": "https://a.lan:7880"}).get_json()
    b = client.post("/satellites", json={"name": "two", "url": "https://b.lan:7880"}).get_json()
    assert a["secret"] != b["secret"]


def test_rotating_gives_a_new_secret_and_replaces_the_old(client, settings_file):
    first = client.post("/satellites",
                        json={"name": "test-satellite", "url": "https://test-satellite.invalid:7880"}).get_json()["secret"]
    second = client.post("/satellites/test-satellite/secret").get_json()["secret"]
    assert second != first
    assert sat_mod.entry("test-satellite")["secret"] == second


@pytest.mark.parametrize("name", ["cuda", "cuda:0", "cpu", "ma:ia", "", "TEST-SATELLITE!"])
def test_a_name_that_would_break_a_device_id_is_refused(client, settings_file, name):
    """The satellite name forms part of `<satellite>:<device>`. Reject colons and names beginning
with `cuda` so parsing stays unambiguous and remote IDs cannot trigger local-device handling."""
    r = client.post("/satellites", json={"name": name, "url": "https://x.lan:7880"})
    assert r.status_code == 400, f"{name!r} was accepted as a satellite name"


def test_a_url_without_a_scheme_is_refused(client, settings_file):
    r = client.post("/satellites", json={"name": "test-satellite", "url": "test-satellite.invalid:7880"})
    assert r.status_code == 400


def test_a_duplicate_satellite_name_is_refused(client, settings_file):
    client.post("/satellites", json={"name": "test-satellite", "url": "https://a.lan:7880"})
    r = client.post("/satellites", json={"name": "test-satellite", "url": "https://b.lan:7880"})
    assert r.status_code == 400


def test_a_file_that_is_not_a_certificate_is_refused(client, settings_file, monkeypatch,
                                                     tmp_path):
    """A "pin" that is not a certificate degrades silently to unpinned TLS while the badge keeps
    saying pinned — which against an active attacker on the LAN is the failure the pin exists
    to prevent."""
    monkeypatch.setattr(sat_mod, "cert_dir", lambda: tmp_path / "certs")
    client.post("/satellites", json={"name": "test-satellite", "url": "https://test-satellite.invalid:7880"})
    r = client.post("/satellites/test-satellite/cert", data=b"not a cert",
                    content_type="application/x-pem-file")
    assert r.status_code == 400
    assert sat_mod.entry("test-satellite")["cert"] is None, "a bad file was pinned anyway"


def test_a_real_certificate_is_stored_and_pinned(client, settings_file, monkeypatch, tmp_path):
    pem = _self_signed_pem()
    monkeypatch.setattr(sat_mod, "cert_dir", lambda: tmp_path / "certs")
    client.post("/satellites", json={"name": "test-satellite", "url": "https://test-satellite.invalid:7880"})
    r = client.post("/satellites/test-satellite/cert", data=pem,
                    content_type="application/x-pem-file")
    assert r.status_code == 200
    assert sat_mod.entry("test-satellite")["cert"] == "test-satellite.pem"
    assert (tmp_path / "certs" / "test-satellite.pem").read_bytes() == pem
    assert r.get_json()["verified"] is True, "a pinned TLS link must report as verified"


def test_a_private_key_beside_the_certificate_is_not_stored(client, settings_file,
                                                            monkeypatch, tmp_path):
    """🔴 The upload is re-serialized from the parsed certificate, never written through.

    `load_pem_x509_certificate` finds the first CERTIFICATE block and ignores everything around
    it, so a file holding `key.pem` + `cert.pem` — the exact slip §11.3's boxed output was
    rewritten to prevent ("it's so easy to copy the wrong line, and then you put the private key
    on the server") — validated, returned 200, showed the RIGHT fingerprint, and left the
    satellite's plaintext private key in Vocalis's certs/ directory, outside the vault, forever.
    Uploading key.pem alone is correctly refused, which is what made this look safe.
    """
    key_pem, pem = _self_signed_pair()
    assert b"PRIVATE KEY" in key_pem                      # the file the operator must not send
    monkeypatch.setattr(sat_mod, "cert_dir", lambda: tmp_path / "certs")
    client.post("/satellites", json={"name": "test-satellite", "url": "https://test-satellite.invalid:7880"})
    r = client.post("/satellites/test-satellite/cert", data=key_pem + pem,
                    content_type="application/x-pem-file")
    assert r.status_code == 200                          # it IS a valid certificate, just not only
    stored = (tmp_path / "certs" / "test-satellite.pem").read_bytes()
    assert b"PRIVATE KEY" not in stored, "the satellite's private key was written to the certificate file"
    assert stored.count(b"BEGIN CERTIFICATE") == 1
    assert sat_mod.fingerprint(stored) == r.get_json()["fingerprint"], (
        "what is pinned must be what the fingerprint describes")


def test_a_second_certificate_in_the_file_is_not_silently_trusted(client, settings_file,
                                                                  monkeypatch, tmp_path):
    """A pin that accepts N certificates while displaying one fingerprint is the "the badge said
    pinned" failure §6 exists to stop. The whole uploaded file used to become the CA file, so a
    bundle (old cert + new cert after a regeneration) trusted both."""
    monkeypatch.setattr(sat_mod, "cert_dir", lambda: tmp_path / "certs")
    first, second = _self_signed_pem(), _self_signed_pem()
    assert first != second
    client.post("/satellites", json={"name": "test-satellite", "url": "https://test-satellite.invalid:7880"})
    r = client.post("/satellites/test-satellite/cert", data=first + second,
                    content_type="application/x-pem-file")
    assert r.status_code == 200
    stored = (tmp_path / "certs" / "test-satellite.pem").read_bytes()
    assert stored.count(b"BEGIN CERTIFICATE") == 1, "both certificates are trusted"
    assert sat_mod.fingerprint(stored) == r.get_json()["fingerprint"]


def test_the_fingerprint_is_the_one_setup_py_prints(client, settings_file, monkeypatch,
                                                    tmp_path):
    """It exists to be COMPARED — §11.3 tells the operator to check it against the satellite's
    console — so the two implementations have to agree, colons, uppercase and all. Nothing
    tested that; `grep -rn fingerprint tests/` found nothing at all."""
    import importlib.util
    from conftest import REPO_ROOT
    spec = importlib.util.spec_from_file_location(
        "satellite_setup_fp", REPO_ROOT / "satellite" / "setup.py")
    setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(setup)

    pem = _self_signed_pem()
    cert_p = tmp_path / "cert.pem"
    cert_p.write_bytes(pem)
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        setup._print_fingerprint(cert_p)
    printed = [ln.split("SHA-256:")[1].strip() for ln in buf.getvalue().splitlines()
               if "SHA-256:" in ln][0]
    assert sat_mod.fingerprint(pem) == printed


def test_an_oversized_cert_upload_is_refused_without_being_written(client, settings_file,
                                                                   monkeypatch, tmp_path):
    """🔴 This route deliberately does NOT read request.files, because every route that does is
    exempt from the 128 MB body cap — an exemption sized for streaming audio to disk, which a
    two-kilobyte certificate has no use for. That means the cap here is this route's own."""
    monkeypatch.setattr(sat_mod, "cert_dir", lambda: tmp_path / "certs")
    client.post("/satellites", json={"name": "test-satellite", "url": "https://test-satellite.invalid:7880"})
    r = client.post("/satellites/test-satellite/cert", data=b"x" * (65 * 1024),
                    content_type="application/x-pem-file")
    assert r.status_code == 413
    assert not (tmp_path / "certs").exists(), "an oversized body reached the filesystem"


def test_unticking_every_device_is_allowed_and_saved(client, settings_file):
    """Allow an empty device selection: saving zero requested workers is how an operator releases a
satellite's VRAM without stopping its service. CPU rendering remains valid but slower, so the
response must warn when the saved plan leaves no accelerator enabled."""
    ok = client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": False},
        {"id": "test-satellite:cuda:0", "enabled": True}]})
    assert ok.status_code == 200, "a satellite-only selection must still be allowed"

    # A loguru sink, not `caplog`: this app logs through loguru, which does not propagate to the
    # stdlib logging that caplog hooks — so caplog reads EMPTY here even while the line is
    # plainly on stderr, and the assertion would have passed for the wrong reason if inverted.
    from loguru import logger as _logger
    said = []
    sink = _logger.add(lambda m: said.append(str(m)), format="{message}", level="WARNING")
    try:
        r = client.put("/devices", json={"devices": [
            {"id": "cuda:0", "enabled": False},
            {"id": "test-satellite:cuda:0", "enabled": False}]})
    finally:
        _logger.remove(sink)
    assert r.status_code == 200, "empty device selection was refused"
    rows = {d["id"]: d for d in rt_settings.load_app_settings()["devices"]}
    assert rows["test-satellite:cuda:0"]["enabled"] is False, "the disabled selection was not saved"
    assert rows["cuda:0"]["enabled"] is False
    assert any("cpu" in m.lower() for m in said), (
        "an empty device selection must warn that rendering will use the CPU")


def test_unticking_the_last_card_still_releases_the_satellite(client, settings_file, monkeypatch):
    """Removing the last enabled card must reconcile an empty worker plan asynchronously. Refusing the
save or returning before reconciliation would leave the satellite's existing workers loaded."""
    import threading
    done, seen = threading.Event(), {}

    def _reconcile(counts):
        seen["counts"] = dict(counts)
        done.set()
        return {}

    monkeypatch.setattr(sat_mod, "reconcile", _reconcile)
    client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True},
        {"id": "test-satellite:cuda:0", "enabled": True}]})
    # 🔴 LET THE SETUP SAVE'S OWN RECONCILE LAND BEFORE CLEARING. It runs OFF the request thread
    # (that is the point of the feature), so `put()` returning does not mean it has happened. If
    # it lands after the clear it sets `done` and writes ITS counts — the wait below is then
    # satisfied by the wrong call, and the assertion compares the setup save's counts instead of
    # the untick's. The window is normally microseconds and the test always won; under the full
    # suite a DNS timeout resolving `test-satellite.invalid` stretches it wide enough to lose, which is a
    # failure in `main` about nothing. Same race 36abcb3 fixed for the reconnect tests.
    assert done.wait(timeout=5), "the setup save never reached the satellite"
    done.clear()
    seen.clear()

    r = client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": False},
        {"id": "test-satellite:cuda:0", "enabled": False}]})
    assert r.status_code == 200
    assert done.wait(timeout=5), "unticking everything never reached the satellite"
    assert seen["counts"] == {}, (
        "no card is wanted, so reconcile() zeroes every known one — see apply_plan")


def test_saving_devices_reconciles_the_satellite_immediately(client, settings_file, monkeypatch):
    """Reconcile the saved device plan after every settings change, including cards removed from the
selection. Run reconciliation off the request thread because loading replicas and connecting to an
unreachable satellite can be slow."""
    import threading
    done, seen = threading.Event(), {}

    def _reconcile(counts):
        seen["counts"] = dict(counts)
        done.set()
        return {}

    monkeypatch.setattr(sat_mod, "reconcile", _reconcile)
    r = client.put("/devices", json={"devices": [
        {"id": "cuda:0", "enabled": True},
        {"id": "test-satellite:cuda:0", "enabled": True},
        {"id": "test-satellite:cuda:1", "enabled": False}]})
    assert r.status_code == 200
    assert done.wait(timeout=5), "the satellite was never told about the change"
    assert seen["counts"] == {"test-satellite:cuda:0": 1}, (
        f"only the ticked satellite cards are asked for; the rest are zeroed by reconcile() "
        f"itself — got {seen['counts']}")


def test_a_render_in_flight_defers_the_satellite_reconcile(client, settings_file, monkeypatch):
    """🔴 A prior fix established this concurrency contract: releasing a replica out from under an in-flight book
    aborts it. The local pool drop has always guarded on the GPU gate for exactly that reason,
    and the satellite path must keep the same contract. Deferring is safe because `apply_plan`
    now names every known card explicitly, so the next pool build performs the release rather
    than forgetting it."""
    from vocalis.runtime.gpu import GPUS
    import vocalis.web.ui as ui_mod
    called = []
    monkeypatch.setattr(sat_mod, "reconcile", lambda counts: called.append(counts))

    # Absence is asserted only once the reconcile thread has FINISHED, and "finished" is a POSITIVE
    # event: the function the thread runs is wrapped so that returning sets it. This used to join
    # threads by the name "satellite-reconcile", which proves nothing if the product ever renames
    # the thread (the loop then finds no thread and `called == []` holds vacuously). The route reads
    # `_reconcile_satellites` from the module when it spawns the thread, so patching the module
    # attribute before the PUT is seen.
    ran = threading.Event()
    real_reconcile = ui_mod._reconcile_satellites

    def _reconcile_then_signal(want):
        try:
            real_reconcile(want)
        finally:
            ran.set()

    monkeypatch.setattr(ui_mod, "_reconcile_satellites", _reconcile_then_signal)

    assert GPUS.acquire(timeout=1), "the gate should be free in a test"
    try:                                              # stand in for a render holding the cards
        r = client.put("/devices", json={"devices": [
            {"id": "cuda:0", "enabled": True},
            {"id": "test-satellite:cuda:0", "enabled": False}]})
        assert r.status_code == 200
        # Its `GPUS.acquire(timeout=0.1)` fails while this test holds the gate, and the thread then
        # returns without ever reaching `reconcile`.
        assert ran.wait(timeout=10), "the satellite reconcile thread never ran to completion"
        assert called == [], "a save yanked the satellite's replicas mid-render"
    finally:
        GPUS.release()


def test_a_malformed_satellite_entry_does_not_log_its_secret(monkeypatch, settings_file, caplog):
    """🔴 The warning interpolated the whole entry — `secret` included — and it fires on every
    `configured()` call, i.e. every 10 s while the Settings panel is open. logs/vocalis.log is
    unencrypted, keeps ten rotations, and `/logs/tail` serves it to the browser. One typo while
    hand-editing app_settings.yaml (`ur1:`, or dropping the line while re-indenting) was enough.
    """
    secret = "d" * 64
    monkeypatch.setattr(rt_settings, "load_app_settings",
                        lambda: {"satellites": [{"name": "", "url": "", "secret": secret}]})
    monkeypatch.setattr(sat_mod.settings, "load_app_settings",
                        lambda: {"satellites": [{"name": "", "url": "", "secret": secret}]})

    seen = []
    monkeypatch.setattr(sat_mod.logger, "warning", lambda m: seen.append(str(m)))
    assert sat_mod.configured() == []
    assert seen, "a malformed entry must still be reported"
    assert secret not in " ".join(seen), f"the master secret was logged: {seen}"


def test_an_unpinned_satellite_never_reports_as_verified(client, settings_file):
    """§6's trap. The badge is the client's verdict, not 'the URL starts with https'."""
    client.post("/satellites", json={"name": "test-satellite", "url": "https://test-satellite.invalid:7880"})
    sats = client.get("/devices").get_json()["satellites"]
    assert sats[0]["verified"] is False
    assert "NOT pinned" in sats[0]["note"]


def _self_signed_pair() -> tuple:
    """(key PEM, certificate PEM) — the two files `setup.py` writes side by side, which is what
    makes concatenating them by accident so easy."""
    from cryptography.hazmat.primitives import serialization
    key, pem = _self_signed(with_key=True)
    return (key.private_bytes(serialization.Encoding.PEM,
                              serialization.PrivateFormat.PKCS8,
                              serialization.NoEncryption()), pem)


def _self_signed_pem() -> bytes:
    return _self_signed(with_key=False)


def _self_signed(with_key: bool = False):
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test-satellite.invalid")])
    now = datetime.datetime(2026, 1, 1)
    cert = (x509.CertificateBuilder()
            .subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=3650))
            .sign(key, hashes.SHA256()))
    pem = cert.public_bytes(serialization.Encoding.PEM)
    return (key, pem) if with_key else pem


def test_a_real_change_drops_the_pool_so_it_is_not_a_silent_no_op(client, settings_file,
                                                                  monkeypatch):
    """When device settings change, drop a resident pool so the next request uses the new plan rather
than silently continuing with stale workers."""
    dropped = []
    monkeypatch.setattr(pool_mod, "model_ready", lambda: True)
    monkeypatch.setattr(pool_mod, "drop_pool", lambda: dropped.append(1))
    client.put("/devices", json={"devices": [{"id": "cuda:0", "enabled": True}]})
    dropped.clear()
    # The change that used to be tested here was a worker count going 1 -> 2. With the count
    # gone, ticking is the only change a row can express -- so that is what has to drop the pool.
    client.put("/devices", json={"devices": [{"id": "cuda:0", "enabled": False}]})
    assert dropped == [1]


# ── reconnect after a satellite restart ─────────────────────────────────────

def _test_satellite(client, monkeypatch, *, loaded=None, reachable=True, cards=("cuda:0",)):
    """A satellite named `test-satellite` that answers health, with `loaded` as its live worker counts.

    🔴 `reconcile` is neutered here, and that is not tidiness. Saving devices fires its own
    reconcile onto a BACKGROUND THREAD, which reaches `apply_plan` — the very thing these tests
    record. Left live it appends a second entry at an unpredictable moment, so the assertions
    below would pass or fail on thread scheduling. The PUT's reconcile has its own test above;
    what is under test here is `resync`, which calls `apply_plan` directly.
    """
    client.post("/satellites", json={"name": "test-satellite", "url": "https://test-satellite.invalid:7880"})
    monkeypatch.setattr(sat_mod, "reconcile", lambda counts: {})
    monkeypatch.setattr(sat_mod, "health",
                        lambda name: {"reachable": reachable, "ready": bool(loaded),
                                      "available_devices": list(cards), "devices": list(cards),
                                      "workers": dict(loaded or {}), "sr": 24000})


def _save(client, rows):
    return client.put("/devices", json={"devices": rows})


def test_reconnect_applies_a_plan_that_has_not_changed(client, settings_file, monkeypatch):
    """Reconnect must resend the saved plan even when it matches the stored settings. A satellite can
restart and lose its workers without changing the local rows; toggling settings to force a diff
must not be required."""
    _test_satellite(client, monkeypatch, loaded={})                     # restarted: holding nothing
    rows = [{"id": "cuda:0", "enabled": True},
            {"id": "test-satellite:cuda:0", "enabled": True}]
    _save(client, rows)
    plans = []
    monkeypatch.setattr(sat_mod, "apply_plan", lambda p: plans.append(dict(p)))

    _save(client, rows)                     # the panel's save when nothing was touched
    assert plans == [], "an unchanged save is not supposed to reconcile — that is the premise"

    r = client.post("/satellites/test-satellite/reconnect")
    assert r.status_code == 200
    assert plans == [{"test-satellite:cuda:0": 1}], (
        f"reconnect must declare the saved plan even though nothing changed — got {plans}")


def test_reconnect_does_not_stop_at_ready_the_way_reload_does(client, settings_file, monkeypatch):
    """The reason this is not just a button wired to `reload()`.

    `reload()` returns early when health says `ready`, which is correct for ITS trigger — a 503
    means zero replicas — and wrong here. A satellite holding ONE replica where settings ask for
    two is `ready`, and that is exactly the divergence this button exists to correct.
    """
    _test_satellite(client, monkeypatch, loaded={"cuda:0": 1})          # ready, but short by one
    _save(client, [{"id": "cuda:0", "enabled": True},
                   {"id": "test-satellite:cuda:0", "enabled": True}])
    plans = []
    monkeypatch.setattr(sat_mod, "apply_plan", lambda p: plans.append(dict(p)))
    assert client.post("/satellites/test-satellite/reconnect").status_code == 200
    assert plans == [{"test-satellite:cuda:0": 1}], (
        "a satellite that is `ready` but under-loaded was left alone — reload()'s early return "
        "leaking into the manual path")


def test_reconnect_declares_the_whole_satellite_not_one_card(client, settings_file, monkeypatch):
    """The button sits on a card row, but `Engine.load` is declarative per MACHINE and
    `apply_plan` gives every card it knows about an explicit count. Sending one card's number
    would zero that satellite's other cards — releasing VRAM nobody asked to release."""
    _test_satellite(client, monkeypatch, loaded={}, cards=("cuda:0", "cuda:1"))
    _save(client, [{"id": "cuda:0", "enabled": True},
                   {"id": "test-satellite:cuda:0", "enabled": True},
                   {"id": "test-satellite:cuda:1", "enabled": True}])
    plans = []
    monkeypatch.setattr(sat_mod, "apply_plan", lambda p: plans.append(dict(p)))
    client.post("/satellites/test-satellite/reconnect")
    assert plans == [{"test-satellite:cuda:0": 1, "test-satellite:cuda:1": 1}]


def test_reconnect_asks_for_zero_on_an_unticked_card(client, settings_file, monkeypatch):
    """An unticked row is a request for ZERO, not silence — `apply_plan`'s own rule. That makes
    this button a way to release VRAM a satellite still holds from before a settings change, not
    only a way to claim it."""
    _test_satellite(client, monkeypatch, loaded={"cuda:0": 2}, cards=("cuda:0", "cuda:1"))
    _save(client, [{"id": "cuda:0", "enabled": True},
                   {"id": "test-satellite:cuda:0", "enabled": False},
                   {"id": "test-satellite:cuda:1", "enabled": True}])
    plans = []
    monkeypatch.setattr(sat_mod, "apply_plan", lambda p: plans.append(dict(p)))
    client.post("/satellites/test-satellite/reconnect")
    assert plans == [{"test-satellite:cuda:0": 0, "test-satellite:cuda:1": 1}]


def test_reconnect_reports_what_the_satellite_says_it_has(client, settings_file, monkeypatch):
    """The reply is read back from health, never echoed from the plan. A satellite that fitted
    nothing must not be reported as holding the replica it was asked for — that is the panel
    lying in a new place instead of the old one."""
    _test_satellite(client, monkeypatch, loaded={"cuda:0": 0})          # asked 1, fitted 0
    _save(client, [{"id": "cuda:0", "enabled": True},
                   {"id": "test-satellite:cuda:0", "enabled": True}])
    monkeypatch.setattr(sat_mod, "apply_plan", lambda p: None)
    body = client.post("/satellites/test-satellite/reconnect").get_json()
    assert body["plan"] == {"test-satellite:cuda:0": 1}
    assert body["loaded"] == {"cuda:0": 0}
    assert body["reachable"] is True


def test_reconnect_to_a_satellite_that_is_off_says_so_instead_of_failing(client, settings_file,
                                                                        monkeypatch):
    """Not running is the normal steady state (§11.4), so this is a 200 reporting
    `reachable: false` — the panel turns that into "start it, then press it again"."""
    _test_satellite(client, monkeypatch, loaded={}, reachable=False)
    _save(client, [{"id": "cuda:0", "enabled": True},
                   {"id": "test-satellite:cuda:0", "enabled": True}])
    monkeypatch.setattr(sat_mod, "apply_plan", lambda p: None)
    r = client.post("/satellites/test-satellite/reconnect")
    assert r.status_code == 200
    assert r.get_json()["reachable"] is False


def test_reconnect_reaches_the_satellites_own_load_with_local_card_names(client, settings_file,
                                                                        monkeypatch):
    """🔴 Every test above stops at `apply_plan`, one call short of where the harm would be.

    That is the shape three 5.3.1 defects had: the function answered correctly and nothing used
    the answer. So this one stubs the CLIENT instead and asserts what crosses the wire — because
    `Engine.load` is keyed on the satellite's OWN device names. Handing it `{'test-satellite:cuda:0': 2}`
    would be accepted, match no card, and load nothing at all, with a 200 and a cheerful log.
    """
    _test_satellite(client, monkeypatch, loaded={})

    class _Client:
        def __init__(self):
            self.plans = []

        def load(self, plan):
            self.plans.append(dict(plan))
            return {"loaded": plan, "sr": 24000, "devices": list(plan)}

    fake = _Client()
    monkeypatch.setattr(sat_mod, "client_for", lambda n: fake)
    # The save's own reconcile is stubbed out in `_test_satellite`, so nothing but the reconnect below can
    # reach this client — see the note there about the background thread.
    _save(client, [{"id": "cuda:0", "enabled": True},
                   {"id": "test-satellite:cuda:0", "enabled": True}])

    assert client.post("/satellites/test-satellite/reconnect").status_code == 200
    assert fake.plans == [{"cuda:0": 1}], (
        f"the satellite must use its own card names, not local IDs: {fake.plans}")


def test_reconnect_to_an_unknown_satellite_is_a_404(client, settings_file, monkeypatch):
    called = []
    monkeypatch.setattr(sat_mod, "apply_plan", lambda p: called.append(p))
    assert client.post("/satellites/nope/reconnect").status_code == 404
    assert called == [], "an unknown name must not reach the network"


# ── the panel has to SHOW the divergence, not merely be able to fix it ────────

def test_the_rows_report_what_each_satellite_card_is_actually_holding(client, settings_file,
                                                                     monkeypatch):
    """Show saved worker intent and the satellite's current loaded count together. After a restart,
the saved count can remain nonzero while the live count is zero; exposing both makes that
 divergence visible."""
    _test_satellite(client, monkeypatch, loaded={"cuda:0": 0})
    _save(client, [{"id": "cuda:0", "enabled": True},
                   {"id": "test-satellite:cuda:0", "enabled": True}])
    rows = {d["id"]: d for d in client.get("/devices").get_json()["devices"]}
    # A ticked row asks for exactly one replica now, so `loaded: 0` IS the divergence and the
    # page has both halves of it: the tick (intent) and this number (fact).
    assert rows["test-satellite:cuda:0"]["enabled"] is True, "what settings ask for"
    assert rows["test-satellite:cuda:0"]["loaded"] == 0, "what the satellite actually holds"


def test_an_unreachable_card_reports_loaded_as_unknown_not_as_zero(client, settings_file,
                                                                  monkeypatch):
    """`None`, never 0. We do not know what a sleeping box holds, and "0 loaded" printed beside
    "(not running)" reads as a second, contradictory fault."""
    _test_satellite(client, monkeypatch, loaded={}, reachable=False)
    _save(client, [{"id": "cuda:0", "enabled": True},
                   {"id": "test-satellite:cuda:0", "enabled": True}])
    rows = {d["id"]: d for d in client.get("/devices").get_json()["devices"]}
    assert rows["test-satellite:cuda:0"]["loaded"] is None
