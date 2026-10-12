"""Contract tests for the Vocalis Satellite setup program in packaging/windows (design section 9, "Satellite setup program
and tray icon for Windows, and quieter setup output", added October 11, 2026).

Pure-text checks of vocalis-satellite.iss, build-satellite-installer.ps1 and the hidden-desktop driver run everywhere. The
checks that execute PowerShell functions (extracted from the build script with the PowerShell parser, so nothing else in it
runs) need Windows PowerShell 5.1 and are skipped without it. The checks that compile the script and read the icon out of
the built program need the pinned Inno Setup compiler (restored by `dotnet restore packaging/windows/Vocalis.InstallerBuild.csproj
--locked-mode`); they skip only when it is not restored. The compile happens in a staging copy of the few files the script
packages, with a stand-in tray program, so these tests do not depend on the tray project or on the tray icons' two other
looks existing. Nothing here runs a setup program (the wizard is driven separately, on the hidden desktop, by
packaging/windows/tests/drive_satellite_installer.ps1 against a test-identity build), starts Docker, or touches an install.
"""
from pathlib import Path
import ast
import ctypes
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess

import pytest

from test_windows_installer import DIGEST, DIGEST_CASES, WIZARD_PICTURES, WIZARD_LARGE, WIZARD_SMALL, _run_ps, _wizard_pictures_named

PACKAGING = Path(__file__).resolve().parents[1]
REPO = PACKAGING.parent
WINDOWS = PACKAGING / "windows"
ISS = WINDOWS / "vocalis-satellite.iss"
MAIN_ISS = WINDOWS / "vocalis.iss"
BUILD_PS1 = WINDOWS / "build-satellite-installer.ps1"
MAIN_BUILD_PS1 = WINDOWS / "build-installer.ps1"
DRIVER = WINDOWS / "tests" / "drive_satellite_installer.ps1"
ACCEPTANCE = WINDOWS / "tests" / "acceptance_satellite.py"
ICON = WINDOWS / "vocalis.ico"
ALLOWLIST = PACKAGING / "source-offer" / "allowlist.json"
ISCC = WINDOWS / "obj" / "packages" / "tools.innosetup" / "6.7.3" / "tools" / "ISCC.exe"
POWERSHELL = shutil.which("powershell.exe") if os.name == "nt" else None
needs_powershell = pytest.mark.skipif(POWERSHELL is None, reason="Windows PowerShell 5.1 is required")
needs_compiler = pytest.mark.skipif(
    os.name != "nt" or not ISCC.is_file(), reason="Windows only (the Linux test container sees ISCC.exe through the mount but cannot run it); or ""the pinned Inno Setup compiler is not restored (dotnet restore packaging/windows/Vocalis.InstallerBuild.csproj --locked-mode)")

REAL_GUID = "DEA56953-B5EE-4D67-9CDD-19506AE58EEC"
IMAGE = f"vocalis-satellite@sha256:{'a' * 64}"
ICON_NAMES = ["vocalis.ico", "vocalis-satellite-stopped.ico", "vocalis-satellite-nodocker.ico"]
OWN_FILES = [ISS, BUILD_PS1, DRIVER, Path(__file__)]


# ---- helpers ----------------------------------------------------------------------------------------------

def _iss_text() -> str:
    return ISS.read_text(encoding="ascii")


def _section(name: str) -> list:
    """The non-blank, non-comment lines of one section of the .iss."""
    current, lines = None, []
    for line in _iss_text().splitlines():
        header = re.match(r"^\s*\[(\w+)\]\s*$", line)
        if header:
            current = header.group(1)
            continue
        if current == name and line.strip() and not line.lstrip().startswith(";"):
            lines.append(line)
    return lines


def _files():
    """(source, flags, dest_name, check, line) for every [Files] entry."""
    entries = []
    for line in _section("Files"):
        source = re.match(r'^\s*Source:\s*"([^"]+)"', line).group(1)
        flags = re.search(r"Flags:\s*([^;]+)", line)
        dest = re.search(r'DestName:\s*"([^"]+)"', line)
        check = re.search(r"Check:\s*(\w+)", line)
        entries.append((source, (flags.group(1) if flags else "").split(), dest.group(1) if dest else None, check.group(1) if check else None, line))
    return entries


def _code() -> str:
    text = _iss_text()
    return text[text.index("\n[Code]") + 1:]


def _pascal(name: str) -> str:
    """The text of one top-level function or procedure of [Code] (its `end;` is the first one at column 0)."""
    # (a `forward;` declaration has no body and is skipped)
    found = re.search(rf"^(?:function|procedure) {re.escape(name)}\b(?![^\n]*; forward;)[^\n]*\n.*?^end;$", _code(), re.MULTILINE | re.DOTALL)
    assert found, f"{name} not found in the [Code] section"
    return found.group(0)


def _function_names() -> list:
    """Every function and procedure of [Code] that has a body (the externals and `forward;` declarations have none)."""
    return re.findall(r"^(?:function|procedure) (\w+)\b(?![^\n]*; forward;)[^\n]*\n(?!\s+external)", _code(), re.MULTILINE)


def _ordered(text: str, *needles: str) -> None:
    """Each needle occurs, and in the given order."""
    position = -1
    for needle in needles:
        found = text.find(needle, position + 1)
        assert found > position, f"{needle!r} is missing or out of order"
        position = found


def _test_guid(word: str) -> str:
    digest = hashlib.sha256(f"vocalis-satellite-test-identity:{word}".encode()).hexdigest()[:32].upper()
    return f"{digest[:8]}-{digest[8:12]}-{digest[12:16]}-{digest[16:20]}-{digest[20:32]}"


def _stage(root: Path, *, tray: bool = True) -> Path:
    """Copies the few files the script packages into a tree of the same shape, plus a stand-in tray program, and returns the
    staged .iss. The two tray looks are staged as copies of vocalis.ico when the real ones are not there (yet)."""
    windows = root / "packaging" / "windows"
    (root / "packaging" / "satellite").mkdir(parents=True)
    windows.mkdir(parents=True)
    shutil.copy(ISS, windows)
    shutil.copy(WINDOWS / "wizard-header-picture.iss", windows)  # included by the script's [Code]
    shutil.copy(WINDOWS / "satellite-log-tail.ps1", windows)  # one of the installed files
    shutil.copy(WINDOWS / "vocalis-control.ps1", windows)
    for name in ICON_NAMES:
        source = WINDOWS / name
        shutil.copy(source if source.is_file() else ICON, windows / name)
    for name in WIZARD_PICTURES:  # the wizard's own pictures: the compiler reads them from the script's folder
        shutil.copy(WINDOWS / name, windows / name)
    shutil.copy(PACKAGING / "windows-compose.ps1", root / "packaging")
    shutil.copy(PACKAGING / "satellite" / "satellite-setup.ps1", root / "packaging" / "satellite")
    shutil.copy(PACKAGING / "satellite" / "README.md", root / "packaging" / "satellite")
    shutil.copy(REPO / "LICENSE", root)
    if tray:
        (root / "VocalisSatelliteTray.exe").write_bytes(b"MZ stand-in tray program")
    return windows / "vocalis-satellite.iss"


def _iscc(iss: Path, out: Path, *, identity: str = "", output: bool = True, extra: tuple = ()) -> subprocess.CompletedProcess:
    env = dict(os.environ,
               VOCALIS_SATELLITE_VERSION="12.0.0-M1", VOCALIS_SATELLITE_VERSION_INFO="12.0.0.0", VOCALIS_SATELLITE_IMAGE=IMAGE,
               VOCALIS_SATELLITE_TRAY_EXE=str(iss.parents[2] / "VocalisSatelliteTray.exe"),
               VOCALIS_SATELLITE_TEST_IDENTITY=identity, VOCALIS_SATELLITE_TEST_GUID=_test_guid(identity) if identity else "")
    arguments = [str(ISCC), f"/O{out}" if output else "/O-", f"/FVocalis-Satellite-Setup-test-{identity or 'real'}", *extra, str(iss)]
    return subprocess.run(arguments, capture_output=True, text=True, timeout=180, env=env)


def _preprocessed(root: Path, identity: str) -> str:
    """The script after the preprocessor has run with this identity: ISPP's own SaveToFile writes it out."""
    iss = _stage(root)
    wrapper = iss.parent / "wrapper.iss"
    wrapper.write_text('#include "vocalis-satellite.iss"\n#expr SaveToFile(AddBackslash(SourcePath) + "preprocessed.iss")\n', encoding="ascii")
    result = _iscc(wrapper, root / "out", identity=identity, output=False)
    assert result.returncode == 0, result.stdout + result.stderr
    return (iss.parent / "preprocessed.iss").read_text(encoding="utf-8", errors="replace")


# ---- the text rules ---------------------------------------------------------------------------------------

def test_the_new_files_are_ascii_with_lf_endings_and_name_no_development_machine_path():
    for path in OWN_FILES + [WINDOWS / "README.md"]:
        raw = path.read_bytes()
        if path != WINDOWS / "README.md":
            raw.decode("ascii")  # Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page; Inno reads it as ANSI too
        assert b"\r" not in raw, path.name
        text = raw.decode("utf-8").lower()
        # the source offer refuses development-machine paths in any shipped file (build_source_offer.py): the folder that
        # holds this checkout and the profile folder of whoever runs the tests, read from this machine, not written here
        for folder in (REPO.parent, Path.home()):
            if folder == Path(folder.anchor):
                continue  # the checkout sits at a filesystem root (the Linux test container mounts it at /repo): "/" names nothing
            for spelling in (str(folder), str(folder).replace("\\", "/")):
                assert spelling.lower() + "\\" not in text and spelling.lower() + "/" not in text, f"{path.name} names {spelling}"


@needs_powershell
def test_the_build_script_and_the_driver_parse_in_windows_powershell():
    for path in (BUILD_PS1, DRIVER):
        command = ("$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile("
                   f"'{path}',[ref]$t,[ref]$e);if($e.Count){{$e|%{{$_.Message}};exit 1}}")
        result = subprocess.run([POWERSHELL, "-NoProfile", "-Command", command], capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, path.name + result.stdout + result.stderr


def test_nothing_in_the_satellite_setup_program_pushes_or_publishes_an_image():
    # Repository policy: never push, publish or upload images; the setup program and its build only name a reference.
    forbidden = [r"docker\s+(image\s+)?push", r"docker\s+compose\s+push", r"docker\s+buildx[^\n]*--push", r"--push\b",
                 r"docker\s+login", r"docker\s+(image\s+)?tag\b", r"skopeo\s+(copy|sync)", r"crane\s+(push|copy|append)",
                 r"oras\s+push", r"gh\s+(release|api)", r"\bpodman\s+push", r"regctl\s+image\s+copy"]
    for path in (ISS, BUILD_PS1, DRIVER):
        text = path.read_text(encoding="ascii")
        for pattern in forbidden:
            assert not re.search(pattern, text, re.IGNORECASE), f"{path.name} matches {pattern}"
    # and the .iss carries one image reference and no image bytes: the only image-related input is the reference
    text = _iss_text()
    assert "VOCALIS_SATELLITE_IMAGE" in text and "docker pull" not in text.lower()


# ---- setup directives and the identity -------------------------------------------------------------------

def test_the_setup_directives_follow_the_design():
    text = _iss_text()
    for directive in ("PrivilegesRequired=lowest", r"DefaultDirName={localappdata}\Programs\{#ProgramFolder}", "WizardStyle=modern",
                      "ArchitecturesAllowed=x64compatible", "ArchitecturesInstallIn64BitMode=x64compatible",
                      "AppVersion={#AppVersion}", "VersionInfoVersion={#VersionInfo}", "MinVersion=10.0.19041",
                      "OutputBaseFilename=Vocalis-Satellite-Setup-{#AppVersion}-x64{#OutputSuffix}",
                      "SetupMutex={#MutexName}", r"LicenseFile=..\..\LICENSE", "DisableDirPage=yes", "DisableProgramGroupPage=yes",
                      "CloseApplications=no", "DefaultGroupName={#GroupName}", "AppPublisher=Douglas Beachy"):
        assert re.search(rf"^{re.escape(directive)}$", text, re.MULTILINE), directive
    assert "AppId={{{#AppGuid}}" in text
    assert "Uninstall\\{{#AppGuid}}_is1" in text
    # one fixed, permanent AppId of its own, never the main installer's, so Vocalis and a satellite install side by side
    guids = set(re.findall(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}", text))
    assert guids == {REAL_GUID}
    assert f'#define RealAppGuid "{REAL_GUID}"' in text
    main_guid = re.search(r'#define AppGuid "([0-9A-F-]{36})"', MAIN_ISS.read_text(encoding="utf-8")).group(1)
    assert main_guid != REAL_GUID
    # the signing hook exists only in a signed (release) build
    signed_if = '#if GetEnv("VOCALIS_SATELLITE_SIGNED_BUILD") == "1"'
    for directive in ("SignTool=azurecodesign", "SignedUninstaller=yes"):
        before = text[:text.index("\n" + directive)]
        assert before.rfind(signed_if) > before.rfind("#endif"), directive
    # it installs for one user only
    assert "PrivilegesRequiredOverridesAllowed" not in text and "admin" not in "\n".join(_section("Setup")).lower()


@needs_compiler
def test_a_test_identity_changes_every_name_shared_with_a_real_install(tmp_path):
    real = _preprocessed(tmp_path / "real", "")
    test = _preprocessed(tmp_path / "test", "abc")

    def values(text):
        found = {
            "AppId": re.search(r"^AppId=(.+)$", text, re.MULTILINE).group(1),
            "AppName": re.search(r"^AppName=(.+)$", text, re.MULTILINE).group(1),
            "DefaultDirName": re.search(r"^DefaultDirName=(.+)$", text, re.MULTILINE).group(1),
            "DefaultGroupName": re.search(r"^DefaultGroupName=(.+)$", text, re.MULTILINE).group(1),
            "SetupMutex": re.search(r"^SetupMutex=(.+)$", text, re.MULTILINE).group(1),
            "OutputBaseFilename": re.search(r"^OutputBaseFilename=(.+)$", text, re.MULTILINE).group(1),
            "Run value": re.search(r'Software\\Microsoft\\Windows\\CurrentVersion\\Run"; ValueType: string; ValueName: "([^"]+)"', text).group(1),
            "Code Run value": re.search(r"^  RunValueName = '([^']+)';$", text, re.MULTILINE).group(1),
            "uninstall key": re.search(r"^  UninstallKey = '([^']+)';$", text, re.MULTILINE).group(1),
            "default satellite folder": re.search(r"function DefaultSatelliteFolder: String;\nbegin\n  Result := ExpandConstant\('([^']+)'\);", text).group(1),
        }
        return found

    real_values, test_values = values(real), values(test)
    assert set(real_values) == set(test_values) and len(real_values) == 10
    for name in real_values:
        assert real_values[name] != test_values[name], f"{name} is the same in a test build: {real_values[name]}"
        assert real_values[name], name
    for name in ("AppName", "DefaultDirName", "DefaultGroupName", "SetupMutex", "OutputBaseFilename", "Run value", "Code Run value", "default satellite folder"):
        assert "abc" in test_values[name], (name, test_values[name])
    assert _test_guid("abc") in test_values["AppId"] and _test_guid("abc") in test_values["uninstall key"]
    # nothing of the real identity is left in a test build: not its AppId, not its mutex, not its Run value or folder
    assert REAL_GUID not in test
    assert real_values["SetupMutex"] == "VocalisSatelliteSetupMutex" and real_values["AppName"] == "Vocalis Satellite"
    assert real_values["DefaultDirName"] == r"{localappdata}\Programs\VocalisSatellite"
    assert real_values["default satellite folder"] == r"{localappdata}\VocalisDocker\satellite"  # unchanged: a script-made satellite is found
    assert REAL_GUID in real and real_values["Run value"] == "Vocalis Satellite"
    # the real program's text still carries the build's version and image
    assert "12.0.0-M1" in real and IMAGE in real


# ---- the icon, everywhere ---------------------------------------------------------------------------------

def test_the_vocalis_icon_is_named_for_the_setup_the_uninstall_entry_and_every_shortcut():
    text = _iss_text()
    assert re.search(r"^SetupIconFile=vocalis\.ico$", text, re.MULTILINE)
    assert re.search(r"^UninstallDisplayIcon=\{app\}\\vocalis\.ico$", text, re.MULTILINE)
    icons = _section("Icons")
    assert [re.search(r'Name: "\{group\}\\([^"]+)"', line).group(1) for line in icons] == [
        "Vocalis Satellite", "Repair satellite", "Change secret", "New certificate", "Satellite guide", "Uninstall"]
    for line in icons:
        assert 'IconFilename: "{app}\\vocalis.ico"' in line, line
    # the other two looks are installed but never stand in for the Vocalis icon on a shortcut or an entry
    assert re.findall(r"\.ico", "\n".join(icons)) == [".ico"] * len(icons)
    installed = {source for source, flags, *_ in _files() if "dontcopy" not in flags}
    assert set(ICON_NAMES) <= installed
    # the build refuses clearly when one of the three is missing
    ps = BUILD_PS1.read_text(encoding="ascii")
    assert re.search(r"\$IconFileNames = @\('vocalis\.ico', 'vocalis-satellite-stopped\.ico', 'vocalis-satellite-nodocker\.ico'\)", ps)
    assert "Icon file is missing:" in ps


def test_the_wizards_own_pictures_are_the_vocalis_v_in_both_setup_programs_so_no_inno_stock_picture_is_left():
    for iss in (ISS, MAIN_ISS):
        text = iss.read_text(encoding="ascii")
        small, large = _wizard_pictures_named(text)
        assert small == WIZARD_SMALL and large == WIZARD_LARGE, iss.name
        for name in small + large:
            assert (WINDOWS / name).is_file(), name
        # the directives name only these files: nothing from the compiler's own folder (the stock pictures live there)
        assert "compiler:" not in text and "WizClassic" not in text, iss.name
        # "modern" and not "modern dynamic": the dark-mode picture directives do not apply, so these two are every picture
        assert re.search(r"^WizardStyle=modern$", text, re.MULTILINE) and "DynamicDark" not in text, iss.name
    # the satellite wizard names its pictures in [Setup], where every Inno directive lives
    assert "WizardSmallImageFile=" in "\n".join(_section("Setup")) and "WizardImageFile=" in "\n".join(_section("Setup"))


@needs_powershell
def test_both_build_scripts_read_the_same_picture_list_from_their_script_and_name_a_missing_file(tmp_path):
    for build, iss in ((BUILD_PS1, ISS), (MAIN_BUILD_PS1, MAIN_ISS)):
        body = f"[pscustomobject]@{{ r = @(Get-WizardPictureNames '{iss}') }} | ConvertTo-Json -Compress"
        assert _run_ps(tmp_path, build, body, functions=("Get-WizardPictureNames",))["r"] == WIZARD_SMALL + WIZARD_LARGE, build.name
        text = build.read_text(encoding="ascii")
        assert "Wizard picture is missing:" in text and "make_icon.py writes the wizard pictures" in text, build.name
        assert "names no wizard pictures" in text, build.name


def _icon_32_from_exe(path: Path):
    """The 32 px icon the built program carries as its first group icon, read through the Win32 resource functions."""
    from PIL import Image
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LoadLibraryExW.restype = ctypes.c_void_p
    kernel.LoadLibraryExW.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_uint32]
    kernel.FindResourceW.restype = ctypes.c_void_p
    kernel.FindResourceW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    kernel.LoadResource.restype = ctypes.c_void_p
    kernel.LoadResource.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel.LockResource.restype = ctypes.c_void_p
    kernel.LockResource.argtypes = [ctypes.c_void_p]
    kernel.SizeofResource.restype = ctypes.c_uint32
    kernel.SizeofResource.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel.FreeLibrary.argtypes = [ctypes.c_void_p]
    kernel.EnumResourceNamesW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    RT_ICON, RT_GROUP_ICON, LOAD_LIBRARY_AS_DATAFILE = 3, 14, 0x2
    module = kernel.LoadLibraryExW(str(path), None, LOAD_LIBRARY_AS_DATAFILE)
    assert module, f"could not load {path}: {ctypes.get_last_error()}"
    try:
        names = []
        callback_type = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)

        def collect(_module, _kind, name, _param):
            names.append(name if name is None or name < 65536 else ctypes.wstring_at(name))
            return 1

        callback = callback_type(collect)
        kernel.EnumResourceNamesW(module, RT_GROUP_ICON, ctypes.cast(callback, ctypes.c_void_p), None)
        assert names, "the program has no group icon"

        def resource(kind, name):
            ident = ctypes.c_void_p(name) if isinstance(name, int) else ctypes.cast(ctypes.c_wchar_p(name), ctypes.c_void_p)
            handle = kernel.FindResourceW(module, ident, kind)
            assert handle, f"resource {name!r} of type {kind} not found"
            size = kernel.SizeofResource(module, handle)
            return ctypes.string_at(kernel.LockResource(kernel.LoadResource(module, handle)), size)

        group = resource(RT_GROUP_ICON, names[0])
        count = int.from_bytes(group[4:6], "little")
        for index in range(count):
            width, height, colors, _, planes, bits, size, ident = (
                group[6 + 14 * index], group[7 + 14 * index], group[8 + 14 * index], group[9 + 14 * index],
                int.from_bytes(group[10 + 14 * index:12 + 14 * index], "little"), int.from_bytes(group[12 + 14 * index:14 + 14 * index], "little"),
                int.from_bytes(group[14 + 14 * index:18 + 14 * index], "little"), int.from_bytes(group[18 + 14 * index:20 + 14 * index], "little"))
            if width == 32:
                data = resource(RT_ICON, ident)
                single = (b"\x00\x00\x01\x00\x01\x00" + bytes([width, height, colors, 0]) + planes.to_bytes(2, "little") + bits.to_bytes(2, "little")
                          + len(data).to_bytes(4, "little") + (22).to_bytes(4, "little") + data)
                return Image.open(io.BytesIO(single)).convert("RGBA")
        raise AssertionError("the program's icon group has no 32 px image")
    finally:
        kernel.FreeLibrary(module)


@needs_compiler
def test_the_built_setup_program_carries_the_vocalis_icon_pixel_for_pixel_at_32_px(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image
    iss = _stage(tmp_path)
    out = tmp_path / "out"
    result = _iscc(iss, out)
    assert result.returncode == 0, result.stdout + result.stderr
    built = next(out.glob("*.exe"))
    from_exe = _icon_32_from_exe(built)
    with Image.open(ICON) as ico:
        reference = ico.ico.getimage((32, 32)).convert("RGBA")
    assert from_exe.size == reference.size == (32, 32)
    assert from_exe.tobytes() == reference.tobytes(), "the icon inside the built setup program is not vocalis.ico at 32 px"
    # and it is the orange V on the dark square, not an Inno default (which has neither colour)
    assert b"\xff\x7a\x18\xff" in from_exe.tobytes(), "no orange pixel of the Vocalis V"


# ---- the compiler's own parse ----------------------------------------------------------------------------

@needs_compiler
def test_the_pinned_compiler_parses_the_script_with_no_warnings_for_a_real_and_a_test_identity(tmp_path):
    for identity in ("", "abc"):
        root = tmp_path / (identity or "real")
        iss = _stage(root)
        out = root / "out"
        result = _iscc(iss, out, identity=identity)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "Successful compile" in result.stdout
        assert not re.search(r"(?i)\bwarning\b", result.stdout + result.stderr), result.stdout + result.stderr
        assert len(list(out.glob("*.exe"))) == 1


@needs_compiler
def test_the_script_refuses_to_compile_without_its_inputs(tmp_path):
    iss = _stage(tmp_path)
    for variable, message in (("VOCALIS_SATELLITE_VERSION", "VOCALIS_SATELLITE_VERSION must come"),
                              ("VOCALIS_SATELLITE_IMAGE", "VOCALIS_SATELLITE_IMAGE must come"),
                              ("VOCALIS_SATELLITE_TRAY_EXE", "VOCALIS_SATELLITE_TRAY_EXE must come")):
        env = dict(os.environ, VOCALIS_SATELLITE_VERSION="12.0.0-M1", VOCALIS_SATELLITE_VERSION_INFO="12.0.0.0", VOCALIS_SATELLITE_IMAGE=IMAGE,
                   VOCALIS_SATELLITE_TRAY_EXE=str(tmp_path / "VocalisSatelliteTray.exe"), VOCALIS_SATELLITE_TEST_IDENTITY="", VOCALIS_SATELLITE_TEST_GUID="")
        env[variable] = ""
        result = subprocess.run([str(ISCC), "/O-", str(iss)], capture_output=True, text=True, timeout=120, env=env)
        assert result.returncode != 0 and message in result.stdout + result.stderr, (variable, result.stdout + result.stderr)
    # a test identity without its AppId is refused too
    env = dict(os.environ, VOCALIS_SATELLITE_VERSION="12.0.0-M1", VOCALIS_SATELLITE_VERSION_INFO="12.0.0.0", VOCALIS_SATELLITE_IMAGE=IMAGE,
               VOCALIS_SATELLITE_TRAY_EXE=str(tmp_path / "VocalisSatelliteTray.exe"), VOCALIS_SATELLITE_TEST_IDENTITY="abc", VOCALIS_SATELLITE_TEST_GUID="")
    result = subprocess.run([str(ISCC), "/O-", str(iss)], capture_output=True, text=True, timeout=120, env=env)
    assert result.returncode != 0 and "VOCALIS_SATELLITE_TEST_GUID must come" in result.stdout + result.stderr


# ---- the files, the shortcuts and the registry ------------------------------------------------------------

def test_the_script_installs_exactly_the_designed_files_under_their_designed_names():
    entries = _files()
    installed = [(source.replace("\\", "/"), dest) for source, flags, dest, _, _ in entries if "dontcopy" not in flags]
    assert installed == [
        ("../satellite/satellite-setup.ps1", None), ("{#TrayExe}", "VocalisSatelliteTray.exe"), ("satellite-log-tail.ps1", None),
        ("{srcexe}", "Vocalis-Satellite-Setup.exe"),
        ("../satellite/README.md", "Vocalis-Satellite-Guide.md"), ("../../LICENSE", None), ("vocalis.ico", None),
        ("vocalis-satellite-stopped.ico", None), ("vocalis-satellite-nodocker.ico", None)]
    # everything installed goes to {app}, with no version check (the program and its guide are replaced on an upgrade)
    for source, flags, dest, check, line in entries:
        if "dontcopy" in flags:
            continue
        assert 'DestDir: "{app}"' in line and "ignoreversion" in flags, line
    # the copy of the setup program itself is an external file (the running setup program, {srcexe})
    copy = next(line for source, *_, line in entries if source == "{srcexe}")
    assert "external" in copy
    # extracted to {tmp} for the wizard-time work, never installed; the control script needs the compose helper beside it
    assert sorted(source.replace("\\", "/") for source, flags, *_ in entries if "dontcopy" in flags) == [
        "../satellite/satellite-setup.ps1", "../windows-compose.ps1", "vocalis-control.ps1"]
    # sources that exist in the repository today (the tray program is built; the two other icons are another part's work)
    for source, flags, *_ in entries:
        if source.startswith("{") or source in ("vocalis-satellite-stopped.ico", "vocalis-satellite-nodocker.ico"):
            continue
        assert (WINDOWS / source.replace("\\", "/")).is_file(), source
    assert (WINDOWS / "vocalis.ico").is_file()
    # the guide is installed under the name the shortcuts and the tray menu use
    assert "Vocalis-Satellite-Guide.md" in _iss_text()


def test_the_start_menu_group_has_the_designed_shortcuts_and_nothing_on_the_desktop():
    icons = _section("Icons")
    by_name = {re.search(r'Name: "\{group\}\\([^"]+)"', line).group(1): line for line in icons}
    assert 'Filename: "{app}\\VocalisSatelliteTray.exe"' in by_name["Vocalis Satellite"]
    for name, mode in (("Repair satellite", "repair"), ("Change secret", "newsecret"), ("New certificate", "newcertificate")):
        assert 'Filename: "{app}\\Vocalis-Satellite-Setup.exe"' in by_name[name] and f'Parameters: "/MODE={mode}"' in by_name[name], name
    assert 'Filename: "{win}\\notepad.exe"' in by_name["Satellite guide"] and "Vocalis-Satellite-Guide.md" in by_name["Satellite guide"]
    assert 'Filename: "{uninstallexe}"' in by_name["Uninstall"]
    # Start and Stop live in the icon's menu only
    assert not any("Start satellite" in name or "Stop satellite" in name for name in by_name)
    assert "userdesktop" not in _iss_text() and "desktopicon" not in _iss_text() and "[Tasks]" not in _iss_text()


def test_the_run_entry_starts_the_tray_icon_at_sign_in_and_is_removed_at_uninstall():
    registry = _section("Registry")
    assert len(registry) == 1, registry
    line = registry[0]
    assert 'Root: HKCU; Subkey: "Software\\Microsoft\\Windows\\CurrentVersion\\Run"' in line
    assert 'ValueName: "{#RunValueName}"' in line
    assert 'ValueData: """{app}\\VocalisSatelliteTray.exe"" --signin"' in line
    assert "uninsdeletevalue" in line
    # the uninstaller also deletes it by name, after closing the icon
    uninstall = _pascal("CurUninstallStepChanged")
    assert "RegDeleteValue(HKCU, RunKey, RunValueName)" in uninstall
    assert re.search(r"RunValueName = '\{#RunValueName\}'", _code()) and "RunKey = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run'" in _code()


def test_every_installed_file_shortcut_and_registry_entry_is_skipped_in_a_maintenance_mode():
    # Inno cannot skip its install step, so each entry carries a check that is false in a mode (design: maintenance modes)
    for source, flags, dest, check, line in _files():
        if "dontcopy" not in flags:
            assert check == "FullInstall", line
    for section in ("Icons", "Registry"):
        for line in _section(section):
            assert "Check: FullInstall" in line, line
    assert "Check:" not in "\n".join(_section("UninstallDelete"))
    assert re.search(r"function FullInstall: Boolean;\nbegin\n  Result := RunMode = '';\nend;", _code())
    # the program state is written, the tray icon closed and the secret file cleared only by a full install; the script
    # runs in every mode (that is what a mode is for)
    step = _pascal("CurStepChanged")
    _ordered(step, "ssPostInstall", "if RunMode = '' then", "RemoveZoneIdentifier;", "WriteState;", "RunSatelliteSetup;", "StartTrayIcon;")
    prepare = _pascal("PrepareToInstall")
    assert "if RunMode = '' then" in prepare and "CloseTrayIcon(InstalledApp)" in prepare
    # the three modes, and nothing else, are accepted
    start = _pascal("InitializeSetup")
    assert "RunMode := Lowercase(Trim(ExpandConstant('{param:MODE|}')))" in start
    assert "(RunMode <> 'repair') and (RunMode <> 'newsecret') and (RunMode <> 'newcertificate')" in start
    # a mode needs an install to run from; the installed copy started with no mode does not copy itself over itself
    assert "(not InstalledHere) or (StateRoot = '')" in start
    assert "CompareText(ExpandConstant('{srcexe}'), InstalledApp + '\\' + SetupCopyName) = 0" in start and "RunMode := 'repair'" in start


def test_a_mode_shows_only_the_pages_it_needs():
    skip = _pascal("ShouldSkipPage")
    mode_branch = skip[skip.index("if RunMode <> '' then"):skip.index("  else\n  begin\n    if PageID = FolderPage.ID")]
    for page in ("wpWelcome", "wpLicense", "wpReady", "PrereqPage.ID", "FolderPage.ID", "PortPage.ID"):
        assert page in mode_branch, page
    assert "Result := RunMode <> 'newcertificate'" in mode_branch  # the certificate page only in its mode
    assert "Result := not PairPageWanted" in mode_branch
    wanted = _pascal("PairPageWanted")
    _ordered(wanted, "RunMode = 'newcertificate'", "Result := False", "RunMode = 'newsecret'", "Result := True", "PlanNeedsSecret = 'yes'")


# ---- the wizard's pages ----------------------------------------------------------------------------------

def test_the_wizard_has_the_designed_pages_in_the_designed_order():
    wizard = _pascal("InitializeWizard")
    _ordered(wizard,
             "WizardForm.WelcomeLabel2.Caption", "PrereqPage := CreateCustomPage(wpLicense, 'Prerequisites'",
             "FolderPage := CreateInputDirPage(PrereqPage.ID, 'Satellite folder'", "PortPage := CreateInputQueryPage(FolderPage.ID, 'Port, name and starting'",
             "CertPage := CreateInputQueryPage(PortPage.ID, 'New certificate'", "PairPage := CreateCustomPage(CertPage.ID, 'Pair with Vocalis'",
             "RunPage := CreateOutputMarqueeProgressPage('Setting up the satellite'", "CreateFinishControls;")
    # welcome: two sentences, what a satellite is and that it is optional. The page has to be turned on: Inno Setup's
    # default leaves the Welcome page out, and the two sentences would never be shown.
    assert "DisableWelcomePage=no" in _section("Setup")
    welcome = wizard[wizard.index("WelcomeLabel2.Caption"):wizard.index("// Prerequisites")]
    assert "A satellite is optional" in welcome and welcome.count(". '") + welcome.count(".'") == 2
    # prerequisites: the space needed, the Docker Desktop sign-in note that does not block, Retry
    assert "about 10 GB in Docker" in wizard and "3.2 GB" in wizard and "FreeSpaceText(DefaultSatelliteFolder)" in wizard
    assert "RegValueExists(HKCU, RunKey, DockerDesktopRunValue)" in wizard and "This does not block setup." in wizard
    assert "PrereqRetry.Caption := 'Retry'" in wizard
    # the default folder is the script's own, so a satellite made by the script is found
    assert r"FolderPage.Values[0] := DefaultSatelliteFolder" in wizard and "VocalisDocker\\satellite" in _iss_text()
    # port, name and starting: 7880, the computer's name in lower case, an optional extra address, the tick box on by default
    assert "DefaultPortText = '7880'" in _code() and "Lowercase(GetComputerNameString)" in wizard
    assert "Extra address (optional; only if Vocalis reaches this computer by an address setup does not find, for example through a VPN):" in wizard
    assert "AutostartCheck.Caption := 'Start the satellite when Windows starts. You can change this from the tray icon.'" in wizard
    assert "AutostartCheck.Checked := True" in wizard
    # the Pair page comes before Ready: the secret box is masked and has no default
    assert "PairSecret := TPasswordEdit.Create(PairPage)" in wizard and "PairSecret.Text := ''" in wizard
    assert "Vocalis shows a secret once. Paste it here:" in wizard
    # the Setting up page cannot be cancelled and says so
    assert "It cannot be cancelled here;" in wizard and "run setup again and it carries on" in wizard
    cancel = _pascal("CancelButtonClick")
    assert "if SetupRunning then" in cancel and "Cancel := False" in cancel


def test_the_normal_wizard_skips_the_folder_and_port_pages_when_the_folder_is_known():
    skip = _pascal("ShouldSkipPage")
    normal = skip[skip.index("  else\n  begin\n    if PageID = FolderPage.ID"):]
    assert "if PageID = FolderPage.ID then\n      Result := Known" in normal
    assert "else if PageID = PortPage.ID then\n      Result := Known or UseExistingFolder" in normal
    assert "else if PageID = CertPage.ID then\n      Result := True" in normal
    assert "else if PageID = PairPage.ID then\n      Result := not PairPageWanted" in normal
    assert "Known := InstalledHere and (StateRoot <> '')" in skip
    # a Prerequisites page is always shown in a normal run (it is skipped only in a mode)
    assert "PrereqPage.ID" not in normal


def test_the_folder_page_has_the_main_installers_refusals_and_offers_to_use_an_existing_satellite():
    validate = _pascal("ValidateFolder")
    for refusal in ("Pos('''', Dir) > 0", "HasLineBreak(Dir)", "GetDriveType(Copy(Dir, 1, 3)) = 4", "A network drive cannot be used",
                    "cannot be inside the program folder", "(Dir[2] <> ':')"):
        assert refusal in validate, refusal
    # the script is the authority for what else it refuses; an existing satellite is found by the plan
    assert "RunPlan(Dir, '')" in validate and "PlanSatellite = 'existing'" in validate and "UseExisting := True" in validate
    assert "MinimumFolderBytes = 3500000000" in _code() and "3.2 GB" in validate
    nxt = _pascal("NextButtonClick")
    assert "This folder already holds a satellite" in nxt and "Use this satellite?" in nxt
    # a taken-over satellite keeps its own port, name and autostart value, from the plan
    assert "ChosenPort := PlanPort" in nxt and "ChosenName := PlanName" in nxt and "ChosenAutostart := PlanAutostart" in nxt


def test_the_port_page_tests_the_port_offers_the_suggestion_and_needs_an_address():
    page = _pascal("ValidatePortPage")
    assert "RunScriptCaptured('-CheckPort -Port ' + IntToStr(PortNumber), Code)" in page
    assert "'Suggested port:'" in page and "Use port " in page and "instead?" in page
    assert "(PortNumber < 1024) or (PortNumber > 65535)" in page
    _ordered(page, "-CheckPort", "RunPlan(ChosenRoot, ' -Port '", "PlanAddresses = ''", "Fill in \"Extra address\"")
    assert "AddressArgument(PortPage.Values[2])" in page
    note = _pascal("RefreshPortAddressNote")
    assert "Setup found no network address for this computer." in note
    assert "' -Address ' + Q(Trim(Address))" in _pascal("AddressArgument")


def test_the_pair_page_checks_only_the_shape_and_says_so_plainly():
    shape = _pascal("SecretHasShape")
    assert "Length(Text) = 64" in shape and "IsHexDigit" in shape
    nxt = _pascal("NextButtonClick")
    assert "Typed := Trim(PairSecret.Text)" in nxt and "not SecretHasShape(Typed)" in nxt
    assert "That is not the shape of a Vocalis secret. It is 64 characters of 0-9 and a-f" in nxt
    # the message gives the length, never the text
    refusal = nxt[nxt.index("That is not the shape"):nxt.index("Result := False", nxt.index("That is not the shape"))]
    assert "IntToStr(Length(Typed))" in refusal and "+ Typed" not in refusal
    # the address box and the Copy button
    changed = _pascal("CurPageChanged")
    assert "PairAddressMemo.Lines.Text := PlanUrlLines(PlanPort)" in changed
    assert "Add satellite. Address to enter:" in changed and "New secret..." in changed
    copy = _pascal("CopyEditText")
    assert "Edit.SelLength := Length(Edit.Text)" in copy and "NativeSendMessage(Edit.Handle, $0301, 0, 0)" in copy  # WM_COPY
    assert "SendMessageW@user32.dll" in _code()


def test_the_prerequisites_page_runs_check_only_and_the_net_framework_check_and_blocks_next_until_they_pass():
    run = _pascal("RunPrerequisiteChecks")
    assert "RunScriptCaptured('-CheckOnly', Code)" in run and "DotNetFrameworkOk(DotNetText)" in run
    assert "PrereqPassed := ScriptOk and DotNetOk" in run and "WizardForm.NextButton.Enabled := PrereqPassed" in run
    assert "ScriptOk := Code = 0" in run
    net = _pascal("DotNetFrameworkOk")
    assert "MinimumDotNetRelease" in net and "https://dotnet.microsoft.com/download/dotnet-framework/net48" in net and "downloads nothing itself" in net
    assert "MinimumDotNetRelease = 528040" in _code() and r"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full" in _code()
    assert "All checks passed. Choose Next." in run and "A check failed. Follow the Fix text on the failed line, then choose Retry." in run
    # Next is disabled while the checks run and until they pass
    assert run.index("WizardForm.NextButton.Enabled := False") < run.index("RunScriptCaptured('-CheckOnly'")


# ---- what the wizard passes to the script ---------------------------------------------------------------

def test_the_script_arguments_follow_the_designed_table_row_by_row():
    build = _pascal("BuildScriptArguments")
    # always: -Root and -NoPrompt (under the wizard the secret prompt would be invisible and the run would wait forever)
    assert "Result := '-Root ' + Q(ChosenRoot) + ' -NoPrompt';" in build
    # /MODE=newsecret: -NewSecret -SecretFile
    new_secret = build[build.index("if RunMode = 'newsecret' then"):build.index("else if RunMode = 'newcertificate' then")]
    assert "' -NewSecret'" in new_secret and "NeedsSecretFile := True" in new_secret
    # /MODE=newcertificate: -NewCertificate [-Address]
    new_cert = build[build.index("else if RunMode = 'newcertificate' then"):build.index("else if not RunPlan(ChosenRoot, '') then")]
    assert "' -NewCertificate' + AddressArgument(ChosenAddress)" in new_cert and "SecretFile" not in new_cert
    # first install and the repair after a first run that failed before satellite.env existed: the plan says 'new'
    first = build[build.index("else if PlanSatellite = 'new' then"):build.index("  else\n  begin\n    // An upgrade")]
    for token in ("' -Image ' + Q(BakedImage)", "' -Port ' + ChosenPort", "' -Name ' + Q(ChosenName)", "' -Autostart ' + ChosenAutostart",
                  "AddressArgument(ChosenAddress)", "NeedsSecretFile := True"):
        assert token in first, token
    assert "-Update" not in first
    # upgrade, take-over and repair of a FINISHED folder: a plain rerun when the recorded image is the baked one, an update otherwise
    existing = build[build.index("  else\n  begin\n    // An upgrade"):build.index("  if NeedsSecretFile then")]
    assert "else if PlanImage <> BakedImage then" in existing and "' -Update -Image ' + Q(BakedImage)" in existing
    assert "if PlanNeedsSecret = 'yes' then NeedsSecretFile := True" in existing
    for forbidden in ("-Port", "-Name", "-Autostart", "-NewSecret", "-NewCertificate"):
        assert forbidden not in existing, forbidden
    # the secret file is named only when a secret is in hand
    tail = build[build.index("  if NeedsSecretFile then"):]
    assert "if SecretValue <> '' then" in tail and "' -SecretFile ' + Q(SecretPath)" in tail and "NeedsSecretFile := False" in tail
    # the state file feeds the first-install row (PORT, NAME, ADDRESS, AUTOSTART), so a repair passes them again
    choices = _pascal("PrepareChoices")
    for token in ("ChosenPort := StatePort", "ChosenName := StateName", "ChosenAutostart := StateAutostart", "ChosenAddress := StateAddress"):
        assert token in choices, token
    assert "if RunMode <> 'newcertificate' then ChosenAddress := StateAddress" in choices  # the typed address is this run's own


def _without_comments(pascal: str) -> str:
    return "\n".join(line for line in pascal.splitlines() if not line.lstrip().startswith("//"))


def test_an_unfinished_existing_folder_gets_the_baked_image_and_no_update_in_an_upgrade_a_take_over_and_a_repair():
    """The design's arguments table, row "the same three situations when the plan says the folder's setup never finished
    (SETUP_FINISHED=no)": -Image <baked> with no -Update, and -SecretFile when the plan says a secret is needed, whatever the
    recorded image is. One branch of BuildScriptArguments serves an upgrade, a take-over and /MODE=repair alike, so what is
    proved is that the branch has no condition on the mode, the install or the take-over and puts the rule first."""
    build = _pascal("BuildScriptArguments")
    existing = build[build.index("  else\n  begin\n    // An upgrade"):build.index("  if NeedsSecretFile then")]
    code = _without_comments(existing)
    # the chain that reaches the branch: only a new secret, a new certificate or a plan that says 'new' leave it
    chain = build[:build.index("  else\n  begin\n    // An upgrade")]
    assert [m for m in re.findall(r"(?:if|else if) ([^\n]+?) then", _without_comments(chain))] == [
        "RunMode = 'newsecret'", "RunMode = 'newcertificate'", "not RunPlan(ChosenRoot, '')", "PlanSatellite = 'new'"]
    for condition in ("RunMode", "UseExistingFolder", "InstalledHere"):  # no condition of its own: upgrade, take-over and repair all take it
        assert condition not in code, condition
    # the unfinished rule comes first and ignores the recorded image: the baked image, with no -Update
    unfinished = code[code.index("if PlanSetupFinished = 'no' then"):code.index("else if PlanImage <> BakedImage then")]
    assert unfinished.split("then", 1)[1].strip() == "Result := Result + ' -Image ' + Q(BakedImage)", unfinished
    assert "Update" not in unfinished and "PlanImage" not in unfinished
    # the finished rule is as it was: nothing more when equal, -Update -Image <baked> when different
    finished = code[code.index("else if PlanImage <> BakedImage then"):]
    assert "Result := Result + ' -Update -Image ' + Q(BakedImage);" in finished
    # the secret file is added by the plan's NEEDS_SECRET in both, after the image decision
    assert code.index("else if PlanImage <> BakedImage then") < code.index("if PlanNeedsSecret = 'yes' then NeedsSecretFile := True")
    # SETUP_FINISHED is read from the script's plan (the one reader of satellite.env), and the decision is logged with values
    assert "PlanSetupFinished := CapturedValue('SETUP_FINISHED')" in _pascal("RunPlan")
    assert "Script arguments decided: satellite %s, finished %s, recorded image" in build


def test_the_script_runs_once_hidden_from_the_post_install_step_with_the_moving_bar_page():
    run = _pascal("RunSatelliteSetup")
    assert "ExecAndLogOutput(PowerShellExe" in run and "SW_HIDE, ewWaitUntilTerminated, SetupExitCode, @OnSetupLine" in run
    assert "ExpandConstant('{app}\\satellite-setup.ps1')" in run  # the installed copy, not the one in {tmp}
    assert "-NoProfile -ExecutionPolicy Bypass -File " in run
    _ordered(run, "BuildScriptArguments(SecretPath, NeedsSecretFile)", "SetupRunning := True", "RunPage.Show", "SaveStringToFile(SecretPath",
             "ExecAndLogOutput", "finally", "RunPage.Hide", "DeleteFile(SecretPath)", "SetupRan := True", "ReadResultFile(SetupExitCode)")
    # the page shows the current step title ("[n/N] ...") and the latest output line
    line = _pascal("OnSetupLine")
    assert "S[1] = '['" in line and "RunPage.SetText(S, S)" in line and "RunPage.Msg2Label.Caption := S" in line
    # prerequisite, address and port checks go through the captured runner, all from {tmp}, hidden
    runner = _pascal("RunScriptCaptured")
    assert "ExpandConstant('{tmp}') + '\\satellite-setup.ps1'" in runner and "SW_HIDE" in runner and "@OnCaptureLine" in runner
    # the wizard starts the tray icon from code after the script has exited, not from a [Run] entry
    assert not _section("Run") and not re.search(r"^\[Run\]", _iss_text(), re.MULTILINE)
    assert _pascal("CurStepChanged").index("RunSatelliteSetup;") < _pascal("CurStepChanged").index("StartTrayIcon;")


# ---- the secret --------------------------------------------------------------------------------------------

def test_the_secret_file_is_written_just_before_the_script_and_deleted_after_it_on_every_path():
    run = _pascal("RunSatelliteSetup")
    assert "SecretPath := ExpandConstant('{app}\\' + SecretFileName)" in run and "SecretFileName = 'pairing-secret.tmp'" in _code()
    # plain ASCII with no byte-order mark: SaveStringToFile of an AnsiString (a string of 64 hex digits)
    assert "SaveStringToFile(SecretPath, AnsiString(SecretValue), False)" in run
    assert "UTF8" not in run and "Utf8Encode" not in run
    # written inside the try that has the finally which deletes it, and the finally clears the memory copies
    body = run[run.index("  try\n    RunPage.SetText"):]
    assert body.index("SaveStringToFile(SecretPath") < body.index("ExecAndLogOutput") < body.index("  finally")
    final = body[body.index("  finally"):]
    assert "DeleteFile(SecretPath)" in final and "SecretValue := ''" in final and "PairSecret.Text := ''" in final
    # deleted at every start of the setup program, again before the copy, and by uninstall (both ways)
    assert "DeleteLeftoverSecret(InstalledApp)" in _pascal("InitializeSetup")
    assert "DeleteLeftoverSecret(ExpandConstant('{app}'))" in _pascal("PrepareToInstall")
    assert "DeleteLeftoverSecret(AppDir)" in _pascal("CurUninstallStepChanged")
    assert 'Type: files; Name: "{app}\\pairing-secret.tmp"' in _section("UninstallDelete")
    # in the program folder, not in Inno's {tmp}
    assert "{tmp}" not in run


def test_the_secret_is_never_on_a_command_line_in_the_environment_in_a_log_or_in_a_file_other_than_its_own():
    code = _code()
    # every use of the secret value variables, by the function that has it
    allowed = {"SecretValue": {"NextButtonClick", "BuildScriptArguments", "RunSatelliteSetup"},
               "PairSecret": {"InitializeWizard", "NextButtonClick", "RunSatelliteSetup"}}
    functions = _function_names()
    bodies = {name: _pascal(name) for name in functions}
    for variable, names in allowed.items():
        users = {name for name, body in bodies.items() if re.search(rf"\b{variable}\b", body)}
        assert users <= names, (variable, users - names)
    # no log line mentions the secret, its box or the typed copy
    for statement in re.findall(r"Log\((?:[^;]|\n)*?\);", code):
        assert not re.search(r"SecretValue|PairSecret|\bTyped\b", statement), statement
    # the arguments carry the secret FILE path only; the environment is never set; the state file has no secret key
    assert "SetEnvironment" not in code and "PutEnv" not in code
    assert "SECRET" not in _pascal("WriteState").upper().replace("SECRETVALUE", "")
    build = _pascal("BuildScriptArguments")
    assert "Result := Result + ' -SecretFile ' + Q(SecretPath)" in build  # the path of the file, never the value
    # the result file is read for fixed keys only, none of which is the secret
    keys = set(re.findall(r"FileValue\(\w+, '(\w+)'\)", _pascal("ReadResultFile")))
    assert keys == {"EXIT_CODE", "VOCALIS_STEPS", "CERTIFICATE_FILE", "FINGERPRINT", "FAILURE", "LOG_FILE", "RUNNING"}


# ---- the state file ------------------------------------------------------------------------------------

def test_the_state_file_holds_the_designed_keys_as_utf8_without_a_byte_order_mark():
    write = _pascal("WriteState")
    keys = re.findall(r"Lines\[\d\] := '(\w+)=' \+", write)
    assert keys == ["ROOT", "IMAGE", "VERSION", "PORT", "NAME", "ADDRESS", "AUTOSTART"]
    assert "SaveStringsToUTF8FileWithoutBOM(ExpandConstant('{app}\\' + StateFileName), Lines, False)" in write
    assert "StateFileName = 'satellite-installer-state.txt'" in _code()
    # the image and version are the baked ones
    assert "'IMAGE=' + BakedImage" in write and "'VERSION=' + AppVersionText" in write
    # what reads it back reads exactly those keys, as UTF-8
    load = _pascal("LoadState")
    assert re.findall(r"FileValue\(FileName, '(\w+)'\)", load) == ["ROOT", "IMAGE", "PORT", "NAME", "ADDRESS", "AUTOSTART"]
    assert "Utf8Decode(Raw)" in _pascal("FileValue")
    # written before the script runs, so a repair after a first run that failed before satellite.env existed can pass the values again
    step = _pascal("CurStepChanged")
    assert step.index("WriteState;") < step.index("RunSatelliteSetup;")


# ---- the finish page --------------------------------------------------------------------------------------

def test_the_finish_page_is_built_from_the_result_file_keyed_on_vocalis_steps():
    result = _pascal("ReadResultFile")
    assert "ChosenRoot + '\\setup-result.txt'" in result
    # a result file is used only when it records this run's exit code; with a zero exit and no readable file the plan is the fallback
    assert "Recorded = IntToStr(ExitCode)" in result
    assert "RunPlan(ChosenRoot, '')" in result and "ResCertificateFile := PlanCertificateFile" in result and "ResFingerprint := PlanFingerprint" in result
    assert "could not be read" in result
    page = _pascal("ShowFinishPage")
    for steps in ("upload-and-tick", "upload", "none"):
        assert f"ResVocalisSteps = '{steps}'" in page, steps
    assert "One thing is left: give Vocalis its certificate." in page and "One thing is left: give Vocalis the new certificate." in page
    assert "Nothing has to be done in Vocalis." in page and "Then tick its card." in page
    # the 'upload' text has no tick sentence
    upload = page[page.index("ResVocalisSteps = 'upload' then"):page.index("ResVocalisSteps = 'none'")]
    assert "Then tick" not in upload
    # the October 10 plain-run wording for 'maybe'
    assert "If this satellite is already set up in Vocalis, nothing more has to be done there." in page
    assert "If it is not (for example an earlier run stopped part way), two steps are left in Vocalis" in page
    # every variant: the icon is in the notification area; the guide's Network section
    assert "icon is now in the notification area" in page and 'see the "Network" section of the satellite guide' in page
    # failure: the heading, the reason from the result file or the last output lines, the log with an Open button, resume
    assert "Setup did not finish" in page and "ResFailure" in page and "TailLines" in page and "ResLogFile" in page
    assert "Run this setup program again, or choose \"Repair satellite\" in the Start menu, and setup resumes" in page
    assert "The program files stay installed." in page
    # the buttons: Show the file (Explorer with the file selected), Copy the path, Open the log
    assert "'Show the file'" in _pascal("CreateFinishControls") and "'Copy the path'" in _pascal("CreateFinishControls") and "'Open the log'" in _pascal("CreateFinishControls")
    assert "'/select,' + Q(FileName)" in _pascal("ShowFileInExplorer")
    # the fingerprint is selectable (a read-only edit)
    assert "FinPrintEdit.ReadOnly := True" in _pascal("CreateFinishControls") and "FinCertEdit.ReadOnly := True" in _pascal("CreateFinishControls")
    assert "wpFinished" in _pascal("CurPageChanged") and "ShowFinishPage;" in _pascal("CurPageChanged")


def test_the_test_seam_keeps_explorer_and_notepad_off_the_desktop_and_still_starts_the_tray_icon():
    code = _code()
    assert "GetEnv('VOCALIS_SATELLITE_TEST_NO_SHELL') = '1'" in _pascal("ShellSeam")
    assert "ShellLogName = 'test-shell-actions.log'" in code
    note = _pascal("NoteShellAction")
    assert "{app}\\' + ShellLogName" in note and "would " in note
    # Explorer and Notepad hand off to the visible desktop's shell: under the seam they are noted and NOT started
    for name in ("ShowFileInExplorer", "OpenInNotepad"):
        body = _pascal(name)
        seam = body[body.index("if ShellSeam then"):body.index("Exec(")]
        assert "NoteShellAction(" in seam and "Exit;" in seam, name
    # the tray icon is the wizard's own child on the wizard's own desktop: under the seam it is noted AND started, so the
    # live test proves the wizard starts it
    tray = _pascal("StartTrayIcon")
    seam = tray[tray.index("if ShellSeam then"):tray.index("Exec(")]
    assert "NoteShellAction(" in seam and "Exit;" not in seam.split("if not FileExists")[0]
    # and nothing else in the file starts Explorer, Notepad or the tray program as a desktop program
    for pattern in (r"explorer\.exe", r"notepad\.exe"):
        for name in _function_names():
            if re.search(pattern, _pascal(name)):
                assert name in ("ShowFileInExplorer", "OpenInNotepad"), (pattern, name)
    assert "ShellExec(" not in code
    # the shortcut to the guide is a Start menu entry (the user's own click), not the wizard's action
    assert "notepad.exe" in "\n".join(_section("Icons"))


def test_the_setting_up_pages_description_fits_two_lines_and_still_says_the_three_facts():
    # Live test, October 11, 2026: the earlier text (about 200 characters) was cut off after "keeping"; the description
    # area holds two lines at 100% scaling, about 120 characters of the wizard font
    found = re.search(r"CreateOutputMarqueeProgressPage\('Setting up the satellite',\s*'((?:[^']|'')*)'\);", _pascal("InitializeWizard"))
    assert found, "the Setting up page's description was not found"
    description = found.group(1)
    assert len(description) <= 125, (len(description), description)
    assert "keeping" not in description
    # (1) a first run can take several minutes, (2) it cannot be cancelled here, (3) an interrupted setup carries on when run again
    assert "A first run can take several minutes" in description
    assert "cannot be cancelled here" in description
    assert "interrupted" in description and "run setup again" in description and "carries on" in description


# ---- the Modify entry, reinstall and uninstall --------------------------------------------------------------

def test_a_maintenance_run_does_not_write_the_uninstaller_its_log_or_the_uninstall_key():
    # Live test, October 11, 2026: every /MODE= run rewrote unins000.exe and grew unins000.dat by about 104 KB, although
    # nothing is installed. [Setup] Uninstallable takes a run-time boolean expression; it is the mode check the entries
    # already use, so the full install writes the uninstaller and a maintenance mode leaves the existing one alone.
    setup = _section("Setup")
    assert "Uninstallable=FullInstall" in setup, setup
    assert len([line for line in setup if line.startswith("Uninstallable")]) == 1
    # nothing else in [Setup] weakens the uninstaller of the full install or hides its Installed apps entry
    for directive in ("CreateUninstallRegKey", "UninstallLogMode", "UpdateUninstallLogAppName", "UninstallFilesDir"):
        assert not [line for line in setup if line.startswith(directive)], directive
    # the expression is the same function the entries use, and a function that is false in every maintenance mode
    assert re.search(r"function FullInstall: Boolean;\nbegin\n  Result := RunMode = '';\nend;", _code())
    # the decision is logged, with the mode
    start = _pascal("InitializeSetup")
    assert "Uninstallable=FullInstall is true" in start and "Uninstallable=FullInstall is false (mode " in start
    # the Modify path, the icon and NoModify=0 are still written in every mode (into the existing key in a maintenance mode)
    step = _pascal("CurStepChanged")
    assert re.search(r"ssDone then\n    SetModifyEntry;", step)
    assert "RunMode" not in _pascal("SetModifyEntry")
    assert re.search(r"^UninstallDisplayIcon=\{app\}\\vocalis\.ico$", _iss_text(), re.MULTILINE)

def test_installed_apps_gets_a_modify_entry_that_runs_the_installed_copy_in_repair_mode():
    modify = _pascal("SetModifyEntry")
    assert "RegWriteStringValue(HKCU, UninstallKey, 'ModifyPath', Q(ExpandConstant('{app}\\' + SetupCopyName)) + ' /MODE=repair')" in modify
    assert "RegWriteDWordValue(HKCU, UninstallKey, 'NoModify', 0)" in modify
    # Inno writes NoModify=1 itself, so the entry is written after it has finished, and in every mode
    step = _pascal("CurStepChanged")
    assert re.search(r"ssDone then\n    SetModifyEntry;", step)
    assert "SetModifyEntry;" in _pascal("CurPageChanged")
    # Uninstall is the uninstaller Inno registers; the Installed apps icon is the Vocalis icon
    assert re.search(r"^UninstallDisplayIcon=\{app\}\\vocalis\.ico$", _iss_text(), re.MULTILINE)
    # the zone identifier of a downloaded setup program is not carried to the installed copy
    zone = _pascal("RemoveZoneIdentifier")
    assert "':Zone.Identifier'" in zone and "DeleteFile(Stream)" in zone


def test_uninstall_closes_the_icon_first_removes_the_run_entry_and_the_container_and_keeps_the_folder_and_the_image():
    uninstall = _pascal("CurUninstallStepChanged")
    _ordered(uninstall, "usUninstall", "CloseTrayIcon(AppDir)", "RegDeleteValue(HKCU, RunKey, RunValueName)", "DeleteLeftoverSecret(AppDir)",
             "FileValue(StateFile, 'ROOT')", "' -Root ' + Q(Root) + ' -Remove -NoPrompt'", "usDone")
    assert "FileExists(Root + '\\satellite.env')" in uninstall  # the container is looked up through the folder; a missing one is said so
    assert "(Code = 10) or (Code = 11)" in uninstall and "Docker is not running, so the satellite''s container was skipped" in uninstall
    assert "docker ps -a --filter name=vocalis-satellite" in uninstall
    assert "The satellite folder was not deleted:" in uninstall and "docker image rm " in uninstall
    # the satellite folder and the image are never removed by anything in the file
    code = _code()
    assert "DelTree" not in code and "RemoveDir" not in code and "image rm' +" not in code
    # the tray icon is asked to close with --exit, both on an upgrade and first in the uninstaller
    close = _pascal("CloseTrayIcon")
    assert "'--exit'" in close and "ewWaitUntilTerminated" in close
    # the tray's exit codes: 0 done (also with no icon running), 3 no icon: only these two count as closed (the rule has
    # its own test below)
    assert "Result := (Code = 0) or (Code = 3)" in close and close.startswith("function CloseTrayIcon")
    prepare = _pascal("PrepareToInstall")
    assert "if not CloseTrayIcon(InstalledApp) then" in prepare and "could not be closed" in prepare and 'choose "Close this icon"' in prepare and "Nothing was changed." in prepare
    assert "TrayClosed := CloseTrayIcon(AppDir)" in uninstall and "could not be closed" in uninstall
    # the files the wizard, the tray program and the seam write into {app} are removed by name, and the folder only when
    # it is then empty. Never the whole folder: Inno honors /DIR= even with the folder page off, so a recursive delete of
    # {app} could remove a folder the user keeps other things in (the main installer's rule is the same).
    delete = _section("UninstallDelete")
    assert delete == [
        'Type: files; Name: "{app}\\satellite-installer-state.txt"',
        'Type: files; Name: "{app}\\pairing-secret.tmp"',
        'Type: files; Name: "{app}\\test-shell-actions.log"',
        'Type: files; Name: "{app}\\satellite-tray.log"',
        'Type: files; Name: "{app}\\satellite-tray.log.1"',
        'Type: dirifempty; Name: "{app}"',
    ], delete
    # those names are the ones the code writes: the state file, the secret file and the seam log are constants of the
    # script, and the tray program's log name is in its source
    for constant in ("StateFileName = 'satellite-installer-state.txt'", "SecretFileName = 'pairing-secret.tmp'", "ShellLogName = 'test-shell-actions.log'"):
        assert constant in code, constant
    tray_program = (ISS.parent / "tray" / "Program.cs").read_text(encoding="utf-8")
    assert 'Path.Combine(exeFolder, "satellite-tray.log")' in tray_program
    assert 'string older = path + ".1";' in (ISS.parent / "tray" / "Log.cs").read_text(encoding="utf-8")


def test_only_exit_codes_0_and_3_let_an_upgrade_or_an_uninstall_go_on_past_the_running_icon():
    """October 11, 2026: only code 4 stopped an upgrade, so code 1 (the icon refused, or ended by crashing)
    let it copy over a running program file. The tray program's --exit answers 0 (closed, also when no icon is running), 1
    (refused or failed), 2 (bad usage), 3 (no icon running), 4 (did not answer in time)."""
    close = _pascal("CloseTrayIcon")
    code = _without_comments(close)
    # the rule, and nothing else, decides: no other code is named, and the old test for 4 alone is gone
    assert "Result := (Code = 0) or (Code = 3);" in code
    assert not re.search(r"Code = [124]\b", code) and "Code = 4" not in code
    # a program that could not even be started is not an answer: the icon may still run, so it counts as not closed
    started_branch = code[code.index("  else\n  begin\n    Result := False;"):]
    assert "Could not run" in started_branch and "treated as not closed" in started_branch
    # the decision is logged with its values (the code, the milliseconds, the verdict)
    assert "--exit returned %d after %d ms; the icon is treated as closed: %d." in code
    # a missing tray program is the one case with nothing to close: it starts from True and returns before running anything
    assert code.index("Result := True;") < code.index("if not FileExists(TrayPath) then") < code.index("Exec(TrayPath, '--exit'")
    # an upgrade stops before copying anything, with a message that says the icon could not be closed and how to close it
    prepare = _pascal("PrepareToInstall")
    _ordered(prepare, "if not CloseTrayIcon(InstalledApp) then", "could not be closed", "right-click the icon", 'choose "Close this icon"', "run this setup program again", "Nothing was changed.", "Exit;")
    # in a maintenance mode the icon is left running and not closed at all
    assert "if RunMode = '' then" in prepare


def test_the_secret_file_is_held_open_against_deletion_for_the_length_of_the_run_and_closed_before_the_wizards_own_delete():
    hold = _pascal("HoldFileAgainstDeletion")
    # read access only and read sharing only: fmShareDenyWrite is the Windows share mode FILE_SHARE_READ, with no delete sharing
    assert "TFileStream.Create(FileName, fmOpenRead or fmShareDenyWrite)" in hold
    for wider in ("fmShareDenyNone", "fmShareExclusive", "fmCreate", "fmOpenWrite", "fmOpenReadWrite", "fmShareDenyRead"):
        assert wider not in hold, wider
    # a hold that cannot be taken is logged with its reason, returns nil and never raises
    assert "except" in hold and "Result := nil;" in hold and "Could not hold the pairing secret file open against deletion: ' + GetExceptionMessage" in hold
    release = _pascal("ReleaseSecretHold")
    assert "if SecretHold <> nil then" in release and "SecretHold.Free;" in release and "SecretHold := nil;" in release
    assert "SecretHold: TFileStream;" in _code()
    # the order in the run: written, held, the script runs, the hold ends right after it exits and before the log line of
    # the finish, and again (a no-op) in the finally, before the wizard's own delete
    run = _pascal("RunSatelliteSetup")
    _ordered(run, "SaveStringToFile(SecretPath", "SecretHold := HoldFileAgainstDeletion(SecretPath)", "ExecAndLogOutput", "ReleaseSecretHold;",
             "Run finished: exit code", "  finally", "ReleaseSecretHold;", "DeleteFile(SecretPath)")
    first_release = run.index("ReleaseSecretHold;")
    assert run.index("ExecAndLogOutput") < first_release < run.index("  finally")
    # the first release follows the script's own try/except directly (nothing between the except block and it but a comment)
    between = run[run.index("The setup script run raised"):first_release]
    assert not re.search(r"\b(DeleteFile|SaveStringToFile|Sleep)\b", between)
    # the hold is a handle, never the secret: the value and its box are not touched by either function
    for body in (hold, release):
        assert not re.search(r"SecretValue|PairSecret", body)


@needs_powershell
def test_a_read_only_handle_with_read_sharing_lets_programs_read_the_file_but_not_delete_rename_or_write_it(tmp_path):
    """The Windows facts the hold rests on, shown with the same share mode the Pascal Script stream asks for (read access,
    FILE_SHARE_READ and no FILE_SHARE_DELETE): another program can read the file, even one that opens it with every share
    flag, as a file server does; it cannot delete, rename or write it; once the handle is closed the delete works.
    This proves the mechanism on this Windows, not Inno's stream class itself (the live run does that)."""
    secret = tmp_path / "pairing-secret.tmp"
    secret.write_bytes(b"0" * 64)
    script = tmp_path / "hold.ps1"
    script.write_text(
        "param([string]$Path)\n"
        "$ErrorActionPreference = 'Stop'\n"
        "function Try-It([string]$What, [scriptblock]$Do) { try { & $Do | Out-Null; \"$What=ok\" } catch { \"$What=refused\" } }\n"
        "$hold = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)\n"
        "Try-It 'read' { [IO.File]::ReadAllText($Path).Length }\n"
        "Try-It 'read-every-share' { $s = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite, Delete'); $s.Dispose() }\n"
        "Try-It 'delete' { [IO.File]::Delete($Path) }\n"
        "Try-It 'rename' { [IO.File]::Move($Path, $Path + '.moved') }\n"
        "Try-It 'write' { [IO.File]::AppendAllText($Path, 'x') }\n"
        "Try-It 'still-there' { if (-not (Test-Path -LiteralPath $Path)) { throw 'gone' } }\n"
        "$hold.Dispose()\n"
        "Try-It 'delete-after-close' { [IO.File]::Delete($Path) }\n"
        "Try-It 'gone-after-close' { if (Test-Path -LiteralPath $Path) { throw 'still there' } }\n",
        encoding="ascii")
    done = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), str(secret)],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stdout + done.stderr
    outcome = dict(line.split("=", 1) for line in done.stdout.split() if "=" in line)
    assert outcome == {"read": "ok", "read-every-share": "ok", "delete": "refused", "rename": "refused", "write": "refused",
                       "still-there": "ok", "delete-after-close": "ok", "gone-after-close": "ok"}, done.stdout


def test_the_new_certificate_page_starts_with_the_extra_address_saved_at_first_setup():
    wizard = _pascal("InitializeWizard")
    # the box is created, then filled from the state file's ADDRESS (StateAddress), before the page's other controls
    _ordered(wizard, "CertPage := CreateInputQueryPage(PortPage.ID, 'New certificate'", "CertPage.Add('Extra address (optional;", "CertPage.Values[0] := StateAddress;",
             "CertAddressMemo := TNewMemo.Create(CertPage)")
    # StateAddress is that state file's ADDRESS key, read by LoadState in InitializeSetup, which Inno runs before InitializeWizard
    assert "StateAddress := FileValue(FileName, 'ADDRESS')" in _pascal("LoadState")
    assert "LoadState(InstalledApp)" in _pascal("InitializeSetup")
    # the list under the box shows what the certificate will name WITH that address, and a typed one replaces it at Next
    changed = _pascal("CurPageChanged")
    cert = changed[changed.index("CurPageID = CertPage.ID"):changed.index("CurPageID = PairPage.ID")]
    assert "Extra := AddressArgument(CertPage.Values[0])" in cert and "RunPlan(ChosenRoot, Extra)" in cert
    assert "ChosenAddress := Trim(CertPage.Values[0])" in _pascal("ValidateCertificatePage")
    # only the new-certificate run takes the typed value: every other run passes the recorded one, as before
    assert "if RunMode <> 'newcertificate' then ChosenAddress := StateAddress" in _pascal("PrepareChoices")
    assert "' -NewCertificate' + AddressArgument(ChosenAddress)" in _pascal("BuildScriptArguments")


def test_a_program_folder_the_script_cannot_use_stops_setup_at_the_start_with_the_folder_the_reason_and_the_dir_way_out():
    problem = _pascal("ProgramFolderProblem")
    # the three characters the script refuses in the secret file's path, each named in the message
    assert "Pos('''', Dir) > 0" in problem and "What := 'an apostrophe'" in problem
    assert "Pos(',', Dir) > 0" in problem and "What := 'a comma'" in problem
    assert "HasLineBreak(Dir)" in problem and "What := 'a line break'" in problem
    # one message: names the folder, says why, and says setup can be started with /DIR="<another folder>"
    message = problem[problem.index("Result := '{#AppName} cannot be set up in this program folder:'"):]
    for needle in ("Dir", "The folder path contains ' + What", "the setup script refuses such a path for the file that carries the pairing secret",
                   "/DIR=\"C:\\VocalisSatellite\"", "/DIR=\"<another folder>\"", "Nothing was changed."):
        assert needle in message, needle
    assert "ExtractFileName(ExpandConstant('{srcexe}'))" in message  # the example uses the setup program's own file name
    # the decision is logged with its values
    assert "Program folder \"%s\": problem \"%s\"." in problem
    # it is the first thing InitializeSetup does after the mode and the install are known, before any page or any change
    start = _pascal("InitializeSetup")
    _ordered(start, "InstalledHere := RegQueryStringValue", "Problem := ProgramFolderProblem(ProgramFolderCandidate)", "SuppressibleMsgBox(Problem, mbError, MB_OK, IDOK)",
             "Result := False;", "Exit;", "if RunMode <> '' then", "InstalledVersionIsNewer(InstalledVersionText)", "RunPlan(StateRoot, '')")
    # where the program files will go before the wizard exists: /DIR=, else the earlier install's folder, else the default
    candidate = _pascal("ProgramFolderCandidate")
    _ordered(candidate, "{param:DIR|}", "InstalledApp", "{localappdata}\\Programs\\{#ProgramFolder}")
    # and the real folder is checked again once the wizard has settled it, before anything is copied
    prepare = _pascal("PrepareToInstall")
    assert prepare.index("ProgramFolderProblem(ExpandConstant('{app}'))") < prepare.index("CloseTrayIcon(InstalledApp)")


def test_an_upgrade_or_a_mode_whose_saved_satellite_folder_is_on_a_missing_drive_says_so_and_how_to_go_on():
    start = _pascal("InitializeSetup")
    # applies to an upgrade and to every maintenance mode: the branch is taken whenever the install recorded a folder
    branch = start[start.index("if InstalledHere and (StateRoot <> '') then\n  begin\n    ChosenRoot := StateRoot;"):]
    _ordered(branch, "DirExists(ExtractFileDrive(StateRoot) + '\\')", "on a drive that is not available now", "Reconnect that drive", "uninstall {#AppName} first",
             "choose another folder", "Nothing was changed.", "Result := False;", "Exit;", "RunPlan(StateRoot, '')")
    assert "The drive of the saved satellite folder \"%s\" is not there." in branch  # logged with the folder
    # the script's plan is never asked about a drive that is not there, so the plain message is the one that is shown
    assert branch.index("DirExists(ExtractFileDrive(StateRoot)") < branch.index("RunPlan(StateRoot, '')")


def test_a_lower_version_is_refused_by_the_main_installers_ordering_not_a_second_implementation():
    compare = _pascal("InstalledVersionIsNewer")
    assert "-Action compare-version" in compare and "Result := ResultCode = 42" in compare
    assert compare.index("EnsureComposeHelper;") < compare.index("ExtractTemporaryFile('vocalis-control.ps1')")
    assert "ExpandConstant('{tmp}\\vocalis-control.ps1')" in compare
    start = _pascal("InitializeSetup")
    assert "InstalledVersionIsNewer(InstalledVersionText)" in start and "Setup does not roll a satellite back to an older version." in start
    # the control script is not edited and not copied: the same file the main installer uses is the source
    sources = [source for source, flags, *_ in _files() if "dontcopy" in flags]
    assert "vocalis-control.ps1" in sources and "..\\windows-compose.ps1" in sources
    assert "function Compare-VocalisVersion" not in _iss_text()


@needs_powershell
def test_the_comparison_the_setup_program_runs_refuses_exactly_a_higher_installed_version(tmp_path):
    extracted = tmp_path / "extracted tmp"
    extracted.mkdir()
    shutil.copy(WINDOWS / "vocalis-control.ps1", extracted / "vocalis-control.ps1")
    shutil.copy(PACKAGING / "windows-compose.ps1", extracted / "windows-compose.ps1")
    for installed, new, expected in (("12.0.0-M2", "12.0.0-M1", 42), ("12.0.0", "12.0.0-M9", 42), ("12.0.0-M1", "12.0.0-M2", 40),
                                     ("12.0.0-M1", "12.0.0-M1", 41), ("12.0.1", "12.0.0", 42)):
        result = subprocess.run(
            [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(extracted / "vocalis-control.ps1"), "-Action", "compare-version",
             "-InstalledVersion", installed, "-NewVersion", new], capture_output=True, text=True, timeout=60)
        assert result.returncode == expected, (installed, new, result.stdout + result.stderr)


# ---- the build script ------------------------------------------------------------------------------------

def test_the_build_script_keeps_the_main_builds_safety_rules_and_adds_the_satellite_ones():
    ps = BUILD_PS1.read_text(encoding="ascii")
    for needle in ("Refusing to overwrite existing package artifact", ".sha256", ".files.json", "--locked-mode", "InnoSetupCompiler", "signing.local.json",
                   "azurecodesign", "Get-PublishedReferenceProblem", "compiled vocalis-satellite.iss with no warnings", "Vocalis.InstallerBuild.csproj"):
        assert needle in ps, needle
    # the tray program: locked restore, Release build, its unit tests, then packed; a signed build signs a copy first
    _ordered(ps, "Tray restore", "'--locked-mode'", "Tray build", "'-c', 'Release'", "Tray tests", "'test'", "ProcessStartInfo")
    assert "VocalisSatelliteTray.csproj" in ps and r"bin\Release\net48\VocalisSatelliteTray.exe" in ps
    # the tray's assembly version is the product version's numeric part (12.0.0 for 12.0.0-M1)
    assert "$TrayVersion = $Version -replace '-M\\d+$', ''" in ps and '"-p:Version=$TrayVersion"' in ps
    assert "Copy-Item -LiteralPath $TrayExe -Destination $PackedTrayExe" in ps and "-Files @($PackedTrayExe)" in ps
    assert "$Environment.VOCALIS_SATELLITE_TRAY_EXE = $PackedTrayExe" in ps
    # signing paths and accounts are never in the repository
    for text in (ps, ISS.read_text(encoding="ascii")):
        assert not re.search(r"(?i)(tenant|client[_-]?secret|endpoint\s*=|CertificateProfile|AZURE_)", text)
    # the image is baked in as a reference; the pinned compiler project is the main build's
    assert "VOCALIS_SATELLITE_IMAGE = $SatelliteImage" in ps
    csproj = (WINDOWS / "Vocalis.InstallerBuild.csproj").read_text(encoding="utf-8")
    assert 'Include="Tools.InnoSetup" Version="6.7.3"' in csproj and "<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>" in csproj


def test_the_reference_rule_and_the_helpers_are_the_main_builds_copied_exactly():
    satellite = BUILD_PS1.read_text(encoding="ascii")
    main = MAIN_BUILD_PS1.read_text(encoding="ascii")
    for pattern in (r"\$DigestReferencePattern = '[^']+'", r"\$VersionPattern = '[^']+'"):
        assert re.search(pattern, satellite).group(0) == re.search(pattern, main).group(0)
    for name in ("Test-DigestReference", "Get-ImageRegistryHost", "Get-PublishedReferenceProblem", "Get-ReferenceDigest", "Get-VocalisVersion",
                 "Get-VersionInfoVersion", "ConvertTo-ArgumentString", "Resolve-OutputRoot"):
        pattern = rf"^function {re.escape(name)}\b.*?^}}$"
        copy = re.search(pattern, satellite, re.MULTILINE | re.DOTALL)
        original = re.search(pattern, main, re.MULTILINE | re.DOTALL)
        assert copy and original, name
        assert copy.group(0) == original.group(0), f"{name} differs from build-installer.ps1"


@needs_powershell
def test_the_build_accepts_and_refuses_the_same_references_as_the_main_build(tmp_path):
    result = _run_ps(tmp_path, BUILD_PS1, "[pscustomobject]@{ r = @($Data | ForEach-Object { Test-DigestReference $_ }) } | ConvertTo-Json -Compress",
                     functions=("Test-DigestReference",), variables=("DigestReferencePattern",), data=[case for case, _ in DIGEST_CASES])
    assert result["r"] == [expected for _, expected in DIGEST_CASES]


@needs_powershell
def test_a_signed_build_refuses_references_without_a_published_registry_host(tmp_path):
    cases = {
        f"vocalis-satellite@sha256:{DIGEST}": "no registry host",
        f"library/vocalis-satellite@sha256:{DIGEST}": "no registry host",
        f"localhost:5000/vocalis-satellite@sha256:{DIGEST}": "on this machine",
        f"127.0.0.1:5000/vocalis-satellite@sha256:{DIGEST}": "on this machine",
        f"ghcr.io/example/vocalis-satellite@sha256:{DIGEST}": None,
    }
    result = _run_ps(tmp_path, BUILD_PS1,
                     "[pscustomobject]@{ r = @($Data | ForEach-Object { [string](Get-PublishedReferenceProblem $_) }) } | ConvertTo-Json -Compress",
                     functions=("Get-ImageRegistryHost", "Get-PublishedReferenceProblem"), data=list(cases))
    for reference, problem, expected in zip(cases, result["r"], cases.values()):
        if expected is None:
            assert problem == "", (reference, problem)
        else:
            assert expected in problem, (reference, problem)


@needs_powershell
def test_the_output_folder_version_and_test_identity_helpers(tmp_path):
    base = str(tmp_path / "packaging" / "windows")
    absolute = str(tmp_path / "elsewhere" / "out")
    tts = tmp_path / "tts_utils.py"
    tts.write_text('import os\nVERSION = "12.0.0-M1"\n', encoding="ascii")
    body = (f"[pscustomobject]@{{ rel = (Resolve-OutputRoot '{base}' '..\\..\\artifacts\\windows'); abs = (Resolve-OutputRoot '{base}' '{absolute}'); "
            f"version = (Get-VocalisVersion '{tts}'); info = (Get-VersionInfoVersion '12.0.0-M1'); "
            "g1 = (Get-TestIdentityGuid 'abc'); g2 = (Get-TestIdentityGuid 'abd'); g3 = (Get-TestIdentityGuid 'abc'); "
            "ok = @('abc', 'e2e', 'a1b2c3', 'abcdefghijklmnop') | ForEach-Object { $_ -cmatch $TestIdentityPattern }; "
            "bad = @('', 'ABC', 'a b', 'a-b', 'abcdefghijklmnopq', \"abc`n\") | ForEach-Object { $_ -cmatch $TestIdentityPattern } } | ConvertTo-Json -Compress")
    result = _run_ps(tmp_path, BUILD_PS1, body, functions=("Resolve-OutputRoot", "Get-VocalisVersion", "Get-VersionInfoVersion", "Get-TestIdentityGuid"),
                     variables=("VersionPattern", "TestIdentityPattern"))
    assert result["rel"] == str(tmp_path / "artifacts" / "windows") and result["abs"] == absolute
    assert result["version"] == "12.0.0-M1" and result["info"] == "12.0.0.0"
    assert result["g1"] == _test_guid("abc") == result["g3"] and result["g2"] == _test_guid("abd") and result["g1"] != result["g2"] != REAL_GUID
    assert re.fullmatch(r"[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}", result["g1"])
    assert all(result["ok"]) and not any(result["bad"])


@needs_powershell
def test_the_driver_derives_the_same_test_identity_app_id_as_the_build_script(tmp_path):
    function = re.search(r"^function Get-TestIdentityGuid.*?^}$", DRIVER.read_text(encoding="ascii"), re.MULTILINE | re.DOTALL).group(0)
    build_function = re.search(r"^function Get-TestIdentityGuid.*?^}$", BUILD_PS1.read_text(encoding="ascii"), re.MULTILINE | re.DOTALL).group(0)
    assert function == build_function  # one derivation, copied
    result = _run_ps(tmp_path, DRIVER, "[pscustomobject]@{ g = (Get-TestIdentityGuid 'abc') } | ConvertTo-Json -Compress", functions=("Get-TestIdentityGuid",))
    assert result["g"] == _test_guid("abc")


def _mini_tree(root: Path, *, icons: bool, everything: bool, pictures: bool = True) -> Path:
    windows = root / "packaging" / "windows"
    windows.mkdir(parents=True)
    (root / "source" / "vocalis" / "src").mkdir(parents=True)
    (root / "source" / "vocalis" / "src" / "tts_utils.py").write_text('VERSION = "12.0.0-M1"\n', encoding="ascii")
    shutil.copy(BUILD_PS1, windows)
    shutil.copy(ICON, windows)
    if icons:
        for name in ICON_NAMES[1:]:
            shutil.copy(ICON, windows / name)
    if everything:
        shutil.copy(ISS, windows)
        shutil.copy(WINDOWS / "wizard-header-picture.iss", windows)
        shutil.copy(WINDOWS / "satellite-log-tail.ps1", windows)
        if pictures:
            for name in WIZARD_PICTURES:
                shutil.copy(WINDOWS / name, windows / name)
        shutil.copy(WINDOWS / "vocalis-control.ps1", windows)
        (root / "packaging" / "satellite").mkdir()
        shutil.copy(PACKAGING / "windows-compose.ps1", root / "packaging")
        shutil.copy(PACKAGING / "satellite" / "satellite-setup.ps1", root / "packaging" / "satellite")
        shutil.copy(PACKAGING / "satellite" / "README.md", root / "packaging" / "satellite")
        shutil.copy(REPO / "LICENSE", root)
    return windows / "build-satellite-installer.ps1"


def _run_build(script: Path, *arguments: str):
    result = subprocess.run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), *arguments],
                            capture_output=True, text=True, timeout=180)
    return result.returncode, re.sub(r"\s+", " ", result.stdout + result.stderr)


@needs_powershell
def test_the_build_refuses_a_missing_icon_a_missing_tray_project_a_bad_reference_and_a_signed_test_identity(tmp_path):
    reference = f"ghcr.io/example/vocalis-satellite@sha256:{DIGEST}"
    out = str(tmp_path / "out")
    # a missing icon (the build names the file and says what writes it)
    code, text = _run_build(_mini_tree(tmp_path / "a", icons=False, everything=False), "-SatelliteImage", reference, "-OutputDirectory", out)
    assert code != 0 and "Icon file is missing:" in text and "vocalis-satellite-stopped.ico" in text and "make_icon.py" in text, text
    # all three icons but a wizard picture the .iss names is missing (the build names the file and says what writes it)
    code, text = _run_build(_mini_tree(tmp_path / "e", icons=True, everything=True, pictures=False), "-SatelliteImage", reference, "-OutputDirectory", out)
    assert code != 0 and "Wizard picture is missing:" in text and "vocalis-wizard-small-58.png" in text and "make_icon.py" in text, text
    # all three icons but no tray project: the build stops before packing anything, and says which file it wants
    code, text = _run_build(_mini_tree(tmp_path / "b", icons=True, everything=True), "-SatelliteImage", reference, "-OutputDirectory", out)
    assert code != 0 and "The tray project is missing:" in text and "VocalisSatelliteTray.csproj" in text, text
    assert not (tmp_path / "out").exists() or not list((tmp_path / "out").glob("*.exe"))
    # a reference that is not name@sha256:<64 hex>
    code, text = _run_build(_mini_tree(tmp_path / "c", icons=True, everything=True), "-SatelliteImage", "vocalis-satellite:latest", "-OutputDirectory", out)
    assert code != 0 and "-SatelliteImage must be name@sha256:<64 hex digits>" in text, text
    # a test identity is never signed; a bad word is refused; both before anything else happens
    script = _mini_tree(tmp_path / "d", icons=True, everything=True)
    code, text = _run_build(script, "-SatelliteImage", reference, "-TestIdentity", "abc", "-SignToolPath", "x", "-DlibPath", "y", "-MetadataPath", "z")
    assert code != 0 and "are for tests and are never signed" in text, text
    code, text = _run_build(script, "-SatelliteImage", reference, "-TestIdentity", "Not A Word", "-OutputDirectory", out)
    assert code != 0 and "-TestIdentity must be one lowercase word" in text, text
    # signing needs all three paths
    code, text = _run_build(script, "-SatelliteImage", reference, "-SignToolPath", "x")
    assert code != 0 and "Signed builds require all three" in text, text


@needs_powershell
def test_the_build_lists_what_the_script_installs_and_resolves_the_tray_program(tmp_path):
    body = (f"[pscustomobject]@{{ r = @(Get-SatelliteIssPackagedFiles '{ISS}' 'C:\\tray\\VocalisSatelliteTray.exe' | ForEach-Object "
            "{ [pscustomobject]@{ name = $_.InstalledAs; source = $_.Source; path = [string]$_.FullPath } }) } | ConvertTo-Json -Compress")
    result = _run_ps(tmp_path, BUILD_PS1, body, functions=("Get-SatelliteIssPackagedFiles",))["r"]
    assert [entry["name"] for entry in result] == [
        "satellite-setup.ps1", "VocalisSatelliteTray.exe", "satellite-log-tail.ps1", "Vocalis-Satellite-Setup.exe", "Vocalis-Satellite-Guide.md", "LICENSE",
        "vocalis.ico", "vocalis-satellite-stopped.ico", "vocalis-satellite-nodocker.ico"]
    by_name = {entry["name"]: entry for entry in result}
    assert by_name["VocalisSatelliteTray.exe"]["path"] == "C:\\tray\\VocalisSatelliteTray.exe"
    assert by_name["Vocalis-Satellite-Setup.exe"]["path"] == ""  # the setup program itself: hashed once it exists
    assert Path(by_name["satellite-setup.ps1"]["path"]) == (PACKAGING / "satellite" / "satellite-setup.ps1").resolve()
    assert Path(by_name["Vocalis-Satellite-Guide.md"]["path"]) == (PACKAGING / "satellite" / "README.md").resolve()


# ---- the driver and the acceptance tool ----------------------------------------------------------------------

def test_the_driver_is_for_test_identity_builds_only_never_logs_the_secret_and_never_presses_copy():
    text = DRIVER.read_text(encoding="ascii")
    assert "[Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{1,16}$')][string]$TestIdentity" in text
    assert "VOCALIS_SATELLITE_TEST_NO_SHELL = '1'" in text
    # the secret is read into memory, typed with a window message, and only its length is logged
    for line in text.splitlines():
        if "Write-Step" in line and "$secret" in line:
            assert ".Length" in line, line
    assert "Set-Text $box $secret" in text and "SecretFile" in text
    # no Copy button is ever pressed (the hidden desktop shares the clipboard with the visible one)
    assert not re.search(r"Invoke-Button \$\w+ '\^?(Copy|Show the file)", text)
    # every page the .iss has a handler for
    for phrase in ("A satellite lets Vocalis", "The satellite needs Docker Desktop", "Where should the satellite keep its files",
                   "Which port should the satellite use", "Make a new certificate for the satellite", "Give the satellite the secret Vocalis shows",
                   "Ready to Install", "Setting up the satellite", "Setup did not finish", "'^Retry'"):
        assert phrase in text, phrase
    iss = _iss_text()
    for phrase in ("Where should the satellite keep its files?", "Which port should the satellite use, and what is it called?",
                   "Make a new certificate for the satellite.", "Give the satellite the secret Vocalis shows.", "The satellite needs Docker Desktop"):
        assert phrase in iss, phrase
    # only processes it started are stopped, by PID
    assert "Stop-Process -Id $id" in text and "Stop-Process -Name" not in text


def test_the_acceptance_tool_takes_the_fingerprint_from_a_setup_result_file(tmp_path):
    source = ACCEPTANCE.read_text(encoding="utf-8")
    tree = ast.parse(source)
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "result_file_value")
    namespace = {"Path": Path}
    exec(compile(ast.Module([function], []), str(ACCEPTANCE), "exec"), namespace)  # only this one function; the module imports a browser driver
    result = tmp_path / "setup-result.txt"
    fingerprint = ":".join(["AB"] * 32)
    result.write_bytes(b"\xef\xbb\xbfSCHEMA=1\r\nNAME=x\r\nFINGERPRINT=" + fingerprint.encode() + b"\r\nLOG_FILE=a=b\r\n")
    assert namespace["result_file_value"](result, "FINGERPRINT") == fingerprint
    assert namespace["result_file_value"](result, "LOG_FILE") == "a=b"
    assert namespace["result_file_value"](result, "MISSING") == ""
    # the option exists beside --fingerprint, neither required alone, and exactly one of the two is accepted
    assert '--setup-result' in source and 'p.add_argument("--fingerprint", help=' in source
    assert "give exactly one of --fingerprint and --setup-result" in source and "FINGERPRINT" in source
    assert "required=True, help=\"AA:BB:... as the setup script printed it\"" not in source


# ---- the source offer ---------------------------------------------------------------------------------------

def test_the_source_offer_allowlist_lists_the_new_shipped_files_and_matches_the_checkout():
    allowlist = json.loads(ALLOWLIST.read_text(encoding="utf-8"))
    files = allowlist["files"]
    assert files == sorted(set(files), key=lambda value: value.encode("utf-8"))
    for path in ("packaging/windows/vocalis-satellite.iss", "packaging/windows/build-satellite-installer.ps1",
                 "packaging/tests/test_satellite_windows_installer.py", "packaging/windows/tests/drive_satellite_installer.ps1",
                 "packaging/windows/tests/acceptance_satellite.py"):
        assert path in files, path
        assert (REPO / path).is_file(), path
    if shutil.which("git") is None:
        pytest.skip("the inventory comparison needs git (the Linux test container has none); the listing above was checked")
    # the allowlist is exact: the build_source_offer.py inventory (tracked and untracked, not ignored) equals it, so a new
    # shipped file that is not listed here (the tray project's, the two tray icons) fails this test instead of the release build
    spec = importlib.util.spec_from_file_location("vocalis_build_source_offer", PACKAGING / "source-offer" / "build_source_offer.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    inventory = module.selected_file_inventory(allowlist["roots"])
    missing = sorted(set(files) - set(inventory))
    unlisted = sorted(set(inventory) - set(files))
    assert missing == [] and unlisted == [], f"allowlist stale: listed but absent {missing}; present but unlisted {unlisted}"
    # and every listed file passes the source offer's own checks (no symlink, no development-machine path)
    records = module.validate_sources(REPO, files)
    assert len(records) == len(files)
