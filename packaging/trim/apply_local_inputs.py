#!/usr/bin/env python3
"""Apply the reviewed PANNs local-input patch to its installed 0.1.1 source."""
from __future__ import annotations
import hashlib
import sys
from pathlib import Path

EXPECTED = {
    "config.py": (
        "1510a0a04a68b3e179617f7e01d9c14df5326e120b4c04a9810921f556feba28",
        "8e8b58fb8503a4e6b064a8639b07d3581d2b8bb924d6c1e1fe218308fc6d30d3",
    ),
    "inference.py": (
        "f0c3343ab5d10616f8e44ce436ab52529f7d856e11bc6953f688b5485f86d28a",
        "4293ddce865bdf00dbfc4c067c596940619162dea2e1f40d15e337ebf890e775",
    ),
}

REPLACEMENTS = {
    "config.py": [(
        """labels_csv_path = '{}/panns_data/class_labels_indices.csv'.format(str(Path.home()))

# Download labels if not exist
if not os.path.isfile(labels_csv_path):
	os.makedirs(os.path.dirname(labels_csv_path), exist_ok=True)
	os.system('wget -O "{}" "http://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/class_labels_indices.csv"'.format(labels_csv_path))""",
        """model_root = os.environ.get("VOCALIS_TRIM_MODEL_ROOT")
if not model_root:
    raise RuntimeError("VOCALIS_TRIM_MODEL_ROOT is required for local PANNs labels")
labels_csv_path = str(Path(model_root) / "class_labels_indices.csv")
if not os.path.isfile(labels_csv_path):
    raise FileNotFoundError("Trim AudioSet labels are missing: {}".format(labels_csv_path))""",
    )],
    "inference.py": [(
        """        if not checkpoint_path:
            checkpoint_path='{}/panns_data/Cnn14_mAP=0.431.pth'.format(str(Path.home()))
        print('Checkpoint path: {}'.format(checkpoint_path))
        
        if not os.path.exists(checkpoint_path) or os.path.getsize(checkpoint_path) < 3e8:
            create_folder(os.path.dirname(checkpoint_path))
            zenodo_path = 'https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1'
            os.system('wget -O "{}" "{}"'.format(checkpoint_path, zenodo_path))""",
        """        if not checkpoint_path:
            raise ValueError("An explicit local PANNs checkpoint path is required")
        print('Checkpoint path: {}'.format(checkpoint_path))
        if not os.path.isfile(checkpoint_path):
            raise FileNotFoundError("PANNs checkpoint is missing: {}".format(checkpoint_path))""",
    ), (
        """        # Model
        if model is None:
            self.model = Cnn14(sample_rate=32000, window_size=1024, 
                hop_size=320, mel_bins=64, fmin=50, fmax=14000, 
                classes_num=self.classes_num)
        else:
            self.model = model

        checkpoint = torch.load(checkpoint_path, map_location=self.device)
        self.model.load_state_dict(checkpoint['model'])""",
        """        # Model
        if model is None:
            self.model = Cnn14(sample_rate=32000, window_size=1024, 
                hop_size=320, mel_bins=64, fmin=50, fmax=14000, 
                classes_num=self.classes_num)
        else:
            self.model = model

        # Preserve PyTorch's restricted unpickler; this pinned checkpoint stores NumPy metadata.
        with torch.serialization.safe_globals([
            np.core.multiarray._reconstruct,
            np.ndarray,
            np.dtype,
            type(np.dtype("int64")),
        ]):
            checkpoint = torch.load(checkpoint_path, map_location=self.device,
                                    weights_only=True)
        self.model.load_state_dict(checkpoint['model'])""",
    )],
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply_local_inputs.py <panns_inference directory>")
    root = Path(sys.argv[1])
    if root.name != "panns_inference" or root.is_symlink() or not root.is_dir():
        raise SystemExit("Refusing an unexpected PANNs package directory")
    for filename, (source_hash, patched_hash) in EXPECTED.items():
        path = root / filename
        original = path.read_bytes()
        if sha256(original) != source_hash:
            raise SystemExit(f"Refusing unexpected PANNs source: {filename}")
        text = original.decode("utf-8")
        for before, after in REPLACEMENTS[filename]:
            if text.count(before) != 1:
                raise SystemExit(f"Expected one reviewed patch hunk in {filename}")
            text = text.replace(before, after, 1)
        patched = text.encode("utf-8")
        if sha256(patched) != patched_hash:
            raise SystemExit(f"Patched source hash mismatch: {filename}")
        path.write_bytes(patched)
        if sha256(path.read_bytes()) != patched_hash:
            raise SystemExit(f"Post-write source hash mismatch: {filename}")
        print(f"PATCHED {filename} {source_hash} -> {patched_hash}")
    cache = root / "__pycache__"
    if cache.is_symlink():
        raise SystemExit("Refusing symlinked PANNs bytecode cache")
    for bytecode in (cache / "config.cpython-312.pyc", cache / "inference.cpython-312.pyc"):
        if bytecode.exists():
            bytecode.unlink()
        if bytecode.exists():
            raise SystemExit(f"Stale PANNs bytecode remains: {bytecode.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
