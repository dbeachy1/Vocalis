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

const AVATAR = 'testchar.png';
const CHAR_DIR = 'testchar';

/**
 * 🔀 DERIVED CHATS — `DESIGN_MIXED_MODE.md` §8, the table the shared code paths make non-obvious.
 *
 * §13 assigns §8 to **Vault to implement, fork to test**, and until this file existed the fork tested one
 * row of it: *save into an existing chat*. That is the easy row. The rows that were never checked are the
 * ones where a DERIVED chat is written — branch, rename, import — because "new chat" and "copy of an
 * existing chat" are the same code path in places, which is exactly why §8 says to state the rule rather
 * than let it emerge.
 *
 * §8's rule: **state is inherited from the source, never from the moment.** Only a genuinely new chat gets
 * today's default.
 *
 * | Operation | §8 says |
 * |---|---|
 * | New chat, provider installed | Encrypted |
 * | Branch / duplicate of a **plaintext** chat | Plaintext |
 * | Branch / duplicate of an **encrypted** chat | Encrypted |
 * | Rename of either | State preserved — renaming is not a conversion |
 * | Import (`/api/chats/import`) | Encrypted — it is a new chat |
 *
 * ## ⚠️ What this suite asserts, and the one place it deliberately asserts the CODE and not the SPEC
 *
 * Every row below is asserted against a live server. Four of them pass on their merits. The branch-of-a-
 * plaintext-chat row does NOT behave as §8's table describes, and this suite pins the behaviour that
 * actually ships while `§14.6` records the divergence and the decision it needs:
 *
 * 🔴 **A branch is a `POST /api/chats/save` under a NEW file name** (`bookmarks.js:231` → `saveChat({
 * chatName })`). The server receives a write to a path that does not exist yet, with no reference of any
 * kind to the chat it came from — the branch's *content* is a copy, but the *request* is indistinguishable
 * from "create a new chat". So the provider does the only thing it can do and applies its default, which is
 * encryption. Inheriting here is not a bug the provider can fix alone; it needs the fork to tell it what the
 * source was, which is an interface change (§6) and Vault's to consume.
 *
 * Backup portability also depends on choosing the encryption policy explicitly. Keep that decision separate
 * from this suite rather than encoding an unresolved policy as correct behavior.
 */

/**
 * Give the default user a real password, so login can unlock the provider.
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
 * On-disk name → logical name. The fixture's scheme, restated so drift breaks a test.
 * @param {string} name The marked on-disk name
 * @returns {string} The logical name it hides
 */
function demangle(name) {
    const ext = path.extname(name);
    return Buffer.from(name.slice('enc~'.length, name.length - ext.length), 'base64url').toString('utf-8') + ext;
}

/** A minimal but well-formed chat: a metadata header line, then one message. */
function chatBody(marker) {
    return [
        { user_name: 'User', character_name: CHAR_DIR, create_date: '2026-07-20', chat_metadata: {} },
        { name: CHAR_DIR, is_user: false, mes: `hello from chat ${marker}`, send_date: '2026-07-20' },
    ];
}

describe('🔀 derived chats: branch, rename and import (§8)', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let configPath;
    /** @type {import('./util/st-server.js').RunningServer|null} */
    let server = null;
    /** @type {string} */
    let base;
    /** @type {string|undefined} */
    let cookie;

    const chatsDir = () => path.join(dataRoot, 'default-user', 'chats', CHAR_DIR);
    const onDisk = () => (fs.existsSync(chatsDir()) ? fs.readdirSync(chatsDir()).sort() : []);

    /** Every logical chat name in the directory, whichever namespace it lives in. */
    const logicalNames = () => onDisk().map((n) => (n.startsWith('enc~') ? demangle(n) : n)).sort();

    /** Is this logical chat encrypted on disk? Read from the raw directory, never from an API. */
    const isEncrypted = (logicalName) => onDisk().some((n) => n.startsWith('enc~') && demangle(n) === logicalName);

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
     * POST a multipart form as the current session — what the import path actually receives.
     * @param {string} route The route
     * @param {FormData} form The form
     * @returns {Promise<{status: number, body: any, text: string}>} The response
     */
    async function postForm(route, form) {
        const response = await fetch(`${base}${route}`, {
            method: 'POST',
            headers: { ...(cookie ? { Cookie: cookie } : {}) },
            body: form,
        });

        const text = await response.text();

        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = text;
        }

        return { status: response.status, body: parsed, text };
    }

    const saveChat = (fileName, chat) => post('/api/chats/save', { avatar_url: AVATAR, file_name: fileName, chat, force: true });
    const getChat = (fileName) => post('/api/chats/get', { avatar_url: AVATAR, file_name: fileName });
    const renameChat = (from, to) => post('/api/chats/rename', { avatar_url: AVATAR, original_file: from, renamed_file: to });

    beforeAll(async () => {
        scratch = makeScratchDirectory('derived-chats');
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);

        // 🔴 THE LEGACY CHAT IS PLANTED BEFORE THE PROVIDER EXISTS, with raw `fs` into the seeded tree. A
        // chat created through the provider could never be the subject of "a chat that predates the plugin".
        fs.mkdirSync(chatsDir(), { recursive: true });
        fs.writeFileSync(
            path.join(chatsDir(), 'legacy.jsonl'),
            chatBody('LEGACY').map((m) => JSON.stringify(m)).join('\n'),
        );

        installStorageProvider(providersPath, MIXED_PROVIDER);

        server = await startSillyTavern({
            dataRoot,
            configPath,
            enableUserAccounts: true,
            storageProvidersPath: providersPath,
            providerEnv: {
                ST_KEYED_STATE: path.join(scratch, 'vault-keys.json'),
                ST_KEYED_HANDLE: 'default-user',
                ST_KEYED_PASSWORD: PASSWORD,
                ST_KEYED_RECOVERY_KEY: RECOVERY_KEY,
            },
        });

        if (!server.listening) throw new Error(`Boot with provider failed.\n\n${server.output()}`);

        base = `http://127.0.0.1:${server.port}`;

        const login = await post('/api/users/login', { handle: 'default-user', password: PASSWORD });
        cookie = login.cookie || cookie;
        if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    // ── the two baselines the rest of the table is measured against ──────────────────────────────────────
    test('the planted legacy chat is readable and still plaintext; a new chat is encrypted', async () => {
        // ⚠️ Assert the data EXISTS before asserting anything about its state — §10's warning about the
        // vacuous green applies to every suite in this project, not only the oracle ones.
        expect((await getChat('legacy')).body).toEqual(chatBody('LEGACY'));
        expect(isEncrypted('legacy.jsonl')).toBe(false);

        expect((await saveChat('fresh', chatBody('FRESH'))).body).toEqual({ ok: true });
        expect(isEncrypted('fresh.jsonl')).toBe(true);
        expect((await getChat('fresh')).body).toEqual(chatBody('FRESH'));
    }, 240_000);

    // ── §8 row 4: rename ─────────────────────────────────────────────────────────────────────────────────
    test('🔴 renaming the LEGACY chat leaves it plaintext — renaming is not a conversion (§8 row 4)', async () => {
        // This is the row with teeth. `/api/chats/rename` is `storage.copyFile` + `storage.unlink`, so the
        // provider sees a copy WITH its source — the one derived operation where inheritance is implementable
        // today — and a provider that instead treated the destination as a new file would silently convert a
        // chat the user never opted to encrypt.
        expect((await renameChat('legacy.jsonl', 'legacy-renamed.jsonl')).body).toMatchObject({ ok: true });

        expect(logicalNames()).toContain('legacy-renamed.jsonl');
        expect(logicalNames()).not.toContain('legacy.jsonl');
        expect(isEncrypted('legacy-renamed.jsonl')).toBe(false);

        // Readable, and still the same chat — a "preserved" file that lost its contents is not preserved.
        expect((await getChat('legacy-renamed')).body).toEqual(chatBody('LEGACY'));

        // And on disk it is genuinely in the clear, not merely reported so.
        expect(fs.readFileSync(path.join(chatsDir(), 'legacy-renamed.jsonl'), 'utf-8')).toContain('hello from chat LEGACY');
    }, 240_000);

    test('renaming an ENCRYPTED chat leaves it encrypted and readable (§8 row 4)', async () => {
        expect((await renameChat('fresh.jsonl', 'fresh-renamed.jsonl')).body).toMatchObject({ ok: true });

        expect(logicalNames()).toContain('fresh-renamed.jsonl');
        expect(isEncrypted('fresh-renamed.jsonl')).toBe(true);
        expect((await getChat('fresh-renamed')).body).toEqual(chatBody('FRESH'));

        // The plaintext of a renamed encrypted chat must not appear under the new name either.
        const marked = onDisk().find((n) => n.startsWith('enc~') && demangle(n) === 'fresh-renamed.jsonl');
        expect(fs.readFileSync(path.join(chatsDir(), marked), 'utf-8')).not.toContain('hello from chat FRESH');
    }, 240_000);

    // ── §8 rows 2 and 3: branch / duplicate ──────────────────────────────────────────────────────────────
    test('branching an ENCRYPTED chat produces an encrypted branch (§8 row 3)', async () => {
        const source = (await getChat('fresh-renamed')).body;
        expect((await saveChat('fresh-branch', source)).body).toEqual({ ok: true });

        expect(isEncrypted('fresh-branch.jsonl')).toBe(true);
        expect((await getChat('fresh-branch')).body).toEqual(source);
    }, 240_000);

    test('🔴 branching a PLAINTEXT chat produces an ENCRYPTED branch — §8 row 2 says plaintext (§14.6)', async () => {
        // The divergence, pinned rather than hidden. `createBranch` (bookmarks.js:186) ends at
        // `saveChat({ chatName })` → POST /api/chats/save under a name that does not exist yet. The server
        // cannot tell that request apart from "create a new chat": the content is a copy, but nothing in the
        // request says so. The provider applies its default, which is encryption.
        //
        // The consequence is real and worth stating plainly: branch a chat that predates the plugin and the
        // BRANCH needs the plugin for ever, while its parent never will. Nothing is lost — the parent is
        // untouched and the branch is new data created after the install — which is why this is a design
        // call (§14.6) and not a bug this suite gets to fail over.
        const source = (await getChat('legacy-renamed')).body;
        expect((await saveChat('legacy-branch', source)).body).toEqual({ ok: true });

        expect(isEncrypted('legacy-branch.jsonl')).toBe(true);
        expect((await getChat('legacy-branch')).body).toEqual(source);

        // 🔴 WHATEVER §14.6 DECIDES, THIS MUST HOLD: the source chat is untouched by the branch. The §1
        // guarantee is about the chat that predates the plugin, and branching one must never convert it.
        expect(isEncrypted('legacy-renamed.jsonl')).toBe(false);
        expect(fs.readFileSync(path.join(chatsDir(), 'legacy-renamed.jsonl'), 'utf-8')).toContain('hello from chat LEGACY');
    }, 240_000);

    // ── §8 row 5: import ─────────────────────────────────────────────────────────────────────────────────
    test('an imported chat is encrypted — it is a new chat, written through the provider (§8 row 5)', async () => {
        const jsonl = chatBody('IMPORTED').map((m) => JSON.stringify(m)).join('\n');

        const form = new FormData();
        form.set('file_type', 'jsonl');
        form.set('avatar_url', AVATAR);
        form.set('user_name', 'User');
        form.set('character_name', CHAR_DIR);
        form.set('avatar', new File([jsonl], 'imported.jsonl', { type: 'application/octet-stream' }));

        const result = await postForm('/api/chats/import', form);
        expect(result.status).toBe(200);
        expect(result.body?.error).toBeUndefined();

        // `res` is a bare `true`; the name the endpoint chose comes back in `fileNames`.
        const imported = String(result.body.fileNames[0]);
        expect(imported.endsWith('.jsonl')).toBe(true);

        // 🔴 THE LEAK THIS SUITE FOUND. The .jsonl import path does not WRITE the chat, it `copyFile`s the
        // multer upload into the chats directory (chats.js:836) — and the upload landed in a directory the
        // provider passes through in the clear, so the copy inherits *plaintext* and the imported chat is
        // written unencrypted onto an install whose whole premise is encryption at rest. Every message the
        // user just imported is on disk in the clear, under a name that is in the clear, and nothing in the
        // UI says so.
        expect(isEncrypted(imported)).toBe(true);
        expect((await getChat(imported.replace(/\.jsonl$/, ''))).body).toEqual(chatBody('IMPORTED'));

        // And the plaintext must not be sitting in the directory under any name.
        for (const name of onDisk()) {
            expect(fs.readFileSync(path.join(chatsDir(), name), 'utf-8')).not.toContain('hello from chat IMPORTED');
        }
    }, 240_000);

    // ── the property all five rows exist to protect ──────────────────────────────────────────────────────
    test('🔴 after every derived operation, the legacy chat is STILL plaintext and STILL readable (§1)', async () => {
        // The whole feature reduces to this sentence, and derived operations are where it is most likely to
        // be broken by accident: they are the paths that write new files while a plaintext chat is open.
        expect(isEncrypted('legacy-renamed.jsonl')).toBe(false);
        expect((await getChat('legacy-renamed')).body).toEqual(chatBody('LEGACY'));
        expect(fs.readFileSync(path.join(chatsDir(), 'legacy-renamed.jsonl'), 'utf-8')).not.toContain('stenv:');
    }, 240_000);
});
