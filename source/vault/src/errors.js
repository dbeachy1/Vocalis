/**
 * The two things that can go wrong in a way SillyTavern must not "repair".
 *
 * 🔴 THE WHOLE POINT OF THIS FILE IS THAT THERE IS ONE OF THEM, NOT TWO.
 *
 * `StorageError` used to be private to `provider.js`. So `key-value.js`, needing to say exactly the same
 * thing about exactly the same condition, built its own:
 *
 *     throw Object.assign(new Error(`The vault for '${handle}' is shut…`), { code: 'EUNAVAILABLE' });
 *
 * The code matched. Nothing else did — no `name: 'StorageError'`, no `.path`. `tests/provider.test.js`
 * pins `{ name: 'StorageError', code: 'EUNAVAILABLE' }`, so the key-value error would not have satisfied
 * the contract the provider's own suite enforces, and any fork-side guard written to that shape would
 * have skipped straight past it.
 *
 * That matters more here than it would almost anywhere else, because of what the fork does with the
 * errors it does NOT recognise. `provider.js` opens by naming the cost: SillyTavern has six code paths
 * that respond to unreadable data by deleting it and regenerating it from source. An error that fails to
 * present as a storage error is an error those paths feel free to "fix".
 *
 * ## The two codes, and why confusing them destroys data
 *
 * Both mean **the data is there and you cannot have it**. Neither ever means "there is nothing here".
 * `ENOENT` means the latter, which is why neither of these is ever allowed to become one.
 */

/** Storage is not ready — the vault is shut. The data EXISTS. Never regenerate on this. */
export const EUNAVAILABLE = 'EUNAVAILABLE';

/** Could not decode — wrong key, tampering, corruption. The data EXISTS. Never regenerate on this. */
export const EPROVIDER = 'EPROVIDER';

/**
 * An error that means "the data is there, and I cannot give it to you".
 */
export class StorageError extends Error {
    /**
     * @param {string} code EUNAVAILABLE or EPROVIDER
     * @param {string} message What happened
     * @param {string} [failedPath] The logical path
     */
    constructor(code, message, failedPath) {
        super(message);
        this.name = 'StorageError';
        this.code = code;
        this.path = failedPath;
    }
}

/**
 * The vault is shut, so this cannot be served.
 * @param {string} message What happened, in the words the user should read
 * @param {string} [failedPath] The logical path
 * @returns {StorageError} The error to throw
 */
export function unavailable(message, failedPath) {
    return new StorageError(EUNAVAILABLE, message, failedPath);
}

/**
 * The bytes are ours and we cannot decode them.
 *
 * ⚠️ Never for "this file is missing" and never for "this file is not ours". Both of those have honest
 * answers elsewhere; this one says *ours, and broken*, which is what stops a regenerate.
 * @param {string} message What happened
 * @param {string} [failedPath] The logical path
 * @returns {StorageError} The error to throw
 */
export function undecodable(message, failedPath) {
    return new StorageError(EPROVIDER, message, failedPath);
}

/**
 * Is this one of ours?
 *
 * The fork asks the same question its own way; this is here so that nothing inside this plugin has to
 * duplicate-guess the shape it just threw.
 * @param {any} error Anything caught
 * @returns {boolean} True if it is a StorageError
 */
export function isStorageError(error) {
    return error instanceof StorageError;
}
