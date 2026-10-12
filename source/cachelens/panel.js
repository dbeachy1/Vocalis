/**
 * The panel — one row per turn, newest first.
 *
 * 🔴 THE BAR HAS EXACTLY TWO COLOURED SEGMENTS: REUSED AND REPROCESSED. NEVER MORE. A third colour would
 * assert a third category of token and there is not one — text the backend had to process is red even where
 * it is byte-for-byte identical to last turn, because the cache did not save a single token of it. That is
 * what makes "you moved one lorebook entry and paid for 14,000 tokens" show up as a nearly-solid red bar,
 * which is the entire reason the panel exists (DESIGN.md §3). A diff view belongs in the expanded row below,
 * where showing a human what changed is the goal; it does not belong in the bar.
 *
 * 🔴 WHERE THE SEGMENTS COME FROM IS `bar.js`, AND IT IS THE BACKEND'S MEASUREMENT WHEREVER THERE IS ONE.
 * The shared prefix is a prediction that has been observed 22× off the truth on consecutive turns, so it is
 * drawn as a tick and never as the green segment.
 *
 * ⚠️ AND THE BAR'S WIDTH IS THE CONTEXT WINDOW, NOT THE PROMPT. Rows are then comparable to each other and
 * the unfilled tail reads as headroom — except where the turn recorded no window, or the counts are still
 * characters, and the bar marks itself so the tail is not misread.
 *
 * A collapsed row shows its id or raw badge, bar, summary, view button, and chevron. The row's plain-English
 * detail drawer contains measurement, change, rewrite, eviction, and client-side information; it opens by
 * clicking the row or activating it from the keyboard. Both message and raw rows use this layout.
 */

import { Popup, POPUP_TYPE } from '../../../popup.js';
import { copyText } from '../../../utils.js';

import { barSplit, fmt, pct, summaryFor, verdictFor } from './bar.js';
import { EXPANSION_CONTEXT, buildRows, fillTokenCounts } from './index.js';
import { describeAge } from './persist.js';
import { fetchRecordPrompt, PROVENANCE } from './record.js';
import { VERSION } from './version.js';

/** @type {Popup|null} */
let openInstance = null;

/** @type {HTMLElement|null} */
let container = null;

/**
 * `rowKey` -> whether its expansion is showing, so a refresh does not collapse what the reader opened.
 *
 * 🔴 KEYED BY `rowKey`, NOT `mesId` (DESIGN_RAW_GENERATION_ROWS.md §8). `rowKey` is `message:<mesId>` for an
 * ordinary row and `raw:<recordId>` for a raw one — a raw row has no `mesId` at all, so keying this Set by
 * `mesId` would collapse or cross-link rows the moment both kinds are on screen together.
 *
 * Both message and raw rows can expand. Raw rows use `raw:<recordId>` keys because they have no `mesId`.
 */
const expanded = new Set();

/**
 * @param {string} tag Element name
 * @param {string} className Class list
 * @param {string} [text] Text content
 * @returns {HTMLElement} The element
 */
function el(tag, className, text) {
    const node = document.createElement(tag);

    node.className = className;

    if (text !== undefined) {
        node.textContent = text;
    }

    return node;
}

/**
 * Make newlines visible, so a break on whitespace or an instruct token is something the eye can land on
 * rather than an invisible gap (DESIGN.md §8).
 * @param {string} text A fragment of prompt
 * @returns {string} The same, with pilcrows for newlines
 */
function showNewlines(text) {
    return text.replace(/\r/g, '').replace(/\n/g, '¶');
}

/**
 * One row of a plain-English detail list — a fixed-width label, then the sentence.
 *
 * Omit a line when it has no applicable value; an empty line would confuse "not applicable" with "nothing here."
 * @param {HTMLElement} box The drawer to append into
 * @param {string} label The fixed-width label, e.g. "Cache"
 * @param {string|null|undefined} text The sentence, or nothing to say
 * @param {{title?: string, warn?: boolean}} [opts] The tooltip, and whether to render as a warning
 * @returns {void}
 */
function detail(box, label, text, opts = {}) {
    if (text === null || text === undefined || text === '') {
        return;
    }

    const row = el('div', opts.warn ? 'cachelens-detail cachelens-warn' : 'cachelens-detail');

    row.append(el('span', 'cachelens-detail-label', label));

    const value = el('span', 'cachelens-detail-value', text);

    if (opts.title) {
        value.title = opts.title;
    }

    row.append(value);
    box.append(row);
}

/**
 * The two-segment bar: what the backend reused, and what it had to process.
 *
 * 🔴 THE ARITHMETIC LIVES IN `bar.js`, WHICH IS PURE AND TESTED. This function only turns its answer into
 * elements. The rule it implements — measurement over prediction, and a lower-bound prefix reduced to a tick
 * — is the correction that made this panel truthful; see `bar.js` for the two turns that proved it.
 * @param {import('./index.js').Row} row A row from `buildRows`
 * @returns {HTMLElement} The bar
 */
function renderBar(row) {
    const bar = el('div', 'cachelens-bar');
    const split = barSplit(row);

    bar.title = split.title;

    if (split.kind === 'greyed') {
        bar.classList.add('cachelens-bar-greyed');

        return bar;
    }

    // Two different reasons, one appearance: there is nothing to draw. What separates them is the title,
    // which `bar.js` has already made specific — an empty bar that claims to be the first turn of the chat
    // when it is the four-hundredth is the failure being avoided, and it lives in the words, not the pixels.
    if (split.kind === 'no-baseline' || split.kind === 'no-prompt'
        || split.kind === 'raw-no-usage' || split.kind === 'raw-invalid-usage'
        || split.kind === 'raw-failed' || split.kind === 'raw-cancelled') {
        // 🔴 THE SAME EMPTY-DASHED BAR AS A MESSAGE ROW WITH NOTHING TO DRAW, FOR THE SAME REASON: absent,
        // invalid, failed and cancelled usage are none of them zero reuse (DESIGN_RAW_GENERATION_ROWS.md
        // §10, `bar.js`'s `emptyRawBar`). An empty bar with no green and no red is the honest picture, and
        // the title (set above from `split.title`) already says which of the four this is.
        bar.classList.add('cachelens-bar-empty');

        return bar;
    }

    if (split.kind === 'predicted') {
        bar.classList.add('cachelens-bar-predicted');

        if (!split.inTokens) {
            bar.classList.add('cachelens-bar-provisional');
        }
    }

    if (!split.toWindow) {
        // The tail is not headroom, and the bar says so rather than inviting the reader to read it as room
        // to spare (DESIGN.md §3: the width is the context window, when there is one to be the width).
        bar.classList.add('cachelens-bar-nowindow');
    }

    const scale = split.denominator > 0 ? 100 / split.denominator : 0;
    const reused = el('span', 'cachelens-green');
    const recomputed = el('span', 'cachelens-red');

    reused.style.width = `${Math.max(0, Math.min(100, split.green * scale))}%`;
    recomputed.style.width = `${Math.max(0, Math.min(100, (split.total - split.green) * scale))}%`;
    bar.append(reused, recomputed);

    if (split.prefixMark !== null) {
        // 🔴 A TICK, NEVER A THIRD SEGMENT. The header rule stands: a third colour would assert a third
        // category of token and there is not one. This is a hairline saying where the prediction fell, so the
        // gap between predicted and measured — itself the finding, per DESIGN.md §6.4 — is visible without
        // reading the numbers.
        const tick = el('span', 'cachelens-tick');

        // ⚠️ AND IT IS KEPT INSIDE THE BAR, BECAUSE A MARK THAT CLIPS TO NOTHING IS A SILENT OMISSION.
        // The bar is `overflow: hidden` for its rounded corners, and the hairline is centred on its position
        // with a -1px margin, so a prefix of 0 tokens — a prompt whose very first token differs — put half the
        // tick outside the bar and the rest under its own clipped edge: the code believed it had drawn a mark
        // and the reader saw none. `clamp` pins the travel to the bar's own width at layout time, which a
        // percentage computed here cannot do.
        const at = Math.max(0, Math.min(100, split.prefixMark * scale));

        tick.style.left = `clamp(1px, ${at}%, calc(100% - 1px))`;
        tick.title = `Shared prefix: ${fmt(split.prefixMark)} tokens (${pct(split.prefixMark, split.total)} of this prompt). A LOWER bound on reuse — cache-reuse recovers text that only moved position.`;
        bar.append(tick);
    }

    return bar;
}

/**
 * When this row's generation happened. Use `requestedAt` (when the prompt was sent), then `measuredAt` for
 * stamp-only rows. Return no time when neither value is available; treat non-positive legacy timestamps as
 * missing so they do not render as dates near the Unix epoch.
 * @param {import('./index.js').Row} row A row from `buildRows`
 * @returns {HTMLElement|null} The time column, or null when the row has no usable timestamp
 */
function renderWhen(row) {
    const anyRow = /** @type {*} */ (row);
    const at = Number.isFinite(anyRow.requestedAt) && anyRow.requestedAt > 0 ? anyRow.requestedAt
        : (Number.isFinite(anyRow.measuredAt) && anyRow.measuredAt > 0 ? anyRow.measuredAt : null);

    if (!Number.isFinite(at) || at <= 0) {
        return null;
    }

    const date = new Date(at);
    const span = el('span', 'cachelens-when', date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }));

    span.title = date.toLocaleString();

    return span;
}

/**
 * The summary beside the bar, with measured values colored and estimates or unavailable values muted.
 *
 * 🔴 BUILT ON `summaryFor` (`bar.js`), NEVER RE-DERIVING ITS RULES. Only the two colours are decided here:
 * `summaryFor`'s text for the two unmuted kinds (`measured`, `raw-measured`) is always exactly
 * `cached <n> (<pct>) · uncached <n> (<pct>)` — see its own two branches — so splitting on the separator and
 * tinting each half is safe precisely because both are produced by the same function, in the same module,
 * from the same rule. A muted result (predicted, unmeasured, failed/cancelled/no-usage/invalid) is printed
 * as-is, ungreened and unreddened — colouring a lower-bound ESTIMATE the same as a measurement would be the
 * exact confusion `bar.js`'s header comment exists to prevent.
 * @param {import('./index.js').Row} row A row from `buildRows`
 * @returns {HTMLElement} The summary column
 */
function renderSummary(row) {
    const summary = summaryFor(row);
    const span = el('span', 'cachelens-summary');

    span.title = summary.title;

    if (summary.muted) {
        span.classList.add('cachelens-muted');
        span.textContent = summary.text;

        return span;
    }

    const [cachedPart, uncachedPart] = summary.text.split(' · ');

    span.append(el('span', 'cachelens-summary-cached', cachedPart));
    span.append(document.createTextNode(' · '));
    span.append(el('span', 'cachelens-summary-uncached', uncachedPart));

    return span;
}

/**
 * The `view` button — the collapsed row's only control besides the bar and the chevron.
 *
 * ⚠️ NO LINK WHERE THERE IS NOTHING BEHIND IT (message rows only). A stored row whose prompt the browser no
 * longer holds would open an empty popup captioned as this turn's prompt, which reads as the prompt having
 * been empty rather than as it not being here — so this returns null and the caller appends nothing.
 *
 * A raw row's prompt lives
 * only in the server's in-memory ring buffer — whether it is still there is unknown until the click actually
 * asks, so the button itself cannot be conditioned on anything known client-side.
 * @param {import('./index.js').Row} row A row from `buildRows`
 * @returns {HTMLElement|null} The button, or null when a message row has no prompt to show
 */
function renderViewButton(row) {
    const isRaw = row.kind === 'raw';

    if (!isRaw && row.promptKnown === false) {
        return null;
    }

    const button = el('button', 'cachelens-view', 'view');

    // `el()` is typed to return the `HTMLElement` its callers overwhelmingly build — a `<div>` or a `<span>`
    // — so the one property this file ever sets that only a `<button>` has needs its own cast, the same
    // "I know which kind this is" cast `bar.js`'s `row.stamp` narrowing already uses.
    /** @type {HTMLButtonElement} */ (button).type = 'button';
    button.title = isRaw
        ? "Fetch this request's prompt from the server, while it still holds it, and show it in a popup."
        : 'Show the whole prompt for this turn';
    button.addEventListener('click', (event) => {
        // The row's own click handler (below) toggles the drawer — a click on this button must never also
        // do that, the same rule the old `copy` control followed.
        event.stopPropagation();

        if (isRaw) {
            void handleRawView(/** @type {import('./index.js').RawRow} */ (row));
        } else {
            void showFullPrompt(/** @type {import('./index.js').MessageRow} */ (row));
        }
    });

    return button;
}

/**
 * The full prompt for one turn, copyable — reusing the raw-prompt popup's mechanism (DESIGN.md §9).
 *
 * ⚠️ IT SAYS WHICH TEXT IT IS. On an install with a prompt-rewriting plugin the browser's copy and the sent
 * prompt are different strings, and showing one while implying the other is the failure the fork record
 * exists to prevent.
 * @param {import('./index.js').MessageRow} row The message row whose prompt to show
 * @returns {Promise<void>} When the popup closes
 */
async function showFullPrompt(row) {
    const content = el('div', 'cachelens-full');

    const label = el('div', 'cachelens-full-label', `#${row.mesId} — ${row.provenanceLabel}`);

    label.title = row.provenanceDetail || '';
    content.append(label);

    const pre = el('pre', 'cachelens-full-text');

    pre.textContent = row.promptText;
    content.append(pre);

    const popup = new Popup(content, POPUP_TYPE.TEXT, null, {
        allowVerticalScrolling: true,
        leftAlign: true,
        wide: true,
        large: true,
        // No `result`, deliberately: a button without one does not close the popup, and copying the prompt
        // then having it vanish is not what anyone wanted.
        customButtons: [{
            text: 'Copy all',
            icon: 'fa-copy',
            action: async () => {
                await copyText(row.promptText);
                toastr.info('Copied!');
            },
        }],
    });

    await popup.show();
}

/**
 * The `view` click on a RAW row — the one sanctioned on-demand read of a raw record's prompt.
 *
 * 🔴 THE TEXT IS NEVER STORED. `text` below is a local variable, handed straight to the popup and to
 * `copyText`; it is never assigned onto `row`, `row.stamp`, or any module-level cache in this file. That is
 * the boundary `fetchRecordPrompt`'s own header states, and this is the one call site that could break it.
 * @param {import('./index.js').RawRow} row The raw row clicked
 * @returns {Promise<void>} When the popup closes, or the "gone" toast is shown
 */
async function handleRawView(row) {
    const backend = row.stamp?.backend;
    const recordId = row.stamp?.id;

    console.debug('[cache-lens] panel.js handleRawView: view clicked for a raw row', { backend, recordId, seq: row.stamp?.seq });

    const text = await fetchRecordPrompt(/** @type {string} */ (backend), recordId);

    if (text === null) {
        // 🔴 NOT AN ERROR — THE SERVER'S OWN MEMORY WINDOW, SAID PLAINLY. The record route keeps only its
        // last few generations per backend; a raw row can outlive that window (it is drawn from the persisted
        // stamp, which has no such limit), and this is the ordinary, expected outcome of clicking view on one.
        console.debug('[cache-lens] panel.js handleRawView: server no longer holds this prompt', { backend, recordId });
        toastr.info("The server no longer holds this prompt — it keeps only its last few generations in memory and never saves them.");

        return;
    }

    console.debug('[cache-lens] panel.js handleRawView: prompt fetched, opening popup', { backend, recordId, textLength: text.length });

    await showRawPromptPopup(row, text);
}

/**
 * The popup a successful `view` click opens on a raw row.
 *
 * 🔴 `chat` BACKEND, JSON TEXT: SHOW IT PRETTY-PRINTED. A chat-completion prompt is a message array
 * serialised to a string; showing the raw JSON blob is technically correct and useless to read. When the text
 * does not parse — a text-completion backend, or a shape this build does not expect — it is shown exactly as
 * received rather than guessed at.
 * @param {import('./index.js').RawRow} row The raw row this prompt belongs to
 * @param {string} text The prompt, fetched fresh and never stored
 * @returns {Promise<void>} When the popup closes
 */
async function showRawPromptPopup(row, text) {
    const backend = row.stamp?.backend;
    let display = text;

    if (backend === 'chat') {
        try {
            display = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
            // Not JSON, or not the shape expected — shown as received rather than guessed at.
            display = text;
        }
    }

    const content = el('div', 'cachelens-full');
    const label = el('div', 'cachelens-full-label', `RAW #${row.stamp?.seq ?? '?'} — as sent · held in server memory only, not saved`);

    content.append(label);

    const pre = el('pre', 'cachelens-full-text');

    pre.textContent = display;
    content.append(pre);

    const popup = new Popup(content, POPUP_TYPE.TEXT, null, {
        allowVerticalScrolling: true,
        leftAlign: true,
        wide: true,
        large: true,
        customButtons: [{
            text: 'Copy all',
            icon: 'fa-copy',
            action: async () => {
                await copyText(display);
                toastr.info('Copied!');
            },
        }],
    });

    await popup.show();
}

/**
 * The "Prompt size" drawer line.
 * @param {import('./index.js').MessageRow} row A message row
 * @returns {{text: string, title: string}} The line
 */
function promptSizeLine(row) {
    const promptTokens = row.promptTokens;

    if (typeof promptTokens === 'number' && Number.isFinite(promptTokens)) {
        const context = row.maxContext > 0
            ? `${pct(promptTokens, row.maxContext)} of the ${fmt(row.maxContext)}-token context`
            : 'context size not recorded';

        return {
            text: `${fmt(promptTokens)} tokens · ${context}`,
            title: row.tokenizer
                ? `Counted with ${row.tokenizer}. The client tokenizer may not be the backend's, so the token count is an estimate.`
                : 'Prompt tokens over the context window.',
        };
    }

    // The tokenizer has not answered for this turn — shown in characters rather than blocking on it
    // (DESIGN.md §10), and said so rather than silently switching units.
    return {
        text: `${fmt(row.promptChars)} characters — token count not available`,
        title: "This build's tokenizer has not reported a token count for this turn, so the size is shown in characters instead.",
    };
}

/**
 * The "Cache" drawer line — what the backend measured, or why there is nothing measured.
 *
 * Report measured usage when available and explain why it is absent otherwise. Partial provider reports remain
 * visible here; the bar separately requires a complete comparable split.
 * @param {import('./index.js').MessageRow} row A message row
 * @returns {{text: string, title: string, warn?: boolean}} The line
 */
function cacheLine(row) {
    const raw = row.timings;
    const cacheN = raw && typeof raw === 'object' && typeof raw.cache_n === 'number' && Number.isFinite(raw.cache_n) ? raw.cache_n : null;
    const promptN = raw && typeof raw === 'object' && typeof raw.prompt_n === 'number' && Number.isFinite(raw.prompt_n) ? raw.prompt_n : null;
    const promptMs = raw && typeof raw === 'object' && typeof raw.prompt_ms === 'number' && Number.isFinite(raw.prompt_ms) ? raw.prompt_ms : null;

    /** @returns {string} The " · measured …" suffix shared by every measured branch below */
    const measuredSuffix = () => {
        if (row.measurementSource === 'recorded') {
            const age = describeAge(row.measuredAt, Date.now());

            return age ? ` · measured ${age}, saved with the chat` : ' · measured, time not recorded, saved with the chat';
        }

        if (row.measurementSource === 'live') {
            return ' · measured this session';
        }

        return '';
    };
    const prefillClause = promptMs !== null ? `, ${(promptMs / 1000).toFixed(2)}s prefill` : '';

    if (cacheN !== null && promptN !== null) {
        return {
            text: `the backend reused ${fmt(cacheN)} tokens and processed ${fmt(promptN)}${prefillClause}${measuredSuffix()}`,
            title: 'Measured by the backend, and what the bar is drawn from. The tick on the bar (when there is one) is what this panel PREDICTED from the shared prefix.',
        };
    }

    if (promptN !== null || promptMs !== null) {
        // `prompt_n` and/or `prompt_ms` arrived without `cache_n` — llama.cpp's own timings event can send
        // one without the other on some builds, and this says exactly which half showed up.
        const base = promptN !== null
            ? `the backend processed ${fmt(promptN)} tokens but did not say how many it reused`
            : 'the backend reported a prefill time but did not say how many tokens it reused or processed';

        return {
            text: `${base}${prefillClause}${measuredSuffix()}`,
            title: 'Measured by the backend, but only in part — the fields that did arrive are shown as far as they go. The bar itself needs both cached and processed counts together, so it treats this the same as no measurement (DESIGN.md §6.4).',
        };
    }

    if (cacheN !== null) {
        // The mirror case — `cache_n` without `prompt_n`/`prompt_ms` — kept for the same reason: whatever
        // the backend DID say is shown rather than discarded because the rest did not arrive.
        return {
            text: `the backend reused ${fmt(cacheN)} tokens but did not say how many it processed${measuredSuffix()}`,
            title: 'Measured by the backend, but only in part — the fields that did arrive are shown as far as they go. The bar itself needs both cached and processed counts together, so it treats this the same as no measurement (DESIGN.md §6.4).',
        };
    }

    // 🔴 THREE STATES, NOT TWO, AND THE SILENT ONE WAS THE PROBLEM. See the function comment above.
    if (row.unreadableStamp !== null && row.unreadableStamp !== undefined) {
        return {
            text: 'recorded by a newer Cache Lens',
            title: `This turn carries a measurement written under schema v${row.unreadableStamp}, which this build (${VERSION}) does not know how to read. It has not been lost — reload the page, and if the version in the header still disagrees with SillyTavern's extension list, this tab is running modules the server has already replaced.`,
            warn: true,
        };
    }

    if (row.recorded) {
        return {
            text: 'the backend did not report cache usage for this turn',
            title: "This turn WAS measured and the measurement is stored with the chat — the backend simply didn't report how many tokens it reused. Older llama.cpp builds do not, and most chat-completion providers never do.",
        };
    }

    return {
        text: "no measurement was saved — this turn is older than Cache Lens's recording",
        title: 'No measurement was kept for this turn. Turns generated before Cache Lens started writing them into the chat have none, and there is no way to recover one.',
    };
}

/**
 * The "Changed since last turn" drawer line — where the prompt first diverges from last turn's, in plain
 * English, or the plain reason there is nothing to compare.
 *
 * For a greyed row with a baseline, show the computed position with a caveat describing its source. Do not
 * present the browser's copy as the sent prompt. The first-turn, no-prompt, predecessor-gone, unchanged, and
 * numeric cases mirror `bar.js`'s `describeChange`, with wording specific to this drawer's units and sections.
 * Keep the unit-labelled wording here; the bar uses a shorter summary.
 * @param {import('./index.js').MessageRow} row A message row
 * @returns {{text: string, title: string, warn?: boolean}} The line
 */
function changedLine(row) {
    if (!row.hasBaseline) {
        // Nothing to compare regardless of provenance — greyed or not, there is no baseline to have run the
        // comparison against, so there is no caveat to add on top of the reason itself.
        /** @type {Record<string, string>} */
        const reasons = {
            'first-turn': 'first turn — nothing was in the cache to compare against',
            'no-prompt': 'this prompt no longer stored',
            'predecessor-gone': 'previous prompt no longer stored',
        };
        const text = reasons[row.baselineMissing ?? ''] ?? 'no comparison available';

        return {
            text,
            title: row.baselineMissing === 'no-prompt'
                ? "The measurement for this turn was stored with the chat, but the prompt it was taken from is no longer in this browser's store — a long chat's store drops the oldest ones."
                : (row.baselineMissing === 'predecessor-gone'
                    ? "The previous turn's prompt is no longer in this browser's store, so there is nothing to compare this one against."
                    : 'The first generation on this backend. There was no previous prompt to compare against.'),
        };
    }

    // A greyed row's comparison ran on the browser's own copies, which may not be what the backend actually
    // received — so the position below is captioned rather than withheld. `greyedReason` is the specific
    // reason (no server record and a plugin loaded, or the final prompt otherwise unconfirmed); the fallback
    // covers a row greyed for a reason this function was not told.
    const caveat = row.greyed ? " — compared using the browser's copy, which may not be what the server sent" : '';
    const greyedTitle = row.greyedReason || 'The prompt as sent could not be established, so nothing can be compared against it.';

    if (row.prefixChars >= row.promptChars) {
        return {
            text: `nothing changed${caveat}`,
            title: row.greyed ? greyedTitle : `All ${fmt(row.promptChars)} characters of this prompt were already in the shared prefix — the healthy append-only turn.`,
            warn: row.greyed,
        };
    }

    const prefixTokens = row.prefixTokens;
    const promptTokens = row.promptTokens;
    const inTokens = typeof prefixTokens === 'number' && Number.isFinite(prefixTokens)
        && typeof promptTokens === 'number' && Number.isFinite(promptTokens);
    const at = inTokens ? prefixTokens : row.prefixChars;
    const of = inTokens ? promptTokens : row.promptChars;
    const unit = inTokens ? 'token' : 'char';
    const inside = row.rewriteHit ? `${row.rewriteHit.id}'s insertion` : (row.attribution ?? 'unattributed');

    return {
        text: `at ${unit} ${fmt(at)} of ${fmt(of)} (${pct(at, of)} in), inside ${inside}${caveat}`,
        title: row.greyed
            ? greyedTitle
            : `The first ${fmt(at)} ${inTokens ? 'tokens' : 'characters'} of this prompt are the same as last turn; it differs from there on. This locates the CAUSE of a cache break — it does not price one, because cache-reuse can recover text that only moved position. See the Cache line above for what the turn actually paid.`,
        warn: row.greyed,
    };
}

/**
 * The "Prompt shown is" drawer line — which text this row is showing, and how sure the panel is that it
 * matches what the backend actually received (DESIGN.md §6.3).
 * @param {import('./index.js').MessageRow} row A message row
 * @param {import('./index.js').Mode} mode From `buildRows`, for the degraded-build sentence and the record
 * depth
 * @returns {{text: string, title: string, warn?: boolean}} The line
 */
function promptShownLine(row, mode) {
    switch (row.provenance) {
        case PROVENANCE.SENT:
            return {
                text: `exactly what the server sent — modified by ${row.rewrittenBy.join(', ')}`,
                title: row.provenanceDetail || '',
            };

        case PROVENANCE.CONFIRMED:
            return {
                text: 'exactly what the server sent — no server plugin changed it',
                title: row.provenanceDetail || '',
            };

        case PROVENANCE.BROWSER:
            return {
                text: "the browser's copy — no server plugin is loaded, so that is what was sent",
                title: row.provenanceDetail || '',
            };

        case PROVENANCE.UNKNOWN:
        default:
            if (mode.recordSupported) {
                return {
                    text: `the browser's copy. The server keeps only its last ${mode.depth} prompts in memory and no longer has this one, and a server plugin is loaded, so the exact text sent can't be confirmed.`,
                    title: row.provenanceDetail || '',
                    warn: true,
                };
            }

            // The degraded build — no record route at all — gets its own plain sentence rather than one that
            // talks about a memory window this build was never able to keep.
            return {
                text: "the browser's copy. This build does not report what the server sent, and a server plugin is loaded, so the exact text sent can't be confirmed.",
                title: row.provenanceDetail || '',
                warn: true,
            };
    }
}

/**
 * The message-row drawer shows details and, when a real divergence exists, the previous/current diff.
 *
 * 🔴 THE DIFF VIEW'S OWN HEAD LINE IS DROPPED, NOT DUPLICATED. It used to open with "Changed at char N of M
 * … inside: X" — the same fact the "Changed since last turn" detail line above it now states, in the same
 * words but plainer. Printing both would be the row saying the same thing twice.
 * @param {import('./index.js').MessageRow} row A message row
 * @param {import('./index.js').Mode} mode From `buildRows`
 * @returns {HTMLElement} The drawer
 */
function renderMessageDrawer(row, mode) {
    const box = el('div', 'cachelens-expansion');

    const size = promptSizeLine(row);

    detail(box, 'Prompt size', size.text, { title: size.title });

    const cache = cacheLine(row);

    detail(box, 'Cache', cache.text, { title: cache.title, warn: cache.warn });

    const changed = changedLine(row);

    detail(box, 'Changed since last turn', changed.text, { title: changed.title, warn: changed.warn });

    const shown = promptShownLine(row, mode);

    detail(box, 'Prompt shown is', shown.text, { title: shown.title, warn: shown.warn });

    if (row.rewriteNote) {
        detail(box, 'Server plugin edits', row.rewriteNote.text, { title: row.rewriteNote.title, warn: row.rewriteNote.warn });
    }

    if (Array.isArray(row.clientChanges) && row.clientChanges.length > 0) {
        detail(
            box,
            'Changed in the browser',
            `${row.clientChanges.join(', ')} — these are assembled in the browser (World Info, the author's note, summaries, vectors) and differ from last turn.`,
            { title: "These are assembled in the browser before the prompt is sent, so no server plugin list can ever name them. Whether they are what the cache paid for is the Cache line's answer, not this one." },
        );
    }

    if (Array.isArray(row.clientUnplaced) && row.clientUnplaced.length > 0) {
        detail(
            box,
            'Missing from the prompt',
            `${row.clientUnplaced.join(', ')} — active, but their text isn't in the prompt as sent: either the context limit trimmed them, or they were inserted in pieces.`,
            {
                warn: true,
                title: 'The breakdown holds this component but the prompt as sent does not contain it. This panel cannot tell the two causes apart.',
            },
        );
    }

    if (row.evictionNote) {
        detail(box, 'Between turns', row.evictionNote, { title: 'What reached the backend between this turn and the one before it.' });
    }

    // Show a greyed row's diff with its source caveat. Only a missing baseline suppresses the comparison;
    // `verdictFor` separately withholds a priced verdict for greyed rows.
    if (!row.hasBaseline) {
        return box;
    }

    const verdict = verdictFor(row);

    if (row.prefixChars >= row.promptChars) {
        if (verdict) {
            box.append(el('div', `cachelens-verdict cachelens-verdict-${verdict.kind}`, verdict.text));
        }

        return box;
    }

    if (verdict) {
        box.append(el('div', `cachelens-verdict cachelens-verdict-${verdict.kind}`, verdict.text));
    }

    const at = row.prefixChars;
    const before = Math.max(0, at - EXPANSION_CONTEXT.before);
    const prev = row.baselineText ?? '';

    // Two lines, aligned on the divergence column, so the eye lands on the break.
    const sharedChars = at - before;
    let divergentChars = 0;

    for (const [label, text] of [['prev', prev], ['this', row.promptText]]) {
        const line = el('div', 'cachelens-line');
        const shared = showNewlines(text.slice(before, at));
        const divergent = showNewlines(text.slice(at, at + EXPANSION_CONTEXT.after));

        divergentChars = Math.max(divergentChars, divergent.length);
        line.append(el('span', 'cachelens-line-label', label));
        line.append(el('span', 'cachelens-ellipsis', before > 0 ? '…' : ' '));
        line.append(el('span', 'cachelens-shared', shared));
        line.append(el('span', 'cachelens-divergent', divergent));
        line.append(el('span', 'cachelens-ellipsis', text.length > at + EXPANSION_CONTEXT.after ? '…' : ''));
        box.append(line);
    }

    /**
     * A labelled span of dashes, so the two segments are measured rather than merely coloured.
     * @param {string} caption What the segment is
     * @param {number} width How many characters wide it should be
     * @returns {string} The rule
     */
    const segment = (caption, width) => {
        const inner = Math.max(0, width - 2);
        const pad = Math.max(0, inner - caption.length);
        const left = Math.floor(pad / 2);

        return `|${'-'.repeat(left)}${caption.slice(0, inner)}${'-'.repeat(pad - left)}|`;
    };
    const ruler = el('div', 'cachelens-ruler');

    ruler.append(el('span', 'cachelens-line-label', ''));
    ruler.append(el('span', 'cachelens-ellipsis', before > 0 ? ' ' : ' '));
    ruler.append(el('span', 'cachelens-shared', segment(` shared, ${fmt(sharedChars)} chars `, sharedChars)));
    ruler.append(el('span', 'cachelens-divergent', segment(` divergent, ${fmt(divergentChars)} chars `, divergentChars)));
    box.append(ruler);

    if (row.attribution === null) {
        const why = el('div', 'cachelens-unattributed', 'Unattributed: no prompt section could be placed here without ambiguity. A wrong name would send you to fix the wrong lorebook.');

        box.append(why);
    }

    return box;
}

/**
 * Show the raw request identity, input split, backend, age, and on-demand prompt view.
 * @param {import('./index.js').RawRow} row A raw row
 * @returns {HTMLElement} The drawer
 */
function renderRawDrawer(row) {
    const box = el('div', 'cachelens-expansion');
    const stamp = row.stamp;

    detail(
        box,
        'What this is',
        'A quiet generation (for example /gen, Vocalis Quote-and-Send, or a summary). It is not part of the chat history.',
    );

    const input = summaryFor(row);
    let inputText;

    if (input.cached === null || input.uncached === null) {
        inputText = input.text;
    } else {
        const total = input.cached + input.uncached;

        inputText = `${fmt(total)} tokens — cached ${fmt(input.cached)} (${pct(input.cached, total)}), uncached ${fmt(input.uncached)} (${pct(input.uncached, total)})`;
    }

    detail(box, 'Input', inputText, { title: input.title });

    detail(box, 'Backend', `${stamp?.backend ?? '—'} / ${stamp?.apiType ?? '—'}`);

    const age = describeAge(stamp?.requestedAt ?? null, Date.now());

    detail(box, 'When', age ?? 'time not recorded');

    detail(box, 'Prompt', "use view to see it while the server still holds it — it keeps its last few generations in memory only");

    return box;
}

/**
 * One row.
 *
 * Message and raw rows share the same layout and click/keyboard behavior. They branch only for the id column,
 * drawer content, and `view` target.
 * @param {import('./index.js').Row} row A row from `buildRows`
 * @param {import('./index.js').Mode} mode From `buildRows` — needed by a message row's "Prompt shown is" line
 * @returns {HTMLElement} The row element
 */
function renderRow(row, mode) {
    const isRaw = row.kind === 'raw';
    const node = el('div', isRaw ? 'cachelens-row cachelens-row-raw' : 'cachelens-row');
    const head = el('div', isRaw ? 'cachelens-head cachelens-head-raw' : 'cachelens-head');
    const isExpanded = expanded.has(row.rowKey);

    // Expansion state and DOM identity use `rowKey`, not `mesId` (DESIGN_RAW_GENERATION_ROWS.md §8) — a raw
    // row has no `mesId` at all. `mesId` stays on message rows too, below: existing tests and any external
    // styling may still read it.
    node.dataset.rowkey = String(row.rowKey);

    // The head is the one clickable/focusable control that opens the drawer, for both row kinds.
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');

    if (isRaw) {
        // 🔴 THE WHOLE ROW SAYS WHAT IT IS, NOT JUST THE BADGE — colour and hover are never the only
        // indicators (DESIGN_RAW_GENERATION_ROWS.md §1, §10). Kept unchanged by this redesign.
        const RAW_TOOLTIP = 'Raw generation request (SillyTavern quiet generation). It is not part of roleplay chat history.';

        node.title = RAW_TOOLTIP;
        node.setAttribute('aria-label', RAW_TOOLTIP);

        const idCol = el('span', 'cachelens-id cachelens-id-raw');

        idCol.append(el('span', 'cachelens-raw-badge', 'RAW'));

        // A quiet request's own seq, alongside the badge, when there is one to show.
        if (row.stamp?.seq) {
            idCol.append(el('span', 'cachelens-raw-seq', `#${row.stamp.seq}`));
        }

        head.append(idCol);
    } else {
        node.dataset.mesid = String(row.mesId);
        head.append(el('span', 'cachelens-id', `#${row.mesId}`));
    }

    head.append(renderBar(row));
    head.append(renderSummary(row));

    const when = renderWhen(row);

    if (when) {
        head.append(when);
    }

    const view = renderViewButton(row);

    if (view) {
        head.append(view);
    }

    const chevron = el('span', 'cachelens-chevron', isExpanded ? '▾' : '▸');

    chevron.setAttribute('aria-hidden', 'true');
    head.append(chevron);

    node.append(head);

    if (isExpanded) {
        node.append(isRaw
            ? renderRawDrawer(/** @type {import('./index.js').RawRow} */ (row))
            : renderMessageDrawer(/** @type {import('./index.js').MessageRow} */ (row), mode));
    }

    const toggle = () => {
        if (expanded.has(row.rowKey)) {
            expanded.delete(row.rowKey);
        } else {
            expanded.add(row.rowKey);
        }

        void refreshPanel();
    };

    head.addEventListener('click', toggle);
    // Enter and Space are the standard activation keys for a `role="button"` element — a native <button>
    // gets these for free, but `head` is a <div> (it also has to contain the bar, summary and view button),
    // so the keydown handler is what makes it actually reachable from the keyboard rather than just labelled
    // as one.
    //
    // Ignore bubbled key events from descendant controls, such as the view button, so their activation does not
    // also toggle the row drawer.
    head.addEventListener('keydown', (event) => {
        if (event.target !== head) {
            return;
        }

        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault?.();
            toggle();
        }
    });

    return node;
}

/**
 * The header that states which source produced what is on screen.
 *
 * 🔴 STATE WHICH SOURCE PRODUCED WHAT YOU ARE SHOWING. Presenting the browser's copy as "what the backend
 * received" is the exact failure the fork record exists to prevent, and it would be worse for being
 * invisible (DESIGN.md §6.3).
 * @param {import('./index.js').Mode} mode From `buildRows`
 * @param {number} droppedRows How many itemized entries carried no usable prompt
 * @param {boolean} skipsUserMessages Whether any listed row is separated from the next by messages the
 * reader sent — the numbering note is printed only when there is a skip on screen to explain
 * @returns {HTMLElement} The header
 */
function renderMode(mode, droppedRows, skipsUserMessages) {
    const box = el('div', 'cachelens-mode');

    // Show the version compiled into the loaded module. A per-user extension copy can shadow the global copy,
    // and an open tab keeps its loaded modules until reloaded; this identifies which code rendered the panel.
    const stamp = el('div', 'cachelens-version', `Cache Lens ${VERSION}`);

    stamp.title = "The version of the code that drew this panel. If it disagrees with the version in SillyTavern's extension list, this page is running modules the server has already replaced — reload it.";
    box.append(stamp);

    // State what the panel shows and where the information came from; avoid a mode label that has no user-facing
    // distinction.
    if (mode.recordSupported) {
        box.append(el('div', 'cachelens-mode-line', `The server reports what it actually sent — the last ${mode.depth} generations per backend.`));

        if (mode.recordsSeen === 0) {
            box.append(el('div', 'cachelens-mode-line cachelens-muted', 'Nothing recorded on this backend yet — this resolves on the next generation.'));
        }
    } else if (mode.pluginsPresent) {
        box.append(el('div', 'cachelens-mode-line cachelens-warn', 'This build does not report what the server sent, and a server plugin is loaded. Turns are greyed because the final prompt is not visible to the client.'));
    } else {
        box.append(el('div', 'cachelens-mode-line', "This build does not report what the server sent. No server plugin is loaded, so the browser's copy is what went out."));
    }

    // Client-side prompt changes are reported in the row drawer only when a component actually changed the
    // prompt; avoid repeating that explanation in the panel header.

    // Explain once that message ids refer to generated messages; user messages create gaps between rows.
    if (skipsUserMessages) {
        box.append(el('div', 'cachelens-mode-line cachelens-muted', 'Numbered by chat message, so the ids step over your own messages: sending one is not a generation, and the prompt it produced is the row above it.'));
    }

    if (!mode.backend) {
        box.append(el('div', 'cachelens-mode-line cachelens-muted', 'This API does not reach the recorder.'));
    }

    if (mode.backend === 'chat') {
        // Chat-completion prompts are message arrays, so compare the assembled array rather than a string.
        box.append(el('div', 'cachelens-mode-line cachelens-muted', 'Chat completion: the prompt is a message array, so rows compare the assembled array rather than a string.'));
    }

    // 🔴 HONEST DEGRADATION, NOT AN ERROR (DESIGN_RAW_GENERATION_ROWS.md §11.4). An older Taproom build can
    // still be recognised as having sent a `quiet` generation — the record identity and classification are
    // unrelated to usage — so raw rows can still be LISTED. What it never does is invent a zero measurement
    // for one, and this line says why the raw rows on screen have no bar or counts rather than leaving the
    // reader to wonder whether reuse was really nil.
    if (mode.rawUsageSupported === false) {
        box.append(el('div', 'cachelens-mode-line cachelens-muted', 'This Taproom build does not report cache usage for raw generation requests, so raw rows are listed but cannot be measured.'));
    }

    // ⚠️ "TOO NEW TO READ" AND "NOT RECORDED" ARE OPPOSITE FACTS — the same rule `cacheLine`'s
    // `unreadableStamp` branch already enforces for an ordinary row's stamp, applied to the whole raw envelope
    // (DESIGN_RAW_GENERATION_ROWS.md §7.2, §13). Printed once here rather than per row, because it is a fact
    // about this chat's data, not about any one turn.
    if (mode.rawEnvelopeUnreadable !== null && mode.rawEnvelopeUnreadable !== undefined) {
        box.append(el('div', 'cachelens-mode-line cachelens-warn', `This chat holds raw generation measurements written under schema v${mode.rawEnvelopeUnreadable}, which this build (${VERSION}) does not know how to read. They have not been lost and are left untouched — reload the page, and if the version above still disagrees with SillyTavern's extension list, this tab is running modules the server has already replaced.`));
    }

    if (droppedRows > 0) {
        box.append(el('div', 'cachelens-mode-line cachelens-muted', `${droppedRows} turn(s) not listed: their itemized entry carries no prompt, which a long chat's persisted store does for older turns. A turn the panel can say nothing about is left out rather than drawn as an empty row.`));
    }

    // Make the expandable details discoverable without repeating per-row instructions.
    box.append(el('div', 'cachelens-mode-line cachelens-muted', 'Newest first. Click a row for details.'));

    return box;
}

/**
 * One run of message ids between two rows that has no row of its own.
 * @typedef {object} Gap
 * @property {number} from First rowless message id
 * @property {number} to Last rowless message id
 * @property {number} below The row this run sits directly above
 * @property {boolean} allUser Whether every id in it is a message the reader sent
 */

/**
 * The rowless runs between the listed rows, decided once so the header and the list cannot disagree.
 *
 * 🔴 AN EXPLANATION PRINTED NINE TIMES IN A TEN-ROW PANEL IS THE ANNOYANCE, NOT THE CURE. Generations are
 * stamped with the id of the message they PRODUCE, so an ordinary alternating chat leaves every message the
 * reader typed without a row — and the panel captioned every one of them. Two wordings of that caption were
 * tried, and both READ AS NINE MISSING LINES, because a line of prose between two rows is a thing the eye
 * counts as a row whatever it says. So the ordinary case now draws NOTHING and the numbering is explained
 * once in the header. What still gets a line is a run the panel cannot account for — rare, genuinely worth
 * pointing at, and the signal the interleaved text was drowning.
 *
 * 🔴 MESSAGE ROWS ONLY (DESIGN_RAW_GENERATION_ROWS.md §8, §10). A raw row has no `mesId` and is not a
 * message — it neither creates nor closes a numeric `mesId` gap. Feeding it the full `rows` list (raw and
 * message mixed) would compare `undefined` against a message id here and manufacture a phantom gap line; the
 * caller passes `messageRows` from `buildRows()`, never `rows`.
 * @param {import('./index.js').MessageRow[]} messageRows The message-kind rows the panel is drawing, newest
 * first
 * @param {Set<number>} userMesIds Which ids in the listed span the reader sent
 * @returns {Gap[]} One entry per rowless run
 */
function gapsBetween(messageRows, userMesIds) {
    /** @type {Gap[]} */
    const gaps = [];
    let previousId = null;

    for (const row of messageRows) {
        if (previousId !== null && previousId - row.mesId > 1) {
            const from = row.mesId + 1;
            const to = previousId - 1;
            let allUser = true;

            for (let id = from; id <= to; id++) {
                if (!userMesIds.has(id)) {
                    allUser = false;
                    break;
                }
            }

            gaps.push({ from, to, below: row.mesId, allUser });
        }

        previousId = row.mesId;
    }

    return gaps;
}

/**
 * The line standing in for a run of rowless messages the panel CANNOT account for.
 *
 * ⚠️ NEVER CALLED FOR A RUN THE READER SENT — that one draws nothing. This wording stays deliberately
 * uncommitted about what the missing messages were, because a hidden message, an edit and an entry whose
 * prompt aged out of the browser's store are three different facts and the panel checked none of them.
 * @param {Gap} gap One rowless run
 * @returns {string} The line
 */
function gapLine(gap) {
    const span = gap.from === gap.to ? `#${gap.from}` : `#${gap.from}–#${gap.to}`;

    return `${span} — no prompt recorded, so no row. Expected, not a dropped turn.`;
}

/**
 * Draw everything into the open panel.
 * @returns {Promise<void>} When drawn
 */
export async function refreshPanel() {
    if (!container || !openInstance) {
        return;
    }

    const target = container;
    const { rows, messageRows, userMesIds, mode, droppedRows } = await buildRows();

    if (container !== target) {
        return;
    }

    // 🔴 GAPS ARE COMPUTED FROM `messageRows`, NEVER `rows` (DESIGN_RAW_GENERATION_ROWS.md §8). `rows` is the
    // combined, interleaved list both kinds render from below; `messageRows` is the message-only subset in
    // the same order, and it is what `gapsBetween` needs to avoid inventing a gap around a raw row.
    const gaps = gapsBetween(messageRows, userMesIds);
    const draw = () => {
        target.replaceChildren();
        target.append(renderMode(mode, droppedRows, gaps.some(gap => gap.allUser)));

        const list = el('div', 'cachelens-rows');

        if (rows.length === 0) {
            list.append(el('div', 'cachelens-mode-line cachelens-muted', 'No turns with a recorded prompt in this chat yet.'));
        }

        // 🔴 ONLY THE RUNS THE PANEL CANNOT ACCOUNT FOR GET A LINE. The reader's own messages are the
        // ordinary reason the ids step, they are explained once in the header, and captioning each one put
        // nine lines of prose into a ten-row list — which is what "rows are missing" looks like.
        const unexplained = new Map(gaps.filter(gap => !gap.allUser).map(gap => [gap.below, gap]));

        for (const row of rows) {
            // A gap belongs immediately above the MESSAGE row it was computed for — a raw row is never one
            // (DESIGN_RAW_GENERATION_ROWS.md §8), so it is never a candidate to carry a gap line above it.
            const gap = row.kind !== 'raw' ? unexplained.get(row.mesId) : undefined;

            if (gap) {
                list.append(el('div', 'cachelens-gap', gapLine(gap)));
            }

            list.append(renderRow(row, mode));
        }

        target.append(list);
    };

    draw();

    // Then the token numbers, which the first paint deliberately did not wait for.
    await fillTokenCounts(rows, getChatIdForCache());

    if (container === target) {
        draw();
    }
}

/**
 * The memo key for token counts. Kept here so `panel.js` and `index.js` agree without either importing the
 * other's private state.
 * @returns {string|null} The current chat id
 */
function getChatIdForCache() {
    return globalThis.SillyTavern?.getContext?.()?.chatId ?? null;
}

/**
 * Open the panel.
 * @returns {Promise<void>} When the panel closes
 */
export async function openPanel() {
    container = el('div', 'cachelens');

    const popup = new Popup(container, POPUP_TYPE.TEXT, null, {
        allowVerticalScrolling: true,
        leftAlign: true,
        wide: true,
        large: true,
    });

    openInstance = popup;

    const shown = popup.show();

    await refreshPanel();
    await shown;

    openInstance = null;
    container = null;
}
