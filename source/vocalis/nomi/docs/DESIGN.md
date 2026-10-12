# Nomi Chatterbox TTS — Design & Implementation Specification

> **Status**: HISTORICAL — the design as originally built (standalone server).
> Since 2.1 the unified `vocalis_server` serves `/speak`, and since 3.x the
> Nomi voice map lives in the `nomi` section of `voice_settings.yaml`
> (`nomi/voices.yaml` no longer exists). The extension and cache design here
> are still accurate.

---

## 1. Background & Goal

**Chatterbox TTS** (https://github.com/resemble-ai/chatterbox) is a local, open-source,
LLM-based text-to-speech system by Resemble AI. It runs entirely on a local GPU (supported local GPU)
and supports voice cloning from a reference WAV file. It is already installed and working
at `<install-root>\` with a Python venv at `<install-root>\venv\`.

**Nomi.ai** is an AI companion web app. Each "Nomi" is a named AI persona. Nomi has
built-in ElevenLabs TTS (a purple ▶ play button beside each Nomi message). The goal is
to inject a second play button that uses local Chatterbox instead, with per-Nomi voice
configuration and aggressive audio caching.

**What we are building:**
1. `nomi\src\nomi_server.py` — a local Flask HTTP server that accepts text, generates
   speech via Chatterbox with the configured voice for that Nomi, caches the result, and
   returns a WAV file.
2. `nomi\chrome_extension\` — a Chrome extension (Manifest V3) that injects a play button
   next to each Nomi message and communicates with the local server.
3. `nomi\voices.yaml` — configuration mapping Nomi IDs to voice files and TTS parameters.
4. `nomi\start_nomi_server.bat` — launcher script.

---

## 2. Repository Layout

```
<install-root>\
│
├── venv\                          Python venv (already set up — DO NOT recreate)
├── voice_samples\                 Reference WAV files for voice cloning
│   └── reference.wav
├── src\                           Existing Chatterbox tools (do not modify)
│   ├── generate.py                ← split_into_chunks() lives here — import it
│   ├── book_to_audio.py
│   ├── gradio_tts_app.py
│   └── gradio_tts_turbo_app.py
│
└── nomi\                          Everything for this feature
    ├── docs\
    │   └── DESIGN.md              ← this file
    ├── src\
    │   └── nomi_server.py         ← TO BUILD
    ├── chrome_extension\          ← TO BUILD
    │   ├── manifest.json
    │   ├── content.js
    │   ├── content.css
    │   └── icons\
    │       ├── icon16.png
    │       ├── icon48.png
    │       └── icon128.png
    ├── nomi_output\               Audio cache — auto-created at runtime, gitignored
    │   └── <xx>\                  First 2 hex chars of MD5 hash
    │       └── <md5>.wav
    ├── voices.yaml                ← Nomi ID → voice mapping (already has template)
    └── start_nomi_server.bat      ← TO BUILD
```

---

## 3. `voices.yaml` Schema

Located at `<install-root>\nomi\voices.yaml`.

**Keys are Nomi IDs** (the numeric ID from the URL `/nomis/<id>`), not names.
This handles: multiple Nomis with the same name, Nomi deletion/recreation (same name,
new ID, possibly different voice).
The Nomi's display name goes in a `#` comment beside the key for human readability.

```yaml
server:
  port: 8765
  max_cached_files: 10000   # oldest files evicted when this limit is exceeded

defaults:
  exaggeration: 0.5
  cfg_weight:   0.5
  temperature:  0.8

nomis:
  "<nomi-id>":  # display name
    voice: reference.wav
    exaggeration: 0.5
    cfg_weight:   0.5
    temperature:  0.8

  # "<other-nomi-id>":  # example persona
  #   voice: example.wav

# Fallback voice when a Nomi ID is not found in 'nomis':
default_voice: reference.wav
```

Voice filenames are relative to `<install-root>\voice_samples\`.
Per-Nomi TTS params fall back to `defaults` if omitted.

---

## 4. Architecture

```
  Chrome (nomi.ai)
  ┌──────────────────────────────────────────────────────┐
  │ content.js                                           │
  │  • Extracts Nomi ID from URL: /nomis/<id>            │
  │  • MutationObserver → detects new Nomi messages      │
  │  • Injects [▶] button to right of existing play btn  │
  │  • On click: POST /speak → receives WAV → plays it   │
  └──────────────────────┬───────────────────────────────┘
                         │ HTTP POST localhost:8765/speak
                         │ { "nomi_id": "<nomi-id>",
                         │   "nomi_name": "Example persona",   ← for logging only
                         │   "text": "..." }
                         │ ← audio/wav binary
                         ▼
  nomi_server.py  (Flask, Chatterbox venv)
  ┌──────────────────────────────────────────────────────┐
  │  1. Look up voice params by nomi_id in voices.yaml   │
  │  2. hash = MD5(voice_filename + "\0" + text)         │
  │  3. Cache HIT  → return WAV immediately              │
  │  4. Cache MISS → chunk → generate → concat → cache   │
  │  5. Evict oldest if cache > max_cached_files         │
  │  6. Return WAV as audio/wav response                 │
  └──────────────────────────────────────────────────────┘
          │ reads                      │ read/write
          ▼                            ▼
  voice_samples\                  nomi\nomi_output\
  reference.wav               <xx>\<md5>.wav
```

---

## 5. Server — `nomi\src\nomi_server.py`

### Dependencies

All already installed in the venv. May need `pip install flask flask-cors` if not present
(add to a `nomi\install_nomi_deps.bat` if needed).

### Startup sequence

1. Resolve paths: `BASE_DIR = Path(__file__).parent.parent.parent` → `<install-root>\`
2. Load `nomi\voices.yaml`
3. Import `split_into_chunks` from `src\generate.py` via `sys.path`:
   ```python
   sys.path.insert(0, str(BASE_DIR / "src"))
   from generate import split_into_chunks
   ```
4. Load Chatterbox model once: `ChatterboxTTS.from_pretrained(device="cuda")`
5. Start Flask on `localhost:<port>` (from YAML, default 8765)

### Endpoints

#### `POST /speak`

Request JSON:
```json
{
  "nomi_id":   "<nomi-id>",
  "nomi_name": "Example persona",
  "text":      "Full message text."
}
```

Response: `audio/wav` binary (`Content-Type: audio/wav`)

Logic:
```
1. Look up nomi_id in voices.yaml → get voice_file path and TTS params
   If not found: use default_voice + defaults, print warning

2. hash = MD5((voice_filename + "\0" + text).encode()).hexdigest()
   cache_path = nomi_output / hash[:2] / (hash + ".wav")

3. If cache_path.exists():
       return send_file(cache_path, mimetype="audio/wav")

4. chunks = split_into_chunks(text)
   tmp_dir = nomi_output / "__chunks__" / hash
   tmp_dir.mkdir(parents=True, exist_ok=True)

5. For each chunk:
       wav = model.generate(chunk, audio_prompt_path=voice_file,
                            exaggeration=ex, cfg_weight=cfg, temperature=temp)
       torchaudio.save(tmp_dir / f"{i:04d}.wav", wav, model.sr)

6. Concatenate all chunk wavs → combined
   torchaudio.save(cache_path, combined, model.sr)
   shutil.rmtree(tmp_dir)

7. Convert WAV → MP3 (96 kbps mono) via ffmpeg subprocess:
   mp3_path = nomi_output / "mp3" / hash[:2] / (hash + ".mp3")
   mp3_path.parent.mkdir(parents=True, exist_ok=True)
   subprocess.run(
       ["ffmpeg", "-y", "-i", str(cache_path),
        "-ac", "1", "-b:a", "96k", str(mp3_path),
        "-loglevel", "warning"],
       check=True
   )
   If ffmpeg fails, log a warning but do NOT abort — WAV is still returned.

8. Evict oldest entries if total WAV count > max_cached_files.
   On eviction of a WAV, also delete its paired MP3 if it exists.
   (exclude __chunks__ directory from count)

9. return send_file(cache_path, mimetype="audio/wav")
```

#### `GET /health`

```json
{ "status": "ok", "model": "loaded", "port": 8765 }
```

Returns `503` with `{ "status": "starting" }` if model not yet loaded.

### Flask setup

```python
from flask import Flask, request, send_file, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)   # allow requests from chrome-extension:// origin
```

---

## 6. Cache Design

### Directory structure

```
nomi\nomi_output\
  3f\
    3f7a1b2c8e4d....wav
    3f0044abc1f2....wav
  a1\
    a1339fd200ab....wav
  mp3\                        ← MP3 mirror, same hash-based layout
    3f\
      3f7a1b2c8e4d....mp3
    a1\
      a1339fd200ab....mp3
  __chunks__\                 ← temp during generation, always cleaned up
```

WAV is the primary cache and what is served to the browser. MP3 is generated
immediately after each new WAV (96 kbps mono via ffmpeg) for external use.
If ffmpeg conversion fails the WAV is still served — MP3 is best-effort.

### Cache key

```python
import hashlib
key = hashlib.md5((voice_filename + "\0" + text.strip()).encode()).hexdigest()
```

Keying on `voice_filename + text` means:
- Two Nomis saying the same text with different voices → different cache entries (no collision)
- Changing a Nomi's voice → old cache files become unreachable orphans, evicted naturally
- Reassigning a Nomi back to a previous voice → old cache becomes active again instantly

### Eviction

```python
all_wavs = sorted(
    [f for f in cache_root.rglob("*.wav") if "__chunks__" not in str(f)],
    key=lambda f: f.stat().st_mtime
)
while len(all_wavs) > max_cached_files:
    oldest = all_wavs.pop(0)
    oldest.unlink()
    # also delete paired MP3 if it exists
    mp3 = cache_root / "mp3" / oldest.parent.name / (oldest.stem + ".mp3")
    if mp3.exists():
        mp3.unlink()
```

Evicts oldest-written files. Not true LRU (mtime not updated on cache hit), but
replaying very old messages is rare enough that this is acceptable.

### Capacity

With `max_cached_files = 10000` and 256 subdirs: ~39 files per subdir on average.
NTFS and Windows Explorer both handle this comfortably. Safe to increase to 100,000
if needed (still only ~390 per subdir).

---

## 7. Chrome Extension

### Manifest (`nomi\chrome_extension\manifest.json`)

```json
{
  "manifest_version": 3,
  "name": "Nomi Chatterbox TTS",
  "version": "1.0",
  "description": "Local Chatterbox TTS playback for Nomi messages",
  "permissions": [],
  "host_permissions": [
    "https://nomi.ai/*",
    "http://localhost/*"
  ],
  "content_scripts": [{
    "matches": ["https://nomi.ai/*"],
    "js":  ["content.js"],
    "css": ["content.css"],
    "run_at": "document_idle"
  }]
}
```

The extension's server URL is caller-configurable, but browser access is limited to origins in its
host permissions. A custom remote Vocalis origin therefore needs a matching manifest permission
and an extension reload or reinstall; entering its URL alone does not grant access.

### Nomi.ai DOM Structure (confirmed via DevTools)

Nomi uses **React + Mantine UI** + CSS Modules. Class names follow
`ComponentName_localClass__Hash` — use `[class*="ComponentName_localClass"]`
substring selectors to survive hash changes between Nomi deployments.

```
div[class*="NomiChatContainer_messageWrapper"]   one per message
  div[class*="MessageBubble_nomiWrapper"]        Nomi messages only (not user bubbles)
    div[class*="MessageBubble_root"]
      div[class*="MessageBubble_content"]        full message text → .innerText
      div[class*="MessageBubble_reactionContainer"]
  div[class*="MessageBubble_sideInfo"]           play button + timestamp (inject here)
    button[aria-label="Play message"]            existing ElevenLabs play button
```

**Nomi ID** — extracted from URL:
```javascript
function getNomiId() {
  const m = location.pathname.match(/\/nomis\/(\d+)/)
  return m ? m[1] : null
}
```

**Nomi name** — for logging only, from left-nav sidebar:
```javascript
function getNomiName() {
  return document.querySelector(`a[href="${location.pathname}"] h3`)
                 ?.textContent?.trim() ?? "unknown"
}
```

**Message text** — when button clicked:
```javascript
const wrapper = btn.closest('[class*="NomiChatContainer_messageWrapper"]')
const text = wrapper.querySelector('[class*="MessageBubble_content"]').innerText.trim()
```

### `content.js` — Full Behavior

**Injection guard**: add `data-chatterbox-injected="1"` to the sideInfo container
after injecting our button. Check for this attribute before injecting to prevent
duplicates (MutationObserver fires multiple times).

**Button HTML**:
```html
<button class="nomi-cb-btn" title="<md5hash>.wav">
  <!-- SVG injected by JS: circle+triangle (play) or circle+square (stop) -->
</button>
```

**Button states**:

| State | Icon | CSS class | Tooltip |
|-------|------|-----------|---------|
| Idle | ▶ in circle | `nomi-cb-idle` | `<md5>.wav` |
| Generating | ▶ in circle + spinner ring | `nomi-cb-generating` | `generating…` |
| Playing | ■ in circle | `nomi-cb-playing` | `<md5>.wav` |
| Error | ⚠ | `nomi-cb-error` | `Start nomi_server first` |

The spinner is a CSS `@keyframes` rotating border on the button. The icon itself
does not change during generation — only the border animates.

**Click handler state machine**:
```
IDLE click:
  1. GET /health → if error: set ERROR state, return
  2. Set GENERATING state (spinner, pointer-events: none)
  3. abortController = new AbortController()
  4. fetch POST /speak {nomi_id, nomi_name, text} signal=abortController.signal timeout=5min
  5. blob = await response.blob()
  6. url = URL.createObjectURL(blob)
  7. audio = new Audio(url)
  8. URL.revokeObjectURL(url)     ← free blob memory immediately
  9. audio.play()
  10. Set PLAYING state
  11. audio.onended → Set IDLE state

GENERATING click:
  1. abortController.abort()
  2. Set IDLE state

PLAYING click:
  1. audio.pause(); audio.src = ""
  2. Set IDLE state
```

**MutationObserver** — watches for new messages:
```javascript
const observer = new MutationObserver(() => {
  document.querySelectorAll(
    '[class*="MessageBubble_sideInfo"]:not([data-chatterbox-injected])'
  ).forEach(injectButton)
})
observer.observe(document.body, { subtree: true, childList: true })
```

**SPA navigation** — re-init when user switches Nomis (URL changes):
```javascript
const _push = history.pushState.bind(history)
history.pushState = (...args) => { _push(...args); onNavigate() }
window.addEventListener('popstate', onNavigate)

function onNavigate() {
  // nomi_id and nomi_name are re-read from URL/DOM on each button click,
  // so no action needed here except potentially re-scanning for uninjected buttons
  setTimeout(scanAndInject, 500)  // allow React to re-render
}
```

### `content.css`

Minimal styles for the button and spinner ring. Should visually complement the
existing Nomi play button (purple circle) — suggested style: same size, outlined
circle (not filled), purple stroke, to be distinct but clearly related.

```css
.nomi-cb-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid #9610ff;   /* Nomi purple */
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  margin-left: 6px;
  padding: 0;
  transition: opacity 0.2s;
}

.nomi-cb-btn svg {
  width: 16px;
  height: 16px;
  fill: #9610ff;
}

.nomi-cb-generating {
  pointer-events: none;
  opacity: 0.7;
}

.nomi-cb-generating::after {
  content: "";
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: #9610ff;
  animation: nomi-spin 0.8s linear infinite;
}

@keyframes nomi-spin {
  to { transform: rotate(360deg); }
}

.nomi-cb-error svg {
  fill: #cc0000;
}
```

---

## 8. `start_nomi_server.bat`

```batch
@echo off
cd /d "%~dp0..\"
echo ====================================
echo  Nomi Chatterbox TTS Server
echo ====================================
echo.
echo Listening on http://localhost:8765
echo Press Ctrl+C to stop.
echo.
"%~dp0..\venv\Scripts\python.exe" nomi\src\nomi_server.py
pause
```

Runs from `<install-root>\` so all relative paths resolve correctly.
Uses the existing venv — no separate install needed (Flask/flask-cors may need
`pip install flask flask-cors` once if not already present).

---

## 9. Loading the Extension in Chrome

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select `<install-root>\nomi\chrome_extension\`
5. Navigate to `https://nomi.ai` — buttons appear automatically

To update after code changes: click the refresh icon on the extension card
in `chrome://extensions`.

---

## 10. Implementation Checklist

Build in this order:

- [ ] `nomi\src\nomi_server.py`
- [ ] `nomi\start_nomi_server.bat`
- [ ] `nomi\chrome_extension\manifest.json`
- [ ] `nomi\chrome_extension\content.css`
- [ ] `nomi\chrome_extension\content.js`
- [ ] Icons (16×16, 48×48, 128×128 PNG — simple waveform or speaker)
- [ ] Smoke test: start server, load extension, open nomi.ai, click button
- [ ] **Code review pass** before considering done (see below)

### Code Review Checklist

Run a review pass on each file after completion:

- `nomi_server.py`: path resolution, cache eviction logic, hash correctness,
  error handling on generation failure, Flask CORS config
- `content.js`: MutationObserver teardown on page unload, button dedup guard,
  AbortController cleanup, audio objectURL revocation, state machine correctness
- `voices.yaml`: schema validation on load, graceful fallback for missing nomi_id
- End-to-end paths: cache hit, cache miss, server-down, abort mid-generation

---

## 11. Not in Scope

- Streaming audio (play before full generation completes)
- Extension popup/options UI (config is YAML-only)
- Chatterbox Turbo model (standard model only)
- Auto-start of server (user runs `start_nomi_server.bat` manually)
- Any UI for managing voices.yaml (edit the file directly)
