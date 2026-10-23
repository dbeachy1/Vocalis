"""Provide the client side of the satellite link. RemoteModel implements generate() and sr so WorkerPool can use it as a replica without changing local scheduling. Satellite device names bypass local CUDA device and VRAM checks. Send voice samples as content-addressed bytes; the satellite decodes them in memory and stores only prepared conditionals."""
import hashlib
import json
import sys
import threading
import uuid
from pathlib import Path

from loguru import logger

# The protocol lives with the satellite, because that folder is copied to another machine and
# must work standalone. Importing the same file rather than keeping a second copy is deliberate:
# a vendored duplicate would drift, and a drifted cipher fails silently rather than loudly.
# (`vocalis.py` sets the precedent for an explicit path insert with a reason attached.)
_SATELLITE_DIR = Path(__file__).resolve().parent.parent / "satellite"
if str(_SATELLITE_DIR) not in sys.path:
    sys.path.insert(0, str(_SATELLITE_DIR))

import vocalis_satellite_protocol as proto      # noqa: E402

DEVICE_SEP = ":"
# Keep connection establishment and response waiting independent. A bare `requests` timeout is applied to both phases, so an unreachable satellite can occupy a render worker for the full read timeout. `_timeout()` pairs a short connect bound with the longer render bound.
CONNECT_TIMEOUT = 5.0        # Short bound for unreachable satellites.
READ_TIMEOUT = 900.0         # a long chunk render is legitimately slow
CANCEL_TIMEOUT = 60.0        # Warn and drop locally after this bound (§10).
HEALTH_TIMEOUT = 5.0
#: The GPU-stat poll runs at 4 Hz. Bound both request phases below the poll interval so a missing satellite cannot stall the poller for the ordinary five-second connection timeout.
GPUSTATS_TIMEOUT = 0.2


# What the user is told when the satellite answers 401 to a sealed request. October 10, 2026: the
# old text said "re-run setup.py there", which a Docker satellite does not have; the setup file
# with --new-secret is its equivalent. Both `_post` paths use this one sentence.
SECRET_MISMATCH_FIX = ('The shared secret does not match. Press "New secret…" on this satellite\'s '
                       'row in Settings, then give the new secret to the satellite: its setup '
                       'file with --new-secret (Docker), or setup.py (source install).')


def _timeout(read_s, connect_s=None):
    """`(connect, read)` for requests. Never a bare float — see CONNECT_TIMEOUT.

    `connect_s` overrides the shared CONNECT_TIMEOUT for a caller that cannot afford the
    ordinary 5 s just to learn a satellite is unreachable — see GPUSTATS_TIMEOUT, whose 4 Hz
    poller needs BOTH halves capped well under its own interval."""
    return (CONNECT_TIMEOUT if connect_s is None else connect_s, read_s)


def _is_ip_literal(host: str) -> bool:
    import ipaddress
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        return False


def ipv4_url(url: str) -> str:
    """Return the configured URL with its hostname resolved to IPv4. The satellite listener accepts IPv4, so select an IPv4 DNS answer explicitly rather than relying on resolver order. TLS verification still requires the certificate SAN to include the resolved address."""
    import socket
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(url)
    host = parts.hostname
    if not host or _is_ip_literal(host):
        return url
    try:
        infos = socket.getaddrinfo(host, parts.port, socket.AF_INET, socket.SOCK_STREAM)
    except OSError as exc:
        raise SatelliteUnreachable(
            f"{host!r} has no IPv4 address — Vocalis dials IPv4 only. Give the satellite an "
            f"A record, or put its IPv4 address in the URL. ({exc})") from exc
    if not infos:
        raise SatelliteUnreachable(f"{host!r} resolved to no IPv4 address")
    ip = infos[0][4][0]
    netloc = f"{ip}:{parts.port}" if parts.port else ip
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


class SatelliteError(Exception):
    """The satellite refused, failed, or could not be reached."""


class SatelliteUnreachable(SatelliteError):
    """Expected transport failure when a satellite is unavailable. Callers may fall back to local workers and must not treat this condition as an application error."""


class SatelliteTimedOut(SatelliteUnreachable):
    """The satellite answered the connection but did not finish in time: running, but busy or
    crawling, not switched off. A pool that drops it waits before taking it back (2026-10-22),
    because one that answers health at once would otherwise rejoin in seconds and crawl again."""


class SatelliteCanceled(SatelliteError):
    """Raised when a remote batch was canceled rather than failed. The pool drops undelivered chunks on cancellation but retries them after ordinary failures."""


def says_canceled(d) -> bool:
    """Return whether a reply indicates cancellation using either supported spelling. Send the current spelling and accept the legacy spelling so mixed-version deployments preserve cancel behavior."""
    return bool(d) and (bool(d.get("canceled")) or bool(d.get("cancelled")))


def status_is_canceled(d) -> bool:
    """The same tolerance, for the streaming trailer's `status` value."""
    return bool(d) and d.get("status") in ("canceled", "cancelled")


def device_name(satellite: str, device: str) -> str:
    """Combine a satellite identifier and local device name, for example `<satellite>:cuda:0`. The prefix keeps remote devices distinct from local CUDA devices."""
    return f"{satellite}{DEVICE_SEP}{device}"


def split_device(device: str):
    """Split a device name into its satellite identifier and local device, or return None for the satellite identifier when the name is local."""
    s = str(device)
    if s.startswith("cuda") or s == "cpu":
        return None, s
    head, _, rest = s.partition(DEVICE_SEP)
    return (head, rest) if rest else (None, s)


def is_remote(device) -> bool:
    return split_device(device)[0] is not None


class SatelliteClient:
    """One satellite. Sealed bodies, pinned TLS, and no bearer token — the AEAD tag is the
    authentication (§7)."""

    def __init__(self, name: str, url: str, master: bytes, cert: str = None,
                 verify: bool = True, vram_cap_gb: float = 0.0, st_max_batch=1):
        self.name = name
        self.url = url.rstrip("/")
        self._master = master
        self.cert = cert
        # Resolve callable VRAM caps when sending each request. Long-lived clients can outlive settings edits; caching a cap would let a later `/capacity` call replace a configured limit with zero, which the receiver treats as uncapped.
        self._cap = vram_cap_gb if callable(vram_cap_gb) else float(vram_cap_gb or 0.0)
        # Resolve callable batch limits when they are read. The client is long-lived, so caching the value would hide settings changes until the pool is rebuilt.
        self._st_batch = st_max_batch if callable(st_max_batch) else int(st_max_batch or 1)
        # 🔴 One place answers "is this link actually protected", and it feeds both the
        # connection and anything that displays a badge. A UI that reports HTTPS while
        # verification is off is worse than plain HTTP, because it misreports and nobody
        # looks twice (§6).
        self.verify = (cert if (cert and verify) else verify)
        self._dial = None            # the IPv4 form of `url`, resolved once (see ipv4_url)
        self._dial_lock = threading.Lock()
        # Keep the last logged address separate from the cached dial address. Connection failures clear the cache so DNS can be retried, but repeated resolution to an unchanged address should not emit a log line each time; a changed address should be logged once.
        self._last_logged_dial = None

    @property
    def vram_cap_gb(self) -> float:
        """The ceiling to send, resolved NOW. Never raises: this sits in front of every render,
        and a settings read that failed must degrade to "no cap said" rather than take the
        dispatch with it."""
        if not callable(self._cap):
            return self._cap
        try:
            return float(self._cap() or 0.0)
        except Exception:                                     # noqa: BLE001
            return 0.0

    @property
    def st_max_batch(self) -> int:
        """The SillyTavern batch ceiling for this satellite, resolved NOW, as 1..64.

        Never raises, and a failed settings read answers **1** rather than the uncapped 0 the
        VRAM property returns: the two defaults point in opposite directions on purpose. "No
        answer" for a ceiling on how much the card may hold has to mean "hold nothing extra";
        "no answer" for how many chunks to batch has to mean the batch size that cannot make
        playback wait.
        """
        v = self._st_batch
        if callable(v):
            try:
                v = v()
            except Exception:                                 # noqa: BLE001
                return 1
        try:
            return max(1, min(int(v or 1), 64))
        except (TypeError, ValueError):
            return 1

    def _raise_if_unsealed(self, r) -> None:
        """Turn a plain-text or HTML error body into the message it actually says.

        🔴 Both `_post` paths used to hand every reply to `open_frames` before looking at the
        status. A body the satellite did not seal — a 404 for a mistyped path, a Flask 500, a
        400 from an older satellite — is then read as an envelope, and the first four bytes of
        `"'text' is required"` become a 661 MB frame length: *"refusing to allocate for
        unauthenticated data"*. The operator is told the crypto failed, on the wrong machine,
        for a bad WAV file. A satellite of this version seals its refusals; this is the
        cross-version half, and it is also what keeps a proxy's error page readable.
        """
        if r.headers.get("Content-Type", "").split(";")[0].strip() == "application/octet-stream":
            return
        body = " ".join((r.text or "").split())[:300]
        raise SatelliteError(f"satellite {self.name!r}: HTTP {r.status_code}"
                             + (f" — {body}" if body else ""))

    def _forget_dial(self) -> None:
        """Clear the cached IPv4 address so the next attempt resolves the hostname again. This allows the client to recover when DHCP changes the satellite address."""
        with self._dial_lock:
            self._dial = None

    def dial_url(self) -> str:
        """`url` with the host resolved to IPv4, cached. Resolved once rather than per request:
        every chunk of every render goes through here, and a DNS lookup per chunk would be a
        needless dependency on the resolver being up."""
        with self._dial_lock:
            if self._dial is not None:
                return self._dial
        # ⚠️ Resolved OUTSIDE the lock. `socket.getaddrinfo` has no timeout of its own — a
        # resolver that has stopped answering (router reboot) costs the system default, twice —
        # and holding the lock across it queued every worker for this satellite behind one
        # lookup, including the Settings health poll on its Flask request thread. That is the
        # invariant 701276f exists to enforce, with the DNS half left unguarded. Two threads
        # racing here at worst resolve twice and agree.
        dial = ipv4_url(self.url)
        with self._dial_lock:
            if self._dial is None:
                self._dial = dial
                # Compare against the last logged address, not only the current cache. Connection failures clear the cache for DNS retry; repeated resolution to the same address should not emit a line each time, while a changed address should be logged.
                if dial != self.url and dial != self._last_logged_dial:
                    logger.info(f"satellite {self.name!r}: dialing {dial} (IPv4)")
                    self._last_logged_dial = dial
            return self._dial

    @property
    def is_tls(self) -> bool:
        return self.url.lower().startswith("https://")

    @property
    def is_verified(self) -> bool:
        """TLS **and** pinned. Anything else must not be described as secure."""
        return self.is_tls and bool(self.cert) and self.verify is not False

    def security_note(self) -> str:
        if self.is_verified:
            return "TLS, pinned"
        if self.is_tls:
            return "TLS but NOT pinned — any host on the LAN can impersonate this satellite"
        return "PLAIN HTTP — payloads are still sealed, but metadata is exposed and there is " \
               "no forward secrecy"

    # ── transport ────────────────────────────────────────────────────────────

    def _post(self, path: str, payload: bytes, timeout, connect_s=None):
        import requests
        salt = proto.new_salt()
        k2s = proto.derive_key(self._master, salt, proto.DIR_TO_SATELLITE)
        s2k = proto.derive_key(self._master, salt, proto.DIR_TO_SERVER)
        try:
            r = requests.post(f"{self.dial_url()}{path}",
                              data=proto.seal_bytes(k2s, payload),
                              headers={"X-Vocalis-Salt": salt.hex(),
                                       "Content-Type": "application/octet-stream"},
                              timeout=_timeout(timeout, connect_s), verify=self.verify)
        except requests.exceptions.SSLError as exc:
            # A pin that does not validate FAILS. It is never downgraded to a warning — that
            # would make the pin decorative (§6).
            raise SatelliteError(
                f"satellite {self.name!r}: TLS verification failed — the certificate does not "
                f"match the pinned one at {self.cert}. Re-copy cert.pem, or re-run setup on the "
                f"satellite. ({exc})") from exc
        except requests.exceptions.ReadTimeout as exc:
            # A read timeout means the address answered but the operation did not finish in time. Keep the cached dial address: clearing it here makes a busy satellite trigger repeated DNS lookups, especially on the fast GPU-stat poll.
            raise SatelliteTimedOut(
                f"satellite {self.name!r} did not answer {path} within {timeout:.3g}s — it may "
                f"be busy. ({type(exc).__name__})") from exc
        except requests.exceptions.RequestException as exc:
            # Not streamed, so `requests.post` reads the whole body itself, and a read timeout
            # AFTER the headers comes out as a ConnectionError wrapping urllib3's ReadTimeoutError,
            # not as ReadTimeout. It is the same "answered, then too slow" as the branch above:
            # timed out, and the dial cache kept (2026-10-22).
            from urllib3.exceptions import ReadTimeoutError
            if any(isinstance(a, ReadTimeoutError) for a in exc.args):
                raise SatelliteTimedOut(
                    f"satellite {self.name!r} stopped sending {path} part-way, nothing for "
                    f"{timeout:.3g}s — it may be busy. ({type(exc).__name__})") from exc
            # The address it answered on may have moved (DHCP, a reboot). Drop the cached IPv4
            # so the next attempt resolves again, and name what was actually dialed — printing
            # `self.url` alone showed the operator the name that WOULD have worked.
            dialed = self._dial
            self._forget_dial()
            where = f"{self.url} ({dialed})" if dialed and dialed != self.url else self.url
            raise SatelliteUnreachable(
                f"satellite {self.name!r} is not reachable at {where} — start it on the "
                f"box. ({type(exc).__name__})") from exc
        if r.status_code == 401:
            raise SatelliteError(f"satellite {self.name!r} rejected our envelope. "
                                 f"{SECRET_MISMATCH_FIX}")
        self._raise_if_unsealed(r)
        # Frames, not joined bytes: the render reply is a JSON header frame plus a PCM frame,
        # and joining them would make the boundary ambiguous. `finish()` runs inside
        # open_frames, so a truncated reply raises here rather than becoming a short render.
        return r.status_code, proto.open_frames(s2k, r.content)

    def _post_stream(self, path: str, payload: bytes, timeout):
        """Post a request and yield each response frame as it arrives. On non-200 responses, return the collected frames for ordinary error parsing; on success, keep the connection open until the iterator is exhausted or closed. Require the authenticated end marker before accepting a stream as complete."""
        import requests
        salt = proto.new_salt()
        k2s = proto.derive_key(self._master, salt, proto.DIR_TO_SATELLITE)
        s2k = proto.derive_key(self._master, salt, proto.DIR_TO_SERVER)
        try:
            r = requests.post(f"{self.dial_url()}{path}",
                              data=proto.seal_bytes(k2s, payload),
                              headers={"X-Vocalis-Salt": salt.hex(),
                                       "Content-Type": "application/octet-stream"},
                              timeout=_timeout(timeout), verify=self.verify, stream=True)
        except requests.exceptions.SSLError as exc:
            raise SatelliteError(
                f"satellite {self.name!r}: TLS verification failed — the certificate does not "
                f"match the pinned one at {self.cert}. Re-copy cert.pem, or re-run setup on the "
                f"satellite. ({exc})") from exc
        except requests.exceptions.ReadTimeout as exc:
            # See the identical branch in `_post` — the address answered, only the read half
            # expired, so this must not be treated as "the address moved" and must not clear
            # the dial cache the render path shares.
            raise SatelliteTimedOut(
                f"satellite {self.name!r} did not answer {path} within {timeout:.3g}s — it may "
                f"be busy. ({type(exc).__name__})") from exc
        except requests.exceptions.RequestException as exc:
            # The address it answered on may have moved (DHCP, a reboot). Drop the cached IPv4
            # so the next attempt resolves again, and name what was actually dialed — printing
            # `self.url` alone showed the operator the name that WOULD have worked.
            dialed = self._dial
            self._forget_dial()
            where = f"{self.url} ({dialed})" if dialed and dialed != self.url else self.url
            raise SatelliteUnreachable(
                f"satellite {self.name!r} is not reachable at {where} — start it on the "
                f"box. ({type(exc).__name__})") from exc
        if r.status_code == 401:
            r.close()
            raise SatelliteError(f"satellite {self.name!r} rejected our envelope. "
                                 f"{SECRET_MISMATCH_FIX}")
        if r.status_code != 200:
            with r:
                self._raise_if_unsealed(r)
                return r.status_code, proto.open_frames(s2k, r.content)

        def gen():
            reader = proto.SealedReader(s2k)
            try:
                for raw in r.iter_content(chunk_size=64 * 1024):
                    if raw:
                        for payload in reader.feed(raw):
                            yield payload
                reader.finish()
            except requests.exceptions.RequestException as exc:
                # 🔴 A FAILURE PART-WAY THROUGH THE REPLY IS STILL THE SATELLITE (2026-10-22). Only
                # the request itself was wrapped above, so a satellite that stopped or crawled after
                # its first frame raised a raw `requests` error here: the pool took it for a bad
                # chunk, kept the worker and retried on it, instead of moving the work to the local
                # cards and taking the satellite back when it recovers. `iter_content` reports a
                # read timeout as a ConnectionError wrapping urllib3's ReadTimeoutError.
                from urllib3.exceptions import ReadTimeoutError
                if isinstance(exc, requests.exceptions.ReadTimeout) or any(
                        isinstance(a, ReadTimeoutError) for a in exc.args):
                    raise SatelliteTimedOut(
                        f"satellite {self.name!r} stopped sending {path} part-way, nothing for "
                        f"{timeout:.3g}s — it may be busy. ({type(exc).__name__})") from exc
                raise SatelliteUnreachable(
                    f"satellite {self.name!r} dropped the connection part-way through {path} — "
                    f"it may have been stopped. ({type(exc).__name__})") from exc
            finally:
                r.close()

        return r.status_code, gen()

    def _post_json(self, path, obj, timeout=READ_TIMEOUT, connect_s=None):
        status, frames = self._post(path, json.dumps(obj).encode("utf-8"), timeout, connect_s)
        try:
            return status, json.loads(b"".join(frames).decode("utf-8"))
        except ValueError as exc:
            raise SatelliteError(f"satellite {self.name!r} sent a non-JSON reply") from exc

    # ── verbs ────────────────────────────────────────────────────────────────

    def health(self) -> dict:
        # Reassert the current cap during health polling so an idle satellite receives settings changes and recovers the configured value after a restart.
        _, d = self._post_json("/satellite/health",
                               {"vram_cap_gb": self.vram_cap_gb}, HEALTH_TIMEOUT)
        return d

    def load(self, plan: dict) -> dict:
        # §17 — the cap rides with the plan. A 1.10 satellite ignores the extra key, which is why
        # this needs no capability check: there is nothing it can get wrong by not understanding.
        _, d = self._post_json("/satellite/load",
                               {"plan": plan, "vram_cap_gb": self.vram_cap_gb})
        return d

    def unload(self) -> dict:
        _, d = self._post_json("/satellite/unload", {})
        return d

    def gpustats(self) -> dict:
        """Return per-card readings from /satellite/gpustats using the field shape consumed by the shared GPU display. Keep live readings separate from health polling and use the short GPU-stat timeout so a failed satellite does not delay dispatch."""
        _, d = self._post_json("/satellite/gpustats", {}, GPUSTATS_TIMEOUT,
                               connect_s=GPUSTATS_TIMEOUT)
        return d

    def capacity(self, device: str, lengths: list) -> int:
        """Return how many chunks a card can accept in one pass using their lengths only; never send chunk text for this scheduling estimate. Use the short health timeout so dispatch can fall back promptly when a satellite is unavailable."""
        # 🔴 §17 — AND THE CAP, ON EVERY ONE. This verb runs a round trip before each dispatch, so
        # it is the channel that makes an edited cap take effect on the next batch instead of on
        # the next load of a model that may be resident for hours.
        _, d = self._post_json("/satellite/capacity",
                               {"device": device, "lengths": [int(n) for n in lengths],
                                "vram_cap_gb": self.vram_cap_gb},
                               HEALTH_TIMEOUT)
        return int(d.get("take") or 0)

    def send_voice(self, voice_hash: str, audio: bytes) -> dict:
        status, frames = self._post("/satellite/voice",
                                    voice_hash.encode("ascii") + audio, READ_TIMEOUT)
        body = b"".join(frames)
        if status != 200:
            raise SatelliteError(f"satellite {self.name!r} refused the voice: {body[:200]!r}")
        return json.loads(body.decode("utf-8"))

    def cancel(self, request_id: str) -> bool:
        """Best effort by design. If it does not answer within 60 s the caller drops the job
        locally and logs a warning — the satellite going deaf must be visible, not silently
        expensive (§10)."""
        try:
            _, d = self._post_json("/satellite/cancel", {"request_id": request_id},
                                   CANCEL_TIMEOUT)
            return says_canceled(d)
        except SatelliteError as exc:
            logger.warning(f"no response from satellite {self.name!r} to cancel {request_id} "
                           f"after {CANCEL_TIMEOUT:.0f}s — job dropped locally ({exc})")
            return False

    def vram(self, device: str) -> dict:
        """Return a fresh free-VRAM reading for the requested card. Do not cache it; use None when unavailable and treat that as no capacity. Keep the decision timeout short enough for local fallback."""
        _, d = self._post_json("/satellite/vram", {"device": device}, HEALTH_TIMEOUT)
        return d

    def leadvocal(self, request_id, wav: bytes, **head):
        """Submit a vocal stem for remote separation and return (status, error, header, parts). A non-200 response makes the device unavailable so the caller can fall back locally. Use the render timeout for this long-running operation. keep_warm is a hint, not a resource lease; the satellite may still release an idle worker."""
        body = proto.pack_parts({"request_id": request_id, **head}, [("vocals", wav)])
        status, frames = self._post("/satellite/leadvocal", body, READ_TIMEOUT)
        blob = b"".join(frames)
        if status != 200:
            try:
                return status, json.loads(blob.decode("utf-8")), None, None
            except ValueError:
                return status, {"error": f"satellite {self.name!r} sent {blob[:200]!r}"}, None, None
        head_out, parts = proto.unpack_parts(blob)
        return status, None, head_out, parts

    def render(self, request_id, text, voice_hash, **kw):
        """(status, error_dict_or_None, frames_or_None).

        A 409 carrying `need_voice` is the content-addressed voice protocol working, not a
        failure — the caller ships the sample and retries.
        """
        body = {"request_id": request_id, "text": text, "voice_hash": voice_hash, **kw}
        status, frames = self._post("/satellite/render",
                                    json.dumps(body).encode("utf-8"), READ_TIMEOUT)
        if status != 200:
            return status, json.loads(b"".join(frames).decode("utf-8")), None
        return status, None, frames

    def render_batch(self, request_id, chunks, voice_hash, **kw):
        """Submit multiple chunks and return (status, error, frames). Require each chunk to carry a caller-supplied id so replies can be matched independently of order."""
        body = {"request_id": request_id, "voice_hash": voice_hash,
                "chunks": [{"id": str(c["id"]), "text": c["text"]} for c in chunks], **kw}
        status, frames = self._post_stream("/satellite/render",
                                           json.dumps(body).encode("utf-8"), READ_TIMEOUT)
        if status != 200:
            return status, json.loads(b"".join(frames).decode("utf-8")), None
        return status, None, frames

    def stream(self, request_id, text, voice_hash, **kw):
        """Return (status, error_dict_or_None, payload_iterator_or_None). A successful response yields tagged payload frames; an error response provides the complete error body."""
        body = {"request_id": request_id, "text": text, "voice_hash": voice_hash, **kw}
        status, frames = self._post_stream("/satellite/stream",
                                           json.dumps(body).encode("utf-8"), READ_TIMEOUT)
        if status != 200:
            return status, json.loads(b"".join(frames).decode("utf-8")), None
        return status, None, frames


class RemoteModel:
    """A satellite replica, shaped like a `ChatterboxTTS` as far as the pool is concerned.

    Only `.sr` and `.generate()` are ever touched — see this module's docstring. Everything the
    pool does around it (retry, re-split, banking, priority) is untouched.
    """

    # Checked with getattr by `vocalis_streaming.stream_message`, which must not import this
    # module just to ask the question — a box with no satellites never loads it at all.
    is_remote = True

    def __init__(self, client: SatelliteClient, device: str, sr: int, verbs=None,
                 caps=None, max_batch=None, registry=None):
        # October 10, 2026 — `self.client` is the client the worker was BUILT with and, after the
        # first request, the one the latest request resolved. It must never be used to SEND a
        # request: this object lives as long as the pool, and "New secret...", a new certificate
        # or an edited URL builds a new client in the registry while this one keeps the old
        # secret, pin and URL. Seen live as `POST /satellite/stream 401` ("rejected our
        # envelope") with Settings showing the satellite reachable and its model loaded. Every
        # request starts with `current_client()` and uses what it returns, start to finish.
        # `registry` is whatever answers `client_for(name)`; None (a bare `RemoteModel(client,
        # ...)`, as the tests build one) means "the client I was given is the only one".
        self.client = client
        self._registry = registry
        self.device = device            # the satellite-local name, e.g. "cuda:0"
        # What the far end said it can do. `None` means it did not say — a satellite older than
        # 1.1 — and `can_stream` resolves that to False so the chunk degrades to a batch render
        # instead of failing. §4: declared, never enforced.
        self.verbs = list(verbs) if verbs is not None else None
        # Capabilities describe supported routes and gate optional behavior. Satellites may be upgraded independently, so a version comparison is not a reliable capability check.
        self.caps = list(caps) if caps is not None else None
        # 🔴 A CEILING, NOT AN ALLOWANCE — see the satellite's own health comment. It sizes how
        # many queued chunks this worker hands over at once; what a pass can afford is read from
        # `mem_get_info` on the card, at the moment it runs, by the satellite. Never cached, and
        # never sent back the other way.
        self.max_batch = int(max_batch) if max_batch else 0
        # The last batch reply's trailer, for the pool to read once the generator is exhausted.
        # 7.3.17 uses it for `held`/`want` — the chunks the card kept back for a top-up rather
        # than render as a short pass. Safe as plain instance state because one worker drives one
        # replica: two submissions are never in flight on the same `RemoteModel`.
        self.last_trailer = {}
        # The pool-level device identifier distinguishes equal device names on different satellites and keys measured worker rates.
        self.pool_device = device_name(client.name, device)
        self.sr = int(sr)
        self._hash_cache = {}           # path -> (mtime, size, hash)
        self._lock = threading.Lock()

    # -- voice ---------------------------------------------------------------

    def _voice_bytes_and_hash(self, path):
        """Content-addressed: sha256 of the sample's bytes, cached on (mtime, size).

        🔴 Read through `vault_fs`, not bare pathlib. In practice `make_generate_fn` has already
        run `voice_for_model()` and hands us a plaintext SCRATCH path — but relying on that
        would make this function silently wrong the first time anything calls
        `RemoteModel.generate()` with a logical path, and in the vault that is not a
        wrong-content bug, it is a file whose name is SIV-encrypted and cannot be found at all.
        Routing costs nothing and is correct either way (`route()` returning None is a
        passthrough).
        """
        import vault_fs
        # `vault_fs.stat` returns Stat(size, mtime) — NOT an os.stat_result, and None when the
        # file is absent (a library listing races the delete button). Both differences are
        # deliberate on its side; getting either wrong here is an AttributeError on the first
        # real render, which is exactly how this was found.
        st = vault_fs.stat(path)
        if st is None:
            raise SatelliteError(f"voice sample has gone: {path}")
        key = str(path)
        with self._lock:
            cached = self._hash_cache.get(key)
        if cached and cached[0] == st.mtime and cached[1] == st.size:
            return None, cached[2]
        data = vault_fs.read_bytes(path)
        h = hashlib.sha256(data).hexdigest()
        with self._lock:
            self._hash_cache[key] = (st.mtime, st.size, h)
        return data, h

    def current_client(self):
        """The client that matches the settings saved RIGHT NOW. Call once at the start of a
        request and use the result for everything that request does (its retries, its voice
        upload, its cancel); never once per attribute access.

        Costs what `satellites.client_for` costs: one settings read and a tuple compare, the same
        read the per-request VRAM-cap callback already makes. A satellite that was removed from
        Settings, has no secret, or whose pinned certificate file is gone fails as a plain
        `SatelliteError`, exactly like any other satellite failure, so the pool's ordinary chunk
        failure handling applies. Anything else `client_for` raises (a hand-edited secret that
        is not hex) is wrapped to the same type so a worker thread never dies on it.
        """
        reg = self._registry
        if reg is None:
            return self.client
        name = self.client.name
        try:
            client = reg.client_for(name)
        except SatelliteError as exc:
            logger.warning(f"satellite {name!r} on {self.device}: no usable client for this "
                           f"request ({exc})")
            raise
        except (ValueError, TypeError, OSError) as exc:
            # ValueError: a hand-edited secret that is not hex (`bytes.fromhex`). OSError: the
            # pinned certificate path could not be examined. Named, not blind, on purpose: the
            # ratchets in test_m5_boundaries / test_webui_types count blind handlers, and anything
            # else escaping here is a genuine bug that should show as a traceback.
            logger.warning(f"satellite {name!r} on {self.device}: could not build a client for "
                           f"this request ({type(exc).__name__}: {exc})")
            raise SatelliteError(f"satellite {name!r}: could not build a client from the saved "
                                 f"settings ({type(exc).__name__}: {exc})") from exc
        if client is not self.client:
            # Which of the three changed is the useful fact; the secret itself is never logged.
            old = self.client
            changed = [what for what, a, b in (
                ("url", getattr(old, "url", None), getattr(client, "url", None)),
                ("pin", getattr(old, "cert", None), getattr(client, "cert", None)),
                ("secret", getattr(old, "_master", None), getattr(client, "_master", None)))
                if a != b]
            logger.info(f"satellite {name!r} on {self.device}: settings changed since this "
                        f"worker's last request ({', '.join(changed) or 'rebuilt'}) — using the "
                        f"current client ({getattr(client, 'url', '?')}, "
                        f"pinned={bool(getattr(client, 'cert', None))})")
            self.client = client
        return client

    def _recover(self) -> bool:
        """Ask the shared registry to redeclare the satellite plan after it reports that no model is loaded. The registry owns the total replica count across workers and the synchronization for reloading."""
        try:
            from vocalis.runtime import satellites as reg
            return bool(reg.reload(self.client.name))
        except Exception as exc:                                # noqa: BLE001
            logger.warning(f"satellite {self.client.name!r} could not be reloaded: {exc}")
            return False

    @property
    def can_stream(self) -> bool:
        """Return whether the satellite advertised the streaming endpoint. Missing capability metadata means streaming is unavailable."""
        return bool(self.verbs) and "stream" in self.verbs

    def capacity(self, lengths: list) -> int:
        """Return the advertised chunk capacity for this satellite card using chunk lengths only. Use a short timeout so a failed device can be skipped promptly."""
        if not lengths:
            return 0
        try:
            return int(self.current_client().capacity(self.device, list(lengths)))
        except SatelliteError:
            return 0

    @property
    def can_batch(self) -> bool:
        """Return whether the satellite advertised multi-chunk requests. Missing capability metadata selects the single-chunk fallback."""
        return bool(self.caps) and "batch_render" in self.caps

    @property
    def batch_slice(self) -> int:
        """How many queued chunks to hand over in one submission.

        The satellite's published ceiling when it published one, 8 otherwise. It is a scheduling
        figure and NOT a promise about the card: the satellite splits whatever it is given into
        as many passes as free VRAM affords at that instant and returns each one as it finishes.
        Bounded at both ends because it arrives over the wire — a satellite reporting 0 or 10000
        must not be able to stall a pool or starve every other worker.
        """
        return max(1, min(int(self.max_batch or 8), 64))

    @property
    def st_batch_slice(self) -> int:
        """Return the smaller of the configured batch size and the satellite-advertised ceiling. The client setting may lower the ceiling but cannot raise it."""
        return max(1, min(self.batch_slice, int(self.client.st_max_batch or 1)))

    # -- cancellation --------------------------------------------------------

    def _request_id(self, text) -> str:
        """Create an identifier unique to one render request. The remote cancel endpoint uses this identifier to select the render to abort."""
        return f"{self.client.name}-{uuid.uuid4().hex[:16]}"

    def _cancel_bridge(self, request_id, client):
        """Bridge the local cancellation Event to a remote render with a watcher thread. Return (stop_event, thread); callers must signal and join the watcher in a finally block. Share this path between generate and stream so cancellation stops remote work in both modes. `client` is the one the request started with: the cancel must reach the same satellite, URL and secret as the render it cancels."""
        import tts_utils

        ev = getattr(tts_utils._GEN_CANCEL, "event", None)
        stop = threading.Event()
        if ev is None:
            return stop, None

        def _watch():
            while not stop.wait(0.25):
                if ev.is_set():
                    client.cancel(request_id)
                    return
        watcher = threading.Thread(target=_watch, daemon=True)
        watcher.start()
        return stop, watcher

    # -- generate ------------------------------------------------------------

    def generate(self, text, audio_prompt_path=None, exaggeration=0.5,
                 cfg_weight=0.5, temperature=0.8):
        import numpy as np
        import torch

        import tts_utils

        # One client for the whole request — see `current_client`. Resolved before the voice is
        # read so a satellite removed from Settings fails fast and clean.
        client = self.current_client()
        voice_hash, data = "", None
        if audio_prompt_path:
            data, voice_hash = self._voice_bytes_and_hash(audio_prompt_path)

        request_id = self._request_id(text)
        stop, watcher = self._cancel_bridge(request_id, client)

        try:
            # Same recovery ladder as `stream`, and it has to be here too: a restarted satellite
            # breaks a book render exactly as readily as a stream, it is simply less visible
            # because a batch chunk IS retried and the failure arrives as a chunk error.
            sent_voice = reloaded = False
            while True:
                status, err, frames = self._render_once(client, request_id, text, voice_hash,
                                                        exaggeration, cfg_weight, temperature)
                if status == 200:
                    break
                if status == 409 and says_canceled(err):
                    raise tts_utils.GenerationCanceled()
                if status == 409 and err and err.get("need_voice") and not sent_voice:
                    if data is None and audio_prompt_path:
                        import vault_fs
                        data = vault_fs.read_bytes(audio_prompt_path)
                    if data is None:
                        raise SatelliteError(
                            "satellite needs the voice but we have no bytes for it")
                    client.send_voice(voice_hash, data)
                    sent_voice = True
                    continue
                if status == 503 and not reloaded:
                    reloaded = True
                    if self._recover():
                        sent_voice = False      # the restart took its voice cache with it
                        continue
                raise SatelliteError(f"satellite {self.client.name!r} render failed: "
                                     f"{(err or {}).get('error', status)}")
        finally:
            stop.set()
            if watcher is not None:
                watcher.join(timeout=1.0)

        meta, pcm = self._parse(frames)
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32767.0
        if meta.get("sr") and int(meta["sr"]) != self.sr:
            # Not fatal, but it means the pool's single `sr` is wrong for this worker and the
            # splice would be pitched. Loud, because it is otherwise inaudible until playback.
            logger.error(f"satellite {self.client.name!r} returned sr={meta['sr']} but the pool "
                         f"is running at {self.sr} — audio from this worker will be mis-pitched")
        return torch.from_numpy(audio).unsqueeze(0)

    def _render_once(self, client, request_id, text, voice_hash, exaggeration, cfg, temperature):
        return client.render(request_id, text, voice_hash,
                                  exaggeration=float(exaggeration), cfg=float(cfg),
                                  temperature=float(temperature), device=self.device)

    def generate_batch(self, items, audio_prompt_path=None, exaggeration=0.5,
                       cfg_weight=0.5, temperature=0.8, more_available=False, held=()):
        """Submit chunks in batches and yield each completed (id, wav) as it arrives. Match results by caller-supplied id, not position. Do not start another request while the response generator is active because the remote replica lock is held for the full reply. Raise cancellation separately from failures; cancellations drop undelivered chunks while failures allow retry. Use more_available and held to flush or top up a card without losing the ids it retained."""
        import torch

        import tts_utils

        # One client for the whole submission — see `current_client`. This is a generator, so a
        # removed satellite raises on the first `next()`, where every other failure also lands.
        client = self.current_client()
        voice_hash, data = "", None
        if audio_prompt_path:
            data, voice_hash = self._voice_bytes_and_hash(audio_prompt_path)

        chunks = [{"id": str(cid), "text": text} for cid, text in items]
        request_id = self._request_id("")
        stop, watcher = self._cancel_bridge(request_id, client)
        finished = False        # cleared only by a reply we read to its trailer — see `finally`

        try:
            # The same recovery ladder `generate` and `stream` use, and for the same reason: a
            # restarted satellite has an empty voice cache, so 503 -> reload -> 409 -> ship the
            # sample -> 200 is the normal path back. Every rung is reached before a single frame
            # is read, which is the only window in which the HTTP status still means anything.
            sent_voice = reloaded = False
            while True:
                status, err, frames = client.render_batch(
                    request_id, chunks, voice_hash,
                    exaggeration=float(exaggeration), cfg=float(cfg_weight),
                    temperature=float(temperature), device=self.device,
                    # The scheduler sets this flag only when queued work remains for this batch. A satellite may retain a remainder only when the sender can still submit its continuation.
                    more_available=bool(more_available),
                    # What we believe the card is still holding from the previous call in this
                    # chain. Naming them is what lets the satellite drop a remainder nobody is
                    # waiting for any more instead of prepending it to a stranger's submission.
                    held=[str(h) for h in (held or ())])
                if status == 200:
                    break
                if status == 409 and says_canceled(err):
                    raise tts_utils.GenerationCanceled()
                if status == 409 and err and err.get("need_voice") and not sent_voice:
                    if data is None and audio_prompt_path:
                        import vault_fs
                        data = vault_fs.read_bytes(audio_prompt_path)
                    if data is None:
                        raise SatelliteError(
                            "satellite needs the voice but we have no bytes for it")
                    client.send_voice(voice_hash, data)
                    sent_voice = True
                    continue
                if status == 503 and not reloaded:
                    reloaded = True
                    if self._recover():
                        sent_voice = False      # the restart took its voice cache with it
                        continue
                raise SatelliteError(f"satellite {self.client.name!r} batch failed: "
                                     f"{(err or {}).get('error', status)}")

            warned_sr = False
            # Reset per submission: the pool reads it straight after this generator is exhausted,
            # and a stale `held` from a previous batch would make it wait for chunks nobody holds.
            self.last_trailer = {}
            for cid, sr, audio in self.iter_batch(frames, self.last_trailer):
                if sr and int(sr) != self.sr and not warned_sr:
                    # Once per batch, not once per chunk: it is one property of the far end and
                    # eight identical CRITICAL lines per submission bury the render's own log.
                    warned_sr = True
                    logger.error(f"satellite {self.client.name!r} returned sr={sr} but the pool "
                                 f"is running at {self.sr} — audio from this worker will be "
                                 f"mis-pitched")
                yield cid, torch.from_numpy(audio).unsqueeze(0)
            finished = True
        except SatelliteCanceled:
            # The satellite has already stopped of its own accord — nothing to tell it.
            finished = True
            raise tts_utils.GenerationCanceled()
        finally:
            stop.set()
            if watcher is not None:
                watcher.join(timeout=1.0)
            # On any abnormal exit, cancel the remote request so it releases its card instead of finishing work with no consumer. This includes timeout, truncated reply, error trailer, or generator abandonment; cancellation is idempotent for requests that already finished. Run it on a daemon thread because the cancel request may wait for its full timeout, and the pool worker must be returned promptly.
            if not finished:
                threading.Thread(target=client.cancel, args=(request_id,),
                                 daemon=True).start()

    # -- stream --------------------------------------------------------------

    def stream(self, text, audio_prompt_path=None, exaggeration=0.5, cfg_weight=0.5,
               temperature=0.8, config=None):
        """Yield float32 mono windows at the remote sample rate. Match the local stream interface and end cleanly on cancellation so already-yielded audio remains valid and incomplete chunks are not promoted."""
        import numpy as np

        from vocalis_stream_core import render_config

        if not self.can_stream:
            # An older satellite. Render the chunk whole and hand it back as ONE window: the
            # listener loses progressive audio for chunk 1 only, and the governor's measured
            # batch rate for this device already reflects how long that takes. Failing instead
            # would abort the whole message, because a _StreamJob is never retried.
            logger.info(f"satellite {self.client.name!r} has no streaming verb — chunk 1 "
                        f"renders whole on it (upgrade the satellite for progressive audio)")
            wav = self.generate(text, audio_prompt_path=audio_prompt_path,
                                exaggeration=exaggeration, cfg_weight=cfg_weight,
                                temperature=temperature)
            audio = wav.squeeze(0).float().cpu().numpy()
            if len(audio):
                yield audio
            return

        # One client for the whole stream — see `current_client`. The no-streaming-verb branch
        # above renders through `generate`, which resolves its own.
        client = self.current_client()
        voice_hash, data = "", None
        if audio_prompt_path:
            data, voice_hash = self._voice_bytes_and_hash(audio_prompt_path)

        request_id = self._request_id(text)
        stop, watcher = self._cancel_bridge(request_id, client)
        kw = dict(exaggeration=float(exaggeration), cfg=float(cfg_weight),
                  temperature=float(temperature), device=self.device)
        if config is not None:
            kw["config"] = render_config(config)

        try:
            sent_voice = reloaded = False
            while True:
                status, err, payloads = client.stream(request_id, text, voice_hash, **kw)
                if status == 200:
                    break
                # The content-addressed voice protocol. Cold satellite, one extra round trip.
                if status == 409 and err and err.get("need_voice") and not sent_voice:
                    if data is None and audio_prompt_path:
                        import vault_fs
                        data = vault_fs.read_bytes(audio_prompt_path)
                    if data is None:
                        raise SatelliteError(
                            "satellite needs the voice but we have no bytes for it")
                    client.send_voice(voice_hash, data)
                    sent_voice = True
                    continue
                # A restarted satellite has an empty voice cache. Reload its plan and retry once; a render can require both plan reload and voice upload, so keep the recovery steps in one loop.
                if status == 503 and not reloaded:
                    reloaded = True
                    if self._recover():
                        sent_voice = False      # its voice cache went with the restart
                        continue
                raise SatelliteError(f"satellite {self.client.name!r} stream failed: "
                                     f"{(err or {}).get('error', status)}")

            saw_header, trailer = False, None
            for payload in payloads:
                if not payload:
                    raise SatelliteError("empty payload in the stream")
                tag, body = payload[:1], payload[1:]
                if tag == proto.TAG_AUDIO:
                    if not saw_header:
                        raise SatelliteError("audio arrived before the stream header")
                    yield np.frombuffer(body, dtype="<i2").astype(np.float32) / 32767.0
                elif tag == proto.TAG_HEADER:
                    saw_header = True
                    sr = int(json.loads(body.decode("utf-8")).get("sr") or 0)
                    if sr and sr != self.sr:
                        # Loud, because it is inaudible until playback: the pool splices every
                        # worker's audio at ONE rate, so a mismatch pitches this chunk only.
                        logger.error(
                            f"satellite {self.client.name!r} streamed at sr={sr} but the pool "
                            f"is running at {self.sr} — this chunk will be mis-pitched")
                elif tag == proto.TAG_TRAILER:
                    trailer = json.loads(body.decode("utf-8"))
                else:
                    raise SatelliteError(f"unknown payload tag {tag!r} in the stream")

            # 🔴 No trailer means the frames authenticated and the END arrived, yet the
            # satellite never said how it ended. Treating that as success is how a truncated
            # render becomes a finished one.
            if trailer is None:
                raise SatelliteError("the stream ended without a trailer — its status is unknown")
            if trailer.get("status") == "error":
                raise SatelliteError(f"satellite {self.client.name!r} stream failed: "
                                     f"{trailer.get('error')}")
        finally:
            stop.set()
            if watcher is not None:
                watcher.join(timeout=1.0)

    @staticmethod
    def _parse(frames):
        """The render reply is a JSON header frame, then the PCM — which may span SEVERAL frames.

        The PCM is one frame today because a chunk's audio fits, but "fits" is a property of the
        chunker's size limit rather than of this format, and the voice-sample failure was exactly
        this assumption in the other direction. Frame 0 is the header; everything after it is
        audio, joined. `FRAME_PAYLOAD_BYTES` is even, so a split never lands mid-sample.
        """
        if not frames or len(frames) < 2:
            raise SatelliteError(
                f"render reply had {len(frames or [])} frame(s), expected at least 2 "
                f"(a JSON header and the PCM)")
        return json.loads(frames[0].decode("utf-8")), b"".join(frames[1:])

    @staticmethod
    def iter_batch(payloads, out_trailer=None):
        """Yield (id, sample_rate, float32_audio) for each completed chunk as it arrives. Match by caller-supplied id, never by position. Raise a mid-batch error rather than allowing callers to treat a partial response as a complete section."""
        import numpy as np
        import vocalis_satellite_protocol as proto
        pending, want, buf, sr = None, 0, bytearray(), None
        saw_trailer = False

        def finish():
            block = np.frombuffer(bytes(buf), dtype="<i2").astype(np.float32) / 32767.0
            return pending, sr, block

        for p in payloads:
            tag, body = p[:1], p[1:]
            if tag == proto.TAG_HEADER:
                if pending is not None:
                    raise SatelliteError(f"chunk {pending!r} was cut short: wanted {want} "
                                         f"samples, got {len(buf) // 2}")
                head = json.loads(body.decode("utf-8"))
                pending, want, sr = str(head.get("id")), int(head.get("samples", 0)), head.get("sr")
                buf = bytearray()
            elif tag == proto.TAG_AUDIO:
                if pending is None:
                    raise SatelliteError("audio arrived before any chunk header")
                buf += body
                if len(buf) >= want * 2:
                    if len(buf) != want * 2:
                        raise SatelliteError(
                            f"chunk {pending!r} overran: header said {want} samples, "
                            f"got {len(buf) // 2}")
                    yield finish()
                    pending, want, buf = None, 0, bytearray()
            elif tag == proto.TAG_TRAILER:
                saw_trailer = True
                st = json.loads(body.decode("utf-8"))
                # 7.3.17 — the trailer now carries more than a status: `held`/`want` name the
                # chunks the card kept back rather than render as a short pass. Surfaced through
                # a caller-supplied dict because this is a staticmethod and the alternative is
                # changing what the generator yields, which every caller and test reads.
                if out_trailer is not None:
                    out_trailer.update(st)
                if status_is_canceled(st):
                    # BY TYPE, not by message. The pool retries a failed chunk and drops a
                    # canceled one, so a cancel flattened into a generic error becomes three
                    # rounds of retries against a satellite that was told to stop.
                    raise SatelliteCanceled("the batch was canceled")
                if st.get("status") != "ok":
                    raise SatelliteError(st.get("error") or f"batch {st.get('status')}")
            else:
                raise SatelliteError(f"unknown frame tag {tag!r} in a batch reply")
        if pending is not None:
            raise SatelliteError(f"chunk {pending!r} was cut short at end of reply")
        if not saw_trailer:
            raise SatelliteError("batch reply ended without a trailer — it was truncated")

    @staticmethod
    def split_batch(frames):
        """The whole batch collected into `(sample_rate, {id: audio})`.

        A convenience over `iter_batch` for callers that genuinely want everything before they
        act — tests, and a single short batch. **A book render must not use this**: it throws away
        the incremental delivery that exists so early chunks can be banked.
        """
        out, sr = {}, None
        for cid, rate, wav in RemoteModel.iter_batch(frames):
            out[cid], sr = wav, rate
        return sr, out


def remote_model(device: str, registry=None):
    """Build a `RemoteModel` for a `<satellite>:<device>` name. Called by `tts_utils.load_model`
    when the pool is asked for a satellite device, so `WorkerPool` needs no satellite knowledge.

    Raises `SatelliteUnreachable` if the box is off — which `WorkerPool` already handles the same
    way it handles a card that will not load: log, skip, carry on with what fits.

    ⚠️ **The load below is a FALLBACK, not the mechanism.** `satellites.apply_plan()` declares
    each satellite's full replica plan once, before the pool builds any worker, because this
    function is called per worker SLOT and a per-slot call cannot express a total — the branch
    only fires while the satellite reports no sample rate, i.e. on the first slot, so every later
    slot silently got a client for a replica that was never created. Keep this branch for the
    direct-`WorkerPool` callers that never went through `get_pool`, but do not grow it: the count
    belongs to `apply_plan`.
    """
    from vocalis.runtime import satellites as reg
    registry = registry or reg
    sat_name, local_device = split_device(device)
    if sat_name is None:
        raise SatelliteError(f"{device!r} is not a satellite device")
    client = registry.client_for(sat_name)
    health = client.health()
    if not health.get("sr"):
        # Cold satellite: ask it to load this device before we can know its sample rate.
        plan_before = health.get("workers", {}) or {}
        want = dict(plan_before)
        want[local_device] = want.get(local_device, 0) + 1
        client.load(want)
        health = client.health()
    sr = health.get("sr")
    if not sr:
        raise SatelliteError(f"satellite {sat_name!r} loaded no replica on {local_device}")
    verbs = health.get("verbs")
    caps  = health.get("capabilities")
    logger.info(f"satellite {sat_name!r} v{health.get('satellite_version')} on {local_device}: "
                f"ready (sr={sr}, {client.security_note()}"
                f"{'' if verbs and 'stream' in verbs else ', no streaming verb'}"
                f"{', batched' if caps and 'batch_render' in caps else ', one chunk per request'})")
    return RemoteModel(client, local_device, sr, verbs=verbs, caps=caps,
                       max_batch=health.get("max_batch"), registry=registry)
