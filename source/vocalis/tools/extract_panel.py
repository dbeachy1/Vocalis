"""Move one `<section data-panel="X">` out of `index.html` into `partials/panel-X.html` (9.0-m0).

Move the panel's source lines verbatim, preserving their line endings. Replace the source block
with one include tag; `runtime/page.assemble()` then reconstructs the original page.

    python tools/extract_panel.py kobold
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

WEBUI = Path(__file__).resolve().parents[1] / "src" / "webui"
INDEX = WEBUI / "index.html"
PARTIALS = WEBUI / "partials"


def span(lines: list[str], panel: str) -> tuple[int, int]:
    """`(first, last)` 0-indexed lines of the panel, by `<section>` depth rather than by a regex.

    Count nested section tags rather than matching to the first closing tag; panels may contain
    nested sections.
    """
    opens = re.compile(r"<section\b")
    closes = re.compile(r"</section>")
    start = next(
        (i for i, l in enumerate(lines) if re.search(rf'<section data-panel="{panel}"', l)), None
    )
    if start is None:
        raise SystemExit(f"no <section data-panel=\"{panel}\"> in {INDEX}")
    depth = 0
    for j in range(start, len(lines)):
        depth += len(opens.findall(lines[j])) - len(closes.findall(lines[j]))
        if depth == 0:
            return start, j
    raise SystemExit(f'panel "{panel}" is never closed - refusing to guess where it ends')


def main(panel: str) -> None:
    raw = INDEX.read_bytes()
    nl = b"\r\n" if b"\r\n" in raw else b"\n"
    lines = raw.split(nl)
    text = [l.decode("utf-8") for l in lines]

    first, last = span(text, panel)

    PARTIALS.mkdir(exist_ok=True)
    out = PARTIALS / f"panel-{panel}.html"
    if out.exists():
        raise SystemExit(f"{out} already exists - refusing to overwrite an extracted panel")
    # Keep the include at column zero and omit a trailing newline so Jinja does not add bytes to
    # the reconstructed panel.
    out.write_bytes(nl.join(lines[first:last + 1]))

    include = f"{{% include 'partials/panel-{panel}.html' %}}".encode("utf-8")
    INDEX.write_bytes(nl.join(lines[:first] + [include] + lines[last + 1:]))

    print(f"{panel}: moved lines {first + 1}-{last + 1} ({last - first + 1} lines) -> {out.name}")
    print(f"index.html: {len(lines)} -> {len(lines) - (last - first)} lines")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
