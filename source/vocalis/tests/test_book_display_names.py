"""Book title presentation and rename behavior."""
import threading
import os
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

import book_state
import tts_utils
import vocalis.runtime.jobs as jobs
from conftest import REPO_ROOT  # noqa: F401 - establishes the project import path
from book_to_audio import books_root
from vocalis.web import books as web_books
from vocalis.web import system as web_system
import vocalis_server as vs


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as test_client:
        yield test_client


@pytest.fixture
def tmp_output(monkeypatch, tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    chunks = tmp_path / "chunks"
    chunks.mkdir()
    monkeypatch.setattr(web_books, "OUTPUT_DIR", output)
    monkeypatch.setattr(web_books, "CHUNKS_ROOT", chunks)
    monkeypatch.setattr(web_system, "OUTPUT_DIR", output)
    return output


@pytest.fixture
def encrypted_book_store(tmp_path, monkeypatch):
    import vault
    import vault_store

    monkeypatch.setattr(vault, "DEFAULT_KDF", {
        "algo": "argon2id", "memory_kib": 8 * 1024, "time_cost": 1, "parallelism": 1})
    install, cache = tmp_path / "install", tmp_path / "cache"
    install.mkdir()
    cache.mkdir()
    store = vault_store.configure([("install", install), ("cache", cache)],
                                  install / "vault_keys.yaml")
    store.create("book display test")
    monkeypatch.setattr(vault_store, "STORE", store)
    return install


def _book(tmp_path, name='Sample Book (Sample Voice)'):
    root = books_root(tmp_path)
    d = root / name
    (d / "mp3").mkdir(parents=True)
    (d / "mp3" / "00_Chapter_1.mp3").write_bytes(b"audio")
    return root, d


def test_library_uses_voice_label_but_keeps_stable_book_reference(
        client, tmp_output, monkeypatch):
    root, d = _book(tmp_output)
    book_state.write_sidecar(d, {"source_docx": 'Sample Book.docx', "voice": 'sample_voice.wav',
                                 "params": {}, "chapters": []})
    monkeypatch.setattr(web_system.voice_utils, "get_labels", lambda _path: {'sample_voice.wav': 'Sample Voice v2'})

    response = client.get("/library")

    assert response.status_code == 200
    row = next(item for item in response.get_json() if item["book"] == d.name)
    assert row["display_name"] == 'Sample Book (Sample Voice v2)'
    assert row["voice_label"] == 'Sample Voice v2'
    assert row["voice"] == 'sample_voice.wav'
    assert row["has_sidecar"] is True
    assert row["has_render_metadata"] is True


def test_library_model_default_and_imported_rename_metadata(client, tmp_output):
    root, imported = _book(tmp_output, "Imported")
    renamed = client.post("/book/Imported/rename", json={"name": "My Favorite Book"})
    assert renamed.status_code == 200
    assert renamed.get_json() == {"book": "Imported", "display_name": "My Favorite Book"}

    row = next(item for item in client.get("/library").get_json() if item["book"] == "Imported")
    assert row["display_name"] == "My Favorite Book"
    assert row["has_sidecar"] is True
    assert row["has_render_metadata"] is False
    assert set(book_state.load_sidecar(imported)) == {"display_name", "updated"}
    detail = client.get("/output/Imported").get_json()
    assert detail["display_name"] == "My Favorite Book"
    assert detail["has_sidecar"] is True
    assert detail["has_render_metadata"] is False

    default = root / "Default Voice"
    (default / "mp3").mkdir(parents=True)
    (default / "mp3" / "00_chapter.mp3").write_bytes(b"audio")
    book_state.write_sidecar(default, {"source_docx": "Default Voice.docx", "voice": ""})
    row = next(item for item in client.get("/library").get_json() if item["book"] == "Default Voice")
    assert row["display_name"] == "Default Voice"
    assert row["has_render_metadata"] is True


def test_library_rendered_at_uses_only_audio_artifact_mtimes(client, tmp_output):
    root, d = _book(tmp_output, "Timestamp Book")
    audio = d / "mp3" / "00_Chapter_1.mp3"
    audio_time = time.time() - 3600
    os.utime(audio, (audio_time, audio_time))
    book_state.write_sidecar(d, {"display_name": "Cosmetic Rename"})
    sidecar = book_state.sidecar_path(d)
    future = time.time() + 3600
    os.utime(sidecar, (future, future))

    row = next(item for item in client.get("/library").get_json()
               if item["book"] == "Timestamp Book")
    assert row["rendered_at"] == pytest.approx(audio_time, abs=0.01)


def test_rename_before_first_chapter_uses_registered_job_reference(client, monkeypatch, tmp_output):
    job = jobs.Job(id="renameearly", docx="C:/private/Source Book.docx", voice='sample_voice.wav',
                   params=tts_utils.GenParams(), gpus="cpu", workers=1,
                   out_name='Source Book (Sample Voice)')
    with jobs.JOBS_LOCK:
        jobs.JOBS[job.id] = job
    monkeypatch.setattr(web_books.voice_utils, "get_labels", lambda _path: {'sample_voice.wav': 'Sample Voice'})
    try:
        row = next(item for item in client.get("/book/jobs").get_json() if item["id"] == job.id)
        assert row["book"] == job.out_name
        assert row["voice"] == 'sample_voice.wav'
        assert row["display_name"] == 'Source Book (Sample Voice)'
        assert row["voice_label"] == 'Sample Voice'
        assert row["output_dir"] is None

        response = client.post(f"/book/{job.out_name}/rename", json={"name": "A Better Title"})
        assert response.status_code == 200
        sidecar = book_state.load_sidecar(books_root(tmp_output) / job.out_name)
        assert sidecar == {"display_name": "A Better Title", "updated": sidecar["updated"]}
        assert "voice" not in sidecar and "source_docx" not in sidecar and "chapters" not in sidecar
        row = next(item for item in client.get("/book/jobs").get_json() if item["id"] == job.id)
        assert row["display_name"] == "A Better Title"
        assert row["voice_label"] == 'Sample Voice'
    finally:
        with jobs.JOBS_LOCK:
            jobs.JOBS.pop(job.id, None)


def test_rename_is_preserved_by_resume_and_finalize(tmp_path):
    d = tmp_path / "book"
    d.mkdir()
    sections = [{"index": 0, "title": "One", "filename": "00_One"}]
    book_state.init_sidecar(d, "book.docx", "V.wav", None, {}, sections)
    book_state._rename_book_unlocked(d, book_state.load_sidecar(d), "Chosen Title")
    book_state.init_sidecar(d, "book.docx", "V.wav", None, {}, sections)
    book_state.update_chapter(d, 0, status="done", voice="V.wav", duration_s=2.0)
    book_state.finalize(d, 2.0)
    assert book_state.load_sidecar(d)["display_name"] == "Chosen Title"


@pytest.mark.parametrize("body", [{}, {"name": "  "}, {"name": "bad\nname"},
                                   {"name": "bad\u0085name"},
                                   {"name": "x" * 513}, {"name": 42}, {"name": None}])
def test_rename_rejects_invalid_names(client, body):
    assert client.post("/book/anything/rename", json=body).status_code == 400


def test_rename_rejects_missing_traversal_and_corrupt_books(client, tmp_output):
    assert client.post("/book/missing/rename", json={"name": "Title"}).status_code == 404
    assert client.post("/book/%2e%2e/rename", json={"name": "Title"}).status_code == 400
    root, d = _book(tmp_output, "Corrupt")
    path = book_state.sidecar_path(d)
    path.write_text("{{{", encoding="utf-8")
    before = path.read_bytes()
    assert client.post("/book/Corrupt/rename", json={"name": "Title"}).status_code == 409
    assert path.read_bytes() == before


def test_concurrent_rename_and_chapter_update_preserve_both(tmp_path):
    d = tmp_path / "book"
    d.mkdir()
    sections = [{"index": 0, "title": "One", "filename": "00_One"}]
    book_state.init_sidecar(d, "book.docx", "V.wav", None, {}, sections)
    barrier = threading.Barrier(2)

    def rename():
        barrier.wait()
        with book_state._sidecar_lock(d):
            sc = book_state._load_sidecar_unlocked(d, strict=True)
            book_state._rename_book_unlocked(d, sc, "Concurrent Title")

    def update():
        barrier.wait()
        book_state.update_chapter(d, 0, status="done", voice="V.wav", duration_s=3.0)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(rename), pool.submit(update)]
        for future in futures:
            future.result()

    sc = book_state.load_sidecar(d)
    assert sc["display_name"] == "Concurrent Title"
    assert sc["chapters"][0]["status"] == "done"


def test_encrypted_sidecar_round_trip_keeps_rename_and_render_metadata(encrypted_book_store):
    import vault_fs

    output = encrypted_book_store / "output" / "books"
    d = output / "Synthetic Book"
    vault_fs.mkdir(d)
    book_state.write_sidecar(d, {"source_docx": "Synthetic Book.docx", "voice": "",
                                 "params": {}, "chapters": [], "total_duration_s": 0})
    with book_state._sidecar_lock(d):
        sc = book_state._load_sidecar_unlocked(d, strict=True)
        book_state._rename_book_unlocked(d, sc, "Encrypted Friendly Title")

    row = next(item for item in book_state.scan_library(output) if item["book"] == d.name)
    assert row["display_name"] == "Encrypted Friendly Title"
    assert row["has_render_metadata"] is True
    assert book_state.load_sidecar(d)["source_docx"] == "Synthetic Book.docx"


def test_clear_serializes_with_rename_and_cannot_leave_a_recreated_book(
        tmp_output, monkeypatch):
    import vocalis_server as vs

    root, d = _book(tmp_output, "Race Book")
    book_state.write_sidecar(d, {"source_docx": "Race Book.docx", "voice": ""})
    start = threading.Barrier(3)
    outcomes = {}

    def request(action):
        start.wait()
        with vs.app.test_client() as test_client:
            if action == "rename":
                response = test_client.post("/book/Race%20Book/rename", json={"name": "Renamed"})
            else:
                response = test_client.post("/book/clear/Race%20Book", json={"confirm": "Race Book"})
            outcomes[action] = response.status_code

    pool = ThreadPoolExecutor(max_workers=2)
    try:
        with book_state._sidecar_lock(d):
            rename_future = pool.submit(request, "rename")
            clear_future = pool.submit(request, "clear")
            start.wait()
        rename_future.result()
        clear_future.result()
    finally:
        pool.shutdown(wait=True)

    assert outcomes["clear"] == 200
    assert outcomes["rename"] in (200, 404)
    assert not d.exists()
