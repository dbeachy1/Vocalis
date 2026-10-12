import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import { argon2id } from './argon2.js';
import { sensitive } from '../logging.js';

/**
 * Derive a password KEK with Argon2id and independent data subkeys with HKDF.
 * This module operates on supplied bytes and parameters; vault record access stays in vault.js.
 */

/**
 * Current Argon2id defaults. Tune memory cost against expected concurrent logins; swapping adds latency
 * without improving password resistance.
 */

export const ARGON2_MEMORY_KIB = 256 * 1024;
export const ARGON2_ITERATIONS = 3;
export const ARGON2_PARALLELISM = 4;

const KEK_LENGTH = 32;

/**
 * Return the defaults used for new vaults and for legacy records without stored KDF parameters.
 * @returns {{algorithm: string, memoryKiB: number, iterations: number, parallelism: number}} Current defaults
 */

export function currentKdfParameters() {

    return {

        algorithm: 'argon2id',

        memoryKiB: ARGON2_MEMORY_KIB,

        iterations: ARGON2_ITERATIONS,

        parallelism: ARGON2_PARALLELISM,

    };

}

/**
 * Derive the key-encryption key from a password using the parameters recorded for this vault.
 * Legacy vaults without `kdf` metadata use the current defaults.
 * @param {string} password The user's login password
 * @param {Buffer} salt The KEK salt, stored in the vault-keys file
 * @param {{memoryKiB: number, iterations: number, parallelism: number}} [parameters] Stored parameters; omitted for legacy records
 * @returns {Promise<Buffer>} A 32-byte KEK
 */

export async function deriveKek(password, salt, parameters = undefined) {

    const kdf = parameters ?? currentKdfParameters();



    return await argon2id({

        password: password.normalize(),

        salt,

        parallelism: sane(kdf.parallelism, ARGON2_PARALLELISM, 1, 16, 'parallelism'),

        iterations: sane(kdf.iterations, ARGON2_ITERATIONS, 1, 32, 'iterations'),

        memoryKiB: sane(kdf.memoryKiB, ARGON2_MEMORY_KIB, 8, 2 * 1024 * 1024, 'memoryKiB'),

        hashLength: KEK_LENGTH,

    });

}


/**
 * Bound Argon2 parameters read from unauthenticated `.vault-keys.json` metadata to prevent excessive
 * allocation or login time. Invalid values fall back to defaults; a mismatched derived key still fails
 * authenticated unwrap. If another KDF is added, validate `kdf.algorithm` before dispatching on it.
 * @param {unknown} value What the record claims
 * @param {number} fallback What to use when the claim is not usable
 * @param {number} low Smallest value that is neither an attack nor a mistake
 * @param {number} high Largest ditto
 * @param {string} field The field name, for the warning
 * @returns {number} A number that is safe to hand to argon2
 */
function sane(value, fallback, low, high, field) {
    if (value === undefined || value === null) {
        return fallback;
    }

    if (!Number.isInteger(value) || value < low || value > high) {
        // SENSITIVE: the offending value is attacker-supplied, and a warning about it names one account.
        sensitive().warn(
            `[vault] ignoring an out-of-range argon2 '${field}' in a vault-keys record; using the default. ` +
            `Expected an integer in [${low}, ${high}].`,
        );

        return fallback;
    }

    return value;
}

/**
 * Derive independent subkeys with separate HKDF `info` labels. The keys are re-derived from the DEK
 * on unlock rather than stored in the vault.
 * @param {Buffer} dek The data-encryption key
 * @returns {{kContent: Buffer, kNames: Buffer, kCache: Buffer, kCacheNames: Buffer}} The subkeys
 */

export function deriveSubkeys(dek) {

    // These HKDF `info` labels are persisted-format contracts: changing one prevents existing data
    // from deriving the same key. New labels can be added without changing existing labels.

    return {

        // AES-256-GCM.

        kContent: Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), 'sillytavern-encrypted-storage:content:v1', 32)),

        // AES-SIV takes a double-length key: 32 bytes to authenticate, 32 to encrypt.

        kNames: Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), 'sillytavern-encrypted-storage:names:v1', 64)),

        // The key/value store (node-persist), which writes its own bytes with its own `fs` calls and never

        // passes through the provider at all. Its own key, because it is its own domain.

        kCache: Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), 'sillytavern-encrypted-storage:keyvalue:v1', 32)),

        // And the NAMES of that store's files, which node-persist derives by hashing the key — and the key

        // is a plaintext path. An unkeyed hash is a confirmation oracle; a keyed one is not. Separate from

        // kCache because it is used with a different primitive (HMAC, not AES-GCM), and mixing primitives

        // under one key is exactly the shortcut this design does not take anywhere else.

        kCacheNames: Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), 'sillytavern-encrypted-storage:keyvalue-names:v1', 32)),

    };

}

/**
 * Derive a caller-namespaced subkey without exposing the DEK. Prefixing the caller label prevents it
 * from colliding with the built-in key labels.
 * @param {Buffer} dek The data-encryption key
 * @param {string} info The caller's label; distinct labels derive independent keys
 * @param {number} length Requested output length in bytes
 * @returns {Buffer} The derived key
 */

export function deriveSubkey(dek, info, length) {

    // Persisted plugin keys depend on this prefix; changing it prevents existing stores from reopening.

    return Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), `sillytavern-encrypted-storage:plugin:${info}`, length));

}

/**

 * Turn a recovery key into a wrapping key.

 * @param {Buffer} recoveryKey The raw 32-byte recovery key

 * @returns {Buffer} A 32-byte wrapping key

 */

export function deriveRecoveryWrappingKey(recoveryKey) {

    // Persisted recovery keys depend on this label; changing it would make them unusable.

    return Buffer.from(crypto.hkdfSync('sha256', recoveryKey, Buffer.alloc(0), 'sillytavern-encrypted-storage:recovery:v1', 32));

}
