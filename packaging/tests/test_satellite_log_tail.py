"""Tests of packaging/windows/satellite-log-tail.ps1, the program behind the tray icon's "Tail the satellite log" item
(October 11, 2026; Doug: "pop up in a new command prompt, simply tailing the log. And if I restart the satellite, keep
that tail open, okay? Don't close it.").

Windows only (the script is Windows PowerShell 5.1 and uses a Windows file-identity call). Each test starts the script as
a child process with its output piped (no window), waits for the line it expects with a bounded deadline (an explicit
completion signal, never a sleep), and then ends the child by its PID. The deadline is a safety net for a hang, not part
of the proof: a test that reaches it fails with everything the script printed so far.
"""
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "windows" / "satellite-log-tail.ps1"
POWERSHELL = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
CREATE_NO_WINDOW = 0x08000000
DEADLINE_SECONDS = 90  # a safety net against a hang; the waits below return as soon as the line is there

pytestmark = pytest.mark.skipif(sys.platform != "win32" or not POWERSHELL.is_file(), reason="Windows PowerShell 5.1 is required")


class Tail:
    """One running copy of the script. Lines are read by a thread so a wait never blocks on the pipe."""

    def __init__(self, path, lines=None, title=None, cwd=None):
        args = [str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT), "-Path", str(path), "-PollMilliseconds", "50"]
        if lines is not None:
            args += ["-Lines", str(lines)]
        if title is not None:
            args += ["-Title", title]
        self.process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        creationflags=CREATE_NO_WINDOW, cwd=cwd)
        self.seen = []
        self._queue = queue.Queue()
        self._errors = []
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._pump_errors, daemon=True).start()

    def _pump(self):
        for raw in iter(self.process.stdout.readline, b""):
            self._queue.put(raw.decode("utf-8").rstrip("\r\n"))
        self._queue.put(None)

    def _pump_errors(self):
        for raw in iter(self.process.stderr.readline, b""):
            self._errors.append(raw.decode("utf-8", "replace"))

    def wait_for(self, wanted):
        """Reads lines until one equals wanted; returns the lines read before it. Fails with everything seen on a hang."""
        before = []
        deadline = time.monotonic() + DEADLINE_SECONDS
        while True:
            remaining = deadline - time.monotonic()
            try:
                line = self._queue.get(timeout=max(remaining, 0.01))
            except queue.Empty:
                line = "<deadline>"
            if line is None:
                pytest.fail(f"the script ended before printing {wanted!r}; seen {self.seen}; errors {self._errors}")
            if line == "<deadline>":
                pytest.fail(f"no {wanted!r} within {DEADLINE_SECONDS} s; seen {self.seen}; errors {self._errors}")
            self.seen.append(line)
            if line == wanted:
                return before
            before.append(line)

    def stop(self):
        """Ends the child by its PID. The script has no children of its own."""
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=30)


@pytest.fixture
def tails():
    started = []

    def start(*args, **kwargs):
        tail = Tail(*args, **kwargs)
        started.append(tail)
        return tail

    yield start
    for tail in started:
        tail.stop()


def _write(path, text, mode="wb"):
    with open(path, mode) as handle:
        handle.write(text.encode("utf-8"))


def test_it_prints_the_last_fifty_lines_of_an_existing_file_and_no_earlier_ones(tails, tmp_path):
    log = tmp_path / "satellite.log"
    _write(log, "".join(f"line {n:03d}\n" for n in range(1, 121)))
    tail = tails(log)
    before = tail.wait_for("line 120")
    assert before == [f"line {n:03d}" for n in range(71, 120)]


def test_a_shorter_file_is_printed_whole_and_the_count_can_be_chosen(tails, tmp_path):
    log = tmp_path / "satellite.log"
    _write(log, "alpha\nbeta\ngamma")  # the last line has no line break yet: it is held back
    tail = tails(log, lines=2)
    assert tail.wait_for("beta") == []
    _write(log, "\n", "ab")
    assert tail.wait_for("gamma") == []


def test_lines_are_shown_as_written_in_utf8(tails, tmp_path):
    log = tmp_path / "satellite.log"
    text = "gr\u00fc\u00dfe \u2603 \u65e5\u672c\u8a9e \U0001f600"
    _write(log, text + "\n")
    assert tails(log).wait_for(text) == []


def test_lines_written_later_are_printed_as_they_arrive_with_windows_line_breaks_removed(tails, tmp_path):
    log = tmp_path / "satellite.log"
    _write(log, "first\n")
    tail = tails(log)
    tail.wait_for("first")
    _write(log, "second\r\n", "ab")
    tail.wait_for("second")
    _write(log, "third\n", "ab")
    tail.wait_for("third")


def test_it_continues_with_the_new_file_after_the_old_one_is_renamed_away_even_when_the_new_one_is_longer(tails, tmp_path):
    log = tmp_path / "satellite.log"
    _write(log, "old one\nold two\n")
    tail = tails(log)
    tail.wait_for("old two")
    # The satellite's rotation: the last lines go to the old file, the old file is renamed, a new one takes the name. The
    # new file is longer than the old one, so a length comparison alone could not tell that it is a different file.
    _write(log, "old last\n", "ab")
    os.rename(log, tmp_path / "satellite.2026-10-11_12-00-00.log")
    _write(log, "".join(f"new {n}\n" for n in range(1, 8)))
    before = tail.wait_for("new 7")
    assert before == ["old last", "The log file was replaced (rotated); following the new file from its start.", "new 1", "new 2", "new 3", "new 4", "new 5", "new 6"]


def test_a_file_that_becomes_shorter_is_read_from_its_start(tails, tmp_path):
    log = tmp_path / "satellite.log"
    _write(log, "a long first line to be cut away\nsecond long line to be cut away\n")
    tail = tails(log)
    tail.wait_for("second long line to be cut away")
    _write(log, "short\n")  # the same file, emptied and written again
    before = tail.wait_for("short")
    assert before == ["The log file became shorter; following it from its start."]


def test_a_missing_file_is_announced_once_and_followed_when_it_appears(tails, tmp_path):
    log = tmp_path / "logs" / "satellite.log"  # the folder does not exist either
    tail = tails(log)
    announcement = tail.wait_for(f"The log file does not exist yet: {log} - waiting for it.")
    assert announcement == []
    (tmp_path / "logs").mkdir()
    _write(log, "it appeared\n")
    tail.wait_for("it appeared")
    _write(log, "and it is followed\n", "ab")
    tail.wait_for("and it is followed")
    assert [line for line in tail.seen if line.startswith("The log file does not exist")] == [f"The log file does not exist yet: {log} - waiting for it."]


def test_a_file_that_is_there_but_cannot_be_opened_is_said_so_and_followed_once_it_can(tails, tmp_path):
    """A log another program holds without sharing is not a missing log: the viewer says it cannot be opened, waits, and
    then shows its last lines once, never "does not exist"."""
    import ctypes
    from ctypes import wintypes

    log = tmp_path / "satellite.log"
    _write(log, "one\ntwo\n")
    create = ctypes.WinDLL("kernel32", use_last_error=True).CreateFileW
    create.restype = wintypes.HANDLE
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    close = ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle
    close.argtypes = [wintypes.HANDLE]
    held = create(str(log), 0x80000000, 0, None, 3, 0, None)  # GENERIC_READ, no sharing, OPEN_EXISTING
    assert held not in (None, wintypes.HANDLE(-1).value), ctypes.get_last_error()
    try:
        tail = tails(log)
        tail.wait_for(f"The log file cannot be opened right now (in use, or no access): {log} - waiting for it.")
    finally:
        close(held)
    tail.wait_for("two")
    _write(log, "three\n", "ab")
    tail.wait_for("three")
    assert [line for line in tail.seen if "does not exist" in line] == []
    assert tail.seen.count("one") == 1 and tail.seen.count("two") == 1


def test_an_open_log_window_does_not_keep_the_folder_it_was_started_in(tails, tmp_path):
    """The tray icon starts the viewer in the satellite's program folder. Windows cannot remove a folder that is a
    running program's current folder, so the viewer leaves it at once: an uninstall with a log window open can still
    remove the program folder."""
    log = tmp_path / "logs" / "satellite.log"
    log.parent.mkdir()
    _write(log, "running\n")
    program_folder = tmp_path / "program"
    program_folder.mkdir()
    tail = tails(log, cwd=str(program_folder))
    tail.wait_for("running")
    os.rmdir(program_folder)  # raises PermissionError while a running program still sits in it
    assert not program_folder.exists()
    _write(log, "still following\n", "ab")
    tail.wait_for("still following")


def test_it_never_blocks_the_satellite_from_appending_renaming_or_deleting_the_file_it_follows(tails, tmp_path):
    log = tmp_path / "satellite.log"
    _write(log, "one\n")
    tail = tails(log)
    tail.wait_for("one")
    # Every one of these fails with a sharing violation if the script holds the file without allowing it.
    _write(log, "two\n", "ab")
    tail.wait_for("two")
    moved = tmp_path / "satellite.moved.log"
    os.rename(log, moved)
    os.remove(moved)
    # The name is free again as soon as the script lets the deleted file go, and the script then follows the new file.
    tail.wait_for(f"The log file does not exist yet: {log} - waiting for it.")
    _write(log, "recreated\n")
    tail.wait_for("recreated")


def test_the_console_title_is_set_when_a_window_exists_and_never_fails_without_one(tails, tmp_path):
    log = tmp_path / "satellite.log"
    _write(log, "x\n")
    tail = tails(log, title="Vocalis Satellite log (test word)")
    tail.wait_for("x")
    assert tail.process.poll() is None


def test_the_script_is_ascii_and_has_no_pause_at_the_end():
    raw = SCRIPT.read_bytes()
    text = raw.decode("ascii")  # raises when a non-ASCII byte is there
    assert "Read-Host" not in text and "-PauseAtEnd" not in text and "Pause" not in text
