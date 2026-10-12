import fs from 'node:fs';
import path from 'node:path';

import {
    createVault,
    mintRecoveryKey,
    rewrapPassword,
    unlockWithPassword,
    unlockWithRecoveryKey,
} from './crypto/vault.js';
import * as paths from './paths.js';
import * as session from './session.js';
import { adoptLogger, normal, sensitive } from './logging.js';
import { assertPasswordCanKey, assertUsable } from './preconditions.js';
import { hasVault, readVaultKeys, writeVaultKeys } from './vault-store.js';
import { flushForeignStores } from './foreign-stores.js';
import { isOurEnvelope, MAX_HEADER_BYTES } from './envelope.js';

/**
 * Owns vault unlock and password-change flows. The DEK is unwrapped into the in-memory session by a password
 * or recovery key; disk access alone never reveals it.
 */


// The data root lives on the provider's state now -- see `vault-state.js`.

/** Per-provider keys waiting to be shown; see `vault-state.js`. */

/**
 * Boot.
 * @param {import('./types.js').StorageProviderContext} context The boot context
 * @returns {void}
 */
export function init(vault, context) {
    // Install the provider logger before any initialization can emit diagnostics.
    adoptLogger(context);

    // Reject configurations that cannot enforce the vault's lock requirements.
    assertUsable(context);

    vault.dataRoot = path.resolve(context.dataRoot);

    // Use the host's account list; directory names can also be global files such as content.log.
    paths.rememberHandles(vault, context.users);

    // Apply earlier plugin registrations now that the data root is known.
    flushForeignStores(vault);
}

/**
 * The data root being served.
 * @returns {string} The data root
 */
export function getDataRoot(vault) {
    return vault.dataRoot;
}

/**
 * Does this account have a vault -- that is, is its data encrypted under a password?
 *
 * This is what the fork asks before it will allow a blind password reset. A `true` here means resetting
 * this user's password without their old one would orphan their data forever.
 * @param {string} handle The user handle
 * @returns {boolean} True if the account is encrypted
 */
export function ownsUser(vault, handle) {
    return hasVault(vault.dataRoot, handle);
}

/**
 * Is this user's data servable right now?
 * @param {string} handle The user handle
 * @returns {boolean} True if the DEK is in memory
 */
export function isReady(vault, handle) {
    return session.isOpen(vault, handle);
}

/**
 * Open the account vault with the verified login password, creating one for a new account. Any recovery key
 * remains pending until {@link acknowledgeRecoveryKey} confirms the user saved it.
 * @param {string} handle The user handle
 * @param {string} password The password just verified by SillyTavern
 * @returns {Promise<void>}
 */
export async function unlock(vault, handle, password) {
    // Serialize the vault-key read/modify/write across asynchronous KDF work.
    return await withKeyFileLock(vault, handle, () => unlockUnderLock(vault, handle, password));
}

/** @see unlock */
async function unlockUnderLock(vault, handle, password) {
    // Recheck here because accounts can be created after the boot-time validation.
    assertPasswordCanKey(password, 'The password that opens your vault');

    const existing = readVaultKeys(vault.dataRoot, handle);

    if (!existing) {
        await createVaultFor(vault, handle, password);
        return;
    }

    // A wrong password must not create or overwrite the vault.
    const dek = await unlockWithPassword(existing, password);
    session.open(vault, handle, dek);

    ensureRecoveryKeyIsAcknowledged(vault, handle, existing, dek);
}

/**
 * Reissue a recovery key on login until the user acknowledges saving it. Persist its wrap before exposing
 * the key, so a displayed key always opens the stored vault.
 * @param {string} handle The user handle
 * @param {import('./crypto/vault.js').VaultKeys} keys Their current vault keys
 * @param {Buffer} dek The DEK, just unwrapped
 * @returns {void}
 */
function ensureRecoveryKeyIsAcknowledged(vault, handle, keys, dek) {
    if (keys.recovery_acknowledged === true) {
        return;
    }

    const { keys: updated, recoveryKey } = mintRecoveryKey(keys, dek);

    try {
        writeVaultKeys(vault, handle, updated);
    } catch (error) {
        // Keep login available, but do not expose an unpersisted key. Log the account and error separately
        // so normal logs report the failure without exposing user-authored identifiers or paths.
        normal().error(
            'Could not write a new recovery key for an account. That account is UNRECOVERABLE if the user ' +
            'forgets their password. This will be retried at their next login. ' +
            'Enable logging.debugMode to see which account, and why.',
        );

        // Pass the Error object so the logging seam can retain a safe error code when details are suppressed.
        sensitive().error('Recovery key write failed for', handle, error);
        return;
    }

    vault.recoveryKeys.set(handle, recoveryKey);
}

/**
 * Turn encryption on for an account that does not have it yet.
 * @param {string} handle The user handle
 * @param {string} password The password
 * @returns {Promise<void>}
 */
async function createVaultFor(vault, handle, password) {
    // Mixed mode preserves existing plaintext and encrypts new files, so account creation can proceed when
    // legacy content exists.
    const existingData = listUserContent(vault, handle);

    // A missing keys file with existing ciphertext indicates a lost key file, not a new account. Refuse to
    // create a replacement DEK: it cannot decrypt the existing data and would make the account appear empty.
    const encrypted = existingData.filter(relative => carriesOurEnvelope(paths.userRoot(vault.dataRoot, handle, relative)));

    if (encrypted.length > 0) {
        throw new Error(
            'REFUSING TO CREATE A VAULT HERE. This account has no .vault-keys.json, but it does contain ' +
            `${encrypted.length} file(s) that this plugin encrypted. The key file has been LOST, not never ` +
            'created -- and without it those files cannot be decrypted by anything, including a new vault.\n\n' +
            'Creating one now would make the situation permanently worse: the existing ciphertext would be ' +
            'treated as somebody else\'s plaintext, handed to SillyTavern unreadable, and regenerated from ' +
            'nothing.\n\n' +
            'Restore .vault-keys.json for this account from a backup. It is a DOTFILE, so `cp -r dir/*` and ' +
            'file managers with hidden files turned off both skip it -- check whether that is what happened.',
        );
    }

    const { keys, dek, recoveryKey } = await createVault(password);

    // Record only whether legacy plaintext exists. verify uses this bit to distinguish expected legacy files
    // from leaks; storing paths here would expose chat and character names in the plaintext key file.
    keys.legacyData = existingData.length > 0;

    if (keys.legacyData) {
        // Keep counts in normal logs and account handles in the sensitive channel.
        normal().info(`[vault] an account had ${existingData.length} file(s) before encryption was turned on. Those stay readable and unencrypted, for ever. Everything from now on is encrypted. Enable logging.debugMode to see which account.`);
        sensitive().info('[vault] the account with legacy plaintext data is', handle);
    }

    writeVaultKeys(vault, handle, keys);
    session.open(vault, handle, dek);

    // Keep the key only until the caller collects it for display.
    vault.recoveryKeys.set(handle, recoveryKey);
}

/**
 * Does the file at this path begin with OUR envelope?
 *
 * Reads only the header window, never the body — `isOurEnvelope` is documented as a prefix check that must
 * never become a decrypt, and this is called once per file in an account directory.
 *
 * Unreadable, vanished, or a directory all answer "no": the caller is deciding whether to REFUSE, so the
 * only answer that matters is a positive identification of our own ciphertext.
 * @param {string} absolutePath The file to look at
 * @returns {boolean} True if these are bytes this plugin wrote
 */
function carriesOurEnvelope(absolutePath) {
    let fd;

    try {
        fd = fs.openSync(absolutePath, 'r');

        const window = Buffer.alloc(MAX_HEADER_BYTES);
        const read = fs.readSync(fd, window, 0, MAX_HEADER_BYTES, 0);

        return isOurEnvelope(window.subarray(0, read));
    } catch {
        return false;
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}

/**
 * What is already in this user's directory, ignoring the things SillyTavern creates empty at boot?
 * @param {string} handle The user handle
 * @returns {string[]} Relative paths of real content
 */
function listUserContent(vault, handle) {
    const root = paths.userRoot(vault.dataRoot, handle);

    if (!fs.existsSync(root)) {
        return [];
    }

    /** @type {string[]} */
    const found = [];

    /**
     * @param {string} directory Directory to walk
     * @param {string} prefix Path prefix for reporting
     * @returns {void}
     */
    function walk(directory, prefix) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                walk(path.join(directory, entry.name), relative);
                continue;
            }

            // SillyTavern writes these itself, at boot, for a brand-new empty account. They are not data,
            // and treating them as data would make a fresh install impossible to encrypt.
            if (entry.name === '.vault-keys.json' || entry.name === 'settings.json' || entry.name === 'stats.json' || entry.name === 'secrets.json') {
                continue;
            }

            found.push(relative);
        }
    }

    walk(root, '');
    return found;
}

/**
 * Shut a vault. The keys are wiped.
 * @param {string} handle The user handle
 * @returns {void}
 */
export function lock(vault, handle) {
    session.close(vault, handle);

    // An unshown recovery key is a secret, and a secret belonging to a user whose vault is SHUT has no
    // business sitting in this process's memory. Dropping it costs nothing: it was never acknowledged, so
    // the next login mints another one and asks again.
    vault.recoveryKeys.delete(handle);
}

/**
 * Change the password by rewrapping the existing DEK; encrypted data and the recovery wrap stay unchanged.
 * Require the old password even for an open session: session state proves the vault is unlocked, not that the
 * caller knows the credential. Without that proof, a temporary session could set a password it controls and
 * gain lasting access. Refuse the host's password change if the DEK cannot be unwrapped.
 * @param {string} handle The user handle
 * @param {string|null} oldPassword The current password. REQUIRED, even when the vault is open.
 * @param {string} newPassword The new password
 * @returns {Promise<void>}
 */
export async function rekey(vault, handle, oldPassword, newPassword) {
    // Serialised per account -- see `withKeyFileLock`. This wrapper exists because argon2 now suspends
    // in the middle of this function's read-modify-write of the vault-keys file.
    return await withKeyFileLock(vault, handle, () => rekeyUnderLock(vault, handle, oldPassword, newPassword));
}

/** @see rekey */
async function rekeyUnderLock(vault, handle, oldPassword, newPassword) {
    const keys = readVaultKeys(vault.dataRoot, handle);

    if (!keys) {
        // No vault: nothing is keyed from this password, so there is nothing to orphan and nothing to do.
        return;
    }


    assertPasswordCanKey(newPassword, 'Your new password');

    // Rewrapping with the same password would report success without rotating the credential.
    if (oldPassword && oldPassword === newPassword) {
        throw new Error('Your new password must be different from your current one.');
    }

    // An open session is not proof of the old password; unwrap the DEK with that credential.
    const dek = await unlockWithPassword(keys, requireOldPassword(handle, oldPassword));

    const updated = await rewrapPassword(keys, dek, newPassword);
    writeVaultKeys(vault, handle, updated);

    // The password changed; the key did not. Keep the session open -- the user is standing right there.
    session.open(vault, handle, dek);
}

/**
 * @param {string} handle The user handle
 * @param {string|null} oldPassword The old password, maybe
 * @returns {string} The old password
 */
function requireOldPassword(handle, oldPassword) {
    if (!oldPassword) {
        // The host displays this refusal verbatim; distinguish a missing password from a failed unlock.
        throw new Error('Enter your current password to change it. It is what unwraps your data, so it cannot be changed without it -- being signed in is not enough, because that proves the vault is open, not who opened it.');
    }

    return oldPassword;
}

/**
 * The way back in from a forgotten password.
 *
 * The recovery key reaches the SAME DEK by the other wrap. So this re-wraps under the new password and
 * opens the vault: the account is recovered and the data is recovered, in one step, because under
 * encryption they were never two different things.
 *
 * Nothing is re-encrypted, so it is instant whether the account holds one chat or fifty gigabytes.
 * @param {string} handle The user handle
 * @param {string} recoveryKey The recovery key, as it was printed
 * @param {string} newPassword The new password
 * @returns {Promise<void>}
 */
export async function recover(vault, handle, recoveryKey, newPassword) {
    // Serialised per account -- see `withKeyFileLock`. This wrapper exists because argon2 now suspends
    // in the middle of this function's read-modify-write of the vault-keys file.
    return await withKeyFileLock(vault, handle, () => recoverUnderLock(vault, handle, recoveryKey, newPassword));
}

/** @see recover */
async function recoverUnderLock(vault, handle, recoveryKey, newPassword) {
    const keys = readVaultKeys(vault.dataRoot, handle);

    if (!keys) {
        // 🔴 NO HANDLE IN THE MESSAGE -- the rule `preconditions.js` states for itself and these three broke.
        // An Error travels: the fork RENDERS it to the user verbatim, and logs it wherever it likes, outside
        // the NORMAL/SENSITIVE seam entirely. The user reading this knows their own handle, so it adds
        // nothing to them and everything to a log file. (RECOVER [drive:][path]filename is also a PRE-AUTH flow by definition --
        // you are there because you forgot your password -- so naming which handles exist was an oracle for
        // free.)
        throw new Error('This account has no vault, so there is nothing to recover.');
    }


    assertPasswordCanKey(newPassword, 'Your new password');

    // Verify the recovery key before changing the password or writing the new wrap.
    const dek = await unlockWithRecoveryKey(keys, recoveryKey);

    const updated = await rewrapPassword(keys, dek, newPassword);
    writeVaultKeys(vault, handle, updated);

    // They proved ownership. They are in.
    session.open(vault, handle, dek);
}

/**
 * Return the unacknowledged recovery key without consuming it. Only {@link acknowledgeRecoveryKey} clears it.
 * @param {string} handle The user handle
 * @returns {string|null} The recovery key, or null if there is not one waiting
 */
export function pendingRecoveryKey(vault, handle) {
    return vault.recoveryKeys.get(handle) ?? null;
}

/**
 * Replace the recovery key after verifying the password, even for an open session. Session access alone must
 * not let a caller obtain a key that grants lasting access. Persist the replacement wrap before returning the
 * new key; this invalidates the previous recovery key.
 * @param {string} handle The user handle
 * @param {string} password Their CURRENT password. Proof of identity, not a formality.
 * @returns {Promise<void>}
 */
export async function regenerateRecoveryKey(vault, handle, password) {
    // Serialised per account -- see `withKeyFileLock`. This wrapper exists because argon2 now suspends
    // in the middle of this function's read-modify-write of the vault-keys file.
    return await withKeyFileLock(vault, handle, () => regenerateRecoveryKeyUnderLock(vault, handle, password));
}

/** @see regenerateRecoveryKey */
async function regenerateRecoveryKeyUnderLock(vault, handle, password) {
    const keys = readVaultKeys(vault.dataRoot, handle);

    if (!keys) {
        throw new Error('This account has no vault, so there is no recovery key to replace.');
    }

    // ⚠️ NOT the empty-password rule, and deliberately not routed through
    // `assertPasswordCanKey`. That rule is about a password too weak to KEY anything. This one is about
    // PROOF: minting a recovery key needs only the DEK, which is already in RAM while the user is signed
    // in, so a version of this that trusted the session would be a one-click key-exfiltration button.
    // Different question, different answer, its own sentence.
    if (!password) {
        throw new Error('Enter your current password. A new recovery key opens your account for ever, so we have to know it is you.');
    }

    // 🔴 The proof. This throws on a wrong password, and it does NOT consult the session — being signed in
    // is not knowing the password, and that distinction is the only thing standing between this button and
    // a key-theft button.
    const dek = await unlockWithPassword(keys, password);

    // 🔴 THIS DEK IS NOT THE SESSION'S DEK, SO NOTHING ELSE WILL EVER WIPE IT.
    //
    // `unlockWithPassword` returns a FRESH Buffer. It is never handed to `session.open`, so it is not in
    // `vault.sessions`, so `session.close()` — which iterates the record and zeroes every Buffer in it —
    // has no reference to it and never can. It was simply dropped, and it survived in the heap for the life
    // of the process.
    //
    // The irony is the point: this is the "I think my recovery key leaked" button. The one operation a user
    // performs BECAUSE they fear compromise was the one that left a permanent master-key copy behind.
    //
    // `finally`, so the mint and the write throwing does not skip it.
    try {
        const { keys: updated, recoveryKey } = mintRecoveryKey(keys, dek);

        // The new key has not been seen by a human yet, so the account is once again in the state where it
        // has a recovery wrap nobody can open. Re-arm the nag: it is now unacknowledged, and it stays that
        // way until the user says otherwise.
        writeVaultKeys(vault, handle, { ...updated, recovery_acknowledged: false });

        // Only now. If the write above threw, we never get here, and the OLD key is still on the disk and
        // still works — nothing is lost and nothing has silently changed underneath the user.
        vault.recoveryKeys.set(handle, recoveryKey);
    } finally {
        dek.fill(0);
    }
}

/**
 * The user says they have written their recovery key down. Stop asking.
 *
 * 🔴 This is the ONLY thing that stops the nag, and it is deliberately the user's own assertion rather than
 * anything the server can infer. "We rendered it" is not evidence that a human read it, and this is the one
 * fact in the system that cannot be reconstructed from the disk if we get it wrong.
 * @param {string} handle The user handle
 * @returns {void}
 */
export function acknowledgeRecoveryKey(vault, handle) {
    const keys = readVaultKeys(vault.dataRoot, handle);

    if (!keys) {
        throw new Error('This account has no vault, so there is no recovery key to acknowledge.');
    }

    // Whatever is still pending is now the user's problem, on paper. Drop our copy.
    vault.recoveryKeys.delete(handle);

    writeVaultKeys(vault, handle, { ...keys, recovery_acknowledged: true });
}

/**
 * Serialise everything that read-modify-writes one account's vault-keys file.
 *
 * 🔴 THESE RACES WERE REAL ALL ALONG AND UNREACHABLE BY ACCIDENT. THE ACCIDENT IS NOW OVER.
 *
 * Every entry point below has the same shape: read the whole keys record, do slow work, write back a spread
 * of the snapshot it read. That is a lost update waiting to happen, and until now it could not happen —
 * every `await` in this file resolved synchronously, because all the I/O is `fs.*Sync` and `argon2id`
 * wrapped `crypto.argon2Sync`. An entire `unlock`/`rekey`/`recover` ran start-to-finish in one uninterrupted
 * macrotask, so no second request could get between the read and the write.
 *
 * Moving argon2 off the main thread — which had to happen, because a 143 ms synchronous stall on every
 * login and every FAILED login is a free denial of service — deletes that guarantee. The suspension is now
 * ~143 ms wide, in the exact middle of every one of these sequences, which is an enormous window.
 *
 * What it would cost, concretely:
 *
 *   - `unlock` suspends holding a snapshot; a password change completes; `unlock`'s write-back of
 *     `wrap_recovery` carries the STALE `salt_kek` and `wrap_password` with it, silently reverting the
 *     change. The user's new password stops working and the old one starts working again.
 *   - `rekey` completes across a concurrent `regenerateRecoveryKey` and reverts `wrap_recovery` —
 *     invalidating a recovery key the user has just been shown and has written down on paper. That is the
 *     "worse than having no recovery key at all" state this file is built to prevent.
 *
 * The fix is a per-handle queue, not a global one: two different accounts have no shared state and must not
 * wait on each other's 143 ms. Chaining onto the previous tail is enough because JS is single-threaded — the
 * read cannot be interleaved with anything except at an `await`, and every `await` for this handle is now
 * inside the chain.
 *
 * The chain is deliberately kept alive by `finally` regardless of outcome, so one rejected operation does
 * not wedge the account, and the map entry is deleted when this call is the last one out so a long-lived
 * process does not accumulate an entry per account that ever logged in.
 * @param {import('./vault-state.js').VaultState} vault The provider's state
 * @param {string} handle The account whose keys file is about to be read and written
 * @param {() => Promise<any>} operation The read-modify-write to run alone
 * @returns {Promise<any>} Whatever the operation returned
 */
async function withKeyFileLock(vault, handle, operation) {
    const previous = vault.keyFileLocks.get(handle) ?? Promise.resolve();

    // `.catch()` rather than `await previous`: this call must run after the last one FINISHES, but must not
    // inherit its failure. Without it, one wrong password would reject every queued operation behind it.
    const mine = previous.catch(() => {}).then(operation);

    // The TAIL is the swallowed form, and the comparison below must be against that same object -- comparing
    // against `mine` would never match, so the entry would never be cleared.
    const tail = mine.catch(() => {});

    vault.keyFileLocks.set(handle, tail);

    try {
        return await mine;
    } finally {
        // Only if nobody queued behind me. If they did, the entry is theirs and clearing it would let the
        // next arrival skip the queue entirely.
        if (vault.keyFileLocks.get(handle) === tail) {
            vault.keyFileLocks.delete(handle);
        }
    }
}
