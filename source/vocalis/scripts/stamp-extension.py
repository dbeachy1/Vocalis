#!/usr/bin/env python3
"""Re-stamp the SillyTavern extension after changing it.  `python scripts/stamp-extension.py`

Run this when you have edited anything under `sillytavern/extension/`. `test_ext_build_stamp.py`
goes red until you do, and its failure message names this script.

The stamp is derived from extension content rather than the release version, so it changes only
when the extension changes. See `vocalis/runtime/extstamp.py` for the hashing contract.

⚠️ IT IS IDEMPOTENT. The stamp line is excluded from its own hash, so running this twice writes
once; a no-op run says so and touches nothing (which matters — rewriting the file would change its
mtime, and `declared()` caches on mtime).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> int:
    # Add the project source path before importing its module; the standalone script cannot
    # resolve that import until the path is configured.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
    from vocalis.runtime import extstamp

    d = extstamp.extension_dir()
    index = d / "index.js"
    if not index.exists():
        print(f"x {index} does not exist", file=sys.stderr)
        return 1

    want = extstamp.compute(d)
    have = extstamp.declared(d)
    if have == want:
        print(f"= extension stamp already {want} — nothing to do")
        return 0

    src = index.read_text(encoding="utf-8")
    new, n = extstamp.STAMP_RE.subn(f"const EXT_BUILD = '{want}';", src, count=1)
    if n != 1:
        print("x could not find `const EXT_BUILD = '...';` in index.js", file=sys.stderr)
        return 1

    # Replace through a sibling temporary file so interruption cannot truncate index.js.
    tmp = index.with_suffix(".js.tmp")
    tmp.write_text(new, encoding="utf-8", newline="")
    os.replace(tmp, index)
    print(f"+ extension stamp {have or '(none)'} -> {want}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
