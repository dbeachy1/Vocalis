"""Concatenate compatible MP3 inputs with ffmpeg stream copy. Share one implementation across book and scene callers. Pipe the concat list, quote file paths, allow only the required file and pipe protocols, and materialize vault inputs under opaque scratch names. Callers joining mixed profiles must probe and re-encode as needed. Callers that compute offsets or totals for a join add up `contributed_s` (packet durations), never the per-file format duration."""
import subprocess
from contextlib import ExitStack
from pathlib import Path

from loguru import logger

import scratch as scratch_mod
import vault_fs


def contributed_s(path, *, scratch_root=None) -> float:
    """How many seconds `path` adds to a stream-copy join: the SUM OF ITS PACKET DURATIONS.

    🔴 NOT `ffprobe -show_entries format=duration`. FFmpeg 8 applies the MP3 gapless metadata
    (LAME/Xing encoder delay and end padding) when it probes ONE file, so a "1 s" 24 kHz mono
    96k part probes at exactly 1.000 s. The concat demuxer keeps every part's full frames,
    padding included — that part is 44 packets x 0.024 s = 1.056 s of the joined file. Measured
    in the image (ffmpeg 8.0.1): three 1 s parts and two 0.7 s gaps probed 1.000 / 0.700 each,
    summed to 4.400, and the joined file decoded to 4.648. Offsets and totals built from the
    per-file probe drifted ~50 ms per joined part, and the older Windows build (which did not
    trim gapless info) hid it because its probe equalled the packet sum. The packet sum is what
    a join contains on EVERY build, which is why this is the one to add up.

    `duration_time` is per packet, so MPEG-1 (1152 samples a frame) and MPEG-2 Layer III
    (576 samples a frame, the 24 kHz speech profile) need no special-casing here.

    Goes through the vault seam like `concat_mp3` (ffprobe is a child process and has no DEK),
    which is a no-op returning the original path for a file that is not ours. When ffprobe runs
    but yields no packet durations, falls back to the format duration and logs it — the join
    still gets a number, and a wrong-by-padding one beats a crash. Raises FileNotFoundError when
    ffprobe itself is not installed, exactly as `tts_utils.ffprobe_duration` does.
    """
    root = scratch_root if scratch_root is not None else scratch_mod.scratch_root()
    with vault_fs.child_input(Path(path), root) as plain:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "packet=duration_time", "-of", "csv=p=0", str(plain)],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        total, packets = 0.0, 0
        if r.returncode == 0:
            for line in r.stdout.splitlines():
                field = line.strip().rstrip(",")
                if not field:
                    continue
                try:
                    total += float(field)
                    packets += 1
                except ValueError:                 # "N/A" on a packet with no duration
                    pass
        if packets:
            logger.debug(f"contributed_s: {packets} packets = {total:.3f} s")
            return total
        from tts_utils import ffprobe_duration
        fallback = ffprobe_duration(plain) or 0.0
        logger.warning(f"contributed_s: ffprobe gave no packet durations (rc={r.returncode}, "
                       f"{r.stderr.strip()[:200]!r}); using the format duration {fallback:.3f} s")
        return fallback


def concat_quote(p) -> str:
    """Quote one path for the concat demuxer's list. Landmines 2 and 3 above, together —
    they are one string and separating them is how a caller gets one of them right.

    Verified against ffmpeg, not assumed: the `file:` prefix is what stops the pipe protocol
    being inherited by the entries, and the `'\\''` dance is what survives a chapter called
    `03_Rock'n'Roll.mp3`."""
    return "'file:" + Path(p).as_posix().replace("'", "'\\''") + "'"


def concat_mp3(paths, dest, *, scratch_root=None, encode=None) -> Path:
    """Join `paths` (in the order given) into `dest`. Returns `dest`.

    `encode` (7.5.27) replaces the default `-c copy` with encoder arguments — e.g.
    `["-c:a", "libopus", "-b:a", "192k"]` for the Opus audiobook. Stream copy stays the
    default because it is the right answer whenever the inputs already agree, and it is
    lossless. Pass `encode` and the codec question below becomes moot: a re-encode is exactly
    how you join inputs that do NOT agree, which is the case the docstring warns about.

    Both ends go through the vault seam: each source is materialized with
    `vault_fs.child_input` (a no-op returning the original path when the file is not ours),
    ffmpeg writes into the scratch, and `vault_fs.from_scratch` brings the result back into
    the store — encrypting it if the destination is routed.

    🔴 **The caller owns the codec question.** A stream copy across inputs that disagree on
    codec, sample rate, channel count or bitrate produces a file that plays wrong or not at
    all, and ffmpeg does not always say so. Every speech artifact this app renders is 96 kbps
    mono (`mp3_render.MP3_BITRATE`, `enhance.MP3_BITRATE_PLAIN`), so book chapters and the
    SillyTavern message cache are safe by construction. **Enhanced clips are 256 kbps
    (`MP3_BITRATE_ENHANCED`) and voiceswap output is 320 k stereo** — the moment a caller joins
    arbitrary library clips (6.0 §7's Join), it must ffprobe each input and re-encode when they
    differ, rather than reaching for this function and hoping.

    Raises FileNotFoundError for an empty list and RuntimeError if ffmpeg fails.
    """
    paths = [Path(p) for p in paths]
    if not paths:
        raise FileNotFoundError("nothing to concatenate")

    dest = Path(dest)
    root = scratch_root if scratch_root is not None else scratch_mod.scratch_root()
    with ExitStack() as stack:
        srcs = [stack.enter_context(vault_fs.child_input(p, root)) for p in paths]
        # The scratch temp must carry the DESTINATION's extension, not a hardcoded `.mp3`:
        # ffmpeg picks its muxer from the output filename, so an Opus encode writing to a
        # `.mp3` temp produces an MP3-muxed file with an Opus stream in it — which some
        # players open and most do not. It was `.mp3` because this function only ever
        # stream-copied MP3s.
        tmp = stack.enter_context(
            scratch_mod.file(root, f"concat|{dest}", dest.suffix or ".mp3"))
        if encode:
            # Use the concat filter when re-encoding mixed inputs. The demuxer requires matching codecs, sample rates, and channel layouts; mismatches can silently truncate or mis-time output before the encoder runs.
            # The filter decodes inputs to PCM and joins samples. Resample and format every input to the same rate and channel layout before joining. This costs a full decode but preserves the audio.
            # Use 48 kHz mono for the output so the Opus encode uses its native rate without another resample.
            rate, layout = 48000, "mono"
            cmd = ["ffmpeg", "-y"]
            for s in srcs:
                cmd += ["-i", str(s)]
            pre = ";".join(
                f"[{i}:a]aresample={rate},aformat=sample_fmts=fltp:channel_layouts={layout}[a{i}]"
                for i in range(len(srcs)))
            joins = "".join(f"[a{i}]" for i in range(len(srcs)))
            cmd += ["-filter_complex",
                    f"{pre};{joins}concat=n={len(srcs)}:v=0:a=1[out]",
                    "-map", "[out]", *encode, str(tmp), "-loglevel", "error"]
            r = subprocess.run(cmd, capture_output=True, text=True,
                               encoding="utf-8", errors="replace")
        else:
            listing = "".join(f"file {concat_quote(s)}\n" for s in srcs)
            r = subprocess.run(
                ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
                 "-protocol_whitelist", "file,pipe", "-i", "pipe:0",
                 "-c", "copy", str(tmp), "-loglevel", "error"],
                input=listing, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
            )
        if r.returncode != 0:
            raise RuntimeError(f"ffmpeg concat failed: {r.stderr.strip()}")
        vault_fs.from_scratch(tmp, dest)
    return dest
