import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect } from '@jest/globals';

import * as testing from '../src/testing.js';
import createProvider from '../src/index.js';
import { createVaultState } from '../src/vault-state.js';

/**
 * 🔴 THE INVARIANT IS NOW THE OPPOSITE OF WHAT IT WAS, AND THAT IS THE WHOLE OF PART 3.
 *
 * This file used to assert that `src/testing.js` re-exported **every** reset hook in `src/`, because there
 * were six module-level globals and a test had to know which subset to clear. The list existed so it could
 * not fall behind the state.
 *
 * There is almost nothing left to reset. State belongs to a provider, and the way to get a clean one is to
 * build one. So the test now guards the other direction: **no new process-global mutable state may creep
 * back in.** A `reset*()` that takes no arguments is the signature of exactly that — a module-level
 * variable somebody needs to put back — and there is one left, deliberately.
 */
describe('the testing surface, and the globals that are gone', () => {
    /**
     * Nullary reset-shaped exports found by reading `src/`.
     *
     * Nullary is the tell. `session.closeAll(vault)` clears a provider's keys; `resetLogging()` clears
     * something belonging to the process. Taking no arguments means "there is only one of these".
     * @returns {string[]} Their names, with the file they live in
     */
    const globalResetHooks = () => {
        // 🔴 `fileURLToPath`, NOT `new URL(...).pathname.slice(1)`. That idiom is Windows-only: the pathname
        // of a `file://` URL is `/C:/x` there, so dropping the first character gives `C:/x` and looks
        // correct -- but on POSIX it is `/home/runner/x`, and the same slice yields `home/runner/x`, a
        // relative path that does not exist. `readdirSync` then throws ENOENT and this guard is DEAD on
        // every Linux machine, including the box this deploys to.
        //
        // ⚠️ AND DO NOT "FIX" IT WITH A try/catch. Swallowing the error converts a guard that crashes into a
        // guard that permanently passes, which is strictly worse: this test exists to fail when new
        // process-global state creeps in, and one that can no longer fail is not a test.
        //
        // Two sibling guards in `log-classification.test.js` had the identical bug and were corrected; this
        // third one was missed, and CI caught it on its first ever run, on Ubuntu, while Windows went green.
        const root = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
        /** @type {string[]} */
        const found = [];

        /** @param {string} directory @returns {void} */
        const walk = (directory) => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const full = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    walk(full);
                    continue;
                }

                if (!entry.name.endsWith('.js')) {
                    continue;
                }

                const code = fs.readFileSync(full, 'utf-8');

                for (const match of code.matchAll(/^export function ((?:reset|forget|close)[A-Za-z]*)\s*\(\s*\)/gm)) {
                    found.push(`${entry.name}:${match[1]}`);
                }
            }
        };

        walk(root);
        return found.sort();
    };

    test('🔴 exactly one process-global reset remains, and it is the logger', () => {
        // 🔴 IF THIS FAILS WITH A NEW NAME, SOMEBODY ADDED MODULE-LEVEL MUTABLE STATE. That is the thing
        // Part 3 removed, and the reason it was removed is on the record in `tests/verify.test.js`: a test
        // passed with its guard DELETED, because a previous `beforeEach` had already set a shared global.
        //
        // The logger is the one honest exception. The fork hands ONE logger to the process, at boot, in the
        // storage-provider context — it is a property of the process, not of a provider, and a second
        // provider does not get a second logger to adopt.
        expect(globalResetHooks()).toEqual(['logging.js:resetLogging']);
    });

    test('src/testing.js exports the logger reset and the key wipe, and nothing else', () => {
        expect(Object.keys(testing).sort()).toEqual(['closeAll', 'resetLogging']);
    });

    test('resetLogging is idempotent from a cold start', () => {
        expect(() => testing.resetLogging()).not.toThrow();
        expect(() => testing.resetLogging()).not.toThrow();
    });

    /**
     * 🔴 THE CLAIM PART 3 ACTUALLY MAKES, TESTED DIRECTLY.
     *
     * Not "the code is tidier". Two providers in one process are two providers — different data roots,
     * different key tables, and neither can see the other. Before this, `createVaultProvider()` was a
     * factory in name only: every one of them shared six module-level globals, including the keys.
     */
    test('🔴 two providers in one process share NOTHING', async () => {
        const os = await import('node:os');

        const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-a-'));
        const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-b-'));

        const stateA = createVaultState();
        const stateB = createVaultState();

        try {
            fs.mkdirSync(path.join(rootA, 'user-one'));
            fs.mkdirSync(path.join(rootB, 'user-two'));

            const context = (dataRoot, handle) => ({
                dataRoot,
                accountsEnabled: true,
                basicAuthMode: false,
                authenticationDelegated: false,
                users: [{ handle, enabled: true, hasPassword: true }],
            });

            const a = createProvider(stateA);
            const b = createProvider(stateB);

            a.init(context(rootA, 'user-one'));
            b.init(context(rootB, 'user-two'));

            // Each owns its own tree and disclaims the other's. Under a shared `dataRoot` global, the
            // second `init` would have silently redirected the first provider.
            expect(a.owns(path.join(rootA, 'user-one', 'chats'))).toBe(true);
            expect(a.owns(path.join(rootB, 'user-two', 'chats'))).toBe(false);
            expect(b.owns(path.join(rootB, 'user-two', 'chats'))).toBe(true);
            expect(b.owns(path.join(rootA, 'user-one', 'chats'))).toBe(false);

            // 🔴 And the keys do not cross. Unlocking in A must not make B ready.
            await a.unlock('user-one', 'a password for user-one');

            expect(a.isReady('user-one')).toBe(true);
            expect(b.isReady('user-one')).toBe(false);
            expect(stateB.sessions.size).toBe(0);

            // Locking A leaves nothing of A's behind, and never touched B.
            a.lock('user-one');

            expect(stateA.sessions.size).toBe(0);
            expect(stateB.sessions.size).toBe(0);
        } finally {
            testing.closeAll(stateA);
            testing.closeAll(stateB);
            fs.rmSync(rootA, { recursive: true, force: true });
            fs.rmSync(rootB, { recursive: true, force: true });
        }
    });
});
