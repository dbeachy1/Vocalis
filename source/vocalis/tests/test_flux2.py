"""The FLUX.2 graph and its submission (9.0-m4, with a pinned ComfyUI graph).

🔴 **A MIS-MAPPED API GRAPH FAILS OBSCURELY, AND THIS RELEASE HAS THE RECEIPT.** Submitted as
stored, the graph ran NINE of its thirteen nodes and then died inside `UnetLoaderGGUF` with
`expected str, bytes or os.PathLike object, not NoneType` — a TypeError from a loader, for a model
path that had simply moved. Nothing in that message says "wrong filename". These specs pin the
shape so the next drift is caught before a card is booked.
"""
from __future__ import annotations

import json

import pytest

from vocalis.runtime import flux2


@pytest.fixture(scope="module")
def graph():
    return flux2.load_graph()


def test_the_graph_is_vendored_in_the_repo(graph):
    """🔴 NOT `~/flux2-facetrain.api.json`. A deploy carries the repo and nothing else, so a graph
    in a home directory is a dependency that silently does not ship — the box would have code that
    submits a file it cannot find."""
    assert flux2.GRAPH_PATH.is_file()
    assert "graphs" in flux2.GRAPH_PATH.parts
    assert flux2.GRAPH_PATH.suffix == ".json"
    assert len(graph) >= 13


def test_every_node_this_module_drives_exists_and_has_the_field(graph):
    """⚠️ THE NODE IDS ARE A CONTRACT WITH A FILE THAT A HUMAN EDITS IN A GUI. Re-exporting the
    workflow can renumber them, and `build()` would then set `text` on a node that no longer
    encodes the prompt — every image identical, silently, because nothing errors."""
    checks = [
        (flux2.NODE_IMAGE, "image", "LoadImage"),
        (flux2.NODE_PROMPT, "text", "CLIPTextEncode"),
        (flux2.NODE_SAMPLER, "seed", "KSampler"),
        (flux2.NODE_SAVE, "filename_prefix", "SaveImage"),
        (flux2.NODE_UNET, "unet_name", "UnetLoaderGGUF"),
        (flux2.NODE_SIZE, "width", "EmptyFlux2LatentImage"),
    ]
    for node_id, field, class_type in checks:
        assert node_id in graph, f"node {node_id} ({class_type}) is gone from the graph"
        assert graph[node_id]["class_type"] == class_type, (
            f"node {node_id} is now a {graph[node_id]['class_type']}, not a {class_type} - "
            "the graph was re-exported and the ids moved"
        )
        assert field in graph[node_id]["inputs"], f"{class_type}.{field} is gone"


def test_the_unet_path_is_the_one_that_actually_resolved(graph):
    """🔴 THE BUG THAT COST THE FIRST VALIDATION RUN. The stored graph said
    `diffusion_models/flux2-dev-Q6_K.gguf`; ComfyUI offers
    `diffusion_models/flux2/flux2-dev-Q6_K.gguf` — a `flux2/` directory added since .

    ⚠️ This cannot check the box from here, so it pins the string that was MEASURED to work. If
    the model moves again this fails in CI rather than four minutes into a booked card.
    """
    assert graph[flux2.NODE_UNET]["inputs"]["unet_name"] == \
        "diffusion_models/flux2/flux2-dev-Q6_K.gguf"


def test_build_sets_every_field_and_does_not_mutate_the_template(graph):
    """A template mutated in place would leak one image's prompt into the next — and since the
    run is resumable, into every later resume of it too."""
    before = json.dumps(graph, sort_keys=True)
    g = flux2.build(graph, face_name="face.png", prompt="a portrait", seed=42, prefix="out/x")

    assert g[flux2.NODE_IMAGE]["inputs"]["image"] == "face.png"
    assert g[flux2.NODE_PROMPT]["inputs"]["text"] == "a portrait"
    assert g[flux2.NODE_SAMPLER]["inputs"]["seed"] == 42
    assert g[flux2.NODE_SAVE]["inputs"]["filename_prefix"] == "out/x"
    assert json.dumps(graph, sort_keys=True) == before, "build() mutated the caller's template"


def test_the_seed_is_stable_per_slot_because_the_run_is_resumable():
    """🔴 DERIVED FROM THE SLOT, NOT RANDOM. `loragen.plan()` recomputes what is left from what is
    on disk, so the same prompt at the same index is the same job after a restart. A random seed
    would make a resumed slot render a DIFFERENT image from the one that was interrupted — and the
    filename is derived from the slot too, so the sheet would show one picture where the log
    recorded another."""
    a = flux2.seed_for("subj:001:00")
    assert a == flux2.seed_for("subj:001:00")
    assert a != flux2.seed_for("subj:001:01"), "two slots share a seed - the sheet will repeat"
    assert a != flux2.seed_for("subj:002:00")


def test_the_seed_fits_in_63_bits():
    """⚠️ ComfyUI round-trips the seed through JSON, and a value past 2**63 comes back changed on
    some builds — which would break the reproducibility above in a way that only shows up as a
    resumed image not matching."""
    for i in range(50):
        s = flux2.seed_for(f"x:{i:03d}:00")
        assert 0 <= s < (1 << 63)


def test_a_failure_names_the_node_not_just_the_word_error():
    """⚠️ ComfyUI buries the useful half in `messages` as `["execution_error", {...}]`. Reporting
    only `status_str` puts the word "error" on screen for a wrong model path, a missing custom
    node and an OOM alike — which is exactly what the first validation run would have shown."""
    status = {
        "status_str": "error",
        "messages": [
            ["execution_start", {}],
            ["execution_error", {
                "node_id": "1", "node_type": "UnetLoaderGGUF",
                "exception_type": "TypeError",
                "exception_message": "expected str, bytes or os.PathLike object, not NoneType\n",
            }],
        ],
    }
    got = flux2._explain(status)
    assert "UnetLoaderGGUF" in got
    assert "NoneType" in got


def test_an_error_status_raises_rather_than_polling_to_the_timeout(monkeypatch):
    """🔴 A poller that only looked for images would spin for the full timeout and report "slow"
    for something that failed in four seconds."""
    monkeypatch.setattr(flux2, "_get_json", lambda url, timeout=30.0: {
        "pid": {"status": {"status_str": "error", "messages": [
            ["execution_error", {"node_type": "KSampler", "exception_message": "boom"}]]}}
    })
    with pytest.raises(flux2.GraphFailed) as exc:
        flux2.wait_for_images("http://x", "pid", poll_s=0.01, timeout_s=5)
    assert "KSampler" in str(exc.value)


def test_completed_without_an_image_is_also_a_failure(monkeypatch):
    """A graph whose SaveImage was deleted completes happily and writes nothing. Treating that as
    success is how a run finishes green with an empty output directory."""
    monkeypatch.setattr(flux2, "_get_json", lambda url, timeout=30.0: {
        "pid": {"status": {"completed": True}, "outputs": {}}
    })
    with pytest.raises(flux2.GraphFailed):
        flux2.wait_for_images("http://x", "pid", poll_s=0.01, timeout_s=5)


def test_the_dispatcher_uploads_and_fetches_rather_than_using_paths():
    """ComfyUI cannot access vault-routed files; transfer inputs and outputs through the API."""
    import inspect

    from vocalis.web import lora as web_lora
    src = inspect.getsource(web_lora.create_lora_blueprint)
    body = src[src.index("def _gen_render"):src.index("def _gen_dispatch")]
    assert "flux2.upload_image(" in body, "the face is not uploaded through the API"
    assert "flux2.fetch_image(" in body, "the result is not fetched back"
    assert "vault_fs.write_bytes(" in body, "the image is not written through the vault router"


def test_the_graph_is_loaded_once_not_per_image():
    """📌 A graph re-read per image lets an edit land mid-run, so half a contact sheet comes from
    one graph and half from another with nothing to say so."""
    import inspect

    from vocalis.web import lora as web_lora
    src = inspect.getsource(web_lora.create_lora_blueprint)
    assert src.count("flux2.load_graph()") == 1
    body = src[src.index("def _gen_render"):src.index("def _gen_dispatch")]
    assert "load_graph()" not in body, "the graph is re-read on every image"


def test_two_submissions_of_one_graph_do_not_hash_identically(graph, monkeypatch):
    """🔴 THE REGRESSION THIS EXISTS FOR: a byte-identical resubmission is a ComfyUI CACHE HIT,
    and a full cache hit returns `success` with `outputs: {}` — no image, no error, five
    milliseconds. `wait_for_images` then raises "the graph completed without producing an image",
    which reads as a broken graph and is nothing of the sort.

    It is reachable by the most ordinary gesture there is: `seed_for()` is stable per slot on
    purpose, and all three builders take a prefix that is constant per subject/candidate/test, so
    "generate those candidates again" must create a distinct submission.
    """
    sent = []
    monkeypatch.setattr(flux2, "_post_json",
                        lambda url, payload, timeout=30.0: sent.append(payload) or {"prompt_id": "p"})
    g = flux2.build_txt2img(graph, prompt="a face", seed=7, prefix="vocalis-lora/candidates")
    flux2.submit("http://x", g)
    flux2.submit("http://x", g)

    first, second = (p["prompt"][flux2.NODE_SAVE]["inputs"]["filename_prefix"] for p in sent)
    assert first != second, "two submissions hash identically and the second is a silent cache hit"
    assert first.startswith("vocalis-lora/candidates-"), first
    assert second.startswith("vocalis-lora/candidates-"), second


def test_only_the_output_node_is_stamped_so_the_expensive_nodes_stay_cached(graph, monkeypatch):
    """📌 The nonce is on `SaveImage` BECAUSE it is a leaf: the sampler and the model load keep
    their cache, so a resubmission costs milliseconds instead of three minutes. A nonce upstream
    would re-run the sampler; a changed SEED would return a DIFFERENT image than the one the
    caller asked to re-fetch. Both were live options and both are wrong."""
    sent = []
    monkeypatch.setattr(flux2, "_post_json",
                        lambda url, payload, timeout=30.0: sent.append(payload) or {"prompt_id": "p"})
    g = flux2.build_txt2img(graph, prompt="a face", seed=7, prefix="p")
    flux2.submit("http://x", g)

    got = sent[0]["prompt"]
    changed = [n for n in got if got[n] != g[n]]
    assert changed == [flux2.NODE_SAVE], f"more than the output node moved: {changed}"
    assert got[flux2.NODE_SAMPLER]["inputs"]["seed"] == 7, "the seed moved - a different image"


def test_submit_does_not_mutate_the_caller_s_graph(graph, monkeypatch):
    """⚠️ The graph is loaded ONCE per process and reused for every image (see the test above), so
    a submit that stamped in place would append a nonce per call and grow the prefix for ever."""
    monkeypatch.setattr(flux2, "_post_json",
                        lambda url, payload, timeout=30.0: {"prompt_id": "p"})
    g = flux2.build_txt2img(graph, prompt="a face", seed=7, prefix="vocalis-lora/candidates")
    before = g[flux2.NODE_SAVE]["inputs"]["filename_prefix"]
    flux2.submit("http://x", g)
    flux2.submit("http://x", g)
    assert g[flux2.NODE_SAVE]["inputs"]["filename_prefix"] == before


def test_the_dispatcher_hands_off_and_does_not_render_on_the_queue_s_thread():
    """🔴 THE DEFECT THIS PINS: `_gen_dispatch` used to do the whole render inline — upload,
    submit, `wait_for_images` for MINUTES, fetch, write — and `GenerateRun.start()` calls it from
    inside `with self._lock` via `enqueue -> pump`. So `POST .../generate` did not answer until the
    first image on every card had landed, and `POST /lora/generate/stop` blocked on that same lock:
    a blocking dispatch can leave the request unanswered while `canceled` stays false
    and the run still going — against §4.4's *"Stop is real"*.

    `AceQueue.pump` states the contract in its own docstring — *"DISPATCH IS CALLED OUTSIDE THE
    LOCK. It hands off to a worker thread"* — and `web/acestep.py` honors it. So do `loracands`
    and `loratest`. Generate was the only one of the three siblings that did not.

    ⚠️ **`loragen._lock` IS AN `RLock`, WHICH IS WHY THIS WAS A HANG AND NOT A CRASH.** `landed()`
    re-enters the lock on the rendering thread; a plain `Lock` would have deadlocked on image one.

    🔴 **PARSED, NOT GREPPED, AND THE FIRST VERSION OF THIS TEST PROVED WHY.** It asserted
    `"threading.Thread(" in body` — and passed with the hand-off reverted, because the docstring
    right above says the words `threading.Thread(...)` while explaining the fix. The scanner was
    reading its own documentation. The AST sees code and nothing else.
    """
    import ast
    import inspect
    import textwrap

    from vocalis.web import lora as web_lora
    tree = ast.parse(textwrap.dedent(inspect.getsource(web_lora.create_lora_blueprint)))
    fns = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    assert "_gen_dispatch" in fns and "_gen_render" in fns, sorted(fns)

    disp = fns["_gen_dispatch"]
    body = list(disp.body)
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        body = body[1:]                       # drop the docstring: prose is not code
    calls = {ast.unparse(n.func) for n in ast.walk(ast.Module(body=body, type_ignores=[]))
             if isinstance(n, ast.Call)}

    assert any(c.endswith("Thread") for c in calls), (
        f"the dispatcher renders on the queue's thread again - it calls {sorted(calls)}"
    )
    for blocking in ("flux2.wait_for_images", "flux2.upload_image", "flux2.fetch_image"):
        assert blocking not in calls, (
            f"{blocking} is back inside _gen_dispatch - the queue calls it while walking its free "
            "backends, so it must not block"
        )
    assert "_gen_render" not in calls, "the dispatcher calls the render directly instead of spawning"
