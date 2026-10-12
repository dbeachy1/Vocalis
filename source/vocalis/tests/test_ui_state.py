"""5.0-M8 — ui_state.py, the server-side UI-state store, at the unit level.

The vault-facing behavior (encrypted at rest, the endpoint, inert-without-a-vault) lives in
tests/test_m6_e2e.py, because only that file turns a vault on. This file pins the pure logic that
does not need one: the write filter and the non-strict loader.
"""
import re

from conftest import REPO_ROOT

import ui_state


def test_the_two_client_only_lists_agree():
    """The Python and JavaScript client-only state allowlists must match so keys cannot be stored on only one side."""
    # 🔴 THE HAYSTACK MOVED AT 7.3-m13 AND THE DRIFT IT GUARDS DID NOT. `UIS` was a top-level IIFE
    # in index.html for as long as there was an inline script to hold it; §10 items 1 and 2 deleted
    # that script, and the factory is `js/util/uistate.js` now. The two lists still have to agree,
    # and the cost of them disagreeing is unchanged — a key in Python but not JS is DELETED from
    # localStorage on every boot, which is exactly what 7.2-m3 did to `vocalis-ui-font`.
    #
    # ⚠️ NOT `index.html` WITH A FALLBACK. A guard that searches two places and passes if either
    # matches would have gone on passing through the whole move while measuring the wrong file. One
    # location, asserted to exist, so a future move fails here by name.
    page = (REPO_ROOT / "src" / "webui" / "js" / "util" / "uistate.js").read_text(encoding="utf-8")
    m = re.search(r"const\s+CLIENT_ONLY\s*=\s*new Set\(\[([^\]]*)\]\)", page)
    assert m, ("the UIS CLIENT_ONLY set is gone or reshaped in js/util/uistate.js — this guard is "
               "now blind, fix it")
    in_js = set(re.findall(r"['\"]([^'\"]+)['\"]", m.group(1)))
    assert in_js == set(ui_state.CLIENT_ONLY), (
        "the device-local key lists have drifted.\n"
        f"  index.html : {sorted(in_js)}\n"
        f"  ui_state.py: {sorted(ui_state.CLIENT_ONLY)}\n"
        "A key in Python but not JS is DELETED from localStorage on every boot; a key in JS but "
        "not Python is accepted into the encrypted store when it was meant to stay device-local.")


def test_sanitize_drops_device_local_and_foreign_keys():
    """The write filter is the line between "the browser POSTed something" and "we wrote it into
    the store". theme/vol are device-local and must never sync; a key without the vocalis- prefix
    is not ours."""
    out = ui_state.sanitize({
        "vocalis-tab": "book",
        "vocalis-pg-text": "hello",
        "vocalis-theme": "dark",     # device-local
        "vocalis-vol": "0.5",        # device-local
        "evil": "x",                 # no prefix
        "vocalis-none": None,        # null dropped
    })
    assert out == {"vocalis-tab": "book", "vocalis-pg-text": "hello"}


def test_sanitize_coerces_values_to_strings_and_caps_length():
    """localStorage only ever held strings; a stale/hostile client must not be able to stuff the
    vault file with megabytes. The tail is truncated rather than the whole save rejected."""
    out = ui_state.sanitize({"vocalis-pg-cap": 1, "vocalis-pg-text": "x" * (2 * 1024 * 1024)})
    assert out["vocalis-pg-cap"] == "1"
    assert len(out["vocalis-pg-text"]) == ui_state._MAX_VALUE_LEN


def test_sanitize_of_a_non_dict_is_empty():
    assert ui_state.sanitize("not a dict") == {}
    assert ui_state.sanitize(None) == {}


def test_load_of_a_missing_file_is_empty(tmp_path):
    assert ui_state.load(tmp_path / "nope.yaml") == {}


def test_load_of_an_unparseable_file_degrades_to_empty(tmp_path):
    """A corrupt CONVENIENCE store must not break the page — it defaults, like voice_utils does.
    (A wrong DEK is different: VaultAuthError is a BaseException and propagates, tested in e2e.)"""
    p = tmp_path / "ui_state.yaml"
    p.write_text("{{{ not yaml", encoding="utf-8")
    assert ui_state.load(p) == {}


def test_load_of_a_non_mapping_is_empty(tmp_path):
    p = tmp_path / "ui_state.yaml"
    p.write_text("- a\n- b\n", encoding="utf-8")     # a list, not a mapping
    assert ui_state.load(p) == {}


def test_the_account_keys_and_client_keys_are_disjoint_and_cover_them_all():
    """The account keys + the 2 device-local keys are the ones the UI actually uses. A drift here
    (a key added to one set that overlaps the other) would silently sync a device-local pref or
    strand an account one."""
    assert ui_state.ACCOUNT_KEYS.isdisjoint(ui_state.CLIENT_ONLY)
    assert len(ui_state.ACCOUNT_KEYS) == 19
    # `vocalis-ui-font` joined in 7.2-m3. ⚠️ IT IS HERE FOR A MECHANICAL REASON, NOT A POLICY ONE,
    # and the distinction matters if anyone is tempted to "tidy" it out: the text size is read by
    # a <script> in <head> BEFORE FIRST PAINT, so it cannot wait for the account state the server
    # injects later without the page visibly resizing after it has been drawn — exactly why
    # `theme` is here. The AUTHORITATIVE copy is `ui_font_px` in app settings, so the preference
    # does follow the user to another machine; this entry only permits a render-time cache that
    # UIS's boot sweep would otherwise delete.
    assert ui_state.CLIENT_ONLY == {"vocalis-theme", "vocalis-vol", "vocalis-ui-font"}


def test_the_page_never_stores_an_account_key_in_raw_localstorage():
    """Account credentials must not be written to unencrypted browser local storage."""
    page = (REPO_ROOT / "src" / "webui" / "index.html").read_text(encoding="utf-8")
    # ⚠️ Both quote styles and any word character. The old pattern was single-quote-only and
    # `[a-z-]+`, so `setItem("vocalis-sttab", …)` or `'vocalis-tab2'` walked straight past the
    # one check that exists to stop a fourth instance of this bug — and the key would then be
    # swept out of localStorage by UIS on the next boot, with a green suite.
    used = set(re.findall(r"""localStorage\.(?:get|set|remove)Item\(\s*['"](vocalis-[\w-]+)['"]""",
                          page))
    assert used <= set(ui_state.CLIENT_ONLY), (
        f"these keys go through raw localStorage, which UIS deletes on boot: "
        f"{sorted(used - set(ui_state.CLIENT_ONLY))} — use UIS.getItem/setItem instead")


# ── 8.0-m21: the per-key delta, the fix for the two-tab clobber ──────────────────────────────
# A whole-blob PUT from one window overwrites every other window's newer keys; apply_delta is
# what makes concurrent windows safe. The browser-level reproduction lives in
# tests/test_ace_draft_persistence_browser.py::test_a_second_open_tab_cannot_erase_the_first_tabs_pick.

def test_apply_delta_merges_instead_of_replacing(tmp_path):
    p = tmp_path / "ui_state.yaml"
    ui_state.save(p, {"vocalis-tab": "acestep", "vocalis-ace-draft": "{\"tpl\": \"t1\"}"})
    # A second writer touches ONE key; the draft it never mentions must survive.
    merged = ui_state.apply_delta(p, {"vocalis-tab": "voices"}, [])
    assert merged["vocalis-tab"] == "voices"
    assert merged["vocalis-ace-draft"] == "{\"tpl\": \"t1\"}"
    assert ui_state.load(p) == merged


def test_apply_delta_deletes_only_what_it_is_told(tmp_path):
    p = tmp_path / "ui_state.yaml"
    ui_state.save(p, {"vocalis-a": "1", "vocalis-b": "2"})
    merged = ui_state.apply_delta(p, {}, ["vocalis-a", "vocalis-never-existed"])
    assert merged == {"vocalis-b": "2"}


def test_apply_delta_sanitizes_like_a_put(tmp_path):
    """The delta path must not become a side door past the write filter: device-local keys and
    foreign keys are dropped exactly as `save` drops them."""
    p = tmp_path / "ui_state.yaml"
    merged = ui_state.apply_delta(p, {"vocalis-theme": "dark", "evil": "x",
                                      "vocalis-ok": "kept"}, [])
    assert merged == {"vocalis-ok": "kept"}


# ── 9.5.6: every key the front end stores must SURVIVE the write filter ───────────────────────
#
# 🔴 FOUND BY BUILDING A FIXTURE, NOT BY READING. `tests/test_clips_queue_layout_browser.py` seeds
# the enhancement queue through ui-state and reloads the page; the queue came back EMPTY, and the
# reason was that `scenes.js` wrote it under `sc-enhq` — the only one of the front end's 27 UIS
# keys without the `vocalis-` prefix `sanitize` requires. Every flush of that key had been
# discarded at `/ui-state` since 8.2.4 shipped, so the queue never once survived a reload.
#
# ⚠️ IT LOOKED LIKE IT WORKED, WHICH IS WHY IT LASTED FIVE MILESTONES. `UIS` answers reads out of
# its own in-memory copy, so the queue survived tab switches, filters and every re-render — the
# only gesture that could expose it was a page reload with something still queued, and by then the
# obvious explanation is "the queue drained".
#
# 📌 THE PAIRING IS THE CHECK. A test over `sanitize` alone cannot see this: `sanitize` was right.
# A test over the front end alone cannot see it either: `UIS.setItem('sc-enhq', …)` is valid
# JavaScript that does exactly what it says. The defect lives in the SEAM, so the check has to
# read the real key names out of the real modules and put them through the real filter.
_UIS_KEY = re.compile(r"UIS\.(?:set|get|remove)Item\(\s*'([^']+)'")


def test_every_ui_state_key_the_front_end_uses_survives_sanitize():
    from pathlib import Path

    js = Path(REPO_ROOT) / "src" / "webui" / "js"
    keys = set()
    for f in js.rglob("*.js"):
        keys.update(_UIS_KEY.findall(f.read_text(encoding="utf-8")))
    assert len(keys) > 20, (
        f"only {len(keys)} UIS keys found under src/webui/js — the regex has stopped matching the "
        "call shape, so this guard is asserting nothing. Fix the pattern, do not lower the floor.")

    # CLIENT_ONLY keys are dropped ON PURPOSE (theme, volume, text size are properties of the
    # screen you are sitting at) and are read by the pre-paint blocks, never restored from here.
    stored = {k for k in keys if k not in ui_state.CLIENT_ONLY}
    kept = ui_state.sanitize({k: "x" for k in stored})
    lost = sorted(stored - set(kept))
    assert not lost, (
        f"{len(lost)} UI-state key(s) the browser writes are silently DISCARDED by the server: "
        f"{lost}. `sanitize` keeps only keys beginning 'vocalis-', so these never reach the store "
        "and whatever they remember is lost on every reload — with no error anywhere, because "
        "UIS answers reads from its own in-memory copy. Rename the key; do not widen the filter.")
