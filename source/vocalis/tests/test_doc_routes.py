"""Every route path the 5.0 docs name must actually exist.

This is a class of error that has cost two live sessions, not a tidiness rule:

  * `/admin/credentials` was named in THREE documents and never existed. The app answers it 404.
    A session drove it, got the 404, and spent the run deciding whether the route was missing or
    the box was broken.
  * "There is no RVC import route" was concluded from a search scoped to `/voiceswap/…`, written
    into a handoff, copied into TESTING_PLAN §3d, and an open question was built on top of it.
    `POST /voices/rvc/import` had existed since 4.6. §3d was never blocked.

Prose is not checked by anything, so a wrong path outlives every review — it reads fine, and only
someone driving the live box finds out. This makes the check mechanical: the decorators are the
ground truth, and a doc that disagrees fails here instead of during a live session.

Scope is deliberately the docs a session ACTS on. The 2.x/4.x design docs describe routes that
were real when they were written; auditing those would report history as if it were a defect.
"""
import re
from pathlib import Path

import pytest

from conftest import REPO_ROOT

SRC = REPO_ROOT / "src"
DOCS = REPO_ROOT / "docs"
IN_SCOPE = re.compile(r"^(TESTING_PLAN_5_0|DESIGN_5_0|SPEC_5_0|DEPLOYMENT_QA_5_0|SWEEP_5_0)")

# Route-shaped things in backticks that are NOT routes of ours. Each needs a reason — the point
# of the list is that adding to it is a decision, not a reflex. A genuinely wrong path must never
# be silenced by appending it here.
#
# 🔴 THE CONVENTION, when you need to write about a route that does NOT exist: name it in PLAIN
# TEXT, not backticks. The audit reads a backticked path as a claim, so quoting a dead one as code
# forces an exemption, and every exemption is a hole this test cannot see through. /admin/credentials
# predates the convention and is heavily formatted in two places; leave it and follow the rule in
# new prose. (SPEC_5_0_M2_5's /stems/split correction is written that way and needs no entry here.)
NOT_OUR_ROUTES = {
    "/admin/credentials": "the cautionary example itself — cited BECAUSE it never existed",
    "/audio":             "a suffix in prose (“its /audio went 404”), not a whole path",
    "/v1":                "a prefix; the three real doors are named beside it",
    "/data":              "a host data partition",
    "/swap.img":          "a host swapfile path",
}

# KoboldCPP's own HTTP API and host filesystem paths — never ours, never worth listing one by one.
FOREIGN = ("/api/", "/home/", "/scratch", "/ai-", "/var/", "/etc/", "/tmp", "/dev/", "/opt/",
           "/usr/", "/proc")
FILEISH = (".py", ".md", ".yaml", ".yml", ".json", ".html", ".js", ".sh", ".wav", ".mp3", ".pth",
           ".index", ".epub", ".docx", ".zip", ".log", ".txt", ".css", ".jsonl")

CLAIM = re.compile(r"`(?:(?:GET|POST|PUT|DELETE|PATCH)\s+)?(/[A-Za-z0-9_\-<>:/.]*)`")


def _route_patterns():
    """Every @app.route path, as a regex. `<name>` matches one segment, `<path:name>` matches
    many — so a doc naming the CONCRETE /bulk/current/cleanup matches /bulk/current/<mode> and is
    not a false positive."""
    pats = []
    for py in SRC.rglob("*.py"):
        for m in re.finditer(r'@\w+\.route\(\s*["\']([^"\']+)["\']',
                             py.read_text(encoding="utf-8")):
            rx = ""
            for part in re.split(r"(<[^>]+>)", m.group(1).rstrip("/")):
                rx += (r".+" if part.startswith("<path:")
                       else r"[^/]+" if part.startswith("<") else re.escape(part))
            pats.append(re.compile(rx + r"/?$"))
    return pats


def _claims():
    """(path, doc, line) for every route-shaped backtick in the in-scope docs."""
    out = []
    for md in sorted(DOCS.glob("*.md")):
        if not IN_SCOPE.match(md.name):
            continue
        for i, line in enumerate(md.read_text(encoding="utf-8").splitlines(), 1):
            for m in CLAIM.finditer(line):
                p = m.group(1)
                if (p == "/" or p.endswith(FILEISH) or any(s in p for s in FOREIGN)
                        or p in NOT_OUR_ROUTES):
                    continue
                out.append((p, md.name, i))
    return out


def test_the_docs_name_only_routes_that_exist():
    """The assertion. A failure here means a document is lying about the app's surface."""
    pats = _route_patterns()
    bad = [(p, d, i) for p, d, i in _claims() if not any(rx.fullmatch(p) for rx in pats)]

    assert not bad, "docs name routes that do not exist:\n" + "\n".join(
        f"  {d}:{i}  {p}" for p, d, i in sorted(bad, key=lambda t: (t[1], t[2])))


def test_the_audit_can_actually_see_the_routes():
    """A guard on the guard. If the decorator regex ever stops matching — a refactor to
    Blueprints, a decorator rename — `_route_patterns()` returns few or none and the test above
    passes vacuously while checking nothing. That is the failure mode of every lint written
    against a parse, so it gets its own assertion."""
    assert len(_route_patterns()) > 100


@pytest.mark.parametrize("path,why", sorted(NOT_OUR_ROUTES.items()))
def test_the_exception_list_stays_honest(path, why):
    """Every exemption must still be an exemption. If one of these becomes a REAL route, the
    entry is now hiding it from the audit and must be deleted — so failing here is the point."""
    pats = _route_patterns()

    assert not any(rx.fullmatch(path) for rx in pats), (
        f"{path} is a real route now — drop it from NOT_OUR_ROUTES ({why})")
