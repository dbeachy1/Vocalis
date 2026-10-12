import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const KEYED_PROVIDER = path.join(testDirectory, 'fixtures', 'keyed-provider.js');

const PASSWORD = 'the-password';
const RECOVERY_KEY = 'TEST_ONLY_RECOVERY_KEY_FIXTURE_0000000000000001';

/**
 * The avatar we plant on the disk. Its bytes are the evidence: if they ever appear in an anonymous
 * response, that response leaked a file out of an encrypted account.
 *
 * 🔴 PLANTING IT IS THE WHOLE TEST. `getUserAvatar` returns the default when the user has no avatar of
 * their own — so against an account with no avatar, EVERY assertion below passes with the guard removed.
 * That is the vacuous green this project has produced five of: "no leak found" is equally true of a
 * system that cannot leak and a system that has nothing to leak. Assert the data EXISTS first, then
 * assert what the anonymous caller does not get.
 */
const AVATAR_BYTES = crypto.randomBytes(64);
const AVATAR_BASE64 = AVATAR_BYTES.toString('base64');

/**
 * The placeholder an anonymous caller gets instead of a real avatar.
 *
 * 🔴 THIS USED TO BE THE LITERAL `/img/default-user.png`, WHICH IS A FILE THAT HAS NEVER EXISTED. The
 * constant in `src/users.js` had the words transposed, this test copied the typo out of it, and both
 * agreed with each other for as long as nobody looked in `public/img/`. Every account without its own
 * avatar — which on the login screen is most of them — rendered a broken image and logged a 403, while
 * this suite stayed green.
 *
 * So the path is asserted to EXIST ON DISK below. A test that pins a filename without checking anything
 * ships it is pinning a string, not a behaviour, and this suite has now made that mistake once.
 */
const PLACEHOLDER_AVATAR = '/img/user-default.png';

/**
 * Give the default user a real password, so the provider has something to key itself from.
 * @param {string} dataRoot The data root
 * @returns {Promise<void>}
 */
async function setPassword(dataRoot) {
    const store = nodePersist.create({ dir: path.join(dataRoot, '_storage'), expiredInterval: 0 /* no stray timer — see setPassword in integration/harness.mjs */ });
    await store.init();

    const user = await store.getItem('user:default-user');
    const salt = crypto.randomBytes(16).toString('base64');

    user.password = crypto.scryptSync(PASSWORD.normalize(), salt, 64).toString('base64');
    user.salt = salt;

    await store.setItem('user:default-user', user);
}

/**
 * POST some JSON, optionally as a logged-in user.
 * @param {string} base Base URL
 * @param {string} route Route
 * @param {any} body Body
 * @param {string} [cookie] Session cookie, if we are pretending to be someone
 * @returns {Promise<{status: number, body: any, cookie: string}>} The response
 */
async function post(base, route, body, cookie) {
    const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
    });

    const setCookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const text = await response.text();

    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }

    return { status: response.status, body: parsed, cookie: setCookie };
}

/**
 * GET some JSON as a logged-in user.
 * @param {string} base Base URL
 * @param {string} route Route
 * @param {string} cookie Session cookie
 * @returns {Promise<{status: number, body: any}>} The response
 */
async function get(base, route, cookie) {
    const response = await fetch(`${base}${route}`, { headers: { Cookie: cookie } });
    const text = await response.text();

    // A refusal is not JSON — express sends the bare word "Forbidden" — and the refusal is half of what
    // these tests are here to observe. Parsing optimistically would turn the RIGHT answer into a crash.
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }

    return { status: response.status, body: parsed };
}

/**
 * 🔴 THE LOGIN SCREEN IS NOT AUTHENTICATED, AND IT WAS READING USER DATA THROUGH THE PROVIDER.
 *
 * `POST /api/users/list` is mounted ABOVE `requireLoginMiddleware`, by design — it is what draws the
 * account picker on the login page. It called `getUserAvatar()`, which reads the user's avatar through
 * the storage funnel and swallows every error.
 *
 * Against a plain filesystem that is a deliberate upstream trade: the avatar is a picture the user chose
 * to represent themselves on a login screen, it is in the clear on disk anyway, and showing it is the
 * point. Against a PROVIDER it is two separate bugs, and the second is the one that hid:
 *
 *   1. When storage is unavailable, the read throws and the catch returns the default avatar. Harmless.
 *   2. When storage is AVAILABLE — the user is logged in in some other session, so the key is in the
 *      server's memory — **the read succeeds**, and an anonymous caller is handed that user's own file.
 *
 * The leak matters. The ORACLE matters more: the response *differs by storage state*, so anybody on the
 * network can poll the public user list and learn exactly when a given person is logged in. Encrypting
 * the avatar does not close that. An unlocked server answers it from RAM, cheerfully, with the correct
 * key in hand — a cipher and an auth gate close different holes, and it is very easy to ship the first
 * believing you closed the second.
 *
 * So the fix is not "encrypt harder" and it is not "return the default when the read fails". It is that
 * the answer **must not depend on provider state at all**: if a provider owns the user, the login screen
 * gets the default avatar, always, whatever the provider could do for us at this instant.
 */
describe('🔴 the login screen must not answer questions about an encrypted account', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;

    beforeAll(async () => {
        scratch = makeScratchDirectory('login-oracle');
        dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);

        // Plant the avatar. See AVATAR_BYTES — without this the whole suite is decorative.
        const userDirectory = path.join(dataRoot, 'default-user', 'user');
        fs.mkdirSync(userDirectory, { recursive: true });
        fs.writeFileSync(path.join(userDirectory, 'avatar.png'), AVATAR_BYTES);

        installStorageProvider(providersPath, KEYED_PROVIDER);

        server = await startSillyTavern({
            dataRoot,
            configPath,
            storageProvidersPath: providersPath,
            enableUserAccounts: true,
            providerEnv: {
                ST_KEYED_STATE: path.join(scratch, 'vault-keys.json'),
                ST_KEYED_HANDLE: 'default-user',
                ST_KEYED_PASSWORD: PASSWORD,
                ST_KEYED_RECOVERY_KEY: RECOVERY_KEY,
            },
        });

        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);
        base = `http://127.0.0.1:${server.port}`;
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    test('the placeholder avatar is a file that actually ships', () => {
        // The assertion that would have caught the transposed name. Both the constant and this suite said
        // `/img/default-user.png`; `public/img/` has only ever held `user-default.png`.
        const shipped = path.join(path.dirname(testDirectory), 'public', PLACEHOLDER_AVATAR.replace(/^\//, ''));
        expect(fs.existsSync(shipped)).toBe(true);
    });

    test('locked: the anonymous user list does not carry the avatar', async () => {
        const { status, body } = await post(base, '/api/users/list', {});

        expect(status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0].handle).toBe('default-user');
        expect(body[0].avatar).toBe(PLACEHOLDER_AVATAR);
        expect(JSON.stringify(body)).not.toContain(AVATAR_BASE64);
    });

    // 🔴 THE ONE THAT MATTERS. Everything above passes with the guard removed, because a locked provider
    // refuses the read anyway and the catch hands back the default. This is the test the bug fails.
    test('UNLOCKED: the server can decrypt the avatar right now — and still will not give it to an anonymous caller', async () => {
        const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
        expect(login.status).toBe(200);
        expect(login.cookie).toBeTruthy();

        // 🔑 PROVE THE SERVER CAN SERVE IT. The key is in RAM, the file is on the disk, and an
        // AUTHENTICATED request gets the real bytes back. Without this assertion the test below would be
        // satisfied by a server that had simply broken, or by an account with no avatar at all.
        const me = await get(base, '/api/users/me', login.cookie);
        expect(me.status).toBe(200);
        expect(me.body.avatar).toContain(AVATAR_BASE64);

        // ...and now ask ANONYMOUSLY, in that same unlocked window. No cookie. The provider would happily
        // decrypt this file — it just did. The guard is the only thing standing between an unauthenticated
        // caller and a file out of an encrypted account.
        const anonymous = await post(base, '/api/users/list', {});

        expect(anonymous.status).toBe(200);
        expect(anonymous.body[0].avatar).toBe(PLACEHOLDER_AVATAR);
        expect(JSON.stringify(anonymous.body)).not.toContain(AVATAR_BASE64);
    });

    // The oracle, stated as the property it really is: locked and unlocked must be INDISTINGUISHABLE to
    // someone who is not logged in. If these two responses ever differ, the difference is the side channel
    // — whatever it happens to be carrying today.
    test('the anonymous answer is byte-identical whether the vault is locked or unlocked', async () => {
        const unlocked = await post(base, '/api/users/list', {});

        const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
        await post(base, '/api/users/logout', {}, login.cookie);

        const locked = await post(base, '/api/users/list', {});

        expect(JSON.stringify(locked.body)).toBe(JSON.stringify(unlocked.body));
    });

    /**
     * 🔴 AND THE DOOR THIS ONE WAS FOUND THROUGH.
     *
     * The test above was written to compare a locked window with an unlocked one — and it PASSED with the
     * avatar guard deliberately removed, which it had no business doing. The reason was not a bad test.
     * It was that **there was no locked window**: `storage.lock()` was exported, implemented, and called
     * by nobody at all. Logging out dropped the session cookie and left the data key sitting in this
     * process's memory until something killed the process.
     *
     * The plugin's own README promised "log out, restart, or crash → locked". Restart and crash were true
     * for free — the key is RAM-only. Log out was simply not implemented, and nothing anywhere said so.
     */
    test('logging out LOCKS the vault: a replayed session cookie is refused afterwards', async () => {
        const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
        expect(login.status).toBe(200);

        // The vault is open, and this cookie can read the account's own files.
        const before = await get(base, '/api/users/me', login.cookie);
        expect(before.status).toBe(200);
        expect(before.body.avatar).toContain(AVATAR_BASE64);

        await post(base, '/api/users/logout', {}, login.cookie);

        // Public login branding remains available while the stale session is rejected. Keep this allowlist
        // exact: user-owned avatar and account routes still require an unlocked authenticated session.
        for (const asset of ['/favicon.ico', '/img/logo.png', '/img/apple-icon-144x144.png']) {
            const response = await fetch(`${base}${asset}`, { headers: { Cookie: login.cookie } });
            expect(response.status).toBe(200);

            const shippedPath = path.join(path.dirname(testDirectory), 'public', asset.slice(1));
            expect(Buffer.from(await response.arrayBuffer())).toEqual(fs.readFileSync(shippedPath));
        }

        // 🔑 Replay the SAME cookie. It is still a validly-signed session naming this handle — logout
        // cleared it in the *response*, but we kept our copy, and nothing about it has expired. So the
        // session check will wave it straight through. The ONLY thing left that can refuse it is the
        // storage being genuinely locked.
        //
        // Without the lock, this comes back 200 with the avatar attached: proof that "logged out" was
        // cosmetic and the key was still in memory.
        const after = await get(base, '/api/users/me', login.cookie);
        expect(after.status).toBe(403);
    });
});
