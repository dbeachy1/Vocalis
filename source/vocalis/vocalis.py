#!/usr/bin/env python3
"""Run the Vocalis server as an importable module.

Importing `vocalis_server` under its package name keeps later imports bound to
this process's existing Flask app and vault configuration. Executing the server
module directly would register it only as `__main__`, allowing a later import
by name to create a second application instance.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

import vocalis_server  # noqa: E402  (must follow the sys.path insert)

if __name__ == "__main__":
    vocalis_server.main()
