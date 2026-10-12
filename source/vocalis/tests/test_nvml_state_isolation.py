"""conftest's autouse fixture resets the readout module's remembered NVML failures and the
satellite batch module's settled reader between tests, so a result never depends on test order
(October 10, 2026).

The two tests run in file order on one worker: the first leaves every piece of state dirty on
purpose, with nothing of its own to clean it, and the second must find it clean.
"""
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "satellite"))
gs = importlib.import_module("vocalis_satellite_gpustats")
batch = importlib.import_module("vocalis_satellite_batch")


def test_a_leaves_the_state_dirty():
    gs._NVML = object()
    gs._NVML_UNAVAILABLE_LOGGED = True
    gs._NVML_RETRY_AT = 1e12
    gs._MAPPING = {0: 0}
    gs._MAPPING_RETRY_AT = 1e12
    gs._MAPPING_FAILURE_LOGGED = True
    gs._MAPPING_FALLBACK_LOGGED.add(0)
    gs._HANDLE_WARNED.add(0)
    gs._CARD_ACTIVE_LOGGED.add(0)
    gs._CARD_CACHE[0] = (0.0, {})
    gs._FIELD_WARNED.add((0, "fan_pct"))
    gs._MCLK_DIVISOR[0] = 4
    batch._WHOLE_CARD["fn"] = lambda d: (1.0, 2.0)
    batch._WHOLE_CARD["source"] = "dirty"
    batch._WHOLE_CARD_WARNED.add("RuntimeError")
    batch._CAP_LOGGED_GB["cuda:0"] = 3.0
    batch._CAP_WARNED.add(("cuda:0", 1.0))


def test_b_finds_it_clean():
    assert gs._NVML is None and gs._NVML_RETRY_AT is None
    assert gs._MAPPING is None and gs._MAPPING_RETRY_AT is None
    assert gs._MAPPING_FAILURE_LOGGED is False and gs._NVML_UNAVAILABLE_LOGGED is False
    assert not gs._MAPPING_FALLBACK_LOGGED and not gs._HANDLE_WARNED
    assert not gs._CARD_ACTIVE_LOGGED and not gs._CARD_CACHE
    assert not gs._FIELD_WARNED and not gs._MCLK_DIVISOR
    assert batch._WHOLE_CARD["fn"] is None
    assert batch._WHOLE_CARD["source"] == batch._WHOLE_CARD_STANDALONE
    assert not batch._WHOLE_CARD_WARNED and not batch._CAP_LOGGED_GB and not batch._CAP_WARNED
