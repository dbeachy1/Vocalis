import fs from 'node:fs';
import path from 'node:path';

import { NAME_SCHEME_LEGACY, NAME_SCHEME_MIXED } from './crypto/name-cipher.js';

/**
 * Where the wrapped keys live, and the rules about that file.
 *
 * ## The file
 *
 * `<DATA_ROOT>/<handle>/.vault-keys.json` — one per account, holding a fresh argon2id salt and the DEK
 * wrapped twice: once under the password, once under the recovery key. A few hundred bytes.
 *
 * ## Three rules, and each of them has a way to kill you
 *
 * 1. 🔴 **IT IS PLAINTEXT, BY NECESSITY.** It is what you unlock *with* — encrypting it would be a lock
 *    whose key is inside the lock. So the provider must never try to encrypt or decrypt it, and must
 *    serve it even while the vault is shut. It gives nothing away: salts and wrapped blobs are exactly
 *    what an attacker is expected to have, and they are useless without the password.
 *
 * 2. 🔴 **LOSING IT LOSES EVERYTHING, EVEN IF YOU REMEMBER THE PASSWORD.** The password does not decrypt
 *    the data — it unwraps THIS BLOB, and the blob holds the key that decrypts the data. Delete this file
 *    and every chat on the disk becomes permanently unreadable, with the correct password in hand and a
 *    perfect backup of everything else. It must be in every backup, and it must be the first thing
 *    restored.
 *
 *    This is why it lives INSIDE the user directory rather than off to one side: SillyTavern's own backup
 *    walks that directory, so the key file rides along automatically and the ZIP is a complete,
 *    restorable artifact. A key file kept somewhere tidier would be a key file left out of the backup.
 *
 * 3. 🔴 **NOTHING MAY EVER SWEEP IT UP.** It sits in the user's root next to `settings.json`, and it must
 *    survive every boot-time migration, every `data-maid` orphan sweep, and every cache repair — none of
 *    which have ever heard of it. (Checked: data-maid only ever scans named subdirectories — chats,
 *    characters, images, groups, thumbnails — and never the user root. So the file is not in its path.
 *    `tests/` pins that, because "not currently in its path" is one refactor away from "deleted".)
 */

/** The name of the file, in every user directory. */
export const VAULT_KEYS_FILENAME = '.vault-keys.json';

/**
 * Where a user's wrapped keys live.
 * @param {string} dataRoot The data root
 * @param {string} handle The user handle
 * @returns {string} Absolute path to their vault-keys file
 */
export function vaultKeysPath(dataRoot, handle) {
    return path.join(dataRoot, handle, VAULT_KEYS_FILENAME);
}

// 🔴 `isVaultKeysPath` WAS HERE AND IS GONE. It had ZERO callers anywhere in src/, bin/ or tests/, while
// its docblock asserted "the provider asks this on every single I/O call". It also matched on
// `path.basename`, so it answered TRUE for `chats/.vault-keys.json` -- where `paths.isVaultKeys`, which is
// the one actually wired in, is root-only and answers false. Two functions for one question, disagreeing,
// one of them unreferenced: a divergence waiting for whoever called the wrong one first.


/**
 * Does this account have a vault?
 * @param {string} dataRoot The data root
 * @param {string} handle The user handle
 * @returns {boolean} True if the account is encrypted
 */
export function hasVault(dataRoot, handle) {
    return fs.existsSync(vaultKeysPath(dataRoot, handle));
}

/**
 * Every account that has a vault.
 * @param {string} dataRoot The data root
 * @returns {string[]} Handles
 */
export function listVaultedHandles(dataRoot) {
    if (!fs.existsSync(dataRoot)) {
        return [];
    }

    return fs.readdirSync(dataRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
        .map(entry => entry.name)
        .filter(handle => hasVault(dataRoot, handle));
}

/**
 * Read a user's wrapped keys.
 * @param {string} dataRoot The data root
 * @param {string} handle The user handle
 * @returns {import('./crypto/vault.js').VaultKeys|null} The keys, or null if the account is not encrypted
 */
export function readVaultKeys(dataRoot, handle) {
    const keysPath = vaultKeysPath(dataRoot, handle);

    if (!fs.existsSync(keysPath)) {
        return null;
    }

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));

    // 🔴 A vault-keys file we cannot understand is a STOP, not a shrug. If a future version writes a
    // format this one does not know, the safe move is to refuse to run -- because the alternative is to
    // treat the account as un-vaulted, serve the ciphertext as if it were plaintext, and let
    // SillyTavern's boot-time repair machinery loose on it.
    // Version 1 is a pre-mixed-mode vault: every name in it is bare ciphertext and every file in it is ours.
    // Version 2 adds `nameScheme`, and with it the possibility that some files in the account are not ours
    // at all. Both are readable by this build; anything else is not, and saying so is the whole point.
    if (keys?.version !== 1 && keys?.version !== 2) {
        throw new Error(`${keysPath} is version ${keys?.version}, and this plugin understands versions 1 and 2. Refusing to touch this account rather than risk damaging it. Upgrade the plugin.`);
    }

    return keys;
}

/**
 * Write a user's wrapped keys.
 *
 * Atomic, because a torn write here is the end of the account. The rename is the commit point: either the
 * old keys are intact or the new ones are, and never a half of each.
 * @param {string} dataRoot The data root
 * @param {string} handle The user handle
 * @param {import('./crypto/vault.js').VaultKeys} keys The keys
 * @returns {void}
 */
export function writeVaultKeys(vault, handle, keys) {
    const keysPath = vaultKeysPath(vault.dataRoot, handle);
    const temporaryPath = `${keysPath}.tmp`;

    vault.schemeCache.delete(handle);
    fs.mkdirSync(path.dirname(keysPath), { recursive: true });

    // 🔴 THE DOCBLOCK ABOVE PROMISED DURABILITY AND THE CODE ONLY DELIVERED ATOMICITY, AND THE DIFFERENCE
    // BETWEEN THEM IS THE WHOLE ACCOUNT.
    //
    // rename(2) makes the DIRECTORY ENTRY swap atomically. It says nothing about whether the bytes the entry
    // points at ever reached the platter. So: user changes their password, rewrapPassword produces a new
    // salt_kek and wrap_password, this writes and renames, the box loses power a second later. On reboot
    // .vault-keys.json EXISTS -- so `hasVault()` is true and nothing re-initialises it -- and its contents
    // are zero bytes. readVaultKeys throws SyntaxError out of unlock().
    //
    // Neither the old password nor the new one opens the account, and the recovery key went with the file.
    // That is total, permanent, unrecoverable loss of every chat in that account, and it is the exact
    // outcome rule 2 at the top of this file says must never happen.
    //
    // ext4's data=ordered heuristic usually hides this, which is why it has not bitten. It is a heuristic,
    // not a guarantee, and it does not hold on XFS, on data=writeback, or on a network filesystem.
    //
    // 0600 on the fd rather than the path, incidentally: writeFileSync's `mode` is only applied on O_CREAT,
    // so a pre-existing (or planted) .tmp kept whatever permissions it already had, and writeFileSync
    // follows symlinks. Opening with 'w' and an explicit mode closes both.
    const fd = fs.openSync(temporaryPath, 'w', 0o600);

    try {
        fs.writeFileSync(fd, JSON.stringify(keys, null, 2), { encoding: 'utf-8' });
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }

    fs.renameSync(temporaryPath, keysPath);

    // And the rename itself, so it cannot be the thing that is lost. Best effort: Windows cannot open a
    // directory as a file (EPERM); on Linux, syncing the containing directory persists the rename. See
    // `provider/atomic.js`.
    let directoryFd;

    try {
        directoryFd = fs.openSync(path.dirname(keysPath), 'r');
        fs.fsyncSync(directoryFd);
    } catch {
        // See above.
    } finally {
        if (directoryFd !== undefined) {
            fs.closeSync(directoryFd);
        }
    }
}

/**
 * 🔀 WHICH NAME SCHEME THIS ACCOUNT USES — and why it is written down rather than worked out.
 *
 * See `crypto/name-cipher.js` for what the two schemes are. What matters here is that the answer is a
 * FACT ABOUT THE ACCOUNT, recorded once when its vault is created, and never inferred afterwards.
 *
 * 🔴 The tempting alternative is to look at the directory and guess — "these names have markers, so it must
 * be scheme 2". It is unsafe in a way that only shows up on a real account: an empty directory has no names
 * to look at, a directory whose files are all legacy plaintext looks exactly like a scheme-1 account that
 * has been emptied, and a wrong guess in that second case makes the provider treat scheme-1 CIPHERTEXT as
 * plaintext and hand it to SillyTavern, which parses it, fails, and rebuilds the file from nothing. There
 * is no reading of the disk that distinguishes those cases. There is a field in a file that does.
 *
 * ⚠️ **An account created before mixed mode existed has no field, and that means scheme 1** — not "unknown",
 * and not "upgrade it now". Those accounts are entirely ours by construction (`createVaultFor` has always
 * refused to encrypt an account that already held data), so scheme 1 remains exactly correct for them and
 * changing it would rename every file they contain.
 * @param {string} dataRoot The data root
 * @param {string} handle The user handle
 * @returns {number} `NAME_SCHEME_LEGACY` or `NAME_SCHEME_MIXED`
 */
export function nameSchemeFor(vault, handle) {

    const cached = vault.schemeCache.get(handle);

    if (cached !== undefined) {
        return cached;
    }

    let scheme = NAME_SCHEME_LEGACY;

    try {
        scheme = readVaultKeys(vault.dataRoot, handle)?.nameScheme === NAME_SCHEME_MIXED
            ? NAME_SCHEME_MIXED
            : NAME_SCHEME_LEGACY;
    } catch {
        // Unreadable or absent. `readVaultKeys` throws for a keys file from a future version, and that stop
        // is enforced where it can refuse the whole account; here, on a hot path called for every I/O, the
        // useful answer is the conservative one. Scheme 1 is conservative because it treats every name as
        // ours, which fails LOUDLY on a name it cannot decode — where scheme 2 would silently classify it
        // as somebody else's plaintext and serve the ciphertext.
    }

    vault.schemeCache.set(handle, scheme);
    return scheme;
}

// HISTORY, kept deliberately -- the function this described is gone, and why it is gone matters.
//
// 🔴 THE CACHE KEY, IN EXACTLY ONE PLACE — and it cost a full afternoon to learn why that matters.
//
// This expression was written out twice: once where the cache is read and once where it is invalidated. A
// stray byte got into one copy, so the two keys never matched, so `writeVaultKeys` invalidated nothing.
//
// What that did was not "a slightly stale cache". SillyTavern builds the directory skeleton at boot, before
// anybody has logged in — so the first read happened while the account had NO vault, cached the answer
// `NAME_SCHEME_LEGACY`, and then never let go of it. Logging in created a scheme-2 vault whose keys file
// said so plainly, and every subsequent write ignored it and used scheme-1 names. The account's own record
// of its format and the format actually on its disk disagreed, permanently, on a fresh install.
//
// Nothing threw. Every unit test passed, because unit tests unlock before they do anything and so never
// populate the cache while the vault is shut. It took an end-to-end run against a real server to see it,
// and the visible symptom was a chat that saved with a 200 and came back empty.
//
// So: one function, called from both sides. Two copies of a key is a bug waiting for a typo.
// 🔴 AND THE COMPOSITE KEY IS GONE ENTIRELY, WHICH IS THE REAL FIX.
//
// `cacheKeyFor(dataRoot, handle)` existed because ONE module-level Map served every data root in the
// process, so the data root had to be smuggled into every key. The cache belongs to a provider now, and
// a provider serves one data root -- so the key is just the handle, and there is no expression left to
// write out twice or to get a stray byte into. The bug above is not fixed, it is unreachable.

/**
 * The scheme, per account, read once per process.
 *
 * Safe to cache because it is immutable for the life of a vault: it is written when the vault is created
 * and there is no operation that changes it. {@link writeVaultKeys} still invalidates, so that a test (or a
 * future migration) that rewrites the file cannot be served a stale answer.
 * @type {Map<string, number>}
 */
// Per provider now -- see `vault-state.js`. It was a module-level Map keyed by dataRoot+handle, which

/**
 * Forget every cached scheme. For tests, which build and tear down data roots in one process.
 * @returns {void}
 */
// only worked because the key carried the data root; the state object makes the ownership real.
export function forgetNameSchemes(vault) {
    vault.schemeCache.clear();
}
