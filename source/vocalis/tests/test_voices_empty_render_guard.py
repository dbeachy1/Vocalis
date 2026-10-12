"""An empty data response must not replace a loading list before the first successful render."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

VOICES = Path(__file__).resolve().parents[1] / "src" / "webui" / "js" / "voices" / "voices.js"


@pytest.fixture(scope="module")
def code():
    """Comments stripped — this guard is now documented at length, and a scanner reading its own
    explanation would pass on the prose rather than the code."""
    src = VOICES.read_text(encoding="utf-8")
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return "\n".join(ln.split("//", 1)[0] for ln in src.splitlines())


def test_the_subtab_guard_does_not_test_an_array_for_truthiness(code):
    """🔴 THE DEFECT ITSELF. `if (state.vlist)` is true for `[]`, so the guard admitted exactly the
    case its comment exists to exclude."""
    assert "if (state.vlist) renderVoiceList()" not in code, (
        "the sub-tab switcher guards on a truthy array again - `[]` passes it, and an empty store "
        "will paint 'No uploaded voices.' over a list that is still loading"
    )


def test_it_guards_on_whether_a_LOAD_HAPPENED(code):
    """⚠️ `dataset.loaded` IS THE RIGHT SIGNAL, NOT `.length`. A genuinely empty library must still
    render its empty state — the question is "has a load happened", not "is there anything in it".
    A `.length` guard would fix this bug and break the empty library."""
    at = code.index("renderVoiceList();", code.index("data-vcpanel"))
    guard = code[max(0, at - 300):at]
    assert "dataset.loaded" in guard, (
        "the guard no longer asks whether a load has happened"
    )
    assert not re.search(r"state\.vlist\s*&&\s*state\.vlist\.length", guard), (
        "guarding on .length would stop a genuinely EMPTY library from ever rendering its empty "
        "state - the guard is about whether a load happened, not about what it returned"
    )


def test_only_the_loader_sets_the_loaded_flag(code):
    """📌 The flag has to mean "a load completed", so exactly one place may set it — the loader,
    after its fetch and render. A second setter would make it mean "someone thought about it"."""
    assert code.count("dataset.loaded = '1'") == 1, (
        "more than one place sets the loaded flag, so it no longer means a load completed"
    )
    at = code.index("dataset.loaded = '1'")
    before = code[max(0, at - 500):at]
    assert "renderVoiceList()" in before, (
        "the flag is set before the first render, so the guard would admit a paint that has "
        "nothing to draw"
    )


def test_the_loader_still_renders_unconditionally(code):
    """⚠️ THE GUARD MUST NOT REACH THE LOADER. `loadVoiceList` renders after its own fetch and
    must never be gated on a flag it is itself responsible for setting — that would be a list
    that can never make its first paint."""
    fn = code[code.index("export async function loadVoiceList"):]
    fn = fn[:fn.index("function vCleanBadges")]
    at = fn.index("renderVoiceList();")
    line_start = fn.rfind("\n", 0, at)
    assert "if" not in fn[line_start:at], (
        "the loader's own render became conditional - the list could never paint the first time"
    )
