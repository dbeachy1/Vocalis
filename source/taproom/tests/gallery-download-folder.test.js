import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import yauzl from 'yauzl';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * Gallery downloads must return usable image bytes when storage is encrypted.
 *
 * The archive must decrypt each stored image rather than return ciphertext; downloading the whole data
 * root is broader than a gallery export, while saving files individually loses the folder operation.
 *
 * ⚠️ **The failure this suite exists to catch is silent.** `archive.directory()` and `archive.glob()`
 * would produce a zip of exactly the right shape — right entry names, right count, plausible sizes —
 * containing raw ciphertext, and nobody finds out until they open a picture weeks later. So the test
 * that matters is not "a zip came back", it is **byte-for-byte equality with what was uploaded**.
 */
describe('🔴 Gallery folder download', () => {
    /** @type {string} */
    let scratch;
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let st;
    /** @type {string} */
    let base;

    /** A one-pixel PNG. Small, but its bytes are distinctive enough to compare against. */
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const FOLDER = 'Cleo';

    beforeAll(async () => {
        scratch = makeScratchDirectory('gallery-download-folder');

        st = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);
        base = `http://127.0.0.1:${st.port}`;
    }, 240_000);

    afterAll(async () => {
        await st?.stop();
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    /**
     * @param {string} filename Name to store it under, without extension
     * @param {string} folder Character folder
     * @returns {Promise<number>} The upload's HTTP status
     */
    async function upload(filename, folder) {
        const response = await fetch(`${base}/api/images/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: PNG.toString('base64'), format: 'png', filename, ch_name: folder }),
        });

        return response.status;
    }

    /**
     * @param {string} folder Character folder
     * @returns {Promise<{status: number, buffer: Buffer, disposition: string|null}>} The response
     */
    async function download(folder) {
        const response = await fetch(`${base}/api/images/download-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder }),
        });

        return {
            status: response.status,
            buffer: Buffer.from(await response.arrayBuffer()),
            disposition: response.headers.get('content-disposition'),
        };
    }

    /**
     * @param {Buffer} buffer The zip
     * @returns {Promise<Map<string, Buffer>>} Entry name to its decompressed bytes
     */
    function readZip(buffer) {
        return new Promise((resolve, reject) => {
            /** @type {Map<string, Buffer>} */
            const entries = new Map();

            yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
                if (error) return reject(error);

                zip.on('entry', (entry) => {
                    zip.openReadStream(entry, (streamError, stream) => {
                        if (streamError) return reject(streamError);
                        /** @type {Buffer[]} */
                        const chunks = [];
                        stream.on('data', chunk => chunks.push(chunk));
                        stream.on('end', () => {
                            entries.set(entry.fileName, Buffer.concat(chunks));
                            zip.readEntry();
                        });
                        stream.on('error', reject);
                    });
                });

                zip.on('end', () => resolve(entries));
                zip.on('error', reject);
                zip.readEntry();
            });
        });
    }

    test('a folder with no images answers 404 as JSON, before any archive headers are committed', async () => {
        const result = await download('NobodyHasThisName');
        expect(result.status).toBe(404);
        expect(result.disposition).toBeNull();
    });

    test('a missing folder name is rejected', async () => {
        const response = await fetch(`${base}/api/images/download-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });

        expect(response.status).toBe(400);
    });

    test('🔴 a traversal attempt cannot reach outside the images directory', async () => {
        const result = await download('../../../etc');
        // `sanitize-filename` flattens it, so it becomes a folder name that does not exist rather
        // than a path that escapes. Either rejection is acceptable; escaping is not.
        expect([400, 404]).toContain(result.status);
        expect(result.disposition).toBeNull();
    });

    test('every uploaded image comes back in the zip', async () => {
        expect(await upload('first', FOLDER)).toBe(200);
        expect(await upload('second', FOLDER)).toBe(200);
        expect(await upload('third', FOLDER)).toBe(200);

        const result = await download(FOLDER);
        expect(result.status).toBe(200);
        expect(result.disposition).toContain(`${FOLDER}.zip`);

        const entries = await readZip(result.buffer);
        expect(entries.size).toBe(3);
        expect([...entries.keys()].sort()).toEqual(['first.png', 'second.png', 'third.png']);
    });

    test('🔴 the archived bytes are the LOGICAL image, not whatever is on disk', async () => {
        // The whole point. Under a transforming storage provider, letting archiver read the directory
        // itself would zip ciphertext -- correct names, correct count, unopenable contents.
        const entries = await readZip((await download(FOLDER)).buffer);

        for (const [name, contents] of entries) {
            expect({ name, equal: contents.equals(PNG) }).toEqual({ name, equal: true });
        }
    });

    test('one folder does not leak into another', async () => {
        expect(await upload('lonely', 'SomeoneElse')).toBe(200);

        const entries = await readZip((await download('SomeoneElse')).buffer);
        expect([...entries.keys()]).toEqual(['lonely.png']);
    });
});
