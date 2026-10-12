import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const MIXED_PROVIDER = path.join(testDirectory, 'fixtures', 'mixed-provider.js');

const PASSWORD = 'the-password';
const RECOVERY_KEY = 'TEST_ONLY_RECOVERY_KEY_FIXTURE_0000000000000001';

/**
 * 🔒 THE PER-CHAT MARKER MUST NOT BECOME AN ORACLE — `DESIGN_MIXED_MODE.md` §10, tests 15 and 16.
 *
 * ⚠️ THE TRAP THIS SUITE IS BUILT TO AVOID, in the words of `storage-provider-login-oracle.test.js`:
 * *"'no leak found' is equally true of a system that cannot leak and a system that has nothing to leak.
 * That is the vacuous green this project has produced five of."*
 *
 * So every refusal asserted here is preceded by proving the same request SUCCEEDS for an authenticated
 * caller and returns the very thing the anonymous caller must not get. A 401 on an endpoint that would have
 * answered "no such chat" anyway proves nothing.
 *
 * Two properties, and they fail in different directions:
 *
 * 1. **The per-chat endpoint is authenticated.** An anonymous caller must not learn whether a chat exists,
 *    let alone whether it is encrypted or which provider wrote it. `POST /api/users/list` already hands
 *    unauthenticated callers every handle on the box, so any per-chat flag reachable without a session
 *    turns that into a targeting list.
 * 2. **The anonymous instance endpoint does not vary with lock state.** A `/api/storage/status` that
 *    differed between a locked and an unlocked vault lets anyone on the network poll it and learn exactly
 *    when a user is logged in.
 */

/** The plaintext chat: created before the provider arrives, and it stays readable for ever (§1). */
const LEGACY_CHAT = 'legacy.jsonl';

/** The encrypted chat: created while the provider is installed. */
const ENCRYPTED_CHAT = 'secret.jsonl';

/**
 * Give the default user a real password, so the provider has something to key itself from.
 * @param {string} dataRoot The data root
 * @returns {Promise<void>} When the password is set
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
 * @returns {Promise<{status: number, body: any, cookie: string, text: string}>} The response
 */
async function post(base, route, body, cookie) {
    const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
    });

    const setCookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const text = await response.text();

    // A refusal is not JSON -- express sends the bare word "Forbidden" -- and the refusal is half of what
    // this suite exists to observe, so parsing optimistically would turn the RIGHT answer into a crash.
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }

    return { status: response.status, body: parsed, cookie: setCookie, text };
}

describe('🔒 the per-chat storage marker is authenticated (§12 test 15)', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let cookie;

    beforeAll(async () => {
        scratch = makeScratchDirectory('chat-status-oracle');
        dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);

        // 🔴 PLANT A REAL PLAINTEXT CHAT BEFORE THE PROVIDER EXISTS. Without this the mixed-mode half of
        // the assertions below is decorative -- there would be nothing for the provider to pass through.
        const chatsDirectory = path.join(dataRoot, 'default-user', 'chats');
        fs.mkdirSync(chatsDirectory, { recursive: true });
        fs.writeFileSync(path.join(chatsDirectory, LEGACY_CHAT), '{"name":"from before the plugin"}\n');

        installStorageProvider(providersPath, MIXED_PROVIDER);

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

        const login = await post(base, '/api/users/login', { handle: 'default-user', password: PASSWORD });
        cookie = login.cookie;

        // An encrypted chat, written through the provider now that it is installed. Written with raw fs
        // under the provider's own on-disk shape would be cheating; this goes through the running server.
        const encryptedPath = path.join(chatsDirectory, ENCRYPTED_CHAT);
        // The fixture encodes only the stem and keeps the real extension in the clear, so an uninstalled
        // encrypted chat still passes the `.jsonl` listers (see mixed-provider.js NAME_PREFIX). Match that
        // shape by hand here: `enc~<base64url(stem)><ext>`.
        const markedName = `enc~${Buffer.from(path.parse(ENCRYPTED_CHAT).name, 'utf-8').toString('base64url')}${path.extname(ENCRYPTED_CHAT)}`;
        fs.writeFileSync(
            path.join(chatsDirectory, markedName),
            `stenv:1:mixed-provider:${Buffer.from('{"name":"after the plugin"}\n', 'utf-8').toString('base64')}`,
        );

        // A setup sanity check, as a guard rather than an `expect` — the linter reserves `expect` for test
        // blocks, and this is a beforeAll. If the encrypted chat somehow landed under its plaintext name the
        // whole premise of the suite is wrong, so fail the boot loudly instead of testing a lie.
        if (fs.existsSync(encryptedPath)) {
            throw new Error(`Setup error: encrypted chat was written under its plaintext name ${encryptedPath}`);
        }
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    test('🔴 FIRST, prove the data is there: an authenticated caller gets a real answer', async () => {
        const answer = await post(base, '/api/storage/chat-status', {
            chats: [LEGACY_CHAT, ENCRYPTED_CHAT],
        }, cookie);

        expect(answer.status).toBe(200);

        // The mixed-mode property itself, end to end through a live server: one account, two chats, one
        // encrypted and one not, both reported in a single answer.
        expect(answer.body.chats[ENCRYPTED_CHAT].encrypted).toBe(true);
        expect(answer.body.chats[LEGACY_CHAT].encrypted).toBe(false);
    });

    test('🔴 the SAME request without a session is refused, and leaks neither chat', async () => {
        const anonymous = await post(base, '/api/storage/chat-status', {
            chats: [LEGACY_CHAT, ENCRYPTED_CHAT],
        });

        // 🔴 PINNED TO 403, NOT >= 400. An earlier version of this test asserted only "some error", and it
        // passed even with the router mounted ABOVE the auth boundary -- because the handler then crashed
        // on a missing request.user and returned 500, which is >= 400 and carries no chat names either.
        // A test that cannot tell a refusal from a crash is the vacuous green this file's header warns
        // about, so the refusal is pinned exactly.
        expect(anonymous.status).toBe(403);
        expect(anonymous.text).toBe('Forbidden');

        // Not merely "not 200" -- the response must not carry the chat names, the marker, or the provider
        // id. An anonymous caller must not even learn that these chats exist.
        expect(anonymous.text).not.toContain(ENCRYPTED_CHAT);
        expect(anonymous.text).not.toContain(LEGACY_CHAT);
        expect(anonymous.text).not.toContain('mixed-provider');
        expect(anonymous.text).not.toContain('encrypted');
    });

    test('🔴 the provider id never appears in the ANONYMOUS instance endpoint', async () => {
        const status = await fetch(`${base}/api/storage/status`);
        const text = await status.text();

        // §3.1 accepts naming the provider on disk and through an authenticated endpoint. This is neither.
        expect(status.status).toBe(200);
        expect(text).not.toContain('mixed-provider');
        expect(JSON.parse(text)).toHaveProperty('enabled', true);
    });

    test('🔴 /api/storage/status is byte-identical logged out and logged in (§12 test 16)', async () => {
        // A response that varied with lock state lets anyone on the network poll it and learn exactly when
        // a user is logged in. The vault is unlocked right now -- a session was established in beforeAll --
        // so an anonymous read taken now must match one taken with the session cookie attached.
        const anonymous = await fetch(`${base}/api/storage/status`);
        const anonymousText = await anonymous.text();

        const authenticated = await fetch(`${base}/api/storage/status`, { headers: { Cookie: cookie } });
        const authenticatedText = await authenticated.text();

        expect(anonymousText).toBe(authenticatedText);
    });
});
