"""Statically detect names that functions load from module scope but the module never binds.

This catches unresolved calls on startup or error-handling paths that ordinary import checks and route-driven tests may not execute. The check is intentionally limited to undefined names; style, unused imports, and shadowing have separate guards.

Use the standard-library `symtable` module so the check runs on a fresh checkout without an optional linter that could be missing or silently skipped.
"""
import builtins
import symtable
from pathlib import Path

import pytest

from conftest import REPO_ROOT

SRC = Path(REPO_ROOT) / "src"

# Names Python itself provides in a module scope that `symtable` still reports as global.
_IMPLICIT = {"__name__", "__file__", "__doc__", "__package__", "__spec__", "__loader__",
             "__builtins__", "__debug__", "__path__", "__all__", "__annotations__"}


def _module_files():
    return sorted(p for p in SRC.rglob("*.py") if "__pycache__" not in p.parts)


def _bound(table) -> set:
    """Every name this scope BINDS — assigned, imported, `def`'d, `class`'d, or a parameter."""
    return {s.get_name() for s in table.get_symbols() if s.is_assigned() or s.is_parameter()
            or s.is_imported() or s.is_namespace()}


def _globals_written(table, out):
    """Names some nested scope declares `global` and then BINDS — they exist at runtime.

    `book_to_audio.generate_section` reads `torch`, which the module never imports at top level:
    `main()` does `global torch; import torch`, deliberately, so that `--list-styles` starts
    without paying for torch. Statically the module scope has no `torch` and this check would
    call it undefined. It is not — it is a module global created at runtime, which is a real and
    reasonable pattern, and the `global` declaration is what makes it legible.

    A name that is only ever CALLED, never bound anywhere, is untouched by this — which is the
    `_bulk_cfg` case, and the reason this concession costs the check nothing.
    """
    for child in table.get_children():
        for sym in child.get_symbols():
            if sym.is_global() and (sym.is_assigned() or sym.is_imported()):
                out.add(sym.get_name())
        _globals_written(child, out)
    return out


def _globals_read(table, out):
    """Names each nested scope reads from the MODULE scope, recursively.

    `is_global()` is the question: the compiler has already resolved the name against every
    enclosing scope, so a closure variable, a parameter and a local are all excluded for us.
    What is left is genuinely "look this up in the module, then in builtins".
    """
    for child in table.get_children():
        for sym in child.get_symbols():
            if sym.is_global() and sym.is_referenced():
                out.setdefault(sym.get_name(), child.get_name())
        _globals_read(child, out)
    return out


@pytest.mark.parametrize("path", _module_files(), ids=lambda p: p.name)
def test_no_module_reads_a_name_that_does_not_exist(path):
    """One case per module in `src/`, so a failure names the file without a needle-in-haystack.

    The message deliberately quotes the scope that reads it: "in run_store_startup_tasks" is the
    difference between a two-minute fix and a hunt, because the undefined name is almost always
    a symbol that MOVED and the reader needs to know who was still holding it.
    """
    table = symtable.symtable(path.read_text(encoding="utf-8"), str(path), "exec")
    known = (_bound(table) | _globals_written(table, set())
             | set(dir(builtins)) | _IMPLICIT)
    missing = {n: fn for n, fn in _globals_read(table, {}).items() if n not in known}
    assert not missing, (
        f"{path.relative_to(REPO_ROOT)} reads {len(missing)} name(s) it never defines — "
        "a moved symbol whose caller was left behind:\n  "
        + "\n  ".join(f"{n!r} in {fn}()" for n, fn in sorted(missing.items())))


def test_the_check_ACTUALLY_catches_a_moved_symbol():
    """The planted case, because a scanner that silently matches nothing is worse than none.

    This is the real 5.1-P4.5 shape, reduced: a helper is deleted, its caller is not, and the
    call sits inside a broad `except` that turns the NameError into a log line. If this test
    ever fails, the check above has stopped checking and every module is passing for free.
    """
    src = (
        "import logging\n"
        "def run_store_startup_tasks():\n"
        "    try:\n"
        "        return startup_recover(_bulk_cfg())\n"
        "    except Exception as exc:\n"
        "        logging.warning(f'bulk startup recovery failed: {exc}')\n"
    )
    table = symtable.symtable(src, "planted.py", "exec")
    known = (_bound(table) | _globals_written(table, set())
             | set(dir(builtins)) | _IMPLICIT)
    missing = {n: fn for n, fn in _globals_read(table, {}).items() if n not in known}
    assert set(missing) == {"_bulk_cfg", "startup_recover"}, missing
    assert missing["_bulk_cfg"] == "run_store_startup_tasks"      # the scope is named, not just the name
