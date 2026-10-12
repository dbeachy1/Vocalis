"""Answer prompts in another process's console by typing into it (Windows only, stdlib only).

The installer test needs to answer setup's Taproom owner prompts ("Owner handle: ", "Owner password: ",
"Confirm password: "). The password prompts read raw keystrokes from a real terminal, so the answers
cannot be piped: they must arrive as key presses. This attaches to the console of the given process,
watches the line the cursor is on, and when it ends with the next expected prompt writes that answer
as key events followed by Enter. It works on a hidden desktop because nothing here needs focus.

The answers come from a JSON file ([[prompt, answer], ...], test values only), never from the command
line or the environment, and are never printed. The screen text this reads is never logged either:
it can hold the echoed handle. Only prompt names and timings are reported.

Usage: python console_keys.py --pid PID --answers FILE --timeout SECONDS [--poll 0.5]
Exit code: 0 every prompt answered; 2 the console went away; 3 timed out waiting for a prompt.
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import sys
import time

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

GENERIC_READ, GENERIC_WRITE = 0x80000000, 0x40000000
FILE_SHARE_READ, FILE_SHARE_WRITE = 1, 2
OPEN_EXISTING = 3
KEY_EVENT = 1
VK_RETURN = 0x0D
INVALID_HANDLE = ctypes.c_void_p(-1).value


class COORD(ctypes.Structure):
    _fields_ = [("X", wt.SHORT), ("Y", wt.SHORT)]


class SMALL_RECT(ctypes.Structure):
    _fields_ = [("Left", wt.SHORT), ("Top", wt.SHORT), ("Right", wt.SHORT), ("Bottom", wt.SHORT)]


class CONSOLE_SCREEN_BUFFER_INFO(ctypes.Structure):
    _fields_ = [("dwSize", COORD), ("dwCursorPosition", COORD), ("wAttributes", wt.WORD),
                ("srWindow", SMALL_RECT), ("dwMaximumWindowSize", COORD)]


class KEY_EVENT_RECORD(ctypes.Structure):
    _fields_ = [("bKeyDown", wt.BOOL), ("wRepeatCount", wt.WORD), ("wVirtualKeyCode", wt.WORD),
                ("wVirtualScanCode", wt.WORD), ("uChar", wt.WCHAR), ("dwControlKeyState", wt.DWORD)]


class INPUT_RECORD(ctypes.Structure):
    class _Event(ctypes.Union):
        _fields_ = [("KeyEvent", KEY_EVENT_RECORD), ("_pad", ctypes.c_byte * 16)]
    _fields_ = [("EventType", wt.WORD), ("Event", _Event)]


kernel32.AttachConsole.argtypes = [wt.DWORD]
kernel32.CreateFileW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p, wt.DWORD, wt.DWORD, wt.HANDLE]
kernel32.CreateFileW.restype = wt.HANDLE
kernel32.GetConsoleScreenBufferInfo.argtypes = [wt.HANDLE, ctypes.POINTER(CONSOLE_SCREEN_BUFFER_INFO)]
kernel32.ReadConsoleOutputCharacterW.argtypes = [wt.HANDLE, wt.LPWSTR, wt.DWORD, COORD, ctypes.POINTER(wt.DWORD)]
kernel32.WriteConsoleInputW.argtypes = [wt.HANDLE, ctypes.POINTER(INPUT_RECORD), wt.DWORD, ctypes.POINTER(wt.DWORD)]
kernel32.CloseHandle.argtypes = [wt.HANDLE]


def open_console(name: str) -> wt.HANDLE:
    handle = kernel32.CreateFileW(name, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, None,
                                  OPEN_EXISTING, 0, None)
    if not handle or handle == INVALID_HANDLE:
        raise OSError(f"cannot open {name}: Win32 error {ctypes.get_last_error()}")
    return handle


def cursor_line(out: wt.HANDLE) -> str | None:
    """The text of the line the cursor is on, or None when the console is gone."""
    info = CONSOLE_SCREEN_BUFFER_INFO()
    if not kernel32.GetConsoleScreenBufferInfo(out, ctypes.byref(info)):
        return None
    width = info.dwSize.X
    buffer = ctypes.create_unicode_buffer(width)
    read = wt.DWORD()
    if not kernel32.ReadConsoleOutputCharacterW(out, buffer, width, COORD(0, info.dwCursorPosition.Y),
                                                ctypes.byref(read)):
        return None
    return buffer.value[:read.value].rstrip()


kernel32.GetConsoleProcessList.argtypes = [ctypes.POINTER(wt.DWORD), wt.DWORD]


def others_attached() -> bool:
    """True while some process other than this one is still attached to the console. Attached, this
    helper keeps the console alive, so a console whose program finished without ever showing the
    prompt (a rerun that adopts an existing owner) would never close and the installer waiting on
    it would hang (seen October 9, 2026). The helper leaves as soon as it is alone."""
    ids = (wt.DWORD * 16)()
    return kernel32.GetConsoleProcessList(ids, 16) > 1


def key_records(text: str) -> ctypes.Array:
    records = []
    for char in text + "\r":
        for down in (True, False):
            record = INPUT_RECORD()
            record.EventType = KEY_EVENT
            key = record.Event.KeyEvent
            key.bKeyDown = down
            key.wRepeatCount = 1
            key.wVirtualKeyCode = VK_RETURN if char == "\r" else 0
            key.uChar = char
            records.append(record)
    return (INPUT_RECORD * len(records))(*records)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--answers", required=True)
    parser.add_argument("--timeout", type=float, required=True, help="seconds to wait for EACH prompt")
    parser.add_argument("--poll", type=float, default=0.5)
    args = parser.parse_args()
    with open(args.answers, encoding="utf-8") as stream:
        answers = [(str(prompt), str(answer)) for prompt, answer in json.load(stream)]

    kernel32.FreeConsole()
    if not kernel32.AttachConsole(args.pid):
        print(f"cannot attach to the console of pid {args.pid}: Win32 error {ctypes.get_last_error()}",
              file=sys.stderr, flush=True)
        return 2
    conin, conout = open_console("CONIN$"), open_console("CONOUT$")
    try:
        for prompt, answer in answers:
            deadline = time.monotonic() + args.timeout
            started = time.monotonic()
            while True:
                line = cursor_line(conout)
                if line is None:
                    return 2
                if line.endswith(prompt.rstrip()):
                    break
                if not others_attached():
                    sys.__stderr__.write(f"the console's program finished before {prompt.strip()!r} appeared\n")
                    return 2
                if time.monotonic() > deadline:
                    return 3
                time.sleep(args.poll)
            records = key_records(answer)
            written = wt.DWORD()
            if not kernel32.WriteConsoleInputW(conin, records, len(records), ctypes.byref(written)):
                return 2
            # Wait for the cursor to leave the prompt line, so the next prompt is not mistaken for this one.
            while (cursor_line(conout) or "").endswith(prompt.rstrip()) and time.monotonic() < deadline:
                time.sleep(args.poll)
            # Report on the real stderr (the attached console is not ours to write to).
            sys.__stderr__.write(f"answered {prompt.strip()!r} after {time.monotonic() - started:.0f} s\n")
        return 0
    finally:
        kernel32.CloseHandle(conin)
        kernel32.CloseHandle(conout)
        kernel32.FreeConsole()


if __name__ == "__main__":
    sys.exit(main())
