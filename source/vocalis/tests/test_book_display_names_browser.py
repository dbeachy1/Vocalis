"""Book display names and rename actions in an isolated real browser."""
import os
import json
import shutil
import socket
import subprocess
import threading
from pathlib import Path

import pytest
import yaml

from conftest import REPO_ROOT, assert_spec_ran, bound_server

SPEC = Path(__file__).parent / "book_display_names_browser_spec.mjs"
NODE = shutil.which("node")


def _chrome():
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for name in ("chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    for path in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                 r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                 "/usr/bin/google-chrome", "/usr/bin/chromium"):
        if Path(path).exists():
            return path
    return None


@pytest.mark.skipif(NODE is None, reason="node is not installed")
@pytest.mark.skipif(_chrome() is None, reason="Chrome is not installed")
def test_display_names_and_rename_actions_in_a_real_browser(tmp_path, monkeypatch):
    out = tmp_path / "output"
    cache = tmp_path / "cache"
    settings = tmp_path / "app_settings.yaml"
    out.mkdir()
    cache.mkdir()
    settings.write_text(yaml.safe_dump({"output_dir": str(out)}), encoding="utf-8")
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(cache))

    import book_state
    import book_to_audio
    import tts_utils
    from vocalis.runtime import jobs
    from vocalis.web import books as web_books
    from vocalis.web import system as web_system
    import vocalis.runtime.paths as paths
    import vocalis.runtime.settings as runtime_settings
    import vocalis_server as vs

    monkeypatch.setattr(runtime_settings, "APP_SETTINGS", settings)
    monkeypatch.setattr(book_to_audio, "OUTPUT_DIR", out)
    monkeypatch.setattr(web_books, "OUTPUT_DIR", out)
    monkeypatch.setattr(web_system, "OUTPUT_DIR", out)
    monkeypatch.setattr(paths, "VOICE_SETTINGS", tmp_path / "voice_settings.yaml")

    labels_path = tmp_path / "voice_labels.json"
    labels_path.write_text(json.dumps({'Test_Voice_1.wav': 'Test Voice 1 Current'}), encoding="utf-8")
    get_labels = lambda _path: json.loads(labels_path.read_text(encoding="utf-8"))
    monkeypatch.setattr(web_books.voice_utils, "get_labels", get_labels)
    monkeypatch.setattr(web_system.voice_utils, "get_labels", get_labels)

    books_root = book_to_audio.books_root(out)
    rendered_refs = ["heart-magic-ref", "second-story-ref"]
    for ref, source in zip(rendered_refs, ('Test Book One.docx', 'Test Book Two.docx')):
        book_dir = books_root / ref
        audio_dir = book_dir / "mp3"
        audio_dir.mkdir(parents=True)
        (audio_dir / "00_Chapter_1.mp3").write_bytes(b"ID3" + b"\0" * 128)
        if ref == "heart-magic-ref":
            (book_dir / f"{ref}_full.opus").write_bytes(b"complete opus test bytes")
            (book_dir / f"{ref}_full.mp3").write_bytes(b"complete mp3 test bytes")
            (book_dir / f"{ref}_full.m4a").write_bytes(b"")
        elif ref == "second-story-ref":
            (book_dir / f"{ref}_full.mp3").write_bytes(b"complete mp3 test bytes")
        book_state.write_sidecar(book_dir, {
            "source_docx": source,
            "voice": 'Test_Voice_1.wav',
            "params": {},
            "chapters": [{"index": 0, "title": "Chapter 1", "filename": "00_Chapter_1",
                          "status": "done", "voice": 'Test_Voice_1.wav'}],
        })

    imported_ref = "manual-import"
    imported_audio = books_root / imported_ref / "mp3"
    imported_audio.mkdir(parents=True)
    (imported_audio / "Chapter_Only.mp3").write_bytes(b"ID3" + b"\0" * 128)

    live_job = jobs.Job(
        id="display-name-browser-job",
        docx=str(tmp_path / "Queued Synthetic Story.docx"),
        voice='Test_Voice_1.wav',
        params=tts_utils.GenParams(),
        gpus="cpu",
        workers=1,
        status="running",
        out_name="queued-source-ref",
    )
    with jobs.JOBS_LOCK:
        jobs.JOBS[live_job.id] = live_job

    monkeypatch.setitem(vs.app.config, "TESTING", False)
    previous_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(60.0)
    server = bound_server(vs.app)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    before_screenshot = REPO_ROOT / ".codex" / "qa" / "book-display-names-before-rename.png"
    after_screenshot = REPO_ROOT / ".codex" / "qa" / "book-display-names-after-rename.png"
    before_screenshot.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            [NODE, str(SPEC), f"http://127.0.0.1:{server.server_port}/", _chrome(),
             str(before_screenshot), str(after_screenshot), str(labels_path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )
    finally:
        server.shutdown()
        thread.join(timeout=10)
        socket.setdefaulttimeout(previous_timeout)
        with jobs.JOBS_LOCK:
            jobs.JOBS.pop(live_job.id, None)

    assert result.returncode == 0, f"book display names failed in a real browser:\n{result.stdout}\n{result.stderr}"
    assert_spec_ran(result, SPEC, floor=19)
    for assertion in (
        "automatic titles use the current voice label",
        "raw voice filename follows its friendly label",
        "imported books retain their imported indicator",
        "queued jobs show their registered stable reference and label",
        "queued books can be renamed before their first chapter",
        "a renamed live book keeps job voice details and shows metadata pending instead of imported",
        "Cancel leaves the current title alone",
        "Save keeps the stable book reference",
        "the selected heading updates without replacing its audio node",
        "the explicit title survives a voice-label change and reload",
        "filtering matches the display name",
        "title sorting follows display names",
        "no uncaught page errors",
    ):
        assert assertion in result.stdout, f"browser assertion did not run: {assertion}\n{result.stdout}"
