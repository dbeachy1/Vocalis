"""Owns the `/wbedit/*` browser routes for the Character and Worldbook editor. The progress stream sends status metadata only; proposal text is fetched through authenticated routes. Only one pass runs process-wide, and each pass keeps the instruction captured at start. Engine selection and transport are resolved by `vocalis.web.llm_engine`; this module does not build engine requests."""
from __future__ import annotations

import copy
import json
import queue
import threading
import time

from flask import Blueprint, Response, abort, jsonify, request
from loguru import logger

import kobold
import vault_fs

from wbedit import assemble as wb_assemble
from wbedit import formats, pairing, prompt, push, runner, sweep, thumbs
from wbedit.backends.base import BackendRefused
from wbedit.backends.chat import ChatCompletions
from wbedit.core.locator import get_at, set_at
from wbedit.formats import (card as card_fmt, depthfix, entryfields, merge as wb_merge,
                            persona as persona_fmt, png_card, st_write)
# ⚠️ Aliased: `wbedit.core.validate` (the flag set) is a different module with the same basename,
# and `formats.validate` is not re-exported by `formats/__init__`, so attribute access on the
# package would be an AttributeError at request time rather than an ImportError at start-up.
from wbedit.formats import validate as doc_validate
from wbedit.store.documents import stamp_of
from wbedit.store import (AVATAR, AmbiguousName, DocumentStore, InstructionLibrary,
                          MissingDocument, PassStore, RevisionConflict, StoreCorrupt)
from wbedit.store.models import KINDS, Proposal

from vocalis.runtime import paths
from vocalis.web.reqargs import BadArg, revision_arg

# 🔴 THE MODULE, NOT THE FUNCTION — `from ... import _kobold_cfg` WOULD BE A BUG. That helper is
# the network boundary and a dozen tests stub it wholesale (`web/kobold.py`'s own note says so);
# binding the function object here captures the REAL one at import, so every stub would miss this
# module and the suite would go looking for a live KoboldCpp. Looked up through the module on each
# call, the seam holds.
import vocalis.web.kobold as _web_kobold
# 11.1 — which engine a pass runs on. `kobold_post` is imported BY NAME on purpose: it lived here
# until 11.1 and `from vocalis.web.wbedit import kobold_post` is how the runner test reaches it.
from vocalis.web import llm_engine
from vocalis.web.llm_engine import kobold_post

#: Where the Section-Editor card lives. 🔴 A RUNTIME DEPENDENCY, and it will look like a mistake
#: (§7): the system prompt is `system_prompt + description` from this card and the five few-shot
#: pairs come from splitting its `mes_example` on `<START>`. Those pairs are what suppress this
#: model's chain-of-thought — without them it emits ~200 tokens of visible reasoning first, and
#: that reasoning lands inside the sentinels, where it reads as content.
CARD_PATH = paths.CODE_DIR / "reference" / "wbedit-baseline" / "prompts" / "Section-Editor.json"

MAX_UPLOAD = 8 * 1024 * 1024        # a card PNG's JSON is ~1 MB at p90 (§4.3); this is slack
MAX_NAME = 200


def _decode_upload(blob: bytes, *, not_text: str):
    """Decode uploaded document bytes as UTF-8. Return `(text, None)` on success or `(None,
    (body, status))` with a caller-specific error. Refuse invalid UTF-8 rather than guessing
    a legacy encoding; silent decoding can corrupt imported content.
    """
    try:
        return blob.decode("utf-8"), None
    except UnicodeDecodeError:
        pass
    try:
        blob.decode("cp1252")
    except UnicodeDecodeError:
        return None, (jsonify({"error": not_text}), 400)
    return None, (jsonify({"error": "this file is not UTF-8 — it looks like it was saved as "
                                    "Windows-1252 (cp1252) by an editor. Re-save it as UTF-8 "
                                    "and import it again."}), 400)


class _BadUpload(Exception):
    """A file this door will not take, carrying the response that says why.

    🔴 **AN EXCEPTION RATHER THAN A RETURNED RESPONSE, BECAUSE THERE ARE NOW TWO DOORS.** Seven
    rejections live in `_read_document_upload` below, each with wording that took a real support
    round to get right — the cp1252 sentence, "that PNG has no character in it", the difference
    between a file that is too large and one that is not a card. A helper that returned
    `(payload, error)` would have every caller re-checking `error` on every line, and the caller
    that forgets is the one that carries on with `doc = None`.
    """

    def __init__(self, body, status: int):
        self.response = (body, status)
        super().__init__("rejected upload")


def _read_document_upload():
    """Read and validate an uploaded card or worldbook, returning `(doc, png, default_name,
    kind)`. Raise `_BadUpload` for request-specific failures. Share this validation across
    import and merge routes so both accept the same document shapes. Return a card PNG
    without persisting it; only document creation may store the avatar.
    """
    raw = request.files.get("file")
    png = None
    if raw is not None:
        blob = raw.read(MAX_UPLOAD + 1)
        if len(blob) > MAX_UPLOAD:
            raise _BadUpload(jsonify({"error": "file too large"}), 413)
        # 🔴 A CHARACTER CARD IS A PNG (§4.3.1) — the JSON lives in the image's text chunks
        # and the picture IS the avatar. Sniff the signature rather than trusting the
        # SillyTavern exports may include arbitrary filenames
        # Inspect the PNG signature instead of trusting the filename; uploaded names and contents may disagree.
        if blob.startswith(png_card.PNG_SIGNATURE):
            try:
                doc, _chunk = png_card.read_card(blob)
            except png_card.NoCardInPng as exc:
                # "not a PNG" and "that PNG has no character in it" are different mistakes
                # with different fixes, and the second can mean the caller selected the picture
                # instead of exporting the card.
                raise _BadUpload(jsonify({"error": str(exc)}), 400)
            png = blob
        else:
            # 🔴 TWO DIFFERENT FAILURES, AND THEY HAD ONE MESSAGE. A file that is valid JSON
            # saved in cp1252 by an editor got "not a JSON document", which is false and
            # leaves the caller with an actionable decode error; parse failures retain their caller-specific wording.
            # and the fix, a parse failure keeps the old wording.
            #
            # ⚠️ IT STILL REFUSES RATHER THAN GUESSING. cp1252 has only five undefined bytes,
            # so decoding with it "succeeds" on almost any input — a silent fallback would
            # turn a clean rejection into a silently mis-decoded import, which is the exact
            # bug class this whole area exists to prevent. Re-saving as UTF-8 is lossless, so the
            # caller can correct the encoding without this route guessing.
            text, failed = _decode_upload(
                blob, not_text="not a JSON document or a character-card PNG")
            if failed:
                raise _BadUpload(*failed)
            try:
                doc = json.loads(text)
            except ValueError:
                raise _BadUpload(
                    jsonify({"error": "not a JSON document or a character-card PNG"}), 400)
        default_name = (raw.filename or "").rsplit(".", 1)[0]
    else:
        body = request.get_json(silent=True) or {}
        doc = body.get("document")
        default_name = str(body.get("name") or "")
        if not isinstance(doc, dict):
            raise _BadUpload(jsonify({"error": "no document"}), 400)

    # Validate before classifying so malformed documents receive a precise validation error rather
    # than being reported as an unsupported document shape.
    try:
        doc_validate.check_document(doc)
    except doc_validate.InvalidDocument as exc:
        raise _BadUpload(jsonify({"error": str(exc)}), 400)
    try:
        kind = formats.detect.doc_kind(doc)
    except (AttributeError, TypeError, KeyError):
        # NARROW ON PURPOSE. `doc_kind` only walks dict keys, so a document of the wrong
        # shape raises one of these and nothing else. A blind handler here would swallow a
        # bug in the detector and file the document as "unsupported" — which reads as a
        # A handler should not misreport detector bugs as unsupported user documents.
        kind = ""
    if kind not in KINDS:
        # Raised rather than filed: a document no pass can touch would sit in the Library
        # looking normal, and show itself as an empty field list days later.
        raise _BadUpload(jsonify({"error": "not a character card or worldbook"}), 400)
    return doc, png, default_name, kind

#: §8.2 — `?world=` on the Library route, asking for the cards linked to NO book. Cannot collide
#: with a real document id, which is 16 hex characters (`store.models.new_id`).
UNLINKED = "none"

#: Our name for a card's image, never the upload's filename — that string is
#: attacker-controlled and a separator in it would escape the document's directory. Defined in
#: `store/documents.py` and re-exported here: the ST push (7.0-m2i) stores an avatar too, and two
#: literals would be two answers to "where is the picture".


class _Absent:
    """The key is not on the entry at all — distinct from every value it could hold."""

    def __repr__(self) -> str:            # pragma: no cover — diagnostics only
        return "<absent>"


_ABSENT = _Absent()


def _same(a: object, b: object) -> bool:
    """Is `b` the value already there? — 7.0-m5g / §9a.26.

    🔴 **`==` IS THE WRONG TEST AND IT WOULD LOSE USER EDITS SILENTLY.** In Python `False == 0` and
    `True == 1`, so a plain equality check makes "set `sticky` to 0 (explicitly none)" look
    identical to a stored `False`, and the edit is dropped as a no-op — the save says nothing
    changed, mints no revision, and the box springs back to what it was. The falsy values are
    genuinely distinct in SillyTavern (`null` inherits the global, `0` is an explicit none,
    `false` is off), so the comparison has to be too.
    """
    if a is b:
        return True
    if type(a) is not type(b):
        return False
    return a == b


class _Run:
    """One in-flight pass: the thread, its event buffer, and its live subscribers.

    Deliberately NOT `runtime.jobs.Job`. That dataclass is render-shaped — `docx`, `voice`,
    `gpus`, `params`, `cap60` — and a pass has none of them. Borrowing it would put eight
    meaningless fields on this object and one meaningless `kind` on that one, and the next
    person to add a field to `Job` would have to reason about a domain it has nothing to do
    with. What IS shared is the SSE generator's shape, and that is copied deliberately below
    (twelve lines) rather than imported, because the terminal event names differ.
    """

    def __init__(self, doc_id: str, pass_id: str):
        self.doc_id = doc_id
        self.pass_id = pass_id
        self.events: list[dict] = []
        self.subscribers: list[queue.Queue] = []
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.done = False
        #: §6.4.3 — every model exchange, verbatim, for the log window. NEVER emitted on the
        #: SSE stream: these carry field text and I16 forbids that on `/pass/<id>/events`.
        #: Served instead by `GET /wbedit/pass/<doc>/<pass>/log`, an ordinary session-gated
        #: route on the same footing as `/revision/<n>`, which already returns field text.
        self.exchanges: list[dict] = []
        self.dropped = 0

    def emit(self, ev: dict) -> None:
        with self.lock:
            self.events.append(ev)
            for q in self.subscribers:
                q.put(ev)

    def log_exchange_persisted(self, docs, log_n: int, pass_id: str, body, reply: str | None) -> None:
        """Record each model exchange in the live window and persist completed exchanges under the
    revision current when the pass started. Do not persist an open exchange (`reply is
    None`); it is not complete and could leave a partial row after a crash.
    """
        # ⚠️ THE ROW NUMBER IS READ UNDER THE SAME LOCK THAT WRITES IT. `log_exchange` mutates
        # `self.exchanges`/`self.dropped` under `self.lock`; reading them out here afterward was
        # a second, unlocked look at state a concurrent field could have moved in between, so two
        # fields finishing together could persist the same `n` or skip one. Cosmetic — it is the
        # row number in the saved log, not the content — but it is the same read-modify-write
        # shape as §3.4 and costs nothing to close properly.
        n = self.log_exchange(body, reply)
        if reply is None:
            return
        docs.append_log(self.doc_id, log_n, [{
            "pass_id": pass_id, "n": n,
            "request": body, "reply": reply}])

    def log_exchange(self, body, reply: str | None) -> int:
        """Record one request/reply pair; `reply is None` marks a request awaiting its response.
    Bound the in-memory window and report dropped entries. Open a row at send time and
    update it at completion so the live view reflects long-running calls; serial passes
    allow one open row at a time.
    """
        with self.lock:
            if reply is not None and self.exchanges and self.exchanges[-1]["reply"] is None:
                self.exchanges[-1]["reply"] = reply
                return self.exchanges[-1]["n"]
            n = len(self.exchanges) + self.dropped + 1
            self.exchanges.append({"n": n, "request": body, "reply": reply})
            if len(self.exchanges) > _LOG_KEEP:
                self.exchanges.pop(0)
                self.dropped += 1
            return n


def _as_tuple(exc) -> tuple:
    """Normalize `vault_fs`'s deferred exception accessors for use in an `except (...)` tuple.

    They return either a class or `()` (when `vault` is unimportable, which is how the pure-
    library tests run), and `except (A, *())` is a valid empty splat while `except (A, *B)` on a
    bare class is not. One helper rather than a conditional at each site.
    """
    return exc if isinstance(exc, tuple) else (exc,)


#: The single active pass (I12). Guarded by `_RUN_LOCK`; `None` means nothing is running.
_RUN: _Run | None = None
_RUN_LOCK = threading.Lock()

#: Finished runs, kept only so a browser that reconnects after the last event still gets the
#: replay rather than a 404. Bounded — the authoritative record is the Pass on disk, which is
#: never pruned, so losing one of these costs a page refresh and nothing else.
_RECENT: dict[str, _Run] = {}
_RECENT_KEEP = 8

#: Maximum exchanges retained in the live pass log. The cap bounds memory and rendering cost;
#: dropped exchanges are counted and reported rather than silently omitted.
_LOG_KEEP = 60


def reconcile_orphaned_passes() -> list[str]:
    """Close persisted passes marked `running` when their process no longer exists, and return
    the IDs closed. Use the persisted cursor and total to describe progress; skip passes
    still present in `_RUN`, since this also runs after vault unlock while a pass may be
    active.
    """
    # ⚠️ NAMED, NOT BLIND — `tests/test_m5_boundaries.py` caps blind handlers in `src/` and this
    # function arrived four over. These are the failures a store walk can actually produce: a
    # vault or filesystem error, a record that will not parse, a document that vanished between
    # the listing and the read.
    _STORE_FAULTS = (OSError, ValueError, KeyError, RuntimeError, StoreCorrupt, MissingDocument)

    closed: list[str] = []
    try:
        docs, passes = DocumentStore(paths.WBEDIT_DIR), PassStore(paths.WBEDIT_DIR)
        documents = docs.list_documents()
    except _STORE_FAULTS as exc:
        logger.warning(f"wbedit: could not enumerate documents to reconcile passes: {exc}")
        return closed

    with _RUN_LOCK:
        live = {_RUN.pass_id} if (_RUN is not None and not _RUN.done) else set()

    for doc in documents:
        try:
            records = passes.list_passes(doc.id)
        except _STORE_FAULTS:
            continue
        for p in records:
            if p.status != "running" or p.id in live:
                continue
            try:
                # 🔴 A REASON, NEVER A PAYLOAD (I16). `error` reaches the UI and the report, so
                # it carries counts and nothing from the document.
                passes.finish(doc.id, p.id, status="interrupted",
                              error=f"interrupted by a restart at field {p.cursor} of {p.total}")
                closed.append(p.id)
            except _STORE_FAULTS as exc:
                logger.warning(f"wbedit: could not reconcile pass {p.id}: {exc}")
    return closed


def create_wbedit_blueprint() -> Blueprint:
    """No injected state — every dependency is a module both sides import (see web/stems.py)."""
    bp = Blueprint("vocalis_wbedit", __name__)

    # ── the stores ───────────────────────────────────────────────────────────
    #
    # 🔴 BUILT PER REQUEST, NEVER AT IMPORT (I15). Vocalis boots locked, and a store constructed
    # at module scope that read anything would raise `VaultLocked` and crash-loop the server
    # under `Restart=always` — it could never come up to serve the unlock page. These
    # constructors are inert (they hold a Path), but they are built here anyway so that
    # conftest's `WBEDIT_DIR` pin is read at call time rather than captured at import; a
    # module-level `DocumentStore(paths.WBEDIT_DIR)` would bind the HOST's install root into
    # every test in the suite.

    def _docs() -> DocumentStore:
        return DocumentStore(paths.WBEDIT_DIR)

    def _passes() -> PassStore:
        return PassStore(paths.WBEDIT_DIR)

    def _library() -> InstructionLibrary:
        return InstructionLibrary(paths.WBEDIT_DIR)

    @bp.errorhandler(MissingDocument)
    def _missing(exc):
        return jsonify({"error": "not found"}), 404

    @bp.errorhandler(RevisionConflict)
    def _conflict(exc):
        """409 — the edit was built on a base that is no longer the head.

        🔴 **THE CURRENT `latest` IS PART OF THE ANSWER, NOT JUST THE MESSAGE.** The browser has
        to be able to reopen at the right revision without a second round trip, and telling it
        the number is what lets the pane say *which* version it is about to show. A bare 409
        would leave the UI guessing, and the guess it would make is "reload the one I already
        have".

        ⚠️ No body and no locator (I16): `RevisionConflict` carries three integers and an id.
        """
        return jsonify({"error": str(exc), "conflict": True,
                        "revision": exc.base, "latest": exc.latest}), 409

    @bp.errorhandler(BadArg)
    def _bad_arg(exc):
        """400 — a query parameter was present and unreadable (A.3).

        Its message names the parameter and echoes at most 32 characters of what arrived, which
        is what makes it actionable: "revision must be a whole number, not 'undefined'" tells the
        caller their template interpolated nothing, and the generic catch-all below would not.

        ⚠️ Safe under I16 because the echo is a QUERY PARAMETER the caller sent, not document
        content, and it is length-clamped at the raise site.
        """
        return jsonify({"error": str(exc)}), 400

    @bp.errorhandler(StoreCorrupt)
    def _corrupt(exc):
        # Log only the record name: parser exceptions may include a window of document content.
        logger.error(f"wbedit: unreadable record — {exc}")
        return jsonify({"error": str(exc), "corrupt": True}), 500

    @bp.errorhandler(Exception)
    def _unexpected(exc):
        """Convert unenumerated document-processing errors into a client-readable 400 response.
    Re-raise `HTTPException` and `VaultLocked` so Flask preserves deliberate HTTP responses
    and the application-level locked-vault handler.
    """
        from werkzeug.exceptions import HTTPException

        if isinstance(exc, HTTPException):
            raise exc
        if isinstance(exc, _as_tuple(vault_fs.locked_exc())):
            raise exc
        # `logger` is loguru, which formats with `str.format` and ignores `%s` entirely —
        # measured: this logged the literal "%s" and the exception type never appeared on the
        # message line. The traceback still carried it, which is why it survived a year.
        logger.exception(f"wbedit: unhandled {type(exc).__name__}")
        if isinstance(exc, OSError):
            # Disk, permissions, a full volume — ours, not the document's. Do not blame the input.
            return jsonify({"error": f"the server could not complete that ({type(exc).__name__})"}), 500
        return jsonify({"error": f"that document or request could not be processed "
                                 f"({type(exc).__name__})"}), 400

    def _locked_guard(fn):
        """Turn a locked vault into a 423 rather than a 500.

        ⚠️ **NOT AN EMPTY LIST.** Serving `[]` while the vault is locked would render an
        ambiguous unreadable as the fact "you have no documents" — the 4.7 `list_options`
        lesson, and the same reasoning the fork contract applies to a 409 from worldinfo:
        never read "unreadable" as "zero".
        """
        import functools

        @functools.wraps(fn)
        def wrapper(*a, **kw):
            try:
                return fn(*a, **kw)
            except vault_fs.locked_exc():
                return jsonify({"error": "the vault is locked", "locked": True}), 423
        return wrapper

    # ── pairing with the SillyTavern extension (§8, m2) ──────────────────────
    #
    # Manage the administrator-side pairing token: create, display, and revoke it. The extension-side routes live in `vocalis/web/pair.py`.
    # it. The other side — the routes that token opens — is `vocalis/web/pair.py`, deliberately a
    # different blueprint so the thing being protected and the thing doing the protecting are not
    # in the same file with the same gate.

    @bp.get("/wbedit/pairing")
    @_locked_guard
    def wbedit_pairing():
        """Return the current pairing token for configuring the SillyTavern extension. The route
    requires an authenticated session and unlocked vault, the same access needed to read
    documents; it does not broaden document access.
    """
        resp = jsonify({"paired": pairing.has_token(), "token": pairing.get_token()})
        # 🔴 Never cached, never revalidated from a store. It is a credential in a response body.
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.post("/wbedit/pairing/rotate")
    @_locked_guard
    def wbedit_pairing_rotate():
        """Mint a new token. 🔴 **This REVOKES the old one immediately** — the extension stops
        working until the new value is pasted in, which is the point rather than a side effect."""
        resp = jsonify({"paired": True, "token": pairing.rotate()})
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.delete("/wbedit/pairing")
    @_locked_guard
    def wbedit_pairing_clear():
        """Unpair. Every `/pair/*` request then fails closed — `pairing.verify` refuses an
        unconfigured install rather than waving it through."""
        pairing.clear()
        return jsonify({"paired": False, "token": ""})

    # ── the library of documents ─────────────────────────────────────────────

    @bp.get("/wbedit/documents")
    @_locked_guard
    def wbedit_documents():
        """Return Library metadata without revision bodies. `avatar` indicates whether a picture
    exists. `world=<book id>` filters by stable document identity, and `world=none` selects
    unlinked cards; name-based filtering would break when a book is renamed.
    """
        kind = request.args.get("kind", "")
        world = request.args.get("world", "")
        store = _docs()
        docs = store.list_documents()
        if kind:
            docs = [d for d in docs if d.kind == kind]
        if world == UNLINKED:
            docs = [d for d in docs if not d.world_id]
        elif world:
            docs = [d for d in docs if d.world_id == world]
        # `pending` is the roster's orange marker: how many fields the user changed but has not
        # saved. Costs a `stat` per row and nothing more when nothing is pending, which is the
        # normal state — see `DocumentStore.draft_count`.
        # 🔴 9.5.12 — `avatar_at` COSTS NOTHING THAT WAS NOT ALREADY BEING SPENT. This row used to
        # call `has_asset`, which is one `stat`; `asset_stamp` is the same `stat` with its answer
        # kept instead of thrown away. The browser puts it in the picture's URL, which is the only
        # thing that makes a REPLACED picture visible — Chrome reuses a resource whose URL has not
        # changed out of its per-page memory cache without revalidating, and no response header
        # reaches that. Measured, not reasoned: `no-cache` alone left the browser check red.
        #
        # 🔴 9.7.7 — AND `thumb_at` IS THE OTHER HALF, WHICH 9.5.12 MISSED. The row's `<img>` does
        # not point at `/avatar`; it points at `/thumb`, which was still on a bare URL — so the
        # same memory cache went on drawing the old circle after an upload while the editor's big
        # picture beside it updated. `face_stamps` answers both from the one `stat` this row was
        # already spending, and the thumb's key folds in the focus rect, which `avatar_at` cannot.
        return jsonify({"documents": [
            {**d.to_dict(), "avatar": bool(stamp), "avatar_at": stamp, "thumb_at": thumb,
             "pending": store.draft_count(d.id)}
            for d, (stamp, thumb) in ((d, store.face_stamps(d)) for d in docs)]})

    @bp.post("/wbedit/documents")
    @_locked_guard
    def wbedit_import():
        """Import a card or a lorebook (§6.1's import button; m2 adds the ST picker).

        🔴 **THE KIND IS DETECTED, NOT DECLARED, AND CARD IS CHECKED FIRST** (§4.2) — a V2 card
        may embed a `character_book` with `entries` and would otherwise be filed as a worldbook,
        editing the embedded book and silently ignoring `description`, `personality`, `scenario`
        and the greetings.
        """
        try:
            doc, png, default_name, kind = _read_document_upload()
        except _BadUpload as bad:
            return bad.response

        name = formats.detect.display_name(doc, kind, default_name)
        # §4.3 — one helper, so a card imported as JSON and the same card imported as a PNG
        # cannot disagree about where its face is.
        focus = png_card.focus_rect(doc) if kind == "card" else {}
        # §8.2 — the card's primary lorebook, by NAME because that is ST's format. `create()`
        # resolves it to a book id; it is not resolved here, so the ST import path (m2) cannot
        # arrive later and forget to.
        world_ref = png_card.world_name(doc) if kind == "card" else ""
        store = _docs()
        # Import a same-named worldbook as a new revision instead of creating duplicate rows. The
                # prior revision remains available for rollback; refuse ambiguous matches rather than guess.
        try:
            created, is_new, changed = store.import_from_file(
                doc, name=name[:MAX_NAME], kind=kind, focus=focus, world_ref=world_ref)
        except AmbiguousName as exc:
            # 409, not 400: the FILE is fine and re-sending it will not help. What has to change
            # is the library, and the message says which part of it.
            return jsonify({"error": str(exc)}), 409
        # 🔴 ONLY ONTO A DOCUMENT THIS IMPORT JUST MADE. `import_from_file`
        # merges by name for WORLDBOOKS, and `png_card.read_card` accepts any PNG whose `chara`
        # chunk decodes to a storable dict — including one holding `{"entries": {...}}`, which
        # `detect.doc_kind` answers "worldbook" for. Such a file, named like a book already here,
        # landed as that book's next revision AND overwrote its stored avatar. The comment above
        # says the import "is not destructive… the pre-import revision stays in the picker": true
        # of the content, false of the asset, which has no revision history and no undo at all.
        if png is not None and is_new:
            # The image is stored VERBATIM — §4.3: never re-encode it. An animated PNG survives,
            # and foreign ancillary chunks (ComfyUI generation metadata) survive with it. It is
            # user content and routes into the vault like everything else.
            store.put_asset(created.id, AVATAR, png)
        body = created.to_dict()
        body["avatar"] = png is not None
        # What actually happened, so the message line can say it rather than infer it. `changed`
        # is about the REVISION: an identical re-import mints nothing (`_revise_existing`), and a
        # toast claiming "revision 7" over a document still at 6 is a small but misleading status.
        body["created"] = is_new
        body["changed"] = changed
        body["revision"] = created.latest
        return jsonify(body), 201 if is_new else 200

    #: 🔴 **PERSONAS ARE OUT, AND NOT BY OVERSIGHT.** A persona's identity is its avatar filename
    #: over in SillyTavern, and `_import_persona_file` exists precisely because a file does not get
    #: to assign one — a merge door that took personas would be a second road to the identity claim
    #: that one refuses. Cards reach this door only because the TARGET comes from the URL, which is
    #: The target document ID comes from the route; do not resolve it by a potentially ambiguous name.
    _MERGEABLE = ("worldbook", "card")

    #: What `field_choices` and `entry_choices` are allowed to say. Validated rather than ignored:
    #: a typo'd value silently falling back to the computed verdict is a pane whose radio button
    #: does nothing, which the user could report as "the merge ignored me" without enough detail
    #: to reproduce the problem.
    _FIELD_PICKS = ("mine", "theirs", "edited")
    _ENTRY_PICKS = ("keep", "drop")

    #: A hand-written resolution is one field of one entry, so a whole book's worth of them is
    #: still small. Capped anyway, and with its own message: Werkzeug's own limit would answer 413
    #: with nothing naming which form field was too big.
    _MAX_EDITS = 4 * 1024 * 1024

    def _edits(name: str) -> dict:
        """The hand-written resolutions off the form: `{address: text}`, or `BadArg`.

        🔴 **KEPT SEPARATE FROM `_picks` BECAUSE THE VALUES ARE USER TEXT, NOT AN ENUM.** `_picks`
        validates against a closed set and echoes what it found; doing that here would put a line
        of the worldbook into an error string and into the log. This one checks the SHAPE and says
        which address is wrong, never what it says.
        """
        raw = request.form.get(name) or ""
        if not raw.strip():
            return {}
        if len(raw) > _MAX_EDITS:
            raise BadArg(f"{name} is {len(raw)} bytes, over the {_MAX_EDITS} limit")
        try:
            got = json.loads(raw)
        except ValueError:
            raise BadArg(f"{name} must be a JSON object") from None
        if not isinstance(got, dict):
            raise BadArg(f"{name} must be a JSON object")
        for key, value in got.items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise BadArg(f"{name} must map an address to text, and "
                             f"{str(key)[:32]!r} does not")
        return got

    def _picks(name: str, allowed: tuple) -> dict:
        """One choices map off the form, or `BadArg`. Absent is `{}` — the computed verdicts."""
        raw = (request.form.get(name) or "").strip()
        if not raw:
            return {}
        try:
            got = json.loads(raw)
        except ValueError:
            raise BadArg(f"{name} must be a JSON object, not {raw[:32]!r}") from None
        if not isinstance(got, dict):
            raise BadArg(f"{name} must be a JSON object, not {raw[:32]!r}")
        for key, value in got.items():
            if not isinstance(key, str) or value not in allowed:
                # ⚠️ The KEY is echoed, never the value's neighbors: a choices map is addresses,
                # not content, so this cannot carry a line of the worldbook into an error string.
                raise BadArg(f"{name} may only say {' or '.join(allowed)}, and "
                             f"{str(key)[:32]!r} says {str(value)[:32]!r}")
        return got

    @bp.post("/wbedit/documents/<doc_id>/merge")
    @_locked_guard
    def wbedit_merge(doc_id):
        """Preview or apply a worldbook merge without replacing the current document. Preview is
    the default; `apply=1` creates a revision. Compare incoming content with the original
    imported revision and the current revision so untouched entries can update while local
    edits remain reviewable.
    """
        try:
            doc, _png, _default_name, kind = _read_document_upload()
        except _BadUpload as bad:
            return bad.response
        if kind not in _MERGEABLE:
            # Names what arrived, because "that cannot be merged" over the selected file is not
            # actionable.
            return jsonify({"error": f"a {kind} cannot be merged — import it instead"}), 400

        store = _docs()
        target = store.get(doc_id)                      # MissingDocument -> 404
        if target.kind != kind:
            # 🔴 A CARD MERGED INTO A BOOK IS NOT A CONFUSED USER, IT IS A DESTROYED DOCUMENT.
            # The engine would happily compare a card's fields against a book's, find nothing in
            # common, and report the whole book as removed and the whole card as added. Both are
            # named so the message says which way round the mistake is.
            return jsonify({"error": f"that file is a {kind} and this document is a "
                                     f"{target.kind} — they cannot be merged together"}), 400

        applying = request.form.get("apply") == "1"
        if applying:
            # A.3's rule, applied to a form field rather than a query arg: present-and-unreadable
            # is a 400, and ABSENT is a 400 too, because there is no safe default for "which
            # version were these choices made against".
            raw = (request.form.get("revision") or "").strip()
            if not raw.isdigit():
                raise BadArg("revision must be the whole number of the version these "
                             f"choices were made against, not {raw[:32]!r}")
            head = store.revision(doc_id, int(raw))     # MissingDocument -> 404
        else:
            head = store.revision(doc_id)

        base = store.merge_base(doc_id)
        # 🔴 ONE ENGINE, TWO DOORS INTO IT. The five-row table, the conflict rule and the applier
        # are shared; what differs is where the entries live, which `MergeResult.container`
        # carries. A second merge implementation for cards is the thing this must never become.
        merge_fn = wb_merge.merge_card if kind == "card" else wb_merge.merge_worldbook
        result = merge_fn(base.content, head.content, doc)
        body = {**result.to_dict(), "base": base.n, "revision": head.n,
                "conflicts": result.conflicts, "name": target.name}
        if not applying:
            return jsonify(body), 200

        field_choices = _picks("field_choices", _FIELD_PICKS)
        field_edits = _edits("field_edits")
        # 🔴 **AN `edited` PICK WITH NO TEXT WOULD WRITE `None` INTO THE DOCUMENT.** `_merge_pick`
        # returns the edit verbatim, so a browser that sent the radio and dropped the textarea —
        # for example, after a rename or a truncated form — would blank the field it was resolving.
        # Refused at the door, naming the address, rather than discovered in the revision.
        orphans = sorted(a for a, pick in field_choices.items()
                         if pick == wb_assemble.PICK_EDITED and a not in field_edits)
        if orphans:
            return jsonify({"error": f"these fields say they were edited by hand but carry no "
                                     f"text: {', '.join(orphans[:6])}"}), 400
        merged = wb_assemble.apply_merge(head.content, result,
                                         field_choices=field_choices,
                                         entry_choices=_picks("entry_choices", _ENTRY_PICKS),
                                         field_edits=field_edits)
        tally = result.tally()
        # The note appears in the revision picker, so it says what the merge DID rather than that
        # one happened. `add_merged_revision` marks it as the new
        # reconciliation point, which is what makes the NEXT merge measure from here.
        note = (f"merged an imported file — {tally[wb_merge.CHANGED]} changed, "
                f"{tally[wb_merge.ADDED]} added, {result.conflicts} decided")
        new = store.add_merged_revision(doc_id, merged, note=note, from_revision=head.n)
        body["revision"] = new.n
        body["applied"] = True
        return jsonify(body), 201

    @bp.get("/wbedit/st-sweep")
    def wbedit_sweep_status():
        """Is a SillyTavern tab listening, and how did the last import go? (7.0-m2j)

        Deliberately NOT `_locked_guard`ed, and that is safe because it reads no documents: this
        is the status of a conversation with the browser extension.

        ⚠️ A.6 — IT DOES *NOT* STAY ANSWERABLE WHILE THE VAULT IS SHUT, AND THIS DOCSTRING USED TO
        CLAIM IT DID. `_require_unlocked` in `vocalis_server.py` is an app-level `before_request`
        whose exempt list is `/health`, `/login`, `/logout` and `/vault/*` — nothing else. This
        path is on neither list, so a locked vault answers 401 *before this view is ever entered*
        and the pane goes blank exactly as it would with the guard. Omitting `_locked_guard` here
        buys nothing at all; it simply costs nothing either. If the pane should really speak while
        locked, the change is an entry in that exempt list, not the absence of this decorator.
        """
        return jsonify(sweep.status())

    @bp.post("/wbedit/st-sweep")
    @_locked_guard
    def wbedit_sweep_request():
        """Request an import sweep from the connected SillyTavern extension. The extension owns the
    authenticated SillyTavern session, so this route records the request and returns its
    status; it does not contact SillyTavern directly. Return status even when no extension
    is listening.
    """
        sweep.request()
        return jsonify(sweep.status())

    @bp.delete("/wbedit/st-sweep")
    @_locked_guard
    def wbedit_sweep_cancel():
        """Cancel a pending SillyTavern import sweep so a later extension poll cannot perform an
    import the user has stopped waiting for.
    """
        sweep.cancel()
        return jsonify(sweep.status())

    # ── m3: send back to SillyTavern ─────────────────────────────────────────

    def _push_state():
        """`push.status()` plus the one field the send line reads and `push` cannot know.

        🔴 THREE OF THE FOUR RETURNS USED TO OMIT `connected`, AND THE STATUS ROUTE JOINED IT BY
        HAND. `push.status()` returns exactly `{pending, running, last}` — whether a SillyTavern
        tab is actually attached is `sweep`'s fact, not `push`'s, so every caller had to remember
        to join it. `GET /wbedit/st-push` remembered; the POST that STARTS a send, its 409 twin,
        and the DELETE did not.

        The cost was a wrong first frame on the thing a user watches most closely: `wb/st.js:210`
        renders `s.connected ? 'sending to SillyTavern…' : 'waiting for SillyTavern…'` off the
        POST's own response, so a send into a connected tab announced itself as *waiting* and only
        corrected ~2 s later when the first poll landed. It read as a stall in exactly the moment
        the write was going through.

        ⚠️ THE FIX IS THIS FUNCTION, NOT A FOURTH COPY OF THE JOIN. A shape that has to be
        reassembled at every return is one that will be forgotten at the next return added — which
        is precisely what happened here, since the correct version at `/wbedit/st-push` was sitting
        forty lines above the three that were wrong.
        """
        st = sweep.status()
        # Report extension freshness from its own build and self-check state, not Vocalis `VERSION`.
                # The served tab provides the authoritative result; a repository copy may be stale.
                # Only an explicit `stale` result signals stale; older clients and failed checks remain unknown.
        build = str(st.get("build") or "")
        return {**push.status(), "connected": st["connected"], "build": build,
                "stale": st.get("self_check") == "stale"}

    @bp.get("/wbedit/st-push")
    def wbedit_push_status():
        """Is a send pending, running, or how did the last one go? (7.0-m3)

        Not `_locked_guard`ed and it reads no documents, for the same reason `/wbedit/st-sweep`
        is not: this is the state of a conversation with the extension.

        ⚠️ A.6 — and it does NOT stay answerable while the vault is shut, whatever this used to
        say. See `wbedit_sweep_status` for the mechanism: the app-level `_require_unlocked` gate
        answers 401 before either view runs.
        """
        return jsonify(_push_state())

    @bp.post("/wbedit/documents/<doc_id>/send")
    @_locked_guard
    def wbedit_push_request(doc_id):
        """Plan and queue a write to SillyTavern through the paired extension, which owns the
    session. Validate the plan when requested so unsendable documents fail immediately, and
    report mirrored fields that will not be written.
    """
        store = _docs()
        doc = store.get(doc_id)
        # A.3 — an unparseable `?revision=` is a 400, never a silent "latest". This is the SEND
        # path: substituting latest here writes a version of the document into SillyTavern that
        # nobody asked for, over the top of whatever is there.
        rev = store.revision(doc_id, revision_arg())
        try:
            # 🔴 `store.outbound` first, exactly as the export does — the world name and the
            # avatar focus rect are injected in ONE place so a send and a download cannot
            # disagree about what the card says.
            # 🔴 THE SAME ARGUMENTS `/pair/plan/<id>` PASSES, AND `has_avatar` WAS MISSING HERE.
            # This route builds the plan to refuse an unsendable document ON THE PRESS; the
            # extension then fetches the plan again from `/pair/plan/<id>`, which passes BOTH
            # picture questions (§9a.33: `avatar` is "ours has diverged from theirs", `has_avatar`
            # is "we have one at all", and a CREATE asks the second). Omitting it here meant the
            # two builds of one plan disagreed — harmless today, because only `dropped` and the
            # `Unsendable` verdict are read from this copy, and neither depends on it. That is
            # exactly the shape of defect this codebase keeps finding at a seam: a check performed
            # on a DIFFERENT object from the one that ships. The day a create becomes unsendable
            # without a picture, the press would say yes and the collect would say no.
            plan = st_write.plan(doc, store.outbound(doc, rev.content), st_ref=doc.st_ref,
                                 name=doc.name,
                                 avatar=doc.avatar_dirty and store.has_asset(doc.id, AVATAR),
                                 has_avatar=store.has_asset(doc.id, AVATAR),
                                 world=store.world_out(doc))
        except st_write.Unsendable as exc:
            return jsonify({"error": str(exc)}), 400
        if not push.request(doc.id, rev.n, kind=doc.kind, name=doc.name,
                            dropped=plan["dropped"]):
            # 🔴 REFUSED, NOT QUEUED — see `wbedit/push`. One write into the SillyTavern install at a time,
            # and a second press while one is in flight is far more likely to be impatience than
            # a second document.
            return jsonify({**_push_state(), "error": "a send is already running"}), 409
        return jsonify(_push_state())

    @bp.delete("/wbedit/st-push")
    @_locked_guard
    def wbedit_push_cancel():
        """The pane giving up waiting. An uncollected send that fires whenever a SillyTavern tab
        next opens is an unannounced write of a possibly outdated revision. The import path has
        `sweep.cancel` for the same reason."""
        push.cancel()
        return jsonify(_push_state())

    @bp.post("/wbedit/assemble")
    @_locked_guard
    def wbedit_assemble():
        """Build one named worldbook from section chunks. Sort chunks by filename before assigning
    IDs because multi-file upload order is not stable. Store a rebuild as a new document
    rather than a revision of the compiled book, which may already contain edits not present
    in the source chunks.
    """
        ups = request.files.getlist("files")
        if not ups:
            return jsonify({"error": "no files"}), 400
        files, total = [], 0
        for f in ups:
            blob = f.read(MAX_UPLOAD + 1)
            total += len(blob)
            if len(blob) > MAX_UPLOAD or total > MAX_UPLOAD * 4:
                return jsonify({"error": "upload too large"}), 413
            try:
                files.append((f.filename or "", json.loads(blob.decode("utf-8"))))
            except (ValueError, UnicodeDecodeError):
                return jsonify({"error": f"{f.filename or 'a file'} is not valid JSON"}), 400

        try:
            book, report = wb_assemble.assemble(files)
        except wb_assemble.AssemblyFailed as exc:
            # 🔴 ERRORS ABORT AND NOTHING IS FILED. "A book with three entries that can never
            # fire" is exactly what the validator exists to catch, and it is invisible in
            # SillyTavern until a scene silently lacks its lore. Warnings are a different thing
            # and never block.
            return jsonify({"error": "the chunks did not validate", "errors": exc.errors}), 400

        name = (str((request.form.get("name") or "")).strip()
                or report.world_name or "Assembled worldbook")
        created = _docs().create(book, name=name[:MAX_NAME], kind="worldbook", source="upload")
        return jsonify({**created.to_dict(), "report": report.to_dict()}), 201

    @bp.get("/wbedit/documents/<doc_id>")
    @_locked_guard
    def wbedit_document(doc_id):
        store = _docs()
        doc = store.get(doc_id)
        # `revisions` (bare numbers) stays for every existing caller; `revision_index` carries the
        # timestamps the picker labels itself with (m4n). Two keys rather than a changed shape,
        # because the numbers list is what three other call sites already iterate.
        # Resolve the displayed worldbook name from `world_id`, so renames stay current; retain
                # `world_ref` for cards whose referenced book is not held locally. Use one lookup for this
                # document rather than resolving every item during Library serialization.
        world_name, world_held = doc.world_ref, False
        if doc.kind == "card" and doc.world_id:
            try:
                world_name, world_held = store.get(doc.world_id).name, True
            except MissingDocument:
                # The book was deleted between the link being made and this read. `delete` clears
                # the `world_id` of every card pointing at it, so this is a narrow race rather
                # than a normal state — fall back to what the card itself says.
                world_name, world_held = doc.world_ref, False
        # `avatar_at` is the picture's `(size, mtime)` — the editor puts it in the <img> URL so a
        # replaced face is actually re-fetched (9.5.12; see the roster route's note). Same one
        # `stat` `has_asset` was already costing. `thumb_at` rides along because the two payloads
        # are read by the same code and a row that carried one field more than a document would be
        # a difference to remember rather than a shape to rely on.
        stamp, thumb = store.face_stamps(doc)
        return jsonify({**doc.to_dict(), "avatar": bool(stamp), "avatar_at": stamp,
                        "thumb_at": thumb,
                        "world_name": world_name, "world_held": world_held,
                        "revisions": store.revisions(doc_id),
                        "revision_index": store.revision_index(doc_id),
                        "passes": [p.to_dict() for p in _passes().list_passes(doc_id)]})

    # ── pending edits (§9a.15) ───────────────────────────────────────────────
    #
    # Draft routes persist pending field text without creating a document revision. Keep them
        # session-gated like revision and log routes; I16 restricts SSE frames, not authenticated fetches.
    @bp.put("/wbedit/documents/<doc_id>/draft")
    @_locked_guard
    def wbedit_draft_put(doc_id):
        body = request.get_json(silent=True) or {}
        locator = body.get("locator")
        if not isinstance(locator, list) or not locator:
            return jsonify({"error": "locator is required"}), 400
        try:
            revision = int(body.get("revision"))
        except (TypeError, ValueError):
            return jsonify({"error": "revision is required"}), 400
        text = body.get("text")
        if text is not None and not isinstance(text, str):
            return jsonify({"error": "text must be a string"}), 400
        pending = _docs().put_draft(doc_id, revision, locator, text)
        return jsonify({"pending": pending, "revision": revision})

    @bp.get("/wbedit/documents/<doc_id>/draft/<int:n>")
    @_locked_guard
    def wbedit_draft_get(doc_id, n):
        # 🔴 7.3.9e — `total` IS NOT `len(fields)` AND THE GAP IS THE WHOLE REASON IT IS HERE.
        # `drafts()` serves only a draft stamped at the revision being rendered; `draft_count`
        # counts what is on disk whatever it is stamped at. They differ only when a draft was
        # stranded — `add_revision` carries one forward at a single funnel, so that needs a crash
        # between the revision write and the carry — and in exactly that case the roster's orange
        # marker (7.3.9d) shows a number for edits the editor cannot restore. Without this the UI
        # has no way to know they exist, so `↺ Discard` reads its own empty map, says "nothing to
        # discard", and the marker is unclearable for ever. A count it cannot see is worse than
        # invisible cruft, which is what this was before the marker made it visible.
        return jsonify({"revision": n, "fields": _docs().drafts(doc_id, n),
                        "total": _docs().draft_count(doc_id)})

    @bp.delete("/wbedit/documents/<doc_id>/draft")
    @_locked_guard
    def wbedit_draft_clear(doc_id):
        _docs().clear_drafts(doc_id)
        return jsonify({"ok": True})

    @bp.get("/wbedit/documents/<doc_id>/revision/<int:n>")
    @_locked_guard
    def wbedit_revision(doc_id, n):
        """A whole revision, content included — the Editor pane's data (§6.1).

        This route DOES carry bodies, and that is its job. The line I16 draws is between here
        and the progress stream, not between here and the browser.
        """
        return jsonify(_docs().revision(doc_id, n).to_dict())

    @bp.get("/wbedit/documents/<doc_id>/fields")
    @_locked_guard
    def wbedit_fields(doc_id):
        """The checkbox list for §6.2 — every editable field, with its length.

        Lengths travel because the preflight needs them: measured on GLM-Steam-106B at IQ4_XS,
        a CHANGED field costs roughly 9s at 150 characters and 26s at 1600, and a NOCHANGE
        about 6s. 🔴 Those numbers are an OBSERVED RUN (7.0-m1d), not a guess, and they belong
        to that model — re-measure before trusting them under another.
        """
        n = revision_arg()                      # A.3 — present-and-unparseable is a 400, not latest
        rev = _docs().revision(doc_id, n)
        include = request.args.get("card_fields", "")
        # 🔴 m5d / §9a.21 — THE EDITOR ASKS FOR EVERY FIELD, NOT THE PASS DEFAULT. This route fell
        # through to `CARD_FIELDS_DEFAULT` (five fields) because it named no set, and the UI has
        # never sent `card_fields` — so `alternate_greetings`, `creator_notes`, `system_prompt`
        # and `post_history_instructions` were unreachable in a product whose entire pitch is
        # Include all supported card fields; `preselect` keeps newly exposed fields initially unticked.
        # `preselect` is what keeps I13 true: they arrive unticked.
        # 🔴 7.4 / §9a.32 — AND THE EMPTY ONES, which m5d did not reach. A field with no text had
        # no row, so a card that arrived without a `system_prompt` could never be given one here;
        # the only way in was to type it into SillyTavern first and re-sweep. `POST /edit` passes
        # the same flag, and the two must not drift: this route decides what is OFFERED and that
        # one decides what may be SAVED, from the same call.
        # 🔴 §9a.11 — `persona_empty` TRAVELS WITH `card_empty` AND MUST NEVER BE ADDED TO ONE OF
        # THESE TWO BRANCHES ONLY. Same pairing as the /edit route below: this decides what is
        # OFFERED, that decides what may be SAVED, and a persona field offered here but refused
        # there would silently lose the user's textarea input.
        kw = {"card_fields": formats.CARD_FIELDS_ALL,
              "card_preselect": formats.CARD_FIELDS_DEFAULT, "card_empty": True,
              "persona_empty": True}
        if include:
            kw = {"card_fields": tuple(x for x in include.split(",") if x), "card_empty": True,
                  "persona_empty": True}
        jobs = formats.collect(rev.content, rel=str(doc_id), **kw)
        # `mode` — m4y / §9a.4. It was computed into `Job.meta` all along and simply never crossed
        # the wire, which is why the editor could show a length and say nothing about whether an
        # entry costs tokens on every single message. "" means "this field has no injection mode"
        # (a card's own description, a persona) and the UI draws no dot for it.
        # 🔴 m5g / §9a.26 — THE TYPED SETTINGS SURFACE, AND THE VALUES DELIBERATELY DO NOT TRAVEL
        # WITH IT. `entry_fields` is a static schema; the browser already holds the revision it is
        # editing and reads each value out of that. Sending 37 values per entry alongside would
        # put a whole book's settings on the wire a second time, and the second copy is the one
        # that goes stale the instant anything is written.
        #
        # `entry` is null for everything that is not an entry in a COMPILED book — a card's own
        # description, a persona, a section chunk. The UI draws no settings fold for those, which
        # is the honest answer rather than a fold full of controls that write the wrong schema.
        return jsonify({
            "revision": rev.n,
            "fields": [
                {"locator": list(j.locator), "label": j.label, "chars": len(j.original),
                 "kind": j.meta.get("kind", ""), "mode": j.meta.get("mode", ""),
                 "entry": j.meta.get("entry") or None,
                 # m4k / §9a.5 — the heading this field sits under, "" for most. The editor draws
                 # it once, when it changes, so a card's embedded lorebook reads as part of the
                 # card rather than as a World Book that leaked into the pane.
                 "group": j.meta.get("group", ""),
                 # §9a.29 — this entry is stored, looks fine, and SillyTavern will never fire it.
                 # Forwarded, never recomputed: the predicate lives in `worldbook.py` and a second
                 # opinion here is how the marker and the 422 refusal start disagreeing.
                 "inert": bool(j.meta.get("inert", False)),
                 # §9a.32 — this field has no text yet. The row exists so it can be given some;
                 # the browser disables its checkbox on this, because a pass over an empty field
                 # asks the model to rewrite something it was never sent.
                 "empty": bool(j.meta.get("empty", False)),
                 "pass_default": bool(j.meta.get("pass_default", True))} for j in jobs],
            "entry_fields": entryfields.spec_payload(),
            "entry_groups": entryfields.group_payload(),
        })

    @bp.get("/wbedit/documents/<doc_id>/avatar")
    @_locked_guard
    def wbedit_avatar(doc_id):
        """The card PNG (§4.3) — the Library's roster of faces and the Editor's big image (m2a).

        🔴 **THE CARD PNG *IS* THE AVATAR, AND IT GOES OUT WHOLE.** There is exactly one image
        per character; the circle is a REGION of it, described by `Document.focus`, and it is cut
        in the browser. We deliberately do not cut or rescale it here:

        - **Sharpness was never the argument for a server cut.** The fork cuts server-side
          because its circle is panned out of a 144px *thumbnail*, and no `object-position` can
          make that sharp. We hold the full-resolution original, so a CSS crop of it is the same
          pixels a server crop would have produced.
        - 🔴 **A re-encode would flatten an animated PNG** and drop every foreign ancillary chunk
          — the exact damage `png_card.write_card` goes out of its way to avoid on the way in
          (§4.3). An avatar that animates in SillyTavern animates here, for free, because nothing
          in this path decodes it.
        - Their thumbnails are a JPEG cache invalidated on mtime; §4.3 says do not archive one.
          Deriving our *own* cache would be the same bargain with our own name on it, and it is
          not worth it until a roster is measured slow.

        What it costs is bytes — ~700 KB per face at p50 — so the conditional request below is
        load-bearing rather than a nicety, and the roster tags every `<img>` `loading="lazy"`.
        """
        store = _docs()
        size, mtime = store.asset_stat(doc_id, AVATAR)      # MissingDocument → 404

        # Strong, and derived from a stat rather than the bytes. The asset is written once at
        # import and never rewritten in place, so (size, mtime) moving means a different image.
        # ⚠️ NOT a content hash, and §4.3.1 is why one would be a trap anyway: SillyTavern
        # re-encodes on every card edit, so identical pixels come back as different bytes. This
        # tag answers "is it the same FILE", which is the only question a cache is asking.
        etag = f'"{doc_id}-{stamp_of(size, mtime)}"'
        if request.headers.get("If-None-Match") == etag:
            resp = Response(status=304)
        else:
            resp = Response(store.asset(doc_id, AVATAR), mimetype="image/png")
        resp.headers["ETag"] = etag
        # 🔴 `private`, and no `immutable`. A character's face is user content out of an
        # encrypted store; it must not land in a shared proxy.
        #
        # 🔴 9.5.12 — `no-cache`, NOT `max-age=300`, AND THE ROUTE IS THE SMALLER HALF OF THAT FIX.
        # The URL now carries `?v=<avatar_at>` (`wbShowCard`), so a changed picture is a changed
        # URL; this header covers the callers that have no stamp in hand — `wbFaceFallback`, a
        # reload, a second tab — for which a 300-second window meant painting a face the store had
        # already replaced.
        #
        # ⚠️ **AND THE HEADER ALONE DOES NOT FIX IT — MEASURED, TWICE, AFTER I WROTE THAT IT DID.**
        # Chrome reuses an <img> whose URL has not changed out of its per-page memory cache without
        # revalidating, which no response header reaches; the browser check for a picture replaced
        # behind the page's back was still red with this line already changed. The stamp is what
        # fixes it. A separate mutation test killed the first version of that check outright: it
        # uploaded from the page, and a successful unsafe request invalidates the cache entry for
        # its own target (RFC 9111 §4.4), so that path could not go stale in the first place.
        #
        # ⚠️ `no-cache` IS NOT `no-store`. The browser keeps the bytes and revalidates, so a repeat
        # view is a conditional request answered by a bodiless 304 — the 700 KB saving this route
        # cares about is on the FIRST load and is untouched. It is the bargain `/thumb` already
        # makes for exactly this reason (m4p), whose comment claimed this route made it too. It
        # did not; the claim is true as of this line.
        resp.headers["Cache-Control"] = "private, no-cache"
        return resp

    @bp.get("/wbedit/documents/<doc_id>/thumb")
    @_locked_guard
    def wbedit_thumb(doc_id):
        """Return a cropped, resized avatar thumbnail for the Library roster. The crop is already
    applied, so the browser must not apply its focus rectangle again. On decode failure, let
    the client fall back to the full avatar route.
    """
        store = _docs()
        try:
            blob, key = store.thumbnail(doc_id)
        except thumbs.ThumbFailed as exc:
            # 415, deliberately: it is a statement about THIS image, not about the server, and it
            # must not read as an outage in a log. The row is fine — it falls back.
            logger.info(f"wbedit: no thumbnail for {doc_id} — {exc}")
            return jsonify({"error": str(exc)}), 415

        etag = f'"{doc_id}-t-{key}"'
        if request.headers.get("If-None-Match") == etag:
            resp = Response(status=304)
        else:
            resp = Response(blob, mimetype="image/webp")
        resp.headers["ETag"] = etag
        # Revalidate thumbnails because the URL does not encode the crop; a long `max-age` could show
                # an old crop after focus changes. `no-cache` allows storage but requires conditional
                # validation, preserving 304 responses. A URL-keyed cache would require per-row metadata work.
        resp.headers["Cache-Control"] = "private, no-cache"
        return resp

    @bp.get("/wbedit/documents/<doc_id>/export")
    @_locked_guard
    def wbedit_export(doc_id):
        """Download the requested revision in the format SillyTavern imports. Rebuild a card PNG
    with its stored original picture and preserve the requested revision rather than
    defaulting to latest, so an older revision remains usable for rollback.
    """
        store = _docs()
        doc = store.get(doc_id)
        # A.3 — and the docstring above is exactly why: a route whose whole purpose is "the
        # revision asked for, never the latest" was reading `?revision=banana` as latest.
        rev = store.revision(doc_id, revision_arg())
        content = store.outbound(doc, rev.content)

        if doc.kind == "card" and store.has_asset(doc_id, AVATAR):
            blob = png_card.write_card(store.asset(doc_id, AVATAR), content)
            mimetype, ext = "image/png", "png"
        else:
            blob = json.dumps(content, ensure_ascii=False, indent=2).encode("utf-8")
            mimetype, ext = "application/json", "json"

        resp = Response(blob, mimetype=mimetype)
        resp.headers["Content-Disposition"] = _disposition(f"{doc.name}.{ext}")
        # User content on its way out of an encrypted store: no intermediary keeps a copy.
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.post("/wbedit/documents/<doc_id>/avatar")
    @_locked_guard
    def wbedit_put_avatar(doc_id):
        """Replace a card's avatar from a raw PNG request body. Store the bytes verbatim to
    preserve animation and ancillary chunks; do not decode and re-encode the source. Accept
    card documents only.
    """
        if (request.content_length or 0) > MAX_UPLOAD:
            return jsonify({"error": "image too large"}), 413
        blob = request.get_data(cache=False)
        if len(blob) > MAX_UPLOAD:
            return jsonify({"error": "image too large"}), 413
        if not blob.startswith(png_card.PNG_SIGNATURE):
            return jsonify({"error": "that is not a PNG"}), 400

        store = _docs()
        doc = store.get(doc_id)
        if doc.kind == "worldbook":
            return jsonify({"error": "a worldbook has no picture"}), 400
        return jsonify(store.put_avatar(doc_id, blob).to_dict()), 201

    @bp.post("/wbedit/documents/<doc_id>/focus")
    @_locked_guard
    def wbedit_set_focus(doc_id):
        """m4o — which square of the picture is the face. `{"focus": {x, y, w}}`, or `null` to
        go back to the centered square.

        🔴 **THE RECT IS FRACTIONS OF THE IMAGE, NEVER PIXELS**, because that is the fork's own
        format (`focusToParam` serializes `x,y,w` to four decimals) and because pixels would be
        wrong the moment a different picture is uploaded under the same rect.

        🔴 **NO REVISION IS MINTED.** See `DocumentStore.set_focus` — the rect describes the image,
        the image is an Asset, and it reaches SillyTavern injected at the boundary exactly as the
        world name does. A revision per drag would be history nobody reads.
        """
        body = request.get_json(silent=True) or {}
        raw = body.get("focus")
        if raw is None:
            return jsonify(_docs().set_focus(doc_id, None).to_dict())
        if not isinstance(raw, dict):
            return jsonify({"error": "focus must be an object or null"}), 400
        try:
            rect = {k: float(raw[k]) for k in ("x", "y", "w")}
        except (KeyError, TypeError, ValueError):
            return jsonify({"error": "focus needs x, y and w"}), 400
        # This value is stored in the Library card
        # The focus rect is stored in the card and used by SillyTavern, so validate it before saving.
        # `focusToParam` would serialize happily, and a rect running off the edge crops to nothing.
        if not (0.0 < rect["w"] <= 1.0):
            return jsonify({"error": "the face square must fit inside the picture"}), 400
        for k in ("x", "y"):
            rect[k] = min(max(rect[k], 0.0), 1.0 - rect["w"])
        return jsonify(_docs().set_focus(doc_id, rect).to_dict())

    @bp.post("/wbedit/books")
    @_locked_guard
    def wbedit_new_book():
        """Create an empty worldbook authored in Vocalis and mark its source accordingly. Keep the
    Add Entry control available in the empty state. Refuse to send an empty book because the
    SillyTavern write replaces the target book.
    """
        name = str((request.get_json(silent=True) or {}).get("name") or "").strip()
        if not name:
            return jsonify({"error": "no name"}), 400
        doc = _docs().create({"entries": {}}, name=name[:MAX_NAME], kind="worldbook", source="new")
        body = doc.to_dict()
        body["avatar"] = False
        return jsonify(body), 201

    @bp.post("/wbedit/cards")
    @_locked_guard
    def wbedit_new_card():
        """Create a character card from the valid empty V2-card skeleton and run the normal
    document validation. New cards start without a worldbook association; association is
    managed separately.
    """
        name = str((request.get_json(silent=True) or {}).get("name") or "").strip()
        if not name:
            return jsonify({"error": "no name"}), 400
        doc = _docs().create(card_fmt.empty_card(name[:MAX_NAME]),
                             name=name[:MAX_NAME], kind="card", source="new")
        body = doc.to_dict()
        body["avatar"] = False
        return jsonify(body), 201

    @bp.post("/wbedit/personas")
    @_locked_guard
    def wbedit_new_persona():
        """Create a persona document without inventing its SillyTavern avatar reference. The
    persona filename is assigned when its avatar is uploaded; a standalone PNG contains no
    persona metadata and cannot be imported as a complete persona.
    """
        name = str((request.get_json(silent=True) or {}).get("name") or "").strip()
        if not name:
            return jsonify({"error": "no name"}), 400
        doc = _docs().create({"spec": persona_fmt.SPEC, "name": name[:MAX_NAME]},
                             name=name[:MAX_NAME], kind="persona", source="new")
        body = doc.to_dict()
        body["avatar"] = False
        return jsonify(body), 201

    @bp.post("/wbedit/personas/import")
    @_locked_guard
    def wbedit_import_persona():
        """Import a persona JSON file through a dedicated route because external files lack
    Vocalis's persona marker and persona shape alone is ambiguous with a card. Convert the
    file, then apply the shared document checks and require the result to classify as a
    persona. Reject PNG-only uploads, which contain an avatar but no persona fields.
    """
        raw = request.files.get("file")
        if raw is None:
            return jsonify({"error": "no file"}), 400
        blob = raw.read(MAX_UPLOAD + 1)
        if len(blob) > MAX_UPLOAD:
            return jsonify({"error": "file too large"}), 413
        if blob.startswith(png_card.PNG_SIGNATURE):
            return jsonify({"error": "a persona's PNG holds only the picture — there is no "
                                     "persona inside it. Press ✚ New Persona…, type the name and "
                                     "description, then ⬆ Upload PNG to give it this face."}), 400
        text, failed = _decode_upload(blob, not_text="that file is not a persona document")
        if failed:
            return failed
        default_name = (raw.filename or "").rsplit(".", 1)[0]
        try:
            doc, from_prose = persona_fmt.from_upload(text, default_name=default_name)
        except persona_fmt.NotAPersona as exc:
            return jsonify({"error": str(exc)}), 400

        # The funnel, in the order the other door runs it: the validity of the document first, so
        # a refusal names the real reason, and only then what kind of document it is.
        try:
            doc_validate.check_document(doc)
        except doc_validate.InvalidDocument as exc:
            return jsonify({"error": str(exc)}), 400
        if formats.detect.doc_kind(doc) != "persona":
            # Unreachable through `from_upload`, which stamps the marker itself — and that is
            # exactly why it is asserted rather than assumed. The two are in different modules,
            # and the day the marker changes in one of them this answers 400 instead of filing a
            # document no pass, editor or send can read.
            return jsonify({"error": "that file does not describe a persona"}), 400

        name = formats.detect.display_name(doc, "persona", default_name)
        # 🔴 A NEW ROW EVERY TIME, WHICH IS `import_from_file`'s DOCUMENTED ASYMMETRY AND
        # NOT AN OVERSIGHT. Name-merging is for worldbooks, whose name IS their identity; a
        # persona is keyed on its avatar filename over there, so two personas may legitimately
        # share a display name and merging on it would put one person's description into
        # another's history.
        # 🔴 9.5.13 — THE `avatar` IN THE FILE IS A CLAIM, AND IT IS HANDED OVER AS ONE.
        # `from_document` returns our own export verbatim, so a file carrying our spec marker
        # arrives still holding the avatar filename that IS a persona's identity in SillyTavern.
        # It is not adopted here and it is not silently kept: `_import_persona_file` checks it
        # against the library's own record and either lands the file on the document that really
        # owns that key, or strips it. See that method for what the exemption cost.
        created, is_new, changed = _docs().import_from_file(
            doc, name=name[:MAX_NAME], kind="persona",
            st_ref=persona_fmt.avatar_id(doc))
        body = created.to_dict()
        body["avatar"] = False
        body["created"] = is_new
        body["changed"] = changed
        body["revision"] = created.latest
        # The toast says the whole file is in the description when it is, because that text goes
        # into every prompt; trimming remains the user's choice. See `persona.from_upload`.
        body["prose"] = from_prose
        return jsonify(body), 201 if is_new else 200

    @bp.post("/wbedit/documents/<doc_id>/entry")
    @_locked_guard
    def wbedit_new_entry(doc_id):
        """🔴 7.0-m4z / §9a.19 — add an entry to a World Book.

        **THIS CANNOT BE A CLIENT-SIDE EDIT, AND THAT IS WHY IT IS A ROUTE.** `/edit` refuses a
        locator that does not already resolve (`get_at` must find it), and `set_at` only assigns a
        leaf — neither can bring a new `entries` key into existence. So the entry has to exist in a
        revision before the editor can address it at all.

        🔴 **THE uid IS max+1 OVER THE WHOLE BOOK, NEVER `len(entries)`.** Deleting an entry in
        SillyTavern leaves a gap, so a count-based id collides with a live entry and the new text
        lands *on top of* an existing entry — a silent overwrite inside the document this feature exists
        to grow. The container key is `str(uid)` to match the compiled shape (§8.1).

        ⚠️ Refused on a section chunk file: its `entries` is a LIST with a different key field, and
        appending a compiled-shape entry to it would produce a document that assembles into
        something that fires nothing. Assemble it first — the same boundary `st_write` draws.
        """
        body = request.get_json(silent=True) or {}
        comment = str(body.get("comment") or "").strip()
        # 🔴 A.3, AND THIS ONE IS A WRITE.
        # `add_revision` does not call `_require_latest`, so an unparseable `?revision=` silently
        # forked the new head off latest instead of off the base the browser named. That is §1.1's
        # harm (a change built on a base nobody chose) reachable by a mangled URL.
        n = revision_arg()
        rev = _docs().revision(doc_id, n)
        content = rev.content
        if not isinstance(content, dict) or not isinstance(content.get("entries"), dict):
            return jsonify({"error": "this is a section chunk file, not a compiled World Book — "
                                     "assemble it first, then add entries to the assembled book"}), 400

        entries = dict(content["entries"])
        # 🔴 `max + 1`, NEVER `len(entries)` — see `assemble.next_uid`, which is where that loop
        # went when ⬆ Import entry became its second caller. The hazard it guards is unchanged.
        uid = wb_assemble.next_uid(entries)
        # 🔴 m5e / §9a.22 — BORN AT THE BOOK'S OWN PRIORITY, NOT THE ASSEMBLER'S 20. An imported
        # book's entries carry SillyTavern's 100; an entry minted at 20 sorts last and is the first
        # thing dropped when the World Info budget fills, silently. See `order_for_new_entry`.
        order = wb_assemble.order_for_new_entry(entries)
        # 🔴 9.5.11 — AND AT DEPTH, WHICH `new_entry` NOW DOES FOR ITSELF. `DEFAULTS` puts a new
        # entry at position 0, inside the character definitions, so the new entry
        # invalidates the KV cache for the whole prompt below it every turn it flickers — the exact
        # cost ⇊ Fix positions exists to remove, reintroduced one click at a time. See
        # `assemble.NEW_ENTRY_POSITION`; the order above is the book's answer, this one is not.
        entry = wb_assemble.new_entry(uid, comment=comment or f"entry {uid}", order=order)
        entry["displayIndex"] = len(entries)
        entries[str(uid)] = entry

        out = dict(content)
        out["entries"] = entries
        # Require the base revision to remain the current head. If another tab advances it while the
                # editor is open, return 409 with `latest` instead of overwriting newer content.
        new = _docs().add_revision(doc_id, out, note=f"added entry {entry['comment']}",
                                   from_revision=rev.n, require_head=True)
        return jsonify({"revision": new.n, "uid": uid, "order": order,
                        "locator": ["entries", str(uid), "content"]}), 201

    @bp.post("/wbedit/documents/<doc_id>/entry/import")
    @_locked_guard
    def wbedit_import_entry(doc_id):
        """Merge one or more imported entries into a worldbook as a single new revision. Validate
    the upload before merging, assign each entry a fresh `assemble.next_uid` rather than
    trusting its external `uid`, and report renumbering. One file produces one revision.
    """
        raw_file = request.files.get("file")
        if raw_file is None:
            return jsonify({"error": "no file"}), 400
        blob = raw_file.read(MAX_UPLOAD + 1)
        if len(blob) > MAX_UPLOAD:
            return jsonify({"error": "file too large"}), 413
        # Distinguish UTF-8 decoding failures from JSON parse failures so the response identifies the
                # actual correction required.
        try:
            text = blob.decode("utf-8")
        except UnicodeDecodeError:
            return jsonify({"error": "this file is not UTF-8 — re-save it as UTF-8 and try "
                                     "again."}), 400
        try:
            incoming = json.loads(text)
        except ValueError:
            return jsonify({"error": "that is not a JSON file"}), 400
        try:
            doc_validate.check_document(incoming, what="that entry file")
        except doc_validate.InvalidDocument as exc:
            return jsonify({"error": str(exc)}), 400

        found = formats.worldbook.entries_for_import(incoming)
        if not found:
            return jsonify({"error": "no entry in that file — it should be one SillyTavern entry, "
                                     "or a worldbook holding one or more in its `entries`"}), 400

        # 🔴 A.3 — the same write-side hazard `POST …/entry` records: an unparseable `?revision=`
        # must not fork this merge off latest instead of off the base the browser named.
        rev = _docs().revision(doc_id, revision_arg())
        content = rev.content
        if not isinstance(content, dict) or not isinstance(content.get("entries"), dict):
            return jsonify({"error": "this is a section chunk file, not a compiled World Book — "
                                     "assemble it first, then import entries into the assembled "
                                     "book"}), 400

        entries = dict(content["entries"])
        # §9a.22 — the book's own priority is the fallback, and it is computed ONCE, from the book
        # as it stood. Recomputing it per entry would let a file of three entries drag the mode.
        order = wb_assemble.order_for_new_entry(entries)
        uids, placeholders, inert = [], 0, 0
        for raw in found:
            # 🔴 INSIDE THE LOOP, against the GROWING dict. A file holding three entries would
            # otherwise be given one uid three times, and two thirds of it would vanish into the
            # same key — the collision this route exists to prevent, arriving from our own side.
            uid = wb_assemble.next_uid(entries)
            entry = wb_assemble.adopt_entry(raw, uid, order=order, display_index=len(entries))
            entries[str(uid)] = entry
            uids.append({"from": raw.get("uid") if isinstance(raw, dict) else None, "to": uid})
            if entry["content"] == wb_assemble.NEW_ENTRY_TEXT:
                placeholders += 1
            # §9a.29 — an entry that arrives keyless and normal is one SillyTavern stores, shows,
            # and never fires. The editor marks it, but the moment it is worth saying is now.
            if (formats.worldbook.fires_by_keyword(entry)
                    and not formats.worldbook.entry_keys(entry)):
                inert += 1

        out = dict(content)
        out["entries"] = entries
        note = f"imported {len(uids)} entr{'y' if len(uids) == 1 else 'ies'}"
        # `require_head` for `POST …/entry`'s reason — this door mints a head from the base the
        # browser named too, and it is behind a file picker, so the window is not a click.
        new = _docs().add_revision(doc_id, out, note=note, from_revision=rev.n,
                                   require_head=True)
        return jsonify({"revision": new.n, "added": len(uids), "uids": uids, "order": order,
                        "placeholders": placeholders, "inert": inert,
                        "locator": ["entries", str(uids[0]["to"]), "content"]}), 201

    # ── 9.4 — Fix positions: stop the World Info block from moving every turn ────────────────
    #
    # The measurement, the fork citations and the transform itself are in `formats/depthfix.py`.
    # What lives HERE is the part that touches a browser, and it is two routes rather than one so
    # that the preview cannot write and the write cannot be reached without one:
    #
    #   GET  …/depths  — counts only, nothing written. Four numbers, one per tick combination, so
    #                    the dialog updates its own count line without a second request AND
    #                    without a second authority deciding what "moving" means.
    #   POST …/depths  — mints a revision.
    #
    # The client submits settings only. Re-plan on the server from the revision being written so a
        # stale browser cannot move entries omitted from its preview.
    #
    # 🔴 **COUNTS ONLY, EVERYWHERE.** Neither route returns an entry's text, keywords or title,
    # and neither logs one. `plan()` is built that way; this is the reminder for whoever adds the
    # "which ones?" affordance that will feel obviously useful one day.

    def _compiled_book(doc_id):
        """`(revision, None)` for a compiled World Book, `(None, response)` for anything else.

        ⚠️ Refused on a section chunk file for `POST …/entry`'s reason: its `entries` is a LIST
        and its key field is spelled differently, so "position" on it is not the field
        SillyTavern reads. Assemble it first — the same boundary `st_write` draws.
        """
        rev = _docs().revision(doc_id, revision_arg())
        if not formats.worldbook.is_compiled(rev.content):
            return None, (jsonify({"error": "this is not a compiled World Book — a character "
                                            "card has no entry positions, and a section chunk "
                                            "file has to be assembled first"}), 400)
        return rev, None

    def _depth_arg(raw):
        """Parse the requested depth as an integer and return `BadArg` when it is outside the
    entry-field bounds. Refuse invalid values rather than clamping them, which would
    silently rewrite data.
    """
        if raw is None:
            return depthfix.DEFAULT_DEPTH
        if isinstance(raw, bool) or not isinstance(raw, int):
            try:
                raw = int(str(raw).strip())
            except (TypeError, ValueError):
                # `from None` like `reqargs.revision_arg`: the chained `int()` traceback says
                # nothing the message does not, and this is a 400 about the caller's input.
                raise BadArg("depth has to be a whole number") from None
        if not depthfix.MIN_DEPTH <= raw <= depthfix.MAX_DEPTH:
            raise BadArg(f"depth has to be between {depthfix.MIN_DEPTH} and "
                         f"{depthfix.MAX_DEPTH}")
        return raw

    @bp.get("/wbedit/documents/<doc_id>/depths")
    @_locked_guard
    def wbedit_depths_preview(doc_id):
        """What Fix positions would do to this revision, as counts. Nothing is written."""
        rev, refusal = _compiled_book(doc_id)
        if refusal is not None:
            return refusal
        content = rev.content
        # All four tick combinations, computed by the one function that decides what "moving"
        # means. The alternative — the browser adding `offer_examples` to `moving` — is wrong
        # whenever an entry qualifies under BOTH extras, and wrong quietly.
        plans = {
            "base": depthfix.plan(content),
            "examples": depthfix.plan(content, examples=True),
            "unstable": depthfix.plan(content, unstable=True),
            "both": depthfix.plan(content, examples=True, unstable=True),
        }
        base, wide = plans["base"], plans["both"]
        return jsonify({
            "revision": rev.n,
            "total": base["total"],
            "moving": {k: p["moving"] for k, p in plans.items()},
            # 🔴 THE OTHER HALF OF THE PREVIEW, AND IT IS PER-COMBINATION FOR `moving`'s REASON.
            # The diagnosis handoff's UI requirement is "total entries, how many would move, how
            # many would be LEFT ALONE" — three numbers, and the third was missing because
            # `total - moving` is derivable and I let that stand in for showing it. It is also not
            # enough on its own: "16 left alone" invites "left alone why?", and the buckets answer
            # it. They shift as the ticks change (a flickering constant leaves `left_stable` the
            # moment that tick goes on), so they are computed per combination here rather than
            # once — the same rule that made `moving` a map.
            "leaving": {k: p["leaving"] for k, p in plans.items()},
            "buckets": {k: {"stable": p["left_stable"], "at_depth": p["left_at_depth"],
                            "placed": p["left_placed"], "offered": p["offer_examples"] + p["offer_unstable"]}
                        for k, p in plans.items()},
            "left_stable": base["left_stable"],
            "left_at_depth": base["left_at_depth"],
            "left_placed": base["left_placed"],
            "offer_examples": base["offer_examples"],
            "offer_unstable": base["offer_unstable"],
                        # Report counts per checkbox combination; enabling examples can move entries between
                        # offered categories, so a single aggregate would not match the visible controls.
            "offers": {k: {"examples": p["offer_examples"], "unstable": p["offer_unstable"]}
                       for k, p in plans.items()},
            # From the WIDE plan: an always-injected entry that flickers AND sits at an example
            # position is counted under `offer_examples` in the base plan and would otherwise
            # have no reason attached, so the dialog would under-report why they are being
            # offered at all.
            "reasons": wide["reasons"],
            "by_position": base["by_position"],
            "default_depth": depthfix.DEFAULT_DEPTH,
            "min_depth": depthfix.MIN_DEPTH,
            "max_depth": depthfix.MAX_DEPTH,
        })

    @bp.post("/wbedit/documents/<doc_id>/depths")
    @_locked_guard
    def wbedit_depths_apply(doc_id):
        """Move the flickering entries to `At depth`, as ONE new revision.

        🔴 **THE REVISION IS THE UNDO, AND IT IS WHY THIS DOES NOT WRITE A `.fixed.json`.** The
        diagnosis handoff specified "never overwrite the input — write `<name>.fixed.json`",
        because it was designing a file-transform utility for a tool that could not hold the
        book. This one holds it: the pre-fix revision stays in the picker, stays exportable, and
        `↺ Roll back to this` already undoes the whole operation. A second file beside the first
        would be a weaker undo AND a second copy of the lorebook on disk.

        🔴 **`verify` CAN REFUSE, AND THEN NOTHING IS SAVED.** A corrupted World Book is much
        worse than a slow one, so the transform's output is checked against its input — every
        field outside `WRITTEN_FIELDS`, byte-identical, per entry — before `add_revision` is
        reached. A failure here is ours, never the document's, so it is a 500 and it says so.
        """
        body = request.get_json(silent=True) or {}
        depth = _depth_arg(body.get("depth"))
        examples = bool(body.get("examples"))
        unstable = bool(body.get("unstable"))
        rev, refusal = _compiled_book(doc_id)
        if refusal is not None:
            return refusal
        content = rev.content
        plan = depthfix.plan(content, depth=depth, examples=examples, unstable=unstable)
        if not plan["move"]:
            # Not an error state in the world, but it must not mint a revision: an identical
            # revision in the picker is a rollback target that does nothing, and a "done" toast
            # over an unchanged book undermines trust in the status messages.
            #
                        # Distinguish an empty move set from entries available only through optional categories,
                        # so the response agrees with the selected plan.
            offered = plan["offer_examples"] + plan["offer_unstable"]
            if offered:
                return jsonify({"error": f"nothing to move with these settings — the "
                                         f"{offered} entr{'y' if offered == 1 else 'ies'} this "
                                         f"book has above the chat history are the ones offered "
                                         f"as extras, so tick one of the boxes to move them",
                                "moved": 0, "offered": offered}), 400
            return jsonify({"error": "nothing to move — no entry in this book is sitting above "
                                     "the chat history where it would cost you a reprocess",
                            "moved": 0, "offered": 0}), 400
        out = depthfix.apply_plan(content, plan["move"], depth)
        try:
            depthfix.verify(content, out, plan["move"], depth)
        except depthfix.DepthFixFailed as exc:
            logger.error("wbedit: the depth fix refused its own output for {}: {}", doc_id, exc)
            return jsonify({"error": f"the rewritten book failed its own check ({exc}) — nothing "
                                     f"was saved and this revision is untouched"}), 500
        moved = len(plan["move"])
        note = (f"moved {moved} entr{'y' if moved == 1 else 'ies'} to depth {depth}")
        # Require the book head to match the previewed revision before writing. Return 409 with the
                # current head when another editor or paired import advances it during the modal.
        new = _docs().add_revision(doc_id, out, note=note, from_revision=rev.n,
                                   require_head=True)
        return jsonify({"revision": new.n, "moved": moved, "depth": depth,
                        "total": plan["total"], "left_stable": plan["left_stable"],
                        "left_at_depth": plan["left_at_depth"],
                        "left_placed": plan["left_placed"]}), 201

    @bp.post("/wbedit/documents/<doc_id>/rename")
    @_locked_guard
    def wbedit_rename(doc_id):
        name = str((request.get_json(silent=True) or {}).get("name") or "").strip()
        if not name:
            return jsonify({"error": "no name"}), 400
        return jsonify(_docs().rename(doc_id, name[:MAX_NAME]).to_dict())

    @bp.post("/wbedit/documents/<doc_id>/world")
    @_locked_guard
    def wbedit_set_world(doc_id):
        """Associate a character with a worldbook by document ID, or clear the association with an
    empty string. Return the updated record without minting a revision or moving `latest`;
    stable IDs preserve the relationship across renames.
    """
        body = request.get_json(silent=True) or {}
        book = body.get("book")
        if book is None or not isinstance(book, str):
            return jsonify({"error": "no book"}), 400
        try:
            doc = _docs().set_world(doc_id, book.strip())
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify(doc.to_dict())

    @bp.delete("/wbedit/documents/<doc_id>")
    @_locked_guard
    def wbedit_delete(doc_id):
        _docs().delete(doc_id)
        return jsonify({"ok": True})

    @bp.post("/wbedit/documents/<doc_id>/rollback/<int:n>")
    @_locked_guard
    def wbedit_rollback(doc_id, n):
        """Roll back by minting a NEW revision equal to `n` — history is never deleted and the
        numbering never rewinds (§4). "Revision 7 (from revision 3)" is the honest label."""
        return jsonify(_docs().rollback(doc_id, n).to_dict())

    @bp.post("/wbedit/documents/<doc_id>/edit")
    @_locked_guard
    def wbedit_hand_edit(doc_id):
        """Apply one hand edit from the Editor pane as a new revision. This route changes document
    content directly and does not run an LLM pass.
    """
        body = request.get_json(silent=True) or {}
        edits = body.get("edits")
        if not isinstance(edits, list) or not edits:
            return jsonify({"error": "no edits"}), 400
        base = body.get("revision")
        store = _docs()
        rev = store.revision(doc_id, base if isinstance(base, int) else None)

        # 🔴 m5g / §9a.26 — WHICH ENTRIES A TYPED EDIT MAY ADDRESS, TAKEN FROM THE COLLECTOR
        # RATHER THAN FROM THE SHAPE OF THE LOCATOR. `("data", "order")` is a perfectly
        # well-formed locator ending in a known field name, and honoring it would write a
        # worldbook setting into the top of a character card. Asking the collector produces
        # exactly the set the editor was offered, which is the only set that can be legitimate.
        jobs = formats.collect(rev.content, rel=str(doc_id),
                               card_fields=formats.CARD_FIELDS_ALL,
                               card_preselect=formats.CARD_FIELDS_DEFAULT,
                               card_empty=True, persona_empty=True)
        entry_locs = {tuple(j.meta["entry"]) for j in jobs if j.meta.get("entry")}
        # 🔴 AND THE PROSE BRANCH GETS THE SAME TREATMENT.
        #
        # It used to check only that the locator RESOLVED, which is not a permission check at
        # all: `set_at` does `node[locator[-1]] = value`, so any addressable node could be
        # replaced by a string. `{"locator": ["entries","5"], "text": "x"}` replaced an ENTIRE
        # ENTRY with `"x"`; on a card, `["data"]` replaced the whole card body. Narrower forms
        # hit exactly what `entryfields.NOT_EDITABLE` exists to protect — `uid` (the identity
        # every other locator points at), `order`, `constant`, `spec`. And it did not stop
        # there: Send then ships the mangled document and `saveWorldInfo` REPLACES the book in
        # SillyTavern.
        #
        # The set was already being computed on the line above and thrown away. It is
        # definitionally what `GET /fields` offered — same call, same kwargs — so nothing the
        # editor can legitimately edit is outside it.
        #
        # ⚠️ Not a regression for a new entry: `assemble.new_entry` seeds a non-blank `content`,
        # so a just-created entry IS collected.
        #
                        # Empty card fields must be represented in the editor payload as well as the
                        # collector; otherwise the editor cannot save a first value for that field.
        # were the bug. `/fields` offers the empty rows now, so this set has to contain them or
        # every one of them would be a textarea that refuses to save with "not an editable field
        # of this document" — a control that is visible, typable, and dead on the press.
        prose_locs = {tuple(j.locator) for j in jobs}

        typed: list[tuple[tuple, object]] = []
        for e in edits:
            loc = e.get("locator")
            if not isinstance(loc, list) or not loc:
                return jsonify({"error": "an edit needs a locator"}), 400
            key = tuple(loc)

            # A SETTING — `value` is typed JSON and may legitimately be null, false or 0.
            # `"value" in e` and not a truthiness test: `{"value": null}` is the whole point of
            # the tri-state, and `e.get("value")` cannot tell it from an absent key.
            if "value" in e:
                if key[:-1] not in entry_locs:
                    return jsonify({"error": f"locator {loc} is not a worldbook entry "
                                             f"setting"}), 400
                try:
                    value = entryfields.coerce(str(key[-1]), e["value"])
                except entryfields.BadValue as exc:
                    return jsonify({"error": str(exc)}), 400
                # ⚠️ A MISSING KEY IS NOT AN ERROR HERE, and that is the one place this route is
                                # Legacy books may lack fields added later. Once the parent is validated as an
                                # entry, `set_at` may create the absent key as the SillyTavern editor does.
                # the key is exactly what SillyTavern's own editor does.
                try:
                    original = get_at(rev.content, key)
                except (KeyError, IndexError, TypeError):
                    original = _ABSENT
                if not _same(original, value):
                    typed.append((key, value))
                continue

            # PROSE — one string at one locator, the path everything took before m5g.
            text = e.get("text")
            if not isinstance(text, str):
                return jsonify({"error": "an edit needs a locator and text"}), 400
            # 🔴 EDITABLE, NOT MERELY ADDRESSABLE (§2.2). "It resolves" is not permission: see
            # the note where `prose_locs` is built.
            if key not in prose_locs:
                return jsonify({"error": f"locator {loc} is not an editable field of this "
                                         f"document"}), 400
            try:
                original = get_at(rev.content, key)
            except (KeyError, IndexError, TypeError):
                # 🔴 §9a.32 — A FIELD THAT IS NOT THERE YET READS AS "", AND THE PERMISSION CHECK
                # ABOVE IS WHAT MAKES THAT SAFE. This used to 400, which was right while every
                # collected field necessarily resolved; now `card_empty` offers the absent ones,
                # so the first save of a `system_prompt` lands here by design. It is NOT a
                # loosening: `prose_locs` has already proved this exact locator is one the editor
                # legitimately offered, and `set_at` writes onto a parent the collector walked.
                original = ""
            if text != original:
                typed.append((key, text))

        if not typed:
            return jsonify({"error": "nothing changed"}), 400

                # Refuse a normal entry without keywords because SillyTavern's activation loop skips it;
                # accepting it would report a save for content that can never fire.
        # does nothing, forever, with the only trace a debug line nobody has switched on.
        #
        # Judged on the RESULT, not on the edits: `typed` may be deleting the last keyword, or
        # setting `constant` false on an entry that never had one, and neither is visible by
        # looking at the edit alone. So apply to a copy and ask the document.
        #
        # ⚠️ The copy is not an optimization to remove — `set_at` mutates in place and `rev.content`
        # is the STORED revision (I8: the imported document is immutable).
        if formats.detect.doc_kind(rev.content) == "worldbook":
            preview = copy.deepcopy(rev.content)
            for loc, value in typed:
                try:
                    set_at(preview, loc, value)
                except (KeyError, IndexError, TypeError):
                    # A locator that will not resolve on the copy is a bug the branches above
                    # already reject; do not turn it into a confusing keyword refusal.
                    preview = None
                    break
            inert = formats.worldbook.inert_entries(preview) if preview is not None else []
            if inert:
                labels = [e["label"] for e in inert]
                shown = ", ".join(labels[:6]) + (f" and {len(labels) - 6} more"
                                                 if len(labels) > 6 else "")
                logger.info(f"wbedit: save refused — {len(inert)} entr"
                            f"{'y' if len(inert) == 1 else 'ies'} with no keywords")
                # 🔴 422, NOT 409. The 409 on this route already means "someone else moved the
                                # Use the standard stale-head conflict response so the client can distinguish a
                                # concurrent edit from a validation error.
                return jsonify({
                    "error": "entries_without_keywords",
                    # LABELS to say, LOCATORS to mark — see `inert_entries`.
                    "entries": inert,
                    "message": f"{len(inert)} entr"
                               f"{'y has' if len(inert) == 1 else 'ies have'} no keywords, so "
                               f"SillyTavern would never use "
                               f"{'it' if len(inert) == 1 else 'them'}: {shown}. Add a keyword "
                               f"(or delete the entry) and save again.",
                }), 422
        # 🔴 THE PENDING STATE HAS BECOME REAL, SO IT STOPS BEING PENDING (§9a.15). Leaving the
        # draft behind would mean the next open replayed edits that are already in the revision —
        # harmless-looking because the text matches, until the user rolls back and the draft
        # silently re-applies them over the older bytes.
        #
        # ⚠️ THE CLEAR LIVES IN `apply_edits` NOW, NOT HERE (1.2). It happens inside the same lock
        # that mints the revision, and only when one was actually minted — so a client that dies
        # on the response, or any future caller of `apply_edits`, still ends clean. The explicit
        # `store.clear_drafts(doc_id)` that used to sit on the next line was doing the same job a
        # moment later and outside the lock; two answers to "who clears the draft on save" is one
        # too many, and the one that can be skipped by a caller is the wrong one to keep.
        new = store.apply_edits(doc_id, rev.n, typed, note="hand edit")
        return jsonify(new.to_dict() if new else {}), 201

    # ── the instruction library ──────────────────────────────────────────────

    @bp.get("/wbedit/instructions")
    @_locked_guard
    def wbedit_instructions():
        kind = request.args.get("kind", "")
        return jsonify({"instructions": [i.to_dict() for i in _library().list(kind)]})

    @bp.post("/wbedit/instructions")
    @_locked_guard
    def wbedit_instruction_add():
        b = request.get_json(silent=True) or {}
        text = str(b.get("text") or "").strip()
        if not text:
            return jsonify({"error": "no instruction text"}), 400
        ins = _library().add(name=str(b.get("name") or "")[:MAX_NAME], text=text,
                             kind=str(b.get("kind") or ""), favorite=bool(b.get("favorite")))
        return jsonify(ins.to_dict()), 201

    @bp.post("/wbedit/instructions/<ins_id>")
    @_locked_guard
    def wbedit_instruction_update(ins_id):
        b = request.get_json(silent=True) or {}
        fields = {k: v for k, v in b.items() if k in ("name", "text", "favorite", "kind")}
        if not fields:
            return jsonify({"error": "nothing to update"}), 400
        try:
            return jsonify(_library().update(ins_id, **fields).to_dict())
        except KeyError:
            abort(404)

    @bp.delete("/wbedit/instructions/<ins_id>")
    @_locked_guard
    def wbedit_instruction_delete(ins_id):
        try:
            _library().delete(ins_id)
        except KeyError:
            abort(404)
        return jsonify({"ok": True})

    # ── the model ────────────────────────────────────────────────────────────

    @bp.get("/wbedit/model")
    def wbedit_model():
        """Which model is actually loaded (§3.1).

        🔴 **THE TAB MUST SHOW THIS BEFORE A PASS STARTS.** A pass run under one model is not
        the same pass, and the difference is invisible afterward unless it was recorded. The
        name comes from `/api/v1/model` WITH the bearer — unauthenticated it is the placeholder
        `koboldcpp/protected-model`, and recording that would be worse than recording nothing.

        📌 11.1: answers for the CHOSEN engine, and says which (`engine`, `engine_label`) so the
        badge can read `model: X (OpenRouter)` — text leaving the box must be visible before a
        pass, not discovered in its log. KoboldCpp's branch is the 7.0 code, unchanged.
        """
        eng = llm_engine.chosen()
        tag = {"engine": eng, "engine_label": llm_engine.LABELS[eng]}
        if eng != "kobold":
            try:
                e = llm_engine.resolve(eng)
            except llm_engine.EngineUnavailable as exc:
                return jsonify({"loaded": False, "error": str(exc), **tag}), 200
            return jsonify({"loaded": True, **e.status, "model": e.model, **tag})
        try:
            cfg = _web_kobold._kobold_cfg()
            st = kobold.status(cfg)
        except kobold.KoboldUnreachable as exc:
            return jsonify({"loaded": False, "error": str(exc), **tag}), 200
        except (OSError, ValueError, KeyError, AttributeError, TypeError) as exc:
            # A hand-edited `kobold:` block in app_settings.yaml resolves to nonsense rather
            # than raising cleanly, and this route is a status badge — it must degrade to "no
            # model" instead of 500ing the tab it sits on.
            logger.warning(f"wbedit: kobold status failed — {type(exc).__name__}")
            return jsonify({"loaded": False, "error": "kobold status failed", **tag}), 200
        return jsonify({"loaded": True, **st, **tag})

    # ── passes ───────────────────────────────────────────────────────────────

    @bp.post("/wbedit/documents/<doc_id>/pass")
    @_locked_guard
    def wbedit_pass_start(doc_id):
        """Open a pass and run it on a worker thread.

        🔴 **409 WHILE ONE IS RUNNING (I12).** One model is loaded. Two passes would interleave
        requests to it and invalidate the prompt-prefix cache on every call, so the second one
        would be slower AND worse. Queueing was rejected: the honest answer to "can I start
        another" is no, and a queue that hides a 35-minute wait behind a spinner is a worse
        answer than a refusal.
        """
        global _RUN
        b = request.get_json(silent=True) or {}
        instruction = str(b.get("instruction") or "").strip()
        if not instruction:
            return jsonify({"error": "no instruction"}), 400

        with _RUN_LOCK:
            if _RUN is not None and not _RUN.done:
                return jsonify({"error": "a pass is already running", "running": True,
                                "doc_id": _RUN.doc_id, "pass_id": _RUN.pass_id}), 409

        store, pstore = _docs(), _passes()
        doc = store.get(doc_id)
        rev = store.revision(doc_id, b.get("revision") if isinstance(b.get("revision"), int)
                             else None)

        # 🔴 m5d / §9a.21 — COLLECT WIDE, THEN FILTER. The editor now shows nine card fields, so a
        # locator it offered must RESOLVE here or ticking `alternate_greetings[1]` and pressing Run
        # would come back "no fields selected" — a control that is visible, tickable, counted in
        # the preflight, and dead on the press.
        kw = {"card_fields": formats.CARD_FIELDS_ALL,
              "card_preselect": formats.CARD_FIELDS_DEFAULT}
        if b.get("card_fields"):
            kw = {"card_fields": tuple(b["card_fields"])}
        jobs = formats.collect(rev.content, rel=doc.name, **kw)

        wanted = b.get("locators")
        if isinstance(wanted, list) and wanted:
            keep = {tuple(x) for x in (tuple(w) for w in wanted)}
            jobs = [j for j in jobs if tuple(j.locator) in keep]
        else:
            # 🔴 AND I13 IS THE FALLBACK, NOT THE WIDE SET. A caller that names no locators is
            # saying "run the usual pass"; before m5d that meant five fields, and widening the
            # collector must not quietly turn it into nine — least of all onto `system_prompt`.
            jobs = [j for j in jobs if j.meta.get("pass_default", True)]
        if not jobs:
            return jsonify({"error": "no fields selected"}), 400

        # 11.1 — the chosen engine, resolved ONCE. KoboldCpp's two 503 sentences ("kobold is not
        # reachable: …", "no model is loaded") are produced inside `llm_engine` word for word.
        try:
            engine = llm_engine.resolve()
        except llm_engine.EngineUnavailable as exc:
            return jsonify({"error": str(exc)}), 503
        model = engine.model

        sampler = engine.sampler
        p = pstore.start(doc_id, revision=rev.n, instruction=instruction, model=model,
                         sampler=sampler, selection=[list(j.locator) for j in jobs],
                         total=len(jobs), engine=engine.id)
        logger.info(f"wbedit: pass {p.id} on {engine.label} ({model}), {len(jobs)} fields")

        run = _Run(doc_id, p.id)
        with _RUN_LOCK:
            _RUN = run
            _RECENT[p.id] = run
            for old in list(_RECENT)[:-_RECENT_KEEP]:
                _RECENT.pop(old, None)

        t = threading.Thread(target=_run_pass, name=f"wbedit-{p.id}",
                             args=(run, engine, jobs, instruction, sampler, model,
                                   str(b.get("instruction_id") or ""), doc.name),
                             daemon=True)
        t.start()
        return jsonify({**p.to_dict(), "fields": len(jobs)}), 201

    @bp.get("/wbedit/pass/<doc_id>/<pass_id>")
    @_locked_guard
    def wbedit_pass(doc_id, pass_id):
        """The pass record plus a METADATA-ONLY index of its proposals.

        🔴 **NO BODIES HERE, DELIBERATELY.** The review queue asks for one proposal at a time.
        A "give me everything" route would be convenient, would work, and would put a whole
        book's worth of before/after text into one response that some proxy will buffer.
        """
        p = _passes().get(doc_id, pass_id)
        props = _passes().proposals(doc_id, pass_id)
        return jsonify({**p.to_dict(), "proposals": [
            {"index": x.index, "label": x.label, "status": x.status, "review": x.review,
             "flags": x.flags, "elapsed": x.elapsed, "chars": len(x.original),
             "reason": x.reason} for x in props]})

    @bp.get("/wbedit/pass/<doc_id>/<pass_id>/proposal/<int:index>")
    @_locked_guard
    def wbedit_proposal(doc_id, pass_id, index):
        """One proposal, bodies included — what the review pane fetches after SSE announces it
        (§6.3.1). This route is the reason the SSE frame does not need to carry text."""
        return jsonify(_passes().proposal(doc_id, pass_id, index).to_dict())

    @bp.post("/wbedit/pass/<doc_id>/<pass_id>/proposal/<int:index>/review")
    @_locked_guard
    def wbedit_review(doc_id, pass_id, index):
        b = request.get_json(silent=True) or {}
        review = str(b.get("review") or "")
        edited = b.get("edited")
        if review not in ("pending", "approved", "rejected", "edited", "none"):
            return jsonify({"error": "bad review state"}), 400
        if edited is not None and not isinstance(edited, str):
            return jsonify({"error": "edited must be text"}), 400
        return jsonify(_passes().review(doc_id, pass_id, index, review, edited).to_dict())

    @bp.get("/wbedit/pass/<doc_id>/<pass_id>/log")
    @_locked_guard
    def wbedit_pass_log(doc_id, pass_id):
        """Return the exact prompt block and reply for a pass through an authenticated,
    session-gated route. Do not include field text in the SSE progress stream. Keep the log
    in memory; it is not written as a second persistent copy of document text.
    """
        run = _RUN if (_RUN and _RUN.pass_id == pass_id) else _RECENT.get(pass_id)
        if run is None or run.doc_id != doc_id:
            # Not an error: the bounded `_RECENT` means an old pass legitimately has no log, and
            # the pane says so rather than showing an empty window that reads as "nothing sent".
            return jsonify({"exchanges": [], "dropped": 0, "available": False})
        with run.lock:
            return jsonify({"exchanges": list(run.exchanges), "dropped": run.dropped,
                            "available": True, "running": not run.done})

    @bp.get("/wbedit/dismissed")
    @_locked_guard
    def wbedit_dismissed():
        """Return SillyTavern references that were dismissed from the Library so the user can
    restore them. This is metadata for the recycle-bin view, not document content.
    """
        return jsonify({"refs": _docs().dismissed()})

    @bp.delete("/wbedit/dismissed")
    @_locked_guard
    def wbedit_restore_all():
        return jsonify({"restored": _docs().restore()})

    @bp.delete("/wbedit/dismissed/<path:st_ref>")
    @_locked_guard
    def wbedit_restore_one(st_ref):
        """⚠️ `<path:>` because an `st_ref` is SillyTavern's own key and carries a `.png`, spaces
        and occasionally a slash. The default converter stops at the first `/` and would silently
        restore nothing for exactly those documents."""
        return jsonify({"restored": _docs().restore(st_ref)})

    @bp.post("/wbedit/dismissed")
    @_locked_guard
    def wbedit_dismiss_one():
        """Restore one dismissed SillyTavern reference to the recycle bin when an undelete sweep
    does not restore its document. Refuse if a live document already uses the reference. Put
    the ref in the request body because refs may contain slashes that make a `<path:>` route
    ambiguous with purge routes.
    """
        store = _docs()
        ref = str((request.get_json(silent=True) or {}).get("ref", "")).strip()
        if not ref:
            return jsonify({"error": "empty_ref"}), 400
        if any((d.st_ref or "").strip() == ref for d in store.list_documents()):
            return jsonify({"error": "has_document",
                            "message": "That document is in the Library — delete it to bin it."}), 409
        store.dismiss(ref)
        return jsonify({"dismissed": True})

    @bp.post("/wbedit/dismissed/<path:st_ref>/purge")
    @_locked_guard
    def wbedit_purge_one(st_ref):
        """Permanently remove one reference from the recycle bin while keeping it declined. Use
    POST because DELETE on the dismissed-reference route means undelete. Accept path-like
    refs so slashes in SillyTavern keys are preserved.
    """
        return jsonify({"purged": _docs().purge(st_ref)})

    @bp.get("/wbedit/prompt")
    @_locked_guard
    def wbedit_prompt_get():
        """Return the active system prompt and few-shot pairs together with their baseline so the
    editor can display both the current override and its reset target from one consistent
    response.
    """
        card = json.loads(vault_fs.read_text(CARD_PATH))
        return jsonify(prompt.settings.load(paths.WBEDIT_DIR, card))

    @bp.put("/wbedit/prompt")
    @_locked_guard
    def wbedit_prompt_put():
        """Save a prompt override. Refuse changes while a pass is running because its instruction
    prefix is frozen for that pass. Require a non-empty system prompt, but allow an empty
    few-shot list.
    """
        if _RUN is not None and not _RUN.done:
            return jsonify({"error": "a pass is running — the prompt is frozen until it finishes",
                            "doc_id": _RUN.doc_id, "pass_id": _RUN.pass_id}), 409
        b = request.get_json(silent=True) or {}
        system = b.get("system")
        shots = b.get("shots")
        wrapper = b.get("wrapper") or prompt.assemble.DEFAULT_WRAPPER
        if not isinstance(system, str) or not system.strip():
            return jsonify({"error": "the system prompt cannot be empty"}), 400
        if not isinstance(shots, list) or not all(isinstance(s, dict) for s in shots):
            return jsonify({"error": "shots must be a list of {user, assistant}"}), 400
        for s in shots:
            if not isinstance(s.get("user"), str) or not isinstance(s.get("assistant"), str):
                return jsonify({"error": "every shot needs a user and an assistant string"}), 400
        # 🔴 The one validation that prevents a SILENT corruption rather than a visible refusal:
        # a wrapper missing `{field}` sends no text to edit and the model answers anyway, so every
        # field comes back plausible and wrong and it reads as a model fault.
        bad = prompt.assemble.validate_wrapper(wrapper)
        if bad:
            return jsonify({"error": bad}), 400
        prompt.settings.save(paths.WBEDIT_DIR, system, shots, wrapper)
        card = json.loads(vault_fs.read_text(CARD_PATH))
        return jsonify(prompt.settings.load(paths.WBEDIT_DIR, card))

    @bp.delete("/wbedit/prompt")
    @_locked_guard
    def wbedit_prompt_reset():
        """Restore the prompt and few-shot pairs from the card's baseline defaults.

    """
        if _RUN is not None and not _RUN.done:
            return jsonify({"error": "a pass is running — the prompt is frozen until it finishes",
                            "doc_id": _RUN.doc_id, "pass_id": _RUN.pass_id}), 409
        # 🔴 m5a / §9a.12 — what it is about to throw away is recorded first. The pane's own help
        # text tells the user to press Reset when a pass misbehaves, so this button discards
        # settings that may not have been copied elsewhere.
        prompt.settings.reset(paths.WBEDIT_DIR)
        card = json.loads(vault_fs.read_text(CARD_PATH))
        return jsonify(prompt.settings.load(paths.WBEDIT_DIR, card))

    @bp.get("/wbedit/prompt/revisions")
    @_locked_guard
    def wbedit_prompt_revisions():
        """🔴 m5a / §9a.12 — every prompt this install has had, newest last.

        Metadata only: `n`, `created_at`, `note`, `fingerprint`. The bodies are multi-KB each and a
        picker needs none of them — the same rule `GET /wbedit/pass/<doc>/<pass>` follows, and for
        the same reason (a whole history in one response is what some proxy will buffer).
        """
        return jsonify({"revisions": prompt.settings.revision_index(paths.WBEDIT_DIR)})

    @bp.get("/wbedit/prompt/revision/<int:n>")
    @_locked_guard
    def wbedit_prompt_revision(n):
        """One saved prompt, in full, for review before restoring it."""
        d = prompt.settings.revision(paths.WBEDIT_DIR, n)
        if d is None:
            return jsonify({"error": "that prompt revision is missing or unreadable"}), 404
        return jsonify(d)

    @bp.post("/wbedit/prompt/rollback/<int:n>")
    @_locked_guard
    def wbedit_prompt_rollback(n):
        """Put an old prompt back — by minting a NEW revision equal to it.

        🔴 **HISTORY IS NEVER REWOUND, EXACTLY AS `DocumentStore.rollback` DOES IT.** Restoring
        revision 3 while sitting on 7 gives you 8, not 3 again. A restore that truncated would make
        recovering from a bad restore impossible, which turns the safety net into a second way to
        lose the thing.
        """
        if _RUN is not None and not _RUN.done:
            return jsonify({"error": "a pass is running — the prompt is frozen until it finishes",
                            "doc_id": _RUN.doc_id, "pass_id": _RUN.pass_id}), 409
        d = prompt.settings.revision(paths.WBEDIT_DIR, n)
        if d is None:
            return jsonify({"error": "that prompt revision is missing or unreadable"}), 404
        prompt.settings.save(paths.WBEDIT_DIR, d["system"], d.get("shots") or [],
                             d.get("wrapper") or "", note=f"restored from revision {n}")
        card = json.loads(vault_fs.read_text(CARD_PATH))
        return jsonify(prompt.settings.load(paths.WBEDIT_DIR, card))

    @bp.get("/wbedit/documents/<doc_id>/log/<int:n>")
    @_locked_guard
    def wbedit_document_log(doc_id, n):
        """Return the persisted model log for one document revision, including exchanges from
    passes that did not create a revision. This survives restarts and is separate from the
    in-memory log for a currently running pass.
    """
        self_docs = _docs()
        self_docs.get(doc_id)                # 404s on an unknown document rather than empty
        return jsonify({"revision": n, "rows": self_docs.read_log(doc_id, n)})

    @bp.post("/wbedit/pass/<doc_id>/<pass_id>/review-all")
    @_locked_guard
    def wbedit_review_all(doc_id, pass_id):
        b = request.get_json(silent=True) or {}
        review = str(b.get("review") or "")
        if review not in ("approved", "rejected", "pending"):
            return jsonify({"error": "bad review state"}), 400
        return jsonify({"moved": _passes().review_all(doc_id, pass_id, review)})

    @bp.post("/wbedit/pass/<doc_id>/<pass_id>/materialize")
    @_locked_guard
    def wbedit_materialize(doc_id, pass_id):
        """Accept the marked proposals and mint the next revision (§6.3.2's confirmation lands
        on this). Nothing is applied implicitly — this route is the only way a pass reaches a
        document."""
        p = _passes().get(doc_id, pass_id)
        props = _passes().proposals(doc_id, pass_id)
        rev = _docs().materialize(doc_id, p.revision, props, pass_id=pass_id)
        if rev is None:
            return jsonify({"error": "nothing was approved", "applied": 0}), 400
        applied = sum(1 for x in props if x.text is not None)
        return jsonify({**rev.to_dict(), "applied": applied}), 201

    @bp.post("/wbedit/pass/<doc_id>/<pass_id>/cancel")
    def wbedit_cancel(doc_id, pass_id):
        """Stop after the field in flight. It cannot interrupt one — the runner is a generator
        and we stop consuming it — so the worst case is one more model call. Everything already
        proposed stays on disk and stays reviewable; a canceled pass is a short pass, not a
        discarded one."""
        with _RUN_LOCK:
            run = _RUN
        if run is None or run.pass_id != pass_id:
            return jsonify({"error": "not running"}), 404
        run.cancel.set()
        return jsonify({"ok": True})

    @bp.get("/wbedit/pass/<doc_id>/<pass_id>/events")
    def wbedit_events(doc_id, pass_id):
        """The progress stream. 🔴 METADATA ONLY — see the module docstring."""
        with _RUN_LOCK:
            run = _RUN if (_RUN and _RUN.pass_id == pass_id) else _RECENT.get(pass_id)
        if run is None:
            abort(404)

        def stream():
            q: queue.Queue = queue.Queue()
            with run.lock:
                backlog = list(run.events)
                if not run.done:
                    run.subscribers.append(q)
            terminal = ("pass.finish", "error", "canceled")
            try:
                for ev in backlog:
                    yield f"data: {json.dumps(ev)}\n\n"
                    if ev.get("kind") in terminal:
                        return
                if run.done:
                    return
                # 🔴 A BOUNDED WAIT, BECAUSE `q.get()` WITH NO TIMEOUT TRUSTS THE PRODUCER
                # ABSOLUTELY. If `_run_pass` ever ends without emitting a
                # terminal event, this loop blocks forever: a pinned worker thread and a socket
                # that never closes, per subscribed tab. That was reachable via `VaultAuthError`
                # (fixed above), and the lesson generalizes — a reader must not depend on the
                # writer being flawless for its own liveness.
                #
                # ⚠️ THE TIMEOUT IS NOT AN ERROR AND MUST NOT LOOK LIKE ONE. A pass legitimately
                # goes minutes between events: one long field at IQ4_XS is 26 s, and over 100 s
                # when the model reasons to the token ceiling. So a tick sends an SSE COMMENT —
                # which the EventSource spec requires clients to ignore — and doubles as the
                # keepalive that stops an idle proxy dropping the connection.
                #
                # `run.done` is the escape: set in `_run_pass`'s `finally`, so it is true even on
                # the paths that emit nothing at all. One extra drain after it flips, because the
                # producer sets `done` and emits under separate locks.
                while True:
                    try:
                        ev = q.get(timeout=15.0)
                    except queue.Empty:
                        if run.done:
                            try:
                                ev = q.get_nowait()
                            except queue.Empty:
                                break
                        else:
                            yield ": keepalive\n\n"
                            continue
                    yield f"data: {json.dumps(ev)}\n\n"
                    if ev.get("kind") in terminal:
                        break
            finally:
                with run.lock:
                    if q in run.subscribers:
                        run.subscribers.remove(q)

        return Response(stream(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return bp


def _disposition(filename: str) -> str:
    """Build a safe RFC 6266 `Content-Disposition` value for a user-provided filename. Remove
    quote and CR/LF characters to prevent header injection, and include an ASCII `filename`
    plus UTF-8 `filename*` so non-ASCII names are preserved.
    """
    from urllib.parse import quote

    clean = "".join(c for c in filename if c.isprintable() and c not in '"\\/:*?<>|')
    clean = clean.strip() or "document"
    ascii_name = clean.encode("ascii", "replace").decode("ascii").replace("?", "_")
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(clean)}'


# ── the worker ───────────────────────────────────────────────────────────────

def _run_pass(run: _Run, engine: "llm_engine.Engine", jobs, instruction: str, sampler: dict,
              model: str,
              instruction_id: str, doc_name: str) -> None:
    """Consume the runner and persist every result. Runs on a worker thread.

    🔴 **THE PROPOSAL IS WRITTEN BEFORE THE EVENT IS EMITTED.** A browser that is told "row 34
    is ready" and then fetches row 34 must find it. The reverse order is a 404 that only ever
    reproduces under load, which is the worst kind.
    """
    global _RUN
    pstore = PassStore(paths.WBEDIT_DIR)
    docs = DocumentStore(paths.WBEDIT_DIR)
    doc_id, pass_id = run.doc_id, run.pass_id

    try:
        # `vault_fs.read_text` on an UNROUTED path is already a plain read — that is the whole
        # point of the seam — so the `Path.read_text` fallback this used to carry bought nothing
        # and cost a writer-census finding. One call, both arms.
        card = json.loads(vault_fs.read_text(CARD_PATH))
        # Use the saved prompt override when present. Resolve it once before the first model call so I10 keeps the instruction stable for the entire pass.
        # call: I10 freezes the instruction for the duration of a pass and the prompt is the same
        # argument, only stronger — a prefix that changed mid-run would silently make the second
        # half of the field list a different pass from the first.
        eff = prompt.settings.load(paths.WBEDIT_DIR, card)
        system, shots = eff["system"], eff["shots"]
        # Resolved ONCE, before the first call: a pass that materializes mid-flight would
        # otherwise start writing into the next version's log halfway down the field list.
        log_n = docs.log_revision(doc_id)
        # §6.4.1 — WHICH PROMPT RAN THIS PASS goes in the record, for the same reason the model
        # does (§3.1): a pass run under a tuned prompt is not the same pass, and six weeks later
        # the log is the only thing that can say which one it was.
        docs.append_log(doc_id, log_n, [{"pass_id": pass_id, "event": "pass.start",
                                         "instruction": instruction, "model": model,
                                         "engine": engine.id,
                                         "revision": log_n,
                                         "prompt": eff["fingerprint"]}])
        backend = ChatCompletions(engine.post,
                                  model=model, timeout=engine.timeout,
                                  on_exchange=lambda body, reply: run.log_exchange_persisted(
                                      docs, log_n, pass_id, body, reply))

        for ev in runner.run(jobs, instruction=instruction, backend=backend,
                             prompt=prompt.for_runner(system, shots, eff["wrapper"]),
                             sampler=sampler,
                             assistant_prefill=engine.id not in llm_engine.HOSTED):
            if ev.kind == runner.FIELD_RESULT:
                pstore.record(doc_id, pass_id, Proposal.from_event(ev))
            run.emit(ev.public())
            if ev.kind == runner.PASS_FINISH:
                pstore.finish(doc_id, pass_id, tally=ev.tally)
                if instruction_id:
                    try:
                        InstructionLibrary(paths.WBEDIT_DIR).record_run(
                            instruction_id, doc_id=doc_id, doc_name=doc_name, pass_id=pass_id,
                            tally=ev.tally)
                    except (OSError, ValueError, KeyError, RuntimeError):
                        # Bookkeeping. A pass that finished must not be reported as failed
                        # because the library entry it came from has since been deleted.
                        logger.warning("wbedit: could not attach the run to its instruction")
            if run.cancel.is_set() and ev.kind == runner.FIELD_RESULT:
                pstore.finish(doc_id, pass_id, status="canceled")
                run.emit({"kind": "canceled"})
                break
    # 🔴 `VaultAuthError` IS NAMED BECAUSE IT IS A `BaseException`.
    #
    # `VaultAuthError` is a `BaseException` so broad `except Exception` handlers cannot turn a
    # decrypt failure into "the file is empty" and trigger deletion or regeneration. Keep it out
    # of this handler.
    #
    # But it also meant a corrupt byte in this document's own `log/000N.jsonl` — exactly the
    # artifact the `part_path` fix exists to stop producing, so existing installs can already
    # hold one — sailed past this handler. `finally` still set `run.done`, so nothing looked
    # wrong from the outside, while `pstore.finish()` never ran and no terminal event was ever
    # emitted. A browser already subscribed then sat in `q.get()` forever, pinning a worker
    # thread and a socket, and the pass read `running` on disk until the next boot.
    #
    # ⚠️ CAUGHT HERE, RE-RAISED NOWHERE. This is a thread entry point — there is nothing above
    # it to catch anything — so the choice is between reporting it and losing it. Reported.
    except (Exception, *_as_tuple(vault_fs.auth_exc())) as exc:  # noqa: BLE001
        # 🔴 THE TYPE, NEVER THE MESSAGE (I16). An exception raised anywhere near a field can
        # carry that field in its text — `json.JSONDecodeError` quotes the document window it
        # failed on — and this string reaches the browser, the log and the Pass record.
        reason = type(exc).__name__
        if isinstance(exc, BackendRefused):
            # 11.1 — the one exception whose MESSAGE is shown: "OpenRouter rejected the API key
            # (HTTP 401)" is the whole point, and `BackendRefused` is composed by us from a status
            # code, never quoted from the provider (its own docstring), so I16 holds.
            reason = str(exc)
        logger.exception(f"wbedit: pass {pass_id} failed ({reason})")
        try:
            pstore.finish(doc_id, pass_id, status="failed", error=reason)
        except (OSError, ValueError, KeyError, RuntimeError, *_as_tuple(vault_fs.auth_exc())):
            pass        # the vault re-locked mid-pass, say. The emit below still reaches the UI.
        run.emit({"kind": "error", "reason": reason})
    finally:
        with run.lock:
            run.done = True
        with _RUN_LOCK:
            if _RUN is run:
                _RUN = None
