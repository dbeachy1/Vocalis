"""Tests of the satellite tray program (packaging/windows/tray), design "Satellite setup program and tray icon for
Windows" (October 11, 2026), the tray bullet and the icon bullet of its Proof.

Pure-text checks (the project names vocalis.ico as its application icon, the pinned reference assemblies, the
committed lock files, the icon script's three looks) run everywhere with Pillow. The checks that build and run the
program need the .NET SDK on Windows and are skipped only without it: locked restore, build with warnings as errors,
the xUnit project (`dotnet test packaging/windows/tray/tests`), and the icon read out of the built program and
compared pixel for pixel, at 32 pixels, with vocalis.ico.

Every dotnet run writes its whole output to a log file in pytest's temporary folder and the failure message carries
the tail of it. The program itself is never started here (the live smoke run is separate and uses the hidden desktop).
"""
from pathlib import Path
import importlib.util
import io
import os
import shutil
import struct
import subprocess

import pytest

PACKAGING = Path(__file__).resolve().parents[1]
WINDOWS = PACKAGING / "windows"
TRAY = WINDOWS / "tray"
TESTS_PROJECT = TRAY / "tests" / "VocalisSatelliteTray.Tests.csproj"
PROJECT = TRAY / "VocalisSatelliteTray.csproj"
EXE = TRAY / "bin" / "Release" / "net48" / "VocalisSatelliteTray.exe"
LOOK_FILES = ("vocalis.ico", "vocalis-satellite-stopped.ico", "vocalis-satellite-nodocker.ico")


def _dotnet():
    if os.name != "nt":
        return None
    exe = shutil.which("dotnet")
    if exe is None:
        return None
    listing = subprocess.run([exe, "--list-sdks"], capture_output=True, text=True, timeout=60)
    return exe if listing.returncode == 0 and listing.stdout.strip() else None


DOTNET = _dotnet()
needs_dotnet = pytest.mark.skipif(DOTNET is None, reason="the .NET SDK (on Windows) is required")


def _load_make_icon():
    spec = importlib.util.spec_from_file_location("vocalis_make_icon_tray", WINDOWS / "make_icon.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _dotnet_run(log_path, *args, timeout=900):
    env = dict(os.environ, DOTNET_CLI_TELEMETRY_OPTOUT="1", DOTNET_NOLOGO="1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE="1")
    with open(log_path, "wb") as log:
        done = subprocess.run([DOTNET, *map(str, args)], stdout=log, stderr=subprocess.STDOUT, env=env, timeout=timeout)
    text = Path(log_path).read_text(encoding="utf-8", errors="replace")
    return done.returncode, text


# ---- the project, as text ------------------------------------------------------------------------------------

def test_the_project_names_vocalis_ico_as_the_programs_own_icon_and_embeds_the_three_looks():
    text = PROJECT.read_text(encoding="utf-8")
    # The file icon of the program (Task Manager, Windows' Startup apps list) is the Vocalis icon, from the one source.
    assert "<ApplicationIcon>..\\vocalis.ico</ApplicationIcon>" in text
    assert (WINDOWS / "vocalis.ico").is_file()
    # The three notification-area looks are embedded, so the program needs no loose .ico files to show the right picture.
    for name in LOOK_FILES:
        assert f'<EmbeddedResource Include="..\\{name}" LogicalName="{name}" />' in text, name
        assert (WINDOWS / name).is_file(), name


def test_the_project_is_net48_windows_forms_with_pinned_reference_assemblies_and_warnings_as_errors():
    text = PROJECT.read_text(encoding="utf-8")
    assert "<TargetFramework>net48</TargetFramework>" in text
    assert "<UseWindowsForms>true</UseWindowsForms>" in text
    assert "<TreatWarningsAsErrors>true</TreatWarningsAsErrors>" in text
    assert '<PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />' in text
    assert "<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>" in text
    assert "<AssemblyName>VocalisSatelliteTray</AssemblyName>" in text
    for lock_file in (TRAY / "packages.lock.json", TRAY / "tests" / "packages.lock.json"):
        content = lock_file.read_text(encoding="utf-8")
        assert '"resolved": "1.0.3"' in content and "contentHash" in content, lock_file
    tests_text = TESTS_PROJECT.read_text(encoding="utf-8")
    assert "<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>" in tests_text
    assert "<TreatWarningsAsErrors>true</TreatWarningsAsErrors>" in tests_text


def test_the_tray_sources_are_text_with_lf_endings():
    for path in sorted(TRAY.rglob("*")):
        if not path.is_file() or any(part in ("bin", "obj") for part in path.relative_to(TRAY).parts):
            continue
        data = path.read_bytes()
        data.decode("utf-8")
        assert b"\r" not in data, path.name


# ---- the icon script's three looks ---------------------------------------------------------------------------

def test_make_icon_produces_the_three_looks_and_the_colour_one_equals_the_committed_vocalis_ico(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image
    module = _load_make_icon()
    assert set(module.LOOKS) == {"colour", "stopped", "nodocker"}
    assert [module.LOOKS[look][0] for look in ("colour", "stopped", "nodocker")] == list(LOOK_FILES)
    written = {}
    for look, (name, _stroke, _mark) in module.LOOKS.items():
        out = tmp_path / name
        sizes = module.build_icon(out, look)
        assert sizes == list(module.SIZES)
        written[look] = out.read_bytes()
    # The colour look is the existing icon, byte for byte, and every committed file is what the script makes.
    assert written["colour"] == (WINDOWS / "vocalis.ico").read_bytes()
    assert written["stopped"] == (WINDOWS / "vocalis-satellite-stopped.ico").read_bytes()
    assert written["nodocker"] == (WINDOWS / "vocalis-satellite-nodocker.ico").read_bytes()
    assert len({written["colour"], written["stopped"], written["nodocker"]}) == 3

    def frame(look, size):
        return Image.open(io.BytesIO(written[look])).ico.getimage((size, size)).convert("RGBA")

    # Same drawing, three looks: the left arm's round cap (centered at 18,18 of 64, so 72,72 at 256 px) is orange, grey,
    # grey; the small mark (lower right, over the V's bottom vertex) is only on the last.
    assert frame("colour", 256).getpixel((72, 72)) == (0xFF, 0x7A, 0x18, 255)
    assert frame("stopped", 256).getpixel((72, 72)) == (0x8B, 0x8F, 0x98, 255)
    assert frame("nodocker", 256).getpixel((72, 72)) == (0x8B, 0x8F, 0x98, 255)
    assert frame("stopped", 256).getpixel((128, 184)) == (0x8B, 0x8F, 0x98, 255)
    assert frame("stopped", 256).getpixel((225, 188))[:3] == (0x2A, 0x2D, 0x33)  # no mark on the plain grey look
    assert frame("nodocker", 256).getpixel((225, 188))[:3] == (0xE5, 0x48, 0x4D)  # the small mark, lower right (beside its "!")
    for look in written:
        assert [(w, h) for w, h in sorted(Image.open(io.BytesIO(written[look])).info["sizes"])] == [(s, s) for s in module.SIZES]


# ---- reading the icon out of the built program ----------------------------------------------------------------

def _rsrc_icons(exe_bytes):
    """The first RT_GROUP_ICON of a PE file and its RT_ICON frames, rebuilt as an .ico file (bytes)."""
    pe = struct.unpack_from("<I", exe_bytes, 0x3C)[0]
    assert exe_bytes[pe:pe + 4] == b"PE\0\0"
    count = struct.unpack_from("<H", exe_bytes, pe + 6)[0]
    optional_size = struct.unpack_from("<H", exe_bytes, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from("<H", exe_bytes, optional)[0]
    directories = optional + (112 if magic == 0x20B else 96)
    rsrc_rva, _ = struct.unpack_from("<II", exe_bytes, directories + 2 * 8)
    assert rsrc_rva, "the program has no resource section"
    sections = []
    for i in range(count):
        base = pe + 24 + optional_size + 40 * i
        virtual_size, virtual_address, raw_size, raw_pointer = struct.unpack_from("<IIII", exe_bytes, base + 8)
        sections.append((virtual_address, max(virtual_size, raw_size), raw_pointer))

    def rva_to_offset(rva):
        for address, size, pointer in sections:
            if address <= rva < address + size:
                return rva - address + pointer
        raise AssertionError(f"RVA {rva:#x} is in no section")

    root = rva_to_offset(rsrc_rva)

    def entries(offset):
        named, ids = struct.unpack_from("<HH", exe_bytes, offset + 12)
        found = []
        for i in range(named + ids):
            name, target = struct.unpack_from("<II", exe_bytes, offset + 16 + 8 * i)
            found.append((name, target))
        return found

    def leaf(target):
        """Follows sub-directories (name, then language) to the first data entry; returns its bytes."""
        offset = root + (target & 0x7FFFFFFF)
        while target & 0x80000000:
            _, target = entries(offset)[0]
            offset = root + (target & 0x7FFFFFFF)
        data_rva, size, _code_page, _reserved = struct.unpack_from("<IIII", exe_bytes, offset)
        start = rva_to_offset(data_rva)
        return exe_bytes[start:start + size]

    def by_type(wanted):
        result = {}
        for type_id, target in entries(root):
            if type_id == wanted:
                offset = root + (target & 0x7FFFFFFF)
                for resource_id, sub in entries(offset):
                    result[resource_id] = leaf(sub)
        return result

    icons = by_type(3)       # RT_ICON
    groups = by_type(14)     # RT_GROUP_ICON
    assert groups, "the program has no icon group"
    group = groups[sorted(groups)[0]]  # the lowest-numbered group is the program's own icon
    _reserved, _kind, number = struct.unpack_from("<HHH", group, 0)
    frames = []
    for i in range(number):
        width, height, colors, reserved, planes, bits, size, icon_id = struct.unpack_from("<BBBBHHIH", group, 6 + 14 * i)
        frames.append((width, height, colors, reserved, planes, bits, icons[icon_id]))
    out = io.BytesIO()
    out.write(struct.pack("<HHH", 0, 1, len(frames)))
    offset = 6 + 16 * len(frames)
    for width, height, colors, reserved, planes, bits, blob in frames:
        out.write(struct.pack("<BBBBHHII", width, height, colors, reserved, planes, bits, len(blob), offset))
        offset += len(blob)
    for *_head, blob in frames:
        out.write(blob)
    return out.getvalue()


# ---- build, unit tests, and the icon of the built program ------------------------------------------------------

@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """Locked restore of both projects, then a Release build with warnings as errors. Returns the log folder."""
    logs = tmp_path_factory.mktemp("tray-logs")
    for project in (PROJECT, TESTS_PROJECT):
        code, text = _dotnet_run(logs / f"restore-{project.stem}.log", "restore", project, "--locked-mode")
        assert code == 0, f"locked restore of {project.name} failed:\n{text[-3000:]}"
    code, text = _dotnet_run(logs / "build.log", "build", PROJECT, "-c", "Release", "--no-restore", "-warnaserror")
    assert code == 0, f"build failed:\n{text[-3000:]}"
    assert "0 Warning(s)" in text and "0 Error(s)" in text, text[-1500:]
    assert EXE.is_file()
    return logs


@needs_dotnet
def test_the_program_builds_with_a_locked_restore_and_no_warnings_as_one_file(built):
    assert EXE.stat().st_size > 20_000
    # One program file: the SDK's generated .exe.config is switched off, and nothing else is needed beside it.
    siblings = sorted(p.name for p in EXE.parent.iterdir() if p.suffix.lower() in (".exe", ".dll", ".config"))
    assert siblings == ["VocalisSatelliteTray.exe"], siblings


@needs_dotnet
def test_the_xunit_project_passes(built):
    code, text = _dotnet_run(built / "test.log", "test", TESTS_PROJECT.parent, "-c", "Release", "--no-restore")
    assert code == 0, f"dotnet test failed:\n{text[-4000:]}"
    assert "Passed!" in text and "Failed:     0" in text, text[-1500:]
    # A run that found no tests would also exit 0; the design lists every situation, so there are well over a hundred.
    total = int(text.rsplit("Total:", 1)[1].split()[0].rstrip(","))
    assert total >= 100, text[-800:]


@needs_dotnet
def test_the_built_program_carries_the_vocalis_icon_pixel_for_pixel_at_32_px(built):
    pytest.importorskip("PIL")
    from PIL import Image
    expected = Image.open(WINDOWS / "vocalis.ico").ico.getimage((32, 32)).convert("RGBA")
    rebuilt = _rsrc_icons(EXE.read_bytes())
    actual = Image.open(io.BytesIO(rebuilt)).ico.getimage((32, 32)).convert("RGBA")
    assert actual.size == expected.size == (32, 32)
    assert actual.tobytes() == expected.tobytes()
    # And every size of the committed icon is in the program, not only the one compared above.
    sizes = sorted(Image.open(io.BytesIO(rebuilt)).info["sizes"])
    assert sizes == [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]


@needs_dotnet
def test_the_built_program_embeds_the_three_looks_unchanged(built):
    data = EXE.read_bytes()
    for name in LOOK_FILES:
        assert (WINDOWS / name).read_bytes() in data, f"{name} is not embedded in the built program"
