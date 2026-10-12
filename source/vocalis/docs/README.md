# docs/

Three documents live here. They are the ones someone **running** Vocalis needs.

| | |
|---|---|
| [`SILLYTAVERN_EXTENSION.md`](SILLYTAVERN_EXTENSION.md) | the TTS extension — what it is, how it talks to the server, install and troubleshooting |
| [`RESTORE_5_0.md`](RESTORE_5_0.md) | getting your data back. Written on the assumption you are having a bad day, so the procedure comes first and the reasoning last |
| [`DESIGN_SINGLE_USER.md`](DESIGN_SINGLE_USER.md) | why Vocalis is single-user by design, and why multi-user is expensive |

## The design docs are not here anymore

Sixty-four milestone design documents used to sit in this folder. They were development
records — `Status: COMPLETE (4.1-m16)` and a table of what each milestone landed — not
documentation, and they are no longer tracked in git.

**Source comments still cite them, without a path:**

```python
# Split out of `vocalis_server.py` in 5.1-P1 (5.1-refactor §7, Phase 1.1). It lives here
```

A citation names the document and the section — `DESIGN_5_2_PRERENDER §3.2`,
`SPEC_5_0_M1`, `5.1-refactor §2.1`. The path is deliberately absent, because a path that
resolves to nothing is worse than a name that at least says what to go and find.

The private archive remains outside the repository. If you are reading this from a clone and
want the reasoning behind a decision, the commit history and the code are what you have —
which is usually enough, because the docs that mattered most were the ones where a
measurement overturned a design, and those verdicts are in the code as comments already.
