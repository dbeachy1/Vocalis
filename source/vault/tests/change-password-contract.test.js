import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawn } from 'node:child_process';

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';

jest.setTimeout(600_000);

/**
 * Verify the full password-change contract: the persisted account hash is re-keyed, the new password works
 * after logout, and the old password no longer authenticates.
 */

const FORK = process.env.ST_FORK_PATH ?? path.resolve(path.dirname(process.cwd()), 'taproom');
const PLUGIN = process.cwd();
const HANDLE = 'default-user';

const OLD_PASSWORD = 'TEST-OLD-PASSWORD-1234567890';
const NEW_PASSWORD = 'TEST-OLD-PASSWORD-1234567890.'; // The new value appends one character to the old value.

const forkIsPresent = fs.existsSync(path.join(FORK, 'server.js'));
const describeIfFork = forkIsPresent ? describe : describe.skip;

/** @returns {Promise<number>} A free port */
const freePort = () => new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
});

describeIfFork('password change rekeys the account', () => {
    /** @type {string} */ let scratch;
    /** @type {string} */ let dataRoot;
    /** @type {string} */ let providers;
    /** @type {string} */ let configPath;
    /** @type {any} */ let server;

    /**
     * Boot SillyTavern with the real plugin behind it.
     * @param {boolean} withProvider Whether to install the provider
     * @returns {Promise<any>} The running server
     */
    async function boot(withProvider) {
        const port = await freePort();
        const env = {
            ...process.env,
            SILLYTAVERN_DATAROOT: dataRoot,
            SILLYTAVERN_LISTEN: 'false',
            SILLYTAVERN_BROWSERLAUNCH_ENABLED: 'false',
            SILLYTAVERN_ENABLESERVERPLUGINS: 'false',
            NODE_ENV: 'test',
        };

        if (withProvider) {
            env.SILLYTAVERN_STORAGEPROVIDERSPATH = providers;
            env.SILLYTAVERN_ENABLEUSERACCOUNTS = 'true';
        }

        const child = spawn(process.execPath, [
            'server.js', `--dataRoot=${dataRoot}`, `--configPath=${configPath}`,
            `--port=${port}`, '--listen=false', '--autorun=false', '--disableCsrf',
        ], { cwd: FORK, env, stdio: ['ignore', 'pipe', 'pipe'] });

        let output = '';
        child.stdout.on('data', chunk => output += chunk);
        child.stderr.on('data', chunk => output += chunk);

        // A fresh DATA_ROOT has a cold webpack cache, so allow up to four minutes for the first boot.
        let up = false;
        for (let i = 0; i < 480; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (child.exitCode !== null) break;
            try {
                await fetch(`http://127.0.0.1:${port}/`);
                up = true;
                break;
            } catch { /* not listening yet */ }
        }

        // A failed boot must stop its child because callers throw before reaching `stop()`.
        if (!up) {
            child.kill();
        }

        return {
            port, up,
            output: () => output,
            // Clear the fallback timer when the child exits; otherwise Jest's worker can remain alive.
            stop: () => new Promise(r => {
                const fallback = setTimeout(r, 3000);

                child.on('exit', () => {
                    clearTimeout(fallback);
                    r();
                });

                child.kill();
            }),
        };
    }

    /**
     * POST some JSON, exactly as the browser does.
     * @param {string} route The route
     * @param {any} body The body
     * @param {string} [auth] A session cookie
     * @returns {Promise<{status: number, body: any, cookie: string}>} The response
     */
    async function post(route, body, auth) {
        const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: auth } : {}) },
            body: JSON.stringify(body),
        });

        const text = await response.text();
        let parsed;

        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = text;
        }

        return {
            status: response.status,
            body: parsed,
            cookie: response.headers.getSetCookie().map(c => c.split(';')[0]).join('; '),
        };
    }

    /**
     * The password hash SillyTavern has on file, straight off the disk.
     *
     * Read the persisted credential so the test verifies the stored hash, not only the HTTP response.
     * @returns {Promise<{password: string, salt: string}>} The stored credential
     */
    async function storedCredential() {
        const { default: nodePersist } = await import('node-persist');
        const store = nodePersist.create({ dir: path.join(dataRoot, '_storage') });
        await store.init();
        const user = await store.getItem(`user:${HANDLE}`);
        return { password: user.password, salt: user.salt };
    }

    beforeAll(async () => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'st-change-password-'));
        dataRoot = path.join(scratch, 'data');
        providers = path.join(scratch, 'storage-providers');
        configPath = path.join(scratch, 'config.yaml');

        const seed = await boot(false);
        if (!seed.up) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        const { default: nodePersist } = await import('node-persist');
        const store = nodePersist.create({ dir: path.join(dataRoot, '_storage') });
        await store.init();
        const user = await store.getItem(`user:${HANDLE}`);
        const salt = crypto.randomBytes(16).toString('base64');
        user.password = crypto.scryptSync(OLD_PASSWORD.normalize(), salt, 64).toString('base64');
        user.salt = salt;
        await store.setItem(`user:${HANDLE}`, user);

        // The plugin refuses to encrypt an account that already holds data, so empty it before the first
        // encrypted boot. SillyTavern re-seeds its defaults after unlock, through the provider.
        fs.rmSync(path.join(dataRoot, HANDLE), { recursive: true, force: true });

        fs.mkdirSync(providers, { recursive: true });
        fs.cpSync(PLUGIN, path.join(providers, 'vault'), {
            recursive: true,
            filter: src => !src.includes('node_modules') && !src.includes(`${path.sep}.git`),
        });

        server = await boot(true);
        if (!server.up) throw new Error(`Encrypted boot failed.\n\n${server.output()}`);
    });

    afterAll(async () => {
        await server?.stop();
        // Brief retries allow Windows to release handles held by the stopped child.
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    test('🔑 the exact sequence: change it, log out, log back in with the NEW one', async () => {
        // 1. Log in with the old password. This creates the vault.
        const first = await post('/api/users/login', { handle: HANDLE, password: OLD_PASSWORD });
        expect(first.status).toBe(200);

        const before = await storedCredential();

        // 2. Change the password, exactly as the dialog does: handle, newPassword, oldPassword.
        const changed = await post('/api/users/change-password', {
            handle: HANDLE,
            oldPassword: OLD_PASSWORD,
            newPassword: NEW_PASSWORD,
        }, first.cookie);

        expect(changed.status).toBe(204);

        // Verify the persisted hash; a successful response alone does not prove the credential changed.
        const after = await storedCredential();
        expect(after.password).not.toBe(before.password);
        expect(after.password).toBe(crypto.scryptSync(NEW_PASSWORD.normalize(), after.salt, 64).toString('base64'));

        // 3. Log out. This locks the vault.
        // The password change bumps the account version, so the response re-issues the session cookie. A
        // browser carries that automatically; a test must too, or the next request is a stale session.
        const session = changed.cookie || first.cookie;
        const out = await post('/api/users/logout', {}, session);
        expect(out.status).toBe(204);

        // 4. Confirm the replacement password works after logout.
        const withNew = await post('/api/users/login', { handle: HANDLE, password: NEW_PASSWORD });
        expect(withNew.status).toBe(200);

        // 5. 🔴 AND THE OLD PASSWORD MUST BE DEAD. Asserting only step 4 would pass for a change that ADDED
        //    a wrap without retiring the old one — and an old password that still opens the account for ever
        //    is not a password change, it is a second key.
        const withOld = await post('/api/users/login', { handle: HANDLE, password: OLD_PASSWORD });
        expect(withOld.status).toBe(403);
    });
});
