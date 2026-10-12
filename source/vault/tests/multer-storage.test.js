import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Buffer } from 'node:buffer';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import createVaultProvider from '../src/provider.js';
import { DEFAULT_MAX_UPLOAD_BYTES } from '../src/multer-storage.js';
import * as lifecycle from '../src/lifecycle.js';
import * as session from '../src/session.js';
import { createVaultState } from '../src/vault-state.js';

const HANDLE = 'default-user';
const PASSWORD = 'correct horse battery staple';

/** A character card, as it arrives from the browser. */
const CARD = Buffer.from(JSON.stringify({
    name: 'Test Character 1',
    description: '[Test Character 1\'s Personality= "caring", "protective"]',
    first_mes: 'I have been waiting for you.',
}), 'utf-8');

/** @type {string} */
let dataRoot;
/** @type {any} */
let provider;
/** @type {any} */
let engine;

/**
 * The request multer hands the engine, once setUserDataMiddleware has run.
 * @returns {any} A request
 */
function request() {
    return { user: { profile: { handle: HANDLE } } };
}

/**
 * The file multer hands the engine.
 * @param {Buffer} bytes The bytes coming up the wire
 * @returns {any} A multer file
 */
function incoming(bytes) {
    return { originalname: 'Test Character 1.png', stream: Readable.from(bytes) };
}

/**
 * Drive `_handleFile` and wait for it.
 * @param {Buffer} bytes The upload
 * @returns {Promise<any>} What multer would put on `request.file`
 */
function handle(bytes) {
    return new Promise((resolve, reject) => {
        engine._handleFile(request(), incoming(bytes), (error, info) => error ? reject(error) : resolve(info));
    });
}


/**
 * This suite's own provider state.
 *
 * 🔴 A FRESH ONE PER TEST **IS** THE RESET. Before `vault-state.js` the modules held six
 * globals between them, so a test had to remember which `reset*()` calls applied to it -- and
 * `tests/verify.test.js` records a test that passed with its guard DELETED because the shared
 * `dataRoot` was already set by a previous `beforeEach`. Nothing here can do that now: a provider
 * built around this object cannot see any other test's state, because there is no other state to see.
 */
let vault;
beforeEach(async () => {
    vault = createVaultState();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multer-'));
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
    engine = provider.multerStorage();
});

afterEach(() => {
    session.closeAll(vault);
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * 🔴 EVERY IMPORT TOUCHES THE DISK HERE, BEFORE SILLYTAVERN SEES A BYTE OF IT.
 *
 * Character cards, chats, world info, sprite packs, avatars, speech-to-text audio — multer stages all of it
 * as a file, with its own `fs.createWriteStream`, having never heard of the storage provider. So it went
 * down in PLAINTEXT and sat there until SillyTavern got round to reading it and deleting it.
 *
 * The end-to-end test cannot prove this end of it: by the time the request finishes, SillyTavern has already
 * deleted the staged file, so the staging directory is empty and grepping it proves exactly nothing. (That
 * is the same vacuous assertion that let the character-cache leak survive for two milestones — an empty
 * directory contains no plaintext.) So the bytes get inspected HERE, while the file still exists.
 */
describe('🔴 the multer seam: uploads staged on the disk', () => {
    test('🔴 WHAT LANDS ON THE DISK IS CIPHERTEXT', async () => {
        const staged = await handle(CARD);

        // Go and find the actual file, wherever the provider decided to put it. The logical name is not the
        // physical one -- the provider encrypts names too -- so walk for it rather than assuming.
        const uploads = fs.readdirSync(path.join(dataRoot, HANDLE), { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => path.join(entry.parentPath, entry.name))
            .filter(file => !file.endsWith('.vault-keys.json'));

        expect(uploads.length).toBe(1);

        const onDisk = fs.readFileSync(uploads[0]);

        expect(onDisk.toString('latin1')).not.toContain('Test Character 1');
        expect(onDisk.toString('latin1')).not.toContain('waiting for you');
        expect(onDisk.equals(CARD)).toBe(false);

        // And SillyTavern reads it straight back, through the funnel, as the bytes it uploaded.
        expect(provider.readFileSync(staged.path).equals(CARD)).toBe(true);
    });

    test('🔴 destination and filename are LOGICAL — eight readers depend on it', async () => {
        // SillyTavern rebuilds the path as path.join(destination, filename) in eight places and hands it to
        // storage.*, which expects a LOGICAL path and maps it to disk itself. Hand back a physical path and
        // every one of those readers would ask the provider to encrypt an already-encrypted name.
        const staged = await handle(CARD);

        expect(staged.path).toBe(path.join(staged.destination, staged.filename));
        expect(staged.destination).toBe(path.join(dataRoot, HANDLE, '_uploads'));

        // The logical path is NOT what is on the disk...
        expect(fs.existsSync(staged.path)).toBe(false);

        // ...but the provider resolves it, which is the whole point.
        expect(provider.exists(staged.path)).toBe(true);
    });

    test('the reported size is the LOGICAL size', async () => {
        const staged = await handle(CARD);
        expect(staged.size).toBe(CARD.length);
    });

    test('🔴 a LOCKED vault REFUSES the upload — it does not write it in the clear', async () => {
        // The one case where the tempting thing to do is the catastrophic one. multer's default engine would
        // cheerfully put the bytes on the disk unencrypted; there is no key, so the only honest answer is to
        // fail the request.
        lifecycle.lock(vault, HANDLE);

        await expect(handle(CARD)).rejects.toThrow();

        const left = fs.readdirSync(path.join(dataRoot, HANDLE), { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile() && !entry.name.endsWith('.vault-keys.json'));

        expect(left).toEqual([]);
    });

    test('🔴 an upload with NO LOGGED-IN USER is refused', async () => {
        // There is no user, so there is no key, so there is nowhere safe to put this.
        await expect(new Promise((resolve, reject) => {
            engine._handleFile({}, incoming(CARD), (error, info) => error ? reject(error) : resolve(info));
        })).rejects.toThrow(/no logged-in user/i);
    });

    test('_removeFile deletes the staged file', async () => {
        const staged = await handle(CARD);
        expect(provider.exists(staged.path)).toBe(true);

        await new Promise((resolve, reject) => {
            engine._removeFile(request(), staged, (error) => error ? reject(error) : resolve(undefined));
        });

        expect(provider.exists(staged.path)).toBe(false);
    });

    test('a large upload survives being chunked', async () => {
        // The stream arrives in pieces. A naive engine that encrypts per chunk, or that forgets to wait for
        // `end`, produces a file that is quietly truncated -- and a truncated ciphertext does not decrypt to
        // a truncated file, it decrypts to nothing at all.
        const big = crypto.randomBytes(5 * 1024 * 1024);
        const staged = await handle(big);

        expect(staged.size).toBe(big.length);
        expect(provider.readFileSync(staged.path).equals(big)).toBe(true);
    });
});

describe('🔴 an upload is bounded, and a shut vault is discovered before the transfer, not after', () => {
    test('🔴 a LOCKED vault is refused BEFORE the stream is read, not after the last byte', async () => {
        // The engine used to buffer the whole upload and only reach for the key at `end`, so the user paid
        // for the entire transfer before being told it could not be saved. `createWriteStream` asks for the
        // content key eagerly, so the refusal lands before a single byte moves.
        lifecycle.lock(vault, HANDLE);

        let consumed = 0;
        const stream = Readable.from(CARD);
        stream.on('data', (chunk) => {
            consumed += chunk.length;
        });

        await expect(new Promise((resolve, reject) => {
            engine._handleFile(request(), { originalname: 'Test Character 1.png', stream }, (error, info) => error ? reject(error) : resolve(info));
        })).rejects.toThrow();

        // 🔴 THIS IS THE ASSERTION. Rejecting is not the fix -- it rejected before. Rejecting having read
        // NOTHING is the fix, and it is the only part a "does it fail?" test cannot see.
        expect(consumed).toBe(0);
    });

    test('🔴 an upload over the ceiling is refused, and nothing is staged', async () => {
        // The ceiling is a bound on MEMORY: an encrypted file is sealed as one message, so the plaintext,
        // the concatenation of it and the ciphertext are all live at once. Unbounded means an OOM that takes
        // every other user's session with it.
        const small = provider.multerStorage(1024);
        const over = crypto.randomBytes(4096);

        await expect(new Promise((resolve, reject) => {
            small._handleFile(request(), incoming(over), (error, info) => error ? reject(error) : resolve(info));
        })).rejects.toThrow(/larger than 1024 bytes/i);

        const left = fs.readdirSync(path.join(dataRoot, HANDLE), { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile() && !entry.name.endsWith('.vault-keys.json'));

        expect(left).toEqual([]);
    });

    test('an upload exactly AT the ceiling is allowed — the limit is a maximum, not a target', async () => {
        const exact = provider.multerStorage(4096);
        const bytes = crypto.randomBytes(4096);
        const staged = await new Promise((resolve, reject) => {
            exact._handleFile(request(), incoming(bytes), (error, info) => error ? reject(error) : resolve(info));
        });

        expect(staged.size).toBe(4096);
        expect(provider.readFileSync(staged.path).equals(bytes)).toBe(true);
    });

    test('the default ceiling is generous enough that nothing real meets it', () => {
        // If this ever has to shrink, it is a policy decision and it belongs in the comment on the constant,
        // not in a quiet edit: refusing a legitimate import is a support call.
        expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(500 * 1024 * 1024);
    });
});
