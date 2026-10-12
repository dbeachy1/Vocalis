"""Release audit 2026-10-11 - nothing a user can reach may lie about what the Docker package is.

The rule for the first public release: a control or text must not fail silently, lie about what it
did, or point at something that does not exist in this package. These tests pin the pieces that are
checkable without a container:

  * the ONE Docker flag the page reads (`/health` -> `docker`), and the other server answers that
    word a text differently in the container (`/settings/app` -> the log file's real location);
  * the page markup that is hidden or reworded in Docker (the manual book path, the "copied into
    output/ by hand" help, the loopback-address advice);
  * a scan of every user-visible string on the page for the names of features that are not in this
    product (Voice Swap, Voice Training, RVC, LoRA Studio, Productions), so they cannot come back;
  * the SillyTavern extension's texts (port, tab names, the name of the pairing panel).

What can only be proven in a running container is listed in the report, not here.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

import vocalis_server as vs
import vocalis.runtime.paths as rt_paths
import vocalis.runtime.settings as rt_settings
from conftest import REPO_ROOT
from vocalis.runtime import auth, page

WEBUI = Path(REPO_ROOT) / "src" / "webui"
EXT = Path(REPO_ROOT) / "sillytavern" / "extension" / "index.js"


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


class _DockerPaths:
    """`vocalis.runtime.paths` as one route module sees it in Docker mode. Patched into that
    module only, so the app's before_request gates keep seeing the ordinary test environment."""

    def __init__(self, real):
        self._real = real

    def docker_encrypted_mode(self):
        return True

    def __getattr__(self, name):
        return getattr(self._real, name)


# ── the one flag ─────────────────────────────────────────────────────────────

def test_health_reports_docker_false_for_a_source_run(client):
    body = client.get("/health").get_json()
    assert body["docker"] is False, body


def test_health_reports_docker_true_in_the_package(client, monkeypatch):
    """/health is the payload the page already polls at load (it carries `initialized` for
    ENCRYPTED), so the flag costs no new request. It is open before the vault exists, which is
    when the page first asks."""
    monkeypatch.setattr(rt_paths, "docker_encrypted_mode", lambda: True)
    monkeypatch.setattr(auth.STORE, "is_initialized", lambda: False)
    monkeypatch.setattr(auth, "auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "creds_broken", lambda: False)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.get_json()["docker"] is True


def test_the_page_poller_writes_the_flag_where_every_text_reads_it():
    """The /health answer must land in `DOCKER` (JS strings) and on `<html data-docker>` (the
    `.docker-only` / `.plain-only` text in the partials)."""
    model = (WEBUI / "js" / "sys" / "model.js").read_text(encoding="utf-8")
    assert "setDocker(h.docker)" in model
    assert "document.documentElement.dataset.docker = DOCKER ? '1' : '0'" in model
    state = (WEBUI / "js" / "sys" / "modelstate.js").read_text(encoding="utf-8")
    assert "export let DOCKER = false;" in state and "export function setDocker(" in state


def test_both_text_variants_stay_hidden_until_the_flag_is_known():
    """Otherwise the page would flash the wrong variant on load."""
    css = (WEBUI / "css" / "base.css").read_text(encoding="utf-8")
    assert re.search(r"html:not\(\[data-docker\]\) \.docker-only", css)
    assert re.search(r"html:not\(\[data-docker\]\) \.plain-only", css)
    assert re.search(r'html\[data-docker="1"\] \.plain-only', css)
    assert re.search(r'html\[data-docker="0"\] \.docker-only', css)


def test_settings_app_gives_the_real_log_location_in_docker(client, monkeypatch, tmp_path):
    """Item 7. /logs/vocalis.log is the container's mount point; the user's file is
    logs/vocalis/vocalis.log inside the data folder chosen at setup (compose.yaml binds it)."""
    monkeypatch.setattr(rt_settings, "APP_SETTINGS", tmp_path / "app_settings.yaml")
    plain = client.get("/settings/app").get_json()
    assert plain["log_path"].endswith("vocalis.log") and plain["log_path_in_data_folder"] is False

    import vocalis.web.ui as ui_mod
    monkeypatch.setattr(ui_mod, "paths", _DockerPaths(ui_mod.paths))
    docker = client.get("/settings/app").get_json()
    assert docker["log_path"] == "logs/vocalis/vocalis.log", docker["log_path"]
    assert docker["log_path_in_data_folder"] is True
    assert not docker["log_path"].startswith("/"), "a container path would be a lie on the host"


def test_the_log_location_has_a_place_to_say_where_it_is():
    settings = (WEBUI / "partials" / "panel-settings.html").read_text(encoding="utf-8")
    st = (WEBUI / "partials" / "panel-sillytavern.html").read_text(encoding="utf-8")
    assert 'id="logPathWhere"' in settings and 'id="stLogPathWhere"' in st
    theme = (WEBUI / "js" / "ui" / "theme.js").read_text(encoding="utf-8")
    assert "inside the data folder you chose at setup" in theme


# ── item 4: the manual book path is not offered in Docker; item 5: true help texts ────────────

def _page() -> str:
    return page.assemble()


def test_the_manual_server_path_is_hidden_in_docker_and_present_otherwise():
    html = _page()
    m = re.search(r'<details class="([^"]*)"[^>]*id="bookManualPath"[^>]*>\s*<summary[^>]*>'
                  r'…or enter a server path manually</summary>', html)
    assert m, "the manual-path disclosure is gone altogether (a plain source run still needs it)"
    assert "plain-only" in m.group(1).split(), \
        "the host-path field must carry plain-only so the Docker page does not offer it"
    # The input stays in the DOM in both modes: the uploaded-book picker fills it.
    assert 'id="path"' in html and 'id="parseBtn"' in html


def test_copied_into_output_by_hand_is_not_promised_in_docker():
    html = _page()
    assert re.search(r'<span class="plain-only"> \(or copied into <code>output/</code> by hand\)</span>', html)
    assert html.count("copied into <code>output/</code> by hand") == 1


def test_loopback_advice_is_docker_only_text_beside_each_llm_address():
    html = _page()
    for fid, who in (("kobUrlDockerNote", "KoboldCpp"), ("llaUrlDockerNote", "llama-server")):
        m = re.search(rf'<div class="[^"]*docker-only[^"]*" id="{fid}"[^>]*>(.*?)</div>', html, re.S)
        assert m, f"{fid} is missing"
        text = m.group(1)
        assert "more than loopback" in text and "127.0.0.1" in text and "container itself" in text
        assert "host.docker.internal" in text and who in text


# ── item 6: the names of features that are not in this product ───────────────────────────────

#: User-visible phrases that point at features the Docker product does not have (subsystems.py:
#: "Voice Swap/RVC and LoRA Studio are not in this product at all", packaging/README.md: "Voice
#: Swap/RVC/Applio, LoRA Studio, Video and Productions"). Matched case-insensitively unless noted.
ABSENT_FEATURE_PHRASES = [
    r"voice[ -]swap",
    r"voice[ -]training",
    r"swap-ready",
    r"learned voice",
    r"trained (?:voice|from)|voices? (?:already )?trained|before training|for training|to train on",
    r"\bapplio\b",
    r"lora studio",
    r"video (?:tab|studio)",
    r"🎓",
    r"train on its row",
]
#: Case-sensitive: "RVC" and the product name "Productions" are only these words.
ABSENT_FEATURE_CASED = [r"\bRVC\b", r"\bProductions\b"]


def _strip_html_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.S)


def user_visible_page_text() -> dict[str, str]:
    """Every file whose strings can reach the user, with comments gone.

    The committed bundle IS the page's JavaScript with comments removed by the bundler, so it is
    the honest comment-free corpus (another test fails if it drifts from the sources). The partials
    and index.html lose their HTML comments here."""
    # The bundler drops comments between statements but keeps one inside an expression and keeps
    # the HTML comments that sit inside template literals; neither is shown to anyone.
    bundle = _strip_html_comments((WEBUI / "bundle" / "app.js").read_text(encoding="utf-8"))
    out = {"bundle/app.js": re.sub(r"^\s*//.*$", "", bundle, flags=re.M)}
    for p in sorted((WEBUI / "partials").glob("*.html")) + [WEBUI / "index.html"]:
        out[p.relative_to(WEBUI).as_posix()] = _strip_html_comments(p.read_text(encoding="utf-8"))
    return out


def find_absent_feature_mentions(text: str) -> list[str]:
    hits = []
    for pat in ABSENT_FEATURE_PHRASES:
        hits += [m.group(0) for m in re.finditer(pat, text, re.I)]
    for pat in ABSENT_FEATURE_CASED:
        hits += [m.group(0) for m in re.finditer(pat, text)]
    return hits


def test_the_scanner_would_catch_what_it_exists_to_catch():
    """A scan that matches nothing proves nothing: plant each phrase and see it found."""
    for planted in ("use Voice Swap for that", "Voice Training reuses it", "a swap-ready split",
                    "the learned voice", "trained voices are unaffected", "before training",
                    "an RVC model", "Applio", "LoRA Studio", "the Productions tab", "🎓 a clip",
                    "with 🎓 Train on its row"):
        assert find_absent_feature_mentions(planted), planted
    assert not find_absent_feature_mentions("Voices > Clean, Enhance, Stems, Speech, ACE-Step")


@pytest.mark.parametrize("name", sorted(user_visible_page_text()))
def test_no_user_visible_text_names_a_feature_this_package_does_not_have(name):
    text = user_visible_page_text()[name]
    hits = find_absent_feature_mentions(text)
    assert not hits, (
        f"{name} shows the user text about a feature that is not in the Docker product: "
        f"{sorted(set(hits))}. Reword it so the sentence stays useful without pointing at a "
        f"tab or program that does not exist here.")


# ── item 8: no loopback example left where it would mean the container ───────────────────────

def test_the_html_placeholders_do_not_teach_loopback_for_the_docker_user():
    """The static placeholders are what a non-Docker run shows; the Docker page replaces them from
    `applyDockerAttributes` as soon as /health answers (tests/docker_texts_smoke.mjs). Pin that the
    replacement exists, so the loopback example never survives into the package."""
    model = (WEBUI / "js" / "sys" / "model.js").read_text(encoding="utf-8")
    assert "http://host.docker.internal:5001" in model and "http://host.docker.internal:8080" in model
    assert "applyDockerAttributes();" in model


# ── item 10: the satellite secret dialog names the real programs first ───────────────────────

def test_the_secret_dialog_names_the_docker_satellite_setup_first_and_correctly():
    src = (WEBUI / "js" / "sys" / "devices.js").read_text(encoding="utf-8")
    block = src[src.index("const where = DOCKER"):src.index("return modal(\n    `Shared secret for")]
    docker_branch, plain_branch = block.split(": `<p>Paste this into <code>setup.bat</code>")
    assert "Vocalis Satellite setup program" in docker_branch and "satellite-setup.sh" in docker_branch
    assert "setup.bat" not in docker_branch, "the Docker satellite has no setup.bat"
    assert "satellite-setup.sh --new-secret" in docker_branch
    assert "re-run setup there" in plain_branch, "the developer's source run keeps its setup.bat wording"


# ── items 11 and 12: the extension's own words ───────────────────────────────────────────────

def test_the_pairing_note_says_narration_needs_the_token_too():
    html = (WEBUI / "partials" / "panel-settings.html").read_text(encoding="utf-8")
    note = re.search(r"<h2>SillyTavern extension</h2>\s*<div[^>]*><b>(.*?)</b>", html, re.S).group(1)
    assert "narration" in note.lower() and "worldbooks" in note, note
    assert "Only needed to push" not in html


def test_the_extension_toasts_name_the_panel_the_way_the_page_titles_it():
    ext = EXT.read_text(encoding="utf-8")
    assert "Settings → SillyTavern pairing" not in ext
    assert ext.count("(Settings → SillyTavern extension)") == 2
    html = (WEBUI / "partials" / "panel-settings.html").read_text(encoding="utf-8")
    assert "<h2>SillyTavern extension</h2>" in html, "the name the toasts send people to"


def test_the_extension_points_at_the_real_tab_and_the_packages_port():
    ext = EXT.read_text(encoding="utf-8")
    assert "Scene built — it is in the Clips tab" not in ext
    assert "find it in Vocalis under SillyTavern → Scene Clips" in ext
    sillytavern = (WEBUI / "partials" / "panel-sillytavern.html").read_text(encoding="utf-8")
    assert ">Scene Clips</button>" in sillytavern, "the sub-tab the toast names"
    assert ":7870" not in ext and ":7871" not in ext, "the in-container port is not the user's port"
    assert ext.count("vocalis.example:18770") == 2
