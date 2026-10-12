#!/usr/bin/env python3
"""Apply Vocalis's opt-in Torch policy before starting the ACE-Step API module."""
from __future__ import annotations

import os
import runpy
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SATELLITE_DIR = PROJECT_ROOT / "satellite"
sys.path.insert(0, str(SATELLITE_DIR))


def main() -> None:
    """Configure Torch, then preserve ``python -m acestep.api_server`` behavior."""
    import torch

    from vocalis_torch_backend import apply_rocm_miopen_policy

    apply_rocm_miopen_policy(torch)
    source_root = os.getcwd()
    sys.path.insert(0, source_root)
    try:
        runpy.run_module("acestep.api_server", run_name="__main__", alter_sys=True)
    finally:
        # Direct execution places the launcher directory at sys.path[0]; remove only our
        # temporary source-root entry when the delegated module returns.
        if sys.path and sys.path[0] == source_root:
            del sys.path[0]


if __name__ == "__main__":
    main()
