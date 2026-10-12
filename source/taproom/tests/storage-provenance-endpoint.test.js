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
const RECOVERY_KEY = 'TEST_ONLY_RECOVERY_KEY_FIXTURE_0000000000000001';

/**
 * 🪪 THE WHOLE POINT OF THE PROVENANCE REGISTRY, END TO END — `DESIGN_STORAGE_PROVENANCE.md` §9 tests 1, 3, 6.
 *
 * Every other suite for this feature tests a function. This one tests the CLAIM: that a user who uninstalls
 * a storage provider is told, by name, what they need to put back — with that provider gone from the disk,
 * from the process, and from the config, across a server restart.
 *
 * The sequence is the design's own, and each step has to be real for the next to mean anything:
 *
 *   1. Boot with the provider installed. It declares itself; the fork records it while it can be trusted.
 *   2. Write a chat through it, so there are bytes on disk whose envelope names that provider.
 *   3. DELETE the provider from the storage-providers directory and boot again. Nothing in the process
 *      knows what `mixed-provider` is any more — the only trace is a slug in a file header and the fork's
 *      own record.
 *   4. Ask the marker endpoint. It must produce the plugin's NAME.
 *
 * ## 🔴 The two assertions that stop this being a feature that only works in the happy case
 *
 * A planted chat naming a provider that was never installed here must get nothing but its bare id (§9.3) —
 * that is the case §4's trust model exists to keep boring, and the case a user restoring someone else's
 * backup lands in. And deleting the registry between boots must return the fork to exactly its old
 * behaviour (§9.6), because §5 makes this an enrichment and never a dependency.
 */

/** Created while the provider is installed: enveloped, and its header names the provider. */
const SECRET_CHAT = 'a-chat-written-by-the-plugin';

/** A chat planted by hand whose envelope names a provider that was NEVER installed on this instance. */
const PLANTED_CHAT = 'a-chat-from-somewhere-else';

/** The id that planted chat claims. Well-formed, so it survives validation — and still unknown. */
const PLANTED_PROVIDER_ID = 'never-installed';

/** The character directory both chats live under. */
const CHARACTER = 'Someone';

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

/** A minimal but well-formed chat: a metadata header line, then one message. */
function chatBody(marker) {
    return [
        { user_name: 'User', character_name: CHARACTER, create_date: '2026-07-20', chat_metadata: {} },
        { name: CHARACTER, is_user: false, mes: `hello from ${marker}`, send_date: '2026-07-20' },
    ];
}

describe('🪪 a provider that is gone is still named, because the fork watched it run', () => {
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

    /**
     * The name the provider actually wrote the secret chat under.
     *
     * 🔴 THE MANGLED NAME IS WHAT SURVIVES THE UNINSTALL, AND ASKING FOR THE LOGICAL ONE PROVES NOTHING.
     * The fixture encrypts filenames, so `a-chat-written-by-the-plugin.jsonl` exists only as something the
     * provider could demangle — and the provider is the thing that is gone. With it uninstalled, the row a
     * user sees in the chat list is built by scanning the directory, so it carries the scrambled name, and
     * that is the name the marker endpoint is asked about. A test that asked for the logical name would
     * resolve nothing, get "ordinary file" back, and be asserting against the wrong file entirely.
     * @type {string}
     */
    let secretOnDiskName;

    const chatsDir = () => path.join(dataRoot, 'default-user', 'chats', CHARACTER);
    const registryPath = () => path.join(scratch, 'providers.json');

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
     * 🔴 `provider: false` DELETES THE PROVIDER FROM DISK rather than merely not pointing at it. Not
     * configuring a path would leave the plugin sitting there, and "the plugin is installed but unused" is a
     * different situation from the one this suite is about. An uninstall is an uninstall.
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
                        ST_KEYED_RECOVERY_KEY: RECOVERY_KEY,
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
     * Ask the per-chat marker endpoint about some chats in this character's directory.
     * @param {string[]} names Chat file names
     * @returns {Promise<any>} The response
     */
    const status = (names) => post('/api/storage/chat-status', {
        chats: names.map((name) => ({ name, directory: CHARACTER })),
    });

    beforeAll(async () => {
        scratch = makeScratchDirectory('provenance-endpoint');
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);

        // 🔴 PLANTED WITH RAW `fs`, AND ITS ENVELOPE NAMES A PROVIDER THIS INSTANCE HAS NEVER RUN. This is
        // the file that models a restored backup from another machine — or an attacker writing into the
        // data directory, which the whole threat model assumes is possible. Its id is well-formed, so it
        // sails through the envelope parser's character class and reaches the registry as a real lookup.
        fs.mkdirSync(chatsDir(), { recursive: true });
        fs.writeFileSync(
            path.join(chatsDir(), `${PLANTED_CHAT}.jsonl`),
            `stenv:1:${PLANTED_PROVIDER_ID}:this is not readable by anything here\n`,
        );

        installStorageProvider(providersPath, MIXED_PROVIDER);
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    // 1 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('1. the provider declares itself on load, and the fork writes that down outside the data root', async () => {
        await reboot({ provider: true });
        expect((await login()).status).toBe(200);

        expect((await post('/api/chats/save', {
            ch_name: CHARACTER, file_name: SECRET_CHAT, chat: chatBody('the plugin'), avatar_url: `${CHARACTER}.png`, force: true,
        })).status).toBe(200);

        // The bytes on disk carry the envelope, and its third field is the key everything below turns on.
        const onDisk = fs.readdirSync(chatsDir()).filter((name) => name.startsWith('enc~'));
        expect(onDisk).toHaveLength(1);
        secretOnDiskName = onDisk[0];
        expect(fs.readFileSync(path.join(chatsDir(), secretOnDiskName), 'utf-8').startsWith(ENVELOPE_HEADER)).toBe(true);

        // 🔴 §9 test 7, asserted on the real path rather than on the intention: the registry is beside
        // config.yaml and NOT under the data root, because a registry an attacker could write would be a
        // more convincing forgery than the planted chat it is meant to explain.
        expect(fs.existsSync(registryPath())).toBe(true);
        expect(registryPath().startsWith(path.resolve(dataRoot))).toBe(false);

        const recorded = JSON.parse(fs.readFileSync(registryPath(), 'utf-8')).providers[IDENTITY.id];
        expect(recorded).toMatchObject({ id: IDENTITY.id, name: IDENTITY.name, version: IDENTITY.version });
        expect(recorded.firstSeen).toEqual(expect.any(String));
    }, 240_000);

    // 2 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('2. 🔴 with the plugin GONE, the chat is still named — by the plugin\'s name, not its slug', async () => {
        await reboot({ provider: false });
        expect((await login()).status).toBe(200);

        // Nothing in this process knows what `mixed-provider` is. The directory is empty, the module was
        // never imported, and the only things left are a slug in a file header and the fork's own record.
        expect(fs.existsSync(providersPath)).toBe(false);

        const answer = await status([secretOnDiskName]);
        const state = answer.body.chats[secretOnDiskName];

        // §11, unchanged: the row is present and disabled rather than hidden.
        expect(state.encrypted).toBe(true);
        expect(state.unavailable).toBe(true);

        // 🪪 §7, the new part: the id is still there — it is the only half that matches what is on the disk
        // — and beside it is a name a human can act on, which no amount of staring at the file could have
        // produced.
        expect(state.requiresProvider).toBe(IDENTITY.id);
        expect(state.identity).toMatchObject({
            name: IDENTITY.name,
            source: IDENTITY.source,
            version: IDENTITY.version,
        });
        expect(state.identity.lastSeen).toEqual(expect.any(String));
    }, 240_000);

    // 3 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('3. 🔴 §9.3 a chat naming a provider that was never here gets its bare id and NOTHING else', async () => {
        const answer = await status([`${PLANTED_CHAT}.jsonl`]);
        const state = answer.body.chats[`${PLANTED_CHAT}.jsonl`];

        expect(state.encrypted).toBe(true);
        expect(state.unavailable).toBe(true);
        expect(state.requiresProvider).toBe(PLANTED_PROVIDER_ID);

        // 🔴 THE INVERSION, DEMONSTRATED. A file cannot introduce a provider; only a provider that ran here
        // can. So this one gets exactly what the fork showed before the registry existed.
        expect(state.identity).toBeNull();
    }, 240_000);

    // 4 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('4. 🔴 a planted file cannot borrow the real provider\'s identity by naming its id', async () => {
        // §4 is explicit that this case is SAFE rather than prevented: a planted file naming `mixed-provider`
        // shows the real provider's details, and that tells the user nothing false — those details describe
        // the plugin they genuinely installed, and the planted bytes still will not decrypt. What must not
        // happen is the planted file contributing anything of its own to what is displayed.
        const impostor = `${PLANTED_CHAT}-impostor.jsonl`;
        fs.writeFileSync(path.join(chatsDir(), impostor), `stenv:1:${IDENTITY.id}:not really from that plugin\n`);

        const state = (await status([impostor])).body.chats[impostor];

        expect(state.identity.name).toBe(IDENTITY.name);
        expect(state.identity.source).toBe(IDENTITY.source);
    }, 240_000);

    // 4b ─────────────────────────────────────────────────────────────────────────────────────────────────
    test('4b. 🔴 a REAL provider\'s marker, not the fixture\'s — the fork must not know any prefix at all', async () => {
        // 🔴 THE FIXTURE GAP, CLOSED FROM THE OTHER SIDE. Every mixed-mode suite in this repo drives one
        // fixture whose on-disk marker is `enc~`, so "the fork is marker-agnostic" was established by
        // reading the source (`grep -rn "enc~" src/ public/` finds nothing) rather than by exercising it.
        // That is exactly the fixture-gap argument `mixed-provider.js`'s own header makes against itself,
        // and the SillyTavern-Vault session raised it: an assertion that matches `/^enc~/` passes against
        // the fixture and says nothing whatsoever about the real plugin.
        //
        // So this plants SillyTavern-Vault's ACTUAL on-disk shape — `venc1~<base64url ciphertext>.jsonl`,
        // six characters of marker rather than four — with a real envelope behind it, and asserts the fork
        // classifies it identically. Nothing here is demangled: the provider is uninstalled, which is the
        // state §11 is about, and the name is opaque to the fork by design.
        const vaultShaped = `venc1~${Buffer.from('some-encrypted-name', 'utf-8').toString('base64url')}.jsonl`;
        fs.writeFileSync(path.join(chatsDir(), vaultShaped), 'stenv:1:vault:STV1\x00\xff binary body\n');

        const state = (await status([vaultShaped])).body.chats[vaultShaped];

        expect(state.encrypted).toBe(true);
        expect(state.unavailable).toBe(true);
        expect(state.requiresProvider).toBe('vault');

        // 🔴 AND THE §9.1 BACKUP LISTING TOO, which is where a prefix assumption would actually bite. That
        // filter keeps a row on `.jsonl` extension plus envelope — never on the `chat_` stem, which a
        // mangled name does not have. A marker-sensitive filter would drop exactly the backups a user opens
        // that screen to look for.
        const backupsDir = path.join(dataRoot, 'default-user', 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        const backupName = `venc1~${Buffer.from('chat_Someone_2026-07-20', 'utf-8').toString('base64url')}.jsonl`;
        fs.writeFileSync(path.join(backupsDir, backupName), 'stenv:1:vault:STV1\x00\xff binary body\n');

        const listed = await post('/api/backups/chat/get', {});
        const row = listed.body.find((b) => b.file_name === backupName);

        expect(row).toBeDefined();
        expect(row.storage.encrypted).toBe(true);
        expect(row.storage.requiresProvider).toBe('vault');
    }, 240_000);

    // 5 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('5. §9.6 delete the registry and the fork returns to exactly its old sentence', async () => {
        // §5: an enrichment, never a dependency. A fork whose registry is missing must not degrade the §11
        // dead row it already draws correctly — it must draw precisely that row and nothing more.
        fs.rmSync(registryPath());
        await reboot({ provider: false });
        expect((await login()).status).toBe(200);

        const state = (await status([secretOnDiskName])).body.chats[secretOnDiskName];

        expect(state.encrypted).toBe(true);
        expect(state.unavailable).toBe(true);
        expect(state.requiresProvider).toBe(IDENTITY.id);
        expect(state.identity).toBeNull();
    }, 240_000);

    // 8 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('8. 🪪 §12.1 the plugin is INSTALLED but the file is too new → "update it", naming the loaded plugin', async () => {
        // §7 row 3, the state that could not exist until the provider grew `envelopeVersionAt()`. Everything
        // above this is "the plugin is GONE"; this is "you HAVE the plugin and it still will not open".
        //
        // 🔴 THE FILE VERSION IS PLANTED, NOT WRITTEN BY THE PROVIDER. The fixture always writes version 1
        // (its ENVELOPE_HEADER), so a chat it wrote can never skew — the whole point is a file from a build
        // this one does not know. So a `stenv:99:` header is planted by hand under the provider's own
        // on-disk name shape, and the fixture's `envelopeVersionAt` reports 99 off the bytes. Reading it off
        // a constant instead would make exactly this case undetectable while passing every other test.
        //
        // The earlier `reboot({ provider: false })` calls DELETED the plugin from disk (that is what makes
        // them uninstalls), so it has to be re-installed before a boot that expects it to load.
        installStorageProvider(providersPath, MIXED_PROVIDER);
        await reboot({ provider: true });
        expect((await login()).status).toBe(200);

        // 🔴 ASK ABOUT THE LOGICAL NAME, so the installed provider resolves it to its own marked file and
        // answers `encryptsPath` true — the only branch the skew check lives in. Planting under the mangled
        // name and asking for THAT would be classified as a plaintext passthrough (a real file sits at the
        // literal path), which is the §12.1 logical-vs-physical trap, and the test would prove nothing.
        const tooNewLogical = 'a-chat-from-a-newer-build';
        const tooNewMangled = `enc~${Buffer.from(tooNewLogical, 'utf-8').toString('base64url')}.jsonl`;
        fs.writeFileSync(
            path.join(chatsDir(), tooNewMangled),
            `stenv:99:${IDENTITY.id}:${Buffer.from('unreadable by this build').toString('base64')}\n`,
        );

        const state = (await status([`${tooNewLogical}.jsonl`])).body.chats[`${tooNewLogical}.jsonl`];

        // The chat is encrypted and the provider is present, so it is NOT `unavailable` — this is the one
        // state in the whole design that is `requiresUpdate` while the provider is installed and answering.
        expect(state.encrypted).toBe(true);
        expect(state.unavailable).toBe(false);
        expect(state.requiresUpdate).toBe(true);

        // 🔴 The name is the LOADED provider's, resolved from the provider that owns the bytes — never read
        // off the file (§4, Vault's Q2). The sentence it feeds is an instruction to install software, so the
        // source must be the one §4 trusts.
        expect(state.requiresProvider).toBe(IDENTITY.id);
        expect(state.identity).toMatchObject({ name: IDENTITY.name, version: IDENTITY.version });

        // 🔴 AND SILENCE MEANS READABLE. The version-1 chat the provider actually wrote, asked about by its
        // logical name in the same breath, must be a plain readable chat — no skew, no update sentence.
        const readable = (await status([`${SECRET_CHAT}.jsonl`])).body.chats[`${SECRET_CHAT}.jsonl`];
        expect(readable.encrypted).toBe(true);
        expect(readable.unavailable).toBe(false);
        expect(readable.requiresUpdate).toBeUndefined();
    }, 240_000);
});
