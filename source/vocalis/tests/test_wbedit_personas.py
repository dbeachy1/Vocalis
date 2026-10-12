"""Tests persona listing, selection, and persistence."""
from __future__ import annotations

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from wbedit import formats
from wbedit.formats import persona
from wbedit.store.models import KINDS

PERSONA = {
    "spec": persona.SPEC,
    "avatar": "test-user.png",
    "name": "Test User",
    "description": "A software engineer who reads code fluently and dislikes being asked twice.",
    "title": "The one at the keyboard",
    "position": 0, "depth": 4, "role": 0,
    "lorebook": "Sample World Book 1",
}

#: What onboarding actually writes: `description` and `position`, nothing else. Real installs are
#: full of these, and `title`/`focus` are DELETED rather than blanked when empty (personas.js:862).
MINIMAL = {"spec": persona.SPEC, "avatar": "new.png", "name": "User",
           "description": "Just me.", "position": 0}


# ── detection ────────────────────────────────────────────────────────────────

def test_a_persona_is_detected():
    assert formats.detect.doc_kind(PERSONA) == "persona"
    assert formats.detect.doc_kind(MINIMAL) == "persona"


def test_a_persona_is_not_mistaken_for_a_v1_card():
    """Checks that a persona is not mistaken for a v1 card."""
    flat_v1 = {"name": "Test Character 2", "description": "A tall woman.", "first_mes": "You again."}
    assert formats.detect.doc_kind(flat_v1) == "card"
    assert formats.detect.doc_kind(PERSONA) == "persona"

    # …and the reverse: a persona that happens to carry a `first_mes` key is STILL a persona,
    # because the spec marker is exact and is checked first.
    assert formats.detect.doc_kind({**PERSONA, "first_mes": "hello"}) == "persona"


def test_a_card_and_a_worldbook_still_detect_as_before():
    """Adding a third kind must not move the other two."""
    assert formats.detect.doc_kind({"spec": "chara_card_v2", "data": {"description": "x"}}) == "card"
    assert formats.detect.doc_kind({"entries": {}}) == "worldbook"
    assert formats.detect.doc_kind([]) == "worldbook"
    assert formats.detect.doc_kind({"nothing": 1}) is None


def test_persona_is_a_known_kind():
    assert "persona" in KINDS


# ── what a pass may edit ─────────────────────────────────────────────────────

def test_only_the_prose_is_collected():
    """Checks that only the prose is collected."""
    jobs = formats.collect(PERSONA, rel="Test User")
    assert [j.label for j in jobs] == ["description", "title"]
    assert all(isinstance(j.original, str) and j.original.strip() for j in jobs)


def test_a_minimal_persona_yields_just_its_description():
    """Absent and empty are the same here, because on their side an empty title is DELETED."""
    jobs = formats.collect(MINIMAL, rel="User")
    assert [j.label for j in jobs] == ["description"]


def test_the_locator_addresses_the_field_directly():
    jobs = formats.collect(PERSONA, rel="Test User")
    assert [tuple(j.locator) for j in jobs] == [("description",), ("title",)]


def test_the_context_says_this_is_the_USER_not_a_character():
    """Checks that the context says this is the user not a character."""
    jobs = formats.collect(PERSONA, rel="Test User")
    kind = jobs[0].meta["kind"]
    assert "USER" in kind and "not a character" in kind, kind


# ── identity ─────────────────────────────────────────────────────────────────

def test_identity_is_the_avatar_filename_not_the_name():
    """✅ Stable under rename: `renamePersona` writes only `power_user.personas[avatarId]`, so the
    filename survives a display-name change. Same property §8.2 leans on for worldbooks."""
    assert persona.avatar_id(PERSONA) == "test-user.png"
    renamed = {**PERSONA, "name": "Test User Renamed"}
    assert persona.avatar_id(renamed) == persona.avatar_id(PERSONA)


def test_a_persona_names_itself_and_falls_back_to_its_avatar():
    assert formats.detect.display_name(PERSONA, "persona", "ignored") == "Test User"
    nameless = {k: v for k, v in PERSONA.items() if k != "name"}
    assert formats.detect.display_name(nameless, "persona", "ignored") == "test-user.png", (
        "an avatar filename says WHICH persona it is; the caller's context does not")


def test_the_lorebook_is_read_by_name_like_a_card_s_world():
    """Checks that the lorebook is read by name like a card s world."""
    assert persona.lorebook_name(PERSONA) == "Sample World Book 1"
    assert persona.lorebook_name(MINIMAL) == ""
