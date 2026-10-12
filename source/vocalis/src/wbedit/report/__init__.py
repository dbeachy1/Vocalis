"""Report writers — subscribers to the runner's event stream.

This is one of the two authorized destinations for document text (I16, §10): reports include
before/after bodies. Logs, tracebacks, error payloads, and SSE frames must remain content-free;
the report and review-queue payload are the explicit exceptions.

⚠️ Nothing here opens a file. A writer is handed in, so the vault owns the bytes and
`test_m6_writer_census.py` stays green — see `wbedit/__init__.py`.
"""
