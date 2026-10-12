import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import {
    CHARACTER_IDS_FILE,
    readCharacterIds,
    writeCharacterIds,
    lookupCharacterId,
    lookupCharacterIds,
    lookupAvatarById,
    getOrMintCharacterId,
    renameCharacterId,
    deleteCharacterId,
} from '../src/character-ids.js';
import { registerStorageProvider, unregisterStorageProvider, StorageError, EUNAVAILABLE } from '../src/storage.js';
import { makeScratchDirectory } from './util/st-server.js';

/**
 * 🔴 THE MAP IS THE ONLY COPY OF AN IDENTITY THAT IS SUPPOSED TO OUTLIVE A RENAME.
 *
 * Everything §22 promises rests on one string not changing. The interesting failures are therefore not
 * "an error was thrown" — they are the silent ones, where a character quietly acquires a SECOND identity and
 * every memory filed under the first becomes unreachable, on an install that looks like it is working.
 *
 * So these tests are written to catch re-minting specifically, and they follow this project's rule for that
 * class of bug: **prove the id exists before asserting anything about what happens to it.** "The id did not
 * change" is trivially true of a map that never had one.
 */
describe('🆔 character ids: one string, across everything the app does to a card', () => {
    /** @type {string} */
    let root;

    beforeEach(() => {
        root = makeScratchDirectory('character-ids');
        unregisterStorageProvider();
    });

    afterEach(() => {
        unregisterStorageProvider();
        fs.rmSync(root, { recursive: true, force: true });
    });

    /**
     * A provider that owns everything and can serve none of it — a locked vault.
     *
     * It throws the API's own EUNAVAILABLE rather than returning nonsense, because that is the contract's way
     * of saying "the data is THERE and I cannot reach it right now". Nothing may respond to that by minting.
     * @returns {any} The provider
     */
    function lockedProvider() {
        const refuse = (p) => { throw new StorageError(EUNAVAILABLE, 'Locked.', p); };

        return {
            id: 'locked-for-test',
            owns: () => true,
            init: async () => { },
            isReady: () => false,
            unlock: async () => { },
            lock: () => { },
            rekey: async () => { },
            readFile: async (p) => refuse(p),
            readFileSync: (p) => refuse(p),
            createReadStream: (p) => refuse(p),
            exists: (p) => refuse(p),
            stat: (p) => refuse(p),
            readdir: (p) => refuse(p),
            writeFile: async (p) => refuse(p),
            writeFileSync: (p) => refuse(p),
            createWriteStream: (p) => refuse(p),
            mkdir: () => { },
            unlink: (p) => refuse(p),
            rename: (p) => refuse(p),
            copyFile: (p) => refuse(p),
            cp: (p) => refuse(p),
            rm: (p) => refuse(p),
            sendFile: async (_res, p) => refuse(p),
        };
    }

    describe('minting', () => {
        test('the same card gets the same id twice — minting is idempotent, not a generator', async () => {
            const first = await getOrMintCharacterId(root, 'Marcus.png');
            const second = await getOrMintCharacterId(root, 'Marcus.png');

            expect(first).toEqual(expect.any(String));
            expect(second).toBe(first);
        });

        test('two cards get different ids even when their display names are identical', async () => {
            // §22.9 item 2, at the level where it originates. Nothing here mentions a name, which IS the
            // point: two cards called "Marcus" are two avatar filenames, and no test keyed on names can see
            // the difference between this passing and it failing.
            const one = await getOrMintCharacterId(root, 'Marcus.png');
            const two = await getOrMintCharacterId(root, 'Marcus (1).png');

            expect(two).not.toBe(one);
        });

        test('🔴 racing first-sight mints agree on ONE id — §22.6, answered', async () => {
            // Both callers read "absent" before either writes, and the loser's write lands second. Without
            // serialisation the map ends up holding the second id while the first caller has already been
            // handed the first — so a memory filed during that generation is orphaned the moment it is made.
            const [a, b, c] = await Promise.all([
                getOrMintCharacterId(root, 'Elara.png'),
                getOrMintCharacterId(root, 'Elara.png'),
                getOrMintCharacterId(root, 'Elara.png'),
            ]);

            expect(b).toBe(a);
            expect(c).toBe(a);

            const onDisk = JSON.parse(fs.readFileSync(path.join(root, CHARACTER_IDS_FILE), 'utf-8'));
            expect(Object.keys(onDisk.ids)).toEqual(['Elara.png']);
            expect(onDisk.ids['Elara.png']).toBe(a);
        });

        test('no avatar to key on yields null rather than an id for nothing', async () => {
            expect(await getOrMintCharacterId(root, '')).toBeNull();
            expect(await getOrMintCharacterId(root, undefined)).toBeNull();
        });
    });

    describe('lookup never mints', () => {
        test('an unseen card resolves to null and is NOT added to the map', async () => {
            // The load-bearing half of the `null` contract (§22.8.2). Per-turn resolution runs over historical
            // turns that can name deleted or never-seen characters; minting there would grow the map without
            // bound and hand a plugin a confident id for a character that does not exist.
            expect(await lookupCharacterId(root, 'Ghost.png')).toBeNull();
            expect(fs.existsSync(path.join(root, CHARACTER_IDS_FILE))).toBe(false);
        });

        test('a batch resolves positionally, with null in every gap', async () => {
            const marcus = await getOrMintCharacterId(root, 'Marcus.png');
            const elara = await getOrMintCharacterId(root, 'Elara.png');

            // A window's worth of turns: two characters, a user turn (no avatar), and a deleted character.
            const resolved = await lookupCharacterIds(root, ['Marcus.png', null, 'Elara.png', 'Deleted.png', undefined, 'Marcus.png']);

            expect(resolved).toEqual([marcus, null, elara, null, null, marcus]);
        });

        test('🔴 a user turn resolves to null, never the empty string', async () => {
            // Asserted as identity, not falsiness, and that is deliberate: `''` is falsy AND composes into a
            // structurally valid partition (`u::<personaId>`), so a `toBeFalsy()` assertion passes on exactly
            // the bug this contract exists to prevent. §22.8.2.
            const [resolved] = await lookupCharacterIds(root, [null]);

            expect(resolved).toBeNull();
            expect(resolved).not.toBe('');
        });
    });

    describe('🔁 the map runs backwards too — §25', () => {
        test('an id resolves to the avatar it was minted for', async () => {
            const marcus = await getOrMintCharacterId(root, 'Marcus.png');

            expect(await lookupAvatarById(root, marcus)).toBe('Marcus.png');
        });

        test('🔴 it picks the RIGHT card out of several, which a scan can get wrong', async () => {
            // The failure this guards is not "returns nothing" — it is returning a *different* character's
            // avatar, which then loads a stranger's card and tells a memory plugin those facts are already
            // known. Silent, and worse than no baseline at all. So plant several and check every one.
            const marcus = await getOrMintCharacterId(root, 'Marcus.png');
            const elara = await getOrMintCharacterId(root, 'Elara.png');
            const ghost = await getOrMintCharacterId(root, 'Ghost.png');

            expect(await lookupAvatarById(root, marcus)).toBe('Marcus.png');
            expect(await lookupAvatarById(root, elara)).toBe('Elara.png');
            expect(await lookupAvatarById(root, ghost)).toBe('Ghost.png');
        });

        test('an id no card carries resolves to null', async () => {
            await getOrMintCharacterId(root, 'Marcus.png');

            expect(await lookupAvatarById(root, 'a-uuid-nobody-minted')).toBeNull();
        });

        test('🔴 a deleted card stops resolving — the map is not a graveyard', async () => {
            // §22.9 item 4 from the other side. After a delete the id still exists in a plugin's store, and
            // `readCharacterCard` must answer `null` for it rather than reaching a stale filename.
            const original = await getOrMintCharacterId(root, 'Marcus.png');
            expect(await lookupAvatarById(root, original)).toBe('Marcus.png');

            await deleteCharacterId(root, 'Marcus.png');

            expect(await lookupAvatarById(root, original)).toBeNull();
        });

        test('🔴 after a rename the SAME id resolves to the NEW filename', async () => {
            // This is §22's promise stated backwards, and it is what makes reading a card by id safe across a
            // rename: the plugin's stored id keeps working and silently follows the file.
            const before = await getOrMintCharacterId(root, 'Marcus.png');
            await renameCharacterId(root, 'Marcus.png', 'Marcus Aurelius.png');

            expect(await lookupAvatarById(root, before)).toBe('Marcus Aurelius.png');
        });

        test('an empty or non-string id is null, not a scan for undefined', async () => {
            // `undefined === undefined` would match any avatar whose value was somehow unset, so the guard is
            // not merely defensive tidiness.
            expect(await lookupAvatarById(root, '')).toBeNull();
            expect(await lookupAvatarById(root, /** @type {any} */ (null))).toBeNull();
            expect(await lookupAvatarById(root, /** @type {any} */ (undefined))).toBeNull();
        });
    });

    describe('rename — the whole reason this file exists', () => {
        test('🔴 the id survives, and the old avatar key does NOT — §22.9 item 1', async () => {
            // 1. Prove the id exists. Without this, "the id did not change" is vacuous.
            const before = await getOrMintCharacterId(root, 'Marcus.png');
            expect(before).toEqual(expect.any(String));

            // 2. Rename, as `renameCharacter` does when it mints the new avatar filename.
            const after = await renameCharacterId(root, 'Marcus.png', 'Marcus Aurelius.png');

            expect(after).toBe(before);
            expect(await lookupCharacterId(root, 'Marcus Aurelius.png')).toBe(before);

            // 3. The old key is gone, so a future card taking that filename cannot inherit this identity.
            expect(await lookupCharacterId(root, 'Marcus.png')).toBeNull();

            const onDisk = JSON.parse(fs.readFileSync(path.join(root, CHARACTER_IDS_FILE), 'utf-8'));
            expect(Object.keys(onDisk.ids)).toEqual(['Marcus Aurelius.png']);
        });

        test('renaming a never-minted card is a no-op, not an accidental mint', async () => {
            expect(await renameCharacterId(root, 'Unseen.png', 'Renamed.png')).toBeNull();
            expect(await lookupCharacterId(root, 'Renamed.png')).toBeNull();
        });
    });

    describe('delete', () => {
        test('the id is forgotten, and a re-import mints a different one — §22.9 item 4', async () => {
            const original = await getOrMintCharacterId(root, 'Marcus.png');
            expect(original).toEqual(expect.any(String));

            expect(await deleteCharacterId(root, 'Marcus.png')).toBe(original);
            expect(await lookupCharacterId(root, 'Marcus.png')).toBeNull();

            const reimported = await getOrMintCharacterId(root, 'Marcus.png');
            expect(reimported).not.toBe(original);
        });
    });

    describe('🔴 unreadable is not empty', () => {
        test('a locked map THROWS rather than coming back empty and re-minting', async () => {
            // 1. PROVE THE DATA EXISTS. The whole hazard is a map that is there and unreachable.
            const original = await getOrMintCharacterId(root, 'Marcus.png');
            const onDisk = JSON.parse(fs.readFileSync(path.join(root, CHARACTER_IDS_FILE), 'utf-8'));
            expect(onDisk.ids['Marcus.png']).toBe(original);

            // 2. Make it unreadable — not absent. The file is right there.
            registerStorageProvider(lockedProvider());

            // 3. Every path must refuse. A resolve-to-empty here is not a degraded read: the next mint would
            //    issue a NEW uuid for a character that already has one, and every memory filed under the old
            //    id becomes unreachable forever — because the vault was locked, which is a normal state.
            await expect(readCharacterIds(root)).rejects.toThrow();
            await expect(lookupCharacterId(root, 'Marcus.png')).rejects.toThrow();
            await expect(getOrMintCharacterId(root, 'Marcus.png')).rejects.toThrow();
            await expect(renameCharacterId(root, 'Marcus.png', 'New.png')).rejects.toThrow();
            await expect(lookupCharacterIds(root, ['Marcus.png'])).rejects.toThrow();

            // 🔴 The reverse lookup too, and this one carries §25's whole fail-loud promise. It is the first
            // thing `context.readCharacterCard` calls, so a `null` here instead of a throw would surface to a
            // memory plugin as "this character has no card" — and it would extract an empty baseline on a
            // vault that was merely locked, then never revisit it.
            await expect(lookupAvatarById(root, original)).rejects.toThrow();

            // 4. And the file on disk is untouched — nothing wrote an empty map over it on the way past.
            unregisterStorageProvider();
            expect(await lookupCharacterId(root, 'Marcus.png')).toBe(original);
        });

        test('a corrupt map throws instead of silently starting over', async () => {
            fs.writeFileSync(path.join(root, CHARACTER_IDS_FILE), '{ this is not json', 'utf-8');

            await expect(readCharacterIds(root)).rejects.toThrow();
            await expect(getOrMintCharacterId(root, 'Marcus.png')).rejects.toThrow();
        });

        test('a well-formed file of the WRONG SHAPE throws too', async () => {
            // JSON.parse succeeds, so only a shape check catches this. Absent that, `index.ids[avatar]` on an
            // undefined `ids` throws somewhere further away, or worse, quietly re-mints.
            fs.writeFileSync(path.join(root, CHARACTER_IDS_FILE), JSON.stringify({ version: 1 }), 'utf-8');

            await expect(readCharacterIds(root)).rejects.toThrow(/not a character id index/);
        });

        test('genuinely absent IS empty — ENOENT is the one absence', async () => {
            await expect(readCharacterIds(root)).resolves.toEqual({ version: 1, ids: {} });
        });
    });

    describe('the map round-trips', () => {
        test('what is written is what is read', async () => {
            const index = { version: 1, ids: { 'Marcus.png': 'uuid-1', 'Elara.png': 'uuid-2' } };
            await writeCharacterIds(root, index);

            await expect(readCharacterIds(root)).resolves.toEqual(index);
        });
    });
});
