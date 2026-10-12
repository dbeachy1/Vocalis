"""Exercise Docker-only mount validation and the narrow pre-vault route surface."""
import re

import pytest

import vault_survey
import vocalis_server as vs
from vocalis.runtime import auth, paths, acestep as rt
from vocalis.web import auth as web_auth
from vocalis.web import lora as web_lora
from vocalis.web import ui as web_ui
from vocalis.runtime import loratrain


@pytest.fixture
def client():
    vs.app.config["TESTING"] = True
    with vs.app.test_client() as test_client:
        yield test_client


def test_docker_runtime_roots_must_be_explicit_and_writable(monkeypatch, tmp_path):
    monkeypatch.setenv("VOCALIS_REQUIRE_VAULT", "1")
    monkeypatch.delenv("VOCALIS_BULK_DIR", raising=False)
    with pytest.raises(RuntimeError, match="VOCALIS_BULK_DIR"):
        paths.validate_runtime_roots()

    roots = {"data": tmp_path / "data", "cache": tmp_path / "cache",
             "logs": tmp_path / "logs", "scratch": tmp_path / "work" / "scratch",
             "bulk": tmp_path / "work" / "scratch" / "bulk"}
    for root in roots.values():
        root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("VOCALIS_DATA_DIR", str(roots["data"]))
    monkeypatch.setenv("VOCALIS_CACHE_DIR", str(roots["cache"]))
    monkeypatch.setenv("VOCALIS_LOG_DIR", str(roots["logs"]))
    monkeypatch.setenv("VOCALIS_SCRATCH_DIR", str(roots["scratch"]))
    monkeypatch.setenv("VOCALIS_BULK_DIR", str(roots["bulk"]))
    monkeypatch.setattr(paths, "DATA_DIR", roots["data"])
    monkeypatch.setattr(paths, "LOG_DIR", roots["logs"])
    monkeypatch.setattr(paths, "SCRATCH_DIR", roots["scratch"])
    monkeypatch.setattr(paths, "BULK_DIR", roots["bulk"])
    paths.validate_runtime_roots()

    roots["bulk"].rmdir()
    with pytest.raises(RuntimeError, match="bulk directory is missing"):
        paths.validate_runtime_roots()


def test_fresh_docker_bootstrap_exposes_only_setup_paths(client, monkeypatch):
    monkeypatch.setattr(paths, "docker_encrypted_mode", lambda: True)
    monkeypatch.setattr(auth.STORE, "is_initialized", lambda: False)
    # A FRESH store, stated rather than inherited: the per-worker data dir can hold files an
    # earlier test on the same xdist worker left, and /vault/init refuses a populated store (409)
    # before it ever checks the password. Seen 2026-10-09 in a full -n 8 run. The populated-store
    # refusal has its own tests in test_auth_surface.py.
    monkeypatch.setattr(vault_survey, "existing_plaintext_data", lambda store: [])
    monkeypatch.setattr(auth, "auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "creds_broken", lambda: False)

    setup = client.get("/setup")
    assert setup.status_code == 200
    csrf = re.search(rb'name="csrf-token" content="([^"]+)"', setup.data).group(1).decode()
    assert b"data-mode=\"fresh\"" in setup.data

    nav = client.get("/", headers={"Sec-Fetch-Mode": "navigate"})
    assert nav.status_code == 302 and nav.headers["Location"].endswith("/setup")
    assert client.get("/health").status_code == 200
    assert client.post("/vault/rotate-recovery").status_code == 503
    for endpoint, payload in (("/acestep/init", {"device": "cuda:0", "model": "sample"}),
                              ("/llama/load", {"model": "sample"}),
                              ("/kobold/load", {"filename": "sample"}),
                              ("/train/start", {"name": "sample"})):
        assert client.post(endpoint, json=payload).status_code == 503
    assert client.post("/admin/set-credentials", headers={"X-CSRF-Token": csrf},
                       json={"username": "admin", "password": "   "}).status_code == 400
    assert client.post("/vault/init", headers={"X-CSRF-Token": csrf},
                       json={"password": ""}).status_code == 401


def test_existing_credentials_must_login_before_vault_initialization(client, monkeypatch):
    monkeypatch.setattr(paths, "docker_encrypted_mode", lambda: True)
    monkeypatch.setattr(auth.STORE, "is_initialized", lambda: False)
    monkeypatch.setattr(auth, "auth_enabled", lambda: True)
    monkeypatch.setattr(auth, "creds_broken", lambda: False)
    monkeypatch.setattr(auth, "ADMIN_USER", "existing-owner")
    monkeypatch.setattr(auth, "password_ok", lambda password: password == "existing-password")
    monkeypatch.setattr(web_auth.vault_survey, "existing_plaintext_data", lambda store: [])
    monkeypatch.setattr(auth.STORE, "create", lambda password: "synthetic-recovery-key")
    monkeypatch.setattr(auth.STORE, "issue_suk", lambda: "synthetic-suk")
    monkeypatch.setattr(web_auth, "store_startup_tasks", lambda: None)

    setup = client.get("/setup")
    assert setup.status_code == 200 and b'data-mode="existing-credentials"' in setup.data
    csrf = re.search(rb'name="csrf-token" content="([^"]+)"', setup.data).group(1).decode()
    headers = {"X-CSRF-Token": csrf}
    assert client.post("/vault/init", headers=headers,
                       json={"password": "existing-password"}).status_code == 401
    login = client.post("/login", headers=headers,
                        json={"username": "existing-owner", "password": "existing-password"})
    assert login.status_code == 200 and login.get_json()["ok"] is True
    initialized = client.post("/vault/init", headers=headers,
                              json={"password": "existing-password"})
    assert initialized.status_code == 200
    assert initialized.get_json()["recovery_key"] == "synthetic-recovery-key"


def test_docker_ace_lifecycle_routes_use_the_local_child_manager(client, monkeypatch):
    monkeypatch.setattr(paths, "docker_encrypted_mode", lambda: True)
    monkeypatch.setattr(auth.STORE, "is_initialized", lambda: True)
    monkeypatch.setattr(auth, "auth_enabled", lambda: True)
    monkeypatch.setattr(auth, "creds_broken", lambda: False)
    monkeypatch.setattr(auth, "vault_locked", lambda: False)

    monkeypatch.setattr(rt, "installed", lambda: [
        ("acestep-api-gpu0", "http://127.0.0.1:7683", "cuda:0")])
    monkeypatch.setattr(rt, "active_count", lambda *_args: 0)
    calls = []
    for action in ("start", "stop", "restart"):
        monkeypatch.setattr(rt, f"{action}_all", lambda _action=action, **_kw: (
            calls.append(_action), [{"ok": True, "state": _action, "device": "cuda:0"}])[1])
    monkeypatch.setattr(rt, "stop_instance", lambda **kw: (
        calls.append(("unload", kw.get("device"))),
        {"ok": True, "state": "stopped", "device": kw.get("device")})[1])
    with client.session_transaction() as sess:
        sess["logged_in"] = True
    for endpoint in ("/comfyui/start", "/comfyui/stop", "/comfyui/restart"):
        assert client.post(endpoint, json={"device": "cuda:0"}).status_code == 501
    for endpoint in ("/acestep/start", "/acestep/stop", "/acestep/restart"):
        assert client.post(endpoint, json={"device": "cuda:0"}).status_code == 200
    assert client.post("/acestep/unload", json={"device": "cuda:0"}).status_code == 200
    assert calls == ["start", "stop", "restart", ("unload", "cuda:0")]


def test_docker_refuses_lora_training_before_external_launch(client, monkeypatch, tmp_path):
    monkeypatch.setattr(paths, "docker_encrypted_mode", lambda: True)
    monkeypatch.setattr(auth.STORE, "is_initialized", lambda: True)
    monkeypatch.setattr(auth, "auth_enabled", lambda: True)
    monkeypatch.setattr(auth, "creds_broken", lambda: False)
    monkeypatch.setattr(auth, "vault_locked", lambda: False)
    script = tmp_path / "ai-toolkit.sh"
    script.write_text("synthetic launcher")
    monkeypatch.setattr(loratrain, "LAUNCH_SCRIPT", script)
    monkeypatch.setattr(web_lora.lorasubj, "get",
                        lambda subject_id: type("Subject", (), {"name": "sample"})())
    monkeypatch.setattr(web_lora.lorasubj, "dataset_size", lambda subject_id: 1)

    def forbidden_spawn(*args, **kwargs):
        raise AssertionError("Docker training must not spawn ai-toolkit")

    monkeypatch.setattr(loratrain.subprocess, "Popen", forbidden_spawn)
    with client.session_transaction() as sess:
        sess["logged_in"] = True

    assert script.is_file()
    assert loratrain.launcher_available() is False
    # LoRA Studio is an EXCLUDED surface (the Vocalis 12.0 scope: "Exclude LoRA
    # Studio, Video, RVC training, Voice Swap ..."). Commit 39df8c4 ("remove excluded feature routes
    # and UI") stopped registering `create_lora_blueprint()` in vocalis_server.py, so the HTTP route
    # no longer exists and answers 404 - it used to answer 501 ("ai-toolkit is not installed") from
    # inside that blueprint. This asserts the product-level fact (nothing under /lora is served and
    # nothing spawns); the module-level refusal below stays pinned as the second line of defense for
    # anything that still calls the launcher directly.
    response = client.post("/lora/subjects/synthetic/train", json={})
    assert response.status_code == 404
    assert not [rule.rule for rule in client.application.url_map.iter_rules()
                if rule.rule.startswith("/lora")]
    with pytest.raises(loratrain.TrainRefused, match="not available in Docker"):
        loratrain.launch_real(config=tmp_path / "config.yaml", log=tmp_path / "train.log")


def test_initialized_vault_without_credentials_allows_recovery_only(client, monkeypatch):
    monkeypatch.setattr(paths, "docker_encrypted_mode", lambda: True)
    monkeypatch.setattr(auth.STORE, "is_initialized", lambda: True)
    monkeypatch.setattr(auth, "auth_enabled", lambda: False)
    monkeypatch.setattr(auth, "creds_broken", lambda: False)
    monkeypatch.setattr(auth, "vault_locked", lambda: True)

    setup = client.get("/setup")
    assert setup.status_code == 200 and b'data-mode="recovery"' in setup.data
    csrf = re.search(rb'name="csrf-token" content="([^"]+)"', setup.data).group(1).decode()
    assert client.post("/vault/unlock-suk", json={"suk": "x"}).status_code == 503
    assert client.post("/vault/recover", headers={"X-CSRF-Token": csrf},
                       json={}).status_code == 400
