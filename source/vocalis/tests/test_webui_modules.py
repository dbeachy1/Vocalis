"""`/webui/js/<path>` serves the ES module tree; the app does not expose a general static directory.
The route rejects traversal after resolving the requested path, so `..` segments and symlinks are
checked against the module root before a file is served.
"""
import re
from pathlib import Path
from unittest import mock

import pytest

import vocalis_server as vs
from vocalis.runtime import paths


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as c:
        yield c


def test_a_module_is_served_as_javascript(client):
    r = client.get("/webui/js/util/dom.js")
    assert r.status_code == 200, r.data[:200]
    # 🔴 Not decoration: a <script type="module"> is REFUSED on a wrong Content-Type, where a
    # classic <script src> would have run anyway. Getting this wrong breaks every module at once
    # and looks like the import failing.
    assert "javascript" in r.headers["Content-Type"], r.headers["Content-Type"]
    assert b"export const $" in r.data


def test_nested_modules_are_reachable(client):
    """The tree is `js/util/…` and `js/ui/…`, so a one-level route would not have been enough."""
    assert client.get("/webui/js/ui/modal.js").status_code == 200


def test_modules_are_revalidated_never_served_blind(client):
    """Verify module responses are revalidated on every use without downloading unchanged bytes.

    The test exercises both the initial response and a conditional request: `no-cache` must be paired
    with an `ETag`, and a matching validator must produce a bodyless 304. Version query strings on the
    entry module do not propagate to relative imports, so each module request needs its own freshness
    check.
    """
    r = client.get("/webui/js/util/dom.js")
    assert r.headers.get("Cache-Control") == "no-cache", dict(r.headers)
    etag = r.headers.get("ETag")
    assert etag, f"no ETag, so `no-cache` costs a full re-download every load: {dict(r.headers)}"

    # A current validator: 304, no body. That bodiless answer IS the saving.
    fresh = client.get("/webui/js/util/dom.js", headers={"If-None-Match": etag})
    assert fresh.status_code == 304, f"expected 304 for a current ETag, got {fresh.status_code}"
    assert not fresh.data, f"a 304 must carry no body, got {len(fresh.data)} bytes"

    # A stale one: the browser gets the new bytes, never a nod to reuse yesterday's.
    stale = client.get("/webui/js/util/dom.js", headers={"If-None-Match": '"deployed-yesterday"'})
    assert stale.status_code == 200, f"a stale ETag must re-serve, got {stale.status_code}"
    assert b"export const $" in stale.data


@pytest.mark.parametrize("attack", [
    "../../../../etc/passwd",
    "../../vocalis_server.py",
    "..%2f..%2fvocalis_server.py",
    "ui/../../../tts_utils.py",
    "/etc/passwd",
])
def test_traversal_is_refused(client, attack):
    """Every one of these resolves outside `src/webui/js`, and none may be served.

    ⚠️ Asserting on the STATUS is not enough on its own — a 200 whose body is a stack trace would
    also be a leak — so the body is checked for the thing each target would contain.

    ⚠️ `follow_redirects=True` because the answer is not always a direct 404: `/webui/js//etc/passwd`
    has a double slash, and Werkzeug answers a 308 to the normalized path before the route is ever
    reached. That is not a leak, but asserting `== 404` on the first hop would have called it one —
    and, worse, a test that accepted a bare 308 would pass without ever learning where it went. What
    matters is where the redirect LANDS."""
    r = client.get(f"/webui/js/{attack}", follow_redirects=True)
    assert r.status_code == 404, (attack, r.status_code)
    assert b"root:" not in r.data and b"VERSION" not in r.data


def test_only_js_is_served(client, tmp_path, monkeypatch):
    """🔴 The extension check is what keeps "this directory holds only modules" true by
    construction, rather than true because nobody has put anything else there yet. Proven against a
    real non-.js file rather than an absent one, so a 404 cannot pass for the wrong reason."""
    root = tmp_path / "webui"
    (root / "js").mkdir(parents=True)
    (root / "js" / "secret.txt").write_text("not a module", encoding="utf-8")
    (root / "js" / "real.js").write_text("export const a = 1;\n", encoding="utf-8")
    monkeypatch.setattr(paths, "WEBUI", root)

    assert client.get("/webui/js/real.js").status_code == 200, "the fixture root is not wired"
    assert client.get("/webui/js/secret.txt").status_code == 404


def test_a_missing_module_is_404_not_500(client):
    assert client.get("/webui/js/ui/nope.js").status_code == 404


def test_a_directory_is_not_served(client):
    """`is_file()` matters: `send_file` on a directory raises, which would be a 500."""
    assert client.get("/webui/js/ui").status_code in (404, 308)


def _inline_app_script() -> str:
    """The page's own <script>, chosen the way the smoke specs now do it — the LONGEST inline
    block, never the last. 7.1 added `<script type="module">` tags that sit after it."""
    import re
    html = (Path(paths.WEBUI) / "index.html").read_text(encoding="utf-8")
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", html)
    return max(blocks, key=len)


# ✅ `esc` LEFT THIS LIST IN 7.3-m8c — the `wbEl` ending for the second time. Its only parse-time
# caller was the `vcInitLang` IIFE, m8b moved that into js/voices/voices.js, and with no parse-time
# reader left the inline copy had nothing to serve: js/util/dom.js is the single definition now and
# the shim publishes it for the 210 inline callers. 🔴 THE DELETION IS WHY THE DRIFT TEST GOES WITH
# IT — for `esc` the drift was a live injection hole (see the docstring), and a drift test over one
# copy is a test that cannot fail.
# ✅ AND `AUDITION_TEXT` LEFT IT IN 7.3-m12c, ON THE CONDITION ITS OWN ROW WROTE DOWN AT m3:
# *"delete the inline copy when the `pgText` restore moves (m12), and drop this row in the same
# commit."* The restore is `$('pgText').value=UIS.getItem('vocalis-pg-text')||AUDITION_TEXT`, and it
# went to js/pg/playground.js — the module that owns that box — where `AUDITION_TEXT` is an ordinary
# import from js/ui/audition.js. One copy, so there is nothing left for a drift test to compare.
# 📌 THAT IS TWO DUPLICATES RETIRED BY THEIR OWN STATED CONDITION (esc at m8c, this at m12c) AND
# ZERO retired by someone noticing. A duplicate created without a removal condition is the one that
# outlives the reason for it — which is what §3.1a's "duplicate or move the caller" costs if the
# first half is taken without writing down when it ends.

def _js_function_source(text: str, name: str) -> str | None:
    """The source of `async function <name>(…){…}`, from the keyword to its balanced `}`.

    ⚠️ A REGEX CANNOT DO THIS and the near-miss is worse than the miss. `$` and `esc` are one-liners
    ending in `;`, so `test_the_duplicated_helpers_have_not_drifted` can match them with a pattern.
    These four are multi-line bodies full of `{}` — `.*?}` stops at the FIRST brace (inside
    `fetch(u,{method:'POST'…})`) and would compare two truncated prefixes that agree perfectly while
    the error-handling tail below them has drifted. So: count braces, and skip the ones that are not
    code. Quote tracking is not decoration either — a `{` inside a future string literal would
    unbalance the count and silently return the rest of the file.
    """
    m = re.search(r"^(?:export\s+)?async\s+function\s+%s\s*\(" % re.escape(name), text, re.M)
    if not m:
        return None
    # The signature is INCLUDED — the parameter list is part of what must not drift, and starting at
    # the brace would compare two bodies while `jpost(u,b)` quietly became `jpost(b,u)`.
    start = m.start()
    i, depth, quote = text.index("{", m.end() - 1), 0, None
    while i < len(text):
        c = text[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
        elif c == "/" and text[i + 1:i + 2] == "/":
            i = text.find("\n", i)
            if i < 0:
                break
            continue
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    return None


def _strip_js_comments(src: str) -> str:
    """Whole-line `//` comments only.

    ⚠️ Deliberately NOT trailing comments: stripping from the first `//` on a line would cut a
    literal like `'http://…'` in half and turn a passing comparison into a confusing one. Whole-line
    is enough — the only comment inside these four bodies is the `// PREFER message` block, and
    comparing prose is what we want to avoid anyway. Reflowing a comment in one copy must not go red;
    changing a character of CODE in one copy must.
    """
    return "\n".join(ln for ln in src.splitlines() if not ln.strip().startswith("//"))



def test_the_brace_scanner_stops_at_the_right_brace():
    """⚠️ THE TEST ABOVE IS ONLY WORTH ITS RUNTIME IF THE EXTRACTOR IS RIGHT, and a broken one fails
    SILENTLY GREEN — two truncated prefixes agree, and the drifted tails are never compared. So the
    scanner is checked against the three things that could truncate it: a nested object literal, a
    brace inside a string, and a brace inside a comment."""
    src = (
        "async function f(u){const o={a:{b:1}};\n"
        "  // a } in a comment\n"
        "  const s='}';\n"
        "  return o;}\n"
        "async function g(){return 2;}\n"
    )
    got = _js_function_source(src, "f")
    assert got is not None and got.startswith("async function f(u){"), got
    assert got.endswith("return o;}"), got
    assert "function g" not in got
    assert _js_function_source(src, "g") == "async function g(){return 2;}"
    assert _js_function_source(src, "nope") is None


#: `on<event>="…"` attributes whose body names no function of ours, and so cannot be broken by a
#: function moving into a module. Each needs a reason — adding to this list is a decision, not a
#: reflex, and a genuinely unsafe handler must never be silenced by appending it here.
_INLINE_HANDLERS_THAT_NAME_NOTHING = {
    'onclick="this.select()"': "a DOM method on the element itself — resolves no global",
}

#: `on<event>=` written inside a STRING in JS source is how these get into the page, so the scan has
#: to read source rather than rendered HTML.
_INLINE_HANDLER = re.compile(r"""on(?:load|error|click|change|input|blur|focus|keydown|keyup|"""
                             r"""submit|mouseover|mouseout|ended|play|pause)\s*=\s*["'][^"']*["']""")


def _handler_hits(src: str) -> list[tuple[int, str]]:
    """`(line number, attribute)` for every inline handler, skipping whole-line `//` comments.

    ⚠️ IT SKIPS RATHER THAN STRIPS, AND THAT IS THE POINT. The obvious version reuses
    `_strip_js_comments`, which *removes* comment lines — so `enumerate` over the result counts
    lines in a file nobody has, and every number in the failure message is short by however many
    comments preceded it. Caught by a page-sabotage check: the real handler is at
    `index.html:10603` and the assertion said 8161. A failure message that sends the reader to the
    wrong line is worse than one that gives no line at all, because it looks authoritative.

    📌 Whole-line only, same rule as `_strip_js_comments` and for the same reason — `say.js` quotes
    the old `onclick="…"` pattern in prose deliberately, and that must not count.
    """
    return [(n, hit)
            for n, line in enumerate(src.split("\n"), start=1)
            if not line.strip().startswith("//")
            for hit in _INLINE_HANDLER.findall(line)]


def test_no_inline_event_attribute_resolves_a_function_from_a_string():
    """Inline handlers that resolve module functions by name fail silently after extraction.

    Scan the page and every module for handlers that name functions. Use delegated listeners instead;
    `load` and `error` do not bubble, so their delegation must use the capture phase.
    """
    srcs = {"index.html": (Path(paths.WEBUI) / "index.html").read_text(encoding="utf-8")}
    for p in sorted((Path(paths.WEBUI) / "js").rglob("*.js")):
        srcs[f"js/{p.relative_to(Path(paths.WEBUI) / 'js').as_posix()}"] = p.read_text(encoding="utf-8")

    bad = [f"{name}:{line_no}  {hit}"
           for name, src in srcs.items()
           for line_no, hit in _handler_hits(src)
           if hit.replace("'", '"') not in _INLINE_HANDLERS_THAT_NAME_NOTHING]

    assert not bad, (
        "an inline event attribute resolves a function name from a string. Module scope makes that "
        "lookup find nothing, and the failure is silent — the element renders and the handler never "
        "runs. Use a delegated listener instead (and remember `load`/`error` need the CAPTURING "
        "phase, because they do not bubble). See DESIGN_7_1_FRONTEND_REFACTOR.md §5.2 item 5.\n  "
        + "\n  ".join(bad))


def test_the_inline_handler_scan_actually_sees_one():
    """⚠️ The test above passes on a page with no handlers at all, which is also what a broken regex
    looks like. So the scanner is shown one of each shape it must catch — including the two that
    were missed — and the exemption is shown to be exact rather than a substring."""
    src = ('<div>\n'
           '// it was onclick="wbHush(k)" once\n'
           """<img onload="wbFitFace(this)" onerror='wbFaceFallback(this)'>\n"""
           '<b onclick="wbGo(k)">\n')
    # 🔴 Line numbers are the real subject here — see `_handler_hits`. Both handlers on line 3, the
    # commented one on line 2 not at all, and `onclick` on line 4 counted from the UNSTRIPPED file.
    assert _handler_hits(src) == [
        (3, 'onload="wbFitFace(this)"'), (3, "onerror='wbFaceFallback(this)'"),
        (4, 'onclick="wbGo(k)"')]
    # The exemption is the WHOLE attribute, so a handler that merely contains it is still caught.
    assert 'onclick="this.select();wbGo(k)"' not in _INLINE_HANDLERS_THAT_NAME_NOTHING


#: A page expression a spec hands to the browser. All three helpers take one: `evaluate` runs it
#: once, `waitFor` and `mustWait` poll it. A ReferenceError costs the same in any of them.
#:
#: 🔴 THE WHOLE TEMPLATE, NOT ITS FIRST TOKEN. This used to be
#: `evaluate\(\s*cdp\s*,\s*`\s*(?:await\s+)?(name)\s*\(` — a single call anchored to the START of
#: the template — and 7.1-m13 walked straight past it. `wbEl('books', 'wbMsg')` sat on line five of
#: a nine-line IIFE, so deleting the inline `wbEl` would have thrown inside the page and the test
#: that exists for exactly that would have stayed green. Backticks cannot nest (§5.13), so `[^`]*`
#: is a sound reader of the body.
_CDP_TEMPLATE = re.compile(r"(?:evaluate|waitFor|mustWait)\(\s*cdp\s*,\s*`([^`]*)`", re.S)

#: `foo(` — a call, wherever it appears. `.` in the lookbehind is what keeps `el.querySelector(`
#: and `JSON.parse(` out; a method is the object's business, not the page's global scope.
_CDP_CALL = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(")

#: Names the template declares for itself, which are therefore not page globals.
_CDP_LOCAL = re.compile(r"(?:^|[;{(,\s])(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)")
_CDP_ARROW_PARAM = re.compile(r"(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>")

#: `${…}` is interpolated by NODE before the string ever reaches the browser, so what it names is a
#: spec-side helper (`rowOf`, `bookNamed`, `cardNaming`) and not a page global at all. Scanning
#: through it reports three functions as missing that were never asked for.
_CDP_INTERP = re.compile(r"\$\{[^{}]*\}")

#: Reserved words that take a parenthesis and are not calls.
_JS_KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "typeof", "instanceof", "new",
                "delete", "await", "async", "void", "do", "else", "function", "class", "yield",
                "in", "of", "throw", "case",
                # `import('/webui/js/…')` is a SYNTACTIC FORM that happens to look like a call,
                # and the scanner below matches `name(` — so a spec that pulls a module in
                # dynamically (power_line_browser_spec.mjs, to drive the renderer straight)
                # otherwise reports the page as owing it a function called `import`. No page can
                # define one: it is a reserved word.
                "import"}

#: Browser and language built-ins a spec may legitimately call in a page expression.
_JS_NATIVE = {"getComputedStyle", "fetch", "alert", "confirm", "prompt", "requestAnimationFrame",
              "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
              "Number", "String", "Boolean", "Array", "Object", "JSON", "Promise", "Error", "Date",
              "Map", "Set", "RegExp", "Symbol", "BigInt", "encodeURIComponent",
              "decodeURIComponent", "parseInt", "parseFloat", "isNaN", "structuredClone", "Blob",
              # `DataTransfer` is how a spec puts a File into an `<input type=file>` — 7.3.20's
              # ⬆ Import entry check. There is no other way: `input.files` is only assignable from
              # a `FileList`, and `DataTransfer` is the only constructor that makes one.
              "URL", "FormData", "File", "FileList", "DataTransfer", "FileReader", "Image",
              # ⚠️ `EventTarget` is the BASE CLASS of the four event types on this line and the
              # next, and it was the one missing. 9.1 §1: st_button_state_spec builds its fake
              # audio element as `Object.assign(new EventTarget(), {paused:false})` — which is
              # exactly the contract index.js depends on (`.paused` plus the element's own
              # play/pause events) and cannot be a real `<audio>`, whose `paused` is read-only.
              # The scan read a platform global as a name some Vocalis module owed the page.
              "Event", "CustomEvent", "EventTarget",
              # ⚠️ `DragEvent` joined them in 9.5.6 for the same reason `EventTarget` did: it is a
              # PLATFORM global, not a name any Vocalis module owes the page. The enhancement
              # queue's reorder is a drag, and `clips_queue_layout_spec.mjs` drives the real
              # dragstart → dragover → drop path with synthesized ones — which is the only way to
              # prove the handlers are reached, since `draggable="true"` renders identically with
              # nothing listening. CDP cannot synthesize an HTML5 drag any other way.
              "DragEvent",
              # `MutationObserver` joined them on 2026-10-12, for the same reason: it is a platform
              # global. The specs stopped sleeping and started waiting for the page itself, and
              # counting a list's repaints (wbedit_browser_spec.mjs) is done with one.
              "MutationObserver",
              "MouseEvent", "KeyboardEvent", "PointerEvent", "AbortController", "atob", "btoa",
              "Response", "Request", "Headers", "TextEncoder", "TextDecoder", "Uint8Array",
              "DataView", "ArrayBuffer"}


#: 🔴 THE BARE-VALUE ARM, ADDED IN 7.3-m11b — §11.8's lesson arriving in the SPEC scan.
#: `_CDP_CALL` needs a `(` after the name, so a spec that READS or WRITES a page global rather than
#: calling one was invisible. m11b made `stFaces` private to js/st/chars.js and
#: `wbedit_browser_spec.mjs` says `stFaces = {…fixture…}` and `Object.keys(stFaces.byName)`; both
#: threw in Chrome and every static check in this suite stayed green. Exactly the shape m4l found
#: in the page scan, in the one caller set that lives outside index.html.
#: `(?!\s*[(:])` drops calls (the arm above owns those) and object-literal keys (`byName:`).
_CDP_BARE = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])(?!\s*[(:])")


def _spec_page_scope(src: str) -> tuple[set, set]:
    """`(called, read)` — the names a spec's CDP templates resolve in the PAGE's own scope.

    Locals, arrow parameters, `${…}` interpolations, keywords and built-ins are all removed, so
    what comes back is the set of things the page itself has to be able to resolve.

    ⚠️ THE TWO ARMS ARE SEPARATE BECAUSE THEY ARE CHECKED DIFFERENTLY. A call can be matched
    against every name the page or the modules define; a bare read cannot, because at that width it
    matches `rows`, `box`, `saved` and every other snippet-local the local-scan happens to miss.
    The `read` set is therefore intersected with names a MODULE owns at column 0 — which is the
    only question worth asking anyway: *a module owns this name; can the page still see it?*
    """
    # 🔴 THE PROVEN MASKER, NOT A SECOND HAND-ROLLED ONE. The two `re.sub` calls this used to do
    # blank `'…'` and `"…"` and nothing else, which is fine for the call arm (a call needs a `(`
    # right after the name, and string contents rarely have one) and NOT fine for the bare arm:
    # `/^3 candidates · 300 KB on disk/.test(…)` in vc_undelete_browser_spec.mjs made the word
    # `on` read as a page global, because js/voice/autoplay.js happens to declare a private
    # helper by that name. `_mask_literals` disambiguates regex-from-division properly, is itself
    # under test (§2.3's trap is pinned there), and blanks comments in the same pass.
    from test_webui_parsetime import _mask_literals

    called, read = set(), set()
    for body in _CDP_TEMPLATE.findall(src):
        clean = _mask_literals(_CDP_INTERP.sub(" ", body))
        # `| _free_later_declarators`: `const l = …, c = getComputedStyle(l)` binds `c` too
        # (acestep_tab_browser_spec.mjs:398 was reported as driving a page global named `c`).
        local = set(_CDP_LOCAL.findall(clean)) | _free_later_declarators(clean)
        for parens, bare in _CDP_ARROW_PARAM.findall(clean):
            for part in (parens or bare).split(","):
                part = part.strip().split("=")[0].strip()
                if re.fullmatch(r"[A-Za-z_$][\w$]*", part or ""):
                    local.add(part)
        drop = local | _JS_KEYWORDS | _JS_NATIVE
        called |= {n for n in _CDP_CALL.findall(clean) if n not in drop}
        read |= {n for n in _CDP_BARE.findall(clean) if n not in drop}
    return called, read


def _page_names_a_spec_calls(src: str) -> set:
    """Back-compat shim for the call arm alone."""
    return _spec_page_scope(src)[0]


def test_every_function_the_browser_specs_drive_is_still_reachable():
    """Browser specs are callers too, even when they invoke page functions through CDP.

    Include every expression in each CDP template and all supported helpers so a module export remains
    reachable to both the page and its specs. This static check catches missing names without starting
    a browser or server.
    """
    webui = Path(paths.WEBUI)
    page = (webui / "index.html").read_text(encoding="utf-8")
    exported, defined = set(), set()
    for p in sorted((webui / "js").rglob("*.js")):
        src = p.read_text(encoding="utf-8")
        exported |= set(re.findall(r"^export\s+(?:async\s+)?(?:function|const|let)\s+([\w$]+)", src, re.M))
    defined |= set(re.findall(r"^(?:async\s+)?function\s+([\w$]+)", page, re.M))
    defined |= set(re.findall(r"^(?:const|let|var)\s+([\w$]+)\s*=", page, re.M))

    # 🔴 EVERY NAME A MODULE DECLARES AT COLUMN 0, exported or not. This is what scopes the
    # bare-value arm: without it, "every identifier a CDP snippet reads" is mostly snippet locals.
    owned = {}
    for p in sorted((webui / "js").rglob("*.js")):
        rel = "js/" + p.relative_to(webui / "js").as_posix()
        for _, name in _MODULE_DEF.findall(p.read_text(encoding="utf-8")):
            owned.setdefault(name, rel)

    driven, valued = {}, {}
    for spec in sorted(Path(__file__).parent.glob("*_spec.mjs")):
        calls, reads = _spec_page_scope(spec.read_text(encoding="utf-8"))
        for name in calls:
            driven.setdefault(name, set()).add(spec.name)
        for name in reads:
            valued.setdefault(name, set()).add(spec.name)

    assert driven, "no CDP page expressions found — the pattern has gone stale"
    missing = {n: sorted(v) for n, v in driven.items()
               if n not in exported and n not in defined}
    # ⚠️ The bare arm asks the narrower question — a name some MODULE owns, which the page can no
    # longer resolve. `n not in defined` keeps a name the page still declares out of it (the module
    # copy is then irrelevant), and `n not in exported` is the actual failure.
    missing.update({f"{n} (read as a value)": sorted(v) for n, v in valued.items()
                    if n in owned and n not in exported and n not in defined})
    assert not missing, (
        "a browser spec drives a name that is neither exported by a module nor defined in "
        "index.html. It will throw ReferenceError INSIDE the page, which surfaces as a spec that "
        "hangs and prints nothing — export it, or stop driving it directly.\n"
        "  🔴 IF IT IS STATE RATHER THAN A FUNCTION, EXPORT A FUNCTION OVER IT, NEVER THE STATE. "
        "`Object.assign(window, mod)` copies a value once, so publishing a reassigned `let` leaves "
        "the spec asserting about the seed value forever (§11.4) — quieter than the crash and "
        "worse. m11b added `stPollRunning()` over a timer and `stFacesNow()` over a map.\n"
        "  📌 And if the spec is INJECTING a fixture, give the function a parameter instead: "
        "`stFaceFor`'s fourth argument is that, and it removed a save/restore of a page global.\n  "
        + "\n  ".join(f"{n}  <- {', '.join(v)}" for n, v in sorted(missing.items())))


def test_the_bare_value_arm_of_the_spec_scan_is_not_vacuous():
    """⚠️ The bare arm added in 7.3-m11b compares two computed sets, and two empty sets are equal.

    Four ways it could pass while measuring nothing, pinned so it cannot: it has to SEE a bare read
    that is not a call, it has to keep property access and object keys OUT, it has to mask regex
    literals (the false positive that made it reuse `_mask_literals`), and it has to be scoped by
    a module-owned name set that is real.
    """
    from test_webui_parsetime import _mask_literals

    def read(js: str) -> set:
        return _spec_page_scope(f"evaluate(cdp, `{js}`)")[1]

    # 1. a bare read of a page global is SEEN — this is the m11b failure in one line
    assert "stFaces" in read("Object.keys(stFaces.byName)")
    assert "stPollTimer" in read("stPollTimer === null")
    # 2. …and a WRITE, which is how wbedit_browser_spec.mjs injected its fixture
    assert "stFaces" in read("stFaces = {loaded: true}")
    # 3. property access and object-literal keys stay out, or the scan floods
    assert "byName" not in read("Object.keys(stFaces.byName)")
    assert "loaded" not in read("stFaces = {loaded: true}")
    # 4. 🔴 A REGEX LITERAL IS NOT CODE. `/… on disk/` in vc_undelete_browser_spec.mjs reported the
    #    word `on` as a page global, because js/voice/autoplay.js declares a private `on()`.
    assert "on" not in read("/^3 candidates · 300 KB on disk/.test(x)")
    assert "disk" not in read("/^3 candidates · 300 KB on disk/.test(x)")
    #    …and the masker must not have eaten the code around it
    assert "test" not in read("/a on b/.test(x)"), "method call leaked in as a global"

    # 5. the scoping set is real: the modules genuinely own the names the arm keys off
    webui = Path(paths.WEBUI)
    owned = set()
    for p in sorted((webui / "js").rglob("*.js")):
        owned |= {n for _, n in _MODULE_DEF.findall(p.read_text(encoding="utf-8"))}
    assert len(owned) > 300, f"only {len(owned)} module-owned names — the scan is scoped to nothing"
    assert {"stFaces", "stPollTimer", "stFacesNow"} <= owned, "js/st/chars.js is not being read"


#: `wbAskName = …` / `window.jget = …` inside a spec — replacing one of OUR functions to stub it.
#: Any plain assignment, so the restore half (`window.jget = real;`) is caught as well as the stub
#: half. `==`/`===` are excluded by the lookahead; `+=` and `const x =` cannot match the anchor.
_SPEC_STUB = re.compile(r"^\s*(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*(?!=)", re.M)

#: Stubs of a name that is BOTH a module export AND still defined inline in `index.html`. Those
#: still work — for inline callers — because a classic script's top-level `function f(){}` is a
#: property of the global object, so assigning over it is seen by every inline caller.
#:
#: ⚠️ THIS IS A REPRIEVE, NOT AN ACQUITTAL. `jget` was in exactly this state during m11b and the
#: log poll broke anyway — because the MODULE that imports it stopped resolving through `window`
#: while the inline callers carried on.
#:
#: 🔴 SO AN ENTRY IS `(spec, stubbed_name) -> (function_under_test, reason)`, AND THE FIRST HALF OF
#: THAT VALUE IS THE EXPIRY. The reprieve holds only while the function the spec DRIVES is itself
#: still declared inline, because that is the thing that decides whether the stub is consulted —
#: not whether an inline copy of the stubbed helper exists somewhere. `$`, `esc` and the four `j*`
#: helpers keep their inline definitions for the whole of 7.3 (DESIGN_7_1 §7), so keying the
#: exemption on the STUBBED name alone can never expire and did not.
#:
#: ⚠️ 7.3-m7 IS WHY THIS IS A CHECK AND NOT A COMMENT. The single entry here read *"it must become
#: a `fetch` stub when Clips moves … and this entry deleted in the same commit"* — the right
#: instruction, written a milestone in advance, and the guard could not act on it. m7 moved
#: `loadScenes` into js/scenes/scenes.js, this scan stayed green, and the ordering check in
#: `clips_favorites_browser_spec.mjs` went red 90 seconds into a browser run describing an
#: ordering bug that was not there. A prose deadline inside a test is not a deadline.
_STUBS_STILL_REACHING_INLINE_CODE = {
    # ✅ EMPTY AS OF 7.3-m7, and the entry that was here is the reason the expiry column exists.
    # A new entry looks like:
    #     ("some_browser_spec.mjs", "jget"): ("loadThing", "the Thing code is still inline …"),
    # and dies on its own the day `loadThing` stops being an inline declaration.
}


def _stub_reprieve_holds(spec_name, stubbed, inline):
    """Is the exemption for `spec_name`'s stub of `stubbed` still LIVE?

    Two conditions, and the second one is the one 7.3-m7 had to add:

    1. the stubbed helper is still declared inline — otherwise nothing reads it off the global;
    2. **the function the spec drives is still declared inline** — otherwise that caller holds a
       module binding and the stub is never consulted, whatever is true of (1).

    `inline` is the set of column-0 declarations in index.html.
    """
    entry = _STUBS_STILL_REACHING_INLINE_CODE.get((spec_name, stubbed))
    if entry is None:
        return False
    under_test, _reason = entry
    return stubbed in inline and under_test in inline


def test_no_browser_spec_stubs_a_function_that_has_become_a_module_export():
    """A spec assignment cannot replace a function imported through a module binding.

    The assignment may succeed while the page continues to call the imported function; likewise,
    `Object.assign(window, mod)` copies values once and does not create live bindings. Stub stable
    dependencies such as `fetch` or the DOM, or drive the real control. Inline definitions are
    exempted only while page code can still call them; the exemption must expire when that definition
    is removed.
    """
    webui = Path(paths.WEBUI)
    exported = set()
    for p in sorted((webui / "js").rglob("*.js")):
        exported |= set(re.findall(r"^export\s+(?:async\s+)?(?:function|const|let)\s+([\w$]+)",
                                   p.read_text(encoding="utf-8"), re.M))
    assert exported, "no module exports found — this test would pass vacuously"

    # 🔴 STILL DEFINED INLINE = the stub still reaches inline callers, so it is a reprieve rather
    # than a pass. When the inline copy of a name is finally deleted, that name leaves this set and
    # the exemption below stops applying — which is precisely when the stub becomes wrong. The test
    # corrects itself on the right day instead of needing anyone to remember.
    #
    # ⚠️ THAT DAY IS 7.3 FOR `jget`, NOT m13. m13 deleted the inline `wbEl` only; `$`, `esc` and the
    # four `j*` helpers keep their inline definitions because the boot sequence calls them at parse
    # time (DESIGN_7_1_FRONTEND_REFACTOR.md §7, corrected in 188714a).
    page = (webui / "index.html").read_text(encoding="utf-8")
    inline = set(re.findall(r"^(?:async\s+)?function\s+([\w$]+)", page, re.M))
    inline |= set(re.findall(r"^(?:const|let|var)\s+([\w$]+)\s*=", page, re.M))

    bad, reprieved = [], []
    for spec in sorted(Path(__file__).parent.glob("*.mjs")):
        for n, line in enumerate(spec.read_text(encoding="utf-8").split("\n"), start=1):
            if line.strip().startswith("//"):
                continue
            for name in _SPEC_STUB.findall(line):
                if name not in exported:
                    continue
                where = f"{spec.name}:{n}  {line.strip()[:70]}"
                if _stub_reprieve_holds(spec.name, name, inline):
                    reprieved.append(where)
                else:
                    bad.append(where)

    assert not bad, (
        "a browser spec assigns over a function that is a module export and is no longer defined "
        "inline. The assignment succeeds and is NEVER CONSULTED — importers hold a module binding, "
        "and the shim's Object.assign copied a value, not a live binding. Stub something the split "
        "cannot move (fetch, the DOM) or drive the real control. "
        "See DESIGN_7_1_FRONTEND_REFACTOR.md §5.12.\n  " + "\n  ".join(bad))

    # Not an assertion — an exemption that has gone stale is a maintenance signal, not a failure.
    for key in _STUBS_STILL_REACHING_INLINE_CODE:
        assert any(r.startswith(key[0]) for r in reprieved), (
            f"the exemption for {key} no longer matches anything — the stub was fixed or moved, so "
            "delete the entry rather than leaving a rule nobody is subject to")


def test_a_stub_exemption_expires_when_the_function_it_covers_moves():
    """🔴 THE COMPANION FOR THE EXPIRY COLUMN, AND IT IS NOT OPTIONAL — the table above is EMPTY as
    of 7.3-m7, so `_stub_reprieve_holds` has no live subject and every arm of it would otherwise be
    unexercised. An exemption mechanism nobody is subject to is exactly the shape that let m7's
    failure through: the rule was correct, written a milestone early, and never evaluated.

    Driven with synthetic tables rather than the real one, because the point is the LOGIC, and the
    real table is supposed to stay empty.
    """
    key = ("some_browser_spec.mjs", "jget")
    table = {key: ("loadThing", "the Thing code is still inline")}
    with mock.patch.dict(_STUBS_STILL_REACHING_INLINE_CODE, table, clear=True):
        # Both inline: the stub still reaches the caller, so the reprieve holds.
        assert _stub_reprieve_holds(*key, {"jget", "loadThing"})
        # 🔴 THE m7 CASE. `jget` is STILL inline — it is for the whole of 7.3 — but the function
        # under test moved into a module, so the stub is never consulted. The old scan keyed only on
        # the left-hand condition and stayed green here.
        assert not _stub_reprieve_holds(*key, {"jget"})
        # The stubbed helper's own inline copy finally deleted: the original expiry, still enforced.
        assert not _stub_reprieve_holds(*key, {"loadThing"})
        # A spec/name pair with no entry is never reprieved.
        assert not _stub_reprieve_holds("other_spec.mjs", "jget", {"jget", "loadThing"})

    # ⚠️ AND THE REAL TABLE'S SHAPE, WHICH IS THE PART THAT CAN ACTUALLY ROT. Adding an exemption
    # is legitimate; adding one that is a bare reason string is how the expiry gets skipped, and it
    # would fail as a TypeError deep inside `_stub_reprieve_holds` rather than saying so here.
    for key, value in _STUBS_STILL_REACHING_INLINE_CODE.items():
        assert isinstance(value, tuple) and len(value) == 2 and all(value), (
            f"the exemption for {key} must be (function_under_test, reason) — the first half is "
            "what makes the entry expire when that function moves into a module, and a bare string "
            "is the pre-7.3-m7 shape that could never expire")


def test_the_spec_stub_scan_recognizes_the_three_that_bit_us():
    """⚠️ Pinned to the exact shapes, because a pattern that matches nothing is indistinguishable
    from a codebase with nothing to match."""
    assert _SPEC_STUB.findall("        window.jget = async u => {") == ["jget"]
    assert _SPEC_STUB.findall("        wbAskName = async () => 'Appended';") == ["wbAskName"]
    assert _SPEC_STUB.findall("        window.fetch = (url, opts) => {") == ["fetch"]
    assert _SPEC_STUB.findall("        window.jget = real;") == ["jget"]
    # A plain local is not a stub, and neither is a comparison.
    assert _SPEC_STUB.findall("        const rows = fields.length;") == []
    assert _SPEC_STUB.findall("        if (window.jget === real) return;") == []


def test_the_cdp_call_scan_actually_matches_the_specs():
    """⚠️ The test above passes vacuously if the scan stops matching, which is also what a green
    run looks like. So it is pinned to real call sites, to the one that caused it, and to the one
    it missed."""
    spec = (Path(__file__).parent / "wbedit_browser_spec.mjs").read_text(encoding="utf-8")
    found = _page_names_a_spec_calls(spec)
    assert "wbLoadLog" in found, "the wbLoadLog call sites that caused this test are no longer matched"
    assert len(found) >= 5, f"only matched {sorted(found)} — the pattern is probably stale"

    # The shape it always caught: one call, at the head of the template.
    assert _page_names_a_spec_calls("await evaluate(cdp, `wbOpen('cards', id)`)") == {"wbOpen"}

    # 🔴 THE SHAPE IT MISSED UNTIL 7.1-m13, and the reason the scan reads whole templates now. A
    # call buried inside an IIFE is exactly as much a page caller as one at the head of it.
    buried = _page_names_a_spec_calls(
        "const said = await evaluate(cdp, `(async () => {\n"
        "    wbHush('books');\n"
        "    const el = wbEl('books', 'wbMsg');\n"
        "    return el.textContent;\n"
        "})()`);")
    assert buried == {"wbHush", "wbEl"}, buried

    # And the three kinds of noise that would make it cry wolf: a method, a local, and a Node-side
    # `${…}` interpolation the browser never sees.
    quiet = _page_names_a_spec_calls(
        "await waitFor(cdp, `(() => {\n"
        "    const pick = n => n.trim();\n"
        "    const row = ${rowOf('Test Character 3')};\n"
        "    return pick(row.dataset.pre) && document.querySelector('#x') && Number('1');\n"
        "})()`);")
    assert quiet == set(), quiet

    # `mustWait` and `waitFor` carry page expressions too — they were invisible to the old pattern.
    assert _page_names_a_spec_calls("mustWait(cdp, `wbFindOpen('books')`)") == {"wbFindOpen"}


def test_every_action_a_message_line_offers_is_registered():
    """🔴 THE BIJECTION FOR `WB_ACTIONS`, WHICH NOTHING CHECKED UNTIL 7.1-m12.

    `wbSay(kind, text, {action: {label: 'Cancel', fn: 'wbStSweepCancel'}})` renders a button whose
    click looks the name up in `say.js`'s registry. The failure when the name is not registered is
    the one the registry was built to prevent and is completely silent: **the button renders, it
    clicks, and nothing happens, with no error anywhere anyone is looking.**

    ⚠️ The shim used to do the registering by hand, with a comment naming exactly that failure. m12
    moved it into `st.js` — and a grep for `wbStSweepCancel` across `tests/` found **nothing at
    all**. The mechanism had been correct for three milestones and unguarded for all of them; the
    move was the moment to notice, because a registration that silently stops happening looks
    identical to one that never did.

    📌 Both directions, like §2's roster audit and for the same reason. An offered-but-unregistered
    name is a dead button; a registered-but-never-offered name is dead code that reads as coverage.

    🔴 **THE REGISTRY HAS TWO READERS SINCE 9.7.1, AND A SCAN THAT KNOWS ONE OF THEM IS WORSE THAN
    NO SCAN.** `runWbAction(name, kind, done)` is the second: `open.js`'s `Undelete` starts the
    SillyTavern sweep through it rather than importing `st.js`, which would close the cycle §5.5
    forbids. Counting only `fn: '…'` would report `wbStSweep` as "registered, never offered" — i.e.
    it would call a live call path dead code, and the obvious way to quiet that is to delete the
    registration, which breaks Undelete silently. **A name reached by EITHER reader is offered.**
    """
    js = sorted((Path(paths.WEBUI) / "js").rglob("*.js"))
    offered, called, registered = {}, {}, {}
    for p in js:
        src = "\n".join(l for l in p.read_text(encoding="utf-8").split("\n")
                        if not l.strip().startswith("//"))
        for m in re.finditer(r"fn:\s*'([^']+)'", src):
            offered.setdefault(m.group(1), []).append(p.name)
        # ⚠️ The quote is what keeps the DEFINITION in `say.js` out of this — `runWbAction(name,`
        # has no quote after the paren, so only call sites with a literal name match.
        for m in re.finditer(r"runWbAction\(\s*'([^']+)'", src):
            called.setdefault(m.group(1), []).append(p.name)
        for m in re.finditer(r"registerWbAction\(\s*'([^']+)'", src):
            registered.setdefault(m.group(1), []).append(p.name)

    assert offered, "no `fn: '…'` action names found — the pattern has gone stale, not the code"
    assert called, "no `runWbAction('…')` call sites found — the second reader's pattern has gone stale"
    reached = set(offered) | set(called)
    assert reached == set(registered), (
        "the message line's action registry is not a bijection. A name offered but never registered "
        "is a button that renders, clicks, and does nothing — silently, which is the whole reason "
        "`registerWbAction` exists. A name registered but never reached is dead code.\n"
        f"  reached, not registered: {sorted(reached - set(registered))}\n"
        f"  registered, not reached: {sorted(set(registered) - reached)}")


def test_the_action_registry_scan_is_not_vacuous():
    """⚠️ The test above is only worth its runtime if all three patterns still match real code — and
    two empty sets are equal, so a stale regex passes it perfectly.

    🔴 THE THIRD PIN IS THE ONE THAT MATTERS FOR 9.7.1. `Undelete` reaches `wbStSweep` by a STRING,
    which is the one wiring a type checker cannot see: rename the function and `tsc` stays green
    while the button silently stops importing anything. This pins both ends of that string.
    """
    st = (Path(paths.WEBUI) / "js" / "wb" / "st.js").read_text(encoding="utf-8")
    assert re.findall(r"fn:\s*'([^']+)'", st) == ["wbStSweepCancel", "wbStSendCancel"]
    assert re.findall(r"registerWbAction\(\s*'([^']+)'", st) == [
        "wbStSweepCancel", "wbStSendCancel", "wbStSweep"]
    op = (Path(paths.WEBUI) / "js" / "wb" / "open.js").read_text(encoding="utf-8")
    assert re.findall(r"runWbAction\(\s*'([^']+)'", op) == ["wbStSweep"]


def test_every_module_on_disk_is_reachable_through_the_route(client):
    """A module on disk that the page imports must be available to the browser."""
    root = Path(paths.WEBUI) / "js"
    found = sorted(p.relative_to(root).as_posix() for p in root.rglob("*.js"))
    assert found, "no modules on disk — this test would pass vacuously"
    for rel in found:
        assert client.get(f"/webui/js/{rel}").status_code == 200, rel


# ── the import graph ─────────────────────────────────────────────────────────
# 🔴 NOTHING CHECKED THAT AN `import` RESOLVES UNTIL 7.3-m4, and the split is entirely made of
# moving exports between files. The two failures below are the ones that shape actually produces:
#
#   · a specifier pointing at a file that is not there   -> the module throws on load
#   · a NAMED import of something the target no longer exports -> ditto, and this is the one the
#     split causes, because "move a function to a new module" is the milestone's whole job
#
# Either one is a SyntaxError or a TypeError inside the browser, before a line of the importing
# module runs. `test_every_module_on_disk_is_reachable_through_the_route` proves a module can be
# FETCHED; it says nothing about whether what it asks for exists. m4 split `pollComfy` out of
# `sys/model.js` into `sys/comfy.js`, and nothing in this suite would have noticed if the importer
# had been left pointing at the old file — `js/sys/comfy.js` has no browser spec at all.

# ⚠️ `^[ 	]*`, NOT `^`. index.html's shim indents every one of its imports by two spaces, so an
# anchored `^import` matched the module tree and MISSED THE SHIM ENTIRELY — the twenty-odd imports
# that actually assemble the page. Caught by `test_the_import_scan_is_not_vacuous` below, which is
# the entire reason that test is worth its runtime.
# 🔴 re.S SINCE 9.0-m5, AND `[^;]+?` RATHER THAN `.+?` TO PAY FOR IT.
#
# Without re.S a MULTI-LINE import matched nothing at all, so a module imported only across
# two lines was reported as an orphan that "renders nowhere" while being imported perfectly
# well. The note at `_FREE_IMPORT_FROM` below predicted the missing flag would "under-check
# rather than false-alarm" and left it alone on that basis; that prediction was wrong, and it
# cost a green suite the first time a wired-in module wrapped its import list.
#
# ⚠️ re.S alone would be a second bug: `.+?` could then run from a BARE `import 'x';` across
# a statement boundary to the next line's ` from '...'`, inventing an import that is not
# there. An import clause never contains a semicolon, so `[^;]` bounds the match to one
# statement — which is what makes crossing a NEWLINE safe.
_IMPORT_FROM = re.compile(r"^[ 	]*import\s+([^;]+?)\s+from\s+['\"]([^'\"]+)['\"]",
                          re.M | re.S)
_IMPORT_BARE = re.compile(r"^[ 	]*import\s+['\"]([^'\"]+)['\"]", re.M)
_DYNAMIC = re.compile(r"\bimport\(\s*['\"]([^'\"]+)['\"]\s*\)")
_EXPORTED = re.compile(r"^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)", re.M)
_NAMED = re.compile(r"\{([^}]*)\}")


def _js_root() -> Path:
    return Path(paths.WEBUI) / "js"


def _resolve(spec: str, importer: Path) -> Path | None:
    """A specifier -> the file it means, or None when it is not ours to check.

    Two forms are in use and both must work. Modules import each other RELATIVELY
    (`'../util/dom.js'`), while `index.html`'s shim uses the ABSOLUTE route path
    (`'/webui/js/sys/devices.js'`) because it is resolving against the page's URL, not a file.
    """
    if spec.startswith("/webui/js/"):
        return _js_root() / spec[len("/webui/js/"):]
    if spec.startswith("."):
        return (importer.parent / spec).resolve()
    return None            # bare specifier — a CDN or npm name, and there are none of those here


def _imports_of(src: str, importer: Path):
    """(specifier, {named imports}) for executable static and dynamic imports in `src`.

    JSDoc `import('./module.js').Type` references are type annotations, not browser requests.
    Keep the lexical mask only for locating executable `import` tokens; parse specifiers from the
    original text so their string values remain available.
    """
    from test_webui_parsetime import _mask_literals

    code = _mask_literals(src)

    def is_code_import(match) -> bool:
        offset = match.group(0).find("import")
        return offset >= 0 and code[match.start() + offset:match.start() + offset + 6] == "import"

    out = []
    for match in _IMPORT_FROM.finditer(src):
        if not is_code_import(match):
            continue
        clause, spec = match.group(1), match.group(2)
        names = set()
        m = _NAMED.search(clause)
        if m:
            for part in m.group(1).split(","):
                part = part.strip()
                if not part:
                    continue
                # `import { a as b }` — the ORIGINAL name is what the target must export.
                names.add(part.split(" as ")[0].strip())
        out.append((spec, names, importer))
    for rx in (_IMPORT_BARE, _DYNAMIC):
        for match in rx.finditer(src):
            if is_code_import(match):
                out.append((match.group(1), set(), importer))
    return out


def test_import_graph_ignores_jsdoc_type_references():
    src = (
        "/** @type {import('./removed-types.js').SongRow[]} */\n"
        "const load = () => import('./retained-runtime.js');\n"
    )
    graph = _imports_of(src, Path("media/stems.js"))
    assert [(spec, names) for spec, names, _ in graph] == [
        ("./retained-runtime.js", set())]


def _every_import():
    """Every import in the module tree AND in index.html's shim."""
    root = _js_root()
    files = sorted(root.rglob("*.js"))
    assert files, "no modules on disk — this test would pass vacuously"
    graph = []
    for p in files:
        graph += _imports_of(p.read_text(encoding="utf-8"), p)
    page = Path(paths.WEBUI) / "index.html"
    graph += _imports_of(page.read_text(encoding="utf-8"), page)
    return graph


def test_every_import_specifier_points_at_a_file_that_exists():
    """🔴 A specifier that resolves to nothing is a 404 mid-load: the importing module never runs,
    and everything it was going to wire is silently not wired."""
    graph = _every_import()
    assert graph, "no imports found — the patterns have gone stale"
    missing = [f"{imp.name}: import '{spec}' -> {tgt}"
               for spec, _, imp in graph
               if (tgt := _resolve(spec, imp)) is not None and not tgt.is_file()]
    assert not missing, "an import points at a file that does not exist:\n  " + "\n  ".join(missing)


def test_every_named_import_is_actually_exported_by_its_target():
    """🔴 THE ONE THE SPLIT ACTUALLY CAUSES. Moving `pollComfy` from `sys/model.js` to
    `sys/comfy.js` leaves every importer of the old name pointing at a module that no longer has
    it — `import { pollComfy } from './sys/model.js'` is a SyntaxError in the browser, thrown
    before the importing module's first statement. Nothing else in this suite computes it."""
    graph = _every_import()
    exports: dict[Path, set[str]] = {}
    bad = []
    for spec, names, imp in graph:
        if not names:
            continue
        tgt = _resolve(spec, imp)
        if tgt is None or not tgt.is_file():
            continue                      # the test above owns that failure
        if tgt not in exports:
            exports[tgt] = set(_EXPORTED.findall(tgt.read_text(encoding="utf-8")))
        for n in sorted(names - exports[tgt]):
            bad.append(f"{imp.name} imports {{{n}}} from '{spec}', which does not export it")
    assert not bad, "a named import does not exist in its target module:\n  " + "\n  ".join(bad)


def test_the_import_scan_is_not_vacuous():
    """The two tests above are only worth their runtime if the patterns actually match. Pin the
    shapes really in the tree: a relative named import, the shim's absolute `import * as`, the one
    bare side-effect import (`wb/wire.js`), and the dynamic `import()` that boots main.js."""
    graph = _every_import()
    specs = [s for s, _, _ in graph]
    named = {n for _, ns, _ in graph for n in ns}

    # 🔴 THE SHAPES CHANGED AT 7.3-m13 AND THE QUESTION DID NOT: does the scan see every FORM of
    # import that is really in the tree? The forms themselves moved when index.html's shim was
    # deleted (§10 items 1 and 2) — there are no `/webui/js/…` absolute specifiers left, because the
    # only thing that used them was the shim, and no dynamic `await import('/webui/js/main.js')`,
    # because the page loads main.js with a `src=` attribute now. What replaced both is a block of
    # BARE relative side-effect imports in js/main.js, which is the root of the graph.
    #
    # ⚠️ THE BARE FORM IS THE ONE THAT MATTERS MOST AND IS THE EASIEST TO STOP SEEING. It publishes
    # no name, so a scan that only followed named imports would miss ~45 modules and still look
    # healthy — which is the exact hole `test_every_module_on_disk_is_imported_by_something` exists
    # to close, and that test is built on this scan.
    assert any(s.startswith("../") or s.startswith("./") for s in specs), "no relative imports"
    bare = [s for s, ns, _ in graph if not ns]
    assert len(bare) > 20, (
        f"only {len(bare)} bare side-effect import(s) found; js/main.js roots the graph with ~45 of "
        "them. A scan that has stopped seeing the bare form makes the orphan check vacuous.")
    assert any(s.endswith("/wb/wire.js") for s in specs), (
        "wb/wire.js is not imported anywhere — it exports NOTHING, so nothing else will notice: "
        "the three Character-Cards panes are silently unwired")
    # 🔴 THIS WAS WRITTEN AS A DISJUNCTION AND THE RIGHT-HAND SIDE IS UNCONDITIONALLY TRUE, so the
    # whole line reduced to "main.js exists on disk" while reading like a check on the scan. It
    # cannot be tightened into the left-hand form either, and the reason is the point: NOTHING
    # IMPORTS main.js. It is the graph's root, reached by index.html's `<script type="module"
    # src=…>` and by nothing else, so an import scan will never see it — the left operand was
    # always false. Say the real thing instead, and let the page's reference be checked where it
    # actually lives (test_webui_size.py's one-module-tag guard).
    assert (_js_root() / "main.js").is_file(), (
        "js/main.js is gone — it is the graph's only root, and every other module is reachable "
        "only through it")
    assert {"$", "esc"} <= named, "the dom.js helpers are no longer imported by name"
    # Resolution must actually land on real files, or the checks above pass by resolving to None.
    resolved = [_resolve(s, i) for s, _, i in graph]
    assert sum(1 for r in resolved if r is not None and r.is_file()) > 20, \
        "almost nothing resolved — _resolve is broken and both tests are vacuous"


# ── the LAYERING guard: a ui/ helper must not reach into a feature's state ───────────────────
#
# 🔴 WHAT THIS PINS, AND WHY A BROWSER SPEC CANNOT (7.3-m4u). `ui/audition.js`'s `wireClearCache`
# took its voice-options list from `stVoiceOpts.length ? stVoiceOpts : nomiOpts` — a shared helper
# reaching into TWO sibling features to answer a question both of its callers already knew. The cost
# was not the reach: it was that both names then had to stay declared in index.html forever, because
# making either module-private turned the other feature's 🧹 Clear cached button into a
# ReferenceError. Two extractions (m4t, m11a) wrote that constraint down as a fact before anyone
# asked why it existed. The list is a parameter now and both constraints are gone.
#
# ⚠️ SABOTAGE-VERIFIED THE HARD WAY: putting `nomiOpts` back into that expression and running the
# browser specs passes. `nomiOpts` is module-private now, so the reference throws — but only inside
# the Clear-cached click handler, and NO SPEC CLICKS THAT BUTTON. The failure is real, remote, and
# invisible to everything the suite runs.
#
# 📌 SO THIS IS A TEXT CHECK, DELIBERATELY, AND IT IS HONEST ABOUT BEING ONE. It cannot prove the
# helper works; it proves the helper does not name state it has no business naming, which is the
# specific regression m4u exists to prevent. **A browser spec that actually clicks 🧹 Clear cached
# would be strictly better and does not exist** — if you write one, keep this too: they answer
# different questions.
_FEATURE_STATE_NO_UI_MODULE_MAY_NAME = ("stVoiceOpts", "nomiOpts", "scLib", "vs", "vt", "vc")


def test_no_ui_module_reaches_into_a_features_own_state():
    """🔴 `ui/` IS THE SHARED LAYER. A helper there naming a feature's global pins that global to
    the page — the feature cannot make it module-private without breaking the helper, and the
    breakage surfaces only when a user clicks the one control that path serves."""
    root = _js_root()
    bad = []
    for p in sorted((root / "ui").glob("*.js")):
        # 🔴 STRIP COMMENTS FIRST. Every one of these files documents the reach it USED to have,
        # quoting the name verbatim — searching for a mention finds the post-mortem, not the code.
        src = _strip_js_comments(p.read_text(encoding="utf-8"))
        for n in _FEATURE_STATE_NO_UI_MODULE_MAY_NAME:
            if re.search(r"(?<![\w$.])" + re.escape(n) + r"(?![\w$])", src):
                bad.append(f"ui/{p.name} names `{n}`, which belongs to a feature module")
    assert not bad, (
        "\n  ".join(["a shared ui/ helper reaches into a feature's own state:"] + bad)
        + "\n\nPass the value in as a parameter from the call sites, which already have it — that "
          "is what m4u did for wireClearCache's options list (§11.14). Do NOT export the global so "
          "ui/ can import it: that points the shared layer at a feature and pins it just as hard.")


def test_the_layering_scan_is_not_vacuous():
    """The check above passes trivially if the scan reads nothing, or if comment-stripping eats the
    code. Prove it sees real identifiers in the files it is scanning, and that it would fire."""
    aud = _strip_js_comments((_js_root() / "ui" / "audition.js").read_text(encoding="utf-8"))
    assert "wireClearCache" in aud, "comment-stripping ate the code, or the file moved"
    assert "optsOf" in aud, "the m4u parameter is gone — if it was renamed, re-point this pin"
    # the word-boundary guard must not match a property access or a longer name
    assert re.search(r"(?<![\w$.])nomiOpts(?![\w$])", "let nomiOpts=[];")
    assert not re.search(r"(?<![\w$.])nomiOpts(?![\w$])", "x.nomiOpts")
    assert not re.search(r"(?<![\w$.])vc(?![\w$])", "vcRenderBatch()")


# ── the FORK guard: exactly one declaration, or the two copies drift silently ────────────────
#
# 🔴 THE FAILURE, WHICH THIS PROJECT HAS ALREADY HAD, AND THE HOLE, FOUND BY SABOTAGE AT m11a.
# Declare a name in the page AND in a module and the module writes its copy while every inline
# reader reads one nothing updates — DESIGN §6 step 5 calls it "worse than either alternative, and
# invisible", and §11.4 is the long version. m4m measured it: `vsStart` declared in a module while
# the page kept assigning the inline one made every elapsed time read as ~29 million minutes.
#
# The project's answer has been a grep with a HAND-MAINTAINED name list, run from memory before a
# commit — `vt|vs|vc|state|vtStart|vtCurveAt|vsStart`. That list is stale the moment an extraction
# adds shared state to it, and nothing fails when it is. Sabotage at m11a: add `let nomiOpts=[];`
# to js/st/nomi.js, leaving index.html's declaration in place, and the whole suite stays green.
#
# 📌 SEVEN NAMES ARE DUPLICATED ON PURPOSE and are the allowlist below — `$`, `esc` and the four
# `j*` helpers (they cannot move while the boot IIFE calls them at parse time, DESIGN_7_1 §5.6) and
# `AUDITION_TEXT` (a top-level restore reads it, §3.1a). Each has its own drift test above, which is
# the price of the duplication; this test is about every name that is NOT paying that price.
# ✅ FIVE NOW, NOT SEVEN — `esc` left at 7.3-m8c and `AUDITION_TEXT` at 7.3-m12c, each on the removal
# condition its own drift row had written down. ⚠️ The not-vacuous test below is what forces this set
# to shrink when a duplication ends, rather than leaving it claiming one that has: it asserts the
# allowlisted names really are declared in BOTH places, so a stale entry fails there.
# 📌 WHAT IS LEFT IS EXACTLY THE m13 SET — `$` and the four `j*` helpers, all five held by the same
# fact, that the boot IIFE and ~90 top-level statements call them while the page is still parsing.
# They go when the inline script does, and not one milestone earlier.
# ✅ EMPTY AS OF 7.3-m13 — the last five went with the inline script. The set is kept rather
# than deleted because the checks below still use it, and an empty allowlist is the honest
# statement of the end state: NOTHING is duplicated between the page and the module tree,
# because there is no page-side JavaScript left for anything to be duplicated INTO.
_DUPLICATED_ON_PURPOSE: set[str] = set()

# Column 0, both eras: the inline script writes every top-level construct at column 0 and indents
# everything nested, and so does a module (with an optional `export ` in front). DESIGN §2.3 —
# a brace scanner is silently corrupted by regex literals and template interpolations; this is not.
_TOP_DECL = re.compile(
    r"^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)"
    r"|^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)", re.M)


def _top_level_names(src: str) -> set[str]:
    return {next(g for g in m.groups() if g) for m in _TOP_DECL.finditer(_strip_js_comments(src))}


def test_no_name_is_declared_both_inline_and_in_a_module():
    """🔴 ONE DECLARATION, OR THE WRITES AND THE READS GO TO DIFFERENT BINDINGS.

    `Object.assign(window, mod)` copies a value once; it is not a live binding. So a name declared
    in both places is two independent variables that look like one, and every symptom of it is
    remote from the cause — a timer that reads as 29 million minutes, a picker that never sees a
    newly added voice, a flag that is permanently false.
    """
    inline = _top_level_names(_inline_app_script())
    root = _js_root()
    bad = []
    for p in sorted(root.rglob("*.js")):
        for n in sorted(_top_level_names(p.read_text(encoding="utf-8")) & inline
                        - _DUPLICATED_ON_PURPOSE):
            bad.append(f"`{n}` is declared at column 0 in BOTH index.html and "
                       f"{p.relative_to(root).as_posix()}")
    assert not bad, (
        "\n  ".join(["a name has two declarations, so its writers and readers disagree:"] + bad)
        + "\n\nPick one. If inline code still READS it, the declaration stays in the page and the "
          "module reaches it through the scope chain (safe, resolved at call time — §3.1). If "
          "nothing inline reads it, delete the inline copy. Never both. If the duplication is "
          "deliberate, it needs a drift test and a line in _DUPLICATED_ON_PURPOSE, not silence.")


def test_the_fork_scan_is_not_vacuous():
    """The check above is worth nothing if `_top_level_names` under-reads either side. Pin a real
    declaration of each shape in each era, and prove the allowlist is doing work."""
    inline = _top_level_names(_inline_app_script())
    # every shape, in the page
    #
    # 🔴 THE `function` SHAPE IS DERIVED, NOT NAMED — 7.3-m2a, and the note twelve lines down already
    # had the lesson for the `let` case: *"pin a declaration that CANNOT move, not merely one that has
    # not."* This line said `switchTab`, and m2a moved `switchTab` into js/ui/tabs.js. The bind is that
    # for the `function` shape there IS no immovable choice — every inline function is scheduled to
    # leave by m13, so any name written here is a name some milestone will take. So ask the question
    # without a name: does the scanner see the SHAPE at all in the real file?
    #
    # ⚠️ Deliberately re-derived with the sub-pattern rather than reusing `_top_level_names`, which
    # collapses the three shapes into one set and could not tell you WHICH one had stopped being seen.
    # At m13 the inline block is deleted and this goes to zero — that is the signal to rewrite this
    # file against modules (§10 item 1), not to soften the assertion.
    # 🔴 ALL THREE PAGE-SIDE ARMS ARE GONE AT 7.3-m13, AND THE PARAGRAPH ABOVE PREDICTED IT TWICE.
    # It said, of the `function` shape: "every inline function is scheduled to leave by m13, so any
    # name written here is a name some milestone will take. At m13 the inline block is deleted and
    # this goes to zero — that is the signal to rewrite this file against modules (§10 item 1), not
    # to soften the assertion." Then m12d found the same thing true of `const` (`state`) and `let`
    # (`ENCRYPTED`), each of which had its own note explaining why it was the immovable one.
    #
    # 📌 THE END STATE IS STRONGER THAN THE CHECK WAS. There is no immovable name for any shape
    # because there are no page-side names AT ALL, so the fork this scan looks for — one identifier
    # declared in BOTH the page and a module — is unreachable by construction rather than absent by
    # measurement. That is asserted directly here, and `test_webui_size.py`'s
    # `test_the_page_has_no_inline_application_script` is what keeps it true.
    page_src = _strip_js_comments(_inline_app_script())
    page_decls = re.findall(r"^(?:export\s+)?(?:async\s+function|function|const|let|var)\s+([A-Za-z_$][\w$]*)",
                            page_src, re.M)
    assert not page_decls, (
        f"index.html declares {sorted(set(page_decls))[:5]} at the top level of an inline script. "
        "That is application JavaScript back in the page, and it can now FORK with a module - which "
        "is the whole failure this file was built around. Put it in a module under src/webui/js/.")
    assert not inline, (
        f"`_top_level_names` reports {sorted(inline)[:5]} in the page, but the shape scan above "
        "found no declarations. The two disagree, so one of them is broken - fix that before "
        "trusting anything else in this file.")

    # every shape, in a module — including behind `export `
    devices = _top_level_names((_js_root() / "sys" / "devices.js").read_text(encoding="utf-8"))
    assert "loadDevices" in devices, "`export async function` is not being seen in a module"
    assert "devBusy" in devices, "a bare module-private `let` is not being seen"
    filt = _top_level_names((_js_root() / "util" / "filter.js").read_text(encoding="utf-8"))
    assert "FILT" in filt, "`export const` is not being seen in a module"
    # ✅ THE ALLOWLIST ARM IS RETIRED AT 7.3-m13, ON THE INSTRUCTION IT CARRIED. It read
    # `assert "$" in (dom & inline)` with the message *"if the inline copy is finally gone, shrink
    # _DUPLICATED_ON_PURPOSE rather than leaving it claiming a duplication that has ended"* — and
    # the inline copy is gone, so `_DUPLICATED_ON_PURPOSE` is empty and there is no intersection
    # left to assert. 📌 An allowlist that is empty is not the same as an allowlist that is
    # unchecked: the arm below is what makes the difference, by requiring it to be empty for a
    # REASON (no page-side declarations exist) rather than by having been quietly cleared.
    dom = _top_level_names((_js_root() / "util" / "dom.js").read_text(encoding="utf-8"))
    assert "$" in dom, "`$` is not being seen in js/util/dom.js — the module-side scan is broken"
    assert not _DUPLICATED_ON_PURPOSE, (
        f"_DUPLICATED_ON_PURPOSE claims {sorted(_DUPLICATED_ON_PURPOSE)} are duplicated between "
        "index.html and a module, but the page declares nothing at all since 7.3-m13. Either the "
        "page has grown JavaScript again (see test_webui_size.py) or this allowlist is stale.")
    # ✅ AND THIS IS WHAT THAT INSTRUCTION LOOKS LIKE CARRIED OUT. `esc` was in the line above until
    # 7.3-m8c; it is asserted ABSENT from the inline block now, so the allowlist cannot quietly grow
    # it back — which matters more for `esc` than for the others, because a second copy of an escaper
    # is an injection hole waiting for the two to disagree.
    assert "esc" not in inline, (
        "`esc` is declared inline again. It was deleted at 7.3-m8c because index.html had no "
        "parse-time caller left; if one is back, js/util/dom.js is still the single definition and "
        "the right fix is to move the caller, not to re-fork the escaper.")


# ═════════════════════════════════════════════════════════════════════════════════════════
# 🔴 THE DUPLICATE-DRIFT FAMILY IS RETIRED — 7.3-m13, AND BOTH TESTS SAID SO THEMSELVES.
#
# `$` and the four `j*` helpers existed TWICE on purpose since 7.1 §5.3/§5.6: once in
# `js/util/dom.js` / `js/util/http.js`, once in index.html's classic script. Not an untidiness — a
# module is DEFERRED, and ~90 top-level statements plus the boot IIFE called them while the page was
# still parsing, so the inline copies could not move until there was no inline script left to need
# them. The price of that duplication was these tests: two definitions that can drift apart, with
# nothing else in the suite able to notice.
#
# Both failure messages carried their own removal condition and both fired on schedule at m13:
#     "$ is no longer defined inline in index.html…"
#     "…If the inline script is finally gone, delete this test with it — otherwise the module copy
#      just lost its counterpart."
#
# 📌 FIVE DUPLICATES RETIRED ACROSS 7.3, AND EVERY ONE WENT ON A CONDITION WRITTEN THE DAY IT WAS
# CREATED — `wbEl` (7.1-m13), `esc` (m8c), `AUDITION_TEXT` (m12c), and `$`/`j*` here. **None was
# retired because somebody noticed.** That is the argument for writing the condition into the
# duplicate at the moment you accept it: §3.1a's "duplicate the helper OR move the caller" is a
# reasonable trade only if the first branch records when it ends.
#
# ⚠️ FOR `esc` THE DRIFT WAS A SECURITY BUG, and that is why the family is worth this epitaph rather
# than a silent delete: `"` is in its character class because the result goes into ATTRIBUTE values,
# and a page whose two escapers disagreed had an injection hole in whichever half was behind. The
# duplication is gone, so the hole is unreachable by construction — which is a better outcome than a
# test, and the only kind of "delete the test" that is ever right.


# ── the ORPHAN guard: a module nothing imports is a feature nobody wired ─────────────────────
#
# 🔴 THE HOLE THIS CLOSES, FOUND BY SABOTAGE IN 7.3-m4s. Delete the shim's
# `import '/webui/js/sys/login.js';` and the ENTIRE suite stays green — 3,914 tests. The module is
# still on disk, so the route test passes; every specifier in the file still resolves, so the import
# graph passes; nothing on the shim lost an export, so the page-reachability scan passes; no browser
# spec drives it. And the ⚙ Settings tab ships with **Apply** and **Generate new recovery key** dead
# on click, with no ReferenceError anywhere to say so.
#
# 📌 IT IS THE BARE SIDE-EFFECT IMPORTS THAT ARE EXPOSED, and there are now four of them —
# `wb/wire.js`, `voice/autoplay.js`, `voice/rvcimport.js`, `sys/login.js`. Every other module is
# held in place by a NAMED import, so dropping its line breaks something loudly at load. A module
# that exports nothing is held in place by one line and nothing else, and each of the four has a
# comment in the shim saying so ("⚠️ SO THIS IMPORT IS THE WHOLE FEATURE"). A comment is not a test.
#
# ⚠️ IT ALSO CATCHES THE OTHER DIRECTION — a module written but never wired in, which during a split
# is the likelier of the two. The reachability closure below starts at index.html and follows every
# static, bare and dynamic import; anything on disk it never reaches is one or the other.
def _reachable_from_the_page() -> set[Path]:
    """Return every module reachable from the source entry point, including transitive imports.

    The production page loads a bundle built from `js/main.js`; checking the source import graph keeps
    side-effect-only imports reachable and catches modules omitted from the application.
    """
    entry = _js_root() / "main.js"
    assert entry.is_file(), "js/main.js is gone — it is the module graph's only root since 7.3-m13"
    seen: set[Path] = set()
    page = Path(paths.WEBUI) / "index.html"
    queue = [entry.resolve()]
    queue += [t for spec, _, imp in _imports_of(page.read_text(encoding="utf-8"), page)
              if (t := _resolve(spec, imp)) is not None]
    while queue:
        f = queue.pop()
        if f in seen or not f.is_file():
            continue
        seen.add(f)
        queue += [t for spec, _, imp in _imports_of(f.read_text(encoding="utf-8"), f)
                  if (t := _resolve(spec, imp)) is not None]
    return seen


def test_every_module_on_disk_is_imported_by_something():
    """🔴 A module the page never imports is dead weight or a dropped wiring line, and the four bare
    side-effect imports can only fail this way — they publish no name, so nothing else notices."""
    root = _js_root()
    on_disk = {p.resolve() for p in root.rglob("*.js")}
    assert on_disk, "no modules on disk — this test would pass vacuously"
    orphans = sorted(p.relative_to(root.resolve()).as_posix() for p in on_disk - _reachable_from_the_page())
    assert not orphans, (
        "these modules exist on disk but index.html cannot reach them by any import chain:\n  "
        + "\n  ".join(orphans)
        + "\n\nEither an import was dropped from the product graph or the module was written and "
          "never wired in. Remove dead modules rather than shipping unreachable UI code.")


def test_the_orphan_scan_is_not_vacuous():
    """The check above is worth nothing if the closure silently reaches everything, or nothing.
    Pin both ends: a module reached ONLY by a bare side-effect import, and one reached only
    transitively (never named in index.html at all)."""
    root = _js_root()
    reached = {p.resolve() for p in _reachable_from_the_page()}
    # `sys/login.js` is in the shim by a bare import and named nowhere else in the tree.
    login = (root / "sys" / "login.js").resolve()
    assert login.is_file(), "js/sys/login.js is gone — if it moved, re-point this pin"
    assert login in reached, "the closure does not follow bare side-effect imports"
    # `sys/comfy.js` is deliberately OFF the shim; only main.js imports it, and main.js is reached
    # only through the shim's dynamic `import()`. Two hops, neither of them a shim line.
    comfy = (root / "sys" / "comfy.js").resolve()
    assert comfy.is_file(), "js/sys/comfy.js is gone — if it moved, re-point this pin"
    assert comfy in reached, "the closure does not follow the dynamic boot import, or does not recurse"
    # And it must not reach by accident: a file the page cannot load is not in the set.
    assert (root / "no_such_module.js").resolve() not in reached


# ── the extraction guard: a name the PAGE calls must still be reachable from the page ───────
#
# 🔴 THE FAILURE THIS EXISTS FOR, FOUND BY SABOTAGE IN 7.3-m4h. Drop the `export` from
# `js/media/bulk.js`'s `loadBulk` and NOTHING in the suite went red — not the import graph (it is
# not an import), not the spec-reachability check (no browser spec drives it), not the smokes (they
# slice the source, they do not run the page). But `switchTab` still says `if(name==='bulk')
# loadBulk();`, and with the export gone the shim's `Object.assign` has nothing to copy, so the
# first click on the Bulk tab is `ReferenceError: loadBulk is not defined` and a tab that does not
# open. Every extraction in this milestone can make exactly that mistake, and every one of them so
# far has been correct only by hand.
#
# 📌 THE RULE, and it is the whole eligibility question the shim exists to answer: **a name the
# inline script CALLS, and no longer DEFINES, has to be exported by some module AND that module has
# to be on the shim.** Being exported is not enough — js/sys/comfy.js is deliberately off the shim
# (main.js imports `pollComfy` directly), so an export there is invisible to inline code.
_PAGE_CALL = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(")
_PAGE_DEF = re.compile(r"(?:^|[;{(,\s])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"
                       r"|(?:^|[;{(,\s])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=")
_MODULE_DEF = re.compile(r"^(export\s+)?(?:async\s+)?(?:function|const|let)\s+([\w$]+)", re.M)


# ═════════════════════════════════════════════════════════════════════════════════════════
# 🔴 THE SHIM-REACHABILITY PAIR IS RETIRED — 7.3-m13. Two tests and one helper lived here:
# `_shim_block`, `test_every_name_the_page_still_calls_is_reachable_from_a_module_on_the_shim` and
# its vacuity guard. They answered the eligibility question the `Object.assign(window, …)` shim
# existed to raise: **a name the inline script CALLS, and no longer DEFINES, has to be exported by
# some module AND that module has to be on the shim** — being exported was never enough, because
# `js/sys/comfy.js` was deliberately off it.
#
# ✅ §10 items 1 and 2 delete both halves of that question. The page calls nothing (there is no
# inline script) and publishes nothing (there is no shim), so the check has no subject — the same
# retirement as `test_webui_parsetime.py`'s scanner, for the same reason, in the same commit.
#
# 📌 WHAT IT BOUGHT, because deleting a test should have to say so: it is the check that made the
# shim's membership list a MEASURED property rather than a maintained one. Twice it caught a module
# exporting a name the page called while not being on the Object.assign — a ReferenceError on first
# click, invisible to every other test in the suite. Its vacuity guard also produced §11.15's third
# instance in this file: `assert len(called) > 200` went red at 192 on a healthy extraction, and the
# lesson (a number is the same mistake as a name, when the milestone drives the quantity down) is
# one of the four that §11.30 generalizes.
#
# ⚠️ WHAT REPLACES IT IS NOT NOTHING. `test_every_module_on_disk_is_imported_by_something` above now
# roots at `js/main.js` and is the surviving guard of this family — the failure mode it catches
# (drop one side-effect import, everything stays green, a panel dies silently) is exactly the one
# these two were about, and it is now the ONLY thing standing between a dropped import line and a
# dead feature. `test_every_function_the_browser_specs_drive_is_still_reachable` covers the other
# half: a spec caller is a caller.

def test_the_tab_bar_cannot_call_a_loader_before_the_modules_land():
    """🔴 THE TAB BAR IS CLICKABLE BEFORE THE CODE BEHIND THE TABS EXISTS.

    `$('tabs').addEventListener(…)` is inline top-level code, live from index.html:2962 — near the
    TOP of an 8,000-line block. `switchTab` is inline too, so it is always defined; the trap is that
    EIGHT of the loaders it calls are module-only (loadLibrary, loadBulk, kobLoadAll, kobPollStop,
    stLogStop, alignDevCols, loadDevices, pairLoad) and none of them exists until the shim has
    fetched and evaluated the whole module graph.

    ⚠️ AND THE SYMPTOM WAS NOT "the tab does not switch", which is what the design notes said for
    three milestones. `switchTab` does its highlight and its panel show/hide FIRST and calls the
    loaders after, so the tab opened EMPTY and the previous tab's pollers kept running.
    `if(name!=='kobold')kobPollStop()` is reached by every tab except Kobold, so which tab was
    clicked did not matter — they all died in the same place.

    The listener now defers to `window.__uiReady` and records `window.__pendingTab` instead, and
    js/main.js honors that click in preference to the remembered tab.
    """
    # 🔴 THE SUBJECT MOVED AT 7.3-m13 AND THE CLAIM DID NOT. §11.20 records this listener as the ONE
    # statement deliberately left in index.html for twelve milestones, because its existence AT PARSE
    # TIME was the feature: the tab bar's markup is parsed thousands of lines before the module graph
    # is fetched, so a user can click it during load. m13 deletes the classic script, so it is a
    # module body statement now — and the guard is MORE necessary rather than less, because deleting
    # the `__uiReady` dance would now look like removing vestigial code rather than removing a fix.
    #
    # ⚠️ THE WINDOW IS SMALLER AND NOT ZERO. js/ui/tabs.js evaluates when its imports resolve;
    # js/main.js sets `window.__uiReady` in ITS module body, and main.js is the last module in the
    # graph to run. A click landing between the two is still recorded rather than dropped.
    src = (_js_root() / "ui" / "tabs.js").read_text(encoding="utf-8")
    # ⚠️ REGEX, NOT `find`, SINCE 8.8-m10. `$()` became honestly nullable, so this call now reads
    # `/** @type {VEl} */ ($('tabs')).addEventListener(...)` and the exact byte sequence is gone.
    # `\)?` admits the cast's closing paren and nothing else — the CLAIM is unchanged: this still
    # pins the listener that `#tabs` is wired with, and the two body checks below are untouched.
    m = re.search(r"\$\('tabs'\)\)?\.addEventListener", src)
    assert m, ("the tab bar's click listener is gone from js/ui/tabs.js — it moved there "
               "from index.html at 7.3-m13; find it before deleting this")
    start = m.start()
    # ⚠️ THE STATEMENT, NOT THE LINE (8.3.2). This read the single LINE holding the
    # addEventListener call, which worked only while the whole listener was written on one line.
    # Prettier spreads it over four, so the guard being tested now sits two lines below the line
    # this found — and the test reported the fix as missing against code that has it. The
    # statement ends at the `});` in column 0, which is the only one inside this slice.
    end = src.find("\n});", start)
    assert end != -1, ("the tab bar's listener is no longer a statement ending at column 0 — "
                       "re-anchor this slice rather than deleting the two checks below")
    listener = src[start:end]
    assert "__uiReady" in listener, (
        "the tab bar's listener calls switchTab without checking that the module graph has "
        "landed. Every loader switchTab reaches for is module-only, so a click during page load "
        "opens an empty tab and leaks the previous tab's pollers. §11.6 item 3.\n  " + listener)
    assert "__pendingTab" in listener, (
        "the listener guards on __uiReady but throws the click away instead of recording it. A "
        "user who clicks during load then watches nothing happen, which is not better than the "
        "error it replaced — record the tab and let js/main.js apply it.\n  " + listener)


def test_main_js_opens_the_tab_bar_before_it_starts_awaiting_things():
    """🔴 THE ORDERING IS THE WHOLE FIX, AND IT IS THE EASY THING TO GET WRONG LATER.

    `window.__uiReady = true` has to run in main.js's MODULE BODY — which executes immediately
    after the shim's `Object.assign`, so every name switchTab needs is already published.

    Move it inside the boot IIFE and the guard still "works" while being far worse than the bug: the
    IIFE awaits loadGpus, loadVoices, loadAppSettings, loadEnhanceInfo, loadRenderRate, loadBooks
    and restoreBook first, so the tab bar would stay shut through eight network round trips instead
    of one module-graph load. The failure mode of getting this wrong is a page that feels broken for
    a second, which nobody will trace back to a line that reads correct.
    """
    main = (_js_root() / "main.js").read_text(encoding="utf-8")
    ready = main.index("window.__uiReady = true")
    # ⚠️ At COLUMN 0, not the first `(async()=>{` in the file — main.js's own header comment quotes
    # the IIFE while explaining where it used to live, and an unanchored `.index` finds that at
    # offset 74 and reports the fix as broken. It cost this test one red run.
    # ⚠️ `\s*` between the tokens since 8.3.2 — Prettier writes `(async () => {`. The COLUMN-0
    # anchor is untouched and still load-bearing, for the reason the comment above gives.
    m = re.search(r"^\(async\s*\(\)\s*=>\s*\{", main, re.M)
    assert m, "main.js's boot IIFE is gone — find it before trusting this test"
    iife = m.start()
    assert ready < iife, (
        "window.__uiReady is set inside main.js's boot IIFE rather than in the module body. That "
        "holds the tab bar shut until every boot fetch has resolved — a far wider window than the "
        "ReferenceError it was meant to close.")
    # ⚠️ A REGEX SINCE 8.3.2 — Prettier writes `window.__pendingTab || t || 'playground'`. Still
    # requires the remembered tab to be the LEFT operand of a `||`, which is the claim: it wins
    # over whatever the restored tab was. A mere mention of the name does not satisfy it, and the
    # file's own comments mention it three times.
    assert re.search(r"window\.__pendingTab\s*\|\|", main), (
        "main.js no longer honors a tab clicked while the modules were loading. The click is the "
        "more recent statement of intent and must win over the remembered tab.")


# ─────────────────────────────────────────────────────────────────────────────────────────────
# 🔴 THE FREE-NAME SCAN — the JS counterpart to test_no_undefined_names.py, and the guard whose
# The source-shape guard prevents these runtime-only ReferenceErrors.
#
# THE HOLE IT CLOSES. `test_every_named_import_is_actually_exported_by_its_target` above validates
# the imports that ARE WRITTEN. By construction it cannot see one that is MISSING — and a missing
# import is not a SyntaxError, it is a free identifier, which in a module is a ReferenceError at the
# moment the line runs. So it ships, and it ships silently.
#
# 🔴 AND THE BROWSER SPECS CANNOT CATCH IT, BECAUSE THE HARNESS RE-CREATES THE SHIM m13 DELETED.
# `tests/_websrc.mjs`'s PUBLISH_SPEC_SURFACE does `Object.assign(window, await import(…))` over the
# spec surface, so every EXPORTED name becomes a global in the spec browser. A module that forgot an
# import then resolves the name through the scope chain to `window` and passes — while the user, on
# a page with no shim, gets the ReferenceError. Six of the ten were masked exactly this way. **The
# suite was not merely blind to this class; it was actively hiding it.**
#
# WHAT IT ASSERTS, and why this shape has no false positives: a name USED bare in module B, BOUND
# nowhere in B (not imported, not declared at any scope, not a parameter), and DEFINED at module
# level in some other module A of this tree. That last clause is what makes it precise — it is the
# exact signature of this refactor's failure ("the name used to be a page global and now lives in
# A"), and it means an unknown browser global can never trip it. §11.30's rule holds: it asserts
# what the code IS, never how much of it there is.
_FREE_MODULE_DEF = re.compile(
    r"^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)", re.M)
# `$` is a real export (util/dom.js), so it cannot just be ignored — but `${` is interpolation,
# not a use of it. The trailing lookahead keeps `$(…)` and drops `${…}`. Without it every module
# using a template literal reports `$`.
_FREE_IDENT = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])(?!\{)")
_FREE_DECL = re.compile(r"\b(?:const|let|var|function|class)\s+([\w$]+)")
_FREE_DECL_PAT = re.compile(r"\b(?:const|let|var)\s*[\[{]([^\]}]*)[\]}]")
_FREE_FN_PARAMS = re.compile(r"\bfunction\s*[\w$]*\s*\(([^)]*)\)")
# ⚠️ THE KEYWORD LOOKAHEAD IS LOAD-BEARING. Without it this matches `if(enh){` as though `enh` were
# a parameter of a method called `if`, which silently binds every name that ever appears alone in a
# condition. That is precisely how `enh` in js/media/bulk.js stayed invisible: the file's
# `if(enh){` at :267 "declared" it, so the free read at :222 looked bound.
_FREE_METHOD_PARAMS = re.compile(
    r"(?<![\w$.])(?!(?:if|while|for|switch|catch|with|return|do|else)\s*\()[\w$]+\s*\(([^()]*)\)\s*\{")
_FREE_ARROW_PARENS = re.compile(r"\(([^()]*)\)\s*=>")
_FREE_ARROW_BARE = re.compile(r"(?<![\w$.])([\w$]+)\s*=>")
_FREE_CATCH = re.compile(r"\bcatch\s*\(\s*([\w$]+)")
_FREE_FOR = re.compile(r"\bfor\s*\(\s*(?:const|let|var)\s+([\w$]+)")
_FREE_KEY = re.compile(r"\b([\w$]+)\s*:")
_FREE_NESTED_SQ = re.compile(r"'[^'\n]*'")
_FREE_NESTED_DQ = re.compile(r'"[^"\n]*"')
# 🔴 DOTALL, WHICH `_IMPORT_FROM` ABOVE IS NOT — and the difference is not cosmetic here. Several
# modules wrap a long named-import list over two lines (js/media/voiceswap.js and js/st/chars.js
# both do), and without re.S the clause stops at the newline: this scan then sees only the first
# line's names, calls the rest unimported, and reports eight false positives on a clean tree. It
# was written that way first and that is exactly what happened.
# 📌 SUPERSEDED 9.0-m5: `_IMPORT_FROM` now carries re.S. This note used to say the missing flag
# would "under-check rather than false-alarm" and that widening the shared regex was too risky to
# do mid-review. The first half was wrong — a multi-line import matched NOTHING, so the module it
# named was reported as an unreachable orphan — and the second half is what kept a known-wrong
# scanner in place until it failed. Widened, bounded with `[^;]` so re.S cannot cross a statement,
# and the whole module suite re-run behind it.
_FREE_IMPORT_FROM = re.compile(
    r"^[ \t]*import\s+(.+?)\s+from\s+['\"]([^'\"]+)['\"]", re.M | re.S)

_FREE_KEYWORDS = set("""if else for while do switch case break continue return function class const
let var new typeof instanceof in of delete void this super null true false undefined NaN Infinity
try catch finally throw yield await async import export default extends static get set from as with
debugger""".split())

# Browser/JS globals a module may legitimately name. Deliberately generous: a name wrongly listed
# here can only cause a MISS, and the "defined elsewhere in this tree" clause above is what actually
# carries the precision — a global that is also a module-level name in js/ would be caught anyway.
_FREE_GLOBALS = set("""window document console Math JSON Date Array Object String Number Boolean
RegExp Error TypeError RangeError Promise Set Map WeakMap WeakSet Symbol Proxy Reflect BigInt
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI
setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame fetch
alert confirm prompt localStorage sessionStorage navigator location history screen performance URL
URLSearchParams FormData Blob File FileReader Image Audio Video AbortController Event CustomEvent
MutationObserver IntersectionObserver ResizeObserver EventSource WebSocket Worker Notification
getComputedStyle structuredClone queueMicrotask crypto TextEncoder TextDecoder Intl atob btoa
Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array
ArrayBuffer DataView HTMLElement Element Node NodeList DOMParser XMLHttpRequest AudioContext
MediaRecorder webkitAudioContext arguments globalThis eval""".split())


def _free_blank_nested(s: str) -> str:
    """`_mask_literals` leaves `${…}` VISIBLE because it is code — but a string nested INSIDE one
    stays visible with it. `'Unavailable on this box.'` then donates the identifier `on`, and
    `class="sm dl"` donates `sm`; both are real exports elsewhere in the tree, so both were
    false positives until this second pass. Anything still quoted after the first mask is nested
    inside an interpolation, so blanking it is safe."""
    for rx in (_FREE_NESTED_SQ, _FREE_NESTED_DQ):
        s = rx.sub(lambda m: m.group(0)[0] + " " * (len(m.group(0)) - 2) + m.group(0)[0], s)
    return s


def _free_bindings(src: str) -> set[str]:
    """Every name BOUND in this source, by any form. Generous on purpose: a binding form missed
    here becomes a false positive, while one over-collected can only cause a miss."""
    # 🔴 BLOCK-SCOPED `const`/`let` ARE DELIBERATELY LEFT OUT — `_free_block_scoped` owns them and
    # decides them per use site. Everything else (params, `var`, `function`, `class`, `catch`,
    # loop vars) stays file-wide. ⚠️ IT MUST BE FILTERED HERE RATHER THAN SUBTRACTED FROM THE
    # FINISHED SET: a name can be a parameter in one function AND a block `const` in another —
    # `on` is exactly that (`function wbSaveBusy(kind, on, btn)` in wb/edit.js) — and subtracting
    # by name afterward threw away the parameter binding too, inventing three false positives.
    blocked = {(a, b) for spans in _free_block_scoped(src).values() for (a, b) in spans}
    out = {m.group(1) for m in _FREE_DECL.finditer(src)
           if not (m.group(0).lstrip().startswith(("const", "let"))
                   and any(a <= m.start() <= b for a, b in blocked))}
    for m in _FREE_DECL_PAT.finditer(src):
        for part in re.split(r"[,\s]+", m.group(1)):
            part = part.split(":")[-1].split("=")[0].strip().lstrip(".")
            if part and re.fullmatch(r"[\w$]+", part):
                out.add(part)
    for rx in (_FREE_FN_PARAMS, _FREE_METHOD_PARAMS, _FREE_ARROW_PARENS):
        for m in rx.finditer(src):
            for part in re.split(r"[,\s]+", m.group(1)):
                part = part.split("=")[0].strip().lstrip(".").strip("{}[]")
                if part and re.fullmatch(r"[\w$]+", part):
                    out.add(part)
    for rx in (_FREE_ARROW_BARE, _FREE_CATCH, _FREE_FOR):
        out |= {m.group(1) for m in rx.finditer(src)}
    out |= _free_later_declarators(src)
    return out


def _free_later_declarators(src: str) -> set[str]:
    """The SECOND and later names of a multi-name declaration: `busy` in
    `const cur = $('vtGpu').value, busy = vtBusyCards();`.

    🔴 `_FREE_DECL` sees only the name right after the keyword, so every later declarator read as a
    free use. That was harmless until another module defined the same name at module level — in a later change,
    `st/extension-settings.js` gained a module `let busy`, and voice/training.js:577's LOCAL `busy`
    was reported as "uses `busy` … and never imports it". Collected file-wide (the direction that
    can only cause a miss, per `_free_block_scoped`), by walking each declaration to its `;` at
    bracket depth 0 and taking every `, name =` at that depth — a comma inside a call's arguments or
    an object literal is at depth > 0 and is not a declarator."""
    out: set[str] = set()
    for m in re.finditer(r"\b(?:const|let|var)\s+", src):
        depth, i = 0, m.end()
        while i < len(src):
            ch = src[i]
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                if depth == 0:
                    break
                depth -= 1
            elif ch == ";" and depth == 0:
                break
            elif ch == "," and depth == 0:
                d = re.match(r",\s*([A-Za-z_$][\w$]*)\s*=(?![=>])", src[i:])
                if d:
                    out.add(d.group(1))
            i += 1
    return out


def _free_block_scoped(src: str) -> dict[str, list[tuple[int, int]]]:
    """`const`/`let` declarations that are NOT at module level, each with the span of the block it
    is confined to. Everything else `_free_bindings` collects stays file-wide.

    🔴 THIS EXISTS BECAUSE A FLAT, FILE-WIDE BINDING SET MISSES A REAL BUG, AND ONE DID. In
    js/media/bulk.js three separate functions declare `const enh = blkMode==='enhance'` — a
    BOOLEAN — while `loadBulk` reads `enh.choices`, meaning sys/enhance.js's capability object,
    which the file never imported. A file-wide set sees `enh` as "declared here" and stays quiet;
    the user gets a ReferenceError on the first visit to the Bulk tab. The name being locally
    taken WITH A DIFFERENT MEANING is what made it invisible to a reader too.

    ⚠️ ONLY `const`/`let`, and only the innermost enclosing braces. `var` and `function` hoist to
    the enclosing FUNCTION rather than the block, and parameters belong to a span this cheap scan
    does not compute — so all of those are left file-wide by `_free_bindings`. That is the
    deliberate direction to be wrong in: a binding treated as wider than it is can only cause a
    MISS, while one treated as narrower invents a false positive, and a guard that cries wolf is
    a guard somebody deletes."""
    opens, spans = [], {}
    for i, ch in enumerate(src):
        if ch == "{":
            opens.append(i)
        elif ch == "}" and opens:
            spans[opens.pop()] = i
    starts = sorted(spans)
    out: dict[str, list[tuple[int, int]]] = {}
    for m in re.finditer(r"\b(?:const|let)\s+([\w$]+)", src):
        pos = m.start()
        inner = None
        for s in starts:
            if s < pos <= spans[s] and (inner is None or s > inner):
                inner = s
        if inner is not None:                    # module-level declarations stay file-wide
            out.setdefault(m.group(1), []).append((inner, spans[inner]))
    return out


def _free_imported(src: str) -> set[str]:
    """The LOCAL name each import binds — `import {a as b}` binds `b`, which is the opposite end
    from `test_every_named_import_is_actually_exported_by_its_target`, which wants `a`."""
    out = set()
    for clause, _spec in _FREE_IMPORT_FROM.findall(src):
        m = _NAMED.search(clause)
        if m:
            for part in m.group(1).split(","):
                part = part.strip()
                if part:
                    out.add(part.split(" as ")[-1].strip())
        head = clause.split("{")[0]
        d = re.match(r"^\s*(?:([\w$]+)\s*,?|\*\s+as\s+([\w$]+))", head)
        if d:
            out.add(d.group(1) or d.group(2))
    return out


def _free_name_hits(root: Path) -> list[str]:
    """Shared by the guard and its vacuity test so the two can never drift apart."""
    from test_webui_parsetime import _mask_literals
    files = sorted(root.rglob("*.js"))
    assert files, f"no modules under {root} — this scan would pass vacuously"
    srcs, defined_in = {}, {}
    for p in files:
        # 🔴 `...` BECOMES BLANKS BEFORE ANYTHING ELSE LOOKS AT THE SOURCE. `_FREE_IDENT`'s
        # lookbehind rejects a name preceded by `.` so that `o.wbSetEdits` is read as a property
        # and not as a use — and spread wears the same three characters. `edits.push(...wbSetEdits
        # (kind))` in js/wb/open.js therefore looked like a property access, and THE WORST BUG OF
        # THE TWELVE — every Save in the World Book editor throwing — was invisible to this scan
        # until the dots were blanked. Blanking leaves the identifier free-standing and a rest
        # parameter `(...args)` still yields `args`.
        srcs[p] = _free_blank_nested(_mask_literals(p.read_text(encoding="utf-8"))).replace("...", "   ")
        rel = p.relative_to(root).as_posix()
        for m in _FREE_MODULE_DEF.finditer(srcs[p]):
            defined_in.setdefault(m.group(1), []).append(rel)
    hits = []
    for p in files:
        src = srcs[p]
        rel = p.relative_to(root).as_posix()
        blocks = _free_block_scoped(src)
        # `_free_bindings` has already excluded block-scoped `const`/`let`; those are decided per
        # use site against `blocks` below.
        bound = _free_bindings(src) | _free_imported(src) | _FREE_KEYWORDS | _FREE_GLOBALS
        keys = {m.group(1) for m in _FREE_KEY.finditer(src)}
        for n in sorted({m.group(1) for m in _FREE_IDENT.finditer(src)} - bound):
            if n in keys:
                continue
            owners = [o for o in defined_in.get(n, []) if o != rel]
            if not owners:
                continue
            # 🔴 THE TRAILING CLAUSE MAKES THIS A CODE-POSITION TEST, AND IT IS WHAT KEEPS ENGLISH
            # PROSE OUT. `_mask_literals` blanks a template's text but leaves `${…}` visible as
            # code — and a template NESTED INSIDE one of those interpolations is therefore never
            # blanked at all. js/pg/playground.js has exactly that: `…✨ enhance on finish…`, whose
            # `on` is a real export of js/voice/autoplay.js, so it reported as a missing import.
            # A genuine use is followed by punctuation — `sizeTip(`, `enh.`, `vcTab===`,
            # `${ETA_UNKNOWN}` — while a word in a sentence is followed by another word. Requiring
            # the next non-space character to be non-alphabetic costs nothing real and drops the
            # last false positive. ⚠️ It can MISS a bare trailing reference (`return sizeTip` at a
            # line end followed by a word); that is the direction to be wrong in.
            hit = re.compile(r"(?<![\w$.])" + re.escape(n)
                             + r"(?![\w$])(?!\{)(?=\s*(?:[^\sA-Za-z_$]|$))")
            spans = blocks.get(n, [])
            # Report the first use that no block declaring `n` encloses. If every use sits inside
            # one, the name is genuinely local everywhere and there is nothing to say.
            free_at = next((m.start() for m in hit.finditer(src)
                            if not any(a <= m.start() <= b for a, b in spans)), None)
            if free_at is None:
                continue
            line = src.count("\n", 0, free_at) + 1
            hits.append(
                rel + ":" + str(line) + " uses `" + n + "`, defined in "
                + ", ".join(owners) + ", and never imports it")
    return hits


def test_no_module_uses_a_name_it_never_imports():
    """Catch unresolved module names that otherwise fail only when a feature runs.

    These bugs can leave the page loaded while saves, polls, or controls fail with `ReferenceError`.
    False-positive cases for the scanner are covered by
    `test_the_free_name_scan_is_not_vacuous` below.
    """
    hits = _free_name_hits(_js_root())
    assert not hits, (
        "a module uses a name it never imports — that is a ReferenceError the moment the line "
        "runs, not a load error, so the page boots and the feature is simply dead:\n  "
        + "\n  ".join(hits))


def test_the_free_name_scan_is_not_vacuous(tmp_path):
    """🔴 A SCAN THAT REPORTS ZERO IS WORTHLESS UNTIL IT HAS BEEN SHOWN TO REPORT SOMETHING. This
    plants the exact shape of the ten — a module that calls a name another module defines, without
    importing it — and asserts the scan names the file, the name and the owner.

    ⚠️ IT ALSO PLANTS THE TWO FALSE POSITIVES THAT COST THE SCAN A REWRITE, in `clean.js`: a
    nested string inside a template interpolation (`'a b on c'` — `on` is a real export), and a
    `${…}` interpolation (which makes a bare `$` look like a use of util/dom.js's `$`). Both must
    stay silent, or the scan is one that cries wolf and gets deleted by whoever it wakes."""
    (tmp_path / "owner.js").write_text(
        "export const sizeTip = c => c.size;\nexport const on = 1;\nexport const $ = i => i;\n"
        "export const enh = {choices: [8]};\nexport function wbSetEdits(k){ return [k]; }\n",
        encoding="utf-8")
    # Three guilty modules, one per shape that actually shipped.
    (tmp_path / "guilty_plain.js").write_text(          # a bare call, the commonest shape
        "export const row = c => `<td>${sizeTip(c)}</td>`;\n", encoding="utf-8")
    (tmp_path / "guilty_spread.js").write_text(         # 🔴 wb/open.js's shape: `...` is not a `.`
        "export function go(k){ const e = []; e.push(...wbSetEdits(k)); return e; }\n",
        encoding="utf-8")
    (tmp_path / "guilty_shadow.js").write_text(         # 🔴 bulk.js's shape: same name, other scope
        "export function paint(mode){ const enh = mode === 'enhance'; return enh ? 1 : 2; }\n"
        "export function load(){ return enh.choices.length; }\n", encoding="utf-8")
    (tmp_path / "clean.js").write_text(
        "import { sizeTip, $ } from './owner.js';\n"
        "export function busy(kind, on, btn){ return on ? kind : btn; }\n"
        "export const ok = c => `<i title=\"sm dl\">${sizeTip(c)}</i>` + $('x')"
        " + (c ? 'a b on c' : `<b>enhance on finish</b>`);\n",
        encoding="utf-8")
    hits = sorted(_free_name_hits(tmp_path))
    assert len(hits) == 3, "expected exactly the three planted defects, got " + str(hits)
    assert "guilty_plain.js" in hits[0] and "sizeTip" in hits[0], hits[0]
    assert "guilty_shadow.js" in hits[1] and "`enh`" in hits[1], hits[1]
    assert "guilty_spread.js" in hits[2] and "wbSetEdits" in hits[2], hits[2]


_SPEC_SURFACE_ARRAY = re.compile(r"export\s+const\s+SPEC_SURFACE\s*=\s*\[(.*?)\]", re.S)


def _spec_surface() -> list[str]:
    """The module list `tests/_websrc.mjs` publishes, read out of the .mjs itself.

    ⚠️ PARSED, NOT DUPLICATED. Copying the 46 paths into this file would create a second list that
    drifts from the real one, and the drift would be invisible in exactly the direction that
    matters: this test would keep checking modules the harness no longer publishes while saying
    nothing about the ones it does."""
    src = (Path(__file__).parent / "_websrc.mjs").read_text(encoding="utf-8")
    m = _SPEC_SURFACE_ARRAY.search(src)
    assert m, "SPEC_SURFACE is no longer an array literal in tests/_websrc.mjs — find it before "\
              "trusting this test, which would otherwise pass on an empty list"
    return re.findall(r"['\"]([^'\"]+)['\"]", m.group(1))


def test_every_module_the_spec_surface_publishes_is_actually_served(client):
    """🔴 NOTHING PINNED `SPEC_SURFACE` AGAINST THE ROUTE, AND THE HARNESS COULD NOT TELL YOU. Until
    the 7.3 code review `_websrc.mjs`'s PUBLISH_SPEC_SURFACE wrapped its import in `try { … } catch
    (e) {}` and returned `true` regardless — so a module renamed out from under that list produced
    no error, no log line and no failure. Every spec that awaits it carried on asserting against a
    page missing exactly the names it was about to test, and the eleven browser specs that depend on
    it would have gone quietly weaker rather than red.

    ⚠️ THIS IS THE DETERMINISTIC HALF, AND IT EXISTS BECAUSE THE BROWSER HALF CANNOT BE. Making the
    harness fatal on any publish failure turned `test_scene_edit_browser.py` red with 19 of the 46
    reporting "Failed to fetch dynamically imported module" — under `-n 16` only; alone, the same
    spec publishes all 46 cleanly. That failure is the suite's own load against a dev server, so the
    harness now probes with `fetch()` and tolerates a transport loss while still failing hard on a
    module that genuinely will not serve or will not evaluate. The question worth asking — *is every
    module on that list reachable at all?* — is asked HERE instead, through the test client, where
    there is no browser, no concurrency and nothing to be flaky about.

    📌 It checks the ROUTE, not just the filesystem, because the route is what a spec actually uses:
    a file present on disk but unreachable (wrong suffix, outside the js root, a route regression)
    fails a spec in precisely the way this list is supposed to prevent."""
    surface = _spec_surface()
    missing = []
    for rel in surface:
        r = client.get("/webui/js/" + rel)
        if r.status_code != 200:
            missing.append(f"{rel} -> HTTP {r.status_code}")
    assert not missing, (
        "tests/_websrc.mjs's SPEC_SURFACE names modules the route will not serve, so the browser "
        "specs that publish it are silently missing those names:\n  " + "\n  ".join(missing))


def test_the_spec_surface_list_is_not_vacuous():
    """A list that has become empty, or a parse that has silently stopped finding it, would make the
    check above pass while asserting nothing at all — the exact shape of the bug it is here to
    prevent, one level up."""
    surface = _spec_surface()
    assert len(surface) > 40, (
        f"SPEC_SURFACE has {len(surface)} entries; it published 46 when this was written. A list "
        "that has shrunk that far is a harness that has stopped publishing most of the page.")
    assert all(s.endswith(".js") for s in surface), surface
    assert len(set(surface)) == len(surface), "SPEC_SURFACE has duplicates"
    # Every published module must also be a real file — the route check above would catch a rename,
    # but this names the disk side explicitly so a failure says which of the two is wrong.
    assert not [s for s in surface if not (_js_root() / s).is_file()], (
        "SPEC_SURFACE names a module that is not on disk")


def test_every_source_row_that_paints_a_star_carries_favorite():
    """The retained Stems song row and click handler must carry the same favorite state."""
    src = (_js_root() / "media" / "stems.js").read_text(encoding="utf-8")

    def _code(chunk):
        """🔴 COMMENTS OUT, OR THIS TEST GRADES ITS OWN PROSE.

        Verified by sabotage, which is the only reason this exists: with the fix reverted the
        test still PASSED. The comment vsSources() now carries — explaining the bug — contains
        the literal `{favorite: !cur}`, and a key-scanning regex cannot tell that from a real
        field, so the guard was grading the explanation of the bug instead of the bug.
        """
        return re.sub("//[^" + chr(10) + "]*", "", chunk)

    def _body(fn):
        """The function's body by BRACE MATCHING, not a closing-brace-at-column-0 regex.

        Both of these end their last statement and the function on ONE line (`...;}`), so an
        anchor on a newline-then-brace matches nothing and this test fails as "the function is
        gone" — which reads like the code was deleted rather than like the pattern was wrong.
        It cost this test one red run.
        """
        i = src.index("{", src.index(fn))
        depth = 0
        for j in range(i, len(src)):
            depth += (src[j] == "{") - (src[j] == "}")
            if depth == 0:
                return src[i + 1:j]
        raise AssertionError(f"unbalanced braces reading {fn}")

    assert "function ssOneSong(" in src, "the retained Stems song row is missing"
    row = _body("function ssOneSong(")
    assert re.search(
        r"favBtn\(\s*'favsong2'\s*,\s*s\.ref\s*,\s*s\.favorite\s*\)", row), (
            "the Stems song row must pass its favorite value to the visible star")

    marker = "const fs = /** @type {HTMLElement} */ (e.target).dataset.favsong2;"
    assert marker in src, "the Stems song-star click handler is missing"
    handler = src[src.index(marker):src.index("const qa =", src.index(marker))]
    assert re.search(
        r"(?:\(ss\.songs\s*\|\|\s*\[\]\)|ss\.songs)\.find\(\s*([\w$]+)"
        r"\s*=>\s*\1\.ref\s*===\s*fs\s*\)", handler), (
        "the click handler must look up the clicked song before toggling its favorite")
    assert re.search(r"favToggle\([^\n]*s\s*&&\s*s\.favorite", handler), (
        "the click handler must send the current favorite value so the toggle remains reversible")
    assert "await ssLoadSongs()" in handler, (
        "the click handler must reload the retained song list after a successful toggle")


def test_no_tray_assigns_its_preview_src_outside_the_guard():
    """🔴 ASSIGNING `<audio>.src` RELOADS THE ELEMENT EVEN WITH THE IDENTICAL URL.

    The browser tears the media resource down and restarts at 0. Tray renderers run for reasons
    that have nothing to do with which clip is loaded — a list refresh, a filter keystroke, a star
    toggled, a poll landing — so a bare `el.src = u` inside one means the preview you are listening
    to restarts a second in, repeatedly, with the cause nowhere near the sound.

    `ui/trayslot.js` holds the guard (reassign only when `dataset.ref` changed) and 7.5.12 routed
    all four callers through it. This is the regression: a fifth tray, or a "simplification" of an
    existing one, that assigns the src directly again.

    ⚠️ The failure it protects against is INAUDIBLE IN A TEST and obvious to a human — nothing
    throws, no request fails, the element just starts over. That asymmetry is exactly why it is
    worth a static check rather than trusting a browser spec to notice.
    """
    offenders = []
    for path in sorted(_js_root().rglob("*.js")):
        if path.name == "trayslot.js":
            continue                       # the one place the assignment belongs
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("//")[0]
            if re.search(r"TrayAudio'\)\.src\s*=", code) or re.search(r"TrayAudio\"\)\.src\s*=", code):
                offenders.append(f"{path.relative_to(_js_root())}:{n}: {line.strip()[:90]}")
    assert not offenders, (
        "a tray preview player has its `src` assigned outside ui/trayslot.js. Assigning src "
        "reloads the element even when the URL is unchanged, so any re-render restarts playback.\n  "
        + "\n  ".join(offenders)
        + "\n  Call trayAudio(el, ref, url) instead — it only reassigns when the ref changed.")


# 🔴 EVERY HEADLESS CHROME MUST BE GIVEN ITS OWN TEMP, AND THE SCAN MUST NOT READ THE COMMENT
# THAT EXPLAINS WHY. `--user-data-dir` does NOT move Chromium's scratch: a fresh profile unpacks
# the bundled component extensions through ScopedTempDir, which resolves against base::GetTempDir()
# — the process's TMP/TEMP — so a spawn that inherits Node's environment drops
# `scoped_dir<pid>_<rand>` in %TEMP% ROOT, outside the tree cleanup() deletes. 609 orphans /
# 265 MB had accumulated on a Windows host before detection, because no Windows
# ever collects %TEMP% — not on boot, not on any schedule.
#
# ⚠️ THE PROSE TRAP IS REAL HERE, AND IT IS SELF-INFLICTED. The fix ships with a six-line comment
# above it in all 46 files, and that comment contains the words TEMP and TMP. A scan over the raw
# text would be satisfied by the EXPLANATION of the fix and would stay green after somebody
# deleted the fix itself. So comments are stripped before anything is matched.
#
# ⚠️ TWO SPELLINGS, BECAUSE THE TREE HAS TWO. Most specs interpolate — `--user-data-dir=${profile}`
# — but `ace_draft_persistence_` and `ace_draft_twotab_` concatenate: `'--user-data-dir=' + profile`.
# The first version of this scan knew only the template form and reported those two as having no
# profile at all, which is the failure mode a census has: it reads as a finding about the code when
# it is a gap in the reader.
_SPAWN_UDD = re.compile(r"""--user-data-dir=(?:\$\{(\w+)\}|['"]\s*\+\s*(\w+))""")


def _spec_code_without_comments(text):
    """The spec's code with `//` comments removed, line by line — the same shape the tray-audio
    scan above uses. Enough for this job: the three things matched here
    (`--user-data-dir=${x}` inside a template literal, `TEMP: x`, `...process.env`) never
    contain a `//`."""
    out = []
    for line in text.splitlines():
        if line.strip().startswith("//"):
            continue
        out.append(line.split("//")[0])
    return "\n".join(out)


def test_every_headless_chrome_spawn_gives_the_child_its_own_temp():
    """A spec that spawns Chrome without an `env` override leaks two directories per launch into
    the OS temp root, permanently.

    📌 Pinned as a FINGERPRINT, not a tally. The count of browser specs is 46 today and was 22
    when `ui/filesafe.js` wrote it into a comment; a number in prose stops tracking the tree the
    moment somebody adds a spec, which is exactly how that one went stale. What is asserted is
    that the identifier interpolated into `--user-data-dir` is the SAME identifier assigned to
    both TEMP and TMP — so a new spec is subject to this on the day it is written.

    📌 Both names, because Windows hands Chromium whichever of TEMP/TMP it has.
    """
    specs = []
    for path in sorted(Path(__file__).parent.glob("*.mjs")):
        text = path.read_text(encoding="utf-8")
        if "--headless=new" in text:
            specs.append((path, _spec_code_without_comments(text)))

    # 🔴 A CENSUS THAT FOUND NOTHING PASSES EVERY ASSERTION BELOW. This is the floor that stops a
    # moved directory or a renamed flag from quietly turning the whole test into a no-op.
    assert len(specs) >= 40, (
        f"only {len(specs)} browser spec(s) matched '--headless=new' under tests/; "
        "expected at least 40. If specs moved or the flag changed, fix the scan rather than "
        "lowering the floor.")

    bad = []
    for path, code in specs:
        m = _SPAWN_UDD.search(code)
        if not m:
            bad.append(f"{path.name}: spawns headless Chrome but has no `--user-data-dir=${{var}}`")
            continue
        var = m.group(1) or m.group(2)
        if not re.search(r"env:\s*\{\s*\.\.\.process\.env", code):
            bad.append(f"{path.name}: spawn options carry no `env: {{ ...process.env, ... }}`")
            continue
        missing = [n for n in ("TEMP", "TMP") if not re.search(rf"\b{n}:\s*{var}\b", code)]
        if missing:
            bad.append(f"{path.name}: env does not point {'/'.join(missing)} at `{var}`")

    assert not bad, (
        "a browser spec spawns headless Chrome without redirecting the child's TEMP into the "
        "profile it deletes. Chromium's unpack scratch follows the PROCESS temp, not "
        "--user-data-dir, so every launch orphans two `scoped_dir*` directories in %TEMP% root "
        "and nothing on Windows ever collects them.\n  " + "\n  ".join(bad)
        + "\n  Add `env: { ...process.env, TEMP: <profile>, TMP: <profile> }` to the spawn "
          "options — both names, and the same identifier `--user-data-dir` uses.")
