import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import createVaultProvider from '../src/provider.js';
import * as session from '../src/session.js';
import { createVaultState } from '../src/vault-state.js';

const HANDLE = 'default-user';
const PASSWORD = 'correct horse battery staple';

/** Something with enough bytes to take a meaningful slice out of. */
const CLIP = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

/** @type {string} */
let dataRoot;
/** @type {any} */
let provider;
/** @type {any} */
let vault;
/** @type {string} */
let CLIP_PATH;

/**
 * A LOGICAL path, which in this provider is an absolute one under the data root.
 * @param {...string} parts Path segments below the user's directory
 * @returns {string} The logical path
 */
function at(...parts) {
    return path.join(dataRoot, HANDLE, ...parts);
}

/**
 * The bits of an Express response this code path actually touches.
 * @param {string} [range] The `Range` header the browser sent, if any
 * @returns {any} A response double that records what was sent
 */
function fakeResponse(range) {
    /** @type {Record<string, any>} */
    const headers = {};

    return {
        req: { headers: range === undefined ? {} : { range } },
        statusCode: 200,
        headers,
        /** @type {any} */
        body: undefined,
        type(extension) {
            this.contentType = extension;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(name, value) {
            headers[name] = value;
        },
        end(chunk) {
            this.body = chunk;
        },
    };
}

beforeEach(async () => {
    vault = createVaultState();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sendfile-'));
    fs.mkdirSync(path.join(dataRoot, HANDLE), { recursive: true });
    session.closeAll(vault);

    provider = createVaultProvider(vault);
    provider.init({
        dataRoot,
        accountsEnabled: true,
        basicAuthMode: false,
        authenticationDelegated: false,
        users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
    });

    await provider.unlock(HANDLE, PASSWORD);

    CLIP_PATH = at('user', 'files', 'speech.wav');
    provider.mkdir(at('user', 'files'), { recursive: true });
    provider.writeFileSync(CLIP_PATH, CLIP);
});

afterEach(() => {
    session.closeAll(vault);
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * 🔴 `sendFile` ACCEPTED `opts` AND DROPPED IT ON THE FLOOR — ONLY ON THE ENCRYPTED BRANCH.
 *
 * The passthrough branch forwards `opts` straight to `res.sendFile`, so the very same call behaved one way
 * for a legacy plaintext file and another for an encrypted one, with no way for the caller to tell which it
 * got. The visible symptom was ranges: every `Range` request was answered `200` with the whole body.
 */
describe('sendFile on an encrypted file', () => {
    test('with no Range header it sends the whole body, and advertises that it accepts ranges', async () => {
        const res = fakeResponse();
        await provider.sendFile(res, CLIP_PATH);

        expect(res.statusCode).toBe(200);
        expect(res.headers['Accept-Ranges']).toBe('bytes');
        expect(res.headers['Content-Length']).toBe('1000');
        expect(Buffer.from(res.body).equals(CLIP)).toBe(true);
    });

    test('🔴 a Range request gets 206 and ONLY those bytes', async () => {
        const res = fakeResponse('bytes=100-199');
        await provider.sendFile(res, CLIP_PATH);

        expect(res.statusCode).toBe(206);
        expect(res.headers['Content-Range']).toBe('bytes 100-199/1000');
        expect(res.headers['Content-Length']).toBe('100');
        expect(Buffer.from(res.body).equals(CLIP.subarray(100, 200))).toBe(true);
    });

    test('🔴 and the bytes are the DECRYPTED ones, sliced — not a slice of the ciphertext', async () => {
        // The whole point of this branch: `res.sendFile` would have served the file on the platter.
        const res = fakeResponse('bytes=0-15');
        await provider.sendFile(res, CLIP_PATH);

        expect(Buffer.from(res.body).equals(CLIP.subarray(0, 16))).toBe(true);

        // ...and prove those bytes are nowhere on the platter, or the assertion above proves nothing: a
        // provider that had quietly stopped encrypting would pass it too. The physical names are ciphertext
        // as well, so this walks the tree rather than guessing a path.
        const onDisk = fs.readdirSync(path.join(dataRoot, HANDLE), { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile() && !entry.name.endsWith('.vault-keys.json'))
            .map(entry => fs.readFileSync(path.join(entry.parentPath, entry.name)));

        expect(onDisk.length).toBeGreaterThan(0);
        expect(onDisk.some(bytes => bytes.includes(CLIP.subarray(0, 16)))).toBe(false);
    });

    test('a suffix range serves the END of the file', async () => {
        const res = fakeResponse('bytes=-50');
        await provider.sendFile(res, CLIP_PATH);

        expect(res.statusCode).toBe(206);
        expect(res.headers['Content-Range']).toBe('bytes 950-999/1000');
        expect(Buffer.from(res.body).equals(CLIP.subarray(950))).toBe(true);
    });

    test('🔴 an unsatisfiable range is 416, NOT 200 with the whole file', async () => {
        const res = fakeResponse('bytes=5000-6000');
        await provider.sendFile(res, CLIP_PATH);

        expect(res.statusCode).toBe(416);
        expect(res.headers['Content-Range']).toBe('bytes */1000');
        expect(res.body).toBeUndefined();
    });

    test('acceptRanges: false says so, and then ignores the header', async () => {
        const res = fakeResponse('bytes=100-199');
        await provider.sendFile(res, CLIP_PATH, { acceptRanges: false });

        expect(res.headers['Accept-Ranges']).toBe('none');
        expect(res.statusCode).toBe(200);
        expect(Buffer.from(res.body).equals(CLIP)).toBe(true);
    });

    test('opts.headers are applied — a download name is not optional', async () => {
        const res = fakeResponse();
        await provider.sendFile(res, CLIP_PATH, {
            headers: { 'Content-Disposition': 'attachment; filename="speech.wav"' },
        });

        expect(res.headers['Content-Disposition']).toBe('attachment; filename="speech.wav"');
    });

    test('Last-Modified is sent, and lastModified: false suppresses it', async () => {
        const withIt = fakeResponse();
        await provider.sendFile(withIt, CLIP_PATH);
        expect(withIt.headers['Last-Modified']).toEqual(expect.stringMatching(/GMT$/));

        const without = fakeResponse();
        await provider.sendFile(without, CLIP_PATH, { lastModified: false });
        expect(without.headers['Last-Modified']).toBeUndefined();
    });

    test('a range over an empty file is 416 rather than an empty 206', async () => {
        const empty = at('user', 'files', 'silence.wav');
        provider.writeFileSync(empty, Buffer.alloc(0));

        const res = fakeResponse('bytes=0-');
        await provider.sendFile(res, empty);

        expect(res.statusCode).toBe(416);
        expect(res.headers['Content-Range']).toBe('bytes */0');
    });

    test('a locked vault still refuses before any of this', async () => {
        provider.lock(HANDLE);

        await expect(provider.sendFile(fakeResponse('bytes=0-99'), CLIP_PATH))
            .rejects.toMatchObject({ code: 'EUNAVAILABLE' });
    });
});

/**
 * The randomness is only here to keep the fixture honest -- a file of repeating bytes would let a slice
 * taken at the wrong offset still compare equal.
 */
test('the fixture is not accidentally self-similar', () => {
    expect(CLIP.subarray(100, 200).equals(CLIP.subarray(200, 300))).toBe(false);
    expect(crypto.createHash('sha256').update(CLIP).digest('hex')).toHaveLength(64);
});
