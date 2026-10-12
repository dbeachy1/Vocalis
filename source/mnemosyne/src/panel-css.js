/**
 * The panel's own stylesheet (fork panel design §10.3), served by `GET /panel.css`.
 *
 * ## 🔴 This channel did not exist a day ago, and two of this plugin's docblocks said so
 *
 * Until the fork shipped `stylesheetPath`, a plugin had **no way of any kind** to ship a rule: every
 * `mnemosyne-*` class reached the browser and matched nothing. That shaped real decisions here — the calendar
 * became a `<table>` because a `<div>` grid rendered as `SuMoTuWeThFrSa123456789…`, the scope selector marks
 * itself with ◉/○ because three identically-styled buttons gave no clue which filter was on, and the recall
 * badge is a 💡 glyph because a color could not be delivered. **Those choices all stay.** They are legible
 * with zero CSS, and this stylesheet is fetched once, over the network, by a client that logs a failure and
 * carries on — so anything that depends on it arriving is a thing that sometimes will not be there.
 *
 * 🔴 **THE RULE THAT FOLLOWS FROM THAT: nothing here may carry meaning of its own.** Every rule below either
 * makes the panel usable at a size it already had (the scroll containment) or reinforces a distinction the
 * markup already draws (the recalled tint, beside the badge that says it in words). If a future rule is the
 * only thing telling the user something, that fact belongs in the fragment instead.
 *
 * ## Why a JS module rather than a `.css` file
 *
 * The host fetches this over HTTP and steps over a failure, so the one outcome worth engineering against is
 * "the route 404s on someone's install". A string in a module is loaded by the same loader that loaded
 * `index.js` — no path resolution relative to `import.meta.url`, no packaging question, nothing that behaves
 * differently when the plugin directory is a symlink. It cannot be missing.
 *
 * ## Scoping
 *
 * The host wraps this in `@scope (#pluginPanel-mnemosyne) { … }`, so a selector cannot reach the application
 * around it and `:root` matches nothing. Theme variables still cascade in, which is why every color below is
 * a `--SmartTheme*` variable: a hard-coded hex looks pasted-in when the host theme changes.
 */

/**
 * The host popup content clips overflow and does not provide a scroller. Its `root` region replaces the
 * children of the region container, removing the `.mnemosyne-panel` wrapper after navigation. Scope layout to
 * `:scope` in the host popup so the bounded flex column works before and after that replacement. Keep the
 * header, toolbar, and pager fixed while the recall section and day list share one scroll region.
 */
export const PANEL_CSS = `
/* ---- Layout: bound our own height, because the popup around us will not (see the docblock). ---- */

/* The host's own .popup-content, and the ONLY element present in both layouts — see the docblock's second
   section. It is already bounded (a flex item of a 90dvh popup, with overflow:hidden), so laying it out as a
   column is all that is needed; nothing here guesses a viewport fraction. */
:scope {
    display: flex;
    flex-direction: column;
    min-height: 0;
}

/* ⚠️ NO \`max-height\` HERE ANY MORE, AND THE MEASUREMENT IS WHY. It used to be \`78dvh\`, a guess at what the
   popup would leave us — and with the container laid out properly above, the guess is both unnecessary and
   wrong by 86px at a 1200x800 viewport: the popup actually offers about 86dvh, so the cap was silently
   holding back a tenth of the panel on every open. min-height:0 is what lets this shrink below its content so
   the scroller inside it can do its job. */
.mnemosyne-panel {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
}

/* One scroller keeps the recall section and day list together. \`min-height: 0\` lets this flex item shrink below
   its content size so overflow stays inside the panel. */
.mnemosyne-scroll {
    overflow-y: auto;
    flex: 1 1 auto;
    min-height: 0;
}

/* The list no longer scrolls on its own — .mnemosyne-scroll around it does, so that the recall section
   scrolls WITH it rather than above it. */
.pluginPanel-list {
    min-height: 0;
}

/* The recall readout, which a pre-interactive host gets instead of the browser (no region attribute). One
   scroll box for the whole thing: it has no toolbar worth pinning. */
.mnemosyne-panel:not([data-panel-region]) {
    overflow-y: auto;
}

/* ---- What the last reply recalled ---- */

/* Use the underline color for recalled rows. Quote color already marks superseded rows, so the states remain
   visually distinct. */
.mnemosyne-row--recalled {
    border-left: 3px solid var(--SmartThemeUnderlineColor);
    padding-left: 0.6em;
    background: color-mix(in srgb, var(--SmartThemeUnderlineColor) 8%, transparent);
}

.pluginPanel-badge.mnemosyne-recalled {
    color: var(--SmartThemeUnderlineColor);
    border-color: color-mix(in srgb, var(--SmartThemeUnderlineColor) 60%, transparent);
    white-space: nowrap;
}

/* Keep controls visible at rest; the host style otherwise dims buttons and adds a border only on hover. This
   scoped sheet loads after the host rule with the same specificity, so it does not need \`!important\`. Icons
   and badges continue to carry state meaning if the stylesheet fails to load. */

.pluginPanel-button {
    display: inline-block;
    opacity: 1;
    padding: 0.25em 0.7em;
    border: 1px solid color-mix(in srgb, var(--SmartThemeBodyColor) 35%, transparent);
    border-radius: 0.4em;
    background: color-mix(in srgb, var(--SmartThemeBodyColor) 7%, transparent);
    line-height: 1.5;
}

/* The host dims a row's controls to 0.85 until the row is hovered, at a specificity this cannot outrank by
   class alone. Restated here so an outlined button does not fade for being inside a row. */
.pluginPanel-row .pluginPanel-button,
.pluginPanel-row:hover .pluginPanel-button {
    opacity: 1;
}

.pluginPanel-button:hover,
.pluginPanel-button:focus-visible {
    border-color: var(--SmartThemeQuoteColor);
    background: color-mix(in srgb, var(--SmartThemeQuoteColor) 20%, transparent);
}

/* The two colors, and only two. "Different colors" as a palette would put six hues on one toolbar and say
   nothing; what a user needs to tell apart at a glance is the action that COMMITS something and the one that
   cannot be undone. Everything else is deliberately the neutral outline above. */
.mnemosyne-button--primary {
    border-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 70%, transparent);
    background: color-mix(in srgb, var(--SmartThemeQuoteColor) 15%, transparent);
    color: var(--SmartThemeQuoteColor);
}

.mnemosyne-button--danger {
    border-color: color-mix(in srgb, var(--warning, crimson) 55%, transparent);
    background: color-mix(in srgb, var(--warning, crimson) 10%, transparent);
    color: var(--warning, crimson);
}

.mnemosyne-button--danger:hover,
.mnemosyne-button--danger:focus-visible {
    border-color: var(--warning, crimson);
    background: color-mix(in srgb, var(--warning, crimson) 22%, transparent);
}

/* A disabled pager end is text, not a control, and must not read as one now that controls have outlines. */
.pluginPanel-pager .pluginPanel-muted {
    border: 1px solid transparent;
    padding: 0.25em 0.7em;
}

/* ---- 🔴 The recall section, pinned above the day list ----

   What the last reply used, answered before it is asked (see \`renderRecalled\`). Tinted with the same
   underline color the recalled ROWS carry, because they are two views of one fact and a second hue would
   imply a second fact. */

.mnemosyne-recalled__section {
    margin-bottom: 0.8em;
    padding: 0.6em 0.7em;
    border: 1px solid color-mix(in srgb, var(--SmartThemeUnderlineColor) 45%, transparent);
    border-radius: 0.5em;
    background: color-mix(in srgb, var(--SmartThemeUnderlineColor) 7%, transparent);
}

.mnemosyne-recalled__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5em;
    margin-bottom: 0.4em;
}

/* The heading when there is nothing to toggle — a decline, or a chat that has not generated yet. It is not a
   button and must not wear a button's outline. */
.mnemosyne-recalled__title {
    font-weight: 600;
    color: var(--SmartThemeUnderlineColor);
}

.mnemosyne-recalled__toggle {
    font-weight: 600;
    border-color: color-mix(in srgb, var(--SmartThemeUnderlineColor) 65%, transparent);
    background: color-mix(in srgb, var(--SmartThemeUnderlineColor) 14%, transparent);
    color: var(--SmartThemeUnderlineColor);
}

.mnemosyne-recalled__item {
    padding: 0.35em 0;
}

.mnemosyne-recalled__item + .mnemosyne-recalled__item {
    border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 35%, transparent);
}

/* ---- "What was sent": the block, verbatim ---- */

/* The one place in this panel showing text the model received rather than text a person wrote, so it is
   monospaced and it keeps its own line breaks — the block's structure (header line, one bullet per memory) is
   what makes it readable, and reflowing it as prose would hide exactly what the view exists to show.
   pre-wrap, not pre: a memory is ~490 characters and a horizontal scrollbar would bury the end of every line. */
.mnemosyne-block {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0.5em 0;
    padding: 0.6em;
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 4px;
    background: var(--black30a);
    font-family: var(--monoFontFamily, monospace);
    font-size: 0.9em;
    max-height: 45dvh;
    overflow-y: auto;
}

/* The query is the user's own words, quoted back — the same left-border idiom the version history uses for
   "this is a thing being referred to, not a thing being said here". */
.mnemosyne-query {
    margin: 0.3em 0 0.8em;
    padding-left: 0.8em;
    border-left: 2px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 50%, transparent);
    font-style: italic;
}

/* Scrolls as one region — unlike the browse view it has no toolbar worth pinning. */
.mnemosyne-prompt {
    overflow-y: auto;
    min-height: 0;
}

.mnemosyne-caveat {
    opacity: 0.8;
}

/* ---- Hierarchy (§10.5): the content is the point, the chrome recedes ---- */

/* A day separator is a rule with its label sitting on it, never a heading. */
.mnemosyne-day {
    display: flex;
    align-items: center;
    gap: 0.6em;
    margin: 0.8em 0 0.2em;
    color: var(--SmartThemeEmColor);
    font-size: 0.85em;
}

.mnemosyne-day::after {
    content: "";
    flex: 1;
    border-top: 1px solid color-mix(in srgb, var(--SmartThemeBorderColor) 40%, transparent);
}

/* Earlier versions, indented under the row they belong to. */
.mnemosyne-versions {
    margin: 0.4em 0 0 1em;
    padding-left: 0.8em;
    border-left: 2px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 50%, transparent);
}

.mnemosyne-version {
    padding: 0.3em 0;
    opacity: 0.85;
}

.mnemosyne-versionNote {
    opacity: 0.7;
}

/* The edit box should be the width of the row it replaces, not the browser's 20-column default. */
.mnemosyne-edit {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    color: var(--SmartThemeBodyColor);
    background: var(--black30a);
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 4px;
    padding: 0.4em;
}

/* ---- The index line (schema.js v5) ----

   The memory is what gets injected; this is what gets embedded and matched against future questions. It is
   shown on every row because a user whose memory is never recalled is entitled to see why, and it is set
   BELOW and quieter than the memory because it is machinery rather than content — the eye should reach the
   memory first and find this only when asking why that memory did or did not come up. */
.mnemosyne-index {
    font-size: 0.9em;
    opacity: 0.72;
    margin-top: 0.25em;
    padding-left: 0.6em;
    border-left: 2px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 35%, transparent);
}

/* ⚠️ Quieter still, never hidden: "found by its own text" is a true and useful statement about a hand-written
   memory, and blank space where a field belongs reads as a bug. */
.mnemosyne-index--none {
    opacity: 0.5;
    font-style: italic;
}

.mnemosyne-indexTag {
    font-weight: 600;
    opacity: 0.8;
}

/* The label wraps its own textarea, so it is a block or the box lands beside the words instead of under them. */
.mnemosyne-indexLabel {
    display: block;
    margin-top: 0.4em;
    font-size: 0.9em;
    opacity: 0.8;
}

.mnemosyne-edit--index {
    margin-top: 0.2em;
    font-size: 0.95em;
}

/* The selected scope. The ◉/○ glyph is what actually says it (and must keep saying it — see the header);
   this only stops the chosen one receding into the row beside it. */
.mnemosyne-scope--on {
    font-weight: 600;
    color: var(--SmartThemeUnderlineColor);
}

/* ---- The calendar ---- */

.mnemosyne-calendar {
    border-collapse: collapse;
    margin: 0.5em auto;
}

.mnemosyne-cell {
    width: 2.4em;
    height: 2.2em;
    text-align: center;
    vertical-align: middle;
}

.mnemosyne-cell--head {
    color: var(--SmartThemeEmColor);
    font-size: 0.85em;
    font-weight: normal;
}

/* A day with nothing in it is present but unremarkable — the grid has to stay a grid. */
.mnemosyne-cell--empty {
    opacity: 0.35;
}

/* ---- The failure banner and the log view ---- */

/* 🔴 RED, AND DELIBERATELY THE LOUDEST THING IN THE PANEL. Everything else here is built to recede (§10.5);
   this is the one element whose job is to interrupt. It appears only when automatic memory has actually
   failed, so it cannot become furniture — a banner that is always up is a banner nobody reads.
   --SmartThemeQuoteColor is not used: the theme's quote color is decorative and varies to the point of
   being green in some themes. A warning has to be a warning in every theme, so the hue is fixed and only its
   opacity is composed against the theme's background. */
.mnemosyne-alert {
    margin: 0 0 0.7em;
    padding: 0.6em 0.7em;
    border: 1px solid #d9534f;
    border-left: 4px solid #d9534f;
    border-radius: 4px;
    background: color-mix(in srgb, #d9534f 12%, transparent);
}

.mnemosyne-alert-head {
    font-weight: bold;
    color: #ff6b66;
    margin-bottom: 0.25em;
}

.mnemosyne-alert-why {
    margin-bottom: 0.35em;
}

/* The remedy reads as advice rather than as more alarm — it is the calm half of the message. */
.mnemosyne-alert-fix {
    opacity: 0.85;
    font-size: 0.92em;
    margin-bottom: 0.5em;
}

.mnemosyne-alert-actions {
    display: flex;
    gap: 0.4em;
}

.mnemosyne-log-head {
    display: flex;
    align-items: center;
    gap: 0.6em;
    margin-bottom: 0.5em;
}

.mnemosyne-log-title {
    color: var(--SmartThemeEmColor);
    font-size: 0.9em;
}

/* 🔴 A TEXTAREA SO IT CAN BE FOCUSED AND SELECTED WITH ONE Ctrl-A — see renderLog for why that is the whole
   point rather than a detail. resize: vertical because a log is exactly the thing a reader wants more of.
   No wrapping: log lines are long and reflowing them makes two adjacent entries look like one. */
.mnemosyne-log {
    width: 100%;
    box-sizing: border-box;
    min-height: 40dvh;
    padding: 0.6em;
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 4px;
    background: var(--black30a);
    color: inherit;
    font-family: var(--monoFontFamily, monospace);
    font-size: 0.82em;
    line-height: 1.45;
    white-space: pre;
    overflow: auto;
    resize: vertical;
}

.mnemosyne-log-foot {
    margin-top: 0.4em;
    opacity: 0.8;
    font-size: 0.85em;
}

/* ── Settings (v1.0) ─────────────────────────────────────────────────────────────────────────────────────
   🔴 THE HELP TEXT IS ALWAYS VISIBLE, NOT ONLY ON HOVER, and that is a deliberate cost in density. Two of
   these knobs fail SILENTLY when set wrong — an extraction ceiling below what a reasoning model spends
   thinking returns an empty answer, and a small memory size produces memories that parse fine and say
   nothing. A user who never hovers would have no way to connect either symptom to the number that caused it.
   The title attribute is still there for the pointer; this is for the eye that never asks. */
/* 🔴 THE SCROLL CONTAINER, WHICH THIS VIEW WAS THE ONE LONG VIEW TO SHIP WITHOUT. .mnemosyne-scroll and
   .mnemosyne-prompt both declare overflow-y:auto with min-height:0, and for the same reason: the panel opens
   as a Popup whose .popup-content is overflow:hidden, so a flex child that does not scroll itself simply
   paints past the bottom of the dialog with no scrollbar to reach it. The settings form is seven blocks with
   always-visible help text, then a 40dvh textarea, then the presets list — comfortably taller than the popup
   on any screen, so the bottom of the form was unreachable.

   ⚠️ It does not bite in the Extensions dialog, where the fork passes a null scroller because that dialog
   scrolls itself — which is exactly how a view tried only through the §28 door looks fine and is not.

   ⚠️ NO BACKTICKS ANYWHERE IN THIS FILE'S COMMENTS. The whole stylesheet is one JS template literal, so a
   backtick here ends the string and the file stops parsing — which is how this rule first landed broken. */
.mnemosyne-settings {
    display: flex;
    flex-direction: column;
    gap: 1.1em;
    padding: 0.2em 0.1em 1em;
    overflow-y: auto;
    flex: 1 1 auto;
    min-height: 0;
}

.mnemosyne-setting {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas: "label input" "help help" "range range";
    gap: 0.25em 0.8em;
    align-items: center;
    padding-bottom: 0.9em;
    border-bottom: 1px solid var(--SmartThemeBorderColor);
}

.mnemosyne-setting-label { grid-area: label; font-weight: 600; }

.mnemosyne-setting-input {
    grid-area: input;
    display: flex;
    align-items: baseline;
    gap: 0.4em;
    white-space: nowrap;
}

/* 🔴 EVERY TEXT-ENTRY CONTROL IN THIS PANEL STATES ITS OWN COLORS. A BARE INPUT IS THE BUG.

   These rules used to set width and alignment and nothing else, so the browser supplied its default LIGHT
   input background while the field inherited SillyTavern's dark-theme LIGHT text — light on light. The
   numbers were there, correct, but the controls remained unreadable without explicit colors.

   ⚠️ AN INPUT INHERITS color BUT NEVER background-color, which is exactly what makes this fail silently on a
   dark theme and look fine on a light one. Neither half may be left to the browser: the textarea rules above
   already state both, and these are the same control wearing a different type. A control added here states
   both too — panel-view.test.js sweeps every input and textarea the panel can emit and fails if either is
   missing, because the HTML was correct throughout this bug and no other test could see it.

   Values come from the host's theme variables rather than literals, so the panel follows whatever theme the
   user picked instead of imposing one. Same tokens the edit textarea uses. */
.mnemosyne-setting-input input,
.mnemosyne-preset-input {
    color: var(--SmartThemeBodyColor);
    background: var(--black30a);
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 4px;
    padding: 0.35em 0.5em;
    font-family: inherit;
    font-size: inherit;
}

/* The focused field says so in the theme's own accent, because a control whose only focus mark is the
   browser's default ring is one the keyboard user loses track of on a dark background. */
.mnemosyne-setting-input input:focus-visible,
.mnemosyne-preset-input:focus-visible {
    outline: 2px solid var(--SmartThemeQuoteColor);
    outline-offset: 1px;
}

/* 🔴 THE ONE FIELD THE CONTRAST FIX MISSED, BY THE MECHANISM THE CONTRAST FIX WAS ABOUT. Setting color on an
   input does not set its PLACEHOLDER color: that comes from the UA, resolved against color-scheme, and the
   host pins color-scheme:only light on body — so the placeholder renders as light-scheme dark gray over
   --black30a, which is dark on dark. The host's own placeholder rules are scoped to textarea and .text_pole,
   and this input is neither, so nothing upstream covers it either.

   ⚠️ The panel's contrast sweep cannot see this rule: its selector normalizer strips pseudo fragments, which
   leaves a double-colon selector with a trailing colon that matches no wanted selector. That is why this
   walked straight through a test written to catch exactly this class of bug. */
.mnemosyne-preset-input::placeholder {
    color: var(--SmartThemeEmColor);
    opacity: 0.7;
}

/* ⚠️ A fixed width rather than auto: these hold 1 to 5 digits, and a field that resizes as you type makes the
   whole column jump while you are reading the row above it. */
.mnemosyne-setting-input input { width: 6em; text-align: right; }

.mnemosyne-setting-unit { color: var(--SmartThemeEmColor); font-size: 0.85em; }

.mnemosyne-setting-help {
    grid-area: help;
    color: var(--SmartThemeEmColor);
    font-size: 0.85em;
    line-height: 1.35;
}

.mnemosyne-setting-help em { opacity: 0.85; }

.mnemosyne-setting-range {
    grid-area: range;
    color: var(--SmartThemeEmColor);
    font-size: 0.78em;
    opacity: 0.7;
}

.mnemosyne-setting-actions { display: flex; gap: 0.6em; padding: 0.2em 0; }

.mnemosyne-preset-head { font-weight: 600; margin-top: 0.4em; }

.mnemosyne-preset-new { display: flex; gap: 0.6em; align-items: center; }

.mnemosyne-preset-input { flex: 1 1 auto; min-width: 0; }

.mnemosyne-preset { display: flex; gap: 0.6em; align-items: center; }

.mnemosyne-preset-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }

/* ---- The reset block ----

   ⚠️ SEPARATED BY A RULE AND A TINT, NOT BY A THIRD BUTTON COLOR. The two-color rule above still holds —
   the button in here is the same \`--danger\` as "Delete this memory", because they are the same KIND of
   action and inventing a redder red for this one would start the palette this stylesheet exists to refuse.
   What distinguishes it is the boundary: it is the only region on the settings screen with a border, so it
   reads as a different part of the page rather than as one more control in a column of controls.

   The margin above it is deliberately large. This sits directly under the preset list, and a destructive
   control one line below a routine one is a mis-click waiting to be reported as data loss. */
.mnemosyne-danger-head {
    margin-top: 2em;
    padding-top: 0.8em;
    border-top: 1px solid color-mix(in srgb, var(--warning, crimson) 35%, transparent);
    color: var(--warning, crimson);
}

.mnemosyne-danger-zone {
    display: flex;
    flex-direction: column;
    gap: 0.5em;
    margin-top: 0.6em;
    padding: 0.8em;
    border: 1px solid color-mix(in srgb, var(--warning, crimson) 45%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--warning, crimson) 7%, transparent);
}

/* The standing measurement — "412 memories · 13.0 MB on disk". Full body color rather than the dimmed
   \`--SmartThemeEmColor\` the help lines use, because it is the one line in this block that is a FACT about
   the store rather than an explanation of the button: it has to be readable at a glance, from across the
   room, by someone checking whether a reset already happened. */
.mnemosyne-danger-size { margin-top: 0.5em; }

/* The outcome sentence — "Erased 412 memories, 13.0 MB → 96.0 KB". It is the ONLY confirmation the user
   gets that anything happened, because a successful reset leaves a screen that looks exactly like the one
   before it apart from this line. */
.mnemosyne-danger-notice {
    margin-top: 0.5em;
    padding: 0.5em 0.7em;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 45%, transparent);
    background: color-mix(in srgb, var(--SmartThemeQuoteColor) 12%, transparent);
}

/* Show rescan progress while the request remains pending. A rescan
   holds its request open for a minute or more, and the panel can render nothing new until it answers — so the
   only thing that can change on screen meanwhile is what the host does to the clicked control. It adds
   \`pluginPanel-pending\` (dimmed, unclickable, and every other action is refused until it clears); these rules
   hang the green line and its spinner off that same class, so they appear and vanish exactly with it.
   ⚠️ An exception to this sheet's "nothing here carries meaning" rule, and a forced one: there is no fragment
   to put the words in while the request is in flight. Without the sheet the host's dimming still shows. The
   progress state is explicit and not dependent on a theme color. */
.mnemosyne-rescan:has(.pluginPanel-pending) .mnemosyne-rescan-status::before {
    content: "⟳";
    display: inline-block;
    margin-right: 0.4em;
    animation: mnemosyne-spin 1s linear infinite;
}
.mnemosyne-rescan:has(.pluginPanel-pending) .mnemosyne-rescan-status::after {
    content: "Rescanning… this can take a minute or more.";
}
.mnemosyne-rescan-status {
    color: #4caf50;
    font-weight: bold;
}
@keyframes mnemosyne-spin { to { transform: rotate(360deg); } }

`;
