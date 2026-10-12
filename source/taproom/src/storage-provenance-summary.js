import path from 'node:path';

import * as storage from './storage.js';
import { describeStorageState } from './storage-status.js';
import { log, LogClass } from './logger.js';

/**
 * 🪪 SURFACE 5 — "I UNINSTALLED SOMETHING. WHAT DID IT TAKE WITH IT?" — `DESIGN_STORAGE_PROVENANCE.md` §7
 * surface 5.
 *
 * Surfaces 1–4 each answer for the one file, list, or editor the user happens to be looking at. None of them
 * answers the question a worried user actually has the moment a provider is gone: *how much of my data is
 * behind it, and across which kinds of thing?* This walks a single user's data root, asks the one shared
 * "what state are these bytes in?" question of every file (`describeStorageState`), and tallies the
 * unavailable ones by the provider they need and the kind of data they are.
 *
 * ## 🔴 THE WALK IS OVER LOGICAL NAMES, AND THAT IS THE WHOLE CORRECTNESS ARGUMENT
 *
 * `describeStorageState` reads raw `fs` at the path it is given (`storage-status.js`). That is correct ONLY
 * where the on-disk name equals the logical name — the provider-gone case, which is exactly what this panel
 * exists for. But this panel may also be opened while a name-encrypting provider is still installed, and
 * there the two names differ: the file the user calls `my-chat.jsonl` sits on disk as `venc1~<cipher>.jsonl`.
 *
 * So the listing goes through `storage.readdir`, which returns LOGICAL names (demangled by the provider when
 * one is loaded, and the plain on-disk names when none is), and every path handed to `describeStorageState`
 * is the LOGICAL path. The consequences, both of which the tests pin:
 *
 * - **Provider installed and readable → nothing is counted.** `describeStorageState` on the logical path hits
 *   `encryptsPath`, which is `true`, so the state is `encrypted && !unavailable` and the file is skipped. Ask
 *   the on-disk mangled name instead and raw `fs` would see the envelope, find no installed provider claiming
 *   that literal path, and wrongly count the provider's own live data as lost. This is the landmine
 *   `storage-status.js` and the mixed-provider fixture both warn about.
 * - **Provider gone → the file counts.** `storage.readdir` is plain `fs`, the mangled name IS the logical
 *   name (nothing can demangle it), the extension rode along in the clear so the file still lists, and
 *   `describeStorageState` reads the content envelope keylessly and reports `unavailable` with the id.
 *
 * ## 🔴 THE ID IS A KEY, NEVER A SOURCE OF TRUTH (§4)
 *
 * Everything about a provider's identity comes from `describeStorageState` → the fork's own registry, written
 * while that provider ran. A file naming a provider that was never installed here tallies under its bare id
 * with a null identity — it cannot introduce a provider, only ask after one. That keeps a restored-from-
 * elsewhere data directory the boring case §4 designed it to be.
 */

/**
 * The data types this panel enumerates, and where each lives under a user's directory list.
 *
 * This is the same set §7 surface 4 wired one endpoint at a time, plus the two — chats and group chats —
 * that surfaces 1–3 already mark per row. Gathering all of them in one place is the point of surface 5: the
 * per-surface markers tell a user about the file in front of them, and this tells them about the whole
 * account at once.
 *
 * 🔴 THE NOUN KEYS ARE FORK CONSTANTS, matched on the client to `DATA_NOUNS` — never a value off the disk.
 * The client turns `chat` into "chats" and `world` into "world info files"; a filename or a provider string
 * must never reach that mapping (§3.1).
 * @type {ReadonlyArray<{type: string, dir: (d: import('./users.js').UserDirectoryList) => string, ext: string|null, nested: boolean}>}
 */
const DATA_TYPES = Object.freeze([
    { type: 'chat', dir: d => d.chats, ext: '.jsonl', nested: true },
    { type: 'group-chat', dir: d => d.groupChats, ext: '.jsonl', nested: false },
    { type: 'character', dir: d => d.characters, ext: '.png', nested: false },
    { type: 'world', dir: d => d.worlds, ext: '.json', nested: false },
    { type: 'group', dir: d => d.groups, ext: '.json', nested: false },
    { type: 'background', dir: d => d.backgrounds, ext: null, nested: false },
]);

/**
 * The one file that is not a directory of files: the user's settings.
 * @type {string}
 */
const SETTINGS_FILE = 'settings.json';

/**
 * A cap on how many files one scan will look at, so a pathological data root cannot turn an on-demand button
 * into an unbounded walk. Generous — a real account is nowhere near it — and when it IS hit the summary says
 * so rather than quietly under-counting, because a panel that promises "here is everything affected" and
 * silently stops is worse than one that admits it stopped (the "no silent caps" rule).
 */
const MAX_FILES_SCANNED = 50_000;

/**
 * @typedef {object} ProviderNeed
 * @property {string|null} id The provider id every counted file names, or null for files whose id failed the
 * envelope's own character class — real unavailable data the fork cannot put a name to.
 * @property {import('./storage-provenance.js').ProviderIdentity|null} identity What the fork recorded about
 * that provider while it ran, or null when it has no record — a planted id, or a provider that never declared.
 * @property {number} total Every unavailable file that needs this provider, across all types.
 * @property {Record<string, number>} counts The total broken down by data type (`chat`, `character`, …).
 */

/**
 * @typedef {object} UnavailableSummary
 * @property {ProviderNeed[]} providers One entry per distinct provider the account's unavailable data needs,
 * ordered most-affected first. Empty when nothing is unavailable — the reassuring, and common, answer.
 * @property {boolean} truncated True if the scan hit {@link MAX_FILES_SCANNED} and the counts are a floor,
 * not a total.
 * @property {boolean} incomplete True if a data directory could not be listed at all, so part of the account
 * was never looked at. Distinct from `truncated`: that one stopped early, this one could not see.
 */

/**
 * Walk one user's data root and tally the data that needs an absent provider.
 *
 * Never throws: a directory that does not exist, or cannot be listed, contributes nothing rather than failing
 * the whole scan — the same "an enrichment, never a dependency" rule the registry follows. A settings file
 * that is fine, a worlds directory that was deleted, a background that reads normally: all simply do not
 * appear in the result.
 * @param {import('./users.js').UserDirectoryList} directories One user's directory list
 * @returns {UnavailableSummary} The grouped counts
 */
export function summariseUnavailableData(directories) {
    /** @type {Map<string, ProviderNeed>} keyed by id, with '' standing in for the null (unknown) id. */
    const needs = new Map();
    const budget = { remaining: MAX_FILES_SCANNED, truncated: false, incomplete: false };

    /**
     * Fold one file's state into the running tally, if it is unavailable.
     * @param {string} type The fork's noun key for this file's kind of data
     * @param {string} absPath The LOGICAL absolute path — see the header on why it must be logical
     * @returns {void}
     */
    function consider(type, absPath) {
        if (budget.remaining <= 0) {
            budget.truncated = true;
            return;
        }

        budget.remaining -= 1;

        const state = describeStorageState(absPath);

        if (!state.unavailable) {
            return;
        }

        const id = state.requiresProvider ?? null;
        const key = id ?? '';
        const need = needs.get(key) ?? { id, identity: state.identity ?? null, total: 0, counts: {} };

        need.total += 1;
        need.counts[type] = (need.counts[type] ?? 0) + 1;

        // The identity is the same for every file naming one id (it comes from the registry, not the file),
        // so the first non-null wins and later files only add to the count. Keeping the first also means a
        // planted file that names a real id after a genuine one cannot blank an identity already resolved.
        if (!need.identity && state.identity) {
            need.identity = state.identity;
        }

        needs.set(key, need);
    }

    for (const { type, dir, ext, nested } of DATA_TYPES) {
        walkType(directories, dir(directories), ext, nested, type, consider, budget);
    }

    consider('settings', path.join(directories.root, SETTINGS_FILE));

    const providers = [...needs.values()].sort((a, b) => b.total - a.total);
    return { providers, truncated: budget.truncated, incomplete: budget.incomplete };
}

/**
 * List one data-type directory (one level, or two for chats) and hand each file to {@link consider}.
 *
 * 🔴 EXTENSION-FILTERED, AND THE FILTER IS WHAT SURVIVES A NAME-ENCRYPTING PROVIDER. With the provider gone
 * a chat's on-disk name is scrambled but keeps its `.jsonl` (the fixture and Vault both keep the extension in
 * the clear for exactly this reason), so `path.extname` still recognises it. Backgrounds carry many
 * extensions and are filtered by `ext: null` — every file is offered, and only an enveloped one is ever
 * counted, so a stray non-image contributes nothing.
 * @param {import('./users.js').UserDirectoryList} directories The user's directory list
 * @param {string} root The directory to walk
 * @param {string|null} ext The extension to keep, or null to consider every file
 * @param {boolean} nested True when this directory holds subdirectories of files (chats/<character>/<chat>)
 * @param {string} type The fork noun key for this data type
 * @param {(type: string, absPath: string) => void} consider The tally callback
 * @param {{remaining: number, truncated: boolean, incomplete: boolean}} budget The scan budget, to stop a
 * runaway walk and to record what could not be read
 * @returns {void}
 */
function walkType(directories, root, ext, nested, type, consider, budget) {
    if (!root || budget.remaining <= 0) {
        return;
    }

    for (const entry of listNames(root, nested, budget)) {
        if (budget.remaining <= 0) {
            budget.truncated = true;
            return;
        }

        if (nested) {
            // The nested level is chats/<character>/. The <character> directory names are not enveloped
            // (directories are never mangled), so this is a plain recurse one level down.
            for (const file of listNames(path.join(root, entry), false, budget)) {
                if (matchesExt(file, ext)) {
                    consider(type, path.join(root, entry, file));
                }
            }
            continue;
        }

        if (matchesExt(entry, ext)) {
            consider(type, path.join(root, entry));
        }
    }
}

/**
 * The LOGICAL names in a directory, or an empty list if it cannot be read.
 *
 * Through `storage.readdir` so the names are logical (see the header). A missing or unreadable directory is
 * the normal case for an account that never used a given data type, so it is swallowed to `[]` rather than
 * thrown — this is a survey, and a gap in it is not an error.
 *
 * ⚠️ `withFileTypes` is deliberately NOT used. The nested walk needs to descend into subdirectories, but a
 * flat directory that happens to contain a stray subdirectory would have that subdirectory offered to
 * `describeStorageState`, which returns not-unavailable for a directory path and so counts nothing. Names
 * alone keep this simple and the miscount impossible.
 * @param {string} directory The directory to list
 * @param {boolean} _nested Unused; kept so the two call sites read symmetrically
 * @returns {string[]} The logical entry names
 */
function listNames(directory, _nested, budget) {
    try {
        if (!storage.exists(directory)) {
            return [];
        }

        return storage.readdir(directory).map(name => String(name));
    } catch (error) {
        // 🔴 A DIRECTORY THAT THREW IS NOT A DIRECTORY THAT WAS EMPTY, AND ONLY ONE OF THOSE IS SILENT.
        //
        // An absent directory is ordinary — an account that has never made a group has no groups folder — and
        // it contributes nothing, correctly. A directory that REFUSED to list is the opposite: it may hold
        // every affected file on the account, and returning [] for it reported a partial scan as a complete
        // one. With no provider installed this is plain `fs.readdirSync`, so any EACCES, EPERM or EIO — a
        // permission-mangled restore, a NAS mount hiccup, a directory left owned by another uid after a
        // container change — silently dropped a whole data type. The user is then told, with counts and
        // confidence, that their characters are fine because their characters could not be looked at.
        //
        // ⚠️ This is a SEPARATE flag from `truncated`. That one means "we stopped early, the counts are a
        // floor"; this means "we could not see part of it at all". Both are honesty about the same answer,
        // and neither implies the other.
        if (budget) {
            budget.incomplete = true;
        }

        log.warn(LogClass.NORMAL, 'A data directory could not be listed while summarising storage; the summary is incomplete.');
        log.warn(LogClass.SENSITIVE, `Could not list ${directory}:`, error);
        return [];
    }
}

/**
 * Does this name carry the extension this data type wants?
 * @param {string} name A single file name
 * @param {string|null} ext The wanted extension, or null to accept anything
 * @returns {boolean} True if it should be considered
 */
function matchesExt(name, ext) {
    return ext === null || path.extname(name).toLowerCase() === ext;
}
