"""The Nomi speaker singleton — the `nomi` section of voice_settings.yaml, plus its clip cache.

Moved out of `vocalis_server.py` in 5.1-P4.8. One object, three consumers in three domains:
`/speak` (web/speech.py), the Nomi admin tab (web/nomi.py), and `create_stream_blueprint`,
which takes it as an injected parameter — the same tell as `voice_options` and `resolve_voice`
in `runtime/voices.py`, and it can stop being injected in Phase 5.

**A module-level singleton, deliberately, and it stays one.** `NomiSpeaker` holds the parsed
config and an LRU over the MP3 cache; two instances would mean two caches disagreeing about
what has been evicted, and `/nomi` PUT calls `load_config()` on THIS object so that `/speak`
reflects an edit on the very next request. A factory function would hand out a fresh, cold,
empty-cache speaker to whoever asked second.
"""
import os

from nomi_speak import NomiSpeaker

from vocalis.runtime import paths

# The cache limit applies independently to each speaker. At the default of 5,000 files, a
# speaker's cache has a bounded size without imposing one shared limit across all speakers.
NOMI = NomiSpeaker(paths.VOICE_SETTINGS, paths.VOICE_SAMPLES, paths.AUDIO_CACHE,
                   max_cached_files=int(os.environ.get("VOCALIS_NOMI_MAX_CACHED", "5000")))
