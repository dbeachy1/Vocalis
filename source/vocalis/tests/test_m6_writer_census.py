"""Statically census filesystem operations that may touch vault data and require each to be routed through `vault_fs` or explicitly justified.

The census traces store-root values through the source tree, including inferred helper returns, closures, `Path` parameters, dynamic paths, and subprocess arguments. Scratch paths remain a separate plaintext boundary.

The analysis deliberately over-approximates: false positives need an allow-list reason, while an unreported vault access can break reads or deletes or expose cleartext. Focused tests cover inference cases that a fixed path inventory would miss.
"""
import ast
import collections

import pytest

from conftest import REPO_ROOT  # noqa: F401  (sys.path side effect)


# ── what the taint is rooted at ──────────────────────────────────────────────────────────

# Store roots, spelled as `src/` spells them. Kept in step with test_m6_router.py's
# _PATH_ROOT_NAMES/_PATH_ROOT_CALLS by test_the_two_censuses_agree_on_the_roots, below.
_VAULT_ROOT_NAMES = {"DATA_DIR", "OUTPUT_DIR", "CHUNKS_ROOT"}
_VAULT_ROOT_CALLS = {"cache_root", "chunks_root"}


def _store_root_of(node):
    """The store-root name this expression IS, bare or module-qualified, else None.

    🔴 `paths.DATA_DIR` MUST COUNT AS `DATA_DIR`. Store roots are module globals in
    `vocalis/runtime/paths.py`, so matching an
    `ast.Name` was the whole job. The moment the constants move to `vocalis/runtime/paths.py`
    every reference becomes an `ast.Attribute` — and an Attribute whose `.attr` is not a
    propagating one returns None from `taint()`, i.e. **not a vault path**. That is 128 call
    sites in `vocalis_server` alone dropping out of the audit at once, silently, and every
    blueprint written in Phase 4 will be spelled the same way.

    Deliberately liberal about the left-hand side: any `<anything>.DATA_DIR` counts. Erring
    toward MORE taint costs an allowlist entry someone has to justify; erring the other way is
    the leak this file exists to prevent.
    """
    if isinstance(node, ast.Name):
        return node.id if node.id in _VAULT_ROOT_NAMES else None
    if isinstance(node, ast.Attribute):
        return node.attr if node.attr in _VAULT_ROOT_NAMES else None
    return None

# The plaintext boundary. A path from here is NOT ours to route — that is what the scratch IS
# (design §8.1). `path_for` is scratch.py's own constructor; the tempfile entries are for the
# handful of pre-5.0 sites that still use it and are covered by their own tests.
_SAFE_ROOT_CALLS = {"scratch_root", "default_root", "path_for",
                    "mkdtemp", "gettempdir", "TemporaryDirectory", "NamedTemporaryFile"}

# 🔴 AND THE SAME BOUNDARY REACHED THROUGH A CONFIG OBJECT, which is how most of src/ holds
# it: `bulk.BulkConfig.scratch_root`, `EnhanceConfig.scratch`, `CleanupConfig.scratch`. Every
# batch, every enhance temporary and every cleanup preview lives under one of these, and
# `Path(cfg.scratch_root)` is indistinguishable from `Path(<anything>)` to a parser that only
# reads shapes. Without this, bulk.py alone contributes 37 findings and every one is wrong —
# a census nobody can finish reading is a census nobody reads.
#
# It is a NAME-BASED rule and that is defensible exactly here: `scratch.py` owns the word,
# `test_no_module_in_src_uses_the_os_temp_dir` bans the alternative outright, and
# test_the_scratch_names_still_mean_the_scratch below pins each one to a real declaration.
_SAFE_ATTRS = {"scratch", "scratch_root", "scratch_dir"}

# ...and the same boundary under a name that does not say "scratch". `voiceswap.SwapConfig`
# declares `work_root: Path  # transient per-job workdirs — IN THE SCRATCH (5.0 §8.2)` and
# builds it as `scratch.scratch_root(app_settings) / "voiceswap"`. The COMMENT is the only
# thing that says so in English, and a parser cannot read English — but it can read the
# construction. `_infer_safe_fields` below harvests every `field=<scratch expression>` keyword
# in src/ and adds the field's name here, so the declaration site teaches the census the alias.

# Explicitly routed by the function itself. `route()` returning None is not "no vault" — it is
# "not ours" (see vault_fs's module docstring), so the `else` arm of an explicit route check is
# the CORRECT plaintext call, not a missed one. `tts_utils.valid_or_remove`, `source_stat` and
# `voiceswap.get_stems` are all written this way on purpose; flagging their fallback arms would
# mean thirty allow-list entries that all say "the else arm of the route() above".
_ROUTE_CHECKS = {"route", "vault_route"}

# Reserved key in a `_locals()` result: the parameter names the current probe is deliberately
# NOT seeding. Never a real identifier, so it cannot collide with one.
_HELD_CLEAN = "  held-clean (not an identifier)"

# Literal first components under a store root that are deliberately NOT encrypted. Same list
# and same reasons as test_m6_router.py::_EXEMPT — that file asserts they stay in step.
#
# 🔴 `reference` (7.0) IS TRACKED SOURCE, on exactly the argument `src` and `nomi` rest on. It
# holds `wbedit-baseline/` — the standalone worldbook tool 7.0 productizes, plus the
# `Section-Editor.json` prompt card the editor loads on every pass. Design §7.1 is why it is
# there and not under `src/`: the baseline does raw `read_text`/`write_text` on argparse paths,
# which is correct for a CLI and illegal under `src/`, and the fix for that is moving the file
# rather than granting it eight exemptions. Kept in step with `test_m6_router._EXEMPT` by
# `test_the_two_censuses_agree_on_the_roots`, which is what caught this being added to one and
# not the other.
_EXEMPT_PREFIX = {"app_settings.yaml", "admin_credentials.yaml", "vault_keys.yaml",
                  "logs", "src", "nomi", "certs", "reference", "sillytavern", "work"}

# The modules that ARE the seam. A call on one of these is the routed form, by definition.
_ROUTER_MODULES = {"vault_fs", "vault", "vault_store", "scratch", "scratch_mod"}


# ── what counts as touching the disk ─────────────────────────────────────────────────────
#
# 🔴 WIDER THAN ROUND 2's GREP, ON PURPOSE. `stat` is here because its absence is what turned
# two freshly-routed 404s into 500s; `is_file`/`is_dir`/`touch`/`samefile` are here because
# nothing had looked for them at all.
_PATH_OPS = {
    "exists", "stat", "lstat", "is_file", "is_dir", "samefile",
    "glob", "rglob", "iterdir", "walk",
    "open", "read_text", "read_bytes", "write_text", "write_bytes",
    "unlink", "rename", "replace", "mkdir", "rmdir", "touch", "chmod",
    "symlink_to", "hardlink_to",
}
_SHUTIL_OPS = {"rmtree", "copy", "copy2", "copyfile", "copytree", "move",
               "make_archive", "unpack_archive", "disk_usage"}
_OS_OPS = {"remove", "unlink", "rename", "replace", "makedirs", "rmdir", "mkdir",
           "stat", "utime", "listdir", "scandir", "walk", "chmod", "link", "symlink"}
_SUBPROCESS_OPS = {"run", "Popen", "check_output", "check_call", "call"}

# Attributes/methods that carry taint with them: a vault path's `.parent` is still in the
# vault, and `p.with_suffix(".mp3")` is the single most common way one is built.
_PROPAGATING = {"parent", "absolute", "resolve", "expanduser", "with_name", "with_suffix"}

# The router's own child-process seam. A conduit that calls one of these on the parameter in
# question HANDLES the vault itself and is not a finding — which is how `tts_utils` and
# `voiceswap`'s two separate `ffprobe_duration`s both come out clean without being named here.
_CHILD_SEAM = {"child_input", "to_scratch", "decrypt_to_scratch", "from_scratch"}

# Not scanned: the vault IS the plaintext side of itself. `vault_migrate` reads a plaintext
# tree and writes an encrypted one by definition, and scratch.py owns the boundary.
# `vault_survey` is vault_migrate's READ-ONLY detection half, lifted out in 7.0-m6 §7 so
# `/vault/init` could ask "is this store empty?" without importing the machinery that moves
# data — its whole job is raw-reading the physical tree to find plaintext, i.e. the same
# by-definition exemption as its parent. Its docstring forbids it ever growing a write.
_NOT_SCANNED = {"vault.py", "vault_fs.py", "vault_store.py", "vault_migrate.py",
                "vault_survey.py", "scratch.py"}


def _src_root(root=None):
    return (root or REPO_ROOT) / "src"


def _src_files(root=None):
    """Every .py under src/ of the tree under audit, AT ANY DEPTH. `root` is how the acceptance
    test points the SAME analysis at a historical checkout instead of the working tree.

    🔴 rglob, not glob. This walk was non-recursive until 5.1, which was correct only for as
    long as no .py file lived in a subdirectory of src/. The first one to appear would have
    left the audit silently — and per this file's own opening warning, an empty to-do list
    looks exactly like nothing to do, so the census would have gone on passing while covering
    less and less of the product. It is the guarantee 5.0 exists to provide; it does not get
    to depend on nobody ever making a folder.
    """
    return sorted(p for p in _src_root(root).rglob("*.py") if "__pycache__" not in p.parts)


def _mod_key(path, root=None):
    """The census's name for a module: its path relative to src/, posix-style.

    For a top-level file this IS the basename, so every allowlist key, every `_NOT_SCANNED`
    entry and the direct `trees["vault_store.py"]` lookup keep matching unchanged. A file in a
    subpackage gets `vocalis/web/bulk.py` — which is the point: keying on the basename would
    let `src/vocalis/web/bulk.py` silently overwrite `src/bulk.py` in `self.trees`, dropping a
    whole module from the audit with no error. Same failure as the non-recursive glob, one
    layer in.
    """
    return path.relative_to(_src_root(root)).as_posix()


def _params(fn):
    """(positional names in order, all names)."""
    a = fn.args
    pos = [p.arg for p in list(a.posonlyargs) + list(a.args)]
    return pos, set(pos) | {p.arg for p in a.kwonlyargs}


# Calls that hand back what they were given, restructured. `return sorted(Path(out_dir) / n
# for n in ...)` is a function that returns vault paths, and reading only the outermost node
# says "it returns whatever sorted() returns" — which is how `_pending_chapter_wavs` (the
# enhance pass's entire to-do list) stayed invisible on the first pass of this file.
_PASSTHROUGH_CALLS = {"sorted", "list", "tuple", "set", "reversed", "iter", "next", "filter"}


def _value_exprs(node, depth=0):
    """The expressions a value could actually BE, unwrapping containers and pass-throughs."""
    if depth > 6 or node is None:
        return
    if isinstance(node, ast.Call):
        name = node.func.id if isinstance(node.func, ast.Name) else None
        if name in _PASSTHROUGH_CALLS:
            for a in node.args:
                yield from _value_exprs(a, depth + 1)
            return
        yield node
        return
    if isinstance(node, (ast.ListComp, ast.GeneratorExp, ast.SetComp)):
        yield from _value_exprs(node.elt, depth + 1)
        return
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        for e in node.elts:
            yield from _value_exprs(e, depth + 1)
        return
    if isinstance(node, ast.IfExp):
        yield from _value_exprs(node.body, depth + 1)
        yield from _value_exprs(node.orelse, depth + 1)
        return
    if isinstance(node, ast.BoolOp):
        for v in node.values:
            yield from _value_exprs(v, depth + 1)
        return
    yield node


class _Index:
    """The whole analysis. Parse once, resolve names to definitions, then two fixpoints:
    which functions RETURN a vault path, and which functions hand a parameter to a CHILD.
    """

    def __init__(self, root=None):
        self.trees = {}
        for f in _src_files(root):
            self.trees[_mod_key(f, root)] = ast.parse(f.read_text(encoding="utf-8-sig"),
                                                      filename=str(f))

        # (module, name) -> FunctionDef, and name -> [(module, FunctionDef)] for the
        # unqualified case. Two modules define `ffprobe_duration`, with different contracts
        # and — for most of 5.0 — different routing, so the resolver below has to care.
        self.defs, self.by_name = {}, collections.defaultdict(list)
        for mod, tree in self.trees.items():
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    self.defs[(mod, node.name)] = node
                    self.by_name[node.name].append((mod, node))

        # `from voiceswap import ffprobe_duration` in cleanup.py means cleanup's bare
        # `ffprobe_duration(...)` is voiceswap's, not tts_utils's. Without this the two
        # collapse and the one that routes silently vouches for the one that does not.
        self.imports = collections.defaultdict(dict)
        # 🔴 AND the MODULE aliases: `import bulk`, `from vocalis.runtime import configs`,
        # `import vocalis.runtime.pool as rt_pool`. `resolve()` used to turn `configs.f()` into
        # the module key `"configs.py"` by pasting `.py` onto the alias — which is correct for
        # every flat module in `src/`, and correct for NOTHING under `src/vocalis/`, whose keys
        # are paths like `vocalis/runtime/configs.py`. See `module_alias`'s note below.
        self.module_alias = collections.defaultdict(dict)
        for mod, tree in self.trees.items():
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module:
                    src_mod = self._resolve_module(node.module)
                    if src_mod:
                        for a in node.names:
                            self.imports[mod][a.asname or a.name] = (src_mod, a.name)
                    # `from vocalis.runtime import configs` — the NAME is a module, not a
                    # function, so it belongs in the alias map instead.
                    for a in node.names:
                        sub = self._resolve_module(f"{node.module}.{a.name}")
                        if sub:
                            self.module_alias[mod][a.asname or a.name] = sub
                elif isinstance(node, ast.Import):
                    for a in node.names:
                        tgt = self._resolve_module(a.name)
                        if not tgt:
                            continue
                        # `import vocalis.runtime.pool as rt_pool` binds `rt_pool`;
                        # a bare `import bulk` binds `bulk`.
                        self.module_alias[mod][a.asname or a.name.split(".")[0]] = tgt

        self._returns_vault_path = set()
        self._returns_scratch = set()
        self._returns_param = {}
        self._conduits = collections.defaultdict(set)
        self.globals = {}
        self.safe_attrs = set(_SAFE_ATTRS)
        self.vault_attrs = set()
        self._infer_vault_fields()
        self._infer_safe_fields()
        self._infer_scratch_returns()
        # Twice round: a module constant can be a call to a helper that returns a vault path,
        # and that helper's own body may be built out of a module constant. One pass in each
        # direction settles it; the second pair is cheap and proves it has settled.
        for _ in range(2):
            self._infer_globals()
            self._infer_returns()
        self._infer_conduits()

    def _resolve_module(self, dotted):
        """`from X import ...` -> the census's key for X, or None if X isn't ours.

        `src/` is on sys.path, so one module can honestly be named two ways: `from bulk import
        f` and `from vocalis.runtime.jobs import f` are both real. Try the dotted path as a
        relative path first, then the bare top-level name (which is what this did before 5.1
        and is still how every flat service module is imported).

        The last clause resolves a leaf name that is unambiguous across subpackages, and
        deliberately returns None when it is not. Guessing between two same-named modules is
        exactly how `voiceswap.ffprobe_duration` and `tts_utils.ffprobe_duration` collapsed
        into one — and then the one that routes vouched for the one that does not.
        """
        as_path = dotted.replace(".", "/") + ".py"
        if as_path in self.trees:
            return as_path
        leaf = dotted.split(".")[-1] + ".py"
        if leaf in self.trees:
            return leaf
        hits = [k for k in self.trees if k.rsplit("/", 1)[-1] == leaf]
        return hits[0] if len(hits) == 1 else None

    # ── module-level constants ───────────────────────────────────────────────────────────

    def _infer_globals(self):
        """`BOOKS_DIR = BASE_DIR / "books"` at module scope is a store root wearing a second
        name, and the seam that resolves an uploaded book — `_books_file` — is built entirely
        out of it. A census seeded only from the THREE root names in `test_m6_router.py`
        cannot see `f.stat()` in `books_inspect`, which is one of the six sites this file has
        to rediscover to be worth committing. So the roots are computed, not listed."""
        for mod, tree in self.trees.items():
            g = {}
            for _ in range(3):
                before = dict(g)
                for node in tree.body:
                    if isinstance(node, ast.Assign):
                        src, tgts = node.value, node.targets
                    elif isinstance(node, ast.AnnAssign) and node.value is not None:
                        src, tgts = node.value, [node.target]
                    else:
                        continue
                    why = self.taint(mod, src, g)
                    if not why:
                        continue
                    for t in tgts:
                        if isinstance(t, ast.Name):
                            g[t.id] = f"module constant under {why}"
                if g == before:
                    break
            self.globals[mod] = g

    # ── resolution ───────────────────────────────────────────────────────────────────────

    def resolve(self, mod, node):
        """A Call's func node -> [(module, FunctionDef)] it could reach.

        `mod.fn(...)` resolves by module; a bare `fn(...)` resolves through `mod`'s import
        table, then its own module, and only then falls back to EVERY definition of that
        name — the conservative direction, because a missed resolution here is a missed bug.

        🔴 THE ALIAS IS NOT THE FILENAME, and assuming it was is a silent hole the 5.1 refactor
        opens wide (fixed P3.6). This did `cand = f"{alias}.py"`, which is right for every flat
        module — `enhance.run_enhance()` really is in `enhance.py` — and wrong for every module
        in the package, whose key is a PATH: `configs.enhance_cfg()` looked for `configs.py`,
        found nothing, and returned `[]`. An unresolved call is an UNTAINTED call, so the
        finding simply disappears; nothing says the analysis gave up. By the end of Phase 4
        nearly every cross-module call in `src/` is spelled this way, so this is the difference
        between a census that follows the product and one that quietly stops at the package
        boundary. `import x as y` was never handled either, for the same reason nobody noticed.
        """
        f = node.func
        if isinstance(f, ast.Attribute):
            if isinstance(f.value, ast.Name):
                cand = self.module_alias.get(mod, {}).get(f.value.id, f"{f.value.id}.py")
                if (cand, f.attr) in self.defs:
                    return [(cand, self.defs[(cand, f.attr)])]
            return []
        if not isinstance(f, ast.Name):
            return []
        name = f.id
        if name in self.imports.get(mod, {}):
            m, n = self.imports[mod][name]
            if (m, n) in self.defs:
                return [(m, self.defs[(m, n)])]
        if (mod, name) in self.defs:
            return [(mod, self.defs[(mod, name)])]
        return list(self.by_name.get(name, ()))

    def _declared_fields(self):
        """Every field name DECLARED on a class in src/ — `work_root: Path` on SwapConfig.

        🔴 THE HARVESTS BELOW ARE RESTRICTED TO THESE, and the restriction is not tidiness.
        Harvesting any keyword argument instead let one call — `wav_to_mp3(wav, audio=scratch)`
        — teach the census that the word `audio` means the scratch, everywhere, in every
        module. A config field is a declaration about where a tree LIVES; a keyword argument
        is one call passing one value, and reading it as the former silently disarms whole
        subsystems.
        """
        out = set()
        for tree in self.trees.values():
            for node in ast.walk(tree):
                if isinstance(node, ast.ClassDef):
                    for stmt in node.body:
                        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                            out.add(stmt.target.id)
        return out

    def _infer_safe_fields(self):
        """Config fields BUILT from the scratch — `work_root=scratch.scratch_root(...)`.

        Harvested from the construction rather than listed, so a field renamed in 5.1 keeps
        working and a field quietly REPOINTED at a store root stops being safe on the same
        commit. Two passes: a field can be built from another field that was itself just
        proven safe.
        """
        fields = self._declared_fields()
        for _ in range(3):
            before = set(self.safe_attrs)
            for tree in self.trees.values():
                for node in ast.walk(tree):
                    if isinstance(node, ast.Call):
                        for kw in node.keywords:
                            if kw.arg in fields and self.is_scratch(kw.value):
                                self.safe_attrs.add(kw.arg)
                    elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                        val = node.value
                        tgts = node.targets if isinstance(node, ast.Assign) else [node.target]
                        if val is not None and self.is_scratch(val):
                            for t in tgts:
                                if isinstance(t, ast.Attribute) and t.attr in fields:
                                    self.safe_attrs.add(t.attr)
            if self.safe_attrs == before:
                break
        self.safe_attrs -= self.vault_attrs      # a store root always wins over a guess

    def _routed_tree_names(self):
        """The tree names out of `vault_store.ROUTES`, READ rather than imported.

        Parsed, not imported, for the same reason everything else here is: this file must
        stay a parser with no runtime dependency on the app it is auditing. Importing
        `vault_store` drags in loguru and the whole config stack, and a census that cannot run
        without the application booting is a census that stops running.
        """
        out = set()
        tree = self.trees.get("vault_store.py")
        if tree is None:
            return out
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            for k, v in zip(node.keys, node.values):
                if isinstance(k, ast.Constant) and k.value == "trees":
                    out.update(c.value for c in ast.walk(v)
                               if isinstance(c, ast.Constant) and isinstance(c.value, str))
        return out

    def _infer_vault_fields(self):
        """THE MIRROR IMAGE, and the half that finds bugs: config fields built from a ROUTED
        TREE. `TrainConfig.rvc_dir` is `root / "voice_models"`; `SwapConfig.training_dir` is
        `root / "voice_training"`. Both are vault trees, and `root` is a PARAMETER of the
        resolve_config that builds them — so nothing rooted at a module-level store constant
        is visible here and the taint dies at the config boundary.

        That gap is not academic. It hid `voiceswap.speech_path`'s bare `p.is_file()` (speech
        refs silently resolve to nothing on an encrypted box) and `voicetrain._link`'s
        hardlink of a 600 MB .index into `voice_models/` in cleartext, under a cleartext name.

        The tree names are read from `vault_store.ROUTES` — the same list the router itself
        uses — so registering a store in 5.1 teaches this rule about it on the same commit.
        """
        trees = self._routed_tree_names()
        fields = self._declared_fields()
        self.vault_attrs = set()
        for tree in self.trees.values():
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                for kw in node.keywords:
                    if kw.arg not in fields:
                        continue
                    for sub in ast.walk(kw.value):
                        if isinstance(sub, ast.Constant) and sub.value in trees:
                            self.vault_attrs.add(kw.arg)

    def _infer_scratch_returns(self):
        """Functions whose EVERY return is scratch-rooted — `enhance.scratch_path`,
        `bulk._job_dir`, `cleanup._cleanup_preview_dir`. Run first, because it is what stops
        the vault inference from claiming the plaintext boundary as its own.

        "Every", not "any": a function that sometimes hands back a store path and sometimes a
        temporary is exactly the one worth looking at by hand.
        """
        for _ in range(4):
            before = set(self._returns_scratch)
            for mod, tree in self.trees.items():
                for node in ast.walk(tree):
                    if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        continue
                    rets = [n.value for n in ast.walk(node)
                            if isinstance(n, ast.Return) and n.value is not None]
                    if rets and all(self.is_scratch(r) for r in rets):
                        self._returns_scratch.add((mod, node.name))
            if self._returns_scratch == before:
                break

    # ── fixpoint 1: which functions return a vault path ──────────────────────────────────

    def _infer_returns(self):
        """Inferred, not annotated. `_pending_chapter_wavs` is declared `-> list` and hands
        back chapter WAVs in `output/`; an annotation-driven census believes it and loses the
        whole enhance to-do list.

        TWO ANSWERS, and keeping them apart is what stops the over-approximation compounding:

          UNCONDITIONAL — the return is rooted at a store root or a module constant, so every
            call to it yields a vault path. `_book_dir`, `_books_file`, `concat_book_mp3`.
          PARAMETRIC — the return is only as tainted as an ARGUMENT was. `stems.demucs_out_dir`
            is `Path(work) / DEMUCS_MODEL / Path(song).stem`: called with the scratch workdir
            it is scratch, and marking it "returns a vault path" made every Demucs stem probe
            in `get_stems` a finding. Recorded as the carrying parameters instead, and resolved
            per call site in `taint()`.

        🔴 A NESTED def SEES ITS PARENT'S LOCALS — HERE TOO, not only in `_scan_fn`. This walked
        every FunctionDef with no idea what enclosed it, so a closure's return was judged against
        its OWN parameters alone. `book_to_audio.start_section` builds `chunks_dir = chunks_base /
        section['filename']` from a `Path` parameter and closes over it:

            def cpath(i):
                return chunks_dir / f"chunk_{i:04d}.wav"

        `chunks_dir` is not a local of `cpath`, so `cpath` came out UNTAINTED — and with it every
        `cpath(i).<op>()` in the module, in both halves of the render. `finish_section` deletes a
        truncated chunk that way, and on an encrypted box that bare `unlink` raised
        FileNotFoundError on a plaintext name and took the whole book down with it (7.3.8). This
        is the one call in `book_to_audio.py` that 5.0-M6 did not route, and the reason it was not
        found by the file whose entire job is finding it.

        The chain is seeded outermost-first and the function's own bindings win, exactly as
        `_scan_fn` does it — same argument, same order, and it is a fixpoint either way.
        """
        for _ in range(8):
            before = (set(self._returns_vault_path), dict(self._returns_param))
            for mod, tree in self.trees.items():
                if mod in _NOT_SCANNED:
                    continue
                for node, enclosing in self._functions(tree):
                    rets = [n.value for n in ast.walk(node)
                            if isinstance(n, (ast.Return, ast.Yield)) and n.value is not None]
                    if not rets:
                        continue
                    # Computed once per function, not once per probe: `_locals` is itself a
                    # fixpoint and this loop already runs it O(params) times.
                    outer = {}
                    for up in enclosing:
                        outer.update(self._locals(mod, up))

                    def tainted_with(seeds, _outer=outer, _fn=node, _rets=rets):
                        loc = dict(_outer)
                        loc.update(self._locals(mod, _fn, only_params=seeds))
                        return any(self.taint(mod, e, loc)
                                   for r in _rets for e in _value_exprs(r))

                    if (mod, node.name) not in self._returns_vault_path and tainted_with(set()):
                        self._returns_vault_path.add((mod, node.name))   # store-rooted
                        continue
                    _pos, allp = _params(node)
                    carriers = {p for p in allp if tainted_with({p})}
                    if carriers:
                        self._returns_param[(mod, node.name)] = carriers
            if (set(self._returns_vault_path), dict(self._returns_param)) == before:
                break

    # ── fixpoint 2: which parameters reach a child process ───────────────────────────────

    def _flows(self, fn, seeds):
        """Names in `fn` derived from `seeds`. Syntactic and deliberately generous: this
        answers "could this parameter's value end up in that argv", and over-answering costs
        an allow-list line while under-answering costs a silent child-process failure."""
        live = set(seeds)
        for _ in range(4):
            before = set(live)
            for node in ast.walk(fn):
                src, tgts = None, []
                if isinstance(node, ast.Assign):
                    src, tgts = node.value, node.targets
                elif isinstance(node, ast.AnnAssign) and node.value is not None:
                    src, tgts = node.value, [node.target]
                elif isinstance(node, ast.NamedExpr):
                    src, tgts = node.value, [node.target]
                elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                    src, tgts = node.iter, [node.target]
                elif isinstance(node, ast.withitem) and node.optional_vars is not None:
                    src, tgts = node.context_expr, [node.optional_vars]
                if src is None:
                    continue
                if any(isinstance(n, ast.Name) and n.id in live for n in ast.walk(src)):
                    for t in tgts:
                        live |= {n.id for n in ast.walk(t) if isinstance(n, ast.Name)}
            if live == before:
                break
        return live

    def _self_routes(self, fn, live):
        """Does this function hand `live` through the router's child seam itself?

        `voiceswap.ffprobe_duration` does exactly this — `with vault_fs.child_input(path, ...)`
        — and so its eight callers are correct as written. Detecting it rather than listing it
        is what keeps the answer right when the seam moves.
        """
        for node in ast.walk(fn):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None)
            if name not in _CHILD_SEAM:
                continue
            if any(isinstance(n, ast.Name) and n.id in live for n in ast.walk(node)):
                return True
        return False

    def _infer_conduits(self):
        """A CONDUIT is a function that carries one of its parameters into a child process's
        argv — directly, or by handing it to another conduit's conduit parameter.

        🔴 THIS IS THE CATEGORY NO GREP COULD REACH. `ffprobe_duration(path) -> float | None`
        reads as a pure function; it is a subprocess wearing a return type. `_enhance_book`
        summed it over a book's chapters to quote the GPU hours the user was about to approve,
        and got 0.0 for every one, and told them it was about to enhance "0.0h of audio".
        """
        for _ in range(8):
            changed = False
            for (mod, name), fn in self.defs.items():
                if mod in _NOT_SCANNED:
                    continue
                _, allp = _params(fn)
                for p in sorted(allp - self._conduits[(mod, name)]):
                    live = self._flows(fn, {p})
                    if self._self_routes(fn, live):
                        continue                      # routed at the door — not a conduit
                    if self._reaches_child(mod, fn, live, exclude=(mod, name)):
                        self._conduits[(mod, name)].add(p)
                        changed = True
            if not changed:
                break

    def _reaches_child(self, mod, fn, live, exclude):
        for node in ast.walk(fn):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) \
                    and f.value.id == "subprocess" and f.attr in _SUBPROCESS_OPS:
                if any(isinstance(n, ast.Name) and n.id in live for n in ast.walk(node)):
                    return True
            for tgt in self.resolve(mod, node):
                if tgt == exclude or (tgt[0], tgt[1].name) == exclude:
                    continue
                slots = self._conduits.get((tgt[0], tgt[1].name))
                if not slots:
                    continue
                pos, _all = _params(tgt[1])
                for i, a in enumerate(node.args):
                    slot = pos[i] if i < len(pos) else None
                    if slot in slots and any(isinstance(n, ast.Name) and n.id in live
                                             for n in ast.walk(a)):
                        return True
                for kw in node.keywords:
                    if kw.arg in slots and any(isinstance(n, ast.Name) and n.id in live
                                               for n in ast.walk(kw.value)):
                        return True
        return False

    # ── taint ────────────────────────────────────────────────────────────────────────────

    def _locals(self, mod, fn, only_params=None):
        """name -> why-it-is-tainted, for one function body.

        `only_params` restricts which parameters are seeded, which is how `_infer_returns`
        asks its two questions: `set()` = "is the return tainted with NO tainted arguments?"
        (unconditional), `{p}` = "does parameter p carry taint out?" (parametric)."""
        args = list(fn.args.posonlyargs) + list(fn.args.args) + list(fn.args.kwonlyargs)
        tainted = dict(self.globals.get(mod, {}))
        for a in args:                          # a parameter SHADOWS the module constant
            tainted.pop(a.arg, None)
        for a in args:
            if only_params is not None and a.arg not in only_params:
                continue
            if only_params is not None or (a.annotation is not None
                                           and "Path" in ast.unparse(a.annotation)):
                tainted[a.arg] = "parameter annotated Path"
        # 🔴 THE PARAMETERS THIS PROBE IS HOLDING CLEAN, and it is what makes the
        # unconditional/parametric split above mean anything. `stems.demucs_out_dir` returns
        # `Path(work) / DEMUCS_MODEL / ...`; without this, the generic "Path() of a
        # non-literal" fallback fires on `work` even when the probe deliberately left it
        # unseeded, so EVERY path-shaped helper comes out unconditionally tainted and the
        # split collapses back to the over-approximation it was meant to refine.
        if only_params is not None:
            tainted[_HELD_CLEAN] = {a.arg for a in args if a.arg not in only_params}
        # 🔴 _own_nodes, NOT ast.walk — 5.1-P4.6, and this is a defect in P4.5a's own fix.
        # Seeding a nested def from its enclosing function is right; collecting the enclosing
        # function's bindings with ast.walk is not, because that sweeps in EVERY SIBLING'S
        # locals too. In a blueprint factory the siblings are thirteen unrelated routes, so
        # `p = voicetrain.source_path(...)` in one route tainted `p` in another and the census
        # reported two touches that are provably fine. Over-reporting is the safe direction and
        # it still cost real time: an ALLOW entry written for a bug that is not there is a false
        # claim that outlives the reader who wrote it.
        for _ in range(4):
            before = dict(tainted)
            for node in self._own_nodes(fn):
                src, tgts = None, []
                if isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
                    why = self.taint(mod, node.iter, tainted)
                    if why and isinstance(node.target, ast.Name):
                        tainted[node.target.id] = why
                    continue
                if isinstance(node, ast.Assign):
                    src, tgts = node.value, node.targets
                elif isinstance(node, ast.AnnAssign) and node.value is not None:
                    src, tgts = node.value, [node.target]
                elif isinstance(node, ast.NamedExpr):
                    src, tgts = node.value, [node.target]
                elif isinstance(node, ast.withitem) and node.optional_vars is not None:
                    src, tgts = node.context_expr, [node.optional_vars]
                if src is None:
                    continue
                why = self.taint(mod, src, tainted)
                if not why:
                    continue
                for tgt in tgts:
                    if isinstance(tgt, ast.Name):
                        tainted[tgt.id] = why
                    elif isinstance(tgt, (ast.Tuple, ast.List)):
                        for e in tgt.elts:
                            if isinstance(e, ast.Name):
                                tainted[e.id] = why
            if tainted == before:
                break
        return tainted

    def is_scratch(self, node, depth=0):
        """PROVABLY the plaintext boundary — the one thing that kills taint outright.

        Distinct from "not known to be tainted", and the distinction is load-bearing:
        `Path(<unknown>)` is a finding by design, so without a positive answer here every
        `Path(cfg.scratch_root)` in the app reads as a possible vault path.
        """
        if depth > 8 or node is None:
            return False
        safe = getattr(self, "safe_attrs", _SAFE_ATTRS)
        if isinstance(node, ast.Attribute):
            return node.attr in safe or self.is_scratch(node.value, depth + 1)
        if isinstance(node, ast.Name):
            # `__file__` is src/, which is our own code and never encrypted — it is the third
            # entry in test_m6_router.py's _EXEMPT for exactly that reason. `WEBUI` and every
            # other asset path in the app hangs off it.
            return node.id in safe or node.id == "__file__"
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            return self.is_scratch(node.left, depth + 1)
        if isinstance(node, ast.Call):
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None)
            if name in _SAFE_ROOT_CALLS:
                return True
            if isinstance(f, ast.Attribute) and f.value is not None \
                    and name in _PROPAGATING | {"Path"}:
                return self.is_scratch(f.value, depth + 1)
            if name == "Path" and node.args:
                return self.is_scratch(node.args[0], depth + 1)
            for tmod, tfn in self.resolve("", node):
                if (tmod, tfn.name) in self._returns_scratch:
                    return True
            return False
        return False

    def taint(self, mod, node, tainted):
        """Why `node` might be a vault path, or None."""
        if self.is_scratch(node):
            return None
        unwrapped = list(_value_exprs(node))
        if unwrapped != [node]:                   # a container or a pass-through call
            for e in unwrapped:
                why = self.taint(mod, e, tainted)
                if why:
                    return why
            return None
        if isinstance(node, ast.Name):
            if node.id in tainted:
                return tainted[node.id]
            return "store root" if node.id in _VAULT_ROOT_NAMES else None
        if isinstance(node, ast.Attribute):
            if node.attr in getattr(self, "vault_attrs", ()):
                return f"cfg.{node.attr} — a routed tree (vault_store.ROUTES)"
            if _store_root_of(node):              # paths.BASE_DIR — same root, module-qualified
                return "store root"
            return self.taint(mod, node.value, tainted) if node.attr in _PROPAGATING else None
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            if _store_root_of(node.left) \
                    and isinstance(node.right, ast.Constant) \
                    and node.right.value in _EXEMPT_PREFIX:
                return None                       # deliberately-cleartext, per _EXEMPT_PREFIX
            return self.taint(mod, node.left, tainted)
        if isinstance(node, ast.Subscript):
            return self.taint(mod, node.value, tainted)
        if isinstance(node, ast.IfExp):
            return (self.taint(mod, node.body, tainted)
                    or self.taint(mod, node.orelse, tainted))
        if isinstance(node, ast.Call):
            f = node.func
            name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None)
            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) \
                    and f.value.id in _ROUTER_MODULES:
                return None
            if name in _SAFE_ROOT_CALLS:
                return None
            if name in _VAULT_ROOT_CALLS:
                return f"{name}()"
            if name == "Path":
                if not node.args or isinstance(node.args[0], ast.Constant):
                    return None
                why = self.taint(mod, node.args[0], tainted)
                if why:
                    return why
                if self._root_name(node.args[0]) in tainted.get(_HELD_CLEAN, ()):
                    return None                   # a parameter this probe is holding clean
                return "Path() of a non-literal — may be a vault path"
            if name in _PROPAGATING and isinstance(f, ast.Attribute):
                return self.taint(mod, f.value, tainted)
            for tmod, tfn in self.resolve(mod, node):
                if (tmod, tfn.name) in self._returns_vault_path:
                    return f"{tfn.name}() returns a vault path"
                carriers = self._returns_param.get((tmod, tfn.name))
                if not carriers:
                    continue
                # Only as tainted as the argument it was handed — resolved HERE, per call.
                pos, _all = _params(tfn)
                for i, a in enumerate(node.args):
                    if (pos[i] if i < len(pos) else None) in carriers:
                        why = self.taint(mod, a, tainted)
                        if why:
                            return f"{tfn.name}() passes through a vault path ({why})"
                for kw in node.keywords:
                    if kw.arg in carriers:
                        why = self.taint(mod, kw.value, tainted)
                        if why:
                            return f"{tfn.name}() passes through a vault path ({why})"
            return None
        return None

    # ── the scan ─────────────────────────────────────────────────────────────────────────

    def findings(self):
        """[(module, function, line, call-text, why)] — every unjustified touch."""
        out = []
        for mod, tree in self.trees.items():
            if mod in _NOT_SCANNED:
                continue
            for fn, chain in self._functions(tree):
                out += self._scan_fn(mod, fn, chain)
        return out

    @staticmethod
    def _functions(tree, chain=()):
        """Yield (FunctionDef, enclosing-defs-outermost-first) for every def in the tree."""
        for node in ast.iter_child_nodes(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                yield node, chain
                yield from _Index._functions(node, chain + (node,))
            else:
                yield from _Index._functions(node, chain)

    @staticmethod
    def _own_nodes(fn):
        """Every node belonging to THIS function, stopping at a nested `def`.

        🔴 5.1-P4.5. `findings()` walks the tree and scans every FunctionDef it meets — so a
        nested one was scanned twice: once as itself, and once as part of its parent's subtree.
        Two findings, same call, different `function` field, and the ALLOW list can only excuse
        one spelling. That was invisible until Phase 4, because a route was a module-level
        `def`; now every route is nested inside `create_<domain>_blueprint()`, so the SECOND
        attribution is always the factory — a label that says nothing about which route, and
        the same for all thirteen of them.

        Descends into `Lambda` on purpose: a lambda is not a FunctionDef, so it never gets a
        scan of its own, and `on_line=lambda line: emit(...)` is a real conduit.
        """
        stack, out = list(ast.iter_child_nodes(fn)), []
        while stack:
            n = stack.pop()
            out.append(n)
            if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                stack += list(ast.iter_child_nodes(n))
        return out

    @staticmethod
    def _root_name(node):
        """The leftmost Name in a path expression — `src.path` -> "src", `d / n` -> "d"."""
        while True:
            if isinstance(node, ast.Attribute):
                node = node.value
            elif isinstance(node, ast.Subscript):
                node = node.value
            elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
                node = node.left
            elif isinstance(node, ast.Call):
                node = node.func.value if isinstance(node.func, ast.Attribute) else None
                if node is None:
                    return None
            else:
                return node.id if isinstance(node, ast.Name) else None

    def _routed_here(self, fn):
        """Variables this function passes to `route()` itself — it owns both arms."""
        out = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Call):
                name = node.func.attr if isinstance(node.func, ast.Attribute) \
                    else getattr(node.func, "id", None)
                if name in _ROUTE_CHECKS:
                    for a in node.args:
                        root = self._root_name(a)
                        if root:
                            out.add(root)
        return out

    def _scan_fn(self, mod, fn, enclosing=()):
        # 🔴 A NESTED def SEES ITS PARENT'S LOCALS, and the taint has to travel with them.
        # `_own_nodes` stopped the double-attribution, but scanning `finalize` in isolation
        # also lost `ws` — bound in `_playground_stream_gen`, closed over here — and the
        # census silently stopped reporting a call it had reported for months. Seed from the
        # enclosing chain outermost-first, then let the function's own bindings win.
        tainted = {}
        for outer in enclosing:
            tainted.update(self._locals(mod, outer))
        tainted.update(self._locals(mod, fn))
        routed = set().union(*(self._routed_here(f) for f in enclosing + (fn,)))
        hits = []

        def add(kind, node, why, touched=None):
            if touched is not None and self._root_name(touched) in routed:
                return                      # the else arm of this function's own route check
            text = ast.unparse(node)
            hits.append((mod, fn.name, node.lineno,
                         text if len(text) <= 110 else text[:107] + "...", f"{kind}: {why}"))

        for node in self._own_nodes(fn):        # NOT ast.walk — see _own_nodes
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            if isinstance(f, ast.Attribute):
                base, attr = f.value, f.attr
                if isinstance(base, ast.Name) and base.id in _ROUTER_MODULES:
                    continue                                   # this IS the routed form
                if isinstance(base, ast.Name) and base.id == "shutil" and attr in _SHUTIL_OPS:
                    for a in node.args:
                        why = self.taint(mod, a, tainted)
                        if why:
                            add("bare shutil", node, why, a)
                            break
                    continue
                if isinstance(base, ast.Name) and base.id == "os" and attr in _OS_OPS:
                    for a in node.args:
                        why = self.taint(mod, a, tainted)
                        if why:
                            add("bare os", node, why, a)
                            break
                    continue
                if isinstance(base, ast.Name) and base.id == "subprocess" \
                        and attr in _SUBPROCESS_OPS:
                    for n in ast.walk(node):
                        if isinstance(n, (ast.Name, ast.Call, ast.BinOp, ast.Attribute)):
                            why = self.taint(mod, n, tainted)
                            if why:
                                add("vault path -> child process", node, why, n)
                                break
                    continue
                if attr in _PATH_OPS:
                    why = self.taint(mod, base, tainted)
                    if why:
                        add("bare pathlib", node, why, base)
                    continue
            name = f.id if isinstance(f, ast.Name) else getattr(f, "attr", None)
            if name == "open" and node.args:
                why = self.taint(mod, node.args[0], tainted)
                if why:
                    add("bare open()", node, why, node.args[0])
                continue
            for tmod, tfn in self.resolve(mod, node):
                slots = self._conduits.get((tmod, tfn.name))
                if not slots or (tmod, tfn.name) == (mod, fn.name):
                    continue
                pos, _all = _params(tfn)
                found = False
                for i, a in enumerate(node.args):
                    slot = pos[i] if i < len(pos) else None
                    if slot in slots:
                        why = self.taint(mod, a, tainted)
                        if why:
                            add(f"vault path -> child, via {tfn.name}({slot})", node, why, a)
                            found = True
                            break
                if found:
                    break
                for kw in node.keywords:
                    if kw.arg in slots:
                        why = self.taint(mod, kw.value, tainted)
                        if why:
                            add(f"vault path -> child, via {tfn.name}({kw.arg})", node, why, kw.value)
                            found = True
                            break
                if found:
                    break
        return hits


# ── the allow-list ───────────────────────────────────────────────────────────────────────
#
# Keyed on (module, function, the call as the parser re-prints it) — NOT on a line number,
# which every edit above it invalidates, and not on a bare function name, which would excuse
# a second call that arrives later. EDIT THE CALL AND THE EXEMPTION LAPSES, which is the
# behavior you want: the reason was written about the code as it stood.
#
# 🔴 EVERY ENTRY IS AN ARGUMENT, NOT A NAME. "It's fine" is not a reason. The question each
# one answers is: *what makes this path provably NOT inside the vault, or this call provably
# not a bare filesystem touch?*

# The reasons, named once and shared, because most findings arrive in clusters that have ONE
# argument between them. A shared constant is still an argument per entry — it is the same
# argument, stated once, which is what you want when six calls in a function are six steps of
# one atomic write.

_SCRATCH_WORK = (
    "the whole function operates in the SCRATCH: its dst/tmp are `scratch_path(cfg, ...)` or a "
    "`<job-id>` dir under `cfg.scratch_root`, which route() deliberately disclaims (design "
    "§8.1). A bare open() here is the correct call, not a missed one — the scratch is the "
    "plaintext boundary and children read it.")

_PARAM_IS_SCRATCH = (
    "flagged only because the parameter is annotated `Path`; every caller passes a scratch "
    "path. The annotation heuristic is what caught `_enhance_chapter(wav: Path)`, so it stays "
    "— this is the cost of that catch.")

_CLI_USER_PATH = (
    "a standalone CLI whose output path is the user's own `-o`/`--out-dir` argument: an "
    "arbitrary filesystem location the user names, not a store path. The vault is not "
    "involved unless they point it inside one, which is their call to make.")

_OUR_OWN_CODE = (
    "under `src/` — our own code and shipped assets, rooted at `__file__`. Third entry in "
    "test_m6_router.py::_EXEMPT, same reason: never encrypted.")

_CONFIG_NOT_CONTENT = (
    "a CONFIG path, not user content — an interpreter, a script, a cert, an env file. It "
    "lives outside every store root, and several must be readable while the vault is LOCKED.")

_IMMUTABLE_MODEL_ARTIFACT = (
    "a hash-verified, versioned Chatterbox artifact under the explicit read-only model mount. "
    "These static model weights are not user-authored store content; verification reads them "
    "before loading the selected local model.")

_MODEL_PRESENCE_CHECK = (
    "an existence check on a model WEIGHT or its catalog file, under the read-only model mount "
    "(LEADVOCAL_MODELS) or torch's hub cache (TORCH_HOME). It reads no content and these are not "
    "user-authored store files; the point of the check is to refuse to start a child that would "
    "otherwise download the file.")

_APPLIO_WORKSPACE = (
    "Applio's own workspace (`cfg.logs_dir` = `~/Applio/logs/`), which is outside every root "
    "and NOT ours — 4.9 GB of checkpoints the router deliberately cannot reach (M7). "
    "voicetrain.py:351 documents why this must not become `vault_fs.exists`.")

_ROUTE_ELSE_ARM = (
    "the PLAIN arm of this function's own `vault_store.route(dest)` check, reached only when "
    "the destination is not ours — an un-migrated box, or a registry pointed outside the "
    "install root. `route() -> None` does not mean 'no vault', it means 'not ours' "
    "(vault_fs's module docstring), so a bare hardlink here is the correct call and the "
    "encrypted case is handled ten lines down. Flagged because the temp is derived from "
    "`dest` rather than being `dest`, which the route-check heuristic cannot follow.")

_ROUTES_ITSELF = (
    "the plaintext arm of a seam that routes explicitly one line away, or the primitive the "
    "router's own fallback is built out of. `vault_fs.from_scratch` calls `move_into_place`; "
    "routing it would be a cycle.")

_SCENE_SCRATCH = (
    "6.0 §3: a scene build's plaintext lives in the SCRATCH and nowhere else — the per-message "
    "copies it holds against eviction (§9), the gap silence, and the WAV the enhancer reads. "
    "Every one of these paths is `scratch.file(root, ...)` or derived from the `scratch_root` "
    "the builder was handed; the two ends that DO touch the store — reading the speech cache "
    "and landing output/scenes — go through `vault_fs.child_input` and `mp3_concat`/"
    "`scenes.write_manifest` respectively. Flagged for the annotation heuristic's usual reason.")

#: 🔴 8.1-m1. THE ONLY TREE IN THIS REPO THAT MUST **NOT** BE ROUTED THROUGH `vault_fs`, which is
#: why it needs a written argument rather than a fix.
#:
#: `acestage` stages audio into the ACE-Step backend's own temp directory
#: (`/ai-output/acestep-tmp`, pinned by `ACESTEP_TMPDIR` on both units). Two facts make routing it
#: not merely unnecessary but WRONG:
#:
#:   1. The consumer is a SEPARATE PROCESS that holds no DEK and must never be given one. An
#:      app-encrypted file there is a file ACE-Step cannot open — the staging exists precisely to
#:      cross that boundary.
#:   2. `validate_audio_path` 400s on any absolute path outside `tempfile.gettempdir()`, so the
#:      destination is not ours to choose. There is exactly one directory that works.
#:
#: 📌 AND THE PRIVACY REQUIREMENT IS STILL MET, by the filesystem rather than by the app:
#: `/ai-output` is a symlink to `the host vault-backed output tree`, i.e. inside the gocryptfs mount.
#: Encrypted at rest, just not by us. The names are opaque (`scratch.opaque_name`), so the words
#: do not arrive as filenames either — the doctrine `src/scratch.py` §1 is about.
_ACE_STAGE = (
    "8.1-m1 §6: the ACE-Step backend's temp directory, which is deliberately OUTSIDE vault_fs — "
    "the backend is a separate process with no DEK, and `validate_audio_path` rejects any path "
    "outside its own `gettempdir()` with a 400, so there is exactly one directory that works and "
    "it is not ours to route. Encrypted at rest by gocryptfs (`/ai-output` -> `~/.vault/`), and "
    "the names are `scratch.opaque_name` hashes. Flagged for the annotation heuristic's usual "
    "reason: `root`/`dst` are non-literal Paths.")

#: 🔴 THE LoRA TRAINING HANDOFF (). ai-toolkit is a separate process holding no DEK, so
#: on an encrypted install the routed dataset is not merely unreadable to it — the path does not
#: EXIST. Measured that day: the config said `.../lora_datasets/2f8801076ea1` while the platter
#: held `lora_datasets/tl7PaW0O.../NSe8dp5E...`, directory AND filenames encrypted, and
#: The host configuration was unreadable by the smoke helper, exposing the same root-path assumption.
#:
#: 📌 THE DESTINATION IS THE SCRATCH, WHICH `vault_store` DELIBERATELY NEVER ROUTES — its own
#: ROUTES comment says encrypting `work/scratch` "would encrypt the destination
#: decrypt_to_scratch writes TO. A circular absurdity." 5.0 §8.3 calls it "the ONE place plaintext
#: is allowed to touch the disk", and `enhance.py` already uses it to feed a foreign venv. On remote host
#: it is a dm-crypt volume re-keyed from /dev/urandom at every boot.
#:
#: ⚠️ THE SOURCE IS STILL READ THROUGH THE ROUTER — `vault_fs.read_bytes(src)` — so this copies
#: OUT of the vault rather than reading around it. Names are `scratch.opaque_name` hashes, so the
#: subject's name does not arrive as a filename. Flagged for the heuristic's usual reason: `dst`,
#: `staged` and `cfg_path` are non-literal Paths.
_LORA_LEND = (
    "9.0-m6: ComfyUI's OWN lora directory, which is not the vault and cannot be. `/ai-models` is "
    "gocryptfs's, deliberately outside the store — `vault_store.route()` answers None for it — and "
    "ComfyUI is a foreign process with no DEK, so a routed path there is a path it cannot open. "
    "The census reads `lora_dir()` as returning a vault path because it returns `Path()` of a "
    "config value; it is the one directory under /ai-models this app writes to, bounded to one "
    "filename PREFIX and one run's lifetime. The SOURCE is still read through "
    "vault_fs.read_bytes, the lent name is a hash so the shared directory learns nothing, the "
    "`finally` takes it back, and `lorapublish.sweep()` at startup is the guarantee behind that "
    "promise. See src/vocalis/runtime/lorapublish.py.")

_LORA_COLLECT = (
    "9.0 defect 5: READING BACK what ai-toolkit wrote in the scratch, to put it in the vault. "
    "The path is `TrainState.staged_out` / `staged_log`, recorded by `stage_for_ai_toolkit` — a "
    "scratch path, which `vault_store` deliberately never routes; the analyzer cannot see that "
    "through a str field on a dataclass, which is the only reason these are here rather than "
    "classified automatically like the writes in that function. Every one is a READ of plaintext "
    "a foreign process produced, and the DESTINATION goes through vault_fs.write_bytes. "
    "See src/vocalis/runtime/loratrain.py::TrainRun._collect_models.")

_DOCKER_TRAIN_REFUSAL = (
    "The ai-toolkit launcher probe and process spawn are the external training boundary. "
    "`launcher_available()` returns false in encrypted Docker mode, and `launch_real()` refuses "
    "before probing the script or spawning a child; legacy mode retains this launcher. The Docker "
    "request test verifies the existing 501 response and no-spawn contract.")

#: 9.7.2 — the extension build stamp reads the extension's own source.
#:
#: 🔴 **NOT A VAULT PATH, AND PROVABLY SO RATHER THAN BY ASSERTION.** These three read
#: `BASE_DIR/sillytavern/extension/`, which `test_m6_router.py::_EXEMPT` records for the same
#: reason `nomi` is recorded: it is the extension we SHIP, tracked in git, and SillyTavern serves
#: it to a browser out of its own tree. There is no user content in it and never can be — a copy
#: of it is sitting unencrypted under `~/sillytavern.encrypted/public/` by design, because that is
#: the only place a browser can load it from.
#:
#: ⚠️ **AND ROUTING THEM WOULD BE WRONG, NOT MERELY UNNECESSARY.** `vault_fs` on an unrouted path
#: is a plain read today, so it would look harmless — but it would state that these bytes are
#: vault content, and the next person to widen `ROUTES` would encrypt the file that has to stay
#: readable for the hash to mean anything.
_EXT_STAMP = (
    "the SillyTavern extension's OWN source, which is tracked in git and served to a browser by "
    "SillyTavern — see test_m6_router.py::_EXEMPT for BASE_DIR/sillytavern. Read to derive the "
    "build stamp from the file's bytes (9.7.2), which is what makes 'is your tab running this "
    "code?' answerable without pinning the stamp to the release number."
)

_ALLOW = {
    ("vocalis/runtime/extstamp.py", "compute", "(d / name).read_text(encoding='utf-8')"): _EXT_STAMP,
    ("vocalis/runtime/extstamp.py", "declared", "p.stat()"): _EXT_STAMP,
    ("vocalis/runtime/extstamp.py", "declared", "p.read_text(encoding='utf-8')"): _EXT_STAMP,
    # ── 9.0 defect 4: the LoRA training's plaintext handoff to ai-toolkit ────────────────
    #
    # 📌 The three staging WRITES that used to be excused here are gone, and nothing was
    # loosened to remove them: `stage_for_ai_toolkit` now builds its root as
    # `Path(scratch.scratch_root()) / ...` in one expression instead of `root =
    # scratch.scratch_root()` and `Path(root) / ...` two lines later, so `is_scratch` resolves
    # it through `_SAFE_ROOT_CALLS` and the census classifies them correctly by itself.
    # `test_the_ALLOW_list_cannot_rot_either` is what required their removal.
    ("vocalis/runtime/loratrain.py", "_progress_log", "staged.is_file()"): _LORA_COLLECT,
    ("vocalis/runtime/loratrain.py", "launcher_available", "LAUNCH_SCRIPT.is_file()"):
        _DOCKER_TRAIN_REFUSAL,
    ("vocalis/runtime/loratrain.py", "launch_real", "script.is_file()"):
        _DOCKER_TRAIN_REFUSAL,
    ("vocalis/runtime/loratrain.py", "launch_real",
     "subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, ..."):
        _DOCKER_TRAIN_REFUSAL,
    ("vocalis/runtime/loratrain.py", "_collect_models",
     "Path(out).rglob(f'*{MODEL_SUFFIX}')"): _LORA_COLLECT,
    # ── 9.0-m6: lending a trained model to ComfyUI for the length of one test run ────────
    ("vocalis/runtime/lorapublish.py", "available", "lora_dir(app_settings).is_dir()"): _LORA_LEND,
    ("vocalis/runtime/lorapublish.py", "sweep", "d.is_dir()"): _LORA_LEND,
    ("vocalis/runtime/lorapublish.py", "sweep", "d.iterdir()"): _LORA_LEND,
    ("vocalis/runtime/lorapublish.py", "lent", "d.is_dir()"): _LORA_LEND,
    ("vocalis/runtime/lorapublish.py", "lent",
     "dst.write_bytes(vault_fs.read_bytes(src))"): _LORA_LEND,
    ("vocalis/runtime/lorapublish.py", "lent", "dst.unlink(missing_ok=True)"): _LORA_LEND,
    ("vocalis/runtime/loratrain.py", "_collect_log", "src.is_file()"): _LORA_COLLECT,
    ("vocalis/runtime/loratrain.py", "_collect_log", "src.read_bytes()"): _LORA_COLLECT,
    # ── 8.6.5: the uncapped-range fix reads plain files it has already established are OURS ──
    ("store_serve.py", "gen", "open(p, 'rb')"):
        "THE UNROUTED BRANCH, WHICH IS THE DEFINITION OF 'not a vault path'. `_send_plain` is "
        "only reached when `vault_store.route(p)` answered None — the file is not in the vault, "
        "so there is nothing to decrypt and `open()` is the correct reader. It exists to CAP the "
        "range on /ai-output songs, which Werkzeug was otherwise answering whole and pinning a "
        "browser socket with. The routed branch beside it still goes through `vault.stream_range` "
        "and is untouched.",
    ("store_serve.py", "_send_plain", "p.stat()"):
        "Metadata on the same already-established non-vault path — the byte length, to build a "
        "Content-Range. Guarded by OSError so a file that vanished falls back to send_file "
        "rather than 500ing.",
    # ── 8.6 lead-vocal routing: the repo's own file, and the job's own scratch ────────────
    ("leadvocal.py", "detect_script_sha", "Path(script).read_bytes()"):
        "This reads the configured repository script, not vault content. The digest detects a drifted satellite copy.",
    ("stemsplit.py", "_separate_remote", "wet_p.read_bytes()"):
        "The decoded WAV is job scratch already outside the vault; the job owns and deletes this directory.",
    ("stemsplit.py", "_separate_remote", "backing_p.write_bytes(parts.get('backing') or b'')"):
        "Remote separator output uses the same per-job scratch path as the local child.",
    ("stemsplit.py", "_separate_remote", "dry_p.write_bytes(parts['dry'])"):
        "The same, for the de-reverbed half. Written only when the request asked for it and "
        "the satellite actually returned it; §3.5's alignment check downstream decides whether "
        "it is USED, exactly as it does on the local path.",
    # ── 6.0 audio scenes: all four are the scratch ───────────────────────────────────────
    ("scene_build.py", "make_silence",
     "dest.parent.mkdir(parents=True, exist_ok=True)"): _SCENE_SCRATCH,
    # `cl={layout}` since 6.0-m2: the gap has to match the OUTPUT profile in channels as well as
    # rate, or a stereo Join gets a mono silence spliced between stereo sources.
    ("scene_build.py", "make_silence",
     "subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', "
     "f'anullsrc=r={int(sample_rate)}:cl={layout}', '-t', f'..."): _SCENE_SCRATCH,
    ("scene_build.py", "_own_copy", "shutil.copyfile(plain, own)"):
        "BOTH ends are scratch by construction: `plain` is what `vault_fs.child_input` just "
        "handed back (a decrypted copy on an encrypted box, the original on a plaintext one) "
        "and `own` is a `scratch.file`. The copy exists precisely BECAUSE child_input returns "
        "the original when the file is not ours — see _own_copy's docstring, which is about "
        "the eviction §9 promises protection from.",
    # The caller of `build_scene`. Its `output_dir` came to look like a conduit when the build
    # started storing the joined file's own probe: `probed = ffprobe_duration(scene_mp3)` (with
    # `scene_mp3` under `output_dir`) then `job.duration_s = probed` makes `job` a live name in
    # `_flows`, and `job.gap_s` is the `seconds` argument to `make_silence`. That is the analyzer
    # being generous, not a path: `seconds` is a float, and the one real touch of the store
    # path — `ffprobe_duration(scene_mp3)` — routes at its own door (`vault_route` + `child_input`
    # inside tts_utils.ffprobe_duration), as does `concat_mp3`, whose inputs are the scratch
    # copies `_own_copy` made.
    ("vocalis_stream_http.py", "_run",
     "scene_build.build_scene(job, resolved, output_dir=scene_output_dir(), "
     "render_many=lambda group, cancel: sce..."):
        "`output_dir` is only ever used to name the scenes directory; the one child that reads "
        "a file under it (ffprobe of the joined scene) goes through `tts_utils.ffprobe_duration`, "
        "which decrypts to scratch at its own door. The analyzer's flow from that probe's result "
        "into `job` and on to `make_silence(seconds)` carries a float, not a path.",
    # ── 6.0-m2 Join: the same shape, for the same reason ─────────────────────────────────
    ("clip_join.py", "_own_copy", "shutil.copyfile(plain, own)"):
        "Identical to `scene_build._own_copy` and justified identically: `plain` is what "
        "`vault_fs.child_input` just handed back and `own` is a `scratch.file`, so BOTH ends "
        "are plaintext by construction. Join needs it MORE than a scene build does — its "
        "inputs include the Playground store, where a re-render replaces a clip in place while "
        "ffmpeg is walking it.",
    # ── 6.1-m1a scene edit: every one of these is downstream of ONE child_input ──────────
    #
    # `run_edit` materializes the source scene exactly once, at the top of its ExitStack:
    #     plain_src = Path(stack.enter_context(vault_fs.child_input(src_mp3, root)))
    # THAT is the routing. Everything below reads `plain_src` — a decrypted scratch copy on an
    # encrypted box, the original on a plaintext one — and writes into `scratch.file` handles.
    # The analyzer cannot follow the variable across the three call sites, which is the whole
    # reason each needs a sentence rather than a suppression.
    ("scene_edit.py", "cut",
     "subprocess.run(['ffmpeg', '-y', '-ss', f'{max(0.0, start):.3f}', "
     "'-t', f'{max(0.0, dur):.3f}', '-i', str(sr..."):
        "Both ends are plaintext by construction and there is only one call site: `src` is "
        "`plain_src` (see above) and `dest` is a `scratch.file` opened on the line before. "
        "⚠️ If a second caller ever appears, it has to hold to the same contract or this "
        "justification stops being true — the annotation on the parameter is not a guarantee, "
        "this sentence is.",
    ("scene_edit.py", "run_edit", "cut(plain_src, dst, start, end - start)"):
        "`plain_src` is the child_input copy and `dst` is a `scratch.file`. Scratch to scratch.",
    ("scene_edit.py", "run_edit", "clip_join.probe(plain_src)"):
        "ffprobe on the child_input copy, never on the store path — and it only READS, to learn "
        "the scene's own sample rate and channel count so the gap can be made to match it (§4.2, "
        "which is 6.0-m2's mono-gap defect in its second home).",


    # ── tts_utils: the primitives the router is BUILT OUT OF ─────────────────────────────
    ("tts_utils.py", "atomic_replace", "tmp.replace(dest)"): _ROUTES_ITSELF,
    ("tts_utils.py", "move_into_place", "dst.parent.mkdir(parents=True, exist_ok=True)"): _ROUTES_ITSELF,
    ("tts_utils.py", "move_into_place", "os.replace(src, part)"): _ROUTES_ITSELF,
    ("tts_utils.py", "move_into_place", "shutil.copyfile(src, part)"): _ROUTES_ITSELF,
    ("tts_utils.py", "move_into_place", "src.unlink(missing_ok=True)"): _ROUTES_ITSELF,
    ("tts_utils.py", "move_into_place", "part.unlink(missing_ok=True)"): _ROUTES_ITSELF,
    ("tts_utils.py", "source_stat", "Path(p).stat()"): _ROUTES_ITSELF,
    ("tts_utils.py", "voice_for_model", "Path(hit[0]).exists()"):
        "`hit[0]` is the memoized SCRATCH path from a previous decrypt_to_scratch — the probe "
        "asks whether our own temporary is still on disk before reusing it.",
    ("tts_utils.py", "load_env_file", "path.read_text(encoding='utf-8')"): _CONFIG_NOT_CONTENT,
    ("leadvocal.py", "missing_model_files", "(root / name).is_file()"): _MODEL_PRESENCE_CHECK,
    ("stems.py", "require_demucs_model", "path.is_file()"): _MODEL_PRESENCE_CHECK,
    ("tts_utils.py", "_verified_chatterbox_model_dir", "artifact.is_file()"): _IMMUTABLE_MODEL_ARTIFACT,
    ("tts_utils.py", "_verified_chatterbox_model_dir", "artifact.stat()"): _IMMUTABLE_MODEL_ARTIFACT,
    ("tts_utils.py", "_verified_chatterbox_model_dir", "artifact.open('rb')"): _IMMUTABLE_MODEL_ARTIFACT,
    ("tts_utils.py", "setup_logging",
     "Path(log_path).parent.mkdir(parents=True, exist_ok=True)"):
        "logs/ is never encrypted and must be writable while the vault is LOCKED — it is in "
        "both _EXEMPT_PREFIX and test_m6_router.py::_EXEMPT for that reason.",

    # ── bulk: every batch lives under cfg.scratch_root ───────────────────────────────────
    ("bulk.py", "land_output", "dst.parent.mkdir(parents=True, exist_ok=True)"): _PARAM_IS_SCRATCH,
    ("bulk.py", "decode_to_wav", "dst.parent.mkdir(parents=True, exist_ok=True)"): _SCRATCH_WORK,
    ("bulk.py", "decode_to_wav",
     "subprocess.run(['ffmpeg', '-y', '-i', str(src), '-ac', '1', '-f', 'wav', str(tmp), "
     "'-loglevel', 'error'], c..."): _SCRATCH_WORK,
    ("bulk.py", "decode_to_wav", "tmp.is_file()"): _SCRATCH_WORK,
    ("bulk.py", "decode_to_wav", "Path(tmp).unlink(missing_ok=True)"): _SCRATCH_WORK,
    ("bulk.py", "decode_to_wav", "os.replace(tmp, dst)"): _SCRATCH_WORK,
    ("bulk.py", "manifest_of", "Path(job.result_zip).is_file()"): _SCRATCH_WORK,
    ("bulk.py", "stage_add", "Path(tmp).unlink(missing_ok=True)"): _SCRATCH_WORK,
    ("bulk.py", "copy_result_to_staging", "Path(job.result_zip).is_file()"): _SCRATCH_WORK,
    ("bulk.py", "copy_result_to_staging", "Path(tmp).unlink(missing_ok=True)"): _SCRATCH_WORK,

    # ── cleanup: same, plus the trim scorer's isolated venv ──────────────────────────────
    ("cleanup.py", "trim_scorer_unavailable_reason", "Path(self.trim_scorer_python).is_file()"): _CONFIG_NOT_CONTENT,
    ("cleanup.py", "trim_scorer_unavailable_reason", "Path(self.trim_scorer_script).is_file()"): _CONFIG_NOT_CONTENT,
    ("cleanup.py", "scores_cache_path", "Path(cfg.trim_scorer_script).stat()"): _CONFIG_NOT_CONTENT,
    ("cleanup.py", "denoise_available", "path.open('rb')"):
        "a readability probe of the DeepFilterNet3 config and checkpoint under the read-only model "
        "mount (`denoise_model_root`); static model weights, not user content, and the probe reads "
        "no bytes.",
    ("cleanup.py", "compute_scores", "Path(out).is_file()"): _SCRATCH_WORK,
    ("cleanup.py", "compute_scores", "Path(out).read_text(encoding='utf-8')"): _SCRATCH_WORK,
    ("cleanup.py", "compute_scores", "Path(p).unlink(missing_ok=True)"): _SCRATCH_WORK,
    ("cleanup.py", "_write_wav", "dst.parent.mkdir(parents=True, exist_ok=True)"): _SCRATCH_WORK,
    ("cleanup.py", "_write_wav", "os.replace(tmp, dst)"): _SCRATCH_WORK,
    ("cleanup.py", "_write_wav", "tmp.unlink(missing_ok=True)"): _SCRATCH_WORK,
    ("cleanup.py", "_decode_wav", "dst.parent.mkdir(parents=True, exist_ok=True)"): _SCRATCH_WORK,
    ("cleanup.py", "_decode_wav",
     "subprocess.run(['ffmpeg', '-y', '-i', str(src), '-ac', '1', '-f', 'wav', str(tmp), "
     "'-loglevel', 'error'], c..."): _SCRATCH_WORK,
    ("cleanup.py", "_decode_wav", "tmp.is_file()"): _SCRATCH_WORK,
    ("cleanup.py", "_decode_wav", "Path(tmp).unlink(missing_ok=True)"): _SCRATCH_WORK,
    ("cleanup.py", "_decode_wav", "os.replace(tmp, dst)"): _SCRATCH_WORK,
    ("cleanup.py", "run_cleanup", "Path(p).unlink(missing_ok=True)"): _SCRATCH_WORK,

    # ── generate.py — the standalone chunked-render CLI ──────────────────────────────────
    ("generate.py", "main", "output_path.parent.mkdir(parents=True, exist_ok=True)"): _CLI_USER_PATH,
    ("generate.py", "main", "chunks_dir.exists()"): _CLI_USER_PATH,
    ("generate.py", "main", "shutil.rmtree(chunks_dir)"): _CLI_USER_PATH,
    ("generate.py", "main", "chunks_dir.mkdir(parents=True, exist_ok=True)"): _CLI_USER_PATH,
    # 7.3.8: newly VISIBLE, not newly written. `chunk_path` is a closure over `chunks_dir`, and
    # until this commit `_infer_returns` judged a nested def against its own parameters alone —
    # so these two were invisible for the same reason `book_to_audio`'s truncated-chunk unlink
    # was, which is the bug that commit fixes. Same `_CLI_USER_PATH` argument as the four above,
    # and it is a DIFFERENT tree from the book pipeline's: this CLI's `chunks_dir` is
    # `<repo>/chunks/<stem>` or the user's own `--chunks-dir`, never `cache_root()/chunks`
    # (`CHUNKS_ROOT`), which is the routed one.
    ("generate.py", "main", "chunk_path(i).exists()"): _CLI_USER_PATH,
    ("generate.py", "main", "chunk_path(i).unlink()"): _CLI_USER_PATH,

    # ── the shipped web UI and other src/-rooted assets ──────────────────────────────────
    # 5.1-P4.5: `create_stream_blueprint` was the DUPLICATE spelling of the line below —
    # `cand.exists()` is inside `webui_stream_register`, which is nested in the factory, and
    # the census used to attribute the same call to both. It now attributes each call once,
    # to its innermost enclosing def, so only the real one is left.
    ("vocalis_stream_http.py", "webui_stream_register", "cand.exists()"): _OUR_OWN_CODE,

    # ── voicetrain: Applio's workspace, and the one plaintext->store boundary ────────────
    ("voicetrain.py", "workspace_encrypted",
     "(Path(cfg.logs_dir) / WORKSPACE_SENTINEL).is_file()"): _APPLIO_WORKSPACE,
    # The same non-routing question asked one level out: does the workspace exist AT ALL?
    # Both of these run only when the sentinel is already absent, and they exist to tell a
    # misconfigured VOCALIS_APPLIO_DIR apart from an unmounted volume — which is the
    # difference between "fix the unit" and "mount the disk" (). Deliberately not
    # `vault_fs.exists`, for the reason at voicetrain.py:351: the question is about the MOUNT.
    ("voicetrain.py", "check_workspace", "Path(cfg.logs_dir).exists()"): _APPLIO_WORKSPACE,
    ("voicetrain.py", "read_tb_scalars", "d.is_dir()"): _APPLIO_WORKSPACE,
    ("voicetrain.py", "read_tb_scalars", "d.glob('events.out.tfevents.*')"): _APPLIO_WORKSPACE,
    ("voicetrain.py", "_last_logged_epoch", "log.is_file()"): _APPLIO_WORKSPACE,
    ("voicetrain.py", "_last_logged_epoch", "open(log, 'rb')"): _APPLIO_WORKSPACE,
    ("voicetrain.py", "_last_logged_epoch", "log.stat()"): _APPLIO_WORKSPACE,
    # `_link` is BOTH arms in one function, so it appears twice in this list — once for the
    # plain hardlink and once for the staged copy. That is the shape the census wants: the
    # route(dest) check above them is what makes each correct, and each says so.
    ("voicetrain.py", "_link", "tmp.unlink(missing_ok=True)"): _ROUTE_ELSE_ARM,
    ("voicetrain.py", "_link", "os.link(src, tmp)"): _ROUTE_ELSE_ARM,
    ("voicetrain.py", "_link", "os.replace(tmp, dest)"): _ROUTE_ELSE_ARM,
    ("voicetrain.py", "_link", "shutil.copyfile(src, tmp)"):
        "stages APPLIO'S index into the scratch so `vault_fs.from_scratch` can encrypt it in "
        "— the same boundary and the same shape as `_copy` below. It used to hardlink "
        "straight into voice_models/ instead; see the docstring for what that cost and for "
        "why the hardlink could not survive being fixed.",
    ("voicetrain.py", "_copy", "shutil.copyfile(src, tmp)"):
        "copies APPLIO'S checkpoint into the scratch so that `vault_fs.from_scratch` can eat "
        "the COPY — the docstring explains why from_scratch must not be given the original "
        "(it removes its source, which here is the checkpoint Deploy and Resume both need).",

    # ── retained Stems: Demucs intermediates stay in the per-job scratch ─────────────────
    ("stem_engine.py", "get_stems", "work.mkdir(parents=True, exist_ok=True)"): _PARAM_IS_SCRATCH,
    ("stem_engine.py", "get_stems", "shutil.copyfile(source.path, song)"):
        "`source.path` is checked with `vault_store.route` immediately above. Routed sources use "
        "`decrypt_to_scratch`; this copy is reached only for an unowned clear source.",
    ("stem_engine.py", "get_stems", "(output / name).exists()"):
        "`output` is `demucs_out_dir(work, song)` inside the per-job scratch workdir; "
        "Demucs writes these outputs there before `stems.commit` ingests them.",
    ("stem_engine.py", "get_stems", "instrumental.exists()"):
        "the summed instrumental is an ffmpeg output in the per-job scratch workdir.",

    # The legacy module remains in the source tree for shared song and helper contracts; its
    # Stems path also explicitly routes encrypted inputs and keeps Demucs outputs in scratch.
    ("voiceswap.py", "get_stems", "work.mkdir(parents=True, exist_ok=True)"): _PARAM_IS_SCRATCH,
    ("voiceswap.py", "get_stems", "shutil.copyfile(src.path, song)"):
        "`src.path` is checked with `vault_store.route` immediately above. Routed sources use "
        "`decrypt_to_scratch`; this copy is reached only for an unowned clear source.",
    ("voiceswap.py", "get_stems", "(out / s).exists()"):
        "`out` is `demucs_out_dir(work, song)` inside the per-job scratch workdir; "
        "Demucs writes these outputs there before `stems.commit` ingests them.",
    ("voiceswap.py", "get_stems", "inst.exists()"):
        "the summed instrumental is an ffmpeg output in the per-job scratch workdir.",

    # ── 8.4 "Lead vocals only": every path in the lead chain is the job's scratch ─────────
    # `work` is `cfg.work_root / job.id` under VOCALIS_SCRATCH_DIR, and the three files below
    # are its children. Nothing here is a store path: the ONE thing that lands in the store
    # goes through `stems.commit()`, i.e. through `vault_fs.from_scratch`, which is the seam.
    ("stemsplit.py", "_run_lead", "work.mkdir(parents=True, exist_ok=True)"): _PARAM_IS_SCRATCH,
    ("stemsplit.py", "_run_lead", "backing_p.exists()"):
        "the karaoke model's output in the per-job scratch workdir. It is a DETECTOR's audio "
        "and is discarded after the spans are measured — it never approaches the store.",
    ("stemsplit.py", "_run_lead", "dry_p.exists()"):
        "the de-reverb model's output in the same scratch workdir. What survives it is the CUT, "
        "which commit() lands through the seam; the full-length dry file itself is thrown away.",
    # The rate normalization added after the first live run. `path` is always one of the child's
    # own outputs in the scratch (`backing_p` / `dry_p`, both `work / …`), and `fixed` is its
    # sibling — the census flags them because the helper's parameter is annotated `Path`, which
    # is the same heuristic that caught `_enhance_chapter(wav: Path)` and is worth its cost.
    ("stemsplit.py", "_at_vocal_rate", "fixed.exists()"): _PARAM_IS_SCRATCH,
    ("stemsplit.py", "_run_lead", "_at_vocal_rate(backing_p, 'detector output')"):
        "`backing_p` is the karaoke model's output in the per-job SCRATCH workdir — a DETECTOR's "
        "audio, discarded once the spans are measured. It never approaches the store.",
    ("stemsplit.py", "_run_lead", "_at_vocal_rate(dry_p, 'de-reverbed vocal')"):
        "`dry_p` is the de-reverb model's output in the same scratch workdir. What survives it is "
        "the CUT, which commit() lands through the seam; the full-length dry file is thrown away.",
    ("stemsplit.py", "_run_lead", "spans_p.write_text(report, encoding='utf-8')"):
        "written into the scratch and then handed to commit() in `produced`, exactly like every "
        "stem beside it — the store copy is made by vault_fs.from_scratch, not by this line.",

    # 8.5 — the join-into-one-training-clip decode. `dst` is always a file inside the caller's
    # `scratch.directory(...)`, i.e. the take being materialized for ffmpeg; the clip that
    # actually reaches the pool goes through voicetrain.import_clip, which routes both ends.
    ("vocalis/web/train.py", "decode_take", "Path(dst).exists()"): _PARAM_IS_SCRATCH,

    # ── vocalis_server ───────────────────────────────────────────────────────────────────
    ("vocalis_server.py", "resolve_ssl_context", "Path(path).exists()"): _CONFIG_NOT_CONTENT,
    ("vocalis/runtime/enhancement.py", "enhance_one", "dst.is_file()"): _PARAM_IS_SCRATCH,
    ("vocalis/runtime/enhancement.py", "enhance_one",
     "enhance.run_enhance(configs.enhance_cfg(), src, dst, nfe, device, cancel=job.cancel, "
     "on_line=lambda line: e..."):
        "`run_enhance` routes its own source at the door (M7) and writes to a scratch dst; "
        "`configs.enhance_cfg()` is flagged only because the config OBJECT carries store "
        "roots. (Spelled `_enhance_cfg()` until 5.1-P3.6 and living in vocalis_server.py as "
        "`_enhance_one` until 5.1-P4.4 — the key is MODULE + FUNCTION + SOURCE TEXT, so both "
        "the accessor rename and the move rewrote it, and the rot test said so each time.)",
    ("enhance.py", "run_enhance",
     "_run_enhance(cfg, plain_src, dst, nfe, device, cancel, on_line)"):
        "this IS the routing: `plain_src` is the decrypted scratch copy the line above made, "
        "which is exactly what the child needs and why the seam is here.",
    # 5.1-P4.14 (ledger 3.9): RE-KEYED to vocalis/runtime/procs.py, and `_claim_root` is
    # `claim_root` now — it has a caller outside its own module. Re-keyed, never deleted: an
    # entry pointing at the module a function has left stops MATCHING, which stops it auditing
    # while the suite stays green (§6.1). The writes are unchanged and still justified.
    ("vocalis/runtime/procs.py", "claim_root", "root.mkdir(parents=True, exist_ok=True)"):
        "the instance-marker root — the scratch and cache roots a SECOND install would "
        "collide on. Claimed before anything is unlocked, and deliberately best-effort.",
    ("vocalis/runtime/procs.py", "claim_root", "marker.is_file()"): _CONFIG_NOT_CONTENT,
    ("vocalis/runtime/procs.py", "claim_root",
     "marker.read_text(encoding='utf-8')"): _CONFIG_NOT_CONTENT,
    ("vocalis/runtime/procs.py", "claim_root",
     "marker.write_text(f'{os.getpid()} {mine}\\n', encoding='utf-8')"): _CONFIG_NOT_CONTENT,
    # 5.1-P4.5: the Bulk tab is vocalis/web/bulk.py now. `process` is _BulkCleanupEngine's.
    ("vocalis/web/bulk.py", "process", "bulk.decode_to_wav(src, wav_in)"): _PARAM_IS_SCRATCH,
    ("vocalis/web/bulk.py", "process",
     "cleanup.run_denoise(cfg, wav_in, cleaned, cancel=job.cancel, on_line=lambda line: "
     "emit(job, {'type': 'log',..."): _PARAM_IS_SCRATCH,
    ("vocalis/web/bulk.py", "process",
     "bulk.land_output(cleaned, dst, self.fmt, source=src)"): _PARAM_IS_SCRATCH,
    ("vocalis/web/bulk.py", "bulk_download", "Path(job.result_zip).is_file()"): _SCRATCH_WORK,
    ("vocalis/runtime/enhancement.py", "decode_to_wav",
     "subprocess.run(['ffmpeg', '-y', '-i', str(src), '-ac', '1', str(dst), '-loglevel', "
     "'error'], capture_output..."): _PARAM_IS_SCRATCH,
    # 5.1-P4.12: RE-KEYED to vocalis/web/playground.py, not deleted. An entry keyed to the module
    # a function no longer lives in stops MATCHING, which stops it auditing while the suite stays
    # green (§6.1). The writes themselves are unchanged and still justified.
    ("vocalis/web/playground.py", "run_playground_job",
     "_pg_write_clip(job, ws, pool.sr, upto)"):
        "`ws` is the chunk WORKSPACE under chunks/playground — `_pg_write_clip` routes its own "
        "reads and writes; the flag is on the workspace being handed in, not on a bare call.",
    ("vocalis/web/playground.py", "finalize",
     "_pg_write_clip(job, ws, pool.sr, fin['upto'])"):
        "same workspace, same seam, reached from the streaming path instead of the job path. "
        "(Keyed on `finalize`, the nested def that makes the call, not on its parent "
        "`_playground_stream_gen` — see _own_nodes, 5.1-P4.5.)",
    # REMOVED . This entry excused the call because "`run_cleanup` routes its source at
    # the door" — and that was NOT TRUE. Only the TRIM branch routed (via `_trim_to_scratch`'s own
    # child_input); the denoise-only branch handed `_decode_wav` the logical path and ffmpeg died
    # "No such file or directory" on every encrypted install. The census flagged this exact call
    # and it was waved through on a property the code did not have. The fix gives `run_cleanup` a
    # child_input in that branch, which makes it a genuine self-routing conduit — so the census
    # stops reporting the call on its own and no exemption is needed. **An exemption whose reason
    # is a claim about the callee is only as good as the claim.**
    ("vocalis/web/cleanup.py", "cleanup_preview",
     "cleanup.run_denoise(cfg, orig, cleaned, wet=den['wet'], atten=den['atten'])"):
        "`orig` is already the decrypted scratch copy this route made; `cleaned` is its "
        "sibling in the same scratch dir.",
    # 5.1-P4.9: Create-a-voice is vocalis/web/voices.py now. Every one of these four operates on
    # a SCRATCH path -- the freeze chain's intermediates -- which is exactly why the move had to
    # re-key them rather than drop them: an entry keyed to a module the function no longer lives
    # in stops matching, and a census entry that stops matching stops auditing.
    ("vocalis/web/voices.py", "_design_freeze",
     "cleanup.run_denoise(ccfg, cur, den, wet=1.0, device='cpu')"): _PARAM_IS_SCRATCH,
    ("vocalis/web/voices.py", "_design_freeze",
     "subprocess.run(['ffmpeg', '-y', '-i', str(cur), '-af', 'highpass=f=120:poles=2', '-f', "
     "'wav', str(hp), '-lo..."): _PARAM_IS_SCRATCH,
    ("vocalis/web/voices.py", "_design_freeze",
     "enhance.run_enhance(ecfg, cur, enh, device=device, cancel=cancel, "
     "on_line=lambda ln: logger.info(f'voxcpm f..."): _PARAM_IS_SCRATCH,
    ("vocalis/web/voices.py", "_design_freeze", "Path(dst).is_file()"):
        "`dst` is the generated freeze candidate in scratch; the caller ingests the completed "
        "candidate through `vault_fs.from_scratch`.",
    ("vocalis/web/voices.py", "_design_freeze", "Path(p).unlink(missing_ok=True)"): _SCRATCH_WORK,

    # ── 8.1-m1 ACE-Step staging: the ONE tree that must NOT be routed ─────────────────────
    ("vocalis/runtime/acestage.py", "stage", "root.mkdir(parents=True, exist_ok=True)"):
        _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "stage", "dst.is_file()"): _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "stage", "dst.stat()"): _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "stage", "os.utime(dst, None)"): _ACE_STAGE,
    # 8.2.5: the copy became write-temp-then-`os.replace`, because the name is deterministic and
    # the fast path accepts any non-empty file — a copy cut off mid-write used to leave a
    # truncated reference every later press REUSED, silently, until the sweep. Same destination,
    # same _ACE_STAGE argument, one more hop.
    ("vocalis/runtime/acestage.py", "stage", "shutil.copyfile(made, tmp)"): _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "stage", "os.replace(tmp, dst)"): _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "stage", "tmp.unlink(missing_ok=True)"):
        "the atomic-rename temp, removed on the failure path (after a successful `os.replace` "
        "it no longer exists and `missing_ok` makes that a no-op). It only ever lives inside "
        "the staging root, under a `staged_name` the sweep also recognizes.",
    ("vocalis/runtime/acestage.py", "stage", "made.unlink(missing_ok=True)"):
        "the temp `vault_fs.to_scratch` just produced, removed after it is copied to the "
        "deterministic name — and ONLY when `made != src`, because `to_scratch` hands back the "
        "ORIGINAL file for a non-vault path and unlinking that would delete the user's stem out "
        "of a library this module does not own. Same guard, same reason, as "
        "`vault_fs.child_input`, which exists to make that condition impossible to get wrong.",
    ("vocalis/runtime/acestage.py", "sweep", "root.is_dir()"): _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "sweep", "root.iterdir()"): _ACE_STAGE,
    # m3: the candidate arm. Same destination, same argument — and note the SOURCE here is not a
    # file at all, so there is nothing that could have been routed even in principle.
    ("vocalis/runtime/acestage.py", "_stage_candidate",
     "root.mkdir(parents=True, exist_ok=True)"): _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "_stage_candidate", "dst.is_file()"): _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "_stage_candidate", "dst.stat()"): _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "_stage_candidate", "os.utime(dst, None)"): _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "_stage_candidate", "tmp.write_bytes(data)"):
        "8.1-m3: bytes fetched from the ACE-Step backend over HTTP, written into ITS temp "
        "directory so it can read them back for a remix. There is no vault path anywhere in this "
        "call — a candidate has never been in the vault, because nothing is stored until Save "
        "(see `/acestep/jobs/<id>/audio`'s docstring). Destination argued for in _ACE_STAGE. "
        "8.2.5: lands on a temp name and is `os.replace`d in, same atomicity rule as `stage`.",
    ("vocalis/runtime/acestage.py", "_stage_candidate", "os.replace(tmp, dst)"): _ACE_STAGE,
    ("vocalis/runtime/acestage.py", "_stage_candidate", "tmp.unlink(missing_ok=True)"):
        "the atomic-rename temp's failure-path cleanup — same entry as `stage`'s, same reason.",
    # 2026-10-11: the engine's OUTPUT folder inside that same tree (`<stage root>/api_audio`). It
    # holds the plaintext songs the engine wrote, none of them ever in the vault, and Vocalis
    # deletes the ones no candidate refers to any more (`acecands.reconcile_output`).
    ("vocalis/runtime/acestage.py", "output_dir", "out.is_dir()"):
        "the ACE-Step engine's own output folder inside the staging tree argued for in "
        "_ACE_STAGE: plaintext, written by a separate process, never a vault path. Only asked "
        "whether it exists.",
    ("vocalis/runtime/acestage.py", "sweep_loose", "Path(root).is_dir()"):
        "the staging root itself (`VOCALIS_ACESTEP_STAGE_DIR`), argued for in _ACE_STAGE; asked "
        "only whether it exists before the start-up sweep of the engine's loose audio files.",
    ("vocalis/runtime/acecands.py", "reconcile_output", "os.scandir(out)"):
        "lists the ACE-Step engine's output folder (`acestage.output_dir`), which is plaintext "
        "outside the vault for the reasons given in _ACE_STAGE. The listing only decides which "
        "plain files directly inside it nothing refers to; `_delete_files` removes them by name "
        "from the folder's real path and never follows a link.",

    # ── kobold / nomi ────────────────────────────────────────────────────────────────────
    ("kobold.py", "parse_kcpps", "Path(mp).exists()"):
        "a MODEL path read out of a .kcpps launcher profile — it points into /ai-models or "
        "wherever the user keeps GGUFs, never into a store.",
    ("kobold.py", "config_dir_readable", "Path(cfg.admindir).is_dir()"):
        "asks only whether KoboldCpp's own --admindir (the user's launcher-profile folder, "
        "configured as `kobold.admindir`) is visible to this process; it is KoboldCpp's folder, "
        "never a store, and the answer only decides between reading the .kcpps details and "
        "saying they are not readable from here.",
    ("nomi_speak.py", "promote_temp", "Path(tmp).unlink(missing_ok=True)"):
        "removes the SCRATCH temp after `vault_fs.from_scratch` has taken it into the store — "
        "the docstring on the line above says so.",

    # ── 8.7 voiceclean.py: the whole chain runs on the PLAINTEXT side of the seam ─────────
    #
    # The shape is `stemsplit`'s, for the same reason. Both children here — the separator in the
    # leadvocal venv and the enhancer in its own — are DEK-less: handed a store path they would
    # open a file that does not exist on disk. So `_run` opens with `vault_fs.child_input`, which
    # hands over a decrypted copy under the scratch root and removes it afterward, and every path
    # below is that copy or a sibling of it in `work = scratch_root() / f"voiceclean-{job.id}"`.
    #
    # 🔴 EXACTLY ONE THING CROSSES BACK, and it is not in this list: the final
    # `voice_utils.transcode_normalize(cur, dst)`, whose `dst` IS a store path and which routes
    # its own write. That is the seam; everything here is on the near side of it.
    ("voiceclean.py", "_run", "work.mkdir(parents=True, exist_ok=True)"):
        "`work` is `scratch_root() / voiceclean-<job id>` — the plaintext side, by construction.",
    ("voiceclean.py", "_run", "shutil.rmtree(work, ignore_errors=True)"):
        "removes that same per-job scratch dir. 🔴 It MUST be recursive rather than `rmdir`: the "
        "separator leaves its raw output in there, so a non-recursive tidy-up fails silently and "
        "leaves a plaintext copy of the user's voice in the scratch.",
    ("voiceclean.py", "_run", "out.is_file()"):
        "the ENHANCER's output, written by the child into that scratch dir. It becomes a voice "
        "only by way of transcode_normalize, which routes.",
    ("voiceclean.py", "_run",
     "dereverb_wav(cur, out, cfg=cfg, device=device, model=leadvocal.dereverb_model(''), work=work, cancel=job.ca..."):
        "`cur` is the value of the `vault_fs.child_input` context manager — already decrypted onto "
        "the plaintext side — and `out` is inside the per-job scratch dir.",
    ("voiceclean.py", "_run",
     "enhance.run_enhance(configs.enhance_cfg(), cur, out, device=device, cancel=job.cancel, on_line=lambda ln: l..."):
        "same two paths, and `run_enhance` routes its own `src` at the one door besides (its "
        "docstring, M6). Its config is an interpreter and model dir, not a store.",
    ("voiceclean.py", "dereverb_wav", "shutil.copyfile(src, staged)"):
        "🔴 THIS COPY IS WHY THE CHILD IS SAFE. `detect.py` puts its scratch at "
        "`<input>.parent / leadvocal-work`, so running it on a store path would make a working "
        "directory INSIDE voice_samples/ — observed live on development host before the fix. `src` is already "
        "plaintext (child_input) and `staged` is in the caller's scratch work dir.",
    ("voiceclean.py", "dereverb_wav", "raw.exists()"):
        "the separator's own output in the scratch work dir, discarded once it has been aligned.",
    ("voiceclean.py", "dereverb_wav", "_resample_to(raw, sr, work)"): _PARAM_IS_SCRATCH,
    ("voiceclean.py", "dereverb_wav", "Path(py).exists()"):
        "the leadvocal venv's INTERPRETER (`~/leadvocal-venv/bin/python`) — an install path, "
        "never a store one. Checked so a missing venv is a sentence rather than a traceback.",
    ("voiceclean.py", "dereverb_wav", "Path(script).exists()"):
        "`scripts/leadvocal/detect.py`, inside the repo. `src/` and its siblings are in the "
        "census's own _EXEMPT_PREFIX for the same reason: they are code, not a store.",
    ("voiceclean.py", "_resample_to", "fixed.exists()"): _PARAM_IS_SCRATCH,
    ("voiceclean.py", "_resample_to",
     "subprocess.run(leadvocal.build_resample_cmd(path, fixed, sr), capture_output=True, text=True, encoding='utf..."):
        "ffmpeg on the separator's own output and its sibling, both in the scratch work dir. The "
        "child is DEK-less, which is precisely why neither path may be a store path.",
}


# ── findings this census FOUND, that are REAL, and that are not fixed yet ────────────────
#
# 🔴 THIS IS NOT A SECOND ALLOW-LIST. An entry is a BUG with a diagnosis, parked for exactly
# as long as it takes to fix — the plan (TESTING_PLAN_5_0 §2) lands the census
# separately from the fixes, and this is what makes that possible without committing a red
# suite. `test_the_open_findings_register_is_shrinking` fails the moment an entry stops being
# reported, so a fix cannot land without its entry going with it.
#
# **IT IS EMPTY, AND EMPTY IS THE POINT.** The census's first run held thirty-two sites across
# twelve bugs — a cleartext book title on the platter, a 600 MB unencrypted .index in
# voice_models/, a resume check that never fired, a delete button that deleted nothing. All of
# them are fixed. Anything added here is a debt with a name on it, not a finding filed away.
_OPEN_FINDINGS = {}


def _key(f):
    return (f[0], f[1], f[3])


def _fmt(fs):
    by_mod = collections.defaultdict(list)
    for f in fs:
        by_mod[f[0]].append(f)
    out = []
    for mod in sorted(by_mod):
        out.append(f"\n  {mod}")
        for f in sorted(by_mod[mod], key=lambda x: x[2]):
            out.append(f"    :{f[2]} in {f[1]}()\n        {f[3]}\n        -> {f[4]}")
    return "\n".join(out)


@pytest.fixture(scope="module")
def census():
    return _Index()


@pytest.fixture(scope="module")
def findings(census):
    return census.findings()


# ── the census itself ────────────────────────────────────────────────────────────────────

def test_every_filesystem_touch_on_a_vault_path_is_routed_or_justified(findings):
    """Every finding must be routed through `vault_fs` or have a specific allow-list reason. Unresolved findings fail this guard; the allow-list cannot use a generic “probably safe” rationale.
    """
    unjustified = [f for f in findings
                   if _key(f) not in _ALLOW and _key(f) not in _OPEN_FINDINGS]
    assert not unjustified, (
        f"{len(unjustified)} filesystem operation(s) reach a possible vault path with no "
        f"routing and no written reason.\n"
        f"Route them through vault_fs, or add each to _ALLOW with an argument:\n"
        + _fmt(unjustified))


def test_the_open_findings_register_is_shrinking(findings):
    """An entry in `_OPEN_FINDINGS` that the census no longer reports has been FIXED — so
    delete it. This is what stops that block becoming a second allow-list: a fix cannot land
    without its entry going with it, and an entry cannot linger without the bug lingering too.
    """
    reported = {_key(f) for f in findings}
    stale = sorted(k for k in _OPEN_FINDINGS if k not in reported)
    assert not stale, (
        "these are recorded as OPEN bugs but the census no longer reports them — they are "
        "fixed, and their entries must be deleted with the fix:\n  "
        + "\n  ".join(f"{m}::{fn} — {call}" for m, fn, call in stale))


def test_the_ALLOW_list_cannot_rot_either(findings):
    """Exactly the argument test_m6_router.py::test_the_EXEMPT_list_cannot_rot_either makes,
    one file over: an exemption for a call that no longer exists is a stale claim, and a stale
    claim is how the last allow-list rotted. If the call was edited, its reason was written
    about code that is gone and has to be re-argued."""
    reported = {_key(f) for f in findings}
    stale = sorted(k for k in _ALLOW if k not in reported)
    assert not stale, (
        f"{len(stale)} allow-list entries excuse a call src/ no longer makes — drop them:\n  "
        + "\n  ".join(f"{m}::{fn} — {call}" for m, fn, call in stale))


# ── the guards against THIS FILE lying ───────────────────────────────────────────────────
#
# The lesson test_m6_router.py:455 had to learn, and `assert_no_cleartext`'s expect_files
# before it: **a parser that matches nothing passes, beautifully, forever.** Every assertion
# above is of the form "no findings that aren't excused", which a walk returning [] satisfies
# perfectly. So the walk has to be made to prove it is still looking at the code.

def test_the_census_still_SEES_the_code(census, findings):
    """Floors, not exact counts. A floor is a tripwire for the walk BREAKING; an exact count
    makes every honest deletion a test failure, which teaches people to edit the number
    without reading it — and then it guards nothing.

    🔴 5.1.1: THE FLOORS WERE 5.0-ERA AND 5.1 ROUGHLY DOUBLED THE SURFACE. Measured today:
    trees 65, returns 37, conduits 56, findings 83 — against floors of 25/15/20/40, i.e. 40
    modules could have vanished from the walk with this still green. The whole `vocalis/`
    package is 31 files, so dropping it entirely cleared every floor. Re-pinned to ~80% of
    measured, which is the intended tripwire distance: loose enough that honest deletions do
    not force an edit, tight enough that a broken walk cannot pass.
    """
    assert len(census.trees) >= 52, (
        f"only {len(census.trees)} modules parsed out of src/ — the walk has stopped seeing "
        f"the code, and a walk that sees nothing reports everything as routed")
    # ...and name the ones that matter, because a floor cannot tell you WHICH modules left.
    # These four do the most OUTPUT_DIR/vault filesystem work in the tree; nine blueprint
    # modules have no `_ALLOW` entry at all, so `test_the_ALLOW_list_cannot_rot_either` is not
    # a backstop for them and a floor of 52 would not notice all four leaving together.
    must_see = {"vocalis/web/books.py", "vocalis/web/playground.py", "vocalis/web/voices.py",
                "vocalis/runtime/configs.py"}
    assert must_see <= set(census.trees), (
        f"these modules dropped out of the census walk, so their filesystem touches are "
        f"audited by nothing: {sorted(must_see - set(census.trees))}")
    assert len(census._returns_vault_path) >= 29, (
        f"only {len(census._returns_vault_path)} functions inferred to return a vault path. "
        f"`_book_dir`, `_books_file`, `concat_book_mp3` and `_pending_chapter_wavs` are four "
        f"of them; if this collapsed, return-taint inference is broken")
    conduits = {k: v for k, v in census._conduits.items() if v}
    assert len(conduits) >= 44, (
        f"only {len(conduits)} child-process conduits found — `wav_to_mp3` and `_enhance_one` "
        f"are two, and losing this set loses the entire category of bug no grep could reach")
    assert census.vault_attrs, (
        "no config field was recognized as pointing at a routed tree. `TrainConfig.rvc_dir` "
        "and `SwapConfig.training_dir` are two; losing them lost four real bugs once already")
    assert len(findings) >= 66, (
        f"only {len(findings)} findings across all of src/ — this file's own history says "
        f"that is not a clean tree, it is a broken walk")


def test_a_PLANTED_bare_exists_is_caught(census, tmp_path):
    """The direct proof: hand the analyzer a module it has never seen, containing one obvious
    unrouted touch and one obviously-fine one, and check it separates them. Everything else
    here tests the census against code that was written before it existed; this tests it
    against code written to be caught."""
    planted = tmp_path / "planted.py"
    planted.write_text(
        "from pathlib import Path\n"
        "import scratch\n"
        "BOOKS = OUTPUT_DIR / 'books'\n"
        "def bad():\n"
        "    return (OUTPUT_DIR / 'x').exists()\n"
        "def alsobad(p):\n"
        "    return Path(p).read_bytes()\n"
        "def fine():\n"
        "    return (scratch.scratch_root() / 'x').exists()\n",
        encoding="utf-8")
    census.trees["planted.py"] = ast.parse(planted.read_text(encoding="utf-8-sig"))
    try:
        hits = {(f[1], f[3]) for f in census.findings() if f[0] == "planted.py"}
    finally:
        del census.trees["planted.py"]
    assert ("bad", "(OUTPUT_DIR / 'x').exists()") in hits, (
        "a bare .exists() on a store root was NOT caught — the census is not doing its job")
    assert ("alsobad", "Path(p).read_bytes()") in hits, (
        "a bare read on a Path() built from an unknown value was NOT caught")
    assert not [h for h in hits if h[0] == "fine"], (
        f"the scratch was reported as a vault path: {hits} — over-reporting the plaintext "
        f"boundary is how a census becomes noise nobody reads")


def test_a_CLOSURE_over_its_PARENTS_local_still_returns_a_vault_path(tmp_path):
    """Closure return inference must include tainted values captured from enclosing scopes. A planted source tree verifies that a closure over a vault `Path` is reported, while a closure over a scratch path remains unreported.
    """
    src = tmp_path / "src"
    src.mkdir(parents=True)
    (src / "planted.py").write_text(
        "from pathlib import Path\n"
        "import scratch\n"
        "def start(chunks_base: Path, name):\n"
        "    chunks_dir = chunks_base / name\n"
        "    def cpath(i):\n"
        "        return chunks_dir / f'chunk_{i:04d}.wav'\n"
        "    cpath(0).unlink()\n"
        "    return {'cpath': cpath}\n"
        "def finish(h):\n"
        "    cpath = h['cpath']\n"
        "    cpath(1).unlink()\n"
        "def fine(job):\n"
        "    work = scratch.scratch_root() / 'w'\n"
        "    def spath(i):\n"
        "        return work / f'{i}.wav'\n"
        "    spath(0).unlink()\n",
        encoding="utf-8")

    idx = _Index(tmp_path)
    assert ("planted.py", "cpath") in idx._returns_vault_path, (
        "a closure returning `<enclosing Path local> / name` was not inferred to return a vault "
        "path — the enclosing chain is not reaching the return-taint pass")

    hits = {(f[1], f[3]) for f in idx.findings()}
    assert ("start", "cpath(0).unlink()") in hits, (
        "a bare unlink through a closure was not caught IN the function that defines it")
    assert ("finish", "cpath(1).unlink()") in hits, (
        "a bare unlink through a closure carried out in a handle dict was not caught — this is "
        "book_to_audio.finish_section exactly, and it is where the real one lived")
    assert not [h for h in hits if h[0] == "fine"], (
        f"a closure over a SCRATCH local was reported as a vault path: {sorted(hits)}")


# ── the walk reaches subdirectories (5.1) ────────────────────────────────────────────────
#
# Until 5.1 `_src_files` was `glob("*.py")` — flat. Nothing under src/ was a package, so it was
# correct, and it would have kept passing while auditing less and less of the product the
# moment that stopped being true. The 5.1 refactor makes it stop being true on its first
# commit.
#
# They guard two different halves, and only the first one fails against the old code —
# verified by reverting rglob to glob and watching it go red:
#   * DESCENDS      — the WALK reaches nested files at all.  Red on the flat glob.
#   * INSIDE_a_...  — a nested module's findings survive the rest of the pipeline once it has
#                     been parsed. Green either way, because it injects into `trees` directly;
#                     it guards the relative-path KEY, not the walk. Under the flat glob it was
#                     simply moot, since nothing nested was ever parsed for it to be true of.

def test_the_walk_DESCENDS_into_subpackages(tmp_path):
    """Directly: plant modules at three depths plus a basename collision, and check every one
    of them is parsed under a distinct key. The collision is the point — `src/bulk.py` and
    `src/vocalis/web/bulk.py` are both natural names, and a basename-keyed dict would drop one
    with no error at all."""
    src = tmp_path / "src"
    (src / "vocalis" / "web").mkdir(parents=True)
    (src / "__pycache__").mkdir()
    for rel in ("bulk.py", "vocalis/__init__.py", "vocalis/web/__init__.py",
                "vocalis/web/bulk.py"):
        (src / rel).write_text("x = 1\n", encoding="utf-8")
    (src / "__pycache__" / "stale.py").write_text("x = 1\n", encoding="utf-8")

    keys = {_mod_key(p, tmp_path) for p in _src_files(tmp_path)}
    assert keys == {"bulk.py", "vocalis/__init__.py", "vocalis/web/__init__.py",
                    "vocalis/web/bulk.py"}, (
        f"the walk did not see src/ as it really is: {sorted(keys)}. A flat glob returns only "
        f"bulk.py here, and every subpackage module leaves the audit silently")
    assert "__pycache__/stale.py" not in keys, "compiled leftovers are not source"


def test_a_PLANTED_bare_exists_is_caught_INSIDE_a_subpackage(census, tmp_path):
    """And end-to-end: the same planted module as above, but keyed as a subpackage file. Proves
    a nested module's findings survive the whole pipeline — resolution, inference, reporting —
    rather than merely being parsed and then dropped on the floor."""
    planted = tmp_path / "planted.py"
    planted.write_text(
        "from pathlib import Path\n"
        "BOOKS = OUTPUT_DIR / 'books'\n"
        "def bad():\n"
        "    return (OUTPUT_DIR / 'x').exists()\n",
        encoding="utf-8")
    key = "vocalis/web/planted.py"
    census.trees[key] = ast.parse(planted.read_text(encoding="utf-8-sig"))
    try:
        hits = {(f[1], f[3]) for f in census.findings() if f[0] == key}
    finally:
        del census.trees[key]
    assert ("bad", "(OUTPUT_DIR / 'x').exists()") in hits, (
        f"an unrouted touch in a SUBPACKAGE was not reported (findings for {key}: {hits}). "
        f"The census parses it but the finding never surfaces — which is indistinguishable "
        f"from a clean module, and is what the 5.1 refactor would have produced for every "
        f"file it moved")


def test_a_MODULE_QUALIFIED_root_is_still_a_store_root(census, tmp_path):
    """🔴 `paths.OUTPUT_DIR / 'x'` must taint exactly as `OUTPUT_DIR / 'x'` does.

    This is the 5.1 shape. Once the install-root constants live in
    `vocalis/runtime/paths.py`, nothing spells them bare any more — `vocalis_server` alone has
    128 references and every Phase 4 blueprint will add more. An `ast.Attribute` whose `.attr`
    is not a propagating one falls straight through `taint()` and returns None, so the whole
    lot would have left the audit in one commit, with the census still reporting a clean tree.

    Planted rather than asserted against the real source, so it keeps testing the rule after
    the real source has moved on. Verified red before the fix: the bare form was found and the
    qualified one was not.
    """
    planted = tmp_path / "planted.py"
    planted.write_text(
        "from vocalis.runtime import paths\n"
        "def bare():\n"
        "    return (OUTPUT_DIR / 'x').exists()\n"
        "def qualified():\n"
        "    return (paths.OUTPUT_DIR / 'x').exists()\n"
        "def exempt():\n"
        "    return (paths.DATA_DIR / 'app_settings.yaml').exists()\n",
        encoding="utf-8")
    key = "vocalis/web/planted.py"
    census.trees[key] = ast.parse(planted.read_text(encoding="utf-8-sig"))
    try:
        hits = {f[1] for f in census.findings() if f[0] == key}
    finally:
        del census.trees[key]
    assert "bare" in hits, "the census stopped seeing even the bare form — the scan is broken"
    assert "qualified" in hits, (
        "`paths.OUTPUT_DIR / 'x'` was NOT treated as a vault path. Every install-root constant "
        "is spelled that way from 5.1-P3.5 on, so this is the whole product leaving the audit "
        "at once — and an empty finding list is indistinguishable from a clean tree")
    assert "exempt" not in hits, (
        "the _EXEMPT_PREFIX check must survive module qualification too, or app_settings.yaml "
        "becomes a finding that someone will silence with an allowlist entry instead")


def test_a_call_through_a_PACKAGE_module_alias_still_resolves(census, tmp_path):
    """🔴 `configs.enhance_cfg()` must resolve to `vocalis/runtime/configs.py`.

    `resolve()` used to build the module key by pasting `.py` onto the alias, which is exactly
    right for a flat module (`enhance.run_enhance` really is in `enhance.py`) and wrong for
    every module in the package, whose key is a path. An unresolved call is an UNTAINTED call,
    so a helper that returns a vault path stops being followed and its callers' findings
    vanish — silently, since nothing reports that the analysis gave up.

    Not hypothetical: moving `_enhance_cfg` into `runtime/configs.py` in P3.6 made
    `_design_freeze`'s `run_enhance` finding disappear entirely, and the only reason anyone
    noticed is that the ALLOW-list-rot test complained about the entry left behind. Without
    that entry it would have been a clean removal from the census with no signal at all.

    By the end of Phase 4 nearly every cross-module call in `src/` is spelled this way.
    """
    idx = census
    # The real tree: every runtime module vocalis_server imports must be resolvable by alias.
    aliases = idx.module_alias.get("vocalis_server.py", {})
    pkg = {a: m for a, m in aliases.items() if m.startswith("vocalis/")}
    assert pkg, ("vocalis_server's package-module aliases did not resolve at all — every "
                 "cross-module call into vocalis/ is now untainted and invisible")
    for alias, key in pkg.items():
        assert key in idx.trees, f"{alias} -> {key}, which is not a module the census parses"

    # And planted, so the rule survives the real tree moving on. Three import spellings.
    planted = tmp_path / "planted.py"
    planted.write_text(
        "from vocalis.runtime import configs\n"
        "import vocalis.runtime.pool as rt_pool\n"
        "import bulk\n",
        encoding="utf-8")
    key = "vocalis/web/planted.py"
    idx.trees[key] = ast.parse(planted.read_text(encoding="utf-8-sig"))
    try:
        probe = _Index.__new__(_Index)
        probe.trees = idx.trees
        got = {}
        for node in ast.walk(idx.trees[key]):
            if isinstance(node, ast.ImportFrom) and node.module:
                for a in node.names:
                    sub = idx._resolve_module(f"{node.module}.{a.name}")
                    if sub:
                        got[a.asname or a.name] = sub
            elif isinstance(node, ast.Import):
                for a in node.names:
                    tgt = idx._resolve_module(a.name)
                    if tgt:
                        got[a.asname or a.name.split(".")[0]] = tgt
    finally:
        del idx.trees[key]
    assert got == {"configs": "vocalis/runtime/configs.py",
                   "rt_pool": "vocalis/runtime/pool.py",
                   "bulk": "bulk.py"}, (
        f"module aliases resolved to {got}. All three spellings must work: `from pkg import "
        f"mod`, `import pkg.mod as alias`, and a bare flat `import mod`")


def test_the_two_censuses_agree_on_the_roots():
    """This file and test_m6_router.py both name the store roots as `src/` spells them. If one
    is taught about a new root and the other is not, the one left behind goes quiet rather than
    failing — which is the exact way the previous anti-rot test managed to look at
    twenty-one bugs and report none."""
    import test_m6_router
    assert _VAULT_ROOT_NAMES == test_m6_router._PATH_ROOT_NAMES, (
        "the two censuses disagree about the store root NAMES — reconcile them")
    assert _VAULT_ROOT_CALLS == test_m6_router._PATH_ROOT_CALLS, (
        "the two censuses disagree about the store root CALLS — reconcile them")
    assert _EXEMPT_PREFIX >= {p for _root, p in test_m6_router._EXEMPT}, (
        "test_m6_router exempts a literal under a store root that this file still taints")


# ── the acceptance gate, kept as a test ──────────────────────────────────────────────────

# The six sites `a97fea9` found BY HAND, by uploading one .docx and rendering it, after the
# previous sweep had been declared complete. They are the specification this file was written
# against (TESTING_PLAN_5_0 §2): a census that cannot rediscover them independently is
# not finished, whatever else it reports.
#
# 🔴 AND IT IS THE ONLY TEST HERE THAT CANNOT BE SATISFIED BY WEAKENING SOMETHING. Every other
# assertion is about the CURRENT tree, so a future edit that narrows the walk makes them pass
# more easily. This one is pinned to a commit: narrow the analysis and it goes red, naming the
# bug you stopped being able to see.
_A97FEA9_SITES = {
    ("vocalis_server.py", "_enhance_chapter", "wav.unlink(missing_ok=True)"),
    ("vocalis_server.py", "books_inspect", "f.stat()"),
    ("vocalis_server.py", "book_parse", "path.exists()"),
    ("vocalis_server.py", "book_start", "path.exists()"),
    ("vocalis_server.py", "output_concat", "full.stat()"),
    ("vocalis_server.py", "book_regenerate", "Path(docx).exists()"),
    ("vocalis_server.py", "_enhance_book", "ffprobe_duration(p)"),
}


def test_it_rediscovers_every_site_a97fea9_found_by_hand(tmp_path):
    """THE ACCEPTANCE CRITERION, run against the tree as it stood at `6b22713`.

    Two of these are reached through a `Path()` built from user-supplied JSON, one is a
    parameter annotated `Path`, one is a `.stat()` sitting directly behind a guard that HAD
    just been routed, and one is a vault path handed to ffprobe through a function that reads
    as a pure `float | None`. Round 2's grep — `.exists()` / `.glob()` / `.iterdir()` /
    `shutil` / `os` — could not have found a single one of them.
    """
    import subprocess
    src = tmp_path / "src"
    src.mkdir()
    try:
        names = subprocess.run(["git", "ls-tree", "--name-only", "6b22713:src"],
                               cwd=REPO_ROOT, capture_output=True, text=True, timeout=60)
        if names.returncode != 0:
            pytest.skip("6b22713 not in this clone — shallow checkout or a fresh worktree")
        for name in names.stdout.split():
            if not name.endswith(".py"):
                continue
            blob = subprocess.run(["git", "show", f"6b22713:src/{name}"],
                                  cwd=REPO_ROOT, capture_output=True, timeout=60)
            (src / name).write_bytes(blob.stdout)
    except (OSError, subprocess.SubprocessError):       # noqa: PERF203
        pytest.skip("git unavailable")

    past = _Index(root=tmp_path)                        # same analysis, a different tree
    found = {(f[0], f[1], f[3]) for f in past.findings()}
    missed = sorted(_A97FEA9_SITES - found)
    assert not missed, (
        "the census can no longer see sites that a97fea9 fixed by hand — whatever narrowed "
        "the analysis has re-opened this bug class:\n  "
        + "\n  ".join(f"{m}::{fn} — {call}" for m, fn, call in missed))
