import fs from 'node:fs';
import path from 'node:path';

import { normal, sensitive } from './logging.js';
import { STRUCTURAL_DIRECTORIES } from './structure.js';

/**
 * Registry for encrypted stores owned by other plugins and protected with a vault-derived subkey.
 *
 * The vault verifier normally identifies encrypted files by their `STV1` header. SQLCipher databases use a
 * random salt instead, so a legitimate encrypted database would otherwise look like plaintext. A registry
 * lets each consumer declare its directory without coupling the verifier to consumer-specific paths. The
 * directory name remains structural/plaintext, its contents retain the owner's filenames, and its files are
 * classified as `FOREIGN`. Declaring structural names such as `memory` also keeps path decoding from trying to
 * decrypt a literal directory name when a provider walks the user's tree.
 *
 * Registration is a claim, not proof of encryption. Consumers can list forbidden file-header signatures (for
 * example, `SQLite format 3\0`) so the verifier can catch a plaintext SQLite database written when SQLCipher
 * encryption is unavailable. Registrations without signatures remain unverifiable. This check is intended
 * to detect accidental plaintext, not malicious in-process code; unregistered directories remain subject to
 * the ordinary leak checks.
 */

/** Where registrations are persisted, under the data root. See {@link registryPath} before changing it. */
const REGISTRY_DIRECTORY = '_vault';

/** The file itself. */
const REGISTRY_FILENAME = 'vault-foreign-stores.json';

/**
 * @typedef {object} ForeignStore
 * @property {string} directory The store's root, relative to a user's directory. No leading or trailing '/'
 * @property {string} owner Who owns it — named in the report, so an operator knows who to ask
 * @property {string[]} forbidden Head-of-file signatures that must never appear. May be empty
 */

/** @type {Map<string, ForeignStore>} */
// Per provider now -- see `vault-state.js`.

/**
 * Where the registry file lives for a data root.
 * @param {string} dataRoot The data root
 * @returns {string} Absolute path to the registry file
 */
function registryPath(dataRoot) {
    // 🔴 A `_`-PREFIXED DIRECTORY AT THE DATA ROOT, NOT a file inside a user's directory. `verifyUser` walks
    // `<dataRoot>/<handle>`, and anything under there is EVIDENCE — a registry sitting in the middle of the
    // tree being audited would be both a file the audit has to make an exception for and a file the audit's
    // own subject can edit. `paths.js:169-171` already reserves the `_`-prefixed names as SillyTavern's own,
    // so this is outside every vault by construction.
    //
    // 🔴 BUT IT HAS TO BE AN UNOCCUPIED ONE, AND `_storage` IS NOT. It was, and it bricked SillyTavern.
    // `_storage/` is the node-persist ACCOUNT store: node-persist enumerates that whole directory at
    // `init()` and parses every file as `{key, value, ttl}`. A file that is not one is a hard rejection and
    // not a skipped file, with `forgiveParseErrors` off — so the process dies with exit 1 before the port is
    // bound, on every boot, for ever. It takes `recover-password.js` with it, because that calls the same
    // `initUserStorage` against the same directory: an operator locked out of an encrypted install meets a
    // dead server AND a dead recovery path at the same moment, for the same reason.
    //
    // Registration is persisted after node-persist reads the directory, so a colliding file may break the
    // following startup and the recovery CLI even if the current startup succeeds.
    //
    // `_storage` is the node-persist account store. Check the target data root and select an unused reserved
    // directory before changing this path.
    return path.join(dataRoot, REGISTRY_DIRECTORY, REGISTRY_FILENAME);
}

/**
 * Normalise a declared directory to the form `paths.js` speaks: forward slashes, no leading or trailing one.
 * @param {string} directory As declared
 * @returns {string} The logical directory
 */
function normalise(directory) {
    return String(directory ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Declare that a directory belongs to another plugin, which encrypts it itself.
 *
 * 🔴 **THIS IS CALLED BY SILLYTAVERN, NOT BY THE PLUGIN.** It sits on the provider interface exactly as
 * `deriveSubkey` does, and it is reached the same way: the plugin calls `context.registerForeignStore(…)`,
 * `plugin-loader.js` forwards to `storage.js`, `storage.js` forwards to whatever provider is installed.
 * This module must never learn which plugin is on the other end, and no plugin should ever hold a reference
 * to this provider. The registry is generic for that reason: `owner` is a string we report, not a thing we
 * know about.
 *
 * Idempotent: registering the same directory again replaces the previous declaration.
 *
 * ⚠️ The declaration is PERSISTED, and it has to be. The shallow verify is meant to run from cron
 * (`verify.js:29-32`) — a separate process that loads no plugins and would otherwise see an in-memory
 * registry that nobody had registered anything into, and go straight back to reporting the store as
 * PLAINTEXT. That is the exact failure this module exists to end, so the registration outlives the process.
 * @param {string} dataRoot The data root, or '' if `init` has not run yet
 * @param {{directory: string, owner: string, forbidden?: string[]}} store What is being claimed
 * @returns {void}
 */
export function registerForeignStore(vault, store) {
    const directory = normalise(store?.directory);
    const owner = String(store?.owner ?? '').trim();

    if (!directory || !owner) {
        throw new Error('A foreign store needs both a directory and an owner. It is named in the audit report; an anonymous claim is not one.');
    }

    if (directory.startsWith('..') || directory.split('/').includes('..')) {
        throw new Error(`A foreign store must be inside the user's directory: '${directory}' is not.`);
    }

    // 🔴 A REGISTRATION TURNS ENCRYPTION OFF, AND NOTHING HERE USED TO CHECK WHAT IT WAS TURNING IT OFF FOR.
    //
    // The paragraph above ("the limit of this, stated plainly") reasons about the blast radius of a claim on
    // the AUDIT — a wrong claim makes `verify` report someone else's plaintext as FOREIGN rather than as a
    // leak. That is true and it is only half of it, because the same registry also drives the PROVIDER:
    // `resolve()` returns `foreign: true` for the claimed subtree before the lock gate, `isPassthrough` is
    // then true, and `sealBytes` returns the bytes untransformed. So a claim on `chats` or `user/files` does
    // not merely mis-report — it writes every chat and every Data Bank document to disk IN THE CLEAR, from
    // that moment on, while simultaneously blinding the one tool that would have noticed.
    //
    // The two effects together are the failure: encryption off, detector off, no error, exit 0.
    //
    // A malicious registrant is out of scope and stays out of scope — a plugin running in this process has
    // better attacks available. An ACCIDENT is emphatically IN scope, and this is what an accident looks
    // like: `directory: 'vectors'` from a memory plugin that genuinely does own a store, spelled one level
    // too high. Refusing the structural set costs a legitimate plugin nothing, because a plugin's own store
    // is by definition a directory it created, not one SillyTavern's boot template already owns.
    if (STRUCTURAL_DIRECTORIES.has(directory)) {
        throw new Error(
            `A foreign store cannot claim '${directory}': that is one of SillyTavern's own directories. ` +
                'Registering it would switch this provider to passthrough for everything inside it -- ' +
                'writing that user data to disk unencrypted -- and would tell `verify` to report the ' +
                'result as somebody else\'s encrypted data rather than as a leak. Claim a subdirectory ' +
                'your own plugin creates.',
        );
    }

    // The same accident one level down: claiming an ANCESTOR of a structural directory swallows it whole.
    // `user` would take `user/files`, `user/images` and `user/workflows` with it.
    const swallowed = [...STRUCTURAL_DIRECTORIES].filter(known => known.startsWith(`${directory}/`));

    if (swallowed.length > 0) {
        throw new Error(
            `A foreign store cannot claim '${directory}': it contains SillyTavern's own ` +
                `${swallowed.length === 1 ? 'directory' : 'directories'} ${swallowed.map(d => `'${d}'`).join(', ')}, ` +
                'which would be written unencrypted and reported as clean. Claim a subdirectory your own ' +
                'plugin creates.',
        );
    }

    /** @type {ForeignStore} */
    const record = { directory, owner, forbidden: (store?.forbidden ?? []).map(String) };

    vault.foreignStores.set(directory, record);
    persist(vault);

    if (record.forbidden.length === 0) {
        normal().warn(`[vault] Foreign store '${directory}' (${owner}) declares no forbidden signatures, so verify cannot check it. Its files will be reported as unverifiable.`);
    }

    normal().info(`[vault] Foreign store registered: '${directory}' is owned by ${owner} and encrypted by it, not by us.`);
}

/**
 * Write the registry out, if we yet know where.
 *
 * 🔴 **A FALSY DATA ROOT MUST NOT REACH `path.join`.** `lifecycle.dataRoot` is `''` until `init` runs, and
 * plugin load order is the fork's business, not ours — a plugin may well register before the storage
 * provider has been initialised. `path.join('', '_vault', …)` does not throw: it yields the RELATIVE path
 * `_vault/vault-foreign-stores.json`, which lands in the process working directory — the SillyTavern
 * install, not the data root. Silently, in the wrong place, and invisible to every later `verify`.
 *
 * So this defers instead, and {@link flushForeignStores} writes it when `init` supplies the root. The
 * in-memory half is live either way, so the PROVIDER is correct from the moment of the call regardless.
 * @param {string} dataRoot The data root, or '' if not yet known
 * @returns {boolean} Whether it was written
 */
function persist(vault) {
    if (!vault.dataRoot) {
        return false;
    }

    const target = registryPath(vault.dataRoot);
    const body = JSON.stringify({ version: 1, stores: [...vault.foreignStores.values()] }, null, 4);

    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body, 'utf-8');
        return true;
    } catch (error) {
        // Not fatal, and deliberately so: the in-memory half is what keeps the PROVIDER correct, and that
        // half is already done. Losing the file costs the cron verify its knowledge, which degrades to the
        // old false PLAINTEXT — noisy, not dangerous. Refusing to boot a user's storage over it would be.
        normal().error('[vault] Could not persist the foreign-store registry. A standalone \'verify\' run will report those files as PLAINTEXT. Enable logging.debugMode for the path and the error.');
        sensitive().error('[vault] Foreign-store registry write failed:', target, error);
        return false;
    }
}

/**
 * Write out anything that was registered before we knew the data root. Called from `init`.
 *
 * Plugin load order is not ours to control, so "registered before the provider was initialised" is a normal
 * sequence rather than a misuse — and a registration that was only ever held in memory is one the cron
 * verify never sees, which is the whole failure this module exists to end.
 * @param {string} dataRoot The data root, now known
 * @returns {void}
 */
export function flushForeignStores(vault) {
    if (vault.foreignStores.size > 0) {
        persist(vault);
    }
}

/**
 * Load the registry from disk. For a process that loads no plugins — the `verify` CLI.
 * @param {string} dataRoot The data root
 * @returns {ForeignStore[]} What was registered, or nothing at all
 */
export function loadForeignStores(vault, dataRoot) {
    const source = registryPath(dataRoot);

    if (!fs.existsSync(source)) {
        return [];
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(source, 'utf-8'));
        const stores = Array.isArray(parsed?.stores) ? parsed.stores : [];

        for (const store of stores) {
            const directory = normalise(store?.directory);

            if (directory && store?.owner) {
                vault.foreignStores.set(directory, { directory, owner: String(store.owner), forbidden: (store.forbidden ?? []).map(String) });
            }
        }

        return [...vault.foreignStores.values()];
    } catch (error) {
        // A corrupt registry must FAIL LOUD AND FAIL CLOSED. Returning nothing means every foreign file goes
        // back to reading as PLAINTEXT, which is a false alarm the operator can see and act on. Guessing, or
        // treating unparseable as "trust everything", would be a silent hole.
        normal().error('[vault] The foreign-store registry could not be read, so foreign stores will be reported as PLAINTEXT. Enable logging.debugMode for the path and the error.');
        sensitive().error('[vault] Foreign-store registry read failed:', source, error);
        return [];
    }
}

/**
 * Is this logical path a registered foreign store's own root?
 * @param {string} logicalSoFar A logical path within a user's directory
 * @returns {boolean} True if a plugin claimed it
 */
export function isForeignStoreRoot(vault, logicalSoFar) {
    return vault.foreignStores.has(logicalSoFar);
}

/**
 * Is this logical path inside a registered foreign store — the root itself, or anything beneath it?
 * @param {string} logicalPath A logical path within a user's directory
 * @returns {ForeignStore|undefined} The store that owns it, if any
 */
export function foreignStoreFor(vault, logicalPath) {
    const at = normalise(logicalPath);

    for (const store of vault.foreignStores.values()) {
        if (at === store.directory || at.startsWith(`${store.directory}/`)) {
            return store;
        }
    }

    return undefined;
}

/**
 * Forget every registration. For tests, and for nothing else.
 * @returns {void}
 */
export function resetForeignStores(vault) {
    vault.foreignStores.clear();
}
