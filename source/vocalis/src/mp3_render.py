"""Render text to progressive MP3 blocks without HTTP or cache ownership. Mp3Render starts the source and encoder, yields encoded blocks, and reports done only after successful source completion without cancellation. Callers that stop consuming blocks must close the render."""
import subprocess
import threading

import numpy as np
from loguru import logger

import vault_fs
from vocalis_streaming import stream_message

# The app-standard bitrate (book chapters + playground clips are already 96k mono).
# The source is 24 kHz mono speech (nothing above 12 kHz), where 96k mono is
# transparent — and MP3 at a 24 kHz sample rate caps at 160k anyway (the old
# "192k" was silently clamped by lame). The cache tees these exact bytes.
MP3_BITRATE = "96k"
READ_BLOCK  = 4096

# Reject cache entries shorter than the configured playable duration. File existence alone can misclassify an incomplete render as a cache hit and return silence.
# Use a time-based floor so the threshold remains meaningful if the bitrate changes. A rejected entry is treated as a miss and can be rendered again.
MIN_PLAYABLE_S = 0.25


def mp3_seconds(size_bytes) -> float:
    """Estimate the duration of a constant-bitrate mono MP3 from its size in bytes, without decoding. This is valid for cache entries written at `MP3_BITRATE`; it avoids probing and decrypting each entry merely to calculate duration."""
    bits = int(str(MP3_BITRATE).rstrip("kK")) * 1000
    return (float(size_bytes) * 8.0) / bits


def cache_hit(cpath) -> bool:
    """Return whether `cpath` contains playable audio. Keep this shared check consistent for the state endpoint, stream endpoint, token route, and prerender queue. Missing and undersized files are both cache misses; log undersized files because they indicate an incomplete render."""
    if cpath is None:
        return False
    st = vault_fs.stat(cpath)
    if st is None:
        return False                              # ordinary miss
    if playable_size(st.size):
        return True
    # Not a miss anyone expected: something wrote a file here that is too short to be audio.
    # Named at INFO with its size and duration so a recurrence is traceable to a render rather
    # than being rediscovered months later as "that green button that plays nothing".
    logger.info(f"cache entry too short to be audio ({st.size} B, "
                f"{mp3_seconds(st.size):.3f}s < {MIN_PLAYABLE_S}s) — treating as a MISS")
    return False


def playable_size(size_bytes) -> bool:
    """Is a cache entry of this size long enough to be audio rather than wreckage?

    Takes a SIZE, not a path, deliberately: the rule lives here in one place while the I/O stays
    at each call site, which already has the vault stat in hand. Two copies of a rule that has to
    agree across processes is the defect 9.0.16 shipped to fix — see `STATE_ALIAS` in the
    SillyTavern extension."""
    return size_bytes is not None and mp3_seconds(size_bytes) >= MIN_PLAYABLE_S


class Mp3Render:
    """One message rendering to encoded MP3 off the shared pool.

    pool         — the WorkerPool (only `.sr` is read here; the source uses the rest)
    text/params  — what to say and how (`tts_utils.GenParams`)
    cancel       — shared Event: set it and generation aborts mid-chunk (the pool
                   installs it as the token loop's `_GEN_CANCEL.event`)
    make_stream  — optional custom source `(pool, cancel, config) -> iterator of
                   float32 mono arrays` (the playground's resume/bank path)
    st_speech    — this is a SillyTavern message being played right now, so chunks 2+
                   batch no wider than that satellite's `st_max_batch` (11.2). Ignored
                   with `make_stream`: a custom source does its own submitting, and the
                   two callers that use one (the playground's resume, the pre-render
                   queue's replay) are not live SillyTavern speech.
    on_finish    — called `(state, error)` from the writer thread's `finally`, at
                   the exact moment the old inline writer updated the registry
                   entry. Deliberately NOT deferred to `blocks()`'s finally: the
                   `/status` truncation check reads that state, and moving when it
                   is published would be a behavior change wearing a refactor's
                   clothes.
    """

    def __init__(self, pool, text, params, *, cancel=None, config=None,
                 make_stream=None, bitrate=MP3_BITRATE, label="", on_finish=None,
                 st_speech=False):
        self.pool    = pool
        self.text    = text
        self.params  = params
        self.cancel  = cancel if cancel is not None else threading.Event()
        self.config  = config
        self.make    = make_stream
        self.bitrate = bitrate
        self.label   = label or "stream"
        self.st_speech = bool(st_speech)
        self._on_finish = on_finish

        self.state   = "new"          # new -> live -> done | error | canceled
        self.error   = None           # str, set with state == "error"
        self.samples = 0              # PCM samples generated (0 => nothing to promote)
        self._proc   = None
        self._thread = None
        self._closed = False

    # ── lifecycle ────────────────────────────────────────────────────────────────

    def start(self):
        """Spawn ffmpeg and the writer thread. Raises (ffmpeg missing, etc.) BEFORE
        anything has been generated, so the caller can still fail the request
        cleanly — which is why this is separate from `blocks()`."""
        assert self.state == "new", "Mp3Render.start() is once-only"
        self._proc = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-f", "s16le", "-ar", str(self.pool.sr), "-ac", "1", "-i", "pipe:0",
             "-f", "mp3", "-b:a", self.bitrate, "-flush_packets", "1", "pipe:1"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.state = "live"
        self._thread = threading.Thread(target=self._writer, daemon=True)
        self._thread.start()

    def _writer(self):
        """Drives generation; feeds PCM to ffmpeg."""
        proc, done = self._proc, False
        try:
            gen = (self.make(self.pool, self.cancel, self.config) if self.make is not None
                   else stream_message(self.pool, self.text, self.params,
                                       config=self.config, cancel=self.cancel,
                                       st_speech=self.st_speech))
            for chunk in gen:
                self.samples += len(chunk)
                pcm = (np.clip(chunk, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
                proc.stdin.write(pcm)
            # A canceled stream_message RETURNS cleanly — completion means "the
            # loop ended AND nobody canceled", not just "no exception".
            done = not self.cancel.is_set()
        except (BrokenPipeError, OSError):
            pass                             # ffmpeg died (client gone) — cancel path
        except Exception as exc:             # noqa: BLE001
            self.error = str(exc)
            logger.exception(f"[{self.label}] generation failed mid-stream")
            # Abrupt stop: don't let ffmpeg flush a clean-looking tail — the
            # consumer at least gets a hard truncation instead of a tidy ending.
            try:
                proc.kill()
            except OSError:
                pass
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass
            self.state = "done" if done else ("error" if self.error else "canceled")
            if self._on_finish is not None:
                try:
                    self._on_finish(self.state, self.error)
                except Exception:            # noqa: BLE001 — bookkeeping must not kill the render
                    logger.exception(f"[{self.label}] on_finish hook failed")

    def blocks(self, block_size=READ_BLOCK):
        """Yield encoded MP3 blocks until ffmpeg reaches EOF. Always closes the
        render down on the way out — including on GeneratorExit (the consumer went
        away), which is what stops a disconnected client's GPU work."""
        try:
            while True:
                block = self._proc.stdout.read(block_size)
                if not block:
                    break
                yield block
        finally:
            self.close()

    def close(self):
        """Stop generation and reap the child. Idempotent; safe from any thread."""
        if self._closed:
            return
        self._closed = True
        self.cancel.set()                    # no-op if generation already finished
        if self._proc is not None:
            try:
                self._proc.kill()
            except OSError:
                pass
        if self._thread is not None:
            self._thread.join(timeout=5.0)
        if self.state == "live":             # writer never reached its finally
            self.state = "canceled"

    # ── accounting ───────────────────────────────────────────────────────────────

    @property
    def audio_s(self) -> float:
        return self.samples / self.pool.sr if self.pool.sr else 0.0

    @property
    def promotable(self) -> bool:
        """Whether this render's bytes may be kept: it finished, and it produced
        audio. Both halves matter — a zero-sample "success" would cache silence."""
        return self.state == "done" and self.samples > 0
