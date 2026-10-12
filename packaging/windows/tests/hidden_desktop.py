"""Run a program on Vocalis's shared hidden desktop and wait for it (Windows only, stdlib only).

Why: the installer tests click through a real Inno Setup wizard and a real setup console. Doing that
on Doug's desktop pops windows over his work (Doug, October 9, 2026: "we're going to be testing this
quite a bit going forward and we need to make it doable"). A program started on another desktop
draws there and nobody sees it; every window it opens (the wizard, the setup console it launches)
inherits that desktop.

One desktop, always the same name, opened (or created the first time) and reused: Windows slows down
as desktops pile up, so none is ever made per run. The same rule as the Orbiter test link
(XRVesselsNG XRMMU/tools/testlink/testlink.py, which this mirrors).

A program on the hidden desktop cannot be seen, so a modal dialog nobody expected hangs it: callers
pass a timeout, and on timeout this kills the exact process it started (and only that one) and says
so. UI Automation works on the hidden desktop only from a process that is itself on it, which is why
the driver script runs there rather than here.

Usage: python hidden_desktop.py --timeout SECONDS -- program arg ...
Exit code: the program's own, or 124 on timeout.
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import subprocess
import sys

DESKTOP_NAME = "VocalisTestDesktop"
DESKTOP_ALL_ACCESS = 0x01FF
# No console window at all: on Windows 11 a NEW console window is handed to Windows Terminal, which
# lives on the visible desktop, so a console program started here would pop up on the user's screen
# (seen October 9, 2026). A program that needs a visible console on the hidden desktop must be started
# under conhost.exe, which draws its window where it runs.
CREATE_NO_WINDOW = 0x08000000
WAIT_TIMEOUT = 0x102
INFINITE = 0xFFFFFFFF

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32.OpenDesktopW.argtypes = [wt.LPCWSTR, wt.DWORD, wt.BOOL, wt.DWORD]
user32.OpenDesktopW.restype = wt.HANDLE
user32.CreateDesktopW.argtypes = [wt.LPCWSTR, wt.LPCWSTR, ctypes.c_void_p, wt.DWORD, wt.DWORD, ctypes.c_void_p]
user32.CreateDesktopW.restype = wt.HANDLE


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR), ("lpTitle", wt.LPWSTR),
                ("dwX", wt.DWORD), ("dwY", wt.DWORD), ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD),
                ("dwXCountChars", wt.DWORD), ("dwYCountChars", wt.DWORD), ("dwFillAttribute", wt.DWORD),
                ("dwFlags", wt.DWORD), ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
                ("lpReserved2", ctypes.c_void_p), ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE),
                ("hStdError", wt.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wt.HANDLE), ("hThread", wt.HANDLE), ("dwProcessId", wt.DWORD),
                ("dwThreadId", wt.DWORD)]


kernel32.CreateProcessW.argtypes = [wt.LPCWSTR, wt.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wt.BOOL, wt.DWORD,
                                    ctypes.c_void_p, wt.LPCWSTR, ctypes.POINTER(STARTUPINFOW),
                                    ctypes.POINTER(PROCESS_INFORMATION)]
kernel32.CreateProcessW.restype = wt.BOOL
kernel32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
kernel32.WaitForSingleObject.restype = wt.DWORD
kernel32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
kernel32.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
kernel32.CloseHandle.argtypes = [wt.HANDLE]


def shared_desktop() -> wt.HANDLE:
    """Open the shared desktop, creating it the first time. The handle is kept for this process's life."""
    handle = user32.OpenDesktopW(DESKTOP_NAME, 0, False, DESKTOP_ALL_ACCESS)
    if not handle:
        handle = user32.CreateDesktopW(DESKTOP_NAME, None, None, 0, DESKTOP_ALL_ACCESS, None)
    if not handle:
        raise OSError(f"could not open or create desktop {DESKTOP_NAME!r}: Win32 error {ctypes.get_last_error()}")
    return handle


def run(argv: list[str], timeout_s: float, cwd: str | None = None) -> int:
    desktop = shared_desktop()  # noqa: F841 - held open so the desktop outlives this call
    startup = STARTUPINFOW()
    startup.cb = ctypes.sizeof(STARTUPINFOW)
    startup.lpDesktop = f"WinSta0\\{DESKTOP_NAME}"
    info = PROCESS_INFORMATION()
    command = ctypes.create_unicode_buffer(subprocess.list2cmdline(argv))
    if not kernel32.CreateProcessW(None, command, None, None, False, CREATE_NO_WINDOW, None, cwd,
                                   ctypes.byref(startup), ctypes.byref(info)):
        raise OSError(f"CreateProcessW on {DESKTOP_NAME!r} failed: Win32 error {ctypes.get_last_error()}")
    try:
        print(f"started pid {info.dwProcessId} on the hidden desktop {DESKTOP_NAME!r}", flush=True)
        waited = kernel32.WaitForSingleObject(info.hProcess, int(timeout_s * 1000))
        if waited == WAIT_TIMEOUT:
            kernel32.TerminateProcess(info.hProcess, 124)
            kernel32.WaitForSingleObject(info.hProcess, 10000)
            print(f"timed out after {timeout_s:g} s; terminated pid {info.dwProcessId} (its own children are "
                  "not touched: the caller cleans up what it started)", flush=True)
            return 124
        code = wt.DWORD()
        kernel32.GetExitCodeProcess(info.hProcess, ctypes.byref(code))
        return int(code.value)
    finally:
        kernel32.CloseHandle(info.hThread)
        kernel32.CloseHandle(info.hProcess)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--timeout", type=float, required=True)
    parser.add_argument("--cwd")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("give the program to run after --")
    return run(command, args.timeout, args.cwd)


if __name__ == "__main__":
    sys.exit(main())
