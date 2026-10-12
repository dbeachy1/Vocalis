import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';
import { registerStorageProvider, unregisterStorageProvider, StorageError, EUNAVAILABLE } from '../src/storage.js';
import { makeScratchDirectory } from './util/st-server.js';

// image-metadata.js reads thumbnail dimensions from the config AT MODULE SCOPE, so it cannot be imported
// until a config path exists. Hence the dynamic import: a static one is hoisted above everything and the
// module would `process.exit(1)` while Jest was still collecting the file.
/** @type {typeof import('../src/endpoints/image-metadata.js')} */
let imageMetadata;

/**
 * 🔴 "I CANNOT READ THIS" AND "THERE IS NOTHING HERE" ARE OPPOSITE FACTS.
 *
 * `image-metadata.js` was half-refactored: it WROTE the index through the storage funnel and READ it with a
 * raw `fs.readFile`. Behind a provider that transforms bytes, the read came back as something JSON could not
 * parse — and a bare `catch` turned that into an EMPTY INDEX. The very next write then put the empty index
 * over the real one.
 *
 * `images` would eventually regenerate. `folders` — which the user made by hand — would not. It failed
 * silently, with no error, on an application that looked like it was working perfectly. That is the fourth
 * time this exact shape has appeared in this project.
 *
 * These tests do the thing the project keeps learning it has to do: **prove the data EXISTS before asserting
 * anything about what happens to it.** A test that only says "no folders were lost" is equally happy with an
 * index that never had any.
 */
describe('🖼️  the image metadata index: unreadable is not empty', () => {
    /** @type {string} */
    let root;

    /** The index a user would actually have: some images, and folders they made themselves. */
    const REAL_INDEX = {
        version: 1,
        images: { 'backgrounds/beach.png': { hash: 'abc', aspectRatio: 1.5 } },
        folders: [{ id: 'f1', name: 'Holiday photos' }],
    };

    beforeAll(async () => {
        const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
        setConfigFilePath(path.join(serverDirectory, 'default', 'config.yaml'));
        imageMetadata = await import('../src/endpoints/image-metadata.js');
    });

    beforeEach(() => {
        root = makeScratchDirectory('image-metadata');
        unregisterStorageProvider();
    });

    afterEach(() => {
        unregisterStorageProvider();
        fs.rmSync(root, { recursive: true, force: true });
    });

    /**
     * A provider that owns everything and cannot serve any of it — a locked vault, in other words.
     *
     * It is deliberately NOT a provider that returns nonsense: it throws the API's own EUNAVAILABLE, which
     * is the contract's way of saying "the data is THERE and I cannot reach it right now". Nothing may
     * respond to that by rebuilding.
     * @returns {any} The provider
     */
    function lockedProvider() {
        const refuse = (p) => { throw new StorageError(EUNAVAILABLE, 'Locked.', p); };

        return {
            id: 'locked-for-test',
            owns: () => true,
            init: async () => {},
            isReady: () => false,
            unlock: async () => {},
            lock: () => {},
            rekey: async () => {},
            readFile: async (p) => refuse(p),
            readFileSync: (p) => refuse(p),
            createReadStream: (p) => refuse(p),
            exists: (p) => refuse(p),
            stat: (p) => refuse(p),
            readdir: (p) => refuse(p),
            writeFile: async (p) => refuse(p),
            writeFileSync: (p) => refuse(p),
            createWriteStream: (p) => refuse(p),
            mkdir: () => {},
            unlink: (p) => refuse(p),
            rename: (p) => refuse(p),
            copyFile: (p) => refuse(p),
            cp: (p) => refuse(p),
            rm: (p) => refuse(p),
            sendFile: async (_res, p) => refuse(p),
        };
    }

    /**
     * A provider that stores everything under a name of its own choosing.
     *
     * 🔴 THIS IS THE PROVIDER THE ORPHAN SWEEP'S FIX EXISTS FOR, and until now nothing in the suite was one.
     * Storing an image under a different on-disk name is expressly allowed by the API, and the plugin this
     * fork was built for does exactly that — so the LOGICAL path has no file behind it and a raw `fs.access`
     * fails for every image the user owns. Only the funnel can answer the question truthfully.
     *
     * The contents live in a Map rather than on disk, which is the point: `fs` can see none of it, and
     * `exists` can see all of it.
     * @param {Map<string, any>} store Logical path → bytes
     * @returns {any} The provider
     */
    function renamingProvider(store) {
        const key = (p) => path.resolve(p);
        const missing = (p) => { throw new StorageError(EUNAVAILABLE, 'No such logical path.', p); };

        return {
            id: 'renaming-for-test',
            owns: () => true,
            init: async () => {},
            isReady: () => true,
            unlock: async () => {},
            lock: () => {},
            rekey: async () => {},
            readFile: async (p) => (store.has(key(p)) ? store.get(key(p)) : missing(p)),
            readFileSync: (p) => (store.has(key(p)) ? store.get(key(p)) : missing(p)),
            createReadStream: (p) => missing(p),
            exists: (p) => store.has(key(p)),
            stat: () => ({ size: 0, mtimeMs: 0, birthtimeMs: 0 }),
            readdir: () => [],
            writeFile: async (p, data) => { store.set(key(p), data); },
            writeFileSync: (p, data) => { store.set(key(p), data); },
            createWriteStream: (p) => missing(p),
            mkdir: () => {},
            unlink: (p) => { store.delete(key(p)); },
            rename: (p) => missing(p),
            copyFile: (p) => missing(p),
            cp: (p) => missing(p),
            rm: (p) => missing(p),
            sendFile: async (_res, p) => missing(p),
        };
    }

    test('🔴 a locked index THROWS — it does not come back empty', async () => {
        // 1. PROVE THE DATA EXISTS. Without this the test below is vacuous: "no folders were lost" is
        //    trivially true of an index that never had any, and that is precisely how this class of bug
        //    has slipped through four times already.
        await imageMetadata.writeMetadataIndex(root, REAL_INDEX);

        const onDisk = JSON.parse(fs.readFileSync(path.join(root, imageMetadata.METADATA_FILE), 'utf-8'));
        expect(onDisk.folders).toHaveLength(1);
        expect(onDisk.images['backgrounds/beach.png']).toBeDefined();

        // 2. Now make it unreadable — not absent. The file is right there.
        registerStorageProvider(lockedProvider());

        // 3. The read must FAIL, loudly. Returning `{ images: {}, folders: [] }` here is the bug: the caller
        //    believes the user has no images and no folders, and writes that belief back over the truth.
        await expect(imageMetadata.readMetadataIndex(root)).rejects.toThrow(/locked/i);
    });

    test('🔴 a missing index still starts a fresh one — ENOENT is not a provider error', async () => {
        // The catch has to survive, and this is why. A user with no images yet has no index file, and that
        // genuinely does mean "start an empty one". Only EUNAVAILABLE/EPROVIDER mean "it is there and shut".
        const index = await imageMetadata.readMetadataIndex(root);

        expect(index).toEqual({ version: 1, images: {}, folders: [] });
    });

    test('🔴 the orphan sweep does NOT delete the whole index when the files are merely unreachable', async () => {
        await imageMetadata.writeMetadataIndex(root, REAL_INDEX);

        // The image file itself never exists on the plain filesystem here — which is exactly the situation a
        // provider that renames files on disk creates. `fs.access` on the LOGICAL path finds nothing for
        // EVERY image, and the sweep used to prune the lot as "orphaned" while every file sat there intact.
        //
        // We do not register a provider: on the plain filesystem the file really is absent, so the sweep
        // SHOULD prune it. That is the honest baseline — and it is what makes the assertion below mean
        // something rather than passing by accident.
        await imageMetadata.cleanupOrphanedMetadata(root);

        const afterHonestSweep = await imageMetadata.readMetadataIndex(root);
        expect(afterHonestSweep.images['backgrounds/beach.png']).toBeUndefined();

        // 🔴 AND THE FOLDERS SURVIVE. They are the user's own work and no file's absence implies anything
        // about them. An index rebuilt from scratch would have lost them silently.
        expect(afterHonestSweep.folders).toHaveLength(1);
        expect(afterHonestSweep.folders[0].name).toBe('Holiday photos');
    });

    test('🔴 THE CASE THE FIX EXISTS FOR: a provider that renames on disk keeps every entry', async () => {
        // The test above is the honest baseline and nothing more — it registers no provider, so
        // `storage.exists` falls straight through to `fs.existsSync` and behaves exactly like the
        // `fs.access` it replaced. Revert the fix and that test still passes. This one is what fails.
        const store = new Map();
        registerStorageProvider(renamingProvider(store));

        await imageMetadata.writeMetadataIndex(root, REAL_INDEX);

        // The image is PRESENT as far as the funnel is concerned, and invisible to `fs` — which is the
        // whole situation. Nothing is written to the real filesystem at this path, deliberately.
        store.set(path.resolve(root, 'backgrounds/beach.png'), Buffer.from('the real image bytes'));
        expect(fs.existsSync(path.join(root, 'backgrounds', 'beach.png'))).toBe(false);

        await imageMetadata.cleanupOrphanedMetadata(root);

        const after = await imageMetadata.readMetadataIndex(root);

        // 🔴 THE ASSERTION. Asked through `fs`, every image the user owns looks orphaned and the sweep
        // prunes the lot while every file sits there intact.
        expect(after.images['backgrounds/beach.png']).toBeDefined();
        expect(after.folders).toHaveLength(1);
    });

    test('🔴 and a genuinely orphaned entry is STILL pruned through a provider — the sweep still works', async () => {
        // Without this, the assertion above passes just as well on a sweep that has stopped deleting
        // anything at all, which would be a different bug wearing the fix as a disguise.
        const store = new Map();
        registerStorageProvider(renamingProvider(store));

        await imageMetadata.writeMetadataIndex(root, REAL_INDEX);
        // Note what is NOT done here: the image is never put in the store, so the funnel says it is gone.

        await imageMetadata.cleanupOrphanedMetadata(root);

        const after = await imageMetadata.readMetadataIndex(root);
        expect(after.images['backgrounds/beach.png']).toBeUndefined();
        expect(after.folders).toHaveLength(1);
    });

    test('🔴 a sweep it cannot answer DELETES NOTHING — it throws instead', async () => {
        // "The data is there and I cannot reach it right now" is not an orphan. The sweep reads the index
        // first, so a locked vault must stop it before a single `delete` runs — the alternative is pruning
        // a user's entire image index because their vault happened to be shut when the sweep fired.
        await imageMetadata.writeMetadataIndex(root, REAL_INDEX);

        const onDisk = JSON.parse(fs.readFileSync(path.join(root, imageMetadata.METADATA_FILE), 'utf-8'));
        expect(onDisk.images['backgrounds/beach.png']).toBeDefined();

        registerStorageProvider(lockedProvider());

        await expect(imageMetadata.cleanupOrphanedMetadata(root)).rejects.toThrow(/locked/i);

        // And the file on disk is untouched: the refusal happened before anything was written back.
        unregisterStorageProvider();
        const survived = JSON.parse(fs.readFileSync(path.join(root, imageMetadata.METADATA_FILE), 'utf-8'));
        expect(survived.images['backgrounds/beach.png']).toBeDefined();
        expect(survived.folders).toHaveLength(1);
    });
});
