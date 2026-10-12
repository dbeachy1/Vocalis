"""Process-wide runtime: the state that outlives a request but belongs to no one feature.

The job registry, the GPU arbitration gate, the model worker pools, engine lifecycle. None of
it is HTTP and none of it is leaf domain logic, which is exactly why it accumulated in the
middle of `vocalis_server.py` — there was nowhere else for it to go. This is that nowhere.

Membership test: if two or more feature domains read or write it, and it is not a request, it
belongs here. `5.1-refactor` §5 has the measured list and the verdict for each.
"""
