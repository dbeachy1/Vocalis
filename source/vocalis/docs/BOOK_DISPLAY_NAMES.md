# Book display names and rename

## Contract and scope

Book → Library cards and the Chapters heading show a friendly title. The automatic
title is the source document stem followed by the selected voice's current label in
parentheses; use the existing narrator-name fallback when no label exists, and omit
the suffix for the model default. Existing sidecar-backed books receive this display
without a migration. An explicit user rename overrides the automatic title and
survives rendering, resume, finalization, restart, and later voice-label changes.
Keep the voice filename available as secondary metadata. Users can rename queued,
actively rendering, unfinished, finished, and imported books from the library and
the selected book's Chapters actions. Duplicate display names are allowed because
they do not identify stored books.

Storage folder names, API references, voice identity, cache keys, chapter names,
audio, folder membership, regeneration, and render/resume selection do not change.
This is a focused naming fix, not a storage migration or renderer redesign.

## Ownership and interfaces

The existing per-book `vocalis-book.yaml` owns one optional `display_name` string.
`book_state` writes it with its existing per-book lock and atomic vault-aware
writer, using strict reads so a corrupt sidecar is never replaced. Initialization
must preserve it. Renaming an imported book may create a minimal sidecar; it must
not invent voice, source, chapter completion, duration, or render time records.
Keep `has_sidecar` as physical sidecar presence; add `has_render_metadata` based
on actual recorded source/voice/params/chapters fields so minimal renamed imports
still show the existing imported/no-render-metadata indicator. Check recorded
field presence/shape, not voice truthiness: the model-default voice is empty.

Library and output JSON keep `book` as the stable reference and add `display_name`
and `voice_label`. The current labels come only from `voice_utils.get_labels` with
the existing configured voice-settings path. Pass labels into presentation helpers
without introducing a book-state dependency on Flask/runtime modules. Books without
enough source metadata retain their folder name as the automatic title.

`POST /book/<book>/rename` accepts `{name: string}` and returns the resulting stable
reference and display name. Require a nonempty trimmed name, reject control
characters/non-string input, and support up to 512 characters. Path punctuation is
allowed because this is metadata. Missing books return 404; unreadable sidecars
return a non-destructive error. Follow existing login, SameSite cookie, and
vault-lock gates.
Logs may record rename success/failure, never the private title or book path.

## In-progress sequencing and concurrency

Rename must work before the first chapter and while chapter updates/finalization
are writing. Use the existing per-book lock for every read-modify-write; initialize
preserves a rename that arrived first. The brief pre-sidecar interval must have a
stable reference, friendly title, and rename action from `/book/jobs`: for book
jobs expose `book: j.out_name` from registration, even when `output_dir` is unset.
Use that exact reference rather than deriving it from the nullable output path.
A rename in this interval may create only
the minimal display sidecar for a verified registered book job. Never create an
arbitrary book because a URL was posted. Renderer setup must not erase that name.
Validate audio/sidecar existence or the exact registered live job while holding
the same per-book lock as the rename write. `book_clear` holds that lock around
its existence check and removal, so a concurrent rename cannot recreate a deleted
book through the atomic writer's parent-directory creation.

`rendered_at` is derived only from audio artifact mtimes; a book with no audio is
undated (0). Sidecar and directory mtimes must not turn a cosmetic rename into a
new render or move an old book to the top of Newest render.

## UI and acceptance

Reuse `promptForName` with a prefilled input, Cancel and Save; the server enforces
the length limit. Successful
rename refreshes the shelf and selected heading while keeping the selected stable
reference, folder membership, and playback intact. Filtering, title sorting, and
human-facing confirmations use the display name; all requests use the stable ref.
Escape titles in HTML. Show the friendly voice name before the raw voice filename.

Prove label propagation by changing only voice settings, and prove explicit title
stability after that change. Tests cover legacy/default/unlabeled/imported books,
rename before first chapter and after completion, resume/finalize preservation,
concurrent sidecar writes, missing/corrupt/traversal/invalid inputs, encrypted
round-trip, and unchanged stable refs/audio/folder membership. Browser verification
uses isolated synthetic fixtures to exercise Save, Cancel, reload, filtering,
sorting, active placeholders, and Chapters actions; inspect rendered screenshots.
Run the existing relevant book/state/server/folder/browser suites and npm checks.

Ship as 11.7.0 after the standard independent design review, implementation,
acceptance, and one final complete-candidate review. Push main, deploy the encrypted
instance through the existing runbook, verify the health version and served
UI assets. Restart locks the vault; do not inspect unrelated instance data.

## Independent design review

Reviewed by fresh `gpt-6-sol`, High, agent `/root/design_review`, against source
baseline `8ab3260058afb169b49c961ee111dfd6e6ec8242`, September 30, 2026.
Findings addressed: queued stable references; minimal imported metadata indicators;
reuse of name dialog and existing SameSite/login/vault gates; rename/delete
serialization; audio-only render timestamps. The same reviewer verified the final
revision and accepted it with no remaining blocking findings.
