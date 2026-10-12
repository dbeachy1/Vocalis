"""Every URL built by the browser must resolve to a route registered by the server. The source scan catches client/server drift, including routes used by the Curate grid."""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "src" / "vocalis" / "web"
JS = ROOT / "src" / "webui" / "js"

#: 🔴 `route` INCLUDED, AND IT IS 266 OF THE 300-ODD REGISTRATIONS. A first draft matched only
#: get/post/put/delete and reported 249 false "missing routes" — a scanner that cannot see the
#: dominant idiom does not report nothing, it reports everything.
ROUTE_RE = re.compile(r"@(?:bp|app)\.(?:route|get|post|put|delete|patch)\(\s*[\"']([^\"']+)[\"']")

#: The app's own URLs, as written in the client. Anything not starting with `/` is somebody
#: else's (a CDN, a data: URI, a fragment).
URL_RE = re.compile(r"[\"'`](/(?:lora|productions|voices|stems|songs|speech|clips|playground"
                    r"|system|folders|wbedit|books|comfyui|pair|bulk|nomi|kobold|ace|cleanup"
                    r"|train|swap|book)[^\"'`\s]*)[\"'`]")
PLACE = re.compile(r"\$\{[^}]*\}")


def strip_comments(src: str) -> str:
    """🔴 A SCANNER READS PROSE AS CODE. The comment above the FIXED line in `lora.js` documents
    the broken URL it replaced, and greps identically to the bug — this scanner reported the fix
    as the defect until it learned to skip comments. Blanked, not deleted, so line numbers hold.

    ⚠️ Only whole-line `//` and `/* */`. A TRAILING `//` is left alone: it cannot be told from the
    one inside `'http://…'` without a parser, and a wrong strip loses a real URL — a false
    NEGATIVE, which is the direction that costs something.
    """
    src = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S)
    return "\n".join("" if ln.lstrip().startswith("//") else ln for ln in src.splitlines())


def route_regex(rule: str) -> re.Pattern:
    """`/a/<x>/b` → a regex in which `<x>` is exactly ONE path segment.

    ⚠️ `[^/]+`, never `.+`. A greedy placeholder would let `/lora/thumb/X/X` match
    `/lora/subjects/<id>` and the guard would pass on the very bug it exists to catch.
    """
    parts = ["[^/]+" if s.startswith("<") and s.endswith(">") else re.escape(s)
             for s in rule.split("/")]
    return re.compile("^" + "/".join(parts) + "$")


@pytest.fixture(scope="module")
def routes():
    seen = set()
    for p in sorted((ROOT / "src").rglob("*.py")):
        seen.update(ROUTE_RE.findall(p.read_text(encoding="utf-8")))
    return [(r, route_regex(r)) for r in sorted(seen)]


def resolves(url: str, routes) -> bool:
    """Does this client URL correspond to some registered route?

    📌 THREE SHAPES, because the client builds URLs three ways:
      · whole            `/lora/subjects/X/generated/X.png`
      · concatenated     `/lora/subjects/X/face/candidates/` + name
      · a poll BASE      `/cleanup`, handed to `spDriveJob`, which does `base + '/' + jid`
    The last one is why a bare `/cleanup` is not a defect, and it is checked by appending ONE
    segment — never more, or `/lora/thumb/X/X` would find a match three segments down.
    """
    if any(rx.match(url) for _, rx in routes):
        return True
    if url.endswith("/") and any(r.startswith(url) or rx.match(url + "X") for r, rx in routes):
        return True
    return any(rx.match(url.rstrip("/") + "/X") for _, rx in routes)


def client_urls():
    """(file, line, raw, normalized) for every app URL literal in the client."""
    out = []
    for p in sorted(JS.rglob("*.js")):
        src = strip_comments(p.read_text(encoding="utf-8"))
        for m in URL_RE.finditer(src):
            raw = m.group(1).split("?")[0]
            url = PLACE.sub("X", raw)
            if "${" in raw and url == raw:        # an unresolvable template — skip, don't guess
                continue
            out.append((p, src[:m.start()].count("\n") + 1, raw, url))
    return out


# ── the census ──────────────────────────────────────────────────────────────

def test_every_client_url_resolves_to_a_route(routes):
    """🔴 THE DEFECT. `/lora/thumb/<sid>/<id>` had no route for the whole of 9.0."""
    bad = [f"{p.relative_to(ROOT).as_posix()}:{ln}  {raw}"
           for p, ln, raw, url in client_urls() if not resolves(url, routes)]
    assert not bad, "the client requests URLs the server does not serve:\n  " + "\n  ".join(bad)


# ── and the guard's own guards ──────────────────────────────────────────────

def test_the_scanner_is_actually_looking_at_something(routes):
    """⚠️ A CENSUS THAT FINDS NOTHING PASSES. If a rename empties either side — the JS moves, the
    decorator idiom changes — this test would go green while checking zero URLs against zero
    routes. The floors are well under the real figures (371 URLs, 300+ routes) and exist only to
    fail loudly when the scanner stops seeing the code."""
    assert len(routes) > 150, f"only {len(routes)} routes found - the extractor has gone blind"
    assert len(client_urls()) > 200, "almost no client URLs found - the JS tree moved"


def test_the_guard_catches_the_defect_it_was_written_for(routes):
    """🔴 MUTATION TEST, OR IT IS DECORATION. The exact URL that shipped must still be rejected —
    including through `resolves`, whose base-path relaxation is the part most likely to be widened
    later until it accepts anything."""
    assert not resolves("/lora/thumb/X/X", routes), (
        "the guard would now pass the broken Curate URL it was written to catch"
    )
    assert resolves("/lora/subjects/X/generated/X.png", routes), "the real URL must resolve"


def test_a_url_in_a_comment_is_not_read_as_code():
    """📌 Documentation ABOUT an absence greps identically to the presence — the failure recorded
    in `feedback_a_scanner_reads_prose_as_code.md`, hit again by this very file."""
    src = "// the old one was '/lora/thumb/a/b'\nconst u = '/lora/subjects/x';\n"
    assert "/lora/thumb" not in strip_comments(src)
    assert "/lora/subjects/x" in strip_comments(src)


def test_a_placeholder_matches_one_segment_only(routes):
    """⚠️ THE WINDOW, NOT THE ASSERTION. With `.+` instead of `[^/]+` every URL matches something
    and the census passes on any input at all."""
    rx = route_regex("/lora/subjects/<subject_id>")
    assert rx.match("/lora/subjects/abc")
    assert not rx.match("/lora/subjects/abc/extra"), "a placeholder swallowed a path separator"
