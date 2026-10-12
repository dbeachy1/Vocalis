
/**
 * The panel's HTML, and nothing else.
 *
 * Every fragment `GET /panel` can return is built here, from plain records. **No Express, no store, no
 * context, no I/O** — records in, string out. That is the whole design of this module and the reason it is
 * separate: what the panel *says* is a presentation question, and answering it should not require booting a
 * plugin, faking a fork, and unlocking a vault, which is what testing these functions used to cost.
 *
 * ## 🔴 Escaping is INTEGRITY here, not tidiness — and this argument was recently promoted
 *
 * The fragment is sanitized by the host (DOMPurify) before it reaches the DOM. Until the fork's interactive
 * panels (`DESIGN_PLUGIN_PANEL_UI.md`), the worst an unescaped memory could do was **vanish**: a statement
 * containing `<b>` reached DOMPurify as markup, was eaten, and the user saw a memory with a word missing and
 * no indication anything had happened. Bad, but a display bug.
 *
 * **That is no longer the worst case.** Data attributes survive sanitizing, because the interactive protocol
 * needs them to. So a memory whose text contained
 *
 * ```html
 * <div data-panel-action="/memory/1" data-panel-method="DELETE">tap here</div>
 * ```
 *
 * would, rendered raw, become a **working control** in the user's own panel pointed at the user's own store.
 * The host's prefixing rule keeps it inside this plugin's routes under the already-authenticated session, so
 * it is self-inflicted rather than cross-user — but "a memory can render a button that deletes a memory" is a
 * real defect, and the text in question is written by a language model.
 *
 * 🔴 **Every interpolation of stored or model-generated text goes through {@link escapeHtml}, without
 * exception, and this rule must not be "simplified" away by a later contributor who reads it as belt and
 * braces.** It is not. It is the only thing standing between the extractor's output and the action protocol.
 * There is deliberately no opt-out marker (the fork considered and rejected a `data-panel-untrusted` wrapper:
 * one rule applied everywhere beats two rules where the second excuses the first).
 *
 * ## 🔒 What may appear here
 *
 * Memory statements — the thing the whole store encrypts — are rendered in full, and that is correct. These
 * fragments are served behind the authenticated handle, and `readPanel` will not call any renderer that takes
 * a statement unless the caller's vault is open; a locked one gets {@link renderLockedPanel}, which names
 * nothing. That gate is the reason statements are allowed here and are deliberately absent from the
 * notification channel (see `activity.js`) — two channels, one of them gated, so the gate is worth something.
 *
 * ⚠️ **This is a view, so it never logs.** The plugin's logging rule (`DESIGN.md` §5.6) is that memory text is
 * never written to a log; a module that holds every memory statement in a local variable is exactly where a
 * debugging `console.log` would do the most damage. There are no log calls in this file and there never
 * should be one.
 *
 * ## 🔴 Days are bucketed HERE, in JavaScript, never in SQL
 *
 * The store hands out UTC epochs and this module groups them using the IANA zone the browser supplied (fork
 * panel design §7.7). SQLite cannot do it: it knows `'localtime'` — the *server's* zone — and fixed numeric
 * offsets, has no IANA zone database, and a fixed offset is wrong on both sides of a DST boundary. On a
 * single-machine install the two zones agree, which is precisely what would keep the bug invisible until
 * a timezone boundary is crossed.
 */

import { RESET_PHRASE } from './config.js';
import { SETTINGS_SCHEMA } from './settings.js';


/** How many memories one page of the browse view shows. */
export const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------------------------------------
// The shapes this module renders from.
//
// 🔴 **DECLARED HERE, AND ONLY HERE.** `src/api/panel.js` builds every one of these and this file consumes
// them; a shape written out at both ends is a shape that will eventually disagree with itself, and the half
// that drifts is the half nobody is reading. The direction matches the runtime import — `api/panel.js`
// imports this module, never the other way round — so the types travel the same way the values do.
//
// ⚠️ Two of these records (`RecallRecord`, `IngestRecord`) are actually WRITTEN in `src/retrieval.js` and
// `src/session-state.js`, which return them as bare `object`. What is declared below is therefore the slice
// the panel reads, in the same spirit as `types/express.d.ts`: a statement of what we call, not a promise
// about everything the producer puts in.
// ---------------------------------------------------------------------------------------------------------

/**
 * Which of the four top-level views is on screen. The allow-list `viewState` filters `?view=` against, so an
 * unknown value never reaches {@link renderRegions}' branch table — see `api/panel.js`.
 *
 * ⚠️ `log` is the odd one out and deliberately so: it is the only view that reads no store, which is what lets
 * it answer when the store is the thing that is broken. See {@link renderLog}.
 * @typedef {'browse'|'calendar'|'prompt'|'log'|'settings'} PanelViewName
 */

/**
 * The identity axes the host appended to this panel request, as `identityOf` resolves them.
 *
 * 🔴 `undefined` and `''` are different facts and the difference decides whether a filter may be offered at
 * all — see `availableScopes`. That is why `charId`/`personaId` are `string|undefined` rather than
 * `string|null`: null would be a value the host sent, and the whole point is that it sent nothing.
 *
 * @typedef {object} PanelIdentity
 * @property {string|null} chatId
 * @property {string|undefined} charId
 * @property {string|undefined} personaId
 */

/**
 * A view's whole state, as `viewState` settles it from the query string and every action carries it forward.
 * @typedef {object} ViewState
 * @property {PanelViewName} view
 * @property {number} offset
 * @property {string} scope One of `story`, `me`, `all` — narrowed by `scopesAvailable`, never by this type.
 * @property {boolean} replaced
 * @property {boolean} recalled
 * @property {number|null} edit The memory whose edit box is open, if any.
 * @property {number|null} expand The memory whose history is open, if any.
 * @property {boolean} add
 * @property {boolean} danger Whether the settings screen's reset confirmation is open. ⚠️ Opening it is the
 *   only thing this flag does; the phrase typed into it is what actually authorizes the reset, and that is
 *   checked by the route. A client that sets `danger=1` by hand has skipped a dialog, not a safeguard.
 * @property {number|null} slot ⚠️ A POSITION, so 0 is legitimate — see `viewState`.
 * @property {number} turn How many replies back the prompt view is looking; 0 is the most recent.
 * @property {string|null} month `YYYY-MM`, for the calendar.
 * @property {string[]} regions ⚠️ An ARRAY here and a comma-joined STRING in {@link ActionOverride} — see
 *   {@link params}, which stringifies either.
 * @property {string} tz The browser's IANA zone. Untrusted input; every reader falls back to UTC.
 * @property {PanelIdentity} identity
 * @property {Set<string>} scopesAvailable
 */

/**
 * What one action changes about the state it carries forward.
 *
 * 🔴 **NOT `Partial<ViewState>`, and the difference is not cosmetic.** Three fields are genuinely a different
 * type on this side: `regions` is the comma-joined string an action names its own regions with, while the
 * state parses it back into an array; and the flags are written as `1`/`null` because that is what
 * {@link params} normalizes and `viewState` reads back. Two fields — `id` and `tier` — exist ONLY here: they
 * name the entity an action acts on and are deliberately absent from the view's own state, because the panel
 * keeps no server-side state and a row's occupant changes identity on every edit (see {@link renderRow}).
 *
 * @typedef {object} ActionOverride
 * @property {PanelViewName} [view]
 * @property {number|null} [offset]
 * @property {string|null} [scope]
 * @property {number|null} [replaced]
 * @property {number|null} [recalled]
 * @property {number|null} [edit]
 * @property {number|null} [expand]
 * @property {number|null} [add]
 * @property {number|null} [danger] `1` opens the reset confirmation, `null` closes it.
 * @property {string|null} [month]
 * @property {string} [regions] Comma-joined — see the note above.
 * @property {number|null} [slot]
 * @property {number|null} [id] The memory this action acts on.
 * @property {string} [tier] Which tier a new memory is written to. `POST /memory` refuses to guess one.
 * @property {number|null} [turn]
 */

/**
 * One memory the last reply actually used, as `noteInjection` records it.
 *
 * 🔴 `id` is load-bearing for the PANEL, not only for the log: it is the only thing that lets the browse view
 * mark which of the listed memories a reply used ({@link recalledBadge}). `src/session-state.js` declares this
 * shape without it, which is the annotation that would have hidden the gap.
 *
 * @typedef {object} RecallHit
 * @property {number} id
 * @property {string} tier
 * @property {string} text
 * @property {number} score Cosine similarity, converted from the stored L2 distance.
 */

/**
 * What retrieval did for one generation — the record `noteInjection` writes and this module reads.
 *
 * 🔴 **ONE SHAPE FOR BOTH OUTCOMES, AND `active` IS WHAT TELLS THEM APART.** A decline carries `reason` and
 * little else; a success carries the block, the hits and the numbers. Everything but `active` and `at` is
 * therefore optional, and that is a statement about the record rather than defensiveness — a renderer that
 * reads `count` without first checking `active` is reading a field a decline never had.
 *
 * ⚠️ Optionality also covers records written by an EARLIER VERSION and still sitting in the per-handle
 * buffer across an upgrade: `block` post-dates `hits`, which is exactly why {@link renderPrompt} has a branch
 * for an active record with no block, and why {@link declineSentence} guards `nearest`.
 *
 * @typedef {object} RecallRecord
 * @property {boolean} active
 * @property {number} at Epoch ms, stamped by `noteInjection` on every record.
 * @property {string|null} [chatId] The chat this generation belonged to — the per-chat gate's whole input.
 * @property {string} [reason] Declines only. See {@link declineSentence} for the codes.
 * @property {number} [count]
 * @property {string} [query] What `composeQuery` searched with. Present on successes and on `below-threshold`.
 * @property {string|null} [model] The embedding model, from the fork at runtime — never a constant.
 * @property {string} [backend]
 * @property {string} [block] The injected text VERBATIM. 🔒 Memory statements; see the module header's gate.
 *   ⚠️ An emoji may not be the FIRST character of a `@property` description: TypeScript is still parsing the
 *   name there and rejects a surrogate pair with `TS1127`, exactly as it does an em-dash in a `@see`.
 * @property {number} [blockChars]
 * @property {string} [placement] `'system-before-last'`, `'above-last-turn'` or `'prepended'` — see
 *   {@link placementSentence}.
 * @property {number} [nearest] `below-threshold` only: the best cosine on offer.
 * @property {number} [candidates] `below-threshold` only: how many rows it was the best of.
 * @property {RecallHit[]} [hits]
 */

/**
 * What the last ingest pass wrote, as `noteIngest` records it. Deduplicated by text, one record per pass.
 * @typedef {object} IngestRecord
 * @property {boolean} active
 * @property {number} count
 * @property {string|null} chatId
 * @property {number} at
 * @property {Array<{ text: string, replaced: string|null }>} items
 */

/**
 * What the ingest trigger gate decided this turn — counts and a chat id, never content.
 * @typedef {object} GateRecord
 * @property {number} fresh
 * @property {number} needed
 * @property {number} at
 * @property {string|null} chatId
 */

/**
 * How the last ingest pass that actually ran ended — the record behind the panel's red banner.
 *
 * ⚠️ `reason` and `fix` are `describeFailure`'s output and are content-free by construction
 * (`ingest/diagnose.js`); nothing here is ever the caught error's own message. `consecutive` counts failures
 * in a row and is reset only by a genuine success, which is what lets the banner escalate its wording without
 * the render having to remember anything.
 *
 * @typedef {object} OutcomeRecord
 * @property {boolean} ok
 * @property {string|null} reason
 * @property {string|null} fix
 * @property {number} consecutive
 * @property {number} at
 * @property {string|null} chatId
 */

/**
 * Why each retired row on this page was retired: `id of the memory that replaced it` → that memory's `source`.
 *
 * ⚠️ **Keyed `number|null`, deliberately.** {@link renderRow} looks up `memory.supersededBy` directly, and a
 * retired row that was DELETED rather than replaced carries `null` there. `Map.get(null)` is `undefined`,
 * which {@link retirementReason} already reads as "unknown" — so the wider key type describes what the call
 * sites actually pass, where a `number` key would need a cast asserting something false on exactly that row.
 * Nothing is ever stored under the null key; `sourcesOf` only ever returns ids.
 *
 * @typedef {ReadonlyMap<number|null, string|null>} SuccessorSources
 */

/**
 * What the header says about the store, per partition.
 *
 * ⚠️ `null` is not zero and the sentence branches on the difference: it means the host gave us no identity to
 * compose that partition from, so a count for it would be a guess dressed as a fact. `total` is the union of
 * the partitions we CAN compose — the same set the "Everything" button shows, never the whole database.
 *
 * @typedef {object} MemoryCounts
 * @property {number} total
 * @property {number|null} user
 * @property {number|null} scenario
 */

/**
 * Everything the browse view renders from, read once by `browseSpec` so a full render and a partial one can
 * never disagree about what is in the store.
 * @typedef {object} BrowseSpec
 * @property {ViewState} view
 * @property {import('./schema.js').MemoryRow[]} memories
 * @property {number} total
 * @property {MemoryCounts} counts
 * @property {Set<number>} predecessors Which of `memories` have earlier versions to expand.
 * @property {Map<number, import('./schema.js').MemoryRow[]>} versionsFor Walked ONLY for the expanded row.
 * @property {OutcomeRecord|undefined} outcome How the last ingest pass ended — undefined until one runs.
 * @property {SuccessorSources} sources
 * @property {Map<number, number>} recalled Memory id → the similarity the last reply retrieved it at.
 * @property {number} recalledCount
 * @property {import('./schema.js').MemoryRow[]} recalledMemories The recalled rows themselves, newest first —
 *   what {@link renderRecalled} pins at the top of the view. ⚠️ The SAME rows the `recalled=1` filter puts in
 *   the list, read once by `browseSpec` so the section and the filtered list can never disagree.
 * @property {number} minCosine The similarity floor, for the one decline sentence that quotes it.
 * @property {RecallRecord|undefined} recall
 * @property {number|null} editing
 * @property {boolean} adding
 * @property {string} tz
 * @property {number} now
 * @property {string|null} charName
 * @property {GateRecord|undefined} gate
 * @property {number} firstPassMessages
 * @property {number} maxMemories
 * @property {number} replacedCount
 * @property {Set<string>} scopesAvailable
 */

/**
 * Escape text for safe interpolation into an HTML fragment.
 *
 * 🔴 Load-bearing for integrity, not only display — see the module header. Quotes are escaped too, and that
 * matters more than it looks: every action in this panel carries its state in `data-panel-params`, and an
 * unescaped `"` in an attribute value ends the attribute and starts a new one.
 *
 * 🔴 **TOTAL BY CONSTRUCTION, AND THE ANNOTATION NOW SAYS SO.** The body is `String(text).replace(...)`,
 * which cannot throw on any input, and that is deliberate rather than incidental: this is the last thing
 * standing between an extractor's output and the action protocol, so one stray `null` reaching it must not
 * take a panel down. The tag used to read `@param {string}`, which was narrower than the code and made
 * `panel-view.test.js`'s `escapeHtml(null)` case — the test that PINS the totality — impossible to state
 * truthfully.
 *
 * ⚠️ `string|null|undefined` rather than `unknown`, deliberately. `unknown` would also be true, and it
 * would stop the checker objecting to `escapeHtml(someObject)` — which is a real call-site bug that renders
 * the literal text `[object Object]` into a user's panel. This spelling makes the test honest and keeps that
 * one flagged.
 *
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function escapeHtml(text) {
    // ⚠️ The cast is what says the lookup cannot miss: the character class and the table's keys are the same
    // five characters, written twice on one line, so `replace` is only ever handed a key that is present.
    // Without it the table indexes as `string|undefined`, which `replace` will not accept as a replacement —
    // the checker asking, reasonably, what happens on the sixth character. There is no sixth character.
    return String(text).replace(/[&<>"']/g, c => (/** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }))[c]);
}

/**
 * A byte count as a person reads it.
 *
 * ⚠️ Base 1024 with the short units, because that is what a file manager on either platform shows for the
 * same file and this number exists to be compared against one.
 *
 * ⚠️ **It lives in this module, with the rest of the presentation, and is imported by the reset route** —
 * which is where it used to live. The settings screen prints the size of a store nobody is erasing, and the
 * reset notice prints the same measurement either side of a delete; a second copy would eventually round
 * differently from the first on the one screen where both numbers are read together.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function humanBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return 'an unknown size';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let unit = 0;

    while (n >= 1024 && unit < units.length - 1) {
        n /= 1024;
        unit++;
    }

    // Whole bytes are whole; everything else gets one decimal, so "13.0 MB → 96.0 KB" reads as a measurement
    // rather than as a rounding.
    return `${unit === 0 ? n : n.toFixed(1)} ${units[unit]}`;
}

/**
 * Render the recall readout: what was remembered and what was recalled for the last reply.
 *
 * 🔴 THIS IS ALSO THE WHOLE PANEL ON A PRE-INTERACTIVE HOST. A fork below `apiVersion` 4 honors no actions,
 * so a browse view there would render a screen of controls that silently do nothing — worse than not offering
 * them (fork §11.2). `readPanel` feature-detects and serves exactly this, unchanged, which is why it still
 * carries no region and no action.
 *
 * 🔴 WRITES FIRST, THEN RECALLS. The UI reports a write before showing the resulting recall state.
 *
 * @param {RecallRecord|undefined} recall A recall record (src/session-state.js)
 * @param {IngestRecord|undefined} ingest A write record (src/session-state.js)
 * @returns {string} an HTML fragment
 */
export function renderPanel(recall, ingest) {
    const sections = [];

    if (ingest?.active === true) {
        const noun = ingest.count === 1 ? 'memory' : 'memories';
        // 🔴 A supersession is rendered as a REPLACEMENT, naming what it replaced. Shown as a bare addition, a
        // corrected fact ("she lives in Sample City 3") reads beside the memory it retired ("she lives in Sample City 5") as a
        // contradiction the plugin failed to notice — when in truth it noticed, and acted. The old statement is
        // no more sensitive than the new one: same store, same lock, same panel.
        const items = ingest.items.map(item => (item.replaced
            ? `<li>${escapeHtml(item.text)}<br><small>replacing: ${escapeHtml(item.replaced)}</small></li>`
            : `<li>${escapeHtml(item.text)}</li>`)).join('');

        sections.push(`  <p>Remembered ${ingest.count} new ${noun} from this conversation:</p>
  <ul>${items}</ul>`);
    }

    if (recall?.active === true) {
        const items = (recall.hits ?? []).map(h => `<li>${escapeHtml(h.text)}</li>`).join('');
        const noun = recall.count === 1 ? 'memory' : 'memories';
        const forQuery = recall.query ? ` relevant to “${escapeHtml(recall.query)}”` : '';

        sections.push(`  <p>Recalled ${recall.count} long-term ${noun}${forQuery} for your last reply:</p>
  <ul>${items}</ul>`);
    }

    if (sections.length === 0) {
        return '<div class="mnemosyne-panel"><p><em>Nothing was recalled or remembered for your last reply.</em></p></div>';
    }

    return `<div class="mnemosyne-panel">
${sections.join('\n')}
</div>`;
}

/**
 * The fragment a locked vault gets — a 200 that names no memory.
 *
 * 🔴 THIS EXISTS SO THE ROUTE CAN ANSWER 200 INSTEAD OF 409. The fork's client turns any non-OK status into
 * "This panel could not be loaded" (`plugin-panels.js` `openPanel`), which for the one state that is not a
 * fault at all tells a user their memory is BROKEN when it is merely locked. Returning a fragment instead
 * costs no confidentiality, because this one names nothing — which is precisely why it is a separate function
 * rather than a branch inside a renderer that takes records full of memory statements. It takes no arguments,
 * and it should stay that way.
 *
 * @returns {string} an HTML fragment
 */
export function renderLockedPanel() {
    return '<div class="mnemosyne-panel"><p><em>Memory is locked.</em></p>' +
        '<p>Unlock your vault to see what was recalled and remembered. Nothing has been lost — your memories ' +
        'are encrypted at rest and need the vault\'s key to read.</p></div>';
}

// ---------------------------------------------------------------------------------------------------------
// The memory browser (fork panel design §13). Everything below emits regions and actions, and therefore only
// ever reaches an `apiVersion >= 4` host.
// ---------------------------------------------------------------------------------------------------------

/**
 * A view's state, rendered as the query string every action carries forward.
 *
 * 🔴 THE PANEL KEEPS NO SERVER-SIDE UI STATE, and this function is why. Which page you are on, which scope is
 * selected, whether replaced memories are shown, which row has its edit box open — all of it lives in the
 * next action's URL and nowhere else (fork §4). There is consequently no cache to invalidate, no half-updated
 * view, and no race between two clicks: a buggy fragment renders wrong once and the next interaction fixes it.
 *
 * ⚠️ `as=html` rides on every action deliberately. It is what selects the fragment branch of the shared
 * memory routes, which otherwise answer JSON to their API callers — see `wantsFragment` in `api/request.js`.
 *
 * @param {ViewState} state The current view state
 * @param {ActionOverride} [override] Values to change for this particular action
 * @returns {string} an escaped query string, ready for a `data-panel-params` attribute
 */
function params(state, override = {}) {
    const merged = { ...state, ...override };
    const pairs = [['as', 'html']];

    for (const key of ['view', 'offset', 'scope', 'replaced', 'recalled', 'edit', 'expand', 'add', 'month', 'regions', 'slot', 'id', 'tier', 'turn', 'danger']) {
        // ⚠️ The cast is the loop's own list, restated as a type. Every name above is a member of {@link
        // ViewState} or of {@link ActionOverride}, so the lookup cannot miss — but TypeScript infers a bare
        // `string[]` for an array literal and will not carry the literals through a `for…of` binding, so it
        // has no way to see that. The two lists are checked against each other by this cast: add a name to
        // the loop that neither type declares and this line goes red.
        const value = merged[/** @type {keyof typeof merged} */ (key)];

        if (value !== undefined && value !== null && value !== '' && value !== false) {
            // 🔴 `true` becomes `'1'`, not `'true'`. The flags in this state are read back by `viewState` as
            // `=== '1'`, so a boolean stringified the obvious way round-trips to false and the view silently
            // loses its own state on the next click — the replaced toggle switching itself off as soon as you
            // page. Normalizing at the one place that writes the query string is what keeps the two ends
            // agreeing without either having to know about the other's spelling.
            pairs.push([key, value === true ? '1' : String(value)]);
        }
    }

    return escapeHtml(pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'));
}

/**
 * One clickable control.
 *
 * @param {{ label: string, action: string, method?: string, state: ViewState, override?: ActionOverride,
 *   title?: string, confirm?: string, key?: string, focus?: string, form?: string, className?: string }} spec
 * @returns {string}
 */
function action({ label, action: path, method = 'GET', state, override = {}, title, confirm, key, focus, form, className = 'pluginPanel-button' }) {
    const attrs = [
        `class="${escapeHtml(className)}"`,
        'role="button"',
        'tabindex="0"',
        `data-panel-action="${escapeHtml(path)}"`,
        `data-panel-method="${escapeHtml(method)}"`,
        `data-panel-params="${params(state, override)}"`,
    ];

    if (title) attrs.push(`title="${escapeHtml(title)}"`);
    if (confirm) attrs.push(`data-panel-confirm="${escapeHtml(confirm)}"`);
    if (key) attrs.push(`data-panel-key="${escapeHtml(key)}"`);
    if (focus) attrs.push(`data-panel-focus="${escapeHtml(focus)}"`);
    if (form) attrs.push(`data-panel-form="${escapeHtml(form)}"`);

    return `<span ${attrs.join(' ')}>${escapeHtml(label)}</span>`;
}

/**
 * The `YYYY-MM-DD` a moment falls on, in the user's zone.
 *
 * 🔴 `Intl`, not arithmetic, and not SQL — see the module header. `en-CA` is chosen because its short date
 * format IS `YYYY-MM-DD`, which sorts and compares as a string; nothing about the user's own locale is
 * involved, and nothing about this key is ever shown to them.
 *
 * ⚠️ The zone comes from the browser and is therefore untrusted input: a bad one makes `Intl` throw
 * `RangeError`, which would take down a panel render over a query parameter. Falls back to UTC, which is
 * wrong by at most a day boundary, rather than to an error, which is wrong entirely.
 *
 * @param {number} ms Epoch milliseconds
 * @param {string} tz IANA zone name
 * @returns {string}
 */
export function dayKey(ms, tz) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
            .format(new Date(ms));
    } catch {
        return new Date(ms).toISOString().slice(0, 10);
    }
}

/**
 * A day separator's label: Today, Yesterday, or the date as the user's own locale writes it.
 * @param {string} key A `YYYY-MM-DD` from {@link dayKey}
 * @param {string} tz IANA zone name
 * @param {number} now Epoch milliseconds
 * @returns {string}
 */
function dayLabel(key, tz, now) {
    const today = dayKey(now, tz);
    const yesterday = dayKey(now - 86400000, tz);

    if (key === today) return 'Today';
    if (key === yesterday) return 'Yesterday';

    const [y, m, d] = key.split('-').map(Number);

    try {
        // Noon UTC, so the formatted day cannot slip either side of a boundary whatever the zone.
        return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
            .format(new Date(Date.UTC(y, m - 1, d, 12)));
    } catch {
        return key;
    }
}

/**
 * The time of day a memory was stored, in the user's zone.
 * @param {number} ms Epoch milliseconds
 * @param {string} tz IANA zone name
 * @returns {string}
 */
function timeLabel(ms, tz) {
    try {
        return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    } catch {
        return new Date(ms).toISOString().slice(11, 16);
    }
}

/**
 * `HH:MM:SS` for a log line.
 *
 * ⚠️ Seconds, unlike {@link timeLabel}, and that is the whole reason for a second function. A log is read by
 * correlating it against something else — a message sent, a button pressed — and three ingest declines inside
 * one minute are indistinguishable without them.
 *
 * @param {number} ms Epoch milliseconds
 * @param {string} tz IANA zone
 * @returns {string}
 */
function logStamp(ms, tz) {
    try {
        return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
    } catch {
        return new Date(ms).toISOString().slice(11, 19);
    }
}

/**
 * How a memory's tier reads to a person. The scope key is right for debugging and unusable in a UI.
 * @param {import('./schema.js').MemoryRow} memory
 * @returns {string}
 */
function tierLabel(memory) {
    return memory.tier === 'user' ? 'about me' : 'this story';
}

/**
 * How a memory's provenance reads to a person. `source` is a verb in the store and a past participle here.
 * @param {string|null} source
 * @returns {string}
 */
function sourceLabel(source) {
    if (source === 'edit') return 'edited';
    if (source === 'restore') return 'restored';
    return source ?? 'memory';
}

/**
 * Why a memory is no longer live, in the user's terms.
 *
 * 🔴 The distinction the whole versioned-edit design turns on (fork §14.2): ingest's supersession and a hand
 * edit share one chain and one restore, and `source` is the ONLY thing that tells them apart. A user looking
 * at their own history needs to know which corrections were theirs, because the ones that were not are the
 * ones worth checking.
 *
 * 🔴 **The `source` that answers this is the SUCCESSOR's, never the retired row's own.** A retired memory
 * still carries whatever source it was written with — `auto`, `manual`, null — and that says how it was
 * *created*, which is a different question from how it was *replaced*. `reviseMemory` stamps `edit` on the new
 * row, so the reason lives one link forward. Reading it off the retired row instead labels every hand edit
 * "replaced as the story moved on", which is the panel telling the user the engine did something they did
 * themselves — precisely the black-box impression this feature exists to remove.
 *
 * @param {import('./schema.js').MemoryRow} memory The retired memory
 * @param {string|null|undefined} successorSource `source` of the memory that superseded it, if known
 * @returns {string}
 */
function retirementReason(memory, successorSource) {
    if (memory.supersededBy === null) return 'removed';
    if (successorSource === 'edit') return 'edited by you';
    // 🔴 A restore is the third cause, and it only exists because restoring is now reversible. Without it the
    // second half of the round-trip — restore the original, then change your mind — labels the row you just
    // stood down "replaced as the story moved on", i.e. the engine's doing, on the one action that was
    // unambiguously yours. `restoreMemory` stamps this source for exactly this sentence.
    if (successorSource === 'restore') return 'you restored an earlier version';
    return 'replaced as the story moved on';
}

/**
 * The badge that says this row is one of the memories the last reply actually used.
 *
 * `noteInjection` records the hit IDs for each generation; this badge exposes that record in the browse view.
 *
 * ⚠️ **A GLYPH FIRST, AND THE COLOR ONLY ON TOP OF IT.** Color supplements the visible status label. When this
 * was written a color was undeliverable — no channel existed for a plugin's own stylesheet — and the fork has
 * since shipped one (§10.3), which `src/panel-css.js` now uses to tint the row. The glyph did not become
 * redundant when that landed: the stylesheet is fetched once over the network and a failure is logged and
 * stepped over, so a mark that exists only in CSS is a mark that is sometimes simply absent, with nothing
 * saying so. `pluginPanel-badge` is the host's own primitive, the 💡 is legible with zero CSS, and it is
 * deliberately the same light bulb he clicked to get here.
 *
 * The similarity rides in the `title`, not in the label. It is the honest answer to "why this one" and it is
 * noise on a row the user is reading for its text.
 *
 * @param {number|undefined} score The cosine similarity this memory was retrieved at, if it was
 * @returns {string} a badge, or '' when this memory had nothing to do with the last reply
 */
function recalledBadge(score) {
    if (score === undefined) {
        return '';
    }

    const why = Number.isFinite(score)
        ? `Recalled for your last reply · similarity ${score.toFixed(2)}`
        : 'Recalled for your last reply';

    return `<span class="pluginPanel-badge mnemosyne-recalled" title="${escapeHtml(why)}">💡 recalled</span> `;
}

/**
 * What the second field is for, in one sentence, wherever it appears.
 *
 * ⚠️ One constant and not three copies: it is on the row, on the edit form and on the add form, and a wording
 * that drifted between them would describe three different features to a user who only has one.
 */
const INDEX_HELP = 'This line is what gets compared against future questions. The memory above is what gets ' +
    'read back into the conversation. A memory that is never recalled usually has an index line that does not ' +
    'name what it is about.';

/**
 * The index line, shown under the memory it indexes — or nothing at all when there is none.
 *
 * 🔴 **SHOWN, NOT HIDDEN, AND THAT IS THE POINT OF IT.** The user is entitled to see why a memory is or is not
 * being found; a store that quietly embeds something other than what it displays is exactly the black box this
 * panel exists to open.
 *
 * ⚠️ An absent line is rendered as an explicit sentence rather than as blank space, because blank space is
 * indistinguishable from a rendering bug. "This memory is found by its own text" is the true statement about a
 * hand-written memory (`embedText`, schema.js) and it needs saying.
 *
 * @param {import('./schema.js').MemoryRow} memory
 * @returns {string}
 */
function indexLineOf(memory) {
    const line = memory.indexLine ?? '';

    return line === ''
        ? `
  <div class="mnemosyne-index mnemosyne-index--none" title="${escapeHtml(INDEX_HELP)}">found by its own text</div>`
        : `
  <div class="mnemosyne-index" title="${escapeHtml(INDEX_HELP)}"><span class="mnemosyne-indexTag">found by</span> ${escapeHtml(line)}</div>`;
}

/**
 * One memory, as a row.
 *
 * 🔴 **THE REGION IS NAMED AFTER THE POSITION, NEVER AFTER THE MEMORY IN IT** (fork §5.3, a rule this plugin
 * found while building against the protocol). An edit is versioned — it writes a new row and retires the old
 * one (§14.2) — so the memory occupying a row changes identity the moment the user saves. Name the region
 * `memory-412` and the response after an edit names `memory-413`, which matches nothing on screen: the host
 * correctly ignores it as a stale region, and the row **silently stops responding to every action after its
 * first edit**. So the name is `slot-<n>`, a place in the panel fixed when the page was drawn, and the
 * current entity's id rides in `data-panel-params` instead. The slot survives whatever passes through it.
 *
 * @param {import('./schema.js').MemoryRow} memory A row from `listMemories`
 * @param {ViewState} view The current view state
 * @param {{ slot: number, versions?: import('./schema.js').MemoryRow[], hasVersions?: boolean,
 *   editing?: boolean, tz: string, now?: number, sources?: SuccessorSources, recalledAt?: number }} opts
 *   `recalledAt` is the similarity this memory was retrieved at for the last reply, and `undefined` when it
 *   was not — see {@link recalledBadge}. ⚠️ `now` is declared because both call sites pass it and neither
 *   this function nor anything it calls reads it; dropping it from the type would make those two object
 *   literals fail an excess-property check, which is a change to callers rather than a tidy-up here.
 * @returns {string}
 */
export function renderRow(memory, view, { slot, versions = [], hasVersions = false, editing = false, tz, sources = new Map(), recalledAt = undefined }) {
    const rowState = { ...view, slot, id: memory.id };
    const meta = `${escapeHtml(sourceLabel(memory.source))} · ${escapeHtml(tierLabel(memory))} · ${escapeHtml(timeLabel(memory.createdAt, tz))}`;

    if (editing) {
        // 🔴 `data-panel-focus` on the textarea, or the caret is lost the moment the region redraws around it.
        //
        // 🔴 **BOTH FIELDS, BECAUSE THEY ARE TWO DIFFERENT THINGS AND ONLY ONE OF THEM IS READ BY ANYONE.** The
        // memory is what gets injected into the conversation; the index line is what gets embedded and compared
        // against future questions (schema.js v5). A user whose memory exists but is never recalled can see
        // why here and fix it, which is the whole reason the second box is editable rather than merely shown.
        // The full memory text is injected; the separate index line is embedded and matched against queries.
        //
        // ⚠️ The index box is always sent, even when empty — and `PUT /memory/:id` reads an EMPTY string as
        // "clear it" and an ABSENT field as "keep it". That is correct here precisely because this form always
        // shows the current value: what the user sees in the box is what they are choosing to keep.
        const body = `<textarea name="text" rows="3" class="mnemosyne-edit" data-panel-focus="edit-${slot}">${escapeHtml(memory.text)}</textarea>
  <label class="mnemosyne-indexLabel" title="${escapeHtml(INDEX_HELP)}">how this memory is found
    <textarea name="indexLine" rows="2" class="mnemosyne-edit mnemosyne-edit--index" placeholder="the people, places and topics this memory is about">${escapeHtml(memory.indexLine ?? '')}</textarea>
  </label>`;
        const save = action({
            label: 'Save', action: `/memory/${memory.id}`, method: 'PUT', state: rowState,
            className: 'pluginPanel-button mnemosyne-button--primary',
            // ⚠️ `recalled` for the same reason delete carries it: an edit is versioned, so the saved row is a
            // NEW id that the recall record cannot name, and the section must stop claiming the old one.
            override: { edit: null, regions: `slot-${slot},header,toolbar,recalled` }, form: `slot-${slot}`,
        });
        const cancel = action({
            label: 'Cancel', action: '/panel', state: rowState,
            override: { edit: null, regions: `slot-${slot}` },
        });

        return `<div data-panel-region="slot-${slot}" class="pluginPanel-row mnemosyne-row--editing">
  ${body}
  <div class="pluginPanel-meta">${save} ${cancel}</div>
</div>`;
    }

    const controls = [
        // 🔴 NOT ON A RETIRED ROW. `reviseMemory` selects `WHERE id = ? AND retired = 0`, so editing one can
        // only ever 404 — and it 404s *after* the user has retyped the memory, with the panel holding no state
        // to give the text back. Retired rows appear whenever "☑ Show replaced" is ticked, and they already
        // offer `restore`, which is the correct way to act on a superseded memory.
        memory.retired ? '' : action({
            label: 'edit', action: '/panel', state: rowState, title: 'Edit this memory',
            override: { edit: memory.id, regions: `slot-${slot}` },
        }),
        hasVersions ? action({
            label: versions.length ? 'hide history' : 'history', action: '/panel', state: rowState,
            title: 'Earlier versions of this memory',
            override: { expand: versions.length ? null : memory.id, regions: `slot-${slot}` },
        }) : '',
        action({
            label: 'delete', action: `/memory/${memory.id}`, method: 'DELETE', state: rowState,
            title: 'Delete this memory for good',
            // The only red control in the panel. Everything else here is reversible — an edit is versioned
            // and a restore is itself restorable — so one color marking the one exception says something,
            // where coloring six controls six ways would say nothing. ⚠️ The confirm below is what actually
            // guards it; the color is a hint, exactly like the outline (see `panel-css.js`).
            className: 'pluginPanel-button mnemosyne-button--danger',
            confirm: 'Delete this memory? Unlike an edit, this cannot be undone.',
            // ⚠️ `recalled` is in this list because the deleted memory may be one of the recalled ones, and
            // that section counts from the STORE — leaving it out is how the top of the panel goes on listing
            // a memory the row beneath it just removed.
            override: { regions: `slot-${slot},header,toolbar,pager,recalled` },
        }),
    ].filter(Boolean).join(' ');

    // 🔴 **RESTORE IS OFFERED ON EVERY VERSION, NOT ONLY ON RETIRED ROWS IN THE LIST, AND IT IS WHAT MAKES THE
    // OPERATION REVERSIBLE.** History used to render as inert text, so the only restore control lived on a
    // retired row — which is reachable solely through the "Show replaced" toggle. That made the round trip
    // one-way in the ordinary case: edit a memory, expand its history, restore the original, and the wording
    // you just replaced is now sitting in the history list with no way back short of retyping it. Each history
    // entry therefore has its own restore control, making the operation reversible.
    //
    // 🔴 `expand` follows the restored memory. The restore redraws the list, and the row that comes back is a
    // *different* memory from the one that was expanded — so without this the history collapses at the exact
    // moment the user most needs to see it, and the version that just stood down vanishes with it. Pointing
    // `expand` at what was restored keeps the chain open around the swap, which is what makes the second
    // restore discoverable rather than merely possible.
    /** @param {number} id The memory to make current again — this row's, or one of its earlier versions'. */
    const restoreAction = (id) => action({
        label: 'restore', action: `/memory/${id}/restore`, method: 'POST', state: rowState,
        title: 'Make this version the current one again',
        override: { expand: id, edit: null, regions: 'list,header,toolbar,pager,recalled' },
    });

    // A retired row is present but not current: reduced, marked with why, and offered a way back.
    const restore = memory.retired ? ' ' + restoreAction(memory.id) : '';

    const history = versions.length
        ? `\n  <div class="mnemosyne-versions">${versions.map(v => `<div class="mnemosyne-version">
    <div class="mnemosyne-text">${escapeHtml(v.text)}</div>
    <div class="pluginPanel-meta">${escapeHtml(retirementReason(v, sources.get(v.supersededBy)))} · ${escapeHtml(timeLabel(v.createdAt, tz))} ${restoreAction(v.id)}</div>
  </div>`).join('')}</div>`
        : '';

    // Both badges can be true of one row — a memory recalled for the last reply and then edited by hand on this
    // one — so they compose rather than choosing. Retired first: why a row is not current outranks what it was
    // used for.
    const badge = (memory.retired
        ? `<span class="pluginPanel-badge">${escapeHtml(retirementReason(memory, sources.get(memory.supersededBy)))}</span> `
        : '') + recalledBadge(recalledAt);
    const versionNote = hasVersions && !versions.length
        ? '<div class="pluginPanel-meta mnemosyne-versionNote">└ earlier versions</div>'
        : '';

    // ⚠️ The class is the stylesheet's hook and the BADGE is the statement — never the other way round. A
    // stylesheet is fetched once over the network and a failure is logged and stepped over (fork §10.3), so a
    // row whose only mark is a color is a row that is sometimes unmarked, silently.
    const rowClass = `pluginPanel-row${memory.retired ? ' pluginPanel-muted' : ''}${recalledAt === undefined ? '' : ' mnemosyne-row--recalled'}`;

    return `<div data-panel-region="slot-${slot}" class="${rowClass}">
  <div class="mnemosyne-text">${badge}${escapeHtml(memory.text)}</div>${indexLineOf(memory)}
  <div class="pluginPanel-meta">${meta} ${controls}${restore}</div>${versionNote}${history}
</div>`;
}

/**
 * The list region: rows, grouped under day separators.
 *
 * 🔴 Grouped by `dayKey` in JS, with the browser's zone. Never in SQL. See the module header.
 *
 * @param {import('./schema.js').MemoryRow[]} memories Rows from `listMemories`, newest first
 * @param {ViewState} view The current view state
 * @param {{ versionsFor?: Map<number, import('./schema.js').MemoryRow[]>, predecessors?: Set<number>,
 *   editing?: number|null, tz: string, now: number, adding?: boolean, sources?: SuccessorSources,
 *   recalled?: Map<number, number> }} opts Rendering context. `recalled` maps memory id → the similarity it
 *   was recalled at for the last reply; a row missing from it was not recalled.
 * @returns {string}
 */
export function renderList(memories, view, { versionsFor = new Map(), predecessors = new Set(), editing = null, tz, now, adding = false, sources = new Map(), recalled = new Map() }) {
    const parts = [];

    if (adding) {
        // 🔴 TWO SAVE BUTTONS, ONE PER TIER, AND NO DEFAULT. `POST /memory` refuses to guess a tier and it is
        // right to: `user` promotes a scene into every future conversation and `scenario` buries a durable fact
        // in one chat, and neither mistake announces itself. The route cannot ask, so the panel does — which is
        // the only place in this system where a human is present to answer.
        const saves = [
            ['scenario', 'story', 'Save to this story'],
            ['user', 'me', 'Save as a fact about me'],
        ].filter(([, needs]) => view.scopesAvailable.has(needs)).map(([tier, , label]) => action({
            label, action: '/memory', method: 'POST', state: view,
            className: 'pluginPanel-button mnemosyne-button--primary',
            override: { add: null, tier, regions: 'list,header,toolbar,pager' }, form: 'list',
        })).join(' ');

        const cancel = action({ label: 'Cancel', action: '/panel', state: view, override: { add: null, regions: 'list' } });

        parts.push(`<div class="pluginPanel-row mnemosyne-row--editing">
  <textarea name="text" rows="3" class="mnemosyne-edit" data-panel-focus="add" placeholder="Something worth remembering…"></textarea>
  <label class="mnemosyne-indexLabel" title="${escapeHtml(INDEX_HELP)}">how this memory is found (optional)
    <textarea name="indexLine" rows="2" class="mnemosyne-edit mnemosyne-edit--index" placeholder="leave blank and the memory finds itself"></textarea>
  </label>
  <div class="pluginPanel-meta">${saves} ${cancel}</div>
</div>`);
    }

    let currentDay = null;
    let slot = 0;

    for (const memory of memories) {
        const key = dayKey(memory.createdAt, tz);

        if (key !== currentDay) {
            currentDay = key;
            parts.push(`<div class="mnemosyne-day">${escapeHtml(dayLabel(key, tz, now))}</div>`);
        }

        parts.push(renderRow(memory, view, {
            // 🔴 The row's position on this page, never its id — see renderRow. Counted across day separators
            // so it stays dense and stable for the whole render.
            slot: slot++,
            versions: versionsFor.get(memory.id) ?? [],
            hasVersions: predecessors.has(memory.id),
            editing: editing === memory.id,
            recalledAt: recalled.get(memory.id),
            sources,
            tz,
            now,
        }));
    }

    if (memories.length === 0 && !adding) {
        // ⚠️ The filtered view gets its own sentence. "Nothing here yet. Memories appear as your conversations
        // go on" under a *filter* is the panel reporting an empty store when the store is not empty — the one
        // claim this view must never make by accident. Reachable from a stale click: the toggle is offered only
        // while a recall record stands, and the next generation replaces it.
        parts.push(view.recalled
            ? '<p><em>Nothing from your last reply is here — the recall it refers to has been replaced by a later one.</em></p>'
            : '<p><em>Nothing here yet. Memories appear as your conversations go on — or add one yourself.</em></p>');
    }

    return `<div data-panel-region="list" class="pluginPanel-list">
${parts.join('\n')}
</div>`;
}

/**
 * The recall section, pinned at the top of the browse view: what the last reply actually used.
 *
 * ## 🔴 The answer goes FIRST, not behind a filter you have to know about
 *
 * This section puts memories used by the last reply before the broader history. Its filter narrows the list;
 * users do not need to enable a filter to see what was recalled.
 *
 * ## Why these rows are a READOUT and not {@link renderRow}s
 *
 * 🔴 **A row's region is named after its POSITION (`slot-<n>`), and the list below numbers its own slots from
 * zero.** Rendering full rows here would mint a second `slot-0` in the same panel, and every row-local action
 * — edit, delete, history — resolves through `container.querySelector('[data-panel-region="slot-0"]')`, which
 * returns the FIRST match. Deleting the first memory of the day list would redraw a recalled row instead. So
 * this section carries no per-row controls and no slots at all; the controls live on the same memories in the
 * list below, where the badge already marks them, and one click on the heading brings only those rows into it.
 *
 * ## A decline is content here, not a blank
 *
 * ⚠️ **The section renders on every browse view, including the turns that recalled nothing**, and says why —
 * {@link declineSentence}, the same wording the prompt view uses. A section that appears only on success is a
 * section that is missing exactly when the user is asking "did this thing even run?", and that is the
 * black-box impression this panel exists to remove.
 *
 * 🔒 Memory statements, and therefore behind `readPanel`'s open-vault gate like every other row here.
 *
 * @param {BrowseSpec} spec The browse spec; reads `recalledMemories`, `recalled`, `recall` and `minCosine`
 * @returns {string}
 */
export function renderRecalled({ view, recalledMemories, recalled, recall, recalledCount, minCosine, tz }) {
    // The heading IS the filter. `recalled` is in its own region list because this element re-renders itself:
    // the checkbox glyph and the sentence under it both change when it is clicked.
    const toggle = recalledCount > 0
        ? action({
            label: `${view.recalled ? '☑' : '☐'} 💡 Just recalled (${recalledCount})`,
            action: '/panel', state: view,
            className: `pluginPanel-button mnemosyne-recalled__toggle${view.recalled ? ' mnemosyne-scope--on' : ''}`,
            title: view.recalled ? 'Show everything else again' : 'Hide everything else and list only these',
            override: { recalled: view.recalled ? null : 1, offset: 0, edit: null, expand: null, regions: 'recalled,list,pager,toolbar,header' },
        })
        // 🔴 Still a heading when there is nothing to toggle, never an absent one. `recalledCount` is zero on
        // every decline, and the decline is the case this section is most worth reading.
        : '<span class="mnemosyne-recalled__title">💡 Just recalled</span>';

    // ⚠️ Offered only when a record exists at all — including declines, which is where it answers the most.
    // Same control, same target and the same `turn: null` reasoning the header's copy carried; it lives here
    // now because it is a statement about this same turn, and the two were a screen apart.
    const sent = recall
        ? ' ' + action({
            label: 'What was sent', action: '/panel', state: view,
            title: 'The exact text memory added to your last reply',
            override: { view: 'prompt', turn: null, regions: 'root' },
        })
        : '';

    let body;

    if (view.recalled) {
        // 🔴 THE ROWS ARE IN THE LIST BELOW, SO THEY ARE NOT ALSO HERE. With the filter on, `browseSpec` puts
        // exactly this set into `memories` — printing it twice would be the panel showing one answer as two.
        body = '<p class="pluginPanel-meta">Showing only these below. Click the heading again for everything.</p>';
    } else if (recalledMemories.length > 0) {
        body = `<div class="mnemosyne-recalled__items">${recalledMemories.map((memory) => {
            const score = recalled.get(memory.id);
            // ⚠️ The cast is the `Number.isFinite` on the line above it: that is declared to take `unknown`
            // and return `boolean`, so it narrows nothing the checker can carry forward.
            const why = Number.isFinite(score) ? `similarity ${(/** @type {number} */ (score)).toFixed(2)}` : 'recalled';

            return `<div class="mnemosyne-recalled__item">
    <div class="mnemosyne-text">${escapeHtml(memory.text)}</div>
    <div class="pluginPanel-meta">${escapeHtml(tierLabel(memory))} · ${escapeHtml(why)} · ${escapeHtml(timeLabel(memory.createdAt, tz))}</div>
  </div>`;
        }).join('\n')}</div>`;
    } else if (recall && recall.active !== true) {
        // The decline, in the words the prompt view already uses. One sentence, one source, no second
        // translation to drift from the first.
        body = `<p class="pluginPanel-meta">Nothing was recalled for your last reply — ${escapeHtml(declineSentence(recall, minCosine))}</p>`;
    } else if (recall) {
        // Active, but nothing survived: every memory it used has since been edited or deleted. `recalledCount`
        // is counted from the store rather than from the record for exactly this reason — see `browseSpec`.
        body = '<p class="pluginPanel-meta">The memories your last reply used are no longer in the store.</p>';
    } else {
        body = '<p class="pluginPanel-meta">Memory has not run yet in this conversation. This fills in as soon as you send a message.</p>';
    }

    return `<div data-panel-region="recalled" class="mnemosyne-recalled__section">
  <div class="mnemosyne-recalled__head">${toggle}${sent}</div>
  ${body}
</div>`;
}

/**
 * The red banner: automatic memory is failing, and here is what to do about it.
 *
 * ## 🔴 Why a panel needs this even though the log already has it
 *
 * Everything below the banner is built to explain a silence that is merely *waiting* — "next check in 5 more
 * messages" — and that is the right answer almost always. It is a confident wrong answer in exactly one case,
 * and it is the case that matters: a pass that THROWS does not advance the high-water mark, so the fresh count
 * only grows, the countdown pins at zero, and {@link renderHeader} says *"Next check on your next reply"* on
 * every turn for ever while nothing is ever stored. A user reading that has been told the system is about to
 * work, once per turn, indefinitely.
 *
 * A backend failure must be visible; otherwise the countdown can promise another check indefinitely while
 * ingestion never stores a memory.
 *
 * ⚠️ **Silent when there is nothing wrong, and that is what makes it worth reading.** A banner that is always
 * present is furniture; this one appears only on a real failure, so its presence is information.
 *
 * @param {{ outcome: OutcomeRecord|undefined, view: ViewState }} spec
 * @returns {string}
 */
export function renderAlert({ outcome, view }) {
    if (!outcome || outcome.ok || !outcome.reason) {
        return '<div data-panel-region="alert"></div>';
    }

    // The count is the difference between "the backend hiccuped once" and "this has never worked", and the
    // user cannot tell those apart from a single failure. Stated plainly rather than escalated with color,
    // because the banner is already the loudest thing on the screen.
    const repeated = outcome.consecutive > 1
        ? ` That is now ${outcome.consecutive} failed attempts in a row.`
        : '';

    const viewLog = action({
        label: 'View log', action: '/panel', state: view,
        title: 'Everything this plugin has logged since the server started',
        override: { view: 'log', regions: 'root' },
    });

    return `<div data-panel-region="alert"><div class="mnemosyne-alert">
<div class="mnemosyne-alert-head">⚠ Automatic memory is not working</div>
<div class="mnemosyne-alert-why">Nothing is being stored: ${escapeHtml(outcome.reason)}.${escapeHtml(repeated)}</div>
${outcome.fix ? `<div class="mnemosyne-alert-fix">${escapeHtml(outcome.fix)}</div>` : ''}
<div class="mnemosyne-alert-actions">${viewLog}</div>
</div></div>`;
}

/**
 * The log view: every operational line this plugin has emitted, in one selectable block.
 *
 * 🔴 **A `<textarea>`, not a `<pre>`, and the difference is the entire feature.** The ask was *"show me all the
 * lines that I can copy and paste into you easily"* — and a `<pre>` inside a scrolling panel is selected by
 * dragging across a region that scrolls while you drag. A read-only textarea takes a click and Ctrl-A. The
 * value here is not that the lines are visible; they were always visible, in `st.log`, on a box the user would
 * have to SSH into. The value is that they are one gesture away from a bug report.
 *
 * ⚠️ **`readonly`, not `disabled`.** A disabled control cannot be focused, so Ctrl-A inside it does nothing —
 * which would quietly remove the only reason this is a textarea.
 *
 * ⚠️ The tape holds only the NORMAL channel, so nothing shown here is memory text or chat text — see
 * `log-tape.js`. That is what makes it safe for the reader to paste into a bug report.
 *
 * 🔴 **BUT "CONTENT-FREE" IS NOT "ABOUT NOBODY", WHICH IS WHY THIS IS ADMIN-ONLY.** The tape is process-global
 * — the logging seam has no handle to filter on — so it interleaves every user on the install. The lines carry
 * no statements, and in aggregate they still describe the other accounts: how many stores are open, how many
 * memories each is accumulating, the cosine and novelty of what was just stored, which ids were recalled, all
 * stamped to the second. That is an activity log of when other people are online and how they are using the
 * thing. On a plugin whose premise is a per-user encrypted store, handing it to any logged-in user was a
 * cross-tenant leak of metadata, and the sentence above used to end "safe to put in front of a user" — which
 * was reasoning about the reader and never about the people being read.
 *
 * ⚠️ An admin already has `st.log`, which holds strictly more than this, so the gate costs the legitimate
 * caller nothing. A non-admin is told the log exists and who can read it, rather than being shown a blank.
 *
 * @param {{ tape: Array<{ at: number, level: string, text: string }>, view: ViewState,
 *          denied?: boolean }} spec
 * @returns {string}
 */
export function renderLog({ tape, view, denied = false }) {
    const back = action({
        label: '‹ Back', action: '/panel', state: view,
        override: { view: 'browse', regions: 'root' },
    });

    // 🔴 SAYS SO WHEN IT IS EMPTY, rather than rendering an empty box. An empty log and a log that has not been
    // written to yet are the same picture and opposite meanings, and the second one is much the more likely:
    // the tape lives in memory, so a server restarted a minute ago has nothing in it and nothing is wrong.
    const body = denied
        ? 'The Mnemosyne log is available to administrators only.\n\nIt is a single shared trace of everything the plugin has done since the server started, across every account on this install — so it describes other people\'s activity as well as yours, and it is not filtered per user.\n\nYour own memories, and what was recalled for this chat, are all on the panel behind the Back button.'
        : tape.length === 0
            ? 'Nothing logged yet in this server run.\n\nThe log is kept in memory, so it starts empty every time SillyTavern restarts. Send a message or two and the ingest lines will appear here.'
            : tape.map(line => `${logStamp(line.at, view.tz)} [${line.level.toUpperCase()}] ${line.text}`).join('\n');

    return `<div data-panel-region="root" class="mnemosyne-panel">
<div class="mnemosyne-log-head">${back}<span class="mnemosyne-log-title">${denied ? 'Mnemosyne log — administrators only' : `Mnemosyne log — ${tape.length} line${tape.length === 1 ? '' : 's'} this server run`}</span></div>
<textarea class="mnemosyne-log" readonly rows="20" spellcheck="false">${escapeHtml(body)}</textarea>
${denied ? '' : '<div class="mnemosyne-log-foot">Click inside and press Ctrl-A, then Ctrl-C, to copy all of it.</div>'}
</div>`;
}

/**
 * The header region: what the engine holds, and when it next looks.
 *
 * 🔴 This is the answer to *"I don't feel like it works. I don't know that it's working."* Every number here
 * exists to make the engine legible, and the gate line is the one that matters most — a panel that can say
 * "next check in 5 more messages" is a panel that has explained a silence, which is the difference between a
 * system that seems broken and one that is merely waiting.
 *
 * ⚠️ An absent gate record is its own honest sentence, not a blank. It means no generation has been seen for
 * this chat yet, which is exactly the state the early-first-pass rule exists for.
 *
 * ⚠️ `recall` is deliberately NOT on this signature any more. This region is a statement about the STORE;
 * everything about one particular turn now lives in {@link renderRecalled}. The whole {@link BrowseSpec} is
 * still what gets passed — a destructure reads what it needs and ignores the rest.
 *
 * @param {{ counts: MemoryCounts, charName: string|null, gate: GateRecord|undefined,
 *   firstPassMessages: number, maxMemories: number, view: ViewState }} status
 * @returns {string}
 */
export function renderHeader({ counts, charName, gate, firstPassMessages, maxMemories, view }) {
    const who = charName ? `${escapeHtml(charName)} remembers` : 'You have';
    /** @param {number} n @param {string} one @param {string} many @returns {string} */
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

    // ⚠️ The sentence adapts to what the host actually told us. A count for a partition we cannot compose
    // would be a guess dressed as a fact, and this header's only job is to be believed.
    let about;

    if (counts.user !== null && counts.scenario !== null) {
        about = `${plural(counts.user, 'thing', 'things')} about you, and ${counts.scenario} about this story`;
    } else if (counts.scenario !== null) {
        about = `${plural(counts.total, 'memory', 'memories')}, ${counts.scenario} of them about this story`;
    } else {
        about = plural(counts.total, 'memory', 'memories');
    }

    // The cap belongs to BOTH branches, but the threshold behind it belongs to neither as a trailing clause —
    // it was one, and it printed the wrong number to the only state that could see it. Each branch now states
    // only what is true of the reader standing in it.
    const cap = `stores at most ${plural(maxMemories, 'memory', 'memories')}`;
    let cadence;

    if (gate && Number.isFinite(gate.fresh) && Number.isFinite(gate.needed)) {
        const left = Math.max(0, gate.needed - gate.fresh);
        // The countdown is derived from the gate's OWN `needed`, so it is already right for whichever threshold
        // fired — which is why the threshold itself never needs printing here. A number the reader cannot act
        // on is the one that got this rewritten.
        cadence = left === 0
            ? `Next check on your next reply. Each pass ${cap}.`
            : `Next check in ${left} more message${left === 1 ? '' : 's'}. Each pass ${cap}.`;
    } else {
        // 🔴 An absent gate record means no generation has been seen for this chat yet — which is BY DEFINITION
        // the pre-first-pass state, the one case where the threshold is `firstPassMessages` and NOT
        // `triggerMessages`. This branch used to print 12, telling the user the opening of their scenario would
        // be ignored for twelve messages: precisely the misconception `firstPassMessages` exists to prevent.
        // See `INGEST_DEFAULTS.firstPassMessages` and `ingest/index.js`'s `opening` branch.
        cadence = 'Nothing checked yet in this conversation — the first pass runs after '
            + `${plural(firstPassMessages, 'message', 'messages')} and ${cap}.`;
    }

    const calendar = action({
        label: '📅', action: '/panel', state: view, title: 'Jump to a date',
        override: { view: 'calendar', month: null, regions: 'root' },
    });

    // 🔴 "What was sent" USED TO LIVE HERE AND NOW LIVES IN {@link renderRecalled}. It is a statement about
    // one particular turn, and this header is a statement about the store — so a control answering "what did
    // you actually put in my prompt?" sat a screen away from the section that says what that prompt recalled.
    // It is offered on the same condition it always was (a record exists, declines included) and carries the
    // same `turn: null`; only its neighbors changed. `recall` stays on this signature because {@link
    // BrowseSpec} still supplies it and removing it would be a change to the spec rather than to this region.

    return `<div data-panel-region="header" class="pluginPanel-header">
  <p>${who} ${escapeHtml(about)}. ${calendar}</p>
  <p class="pluginPanel-meta">${escapeHtml(cadence)}</p>
</div>`;
}

/**
 * The toolbar region: the three scope buttons, the replaced toggle, and add.
 *
 * 🔴 The scope filter is HUMANIZED here and only here. `?scope=u:<charId>:<personaId>` is the right shape for
 * the management API and an unusable one for a person; these three buttons are the whole translation, and the
 * partition keys they stand for are composed server-side by `scopeKey` from identity the host supplies.
 *
 * ⚠️ `recalledCount` is deliberately NOT on this signature any more — see the note beside `+ Add` below.
 *
 * @param {{ view: ViewState, replacedCount: number, scopesAvailable: Set<string> }} spec
 * @returns {string}
 */
export function renderToolbar({ view, replacedCount, scopesAvailable }) {
    const scopes = [
        ['story', 'This story'],
        ['me', 'About me'],
        ['all', 'Everything'],
    ];

    // ⚠️ A button appears only if the identity it filters on actually arrived. "This story" needs `chatId`,
    // which the host has always sent; "About me" needs `charId`/`personaId`, which it may not. A button whose
    // partition we cannot compose would filter by a guess — the honest degradation is fewer controls, never a
    // control that lies about what it is showing.
    // 🔴 **WHICH SCOPE IS SELECTED IS IN THE LABEL, NOT ONLY IN A CLASS.** `mnemosyne-scope--on` matched no
    // stylesheet when this was written — a plugin had no channel for one — so the three buttons rendered
    // identically and the panel gave no indication at all of which filter the list was being shown through. A
    // radio glyph is legible with zero CSS and reads correctly beside the checkbox glyph the replaced toggle
    // already uses: ☐/☑ for a thing that is on or off, ○/◉ for three that are mutually exclusive. ✅ The class
    // is now styled by `src/panel-css.js`, and the glyph STAYS: a stylesheet arrives over the network and a
    // failure is stepped over, so the state a user reads must not depend on it having landed.
    const buttons = scopes
        .filter(([value]) => scopesAvailable.has(value))
        .map(([value, label]) => action({
            // 🔴 A scope button clears the recall filter. The two are both "which memories am I looking at", and
            // a scope click that left `recalled=1` on would answer "Everything" with five rows — the button
            // saying one thing and the list showing another.
            label: `${view.scope === value && !view.recalled ? '◉' : '○'} ${label}`, action: '/panel', state: view,
            className: `pluginPanel-button${view.scope === value && !view.recalled ? ' mnemosyne-scope--on' : ''}`,
            override: { scope: value, recalled: null, offset: 0, edit: null, expand: null, regions: 'recalled,list,pager,toolbar,header' },
        })).join(' ');

    const toggle = action({
        label: `${view.replaced ? '☑' : '☐'} Show replaced (${replacedCount})`,
        action: '/panel', state: view,
        override: { replaced: view.replaced ? null : 1, offset: 0, edit: null, expand: null, regions: 'list,pager,toolbar,header' },
    });

    // 🔴 THE "💡 Just recalled" TOGGLE MOVED OUT OF THIS ROW AND INTO {@link renderRecalled}'s heading. It was
    // a fourth control in a row of four, off to the right of three scope radios it does not belong with, and
    // it was the ONLY way to see the thing the light bulb had just lit up about. It is the same action with
    // the same override; what changed is that it now sits on the section it filters, where its count and its
    // rows are already on screen — so `recalledCount` is off this signature too, and both regions still render
    // from the one {@link BrowseSpec}.

    const add = action({
        label: '+ Add', action: '/panel', state: view, title: 'Write a memory yourself',
        className: 'pluginPanel-button mnemosyne-button--primary',
        override: { add: 1, regions: 'list' },
    });

    // ⚠️ **A GEAR ON ITS OWN, AT THE END, AND NOT IN THE SCOPE GROUP.** The three radios and the replaced
    // toggle all change WHAT YOU ARE LOOKING AT; this changes what the engine DOES. Putting it in the same
    // visual run would read as a fourth filter, which is how a settings door ends up never being found.
    const settings = action({
        label: '⚙ Settings', action: '/panel', state: view,
        title: 'How big memories are, how many are recalled, and how often memory runs',
        override: { view: 'settings', regions: 'root' },
    });

    return `<div data-panel-region="toolbar" class="pluginPanel-toolbar">
  ${buttons} ${toggle} ${add} ${settings}
</div>`;
}

/**
 * The pager region. Older on the left, newer on the right — time runs left to right, matching the chat log
 * behind the modal (fork §13.1).
 *
 * @param {{ view: ViewState, total: number }} spec
 * @returns {string}
 */
export function renderPager({ view, total }) {
    const offset = view.offset ?? 0;
    const first = total === 0 ? 0 : offset + 1;
    const last = Math.min(total, offset + PAGE_SIZE);

    const older = offset + PAGE_SIZE < total
        ? action({
            label: '‹ Older', action: '/panel', state: view, key: 'pagedown',
            override: { offset: offset + PAGE_SIZE, edit: null, expand: null, regions: 'list,pager' },
        })
        : '<span class="pluginPanel-muted">‹ Older</span>';

    const newer = offset > 0
        ? action({
            label: 'Newer ›', action: '/panel', state: view, key: 'pageup',
            override: { offset: Math.max(0, offset - PAGE_SIZE), edit: null, expand: null, regions: 'list,pager' },
        })
        : '<span class="pluginPanel-muted">Newer ›</span>';

    return `<div data-panel-region="pager" class="pluginPanel-pager">
  ${older} <span>showing ${first}–${last} of ${total}</span> ${newer}
</div>`;
}

/**
 * The error region. Empty most of the time; the host renders failures into it (fork §7.9).
 * @param {string|null|undefined} message
 * @returns {string}
 */
export function renderError(message) {
    return `<div data-panel-region="panel-error" class="pluginPanel-error">${message ? escapeHtml(message) : ''}</div>`;
}

/**
 * The calendar view: a month grid with a dot on every day that has memories.
 *
 * Two things and no library — a month is forty-two cells of static HTML, and importing a date picker would
 * mean shipping client-side JavaScript into a plugin that ships none.
 *
 * ## 🔴 A `<table>`, because THE GRID CANNOT DEPEND ON CSS THAT MIGHT NOT ARRIVE
 *
 * ✅ **The table stays even though the fork supports plugin CSS.** A
 * stylesheet is fetched once over the network by a client that logs a failure and carries on, so a layout that
 * only exists in CSS is a layout that sometimes does not. Seven columns and a row per week are laid out by the
 * browser's own UA rules: correct before a single rule of ours loads, and correct if none ever does. A month
 * grid genuinely is tabular data, which `<th scope="col">` hands to a screen reader properly. The CSS now
 * dresses these cells; it is not what makes them a grid.
 *
 * ⚠️ **Any new panel structure still has to survive with zero CSS.** That is a design constraint on the
 * markup, and the stylesheet's arrival relaxes how it *looks*, never whether it works.
 *
 * 🔴 **A day's jump target is an OFFSET INTO THE SAME LISTING, computed by index, not by converting local
 * midnight to an epoch.** `times` arrives in exactly the order `listMemories` returns rows, so the position of
 * a day's first memory *is* the offset that lands on it. That avoids the whole local-midnight-to-UTC
 * conversion — which needs a zone offset looked up at the right instant and is wrong on both sides of a DST
 * boundary if you take the shortcut — and it cannot drift from the list, because both are bucketed by the
 * same {@link dayKey} over the same array.
 *
 * @param {{ times: number[], month: string, view: ViewState, tz: string, now: number }} spec ⚠️ `now` is
 *   declared because the caller passes it and this renderer does not read it — a month grid is drawn from
 *   `month` alone. Dropping it from the type would fail the caller's object literal on an excess property.
 * @returns {string}
 */
export function renderCalendar({ times, month, view, tz }) {
    // First offset for each day, and the count, in one pass over the already-ordered timestamps.
    // ⚠️ Both annotated rather than inferred — a bare `new Map()` is `Map<any, any>`, and the offset read out
    // of the first one is what a day cell's jump action is built from. `dayKey` → index, and `dayKey` → count.
    /** @type {Map<string, number>} */
    const firstOffset = new Map();
    /** @type {Map<string, number>} */
    const counts = new Map();

    times.forEach((ms, index) => {
        const key = dayKey(ms, tz);

        if (!firstOffset.has(key)) {
            firstOffset.set(key, index);
        }

        counts.set(key, (counts.get(key) ?? 0) + 1);
    });

    const [year, mon] = month.split('-').map(Number);
    const firstOfMonth = new Date(Date.UTC(year, mon - 1, 1));
    const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const leading = firstOfMonth.getUTCDay();                 // 0 = Sunday, matching the header row below

    const cells = [];

    for (let i = 0; i < leading; i++) {
        cells.push('<td class="mnemosyne-cell mnemosyne-cell--empty"></td>');
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const key = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const n = counts.get(key) ?? 0;

        cells.push(n === 0
            ? `<td class="mnemosyne-cell mnemosyne-cell--empty">${day}</td>`
            : `<td class="mnemosyne-cell">${action({
                label: String(day), action: '/panel', state: view,
                title: `${n} memor${n === 1 ? 'y' : 'ies'}`,
                // ⚠️ `recalled: null` — the offset this jump computed is an index into the UNFILTERED listing
                // (see the docblock), so returning into the recall filter would land on the wrong rows and, with
                // at most `retrievalK` of them, usually on none.
                override: { view: 'browse', month: null, recalled: null, offset: firstOffset.get(key), edit: null, expand: null, regions: 'root' },
            })}</td>`);
    }

    // ⚠️ Padding to a whole week carries NO `mnemosyne-cell` class: these are structural filler that exists
    // only because a table row must be rectangular, and a stylesheet that one day sizes a day cell must not
    // size them too.
    while (cells.length % 7 !== 0) {
        cells.push('<td></td>');
    }

    /** @param {number} delta Months forward (positive) or back (negative). @returns {string} a `YYYY-MM` */
    const shift = (delta) => {
        const m = mon - 1 + delta;
        const y = year + Math.floor(m / 12);
        const mm = ((m % 12) + 12) % 12;
        return `${y}-${String(mm + 1).padStart(2, '0')}`;
    };

    const title = (() => {
        try {
            return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(firstOfMonth);
        } catch {
            return month;
        }
    })();

    const prev = action({ label: '‹', action: '/panel', state: view, override: { view: 'calendar', month: shift(-1), regions: 'root' } });
    const next = action({ label: '›', action: '/panel', state: view, override: { view: 'calendar', month: shift(1), regions: 'root' } });
    const back = action({ label: 'Back to memories', action: '/panel', state: view, override: { view: 'browse', month: null, regions: 'root' } });

    const weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
        .map(d => `<th scope="col" class="mnemosyne-cell mnemosyne-cell--head">${d}</th>`).join('');

    const weeks = [];

    for (let i = 0; i < cells.length; i += 7) {
        weeks.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);
    }

    return `<div data-panel-region="root" class="mnemosyne-panel">
  ${renderError(null)}
  <div class="pluginPanel-header"><p>${prev} ${escapeHtml(title)} ${next}</p></div>
  <table class="mnemosyne-calendar">
    <thead><tr>${weekdays}</tr></thead>
    <tbody>${weeks.join('')}</tbody>
  </table>
  <div class="pluginPanel-pager">${back}</div>
</div>`;
}

/**
 * How a decline reads to the person who is looking at it, rather than to the log.
 *
 * 🔴 EVERY REASON GETS A SENTENCE, INCLUDING THE ONES THAT ARE OUR FAULT. `logInjection` has printed these
 * codes on every generation since v4 — `no-query`, `below-threshold`, `empty-store` — into a plaintext file on
 * the server that a user is never going to read. The panel is where they are, and "nothing was recalled" with
 * no reason attached is indistinguishable from "memory is broken", which is the impression this whole panel
 * exists to remove.
 *
 * ⚠️ An unrecognized code degrades to naming itself rather than to silence. A reason we forgot to translate is
 * still more useful on screen than a blank, and it is greppable in this file when someone reports it.
 *
 * @param {RecallRecord} recall A decline record — `active !== true`. Not optional: the only caller has
 *   already proved a record exists, and the `?.` below is belt to that braces.
 * @param {number} minCosine The similarity floor, for the one reason that is about it
 * @returns {string}
 */
function declineSentence(recall, minCosine) {
    switch (recall?.reason) {
    case 'locked':
        return 'your vault was locked, so there was nothing to search.';
    case 'empty-store':
        return 'you have no memories yet — nothing has been stored for this character and persona.';
    case 'no-query':
        return 'no message of yours could be found in the prompt to search with.';
    case 'no-embedding':
        return 'the embedding model returned nothing, so the search could not run. Memory is unavailable ' +
                'until it does — the server log has the detail.';
    case 'no-hits':
        return 'the search came back empty. Nothing is stored in the partitions this character and chat ' +
                'can reach.';
    case 'below-threshold': {
        // 🔴 The one decline with numbers, and they are the point of it. "Nothing was relevant enough" is a
        // verdict; "the nearest of 12 was 0.31 against a 0.35 floor" is a verdict you can argue with — and
        // arguing with it is exactly what tuning `minCosine` is. Older records carry neither number, so
        // both are guarded and the sentence degrades to the verdict alone rather than printing `undefined`.
        const near = Number.isFinite(recall.nearest)
            ? ` The nearest of ${recall.candidates ?? 'the'} candidate${recall.candidates === 1 ? '' : 's'} ` +
                  // The `Number.isFinite` above IS the proof, and the cast is only carrying it two lines
                  // down: `Number.isFinite` is declared to take `unknown` and return `boolean`, so it
                  // narrows nothing, and an older record with no `nearest` at all takes the empty branch.
                  `scored ${(/** @type {number} */ (recall.nearest)).toFixed(2)}, and the floor is ${minCosine}.`
            : '';
        return `nothing stored was similar enough to what you said.${near}`;
    }
    case 'declined-impersonate':
        return 'that was an impersonation — the model writing your line — and the character\'s memories do ' +
                'not belong in your voice.';
    case 'no-window':
        // The fork called this a reply and sent no conversation with it, so it could not be told apart from
        // a background request. Two known causes, and the remedy differs: the page has not yet learned that
        // a plugin wants the conversation (a reply sent in the first moments after loading, or a startup
        // request that failed — Taproom before 1.8 never asked again), and a sender that never attached it
        // (streamed Kobold Classic and NovelAI before Taproom 1.7).
        return 'SillyTavern sent that reply without the conversation attached, so Mnemosyne could not tell ' +
                'it from a background request and left it alone. Reloading the page usually fixes this; if ' +
                'it keeps happening, update Taproom.';
    case 'error':
        return 'something went wrong and the reply was sent without memory rather than not sent at all. ' +
                'The server log has the detail.';
    default:
        return `it declined with the reason “${recall?.reason ?? 'unknown'}”.`;
    }
}

/**
 * Where in the prompt the block went, in the words of someone who has to reason about context order.
 * @param {string|undefined} placement `'system-before-last'` (chat path), `'above-last-turn'` (text path, at
 *   the fork's anchor), or anything else for the text path's fallback — including `undefined` on a record
 *   written before the field existed, which is correctly the prepended case.
 * @returns {string}
 */
function placementSentence(placement) {
    if (placement === 'system-before-last') {
        return 'Inserted as a system message immediately before your own message — the last thing the model ' +
            'reads before your turn.';
    }

    // The text path with the fork's §27 anchor: the same position as the chat path, in a rendered string.
    // ⚠️ Until 2026-10-10 the record never said so and every text-path turn fell through to the sentence
    // below, which told users the weak placement was in use on turns where it was not.
    if (placement === 'above-last-turn') {
        return 'Inserted immediately above your own message, below the rest of the conversation — the last ' +
            'thing the model reads before your turn.';
    }

    // 🔴 Named honestly, because this placement is the weak one and the user is entitled to know. Without an
    // anchor from the host there is no reliable way to find the final turn inside one rendered string, so the
    // block goes to the front — above the system prompt and the card, and first in line to be discarded if the
    // prompt overruns. See `injectInto` for the reservation contract.
    return 'Prepended to the front of the whole prompt — above the system prompt and the character card. This ' +
        'is the text-completion path, and SillyTavern did not say where your last message begins in it.';
}

/**
 * The prompt view: the exact text Mnemosyne handed the host for the last reply, verbatim.
 *
 * ## 🔴 Why a whole view for one block of text
 *
 * The recalled-memory badge identifies stored rows, but not the exact text sent to the model. This view shows
 * the block itself, unedited, in a `<pre>`: the framing header, the bullets, the collapsed
 * whitespace, exactly as the model received it. Not a reconstruction from the hit list — a reconstruction is a
 * second implementation of `renderBlock` that can drift from the first, and the whole value here is that what
 * you read is what was sent.
 *
 * ⚠️ **AND IT SAYS WHAT IT CANNOT PROMISE.** Mnemosyne sees what it handed the client; it cannot see what the
 * backend then did with it. At full context a text-completion backend discards from the front, which is where
 * the text path puts this block — the defect in `injectInto`, whose whole symptom was that the log and the
 * panel both reported a healthy recall for a prompt the block never reached. A view that showed the block
 * under the words "this is what the model saw" would be reintroducing that lie with better typography.
 *
 * 🔒 The block is memory text and this renderer is only reachable through `readPanel`'s open-vault gate, the
 * same one that guards every row in the browse view. See the module header.
 *
 * ## Paging back
 *
 * `turn` is how many replies ago, 0 being the most recent — the panel holds the last `RECALL_HISTORY` of them
 * (`src/session-state.js`). A request is scoped to a given message, and one record could only ever
 * answer it for the newest; a few can answer it for the handful of turns anyone actually scrolls back through.
 *
 * ⚠️ **A turn ordinal is NOT a message id, and the heading says "replies ago" rather than naming a message for
 * exactly that reason.** Mnemosyne sees prompts going out and never learns which message the generation
 * became, so it cannot tie a record to the bubble a user is pointing at, and a swipe produces a second record
 * for what looks like one message. Labeling these "message 14" would be a precision we do not have. The fork
 * has been asked whether a correlating id could exist; until it does, the honest unit is the turn.
 *
 * @param {{ recall: RecallRecord|undefined, view: ViewState, minCosine: number, turn?: number,
 *   total?: number }} spec
 * @returns {string}
 */
export function renderPrompt({ recall, view, minCosine, turn = 0, total = 0 }) {
    const back = action({
        label: 'Back to memories', action: '/panel', state: view,
        override: { view: 'browse', turn: null, regions: 'root' },
    });

    // Older on the left, newer on the right — the same direction as the browse pager and as the chat behind
    // the modal (fork §13.1). A disabled end is rendered as muted text rather than omitted, so the control row
    // does not change width as you page and the buttons stay where the user's cursor already is.
    const older = turn + 1 < total
        ? action({
            label: '‹ Earlier reply', action: '/panel', state: view, key: 'pagedown',
            override: { view: 'prompt', turn: turn + 1, regions: 'root' },
        })
        : '<span class="pluginPanel-muted">‹ Earlier reply</span>';
    const newer = turn > 0
        ? action({
            label: 'Later reply ›', action: '/panel', state: view, key: 'pageup',
            override: { view: 'prompt', turn: turn - 1, regions: 'root' },
        })
        : '<span class="pluginPanel-muted">Later reply ›</span>';

    // ⚠️ "replies ago", never "messages ago" — see the docblock. The buffer counts generations, and a swipe is
    // a second generation over the same message.
    const when = turn === 0 ? 'your last reply' : `${turn} ${turn === 1 ? 'reply' : 'replies'} before your last`;
    const pager = total > 1
        ? `\n  <div class="pluginPanel-pager">${older} <span>${turn + 1} of ${total}</span> ${newer}</div>`
        : '';

    // The query is shown for successes AND declines — on a decline it is the more useful half, because
    // "nothing matched" and "it searched for the wrong thing" look identical from the outside and read
    // completely differently once you can see the text. `composeQuery` is a documented first-cut heuristic and
    // this is the only place its output is ever visible.
    const query = recall?.query
        ? `<p class="pluginPanel-meta">Searched for:</p>
  <blockquote class="mnemosyne-query">${escapeHtml(recall.query)}</blockquote>`
        : '';

    let body;

    if (!recall) {
        body = '<p><em>Memory has not run yet in this conversation. This page fills in as soon as you send a ' +
            'message.</em></p>';
    } else if (recall.active !== true) {
        body = `<p><strong>Nothing was added to ${escapeHtml(when)}</strong> — ${escapeHtml(declineSentence(recall, minCosine))}</p>
  ${query}`;
    } else {
        const parts = [
            `<pre class="mnemosyne-block">${escapeHtml(recall.block ?? '')}</pre>`,
            `<p class="pluginPanel-meta">${escapeHtml(placementSentence(recall.placement))}</p>`,
            `<p class="pluginPanel-meta">${recall.count} memor${recall.count === 1 ? 'y' : 'ies'} · ` +
                `${recall.blockChars ?? 0} characters · embedded by ${escapeHtml(recall.model ?? 'an unknown model')}</p>`,
            query,
            // ⚠️ The caveat is not a disclaimer to be trimmed later — see the docblock. It is the difference
            // between reporting what we did and claiming what the model saw.
            '<p class="pluginPanel-meta mnemosyne-caveat">This is what Mnemosyne handed SillyTavern. Whether ' +
            'the backend kept it depends on your context limit — a prompt that overruns is trimmed by the ' +
            'backend, and Mnemosyne cannot see that happen.</p>',
        ];

        // 🔴 An active record with no block is an OLDER record, not an empty prompt. `block` arrived after
        // `hits`, so a session that was mid-conversation across the upgrade has one of each. Saying "it sent
        // nothing" there would be a fresh lie in the view built to stop one.
        if (!recall.block) {
            parts[0] = '<p><em>This recall predates the version that records the text — it will be here for ' +
                'your next reply.</em></p>';
        }

        body = parts.filter(Boolean).join('\n  ');
    }

    return `<div data-panel-region="root" class="mnemosyne-panel">
${renderError(null)}
  <div class="pluginPanel-header"><p>What memory sent with ${escapeHtml(when)}</p></div>${pager}
  <div class="mnemosyne-prompt">
  ${body}
  </div>
  <div class="pluginPanel-pager">${back}</div>
</div>`;
}

/**
 * The whole browse fragment — everything, for the initial open or a `root` swap.
 *
 * @param {BrowseSpec} spec Every region's inputs
 * @returns {string}
 */
export function renderBrowser(spec) {
    // Keep recall and history in one scroll container so neither region takes a fixed panel band.
    //
    // ⚠️ The wrapper carries NO `data-panel-region`, deliberately. It is layout, and a region here would be a
    // third name an action could target that redraws two regions at once — the exact coupling the region
    // protocol exists to avoid. Both children keep their own names and are swapped independently.
    return `<div data-panel-region="root" class="mnemosyne-panel">
${renderError(null)}
${renderAlert(spec)}
${renderHeader(spec)}
${renderToolbar(spec)}
<div class="mnemosyne-scroll">
${renderRecalled(spec)}
${renderList(spec.memories, spec.view, spec)}
</div>
${renderPager(spec)}
</div>`;
}

/**
 * Just the regions an action changed, in the order they were asked for.
 *
 * 🔴 **Returning only what changed is the entire point of the protocol** (fork §5, §8.2). Returning `root`
 * every time is permitted and works; it also flickers, loses nothing but reads as a redraw, and defeats the
 * reason regions exist. The set is named by the action itself — the plugin is what knows which parts of its
 * own view an action disturbs — and arrives back here as `regions`.
 *
 * ⚠️ An unknown name is dropped silently rather than guessed at. The host already ignores regions it cannot
 * find (with a `console.debug`), so a typo here degrades to "that part did not update" rather than to an
 * error — and a thrown exception would turn a cosmetic mistake into a failed action.
 *
 * @param {string[]} names Region names, from the action's `regions` parameter
 * @param {Record<string, () => string>} available Region name → renderer
 * @returns {string}
 */
export function renderRegions(names, available) {
    // 🔴 `Object.hasOwn`, NOT a bare lookup — the bare lookup reaches Object.prototype and breaks the contract
    // three lines above. `?regions=valueOf` found `Object.prototype.valueOf`, survived `.filter(Boolean)`
    // because it IS a function, and then threw when called with `this === undefined` (module code is strict);
    // `?regions=__proto__` threw "render is not a function"; `?regions=toString` rendered the literal
    // "[object Undefined]" into the fragment. All three turned a name this function promises to *drop
    // silently* into a 500 and a panel that reads "This panel could not be loaded".
    return names
        .filter(name => Object.hasOwn(available, name))
        .map(name => available[name]())
        .join('\n');
}

/**
 * The settings view: every knob, what it does, and the presets.
 *
 * Each setting explains its effect, so users can assess a value before changing it.
 *
 * ⚠️ **Both a `title` and visible help text, deliberately.** The hover tooltip is what was asked for and it is
 * the right affordance for a dense form; the visible line under the input is for the two fields whose wrong
 * value fails *silently* rather than visibly, where a user who never hovers would never learn why their
 * memories are thin or empty.
 *
 * ⚠️ Rendered from `SETTINGS_SCHEMA`, never from a hand-written field list. A knob added to the schema and
 * forgotten here would be invisible and unset-able while still governing behavior.
 *
 * @param {{settings: Record<string, number>, presets: Array<{name: string, custom: boolean, builtIn?: boolean}>, view: ViewState, template?: string,
 *          defaultTemplate?: string, placeholders?: readonly string[], standalone?: boolean, notice?: string,
 *          rescanNotice?: string, usage?: {memories: number, bytes: number}|null}} spec
 *        `standalone` means this fragment IS the settings screen — the fork's Extensions dialog — rather than
 *        a view inside the panel, so there is nothing behind it for a Back control to return to. `notice` is a
 *        sentence from the ROUTE about what just happened — see {@link renderSettings}'s reset block.
 *        `rescanNotice` is the same kind of sentence from the rescan route, shown beside the Rescan control.
 *        `usage` is `store.usage()`: how much is in there right now, rendered above the reset button. Null
 *        omits the line rather than printing a zero, because "0 memories · 0 B" is what an unmeasured store
 *        and an empty one would both look like, and those are not the same claim.
 * @returns {string} the panel fragment
 */
export function renderSettings({ settings, presets, view, template = '', defaultTemplate = '', placeholders = [], standalone = false, notice = '', rescanNotice = '', usage = null }) {
    // ⚠️ **NO BACK CONTROL WHEN THIS SCREEN IS THE WHOLE FRAGMENT.** Reached through the fork's Extensions
    // dialog (§28) there is no panel behind it to go back to: the action fetches `/panel`, gets a `root`
    // region, and `applyRegions` swaps the entire memory browser into the dialog in place of the form. A
    // control that can only ever strand the user is worse than no control. See `standalone` at the call site.
    const back = standalone ? '' : action({
        label: '‹ Back', action: '/panel', state: view,
        override: { view: 'browse', regions: 'root' },
    });

    const fields = SETTINGS_SCHEMA.map(f => `<div class="mnemosyne-setting" title="${escapeHtml(f.tooltip)}">
  <label class="mnemosyne-setting-label" for="mnemosyne-set-${escapeHtml(f.key)}">${escapeHtml(f.label)}</label>
  <span class="mnemosyne-setting-input"><input id="mnemosyne-set-${escapeHtml(f.key)}" type="number" name="${escapeHtml(f.key)}" value="${escapeHtml(String(settings[f.key]))}" min="${f.min}" max="${f.max}" step="1"><span class="mnemosyne-setting-unit">${escapeHtml(f.unit)}</span></span>
  <div class="mnemosyne-setting-help">${escapeHtml(f.tooltip)}${f.note ? ` <em>${escapeHtml(f.note)}</em>` : ''}</div>
  <div class="mnemosyne-setting-range">${f.min}–${f.max}</div>
</div>`).join('\n');

    const save = action({
        label: 'Save settings', action: '/settings', method: 'PUT', state: view,
        override: { view: 'settings', regions: 'root' }, form: 'settings',
        title: 'Apply these values to this user’s memory engine',
    });

    // ⚠️ The preset name shares the settings form, so "Save as preset" carries the numbers on screen as well as
    // the name. The route ignores the numbers and saves what is STORED — see savePresetRoute for why — so the
    // button is only correct after a save, and its title says so rather than leaving that to be discovered.
    const savePreset = action({
        label: 'Save as preset', action: '/settings/presets', method: 'POST', state: view,
        override: { view: 'settings', regions: 'root' }, form: 'settings',
        title: 'Save the CURRENTLY SAVED settings under this name. Press "Save settings" first if you have edited anything.',
    });

    // Show and edit the same prompt template that extraction uses; do not reconstruct a parallel display copy.
    //
    // ⚠️ The box opens with the BUILT-IN text when nothing is stored, rather than empty. Showing the real
    // prompt is the point; an empty box would show that no override exists, which is not the same question.
    // Saving it back unchanged stores nothing — see `writePromptTemplate` for why that matters.
    const shown = template === '' ? defaultTemplate : template;
    const overridden = template !== '';
    // 🔴 ITS OWN ROUTE, AND NOT `key: 'template'` ON THE PUT. `data-panel-key` is the fork's KEYBOARD binding
    // and is never sent with a request, so the old version put no `template` field in the body and
    // `writeSettingsRoute` cleared nothing — the confirm dialog appeared, the user confirmed, and the override
    // survived. `form:` cannot fix it either: the only form region here holds the prompt textarea, so it would
    // submit the text being discarded. See `resetPromptRoute`.
    const reset = action({
        label: 'Reset to the built-in prompt', action: '/settings/template', method: 'DELETE', state: view,
        override: { view: 'settings', regions: 'root' }, confirm: 'Discard your edited prompt and go back to the built-in one?',
        title: 'Clears your override so this follows the shipped prompt again, including future improvements to it',
    });

    const promptBlock = `<div class="mnemosyne-preset-head">The extraction prompt</div>
<div class="mnemosyne-setting-help">This is exactly what is sent to your model when it writes a memory — the whole instruction, not a summary of it. ${overridden ? 'You are running an edited version.' : 'You are running the built-in prompt; editing this box creates your own copy.'}</div>
<div class="mnemosyne-setting-help">Placeholders are filled in per extraction: ${placeholders.map((/** @type {string} */ v) => `<code>{{${escapeHtml(v)}}}</code>`).join(' ')}. One that is spelled wrong is left in the prompt as-is so you can see it.</div>
<div class="mnemosyne-setting-help"><em>⚠️ The parser only accepts lines shaped <code>[type:importance:subject] statement</code>. A prompt that stops asking for that format will produce memories nothing can store.</em></div>
<textarea name="template" rows="18" class="mnemosyne-log" spellcheck="false">${escapeHtml(shown)}</textarea>
<div class="mnemosyne-setting-actions">${overridden ? reset : ''}</div>`;

    const presetRows = presets.length === 0
        ? '<div class="mnemosyne-setting-help">No presets yet. Set the knobs the way you want them for this model, save them, then name them here — switching models usually means switching these numbers.</div>'
        // ⚠️ A preset that carries its own prompt SAYS SO, because loading it silently replaces the
        // prompt you are reading in the box above. Two presets differing only in wording would otherwise
        // be indistinguishable in this list.
        // 🔴 THE BUILT-IN RENDERS WITHOUT A DELETE CONTROL, because there is nothing there to delete — it is
        // synthesized on every read, not a stored row (see `builtInPreset`). Drawing the button and having the
        // route refuse would be offering an action that cannot succeed, which is worse than not offering it.
        : presets.map(({ name, custom, builtIn = false }) => `<div class="mnemosyne-preset">
  <span class="mnemosyne-preset-name">${escapeHtml(name)}${builtIn ? ' <em class="mnemosyne-setting-unit">built-in · read-only</em>' : ''}${custom ? ' <em class="mnemosyne-setting-unit">custom prompt</em>' : ''}</span>
  ${action({ label: 'Load', action: `/settings/presets/${encodeURIComponent(name)}/apply`, method: 'POST', state: view, override: { view: 'settings', regions: 'root' }, title: builtIn ? 'Put every setting and the prompt back to the shipped defaults' : `Replace the current settings with '${name}'` })}
  ${builtIn ? '' : action({ label: 'Delete', action: `/settings/presets/${encodeURIComponent(name)}`, method: 'DELETE', state: view, override: { view: 'settings', regions: 'root' }, confirm: `Delete the preset '${name}'?` })}
</div>`).join('\n');

    // 🔴 THE RESET, AND THE TWO THINGS THAT MAKE IT SAFE TO PUT ON A SCREEN AT ALL.
    //
    // Reset through the open store so memories can be erased while settings, presets, and the prompt remain.
    //
    // Two gates, deliberately of different kinds, because one of each is worth more than two of either:
    //
    //   1. `data-panel-confirm` — the host's own dialog. Catches the misclick, and nothing else. It is a
    //      CLIENT gate and this code cannot make it a condition of anything.
    //   2. The typed phrase — a real precondition, checked by `resetMemories` against {@link RESET_PHRASE}
    //      before it touches the store. A caller that skips the panel entirely still has to type it.
    //
    // ⚠️ THE INPUT LIVES IN ITS OWN REGION, AND THAT IS NOT COSMETIC. `form: 'danger'` collects the inputs
    // inside `data-panel-region="danger"`, so the reset request carries the phrase and NOTHING else. Were it
    // inside the settings region it would ride along with every numeric field on the screen — and, worse, the
    // phrase would ride along on "Save settings", which is how a confirmation ends up pre-filled by an
    // unrelated click.
    //
    // ⚠️ The two-step exists so the box is not sitting on screen the whole time. A permanently visible
    // "type this to destroy everything" field is one a user eventually types into to see what happens.
    const resetPath = standalone ? '/panel/settings' : '/panel';
    const openReset = action({
        label: 'Reset all memories', action: resetPath, state: view,
        override: { view: 'settings', danger: 1, regions: 'root' },
        className: 'pluginPanel-button mnemosyne-button--danger',
        // ⚠️ THE DIALOG HAS TO SAY WHERE THE BOX IS, because the box cannot be in the dialog. The fork's
        // `data-panel-confirm` calls `Popup.show.confirm` — yes/no, one string, no field and no way to gate
        // its Yes button. So this text ends by pointing at the control that appears behind it; without that
        // sentence, pressing Yes appears to do nothing.
        confirm: 'Are you very sure? This erases every memory in your store — everything you have ever '
            + 'remembered, in every chat. Your settings, presets and prompt are kept. It cannot be undone.'
            + `\n\nPress Yes, then type "${RESET_PHRASE}" in the box that appears and press OK.`,
        title: 'Erase every memory in this store. Your settings are kept.',
    });

    const confirmReset = action({
        label: 'OK — erase them', action: '/memory/reset', method: 'POST', state: view,
        override: { view: 'settings', danger: null, regions: 'root' }, form: 'danger',
        className: 'pluginPanel-button mnemosyne-button--danger',
        title: `Only works if the box reads exactly: ${RESET_PHRASE}`,
    });

    const cancelReset = action({
        label: 'Cancel', action: resetPath, state: view,
        override: { view: 'settings', danger: null, regions: 'root' },
    });

    // 🔴 `notice` is rendered ESCAPED like everything else here, and it comes from the route rather than from
    // the request — see `renderView`. Nothing a client sends can put a sentence on this screen.
    const noticeBlock = notice
        ? `<div class="mnemosyne-danger-notice">${escapeHtml(notice)}</div>`
        : '';

    // Show current usage independently of reset notices, which disappear after the action completes.
    //
    // ⚠️ **THE COUNT IS THE ANSWER; THE BYTES ARE THE CONTAINER.** A reset keeps settings, presets and the
    // prompt, and those live in the same SQLCipher file — so an erased store still reports a real size, and a
    // line that showed only bytes would read as "it did not work" for exactly the person this was built for.
    // The zero case therefore says what the remaining bytes ARE, in words, instead of leaving it to be guessed.
    const usageBlock = usage
        ? `<div class="mnemosyne-setting-help mnemosyne-danger-size">In this store right now: <strong>${usage.memories === 0 ? 'no memories' : `${usage.memories} ${usage.memories === 1 ? 'memory' : 'memories'}`}</strong>, and the file is <strong>${escapeHtml(humanBytes(usage.bytes))}</strong> on disk.${usage.memories === 0 ? ' That is your settings, presets and prompt — the things a reset keeps.' : ''}</div>`
        : '';

    // Rescan the open chat on demand to recover memories missed by an earlier extraction pass.
    //
    // ⚠️ ITS OWN FORM REGION, for the reason the reset's box has one: `form: 'rescan'` sends the count and
    // nothing else, and "Save settings" never carries it.
    //
    // ⚠️ Offered only when the host sent a `chatId`. With no chat open there is nothing to read, and a button
    // that can only answer "open a chat first" is worse than none.
    const rescan = action({
        label: 'Rescan', action: '/memory/rescan', method: 'POST', state: view,
        override: { view: 'settings', danger: null, regions: 'root' }, form: 'rescan',
        className: 'pluginPanel-button mnemosyne-button--primary',
        title: 'Read these messages again now and store the memories that are missing',
    });

    // ⚠️ `mnemosyne-rescan` wraps the whole block so the stylesheet can show "Rescanning…" in the empty
    // status line while the host has the button marked pending — see `panel-css.js`.
    const rescanBlock = view.identity.chatId
        ? `<div class="mnemosyne-rescan">
<div class="mnemosyne-preset-head">Rescan this chat</div>
<div class="mnemosyne-rescan-status" role="status"></div>
${rescanNotice ? `<div class="mnemosyne-danger-notice">${escapeHtml(rescanNotice)}</div>` : ''}
<div class="mnemosyne-setting-help">Reads the last messages of this chat again, right now, and stores any memory that is missing. Nothing is deleted, and memories you already have are skipped. If it finds an old fact that has since changed — where someone used to live, say — your current memory stays, and the old fact is saved behind it where "Show replaced" can show it. It can take a minute or more.</div>
<div data-panel-region="rescan" class="mnemosyne-preset-new">
  <label class="mnemosyne-setting-label" for="mnemosyne-rescan-count">Messages to read</label>
  <input id="mnemosyne-rescan-count" type="number" name="count" value="50" min="1" step="1" class="mnemosyne-preset-input">
  ${rescan}
</div>
</div>`
        : '';

    const dangerBlock = `<div class="mnemosyne-preset-head mnemosyne-danger-head">Start fresh</div>
${noticeBlock}
<div class="mnemosyne-setting-help">Erases every memory in this store — every chat, every fact, and the ingest marks that say how far each conversation has been read. <strong>Your settings, your presets and your extraction prompt are kept.</strong> There is no undo and no backup.</div>
<div class="mnemosyne-setting-help">⚠️ Old conversations are not re-read afterward: ingest picks up from the recent window on your next reply, so history above that window stays unread.</div>
${usageBlock}
${view.danger
        ? `<div data-panel-region="danger" class="mnemosyne-danger-zone">
  <label class="mnemosyne-setting-label" for="mnemosyne-reset-confirm">Type <code>${escapeHtml(RESET_PHRASE)}</code> to continue</label>
  <input id="mnemosyne-reset-confirm" type="text" name="confirm" class="mnemosyne-preset-input" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(RESET_PHRASE)}">
  <div class="mnemosyne-setting-actions">${confirmReset} ${cancelReset}</div>
</div>`
        : `<div class="mnemosyne-setting-actions">${openReset}</div>`}`;

    return `<div data-panel-region="root" class="mnemosyne-panel">
<div class="mnemosyne-log-head">${back}<span class="mnemosyne-log-title">Memory settings</span></div>
<div data-panel-region="settings" class="mnemosyne-settings">
${fields}
<div class="mnemosyne-setting-actions">${save}</div>
${promptBlock}
<div class="mnemosyne-preset-head">Presets</div>
<div class="mnemosyne-setting-help">A different model usually wants different numbers — a large reasoning model needs a much higher extraction ceiling than a small local one. Save a set here and load it when you switch.</div>
<div class="mnemosyne-preset-new"><input type="text" name="presetName" placeholder="Name this preset…" maxlength="60" class="mnemosyne-preset-input">${savePreset}</div>
${presetRows}
</div>
${rescanBlock}
${dangerBlock}
</div>`;
}
