"""HTTPS/TLS config resolution for the unified server (2.1-M6).

resolve_ssl_context is a pure helper so we can test the flag/env logic without
binding a socket or needing a real cert.
"""
import pytest

import vocalis_server


@pytest.fixture(autouse=True)
def _clear_tls_env(monkeypatch):
    monkeypatch.delenv("VOCALIS_TLS_CERT", raising=False)
    monkeypatch.delenv("VOCALIS_TLS_KEY", raising=False)


def test_tls_off_by_default():
    ctx, err = vocalis_server.resolve_ssl_context(None, None, False)
    assert ctx is None and err is None


def test_tls_adhoc():
    ctx, err = vocalis_server.resolve_ssl_context(None, None, True)
    assert ctx == "adhoc" and err is None


def test_tls_cert_key_pair(tmp_path):
    cert = tmp_path / "test-host.pem"; cert.write_text("cert")
    key  = tmp_path / "test-host-key.pem"; key.write_text("key")
    ctx, err = vocalis_server.resolve_ssl_context(str(cert), str(key), False)
    assert ctx == (str(cert), str(key)) and err is None


def test_tls_only_cert_is_error(tmp_path):
    cert = tmp_path / "test-host.pem"; cert.write_text("cert")
    ctx, err = vocalis_server.resolve_ssl_context(str(cert), None, False)
    assert ctx is None and err and "BOTH" in err


def test_tls_missing_file_is_error(tmp_path):
    ctx, err = vocalis_server.resolve_ssl_context(
        str(tmp_path / "nope.pem"), str(tmp_path / "nope-key.pem"), False)
    assert ctx is None and err and "not found" in err


def test_tls_env_fallback(tmp_path, monkeypatch):
    cert = tmp_path / "test-host.pem"; cert.write_text("cert")
    key  = tmp_path / "test-host-key.pem"; key.write_text("key")
    monkeypatch.setenv("VOCALIS_TLS_CERT", str(cert))
    monkeypatch.setenv("VOCALIS_TLS_KEY", str(key))
    ctx, err = vocalis_server.resolve_ssl_context(None, None, False)   # flags unset → env wins
    assert ctx == (str(cert), str(key)) and err is None


# ── app_settings.yaml — where "this box serves HTTPS" actually belongs ────────

def _certs(tmp_path):
    cert = tmp_path / "test-host.pem"; cert.write_text("cert")
    key  = tmp_path / "test-host-key.pem"; key.write_text("key")
    return str(cert), str(key)


def test_tls_from_app_settings(tmp_path):
    """TLS settings must be loaded from application configuration so HTTPS does not depend on the launching shell environment."""
    cert, key = _certs(tmp_path)
    ctx, err = vocalis_server.resolve_ssl_context(
        None, None, False, {"tls": {"cert": cert, "key": key}})
    assert ctx == (cert, key) and err is None


def test_flags_and_env_still_beat_app_settings(tmp_path, monkeypatch):
    """Precedence is flag → env → settings, the same rule as every other subsystem
    (enhance/voiceswap/voicetrain.resolve_config). A one-off `--tls-cert` must still win,
    or you cannot override the box's default without editing its config."""
    cert, key = _certs(tmp_path)
    other = tmp_path / "other.pem"; other.write_text("cert")
    otherk = tmp_path / "other-key.pem"; otherk.write_text("key")
    settings = {"tls": {"cert": str(other), "key": str(otherk)}}

    ctx, _ = vocalis_server.resolve_ssl_context(cert, key, False, settings)
    assert ctx == (cert, key), "an explicit flag must beat the settings file"

    monkeypatch.setenv("VOCALIS_TLS_CERT", cert)
    monkeypatch.setenv("VOCALIS_TLS_KEY", key)
    ctx, _ = vocalis_server.resolve_ssl_context(None, None, False, settings)
    assert ctx == (cert, key), "the env must beat the settings file"


def test_app_settings_without_tls_is_plain_http(tmp_path):
    """When TLS settings are absent, preserve unrelated settings and serve the configured plain-HTTP mode."""
    ctx, err = vocalis_server.resolve_ssl_context(
        None, None, False, {"workers_per_card": 1, "log_ansi_colors": True})
    assert ctx is None and err is None


def test_half_configured_tls_in_settings_is_a_loud_error(tmp_path):
    """A cert with no key must fail at startup with a sentence, not silently downgrade to
    plain HTTP — a silent downgrade is exactly the failure this whole change is about."""
    cert, _key = _certs(tmp_path)
    ctx, err = vocalis_server.resolve_ssl_context(None, None, False, {"tls": {"cert": cert}})
    assert ctx is None and err and "BOTH" in err and "app_settings.yaml" in err


# ── Docker mode: app_settings.yaml `tls` names host files, so it is ignored ──────
#
# October 10, 2026 (in-place switch design, item 5). A standalone install adopted in place keeps
# its `tls: {cert, key}` in the shared app_settings.yaml; inside the container those host paths do
# not exist, and honoring them stopped the server at startup. The proxy in front of the published
# port terminates HTTPS instead. The file itself is never edited (legacy still needs it).

@pytest.fixture
def docker_mode(monkeypatch):
    monkeypatch.setenv("VOCALIS_REQUIRE_VAULT", "1")
    monkeypatch.setattr(vocalis_server, "_DOCKER_TLS_IGNORED_LOGGED", False)


@pytest.fixture
def standalone_mode(monkeypatch):
    monkeypatch.delenv("VOCALIS_REQUIRE_VAULT", raising=False)


_MISSING_HOST_FILES = {"tls": {"cert": "/home/someone/.local/share/mkcert/host.pem",
                               "key": "/home/someone/.local/share/mkcert/host-key.pem"}}


def test_docker_mode_ignores_an_app_settings_tls_entry_naming_missing_files(docker_mode):
    ctx, err = vocalis_server.resolve_ssl_context(None, None, False, _MISSING_HOST_FILES)
    assert ctx is None and err is None, "Docker mode must start plain HTTP, not refuse"


def test_standalone_mode_still_refuses_an_app_settings_tls_entry_naming_missing_files(
        standalone_mode):
    ctx, err = vocalis_server.resolve_ssl_context(None, None, False, _MISSING_HOST_FILES)
    assert ctx is None and err and "not found" in err, "non-Docker behavior is unchanged"


def test_docker_mode_also_ignores_a_half_configured_tls_entry(docker_mode, tmp_path):
    cert, _key = _certs(tmp_path)
    ctx, err = vocalis_server.resolve_ssl_context(None, None, False, {"tls": {"cert": cert}})
    assert ctx is None and err is None


def test_docker_mode_does_not_use_an_existing_app_settings_tls_entry_either(docker_mode, tmp_path):
    """The entry is skipped whether or not its files happen to exist in the container."""
    cert, key = _certs(tmp_path)
    ctx, err = vocalis_server.resolve_ssl_context(
        None, None, False, {"tls": {"cert": cert, "key": key}})
    assert ctx is None and err is None


def test_docker_mode_command_line_and_environment_tls_still_work(docker_mode, tmp_path,
                                                                 monkeypatch):
    cert, key = _certs(tmp_path)
    ctx, err = vocalis_server.resolve_ssl_context(cert, key, False, _MISSING_HOST_FILES)
    assert ctx == (cert, key) and err is None, "--tls-cert/--tls-key still win"

    monkeypatch.setenv("VOCALIS_TLS_CERT", cert)
    monkeypatch.setenv("VOCALIS_TLS_KEY", key)
    ctx, err = vocalis_server.resolve_ssl_context(None, None, False, _MISSING_HOST_FILES)
    assert ctx == (cert, key) and err is None, "VOCALIS_TLS_CERT/KEY still work"

    # Only the settings entry is skipped: a flag naming a missing file is still an error.
    ctx, err = vocalis_server.resolve_ssl_context(
        str(tmp_path / "nope.pem"), str(tmp_path / "nope-key.pem"), False, _MISSING_HOST_FILES)
    assert ctx is None and err and "not found" in err


def test_docker_mode_logs_the_ignored_entry_once(docker_mode):
    from loguru import logger
    lines = []
    sink = logger.add(lambda message: lines.append(message.record["message"]), level="INFO")
    try:
        for _ in range(3):
            vocalis_server.resolve_ssl_context(None, None, False, _MISSING_HOST_FILES)
        vocalis_server.resolve_ssl_context(None, None, False, {})   # no entry: nothing to say
    finally:
        logger.remove(sink)
    ignored = [m for m in lines if "tls" in m and "ignored" in m]
    assert len(ignored) == 1, ignored
    assert "proxy" in ignored[0] and "host.pem" in ignored[0]


def test_docker_mode_says_nothing_when_there_is_no_tls_entry(docker_mode):
    from loguru import logger
    lines = []
    sink = logger.add(lambda message: lines.append(message.record["message"]), level="INFO")
    try:
        ctx, err = vocalis_server.resolve_ssl_context(None, None, False, {"log_ansi_colors": True})
    finally:
        logger.remove(sink)
    assert ctx is None and err is None
    assert not [m for m in lines if "ignored" in m]
