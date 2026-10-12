"""Shared Chatterbox TTS utilities — the single source of truth for the TTS logic that
book_to_audio.py, vocalis_server.py and nomi_speak.py all share."""

PRODUCT_NAME = "Vocalis"
# Bump this on every deploy; the value is shown in the startup banner, /health, and login page.
# Keep release values monotonic, including milestone builds.

VERSION = "12.1.1"


class VocalisError(RuntimeError):
    """A user-actionable failure from the shared library (bad --gpus value, no
    workers loadable, …). Library code raises THIS — never SystemExit: SystemExit
    is not an Exception, so it sails through the servers' `except Exception`
    handlers and kills the thread silently (job stuck 'running' forever, HTTP
    request dropped with no response). CLI entry points catch it and exit(1)
    with the message, preserving the old clean-exit behavior."""

import ctypes
import datetime
import errno
import hashlib
import io
import itertools
import json
import logging
import os
import queue as _queue
import re
import shutil
import subprocess
import sys
import threading
import time
import warnings
from dataclasses import dataclass
from pathlib import Path

from loguru import logger

from engine_process import SETUP_HINT


class GenerationCanceled(Exception):
    """Raised inside the model's token-sampling loop when the batch's cancel Event
    is set — aborts an IN-FLIGHT chunk within one token step (nothing saved; resume
    regenerates it) instead of letting up to 40 s of audio finish pointlessly."""


# The active batch's cancel Event, seen by the token loop running on this worker
# thread (set/cleared around each generate in _worker_loop).
_GEN_CANCEL = threading.local()

# Windows consoles default to cp1252 which can't encode the Unicode symbols
# used in progress output (✓, →, etc.). Force UTF-8 on stdout AND stderr
# (loguru writes to stderr) for all scripts that import this module.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8')

# Suppress noisy third-party library warnings at import time.
warnings.filterwarnings("ignore", category=FutureWarning, message=".*LoRACompatibleLinear.*")
warnings.filterwarnings("ignore", category=FutureWarning, message=".*sdp_kernel.*")
try:
    # transformers manages its own internal log level separately from Python's
    # logging hierarchy — must use their API, not logging.getLogger().
    from transformers.utils import logging as _hf_logging
    _hf_logging.set_verbosity_error()
except ImportError:
    pass

# Chunk size derivation (verified against installed model source):
#   chatterbox/tts.py:           max_new_tokens = 1000  (T3 speech-token hard cap)
#   chatterbox/models/s3tokenizer/s3tokenizer.py:  S3_TOKEN_RATE = 25  (tokens/sec)
#   Hard audio ceiling: 1000 tokens / 25 tokens/sec = 40 seconds per chunk
#   At ~150 words/min English speech: 40s ≈ 100 words ≈ 500–600 characters
#   We target 400 chars ≈ 27s — leaves ~35% headroom below the hard cap while
#   giving quality room before voice drift / pacing issues appear near the ceiling.
CHUNK_SIZE     = 400  # max chars per TTS chunk (verified safe quality target)
MIN_CHUNK_SIZE =  80  # trailing chunks shorter than this are merged into the previous


ENV_FILE_NAME = "vocalis.env"


def load_env_file(install_root, *, override: bool = False) -> tuple:
    """Load `vocalis.env` from the install root into the process environment.

    Returns `(path, values)` or `(None, {})` when no file is present. Existing environment
    values win unless `override=True`. The shared file keeps per-install configuration
    consistent between systemd and command-line tools. It accepts the systemd
    EnvironmentFile subset: `KEY=VALUE`, blank lines, `#` comments, and optional quotes
    around values.
    """
    path = Path(install_root) / ENV_FILE_NAME
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return (None, {})
    applied = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name, value = name.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not name or (name in os.environ and not override):
            continue
        os.environ[name] = value
        applied[name] = value
    return (path, applied)


def cache_root() -> Path:
    """Base dir for Vocalis's regenerable/disposable data — the MD5 audio cache and
    the transient render workspaces (chunks/). Deliberately NOT under the install
    root: it follows each OS's cache convention so backup tools skip it and 'safe to
    delete' semantics are obvious. Finished artifacts (rendered books, the Playground
    clip library) live under output/ in the install root and are unaffected.

      * $VOCALIS_CACHE_DIR wins if set — the one override (systemd unit, tests).
      * Windows: %LOCALAPPDATA%\\Vocalis\\cache  (never Program Files; local, non-roaming)
      * macOS:   ~/Library/Caches/vocalis
      * Linux/other POSIX: $XDG_CACHE_HOME/vocalis  else  ~/.cache/vocalis

    Callers create their own subdirs lazily (mkdir parents=True), so the tree
    materializes on first use — nothing is created just by importing this module."""
    env = os.environ.get("VOCALIS_CACHE_DIR")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "Vocalis" / "cache"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "vocalis"
    xdg = os.environ.get("XDG_CACHE_HOME")
    return (Path(xdg) if xdg else Path.home() / ".cache") / "vocalis"


# Colorized ACE-Step-style log format, BRIGHT palette (light-* = the vivid/bold ANSI
# variants, to match a GNOME-terminal look): bright-green time | level | bright-cyan
# module:func:line - message.
_LOG_FORMAT = ("<light-green>{time:YYYY-MM-DD HH:mm:ss.SSS}</light-green> | "
               "<level>{level: <8}</level> | "
               "<light-cyan>{name}</light-cyan>:<light-cyan>{function}</light-cyan>:<light-cyan>{line}</light-cyan> - "
               "<level>{message}</level>")


#: Limit cause/context traversal before Loguru's recursive formatter renders an exception.
#: The optional torio FFmpeg-extension probe can chain failures across versions and library
#: names, then log at DEBUG and continue; formatting that handled failure can still exceed a
#: deep caller's stack. Keep the cap above ordinary chains and below that probe's chain length.
_MAX_EXC_CHAIN = 12

_CHAIN_DROPPED = ("  [traceback not rendered: exception chain longer than %d links, which "
                  "recurses loguru's formatter into a RecursionError]" % _MAX_EXC_CHAIN)


def _exc_chain_depth(exc, cap):
    """Length of `exc`'s chain, counting to at most `cap + 1`.

    Walks the SAME edges loguru's formatter walks — `__cause__` first, else `__context__`
    unless `__suppress_context__` — so the number this returns is the number of recursions
    that formatter would perform. Stops at `cap + 1` because nothing above the cap needs
    distinguishing, and stops on a repeat because a chain is allowed to be cyclic.
    """
    seen, depth = set(), 0
    while exc is not None and id(exc) not in seen and depth <= cap:
        seen.add(id(exc))
        depth += 1
        if exc.__cause__ is not None:
            exc = exc.__cause__
        elif exc.__context__ is not None and not exc.__suppress_context__:
            exc = exc.__context__
        else:
            exc = None
    return depth


class InterceptHandler(logging.Handler):
    """Route stdlib / third-party logging records (werkzeug, transformers, …)
    through loguru so dependency logs get the same pretty format.

    ⚠️ `setup_logging` installs this at `level=0`, i.e. it claims EVERY record any
    dependency ever emits, at every level, along with whatever exception that dependency
    attached. That is the point — but it means a third-party library's private DEBUG
    record gets rendered by our formatter, so its blast radius is ours. See
    `_MAX_EXC_CHAIN`.
    """
    def emit(self, record):
        try:
            level = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno
        frame, depth = logging.currentframe(), 2
        while frame and frame.f_code.co_filename == logging.__file__:
            frame = frame.f_back
            depth += 1
        exc_info = record.exc_info
        exc = exc_info[1] if exc_info else None
        if exc is not None and _exc_chain_depth(exc, _MAX_EXC_CHAIN) > _MAX_EXC_CHAIN:
            # Keep the message, drop the traceback. 📌 Still argless, so a message
            # containing braces is not run through str.format — same as the line below.
            logger.opt(depth=depth).log(level, record.getMessage() + _CHAIN_DROPPED)
            return
        logger.opt(depth=depth, exception=exc_info).log(level, record.getMessage())


def setup_logging(log_path=None, mode: str = 'a', colorize_file: bool = False) -> None:
    """Configure loguru once at an app entry point.

    - Drops loguru's default handler and adds a colorized stderr sink using
      _LOG_FORMAT; the level comes from $VOCALIS_LOG_LEVEL (default INFO).
      Deliberately NOT the generic $LOG_LEVEL: an ambient LOG_LEVEL=ERROR
      exported for some unrelated tool would silence every progress line and
      the final "Saved:"/"complete!" output of a multi-hour render.
    - If log_path is given, also adds a rotating file sink (10 MB rotation, keep 5).
      colorize_file=True keeps the bright ANSI colors IN the file, so a plain
      `tail -f logs/vocalis.log` (or `less -R`) shows them — the server uses this
      (systemd's journal strips the stderr colors, so the file is where you see
      them). Default False writes a plain-text file (CLI tools, greppable logs).
    - Installs InterceptHandler on the root logger so stdlib/library logs
      (werkzeug, etc.) flow through loguru too.
    `mode` is accepted for backward compatibility and ignored (rotation handles growth).
    """
    level = os.environ.get("VOCALIS_LOG_LEVEL", "INFO").upper()
    logger.remove()
    # Brighter per-level colors (vivid ANSI, GNOME-terminal-ish): loguru's defaults
    # leave INFO uncolored and use the dim color variants. Bump to the light-* /
    # bold variants so the level tag — and, via <level>, the message — pops. The
    # <level> color also drives the message color in _LOG_FORMAT above.
    for _lvl, _color in (("DEBUG",    "<light-black>"),
                         ("INFO",     "<light-white>"),
                         ("SUCCESS",  "<bold><light-green>"),
                         ("WARNING",  "<bold><light-yellow>"),
                         ("ERROR",    "<bold><light-red>"),
                         ("CRITICAL", "<bold><light-red>")):
        logger.level(_lvl, color=_color)
    # diagnose=False is NOT cosmetic and must not be "cleaned up" back to the default.
    # loguru's default is diagnose=True, which renders the LOCAL VARIABLES of every frame
    # on any logger.exception(). Those locals include `job` (job.text = the entire
    # Playground input), the raw SillyTavern chat line, and the Nomi message — so today
    # every unhandled render error writes the user's words, verbatim, into logs/vocalis.log
    # and (under systemd) the journal. Both sinks need it: stderr is captured by journald.
    # backtrace=True is kept: it shows the call stack, which is code, not user content.
    logger.add(sys.stderr, format=_LOG_FORMAT, level=level, colorize=True, enqueue=True,
               backtrace=True, diagnose=False)
    if log_path is not None:
        Path(log_path).parent.mkdir(parents=True, exist_ok=True)
        logger.add(str(log_path), format=_LOG_FORMAT, level=level, colorize=colorize_file,
                   rotation="10 MB", retention=5, enqueue=True, encoding="utf-8",
                   backtrace=True, diagnose=False)
    logging.basicConfig(handlers=[InterceptHandler()], level=0, force=True)
    # NB: we deliberately do NOT register atexit(logger.complete) to drain the
    # enqueue=True sinks. In practice it can block interpreter shutdown for minutes
    # (observed hanging generate.py at exit) — a far worse failure than the rare
    # dropped tail line it was meant to prevent. loguru already flushes enqueued
    # records when the process tears the sinks down on a normal exit.


def make_log_path(prefix: str, name: str, log_dir: Path, timestamp: bool = False) -> Path:
    """Build a log file path under log_dir.

    Date-only (same-day runs append to the same file):
        {prefix}_{name_h8}_{YYYY_MM_DD}.log
    Timestamped (new file each run — for servers):
        {prefix}_{YYYY_MM_DD_HHMMSS}.log

    `name` is HASHED, never spelled. It is the book's title (or the user's output name),
    and `logs/` lives OUTSIDE the vault by design — you need it to debug a locked server —
    so a plaintext title here is readable by anything that can `ls`, with no key at all.
    The h8 is stable per title, so same-day runs of the same book still share one file and
    two different books never collide.
    """
    now = datetime.datetime.now()
    if timestamp:
        stem = f"{prefix}_{now.strftime('%Y_%m_%d_%H%M%S')}"
    else:
        date = now.strftime('%Y_%m_%d')
        h8 = hashlib.sha256(name.encode("utf-8")).hexdigest()[:8] if name else ""
        stem = f"{prefix}_{h8}_{date}" if h8 else f"{prefix}_{date}"
    return log_dir / f"{stem}.log"


# A scene-break marker standing by itself: on its own line, or between two words when the sender
# has already flattened the message to one line. It ENDS the paragraph before it.
_BREAK_MARK = re.compile(
    r"(?<!\S)(?:"
    r"([*\-–—_=~#•·])\1{2,}"                    # one character, three or more: "***", "---", "###"
    r"|[*~=\-–—]{3,}"                           # a mixed rule: "~*~", "-=-", "*~*~*"
    r"|([*\-–—_=~#•·])(?:[ \t]+\2){2,}"         # "* * *", "- - -"
    r"|⁂"
    r")(?!\S)")
# Any other standalone run of symbols is taken out WITHOUT ending the sentence: an emoticon
# ("^_^", ">_<", "-_-"), a table pipe, a stray "#" or "~", a bullet. Treating these as scene breaks
# put a full stop in the middle of a sentence ("5 | 10" was read as "5. 10"). A lone "-", "--",
# "=", "+", "<", ">" or "*" between words is left alone: those are punctuation or arithmetic.
_STRAY_MARK = re.compile(
    r"(?<!\S)(?:[#~_\\|•·◇◆※]+|[*#=~_\\|•·◇◆※+<>^\-–—]{3,})(?!\S)[ \t]*")
_HEADING_MARK = re.compile(r"^(#{1,6}|>+)[ \t]+")                  # "## Title", "> quote"
# The opening run is two or three characters, which is what bold and bold-italic are. Unbounded
# (`\*{2,}`) it was cubic in the length of a run of asterisks stuck to a letter: about a second at
# 2,000 characters, minutes at 10,000, with the whole server waiting on it.
_WHOLE_LINE_BOLD = re.compile(r"^(\*{2,3}|_{2,3})(?:(?!\1).)+\1$")   # "**0900, the next morning**"
_HAS_WORDS = re.compile(r"[^\W_]")
_SENTENCE_END = ".!?…:;,-–—。！？．"
_CLOSERS = "\"'”’»)]*_」』）】》"


def _end_sentence(paragraph: str) -> str:
    """Give a paragraph a full stop when it ends without punctuation, inside any closing
    quote, bracket or emphasis mark."""
    body = paragraph.rstrip(_CLOSERS)
    if not body or body[-1] in _SENTENCE_END:
        return paragraph
    return body + "." + paragraph[len(body):]


def drop_unspeakable_markup(text: str, stops: str = "all") -> str:
    """Take out what has no words in it, and keep a heading from running into the next sentence.

    Doug, 2026-10-12: at a scene break in a chat ("***", then a line such as "0900 the next
    morning") Chatterbox said random words or made noises. Its tokenizer has a token for every one
    of these characters, so nothing fails; the model voices them. Measured that day on a 4090,
    three seeds each, by watching which text token the model attends to for each 40 ms of audio:

      - a marker between two sentences is "read" for 0.24–0.52 s ("***"), about 0.65 s ("---"
        before and after a heading) and 0.12–1.36 s ("###");
      - backslashes, which is what an escaped "\\*\\*\\*" leaves once its asterisks are stripped,
        take no time themselves, but one run in three then spent 2.84 s on a heading that takes
        1.4 s;
      - a marker rendered alone ("---", "* * *", "###") gives 0.4–1.6 s of sound from text that
        has no words.

    With the marker gone and the heading ended as its own sentence, each part of the line takes
    its normal time.

    What this does: a marker, or a line with no letter or digit in it, becomes a paragraph break;
    other standalone symbols (an emoticon, a table pipe) are removed without ending the sentence;
    a "#" heading and a line that is bold from end to end are paragraphs of their own; every
    paragraph but the last ends in a full stop if it had no punctuation. Paragraphs are separated
    by a blank line or a marker. A single newline is NOT a sentence end, so hard-wrapped text
    reads as before. One line of plain text comes back unchanged, so its cache key is unchanged.

    `stops="breaks"` is for BOOKS: only a paragraph that stands next to a marker (the scene heading
    under a "***", the last line of the scene above it) or is a heading gets the full stop. A book
    file made from a PDF has one paragraph per printed line, every one separated by a blank line
    once parsed, and "all" would end a sentence at each line end. Away from a scene break a book's
    prose is left exactly as it was read before.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\\(?=[^\w\s])", "", text)        # a markdown escape: "\*" is "*"
    paragraphs, lines = [], []                       # each paragraph: [text, is it beside a marker]
    after_marker = False                             # a marker stands before the paragraph in `lines`

    def close(marker: bool = False) -> None:
        nonlocal after_marker
        if lines:
            paragraphs.append([" ".join(lines), after_marker or marker])
            lines.clear()
            after_marker = marker
        elif marker:
            after_marker = True
            if paragraphs:                           # the marker follows it, across a blank line
                paragraphs[-1][1] = True

    for line in text.split("\n"):
        line = line.strip()
        mark = _HEADING_MARK.match(line)             # before the markers: "##" alone is one too
        if mark:
            line = line[mark.end():]
        heading = bool(mark) and mark.group(1).startswith("#")
        for n, piece in enumerate(_BREAK_MARK.sub("\n", line).split("\n")):
            piece = _STRAY_MARK.sub("", piece).strip()
            if n:                                    # a marker stood between the two pieces
                close(marker=True)
            if not _HAS_WORDS.search(piece):         # blank, or a line with nothing in it to say
                close(marker=bool(line))
            elif heading or _WHOLE_LINE_BOLD.match(piece):
                close()
                paragraphs.append([piece, True])     # a heading is a sentence in either mode
                after_marker = False
            else:
                lines.append(piece)
    close()
    return " ".join([_end_sentence(p) if (stops == "all" or beside) else p for p, beside in paragraphs[:-1]]
                    + [p for p, _ in paragraphs[-1:]])


def filter_actions(text: str, narrate_actions: bool = True, stops: str = "all") -> str:
    """Roleplay-style *action* markup (SillyTavern / Nomi transcripts, pasted chats).

    narrate_actions=True (the default): the action TEXT is spoken — only the literal
    asterisks are dropped, so markup never leaks into the audio.
    narrate_actions=False: *wrapped spans* are removed entirely — only the dialogue
    outside the asterisks is narrated. Unpaired asterisks are always dropped.

    Scene-break markers and other markup with no words in it come out first (see
    drop_unspeakable_markup). First, because a "***" line holds an odd number of asterisks: left
    in, it reverses every pair after it, and narrate_actions=False then drops the dialogue and
    speaks the actions. Returns "" when nothing with a letter or digit in it is left.

    Shared here (not in the playground) so the Nomi /speak and SillyTavern /v1
    endpoints can reuse the exact same behavior (3.0 wiring)."""
    text = drop_unspeakable_markup(text, stops)
    if narrate_actions:
        out = re.sub(r"\*+", "", text)
    else:
        out = re.sub(r"\*[^*]+\*", " ", text)      # drop each *action span*
        out = out.replace("*", "")                 # any stray unpaired asterisk
        out = re.sub(r"[ \t]{2,}", " ", out)
        out = re.sub(r" +([,.;:!?])", r"\1", out)  # no orphan space before punctuation
        out = out.strip()
    return out if _HAS_WORDS.search(out) else ""


def split_into_chunks(text: str, max_chars: int = CHUNK_SIZE) -> list:
    """
    Split text into Chatterbox-safe chunks.

    Priority order for split boundaries:
      1. Sentence endings  (.  !  ?)   — preferred; never split mid-sentence
      2. Clause boundaries (, ; )      — fallback when a sentence exceeds max_chars
      3. Word boundaries               — last resort for unusually long clauses

    Post-processing: if the final chunk is shorter than MIN_CHUNK_SIZE it is
    merged into the preceding chunk (a tiny orphan is worse than a slightly
    oversized chunk, which is still well within Chatterbox's 40-second hard cap).
    """
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        return []

    chunks: list[str] = []
    current = ""

    def add_piece(piece: str) -> None:
        """Append piece to current chunk, flushing first if it would overflow."""
        nonlocal current
        piece = piece.strip()
        if not piece:
            return
        if current and len(current) + 1 + len(piece) > max_chars:
            chunks.append(current)
            current = piece
        else:
            current = (current + " " + piece).strip() if current else piece

    sentences = re.split(r'(?<=[.!?])\s+', text)
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue

        if len(sentence) <= max_chars:
            add_piece(sentence)
        else:
            # Sentence too long — split on clause boundaries (comma / semicolon)
            clauses = re.split(r'(?<=[,;])\s+', sentence)
            for clause in clauses:
                clause = clause.strip()
                if not clause:
                    continue
                if len(clause) <= max_chars:
                    add_piece(clause)
                else:
                    # Clause still too long — fall back to words
                    for word in clause.split():
                        add_piece(word)

    if current:
        chunks.append(current)

    # Merge trailing orphan chunk into the previous one when it's tiny
    if len(chunks) >= 2 and len(chunks[-1]) < MIN_CHUNK_SIZE:
        combined = chunks[-2] + " " + chunks[-1]
        if len(combined) < max_chars * 1.5:   # stays well below 40-second hard cap
            chunks[-2] = combined.strip()
            chunks.pop()

    return chunks


def chunks_fingerprint(chunks: list) -> str:
    """One hash over a chunk list: the same list of texts, in the same order, and nothing else.

    A render banks each chunk's audio by its INDEX and a resumed render reuses whatever is banked.
    That is only right while chunk 7 is still the same words. When the text or the way it is cut
    changes (an edited book, a new text cleaner), the count often stays the same and the indexes
    silently mean different sentences. A render stores this next to its banked chunks and throws
    them away when it no longer matches."""
    h = hashlib.sha256()
    for chunk in chunks:
        h.update(chunk.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


# S3_TOKEN_RATE from chatterbox/models/s3tokenizer/s3tokenizer.py
_S3_TOKEN_RATE        = 25    # speech tokens per second of audio
_TOKEN_CAP            = 1000  # max_new_tokens hard cap in chatterbox/tts.py
_TRUNCATION_DURATION_S = _TOKEN_CAP / _S3_TOKEN_RATE  # 40.0 s — hard cap audio length


def vault_route(p):
    """The path router, reachable from the seams in this module. `(Vault, logical) | None`.

    DEFERRED, and it has to be: vault.py does `from tts_utils import atomic_replace`, so a
    module-level `import vault_store` here is a circular import. WorkerPool._worker_entry
    already defers exactly this, and says so.
    """
    from vault_store import route
    return route(p)


def wav_frames_sr(path):
    """(num_frames, sample_rate) from a WAV header via soundfile. Portable header
    read: torchaudio 2.11 on the ROCm stack has no working header reader at all —
    `torchaudio.info` doesn't exist there and `torchaudio.load` needs the absent
    torchcodec — so we must NOT read headers through torchaudio.

    Through the vault this stays O(1): open_read() hands back a SEEKABLE reader that decrypts
    only the blocks a read actually touches, so a header read of a 30 MB chapter WAV decrypts
    one 64 KiB block, not thirty megabytes."""
    import soundfile as sf
    r = vault_route(path)
    if r is not None:
        v, logical = r
        with v.open_read(logical) as fh:
            info = sf.info(fh)
        return info.frames, info.samplerate
    info = sf.info(str(path))
    return info.frames, info.samplerate


def is_truncated_wav(path) -> bool:
    try:
        frames, sr = wav_frames_sr(path)
        tokens = int(frames / sr * _S3_TOKEN_RATE)
        return tokens >= _TOKEN_CAP
    except Exception:
        return False


def is_valid_wav(path) -> bool:
    """True if the file's WAV header reads cleanly. A process killed mid-write
    leaves a truncated/unreadable chunk file; treating it as 'done' on resume would
    wedge the run forever (it exists, so it's never regenerated, and the final
    concat crashes on it every time)."""
    try:
        wav_frames_sr(path)
        return True
    except Exception:
        return False


def save_wav_sf(target, wav, sr):
    """Write a torch wav tensor to a WAV via soundfile.

    Replaces torchaudio.save: on the ROCm stack (torchaudio 2.11) save routes
    through torchcodec, which isn't installed and can't be without clobbering the
    ROCm torch — so every torchaudio.save raises "TorchCodec is required". soundfile
    works on both platforms, so this is the portable write path.

    target — a path/str OR a file-like buffer (e.g. io.BytesIO for HTTP streaming).
    wav    — (channels, frames) or (frames,) tensor. .float() guards against a
             bf16/fp16 tensor (autocast output), which numpy can't represent.
    """
    import soundfile as sf
    arr = wav.detach().float().cpu().numpy()
    if arr.ndim == 2:
        arr = arr.T                      # (channels, frames) -> (frames, channels)
    sf.write(target, arr, sr, format="WAV", subtype="PCM_16")


def part_path(dest: Path, suffix: str = ".part") -> Path:
    """A UNIQUE in-flight temp sibling for `dest` — `<dest>.<token><suffix>`.

    🔴 **The token is what makes concurrent writers safe, and it is not decoration.** Every
    atomic writer here stages through a temp sibling and then `atomic_replace`s it into place.
    With a FIXED `<dest>.part`, two threads writing the same destination share ONE temp file:
    they interleave into it, and the second `atomic_replace` then finds it already renamed away.
    The server is threaded, so this needs no bug and no attacker — only two requests at once.

    What it costs, by arm. Outside a vault it lands unparseable YAML/JSON, which the convenience
    stores swallow as "empty" — the user's data, silently gone. Inside a vault it lands a file
    that is a MIX OF TWO CIPHERTEXTS, and every later read raises `VaultAuthError`, which is a
    `BaseException` and deliberately uncaught — so the tab dies, and this project's own doctrine
    forbids repairing or deleting the file to get it back.

    `clip_favorites` holds a module lock for exactly this reason (see its header). A lock only
    works where one module owns the file; most of these writers are called from request threads
    that own nothing, so the fix belongs in the temp NAME, not in every caller.

    ⚠️ **The suffix stays LAST.** `vault.listdir` (`vault.py:858`) and `vault_migrate` (`:78`)
    both recognize a crash-orphaned temp by `endswith(PART_SUFFIX)`, and one that stopped being
    recognized would be DECRYPTED as though it were content — raising, and taking the whole
    directory with it. The token therefore goes BEFORE the suffix, never after. The repo's
    orphan-sweep tests glob `*.part`, which this still matches.
    ⚠️ 8 hex chars, kept short deliberately: `vault.MAX_ENC_NAME` budgets the 255-byte name limit
    down to 200 to leave room for the `.name` companion and this suffix.
    """
    return dest.parent / f"{dest.name}.{os.urandom(4).hex()}{suffix}"


def atomic_replace(tmp: Path, dest: Path, retries: int = 10, delay: float = 0.05) -> None:
    """tmp.replace(dest) with a short retry loop. On Windows os.replace raises
    PermissionError if another handle momentarily has dest open — e.g. a concurrent
    reader of the file a writer thread is replacing. Retry briefly rather than
    dropping the write. (The single shared copy of what used to live separately in
    book_state.py and voice_utils.py.)"""
    for i in range(retries):
        try:
            tmp.replace(dest)
            return
        except PermissionError:
            if i == retries - 1:
                raise
            time.sleep(delay)


def move_into_place(src: Path, dst: Path) -> None:
    """Move `src` to `dst`, atomically at the destination, ACROSS FILESYSTEMS IF NEED BE.

    `os.replace()` is atomic and cannot cross a filesystem boundary — it raises `EXDEV`
    (errno 18). Every place this app moves a finished artifact out of a job's workdir and
    into a library is therefore one mount point away from a hard failure **at the last step
    of a ten-minute job**, with the work done, the GPU spent, and the output about to be
    deleted by the workdir's `finally`.

    That was theoretical until 5.0 §8.2 put the scratch on its own boot-ephemeral dm-crypt
    volume, which is exactly the thing that makes the boundary real. So: try the rename, and
    on EXDEV fall back to copy → atomic-replace → unlink the source.

    The destination stays atomic in both paths, because the copy lands on a `.part` sibling
    ON THE DESTINATION FILESYSTEM and only then is renamed. That is what lets every reader
    treat "the file exists" as "the file is complete" — a half-copied MP3 appearing in the
    library under its real name would be indistinguishable from a finished one.

    (Encryption needs this shape anyway: a cross-mount move becomes read → write → unlink,
    which is precisely `vault.encrypt_from_scratch`.)"""
    src, dst = Path(src), Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    part = dst.with_suffix(dst.suffix + ".part")
    try:
        try:
            os.replace(src, part)
        except OSError as e:
            if e.errno != errno.EXDEV:
                raise
            shutil.copyfile(src, part)     # different filesystem — copy, then drop the source
            src.unlink(missing_ok=True)
        atomic_replace(part, dst)
    finally:
        part.unlink(missing_ok=True)       # a failed land must not leave a stray .part


def save_wav_atomic(path: Path, wav, sr: int) -> None:
    """Crash-safe WAV write: soundfile-write to '<stem>.part.wav' beside the
    destination, then atomically replace. The '.part.wav' suffix is a CONVENTION
    other code depends on (book_state._book_stems skips in-progress files by it;
    cache eviction must too) — every atomic WAV write should go through here so
    the temp-name contract lives in exactly one place.

    IN THE VAULT it goes through a BytesIO, and that is not laziness — libsndfile SEEKS BACK
    to patch the RIFF header's length field when it closes a WAV, and vault.open_write() is a
    streaming block writer that cannot seek. (save_wav_sf already takes a file-like, and two
    sites already hand it a BytesIO, so this is the shape the codebase had anyway.) Peak memory
    is unchanged: the caller already holds the whole tensor, and the book concat holds the
    whole chapter in RAM via torch.cat.

    The .part dance drops out because vault.open_write() does its own — it writes <dest>.part
    and atomically replaces on close. The atomicity contract is kept, by the vault."""
    path = Path(path)
    r = vault_route(path)
    if r is not None:
        v, logical = r
        buf = io.BytesIO()
        save_wav_sf(buf, wav, sr)
        v.write_bytes(logical, buf.getvalue())
        return
    tmp = path.parent / (path.stem + ".part.wav")
    save_wav_sf(str(tmp), wav, sr)
    atomic_replace(tmp, path)


class ChunkUnreadable(Exception):
    """The OS would not hand us a chunk WAV's bytes. NOT "the bytes are not a WAV" —
    that is a different answer, and it is the only one that licenses a delete.

    Raised, not returned, because `False` here does not mean "leave it alone": every
    caller answers False by RE-RENDERING the chunk, which overwrites the file. Returning
    False about a file we could not read destroys it just as surely as the unlink did,
    through a different door. The honest answer to "is this chunk good?" when the disk
    would not say is neither True nor False."""


# A WAV header is 44 bytes; libsndfile may walk a few chunks past it looking for `data`.
# 8 KiB covers every header this app writes and costs one page.
_HEADER_PROBE = 8192


def valid_or_remove(path) -> bool:
    """Resume check for an on-disk chunk WAV: True when it exists and its header reads
    cleanly. A file whose CONTENT is not a WAV (a process killed mid-write) is DELETED so
    it gets regenerated — otherwise it exists forever, is never re-rendered, and the final
    concat crashes on it every run (the corrupt-chunk wedge). That deletion is deliberate
    and it is kept.

    What is NOT kept is deleting a file we could not READ. Those are different events and
    this function used to conflate them, because `is_valid_wav` asks soundfile — and
    libsndfile reports an I/O failure and "these bytes are not a WAV" as the SAME
    exception (it maps a failed open() to SF_ERR_SYSTEM, not to a distinct type). So there
    is no way to ask it which happened. We take the OS read into our own hands instead: if
    WE can read the header bytes, then a soundfile failure afterward is a verdict about
    the CONTENT, and only then may we act on it.

    Absent is not corrupt: a missing chunk has nothing to destroy and is simply not banked.

    Six callers, every one of them looping over every chunk of a render — which is what
    makes the conflation catastrophic rather than annoying. A transient EIO, an ENOSPC, a
    Windows sharing violation from a UI poller — any of them used to take out the whole
    workspace in a single pass, behind a progress bar, logging one line per file.

    🔴 M6 — THE TWO READS MUST MOVE TOGETHER, AND THIS IS WHY.

    There are two of them: the raw byte probe below, and `is_valid_wav`. Route ONLY the probe
    and 8 KiB of CIPHERTEXT reads back perfectly happily — then libsndfile is handed the same
    encrypted file, says (correctly!) "these bytes are not a WAV", and the next line UNLINKS
    EVERY BANKED CHUNK OF THE RENDER. The function whose entire purpose is to stop deleting
    things we could not read becomes the thing that deletes them.

    `is_valid_wav` routes too (via wav_frames_sr), so both reads see plaintext. This is not a
    theory: injecting exactly that half-fix makes test_m6_e2e's resume test log "chunk_0001.wav
    is unreadable — regenerating it" for every chunk in the bank, and go red.

    A VaultAuthError from the probe is NOT an OSError and is deliberately not caught here: a
    wrong key must never be mistaken for a corrupt chunk. It goes to a boundary (M5)."""
    p = Path(path)
    r = vault_route(p)
    if r is not None:
        v, logical = r
        if not v.exists(logical):
            return False
        try:
            with v.open_read(logical) as fh:
                fh.read(_HEADER_PROBE)
        except OSError as e:
            raise ChunkUnreadable(f"{p.name}: {type(e).__name__}") from e
        if is_valid_wav(p):                    # routes as well — the PLAINTEXT header
            return True
        logger.warning(f"  ({p.name} is unreadable — regenerating it)")
        v.unlink(logical, missing_ok=True)
        return False

    if not p.exists():
        return False
    try:
        with open(p, "rb") as fh:
            fh.read(_HEADER_PROBE)
    except OSError as e:
        # We have proven NOTHING about this file's contents. Do not delete it, and do not
        # tell the caller it isn't banked — the caller's answer to that is to overwrite it.
        raise ChunkUnreadable(f"{p.name}: {type(e).__name__}") from e
    if is_valid_wav(p):
        return True
    logger.warning(f"  ({p.name} is unreadable — regenerating it)")
    p.unlink(missing_ok=True)
    return False


def source_stat(p) -> tuple:
    """(size, mtime) of a SOURCE file, or None if it cannot be read. **THE IDENTITY SEAM**
    (5.0 §7.7.2) — the single answer to "has this file changed?", shared by everything that
    caches an answer ABOUT a file: the enhanced-audio cache, the bandwidth measurement, the
    clip durations, and the song-hash index.

    The LOGICAL size and mtime — which today, with no vault, are the real ones. Under 5.0
    they are not: ciphertext is larger, and the migration pass rewrites every mtime. So
    **M6/M7 repoints THIS FUNCTION at the vault's logical stat** (M1 derives the plaintext
    length from the ciphertext length in O(1) — SPEC_5_0_M1 §9.1) and every cache in the app
    keeps hitting across the migration. One seam, one answer.

    It lives HERE, at the bottom of the import graph, rather than in enhance.py where M2.5b
    first built it: `stems` needs it and cannot import `enhance`
    (enhance → voiceswap → stems). `enhance.source_stat` re-exports it, unchanged.

    M6 REPOINTED IT, and that is the whole of the promise above: for a file in the vault the
    answer is now the vault's LOGICAL stat — the PLAINTEXT size, derived from the ciphertext
    size in O(1) (vault.plaintext_len), never the size on disk. Repointing this ONE function
    is what keeps the enhanced-audio cache, the bandwidth cache, the duration cache AND M4's
    song index all hitting across the migration, instead of every one of them missing at once
    and re-doing GPU-hours of work behind a progress bar.

    The mtime is deliberately the PHYSICAL one (vault.Vault.stat, and read its docstring
    before you "fix" it): clear_cache is implemented as nothing BUT an os.utime, and
    nomi_speak's cache key and voice_settings.yaml's reload-poll all need an mtime that
    actually moves when the file is rewritten.

    A path we do NOT own — /ai-output (gocryptfs's), the scratch, an un-migrated box — routes
    to None and is stat'd exactly as before."""
    r = vault_route(p)
    if r is not None:
        v, logical = r
        try:
            st = v.stat(logical)
        except OSError:                 # absent ≠ corrupt, exactly as below
            return None
        return int(st.size), int(st.mtime)
    try:
        st = Path(p).stat()
    except OSError:
        return None
    return int(st.st_size), int(st.st_mtime)


def ffprobe_duration(path) -> float | None:
    """Duration in seconds via ffprobe, or None when ffprobe ran but could not
    produce one (bad file, parse failure). Raises FileNotFoundError when ffprobe
    itself is not installed/on PATH — callers decide whether that is fatal, a
    log-once, or a 0.0. The single shared copy of the probe command.

    ⚠ There is a SECOND prober — `voiceswap.ffprobe_duration` — with a different contract
    (0.0 rather than None, rounded to 0.1 s). enhance/voicetrain/stemsplit all import THAT
    one. Unifying them would change `duration_s` in the training rows and in the book path
    at once, so M4 left it alone deliberately (SPEC_5_0_M4 §9.3). Know which one you have.

    🔴 ROUTED, because ffprobe IS A CHILD PROCESS and has no DEK. Handed a vault path it
    simply fails, and this function's contract turns that into `None` — indistinguishable
    from "bad file". `_enhance_book` summed exactly this over a book's chapters to get the
    hours of GPU it was about to quote, and got 0.0 for every one: the job reported
    `audio_s: 0.0` and told the user it was about to enhance "0.0h of audio".

    A WAV is answered from its HEADER (`wav_frames_sr`, itself routed) rather than by
    decrypting the file: that is O(1) — one 64 KiB block — where the scratch round-trip
    below would copy the whole thing. A ten-hour book's chapter WAVs are ~1.7 GB, and
    copying all of it to read three numbers is not a probe, it is a migration.
    """
    r = vault_route(path)
    if r is not None:
        if str(path).lower().endswith(".wav"):
            try:
                frames, sr = wav_frames_sr(path)
                return (frames / sr) if sr else None
            except (OSError, RuntimeError, ValueError):
                # NAMED (SPEC_5_0_M5 §2). soundfile raises LibsndfileError, which IS a
                # RuntimeError, for a truncated or non-WAV header; OSError covers the read.
                # That is precisely this function's documented "ffprobe ran but could not
                # produce one" case. VaultAuthError is a BaseException and still passes
                # straight through, which is the whole point of the rule.
                return None
        import scratch as scratch_mod
        import vault_fs
        with vault_fs.child_input(path, scratch_mod.scratch_root()) as plain:
            return ffprobe_duration(plain)                    # plaintext now — recurses ONCE
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if r.returncode == 0 and r.stdout.strip():
        try:
            return float(r.stdout.strip())
        except ValueError:
            return None
    return None


def load_wav(path):
    """Load a WAV as (tensor[channels, frames], sr), matching torchaudio.load's
    shape convention. Prefers torchaudio (unchanged behavior on CUDA); falls
    back to soundfile if it fails — torchaudio 2.11 on ROCm can route reads through
    the absent torchcodec too. Inert on platforms where torchaudio.load works.

    A vault path never reaches torchaudio at all: it takes a FILENAME, and the plaintext one
    is not on disk. soundfile takes the vault's file-like directly, and open_read() only
    decrypts the blocks the read touches. Routing FIRST also keeps the `except Exception`
    below from ever seeing a vault failure and quietly retrying it as a soundfile read — the
    exact conflation of "cannot read" with "not a WAV" that M2.5 spent a milestone undoing."""
    r = vault_route(path)
    if r is not None:
        import soundfile as sf
        import torch
        v, logical = r
        with v.open_read(logical) as fh:
            arr, sr = sf.read(fh, dtype="float32", always_2d=True)       # (frames, channels)
        return torch.from_numpy(arr.T.copy()), sr

    import torchaudio as ta
    try:
        return ta.load(str(path))
    except Exception:
        import soundfile as sf
        import torch
        arr, sr = sf.read(str(path), dtype="float32", always_2d=True)   # (frames, channels)
        return torch.from_numpy(arr.T.copy()), sr


def _make_emit(out):
    """One shared progress-line writer for generate_timed/generate_with_retry:
    write to the caller's buffer when given (pool/SSE capture), else loguru.
    depth=2 attributes the log line to the generate_* caller, matching the old
    inline closures."""
    def _emit(msg):
        if out is not None:
            out.write(msg + "\n")
        else:
            logger.opt(depth=2).info(msg)
    return _emit


_warned_no_bf16 = False


def _autocast_ctx():
    """Mixed-precision context for generation. CUDA defaults to bf16 and ROCm to fp16;
    `VOCALIS_DTYPE` may select bf16, fp16, or fp32. CPU and unsupported values use fp32.
    This is the single precision-selection boundary. Generation paths must enter it once;
    nested autocast contexts can produce activations and weights with incompatible dtypes.
    Unsupported bf16 devices fall back to fp32 with a one-time warning.
    """
    import contextlib
    import torch
    global _warned_no_bf16
    # An explicit VOCALIS_DTYPE always wins — it is the documented override and the
    # only way to ask for fp32. Unset, the default is per-vendor.
    dt = os.environ.get("VOCALIS_DTYPE", "").strip().lower()
    if not dt:
        dt = ("fp16" if (torch.version.hip
                         and os.environ.get("VOCALIS_TTS_FP16", "1") != "0")
              else "bf16")
    if torch.cuda.is_available():
        if dt in ("bf16", "bfloat16"):
            if torch.cuda.is_bf16_supported():
                return torch.autocast("cuda", dtype=torch.bfloat16)
            if not _warned_no_bf16:
                _warned_no_bf16 = True
                logger.warning("this GPU does not support bf16 — generation falls back to "
                               "fp32 (set VOCALIS_DTYPE=fp16 to try half precision instead)")
            return contextlib.nullcontext()
        if dt in ("fp16", "float16"):
            return torch.autocast("cuda", dtype=torch.float16)
    return contextlib.nullcontext()


def generate_timed(chunk: str, generate_fn, sr: int, label: str = "", out=None) -> tuple:
    """
    Call generate_fn(chunk), time it, print a quality stats line, and return
    (wav, chars_generated, seconds_elapsed).

    generate_fn  — zero-arg callable that returns the wav tensor, e.g.:
                   lambda: model.generate(chunk, audio_prompt_path=..., ...)
    sr           — model sample rate (model.sr), used to count speech tokens
    label        — text to print before generation (no newline); leave empty
                   to suppress the prefix entirely
    out          — optional stream to print to instead of stdout. The worker pool
                   passes a per-chunk buffer here so all of a chunk's output can be
                   flushed to the real console as one atomic, uninterleaved block.

    Quality zones (based on speech-token percentage of the 40-second hard cap):
      ✓  < 80 %  — well within quality range
      ⚠  80-90 % — approaching degradation zone
      ✗  > 90 %  — likely quality impact
    """
    _emit = _make_emit(out)

    if label:
        _emit(label)
    t0  = time.time()
    with _autocast_ctx():                 # bf16 autocast by default (VOCALIS_DTYPE)
        wav = generate_fn()
    dt  = time.time() - t0
    truncated = report_generated(chunk, wav, sr, dt, out=out)
    return wav, len(chunk), dt, truncated


def report_generated(chunk: str, wav, sr: int, dt: float, out=None) -> bool:
    """Print one finished chunk's stats line and say whether it hit the token cap.

    Split out of `generate_timed` for 6.2-m3: a BATCHED chunk arrives already rendered, so there
    is nothing to time around, but its quality zone and its truncation check must be identical —
    §7.3 says both stay PER CHUNK and never per batch. One copy, so they cannot drift.

    ⚠️ `dt` is a share of a batched pass on that path, not this chunk's own render time: several
    chunks of one forward pass land back to back, so the pass's wall time falls on the one that
    closed it and the rest read as instant. The aggregate over a submission is exact; the
    per-chunk `c/s` and `x` figures are lumpy by construction and are not evidence of anything.
    """
    _emit = _make_emit(out)
    tokens    = int(wav.shape[-1] / sr * _S3_TOKEN_RATE)
    truncated = tokens >= _TOKEN_CAP
    pct       = tokens / _TOKEN_CAP * 100
    quality   = "✓" if pct < 80 else ("⚠" if pct < 90 else "✗")
    cps       = len(chunk) / dt if dt > 0 else 0.0
    audio_s     = wav.shape[-1] / sr
    render_rate = audio_s / dt if dt > 0 else 0.0
    _emit(f"  [{dt:.1f}s  {cps:.0f} c/s  |  {tokens} tok  {pct:.0f}% {quality}  |  {render_rate:.1f}x ]")
    if truncated:
        _emit(f"  *** TRUNCATED: chunk hit the 1000-token hard cap — audio cuts off mid-speech ***")
        # The chunk's TEXT used to be dumped here (120 chars). Everything _emit()ed lands
        # in loguru — directly when out=None, and via the buffer replay in WorkerPool
        # otherwise — so this wrote the user's words to logs/vocalis.log on the normal
        # path. The char count is what actually diagnoses a truncation; the words never did.
        _emit(f"  *** Chunk was {len(chunk)} chars — re-split and retried ***")
    return truncated


def generate_with_retry(chunk: str, make_fn, sr: int, label: str = "", out=None) -> tuple:
    """
    Like generate_timed but re-splits and retries if the chunk is truncated.

    make_fn: callable(chunk_text) -> zero-arg generate callable
    out:     optional stream (see generate_timed) for atomic per-chunk output.
    Returns (wav, chars, total_dt, truncated)
    """
    wav, chars, dt, truncated = generate_timed(chunk, make_fn(chunk), sr, label=label, out=out)
    if not truncated:
        return wav, chars, dt, False
    return resplit_and_retry(chunk, make_fn, sr, spent_s=dt, out=out)


def resplit_and_retry(chunk: str, make_fn, sr: int, spent_s: float = 0.0, out=None) -> tuple:
    """The truncation half of `generate_with_retry`, for a chunk that has ALREADY been rendered
    once and came back at the token cap. Returns (wav, chars, total_dt, truncated).

    Split out for 6.2-m3 so the batched path retries exactly as the serial one does. §7.3:
    **the retry stays PER SEQUENCE** — one chunk of eight hitting the 40-second cap re-renders
    that chunk and never the batch, which is also why this runs after the batch's reply is fully
    consumed rather than inside it (a nested render on a satellite mid-reply deadlocks on its
    replica lock).

    `spent_s` is the time already spent on the attempt that truncated, so the caller's accounting
    still adds up to the wall time.
    """
    import torch
    _emit = _make_emit(out)

    sub_chunks = split_into_chunks(chunk, max_chars=len(chunk) // 2)
    if len(sub_chunks) < 2:
        # Indivisible — retry from scratch (TTS is non-deterministic; second attempt often succeeds)
        _emit(f"  Chunk cannot be split ({len(chunk)} chars) — retrying from scratch...")
        wav2, chars2, dt2, truncated2 = generate_timed(chunk, make_fn(chunk), sr, out=out)
        return wav2, chars2, spent_s + dt2, truncated2

    w = len(str(len(sub_chunks)))
    _emit(f"  Re-splitting into {len(sub_chunks)} sub-chunks and retrying...")
    wavs, total_chars, total_dt, any_truncated = [], 0, 0.0, False
    for i, sub in enumerate(sub_chunks):
        sub_label = f"    [retry {i+1:{w}}/{len(sub_chunks)}]  ({len(sub)} chars)"
        sub_wav, sub_chars, sub_dt, sub_trunc = generate_timed(sub, make_fn(sub), sr, label=sub_label, out=out)
        wavs.append(sub_wav)
        total_chars += sub_chars
        total_dt    += sub_dt
        any_truncated = any_truncated or sub_trunc

    return torch.cat(wavs, dim=-1), total_chars, total_dt, any_truncated


def _cancellable_tqdm(iterable=None, *args, **kwargs):
    """Drop-in for the tqdm used inside chatterbox's T3 token-sampling loops:
    yields from the real tqdm but raises GenerationCanceled the moment this
    worker's batch is canceled. This is what lets Cancel stop a chunk that is
    ALREADY generating (mid-loop) instead of only preventing new dispatch —
    the model itself has no abort hook, but its sampling loop iterates tqdm."""
    from tqdm import tqdm as _real_tqdm
    it = _real_tqdm(iterable, *args, **kwargs)
    ev = getattr(_GEN_CANCEL, "event", None)
    for x in it:
        if ev is not None and ev.is_set():
            it.close()
            raise GenerationCanceled()
        yield x


def _install_cancel_hook():
    """Swap the tqdm symbol for the cancellable wrapper in EVERY iterative stage of
    a chunk render: chatterbox's T3 module (token-sampling loop)
    AND the s3gen flow-matching vocoder loop. On ROCm a chunk spends a large share
    of its wall time in the vocoder, so hooking only the sampler made cancels look
    card-dependent — whichever worker happened to be vocoding ran to completion.
    Idempotent; installed at model load so importing tts_utils stays light."""
    import chatterbox.models.t3.t3 as t3mod
    import chatterbox.models.s3gen.flow_matching as fmmod
    for mod in (t3mod, fmmod):
        if not getattr(mod, "_vocalis_cancellable", False):
            mod.tqdm = _cancellable_tqdm
            mod._vocalis_cancellable = True


_CHATTERBOX_MODEL_MANIFEST_PATH = Path(
    "/usr/share/vocalis-g1/chatterbox-model-manifest.json"
)
_CHATTERBOX_MODEL_MANIFEST_SHA256 = (
    "978002e635d814936782a337da0e36577d01c036ea74964bfea532dff0c77a83"
)
_CHATTERBOX_MODEL_FILES = {
    "ve.safetensors",
    "t3_cfg.safetensors",
    "s3gen.safetensors",
    "conds.pt",
    "tokenizer.json",
}


def _verified_chatterbox_model_dir(model_dir) -> Path:
    """Verify the packaged Chatterbox manifest and every artifact before model loading."""
    model_dir = Path(model_dir)
    if not model_dir.is_absolute():
        raise VocalisError("VOCALIS_CHATTERBOX_MODEL_DIR must be an absolute path")

    try:
        manifest_bytes = _CHATTERBOX_MODEL_MANIFEST_PATH.read_bytes()
    except OSError as exc:
        raise VocalisError(
            f"The packaged Chatterbox model manifest is unavailable: {exc}"
        ) from exc
    if hashlib.sha256(manifest_bytes).hexdigest() != _CHATTERBOX_MODEL_MANIFEST_SHA256:
        raise VocalisError("The packaged Chatterbox model manifest failed its SHA-256 check")
    try:
        manifest = json.loads(manifest_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VocalisError("The packaged Chatterbox model manifest is invalid JSON") from exc

    if not isinstance(manifest, dict):
        raise VocalisError("The packaged Chatterbox model manifest must be a JSON object")
    revision = manifest.get("revision")
    if (
        type(manifest.get("schema_version")) is not int
        or manifest.get("schema_version") != 1
        or manifest.get("repository") != "ResembleAI/chatterbox"
        or not isinstance(revision, str)
        or re.fullmatch(r"[0-9a-f]{40}", revision) is None
        or model_dir.name != revision
    ):
        raise VocalisError("The configured Chatterbox directory does not match its frozen manifest")

    files = manifest.get("files")
    if not isinstance(files, list) or len(files) != len(_CHATTERBOX_MODEL_FILES):
        raise VocalisError("The frozen Chatterbox manifest has an unexpected artifact set")
    entries = {}
    for item in files:
        if not isinstance(item, dict):
            raise VocalisError("The frozen Chatterbox manifest has an invalid file entry")
        name = item.get("path")
        if not isinstance(name, str) or Path(name).name != name or name in entries:
            raise VocalisError("The frozen Chatterbox manifest has an invalid artifact path")
        entries[name] = item
    if set(entries) != _CHATTERBOX_MODEL_FILES:
        raise VocalisError("The frozen Chatterbox manifest has an unexpected artifact set")

    for name, item in entries.items():
        expected_size = item.get("bytes")
        expected_hash = item.get("sha256")
        if (
            type(expected_size) is not int
            or expected_size <= 0
            or not isinstance(expected_hash, str)
            or re.fullmatch(r"[0-9a-f]{64}", expected_hash) is None
        ):
            raise VocalisError(f"The frozen Chatterbox manifest has invalid metadata for {name}")

        artifact = model_dir / name
        if artifact.is_symlink() or not artifact.is_file():
            raise VocalisError(f"The frozen Chatterbox artifact is missing or not a regular file: {name}."
                               + SETUP_HINT)
        try:
            actual_size = artifact.stat().st_size
            digest = hashlib.sha256()
            with artifact.open("rb") as stream:
                for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                    digest.update(block)
        except OSError as exc:
            raise VocalisError(f"Unable to verify the frozen Chatterbox artifact {name}: {exc}") from exc
        if actual_size != expected_size or digest.hexdigest() != expected_hash:
            raise VocalisError(f"The frozen Chatterbox artifact failed integrity verification: {name}")

    return model_dir


def load_model(device: str):
    """Load and return the Chatterbox TTS model. (The turbo variant was removed
    app-wide in 3.x: one shared pool = ONE model class, streaming was built and
    ear-validated on the standard model, and per-entity turbo flags were dead
    controls that the streaming paths always ignored.)

    5.3: a device named `<satellite>:<device>` (e.g. `satellite01:cuda:0`) returns a REMOTE
    replica instead — an object exposing `.sr` and `.generate()`, which is all
    `WorkerPool` and `make_generate_fn` ever touch. The import is local so this module
    stays standalone for every caller that has no satellites configured.
    """
    if ":" in device and not device.startswith("cuda"):
        from satellite_client import remote_model
        return remote_model(device)
    model_dir = os.environ.get("VOCALIS_CHATTERBOX_MODEL_DIR")
    if model_dir:
        verified_model_dir = _verified_chatterbox_model_dir(model_dir)
    elif os.environ.get("VOCALIS_REQUIRE_VAULT") == "1":
        raise VocalisError(
            "The packaged runtime requires VOCALIS_CHATTERBOX_MODEL_DIR and its frozen manifest"
        )
    else:
        verified_model_dir = None
    _install_cancel_hook()                 # cancel can abort a chunk mid-generation
    from chatterbox.tts import ChatterboxTTS
    if verified_model_dir is not None:
        logger.info("Loading verified local Chatterbox model")
        return ChatterboxTTS.from_local(verified_model_dir, device=device)
    logger.info("Loading Chatterbox model…")
    return ChatterboxTTS.from_pretrained(device=device)


_VOICE_SCRATCH: dict = {}          # logical -> (scratch path, logical mtime)
_VOICE_SCRATCH_LOCK = threading.Lock()


def voice_for_model(voice):
    """Return a path Chatterbox can open for an audio prompt. Chatterbox opens
    `audio_prompt_path` inside third-party code, so encrypted voice samples are decrypted
    into the configured scratch area before use. The scratch filename is opaque. The
    decrypted path is memoized by the vault's logical modification time so replacing or
    clearing a voice invalidates the cache. Paths outside the vault pass through unchanged,
    and `None` remains the model-default voice.
    """
    if not voice:                       # None/"" — the model default. Nothing to decrypt.
        return voice
    r = vault_route(voice)
    if r is None:
        return voice
    v, logical = r

    import scratch as scratch_mod
    mtime = v.stat(logical).mtime
    with _VOICE_SCRATCH_LOCK:
        hit = _VOICE_SCRATCH.get(logical)
        if hit is not None and hit[1] == mtime and Path(hit[0]).exists():
            return str(hit[0])
        out = v.decrypt_to_scratch(logical, scratch_mod.scratch_root())
        _VOICE_SCRATCH[logical] = (out, mtime)
        return str(out)


def make_generate_fn(model, chunk: str, voice,
                     exaggeration: float = 0.5, cfg: float = 0.5,
                     temperature: float = 0.8):
    """Return a zero-arg callable that generates audio for the given chunk."""
    voice = voice_for_model(voice)      # chatterbox opens this path ITSELF — it must be plaintext
    # 🔴 NO autocast HERE, AND THAT IS LOAD-BEARING. Every caller of this callable already runs
    # inside `_autocast_ctx()` — `generate_timed` for the direct path, `WorkerPool._worker_entry`
    # for a pool worker's whole loop — so opening a region here NESTS one inside the other. When
    # 84e8b7c did exactly that to put ROCm on fp16, the outer bf16 region's activations met the
    # inner region's fp16 weights and every local ROCm render raised "Input type
    # (CUDABFloat16Type) and weight type (torch.cuda.HalfTensor) should be the same". The ROCm
    # fp16 default lives in `_autocast_ctx` now; read its docstring before changing precision.
    return lambda: model.generate(chunk, audio_prompt_path=voice,
                                  exaggeration=exaggeration,
                                  cfg_weight=cfg,
                                  temperature=temperature)


def wav_to_mp3(wav_path: Path, bitrate: str = "96k", audio: Path = None) -> Path:
    """Convert a WAV to a mono MP3 in an mp3/ subdirectory beside it.
    ATOMIC (encode to '<stem>.part.mp3', then rename): since 3.x the chapter MP3 is
    the book's ONLY persistent artifact and its existence marks the section done —
    a crash mid-encode must never leave a truncated file that reads as finished.
    (book_state._book_stems skips '.part.mp3' names by convention.)

    `bitrate` is 96k for plain Chatterbox and 256k when the audio has been through
    bandwidth extension — enhance.mp3_bitrate() owns that choice and explains it. It is
    passed in rather than imported, because enhance imports (transitively) this module.

    `audio` is the file actually encoded, when that is NOT `wav_path`: an enhanced chapter
    is a derivative in scratch, but its identity is still the chapter — so the MP3 must
    land under the CHAPTER's stem, not the derivative's. Naming and sourcing are separate
    questions and this is the one place they diverge.

    🔴 M6 — ffmpeg IN and ffmpeg OUT, and the OUT is the dangerous half.

    Both paths crossed the store. `-i` reads the chapter WAV out of `output/<book>/`, whose
    plaintext name does not exist once the vault is on — that failure is LOUD. The `.part.mp3`
    it wrote lands in `output/<book>/mp3/`, INSIDE the vault, in cleartext — and that failure is
    silent: the book renders, the chapter plays, the library lists, and the audiobook is on the
    platter in the clear. Same shape as playground_clips.encode_mp3, same fix.

    The `.part.mp3` naming convention outlives the change even though the temp has moved to the
    scratch — `book_state._book_stems` skips those names, and it is skipping them in the STORE,
    where a half-written MP3 would otherwise read as a finished chapter. `vault.open_write` and
    `move_into_place` each keep their own atomic landing, so `mp3_path` still only ever exists
    complete."""
    import scratch as scratch_mod
    import vault_fs

    mp3_dir = wav_path.parent / "mp3"
    mp3_path = mp3_dir / (wav_path.stem + ".mp3")
    root = scratch_mod.scratch_root()
    with vault_fs.child_input(audio or wav_path, root) as src, \
            scratch_mod.file(root, f"wav_to_mp3|{mp3_path}", ".mp3") as tmp_path:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", str(src),
             "-ac", "1", "-b:a", str(bitrate), "-f", "mp3", str(tmp_path),
             "-loglevel", "warning"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            # A non-zero exit means the MP3 is missing or a truncated partial — do NOT
            # hand back a path that looks valid. Raise so callers can react (they may
            # log-and-continue for a best-effort encode, but they get to decide).
            raise RuntimeError(f"ffmpeg failed to encode {mp3_path.name}: {result.stderr.strip()}")
        vault_fs.from_scratch(tmp_path, mp3_path)
    return mp3_path


#: Use 192 kb/s Opus for chapter audio: a stereo-capable lossy format that preserves quality without retaining WAV-sized files.
OPUS_BITRATE = "192k"


def wav_to_opus(wav_path: Path, bitrate: str = OPUS_BITRATE, audio: Path = None) -> Path:
    """`wav_to_mp3`'s contract, in Opus: encode to `mp3/<stem>.opus`, atomically.

    ⚠️ YES, `.opus` INSIDE A DIRECTORY CALLED `mp3/`. Renaming it would break every stored
    chapter URL, every existing book on disk, and the `mp3/` literal in a dozen readers, for a
    cosmetic gain. The directory means "the encoded artifact", and it has meant that since 3.x;
    the extension is what says the format. `book_state.chapter_encoded` is the resolver, and it
    reads both.

    Atomic for the same reason as its MP3 twin: the encoded chapter's EXISTENCE is what marks a
    section done and lets a resumed render skip it, so a truncated file left by a crash mid-encode
    would read as finished and silently ship a clipped chapter.

    Raises on a non-zero ffmpeg exit rather than returning a path that looks valid — the caller
    decides whether to log-and-continue (book_to_audio keeps the WAV as retry material) or fail.
    """
    import scratch as scratch_mod
    import vault_fs

    out_path = wav_path.parent / "mp3" / (wav_path.stem + ".opus")
    root = scratch_mod.scratch_root()
    with vault_fs.child_input(audio or wav_path, root) as src, \
            scratch_mod.file(root, f"wav_to_opus|{out_path}", ".opus") as tmp_path:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-vn",
             "-c:a", "libopus", "-b:a", str(bitrate), "-vbr", "on",
             "-application", "audio", str(tmp_path), "-loglevel", "warning"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg failed to encode {out_path.name}: {result.stderr.strip()}")
        vault_fs.from_scratch(tmp_path, out_path)
    return out_path


# ─────────────────────────────────────────────────────────────────────────────
#  Multi-GPU worker pool (2.0-M2)
#
#  Cross-vendor + multi-GPU: on ROCm, torch.cuda.* speaks to AMD via HIP, so this
#  code has no vendor branch — device selection is the only thing that varies.
#  A *worker* is one concurrent generator holding its own model *replica* pinned
#  to a device; the pool = all workers across the selected devices. Model A
#  (thread-per-worker + shared queue): PyTorch releases the GIL during GPU kernels,
#  so workers on distinct cards overlap. Chunks write to indexed files, so the
#  caller's existing concat stitches them in order — no in-memory reassembly.
# ─────────────────────────────────────────────────────────────────────────────

def parse_devices(gpus) -> list:
    """Turn a --gpus value into a list of device strings.

    'all' (or None) → every CUDA device, or ['cpu'] if none present.
    'cpu'           → ['cpu'].
    '0' / '0,1'     → ['cuda:0'] / ['cuda:0','cuda:1'] (validated against count).
    """
    import torch
    g = str(gpus or "all").strip().lower()
    if g == "cpu":
        return ["cpu"]
    n = torch.cuda.device_count()
    if g == "all":
        return [f"cuda:{i}" for i in range(n)] or ["cpu"]
    devs = []
    for tok in g.split(","):
        tok = tok.strip()
        if tok == "":
            continue
        try:
            i = int(tok)
        except ValueError:
            raise VocalisError(f"--gpus: '{tok}' is not a card index, 'all', or 'cpu'.")
        if i < 0 or i >= n:
            raise VocalisError(f"--gpus: card {i} requested but {n} CUDA device(s) present "
                             f"(valid indices 0..{n - 1}).")
        devs.append(f"cuda:{i}")
    # De-duplicate while preserving order: '--gpus 0,0' must not load a card twice
    # (the second pass would bypass the fit check and oversubscribe VRAM).
    seen = set()
    uniq = [d for d in devs if not (d in seen or seen.add(d))]
    return uniq or ["cpu"]


_SYSFS_DEV_CACHE: dict = {}   # (domain, bus) -> sysfs device dir (or None) — static per boot


def _amd_sysfs_vram_by_pci(domain: int, bus: int):
    """(used_bytes, total_bytes) from AMD's sysfs VRAM sensor for the card at PCI
    domain:bus, or (None, None). This is the whole-card VRAM the OS monitor reads;
    on ROCm torch.cuda.mem_get_info (hipMemGetInfo) drastically under-reports other
    processes' allocations (e.g. it reports ~3 GB used while an 80B LLM co-tenant
    actually holds ~29 GB). Linux/AMD only — a no-op elsewhere (glob finds nothing).

    The PCI->sysfs-dir mapping is resolved ONCE per card and cached: this runs at
    ~1 Hz per card from the UI's VRAM strip and each job's ticker, and re-globbing
    /sys/class/drm plus realpath-resolving every card on every read is pure waste
    (the mapping cannot change without a reboot). Only the two tiny value files
    are re-read per call."""
    import glob
    import os
    key = (domain, bus)
    if key not in _SYSFS_DEV_CACHE:
        # Resolve into a LOCAL and publish the key EXACTLY ONCE, fully-resolved. The old code
        # published `None` first and back-filled it after the glob — which, with gpu_stats()
        # called from several threads at once (the strip poll plus off-lock fit-checks), let a
        # second thread observe the key present-but-None mid-resolution and cache that transient
        # None permanently in _HWMON_CACHE. That poisoned the card's hwmon readings (temp/power/
        # clocks) for the whole process while util% and VRAM — which re-read this cache every
        # call — silently recovered. Assign-once means a racing thread sees the key ABSENT and
        # does its own (idempotent) glob instead of ever seeing a spurious None.
        resolved = None
        want = f"{domain:04x}:{bus:02x}"          # e.g. "0000:03"
        for used_f in glob.glob("/sys/class/drm/card*/device/mem_info_vram_used"):
            dev = os.path.dirname(used_f)
            addr = os.path.basename(os.path.realpath(dev))   # e.g. "0000:03:00.0"
            parts = addr.split(":")
            if len(parts) >= 2 and f"{parts[0]}:{parts[1]}" == want:
                resolved = dev
                break
        _SYSFS_DEV_CACHE[key] = resolved
    dev = _SYSFS_DEV_CACHE[key]
    if dev is None:
        return None, None
    try:
        used  = int(open(os.path.join(dev, "mem_info_vram_used")).read().strip())
        total = int(open(os.path.join(dev, "mem_info_vram_total")).read().strip())
        return used, total
    except Exception:
        return None, None


_PDEV_CACHE: dict = {}        # cuda index -> "0000:03:00.0" — static per boot


def pci_addr_for_device(device):
    """The fully-qualified PCI address ("0000:03:00.0") for a cuda device index, or
    None off AMD/Linux. This is the form amdgpu's fdinfo `drm-pdev` key uses, and it
    is one realpath away from the sysfs device dir the VRAM sensor already caches —
    so reuse that mapping rather than adding a second resolver.

    Only the POSITIVE answer is cached. An unresolved sysfs dir costs one dict lookup
    per sample to retry, and caching the None instead is exactly the bug _hwmon_dir
    below documents: a card that is merely unresolved this instant gets frozen at None
    for the life of the process.

    Narrowed rather than blind, unlike the three sensors below it that do the same job:
    a bad device string is a ValueError, and an index this box does not enumerate is
    whichever of RuntimeError/AssertionError the installed torch favors. Nothing else
    in here can raise — glob does not, and both path calls take strings we produced."""
    import os
    import torch
    try:
        idx = int(str(device).split(":")[1]) if ":" in str(device) else int(device)
        if idx in _PDEV_CACHE:
            return _PDEV_CACHE[idx]
        p = torch.cuda.get_device_properties(idx)
        bus = getattr(p, "pci_bus_id", None)
        if bus is None:
            return None
        dom = getattr(p, "pci_domain_id", 0) or 0
        _amd_sysfs_vram_by_pci(dom, bus)           # resolves + caches the sysfs dir
        dev = _SYSFS_DEV_CACHE.get((dom, bus))
        if not dev:
            return None
        _PDEV_CACHE[idx] = os.path.basename(os.path.realpath(dev))
        return _PDEV_CACHE[idx]
    except (ValueError, RuntimeError, AssertionError):
        return None


def _fdinfo_vram_bytes(body: str, addr: str):
    """VRAM bytes this fd holds on the card at PCI `addr`, from one /proc/*/fdinfo
    body — or None if the fd belongs to another card, or the kernel emits neither key.

    Split out from proc_vram_bytes so the parse is testable without a live amdgpu:
    the None-on-no-key path is the Windows/CUDA fallback and it is the one that would
    otherwise regress silently."""
    if f"drm-pdev:\t{addr}" not in body and addr not in body:
        return None
    for line in body.splitlines():
        # amdgpu prints "drm-memory-vram:\t5645632 KiB". Take the FIRST of the two keys
        # the file offers: drm-memory-vram is emitted first and is the one every amdgpu
        # has; drm-resident-vram is the fallback for kernels that dropped it. They agree.
        if line.startswith(("drm-memory-vram:", "drm-resident-vram:")):
            parts = line.split()
            return int(parts[1]) * 1024 if len(parts) >= 3 and parts[2] == "KiB" else None
    return None


def _children_of(pid: str) -> list:
    """Direct children of `pid` as pid strings, from /proc/<pid>/task/<tid>/children —
    empty off Linux, or on a kernel built without CONFIG_PROC_CHILDREN. One glob over
    our own threads, not a scan of /proc; see vocalis_pids for why that matters."""
    import glob
    out = []
    for f in glob.glob(f"/proc/{pid}/task/*/children"):
        try:
            with open(f) as fh:
                out.extend(fh.read().split())
        except OSError:                # the only thing reading /proc can raise: the thread
            continue                   # exited between the glob and the open
    return out


def _render_fdinfo(pid: str) -> list:
    """The /proc/<pid>/fdinfo body of every open DRM render node, as strings.

    Filter by the render-node symlink FIRST. A blind scan of every fdinfo in a server
    process is waste — the realpath check drops 27 fds to the two or three that matter —
    and fd counts grow with load on what is a per-sample path.

    Every failure is skipped rather than raised: a VoxCPM2 worker reaped mid-scan takes
    its /proc entry with it, and that must cost one fd, never the whole card's reading."""
    import glob
    import os
    out = []
    for link in glob.glob(f"/proc/{pid}/fd/*"):
        try:
            if "/dev/dri/render" not in os.path.realpath(link):
                continue
            with open(f"/proc/{pid}/fdinfo/{os.path.basename(link)}") as fh:
                out.append(fh.read())
        except OSError:                # an fd closed, or the whole process gone, since the
            continue                   # glob — realpath and basename cannot raise here
    return out


def _cgroup_of(pid: str):
    """/proc/<pid>/cgroup verbatim, or None where it can't be read.

    Compared as an OPAQUE STRING — the only question ever asked of it is whether two
    processes are in the same cgroup, so cgroup v1 vs v2, the mount layout and the unit
    naming never come into it."""
    try:
        with open(f"/proc/{pid}/cgroup") as fh:
            return fh.read()
    except OSError:                    # not Linux, or the process is already gone
        return None


def vocalis_pids(root: str = "self") -> list:
    """Return Vocalis process IDs: the current process and descendants in its cgroup. This
    includes resident model workers and child renderers that terminate with the service. Use
    both cgroup membership and process ancestry: cgroup membership alone can include
    unrelated processes in a developer session, while ancestry alone can include training
    jobs intentionally launched in a sibling scope. Read `/proc/<pid>/task/<tid>/children`
    to avoid scanning every process; if unavailable, return the root process only.
    """
    ours = _cgroup_of(root)
    out, seen, stack = [], set(), [root]
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        if pid != root and ours is not None and _cgroup_of(pid) != ours:
            continue          # outlives our restart — not ours, and nor is anything under it
        out.append(pid)
        stack.extend(_children_of(pid))
    return out


def proc_vram_bytes(device):
    """Return this process's and its workers' VRAM use on one AMD/Linux device, or `None` on
    unsupported platforms. DRM accounting includes the HIP context, library allocations, and
    memory outside PyTorch's allocator. Match open render-node file descriptors by PCI
    address because each worker's `HIP_VISIBLE_DEVICES` remaps device indices. Sum matching
    descriptors across the process tree.
    """
    addr = pci_addr_for_device(device)
    if not addr:
        return None
    total, found = 0, False
    for pid in vocalis_pids():
        for body in _render_fdinfo(pid):
            n = _fdinfo_vram_bytes(body, addr)
            if n is not None:
                total, found = total + n, True
    return total if found else None


#: A sensor or memory read this soon after a full NVML pass shares it: `gpu_stats` reads a card's
#: clocks (the full pass) and then its other sensors and memory within milliseconds, so a card
#: costs one pass per poll. The UI polls every 250 ms, so a next poll never reuses this one's pass,
#: and the satellite's half-second decode check and the fit-checks get a read taken for them.
_NVML_SENSOR_AGE_S = 0.1
_NVML_MEMORY_REUSE_S = 0.1
_NVML_CALL_WARNED = False     # the readout module raised once already; do not repeat it per call


def _nvidia_card(device, max_age_s: float = 0.0, memory_only: bool = False):
    """The NVIDIA driver's whole-card fields for a cuda device (October 10, 2026), or None.

    The NVML work itself (one initialization, the UUID match between PyTorch's card and NVML's,
    per-field tolerance, the once-a-minute retry of a failed start) lives in the satellite's
    readout module, `vocalis_satellite_gpustats.whole_card`, and is not written twice. The main
    server already has the satellite folder on sys.path (see vocalis_server.py); a process that
    cannot import the module (a command-line tool, a test) falls through silently and the
    callers use the next source in their order. NVML is consulted only when PyTorch is a CUDA
    build, a rule the readout module owns, so the AMD images never reach it.

    `max_age_s` > 0 accepts a read at most that old, so the sensors `gpu_stats` asks for right
    after the memory read do not each cost a fresh NVML pass."""
    global _NVML_CALL_WARNED
    try:
        import vocalis_satellite_gpustats as readout
    except ImportError:
        return None
    try:
        idx = int(str(device).split(":")[1]) if ":" in str(device) else int(device)
        return readout.whole_card(idx, max_age_s=max_age_s, memory_only=memory_only)
    except Exception as exc:
        # The readout module's own failures are handled (and logged once) inside it; this is
        # for anything it did not anticipate. The memory and sensors then use their other
        # sources, which is exactly the pre-NVML behavior.
        if not _NVML_CALL_WARNED:
            _NVML_CALL_WARNED = True
            logger.warning(f"NVML whole-card read failed ({type(exc).__name__}: {exc}) -- using "
                           f"PyTorch's memory number and no NVIDIA sensors for now; this line "
                           f"is logged once")
        return None


def _nvidia_sensor(device, field: str):
    """One sensor field of `_nvidia_card`, or None (no NVML, or the driver omits that field)."""
    card = _nvidia_card(device, max_age_s=_NVML_SENSOR_AGE_S)
    return None if card is None else card.get(field)


def gpu_util_percent(device):
    """Whole-card compute utilization % (0-100) from AMD's sysfs gpu_busy_percent,
    or, where that sensor doesn't exist, the NVIDIA driver's busy figure (NVML); None where
    neither exists (callers omit the bar). Reuses the VRAM sensor's cached PCI->sysfs
    mapping: one tiny file read."""
    import os
    import torch
    try:
        idx = int(str(device).split(":")[1]) if ":" in str(device) else int(device)
        p = torch.cuda.get_device_properties(idx)
        bus = getattr(p, "pci_bus_id", None)
        if bus is None:
            return _nvidia_sensor(device, "util_pct")
        dom = getattr(p, "pci_domain_id", 0) or 0
        _amd_sysfs_vram_by_pci(dom, bus)           # resolves + caches the sysfs dir
        dev = _SYSFS_DEV_CACHE.get((dom, bus))
        if not dev:
            return _nvidia_sensor(device, "util_pct")
        pct = int(open(os.path.join(dev, "gpu_busy_percent")).read().strip())
        return max(0, min(100, pct))
    except Exception:
        return _nvidia_sensor(device, "util_pct")


_HWMON_CACHE: dict = {}       # (domain, bus) -> hwmon dir (or None) — static per boot


def _hwmon_dir(device):
    """The card's sysfs hwmon directory, or None (non-AMD / non-Linux, e.g. the
    Windows dev box — callers omit the reading rather than show a blank).

    Resolved once per card and cached, like the PCI->sysfs map it rides on: the UI
    strip polls this at ~1 Hz per card, and re-globbing on every read is pure waste
    (it cannot change without a reboot). Only the tiny value files are re-read."""
    import glob
    import os
    import torch
    try:
        idx = int(str(device).split(":")[1]) if ":" in str(device) else int(device)
        p = torch.cuda.get_device_properties(idx)
        bus = getattr(p, "pci_bus_id", None)
        if bus is None:
            return None
        dom = getattr(p, "pci_domain_id", 0) or 0
        key = (dom, bus)
        if key not in _HWMON_CACHE:
            _amd_sysfs_vram_by_pci(dom, bus)       # resolves + caches the sysfs dir
            dev = _SYSFS_DEV_CACHE.get(key)
            if not dev:
                # The sysfs dir isn't resolved YET — do NOT cache a negative, or we freeze this
                # card's temp/power/clocks at None for the whole process. Leave the key absent
                # and retry next sample; the sysfs cache repairs within a tick. (This is the
                # other half of the concurrency fix in _amd_sysfs_vram_by_pci above.)
                return None
            # dev IS resolved: cache the answer once. A genuine None here (card has no hwmon)
            # is legitimate and permanent — that card simply exposes no sensors.
            found = sorted(glob.glob(os.path.join(dev, "hwmon", "hwmon*")))
            _HWMON_CACHE[key] = found[0] if found else None
        return _HWMON_CACHE.get(key)
    except Exception:
        return None


def _hwmon_int(device, *names):
    """First readable hwmon value among `names`, or None. Several names because the
    kernel isn't consistent about them across AMD parts: the R9700s report power as
    `power1_average`, while the box's integrated GPU only has `power1_input`."""
    import os
    h = _hwmon_dir(device)
    if not h:
        return None
    for n in names:
        try:
            return int(open(os.path.join(h, n)).read().strip())
        except Exception:
            continue
    return None


def gpu_temp_c(device):
    """Whole-card temperature in °C (hwmon `temp1_input` — the edge sensor, in
    millidegrees), or, where that sensor doesn't exist, the NVIDIA driver's (NVML) figure;
    None where neither exists."""
    v = _hwmon_int(device, "temp1_input")
    return _nvidia_sensor(device, "temp_c") if v is None else round(v / 1000)


def gpu_power_w(device):
    """Whole-card power draw in watts (hwmon reports microwatts), or, where that sensor doesn't
    exist, the NVIDIA driver's (NVML) figure; None where neither exists.

    `power1_average` is the R9700's rolling average — the number the OS monitor
    shows. `power1_input` is the instantaneous fallback some parts expose instead."""
    v = _hwmon_int(device, "power1_average", "power1_input")
    return _nvidia_sensor(device, "power_w") if v is None else round(v / 1e6)


def gpu_clocks_mhz(device) -> tuple:
    """(core_mhz, vram_mhz) from hwmon `freq1_input` (sclk) and `freq2_input` (mclk),
    which report Hz. Either may be None where neither the sensor nor, on an NVIDIA card,
    the driver (NVML) has it; each is resolved on its own.

    An idle AMD card reports sclk **0** — it isn't a missing reading, it's clock
    gating: the core is parked until there's work. So 0 is shown as 0, not hidden."""
    s = _hwmon_int(device, "freq1_input")
    m = _hwmon_int(device, "freq2_input")
    return (_nvidia_sensor(device, "sclk_mhz") if s is None else round(s / 1e6),
            _nvidia_sensor(device, "mclk_mhz") if m is None else round(m / 1e6))


def gpu_fan_pct(device):
    """Return commanded fan duty cycle as a percentage (`pwm1 / pwm1_max`), or, where the hwmon
    values are unavailable or the maximum is zero, the NVIDIA driver's (NVML) fan speed; `None`
    where neither exists. This is a duty target, not measured RPM; using the target keeps AMD
    and NVIDIA values comparable.
    """
    pwm = _hwmon_int(device, "pwm1")
    pwm_max = _hwmon_int(device, "pwm1_max")
    if pwm is None or not pwm_max:
        return _nvidia_sensor(device, "fan_pct")
    return max(0, min(100, round(100 * pwm / pwm_max)))


# ── CPU stats (the strip's second line) ──────────────────────────────────────
# Linux reads sysfs/procfs directly, below. Windows (11.1.5 — the `_win_*` family further down,
# right before `cpu_stats()`) reads the same-shaped fields off the Win32 API via `ctypes` —
# stdlib only, no psutil, no new dependency. Every field still degrades to None where ITS OWN
# platform has nothing to read (RAPL power and temperature, ZFS ARC, PSI, load average, and swap
# in the Linux sense all have no Windows equivalent — see `_win_cpu_stats` for the one-line
# reason beside each). What is superseded is only the OLD Windows behavior: the whole row used
# to be omitted rather than shown blank, because every field came back None. It no longer does.

#: "stat" -> the last (idle, total) from /proc/stat; "win_times" -> the last (idle, kernel, user)
#: FILETIME tick counts from Windows' GetSystemTimes (see `_win_cpu_percent` — kept in its own
#: key so it can never collide with "stat"); one further key per RAPL domain PATH, each holding
#: that domain's own last (µJ, monotonic). See `_cpu_power_w` for why a single shared RAPL slot
#: was a bug and not a simplification.
_CPU_PREV: dict = {}
_CPU_PATHS: dict = {}         # sysfs paths, resolved once — they can't change without a reboot


def _cpu_percent() -> float:
    """top-style CPU load: 100% = ONE logical core fully busy, so a 32-thread box
    saturates at 3200%. Computed as the delta since the previous call, which is what
    makes it a rate rather than a since-boot average — the strip polls at 1 Hz, so
    each reading covers the last second."""
    try:
        with open("/proc/stat") as f:
            parts = f.readline().split()
    except OSError:
        return None
    if not parts or parts[0] != "cpu":
        return None
    vals = [int(v) for v in parts[1:]]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)        # idle + iowait
    total = sum(vals)
    prev = _CPU_PREV.get("stat")
    _CPU_PREV["stat"] = (idle, total)
    if not prev:
        return None                                           # first call: no delta yet
    d_idle, d_total = idle - prev[0], total - prev[1]
    if d_total <= 0:
        return None
    busy = 1.0 - (d_idle / d_total)
    return round(max(0.0, busy) * (os.cpu_count() or 1) * 100)


def _cpu_mhz():
    """Average current core clock. Averaged, not maxed: one core boosting to 5.7 GHz
    while 31 idle at 400 MHz is not '5700 MHz of CPU'.

    The file LIST is globbed once and cached — same reasoning as the GPU sysfs maps above:
    the strip reads this 4x/s, and re-walking 32 cpufreq directories every time to learn
    what it already knows was two thirds of the whole sample's cost. Only the values are
    re-read. (A CPU going offline just makes its read fail and drop out of the average.)"""
    import glob
    if "cpufreq" not in _CPU_PATHS:
        _CPU_PATHS["cpufreq"] = sorted(
            glob.glob("/sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq"))
    vals = []
    for f in _CPU_PATHS["cpufreq"]:
        try:
            vals.append(int(open(f).read().strip()))          # kHz
        except (OSError, ValueError):
            continue
    return round(sum(vals) / len(vals) / 1000) if vals else None


def _cpu_temp_c():
    """CPU package temperature — k10temp's Tctl on AMD, coretemp's Package on Intel.

    The hwmon directory is resolved once and cached (it can't change without a reboot);
    only `temp1_input` is re-read per sample."""
    import glob
    if "hwmon" not in _CPU_PATHS:
        # Assign-once, same rationale as _amd_sysfs_vram_by_pci: don't publish a None placeholder
        # a concurrent sampler could read mid-resolution. Only one cache reads this, so the worst
        # case here was a one-sample blank rather than a permanent poison — cleaned for consistency.
        resolved = None
        for h in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
            try:
                name = open(os.path.join(h, "name")).read().strip()
            except OSError:
                continue
            if name in ("k10temp", "coretemp", "zenpower"):
                resolved = h
                break
        _CPU_PATHS["hwmon"] = resolved
    h = _CPU_PATHS["hwmon"]
    if not h:
        return None
    try:
        return round(int(open(os.path.join(h, "temp1_input")).read().strip()) / 1000)
    except (OSError, ValueError):
        return None


def _cpu_power_w(state=None):
    """Return package power from RAPL, or `None` when no readable counter is available. RAPL
    reports cumulative microjoules, so power is computed from successive samples. `state`
    keeps the previous reading per sampler; the strip and background header sampler must not
    share a delta interval. Key prior readings by RAPL domain so a transient read failure
    cannot pair a package counter with a core counter. Wrapped or invalid deltas are
    rejected. The counter may require an operator-installed udev rule. Do not change that
    permission policy in application code.
    """
    import glob
    state = _CPU_PREV if state is None else state
    for d in sorted(glob.glob("/sys/class/powercap/*rapl*:[0-9]")):
        try:
            uj = int(open(os.path.join(d, "energy_uj")).read().strip())
        except (OSError, ValueError, PermissionError):
            continue
        now = time.monotonic()
        prev = state.get(d)                                   # this DOMAIN's previous read
        state[d] = (uj, now)
        if not prev or now <= prev[1]:
            return None
        d_uj, d_t = uj - prev[0], now - prev[1]
        if d_uj < 0 or d_t <= 0:                              # counter wrapped
            return None
        return round(d_uj / 1e6 / d_t)                        # µJ → J → W
    return None


def _meminfo():
    """/proc/meminfo as {name: kB}, or None off Linux.

    One read serves both RAM and swap. `_cpu_mem` and `_swap_gb` are called from the same
    `cpu_stats()` on the same sample, and opening the same pseudo-file twice 4x/s to answer
    two questions from the same six lines is the kind of waste that never shows up in a
    profile and never stops costing."""
    try:
        with open("/proc/meminfo") as f:
            info = {}
            for line in f:
                k, _, v = line.partition(":")
                info[k] = int(v.split()[0])                   # kB
    except (OSError, ValueError, IndexError):
        return None
    return info


def _cpu_mem(info=None):
    """System RAM as (used_gb, total_gb), or None where there is no /proc/meminfo.

    used = MemTotal - MemAvailable, NOT total-free. The page cache is not "used" memory:
    Linux fills every spare page with cache and hands it straight back under pressure, so
    total-free reads ~95% full on an idle box that is in fact almost empty. MemAvailable is
    the kernel's own estimate of what a new allocation could take without swapping — the
    same number `free` prints under `available`, and the only one that means what the bar
    is claiming to mean.

    Not cached: unlike the clock and hwmon paths, this is one open() of one file, and the
    values are the whole point. `info` is that read, passed in when the caller has already
    done it; the no-argument call still works and still reads for itself."""
    info = _meminfo() if info is None else info
    if info is None:
        return None
    total, avail = info.get("MemTotal"), info.get("MemAvailable")
    if not total or avail is None:
        return None
    used = max(0, total - avail)
    return round(used / 1048576, 1), round(total / 1048576, 1)   # kB → GiB


#: ZFS's own kernel memory, which `MemAvailable` does not know about.
_ARCSTATS = "/proc/spl/kstat/zfs/arcstats"


def _arc_reclaimable_gb():
    """Return reclaimable ZFS ARC in GiB, or `None` when ZFS is unavailable. Use `size -
    c_min`, because the ARC minimum is not reclaimable. Page cache is already excluded from
    `_cpu_mem`'s used-memory value, so this result only partitions the existing memory
    display.
    """
    try:
        with open(_ARCSTATS) as f:
            vals = {}
            for line in f:
                parts = line.split()
                if len(parts) >= 3:
                    vals[parts[0]] = parts[2]          # name · type · DATA
        size, c_min = int(vals["size"]), int(vals["c_min"])
    except (OSError, ValueError, KeyError, IndexError):
        return None                                    # not a ZFS box — no second segment
    return round(max(0, size - c_min) / 1073741824, 1)  # bytes → GiB


def _swap_gb(info=None):
    """Swap as (used_gb, total_gb), or None where there is no swap configured at all.

    THE CONSEQUENCE OF PRESSURE, WHICH IS WHY IT IS WORTH A LINE OF ITS OWN. `_cpu_mem`
    answers "how full is RAM"; this answers "did the kernel already have to give up and
    write pages to disk". The two are not the same question and the first cannot imply the
    second: a box can sit at 60% RAM having pushed 9 GB out to swap hours ago, and it will
    read as comfortable while every one of those pages costs a disk seek to touch again.

    Unlike PSI this figure PERSISTS — it is still on screen long after the squeeze that
    caused it has passed, which is the whole point of pairing it with a live metric.

    `SwapTotal == 0` returns None, not (0, 0): a box with swap off has nothing to report
    here, and a bar reading "0.0 / 0.0 GB" would be noise on every such box forever."""
    info = _meminfo() if info is None else info
    if info is None:
        return None
    total, free = info.get("SwapTotal"), info.get("SwapFree")
    if not total or free is None:
        return None
    used = max(0, total - free)
    return round(used / 1048576, 1), round(total / 1048576, 1)   # kB → GiB


#: The kernel's own memory-pressure metric. CONFIG_PSI, so absent on some kernels.
_PSI_MEM = "/proc/pressure/memory"


def _mem_psi():
    """Return Linux memory-pressure data as `{avg10, avg60, avg300, total_s}`, or `None` when
    PSI is unavailable. The `some` averages represent time when at least one task was
    stalled. The monotonic `total` counter preserves cumulative stall time alongside the
    decaying averages.
    """
    try:
        with open(_PSI_MEM) as f:
            for line in f:
                if not line.startswith("some "):
                    continue
                vals = {}
                for tok in line.split()[1:]:
                    k, _, v = tok.partition("=")
                    vals[k] = float(v)
                return {"avg10": round(vals["avg10"], 2),
                        "avg60": round(vals["avg60"], 2),
                        "avg300": round(vals["avg300"], 2),
                        # µs since boot → seconds. Monotonic: it never decays, unlike the averages.
                        "total_s": int(vals["total"] / 1e6)}
    except (OSError, ValueError, KeyError, IndexError):
        return None
    return None


def _uptime_s():
    """Return seconds since boot on Linux, or `None` elsewhere. Display this beside the
    cumulative PSI stall time to provide its operating interval.
    """
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def _loadavg():
    """The 1/5/15-minute run-queue averages as a list, or None off Linux.

    ⚠️ NOT the same quantity as `pct` on the CPU row, which is the strip's own top-style
    utilization. Load average counts tasks WAITING as well as running, so it goes above the
    core count on a box that is contended rather than merely busy — which is exactly the case
    the CPU percentage cannot show, and why both are on screen."""
    try:
        with open("/proc/loadavg") as f:
            p = f.read().split()
        return [float(p[0]), float(p[1]), float(p[2])]
    except (OSError, ValueError, IndexError):
        return None


# ── CPU stats — Windows ───────────────────────────────────────────────────────
# 11.1.5: the box this was developed on IS a Windows dev box, and the whole CPU row — plus the
# uptime/RAM header lines that ride the same sample — used to go blank on it. ctypes only, no
# psutil (a dependency decision, not an oversight: the four calls below are all stdlib can reach
# and the whole point was not adding a package to read four numbers). `ctypes.windll` is a
# Windows-only attribute of the `ctypes` module — referencing it while running on Linux raises
# AttributeError — so nothing below module scope touches it until a `_win_*` function actually
# runs, and `cpu_stats()` only calls into this family when `os.name == "nt"`. The structures
# themselves (just ctypes primitives, no windll) are safe to define at import time on any OS.


class _FILETIME(ctypes.Structure):
    """A Win32 FILETIME — here it's not a timestamp but an accumulated DURATION in 100 ns
    ticks, which is what GetSystemTimes fills it with."""
    _fields_ = [("dwLowDateTime", ctypes.c_ulong), ("dwHighDateTime", ctypes.c_ulong)]


class _MEMORYSTATUSEX(ctypes.Structure):
    """The subset of MEMORYSTATUSEX this file reads is `ullTotalPhys`/`ullAvailPhys`, but the
    struct is defined in full because GlobalMemoryStatusEx validates `dwLength` against the
    real struct size and refuses a short one."""
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


class _PROCESSOR_POWER_INFORMATION(ctypes.Structure):
    """One logical processor's entry from CallNtPowerInformation(ProcessorInformation) —
    `CurrentMhz` is the field this file wants, the Windows analogue of a `scaling_cur_freq`
    file, one array instead of one file per core."""
    _fields_ = [("Number", ctypes.c_ulong), ("MaxMhz", ctypes.c_ulong),
                ("CurrentMhz", ctypes.c_ulong), ("MhzLimit", ctypes.c_ulong),
                ("MaxIdleState", ctypes.c_ulong), ("CurrentIdleState", ctypes.c_ulong)]


#: Which Windows sampler failures have already been logged. The CPU row polls at up to 4 Hz —
#: a `logger.warning` on every tick would drown the log within a minute of one missing privilege
#: or one old Windows build lacking a call, so each distinct failure is logged exactly once
#: (same "log the state change, not the steady state" rule `power.py`'s stall counter follows).
_WIN_LOGGED: dict = {}


def _win_log_once(key: str, msg: str) -> None:
    if key in _WIN_LOGGED:
        return
    _WIN_LOGGED[key] = True
    logger.warning(msg)


def _win_get_system_times():
    """Raw GetSystemTimes call: (idle, kernel, user) in 100 ns ticks since boot, as a plain
    tuple of ints. Split out from `_win_cpu_percent` so that function's delta arithmetic —
    the part actually worth testing — can be exercised with an injected tuple instead of a
    live Win32 call. Raises OSError/AttributeError on any failure; `_win_cpu_percent` is the
    one that catches and degrades."""
    idle, kernel, user = _FILETIME(), _FILETIME(), _FILETIME()
    if not ctypes.windll.kernel32.GetSystemTimes(
            ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
        raise ctypes.WinError()

    def _ticks(ft):
        return (ft.dwHighDateTime << 32) | ft.dwLowDateTime
    return _ticks(idle), _ticks(kernel), _ticks(user)


def _win_cpu_percent():
    """Windows analogue of `_cpu_percent` above: same top-style scaling (100% = one logical
    core, × cpu_count × 100), same delta-since-last-call, same None on the first call — see
    that docstring for what the number means. Kept in `_CPU_PREV["win_times"]`, its own key,
    so it can never collide with the Linux "stat" key.

    🔴 KERNEL TIME INCLUDES IDLE TIME on Windows — GetSystemTimes' own contract says so — unlike
    /proc/stat, where idle and the other buckets are disjoint counters that simply sum to the
    total. So the fraction busy is NOT `1 - idle/total` the way the Linux side reads it; it's
    `(kernel + user - idle) / (kernel + user)`, because `kernel` already contains every idle
    tick and has to have it subtracted back out before `total` means "all CPU time" rather than
    "all CPU time, counted twice for the idle part"."""
    try:
        idle_t, kernel_t, user_t = _win_get_system_times()
    except (OSError, AttributeError, ValueError) as exc:
        _win_log_once("cpu_percent", f"cpu_stats: Windows CPU load unavailable "
                                      f"(GetSystemTimes failed: {exc})")
        return None
    prev = _CPU_PREV.get("win_times")
    _CPU_PREV["win_times"] = (idle_t, kernel_t, user_t)
    if not prev:
        return None                                           # first call: no delta yet
    d_idle = idle_t - prev[0]
    d_total = (kernel_t - prev[1]) + (user_t - prev[2])        # kernel INCLUDES idle — see above
    if d_total <= 0:
        return None
    busy = (d_total - d_idle) / d_total
    return round(max(0.0, busy) * (os.cpu_count() or 1) * 100)


def _win_get_processor_max_mhz_list():
    """Return each logical processor's nominal `MaxMhz` from `CallNtPowerInformation`. Windows
    may report `CurrentMhz` as a constant base value rather than a live clock, so use the
    performance counter for the current multiplier.
    """
    count = os.cpu_count() or 1
    buf = (_PROCESSOR_POWER_INFORMATION * count)()
    size = ctypes.sizeof(_PROCESSOR_POWER_INFORMATION) * count
    # ProcessorInformation == 11 in the POWER_INFORMATION_LEVEL enum (powrprof.h). That level
    # takes no input buffer — only the output array CallNtPowerInformation fills in place.
    status = ctypes.windll.powrprof.CallNtPowerInformation(11, None, 0, ctypes.byref(buf), size)
    if status != 0:                                            # STATUS_SUCCESS == 0
        raise OSError(f"CallNtPowerInformation returned NTSTATUS {status:#x}")
    return [p.MaxMhz for p in buf]


class _PDH_FMT_COUNTERVALUE(ctypes.Structure):
    """The subset of PDH_FMT_COUNTERVALUE this file reads — `CStatus` plus the `doubleValue`
    arm of its union, which is what a `PDH_FMT_DOUBLE`-formatted read fills in. ctypes applies
    the same struct-alignment rules the real (MSVC-compiled) struct was built with, so the
    4-byte gap between a `DWORD` and an 8-byte-aligned `double` member appears automatically —
    no explicit padding field is needed for these two members to land at the right offsets."""
    _fields_ = [("CStatus", ctypes.c_ulong), ("doubleValue", ctypes.c_double)]


#: PDH_FMT_DOUBLE — ask PdhGetFormattedCounterValue for a double rather than a long or a
#: string (pdh.h).
_PDH_FMT_DOUBLE = 0x00000200

#: The one PDH query this process ever opens, held for its whole life — same "resolve once"
#: reasoning as `_CPU_PATHS` above, except the resource here is a live OS query/counter HANDLE
#: pair rather than a path string, so there is nothing to re-glob and nothing to invalidate.
#: `collected` tracks whether `PdhCollectQueryData` has run at least once: `% Processor
#: Performance` is a RATE counter (see `_win_cpu_mhz`'s docstring for why it exists at all), and
#: its first collection has no earlier sample to compute a rate against — same "first call, no
#: answer yet" contract `_cpu_percent` and `_win_cpu_percent` both already follow.
_PDH_STATE: dict = {"query": None, "counter": None, "collected": False}
#: PDH handles are not documented safe for concurrent use from multiple threads without the
#: caller's own synchronization (MSDN). `cpu_stats()` has exactly one caller today
#: (`runtime/gpu.py`'s `strip_sample()`, itself serialized by its own `_STRIP_LOCK`) — but
#: `cpu_stats()` is a public, module-level function that a future caller could reach directly,
#: bypassing that lock entirely, and the query/counter handles below are mutable process-wide
#: state either way. The lock lives HERE, next to the state it protects, rather than being
#: assumed from a caller this file cannot see or guarantee.
_PDH_LOCK = threading.Lock()


def _win_open_pdh_query() -> None:
    """Opens `_PDH_STATE`'s query and adds the one counter this file wants. Raises on any
    failure; `_win_get_processor_performance_pct` (the only caller, always under `_PDH_LOCK`)
    is what degrades and logs."""
    query = ctypes.c_void_p()
    status = ctypes.windll.pdh.PdhOpenQueryW(None, 0, ctypes.byref(query))
    if status != 0:
        raise OSError(f"PdhOpenQueryW returned {status:#x}")
    counter = ctypes.c_void_p()
    # PdhAddEnglishCounterW, NOT PdhAddCounterW: the counter PATH below is a fixed English
    # string that must resolve the same way regardless of the box's display language. Available
    # since Vista — every OS this file targets is well past that floor.
    status = ctypes.windll.pdh.PdhAddEnglishCounterW(
        query, "\\Processor Information(_Total)\\% Processor Performance", 0, ctypes.byref(counter))
    if status != 0:
        ctypes.windll.pdh.PdhCloseQuery(query)
        raise OSError(f"PdhAddEnglishCounterW returned {status:#x}")
    _PDH_STATE["query"], _PDH_STATE["counter"] = query, counter


def _win_get_processor_performance_pct():
    """Raw PDH read of `\\Processor Information(_Total)\\% Processor Performance` — the live
    multiplier Task Manager's own "Speed" figure applies to the base clock (see `_win_cpu_mhz`'s
    docstring for the measurement that makes this call necessary at all). Opens the query lazily
    on the first call and leaves it open. A RATE counter, so the first `PdhCollectQueryData` in
    the query's life has nothing to compute a rate FROM and this returns None on it — the same
    delta contract every other sampler in this file follows, not a failure. Raises on any other
    PDH/Win32 failure; `_win_cpu_mhz` is what degrades and logs those."""
    with _PDH_LOCK:
        if _PDH_STATE["query"] is None:
            _win_open_pdh_query()
        status = ctypes.windll.pdh.PdhCollectQueryData(_PDH_STATE["query"])
        if status != 0:
            raise OSError(f"PdhCollectQueryData returned {status:#x}")
        first = not _PDH_STATE["collected"]
        _PDH_STATE["collected"] = True
        if first:
            return None                                        # rate counter: no delta yet
        value = _PDH_FMT_COUNTERVALUE()
        status = ctypes.windll.pdh.PdhGetFormattedCounterValue(
            _PDH_STATE["counter"], _PDH_FMT_DOUBLE, None, ctypes.byref(value))
        if status != 0:
            raise OSError(f"PdhGetFormattedCounterValue returned {status:#x}")
        return value.doubleValue


def _win_cpu_mhz():
    """Return the average current Windows CPU clock in MHz. Average the processors' nominal
    `MaxMhz` values for the base clock and apply the live `Processor Performance` counter;
    `CurrentMhz` is not a reliable live reading on modern systems. The performance counter's
    first sample may return `None` while its rate is established.
    """
    try:
        base_vals = _win_get_processor_max_mhz_list()
    except (OSError, AttributeError, ValueError) as exc:
        _win_log_once("cpu_mhz_base", f"cpu_stats: Windows base CPU clock unavailable "
                                       f"(CallNtPowerInformation failed: {exc})")
        return None
    if not base_vals:
        return None
    base_mhz = sum(base_vals) / len(base_vals)
    try:
        perf_pct = _win_get_processor_performance_pct()
    except (OSError, AttributeError, ValueError) as exc:
        _win_log_once("cpu_mhz_perf", f"cpu_stats: Windows live CPU clock unavailable "
                                       f"(PDH '% Processor Performance' failed: {exc})")
        return None
    if perf_pct is None:
        return None                                              # PDH query's first collection
    return round(base_mhz * perf_pct / 100)


def _win_get_memory_status():
    """Raw GlobalMemoryStatusEx call, returning (total_bytes, avail_bytes) as plain ints."""
    stat = _MEMORYSTATUSEX()
    stat.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
        raise ctypes.WinError()
    return stat.ullTotalPhys, stat.ullAvailPhys


def _win_cpu_mem():
    """Windows analogue of `_cpu_mem` above: used = total - available, same formula, same
    reasoning. `ullAvailPhys` is GlobalMemoryStatusEx's own estimate of what a new allocation
    could take without paging — the Windows analogue of Linux's `MemAvailable`, not a simple
    total-free (Windows also fills spare RAM with cache, and this field already excludes it
    from "used" the same way MemAvailable does)."""
    try:
        total, avail = _win_get_memory_status()
    except (OSError, AttributeError, ValueError) as exc:
        _win_log_once("cpu_mem", f"cpu_stats: Windows memory stats unavailable "
                                  f"(GlobalMemoryStatusEx failed: {exc})")
        return None
    if not total:
        return None
    used = max(0, total - avail)
    return round(used / 1073741824, 1), round(total / 1073741824, 1)   # bytes -> GiB


def _win_get_tick_count_ms():
    """Raw GetTickCount64 call, in milliseconds since boot. `restype` is set explicitly to a
    64-bit unsigned type — ctypes otherwise assumes a 32-bit `c_int` return, which would
    truncate or sign-flip a real tick count on any box that's been up more than ~24.8 days.
    (The 32-bit `GetTickCount` this replaces wrapped at ~49.7 days; that's why this one exists.)"""
    k32 = ctypes.windll.kernel32
    k32.GetTickCount64.restype = ctypes.c_ulonglong
    return k32.GetTickCount64()


def _win_uptime_s():
    """Windows analogue of `_uptime_s` above: seconds since boot, or None on failure."""
    try:
        ms = _win_get_tick_count_ms()
    except (OSError, AttributeError, ValueError) as exc:
        _win_log_once("uptime", f"cpu_stats: Windows uptime unavailable "
                                 f"(GetTickCount64 failed: {exc})")
        return None
    return ms / 1000.0


# Windows has no unprivileged CPU package-temperature API. When available, read HWiNFO's
# shared-memory section or LibreHardwareMonitor's optional loopback web server. Neither adds
# a Vocalis dependency; both sources require their own privileged sensor driver.
# The HWiNFO layout follows these independent MIT-licensed references:
# https://raw.githubusercontent.com/Seraksab/Hwinfo.SharedMemory.Net/main/Hwinfo.SharedMemory/MappedSection.cs
# https://raw.githubusercontent.com/kallex/PromDapterHWiNFO/master/HWiNFODataProvider/HWiNFOProvider.cs
# The LibreHardwareMonitor JSON shape follows its server implementation:
# https://raw.githubusercontent.com/LibreHardwareMonitor/LibreHardwareMonitor/master/LibreHardwareMonitor.Windows.Forms/Utilities/HttpServer.cs
# https://raw.githubusercontent.com/LibreHardwareMonitor/LibreHardwareMonitor/master/LibreHardwareMonitor.Windows.Forms/UI/SensorNode.cs

#: Which CPU temperature reading to show when a source publishes more than one — checked in this
#: order, first (exact, case-sensitive) label match wins. AMD's Tctl/Tdie is the control-loop
#: temperature — what the fan curve and PBO actually react to, not one core's hotspot — and it is
#: what HWiNFO and LHM each label it AS on AMD (differently from each other, hence two entries).
#: Intel has no Tctl/Tdie; "CPU Package" is its closest analogue, the package-level sensor.
#: Anything else falls back to the first temperature reading found under the CPU's own
#: sensor/hardware node instead of showing nothing — see `_win_parse_hwinfo_shm` and
#: `_win_pick_lhm_cpu_temp` below, which both apply this same list the same way.
_CPU_TEMP_LABEL_PREFERENCE = ("CPU (Tctl/Tdie)", "Core (Tctl/Tdie)", "CPU Package")

# ---- HWiNFO shared memory ---------------------------------------------------------------------

#: HWiNFO's shared-memory mapping name — `Global\` because it is the whole session's, not
#: per-user (both sources linked above agree on this name verbatim).
_HWINFO_SHM_NAME = "Global\\HWiNFO_SENS_SM2"

#: 'HWiS' read as a little-endian uint32 — HWiNFO's own "the shared memory is alive" signature
#: (Seraksab/Hwinfo.SharedMemory.Net, `MappedSection.cs`: `HWiNfoSensorsSignature`, "'HWiS' in
#: little-endian byte order").
_HWINFO_SIGNATURE_ALIVE = 0x53695748

#: HWiNFO overwrites the header's signature with this while a section is being torn down — the
#: free edition's 12-hour Shared Memory Support expiry included (same source: "HWiNFO overwrites
#: it (e.g. with 0xDEADBEEF) while the section is being torn down"). Anything that is neither
#: this nor the alive signature above (an unrecognized future build, mid-write garbage) is
#: treated exactly the same way: absent, not a crash — see `_win_parse_hwinfo_shm`.
_HWINFO_SIGNATURE_DEAD = 0xDEADBEEF

#: A sanity ceiling on `dwNumReadingElements`, not a real HWiNFO limit (a real install reports a
#: few hundred). HWiNFO republishes its whole section on every poll — drops the count to 0 and
#: counts back up while it refills — so a read landing in that window could see a header whose
#: signature still reads ALIVE but whose count is mid-write garbage. Rejecting an implausible
#: count is cheap insurance against looping over it; it is not the retry-with-backoff machinery
#: `Hwinfo.SharedMemory.Net` uses for the same race, which this file's ~1s cache makes
#: unnecessary here — a bad sample just means the NEXT sample tries again.
_HWINFO_MAX_READING_ELEMENTS = 100_000

#: HWiNFO_SENSORS_STRING_LEN2 / HWiNFO_UNIT_STRING_LEN, same two sources as above.
_HWINFO_LABEL_LEN = 128
_HWINFO_UNIT_LEN = 16

#: SENSOR_READING_TYPE.SENSOR_TYPE_TEMP — 1 in HWiNFO's own enum (`SENSOR_TYPE_NONE=0` comes
#: first; TEMP is the very next value). The only member of that enum this file needs.
_HWINFO_SENSOR_TYPE_TEMP = 1


class _HwInfoSharedMemHeader(ctypes.Structure):
    """HWiNFO's shared-memory header — see this section's header comment for where the layout
    came from. `_pack_ = 1` because HWiNFO's own struct is `#pragma pack(1)`: no compiler padding
    between the `poll_time` int64 and its neighboring uint32 fields.

    `dwVersion`/`dwRevision` are declared but never read — they exist here only so the fields
    after them land at the right byte offsets, the same reason `_MEMORYSTATUSEX` above declares
    fields this file doesn't otherwise touch."""
    _pack_ = 1
    _fields_ = [("dwSignature", ctypes.c_uint32), ("dwVersion", ctypes.c_uint32),
                ("dwRevision", ctypes.c_uint32), ("poll_time", ctypes.c_int64),
                ("dwOffsetOfSensorSection", ctypes.c_uint32),
                ("dwSizeOfSensorElement", ctypes.c_uint32),
                ("dwNumSensorElements", ctypes.c_uint32),
                ("dwOffsetOfReadingSection", ctypes.c_uint32),
                ("dwSizeOfReadingElement", ctypes.c_uint32),
                ("dwNumReadingElements", ctypes.c_uint32)]


class _HwInfoReadingElement(ctypes.Structure):
    """Describe the HWiNFO reading fields used by the shared-memory parser. Match the original
    sensor label rather than the user-renamed label, and inspect only temperature readings.
    Stride elements by the header's `dwSizeOfReadingElement`, which may exceed this
    structure's size. Read only the smaller of the declared element size and this
    structure's size.
    """
    _pack_ = 1
    _fields_ = [("tReading", ctypes.c_uint32), ("dwSensorIndex", ctypes.c_uint32),
                ("dwReadingID", ctypes.c_uint32),
                ("szLabelOrig", ctypes.c_char * _HWINFO_LABEL_LEN),
                ("szLabelUser", ctypes.c_char * _HWINFO_LABEL_LEN),
                ("szUnit", ctypes.c_char * _HWINFO_UNIT_LEN),
                ("Value", ctypes.c_double), ("ValueMin", ctypes.c_double),
                ("ValueMax", ctypes.c_double), ("ValueAvg", ctypes.c_double)]


def _win_open_hwinfo_view():
    """Opens HWiNFO's shared-memory mapping and returns `(base_address, cleanup)`, or `None` if
    HWiNFO isn't currently publishing one — `OpenFileMappingW` simply not finding the name, the
    overwhelmingly common case on a box that doesn't run HWiNFO at all (this one, right now).
    Raises `OSError` on any OTHER Win32 failure — `_win_read_hwinfo_temp` is what catches and
    degrades, same split as every other `_win_*` source in this file.

    Split from `_win_parse_hwinfo_shm` purely for testability, the same reason
    `_win_get_system_times` is split from `_win_cpu_percent`: a test can hand that function the
    address of a fabricated `bytearray` instead of this function's real mapping — see its
    docstring."""
    k32 = ctypes.windll.kernel32
    k32.OpenFileMappingW.restype = ctypes.c_void_p
    k32.OpenFileMappingW.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_wchar_p]
    k32.MapViewOfFile.restype = ctypes.c_void_p
    k32.MapViewOfFile.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
                                   ctypes.c_uint32, ctypes.c_size_t]
    k32.UnmapViewOfFile.restype = ctypes.c_int
    k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
    k32.CloseHandle.restype = ctypes.c_int
    k32.CloseHandle.argtypes = [ctypes.c_void_p]
    file_map_read = 0x0004
    handle = k32.OpenFileMappingW(file_map_read, False, _HWINFO_SHM_NAME)
    if not handle:
        return None                                        # HWiNFO not running / SHM support off
    view = k32.MapViewOfFile(handle, file_map_read, 0, 0, 0)
    if not view:
        k32.CloseHandle(handle)
        raise ctypes.WinError()

    def _cleanup():
        try:
            if not k32.UnmapViewOfFile(view):
                raise ctypes.WinError()
        finally:
            # A failed unmap must not leak the mapping handle. Keep the unmap error as the
            # reported failure if both cleanup calls fail.
            if not k32.CloseHandle(handle):
                close_error = ctypes.WinError()
                if sys.exc_info()[0] is None:
                    raise close_error

    return view, _cleanup


def _win_parse_hwinfo_shm(base: int):
    """Parses HWiNFO's shared-memory layout starting at `base` and returns `(temp_c, label)` for
    the best CPU temperature reading — `label` is the ORIGINAL label that matched, purely so
    `_win_cpu_temp_source` can log which one it found — or `None` if the section carries no
    valid/live header or no temperature reading at all.

    `base` is just an integer address: the tests build a `bytearray` in this exact layout and
    hand this function `ctypes.addressof()` of it, which exercises the same pointer arithmetic a
    real HWiNFO mapping needs without opening one. `_win_open_hwinfo_view` above is the only
    thing that ever points this at a real mapping."""
    header = _HwInfoSharedMemHeader.from_address(base)
    if header.dwSignature != _HWINFO_SIGNATURE_ALIVE:
        # Covers the DEAD signature (torn down / free-edition 12-hour expiry) AND anything else
        # unrecognized — HWiNFO gives no way to tell those apart at this layer, and an
        # unrecognized signature is exactly as untrustworthy as a dead one.
        return None
    count = header.dwNumReadingElements
    if count > _HWINFO_MAX_READING_ELEMENTS:
        _win_log_once("hwinfo_count", f"cpu_stats: HWiNFO section reports {count} reading "
                                       f"elements (implausible) — ignoring this sample")
        return None
    stride = header.dwSizeOfReadingElement
    read_len = min(ctypes.sizeof(_HwInfoReadingElement), stride)
    section_base = base + header.dwOffsetOfReadingSection
    best = None                                            # (preference rank, label, value)
    fallback = None                                        # first temperature reading, any label
    for i in range(count):
        raw = ctypes.string_at(section_base + i * stride, read_len)
        # Zero-padded so a header claiming a SMALLER element than this struct (should never
        # happen on a well-formed section, but nothing here should trust that) leaves the
        # trailing fields — ValueMin/Max/Avg, unused anyway — at a harmless 0.0 rather than
        # reading uninitialized memory.
        elem = _HwInfoReadingElement.from_buffer_copy(
            raw.ljust(ctypes.sizeof(_HwInfoReadingElement), b"\x00"))
        if elem.tReading != _HWINFO_SENSOR_TYPE_TEMP:
            continue
        label = elem.szLabelOrig.decode("latin-1", "replace")     # CP1252's degree-sign-safe subset
        value = elem.Value
        if fallback is None:
            fallback = (label, value)
        if label in _CPU_TEMP_LABEL_PREFERENCE:
            rank = _CPU_TEMP_LABEL_PREFERENCE.index(label)
            if best is None or rank < best[0]:
                best = (rank, label, value)
    chosen = (best[1], best[2]) if best else fallback
    return (round(chosen[1]), chosen[0]) if chosen else None


def _win_read_hwinfo_temp():
    """`(temp_c, label)` for HWiNFO's best current CPU temperature reading, or `None` if HWiNFO
    isn't publishing shared memory right now. Raises `OSError`/`AttributeError` on any other
    Win32 failure; `_win_cpu_temp_source` is what catches and degrades."""
    view = _win_open_hwinfo_view()
    if view is None:
        return None
    base, cleanup = view
    try:
        return _win_parse_hwinfo_shm(base)
    finally:
        cleanup()


# ---- LibreHardwareMonitor web server ------------------------------------------------------------

#: LHM's Remote Web Server default port (Options ▸ Remote Web Server) when nothing overrides it.
_LHM_PORT_DEFAULT = 8085

#: Keep this bounded: a closed loopback endpoint may time out instead of failing immediately.
#: The temperature probe runs asynchronously, so a missing sensor service cannot block sampling.
_LHM_FETCH_TIMEOUT_S = 0.3


def _win_lhm_port() -> int:
    """Resolves LibreHardwareMonitor's web-server port: env `VOCALIS_LHM_PORT` ->
    `app_settings.yaml`'s `sensors: lhm_port:` -> `_LHM_PORT_DEFAULT` — the same env -> app
    setting -> default precedence `vocalis.runtime.acestep.configured()` follows for its own
    port.

    `vocalis.runtime.settings` is imported LAZILY, not at module scope: this file is deliberately
    import-light (`book_to_audio.py` and `nomi_speak.py` both use it without the rest of the app
    on their path), and `vocalis.runtime.settings` itself imports `atomic_replace` FROM this
    file — an unconditional top-level import here would be circular. Where the `vocalis` package
    can't be imported at all, this just falls back to the env var and the default, the same way
    every other setting in this file already degrades when its source isn't there."""
    env = os.environ.get("VOCALIS_LHM_PORT")
    if env:
        try:
            return int(env)
        except ValueError:
            _win_log_once("lhm_port_env", f"cpu_stats: VOCALIS_LHM_PORT={env!r} is not an "
                                           f"integer — using app_settings/default instead")
    try:
        from vocalis.runtime import settings as _settings
    except ImportError as exc:
        _win_log_once("lhm_port_import", f"cpu_stats: vocalis.runtime.settings unavailable "
                                          f"({exc}) — using the default LHM port "
                                          f"{_LHM_PORT_DEFAULT}")
        return _LHM_PORT_DEFAULT
    sensors_cfg = _settings.load_app_settings().get("sensors")
    port = sensors_cfg.get("lhm_port") if isinstance(sensors_cfg, dict) else None
    if not port:
        return _LHM_PORT_DEFAULT
    try:
        return int(port)
    except (TypeError, ValueError):
        _win_log_once("lhm_port_settings", f"cpu_stats: app_settings sensors.lhm_port={port!r} "
                                            f"is not an integer — using {_LHM_PORT_DEFAULT}")
        return _LHM_PORT_DEFAULT


def _win_fetch_lhm_json(port: int = None) -> dict:
    """Raw fetch of LHM's `data.json` as a parsed dict. Split out from `_win_pick_lhm_cpu_temp`
    for the same testability reason `_win_get_system_times` is split from `_win_cpu_percent`:
    this is the one thing here that touches the network, so tests inject a replacement for THIS
    function instead of standing up a real HTTP server. Raises `OSError`/`ValueError` on any
    fetch/parse failure — a closed port is the overwhelmingly common case, since LHM's Remote Web
    Server option defaults OFF. `_win_cpu_temp_source` is what catches and degrades."""
    import json
    import urllib.request
    url = f"http://127.0.0.1:{port if port is not None else _win_lhm_port()}/data.json"
    with urllib.request.urlopen(url, timeout=_LHM_FETCH_TIMEOUT_S) as resp:
        return json.loads(resp.read())


def _win_pick_lhm_cpu_temp(tree: dict):
    """Walk LibreHardwareMonitor's parsed `data.json` tree and return the best CPU temperature
    as `(temp_c, label)`, or `None`. Temperature values are formatted strings such as `"62.4
    °C"`. Prefer CPU hardware nodes identified by `HardwareId`; when that field is absent on
    older versions, scan the whole tree and use the CPU-specific label preference list.
    """
    cpu_hw_nodes = []
    saw_hardware_id = [False]                              # one-element list: a mutable closure cell

    def _find_cpu_hw(node):
        hw_id = node.get("HardwareId")
        if hw_id is not None:
            saw_hardware_id[0] = True
            if hw_id.lower().startswith(("/amdcpu", "/intelcpu")):
                cpu_hw_nodes.append(node)
                return                                     # a CPU hw node's children are its own
        for child in node.get("Children") or []:
            _find_cpu_hw(child)

    _find_cpu_hw(tree)
    scope = cpu_hw_nodes if cpu_hw_nodes else ([] if saw_hardware_id[0] else [tree])
    if not scope:
        return None                                         # HardwareId present, but no CPU found

    best = None                                             # (preference rank, label, value)
    fallback = None                                         # first temperature reading, any label

    def _find_temps(node):
        nonlocal best, fallback
        has_type = "Type" in node
        is_temp_leaf = (node.get("Type") == "Temperature" if has_type
                         else bool(_LHM_CELSIUS_RE.search(str(node.get("Value") or ""))))
        if is_temp_leaf:
            value = _parse_lhm_celsius(node.get("Value"))
            if value is not None:
                label = node.get("Text") or ""
                if fallback is None:
                    fallback = (label, value)
                if label in _CPU_TEMP_LABEL_PREFERENCE:
                    rank = _CPU_TEMP_LABEL_PREFERENCE.index(label)
                    if best is None or rank < best[0]:
                        best = (rank, label, value)
        for child in node.get("Children") or []:
            _find_temps(child)

    for hw_node in scope:
        _find_temps(hw_node)
    chosen = (best[1], best[2]) if best else fallback
    return (round(chosen[1]), chosen[0]) if chosen else None


#: Matches the leading numeric value of LHM's formatted Celsius string, e.g. "62.4" out of
#: "62.4 °C". Deliberately does NOT match a °F reading — an LHM install configured for Fahrenheit
#: units reports its Value as "144.3 °F", which this regex will not find, so a Fahrenheit-
#: configured box degrades to "no LHM reading" (falls through to HWiNFO, or to None) rather than
#: silently mislabeling a Fahrenheit number as Celsius. Converting it is out of scope here — the
#: brief this shipped against asked for °C parsing only.
_LHM_CELSIUS_RE = re.compile(r"-?\d+(?:\.\d+)?(?=\s*\xb0C)")


def _parse_lhm_celsius(value) -> float:
    """Extracts the numeric °C reading from LHM's formatted string (`"62.4 °C"`), or `None` for
    anything else — a container node's blank placeholder Value, a non-Celsius unit. See
    `_LHM_CELSIUS_RE`'s own comment for the Fahrenheit case specifically."""
    if not isinstance(value, str):
        return None
    m = _LHM_CELSIUS_RE.search(value)
    return float(m.group()) if m else None


def _win_read_lhm_temp(port: int = None):
    """`(temp_c, label)` for LibreHardwareMonitor's best CPU temperature reading, or `None` if
    the fetch succeeded but published no CPU temperature at all — distinct from the fetch itself
    failing, which `_win_fetch_lhm_json` raises instead of returning."""
    tree = _win_fetch_lhm_json(port)
    return _win_pick_lhm_cpu_temp(tree)


# ---- combining the two, with the strip's own caching -------------------------------------------

#: Cached Windows CPU temperature: `{"temp_c", "source", "resolved_at", "probed_at", "refreshing"}`.
#: `resolved_at` is the monotonic time of the last SUCCESSFUL read — what
#: `_WIN_TEMP_STALE_FLOOR_S` checks. `probed_at` is the time of the last COMPLETED probe attempt,
#: success or failure — what the cache-fresh/re-probe windows below check to decide whether
#: another refresh is due. `refreshing` is the in-flight guard: at most one refresh is ever
#: outstanding, so a slow probe can never stack up threads — see `_win_cpu_temp_source`.
_WIN_TEMP_STATE: dict = {"temp_c": None, "source": None, "resolved_at": None, "probed_at": None,
                          "refreshing": False}
#: Protect every `_WIN_TEMP_STATE` access and refresh decision, but never hold the lock across
#: HWiNFO or LibreHardwareMonitor I/O. `cpu_stats()` runs under the strip lock shared by
#: HTTP, SSE, and job events, so probes run on a single background thread and callers read cache.
_WIN_TEMP_LOCK = threading.Lock()

_WIN_TEMP_CACHE_S = 1.0        # a found source is re-read at most once a second
_WIN_TEMP_REPROBE_S = 15.0     # an ABSENT source is re-tried at most once every 15s
#: 🔴 THE STALENESS FLOOR — a backstop UNDER the cadence above, not a replacement for it. Under
#: normal operation `resolved_at` refreshes every `_WIN_TEMP_CACHE_S` (1s) while a source is
#: healthy, so this never fires in the happy path. It exists for when something ELSE goes wrong —
#: the refresh thread wedges inside a probe, the process is starved and the daemon thread never
#: gets scheduled, a future bug leaves `refreshing` stuck `True` — in which case a number that
#: stopped updating minutes ago must not keep showing as if it were live: the UI showing nothing
#: beats the UI showing a wrong number. Ten times the normal cache window: generous enough that
#: one merely-slow refresh cycle never trips it, tight enough that a genuinely wedged sampler goes
#: blank within seconds, not minutes.
_WIN_TEMP_STALE_FLOOR_S = 10.0


def _win_spawn_temp_refresh(fn) -> None:
    """The real refresh runner: one named, DAEMON thread per call — never started at import, only
    when `_win_cpu_temp_source` decides a refresh is actually due. Daemon so a wedged probe (an
    `urlopen` hung past its own timeout, say) can never keep the process from exiting.

    Split out from `_win_cpu_temp_source` purely so tests can inject a synchronous stand-in
    (either `runner=` or by monkeypatching `_WIN_TEMP_RUNNER`) and drive the whole thing with an
    injected clock — no real thread, no sleep, in any test."""
    threading.Thread(target=fn, name="vocalis-cputemp", daemon=True).start()


#: The runner `_win_cpu_temp_source` uses when its own `runner` argument is omitted — a
#: module-level indirection, not a hardcoded call, so a test can monkeypatch this ONE name and
#: every caller that doesn't pass `runner=` explicitly (i.e. `_win_cpu_stats`'s real, production
#: call) picks up the replacement too.
_WIN_TEMP_RUNNER = _win_spawn_temp_refresh


def _win_do_temp_refresh(now: float) -> None:
    """Runs the actual probe — HWiNFO, then LHM if that finds nothing — OUTSIDE `_WIN_TEMP_LOCK`,
    and writes the result back under the lock once it's done. This is the function
    `runner`/`_WIN_TEMP_RUNNER` is handed; it ALWAYS clears `_WIN_TEMP_STATE["refreshing"]` before
    returning, including on an unexpected exception, so a bug in here can never wedge every future
    sample behind a permanently "in flight" refresh.

    `now` is the monotonic time the refresh was TRIGGERED at, not when it completes: stamping
    `probed_at`/`resolved_at` with the trigger time rather than reading a fresh clock inside the
    thread makes an in-flight probe look, if anything, SLIGHTLY more stale than it truly is once
    it lands — never less — and keeps this whole path driven by the one clock
    `_win_cpu_temp_source`'s caller already controls, with no second clock read a test would have
    to fake out separately."""
    temp_c, source, label = None, None, None
    try:
        try:
            hw = _win_read_hwinfo_temp()
        except (OSError, AttributeError, ValueError) as exc:
            _win_log_once("temp_hwinfo", f"cpu_stats: HWiNFO shared memory unavailable ({exc})")
            hw = None
        if hw is not None:
            temp_c, label = hw
            source = "hwinfo"
        else:
            try:
                lhm = _win_read_lhm_temp()
            except (OSError, ValueError) as exc:
                _win_log_once("temp_lhm", f"cpu_stats: LibreHardwareMonitor web server "
                                           f"unavailable ({exc})")
                lhm = None
            if lhm is not None:
                temp_c, label = lhm
                source = "lhm"
    except Exception as exc:
        # A swallow of last resort. Nothing above should raise anything but the two tuples
        # already caught, but this runs on a background thread with NO caller to propagate to —
        # an exception escaping here would just vanish silently (Python logs an unhandled thread
        # exception, but nothing IN this app would see it) and leave `refreshing` stuck True
        # forever were it not for the `finally` below. Logged once, same rule as every other
        # swallowed exception in this file.
        _win_log_once("temp_refresh", f"cpu_stats: Windows temperature refresh failed "
                                       f"unexpectedly ({exc})")
    finally:
        with _WIN_TEMP_LOCK:
            state = _WIN_TEMP_STATE
            if source != state["source"]:
                if source:
                    logger.info(f"cpu_stats: Windows CPU temperature source found — {source} "
                                f"('{label}', {temp_c} C)")
                elif state["source"]:
                    logger.info(f"cpu_stats: Windows CPU temperature source lost — was "
                                f"{state['source']}")
            state["temp_c"], state["source"] = temp_c, source
            state["probed_at"] = now
            if source is not None:
                state["resolved_at"] = now
            state["refreshing"] = False


def _win_cpu_temp_source(now: float = None, runner=None) -> tuple:
    """Return cached `(temp_c, source)` for the Windows CPU-temperature row, where source is
    `"hwinfo"`, `"lhm"`, or `None`. This function never waits for a probe: when the cache
    expires it starts at most one background refresh and returns the prior cached value.
    Failed probes use the longer retry interval, and readings older than
    `_WIN_TEMP_STALE_FLOOR_S` are reported as unavailable.
    """
    now = now if now is not None else time.monotonic()
    run = runner if runner is not None else _WIN_TEMP_RUNNER
    with _WIN_TEMP_LOCK:
        state = _WIN_TEMP_STATE
        due = (state["probed_at"] is None
               or (state["source"] is not None and now - state["probed_at"] >= _WIN_TEMP_CACHE_S)
               or (state["source"] is None and now - state["probed_at"] >= _WIN_TEMP_REPROBE_S))
        start_refresh = due and not state["refreshing"]
        if start_refresh:
            state["refreshing"] = True
        temp_c, source = state["temp_c"], state["source"]
        stale = (source is not None
                 and (state["resolved_at"] is None
                      or now - state["resolved_at"] > _WIN_TEMP_STALE_FLOOR_S))
    # The refresh is launched AFTER the lock is released, not inside the `with` block above: an
    # injected synchronous `runner` (every test in this file) calls `_win_do_temp_refresh`
    # directly, which itself takes `_WIN_TEMP_LOCK` in its own `finally` — starting it while this
    # function still held the lock would deadlock a plain `threading.Lock` against itself on
    # every synchronous-runner test. The real threaded runner doesn't need the lock held either:
    # `Thread.start()` only schedules the thread: nothing about starting it touches shared state.
    if start_refresh:
        run(lambda: _win_do_temp_refresh(now))
    if stale:
        return None, None
    return temp_c, source


def _win_cpu_stats() -> dict:
    """Windows branch of `cpu_stats()` below — same keys, same None-degrades-the-field
    contract, different sources. Every field this platform genuinely has no reading for
    carries its own one-line reason; see the general note in this section's header comment."""
    mem = _win_cpu_mem()
    temp_c, temp_src = _win_cpu_temp_source()
    result = {"pct": _win_cpu_percent(), "mhz": _win_cpu_mhz(),
              # No unprivileged Windows API reports package power: RAPL has no Windows analogue
              # a normal process can read.
              "power_w": None,
              # 🔴 SUPERSEDED, NOT DELETED: this used to be unconditionally None for the reason
              # below, which is STILL TRUE by itself — no unprivileged Win32/WMI API reports
              # package temperature; the ACPI thermal zone WMI exposes
              # (MSAcpi_ThermalZoneTemperature) is a board zone, not a per-package sensor, and is
              # frequently absent or stale on consumer boards. What changed is that Windows isn't
              # the only thing that can answer any more: `_win_cpu_temp_source` (see its own
              # docstring) reads HWiNFO's shared memory or LibreHardwareMonitor's web server,
              # either while it happens to be running, and this is only what's left None when
              # NEITHER is — not "never on Windows" any more.
              "temp_c": temp_c,
              # Which of the two supplied `temp_c` — "hwinfo" | "lhm" | None. `cpu_stats()`'s
              # Linux branch below always sends this key too (as None), so hwstrip.js never has
              # to special-case its absence — only its value.
              "temp_src": temp_src,
              "cores": os.cpu_count() or 1,
              "mem_used_gb":  mem[0] if mem else None,
              "mem_total_gb": mem[1] if mem else None,
              # ZFS ARC has no Windows equivalent.
              "mem_reclaimable_gb": None,
              # Windows reports commit charge / pagefile usage here, not the quantity this line
              # claims (pages the kernel actually pushed out of RAM to disk) — faking one from the
              # other would answer a question nobody asked, so both stay None rather than mislead.
              "swap_used_gb": None,
              "swap_total_gb": None,
              # PSI is a Linux kernel feature (CONFIG_PSI); nothing on Windows measures the same
              # "time stalled waiting on memory" quantity.
              "mem_psi": None,
              "uptime_s": _win_uptime_s(),
              # No unprivileged Windows equivalent of /proc/loadavg — Windows has no run-queue
              # average at all, privileged or not.
              "loadavg": None}
    if temp_c is None:
        # Include a setup hint only when no temperature source is available. The client uses this
        # property to show the guidance without inferring the platform itself.
        result["temp_hint"] = ("CPU temperature on Windows comes from HWiNFO (Settings ▸ Shared "
                                "Memory Support) or LibreHardwareMonitor (Options ▸ Remote Web "
                                "Server) while it is running.")
    return result


def cpu_stats() -> dict:
    """The strip's CPU line: load, clock, power, temperature, RAM. Any field the box can't
    report comes back None and the UI omits it."""
    if os.name == "nt":
        return _win_cpu_stats()
    info = _meminfo()
    mem = _cpu_mem(info)
    arc = _arc_reclaimable_gb() if mem else None
    swap = _swap_gb(info)
    psi = _mem_psi()
    # Never claim more is reclaimable than is used: the two readings are taken microseconds apart
    # from different files, and a bar segment longer than the bar is a rendering bug, not a fact.
    if arc is not None and mem:
        arc = min(arc, mem[0])
    return {"pct": _cpu_percent(), "mhz": _cpu_mhz(), "power_w": _cpu_power_w(),
            "temp_c": _cpu_temp_c(),
            # Always present (mirroring Windows' own key of the same name), always None here:
            # this platform's temperature comes straight off hwmon, never off a monitoring app —
            # see `_win_cpu_temp_source` for the Windows side of this field.
            "temp_src": None,
            "cores": os.cpu_count() or 1,
            "mem_used_gb":  mem[0] if mem else None,
            "mem_total_gb": mem[1] if mem else None,
            # None on every non-ZFS box, which is what makes the UI degrade to one solid bar.
            "mem_reclaimable_gb": arc,
            # The two header lines under the buttons (7.3.2). Each is None on a box that
            # cannot report it — no swap configured, or a kernel built without CONFIG_PSI —
            # and the UI omits that line entirely rather than printing a zero it invented.
            "swap_used_gb":  swap[0] if swap else None,
            "swap_total_gb": swap[1] if swap else None,
            "mem_psi": psi,
            # Two more small pseudo-file reads per sample, on the same line as swap: without
            # uptime the stall total below it cannot be judged at all, and load average is the
            # one contention signal the CPU row's percentage cannot show (see _loadavg).
            "uptime_s": _uptime_s(),
            "loadavg": _loadavg()}


def vram_used_total_sensor(device):
    """`(used_bytes, total_bytes)` from AMD's system sensor ONLY, or None when it has no answer
    for this card. This is the first step of `vram_used_total` and nothing else: no NVML, and
    above all no `torch.cuda.mem_get_info`, which creates a CUDA context (about 200 MB on a Radeon
    AI PRO R9700, measured October 10, 2026) and reports PyTorch's number rather than the whole
    card's. The satellite's telemetry readout uses it so that sampling a card that holds no model
    never creates a context. Reading the device properties for the PCI address does not create
    one (the same measurement)."""
    import torch
    try:
        idx = int(str(device).split(":")[1]) if ":" in str(device) else int(device)
        p = torch.cuda.get_device_properties(idx)
        bus = getattr(p, "pci_bus_id", None)
        if bus is None:
            return None
        dom = getattr(p, "pci_domain_id", 0) or 0
        u, t = _amd_sysfs_vram_by_pci(dom, bus)
        return (u, t) if u is not None and t else None
    except Exception:
        return None


def vram_used_total(device) -> tuple:
    """(used_bytes, total_bytes) whole-card for a cuda device — accurate even with
    co-tenant processes. The order, October 10, 2026:

      1. the AMD sysfs sensor (ROCm's mem_get_info wildly under-reports other processes);
      2. the NVIDIA driver through NVML, matched to PyTorch's card by UUID (the satellite's
         readout module; see `_nvidia_card`);
      3. torch.cuda.mem_get_info.

    Step 3 is right on Linux with NVIDIA, where the driver and PyTorch agree, and is what is
    left when NVML cannot be used. It is NOT right on Windows: measured on the Windows NVIDIA test machine on October 10,
    2026, with another process holding 4 GiB of the RTX 4090, mem_get_info still reported
    22,988 MiB free while NVML (what nvidia-smi prints) went from 10,216 to 5,670 MiB free; the
    same gap appears inside Docker Desktop containers and in native Windows Python, so it is
    how Windows hands out GPU memory, not Docker. This docstring used to say the fallback "is
    correct on CUDA", which holds on Linux only."""
    import torch
    idx = int(str(device).split(":")[1]) if ":" in str(device) else int(device)
    # Step 1 is `vram_used_total_sensor`, the one place that reads the AMD sensor.
    sensor = vram_used_total_sensor(idx)
    if sensor is not None:
        return sensor
    # Memory only: this is asked every half second by the satellite's decode loop and by every
    # fit-check, none of which want the eight sensor calls.
    card = _nvidia_card(idx, max_age_s=_NVML_MEMORY_REUSE_S, memory_only=True)
    if card is not None and card.get("used_bytes") is not None and card.get("total_bytes"):
        return card["used_bytes"], card["total_bytes"]
    free, total = torch.cuda.mem_get_info(idx)
    return total - free, total


def device_mem_gb(device) -> tuple:
    """(free_gb, total_gb) for a cuda device string; (None, None) for cpu. Uses the
    accurate whole-card reader (vram_used_total) so the fit-check sees the REAL free
    VRAM when the card is shared with another process — not mem_get_info's inflated
    free. Works on CUDA and ROCm (HIP)."""
    if not str(device).startswith("cuda"):
        return None, None
    used, total = vram_used_total(device)
    return (total - used) / 2**30, total / 2**30


def _satellite_asleep(exc) -> bool:
    """True if exc is "that other machine is not running" — §11.4's normal steady state.

    Kept beside `_is_oom` because the pool build treats them the same way: neither is a reason
    to fail a render that the remaining devices can serve.
    """
    try:
        from satellite_client import SatelliteUnreachable
    except ImportError:                        # a build with no satellite support at all
        return False
    return isinstance(exc, SatelliteUnreachable)


def _is_oom(exc) -> bool:
    """True if exc is an out-of-memory error (CUDA or ROCm/HIP)."""
    import torch
    oom_cls = getattr(torch.cuda, "OutOfMemoryError", ())
    if isinstance(exc, oom_cls):
        return True
    msg = str(exc).lower()
    return "out of memory" in msg or "hip out of memory" in msg or "cuda error: out of memory" in msg


def describe_devices(devices) -> str:
    """Human-readable 'cuda:0 NVIDIA GeForce RTX 4090 | cuda:1 ...' for logging."""
    import torch
    parts = []
    for d in devices:
        if d.startswith("cuda"):
            try:
                parts.append(f"{d} {torch.cuda.get_device_name(int(d.split(':')[1]))}")
            except Exception:
                parts.append(d)
        else:
            parts.append(d)
    return "  |  ".join(parts)


@dataclass
class GenParams:
    """Per-job generation settings handed to the pool (voice/knobs).
    Rendering is UNSEEDED (torch's RNG self-seeds at process start and rolls
    forward): identity = text + voice + knobs, and the stored audio artifact IS
    the reproducibility — seeds were removed everywhere in 3.x."""
    voice: str = None
    exaggeration: float = 0.5
    cfg: float = 0.5
    temperature: float = 0.8


# ── Shared-pool scheduling (2.1-M1) ───────────────────────────────────────────
# One pool, one set of replicas: every caller — a book section, a Nomi /speak, a
# SillyTavern message — submits its chunks to a shared PriorityQueue and they
# interleave at chunk granularity across all workers. Interactive speech (Nomi/ST)
# outranks batch book chunks; within a priority it's FIFO by submission order.
INTERACTIVE = 0     # /speak, SillyTavern — served before book chunks
BATCH       = 10    # book render / playground

# Scheduling is demand-driven: each worker takes the work it can start now and returns for more.
# Batching devices request one capacity-bounded pass; workers do not reserve work across devices.


class _Shutdown:
    """Sentinel job that tells a worker thread to exit (used by pool.shutdown())."""


_SHUTDOWN = _Shutdown()


class _Job:
    """One chunk queued on the shared pool. Carried in the PriorityQueue as
    (priority, seq, _Job); seq is a globally-unique monotonic counter, so two jobs
    never fall through to comparing _Job instances (which aren't orderable)."""
    __slots__ = ("index", "text", "batch")

    def __init__(self, index, text, batch):
        self.index = index
        self.text  = text
        self.batch = batch


class _StreamJob:
    """A chunk that renders via a caller-supplied STREAMING function instead of the
    standard whole-chunk generate (Vocalis 3.0: vocalis_streaming.stream_message).
    The worker that dequeues it is naturally leased for the job's duration; all
    other bookkeeping (priority, events, accounting) is shared with _Job. runner is
    called as runner(model, heartbeat) and must return (wav, chars, dt) — the
    concatenated audio, so the batch's save callback banks it like any other chunk
    (which is what feeds the whole-message cache tee). A stream job is NEVER
    requeued/retried: its audio may already be on the wire, and a retry would
    replay it."""
    __slots__ = ("index", "text", "batch", "runner")

    def __init__(self, index, text, batch, runner):
        self.index  = index
        self.text   = text
        self.batch  = batch
        self.runner = runner


class _Batch:
    """One caller's submission to the shared pool: its per-chunk retry budget,
    result accounting, and a progress event the caller's collect() waits on. Done
    when `pending` reaches 0; if `failed` is non-empty then, collect() raises.

    `inflight` = jobs of this batch a worker is CURRENTLY generating; the stall
    watchdog only fires while inflight > 0 (a chunk mid-generation that stops making
    progress is a wedged kernel — a chunk merely queued behind other work is not)."""

    def __init__(self, params, priority, save, total, on_event, chapter, cancel,
                 st_speech=False):
        self.params   = params
        self.priority = priority
        # This identifies live SillyTavern speech, whose submissions obey the satellite's configured
        # cap. Other interactive and speculative jobs do not use this speech-specific limit.
        self.st_speech = bool(st_speech)
        self.save     = save
        self.total    = total
        self.on_event = on_event
        self.chapter  = chapter
        self.cancel   = cancel or threading.Event()
        self.lock     = threading.Lock()
        self.progress = threading.Event()   # pulsed on every completion / failure / drop
        self.pending  = 0                    # jobs not yet resolved (done | failed | canceled)
        self.inflight = 0                    # jobs a worker is generating right now (watchdog)
        self.attempts = {}                   # index -> non-OOM attempt count
        self.failed   = {}                   # index -> repr(exc) for chunks we gave up on
        self.errs     = []                   # (device, index, repr) diagnostics
        self.chars    = 0
        self.time     = 0.0
        # 5.0-M5 boundary 3: the actual VaultAuthError, not a repr of it, so collect() can
        # RE-RAISE it rather than flatten it into a RuntimeError. That is what lets the job
        # thread's `except VaultAuthError` (boundary 2) see it and report a vault failure
        # instead of a generic "chunk failed" -- and, crucially, delete nothing.
        self.vault_error = None


class WorkerPool:
    """Thread-per-worker TTS pool. Built once (loads the replicas); reused per
    section/clip via run_chunks(). Reassembly is the caller's job (indexed files).
    """

    def __init__(self, devices: list, workers_per_device,
                 act_headroom_gb: float = 1.5):
        """act_headroom_gb — VRAM to keep free *per loaded worker* for its
        generation activation. The fit check stops adding workers to a card once
        `free < (loaded+1) * act_headroom_gb`, so replicas never pack the card so
        tightly that generation OOMs. We deliberately do NOT chase a per-worker
        'marginal' delta: mem_get_info reports whole-card free VRAM, so on a shared
        desktop card other processes make that delta noisy (even negative). The
        graceful load/runtime OOM paths are the real backstop; exact tuning is done
        on the headless target.

        workers_per_device — an int (every device gets it) OR a {device: count} dict.
        Counts are per-device because a single value cannot suit different VRAM capacities;
        the default of 1 limits resource contention with other workloads. The dict form is an
        EXTENSION of the input, deliberately: the fit check, the graceful load-time OOM
        drop and the footprint logging below are tuned and are not restructured around
        it. See DESIGN_5_3_SATELLITES §3.5.
        """
        import torch
        counts = ({str(d): int(n) for d, n in workers_per_device.items()}
                  if isinstance(workers_per_device, dict)
                  else {str(d): int(workers_per_device) for d in devices})
        if any(n < 1 for n in counts.values()):
            raise VocalisError("--workers must be >= 1.")
        if not counts:
            raise VocalisError("no devices selected.")
        self.worker_counts = counts
        self.devices = list(devices)
        self.workers = []   # [{id, device}]; the model replica is held in _models
        self._models = {}   # worker id -> model replica
        self._lock   = threading.Lock()   # guards workers/_models mutation (worker drop)
        self.poisoned = False   # set on a stall abort: a zombie thread may still hold a
                                # replica, so a cached pool must be rebuilt, never reused
        wid = 0
        satellites_asleep = []            # devices skipped because that machine is not running
        for dev in self.devices:
            is_cuda  = dev.startswith("cuda")
            if is_cuda:
                torch.cuda.set_device(int(dev.split(":")[1]))
            loaded    = 0
            first_free = None   # card free BEFORE the first worker (for footprint report)
            for slot in range(counts.get(str(dev), 1)):
                free_gb, total_gb = device_mem_gb(dev)
                if first_free is None:
                    first_free = free_gb
                # Fit check: keep enough free VRAM for every loaded worker (plus
                # this one) to hold its generation activation.
                if is_cuda and free_gb is not None and slot > 0:
                    need = (loaded + 1) * act_headroom_gb
                    if free_gb < need:
                        logger.warning(f"[{dev}] fit check: ~{need:.1f} GB free needed to run "
                                       f"{loaded + 1} workers but only {free_gb:.1f} GB free — "
                                       f"stopping at {loaded} worker(s) on this card.")
                        break
                logger.info(f"worker {wid} → {dev}: loading replica…")
                try:
                    model = load_model(dev)
                except Exception as exc:                       # graceful load-time OOM
                    if _satellite_asleep(exc):
                        # 🔴 A satellite that is not running is the DOCUMENTED steady state
                        # (§11.4) — the console gets closed whenever that machine's owner wants
                        # the card back — and `remote_model()`'s docstring already claims this
                        # is handled "the same way as a card that will not load: log, skip,
                        # carry on with what fits". It was not. `SatelliteUnreachable` is not an
                        # OOM, so it re-raised out of the pool build and took the LOCAL cards
                        # with it: every render on the box failed while the satellite slept,
                        # each attempt first loading and then discarding the local replicas.
                        satellites_asleep.append(dev)
                        logger.warning(f"[{dev}] {exc} — skipping it; rendering on the devices "
                                       f"that answered.")
                        break
                    if not _is_oom(exc):
                        raise
                    f2, t2 = device_mem_gb(dev)
                    where = f"({f2:.1f} GB free of {t2:.1f} GB) " if f2 is not None else ""
                    logger.warning(f"[{dev}] OUT OF MEMORY loading worker {slot} {where}"
                                   f"— dropping it and the rest on this card; continuing on what fits.")
                    if is_cuda:
                        torch.cuda.empty_cache()
                    break
                self._models[wid] = model
                self.workers.append({"id": wid, "device": dev})
                loaded += 1
                if is_cuda:
                    nf, nt = device_mem_gb(dev)
                    if loaded == 1 and first_free is not None and nf is not None:
                        foot = max(first_free - nf, 0.0)
                        logger.info(f"worker {wid} → {dev}: loaded (~{foot:.1f} GB incl. one-time "
                                    f"runtime; {nf:.1f}/{nt:.1f} GB card free)")
                    else:
                        logger.info(f"worker {wid} → {dev}: loaded ({nf:.1f}/{nt:.1f} GB card free)")
                wid += 1
            if loaded == 0:
                logger.warning(f"[{dev}] no workers loaded — excluding this card.")
        if not self.workers:
            if satellites_asleep:
                # The satellite-only selection, with the satellite off. Saying "out of memory?"
                # here sends the reader to the wrong machine entirely.
                raise VocalisError(
                    f"WorkerPool: the only device(s) selected are satellites and none answered "
                    f"({', '.join(satellites_asleep)}). Start the satellite on that machine, or "
                    f"tick one of this machine's own cards in ⚙ Settings ▸ Devices.")
            raise VocalisError("WorkerPool: no workers could be loaded on any device "
                             "(out of memory?). Use fewer --workers, --gpus cpu, or free VRAM.")
        self.sr = self._models[self.workers[0]["id"]].sr
        self._init_pool_state()

    def __len__(self):
        return len(self.workers)

    def _drop_worker(self, wid: int) -> None:
        """Permanently remove a worker from the pool and free its replica. Called
        when a worker OOMs or its satellite becomes unreachable at runtime.
        Removing it from self.workers means the next run_chunks() won't resurrect
        it (fixes the 'dropped worker reappears' bug)."""
        with self._lock:
            self.workers = [w for w in self.workers if w["id"] != wid]
            model = self._models.pop(wid, None)
        del model                        # release our ref; the worker frame drops its own on return
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def replicas(self) -> list:
        """[(device, model), …] — the loaded replicas, for request-level pools
        (Nomi §4.3) that grab a whole model per request rather than dispatching
        chunks."""
        return [(w["device"], self._models[w["id"]]) for w in self.workers]

    MAX_CHUNK_ATTEMPTS = 3   # non-OOM retries for a single chunk before giving up on it

    def _init_pool_state(self):
        """Runtime scheduling state for the shared job queue. Kept separate from
        __init__ so tests that build a pool via __new__ (fake workers, no model
        load) can set it up too. Worker threads start lazily on first submit."""
        self._jobq          = _queue.PriorityQueue()
        self._seq           = itertools.count()
        self._start_lock    = threading.Lock()
        self._started       = False
        self._threads       = []
        self._shutdown_flag = False

    def _ensure_started(self):
        """Spawn the persistent worker threads on first use — one per replica, each
        pinned to its device inside a loop-scoped autocast region that keeps torch's
        weight-cast cache alive across chunks. Idempotent."""
        with self._start_lock:
            if self._started:
                return
            self._threads = [threading.Thread(target=self._worker_entry, args=(wk,), daemon=True)
                             for wk in list(self.workers)]
            for t in self._threads:
                t.start()
            self._started = True

    def _worker_entry(self, worker):
        """BOUNDARY 3 of 5 — the WorkerPool worker thread (SPEC_5_0_M5 §6).

        A persistent daemon thread. If a VaultAuthError kills it, the pool silently loses a
        worker: the batch it was serving never completes, `batch.progress` is never set, and
        the render hangs forever with no error anywhere. That is precisely the "hang becomes
        the normal UX" failure the boundary list exists to prevent.

        The import is DEFERRED on purpose: vault.py does `from tts_utils import atomic_replace`,
        so a module-level `import vault` here would be a circular import. This is the one
        boundary that cannot import its own exception at the top of the file.
        """
        from vault import VaultAuthError

        try:
            with _autocast_ctx():              # loop-scoped autocast (see note in run_chunks/_worker_loop)
                self._worker_loop(worker)
        except VaultAuthError as exc:          # BY NAME
            # Poison the pool so the next get_pool() rebuilds rather than handing out a pool
            # that is quietly one worker short, and let the waiting batch fail loudly instead
            # of waiting on a chunk that will never arrive. Nothing is deleted.
            self.poisoned = True
            logger.critical(f"pool worker {worker.get('id')}: VAULT AUTHENTICATION FAILED — {exc}")
            logger.critical("The worker is stopped and the pool is poisoned. Nothing was deleted.")
            raise

    def _worker_loop(self, worker):
        """A persistent worker: pull the highest-priority job from the shared queue,
        generate it on this worker's replica, deliver via the batch's save callback,
        repeat. Exits on a shutdown sentinel or when this worker is OOM-dropped."""
        from vault import VaultAuthError   # deferred: vault imports tts_utils -> circular at module level
        import torch
        dev = worker["device"]
        with self._lock:
            model = self._models.get(worker["id"])
        if model is None:                      # already dropped by an earlier run — nothing to do
            return
        if dev.startswith("cuda"):
            torch.cuda.set_device(int(dev.split(":")[1]))

        while True:
            _prio, _seq, job = self._jobq.get()
            if job is _SHUTDOWN:
                return
            batch = job.batch
            index, text = job.index, job.text
            # A canceled batch's remaining chunks are skipped (not generated); a
            # chunk already mid-generation isn't preempted.
            if batch.cancel.is_set():
                with batch.lock:
                    batch.pending -= 1
                batch.progress.set()
                continue

            # 6.2-m3 — a satellite that can take a LIST gets one: drain this worker's queue of
            # the chunks it would otherwise have run one at a time and submit them together.
            # Gated on the CAPABILITY (never the version), and only ever for plain _Jobs of THIS
            # batch — a _StreamJob has a runner of its own and a different batch has different
            # params. A slice of one is left on the serial path below: batched-of-one measured
            # 0.98x, so there is nothing to win and the serial path is the tested one.
            # 11.2 — and never more than `st_max_batch` of them when the listener is waiting on
            # this very audio. A cap of 1 leaves the job on the serial path below, which is the
            # pre-6.2 behavior exactly: `_drain_batch_items` would return nothing anyway, and
            # saying so here keeps the capacity round trip off the interactive path too.
            cap = self._batch_cap(model, batch)
            if self._batching_ok(model) and not isinstance(job, _StreamJob) and cap > 1:
                items = self._drain_batch_items(job, cap)
                mates = self._trim_to_capacity(model, job, items)
                if mates:
                    if self._run_batch(worker, model, dev, [job] + mates):
                        return                 # this worker was dropped — exit the thread
                    continue

            buf     = io.StringIO()
            w       = len(str(batch.total))
            # `preview` is for the BROWSER only — it rides the SSE chunk_start/chunk_done
            # events below, which is an authenticated channel showing the user their own
            # text. It must NOT go in `label`: label is written into `buf`, and buf is
            # replayed WHOLESALE into loguru on the success path (see logger.info(buf...)
            # further down), so a preview here put 60 chars of the user's words into
            # logs/vocalis.log for every chunk of every render — book, Playground, ST and
            # Nomi alike. The buffer LOOKS like an SSE-only channel. It is not.
            preview = text[:60] + ("..." if len(text) > 60 else "")
            label   = f"  [{dev}] chunk [{index + 1:>{w}}/{batch.total}]  ({len(text)} chars)"
            with batch.lock:
                batch.inflight += 1
            if batch.on_event:
                batch.on_event({"type": "chunk_start", "device": dev, "chapter": batch.chapter,
                                "chunk": index, "total": batch.total, "preview": preview})
            # The ENTIRE per-chunk body — generation AND save AND emission — is
            # guarded: a failure in save() (disk full, backend error) must not
            # silently kill the worker and leave a hole that later crashes the concat.
            _GEN_CANCEL.event = batch.cancel   # token loop aborts mid-chunk on cancel
            try:
                if isinstance(job, _StreamJob):
                    # Streaming chunk: the runner pumps audio windows to its consumer
                    # itself (heartbeat = progress pulse per window, so the stall
                    # watchdog sees window-level progress) and returns the full wav
                    # for the normal save/banking path.
                    wav, chars, dt = job.runner(model, batch.progress.set)
                else:
                    def make_fn(c, m=model):
                        return make_generate_fn(m, c, batch.params.voice,
                                                batch.params.exaggeration, batch.params.cfg,
                                                batch.params.temperature)

                    wav, chars, dt, _ = generate_with_retry(text, make_fn, self.sr, label=label, out=buf)
                if batch.save:
                    batch.save(index, wav, self.sr)
            except GenerationCanceled:
                # Cancel landed mid-generation: the partial audio is discarded
                # (nothing was saved — the chunk file only lands after a full
                # generate), the chunk resolves, and the batch drains instantly.
                with batch.lock:
                    batch.inflight -= 1
                    batch.pending  -= 1
                if batch.on_event:
                    batch.on_event({"type": "log",
                                    "line": f"[{dev}] chunk {index + 1} aborted mid-generation"})
                batch.progress.set()
                continue
            except VaultAuthError as exc:       # BOUNDARY 3 of 5 — BY NAME
                # THE HANG LIVES HERE. `except Exception` below CANNOT see a VaultAuthError
                # (it is a BaseException, deliberately), so without this clause it escapes the
                # per-chunk guard with batch.inflight and batch.pending STILL INCREMENTED --
                # and collect() then waits forever on a chunk that will never arrive. A render
                # that hangs with no error anywhere is exactly the "hang becomes the normal UX"
                # failure the five boundaries exist to prevent.
                #
                # Under M6/M7 this is a live path: batch.save() becomes a vault WRITE.
                #
                # Resolve the chunk through the pool's own failure mechanism so the batch
                # drains, and hand collect() the exception ITSELF so it can re-raise it by
                # type. Do NOT kill the worker: the pool is long-lived and shared, and a
                # locked vault is not a reason to permanently degrade it.
                with batch.lock:
                    batch.inflight -= 1
                    batch.pending  -= 1
                    batch.failed[index] = repr(exc)
                    batch.vault_error = exc
                batch.progress.set()             # wake collect() NOW instead of at the watchdog
                logger.critical(f"[{dev}] chunk {index + 1}: VAULT AUTHENTICATION FAILED — {exc}")
                logger.critical("The render is stopped. Nothing has been deleted or regenerated.")
                continue
            except Exception as exc:            # OOM / CUDA error / save failure / etc.
                with batch.lock:
                    batch.inflight -= 1
                if self._handle_job_error(worker, job, exc, dev, buf):
                    return                       # this worker OOMed and was dropped — exit the thread
                continue
            finally:
                _GEN_CANCEL.event = None

            with batch.lock:
                batch.inflight -= 1
                batch.chars   += chars
                batch.time    += dt
                batch.pending -= 1
            # 5.3-m4: feed the streaming buffer governor its per-device rate (design §3.3).
            # This is the one place a real render's audio length and wall time are both in
            # hand, and a mixed pool has no single rate — different devices can have
            # substantially different render rates, so one constant derives a floor for a machine that does
            # not exist. Guarded end to end: a bookkeeping slip must never fail a book.
            try:
                from vocalis_streaming import record_render_rate
                record_render_rate(dev, wav.shape[-1] / self.sr, dt,
                                   streaming=isinstance(job, _StreamJob))
            except Exception:                             # noqa: BLE001
                pass
            logger.info(buf.getvalue().rstrip("\n"))       # loguru is thread-safe
            if batch.on_event:
                audio_s = wav.shape[-1] / self.sr
                tokens  = int(audio_s * _S3_TOKEN_RATE)
                pct     = tokens / _TOKEN_CAP * 100
                mark    = "✓" if pct < 80 else ("⚠" if pct < 90 else "✗")
                batch.on_event({"type": "chunk_done", "device": dev, "chapter": batch.chapter,
                                "chunk": index, "total": batch.total, "preview": preview,
                                "stats": {"s": round(dt, 1), "cps": round(chars / dt) if dt else 0,
                                          "tokens": tokens, "pct": round(pct), "mark": mark,
                                          "render": round(audio_s / dt, 1) if dt else 0},
                                "log": buf.getvalue().rstrip("\n")})
            batch.progress.set()

    # ── 6.2-m3: several chunks in one submission ─────────────────────────────

    def _batching_ok(self, model) -> bool:
        """Whether this worker may hand its satellite a LIST of chunks.

        The capability, never the version string — a satellite is upgraded independently of the
        server that drives it. A satellite that advertises batching keeps receiving batches after
        a failed request; the per-chunk retry budget reports a persistent failure instead of
        silently reducing throughput for the rest of the book.
        """
        return bool(getattr(model, "can_batch", False))

    @staticmethod
    def _batch_cap(model, batch) -> int:
        """Return the maximum number of chunks this worker may submit for the batch. Use
    `batch_slice` for local work and the satellite's configured cap for live SillyTavern
    speech. Apply the cap before sending a remote submission: the satellite renders a
    submission as a group, so a smaller bounded pass limits how long later chunks wait. Use
    `getattr` to support remote-model fakes and retain the local fallback.
    """
        slice_ = max(1, int(getattr(model, "batch_slice", 1) or 1))
        if not getattr(batch, "st_speech", False):
            return slice_
        return max(1, min(slice_, int(getattr(model, "st_batch_slice", slice_) or 1)))

    def _drain_batch_mates(self, job, cap: int) -> list:
        """Take up to `cap - 1` further queued jobs of the SAME batch, in queue order.

        Stops at the first thing that is not one — a shutdown sentinel, a _StreamJob, or another
        caller's batch — and puts it back EXACTLY as it came off, priority and sequence number
        intact. That is what keeps an INTERACTIVE chunk arriving mid-drain ahead of the book we
        are serving, and it is why the item is re-queued whole rather than through `_requeue`,
        which would move it to the back of its tier.

        The cap is what stops one worker swallowing a whole section and starving the others: the
        queue is shared, and a book submits every chunk of a section at once.
        """
        return [it[2] for it in self._drain_batch_items(job, cap)]

    def _drain_batch_items(self, job, cap: int) -> list:
        """`_drain_batch_mates`, but returning the QUEUE ITEMS — (priority, seq, job) — rather
        than the jobs themselves, so a caller that ends up taking fewer than it drained can put
        the surplus back exactly as it came off. See `_trim_to_capacity`."""
        items = []
        while len(items) + 1 < max(1, int(cap)):
            try:
                item = self._jobq.get_nowait()
            except _queue.Empty:
                break
            other = item[2]
            if (other is _SHUTDOWN or isinstance(other, _StreamJob)
                    or not self._may_travel_together(job, other)):
                self._jobq.put(item)
                break
            items.append(item)
        return items

    def _drain_top_up(self, ref, want: int) -> list:
        """Take up to `want` additional queue items that may travel with the satellite's current
    work, stopping at the first incompatible item. The satellite supplies this capacity;
    fewer items means the queue has no more eligible work, not that the requested count
    should be inferred or retried. Unlike `_drain_batch_items`, `want` counts only
    additional items because the current work is already on the satellite.
    """
        items = []
        while len(items) < max(0, int(want)):
            try:
                item = self._jobq.get_nowait()
            except _queue.Empty:
                break
            other = item[2]
            if (other is _SHUTDOWN or isinstance(other, _StreamJob)
                    or not self._may_travel_together(ref, other)):
                self._jobq.put(item)
                break
            items.append(item)
        return items

    @staticmethod
    def _may_travel_together(job, other) -> bool:
        """Return whether `other` may share a submission with `job`. Chunks must have equal
    generation parameters, priority, and the identical cancellation event. Parameter
    equality permits one request configuration; priority preserves interactive ordering;
    event identity prevents canceling one section from canceling another.
    """
        a, b = job.batch, other.batch
        if a is b:
            return True
        return (a.params == b.params
                and a.priority == b.priority
                and a.cancel is b.cancel
                # The speech flag must match because the submission cap is selected from its head job.
                and a.st_speech == b.st_speech)

    def _requeue_items(self, items) -> None:
        """Put drained items back EXACTLY as they came off — priority and sequence intact — so
        they keep their place in the queue rather than moving to the back of their tier."""
        for it in items:
            self._jobq.put(it)

    def _trim_to_capacity(self, model, job, items) -> list:
        """Ask a batching device for its current capacity, keep that many queued items, and requeue
    the rest. The capacity is a snapshot and may be stale by dispatch time, so the decode
    watchdog remains necessary. A zero response means the remote capacity request failed;
    retain the drained items so normal rendering can report the failure and resolve them.
    """
        if not items:
            return []
        lengths = [len(job.text)] + [len(it[2].text) for it in items]
        take = int(model.capacity(lengths) or 0)
        if take <= 0:
            # 🔴 NO ANSWER EARNS NO DEPTH. 0 means the satellite is stopped or the request
            # failed, and this is the path where least is known about the card — so it falls
            # back to the published ceiling exactly as it did before pipelining existed, rather
            # than inheriting a backlog sized for an answer that never came. The chunks are
            # already off the shared queue, so the surplus is requeued rather than dropped and
            # the ordinary render path reports the failure a moment later.
            ceiling = int(getattr(model, "batch_slice", 0)) or len(lengths)
            if ceiling >= len(lengths):
                return [it[2] for it in items]
            keep = items[:max(0, ceiling - 1)]
            self._requeue_items(items[len(keep):])
            return [it[2] for it in keep]
        # Pull a capacity-bounded pass at a time; do not reserve future work across workers.
        if take >= len(lengths):
            return [it[2] for it in items]
        keep = items[:max(0, take - 1)]        # `job` is already the first member of the pass
        self._requeue_items(items[len(keep):])
        return [it[2] for it in keep]

    def _run_batch(self, worker, model, dev, jobs) -> bool:
        """Render several chunks of one batch on a satellite (6.2-m3), topping the card up until
        it has nothing held back (7.3.17).

        Returns True if this worker was dropped and its thread must exit.

        🔴 THE CARD IS NEVER LEFT WITH A SHORT PASS TO RENDER. A pass of two costs nearly what a
        pass of twenty does, so a submission that ends on a remainder throws most of a pass away —
        which is what made every chapter tail collapse to single-digit batches. Instead the card
        keeps the remainder in its own memory, names it in the trailer along with how many more it
        has room for, and this loops: drain that many, send them, and the card renders the lot as
        one pass. It ends when the card holds nothing — either because a round filled it, or
        because the queue ran dry and the last call told it no more was coming, which makes it
        render what it has.

        Each chunk is banked THE MOMENT IT LANDS, because the satellite splits the submission
        into as many passes as its card affords and returns each one as it finishes: a section's
        early chunks are final while its later ones are still rendering, and a failure late in
        the run does not discard them.

        §7.3, the requirements that survive batching, each in one place here:
          * the truncation re-split is PER SEQUENCE — `retries` below, run after the reply
            closes (a nested render on this satellite would deadlock on the replica lock the
            reply itself is holding);
          * the quality zones are PER CHUNK — `report_generated`, the same call the serial path
            makes;
          * an MD5 cache hit never reaches the queue at all, so it cannot consume a slot: the
            book, bulk and playground paths all submit only their MISSING chunks;
          * a cancel banks nothing further and retries nothing — the satellite abandons the pass
            it is in, and a partial handed back as real would poison every resume of the render.
        """
        from vault import VaultAuthError   # deferred: vault imports tts_utils -> circular

        # 🔴 THE WIRE ID IS UNIQUE FOR THE LIFE OF THE POOL — not the chunk index, and no longer
        # the position in the submission either. The index collides because a submission may span
        # sections and every section numbers its chunks from zero: keyed on it, two sections'
        # chunk 0 collide in `left` and one is silently banked as the other. The POSITION then
        # collides for the same reason one step later — a chunk the card is holding from call 1
        # keeps its id into call 2, where position 0 is somebody else. `next(self._seq)` is the
        # counter the queue already uses as its tiebreaker and is monotonic, so an id is never
        # reused and `left` stays order-independent exactly as before.
        #
        # `first` is only for what the drain predicate has already proved identical across the
        # submission: params, priority and the cancel Event. Everything that varies per section —
        # the lock, the counters, the save callback, the chapter and its total — is read off
        # `job.batch`, never off this.
        first = jobs[0].batch
        # 11.2 — 0 for everything that is NOT live SillyTavern speech, which keeps 7.3.17's rule
        # intact where it still applies: for a book the number in the trailer is the card's own
        # and nothing here second-guesses it.
        st_cap = self._batch_cap(model, first) if first.st_speech else 0
        left, bufs, previews, cids = {}, {}, {}, {}
        sent_total = 0

        def enroll(js) -> list:
            """Give each job a wire id, count it in flight, and tell the browser it started.
            Returns `[(cid, job), …]`. Called once per round of the chain below, because the
            top-up brings new chunks into a submission that is already under way."""
            nonlocal sent_total
            out = []
            for j in js:
                cid = str(next(self._seq))
                left[cid], bufs[cid], cids[id(j)] = j, io.StringIO(), cid
                # `preview` is for the BROWSER only and must NOT go into `label` — see the note in
                # _worker_loop: label is written into buf, and buf is replayed WHOLESALE into loguru.
                previews[cid] = j.text[:60] + ("..." if len(j.text) > 60 else "")
                out.append((cid, j))
                sent_total += 1
                with j.batch.lock:
                    j.batch.inflight += 1
                if j.batch.on_event:
                    j.batch.on_event({"type": "chunk_start", "device": dev,
                                      "chapter": j.batch.chapter, "chunk": j.index,
                                      "total": j.batch.total, "preview": previews[cid]})
            return out

        def label_for(j, size) -> str:
            """Written when the chunk LANDS, not when it was sent — a held chunk renders in a
            later, bigger pass than the one it was submitted with, and `[batch of N]` is the log's
            only record of how well the card was actually fed."""
            w = len(str(j.batch.total))
            return (f"  [{dev}] chunk [{j.index + 1:>{w}}/{j.batch.total}]  "
                    f"({len(j.text)} chars)  [batch of {size}]")

        retries, dropped, canceled, failure = [], False, False, None
        _GEN_CANCEL.event = first.cancel
        try:
            # A satellite may retain chunks between submissions. Bank completed results, top up the
            # held remainder with new work, and continue until no more work is sent. A final request
            # sets `more_available=False` so the satellite renders its held tail.
            outgoing, holding = list(jobs), []
            while True:
                sending = enroll(outgoing)
                n = len(sending) + len(holding)
                # There is more of this batch to come if there is anything queued at all — the
                # predicate cannot be tested without dequeuing, so this deliberately says yes to a
                # queue holding only work this card cannot take. The flush above is what makes
                # that safe. With nothing new to send this is the flush itself, hence `sending`.
                more = bool(sending) and not self._jobq.empty()
                # A full speech-capped submission is terminal even when the queue is nonempty; tell the
                # satellite to render its held work rather than wait for a top-up it cannot take.
                if st_cap and len(sending) + len(holding) >= st_cap:
                    more = False
                t0 = t_prev = time.time()
                landed, samples = 0, 0
                try:
                    for cid, wav in model.generate_batch(
                            [(cid, j.text) for cid, j in sending],
                            audio_prompt_path=voice_for_model(first.params.voice),
                            exaggeration=first.params.exaggeration, cfg_weight=first.params.cfg,
                            temperature=first.params.temperature,
                            more_available=more, held=holding):
                        now, cid = time.time(), str(cid)
                        # `wall` accounts elapsed time per chunk. `share` distributes submission time across
                        # returned chunks because a batch response delivers them together.
                        #
                        # Divide elapsed time by the full submission size, not the number landed so far. A batch
                        # returns chunks together; using the running count would make early chunks appear slower.
                        #
                        # `n` is this ROUND's submission — what was sent plus what the card was
                        # already holding, which is exactly what it renders. The server asks
                        # /satellite/capacity what the card can take before the first round and
                        # the card names its own appetite for every round after, so the pass size
                        # is known before the first chunk lands.
                        # ⚠️ If the satellite still splits — its free VRAM fell between the answer
                        # and the pass — later chunks read low rather than absurd, and the
                        # once-per-round aggregate below is the figure that is always exact.
                        wall, t_prev = now - t_prev, now
                        landed += 1
                        share = (now - t0) / max(1, n)
                        job = left.pop(cid, None)
                        if job is None:
                            # Not fatal, and loud: the reply names chunks by the ids we sent, so
                            # an id we never sent means the two sides disagree about what a batch
                            # IS. A stale chunk from an abandoned chain reaches here too, which is
                            # what the `held` handshake on the request exists to prevent.
                            logger.error(f"[{dev}] a batch reply named chunk {cid!r}, which was "
                                         f"not in the submission — ignoring it")
                            continue
                        samples += int(wav.shape[-1])
                        _make_emit(bufs[cid])(label_for(job, n))
                        if report_generated(job.text, wav, self.sr, share, out=bufs[cid]):
                            retries.append((job, wall))  # re-split AFTER the reply is consumed
                            continue
                        if self._bank_batched(worker, job.batch, dev, job, wav, share,
                                              bufs[cid], previews[cid], wall=wall):
                            dropped = True
                    took = time.time() - t0
                    if landed and took > 0:
                        # The aggregate is the figure that means something for a batch, and it is
                        # the one the design's acceptance is stated in. Said once per round,
                        # where the per-chunk lines cannot say it.
                        audio_s = samples / self.sr
                        logger.info(f"[{dev}] batch of {n}: {audio_s:.1f}s of audio in "
                                    f"{took:.1f}s ({audio_s / took:.2f}x realtime)")
                except GenerationCanceled:
                    canceled = True
                except VaultAuthError as exc:           # BOUNDARY 3 of 5 — BY NAME
                    # `except Exception` below cannot see this (it is a BaseException,
                    # deliberately), and without this clause it would escape with
                    # `inflight`/`pending` still counted for every undelivered chunk — collect()
                    # then waits forever on chunks that will never arrive. Resolved below, by
                    # type, so collect() re-raises a KEY failure as itself rather than as "some
                    # chunks failed".
                    failure = exc
                except Exception as exc:                # noqa: BLE001
                    failure = exc

                if canceled or failure is not None:
                    break

                # 🔴 WHAT THE CARD KEPT, AND HOW MUCH MORE IT WANTS. Anything named here is still
                # in `left` on purpose: its `inflight` and `pending` stay counted, and it must NOT
                # reach the undelivered path below — a chunk sent and not returned is treated as a
                # failure there, so held ids must be carried into the next submission instead.
                trailer = getattr(model, "last_trailer", None) or {}
                holding = [str(c) for c in (trailer.get("held") or ()) if str(c) in left]
                if not holding:
                    break
                if not more:
                    # It held without a license. Fall through to the undelivered path, which
                    # retries those chunks — and the next chain names an
                    # empty `held`, so the card drops them rather than prepending them to it.
                    logger.error(f"[{dev}] the satellite held {len(holding)} chunk(s) after being "
                                 f"told no more were coming — treating them as undelivered")
                    break
                if first.cancel.is_set():
                    # Nothing more goes out for a canceled batch, and what the card is holding is
                    # resolved as canceled below rather than rendered for nobody.
                    canceled = True
                    break
                # Exactly what it asked for. It sized that number the same way it sizes the pass
                # itself, so there is nothing to second-guess here — and if the queue cannot fill
                # the order, the short answer becomes the flush on the next turn of the loop.
                want = max(1, int(trailer.get("want") or 1))
                # 🔴 11.2 — EXCEPT FOR THE CONFIGURED CEILING, WHICH THE CARD CANNOT KNOW ABOUT. The
                # top-up is the one place a submission can grow past the cap after the fact: the
                # card keeps a remainder and asks for room it genuinely has, and granting it would
                # rebuild the very pass of eight the setting exists to prevent. Minus what it is
                # already holding, because those rows are prepended to the next pass rather than
                # re-sent — held + granted is what it will decode.
                #
                # ⚠️ A CLAMP TO ZERO IS SAFE AND IS NOT A HANG. `_drain_top_up(…, 0)` returns
                # nothing, so the next turn sends nothing, `more` is False, and the card is told
                # no more is coming — which is the flush that makes it render what it holds. That
                # is the same path a queue that ran dry takes.
                if st_cap:
                    want = max(0, min(want, st_cap - len(holding)))
                outgoing = [it[2] for it in self._drain_top_up(jobs[0], want)]

            n = sent_total
            if canceled:
                for job in left.values():
                    self._chunk_canceled(job.batch, dev, job, "the batch was canceled")
                left.clear()
                # 🔴 A DEFERRED RE-SPLIT IS NOT RESOLVED YET. A truncated chunk is popped out of
                # `left` at the top of the loop and parked in `retries`, so from here it is in
                # NEITHER collection — its `inflight` and `pending` are still counted. Dropping
                # the list without resolving them left `collect()` waiting on a chunk that could
                # never arrive: it takes the `inflight > 0` branch, blocks for the full
                # `stall_timeout_s` (900 s, or 7200 s if any worker is CPU), then raises "a worker
                # is likely wedged (hung GPU kernel)" AND sets `poisoned`, tearing down every
                # replica on the box. A cancel is not a wedged kernel, and it must not read as one.
                for job, _spent in retries:
                    self._chunk_canceled(job.batch, dev, job, "the batch was canceled")
                retries = []
            elif isinstance(failure, VaultAuthError):
                for job in left.values():
                    self._chunk_vault_failed(job.batch, dev, job, failure)
                left.clear()
            elif failure is not None or left:
                # The CHUNK numbers, not the wire ids — a submission may span sections, so the
                # position in it means nothing to a reader of the log.
                exc = failure if failure is not None else RuntimeError(
                    f"the batch ended cleanly without chunk(s) "
                    f"{sorted(j.index for j in left.values())} — the satellite reported success "
                    f"and did not send them")
                # A failed submission affects its undelivered chunks, but does not prove the device lacks
                # batching capability. The normal retry budget decides whether work continues.
                # The normal retry budget below decides whether the render can continue.
                logger.error(f"[{dev}] batch of {n} failed after delivering {n - len(left)}: "
                             f"{exc!r}")
                for cid, job in list(left.items()):
                    with job.batch.lock:
                        job.batch.inflight -= 1
                    if dropped:
                        # One dead worker can own many undelivered chunks. Once it has been
                        # removed, none of those chunks should spend a retry on that device.
                        self._requeue(job)
                        job.batch.progress.set()
                    elif self._handle_job_error(worker, job, exc, dev, bufs[cid]):
                        dropped = True
                left.clear()
            for job, spent in retries:
                cid = cids[id(job)]
                if job.batch.cancel.is_set():
                    self._chunk_canceled(job.batch, dev, job, "the batch was canceled")
                    continue
                if dropped:
                    # A truncated chunk from an earlier reply still needs its full retry,
                    # but the satellite that delivered it can no longer run the re-split.
                    with job.batch.lock:
                        job.batch.inflight -= 1
                    self._requeue(job)
                    job.batch.progress.set()
                    continue

                def make_fn(c, m=model):
                    return make_generate_fn(m, c, first.params.voice,
                                            first.params.exaggeration, first.params.cfg,
                                            first.params.temperature)
                try:
                    wav, chars, dt, _ = resplit_and_retry(job.text, make_fn, self.sr,
                                                          spent_s=spent, out=bufs[cid])
                except GenerationCanceled:
                    self._chunk_canceled(job.batch, dev, job, "aborted mid-generation")
                    continue
                except VaultAuthError as exc:           # BOUNDARY 3 of 5 — BY NAME
                    self._chunk_vault_failed(job.batch, dev, job, exc)
                    continue
                except Exception as exc:                # noqa: BLE001
                    with job.batch.lock:
                        job.batch.inflight -= 1
                    if self._handle_job_error(worker, job, exc, dev, bufs[cid]):
                        dropped = True
                    continue
                if self._bank_batched(worker, job.batch, dev, job, wav, dt, bufs[cid],
                                      previews[cid], chars=chars):
                    dropped = True
        finally:
            _GEN_CANCEL.event = None
        return dropped

    def _bank_batched(self, worker, batch, dev, job, wav, dt, buf, preview, chars=None,
                      wall=None) -> bool:
        """Save one chunk that arrived in a batch reply and resolve it. True if the worker was
        dropped.

        `dt` is what the reader sees and `wall` is what the books add up — see the two-times note
        in `_run_batch`. `wall=None` means they are the same figure, which is what the truncation
        retries pass, because those really did take their own time.

        ⚠️ **`record_render_rate` is deliberately NOT called here**, and that is not an omission.
        The governor keeps a window of the last 8 observations per device and takes the SLOWEST,
        which is only meaningful while each observation is one chunk's own render time. A batched
        pass lands several chunks back to back, so the wall time falls on whichever closed the
        pass and the rest read as instant — eight of those flush the window and the "slowest"
        becomes a few thousand times realtime, which would have the streaming governor buffer
        almost nothing. The rate that matters for streaming is measured on the streaming path,
        which is never batched: a _StreamJob has its own runner and is excluded from the drain.
        """
        from vault import VaultAuthError   # deferred: vault imports tts_utils -> circular
        try:
            if batch.save:
                batch.save(job.index, wav, self.sr)
        except VaultAuthError as exc:                   # BOUNDARY 3 of 5 — BY NAME
            self._chunk_vault_failed(batch, dev, job, exc)
            return False
        except Exception as exc:                        # noqa: BLE001
            with batch.lock:
                batch.inflight -= 1
            return self._handle_job_error(worker, job, exc, dev, buf)

        with batch.lock:
            batch.inflight -= 1
            batch.chars   += len(job.text) if chars is None else chars
            batch.time    += dt if wall is None else wall
            batch.pending -= 1
        logger.info(buf.getvalue().rstrip("\n"))        # loguru is thread-safe
        if batch.on_event:
            audio_s = wav.shape[-1] / self.sr
            tokens  = int(audio_s * _S3_TOKEN_RATE)
            pct     = tokens / _TOKEN_CAP * 100
            mark    = "✓" if pct < 80 else ("⚠" if pct < 90 else "✗")
            batch.on_event({"type": "chunk_done", "device": dev, "chapter": batch.chapter,
                            "chunk": job.index, "total": batch.total, "preview": preview,
                            "stats": {"s": round(dt, 1), "cps": round(len(job.text) / dt) if dt else 0,
                                      "tokens": tokens, "pct": round(pct), "mark": mark,
                                      "render": round(audio_s / dt, 1) if dt else 0},
                            "log": buf.getvalue().rstrip("\n")})
        batch.progress.set()
        return False

    def _chunk_canceled(self, batch, dev, job, why: str) -> None:
        """Resolve a chunk that was canceled: nothing is banked, nothing is retried."""
        with batch.lock:
            batch.inflight -= 1
            batch.pending  -= 1
        if batch.on_event:
            batch.on_event({"type": "log",
                            "line": f"[{dev}] chunk {job.index + 1}: {why}"})
        batch.progress.set()

    def _chunk_vault_failed(self, batch, dev, job, exc) -> None:
        """Resolve a chunk killed by a locked vault — BOUNDARY 3 of 5, batched half.

        The exception ITSELF goes on the batch (not a repr) so collect() re-raises it by type;
        flattening it into "a chunk failed" is precisely what boundary 2 exists to prevent, and
        it is the difference between "the key is gone" and "re-render that chunk"."""
        with batch.lock:
            batch.inflight -= 1
            batch.pending  -= 1
            batch.failed[job.index] = repr(exc)
            batch.vault_error = exc
        logger.critical(f"[{dev}] chunk {job.index + 1}: VAULT AUTHENTICATION FAILED — {exc}")
        logger.critical("The render is stopped. Nothing has been deleted or regenerated.")
        batch.progress.set()

    def _requeue(self, job):
        """Put a job back on the shared queue (retry / OOM reassignment) at its
        batch's priority with a fresh sequence number (back of its priority tier)."""
        self._jobq.put((job.batch.priority, next(self._seq), job))

    def _handle_job_error(self, worker, job, exc, dev, buf) -> bool:
        """Resolve a failed chunk (mirrors 2.0 run_chunks failure isolation):
          * OOM or an unreachable satellite with a local worker available → requeue
                    the chunk for a survivor AND permanently drop this worker;
                   returns True (the worker thread must exit). Does NOT consume the
                   chunk's non-OOM retry budget.
          * non-OOM → retry up to MAX_CHUNK_ATTEMPTS on any survivor; on the final
                   attempt, record it failed and resolve the job. Returns False.
        """
        batch = job.batch
        index = job.index
        is_oom = _is_oom(exc)
        # A connection timeout is a device failure, not a bad text chunk. Keep the
        # existing retry path for a satellite-only pool, even with several remote
        # devices: it may recover during those attempts. Only a selected local
        # worker establishes the fallback this render can keep using.
        with self._lock:
            satellite_failed_over = (_satellite_asleep(exc) and
                                     any(w["device"] != dev and
                                         (w["device"] == "cpu" or
                                          w["device"].startswith("cuda:"))
                                         for w in self.workers))
        with batch.lock:
            batch.errs.append((dev, index, repr(exc)))
        free_gb, total_gb = device_mem_gb(dev)
        where = f" ({free_gb:.1f} GB free of {total_gb:.1f} GB)" if free_gb is not None else ""

        # A stream job is never requeued (OOM or not): part of its audio may already
        # be on the wire, and a re-run would replay it. Fail it immediately; on OOM
        # the worker is still dropped.
        if isinstance(job, _StreamJob):
            with batch.lock:
                batch.failed[index] = repr(exc)
                batch.pending -= 1
            msg = f"[{dev}] ERROR on streaming chunk {index + 1}{where}: {exc!r} — stream aborted (no retry)."
            logger.error(msg)
            if batch.on_event:
                batch.on_event({"type": "chunk_failed", "device": dev, "chapter": batch.chapter,
                                "chunk": index, "reason": "stream_error", "message": repr(exc), "log": msg})
            batch.progress.set()
            if is_oom or satellite_failed_over:
                self._drop_worker(worker["id"])
                return True
            return False

        if is_oom or satellite_failed_over:
            self._requeue(job)                 # a survivor picks it up
            self._drop_worker(worker["id"])    # frees the replica; no resurrection
            reason = "OOM" if is_oom else "satellite_unreachable"
            msg = (f"[{dev}] {reason} on chunk {index + 1}{where}: {exc!r} — "
                   f"dropping this worker; its chunk was requeued for a survivor.")
            logger.warning(msg)
            if batch.on_event:
                batch.on_event({"type": "device_dropped", "device": dev, "chapter": batch.chapter,
                                "chunk": index, "reason": reason, "message": repr(exc), "log": msg})
            batch.progress.set()
            return True

        with batch.lock:
            n = batch.attempts.get(index, 0) + 1
            batch.attempts[index] = n
        if n < self.MAX_CHUNK_ATTEMPTS:
            # Non-OOM: a single bad chunk must not tear the pool down. Retry it (TTS
            # is non-deterministic — a re-roll often works); the worker stays alive.
            self._requeue(job)
            logger.warning(f"[{dev}] ERROR on chunk {index + 1}{where}: {exc!r} — "
                           f"retry {n}/{self.MAX_CHUNK_ATTEMPTS - 1}.")
            batch.progress.set()
            return False

        with batch.lock:
            batch.failed[index] = repr(exc)
            batch.pending -= 1
        msg = (f"[{dev}] ERROR on chunk {index + 1}{where} after {n} attempts: "
               f"{exc!r} — giving up on this chunk.")
        logger.error(msg)
        if batch.on_event:
            batch.on_event({"type": "chunk_failed", "device": dev, "chapter": batch.chapter,
                            "chunk": index, "reason": "error", "message": repr(exc), "log": msg})
        batch.progress.set()
        return False

    def _resolve_stall_timeout(self, stall_timeout_s):
        """Watchdog timeout: an explicit argument always wins; else 900 s, overridable
        by VOCALIS_STALL_TIMEOUT_S, and raised to 2 h if any worker is on CPU (where
        a single chunk can legitimately take >15 min)."""
        if stall_timeout_s is not None:
            return stall_timeout_s
        env_timeout = os.environ.get("VOCALIS_STALL_TIMEOUT_S")
        if env_timeout:
            try:
                return float(env_timeout)
            except ValueError:
                logger.warning(f"VOCALIS_STALL_TIMEOUT_S={env_timeout!r} is not a number — ignored")
        if any(wk["device"] == "cpu" for wk in self.workers):
            return 7200.0
        return 900.0

    def submit(self, items: list, params: GenParams, priority: int = BATCH, save=None,
               total: int = None, on_event=None, chapter=None, cancel=None,
               stream_runner=None, st_speech: bool = False):
        """Enqueue (chunk_index, chunk_text) items on the shared pool at `priority`
        (BATCH for book/playground, INTERACTIVE for /speak + SillyTavern). Returns a
        _Batch handle to wait on via collect(). save(index, wav, sr) is called from a
        worker thread as each chunk finishes (so it MUST be thread-safe).

        stream_runner — optional runner(model, heartbeat) -> (wav, chars, dt) for the
        FIRST item: that chunk renders via the caller's streaming function on the
        worker that dequeues it (3.0 streaming; see _StreamJob). Later items render
        normally and bank their audio via save().

        st_speech — this is live SillyTavern speech, so a satellite's batches are bounded by
        its `st_max_batch` setting (11.2). See `_Batch`."""
        self._ensure_started()
        batch = _Batch(params, priority, save,
                       total if total is not None else len(items),
                       on_event, chapter, cancel, st_speech=st_speech)
        with batch.lock:
            batch.pending = len(items)
        first = items[0][0] if items else None
        for index, text in items:
            if stream_runner is not None and index == first:
                job = _StreamJob(index, text, batch, stream_runner)
            else:
                job = _Job(index, text, batch)
            self._jobq.put((priority, next(self._seq), job))
        return batch

    def collect(self, batch, stall_timeout_s: float = None) -> tuple:
        """Wait for a submitted batch to finish. Returns (chars, seconds) for it.
        Raises RuntimeError if a chunk fails permanently, if all workers are lost
        with work still pending (OOM-drained pool), or on a stall (a chunk in-flight
        with no progress past the watchdog timeout — a wedged kernel; poisons the
        pool so a cached instance is rebuilt, never re-dispatched alongside it)."""
        stall_timeout_s = self._resolve_stall_timeout(stall_timeout_s)
        poll = min(1.0, max(0.05, stall_timeout_s))
        last = time.monotonic()
        while True:
            with batch.lock:
                pending, inflight = batch.pending, batch.inflight
            if pending <= 0:
                break
            if batch.progress.wait(poll):
                batch.progress.clear()
                last = time.monotonic()
                continue
            with self._lock:
                n_workers = len(self.workers)
            if n_workers == 0:
                raise RuntimeError(
                    f"no workers left to generate {pending} pending chunk(s) — every worker "
                    f"was dropped (out of memory?). Failed: {batch.failed or batch.errs}")
            if inflight > 0:
                if time.monotonic() - last > stall_timeout_s:
                    self.poisoned = True
                    raise RuntimeError(
                        f"WorkerPool stalled: no progress for {stall_timeout_s:.0f}s with a chunk "
                        f"in-flight and worker(s) still alive — a worker is likely wedged (hung GPU "
                        f"kernel). Aborting to avoid an indefinite hang.")
            else:
                # pending > 0 but nothing of ours is generating: our chunks are queued
                # behind higher-priority / other work — fair queuing, not a stall.
                last = time.monotonic()
        if batch.vault_error is not None:
            # Re-raise the VaultAuthError BY TYPE, ahead of the generic RuntimeError below.
            # Flattening it into a RuntimeError here would hand the job thread an ordinary
            # Exception and quietly defeat boundary 2 — the render would report "chunk failed"
            # and the caller would have no way to know a KEY, not a chunk, was the problem.
            raise batch.vault_error
        if batch.failed:
            raise RuntimeError(
                f"{len(batch.failed)} chunk(s) failed permanently after all retries. "
                f"Failed: {batch.failed or batch.errs}")
        return batch.chars, batch.time

    def submit_chunks(self, items: list, params: GenParams, save, total: int,
                      on_event=None, chapter=None, cancel=None):
        """Queue each `(index, text)` at batch priority and return its handle without waiting.
    Keeping later sections queued across section boundaries lets other workers take work
    while a satellite handles its current submission. Return `None` for empty `items`;
    `collect_chunks` interprets it as `(0, 0.0)`.
    """
        if not items:
            return None
        return self.submit(items, params, priority=BATCH, save=save, total=total,
                           on_event=on_event, chapter=chapter, cancel=cancel)

    def collect_chunks(self, batch, stall_timeout_s: float = None) -> tuple:
        """The COLLECT half of `run_chunks`. A None batch (nothing was submitted) is (0, 0.0),
        so a caller never has to special-case a section that resumed complete."""
        if batch is None:
            return 0, 0.0
        return self.collect(batch, stall_timeout_s=stall_timeout_s)

    def run_chunks(self, items: list, params: GenParams, save, total: int,
                   on_event=None, chapter=None, stall_timeout_s: float = None, cancel=None) -> tuple:
        """Generate every (index, text) in `items` at BATCH priority (book/playground),
        calling save(index, wav, sr) per finished chunk. Thin wrapper over the shared
        pool (submit + collect) preserving the 2.0 contract and failure isolation.

        ⚠️ Submit-and-collect in one call, so this SERIALIZES at its own boundary: nothing of
        the caller's is queued behind these chunks, and every worker goes idle as they drain.
        That is correct for a caller with nothing else to render (the playground, one chapter
        re-rendered on its own) and wrong for a book — see `submit_chunks`.

        Returns (chars_generated, seconds_spent). Raises RuntimeError if any chunk
        could not be generated, or on a stall."""
        return self.collect_chunks(
            self.submit_chunks(items, params, save, total,
                               on_event=on_event, chapter=chapter, cancel=cancel),
            stall_timeout_s=stall_timeout_s)

    def speak(self, text: str, params: GenParams, priority: int = INTERACTIVE,
              stall_timeout_s: float = None) -> tuple:
        """Generate a whole message and return (wav, sr). The message's chunks fan
        across all workers via the shared pool at `priority` (INTERACTIVE by default,
        so /speak and SillyTavern outrank batch book chunks) and are concatenated in
        index order. Returns (None, sr) for empty text. Raises on failure/stall —
        never returns partial audio."""
        import torch
        chunks = split_into_chunks(text)
        if not chunks:
            return None, self.sr
        results, rlock = {}, threading.Lock()

        def save(idx, wav, sr):
            with rlock:
                results[idx] = wav

        batch = self.submit([(i, c) for i, c in enumerate(chunks)], params,
                            priority=priority, save=save, total=len(chunks))
        self.collect(batch, stall_timeout_s=stall_timeout_s)
        combined = torch.cat([results[i] for i in range(len(chunks))], dim=-1)
        return combined, self.sr

    def shutdown(self):
        """Stop the persistent worker threads (one sentinel each, drained after any
        pending work) and free their replicas. Call when the cached pool is replaced
        or the model is unloaded, so worker threads and VRAM don't leak."""
        with self._start_lock:
            if not self._started:
                with self._lock:
                    self.workers, self._models = [], {}
                return
            threads = list(self._threads)
            self._shutdown_flag = True
        for _ in threads:
            self._jobq.put((BATCH + 100, next(self._seq), _SHUTDOWN))
        for t in threads:
            t.join(timeout=5.0)
        with self._lock:
            self.workers, self._models = [], {}


def render_messages_in_one_batch(pool, texts, params, cancel=None):
    """Every chunk of every message in ONE submission — the path that actually batches.

    Returns a list as long as `texts`: each message's samples as a 1-D float32 numpy array,
    or None where the submission did not deliver every chunk of that message.

    🔴 WHY THIS IS NOT `speak()` IN A LOOP. A message rendered on its own goes through
    `stream_message`, whose first chunk is a `_StreamJob` — and `_worker_loop` excludes those
    from batching by design, so the only chunks that can ever batch are 2..n of ONE message.
    Measured against realistic message lengths that leaves a mean effective batch size of about
    1.3. Flattening several messages into one `run_chunks` submission is what lifts it, and it
    is worth roughly 4x on a real workload (6.3-m3, measured end to end on the satellite).

    ⚠️ **Only for work NOBODY IS LISTENING TO YET** — scene builds and speculative pre-renders.
    It is strictly worse than streaming for a live click: it returns nothing at all until the
    whole submission lands, where `stream_message` starts feeding a listener after chunk one.
    That is the trade §3 of DESIGN_6_2_BATCHING declined for interactive work, and it still
    stands; these callers are background producers, which is why they may take it.

    One voice per call. `_Batch` carries `params` and `_drain_batch_mates` refuses a job whose
    batch differs, so a caller with two voices must make two calls — grouping them here would
    silently produce one submission that cannot batch.
    """
    import torch

    out = [None] * len(texts)
    # The pool keys results by the index it was HANDED, so the map from flat index back to
    # message is the only place that correspondence lives and it has to be built once.
    flat, owner_of = [], {}
    for pos, text in enumerate(texts):
        for chunk in split_into_chunks(text or ""):
            owner_of[len(flat)] = pos
            flat.append((len(flat), chunk))
    if not flat:
        return out

    got, lock = {}, threading.Lock()

    def save(idx, wav, sr):
        with lock:
            got[idx] = wav

    try:
        pool.run_chunks(flat, params, save, len(flat), cancel=cancel)
    # ⚠️ `RuntimeError` ONLY, and that is what keeps BOUNDARY 3 intact without naming it here:
    # `VaultAuthError` is deliberately a `BaseException` (vault.py:58), so it cannot be caught by
    # this clause and still leaves by type, as `collect()` re-raised it. A broader `except
    # Exception` here would be the exact "except Exception: return None" data-loss idiom that
    # 5.0's sweep was written against.
    except RuntimeError as exc:                        # noqa: BLE001
        # 🔴 SOME chunks failed permanently; the ones that landed are still good. Letting this
        # escape made the assembly loop below dead code on the failure path, so ONE bad chunk in
        # a 150-chunk submission threw away every complete message in it — a 74-message scene
        # build would discard 73 finished renders and re-do the lot one at a time through the
        # streaming path, giving back the whole 4.09x for one chunk. The docstring's contract
        # ("or None where the submission did not deliver every chunk of that message") was only
        # ever honored for cancels. The `len(parts) == len(want)` guard below is what keeps a
        # partly-delivered message None, so the callers' per-message fallback still covers
        # exactly what is genuinely missing and nothing more.
        logger.warning(f"batched submission: {exc} — keeping the messages that did complete")

    for pos in range(len(texts)):
        want = sorted(i for i, p in owner_of.items() if p == pos)
        parts = [got[i] for i in want if i in got]
        # A short message is left as None rather than concatenated from what arrived: a
        # canceled or partly-failed submission must not hand back a truncated render that
        # every caller here would then promote into a cache as if it were whole.
        if want and len(parts) == len(want):
            out[pos] = torch.cat(parts, dim=-1).squeeze(0).cpu().numpy()
    return out
