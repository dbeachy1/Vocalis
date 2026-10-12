/**
 * EVERYTHING ONE PROVIDER KNOWS, IN ONE OBJECT THAT THE PROVIDER OWNS.
 *
 * 🔴 `createVaultProvider()` LOOKED LIKE A FACTORY AND WAS NOT ONE.
 *
 * Every piece of state behind it was module-global: the data root, the unlocked key table, the known
 * handles, the foreign-store registry, the name-scheme cache and the pending recovery keys. So two
 * providers built in one process were not two providers. They were one provider with two front doors,
 * silently sharing six things — including the keys.
 *
 * ## What that actually cost, on the record
 *
 * Not a production bug. Something worse, and this repo has it written down already
 * (`tests/verify.test.js`):
 *
 * > *"The first version of these went through the provider, and it was **VACUOUS**. `lifecycle`'s
 * > `dataRoot` is module-level state shared by every provider instance in the process, and the suite's
 * > `beforeEach` has already set it — so a freshly-created provider does not see the pre-init condition
 * > at all, and the test passed happily with the guard deleted. Mutation testing caught it; nothing else
 * > would have."*
 *
 * A test that passes with the guard deleted is the worst thing a suite can contain, and global state is
 * what produced it. It could not be fixed by writing a better test, because the shared state was upstream
 * of every test that could be written.
 *
 * ## What is here, and what deliberately is not
 *
 * Six things are per-provider, because each is a fact about ONE data root:
 *
 *     dataRoot        which tree this provider serves
 *     handles         who the accounts are, from the boot context
 *     sessions        the unlocked DEKs and subkeys. RAM only. See `session.js`.
 *     foreignStores   directories another plugin claimed, under THIS data root
 *     schemeCache     each account's filename scheme, immutable per vault
 *     recoveryKeys    minted, not yet acknowledged, held for one collection
 *
 * ⚠️ **THE LOG SINKS ARE NOT HERE, AND THAT IS NOT AN OVERSIGHT.** The fork hands ONE logger to the
 * process, at boot, in the storage-provider context. It is a property of the process, not of a provider,
 * and a second provider does not get a second logger to adopt. Making it per-instance would invent an
 * ownership that does not exist and let two providers disagree about where warnings go. `logging.js`
 * keeps its module-level sinks, and `resetLogging()` remains the way to put them back.
 *
 * ## ⚠️ The DEKs live in here
 *
 * `sessions` holds live key material. Dropping a reference to a state object does NOT wipe it — the
 * buffers survive in the heap until the garbage collector gets to them, which is exactly the window
 * `session.close()` exists to close. **Shutting a provider down means `session.closeAll(vault)`, not
 * letting the object go.**
 */

/**
 * @typedef {object} VaultState
 * @property {string} dataRoot The data root this provider serves. Empty until `init`.
 * @property {Set<string>} handles Account handles, from the boot context.
 * @property {Map<string, import('./session.js').UnlockedKeys>} sessions handle -> keys. RAM ONLY.
 * @property {Map<string, {directory: string, owner: string, forbidden: string[]}>} foreignStores
 * Registered foreign stores, keyed by directory.
 * @property {Map<string, number>} schemeCache handle -> name scheme.
 * @property {Map<string, string>} recoveryKeys handle -> a minted, unacknowledged recovery key.
 * @property {Map<string, Promise<void>>} keyFileLocks handle -> the tail of the in-flight chain of
 * operations that read-modify-write that account's vault-keys file. See `withKeyFileLock`.
 */

/**
 * A provider's own state, empty.
 * @returns {VaultState} Fresh state, owned by exactly one provider
 */
export function createVaultState() {
    return {
        dataRoot: '',
        handles: new Set(),
        sessions: new Map(),
        foreignStores: new Map(),
        schemeCache: new Map(),
        recoveryKeys: new Map(),
        keyFileLocks: new Map(),
    };
}
