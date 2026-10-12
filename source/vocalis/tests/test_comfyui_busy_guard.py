"""The ComfyUI stop guard, and the between-submissions race it used to lose (9.0-m4).

🔴 **THE BUG THIS FILE EXISTS FOR IS A WINDOW, NOT A STATE.** `comfyui_queue_busy()` reads
`/api/queue` per instance and is truthy only when it can *positively see* work — `None` means both
"idle" and "cannot tell", which is why callers only refuse when it is definitely busy. That is
correct on its own terms.

It stops being correct the moment something holds a list of jobs locally and submits them **one at
a time**, which is the `acequeue` pattern and is otherwise right: between two submissions ComfyUI's
queue is genuinely empty. A Stop click landing in that gap read "not busy", stopped the service,
and lost every image still to come — with the guard doing exactly what it was written to do.

📌 The fix is not a bigger poll or a sleep. It is asking **our own run state**, and the external
`GpuGate` lease already is that: whatever claims a card for a dispatched run holds it for the whole
run, submissions and gaps alike. One source of truth, not a third one to drift.
"""
from __future__ import annotations

import pytest

from vocalis.runtime import gpu


@pytest.fixture(autouse=True)
def _clean_gate():
    """The gate is a process global. Leaving a lease behind would make every later test in the
    session see a busy card — the exact leak `release_external` is written to tolerate."""
    for d in list(gpu.GPUS.external()):
        gpu.GPUS.release_external(d)
    yield
    for d in list(gpu.GPUS.external()):
        gpu.GPUS.release_external(d)


def test_the_lease_is_visible_between_submissions(monkeypatch):
    """The window itself, reproduced: ComfyUI's queue reports EMPTY while a run is live.

    This is the state the old guard could not distinguish from "nothing is happening", and it is
    the state a generation loop is in for a moment after every single image.
    """
    from vocalis.runtime import comfyui as rt_comfyui
    monkeypatch.setattr(rt_comfyui, "comfyui_queue_busy", lambda: None)

    gpu.GPUS.claim_external("cuda:0", 'lora:test-subject')
    assert rt_comfyui.comfyui_queue_busy() is None, "the queue is empty - that is the window"
    assert gpu.GPUS.external(), "the lease must still report the run"


def test_the_guard_refuses_a_stop_while_a_lease_is_held(monkeypatch):
    """End to end through the route: a Stop in the window answers 409, not 200.

    ⚠️ Asserted on the ROUTE rather than on the helper, because the bug was never in
    `comfyui_queue_busy()` — that function is right. It was in what the route concluded from it.
    """
    # 🔴 `vs.app`, NEVER `vs.create_app()`. `test_create_app_is_called_exactly_once_anywhere`
    # refuses a second call and names this exact temptation in its docstring: a fixture building
    # a fresh app 'for isolation'. It is not isolation — `web/auth.py` and `web/ui.py` keep their
    # injected seams in MODULE globals, so a second app repoints the FIRST app's wiring at the
    # second one's dependencies, and the vault store is configured once per PROCESS regardless.
    import vocalis_server as vs
    from vocalis.runtime import comfyui as rt_comfyui
    monkeypatch.setattr(rt_comfyui, "comfyui_queue_busy", lambda: None)
    monkeypatch.setattr(rt_comfyui, "comfyui_instances",
                        lambda: [("comfyui.service", "http://127.0.0.1:8189")])

    client = vs.app.test_client()
    with client.session_transaction() as sess:
        sess["logged_in"] = True

    gpu.GPUS.claim_external("cuda:0", 'lora:test-subject')
    r = client.post("/comfyui/stop", json={})
    assert r.status_code == 409, (
        f"a Stop landing between two submissions was allowed ({r.status_code}) - it would have "
        "killed the run and lost every image still to come"
    )
    body = r.get_json() or {}
    assert body.get("error") == "comfyui_busy"
    assert 'lora:test-subject' in (body.get("holders") or []), (
        "the refusal does not say WHAT is holding the cards, so the caller cannot tell when force is appropriate"
    )


def test_force_still_overrides(monkeypatch):
    """🔴 THE ESCAPE HATCH MUST SURVIVE. `force` exists because a wedged run would otherwise make
    the service unstoppable — and a leaked lease is exactly the failure that would cause that.
    A guard with no override turns one stuck job into a reboot."""
    import vocalis_server as vs
    from vocalis.runtime import comfyui as rt_comfyui
    monkeypatch.setattr(rt_comfyui, "comfyui_queue_busy", lambda: None)
    monkeypatch.setattr(rt_comfyui, "comfyui_instances",
                        lambda: [("comfyui.service", "http://127.0.0.1:8189")])

    client = vs.app.test_client()
    with client.session_transaction() as sess:
        sess["logged_in"] = True

    gpu.GPUS.claim_external("cuda:0", 'lora:test-subject')
    r = client.post("/comfyui/stop", json={"force": True})
    assert r.status_code != 409, "force did not override the lease - the service is unstoppable"


def test_no_lease_and_an_empty_queue_still_allows_a_stop(monkeypatch):
    """⚠️ THE GUARD MUST NOT BECOME UNCONDITIONAL. If holding no lease still refused, Stop would
    be broken for every ordinary idle case — which is a worse bug than the one being fixed, and
    the kind a test that only checks the refusal path would never catch."""
    import vocalis_server as vs
    from vocalis.runtime import comfyui as rt_comfyui
    monkeypatch.setattr(rt_comfyui, "comfyui_queue_busy", lambda: None)
    monkeypatch.setattr(rt_comfyui, "comfyui_instances",
                        lambda: [("comfyui.service", "http://127.0.0.1:8189")])

    client = vs.app.test_client()
    with client.session_transaction() as sess:
        sess["logged_in"] = True

    assert not gpu.GPUS.external()
    r = client.post("/comfyui/stop", json={})
    assert r.status_code != 409, "an idle box refused a Stop - the guard fires unconditionally"
