"""Check optional Git metadata without importing or initializing DeepFilterNet."""
from __future__ import annotations

import ast
import os
import subprocess
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace

from apply_local_inputs import patched_source

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WHEEL = ROOT / ".codex/packaging-probes/dfn-private-20261008/runtime-code/deepfilternet-0.5.6-py3-none-any.whl"
WHEEL = Path(os.environ.get("DFN_TEST_WHEEL", str(DEFAULT_WHEEL)))


def isolated_get_git_root(check_output):
    """Exercise only the exact patched function with a controlled Git result."""
    with zipfile.ZipFile(WHEEL) as archive:
        source = patched_source(archive.read("df/utils.py"))
    module = ast.parse(source.decode("utf-8"))
    node = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == "get_git_root")
    namespace = {
        "__file__": "/synthetic/site-packages/df/utils.py",
        "os": os,
        "subprocess": SimpleNamespace(check_output=check_output, CalledProcessError=subprocess.CalledProcessError),
    }
    exec(compile(ast.Module(body=[node], type_ignores=[]), "df/utils.py", "exec"), namespace)
    return namespace["get_git_root"]()


class GitMetadataTests(unittest.TestCase):
    def test_missing_git_returns_unavailable(self):
        def missing(_args):
            raise FileNotFoundError("git")

        self.assertIsNone(isolated_get_git_root(missing))

    def test_nonrepository_returns_unavailable(self):
        def outside(_args):
            raise subprocess.CalledProcessError(128, "git")

        self.assertIsNone(isolated_get_git_root(outside))

    def test_repository_metadata_is_unchanged(self):
        self.assertEqual(isolated_get_git_root(lambda _args: b"/synthetic/repo\n"), "/synthetic/repo")


if __name__ == "__main__":
    unittest.main()
