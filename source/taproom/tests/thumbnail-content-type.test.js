import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * 🔴 A THUMBNAIL MUST BE SERVED AS THE FORMAT IT ACTUALLY IS.
 *
 * A cached thumbnail is written under the ORIGINAL image's filename — `thumbnails/avatar/Cleo.png` —
 * while `processSingleImage` encodes JPEG unless `thumbnails.format` says `png`. Content-Type was then
 * derived from that filename, at both ends of the storage funnel: Express's own `sendFile`, and the
 * vault provider's `res.type(path.extname(p))`. So every avatar thumbnail the server has ever sent went
 * out declared `image/png` with `ff d8 ff` in the body.
 *
 * ⚠️ NOTHING IN THE APP COULD HAVE CAUGHT THIS, which is why it lived so long. `<img>` sniffs image
 * bytes and ignores the declaration, so the UI was always correct. The declaration only matters to a
 * client that does something with the answer — Vocalis 7.0's character editor pulls these bytes across
 * a wire and files them in an encrypted store as a typed asset, and a JPEG stored as `.png` is a
 * corruption that surfaces much later, somewhere else.
 *
 * The assertion is therefore not "it says image/jpeg" but **the declared type agrees with the bytes**.
 * That is the invariant; the specific value follows from `thumbnails.format` and would move with it.
 */
describe('🔴 Thumbnails: the declared Content-Type matches the bytes', () => {
    /** @type {string} */
    let scratch;
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let st;
    /** @type {string} */
    let base;
    /** @type {string} */
    let charactersDirectory;

    /** A real 1x1 PNG. Small enough to inline, valid enough for Jimp to decode and re-encode. */
    const ONE_PIXEL_PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    );

    /** Signatures, so a test can say what it actually received rather than what it hoped for. */
    const MAGIC = {
        'image/png': [0x89, 0x50, 0x4e, 0x47],
        'image/jpeg': [0xff, 0xd8, 0xff],
        'image/gif': [0x47, 0x49, 0x46],
    };

    beforeAll(async () => {
        scratch = makeScratchDirectory('thumbnail-content-type');

        st = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);
        base = `http://127.0.0.1:${st.port}`;
        charactersDirectory = path.join(scratch, 'data', 'default-user', 'characters');

        fs.mkdirSync(charactersDirectory, { recursive: true });
        fs.writeFileSync(path.join(charactersDirectory, 'Probe.png'), ONE_PIXEL_PNG);

        // Never decoded — `serveThumbnail` short-circuits `.gif` to the original before any decode — so
        // the bytes only have to carry the signature the response is about to claim.
        fs.writeFileSync(path.join(charactersDirectory, 'Moving.gif'), Buffer.from('GIF89a...not really', 'latin1'));
    }, 240_000);

    afterAll(async () => {
        await st?.stop();
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    /**
     * @param {string} url URL under the server root
     * @returns {Promise<{status: number, declared: string, magic: number[]}>} What came back
     */
    async function get(url) {
        const response = await fetch(`${base}${url}`);
        const body = Buffer.from(await response.arrayBuffer());

        return {
            status: response.status,
            declared: (response.headers.get('content-type') ?? '').split(';')[0].trim(),
            magic: [...body.subarray(0, 4)],
        };
    }

    /**
     * @param {{declared: string, magic: number[]}} result A response
     */
    function expectBytesToMatchDeclaration(result) {
        const signature = MAGIC[result.declared];
        expect(signature).toBeDefined();
        expect(result.magic.slice(0, signature.length)).toEqual(signature);
    }

    test('🔴 the rectangular avatar thumbnail is not JPEG announced as PNG', async () => {
        const result = await get('/thumbnail?type=avatar&file=Probe.png');

        expect(result.status).toBe(200);
        expect(result.declared).toBe('image/jpeg');
        expectBytesToMatchDeclaration(result);
    });

    test('🔴 nor is the square face thumbnail, which is served from its own path', async () => {
        const result = await get('/thumbnail/face?type=face&file=Probe.png');

        expect(result.status).toBe(200);
        expect(result.declared).toBe('image/jpeg');
        expectBytesToMatchDeclaration(result);
    });

    test('a focus rect changes the cache filename, and the fresh cut is declared correctly too', async () => {
        // The focus keys the cache name, so this is a file that has never existed before — it exercises
        // the generate-then-serve path rather than the serve-from-cache one the tests above warmed.
        const result = await get('/thumbnail/face?type=face&file=Probe.png&focus=0.1,0.2,0.5');

        expect(result.status).toBe(200);
        expect(result.declared).toBe('image/jpeg');
        expectBytesToMatchDeclaration(result);
    });

    test('the ORIGINAL, when it is served instead of a thumbnail, keeps its own type', async () => {
        // A GIF is passed through untouched, and there the filename IS the truth. This is the case the
        // fix must not break: it proves the type is being decided per-path and not hardcoded.
        const result = await get('/thumbnail?type=avatar&file=Moving.gif');

        expect(result.status).toBe(200);
        expect(result.declared).toBe('image/gif');
        expectBytesToMatchDeclaration(result);
    });

    test('and the untouched card PNG at /characters is still a PNG', async () => {
        // Vocalis's C10 read path. Not a thumbnail at all, and it was always correct — asserted so that
        // a future change to the thumbnail funnel cannot quietly take the real avatar with it.
        const result = await get('/characters/Probe.png');

        expect(result.status).toBe(200);
        expect(result.declared).toBe('image/png');
        expectBytesToMatchDeclaration(result);
        expect(Buffer.from(result.magic)).toEqual(ONE_PIXEL_PNG.subarray(0, 4));
    });
});
