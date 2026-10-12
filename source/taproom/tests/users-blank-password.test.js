import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import accountStorage from 'node-persist';
import express from 'express';

import { setConfigFilePath } from '../src/util.js';
import { registerStorageProvider, unregisterStorageProvider } from '../src/storage.js';
import { makeScratchDirectory } from './util/st-server.js';

/**
 * A BLANK PASSWORD MUST BE REFUSED ON EVERY ROUTE THAT WRITES ONE (Taproom, October 11, 2026, pre-release audit).
 *
 * Admin Panel > New User offered "[ No password ]" and the server stored `password: ''` for an enabled account. Every
 * container start runs `provision-owner.mjs --check`, and the Vault provider checks too; both refuse to start with an
 * enabled passwordless account, and `restart: unless-stopped` turns that into a loop the page cannot undo. These
 * tests drive the real routers (not stubs of them) against a real account store, with a provider registered, because
 * "a provider is registered" is the fact the refusal is gated on (`passwordIsRequired` in `src/users.js`).
 *
 * The routes that write a password: admin create, admin enable (a disabled passwordless account becomes an enabled
 * one), change-password (admin and own), recover-step2 (the console-code reset). recover-with-key already demands
 * a new password and is not repeated here.
 */

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const REFUSAL_PATTERN = /A password is required/;

/** @type {typeof import('../src/users.js')} */
let users;
/** @type {{router: import('express').Router}} */
let adminRoutes;
/** @type {{router: import('express').Router}} */
let privateRoutes;
/** @type {{router: import('express').Router}} */
let publicRoutes;
/** @type {http.Server} */
let server;
/** @type {string} */
let base;
/** @type {string} */
let root;

/**
 * The smallest object `registerStorageProvider` accepts. Nothing here stores or encrypts anything; the routes under
 * test only ask whether a provider exists, whether it owns a user, and whether it lets a re-key through.
 * @returns {object} A provider
 */
function makeProvider() {
    const noop = async () => { };
    return {
        id: 'blank-password-fixture',
        owns: () => false,
        ownsUser: () => false,
        init: noop,
        isReady: () => true,
        readFile: noop,
        readFileSync: () => '',
        createReadStream: noop,
        exists: () => false,
        stat: noop,
        readdir: () => [],
        writeFile: noop,
        writeFileSync: noop,
        createWriteStream: noop,
        mkdir: noop,
        unlink: noop,
        rename: noop,
        copyFile: noop,
        cp: noop,
        rm: noop,
        sendFile: noop,
        unlock: noop,
        lock: noop,
        rekey: noop,
    };
}

/**
 * POST JSON as a given account.
 * @param {string} route Route under the mounted prefix
 * @param {object} body JSON body
 * @param {string} [as] Handle of the account making the request
 * @returns {Promise<{status: number, body: any}>} The response
 */
async function post(route, body, as = 'admin') {
    const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-user': as },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }
    return { status: response.status, body: parsed };
}

/**
 * Put an account straight into the store.
 * @param {string} handle Handle
 * @param {object} fields Fields that differ from an enabled, passworded member
 * @returns {Promise<void>}
 */
async function putAccount(handle, fields = {}) {
    const salt = users.getPasswordSalt();
    await accountStorage.setItem(users.toKey(handle), {
        handle,
        name: handle,
        created: Date.now(),
        password: users.getPasswordHash('the-old-password', salt),
        salt,
        admin: false,
        enabled: true,
        ...fields,
    });
}

/**
 * @param {string} handle Handle
 * @returns {Promise<any>} The stored account
 */
async function readAccount(handle) {
    return accountStorage.getItem(users.toKey(handle));
}

beforeAll(async () => {
    setConfigFilePath(path.join(path.dirname(testDirectory), 'default', 'config.yaml'));
    users = await import('../src/users.js');
    adminRoutes = await import('../src/endpoints/users-admin.js');
    privateRoutes = await import('../src/endpoints/users-private.js');
    publicRoutes = await import('../src/endpoints/users-public.js');

    root = makeScratchDirectory('blank-password');
    globalThis.DATA_ROOT = root;
    await users.initUserStorage(root);

    const app = express();
    app.use(express.json());
    app.use(async (request, _response, next) => {
        const handle = request.headers['x-test-user'];
        const profile = typeof handle === 'string' ? await accountStorage.getItem(users.toKey(handle)) : null;
        if (profile) {
            request.user = { profile, directories: users.getUserDirectories(profile.handle) };
        }
        request.session = { handle: request.user?.profile?.handle };
        next();
    });
    app.use('/admin', adminRoutes.router);
    app.use('/private', privateRoutes.router);
    app.use('/public', publicRoutes.router);

    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
    unregisterStorageProvider();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
    unregisterStorageProvider();
    await putAccount('admin', { admin: true });
    await putAccount('member');
    await putAccount('sleeper', { enabled: false, password: '', salt: '' });
});

describe('with a storage provider registered (this package)', () => {
    beforeEach(() => registerStorageProvider(makeProvider()));

    test.each([
        ['an empty string', ''],
        ['no password at all', undefined],
        ['null', null],
        ['a number', 12345],
    ])('creating an account with %s is refused and writes nothing', async (_label, password) => {
        const { status, body } = await post('/admin/create', { handle: 'newcomer', name: 'Newcomer', password });

        expect(status).toBe(400);
        expect(body.error).toMatch(REFUSAL_PATTERN);
        expect(await readAccount('newcomer')).toBeUndefined();
    });

    test('creating an account with a real password still works and stores a hash', async () => {
        const { status, body } = await post('/admin/create', { handle: 'newcomer', name: 'Newcomer', password: 'a-real-password' });

        expect(status).toBe(200);
        expect(body.handle).toBe('newcomer');
        const stored = await readAccount('newcomer');
        expect(stored.enabled).toBe(true);
        expect(stored.password).toBe(users.getPasswordHash('a-real-password', stored.salt));
    });

    test.each([
        ['an empty string', ''],
        ['no password at all', undefined],
        ['null', null],
    ])('an administrator changing another account\'s password to %s is refused and nothing changes', async (_label, newPassword) => {
        const before = await readAccount('member');
        const { status, body } = await post('/private/change-password', { handle: 'member', newPassword }, 'admin');

        expect(status).toBe(400);
        expect(body.error).toMatch(REFUSAL_PATTERN);
        expect(await readAccount('member')).toEqual(before);
    });

    test('a user changing their own password to blank is refused and the old password still works', async () => {
        const before = await readAccount('member');
        const { status, body } = await post('/private/change-password', { handle: 'member', oldPassword: 'the-old-password', newPassword: '' }, 'member');

        expect(status).toBe(400);
        expect(body.error).toMatch(REFUSAL_PATTERN);
        expect(await readAccount('member')).toEqual(before);
    });

    test('changing a password to a real one still works', async () => {
        const { status } = await post('/private/change-password', { handle: 'member', oldPassword: 'the-old-password', newPassword: 'the-new-password' }, 'member');

        expect(status).toBe(204);
        const stored = await readAccount('member');
        expect(stored.password).toBe(users.getPasswordHash('the-new-password', stored.salt));
    });

    test('enabling a disabled account that has no password is refused, and it stays disabled', async () => {
        const { status, body } = await post('/admin/enable', { handle: 'sleeper' });

        expect(status).toBe(400);
        expect(body.error).toMatch(/no password/);
        expect((await readAccount('sleeper')).enabled).toBe(false);
    });

    test('enabling a disabled account that has a password still works', async () => {
        await putAccount('rested', { enabled: false });
        const { status } = await post('/admin/enable', { handle: 'rested' });

        expect(status).toBe(204);
        expect((await readAccount('rested')).enabled).toBe(true);
    });

    test('the console-code reset refuses a blank new password before it looks at the code', async () => {
        const { status, body } = await post('/public/recover-step2', { handle: 'member', code: '000000', newPassword: '' }, 'nobody');

        expect(status).toBe(400);
        expect(body.error).toMatch(REFUSAL_PATTERN);
        expect(users.getPasswordHash('the-old-password', (await readAccount('member')).salt)).toBe((await readAccount('member')).password);
    });
});

describe('with no storage provider (a plain fork) the old behavior is kept', () => {
    test('blankPasswordRefusal answers null for every input', () => {
        for (const password of ['', undefined, null, 'x']) {
            expect(users.blankPasswordRefusal(password)).toBeNull();
        }
    });

    test('changing a password to blank is allowed and clears it', async () => {
        const { status } = await post('/private/change-password', { handle: 'member', oldPassword: 'the-old-password', newPassword: '' }, 'member');

        expect(status).toBe(204);
        expect((await readAccount('member')).password).toBe('');
    });

    test('enabling a passwordless account is allowed', async () => {
        const { status } = await post('/admin/enable', { handle: 'sleeper' });

        expect(status).toBe(204);
        expect((await readAccount('sleeper')).enabled).toBe(true);
    });

    test('the console-code reset reaches the code check (a wrong code is 403, not a password refusal)', async () => {
        const { status, body } = await post('/public/recover-step2', { handle: 'member', code: '000000', newPassword: '' }, 'nobody');

        expect(status).toBe(403);
        expect(body.error).toBe('Incorrect code');
    });
});
