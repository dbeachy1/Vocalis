"""Tests for mixed-precision selection (tts_utils._autocast_ctx).

The default is bf16 on CUDA and fp16 on ROCm (fp32 has no door into RDNA's WMMA
units — DESIGN_6_2_BATCHING.md §6.2), overridable to bf16/fp16/fp32 via
VOCALIS_DTYPE, and a no-op on CPU. We force the CUDA branch and the HIP build flag
with monkeypatch and inspect the returned context WITHOUT entering it, so these run
on any host (no GPU required)."""
import contextlib
import inspect
import re

import torch

import tts_utils
from tts_utils import _autocast_ctx


def _force_cuda(monkeypatch, available):
    monkeypatch.setattr(torch.cuda, "is_available", lambda: available)


def _force_hip(monkeypatch, hip):
    """`torch.version.hip` is the ROCm-build tell — a version string there, None on CUDA."""
    monkeypatch.setattr(torch.version, "hip", "6.4.0" if hip else None, raising=False)


def test_default_is_bf16_on_cuda(monkeypatch):
    _force_cuda(monkeypatch, True)
    _force_hip(monkeypatch, False)
    monkeypatch.delenv("VOCALIS_DTYPE", raising=False)      # unset → bf16 default
    ctx = _autocast_ctx()
    assert isinstance(ctx, torch.autocast)
    assert ctx.fast_dtype == torch.bfloat16


def test_default_is_fp16_on_rocm(monkeypatch):
    """On ROCm, fp16 is the default because fp32 cannot use RDNA's WMMA units efficiently.
    `VOCALIS_TTS_FP16=0` restores bf16 when an installation needs that precision instead."""
    _force_cuda(monkeypatch, True)
    _force_hip(monkeypatch, True)
    monkeypatch.delenv("VOCALIS_DTYPE", raising=False)
    monkeypatch.delenv("VOCALIS_TTS_FP16", raising=False)
    ctx = _autocast_ctx()
    assert isinstance(ctx, torch.autocast) and ctx.fast_dtype == torch.float16


def test_the_rocm_fp16_killswitch_puts_it_back_on_bf16(monkeypatch):
    """VOCALIS_TTS_FP16=0 is the documented way out if fp16 ever sounds wrong on a given card."""
    _force_cuda(monkeypatch, True)
    _force_hip(monkeypatch, True)
    monkeypatch.delenv("VOCALIS_DTYPE", raising=False)
    monkeypatch.setenv("VOCALIS_TTS_FP16", "0")
    ctx = _autocast_ctx()
    assert isinstance(ctx, torch.autocast) and ctx.fast_dtype == torch.bfloat16


def test_an_explicit_dtype_beats_the_rocm_default(monkeypatch):
    """The per-vendor default fills in only when VOCALIS_DTYPE is unset — an explicit value is a
    deliberate instruction and must not be quietly upgraded to fp16 on an AMD box."""
    _force_cuda(monkeypatch, True)
    _force_hip(monkeypatch, True)
    monkeypatch.delenv("VOCALIS_TTS_FP16", raising=False)
    monkeypatch.setenv("VOCALIS_DTYPE", "bf16")
    assert _autocast_ctx().fast_dtype == torch.bfloat16
    monkeypatch.setenv("VOCALIS_DTYPE", "fp32")
    assert isinstance(_autocast_ctx(), contextlib.nullcontext)


def test_the_generate_callable_opens_no_autocast_region_of_its_own():
    """🔴 Regression guard for an autocast nesting error on ROCm.

    `make_generate_fn`'s callable is invoked inside `_autocast_ctx()` by BOTH of its paths —
    `generate_timed` wraps the direct one, `WorkerPool._worker_entry` wraps a worker's whole loop.
    A second `torch.autocast` opened inside it therefore always nests, and a nested region with a
    DIFFERENT dtype is not a refinement: the outer region's activations meet the inner region's
    weight casts and torch raises

        Input type (CUDABFloat16Type) and weight type (torch.cuda.HalfTensor) should be the same

    ⚠️ NOTHING ELSE IN THE SUITE COULD SEE IT. The dtype only diverges once real tensors flow
    through a real model on a real ROCm card, and the A/B harness that justified the change
    (`scripts/bench-s3gen-autocast.py`) calls `model.generate` directly, entering neither region.
    So the measurement was right, the integration was never exercised, and the box was the first
    thing to run the combination. This is a source check because that is what can run everywhere.
    """
    src = inspect.getsource(tts_utils.make_generate_fn)
    code = "\n".join(ln for ln in src.splitlines() if not ln.strip().startswith("#"))
    assert "autocast" not in code, (
        "make_generate_fn opened an autocast region. Its callers already run inside one, so this "
        "nests — pick the precision in _autocast_ctx() instead, and read its docstring first.")


def test_only_one_autocast_region_wraps_the_generate_path():
    """⚠️ The guard above is per-function and this one is per-module: exactly two places may open
    a region, and they are the two that wrap a whole path. A third is either a nest or a gap."""
    src = inspect.getsource(tts_utils)
    openers = re.findall(r"^\s*with\s+_autocast_ctx\(\)", src, re.M)
    assert len(openers) == 2, (
        f"expected 2 `with _autocast_ctx()` sites (generate_timed and WorkerPool._worker_entry), "
        f"found {len(openers)}")
    # And no raw `torch.autocast(` anywhere outside _autocast_ctx itself.
    raw = [ln.strip() for ln in src.splitlines()
           if "torch.autocast(" in ln and not ln.strip().startswith("#")]
    ctx_src = inspect.getsource(tts_utils._autocast_ctx)
    outside = [ln for ln in raw if ln not in ctx_src]
    assert not outside, (
        "torch.autocast is constructed outside _autocast_ctx — precision is decided in one "
        "place:\n  " + "\n  ".join(outside))


def test_fp16_override(monkeypatch):
    _force_cuda(monkeypatch, True)
    monkeypatch.setenv("VOCALIS_DTYPE", "fp16")
    ctx = _autocast_ctx()
    assert isinstance(ctx, torch.autocast) and ctx.fast_dtype == torch.float16


def test_fp32_override_disables_autocast(monkeypatch):
    _force_cuda(monkeypatch, True)
    monkeypatch.setenv("VOCALIS_DTYPE", "fp32")
    assert isinstance(_autocast_ctx(), contextlib.nullcontext)   # plain fp32, no autocast


def test_unknown_dtype_falls_back_to_fp32(monkeypatch):
    _force_cuda(monkeypatch, True)
    monkeypatch.setenv("VOCALIS_DTYPE", "garbage")
    assert isinstance(_autocast_ctx(), contextlib.nullcontext)   # safe fallback, not a crash


def test_cpu_is_always_fp32(monkeypatch):
    _force_cuda(monkeypatch, False)
    monkeypatch.setenv("VOCALIS_DTYPE", "bf16")                  # ignored — no CUDA
    assert isinstance(_autocast_ctx(), contextlib.nullcontext)
