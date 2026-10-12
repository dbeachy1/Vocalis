import crypto from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';

/**
 * Use Node's built-in Argon2id so key derivation does not trust third-party code.
 * Node 24 or newer is required; no fallback implementation is used.
 */

/**
 * Require Node 24 or newer.
 *
 * The import-time guard prevents an unsupported runtime from starting maintenance or accepting logins.
 */
if (typeof crypto.argon2 !== 'function') {
    throw new Error(
        `This plugin requires Node 24 or newer, and this is ${process.version}.\n\n` +
        'It derives its key with argon2id, which Node 24 provides in core. Older versions do not have it,\n' +
        'and taking a third-party package to derive the key that unwraps every chat would undo the point of\n' +
        'the exercise: the threat this plugin exists to stop IS a poisoned dependency.\n\n' +
        'SillyTavern itself tests only on Node 24 and ships a Node 24 container, so this is also the runtime\n' +
        'it is actually validated against.',
    );
}

/**
 * Derive a key with argon2id.
 * @param {object} options The parameters
 * @param {string} options.password The password, already normalized by the caller
 * @param {Buffer} options.salt The salt
 * @param {number} options.parallelism Lanes
 * @param {number} options.iterations Passes
 * @param {number} options.memoryKiB Memory cost, in KiB
 * @param {number} options.hashLength Output length in bytes
 * @returns {Promise<Buffer>} The derived key
 */
export async function argon2id({ password, salt, parallelism, iterations, memoryKiB, hashLength }) {
    // Use the asynchronous API so password attempts do not block the server event loop. This introduces
    // a suspension point in lifecycle operations; vault-store.js serializes key-file updates.
    return await new Promise((resolve, reject) => {
        crypto.argon2('argon2id', {
            message: Buffer.from(password, 'utf-8'),
            nonce: salt,
            parallelism,
            passes: iterations,
            memory: memoryKiB,
            tagLength: hashLength,
        }, (error, tag) => {
            if (error) {
                reject(error);
                return;
            }

            resolve(Buffer.from(tag));
        });
    });
}
