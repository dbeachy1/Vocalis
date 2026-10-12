import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { bootSillyTavern, makeScratchDirectory } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * 🔴 THE PLUGINS DIRECTORY IS NOT CONFIGURABLE, so this test writes into the real one.
 *
 * `server-main.js` builds it as `path.join(serverDirectory, 'plugins')` — no config value, no override, no
 * environment variable. Unlike `storageProvidersPath`, a test cannot point it at a scratch directory. So the
 * fixtures are installed into the repository's own `plugins/` and removed again in `afterAll`.
 *
 * The names are prefixed `zz-` so that a stray file left by a killed run sorts to the end and is obvious.
 * Nothing else in `plugins/` is touched: the loader skips `.gitkeep` and `package.json` (neither is `.js`,
 * `.cjs` or `.mjs`), and this test only ever unlinks the two files it created.
 */
// A scratch directory, not the repository's real `plugins/`. The fork now honours `pluginsPath`, so a
// suite no longer has to share one process-wide directory with every other suite AND with whatever is
// genuinely installed on the machine.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');

const CONTEXT_FIXTURE = path.join(testDirectory, 'fixtures', 'context-plugin.mjs');
const LEGACY_FIXTURE = path.join(testDirectory, 'fixtures', 'legacy-plugin.mjs');

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
 *
 * Re-export rather than copy, for the same reason `installStorageProvider` does: a copy sitting somewhere
 * else could not resolve its own imports.
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
 * 🔴 DOES THE PLUGIN CONTEXT ACTUALLY ARRIVE?
 *
 * The fork now calls `init(router, createPluginContext(id))`. Every claim made for that change is worthless
 * unless the second argument turns up in a real plugin, in a real boot — and a context that never arrives is
 * SILENT. The plugin reads `undefined`, does nothing, reports nothing, and looks exactly like a plugin that
 * simply had nothing to do.
 *
 * That is not hypothetical in this fork. `storage.multerStorage()` was resolved at module scope, returned
 * null for ever, and the plaintext fallback was installed permanently on every install that ever ran. It
 * looked exactly like working code. The lesson was written down: **before asking "does the hook work", ask
 * "did anything call it".**
 *
 * So: boot SillyTavern for real, with two plugins installed — one that wants the context and one written
 * before the context existed — and assert on what they wrote down.
 */
describe('the plugin context', () => {
    /** @type {string[]} */
    let lines = [];
    /** @type {string} */
    let output = '';
    /** @type {string} */
    let dataRoot = '';

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-context');
        dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const journalPath = path.join(scratch, 'plugin-journal.txt');

        installPlugin(CONTEXT_FIXTURE, 'zz-context-probe');
        installPlugin(LEGACY_FIXTURE, 'zz-legacy-probe');

        const result = await bootSillyTavern({
            dataRoot,
            configPath,
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                // The harness disables server plugins by default, and they are off by default in the product
                // too. This is the only test that wants them on.
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                // 🔴 Never let a test git-pull the plugins directory. Auto-update defaults to TRUE.
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                // Only OUR fixtures register. Jest runs suites in parallel and plugins/ is shared and not
                // configurable, so another suite's shim may be on disk while this server boots (fixture-gate.mjs).
                ST_FIXTURE_IDS: 'context-probe,legacy-probe',
                ST_PLUGIN_JOURNAL: journalPath,
            },
        });

        output = result.output ?? '';
        lines = fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
            : [];
    }, 90_000);

    afterAll(() => {
        for (const target of installed) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the plugin loads at all — otherwise every assertion below is vacuous', () => {
        // If this fails, the plugins never ran and the rest of this suite is asserting on an empty file.
        // That is the false green this whole fixture exists to prevent.
        expect(lines.length).toBeGreaterThan(0);
        expect(output).toContain('server plugin(s) are currently loaded');
    });

    test('init receives a second argument, and it is not undefined', () => {
        expect(lines).toContain('init called with 2 argument(s)');
        expect(lines).not.toContain('context: MISSING');
        expect(lines).toContain('context: object');
    });

    test('the context carries the plugin its own id, so a bad callback can be named', () => {
        expect(lines).toContain('context.id: context-probe');
    });

    test('onStorageReady is present, and calling it does not throw with no provider installed', () => {
        expect(lines).toContain('onStorageReady: function');
        expect(lines).toContain('onStorageReady() registered without throwing');
        expect(lines.some(line => line.startsWith('onStorageReady() THREW'))).toBe(false);
    });

    test('🔴 the storage provider itself is NOT reachable from the context', () => {
        // Handing a plugin the provider object hands it unlock, rekey and recover along with everything
        // else. If someone puts it on the context "for convenience", this is what notices.
        expect(lines).toContain('provider reachable: false');
    });

    test('🔴 with no provider installed, the key capabilities say NO — not "wait"', () => {
        // This is the plaintext deployment, which is a supported configuration and not an error. The
        // distinction that matters: hasSecureStorage is FALSE, meaning "there is no key here and there never
        // will be". A plugin reading that knows to fail loudly instead of waiting for an unlock that is
        // never coming.
        expect(lines).toContain('init hasSecureStorage: false');
        expect(lines).toContain('init deriveSubkey: null');
    });

    test('isStorageReady is TRUE with no provider — which is why it is useless alone', () => {
        // The plain filesystem is never unavailable, so `isReady` answers true. Anyone treating this as
        // "the vault is open" is wrong; it only means anything alongside hasSecureStorage.
        expect(lines).toContain('init isStorageReady: true');
    });

    test('embed is present — the capability the memory plugin is blocked on', () => {
        // Presence only. Whether it embeds anything is `plugin-embed.test.js`, which pays for a real model to
        // find out; this suite must stay cheap because five others share its fixture.
        expect(lines).toContain('embed: function');
    });

    test('userDirectory hands back this user\'s own directory, under the data root', () => {
        // A plugin with data of its own needs somewhere to put it, and the alternative it had was reaching
        // into globalThis.DATA_ROOT — the fork's internals, hard-coded into the plugin, breaking silently the
        // moment they move.
        expect(lines).toContain('userDirectory: function');
        expect(lines).toContain(`init userDirectory: ${path.join(dataRoot, 'default-user')}`);
    });

    test('🔴 userDirectory refuses a handle that would climb out of the data root', () => {
        // Not a security boundary — a plugin has `fs` — but a handle is joined onto a path and cached by
        // whatever it turns out to be. A bug must not resolve into someone else's directory.
        expect(lines).toContain('userDirectory traversal: refused');
    });

    test('a plugin written against init(router) still loads, untouched and unaware', () => {
        // The backward-compatibility promise, exercised rather than asserted. JavaScript ignores surplus
        // arguments -- but a promise nobody tests is just a comment.
        //
        // `router is function`, not `object`: express.Router() returns middleware, which is callable. The
        // first draft of this test asserted 'object' and failed, which is the only reason anyone knows.
        expect(lines).toContain('legacy: init called, declared arity 1, router is function');
        expect(lines).toContain('legacy: loaded');
    });
});
