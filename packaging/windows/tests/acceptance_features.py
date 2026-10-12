"""Feature acceptance sweep for an installed Vocalis test instance, driven through a headless browser session.

Where acceptance_browser.py proves the install itself (first-run setup, pairing, one narration),
this walks every workflow in the Vocalis feature map in order: Playground, voices, VoxCPM2 design,
Book, Bulk, Speech, Stems, ACE-Step, Clips, a Scene built from a Taproom chat, diagnostics,
settings and pairing, the excluded routes, and a UI smoke over every tab. Each step is named and
records PASS, FAIL (with the server's own error text, the last requests, and the new server log
lines) or EXPECTED-UNAVAILABLE (only where the product holds a model back for licensing; since October 11, 2026
no step does, because setup downloads every model, so the status is kept for a future hold). One
failing step never stops the run. A table is printed at the end and a JSON file is written.

API calls go through the Playwright browser context's request API, so the Vocalis session cookie
set at login applies to them exactly as it does to the page; the X-CSRF-Token header (read from
the page's csrf meta tag) is sent where the server enforces it. Calls that must prove the pairing
bearer on its own (/pair/ping, /speak/ping, /v1/*) use a second request context with no cookies.

Audio: Chromium is launched headless with --mute-audio, so nothing can reach the speakers and no
window opens (Doug, October 9, 2026: test narration reached his speakers from a visible browser).

Secrets: the Vocalis password is read from the secrets folder and never printed. The recovery key
minted by the rotate-recovery step is written to the secrets folder (vocalis-recovery-key,
replacing the old one) and is never printed or put in the JSON result.

Product defects found are only recorded here (request, response, server log lines); this file
changes nothing in the product.

Usage (run Python WITHOUT -I so it finds Playwright):
    python acceptance_features.py [--vocalis URL] [--taproom URL] [--secrets DIR] [--out-dir DIR]
                                  [--log FILE] [--only 01,12,14]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import secrets as pysecrets
import shutil
import struct
import sys
import time
import traceback
import wave
import zipfile
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import acceptance_browser as ab  # noqa: E402  (reused: vocalis_login, taproom_login, pairing_token)
from playwright.sync_api import TimeoutError as PlaywrightTimeout  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

REPO = HERE.parents[2]

DEFAULT_VOCALIS = "http://127.0.0.1:18770"
DEFAULT_TAPROOM = "http://127.0.0.1:18771"
# No machine-specific defaults: pass --secrets, --out-dir and --log for the install under test.
DEFAULT_SECRETS = Path("vocalis-test-secrets")
DEFAULT_OUT = Path("vocalis-test-out")
DEFAULT_LOG = Path("vocalis-test-logs") / "vocalis" / "vocalis.log"

PASS, FAIL, EXPECTED = "PASS", "FAIL", "EXPECTED-UNAVAILABLE"

# Every wait is bounded; these are the safety deadlines in seconds (a timeout is a FAIL).
PG_RENDER_S = 600       # Playground render: the stream is read to its end, model may be cold
JOB_DONE_S = 300        # short GPU/CPU jobs (cleanup, enhance of a few seconds of audio)
BOOK_S = 900
BULK_S = 600
DESIGN_S = 600
ACE_UP_S = 240
ACE_LOAD_S = 1800       # a 19 GB model off a cold disk
ACE_GEN_S = 900
SCENE_S = 900

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

# The server's own words when the HTDemucs weights are not on disk (stems.require_demucs_model).
# October 11, 2026: setup downloads them (the earlier licensing hold, which made this answer an EXPECTED-UNAVAILABLE
# result, is lifted), so this answer now means setup did not finish and the split is a FAIL, never expected.
STEMS_MISSING_RE = re.compile(r"has not been downloaded yet", re.I)


def say(text: str) -> None:
    print(time.strftime("%H:%M:%S"), text, flush=True)


class Fail(Exception):
    """A step failed; the message is what goes in the results table."""


class Expected(Exception):
    """A step hit a feature the edition holds back; the message is the server's own explanation."""


# ── HTTP helpers ─────────────────────────────────────────────────────────────────────────

def q(segment: str) -> str:
    """Percent-encode one path segment."""
    return quote(str(segment), safe="")


def qpath(ref: str) -> str:
    """Percent-encode a ref that legitimately contains '/' (Playground clip refs are vdir/stem)."""
    return quote(str(ref), safe="/")


def encode_multipart(fields):
    """fields: list of (name, value) where value is a string or (filename, bytes, mime). Repeated
    names are allowed (the stems upload sends several `file` parts), which Playwright's own
    multipart dict cannot express."""
    boundary = "----accfeat" + pysecrets.token_hex(12)
    out = bytearray()
    for name, value in fields:
        out += f"--{boundary}\r\n".encode()
        if isinstance(value, tuple):
            filename, data, mime = value
            out += (f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                    f"Content-Type: {mime}\r\n\r\n").encode()
            out += data
        else:
            out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
            out += str(value).encode()
        out += b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


class Resp:
    def __init__(self, status: int, body: bytes, headers: dict):
        self.status = status
        self.body = body
        self.headers = headers
        self._json = None
        self._parsed = False

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    @property
    def json(self):
        if not self._parsed:
            self._parsed = True
            try:
                self._json = json.loads(self.body.decode("utf-8"))
            except Exception:  # noqa: BLE001 — not JSON is an ordinary answer (HTML 404, audio)
                self._json = None
        return self._json

    def err(self) -> str:
        """The server's own error text: JSON error/message fields, else the start of the body."""
        j = self.json
        parts = []
        if isinstance(j, dict):
            e = j.get("error")
            if isinstance(e, dict):
                e = e.get("message") or e.get("type")
            if e:
                parts.append(str(e))
            if j.get("message") and str(j["message"]) not in parts:
                parts.append(str(j["message"]))
        if parts:
            return " | ".join(parts)
        if self.headers.get("content-type", "").startswith(("audio/", "application/zip")):
            return f"<{len(self.body)} bytes of {self.headers.get('content-type')}>"
        return self.text.strip()[:300]


class Api:
    """One request context against one base URL, recording a trace of its exchanges per step."""

    def __init__(self, ctx, base: str, name: str):
        self.ctx = ctx
        self.base = base.rstrip("/")
        self.name = name
        self.trace: list[dict] = []
        self.csrf = ""

    def call(self, method: str, path: str, *, body=None, fields=None, headers=None,
             timeout: float = 60.0, secret: bool = False, bearer: str | None = None) -> Resp:
        hdr = dict(headers or {})
        data = None
        if bearer:
            hdr["Authorization"] = "Bearer " + bearer
        if body is not None:
            data = json.dumps(body).encode()
            hdr["Content-Type"] = "application/json"
        elif fields is not None:
            data, content_type = encode_multipart(fields)
            hdr["Content-Type"] = content_type
        started = time.monotonic()
        r = self.ctx.fetch(self.base + path, method=method, data=data, headers=hdr,
                           timeout=timeout * 1000, max_redirects=0)
        resp = Resp(r.status, r.body(), {k.lower(): v for k, v in r.headers.items()})
        if secret:
            request_body, response_text = "<redacted>", "<redacted>"
        else:
            if body is not None:
                request_body = json.dumps(body)[:300]
            elif fields is not None:
                request_body = f"<multipart {len(data)} bytes>"
            else:
                request_body = None
            if resp.status >= 400 or resp.json is not None:
                response_text = resp.err()[:600] if resp.status >= 400 else resp.text[:300]
            else:
                response_text = f"<{len(resp.body)} bytes {resp.headers.get('content-type', '')}>"
        self.trace.append({
            "api": self.name, "request": f"{method} {path}", "request_body": request_body,
            "status": resp.status, "seconds": round(time.monotonic() - started, 2),
            "response": response_text,
        })
        return resp

    def get(self, path, **kw):
        return self.call("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.call("POST", path, body=body if body is not None else {}, **kw)

    def expect(self, resp: Resp, status, what: str) -> Resp:
        ok = (status,) if isinstance(status, int) else tuple(status)
        if resp.status not in ok:
            raise Fail(f"{what}: HTTP {resp.status}: {resp.err()}")
        return resp

    def get_json(self, path, what=None, ok=200, **kw):
        r = self.expect(self.get(path, **kw), ok, what or f"GET {path}")
        if r.json is None:
            raise Fail(f"GET {path}: answered {r.status} but not JSON: {r.text[:200]}")
        return r.json


# ── step runner ──────────────────────────────────────────────────────────────────────────

class Runner:
    def __init__(self, apis: list[Api], log_path: Path, only: set[str]):
        self.apis = apis
        self.log_path = log_path
        self.only = only
        self.results: list[dict] = []
        self.S: dict = {}

    def log_size(self) -> int:
        try:
            return self.log_path.stat().st_size
        except OSError:
            return 0

    def log_since(self, mark: int, limit: int = 25) -> list[str]:
        try:
            with open(self.log_path, "rb") as f:
                f.seek(mark if mark <= self.log_path.stat().st_size else 0)
                text = f.read().decode("utf-8", "replace")
        except OSError as exc:
            return [f"<server log unreadable: {exc}>"]
        lines = [ANSI_RE.sub("", ln)[:400] for ln in text.splitlines() if ln.strip()]
        return lines[-limit:]

    def run(self, sid: str, name: str, fn, needs: tuple = ()) -> None:
        if self.only and sid[:2] not in self.only:
            return
        for api in self.apis:
            api.trace = []
        mark = self.log_size()
        started = time.monotonic()
        status, note = PASS, ""
        missing = [k for k in needs if k not in self.S]
        try:
            if missing:
                raise Fail("blocked: an earlier step did not produce " + ", ".join(missing))
            out = fn()
            note = out if isinstance(out, str) else ""
        except Fail as exc:
            status, note = FAIL, str(exc)
        except Expected as exc:
            status, note = EXPECTED, str(exc)
        except Exception as exc:  # noqa: BLE001 — a bug in the step or an unexpected shape; never stops the run
            status = FAIL
            note = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
        seconds = round(time.monotonic() - started, 1)
        rec = {"id": sid, "name": name, "status": status, "note": note, "seconds": seconds}
        if status in (FAIL, EXPECTED):
            rec["requests"] = [t for api in self.apis for t in api.trace][-6:]
            rec["server_log"] = self.log_since(mark)
        self.results.append(rec)
        say(f"{sid} {name}: {status} ({seconds}s){' - ' + note if note else ''}")


def wait_for(desc: str, probe, done, *, deadline_s: float, interval: float = 2.0, failed=None):
    """Poll `probe` until `done(value)`; `failed(value)` returns an error text to fail early."""
    started = time.monotonic()
    while True:
        value = probe()
        if failed is not None:
            message = failed(value)
            if message:
                raise Fail(message)
        if done(value):
            return value
        if time.monotonic() - started > deadline_s:
            raise Fail(f"timed out after {deadline_s:.0f}s waiting for {desc}; last answer: "
                       f"{json.dumps(value, default=str)[:400]}")
        time.sleep(interval)


# ── generated test inputs ────────────────────────────────────────────────────────────────

def make_tone_wav(seconds: float, freq: float, rate: int = 24000) -> bytes:
    """A small mono 16-bit sine WAV, built with the standard library (no ffmpeg needed)."""
    import io
    frames = bytearray()
    for i in range(int(seconds * rate)):
        frames += struct.pack("<h", int(8000 * math.sin(2 * math.pi * freq * i / rate)))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def make_docx(path: Path, chapters: list[tuple[str, str]]) -> None:
    """A tiny valid .docx built by hand: one Heading 1 per chapter followed by its body paragraph.
    python-docx is not required; the product's parser (python-docx) reads the style names."""
    def esc(s: str) -> str:
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    body = []
    for title, text in chapters:
        body.append(f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>{esc(title)}</w:t></w:r></w:p>')
        body.append(f"<w:p><w:r><w:t>{esc(text)}</w:t></w:r></w:p>")
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    document = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {ns}><w:body>'
                + "".join(body) + "<w:sectPr/></w:body></w:document>")
    styles = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {ns}>'
              '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
              '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>'
              '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/></w:style>'
              '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>'
              '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/></w:style></w:styles>')
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                     '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                     "</Types>")
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>")
    doc_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
                "</Relationships>")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
        z.writestr("word/styles.xml", styles)
        z.writestr("word/_rels/document.xml.rels", doc_rels)


def audio_ok(resp: Resp, what: str, min_bytes: int = 1000) -> str:
    if resp.status != 200:
        raise Fail(f"{what}: HTTP {resp.status}: {resp.err()}")
    if len(resp.body) < min_bytes:
        raise Fail(f"{what}: only {len(resp.body)} bytes came back")
    return f"{len(resp.body)} bytes {resp.headers.get('content-type', '')}"


# ── the steps ────────────────────────────────────────────────────────────────────────────

def build_steps(R: Runner, V: Api, B: Api, page, context, args, tmp: Path) -> None:
    S = R.S
    base = args.vocalis.rstrip("/")
    secrets_dir = Path(args.secrets)
    stamp = time.strftime("%H%M%S")
    run_id = f"accfeat{stamp}"

    def pg_render(text: str, voice: str = "") -> dict:
        r = V.expect(V.post("/playground/stream", {
            "text": text, "voice": voice, "exaggeration": 0.5, "cfg": 0.5, "temperature": 0.8,
            "enhance": False}), 202, "POST /playground/stream")
        j = r.json or {}
        if not j.get("job_id") or not j.get("stream_url"):
            raise Fail(f"stream start answered without job_id/stream_url: {r.text[:300]}")
        stream = V.get(j["stream_url"], timeout=PG_RENDER_S)
        V.expect(stream, 200, "read the stream to its end")
        if not stream.body:
            raise Fail("the stream ended with zero bytes")
        status = wait_for(
            "the Playground job to finish", lambda: V.get_json("/book/status/" + q(j["job_id"])),
            lambda d: d.get("status") in ("done", "failed", "canceled"), deadline_s=120, interval=1.0)
        if status["status"] != "done":
            raise Fail(f"Playground job {status['status']}: {status.get('error')}")
        if not status.get("clip"):
            raise Fail("Playground job finished without a clip ref")
        return {"job_id": j["job_id"], "ref": status["clip"], "stream_bytes": len(stream.body),
                "content_type": stream.headers.get("content-type", "")}

    # 01 Login ------------------------------------------------------------------------
    def login():
        password = ab.read_secret(secrets_dir, "vocalis-password")
        if not password:
            raise Fail("no vocalis-password in the secrets folder")
        page.goto(base + "/login", wait_until="domcontentloaded")
        ab.vocalis_login(page, base, password)
        probe = V.get("/system/stats")
        V.expect(probe, 200, "authenticated probe GET /system/stats after login")
        index = V.get("/")
        V.expect(index, 200, "GET / (the UI shell)")
        m = re.search(r'<meta name="csrf" content="([^"]+)"', index.text)
        if not m:
            raise Fail("the UI shell carried no csrf meta tag")
        V.csrf = m.group(1)
        S["login"] = True
        return "session cookie accepted; csrf token read from the page"
    R.run("01a", "Login (session in browser context)", login)

    # 02 Playground -------------------------------------------------------------------
    def pg_stream():
        got = pg_render("Acceptance sweep one. This is a short test sentence for the Playground.")
        S["clip_default"] = got["ref"]
        return f"stream {got['stream_bytes']} bytes ({got['content_type']}), clip {got['ref']}"
    R.run("02a", "Playground stream render (read to the end)", pg_stream, needs=("login",))

    def pg_listed():
        rows = V.get_json("/playground/clips")
        row = next((r for r in rows if r.get("ref") == S["clip_default"] and r.get("kind") == "clip"), None)
        if not row:
            raise Fail(f"clip {S['clip_default']} is not in GET /playground/clips ({len(rows)} rows)")
        return f"listed: {row.get('duration_s')}s, {row.get('size')} bytes"
    R.run("02b", "Playground clip listed", pg_listed, needs=("clip_default",))

    def pg_audio():
        r = V.get("/playground/clips/" + qpath(S["clip_default"]) + "/audio?download=1")
        note = audio_ok(r, "clip audio download")
        S["clip_audio"] = r.body
        return note
    R.run("02c", "Playground clip audio downloaded", pg_audio, needs=("clip_default",))

    def pg_favorite():
        r = V.expect(V.post("/playground/clips/" + qpath(S["clip_default"]) + "/favorite",
                            {"favorite": True}), 200, "favorite")
        if (r.json or {}).get("favorite") is not True:
            raise Fail(f"favorite not stored: {r.text[:200]}")
        rows = V.get_json("/playground/clips")
        row = next((x for x in rows if x.get("ref") == S["clip_default"]), {})
        if not row.get("favorite"):
            raise Fail("the listing does not show the clip as a favorite")
        return "favorite stored and listed"
    R.run("02d", "Playground clip favorite", pg_favorite, needs=("clip_default",))

    def pg_zip():
        r = V.post("/playground/clips/zip", {"clips": [S["clip_default"]]}, timeout=120)
        V.expect(r, 200, "zip export")
        import io
        z = zipfile.ZipFile(io.BytesIO(r.body))
        names = z.namelist()
        if not names or z.testzip() is not None:
            raise Fail(f"zip is empty or corrupt: {names}")
        return f"zip {len(r.body)} bytes, entries: {names}"
    R.run("02e", "Playground zip export", pg_zip, needs=("clip_default",))

    # 03 Voice upload ------------------------------------------------------------------
    def voice_upload():
        label = f"{run_id}-uploaded"
        r = V.expect(V.call("POST", "/voices", fields=[
            ("name", label), ("file", (label + ".mp3", S["clip_audio"], "audio/mpeg"))],
            timeout=180), 200, "POST /voices")
        name = (r.json or {}).get("name")
        if not name:
            raise Fail(f"upload answered without a voice name: {r.text[:300]}")
        S["voice_up"] = name
        return f"voice {name}, peak {(r.json or {}).get('peak_dbfs')} dBFS"
    R.run("03a", "Voice upload (Playground clip as the reference)", voice_upload, needs=("clip_audio",))

    def voice_listed():
        rows = V.get_json("/voices")
        if not any(v.get("name") == S["voice_up"] for v in rows):
            raise Fail(f"voice {S['voice_up']} not in GET /voices ({len(rows)} voices)")
        return f"{len(rows)} voices listed"
    R.run("03b", "Voice listed", voice_listed, needs=("voice_up",))

    def voice_render():
        got = pg_render("Acceptance sweep two. This line is spoken with the uploaded voice.", S["voice_up"])
        S["clip_voice"] = got["ref"]
        return f"clip {got['ref']}, stream {got['stream_bytes']} bytes"
    R.run("03c", "Playground render with the uploaded voice", voice_render, needs=("voice_up",))

    # 04 VoxCPM2 design ---------------------------------------------------------------
    def design():
        r = V.post("/voices/design", {
            "prompt": "A calm adult narrator with a warm, low voice",
            "sample_text": "This is a designed voice for the acceptance sweep.",
            "steps": 10, "seed": 12345}, timeout=60)
        V.expect(r, 202, "POST /voices/design")
        job_id = (r.json or {}).get("job_id")
        if not job_id:
            raise Fail("design answered without a job_id")
        done = wait_for(
            "VoxCPM2 design", lambda: V.get_json("/voices/design/status/" + q(job_id)),
            lambda d: d.get("status") != "running", deadline_s=DESIGN_S, interval=3.0)
        if done["status"] != "done" or not done.get("candidates"):
            raise Fail(f"design {done['status']}: errors={done.get('errors')} log tail={done.get('log', [])[-3:]}")
        S["design_token"] = done["candidates"][0]["token"]
        return f"candidate ready, seed {done['candidates'][0].get('seed')}, {done['candidates'][0].get('duration_s')}s"
    R.run("04a", "VoxCPM2 design (seed 12345, steps 10)", design, needs=("login",))

    def design_save():
        label = f"{run_id}-designed"
        r = V.expect(V.post("/voices/design/save", {"token": S["design_token"], "name": label}),
                     200, "POST /voices/design/save")
        name = (r.json or {}).get("name")
        if not name:
            raise Fail(f"save answered without a name: {r.text[:200]}")
        rows = V.get_json("/voices")
        if not any(v.get("name") == name for v in rows):
            raise Fail(f"saved voice {name} is not listed")
        S["voice_design"] = name
        return f"saved as {name}"
    R.run("04b", "Designed voice saved as a voice", design_save, needs=("design_token",))

    def design_render():
        got = pg_render("Acceptance sweep three. This line is spoken with the designed voice.", S["voice_design"])
        S["clip_design"] = got["ref"]
        return f"clip {got['ref']}, stream {got['stream_bytes']} bytes"
    R.run("04c", "Playground render with the designed voice", design_render, needs=("voice_design",))

    def voice_clean():
        label = f"{run_id}-clean"
        r = V.expect(V.post(f"/voices/{q(S['voice_up'])}/clean",
                            {"dereverb": False, "enhance": True, "label": label}),
                     202, "POST /voices/<name>/clean")
        job_id = (r.json or {}).get("job_id")
        done = wait_for(
            "voice clean", lambda: V.get_json("/voices/clean/status/" + q(job_id)),
            lambda d: d.get("status") != "running", deadline_s=JOB_DONE_S, interval=3.0)
        if done["status"] != "done":
            raise Fail(f"voice clean {done['status']}: {done.get('error')} (note: {done.get('note')})")
        return f"new voice {done.get('voice')}, enhanced={done.get('enhanced')}"
    R.run("04d", "Voice clean (enhance, from the uploaded voice)", voice_clean, needs=("voice_up",))

    # 05 Book -------------------------------------------------------------------------
    def book_upload():
        name = f"{run_id}-book.docx"
        path = tmp / name
        make_docx(path, [("Chapter One", "The first chapter is short. It has two sentences."),
                         ("Chapter Two", "The second chapter is also short. It ends the book.")])
        r = V.expect(V.call("POST", "/books", fields=[("file", (name, path.read_bytes(),
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))]),
                     200, "POST /books")
        S["book_file"] = (r.json or {}).get("name") or name
        return f"uploaded {S['book_file']} ({(r.json or {}).get('size')} bytes)"
    R.run("05a", "Book: generate tiny .docx and upload", book_upload, needs=("login",))

    def book_inspect():
        j = V.get_json(f"/books/{q(S['book_file'])}/inspect")
        if len(j.get("chapters", [])) < 2:
            raise Fail(f"expected 2 chapters, inspect found {j.get('chapters')}")
        S["book_path"] = j["path"]
        S["book_chapters"] = len(j["chapters"])
        return f"{len(j['chapters'])} chapters, {j.get('words')} words: {[c['title'] for c in j['chapters']]}"
    R.run("05b", "Book: inspect", book_inspect, needs=("book_file",))

    def book_run():
        payload = {"path": S["book_path"], "voice": "", "enhance": False}
        r = V.post("/book/start", payload)
        if r.status == 409:
            kind = (r.json or {}).get("error")
            if kind == "different_narrator":
                payload["confirm_new_narrator"] = True
            elif kind == "kobold_loaded" or "kobold" in r.text.lower():
                payload["force"] = True
            r = V.post("/book/start", payload)
        V.expect(r, 200, "POST /book/start")
        job_id = (r.json or {}).get("job_id")
        st = wait_for("the book render", lambda: V.get_json("/book/status/" + q(job_id)),
                      lambda d: d.get("status") in ("done", "failed", "canceled"),
                      deadline_s=BOOK_S, interval=3.0)
        if st["status"] != "done":
            raise Fail(f"book job {st['status']}: {st.get('error')}")
        S["book_dir"] = re.split(r"[\\/]", (st.get("output_dir") or "").rstrip("/\\"))[-1]
        if not S["book_dir"]:
            raise Fail(f"book finished without an output_dir: {st}")
        return f"done, chapters done {st.get('done_sections')}, output {S['book_dir']}"
    R.run("05c", "Book: start (enhance off) and wait done", book_run, needs=("book_path",))

    def book_output():
        lib = V.get_json("/library")
        if not any(b.get("book") == S["book_dir"] for b in lib):
            raise Fail(f"{S['book_dir']} is not in GET /library")
        j = V.get_json("/output/" + q(S["book_dir"]))
        chapters = j.get("chapters", [])
        if len(chapters) < S["book_chapters"]:
            raise Fail(f"output lists {len(chapters)} chapters, expected {S['book_chapters']}")
        first = chapters[0]
        candidates = [f"mp3/{first['mp3']}" if first.get("mp3") else None, first.get("mp3"),
                      first.get("wav")]
        last = None
        for fname in [c for c in candidates if c]:
            r = V.get(f"/output/{q(S['book_dir'])}/file/{qpath(fname)}")
            last = r
            if r.status == 200 and len(r.body) > 1000:
                return f"{len(chapters)} chapters, first chapter file {fname} {len(r.body)} bytes, total {j.get('total_duration_s')}s"
        raise Fail(f"no chapter file could be fetched; last answer {last.status if last else '?'}")
    R.run("05d", "Book: library and output listing, chapter file", book_output, needs=("book_dir",))

    def book_concat():
        r = V.post(f"/output/{q(S['book_dir'])}/concat", {"format": "mp3", "bitrate": 128}, timeout=300)
        V.expect(r, 200, "concat to mp3")
        j = r.json or {}
        f = V.get(f"/output/{q(S['book_dir'])}/file/{qpath(j.get('file', ''))}")
        note = audio_ok(f, "full audiobook file")
        return f"{j.get('file')}: {j.get('chapters')} chapters, {j.get('duration_s')}s, {note}"
    R.run("05e", "Book: concat to mp3", book_concat, needs=("book_dir",))

    # 06 Bulk ------------------------------------------------------------------------
    def bulk_mode(mode: str):
        info = V.get_json("/bulk/info")
        avail = info.get("available") if mode == "enhance" else info.get("cleanup_available")
        if not avail:
            raise Fail(f"/bulk/info says {mode} is unavailable: "
                       f"{info.get('message') if mode == 'enhance' else info.get('cleanup_message')}")
        V.expect(V.call("POST", f"/bulk/stage/{mode}", fields=[
            ("file", (f"{run_id}-bulk-{mode}.mp3", S["clip_audio"], "audio/mpeg"))]), 200, "stage a file")
        staged = V.get_json(f"/bulk/stage/{mode}")
        if not staged:
            raise Fail("staging answered OK but nothing is staged")
        r = V.expect(V.call("POST", f"/bulk/{mode}", fields=[("format", "wav")], timeout=120),
                     202, f"POST /bulk/{mode}")
        job_id = (r.json or {}).get("job_id")
        st = wait_for(f"bulk {mode}", lambda: V.get_json("/bulk/status/" + q(job_id)),
                      lambda d: d.get("status") in ("done", "failed", "canceled"),
                      deadline_s=BULK_S, interval=3.0)
        if st["status"] != "done":
            raise Fail(f"bulk {mode} {st['status']}: {st.get('error')}")
        cur = V.get_json(f"/bulk/current/{mode}")
        if not cur.get("has_result"):
            raise Fail(f"/bulk/current/{mode} has no result: {json.dumps(cur)[:300]}")
        z = V.get(f"/bulk/download/{mode}", timeout=120)
        V.expect(z, 200, f"download /bulk/download/{mode}")
        import io
        zf = zipfile.ZipFile(io.BytesIO(z.body))
        names = zf.namelist()
        if not names or zf.testzip() is not None:
            raise Fail(f"bulk {mode} zip is empty or corrupt: {names}")
        if mode == "cleanup":
            wavs = [n for n in names if n.lower().endswith(".wav")]
            if wavs:
                S["bulk_wav"] = zf.read(wavs[0])      # reused by the Speech WAV cleanup step
        V.expect(V.post(f"/bulk/reset/{mode}", {}), 200, f"reset {mode}")
        cur2 = V.get_json(f"/bulk/current/{mode}")
        if cur2.get("has_result"):
            raise Fail(f"after reset /bulk/current/{mode} still has a result")
        return f"{st.get('done')}/{st.get('total')} done, zip {len(z.body)} bytes: {names}, reset ok"
    R.run("06a", "Bulk cleanup (stage, run, zip, reset)", lambda: bulk_mode("cleanup"), needs=("clip_audio",))
    R.run("06b", "Bulk enhance (stage, run, zip, reset)", lambda: bulk_mode("enhance"), needs=("clip_audio",))

    # 07 Speech ------------------------------------------------------------------------
    def speech_upload():
        name = f"{run_id}-speech.mp3"
        r = V.expect(V.call("POST", "/train/sources", fields=[("file", (name, S["clip_audio"], "audio/mpeg"))]),
                     200, "POST /train/sources")
        ref = (r.json or {}).get("ref")
        if not ref:
            raise Fail(f"upload answered without a ref: {r.text[:200]}")
        S["speech_ref"] = ref
        rows = V.get_json("/train/sources")
        if not any(x.get("ref") == ref for x in rows):
            raise Fail("uploaded clip is not listed in GET /train/sources")
        return f"ref {ref}, {(r.json or {}).get('duration_s')}s, bandwidth {(r.json or {}).get('bandwidth_hz')} Hz"
    R.run("07a", "Speech: upload clip to /train/sources", speech_upload, needs=("clip_audio",))

    def speech_analyze():
        info = V.get_json("/cleanup/info")
        r = V.expect(V.post("/cleanup/analyze", {"ref": S["speech_ref"]}, timeout=180), 200, "POST /cleanup/analyze")
        keys = sorted((r.json or {}).keys())
        return f"trim_available={info.get('trim_available')} scorer={info.get('trim_scorer_available')}; analyze keys {keys}"
    R.run("07b", "Speech: analyze", speech_analyze, needs=("speech_ref",))

    def speech_score():
        r = V.expect(V.post("/cleanup/score", {"ref": S["speech_ref"]}), 202, "POST /cleanup/score")
        job_id = (r.json or {}).get("job_id")
        st = wait_for("trim scoring", lambda: V.get_json("/cleanup/" + q(job_id)),
                      lambda d: d.get("status") in ("done", "failed", "canceled"),
                      deadline_s=JOB_DONE_S, interval=3.0)
        if st["status"] != "done":
            raise Fail(f"score {st['status']}: {st.get('error')}")
        return "scored: " + (st.get("line") or "")
    R.run("07c", "Speech: score", speech_score, needs=("speech_ref",))

    def cleanup_trim_denoise(ref: str):
        """The brief's cleanup (trim max_excess_db 24 + denoise). A clean synthetic clip sits ~38-44 dB
        above its own near-silent floor, so 24 dB legitimately drops it; the server then says 'Loosen
        the threshold and try again'. Do that once (highest measured excess + 5 dB, music veto off) and
        say so in the note, so the step still proves the trim + denoise path where it can work."""
        r = V.expect(V.post("/cleanup/run", {
            "ref": ref, "trim": {"enabled": True, "max_excess_db": 24},
            "denoise": {"enabled": True, "wet": 1, "atten": 0}}), 202, "POST /cleanup/run")

        def finish(job):
            return wait_for("cleanup run", lambda: V.get_json("/cleanup/" + q(job)),
                            lambda d: d.get("status") in ("done", "failed", "canceled"),
                            deadline_s=JOB_DONE_S, interval=3.0)
        st = finish((r.json or {}).get("job_id"))
        note = ""
        if st["status"] == "failed" and "trim dropped everything" in str(st.get("error")):
            analysis = V.expect(V.post("/cleanup/analyze", {"ref": ref}, timeout=180),
                                200, "POST /cleanup/analyze").json or {}
            regions = analysis.get("regions") or []
            worst = max([x.get("excess_db") or 0 for x in regions] + [0])
            music = max([x.get("music_sfx") or 0 for x in regions] + [0])
            loose = math.ceil(worst) + 5
            first_error = st.get("error")
            r2 = V.expect(V.post("/cleanup/run", {
                "ref": ref, "trim": {"enabled": True, "max_excess_db": loose, "music_veto": 1.0},
                "denoise": {"enabled": True, "wet": 1, "atten": 0}}), 202, "POST /cleanup/run (loosened)")
            st = finish((r2.json or {}).get("job_id"))
            note = (f"at max_excess_db=24 the server answered '{first_error}' (analysis of {ref}: "
                    f"{len(regions)} region(s), highest excess {worst} dB, highest music/SFX {music}); "
                    f"rerun with max_excess_db={loose}, music_veto=1.0 -> {st['status']}"
                    f"{': ' + str(st.get('error')) if st.get('error') else ''}. ")
        if st["status"] != "done" or not st.get("refs"):
            raise Fail(f"cleanup {st['status']}: {st.get('error')} refs={st.get('refs')}. {note}")
        rows = V.get_json("/train/sources")
        missing = [x for x in st["refs"] if not any(row.get("ref") == x for row in rows)]
        if missing:
            raise Fail(f"cleanup reported {st['refs']} but {missing} are not listed in /train/sources")
        return ("PASS with note: " if note else "") + note + f"cleaned clips {st['refs']}"

    R.run("07d", "Speech: cleanup run (trim + denoise) on the MP3 clip",
          lambda: cleanup_trim_denoise(S["speech_ref"]), needs=("speech_ref",))

    def speech_cleanup_wav():
        name = f"{run_id}-speech-wav.wav"
        r = V.expect(V.call("POST", "/train/sources", fields=[("file", (name, S["bulk_wav"], "audio/wav"))]),
                     200, "POST /train/sources (WAV)")
        return cleanup_trim_denoise((r.json or {}).get("ref"))
    R.run("07e", "Speech: cleanup run (trim + denoise) on a WAV clip", speech_cleanup_wav, needs=("bulk_wav",))

    def speech_enhance():
        r = V.post(f"/train/sources/{q(S['speech_ref'])}/enhance", {})
        if r.status == 409 and "already full quality" in r.err().lower():
            return f"PASS with note: server answered 409 '{r.err()}' (input already full band)"
        V.expect(r, 202, "POST /train/sources/<ref>/enhance")
        job_id = (r.json or {}).get("job_id")
        st = wait_for("speech enhance", lambda: V.get_json("/playground/enhance/" + q(job_id)),
                      lambda d: d.get("status") in ("done", "failed", "canceled"),
                      deadline_s=JOB_DONE_S, interval=3.0)
        if st["status"] != "done":
            raise Fail(f"enhance {st['status']}: {st.get('error')}")
        f = V.get(f"/train/sources/{q(S['speech_ref'])}/enhanced")
        return "enhanced copy: " + audio_ok(f, "enhanced download")
    R.run("07f", "Speech: enhance (409 already-full-quality counts as PASS)", speech_enhance, needs=("speech_ref",))

    # 08 Stems -----------------------------------------------------------------------------
    def stems_song():
        name = f"{run_id}-song.mp3"
        r = V.expect(V.call("POST", "/voiceswap/songs", fields=[("file", (name, S["clip_audio"], "audio/mpeg"))]),
                     200, "POST /voiceswap/songs")
        ref = (r.json or {}).get("ref")
        if not ref:
            raise Fail(f"song upload answered without a ref: {r.text[:200]}")
        rows = V.get_json("/voiceswap/songs")
        if not any(x.get("ref") == ref for x in rows):
            raise Fail("uploaded song is not listed in GET /voiceswap/songs")
        S["song_ref"] = ref
        return f"song ref {ref}"
    R.run("08a", "Stems: song upload and listing", stems_song, needs=("clip_audio",))

    def stems_split():
        r = V.post("/stems/start", {"song": S["song_ref"], "mode": "2stem", "device": "auto"})
        if r.status == 200 and (r.json or {}).get("cached"):
            return f"already split: {r.json.get('ref')}"
        V.expect(r, 200, "POST /stems/start")
        job_id = (r.json or {}).get("job_id")
        st = wait_for("the 2stem split", lambda: V.get_json("/stems/status/" + q(job_id)),
                      lambda d: d.get("status") in ("done", "failed", "canceled"),
                      deadline_s=JOB_DONE_S, interval=2.0)
        if st["status"] == "done":
            return f"split ran: result {st.get('result')}"
        error = str(st.get("error") or "")
        if st["status"] == "failed" and STEMS_MISSING_RE.search(error):
            raise Fail(f"the HTDemucs model was not downloaded by setup, server says: {error}")
        raise Fail(f"split {st['status']}: {error}")
    R.run("08b", "Stems: 2stem split (real HTDemucs split)", stems_split, needs=("song_ref",))

    def stems_upload():
        fields = [("name", f"{run_id}-stems"),
                  ("file", ("vocals.wav", make_tone_wav(1.5, 330), "audio/wav")),
                  ("file", ("instrumental.wav", make_tone_wav(1.5, 110), "audio/wav"))]
        r = V.expect(V.call("POST", "/stems/upload", fields=fields), 200, "POST /stems/upload")
        ref = (r.json or {}).get("ref")
        if not ref:
            raise Fail(f"stems upload answered without a ref: {r.text[:200]}")
        lib = V.get_json("/stems/library")
        row = next((x for x in lib if x.get("ref") == ref), None)
        if not row:
            raise Fail(f"set {ref} is not in GET /stems/library")
        audio = V.get(f"/stems/library/{q(ref)}/vocals/audio")
        note = audio_ok(audio, "stored vocals stem", min_bytes=500)
        return f"set {ref}, stems {[f.get('stem') for f in row.get('files', [])]}; vocals {note}"
    R.run("08c", "Stems: bring-your-own stems upload and library listing", stems_upload, needs=("login",))

    # 09 ACE-Step ---------------------------------------------------------------------------
    def ace_first_backend():
        st = V.get_json("/acestep/status")
        if not st.get("available"):
            raise Fail("GET /acestep/status says ACE-Step is not available (no installed backend)")
        auth = [b for b in st.get("backends", []) if b.get("authorized")]
        if not auth:
            raise Fail("no ACE-Step card is authorized (Settings > Devices)")
        return st, auth[0]

    def ace_start():
        st, first = ace_first_backend()
        S["ace_device"] = first["device"]
        S["ace_started"] = True
        # One 24 GB card is shared by Chatterbox, VoxCPM2 and ACE-Step, and by other instances on this
        # machine. Free this instance's resident models first, the way the UI's unload does ("Free a
        # model's VRAM so another app can use the cards"); the first full run's 09c failed a VRAM
        # pre-flight with them resident (see the 09c evidence in the results).
        unload = V.post("/model/unload", {"which": "all"}, timeout=120)
        V.expect(unload, 200, "POST /model/unload (all)")
        r = V.post("/acestep/start", {})
        V.expect(r, 200, "POST /acestep/start")
        wait_for("the ACE-Step backend to answer", lambda: ace_first_backend()[1],
                 lambda b: b.get("up"), deadline_s=ACE_UP_S, interval=3.0)
        return f"models unloaded, started; first authorized card {S['ace_device']} is up"
    R.run("09a", "ACE-Step: start", ace_start, needs=("login",))

    def ace_load():
        dev = S["ace_device"]
        models = V.get_json("/acestep/models")["backends"].get(dev) or {}
        if not models.get("reachable"):
            raise Fail(f"{dev} is not reachable for its model inventory: {models}")
        model = models.get("default") or (models.get("models") or [None])[0]
        if not model:
            raise Fail(f"{dev} offers no model: {models}")
        S["ace_model"] = model
        _st, b = ace_first_backend()
        if not b.get("model_loaded"):
            r = V.post("/acestep/init", {"device": dev, "model": model})
            V.expect(r, 202, "POST /acestep/init")
        b = wait_for(f"{model} to load on {dev}", lambda: ace_first_backend()[1],
                     lambda x: x.get("model_loaded") is True and not x.get("loading"),
                     deadline_s=ACE_LOAD_S, interval=5.0)
        return f"{model} loaded on {dev}"
    R.run("09b", "ACE-Step: load the default model on the first authorized card", ace_load,
          needs=("ace_device",))

    def ace_generate():
        template = {"mode": "custom", "caption": "calm ambient piano with soft pads, slow tempo",
                    "lyrics": "", "instrumental": True, "duration": 10, "vocal_language": "en",
                    "name": f"{run_id}-ace"}
        r = V.expect(V.post("/acestep/generate", {"template": template, "settings": {}}),
                     202, "POST /acestep/generate")
        made = (r.json or {}).get("jobs") or []
        if not made:
            raise Fail(f"generate answered without jobs: {r.text[:300]}")
        ids = [m["job_id"] for m in made]
        S["ace_jobs"] = ids

        def probe():
            rows = {j["id"]: j for j in V.get_json("/acestep/jobs").get("jobs", [])}
            return [rows.get(i, {"id": i, "status": "missing"}) for i in ids]
        rows = wait_for("the 10-second song", probe,
                        lambda rs: all(x["status"] in ("done", "failed", "canceled") for x in rs),
                        deadline_s=ACE_GEN_S, interval=4.0)
        bad = [x for x in rows if x["status"] != "done"]
        if bad:
            try:
                cards = [{k: g.get(k) for k in ("name", "used_gb", "total_gb", "free_gb", "vocalis_gb")}
                         for g in V.get_json("/system/stats").get("gpus", [])]
            except Exception as exc:  # noqa: BLE001 — evidence only
                cards = f"unavailable: {exc}"
            raise Fail("job(s) not done: " + json.dumps(
                [{k: x.get(k) for k in ("id", "status", "error", "device", "model")} for x in bad])
                + f"; GPU at failure time: {json.dumps(cards)}")
        S["ace_job"] = rows[0]["id"]
        return f"{len(rows)} job(s) done on {[x.get('device') for x in rows]}, model {rows[0].get('model')}, seed {rows[0].get('seed')}"
    R.run("09c", "ACE-Step: generate 10-second instrumental and wait", ace_generate, needs=("ace_model",))

    def ace_audio():
        r = V.get(f"/acestep/jobs/{q(S['ace_job'])}/audio", timeout=120)
        note = audio_ok(r, "candidate audio")
        if not r.body.startswith(b"fLaC"):
            raise Fail(f"candidate audio is not FLAC (starts {r.body[:4]!r}); {note}")
        return note
    R.run("09d", "ACE-Step: fetch candidate audio", ace_audio, needs=("ace_job",))

    def ace_save():
        name = f"{run_id}-ace-song"
        r = V.expect(V.post(f"/acestep/jobs/{q(S['ace_job'])}/save", {"name": name}, timeout=120),
                     201, "POST /acestep/jobs/<id>/save")
        sid = (r.json or {}).get("id")
        lib = V.get_json("/acestep/library").get("songs", [])
        if not any(s.get("id") == sid for s in lib):
            raise Fail(f"saved song {sid} is not listed in GET /acestep/library ({len(lib)} songs)")
        a = V.get(f"/acestep/library/{q(sid)}/audio", timeout=120)
        return f"song {sid} saved and listed; library audio {audio_ok(a, 'library audio')}"
    R.run("09e", "ACE-Step: save to library and list", ace_save, needs=("ace_job",))

    # October 10, 2026 (in-place switch design, item 13): Vocalis stages a reference or source clip
    # into a folder the ACE child must also read. The image used to leave VOCALIS_ACESTEP_STAGE_DIR
    # unset, so Vocalis staged under /ai-output/acestep-tmp while the child read /work/vocalis/acestep;
    # 09c only renders text-to-music and never staged anything. These two steps stage real audio.
    def ace_wait_jobs(r, what):
        made = (r.json or {}).get("jobs") or []
        if not made:
            raise Fail(f"{what}: generate answered without jobs: {r.text[:300]}")
        ids = [m["job_id"] for m in made]

        def probe():
            rows = {j["id"]: j for j in V.get_json("/acestep/jobs").get("jobs", [])}
            return [rows.get(i, {"id": i, "status": "missing"}) for i in ids]
        rows = wait_for(what, probe, lambda rs: all(x["status"] in ("done", "failed", "canceled") for x in rs),
                        deadline_s=ACE_GEN_S, interval=4.0)
        bad = [x for x in rows if x["status"] != "done"]
        if bad:
            raise Fail(f"{what}: job(s) not done: " + json.dumps(
                [{k: x.get(k) for k in ("id", "status", "error", "device", "model")} for x in bad]))
        audio = V.get(f"/acestep/jobs/{q(rows[0]['id'])}/audio", timeout=120)
        return f"{len(rows)} job(s) done; {audio_ok(audio, what + ' audio')}"

    def ace_reference():
        refs = V.get_json("/acestep/references").get("references", [])
        if not refs:
            raise Fail("GET /acestep/references offers no clip (08c should have stored a vocals stem)")
        template = {"mode": "custom", "caption": "warm acoustic guitar ballad, slow tempo",
                    "lyrics": "", "instrumental": True, "duration": 10, "vocal_language": "en",
                    "reference": refs[0]["token"], "name": f"{run_id}-ace-ref"}
        r = V.expect(V.post("/acestep/generate", {"template": template, "settings": {}}),
                     202, "POST /acestep/generate (with a reference clip)")
        return f"reference {refs[0]['token']}: " + ace_wait_jobs(r, "the reference-guided song")
    R.run("09g", "ACE-Step: generate with a reference clip (staged audio reaches the backend)",
          ace_reference, needs=("ace_model",))

    def ace_remix():
        songs = V.get_json("/acestep/library").get("songs", [])
        if not songs:
            raise Fail("GET /acestep/library has no song to remix (09e should have saved one)")
        template = {"mode": "remix", "caption": "the same song as a lo-fi version",
                    "lyrics": "", "instrumental": True, "duration": 10, "vocal_language": "en",
                    "source": f"song:{songs[0]['id']}", "name": f"{run_id}-ace-remix"}
        r = V.expect(V.post("/acestep/generate", {"template": template, "settings": {}}),
                     202, "POST /acestep/generate (remix from a library song)")
        return f"source song:{songs[0]['id']}: " + ace_wait_jobs(r, "the remix")
    R.run("09h", "ACE-Step: remix from a library song (staged source reaches the backend)",
          ace_remix, needs=("ace_model", "ace_job"))

    def ace_stop():
        r = V.post("/acestep/stop", {}, timeout=120)
        if r.status == 409 and not S.get("ace_started"):
            return f"nothing to stop: {r.err()}"
        V.expect(r, 200, "POST /acestep/stop")
        S["ace_stopped"] = True

        def probe():
            st = V.get_json("/acestep/status")
            return [b for b in st.get("backends", []) if b.get("up") or b.get("model_loaded")]
        wait_for("ACE-Step backends to go down", probe, lambda up: not up, deadline_s=120, interval=3.0)
        return "stopped; no backend answers"
    R.run("09f", "ACE-Step: stop (free VRAM)", ace_stop)

    # 10 Clips -------------------------------------------------------------------------------
    def clips_list():
        rows = V.get_json("/clips/items")
        pg = [r for r in rows if r.get("kind") == "playground"]
        if len(pg) < 2:
            raise Fail(f"expected at least 2 Playground clips, found {len(pg)} of {len(rows)} items")
        S["clips_pg"] = [r["ref"] for r in pg[:2]]
        kinds = sorted({r.get("kind") for r in rows})
        return f"{len(rows)} items, kinds {kinds}"
    R.run("10a", "Clips: list", clips_list, needs=("login",))

    def clips_favorite():
        ref = S["clips_pg"][0]
        r = V.expect(V.post("/clips/favorite", {"kind": "playground", "ref": ref}), 200, "POST /clips/favorite")
        if (r.json or {}).get("favorite") is not True:
            # A toggle: the first press may un-star a star that was already set; press again.
            r = V.expect(V.post("/clips/favorite", {"kind": "playground", "ref": ref}), 200, "POST /clips/favorite")
            if (r.json or {}).get("favorite") is not True:
                raise Fail(f"could not set a favorite: {r.text[:200]}")
        rows = V.get_json("/clips/items")
        row = next((x for x in rows if x.get("ref") == ref and x.get("kind") == "playground"), {})
        if not row.get("favorite"):
            raise Fail("GET /clips/items does not show the favorite")
        return f"favorite set on {ref}"
    R.run("10b", "Clips: favorite", clips_favorite, needs=("clips_pg",))

    def clips_join():
        items = [{"kind": "playground", "ref": r} for r in S["clips_pg"]]
        r = V.expect(V.post("/clips/join", {"title": f"{run_id} join", "gap_s": 0.5, "items": items}),
                     202, "POST /clips/join")
        job_id = (r.json or {}).get("job_id")
        st = wait_for("the join", lambda: V.get_json("/clips/join/" + q(job_id)),
                      lambda d: d.get("status") in ("done", "failed", "canceled"),
                      deadline_s=JOB_DONE_S, interval=2.0)
        if st["status"] != "done" or not st.get("ref"):
            raise Fail(f"join {st['status']}: {st.get('error')}")
        return f"joined into scene {st['ref']} ({st.get('duration_s')}s, {st.get('total')} clips)"
    R.run("10c", "Clips: join two Playground clips", clips_join, needs=("clips_pg",))

    # 11 Scene from a SillyTavern chat ----------------------------------------------------
    taproom = {"page": None}

    def scene_chat():
        S["pair_token"] = ab.pairing_token(page) if page.url.startswith(base) else None
        if not S["pair_token"]:
            page.goto(base + "/", wait_until="domcontentloaded")
            S["pair_token"] = ab.pairing_token(page)
        tp = context.new_page()
        taproom["page"] = tp
        tp.on("dialog", lambda d: d.dismiss())
        ab.taproom_login(tp, args.taproom.rstrip("/"), secrets_dir)
        ab.open_first_character(tp, need_narrate_button=False, timeout_s=90)
        S["chat_ready"] = True
        return "Taproom logged in; first character's chat open"
    R.run("11a", "Scene: Taproom login and open the first character's chat", scene_chat, needs=("login",))

    def scene_items():
        # Mirrors sillytavern/extension/index.js: cleanText (:124), personaAvatarForMessage (:171),
        # bodyFor (:194) and selectionScan (:3308), restricted to the messages visible on the page.
        got = taproom["page"].evaluate(r"""() => {
            const c = SillyTavern.getContext();
            const clean = raw => {
                let t = c.substituteParams(raw || '');
                return t.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '')
                    .replace(/!\[.*?\]\([^)]*\)/g, '').replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, '')
                    .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
            };
            const persona = msg => {
                if (!msg || !msg.is_user || !msg.force_avatar) return '';
                try {
                    const url = new URL(String(msg.force_avatar), new URL(window.location.href));
                    if (url.origin !== window.location.origin || url.pathname !== '/thumbnail'
                        || url.searchParams.get('type') !== 'persona') return '';
                    return String(url.searchParams.get('file') || '');
                } catch { return ''; }
            };
            const items = [];
            let skipped = 0;
            for (let i = 0; i < c.chat.length; i++) {
                const msg = c.chat[i];
                if (!msg || msg.is_system) continue;
                if (!document.querySelector('.mes[mesid="' + i + '"]')) continue;
                const text = clean(msg.mes);
                if (!text) { skipped++; continue; }
                let avatar = persona(msg);
                if (!avatar) avatar = String(msg.original_avatar || '');
                if (!avatar && !c.groupId && !msg.is_user) {
                    const me = (c.characters || [])[Number(c.characterId ?? -1)];
                    if (me && me.avatar && !msg.is_user) avatar = String(me.avatar);
                }
                items.push({input: text, character: msg.name || '', character_avatar: avatar, mesid: i});
            }
            return {items, skipped, chat: c.getCurrentChatId ? String(c.getCurrentChatId() || '') : '',
                    name: c.name2 || ''};
        }""")
        items = got["items"][:10]
        if not items:
            raise Fail(f"no speakable visible messages in the chat ({got['skipped']} empty)")
        S["scene_items"] = items
        S["scene_chat"] = got["chat"]
        S["scene_character"] = got["name"]
        return f"{len(items)} message(s) from {got['name']}, {got['skipped']} skipped"
    R.run("11b", "Scene: build the request body the extension builds", scene_items, needs=("chat_ready",))

    def scene_estimate():
        r = B.expect(B.post("/v1/audio/scene/estimate", {"items": S["scene_items"], "gap_s": 0.7},
                            bearer=S["pair_token"]), 200, "POST /v1/audio/scene/estimate")
        j = r.json or {}
        return f"total {j.get('total')}, cached {j.get('cached')}, uncached {j.get('uncached')}, skipped {j.get('skipped')}"
    R.run("11c", "Scene: estimate (pairing bearer)", scene_estimate, needs=("scene_items", "pair_token"))

    def scene_create():
        r = B.post("/v1/audio/scene", {
            "title": f"{run_id} scene", "items": S["scene_items"], "gap_s": 0.7, "source": "st",
            "chat": S["scene_chat"]}, bearer=S["pair_token"])
        B.expect(r, 202, "POST /v1/audio/scene")
        j = r.json or {}
        job_id = j.get("job_id")
        st = wait_for("the scene build",
                      lambda: B.get_json("/v1/audio/scene/" + q(job_id), bearer=S["pair_token"]),
                      lambda d: d.get("status") in ("done", "failed", "canceled"),
                      deadline_s=SCENE_S, interval=3.0)
        if st["status"] != "done":
            raise Fail(f"scene {st['status']}: {st.get('error')}")
        S["scene_ref"] = st.get("ref")
        return (f"{j.get('items')} message(s) sent, {j.get('skipped')} skipped by server; "
                f"{st.get('done')}/{st.get('total')} done, {st.get('cached')} cached, {st.get('duration_s')}s, ref {st.get('ref')}")
    R.run("11d", "Scene: create (pairing bearer) and wait done", scene_create, needs=("scene_items", "pair_token"))

    def scene_listed():
        rows = V.get_json("/clips/scenes")
        if not any(x.get("ref") == S["scene_ref"] for x in rows):
            raise Fail(f"scene {S['scene_ref']} is not in GET /clips/scenes ({len(rows)} scenes)")
        a = V.get(f"/clips/scenes/{q(S['scene_ref'])}/audio", timeout=120)
        return "listed; audio " + audio_ok(a, "scene audio")
    R.run("11e", "Scene: listed in Clips with audio", scene_listed, needs=("scene_ref",))

    # 12 Diagnostics -------------------------------------------------------------------------
    def diag_health():
        j = V.get_json("/health")
        if j.get("status") != "ok" or j.get("locked") or not j.get("initialized"):
            raise Fail(f"unhealthy: {json.dumps(j)[:300]}")
        return f"version {j.get('version')}, model_ready={j.get('model_ready')}"
    R.run("12a", "Diagnostics: /health", diag_health)

    def diag_stats():
        j = V.get_json("/system/stats")
        gpus = j.get("gpus") or []
        if not gpus:
            raise Fail(f"/system/stats lists no GPU: keys {sorted(j)}")
        g = V.get_json("/gpus")
        return f"{len(gpus)} GPU(s): {[x.get('name') for x in gpus]}; /gpus {len(g)} row(s)"
    R.run("12b", "Diagnostics: /system/stats has a GPU", diag_stats)

    def diag_logs():
        j = V.get_json("/logs/tail")
        if j.get("missing") or not j.get("text"):
            raise Fail(f"/logs/tail returned no text: {json.dumps(j)[:200]}")
        return f"{len(j['text'])} chars, cursor {j.get('cursor')}"
    R.run("12c", "Diagnostics: /logs/tail returns text", diag_logs)

    def diag_settings():
        j = V.get_json("/settings/app")
        if not isinstance(j, dict) or not j:
            raise Fail(f"/settings/app returned {type(j).__name__}")
        return f"{len(j)} keys"
    R.run("12d", "Diagnostics: /settings/app", diag_settings)

    # 13 Settings and pairing ----------------------------------------------------------------
    def pair_ping():
        if "pair_token" not in S:
            page.goto(base + "/", wait_until="domcontentloaded")
            S["pair_token"] = ab.pairing_token(page)
        ok = B.expect(B.get("/pair/ping", bearer=S["pair_token"]), 200, "GET /pair/ping")
        if (ok.json or {}).get("paired") is not True:
            raise Fail(f"/pair/ping did not say paired: {ok.text[:200]}")
        bad = B.get("/pair/ping", bearer="not-the-token")
        if bad.status != 401:
            raise Fail(f"a wrong token should be 401, got {bad.status}")
        return "paired:true with the token; wrong token 401"
    R.run("13a", "Settings: /pair/ping paired", pair_ping, needs=("login",))

    def nomi_rotate():
        old = V.get_json("/nomi/pairing", secret=True)
        r = V.expect(V.post("/nomi/pairing/rotate", {}, secret=True), 200, "POST /nomi/pairing/rotate")
        new = (r.json or {}).get("token")
        if not new or new == old.get("token"):
            raise Fail("rotate did not mint a different token")
        ping = B.expect(B.get("/speak/ping", bearer=new), 200, "GET /speak/ping with the new token")
        if (ping.json or {}).get("paired") is not True:
            raise Fail(f"/speak/ping with the new token: {ping.text[:200]}")
        stale = B.get("/speak/ping", bearer=old.get("token") or "x")
        if stale.status != 401:
            raise Fail(f"the old Nomi token should be revoked (401), got {stale.status}")
        return "token rotated; new token pings paired, old token 401"
    R.run("13b", "Settings: Nomi token rotate and /speak/ping", nomi_rotate, needs=("login",))

    def rotate_recovery():
        password = ab.read_secret(secrets_dir, "vocalis-password")
        r = V.call("POST", "/vault/rotate-recovery", body={"password": password},
                   headers={"X-CSRF-Token": V.csrf}, secret=True)
        V.expect(r, 200, "POST /vault/rotate-recovery")
        key = (r.json or {}).get("recovery_key")
        if not key:
            raise Fail("rotate-recovery answered OK without a recovery_key")
        # Write the new key before anything else can fail, replacing the old file atomically.
        target = secrets_dir / "vocalis-recovery-key"
        staging = secrets_dir / "vocalis-recovery-key.new"
        staging.write_text(key + "\n", encoding="utf-8")
        staging.replace(target)
        return f"new recovery key ({len(key)} chars) written to {target.name}; not printed"
    R.run("13c", "Settings: /vault/rotate-recovery (key to secrets folder)", rotate_recovery, needs=("login",))

    def devices():
        j = V.get_json("/devices")
        rows = j.get("devices") or []
        return f"{len(rows)} device row(s), subsystems {[s.get('key') for s in j.get('subsystems', [])]}"
    R.run("13d", "Settings: GET /devices", devices)

    # 14 Excluded features --------------------------------------------------------------------
    # source/vocalis/tests/test_app_factory.py::test_excluded_execution_routes_are_not_registered
    # asserts none of these rules exist, so an unmatched URL is a plain 404 for a logged-in caller.
    excluded = [("GET", "/lora/subjects"), ("POST", "/lora/generate"), ("GET", "/lora/templates"),
                ("GET", "/productions"), ("POST", "/productions"), ("GET", "/video/anything"),
                ("POST", "/voiceswap/start"), ("POST", "/voiceswap/audition"), ("GET", "/voiceswap/library"),
                ("GET", "/voiceswap/voices"), ("GET", "/voiceswap/jobs"), ("POST", "/voices/rvc/import"),
                ("POST", "/train/start"), ("GET", "/train/trainings"), ("GET", "/train/jobs")]

    def excluded_routes():
        bad = []
        for method, path in excluded:
            r = V.call(method, path, body={} if method == "POST" else None)
            if r.status != 404:
                bad.append(f"{method} {path} -> {r.status} {r.err()[:80]}")
        if bad:
            raise Fail("not 404: " + "; ".join(bad))
        return f"all {len(excluded)} excluded routes answer 404"
    R.run("14a", "Excluded: /lora, /productions, Voice Swap run and training routes are 404", excluded_routes,
          needs=("login",))


# ── UI smoke ──────────────────────────────────────────────────────────────────────────────

def ui_smoke(R: Runner, page, base: str) -> None:
    events: list[dict] = []
    ctx = {"where": "load"}
    page.on("pageerror", lambda e: events.append({"where": ctx["where"], "kind": "pageerror", "text": str(e)[:300]}))
    page.on("console", lambda m: events.append({"where": ctx["where"], "kind": "console.error",
            "text": f"{m.text[:250]} ({m.location.get('url', '')[:120]})"}) if m.type == "error" else None)
    page.on("response", lambda r: events.append({"where": ctx["where"], "kind": "http",
            "text": f"{r.status} {r.request.method} {r.url[:150]}"}) if r.status >= 500 else None)

    # A tab or sub-tab has finished loading when every fetch its click started has come back and been
    # handled. The page streams only through EventSource (job and system events), which is left alone;
    # its data requests are all fetch(), counted here from the first script on each load. A fetch counts
    # until its whole body has arrived (read from a clone, so the page's own read is untouched) and one
    # task more, so the page's handler for that response has run before the check looks for errors.
    page.add_init_script("""(() => {
        if (window.__vocalisInflight) return;
        const inflight = window.__vocalisInflight = new Map();
        let next = 0;
        const original = window.fetch;
        window.fetch = function (...args) {
            const id = next++;
            inflight.set(id, String(args[0] && args[0].url || args[0]).slice(0, 150));
            const p = original.apply(this, args);
            p.then(r => r.clone().arrayBuffer()).catch(() => {})
             .finally(() => setTimeout(() => inflight.delete(id), 0));
            return p;
        };
    })()""")

    def settle():
        # Two animation frames first, so the click's handlers have run and started their requests.
        page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
        try:
            page.wait_for_function("() => window.__vocalisInflight.size === 0", timeout=30000)
        except PlaywrightTimeout:
            pending = page.evaluate("() => [...window.__vocalisInflight.values()]")
            raise Fail(f"requests still unanswered after 30 s: {pending[:5]}") from None

    def check(where: str):
        mine = [e for e in events if e["where"] == where]
        if mine:
            seen, uniq = set(), []
            for e in mine:
                key = (e["kind"], e["text"])
                if key not in seen:
                    seen.add(key)
                    uniq.append(f"{e['kind']}: {e['text']}")
            raise Fail("; ".join(uniq[:8]) + (f" (+{len(uniq) - 8} more)" if len(uniq) > 8 else ""))
        return "no page errors, console errors or HTTP 5xx"

    def load():
        page.goto(base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#tabs [data-tab]", timeout=30000)
        settle()
        return check("load")
    R.run("15a", "UI smoke: load the main page", load, needs=("login",))
    if "login" not in R.S:
        return

    tabs = page.evaluate("() => [...document.querySelectorAll('#tabs [data-tab]')].map(b => ({tab: b.dataset.tab, label: (b.textContent||'').trim()}))")
    # Sub-tab buttons come in two spellings: data-<area>tab (bktab, sttab, vstab, llmtab, ...) and the
    # buttons of any .tabs strip other than the top-level one (Bulk's data-blkmode). Visible ones only.
    sub_js = r"""() => {
        const out = [], seen = new Set();
        const add = (b, a) => {
            const key = a.name + '=' + a.value;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({attr: a.name, val: a.value, label: (b.textContent || '').trim().slice(0, 40)});
        };
        for (const b of document.querySelectorAll('button, [role=tab]')) {
            if (!b.offsetParent) continue;
            for (const a of b.attributes)
                if (/^data-.*tab$/.test(a.name) && a.name !== 'data-tab') add(b, a);
        }
        for (const strip of document.querySelectorAll('.tabs:not(#tabs)')) {
            for (const b of strip.querySelectorAll('button')) {
                if (!b.offsetParent) continue;
                const a = [...b.attributes].find(x => x.name.startsWith('data-'));
                if (a) add(b, a);
            }
        }
        return out;
    }"""
    for index, t in enumerate(tabs, start=1):
        where = t["label"] or t["tab"]
        sid = f"15{chr(ord('b') + index - 1)}"

        def visit(t=t, where=where):
            ctx["where"] = where
            page.click(f'#tabs [data-tab="{t["tab"]}"]')
            settle()
            visited, queue, clicked = set(), page.evaluate(sub_js), []
            while queue:
                s = queue.pop(0)
                key = (s["attr"], s["val"])
                if key in visited:
                    continue
                visited.add(key)
                ctx["where"] = f"{where} / {s['label'] or s['val']}"
                sel = f'[{s["attr"]}="{s["val"]}"]'
                loc = page.locator(sel + ":visible").first
                if not loc.count():
                    continue
                loc.click()
                settle()
                clicked.append(s["label"] or s["val"])
                for extra in page.evaluate(sub_js):
                    if (extra["attr"], extra["val"]) not in visited:
                        queue.append(extra)
            # Gather errors raised under this tab and any of its sub-tabs.
            mine = [e for e in events if e["where"] == where or e["where"].startswith(where + " / ")]
            # By design, not a defect: step 09 stops ACE-Step with a saved candidate still in the tray, and
            # the tray's <audio preload="metadata"> then gets the proxy's 502 (ace/tray.js says a stopped
            # backend makes every candidate fail at once and shows a banner). Counted, not failed.
            designed = [e for e in mine if re.search(r"(502|BAD GATEWAY).*/acestep/jobs/[0-9a-f]+/audio", e["text"])]
            mine = [e for e in mine if e not in designed]
            if mine:
                seen, uniq = set(), []
                for e in mine:
                    k = (e["where"], e["kind"], e["text"])
                    if k not in seen:
                        seen.add(k)
                        uniq.append(f"[{e['where']}] {e['kind']}: {e['text']}")
                raise Fail("; ".join(uniq[:8]) + (f" (+{len(uniq) - 8} more)" if len(uniq) > 8 else ""))
            extra = (f"; ignored {len(designed)} designed 502(s) for stopped-ACE-Step candidate audio"
                     if designed else "")
            return f"sub-tabs clicked: {clicked or 'none'}; no page errors, console errors or HTTP 5xx{extra}"
        R.run(sid, f"UI smoke: tab {where}", visit)


# ── main ──────────────────────────────────────────────────────────────────────────────────

def print_table(results: list[dict]) -> None:
    width = max([len(r["name"]) for r in results] + [10])
    print("\n" + "=" * (width + 40))
    print(f"{'ID':<5} {'STATUS':<22} {'SEC':>7}  STEP")
    print("-" * (width + 40))
    for r in results:
        print(f"{r['id']:<5} {r['status']:<22} {r['seconds']:>7}  {r['name']}")
    print("=" * (width + 40))
    counts = {s: sum(1 for r in results if r["status"] == s) for s in (PASS, FAIL, EXPECTED)}
    print(f"PASS {counts[PASS]}   FAIL {counts[FAIL]}   EXPECTED-UNAVAILABLE {counts[EXPECTED]}   total {len(results)}")
    for r in results:
        if r["status"] != PASS and r["note"]:
            print(f"  {r['id']} {r['status']}: {r['note'][:400]}")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--vocalis", default=DEFAULT_VOCALIS)
    parser.add_argument("--taproom", default=DEFAULT_TAPROOM)
    parser.add_argument("--secrets", default=str(DEFAULT_SECRETS))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT))
    parser.add_argument("--log", default=str(DEFAULT_LOG), help="the Vocalis server log, read for evidence on failures")
    parser.add_argument("--only", default="", help="comma list of two-digit step groups, e.g. 01,12,14")
    args = parser.parse_args()
    only = {x.strip() for x in args.only.split(",") if x.strip()}
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = REPO / "temp" / time.strftime("acceptance-features-%Y%m%d-%H%M%S")
    tmp.mkdir(parents=True, exist_ok=True)
    started_wall = time.time()
    started = time.monotonic()
    started_iso = time.strftime("%Y-%m-%dT%H:%M:%S")
    base = args.vocalis.rstrip("/")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--mute-audio", "--autoplay-policy=no-user-gesture-required"])
        context = browser.new_context()
        page = context.new_page()
        bearer_ctx = pw.request.new_context()
        V = Api(context.request, base, "session")
        B = Api(bearer_ctx, base, "bearer")
        R = Runner([V, B], Path(args.log), only)
        try:
            build_steps(R, V, B, page, context, args, tmp)
            ui_smoke(R, page, base)
        finally:
            if R.S.get("ace_started") and not R.S.get("ace_stopped"):
                try:
                    V.post("/acestep/stop", {}, timeout=120)
                    say("cleanup: ACE-Step stopped after an interrupted run")
                except Exception as exc:  # noqa: BLE001
                    say(f"cleanup: could not stop ACE-Step: {exc}")
            try:
                browser.close()
                bearer_ctx.dispose()
            except Exception as exc:  # noqa: BLE001
                say(f"browser close: {exc}")
            shutil.rmtree(tmp, ignore_errors=True)

    elapsed = round(time.monotonic() - started, 1)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(started_wall))
    result_path = out_dir / f"features-{stamp}.json"
    payload = {"started": started_iso, "elapsed_s": elapsed, "vocalis": base, "taproom": args.taproom,
               "only": sorted(only), "counts": {s: sum(1 for r in R.results if r["status"] == s)
                                                for s in (PASS, FAIL, EXPECTED)},
               "results": R.results}
    result_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    print_table(R.results)
    print(f"\nElapsed {elapsed} s. Results written to {result_path}")
    return 1 if any(r["status"] == FAIL for r in R.results) else 0


if __name__ == "__main__":
    sys.exit(main())
