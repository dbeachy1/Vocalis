"""Centralize locality and TLS policy shared by model-host clients. Explicit locality configuration takes precedence; otherwise only loopback and the current machine hostnames count as local. Locality gates access to local resources. TLS uses a supplied CA when configured, permits an unverified context only for local hosts, and verifies remote hosts by default."""

from __future__ import annotations

import socket
import ssl
import urllib.parse

#: Hosts that are unambiguously this machine no matter what the box is called.
LOOPBACK = {"localhost", "127.0.0.1", "::1"}


def is_local_url(url: str, explicit=None) -> bool:
    """Return whether the URL targets this machine. An explicit setting overrides hostname detection for containers, proxies, and other network arrangements. Never infer locality from a GPU or VRAM measurement; configuration determines trust, while measurements determine capacity."""
    if explicit is not None:
        return bool(explicit)
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:                                   # malformed URL -> not our box
        return False
    if not host:
        return False
    return host in LOOPBACK or host in {socket.gethostname().lower(),
                                        socket.getfqdn().lower()}


def ssl_context(cafile: str = "", local: bool = True):
    """Build a TLS context. A supplied CA enables certificate verification with that trust root. Without a CA, only a local host may use an unverified context; remote hosts use normal certificate verification so invalid or untrusted certificates fail."""
    if cafile:
        return ssl.create_default_context(cafile=cafile)
    if local:
        return ssl._create_unverified_context()   # this box's own process, not a network peer
    return ssl.create_default_context()           # remote + no CA -> fail honestly
