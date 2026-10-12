import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';
import { IDENTITY } from './fixtures/mixed-provider.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const MIXED_PROVIDER = path.join(testDirectory, 'fixtures', 'mixed-provider.js');

const PASSWORD = 'the-password';

/**
 * 🪪 §7 SURFACE 5 — "WHAT DID MY UNINSTALL TAKE WITH IT?", END TO END.
 *
 * Surfaces 1–4 answer for the one file in front of the user. This proves the panel that answers for the whole
 * account: walk the data root, tally the unavailable files by the provider they need and the kind of data
 * they are. The two things it has to get right are the two the walk can get wrong:
 *
 * - 🔴 **Readable data must not be counted.** The scan lists LOGICAL names and asks about LOGICAL paths, so a
 *   name-encrypting provider that is still installed reports its own live files as readable, not lost. Ask the
 *   on-disk mangled name instead and the panel would tell a user with a perfectly working vault that all of it
 *   is gone. Test 2 is that regression guard, and it runs with the provider present.
 * - 🔴 **The id is a key, never a source of truth.** A file naming a provider that was never installed here is
 *   counted under its bare id with no identity — it cannot introduce a provider. Test 4.
 *
 * The sequence mirrors the surface-4 suite: write real data through the provider, prove it reads back, then
 * DELETE the provider from disk and prove the account-wide tally is correct.
 */

/** A world written through the provider, so its on-disk bytes carry the envelope. */
const SECRET_WORLD = 'a-world-the-plugin-wrote';

/** A character written through the provider. */
const SECRET_CHARACTER = 'EncryptedPerson';

/**
 * Give the default user a password, so login has a secret to unlock the provider with.
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

describe('🪪 §7 surface 5 — one scan tells you what an uninstall took, grouped by provider', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let configPath;
    /** @type {string} */
    let providersPath;
    /** @type {import('./util/st-server.js').RunningServer|null} */
    let server = null;
    /** @type {string} */
    let base;
    /** @type {string|undefined} */
    let cookie;

    const userDir = () => path.join(dataRoot, 'default-user');

    /**
     * POST some JSON as the current session.
     * @param {string} route The route
     * @param {any} body The body
     * @returns {Promise<{status: number, body: any, text: string, cookie: string}>} The response
     */
    async function post(route, body) {
        const response = await fetch(`${base}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
            body: JSON.stringify(body),
        });

        const setCookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        const text = await response.text();

        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = text;
        }

        return { status: response.status, body: parsed, text, cookie: setCookie };
    }

    /**
     * Stop the running server and boot a fresh one against the same data root.
     *
     * 🔴 `provider: false` DELETES the provider from disk — the uninstall this suite is about.
     * @param {{provider: boolean}} options Whether the provider is installed for this boot
     * @returns {Promise<void>} When the new server is listening
     */
    async function reboot({ provider }) {
        if (server) {
            await server.stop();
            server = null;
        }

        cookie = undefined;

        if (!provider) {
            fs.rmSync(providersPath, { recursive: true, force: true });
        }

        server = await startSillyTavern({
            dataRoot,
            configPath,
            enableUserAccounts: true,
            ...(provider
                ? {
                    storageProvidersPath: providersPath,
                    providerEnv: {
                        ST_KEYED_STATE: path.join(scratch, 'vault-keys.json'),
                        ST_KEYED_HANDLE: 'default-user',
                        ST_KEYED_PASSWORD: PASSWORD,
                    },
                }
                : {}),
        });

        if (!server.listening) {
            throw new Error(`Boot ${provider ? 'with' : 'without'} provider failed.\n\n${server.output()}`);
        }

        base = `http://127.0.0.1:${server.port}`;
    }

    /**
     * Log in as the default user and keep the session cookie.
     * @returns {Promise<{status: number, body: any}>} The login response
     */
    async function login() {
        const result = await post('/api/users/login', { handle: 'default-user', password: PASSWORD });
        cookie = result.cookie || cookie;
        return result;
    }

    /**
     * Ask for the surface-5 summary.
     * @param {boolean} [refresh] Whether to bypass the cache
     * @returns {Promise<{status: number, body: any}>} The response
     */
    function summary(refresh = false) {
        return post('/api/storage/unavailable-summary', refresh ? { refresh: true } : {});
    }

    /**
     * Plant an enveloped file on disk under a logical name — an uninstalled provider's file as it looks with
     * nothing left to demangle it. Naming a provider id lets a single fixture stand in for any data type.
     * @param {string} relativePath Path under the default user's directory
     * @param {string} providerId The id to write into the envelope header
     * @returns {void}
     */
    function plantEnvelope(relativePath, providerId) {
        const absolute = path.join(userDir(), relativePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, `stenv:1:${providerId}:${Buffer.from('unreadable here').toString('base64')}`);
    }

    beforeAll(async () => {
        scratch = makeScratchDirectory('provenance-summary');
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);
        installStorageProvider(providersPath, MIXED_PROVIDER);
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    // 1 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('1. with the plugin installed, real data is written through it', async () => {
        await reboot({ provider: true });
        expect((await login()).status).toBe(200);

        expect((await post('/api/worldinfo/edit', {
            name: SECRET_WORLD,
            data: { entries: { 0: { uid: 0, key: ['k'], content: 'something the user wrote' } } },
        })).status).toBe(200);

        expect((await post('/api/characters/create', {
            ch_name: SECRET_CHARACTER, description: '', first_mes: '', file_name: SECRET_CHARACTER,
        })).status).toBe(200);

        // On disk under mangled names carrying the envelope, or the rest of the suite proves nothing.
        for (const [dir, ext] of [['worlds', '.json'], ['characters', '.png']]) {
            const enc = fs.readdirSync(path.join(userDir(), dir)).filter((n) => n.startsWith('enc~') && n.endsWith(ext));
            expect(enc).toHaveLength(1);
        }
    }, 120_000);

    // 2 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('2. 🔴 with the plugin INSTALLED, the summary is empty — live data is not reported as lost', async () => {
        const response = await summary(true);

        expect(response.status).toBe(200);
        expect(response.body.truncated).toBe(false);

        // The whole regression: the world and character above are on disk enveloped, but they read fine
        // through the installed provider. A summary that listed them would be telling a user with a working
        // vault that all of it is gone — the exact miscount the logical-name walk exists to prevent.
        expect(response.body.providers).toEqual([]);
    }, 120_000);

    // 3 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('3. 🔴 with the plugin GONE, every data type is tallied under the provider it needs', async () => {
        await reboot({ provider: false });
        expect((await login()).status).toBe(200);

        // The world and character survive from disk as enveloped files. Round out the account with one of
        // every other kind, planted as an uninstalled provider's file looks: a logical name, an envelope
        // naming the provider, the extension in the clear.
        plantEnvelope(path.join('chats', 'Test Character 1', 'a-chat.jsonl'), IDENTITY.id);
        plantEnvelope(path.join('group chats', 'a-group-chat.jsonl'), IDENTITY.id);
        plantEnvelope(path.join('groups', 'a-group.json'), IDENTITY.id);
        plantEnvelope(path.join('backgrounds', 'a-background.png'), IDENTITY.id);
        plantEnvelope('settings.json', IDENTITY.id);

        const response = await summary(true);
        expect(response.status).toBe(200);
        expect(response.body.truncated).toBe(false);

        const need = response.body.providers.find((p) => p.id === IDENTITY.id);
        expect(need).toBeDefined();

        // Every kind present, one each, all naming the real provider from the fork's own registry.
        expect(need.counts).toEqual({
            chat: 1, 'group-chat': 1, character: 1, world: 1, group: 1, background: 1, settings: 1,
        });
        expect(need.total).toBe(7);
        expect(need.identity.name).toBe(IDENTITY.name);
        expect(need.identity.source).toBe(IDENTITY.source);
    }, 120_000);

    // 4 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('4. 🔴 a file naming a provider that was never here gets its own bucket, bare id, no identity', async () => {
        // §4's trust model, in the aggregate: the id in a file is a lookup key. It can ask after a provider,
        // never introduce one. This is the case a user restoring someone else\'s data lands in.
        plantEnvelope(path.join('worlds', 'from-elsewhere.json'), 'never-installed');

        const response = await summary(true);
        const stranger = response.body.providers.find((p) => p.id === 'never-installed');

        expect(stranger).toBeDefined();
        expect(stranger.identity).toBeNull();
        expect(stranger.counts).toEqual({ world: 1 });

        // And it has NOT polluted the real provider's identity or counts.
        const need = response.body.providers.find((p) => p.id === IDENTITY.id);
        expect(need.identity.name).toBe(IDENTITY.name);
        expect(need.counts.world).toBe(1);
    }, 120_000);

    // 5 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('5. 🔴 an ordinary corrupt file is NOT blamed on a missing plugin', async () => {
        // Surface 4's boundary, restated for the aggregate. A truncated download or a hand-edited file has
        // nothing to do with an uninstall; only a parseable envelope is counted. This one must change no total.
        fs.writeFileSync(path.join(userDir(), 'worlds', 'just-broken.json'), '{ not json at all');

        const response = await summary(true);
        const need = response.body.providers.find((p) => p.id === IDENTITY.id);

        expect(need.counts.world).toBe(1);
        const stranger = response.body.providers.find((p) => p.id === 'never-installed');
        expect(stranger.counts.world).toBe(1);
    }, 120_000);

    // 6 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('6. providers are ordered most-affected first', async () => {
        const response = await summary(true);
        const totals = response.body.providers.map((p) => p.total);

        // mixed-provider (many) before never-installed (one), and never ascending.
        expect(totals).toEqual([...totals].sort((a, b) => b - a));
        expect(response.body.providers[0].id).toBe(IDENTITY.id);
    }, 120_000);

    // 7 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('7. the result is cached until asked to refresh', async () => {
        // A new planted file must NOT show up on a plain (cached) read, and MUST show up on a refresh. This is
        // the §11.3 behaviour: a full walk is expensive, so it is computed once and kept.
        plantEnvelope(path.join('worlds', 'planted-after-cache.json'), IDENTITY.id);

        const cached = await summary(false);
        const cachedNeed = cached.body.providers.find((p) => p.id === IDENTITY.id);
        expect(cachedNeed.counts.world).toBe(1);

        const fresh = await summary(true);
        const freshNeed = fresh.body.providers.find((p) => p.id === IDENTITY.id);
        expect(freshNeed.counts.world).toBe(2);
    }, 120_000);

    // 8 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('8. 🔴 an anonymous caller gets no summary', async () => {
        // Per-user data, and it must never become an anonymous oracle (§9 test 9, DESIGN_MIXED_MODE.md §10).
        const response = await fetch(`${base}/api/storage/unavailable-summary`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });

        expect(response.status).not.toBe(200);

        const text = await response.text();
        expect(text).not.toContain(IDENTITY.name);
        expect(text).not.toContain(IDENTITY.id);
    }, 120_000);
});
