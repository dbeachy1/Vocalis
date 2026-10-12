"""Preserve worker crash files across test runs and report leftover evidence at the end of the suite. A native worker crash may leave no Python traceback, so the per-worker file is the useful diagnostic record."""
import time

import conftest


def test_a_dead_workers_file_is_preserved_not_truncated(tmp_path):
    """The defect, stated as a run sequence: die, then start again, then look."""
    (tmp_path / "gw3.txt").write_text("Thread 0x1234 (most recent call first):\n  File ...\n",
                                      encoding="utf-8")

    fh = conftest._open_crash_file(tmp_path, "gw3")     # the next run boots its gw3
    fh.close()

    kept = [p for p in tmp_path.glob("gw3-*.txt")]
    assert len(kept) == 1, f"the dead worker's file was not preserved: {sorted(tmp_path.iterdir())}"
    assert "most recent call first" in kept[0].read_text(encoding="utf-8"), (
        "the file was preserved by name but its contents were lost")
    assert (tmp_path / "gw3.txt").read_text(encoding="utf-8") == "", (
        "this run's own file should be fresh and empty")


def test_an_empty_leftover_is_preserved_too(tmp_path):
    """🔴 EMPTY IS THE ANSWER, NOT THE ABSENCE OF ONE — it says 'killed, not faulted'. A rule that
    kept only non-empty files would throw away the exact finding this mechanism has produced
    every time it has fired."""
    (tmp_path / "gw7.txt").write_bytes(b"")

    conftest._open_crash_file(tmp_path, "gw7").close()

    kept = [p for p in tmp_path.glob("gw7-*.txt")]
    assert len(kept) == 1, f"an empty leftover was dropped: {sorted(tmp_path.iterdir())}"
    assert kept[0].stat().st_size == 0


def test_a_clean_exit_only_unlinks_its_own_file(tmp_path):
    """The second half of the old bug: the clean-run unlink must not reach preserved evidence.

    `pytest_sessionfinish` removes the file THIS worker opened when it is empty. Preserved names
    carry a stamp and a dash; live names do not, which is what keeps the two apart.
    """
    (tmp_path / "gw1.txt").write_bytes(b"")
    conftest._open_crash_file(tmp_path, "gw1").close()
    preserved = next(iter(tmp_path.glob("gw1-*.txt")))

    # What sessionfinish does on a clean exit, applied to the live file only.
    live = tmp_path / "gw1.txt"
    if live.stat().st_size == 0:
        live.unlink()

    assert preserved.exists(), "a clean run deleted evidence preserved from an earlier one"
    assert not live.exists()


def test_two_deaths_in_the_same_second_both_survive(tmp_path):
    """The stamp is a second, and a preserve that collided would silently overwrite the older."""
    (tmp_path / "gw2.txt").write_text("first", encoding="utf-8")
    conftest._open_crash_file(tmp_path, "gw2").close()
    first = next(iter(tmp_path.glob("gw2-*.txt")))
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(first.stat().st_mtime))

    second = tmp_path / "gw2.txt"
    second.write_text("second", encoding="utf-8")
    import os
    os.utime(second, (first.stat().st_atime, first.stat().st_mtime))   # same second, deliberately
    conftest._open_crash_file(tmp_path, "gw2").close()

    bodies = sorted(p.read_text(encoding="utf-8") for p in tmp_path.glob(f"gw2-{stamp}*.txt"))
    assert bodies == ["first", "second"], f"a same-second collision lost one: {bodies}"


def test_preserved_evidence_is_pruned_by_age_and_never_by_size(tmp_path):
    """A killed run leaves one file per worker, so this cannot accumulate forever — but the clock
    is the only thing allowed to bin them."""
    old_empty = tmp_path / "gw4-20260101-000000.txt"
    old_empty.write_bytes(b"")
    old_full = tmp_path / "gw5-20260101-000000.txt"
    old_full.write_text("stack", encoding="utf-8")
    fresh = tmp_path / "gw6-20260827-120000.txt"
    fresh.write_bytes(b"")
    stale = time.time() - conftest._CRASH_KEEP_DAYS * 86400 - 60
    for p in (old_empty, old_full):
        import os
        os.utime(p, (stale, stale))

    assert conftest._prune_crash_files(tmp_path) == 2
    assert not old_empty.exists() and not old_full.exists()
    assert fresh.exists(), "a fresh empty file was pruned — empty is evidence, not litter"


def test_pruning_cannot_reach_a_file_any_live_run_could_own(tmp_path):
    """🔴 THE AGE IS THE GUARD, and it has to be, because a live-named `gw3.txt` can belong to
    a CONCURRENT suite — two runs on one box is not hypothetical. `--session-timeout=600` bounds a
    run at ten minutes, so anything younger than the keep window is left strictly alone, live name
    or preserved."""
    import os
    fresh_live = tmp_path / "gw3.txt"                       # this run's own, open right now
    fresh_live.write_bytes(b"")
    fresh_kept = tmp_path / "gw8-20260827-120000.txt"
    fresh_kept.write_text("stack", encoding="utf-8")
    recent = time.time() - 9 * 60                           # a run that started nine minutes ago
    os.utime(fresh_kept, (recent, recent))

    assert conftest._prune_crash_files(tmp_path) == 0
    assert fresh_live.exists(), "the pruner reached a file a live worker could be writing into"
    assert fresh_kept.exists(), "recent evidence was binned"


def test_a_fortnight_old_live_name_is_binned(tmp_path):
    """The other half: a stale `gwN.txt` from an older worker count is never re-opened by any
    worker, so nothing preserves it and the end-of-run report would name it forever. No run lives
    for a fortnight, so age settles it."""
    import os
    stale_live = tmp_path / "gw24.txt"                      # a leftover from a `-n 32` era
    stale_live.write_bytes(b"")
    old = time.time() - conftest._CRASH_KEEP_DAYS * 86400 - 60
    os.utime(stale_live, (old, old))

    assert conftest._prune_crash_files(tmp_path) == 1
    assert not stale_live.exists()


def test_the_run_says_what_was_left_behind(tmp_path, capsys):
    """Nobody goes looking in `temp/`. The controller has to print it, and it has to say which
    of the two answers an empty file is."""
    (tmp_path / "gw3.txt").write_bytes(b"")
    (tmp_path / "gw9-20260827-174436.txt").write_text("Thread 0x1", encoding="utf-8")

    conftest._report_crash_evidence(tmp_path)

    out = capsys.readouterr().out
    assert "gw3.txt" in out and "gw9-20260827-174436.txt" in out, out
    assert "EMPTY = killed from outside" in out, "the empty file's meaning is the whole report"


def test_a_clean_directory_says_nothing(tmp_path, capsys):
    """A report that prints on every green run is one people learn to skip."""
    conftest._report_crash_evidence(tmp_path)
    assert capsys.readouterr().out == ""
