import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT SERVES AN *INTERACTIVE* PANEL, so the host's half of `DESIGN_PLUGIN_PANEL_UI.md` can be
 * driven from a real browser.
 *
 * Separate from `panel-plugin.mjs` on purpose. That fixture's suite asserts on the exact set and order of
 * registered buttons, so adding a third registration there would break it — and gating the two by
 * `ST_FIXTURE_IDS` is what the fixture gate exists for.
 *
 * Everything here is shaped to make a *host* defect visible. The region routes each return a deliberately
 * partial response, so a host that redraws everything on every action fails rather than passes-but-flickers.
 * `/seen` reads back the query the last request carried, which is the only way to prove from the page that
 * ambient context arrived — and, more importantly, that the avatar key did NOT.
 */

export const info = {
    id: 'panel-interactive',
    name: 'Interactive Panel Probe',
    description: 'Serves a panel with regions and actions. Test fixture.',
};

/**
 * The initial panel. Three regions plus two rows, so a partial swap has siblings to leave alone.
 *
 * ⚠️ `data-panel-focus` on the edit box is what the focus-preservation test hangs on. Without it the host is
 * correct to drop focus, and the test would be asserting the absence of a feature nobody asked for.
 */
const PANEL = `
<div data-panel-region="header" id="probe-header">header v1</div>
<div data-panel-region="list" id="probe-list">
  <div data-panel-region="row-1" id="probe-row-1">row one</div>
  <div data-panel-region="row-2" id="probe-row-2">row two</div>
</div>
<div data-panel-region="edit-box">
  <input name="text" value="initial" data-panel-focus="edit-text" id="probe-input">
  <div class="pluginPanel-button" tabindex="0" id="probe-save"
       data-panel-action="/echo" data-panel-method="POST" data-panel-form="edit-box">save</div>
</div>
<div data-panel-region="panel-error" id="probe-error"></div>
<div data-panel-region="pager" id="probe-pager">
  <div class="pluginPanel-button" tabindex="0" id="probe-page" data-panel-action="/bump" data-panel-params="offset=40">older</div>
  <div class="pluginPanel-button" tabindex="0" id="probe-key" data-panel-action="/bump" data-panel-key="pagedown">by key</div>
</div>
<div class="pluginPanel-button" tabindex="0" id="probe-remove" data-panel-action="/kill" data-panel-method="DELETE">remove row one</div>
<div class="pluginPanel-button" tabindex="0" id="probe-whole" data-panel-action="/whole">redraw everything</div>
<div class="pluginPanel-button" tabindex="0" id="probe-ghost" data-panel-action="/ghost">region that is not here</div>
<div class="pluginPanel-button" tabindex="0" id="probe-boom" data-panel-action="/boom">fail</div>
<div class="pluginPanel-button" tabindex="0" id="probe-slow" data-panel-action="/slow">slow</div>
<div class="pluginPanel-button" tabindex="0" id="probe-escape" data-panel-action="escape-the-mount">no leading slash</div>
`;

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The context the fork provides
 * @returns {Promise<void>}
 */
export async function init(router, context) {
    if (!fixtureIsEnabled('panel-interactive')) {
        return;
    }
    if (typeof context?.registerPanel !== 'function') {
        return;
    }

    /** Everything the last real request carried, so the page can read it back without a second boot. */
    let seen = { query: {}, body: '', method: '' };

    /** Every request that reaches this router, so "no request was made" is provable. Counts `/seen` too. */
    let hits = 0;

    router.use((request, _response, next) => {
        hits++;

        // 🔴 `/seen` DOES NOT OVERWRITE WHAT IT REPORTS. The read is itself a request through this router, so
        // recording it would mean the page always reads back the query of its own probe — which is empty, and
        // which made every ambient-context assertion fail for a reason that had nothing to do with the host.
        // The hit COUNT still includes it, deliberately: the suite subtracts its own reads.
        if (request.path !== '/seen') {
            seen = {
                query: { ...request.query },
                body: typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? ''),
                method: request.method,
                // Plugin API v7: what the host sends so `context.generate()` works from a panel action.
                connection: request.get('X-ST-Connection') ?? null,
                envelope: typeof request.get('X-ST-Instruct-Envelope') === 'string',
            };
        }

        next();
    });

    router.get('/panel', (_request, response) => response.type('html').send(PANEL));
    router.get('/status', (_request, response) => response.json({ active: false, count: 0 }));

    // What the last request actually carried. 🔴 The assertion that matters most is a NEGATIVE one — that no
    // avatar filename is anywhere in here — so this returns the whole query rather than named fields.
    router.get('/seen', (_request, response) => response.json({ ...seen, hits }));

    // Two regions, and deliberately not the header: a host that swaps the whole panel passes the "pager
    // changed" assertion and fails the "header untouched" one.
    //
    // 🔴 IT REDRAWS THE EDIT BOX TOO, WHICH IS WHAT MAKES FOCUS PRESERVATION TESTABLE. §7.5 is about a region
    // being replaced *underneath* a control that has focus — the caret vanishing mid-word. Clicking a button
    // cannot produce that, because the click itself moves focus off the input first; only an action fired
    // while focus is still in the box does, which is why the suite drives this one from the keyboard.
    const EDIT_BOX = '<div data-panel-region="edit-box">'
        + '<input name="text" value="initial" data-panel-focus="edit-text" id="probe-input">'
        + '<div class="pluginPanel-button" tabindex="0" id="probe-save"'
        + ' data-panel-action="/echo" data-panel-method="POST" data-panel-form="edit-box">save</div>'
        + '</div>';

    router.get('/bump', (_request, response) => response.type('html')
        .send(`<div data-panel-region="pager" id="probe-pager">pager v2</div>${EDIT_BOX}`));

    // Removal plus a sibling update — the delete shape from §13.3.
    router.delete('/kill', (_request, response) => response.type('html').send(
        '<div data-panel-region="row-1" data-panel-remove></div>' +
        '<div data-panel-region="header" id="probe-header">header v2</div>',
    ));

    router.get('/whole', (_request, response) => response.type('html')
        .send('<div data-panel-region="root"><p id="probe-redrawn">everything</p></div>'));

    // A region that is not on screen. Must be ignored in silence (§5.2) — not an error, not a redraw.
    router.get('/ghost', (_request, response) => response.type('html')
        .send('<div data-panel-region="nowhere">should not appear</div>'));

    router.get('/boom', (_request, response) => response.status(500).type('text').send('deliberate'));

    // Long enough that a second click lands while the first is in flight, short enough not to pace the suite.
    router.get('/slow', async (_request, response) => {
        await new Promise(resolve => setTimeout(resolve, 400));
        response.type('html').send('<div data-panel-region="header" id="probe-header">slow done</div>');
    });

    // Echoes the form body back into a region, which is how the suite proves `data-panel-form` collected the
    // input's CURRENT value rather than the one the fragment was rendered with.
    router.post('/echo', (request, response) => {
        const body = typeof request.body === 'object' && request.body ? request.body : {};
        const text = typeof body.text === 'string' ? body.text : '';

        response.type('html').send(
            '<div data-panel-region="edit-box">' +
            `<input name="text" value="${text.replace(/"/g, '&quot;')}" data-panel-focus="edit-text" id="probe-input">` +
            `<span id="probe-echo">${text.replace(/[<>&]/g, '')}</span>` +
            '</div>',
        );
    });

    context.registerPanel({
        icon: 'fa-solid fa-list',
        label: 'Interactive Panel',
        panelPath: '/panel',
        statusPath: '/status',
    });
}
