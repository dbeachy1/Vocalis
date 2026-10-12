import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { startSillyTavern, makeScratchDirectory } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

/** See `plugin-context.test.js` — the plugins directory is not configurable, so fixtures go in the real one. */
// A scratch directory, not the repository's real `plugins/`. The fork now honours `pluginsPath`, so a
// suite no longer has to share one process-wide directory with every other suite AND with whatever is
// genuinely installed on the machine.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');
const FIXTURE = path.join(testDirectory, 'fixtures', 'chat-delete-plugin.mjs');

const HANDLE = 'default-user';
const GROUP_ID = 'e4c9f1a2-0b77-4a1e-9d3f-2c8a5b6e7f01';

/** Every file we created outside the scratch directory, so afterAll can take them out again. */
const created = [];

/**
 * Turn an absolute path into something an `import` statement will accept on any platform.
 * @param {string} absolutePath The path to import
 * @returns {string} A file:// URL
 */
function pathToImportSpecifier(absolutePath) {
    return new URL(`file:///${absolutePath.split(path.sep).join('/')}`).href;
}

/**
 * Install a plugin fixture so a boot will pick it up.
 * @param {string} fixturePath Absolute path to the fixture module
 * @param {string} name Base name for the installed shim
 * @returns {void}
 */
function installPlugin(fixturePath, name) {
    const target = path.join(PLUGINS_DIRECTORY, `${name}.mjs`);
    fs.writeFileSync(target, `export { info, init } from ${JSON.stringify(pathToImportSpecifier(fixturePath))};\n`, 'utf-8');
    created.push(target);
}

/**
 * Write a file, making its directory first.
 * @param {string} target Absolute path
 * @param {string} contents What to write
 * @returns {void}
 */
function plant(target, contents) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf-8');
}

/**
 * 🔴 §24 — DOES EVERY DELETION PATH ANNOUNCE, AND DOES THE ONE THAT MUST NOT STAY QUIET?
 *
 * A consumer's scenario rows are keyed on `chatId` and there is **no garbage collector behind them**. A
 * deletion path that stays silent therefore leaks rows for the life of the install, and — because chat ids are
 * user-renameable strings — a later chat that reuses the id inherits a stale high-water mark and never ingests
 * a turn. Both failures are permanent and neither raises anything.
 *
 * So this drives all four real endpoints against real files and asserts on what the plugin heard. The
 * negative case is the one to read first: **a card deleted WITHOUT its chats must announce nothing**, because
 * those chat files are still on disk under unchanged names and their memories are still reachable and still
 * correct. Announcing there would destroy live data on what is usually a re-import.
 */
describe('🗑️  §24 — every path that deletes a chat says so, and the one that does not delete one stays quiet', () => {
    /** @type {string[]} */
    let journal = [];
    /** @type {Record<string, number>} */
    let status = {};

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-chat-delete');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const journalPath = path.join(scratch, 'chat-delete.journal');

        const userRoot = path.join(dataRoot, HANDLE);

        // A solo chat, for /api/chats/delete.
        plant(path.join(userRoot, 'chats', 'Solo', 'solo-chat.jsonl'), '{}\n');

        // A character WITH chats, for /api/characters/delete { delete_chats: true }. The endpoint only checks
        // that the avatar file exists and unlinks it — it never parses the card — so a stub file is enough.
        plant(path.join(userRoot, 'characters', 'Doomed.png'), 'not-really-a-png');
        plant(path.join(userRoot, 'chats', 'Doomed', 'doomed-a.jsonl'), '{}\n');
        plant(path.join(userRoot, 'chats', 'Doomed', 'doomed-b.jsonl'), '{}\n');

        // 🔴 A character WITHOUT chats, for { delete_chats: false }. Its chat must survive AND stay unannounced.
        plant(path.join(userRoot, 'characters', 'Kept.png'), 'not-really-a-png');
        plant(path.join(userRoot, 'chats', 'Kept', 'kept-chat.jsonl'), '{}\n');

        // One group conversation, for /api/chats/group/delete — the fourth path, absent from the consumer's list.
        plant(path.join(userRoot, 'group chats', 'lone-group-chat.jsonl'), '{}\n');

        // A whole group with two chats, for /api/groups/delete.
        plant(path.join(userRoot, 'group chats', 'group-chat-1.jsonl'), '{}\n');
        plant(path.join(userRoot, 'group chats', 'group-chat-2.jsonl'), '{}\n');
        plant(path.join(userRoot, 'groups', `${GROUP_ID}.json`), JSON.stringify({
            id: GROUP_ID, name: 'The Crew', members: [], chats: ['group-chat-1', 'group-chat-2'], chat_id: 'group-chat-1',
        }));

        installPlugin(FIXTURE, 'zz-chat-delete-probe');

        const server = await startSillyTavern({
            dataRoot,
            configPath,
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                // 🔴 Never let a test git-pull the plugins directory. Auto-update defaults to TRUE.
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'chat-delete-probe',
                ST_PLUGIN_JOURNAL: journalPath,
            },
        });

        const base = `http://127.0.0.1:${server.port}`;
        const post = async (route, body) => {
            const response = await fetch(`${base}${route}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return response.status;
        };

        try {
            // 1. One solo chat. Sent WITHOUT the extension, which is how the client sends it.
            status.solo = await post('/api/chats/delete', { chatfile: 'solo-chat', avatar_url: 'Solo.png' });

            // 2. One group conversation.
            status.groupChat = await post('/api/chats/group/delete', { id: 'lone-group-chat' });

            // 3. A character, taking its chats with it.
            status.withChats = await post('/api/characters/delete', { avatar_url: 'Doomed.png', delete_chats: true });

            // 4. 🔴 A character, LEAVING its chats. Must announce nothing.
            status.withoutChats = await post('/api/characters/delete', { avatar_url: 'Kept.png', delete_chats: false });

            // 5. A whole group.
            status.group = await post('/api/groups/delete', { id: GROUP_ID });

            // The kept chat must still be on disk — proving (4) was a real no-op and not a silent failure.
            status.keptStillThere = fs.existsSync(path.join(userRoot, 'chats', 'Kept', 'kept-chat.jsonl')) ? 1 : 0;
        } finally {
            await server.stop();
        }

        journal = fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
            : [];
    }, 120_000);

    afterAll(() => {
        for (const target of created) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    /** The chat ids announced, in order. */
    const announced = () => journal.filter(line => line.startsWith('deleted ')).map(line => line.replace(`deleted ${HANDLE} `, ''));

    test('the probe registered and the endpoints answered — otherwise everything below is vacuous', () => {
        expect(journal).toContain('onChatDeleted: function');
        expect(status.solo).toBe(200);
        expect(status.groupChat).toBe(200);
        expect(status.withChats).toBe(200);
        expect(status.withoutChats).toBe(200);
        expect(status.group).toBe(200);
    });

    test('🔴 a solo chat delete announces the id WITHOUT the .jsonl the endpoint appended', () => {
        // The client sends `chatfile` without the extension and the handler appends it. Emitting the body
        // verbatim would announce `solo-chat.jsonl`, which matches zero rows in the consumer and reports
        // success. This asserts the id is spelled the way `getCurrentChatId()` spells it.
        expect(announced()).toContain('solo-chat');
        expect(announced()).not.toContain('solo-chat.jsonl');
    });

    test('deleting ONE conversation from a group announces it — the fourth path', () => {
        expect(announced()).toContain('lone-group-chat');
    });

    test('🔴 a character deleted WITH its chats announces every one of them', () => {
        // This is the path that needed real work: the endpoint `rm -rf`s the folder and names no file, so
        // without enumerating first it could not announce anything at all.
        expect(announced()).toContain('doomed-a');
        expect(announced()).toContain('doomed-b');
    });

    test('🔴 a character deleted WITHOUT its chats announces NOTHING, and the chat survives', () => {
        // The load-bearing negative. Those chat files are still on disk under unchanged names, so anything
        // keyed on `chatId` is still reachable and still correct — and a card delete is usually a re-import.
        // Announcing here would destroy live, retrievable memories.
        expect(announced()).not.toContain('kept-chat');
        expect(status.keptStillThere).toBe(1);
    });

    test('deleting a whole group announces each of its chats', () => {
        expect(announced()).toContain('group-chat-1');
        expect(announced()).toContain('group-chat-2');
    });

    test('every announcement carries the owning handle', () => {
        for (const line of journal.filter(one => one.startsWith('deleted '))) {
            expect(line).toMatch(new RegExp(`^deleted ${HANDLE} `));
        }
    });

    test('no announcement carries a path component or an extension', () => {
        // A directory component or a stray extension in the id is the silent-failure shape this whole
        // feature is designed around, so assert it across every signal rather than only the ones above.
        for (const id of announced()) {
            expect(id).not.toMatch(/[/\\]/);
            expect(id).not.toMatch(/\.jsonl$/i);
        }
    });
});
