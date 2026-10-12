"""`/pair/*` is the bearer-token API used by the SillyTavern extension. The blueprint checks every request so new routes inherit the gate. Wildcard CORS is safe here because the bearer token, not `Origin`, authorizes access. The vault-unlocked gate runs before this blueprint, so a locked vault never reads the token."""
from __future__ import annotations

import queue

from flask import Blueprint, Response, jsonify, request
from loguru import logger

from wbedit import doorbell, formats, pairing, push, sweep
from wbedit.formats import png_card, st_write
from wbedit.store import AVATAR, DocumentStore, MissingDocument
from wbedit.store.models import KINDS
from vocalis.web.reqargs import BadArg, revision_arg

from vocalis.runtime import paths
from vocalis.runtime import st_extension_settings

#: The one prefix. `tests/test_pair_surface.py` asserts every rule under it is gated, so a route
#: added to this blueprint is covered automatically and a route added ELSEWHERE under `/pair/`
#: fails the surface test rather than quietly inheriting nothing.
PREFIX = "/pair"

#: Matches `web/wbedit.MAX_UPLOAD`. A worldbook is the biggest thing that comes through here and
#: Keep this limit below the extension server’s request-body limit while allowing large cards.
#: on their side stops a runaway push and this is the ceiling that does.
MAX_BODY = 8 * 1024 * 1024
MAX_NAME = 200

#: The kinds that HAVE a picture — derived from `KINDS` by subtraction rather than listed, so a
#: fifth kind is opted OUT deliberately instead of being forgotten into a 400. §8.3's persona was
#: forgotten exactly that way: the check was `kind != "card"`, and every persona avatar came back
#: "could not import picture" with nothing on the Vocalis side logging a refusal worth reading.
AVATAR_KINDS = frozenset(KINDS) - {"worldbook"}


def _avatar_is_current(store: DocumentStore, doc, incoming_ref: str) -> bool:
    """Report whether SillyTavern already holds the current avatar. A matching stamp is current; an unstamped legacy client may be treated as current for compatibility; a locally dirty avatar must not be overwritten. A missing or changed remote stamp requires a fetch."""
    if not store.has_asset(doc.id, AVATAR):
        return False
    if not incoming_ref or doc.avatar_dirty:
        return True
    return doc.avatar_ref == incoming_ref


def create_pair_blueprint() -> Blueprint:
    bp = Blueprint("vocalis_pair", __name__)

    @bp.before_request
    def _check_pairing():
        """Every request into this family, without exception.

        🔴 **RETURNS 401 FOR "no token configured" AS WELL AS "wrong token".** `pairing.verify`
        fails closed on an unpaired install; the two cases are deliberately indistinguishable
        from outside, because telling an unauthenticated caller *which* is wrong tells it whether
        the install is worth attacking.
        """
        if request.method == "OPTIONS":
            return None                 # the CORS preflight carries no Authorization header
        # 🔴 m5c — THE STREAM'S TOKEN IS IN THE QUERY STRING, BECAUSE `EventSource` CANNOT SET
        # HEADERS. There is no API for it — not `Authorization`, not `X-…`, nothing. The fork's
        # `EventSource` cannot set request headers, so this endpoint must accept the token in the query string.
        # have a workaround: the alternatives are a WebSocket (a whole second protocol for one
        # bit of information) or a cookie on the Vocalis origin (`withCredentials`, and a second
        # credential path nobody designed). The query string it is.
        #
        # ⚠️ SO THIS TOKEN IS URL-LOGGED WHEREVER URLS ARE LOGGED, and it is the same token the
        # header path uses — treat it as such when rotating.
        #
        # 🔴 BUT NOT BY US, AND THE 401 LINE BELOW IS WHY THAT HOLDS. It logs `request.path`,
        # which in Werkzeug is the path ALONE — the query string lives on `request.query_string`
        # and `request.full_path`. A rejected stream is exactly where a near-miss token would be
        # written to disk, so `full_path` here would be the bug this comment exists to prevent.
        # Pinned by `test_a_rejected_stream_never_logs_the_token`.
        if request.path == "/pair/stream":
            token = request.args.get("token", "")
            if pairing.verify(token.strip()):
                return None
            logger.info(f"pair: 401 {request.method} {request.path} from {request.remote_addr}")
            return jsonify({"error": "pairing required", "paired": False}), 401
        header = request.headers.get("Authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not pairing.verify(token.strip()):
            # 🔴 THE PATH ONLY — never the header, never the body. A rejected request is exactly
            # where a near-miss token would get written to disk, and the fork's own `b7350db26`
            # is the record of an error message quoting user content into a response.
            logger.info(f"pair: 401 {request.method} {request.path} from {request.remote_addr}")
            return jsonify({"error": "pairing required", "paired": False}), 401
        return None

    @bp.get("/pair/ping")
    def pair_ping():
        """The extension's "am I paired?" check — and the only thing it can do before m3.

        It deliberately returns nothing about the install beyond the fact that the token was
        accepted. A version string or a document count here would be a free reconnaissance
        surface for anyone holding a token they should not have.
        """
        return jsonify({"paired": True})

    @bp.get("/pair/extension-settings")
    def pair_extension_settings():
        """Return the current extension settings to a bearer-authenticated SillyTavern tab.

        The response is intentionally not cacheable: it contains the configured prompt, and the
        paired client must refresh the one current snapshot after a content-free doorbell.
        """
        response = jsonify(st_extension_settings.load_settings())
        response.headers["Cache-Control"] = "no-store"
        return response

    @bp.get("/pair/poll")
    def pair_poll():
        """Serve the extension heartbeat and claim at most one queued job. Polling also reports whether a SillyTavern tab is connected. Sweep and send claims are globally exclusive across tabs, and the response carries job metadata rather than document content."""
        # 🔴 9.5.17 — WHICH COPY OF THE EXTENSION IS ACTUALLY RUNNING. The file under SillyTavern
        # is a hand-copied DIRECTORY, not a checkout, and a long-lived tab keeps whatever JS it
        # loaded however many times that file changes. Include a build stamp to identify stale extension copies.



        #
        # ⚠️ A VERSION STRING, ON THE ONE MESSAGE THAT ALWAYS ARRIVES. It is not a document and not
        # a name, so the rule about this heartbeat never carrying content is untouched. An older
        # extension simply omits it and records "" — refusing the poll over a missing build stamp
        # would break precisely the stale client this exists to diagnose.
        #
        # 🔴 9.7.3 — AND `self` IS THE TAB'S OWN VERDICT ON WHETHER IT IS CURRENT. Vocalis used to
        # answer that by hashing `sillytavern/extension/` in its own repo, which is not the copy
        # SillyTavern serves; the tab checks against the file it was actually loaded from. Clamped
        # to the three words it may be, so a client cannot put prose in the pane.
        reported = str(request.args.get("self") or "").strip().lower()
        sweep.note_poll(str(request.args.get("build") or "")[:32],
                        reported if reported in ("current", "stale", "unknown") else "")
        claimed = sweep.claim()
        # 🔴 NEVER BOTH IN ONE ANSWER. A sweep is the whole install and runs for minutes; a send
        # claimed alongside it would sit unstarted and age out on `push.STALE_RUN_S` while the
        # extension was still importing and a send appeared to fail even though no write had
        # gone wrong. Leaving it pending costs one poll, which is five seconds.
        #
        # 🔴 AND "NEVER BOTH" MEANS GLOBALLY, NOT PER REQUEST (B.7). `claimed` only knows about
        # THIS answer, so with two tabs polling — one browser with the settings drawer open twice,
        # or a phone and a desktop — tab A took the sweep and tab B took a send on its own next
        # poll, and the two ran concurrently. That is not merely untidy: the sweep IMPORTS every
        # card while the send does a `merge-attributes` read-modify-write on one of them, so the
        # overlap can lose a document update — the harm `push.claim()` exists to
        # prevent, reached by adding a second tab.
        #
        # ⚠️ THE EXTENSION'S OWN LEASE IS NOT THIS GUARD. B.7's client fix uses `localStorage`,
        # which is per browser profile; a second browser or a second device shares none of it.
        # The server is the only place that sees every tab, so the authoritative answer is here.
        #
        # ⚠️ Ordered `sweep` first deliberately: a sweep is the whole install and a send is one
        # document, so letting the big job through and re-offering the small one on the next poll
        # costs five seconds, while the reverse could starve a sweep behind a queue of sends.
        # ⚠️ `running` is a BOOL here (`sweep.status`), not the dict `push.status` returns under
        # the same key. `is not None` would be true for `False` and would strand every send.
        busy = claimed or bool(sweep.status()["running"])
        job = None if busy else push.claim()
        # 🔴 THE JOB, NOT THE DOCUMENT. `push` carries an id, a revision, a kind and a Library
        # name — our own record of our own store. The content is fetched over the route below, so
        # a poll that goes into a proxy log or a devtools pane never carries document content.
        return jsonify({"sweep": claimed, "push": job})

    @bp.get("/pair/stream")
    def pair_stream():
        """Hold an event stream that wakes hidden extension tabs without carrying work. Frames stay an empty `event: work`; `/pair/poll` performs the single-winner claim, so broadcast events cannot duplicate a send. The query token is required because `EventSource` cannot set headers, and rejected-stream logging must use the path without its query string."""
        sub = doorbell.subscribe()
        if sub is None:
            # ⚠️ 503, AND THE CLIENT IS NOT BROKEN. It falls back to polling, which is precisely
            # why that path is being kept (§9a.25). Saying so plainly beats a stream that connects
            # and never fires.
            return jsonify({"error": "too many streams", "max": doorbell.MAX_STREAMS}), 503
        sid, q = sub

        def frames():
            try:
                # `retry:` is the client's automatic reconnect interval, and it is in the SSE spec
                # rather than a library feature — so a tab that freezes under memory pressure and
                # thaws reconnects by itself. That is the difference from the poll: transient and
                # self-healing rather than permanent and silent.
                yield "retry: 3000\n\n"
                yield "event: hello\ndata: {}\n\n"
                while True:
                    try:
                        q.get(timeout=doorbell.KEEPALIVE_S)
                        yield "event: work\ndata: {}\n\n"
                    except queue.Empty:
                        # ⚠️ `queue.Empty` BY NAME, never `except Exception`. A broad clause here
                        # would turn any real fault inside the loop into a silent keepalive, and
                        # the stream would sit there looking healthy while delivering nothing —
                        # the exact "cheerful success that quietly drops the work" failure this
                        # whole design keeps circling.
                        #
                        # 🔴 THIS WRITE IS HOW A CLOSED TAB IS DISCOVERED. A generator blocked in
                        # `get()` never learns the browser went away, because it is not writing.
                        # The keepalive is the write that raises when the socket is gone, unwinds
                        # this generator, and runs the `finally` — without it every closed tab
                        # leaks a server thread and `count()` stays permanently wrong.
                        yield ": keepalive\n\n"
            finally:
                # Runs on client disconnect, on a raised write, and on shutdown. `count()` is what
                # tells the Library a tab is listening, so a missed unsubscribe makes Vocalis
                # confidently wrong about the one thing this channel exists to know.
                doorbell.unsubscribe(sid)

        return Response(frames(), mimetype="text/event-stream", headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        })

    @bp.post("/pair/sweep")
    def pair_sweep_done():
        """The extension reporting what a claimed sweep managed. Ends the run either way.

        ⚠️ **A FAILED SWEEP MUST REPORT TOO.** If only success posted here, a sweep that died
        halfway would leave the Library saying "importing…" until `STALE_RUN_S` — five minutes of
        a spinner over something that already stopped.
        """
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            body = {}

        def _n(k):
            try:
                return max(0, int(body.get(k) or 0))
            except (TypeError, ValueError):
                return 0

        # 🔴 THE ERRORS ARE COUNTED AND THEIR SUBJECTS NAMED, BUT NO MESSAGE IS TAKEN VERBATIM.
        # These strings render into the Vocalis UI, and a fetch failure on the SillyTavern side can
        # carry a slice of a lorebook in its message — their own `b7350db26` was exactly that. A
        # document NAME is already in the Library; a parser's error text is not.
        errors = body.get("errors")
        names = [str(e)[:MAX_NAME] for e in errors[:20]] if isinstance(errors, list) else []
        # 🔴 EVERY KIND THE EXTENSION COUNTS HAS TO BE CARRIED, OR IT READS AS "NOTHING ARRIVED".
        # §8.3 personas were the third kind, and the extension has incremented `tally.personas`
        # since the read side landed. Dropping the key here is silent: the sweep genuinely worked,
        # the documents are in the store, and the Library says "nothing to import" — which is
        # exactly the "silently did not arrive" failure the UI's own message code warns about. A
        # fourth kind must be added in BOTH places, and there is a test that fails if it is not.
        sweep.finish({"books": _n("books"), "cards": _n("cards"), "personas": _n("personas"),
                      "unchanged": _n("unchanged"), "failed": names})
        logger.info(f"pair: sweep done — {_n('books')} books, {_n('cards')} cards, "
                    f"{_n('personas')} personas, {len(names)} failed")
        return jsonify({"ok": True})

    @bp.post("/pair/documents")
    def pair_import():
        """Import a SillyTavern worldbook or character card. A new `st_ref` creates a Library row (201); a repeated reference updates that row (200). Detect document kind from its contents, require a stable `st_ref`, and keep dismissed-document policy on the server."""
        # 🔴 `cache=True` IS LOAD-BEARING — `cache=False` CONSUMES THE STREAM AND `get_json()`
        # BELOW THEN SEES AN EMPTY BODY, turning every valid push into "no document". The cap
        # still answers 413 correctly in that state, so the route looks like it works right up
        # until something legitimate arrives.
        if (request.content_length or 0) > MAX_BODY:
            return jsonify({"error": "document too large"}), 413      # declared: never read it
        if len(request.get_data(cache=True)) > MAX_BODY:
            return jsonify({"error": "document too large"}), 413      # chunked: no length to trust
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            return jsonify({"error": "expected a JSON object"}), 400

        doc = body.get("document")
        if not isinstance(doc, (dict, list)):
            # A list IS a valid worldbook — a pre-compile section chunk file (`formats/worldbook`
            # reads both shapes), so this cannot be a bare `isinstance(doc, dict)`.
            return jsonify({"error": "no document"}), 400

        st_ref = str(body.get("st_ref") or "").strip()
        if not st_ref:
            return jsonify({"error": "st_ref is required"}), 400
        # 7.3.9 — SillyTavern's stamp for the picture as it stands over there RIGHT NOW. Optional:
        # an older extension sends none and gets the old has-a-picture answer, which is why this
        # change needs no coordinated deploy.
        avatar_ref = str(body.get("avatar_ref") or "").strip()[:MAX_NAME]

        try:
            kind = formats.detect.doc_kind(doc)
        except (AttributeError, TypeError, KeyError):
            # NARROW ON PURPOSE, and copied from the upload route deliberately: `doc_kind` only
            # walks keys, so a wrongly-shaped document raises one of these and nothing else. A
            # blind handler would swallow a bug in the detector and report it as a problem with
            # user document.
            kind = ""
        if kind not in KINDS:
            return jsonify({"error": "not a character card or worldbook"}), 400

        name = formats.detect.display_name(doc, kind, st_ref)[:MAX_NAME]
        focus = png_card.focus_rect(doc) if kind == "card" else {}
        world_ref = png_card.world_name(doc) if kind == "card" else ""

        store = DocumentStore(paths.WBEDIT_DIR)
        # 🔴 §8.2b — DECLINED HERE, NOT IN THE EXTENSION. The button's contract is that one press
        # sends everything (§8.2a); teaching the extension which documents to withhold would move
        # a Vocalis decision into a page we do not control and give the two sides a list to
        # disagree about. The sweep still offers every document and this end says no.
        #
        # 200, not an error: from the extension's side this is a successful, complete push. It
        # counts the document as unchanged and moves on.
        if store.is_dismissed(st_ref):
            logger.info(f"pair: import declined, {kind} dismissed")
            return jsonify({"id": "", "kind": kind, "created": False, "revision": -1,
                            "avatar": True, "dismissed": True}), 200
        document, created = store.import_from_st(doc, kind=kind, st_ref=st_ref, name=name,
                                                 focus=focus, world_ref=world_ref)
        # 🔴 The id and the counters — never the name, and never any of the content. This response
        # goes back across the origin boundary to a page we do not control, and I16's line is
        # not about which client initiated the request.
        # WHICH row it landed on and whether it made one; document content need not be returned.
        logger.info(f"pair: import {kind} {'created' if created else 'revised'} "
                    f"{document.id}@{document.latest}")
        # 🔴 `avatar` EXISTS SO A FAILED PICTURE UPLOAD CAN BE RETRIED (item 12). The extension
        # only fetched the PNG when `created` was true — a deliberate cost decision, since a card
        # is ~700 KB at p50 and re-sending every picture on every press is minutes of transfer for
        # nothing. But it meant a card whose avatar upload failed ONCE never got another attempt:
        # every later press sees `created: false` and skips it, permanently, with no way back
        # short of deleting the row. This boolean lets the extension ask for the picture again
        # exactly when it is missing and never otherwise.
        #
        # ⚠️ It leaks no document content: this reports a fact about our store, like the
        # class of answer as `revision`, which already crosses this boundary.
        return jsonify({"id": document.id, "kind": document.kind, "created": created,
                        "revision": document.latest,
                        "avatar": _avatar_is_current(store, document, avatar_ref),
                        # 7.3.9 — "our copy is AHEAD of yours". The persona sweep has no stamp to
                        # compare (nothing in SillyTavern's persona settings moves when the PNG is
                        # replaced), so it refreshes the picture every press and needs this to know
                        # the one case where it must not: a picture uploaded here and queued to
                        # go the other way. Same class of answer as `revision` — a fact about our
                        # store, never the user's document content.
                        "avatar_dirty": document.avatar_dirty,
                        }), (201 if created else 200)

    @bp.post("/pair/documents/<doc_id>/avatar")
    def pair_avatar(doc_id):
        """Accept the raw `image/png` body for an imported character card and store it verbatim. Validate only the PNG signature; decoding or re-encoding could flatten animation or remove generation metadata."""
        if (request.content_length or 0) > MAX_BODY:
            return jsonify({"error": "image too large"}), 413
        blob = request.get_data(cache=False)
        if len(blob) > MAX_BODY:
            return jsonify({"error": "image too large"}), 413
        # The PNG signature, and that is the whole validation. Cards are always PNG (§4.3), and
        # the point is to refuse a JSON error page or an HTML login redirect that some proxy
        # handed back — not to have an opinion about the pixels.
        if not blob.startswith(b"\x89PNG\r\n\x1a\n"):
            return jsonify({"error": "not a PNG"}), 400

        store = DocumentStore(paths.WBEDIT_DIR)
        try:
            doc = store.get(doc_id)
        except MissingDocument:
            return jsonify({"error": "not found"}), 404
        if doc.kind not in AVATAR_KINDS:
            return jsonify({"error": "a worldbook has no picture"}), 400

        # 🔴 7.3.9 — THE STAMP RIDES IN A HEADER BECAUSE THE BODY IS THE PICTURE. It is what
        # `pair_import` compares next time to answer "do I have the CURRENT one?"; without it
        # stored here, the sweep that just fetched 700 KB would fetch them again on every press
        # for ever. Capped like every other string that crosses this boundary.
        ref = str(request.headers.get("X-Vocalis-Avatar-Ref") or "")[:MAX_NAME]
        # `dirty=False`: these bytes came FROM SillyTavern, so their copy is not behind ours.
        # Routed through `put_avatar` rather than `put_asset` so the replaced face's cached crops
        # are swept — the one thing this path was missing while it could only ever write a picture
        # into an empty slot.
        store.put_avatar(doc.id, blob, ref=ref, dirty=False)
        logger.info(f"pair: avatar {doc.id} ({len(blob)} bytes)")
        return jsonify({"id": doc.id, "bytes": len(blob)}), 201

    # ── m3: send back to SillyTavern ─────────────────────────────────────────
    # Outbound sync runs from the Editor: its job is held here, claimed by the extension,
    # the Editor; `wbedit/push` holds the job; the extension collects it from `/pair/poll` above,
    # fetches the plan here, writes it, and posts the outcome to `/pair/push`.

    @bp.get("/pair/plan/<doc_id>")
    def pair_plan(doc_id):
        """Build the outbound write plan in Vocalis. The plan owns endpoint selection and field allowlists, and never sends a mirrored `character_book`. This authenticated route carries document content; poll and status routes carry only job metadata. Use the revision named by the job, not the latest revision."""
        store = DocumentStore(paths.WBEDIT_DIR)
        try:
            # 🔴 A.3 — AND THIS IS THE ONE THE EXTENSION ACTUALLY READS. The docstring directly
            # above says the revision is "the one the job named, never the latest"; werkzeug's
            # `type=int` returns `None` for an unparseable value exactly as it does for an absent
            # one, and `store.revision(doc_id, None)` reads `None` as latest — so the rule the
            # docstring states was defeated by any mangled value, on the path that WRITES into
            # the SillyTavern installation.
            #
            # ⚠️ Handled locally rather than by an errorhandler: this blueprint deliberately has
            # none (§8's separation), and `revision_arg` raising into a bare 500 here would be a
            # worse answer than the silent latest it replaces.
            n = revision_arg()
            doc = store.get(doc_id)
            rev = store.revision(doc_id, n)
        except BadArg as exc:
            return jsonify({"error": str(exc)}), 400
        except MissingDocument:
            return jsonify({"error": "not found"}), 404

        try:
            # 🔴 `store.outbound` IS THE ONE DEFINITION of what metadata owes a card on the way
            # out — the world name and the avatar focus rect. Export calls the same method, so a
            # send and a download cannot disagree about what the card says.
            # ⚠️ TWO DIFFERENT QUESTIONS ABOUT THE PICTURE, AND §9a.33 NEEDS BOTH. `avatar` is
            # "ours has diverged from theirs" and drives the `/edit-avatar` step of a merge;
            # `has_avatar` is "we have one at all", which is what a CREATE has to ask, because
            # their importer writes a gray placeholder and `avatar_dirty` is false on a card
            # nobody has edited the picture of since it arrived.
            # 🔴 9.7.3 — `world` IS PART OF "THE SAME ARGUMENTS", AND THIS IS THE COPY THAT
            # SHIPS. `/wbedit/st-push` builds the plan to refuse on the press; the extension
            # executes THIS one. A `world=` on one and not the other is the seam defect the
            # `has_avatar` note on that route describes, with a consequence: the pane would say
            # the link travels and the write would leave it behind.
            plan = st_write.plan(doc, store.outbound(doc, rev.content), st_ref=doc.st_ref,
                                 name=doc.name,
                                 avatar=doc.avatar_dirty and store.has_asset(doc.id, AVATAR),
                                 has_avatar=store.has_asset(doc.id, AVATAR),
                                 world=store.world_out(doc))
        except st_write.Unsendable as exc:
            # 400 with OUR sentence. `Unsendable` never quotes content — see its docstring — and
            # this string is rendered straight into the Vocalis status line.
            return jsonify({"error": str(exc)}), 400

        logger.info(f"pair: plan {doc.kind} {doc.id}@{rev.n} "
                    f"({len(plan['dropped'])} dropped)")
        return jsonify({**plan, "id": doc.id, "revision": rev.n})

    @bp.get("/pair/avatar/<doc_id>")
    def pair_avatar_out(doc_id):
        """Return the stored avatar bytes for an outbound plan without decoding or re-encoding them. Preserve the original PNG payload."""
        store = DocumentStore(paths.WBEDIT_DIR)
        try:
            doc = store.get(doc_id)
            blob = store.asset(doc.id, AVATAR)
        except MissingDocument:
            return jsonify({"error": "not found"}), 404
        logger.info(f"pair: avatar out {doc.id} ({len(blob)} bytes)")
        resp = Response(blob, mimetype="image/png")
        # User content on its way out of an encrypted store: no intermediary keeps a copy.
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.post("/pair/push")
    def pair_push_done():
        """Record the extension's send result and settle the queued run on both success and failure. Reporting failures lets the Editor recover instead of leaving a send permanently in progress."""
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            body = {}
        ok = body.get("ok") is True
        reason = str(body.get("reason") or "")[:MAX_NAME]
        doc_id = str(body.get("id") or "")[:64]
        # 🔴 ONLY A SUCCESS CLEARS THE FLAG (m4o). A failed send leaves `avatar_dirty` set so the
        # next attempt still carries the picture; clearing it on the attempt would silently drop
        # the new image and leave SillyTavern showing the old face forever.
        #
        # 🔴 AND ONLY A SUCCESS *THAT ENDED A RUN WE WERE ACTUALLY WAITING FOR*. This used to run
        # BEFORE `finish` and never learn its verdict — so A.4's guard stopped an unclaimed report
        # being FILED while this line went on changing the store anyway. A token holder POSTing
        # `{"ok": true, "avatar": true, "id": …}` with nothing in flight cleared `avatar_dirty` on
        # a real document; the status routes all stayed honest, and the only symptom was that
        # a later send omitted the changed picture, leaving SillyTavern with a stale copy.
        # face. Silent, in document data, and reachable from this route alone.
        #
        # ⚠️ THE ORDER IS NOW LOAD-BEARING: `finish` first, the store write second, gated on its
        # answer. Do not move the write back above it "so the flag is clear before we report".
        ended = push.finish(
            {"ok": ok, "reason": "" if ok else (reason or "the write did not go through"),
             "id": doc_id,
             "revision": body.get("revision") if isinstance(body.get("revision"), int)
             else None,
             "created": body.get("created") is True,
             "reloaded": body.get("reloaded") is True,
             # The display name of what was actually written, so the pane's line can name it.
             # A NAME, never a descriptor: capped like every other name on this route, and it is
             # already in the Library view that initiated the send.
             "wrote": str(body.get("wrote") or "")[:MAX_NAME],
             "avatar": body.get("avatar") is True})
        if ended and ok and body.get("avatar") is True and doc_id:
            DocumentStore(paths.WBEDIT_DIR).clear_avatar_dirty(doc_id)
        # 🔴 §9a.33 — THE KEY SILLYTAVERN JUST FILED IT UNDER, AND MISSING IT COSTS A DUPLICATE.
        # A create answers with the avatar filename their importer chose (`getPngName` disambiguates
        # a name collision, so it is NOT predictable from our side). Recording it turns every later
        # send of this document into an ordinary merge; dropping it means the next Save creates a
        # SECOND character and silently abandons the first. Gated on `ended` for A.4's reason —
        # an unclaimed report must not write into the store.
        #
        # 🔴 AND IT IS **NOT** GATED ON `ok`. `createCard` answers
        # `{ok: false, reason: "picture", created: true, ref}` for a character that DID land and
        # whose image did not — the send failed after creating the character, so the user may retry it.
        # to "the picture did not go through" is to press Save again. Requiring `ok` there is
        # precisely how that retry becomes a second character. A `ref` is only ever present because
        # SillyTavern answered with a filename it wrote, so recording it is a fact either way.
        ref = str(body.get("ref") or "")[:MAX_NAME]
        if ended and ref and doc_id:
            DocumentStore(paths.WBEDIT_DIR).adopt_st_ref(doc_id, ref)
        logger.info(f"pair: push done — {'ok' if ok else 'failed'}")
        return jsonify({"ok": True})

    return bp
