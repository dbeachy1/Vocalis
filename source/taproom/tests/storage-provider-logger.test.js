import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { bootSillyTavern, makeScratchDirectory, installStorageProvider } from './util/st-server.js';
import { CANARY } from './fixtures/logger-provider.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(testDirectory);

const LOGGER_FIXTURE = path.join(testDirectory, 'fixtures', 'logger-provider.js');

/**
 * 🔴 THE LOG FILE IS NOT CONFIGURABLE — only its NAME is.
 *
 * `server.js` passes `directory: serverDirectory`, so the log always lands in the repository root
 * regardless of `--dataRoot`. Only `logging.file` can be steered, via `SILLYTAVERN_LOGGING_FILE`. A unique
 * name keeps this suite from reading a parallel suite's log, or the developer's own `st.log`, and makes the
 * file obvious if a killed run leaves one behind.
 *
 * 🔴 UNIQUE PER RUN, NOT JUST PER SUITE. The repository root is not scratch space — every run of this suite
 * on this machine writes the same directory, so a name that is only unique among SUITES still collides with
 * a second `npm run test:unit` happening at the same time: one run reads a log the other is writing, and the
 * other's `afterAll` deletes it underneath. Two concurrent runs failed exactly here, on the assertion that
 * the file exists at all. The pid is what makes it this run's file — the same thing `log-canary.test.js`
 * does, for the same reason.
 */
const LOG_BASENAME = `zz-provider-logger-test-${process.env.JEST_WORKER_ID ?? '1'}-${process.pid}`;
const LOG_PATH = path.join(serverDirectory, `${LOG_BASENAME}.log`);

/** Every file we created, so afterAll can take them out again. */
const created = [];

/**
 * 🔴 CAN A STORAGE PROVIDER VOUCH FOR ITS OWN LOG LINE, AND IS THAT THE ONLY THING THAT CHANGED?
 *
 * `plugin-logger.test.js` asks this of ordinary plugins. It does not cover storage providers, which load
 * through an entirely different path — and that gap was real: `storage-provider-loader.js` handed a provider
 * only the environment, with no `logger` and no `LogClass`, while `installConsoleSeam()` had already
 * rewritten every `console.*` to SENSITIVE. The result was a provider that could not make itself heard on
 * any default install, for the one condition it most needs to report: that a user's data is now
 * unrecoverable.
 *
 * Two failures are possible and they point in opposite directions. If the channel does not work, an honest
 * provider still cannot report that it is functioning. If it works too well — if it weakened the seam on its
 * way past — then a provider's careless `console.log` is writing user data to `st.log` in plaintext, which is
 * the failure `DESIGN_LOG_HYGIENE.md` exists to prevent.
 *
 * So this suite boots a real server with a provider that emits one line of each kind, and reads the log file
 * back. Not stdout: `log.*` writes to the file, and asserting on the wrong stream would pass while proving
 * nothing.
 */
describe('a storage provider classifying its own log lines', () => {
    /** @type {string[]} */
    let lines = [];
    /** @type {string} */
    let logContents = '';

    beforeAll(async () => {
        const scratch = makeScratchDirectory('provider-logger');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');
        const journalPath = path.join(scratch, 'provider-journal.txt');

        // A log left behind by a killed run would make every assertion below read stale content.
        if (fs.existsSync(LOG_PATH)) {
            fs.unlinkSync(LOG_PATH);
        }

        installStorageProvider(providersPath, LOGGER_FIXTURE);

        await bootSillyTavern({
            dataRoot,
            configPath,
            storageProvidersPath: providersPath,
            providerEnv: {
                ST_PROVIDER_LOG_JOURNAL: journalPath,
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
    }, 240_000);

    afterAll(() => {
        for (const target of created) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the provider ran and the log file exists — otherwise every assertion below is vacuous', () => {
        // A missing log and a perfectly-suppressing log look identical to an `indexOf` that finds nothing.
        // This is the assertion that stops "absent" from being read as "suppressed".
        expect(lines).toContain('logger provider emitted all three lines');
        expect(logContents.length).toBeGreaterThan(0);
    });

    test('the context carries the logger and the vocabulary', () => {
        // The regression this suite was written for: both of these were absent for storage providers.
        expect(lines).toContain('logger: object');
        expect(lines).toContain('LogClass: object');
        expect(lines).not.toContain('logger: MISSING');
        expect(lines).toContain('LogClass.NORMAL: 0');
        expect(lines).toContain('LogClass.SENSITIVE: 1');
    });

    test('the environment still arrives intact alongside the channel', () => {
        // Adding the channel must not displace the account facts a provider refuses a configuration on.
        expect(lines).toContain('dataRoot: true');
        expect(lines).toContain('accountsEnabled: boolean');
        expect(lines).toContain('users: true');
    });

    test('a NORMAL line from a provider survives to st.log on a default install', () => {
        // The capability itself, and the reason the work was done: without this, Vault's "this account is
        // UNRECOVERABLE" warning reaches the operator as a bare suppression stub and nothing else.
        expect(logContents).toContain(CANARY.NORMAL);
    });

    test('bare console.* from a provider is still SENSITIVE, and still suppressed', () => {
        // 🔴 THE LOAD-BEARING ASSERTION. If this ever fails, the channel weakened the seam and a careless
        // provider is writing user data to disk in the clear. Never relax it.
        expect(logContents).not.toContain(CANARY.CONSOLE);
        expect(logContents).toContain('[SENSITIVE suppressed:');
    });

    test('naming SENSITIVE through context.logger suppresses like anything else', () => {
        // The explicit path honours the same gate. Reaching for the logger is not a way around
        // classification — which matters most here, because the provider's other half of a split warning
        // is exactly this call and it carries the handle.
        expect(logContents).not.toContain(CANARY.SENSITIVE);
    });

    test('a provider cannot reach the writer itself', () => {
        // The context exposes the logger and the vocabulary and nothing else from logger.js. A provider that
        // could redirect, close or rotate the operator's log would be a worse problem than the one the
        // channel fixed.
        expect(lines).toContain('initLogger reachable: false');
        expect(lines).toContain('shutdownLogger reachable: false');
        expect(lines).toContain('installConsoleSeam reachable: false');
    });
});
