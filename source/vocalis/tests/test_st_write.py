"""Send plans contain only editable fields and preserve linked World Book data.

A mirrored embedded book is omitted from merge payloads because SillyTavern regenerates it from the standalone book. Card-native books remain editable, and create plans retain the full card payload."""
from __future__ import annotations

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

from wbedit.formats import card as card_fmt
from wbedit.formats import st_write
from wbedit.store.models import Document

BOOK_ENTRIES = [{"keys": ["ledger"], "content": "He keeps the ledger.", "comment": "Ledger"}]


def doc(kind, **kw):
    return Document(id="d1", name=kw.pop("name", "Test_Character"), kind=kind,
                    st_ref=kw.pop("st_ref", ""), **kw)


def v2_card(*, world="", book=None, **fields):
    d = {"name": "Test_Character", "extensions": {"world": world}, **fields}
    if book is not None:
        d["character_book"] = book
    return {"spec": "chara_card_v2", "data": d}


# ───────────────────────────────────────────── the refusals

def test_a_mirrored_lorebook_is_never_sent():
    """🔴 THE ONE THAT MATTERS. `data.extensions.world` non-empty means the embedded book is a
    mirror of a standalone World Book; writing it back lands and is then re-baked over."""
    content = v2_card(world="Test World Book 1", description="An accountant.",
                      book={"entries": BOOK_ENTRIES})
    plan = st_write.plan(doc("card", st_ref="Test_Character.png"), content, st_ref="Test_Character.png")

    assert "character_book" not in plan["merge"]["data"]
    assert "character_book" not in plan["merge"]
    assert plan["dropped"], "the send dropped a lorebook and said nothing about it"
    assert "Test World Book 1" in plan["dropped"][0], \
        "the message must name the book he should edit instead"


def test_a_card_native_lorebook_IS_sent():
    """The common case, and the one the first fix broke by keying on `character_book.name`: most
    V2 cards in the wild ship a NAMED embedded book with no world linked. It exists nowhere else,
    the card editor is the only place it can be edited, and it must therefore be deliverable."""
    content = v2_card(world="", description="An accountant.", book={"entries": BOOK_ENTRIES})
    plan = st_write.plan(doc("card", st_ref="Test_Character.png"), content, st_ref="Test_Character.png")

    assert plan["merge"]["data"]["character_book"] == {"entries": BOOK_ENTRIES}
    assert plan["dropped"] == []


def test_an_absent_world_key_is_treated_as_card_native():
    """`extensions` missing entirely, not just `world` empty — a V1-shaped card upgraded by hand,
    or one written by a tool that never set it. Absent must not read as "mirrored"."""
    content = {"spec": "chara_card_v2",
               "data": {"name": "M", "description": "x", "character_book": {"entries": BOOK_ENTRIES}}}
    plan = st_write.plan(doc("card", st_ref="M.png"), content, st_ref="M.png")
    assert plan["merge"]["data"]["character_book"] == {"entries": BOOK_ENTRIES}


def test_the_world_link_is_never_sent():
    """⚠️ Omitting the key is what leaves SillyTavern's own value alone — `deepMerge` only touches
    keys the payload carries. Sending ours would re-point the card at our Library row's name.

    🔴 **`world=None` IS WHAT EVERY CALLER PASSES FOR A LINK THAT ARRIVED WITH THE CARD**, and it
    is the default, so this test also pins that 9.7.3's carve-out did not quietly become the rule.
    """
    content = v2_card(world="Test World Book 1", description="An accountant.")
    plan = st_write.plan(doc("card", st_ref="Test_Character.png"), content, st_ref="Test_Character.png")
    assert "extensions" not in plan["merge"]["data"]
    assert "world" not in plan["merge"]


# ───────────────────────────────────────────── 9.7.3: the one exception


def test_a_world_link_selected_in_vocalis_is_sent():
    """A user-selected SillyTavern key is sent when `Document.world_set` marks the association as explicitly edited. The key is resolved by the store rather than copied from the Vocalis display name."""
    content = v2_card(world="Test World Book 1", description="An accountant.")
    plan = st_write.plan(doc("card", st_ref="Test_Character.png"), content, st_ref="Test_Character.png",
                         world="Test World Book 1 Selected")
    assert plan["merge"]["data"]["extensions"]["world"] == "Test World Book 1 Selected"


def test_unassociating_sends_an_empty_world_rather_than_deleting_the_key():
    """An empty `extensions.world` is SillyTavern's representation of no primary World Book. Send the empty value; deleting the key would use a shape its editor does not produce."""
    content = v2_card(world="", description="An accountant.")
    plan = st_write.plan(doc("card", st_ref="Test_Character.png"), content, st_ref="Test_Character.png",
                         world="")
    assert plan["merge"]["data"]["extensions"]["world"] == ""
    assert st_write.UNSET_SENTINEL not in repr(plan["merge"])


def test_unassociating_does_not_start_sending_the_mirrored_lorebook():
    """🔴 **THE REGRESSION THIS FEATURE COULD HAVE CAUSED, AND IT IS SILENT.** `outbound` blanks
    `extensions.world` for an unassociated card, so `_card_plan` sees `world == ""` — the same
    thing a card-native lorebook looks like. Without the `world_out == ""` clause, a card that
    correctly DROPPED its mirrored book yesterday would start writing it into his SillyTavern
    card today, purely because a dropdown moved. The mirror is still a stale copy of a book that
    is still a Library document; unlinking the card says nothing about that book.
    """
    content = v2_card(world="", description="An accountant.", book={"entries": BOOK_ENTRIES})
    plan = st_write.plan(doc("card", st_ref="Test_Character.png"), content, st_ref="Test_Character.png",
                         world="")
    assert "character_book" not in plan["merge"]["data"]
    assert plan["dropped"], "a mirrored lorebook was dropped with nothing said about it"
    # ⚠️ And the message does not quote the book he just unlinked from — printing `world_ref` here
    # would read the association he removed back at him.
    assert "unlinked" in plan["dropped"][0]


def test_the_world_link_and_the_focus_rect_share_one_extensions_dict():
    """🔴 **TWO WRITERS, ONE KEY.** `flat["extensions"]` used to be assigned outright by the focus
    branch; a second assignment for the world link would have deleted the rect in the very request
    that set the world — and `deepMerge` reads an absent key as "leave the old crop alone", so the
    loss would have been invisible on both sides.
    """
    content = {"spec": "chara_card_v2",
               "data": {"name": "M", "description": "x",
                        "extensions": {"world": "", "taproom_avatar_focus": {"x": .1, "y": .2, "w": .5}}}}
    ext = st_write.plan(doc("card", st_ref="M.png"), content, st_ref="M.png",
                        world="Test World Book 1")["merge"]["data"]["extensions"]
    assert ext["world"] == "Test World Book 1"
    assert ext[st_write.FOCUS_FIELD] == {"x": .1, "y": .2, "w": .5}


def test_only_editable_fields_are_written():
    """Only fields exposed by the Vocalis editor may be sent. Other imported fields can become stale and overwrite newer values in SillyTavern."""
    content = v2_card(description="An accountant.", talkativeness=0.9, fav=True,
                      tags=["ledger"], creator="someone", character_version="3")
    data = st_write.plan(doc("card", st_ref="M.png"), content, st_ref="M.png")["merge"]["data"]
    assert set(data) <= set(st_write.CARD_WRITE_FIELDS)
    for junk in ("talkativeness", "fav", "tags", "creator", "character_version", "name"):
        assert junk not in data, f"{junk} is not editable in Vocalis and must not be written"


def test_the_write_list_is_derived_from_what_the_editor_offers():
    """🔴 DERIVED, NEVER RETYPED. A tenth editable field added to `CARD_KIND` and forgotten here
    would be editable in Vocalis and silently undeliverable."""
    assert set(st_write.CARD_WRITE_FIELDS) == set(card_fmt.CARD_KIND)


# ───────────────────────────────────────────── the V1/V2 double write

def test_both_levels_are_written_for_a_v2_card():
    """🔴 NOT BELT-AND-BRACES — `readFromV2` compares the flat copy with `data` on every read and
    on a mismatch logs BOTH VERSIONS OF HIS CARD TEXT (`characters.js:694-696`, a SENSITIVE line).
    A partial write would leave that firing on every read of the character."""
    plan = st_write.plan(doc("card", st_ref="M.png"),
                         v2_card(description="An accountant.", first_mes="Hello."),
                         st_ref="M.png")
    for f in ("description", "first_mes"):
        assert plan["merge"][f] == plan["merge"]["data"][f]


def test_v2_only_fields_get_no_flat_alias():
    """`readFromV2`'s `fieldMappings` maps five of ours and no more. A top-level
    `alternate_greetings` or `character_book` is a key nothing over there ever reads."""
    plan = st_write.plan(doc("card", st_ref="M.png"),
                         v2_card(description="x", alternate_greetings=["hi", "hey"],
                                 system_prompt="be brief", book={"entries": BOOK_ENTRIES}),
                         st_ref="M.png")
    for f in ("alternate_greetings", "system_prompt", "character_book"):
        assert f not in plan["merge"], f"{f} has no V1 alias and must not be written flat"
        assert f in plan["merge"]["data"]


def test_a_v1_card_gets_no_data_block():
    """🔴 It has no `spec`, so `getCharaCardV2` sends it through `convertToV2`, which builds `data`
    from the flat fields. A half-populated `data` we wrote would be authoritative-looking, unread,
    and one `spec` field away from shadowing the real values."""
    plan = st_write.plan(doc("card", st_ref="M.png"),
                         {"name": "M", "description": "An accountant.", "first_mes": "Hello."},
                         st_ref="M.png")
    assert "data" not in plan["merge"]
    assert plan["merge"]["description"] == "An accountant."


def test_the_avatar_rides_in_the_body():
    """`mergeCharacterUpdate` takes the whole request body as the merge payload, so `avatar` is
    both the target and a merged field. Their own front-end sends it (`public/script.js:11595`)."""
    plan = st_write.plan(doc("card", st_ref="Test_Character.png"), v2_card(description="x"),
                         st_ref="Test_Character.png")
    assert plan["merge"]["avatar"] == "Test_Character.png"
    assert plan["target"] == "Test_Character.png"


def test_arrays_replace_rather_than_merge():
    """📌 A GUARD ON A DOCUMENT, NOT ON CODE — see the module note. Their `deepMerge` assigns array
    values wholesale because `isObject` excludes arrays, so one request replaces `entries`
    correctly and the `UNSET_SENTINEL` two-step is not just unnecessary but dangerous: an unset
    that lands with a set that fails destroys an embedded lorebook in his install.

    The assertion is that we send the WHOLE array and nothing else — no sentinel, no second pass.
    """
    shortened = [BOOK_ENTRIES[0]]
    plan = st_write.plan(doc("card", st_ref="M.png"),
                         v2_card(description="x", book={"entries": shortened}), st_ref="M.png")
    assert plan["merge"]["data"]["character_book"]["entries"] == shortened
    assert "unset" not in plan, "the UNSET_SENTINEL two-step is not needed and must not come back"
    assert "__@@UNSET@@__" not in repr(plan)


# ───────────────────────────────────────────── worldbooks

def test_a_compiled_book_goes_out_under_its_sillytavern_name():
    book = {"entries": {"0": {"uid": 0, "key": ["ledger"], "content": "He keeps it."}}}
    plan = st_write.plan(doc("worldbook", st_ref="Test World Book 1", name="Test World Book 1 (Vocalis)"),
                         book, st_ref="Test World Book 1", name="Test World Book 1 (Vocalis)")
    assert plan["kind"] == "worldbook"
    assert plan["target"] == "Test World Book 1", "the ST name, not the Library row's name"
    assert plan["book"] == book


def test_a_book_assembled_here_can_be_created_over_there():
    """§6.5 assembles books from chunks, and getting them into SillyTavern is the point of doing
    it. It has no `st_ref` because it has never been over there — the Library name is the name."""
    book = {"entries": {"0": {"uid": 0, "key": ["k"], "content": "c"}}}
    plan = st_write.plan(doc("worldbook", name="Test World Book 2"), book, name="Test World Book 2")
    assert plan["target"] == "Test World Book 2"


def test_a_section_chunk_file_is_refused_with_a_reason():
    """🔴 Its `entries` is a LIST and its key field is `keys`. SillyTavern's loader wants a dict
    keyed by uid with a `key` field; handed this it saves a world that loads and fires nothing."""
    with pytest.raises(st_write.Unsendable) as exc:
        st_write.plan(doc("worldbook", name="Test_World_Book_3"),
                      {"section": "A", "entries": [{"keys": ["g"], "content": "c"}]},
                      name="Test_World_Book_3")
    assert "assemble" in str(exc.value).lower()


# ───────────────────────────────────────────── personas

def test_a_persona_sends_only_its_prose():
    """🔴 A descriptor also carries `connections`, `position`, `depth`, `role` and `lorebook`.
    None is editable here and a wholesale replacement would destroy every one of them."""
    content = {"spec": "vocalis_persona_v1", "avatar": "test-user.png", "name": "Test User",
               "description": "An engineer.", "title": "the boss",
               "position": 0, "depth": 2, "lorebook": "Test World Book 1"}
    plan = st_write.plan(doc("persona", st_ref="test-user.png"), content, st_ref="test-user.png")
    assert plan["persona"] == {"description": "An engineer.", "title": "the boss"}


def test_a_personas_display_name_is_never_sent():
    """Vocalis's rename renames the Library row, not the persona, and `persona.jobs` offers only
    description and title — so there is no edit to propagate, and writing our copy back would undo
    a rename he made in SillyTavern since the import."""
    content = {"spec": "vocalis_persona_v1", "avatar": "test-user.png", "name": "Test User",
               "description": "An engineer."}
    plan = st_write.plan(doc("persona", st_ref="test-user.png"), content, st_ref="test-user.png")
    assert "name" not in plan["persona"]


def test_an_emptied_title_is_a_deletion_not_a_blank():
    """⚠️ Their editor DELETES the key when it is emptied (`personas.js:862`). A `title: ""`
    renders an empty title chip where their own data model would have none."""
    content = {"spec": "vocalis_persona_v1", "avatar": "test-user.png", "description": "An engineer."}
    plan = st_write.plan(doc("persona", st_ref="test-user.png"), content, st_ref="test-user.png")
    assert plan["persona"]["title"] is None


# ───────────────────────────────────────────── the other refusals

def test_a_card_that_was_never_in_sillytavern_is_CREATED_not_refused():
    """A card absent from SillyTavern is created instead of treated as a failed update. A create has no target file and must not apply merge-only drop rules."""
    plan = st_write.plan(doc("card", name="Test_Character"), v2_card(description="x"), name="Test_Character")
    assert plan["kind"] == "card" and plan["create"] is True
    assert plan["target"] == "", "a create addresses no file over there — there is not one yet"
    assert plan["card"]["data"]["description"] == "x"
    assert plan["dropped"] == [], \
        "nothing is withheld from a create: every drop rule is about a merge overwriting theirs"


def test_a_created_card_carries_the_picture_only_when_we_have_one():
    """⚠️ `has_avatar`, NOT `avatar`. The `avatar` flag means "ours has diverged from theirs"
    (`avatar_dirty`), which is false on a card nobody has touched the picture of since import —
    and their importer writes a gray placeholder, so keying the create's picture step on that
    would land his card faceless with nothing saying why."""
    made = st_write.plan(doc("card"), v2_card(description="x"), has_avatar=True)
    assert made["avatar"] is True
    assert st_write.plan(doc("card"), v2_card(description="x"))["avatar"] is False


def test_a_created_card_keeps_its_embedded_lorebook_even_when_a_world_is_linked():
    """🔴 THE MIRROR RULE IS ABOUT A MERGE, AND APPLYING IT HERE WOULD SILENTLY STRIP HIS BOOK.

    A mirrored `character_book` is dropped from a merge because it LANDS and is then re-baked over
    by SillyTavern's next save of that character — a delayed, silent loss. A character that does
    not exist over there has no next save to be re-baked by and no linked world to be stale
    against: the payload is the file ⬇ Export would have handed him, and dropping the book would
    make the automatic path quietly worse than the manual one it replaces."""
    book = {"entries": BOOK_ENTRIES}
    plan = st_write.plan(doc("card"), v2_card(world="Test World Book 2", book=book))
    assert plan["create"] is True
    assert plan["card"]["data"]["character_book"] == book
    assert plan["dropped"] == []


def test_a_reference_that_is_not_a_png_filename_is_refused():
    """Their `merge-attributes` joins this straight onto the characters directory. A ref that is
    not a PNG is our own record being wrong, and their path handling should not get to decide
    what it meant."""
    with pytest.raises(st_write.Unsendable):
        st_write.plan(doc("card", st_ref="Test_Character"), v2_card(description="x"), st_ref="Test_Character")


def test_an_unknown_kind_is_refused():
    with pytest.raises(st_write.Unsendable):
        st_write.plan(doc("something-else"), {"a": 1}, st_ref="x")


def test_a_revision_with_nothing_writable_is_refused():
    """A card whose only content is fields we may not write. Better an honest refusal than a
    `merge-attributes` call carrying nothing but the avatar."""
    with pytest.raises(st_write.Unsendable):
        st_write.plan(doc("card", st_ref="M.png"),
                      {"spec": "chara_card_v2", "data": {"name": "M", "tags": ["x"]}},
                      st_ref="M.png")


def test_no_refusal_quotes_document_content():
    """⚠️ `Unsendable` messages render into the Vocalis UI and its log. They are facts about a
    document's SHAPE, written by us — never a slice of his prose."""
    secret = "SECRET-PROSE-THAT-MUST-NOT-TRAVEL"
    for content, ref in (
        ({"section": "A", "entries": [{"keys": ["g"], "content": secret}]}, ""),
    ):
        with pytest.raises(st_write.Unsendable) as exc:
            st_write.plan(doc("worldbook", name="Test_World_Book_3"), content, st_ref=ref, name="Test_World_Book_3")
        assert secret not in str(exc.value)
    # 🔴 THE CARD HALF USED TO USE THE NO-`st_ref` REFUSAL, WHICH §9a.33 REPLACED WITH A CREATE.
    # The property it was checking has not gone anywhere, so it moves onto the two card refusals
    # that remain — a ref that is not a PNG filename, and a revision with nothing writable in it.
    # ⚠️ Both are reached with the secret sitting in the document, which is the point: the message
    # is a fact about the document's SHAPE and must never quote what is inside it.
    with pytest.raises(st_write.Unsendable) as exc:
        st_write.plan(doc("card", st_ref="Test_Character"), v2_card(description=secret), st_ref="Test_Character")
    assert secret not in str(exc.value)
    with pytest.raises(st_write.Unsendable) as exc:
        st_write.plan(doc("card", st_ref="Test_Character.png"), {"spec": "chara_card_v2",
                                                          "data": {"notes": secret}},
                      st_ref="Test_Character.png")
    assert secret not in str(exc.value)
