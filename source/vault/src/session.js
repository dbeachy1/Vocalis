import { Buffer } from 'node:buffer';

import { deriveSubkeys, deriveSubkey as deriveFromDek } from './crypto/vault.js';

/**
 * The unlocked keys — in memory, and nowhere else.
 *
 * 🔴 THIS MODULE IS THE REASON A STOLEN DISK IS WORTHLESS.
 *
 * The DEK exists here and in no other place. It is never written down, never cached, never persisted,
 * never put in a session, never handed to SillyTavern. When the process exits — cleanly, on a crash, on a
 * power cut, on `systemctl restart` — it is gone, and the only way to get it back is for someone who
 * knows the password to type it in again.
 *
 * That is the whole design in one sentence, and every convenience that would soften it is a hole:
 *
 *   - Caching the DEK on disk "just until the next restart" puts it on the disk.
 *   - Deriving it from anything SillyTavern already stores (like the scrypt password hash in `_storage`)
 *     makes it computable by anyone who can read `_storage`, which is precisely the attacker.
 *   - Keeping it alive across a restart via a "session unlock key" is the same thing wearing a hat.
 *
 * So: no silent re-unlock. Restart means log in again. That is not a rough edge to be smoothed later --
 * it is the feature, and the lock contract in the fork exists to make SillyTavern behave correctly when
 * it happens.
 */

/**
 * @typedef {object} UnlockedKeys
 * @property {Buffer} dek The data-encryption key
 * @property {Buffer} kContent The content subkey (32 bytes, AES-256-GCM)
 * @property {Buffer} kNames The filename subkey (64 bytes, AES-SIV takes a double-length key)
 * @property {Buffer} kCache The key/value store subkey (32 bytes, AES-256-GCM)
 * @property {Buffer} kCacheNames The key/value store's FILENAME subkey (32 bytes, HMAC-SHA256)
 */

// The key table lives on the provider's own state now -- see `vault-state.js`. It was a module-level
// Map, so two providers built in one process silently shared one set of unlocked DEKs.

/**
 * Put a user's keys in memory. Called only by a successful unlock or recovery.
 * @param {import('./vault-state.js').VaultState} vault The provider's state
 * @param {string} handle The user handle
 * @param {Buffer} dek The data-encryption key
 * @returns {void}
 */
export function open(vault, handle, dek) {
    // 🔴 WIPE WHATEVER IS ALREADY THERE FIRST. `set` on an occupied handle used to just overwrite it, and
    // the record it dropped — a DEK and four subkeys, none of them referenced anywhere else — was never
    // zeroed, because `close()` can only ever reach the record currently in the Map.
    //
    // This is not an edge case, it is the documented normal path: `rekey()` deliberately leaves the session
    // open ("the user is standing right there") and ends by calling this function, so EVERY password change
    // orphaned a full set of live keys. `recover()` does the same, and so does any second `unlock()` without
    // an intervening `lock()`. The user then logs out, `close()` reports the vault shut, and a complete
    // un-zeroed key set is sitting in the heap for the life of the process — which is precisely the outcome
    // the `fill(0)` in `close()` exists to prevent, arrived at from the one direction it could not see.
    //
    // No test caught it: the "second unlock" test locks in between, and nothing opens the same handle twice.
    //
    // ⚠️ UNLESS THE CALLER HANDED US THE BUFFER THAT IS ALREADY IN THERE. Every current caller passes a
    // freshly unwrapped DEK, so this cannot happen today — but `close()` zeroes by reference, so a future
    // re-open using the live record's own key would wipe the key it was re-opening with and leave the
    // account holding 32 zero bytes. Cheap to rule out, and the failure it prevents is silent.
    if (vault.sessions.get(handle)?.dek !== dek) {
        close(vault, handle);
    }

    // 🔴 SPREAD, NOT DESTRUCTURED — so a subkey added to `deriveSubkeys` arrives here without an edit.
    //
    // This used to name all four explicitly, and so did `close()`. Adding a fifth therefore meant editing
    // three places in this file, and the third one is the one that matters: a key left out of the zeroing
    // loop is never wiped. It would sit in the heap after every lock, readable in a core dump or a swap
    // file, for the life of the process — and nothing would fail, no test would notice, and the module
    // docblock would go on claiming the opposite. See `close()`.
    vault.sessions.set(handle, { dek, ...deriveSubkeys(dek) });
}

/**
 * Is this user's vault open?
 * @param {import('./vault-state.js').VaultState} vault The provider's state
 * @param {string} handle The user handle
 * @returns {boolean} True if the keys are in memory
 */
export function isOpen(vault, handle) {
    return vault.sessions.has(handle);
}

/**
 * The keys for a user — ALL of them, DEK included.
 *
 * ⚠️ PREFER {@link providerKeys} OR {@link cacheKeys}. This hands out the master key, and a caller that
 * only needs to encrypt a file or name one should not be holding it. Nothing in `src/` calls this any
 * more; it stays exported because the record shape is what {@link open} stores and tests assert against.
 * @param {import('./vault-state.js').VaultState} vault The provider's state
 * @param {string} handle The user handle
 * @returns {UnlockedKeys|undefined} The keys, or undefined if the vault is shut
 */
export function keysFor(vault, handle) {
    return vault.sessions.get(handle);
}

/**
 * 🔴 THE TWO KEYS THE PROVIDER NEEDS, AND NOT THE ONE IT MUST NOT HOLD.
 *
 * `keysFor` returns the whole record — DEK included. `provider/resolve.js` used to call it and hang the
 * result on the ordinary path-resolution object that `resolve()` returns, whose shape is *documented
 * public API*. So a live reference to the master key rode along on a routing record that flows through
 * roughly twenty provider methods and is passed wholesale into the sidecar calculation.
 *
 * Nothing did anything wrong with it. That is the point: the safety was that nobody had yet written
 * `sensitive().error('resolve failed', at, error)` — which `logging.js` forbids by rule and which nothing
 * structurally prevents, and which would put the DEK in a log file. `provider.js` also has two `catch {}`
 * blocks that swallow whatever comes past.
 *
 * The provider needs `kNames` to map a path and `kContent` to open a file. It has never needed the DEK.
 * Handing it exactly those two bounds the worst case of a future mistake from "the master key for this
 * account, from which every other key derives" to "one subkey".
 *
 * ⚠️ THE BUFFERS ARE THE SAME OBJECTS, DELIBERATELY — this is a narrowed view, not a copy. `close()`
 * zeroes the buffers in the record, and a copy would leave these two untouched and readable after a lock,
 * which is the exact failure the narrowing is supposed to reduce.
 * @param {import('./vault-state.js').VaultState} vault The provider's state
 * @param {string} handle The user handle
 * @returns {{kContent: Buffer, kNames: Buffer}|undefined} The provider's keys, or undefined if shut
 */
export function providerKeys(vault, handle) {
    const keys = vault.sessions.get(handle);

    return keys && { kContent: keys.kContent, kNames: keys.kNames };
}

/**
 * The key/value store's two keys, and nothing else. Same reasoning as {@link providerKeys}: `key-value.js`
 * took the whole record — DEK and all — to reach `kCache` and `kCacheNames`.
 * @param {import('./vault-state.js').VaultState} vault The provider's state
 * @param {string} handle The user handle
 * @returns {{kCache: Buffer, kCacheNames: Buffer}|undefined} The store's keys, or undefined if shut
 */
export function cacheKeys(vault, handle) {
    const keys = vault.sessions.get(handle);

    return keys && { kCache: keys.kCache, kCacheNames: keys.kCacheNames };
}

/**
 * Derive a key for a caller outside this plugin, from a user's DEK.
 *
 * The DEK does not leave this module — HKDF runs one way, so the caller gets a key that is useless for
 * anything but the label it asked for, and useless the moment the user locks.
 *
 * `null` when the vault is shut, or when the handle is not ours. This is NOT an error: locked is the normal
 * state of every user until they log in, and a caller that asks before then is behaving correctly. Throwing
 * would turn the ordinary case into an incident. The caller cannot tell "locked" from "no vault here" by
 * `null` alone — deliberately; that distinction belongs to whoever brokers this, not here.
 *
 * No cache. A cached subkey is a copy of a key with a lifetime of its own, which is the thing `close()`
 * exists to prevent. Re-derive on every call; it is one HKDF over 32 bytes.
 * @param {import('./vault-state.js').VaultState} vault The provider's state
 * @param {string} handle The user handle
 * @param {string} info The caller's label
 * @param {number} length How many bytes the caller wants
 * @returns {Buffer|null} The derived key, or null if the vault is shut
 */
export function deriveSubkey(vault, handle, info, length) {
    const keys = vault.sessions.get(handle);
    if (!keys) {
        return null;
    }
    return deriveFromDek(keys.dek, info, length);
}

/**
 * Shut a user's vault and wipe the keys.
 *
 * The `fill(0)` is not superstition. A Buffer that is merely dereferenced sits in the heap, readable, for
 * as long as it takes the garbage collector to get round to it -- and a core dump, a swap file or a heap
 * snapshot taken in that window contains the key. Overwrite it, then drop it.
 *
 * (An honest limit: this cannot scrub copies V8 may have made internally, and it cannot un-swap a page
 * that already went to disk. It closes the window it can close.)
 * @param {import('./vault-state.js').VaultState} vault The provider's state
 * @param {string} handle The user handle
 * @returns {void}
 */
export function close(vault, handle) {
    const keys = vault.sessions.get(handle);

    if (!keys) {
        return;
    }

    // 🔴 EVERY BUFFER IN THE RECORD, FOUND BY ITERATING IT — not five named `fill(0)` calls.
    //
    // The named version was correct and quietly fragile: it had to be updated in step with
    // `deriveSubkeys`, and forgetting was silent in the worst direction. A key that is derived but never
    // wiped survives every lock, which is exactly what this function exists to prevent, and the omission
    // would be invisible to every test in the suite — nothing throws, nothing changes, the key is just
    // still there.
    //
    // Iterating means the set of keys to wipe is the set of keys that exist, by construction.
    for (const value of Object.values(keys)) {
        if (Buffer.isBuffer(value)) {
            value.fill(0);
        }
    }

    vault.sessions.delete(handle);
}

/**
 * Shut every vault. For a clean shutdown, and for tests.
 * @param {import('./vault-state.js').VaultState} vault The provider's state
 * @returns {void}
 */
export function closeAll(vault) {
    for (const handle of [...vault.sessions.keys()]) {
        close(vault, handle);
    }
}
