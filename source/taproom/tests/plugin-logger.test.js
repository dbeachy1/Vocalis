import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { bootSillyTavern, makeScratchDirectory } from './util/st-server.js';
import { CANARY } from './fixtures/logger-plugin.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(testDirectory);

/** See `plugin-context.test.js` — the plugins directory is not configurable, so fixtures go in the real one. */
// A scratch directory, not the repository's real `plugins/`. The fork now honours `pluginsPath`, so a
// suite no longer has to share one process-wide directory with every other suite AND with whatever is
// genuinely installed on the machine.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');

const LOGGER_FIXTURE = path.join(testDirectory, 'fixtures', 'logger-plugin.mjs');

/**
 * 🔴 THE LOG FILE IS NOT CONFIGURABLE EITHER — only its NAME is.
 *
 * `server.js:17` passes `directory: serverDirectory`, so the log always lands in the repository root. Only
 * `logging.file` can be steered, via `SILLYTAVERN_LOGGING_FILE`. A unique name keeps this suite from reading a
 * parallel suite's log, or the developer's own `st.log`, and makes the file obvious if a killed run leaves one.
 *
 * 🔴 UNIQUE PER RUN, NOT JUST PER SUITE. The repository root is not scratch space — every run of this suite
 * on this machine writes the same directory, so a name that is only unique among SUITES still collides with
 * a second `npm run test:unit` happening at the same time: one run reads a log the other is writing, and the
 * other's `afterAll` deletes it underneath. Two concurrent runs failed exactly here, on the assertion that
 * the file exists at all. The pid is what makes it this run's file — the same thing `log-canary.test.js`
 * does, for the same reason.
 */
const LOG_BASENAME = `zz-plugin-logger-test-${process.env.JEST_WORKER_ID ?? '1'}-${process.pid}`;
const LOG_PATH = path.join(serverDirectory, `${LOG_BASENAME}.log`);

/** Every file we created, so afterAll can take them out again. */
const created = [];

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
    created.push(target);
}

/**
 * 🔴 §23 — CAN A PLUGIN VOUCH FOR ITS OWN LINE, AND IS THAT THE ONLY THING THAT CHANGED?
 *
 * Two failures are possible here and they point in opposite directions. If `context.logger` does not work, an
 * honest plugin still cannot report that it is functioning, which is the gap §23 was written to close. If it
 * works too well — if it weakened the seam on its way past — then a plugin's careless `console.log` is writing
 * conversation content to `st.log` in plaintext, which is the failure `DESIGN_LOG_HYGIENE.md` exists to prevent.
 *
 * So this suite boots a real server with a plugin that emits one line of each kind, and reads the log file back.
 * Not stdout: `log.*` writes to the file, and asserting on the wrong stream would pass while proving nothing.
 */
describe('§23 — a plugin classifying its own log lines', () => {
    /** @type {string[]} */
    let lines = [];
    /** @type {string} */
    let logContents = '';

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-logger');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const journalPath = path.join(scratch, 'plugin-journal.txt');

        // A log left behind by a killed run would make every assertion below read stale content.
        if (fs.existsSync(LOG_PATH)) {
            fs.unlinkSync(LOG_PATH);
        }

        installPlugin(LOGGER_FIXTURE, 'zz-logger-probe');

        await bootSillyTavern({
            dataRoot,
            configPath,
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                // 🔴 Never let a test git-pull the plugins directory. Auto-update defaults to TRUE.
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'logger-probe',
                ST_PLUGIN_JOURNAL: journalPath,
                SILLYTAVERN_LOGGING_FILE: LOG_BASENAME,
                // ⚠️ THE WHOLE POINT IS THE DEFAULT INSTALL. Debug mode publishes every SENSITIVE line, which
                // would make the suppression assertions below pass for the wrong reason. State it rather than
                // rely on the default staying false.
                SILLYTAVERN_LOGGING_DEBUGMODE: 'false',
            },
        });

        created.push(LOG_PATH);

        lines = fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
            : [];
        logContents = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf-8') : '';
    }, 90_000);

    afterAll(() => {
        for (const target of created) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the plugin ran and the log file exists — otherwise every assertion below is vacuous', () => {
        // A missing log and a perfectly-suppressing log look identical to an `indexOf` that finds nothing.
        // This is the assertion that stops "absent" from being read as "suppressed".
        expect(lines).toContain('logger probe emitted all three lines');
        expect(logContents.length).toBeGreaterThan(0);
    });

    test('the context carries the logger and the vocabulary', () => {
        expect(lines).toContain('logger: object');
        expect(lines).toContain('LogClass: object');
        expect(lines).not.toContain('logger: MISSING');
        expect(lines).toContain('LogClass.NORMAL: 0');
        expect(lines).toContain('LogClass.SENSITIVE: 1');
    });

    test('§23.7.2 — a NORMAL line survives to st.log on a default install', () => {
        // The capability itself. Without this, an operator cannot tell a working plugin from a dead one.
        expect(logContents).toContain(CANARY.NORMAL);
    });

    test('§23.7.1 — bare console.* is still SENSITIVE, and still suppressed', () => {
        // 🔴 THE LOAD-BEARING ASSERTION. If this ever fails, §23 weakened the seam and a careless plugin is
        // writing conversation content to disk in the clear. Write it first, and never relax it.
        expect(logContents).not.toContain(CANARY.CONSOLE);
        expect(logContents).toContain('[SENSITIVE suppressed:');
    });

    test('§23.7.3 — naming SENSITIVE through context.logger suppresses like anything else', () => {
        // The explicit path honours the same gate. Reaching for the logger is not a way around classification.
        expect(logContents).not.toContain(CANARY.SENSITIVE);
    });

    test('§23.7.4 — a plugin cannot reach the writer itself', () => {
        // The context exposes the logger and the vocabulary and nothing else from logger.js. A plugin that
        // could redirect, close or rotate the operator's log would be a worse problem than the one §23 fixed.
        expect(lines).toContain('initLogger reachable: false');
        expect(lines).toContain('shutdownLogger reachable: false');
        expect(lines).toContain('installConsoleSeam reachable: false');
    });
});
