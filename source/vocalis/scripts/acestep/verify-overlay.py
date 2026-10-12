#!/usr/bin/env python3
"""Verify the Vocalis M0 API-widening overlay is present in an ACE-Step checkout.

Run under the checkout's own venv.  Exits 0 only when every widened parameter is
reachable end to end: declared on the request model, read by the request builder,
and accepted by the pipeline dataclasses.

Usage: verify-overlay.py [checkout-root]     (default: $ACESTEP_HOME, else cwd)

The service start script runs this check on every launch and refuses to start when the overlay is
missing or incomplete.
"""

from __future__ import annotations

import dataclasses
import inspect
import os
import sys

# `acestep` is not installed into the venv — it is imported from the checkout
# tree, which the service supplies as its WorkingDirectory.  This script runs
# from the Vocalis repo instead, and Python puts the SCRIPT's directory on
# sys.path rather than the cwd, so the root has to go on explicitly.  Without
# this the verifier fails with "no module named acestep" no matter what state
# the overlay is in, which is a check that cannot ever pass.
ACESTEP_ROOT = os.path.abspath(
    sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ACESTEP_HOME") or os.getcwd()
)
sys.path.insert(0, ACESTEP_ROOT)

# Fields the overlay routes through to GenerationParams.
PARAM_FIELDS = [
    "retake_seed",
    "retake_variance",
    "flow_edit_morph",
    "flow_edit_source_caption",
    "flow_edit_source_lyrics",
    "flow_edit_n_min",
    "flow_edit_n_max",
    "flow_edit_n_avg",
    "sampler_mode",
    "velocity_norm_threshold",
    "velocity_ema_factor",
    "dcw_enabled",
    "dcw_mode",
    "dcw_scaler",
    "dcw_high_scaler",
    "dcw_wavelet",
    "enable_normalization",
    "normalization_db",
    "fade_in_duration",
    "fade_out_duration",
    "latent_shift",
    "latent_rescale",
]

# Fields the overlay routes through to GenerationConfig.
CONFIG_FIELDS = ["lm_batch_chunk_size", "mp3_bitrate", "mp3_sample_rate"]

# Declared-but-dead upstream fields the overlay revives.  `timesteps` was
# already parsed by build_generation_setup but never populated by the request
# builder; `constrained_decoding` was parsed and then hardcoded to True.
# (`lm_repetition_penalty` is deliberately NOT here: GenerationParams has no
# such field, so wiring it is a pipeline change, not plumbing.)
REVIVED_FIELDS = ["timesteps", "constrained_decoding"]

FAILURES: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        FAILURES.append(message)


class RecordingParser:
    """Stands in for RequestParser and records which fields were asked for."""

    def __init__(self) -> None:
        self.asked: set[str] = set()

    def _record(self, name, default):
        self.asked.add(name)
        return default

    def str(self, name, default=""):
        return self._record(name, default)

    def bool(self, name, default=False):
        return self._record(name, default)

    def int(self, name, default=None):
        return self._record(name, default)

    def float(self, name, default=None):
        return self._record(name, default)

    def get(self, name, default=None):
        return self._record(name, default)


def main() -> int:
    try:
        from acestep.api.http.release_task_models import GenerateMusicRequest
        from acestep.api.http.release_task_request_builder import build_generate_music_request
        from acestep.api.job_generation_setup import build_generation_setup
        from acestep.constants import DEFAULT_DIT_INSTRUCTION
        from acestep.inference import GenerationConfig, GenerationParams
    except Exception as exc:  # noqa: BLE001 - any import failure is fatal here
        print(
            f"OVERLAY VERIFY FAILED: cannot import ACE-Step from {ACESTEP_ROOT}: {exc}",
            file=sys.stderr,
        )
        return 1

    all_request_fields = PARAM_FIELDS + CONFIG_FIELDS + REVIVED_FIELDS

    # 1. Declared on the request model.
    declared = getattr(GenerateMusicRequest, "model_fields", None)
    if declared is None:  # pydantic v1
        declared = GenerateMusicRequest.__fields__
    for name in all_request_fields:
        check(name in declared, f"request model is missing `{name}`")

    # 2. Populated by the request builder.  A field declared on the model but
    #    never read from the request is exactly the `timesteps` failure mode:
    #    settable in theory, always None in practice.
    parser = RecordingParser()
    try:
        build_generate_music_request(
            parser,
            GenerateMusicRequest,
            DEFAULT_DIT_INSTRUCTION,
            0.85,
            2.5,
            0.9,
        )
    except Exception as exc:  # noqa: BLE001
        FAILURES.append(f"build_generate_music_request() raised: {exc}")
    else:
        for name in all_request_fields:
            check(name in parser.asked, f"request builder never reads `{name}`")

    # 3. Accepted by the pipeline dataclasses.  This is what catches an upstream
    #    rename: the overlay would still apply and still parse, then blow up with
    #    a TypeError at generation time instead of here.
    param_names = {f.name for f in dataclasses.fields(GenerationParams)}
    for name in PARAM_FIELDS:
        check(name in param_names, f"GenerationParams has no field `{name}` (upstream rename?)")
    config_names = {f.name for f in dataclasses.fields(GenerationConfig)}
    for name in CONFIG_FIELDS:
        check(name in config_names, f"GenerationConfig has no field `{name}` (upstream rename?)")

    # 4. Actually forwarded by build_generation_setup.
    try:
        source = inspect.getsource(build_generation_setup)
    except OSError as exc:
        FAILURES.append(f"cannot read build_generation_setup source: {exc}")
    else:
        for name in PARAM_FIELDS + CONFIG_FIELDS:
            check(
                f"{name}=req.{name}" in source,
                f"build_generation_setup never forwards `{name}`",
            )
        check(
            "use_constrained_decoding=req.constrained_decoding" in source,
            "build_generation_setup still hardcodes use_constrained_decoding=True",
        )

    # 5. The 5 Hz LM loads AT its target dtype rather than materializing fp32 first.
    #
    # The dtype assertion guards the expected peak-memory reduction during model loading.
    # `_load_pytorch_model` called `from_pretrained` with no `torch_dtype`, so the weights
    # materialize at full fp32 width and are only halved by the `.to(self.dtype)` on the NEXT
    # line — by which time they are already resident, and a device context is active, so that
    # fp32 copy is built ON THE CARD. For Qwen3-1.7B that is roughly 6.8 GB of peak allocation
    # where ~3.4 GB would do.
    #
    # ⚠️ `ACESTEP_ROCM_DTYPE=bfloat16` DOES NOT REACH THIS PATH. It sets `self.dtype`, which is
    # only consulted after the model exists — which is exactly why reading the unit's environment
    # and concluding "we run bf16" was not an answer about this line.
    try:
        from acestep.llm_inference import LLMHandler

        lm_source = inspect.getsource(LLMHandler._load_pytorch_model)
    except Exception as exc:  # noqa: BLE001
        FAILURES.append(f"cannot read LLMHandler._load_pytorch_model: {exc}")
    else:
        check(
            "torch_dtype=self.dtype" in lm_source,
            "the 5Hz LM still loads at fp32 before being cast — lm-dtype.patch is absent, "
            "and it doubles peak VRAM on the card during load",
        )

    # 6. The TMPDIR promotion actually reaches `tempfile` — tempdir-cache.patch.
    #
    # `validate_audio_path` accepts an absolute path only
    # under `tempfile.gettempdir()`, and `tempfile` memoizes that on first use — during the import
    # of `acestep.api_server`, long before `initialize_lifespan_runtime` sets TMPDIR. So the three
    # `os.environ[...]` assignments there were dead on arrival and every staged reference path was
    # refused. Measured both ways on the live checkout before this check was written.
    #
    # ⚠️ ASSERTED ON THE SOURCE, not by calling `gettempdir()` here: this verifier runs as a
    # separate process from a shell, so its own tempdir says nothing about the API server's.
    try:
        from acestep.api import lifespan_runtime

        lr_source = inspect.getsource(lifespan_runtime.initialize_lifespan_runtime)
    except (ImportError, AttributeError, OSError, TypeError) as exc:
        # The four things this can actually raise: the module moved, the function was renamed,
        # the source is unreadable, or it is a builtin. A blanket catch would add nothing except
        # somewhere for a bug in this check to hide.
        FAILURES.append(f"cannot read initialize_lifespan_runtime: {exc}")
    else:
        check(
            "tempfile.tempdir = tmp_root" in lr_source,
            "the TMPDIR promotion never reaches tempfile's cache — tempdir-cache.patch is "
            "absent, and every reference clip will come back as 400 Bad Request",
        )

    if FAILURES:
        print(
            f"OVERLAY VERIFY FAILED ({len(FAILURES)} problem(s)) — the Vocalis "
            "API-widening overlay is absent or stale. An upstream pull most "
            "likely reverted it. Re-apply scripts/acestep/api-widening.patch.",
            file=sys.stderr,
        )
        for problem in FAILURES:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    total = len(all_request_fields)
    print(f"overlay verified: {total} widened parameters reachable end to end")
    return 0


if __name__ == "__main__":
    sys.exit(main())
