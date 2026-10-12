"""Generation backends: the one place this package talks to a model.

🔴 No generation client existed in Vocalis before 6.4 (design §7). `src/kobold.py` is admin-only
— load and unload — and nothing in the codebase called `/v1/chat/completions`. That is a feature:
this code cannot inherit anybody else's sampler defaults, and `base.PROFILE` is therefore the
only sampler block in the product that the editor uses.
"""
