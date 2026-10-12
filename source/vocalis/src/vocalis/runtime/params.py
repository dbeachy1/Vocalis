"""Request-field coercion: parse a value out of JSON or a form, or raise `ValueError`.

Moved out of `vocalis_server.py` in 5.1-P3. They were `_f` / `_b` / `_i` there, called from
about thirty route bodies across six domains, and `_f(data, "cfg", 0.5, 0.0, 1.0)` tells a
reader nothing about what it does. Named `as_float` / `as_bool` / `as_int` here; the server
re-exports them under the old names so the existing call sites are untouched, and new code
should use these.

Every one of them raises `ValueError` rather than returning a default on bad input. Route
bodies turn that into a 400. The alternative — letting a bare `float()` raise — produced a 500,
which says "the server is broken" when the truth is "you sent me a word where a number goes".
"""
import math

import enhance
import vault_fs

# 5.1-P4.10a: the two validators below need the enhancement toolchain's availability and the
# voice store's location. Neither module imports this one, so no cycle: `enhancement` reaches
# configs/pool/jobs, and `paths` reaches nothing in the package at all.
from vocalis.runtime import enhancement
from vocalis.runtime import paths


def as_float(data, key, default, lo=None, hi=None):
    """Parse a float request field, raising ValueError (→ 400) on garbage input
    instead of letting an unguarded float() bubble up as a 500. Rejects NaN/inf —
    float("nan") parses fine and sails through any < / > range check (all NaN
    comparisons are False), which would defeat the validation entirely."""
    v = data.get(key, default)
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{key!r} must be a number (got {v!r})")
    if not math.isfinite(f):
        raise ValueError(f"{key!r} must be a finite number (got {v!r})")
    if lo is not None and f < lo or hi is not None and f > hi:
        raise ValueError(f"{key!r} out of range [{lo}, {hi}]: {f}")
    return f


def as_bool(data, key, default=False) -> bool:
    """Parse a bool request field. JSON sends real booleans, but multipart form
    fields arrive as strings — where bool("false") would be True."""
    v = data.get(key, default)
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def as_int(data, key, default, lo=None, hi=None):
    """Parse an int request field, raising ValueError (→ 400) on garbage input."""
    v = data.get(key, default)
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise ValueError(f"{key!r} must be an integer (got {v!r})")
    if lo is not None and n < lo or hi is not None and n > hi:
        raise ValueError(f"{key!r} out of range [{lo}, {hi}]: {n}")
    return n


def favorite_body() -> bool:
    """`{"favorite": bool}` off the request body — the whole payload of a ★ toggle.

    5.1-P4.7, and it takes the `request` proxy rather than a dict, unlike the three above.
    That is why it is a separate function and not `as_bool(data, "favorite")`: FOUR routes
    share it (the song-shelf endpoint and the Voices tab), all of which are one-field
    POSTs where reading the body IS the parse. `silent=True` on purpose — a ★ click with no
    body at all means "off", not 400.
    """
    from flask import request
    return bool((request.get_json(silent=True) or {}).get("favorite"))

# ── Shared with more than one blueprint (5.1-P4.10a) ─────────────────────────
# Both turn a request field into either a usable value or the 400 that explains why
# not, which is what this module is. Books and playground each validated the same two
# fields the same way.

def enhance_opts(form):
    """(enhanced, nfe, error) from a request body. The error is a 400 payload, and it
    fires only when enhancement was ASKED for and cannot be delivered — before a render
    starts, never at the post-pass when the GPU time has already been spent."""
    from flask import jsonify                 # local, as in favorite_body above
    enhanced = as_bool(form, "enhance", enhancement.enhance_default())
    if enhanced and not enhancement.enhance_available():
        return None, None, (jsonify({"error": enhancement.enhance_unavailable_reason()}), 400)
    return enhanced, enhance.validate_nfe(form.get("nfe")), None


def voice_file_error(voice: str):
    """400 payload when a named voice has no file on disk (deleted/renamed), or
    None when it's fine. Without this, a doomed render burns every chunk's full
    retry budget across all workers before failing with a cryptic RuntimeError —
    the CLI has validated --voice up front since 1.x; the routes must too."""
    # vault_fs.exists: a bare .exists() is False for every voice once the store is encrypted,
    # so this guard — which exists to fail a doomed render EARLY — would instead 400 EVERY
    # render, book and playground alike, with "voice file not found: <a voice that is right
    # there>". Not in §4's inventory; it predates the 4.8 merge (§4.10's class).
    from flask import jsonify                 # local, as in favorite_body above
    if voice and not vault_fs.exists(paths.VOICE_SAMPLES / voice):
        return jsonify({"error": f"voice file not found: {voice}",
                        "hint": "it may have been deleted or renamed — pick another voice"}), 400
    return None
