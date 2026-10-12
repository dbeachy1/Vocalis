#!/usr/bin/env python3
"""Apply the exact DFN 0.5.6 optional-Git-metadata compatibility patch."""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

SOURCE_SHA256 = "19c39c7f3277ab13cc7f6755a4138ac4b0f226216e3c48201b8ec52aec21f9c4"
PATCHED_SHA256 = "d438af589830bb8fd94761418177de4061411365018869333b74a34450f2fd71"
PATCH_SHA256 = "85d332e5bea695584bc7248c705382aefbc39ea6106f768d49f7769b7baae4d3"
OLD = "    except subprocess.CalledProcessError:\n        return None"
NEW = "    except (subprocess.CalledProcessError, FileNotFoundError):\n        return None"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def patched_source(original: bytes) -> bytes:
    """Return the single verified compatibility change, refusing other inputs."""
    if digest(original) != SOURCE_SHA256:
        raise ValueError("Unexpected DeepFilterNet 0.5.6 df/utils.py source")
    text = original.decode("utf-8")
    if text.count(OLD) != 1:
        raise ValueError("Expected one optional Git metadata exception clause")
    result = text.replace(OLD, NEW, 1).encode("utf-8")
    if digest(result) != PATCHED_SHA256:
        raise ValueError("Patched DeepFilterNet source digest mismatch")
    return result


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: apply_local_inputs.py <deepfilter package dir> <patch file>")
    patch = Path(sys.argv[2]).read_bytes()
    if digest(patch) != PATCH_SHA256:
        raise SystemExit("Unexpected DFN local-input patch bytes")
    path = Path(sys.argv[1]) / "utils.py"
    result = patched_source(path.read_bytes())
    path.write_bytes(result)
    if digest(path.read_bytes()) != PATCHED_SHA256:
        raise SystemExit("Post-write DeepFilterNet source digest mismatch")
    print(f"PATCHED df/utils.py {SOURCE_SHA256} -> {PATCHED_SHA256}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
