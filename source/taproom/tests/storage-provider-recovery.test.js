import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(testDirectory);
const KEYED_PROVIDER = path.join(testDirectory, 'fixtures', 'keyed-provider.js');

const PASSWORD = 'the-original-password';
const RECOVERY_KEY = 'TEST_ONLY_RECOVERY_KEY_FIXTURE_0000000000000001';
const NEW_PASSWORD = 'the-password-after-recovery';

/**
 * Give the default user a real password. A provider that needs a secret is meaningless without one.
 * @param {string} dataRoot The data root
 * @param {string} password The password to set
 * @returns {Promise<void>}
 */
async function setPassword(dataRoot, password) {
    const store = nodePersist.create({ dir: path.join(dataRoot, '_storage'), expiredInterval: 0 /* no stray timer — see setPassword in integration/harness.mjs */ });
    await store.init();

    const user = await store.getItem('user:default-user');
    const salt = crypto.randomBytes(16).toString('base64');

    user.password = crypto.scryptSync(password.normalize(), salt, 64).toString('base64');
    user.salt = salt;

    await store.setItem('user:default-user', user);
}

/**
 * Read the account record straight out of node-persist, bypassing the server entirely.
 *
 * The password hash is the thing under test in half of these, and asking the server about it would be
 * asking the accused for a statement. Go and look at the disk.
 * @param {string} dataRoot The data root
 * @returns {Promise<any>} The user record
 */
async function readUser(dataRoot) {
    const store = nodePersist.create({ dir: path.join(dataRoot, '_storage'), expiredInterval: 0 /* no stray timer — see setPassword in integration/harness.mjs */ });
    await store.init();
    return await store.getItem('user:default-user');
}

/**
 * Read the provider's wraps off the disk. Its `.vault-keys.json`, in miniature.
 * @param {string} statePath Path to the fixture's state file
 * @returns {Record<string, Record<string, string>>} handle -> { secret -> dek }
 */
function readVaults(statePath) {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

/**
 * The one thing that must never change: the data key itself.
 * @param {string} statePath Path to the fixture's state file
 * @returns {string} The DEK
 */
function theDek(statePath) {
    const wraps = Object.values(readVaults(statePath)['default-user']);
    const deks = new Set(wraps);

    // Both wraps must be wraps OF THE SAME KEY, or the recovery key would open a different vault.
    expect(deks.size).toBe(1);
    return wraps[0];
}

/**
 * POST some JSON.
 * @param {string} base Base URL
 * @param {string} route Route
 * @param {any} body Body
 * @returns {Promise<{status: number, body: any, cookie: string}>} The response
 */
async function post(base, route, body) {
    const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

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
 * 🔑 RECOVERY: THE WAY BACK IN.
 *
 * Encryption turns "I forgot my password" from an annoyance into a *bereavement*. The password is not a
 * gate in front of the data any more — it is the thing the data is sealed with. Reset it blindly and you
 * do not open the account; you destroy the only key that could ever have opened it, and every chat stays
 * on the disk forever in perfect, unreadable condition.
 *
 * SillyTavern ships a blind reset. `/recover-step1` prints a code to the server console; `/recover-step2`
 * trades it for a new password with no old password required; `recover.js` does the same from the command
 * line with no server running at all. Against the plain filesystem, all three are FINE — the data is
 * plaintext anyway, so anyone who can read the console to get the code could just read the chats. Against
 * a provider they are three separate ways to lose everything.
 *
 * So there is one rule, and everything here is a consequence of it:
 *
 *     A PASSWORD MAY BE CHANGED ONLY WHEN THE KEY CAN BE RE-WRAPPED, OR WHEN THERE IS NO KEY.
 *
 * No provider → no key → the blind reset is allowed, byte-for-byte as upstream. (Tested: it still works.)
 * A provider  → there is a key → the blind reset is refused, at all three doors, and the recovery key is
 *               the way in — because a secret held OFF the machine is proof of ownership, and a code
 *               printed to the machine's own console is not.
 */
describe('🔑 recovery', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let configPath;
    /** @type {string} */
    let providersPath;
    /** @type {string} */
    let statePath;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;

    beforeAll(async () => {
        scratch = makeScratchDirectory('recovery');
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        providersPath = path.join(scratch, 'storage-providers');
        statePath = path.join(scratch, 'vault-keys.json');

        // Seed a normal install and give the user a password, then hand the data root to a provider that
        // keys itself from that password.
        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();
        await setPassword(dataRoot, PASSWORD);

        installStorageProvider(providersPath, KEYED_PROVIDER);

        server = await startSillyTavern({
            dataRoot,
            configPath,
            storageProvidersPath: providersPath,
            enableUserAccounts: true,
            providerEnv: {
                ST_KEYED_STATE: statePath,
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

        if (scratch) {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    // ---- the blind reset must be refused, at every door -----------------------------------------

    test('🔴 /recover-step1 is REFUSED, and says why', async () => {
        const { status, body } = await post(base, '/api/users/recover-step1', { handle: 'default-user' });

        expect(status).toBe(403);
        expect(body.recoveryKeyRequired).toBe(true);
    });

    test('🔴 /recover-step2 is REFUSED TOO — guard the thing that does the damage', async () => {
        // Step 1 already refuses, so no honest caller can be holding a code. But step 2 is the request
        // that actually WRITES THE PASSWORD, and a provider could have been registered between the two.
        // Guarding only the request that leads to the damage, and not the one that does it, is how this
        // kind of check gets quietly defeated.
        const before = await readUser(dataRoot);

        const { status, body } = await post(base, '/api/users/recover-step2', {
            handle: 'default-user',
            code: '123456',
            newPassword: 'hijacked',
        });

        expect(status).toBe(403);

        // 🔴 ASSERT ON *WHY*, NOT JUST ON 403.
        //
        // This route has two ways to answer 403: the guard, and "incorrect code". A test that accepts
        // either one passes whether or not the guard exists -- I removed the guard to check, and this test
        // stayed green, because the made-up code above is of course also wrong. It was measuring nothing.
        //
        // The body is what distinguishes them. Only the guard sets this flag.
        expect(body.recoveryKeyRequired).toBe(true);

        // And -- the part that actually matters -- IT DID NOT TOUCH THE PASSWORD.
        const after = await readUser(dataRoot);
        expect(after.password).toBe(before.password);
        expect(after.salt).toBe(before.salt);
    });

    test('🔴 recover.js — THE COMMAND LINE — is refused as well', async () => {
        // The one caller that could route around all of this. It talks to node-persist directly, with no
        // server running and no session to check. If it did not load the provider and ask, it would reset
        // the password of an encrypted account from a shell prompt and orphan every chat in it.
        const before = await readUser(dataRoot);

        const result = await new Promise((resolve) => {
            const child = spawn(process.execPath, [path.join(serverDirectory, 'recover.js'), 'default-user', 'hijacked'], {
                cwd: scratch,
                env: {
                    ...process.env,
                    SILLYTAVERN_STORAGEPROVIDERSPATH: providersPath,
                    ST_KEYED_STATE: statePath,
                    ST_KEYED_HANDLE: 'default-user',
                    ST_KEYED_PASSWORD: PASSWORD,
                    ST_KEYED_RECOVERY_KEY: RECOVERY_KEY,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let output = '';
            child.stdout.on('data', chunk => output += chunk.toString());
            child.stderr.on('data', chunk => output += chunk.toString());
            child.on('exit', code => resolve({ code, output }));
        });

        expect(result.code).toBe(1);

        // The operator is told the way back in, on a line that names nobody.
        expect(result.output).toMatch(/recovery key/i);

        // 🔴 AND THE PROVIDER'S OWN PROSE IS NOT ON THE TERMINAL. This assertion is the point of the test,
        // not a bonus: this tool never called `initLogger`, so every line buffered and the exit-time dump
        // published it ALL — the SENSITIVE half of every pair included. `/recovery key/i` above used to
        // match the leaked fixture body ('FIXTURE: use the recovery key.') rather than anything the fork
        // meant to say, so the test passed BECAUSE of the leak and would have kept passing through it.
        expect(result.output).not.toMatch(/FIXTURE/);
        expect(result.output).toMatch(/SENSITIVE suppressed/);

        const after = await readUser(dataRoot);
        expect(after.password).toBe(before.password);
    });

    // ---- the recovery key: the door that IS open -------------------------------------------------

    test('🔴 a WRONG recovery key changes nothing at all', async () => {
        // The order in the route is load-bearing: the provider re-keys FIRST, and only if that succeeds
        // does the password change. Reverse them and a failed recovery attempt would leave the user with
        // a new password over a vault that no longer opens to it — locked out by their own rescue.
        const before = await readUser(dataRoot);

        const { status } = await post(base, '/api/users/recover-with-key', {
            handle: 'default-user',
            recoveryKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH',
            newPassword: 'should-never-take-effect',
        });

        expect(status).toBe(403);

        const after = await readUser(dataRoot);
        expect(after.password).toBe(before.password);

        // The old password still works, which is the only proof that matters.
        const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
        expect(login.status).toBe(200);
    });

    test('🔑 THE RIGHT RECOVERY KEY OPENS THE DOOR — and the DATA KEY NEVER MOVES', async () => {
        // The whole design in one assertion.
        //
        // The recovery key does not decrypt the data and it does not re-encrypt anything. It reaches the
        // SAME data key by a different wrap, and re-wraps it under the new password. So recovery is
        // instantaneous no matter how many gigabytes of chats there are, and — the part that would be
        // catastrophic to get wrong — the data that was readable before is still readable after.
        const dekBefore = theDek(statePath);

        const { status } = await post(base, '/api/users/recover-with-key', {
            handle: 'default-user',
            recoveryKey: RECOVERY_KEY,
            newPassword: NEW_PASSWORD,
        });

        expect(status).toBe(204);

        // 🔑 THE KEY IS THE SAME KEY. Only the thing wrapping it changed.
        expect(theDek(statePath)).toBe(dekBefore);
    });

    test('🔑 the new password logs in, and the old one does not', async () => {
        const fresh = await post(base, '/api/users/login', { handle: 'default-user', password: NEW_PASSWORD });
        expect(fresh.status).toBe(200);

        const stale = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
        expect(stale.status).not.toBe(200);
    });

    test('🔑 and the data is READABLE — recovery recovered the data, not just the account', async () => {
        // Under encryption, "I am logged in" and "I can read my chats" are different claims, and only the
        // second one is worth anything. A recovery that restored the account but left the data sealed
        // would be a cruel joke: you would be looking at an empty SillyTavern with every chat you have
        // ever had sitting right there on the disk.
        const login = await post(base, '/api/users/login', { handle: 'default-user', password: NEW_PASSWORD });
        expect(login.status).toBe(200);

        const me = await fetch(`${base}/api/users/me`, { headers: { Cookie: login.cookie } });
        expect(me.status).toBe(200);

        // /api/characters/all reads THROUGH the provider. A locked vault answers 403; a broken one throws.
        // A 200 here means the data key really is in hand.
        const characters = await fetch(`${base}/api/characters/all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: login.cookie },
            body: JSON.stringify({}),
        });

        expect(characters.status).toBe(200);
    });

    test('🔑 recovery left the vault UNLOCKED — you recovered, you are in', async () => {
        // Possession of the recovery key is proof of ownership. Making the user then log in again would
        // be theatre, and worse, it would fail: they would be logging in with a password that was set
        // seconds ago against a vault that must already be open for the login to serve anything.
        const wraps = readVaults(statePath)['default-user'];

        expect(Object.keys(wraps)).toContain(`pw:${NEW_PASSWORD}`);
        expect(Object.keys(wraps)).toContain(`rk:${RECOVERY_KEY}`);
        expect(Object.keys(wraps)).not.toContain(`pw:${PASSWORD}`);
    });

    /**
     * 🔴 THE FORK MUST PASS THE OLD PASSWORD THROUGH. This is a CAPABILITY test, not a policy test.
     *
     * SillyTavern lets an ADMIN change a password without knowing the old one, and its dialog does not even
     * render the field — so `oldPassword` arrives as `''`. Harmless when a password is a gate. But a storage
     * provider may key itself from that password, and may quite reasonably demand it before re-wrapping. If
     * the fork never carries it, that provider can never be satisfied, and the account can never change its
     * password at all.
     *
     * So the fork's obligation is to CARRY it, and to honour a refusal. Whether it is REQUIRED is the
     * provider's business, and the keyed fixture (which now demands it) stands in for a provider that says
     * yes. `default-user` is an admin — which is what makes this the default path and not an edge case.
     */
    test('🔴 an admin re-keying their OWN unlocked vault is refused when the old password is not carried', async () => {
        const dekBefore = theDek(statePath);

        const login = await post(base, '/api/users/login', { handle: 'default-user', password: NEW_PASSWORD });
        expect(login.status).toBe(200);

        // The vault is OPEN. The provider COULD re-wrap from memory — and used to. That is the whole trap:
        // nothing fails, the data is fine, and the key quietly changes hands.
        const changed = await fetch(`${base}/api/users/change-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: login.cookie },
            body: JSON.stringify({
                handle: 'default-user',
                oldPassword: '',
                newPassword: 'a-password-an-attacker-chose',
            }),
        });

        expect(changed.status).toBe(403);

        // 🔴 And the fork must say WHY, in the provider's own words — not invent "your data would have become
        // unreadable", which is a different refusal entirely and a lie when the box was simply left blank.
        const body = await changed.json();
        expect(body.error).toMatch(/current password/i);

        // Nothing moved. The old password still opens the vault; the attacker's does not.
        const wraps = readVaults(statePath)['default-user'];
        expect(wraps[`pw:${NEW_PASSWORD}`]).toBe(dekBefore);
        expect(wraps).not.toHaveProperty('pw:a-password-an-attacker-chose');
    });

    test('🔑 an ORDINARY password change still works, and the recovery key survives it', async () => {
        // Changing your password while logged in
        // must keep working without re-encrypting data or rewriting chats.
        //
        // And the recovery key must SURVIVE it. It wraps the DEK, and the DEK does not move. If a routine
        // password change silently invalidated the saved key, recovery would fail when needed.
        //
        // (My first version of this test asserted the wrap still pointed at the DEK without ever changing
        // the password. It passed with the whole guard ripped out. It was testing the fixture.)
        const FINAL_PASSWORD = 'a-routine-password-change';
        const dekBefore = theDek(statePath);

        const login = await post(base, '/api/users/login', { handle: 'default-user', password: NEW_PASSWORD });
        expect(login.status).toBe(200);

        const changed = await fetch(`${base}/api/users/change-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: login.cookie },
            body: JSON.stringify({
                handle: 'default-user',
                oldPassword: NEW_PASSWORD,
                newPassword: FINAL_PASSWORD,
            }),
        });

        expect(changed.status).toBe(204);

        // 🔑 The data key did not move. Nothing was re-encrypted.
        expect(theDek(statePath)).toBe(dekBefore);

        // The new password opens the vault...
        const wraps = readVaults(statePath)['default-user'];
        expect(wraps[`pw:${FINAL_PASSWORD}`]).toBe(dekBefore);
        expect(wraps).not.toHaveProperty(`pw:${NEW_PASSWORD}`);

        // ...and so, still, does the recovery key.
        expect(wraps[`rk:${RECOVERY_KEY}`]).toBe(dekBefore);

        const relogin = await post(base, '/api/users/login', { handle: 'default-user', password: FINAL_PASSWORD });
        expect(relogin.status).toBe(200);
    });
});

/**
 * 🔴 SHOWING THE RECOVERY KEY. THE MOST IMPORTANT SCREEN IN THE APPLICATION.
 *
 * Everything else in the recovery path was built and tested before this existed — the route, the unwrap,
 * the re-wrap, the refusal of the blind reset at all three doors — and it was all worth NOTHING, because
 * the key was minted and never put in front of the user. An account whose password is forgotten was, in
 * practice, gone: the second door existed and nobody had been given the key to it.
 *
 * The failure is invisible from the inside. Encryption works, logins work, chats save and load; the account
 * looks perfectly healthy right up to the day the password is forgotten, and only then does anyone discover
 * that the way back in was never handed over.
 *
 * So: the provider offers a secret, SillyTavern shows it, and it KEEPS offering it until the user says they
 * have it. Not until something read it out of memory — until a human says so.
 */
describe('🔴 the recovery key is actually SHOWN', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let configPath;
    /** @type {string} */
    let providersPath;
    /** @type {string} */
    let statePath;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;

    const PENDING_KEY = 'TEST_ONLY_PENDING_KEY_FIXTURE_00000000000000002';

    /**
     * Boot a server against the same data root and provider state.
     * @returns {Promise<void>}
     */
    async function boot() {
        server = await startSillyTavern({
            dataRoot,
            configPath,
            storageProvidersPath: providersPath,
            enableUserAccounts: true,
            providerEnv: {
                ST_KEYED_STATE: statePath,
                ST_KEYED_HANDLE: 'default-user',
                ST_KEYED_PASSWORD: PASSWORD,
                ST_KEYED_RECOVERY_KEY: PENDING_KEY,
            },
        });

        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);
        base = `http://127.0.0.1:${server.port}`;
    }

    /**
     * Log in and ask for the pending recovery secret.
     * @returns {Promise<{status: number, secret: string|null, cookie: string}>} The answer
     */
    async function loginAndAsk() {
        const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
        expect(login.status).toBe(200);

        const response = await fetch(`${base}/api/users/recovery-secret`, { headers: { Cookie: login.cookie } });
        const body = await response.json();

        return { status: response.status, secret: body.secret, cookie: login.cookie };
    }

    beforeAll(async () => {
        scratch = makeScratchDirectory('recovery-display');
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        providersPath = path.join(scratch, 'storage-providers');
        statePath = path.join(scratch, 'vault-keys.json');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();
        await setPassword(dataRoot, PASSWORD);

        installStorageProvider(providersPath, KEYED_PROVIDER);
        await boot();
    }, 240_000);

    afterAll(async () => {
        await server?.stop();

        if (scratch) {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    test('🔴 after logging in, the recovery key is THERE TO BE SHOWN', async () => {
        const { status, secret } = await loginAndAsk();

        expect(status).toBe(200);
        expect(secret).toBe(PENDING_KEY);
    });

    test('🔴 asking does NOT consume it — a refresh must not throw away the only copy', async () => {
        // It used to be a destructive read: collect it once and it is gone. Which meant a browser that
        // crashed, or a user who hit F5 while looking for a pen, silently destroyed the only copy of the
        // only key that could ever have recovered the account -- and left the flag saying "not yet shown"
        // false, so nothing would ever offer it again either.
        const first = await loginAndAsk();
        expect(first.secret).toBe(PENDING_KEY);

        const again = await fetch(`${base}/api/users/recovery-secret`, { headers: { Cookie: first.cookie } });
        expect((await again.json()).secret).toBe(PENDING_KEY);
    });

    test('🔴 an ANONYMOUS request is refused — the key belongs to the SESSION, not to a handle', async () => {
        // The secret decrypts the account. A route that handed it out to whoever asked, or that took a
        // handle from the request body, would be a plain unauthenticated key-disclosure endpoint: the
        // attacker would not even need the password.
        const response = await fetch(`${base}/api/users/recovery-secret`);

        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain(PENDING_KEY);
    });

    test('🔑 once acknowledged it is never offered again — and that SURVIVES A RESTART', async () => {
        const { cookie, secret } = await loginAndAsk();
        expect(secret).toBe(PENDING_KEY);

        const acknowledged = await fetch(`${base}/api/users/recovery-secret/acknowledge`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });

        expect(acknowledged.status).toBe(204);

        // Gone, in this process...
        const asked = await fetch(`${base}/api/users/recovery-secret`, { headers: { Cookie: cookie } });
        expect((await asked.json()).secret).toBeNull();

        // 🔴 ...and gone after a RESTART, which is the half that actually matters. If the acknowledgement
        // lived only in RAM, every reboot would mint and offer a NEW key -- silently invalidating the one
        // already saved. Recovery would then fail after a restart.
        await server.stop();
        await boot();

        const afterRestart = await loginAndAsk();
        expect(afterRestart.secret).toBeNull();
    }, 240_000);
});

/**
 * 🟢 NO PROVIDER: SILLYTAVERN IS EXACTLY ITSELF.
 *
 * The other half of the rule, and the half that keeps this upstreamable. With no provider registered there
 * is no key, so there is nothing a reset could destroy, so the reset works precisely as it always has.
 *
 * This is not a courtesy test. If the guard fired when no provider was installed, the fork would have
 * broken account recovery for every ordinary SillyTavern user in exchange for nothing.
 */
describe('🟢 with no provider, the reset works exactly as upstream', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;

    beforeAll(async () => {
        scratch = makeScratchDirectory('recovery-plain');
        dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();
        await setPassword(dataRoot, PASSWORD);

        server = await startSillyTavern({ dataRoot, configPath, enableUserAccounts: true });
        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);
        base = `http://127.0.0.1:${server.port}`;
    }, 240_000);

    afterAll(async () => {
        await server?.stop();

        if (scratch) {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    test('🟢 /recover-step1 prints a code, and /recover-step2 takes it', async () => {
        const step1 = await post(base, '/api/users/recover-step1', { handle: 'default-user' });
        expect(step1.status).toBe(204);

        // The code goes to the server console. That is upstream's design, and it is exactly why this flow
        // cannot be trusted with a key — but with no key to lose, it is simply how SillyTavern works.
        const printed = server.output().match(/recovery code is: \D*(\d{6})/);
        expect(printed).not.toBeNull();

        const step2 = await post(base, '/api/users/recover-step2', {
            handle: 'default-user',
            code: printed[1],
            newPassword: NEW_PASSWORD,
        });
        expect(step2.status).toBe(204);

        // And it really did change the password.
        const login = await post(base, '/api/users/login', { handle: 'default-user', password: NEW_PASSWORD });
        expect(login.status).toBe(200);
    });

    test('🟢 a wrong code is still rejected', async () => {
        const { status } = await post(base, '/api/users/recover-step2', {
            handle: 'default-user',
            code: '000000',
            newPassword: 'nope',
        });

        expect(status).toBe(403);
    });

    test('🟢 the recovery-key route answers "nothing pending" instead of breaking', async () => {
        // A stock SillyTavern has no provider, so nothing ever mints a recovery secret, so this must be a
        // quiet null rather than a 500 -- and the client must simply not show a popup. The whole feature has
        // to be invisible when it is not in use, or it is not upstreamable.
        const login = await post(base, '/api/users/login', { handle: 'default-user', password: NEW_PASSWORD });
        expect(login.status).toBe(200);

        const response = await fetch(`${base}/api/users/recovery-secret`, { headers: { Cookie: login.cookie } });

        expect(response.status).toBe(200);
        expect((await response.json()).secret).toBeNull();
    });
});
