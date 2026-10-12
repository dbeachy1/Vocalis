#!/usr/bin/env python3
"""
build_worldbook.py — SillyTavern world book builder.

Reads lightweight section chunks from sections/*.json, expands each entry to the
full SillyTavern field set, assigns uid/displayIndex sequentially, validates, and
writes the lorebook.

World-agnostic. Per-world settings live in build-config.json beside sections/.
See SillyTavern-Worldbook-Build-Methodology.md for the chunk schema and budget
rationale.

Usage:
    python3 build_worldbook.py [--dir .] [--out NAME.json] [--strict] [--quiet]
"""

import argparse
import glob
import json
import os
import sys
from collections import Counter, defaultdict

# ---------------------------------------------------------------------------
# Fallback configuration. Overridden per world by build-config.json.
# ---------------------------------------------------------------------------

FALLBACK_CONFIG = {
    "world_name": "",
    "out": "lorebook-full.json",
    # Approximate chars-per-token for budget estimates. English prose runs ~4.
    "chars_per_token": 4.0,
    # Total constant footprint ceiling, in tokens.
    "constant_token_budget": 1300,
    # Total World Info budget, in tokens. Used for the concurrency estimate.
    # SillyTavern default is 25% of context.
    "wi_budget_tokens": 12096,
    # Character-count ceilings by entry class.
    "limits": {
        "constant": 1000,
        "standard": 900,
        "character": 1800,
        "mechanics": 1700,
    },
    # Keys that will match on nearly every message. Warn if used as a trigger.
    "noisy_keys": [],
    # Warn when a constant entry does not set ignoreBudget. Sticky entries sort
    # ahead of order at budget time and can displace an unprotected constant.
    "warn_unprotected_constants": True,
}

# ---------------------------------------------------------------------------
# Full SillyTavern entry field set with defaults. Chunk files may override any
# of these; anything not mentioned in a chunk falls back to the value here.
# ---------------------------------------------------------------------------

DEFAULTS = {
    "key": [],
    "keysecondary": [],
    "comment": "",
    "content": "",
    "constant": False,
    "vectorized": False,
    "selective": True,
    "selectiveLogic": 0,
    "addMemo": True,
    "order": 20,
    "position": 0,
    "disable": False,
    "ignoreBudget": False,
    "excludeRecursion": False,
    "preventRecursion": False,
    "delayUntilRecursion": False,
    "probability": 100,
    "useProbability": True,
    "depth": 4,
    "group": "",
    "groupOverride": False,
    "groupWeight": 100,
    "scanDepth": None,
    "caseSensitive": None,
    "matchWholeWords": None,
    "useGroupScoring": None,
    "automationId": "",
    "role": None,
    "sticky": 0,
    "cooldown": 0,
    "delay": 0,
    "matchPersonaDescription": False,
    "matchCharacterDescription": False,
    "matchCharacterPersonality": False,
    "matchCharacterDepthPrompt": False,
    "matchScenario": False,
    "matchCreatorNotes": False,
    "triggers": [],
    "outletName": "",
}

# Chunk-only fields: consumed by the build, never emitted into the lorebook.
BUILD_ONLY = {"id", "class", "keys", "notes"}

# Recognised chunk keys = emittable fields + build-only + the uid pair the
# script assigns itself.
KNOWN_CHUNK_KEYS = set(DEFAULTS) | BUILD_ONLY | {"uid", "displayIndex"}

VALID_CLASSES = {"constant", "standard", "character", "mechanics"}


# ---------------------------------------------------------------------------


def load_config(chunk_dir, cli_out=None):
    """Merge build-config.json over the fallback config."""
    cfg = json.loads(json.dumps(FALLBACK_CONFIG))  # deep copy
    path = os.path.join(chunk_dir, "build-config.json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            try:
                user = json.load(fh)
            except json.JSONDecodeError as exc:
                sys.exit(f"FATAL: build-config.json is not valid JSON — {exc}")
        unknown = set(user) - set(FALLBACK_CONFIG)
        if unknown:
            print(f"  ! build-config.json: unknown keys ignored: "
                  f"{', '.join(sorted(unknown))}")
        for k, v in user.items():
            if k == "limits" and isinstance(v, dict):
                cfg["limits"].update(v)
            elif k in cfg:
                cfg[k] = v
    cfg["noisy_keys"] = {k.lower().strip() for k in cfg["noisy_keys"]}
    if cli_out:
        cfg["out"] = cli_out
    return cfg


def load_sections(chunk_dir):
    """Load all section chunks in filename order."""
    paths = sorted(glob.glob(os.path.join(chunk_dir, "sections", "*.json")))
    if not paths:
        sys.exit(f"No section chunks found in {chunk_dir}/sections/")
    sections = []
    for p in paths:
        with open(p, encoding="utf-8") as fh:
            try:
                sections.append((os.path.basename(p), json.load(fh)))
            except json.JSONDecodeError as exc:
                sys.exit(f"FATAL: {os.path.basename(p)} is not valid JSON — {exc}")
    return sections


def expand(raw, uid, fname, warnings):
    """Expand one lightweight chunk entry into a full SillyTavern entry.

    Starts from DEFAULTS and overlays everything the chunk sets, so any
    SillyTavern field is reachable from a chunk file. Unrecognised keys are
    warned about rather than silently dropped.
    """
    unknown = set(raw) - KNOWN_CHUNK_KEYS
    if unknown:
        label = raw.get("id") or raw.get("comment") or f"uid {uid}"
        warnings.append(
            f"{label} [{fname}]: unrecognised field(s) "
            f"{', '.join(sorted(unknown))} — typo? Passed through unchanged."
        )

    entry = dict(DEFAULTS)
    for k, v in raw.items():
        if k in BUILD_ONLY:
            continue
        entry[k] = v

    # `keys` is the chunk-schema alias for SillyTavern's `key`.
    if "keys" in raw:
        entry["key"] = raw["keys"]

    entry["uid"] = uid
    entry["displayIndex"] = uid
    return entry


def classify(raw, entry, section):
    """Return the entry's class name. Explicit `class` wins."""
    declared = raw.get("class")
    if declared is not None:
        # Returned verbatim even when invalid, so validate() can flag it rather
        # than silently falling back to the heuristic.
        return declared
    if entry["constant"]:
        return "constant"
    if entry["sticky"] > 0:
        return "character"
    return "standard"


def validate(entries, meta, cfg, strict):
    """Return (errors, warnings, worst_key, worst_tokens)."""
    errors, warnings = [], []
    cpt = cfg["chars_per_token"]

    for e, m in zip(entries, meta):
        label = m["label"]

        if not e["content"].strip():
            errors.append(f"{label}: empty content")
        if not e["constant"] and not e["key"]:
            errors.append(
                f"{label}: non-constant entry with no keys — it can never fire"
            )
        if e["constant"] and e["key"]:
            warnings.append(
                f"{label}: constant entry also has keys (keys are ignored)"
            )
        if e["constant"] and not e["ignoreBudget"] and cfg["warn_unprotected_constants"]:
            warnings.append(
                f"{label}: constant without ignoreBudget — a firing sticky entry "
                "can displace it, since sticky sorts ahead of order at budget time"
            )
        if m["class"] not in VALID_CLASSES:
            warnings.append(
                f"{label}: unknown class '{m['class']}' — "
                f"expected one of {', '.join(sorted(VALID_CLASSES))}"
            )
        if e["group"] and e["groupWeight"] == DEFAULTS["groupWeight"]:
            warnings.append(
                f"{label}: in group '{e['group']}' but groupWeight left at default "
                "— all members equally likely"
            )

    # Identity: `id` if present, else `comment`. Empty is legal (sealed entries).
    ids = [m["ident"] for m in meta if m["ident"]]
    for name, n in Counter(ids).items():
        if n > 1:
            errors.append(f"duplicate entry id '{name}' appears {n} times")

    anon = [m["label"] for m in meta if not m["ident"]]
    if anon:
        errors.append(
            f"{len(anon)} entry/entries have neither `id` nor `comment` and cannot "
            f"be identified: {', '.join(anon[:4])}"
            + ("..." if len(anon) > 4 else "")
        )

    if len({e["uid"] for e in entries}) != len(entries):
        errors.append("uid collision — build logic fault")

    # Key collisions.
    key_map = defaultdict(list)
    for e, m in zip(entries, meta):
        for k in e["key"]:
            key_map[str(k).lower().strip()].append(m["label"])
    for k, owners in sorted(key_map.items()):
        if len(owners) >= 4:
            warnings.append(
                f"key '{k}' fires {len(owners)} entries at once: "
                + ", ".join(owners[:4])
                + ("..." if len(owners) > 4 else "")
            )
        if k in cfg["noisy_keys"]:
            warnings.append(
                f"key '{k}' is high-frequency — it will fire on nearly every "
                f"message ({', '.join(owners)}). Consider a distinctive phrase "
                "or make the entry constant."
            )

    # Length ceilings. Section entry_limit overrides the class ceiling.
    for e, m in zip(entries, meta):
        n = len(e["content"])
        if n > m["limit"]:
            warnings.append(
                f"{m['label']}: {n} chars exceeds {m['limit_source']} ceiling "
                f"of {m['limit']}"
            )

    # Constant footprint.
    const_chars = sum(len(e["content"]) for e in entries if e["constant"])
    const_tokens = const_chars / cpt
    if const_tokens > cfg["constant_token_budget"]:
        msg = (
            f"constant footprint ~{const_tokens:.0f} tokens exceeds budget of "
            f"{cfg['constant_token_budget']}"
        )
        (errors if strict else warnings).append(msg)

    # Worst-case concurrency: constants plus everything one key can drag in.
    # Entries sharing an inclusion group only fire one at a time, so take the
    # largest member rather than the sum.
    worst_key, worst_tokens = None, 0.0
    for k in key_map:
        firing = [e for e in entries
                  if k in [str(x).lower().strip() for x in e["key"]]]
        grouped, ungrouped = defaultdict(list), []
        for e in firing:
            (grouped[e["group"]] if e["group"] else ungrouped).append(e)
        chars = sum(len(e["content"]) for e in ungrouped)
        for members in grouped.values():
            chars += max(len(e["content"]) for e in members)
        total = (const_chars + chars) / cpt
        if total > worst_tokens:
            worst_key, worst_tokens = k, total

    if worst_key and worst_tokens > cfg["wi_budget_tokens"]:
        errors.append(
            f"worst-case concurrency ~{worst_tokens:.0f} tokens on key "
            f"'{worst_key}' exceeds WI budget of {cfg['wi_budget_tokens']}"
        )
    elif worst_key and worst_tokens > cfg["wi_budget_tokens"] * 0.6:
        warnings.append(
            f"worst-case concurrency ~{worst_tokens:.0f} tokens on key "
            f"'{worst_key}' is over 60% of the {cfg['wi_budget_tokens']} "
            "token WI budget"
        )

    return errors, warnings, worst_key, worst_tokens


def report(entries, sections, cfg, errors, warnings, worst_key, worst_tokens):
    cpt = cfg["chars_per_token"]
    title = (f"{cfg['world_name'].upper()} WORLD BOOK — BUILD REPORT"
             if cfg["world_name"] else "WORLD BOOK — BUILD REPORT")
    print("=" * 66)
    print(title)
    print("=" * 66)

    for fname, sec in sections:
        n = len(sec["entries"])
        chars = sum(len(e.get("content", "")) for e in sec["entries"])
        print(f"  {sec.get('section', '?')}  {sec.get('section_name', ''):<28} "
              f"{n:>3} entries  {chars:>6} chars   [{fname}]")

    const = [e for e in entries if e["constant"]]
    keyed = [e for e in entries if not e["constant"]]
    const_chars = sum(len(e["content"]) for e in const)
    total_chars = sum(len(e["content"]) for e in entries)

    print("-" * 66)
    print(f"  TOTAL          {len(entries):>3} entries  {total_chars:>6} chars "
          f"(~{total_chars / cpt:.0f} tokens)")
    print(f"  constant       {len(const):>3} entries  {const_chars:>6} chars "
          f"(~{const_chars / cpt:.0f} tokens, budget "
          f"{cfg['constant_token_budget']})")
    print(f"  keyed          {len(keyed):>3} entries")
    if worst_key:
        pct = 100 * worst_tokens / cfg["wi_budget_tokens"]
        print(f"  worst case     ~{worst_tokens:.0f} tokens on key '{worst_key}' "
              f"({pct:.0f}% of {cfg['wi_budget_tokens']})")

    if warnings:
        print("-" * 66)
        print(f"WARNINGS ({len(warnings)})")
        for w in warnings:
            print(f"  ! {w}")

    if errors:
        print("-" * 66)
        print(f"ERRORS ({len(errors)})")
        for e in errors:
            print(f"  X {e}")

    print("=" * 66)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=".", help="directory containing sections/")
    ap.add_argument("--out", default=None,
                    help="output filename (overrides build-config.json)")
    ap.add_argument("--strict", action="store_true",
                    help="treat the constant budget overrun as an error")
    ap.add_argument("--quiet", action="store_true",
                    help="suppress the report unless there are errors")
    args = ap.parse_args()

    cfg = load_config(args.dir, args.out)
    sections = load_sections(args.dir)

    entries, meta, warnings = [], [], []
    uid = 0
    for fname, sec in sections:
        sec_limit = sec.get("entry_limit")
        for raw in sec["entries"]:
            entry = expand(raw, uid, fname, warnings)
            cls = classify(raw, entry, sec)
            if sec_limit:
                limit, limit_source = sec_limit, "section entry_limit"
            else:
                limit = cfg["limits"].get(cls, cfg["limits"]["standard"])
                limit_source = cls
            ident = raw.get("id") or entry["comment"]
            meta.append({
                "ident": ident,
                "label": ident or f"uid {uid} [{fname}]",
                "class": cls,
                "limit": limit,
                "limit_source": limit_source,
                "file": fname,
            })
            entries.append(entry)
            uid += 1

    errors, more_warnings, worst_key, worst_tokens = validate(
        entries, meta, cfg, args.strict
    )
    warnings.extend(more_warnings)

    if errors or not args.quiet:
        report(entries, sections, cfg, errors, warnings, worst_key, worst_tokens)

    if errors:
        sys.exit("\nBuild aborted. Fix errors above.")

    book = {"entries": {str(e["uid"]): e for e in entries}}
    out_path = os.path.join(args.dir, cfg["out"])
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(book, fh, indent=2, ensure_ascii=False)
    print(f"\nWrote {out_path} — {len(entries)} entries.")


if __name__ == "__main__":
    main()