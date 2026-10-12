"""Guard against duplicate references selecting multiple rows in Voice Swap.

The panel combines rows from several stores, and selection, highlighting, and folder dragging all
use row references as identity. Duplicate references can therefore make one click affect rows with
different labels. Browser fixtures cover each source store and assert that every selection maps to
one row."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
DOM_JS = REPO_ROOT / "src" / "webui" / "js" / "util" / "dom.js"
NODE = shutil.which("node")

DRIVER = """
import { dupeIds } from %(mod)s;
const out = [];
const say = (name, v) => out.push([name, v]);

// A clean list — the answer on every correct render.
say('clean', dupeIds('a', [{r: 'x'}, {r: 'y'}, {r: 'z'}], o => o.r));

// Two rows share one id but have different names.
say('collision', dupeIds('b', [{r: 'uploads/one.mp3', n: 'Sample Track One'},
                               {r: 'speech/two.wav',  n: 'Sample Track Two'},
                               {r: 'uploads/one.mp3', n: 'Sample Track Three'}], o => o.r));

// Reported ONCE per (list, id): these renders run at 2 Hz on some panels.
say('again', dupeIds('b', [{r: 'uploads/one.mp3'}, {r: 'uploads/one.mp3'}], o => o.r));

// …but the same id in a DIFFERENT list is a different fact and is reported.
say('other-list', dupeIds('c', [{r: 'uploads/one.mp3'}, {r: 'uploads/one.mp3'}], o => o.r));

// Three of a kind reports the id once, not twice.
say('triple', dupeIds('d', [{r: 'q'}, {r: 'q'}, {r: 'q'}], o => o.r));

// An empty or absent list is not an error — panels render before their data lands.
say('empty', dupeIds('e', [], o => o.r));
say('null', dupeIds('f', null, o => o.r));

// ⚠️ AN ABSENT ID IS STILL AN ID. Two rows that both forgot their ref collide on '' and every
// comparison in the panel would treat them as the same row — the exact failure, arriving by the
// other road. Silently skipping them would make the guard blind to the worse case.
say('missing', dupeIds('g', [{}, {}], o => o.r));

console.log(JSON.stringify(out));
"""


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_dupe_ids_reports_each_collision_once(tmp_path):
    drv = tmp_path / "drv.mjs"
    drv.write_text(DRIVER % {"mod": json.dumps(DOM_JS.as_uri())}, encoding="utf-8")
    r = subprocess.run([NODE, str(drv)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=60)
    assert r.returncode == 0, f"the driver failed:\n{r.stdout}\n{r.stderr}"
    got = dict(json.loads(r.stdout.strip().splitlines()[-1]))

    assert got["clean"] == [], "a list with distinct ids reported a collision"
    assert got["collision"] == ["uploads/one.mp3"], (
        "two rows sharing one ref were not reported — this is the whole guard")
    assert got["again"] == [], "the same collision was reported twice; a 2 Hz repaint would flood the log"
    assert got["other-list"] == ["uploads/one.mp3"], (
        "the same id colliding in a DIFFERENT list is a different fact and must be reported")
    assert got["triple"] == ["q"], "three rows on one id reported the id more than once"
    assert got["empty"] == [] and got["null"] == [], (
        "a panel rendering before its data lands must not be an error")
    assert got["missing"] == [""], (
        "two rows with NO id collide on the empty string, and that is the worse case — every "
        "comparison in the panel treats them as the same row")
