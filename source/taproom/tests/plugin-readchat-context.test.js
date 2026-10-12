import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { startSillyTavern, makeScratchDirectory } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');
const READCHAT_FIXTURE = path.join(testDirectory, 'fixtures', 'readchat-plugin.mjs');
const SEAM_PROVIDER = path.join(testDirectory, 'fixtures', 'seam-provider.js');

const HANDLE = 'default-user';
const AVATAR_STEM = '4f0d2c9e-portrait';
const CHAT_ID = 'Marcus - 2026-09-18@10h00m00s';
const GROUP_ID = '1726650000000';
const MARCUS_ID = 'c0a1e2d3-0000-4000-8000-000000000001';

/** The seam provider's on-disk marker (`seam-provider.js`). A chat planted with it reads only through the provider. */
const MARK = 'SEAM:';

/** Every file we created, so afterAll can take them out again. */
const created = [];

/**
 * @param {string} absolutePath The path to import
 * @returns {string} A file:// URL
 */
function pathToImportSpecifier(absolutePath) {
    return new URL(`file:///${absolutePath.split(path.sep).join('/')}`).href;
}

/**
 * Write a chat as JSONL, marked the way the seam provider would have written it.
 * @param {string} file Absolute path
 * @param {object[]} rows Header and messages
 * @returns {void}
 */
function plantChat(file, rows) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, MARK + rows.map(row => JSON.stringify(row)).join('\n'), 'utf-8');
}

/**
 * 🔴 PLUGIN API v7, THROUGH A REAL SERVER. The unit suite (`plugin-read-chat.test.js`) proves the turns match
 * `recentMessages`; this proves a plugin can actually reach them — that `context.readChat` exists on the context,
 * resolves the user's real directories (including the space in `group chats`), validates what a plugin passes,
 * and reads THROUGH THE STORAGE PROVIDER. The chats are planted marked, so a raw `fs` read would fail to parse
 * the header line, drop it, and then drop the first message as if it were the header — every index off by one.
 */
describe('🔌 context.readChat on a booted server (plugin API v7)', () => {
    /** @type {any} */
    let out = {};
    let status = 0;

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-readchat');
        const dataRoot = path.join(scratch, 'data');
        const providersPath = path.join(scratch, 'storage-providers');
        fs.mkdirSync(providersPath, { recursive: true });
        fs.copyFileSync(SEAM_PROVIDER, path.join(providersPath, 'seam-provider.js'));

        const userRoot = path.join(dataRoot, HANDLE);
        fs.mkdirSync(userRoot, { recursive: true });
        fs.writeFileSync(path.join(userRoot, 'character-ids.json'), JSON.stringify({ version: 1, ids: { [`${AVATAR_STEM}.png`]: MARCUS_ID } }), 'utf-8');

        plantChat(path.join(userRoot, 'chats', AVATAR_STEM, `${CHAT_ID}.jsonl`), [
            { user_name: 'Test User', character_name: 'Marcus', chat_metadata: {} },
            { name: 'Marcus', is_user: false, mes: 'Hello.', send_date: '2026-09-18T10:00:00.000Z' },
            { name: 'Test User', is_user: true, mes: 'Hidden.', is_system: true, send_date: '2026-09-18T10:00:01.000Z' },
            { name: 'Test User', is_user: true, mes: 'Hi.', send_date: '2026-09-18T10:00:02.000Z' },
        ]);
        plantChat(path.join(userRoot, 'group chats', `${GROUP_ID}.jsonl`), [
            { chat_metadata: {} },
            { name: 'Marcus', is_user: false, mes: 'Group hello.', original_avatar: `${AVATAR_STEM}.png`, send_date: '2026-09-18T11:00:00.000Z' },
        ]);

        const shim = path.join(PLUGINS_DIRECTORY, 'zz-readchat-probe.mjs');
        fs.writeFileSync(shim, `export { info, init } from ${JSON.stringify(pathToImportSpecifier(READCHAT_FIXTURE))};\n`, 'utf-8');
        created.push(shim);

        const server = await startSillyTavern({
            dataRoot,
            configPath: path.join(scratch, 'config.yaml'),
            pluginsPath: PLUGINS_DIRECTORY,
            storageProvidersPath: providersPath,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                // 🔴 Never let a test git-pull the plugins directory. Auto-update defaults to TRUE.
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'readchat-probe',
            },
        });

        try {
            const query = new URLSearchParams({ handle: HANDLE, chatId: CHAT_ID, groupId: GROUP_ID });
            const response = await fetch(`http://127.0.0.1:${server.port}/api/plugins/readchat-probe/probe?${query}`);
            status = response.status;
            out = status === 200 ? await response.json() : {};
        } finally {
            await server.stop();
        }
    }, 120_000);

    afterAll(() => {
        for (const target of created) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the probe ran, and the context announces v7 with readChat on it', () => {
        expect(status).toBe(200);
        expect(out.apiVersion).toBeGreaterThanOrEqual(7);
        expect(out.present).toBe('function');
    });

    test('🔴 a solo chat reads through the provider: header dropped, hidden turn a gap, ids and times resolved', () => {
        expect(out.solo).toEqual([
            { role: 'assistant', name: 'Marcus', content: 'Hello.', index: 0, charId: MARCUS_ID, sendDate: Date.parse('2026-09-18T10:00:00.000Z') },
            { role: 'user', name: 'Test User', content: 'Hi.', index: 2, charId: null, sendDate: Date.parse('2026-09-18T10:00:02.000Z') },
        ]);
    });

    test('`last` trims to the trailing turns', () => {
        expect(out.last.map(turn => turn.index)).toEqual([2]);
    });

    test('a group chat reads from `group chats/`, with the speaker\'s id', () => {
        expect(out.group).toEqual([
            { role: 'assistant', name: 'Marcus', content: 'Group hello.', index: 0, charId: MARCUS_ID, sendDate: Date.parse('2026-09-18T11:00:00.000Z') },
        ]);
    });

    test('an unknown id is null', () => {
        expect(out.unknown).toBe('NULL');
    });

    test('malformed arguments throw TypeError, naming the plugin', () => {
        for (const key of ['badLast', 'badLastType', 'badOptions', 'climbing', 'badHandle']) {
            expect(out[key]).toMatch(/^THREW TypeError: .*readchat-probe/);
        }
    });
});
