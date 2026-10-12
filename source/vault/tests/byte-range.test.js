import { describe, test, expect } from '@jest/globals';

import { parseByteRange } from '../src/byte-range.js';

/**
 * 🔴 THE ENCRYPTED BRANCH OF `sendFile` ANSWERED EVERY RANGE REQUEST WITH `200` AND THE WHOLE BODY.
 *
 * `res.sendFile()` cannot be used for an encrypted file -- it reads the disk itself and would send
 * ciphertext -- so that branch writes the bytes out by hand, and inherited none of what `send` does for
 * free. Nothing crashed, which is why it lasted: a `200` is a legal answer to a range request. It just makes
 * seeking in an `<audio>` element re-download the clip, and some players will not seek at all without `206`.
 *
 * The arithmetic lives in its own module so the edge cases can be pinned without a disk or a response.
 */
describe('the Range header', () => {
    const SIZE = 1000;

    test('no header at all means the whole body', () => {
        expect(parseByteRange(undefined, SIZE)).toBeUndefined();
        expect(parseByteRange(null, SIZE)).toBeUndefined();
    });

    test('an ordinary range is inclusive at BOTH ends', () => {
        // Off by one here serves 500 bytes as 501, or drops the last byte of every seek.
        expect(parseByteRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
        expect(parseByteRange('bytes=500-999', SIZE)).toEqual({ start: 500, end: 999 });
    });

    test('an open-ended range runs to the last byte — this is the commonest one a player sends', () => {
        expect(parseByteRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 });
        expect(parseByteRange('bytes=900-', SIZE)).toEqual({ start: 900, end: 999 });
    });

    test('🔴 a SUFFIX range is the LAST n bytes, not the first n', () => {
        // Getting this backwards serves the wrong half of the file under a 206 claiming it is the right half.
        expect(parseByteRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
    });

    test('a suffix longer than the file is the whole file, not an error', () => {
        expect(parseByteRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
    });

    test('an end past the last byte is clamped — asking for more than exists is allowed', () => {
        expect(parseByteRange('bytes=990-5000', SIZE)).toEqual({ start: 990, end: 999 });
    });

    test('🔴 a start past the end of the file is UNSATISFIABLE, not "send everything"', () => {
        // The distinction the caller must not collapse: answering 200 tells a client that asked for byte
        // 5000 of a 1000-byte file that it succeeded, and it writes those bytes at offset 5000.
        expect(parseByteRange('bytes=5000-6000', SIZE)).toEqual({ unsatisfiable: true });
        expect(parseByteRange('bytes=1000-', SIZE)).toEqual({ unsatisfiable: true });
    });

    test('"the last zero bytes" is unsatisfiable, and is not the same as no range', () => {
        expect(parseByteRange('bytes=-0', SIZE)).toEqual({ unsatisfiable: true });
    });

    test('🔴 every range over an EMPTY file is unsatisfiable', () => {
        // `start > end` alone misses this: for size 0, `bytes=0-` gives start 0, end -1.
        expect(parseByteRange('bytes=0-', 0)).toEqual({ unsatisfiable: true });
        expect(parseByteRange('bytes=0-99', 0)).toEqual({ unsatisfiable: true });
    });

    test('a backwards range is unsatisfiable', () => {
        expect(parseByteRange('bytes=500-100', SIZE)).toEqual({ unsatisfiable: true });
    });

    test('a multi-range request falls through to the whole body, exactly as `send` does', () => {
        // multipart/byteranges is a lot of machinery for something no browser sends for media playback.
        expect(parseByteRange('bytes=0-99, 200-299', SIZE)).toBeUndefined();
    });

    test('a unit we do not know, or plain rubbish, is not an error', () => {
        expect(parseByteRange('items=0-99', SIZE)).toBeUndefined();
        expect(parseByteRange('bytes=abc', SIZE)).toBeUndefined();
        expect(parseByteRange('', SIZE)).toBeUndefined();
        expect(parseByteRange('bytes=-', SIZE)).toBeUndefined();
    });
});
