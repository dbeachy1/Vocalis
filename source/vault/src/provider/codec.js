import fs from 'node:fs';
import { Buffer } from 'node:buffer';

import { decryptBuffer, encryptBuffer } from '../crypto/content-cipher.js';
import { MAX_HEADER_BYTES, unwrapEnvelope, wrapEnvelope } from '../envelope.js';
import { undecodable } from '../errors.js';
import { contentKey, isEnveloped, isPassthrough } from './resolve.js';

/**
 * HOW BYTES CROSS THE BOUNDARY -- and the only place that knows the order they cross it in.
 *
 * Reading: strip the envelope, then decrypt, then hand back what the caller asked for. Writing: the same
 * in reverse. Neither order is free. The envelope is a fixed-length prefix the content cipher has never
 * heard of, so leaving it on offsets everything by exactly its length, silently, with every value looking
 * entirely plausible.
 *
 * 🔴 AND THE KEY IS REACHED THROUGH `contentKey`, NEVER OFF `at.keys`. A locked vault must produce a
 * `StorageError`, not a `TypeError` on `undefined.kContent` -- `contentKey` spends twenty lines on why
 * that distinction is the difference between "refused" and "deleted and regenerated". Everything here
 * goes through it, so that is true by construction rather than by everyone remembering.
 */

/**
 * Decrypt, and turn any failure into EPROVIDER rather than something SillyTavern will react to by deleting
 * the file.
 * @param {Buffer} key The content key
 * @param {Buffer} sealed The bytes on disk
 * @param {string} absPath The logical path, for the error
 * @returns {Buffer} The plaintext
 */
function decrypt(key, sealed, absPath) {
    try {
        return decryptBuffer(key, sealed);
    } catch (error) {
        throw undecodable(
            `Could not decrypt '${absPath}': ${error.message}. The file is intact on disk; it cannot be decoded with the current key. It must NOT be deleted or regenerated.`,
            absPath,
        );
    }
}

/**
 * The first bytes of a file — at most one header's worth, and never the whole file.
 *
 * ⚠️ **`subarray(0, read)`, not the whole buffer.** A file shorter than the window leaves the tail of an
 * `alloc`ed buffer full of NULs that were never on the disk, and handing those to a parser is asking it to
 * decide a question about bytes that do not exist. Return what was actually read and nothing else.
 * @param {string} physical The on-disk path
 * @returns {Buffer} The leading bytes, up to {@link MAX_HEADER_BYTES}
 */
export function readHeaderPrefix(physical) {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const fd = fs.openSync(physical, 'r');

    try {
        return buffer.subarray(0, fs.readSync(fd, buffer, 0, MAX_HEADER_BYTES, 0));
    } finally {
        // `finally`, not a trailing call: every caller of this is inside a `try` that swallows, so a throw
        // between open and close would leak the descriptor silently and once per chat in a chat list.
        fs.closeSync(fd);
    }
}

/**
 * Encrypt, and wrap in the public envelope if this account writes one.
 * @param {{scheme: number, ours: boolean}} resolved A resolution
 * @param {Buffer} key The content key
 * @param {Buffer} plaintext The bytes as the caller supplied them
 * @returns {Buffer} The bytes to put on disk
 */
function seal(resolved, key, plaintext) {
    const sealed = encryptBuffer(key, plaintext);
    return isEnveloped(resolved) ? wrapEnvelope(sealed) : sealed;
}

/**
 * Strip the public envelope, and turn any failure into EPROVIDER.
 *
 * 🔴 THE NAME ALREADY SAID THIS FILE IS OURS, SO EVERY FAILURE FROM HERE IS *OURS AND BROKEN*.
 *
 * That is the whole of §3, and the reason this function has no fallback path that returns the raw bytes. A
 * file whose envelope is missing, whose provider id is somebody else's, or whose version is from a future
 * build is damaged or foreign — and the one thing it must never be reported as is absent, because
 * `provider.js` opens by naming the cost: SillyTavern has six code paths that respond to unreadable data by
 * deleting it and regenerating it from source. A chat that is merely damaged would be repaired by being
 * destroyed.
 * @param {{scheme: number, ours: boolean}} resolved A resolution
 * @param {Buffer} raw The bytes on disk
 * @param {string} absPath The logical path, for the error
 * @returns {Buffer} The `STV1` blob the content cipher can read
 */
function unseal(resolved, raw, absPath) {
    if (!isEnveloped(resolved)) {
        return raw;
    }

    const opened = unwrapEnvelope(raw);

    if (!opened.ok) {
        throw undecodable(
            `Could not read '${absPath}': ${opened.reason}. The file is intact on disk and it must NOT be deleted or regenerated.`,
            absPath,
        );
    }

    return opened.sealed;
}

/**
 * 🔀 THE WHOLE READ SIDE OF THE BOUNDARY, IN ONE PLACE.
 *
 * `decrypt(contentKey(at, p), unseal(at, sealed, p), p)` was written out, character for character, in FIVE
 * methods: `readFile`, `readFileSync`, `createReadStream`, `sendFile` and `copyFile`. Each also decided
 * `isPassthrough` for itself, which is the same question asked eleven times across this file.
 *
 * The composition is not arbitrary and the order is not free — the envelope comes off before the content
 * cipher sees the bytes, and the key is reached through {@link contentKey} rather than off `at.keys`, so
 * that a locked vault produces a `StorageError` instead of a `TypeError` on `undefined.kContent`. Written
 * once, those two facts are structural. Written five times, they were a convention that held because
 * nobody had yet copied the wrong line.
 * @param {ReturnType<typeof resolve>} at A resolution
 * @param {Buffer} raw The bytes as they are on the disk
 * @param {string} absPath The logical path, for the error
 * @returns {Buffer} The plaintext — or the raw bytes, if they were never ours to transform
 */
export function openBytes(at, raw, absPath) {
    return isPassthrough(at) ? raw : decrypt(contentKey(at, absPath), unseal(at, raw, absPath), absPath);
}

/**
 * 🔀 AND THE WRITE SIDE. `seal(at, contentKey(at, p), …)` appeared in five places for the same reason.
 * @param {ReturnType<typeof resolve>} at A resolution
 * @param {Buffer} plaintext The bytes as the caller supplied them
 * @param {string} absPath The logical path, for the error
 * @returns {Buffer} The bytes to put on disk
 */
export function sealBytes(at, plaintext, absPath) {
    return isPassthrough(at) ? plaintext : seal(at, contentKey(at, absPath), plaintext);
}

/**
 * Turn a decrypted buffer into whatever the caller asked for.
 *
 * ⚠️ `opts` is load-bearing and easy to drop. `readFile(p, 'utf-8')` must return a STRING, not a Buffer —
 * and a caller that gets a Buffer where it expected a string will usually not crash. It will quietly do the
 * wrong thing, like writing `[object Object]` into a settings file.
 * @param {Buffer} plaintext The decrypted bytes
 * @param {any} opts Whatever SillyTavern passed
 * @returns {Buffer|string} The bytes, or a string
 */
export function asRequested(plaintext, opts) {
    const encoding = typeof opts === 'string' ? opts : opts?.encoding;
    return encoding ? plaintext.toString(encoding) : plaintext;
}

/**
 * Turn whatever SillyTavern handed us into the bytes it means.
 *
 * ⚠️ `writeFile(p, data, 'base64')` means "`data` is a base64 STRING; decode it and store the bytes". A
 * provider that ignores the encoding encrypts the base64 TEXT instead of the image, and the file comes back
 * as gibberish that is, infuriatingly, the right length.
 *
 * 🔴 **`ArrayBuffer.isView`, NOT `Buffer.isBuffer` — and this exact line shipped the bug the docblock above
 * warns about.** `Buffer.isBuffer(new Uint8Array(...))` is **false**, so a typed array fell through to
 * `String(data)` and became the comma-joined decimal byte list: an 8-byte PNG signature stored as the 24
 * ASCII bytes `"137,80,78,71,13,10,26,10"`. Nothing threw. The live path was `POST /api/images/upload`,
 * which handed us `new Uint8Array(imageBuffer)`; on a no-provider install `write-file-atomic` takes a
 * TypedArray natively, so it only ever broke on a VAULTED install — user uploads an image, gets a 200, and
 * the picture is quietly not a picture.
 *
 * `storage.js` in the fork says this interface mirrors `node:fs` semantics, and `node:fs` accepts any
 * `TypedArray`/`DataView`. Being stricter than the contract we claim to implement would be defensible if it
 * threw; being stricter and *silently corrupting* is not. A `DataView` or a `Uint8Array` over a slice of a
 * larger `ArrayBuffer` is why the offset and length are passed explicitly rather than using `data.buffer` —
 * that would take the whole backing store, which is a different and much longer file.
 * @param {any} data Whatever was passed
 * @param {any} opts Whatever was passed
 * @returns {Buffer} The bytes to store
 */
export function asBytes(data, opts) {
    if (Buffer.isBuffer(data)) {
        return data;
    }

    // Every TypedArray and DataView. A Buffer is one too, but it took the branch above already.
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }

    // 🔴 REFUSE WHAT node:fs REFUSES. This used to fall through to `String(data)` for ANYTHING, so
    // `writeFile(settingsPath, { theme: 'dark' })` stored the fifteen bytes `[object Object]`, reported
    // success, and read back as that literal. `undefined` stored `"undefined"`.
    //
    // The docblock above names that exact outcome as the thing to avoid, and then argues -- correctly --
    // that being STRICTER than node:fs is indefensible for a drop-in. Being LOOSER while silently
    // corrupting the file is the same defect wearing the other hat: node:fs throws ERR_INVALID_ARG_TYPE
    // here, so a caller who hits this has a bug that every other storage backend would have shown them.
    //
    // Strings and numbers still convert, because node:fs accepts those.
    if (data === null || data === undefined || (typeof data === 'object' && typeof data.toString !== 'function')) {
        throw new TypeError(
            'The "data" argument must be of type string or an instance of Buffer or TypedArray. Received ' +
            (data === null ? 'null' : typeof data),
        );
    }

    if (typeof data === 'object' && Object.prototype.toString.call(data) === '[object Object]') {
        throw new TypeError(
            'The "data" argument must be of type string or an instance of Buffer or TypedArray. ' +
            'Received a plain object -- it would be stored as the literal text "[object Object]".',
        );
    }

    const encoding = (typeof opts === 'string' ? opts : opts?.encoding) ?? 'utf-8';
    return Buffer.from(String(data), encoding);
}
