#!/usr/bin/env python3
"""
wb_batch_edit.py — drive a local LLM over a worldbook or character card, one field at a time.

Input type is detected: a V1/V2 character card, a section chunk file, or a compiled ST
lorebook. Sends ONE field per request to an OpenAI-compatible endpoint along with a global
instruction, validates the reply, and writes a new file or tree plus a review report. The
model never sees JSON and never sees more than one field.

    python3 wb_batch_edit.py \
        --in  MyWorld/worldbook/sections \
        --out /tmp/wb-out \
        --instruction instructions/rename-a-character.md \
        --card _shared/worldbook-editing/Section-Editor.json \
        --api http://127.0.0.1:5001

Add --dry-run to print the exact prompt for the first entry and stop.
Add --mock to run the whole pipeline with a stub model (no server needed).
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Any, Iterator

BEGIN = "<<<BEGIN"
END = "END>>>"
NOCHANGE = "<<<NOCHANGE>>>"

# Sent alongside the standard OpenAI keys. KoboldCpp defaults rep_pen to 1.1, which
# silently eats words out of verbatim passthrough — it must be forced to 1.0.
# Use --no-extras against a strict server that rejects unknown fields.
DEFAULT_EXTRAS: dict[str, Any] = {
    "min_p": 0.05,
    "rep_pen": 1.0,
    "rep_pen_range": 0,
    "dry_multiplier": 0.0,
    "xtc_probability": 0.0,
}


# --------------------------------------------------------------------------- model


@dataclass
class Job:
    path: Path            # source file
    rel: str              # path relative to --in
    locator: tuple        # walk into the loaded doc to reach this string
    label: str            # human label for the report
    original: str
    meta: dict[str, Any]  # context handed to the model, never edited


@dataclass
class Result:
    job: Job
    status: str                       # CHANGED NOCHANGE SKIPPED FAILED
    revised: str | None = None
    reason: str = ""
    notes: str = ""                   # model's post-sentinel change list
    elapsed: float = 0.0
    flags: list[str] = dc_field(default_factory=list)


# ----------------------------------------------------------------------- card load


def load_card(path: Path) -> tuple[str, list[dict[str, str]]]:
    """Return (system_prompt, few_shot_messages) from a V2 character card."""
    data = json.loads(path.read_text(encoding="utf-8"))
    d = data.get("data", data)
    system = "\n\n".join(x for x in (d.get("system_prompt", ""), d.get("description", "")) if x)
    shots: list[dict[str, str]] = []
    raw = d.get("mes_example", "") or ""
    for block in raw.split("<START>"):
        block = block.strip()
        if not block:
            continue
        m = re.search(r"\{\{char\}\}:", block)
        if not m:
            continue
        user = block[: m.start()].strip()
        assistant = block[m.end():].strip()
        user = re.sub(r"^\{\{user\}\}:\s*", "", user).strip()
        if user and assistant:
            shots.append({"user": user, "assistant": assistant})
    return system, shots


# ----------------------------------------------------------------------- book load


# 🔴 `sha()` and `is_sealed()` USED TO LIVE HERE, and their removal is the point.
#
# X-prefixed entries and files were skipped by default and, under --include-sealed, reported
# blind: a content hash for a label, character deltas for text. Doug reversed that on
# 2026-08-03 — "X is not immune. Just because I haven't seen it doesn't mean that the changes I
# want won't apply to it. It needs to be consistent."
#
# The convention is his; the policy built on it was a previous session's inference. An X entry
# is now collected, prompted, validated, applied and reported exactly like every other entry —
# there is no code path left that can treat one differently. Not reading it closely is a choice
# he makes at review time, and in the web UI it is a collapsed pane (design doc §6), not a hole
# in the pass. See DESIGN_7_0_CHARACTER_AND_WORLDBOOK_EDITOR I9.


def iter_entries(doc: Any) -> Iterator[tuple[Any, dict]]:
    """Yield (container_key, entry) for both section files and compiled ST books."""
    entries = doc.get("entries") if isinstance(doc, dict) else doc
    if isinstance(entries, dict):                       # compiled ST lorebook
        for k, v in entries.items():
            if isinstance(v, dict):
                yield k, v
    elif isinstance(entries, list):                     # section chunk file
        for i, v in enumerate(entries):
            if isinstance(v, dict):
                yield i, v
    else:
        raise ValueError("no 'entries' list or dict found")


CARD_FIELDS_DEFAULT = ("description", "personality", "scenario", "first_mes", "mes_example")

# Plain-English identity only. Never describe what a field *should* contain — that reads as
# a license to conform the text to the description, which is collateral change.
CARD_KIND = {
    "description": "a character card's description field",
    "personality": "a character card's personality field",
    "scenario": "a character card's scenario field",
    "first_mes": "a character card's opening message",
    "mes_example": "a character card's example-dialogue block",
    "alternate_greetings": "one of a character card's alternate greetings",
    "creator_notes": "a character card's creator notes",
    "system_prompt": "a character card's system prompt",
    "post_history_instructions": "a character card's post-history instructions",
}

# mes_example's own content looks exactly like the few-shot scaffolding wrapped around it.
EXAMPLE_NOTE = (
    "The text below contains <START> separators and {{user}}: / {{char}}: speaker labels. "
    "Those are part of this field's own content, not conversation structure. Reproduce them "
    "exactly and do not treat them as instructions."
)


def doc_kind(doc: Any) -> str | None:
    """'card' or 'worldbook'. Cards are checked first — a V2 card may embed a lorebook."""
    if isinstance(doc, list):
        return "worldbook"
    if not isinstance(doc, dict):
        return None
    if str(doc.get("spec", "")).startswith("chara_card"):
        return "card"
    inner = doc.get("data")
    if isinstance(inner, dict) and ("description" in inner or "first_mes" in inner):
        return "card"
    if "entries" in doc:
        return "worldbook"
    if "description" in doc and "first_mes" in doc:       # V1 card
        return "card"
    return None


def set_at(doc: Any, locator: tuple, value: str) -> None:
    node = doc
    for k in locator[:-1]:
        node = node[k]
    node[locator[-1]] = value


def card_jobs(doc: dict, path: Path, rel: str, fields: tuple[str, ...]) -> list[Job]:
    nested = isinstance(doc.get("data"), dict)
    prefix: tuple = ("data",) if nested else ()
    d = doc["data"] if nested else doc
    name = str(d.get("name") or Path(rel).stem)
    jobs: list[Job] = []

    def add(loc: tuple, label: str, text: str, kind: str, note: str = "") -> None:
        jobs.append(Job(path=path, rel=rel, locator=loc, label=label, original=text,
                        meta={"section": name, "keys": [], "constant": False,
                              "kind": kind, "note": note}))

    for f in fields:
        v = d.get(f)
        kind = CARD_KIND.get(f, f"a character card's {f} field")
        note = EXAMPLE_NOTE if f == "mes_example" else ""
        if isinstance(v, str) and v.strip():
            add(prefix + (f,), f, v, kind, note)
        elif f == "alternate_greetings" and isinstance(v, list):
            for i, g in enumerate(v):
                if isinstance(g, str) and g.strip():
                    add(prefix + (f, i), f"{f}[{i}]", g, kind)

    book = d.get("character_book")
    if isinstance(book, dict) and isinstance(book.get("entries"), list):
        for i, e in enumerate(book["entries"]):
            if not isinstance(e, dict):
                continue
            c = e.get("content")
            if isinstance(c, str) and c.strip():
                label = str(e.get("comment") or f"embedded book #{i}")
                add(prefix + ("character_book", "entries", i, "content"),
                    label, c, "a lorebook entry stored inside a character card")
    return jobs


def collect_jobs(root: Path, base: Path, field: str,
                 card_fields: tuple[str, ...]) -> list[Job]:
    files = sorted(root.rglob("*.json")) if root.is_dir() else [root]
    jobs: list[Job] = []
    for path in files:
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            print(f"  !! {path.name}: unreadable ({exc}) — skipped", file=sys.stderr)
            continue
        rel = str(path.relative_to(base)) if base.is_dir() else path.name
        kind = doc_kind(doc)

        if kind == "card":
            found = card_jobs(doc, path, rel, card_fields)
            print(f"  -- {rel}: character card, {len(found)} editable fields")
            jobs.extend(found)
            continue
        if kind != "worldbook":
            print(f"  !! {rel}: not a worldbook or character card — skipped", file=sys.stderr)
            continue

        try:
            found = list(iter_entries(doc))
        except ValueError:
            continue
        listed = isinstance(doc, list)
        section = (doc.get("section_name") or doc.get("section") or Path(rel).stem) if not listed else Path(rel).stem
        for ckey, entry in found:
            original = entry.get(field)
            if not isinstance(original, str) or not original.strip():
                continue
            label = str(entry.get("comment") or entry.get("uid") or f"{Path(rel).stem}#{ckey}")
            keys = entry.get("keys") or entry.get("key") or []
            loc: tuple = (ckey, field) if listed else ("entries", ckey, field)
            jobs.append(Job(
                path=path, rel=rel, locator=loc, label=label,
                original=original,
                meta={
                    "section": str(section),
                    "keys": [str(k) for k in keys] if isinstance(keys, list) else [],
                    "constant": bool(entry.get("constant", False)),
                    "kind": "a lorebook entry",
                    "note": "",
                },
            ))
    return jobs


# -------------------------------------------------------------------- prompt build


def build_user_message(job: Job, instruction: str) -> str:
    ctx = [f"Source: {job.meta['section']}",
           f"You are editing {job.meta.get('kind', 'a text field')}."]
    if job.meta.get("note"):
        ctx.append(job.meta["note"])
    # Every job gets its label and keys — an X entry included. Withholding them was the old
    # sealed path; it gave the model less to work with on exactly the entries whose consistency
    # matters most, which is backwards.
    ctx.append(f"Field: {job.label}")
    if job.meta["keys"]:
        ctx.append("Keys: " + ", ".join(job.meta["keys"]))
    if job.meta["constant"]:
        ctx.append("This entry is always in context.")
    context_block = "\n".join(ctx)
    return (
        "INSTRUCTION\n"
        f"{instruction.strip()}\n\n"
        "If the instruction does not apply to this field at all, emit exactly "
        f"{NOCHANGE} and nothing else. Do not echo an unchanged field.\n\n"
        "CONTEXT (reference only, never edit or repeat this block)\n"
        f"{context_block}\n\n"
        "FIELD\n"
        f"{job.original}"
    )


def build_messages(system: str, shots: list[dict[str, str]], user: str) -> list[dict[str, str]]:
    msgs = [{"role": "system", "content": system}]
    for s in shots:
        msgs.append({"role": "user", "content": s["user"]})
        msgs.append({"role": "assistant", "content": s["assistant"]})
    msgs.append({"role": "user", "content": user})
    return msgs


# ------------------------------------------------------------------------ transport


def call_model(api: str, payload: dict, api_key: str | None, timeout: int) -> str:
    url = api.rstrip("/") + "/v1/chat/completions"
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    try:
        return body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"unexpected response shape: {exc}") from exc


def mock_model(user_msg: str) -> str:
    """Stub for --mock: applies a trivial rename so the pipeline can be exercised."""
    field = user_msg.split("FIELD\n", 1)[1]
    if "Test Character 1" not in field:
        return NOCHANGE
    return f"{BEGIN}\n{field.replace('Test Character 1', 'Renamed Character 1')}\n{END}\nName substituted."


# ------------------------------------------------------------------------ validate


def extract(raw: str) -> tuple[str | None, str, str]:
    """Return (field_or_None, notes, reason). None field means no usable output."""
    text = raw.strip()
    if text.startswith(NOCHANGE) or text == NOCHANGE:
        return None, "", "nochange"
    if "Outside scope." in text or text.startswith("JSON -"):
        return None, "", "model refused"
    i = text.find(BEGIN)
    j = text.find(END, i + 1) if i != -1 else -1
    if i == -1 or j == -1:
        return None, "", "sentinels missing"
    body = text[i + len(BEGIN):j]
    if body.startswith("\n"):
        body = body[1:]
    if body.endswith("\n"):
        body = body[:-1]
    notes = text[j + len(END):].strip()
    if text.find(BEGIN, i + 1) != -1:
        return body, notes, "multiple blocks"
    return body, notes, ""


TOKEN_RE = re.compile(r"\{\{[^}]+\}\}|<START>")
LEAK_LINES = ("FIELD", "INSTRUCTION", BEGIN, END, NOCHANGE)


def paragraphs(text: str) -> int:
    return len([b for b in re.split(r"\n\s*\n", text.strip()) if b.strip()])


def validate(original: str, revised: str, lo: float, hi: float) -> list[str]:
    flags: list[str] = []
    if not revised.strip():
        flags.append("empty output")
        return flags
    ratio = len(revised) / max(len(original), 1)
    if ratio < lo or ratio > hi:
        flags.append(f"length ratio {ratio:.2f} outside [{lo}, {hi}]")
    pb, pa = paragraphs(original), paragraphs(revised)
    if pb != pa:
        flags.append(f"paragraph count {pb} -> {pa}")
    if original.rstrip()[-1:] in ".!?]\"'" and revised.rstrip()[-1:] not in ".!?]\"'":
        flags.append("output does not end on terminal punctuation — likely truncated")
    before, after = sorted(TOKEN_RE.findall(original)), sorted(TOKEN_RE.findall(revised))
    if before != after:
        flags.append("macro/template tokens changed")
    if original.count("[") != revised.count("[") or original.count("]") != revised.count("]"):
        flags.append("bracket-note count changed")
    for line in revised.splitlines():
        s = line.strip()
        if s in LEAK_LINES or s.startswith("CONTEXT (reference only"):
            flags.append(f"protocol text leaked into field: {s!r}")
            break
    return flags


# --------------------------------------------------------------------------- report


def diff(a: str, b: str, label: str) -> str:
    return "\n".join(difflib.unified_diff(
        a.splitlines(), b.splitlines(),
        fromfile=f"{label} (before)", tofile=f"{label} (after)", n=1, lineterm="",
    ))


def fence(*texts: str) -> str:
    """A tilde fence guaranteed longer than any fence inside the content."""
    n = 4
    for t in texts:
        for m in re.findall(r"^\s*(~{3,})", t, re.M):
            n = max(n, len(m) + 1)
    return "~" * n


class Reporter:
    """Appends one block per entry as the run proceeds, so the file can be tailed live."""

    def __init__(self, path: Path, instruction: str, source: str, total: int):
        self.path = path
        self.tally: dict[str, int] = {}
        self.applied = 0
        path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = path.open("w", encoding="utf-8")
        f = fence(instruction)
        self.fh.write(
            "# Worldbook batch edit — report\n\n"
            f"Started {time.strftime('%Y-%m-%d %H:%M:%S')}  \n"
            f"Source: `{source}`  \n"
            f"Fields to consider: {total}\n\n"
            "Written as the run proceeds — safe to tail. Summary is at the bottom.\n\n"
            f"## Instruction\n\n{f}\n{instruction.strip()}\n{f}\n\n---\n\n## Entries\n\n"
        )
        self.fh.flush()

    def add(self, r: Result, applied: bool) -> None:
        j = r.job
        self.tally[r.status] = self.tally.get(r.status, 0) + 1
        if applied:
            self.applied += 1
        mark = "APPLIED" if applied else ("held back" if r.status == "CHANGED" else "—")
        self.fh.write(f"### {j.rel} :: {j.label}\n\n")
        self.fh.write(f"- status: **{r.status}** ({mark})\n")
        self.fh.write(f"- kind: {j.meta.get('kind', 'field')}\n")
        if r.reason:
            self.fh.write(f"- reason: {r.reason}\n")
        for fl in r.flags:
            self.fh.write(f"- **FLAG:** {fl}\n")
        if r.notes:
            self.fh.write(f"- model notes: {r.notes}\n")

        if r.status == "CHANGED" and r.revised is not None:
            fb = fence(j.original, r.revised)
            self.fh.write(f"\n**BEFORE**\n\n{fb}\n{j.original}\n{fb}\n")
            self.fh.write(f"\n**AFTER**\n\n{fb}\n{r.revised}\n{fb}\n")
            d = diff(j.original, r.revised, j.label).rstrip()
            if d:
                fd = fence(d)
                self.fh.write(f"\n<details><summary>changed lines only</summary>\n\n"
                              f"{fd}diff\n{d}\n{fd}\n\n</details>\n")
        self.fh.write("\n---\n\n")
        self.fh.flush()

    def finish(self, failed: int) -> None:
        self.fh.write("## Summary\n\n")
        for k, v in sorted(self.tally.items()):
            self.fh.write(f"- {k}: {v}\n")
        self.fh.write(f"- applied to output: {self.applied}\n")
        held = self.tally.get("CHANGED", 0) - self.applied
        if held:
            self.fh.write(f"- flagged and held back: {held}\n")
        self.fh.write(f"\nFinished {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        self.fh.close()


# ----------------------------------------------------------------------------- main


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--in", dest="src", required=True, help="section file, or directory of them")
    p.add_argument("--out", required=True, help="output .json file (single-file input), or a directory (tree is mirrored)")
    p.add_argument("--instruction", required=True, help="file holding the global instruction")
    p.add_argument("--card", required=True, help="Section-Editor.json (supplies the contract)")
    p.add_argument("--api", default="http://127.0.0.1:5001")
    p.add_argument("--api-key", default=os.environ.get("WB_API_KEY"))
    p.add_argument("--model", default="local")
    p.add_argument("--field", default="content", help="lorebook entry field to edit (default: content)")
    p.add_argument("--card-fields", default=",".join(CARD_FIELDS_DEFAULT),
                   help="comma-separated card fields to edit; add alternate_greetings to include them")
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument("--max-tokens", type=int, default=4096)
    p.add_argument("--timeout", type=int, default=600)
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--min-ratio", type=float, default=0.6)
    p.add_argument("--max-ratio", type=float, default=1.75)
    p.add_argument("--limit", type=int, default=0, help="stop after N entries")
    p.add_argument("--accept-flagged", action="store_true", help="apply edits that tripped a validator")
    p.add_argument("--no-extras", action="store_true", help="omit non-OpenAI sampler fields")
    p.add_argument("--dry-run", action="store_true", help="print the first prompt and exit")
    p.add_argument("--mock", action="store_true", help="run without a server, using a stub model")
    args = p.parse_args()

    src = Path(args.src).expanduser().resolve()
    out_root = Path(args.out).expanduser().resolve()
    base = src if src.is_dir() else src.parent
    instruction = Path(args.instruction).expanduser().read_text(encoding="utf-8")
    system, shots = load_card(Path(args.card).expanduser())

    card_fields = tuple(f.strip() for f in args.card_fields.split(",") if f.strip())
    jobs = collect_jobs(src, base, args.field, card_fields)
    if args.limit:
        jobs = jobs[: args.limit]
    if not jobs:
        print("no editable entries found", file=sys.stderr)
        return 1

    if args.dry_run:
        msgs = build_messages(system, shots, build_user_message(jobs[0], instruction))
        print(f"# {len(jobs)} entries would be processed, {len(shots)} few-shot pairs\n")
        for m in msgs:
            print(f"----- {m['role']} -----\n{m['content']}\n")
        return 0

    single_out = (not src.is_dir()) and out_root.suffix.lower() == ".json"
    report = out_root.with_suffix(".report.md") if single_out else out_root / "batch-edit-report.md"
    reporter = Reporter(report, instruction, str(src), len(jobs))
    print(f"{len(jobs)} fields to consider, {len(shots)} few-shot pairs")
    print(f"report streaming to {report}\n")
    results: list[Result] = []
    accepted: set[int] = set()
    by_file: dict[Path, list[tuple[Job, str]]] = {}
    for n, job in enumerate(jobs, 1):
        print(f"  [{n}/{len(jobs)}] {job.rel} :: {job.label} ... ", end="", flush=True)
        user = build_user_message(job, instruction)
        payload = {
            "model": args.model,
            "messages": build_messages(system, shots, user),
            "temperature": args.temperature,
            "top_p": 1.0,
            "max_tokens": args.max_tokens,
            "presence_penalty": 0.0,
            "frequency_penalty": 0.0,
            "stream": False,
        }
        if not args.no_extras:
            payload.update(DEFAULT_EXTRAS)

        t0 = time.time()
        res: Result | None = None
        for attempt in range(args.retries + 1):
            try:
                raw = mock_model(user) if args.mock else call_model(args.api, payload, args.api_key, args.timeout)
            except (urllib.error.URLError, RuntimeError, TimeoutError) as exc:
                if attempt == args.retries:
                    res = Result(job, "FAILED", reason=f"transport: {exc}")
                    break
                time.sleep(1.5 * (attempt + 1))
                continue
            body, notes, reason = extract(raw)
            if reason == "nochange":
                res = Result(job, "NOCHANGE")
                break
            if body is None:
                if attempt == args.retries:
                    res = Result(job, "FAILED", reason=reason or "unparseable")
                    break
                payload["temperature"] = max(0.05, args.temperature / 2)
                continue
            if body == job.original:
                res = Result(job, "NOCHANGE", notes=notes)
                break
            flags = validate(job.original, body, args.min_ratio, args.max_ratio)
            if reason:
                flags.append(reason)
            res = Result(job, "CHANGED", revised=body, notes=notes, flags=flags)
            break

        assert res is not None
        res.elapsed = time.time() - t0
        applied = (res.status == "CHANGED" and res.revised is not None
                   and (not res.flags or args.accept_flagged))
        if applied and res.revised is not None:
            accepted.add(len(results))
            by_file.setdefault(job.path, []).append((job, res.revised))
        results.append(res)
        reporter.add(res, applied)
        detail = f" [{'; '.join(res.flags)}]" if res.flags else ""
        print(f"{res.status}{detail} ({res.elapsed:.1f}s)")

    for path in sorted({j.path for j in jobs}):
        doc = json.loads(path.read_text(encoding="utf-8"))
        for job, text in by_file.get(path, []):
            set_at(doc, job.locator, text)
        if single_out:
            dest = out_root
        else:
            rel = path.relative_to(base) if base.is_dir() else Path(path.name)
            dest = out_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    changed = sum(1 for r in results if r.status == "CHANGED")
    failed = sum(1 for r in results if r.status == "FAILED")
    reporter.finish(failed)
    flagged = changed - len(accepted)
    print(f"\n{len(accepted)} applied, {flagged} flagged and held back, {failed} failed")
    print(f"{'file' if single_out else 'tree'}:   {out_root}")
    print(f"report: {report}")
    return 2 if failed else 0


if __name__ == "__main__":
    sys.exit(main())