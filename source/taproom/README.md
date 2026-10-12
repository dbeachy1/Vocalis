# SillyTavern

LLM Frontend for Power Users

> **Taproom** is a modified fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern),
> licensed under AGPL-3.0. Server-plugin support, log-hygiene, and storage-provider modifications
> by Douglas Beachy, 2026.

## What's different in this fork: your logs don't contain your conversations

**This works on its own.** No plugins, no encryption, nothing to configure — it is a property of the
fork itself, not of anything you add to it.

Stock SillyTavern writes chat messages, character names and personas into its log file and onto the
terminal in the ordinary course of running. Here it does not.

Every log call site is classified, and `console.*` is rewritten to the SENSITIVE class before anything
else loads. The gate tests `!== NORMAL` rather than `=== SENSITIVE`, so a call site that is new,
unclassified, or drifted is **suppressed rather than published** — publishing requires a deliberate act,
and the absence of one always resolves to suppressed. Suppressed lines still appear, as
`[SENSITIVE suppressed: <site>]`, so you can see that something happened and where.

When you genuinely need the detail, set `logging.debugMode: true`. Everything is then written in clear
text to a separate `<file>_DEBUG.log` — a different file on purpose, so there is exactly one thing to
delete when you are finished.

This is enforced by a test rather than by review discipline: `tests/log-canary.test.js` boots a real
server, drives a real generation containing six marked strings, and asserts that none of them reach the
log or the terminal — then runs identical traffic with `debugMode` on and asserts that every mark **does**
appear. The negative assertion alone would stay green if the marks had never reached the logger at all.

⚠️ Connection metadata is still recorded. `access.log` keeps timestamps, IP addresses and user agents
(`logging.enableAccessLog`), deliberately: it has to stay readable in order to debug a server whose
storage is unavailable.

## Seeing what was actually sent *(Taproom 1.0)*

Taproom lets a server plugin rewrite your prompt on its way to the model. Upstream SillyTavern has no
such thing, and so has never had to answer the question that follows from it: once a plugin has
rewritten your prompt, what did the model actually receive?

Without an answer, the browser's copy — the one behind the prompt-itemization icon — is quietly wrong
whenever such a plugin is installed. It shows what SillyTavern assembled, not what left the server,
and nothing indicates the difference. Anything reasoning about the prompt reasons about the wrong
string: a token count that does not match the bill, a KV-cache view reporting reuse that never
happened.

So the server now keeps **the last ten outgoing prompts, exactly as sent**, and reports them back to
the browser at `/api/prompt-record/<backend>`, along with **which plugins actually changed each one**.
An empty list of changers means the browser's own copy is the truth for that generation.

The behaviour is fixed and there is no setting for it:

- **Ten**, per user and per backend family, reported as `depth` so a reader never has to assume it.
  Not configurable — a knob whose settings can turn the answer off is the requirement made optional.
- **Memory only, never written to disk.** A file of recent prompts would be a new artifact holding a
  copy of your conversation, outside the encrypted store, surviving a restart nobody asked it to
  survive. The prompt is in memory for the length of the request regardless; this keeps the last few,
  and stopping the server is the end of them.
- **Yours alone.** The route takes no user parameter and there is no way to address another account's
  records — the handle comes from the authenticated session or the request answers nothing.

Backends that report their own prefill statistics (llama.cpp's `timings`, including how many tokens it
reused from cache) now reach the browser too, as a `generation_timings` event. SillyTavern was already
receiving those numbers on both the streaming and non-streaming paths and discarding them.

## Themeable control colors *(Taproom 0.4–0.5)*

Upstream SillyTavern's theme system has no button color — buttons inherit the
UI background and body text color, which renders them as unstyled text.
No theme can change this, because there is no variable to set.

Taproom adds four theme variables for button appearance, and ships a default
that makes buttons look like buttons.

| Variable | Controls | Taproom default |
|---|---|---|
| `--SmartThemeButtonBgColor` | Button fill, resting state | `rgba(90, 120, 170, 0.35)` |
| `--SmartThemeButtonBorderColor` | Button border, resting state | `rgba(140, 175, 225, 0.60)` |
| `--SmartThemeButtonTextColor` | Button label text | inherits body text color |
| `--SmartThemeButtonHoverBgColor` | Button fill, hover state | `rgba(110, 150, 210, 0.60)` |

All four are exposed as color pickers in **User Settings → Theme Colors**
and are saved with the theme.

**Themes may override these; they are not required to.** A theme that sets
none of them inherits the Taproom default and renders correctly. Existing
themes — including those written for upstream SillyTavern — work unchanged.
Switching from a theme that sets them back to one that does not restores the
default rather than leaving the previous theme's colors in place.

The active (pressed) state is derived from the resting fill and is not
separately configurable. Focus states are generated automatically from hover
states by SillyTavern's existing dynamic style system.

### Collapsible section headers *(0.5)*

The same four variables also paint every **collapsible section header** — the
"Click to expand" bars, extension settings panels, Author's Note, Reverse
Proxy, and the rest. Upstream renders these as bold body text with a dimmed
chevron, or as a near-black gradient bar; either way they read as a heading
rather than as something you can click.

0.5 adds no fifth variable and no additional picker. A header that opens a
section is a control, so it takes the control colors, and moving the button
pickers moves the headers with them.

The rule is *blue means you can click it*, which is only worth anything if the
converse holds. Section titles that are **not** click targets keep the original
dark heading style — a `standoutHeader` on a plain title, the User Settings
headings, and a World Info entry's row (where the chevron is the click target,
so the chevron is what gets colored).

## Resources

- **Taproom (this fork):** not publicly hosted. This line used to link
  `github.com/dbeachy1/SillyTavern`, which was retired on 2026-08-08 and now resolves to nothing —
  a dead link is worse than no link. When the fork is published, its URL belongs here.

Upstream SillyTavern — for the base project, not this fork's changes:

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

## License

AGPL-3.0
