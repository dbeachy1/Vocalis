"""Tests pure editing helpers and compatibility with the reference implementation."""
from __future__ import annotations

import functools
import importlib.util
import sys
from pathlib import Path

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from wbedit.core import contract, validate as V

BASELINE = Path(__file__).resolve().parent.parent / "reference" / "wbedit-baseline" / "wb_batch_edit.py"

B = contract.BEGIN
E = contract.END
NC = contract.NOCHANGE


@functools.lru_cache(maxsize=1)
def _baseline():
    """Load the reference module by path and register it before execution so dataclass annotations resolve."""
    name = "wb_batch_edit_baseline"
    spec = importlib.util.spec_from_file_location(name, BASELINE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# ------------------------------------------------------------------- 1. the contract


def test_a_clean_block_is_read_back_exactly():
    body, notes, reason = contract.extract(f"{B}\nthe field text\n{E}")
    assert (body, notes, reason) == ("the field text", "", "")


def test_nochange_yields_no_field_and_says_why():
    assert contract.extract(NC) == (None, "", "nochange")
    assert contract.extract(f"{NC}\nnothing matched.") == (None, "", "nochange")


def test_commentary_after_the_closing_sentinel_becomes_notes():
    body, notes, _ = contract.extract(f"{B}\nrevised\n{E}\nRenamed the quill.")
    assert body == "revised"
    assert notes == "Renamed the quill."


def test_a_preamble_before_the_opening_sentinel_is_discarded_not_pasted():
    """The model explaining itself first is common and harmless — as long as the prose does not
    end up inside the field, which is what I5 is about."""
    body, _, reason = contract.extract(f"Certainly! Here is the edited field:\n{B}\nrevised\n{E}")
    assert body == "revised"
    assert reason == ""


def test_missing_sentinels_yield_no_field():
    assert contract.extract("just some prose, no block at all")[0] is None
    assert contract.extract("just some prose, no block at all")[2] == "sentinels missing"
    assert contract.extract(f"{B}\nunterminated")[0] is None


def test_two_blocks_return_the_first_AND_flag_it():
    """Checks that two blocks return the first and flag it."""
    body, _, reason = contract.extract(f"{B}\nfirst\n{E}\nor maybe\n{B}\nsecond\n{E}")
    assert body == "first"
    assert reason == "multiple blocks"


def test_the_cards_own_refusals_are_part_of_the_contract():
    assert contract.extract("JSON - paste the field value instead.")[2] == "model refused"
    assert contract.extract("Outside scope. I only edit one field.")[2] == "model refused"


def test_exactly_one_padding_newline_is_stripped_from_each_side():
    """A field that legitimately begins or ends with a blank line must keep it — stripping
    greedily would silently reformat every entry that opens on a blank line."""
    assert contract.extract(f"{B}\n\nleading blank kept\n\n{E}")[0] == "\nleading blank kept\n"


def test_an_empty_body_is_a_result_not_a_parse_failure():
    """`None` means unreadable; `""` means the model really did return nothing. They are
    different, and `validate()` flags the second."""
    body, _, reason = contract.extract(f"{B}\n\n{E}")
    assert body == "" and reason == ""
    assert "empty output" in V.validate("was something", body, 0.6, 1.75)


# ------------------------------------------------------------------- 2. the validators


def test_a_clean_edit_raises_nothing():
    before = "The quill is red. It sits on the desk."
    after = "The quill is blue. It sits on the desk."
    assert V.validate(before, after, 0.6, 1.75) == []


@pytest.mark.parametrize("before,after,expect", [
    ("x" * 100 + ".", "x" * 20 + ".", "length ratio"),
    ("x" * 100 + ".", "x" * 300 + ".", "length ratio"),
    ("one.\n\ntwo.", "one. two.", "paragraph count"),
    ("A full sentence.", "A sentence that stops mid", "terminal punctuation"),
    ("Hello {{char}}, said {{user}}.", "Hello {{char}}, said the user.", "macro/template"),
    ("A line.\n<START>\nmore.", "A line.\nmore.", "macro/template"),
    ("Some [note] here.", "Some note here.", "bracket-note count"),
])
def test_each_validator_fires_on_its_own_observed_failure(before, after, expect):
    flags = V.validate(before, after, 0.6, 1.75)
    assert any(expect in f for f in flags), f"expected a {expect!r} flag, got {flags}"


def test_protocol_text_in_the_field_is_flagged():
    after = f"The quill is blue.\n{contract.END}\nand more."
    assert any("protocol text leaked" in f for f in V.validate("The quill is red.", after, 0.1, 9.9))


def test_the_leak_flag_never_carries_the_users_own_prose():
    """Checks that the leak flag never carries the users own prose."""
    secret = "ZQCONTENTMARKERQZ"
    after = f"FIELD\n{secret} is the private bit."
    flags = V.validate("something.", after, 0.1, 9.9)
    assert any("protocol text leaked" in f for f in flags)
    assert not any(secret in f for f in flags), f"a field body reached a flag string: {flags}"


def test_the_leak_flag_never_carries_the_prose_that_FOLLOWS_a_matched_prefix():
    """Checks that the leak flag never carries the prose that follows a matched prefix."""
    secret = "ZQCONTENTMARKERQZ"
    after = f"{V.CONTEXT_LEAK_PREFIX}) {secret} is the private bit.\nThe quill is blue."
    flags = V.validate("The quill is red.", after, 0.1, 9.9)
    assert any("protocol text leaked" in f for f in flags), "the leak must still be detected"
    assert not any(secret in f for f in flags), f"a field body reached a flag string: {flags}"


@pytest.mark.parametrize("token,shape", [
    # Machinery: a bare identifier cannot hold a sentence, so it survives verbatim — losing
    # `{{char}}` is the finding this check exists for and the name is the whole diagnostic.
    ("{{char}}", "{{char}}"),
    ("{{user}}", "{{user}}"),
    ("<START>", "<START>"),
    # Free text by definition. ST's comment macro is where a lorebook keeps private notes.
    ("{{// he is secretly her father}}", "{{//…}}"),
    ("{{//no space either}}", "{{//…}}"),
    # The command is ours to name; preserve the user's argument text.
    ("{{setvar::plot_twist::he is her father}}", "{{setvar::…}}"),
    ("{{getvar::plot_twist}}", "{{getvar::…}}"),
    # Anything else — including an identifier-shaped blob long enough to be prose — is shape only.
    ("{{Test User's private aside}}", "{{…}}"),
    ("{{" + "x" * 40 + "}}", "{{…}}"),
])
def test_a_macro_token_is_reported_by_shape_never_by_content(token, shape):
    """Checks that a macro token is reported by shape never by content."""
    assert V.token_shape(token) == shape


def test_the_macro_flag_counts_what_it_no_longer_names():
    """Shapes cost information, so the count has to carry it back: three lost `{{//…}}` must not
    collapse into one, or a mass deletion reads the same as a single one."""
    orig = "a. {{// one}} {{// two}} {{// three}} {{char}}"
    flags = V.validate(orig, "a. {{char}}", 0.1, 9.9)
    macro = [f for f in flags if "macro/template" in f][0]
    assert "(3)" in macro, f"the total is missing: {macro}"
    assert "3×{{//…}}" in macro, f"the per-shape count is missing: {macro}"


def test_empty_output_short_circuits_and_does_not_also_report_a_ratio():
    """One clear finding beats five derived ones — every other check would be measuring nothing
    against something."""
    assert V.validate("a real field.", "   ", 0.6, 1.75) == ["empty output"]


def test_a_field_that_never_ended_on_punctuation_is_not_flagged_for_still_not_doing_so():
    assert V.validate("- one\n- two", "- one\n- three", 0.6, 1.75) == []


def test_reordered_macros_are_not_a_finding_but_a_dropped_one_is():
    assert V.validate("{{user}} and {{char}}", "{{char}} and {{user}}", 0.6, 1.75) == []
    assert any("macro" in f for f in V.validate("{{user}} and {{char}}", "{{char}} alone", 0.1, 9.9))


# ------------------------------------------------------- 3. faithfulness to the baseline

CORPUS = [
    f"{B}\nplain\n{E}",
    f"{B}\nwith notes\n{E}\nChanged one name.",
    f"preamble\n{B}\nafter preamble\n{E}",
    f"{B}\nfirst\n{E}\n{B}\nsecond\n{E}",
    NC,
    f"{NC}\ntrailing prose",
    "JSON - paste the field value instead.",
    "Outside scope.",
    "no sentinels at all",
    f"{B}\nunterminated",
    f"{B}\n\n{E}",
    f"{B}\n\nblank lines kept\n\n{E}",
    f"{B}\ncontains {{{{char}}}} and <START>\n{E}",
    f"{B}\ntrailing whitespace   \n{E}",
    "",
    "   ",
]

PAIRS = [
    ("The quill is red.", "The quill is blue."),
    ("x" * 100 + ".", "x" * 20 + "."),
    ("one.\n\ntwo.", "one. two."),
    ("A full sentence.", "A sentence that stops mid"),
    ("Hello {{char}}.", "Hello {{user}}."),
    ("Some [note].", "Some note."),
    ("a real field.", ""),
    ("- one\n- two", "- one\n- three"),
    ("ends on quote'", "ends on quote'"),
    ("{{user}} and {{char}}", "{{char}} and {{user}}"),
    ("A line.\n<START>\nmore.", "A line.\nmore."),
]


@pytest.mark.parametrize("raw", CORPUS)
def test_extract_agrees_with_the_baseline(raw):
    assert contract.extract(raw) == _baseline().extract(raw)


DIVERGES_ON_MACROS = {
    ("Hello {{char}}.", "Hello {{user}}."),
    ("A line.\n<START>\nmore.", "A line.\nmore."),
}


@pytest.mark.parametrize("before,after", PAIRS)
def test_validate_agrees_with_the_baseline(before, after):
    ours = V.validate(before, after, 0.6, 1.75)
    theirs = _baseline().validate(before, after, 0.6, 1.75)
    if (before, after) not in DIVERGES_ON_MACROS:
        assert ours == theirs
        return

    # Both must still object; only the wording differs. Everything OTHER than the macro flag has
    # to match exactly, so a divergence here cannot quietly widen into a second one.
    assert [f for f in ours if "macro" not in f] == [f for f in theirs if "macro" not in f]
    assert any("dropped or altered" in f for f in ours), ours
    assert any("macro" in f for f in theirs), theirs


def test_the_divergence_list_is_not_stale():
    """A pair that no longer diverges must leave the list, or the list stops meaning anything."""
    for before, after in DIVERGES_ON_MACROS:
        assert V.validate(before, after, 0.6, 1.75) != _baseline().validate(before, after, 0.6, 1.75), (
            f"({before!r}, {after!r}) agrees with the baseline now — remove it from "
            f"DIVERGES_ON_MACROS so the exemption stays honest")


def test_the_sentinels_themselves_agree_with_the_baseline():
    """A changed sentinel could make both sides agree while breaking existing documents."""
    b = _baseline()
    assert (contract.BEGIN, contract.END, contract.NOCHANGE) == (b.BEGIN, b.END, b.NOCHANGE)
    assert V.TOKEN_RE.pattern == b.TOKEN_RE.pattern
    assert set(V.LEAK_LINES) == set(b.LEAK_LINES)


# ── item 4: inserting a macro is not a defect ───────────────────────────────
#
# Adding a macro is a valid edit in the interactive card editor. Only lost or altered macros can
# break runtime substitution; added macros remain visible in the review diff.

def test_adding_a_macro_is_not_flagged():
    from wbedit.core.validate import validate
    flags = validate("Test User met her at a showing.", "{{user}} met her at a showing.", 0.5, 2.0)
    assert not any("macro" in f for f in flags), flags


def test_dropping_a_macro_is_still_flagged():
    from wbedit.core.validate import validate
    flags = validate("{{char}} met {{user}} there.", "She met him there.", 0.5, 2.0)
    assert any("dropped or altered" in f for f in flags), flags
    assert "{{char}}" in " ".join(flags) and "{{user}}" in " ".join(flags), (
        "the flag must name what went missing — 'something changed' is not actionable")


def test_rewriting_a_macro_is_still_flagged():
    """`{{chr}}` is not `{{char}}`: the old one is gone, which is exactly the runtime break."""
    from wbedit.core.validate import validate
    flags = validate("{{char}} waits.", "{{chr}} waits.", 0.5, 2.0)
    assert any("dropped or altered" in f for f in flags), flags


def test_losing_ONE_of_several_identical_macros_is_flagged():
    """Checks that losing one of several identical macros is flagged."""
    from wbedit.core.validate import validate
    flags = validate("{{user}} a {{user}} b {{user}}", "{{user}} a b", 0.3, 2.0)
    assert any("dropped or altered" in f for f in flags), flags


def test_reordering_macros_is_still_not_a_finding():
    from wbedit.core.validate import validate
    flags = validate("{{user}} then {{char}}", "{{char}} then {{user}}", 0.5, 2.0)
    assert not any("macro" in f for f in flags), flags
