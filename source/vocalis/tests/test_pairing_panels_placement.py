"""Both SillyTavern and Nomi pairing panels belong in Settings. Keeping credential setup in one place makes tokens easier to find and preserves a single consistent setup flow. This placement test guards against moving a panel while functional route tests continue to pass."""
import re
from pathlib import Path

import pytest

from vocalis.runtime import paths

HTML = Path(paths.WEBUI) / "index.html"


def _section(name: str) -> str:
    """The markup of one `<section data-panel="…">`, up to the next section."""
    # 9.0-m0: the panels are `{% include %}` partials now, so the FILE is a 198-line shell
    # and `html.index(...)` below raises ValueError rather than returning a panel.
    from conftest import page_markup
    html = page_markup()
    start = html.index(f'<section data-panel="{name}"')
    nxt = html.find("<section data-panel=", start + 10)
    return html[start:nxt if nxt != -1 else len(html)]


@pytest.mark.parametrize("element_id", [
    "pairToken", "pairCopy", "pairNew", "pairClear", "pairShow", "pairState",
    "nomiPairToken", "nomiPairCopy", "nomiPairNew", "nomiPairClear", "nomiPairShow", "nomiPairState",
])
def test_every_pairing_control_is_in_the_settings_panel(element_id):
    settings = _section("settings")
    assert f'id="{element_id}"' in settings, (
        f"{element_id} is not in the Settings panel — both pairing panels belong there, "
        f"together. See this module's docstring.")


def test_no_pairing_control_is_left_on_the_nomi_tab():
    """⚠️ Asserted separately from the test above, and not implied by it: an id can appear TWICE.
    A duplicated panel would satisfy "it is in Settings" while leaving two controls that disagree
    about one secret — the exact failure the SillyTavern panel's own comment warns about for the
    twice-emitted Character Cards panes."""
    nomi = _section("nomi")
    stray = re.findall(r'id="(pair[A-Z]\w*|nomiPair\w*)"', nomi)
    assert not stray, f"pairing controls left on the Nomi tab: {stray}"


def test_the_nomi_tab_still_says_where_the_token_is():
    """Moving the panel away must not silently drop step 5 of the install list — that was the
    whole cost of the move, and the mitigation is that the list now names the destination."""
    nomi = _section("nomi")
    assert "Settings" in nomi and "pairing token" in nomi.lower(), (
        "the Nomi tab's install steps no longer tell the user where to find the token")


def _front_end_source() -> dict[str, str]:
    """index.html PLUS every module beside it, keyed by a readable label.

    ⚠️ 7.3-m4j: THE SILLYTAVERN HALF OF THIS PAIR IS NOT IN THE PAGE ANY MORE. `pairLoad` and its
    three handlers are `js/st/pairing.js`, and the Nomi half is still inline — so a check that
    reads only `index.html` sees one endpoint of the two and goes red for a reason that has nothing
    to do with what it is guarding. The rule is about the FRONT END, and during 7.3 the front end
    is the page plus `src/webui/js/`. Read both, and this keeps working as the rest moves.
    """
    # 9.0-m0: page_markup(), not HTML.read_text() - the ten tab panels are `{% include %}`
    # partials now, so the FILE is a 198-line shell. Reading it here found the Nomi pairing
    # controls missing and blamed the front end for a move that never happened.
    from conftest import page_markup
    src = {"index.html": page_markup()}
    js = Path(paths.WEBUI) / "js"
    for p in sorted(js.rglob("*.js")):
        src[p.relative_to(js).as_posix()] = p.read_text(encoding="utf-8")
    return src


def test_the_two_panels_are_not_wired_to_one_endpoint():
    """🔴 THE THING THAT MUST NEVER BE SHARED IS THE URL. The handlers deliberately mirror each
    other, and sitting them side by side in one tab makes factoring them together tempting — at
    which point one panel pointing at the other's endpoint is a one-character mistake that
    silently rotates the wrong credential."""
    src = _front_end_source()
    blob = "\n".join(src.values())
    for url in ("'/wbedit/pairing'", "'/nomi/pairing'",
                "'/wbedit/pairing/rotate'", "'/nomi/pairing/rotate'"):
        assert url in blob, (
            f"{url} is not called anywhere in the front end. The two pairing panels each own their "
            f"own endpoint and neither may be factored into the other's — see this test's "
            f"docstring. Searched: {', '.join(src)}")


def test_the_endpoint_check_is_reading_the_module_tree():
    """⚠️ The check above would pass VACUOUSLY the day its corpus stopped including the modules —
    the SillyTavern URLs would simply be absent from every file it read, and `in` on a shorter
    blob is not an error. Pin that the module half is really being read."""
    src = _front_end_source()
    assert len(src) > 20, f"only {len(src)} front-end files found — the module walk is broken"
    st = [name for name, text in src.items() if "'/wbedit/pairing/rotate'" in text]
    assert st and any(name != "index.html" for name in st), (
        "the SillyTavern pairing endpoint is only found in index.html, so the module half of the "
        f"corpus is contributing nothing. Found in: {st}")
