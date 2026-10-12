/**
 * The shapes that cross the boundary between SillyTavern and this plugin.
 *
 * 🔴 THIS FILE DID NOT EXIST, AND TWO MODULES ALREADY IMPORTED TYPES FROM IT.
 *
 * `lifecycle.js` and `preconditions.js` both wrote
 * `@param {import('./types.js').StorageProviderContext}` against a file that was not there, so the one
 * object every entry point in this plugin is handed had no declaration anywhere — while being read
 * field-by-field in four separate modules, each reaching for something different:
 *
 *     lifecycle.js      dataRoot, users
 *     preconditions.js  accountsEnabled, authenticationDelegated, users
 *     logging.js        logger, LogClass
 *
 * ⚠️ **NOTHING HERE IS ENFORCED AT RUNTIME, AND IT MUST NOT PRETEND TO BE.** These are JSDoc typedefs: they
 * document what the fork promises and give an editor something to check against. The actual defences are
 * `preconditions.assertUsable`, which refuses to boot on a configuration where the lock would be a
 * decoration, and `logging.adoptLogger`, whose eight-clause structural guard assumes nothing at all —
 * because a fork that has not been redeployed yet is the normal case, not an error.
 *
 * There is no runtime export here on purpose. A module that exists only to be imported by a type
 * annotation should not also be a thing that runs.
 */

/**
 * One SillyTavern account, as the boot context describes it.
 * @typedef {object} StorageProviderUser
 * @property {string} handle The account's directory name under the data root, and its identity everywhere
 * in this plugin. 🔴 User-authored — see `logging.js`. It is never NORMAL-logged.
 * @property {boolean} enabled Is the account active?
 * @property {boolean} hasPassword Does it have a password at all? An account without one cannot have a
 * vault worth the name, which is what `preconditions.js` refuses to boot over.
 */

/**
 * A classified logger, as the fork hands it over.
 *
 * ⚠️ Every method takes the log CLASS as its first argument, ahead of the message. `logging.js` binds that
 * argument rather than wrapping the call, so the fork's one-frame stack attribution still names the real
 * call site rather than naming us.
 * @typedef {object} StorageProviderLogger
 * @property {(logClass: number, ...args: any[]) => void} debug
 * @property {(logClass: number, ...args: any[]) => void} info
 * @property {(logClass: number, ...args: any[]) => void} warn
 * @property {(logClass: number, ...args: any[]) => void} error
 */

/**
 * The boot context, handed to `init` once, at startup.
 *
 * 🔴 `logger` AND `LogClass` ARE OPTIONAL, AND THE OPTIONALITY IS LOAD-BEARING. A fork that has not been
 * redeployed passes neither, and that is not an error — `adoptLogger` returns `false` and everything falls
 * back to `console`, captured SENSITIVE. Treating their absence as a failure would make this plugin refuse
 * to start on the exact deployment it is most likely to meet.
 * @typedef {object} StorageProviderContext
 * @property {string} dataRoot Absolute path to SillyTavern's data directory — the parent of every account.
 * @property {StorageProviderUser[]} users Every account the fork knows about, at boot. Authoritative:
 * without it `paths.isUserHandle` has to guess which top-level names are accounts, and it guessed wrong
 * (it decided `content.log` was a user called "content.log").
 * @property {boolean} accountsEnabled Is multi-account mode on? Off means one shared account with no
 * password, which `preconditions.js` refuses.
 * @property {boolean} [authenticationDelegated] Is login handled by something in front of SillyTavern? If
 * so, SillyTavern never sees a password, so there is nothing to derive a key from.
 * @property {boolean} [basicAuthMode] Is HTTP basic auth in front of it?
 * @property {StorageProviderLogger} [logger] The fork's classified logger, if this build has one.
 * @property {{NORMAL: number, SENSITIVE: number}} [LogClass] The class enum, read from the fork rather
 * than hard-coded — a renumber upstream must not silently reclassify every line this plugin writes.
 */

export {};
