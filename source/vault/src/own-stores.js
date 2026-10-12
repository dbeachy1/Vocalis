/**
 * STORES VAULT ITSELF OPERATES THAT DO NOT GO THROUGH THE PROVIDER'S CIPHER PATH.
 *
 * ## Why this exists, in the words of the module that already made the argument
 *
 * `foreign-stores.js` says it about somebody else's store, and every word applies here:
 *
 * > *Adding `memory` to `STRUCTURAL_DIRECTORIES` and a `store.db` exception to `classify()` would work
 * > today, take four lines, and be wrong: it re-breaks the moment a second consumer appears, and it puts
 * > knowledge of a specific plugin inside a module that should not know any plugin exists. … The thing
 * > that must be general is the declaration.*
 *
 * That reasoning was applied to other plugins' stores and never to our own. So the character-card cache —
 * the one store Vault runs that node-persist writes with its own `fs` calls — was described in four files
 * that never referenced each other:
 *
 *     key-value.js   the envelope tag `esk1:`
 *     verify.js      the tag AGAIN, synchronised by a comment reading "Kept in step with key-value.js"
 *     paths.js       `_cache` and `_cache/characters` as skeleton, and again as library-named
 *     verify.js      `at.startsWith('_cache/')`, a bare string, as the rule for classifying its files
 *
 * The string `_cache` did not appear in `key-value.js` at all — the module that owns the store.
 *
 * ## What one declaration buys
 *
 * Four facts follow from a store declaring itself, and each one is a bug if it is forgotten:
 *
 *   1. its directory is SKELETON — created at boot, before anyone has logged in, so a name needing a key
 *      could not be created at all;
 *   2. the names INSIDE it are the library's — already keyed hashes, and running them back through the
 *      name cipher is encrypting an encryption, which `paths.js` records as having simply thrown;
 *   3. its files carry ITS envelope, not `STV1`;
 *   4. `verify` classifies them under its own verdict rather than as a leak.
 *
 * 🔴 **FORGETTING (4) IS THE EXPENSIVE ONE.** Every file in the store reports `PLAINTEXT`, on every run,
 * for ever — which `foreign-stores.js` identifies as the failure that destroys the leak detector itself:
 * *"a leak detector with a permanent false positive is a leak detector nobody reads."*
 *
 * ⚠️ **This is NOT `foreign-stores.js`, and the difference is who holds the key.** A foreign store belongs
 * to another plugin, is registered at runtime, is persisted, and is taken partly on trust because we
 * cannot decrypt it. These are ours: known at build time, opened with our own subkeys, and verified by
 * actually decrypting them when a password is to hand. Nothing here is a claim; it is a description.
 */

/**
 * @typedef {object} OwnStore
 * @property {string} directory The store's logical directory, relative to the account root.
 * @property {string[]} skeleton Directories that must resolve with no key — the store's own directory and
 * every ancestor of it. SillyTavern and the fork create these at boot, while every vault is shut.
 * @property {string} envelope The tag its values carry. Deliberately NOT the provider's `stenv:` — see
 * `envelope.js`, which argues at length that the two must stay distinct.
 * @property {string} verdict What `verify` calls a healthy file in it. Must be a value of `VERDICT`.
 */

/**
 * The character-card cache: SillyTavern's node-persist store of every parsed card.
 *
 * node-persist does its own `fs.readFile`/`fs.writeFile`, so not one byte of it passes through the
 * provider — which is exactly how it came to hold a verbatim plaintext copy of every card, name,
 * description, personality and first message, behind every guard in `provider.js`. See `key-value.js`.
 * @type {OwnStore}
 */
const CHARACTER_CACHE = {
    directory: '_cache/characters',
    skeleton: ['_cache', '_cache/characters'],
    envelope: 'esk1:',
    verdict: 'key-value',
};

/** Every store Vault operates outside its own cipher path. @type {OwnStore[]} */
export const OWN_STORES = [CHARACTER_CACHE];

/** The character-card cache, for the module that operates it. @type {OwnStore} */
export const KEY_VALUE_STORE = CHARACTER_CACHE;

/**
 * Every directory an own store needs to exist keylessly.
 * @returns {string[]} Logical directories that are skeleton
 */
export function ownStoreSkeleton() {
    return OWN_STORES.flatMap(store => store.skeleton);
}

/**
 * Directories whose CONTENTS are named by a library rather than by us.
 * @returns {string[]} Logical directories whose contents keep their given names
 */
export function ownStoreDirectories() {
    return OWN_STORES.map(store => store.directory);
}

/**
 * Which own store, if any, holds this file?
 *
 * 🔴 MATCHED ON THE DIRECTORY, WITH ITS SEPARATOR. `verify.js` used `at.startsWith('_cache/')` — the
 * PARENT of the real store — so anything dropped anywhere under `_cache/` was judged by the key/value
 * store's rules, including a directory the store does not own. Narrower is correct here: a file that is
 * not in a store we operate has no business being classified as one of its entries.
 * @param {string} logicalRelative A logical path within the account
 * @returns {OwnStore|undefined} The store, or undefined
 */
export function ownStoreFor(logicalRelative) {
    return OWN_STORES.find(store => logicalRelative.startsWith(`${store.directory}/`));
}
