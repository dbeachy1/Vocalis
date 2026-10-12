import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { startSillyTavern, makeScratchDirectory } from './util/st-server.js';
import { SETTINGS_FRAGMENT, LOCKED_FRAGMENT } from './fixtures/settings-plugin.mjs';
import { BROKEN_MESSAGE } from './fixtures/broken-plugin.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

// A scratch directory, not the repository's real `plugins/` — the fork honours `pluginsPath`.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');
const SETTINGS_FIXTURE = path.join(testDirectory, 'fixtures', 'settings-plugin.mjs');
const BROKEN_FIXTURE = path.join(testDirectory, 'fixtures', 'broken-plugin.mjs');
const QUERY_FIXTURE = path.join(testDirectory, 'fixtures', 'query-plugin.mjs');

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
 * 🔴 CAN A SERVER PLUGIN WITH NO ICON BE CONFIGURED, AND CAN A BROKEN ONE BE SEEN?
 *
 * §28. Until this existed, `registerPanel` was a server plugin's only way to put anything on screen, because
 * the server cannot draw — so a plugin with no business owning a chat button had no settings, no version
 * readout, and, worst, no way to say it had failed to start. This suite asserts the fork's half of both:
 *
 * 1. **Settings without a panel.** The fixture registers settings and NO panel deliberately. An
 *    implementation that hangs settings off the panel registration passes every test written against a plugin
 *    that has both, and leaves exactly the case this capability exists for still broken.
 * 2. **A failure that is visible.** A second fixture throws in `init`. It must appear in the inventory, named,
 *    with the stage it failed at — and its error MESSAGE must reach an admin and no one else, because that
 *    message is routinely an absolute path out of the server's filesystem.
 */
describe('server plugin settings and inventory', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let output = '';
    /** @type {string[]} */
    let lines = [];
    /** @type {any} */
    let clientConfig = {};
    /** @type {any[]} */
    let settings = [];
    /** @type {any[]} */
    let serverPlugins = [];

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-settings');
        const journalPath = path.join(scratch, 'plugin-journal.txt');

        installPlugin(SETTINGS_FIXTURE, 'zz-settings-probe');
        installPlugin(BROKEN_FIXTURE, 'zz-broken-probe');
        installPlugin(QUERY_FIXTURE, 'zz-query-probe');

        server = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                // 🔴 Never let a test git-pull the plugins directory. Auto-update defaults to TRUE.
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'settings-probe,broken-probe,query-probe',
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
        settings = clientConfig.settings ?? [];
        serverPlugins = clientConfig.serverPlugins ?? [];
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

    test('🔴 A PLUGIN THAT THROWS IN init DOES NOT STOP THE SERVER — otherwise nothing below is reachable', () => {
        expect(server.listening).toBe(true);
        expect(lines).not.toContain('registerSettings: MISSING');
    });

    test('the capability is announced by version, so a plugin can feature-detect instead of guessing', () => {
        expect(clientConfig.apiVersion).toBeGreaterThanOrEqual(6);
        // The context a plugin reads and the client-config agree. Pinned to the client-config's value rather than
        // to 6, which broke the moment API v7 was added and asserted nothing a `>= 6` check does not.
        expect(lines).toContain(`apiVersion: ${clientConfig.apiVersion}`);
    });

    test('🔴 SETTINGS SURVIVE TO THE ENDPOINT FROM A PLUGIN THAT REGISTERED NO PANEL — the whole point', () => {
        expect(lines).toContain('registerSettings: accepted');

        const entry = settings.find(one => one.id === 'settings-probe');

        expect(entry).toBeDefined();
        expect(entry.label).toBe('Settings Probe');
        expect(entry.description).toBe('Everything this fixture can be told to do.');

        // And it really did register no panel — a passing settings assertion means nothing if the fixture
        // quietly had a button all along. Scoped to this plugin: another fixture in the same boot registers
        // one deliberately, and a bare count would make this assertion about the wrong thing.
        expect((clientConfig.panels ?? []).filter(one => one.id === 'settings-probe')).toHaveLength(0);
    });

    test('settingsPath resolves under the plugin\'s own mount, and the fork never hard-codes the route name', () => {
        const entry = settings.find(one => one.id === 'settings-probe');

        expect(entry.settingsUrl).toBe('/api/plugins/settings-probe/settings');
        expect(entry.stylesheetUrl).toBe('/api/plugins/settings-probe/settings.css');
    });

    test('🔴 A REGISTERED QUERY SURVIVES REGISTRATION — it is legal, so the client has to cope with it', () => {
        // `resolveMountedPath` parses only to check the mount boundary and returns the raw string, so the
        // query rides through. That is deliberate, and it is what made the client-side concatenation bug
        // reachable: the fork accepts `/frag?view=x` and then had to send it alongside its own parameters.
        const settings = clientConfig.settings.find(one => one.id === 'query-probe');
        const panel = (clientConfig.panels ?? []).find(one => one.id === 'query-probe');

        expect(settings.settingsUrl).toBe('/api/plugins/query-probe/frag?view=settingsview');
        expect(panel.panelUrl).toBe('/api/plugins/query-probe/frag?view=panelview');
    });

    test('the plugin route parses its own parameter when nothing else is on the query', async () => {
        // The server half, in isolation: proof that `view` is an ordinary parameter and that anything reading
        // it as fused later is the CLIENT's doing. The browser half is in tests/frontend/server-plugins.e2e.js.
        const response = await fetch(`http://127.0.0.1:${server.port}/api/plugins/query-probe/frag?view=settingsview&tz=UTC`);

        await expect(response.text()).resolves.toContain('view=settingsview');
    });

    test('a keyed response, so a third capability can arrive without reshaping the first two', () => {
        expect(Array.isArray(clientConfig.panels)).toBe(true);
        expect(Array.isArray(clientConfig.settings)).toBe(true);
        expect(Array.isArray(clientConfig.serverPlugins)).toBe(true);
        expect(typeof clientConfig.prompts).toBe('object');
    });

    test('🔴 EVERY BAD SPEC WAS REFUSED IN init, NAMING THE PLUGIN — never accepted and surfaced later', () => {
        const refusals = lines.filter(line => line.startsWith('registerSettings ') && line !== 'registerSettings: accepted');

        expect(refusals).toHaveLength(10);
        expect(refusals.every(line => line.includes('refused, names plugin: true'))).toBe(true);
        expect(lines.some(line => line.includes(': ACCEPTED'))).toBe(false);
    });

    test('a refused registration did not take the good one down with it', () => {
        // `register` replaces a plugin's existing entry by design, so a validator that mutated before it
        // validated would leave this plugin with nothing — and every assertion above would still pass if the
        // refusals had run first. They run last in the fixture; this is the check that they cost nothing.
        expect(settings.filter(one => one.id === 'settings-probe')).toHaveLength(1);
    });

    test('the settings route serves the plugin\'s HTML verbatim — the fork must not rewrite it', async () => {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/plugins/settings-probe/settings`);

        expect(response.status).toBe(200);
        // Byte-for-byte, hostile payload included. Sanitizing is the CLIENT host's job; a fork that stripped
        // it here would be making a decision that belongs to whoever renders the fragment.
        await expect(response.text()).resolves.toBe(SETTINGS_FRAGMENT);
    });

    test('🔴 THE "CANNOT ANSWER RIGHT NOW" ROUTE IS A 503 WITH THE PLUGIN\'S OWN WORDS, NOT AN EMPTY FORM', async () => {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/plugins/settings-probe/settings-locked`);

        // A locked vault is an ordinary state, and the plugin is the only party that can say what to do about
        // it. The status distinguishes it from a working answer; the body is what the user reads.
        expect(response.status).toBe(503);
        await expect(response.text()).resolves.toBe(LOCKED_FRAGMENT);
    });

    test('🔴 A PLUGIN THAT THREW IS IN THE INVENTORY, NAMED, WITH THE STAGE IT DIED AT', () => {
        const broken = serverPlugins.find(one => one.id === 'broken-probe');

        expect(broken).toBeDefined();
        expect(broken.status).toBe('failed');
        expect(broken.stage).toBe('init');
        expect(broken.name).toBe('Broken Probe');
        // The folder it came out of, which is what the user sees in their plugins directory and the only
        // handle they have on it when the manifest never parsed at all.
        expect(broken.source).toBe('zz-broken-probe.mjs');
    });

    test('a plugin that loaded is in the inventory too, so the list is an inventory and not an error log', () => {
        const loaded = serverPlugins.find(one => one.id === 'settings-probe');

        expect(loaded).toBeDefined();
        expect(loaded.status).toBe('loaded');
        expect(loaded.name).toBe('Settings Probe');
        expect(loaded.description).toBe('Registers settings and no panel. Test fixture.');
        expect(loaded.stage).toBeUndefined();
    });

    test('🔴 THE ERROR MESSAGE DOES NOT TRAVEL TO EVERY LOGGED-IN USER — only its shape does', () => {
        const broken = serverPlugins.find(one => one.id === 'broken-probe');

        // `Error`, which is enough to tell "the plugin threw" from "the file would not even import" — and is
        // a constant from a fixed set rather than anything derived from the server's filesystem.
        expect(broken.code).toBe('Error');

        // The message is `${BROKEN_MESSAGE}`, and on a real install it is routinely an absolute path. This
        // response goes to everyone with a login, so it must not be here at all.
        expect(broken.message).toBeUndefined();
        expect(JSON.stringify(clientConfig)).not.toContain(BROKEN_MESSAGE);
    });

    test('an admin can get the message, because they are the one who can go and fix it', async () => {
        // The test server runs single-user, where the default user is an admin — so this is the admin arm.
        const response = await fetch(`http://127.0.0.1:${server.port}/api/plugins/diagnostics`);

        expect(response.status).toBe(200);

        const body = await response.json();
        const broken = body.serverPlugins.find(one => one.id === 'broken-probe');

        expect(broken.message).toContain(BROKEN_MESSAGE);
    });

    test('the failure was logged as well, so the inventory adds a channel rather than replacing one', () => {
        expect(output).toContain('Plugin \'broken-probe\' threw while initializing');
    });
});
