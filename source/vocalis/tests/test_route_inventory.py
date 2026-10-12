"""The app's URL map, pinned — so a route that stops being registered goes RED, not quiet.

Written for the 5.1 refactor (5.1-refactor), which moves 161 routes out of
`src/vocalis_server.py` into blueprints, a few at a time, over many commits. The failure mode
that worries me is not a route that breaks — that is loud. It is a route that is never
registered at all: the module is written, the blueprint is built, and the line that registers
it is forgotten. Flask does not care. Every test that exercises that route 404s, which reads
as "that feature's tests failed" rather than "a whole blueprint is missing" — and any route
with no direct test of its own simply disappears, silently, permanently.

So: pin the shape of the map itself.

**The count is a floor, not an equality.** An exact count makes every honest new route a test
failure, which teaches people to bump the number without reading it, and then it guards
nothing — the same lesson `test_m6_writer_census.py`'s floors were written for. A floor still
catches the thing this file exists to catch, because a forgotten blueprint only ever moves the
number DOWN.

**The path set is an equality**, and that is the real assertion. Refactors do not rename URLs;
the browser and the SillyTavern extension are on the other end of them. If a path in this set
vanishes or changes spelling during 5.1, that is a bug in the refactor, full stop.
"""
import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis_server as vs


def _rules():
    return [r for r in vs.app.url_map.iter_rules() if r.endpoint != "static"]


def _paths():
    return {str(r.rule) for r in _rules()}


# Measured on dev-5.1-factor at 64ca0d7, before any route moved: 161 in vocalis_server.py,
# 3 from st_characters.create_st_blueprint, 6 from vocalis_stream_http.create_stream_blueprint.
BASELINE_RULES = 170


def test_the_url_map_has_not_shrunk():
    n = len(_rules())
    assert n >= BASELINE_RULES, (
        f"the app registers {n} rules, down from {BASELINE_RULES}. A route did not just break "
        f"— it is not registered at all. During 5.1 the overwhelmingly likely cause is a "
        f"blueprint that was written but never passed to register_blueprint(), which no other "
        f"test in this suite can distinguish from 'that feature is broken'")


def test_every_baseline_path_still_exists():
    """The set, not the count. A moved route keeps its URL or it is not a refactor."""
    missing = sorted(BASELINE_PATHS - _paths())
    assert not missing, (
        "these URLs were served before the refactor and are not registered now:\n  "
        + "\n  ".join(missing)
        + "\n\nURLs are a contract with the browser and the SillyTavern extension. If one of "
          "these genuinely had to change, that is a deliberate decision and this set is where "
          "it gets recorded.")


def test_no_route_is_registered_twice():
    """Two blueprints claiming one path is a merge artifact, and Flask resolves it silently by
    first-registration-wins. During a move-in-pieces refactor the natural way to produce it is
    to add the new module's route before deleting the old one."""
    seen, dupes = set(), []
    for r in _rules():
        key = (str(r.rule), tuple(sorted(r.methods - {"HEAD", "OPTIONS"})))
        if key in seen:
            dupes.append(key)
        seen.add(key)
    assert not dupes, (
        f"the same path+method is registered more than once: {dupes}. One of them is dead code "
        f"that will never be reached, and which one is an implementation detail of "
        f"registration order")


@pytest.mark.parametrize("path", [
    "/",
    "/login",
    "/logout",
    "/health",
    "/speak",
    "/v1/audio/speech",
    "/v1/audio/voices",
    "/vault/init",
    "/vault/recover",
    "/vault/unlock-suk",
    "/admin/set-credentials",
    "/ui-state",
])
def test_the_load_bearing_paths_are_present(path):
    """Named individually so a failure says WHICH contract broke. `/speak` and `/v1/audio/*`
    are consumed by software outside this repo — the SillyTavern extension and any OpenAI-TTS
    client — and `/vault/recover` is the one route whose absence is unrecoverable by design.
    """
    assert path in _paths(), f"{path} is no longer registered"


# Captured from the pre-refactor app. Generated, not hand-written:
#     python -c "import sys; sys.path.insert(0,'src'); import vocalis_server as v; \
#                print(sorted({str(r.rule) for r in v.app.url_map.iter_rules() \
#                              if r.endpoint != 'static'}))"
BASELINE_PATHS = set()  # filled in below by _load_baseline()


def _load_baseline():
    """Read the pinned list from the sidecar file next to this one.

    A 170-entry literal inlined here would be unreadable and would make every diff of this
    file noise. It lives in `route_inventory_baseline.txt`, one URL per line.
    """
    p = REPO_ROOT / "tests" / "route_inventory_baseline.txt"
    return {ln.strip() for ln in p.read_text(encoding="utf-8").splitlines()
            if ln.strip() and not ln.startswith("#")}


BASELINE_PATHS = _load_baseline()
