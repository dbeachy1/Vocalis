"""wbedit — the 6.4 Worldbook Editor.

Self-contained on purpose (design doc §7): the package knows nothing about Flask, the vault, or
Vocalis's settings, so it stays extractable and `core/` stays unit-testable without booting the
application. The blueprint in `vocalis/web/` is what wires it in.

🔴 Anything under `src/` must satisfy `test_m6_writer_census.py` — every filesystem touch either
routes through the vault helpers or carries a written justification. That is why the working CLI
this is a port of lives at `reference/wbedit-baseline/` and not here: it does raw read_text /
write_text / open / mkdir on argparse paths, which is correct for a CLI and illegal in this
tree. `core/` is pure and has no I/O at all; the I/O modules that arrive later must be routed
from the start rather than retrofitted. See design doc §7.1.
"""
