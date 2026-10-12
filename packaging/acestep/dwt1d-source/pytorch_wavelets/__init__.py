"""DWT1D operations retained from pytorch-wavelets 1.3.0."""

from pytorch_wavelets._version import __version__
from pytorch_wavelets.dwt.transform1d import DWT1DForward, DWT1DInverse

DWT1D = DWT1DForward
IDWT1D = DWT1DInverse

__all__ = ["__version__", "DWT1DForward", "DWT1DInverse", "DWT1D", "IDWT1D"]
