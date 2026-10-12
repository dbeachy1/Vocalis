"""Submit the vendored FLUX.2 face graph to ComfyUI.

Graphs ship beside this module so deployments do not depend on files in a user's home directory.
Keep the graph aligned with installed model paths; ComfyUI can report stale paths as loader
errors only after partially executing the graph.

HOW A FACE GETS IN, AND AN IMAGE GETS OUT
------------------------------------------
Seed images are uploaded through ComfyUI's API because it owns its input directory and cannot
read vault-backed paths. Generated images are fetched through `/view` and stored through
`vault_fs`, keeping them in the application's routed library regardless of ComfyUI's output path.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from loguru import logger

#: The vendored graphs. Versioned with the code, so a deploy carries them.
_GRAPHS = Path(__file__).resolve().parent.parent / "graphs"
GRAPH_PATH = _GRAPHS / "flux2_face.api.json"

#: Derived from the face graph rather than authored separately. Face candidates are
#: generated from a PROMPT ALONE — there is no seed face yet, which is the point of the
#: screen — so `LoadImage`, `VAEEncode` and `ReferenceLatent` come out and the sampler takes
#: the empty latent node 6 already produced. Every node that remains is one the face graph
#: proved loads on this box; a graph typed from scratch would re-introduce exactly the risk
#: that validation removed.
TXT2IMG_GRAPH_PATH = _GRAPHS / "flux2_txt2img.api.json"

#: Node ids driven by this module. Named constants keep graph edits from silently retargeting a
#: field in multiple locations.
NODE_IMAGE = "20"          # LoadImage.image      — the seed face
NODE_PROMPT = "4"          # CLIPTextEncode.text  — the composed prompt
NODE_SAMPLER = "7"         # KSampler.seed
NODE_SAVE = "13"           # SaveImage.filename_prefix
NODE_UNET = "1"            # UnetLoaderGGUF.unet_name
NODE_SIZE = "6"            # EmptyFlux2LatentImage.width/height

#: Representative measured render time at 896x1152, 20 steps, Q6_K. Loading time was small
#: relative to sampling in the measured configuration; treat this as an approximate per-image
#: rate, not a general hardware estimate. Turbo settings are faster at a lower step count and
#: different quantization, with a quality tradeoff, so they do not replace the configured default.
MEASURED_S_PER_IMAGE = 199.3

DEFAULT_WIDTH = 896
DEFAULT_HEIGHT = 1152


class GraphFailed(RuntimeError):
    """The graph did not produce an image, and why."""


def seed_for(job_id: str) -> int:
    """Derive a stable 63-bit seed from a resumable image-slot identifier.

    ComfyUI transports seeds through JSON, so mask to the signed 63-bit range
    to preserve the value across backends.
    """
    import hashlib

    return int(hashlib.sha256(job_id.encode("utf-8")).hexdigest()[:16], 16) & ((1 << 63) - 1)


def load_graph() -> dict:
    return json.loads(GRAPH_PATH.read_text(encoding="utf-8"))


def load_txt2img_graph() -> dict:
    return json.loads(TXT2IMG_GRAPH_PATH.read_text(encoding="utf-8"))


LORA_TEST_GRAPH_PATH = _GRAPHS / "flux2_lora_test.api.json"

#: The LoraLoaderModelOnly spliced between the unet and the sampler (9.0-m6).
NODE_LORA = "50"

#: Representative measured render time for a nonzero LoRA strength. Applying nonzero strengths
#: patches model weights and takes longer than the zero-strength baseline.
MEASURED_S_PER_TEST_IMAGE = 242.0


def load_lora_test_graph() -> dict:
    return json.loads(LORA_TEST_GRAPH_PATH.read_text(encoding="utf-8"))


def build_lora_test(graph: dict, *, lora: str, prompt: str, seed: int, strength: float,
                    prefix: str, width: int = DEFAULT_WIDTH,
                    height: int = DEFAULT_HEIGHT) -> dict:
    """One image of the proof sheet. Pure.

    The caller passes the same seed for every strength. That is the mechanism, and it is the
    caller's job because only the caller knows the set. Varying it would make every image differ
    for reasons unrelated to the LoRA, and a LoRA doing nothing would look exactly like one that
    works.
    """
    g = json.loads(json.dumps(graph))
    g[NODE_LORA]["inputs"]["lora_name"] = lora
    g[NODE_LORA]["inputs"]["strength_model"] = float(strength)
    g[NODE_PROMPT]["inputs"]["text"] = prompt
    g[NODE_SAMPLER]["inputs"]["seed"] = int(seed)
    g[NODE_SAVE]["inputs"]["filename_prefix"] = prefix
    g[NODE_SIZE]["inputs"]["width"] = int(width)
    g[NODE_SIZE]["inputs"]["height"] = int(height)
    return g


def list_loras(base_url: str, timeout: float = 30.0) -> list:
    """What ComfyUI will accept for `lora_name`.

    Ask ComfyUI for accepted names rather than inferring them from a local directory; model names
    are interpreted by the backend and may not match this application's filesystem.
    """
    info = _get_json(base_url.rstrip("/") + "/object_info/LoraLoaderModelOnly", timeout=timeout)
    for spec in info.values():
        opts = (spec.get("input", {}).get("required", {}) or {}).get("lora_name")
        if opts and isinstance(opts[0], list):
            return list(opts[0])
    return []

def build_txt2img(graph: dict, *, prompt: str, seed: int, prefix: str,
                  width: int = DEFAULT_WIDTH, height: int = DEFAULT_HEIGHT) -> dict:
    """The candidate graph with this image's fields set. Pure.

    This graph has no `face_name`. `build()` would happily
    set `LoadImage.image` on a graph that has no `LoadImage`, raising a KeyError deep in a
    dict — so the two builders are separate functions rather than one with an optional
    argument. A caller cannot reach for the wrong one by leaving a parameter out.
    """
    g = json.loads(json.dumps(graph))
    g[NODE_PROMPT]["inputs"]["text"] = prompt
    g[NODE_SAMPLER]["inputs"]["seed"] = int(seed)
    g[NODE_SAVE]["inputs"]["filename_prefix"] = prefix
    g[NODE_SIZE]["inputs"]["width"] = int(width)
    g[NODE_SIZE]["inputs"]["height"] = int(height)
    return g


def _post_json(url: str, payload: dict, timeout: float = 30.0) -> dict:
    req = urllib.request.Request(url, method="POST", data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _get_json(url: str, timeout: float = 30.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


def upload_image(base_url: str, name: str, data: bytes, timeout: float = 60.0) -> str:
    """Put a seed face into ComfyUI's input store. Returns the name `LoadImage` should use.

    Assemble the multipart body with `urllib`, the project's existing HTTP stack, to avoid another
    dependency.
    """
    boundary = f"----vocalis{uuid.uuid4().hex}"
    head = (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="image"; filename="{name}"\r\n'
            "Content-Type: image/png\r\n\r\n").encode("utf-8")
    # `overwrite` so a re-run of the same subject reuses one slot instead of accumulating
    # `face (1).png`, `face (2).png` — ComfyUI renames rather than replacing by default.
    tail = (f"\r\n--{boundary}\r\n"
            'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'
            f"--{boundary}--\r\n").encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + "/upload/image", method="POST", data=head + data + tail,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read())
    stored = body.get("name") or name
    if body.get("subfolder"):
        stored = f"{body['subfolder']}/{stored}"
    return stored


def build(graph: dict, *, face_name: str, prompt: str, seed: int,
          prefix: str, width: int = DEFAULT_WIDTH, height: int = DEFAULT_HEIGHT) -> dict:
    """The graph with this image's fields set. Pure — no I/O, so it is testable without ComfyUI."""
    g = json.loads(json.dumps(graph))          # deep copy: the caller's template must not move
    g[NODE_IMAGE]["inputs"]["image"] = face_name
    g[NODE_PROMPT]["inputs"]["text"] = prompt
    g[NODE_SAMPLER]["inputs"]["seed"] = int(seed)
    g[NODE_SAVE]["inputs"]["filename_prefix"] = prefix
    g[NODE_SIZE]["inputs"]["width"] = int(width)
    g[NODE_SIZE]["inputs"]["height"] = int(height)
    return g


def _uncached(graph: dict) -> dict:
    """The graph with a per-submission nonce on `SaveImage.filename_prefix`.

    ComfyUI caches on node inputs, and a whole-graph cache hit may return no outputs.
    Submit a byte-identical graph twice and the second `/history` entry comes back
    `status_str: success`, `completed: true`, `outputs: {}` — every node listed in
    `execution_cached`, the whole thing finished in five milliseconds, and not one image. The
    poller above then raises *"the graph completed without producing an image"*, which reads like
    a broken graph and is in fact a cache hit reported as success.

    Every caller builds an identical graph on a re-run by design. `seed_for()` is
    deliberately stable per slot so a resumed job re-renders the same image, and all three
    builders take a `prefix` that is constant per subject/candidate/test. So prompt, seed and
    prefix all match, and "generate those candidates again" is the exact gesture that trips it.
    The nonce goes on the output node because `SaveImage` is a leaf, so changing its
    `filename_prefix` re-executes only that node — the sampler and the model load stay cached and
    the resubmission costs milliseconds rather than three minutes. Putting the nonce anywhere
    upstream would defeat the cache that makes this cheap, and changing the seed would silently
    render a DIFFERENT image than the one the caller asked to re-fetch.
    """
    node = (graph or {}).get(NODE_SAVE)
    if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
        return graph
    g = json.loads(json.dumps(graph))
    prefix = str(g[NODE_SAVE]["inputs"].get("filename_prefix") or "vocalis-lora/out")
    g[NODE_SAVE]["inputs"]["filename_prefix"] = f"{prefix}-{uuid.uuid4().hex[:8]}"
    return g


def submit(base_url: str, graph: dict, timeout: float = 30.0) -> str:
    res = _post_json(base_url.rstrip("/") + "/prompt", {"prompt": _uncached(graph)},
                     timeout=timeout)
    pid = res.get("prompt_id")
    if not pid:
        raise GraphFailed(f"ComfyUI did not accept the graph: {json.dumps(res)[:400]}")
    return pid


def wait_for_images(base_url: str, prompt_id: str, *, poll_s: float = 2.0,
                    timeout_s: float = 1800.0) -> list:
    """Block until the prompt produces images, or fails, or the deadline passes.

    Raise on an error status rather than returning "no images yet." ComfyUI reports a failed
    node in `status.status_str` and then simply stops; a poller that only looked for images would
    spin until the timeout and report "slow" for something that failed in four seconds. That is
    how the stale unet path presented before it was read properly.
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            hist = _get_json(f"{base_url.rstrip('/')}/history/{prompt_id}")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            logger.info(f"flux2: history poll failed, retrying - {exc}")
            time.sleep(poll_s)
            continue
        entry = hist.get(prompt_id)
        if entry:
            images = [im for out in (entry.get("outputs") or {}).values()
                      for im in out.get("images", [])]
            if images:
                return images
            status = entry.get("status") or {}
            if status.get("status_str") == "error":
                raise GraphFailed(_explain(status))
            if status.get("completed"):
                raise GraphFailed("the graph completed without producing an image")
        time.sleep(poll_s)
    raise GraphFailed(f"no image after {int(timeout_s)}s")


def _explain(status: dict) -> str:
    """The failing node and its message, not just "error".

    ComfyUI stores the useful detail in `messages` as `["execution_error", {...}]`. Reporting
    only `status_str` would put the word "error" on screen for a wrong model path, a missing
    custom node and an OOM alike.
    """
    for name, payload in status.get("messages") or []:
        if name == "execution_error" and isinstance(payload, dict):
            node = payload.get("node_type") or payload.get("node_id")
            msg = (payload.get("exception_message") or "").strip().splitlines()
            return f"{node}: {msg[0] if msg else payload.get('exception_type', 'failed')}"
    return "the graph failed"


def fetch_image(base_url: str, image: dict, timeout: float = 120.0) -> bytes:
    """One rendered image's bytes, over `/view`.

    Fetch through `/view` instead of reading a backend-local path. This keeps the module independent
    of ComfyUI's output directory and allows the caller to store results through the vault layer.
    """
    q = urllib.parse.urlencode({"filename": image.get("filename", ""),
                                "subfolder": image.get("subfolder", ""),
                                "type": image.get("type", "output")})
    with urllib.request.urlopen(f"{base_url.rstrip('/')}/view?{q}", timeout=timeout) as r:
        return r.read()
