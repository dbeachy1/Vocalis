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
 * 🔀 THE MIXED-MODE LIFECYCLE — `DESIGN_MIXED_MODE.md` §12, the ten steps in order, plus 9a.
 *
 * Every other storage suite proves one property in isolation. This proves the property the whole feature
 * exists for: **a chat that was not encrypted when it was created stays plaintext for ever, a chat created
 * while the provider is installed is encrypted end to end, and both are readable in the same account at the
 * same time** — across install, save, backup, uninstall and reinstall, against a real server each step.
 *
 * ## Why this is one file, in order, and not twelve independent suites
 *
 * §12 is explicit: "one file, in order". The steps are not independent — step 3 asserts step 1's bytes are
 * untouched, step 9 asserts step 4's encrypted chats survive an uninstall, step 10 asserts they come back.
 * State threads through the whole thing, so the tests share it and run in sequence. A failure early cascades,
 * which is correct: if install corrupts a legacy chat, there is no point pretending the later steps are
 * meaningful.
 *
 * ## Three things the build forced, stated up front rather than discovered in a diff
 *
 * 1. 🔴 **Encrypted names keep their `.jsonl` in the clear, and step 9 is the reason.** Every lister that
 *    surfaces a chat — `/api/characters/chats`, `/api/chats/search`, `/api/backups/chat/get` — filters raw
 *    `fs` entries by `path.extname === '.jsonl'`, and in the uninstalled state there is no provider to
 *    demangle the name first. A scheme that hid the extension would make every uninstalled encrypted chat
 *    vanish from exactly the list §11 says it must appear in. The fixture models the working shape and
 *    `DESIGN_MIXED_MODE.md` §14.2 records the constraint for Vault.
 *
 * 2. 🔴 **Step 9a does not tamper with C and D.** It plants two *sacrificial* chats carrying hostile
 *    provider ids, because step 10 requires C and D to still be READABLE — corrupting their envelope header
 *    would break the very thing step 10 checks. §12 says "a chat's envelope id", not "chat C's".
 *
 * 3. ✅ **Backups do NOT inherit plaintext, and that is the decision (§9.1, closing §14.5).** Source-state
 *    inheritance is not cleanly buildable at today's granularity — `backupChat` is keyed by CHARACTER, not by
 *    chat, so a single `chat_<char>_<ts>` stem covers both the plaintext and the encrypted chats of one
 *    character and has no single state to inherit — and it was decided against on its merits: the backups
 *    directory is where "everything from here on is protected" is the right rule. So a legacy plaintext
 *    chat's backups become encrypted once the provider arrives, while the chat itself stays plaintext for
 *    ever. Step 8 asserts the directory genuinely goes mixed (the `88a0ebdd8` bug) and **step 9b asserts the
 *    obligation that decision carries**: uninstalled, those backups still LIST, and asking to restore one is
 *    refused by name rather than silently importing ciphertext as a chat.
 */

/** The one character every chat in this lifecycle belongs to, so step 5's "all four in one list" is real. */
const AVATAR = 'testchar.png';
const CHAR_DIR = 'testchar';

/**
 * Give the default user a real password, so login can unlock the provider. Same shape as the oracle suite.
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
 * On-disk name → logical name, the fixture's scheme spelled out independently (same discipline as the
 * fixture's ENVELOPE_HEADER: two statements of one wire format, so drift breaks a test).
 * @param {string} name The marked on-disk name
 * @returns {string} The logical name it hides
 */
function demangle(name) {
    const ext = path.extname(name);
    const encoded = name.slice('enc~'.length, name.length - ext.length);
    return Buffer.from(encoded, 'base64url').toString('utf-8') + ext;
}

/** A minimal but well-formed chat: a metadata header line, then one message. */
function chatBody(marker) {
    return [
        { user_name: 'User', character_name: CHAR_DIR, create_date: '2026-07-20', chat_metadata: {} },
        { name: CHAR_DIR, is_user: false, mes: `hello from chat ${marker}`, send_date: '2026-07-20' },
    ];
}

/** Append a user line to a chat body, for the "save a message into it" steps. */
function withReply(body, text) {
    return [...body, { name: 'User', is_user: true, mes: text, send_date: '2026-07-20' }];
}

describe('🔀 mixed mode: the ten-step lifecycle, in order (§12)', () => {
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

    // The last-written state of each chat, so "readable and unchanged" has something to be equal to.
    const bodyA = chatBody('A');
    const bodyB = chatBody('B');
    const bodyC = chatBody('C');
    const bodyD = chatBody('D');
    let latestA = bodyA;
    let latestC = bodyC;

    // Raw on-disk bytes and mtimes captured for the byte-identity / untouched assertions of §12 steps 3 & 9.
    /** @type {{bytes: string, mtimeMs: number}} */
    let aOnDiskAfterCreate;
    /** @type {string} */
    let cEncryptedBytesAfterSave;
    /** @type {string} */
    let cEncryptedName;

    const chatsDir = () => path.join(dataRoot, 'default-user', 'chats', CHAR_DIR);
    const backupsDir = () => path.join(dataRoot, 'default-user', 'backups');
    const onDiskChats = () => (fs.existsSync(chatsDir()) ? fs.readdirSync(chatsDir()).sort() : []);
    const onDiskBackups = () => (fs.existsSync(backupsDir()) ? fs.readdirSync(backupsDir()).sort() : []);
    const readRaw = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf-8');

    /**
     * POST some JSON as the current session. Parses JSON, but survives a bare-word refusal like "Forbidden".
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
     * Stop the running server and boot a fresh one against the SAME data root — with the provider or without
     * it. Booting without `storageProvidersPath` is how "uninstall" is modelled: the plugin is simply not
     * loaded, which is what uninstalling it does to a running server.
     * @param {object} options Boot options
     * @param {boolean} options.provider Whether to load the storage provider this boot
     * @returns {Promise<void>} When the new server is listening
     */
    async function reboot({ provider }) {
        if (server) {
            await server.stop();
            server = null;
        }

        cookie = undefined;

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
     * Log in as the default user and keep the session cookie. Succeeds with a provider (it unlocks the vault)
     * and without one (`storage.unlock` is a no-op when nothing is installed).
     * @returns {Promise<{status: number, body: any, text: string, cookie: string}>} The login response
     */
    async function login() {
        const result = await post('/api/users/login', { handle: 'default-user', password: PASSWORD });
        cookie = result.cookie || cookie;
        return result;
    }

    const saveChat = (fileName, chat) => post('/api/chats/save', { avatar_url: AVATAR, file_name: fileName, chat, force: true });
    const getChat = (fileName) => post('/api/chats/get', { avatar_url: AVATAR, file_name: fileName });
    const listChats = () => post('/api/characters/chats', { avatar_url: AVATAR });
    const chatStatus = (chats) => post('/api/storage/chat-status', { chats });
    const listBackups = () => post('/api/backups/chat/get', {});

    beforeAll(async () => {
        scratch = makeScratchDirectory('mixed-mode-lifecycle');
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        providersPath = path.join(scratch, 'storage-providers');

        // Seed boot creates the default-user data tree; then the account gets a password so that, once the
        // provider is installed, login has a secret to unlock it with.
        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);

        // The provider file is installed once; whether it is LOADED is decided per-boot by whether `reboot`
        // passes the providers path. That is the uninstall/reinstall seam.
        installStorageProvider(providersPath, MIXED_PROVIDER);
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    // 1 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('1. no provider: chats A and B are created plaintext, under ordinary filenames', async () => {
        await reboot({ provider: false });
        expect((await login()).status).toBe(200);

        expect((await saveChat('chat-a', bodyA)).body).toEqual({ ok: true });
        expect((await saveChat('chat-b', bodyB)).body).toEqual({ ok: true });

        // On disk: ordinary names, plaintext bytes, nothing marked — there is no provider to mark anything.
        expect(onDiskChats()).toEqual(expect.arrayContaining(['chat-a.jsonl', 'chat-b.jsonl']));
        expect(onDiskChats().some((n) => n.startsWith('enc~'))).toBe(false);

        const rawA = readRaw(chatsDir(), 'chat-a.jsonl');
        expect(rawA).toContain('hello from chat A');
        expect(rawA).not.toContain('stenv:');

        aOnDiskAfterCreate = {
            bytes: rawA,
            mtimeMs: fs.statSync(path.join(chatsDir(), 'chat-a.jsonl')).mtimeMs,
        };
    }, 240_000);

    // 2 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('2. 🔴 install the provider and log in — login SUCCEEDS (the §2 lockout is gone)', async () => {
        await reboot({ provider: true });

        // This is the regression the whole spec exists for. The old behaviour was `createVaultFor` refusing
        // an account that already has data, throwing out of `unlock`, and locking the account out for ever.
        // A green here is that install-over-existing-data now coexists instead of bricking the login.
        const result = await login();
        expect(result.status).toBe(200);
        expect(result.body).toEqual({ handle: 'default-user' });
    }, 240_000);

    // 3 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('3. the legacy chats read back byte-identical, and their files were never touched', async () => {
        const a = await getChat('chat-a');
        const b = await getChat('chat-b');
        expect(a.body).toEqual(bodyA);
        expect(b.body).toEqual(bodyB);

        // 🔴 Still plaintext, still under their own names, and — the §3 assertion — mtime unchanged: install
        // and the boot after it did not rewrite a single byte of data the user never opted to encrypt.
        expect(onDiskChats()).toEqual(expect.arrayContaining(['chat-a.jsonl', 'chat-b.jsonl']));
        expect(readRaw(chatsDir(), 'chat-a.jsonl')).toBe(aOnDiskAfterCreate.bytes);
        expect(fs.statSync(path.join(chatsDir(), 'chat-a.jsonl')).mtimeMs).toBe(aOnDiskAfterCreate.mtimeMs);
    }, 240_000);

    // 4 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('4. new chats C and D are enveloped on disk, under marked names', async () => {
        expect((await saveChat('chat-c', bodyC)).body).toEqual({ ok: true });
        expect((await saveChat('chat-d', bodyD)).body).toEqual({ ok: true });

        // The provider mangled the names and enveloped the bytes. Raw `fs` cannot find them by logical name.
        expect(onDiskChats()).not.toContain('chat-c.jsonl');
        expect(onDiskChats()).not.toContain('chat-d.jsonl');

        const marked = onDiskChats().filter((n) => n.startsWith('enc~') && n.endsWith('.jsonl'));
        expect(marked.length).toBe(2);
        expect(marked.map(demangle).sort()).toEqual(['chat-c.jsonl', 'chat-d.jsonl']);

        cEncryptedName = marked.find((n) => demangle(n) === 'chat-c.jsonl');
        const rawC = readRaw(chatsDir(), cEncryptedName);
        expect(rawC.startsWith('stenv:1:mixed-provider:')).toBe(true);
        expect(rawC).not.toContain('hello from chat C');
    }, 240_000);

    // 5 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('5. all four appear in ONE list; A and B report not-encrypted, C and D encrypted', async () => {
        const listed = (await listChats()).body.map((c) => c.file_name).sort();
        expect(listed).toEqual(['chat-a.jsonl', 'chat-b.jsonl', 'chat-c.jsonl', 'chat-d.jsonl']);

        const status = await chatStatus([
            { name: 'chat-a.jsonl', directory: CHAR_DIR },
            { name: 'chat-b.jsonl', directory: CHAR_DIR },
            { name: 'chat-c.jsonl', directory: CHAR_DIR },
            { name: 'chat-d.jsonl', directory: CHAR_DIR },
        ]);

        expect(status.status).toBe(200);
        expect(status.body.chats['chat-a.jsonl'].encrypted).toBe(false);
        expect(status.body.chats['chat-b.jsonl'].encrypted).toBe(false);
        expect(status.body.chats['chat-c.jsonl'].encrypted).toBe(true);
        expect(status.body.chats['chat-d.jsonl'].encrypted).toBe(true);

        // 🔴 The tooltip words are the PROVIDER'S. This is the provider's `describe('storage.chatMarker')`
        // body coming through verbatim, not a string the fork invented.
        expect(status.body.marker).toBe('FIXTURE: this chat is encrypted at rest.');
    }, 240_000);

    // 6 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('6. saving a message into A keeps A plaintext — state is inherited, not chosen (§8)', async () => {
        latestA = withReply(bodyA, 'a line typed after the plugin arrived');
        expect((await saveChat('chat-a', latestA)).body).toEqual({ ok: true });

        // A predates the provider, so the save passes through in the clear. No `enc~` copy of A appears.
        expect(onDiskChats()).toContain('chat-a.jsonl');
        expect(readRaw(chatsDir(), 'chat-a.jsonl')).toContain('a line typed after the plugin arrived');
        expect(readRaw(chatsDir(), 'chat-a.jsonl')).not.toContain('stenv:');
        expect(onDiskChats().some((n) => n.startsWith('enc~') && demangle(n) === 'chat-a.jsonl')).toBe(false);

        aOnDiskAfterCreate = {
            bytes: readRaw(chatsDir(), 'chat-a.jsonl'),
            mtimeMs: fs.statSync(path.join(chatsDir(), 'chat-a.jsonl')).mtimeMs,
        };
    }, 240_000);

    // 7 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('7. saving a message into C keeps C encrypted', async () => {
        latestC = withReply(bodyC, 'a secret line typed into the encrypted chat');
        expect((await saveChat('chat-c', latestC)).body).toEqual({ ok: true });

        // C stays marked and enveloped; there is no plaintext `chat-c.jsonl` on disk.
        expect(onDiskChats()).not.toContain('chat-c.jsonl');
        const rawC = readRaw(chatsDir(), cEncryptedName);
        expect(rawC.startsWith('stenv:1:mixed-provider:')).toBe(true);
        expect(rawC).not.toContain('a secret line typed into the encrypted chat');

        cEncryptedBytesAfterSave = rawC;
    }, 240_000);

    // 8 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('8. the backups directory is mixed, and the list surfaces BOTH kinds (the 88a0ebdd8 regression)', async () => {
        // A plaintext backup exists because A/B were first saved before the provider arrived (step 1); an
        // encrypted backup exists because C/D were saved after (step 4+). That temporal split is what makes
        // the backups directory genuinely mixed — see the header note on why this, and not §9 inheritance,
        // is what is asserted.
        const backups = onDiskBackups().filter((n) => n.endsWith('.jsonl'));
        const encryptedBackups = backups.filter((n) => n.startsWith('enc~'));
        const chatBackups = backups.filter((n) => (n.startsWith('enc~') ? demangle(n) : n).startsWith('chat_'));
        const plaintextChatBackups = chatBackups.filter((n) => n.startsWith('chat_'));

        expect(encryptedBackups.length).toBeGreaterThanOrEqual(1);
        expect(plaintextChatBackups.length).toBeGreaterThanOrEqual(1);

        // 🔴 THE REGRESSION. Before the fix, `/api/backups/chat/get` used raw `fs` and matched nothing once
        // names were encrypted, reporting "no backups" while they sat there intact. The count the API
        // returns must equal the count of chat backups actually on disk — of BOTH kinds — or one kind is
        // being silently dropped exactly as it was then.
        const api = await listBackups();
        expect(api.status).toBe(200);
        expect(Array.isArray(api.body)).toBe(true);
        expect(api.body.length).toBe(chatBackups.length);
    }, 240_000);

    // 9 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('9. 🔴 uninstall: A and B still work; C and D are shown, unavailable, naming what they need', async () => {
        await reboot({ provider: false });
        expect((await login()).status).toBe(200);

        // A and B: readable and unchanged, because they were never encrypted.
        expect((await getChat('chat-a')).body).toEqual(latestA);
        expect((await getChat('chat-b')).body).toEqual(bodyB);

        // C and D: present in the list. With no provider to demangle, they appear under their marked names —
        // the point is they APPEAR, disabled, rather than vanishing (§11). Hiding the row is how a user
        // concludes their data is gone and stops looking for it.
        const listed = (await listChats()).body.map((c) => c.file_name);
        const markedNames = listed.filter((n) => n.startsWith('enc~'));
        expect(markedNames.map(demangle).sort()).toEqual(['chat-c.jsonl', 'chat-d.jsonl']);

        const status = await chatStatus(markedNames.map((name) => ({ name, directory: CHAR_DIR })));
        for (const name of markedNames) {
            expect(status.body.chats[name].encrypted).toBe(true);
            expect(status.body.chats[name].unavailable).toBe(true);
            // 🔴 The envelope header names the provider WITHOUT the provider — read keylessly off disk (§3.1).
            expect(status.body.chats[name].requiresProvider).toBe('mixed-provider');
        }

        // 🔴 NOT DELETED, NOT REGENERATED. The boot's request-time destructive paths never fired on these;
        // C's ciphertext is byte-for-byte what step 7 wrote. A regenerate would have replaced it.
        expect(fs.existsSync(path.join(chatsDir(), cEncryptedName))).toBe(true);
        expect(readRaw(chatsDir(), cEncryptedName)).toBe(cEncryptedBytesAfterSave);
    }, 240_000);

    // 9a ─────────────────────────────────────────────────────────────────────────────────────────────────
    test('9a. 🔴 a hostile envelope id is shown as "provider unknown", never as markup, and the list draws', async () => {
        // SACRIFICIAL chats, not C and D — step 10 needs C and D intact. One id is markup, one is 4 KB.
        // Both are written with a valid magic/version so they ARE structurally envelopes; it is only the id
        // that is hostile, which is the case §3.1's character-class and length caps exist for.
        if (server) {
            await server.stop();
            server = null;
        }

        const body = Buffer.from('{"name":"planted"}\n', 'utf-8').toString('base64');
        fs.writeFileSync(path.join(chatsDir(), 'zz-bad-script.jsonl'), `stenv:1:<script>alert(1)</script>:${body}`);
        fs.writeFileSync(path.join(chatsDir(), 'zz-bad-huge.jsonl'), `stenv:1:${'A'.repeat(4096)}:${body}`);

        await reboot({ provider: false });
        expect((await login()).status).toBe(200);

        // The list still draws, with the hostile rows in it — a throw here would take out the whole chat
        // list, which is a worse outcome than one unreadable row.
        const listed = (await listChats());
        expect(listed.status).toBe(200);
        expect(listed.body.map((c) => c.file_name)).toEqual(
            expect.arrayContaining(['zz-bad-script.jsonl', 'zz-bad-huge.jsonl']),
        );

        const status = await chatStatus([
            { name: 'zz-bad-script.jsonl', directory: CHAR_DIR },
            { name: 'zz-bad-huge.jsonl', directory: CHAR_DIR },
        ]);

        // Both rejected by validation → "provider unknown", never the attacker's string.
        expect(status.body.chats['zz-bad-script.jsonl']).toMatchObject({ encrypted: true, unavailable: true, requiresProvider: null });
        expect(status.body.chats['zz-bad-huge.jsonl']).toMatchObject({ encrypted: true, unavailable: true, requiresProvider: null });

        // 🔴 The hostile string never crosses the wire — not as a value, not rendered, not anywhere.
        expect(status.text).not.toContain('<script>');
        expect(status.text).not.toContain('alert(1)');
        expect(status.text).not.toContain('AAAA');

        // Clean up the sacrificial rows so step 10 sees only A, B, C, D.
        fs.unlinkSync(path.join(chatsDir(), 'zz-bad-script.jsonl'));
        fs.unlinkSync(path.join(chatsDir(), 'zz-bad-huge.jsonl'));
    }, 240_000);

    // 9b ─────────────────────────────────────────────────────────────────────────────────────────────────
    test('9b. 🔴 uninstalled: encrypted backups still LIST, and restoring one is refused BY NAME (§14.5)', async () => {
        // §14.5 is decided, and this is the obligation the decision carries. Every backup written after the
        // provider arrives is encrypted — including the backups of chats that are themselves still plaintext,
        // which is wanted. What must not happen is that the user meets that fact as silence: a vanished row,
        // an empty viewer, or a "restored" chat full of ciphertext.
        const backups = onDiskBackups().filter((n) => n.endsWith('.jsonl'));
        const encryptedBackups = backups.filter((n) => n.startsWith('enc~'));
        const plaintextBackups = backups.filter((n) => n.startsWith('chat_'));

        expect(encryptedBackups.length).toBeGreaterThanOrEqual(1);
        expect(plaintextBackups.length).toBeGreaterThanOrEqual(1);

        // 🔴 STILL LISTED. With no provider the names on disk are the mangled ones, so the old `chat_` prefix
        // filter matched none of them and the whole encrypted half of the directory disappeared from the
        // restore UI — the §11 "my backups are gone" outcome, in the one screen a user opens *because*
        // something has already gone wrong.
        const listed = await listBackups();
        expect(listed.status).toBe(200);
        const listedNames = listed.body.map((b) => b.file_name);
        expect(listedNames).toEqual(expect.arrayContaining(encryptedBackups));
        expect(listedNames).toEqual(expect.arrayContaining(plaintextBackups));

        // Each encrypted row carries the state the UI draws the dead row from, naming the plugin it needs —
        // read keylessly off the envelope, with no provider installed to ask.
        for (const name of encryptedBackups) {
            const row = listed.body.find((b) => b.file_name === name);
            expect(row.storage).toEqual({
                encrypted: true,
                unavailable: true,
                requiresProvider: 'mixed-provider',
                // 🪪 §7 of `DESIGN_STORAGE_PROVENANCE.md`: the backup row names the plugin, not just its
                // slug, from the record the fork wrote while that plugin was installed at step 1.
                identity: expect.objectContaining({ id: 'mixed-provider', name: 'FIXTURE Mixed-Mode Provider' }),
            });
        }

        // 🔴 THE REFUSAL. `restoreBackup()` posts whatever this route returns straight to the chat importer,
        // so serving ciphertext here does not fail politely — it imports a garbage chat and calls it a
        // restore. 409, not 404: the backup is emphatically THERE.
        const refused = await post('/api/backups/chat/download', { name: encryptedBackups[0] });
        expect(refused.status).toBe(409);
        expect(refused.body).toEqual({
            error: 'unavailable',
            requiresProvider: 'mixed-provider',
            // The refusal carries the same record the list row does, so the message a user reads when a
            // restore is refused names the plugin rather than repeating a slug at them.
            identity: expect.objectContaining({ id: 'mixed-provider', name: 'FIXTURE Mixed-Mode Provider' }),
        });

        // And not one byte of the file came back with the refusal.
        expect(refused.text).not.toContain('stenv:');
        expect(refused.text).not.toContain('hello from chat');

        // The gate is targeted, not a blanket closure: a backup that predates the provider still downloads,
        // because it is plaintext and nothing is needed to read it.
        const allowed = await post('/api/backups/chat/download', { name: plaintextBackups[0] });
        expect(allowed.status).toBe(200);

        // Deleting an unreadable backup is still allowed — it is the one action that remains sensible on it,
        // and refusing would leave a row the user can neither use nor clear. Asserted on a COPY, so the real
        // backups survive for step 10.
        const doomed = `enc~${Buffer.from('chat_doomed_2026-07-20', 'utf-8').toString('base64url')}.jsonl`;
        fs.copyFileSync(path.join(backupsDir(), encryptedBackups[0]), path.join(backupsDir(), doomed));
        expect((await post('/api/backups/chat/delete', { name: doomed })).status).toBe(200);
        expect(fs.existsSync(path.join(backupsDir(), doomed))).toBe(false);
    }, 240_000);

    // 9c ────────────────────────────────────────────────────────────────────────────────────────────────
    test('9c. 🔴 uninstalled: an unreadable chat is REFUSED, not answered with [], and no save can land on it', async () => {
        // Precondition first, so this cannot go green vacuously if the fixture ever stops encrypting C.
        const beforeNames = onDiskChats();
        const encName = beforeNames.find((n) => n.startsWith('enc~') && demangle(n) === 'chat-c.jsonl');
        expect(encName).toBeDefined();
        const beforeBytes = fs.readFileSync(path.join(chatsDir(), encName));

        // 🔴 `[]` IS THE DANGEROUS ANSWER, NOT THE SAFE ONE. Every line of an envelope fails to parse, so
        // `getChatData` used to return the same `[]` it returns for a genuinely empty chat. The client reads
        // `[]` as "empty or corrupted", pushes the character's greeting and calls `saveChatConditional()`
        // with no further user action — so answering `[]` here is one click away from replacing the
        // conversation with a plaintext stub. The read has to refuse.
        // ⚠️ THE ON-DISK NAME, NOT THE LOGICAL ONE. This provider encrypts filenames (as Vault does), so with
        // it uninstalled there is no `chat-c.jsonl` for anything to resolve — the row in the chat list is the
        // raw `enc~…` name the directory listing produced, and that is what a click sends back. Asking for
        // the logical name here would test a path the UI can never take, and pass for the wrong reason.
        const encId = encName.slice(0, -'.jsonl'.length);

        const read = await getChat(encId);
        expect(read.status).toBe(409);
        expect(read.body?.storage).toMatchObject({ unavailable: true, requiresProvider: 'mixed-provider' });

        // The write refuses too, because the client is not the only caller — an extension, a script or a
        // stale tab can POST straight here. `force: true` is the point rather than a convenience: it skips
        // the integrity check, which is what the destroying path did anyway. An envelope does not parse, so
        // `chatIntegrity` is undefined and the check answers "intact" — it fails OPEN on exactly the bytes
        // it exists to protect, which is why this needed a gate of its own.
        const wrote = await saveChat(encId, chatBody('OVERWRITE'));
        expect(wrote.status).toBe(409);
        expect(wrote.body?.storage).toMatchObject({ unavailable: true, requiresProvider: 'mixed-provider' });

        // The assertion the other two exist to protect: the ciphertext is byte-for-byte untouched.
        expect(fs.readFileSync(path.join(chatsDir(), encName))).toEqual(beforeBytes);
        expect(onDiskChats()).toEqual(beforeNames);
    }, 240_000);

    // 9d ────────────────────────────────────────────────────────────────────────────────────────────────
    test('9d. 🔴 uninstalled: the Data Maid REFUSES to report, rather than condemning the whole account', async () => {
        // 🔴 THIS IS THE ONE THAT ENDS AT A DELETE BUTTON. With the provider gone nothing throws — every
        // read falls through to plain `fs` and succeeds, returning ciphertext — so the `isStorageError`
        // guards throughout data-maid.js never fire. The chats then parse to nothing, so they reference no
        // images and no Data Bank files; and `#collectChats` matches character PNGs, which this provider
        // left mangled on disk, against chat DIRECTORIES, which are never mangled, so nothing matches at
        // all. Every image, file, group chat and chat of every character comes back "loose", behind a
        // dialog that reads "permanently delete". §8 of DESIGN_STORAGE_PROVIDER_API.md calls that the user
        // confirming a lie, and it is reachable from User Settings with no admin gate.
        const report = await post('/api/data-maid/report', {});

        expect(report.status).toBe(409);
        expect(report.body?.storage).toMatchObject({ unavailable: true, requiresProvider: 'mixed-provider' });

        // No report means no token, and no token means no delete can be authorised off the back of one.
        expect(report.body?.token).toBeUndefined();
        expect(report.body?.report).toBeUndefined();
    }, 240_000);

    // 10 ─────────────────────────────────────────────────────────────────────────────────────────────────
    test('10. 🔴 reinstall without touching the data: C and D read again, A and B still plaintext', async () => {
        await reboot({ provider: true });
        expect((await login()).status).toBe(200);

        // The keys survived because `.vault-keys.json` lives in the data root, not in the plugin (§11). The
        // same password unwraps them and the encrypted chats decrypt back to exactly what step 7 last wrote.
        expect((await getChat('chat-c')).body).toEqual(latestC);
        expect((await getChat('chat-d')).body).toEqual(bodyD);

        // And the plaintext half never depended on any of that.
        expect((await getChat('chat-a')).body).toEqual(latestA);
        expect((await getChat('chat-b')).body).toEqual(bodyB);

        // On disk, the shapes are unchanged: A and B plaintext under their own names, C and D marked.
        expect(onDiskChats()).toEqual(expect.arrayContaining(['chat-a.jsonl', 'chat-b.jsonl']));
        expect(onDiskChats().filter((n) => n.startsWith('enc~')).map(demangle).sort()).toEqual(['chat-c.jsonl', 'chat-d.jsonl']);
    }, 240_000);
});
