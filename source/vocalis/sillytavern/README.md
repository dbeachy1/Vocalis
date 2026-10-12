# Vocalis TTS (streaming) — SillyTavern extension

A standalone SillyTavern UI extension that plays chat messages through a
Vocalis server's **real-time streaming** path (Vocalis 3.0): audio starts
within seconds while the rest of the message is still rendering, with
full-chunk prosody — the same engine path the Nomi extension uses.

- A speaker button on every message plays (or stops) that message.
- **Hold that button** for about half a second and release: the line is
  re-rendered rather than replayed, giving you a different take of it.
- Optional **auto-narrate**: new AI replies start playing as they land.
- **Voices are assigned server-side, in the Vocalis web UI** (SillyTavern
  tab): the extension sends speaker identity, not a voice choice. It proactively
  registers the current character when a chat opens and a persona after Vocalis
  successfully imports it (`POST /v1/st/characters`); every narration carries
  `character` plus the character/persona avatar filename when available — the
  server resolves the assigned voice + per-speaker
  exaggeration/cfg/temperature/seed (stored server-side in
  `voice_settings.yaml`'s `sillytavern` section) and auto-registers names it
  hasn't seen (group members appear organically).
- If a stream dies mid-generation, playback stops and a **[Retry] / [OK]**
  dialog appears (the client checks the stream's `/status` when audio ends —
  a truncated stream is otherwise indistinguishable from a finished one).

Server requirements: Vocalis with the 3.0 streaming endpoints
(`POST /v1/audio/stream`, `POST /v1/st/characters`). Both are CORS-enabled,
like the rest of `/v1/*`. Chat lines ARE cached server-side (MD5 of
voice+params+text, the same cache as `/speak`) — re-clicking a message replays
it instantly.

**Narration needs the server URL and the pairing token** (7.0-m6). Generate
the token in the Vocalis web UI under **Settings → SillyTavern extension**,
paste it into the extension once, press Test. It is the one credential for
everything the extension does — narration on `/v1/*`, worldbooks and cards on
`/pair/*` — and a Vocalis with an admin password refuses `/v1/*` without it
(this is what keeps one user's Vocalis private when several people share a
SillyTavern). Without a token, clicking ▶ shows a toast saying exactly where
to get one.

A reachable Vocalis can also refuse for a different reason: a **locked** vault
(5.0) 401s `/v1/*` along with everything else. `/health` stays open so the
extension can tell the states apart — Test reports **LOCKED** rather than a
misleading OK, and a narration attempt toasts the unlock instruction, never
"re-copy your token". The fix is on the Vocalis side: log in to the Vocalis
web UI. Expect it after every Vocalis restart, since the key is RAM-only.

Full reference — the server side, the API contract, the voice-resolution
precedence: [`docs/SILLYTAVERN_EXTENSION.md`](../docs/SILLYTAVERN_EXTENSION.md).

## Install (manual copy)

This is for a SillyTavern you run yourself. The SillyTavern bundled with the
Vocalis Docker package (Taproom) already has this extension installed.

SillyTavern's "Install extension" button only accepts a git URL with
`manifest.json` at the repository root, and this extension is a folder inside
the Vocalis repository, so it is installed by copying the folder. **For ALL ST
users** (the equivalent of the dialog's "Install for all users"), copy into
ST's global third-party directory:

```bash
# On the SillyTavern host, with the Vocalis repository cloned (or its source
# archive unpacked) at ~/Vocalis:
rm -rf ~/SillyTavern/public/scripts/extensions/third-party/Vocalis
cp -r  ~/Vocalis/source/vocalis/sillytavern/extension \
       ~/SillyTavern/public/scripts/extensions/third-party/Vocalis
```

(For a single-user install instead, the target is
`~/SillyTavern/data/<your-st-login>/extensions/Vocalis` — the ACTIVE login's
folder, not `default-user`.)

Installation requirements:
- **A real copy, never a symlink** — ST's discovery only lists real
  directories; a symlinked folder is silently invisible.
- The copy does not update itself — **re-run it after you update Vocalis**
  (whenever `sillytavern/extension/` changes), then reload the ST page (extensions are
  discovered per page load; no ST restart needed).

## Setup (browser side, ~1 minute)

1. Open SillyTavern and **reload the page** (Ctrl-F5).
2. Click the **Extensions** icon (stacked blocks) in the top bar; the
   **Vocalis TTS (streaming)** drawer appears among the drawers — expand it.
   (Missing? See Troubleshooting.)
3. Leave **Enabled** checked, enter your Vocalis server URL, which is the
   address you open Vocalis at (for the Docker package on the same computer,
   `http://127.0.0.1:18770` unless you chose another port), click **Test** →
   expect `OK — Vocalis v12.1.0, model ready` (or "model cold" — it loads on the
   first request). The Docker package answers only on its own computer; to
   reach it from another one, put it behind a reverse proxy with TLS (the
   package's setup reference, `packaging/README.md`, has the details), and the
   browser must then trust that certificate. **LOCKED** means go log in to
   Vocalis, not that the link is misconfigured.
4. **One-click narration tip:** ST hides message actions behind a "…" menu by
   default (two clicks per narration). In **User Settings**, enable
   **"Expand Message Actions"** — every message then shows the 🔊 speaker
   button directly.

## Usage

- **No LLM needed.** Narration reads the chat *log*: open any chat with
  history and click 🔊 on any message (yours or the character's). Text
  generation only matters for **Auto-narrate new AI replies**, which fires
  on freshly generated messages.
- Opening a chat registers its character(s) with Vocalis. Assign voice +
  delivery in the Vocalis web UI → **SillyTavern tab** (voice dropdown,
  knobs, streaming ▶ Audition, Save). An unassigned character speaks with
  the default voice.

## Troubleshooting

- **No Vocalis drawer in Extensions** → wrong user dir or a symlink (see
  Install), or the module failed to load — check the browser console (F12)
  for red lines mentioning Vocalis.
- **Test says unreachable** → check that the browser trusts the server's TLS
  certificate and that the URL uses the intended Vocalis instance's port,
  rather than a SillyTavern or LLM port. For multiple installations, keep
  each SillyTavern instance paired with its corresponding Vocalis instance.
- **Test says LOCKED** → the Vocalis vault is shut. Log in to the Vocalis web
  UI. Nothing to change in SillyTavern.
- **Playback stops early with the [Retry]/[OK] dialog** → the server died
  mid-generation; Retry re-runs the same text. If it repeats, check the Vocalis
  log on the server (in the Docker package, `logs/vocalis/vocalis.log` in the
  data folder).

## Notes

- One playback at a time: starting a message stops the previous one; clicking
  the same message's button while it plays stops it.
- Hold-to-re-render: the spinner starting under your finger means it is armed —
  release then and the line re-renders. Let go before the spinner, or slide off
  the button, and it is an ordinary click. Renders are unseeded, so what you get
  back is a genuinely different reading of the same text, not the same file.
- Switching chats, swiping, or deleting messages stops playback.
- ST's built-in TTS extension is unrelated — leave it off to avoid two
  narrations. This extension does not register as a TTS provider; it is its
  own player on the streaming path (the built-in provider framework only
  supports whole-file responses, which is what `/v1/audio/speech` remains
  available for).
- Files: `manifest.json` (ST extension manifest), `index.js` (UI + events +
  settings), `vocalis-stream.js` (the streaming player: register → one-time
  progressive-MP3 stream → MediaSource pump → `/status` truncation check),
  `style.css`.
