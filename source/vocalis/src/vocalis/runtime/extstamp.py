"""Hash the files served by the SillyTavern extension to identify a loaded build.

The stamp changes only when extension content changes. It is independent of Vocalis's
release version, so unrelated releases do not trigger a reload warning. `compute()` hashes
the repository copy; the browser compares that value with the copy it actually loaded."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from vocalis.runtime import paths

#: The five files SillyTavern actually loads. Keep this list aligned with the deployment helper — if one
#: is ever added there it belongs here too, or the stamp stops covering the thing it describes.
FILES = ("index.js", "manifest.json", "style.css", "vocalis-stream.js", "polish-send.js")

#: Excluding the stamp line from its own hash makes stamping converge in one pass and remain
#: idempotent on subsequent runs.
STAMP_RE = re.compile(r"^const EXT_BUILD = '([^']*)';", re.M)

#: Twelve hex characters. Long enough that a collision is not a thing anyone will meet, short enough
#: to read in a log line and to sit in a poll's query string.
STAMP_LEN = 12

_cache: dict[str, tuple[tuple, str]] = {}


def extension_dir() -> Path:
    return paths.CODE_DIR / "sillytavern" / "extension"


def compute(root: Path | str | None = None) -> str:
    """The stamp this extension's CONTENT deserves, right now.

    Normalize line endings so the same extension content hashes identically across
    platforms. Include each filename so moving content between files changes the stamp.
    """
    d = Path(root) if root else extension_dir()
    h = hashlib.sha256()
    for name in FILES:
        h.update(name.encode("utf-8"))
        src = (d / name).read_text(encoding="utf-8")
        if name == "index.js":
            src = STAMP_RE.sub("const EXT_BUILD = '';", src, count=1)
        h.update(src.replace("\r\n", "\n").encode("utf-8"))
    return h.hexdigest()[:STAMP_LEN]


def declared(root: Path | str | None = None) -> str:
    """What `index.js` currently SAYS it is — the value a loaded tab reports back.

    Cache by file modification time and size: polling avoids repeated reads while a
    replacement on disk invalidates the cache. Return `''` on read errors so callers
    do not report staleness when the server cannot determine the stamp.
    """
    p = (Path(root) if root else extension_dir()) / "index.js"
    try:
        st = p.stat()
        key = str(p)
        hit = _cache.get(key)
        if hit and hit[0] == (st.st_mtime_ns, st.st_size):
            return hit[1]
        m = STAMP_RE.search(p.read_text(encoding="utf-8"))
        val = m.group(1) if m else ""
        _cache[key] = ((st.st_mtime_ns, st.st_size), val)
        return val
    except OSError:
        return ""


# The browser compares its loaded stamp with the extension copy served by SillyTavern.
# These helpers compute and expose the repository copy's stamp for build tooling.
