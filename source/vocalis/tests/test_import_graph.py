"""Modules under `src/` must not import `vocalis_server`, including inside functions.

Launching `src/vocalis_server.py` directly can load it as `__main__`; a later lazy import by
that name may execute the same file again. That created a second Flask app and reconfigured the
vault with a locked store while the original router still reported unlocked health. The repo
root `vocalis.py` entrypoint keeps the canonical module in `sys.modules`, and shared helpers
such as `send_store_file` and `parse_range` live in `src/store_serve.py` for both sides to import.

This AST-based test checks the full source tree, including function-local imports, so future
module moves cannot reintroduce the duplicate-load path unnoticed.
"""
import ast

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)

SRC = REPO_ROOT / "src"
FORBIDDEN = "vocalis_server"


def _src_modules():
    return sorted(p for p in SRC.rglob("*.py") if "__pycache__" not in p.parts)


def _imports_of(tree, wanted):
    """Every import of `wanted` in this tree, at any nesting depth, as (lineno, statement)."""
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name == wanted or a.name.startswith(wanted + "."):
                    hits.append((node.lineno, f"import {a.name}"))
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module == wanted or node.module.startswith(wanted + "."):
                names = ", ".join(a.name for a in node.names)
                hits.append((node.lineno, f"from {node.module} import {names}"))
    return hits


def test_no_module_in_src_imports_the_server():
    offenders = []
    for path in _src_modules():
        if path.name == "vocalis_server.py":
            continue                                    # it is allowed to be itself
        tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        for lineno, stmt in _imports_of(tree, FORBIDDEN):
            offenders.append(f"{path.relative_to(REPO_ROOT).as_posix()}:{lineno}  {stmt}")

    assert not offenders, (
        "these modules import vocalis_server, which closes an import cycle:\n  "
        + "\n  ".join(offenders)
        + "\n\nThis is the shape that took the encrypted install down on 2026-07-22 — read this "
          "file's docstring. Whatever the new module needs from vocalis_server, move that thing "
          "into a module they can both import (see src/store_serve.py), rather than reaching "
          "back up the tree for it.")


def test_the_scan_would_actually_catch_one(tmp_path):
    """A guard on the guard. Every assertion above is 'no offenders found', which an AST walk
    that matches nothing satisfies perfectly and forever — the same vacuous-pass trap
    test_m6_writer_census.py was written around. So plant both shapes and prove they are seen,
    including the function-local one that caused the actual outage."""
    planted = tmp_path / "planted.py"
    planted.write_text(
        "import os\n"
        "from vocalis_server import send_store_file\n"
        "def f():\n"
        "    import vocalis_server\n"
        "    return vocalis_server.app\n",
        encoding="utf-8")
    hits = _imports_of(ast.parse(planted.read_text(encoding="utf-8-sig")), FORBIDDEN)
    assert len(hits) == 2, f"the scan found {hits} — it must see BOTH forms"
    assert any("from vocalis_server import" in s for _, s in hits), "module-level form missed"
    assert any(s == "import vocalis_server" for _, s in hits), (
        "the FUNCTION-LOCAL form was missed — that is the one that caused the outage, and the "
        "only reason it was written that way was to hide from a module-header check")


def test_the_entrypoint_imports_the_server_by_name():
    """The other half of the fix: something must import `vocalis_server` under its real name, or
    it is `__main__` again and every guarantee above evaporates."""
    entry = REPO_ROOT / "vocalis.py"
    assert entry.exists(), (
        "vocalis.py is gone. Without it the server is launched as a script, its module name is "
        "__main__, and 'vocalis_server' is absent from sys.modules — re-arming the re-execution "
        "bug this whole file exists to prevent")
    tree = ast.parse(entry.read_text(encoding="utf-8-sig"), filename=str(entry))
    assert _imports_of(tree, FORBIDDEN), "vocalis.py no longer imports vocalis_server"


def _reexported_names():
    """Names `vocalis_server` binds via `from vocalis.… import …` — i.e. names whose real home
    is now the package, and which exist on `vocalis_server` only as a second reference."""
    tree = ast.parse((SRC / "vocalis_server.py").read_text(encoding="utf-8-sig"))
    names = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and \
                (node.module == "vocalis" or node.module.startswith("vocalis.")):
            for a in node.names:
                names[a.asname or a.name] = f"{node.module}.{a.name}"
    return names


_SERVER_ALIASES = {"vs", "vocalis_server"}


def _assign_targets(node):
    """The targets of an assignment/deletion statement, flattened through tuple unpacking."""
    if isinstance(node, ast.Assign):
        targets = node.targets
    elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
        targets = [node.target]
    elif isinstance(node, ast.Delete):
        targets = node.targets
    else:
        return []
    out = []
    for t in targets:
        out.extend(t.elts if isinstance(t, (ast.Tuple, ast.List)) else [t])
    return out


def _rebinds_on_server(tree):
    """(attribute_name, lineno) for everything that REBINDS an attribute on the server module.

    AST, not a regex over the source. A text scan matches this file's own docstring — which
    necessarily contains `setattr(vs, "JOBS", {})` as the example of what not to do — and the
    cure for that must not be deleting the explanation. A `Call` node is a call; a docstring is
    a `Constant`, and the two are never confused.

    Catches `monkeypatch.setattr(vs, "X", …)`, bare `setattr(vs, "X", …)`,
    `patch.object(vs, "X")`, `patch("vocalis_server.X")` — and **plain assignment,
    `vs.X = …`**. Mutation — `vs.X.clear()`, `vs.X[k] = v` — is deliberately NOT caught,
    because it is correct and common, and neither is reach-through (`vs.vault_store.STORE = …`)
    for the same reason.

    🔴 THE PLAIN-ASSIGNMENT FORM IS THE DANGEROUS ONE AND IT WAS MISSING UNTIL 5.1-P3.4.
    `monkeypatch.setattr(vs, "X", …)` raises AttributeError when `X` is absent, so a name that
    simply CEASES TO EXIST on `vocalis_server` makes every stale setattr go loud — which is the
    whole reason this branch's rule is "do not re-export a name any test rebinds". A bare
    `vs._pool = None` has no such protection: it SILENTLY CREATES the attribute. The test then
    configures a phantom global that nothing reads, and passes.

    Found in the pool audit — `vs._pool` / `vs._pool_sig` are assigned this way at ten sites in
    `test_server.py` and `test_voxcpm.py`, and not one of them was visible to this scan.
    """
    out = []
    for node in ast.walk(tree):
        for t in _assign_targets(node):
            # `vs.X = …` only. `vs.mod.X = …` has an Attribute value, not a Name, and is
            # reach-through: it patches the other module directly and survives any move.
            if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name) \
                    and t.value.id in _SERVER_ALIASES:
                out.append((t.attr, node.lineno))

        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        fname = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")

        if fname in ("setattr", "delattr") and len(node.args) >= 2:
            tgt, attr = node.args[0], node.args[1]
            if (isinstance(tgt, ast.Name) and tgt.id in _SERVER_ALIASES
                    and isinstance(attr, ast.Constant) and isinstance(attr.value, str)):
                out.append((attr.value, node.lineno))

        elif fname == "object" and len(node.args) >= 2:          # patch.object(vs, "X")
            tgt, attr = node.args[0], node.args[1]
            if (isinstance(tgt, ast.Name) and tgt.id in _SERVER_ALIASES
                    and isinstance(attr, ast.Constant) and isinstance(attr.value, str)):
                out.append((attr.value, node.lineno))

        elif fname == "patch" and node.args:                     # patch("vocalis_server.X")
            a = node.args[0]
            if isinstance(a, ast.Constant) and isinstance(a.value, str) \
                    and a.value.startswith("vocalis_server."):
                rest = a.value.split(".", 1)[1]
                if "." not in rest:          # vocalis_server.X, not vocalis_server.mod.X
                    out.append((rest, node.lineno))
    return out


def test_the_rebind_scan_would_actually_catch_one(tmp_path):
    """Guard on the guard, again: prove the scanner sees each rebinding form, and — the part
    that matters — that it does NOT flag the mutation forms, which are correct and which ~20
    real sites use. A scanner that cried wolf on `vs.JOBS.clear()` would be turned off within
    the hour."""
    planted = tmp_path / "planted_test.py"
    planted.write_text(
        'def test_a(monkeypatch):\n'
        '    monkeypatch.setattr(vs, "JOBS", {})\n'
        '    setattr(vocalis_server, "EVENT_CAP", 1)\n'
        '    patch.object(vs, "Job")\n'
        '    patch("vocalis_server.emit")\n'
        '    vs._pool = None\n'                          # plain assignment — the silent one
        '    vs._a, vs._b = 1, 2\n'                       # and through tuple unpacking
        '    vs._n += 1\n'
        '    del vs._gone\n'
        'def test_ok():\n'
        '    vs.JOBS.clear()\n'
        '    vs.JOBS["k"] = 1\n'
        '    vs.JOBS["k"].field = 3\n'
        '    monkeypatch.setattr(vs.vault_store, "STORE", None)\n'
        '    vs.app.secret_key = b"x"\n'                  # reach-through assignment
        '    patch("vocalis_server.enhance.bandwidth_of")\n',
        encoding="utf-8")
    found = {n for n, _ in _rebinds_on_server(
        ast.parse(planted.read_text(encoding="utf-8-sig")))}
    assert found == {"JOBS", "EVENT_CAP", "Job", "emit", "_pool", "_a", "_b", "_n", "_gone"}, (
        f"the rebind scan found {sorted(found)}. It must see all four call forms AND plain "
        f"assignment (vs.X = …, tuple unpacking, augmented, del) — the assignment form is the "
        f"one that fails SILENTLY, because unlike setattr it creates a missing attribute "
        f"instead of raising. And it must NOT report mutation (vs.JOBS.clear(), vs.JOBS[k]=v, "
        f"vs.JOBS[k].field=v) or reach-through (vs.vault_store.STORE, vs.app.secret_key, "
        f"'vocalis_server.enhance.bandwidth_of') — those are correct and stay correct across "
        f"a move")


def test_no_test_REBINDS_a_re_exported_name_on_vocalis_server():
    """🔴 The subtlest way this refactor can break a test into a false pass.

    `from vocalis.runtime.jobs import JOBS` gives `vocalis_server` a second NAME for the same
    dict. MUTATING it (`vs.JOBS.clear()`, `vs.JOBS[k] = v`) is fine and ~20 sites do it — one
    object, everyone sees the change. REBINDING it (`monkeypatch.setattr(vs, "JOBS", {})`)
    points only `vocalis_server`'s name at something new; the function that actually uses it
    reads its OWN module's global and carries on with the original. The test then asserts
    against a dict nothing wrote to.

    That is not hypothetical — it is exactly what
    `test_server.py::test_prune_jobs_caps_finished_and_keeps_running` did the moment the
    registry moved, and it failed loudly only because its assertions happened to be tight
    enough to notice. A laxer test would have passed while checking nothing.

    So: patch the name where it LIVES. `monkeypatch.setattr(vocalis.runtime.jobs, "JOBS", …)`.

    64 names across 240 sites are rebound on `vs` — count it with the AST helper in
    5.1-refactor, never with a grep (the one that said 39 matched double quotes only).
    Each becomes this bug on the day its definition moves into the package.

    ⚠️ **A name that CEASES to exist on `vocalis_server` is only loud for the `setattr` forms.**
    They raise AttributeError; a plain `vs.X = …` creates the attribute and says nothing. That
    is why `_rebinds_on_server` catches assignment too — see its docstring.
    """
    reexported = _reexported_names()
    assert reexported, (
        "vocalis_server no longer re-exports anything from the vocalis package — either the "
        "refactor finished and this test can go, or the scan broke")

    offenders = []
    for path in sorted((REPO_ROOT / "tests").glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        for name, lineno in _rebinds_on_server(tree):
            if name in reexported:
                offenders.append(
                    f"{path.name}:{lineno}  rebinds vs.{name} (lives at {reexported[name]})")

    assert not offenders, (
        "these tests rebind a name that vocalis_server only re-exports:\n  "
        + "\n  ".join(offenders)
        + "\n\nThe patch lands on vocalis_server's reference; the code that uses it reads its "
          "own module's global and never sees the change. Patch it where it lives instead — "
          "read this test's docstring.")


@pytest.mark.parametrize("script", [
    "scripts/start_web.sh",
    "scripts/start_web.bat",
    "scripts/disable-drill.sh",
    "scripts/restore-drill-install.sh",
])
def test_no_launcher_still_runs_the_module_as_a_script(script):
    """`python src/vocalis_server.py` is the launch that makes the module __main__. Every
    launcher must go through vocalis.py instead — a single one left behind is a box that boots
    with the hazard armed, and nothing about it looks wrong."""
    p = REPO_ROOT / script
    if not p.exists():
        pytest.skip(f"{script} not present")

    # Comments are stripped first, because the point is what the script RUNS, not what it
    # mentions — and every one of these files now carries a comment explaining why it stopped
    # running the module directly. A raw substring check fails on its own documentation, which
    # would leave the next person deleting the explanation to get the suite green.
    live = []
    for raw in p.read_text(encoding="utf-8", errors="replace").splitlines():
        s = raw.strip()
        if s.startswith("#") or s.upper().startswith("REM ") or s.startswith("::"):
            continue
        live.append(raw)
    body = "\n".join(live)

    bad = [ln.strip() for ln in live
           if "src/vocalis_server.py" in ln or "src\\vocalis_server.py" in ln]
    assert not bad, (
        f"{script} still launches the module directly:\n  " + "\n  ".join(bad)
        + f"\n\nUse vocalis.py — see 5.1-refactor §2.1. (Importing it for its API, as "
          f"the drill scripts do with `import vocalis_server as vs`, is fine and is not this.)")
    assert body, f"{script} has no executable lines — did the strip eat the file?"
