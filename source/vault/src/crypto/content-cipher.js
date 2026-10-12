import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

/**
 * The content cipher — AES-256-GCM in 64 KiB blocks (the STREAM construction).
 *
 * ```
 * ┌──────────────── header (cleartext, but AUTHENTICATED into every block) ────────────────┐
 * │ magic "STV1" (4) │ version (1) │ reserved (3) │ random per-file nonce prefix (8)        │
 * └───────────────────────────────────────────────────────────────────────────────────────┘
 * ┌ block 0 (64 KiB + 16-byte tag) ┐┌ block 1 ┐┌ … ┐┌ block N (FINAL, may be short) ┐
 *
 *   each block: AES-256-GCM(k_content, nonce = prefix ‖ counter32, aad = header ‖ index ‖ final)
 * ```
 *
 * ## Why not one big AEAD blob
 *
 * A single monolithic ciphertext would be simpler and is wrong, for a reason that shows up the first
 * time a user seeks within a video:
 *
 * - **O(1) SEEKS.** SillyTavern serves audio and video out of `user/images` and large documents out of
 *   `user/files`, and browsers request them with `Range:`. Against a monolithic blob, serving byte
 *   47,000,000 means decrypting from byte zero — on EVERY seek. Worse, a partial read cannot be
 *   authenticated at all, so you would be choosing between "slow" and "unauthenticated". Blocks let us
 *   decrypt exactly the blocks the range touches, and authenticate each one.
 *
 * - **TRUNCATION IS DETECTED.** The final block says so, in its AAD. Cut a file short and the new last
 *   block will not claim to be final, and decryption fails — instead of silently yielding a shorter,
 *   entirely plausible file. A chat that quietly loses its last hundred messages is worse than a chat
 *   that fails to open.
 *
 * - **BLOCKS CANNOT BE MOVED.** The block index is in the AAD and the nonce prefix is per-file and
 *   random, so a block cannot be reordered within a file or transplanted between files.
 *
 * AES-NI makes the cost noise; Node's crypto does this natively.
 *
 * ## The plaintext length is recoverable from the file size alone
 *
 * This matters more than it sounds. `stat().size` becomes `Content-Length`, and SillyTavern's serve
 * paths set it BEFORE reading a byte. Report the ciphertext size and every HTTP response either
 * truncates or hangs. The block layout is regular, so the plaintext length is arithmetic — no decryption
 * and no key required. See {@link plaintextLength}.
 */

export const MAGIC = Buffer.from('STV1', 'ascii');
export const VERSION = 1;

/** 4 magic + 1 version + 3 reserved + 8 nonce prefix. Aligned, for the sake of anyone reading a hexdump. */
export const HEADER_SIZE = 16;

/** The plaintext block size. 64 KiB — big enough that the tag overhead is ~0.02%, small enough to seek. */
export const BLOCK_SIZE = 64 * 1024;

/** GCM's tag. */
export const TAG_SIZE = 16;

/** What one full block costs on disk. */
export const CIPHER_BLOCK_SIZE = BLOCK_SIZE + TAG_SIZE;

/**
 * Build a file header with a fresh random nonce prefix.
 * @returns {Buffer} A 16-byte header
 */
export function createHeader() {
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header, 0);
    header[4] = VERSION;
    crypto.randomBytes(8).copy(header, 8);
    return header;
}

/**
 * Read and validate a header.
 * @param {Buffer} header The first 16 bytes of a file
 * @returns {{noncePrefix: Buffer}} The nonce prefix
 */
export function parseHeader(header) {
    if (header.length < HEADER_SIZE || !header.subarray(0, 4).equals(MAGIC)) {
        throw new Error('Not an encrypted file: the magic is wrong.');
    }

    if (header[4] !== VERSION) {
        throw new Error(`Unsupported encrypted-file version ${header[4]}.`);
    }

    return { noncePrefix: header.subarray(8, 16) };
}

/**
 * The nonce for a block: the file's random prefix, then the block index.
 *
 * 96 bits, which is what GCM wants. The prefix is per-file and random, so the same block index in two
 * different files never reuses a nonce — which for GCM is not a style preference, it is the difference
 * between "encrypted" and "not".
 * @param {Buffer} noncePrefix The file's 8-byte prefix
 * @param {number} index The block index
 * @returns {Buffer} A 12-byte nonce
 */
function nonceFor(noncePrefix, index) {
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce, 0);
    nonce.writeUInt32BE(index, 8);
    return nonce;
}

/**
 * The associated data for a block: the header, the block's index, and whether it is the last one.
 *
 * Binding all three is what stops a block being reordered, transplanted into another file, or silently
 * dropped off the end.
 * @param {Buffer} header The file header
 * @param {number} index The block index
 * @param {boolean} isFinal Whether this is the last block
 * @returns {Buffer} The AAD
 */
function aadFor(header, index, isFinal) {
    const aad = Buffer.alloc(HEADER_SIZE + 5);
    header.copy(aad, 0);
    aad.writeUInt32BE(index, HEADER_SIZE);
    aad[HEADER_SIZE + 4] = isFinal ? 1 : 0;
    return aad;
}

/**
 * How long is the plaintext, given only the size of the ciphertext?
 *
 * No key, no decryption, no I/O beyond the stat that produced the number. `Content-Length` depends on
 * this being right.
 * @param {number} cipherLength The size of the file on disk
 * @returns {number} The logical size
 */
export function plaintextLength(cipherLength) {
    const body = cipherLength - HEADER_SIZE;

    if (body < 0) {
        throw new Error('Encrypted file is too short to contain a header.');
    }

    const wholeBlocks = Math.floor(body / CIPHER_BLOCK_SIZE);
    const remainder = body % CIPHER_BLOCK_SIZE;

    if (remainder === 0) {
        // Every block is full. (An empty plaintext is stored as one empty final block, so body is never
        // zero for a well-formed file — see the check below.)
        if (wholeBlocks === 0) {
            throw new Error('Encrypted file has no blocks. It has been truncated.');
        }

        return wholeBlocks * BLOCK_SIZE;
    }

    if (remainder < TAG_SIZE) {
        throw new Error('Encrypted file is malformed: the final block is shorter than its tag.');
    }

    return wholeBlocks * BLOCK_SIZE + (remainder - TAG_SIZE);
}

/**
 * How big will the ciphertext be, for a plaintext of this length?
 * @param {number} length The plaintext length
 * @returns {number} The on-disk size
 */
export function cipherLength(length) {
    // An empty plaintext still gets one (empty) final block, so that truncating a file to nothing is
    // detectable rather than indistinguishable from an empty file.
    const blocks = Math.max(1, Math.ceil(length / BLOCK_SIZE));
    return HEADER_SIZE + length + blocks * TAG_SIZE;
}

/**
 * Encrypt a whole buffer.
 * @param {Buffer} key The 32-byte content key
 * @param {Buffer} plaintext The plaintext
 * @returns {Buffer} The encrypted file
 */
export function encryptBuffer(key, plaintext) {
    const header = createHeader();
    const { noncePrefix } = parseHeader(header);
    const parts = [header];

    const blocks = Math.max(1, Math.ceil(plaintext.length / BLOCK_SIZE));

    for (let index = 0; index < blocks; index++) {
        const start = index * BLOCK_SIZE;
        const chunk = plaintext.subarray(start, Math.min(start + BLOCK_SIZE, plaintext.length));
        const isFinal = index === blocks - 1;

        const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceFor(noncePrefix, index));
        cipher.setAAD(aadFor(header, index, isFinal));
        parts.push(cipher.update(chunk), cipher.final(), cipher.getAuthTag());
    }

    return Buffer.concat(parts);
}

/**
 * Decrypt a single block.
 * @param {Buffer} key The content key
 * @param {Buffer} header The file header
 * @param {Buffer} noncePrefix The nonce prefix
 * @param {Buffer} block The block, tag included
 * @param {number} index The block index
 * @param {boolean} isFinal Whether this block claims to be the last
 * @returns {Buffer} The plaintext of that block
 */
function decryptBlock(key, header, noncePrefix, block, index, isFinal) {
    const body = block.subarray(0, block.length - TAG_SIZE);
    const tag = block.subarray(block.length - TAG_SIZE);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(noncePrefix, index));
    decipher.setAAD(aadFor(header, index, isFinal));
    decipher.setAuthTag(tag);

    // GCM authenticates in final(). If the block was tampered with, moved, reordered, or is not the
    // block the file says it is, this throws — which is the entire point.
    return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * Decrypt a whole buffer.
 * @param {Buffer} key The content key
 * @param {Buffer} sealed The encrypted file
 * @returns {Buffer} The plaintext
 */
export function decryptBuffer(key, sealed) {
    const header = sealed.subarray(0, HEADER_SIZE);
    const { noncePrefix } = parseHeader(header);

    // 🔴 THE STRUCTURAL CHECK, AND LEAVING IT OUT MADE TRUNCATION SILENT — the one outcome this file's
    // opening docblock says must never happen.
    //
    // `blocks` below is a `ceil`, so a file truncated to exactly its header gives ZERO blocks, the loop
    // never runs, and `Buffer.concat([])` is returned as authenticated plaintext. No tag is verified,
    // because there is no block to verify one on. The caller gets an empty file and a clean success, and
    // the six regenerate-on-unreadable paths `provider.js` warns about respond to empty data by writing
    // the file again from nothing. `dd bs=16 count=1` over a chat is silent, permanent destruction, and
    // it needs no key -- a poisoned dependency can write as well as read.
    //
    // The guard was already written, one function up: `plaintextLength` throws 'Encrypted file has no
    // blocks. It has been truncated.' for exactly this input, and rejects a final block shorter than its
    // tag as well. `decryptRange` has always called it. This path never did, which is the whole defect --
    // not a missing idea, a missing call.
    plaintextLength(sealed.length);

    const body = sealed.subarray(HEADER_SIZE);
    const blocks = Math.ceil(body.length / CIPHER_BLOCK_SIZE);
    const parts = [];

    for (let index = 0; index < blocks; index++) {
        const start = index * CIPHER_BLOCK_SIZE;
        const block = body.subarray(start, Math.min(start + CIPHER_BLOCK_SIZE, body.length));
        const isFinal = index === blocks - 1;

        parts.push(decryptBlock(key, header, noncePrefix, block, index, isFinal));
    }

    return Buffer.concat(parts);
}

/**
 * Decrypt only the blocks a byte range touches.
 *
 * 🔴 THIS IS WHY THE FILE IS IN BLOCKS AT ALL. A browser seeking into a 90 MB video sends
 * `Range: bytes=47000000-`, and this decrypts the handful of blocks that range lands on rather than the
 * 47 MB in front of it. Every one of those blocks is still authenticated individually.
 * @param {Buffer} key The content key
 * @param {Buffer} sealed The encrypted file
 * @param {number} start First plaintext byte wanted, inclusive
 * @param {number} end Last plaintext byte wanted, inclusive
 * @returns {Buffer} Exactly the requested plaintext bytes
 */
export function decryptRange(key, sealed, start, end) {
    const header = sealed.subarray(0, HEADER_SIZE);
    const { noncePrefix } = parseHeader(header);

    const body = sealed.subarray(HEADER_SIZE);
    const totalBlocks = Math.ceil(body.length / CIPHER_BLOCK_SIZE);
    const length = plaintextLength(sealed.length);

    const from = Math.max(0, start);
    const to = Math.min(end, length - 1);

    if (from > to) {
        return Buffer.alloc(0);
    }

    const firstBlock = Math.floor(from / BLOCK_SIZE);
    const lastBlock = Math.floor(to / BLOCK_SIZE);
    const parts = [];

    for (let index = firstBlock; index <= lastBlock; index++) {
        const offset = index * CIPHER_BLOCK_SIZE;
        const block = body.subarray(offset, Math.min(offset + CIPHER_BLOCK_SIZE, body.length));
        const isFinal = index === totalBlocks - 1;

        parts.push(decryptBlock(key, header, noncePrefix, block, index, isFinal));
    }

    // Trim the decrypted blocks down to exactly what was asked for.
    const decrypted = Buffer.concat(parts);
    const offsetInFirst = from - firstBlock * BLOCK_SIZE;

    return decrypted.subarray(offsetInFirst, offsetInFirst + (to - from + 1));
}
