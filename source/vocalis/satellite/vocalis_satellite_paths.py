"""Resolve satellite-owned paths for legacy and mounted deployments."""
import os
from pathlib import Path


HERE = Path(__file__).resolve().parent


def _path(env_name: str, default: Path) -> Path:
    """Return an explicit absolute override or the existing standalone default."""
    raw = os.environ.get(env_name)
    if raw is None:
        return default
    value = raw.strip()
    if not value:
        raise RuntimeError(f"{env_name} is set but empty")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise RuntimeError(f"{env_name} must be an absolute path")
    return path


def configured(env_name: str) -> bool:
    return env_name in os.environ


def require_directory(path: Path, env_name: str) -> Path:
    """Require an explicitly mounted directory without creating or repairing it."""
    if not path.is_dir():
        raise RuntimeError(f"{env_name} directory is missing or not a directory: {path}")
    return path


CONFIG_FILE = _path("VOCALIS_SATELLITE_CONFIG", HERE / "satellite.yaml")
CERT_DIR = _path("VOCALIS_SATELLITE_CERT_DIR", HERE / "certs")
LOG_DIR = _path("VOCALIS_SATELLITE_LOG_DIR", HERE / "logs")
WORK_DIR = _path("VOCALIS_SATELLITE_WORK_DIR", HERE / "work")
LEADVOCAL_WORK_DIR = WORK_DIR / "leadvocal"
