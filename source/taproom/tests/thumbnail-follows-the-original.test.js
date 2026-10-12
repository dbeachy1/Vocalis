import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * 🔴 A CACHED THUMBNAIL WHOSE ORIGINAL HAS CHANGED IS NOT A CACHE HIT.
 *
 * `serveThumbnail` used to regenerate only when nothing was cached, so a thumbnail stayed correct
 * exactly as long as every path that rewrites a character's image remembered to call
 * `invalidateThumbnail`. Six call sites do today. The seventh is the bug, and it is the kind that
 * cannot be found by reading the code that has it — you find it when a user says their character is
 * still wearing last week's face and no reload helps.
 *
 * The staleness comparison already existed inside `generateThumbnail` and was unreachable from the
 * serve path, because the only branch that called it was the one where nothing was cached.
 *
 * ⚠️ THE TEST DELIBERATELY DOES NOT GO THROUGH `/api/characters/edit`. That endpoint invalidates the
 * thumbnail itself, so driving it would prove the invalidation works and say nothing about this. What
 * is under test is the case where NOBODY invalidated: bytes replaced underneath the server, exactly
 * as a future call site that forgets would leave them.
 */
describe('🔴 Thumbnails: a replaced original beats the cached crop', () => {
    /** @type {string} */
    let scratch;
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let st;
    /** @type {string} */
    let base;
    /** @type {string} */
    let charactersDirectory;

    /** Solid red, 64x64. */
    const RED = [255, 0, 0];
    /** Solid green, 64x64 — the picture that replaces it. */
    const GREEN = [0, 255, 0];

    /**
     * CRC-32 table for the PNG chunk checksums.
     * @type {Int32Array}
     */
    const CRC_TABLE = (() => {
        const table = new Int32Array(256);

        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c;
        }

        return table;
    })();

    /**
     * @param {Buffer} buffer Bytes to check
     * @returns {number} CRC-32, as PNG defines it
     */
    function crc32(buffer) {
        let c = 0xFFFFFFFF;

        for (const byte of buffer) {
            c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
        }

        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    /**
     * Encodes a solid-colour PNG.
     *
     * ⚠️ Written out rather than asked of Jimp: the server's encoder is `@jimp/wasm-png`, whose wasm
     * module does not initialise in every test runner. A rectangle is not worth that dependency.
     * @param {number} size Width and height
     * @param {number[]} rgb Colour to fill with
     * @returns {Buffer} PNG bytes
     */
    function solidColourPng(size, [r, g, b]) {
        const stride = size * 3 + 1;
        const raw = Buffer.alloc(stride * size);

        for (let y = 0; y < size; y++) {
            const row = y * stride;
            raw[row] = 0; // Filter type: none.

            for (let x = 0; x < size; x++) {
                raw[row + 1 + x * 3] = r;
                raw[row + 2 + x * 3] = g;
                raw[row + 3 + x * 3] = b;
            }
        }

        /**
         * @param {string} type Four-character chunk type
         * @param {Buffer} data Chunk payload
         * @returns {Buffer} The framed chunk
         */
        const chunk = (type, data) => {
            const length = Buffer.alloc(4);
            length.writeUInt32BE(data.length, 0);
            const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
            const checksum = Buffer.alloc(4);
            checksum.writeUInt32BE(crc32(body), 0);
            return Buffer.concat([length, body, checksum]);
        };

        const header = Buffer.alloc(13);
        header.writeUInt32BE(size, 0);
        header.writeUInt32BE(size, 4);
        header[8] = 8;  // Bit depth.
        header[9] = 2;  // Colour type: truecolour.

        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            chunk('IHDR', header),
            chunk('IDAT', zlib.deflateSync(raw)),
            chunk('IEND', Buffer.alloc(0)),
        ]);
    }

    beforeAll(async () => {
        scratch = makeScratchDirectory('thumbnail-follows-original');

        st = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);
        base = `http://127.0.0.1:${st.port}`;
        charactersDirectory = path.join(scratch, 'data', 'default-user', 'characters');

        fs.mkdirSync(charactersDirectory, { recursive: true });
        fs.writeFileSync(path.join(charactersDirectory, 'Repaint.png'), solidColourPng(64, RED));
    }, 240_000);

    afterAll(async () => {
        await st?.stop();
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    /**
     * @param {string} url URL under the server root
     * @returns {Promise<Buffer>} The response body
     */
    async function getBytes(url) {
        // `cache: 'no-store'` so the runtime's own fetch cache cannot answer for the server.
        const response = await fetch(`${base}${url}`, { cache: 'no-store' });
        expect(response.status).toBe(200);
        return Buffer.from(await response.arrayBuffer());
    }

    /**
     * Replaces the card's bytes underneath the server, the way a call site that forgot to invalidate
     * would leave them.
     * @param {number[]} rgb Colour to write
     * @returns {Promise<void>} When the file is on disk with a newer mtime
     */
    async function replaceCard(rgb) {
        const target = path.join(charactersDirectory, 'Repaint.png');

        // ⚠️ A FILESYSTEM WHOSE TIMESTAMPS HAVE COARSE RESOLUTION WOULD MAKE THIS FLAKY, and the
        // comparison is `>` rather than `>=`. Writing an explicitly later mtime removes the race
        // without weakening what is asserted: the question is whether a newer original is honoured,
        // not whether the clock ticked between two statements.
        fs.writeFileSync(target, solidColourPng(64, rgb));
        const later = new Date(Date.now() + 2000);
        fs.utimesSync(target, later, later);
    }

    test.each([
        ['the tall avatar thumbnail', '/thumbnail?type=avatar&file=Repaint.png'],
        ['the square face thumbnail', '/thumbnail/face?type=face&file=Repaint.png'],
    ])('%s follows the card when nothing invalidated it', async (_label, url) => {
        const before = await getBytes(url);
        expect(before.length).toBeGreaterThan(0);

        // The same request again is a cache hit and must be byte-identical — the control that proves
        // the change asserted below comes from the replacement and not from re-encoding noise.
        expect(await getBytes(url)).toEqual(before);

        await replaceCard(GREEN);

        // ⚠️ BYTES DIFFER, NOT "IT IS GREEN NOW". Reading a colour out of the response would need a
        //    JPEG decoder in this process, and telling the two fixtures apart by compressed size
        //    would be a size assertion wearing a colour's name. Different bytes is what this layer
        //    can honestly prove, and the control above is what makes it mean something: the same
        //    request twice is identical, so a difference can only have come from the replacement.
        //    The "it is the new picture" assertion lives in the browser spec, where a canvas decodes.
        const after = await getBytes(url);
        expect(after).not.toEqual(before);

        // Put it back, so the two parameterised runs do not depend on each other's colour.
        await replaceCard(RED);
    }, 60_000);

    test('an unchanged card is still served from cache, byte for byte', async () => {
        // The other half of the bargain: adding a freshness check must not turn every request into a
        // regeneration. Same bytes twice, with no write in between.
        const url = '/thumbnail?type=avatar&file=Repaint.png';
        const first = await getBytes(url);
        const second = await getBytes(url);

        expect(second).toEqual(first);
    }, 60_000);
});
