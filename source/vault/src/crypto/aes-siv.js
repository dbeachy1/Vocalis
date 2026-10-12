import crypto from 'node:crypto';

/**
 * AES-SIV — RFC 5297. Deterministic authenticated encryption.
 *
 * ## Why this exists at all, and why it is not AES-GCM
 *
 * Filenames have to encrypt DETERMINISTICALLY. Encrypt `chats/Test Character/a chat.jsonl` twice and you
 * must get the same ciphertext both times, or you could never find the file again — every `open` would
 * have to scan and trial-decrypt the entire directory.
 *
 * Every normal AEAD forbids exactly that. AES-GCM with a repeated nonce is catastrophic: it leaks the
 * XOR of the plaintexts and, worse, the authentication key itself. So "just use GCM with a fixed nonce"
 * is not a shortcut, it is a break.
 *
 * SIV is the construction designed for this. It derives its own synthetic IV from the plaintext and the
 * associated data, so identical inputs give identical outputs — deterministically, and still
 * authenticated. It is what Cryptomator uses for filenames, and it is what we use here.
 *
 * ## Why it is implemented here rather than imported
 *
 * Node does not have it. `crypto.getCiphers()` has no `aes-256-siv`: OpenSSL 3 implements the mode but
 * Node does not expose it. The choices were an npm dependency or a careful composition of primitives
 * Node already has.
 *
 * The threat this whole project exists to stop is A POISONED NPM PACKAGE. Adding a crypto dependency to
 * defend against crypto dependencies deserves more scepticism than it usually gets. So: SIV is built
 * here, out of AES-CTR and AES-CMAC, both from OpenSSL via node:crypto — a composition of vetted
 * primitives, following the RFC step by step.
 *
 * 🔴 AND IT IS VERIFIED AGAINST THE RFC'S OWN TEST VECTORS (RFC 5297 §A.1 and §A.2), which run in the
 * unit suite. That is not a nicety. A silently-wrong SIV would produce a vault that looks perfectly
 * fine and is not, and nobody would ever find out. If those vectors do not pass, nothing else in this
 * file is worth anything.
 *
 * ## The key
 *
 * SIV takes a double-length key and splits it: the first half authenticates (S2V/CMAC), the second half
 * encrypts (CTR). For AES-256-SIV that is 64 bytes in, 32 for each. RFC 5297 is explicit that the two
 * halves must be independent, which HKDF gives us for free.
 */

const BLOCK_SIZE = 16;

/**
 * Multiply a 128-bit block by x in GF(2^128), per RFC 5297 §2.3 ("dbl").
 *
 * The polynomial is the one the RFC specifies for CMAC: x^128 + x^7 + x^2 + x + 1, so the reduction
 * constant is 0x87.
 * @param {Buffer} block A 16-byte block
 * @returns {Buffer} The doubled block
 */
function dbl(block) {
    const out = Buffer.alloc(BLOCK_SIZE);
    let carry = 0;

    for (let i = BLOCK_SIZE - 1; i >= 0; i--) {
        const value = (block[i] << 1) | carry;
        out[i] = value & 0xff;
        carry = (block[i] >> 7) & 1;
    }

    // If the top bit was set, reduce by the field polynomial.
    if (carry) {
        out[BLOCK_SIZE - 1] ^= 0x87;
    }

    return out;
}

/**
 * XOR two buffers, up to the length of the shorter one.
 * @param {Buffer} a First
 * @param {Buffer} b Second
 * @returns {Buffer} a XOR b
 */
function xor(a, b) {
    const length = Math.min(a.length, b.length);
    const out = Buffer.alloc(length);

    for (let i = 0; i < length; i++) {
        out[i] = a[i] ^ b[i];
    }

    return out;
}

/**
 * XOR the END of a buffer with another, per the RFC's `xorend`.
 * @param {Buffer} a The longer buffer
 * @param {Buffer} b The shorter buffer
 * @returns {Buffer} a, with its last b.length bytes XORed with b
 */
function xorend(a, b) {
    const out = Buffer.from(a);
    const offset = a.length - b.length;

    for (let i = 0; i < b.length; i++) {
        out[offset + i] ^= b[i];
    }

    return out;
}

/**
 * AES-CMAC (RFC 4493), built on AES-CBC.
 *
 * CMAC is a CBC-MAC with the last block tweaked by one of two subkeys, which is what stops the length-
 * extension attack plain CBC-MAC is vulnerable to. Node has no CMAC either, but CBC with a zero IV is
 * exactly the primitive it is made from.
 * @param {Buffer} key The AES key (16 or 32 bytes)
 * @param {Buffer} message The message to authenticate
 * @returns {Buffer} A 16-byte tag
 */
export function cmac(key, message) {
    const algorithm = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';

    /**
     * Encrypt a single block with a zero IV.
     * @param {Buffer} block The block
     * @returns {Buffer} The encrypted block
     */
    const encryptBlock = (block) => {
        const cipher = crypto.createCipheriv(algorithm, key, Buffer.alloc(BLOCK_SIZE));
        cipher.setAutoPadding(false);
        return Buffer.concat([cipher.update(block), cipher.final()]);
    };

    // Subkey generation (RFC 4493 §2.3).
    const L = encryptBlock(Buffer.alloc(BLOCK_SIZE));
    const K1 = dbl(L);
    const K2 = dbl(K1);

    const blockCount = Math.ceil(message.length / BLOCK_SIZE);
    const isComplete = message.length > 0 && message.length % BLOCK_SIZE === 0;

    // The last block is XORed with K1 if it is whole, or padded and XORed with K2 if it is not. An
    // empty message counts as "not whole" and takes the padded path.
    let lastBlock;

    if (isComplete) {
        lastBlock = xor(message.subarray((blockCount - 1) * BLOCK_SIZE), K1);
    } else {
        const remainder = message.subarray(Math.max(0, blockCount - 1) * BLOCK_SIZE);
        const padded = Buffer.alloc(BLOCK_SIZE);
        remainder.copy(padded);
        padded[remainder.length] = 0x80;
        lastBlock = xor(padded, K2);
    }

    // CBC-chain everything before the last block, then the tweaked last block.
    const head = message.subarray(0, Math.max(0, blockCount - 1) * BLOCK_SIZE);
    const cipher = crypto.createCipheriv(algorithm, key, Buffer.alloc(BLOCK_SIZE));
    cipher.setAutoPadding(false);
    cipher.update(head);

    return Buffer.concat([cipher.update(lastBlock), cipher.final()]);
}

/**
 * S2V — the string-to-vector construction of RFC 5297 §2.4. This is what makes SIV deterministic: the
 * IV is derived from the inputs rather than chosen at random.
 * @param {Buffer} key The MAC half of the key
 * @param {Buffer[]} associated Associated data strings, in order
 * @param {Buffer} plaintext The plaintext
 * @returns {Buffer} The 16-byte synthetic IV
 */
function s2v(key, associated, plaintext) {
    // S2V of nothing at all is CMAC(<one>).
    if (associated.length === 0 && plaintext.length === 0) {
        const one = Buffer.alloc(BLOCK_SIZE);
        one[BLOCK_SIZE - 1] = 1;
        return cmac(key, one);
    }

    let d = cmac(key, Buffer.alloc(BLOCK_SIZE));

    for (const item of associated) {
        d = xor(dbl(d), cmac(key, item));
    }

    // A plaintext of at least a full block gets xorend'd; a short one is padded and doubled.
    if (plaintext.length >= BLOCK_SIZE) {
        return cmac(key, xorend(plaintext, d));
    }

    const padded = Buffer.alloc(BLOCK_SIZE);
    plaintext.copy(padded);
    padded[plaintext.length] = 0x80;

    return cmac(key, xor(dbl(d), padded));
}

/**
 * The CTR keystream is run with the synthetic IV, but with two bits cleared (RFC 5297 §2.5). They are
 * zeroed so that the 32-bit counter cannot overflow into the rest of the IV on long messages.
 * @param {Buffer} v The synthetic IV
 * @returns {Buffer} The counter block
 */
function counterFromIv(v) {
    const counter = Buffer.from(v);
    counter[8] &= 0x7f;
    counter[12] &= 0x7f;
    return counter;
}

/**
 * Encrypt deterministically.
 *
 * The same (key, associated data, plaintext) always produces the same ciphertext. That is the point,
 * and it is also the accepted leak: an observer can tell that two files have the same name. They cannot
 * tell what it is.
 * @param {Buffer} key A 64-byte key (32 for the MAC half, 32 for the CTR half)
 * @param {Buffer[]} associated Associated data, in order. The last item is the "nonce" slot in the RFC.
 * @param {Buffer} plaintext The plaintext
 * @returns {Buffer} The synthetic IV followed by the ciphertext
 */
export function sivEncrypt(key, associated, plaintext) {
    if (key.length !== 64 && key.length !== 32) {
        throw new Error(`AES-SIV needs a 32- or 64-byte key; got ${key.length}.`);
    }

    const half = key.length / 2;
    const macKey = key.subarray(0, half);
    const ctrKey = key.subarray(half);

    const v = s2v(macKey, associated, plaintext);
    const algorithm = ctrKey.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr';
    const cipher = crypto.createCipheriv(algorithm, ctrKey, counterFromIv(v));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return Buffer.concat([v, ciphertext]);
}

/**
 * Decrypt, and authenticate.
 *
 * 🔴 The authentication is the whole reason to use SIV rather than bare CTR: the synthetic IV is
 * recomputed from the DECRYPTED plaintext and compared against the one on the wire, in constant time.
 * If a single byte of the ciphertext, the IV, or the associated data has been touched, they will not
 * match and this throws. A filename that fails to authenticate is a filename an attacker wrote.
 * @param {Buffer} key A 64-byte key
 * @param {Buffer[]} associated Associated data, in the same order used to encrypt
 * @param {Buffer} sealed The synthetic IV followed by the ciphertext
 * @returns {Buffer} The plaintext
 */
export function sivDecrypt(key, associated, sealed) {
    // 🔴 THE SAME CHECK `sivEncrypt` MAKES, AND IT WAS MISSING HERE — WHICH TURNED A CALLER'S BUG INTO AN
    // ACCUSATION OF TAMPERING.
    //
    // Without it a wrong-length key is not rejected; it is SPLIT. A 48-byte key yields a 24-byte MAC half
    // and a 24-byte CTR half, `createDecipheriv` is handed a key length AES does not have, and if it does
    // not throw first the synthetic IV simply fails to match. The message the caller then reads is "the data
    // has been tampered with, or the key is wrong" — which sends whoever is holding it to look at the disk,
    // at their backups, and at an attacker, when what is actually wrong is the key they passed in.
    //
    // The asymmetry was never a decision. `sivEncrypt` grew the guard when a caller got a length wrong on
    // the way in; nothing had yet got one wrong on the way out.
    if (key.length !== 64 && key.length !== 32) {
        throw new Error(`AES-SIV needs a 32- or 64-byte key; got ${key.length}.`);
    }

    if (sealed.length < BLOCK_SIZE) {
        throw new Error('AES-SIV: ciphertext is too short to contain a synthetic IV.');
    }

    const half = key.length / 2;
    const macKey = key.subarray(0, half);
    const ctrKey = key.subarray(half);

    const v = sealed.subarray(0, BLOCK_SIZE);
    const ciphertext = sealed.subarray(BLOCK_SIZE);

    const algorithm = ctrKey.length === 32 ? 'aes-256-ctr' : 'aes-128-ctr';
    const decipher = crypto.createDecipheriv(algorithm, ctrKey, counterFromIv(v));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const expected = s2v(macKey, associated, plaintext);

    // Constant time. A comparison that returns early leaks, one byte at a time, how much of a forged
    // tag was right — which is enough to forge the rest.
    if (!crypto.timingSafeEqual(expected, v)) {
        throw new Error('AES-SIV: authentication failed. The data has been tampered with, or the key is wrong.');
    }

    return plaintext;
}
