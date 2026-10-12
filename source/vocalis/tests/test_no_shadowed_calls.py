"""🔴 A function must not assign a module-level function's name and then call that name.

**This file exists because a rename in 5.1-P4.9 produced a function that could never run, and
everything else in the suite said it was fine.** `_voice_added` became `added`, and its only
caller already unpacked into a variable of that name:

    side = read_sidecar(voice)
    added, exact = added(voice, side)          # UnboundLocalError, every call, forever

Python decides scope per function, not per line: because `added` is assigned *somewhere* in the
body, it is local for the *whole* body, so the call on the right-hand side resolves to the local
that has not been assigned yet. Every `GET /voices` would have 500'd.

**Why nothing else catches it.** It is not a syntax error, so `py_compile` passes. The name IS
defined at module scope, so `test_no_undefined_names` — which asks whether a name exists — sees
nothing wrong; that file scopes itself to undefined names on purpose and this is a *defined* one
being shadowed. Only executing the line finds it, and a route with no test that drives that
exact branch never executes it. The sibling guard covers a related undefined-name case;
this one was written after its near-twin was caught by a suite run instead, which is the only
reason it is a test rather than an incident.

**Renames are how this arrives.** A helper called `_voice_added` collides with nothing; strip
the underscore to move it into a package and it collides with the most natural local name in
its own caller. The move itself is what creates the hazard, so the check belongs with the moves.

⚠️ **Nested functions are their own scope, and this walk respects that.** An inner `def` that
assigns `added` does not make the outer function's `added` local — treating it as if it did is
exactly the taint-leak defect P4.5a and P4.6a each had to fix in the writer census. So the walk
stops at every nested `def`/`lambda`/comprehension-free boundary rather than using a bare
`ast.walk`.
"""
import ast
from pathlib import Path

import pytest

from conftest import REPO_ROOT

SRC = Path(REPO_ROOT) / "src"


def _module_files():
    return sorted(p for p in SRC.rglob("*.py") if "__pycache__" not in p.parts)


def _own_scope(fn):
    """(names this function binds, names it calls bare) — WITHOUT descending into nested
    scopes. A nested `def` has its own locals; crediting them to the parent is the false
    positive that would make this test noise, and noise is how a guard gets deleted."""
    bound, called, declared_global = set(), set(), set()

    def walk(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef,
                                  ast.Lambda)):
                continue                       # its own scope; not ours
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                bound.add(child.id)
            elif isinstance(child, (ast.Import, ast.ImportFrom)):
                for a in child.names:
                    bound.add((a.asname or a.name).split(".")[0])
            elif isinstance(child, (ast.Global, ast.Nonlocal)):
                declared_global.update(child.names)
            elif isinstance(child, ast.Call) and isinstance(child.func, ast.Name):
                called.add(child.func.id)
            walk(child)

    a = fn.args
    for arg in a.args + a.kwonlyargs + a.posonlyargs + [x for x in (a.vararg, a.kwarg) if x]:
        bound.add(arg.arg)
    walk(fn)
    # `global X` / `nonlocal X` means the assignment is NOT to a local, so nothing is shadowed
    return bound - declared_global, called


def _import_shadow_hits(tree):
    """Functions that CALL an imported name before binding a local of that name (5.1.1).

    Shared by the real check and its planted-case guard below, deliberately: the other guards
    in this file re-implement the logic they test, which means a fix to one can silently miss
    the other. One implementation, two callers, no drift."""
    top_level = {n.name for n in tree.body
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    imported = {(a.asname or a.name).split(".")[0]
                for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))
                for a in n.names}
    hits = []
    for fn in [n for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        first_bind, first_call = {}, {}

        def walk(node):
            for c in ast.iter_child_nodes(node):
                if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef,
                                  ast.Lambda)):
                    continue                      # a nested scope has its own locals
                if isinstance(c, ast.Name) and isinstance(c.ctx, ast.Store):
                    first_bind.setdefault(c.id, c.lineno)
                elif isinstance(c, (ast.Import, ast.ImportFrom)):
                    for a in c.names:             # a function-local re-import IS a binding
                        first_bind.setdefault((a.asname or a.name).split(".")[0], c.lineno)
                elif isinstance(c, ast.Call) and isinstance(c.func, ast.Name):
                    first_call.setdefault(c.func.id, c.func.lineno)
                walk(c)

        walk(fn)
        declared_global = set()
        for g in [n for n in ast.walk(fn) if isinstance(n, (ast.Global, ast.Nonlocal))]:
            declared_global.update(g.names)       # then it is not a local, so nothing shadows
        for name in sorted((imported - top_level - declared_global)
                           & set(first_bind) & set(first_call) - {fn.name}):
            if first_call[name] < first_bind[name]:
                hits.append(f"{fn.name}() calls {name}() at :{first_call[name]} but binds a "
                            f"local {name!r} at :{first_bind[name]}")
    return hits


@pytest.mark.parametrize("path", _module_files(), ids=lambda p: p.name)
def test_no_function_shadows_a_module_function_it_calls(path):
    """🔴 5.1.1: IMPORTED callables count too, and after 5.1 they are most of them.

    `top_level` used to hold only module-level `def`/`class`, so the identical defect was
    invisible whenever the shadowed callable arrived by `from X import name`:

        from tts_utils import wav_to_mp3
        def finalize(p):
            mp3 = wav_to_mp3(p)     # UnboundLocalError — compiles fine
            wav_to_mp3 = mp3

    That blind spot got worse with the refactor, not better: the monolith DEFINED
    `generate_section`, `wav_to_mp3`, `safe_name`, `ffprobe_duration`, so they were caught;
    the blueprints IMPORT them, so they were not. Check 2 below does not cover it either —
    it only fires on `name.<attr>` use, never on a bare call.

    ⚠️ ORDERING IS REQUIRED FOR THE IMPORTED NAMES, and only for them. A module-level `def`
    that a function assigns over and calls is a bug either way round, and that check stays
    exactly as it was. But re-importing a name function-locally BEFORE using it is legitimate
    and this codebase does it — `voiceswap.swap_hash` has `from tts_utils import source_stat`
    directly above `st = source_stat(voice_pth)`, which is redundant but correct. Flagging that
    would make the guard noise, and a noisy guard gets switched off."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    top_level = {n.name for n in tree.body
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    hits = []
    for fn in [n for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        bound, called = _own_scope(fn)
        for name in sorted((bound & called & top_level) - {fn.name}):
            hits.append(f"{fn.name}() at :{fn.lineno} assigns AND calls {name!r}")
    hits += _import_shadow_hits(tree)
    assert not hits, (
        f"{path.relative_to(REPO_ROOT)}: a local shadows a module-level function that the same "
        "function calls — the call raises UnboundLocalError at runtime and compiles fine:\n  "
        + "\n  ".join(hits) + "\n\nRename the module-level function (that is what P4.9 did: "
        "`added` → `added_at`) or rename the local.")


@pytest.mark.parametrize("path", _module_files(), ids=lambda p: p.name)
def test_no_local_shadows_an_imported_module_before_using_it(path):
    """The same defect one level up: a local named `params` shadowing the `params` MODULE.

    5.1-P4.10a moved two validators into `runtime/params.py` and repointed the callers to
    `params.voice_file_error(...)`. `book_start` binds a local `params` (the GenParams it is
    building) *below* that call, so the name was local for the whole body and the earlier
    module call read it unassigned. P3.4 hit the identical shape with `from vocalis.runtime
    import pool` and a local `pool`, which is why the aliases in this codebase read `rt_voices`,
    `rt_nomi`, `rt_pool` and now `rt_params`.

    🔴 **Ordering is what makes it a bug, so ordering is what this checks.** A function that
    assigns the name and only *then* uses `name.attr` is reading its own local on purpose —
    `_enhance_chapter` does exactly that with `scratch = enhance.scratch_path(...)` followed by
    `scratch.parent`, and it is correct. Flagging that would make this test noise, and a noisy
    guard gets deleted. Only a use that PRECEDES the first binding can raise."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    aliases = set()
    for n in tree.body:
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                aliases.add((a.asname or a.name).split(".")[0])
    hits = []
    for fn in [n for n in ast.walk(tree)
               if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]:
        first_bind, first_attr_use = {}, {}

        def walk(node):
            for c in ast.iter_child_nodes(node):
                if isinstance(c, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef,
                                  ast.Lambda)):
                    continue
                if isinstance(c, ast.Name) and isinstance(c.ctx, ast.Store):
                    first_bind.setdefault(c.id, c.lineno)
                elif isinstance(c, ast.Attribute) and isinstance(c.value, ast.Name):
                    first_attr_use.setdefault(c.value.id, c.value.lineno)
                walk(c)

        walk(fn)
        for name in sorted(aliases & set(first_bind) & set(first_attr_use)):
            if first_attr_use[name] < first_bind[name]:
                hits.append(f"{fn.name}() uses {name}.<attr> at :{first_attr_use[name]} but "
                            f"binds a local {name!r} at :{first_bind[name]}")
    assert not hits, (
        f"{path.relative_to(REPO_ROOT)}: a local shadows an imported module that the same "
        "function uses BEFORE binding it — UnboundLocalError at runtime, compiles fine:\n  "
        + "\n  ".join(hits) + "\n\nImport the module under an `rt_`-style alias (that is what "
        "P4.10a did: `params` → `rt_params`) or rename the local.")


def test_the_check_ACTUALLY_catches_the_P4_9_shape(tmp_path):
    """The guard needs its own guard: a scan that silently matches nothing is worse than no
    scan, because it reads as a clean result. This is the exact code that shipped broken."""
    mod = tmp_path / "sample.py"
    mod.write_text(
        "def added_at(v, s):\n    return 1, True\n\n\n"
        "def added(v, s):\n    return 1, True\n\n\n"
        "def meta(voice):\n"
        "    side = {}\n"
        "    added, exact = added(voice, side)\n"
        "    return {'added': added}\n", encoding="utf-8")
    tree = ast.parse(mod.read_text(encoding="utf-8"))
    top = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    fn = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "meta"][0]
    bound, called = _own_scope(fn)
    assert "added" in (bound & called & top), "the scan would have missed the P4.9 defect"


def test_the_module_alias_check_catches_P4_10a_and_spares_the_benign_shape(tmp_path):
    """Both halves matter. The first function is `book_start` reduced to its bones — module
    call above, local binding below — and must be caught. The second is `_enhance_chapter`'s
    shape, which is correct code, and must NOT be, or the guard becomes noise."""
    mod = tmp_path / "sample.py"
    mod.write_text(
        "import params\n"
        "import scratch\n"
        "import enhance\n\n\n"
        "def book_start(data):\n"
        "    err = params.voice_file_error('v')\n"          # :6 — module call
        "    params = GenParams(data)\n"                    # :7 — binds it local. BUG.
        "    return params, err\n\n\n"
        "def enhance_chapter(wav, job):\n"
        "    scratch = enhance.scratch_path(wav)\n"         # binds first...
        "    scratch.parent.mkdir()\n"                      # ...then uses its own local. FINE.
        "    return scratch\n", encoding="utf-8")
    tree = ast.parse(mod.read_text(encoding="utf-8"))
    aliases = {a.name for n in tree.body if isinstance(n, ast.Import) for a in n.names}
    caught = {}
    for fn in [n for n in tree.body if isinstance(n, ast.FunctionDef)]:
        binds, uses = {}, {}
        for c in ast.walk(fn):
            if isinstance(c, ast.Name) and isinstance(c.ctx, ast.Store):
                binds.setdefault(c.id, c.lineno)
            elif isinstance(c, ast.Attribute) and isinstance(c.value, ast.Name):
                uses.setdefault(c.value.id, c.value.lineno)
        caught[fn.name] = [n for n in aliases & set(binds) & set(uses)
                           if uses[n] < binds[n]]
    assert caught["book_start"] == ["params"], "the P4.10a defect would have slipped through"
    assert caught["enhance_chapter"] == [], "the benign local-then-use shape was flagged"


def test_a_nested_def_does_not_taint_its_parent(tmp_path):
    """P4.5a and P4.6a were both this bug in the writer census: an inner function's names
    credited to the enclosing one. Here it would flag a parent that is entirely correct."""
    mod = tmp_path / "sample.py"
    mod.write_text(
        "def write(dst):\n    return None\n\n\n"
        "def outer():\n"
        "    def inner(dst):\n"
        "        write = 1\n"                       # inner's local — not outer's
        "        return write\n"
        "    return write(inner)\n", encoding="utf-8")
    tree = ast.parse(mod.read_text(encoding="utf-8"))
    top = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    outer = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "outer"][0]
    bound, called = _own_scope(outer)
    assert not (bound & called & top), "a nested def's assignment leaked into its parent"


def test_the_import_shadow_check_catches_the_from_import_shape_and_spares_the_benign_one(tmp_path):
    """Both halves, same discipline as the module-alias guard above.

    `finalize` is the shape the widened check exists for — a `from X import name` callable
    called above a local of the same name — and the real interpreter raises UnboundLocalError
    on it. `swap_hash` is `voiceswap.swap_hash` reduced to its bones: a redundant function-local
    re-import that PRECEDES the use. That one is correct code and must not be flagged, or the
    guard is noise and gets switched off. It was the first thing the widened check hit, which is
    exactly why the ordering rule is in it."""
    mod = tmp_path / "sample.py"
    mod.write_text(
        "from tts_utils import wav_to_mp3, source_stat\n\n\n"
        "def finalize(p):\n"
        "    mp3 = wav_to_mp3(p)\n"              # :5 — calls the import...
        "    wav_to_mp3 = mp3\n"                 # :6 — ...but binds it local. BUG.
        "    return wav_to_mp3\n\n\n"
        "def swap_hash(pth):\n"
        "    from tts_utils import source_stat\n"   # :10 — binds first...
        "    st = source_stat(pth)\n"               # :11 — ...then calls it. FINE.
        "    return st\n", encoding="utf-8")

    hits = _import_shadow_hits(ast.parse(mod.read_text(encoding="utf-8")))
    assert len(hits) == 1, f"expected exactly the finalize() hit, got {hits}"
    assert "finalize()" in hits[0] and "wav_to_mp3" in hits[0]
    assert not any("swap_hash" in h for h in hits), \
        "the benign function-local re-import was flagged — this guard would become noise"
