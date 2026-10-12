import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { startSillyTavern, makeScratchDirectory } from './util/st-server.js';
import { PANEL_FRAGMENT } from './fixtures/panel-plugin.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * 🔴 THE PLUGINS DIRECTORY IS NOT CONFIGURABLE — see plugin-context.test.js for the full note. The fixture is
 * installed into the repository's real `plugins/`, named `zz-*` so a stray file from a killed run is obvious,
 * and removed in the same `afterAll` that stops the server (the §12.7 lesson about a leaked registration).
 */
// A scratch directory, not the repository's real `plugins/`. The fork now honours `pluginsPath`, so a
// suite no longer has to share one process-wide directory with every other suite AND with whatever is
// genuinely installed on the machine.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');
const PANEL_FIXTURE = path.join(testDirectory, 'fixtures', 'panel-plugin.mjs');

/** Every shim we installed, so afterAll can take them out again. */
const installed = [];

/**
 * Turn an absolute path into something an `import` statement will accept on any platform.
 * @param {string} absolutePath The path to import
 * @returns {string} A file:// URL
 */
function pathToImportSpecifier(absolutePath) {
    return new URL(`file:///${absolutePath.split(path.sep).join('/')}`).href;
}

/**
 * Install a plugin fixture so a boot will pick it up.
 * @param {string} fixturePath Absolute path to the fixture module
 * @param {string} name Base name for the installed shim
 * @returns {void}
 */
function installPlugin(fixturePath, name) {
    const target = path.join(PLUGINS_DIRECTORY, `${name}.mjs`);
    fs.writeFileSync(target, `export { info, init } from ${JSON.stringify(pathToImportSpecifier(fixturePath))};\n`, 'utf-8');
    installed.push(target);
}

/**
 * 🔴 CAN A SERVER PLUGIN ACTUALLY GET A BUTTON?
 *
 * §14 exists because a server plugin gets an Express router and nothing that renders — it cannot draw a pixel.
 * The fork's half of closing that gap is a registry and one endpoint the bundled front-end reads. This suite
 * asserts that half end-to-end, in a real boot.
 *
 * The failure this is really designed against is the SILENT one, which is also the likeliest: a registration
 * that is accepted and never surfaced. Nothing errors, no button appears, and it is indistinguishable from a
 * plugin that chose not to register. So the fixture registers several panels and these tests assert on all,
 * including their order.
 */
describe('plugin UI panels', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let output = '';
    /** @type {string[]} */
    let lines = [];
    /** @type {any[]} */
    let panels = [];
    /** @type {any} */
    let clientConfig = {};

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-panels');
        const journalPath = path.join(scratch, 'plugin-journal.txt');

        installPlugin(PANEL_FIXTURE, 'zz-panel-probe');

        server = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                // 🔴 Never let a test git-pull the plugins directory. Auto-update defaults to TRUE.
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                // Only OUR fixtures register. Jest runs suites in parallel and plugins/ is shared and not
                // configurable, so another suite's shim may be on disk while this server boots (fixture-gate.mjs).
                ST_FIXTURE_IDS: 'panel-probe',
                ST_PLUGIN_JOURNAL: journalPath,
            },
        });

        output = server.output() ?? '';
        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${output}`);
        }

        lines = fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
            : [];

        const response = await fetch(`http://127.0.0.1:${server.port}/api/plugins/client-config`);
        clientConfig = response.ok ? await response.json() : {};
        panels = clientConfig.panels ?? [];
    }, 90_000);

    afterAll(async () => {
        if (server) {
            await server.stop();
        }
        for (const target of installed) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the plugin loaded at all — otherwise every assertion below is vacuous', () => {
        expect(output).toContain('server plugin(s) are currently loaded');
        expect(lines).not.toContain('registerPanel: MISSING');
    });

    test('registerPanel reaches the plugin and every registration survives to the endpoint', () => {
        // The silent failure this suite is built around: accepted, then never surfaced.
        expect(lines).toContain('registerPanel emoji: accepted');
        expect(lines).toContain('registerPanel fontawesome: accepted');
        expect(lines).toContain('registerPanel status-presentation: accepted');
        expect(panels).toHaveLength(3);
    });

    test('the response is keyed by capability, so §17 can add a sibling key without breaking this one', () => {
        // 🔴 NOT a bare array. §17 must send a per-plugin `recentMessages` count outward too, and a plugin can
        // declare a window while registering NO panel — so anything keyed off panels would silently drop
        // exactly those plugins. This asserts the envelope, because reshaping it later, once a released
        // Mnemosyne is reading it, is a breaking change and reshaping it now is free.
        expect(Array.isArray(clientConfig)).toBe(false);
        expect(clientConfig).toHaveProperty('panels');
        expect(Array.isArray(clientConfig.panels)).toBe(true);
    });

    test('display order is registration order, and is stated rather than incidental', () => {
        expect(panels.map(p => p.label)).toEqual(['First Panel', 'Second Panel', 'Status Presentation Panel']);
    });

    test('the fork resolves panelUrl under the plugin\'s own mount, and never hard-codes the route name', () => {
        expect(panels[0].panelUrl).toBe('/api/plugins/panel-probe/panel');
        expect(panels[0].statusUrl).toBe('/api/plugins/panel-probe/status');
    });

    test('a panel without statusPath gets no statusUrl, rather than an empty one', () => {
        // §14.6: no status means an always-on button, not a broken poll against ''.
        expect(panels[1]).not.toHaveProperty('statusUrl');
    });

    test('a panel may expose dynamic resting presentation through its status route', async () => {
        expect(panels[2].statusUrl).toBe('/api/plugins/panel-probe/status-presentation');

        const textResponse = await fetch(`http://127.0.0.1:${server.port}${panels[2].statusUrl}?backend=text`);
        expect(await textResponse.json()).toEqual({ active: false, count: 0 });

        const chatResponse = await fetch(`http://127.0.0.1:${server.port}${panels[2].statusUrl}?backend=chat`);
        expect(await chatResponse.json()).toEqual({
            active: false,
            disabled: true,
            count: 0,
            color: '#555b63',
            tooltip: 'disabled while structured work mode is active',
        });
    });

    test('stylesheetPath resolves under the plugin\'s own mount, like every other panel route', () => {
        // The channel exists because a plugin renders into a document whose stylesheet it cannot extend, so
        // every class it emits matches nothing. It is a PATH and not CSS for the same reason `panelPath` is:
        // the fragment must never be able to supply it.
        expect(panels[0].stylesheetUrl).toBe('/api/plugins/panel-probe/panel.css');
    });

    test('a panel without stylesheetPath gets no stylesheetUrl, so the client fetches nothing', () => {
        // Mutation guard: a registry that defaults the field would have every panel-less-CSS plugin fetching
        // a route it never wrote, and logging a failure per open for ever.
        expect(panels[1]).not.toHaveProperty('stylesheetUrl');
    });

    test('the icon form is classified server-side, so the client never sniffs the string', () => {
        expect(panels[0].iconType).toBe('emoji');
        expect(panels[1].iconType).toBe('class');
        expect(panels[1].icon).toBe('fa-solid fa-brain');
    });

    test('iconColor survives for the FontAwesome form — the whole reason that form exists', () => {
        // Mutation guard: a registry that drops iconColor leaves §14.3.1's colour promise unfulfilled while
        // every other assertion here still passes.
        expect(panels[1].iconColor).toBe('#c8a2ff');
    });

    test('the panel route serves the plugin\'s HTML verbatim — the fork must not rewrite it', async () => {
        const response = await fetch(`http://127.0.0.1:${server.port}${panels[0].panelUrl}`);
        const body = await response.text();

        expect(response.status).toBe(200);
        // Sanitizing is the CLIENT host's job (§14.5). A fork that strips the script here has quietly taken
        // over a plugin's output, and the plugin would have no way to tell.
        expect(body).toBe(PANEL_FRAGMENT);
    });

    test('?chatId reaches the panel route, so a panel can scope itself to the chat on screen', async () => {
        await fetch(`http://127.0.0.1:${server.port}${panels[0].panelUrl}?chatId=abc%20123`);
        const seen = await fetch(`http://127.0.0.1:${server.port}/api/plugins/panel-probe/last-chat-id`);

        // §14.4 — the half of per-chat correlation this capability owns. Decoded, not raw.
        expect(await seen.text()).toBe('abc 123');
    });

    test('the status route answers per chat, so the light follows the conversation being viewed', async () => {
        const lit = await (await fetch(`http://127.0.0.1:${server.port}${panels[0].statusUrl}?chatId=lit-chat`)).json();
        const dark = await (await fetch(`http://127.0.0.1:${server.port}${panels[0].statusUrl}?chatId=other-chat`)).json();

        // Mutation guard: a poller that always lights passes the first of these and fails the second.
        expect(lit.active).toBe(true);
        expect(dark.active).toBe(false);
        expect(lit.count).toBe(3);
    });

    test.each([
        ['no spec'],
        ['array'],
        ['missing panelPath'],
        ['missing label'],
        ['empty icon'],
        ['relative panelPath'],
        ['relative statusPath'],
        ['relative stylesheetPath'],
        // 🔴 These four are the boundary, not the typo check. Each prefixes onto the plugin's mount and
        // still leaves it once the browser resolves the path, arriving at another plugin's router — or the
        // fork's own — with the user's session and a valid CSRF token.
        ['escaping panelPath'],
        ['escaping statusPath'],
        ['escaping stylesheetPath'],
        ['escaping panelPath (backslash)'],
    ])('a bad registration (%s) throws in init and names the plugin', (what) => {
        // 🔴 The alternative to throwing here is a button that silently does nothing when a user clicks it
        // days later. A validator that tolerates any of these passes every happy-path test above.
        expect(lines).toContain(`registerPanel ${what}: refused, names plugin: true`);
        expect(lines).not.toContain(`registerPanel ${what}: ACCEPTED`);
    });
});
