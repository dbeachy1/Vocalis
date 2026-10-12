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
 * GET a route with no credentials at all.
 * @param {string} base Base URL
 * @param {string} route Route
 * @returns {Promise<{status: number, text: string, body: any}>} The response
 */
async function getAnonymous(base, route) {
    const response = await fetch(`${base}${route}`);
    const text = await response.text();

    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }

    return { status: response.status, text, body: parsed };
}

/**
 * GET a route as a logged-in user.
 * @param {string} base Base URL
 * @param {string} route Route
 * @param {string} cookie Session cookie
 * @returns {Promise<{status: number, body: any}>} The response
 */
async function getAsUser(base, route, cookie) {
    const response = await fetch(`${base}${route}`, { headers: { Cookie: cookie } });
    const text = await response.text();

    // A refusal is not JSON — express sends the bare word "Forbidden" — so parse optimistically.
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }

    return { status: response.status, body: parsed };
}

/**
 * POST some JSON, optionally as a logged-in user.
 * @param {string} base Base URL
 * @param {string} route Route
 * @param {any} body Body
 * @param {string} [cookie] Session cookie
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
 * 🔴 THE LOGIN BADGE'S FEED — AND THE ORACLE IT MUST NOT BECOME.
 *
 * The login page draws its storage badge before anybody has logged in — in the provider's words, never the
 * fork's — so this endpoint is necessarily unauthenticated. The header marker rides on the same request.
 * `storage-provider-login-oracle.test.js` exists because the last unauthenticated thing the
 * login page read turned into a side channel: the response varied with provider state, so anybody on the
 * network could poll it and learn when a given person was logged in. Adding a new anonymous endpoint to the
 * same page without pinning that property would be an own goal.
 *
 * So the property under test is not "does it say true" — it is **"does it say the same thing no matter what
 * is happening inside."** One instance-level boolean, constant from boot to shutdown, identical whether a
 * vault is locked or unlocked and whether anyone is logged in or not.
 */
describe('GET /api/storage/status — with a provider installed', () => {
    /** @type {string} */
    let scratch;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;

    beforeAll(async () => {
        scratch = makeScratchDirectory('storage-status-on');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);

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

    test('an anonymous caller is told storage is provided, in the PROVIDER\'s words', async () => {
        const { status, body } = await getAnonymous(base, '/api/storage/status');

        expect(status).toBe(200);
        expect(body.enabled).toBe(true);

        // The words are the fixture's, not the fork's. That is the whole design: SillyTavern cannot say what
        // a provider does with the bytes, so it repeats what the provider said and has no sentence of its own.
        expect(body.badge).toBe('FIXTURE storage is protected.');
    });

    test('🔴 the header marker is asked SEPARATELY — it is not the login badge reused', async () => {
        // The login page has room for a sentence and the header has room for a word, so they are two
        // situations and a provider may answer them differently. The fixture deliberately returns different
        // text for each; if the fork ever asked once and used the answer twice, these would be equal.
        const { body } = await getAnonymous(base, '/api/storage/status');

        expect(body.marker).toBe('FIXTURE-MARKER');
        expect(body.marker).not.toBe(body.badge);
    });

    test('🔴 only `body` crosses — the title and notes are dropped before an anonymous caller sees them', async () => {
        // The fixture returns a title and notes as well. A badge has room for none of it, this endpoint is
        // unauthenticated, and the narrowest thing that can work is the only thing that should go. Asserting
        // on the raw text as well, so a stray field cannot hide in a nested object `toEqual` never looked at.
        const { text, body } = await getAnonymous(base, '/api/storage/status');

        expect(Object.keys(body).sort()).toEqual(['badge', 'enabled', 'marker']);
        expect(text).not.toContain('FIXTURE title');
        expect(text).not.toContain('FIXTURE note');
        expect(text.toLowerCase()).not.toContain('keyed-provider');
        expect(text.toLowerCase()).not.toContain('version');
        expect(text.toLowerCase()).not.toContain('default-user');
    });

    test('🔴 THE ORACLE: the answer is byte-identical locked and unlocked', async () => {
        // The property `storage-provider-login-oracle.test.js` was written to defend, restated for this
        // endpoint. If these two responses ever differ, the difference is a side channel telling anyone on
        // the network when a user is logged in — whatever it happens to be carrying that day.
        const locked = await getAnonymous(base, '/api/storage/status');

        const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
        expect(login.status).toBe(200);

        // 🔑 Prove the vault really is open right now, otherwise "identical" is satisfied by a server that
        // simply never unlocked and the assertion below is decorative.
        const me = await getAsUser(base, '/api/users/me', login.cookie);
        expect(me.status).toBe(200);
        expect(me.body?.handle).toBe('default-user');

        const unlocked = await getAnonymous(base, '/api/storage/status');

        expect(unlocked.text).toBe(locked.text);
    });
});

/**
 * With encryption off, the page must look exactly like
 * an ordinary SillyTavern. Absence is the signal — there is no "unencrypted" badge and this endpoint is the
 * only thing the client asks.
 */
describe('GET /api/storage/status — with no provider installed', () => {
    /** @type {string} */
    let scratch;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;

    beforeAll(async () => {
        scratch = makeScratchDirectory('storage-status-off');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');

        server = await startSillyTavern({ dataRoot, configPath });

        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);
        base = `http://127.0.0.1:${server.port}`;
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    test('the endpoint exists and answers false — the client shows nothing', async () => {
        // It answers rather than 404s so the client can tell "this server says no" from "this server is old",
        // even though both outcomes render identically. The distinction costs nothing and the badge is a
        // claim we decline to make in either case.
        const { status, body } = await getAnonymous(base, '/api/storage/status');

        expect(status).toBe(200);
        expect(body).toEqual({ enabled: false, badge: null, marker: null });
    });
});

/**
 * 🔴 THE CASE THAT PROVES THE FORK HAS NO WORDS OF ITS OWN.
 *
 * A provider is installed and working, and it implements nothing optional — no `describe`. If the fork had
 * quietly kept a stock sentence for this situation, THIS is where it would surface, and it would be
 * SillyTavern telling the user what a storage provider does. There is no such sentence, so the badge simply
 * does not appear.
 *
 * `ST_KEYED_SILENT` is the fixture's existing switch for exactly this: "a fork that only works when the
 * provider is chatty has simply moved its hard-coded strings into a fallback branch nobody tests."
 */
describe('GET /api/storage/status — a provider that says nothing', () => {
    /** @type {string} */
    let scratch;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;

    beforeAll(async () => {
        scratch = makeScratchDirectory('storage-status-silent');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);
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
                ST_KEYED_SILENT: '1',
            },
        });

        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);
        base = `http://127.0.0.1:${server.port}`;
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    test('storage is on, but there is no text — so the client draws nothing', async () => {
        const { status, body } = await getAnonymous(base, '/api/storage/status');

        expect(status).toBe(200);

        // 🔑 Assert the provider really IS installed first. Without this, `text: null` is equally satisfied
        // by a server that has no provider at all, and the test proves nothing about the silent case.
        expect(body.enabled).toBe(true);
        expect(body.badge).toBeNull();
        expect(body.marker).toBeNull();
    });
});
