"""Tests dismissal, restoration, purge, and rollback behavior for imported documents."""
from __future__ import annotations

import copy

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

import vocalis_server as vs
from vocalis.runtime import paths
from wbedit import pairing
from wbedit.store import DocumentStore

CARD = {
    "spec": "chara_card_v2", "spec_version": "2.0",
    "data": {"name": "Test Character 2", "description": "A tall woman.", "personality": "Wry.",
             "scenario": "A tavern.", "first_mes": "You again.", "mes_example": "<START>"},
}


@pytest.fixture
def store(tmp_path):
    return DocumentStore(tmp_path / "wbedit")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")
    monkeypatch.setattr(paths, "WBEDIT_DIR", tmp_path / "wbedit")
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


@pytest.fixture
def auth(client):
    return {"Authorization": f"Bearer {pairing.rotate()}"}


# ── the store ────────────────────────────────────────────────────────────────

def test_deleting_an_imported_document_dismisses_its_st_ref(store):
    doc, _ = store.import_from_st(copy.deepcopy(CARD), kind="card", st_ref="Test Character 2.png",
                                  name="Test Character 2", world_ref="")
    assert store.dismissed() == []
    store.delete(doc.id)
    assert store.dismissed() == ["Test Character 2.png"]
    assert store.is_dismissed("Test Character 2.png")


def test_deleting_an_UPLOADED_document_dismisses_nothing(store):
    """Checks that deleting an uploaded document dismisses nothing."""
    doc = store.create(copy.deepcopy(CARD), name="Test Character 2", kind="card", source="upload")
    store.delete(doc.id)
    assert store.dismissed() == []


def test_the_match_is_exact_not_case_folded(store):
    """Checks that the match is exact not case folded."""
    store.dismiss("Test Character 2.png")
    assert store.is_dismissed("Test Character 2.png")
    assert not store.is_dismissed("test-character-2.png")


def test_restore_takes_one_or_all(store):
    store.dismiss("a.png")
    store.dismiss("b.png")
    assert store.restore("a.png") == 1
    assert store.dismissed() == ["b.png"]
    store.dismiss("c.png")
    assert store.restore() == 2
    assert store.dismissed() == []


def test_dismissing_twice_is_not_two_entries(store):
    store.dismiss("a.png")
    store.dismiss("a.png")
    assert store.dismissed() == ["a.png"]


def test_a_corrupt_dismissed_file_means_NOTHING_is_dismissed(store, tmp_path):
    """Checks that a corrupt dismissed file means nothing is dismissed."""
    import vault_fs
    store.dismiss("a.png")
    vault_fs.write_text(store._dismissed_path(), "{not json")
    assert store.dismissed() == []
    assert not store.is_dismissed("a.png")


# ── the sweep declines, and says so ─────────────────────────────────────────

def test_a_dismissed_document_is_declined_by_the_import_route(client, auth):
    """Checks that a dismissed document is declined by the import route."""
    first = client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD},
                        headers=auth)
    assert first.status_code == 201
    doc_id = first.get_json()["id"]
    assert client.delete(f"/wbedit/documents/{doc_id}").status_code in (200, 204)

    again = client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD},
                        headers=auth)
    assert again.status_code == 200, "a declined push is a SUCCESSFUL, complete push"
    assert again.get_json()["dismissed"] is True
    assert client.get("/wbedit/documents").get_json()["documents"] == [], (
        "the dismissed card must not be re-filed")


def test_restoring_lets_the_next_import_bring_it_back(client, auth):
    doc_id = client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD},
                         headers=auth).get_json()["id"]
    client.delete(f"/wbedit/documents/{doc_id}")
    assert client.get("/wbedit/dismissed").get_json()["refs"] == ["Test Character 2.png"]

    assert client.delete("/wbedit/dismissed").get_json()["restored"] == 1
    back = client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD},
                       headers=auth)
    assert back.status_code == 201 and back.get_json()["created"] is True
    assert len(client.get("/wbedit/documents").get_json()["documents"]) == 1


def test_an_st_ref_with_a_slash_can_still_be_restored(client, auth):
    """Checks that an st ref with a slash can still be restored."""
    client.post("/pair/documents", json={"st_ref": "sub/dir/Test Character 2.png", "document": CARD},
                headers=auth)
    rows = client.get("/wbedit/documents").get_json()["documents"]
    client.delete(f"/wbedit/documents/{rows[0]['id']}")
    assert client.get("/wbedit/dismissed").get_json()["refs"] == ["sub/dir/Test Character 2.png"]

    r = client.delete("/wbedit/dismissed/sub/dir/Test Character 2.png")
    assert r.status_code == 200 and r.get_json()["restored"] == 1



def test_purging_takes_the_ref_out_of_the_bin(store):
    store.dismiss("a.png")
    store.dismiss("b.png")
    assert store.purge("a.png") is True
    assert store.dismissed() == ["b.png"], "the purged ref must leave the list the Library shows"


def test_a_purged_ref_is_STILL_declined(store):
    """A previously purged reference remains excluded from later full import sweeps."""
    store.dismiss("a.png")
    store.purge("a.png")
    assert store.is_dismissed("a.png") is True
    assert store.dismissed_forever() == ["a.png"]


def test_purging_something_not_in_the_bin_changes_nothing(store):
    store.dismiss("a.png")
    assert store.purge("nope.png") is False
    assert store.dismissed() == ["a.png"]
    assert store.dismissed_forever() == []


def test_restore_all_cannot_undo_a_purge(store):
    """Checks that restore all cannot undo a purge."""
    store.dismiss("a.png")
    store.dismiss("b.png")
    store.purge("a.png")
    assert store.restore() == 1, "only the one still in the bin is restorable"
    assert store.is_dismissed("a.png") is True
    assert store.is_dismissed("b.png") is False


def test_purging_twice_is_not_two_entries(store):
    store.dismiss("a.png")
    store.purge("a.png")
    store.dismiss("a.png")          # deleted again, after something brought it back
    store.purge("a.png")
    assert store.dismissed_forever() == ["a.png"]


def test_a_corrupt_forever_file_means_NOTHING_is_purged(store, tmp_path):
    """Checks that a corrupt forever file means nothing is purged."""
    import vault_fs
    store.dismiss("a.png")
    store.purge("a.png")
    vault_fs.write_text(store._forever_path(), "{not json")
    assert store.dismissed_forever() == []
    assert store.is_dismissed("a.png") is False


def test_the_purge_route_keeps_the_import_declining_it(client, auth):
    """Checks that the purge route keeps the import declining it."""
    doc_id = client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD},
                         headers=auth).get_json()["id"]
    client.delete(f"/wbedit/documents/{doc_id}")
    assert client.get("/wbedit/dismissed").get_json()["refs"] == ["Test Character 2.png"]

    r = client.post("/wbedit/dismissed/Test Character 2.png/purge")
    assert r.status_code == 200 and r.get_json()["purged"] is True
    assert client.get("/wbedit/dismissed").get_json()["refs"] == [], "the bin row is gone"

    again = client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD},
                        headers=auth)
    assert again.status_code == 200 and again.get_json()["dismissed"] is True, (
        "a purged document must STILL be declined - permanently means it never comes back")
    assert client.get("/wbedit/documents").get_json()["documents"] == []


def test_an_st_ref_with_a_slash_can_still_be_purged(client, auth):
    """Checks that an st ref with a slash can still be purged."""
    client.post("/pair/documents", json={"st_ref": "sub/dir/Test Character 2.png", "document": CARD},
                headers=auth)
    rows = client.get("/wbedit/documents").get_json()["documents"]
    client.delete(f"/wbedit/documents/{rows[0]['id']}")

    r = client.post("/wbedit/dismissed/sub/dir/Test Character 2.png/purge")
    assert r.status_code == 200 and r.get_json()["purged"] is True
    assert client.get("/wbedit/dismissed").get_json()["refs"] == []




def test_the_rollback_route_puts_a_ref_back_in_the_bin(client, auth):
    """The whole gesture, end to end, in the order the browser performs it."""
    doc_id = client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD},
                         headers=auth).get_json()["id"]
    client.delete(f"/wbedit/documents/{doc_id}")
    client.delete("/wbedit/dismissed/Test Character 2.png")  # Undelete un-declines it
    assert client.get("/wbedit/dismissed").get_json()["refs"] == [], "the row leaves while it tries"

    r = client.post("/wbedit/dismissed", json={"ref": "Test Character 2.png"})  # the import brought nothing
    assert r.status_code == 200 and r.get_json()["dismissed"] is True
    assert client.get("/wbedit/dismissed").get_json()["refs"] == ["Test Character 2.png"], (
        "the row is back, so a second attempt is the same one click")

    # 🔴 AND IT IS DECLINING AGAIN, which is the half a bin row that merely RENDERS would miss.
    again = client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD},
                        headers=auth)
    assert again.get_json()["dismissed"] is True


def test_the_rollback_route_refuses_a_ref_THAT_HAS_A_DOCUMENT(client, auth):
    """Checks that the rollback route refuses a ref that has a document."""
    client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD}, headers=auth)

    r = client.post("/wbedit/dismissed", json={"ref": "Test Character 2.png"})
    assert r.status_code == 409 and r.get_json()["error"] == "has_document"
    assert client.get("/wbedit/dismissed").get_json()["refs"] == [], "and it wrote nothing"


def test_the_rollback_route_refuses_an_empty_ref(client):
    r = client.post("/wbedit/dismissed", json={"ref": "   "})
    assert r.status_code == 400
    assert client.get("/wbedit/dismissed").get_json()["refs"] == []


def test_an_st_ref_with_a_slash_rolls_back(client, auth):
    """Checks that an st ref with a slash rolls back."""
    client.post("/pair/documents", json={"st_ref": "sub/dir/Test Character 2.png", "document": CARD},
                headers=auth)
    rows = client.get("/wbedit/documents").get_json()["documents"]
    client.delete(f"/wbedit/documents/{rows[0]['id']}")
    client.delete("/wbedit/dismissed/sub/dir/Test Character 2.png")
    assert client.get("/wbedit/dismissed").get_json()["refs"] == []

    r = client.post("/wbedit/dismissed", json={"ref": "sub/dir/Test Character 2.png"})
    assert r.status_code == 200
    assert client.get("/wbedit/dismissed").get_json()["refs"] == ["sub/dir/Test Character 2.png"]


def test_rolling_back_twice_is_not_two_rows(client, auth):
    """A retried rollback — the browser's `catch` is not the only way this can be sent twice."""
    doc_id = client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD},
                         headers=auth).get_json()["id"]
    client.delete(f"/wbedit/documents/{doc_id}")
    client.delete("/wbedit/dismissed/Test Character 2.png")
    client.post("/wbedit/dismissed", json={"ref": "Test Character 2.png"})
    client.post("/wbedit/dismissed", json={"ref": "Test Character 2.png"})
    assert client.get("/wbedit/dismissed").get_json()["refs"] == ["Test Character 2.png"]


def test_the_purge_route_still_wins_over_the_rollback_route(client, auth):
    """Checks that the purge route still wins over the rollback route."""
    doc_id = client.post("/pair/documents", json={"st_ref": "Test Character 2.png", "document": CARD},
                         headers=auth).get_json()["id"]
    client.delete(f"/wbedit/documents/{doc_id}")

    r = client.post("/wbedit/dismissed/Test Character 2.png/purge")
    assert r.status_code == 200 and r.get_json().get("purged") is True, (
        "the purge route answered, not a rollback route swallowing the /purge suffix")
    assert client.get("/wbedit/dismissed").get_json()["refs"] == []
    assert "Test Character 2.png/purge" not in client.get("/wbedit/dismissed").get_json()["refs"]
