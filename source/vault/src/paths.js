import fs from 'node:fs';
import path from 'node:path';

import { isMarkedName, isSidecar, loadName, storeName, NAME_SCHEME_LEGACY, NAME_SCHEME_MIXED } from './crypto/name-cipher.js';
import { VAULT_KEYS_FILENAME } from './vault-store.js';
import { foreignStoreFor, isForeignStoreRoot } from './foreign-stores.js';
import { ownStoreDirectories } from './own-stores.js';
import { STRUCTURAL_DIRECTORIES } from './structure.js';

/**
 * Logical paths ↔ physical paths.
 *
 * SillyTavern always speaks in LOGICAL paths — the paths it would use if this plugin did not exist:
 * `<DR>/default-user/chats/Test Character/a chat.jsonl`. What is actually on the disk is
 * `<DR>/default-user/chats/<ciphertext>/<ciphertext>`. This module is the only place that knows both.
 *
 * ## Why the skeleton stays readable
 *
 * `chats/`, `characters/`, `worlds/` and the rest of SillyTavern's fixed directory tree are NOT encrypted.
 * That is not laziness, and it is not a compromise — it is forced, and for a good reason:
 *
 * 🔴 **SillyTavern BUILDS THAT TREE AT BOOT, BEFORE ANYONE HAS LOGGED IN.** `ensurePublicDirectoriesExist`
 * runs `mkdir` across every user's directory skeleton while the vault is still shut and there is no key in
 * the process. A provider that had to encrypt `chats` in order to create it could not create it at all.
 *
 * And the cost is nothing. `chats/` tells an attacker that SillyTavern is installed, which they knew from
 * the port it is listening on. What matters is *what is inside* it — the character names, the chat titles,
 * the world names — and every one of those is a variable component, and every variable component is
 * ciphertext. `characters/Test Character.png` is a directory listing of private character data;
 * `characters/<48 bytes of base64url>` is not.
 *
 * ## The rule, in one line
 *
 *     A path component is plaintext if and only if it is part of SillyTavern's fixed skeleton.
 *     Everything else is encrypted, deterministically, bound to its parent directory.
 *
 * ## The one file that is never touched
 *
 * `.vault-keys.json` is plaintext, keeps its name, and is readable while locked — because it is *what you
 * unlock with*. Encrypting it would be a lock with its key inside.
 */

export { NAME_SCHEME_LEGACY, NAME_SCHEME_MIXED } from './crypto/name-cipher.js';

/**
 * SillyTavern's fixed directory skeleton, relative to `<DATA_ROOT>/<handle>/`.
 *
 * 🔀 THE LIST ITSELF NOW LIVES IN `structure.js`, and is re-exported here because this is where it is used
 * most and where every existing importer looks for it. It had to move because `foreign-stores.js` needs it
 * to refuse a plugin that claims `chats`, and this module already imports `foreign-stores.js` — the two
 * would have pointed at each other. See that file for the reasoning.
 */
export { STRUCTURAL_DIRECTORIES };

/**
 * Directories whose CONTENTS are named by a library rather than by us.
 *
 * node-persist chooses the filenames inside its own store, and it is not going to stop. We give it a KEYED
 * name to use (see `key-value.js` — an HMAC under `k_cache_names`, so it gives an attacker nothing), and
 * then this provider must leave those names alone: they are already ciphertext-equivalent, and running them
 * back through the name cipher would be encrypting an encryption.
 *
 * It also stops `readdir()` throwing in here. It used to: the names are not AES-SIV ciphertext, so decoding
 * them failed — which `diskCache.verify()` caught and responded to by pruning nothing, for ever.
 */
const LIBRARY_NAMED_DIRECTORIES = new Set(ownStoreDirectories());

/**
 * Does a library, rather than this provider, choose the names inside this directory?
 * @param {string} parentLogical The logical directory
 * @returns {boolean} True if its contents keep the names they are given
 */
function isLibraryNamed(vault, parentLogical) {
    // Same rule, for the same reason, one layer out: a plugin that encrypts its own store also names its own
    // files, and AES-SIV-ing a name it chose would be encrypting an encryption — or, as node-persist proved
    // first, simply throwing on the way past.
    return LIBRARY_NAMED_DIRECTORIES.has(parentLogical) || foreignStoreFor(vault, parentLogical) !== undefined;
}

/**
 * Split an absolute path into the user it belongs to and the rest.
 * @param {string} dataRoot The data root
 * @param {string} absPath An absolute path
 * @returns {{handle: string, relative: string}|null} The owner and the logical path within their
 * directory, or null if this is not user data at all
 */
export function split(vault, absPath) {
    const relative = path.relative(vault.dataRoot, path.resolve(absPath));

    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }

    const parts = relative.split(path.sep);
    const handle = parts[0];

    if (!isUserHandle(vault, handle)) {
        return null;
    }

    return { handle, relative: parts.slice(1).join('/') };
}


// Per provider now -- see `vault-state.js`.

/**
 * Remember who the users are.
 * @param {{handle: string}[]} users The accounts, from the boot context
 * @returns {void}
 */
export function rememberHandles(vault, users) {
    for (const user of users ?? []) {
        vault.handles.add(user.handle);
    }
}

/**
 * Is this first path component the name of a user, or something of SillyTavern's own?
 *
 * 🔴 THIS IS NOT THE TRIVIA IT LOOKS LIKE. Getting it wrong made the provider claim ownership of a file
 * that was never user data.
 *
 * `seedGlobalContent` reads `<DATA_ROOT>/content.log` — a file sitting directly in the data root, next to
 * the user directories rather than inside one. The first version of this function took the first path
 * component and called it a handle, so `content.log` became a "user", the provider claimed the file, and
 * tried to decrypt it with a key that did not exist. It threw a TypeError.
 *
 * And SillyTavern SWALLOWED IT: `checkForNewContent` wraps its whole body in
 * `catch (err) { console.error('Content check failed', err); }`. So nothing crashed. It just silently
 * seeded no content at all — no themes, no presets, no backgrounds — and there was nothing to tell you why.
 *
 * So the question "which of these is a user?" gets a real answer, not a guess:
 *
 *   1. SillyTavern told us at boot. That is authoritative.
 *   2. Anything starting with `_` is SillyTavern's own (`_storage`, `_uploads`, `_errors`).
 *   3. Otherwise: a user is a DIRECTORY. `content.log` and `access.log` are files, and files that live in
 *      the data root belong to SillyTavern.
 * @param {string} dataRoot The data root
 * @param {string} name The first path component
 * @returns {boolean} True if this names a user
 */
function isUserHandle(vault, name) {
    if (!name || name.startsWith('_')) {
        return false;
    }

    if (vault.handles.has(name)) {
        return true;
    }

    const candidate = path.join(vault.dataRoot, name);

    if (fs.existsSync(candidate)) {
        return fs.statSync(candidate).isDirectory();
    }

    // It does not exist yet -- SillyTavern is about to create it. A user directory has no file extension;
    // `content.log` does. This only decides the case where a brand-new account is being made, and the very
    // next thing that happens is that the directory appears and clause 3 takes over.
    return !path.extname(name);
}

/**
 * Where one account's data lives, and optionally a path inside it.
 *
 * 🔴 EIGHT PLACES COMPUTED THIS BY HAND, AND `vault-store.js` ALREADY CARRIES THE ARGUMENT FOR WHY THAT
 * IS A BUG WAITING FOR A TYPO — it says so at length about a duplicated cache-key expression that cost an
 * afternoon, and the reasoning was never applied to the joins.
 *
 * The `logicalRelative` form takes a `/`-separated logical path, because that is the separator every
 * string in this module uses, and splits it into real path segments. Passing a logical path straight to
 * `path.join` works by accident on POSIX and by luck on Windows; doing it here means it is done once.
 * @param {string} dataRoot The data root
 * @param {string} handle The user handle
 * @param {string} [logicalRelative] A `/`-separated path within their directory
 * @returns {string} The absolute path
 */
export function userRoot(dataRoot, handle, logicalRelative = '') {
    return logicalRelative
        ? path.join(dataRoot, handle, ...logicalRelative.split('/'))
        : path.join(dataRoot, handle);
}

/**
 * Is this logical path the vault-keys file — the one thing that is never encrypted or renamed?
 * @param {string} logicalRelative The path within the user's directory
 * @returns {boolean} True if it is the key file
 */
export function isVaultKeys(logicalRelative) {
    return logicalRelative === VAULT_KEYS_FILENAME;
}

/**
 * Is this component part of SillyTavern's fixed skeleton?
 * @param {string} logicalSoFar The path built up so far, within the user's directory
 * @returns {boolean} True if it stays plaintext
 */
function isStructural(vault, logicalSoFar) {
    // A registered foreign store's ROOT is skeleton too, and for the same reason the skeleton is: its owner
    // creates it before anyone has logged in, so a name that needed a key could not be created at all. Only
    // the root — everything BENEATH it is the owner's to name, which `isLibraryNamed` handles.
    return STRUCTURAL_DIRECTORIES.has(logicalSoFar) || isForeignStoreRoot(vault, logicalSoFar);
}

/**
 * Is this logical path made ENTIRELY of skeleton?
 *
 * Such a path can be resolved with no key at all, which is what lets SillyTavern build the directory tree
 * at boot while every vault is still shut.
 * @param {string} logicalRelative The logical path within the user's directory
 * @returns {boolean} True if no part of it needs encrypting
 */
export function isAllStructural(vault, logicalRelative) {
    if (!logicalRelative) {
        return true;
    }

    const parts = logicalRelative.split('/');
    let soFar = '';

    for (const part of parts) {
        soFar = soFar ? `${soFar}/${part}` : part;

        if (!isStructural(vault, soFar)) {
            return false;
        }
    }

    return true;
}

/**
 * Would this plugin choose the on-disk name of the final component of this path?
 *
 * 🔴 THE ONLY SOUND KEYLESS TEST FOR "COULD A FILE UNDER THIS EXACT NAME PREDATE US?" — and it needs to be
 * sound, because it gates whether a LOCKED vault will serve a file it finds sitting in the clear.
 *
 * For a component we name, a plaintext name is proof the file predates us: our names are ciphertext, so we
 * could not have written it. For a component we do NOT name — a skeleton directory, or anything inside a
 * library-named one — the plaintext name proves nothing at all, because that is where our own files live
 * too. Serving those raw because they were found in the clear would hand SillyTavern ciphertext and call it
 * plaintext, which is the §3 mistake with the labels swapped.
 * @param {string} logicalRelative The logical path within the user's directory
 * @returns {boolean} True if the last component's on-disk name would be ciphertext
 */
export function namesOwnLeaf(vault, logicalRelative) {
    if (!logicalRelative || isVaultKeys(logicalRelative)) {
        return false;
    }

    const parts = logicalRelative.split('/');
    const parentLogical = parts.slice(0, -1).join('/');

    return !isStructural(vault, logicalRelative) && !isLibraryNamed(vault, parentLogical);
}

// 🔴 `toPhysical` WAS HERE AND IS GONE -- exported, and referenced by nothing in src/, bin/ or tests/.
// The provider goes through `walk()` directly, which is what actually carries the classification.

/**
 * @typedef {object} PathStep
 * @property {string} logical The logical path built up to and including this component.
 * @property {string} physical The on-disk name of this component.
 * @property {boolean} encrypted True if WE named this component — false for skeleton, library-named
 * directories, the key file, and (under scheme 2) anything that predates us.
 * @property {boolean} legacy True if this component is on the disk under its own name because it was there
 * BEFORE this plugin was. See below: this is not the negation of `encrypted`.
 * @property {{name: string, content: string}|null} sidecar The long-name companion this component needs.
 */

/**
 * 🔴 `encrypted` AND `legacy` ARE DIFFERENT QUESTIONS AND THE GAP BETWEEN THEM IS A PLAINTEXT LEAK.
 *
 * `encrypted` is about the NAME. `legacy` is about who put the file there. Three of the four combinations
 * occur, and the one that makes this worth spelling out is `encrypted: false, legacy: false` — a component
 * we did not name but which is still entirely ours: every skeleton directory, and any file that ends up
 * directly inside one.
 *
 * Deriving "are these bytes ours?" from `encrypted` alone gets that case backwards, and the failure is
 * silent and in the worst direction: the provider concludes the file predates it and writes the user's data
 * **in the clear**, on an install whose entire premise is that it does not. `provider.test.js` catches it by
 * adding a file-shaped entry to `STRUCTURAL_DIRECTORIES` on purpose, because today every real entry is a
 * directory and the bug is therefore unreachable by coincidence rather than by design — which is exactly
 * the load-bearing coincidence `contentKey()` was written to stop relying on.
 */

/**
 * 🔀 THE WALK — one component at a time, because under mixed mode each one is classified separately.
 *
 * A logical path is not mapped to a physical one by a single rule any more. `chats/Test Character/a chat.jsonl`
 * in a scheme-2 account can have a legacy plaintext `Test Character` directory holding a brand-new encrypted
 * chat, and both halves of that are correct: §1 says what already existed keeps the state it had, and §8
 * says what is created now is encrypted. The state is a property of each individual name on the disk, so
 * that is the granularity this has to work at.
 *
 * ## 🔴 How an existing name is classified, and the answer that is never allowed
 *
 * By its NAME, keylessly — `isMarkedName` and nothing else. Never by trying to decrypt it and seeing what
 * happens. §4 is emphatic about this and it is the same failure as §3's: a decrypt-and-see test reports a
 * *damaged* file as *not ours*, the provider hands its raw ciphertext to SillyTavern as though it were
 * plaintext, and one of the six regenerate-on-unreadable-data paths repairs it by overwriting it.
 *
 * ## What `probe` is for, and what it costs
 *
 * A name that does not exist yet has no state to inherit, so it takes today's default: encrypted (§8). A
 * name that DOES exist keeps what it has. Telling those apart needs a look at the disk, which is why the
 * caller passes a probe — this module stays testable without a filesystem, and the provider stays the only
 * thing that touches one.
 *
 * ⚠️ **The cost, stated honestly.** Scheme 2 costs up to two `existsSync` calls per component per resolve,
 * where scheme 1 cost none. A three-component path is therefore up to six stats on a path that used to be
 * pure arithmetic. That is the price of a directory holding two namespaces, and it is paid only by accounts
 * that actually have two. If it ever shows up in a profile the fix is a cache keyed by physical path and
 * invalidated on write — NOT a cheaper classifier, because there is no cheaper classifier that is correct.
 *
 * Plaintext wins a tie. Two files should never occupy one logical name, but if they somehow do, the
 * plaintext one is the one that predates us and the one that cannot be mis-decrypted.
 * @param {Buffer} kNames The name key
 * @param {string} logicalRelative The logical path within the user's directory
 * @param {number} [scheme] The account's name scheme
 * @param {(physicalRelative: string) => boolean} [probe] Does this on-disk path exist? Omitted means "do
 * not look" — every component then takes its deterministic encrypted form, which is what a scheme-1 account
 * wants and what a caller asking "where would this go?" wants.
 * @param {boolean} [preferClearLeaf] Force the LAST component to its plaintext form even though nothing is
 * there yet. This is how a copy inherits its source's state (§8): a rename is `copyFile` + `unlink`, so
 * renaming a legacy chat must produce another legacy chat rather than converting it. Only the leaf — the
 * parents are wherever they already are, and the walk finds that out for itself.
 * @returns {PathStep[]} One step per component
 */
export function walk(vault, kNames, logicalRelative, scheme = NAME_SCHEME_LEGACY, probe = undefined, preferClearLeaf = false) {
    if (!logicalRelative) {
        return [];
    }

    if (isVaultKeys(logicalRelative)) {
        return [{ logical: logicalRelative, physical: logicalRelative, encrypted: false, legacy: false, sidecar: null }];
    }

    /** @type {PathStep[]} */
    const steps = [];
    const physical = [];
    const parts = logicalRelative.split('/');
    let logicalSoFar = '';

    for (const [index, part] of parts.entries()) {
        const isLeaf = index === parts.length - 1;
        const parentLogical = logicalSoFar;
        logicalSoFar = logicalSoFar ? `${logicalSoFar}/${part}` : part;

        // The skeleton keeps its name, and so does anything a library named for itself — those are already
        // keyed hashes and running them back through the name cipher would be encrypting an encryption.
        if (isStructural(vault, logicalSoFar) || isLibraryNamed(vault, parentLogical)) {
            steps.push({ logical: logicalSoFar, physical: part, encrypted: false, legacy: false, sidecar: null });
            physical.push(part);
            continue;
        }

        const stored = storeName(kNames, parentLogical, part, scheme);
        const physicalParent = physical.join('/');
        const at = (name) => (physicalParent ? `${physicalParent}/${name}` : name);

        // A component that already exists in the clear predates us and stays that way, for ever (§1). Only
        // scheme 2 can have such a thing; in a scheme-1 account every name is ours by construction.
        //
        // The plaintext candidate is tested FIRST, so it wins if both somehow exist — matching the fork's
        // `mixed-provider.js` fixture, which is the executable statement of this contract. Two files under
        // one logical name cannot arise through any operation here (a write resolves to the plaintext one
        // and stays there), so this only decides the case where something outside the plugin put them both
        // there; and of the two, the plaintext one is the one that predates us and the one that cannot be
        // mis-decrypted.
        if (scheme === NAME_SCHEME_MIXED && ((preferClearLeaf && isLeaf) || (probe && probe(at(part))))) {
            steps.push({ logical: logicalSoFar, physical: part, encrypted: false, legacy: true, sidecar: null });
            physical.push(part);
            continue;
        }

        steps.push({
            logical: logicalSoFar,
            physical: stored.fileName,
            encrypted: true,
            legacy: false,
            sidecar: stored.isLong ? { name: stored.sidecarName, content: stored.sidecarContent } : null,
        });
        physical.push(stored.fileName);
    }

    return steps;
}

/**
 * Every long-name companion file a logical path implies.
 *
 * When an encrypted component is too long for the filesystem, it is stored under a hash and the real
 * ciphertext moves into a companion file beside it. Those files have to be written when the path is
 * created, or a later directory listing will have no way to recover the name.
 * @param {Buffer} kNames The name key
 * @param {string} logicalRelative The logical path
 * @returns {{physicalPath: string, content: string}[]} Companion files, relative to the user's directory
 */
export function sidecarsFor(vault, kNames, logicalRelative, scheme = NAME_SCHEME_LEGACY, probe = undefined, preferClearLeaf = false) {
    const steps = walk(vault, kNames, logicalRelative, scheme, probe, preferClearLeaf);
    const sidecars = [];

    for (let index = 0; index < steps.length; index++) {
        if (!steps[index].sidecar) {
            continue;
        }

        const physicalParent = steps.slice(0, index).map(step => step.physical).join('/');
        const { name, content } = steps[index].sidecar;

        sidecars.push({
            physicalPath: physicalParent ? `${physicalParent}/${name}` : name,
            content,
        });
    }

    return sidecars;
}

/**
 * Should this on-disk entry be hidden from SillyTavern entirely?
 *
 * 🔴 THE COMPANION FILES MUST NEVER BE SEEN. If a `.nm` sidecar ever appeared in a directory listing,
 * SillyTavern would try to parse it as a chat -- and `data-maid` would report it as an orphan and offer to
 * delete it. Deleting a sidecar loses the name of the file it belongs to, permanently.
 * ⚠️ PASS `hasSibling`. `isSidecar` needs the directory to tell a companion from a long name whose own
 * logical extension is `.nm`; with no predicate it calls both of them companions and hides the user's file.
 * @param {string} physicalName An on-disk name
 * @param {(name: string) => boolean} [hasSibling] Does a given name exist in the same directory?
 * @returns {boolean} True if SillyTavern must not be told about it
 */
export function isHidden(physicalName, hasSibling) {
    return isSidecar(physicalName, hasSibling);
}

/**
 * Recover the logical name of an on-disk entry, using the companion file if it needs one.
 * @param {Buffer} kNames The name key
 * @param {string} parentLogical The logical directory it lives in
 * @param {string} physicalName The on-disk name
 * @param {(sidecarName: string) => string|undefined} readSidecar Reads a companion file
 * @param {string} [scheme] The account's name scheme
 * @param {(name: string) => boolean} [hasSibling] Does a given name exist in the same directory?
 * @returns {string} The logical name
 */
export function decodeName(vault, kNames, parentLogical, physicalName, readSidecar, scheme = NAME_SCHEME_LEGACY, hasSibling = undefined) {
    const asStructural = parentLogical ? `${parentLogical}/${physicalName}` : physicalName;

    // 🔴 UNDER SCHEME 2 AN UNMARKED NAME IS SOMEBODY ELSE'S AND IS RETURNED UNTOUCHED.
    //
    // This is the `readdir` half of the union (§4): a mixed directory has two namespaces overlaid, and the
    // caller must get one list with the logical name of every file in it. A legacy chat is already under its
    // logical name, so there is nothing to decode — and attempting to decode it would throw, which in a
    // listing is far worse than it sounds. `readdir` failing takes out the whole directory, not one row, so
    // one plaintext file would hide every encrypted one beside it.
    if (scheme === NAME_SCHEME_MIXED && !isMarkedName(physicalName)) {
        return physicalName;
    }

    // A skeleton directory keeps its name.
    if (isStructural(vault, asStructural)) {
        return physicalName;
    }

    // And so does anything a library named for itself. There is nothing here for the name cipher to decode
    // -- these are already keyed hashes, chosen by the key/value store, and trying to AES-SIV them would
    // simply throw. (It did.)
    if (isLibraryNamed(vault, parentLogical)) {
        return physicalName;
    }

    // And so does the key file.
    if (!parentLogical && physicalName === VAULT_KEYS_FILENAME) {
        return physicalName;
    }

    return loadName(kNames, parentLogical, physicalName, readSidecar, hasSibling);
}
