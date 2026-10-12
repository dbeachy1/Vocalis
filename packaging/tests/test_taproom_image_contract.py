"""Static contract tests for the Taproom image inputs (the extension folder names, the embedding model and the MCP client
import, as settled on October 10, 2026). No Docker, no network: they read the files the image build
reads, so a drifted model name, a stale license file or an old extension folder name fails here before a build.
"""

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

PACKAGING = Path(__file__).resolve().parents[1]
REPO = PACKAGING.parent
MODEL = "Xenova/multi-qa-mpnet-base-cos-v1"
OBSERVED_HEAD = "342c63cb07c8b4f462b14318f1cdbc626d84faeb"

DOCKERFILE = (PACKAGING / "taproom" / "Dockerfile").read_text(encoding="utf-8")
CONFIG = (PACKAGING / "taproom" / "config.yaml").read_text(encoding="utf-8")
MANIFEST = json.loads((PACKAGING / "models" / "mnemosyne" / "manifest.json").read_text(encoding="utf-8"))
ALLOWLIST = json.loads((PACKAGING / "source-offer" / "allowlist.json").read_text(encoding="utf-8"))


def tracked_mcp_client_files():
    """The files tracked under source/mcp-client. A local npm build leaves gitignored outputs (dist/, plugin/index.bundle.js,
    node_modules) in the same folder, so a folder listing is not the imported source; skip cleanly outside a checkout."""
    tool = shutil.which("git")
    if not tool:
        pytest.skip("git is not available")
    result = subprocess.run([tool, "ls-files", "--", "source/mcp-client"], cwd=REPO, capture_output=True, text=True, timeout=60)
    if result.returncode != 0 or not result.stdout.strip():
        pytest.skip("not a checkout of the repository")
    return sorted(line for line in result.stdout.splitlines() if line)


def active_lines(text):
    """The YAML lines that are not comments."""
    return [line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def test_config_embedding_is_multi_qa_and_unpinned():
    active = "\n".join(active_lines(CONFIG))
    assert re.search(rf"^\s+embedding: {re.escape(MODEL)}\s*$", active, re.MULTILINE)
    # No revision key at all: a pin would be cached under <model>/<revision>/ and miss the copy an adopted store holds.
    assert "embeddingRevision" not in active
    assert "all-mpnet" not in active


def test_mnemosyne_package_records_the_configured_model_without_all_mpnet_provenance():
    folder = PACKAGING / "models" / "mnemosyne"
    assert MANIFEST["repository"] == MODEL
    assert MANIFEST["revision"] is None
    assert MANIFEST["observed_head_revision"] == OBSERVED_HEAD
    assert MANIFEST["license"]["identifier"] is None
    assert MANIFEST["acquisition"]["weights_shipped"] is False
    assert not (folder / "LICENSE").exists(), "the all-mpnet Apache text does not apply to the configured model"
    for path in folder.iterdir():
        text = path.read_text(encoding="utf-8")
        # The superseded all-mpnet selection may be named as history, never as the current selection.
        assert "e086c5e0b3a57b0ce46dd6d9c0662948860b35f3" not in text or path.name == "manifest.json"
    files = {item["path"]: item for item in MANIFEST["files"]}
    assert set(files) == {
        "config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt",
        "onnx/model_quantized.onnx",
    }
    for item in files.values():
        assert re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
        assert f"/resolve/{OBSERVED_HEAD}/{item['path']}" in item["url"]


def test_no_model_weight_is_listed_for_the_source_offer():
    models = sorted(p for p in ALLOWLIST["files"] if p.startswith("packaging/models/mnemosyne/"))
    assert models == ["packaging/models/mnemosyne/NOTICE.md", "packaging/models/mnemosyne/manifest.json"]
    assert "packaging/models/mnemosyne/LICENSE" not in ALLOWLIST["files"]


def test_bundled_extensions_use_the_established_folder_names():
    copies = re.findall(r"^COPY .* \./public/scripts/extensions/third-party/(\S+?)/?$", DOCKERFILE, re.MULTILINE)
    assert "taproom-cache-lens" in copies
    assert "Vocalis" in copies
    assert "sillytavern-mcp-client" in copies
    assert "cachelens" not in copies
    assert "vocalis" not in copies
    assert "third-party/cachelens/" not in "\n".join(active_lines(DOCKERFILE))
    assert "third-party/vocalis/" not in "\n".join(active_lines(DOCKERFILE))


def test_mcp_client_is_built_from_imported_source_and_installed_where_taproom_loads_plugins():
    active = "\n".join(active_lines(DOCKERFILE))
    assert "FROM base AS mcp-client-build" in active
    assert "/payload/source/mcp-client/" in active
    assert "npm ci --include=dev --ignore-scripts" in active
    assert "npm run build" in active
    assert "./plugins/mcp-client/" in active
    assert "index.bundle.js" in active
    # Never an upstream-committed bundle: the plugin entry is the committed shim, the bundle comes from the build.
    tracked = tracked_mcp_client_files()
    for built in ("dist/index.iife.js", "plugin/index.bundle.js"):
        assert f"source/mcp-client/{built}" not in tracked


def test_mcp_client_files_are_in_the_source_offer():
    assert "source/mcp-client" in ALLOWLIST["roots"]
    files = set(ALLOWLIST["files"])
    for required in (
        "source/mcp-client/LICENSE",
        "source/mcp-client/DOWNSTREAM-CHANGES.md",
        "source/mcp-client/plugin/index.js",
        "source/mcp-client/server-plugin/src/hardening.ts",
        "source/mcp-client/server-plugin/__tests__/hardening.test.ts",
        "packaging/taproom/collect-npm-notices.mjs",
    ):
        assert required in files, required
    assert tracked_mcp_client_files() == sorted(f for f in files if f.startswith("source/mcp-client/"))
