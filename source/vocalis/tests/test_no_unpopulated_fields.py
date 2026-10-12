"""Detect stored fields that application code never populates.

🔴 **TWO DEFECTS HAD EXACTLY THIS SHAPE, AND THE SECOND ONE AFFECTED THE RELEASE'S MAIN FEATURE.**

  · `Production.subject_id` — productions had an empty subject.
  · `Subject.images`        — a live end-to-end run found it. `GeneratedImage(` was constructed in
                             ZERO places in `src/`, so Generate wrote 50 files, Curate rendered an
                             empty grid over them, and Build refused after the GPU hours were paid.

Both are fields that `from_dict` reads and `to_dict` writes but application code never assigns.
**The round trip is what makes this invisible**: the field is in the JSON, in the API response,
and every unit test can set it by hand. It is simply never filled in by the program.

📌 **SCOPED TO THE 9.0 RUNTIME, WHICH IS WHERE IT IS CLEAN AT ZERO.** Run across all of `src/` this
check has two survivors that are populated dynamically in ways an AST cannot see
(`SongTemplate.from_dict(payload)` from a request body, `LeadParams` via `replace(**out)`) — and
shipping it with a two-entry allow-list would be the countable allowance that
`feedback_never_offer_suppression_as_an_option.md` warns reads as permission. A gate with no
exceptions over the code that produced the defect beats a gate with exceptions over everything."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
RUNTIME = SRC / "vocalis" / "runtime"

#: The 9.0 surface: the modules with a stored shape, which is where an unwritten field can hide.
MODULES = ("lorasubj.py", "loragen.py", "loraface.py", "loratrain.py", "loratest.py",
           "production.py", "shotrender.py")

SERIALIZERS = {"from_dict", "to_dict", "as_dict", "__init__", "__post_init__"}
MUTATORS = {"append", "extend", "add", "update", "insert"}


def dataclasses_in(tree):
    """{Class: [(field, self_populating)]} in declaration order — order matters for positional
    construction, where `Pinned(key, False, "why")` writes fields nothing ever names."""
    out = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        if not any("dataclass" in ast.unparse(d) for d in node.decorator_list):
            continue
        fields = [(b.target.id, "default_factory" in (ast.unparse(b.value) if b.value else ""))
                  for b in node.body
                  if isinstance(b, ast.AnnAssign) and isinstance(b.target, ast.Name)]
        if fields:
            out[node.name] = fields
    return out


def writers(tree, positional):
    """Names this module populates. ⚠️ THREE WAYS, and missing any one fills the report with noise:
    assignment (`o.f = x`), in-place mutation (`o.f.append(x)`), and construction — keyword
    (`T(f=x)`) or POSITIONAL (`T(a, b)`), the last binding by order without naming anything."""
    found = set()

    class V(ast.NodeVisitor):
        def visit_FunctionDef(self, node):
            if node.name in SERIALIZERS:
                return          # serialization moves a value that must already exist elsewhere
            self.generic_visit(node)

        def visit_Assign(self, node):
            for t in node.targets:
                if isinstance(t, ast.Attribute):
                    found.add(t.attr)
            self.generic_visit(node)

        def visit_AugAssign(self, node):
            if isinstance(node.target, ast.Attribute):
                found.add(node.target.attr)
            self.generic_visit(node)

        def visit_Call(self, node):
            for kw in node.keywords:
                if kw.arg:
                    found.add(kw.arg)
            f = node.func
            if isinstance(f, ast.Attribute) and f.attr in MUTATORS and isinstance(f.value, ast.Attribute):
                found.add(f.value.attr)
            if isinstance(f, ast.Name) and f.id[:1].isupper() and node.args:
                positional[f.id] = max(positional.get(f.id, 0), len(node.args))
            self.generic_visit(node)

    V().visit(tree)
    return found


@pytest.fixture(scope="module")
def census():
    """🔴 WRITERS ARE COLLECTED FROM ALL OF `src/`, NOT JUST THE MODULE UNDER TEST. A field is
    routinely set by the route that owns it, so a per-module scan would report every one of them."""
    positional: dict[str, int] = {}
    written: set[str] = set()
    for p in SRC.rglob("*.py"):
        written |= writers(ast.parse(p.read_text(encoding="utf-8")), positional)

    dead = []
    checked = 0
    for name in MODULES:
        p = RUNTIME / name
        if not p.exists():
            continue
        for cls, fields in dataclasses_in(ast.parse(p.read_text(encoding="utf-8"))).items():
            for i, (field, auto) in enumerate(fields):
                if auto or i < positional.get(cls, 0):
                    continue
                checked += 1
                if field not in written:
                    dead.append(f"{name}  {cls}.{field}")
    return dead, checked, written


def test_no_stored_field_is_left_unwritten(census):
    """🔴 THE DEFECT. `Subject.images` would have failed here, and it took the release with it."""
    dead, _, _ = census
    assert not dead, ("stored fields nothing in src/ ever populates - the shape that killed the "
                      "9.0 pipeline:\n  " + "\n  ".join(dead))


def test_the_census_is_looking_at_something(census):
    """⚠️ A CENSUS THAT INSPECTS NOTHING PASSES. If the modules move or the dataclass decorator
    changes shape, this would go green while checking zero fields."""
    _, checked, _ = census
    assert checked > 25, f"only {checked} fields examined - the parser has stopped seeing them"


def test_serialization_does_not_count_as_population(census):
    """🔴 THE WHOLE BASIS OF THE CHECK. `from_dict` assigns every field, so counting it as a writer
    makes this test vacuous for exactly the defect it exists to find — the round trip is what made
    `Subject.images` look alive for the whole of 9.0."""
    src = "\n".join([
        "from dataclasses import dataclass",
        "@dataclass",
        "class T:",
        "    ghost: str = ''",
        "    @classmethod",
        "    def from_dict(cls, d):",
        "        return cls(ghost=d['ghost'])",
    ])
    found = writers(ast.parse(src), {})
    assert "ghost" not in found, "a field assigned only inside from_dict counted as populated"


def test_a_positionally_constructed_field_counts_as_written():
    """📌 `Pinned(("model", "quantize_te"), False, "why")` writes `value` and `why` without naming
    either. Miss this and the report fills with fields that are demonstrably set."""
    positional: dict[str, int] = {}
    writers(ast.parse("x = Pinned(('a','b'), False, 'why')"), positional)
    assert positional.get("Pinned") == 3
