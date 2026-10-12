import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(testDirectory);
const KEYED_PROVIDER = path.join(testDirectory, 'fixtures', 'keyed-provider.js');

const PASSWORD = 'the-original-password';
const RECOVERY_KEY = 'TEST_ONLY_RECOVERY_KEY_FIXTURE_0000000000000001';

/**
 * Give the default user a real password.
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
 * POST some JSON at the server.
 * @param {string} base Server base URL
 * @param {string} route The route
 * @param {object} body The body
 * @param {string} [cookie] A session cookie
 * @returns {Promise<{status: number, body: any, cookie: string}>} The response
 */
async function post(base, route, body, cookie) {
    const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
    });

    return {
        status: response.status,
        body: await response.json().catch(() => ({})),
        // Attributes (Path, HttpOnly, SameSite…) belong in a Set-Cookie, never in a Cookie. Send them back
        // and the session simply does not parse — which looks exactly like being logged out.
        cookie: response.headers.getSetCookie().map(c => c.split(';')[0]).join('; '),
    };
}

/**
 * GET something from the server.
 * @param {string} base Server base URL
 * @param {string} route The route
 * @param {string} cookie A session cookie
 * @returns {Promise<{status: number, body: any}>} The response
 */
async function get(base, route, cookie) {
    const response = await fetch(`${base}${route}`, { headers: { Cookie: cookie } });
    return { status: response.status, body: await response.json().catch(() => ({})) };
}

/**
 * Boot a SillyTavern with the keyed provider installed.
 * @param {string} label A name for the scratch directory
 * @param {boolean} silent True to install a provider with NO describe() and NO recover()
 * @returns {Promise<{server: any, base: string, dataRoot: string, scratch: string}>} The running server
 */
async function boot(label, silent) {
    const scratch = makeScratchDirectory(label);
    const dataRoot = path.join(scratch, 'data');
    const configPath = path.join(scratch, 'config.yaml');
    const providersPath = path.join(scratch, 'storage-providers');

    const seed = await startSillyTavern({ dataRoot, configPath });
    if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
    await seed.stop();

    await setPassword(dataRoot);
    installStorageProvider(providersPath, KEYED_PROVIDER);

    const server = await startSillyTavern({
        dataRoot,
        configPath,
        storageProvidersPath: providersPath,
        enableUserAccounts: true,
        providerEnv: {
            ST_KEYED_STATE: path.join(scratch, 'vault-keys.json'),
            ST_KEYED_HANDLE: 'default-user',
            ST_KEYED_PASSWORD: PASSWORD,
            ST_KEYED_RECOVERY_KEY: RECOVERY_KEY,
            // Long enough never to fire during these tests, but ENABLED — the idle warning has no text to
            // carry when there is no lock to warn about, which is itself correct and is why this is here.
            ST_KEYED_IDLE_LOCK_MS: String(10 * 60 * 1000),
            ...(silent ? { ST_KEYED_SILENT: '1' } : {}),
        },
    });

    if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);

    return { server, base: `http://127.0.0.1:${server.port}`, dataRoot, scratch };
}

/**
 * 🔴 THE FORK MUST NOT KNOW WHAT A PROVIDER IS.
 *
 * SillyTavern is public, generic, and meant to stay mergeable with upstream, where a storage provider might
 * be compression, or a remote object store, or nothing at all. The moment the fork hard-codes "your data is
 * encrypted" it has decided what every provider must be — and it has stopped being a fork of SillyTavern
 * and become ours.
 *
 * It had done exactly that, in six places, and the strings were true, and that is what made them so easy to
 * leave there.
 */
describe('🗣️  the provider speaks; the fork does not', () => {
    // ---- the static guard: no encryption vocabulary in the fork's own strings -------------------
    //
    // This one needs no server, and it is the test that makes the mistake unrepeatable. Everything else
    // here checks that the CURRENT six strings came out. This checks that a SEVENTH never goes in.

    test('🔴 no user-facing string in the fork mentions encryption, at all, anywhere', () => {
        /** Files that carry text to a user's eyes or to an operator's terminal. */
        const sources = [
            ...walk(path.join(serverDirectory, 'src')),
            ...walk(path.join(serverDirectory, 'public', 'scripts')),
            path.join(serverDirectory, 'recover.js'),
        ].filter(file => file.endsWith('.js'));

        // The vocabulary that ONLY makes sense if you know the provider encrypts. "lock", "unlock" and
        // "recovery key" are deliberately NOT here: they are the Storage Provider API's own words, they
        // appear in `storage.js` as `lock()` and `pendingRecoverySecret()`, and a compressing or remote
        // provider would use them too. These are the ones that give the game away.
        const tell = /encrypt|decrypt|ciphertext|plaintext|cipher|vault|unseal/i;

        /** @type {string[]} */
        const offenders = [];

        for (const file of sources) {
            const source = stripComments(fs.readFileSync(file, 'utf-8'));

            for (const [lineNumber, line] of source.split('\n').entries()) {
                for (const literal of line.match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? []) {
                    // Import specifiers and property lookups are code, not prose.
                    if (literal.length < 12 || /^['"`][./@a-z0-9_-]*['"`]$/i.test(literal)) {
                        continue;
                    }

                    if (tell.test(literal)) {
                        offenders.push(`${path.relative(serverDirectory, file)}:${lineNumber + 1}  ${literal.trim()}`);
                    }
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    // ---- a talkative provider: its words reach the user, verbatim -------------------------------

    describe('a provider with something to say', () => {
        /** @type {any} */ let server;
        /** @type {string} */ let base;
        /** @type {string} */ let scratch;

        beforeAll(async () => {
            ({ server, base, scratch } = await boot('text-loud', false));
        }, 90_000);

        afterAll(async () => {
            await server?.stop();
            if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
        });

        test('the refused reset carries the PROVIDER\'s reason, not one the fork invented', async () => {
            const { status, body } = await post(base, '/api/users/recover-step1', { handle: 'default-user' });

            expect(status).toBe(403);
            expect(body.error).toBe('FIXTURE: use the recovery key.');
            expect(body.recovery.title).toBe('FIXTURE cannot reset');
            expect(body.recovery.notes).toEqual(['FIXTURE note.']);

            // And it must say a recovery key will actually work — because for THIS provider, it will.
            expect(body.recoveryKeyRequired).toBe(true);
        });

        test('the recovery-key screen and the idle warning are written by the provider', async () => {
            const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
            expect(login.status).toBe(200);

            const cookie = login.cookie;

            const secret = await get(base, '/api/users/recovery-secret', cookie);
            expect(secret.status).toBe(200);
            expect(secret.body.secret).toBe(RECOVERY_KEY);
            expect(secret.body.text.title).toBe('FIXTURE save this');

            // The warning has to be ASKED FOR before there is anything to warn about: since 2026-07-27 the
            // provider's `ST_KEYED_IDLE_LOCK_MS` only recommends, and a user who has not chosen a lock is
            // correctly told nothing at all. Ten minutes, so it cannot fire during this suite.
            const armed = await post(base, '/api/users/idle-lock', { minutes: 10 }, cookie);
            expect(armed.status).toBe(200);

            const idle = await get(base, '/api/users/idle-status', cookie);
            expect(idle.status).toBe(200);
            expect(idle.body.text.title).toBe('FIXTURE locking');
        });

        test('the provider draws the change-password dialog: its boxes, its labels, its button', async () => {
            const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
            const form = await get(base, '/api/users/password-form?handle=default-user', login.cookie);

            expect(form.status).toBe(200);
            expect(form.body.text.title).toBe('FIXTURE change password');
            expect(form.body.text.submitLabel).toBe('FIXTURE submit');
            expect(form.body.text.fields.map(f => f.name)).toEqual(['current', 'password', 'confirm']);
            expect(form.body.text.fields.every(f => f.required)).toBe(true);
        });

        /**
         * 🔑 THE "NEW RECOVERY KEY" BUTTON, AND THE ONE THING THAT MAKES IT SAFE.
         *
         * A recovery key opens the account FOR EVER, from anywhere, with nothing else. Minting one needs only
         * what the provider already holds while the user is signed in — so a button that issued one on the
         * strength of a live session alone would be a one-click key-theft tool for anybody who reached one: a
         * borrowed desk, a stolen cookie, a hostile UI extension. The key they took would outlive the logout,
         * the restart and the idle lock, which are the whole boundary of this design.
         *
         * SillyTavern's job is to give them somewhere to type the password and to CARRY IT. If the fork ever
         * stops passing it, no provider can enforce anything — which is exactly the capability hole the
         * Current Password field had, and this is the test that would notice.
         */
        test('🔴 a new recovery key REQUIRES the password — being logged in is not enough', async () => {
            const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
            const cookie = login.cookie;

            // The session is live and the provider is unlocked. That must buy exactly nothing.
            const refused = await post(base, '/api/users/recovery-secret/regenerate', { password: 'not-the-password' }, cookie);
            expect(refused.status).toBe(403);
            expect(refused.body.error).toBe('Enter your current password. Being signed in is not knowing it.');

            const empty = await post(base, '/api/users/recovery-secret/regenerate', {}, cookie);
            expect(empty.status).toBe(403);
        });

        test('🔑 with the password, a NEW key is issued and offered — and the nag is re-armed', async () => {
            const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
            const cookie = login.cookie;

            // Establish what is pending BEFORE, or "a new key was issued" is a claim about nothing.
            const before = await get(base, '/api/users/recovery-secret', cookie);
            expect(before.body.secret).toBe(RECOVERY_KEY);

            // The user says they have saved it. Nothing should be pending now.
            const ack = await post(base, '/api/users/recovery-secret/acknowledge', {}, cookie);
            expect(ack.status).toBe(204);
            expect((await get(base, '/api/users/recovery-secret', cookie)).body.secret).toBeNull();

            // Now ask for a new one, with the password.
            const issued = await post(base, '/api/users/recovery-secret/regenerate', { password: PASSWORD }, cookie);
            expect(issued.status).toBe(204);

            // 🔴 And it is OFFERED. A key that is minted and never put in front of the user leaves the
            // account with a recovery wrap whose key exists nowhere — healthy-looking, and unrecoverable.
            const after = await get(base, '/api/users/recovery-secret', cookie);
            expect(after.body.secret).toBeTruthy();
            expect(after.body.secret).not.toBe(RECOVERY_KEY);
        });

        test('the button is offered, and the provider writes its dialog', async () => {
            const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
            const capability = await get(base, '/api/users/recovery-secret/capability', login.cookie);

            expect(capability.status).toBe(200);
            expect(capability.body.canRegenerate).toBe(true);
            expect(capability.body.text.title).toBe('FIXTURE new key');
        });

        test('🔴 a REFUSAL is repeated verbatim — the fork must never paraphrase one it does not understand', async () => {
            const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });

            // The fixture demands the old password even when the vault is open, and says so in its own
            // words. Those words, and not a summary of them, are what the user has to read.
            const { status, body } = await post(base, '/api/users/change-password', {
                handle: 'default-user',
                oldPassword: 'not-the-password',
                newPassword: 'something-new',
            }, login.cookie);

            expect(status).toBe(403);
            expect(body.error).toBe('Enter your current password to change it. Being signed in proves the vault is open, not who opened it.');
        });
    });

    // ---- a silent provider: SillyTavern falls back to ITS OWN text, and claims nothing ----------
    //
    // 🔴 THIS IS THE HALF THAT PROVES THE DESIGN. A fork that only behaves when the provider is chatty has
    // not removed its hard-coded strings — it has moved them into a fallback branch and stopped testing it.

    describe('a provider with nothing to say, and no way back in', () => {
        /** @type {any} */ let server;
        /** @type {string} */ let base;
        /** @type {string} */ let scratch;

        beforeAll(async () => {
            ({ server, base, scratch } = await boot('text-silent', true));
        }, 90_000);

        afterAll(async () => {
            await server?.stop();
            if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
        });

        test('the reset is still refused, and the reason claims NOTHING about what the provider is', async () => {
            const { status, body } = await post(base, '/api/users/recover-step1', { handle: 'default-user' });

            expect(status).toBe(403);
            expect(body.error).not.toMatch(/encrypt|decrypt|cipher|vault/i);
            expect(body.recovery).toBeNull();
        });

        test('🔴 no recover() means NO RECOVERY PROMPT — do not send the user to a box they can never fill', async () => {
            const { status, body } = await post(base, '/api/users/recover-step1', { handle: 'default-user' });

            expect(status).toBe(403);

            // This provider owns the user and has no way back in. Saying "use your recovery key" would be
            // the same dead end as printing a refusal with nothing behind it: a door drawn on a wall.
            //
            // `recoveryKeyRequired` used to be hard-coded `true` here, and the client would have opened the
            // recovery-key form. The server has to ASK `canRecover()`, and answer honestly.
            expect(body.recoveryKeyRequired).toBe(false);
        });

        test('🔴 a provider that cannot issue a new key gets NO BUTTON — never offer what can only fail', async () => {
            const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
            const capability = await get(base, '/api/users/recovery-secret/capability', login.cookie);

            expect(capability.status).toBe(200);
            expect(capability.body.canRegenerate).toBe(false);
            expect(capability.body.text).toBeNull();
        });

        test('the recovery-key screen and the idle warning carry no invented prose', async () => {
            const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
            expect(login.status).toBe(200);

            const secret = await get(base, '/api/users/recovery-secret', login.cookie);
            expect(secret.status).toBe(200);

            // The secret is STILL SHOWN — failing to show it is the one outcome that cannot be undone —
            // but SillyTavern has nothing to say about why it matters, so it says nothing.
            expect(secret.body.secret).toBe(RECOVERY_KEY);
            expect(secret.body.text).toBeNull();

            const form = await get(base, '/api/users/password-form?handle=default-user', login.cookie);
            expect(form.body.text).toBeNull();
        });
    });
});

/**
 * Every .js file beneath a directory.
 * @param {string} root Where to start
 * @returns {string[]} Absolute paths
 */
function walk(root) {
    /** @type {string[]} */
    const found = [];

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);

        if (entry.isDirectory()) {
            found.push(...walk(full));
        } else if (entry.isFile()) {
            found.push(full);
        }
    }

    return found;
}

/**
 * Remove comments, so that the scan sees only what the code actually SAYS.
 *
 * The fork's comments discuss encryption constantly, and they should: they explain why the seams are where
 * they are. A comment is not shown to anybody. A string literal is.
 * @param {string} source JavaScript source
 * @returns {string} The same source with comments blanked, line count preserved
 */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_match, prefix) => prefix);
}
