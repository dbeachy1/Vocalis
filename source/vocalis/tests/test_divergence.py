"""Tests for divergence and plateau decisions against representative smoothed loss curves and checkpoint intervals."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import voicetrain  # noqa: E402


# The real smoothed mel curve (loss_avg_50/g/mel), sampled per epoch.
PRE_DIVERGENCE_CURVE = {5: 17.8, 8: 16.7, 11: 16.6, 14: 16.4, 17: 16.5, 20: 16.3, 23: 16.2,
                25: 16.1}
DIVERGED_CURVE = {26: 24.1, 27: 35.7, 28: 39.7, 29: 39.3, 30: 37.6, 31: 39.1, 32: 39.3,
                 33: 41.3, 34: 39.6}
HEALTHY_CONTROL_CURVE = {5: 18.7, 10: 18.0, 15: 17.5, 20: 17.5, 25: 17.1, 30: 17.4, 35: 17.4,
                 40: 17.0, 45: 17.3, 50: 16.7, 55: 16.7, 60: 16.3, 65: 16.4, 66: 16.1}


def _curve(by_epoch: dict) -> dict:
    """Shape a per-epoch dict like loss_curve() returns it."""
    pts = [{"epoch": e, "step": e * 182, "loss": v, "smooth": v}
           for e, v in sorted(by_epoch.items())]
    best = min(pts, key=lambda p: p["smooth"])
    return {"curve": pts, "best_epoch": best["epoch"], "best_step": best["step"],
            "best_loss": best["smooth"], "source": "tensorboard"}


@pytest.fixture
def curve(monkeypatch):
    """Let a test hand divergence_check any loss curve it likes."""
    box = {}

    def fake(_cfg, _name):
        return box["value"]

    monkeypatch.setattr(voicetrain, "loss_curve", fake)
    return box


# ── the run that made this exist ────────────────────────────────────────────

def test_it_catches_diverged_curve(curve):
    """The whole point. It must fire on the real collapse."""
    curve["value"] = _curve({**PRE_DIVERGENCE_CURVE, **DIVERGED_CURVE})
    d = voicetrain.divergence_check(None, 'Test_Voice_1_v1', epoch=34)
    assert d, "the guard did not fire on the exact run it was written for"
    assert d["best_epoch"] == 25          # and it names the epoch worth keeping
    assert d["best_loss"] == pytest.approx(16.1, abs=0.1)
    assert d["ratio"] > 2.0               # ~2.5x above best — not a marginal call


def test_it_would_have_fired_within_a_few_epochs_of_the_collapse(curve):
    """Not just eventually — SOON. Firing at epoch 45 would still have wasted four hours.
    The collapse completes by 28; the guard needs DIVERGENCE_EPOCHS of evidence, so the
    earliest honest call is ~30."""
    seen = {**PRE_DIVERGENCE_CURVE}
    fired = None
    for e in sorted(DIVERGED_CURVE):
        seen[e] = DIVERGED_CURVE[e]
        curve["value"] = _curve(seen)
        if voicetrain.divergence_check(None, 'Test_Voice_1_v1', epoch=e):
            fired = e
            break
    assert fired is not None, "it never fired"
    assert fired <= 31, f"fired at epoch {fired} — too late to save the GPU time"


def test_it_leaves_healthy_control_alone(curve):
    """The healthy control curve must not trigger the divergence guard."""
    curve["value"] = _curve(HEALTHY_CONTROL_CURVE)
    assert not voicetrain.divergence_check(None, 'Test_Voice_2_v1', epoch=66)


# ── it must not shoot a healthy run ─────────────────────────────────────────

def test_one_bad_epoch_is_not_divergence(curve):
    """GAN training is noisy. A single spike proves nothing, and killing a run over one is
    how you make the guard something people turn off."""
    spiky = {**PRE_DIVERGENCE_CURVE, 26: 40.0, 27: 16.4, 28: 16.3, 29: 16.5, 30: 16.2}
    curve["value"] = _curve(spiky)
    assert not voicetrain.divergence_check(None, "x", epoch=30)


def test_a_run_that_recovers_is_not_killed(curve):
    """Loss above best for a few epochs, then back down. Real, and not a collapse."""
    wobble = {**PRE_DIVERGENCE_CURVE, 26: 22.0, 27: 23.0, 28: 21.0, 29: 17.0, 30: 16.4, 31: 16.2}
    curve["value"] = _curve(wobble)
    assert not voicetrain.divergence_check(None, "x", epoch=31)


def test_early_epochs_are_never_judged(curve):
    """Epochs 1-2 are wild by nature — the loss starts high and falls fast. Judging them
    against 'the best so far' (which IS epoch 1) would kill every healthy run at birth."""
    start = {1: 24.3, 2: 20.1, 3: 18.5, 4: 17.9, 5: 17.5, 6: 17.2}
    curve["value"] = _curve(start)
    for e in range(1, 7):
        assert not voicetrain.divergence_check(None, "x", epoch=e), \
            f"killed a healthy run at epoch {e}"


def test_sustained_but_only_just_above_best_is_not_divergence(curve):
    """A run plateauing 10% above its best is converging, not collapsing. Only a sustained
    DIVERGENCE_RATIO overshoot counts."""
    plateau = {**PRE_DIVERGENCE_CURVE}
    plateau.update({e: 16.1 * 1.10 for e in range(26, 36)})
    curve["value"] = _curve(plateau)
    assert not voicetrain.divergence_check(None, "x", epoch=35)


# ── it must never take the run down with it ─────────────────────────────────

def test_no_curve_yet_is_not_divergence(curve):
    """TensorBoard has not written anything (the first minute of a run)."""
    curve["value"] = {"curve": [], "best_loss": None, "source": "log"}
    assert not voicetrain.divergence_check(None, "x", epoch=20)


def test_raw_only_curve_is_not_judged(curve):
    """No smoothed series (an older Applio). The raw loss is far too noisy to kill a run
    on, so we decline to judge rather than guess."""
    pts = [{"epoch": e, "step": e * 182, "loss": v, "smooth": None}
           for e, v in {**PRE_DIVERGENCE_CURVE, **DIVERGED_CURVE}.items()]
    curve["value"] = {"curve": pts, "best_epoch": 25, "best_loss": 16.1}
    assert not voicetrain.divergence_check(None, "x", epoch=34)


def test_nonsense_best_loss_is_not_divergence(curve):
    """best_loss <= 0 would make the ratio meaningless (or a ZeroDivisionError)."""
    curve["value"] = _curve({e: 0.0 for e in range(1, 20)})
    assert not voicetrain.divergence_check(None, "x", epoch=19)


# ── the checkpoint that should have existed ─────────────────────────────────

def test_checkpoints_land_close_enough_to_the_best_epoch():
    """Checkpoint cadence should preserve a checkpoint within the configured interval of the best epoch."""
    assert voicetrain.SAVE_EVERY_EPOCH == 5
    worst = max(min(abs(best - k) for k in range(0, 201, voicetrain.SAVE_EVERY_EPOCH))
                for best in range(1, 201))
    assert worst <= 2, f"a best epoch could be {worst} epochs from any checkpoint"


# ── plateau: the OTHER way a run wastes a card ──────────────────────────────
#
# A run can continue for many epochs after its best loss. A sustained plateau is a successful
# completion signal, while a sustained increase remains a separate divergence condition.

def test_plateau_leaves_healthy_control_alone(curve):
    """The healthy control curve must not trigger a plateau stop."""
    curve["value"] = _curve(HEALTHY_CONTROL_CURVE)
    assert not voicetrain.plateau_check(None, 'Test_Voice_2_v1', epoch=66)


def test_plateau_fires_when_the_loss_stops_improving(curve):
    # ⚠️ DERIVED FROM PLATEAU_EPOCHS, NOT A LITERAL. This said `epoch=85` against a threshold of
    # 30; doubling the threshold to 60 in 8.8 turned that into a silent false negative and the
    # test would have gone red for a reason that had nothing to do with the code under it.
    stale_to = 50 + voicetrain.PLATEAU_EPOCHS + 5
    best_at_50 = {e: 20.0 - e * 0.05 for e in range(1, 51)}       # improving to epoch 50
    flat_after = {e: 17.6 for e in range(51, stale_to + 5)}        # …then nothing better
    curve["value"] = _curve({**best_at_50, **flat_after})
    p = voicetrain.plateau_check(None, "x", epoch=stale_to)
    assert p, "it never noticed the run had stopped learning"
    assert p["best_epoch"] == 50
    assert p["stale_epochs"] >= voicetrain.PLATEAU_EPOCHS


def test_plateau_never_fires_early(curve):
    """A slow start is not a plateau. Judging before PLATEAU_MIN_EPOCH would kill runs that
    simply had not got going yet."""
    slow = {e: 20.0 for e in range(1, 40)}        # flat from the very beginning
    curve["value"] = _curve(slow)
    for e in range(1, voicetrain.PLATEAU_MIN_EPOCH):
        assert not voicetrain.plateau_check(None, "x", epoch=e), f"stopped at epoch {e}"


def test_plateau_tolerates_a_long_slow_climb(curve):
    """RVC improves in lumpy steps. A new best every ~20 epochs is slow, not finished —
    PLATEAU_EPOCHS (30) must be generous enough not to shoot it."""
    lumpy = {}
    v = 20.0
    for e in range(1, 121):
        if e % 20 == 0:
            v -= 0.3            # a new best, every 20 epochs
        lumpy[e] = v
    curve["value"] = _curve(lumpy)
    assert not voicetrain.plateau_check(None, "x", epoch=115)


def test_plateau_is_not_divergence(curve):
    """They must not be confused. A plateau is the loss FLATTENING (success — keep
    everything). Divergence is the loss going UP and staying there (the discriminator won).
    A flat run must never be reported as diverged."""
    stale_to = 50 + voicetrain.PLATEAU_EPOCHS + 5
    flat = {e: 20.0 - e * 0.05 for e in range(1, 51)}
    flat.update({e: 17.6 for e in range(51, stale_to + 5)})
    curve["value"] = _curve(flat)
    assert voicetrain.plateau_check(None, "x", epoch=stale_to)
    assert not voicetrain.divergence_check(None, "x", epoch=85)


def test_collapsed_curve_is_diverged_not_plateaued(curve):
    """A sustained increase in loss is divergence, not a plateau."""
    curve["value"] = _curve({**PRE_DIVERGENCE_CURVE, **DIVERGED_CURVE})
    assert voicetrain.divergence_check(None, 'Test_Voice_1_v1', epoch=34)


# ── the two grids: what every test above was quietly assuming ────────────────
#
# Every test above hands the checks a curve via the `curve` fixture, whose _curve() gives
# EVERY epoch a smoothed value. Real tfevents do not, and that gap is where both guards
# actually died: loss_curve() looked the smoothed value up by an EXACT step match, but
# Applio writes the raw loss once per epoch (every 182 steps) and the smoothed loss every
# 50 STEPS. The grids coincide every lcm(182, 50) = 4550 steps — one epoch in 25.
#
# With 182 steps per epoch and smoothing every 50 steps, the grids align once every 25
# epochs. The sparse fixture exercises that shape through loss_curve() directly.

STEPS_PER_EPOCH = 182          # synthetic steps-per-epoch fixture
SMOOTH_EVERY = 50       # Applio's loss_avg_50 cadence, in STEPS


class _Cfg:
    """The two attributes loss_curve() actually touches."""

    def __init__(self, root):
        self.root = Path(root)

    def model_dir(self, name):
        return self.root / name


def _tfevents(by_epoch: dict, spe: int = STEPS_PER_EPOCH) -> dict:
    """A tfevents dict shaped like the real thing: the raw loss once per EPOCH (at the
    step that epoch ends on), the smoothed loss every 50 STEPS.

    A smoothed sample taken at step s is a trailing average of the steps around s, so it
    reflects the epoch s falls INSIDE — not the last epoch to have finished. Modeling it
    the other way (floor to the previous epoch's value) is what a moving average very
    deliberately does not do, and a test built on that would be testing a fiction."""
    raw = [(e * spe, v) for e, v in sorted(by_epoch.items())]
    last_step = max(s for s, _ in raw)
    smooth = []
    for step in range(SMOOTH_EVERY, last_step + 1, SMOOTH_EVERY):
        inside = max(1, -(-step // spe))                  # ceil: the epoch step `s` is in
        if inside in by_epoch:
            smooth.append((step, by_epoch[inside]))
    return {"loss/g/mel": raw, "loss_avg_50/g/mel": smooth}


@pytest.fixture
def tb(monkeypatch, tmp_path):
    """Let a test hand loss_curve() a real-shaped tfevents dict — no mocking of the
    function under test."""
    box = {}
    monkeypatch.setattr(voicetrain, "read_tb_scalars", lambda _d: box["value"])
    return box, _Cfg(tmp_path)


def test_every_epoch_gets_a_smoothed_value(tb):
    """THE BUG. Exact-step matching left 3 of 76 epochs with a smoothed value, and the
    chart's trend line, its ▲ marker, divergence_check and plateau_check all read that
    series. Every epoch has a smoothed sample within half an epoch of it; every epoch must
    get one."""
    box, cfg = tb
    box["value"] = _tfevents({e: 20.0 - e * 0.04 for e in range(1, 77)})
    lc = voicetrain.loss_curve(cfg, 'Test_Voice_1')
    got = [p for p in lc["curve"] if p["smooth"] is not None]
    assert len(lc["curve"]) == 76
    assert len(got) == 76, (
        f"only {len(got)} of 76 epochs carry a smoothed value "
        f"(epochs {[p['epoch'] for p in got]}) — the two grids are misaligned again")


def test_divergence_can_fire_at_all(tb):
    """Dense smoothed samples must let the divergence guard accumulate enough consecutive epochs."""
    box, cfg = tb
    box["value"] = _tfevents({**PRE_DIVERGENCE_CURVE, **DIVERGED_CURVE})
    assert voicetrain.loss_curve(cfg, 'Test_Voice_1_v1')["best_epoch"] == 25
    # divergence_check calls loss_curve(cfg, name) itself — same cfg, same fake events.
    d = voicetrain.divergence_check(cfg, 'Test_Voice_1_v1', epoch=34)
    assert d, "the divergence guard STILL cannot fire on a real-shaped curve"
    assert d["best_epoch"] == 25
    assert d["ratio"] > 2.0


def test_best_epoch_is_not_quantized_to_multiples_of_25(tb):
    """The ▲ could only ever land on 25, 50 or 75, so it could never say "your best was
    epoch 69". It has to be able to name any epoch."""
    box, cfg = tb
    losses = {e: 20.0 - e * 0.04 for e in range(1, 77)}
    losses[69] = 14.0                                    # the real minimum, nowhere near 25|50|75
    box["value"] = _tfevents(losses)
    assert voicetrain.loss_curve(cfg, 'Test_Voice_1')["best_epoch"] == 69


def test_a_small_dataset_still_gets_a_usable_series(tb):
    """When smoothing is coarser than epochs, missing samples stay None without dropping rows."""
    box, cfg = tb
    box["value"] = _tfevents({e: 18.0 - e * 0.02 for e in range(1, 31)}, spe=35)
    curve = voicetrain.loss_curve(cfg, 'test_voice_3')["curve"]
    got = [p for p in curve if p["smooth"] is not None]
    assert len(got) >= voicetrain.DIVERGENCE_EPOCHS, (
        f"only {len(got)} of 30 epochs resolved — too few for divergence_check to ever "
        f"see {voicetrain.DIVERGENCE_EPOCHS} of them")


def test_a_gap_in_the_smoothed_series_is_not_papered_over(tb):
    """Nearest-sample, but only within half an epoch. If the smoothed series genuinely has
    no sample near an epoch, that epoch gets None and the guards decline to judge it —
    which is very different from silently attaching a value from ten epochs ago."""
    box, cfg = tb
    ev = _tfevents({e: 18.0 for e in range(1, 21)})
    hole = set(range(10 * STEPS_PER_EPOCH - 400, 10 * STEPS_PER_EPOCH + 400))
    ev["loss_avg_50/g/mel"] = [(s, v) for s, v in ev["loss_avg_50/g/mel"] if s not in hole]
    box["value"] = ev
    at = {p["epoch"]: p["smooth"] for p in voicetrain.loss_curve(cfg, "x")["curve"]}
    assert at[10] is None, "attached a stale smoothed value across a real gap"
    assert at[5] is not None and at[15] is not None      # …and the rest still resolve


# ── Resume must be able to overrule a plateau ───────────────────────────────
#
# A plateau is advisory. On resume, `since` starts a fresh grace window so the first epoch
# does not repeat advice based on staleness recorded before the resume.

def test_resume_is_not_instantly_re_plateaued(curve):
    """The hole. A run whose best was epoch 50 goes stale past the window. Press Resume: the
    next epoch reports, staleness is one higher, and without a fresh window it speaks again on
    the very first epoch back — telling him the thing he just overruled."""
    # ⚠️ DERIVED FROM PLATEAU_EPOCHS, NEVER A LITERAL — see the note in the fires-when-stale test.
    stale_to = 50 + voicetrain.PLATEAU_EPOCHS + 1
    curve["value"] = _curve({**{e: 20.0 - e * 0.05 for e in range(1, 51)},
                             **{e: 17.6 for e in range(51, stale_to + 5)}})
    assert voicetrain.plateau_check(None, "x", epoch=stale_to), "sanity: it does plateau"
    assert not voicetrain.plateau_check(None, "x", epoch=stale_to, since=stale_to - 1), (
        "Resume was overruled on the very first epoch back — the button does nothing"
    )


def test_resume_grace_is_a_full_window_and_then_expires(curve):
    """The user gets a full PLATEAU_EPOCHS to be proved right. If the run really has
    stopped learning, it stops again — Resume buys a fair hearing, not immunity."""
    flat = {**{e: 20.0 - e * 0.05 for e in range(1, 51)},
            **{e: 17.6 for e in range(51, 200)}}
    curve["value"] = _curve(flat)
    resumed_at = 85
    last = resumed_at + voicetrain.PLATEAU_EPOCHS - 1
    assert not voicetrain.plateau_check(None, "x", epoch=last, since=resumed_at)
    p = voicetrain.plateau_check(None, "x", epoch=last + 1, since=resumed_at)
    assert p, "the grace window never expired — a dead run would train forever"
    assert p["stale_epochs"] == last + 1 - 50, "the evidence must report TRUE staleness"


def test_a_resumed_run_that_improves_is_left_alone(curve):
    """And the happy path that justifies the whole grace window: he overrules the stop, and
    the run turns out to have more in it. It keeps setting new bests, so the ordinary
    staleness clock keeps resetting and the grace never even has to be invoked."""
    better = {**{e: 20.0 - e * 0.05 for e in range(1, 51)},
              **{e: 17.6 for e in range(51, 90)},
              **{e: 17.6 - (e - 89) * 0.02 for e in range(90, 130)}}   # improving again
    curve["value"] = _curve(better)
    assert not voicetrain.plateau_check(None, "x", epoch=125, since=85)


# ── The plateau is advisory, not a stop condition ────────────────────────────


def test_a_plateau_does_not_stop_the_run():
    """A plateau remains advisory and must not stop a run."""
    src = Path(voicetrain.__file__).read_text(encoding="utf-8")
    i = src.index("                if p:")
    branch = src[i:i + 1400]
    assert "stop_train" not in branch, (
        "the plateau branch stops the training again; it must report the signal and keep going.")
    assert 'return "done"' not in branch, "the plateau branch ends the run again"
    assert '"type": "log"' in branch and "No new best" in branch, (
        "removing the stop also removed the advice - he asked for the message, not silence")


def test_the_plateau_advice_fires_exactly_once():
    """Once per run, not once per epoch. `plateau_check` is only called while `plateaued` is
    empty, and the branch fills it before emitting - so the guard that stops the re-check is the
    same one that stops the log spam. If those are ever separated, this is the reminder."""
    src = Path(voicetrain.__file__).read_text(encoding="utf-8")
    i = src.index("            if not diverged and not plateaued:")
    branch = src[i:i + 1600]
    assert branch.index("plateaued.update(p)") < branch.index('"type": "log"'), (
        "the advice is emitted before the flag is set, so it repeats every epoch")


def test_the_plateau_threshold_is_not_eager():
    """30 epochs without a new best was normal mid-descent for a lumpy RVC curve, and it cut a
    run short that was still improving. Doubled at 8.8. Pinned so a future 'tidy-up' that halves
    it again has to argue with this line first."""
    assert voicetrain.PLATEAU_EPOCHS >= 60, "the plateau window regressed below its tested minimum"
    assert voicetrain.PLATEAU_MIN_EPOCH >= 40, "a slow start is still not a plateau"


# ── 8.8.4: divergence ADVISES too ─────────────────────────────────────────────


def test_a_divergence_does_not_stop_the_run():
    """A divergence signal remains advisory and must not stop a run."""
    src = Path(voicetrain.__file__).read_text(encoding="utf-8")
    i = src.index("                if d:")
    branch = src[i:i + 1600]
    assert "stop_train" not in branch, "the divergence branch stops the training again"
    assert 'return "diverged"' not in branch, "the divergence branch ends the run again"
    assert "DIVERGED" in branch, "removing the stop also removed the warning"


def test_exactly_one_stop_survives_and_it_is_the_users():
    """Cancel. Nothing else in `follow_train` may end a run on the user's behalf."""
    src = Path(voicetrain.__file__).read_text(encoding="utf-8")
    start = src.index("def follow_train(")
    nxt = src.index(chr(10) + "def ", start + 10)
    body = src[start:nxt]
    assert body.count("stop_train(job.pgid") == 1, (
        f"{body.count('stop_train(job.pgid')} auto-stops in follow_train; there must be exactly "
        "one, and it must be the Cancel branch")
    i = body.index("stop_train(job.pgid")
    assert "job.cancel.is_set()" in body[max(0, i - 700):i], "the surviving stop is not the Cancel"


def test_a_diverged_run_still_refuses_to_auto_deploy():
    """🔴 THE PROTECTION THAT REMOVING THE STOP ALMOST DELETED IN SILENCE.

    Deploy takes the LATEST weight, which after a collapse is the worst one the run produced. That
    was guarded implicitly: `follow_train` returned "diverged" and the completion path never ran.
    Taking the stop out removes that return — so the flag has to carry it instead, or the guard
    quietly becomes "collapse, then ship the collapse".
    """
    src = Path(voicetrain.__file__).read_text(encoding="utf-8")
    i = src.index("outcome = follow_train(")
    assert 'if outcome != "canceled" and job.diverged:' in src[i:i + 1200], (
        "a diverged run no longer reaches the diverged branch, so it will auto-deploy the "
        "post-collapse checkpoint")
    assert 'outcome = "diverged"' in src[i:i + 1200]
