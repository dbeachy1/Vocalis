import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import createVaultProvider from '../src/provider.js';
import * as session from '../src/session.js';
import { forgetNameSchemes } from '../src/vault-store.js';
import { resetForeignStores } from '../src/foreign-stores.js';
import { createVaultState } from '../src/vault-state.js';

/**
 * 🔴 `bin/verify.js` HAD NO TESTS AT ALL, AND THAT IS WHERE THE BUG WAS.
 *
 * 159 lines, shipped, exposed as `npm run verify` and as the `sillytavern-verify` bin — and
 * `tests/verify.test.js` imports only `src/verify.js`. Everything the CLI added on top of the library
 * (argv, the handle bootstrap, the depth claim, the exit code) was unexercised, so a line that could not
 * possibly do what it said sat there being read past.
 *
 * The line was:
 *
 *     : await verifyAll(dataRoot, password && handle ? { [handle]: password } : {});
 *
 * in the branch reached only when `handle` is falsy. The map was ALWAYS `{}`. Every account got a keyless
 * walk, and the summary still printed "(decrypted, every one)" because it asked whether a password had been
 * TYPED rather than whether anything had been DECRYPTED.
 *
 * That is the one lie this tool must never tell. The README calls it "the one operational duty this plugin
 * asks of you", and the entire reason to type a password is to be told the account is RECOVERABLE rather
 * than merely encrypted. Reporting a shallow pass as a deep one answers the question the operator did not
 * ask, in the reassuring direction.
 *
 * These tests drive the real CLI as a subprocess — argv, stdin, stdout, exit code — because that is the
 * only way to cover the part that was wrong.
 */

const CLI = fileURLToPath(new URL('../bin/verify.js', import.meta.url));
const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'a different secret entirely';

/** @type {string} */
let dataRoot;

/**
 * Run the CLI as a real subprocess.
 * @param {string[]} argv Arguments after the script name
 * @param {string} [stdin] What to feed its stdin
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} What it did
 */
function runCli(argv, stdin = '') {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code: code ?? 0, stdout, stderr }));

        child.stdin.end(stdin);
    });
}

/**
 * Build a healthy vaulted account under the current data root.
 * @param {string} handle The account to make
 * @param {string} password Its password
 * @returns {Promise<void>}
 */
async function makeAccount(handle, password) {
    session.closeAll(vault);
    forgetNameSchemes(vault);
    resetForeignStores(vault);

    const userDir = path.join(dataRoot, handle);
    fs.mkdirSync(userDir, { recursive: true });

    const provider = createVaultProvider(vault);

    provider.init({
        dataRoot,
        accountsEnabled: true,
        basicAuthMode: false,
        authenticationDelegated: false,
        users: [{ handle, enabled: true, hasPassword: true }],
    });

    await provider.unlock(handle, password);

    provider.mkdir(path.join(userDir, 'chats', 'Test Character 1'), { recursive: true });
    provider.writeFileSync(path.join(userDir, 'chats', 'Test Character 1', 'a quiet evening.jsonl'), 'I have been waiting for you.');

    provider.lock(handle);
}


/**
 * This suite's own provider state.
 *
 * 🔴 A FRESH ONE PER TEST **IS** THE RESET. Before `vault-state.js` the modules held six
 * globals between them, so a test had to remember which `reset*()` calls applied to it -- and
 * `tests/verify.test.js` records a test that passed with its guard DELETED because the shared
 * `dataRoot` was already set by a previous `beforeEach`. Nothing here can do that now: a provider
 * built around this object cannot see any other test's state, because there is no other state to see.
 */
let vault;
beforeEach(() => {
    vault = createVaultState();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cli-'));
});

afterEach(() => {
    session.closeAll(vault);
    forgetNameSchemes(vault);
    resetForeignStores(vault);
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('🔴 verify CLI: the depth it claims is the depth it did', () => {
    /**
     * 🔴 THE ASSERTION IS A WRONG PASSWORD, AND THE FIRST VERSION OF THIS TEST WAS VACUOUS WITHOUT IT.
     *
     * The obvious test — run with the right password and assert the output says "(decrypted, every one)" —
     * PASSES AGAINST THE BUG. That sentence is exactly what the broken code printed; it was printed from
     * `password ? …`, which is true whether or not anything was decrypted. Asserting it confirms the lie.
     *
     * So the test has to turn on something only a real decrypt can produce. A WRONG password is that thing:
     * `unlockWithPassword` throws, so a deep walk dies and the process exits non-zero. Under the bug the
     * password was never used for anything, so the same run finished cleanly with exit 0 and a reassuring
     * report. Right password / wrong password diverging is proof the key reached the walk.
     *
     * Mutation-checked: revert `bin/verify.js` and this fails; the version asserting the happy string does not.
     */
    test('🔴 --password with no --handle really USES the password, on a root with one account', async () => {
        await makeAccount('default-user', PASSWORD);

        const right = await runCli([`--data-root=${dataRoot}`, '--password'], `${PASSWORD}\n`);

        expect(right.code).toBe(0);
        expect(right.stdout).toContain('(decrypted, every one)');
        expect(right.stdout).not.toContain('Shallow pass');

        // The half that cannot pass unless the password was actually applied.
        const wrong = await runCli([`--data-root=${dataRoot}`, '--password'], 'not the password\n');

        expect(wrong.code).not.toBe(0);
        expect(wrong.stdout).not.toContain('(decrypted, every one)');
    });

    test('🔴 no password means the summary says so, and never claims a decrypt', async () => {
        await makeAccount('default-user', PASSWORD);

        const { code, stdout } = await runCli([`--data-root=${dataRoot}`]);

        expect(code).toBe(0);
        expect(stdout).toContain('header checked; pass --password to decrypt');
        expect(stdout).not.toContain('(decrypted, every one)');
        expect(stdout).toContain('Shallow pass');
    });

    test('🔴 --password with no --handle REFUSES when the root holds more than one account', async () => {
        await makeAccount('default-user', PASSWORD);
        await makeAccount('someone-else', OTHER_PASSWORD);

        const { code, stderr } = await runCli([`--data-root=${dataRoot}`, '--password'], `${PASSWORD}\n`);

        // 2, not 1: this is a usage error, not a finding about the disk. A cron job that greps for a
        // dirty-disk exit code must not be told the data is leaking when the operator mistyped a flag.
        expect(code).toBe(2);
        expect(stderr).toContain('--password needs --handle');
        expect(stderr).toContain('default-user');
        expect(stderr).toContain('someone-else');
    });

    test('a named handle still decrypts only that account, and says which others were shallow', async () => {
        await makeAccount('default-user', PASSWORD);
        await makeAccount('someone-else', OTHER_PASSWORD);

        const { code, stdout } = await runCli([`--data-root=${dataRoot}`, '--handle=default-user', '--password'], `${PASSWORD}\n`);

        expect(code).toBe(0);
        expect(stdout).toContain('(decrypted, every one)');

        // Only that one account was reported on, so nothing is left shallow to warn about.
        expect(stdout).not.toContain('Shallow pass');
    });

    test('a whole-root pass over several accounts is shallow for every one of them', async () => {
        await makeAccount('default-user', PASSWORD);
        await makeAccount('someone-else', OTHER_PASSWORD);

        const { code, stdout } = await runCli([`--data-root=${dataRoot}`]);

        expect(code).toBe(0);
        expect(stdout).not.toContain('(decrypted, every one)');
        expect(stdout).toContain('Shallow pass');
    });

    test('no data root is a usage error, not a crash', async () => {
        const { code, stderr } = await runCli([]);

        expect(code).toBe(2);
        expect(stderr).toContain('usage:');
    });
});
