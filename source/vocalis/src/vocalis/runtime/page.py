"""Assemble the web UI from its HTML template and partials.

Jinja includes remain enabled, but variable substitution is disabled so literal `{{...}}`
macros and server placeholders survive unchanged. The route applies placeholders afterward in
its existing order. Preserve source newlines and the final newline so assembly remains byte-stable;
call `assemble()` when a consumer needs the expanded page.
"""
from __future__ import annotations

from functools import lru_cache

from jinja2 import Environment, FileSystemLoader, StrictUndefined

from vocalis.runtime import paths

#: The page. One entry point; the parts it pulls in live beside it under `partials/`.
INDEX_TEMPLATE = "index.html"

#: Sentinel used to disable Jinja variable substitution while preserving literal `{{...}}` text.
_NO_VARIABLES = "\x00<<no-variables>>\x00"


def _newline_sequence() -> str:
    """Return the line ending used by the current UI template checkout.

    Jinja normalizes template newlines, so matching the source preserves byte-for-byte assembly
    on both CRLF and LF checkouts.
    """
    head = (paths.WEBUI / INDEX_TEMPLATE).read_bytes()[:65536]
    return "\r\n" if b"\r\n" in head else "\n"


@lru_cache(maxsize=1)
def _env() -> Environment:
    """The one environment. Cached because building it walks the loader's search path."""
    return Environment(
        loader=FileSystemLoader(str(paths.WEBUI)),
        variable_start_string=_NO_VARIABLES,
        variable_end_string=_NO_VARIABLES,
        autoescape=False,
        keep_trailing_newline=True,
        newline_sequence=_newline_sequence(),
        undefined=StrictUndefined,
    )


def assemble(template: str = INDEX_TEMPLATE) -> str:
    """The page with its `{% include %}`s expanded and every `{{PLACEHOLDER}}` left alone.

    This is the page as the route sees it *before* substitution, and it is what a test that greps
    the markup wants. With nothing extracted yet it is byte-identical to `index.html` on disk —
    `test_page_assembly.py` pins that, so the mechanism landing and the markup moving stay two
    separately verifiable events.
    """
    return _env().get_template(template).render()


def reset_cache() -> None:
    """Drop the cached environment. For tests that write templates to a temp tree."""
    _env.cache_clear()
