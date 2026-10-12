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
const FIXTURE = path.join(testDirectory, 'fixtures', 'chat-rename-plugin.mjs');

const HANDLE = 'default-user';

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
 * 🔴 §24.4 — DOES A RENAME ANNOUNCE A *MOVE*, AND DOES A FAILED ONE STAY QUIET?
 *
 * A renamed chat keeps its contents and changes its id. Announce nothing and the consumer's scenario rows sit
 * under a key nothing will ever query again — live data loss on a conversation still in progress, with no
 * garbage collector behind it. Announce a *deletion* instead and the consumer discards those rows on purpose,
 * which is strictly worse.
 *
 * So this drives the real endpoint against real files, for solo and group chats both, and asserts on what the
 * plugin heard — including, load-bearingly, what it did **not** hear. Two negatives carry the suite:
 *
 * - **A rename announces no deletion.** The probe registers for both signals, so this cannot pass vacuously.
 * - **A REFUSED rename announces nothing, and the original file is still on disk.** That pair is what proves
 *   the announcement sits inside the success branch (§24.6). If it were emitted before the unlink, a consumer
 *   would re-key its partition to an id that does not exist on disk — and on a vault install, a locked vault
 *   would announce a rename that never happened.
 */
describe('✏️  §24.4 — a renamed chat announces a MOVE, and a refused rename announces nothing', () => {
    /** @type {string[]} */
    let journal = [];
    /** @type {Record<string, number>} */
    let status = {};

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-chat-rename');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const journalPath = path.join(scratch, 'chat-rename.journal');

        const userRoot = path.join(dataRoot, HANDLE);

        // A solo chat, for the ordinary rename.
        plant(path.join(userRoot, 'chats', 'Seraphina', 'old-solo.jsonl'), '{}\n');

        // A group conversation. One endpoint serves both; only the folder differs.
        plant(path.join(userRoot, 'group chats', 'old-group.jsonl'), '{}\n');

        // 🔴 A rename that must be REFUSED, because its destination already exists. Nothing may be announced
        // and the source must survive — that pair is the proof the signal is inside the success branch.
        plant(path.join(userRoot, 'chats', 'Seraphina', 'collides.jsonl'), '{}\n');
        plant(path.join(userRoot, 'chats', 'Seraphina', 'occupied.jsonl'), '{}\n');

        installPlugin(FIXTURE, 'zz-chat-rename-probe');

        const server = await startSillyTavern({
            dataRoot,
            configPath,
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                // 🔴 Never let a test git-pull the plugins directory. Auto-update defaults to TRUE.
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'chat-rename-probe',
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
            // 1. A solo chat. The client sends both names WITH the extension — the opposite of how it sends
            //    a delete — so this is the request shape that catches the body being echoed back unstripped.
            status.solo = await post('/api/chats/rename', {
                is_group: false,
                avatar_url: 'Seraphina.png',
                original_file: 'old-solo.jsonl',
                renamed_file: 'new-solo.jsonl',
            });

            // 2. A group conversation, through the same endpoint.
            status.group = await post('/api/chats/rename', {
                is_group: true,
                avatar_url: 'Seraphina.png',
                original_file: 'old-group.jsonl',
                renamed_file: 'new-group.jsonl',
            });

            // 3. 🔴 A rename onto an occupied name. Must be refused and must announce nothing.
            status.collision = await post('/api/chats/rename', {
                is_group: false,
                avatar_url: 'Seraphina.png',
                original_file: 'collides.jsonl',
                renamed_file: 'occupied.jsonl',
            });

            // The refused rename's source must still be on disk — proving (3) was a real no-op rather than a
            // silent half-completed move.
            status.collidesStillThere = fs.existsSync(path.join(userRoot, 'chats', 'Seraphina', 'collides.jsonl')) ? 1 : 0;

            // And the successful one really did move, so the positives above are not asserting on a signal
            // that fired without any filesystem work behind it.
            status.newSoloExists = fs.existsSync(path.join(userRoot, 'chats', 'Seraphina', 'new-solo.jsonl')) ? 1 : 0;
            status.oldSoloGone = fs.existsSync(path.join(userRoot, 'chats', 'Seraphina', 'old-solo.jsonl')) ? 0 : 1;
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

    /** The renames announced, as `old -> new`, in order. */
    const renames = () => journal.filter(line => line.startsWith('renamed ')).map(line => line.replace(`renamed ${HANDLE} `, ''));

    /** Every chat id that appeared in a rename announcement, either end. */
    const renamedIds = () => renames().flatMap(one => one.split(' -> '));

    test('the probe registered and the endpoint answered — otherwise everything below is vacuous', () => {
        expect(journal).toContain('onChatRenamed: function');
        expect(status.solo).toBe(200);
        expect(status.group).toBe(200);
        expect(status.newSoloExists).toBe(1);
        expect(status.oldSoloGone).toBe(1);
    });

    test('🔴 a solo rename announces both ids, WITHOUT the .jsonl the client sent', () => {
        // The client sends `original_file`/`renamed_file` WITH the extension. Emitting the body verbatim would
        // announce `old-solo.jsonl -> new-solo.jsonl`, which re-keys zero rows in the consumer and reports
        // success — the one way this feature fails silently.
        expect(renames()).toContain('old-solo -> new-solo');
    });

    test('a group chat rename announces too — one endpoint covers both', () => {
        // `/api/chats/rename` branches on `is_group` to pick the folder and is otherwise identical. There is
        // no separate group rename endpoint, so a consumer needs no second subscription.
        expect(renames()).toContain('old-group -> new-group');
    });

    test('🔴 a rename announces NO deletion — the rows moved, they did not die', () => {
        // The probe registers for `onChatDeleted` as well, so this cannot pass by the fork simply never
        // wiring deletion. A consumer hearing "deleted" here would discard the memories of a chat the user
        // is still in the middle of.
        expect(journal).not.toContain(`deleted ${HANDLE} old-solo`);
        expect(journal.filter(line => line.startsWith('deleted '))).toEqual([]);
    });

    test('🔴 a REFUSED rename announces nothing, and the original is still on disk', () => {
        // The load-bearing negative, and the §24.6 property in miniature: the signal lives inside the success
        // branch, after the unlink. Announced before it, a locked vault on an encrypted install would report
        // a rename that never happened and the consumer would re-key to an id with no file behind it.
        expect(status.collision).toBe(400);
        expect(status.collidesStillThere).toBe(1);
        expect(renamedIds()).not.toContain('collides');
        expect(renamedIds()).not.toContain('occupied');
    });

    test('every announcement carries the owning handle', () => {
        for (const line of journal.filter(one => one.startsWith('renamed '))) {
            expect(line).toMatch(new RegExp(`^renamed ${HANDLE} `));
        }
    });

    test('no announced id carries a path component or an extension, at either end', () => {
        // A directory component or a stray extension is the silent-failure shape this whole feature is
        // designed around, so assert it across every id rather than only the ones named above. The group case
        // makes this worth doing: its folder is `group chats`, a different depth from the solo path.
        for (const id of renamedIds()) {
            expect(id).not.toMatch(/[/\\]/);
            expect(id).not.toMatch(/\.jsonl$/i);
        }
    });
});
