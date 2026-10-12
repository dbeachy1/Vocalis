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

/** 0.05 minutes = 3 seconds. The sweep scales with it, so this locks in ~3-4s rather than ~30 minutes. */
const IDLE_MINUTES = 0.05;
const IDLE_MS = IDLE_MINUTES * 60 * 1000;

/**
 * Give the default user a password, so the provider has something to key itself from.
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
 * @param {number} ms How long to wait
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Call a route, tolerating a non-JSON refusal.
 * @param {string} base Base URL
 * @param {string} route Route
 * @param {object} options Fetch options
 * @returns {Promise<{status: number, body: any, cookie: string}>} The response
 */
async function call(base, route, options = {}) {
    const response = await fetch(`${base}${route}`, options);
    const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const text = await response.text();

    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }

    return { status: response.status, body: parsed, cookie };
}

/**
 * Log in and come back with a session cookie.
 * @param {string} base Base URL
 * @returns {Promise<string>} The cookie
 */
async function login(base) {
    const response = await call(base, '/api/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: 'default-user', password: PASSWORD }),
    });

    expect(response.status).toBe(200);
    return response.cookie;
}

/**
 * Is this cookie still good — i.e. is the vault still open?
 *
 * The session cookie survives a lock (it lives on the client and nothing expired it), so the ONLY thing
 * that can turn this into a 403 is `setUserDataMiddleware` finding the storage shut.
 * @param {string} base Base URL
 * @param {string} cookie The session cookie
 * @returns {Promise<number>} The status code
 */
async function probe(base, cookie) {
    const response = await call(base, '/api/users/me', { headers: { Cookie: cookie } });
    return response.status;
}

/**
 * Set the idle lock through the route the account panel uses.
 * @param {string} base Base URL
 * @param {string} cookie The session cookie
 * @param {unknown} minutes What to send as the setting
 * @returns {Promise<{status: number, body: any, cookie: string}>} The response
 */
async function setIdleLock(base, cookie, minutes) {
    return await call(base, '/api/users/idle-lock', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes }),
    });
}

/**
 * 🔒 THE IDLE LOCK.
 *
 * Logging out locks the vault — but almost nobody logs out. They close the tab, or they wander off to lunch.
 * SillyTavern uses `cookieSession`, so a session lives entirely in a cookie on the client: when the user
 * vanishes, THE SERVER IS NEVER TOLD. It simply stops hearing from them and goes on holding their key, until
 * the process dies. On a box that stays up for weeks that is not a lock at all, and "log out, restart, or
 * crash → locked" quietly means "restart or crash → locked".
 *
 * 🔴 AND THE TRAP THAT MAKES THIS MORE THAN A ONE-LINER: an open tab TALKS TO THE SERVER BY ITSELF.
 * `user.js` pings `/api/ping?extend=1` every ten minutes, for as long as the page is open, to keep the
 * session cookie alive. Implement "any request resets the idle clock" and an abandoned tab is immortal: the
 * vault never locks, nothing errors, and the feature looks — from every angle, including a green test suite
 * that only checks the happy path — like it works.
 *
 * So activity must mean THE USER DID SOMETHING. A keepalive is the precise opposite: it is what the page
 * sends when they don't.
 */
describe('🔒 the idle lock', () => {
    /** @type {string} */
    let scratch;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;
    /** @type {Parameters<typeof startSillyTavern>[0]} Kept so the restart test can bring the same instance back. */
    let bootOptions;

    beforeAll(async () => {
        scratch = makeScratchDirectory('idle-lock');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);
        installStorageProvider(providersPath, KEYED_PROVIDER);

        bootOptions = {
            dataRoot,
            configPath,
            storageProvidersPath: providersPath,
            enableUserAccounts: true,
            providerEnv: {
                // 🔒 The provider RECOMMENDS this. It does not get to apply it — see the first two tests,
                // which are the ones that pin that. It was applied verbatim until 2026-07-27, and the
                // symptom was a user signed out of his own desktop every thirty minutes with no setting
                // anywhere to turn it off. The number the sweep actually uses comes from the account.
                ST_KEYED_IDLE_LOCK_MS: String(IDLE_MS),
                ST_KEYED_STATE: path.join(scratch, 'vault-keys.json'),
                ST_KEYED_HANDLE: 'default-user',
                ST_KEYED_PASSWORD: PASSWORD,
                ST_KEYED_RECOVERY_KEY: RECOVERY_KEY,
            },
        };

        server = await startSillyTavern(bootOptions);

        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);
        base = `http://127.0.0.1:${server.port}`;
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    // 🔴 THE HEADLINE, AND THE REGRESSION THIS FILE NOW EXISTS TO PREVENT. The provider is asking for a
    // three-second lock in `providerEnv` above. Nobody has agreed to it. Nothing may happen.
    //
    // Until 2026-07-27 the provider's number WAS the lock, applied at boot with no setting anywhere to
    // change it, and installing a storage provider therefore silently added a logout timer to somebody's
    // own desktop machine. Upstream SillyTavern has no idle lock; a fork that grows one uninvited is a fork
    // people uninstall. If this test ever goes red, the default has drifted back to "whatever the plugin
    // said" and that is a product decision being made by an environment variable.
    test('🔴 THE DEFAULT IS NEVER: a provider recommendation is NOT a lock', async () => {
        const cookie = await login(base);
        expect(await probe(base, cookie)).toBe(200);

        // Well past the recommendation. An implementation that applies it locks here.
        await sleep(IDLE_MS * 2.5);

        expect(await probe(base, cookie)).toBe(200);
    }, 30_000);

    // ...and the recommendation is not thrown away either, or a provider's security advice reaches nobody.
    // The panel needs all three of these to draw itself: whether to appear at all, where to put the tick,
    // and what to attribute to the provider.
    test('the panel is told it is available, switched off, and what the provider suggests', async () => {
        const cookie = await login(base);
        const status = await call(base, '/api/users/idle-status', { headers: { Cookie: cookie } });

        expect(status.status).toBe(200);
        expect(status.body.available).toBe(true);
        expect(status.body.enabled).toBe(false);
        expect(status.body.configuredMinutes).toBe(0);
        expect(status.body.recommendedMinutes).toBeGreaterThan(0);
    }, 30_000);

    // Rubbish must not become a lock, and must not quietly become SOME OTHER lock either. A value rounded
    // into range is a control that lies about what it did, and this one decides when unsent text is lost.
    test.each([
        ['not a number', 'half an hour'],
        ['negative', -5],
        ['past the ceiling', 40321],
        ['infinite', 'Infinity'],
        ['nothing at all', null],
    ])('the route refuses a %s value and changes nothing', async (_label, value) => {
        const cookie = await login(base);

        const refused = await setIdleLock(base, cookie, value);
        expect(refused.status).toBe(400);

        const status = await call(base, '/api/users/idle-status', { headers: { Cookie: cookie } });
        expect(status.body.configuredMinutes).toBe(0);
        expect(status.body.enabled).toBe(false);
    }, 30_000);

    // The plain case, and the one that matters most in real life: the browser is CLOSED. Nothing is sent at
    // all. A lock evaluated lazily on the way through a request would wait for a knock that never comes —
    // which is exactly the user we most want locked.
    test('a user who asked to be locked, and goes away, is locked with no requests at all', async () => {
        const cookie = await login(base);

        const armed = await setIdleLock(base, cookie, IDLE_MINUTES);
        expect(armed.status).toBe(200);
        expect(armed.body.enabled).toBe(true);
        expect(armed.body.configuredMinutes).toBe(IDLE_MINUTES);

        expect(await probe(base, cookie)).toBe(200);

        await sleep(IDLE_MS * 2.5);

        expect(await probe(base, cookie)).toBe(403);
    }, 30_000);

    // 🔴 SETTING IT ARMS IT IMMEDIATELY. The user who turns the lock on from a tab and then walks away is
    // the exact person it is for, and they send no further requests — so if the clock only starts on the
    // NEXT request, they are never locked at all, having just asked to be.
    test('turning it on starts the clock there and then, with no further requests', async () => {
        const cookie = await login(base);
        expect(await setIdleLock(base, cookie, IDLE_MINUTES)).toMatchObject({ status: 200 });

        await sleep(IDLE_MS * 2.5);

        expect(await probe(base, cookie)).toBe(403);
    }, 30_000);

    // And back off again. A setting you cannot undo is a trap, and "Never" is the default it must return to.
    test('setting it back to Never disarms the lock', async () => {
        const cookie = await login(base);
        expect(await setIdleLock(base, cookie, IDLE_MINUTES)).toMatchObject({ status: 200 });

        const off = await setIdleLock(base, cookie, 0);
        expect(off.status).toBe(200);
        expect(off.body.enabled).toBe(false);
        expect(off.body.configuredMinutes).toBe(0);

        await sleep(IDLE_MS * 2.5);

        expect(await probe(base, cookie)).toBe(200);
    }, 30_000);

    // It has to survive the process. The setting lives on the account record precisely so the sweep can read
    // it for a user whose vault is shut — a setting that only existed in memory would silently reset to
    // "Never" on every restart, which on this fork is several times an evening.
    test('the choice survives a restart', async () => {
        const cookie = await login(base);
        expect(await setIdleLock(base, cookie, 240)).toMatchObject({ status: 200 });

        await server.stop();
        server = await startSillyTavern(bootOptions);
        if (!server.listening) throw new Error(`Reboot failed.\n\n${server.output()}`);
        base = `http://127.0.0.1:${server.port}`;

        const status = await call(base, '/api/users/idle-status', { headers: { Cookie: await login(base) } });
        expect(status.body.configuredMinutes).toBe(240);
        expect(status.body.enabled).toBe(true);

        // Put it back, so the tests after this one start from a known state.
        expect(await setIdleLock(base, await login(base), IDLE_MINUTES)).toMatchObject({ status: 200 });
    }, 240_000);

    // 🔴 THE ONE THAT CATCHES THE OBVIOUS IMPLEMENTATION. An open tab keeps pinging. If the ping counts as
    // activity, this test hangs on 200 forever and the idle lock is decorative.
    test('AN OPEN TAB IS NOT A PRESENT USER: the session keepalive must not hold the vault open', async () => {
        const cookie = await login(base);
        expect(await setIdleLock(base, cookie, IDLE_MINUTES)).toMatchObject({ status: 200 });
        expect(await probe(base, cookie)).toBe(200);

        // Be the abandoned tab: ping exactly as user.js does, for well over the idle timeout.
        const deadline = Date.now() + IDLE_MS * 2.5;

        while (Date.now() < deadline) {
            await call(base, '/api/ping?extend=1', { method: 'POST', headers: { Cookie: cookie } });
            await sleep(300);
        }

        expect(await probe(base, cookie)).toBe(403);
    }, 30_000);

    // ...nor may ASKING how long you have left be the thing that gives you longer.
    test('polling /idle-status does not postpone the lock', async () => {
        const cookie = await login(base);
        expect(await setIdleLock(base, cookie, IDLE_MINUTES)).toMatchObject({ status: 200 });

        const deadline = Date.now() + IDLE_MS * 2.5;
        let sawCountdown = false;

        while (Date.now() < deadline) {
            const status = await call(base, '/api/users/idle-status', { headers: { Cookie: cookie } });

            if (status.status === 200 && status.body.enabled && status.body.msUntilLock < IDLE_MS) {
                sawCountdown = true;
            }

            await sleep(300);
        }

        // It really was counting down while we watched — otherwise the assertion below would be satisfied by
        // a route that was simply broken.
        expect(sawCountdown).toBe(true);
        expect(await probe(base, cookie)).toBe(403);
    }, 30_000);

    // 🔴 THE ANTI-VACUOUS TEST. Everything above is equally true of an implementation that just locks
    // everyone after three seconds no matter what they are doing. This is the one that says the lock is
    // actually about IDLENESS: a user who keeps working is NOT locked, however long they keep at it.
    test('a user who keeps working is never locked', async () => {
        const cookie = await login(base);
        expect(await setIdleLock(base, cookie, IDLE_MINUTES)).toMatchObject({ status: 200 });

        const deadline = Date.now() + IDLE_MS * 2.5;

        while (Date.now() < deadline) {
            expect(await probe(base, cookie)).toBe(200);
            await sleep(300);
        }

        expect(await probe(base, cookie)).toBe(200);
    }, 30_000);

    // And the button in the countdown modal has to actually buy them time.
    test('/idle-keepalive resets the clock — the "Stay signed in" button works', async () => {
        const cookie = await login(base);
        expect(await setIdleLock(base, cookie, IDLE_MINUTES)).toMatchObject({ status: 200 });

        // Sit still until we are most of the way to the lock.
        await sleep(IDLE_MS * 0.8);

        const extended = await call(base, '/api/users/idle-keepalive', { method: 'POST', headers: { Cookie: cookie } });
        expect(extended.status).toBe(200);
        expect(extended.body.enabled).toBe(true);

        // A full timeout, back on the clock.
        expect(extended.body.msUntilLock).toBeGreaterThan(IDLE_MS * 0.9);

        // And it is real: wait out what was left of the ORIGINAL deadline and we are still in.
        await sleep(IDLE_MS * 0.5);
        expect(await probe(base, cookie)).toBe(200);
    }, 30_000);
});
