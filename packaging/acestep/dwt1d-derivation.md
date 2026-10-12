# Derived DWT1D package

This source tree retains `DWT1DForward` and `DWT1DInverse` (also exported as
`DWT1D` and `IDWT1D`) from `pytorch-wavelets` 1.3.0. The original scoped
license is preserved at `dwt1d-source/pytorch_wavelets/LICENSE` with Fergal
Cotter's attribution. The exact source wheel and every derived file hash are
recorded in `dwt1d-source-artifact.lock.json`.

ACE constructs the transforms with `J=1` and `mode="zero"`. The analysis and
synthesis algorithms are unchanged. Symmetric padding is rejected explicitly
because its helper is part of the excluded mixed-provenance `utils.py`. DTCWT,
coefficient data, scatternet, and utilities are excluded before installation.
The derived tree grants no rights to those excluded components.
