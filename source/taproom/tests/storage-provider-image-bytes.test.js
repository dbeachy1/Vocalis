import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import extractChunks from 'png-chunks-extract';

import { installStorageProvider, makeScratchDirectory, startSillyTavern } from './util/st-server.js';
import { asBytes } from './fixtures/seam-provider.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const SEAM_PROVIDER = path.join(testDirectory, 'fixtures', 'seam-provider.js');

/**
 * A real, minimal, valid PNG: 1x1, opaque. 70 bytes, correct chunk CRCs, IHDR through IEND.
 *
 * Inline rather than read from a file so that this suite has no fixture it could silently be handed a
 * broken copy of — and so the "is it still valid?" assertion below is checking THIS constant, which is
 * the same thing the upload sends.
 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// The transform the fork's own storage-provider fixture applies — which in turn is byte-identical to the
// real vault's.
//
// ⚠️ IMPORTED FROM THE FIXTURE, NOT TRANSCRIBED FROM IT. This used to be a verbatim copy living in this
// file, so the "why it broke" block below exercised the copy and nothing else: change the fixture's version
// to accept a TypedArray and those tests keep passing while claiming to pin provider behaviour. Importing it
// means drift breaks a test, which is the entire point of having one.

/**
 * 🔴 AN IMAGE THAT SURVIVES THE PROVIDER IS STILL AN IMAGE.
 *
 * `images.js` used to hand `storage.writeFile` a `new Uint8Array(imageBuffer)`. On a plain filesystem that
 * is harmless — `node:fs` accepts any TypedArray. Behind a provider it is not: a provider has to reduce
 * whatever it is given to bytes before it can encrypt them, and the natural way to write that check is
 * `Buffer.isBuffer(data)`, which is FALSE for a Uint8Array. The fallback then stringifies it, so what gets
 * stored is the ASCII text `"137,80,78,71,13,10,26,10,..."` — the decimal byte list, comma separated.
 *
 * Nothing throws. The upload returns 200. The file is simply not a PNG any more, and the only symptom is a
 * broken image in the browser some time later.
 *
 * The fork ALREADY SHIPPED the fixture that reproduces this: `seam-provider.js`'s `asBytes` is identical to
 * the real vault's. What was missing was any test that put an image through it — nothing in the suite
 * uploaded one. That is the gap this file closes.
 *
 * These tests do what this project keeps having to relearn: **prove the bytes are real before asserting
 * anything survived them.** A test that only checks for a 200, or only for a non-empty file, passes
 * happily on 198 bytes of comma-separated digits.
 */
describe('🖼️  an uploaded PNG comes back a PNG, through the provider', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {import('./util/st-server.js').RunningServer} */
    let server;
    /** @type {string} */
    let base;

    /** The PNG as uploaded. */
    const original = Buffer.from(PNG_BASE64, 'base64');

    /** The path the upload reported, relative to the user root. */
    let uploadedPath = '';
    /** Exactly what the server handed back over HTTP. */
    let fetched = Buffer.alloc(0);
    /** @type {number} */
    let uploadStatus = 0;
    /** @type {number} */
    let downloadStatus = 0;

    beforeAll(async () => {
        scratch = makeScratchDirectory('image-bytes');
        dataRoot = path.join(scratch, 'data');

        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');
        const journalPath = path.join(scratch, 'image-bytes.journal');

        const seed = await startSillyTavern({ dataRoot, configPath });
        if (!seed.listening) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        installStorageProvider(providersPath, SEAM_PROVIDER);

        server = await startSillyTavern({
            dataRoot,
            configPath,
            storageProvidersPath: providersPath,
            providerEnv: { ST_SEAM_JOURNAL: journalPath },
        });

        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);
        base = `http://127.0.0.1:${server.port}`;

        const upload = await fetch(`${base}/api/images/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // `format` is required — `images.js:52` rejects anything not in MEDIA_EXTENSIONS with a 400,
            // and it is what builds the extension the file is stored and served under.
            body: JSON.stringify({ image: PNG_BASE64, filename: 'canary', format: 'png' }),
        });

        uploadStatus = upload.status;
        uploadedPath = (await upload.json()).path ?? '';

        // A failed upload must not read as a failed round-trip: without this the byte assertions below
        // would compare against an empty buffer and report a corruption that never happened.
        if (uploadStatus !== 200) throw new Error(`Upload failed (${uploadStatus}).\n\n${server.output()}`);

        const download = await fetch(`${base}/${uploadedPath.replace(/^\/+/, '')}`);
        downloadStatus = download.status;
        fetched = Buffer.from(await download.arrayBuffer());

        // Two server boots, so jest's 5s default hook timeout is nowhere near enough — and a blown hook
        // timeout fails all six tests identically, which reads exactly like a real corruption. Same
        // bound as `storage-provider-seams.test.js`.
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    test('the PNG this suite uploads is genuinely a valid PNG to begin with', () => {
        // Without this the rest of the file is vacuous: "what came back matches what went out" is
        // trivially true of two identically broken things.
        expect(original.subarray(0, 8)).toEqual(PNG_SIGNATURE);

        const chunks = extractChunks(original);
        expect(chunks.map(c => c.name)).toEqual(['IHDR', 'IDAT', 'IEND']);
        expect(original).toHaveLength(70);
    });

    test('🔴 the bytes really went through the provider — this is not a plaintext fallback passing', () => {
        // The seam provider marks everything it writes with a prefix `node:fs` would never produce. If the
        // file on disk lacks it, the provider was bypassed and every assertion below is measuring nothing.
        const onDisk = fs.readFileSync(path.join(dataRoot, 'default-user', 'user', 'images', 'canary.png'));

        expect(onDisk.subarray(0, 5).toString('latin1')).toBe('SEAM:');
        expect(onDisk.equals(original)).toBe(false);
    });

    test('🔴 the fetched image parses as a PNG, chunk CRCs and all', () => {
        // `png-chunks-extract` validates the 8-byte signature AND every chunk's CRC32. Corrupted bytes
        // cannot satisfy it: the stringified form fails the header, and a single flipped bit inside a
        // chunk fails the CRC. This verifies the image bytes rather than only their appearance.
        const chunks = extractChunks(fetched);

        expect(chunks.map(c => c.name)).toEqual(['IHDR', 'IDAT', 'IEND']);

        // IHDR carries the dimensions: width and height as big-endian uint32, first eight bytes of the chunk.
        const ihdr = chunks.find(c => c.name === 'IHDR');
        const header = Buffer.from(ihdr.data);
        expect(header.readUInt32BE(0)).toBe(1);
        expect(header.readUInt32BE(4)).toBe(1);
    });

    test('🔴 the fetched image is byte-identical to the one uploaded', () => {
        expect(fetched).toHaveLength(original.length);
        expect(fetched.equals(original)).toBe(true);
    });

    test('the reported path is under the user images directory', () => {
        expect(uploadedPath).toMatch(/user\/images\/canary\.png$/);
    });

    test('both halves of the round trip answered 200', () => {
        // 🔴 Stated as its own assertion because THE BUG DOES NOT CHANGE THESE. The upload returns 200 and
        // the download returns 200 whether the bytes survived or not — that is the entire character of this
        // defect, and the reason a smoke test would have sailed past it. Only the byte assertions catch it.
        expect(uploadStatus).toBe(200);
        expect(downloadStatus).toBe(200);
    });
});

/**
 * The mechanism, pinned on its own so a failure above is one step from a diagnosis.
 *
 * This needs no server and no provider — it is the arithmetic of the bug. If these two pass and the
 * end-to-end tests fail, the fault moved somewhere else; if this one fails, `images.js` is handing the
 * provider a TypedArray again.
 */
describe('🔎 why it broke: Buffer survives a provider, Uint8Array does not', () => {
    const original = Buffer.from(PNG_BASE64, 'base64');

    test('a Buffer passes through asBytes untouched', () => {
        expect(asBytes(original, undefined).equals(original)).toBe(true);
    });

    test('🔴 a Uint8Array is stringified into the decimal byte list, and stops being a PNG', () => {
        const wrapped = asBytes(new Uint8Array(original), undefined);

        expect(wrapped.equals(original)).toBe(false);
        expect(wrapped.length).toBeGreaterThan(original.length);
        expect(wrapped.subarray(0, 8)).not.toEqual(PNG_SIGNATURE);

        // What it actually becomes: "137,80,78,71,..." — the PNG signature as readable digits.
        expect(wrapped.toString('utf-8').startsWith('137,80,78,71')).toBe(true);
        expect(() => extractChunks(wrapped)).toThrow(/header/i);
    });

    test('🔴 and a provider that stores it cannot give it back — the loss is total', () => {
        // Not a formatting nuisance. The bytes are gone: what a reader gets back is the text, and no
        // amount of parsing recovers the image from it.
        const stored = asBytes(new Uint8Array(original), undefined);

        expect(() => extractChunks(stored)).toThrow();
        expect(Buffer.from(stored.toString('utf-8').split(',').map(Number)).equals(original)).toBe(true);
    });
});
