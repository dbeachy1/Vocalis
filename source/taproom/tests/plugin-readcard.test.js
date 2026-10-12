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
const READCARD_FIXTURE = path.join(testDirectory, 'fixtures', 'readcard-plugin.mjs');
const SEAM_PROVIDER = path.join(testDirectory, 'fixtures', 'seam-provider.js');

const HANDLE = 'default-user';

/**
 * 🔴 THE AVATAR FILENAME IS DELIBERATELY NOT A NAME.
 *
 * The bug §25 exists to make impossible is a plugin composing `characters/${charName}.png`. If the fixture's
 * card were called `Marcus.png` then a broken implementation that guessed from the display name would pass
 * this suite. An opaque filename means the ONLY way to reach this file is to resolve the id against the map.
 */
const AVATAR = '9c4e1b77-d2a0-4f31-8e6b-portrait.png';

/** In the map, with no file behind it — what a deleted card leaves. */
const ORPHAN_AVATAR = 'deleted-card.png';

const KNOWN_ID = 'b81f0e2a-5c74-4d19-9a3e-6f0c2d84be15';
const ORPHAN_ID = '3d7a9c51-0b62-4e88-a1f4-77c5e93b20da';

/** What the plugin must get back — stands in for card bytes; the PNG parse is the plugin's, per §20.1. */
const CARD_PLAINTEXT = 'CANARY-READCARD-PLAINTEXT-9f41';

/** The seam provider's on-disk marker (`seam-provider.js:34`). Planted by hand so the file looks written. */
const MARK = 'SEAM:';

/** Every file we created, so afterAll can take them out again. */
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
 * 🔴 §25 — CAN A PLUGIN HOLDING ONLY A `charId` REACH THE CARD?
 *
 * §20 shipped `context.readFile` with an example showing `characters/Seraphina.png`, and §22.8.2 — written four
 * days earlier — strips `charAvatar` before any plugin sees a prompt. So the fork had shipped a reader for a
 * file whose name the contract refuses to disclose, and the collision was invisible from either side alone.
 * This suite is the proof that the gap is closed, and it is written so that it CANNOT pass by name-guessing:
 * the card's filename is opaque and the fixture is never told it by the API.
 *
 * It boots against the seam provider for the same reason §20's suite does — on a plaintext install "through
 * the provider" and "through `fs`" are the same answer, so a suite without one proves nothing about the case
 * the capability exists for.
 */
describe('🎴 §25 — context.readCharacterCard resolves an id to bytes, and never to a path', () => {
    /** @type {Record<string, string>} */
    let out = {};
    /** @type {number} */
    let status = 0;

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-readcard');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');

        fs.mkdirSync(providersPath, { recursive: true });
        fs.copyFileSync(SEAM_PROVIDER, path.join(providersPath, 'seam-provider.js'));

        const userRoot = path.join(dataRoot, HANDLE);
        fs.mkdirSync(path.join(userRoot, 'characters'), { recursive: true });

        // The map, as `getOrMintCharacterId` would have left it. Planted unmarked deliberately: `unmark` passes
        // unmarked bytes through unchanged (`seam-provider.js:78`), so this still reads, and keeping the marker
        // off it means the witness assertion below is about the CARD and not about this file.
        fs.writeFileSync(
            path.join(userRoot, 'character-ids.json'),
            JSON.stringify({ version: 1, ids: { [AVATAR]: KNOWN_ID, [ORPHAN_AVATAR]: ORPHAN_ID } }, null, 4),
            'utf-8',
        );

        // 🔴 PLANT THE CARD **MARKED**, for the same reason §20's suite does: a plaintext plant would make the
        // provider read and the `fs` read identical, and the witness would pass while proving nothing.
        fs.writeFileSync(path.join(userRoot, 'characters', AVATAR), `${MARK}${CARD_PLAINTEXT}`, 'utf-8');

        // ⚠️ ORPHAN_AVATAR is deliberately NOT written. Its id is in the map and its file is not on disk.

        installPlugin(READCARD_FIXTURE, 'zz-readcard-probe');

        const server = await startSillyTavern({
            dataRoot,
            configPath,
            pluginsPath: PLUGINS_DIRECTORY,
            storageProvidersPath: providersPath,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                // 🔴 Never let a test git-pull the plugins directory. Auto-update defaults to TRUE.
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'readcard-probe',
                ST_READCARD_ID: KNOWN_ID,
                ST_READCARD_ORPHAN_ID: ORPHAN_ID,
                ST_READCARD_AVATAR: AVATAR,
            },
        });

        try {
            const response = await fetch(`http://127.0.0.1:${server.port}/api/plugins/readcard-probe/probe?handle=${HANDLE}`);
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

    test('the probe ran at all — otherwise every assertion below is vacuous', () => {
        expect(status).toBe(200);
        expect(out.present).toBe('function');
    });

    test('🔴 THE CAPABILITY: an id alone reaches the card, decrypted', () => {
        // The plugin was handed a UUID and never the filename `9c4e1b77-…-portrait.png`. Nothing it holds
        // could have composed that path, which is the entire reason this exists.
        expect(out.read).toBe(`OK ${CARD_PLAINTEXT}`);
    });

    test('🔴 THE WITNESS: a raw fs read of the same card returns MARKED bytes, so the two differ', () => {
        // Same mutation §20.5 names, re-run here because `readCharacterCard` could have been implemented with
        // `fs.readFile` after resolving the name and would look correct on a plaintext install.
        expect(out.direct).toBe(`OK ${MARK}${CARD_PLAINTEXT}`);
        expect(out.direct).not.toBe(out.read);
    });

    test('🔴 §22.8.2 SURVIVES: what comes back is bytes, and no filename is anywhere in it', () => {
        // The requirement that made this a capability rather than a `resolveCardPath` helper. Returning the
        // resolved path would hand the avatar filename back to the plugin and undo §22 exactly as thoroughly
        // as never having stripped it — and it would look like a working feature while doing it.
        expect(out.read).not.toMatch(/\.png/);
        expect(out.read).not.toContain(AVATAR);
        expect(out.read).not.toContain('characters');
    });

    test('🔴 an id nothing carries is NULL, not a throw and not empty bytes', () => {
        // An ordinary state — a re-imported card mints a fresh id and the plugin's stored one goes stale. The
        // plugin is entitled to handle it rather than catch it.
        expect(out.unknown).toBe('NULL');
    });

    test('🔴 an id whose CARD IS GONE is NULL too — the map outliving the file is ordinary', () => {
        // This is the one that separates §25 from §20: `readFile` throws on a missing file because the caller
        // named the path and was wrong. Here the FORK resolved the path, so a miss is news about the card, not
        // about the caller. Asserted as NULL and not merely falsy — `''` would pass a falsiness check while
        // composing into a structurally valid empty baseline, which is the §22.8.2 mistake in another costume.
        expect(out.orphan).toBe('NULL');
        expect(out.orphan).not.toMatch(/^THREW/);
    });

    test('a bad handle is refused exactly as readFile refuses one', () => {
        expect(out.badhandle).toMatch(/^THREW/);
        expect(out.badhandle).toMatch(/user handle/);
        expect(out.badhandle).toMatch(/readcard-probe/);
    });

    test('an empty character id is refused rather than scanned for', () => {
        // Without the guard, `''` would scan the map for a falsy value and could match an avatar whose entry
        // was somehow unset — returning a card for a character nobody asked about.
        expect(out.emptyid).toMatch(/^THREW/);
        expect(out.emptyid).toMatch(/character id/);
    });
});
