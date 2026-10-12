#!/usr/bin/env python3
"""Resolve Nomi voice-map settings and manage its audio cache while sending generation through the shared WorkerPool at interactive priority. Read per-Nomi settings from the nomi section and use the configured default only for missing parameters."""
import hashlib
from pathlib import Path

import yaml
from loguru import logger


class NomiSpeaker:
    """Resolve a Nomi identifier to its configured voice and generation parameters, and manage its MP3 cache. Reload the `nomi` settings section when it changes. Cache keys include the voice filename, modification time, parameters, and text; `force` bypasses reuse. `max_cached_files` applies per speaker."""

    def __init__(self, settings_yaml, voice_samples, cache_root, max_cached_files: int = 10000):
        self.settings_yaml  = Path(settings_yaml)
        self.voice_samples  = Path(voice_samples)
        self.cache_root     = Path(cache_root)
        self.max_cached     = max_cached_files      # PER SPEAKER since 5.3.3, not per store
        self._legacy_swept  = False
        self.config         = {}     # the raw `nomi` section: {<id>: entry, default_voice}
        self.mtime          = 0.0
        self.load_config()

    # ── config ────────────────────────────────────────────────────────────────
    def load_config(self):
        """Read the `nomi` section through the vault-aware filesystem. Keep the last valid mapping on parse or shape errors so an incomplete settings write does not clear configured speakers. This is a separate reader from `voice_utils`; both must use the vault-aware path."""
        import vault_fs
        try:
            parsed = yaml.safe_load(vault_fs.read_text(self.settings_yaml))
        except vault_fs.locked_exc():
            # The module-level NomiSpeaker may be constructed before the vault is unlocked. Defer this read and leave `mtime` at zero so the first request after unlock retries the load.
            logger.info("nomi: vault locked — deferring the config load until unlock")
            return
        except FileNotFoundError:
            self.config = {}
            return
        except yaml.YAMLError as exc:
            logger.warning(f"voice_settings.yaml parse failed, keeping previous config: {exc}")
            return
        if not isinstance(parsed, dict):
            logger.warning("voice_settings.yaml is empty or not a mapping — keeping previous config")
            return
        sec = parsed.get("nomi")
        self.config = sec if isinstance(sec, dict) else {}
        st = vault_fs.stat(self.settings_yaml)
        if st is not None:
            self.mtime = st.mtime

    def reload_if_changed(self):
        """Reload the config if voice_settings.yaml has been saved since last
        load (per-request). Any tab's save bumps the mtime — a re-read of the
        unchanged `nomi` section is cheap and harmless.

        The vault reports the PHYSICAL mtime on purpose (vault.Vault.stat) — precisely so this
        poll, and clear_cache's os.utime, still see a number that moves."""
        import vault_fs
        try:
            st = vault_fs.stat(self.settings_yaml)
        except vault_fs.locked_exc():
            return                       # locked: nothing to poll, and load_config defers too
        if st is None:
            return
        if st.mtime != self.mtime:
            self.load_config()

    def resolve(self, nomi_id, nomi_name=""):
        """Nomi id/name → {voice(Path), voice_filename, exaggeration, cfg_weight,
        temperature, narrate_actions}. Unknown id falls back to a name match
        (group chats have no id in the URL), then to default_voice. Params come
        from the Nomi's OWN entry or the chatterbox default — nothing else."""
        # default_voice is a plain-string sibling of the id-keyed entries.
        nomis = {str(k): v for k, v in self.config.items() if isinstance(v, dict)}
        entry = nomis.get(str(nomi_id))
        if entry is None and nomi_name:
            for e in nomis.values():
                if str(e.get("name", "")).lower() == nomi_name.lower():
                    entry = e
                    break
        if entry is None:
            logger.warning(f"nomi {nomi_id!r}/{nomi_name!r} not in the Nomi map — using default_voice")
            voice_file = str(self.config.get("default_voice", "") or "")
        else:
            voice_file = entry.get("voice", "") or ""
            if not voice_file:
                logger.warning(f"nomi {nomi_id!r}/{nomi_name!r} has no voice — using default_voice")
                voice_file = str(self.config.get("default_voice", "") or "")
        entry = entry or {}

        def val(key, default):
            v = entry.get(key)
            return default if v is None else v
        return {
            "voice":           self.voice_samples / voice_file,
            "voice_filename":  voice_file,
            "exaggeration":    val("exaggeration", 0.5),
            "cfg_weight":      val("cfg", 0.5),
            "temperature":     val("temperature", 0.8),
            # narrate_actions: speak *action* spans (default) or dialogue-only.
            # Applied to the text in request_context BEFORE the cache key, so
            # ON/OFF key apart naturally.
            "narrate_actions": bool(val("narrate_actions", True)),
        }

    # ── shared request/param/cache helpers ────────────────────────────────────
    # /speak and /speak/stream MUST agree byte-for-byte on request parsing, the
    # cfg→GenParams mapping, and the cache-write protocol: both endpoints share
    # ONE MD5 cache, so a drift between copies would render different audio under
    # the same key (silent cache poisoning). These helpers are the single copy.

    def register_unknown(self, nomi_id, nomi_name):
        """Auto-create a card for a Nomi we've never seen (id -> {name, voice:""}),
        the way the SillyTavern extension auto-registers characters
        (st_characters.upsert_seen). The card then shows up in the web UI's Nomi
        tab pre-filled with the id and name, ready for a voice; until one is
        assigned the Nomi speaks with default_voice — resolve() already does that,
        so this changes nothing about playback, it only surfaces the Nomi for setup.

        Best-effort: ANY failure is logged and swallowed — a brand-new Nomi must
        still be spoken, never a 500 on the open /speak. The persist goes through
        voice_utils.add_section_entry, whose read-modify-write is atomic under the
        settings lock and strict (a corrupt file aborts the add, it never rebuilds
        the section from one entry). It never runs on a locked vault: /speak and
        /speak/stream 401 while locked (design §5.3), so we don't reach here — and
        if we somehow did, the strict load raises and we swallow it."""
        nomi_id = str(nomi_id or "").strip()
        if not nomi_id or nomi_id in ("None", "null"):
            return                              # group chat with no resolvable id
        # Fast path: request_context reloaded the config first, so this in-memory
        # membership check spares a file read on every play of a known Nomi.
        if nomi_id in {str(k) for k, v in self.config.items() if isinstance(v, dict)}:
            return
        name = "" if str(nomi_name) == "unknown" else str(nomi_name or "")
        import voice_utils
        try:
            added = voice_utils.add_section_entry(
                self.settings_yaml, "nomi", nomi_id, {"name": name, "voice": ""})
        except (voice_utils.SettingsUnreadable, OSError):
            # Handle only settings-read and filesystem errors here so speech can fall back to `default_voice`. Vault authentication is handled by the request boundary; do not hide it in a broad exception handler.
            logger.exception(f"nomi: could not auto-create a card for {nomi_id!r}")
            return
        if added:
            logger.info(f"[nomi] auto-created card for {nomi_id} ({name!r})")
            self.load_config()                  # this instance resolves it immediately

    def request_context(self, data: dict) -> dict:
        """Parse a /speak-shaped JSON body into everything both endpoints need:
        {text, force, nomi_name, cfg, key, cpath, owner} (cache dir created).
        Raises ValueError on empty text (callers map it to HTTP 400)."""
        self.reload_if_changed()
        nomi_id   = str(data.get("nomi_id", ""))
        nomi_name = str(data.get("nomi_name", "unknown"))
        text      = str(data.get("text", "")).strip()
        if not text:
            raise ValueError("empty text")
        # A Nomi the map has never seen gets a card now (id + name pre-filled), so
        # it appears in the Nomi tab for voice assignment. Shared by /speak and
        # /speak/stream since both go through here.
        self.register_unknown(nomi_id, nomi_name)
        cfg   = self.resolve(nomi_id, nomi_name)
        # Asterisk *action* filtering happens BEFORE the cache key: the filtered
        # text is the key input, so narrate-on and narrate-off (different texts)
        # can never collide under one key.
        from tts_utils import filter_actions
        text = filter_actions(text, cfg.get("narrate_actions", True))
        if not text:
            raise ValueError("no speakable text (nothing with a letter or digit in it is "
                             "left for this Nomi)")
        import vault_fs
        key   = self.cache_key(cfg, text)
        # The speaker that owns this entry's slice of the cache. The Nomi ID, not its display
        # name: the name is editable and renaming one would orphan its whole cache.
        owner = f"nomi:{nomi_id}"
        cpath = self.cache_path(key, owner)
        # Routed, not a plain mkdir: an unrouted one creates a CLEARTEXT-named directory inside
        # the encrypted store, which the real (encrypted) one is then created beside — leaving a
        # stray empty dir that listdir has to step over forever.
        vault_fs.mkdir(cpath.parent)
        return {"text": text, "force": bool(data.get("force", False)),
                "nomi_name": nomi_name, "cfg": cfg, "key": key, "cpath": cpath,
                "owner": owner}

    @staticmethod
    def gen_kwargs(cfg) -> dict:
        """cfg (from resolve()) → GenParams kwargs. The one true mapping.
        (Seedless since 3.x — stale `seed:` keys in old YAML are ignored.)"""
        return {"voice": str(cfg["voice"]) if cfg["voice_filename"] else None,
                "exaggeration": cfg["exaggeration"], "cfg": cfg["cfg_weight"],
                "temperature": cfg["temperature"]}

    def store_wav(self, key: str, wav, sr: int, owner: str = None):
        """Encode a rendered WAV tensor as a 96 kbps mono MP3 using plaintext scratch files, then write the finished MP3 through the vault-aware filesystem and run eviction. The method name is retained for callers even though the cached format is MP3."""
        import subprocess

        import scratch as scratch_mod
        import vault_fs
        from tts_utils import save_wav_sf
        cpath = self.cache_path(key, owner)
        root = scratch_mod.scratch_root()
        with scratch_mod.file(root, f"nomi-wav|{key}", ".wav") as tmp_wav, \
                scratch_mod.file(root, f"nomi-mp3|{key}", ".mp3") as tmp_mp3:
            save_wav_sf(str(tmp_wav), wav, sr)     # a scratch path: plaintext, deliberately
            r = subprocess.run(
                ["ffmpeg", "-y", "-i", str(tmp_wav), "-ac", "1", "-b:a", "96k",
                 "-f", "mp3", str(tmp_mp3), "-loglevel", "error"],
                capture_output=True, text=True, encoding="utf-8", errors="replace")
            if r.returncode != 0:
                raise RuntimeError(f"cache mp3 encode failed: {r.stderr.strip()}")
            vault_fs.from_scratch(tmp_mp3, cpath)
        self.evict(owner)

    def promote_temp(self, tmp, key: str, owner: str = None):
        """Atomically promote an already-written temp MP3 into the cache (the
        streaming tee writes the encoded bytes incrementally, then promotes),
        then evict.

        `tmp` is a SCRATCH path — the tee writes plaintext MP3 frames to it as they come off
        ffmpeg — so this is a plaintext→store boundary like any other, and `from_scratch` is
        what crosses it."""
        import vault_fs
        try:
            vault_fs.from_scratch(tmp, self.cache_path(key, owner))
        finally:
            Path(tmp).unlink(missing_ok=True)
        self.evict(owner)

    # ── cache ─────────────────────────────────────────────────────────────────
    def cache_key(self, cfg, text) -> str:
        """Return the cache key for the selected voice, modification time, generation parameters, and text. Fingerprint the voice through `source_stat` so encrypted stores use the logical file identity without hashing the voice bytes. Treat an absent voice as an empty sentinel."""
        from tts_utils import source_stat
        vp    = cfg["voice"]
        # An empty voice sentinel can become `Path(".")`, which is truthy and points at the current working directory. Normalize empty and dot values before building the source fingerprint; otherwise unrelated directory changes invalidate cached renders.
        vp    = None if vp is None or str(vp) in ("", ".") else vp
        st    = source_stat(vp) if vp else None
        mtime = st[1] if st else 0
        params = f"{cfg['exaggeration']}:{cfg['cfg_weight']}:{cfg['temperature']}"
        return hashlib.md5(
            (cfg["voice_filename"] + "\0" + str(mtime) + "\0" + params + "\0" + text).encode()
        ).hexdigest()

    @staticmethod
    def owner_dir(owner: str) -> str:
        """Return an opaque directory name for one speaker. Hashing the user-selected owner prevents character or Nomi names from appearing in cache paths. The 16-character prefix distinguishes owner directories from two-character key shards."""
        return hashlib.md5(str(owner or "").encode()).hexdigest()[:16]

    def cache_path(self, key, owner: str = None) -> Path:
        """`<root>/<owner>/<key[:2]>/<key>.mp3`, or the pre-5.3.3 flat layout when no owner is
        given — reads of old entries and any caller that genuinely has no speaker."""
        if owner is None:
            return self.cache_root / key[:2] / (key + ".mp3")
        return self.cache_root / self.owner_dir(owner) / key[:2] / (key + ".mp3")

    def evict(self, owner: str = None):
        """Remove the oldest cache files beyond max_cached within one speaker subtree. Skip in-flight part files and legacy chunk directories, and include both WAV and MP3 so old entries can age out. Walk each vault directory through listdir because stored names are encrypted on disk."""
        import vault_fs
        # Sweep the legacy flat layout only when evicting a specific owner. An unscoped eviction writes to that layout and could delete the entry it just created.
        # Set the one-time flag before the sweep so an I/O error does not make every speech request repeat the cleanup. Keep authentication failures visible.
        if owner is not None and not self._legacy_swept:
            self._legacy_swept = True         # set FIRST: a failed sweep must not retry forever
            try:
                self.evict_legacy()
            except OSError as exc:
                # Narrow on purpose. A cleanup of unreachable files must never 500 the speech
                # request it is attached to — but a LOCKED vault is not caught here and must
                # not be: the walk below would fail on the same lock, and swallowing it would
                # only move the error somewhere less informative. (Nor is a blind `except`
                # wanted: `test_the_blind_except_count_has_not_quietly_exploded` counts these,
                # and it fired on the first draft of this line, correctly.)
                logger.warning(f"audio cache: the legacy sweep failed ({exc}) — harmless, the "
                               f"old entries stay until the next restart")
        root = self.cache_root if owner is None else self.cache_root / self.owner_dir(owner)
        candidates = []
        for f in self._entries_under(root):
            st = vault_fs.stat(f)
            if st is not None:                 # None => unlinked by a concurrent eviction; skip
                candidates.append((st.mtime, f))
        candidates.sort()
        while len(candidates) > self.max_cached:
            vault_fs.unlink(candidates.pop(0)[1], missing_ok=True)

    def _entries_under(self, root) -> "list":
        """Every cache entry directly beneath `root`, as `<root>/<shard>/<file>`.

        ⚠️ Shard directories only. Under the cache root itself that would also walk into the
        OWNER directories — whose children are shards, not files — so nothing is yielded from
        them and a per-owner sweep never sees another owner's entries.
        """
        import vault_fs
        out = []
        for sub in vault_fs.listdir(root):
            d = root / sub
            if not vault_fs.is_dir(d):
                continue
            for name in vault_fs.listdir(d):
                if "__chunks__" in name or ".part." in name:
                    continue                   # in-flight temp / legacy dir — not an entry
                if name.endswith((".mp3", ".wav")):
                    out.append(d / name)
        return out

    def owner_usage(self, owner: str) -> tuple:
        """`(messages, bytes)` cached for one speaker — the count and PLAINTEXT size of every
        entry in its sub-tree. Feeds the "cached messages" field beside 🧹 Clear (11.2.9).

        One `stat` per entry, the same walk `evict` already does after every write, so it is
        no new kind of cost — but it is not free on a big cache, which is why the web UI asks
        for all speakers in ONE request rather than once per row."""
        import vault_fs
        root = self.cache_root / self.owner_dir(owner)
        if not vault_fs.is_dir(root):
            return 0, 0
        n = size = 0
        for f in self._entries_under(root):
            st = vault_fs.stat(f)
            if st is not None:                 # None => evicted under us; not counted
                n += 1
                size += st.size
        return n, size

    def clear_owner(self, owner: str) -> tuple:
        """Delete every cached entry for one speaker and return the number of files and bytes removed. This removes entries made unreachable by a voice change instead of waiting for capacity eviction."""
        import vault_fs
        root = self.cache_root / self.owner_dir(owner)
        if not vault_fs.is_dir(root):
            return 0, 0
        n = size = 0
        for f in self._entries_under(root):
            st = vault_fs.stat(f)
            if st is None:
                continue
            vault_fs.unlink(f, missing_ok=True)
            n += 1
            size += st.size
        return n, size

    def evict_legacy(self) -> int:
        """Delete cache entries in the old unscoped layout, which current owner-scoped lookups cannot reach. Run this once per process after the vault is unlocked; entries in the old layout must be rendered again if requested."""
        import vault_fs
        dead = []
        for sub in vault_fs.listdir(self.cache_root):
            d = self.cache_root / sub
            # An owner directory is 16 hex; a shard is 2. Only the legacy layout puts a shard
            # at the top level, so the length IS the discriminator between the two layouts.
            if len(sub) != 2 or not vault_fs.is_dir(d):
                continue
            for name in vault_fs.listdir(d):
                if "__chunks__" in name or ".part." in name:
                    continue                   # in-flight temp / legacy dir — not an entry
                if name.endswith((".mp3", ".wav")):
                    dead.append(d / name)
        for f in dead:
            vault_fs.unlink(f, missing_ok=True)
        if dead:
            logger.info(f"audio cache: dropped {len(dead)} entry(s) from the pre-5.3.3 flat "
                        f"layout — unreachable once the cache became per-speaker")
        return len(dead)
