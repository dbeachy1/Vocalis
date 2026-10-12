import fs from 'node:fs';
import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT REGISTERS SETTINGS AND DELIBERATELY NO PANEL.
 *
 * That combination IS the test. §28 exists because `registerPanel` was a server plugin's only UI channel, so
 * a plugin with no business owning a chat button had nowhere to put settings at all. An implementation that
 * hangs settings off the panel registration passes every test written against a plugin that has both — and
 * leaves the icon-less case, the one the capability was built for, exactly as broken as it was. So this
 * fixture registers settings, registers no panel, and the suite asserts the row exists anyway.
 *
 * It also serves a 503 view, because "I cannot read your settings right now" is an ordinary state for a
 * plugin whose store is encrypted and whose vault is locked — and a fork that answered it with an empty form
 * would be handing the user a Save button that overwrites their real configuration with shipped defaults.
 */

/** Where the journal goes. Set by the test, across the process boundary, because plugins run in the child. */
const journalPath = process.env.ST_PLUGIN_JOURNAL ?? '';

/**
 * Write one line to the journal.
 * @param {string} what What happened
 * @returns {void}
 */
function journal(what) {
    if (journalPath) {
        fs.appendFileSync(journalPath, `${what}\n`, 'utf-8');
    }
}

/** The settings fragment. Carries an action and a region so the shared panel machinery is exercised. */
export const SETTINGS_FRAGMENT = '<div data-panel-region="settings-body">'
    + '<p id="probe-settings">settings body</p>'
    + '<label>Threshold <input name="threshold" value="7"></label>'
    + '<div data-panel-action="/save" data-panel-method="POST" data-panel-form="settings-body" id="probe-save">Save</div>'
    + '</div>'
    // Same claim as the panel fixture's: the fork must serve a fragment VERBATIM and let the client host
    // sanitize. An `onerror` fires on innerHTML insertion where a `<script>` tag would not, so it can tell a
    // sanitized fragment from an unsanitized one; a `<script>` probe would be vacuously green.
    + '<img src="x" onerror="window.SETTINGS_PROBE_RAN = true">'
    + '<style>#send_but { display: none !important; }</style>'
    + '<p class="probe-settings-styled">styled by the plugin</p>';

/** What the plugin says when it cannot read the user's real settings. Never a form — see the header. */
export const LOCKED_FRAGMENT = '<p id="probe-locked">Log in to your vault to edit these settings.</p>';

export const info = {
    id: 'settings-probe',
    name: 'Settings Probe',
    description: 'Registers settings and no panel. Test fixture.',
};

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The context the fork provides
 * @returns {Promise<void>}
 */
export async function init(router, context) {
    // See fixture-gate.mjs: a fixture nobody asked for registers nothing.
    if (!fixtureIsEnabled('settings-probe')) {
        return;
    }

    if (typeof context?.registerSettings !== 'function') {
        journal('registerSettings: MISSING');
        return;
    }

    journal(`apiVersion: ${context.apiVersion}`);

    router.get('/settings', (request, response) => {
        // Whatever the fork put in the query, echoed so the suite can prove the ambient context arrives here
        // exactly as it does on a panel route — one machinery, not two.
        journal(`settings route chatId: ${typeof request.query.chatId === 'string' ? request.query.chatId : 'none'}`);
        response.type('html').send(SETTINGS_FRAGMENT);
    });

    // 🔴 THE CONTRACT FOR "CANNOT ANSWER RIGHT NOW". A body, and a 503 — so the host renders the plugin's own
    // words rather than an error toast, and never substitutes a form.
    router.get('/settings-locked', (_request, response) => {
        response.status(503).type('html').send(LOCKED_FRAGMENT);
    });

    router.get('/settings.css', (_request, response) => {
        // The second rule reaches for HOST CHROME on purpose: it is what an unscoped plugin stylesheet could
        // do to the Extensions dialog it is a guest in, and the host's `@scope` wrapper must leave it
        // matching nothing.
        response.type('css').send('.probe-settings-styled { color: rgb(4, 5, 6); } #send_but { display: none !important; }');
    });

    router.post('/save', (request, response) => {
        journal(`save saw threshold: ${request.body?.threshold ?? 'none'}`);
        response.sendStatus(204);
    });

    // --- The happy path. NOTE: no registerPanel call anywhere in this file, on purpose. ---

    context.registerSettings({
        label: 'Settings Probe',
        description: 'Everything this fixture can be told to do.',
        settingsPath: '/settings',
        stylesheetPath: '/settings.css',
    });
    journal('registerSettings: accepted');

    // --- The refusals. Each must THROW, in init, naming this plugin — same discipline as registerPanel. ---

    /**
     * Record whether a bad spec was refused.
     * @param {string} what Which malformation is being tried
     * @param {any} spec The spec to attempt
     * @returns {void}
     */
    const mustRefuse = (what, spec) => {
        try {
            context.registerSettings(spec);
            journal(`registerSettings ${what}: ACCEPTED`);
        } catch (error) {
            journal(`registerSettings ${what}: refused, names plugin: ${String(error.message).includes('settings-probe')}`);
        }
    };

    mustRefuse('no spec', undefined);
    mustRefuse('array', []);
    mustRefuse('missing settingsPath', { label: 'No Path' });
    mustRefuse('missing label', { settingsPath: '/settings' });
    mustRefuse('empty label', { label: '', settingsPath: '/settings' });
    mustRefuse('relative settingsPath', { label: 'Relative', settingsPath: 'settings' });
    mustRefuse('relative stylesheetPath', { label: 'Relative', settingsPath: '/settings', stylesheetPath: 'settings.css' });

    // A leading slash is not the boundary — the RESOLVED path is. Each of these prefixes cleanly onto
    // /api/plugins/settings-probe and still lands somewhere else once a browser normalises it away.
    mustRefuse('escaping settingsPath', { label: 'Escape', settingsPath: '/../other-plugin/settings' });
    mustRefuse('escaping stylesheetPath', { label: 'Escape', settingsPath: '/settings', stylesheetPath: '/%2e%2e/other/panel.css' });
    mustRefuse('escaping settingsPath (backslash)', { label: 'Escape', settingsPath: '/..\\other-plugin/settings' });

    // ⚠️ A REFUSED REGISTRATION MUST NOT HAVE REPLACED THE GOOD ONE. `register` overwrites a plugin's existing
    // entry by design (one plugin, one settings screen), so a validator that mutated before it validated
    // would leave this plugin with no settings at all — and the happy-path assertions above would still pass
    // if they ran first. The suite re-checks the registration after all of these.
}
