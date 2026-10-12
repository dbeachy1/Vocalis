import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import { describe, test, expect } from '@jest/globals';

import {
    BLOCK_SIZE,
    CIPHER_BLOCK_SIZE,
    HEADER_SIZE,
    TAG_SIZE,
    cipherLength,
    decryptBuffer,
    decryptRange,
    encryptBuffer,
    plaintextLength,
} from '../src/crypto/content-cipher.js';

const KEY = crypto.randomBytes(32);

/**
 * The STREAM construction, and the four properties it exists to provide.
 *
 * A monolithic AEAD blob would round-trip perfectly and pass any test you wrote without thinking. These
 * are the tests that distinguish it from the thing we actually need.
 */
describe('the content cipher: round trips', () => {
    test.each([
        ['empty', 0],
        ['one byte', 1],
        ['just under a block', BLOCK_SIZE - 1],
        ['exactly one block', BLOCK_SIZE],
        ['just over a block', BLOCK_SIZE + 1],
        ['exactly two blocks', BLOCK_SIZE * 2],
        ['two and a bit blocks', BLOCK_SIZE * 2 + 1234],
    ])('%s', (_label, length) => {
        const plaintext = crypto.randomBytes(length);
        const sealed = encryptBuffer(KEY, plaintext);

        expect(decryptBuffer(KEY, sealed).equals(plaintext)).toBe(true);
    });

    test('a block boundary is not a special case that quietly loses a byte', () => {
        // Off-by-one at the block boundary is the classic way to write a cipher that works on every
        // input you tried and corrupts one in every 65,536 real files.
        for (const length of [BLOCK_SIZE - 1, BLOCK_SIZE, BLOCK_SIZE + 1]) {
            const plaintext = crypto.randomBytes(length);
            expect(decryptBuffer(KEY, encryptBuffer(KEY, plaintext)).equals(plaintext)).toBe(true);
        }
    });
});

describe('🔴 the content cipher: the properties that matter', () => {
    test('stat().size is computable from the FILE SIZE ALONE, with no key', () => {
        // This becomes Content-Length, and SillyTavern sets it before reading a single byte. Get it
        // wrong and every HTTP response either truncates or hangs — which is the easiest way to get this
        // API subtly, maddeningly wrong.
        for (const length of [0, 1, 100, BLOCK_SIZE - 1, BLOCK_SIZE, BLOCK_SIZE + 1, BLOCK_SIZE * 3 + 77]) {
            const sealed = encryptBuffer(KEY, crypto.randomBytes(length));

            expect(sealed.length).toBe(cipherLength(length));
            expect(plaintextLength(sealed.length)).toBe(length);
        }
    });

    test('TRUNCATION is detected — a file cut short does not decrypt to a shorter, plausible file', () => {
        // The nastiest failure mode available. Without the final-block marker, lopping the end off a
        // chat would yield a perfectly valid, perfectly readable chat that is simply missing its last
        // hundred messages — and nothing would ever tell you.
        const plaintext = crypto.randomBytes(BLOCK_SIZE * 3);
        const sealed = encryptBuffer(KEY, plaintext);

        // Drop the last block entirely. The new last block does not claim to be final.
        const truncated = sealed.subarray(0, sealed.length - CIPHER_BLOCK_SIZE);

        expect(() => decryptBuffer(KEY, truncated)).toThrow();
    });

    test('TRUNCATION of a partial final block is detected too', () => {
        const sealed = encryptBuffer(KEY, crypto.randomBytes(BLOCK_SIZE * 2 + 500));

        expect(() => decryptBuffer(KEY, sealed.subarray(0, sealed.length - 10))).toThrow();
    });

    test('REORDERING blocks is detected', () => {
        // The block index is in the AAD, so a block cannot be moved even within its own file.
        const sealed = encryptBuffer(KEY, crypto.randomBytes(BLOCK_SIZE * 2));

        const body = sealed.subarray(HEADER_SIZE);
        const first = body.subarray(0, CIPHER_BLOCK_SIZE);
        const second = body.subarray(CIPHER_BLOCK_SIZE);

        const swapped = Buffer.concat([sealed.subarray(0, HEADER_SIZE), second, first]);

        expect(() => decryptBuffer(KEY, swapped)).toThrow();
    });

    test('TRANSPLANTING a block from another file is detected', () => {
        // The nonce prefix is per-file and random, and the header is bound into every block's AAD. A
        // block lifted out of one file and dropped into another cannot authenticate.
        const a = encryptBuffer(KEY, crypto.randomBytes(BLOCK_SIZE * 2));
        const b = encryptBuffer(KEY, crypto.randomBytes(BLOCK_SIZE * 2));

        const frankenstein = Buffer.concat([
            a.subarray(0, HEADER_SIZE + CIPHER_BLOCK_SIZE),
            b.subarray(HEADER_SIZE + CIPHER_BLOCK_SIZE),
        ]);

        expect(() => decryptBuffer(KEY, frankenstein)).toThrow();
    });

    test('a single flipped bit anywhere is detected', () => {
        const sealed = encryptBuffer(KEY, crypto.randomBytes(BLOCK_SIZE + 10));

        for (const position of [HEADER_SIZE, HEADER_SIZE + 500, sealed.length - 1]) {
            const tampered = Buffer.from(sealed);
            tampered[position] ^= 0x01;

            expect(() => decryptBuffer(KEY, tampered)).toThrow();
        }
    });

    test('the wrong key fails, rather than returning garbage', () => {
        const sealed = encryptBuffer(KEY, crypto.randomBytes(1000));

        expect(() => decryptBuffer(crypto.randomBytes(32), sealed)).toThrow();
    });

    test('two encryptions of the same plaintext differ — the nonce prefix is fresh each time', () => {
        // Content is NOT deterministic. Only filenames are, and only because they have to be.
        const plaintext = Buffer.from('the same chat, twice');

        expect(encryptBuffer(KEY, plaintext).equals(encryptBuffer(KEY, plaintext))).toBe(false);
    });
});

describe('🔴 the content cipher: Range reads', () => {
    // The reason for blocks. A browser seeking into a video sends Range:, and we must decrypt the
    // blocks it lands on — not the 47 MB in front of them.
    const plaintext = crypto.randomBytes(BLOCK_SIZE * 3 + 4321);
    const sealed = encryptBuffer(KEY, plaintext);

    test.each([
        ['the first byte', 0, 0],
        ['inside the first block', 10, 500],
        ['across a block boundary', BLOCK_SIZE - 5, BLOCK_SIZE + 5],
        ['the whole second block', BLOCK_SIZE, BLOCK_SIZE * 2 - 1],
        ['deep into the last block', BLOCK_SIZE * 3 + 100, BLOCK_SIZE * 3 + 4320],
        ['the entire file', 0, plaintext.length - 1],
        ['the last byte', plaintext.length - 1, plaintext.length - 1],
    ])('%s', (_label, start, end) => {
        const got = decryptRange(KEY, sealed, start, end);

        expect(got.equals(plaintext.subarray(start, end + 1))).toBe(true);
    });

    test('a range past the end of the file is clamped, not an error', () => {
        const got = decryptRange(KEY, sealed, plaintext.length - 10, plaintext.length + 1000);

        expect(got.equals(plaintext.subarray(plaintext.length - 10))).toBe(true);
    });

    test('a range read still AUTHENTICATES the blocks it touches', () => {
        // A partial read that skipped authentication would be the worst of both worlds: the seek is fast
        // and the bytes are unverified.
        const tampered = Buffer.from(sealed);
        tampered[HEADER_SIZE + CIPHER_BLOCK_SIZE + 20] ^= 0x01;

        expect(() => decryptRange(KEY, tampered, BLOCK_SIZE, BLOCK_SIZE + 10)).toThrow();
    });

    test('a range read does NOT touch blocks outside the range', () => {
        // Corrupt the LAST block, then read from the FIRST. If the read is honest about only decrypting
        // what it needs, it succeeds — which is exactly the O(1) seek behaviour we are paying for.
        const tampered = Buffer.from(sealed);
        tampered[tampered.length - 5] ^= 0x01;

        const got = decryptRange(KEY, tampered, 0, 100);

        expect(got.equals(plaintext.subarray(0, 101))).toBe(true);
    });
});

describe('the content cipher: the overhead is what the design claims', () => {
    test('roughly 0.02% for a large file', () => {
        const length = BLOCK_SIZE * 100;
        const overhead = cipherLength(length) - length;
        const ratio = overhead / length;

        expect(ratio).toBeLessThan(0.0005);
        expect(overhead).toBe(HEADER_SIZE + 100 * TAG_SIZE);
    });
});
