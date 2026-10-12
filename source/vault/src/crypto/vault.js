import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import { deriveKek, deriveRecoveryWrappingKey, currentKdfParameters } from './kdf.js';
import { formatRecoveryKey, parseRecoveryKey, RECOVERY_KEY_BYTES } from '../recovery-key.js';
import { NAME_SCHEME_MIXED } from '../name-scheme.js';

/**
 * Manages the per-account DEK. SillyTavern's stored password verifier is independent of this key hierarchy:
 * a fresh argon2id salt derives the KEK, which wraps the DEK. A recovery key provides a second wrap. The
 * unwrapped DEK exists in memory only after successful login; KDF policy and recovery-key encoding live in
 * `kdf.js` and `recovery-key.js`.
 */


const DEK_LENGTH = 32;
const SALT_LENGTH = 16;
const GCM_NONCE_LENGTH = 12;






/**
 * Wrap the DEK under a key.
 * @param {Buffer} wrappingKey The KEK, or a key derived from the recovery key
 * @param {Buffer} dek The DEK to wrap
 * @returns {string} The wrapped blob, base64
 */
function wrap(wrappingKey, dek) {
    const nonce = crypto.randomBytes(GCM_NONCE_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce);
    const sealed = Buffer.concat([cipher.update(dek), cipher.final()]);

    return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString('base64');
}

/**
 * Unwrap the DEK.
 * @param {Buffer} wrappingKey The key to unwrap with
 * @param {string} wrapped The wrapped blob, base64
 * @returns {Buffer} The DEK
 */
function unwrap(wrappingKey, wrapped) {
    const blob = Buffer.from(wrapped, 'base64');
    const nonce = blob.subarray(0, GCM_NONCE_LENGTH);
    const tag = blob.subarray(blob.length - 16);
    const body = blob.subarray(GCM_NONCE_LENGTH, blob.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, nonce);
    decipher.setAuthTag(tag);

    // Authentication failure rejects an incorrect wrapping key without storing a password comparison value.
    return Buffer.concat([decipher.update(body), decipher.final()]);
}




/**
 * The on-disk key file. `<DATA_ROOT>/<handle>/.vault-keys.json`, mode 0600.
 *
 * Plaintext metadata containing salts and wrapped keys. The provider must leave this file readable; losing
 * it makes the account's ciphertext unrecoverable, even with the password.
 *
 * @typedef {object} VaultKeys
 * @property {number} version The format version
 * @property {number} [nameScheme] How this account's filenames are encoded. See `crypto/name-cipher.js`.
 * @property {string} salt_kek Base64. The argon2id salt. Fresh per vault, and NOT ST's password salt.
 * @property {string} wrap_password Base64. The DEK, wrapped under argon2id(password).
 * @property {string} wrap_recovery Base64. The same DEK, wrapped under the recovery key.
 * @property {boolean} [recovery_acknowledged] Has the user confirmed they wrote the recovery key down?
 * @property {object} kdf The argon2id parameters, recorded so a future change does not lock anyone out.
 */

/**
 * Create a brand-new vault: a fresh DEK, wrapped twice.
 * @param {string} password The user's login password
 * @returns {Promise<{keys: VaultKeys, dek: Buffer, recoveryKey: string}>} The new vault
 */
export async function createVault(password) {
    const dek = crypto.randomBytes(DEK_LENGTH);
    const saltKek = crypto.randomBytes(SALT_LENGTH);

    const kek = await deriveKek(password, saltKek);

    const keys = {
        // Bump the format version with the name scheme so older builds reject the record instead of
        // silently interpreting mixed-mode accounts as scheme 1.
        version: 2,
        nameScheme: NAME_SCHEME_MIXED,
        salt_kek: saltKek.toString('base64'),
        wrap_password: wrap(kek, dek),
        // mintRecoveryKey fills this before the vault is persisted.
        wrap_recovery: '',
        recovery_acknowledged: false,
        kdf: currentKdfParameters(),
    };

    // The KEK has done its one job (wrapping the DEK above) and must not outlive it — see the note in
    // `unlockWithPassword`. The DEK deliberately survives: the caller is about to put it in a session.
    kek.fill(0);

    return { ...mintRecoveryKey(keys, dek), dek };
}

/**
 * Mint and wrap a recovery key while the DEK is available. The key itself is returned once and never stored;
 * callers can retry on a later login until it is acknowledged. Each mint replaces the prior recovery wrap,
 * while leaving the password wrap and encrypted data unchanged.
 * @param {VaultKeys} keys The current vault-keys file
 * @param {Buffer} dek The DEK, already unwrapped — i.e. the caller has proved they are allowed to do this
 * @returns {{keys: VaultKeys, recoveryKey: string}} The updated keys, and the key to show the user ONCE
 */
export function mintRecoveryKey(keys, dek) {
    const recoveryKeyBytes = crypto.randomBytes(RECOVERY_KEY_BYTES);
    const wrappingKey = deriveRecoveryWrappingKey(recoveryKeyBytes);

    try {
        return {
            keys: {
                ...keys,
                wrap_recovery: wrap(wrappingKey, dek),
                // A brand-new key nobody has seen yet. It stays false until the user says otherwise.
                recovery_acknowledged: false,
            },
            recoveryKey: formatRecoveryKey(recoveryKeyBytes),
        };
    } finally {
        // Clear wipeable key material; the formatted string must remain available for display.
        recoveryKeyBytes.fill(0);
        wrappingKey.fill(0);
    }
}

/**
 * Unlock with the password. This is the normal path, and it runs on every login.
 * @param {VaultKeys} keys The vault-keys file
 * @param {string} password The password
 * @returns {Promise<Buffer>} The DEK
 */
export async function unlockWithPassword(keys, password) {
    // `keys.kdf`, not the module constants. A vault is opened with what it was built with — see `deriveKek`.
    const kek = await deriveKek(password, Buffer.from(keys.salt_kek, 'base64'), keys.kdf);

    // Wipe the KEK after both successful and failed unwrap attempts.
    try {
        return unwrap(kek, keys.wrap_password);
    } catch {
        // Keep authentication failures indistinguishable to callers.
        throw new Error('Could not unlock the vault: wrong password.');
    } finally {
        kek.fill(0);
    }
}

/**
 * Unlock with the recovery key. The single path back in.
 * @param {VaultKeys} keys The vault-keys file
 * @param {string} recoveryKey The recovery key, as typed by a human
 * @returns {Promise<Buffer>} The DEK
 */
export async function unlockWithRecoveryKey(keys, recoveryKey) {
    const wrappingKey = deriveRecoveryWrappingKey(parseRecoveryKey(recoveryKey));

    try {
        return unwrap(wrappingKey, keys.wrap_recovery);
    } catch {
        throw new Error('Could not unlock the vault: wrong recovery key.');
    }
}

/**
 * Rewrap the existing DEK with a new password-derived key. Data and the recovery wrap remain unchanged.
 * @param {VaultKeys} keys The current vault-keys file
 * @param {Buffer} dek The DEK, already unwrapped (i.e. the caller has proved they may do this)
 * @param {string} newPassword The new password
 * @returns {Promise<VaultKeys>} The updated vault-keys file
 */
export async function rewrapPassword(keys, dek, newPassword) {
    // A fresh salt on every password change. Reusing the old one would let an attacker who captured an
    // old vault-keys file reuse precomputed work against the new one.
    const saltKek = crypto.randomBytes(SALT_LENGTH);

    // Store the salt and KDF parameters with the matching new wrap so future unlocks use the same settings.
    const kdf = currentKdfParameters();
    const kek = await deriveKek(newPassword, saltKek, kdf);

    try {
        return {
            ...keys,
            salt_kek: saltKek.toString('base64'),
            wrap_password: wrap(kek, dek),
            kdf,
        };
    } finally {
        // The third and last KEK site. See `unlockWithPassword`.
        kek.fill(0);
    }
}

/** Re-export the split helpers to preserve existing import paths. */
export { deriveKek, deriveSubkey, deriveSubkeys, currentKdfParameters, ARGON2_MEMORY_KIB, ARGON2_ITERATIONS, ARGON2_PARALLELISM } from './kdf.js';
export { formatRecoveryKey, parseRecoveryKey } from '../recovery-key.js';
