"""The two LLM engine panels expose the same control shape.

The element inventories are compared in both directions. Any intentional difference must be
listed in `ENGINE_SPECIFIC` with its reason, so a missing or extra control cannot pass silently.

⚠️ **IT COMPARES SETS, NOT A CHECKLIST.** A hand-written list of ids to look for ("assert there is
a Load button") would miss an unlisted, extra control on either panel. The remaining checks compare
labels and row behavior where exact parity is required."""
import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

from conftest import REPO_ROOT

PARTIALS = REPO_ROOT / "src" / "webui" / "partials"

# prefix -> partial. The 3-letter prefix is the convention every id in these panels follows.
PANELS = {"kob": PARTIALS / "panel-kobold.html",
          "lla": PARTIALS / "panel-llama.html"}

# Ids one engine has and the other cannot, each with the reason it is not a divergence. Adding to
# this dict is the declaration; it is not a suppression, because the reason has to be true.
ENGINE_SPECIFIC = {
    # A `llama-server -m model.gguf` is a WORKING server that simply has no model-management API.
    # KoboldCpp has no equivalent state — it is always an admin/switcher — so there is nothing for
    # this note to correspond to. See js/sys/llama.js's header, final paragraph.
    "lla": {"Single"},
    "kob": set(),
}


class _Ids(HTMLParser):
    """Every id in the file, plus the tag it sits on and (for buttons) its text."""

    def __init__(self):
        super().__init__()
        self.by_id = {}
        self._open = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self._open.append((tag, a.get("id")))
        if a.get("id"):
            self.by_id[a["id"]] = {"tag": tag, "class": a.get("class", ""), "text": ""}

    def handle_endtag(self, tag):
        while self._open:
            t, _ = self._open.pop()
            if t == tag:
                break

    def handle_data(self, data):
        if self._open and self._open[-1][1] and data.strip():
            self.by_id[self._open[-1][1]]["text"] += data.strip()


def _panel(prefix):
    p = _Ids()
    p.feed(PANELS[prefix].read_text(encoding="utf-8"))
    out = {}
    for ident, info in p.by_id.items():
        assert ident.startswith(prefix), (
            f"{PANELS[prefix].name} has an id {ident!r} that does not start with {prefix!r}. "
            f"The prefix convention is what makes the two panels comparable at all.")
        out[ident[len(prefix):]] = info
    return out


def test_both_engine_panels_carry_the_same_elements():
    """🔴 THE REQUIREMENT, MADE MECHANICAL. Set equality, both directions."""
    kob, lla = _panel("kob"), _panel("lla")
    kob_only = set(kob) - set(lla) - ENGINE_SPECIFIC["kob"]
    lla_only = set(lla) - set(kob) - ENGINE_SPECIFIC["lla"]
    assert not kob_only and not lla_only, (
        "the two LLM engine panels have drifted apart, and the requirement is "
        '*both panels show the same information available in Kobold.*\n'
        f"  only in panel-kobold.html: {sorted(kob_only)}\n"
        f"  only in panel-llama.html:  {sorted(lla_only)}\n"
        "If a divergence is genuinely right, declare it in ENGINE_SPECIFIC with the reason.")


def test_the_declared_divergences_still_exist():
    """A stale allowlist is a lie that grows. An entry naming an id that is gone would sit here
    permanently excusing a divergence that no longer exists — and hiding the next one that reuses
    the name."""
    for prefix, names in ENGINE_SPECIFIC.items():
        have = set(_panel(prefix))
        gone = names - have
        assert not gone, (
            f"ENGINE_SPECIFIC[{prefix!r}] names {sorted(gone)}, which is no longer in "
            f"{PANELS[prefix].name}. Delete the entry rather than leaving it to excuse a future id "
            f"that happens to be called the same thing.")


@pytest.mark.parametrize("prefix", sorted(PANELS))
def test_each_panel_has_the_control_trio(prefix):
    """Set equality alone permits both panels to lose the same control. Assert the shared select, Load,
and Unload controls explicitly, including their visible button labels."""
    panel = _panel(prefix)
    assert panel.get("Sel", {}).get("tag") == "select", f"{prefix}Sel must be a <select>"
    for verb in ("Load", "Unload"):
        info = panel.get(verb)
        assert info and info["tag"] == "button", f"{prefix}{verb} must be a <button>"
        assert info["text"] == verb, (
            f"{prefix}{verb} reads {info['text']!r}. Browser specs locate these buttons by their visible labels.")


@pytest.mark.parametrize("prefix", sorted(PANELS))
def test_each_panel_has_exactly_one_detail_line(prefix):
    """Each panel shows one compact line describing its selected model. The model picker lists the
available presets and files; the detail line describes only the selected item."""
    panel = _panel(prefix)
    det = panel.get("Detail")
    assert det, f"{prefix}Detail is missing — the one line of metadata about the selected model"
    assert "small" in det["class"] and "muted" in det["class"], (
        f"{prefix}Detail is class={det['class']!r}; it must be small+muted like its twin, or the "
        f"two panels read differently even while carrying the same elements.")


def test_no_panel_renders_a_row_per_model():
    """The list is gone from the SOURCE, not merely hidden.

    ⚠️ Asserted on `js/sys/*.js` too, because the markup is only half of it: deleting the container
    while leaving `modelRow()` behind would leave a painter with no canvas and the next session
    would wire it back up.
    """
    js = REPO_ROOT / "src" / "webui" / "js" / "sys"
    for name in ("llama.js", "kobold.js"):
        src = (js / name).read_text(encoding="utf-8")
        # A model-list painter is a `.map(` over the model rows joined into innerHTML. Named
        # rather than pattern-matched: these two are the ones that existed.
        assert not re.search(r"\bmodelRow\b", src), (
            f"{name} still defines or calls modelRow() — the per-model list came back.")
    for prefix, path in PANELS.items():
        assert f'id="{prefix}Models"' not in path.read_text(encoding="utf-8"), (
            f"{path.name} still has a #{prefix}Models container for a row-per-model list.")
