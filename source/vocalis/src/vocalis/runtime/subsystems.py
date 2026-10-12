"""Registry for per-device subsystem capability and authorization.

Each label matches a user-visible tab or sub-tab. Subsystems that share one worker pool share one
authorization row. Capability is separate from authorization: the UI only offers controls for
work a device can actually run, while a missing `uses` key preserves legacy allow-by-default
behavior.

Rendering uses a shared pool across several tabs. ACE-Step is different: its setting controls
whether a dedicated service may run, rather than filtering work dispatched through a shared pool.
"""

#: The render pool — Playground, Book, Bulk, Nomi, SillyTavern, and Enhance riding along.
#: Named rather than spelled "render" at each site: it is the DEFAULT subsystem for every
#: existing caller of `default_devices()` / `local_cuda_devices()`, so it appears in a
#: signature default in three modules and they all have to mean the same one.
RENDER = "render"
VOICECREATE = "voicecreate"
STEMS = "stems"
TRAINING = "training"
SWAP = "swap"
ACESTEP = "acestep"
# ComfyUI is an independently installed optional resource-control target. It is not a bundled
# generation engine; Docker omits its host-control row until a supported adapter exists.
COMFYUI = "comfyui"

#: Display order is the order they appear under a card row.
SUBSYSTEMS = (
    {"key": RENDER,      "label": "Playground · Book · Bulk · Nomi · SillyTavern",
     "hint": "Chatterbox speech for every tab that renders a voice, plus Enhance.",
     "satellite": True},
    {"key": VOICECREATE, "label": "Voices → Create a voice",
     "hint": "VoxCPM2, designing a new voice from a description.",
     "satellite": False},
    {"key": STEMS,       "label": "Voice Studio → Stems",
     "hint": "Demucs, splitting a song into stems — and on a satellite, the lead-vocal "
             "separation that follows one.",
     "satellite": True},
    {"key": COMFYUI,     "label": "ComfyUI controls",
     "hint": "Optional controls for an independently installed ComfyUI service.",
     "satellite": False},
    {"key": ACESTEP,     "label": "ACE-Step",
     "hint": "Music generation. Unticking a card STOPS its ACE-Step backend — this one "
             "switches a service rather than filtering a dispatch.",
     "satellite": False},
)

KEYS = tuple(s["key"] for s in SUBSYSTEMS)
_DOCKER_EXCLUDED = frozenset({COMFYUI})

#: Subsystem keys a standalone Vocalis writes into a card's `uses` map that Docker never offers:
#: Voice Swap/RVC and LoRA Studio are not in this product at all, and ComfyUI controls are hidden in
#: Docker mode. Settings > Devices must not erase them on save (October 10, 2026, in-place switch
#: design, item 6): the same `app_settings.yaml` goes back to the standalone install on a
#: switch-back, and a user who unticked one there would find it silently ticked again.
_LEGACY_KEYS = (TRAINING, SWAP, COMFYUI)


def keys_for_mode(docker_mode: bool = False) -> tuple[str, ...]:
    """Subsystem keys exposed by this runtime profile."""
    if docker_mode:
        return tuple(key for key in KEYS if key not in _DOCKER_EXCLUDED)
    return KEYS


def rows_for_mode(docker_mode: bool = False) -> list[dict]:
    """Device settings rows visible in the active runtime profile."""
    keys = set(keys_for_mode(docker_mode))
    return [row for row in SUBSYSTEMS if row["key"] in keys]


def capable(device_id: str, *, docker_mode: bool = False, leadvocal_ready=None) -> list:
    """The subsystems this device can run AT ALL — capability, never authorization.

    Capability and authorization are separate. The UI should offer a control only for work the
    device supports. CPU is available for speech, but GPU-bound voice, stem, and RVC workloads
    do not have a CPU path.

    `leadvocal_ready` is what the satellite's own health says about its lead-vocal environment
    (`leadvocal_ready` in the satellite's /health). `None` (the default) means "not asked": the
    static answer, which is what the SAVE path uses so a stored choice is never normalized away
    just because the satellite is asleep. `True`/`False` is the display path (release audit,
    2026-10-11, item 3): a satellite that does not report the capability is not offered Stems,
    because the work would silently stay on this machine (`stemsplit` skips it).
    """
    dev = str(device_id or "")
    if ":" in dev and not dev.startswith("cuda:"):      # 'satellite-a:cuda:0' — a satellite card
        # Remote satellites support lead-vocal separation, but not the local Demucs stage.
        # Missing satellite dependencies are an availability state reported by health, not a
        # change in device capability — EXCEPT for the display path above, which only offers
        # Stems to a satellite that has said it can take the work.
        return [key for key in (RENDER, STEMS)
                if key in keys_for_mode(docker_mode)
                and not (key == STEMS and leadvocal_ready is not None and not leadvocal_ready)]
    if dev == "cpu":
        return [RENDER]
    return list(keys_for_mode(docker_mode))


def authorized(cfg: dict, sub: str) -> bool:
    """Is `sub` allowed on the device whose saved row is `cfg`?

    An absent `uses` key allows the subsystem, preserving legacy configurations. The separate
    top-level `enabled` flag is checked by callers and controls the whole device row.
    """
    if not isinstance(cfg, dict):
        return True
    uses = cfg.get("uses")
    if not isinstance(uses, dict):
        return True
    return bool(uses.get(sub, True))


def clean_uses(raw, device_id: str, *, docker_mode: bool = False) -> dict:
    """Normalize a submitted `uses` map: known keys only, capability-filtered, bools.

    Returns `{}` for "nothing to say", which `authorized()` reads as everything allowed — so a
    row the user never narrowed stores no map at all rather than five explicit `true`s. That
    keeps the file readable and keeps a future subsystem's default in ONE place (here), instead
    of frozen into every row the day it was saved.

    Drop keys unsupported by the device rather than storing a denial for a capability that may be
    added later.
    """
    if not isinstance(raw, dict):
        return {}
    allowed = set(capable(device_id, docker_mode=docker_mode))
    return {k: bool(raw[k]) for k in keys_for_mode(docker_mode)
            if k in raw and k in allowed}


def preserved_uses(stored, *, docker_mode: bool = False) -> dict:
    """The part of a card's STORED `uses` map that a Docker-mode save must carry over untouched.

    That is every key of `_LEGACY_KEYS` that this runtime profile does not offer (training and swap,
    plus comfyui in Docker mode), copied with the exact stored value, not coerced: the standalone
    install owns their meaning. Returns `{}` outside Docker mode, where saving behaves as it always
    has, and for a row with no (or a malformed) `uses` map. Offered keys are never returned here;
    those come only from `clean_uses` of what the browser sent."""
    if not docker_mode or not isinstance(stored, dict):
        return {}
    offered = set(keys_for_mode(docker_mode))
    return {k: stored[k] for k in _LEGACY_KEYS if k in stored and k not in offered}
