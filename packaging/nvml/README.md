# nvidia-ml-py (NVML bindings) for the NVIDIA images

One pinned wheel, installed without network into the NVIDIA main image and the NVIDIA satellite image
(design section 10, "Whole-card memory and readings on NVIDIA, and on AMD satellites", October 10, 2026).
It lets Vocalis ask the NVIDIA driver how much of a card is used in total, which PyTorch's own number does
not show on Windows, and read the card's name, busy, temperature, power, clocks and fan.

| What | Value |
| --- | --- |
| Package | `nvidia-ml-py` 13.615.71 (module `pynvml`), pure Python, no dependencies |
| File | `nvidia_ml_py-13.615.71-py3-none-any.whl`, 58,132 bytes |
| SHA-256 | `959bf4adf6fe1308e4bd739e722236b0d1ec8392e2cefad33ff70c311380b9b6` |
| Source | PyPI (`pip download nvidia-ml-py==13.615.71 --no-deps`), fetched October 10, 2026 |
| License | BSD 3-Clause, NVIDIA Corporation; text in `LICENSE-nvidia-ml-py.txt` (taken from the module header, the wheel has no license file) |

Install with the lock, never from an index:

```sh
python -m pip install --no-index --no-deps --require-hashes --only-binary=:all: \
  --find-links=<this folder in the build context> -r requirements.lock
```

The wheel also installs a top-level `example.py` (NVIDIA's sample). Nothing imports it.
