import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import nodePersist from 'node-persist';

import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';
// The real constant, not a second spelling of it. This test read a hand-written 'uploads' and therefore
// asserted on a directory that does not exist; importing the source of truth is what stops that recurring.
import { UPLOADS_DIRECTORY } from '../src/constants.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const MIXED_PROVIDER = path.join(testDirectory, 'fixtures', 'mixed-provider.js');

const PASSWORD = 'the-password';
const RECOVERY_KEY = 'TEST_ONLY_RECOVERY_KEY_FIXTURE_0000000000000001';

const AVATAR = 'testchar.png';
const CHAR_DIR = 'testchar';

/**
 * 🔴 WHAT THE USER UPLOADS MUST NOT ARRIVE IN THE CLEAR — the staging-inheritance class.
 *
 * Found while testing `DESIGN_MIXED_MODE.md` §8 row 5, which says an imported chat is encrypted because it
 * is a new chat written through the provider. It was not. Three endpoints wrote user data into the data root
 * by **copying the multer staging file** rather than writing the bytes:
 *
 *     chats.js       /api/chats/import         copyFile(pathToUpload, chats/<name>.jsonl)
 *     chats.js       /api/chats/group/import   copyFile(pathToUpload, group chats/<name>.jsonl)
 *     backgrounds.js /api/backgrounds/upload   copyFile(img_path, backgrounds/<name>)
 *
 * A copy does not CHOOSE the destination's state, it INHERITS the source's — and the source is a staging
 * file, which is protected only if the provider implements the **optional** `multerStorage` capability. The
 * interface says optional, in as many words ("Optional, like `ownsUser`"), so this made a security guarantee
 * contingent on a capability a conforming provider may simply not have. Under one that omits it, everything
 * a user imports or uploads lands unencrypted on an install whose entire premise is encryption at rest —
 * silently, with nothing in the UI to say so.
 *
 * ⚠️ **On the live install this was latent, not exploited.** Vault implements `multerStorage`, and its
 * `copyFile` classifies by the TARGET rather than the source, so both paths happened to produce encrypted
 * files there. Two independent accidents, either of which could stop being true in a refactor of the other
 * repo — which is precisely the kind of guarantee that is worth nothing until it is unconditional.
 *
 * So the rule these tests hold the fork to, and it is not about any one provider:
 *
 * > 🔴 **A write into the data root takes the DESTINATION's state. Staging state is never inherited.**
 *
 * The fixture makes the failure visible because its `copyFile` inherits from the source (the §8 rename
 * contract) and it does not implement `multerStorage` — which is exactly the conforming-but-minimal provider
 * the interface allows, and exactly the one every other fixture in this directory is not.
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

/** A minimal but well-formed chat. */
function chatBody(marker) {
    return [
        { user_name: 'User', character_name: CHAR_DIR, create_date: '2026-07-20', chat_metadata: {} },
        { name: CHAR_DIR, is_user: false, mes: `hello from chat ${marker}`, send_date: '2026-07-20' },
    ];
}

/** The smallest valid PNG, so the background upload is a real image and not a renamed text file. */
const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

describe('🔴 uploads and imports take the destination\'s state, never the staging file\'s', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {import('./util/st-server.js').RunningServer|null} */
    let server = null;
    /** @type {string} */
    let base;
    /** @type {string|undefined} */
    let cookie;

    const userRoot = () => path.join(dataRoot, 'default-user');
    const listRaw = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

    /**
     * On-disk name → logical name. The fixture's scheme, restated so drift breaks a test.
     * @param {string} name The marked on-disk name
     * @returns {string} The logical name it hides
     */
    function demangle(name) {
        const ext = path.extname(name);
        return Buffer.from(name.slice('enc~'.length, name.length - ext.length), 'base64url').toString('utf-8') + ext;
    }

    /**
     * Everything raw `fs` sees in a directory, split into the two namespaces.
     *
     * ⚠️ Scoped to files the TEST created, never to the whole directory. The seed boot runs before the
     * provider is installed and content-seeds default backgrounds in the clear — correctly, they predate the
     * provider and §1 says they stay as they are — so "every file here is marked" is a false statement about
     * a healthy install, and a test asserting it fails for the one reason that is not a bug.
     * @param {string} directory The directory to inspect
     * @returns {{raw: string[], logical: string[]}} On-disk names, and the logical names they resolve to
     */
    function inspect(directory) {
        const raw = listRaw(directory).filter((n) => fs.statSync(path.join(directory, n)).isFile());
        return { raw, logical: raw.map((n) => (n.startsWith('enc~') ? demangle(n) : n)) };
    }

    /**
     * Assert that one logical file arrived encrypted: marked on disk, enveloped, and with its plaintext
     * findable nowhere in the directory.
     * @param {string} directory The directory it landed in
     * @param {string} logicalName The name the application knows it by
     * @param {string|Buffer} needle Content that must not appear in the clear anywhere
     * @returns {void}
     */
    function expectStoredEncrypted(directory, logicalName, needle) {
        const { raw, logical } = inspect(directory);

        // ⚠️ EXISTS FIRST. Every assertion below passes vacuously against an import that silently did nothing
        // — the vacuous green §10 warns about, which this project has produced five of.
        expect(logical).toContain(logicalName);

        // Not sitting there under its own name, in the clear.
        expect(raw).not.toContain(logicalName);

        const marked = raw.find((n) => n.startsWith('enc~') && demangle(n) === logicalName);
        expect(marked).toBeDefined();

        const bytes = fs.readFileSync(path.join(directory, marked));
        expect(bytes.subarray(0, 6).toString('utf-8')).toBe('stenv:');

        // And the content is in no file in the directory, under any name.
        for (const name of raw) {
            expect(fs.readFileSync(path.join(directory, name)).includes(needle)).toBe(false);
        }
    }

    /**
     * POST a multipart form as the current session — what an upload path actually receives.
     * @param {string} route The route
     * @param {FormData} form The form
     * @returns {Promise<{status: number, text: string, body: any}>} The response
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

        return { status: response.status, text, body: parsed };
    }

    beforeAll(async () => {
        scratch = makeScratchDirectory('upload-staging');
        dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);

        // The character's chat directory has to exist before a chat can be imported into it — the import
        // endpoint writes into `chats/<avatar>` and does not create it. A real install gets it when the
        // character is created.
        fs.mkdirSync(path.join(dataRoot, 'default-user', 'chats', CHAR_DIR), { recursive: true });

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

        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);

        base = `http://127.0.0.1:${server.port}`;

        const response = await fetch(`${base}/api/users/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: 'default-user', password: PASSWORD }),
        });

        cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        if (response.status !== 200) throw new Error(`Login failed: ${response.status}`);
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    test('🔴 an imported character chat is encrypted on disk, and its text appears in no file', async () => {
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

        expectStoredEncrypted(
            path.join(userRoot(), 'chats', CHAR_DIR),
            String(result.body.fileNames[0]),
            'hello from chat IMPORTED',
        );
    }, 240_000);

    test('🔴 an imported GROUP chat is encrypted on disk, and its text appears in no file', async () => {
        const jsonl = chatBody('GROUPED').map((m) => JSON.stringify(m)).join('\n');

        const form = new FormData();
        form.set('avatar', new File([jsonl], 'group.jsonl', { type: 'application/octet-stream' }));

        const result = await postForm('/api/chats/group/import', form);
        expect(result.status).toBe(200);
        expect(result.body?.error).toBeUndefined();

        // The endpoint names the chat it created; the file is that name plus the extension it chose.
        expectStoredEncrypted(
            path.join(userRoot(), 'group chats'),
            `${result.body.res}.jsonl`,
            'hello from chat GROUPED',
        );
    }, 240_000);

    test('🔴 an uploaded background is encrypted on disk — a picture the user chose is user data too', async () => {
        const form = new FormData();
        form.set('avatar', new File([ONE_PIXEL_PNG], 'a-background.png', { type: 'image/png' }));

        const result = await postForm('/api/backgrounds/upload', form);
        expect(result.status).toBe(200);

        // ⚠️ The needle is the PNG's own bytes, not its signature: the default backgrounds seeded before the
        // provider existed are PNGs too, sitting in the clear exactly as §1 says they should, and a signature
        // needle would flag them and call a correct install a leak.
        expectStoredEncrypted(path.join(userRoot(), 'backgrounds'), 'a-background.png', ONE_PIXEL_PNG);
    }, 240_000);

    test('🔴 nothing is left behind in the staging directory', async () => {
        // The staging copy is deleted by every one of these handlers, and it must stay that way: a leftover
        // upload is the same plaintext exposure one directory over, and it survives the request that made it.
        // 🔴 `_uploads`, WITH THE UNDERSCORE — see UPLOADS_DIRECTORY in src/constants.js. This read
        // `uploads` for the life of the test, and `listRaw` answers a missing directory with `[]`, so the
        // assertion was `expect([]).toEqual([])`: it could not fail, and all three upload paths this suite
        // drives had no leftover-staging coverage at all. A test that cannot fail is worse than no test,
        // because it is counted.
        const uploads = path.join(userRoot(), UPLOADS_DIRECTORY);

        // 🔴 THE CONTROL, WITHOUT WHICH THIS IS STILL VACUOUS. `listRaw` answers a missing directory with
        // `[]` — the very property that hid the typo above — so "empty" only means anything once the
        // directory is known to be there. Three uploads have gone through it by now.
        expect(fs.existsSync(uploads)).toBe(true);

        expect(listRaw(uploads).filter((n) => fs.statSync(path.join(uploads, n)).isFile())).toEqual([]);
    }, 240_000);
});
