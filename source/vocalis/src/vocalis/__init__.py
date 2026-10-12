"""The Vocalis package contains shared runtime and web-layer code extracted from `vocalis_server.py`.

`src/` is on `sys.path`, so modules import as `vocalis.runtime.jobs`. Flat service modules beside
this package keep their existing top-level names. The package owns process-wide runtime behavior
and the HTTP surface as it is migrated.

Code under this package must not import `vocalis_server`; `tests/test_import_graph.py` enforces the
dependency direction. Move shared values into this package or pass them in from callers rather than
creating a package-to-server import cycle.
"""
