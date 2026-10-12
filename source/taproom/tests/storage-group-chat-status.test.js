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
 * 👥 GROUP CHATS ARE IN A DIFFERENT DIRECTORY, AND THAT IS THE WHOLE BUG — `DESIGN_MIXED_MODE.md` §7, §11.
 *
 * Every marker suite before this one asks about `chats/<character>/<chat>.jsonl`. Group chats live in a flat
 * `group chats/` beside it, and `/api/storage/chat-status` resolved names under the character root only — so
 * a group chat could never be reported as encrypted, and an uninstalled one could never be reported as
 * unavailable. §11 exists precisely to stop a user concluding their data is gone; it was unenforced in one
 * of the two directories chats live in.
 *
 * ## 🔴 The assertion that stops this suite being vacuous
 *
 * "The group chat reports encrypted" is satisfied by an endpoint that reports EVERYTHING as encrypted, and
 * "the flag works" is satisfied by an endpoint that ignores the flag and happens to be right. So each
 * property is asserted against its opposite: the same names are asked for WITH and WITHOUT `group: true`,
 * and the two answers must differ. A flag that changed nothing would fail here even though every
 * single-sided expectation still passed.
 */

/** Created before the provider exists: plaintext for ever (§1). */
const LEGACY_CHAT = 'legacy-group-chat';

/** Created while the provider is installed: encrypted end to end. */
const SECRET_CHAT = 'secret-group-chat';

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

/**
 * On-disk name → logical name, the fixture's scheme spelled out independently of the fixture (same
 * discipline as the lifecycle suite: two statements of one format, so drift breaks a test).
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
        { user_name: 'User', character_name: 'Group', create_date: '2026-07-20', chat_metadata: {} },
        { name: 'Someone', is_user: false, mes: `hello from ${marker}`, send_date: '2026-07-20' },
    ];
}

describe('👥 the per-chat marker reaches GROUP chats (§7, §11)', () => {
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
    /** @type {string} */
    let groupId;
    /** @type {string} */
    let secretOnDiskName;

    const groupChatsDir = () => path.join(dataRoot, 'default-user', 'group chats');
    const groupsDir = () => path.join(dataRoot, 'default-user', 'groups');
    const onDiskGroupChats = () => (fs.existsSync(groupChatsDir()) ? fs.readdirSync(groupChatsDir()).sort() : []);

    /**
     * POST some JSON as the current session. Survives a bare-word refusal like "Forbidden".
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
     * Stop the running server and boot a fresh one against the SAME data root, with the provider or without
     * it. Booting without it is how "uninstall" is modelled.
     * @param {{provider: boolean}} options Whether to load the storage provider this boot
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
     * Log in as the default user and keep the session cookie.
     * @returns {Promise<{status: number, body: any, text: string, cookie: string}>} The login response
     */
    async function login() {
        const result = await post('/api/users/login', { handle: 'default-user', password: PASSWORD });
        cookie = result.cookie || cookie;
        return result;
    }

    const groupStatus = (chats) => post('/api/storage/chat-status', { chats, group: true });
    const characterStatus = (chats) => post('/api/storage/chat-status', { chats });
    const searchGroupChats = () => post('/api/chats/search', { query: '', avatar_url: null, group_id: groupId });

    beforeAll(async () => {
        scratch = makeScratchDirectory('group-chat-status');
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        providersPath = path.join(scratch, 'storage-providers');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        await setPassword(dataRoot);

        // 🔴 THE LEGACY GROUP CHAT IS PLANTED WITH RAW `fs`, BEFORE THE PROVIDER EXISTS. That is what makes
        // it legacy; one created through the provider could never stand in for "predates the plugin", and
        // without it the mixed half of every assertion below would be decorative.
        fs.mkdirSync(groupChatsDir(), { recursive: true });
        fs.writeFileSync(
            path.join(groupChatsDir(), `${LEGACY_CHAT}.jsonl`),
            chatBody('the legacy group chat').map((m) => JSON.stringify(m)).join('\n') + '\n',
        );

        // 🔴 THE GROUP DEFINITION IS PLANTED PLAINTEXT TOO, AND THAT IS THE SCENARIO, NOT A SHORTCUT.
        //
        // A group created THROUGH the installed provider has an encrypted definition, and an encrypted
        // definition is unreadable once the plugin is gone — `/api/groups/all` swallows the parse failure
        // and the whole group disappears, taking its chat list with it. That is real, and it is the
        // non-chat-data-type gap (`DESIGN_STORAGE_PROVENANCE.md`), not this suite's subject: it would hide
        // the chat-level behaviour under a group-level one and prove nothing about either.
        //
        // What is modelled instead is the case a real user reaches: a group that predates the plugin. §8
        // inheritance keeps its definition plaintext for ever — every later `/api/groups/edit` writes back
        // into an existing plaintext file — so the group stays visible while the chats inside it go mixed.
        groupId = '1700000000000';
        fs.mkdirSync(groupsDir(), { recursive: true });
        fs.writeFileSync(path.join(groupsDir(), `${groupId}.json`), JSON.stringify({
            id: groupId,
            name: 'The Group',
            members: [],
            avatar_url: '',
            allow_self_responses: false,
            activation_strategy: 0,
            generation_mode: 0,
            disabled_members: [],
            chat_id: LEGACY_CHAT,
            chats: [LEGACY_CHAT, SECRET_CHAT],
            auto_mode_delay: 5,
        }, null, 4));

        installStorageProvider(providersPath, MIXED_PROVIDER);
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    // 1 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('1. with the provider installed, a new group chat is enveloped under a marked name', async () => {
        await reboot({ provider: true });
        expect((await login()).status).toBe(200);

        // The group planted in `beforeAll` is visible, and it is the one the chats below belong to.
        const groups = await post('/api/groups/all', {});
        expect(groups.body.map((g) => g.id)).toContain(groupId);

        expect((await post('/api/chats/group/save', { id: SECRET_CHAT, chat: chatBody('the secret group chat'), force: true })).body)
            .toEqual({ ok: true });

        // The provider mangled the name and enveloped the bytes; raw `fs` cannot find it by logical name.
        expect(onDiskGroupChats()).toContain(`${LEGACY_CHAT}.jsonl`);
        expect(onDiskGroupChats()).not.toContain(`${SECRET_CHAT}.jsonl`);

        const marked = onDiskGroupChats().filter((n) => n.startsWith('enc~') && n.endsWith('.jsonl'));
        expect(marked.map(demangle)).toEqual([`${SECRET_CHAT}.jsonl`]);
        secretOnDiskName = marked[0];

        const raw = fs.readFileSync(path.join(groupChatsDir(), secretOnDiskName), 'utf-8');
        expect(raw.startsWith('stenv:1:mixed-provider:')).toBe(true);
        expect(raw).not.toContain('hello from the secret group chat');
    }, 240_000);

    // 2 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('2. 🔴 the marker answers for BOTH group chats — one encrypted, one not, in one reply', async () => {
        const status = await groupStatus([`${LEGACY_CHAT}.jsonl`, `${SECRET_CHAT}.jsonl`]);

        expect(status.status).toBe(200);
        expect(status.body.chats[`${SECRET_CHAT}.jsonl`].encrypted).toBe(true);
        expect(status.body.chats[`${LEGACY_CHAT}.jsonl`].encrypted).toBe(false);

        // The tooltip words are the PROVIDER'S, exactly as for a character chat — a group chat does not get
        // a second vocabulary, and the fork still has none of its own (§6.2).
        expect(status.body.marker).toBe('FIXTURE: this chat is encrypted at rest.');
    }, 240_000);

    // 3 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('3. 🔴 THE FLAG IS LOAD-BEARING: the same names without it resolve somewhere else entirely', async () => {
        // Without `group: true` these names are joined onto `chats/`, where no such file exists — so the
        // encrypted group chat comes back "not encrypted". This is the exact bug: the endpoint was being
        // asked the wrong question and answering it correctly, and the padlock silently never drew.
        //
        // Asserting the WRONG answer on purpose. If someone later makes the endpoint search both roots, this
        // test goes red and should be read as a design question, not a nuisance — searching both roots means
        // a name that exists in both becomes ambiguous, and the caller always knows which it meant.
        const wrong = await characterStatus([`${SECRET_CHAT}.jsonl`]);
        const right = await groupStatus([`${SECRET_CHAT}.jsonl`]);

        expect(wrong.body.chats[`${SECRET_CHAT}.jsonl`].encrypted).toBe(false);
        expect(right.body.chats[`${SECRET_CHAT}.jsonl`].encrypted).toBe(true);
    }, 240_000);

    // 4 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('4. 🔴 `group: true` cannot be walked back into the character tree', async () => {
        // A group request must stay inside `group chats/`. `directory` is meaningless for a flat directory
        // and is dropped, and a name spelled as a traversal is sanitised to something harmless — so neither
        // reaches a character chat. Both are asserted by asking for a path that WOULD resolve if either
        // guard were missing.
        const escaped = await groupStatus([
            { name: `${SECRET_CHAT}.jsonl`, directory: '../../chats' },
            { name: `../group chats/${SECRET_CHAT}.jsonl`, directory: '' },
        ]);

        expect(escaped.status).toBe(200);

        // The first entry must land on the real group chat (the bogus directory was dropped, not honoured);
        // the second must land nowhere at all.
        expect(escaped.body.chats[`${SECRET_CHAT}.jsonl`].encrypted).toBe(true);
        expect(escaped.body.chats[`../group chats/${SECRET_CHAT}.jsonl`]).toEqual({
            encrypted: false, unavailable: false, requiresProvider: null, identity: null,
        });
    }, 240_000);

    // 5 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('5. the group chat list carries BOTH chats, so there are rows for the markers to decorate', async () => {
        // A marker is worthless without the row it decorates, and the two come from different endpoints —
        // the list from `/api/chats/search`, the state from `/api/storage/chat-status`. This is the join:
        // every name the list produces must be a name the status endpoint answers for.
        const listed = await searchGroupChats();
        expect(listed.status).toBe(200);

        const names = listed.body.map((c) => c.file_name).sort();
        expect(names).toEqual([LEGACY_CHAT, SECRET_CHAT].sort());

        // The rows carry the id WITHOUT the extension — the same shape that silently broke the character
        // chat list, where the client sent the bare id and every chat resolved to a path that does not
        // exist. Asserted here so a change to the list's spelling breaks a test rather than a padlock.
        const status = await groupStatus(names.map((n) => `${n}.jsonl`));
        expect(status.body.chats[`${SECRET_CHAT}.jsonl`].encrypted).toBe(true);
        expect(status.body.chats[`${LEGACY_CHAT}.jsonl`].encrypted).toBe(false);
    }, 240_000);

    // 6 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('6. 🔴 uninstalled: the encrypted group chat is UNAVAILABLE and names the provider it needs (§11)', async () => {
        await reboot({ provider: false });
        expect((await login()).status).toBe(200);

        // With no provider, the on-disk name is the mangled one — the same shape the character list shows.
        const status = await groupStatus([secretOnDiskName, `${LEGACY_CHAT}.jsonl`]);

        expect(status.status).toBe(200);
        expect(status.body.chats[secretOnDiskName]).toEqual({
            encrypted: true,
            unavailable: true,
            requiresProvider: 'mixed-provider',
            // 🪪 `DESIGN_STORAGE_PROVENANCE.md` §7: the id is read off this file's own envelope, and the
            // NAME beside it comes from the fork's record of the provider it watched run at step 1 —
            // written outside the data directory, so a planted chat cannot conjure one. A group chat is not
            // a second class of row here: it earns the same sentence a character chat does.
            identity: expect.objectContaining({ id: 'mixed-provider', name: 'FIXTURE Mixed-Mode Provider' }),
        });

        // And the chat that predates the plugin is untouched by all of it (§1) — no provider to name,
        // because there is nothing to name one for.
        expect(status.body.chats[`${LEGACY_CHAT}.jsonl`]).toEqual({
            encrypted: false, unavailable: false, requiresProvider: null, identity: null,
        });
    }, 240_000);

    // 7 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('7. 🔴 uninstalled: the encrypted group chat is still IN THE LIST, as a dead row (§11, §14.7)', async () => {
        // 🔴 THE ROW USED TO VANISH, WHICH IS WORSE THAN THE THING §11 FORBIDS. A group's chats are found by
        // ID from its definition — `<id>.jsonl`, then `storage.exists` — not by scanning the directory the
        // way a character's are. With no provider the logical name does not exist, the filter dropped it,
        // and the encrypted group chat disappeared from the list altogether: "my chats are gone", in the
        // one screen a user opens to look for them.
        const listed = await searchGroupChats();
        expect(listed.status).toBe(200);

        const rows = listed.body;
        expect(rows.map((c) => c.file_name).sort()).toEqual([LEGACY_CHAT, SECRET_CHAT].sort());

        // The unresolved one carries its state with it, because the per-chat status endpoint resolves a
        // PATH and there is no path to resolve — asking it would get "ordinary file" and draw nothing.
        const dead = rows.find((c) => c.file_name === SECRET_CHAT);
        expect(dead.storage).toEqual({ encrypted: true, unavailable: true, requiresProvider: null, identity: null });

        // ⚠️ `requiresProvider` is null ON PURPOSE (§14.7). The id in §3.1 comes from the file's OWN
        // envelope and there is no file here; naming the provider off a sibling's envelope would be an
        // inference rendered as a fact. If that is ever decided differently this assertion is the one to
        // change, and it should be changed deliberately rather than relaxed to `expect.anything()`.
        expect(dead.storage.requiresProvider).toBeNull();

        // 🪪 AND THE PROVENANCE REGISTRY DOES NOT CHANGE THAT, WHICH IS WORTH SAYING OUT LOUD. A record for
        // `mixed-provider` exists on this instance — step 1 wrote one — so it is tempting to reach for it
        // here. The registry answers "what do I know about the provider this FILE names", and no file here
        // names one: it is the id that is missing, not the record of it. Filling it in from the only entry
        // that happens to be present is the same §14.7 inference wearing a new hat.
        expect(dead.storage.identity).toBeNull();

        // Nothing was measured, so nothing is claimed — no invented size, count, or date.
        expect(dead.file_size).toBe('');
        expect(dead.message_count).toBe(0);
        expect(dead.last_mes).toBeNull();

        // And the chat that predates the plugin is a completely ordinary row, carrying no state at all.
        const legacy = rows.find((c) => c.file_name === LEGACY_CHAT);
        expect(legacy.storage).toBeUndefined();
        expect(legacy.message_count).toBeGreaterThan(0);
    }, 240_000);

    // 8 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('8. 🔴 THE GATE: an install with no encryption anywhere is completely unaffected', async () => {
        // The rows above are gated on the group chats directory holding an envelope, and this is why. A
        // group can claim an id whose chat was simply deleted, and on an ordinary install that must stay
        // invisible rather than becoming a permanent dead row telling the user to install a plugin that
        // would not bring anything back. Proved by removing the only enveloped file and re-asking.
        const enveloped = path.join(groupChatsDir(), secretOnDiskName);
        const stashed = fs.readFileSync(enveloped);
        fs.unlinkSync(enveloped);

        const listed = await searchGroupChats();
        expect(listed.status).toBe(200);
        expect(listed.body.map((c) => c.file_name)).toEqual([LEGACY_CHAT]);

        fs.writeFileSync(enveloped, stashed);
    }, 240_000);

    // 9 ──────────────────────────────────────────────────────────────────────────────────────────────────
    test('9. an anonymous caller is refused, and learns neither group chat', async () => {
        const saved = cookie;
        cookie = undefined;
        const anonymous = await groupStatus([secretOnDiskName, `${LEGACY_CHAT}.jsonl`]);
        cookie = saved;

        expect(anonymous.status).toBe(403);
        expect(anonymous.text).toBe('Forbidden');
        expect(anonymous.text).not.toContain(LEGACY_CHAT);
        expect(anonymous.text).not.toContain('mixed-provider');
    }, 240_000);
});
