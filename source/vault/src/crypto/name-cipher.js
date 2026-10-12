import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import { sivEncrypt, sivDecrypt } from './aes-siv.js';
import { NAME_SCHEME_MIXED } from '../name-scheme.js';

/**
 * Filename encryption.
 *
 * Encrypting file CONTENTS and leaving the names alone would be close to pointless. `chats/<character>/
 * <chat title>.jsonl` exposes character names and conversation titles. `characters/<name>.png` exposes the
 * character list. Even directory listings must remain unreadable.
 *
 * ## Four rules, and the fourth one is the one that will bite
 *
 * 1. **Only variable path components are encrypted.** The structural directories — `chats/`,
 *    `characters/`, `worlds/`, `backups/` — carry no information and stay readable. This is also what
 *    lets SillyTavern's `ensurePublicDirectoriesExist` keep walking the tree at boot, before anything is
 *    unlocked. Hide what is private; leave the skeleton alone.
 *
 * 2. **The parent directory is bound into the associated data.** Otherwise `chat_1.jsonl` under two
 *    different characters encrypts identically — leaking that they are the same name, and letting an
 *    attacker move a file between characters and have it still authenticate.
 *
 * 3. **A distinct key** (`k_names`), never the content key.
 *
 * 4. 🔴 **THE LONG-NAME FALLBACK IS MANDATORY.** Encryption plus base64url inflates a name by roughly
 *    1.4×, against a hard 255-byte limit on every filesystem that matters. SillyTavern builds chat
 *    filenames as `<character name> - <timestamp>.jsonl`. So a character with a long name does not
 *    produce an edge case; long names are expected. Handle the fallback here rather than failing with
 *    `ENAMETOOLONG` during an import.
 *
 * The fallback is gocryptfs's: when the encrypted name is too long, store the file under a HASH of that
 * name, and put the real encrypted name in a small companion file beside it.
 */

/**
 * The longest encrypted name we will put on disk directly.
 *
 * The real limit is 255 bytes. We stop well short: the sidecar's own suffix has to fit too, and leaving
 * headroom means a filesystem with a stricter limit does not turn into a support call.
 */
export const MAX_ENCRYPTED_NAME_LENGTH = 180;

/** Long-name files are stored under this prefix, so they are obvious in a directory listing. */
export const LONG_NAME_PREFIX = 'LN.';

/** And their companion file carries the real encrypted name. */
export const LONG_NAME_SUFFIX = '.nm';

/**
 * 🔀 THE TWO NAME SCHEMES, AND WHY A SECOND ONE HAD TO EXIST.
 *
 * Under scheme 1 an encrypted name is bare base64url and nothing else: `Xk3j...`. That is unambiguous in an
 * account where **every** file is ours, which is the only kind of account scheme 1 could produce —
 * `createVaultFor()` used to refuse outright to encrypt an account that already contained data, so under
 * scheme 1 a vault always meant "all of this is mine".
 *
 * Mixed-mode support allows a directory to hold
 * two namespaces at once: legacy plaintext names that predate us, and our ciphertext. Bare base64url can no
 * longer be told from a plaintext filename that happens to look like base64url, and §4 forbids trying to
 * decrypt a name and treating failure as proof that it is plaintext, for the same reason §3 forbids it
 * for contents. It collapses *ours-but-broken* into *not-ours*, and hands a damaged file to the six code
 * paths that respond to unreadable data by regenerating it.
 *
 * So scheme 2 puts a keyless marker on the name. It is chosen per ACCOUNT, recorded in `.vault-keys.json`,
 * and never inferred: an existing scheme-1 account keeps its scheme for ever, because guessing wrong about
 * a live account means serving ciphertext as plaintext to the machinery that repairs files by rewriting
 * them.
 */

// The two scheme numbers now live in `src/name-scheme.js` -- a shared vocabulary rather than something
// the filename cipher owns, because `crypto/vault.js` needs to RECORD a scheme without importing the
// cipher that reads names. Re-exported here so every existing import keeps working.
export { NAME_SCHEME_LEGACY, NAME_SCHEME_MIXED } from '../name-scheme.js';

/**
 * The marker on a scheme-2 encrypted name.
 *
 * `~` is deliberate and doing real work: it is **not in the base64url alphabet** (`A-Z a-z 0-9 - _`), so a
 * marker can never be mistaken for the leading characters of a ciphertext, and it is legal in a filename on
 * every platform the fork supports. The digit is the scheme number, so a future scheme 3 could sit in the
 * same directory as scheme 2 without either being ambiguous.
 */
export const MARKED_NAME_PREFIX = 'venc1~';

/**
 * The same, for a name too long to store directly.
 *
 * A SEPARATE marker rather than the old `LN.` prefix reused inside the marked name, and the reason is the
 * extension: a marked name is `<marker><ciphertext><ext>` and is taken apart by finding the first `.` after
 * the marker, because base64url cannot contain one. `LN.` contains one. Reusing it would put a dot in the
 * middle of the region that is parsed as ciphertext and every long name would decode to garbage.
 */
export const MARKED_LONG_NAME_PREFIX = 'venl1~';

/** Either marker, anchored. The keyless discriminator §4 requires, and the whole of it. */
const MARKED_NAME_PATTERN = /^ven[cl]1~/;

/**
 * Is this on-disk name one this plugin wrote, judged with no key at all?
 *
 * 🔴 THIS IS THE CLASSIFIER FOR NAMES, and it must never grow a fallback. The answer for an unmarked name
 * is "not ours" — full stop, whatever the name looks like and whatever the bytes behind it are. An unmarked
 * name in a scheme-2 account is a file that predates this plugin, and §1 says it stays plaintext for ever.
 * @param {string} fileName An on-disk name
 * @returns {boolean} True if this plugin encrypted it
 */
export function isMarkedName(fileName) {
    return MARKED_NAME_PATTERN.test(fileName);
}

/**
 * Split a marked on-disk name into the parts it was built from.
 *
 * The extension rides in the clear after the ciphertext, so it is found by looking for the first `.` — safe
 * precisely because base64url has no `.` in its alphabet and neither marker contains one.
 * @param {string} fileName A marked on-disk name
 * @returns {{prefix: string, body: string, extension: string}} Its three parts
 */
function splitMarkedName(fileName) {
    const prefix = fileName.slice(0, MARKED_NAME_PREFIX.length);
    const rest = fileName.slice(prefix.length);
    const dot = rest.indexOf('.');

    return dot < 0
        ? { prefix, body: rest, extension: '' }
        : { prefix, body: rest.slice(0, dot), extension: rest.slice(dot) };
}

/**
 * Encrypt one path component.
 *
 * Deterministic: the same name in the same directory always produces the same ciphertext, which is what
 * makes it possible to open a file by name instead of trial-decrypting a whole directory.
 * @param {Buffer} kNames The 64-byte name key
 * @param {string} parent The parent directory's LOGICAL path — bound in as associated data
 * @param {string} name The logical name
 * @returns {string} The encrypted name, base64url
 */
export function encryptName(kNames, parent, name) {
    const sealed = sivEncrypt(kNames, [Buffer.from(parent, 'utf-8')], Buffer.from(name, 'utf-8'));
    return sealed.toString('base64url');
}

/**
 * Decrypt one path component.
 * @param {Buffer} kNames The name key
 * @param {string} parent The parent directory's logical path
 * @param {string} encrypted The encrypted name, base64url
 * @returns {string} The logical name
 */
export function decryptName(kNames, parent, encrypted) {
    const sealed = Buffer.from(encrypted, 'base64url');
    return sivDecrypt(kNames, [Buffer.from(parent, 'utf-8')], sealed).toString('utf-8');
}

/**
 * What a name looks like once it is ready to hit the disk.
 *
 * @typedef {object} StoredName
 * @property {string} fileName What the file is actually called on disk
 * @property {boolean} isLong Whether the long-name fallback was needed
 * @property {string} [sidecarName] The companion file's name, if one is needed
 * @property {string} [sidecarContent] The full encrypted name, to be written into the companion file
 */

/**
 * Work out how a logical name must be stored.
 *
 * Short names are stored under their ciphertext. Long ones are stored under a hash of it, with the
 * ciphertext moved into a companion file — because the ciphertext is the only thing that can be
 * decrypted back, and it will not fit in the filename any more.
 * @param {Buffer} kNames The name key
 * @param {string} parent The parent directory's logical path
 * @param {string} name The logical name
 * @returns {StoredName} How to store it
 */
export function storeName(kNames, parent, name, scheme) {
    const encrypted = encryptName(kNames, parent, name);

    // 🔴 THE WHOLE LOGICAL NAME GOES INTO THE CIPHERTEXT, EXTENSION INCLUDED, and the extension is then
    // ALSO written in the clear on the end. The duplication is deliberate and it is not redundancy.
    //
    // The clear copy exists because of a constraint the fork's lifecycle test discovered (§14.2): every
    // lister that surfaces a chat -- `/api/characters/chats`, `/api/chats/search`, `/api/backups/chat/get`
    // -- filters raw `fs` entries by `path.extname(name) === '.jsonl'`, and in the UNINSTALLED state there
    // is no plugin to demangle the name first. A scheme that hid the extension inside the ciphertext would
    // make every encrypted chat vanish from exactly the lists §11 insists it must appear in, which is the
    // "my data is gone" outcome the whole feature exists to prevent.
    //
    // The encrypted copy exists because the clear one is UNAUTHENTICATED. It sits outside the SIV, so
    // anyone who can rename a file on disk can change it. If the logical name were reassembled as
    // `decrypt(stem) + clearExtension`, that rename would silently change what SillyTavern believes the
    // file is called. Taking the name wholly from the ciphertext makes the clear copy a hint the listers
    // read and nothing else: tamper with it and the file drops out of a filtered list -- visible, and
    // recoverable by renaming it back -- rather than quietly becoming a different file.
    //
    // What it costs is the length of the extension, twice. What it buys is that the on-disk name has no
    // authority over the logical one.
    const extension = extensionOf(name, scheme);
    const marked = scheme === NAME_SCHEME_MIXED;
    const prefix = marked ? MARKED_NAME_PREFIX : '';
    const fileName = `${prefix}${encrypted}${extension}`;

    if (fileName.length <= MAX_ENCRYPTED_NAME_LENGTH) {
        return { fileName, isLong: false };
    }

    // Too long for the filesystem. Hash the ciphertext down to a fixed size and stash the real thing
    // next to it. The hash is of the CIPHERTEXT, not the plaintext, so it leaks nothing beyond what
    // determinism already leaks: that two files have the same name.
    const digest = crypto.createHash('sha256').update(encrypted).digest('base64url');
    const longName = marked
        ? `${MARKED_LONG_NAME_PREFIX}${digest}${extension}`
        : `${LONG_NAME_PREFIX}${digest}`;

    return {
        fileName: longName,
        isLong: true,
        sidecarName: `${longName}${LONG_NAME_SUFFIX}`,
        sidecarContent: encrypted,
    };
}

/**
 * The extension to carry in the clear, if this scheme carries one.
 *
 * Scheme 1 never did, and must not start: its names are already on disk without one, and appending an
 * extension now would change the name of every file in every existing account.
 * @param {string} name The logical name
 * @param {number} scheme The account's name scheme
 * @returns {string} The extension including its dot, or an empty string
 */
function extensionOf(name, scheme) {
    if (scheme !== NAME_SCHEME_MIXED) {
        return '';
    }

    const dot = name.lastIndexOf('.');

    // `path.extname` semantics, done by hand rather than importing `path` into a crypto module: no dot at
    // all, or a name that IS a dot-file (`.htaccess` has no extension, it has a name), both mean "none".
    if (dot < 1) {
        return '';
    }

    const extension = name.slice(dot);

    // A bare trailing dot is not an extension, and an absurdly long one is dropped rather than written
    // twice: it would be pure cost, and it is the long-name fallback -- not this -- that keeps the on-disk
    // name inside the filesystem's limit. Sixteen covers every extension SillyTavern actually produces.
    return extension === '.' || extension.length > 16 ? '' : extension;
}

/**
 * Is this on-disk name a long-name placeholder?
 *
 * ⚠️ PASS `hasSibling` WHEREVER THE LISTING IS IN HAND. Without it, a long name whose logical extension is
 * `.nm` reads as a companion file instead -- the safe answer, but the wrong one. See `carriesOwnCompanion`.
 * @param {string} fileName The name on disk
 * @param {(name: string) => boolean} [hasSibling] Does a given name exist in the same directory?
 * @returns {boolean} True if its real name lives in a companion file
 */
export function isLongName(fileName, hasSibling) {
    const prefix = isMarkedName(fileName) ? MARKED_LONG_NAME_PREFIX : LONG_NAME_PREFIX;

    if (!fileName.startsWith(prefix)) {
        return false;
    }

    return !fileName.endsWith(LONG_NAME_SUFFIX) || carriesOwnCompanion(fileName, hasSibling);
}

/**
 * Does this suffixed name have a companion of its OWN, one entry further out?
 *
 * 🔴 THIS IS THE WHOLE DISAMBIGUATION, AND IT NEEDS NO FORMAT CHANGE. `venl1~<digest>.nm` is ambiguous read
 * alone, but it is not ambiguous read in its own directory. Every long name has exactly one companion, named
 * by appending the suffix -- so the two readings imply different neighbours, and only one set can be present:
 *
 *   the COMPANION of `venl1~<d>`          -> `venl1~<d>` is on disk, `venl1~<d>.nm.nm` is NOT
 *   a long name whose extension is `.nm`  -> `venl1~<d>.nm.nm` IS on disk, holding its ciphertext name
 *
 * For both to hold at once, one SHA-256 digest would have to be the hash of two different encrypted names.
 * So the companion's presence settles it outright, and it settles it from the listing the caller already
 * holds: no extra `stat`, nothing new on disk, and every vault written before this still reads correctly.
 *
 * ⚠️ NO PREDICATE MEANS THE OLD ANSWER, DELIBERATELY. A caller with no listing genuinely cannot tell the two
 * apart, and "it is a companion" is the safer of the two: hiding a user's file is recoverable by anyone who
 * looks, whereas handing a companion to SillyTavern as a chat invites `data-maid` to offer to delete the one
 * copy of somebody's filename. Every caller that CAN answer does; this is the floor, not the intended path.
 * @param {string} fileName The name on disk, already known to end in the suffix
 * @param {(name: string) => boolean} [hasSibling] Does a given name exist in the same directory?
 * @returns {boolean} True if this name is a long name in its own right, not a companion
 */
function carriesOwnCompanion(fileName, hasSibling) {
    return typeof hasSibling === 'function' && hasSibling(`${fileName}${LONG_NAME_SUFFIX}`);
}

/**
 * Is this on-disk name a companion file, rather than a file the user has ever heard of?
 *
 * The provider must hide these from `readdir`. If a sidecar ever leaked into a directory listing,
 * SillyTavern would try to parse it as a chat — and `data-maid` would offer to delete it as an orphan.
 * @param {string} fileName The name on disk
 * @param {(name: string) => boolean} [hasSibling] Does a given name exist in the same directory?
 * @returns {boolean} True if this is bookkeeping, not user data
 */
export function isSidecar(fileName, hasSibling) {
    if (!fileName.endsWith(LONG_NAME_SUFFIX)) {
        return false;
    }

    // 🔴 THE SUFFIX ALONE IS NOT ENOUGH ANY MORE, and mixed mode is what changed that. Hiding an entry from
    // `readdir` is not cosmetic — SillyTavern never learns the file exists, so it can neither open it nor
    // list it, and `data-maid` cannot be asked about it either. That was safe while every file in a vaulted
    // account was one we wrote; it stops being safe the moment a directory also holds files that predate us,
    // because a user's own `notes.nm` would then be swallowed silently by a plugin they installed for
    // encryption. A sidecar is one of OURS, so it carries one of our prefixes; anything else with the same
    // suffix is somebody's file and must be listed.
    // 🔴 A LONG-NAME PREFIX, NOT ANY MARKED PREFIX -- `isMarkedName` ALSO MATCHES `venc1~`, WHICH IS THE
    // HOLE THE PARAGRAPH ABOVE WAS TRYING TO CLOSE AND MISSED.
    //
    // Under scheme 2 a short name carries its logical extension in the clear, so a user file genuinely
    // called `notes.nm` is stored as `venc1~<ciphertext>.nm`. That ends in `.nm` and is a marked name, so
    // the old test called it bookkeeping and `readdir` hid it -- from SillyTavern, from the UI, and from
    // `data-maid`. Encrypted correctly, sitting on the disk, and invisible for ever: exactly the outcome
    // this guard exists to prevent, reached from the one direction it did not look.
    //
    // Only a LONG name ever has a companion, so only a long prefix can precede one.
    //
    // ⚠️ AND THE LAST AMBIGUITY IS SETTLED BY THE DIRECTORY, NOT BY THE NAME.
    // `venl1~<digest>.nm` is both the companion of `venl1~<digest>` and the stored form of a logical name
    // over ~113 characters that ends in `.nm`. Read alone the name cannot say which; read beside its
    // neighbours it can, because only one of the two readings puts a `.nm.nm` on disk. `carriesOwnCompanion`
    // is that test, and the comment on it is where the reasoning lives. A caller that passes no predicate
    // still gets the old answer -- companion -- which is the safe direction and was the previous behaviour.
    if (!fileName.startsWith(LONG_NAME_PREFIX) && !fileName.startsWith(MARKED_LONG_NAME_PREFIX)) {
        return false;
    }

    return !carriesOwnCompanion(fileName, hasSibling);
}

/**
 * Recover the logical name from what is on disk.
 * @param {Buffer} kNames The name key
 * @param {string} parent The parent directory's logical path
 * @param {string} fileName The name on disk
 * @param {(sidecarName: string) => string} readSidecar Reads a companion file, given its name
 * @param {(name: string) => boolean} [hasSibling] Does a given name exist in the same directory?
 * @returns {string} The logical name
 */
export function loadName(kNames, parent, fileName, readSidecar, hasSibling) {
    if (!isLongName(fileName, hasSibling)) {
        // The clear extension on a marked name is a hint for the listers and carries no authority: the
        // logical name comes wholly out of the ciphertext, extension and all. See `storeName`.
        const ciphertext = isMarkedName(fileName) ? splitMarkedName(fileName).body : fileName;
        return decryptName(kNames, parent, ciphertext);
    }

    const encrypted = readSidecar(`${fileName}${LONG_NAME_SUFFIX}`);

    if (!encrypted) {
        throw new Error(`The long-name companion file for '${fileName}' is missing. The name cannot be recovered.`);
    }

    return decryptName(kNames, parent, encrypted.trim());
}
