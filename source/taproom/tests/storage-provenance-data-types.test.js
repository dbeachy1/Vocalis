import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';
import { ENVELOPE_HEADER, IDENTITY } from './fixtures/mixed-provider.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const MIXED_PROVIDER = path.join(testDirectory, 'fixtures', 'mixed-provider.js');

const PASSWORD = 'the-password';

/**
 * 🪪 §7 SURFACE 4 — THE THINGS THAT ARE NOT CHATS ALSO SURVIVE AN UNINSTALL.
 *
 * `storage-provenance-endpoint.test.js` proves the claim for chats. This proves it for the rest of the data
 * root, and it exists because the two failures are not the same failure and neither is a display bug:
 *
 * - **A character card is DROPPED.** With the provider gone the read is plain `fs`, so it succeeds and hands
 *   the PNG parser an envelope. That is not a storage error, so `processCharacter` returns a nameless stub
 *   and `/api/characters/all` filters it out. The library renders short, or empty, and says nothing at all.
 * - 🔴 **A world info file is kept, EMPTIED, and left EDITABLE.** `tryParse` returns undefined for bytes that
 *   are not JSON, and the handler's `|| {}` turned that into a world with no entries — one that lists, opens
 *   and edits like an ordinary empty world, sitting directly on top of the user's real one. The next save
 *   writes over it. This is the one that loses data rather than merely hiding it, and it is why surface 4 is
 *   not cosmetic.
 *
 * Both must instead come back NAMED: the entry present, the provider id on it, and the identity the fork
 * recorded while that provider was running here (§4). The sequence below is the same one the chat suite
 * uses, and each step has to be real for the next to mean anything — in particular the provider is DELETED
 * from disk, not merely left unconfigured.
 */

/** Written through the provider, so its bytes carry an envelope naming it. */
const SECRET_WORLD = 'a-world-written-by-the-plugin';

/** Ditto, as a character card. */
const SECRET_CHARACTER = 'SomeoneEncrypted';

/** Ditto, as a group definition — the fifth data type (§12.3). */
const SECRET_GROUP = 'A Secret Group';

/**
 * Give the default user a real password, so login has a secret to unlock the provider with.
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

describe('🪪 §7 surface 4 — a character and a world outlive the plugin that wrote them', () => {
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

    const worldsDir = () => path.join(dataRoot, 'default-user', 'worlds');
    const charactersDir = () => path.join(dataRoot, 'default-user', 'characters');
    const groupsDir = () => path.join(dataRoot, 'default-user', 'groups');

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
     * 🔴 `provider: false` DELETES the provider from disk. "Installed but unused" is a different situation
     * from the uninstall this suite is about.
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

    beforeAll(async () => {
        scratch = makeScratchDirectory('provenance-data-types');
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
    test('1. with the plugin installed, a world and a character are written through it', async () => {
        await reboot({ provider: true });
        expect((await login()).status).toBe(200);

        expect((await post('/api/worldinfo/edit', {
            name: SECRET_WORLD,
            data: { entries: { 0: { uid: 0, key: ['secret'], content: 'something the user wrote' } } },
        })).status).toBe(200);

        expect((await post('/api/characters/create', {
            ch_name: SECRET_CHARACTER, description: '', first_mes: '', file_name: SECRET_CHARACTER,
        })).status).toBe(200);

        // A GROUP DEFINITION too — the fifth data type (§12.3). Written through the provider, so its
        // groups/<id>.json is enveloped and disappears the same way once the plugin is gone.
        expect((await post('/api/groups/create', { name: SECRET_GROUP, members: [] })).status).toBe(200);

        // All three are on disk under mangled names carrying the fixture's envelope. If this ever stops being
        // true the rest of the suite is testing plaintext and proves nothing.
        for (const [directory, extension] of [[worldsDir(), '.json'], [charactersDir(), '.png'], [groupsDir(), '.json']]) {
            const enc = fs.readdirSync(directory).filter((name) => name.startsWith('enc~') && name.endsWith(extension));
            expect(enc).toHaveLength(1);
            expect(fs.readFileSync(path.join(directory, enc[0]), 'utf-8').startsWith(ENVELOPE_HEADER)).toBe(true);
        }
    }, 120_000);

    // 2 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('2. with the plugin installed, both read back normally and carry no unavailable state', async () => {
        // The regression guard for everything below: the new branches must fire ONLY when the provider is
        // gone. A `storage` field appearing here would mean the fork had started disabling readable data.
        const worlds = await post('/api/worldinfo/list', {});
        const world = worlds.body.find((w) => w.file_id === SECRET_WORLD);

        expect(world).toBeDefined();
        expect(world.storage).toBeUndefined();

        const characters = await post('/api/characters/all', {});
        const character = characters.body.find((c) => c.avatar === `${SECRET_CHARACTER}.png`);

        expect(character).toBeDefined();
        expect(character.storage).toBeUndefined();
        expect(character.name).toBe(SECRET_CHARACTER);
    }, 120_000);

    // 3 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('3. 🔴 with the plugin GONE, the world is still listed — and is NOT an empty editable world', async () => {
        await reboot({ provider: false });
        expect((await login()).status).toBe(200);

        const response = await post('/api/worldinfo/list', {});
        expect(response.status).toBe(200);

        // The row survives under its on-disk name. That name is scrambled, which is correct — the real one
        // was inside the crypto and the thing that could undo that is what got uninstalled.
        const world = response.body.find((w) => w.storage);
        expect(world).toBeDefined();

        // 🔴 THE ASSERTION THAT IS THE WHOLE POINT. Before this change the entry came back with no `storage`
        // at all and `extensions: {}` — indistinguishable, to the client, from a world the user had genuinely
        // left empty. The client would then happily open an editor over it.
        expect(world.storage.unavailable).toBe(true);
        expect(world.storage.requiresProvider).toBe(IDENTITY.id);
        expect(world.storage.identity.name).toBe(IDENTITY.name);
        expect(world.storage.identity.source).toBe(IDENTITY.source);
    }, 120_000);

    // 4 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('4. 🔴 with the plugin GONE, the character card is still in the library rather than dropped', async () => {
        const response = await post('/api/characters/all', {});
        expect(response.status).toBe(200);

        const character = response.body.find((c) => c.storage);
        expect(character).toBeDefined();

        // It has to carry a `name`, because `/all` filters on exactly that — the stub without one is how the
        // card used to disappear. The filename is the only name that is certainly true once the plugin that
        // knew the real one is gone.
        expect(character.name).toBeTruthy();
        expect(character.storage.unavailable).toBe(true);
        expect(character.storage.requiresProvider).toBe(IDENTITY.id);
        expect(character.storage.identity.name).toBe(IDENTITY.name);
    }, 120_000);

    // 5 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('5. 🔴 opening the unreadable world refuses and says which plugin, instead of a bare 500', async () => {
        const worlds = await post('/api/worldinfo/list', {});
        const world = worlds.body.find((w) => w.storage);

        const response = await post('/api/worldinfo/get', { name: world.file_id });

        // Fail-closed AND explicable. `{ entries: {} }` here would be the same data-losing lie as the list
        // entry; a 500 was already fail-closed but told the user only "something went wrong".
        expect(response.status).toBe(409);
        expect(response.body.storage.requiresProvider).toBe(IDENTITY.id);
        expect(response.body.storage.identity.name).toBe(IDENTITY.name);
    }, 120_000);

    // 6 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('6. 🔴 an ordinary corrupt file is NOT blamed on a missing plugin', async () => {
        // §7 surface 4's boundary. A truncated download or a hand-edited file has nothing to do with an
        // uninstall, and telling a user to go and reinstall something would send them hunting for a plugin
        // they never had. Only a parseable envelope earns the sentence.
        fs.writeFileSync(path.join(worldsDir(), 'just-broken.json'), '{ this is not json');
        fs.writeFileSync(path.join(charactersDir(), 'just-broken.png'), 'not a png either');

        const worlds = await post('/api/worldinfo/list', {});
        const broken = worlds.body.find((w) => w.file_id === 'just-broken');

        // It lists (that behaviour is unchanged) but it must not claim a provider.
        expect(broken?.storage).toBeUndefined();

        const characters = await post('/api/characters/all', {});
        expect(characters.body.find((c) => c.avatar === 'just-broken.png')).toBeUndefined();
    }, 120_000);

    // 7 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('7. 🔴 unreadable SETTINGS refuse by name, rather than looking like an empty settings file', async () => {
        // The costliest silent version of all four. `storage.readFileSync` does not throw with no provider
        // registered — it is plain `fs`, so it succeeds and returns the envelope — and this endpoint used to
        // pass that on as `settings`, a string the client hands to `JSON.parse`. Every setting the user has
        // ever chosen, one throw away from the client concluding it has none and saving its defaults over
        // the file. `settings: null` would be the politer answer and the wrong one for the same reason.
        const settingsPath = path.join(dataRoot, 'default-user', 'settings.json');
        fs.writeFileSync(settingsPath, `${ENVELOPE_HEADER}bm90IHJlYWRhYmxlIGhlcmU=`);

        const response = await post('/api/settings/get', {});

        expect(response.status).toBe(409);
        expect(response.body.settings).toBeUndefined();
        expect(response.body.storage.requiresProvider).toBe(IDENTITY.id);
        expect(response.body.storage.identity.name).toBe(IDENTITY.name);
    }, 120_000);

    // 8 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('8. a BACKGROUND whose plugin is gone is marked, instead of rendering as a broken image', async () => {
        // The mildest failure and the most baffling to look at: `mime.lookup` is satisfied by the scrambled
        // name's surviving `.png`, so the background lists happily and then draws as a broken image with
        // nothing anywhere saying the picture is fine and the thing that reads it is missing.
        fs.writeFileSync(path.join(dataRoot, 'default-user', 'backgrounds', 'enc~Zm9v.png'), `${ENVELOPE_HEADER}Zm9v`);

        const response = await post('/api/backgrounds/all', {});
        expect(response.status).toBe(200);

        const marked = response.body.images.find((image) => image.storage);
        expect(marked).toBeDefined();
        expect(marked.storage.requiresProvider).toBe(IDENTITY.id);
        expect(marked.storage.identity.name).toBe(IDENTITY.name);

        // And the ordinary ones are untouched — no `storage` key on a background that reads fine.
        expect(response.body.images.some((image) => !image.storage)).toBe(true);
    }, 120_000);

    // 9 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('9. 🔴 a planted file naming a provider that was never here gets its bare id and no identity', async () => {
        // §9.3, restated for surface 4. This is the case a user restoring someone else's data lands in, and
        // the case §4's trust model exists to keep boring: the id in the file is a KEY for a lookup, never a
        // source of truth. Nothing in a file can introduce a provider to this fork.
        fs.writeFileSync(path.join(worldsDir(), 'from-somewhere-else.json'), 'stenv:1:never-installed:not readable here');

        const worlds = await post('/api/worldinfo/list', {});
        const planted = worlds.body.find((w) => w.file_id === 'from-somewhere-else');

        expect(planted.storage.unavailable).toBe(true);
        expect(planted.storage.requiresProvider).toBe('never-installed');
        expect(planted.storage.identity).toBeNull();
    }, 120_000);

    // 10 ─────────────────────────────────────────────────────────────────────────────────────────────────
    test('10. 🔴 the GROUP DEFINITION whose plugin is gone is still listed, named — not dropped', async () => {
        // §12.3. The group written through the provider in test 1 is enveloped on disk. With the plugin gone,
        // `/api/groups/all` reads it as plain `fs`, hands `JSON.parse` an envelope, and used to log-and-drop —
        // the definition vanished and the group read as deleted. It must come back, named by what it needs.
        const response = await post('/api/groups/all', {});
        expect(response.status).toBe(200);

        const group = response.body.find((g) => g.storage);
        expect(group).toBeDefined();
        expect(group.storage.unavailable).toBe(true);
        expect(group.storage.requiresProvider).toBe(IDENTITY.id);
        expect(group.storage.identity.name).toBe(IDENTITY.name);

        // It carries the fields the client's list code touches, so a stub can never crash the group list.
        expect(group.id).toBeTruthy();
        expect(group.name).toBeTruthy();
        expect(Array.isArray(group.chats)).toBe(true);
        expect(Array.isArray(group.members)).toBe(true);
    }, 120_000);

    // 11 ─────────────────────────────────────────────────────────────────────────────────────────────────
    test('11. 🔴 an ordinary corrupt group definition is NOT blamed on a missing plugin', async () => {
        // Surface 4's boundary again: a hand-edited or truncated group JSON has nothing to do with an
        // uninstall. It falls through to the existing log, and is NOT resurrected as an unavailable stub.
        fs.writeFileSync(path.join(groupsDir(), 'just-broken.json'), '{ not json');

        const response = await post('/api/groups/all', {});
        const broken = response.body.find((g) => g.id === 'just-broken');

        expect(broken).toBeUndefined();

        // And the real unavailable group is still the only one carrying a storage marker.
        expect(response.body.filter((g) => g.storage)).toHaveLength(1);
    }, 120_000);
});
