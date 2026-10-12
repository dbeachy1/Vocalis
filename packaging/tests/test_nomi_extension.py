"""The Nomi browser extension as it ships in the main image and in the download on the Nomi tab.

(2026-10-11) The folder held no icon files although the manifest names three, twice. Chrome refuses to load
an unpacked extension when a file its manifest names is missing, so the extension could not be installed from
this package at all. The icons are drawn by packaging/windows/make_icon.py (the same V as the web page's own
icon), and these tests keep the manifest and the folder in agreement.
"""
import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
EXTENSION = ROOT / "source" / "vocalis" / "nomi" / "chrome_extension"


def _manifest():
    return json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))


def _named_files(manifest):
    names = set(manifest.get("icons", {}).values())
    names |= set(manifest.get("action", {}).get("default_icon", {}).values())
    names.add(manifest["options_ui"]["page"])
    for script in manifest["content_scripts"]:
        names |= set(script.get("js", [])) | set(script.get("css", []))
    return names


def test_every_file_the_manifest_names_is_in_the_folder():
    names = _named_files(_manifest())
    assert {"icons/icon16.png", "icons/icon48.png", "icons/icon128.png", "content.js", "options.html"} <= names
    missing = sorted(name for name in names if not (EXTENSION / name).is_file())
    assert missing == []


def test_the_icons_are_the_ones_the_icon_script_draws_at_the_sizes_the_manifest_gives(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image
    spec = importlib.util.spec_from_file_location("make_icon", ROOT / "packaging" / "windows" / "make_icon.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.NOMI_ICON_DIRECTORY == EXTENSION / "icons"
    manifest = _manifest()
    assert manifest["icons"] == manifest["action"]["default_icon"]
    assert manifest["icons"] == {str(size): f"icons/{module.nomi_icon_name(size)}" for size in module.NOMI_ICON_SIZES}
    drawn = module.build_nomi_extension_icons(tmp_path)
    assert [path.name for path in drawn] == [module.nomi_icon_name(size) for size in module.NOMI_ICON_SIZES]
    for size, path in zip(module.NOMI_ICON_SIZES, drawn):
        committed = Image.open(EXTENSION / "icons" / path.name).convert("RGBA")
        fresh = Image.open(path).convert("RGBA")
        assert committed.size == (size, size)
        # Pixels, not bytes: another Pillow may compress the same picture differently.
        assert committed.tobytes() == fresh.tobytes()
    # The orange V on the dark square: the middle of the left arm's cap at 128 px (18,18 of 64).
    assert Image.open(EXTENSION / "icons" / "icon128.png").convert("RGBA").getpixel((36, 36)) == (0xFF, 0x7A, 0x18, 255)
