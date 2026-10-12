import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT REGISTERS A PATH WITH A QUERY OF ITS OWN — ON BOTH A PANEL AND SETTINGS.
 *
 * `resolveMountedPath` preserves a registered query on purpose: it parses only to check the mount boundary
 * and returns the raw string. So `/frag?view=x` is a legal registration, and §28's own documentation told the
 * first plugin that consumed it to register exactly that shape.
 *
 * It did not work. The fragment fetch built its URL by concatenation — `${url}?${ambientParams()}` — so a
 * SECOND `?` went on the wire. `?` is an ordinary character inside a query value, so the server parsed
 * `view="x?chatId=chat-42"` and never saw `chatId` at all.
 *
 * ⚠️ AND THE SYMPTOM WAS A CORRECT-LOOKING PAGE, which is why this fixture exists rather than a comment. A
 * plugin that validates its view name fails closed to its default view, so the WRONG SCREEN renders with a
 * 200, well-formed and styled, indistinguishable from the plugin having chosen to show that. Nobody
 * investigates a page that looks fine.
 *
 * The route below echoes what the server actually parsed, so the assertion is about the wire and not about
 * anything this fixture decided.
 */

export const info = {
    id: 'query-probe',
    name: 'Query Probe',
    description: 'Registers paths that carry their own query string. Test fixture.',
};

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The context the fork provides
 * @returns {Promise<void>}
 */
export async function init(router, context) {
    if (!fixtureIsEnabled('query-probe')) {
        return;
    }

    // One route, reached with two different registered `view` values. It reports the parsed query back as the
    // fragment, so a test reads what the SERVER saw rather than what the client believes it sent.
    router.get('/frag', (request, response) => {
        const seen = (name) => {
            const value = request.query[name];
            return typeof value === 'string' ? value : '';
        };

        response.type('html').send(
            '<div data-panel-region="body">'
            + `<p id="probe-view">view=${seen('view')}</p>`
            + `<p id="probe-tz">tz=${seen('tz')}</p>`
            + '</div>',
        );
    });

    if (typeof context.registerPanel === 'function') {
        context.registerPanel({
            icon: 'fa-solid fa-magnifying-glass',
            label: 'Query Panel',
            panelPath: '/frag?view=panelview',
        });
    }

    if (typeof context.registerSettings === 'function') {
        context.registerSettings({
            label: 'Query Settings',
            settingsPath: '/frag?view=settingsview',
        });
    }
}
