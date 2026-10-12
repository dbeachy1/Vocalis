import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN WHOSE SETTINGS ROUTE CANNOT ANSWER RIGHT NOW.
 *
 * §28.5. Mnemosyne's settings live inside the user's encrypted database, so while the vault is locked the
 * plugin genuinely cannot read them. That is an ordinary state, not a fault — and the failure it invites is
 * the expensive kind: a host that papered over it with a form full of shipped defaults would be handing the
 * user a Save button that overwrites their real configuration.
 *
 * So the contract is a **503 with a body**, and this fixture is the only way to prove the host honours it:
 * the plugin's own words render, and no form appears.
 *
 * ⚠️ REGISTERS ONLY THIS ONE ROUTE, and no panel. A second fixture rather than a query parameter on the
 * first, because the host builds the URL from the REGISTRATION and never from anything a fragment or a test
 * can hand it — which is exactly the property §6.2 exists to keep, so a test must not be able to bend it.
 */

export const info = {
    id: 'locked-probe',
    name: 'Locked Probe',
    description: 'Its settings route always answers 503. Test fixture.',
};

/** What the plugin says instead of a form. Exported so the e2e asserts on the same string it served. */
export const LOCKED_TEXT = 'Log in to your vault to edit these settings.';

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The context the fork provides
 * @returns {Promise<void>}
 */
export async function init(router, context) {
    if (!fixtureIsEnabled('locked-probe')) {
        return;
    }

    if (typeof context?.registerSettings !== 'function') {
        return;
    }

    router.get('/settings', (_request, response) => {
        // 🔴 A BODY, AND NO INPUTS IN IT. The absence of a form is half the assertion: the host must not
        // synthesize one, and the plugin must not send one it cannot populate.
        response.status(503).type('html').send(`<p id="probe-locked">${LOCKED_TEXT}</p>`);
    });

    context.registerSettings({
        label: 'Locked Probe',
        settingsPath: '/settings',
    });
}
