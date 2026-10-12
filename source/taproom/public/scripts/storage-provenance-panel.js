import { getRequestHeaders } from '../script.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { summariseProviderNeed } from './chat-storage-marker-logic.js';

/**
 * 🪪 SURFACE 5 — THE "WHAT DID MY UNINSTALL TAKE?" PANEL (`DESIGN_STORAGE_PROVENANCE.md` §7 surface 5).
 *
 * Surfaces 1–4 mark the one file, list or editor in front of the user. This is the one place that answers the
 * question a worried user actually has the moment a provider is gone: across my whole account, how much needs
 * it, and what kinds of thing? The server walks the data root and returns grouped counts; this asks for them
 * on demand, and draws one honest sentence per provider.
 *
 * ## 🔴 THE RULES IT INHERITS, NONE OF WHICH IT GETS TO RELAX
 *
 * - **The words come from {@link summariseProviderNeed}, which is pure and tested.** Pluralisation, verb
 *   agreement and the provider phrasing all live there, so a wrong sentence is a unit-test failure, not
 *   something only a human reading the popup would notice.
 * - 🔴 **Every value is written with `textContent`, never markup.** The provider name and `source` are
 *   validated server-side but they are not trusted, and a summary is precisely a place a user is told what to
 *   go and install — the softest possible target for an injected string. No `innerHTML`, no anchor, no link
 *   built from anything the server returned (§3.1, §5).
 * - ⚠️ **A failure draws the reassuring answer, not an alarm.** No provider, an old server without the
 *   endpoint, a request that simply failed: all collapse to "nothing here needs a plugin", which is the true
 *   answer for the overwhelming majority of installs and the safe one when the fork cannot tell.
 */

/** How the panel titles itself in the popup chrome. */
const PANEL_TITLE = 'Storage — data that needs a plugin';

/**
 * Ask the authenticated summary endpoint what an uninstall took.
 * @param {boolean} refresh Whether to bypass the server's per-boot cache and re-walk the data root
 * @returns {Promise<{providers: Array<object>, truncated: boolean, incomplete: boolean}|null>} The summary,
 * or null on any failure
 */
async function fetchSummary(refresh) {
    try {
        const response = await fetch('/api/storage/unavailable-summary', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(refresh ? { refresh: true } : {}),
        });

        // Not-ok means we learned nothing: a fork without the endpoint, or a caller the auth layer bounced.
        // Null is that answer, and `renderSummary` draws it as "could not check" — never as reassurance.
        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch {
        return null;
    }
}

/**
 * Build the panel body from a summary. Plain DOM, every string via `textContent`, so nothing the server
 * returned can be interpreted as markup.
 * @param {{providers: Array<object>, truncated: boolean, incomplete: boolean}|null} summary The endpoint's
 * answer, or null
 * @returns {HTMLElement} The container to hand to the popup
 */
function renderSummary(summary) {
    const container = document.createElement('div');
    container.classList.add('storage-provenance-panel', 'flex-container', 'flexFlowColumn');

    // 🔴 "COULD NOT CHECK" IS NOT "NOTHING IS WRONG", AND THIS PANEL SAID THEY WERE THE SAME.
    //
    // `fetchSummary` collapses every failure to null — an expired session, a stale CSRF token, a server
    // mid-restart, a body that would not parse. One line later `summary?.providers` turned that null into
    // `[]`, indistinguishable from a scan that ran and found nothing, and the panel stated as fact that
    // nothing the user owns needs a missing provider. That is DESIGN_MIXED_MODE §11's "how a user concludes
    // their data is gone and stops looking for it", running in reverse: the one screen built to tell them
    // what needs recovering reassures them hardest exactly when it has learned nothing at all.
    //
    // The sibling marker already resolves this ambiguity the right way (storage-indicator.js: "a claim about
    // the server, and a claim that could not be verified must not be made"). Reassurance is now reachable
    // only from an answer that actually arrived.
    if (summary === null || summary === undefined) {
        const unknown = document.createElement('p');
        unknown.textContent = 'Could not check — the server did not answer. Try again in a moment.';
        container.append(unknown);
        return container;
    }

    const providers = Array.isArray(summary?.providers) ? summary.providers : [];

    // 🔴 THE CAVEATS BELONG ABOVE THE EARLY RETURN, NOT AFTER IT — THE EMPTY ANSWER IS THE ONE THAT NEEDS
    // THEM MOST. Both flags were only ever consulted on the non-empty path, so the single case where the
    // scan learned least printed the most confident sentence in the panel. A scan that exhausts its file
    // budget inside `chats/` — the type it walks first — returns no providers and `truncated: true`, having
    // never looked at characters, worlds, groups, backgrounds or settings; the panel then said flatly that
    // nothing needs a missing provider. `incomplete` is the same failure through the other door: a data
    // directory that could not be listed contributes nothing and used to leave no trace at all.
    const caveats = [];

    if (summary?.truncated === true) {
        caveats.push('This account has more data than one scan reads, so this is a partial answer.');
    }

    if (summary?.incomplete === true) {
        caveats.push('Part of your data could not be read at all during this scan, so it is not accounted for here.');
    }

    for (const caveat of caveats) {
        const note = document.createElement('p');
        note.classList.add('storage-provenance-truncated');
        note.textContent = caveat;
        container.append(note);
    }

    if (providers.length === 0) {
        const reassurance = document.createElement('p');

        // Only an answer with nothing left unseen may reassure without qualification.
        reassurance.textContent = caveats.length === 0
            ? 'Nothing you have needs a storage provider that is not installed.'
            : 'Nothing was found that needs a storage provider that is not installed — but see above.';

        container.append(reassurance);
        return container;
    }

    const intro = document.createElement('p');
    intro.textContent = 'Some of your data was written by a storage provider that is no longer installed. Here is what needs which one:';
    container.append(intro);

    for (const need of providers) {
        const sentence = summariseProviderNeed(need);

        if (!sentence) {
            continue;
        }

        const line = document.createElement('p');
        line.classList.add('storage-provenance-need');
        line.textContent = sentence;
        container.append(line);
    }

    if (summary?.truncated === true) {
        const note = document.createElement('p');
        note.classList.add('storage-provenance-truncated');
        note.textContent = 'These counts are a minimum — the scan stopped before reading everything.';
        container.append(note);
    }

    return container;
}

/**
 * The result value the custom "Rescan" button reports. A number, because the popup parses a button's result
 * with `Number()` and throws on anything else — and one clear of the built-in `POPUP_RESULT` values so it
 * cannot be mistaken for Close or Cancel.
 */
const RESCAN_RESULT = 100;

/**
 * Open the surface-5 panel. Fetches on open, and re-fetches (bypassing the server cache) when asked to
 * rescan, so a user who has since removed the affected data can confirm it without restarting the server.
 *
 * The rescan is a loop that reopens the popup rather than mutating the open one: every view goes through the
 * single {@link renderSummary} path, which is what keeps the `textContent`-only guarantee from having a second
 * code path to escape through.
 * @returns {Promise<void>} When the user closes the panel
 */
export async function openStorageProvenancePanel() {
    let refresh = false;

    for (;;) {
        const summary = await fetchSummary(refresh);
        const result = await callGenericPopup(renderSummary(summary), POPUP_TYPE.TEXT, '', {
            okButton: 'Close',
            wide: false,
            large: false,
            allowVerticalScrolling: true,
            customButtons: [{ text: 'Rescan', result: RESCAN_RESULT, appendAtEnd: true }],
        });

        if (result !== RESCAN_RESULT) {
            return;
        }

        refresh = true;
    }
}

/**
 * The panel's title, exported so a caller can label whatever control opens it consistently.
 */
export const STORAGE_PROVENANCE_PANEL_TITLE = PANEL_TITLE;
