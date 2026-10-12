# SillyTavern Extension — reference

The Vocalis TTS (streaming) extension for SillyTavern: what it is, how it talks
to the server, how voices get assigned, and how to install and troubleshoot it.

This is the **reference** doc — the full picture, including the server side.
[`sillytavern/README.md`](../sillytavern/README.md) is the short operator-facing
version that ships next to the extension itself; if the two ever disagree, the
code wins and both should be fixed.

Current as of Vocalis **5.2**. The extension has been on the streaming path since
3.0-M4, and pre-renders new messages since 5.2 (§10).

---

## 1. What it is

A standalone SillyTavern **UI extension** that plays chat messages through
Vocalis's real-time streaming path. Audio starts within a couple of seconds
while the rest of the message is still rendering, with full-chunk prosody — the
same engine path the Nomi Chrome extension uses.

What the user gets:

- A 🔊 speaker button on **every message** (AI's or the user's own) that plays
  or stops that message.
- **Hold that button for 600 ms** to re-render the line instead of replaying the
  cached take — the same gesture as the Nomi extension's button (§5).
- Optional **auto-narrate**: new AI replies start playing as they land.
- **No LLM needed to narrate.** Narration reads the chat *log*, so any message
  already in the history can be clicked and spoken. Text generation only matters
  for auto-narrate, which fires on freshly generated replies.
- A **[Retry] / [OK]** dialog if a stream dies mid-generation.

### What it deliberately is *not*

It does **not** register as a SillyTavern TTS provider. ST's built-in provider
framework only supports whole-file responses, which would throw away the entire
point — streaming. The extension is its own player sitting directly on the
streaming path. (Vocalis still exposes `POST /v1/audio/speech` for whole-file
OpenAI-compatible callers; the extension doesn't use it.)

Consequence: ST's built-in TTS extension is unrelated and should be left **off**,
or you get two narrations.

---

## 2. Files

The extension is five files in the Vocalis repo:

| File | Role |
|---|---|
| [`sillytavern/extension/manifest.json`](../sillytavern/extension/manifest.json) | ST extension manifest (`display_name`, `js`, `css`) |
| [`sillytavern/extension/index.js`](../sillytavern/extension/index.js) | UI: settings drawer, message buttons, ST event wiring |
| [`sillytavern/extension/vocalis-stream.js`](../sillytavern/extension/vocalis-stream.js) | The streaming player: register → progressive-MP3 pull → MediaSource pump → `/status` check |
| [`sillytavern/extension/polish-send.js`](../sillytavern/extension/polish-send.js) | The optional full-context Polish Text and Send composer action |
| [`sillytavern/extension/style.css`](../sillytavern/extension/style.css) | Styling for the button + settings drawer |

The server side it talks to:

| File | Role |
|---|---|
| [`src/vocalis_stream_http.py`](../src/vocalis_stream_http.py) | The stream blueprint: `POST /v1/audio/stream` register, the one-time `GET /speak/stream/<token>`, `/status`, and the 5.2 pre-render routes |
| [`src/prerender.py`](../src/prerender.py) | 5.2: the speculative-render queue, its gate, the spool and the join-in-progress follower |
| [`src/mp3_render.py`](../src/mp3_render.py) | 5.2: text -> encoded progressive MP3 off the shared pool, shared by the live route and the pre-render producer |
| [`src/st_characters.py`](../src/st_characters.py) | The character → voice/params registry and its HTTP surface |
| [`src/vocalis_server.py`](../src/vocalis_server.py) | `/health`, `/v1/audio/voices`, `/v1/audio/speech`, CORS + auth rules |
| [`src/webui/index.html`](../src/webui/index.html) | The web UI's **SillyTavern tab** — where voices are actually assigned |

Tests:

| File | Covers |
|---|---|
| [`tests/test_st_characters.py`](../tests/test_st_characters.py) | The registry: upsert-vs-assign semantics, full-map replace sanitization, corrupt-file write guard, both route groups |
| [`tests/test_sillytavern.py`](../tests/test_sillytavern.py) | The OpenAI-compatible speech endpoint contract + voice resolution (no GPU; `speak` is faked) |
| [`tests/test_st_extension_smoke.py`](../tests/test_st_extension_smoke.py) + [`tests/st_player_smoke.mjs`](../tests/st_player_smoke.mjs) | The **real** `vocalis-stream.js` under Node against a **real** werkzeug server running the real blueprint — real sockets, real chunked MP3 through real ffmpeg. Proves register, error-shape parsing, cross-origin URL resolution, the `/status` truncation check, and the retry closure. Skips if node isn't installed. |
| [`tests/test_stream_http.py`](../tests/test_stream_http.py) | The stream blueprint itself (tokens, cache tee, concurrency cap, cancel) |
| [`tests/test_prerender.py`](../tests/test_prerender.py) | 5.2: cache-key identity across both routes, the queue, the gate, preemption, join-in-progress, cancel, and a vault lock mid-render |

---

## 3. The core design decision: voices live on the server

**The extension never picks a voice. It sends speaker names and, when available,
their stable avatar filenames.**

This is the single most important thing to understand about the integration, and
it's a deliberate reversal of an earlier design (a pre-M4b client-side voice map,
which `index.js` still actively deletes from saved settings on load).

Characters and narratable personas get into Vocalis automatically:

1. **Chat opens** → the extension fires `POST /v1/st/characters` with the
   character name (or, in a group chat, every member's name). This makes the
   character assignable — and auditionable — in the web UI *before* its first
   narration.
2. **Every narration** carries a `character` field, and the stream register
   auto-upserts names it hasn't seen. Group members therefore appear organically
   even without path 1.
3. **A persona imported from Vocalis** is registered immediately after SillyTavern
   confirms both its settings entry and final avatar filename. This makes it
   assignable before its first narration; a registration outage does not roll back
   the successfully landed persona. User-message narration sends the persisted
   persona avatar filename so duplicate display names remain distinct.

The admin then assigns voice + delivery knobs per character in the **Vocalis web
UI → SillyTavern tab** (voice dropdown, exaggeration/cfg/temperature, a streaming
▶ Audition button, Save). That persists to the `sillytavern` section of
`voice_settings.yaml`, keyed by character name, with a sibling `default_voice`.

An auto-registered but unassigned character is `{"voice": "", "last_seen": ...}`
— it speaks with the default voice, and its params are the chatterbox defaults.

### Voice resolution precedence

On each `POST /v1/audio/stream`, the server picks the voice in this order:

1. an explicit `voice` in the request body (a `voice_samples/` stem — resolved by
   the *same* resolver as `/v1/audio/speech`). The extension never sends this,
   but the endpoint honors it.
2. the character's server-side assignment (the `sillytavern` section).
3. the section's `default_voice`.
4. backstop: the Nomi map's `default_voice`.

If **none** resolve, the server logs a loud warning and renders with whatever
conditionals each pool worker last used — which means **different chunks of one
message can come out in different voices**. That was observed live; it's why the
resolver tries so hard to end up at a concrete file. Set a `default_voice`.

### Param resolution

Params are the character's **own** values, else the chatterbox defaults. There is
**no** per-voice fallback and no borrowing from another tab — settings are
per-entity. Ranges (`src/st_characters.py`):

| Param | Default | Range |
|---|---|---|
| `exaggeration` | 0.5 | 0.0 – 3.0 |
| `cfg` | 0.5 | 0.0 – 1.0 |
| `temperature` | 0.8 | 0.0 – 3.0 |

Registry limits: 500 characters, 64-char names. The name `default_voice` is
reserved (it's the section's one non-entry key) and is rejected as a character
name. Assigned voices are stored leaf-only (`Path(voice).name`) — no traversal.

Persistence goes through `voice_utils` (the shared settings lock + strict
loader): if `voice_settings.yaml` is corrupt, writes are **refused** rather than
overwriting the file with an empty in-memory map. The file survives for hand
repair, and the PUT returns a 500 saying so.

---

## 4. API contract

Everything the extension calls is **CORS-enabled** — it has to be, because the
browser is on the SillyTavern origin and Vocalis is a different host — and since
**7.0-m6** everything except `/health` is **authenticated**: `/v1/*` and `/pair/*`
both demand `Authorization: Bearer <pairing token>`. The web UI *page* is
login-gated; `/health` stays open (it is how a client tells "locked" from
"down"); `/speak*` is knowingly open pending its own milestone (m6 §6.1 — the
Nomi channel, a different client with its own install path).

### 4.0 The 5.0 lock gate — "reachable" is not "available"

**History, kept because the reasoning explains the code:** narration carried no
credential from 5.0-M0 through 7.0-m6 — `/v1/*` was auth-exempt and the
capability was the vault being unlocked. Design §10 specified a token;
`SPEC_5_0_M5.md` §9.1 deferred it, on the reasoning that the only user content on
`/v1/*` was character NAMES and "anyone who can reach the port" meant one user on
their own LAN. **One-Vocalis-per-user (7.0-m6) ended that**: an open `/v1/*` let any
LAN user burn another user's GPUs, enumerate voice names, confirm narrated text
through `/v1/audio/state`, and cancel builds. See `DESIGN_7_0_M6_ENDPOINT_AUTH.md`.

🔴 **Since m6 the pairing token is REQUIRED for narration** — the same token
`/pair/*` has carried since 7.0-m2, generated in the Vocalis web UI under
Settings and pasted into the extension once. There is no separate "narration
key": one token, both families. For any other OpenAI-compatible client it is
simply **the API key**. A user who has never pasted it gets a 401 in OpenAI's
error shape, and the extension's §6.2 guidance toast says where to get it.

⚠️ **The two families are still deliberately distinct.** Worldbooks, character
cards and personas travel on `/pair/*` and nowhere else; narration is `/v1/*`.
Sharing the credential does not merge the channels.

What replaced it is `_require_unlocked` ([`src/vocalis_server.py:1970`](../src/vocalis_server.py)):
once a vault is initialized, a **locked** Vocalis serves audio to nobody, and that
explicitly includes the open machine endpoints. So on a 5.0 install the extension
has three states, not two:

| Vocalis state | `/health` | `/v1/*` | Extension |
|---|---|---|---|
| down / wrong URL | fails | fails | Test says `unreachable: …` |
| up, vault **locked** | **200**, `"locked": true` | **401** `{"error":"locked","message":…}` | Test says **LOCKED**; narration toasts the unlock instruction |
| up, vault unlocked | 200, `"locked": false` | normal | normal |

`/health` is deliberately exempt from the lock gate — it is how the extension can
tell "locked" apart from "down". Both the Test button and the register error path
read that, and they must keep doing so: a reachable-but-locked server that reports
a green OK sends the user hunting for a TTS bug that is really a shut vault.

**Unlocking is a human action on the Vocalis side** — log in to the Vocalis web UI.
The DEK lives only in that process's RAM, so *any* Vocalis restart or crash re-locks
it and narration stops until someone logs in again. Nothing on the SillyTavern side
can unlock it, and nothing on the SillyTavern side needs to store a secret for it.

### `GET /health` — reachability probe (the **Test** button)

```json
{"status": "ok", "product": "Vocalis", "version": "4.1-m4",
 "model_ready": true, "model_loading": false,
 "auth": true, "comfyui": true}
```

The settings drawer renders this as `OK — Vocalis v4.1-m4, model ready` (or
"model cold (loads on first use)").

### `POST /v1/st/characters` — character push (bearer-gated since 7.0-m6, CORS'd, **upsert-only**)

```json
→ {"characters": ["Test Character 1", "Test Character 2"]}
← {"registered": 2}
```

Upsert-only by design: it can never change or delete an existing assignment, so
leaving it unauthenticated has bounded exposure.

### `POST /v1/audio/stream` — the narration register

Payload mirrors `/v1/audio/speech` plus `character`. `model`, `response_format`,
and `speed` are accepted and ignored (the stream is always progressive MP3).

```json
→ {"input": "<text>", "character": "Test Character 1",
   "voice": "<optional stem>", "force": false, "narrate_actions": true}
← {"stream_url": "/speak/stream/<token>",
   "status_url": "/speak/stream/<token>/status",
   "cached": false, "cache_key": "<md5>"}
```

The extension sends `{input, character}`, plus `force: true` for a long-press (§5).

- `narrate_actions` (default **true**): `*action*` spans are spoken with the
  markup stripped. Set false for dialogue only. Filtering happens **server-side**
  (`tts_utils.filter_actions`) — which is exactly why `index.js`'s `cleanText()`
  deliberately does **not** touch asterisks. Pre-stripping client-side would
  blind the server's filter.
- `force`: re-render instead of serving the cache. It is **not** part of the cache
  key (which is voice+params+text), so a forced render replaces the entry it
  re-rolls rather than creating a second one. A forced register also refuses to
  join a pre-render of the same text and stands that speculation down — see §5
  and §10.
- Errors use the OpenAI shape (`{"error": {"message": ..., "type": ...}}`), like
  the rest of `/v1`.

The returned URLs are **relative**; the client resolves them against the server
base (they're cross-origin, so this matters).

### `GET /speak/stream/<token>` — the one-time stream

- **Cache hit** → the whole cached MP3 (`audio/mpeg`), instantly, with an
  `X-Cache-Key` header. Cache hits never consume a concurrency slot.
- **Otherwise** → ONE continuous progressive-MP3 stream (`audio/mpeg`, chunked).
  Chunk 1 token-streams; chunks 2+ bank and splice; the PCM is piped through
  `ffmpeg` → mp3 at 96k as it's generated. The browser starts playing as soon as
  it has a little data.

The token is one-time. A second GET serves the cached MP3 once the tee has
landed, else **410** (browsers do occasionally re-request a media URL).

**Caching:** ST chat lines *are* cached — MD5 of voice+mtime+params+text through
the shared `NomiSpeaker` cache, the same dir and eviction as `/speak`. Re-clicking
a message is the common case and it replays instantly. The tee captures the
**encoded MP3 bytes** as they ship, so the cached file is byte-identical to what
the listener heard: zero extra encode, ~4× smaller than the pre-3.x WAV cache. It
is promoted atomically on completion.

(Note the older claim that "chat lines are never cached server-side" — that's
stale. They are.)

### `GET /speak/stream/<token>/status` — the truncation check

```json
{"state": "new|live|done|error|canceled|unknown", "error": "str|null"}
```

- `done` — rendered to completion.
- `error` — died mid-generation; **playback was truncated**.
- `unknown` — token expired or never existed; can't verify.

### `GET /v1/audio/voices`

The voice stems the server offers. The extension exposes a `fetchVoices()` helper
for it, though voice choice now lives server-side.

### The pairing channel (`/pair/*`, bearer-gated) — 7.0-m2 / m2i

Every rule under `/pair/` requires `Authorization: Bearer <pairing token>`. The gate
is a **blueprint `before_request`**, not a per-route decorator, so a route added later
is covered without anyone remembering to cover it — and `tests/test_pair_surface.py`
walks the live URL map to keep that true.

- `GET /pair/ping` → `{"paired": true}`. The Test button's pairing clause.
- `POST /pair/documents` → import a worldbook or a character card.
  ```json
  {"st_ref": "Sample World Book", "document": { ... }}
  ```
  `st_ref` is **SillyTavern's own key** — a book's NAME, a card's AVATAR FILENAME — and it
  is required. 🔴 **A second push of the same `st_ref` mints revision N+1 on the existing
  Library row**, it does not file a duplicate. Answers `201` on create, `200` on revise,
  with `{"id", "kind", "created", "revision"}` and no document content.
  🔴 **The kind is detected from the document, never declared** — a `"kind"` in the body
  is ignored.
- `POST /pair/documents/<id>/avatar` → the card PNG, **raw `image/png` body**, stored
  byte-for-byte. Cards only. Nothing decodes it (§4.3: a re-encode flattens an animated
  PNG and strips ComfyUI chunks).

🔴 **A LOCKED VAULT ANSWERS 401 ON `/pair/*`, AND IT IS NOT "WRONG TOKEN".**
`_require_unlocked` is an app-level `before_request`, so it runs *before* this family's
bearer gate and 401s every call while the vault is shut — with a correct token in hand.
The two are distinguishable only by body:

```
locked    401 {"error":"locked","message":"Vocalis is locked. Log in to unlock."}
no token  401 {"error":"pairing required","paired":false}
```

Reading a locked vault as "not paired" tells the user to re-copy a correct token, and the
next thing they press is **Generate** — which rotates the secret and revokes a working
pairing.

### 🔴 THE IMPORT IS DRIVEN FROM VOCALIS. THERE IS NO BUTTON IN THIS DRAWER. (7.0-m2j)

The **Vocalis Library** owns the import workflow: `⟳ Import from SillyTavern` is available on both the
Character Cards and World Books panes; one press brings **everything** — every book and
every character. Keep import initiation in Vocalis; persona building follows the same rule
(design §8.2a).

- `GET /pair/poll` → `{"sweep": true|false}`. The extension calls this every 5s. It is both
  the heartbeat (so Vocalis can say *"no SillyTavern tab is open"* rather than spinning) and
  the channel the button arrives through. 🔴 **The pending sweep is CLAIMED** — the server
  clears it in the same lock, so two open SillyTavern tabs cannot both run it.
- `POST /pair/sweep` → the extension's summary: `{books, cards, unchanged, errors[]}`. Posted
  **even when the sweep fails**, because only this ends the run.

⚠️ **Vocalis cannot fetch from SillyTavern itself, and that is why the extension does the
work.** ST runs `enableUserAccounts: true` / `basicAuthMode: false`, so its API answers a
logged-in session and nothing else; giving Vocalis one means storing the user's SillyTavern
password in a second product. The extension is already inside the authenticated page.

📌 **An unchanged document mints no revision.** The button is meant to be pressed again —
without that, three presses would stamp three identical revisions on every document.

### Admin surface (login-gated — the web UI's ST tab, not the extension)

`/st/*` is **not** on the auth-exempt list, so these require a session:

- `GET /st/characters` → `{characters, default_voice, voice_options}`
- `PUT /st/characters` → full-map replace, values sanitized. Incoming `seed` /
  `turbo` keys (pre-3.x clients) are silently dropped.

---

## 5. Client behavior

### The truncation contract

A truncated stream is otherwise **indistinguishable from a finished one** — the
audio element just fires `ended` either way. So when playback ends, the client
fetches the stream's `/status`. If `state === "error"`, it fires `onTruncated`,
and `index.js` raises a CONFIRM popup: *"playback stopped early — the server hit
an error mid-generation"* with **[Retry] / [OK]**. Retry re-runs the same text
(a fresh register). If `/status` can't be reached, the stream is treated as
complete. This matches the Nomi and web-UI clients.

### Playback rules

- **One playback at a time.** Starting a message stops the previous one; clicking
  the same message's button while it plays stops it (toggle).
- **Hold to re-render.** Press and hold the speaker for 600 ms and the spinner
  starts under your finger — that *is* the "armed" feedback. Release and the
  message re-renders with `force: true` instead of replaying the cache. Release
  before the spinner appears, or slide off the button, and it stays an ordinary
  click. Renders are unseeded (identity is voice+params+text), so a forced render
  is simply a **different take of the same line** — which is the entire point of
  the gesture, and why the server must not quietly hand back a pre-render of that
  same text (§10).

  It is wired with **pointer** events, delegated on `document`: ST creates and
  destroys `.mes` nodes constantly, so there is no element to hold press state on,
  and a touch fires no `mousedown` until the tap has already completed. Keyboard
  activation (the button is `interactable tabindex="0"`, so ST turns Enter/Space
  into a click) plays normally and has no force route — it is a gesture, and the
  plain click is the safe outcome. On a touchscreen the same hold is the OS
  text-selection gesture, so `style.css` sets `-webkit-touch-callout`/`user-select`
  to `none` and the extension swallows `contextmenu` on that button.
- Switching chats, swiping, or deleting a message stops playback.
- Stopping **cancels the server render** — the client aborts the fetch, and the
  server's disconnect handling cancels the pool batch and kills ffmpeg. No
  orphaned GPU work.

### Finding the message that is playing (9.1 §1)

Playback may continue while the user scrolls through the chat, so the active message needs a
visible location marker that remains available while playback is paused.

Two markers, on **two different conditions**, and the difference is the point:

| Marker | Where | On when |
|---|---|---|
| **Yellow header band** | ST's `.ch_name` — the full-width strip carrying the speaker's name | a message is **loaded** (`current` is set, i.e. the button shows ⏹) — **including while paused** |
| **Red ⏹ square** | the narrate button itself | the clip is **audible** (`audio.paused === false`) |

🔴 **The band survives a pause on purpose.** The yellow band tracks the loaded message, not
audible playback, so it remains a location marker while audio is paused.

⚠️ **The band is recomputed from `current` on every repaint** (`paintSpeakingRow`,
hung off `setBtnState`), never painted once at playback start. The fork's chat
windowing destroys a row that scrolls out of the viewport and builds a new one from
`#message_template` on the way back — that is the 7.4 §18c bug that made the ⏹ glyph
itself disappear, and a band painted once would reproduce it in the one feature
whose entire purpose is to survive a scroll.

📌 **On the band, the four state colors are re-tuned** (`style.css`, foot of file).
They were all chosen against ST's dark chat and none survives being put on `#ffd23f`:
the cached green lands at **1.73:1**. `.ch_name`'s own text is forced dark for the
same reason — every ST dark theme drives it from `--SmartThemeBodyColor`, so without
that the speaker's name is the least legible thing on the row the band is marking.
`.vocalis_narrate` is exempted from the dark foreground (`:not(.vocalis_narrate)`)
because it is the one icon in the strip still carrying information.

### Transport fallback

The player prefers `MediaSource` with `audio/mpeg` (the progressive pump). If the
response is `audio/wav`, or `MediaSource`/`audio/mpeg` isn't supported, it falls
back to buffering a blob and playing that. The Node smoke test exercises the blob
path; the MediaSource pump is the field-proven Nomi v1.5 recipe and is validated
in the browser.

### Text cleaning (`index.js` → `cleanText`)

`chat[i].mes` is raw markdown. The extension substitutes ST macros, then strips
code fences, embedded images, and HTML tags (pairs with contents, then strays),
and collapses whitespace. **Asterisks are left alone on purpose** — see
`narrate_actions` above. There is no shared ST helper for this; the built-in TTS
extension takes the same approach.

### ST integration points

Everything goes through `SillyTavern.getContext()` — the docs-recommended global,
no fragile `../../..` imports. Verified against ST 1.18.0. jQuery and toastr are
ST page globals.

Events subscribed:

| Event | Action |
|---|---|
| `CHARACTER_MESSAGE_RENDERED` | auto-narrate (with a dedup guard — it can re-fire for one message) |
| `CHAT_CHANGED` | stop playback, push the new chat's character(s) |
| `GROUP_UPDATED` | re-push members (membership changed) |
| `MESSAGE_SWIPED` | stop playback |
| `MESSAGE_DELETED` | stop playback |

Settings live in `extensionSettings.vocalis`: `{enabled, autoNarrate, preRender,
serverUrl}`.

---

## 6. Concurrency + DoS posture

The register routes are unauthenticated, so without a cap a caller could open
unlimited streams — each one an ffmpeg process + a pool batch + a writer thread
(fan-out DoS).

- `MAX_CONCURRENT_STREAMS` = **8** (override with `VOCALIS_MAX_STREAMS`). A 9th
  live stream gets **503** until a slot frees. Cache hits never take a slot.
- **Text length is deliberately NOT capped** — the web UI legitimately streams
  long playground text.
- Unclaimed tokens expire after `STREAM_TTL_S` = 120 s.

---

## 7. Install

SillyTavern's "Install extension" button only accepts a **public git URL** with
`manifest.json` at the repo root. This extension lives inside the private Vocalis
repo, so it is installed by **copying the folder**.

For **all** ST users (the equivalent of the dialog's "Install for all users"),
copy into ST's global third-party directory:

```bash
# On the ST host, with the Vocalis repo cloned:
rm -rf ~/SillyTavern/public/scripts/extensions/third-party/Vocalis
cp -r  ~/Vocalis/sillytavern/extension \
       ~/SillyTavern/public/scripts/extensions/third-party/Vocalis
```

For a **single-user** install instead, the target is
`~/SillyTavern/data/<your-st-login>/extensions/Vocalis` — the **ACTIVE** login's
folder, not `default-user`.

### 7.1 When a host runs two stacks, pair them correctly

An unencrypted stack and an encrypted stack must not be crossed.
Note the casing: `ls ~/SillyTavern*` does **not** match the lowercase encrypted
tree, and a session that used that glob concluded it did not exist. Use
`ls -d ~/[Ss]illy*`.

| Stack | SillyTavern | Vocalis | Pair |
|---|---|---|---|
| plaintext | `~/SillyTavern` (8000) | `~/Vocalis` (7870) | 8000 → 7870 |
| **encrypted** | `~/sillytavern.encrypted` (8001) | `~/Vocalis.encrypted` (**7871**) | **8001 → 7871** |

Installed for the encrypted stack, global (both paths are `.gitignore`d, so the
deployment's `git status` stays clean either way):

```
~/sillytavern.encrypted/public/scripts/extensions/third-party/Vocalis
```

Copy from the Vocalis source checkout, not the deployed checkout; refreshing the extension should not require changing a running service. Set the source and remote target variables before using this example:

```bash
scp -r "$VOCALIS_SOURCE_ROOT/sillytavern/extension/." \
   "$REMOTE_USER@$REMOTE_HOST:$TAPROOM_EXTENSION_DIR/"
```

### 🔴 ONE REPOSITORY, AND THE COPY IS PART OF THE DEPLOY

Other third-party extensions on the remote host are a **git clone** — `SillyTavern-MessageSummarize`
and `SillyTavern-MoonlitEchoesTheme` both have an `origin` and update with `git pull`,
because ST's "Install extension" button clones a public URL. Ours cannot use that: the
button requires `manifest.json` at a **repo root**, and ours is at
`sillytavern/extension/manifest.json` inside a **private** repo.

The extension stays in the Vocalis repository because server and browser changes often need to
land together. For example, pairing-token changes span the server route, extension, and tests.

🔴 **So the deploy copies the folder, and that step is NOT optional.** The remote host already has
`~/Vocalis.encrypted` as a real checkout, so this rides along with the pull:

```bash
cp -r ~/Vocalis.encrypted/sillytavern/extension/. \
      ~/sillytavern.encrypted/public/scripts/extensions/third-party/Vocalis/
```

⚠️ **Skipping it is silent.** The server moves and the extension does not; nothing warns,
and the symptom is a feature that "does not work" in a browser while every server test is
green. Verify with `diff -rq` against the checkout after copying.
📌 A copy is picked up by a **browser reload** of SillyTavern. It needs no ST restart, and
no Vocalis restart — those are for server-side changes.

⚠️ Encryption is irrelevant to where the extension lives: extension *code* is not
user content, and the code holds no secret. ⚠️ **The pairing TOKEN is a secret and
it is not stored here** — it lives in the fork's per-user `settings.json`, in
plaintext, like every other extension setting (§4.0). That is the fork's storage
model, not a choice made here; it is why rotating the token in the Vocalis web UI
is the revocation path. The global
directory sits outside the fork's encryption scope entirely, which is one less
moving part. A per-user install under `data/<ST_USER_HANDLE>/extensions/` also works and
is proven, if you ever want the extension scoped to one account.

Installation details:

- **A real copy, never a symlink.** ST's discovery only lists real directories; a
  symlinked folder is silently invisible.
- The copy **does not track `git pull`.** Re-run it whenever
  `sillytavern/extension/` changes, then reload the ST page. Extensions are
  discovered per page load — no ST restart needed.

If Vocalis ever goes public, the extension can be mirrored to its own small repo
so users install it by pasting a URL. Until then, the copy above is the way.

---

## 8. Setup (browser side, ~1 minute)

1. Open SillyTavern and **reload the page** (Ctrl-F5).
2. Click the **Extensions** icon (stacked blocks) in the top bar. The **Vocalis
   TTS (streaming)** drawer appears among the drawers — expand it.
3. Leave **Enabled** checked, enter the server URL — `https://<REMOTE_HOST>:7870` for the
   plaintext stack, **`https://<REMOTE_HOST>:7871` for the encrypted one** (§7.1) — and
   click **Test** → expect `OK — Vocalis v5.0-M9, model ready` (or "model cold" —
   it loads on the first request). The browser must trust the server's TLS cert —
   the same mkcert CA as the Vocalis web UI. If it says **LOCKED**, that is not an
   error in the link: go and log in to the Vocalis web UI (§4.0).
4. **One-click narration tip:** ST hides message actions behind a "…" menu by
   default, which makes every narration two clicks. In **User Settings**, enable
   **"Expand Message Actions"** — every message then shows the 🔊 button directly.
5. Open a chat (this registers its characters), then assign voice + delivery in
   the Vocalis web UI → **SillyTavern tab**.

---

## 9. Troubleshooting

- **No Vocalis drawer in Extensions** → wrong user dir, or a symlink instead of a
  real copy (see Install), or the module failed to load — check the browser
  console (F12) for red lines mentioning Vocalis.
- **Test says unreachable** → the browser doesn't trust the mkcert CA, or it's the
  wrong URL/port. Vocalis is **7870** (plaintext) or **7871** (encrypted); 8000 /
  8001 are ST itself; 5001 is the LLM.
- **Test says LOCKED, or narration toasts "Vocalis is locked. Log in to unlock."**
  → the vault is shut. Log in to the Vocalis web UI; nothing needs changing in
  SillyTavern. Expect this after **every** Vocalis restart or crash — the DEK is
  RAM-only and does not survive one (§4.0).
- **Playback stops early with the [Retry]/[OK] dialog** → the server died
  mid-generation. Retry re-runs the same text. If it repeats, check
  `~/Vocalis/logs/vocalis.log` on the server.
- **Chunks of one message in different voices** → no voice resolved at all. Set a
  `default_voice` in the ST tab, or assign the character one. The server logs a
  warning when this happens.
- **503 "server busy: too many concurrent streams"** → the 8-slot cap. Wait, or
  raise `VOCALIS_MAX_STREAMS`.
- **A save in the ST tab fails with "voice_settings.yaml is corrupt"** → exactly
  what it says. The write was refused to avoid wiping the other tabs. Fix the
  file by hand.

---

## 10. Pre-rendering (5.2)

The extension tells Vocalis about a new AI reply **the moment it lands**, and Vocalis
renders it speculatively while the box has nothing else to do. When the user clicks
▶, the audio is already in the MD5 cache and playback is instant. Full design and
rationale: [DESIGN_5_2_PRERENDER.md](DESIGN_5_2_PRERENDER.md).

It never plays anything by itself. A pre-render is only ever a *render*; the click is
still the thing that starts playback.

### The setting

**Extensions → Vocalis TTS → "Pre-render new messages"**, default **on**. It spends
GPU on messages the user may never listen to, so it is off-switchable; the server also
honors `VOCALIS_PRERENDER=0`.

Unchecking it cancels whatever is already queued.

### Triggers

| when | what is pre-rendered |
|---|---|
| a new AI reply renders (`CHARACTER_MESSAGE_RENDERED`) **and auto-narrate is off** | that message — it is the one about to be clicked |
| the user clicks ▶ on message N | message N+1 — queued *behind* N's own render |

AI messages only (the 🔊 button on the user's own lines still works; they are just not
speculated on). Auto-narrate on ⇒ no pre-rendering: the reply plays the instant it lands.

### When the server actually renders it

Only when the box has nothing real to do: no live stream, no book/playground/bulk/train
job holding the GPU gate, the model **already loaded** (a guess never triggers a model
load — that would take the cards back from ComfyUI behind the user's back), and a short
idle debounce. One at a time, at most 4 queued.

A click for **different** text preempts the guess mid-chunk — the user is waiting now.
A click for the **same** text **joins** the render already in progress rather than
starting a second one, so a mid-render click is faster than a cold one instead of twice
as expensive.

🔴 **A forced click (long-press, §5) does neither.** Joining would hand back the
speculative render of the same text — the very take the user is re-rolling — and since
renders are unseeded that is the audio they already have: the button would appear to
work and change nothing, silently. So a forced register cancels the speculation for its
own key rather than racing it to the same cache path, preempts any other running guess,
and renders fresh. `tests/test_prerender.py` guards all three.

### Endpoints

`POST /v1/audio/prerender` — body is **byte-identical** to `/v1/audio/stream`; the two
must derive the same MD5 key or a pre-render can never be claimed.

```json
→ {"input": "<text>", "character": "Test Character 1"}
← {"cache_key": "<md5>", "state": "cached|playable|rendering|queued|declined", "queued": 1}
```

`declined` is not an error (queue full, switched off, or the model is cold) — the client
just carries on with the latency it has today.

🔴 **`state` is the SAME vocabulary `/v1/audio/state` answers in, and that is load-bearing.**
Until 9.0.16 this route returned `PrerenderQueue.submit`'s own word `running` for "that key is
already the job on the card" — which is routine, since the extension speculates on mesId+1 while
mesId plays. `/v1/audio/state` has never used that word: `state_of` splits the same condition by
the buffer governor into `rendering` and `playable`, and those two are what the button's color
table is built from. An unknown state was the worst case the client had: no color (orange), no
place in `ACTIVE` so the poll never armed, and a *recorded* state so the sweep never re-asked —
a permanently gray button over audio that finished rendering and plays instantly on click. The
route now translates through `state_of`; the extension aliases `running` → `rendering` as well, so
an extension copy and a server that were installed at different times still agree.

`POST /v1/audio/prerender/cancel` — `{"cache_key": "<md5>"}` or `{"all": true}` →
`{"canceled": n}`. The extension cancels on swipe (that key), and cancels everything on
delete (indices shift) or chat change.

`GET /v1/audio/prerender/stats` — the measurement surface:

```json
{"enabled": true, "queued": 0, "running": null, "gate": "idle", "unclaimed": 2,
 "completed": 34, "hits": 21, "attached": 5, "preempted": 2, "dropped": 1,
 "declined": 0, "canceled": 3, "failed": 0}
```

**`(hits + attached) / completed` is the number that says whether pre-rendering is
earning its GPU.** `hits` counts only clicks that claimed a *pre-render's* cache entry —
an ordinary replay of an ordinary render does not inflate it. Counters are
process-lifetime and reset on restart.

`POST /v1/audio/stream` gained one additive field, `source`: `"cache"` (a hit),
`"prerender"` (this click joined a render in flight) or `"render"` (a fresh one).

### Troubleshooting

- **Nothing is ever pre-rendered** → read `gate` in `/v1/audio/prerender/stats`.
  `model-cold` means the model is unloaded (load it in the web UI, or just narrate once);
  `render` means a book/bulk/train job owns the cards; `streaming` means something is
  playing right now.
- **`completed` climbs but `hits` stays 0** → the click and the pre-render are deriving
  different cache keys. That is the one failure mode that reports nothing on its own:
  every message renders twice and the box just runs hot. Check that the character's voice
  or params were not reassigned between the two, and see DESIGN_5_2_PRERENDER §4.4.
- **The box feels busy while reading** → uncheck "Pre-render new messages", or set
  `VOCALIS_PRERENDER=0` on the server.
