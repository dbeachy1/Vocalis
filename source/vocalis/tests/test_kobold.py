"""4.7-m1 — the KoboldCpp tab's engine.

Everything here runs on the Windows dev box with NO Kobold, which is the point: the admin
API is mocked at the HTTP boundary and no test may depend on a real Kobold.

The fixtures reflect KoboldCpp's documented config shapes. Expected values are explicit so the
tests verify both parsing and derivation rather than comparing an implementation to itself.

The model names below are synthetic. They cover a star, an NN- prefix, a sharded model_param in a
subdirectory, and varied punctuation without relying on any host model inventory.
"""
import json
import socket

import pytest

import kobold


# ── fixtures ────────────────────────────────────────────────────────────────

CONFIGS = {
    "01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps": {
        "model_param": "/ai-models/Nightfall-Aurora-72B-A3B-Chat-tuned.Q6_K_S.gguf",
        "contextsize": 98304, "gpulayers": 999, "usevulkan": [1, 2],
    },
    # Sharded AND in a subdirectory — both halves of why a gguf scan gets the wrong answer.
    "02-★-Coauthor-Prose-Ember-Steam-103B.kcpps": {
        "model_param": "/ai-models/Riverstone_Ember-Steam-103B-A12B-v1/"
                       "Riverstone_Ember-Steam-103B-A12B-v1-IQ4_XS-00001-of-00002.gguf",
        "contextsize": 98304, "gpulayers": 999, "usevulkan": [1, 2],
    },
    "03-★-Coauthor-Scans-Solace-120B.kcpps": {
        "model_param": "/ai-models/Solace-120B-A10B-tuned-v1.i1-IQ4_S.gguf",
        "contextsize": 131072, "gpulayers": 999, "usevulkan": [1, 2],
    },
    "10-Alt-Nightfall-Aurora-72B-Q3.kcpps": {
        "model_param": "/ai-models/Nightfall-Aurora-72B-A3B-Chat-tuned.Q3_K_M.gguf",
        "contextsize": 98304, "gpulayers": 999, "usevulkan": [1, 2],
    },
}


CFG_STAR = "01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps"


@pytest.fixture
def admindir(tmp_path):
    d = tmp_path / "kcpps"
    d.mkdir()
    for name, body in CONFIGS.items():
        (d / name).write_text(json.dumps(body), encoding="utf-8")
    return d


@pytest.fixture
def cfg(admindir):
    return kobold.KoboldConfig(url="https://127.0.0.1:5001", adminpassword="pw",
                               local=True, admindir=admindir)


class FakeKobold:
    """The admin API, mocked at the HTTP boundary — shaped from source, not imagination."""

    def __init__(self, configs=None, model="inactive", authed=True, admin=2):
        self.configs = list(CONFIGS) if configs is None else list(configs)
        self.model, self.authed, self.admin = model, authed, admin
        self.loaded = []

    def __call__(self, cfg, path, body=None, timeout=10.0):
        if path == "/api/extra/version":
            return {"result": "KoboldCpp", "version": "1.116.1", "protected": False,
                    "llm": self.model != "inactive", "admin": self.admin}
        if path == "/api/v1/model":
            # Unauthenticated reads get a FAKE success, not a 401 (koboldcpp.py:6174).
            return {"result": self.model if self.authed else kobold.PROTECTED_SENTINEL}
        if path == "/api/admin/list_options":
            # [] on auth failure — a 200, not a 401 (koboldcpp.py:6199-6202). Kobold appends
            # the two pseudo-configs unconditionally.
            if not self.authed:
                return []
            return self.configs + ["initial_model", "unload_model"]
        if path == "/api/admin/reload_config":
            self.loaded.append(body["filename"])
            return {"success": True}          # QUEUED, not done
        raise AssertionError(f"unexpected path {path}")


@pytest.fixture
def fake(monkeypatch):
    f = FakeKobold()
    monkeypatch.setattr(kobold, "_request", f)
    return f


# ── resolve_config: env -> settings -> default ──────────────────────────────

def test_resolve_config_default(monkeypatch):
    monkeypatch.delenv("VOCALIS_KOBOLD_URL", raising=False)
    c = kobold.resolve_config({})
    assert c.url == "https://127.0.0.1:5001"
    assert c.adminpassword == ""          # no password -> writes disabled
    assert c.local is True                 # loopback default


def test_the_docker_image_has_no_built_in_kobold_address(monkeypatch):
    """Release audit 2026-10-11, item 8. 127.0.0.1 inside the container is the container itself,
    so the old default opened the tab on "KoboldCpp isn't answering at https://127.0.0.1:5001"
    for a server nobody had ever pointed it at. An empty URL is "not set up yet"."""
    monkeypatch.delenv("VOCALIS_KOBOLD_URL", raising=False)
    monkeypatch.setenv("VOCALIS_REQUIRE_VAULT", "1")
    c = kobold.resolve_config({})
    assert c.url == "", c.url
    assert c.local is False, "an empty address is not 'this machine'"
    with pytest.raises(kobold.KoboldUnreachable, match="no URL configured"):
        kobold.version(c)
    # An address the user DID set still wins, in Docker as anywhere.
    monkeypatch.setenv("VOCALIS_KOBOLD_URL", "http://host.docker.internal:5001/")
    assert kobold.resolve_config({}).url == "http://host.docker.internal:5001"
    # And a saved address from Settings is honored too.
    monkeypatch.delenv("VOCALIS_KOBOLD_URL")
    assert kobold.resolve_config({"kobold": {"url": "http://box:5001"}}).url == "http://box:5001"


def test_config_dir_readable_is_false_for_a_folder_this_process_cannot_see(tmp_path):
    assert kobold.config_dir_readable(
        kobold.KoboldConfig(url="http://x", admindir=tmp_path)) is True
    assert kobold.config_dir_readable(
        kobold.KoboldConfig(url="http://x", admindir=tmp_path / "not-mounted")) is False


def test_parse_can_skip_the_model_file_probe(cfg):
    """Docker: `model_param` is a HOST path the container cannot see, so 'does it exist' would
    answer a false 'missing' for every config. The field must be absent, not False."""
    d = kobold.parse_kcpps(cfg, "03-★-Coauthor-Scans-Solace-120B.kcpps", verify_model=False)
    assert d["contextsize"] == 131072 and d["model_param"]
    assert "model_exists" not in d, d


def test_resolve_config_settings_beat_default():
    c = kobold.resolve_config({"kobold": {"url": "https://box:5001/"}},
                              {"adminpassword": "s"})
    assert c.url == "https://box:5001"     # trailing slash normalized off
    assert c.adminpassword == "s"


def test_resolve_config_env_beats_settings(monkeypatch):
    monkeypatch.setenv("VOCALIS_KOBOLD_URL", "https://env:5001")
    monkeypatch.setenv("VOCALIS_KOBOLD_ADMINPASSWORD", "envpw")
    c = kobold.resolve_config({"kobold": {"url": "https://file:5001"}}, {"adminpassword": "filepw"})
    assert c.url == "https://env:5001"
    assert c.adminpassword == "envpw"


# ── the admin password is a SECRET, and app_settings.yaml is not encrypted ───

def test_app_settings_can_no_longer_supply_the_admin_password(monkeypatch):
    """🔴 THE POINT OF THE MOVE, pinned so it cannot drift back.

    app_settings.yaml is exempt from the vault because it must be readable BEFORE unlock, and
    that exemption was justified as "no user content". A password there is plaintext on disk
    forever. If someone re-adds the app_settings fallback "for compatibility", the secret
    silently starts living in the clear again and nothing else would notice — so the fallback
    is asserted GONE, not merely deprioritized.
    """
    monkeypatch.delenv("VOCALIS_KOBOLD_ADMINPASSWORD", raising=False)
    c = kobold.resolve_config({"kobold": {"url": "https://box:5001", "adminpassword": "leaked"}})
    assert c.adminpassword == "", "the admin password was read from the UNENCRYPTED settings file"


def test_a_locked_vault_yields_no_password_rather_than_a_stale_one(monkeypatch):
    """Locked means `secrets` is {} — reads keep working, admin writes are disabled until
    login. Resolving to "" is what `can_admin()` reads as 'not configured'."""
    monkeypatch.delenv("VOCALIS_KOBOLD_ADMINPASSWORD", raising=False)
    c = kobold.resolve_config({"kobold": {"url": "https://box:5001"}}, {})
    assert c.adminpassword == ""
    assert c.url == "https://box:5001"     # the non-secret half still resolves while locked


def test_resolve_config_survives_a_hand_edited_scalar():
    """`kobold: "oops"` in the YAML must not raise — _load_app_settings sets the same
    defensive tone with its isinstance check."""
    c = kobold.resolve_config({"kobold": "oops"})
    assert c.url == "https://127.0.0.1:5001"


# ── locality (§2b) — the dev box is the ideal rig: no Kobold either way ──────

@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "::1"])
def test_local_loopback_literals(host):
    url = f"https://[{host}]:5001" if host == "::1" else f"https://{host}:5001"
    assert kobold._is_local(url) is True


def test_local_own_hostname_is_the_common_case():
    """A loopback-only check would classify the machine's own hostname as remote and disable
    local-only behavior even when its configured certificate covers that hostname."""
    assert kobold._is_local(f"https://{socket.gethostname()}:5001") is True
    assert kobold._is_local(f"https://{socket.getfqdn()}:5001") is True


def test_local_unrelated_host_is_remote():
    assert kobold._is_local("https://some-other-box.example:5001") is False


def test_explicit_local_overrides_in_both_directions():
    assert kobold._is_local("https://some-other-box:5001", explicit=True) is True
    assert kobold._is_local("https://127.0.0.1:5001", explicit=False) is False


def test_explicit_local_setting_from_yaml():
    c = kobold.resolve_config({"kobold": {"url": "https://elsewhere:5001", "local": True}})
    assert c.local is True
    c = kobold.resolve_config({"kobold": {"url": "https://127.0.0.1:5001", "local": False}})
    assert c.local is False


def test_env_local_overrides(monkeypatch):
    monkeypatch.setenv("VOCALIS_KOBOLD_LOCAL", "false")
    assert kobold.resolve_config({"kobold": {"url": "https://127.0.0.1:5001"}}).local is False


# ── TLS: the carve-out is local-only, and cafile outranks it ────────────────

def test_cafile_beats_the_no_verify_carve_out():
    """A trusted CA file verifies the configured hostname and may also cover the loopback
    address. The no-verify branch is only a local fallback when no CA file is configured."""
    import ssl
    c = kobold.KoboldConfig(url="https://127.0.0.1:5001", local=True, cafile="")
    assert kobold._ssl_context(c).verify_mode == ssl.CERT_NONE     # local fallback
    c_remote = kobold.KoboldConfig(url="https://elsewhere:5001", local=False, cafile="")
    assert kobold._ssl_context(c_remote).verify_mode == ssl.CERT_REQUIRED


def test_remote_never_disables_verification():
    """Remote, the no-verify flag would put the admin password on a LAN hop in a Bearer
    header with no way to know who caught it."""
    import ssl
    c = kobold.KoboldConfig(url="https://some-box:5001", local=False)
    assert kobold._ssl_context(c).verify_mode == ssl.CERT_REQUIRED


# ── the list, and what [] means ─────────────────────────────────────────────

def test_list_filters_the_pseudo_configs(cfg, fake):
    names = kobold.list_configs(cfg)
    assert "initial_model" not in names and "unload_model" not in names
    assert len(names) == 4


def test_empty_list_is_an_auth_failure_never_no_configs(cfg, fake):
    """[] means wrong password OR admin off OR missing admindir OR genuinely empty — one
    200 response for all four, with no way to tell them apart. m0 reproduced this live."""
    fake.authed = False
    with pytest.raises(kobold.KoboldAuthFailed) as e:
        kobold.list_configs(cfg)
    assert "no configs" not in str(e.value).lower().replace("does not mean there are no", "")


def test_list_keeps_a_bare_gguf(cfg, fake):
    """valid_exts is (.kcpps, .kcppt, .gguf), so a GGUF placed in --admindir is also listed."""
    fake.configs = list(CONFIGS) + ["Loose-Model-8B.gguf"]
    assert "Loose-Model-8B.gguf" in kobold.list_configs(cfg)


def test_list_drops_a_stray_non_config(cfg, fake):
    fake.configs = list(CONFIGS) + ["notes.txt"]
    assert "notes.txt" not in kobold.list_configs(cfg)


# ── m0's finding: the scan descends a level, so names are PATHS ─────────────

def test_subdirectory_configs_survive_with_their_prefix(cfg, fake):
    """scan_directory(..., depth=1) descends one level and returns relative paths. A backup
    folder therefore creates another loadable entry for each config; keep each path prefix.

    Do NOT "fix" this by filtering names containing '/': Kobold offers them, Kobold loads
    them, and Kobold's own admin UI already lists all eight."""
    dupes = [".ssl-backup-backup/" + n for n in CONFIGS]
    fake.configs = list(CONFIGS) + dupes
    names = kobold.list_configs(cfg)
    assert len(names) == 8
    assert ".ssl-backup-backup/01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps" in names


def test_the_subdir_prefix_stays_visible_in_the_label():
    """The prefix is the ONLY thing telling a live config from a stale backup copy. Hide it
    and Load becomes a coin flip between two identically-labeled rows."""
    live = kobold.display_label("01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps")
    backup = kobold.display_label(".ssl-backup-backup/01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps")
    assert live == "01-★-Chat-Nightfall-Aurora-72B-Q6"     # the filename, verbatim
    assert backup != live
    assert ".ssl-backup-backup/" in backup


def test_the_label_is_the_filename_and_nothing_is_read_into_it():
    """Vocalis interprets no part of a config's name. The filename is data, including its prefix
    and any star characters."""
    assert kobold.display_label("01-★-Chat.kcpps") == "01-★-Chat"     # NN- kept
    assert kobold.display_label("plain.kcpps") == "plain"
    assert not hasattr(kobold, "is_starred")                          # the rule is gone, not disabled


def test_a_config_name_may_contain_a_slash_and_still_resolve(cfg, admindir):
    sub = admindir / ".ssl-backup-backup"
    sub.mkdir()
    (sub / "01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps").write_text(
        json.dumps(CONFIGS["01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps"]), encoding="utf-8")
    d = kobold.parse_kcpps(cfg, ".ssl-backup-backup/01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps")
    assert d["contextsize"] == 98304


def test_a_name_escaping_the_admindir_is_refused(cfg):
    assert kobold.kcpps_path(cfg, "../../etc/passwd") is None
    assert "error" in kobold.parse_kcpps(cfg, "../../etc/passwd")


# ── ordering: ★ pins to top ─────────────────────────────────────────────────

def test_a_star_in_a_name_gets_NO_special_treatment():
    """KoboldCpp has no favorite concept, so a star in a filename must not affect ordering.
    Sorting on that assumption would put a starred name above an unstarred one without a rule.

    The fixture must DISAGREE with the numbering or it proves nothing."""
    names = ["01-Alpha.kcpps", "99-★-Zed.kcpps"]
    assert sorted(names, key=kobold.sort_key) == ["01-Alpha.kcpps", "99-★-Zed.kcpps"]


def test_sorts_by_the_stem():
    names = ["02-Beta.kcpps", "01-★-Alpha.kcpps", "20-Zulu.kcpps", "10-Mike.kcpps"]
    assert sorted(names, key=kobold.sort_key) == [
        "01-★-Alpha.kcpps", "02-Beta.kcpps", "10-Mike.kcpps", "20-Zulu.kcpps"]


def test_sorts_by_stem_not_by_the_subdir_prefix():
    names = ["zz/01-Alpha.kcpps", "02-Beta.kcpps"]
    assert sorted(names, key=kobold.sort_key)[0] == "zz/01-Alpha.kcpps"


def test_a_backup_copy_never_outranks_the_live_config_it_copies():
    """The live and backup entries tie on their stem, so stable ordering can put the backup first.
    This fixture keeps both entries to verify the live config remains the default.

    Both entries have the same stem, so they tie on every other term, and Python's stable
    sort then preserves list_options' order — which puts the subfoldered ones FIRST (Kobold
    scans `sorted(os.listdir())`, and '.ssl-backup-backup' sorts before '01-'). The
    the picker would select a stale backup instead of the live config."""
    live = "01-★-Chat.kcpps"
    backup = ".ssl-backup-backup/01-★-Chat.kcpps"
    assert sorted([backup, live], key=kobold.sort_key) == [live, backup]
    cfg = kobold.KoboldConfig(url="https://x:5001")
    assert kobold.pick_default(cfg, sorted([backup, live], key=kobold.sort_key)) == live


def test_dupes_sit_adjacent_so_the_duplication_is_visible():
    """Sorting by stem before depth keeps each config next to its copy, so two rows with the
    same name are obviously two rows with the same name rather than scattered."""
    names = [".bak/02-★-B.kcpps", "01-★-A.kcpps", ".bak/01-★-A.kcpps", "02-★-B.kcpps"]
    assert sorted(names, key=kobold.sort_key) == [
        "01-★-A.kcpps", ".bak/01-★-A.kcpps", "02-★-B.kcpps", ".bak/02-★-B.kcpps"]


def test_display_label_drops_only_the_extension():
    assert kobold.display_label("01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps") == \
        "01-★-Chat-Nightfall-Aurora-72B-Q6"
    assert kobold.display_label("10-Alt-Nightfall-Aurora-72B-Q3.kcpps") == \
        "10-Alt-Nightfall-Aurora-72B-Q3"


# ── the derivation (§3a-bis) — m0-confirmed against the private oracle ───────

def test_derivation_matches_the_precomputed_table():
    """The API's model name is derived from the configured model parameter; these cases pin the
    resulting string for representative configs."""
    assert kobold.derive_model_name(CONFIGS["01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps"]["model_param"]) == \
        "koboldcpp/Nightfall-Aurora-72B-A3B-Chat-tuned.Q6_K_S"
    assert kobold.derive_model_name(CONFIGS["03-★-Coauthor-Scans-Solace-120B.kcpps"]["model_param"]) == \
        "koboldcpp/Solace-120B-A10B-tuned-v1.i1-IQ4_S"
    assert kobold.derive_model_name(CONFIGS["10-Alt-Nightfall-Aurora-72B-Q3.kcpps"]["model_param"]) == \
        "koboldcpp/Nightfall-Aurora-72B-A3B-Chat-tuned.Q3_K_M"


def test_the_shard_suffix_survives_into_the_reported_name():
    """-00001-of-00002 is part of the string. Derive it; never hand-write it."""
    assert kobold.derive_model_name(
        CONFIGS["02-★-Coauthor-Prose-Ember-Steam-103B.kcpps"]["model_param"]) == \
        "koboldcpp/Riverstone_Ember-Steam-103B-A12B-v1-IQ4_XS-00001-of-00002"


def test_sanitize_strips_rather_than_replaces():
    """re.sub(r'[^\\w\\d\\.\\-_]', '', ...) — 'Foo Bar' -> 'FooBar', not 'Foo_Bar'."""
    assert kobold.derive_model_name("/m/Foo Bar+Baz.gguf") == "koboldcpp/FooBarBaz"
    assert kobold.sanitize_string("a b+c") == "abc"


# ── status ──────────────────────────────────────────────────────────────────

def test_status_inactive(cfg, fake):
    assert kobold.status(cfg) == {"loaded": False, "model": None}


def test_status_loaded(cfg, fake):
    fake.model = "koboldcpp/Nightfall-Aurora-72B-A3B-Chat-tuned.Q6_K_S"
    st = kobold.status(cfg)
    assert st["loaded"] is True and st["model"] == fake.model


def test_protected_model_is_an_auth_failure_not_a_model(cfg, fake):
    """koboldcpp/protected-model is a fake success (a 200) that appears when a user sets
    --password. Reporting it as a loaded model would name a model that doesn't exist."""
    fake.authed = False
    with pytest.raises(kobold.KoboldAuthFailed):
        kobold.status(cfg)


# ── reconciliation ──────────────────────────────────────────────────────────

def test_exact_hit_names_the_config(cfg, fake):
    r = kobold.reconcile(cfg, "koboldcpp/Solace-120B-A10B-tuned-v1.i1-IQ4_S", list(CONFIGS))
    assert r["config"] == "03-★-Coauthor-Scans-Solace-120B.kcpps"
    assert r["how"] == "derived"


def test_no_match_says_loaded_outside_vocalis(cfg, fake):
    r = kobold.reconcile(cfg, 'koboldcpp/Sample-Model-Loaded-By-Hand', list(CONFIGS))
    assert r["config"] is None and r["how"] == "outside"


def test_a_copy_of_a_config_ties_with_its_original_and_the_load_record_breaks_it(cfg, admindir):
    """A stray .ssl-backup-backup/ folder means every config ties with its
    own copy (identical model_param -> identical friendlymodelname), and Kobold's list
    descends a subdir level so both are offered. The design called ties a narrow corner
    (the fixture contains no duplicate non-backup configs).

    Unbroken, the tab reports "loaded outside Vocalis" for a model Vocalis just loaded. What
    breaks the tie is the one thing that outranks a derivation: we loaded X and OBSERVED this
    string appear."""
    sub = admindir / ".ssl-backup-backup"
    sub.mkdir()
    (sub / CFG_STAR).write_text(json.dumps(CONFIGS[CFG_STAR]), encoding="utf-8")
    names = [CFG_STAR, f".ssl-backup-backup/{CFG_STAR}"]
    model = "koboldcpp/Nightfall-Aurora-72B-A3B-Chat-tuned.Q6_K_S"

    r = kobold.reconcile(cfg, model, names)          # nobody loaded it -> genuinely ambiguous
    assert r["config"] is None and r["how"] == "ambiguous"

    cfg.model_map = {CFG_STAR: model}                 # ...but Vocalis loaded THIS one
    r = kobold.reconcile(cfg, model, names)
    assert r["config"] == CFG_STAR and r["how"] == "learned"


def test_a_tie_refuses_to_guess(cfg, admindir):
    """Two kcpps naming the same model_param at different contextsize collide on ONE
    friendlymodelname. Narrow, but a tie is not a license to pick one."""
    (admindir / "90-Twin.kcpps").write_text(
        json.dumps({"model_param": CONFIGS["01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps"]["model_param"],
                    "contextsize": 4096}), encoding="utf-8")
    names = list(CONFIGS) + ["90-Twin.kcpps"]
    r = kobold.reconcile(cfg, "koboldcpp/Nightfall-Aurora-72B-A3B-Chat-tuned.Q6_K_S", names)
    assert r["config"] is None and r["how"] == "ambiguous"
    assert len(r["candidates"]) == 2


def test_remote_falls_back_to_the_learned_mapping(admindir):
    """Remote, model_param is on the other box and there is no endpoint that serves it — so
    the derivation is impossible and observation is the honest substitute."""
    c = kobold.KoboldConfig(url="https://elsewhere:5001", local=False, admindir=admindir,
                            model_map={"01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps": "koboldcpp/X"})
    r = kobold.reconcile(c, "koboldcpp/X", list(CONFIGS))
    assert r["config"] == "01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps"
    assert r["how"] == "learned"


def test_remote_with_no_mapping_yet_says_outside(admindir):
    c = kobold.KoboldConfig(url="https://elsewhere:5001", local=False, admindir=admindir)
    assert kobold.reconcile(c, "koboldcpp/Unknown", list(CONFIGS))["how"] == "outside"


def test_a_fresh_local_derivation_outranks_a_stale_learned_mapping(cfg):
    """The map goes stale when a user repoints a kcpps at another GGUF. Locally, the derivation
    re-reads the file and catches that; the cache is a hint, never an authority."""
    cfg.model_map = {"10-Alt-Nightfall-Aurora-72B-Q3.kcpps":
                     "koboldcpp/Solace-120B-A10B-tuned-v1.i1-IQ4_S"}     # stale: wrong config
    r = kobold.reconcile(cfg, "koboldcpp/Solace-120B-A10B-tuned-v1.i1-IQ4_S", list(CONFIGS))
    assert r["config"] == "03-★-Coauthor-Scans-Solace-120B.kcpps"        # the DERIVED answer
    assert r["how"] == "derived"


# ── the default the drop-down opens on ──────────────────────────────────────

def test_default_prefers_the_loaded_config(cfg):
    cfg.last_config = "10-Alt-Nightfall-Aurora-72B-Q3.kcpps"
    got = kobold.pick_default(cfg, list(CONFIGS), loaded_config="03-★-Coauthor-Scans-Solace-120B.kcpps")
    assert got == "03-★-Coauthor-Scans-Solace-120B.kcpps"    # live truth wins


def test_default_is_last_config_when_nothing_is_loaded(cfg):
    cfg.last_config = "10-Alt-Nightfall-Aurora-72B-Q3.kcpps"
    assert kobold.pick_default(cfg, list(CONFIGS)) == "10-Alt-Nightfall-Aurora-72B-Q3.kcpps"


def test_a_deleted_last_config_falls_back_to_the_first_never_an_error(cfg):
    """Never an error, never an empty select."""
    cfg.last_config = "77-Deleted-Long-Ago.kcpps"
    got = kobold.pick_default(cfg, sorted(CONFIGS, key=kobold.sort_key))
    assert got == "01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps"     # first by stem, not by ★


def test_the_fallback_is_the_first_in_sort_order_and_a_star_does_not_promote_it(cfg):
    """Proves the fallback is position, not the ★. The old rule would have picked the starred
    one; the fixture must disagree with sort order or it proves nothing."""
    names = sorted(["10-Alt.kcpps", "20-★-Beta.kcpps"], key=kobold.sort_key)
    assert kobold.pick_default(cfg, names) == "10-Alt.kcpps"


def test_default_on_an_empty_list_is_empty_not_an_error(cfg):
    assert kobold.pick_default(cfg, []) == ""


# ── kcpps parsing ───────────────────────────────────────────────────────────

def test_parse_reads_the_detail_line(cfg):
    d = kobold.parse_kcpps(cfg, "03-★-Coauthor-Scans-Solace-120B.kcpps")
    assert d["contextsize"] == 131072 and d["gpulayers"] == 999
    assert d["model_exists"] is False        # the fixture's /ai-models path isn't on this box


def test_a_corrupt_kcpps_skips_that_config_rather_than_500ing_the_tab(cfg, admindir):
    (admindir / "50-Corrupt.kcpps").write_text("{not json", encoding="utf-8")
    d = kobold.parse_kcpps(cfg, "50-Corrupt.kcpps")
    assert "error" in d                       # reported, not raised


def test_a_missing_kcpps_is_reported_not_raised(cfg):
    assert kobold.parse_kcpps(cfg, "nope.kcpps")["error"] == "not found"


def test_model_exists_is_true_for_a_real_file(cfg, admindir, tmp_path):
    real = tmp_path / "real.gguf"
    real.write_bytes(b"x")
    (admindir / "60-Real.kcpps").write_text(
        json.dumps({"model_param": str(real), "contextsize": 4096}), encoding="utf-8")
    assert kobold.parse_kcpps(cfg, "60-Real.kcpps")["model_exists"] is True


# ── load ────────────────────────────────────────────────────────────────────

def test_load_posts_the_filename_verbatim_star_and_all(cfg, fake):
    kobold.load(cfg, "01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps")
    assert fake.loaded == ["01-★-Chat-Nightfall-Aurora-72B-Q6.kcpps"]


def test_unload_posts_the_pseudo_config(cfg, fake):
    kobold.unload(cfg)
    assert fake.loaded == ["unload_model"]


def test_available_is_false_without_a_kobold_and_never_raises(monkeypatch):
    def boom(*a, **k):
        raise kobold.KoboldUnreachable("Connection refused")
    monkeypatch.setattr(kobold, "_request", boom)
    ok, err = kobold.available(kobold.KoboldConfig(url="https://127.0.0.1:5001"))
    assert ok is False and "refused" in err
