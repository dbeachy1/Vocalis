"""Manage an ai-toolkit LoRA training run with a verified FLUX.2 configuration.

Training presets and rate estimates are based on a configuration that successfully produced a
model. The resolved configuration is shown before launch, and `resolve()` enforces pinned values
even if the browser submits different values. The pin list is derived from the training config's
own requirements, including optimizer constraints for HIP systems. Unsupported or unverified
options are omitted rather than sent as guessed defaults.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import uuid
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Any, Callable

import vault_fs
import yaml
from loguru import logger

from . import paths

#: The HF id and architecture that trained successfully. Not configurable: a different base model
#: is a different project, and every measurement below is about this one.
BASE_MODEL = "black-forest-labs/FLUX.2-dev"
ARCH = "flux2"


class TrainRefused(RuntimeError):
    """The run cannot start, and why. A refused start must never look like a started one."""


@dataclass(frozen=True)
class Preset:
    """A measured configuration; `s_per_it` and `vram_gib` describe the tested hardware setup."""
    key: str
    label: str
    resolution: int
    steps: int
    s_per_it: float
    vram_gib: float

    def seconds(self, steps: int | None = None) -> float:
        return (self.steps if steps is None else steps) * self.s_per_it


#: Steady-state rate, excluding the slower first-step warmup. Do not use tqdm's early average for
#: duration estimates.
PRESETS: dict[str, Preset] = {
    "fast": Preset("fast", "Fast", 512, 2000, 6.58, 24.2),
    "quality": Preset("quality", "Quality", 1024, 2000, 17.3, 27.42),
}
DEFAULT_PRESET = "quality"

#: Bounds on what the form may ask for. Steps is capped well above the measured 2,000 because a
#: longer run is a legitimate choice; it is capped at all because a typo of 200000 is a 40-day job.
MAX_STEPS = 20_000
MIN_STEPS = 100
MAX_RANK = 128
MIN_RANK = 4
MAX_LR = 1e-2
MIN_LR = 1e-6


#: The model name becomes a path component and is built from client text. `web/lora.py`
#: composes it as `f"{subject.name}-{preset}"`, and neither half is validated: `lorasubj.create`
#: keeps whatever `name` it is given (`(name or "").strip()[:MAX_NAME]`) and `preset` is the raw
#: body field. `_collect_models` then substitutes it into every part of the checkpoint's relative
#: path and `joinpath`s the result under the vault — so a `../` in either half walks straight out.
#: That is not merely a wrong directory: `vault_fs.write_bytes` falls back to a plain
#: `Path.write_bytes` for any path that does not route into the vault, so the escape writes a
#: ~195 MB LoRA of an identifiable person to the filesystem IN CLEARTEXT, which is the single
#: thing 5.0 exists to prevent. Verified by arithmetic, not argued:
#:   output/../../../../../../../../tmp/x  ->  /tmp/x
#: ⚠️ SANITIZED WHERE IT BECOMES A PATH, not where it is composed. The same string is also the
#: name ai-toolkit writes into its own config and logs, and those are free text; pinning the
#: check to the join is what makes it impossible to reintroduce by adding a second composer.
_UNSAFE_IN_NAME = re.compile(r"[^A-Za-z0-9._-]+")
#: Long enough for `<subject>-<preset>` at `lorasubj.MAX_NAME`; short enough to stay a legal
#: filename after the vault's own name expansion. Local rather than imported so this guard has no
#: dependency on the store it is protecting against.
MAX_NAME = 120
#: The same shape `lorasubj._SAFE_ID` enforces, for the same reason and at the same kind of join.
_SAFE_ID = re.compile(r"\A[0-9a-f]{8,32}\Z")


def safe_component(name: str, fallback: str = "model") -> str:
    """`name` reduced to one filename component that cannot leave the directory it is joined to.

    Collapses every separator, `..` and control character to `-`. Returns `fallback` when nothing
    usable survives, because an empty component silently makes `joinpath` a no-op and the
    checkpoint would land ON its own parent directory.
    """
    out = _UNSAFE_IN_NAME.sub("-", (name or "").strip()).strip(".-")
    while ".." in out:
        out = out.replace("..", ".")
    return out[:MAX_NAME] or fallback


@dataclass(frozen=True)
class Pinned:
    """One key the UI may not move, and the measured consequence of moving it."""
    path: tuple[str, ...]
    value: Any
    why: str


#: 🔴 THE FIVE. Each `why` is the observed failure, not a rationale — every one of them is silent.
PINNED: tuple[Pinned, ...] = (
    Pinned(("model", "quantize_te"), False,
           "puts Mistral-24B on the GPU, which is the exact thing the dual-card split exists "
           "to avoid"),
    Pinned(("train", "unload_text_encoder"), True,
           "never frees the ~26 GB the text encoder holds, so there is no room for the "
           "transformer"),
    Pinned(("datasets", "cache_text_embeddings"), True,
           "required by the dual-GPU patch; the stock UI does not offer it at all"),
    Pinned(("train", "optimizer"), "adamw",
           "adamw8bit's paged optimizer needs CUDA GPU<->CPU paging that HIP does not have: "
           "step 1 trains, then loss=0.0 and grad_norm=NaN for ever, with no error"),
    Pinned(("train", "noise_scheduler"), "flowmatch",
           "the scheduler FLUX.2 was trained with; another one trains something else"),
)

#: 📌 Pinned by NOT being written. `low_vram` is in neither working config — it is a stock-UI
#: default that the design carried forward as "unknown interaction with the placement hook". This
#: entry exists so that absence reads as a decision rather than an oversight.
OMITTED = ("low_vram",)


def _tolerated() -> tuple:
    """What the drain thread may swallow and carry on from.

    Vault lock and authorization exceptions derive from `BaseException`, so include them
    explicitly while allowing `KeyboardInterrupt` and `SystemExit` to propagate. Resolve the
    exception classes at call time because the vault module may not be importable during startup.
    """
    out = []
    for probe in (vault_fs.locked_exc, vault_fs.auth_exc):
        exc = probe()
        out.extend(exc if isinstance(exc, tuple) else (exc,))
    return (Exception, *out)


def resolved_preset(preset: Any) -> str:
    """Return the preset key using the same fallback as `resolve()`.

    Keep runtime metadata beside the ai-toolkit config rather than adding unsupported YAML keys.
    """
    return PRESETS.get(str(preset), PRESETS[DEFAULT_PRESET]).key


def _clamp(value: Any, low, high, fallback):
    try:
        v = type(fallback)(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, v))


def resolve(*, dataset_dir, output_dir, name: str, preset: str = DEFAULT_PRESET,
            steps: Any = None, rank: Any = 16, lr: Any = 1e-4,
            overrides: dict | None = None) -> dict:
    """The config ai-toolkit will be handed, resolved from the form and the pins.

    🔴 **THE PINS ARE APPLIED LAST AND UNCONDITIONALLY.** They are not defaults the caller may
    override; an `overrides` dict carrying `quantize_te: true` still gets `False`. The UI renders
    these locked, but a disabled control is a statement about a browser, and this is what makes it
    true of the file ai-toolkit reads.

    ⚠️ **`overrides` EXISTS SO THE PINS GUARD SOMETHING REAL.** Without it the only protection
    would be that `resolve`'s signature happens not to name those keys — which is not a guard, it
    is an accident that the next person to add `**kw` removes without noticing. The threat being
    modeled is a JSON body from a browser, so the function takes one.

    ⚠️ **AND AN UNKNOWN KEY IS DROPPED, NOT PASSED THROUGH.** ai-toolkit's config is executable
    surface; forwarding arbitrary client-supplied keys into it would let a request reach settings
    no screen offers. Only keys already present in the resolved config can be moved at all.
    """
    p = PRESETS.get(str(preset), PRESETS[DEFAULT_PRESET])
    n_steps = p.steps if steps is None else _clamp(steps, MIN_STEPS, MAX_STEPS, p.steps)
    n_rank = _clamp(rank, MIN_RANK, MAX_RANK, 16)
    n_lr = _clamp(lr, MIN_LR, MAX_LR, 1e-4)

    cfg = {
        "job": "extension",
        "config": {
            "name": name,
            "process": [{
                "type": "sd_trainer",
                "training_folder": str(output_dir),
                # Emits a timer block every step. It is what makes the log parseable at all —
                # without it the only progress signal is tqdm's carriage-returned bar.
                "performance_log_every": 1,
                # Stage 0. The dual-GPU mixin places stage 1 on cuda:1 itself; naming both here
                # is how you get one card doing all of it.
                "device": "cuda:0",
                "network": {"type": "lora", "linear": n_rank, "linear_alpha": n_rank},
                "save": {
                    "dtype": "float16",
                    # ⚠️ NOT "at the end". A 9.6-hour unattended run that crashes at hour six
                    # must still leave something usable; six kept covers the whole run.
                    "save_every": 250,
                    "max_step_saves_to_keep": 6,
                    "push_to_hub": False,
                },
                "datasets": [{
                    "folder_path": str(dataset_dir),
                    "caption_ext": "txt",
                    "caption_dropout_rate": 0.0,
                    "shuffle_tokens": False,
                    "cache_latents_to_disk": True,
                    "resolution": [p.resolution],
                }],
                "train": {
                    "batch_size": 1,
                    "steps": n_steps,
                    "gradient_accumulation_steps": 1,
                    "train_unet": True,
                    "train_text_encoder": False,
                    # Non-negotiable at 1024: without it the activation stack alone does not fit.
                    "gradient_checkpointing": True,
                    "lr": n_lr,
                    "ema_config": {"use_ema": False},
                    # Sampling loads the full inference path and is known to break with quantized
                    # models. A sample that crashes the run is worse than no sample.
                    "disable_sampling": True,
                    "skip_first_sample": True,
                    "dtype": "bf16",
                },
                "model": {
                    "name_or_path": BASE_MODEL,
                    "arch": ARCH,
                    "quantize": True,
                },
            }],
        },
    }

    proc = cfg["config"]["process"][0]

    # Applied BEFORE the pins, and only onto keys that already exist. `sections` is derived from
    # the config just built rather than written down, so a key added above is overridable without
    # a second list to keep in step — and a key that is not there cannot be introduced.
    sections = [proc["train"], proc["model"], proc["network"], proc["save"], proc["datasets"][0]]
    # 🔴 THE PATHS ARE NOT OVERRIDABLE. `folder_path` lives in `datasets[0]` and `TrainRun.start`
    # reads the staging source straight back out of the resolved config, so an override here made
    # `stage_for_ai_toolkit` enumerate and copy an arbitrary directory into the scratch and hand
    # it to the trainer. `name_or_path` is the base model for the same reason. Neither is a form
    # value on any screen; both were reachable only because `sections` is derived from the config.
    for key, value in (overrides or {}).items():
        if key in ("folder_path", "name_or_path", "training_folder"):
            logger.warning(f"lora train: refusing an override of {key!r} - paths are resolved, "
                           "never supplied")
            continue
        for section in sections:
            if key in section:
                section[key] = value
                break

    # 🔴 RE-CLAMPED AFTER THE OVERRIDES, BECAUSE THE OVERRIDES RUN AFTER THE CLAMPS. Every bound
    # above was applied to the SIGNATURE argument and then overwritten by a key of the same name
    # out of the request body — `web/lora.py` passes `overrides` through verbatim and says so:
    # *"precisely so the pins are guarding real client input"*. Measured before the fix:
    # steps 2,000,000 (cap 20,000), lr 5.0 (cap 1e-2), linear 4096 (cap 128). MAX_STEPS exists
    # for a typo of 200000, which is a 40-day job; a cap that the same request can lift is not a
    # cap. PINNED below is applied last and was never affected — only the clamped keys were.
    proc["train"]["steps"] = _clamp(proc["train"].get("steps"), MIN_STEPS, MAX_STEPS, n_steps)
    proc["train"]["lr"] = _clamp(proc["train"].get("lr"), MIN_LR, MAX_LR, n_lr)
    proc["network"]["linear"] = _clamp(proc["network"].get("linear"), MIN_RANK, MAX_RANK, n_rank)
    proc["network"]["linear_alpha"] = proc["network"]["linear"]

    for pin in PINNED:
        section, key = pin.path
        target = proc["datasets"][0] if section == "datasets" else proc[section]
        target[key] = pin.value
    for key in OMITTED:
        proc["train"].pop(key, None)
        proc["model"].pop(key, None)
    return cfg


def to_yaml(cfg: dict) -> str:
    """The config as ai-toolkit reads it. `sort_keys=False` so the shown YAML matches the shape a
    reader knows from the proven file — a reordered config is harder to check against it, and
    checking it against that file is the entire point of showing it."""
    return yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True, default_flow_style=False)


# ── reading the run's own log ─────────────────────────────────────────────────

#: tqdm's default bar, which is what ai-toolkit's `ToolkitProgressBar` is:
#:     name:  21%|##  | 418/2000 [45:49<2:54:12,  6.60s/it, lr: 1.0e-04 loss: 1.900e-02]
#: ⚠️ `s/it` FLIPS TO `it/s` above 1 iteration per second. Training here is ~6-17 s/it so it will
#: read `s/it` in practice, but a matcher that only knows one of them silently stops reporting a
#: rate the first time something is fast, and reports nothing rather than reporting wrongly.
_BAR = re.compile(
    r"(?P<done>\d+)/(?P<total>\d+)\s*"
    r"\[(?P<elapsed>[\d:]+)<(?P<remaining>[\d:?]+),\s*"
    r"(?P<rate>[\d.]+)(?P<unit>s/it|it/s)"
)
_LOSS = re.compile(r"loss:\s*([\d.eE+-]+)")


def _hms(text: str) -> float | None:
    """`2:54:12` or `45:49` to seconds. tqdm writes `?` before it can estimate."""
    if not text or "?" in text:
        return None
    parts = text.split(":")
    try:
        nums = [float(x) for x in parts]
    except ValueError:
        return None
    total = 0.0
    for n in nums:
        total = total * 60 + n
    return total


@dataclass
class Progress:
    step: int = 0
    total: int = 0
    s_per_it: float | None = None
    eta_s: float | None = None
    loss: float | None = None


def parse_progress(text: str, expect_total: int = 0) -> Progress:
    """The latest step from the log, whatever shape the log is in.

    ai-toolkit emits progress bars for setup before the training bar. The caller supplies the
    configured training-step count so setup progress is ignored until the matching bar begins.

    ⚠️ A collision is impossible rather than unlikely: `MIN_STEPS` is 100, so no configured run can
    have a total of 56 and be mistaken for the quantization bar.

    🔴 **tqdm SEPARATES UPDATES WITH `\\r`, NOT `\\n`, SO THE WHOLE RUN IS ONE LINE.** Reading the
    log by lines and taking the last one hands you a string containing every update from step 1
    onward — and a `re.search` on it returns the FIRST match, so a naive parser reports "step 1 of
    2000" for nine hours while the log grows perfectly correctly. The fix is not to split at all:
    take the LAST match in the whole text.

    ⚠️ **Reading the tail only would be a second bug at the same spot.** A 2,000-step run at one
    timer block per step makes a log of tens of MB, so tailing is tempting; but the tail boundary
    can fall mid-record, and a truncated `418/2000` reads as `18/2000`. Callers pass a whole
    trailing CHUNK and this function takes the last COMPLETE match inside it.
    """
    if not text:
        return Progress()
    matches = list(_BAR.finditer(text))
    if expect_total:
        matches = [m for m in matches if int(m.group("total")) == expect_total]
    if not matches:
        return Progress()
    m = matches[-1]
    rate = float(m.group("rate"))
    s_per_it = rate if m.group("unit") == "s/it" else (1.0 / rate if rate else None)
    losses = _LOSS.findall(text[m.start():])
    loss = None
    if losses:
        try:
            loss = float(losses[0])
        except ValueError:
            loss = None
    return Progress(
        step=int(m.group("done")),
        total=int(m.group("total")),
        s_per_it=s_per_it,
        eta_s=_hms(m.group("remaining")),
        loss=loss,
    )


#: How much of the log's tail to read for progress. Generous enough to contain several complete
#: bar records even with a timer block between each, small enough that polling it every few
#: seconds costs nothing on a multi-MB file.
TAIL_BYTES = 65_536


def read_progress(log_path, expect_total: int = 0) -> Progress:
    """Progress from a log on disk, reading only its tail.

    🔴 **`open_read` AND SEEK, NEVER `read_bytes`.** A 2,000-step run with a timer block per step
    makes a log of tens of MB, and this is polled every couple of seconds while the screen is open.
    `read_bytes(...)[-N:]` decrypts and materializes the entire file to throw away all but 64 KiB
    of it — the vault's own docstring says `open_read` decrypts only the blocks a read touches,
    which is the difference between O(tail) and O(run so far) on every poll.

    ⚠️ Decoded with `errors="replace"`: the seek boundary lands mid-UTF-8 sequence sooner or later,
    and a `UnicodeDecodeError` here would present as "the training stopped reporting" rather than
    as a decoding bug.
    """
    st = vault_fs.stat(log_path)
    if st is None:
        return Progress()
    try:
        with vault_fs.open_read(log_path) as fh:
            if st.size > TAIL_BYTES:
                fh.seek(st.size - TAIL_BYTES)
            blob = fh.read()
    except OSError:
        return Progress()
    return parse_progress(blob.decode("utf-8", "replace"), expect_total)


# ── the plaintext handoff to ai-toolkit ──────────────────────────────────────

#: `tag` for every scratch path this module makes, so one grep finds the whole handoff.
STAGE_TAG = "loratrain"

#: What a trained model is called, on both sides of the boundary. Named once because the collect
#: globs for it and the Test screen lists by it, and those two disagreeing is a silent empty list.
MODEL_SUFFIX = ".safetensors"

#: How often the drain thread collects finished checkpoints out of the scratch and into the vault.
#:
#: 🔴 **THIS IS WHAT MAKES THE REDIRECT BELOW LEGITIMATE, SO IT IS NOT A TUNING KNOB.** `save_every`
#: is 250 steps — 27 minutes at the Fast preset's measured 6.53 s/it — so a 30 s drain is two orders
#: of magnitude finer than the interval between saves, and what a power cut can take is bounded by
#: the checkpoint being written at that instant rather than by the whole run.
COLLECT_EVERY_S = 30


@dataclass
class Staged:
    """Everything one run keeps in the scratch, under ONE `root` the sweep removes whole.

    Dataset, config, output, and log share one root so cleanup removes the complete plaintext
    workspace, including configuration that may contain identifying names.
    """
    root: Path
    dataset: Path
    config: Path
    output: Path
    log: Path
    #: What ai-toolkit was told to call the model. Opaque — see `_staged_config`.
    model_name: str


def stage_for_ai_toolkit(subject_id: str, dataset_dir, cfg: dict) -> Staged:
    """Materialize everything ai-toolkit reads and writes as PLAINTEXT, in the scratch.

    ai-toolkit is a separate process without the vault key, so routed dataset and config paths are
    unavailable to it. Stage plaintext inputs and config under an opaque scratch root. Dataset
    image and caption filenames share one opaque stem so ai-toolkit preserves each pair. The
    output directory is staged as well, and `_collect_models` copies each completed checkpoint
    into the vault before scratch cleanup can remove it.
    """
    import scratch

    # Keep the workspace under `LORA_STAGE_SUBDIR`, which the startup scratch sweep skips because
    # a training process can outlive the Vocalis process that started it. See
    # `scratch.LORA_STAGE_SUBDIR` and `sweep_staging`.
    root = (Path(scratch.scratch_root()) / scratch.LORA_STAGE_SUBDIR
            / scratch.opaque_name(f"{STAGE_TAG}/{subject_id}/run"))
    dataset = root / scratch.opaque_name(f"{STAGE_TAG}/{subject_id}/dataset")
    output = root / scratch.opaque_name(f"{STAGE_TAG}/{subject_id}/output")
    dataset.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)

    # ⚠️ `vault_fs.glob` RETURNS NAMES, NOT PATHS — its own docstring says so, and
    # `lorasubj._sweep` carries the scar of passing them straight on.
    pairs = 0
    for name in sorted(vault_fs.glob(Path(dataset_dir), "*")):
        src = Path(dataset_dir) / name
        stem = Path(name).stem
        dst = dataset / scratch.opaque_name(f"{STAGE_TAG}/{subject_id}/{stem}",
                                            Path(name).suffix.lower())
        dst.write_bytes(vault_fs.read_bytes(src))
        pairs += 1

    model_name = scratch.opaque_name(f"{STAGE_TAG}/{subject_id}/model")
    cfg_path = root / scratch.opaque_name(f"{STAGE_TAG}/{subject_id}/config", ".yaml")
    cfg_path.write_text(to_yaml(_staged_config(cfg, dataset=dataset, output=output,
                                               name=model_name)), encoding="utf-8")

    logger.info(f"lora train: staged {pairs} dataset files for ai-toolkit under {root.name}")
    return Staged(root=root, dataset=dataset, config=cfg_path, output=output,
                  log=root / scratch.opaque_name(f"{STAGE_TAG}/{subject_id}/log", ".log"),
                  model_name=model_name)


def staging_root():
    """The directory every staged run lives under. Skipped by `scratch.sweep`; reaped by
    `sweep_staging` below."""
    import scratch

    return Path(scratch.scratch_root()) / scratch.LORA_STAGE_SUBDIR


def training_scope_active() -> bool:
    """Is an ai-toolkit training from a PREVIOUS Vocalis process still running?

    The trainer runs in its own systemd scope and can outlive the server process. If systemd is
    unavailable, no scoped run can remain; if the query runs but fails, the state is ambiguous and
    cleanup must preserve the staged files.
    """
    try:
        # Decode output consistently across host locales; malformed bytes do not affect the scope
        # name check.
        r = subprocess.run(["systemctl", "--user", "list-units", "--type=scope", "--no-legend"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=15)
    except FileNotFoundError:
        return False
    except (OSError, subprocess.SubprocessError):
        logger.warning("lora train: could not ask systemd whether a training is running; "
                       "leaving the staged workspace alone")
        return True
    # A failed query cannot establish that no scope is active, so preserve staged data.
    if r.returncode != 0:
        logger.warning(f"lora train: systemctl exited {r.returncode} when asked whether a "
                       f"training is running; leaving the staged workspace alone")
        return True
    return SCOPE_PREFIX in (r.stdout or "")


def sweep_staging() -> int:
    """Delete the staged workspaces of runs that are over. Call at startup.

    📌 This is the other half of `scratch.LORA_STAGE_SUBDIR`'s exemption: the sweep that cannot run
    blindly still has to run. Returns how many workspaces it removed.
    """
    root = staging_root()
    try:
        if not root.is_dir():
            return 0
        entries = list(root.iterdir())
    except OSError:
        return 0
    if not entries:
        return 0
    if training_scope_active():
        logger.info(f"lora train: a training is still running - leaving {len(entries)} staged "
                    "workspace(s) alone")
        return 0
    n = 0
    for p in entries:
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)
        n += 1
    logger.info(f"lora train: swept {n} staged workspace(s) left by a previous run")
    return n


def _staged_config(cfg: dict, *, dataset, output, name: str) -> dict:
    """Return a copy with ai-toolkit paths redirected to scratch.

    Keep the caller's config unchanged for the routed record and YAML preview. The opaque model
    name is mapped back to the subject-specific name when checkpoints are collected, preventing
    subject names from appearing in plaintext scratch filenames.
    """
    import copy

    out = copy.deepcopy(cfg)
    out["config"]["name"] = name
    proc = out["config"]["process"][0]
    proc["training_folder"] = str(output)
    for ds in proc.get("datasets") or []:
        ds["folder_path"] = str(dataset)
    return out


# ── the run ───────────────────────────────────────────────────────────────────

def run_dir(subject_id: str):
    """Where one subject's training artifacts live. Routed like everything else in 9.0 — the log
    names the subject on every checkpoint line and the output is a model OF a person.

    ⚠️ **GUARDED LIKE ITS FIVE SIBLINGS.** `lorasubj.dataset_dir`, `loragen.out_dir`,
    `loraface.face_path`, `loracands.candidates_dir` and `loratest.test_dir` all check the id
    before joining it; this one did not, and it is reachable with client text via
    `GET /lora/subjects/<id>/train/log`. Ids are generated, so this should be unreachable — which
    is exactly why it is asserted rather than assumed.
    """
    if not _SAFE_ID.match(subject_id or ""):
        raise ValueError(f"unsafe subject id for a directory name: {subject_id!r}")
    return paths.LORA_TRAINING / subject_id


def output_dir(subject_id: str):
    """Where the trained models land, in the vault. `_collect_models` fills it."""
    return run_dir(subject_id) / "output"


def trained_models(subject_id: str) -> list:
    """The models this subject has, newest last, as `(name, logical path)`.

    These vault-backed models can be offered through `lorapublish.lent`; they are not visible in
    ComfyUI's unencrypted model directory until temporarily published.

    ⚠️ Sorted by NAME, and the final model sorts before its own checkpoints (`subject-fast` vs
    `subject-fast_000000500`), which is the order the screen wants: the finished model first.
    """
    d = output_dir(subject_id)
    try:
        return [(q.name, q) for q in sorted(vault_fs.rglob(d, f"*{MODEL_SUFFIX}"))]
    except (OSError, ValueError):
        return []


@dataclass
class TrainState:
    subject_id: str = ""
    name: str = ""
    running: bool = False
    pid: int = 0
    unit: str = ""
    preset: str = ""
    #: The scratch directory holding the plaintext ai-toolkit was handed. Swept when the run ends
    #: or is canceled — see `_sweep_staged`.
    staged_dir: str = ""
    #: `training_folder`: where ai-toolkit writes checkpoints, drained into the vault as they land.
    staged_out: str = ""
    #: The log ai-toolkit appends to. Read for progress while the run is live (it is plaintext, so
    #: the poll costs no decryption), copied into the vault once at the end.
    staged_log: str = ""
    #: The opaque name ai-toolkit knows the model by, and the name it gets in the vault. Both are
    #: needed: collecting maps one to the other. See `_staged_config`.
    staged_model: str = ""
    model_name: str = ""
    #: What `_collect_models` has already put in the vault (relative names), and the size it last
    #: saw for a file that was still being written.
    collected: set = dc_field(default_factory=set)
    growing: dict = dc_field(default_factory=dict)
    steps: int = 0
    started: float = 0.0
    finished: float = 0.0
    canceled: bool = False
    error: str = ""
    cards: list = dc_field(default_factory=list)


class TrainRun:
    """One training at a time, per process.

    Launcher and stop callbacks are injected so the state machine can be tested without a GPU.

    ⚠️ **ONE RUN, REFUSED NOT QUEUED.** A second training would take cards the first one is using
    and both would thrash or OOM. `AceQueue` is right for images because images are small and
    independent; a 9.6-hour job that needs every card is not queue-shaped, it is exclusive.
    """

    def __init__(self, *, launch: Callable, stop: Callable, alive: Callable):
        self._launch = launch
        self._stop = stop
        self._alive = alive
        self._lock = threading.RLock()
        self._state = TrainState()
        self._drain_stop = threading.Event()

    def snapshot(self) -> dict:
        with self._lock:
            st = self._state
            if st.running and st.pid and not self._alive(st.pid, st.unit):
                # ⚠️ The run ended without anyone watching. Reconciled on READ rather than by a
                # watcher thread: a poll that must run for state to be correct is a poll that is
                # wrong whenever it is late, and a 9.6-hour job outlives many things.
                st.running = False
                logger.info(f"lora train: {st.name} is no longer alive; marking finished")
                self._finish(st)
            elif st.running:
                self._collect_models(st)
            # `st.steps` is what tells the parser which tqdm bar is the training one — see
            # `parse_progress`. Without it the setup phase reports ai-toolkit's quantization bar.
            prog = (read_progress(self._progress_log(st), st.steps)
                    if st.subject_id else Progress())
            return {
                "subject_id": st.subject_id,
                "name": st.name,
                "running": st.running,
                "preset": st.preset,
                "steps": st.steps,
                "canceled": st.canceled,
                "error": st.error,
                "cards": list(st.cards),
                "step": prog.step,
                "total": prog.total or st.steps,
                "s_per_it": prog.s_per_it,
                "eta_s": prog.eta_s,
                "loss": prog.loss,
            }

    def log_path(self, subject_id: str):
        """The run's log IN THE VAULT — the durable record, and what the screen reads once the run
        is over. It is NOT the file ai-toolkit writes; see `_progress_log`."""
        return run_dir(subject_id) / "train.log"

    def _progress_log(self, st):
        """Which log to parse right now: the staged one while it exists, the vault copy after.

        🔴 **ai-toolkit CANNOT WRITE THE VAULT COPY, AND USED TO BE ASKED TO.** `launch_real` was
        handed `log_path()` — a routed path — so on an encrypted install the trainer wrote
        plaintext at a logical path that is not on the platter, which is `vault_fs`'s own
        *"a missed WRITE is SILENT: it cheerfully drops a cleartext file inside the vault root"*,
        with the subject's name on every checkpoint line. Meanwhile `read_progress` looked for the
        routed name, found nothing, and the Train screen sat at step 0 for three and a half hours.
        Both symptoms, one cause.
        """
        staged = Path(st.staged_log) if st.staged_log else None
        if staged is not None and staged.is_file():
            return staged
        return self.log_path(st.subject_id)

    def config_path(self, subject_id: str):
        return run_dir(subject_id) / "config.yaml"

    def output_dir(self, subject_id: str):
        return output_dir(subject_id)

    def start(self, subject_id: str, name: str, cfg: dict, cards: list,
              preset: str = "") -> dict:
        with self._lock:
            st = self._state
            if st.running and st.pid and self._alive(st.pid, st.unit):
                raise TrainRefused("a training is already running")

            d = run_dir(subject_id)
            vault_fs.mkdir(d)
            vault_fs.mkdir(self.output_dir(subject_id))
            # The routed copy is the RECORD — what ran, kept beside the run, encrypted like
            # everything else in 9.0. It is not the copy ai-toolkit reads.
            vault_fs.write_text(self.config_path(subject_id), to_yaml(cfg))

            # 🔴 …and THIS is the copy it reads. See `stage_for_ai_toolkit`: on an encrypted
            # install neither the dataset nor the config exists as a plain file, and the trainer
            # holds no DEK.
            dataset_dir = cfg["config"]["process"][0]["datasets"][0]["folder_path"]
            staged = stage_for_ai_toolkit(subject_id, dataset_dir, cfg)

            # Pass the staged log path explicitly. The launcher's default could write an
            # unencrypted log containing the subject name outside the scratch sweep. Keep
            # `_progress_log` on the staged path as well. If launch fails, remove the plaintext
            # workspace immediately because no TrainState exists to track it for later cleanup.
            #
            # ⚠️ `BaseException`, and re-raised. The vault's locked/auth errors are deliberately
            # outside `Exception`, and those are exactly the failures most likely to strand a stage.
            try:
                pid, unit = self._launch(config=staged.config, log=staged.log)
            except BaseException:
                shutil.rmtree(staged.root, ignore_errors=True)
                logger.info(f"lora train: launch failed - swept the staged workspace "
                            f"{staged.root.name}")
                raise
            self._state = TrainState(
                subject_id=subject_id, name=name, running=True, pid=pid, unit=unit,
                preset=str(preset or ""),
                staged_dir=str(staged.root),
                staged_out=str(staged.output),
                staged_log=str(staged.log),
                staged_model=staged.model_name,
                model_name=str(cfg["config"]["name"]),
                steps=int(cfg["config"]["process"][0]["train"]["steps"]),
                cards=list(cards),
            )
            self._start_drain()
            logger.info(f"lora train: started {name} pid={pid} unit={unit or '-'}")
            return self.snapshot()

    # ── getting the run's output back across the boundary ────────────────────

    def _start_drain(self) -> None:
        """Collect checkpoints in the background even when no browser is polling progress.

        Scratch is ephemeral, so completed checkpoints must be copied into the vault regularly.
        `snapshot()` also reconciles state when called; this poll keeps collection independent of
        browser activity.
        """
        self._drain_stop = threading.Event()
        threading.Thread(target=self._drain_loop, args=(self._drain_stop,),
                         name="lora-train-drain", daemon=True).start()

    def _drain_loop(self, stop: threading.Event) -> None:
        while not stop.wait(COLLECT_EVERY_S):
            try:
                if not self.snapshot()["running"]:
                    return
            except _tolerated() as exc:
                # A locked vault is recoverable and the next wake tries again. Everything else is
                # logged and survived for the same reason: this thread going quiet costs the run's
                # output, and it would do so silently, in a daemon, hours before anyone looked.
                logger.info(f"lora train: drain poll skipped - {type(exc).__name__}")

    def _finish(self, st) -> None:
        """The end of a run, from either exit: take everything, then destroy the plaintext."""
        self._drain_stop.set()
        self._collect_models(st, final=True)
        self._collect_log(st)
        self._sweep_staged(st)

    def _collect_models(self, st, *, final: bool = False) -> int:
        """Copy finished checkpoints from scratch into the vault and return the count.

        ai-toolkit owns pruning of its output directory, so this process never mutates files it may be
        writing. A checkpoint is copied after its size remains stable across polls; the final pass may
        collect immediately because the writer has exited.
        """
        out = st.staged_out
        if not out or not st.subject_id:
            return 0
        try:
            found = sorted(Path(out).rglob(f"*{MODEL_SUFFIX}"))
        except OSError:
            return 0

        n = 0
        for src in found:
            key = str(src.relative_to(out))
            if key in st.collected:
                continue
            try:
                size = src.stat().st_size
            except OSError:
                continue
            if not size:
                continue
            if not final and st.growing.get(key) != size:
                st.growing[key] = size
                continue
            # Map the opaque scratch token back to the subject-specific vault filename.
            # 🔴 `safe_component` IS LOAD-BEARING, NOT TIDINESS — see its note above. `model_name`
            # is client text and this is the one place it becomes a path.
            safe_model = safe_component(st.model_name)
            rel = [safe_component(part.replace(st.staged_model, safe_model), fallback="checkpoint")
                   for part in Path(key).parts] if st.staged_model else [safe_component(key)]
            dst = self.output_dir(st.subject_id).joinpath(*rel)
            try:
                vault_fs.mkdir(dst.parent)
                vault_fs.write_bytes(dst, src.read_bytes())
            except OSError as exc:
                logger.info(f"lora train: could not collect a checkpoint - {exc}")
                continue
            st.collected.add(key)
            st.growing.pop(key, None)
            n += 1
            logger.info(f"lora train: collected {dst.name} into the vault")
        return n

    def _collect_log(self, st) -> None:
        """Copy the completed log into the vault once.

        While the run is live, `_progress_log` reads the staged copy directly. Avoid rewriting the full
        log on every status poll.
        """
        if not st.staged_log or not st.subject_id:
            return
        src = Path(st.staged_log)
        try:
            if not src.is_file():
                return
            vault_fs.mkdir(run_dir(st.subject_id))
            vault_fs.write_bytes(self.log_path(st.subject_id), src.read_bytes())
        except OSError as exc:
            logger.info(f"lora train: could not keep the run log - {exc}")

    def _sweep_staged(self, st) -> None:
        """Delete this run's plaintext staging tree.

        The tree contains the config, dataset, model output, and log. The caller collects models and
        logs first. Cleanup is best-effort because it also runs during status reads.
        """
        d = st.staged_dir
        if not d:
            return
        st.staged_dir = st.staged_out = st.staged_log = ""
        try:
            shutil.rmtree(d, ignore_errors=True)
            logger.info(f"lora train: swept staged plaintext {Path(d).name}")
        except OSError as exc:                      # pragma: no cover - rmtree already swallows
            logger.info(f"lora train: could not sweep {d} - {exc}")

    def cancel(self) -> dict:
        with self._lock:
            st = self._state
            if st.running and st.pid:
                self._stop(st.pid, st.unit)
                st.canceled = True
                st.running = False
                logger.info(f"lora train: canceled {st.name}")
                # Preserve checkpoints collected before cancellation; cleanup removes only scratch.
                self._finish(st)
            return self.snapshot()


# ── the real launcher ────────────────────────────────────────────────────────

# Configure the external ai-toolkit launcher with an absolute path. It owns GPU visibility,
# the PYTHONPATH that provides KEI_SAFE_SDPA, and removal of incompatible allocator settings.
_LAUNCH_SCRIPT_VALUE = os.environ.get("LORA_LAUNCH_SCRIPT", "").strip()
LAUNCH_SCRIPT = Path(_LAUNCH_SCRIPT_VALUE) if _LAUNCH_SCRIPT_VALUE else None

SCOPE_PREFIX = "vocalis-lora-train-"


def launcher_available() -> bool:
    """Return whether an absolute launcher path is configured and exists."""
    if paths.docker_encrypted_mode():
        return False
    try:
        return bool(LAUNCH_SCRIPT and LAUNCH_SCRIPT.is_absolute() and LAUNCH_SCRIPT.is_file())
    except OSError:
        return False


def launch_real(*, config, log):
    """Start training in a systemd user scope and return `(pid, unit)`.

    The scope keeps the launcher and detached descendants under one lifecycle. Pass the log path
    explicitly so output remains in the staged workspace.
    """
    if paths.docker_encrypted_mode():
        raise TrainRefused("LoRA training is not available in Docker")

    script = LAUNCH_SCRIPT
    if not script or not script.is_absolute() or not script.is_file():
        raise TrainRefused(
            "ai-toolkit launcher is unavailable; set LORA_LAUNCH_SCRIPT to an existing absolute path")

    import voicetrain

    unit = f"{SCOPE_PREFIX}{uuid.uuid4().hex[:8]}"
    if not voicetrain.systemd_scope_available():
        # An honest degrade, not a silent one: without systemd the run dies with the service.
        # `voicetrain` logs the same warning for the same reason on the same boxes.
        unit = ""

    cmd = [str(script), str(log)]
    if unit:
        cmd = ["systemd-run", "--user", "--scope", "--quiet", f"--unit={unit}", "--collect",
               "--"] + cmd

    env = dict(os.environ)
    env["KEI_CONFIG"] = str(config)
    # Disable the watchdog because the training interlock dedicates the cards for this run. A
    # separate VRAM floor could interrupt healthy training and is not user-configurable.
    env["KEI_WATCHDOG"] = "0"

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, env=env, cwd=str(script.parent))
    # The script prints `=== training pid: N` and exits; the training itself is the setsid child,
    # so the Popen pid is the launcher and is NOT what we must later kill.
    out = (proc.communicate(timeout=300)[0] or b"").decode("utf-8", "replace")
    m = re.search(r"training pid:\s*(\d+)", out)
    if not m:
        raise TrainRefused(f"the launch script did not report a pid: {out.strip()[-400:] or '(no output)'}")
    pid = int(m.group(1))
    logger.info(f"lora train: launched pid={pid} unit={unit or '-'}")
    return pid, unit


def stop_real(pid: int, unit: str) -> None:
    """Stop the cgroup if there is one, then the process group as a backstop.

    🔴 **BY PID AND UNIT, NEVER BY NAME.** A `pkill -f run.py` on this box would also match
    another session's work and anything else with that string in its argv.
    """
    import voicetrain
    voicetrain.stop_train(pid, unit)


def alive_real(pid: int, unit: str) -> bool:
    import voicetrain
    return voicetrain.train_alive(pid, unit)
