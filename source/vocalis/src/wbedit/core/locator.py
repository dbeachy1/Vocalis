"""Locators — one addressing mechanism for all three formats (§4.1).

A locator is a tuple walked into a loaded document:

    ("data", "character_book", "entries", 0, "content")   a book inside a V2 card
    ("entries", "3", "content")                           a compiled ST lorebook
    (0, "content")                                        a bare list of entries

🔴 **ADDING A FORMAT MEANS ADDING A COLLECTOR, NEVER TOUCHING THE WRITE PATH.** That is the whole
reason this is a tuple walk rather than three writers: everything not explicitly addressed
round-trips untouched — `spec`, `spec_version`, `uid`, `key`, `order`, `constant`, `disable`, and
dict key order — because nothing else is ever assigned to. The format round-trip test in §10 is
really a test of this one function.

Note the string `"3"` in the second example. A compiled ST lorebook's `entries` is a **dict** with
numeric-looking string keys, and a section chunk file's is a **list**. `set_at` does not care —
`node[k]` means the same walk to both — which is exactly why the walk is untyped.
"""
from __future__ import annotations

from typing import Any


def get_at(doc: Any, locator: tuple) -> Any:
    node = doc
    for k in locator:
        node = node[k]
    return node


def set_at(doc: Any, locator: tuple, value: str) -> None:
    """Write `value` at `locator`. Mutates `doc` in place.

    ⚠️ In-place is correct HERE and nowhere above it: the caller materializes a Revision by
    deep-copying the document it started from and writing into the copy (I8 — the imported
    Document is immutable). This function is the primitive; the copy is the policy, and the
    policy does not belong in the primitive.
    """
    node = doc
    for k in locator[:-1]:
        node = node[k]
    node[locator[-1]] = value
