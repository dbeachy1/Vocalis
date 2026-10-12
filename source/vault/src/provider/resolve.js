import fs from 'node:fs';
import path from 'node:path';

import { NAME_SCHEME_MIXED } from '../crypto/name-cipher.js';
import { nameSchemeFor } from '../vault-store.js';
import * as paths from '../paths.js';
import * as session from '../session.js';
import { foreignStoreFor } from '../foreign-stores.js';
import { unavailable } from '../errors.js';

/**
 * WHAT IS AT THIS LOGICAL PATH, AND WHOSE BYTES ARE THEY?
 *
 * One question, asked in four parts, and every one of them has to be answerable in states where the others
 * are not:
 *
 *     where is it on the disk        -- needs the name key, unless the path is all skeleton
 *     may we look at it at all       -- needs to be decidable while LOCKED
 *     did WE write those bytes       -- from the NAME, keylessly, never from a trial decrypt
 *     what companion files exist     -- against the physical name the walk actually chose
 *
 * ⚠️ NOTHING HERE TRANSFORMS A BYTE. That is `codec.js`, one layer up, and the separation is the point:
 * classification decides what the bytes ARE, and it has to be right before anything decides what to DO
 * with them. The two failure modes this module exists to prevent -- serving ciphertext as plaintext, and
 * reporting present-but-unreadable data as absent -- are both classification mistakes, not cipher ones.
 */

/**
 * Resolve a logical path to a physical one, or explain why we cannot.
 * @param {string} absPath The logical absolute path
 * @returns {{handle: string, logical: string, physical: string, keys: import('./session.js').UnlockedKeys|undefined, foreign: boolean}}
 * The resolution
 */
export function resolve(vault, absPath, preferClearLeaf = false) {
    const dataRoot = vault.dataRoot;
    const owned = paths.split(vault, absPath);

    if (!owned) {
        // Not user data. SillyTavern's own shared directories, and none of our business.
        return { handle: '', logical: '', physical: path.resolve(absPath), keys: undefined, scheme: 0, ours: false, foreign: false };
    }

    const { handle, relative } = owned;
    const keys = session.providerKeys(vault, handle);
    const scheme = nameSchemeFor(vault, handle);
    const userRoot = paths.userRoot(dataRoot, handle);
    const inClear = path.join(userRoot, ...(relative ? relative.split('/') : []));

    // 🔀 A FOREIGN STORE IS NOT OURS IN EITHER DIRECTION, AND NOT IN EITHER STATE.
    //
    // Its owner took a subkey, encrypted its own files under it and named them itself, so there is nothing
    // here for us to transform and nothing for us to decode. The registry is the whole of what we know about
    // it (see foreign-stores.js) and it needs no key, which is what makes this decidable while shut.
    //
    // 🔴 IT HAS TO COME BEFORE THE LOCK GATE, AND ABOVE ALL BEFORE THE WALK. That was the bug: while LOCKED
    // `isAllStructural('memory/store.db')` is false — the store's ROOT is skeleton, the file inside it is
    // not — so a shut vault refused it; and while UNLOCKED it fell through to the walk and came back `ours`,
    // so the read path went looking for an envelope that was never on it and raised EPROVIDER.
    //
    // The caller that found this was `POST /api/users/backup`. A backup reads every file in an account
    // THROUGH this provider, deliberately — an archive of raw ciphertext would be unrestorable — which makes
    // it the first thing to touch every file in an account and therefore the first to notice. The user got a
    // 200 and then a connection that died part-way through the zip. Anything else that walks a whole tree —
    // an export, an integrity check, a migration — hits the identical wall.
    //
    // The walk would produce this same physical path anyway: the root is structural and everything beneath
    // it is library-named, so every component passes through verbatim. What the early return adds is that it
    // does so WITHOUT A KEY, and that `isPassthrough` can then see what this is.
    if (relative && foreignStoreFor(vault, relative)) {
        return { handle, logical: relative, physical: inClear, keys, scheme, ours: false, foreign: true };
    }

    // 🔀 A FILE THAT PREDATES US NEEDS NO KEY, AND A LOCKED VAULT MUST STILL SERVE IT.
    //
    // This is the property mixed mode exists for, seen from the least convenient angle. §1: "uninstalling
    // gives you your install back" — and a shut vault is a weaker version of being uninstalled, so the
    // plaintext half of the account has to keep working through it. The fork's `mixed-provider.js` fixture
    // makes the same point in its own words: its lock gate "deliberately applies to our files only".
    //
    // It is decidable with no key because it needs no cipher: if the whole logical path is sitting on the
    // disk under its own name, that IS a legacy file. Our names are never in the clear, so this can never
    // match one of ours by accident. What we cannot do while locked is find our own files, which is why
    // anything that does not resolve in the clear still stops here.
    if (!keys && scheme === NAME_SCHEME_MIXED && paths.namesOwnLeaf(vault, relative) && fs.existsSync(inClear)) {
        return { handle, logical: relative, physical: inClear, keys, scheme, ours: false, foreign: false };
    }

    // The vault-keys file, and the skeleton, need no key. Everything else does.
    if (!keys && !paths.isAllStructural(vault, relative) && !paths.isVaultKeys(relative)) {
        throw unavailable(`Storage for '${handle}' is locked. They must log in.`, absPath);
    }

    if (!keys) {
        // Skeleton, or the key file. 🔴 `ours: true` — "assume these bytes are ours" — because the only
        // thing this branch can reach is a path we cannot classify without a key, and the safe answer to
        // that is the one that DEMANDS the key rather than the one that hands the bytes over. The key file
        // is unaffected: `isPassthrough` checks it by name, before this ever matters.
        return { handle, logical: relative, physical: inClear, keys, scheme, ours: true, foreign: false };
    }

    const steps = paths.walk(vault, keys.kNames, relative, scheme, probeUnder(userRoot), preferClearLeaf);
    const physicalRelative = steps.map(step => step.physical).join('/');

    return {
        handle,
        logical: relative,
        physical: path.join(userRoot, ...(physicalRelative ? physicalRelative.split('/') : [])),
        keys,
        scheme,

        // 🔴 "DID *WE* WRITE THE BYTES AT THIS PATH?" — decided from the NAME, keylessly, never from
        // whether a decrypt succeeded. See `paths.walk`.
        //
        // 🔴 AND IT IS `!legacy`, NOT `encrypted`. Those are different questions and the gap between them
        // is a plaintext leak — `paths.walk` spells it out at length. A file sitting directly inside a
        // skeleton directory has a name we did not choose and contents that are entirely ours; reading this
        // off `encrypted` would classify it as predating us and write the user's data in the clear.
        ours: steps.length > 0 && !steps[steps.length - 1].legacy,

        // A foreign store never reaches here; it returned above, before the walk.
        foreign: false,

        // Carried so that the companion-file calculation resolves the same way this path did. See
        // {@link sidecarsFor}.
        preferClearLeaf,
    };
}

/**
 * A probe for {@link paths.walk}, over one account's directory.
 * @param {string} userRoot The account's directory
 * @returns {(physicalRelative: string) => boolean} Does this on-disk path exist?
 */
function probeUnder(userRoot) {
    return (physicalRelative) => fs.existsSync(path.join(userRoot, ...physicalRelative.split('/')));
}

/**
 * 🔀 WHERE A COPY OF THIS FILE GOES — and this is the one derived operation that INHERITS (§8).
 *
 * New chats, branches, duplicates, and imports use the current encryption default regardless of source state.
 * Only a copy or rename inherits source state, because it preserves an existing file rather than creating new
 * content.
 *
 * 🔴 **Renaming is the exception, because renaming is not creating.** §8: "renaming is not a conversion". A
 * rename does not reach `rename()` — `src/endpoints/chats.js:590` in the fork does `copyFile(from, to)`
 * followed by `unlink(from)` — so `copyFile` is the only place the source is in our hands at the moment the
 * destination's state is decided. Classify the target on its own and a rename QUIETLY CONVERTS a legacy
 * plaintext chat into an encrypted one, which is §1's guarantee broken by the least suspicious command in
 * the product: the user typed a new title, and their chat now needs a plugin it never needed before.
 *
 * The inheritance is one-directional. A source of ours copied over a target that already exists in the
 * clear leaves the target plaintext — the target predates us too, and §1 covers it for the same reason.
 *
 * 🔴 **"NOT ENCRYPTED BY US" IS NOT THE SAME AS "LEGACY", AND CONFLATING THEM WRITES USER DATA IN THE
 * CLEAR.** This function first said `resolve(to, isPassthrough(source))`, which reads plausibly and was
 * badly wrong: `isPassthrough` is also true for every path OUTSIDE the data root, and the most important
 * copy in the whole product is exactly that. `checkForNewContent` seeds a new account by copying out of the
 * fork's own `default/content/` directory — worlds, presets, sample characters — and under that rule every
 * seeded file inherited "plaintext" from a source that was never a user file at all, and landed unencrypted
 * in the user's directory on the very first login.
 *
 * Nothing failed. The copy succeeded, the app worked, and `Eldoria.json` sat in `worlds/` with its contents
 * readable. It took the end-to-end sweep — which greps the whole data root for a name it knows is in there
 * — to see it, because every unit test copies within one account and never crosses the boundary.
 *
 * So the condition is narrow and states what it actually means: inherit only from a source that is a
 * *legacy file inside a vaulted account*. A source we do not own is not a legacy file; it is somebody
 * else's, and a copy of it into an account is a NEW file in that account, which §8 says is encrypted.
 * @param {ReturnType<typeof resolve>} source The resolved source
 * @param {string} to The logical destination
 * @returns {ReturnType<typeof resolve>} The resolved destination
 */
export function resolveCopyTarget(vault, source, to) {
    // 🔴 AND A FOREIGN STORE'S FILE IS THE SAME TRAP IN ITS THIRD SHAPE. It is `!ours` for the same honest
    // reason the seeded content was — we did not write those bytes — and inheriting from it would land a
    // copy in `chats/` or `user/files/` in the clear. It is not a legacy file: it did not predate the vault,
    // it postdates it, and a copy of one into an account is a NEW file in that account, which §8 encrypts.
    // The exemption belongs to the claimed directory and does not travel out of it.
    const sourceIsLegacy = Boolean(source.handle)
        && source.scheme === NAME_SCHEME_MIXED
        && !source.ours
        && !source.foreign
        && !paths.isVaultKeys(source.logical);

    return resolve(vault, to, sourceIsLegacy);
}

/**
 * Is this path outside our care, or a file we did not write? Either way: plain bytes, straight through.
 *
 * ⚠️ Passthrough is not the same as "not ours to handle". We still own the I/O for a legacy plaintext chat
 * — `owns()` is unchanged and still answers yes for everything under the data root (§5) — we simply do not
 * transform its bytes. Confusing the two would push classification up into the fork's routing, which §5
 * explicitly says must not happen.
 * @param {{handle: string, logical: string, scheme: number, ours: boolean, foreign: boolean}} resolved A resolution
 * @returns {boolean} True if the bytes are not to be transformed
 */
export function isPassthrough(resolved) {
    if (!resolved.handle || paths.isVaultKeys(resolved.logical)) {
        return true;
    }

    // 🔴 A DIRECTORY ANOTHER PLUGIN CLAIMED, LOCKED OR UNLOCKED, IN EITHER NAME SCHEME. Its owner encrypted
    // those bytes and its owner restores them, so the correct contents of a backup — or of any read at all —
    // are exactly the bytes sitting on the disk. This is deliberately not folded into the mixed-mode clause
    // below: a scheme-1 account can hold a foreign store too, and there is nothing legacy about one.
    if (resolved.foreign) {
        return true;
    }

    return resolved.scheme === NAME_SCHEME_MIXED && !resolved.ours;
}

/**
 * 🔴 DEMAND THE KEY, FOR THE OPERATIONS THAT CANNOT HONESTLY BE DONE WITHOUT IT.
 *
 * `resolve()` lets a purely structural path through with no key, which is what allows SillyTavern to build
 * the directory skeleton at boot while every vault is shut. But a structural path is not the same as a
 * key-free OPERATION, and that gap bit hard:
 *
 *     readdir('<U>/worlds')   while locked
 *
 * `worlds` is skeleton, so it resolves. But its CONTENTS have encrypted names, and decoding them needs
 * `k_names` -- which was `undefined`. It sailed into AES-SIV and died with a **TypeError**.
 *
 * A TypeError is the worst available outcome. It is not a StorageError, so `isStorageError()` is false, so
 * NONE of the fork's fail-safe guards re-throw it -- and one of the six regenerate-on-unreadable-data paths
 * would have been free to "repair" the directory by emptying it.
 *
 * So: an operation that must decode a name or a byte says so, explicitly, and gets EUNAVAILABLE instead.
 * @param {{handle: string, keys: any}} resolved A resolution
 * @param {string} absPath The logical path, for the error
 * @returns {void}
 */
export function requireKeys(resolved, absPath) {
    if (resolved.handle && !resolved.keys) {
        throw unavailable(
            `Storage for '${resolved.handle}' is locked, so '${absPath}' cannot be decoded. The data is there. They must log in.`,
            absPath,
        );
    }
}

/**
 * The content key, or EUNAVAILABLE — the ONLY way to reach `keys.kContent`.
 *
 * 🔴 **NEVER WRITE `at.keys.kContent` DIRECTLY. Call this.** Eight methods used to — `readFile`,
 * `readFileSync`, `createReadStream`, `sendFile`, `writeFile`, `writeFileSync`, `createWriteStream` and
 * `copyFile` — while only `readdir`, `unlink`, `rename` and `rm` called {@link requireKeys}. The asymmetry
 * was never intentional; it was just that the name-decoding paths hit the bug first and got fixed alone.
 *
 * Those eight were safe only by an accident of a different module: `resolve()` throws for any path with a
 * non-structural component, and every entry in `STRUCTURAL_DIRECTORIES` happens to be a DIRECTORY, so no
 * fully-structural path can name a file, so the locked case was unreachable. That is a load-bearing
 * invariant held together by a coincidence in a set literal three files away. Add one file-shaped entry to
 * that set — or one foreign store whose root is a file — and all eight dereference `undefined.kContent` and
 * raise a **`TypeError`, not a `StorageError`**.
 *
 * Which is the worst available outcome, for the reason spelled out on {@link requireKeys}: `isStorageError()`
 * is false for a TypeError, so none of the fork's fail-safe re-throws fire, and a regenerate-on-unreadable-
 * data path upstream is free to "repair" the file by rewriting it. Reaching the key through a function that
 * cannot return without the guard makes that unreachable by construction rather than by coincidence.
 * @param {{handle: string, keys: any}} resolved A resolution
 * @param {string} absPath The logical path, for the error
 * @returns {Buffer} The content key
 */
export function contentKey(resolved, absPath) {
    requireKeys(resolved, absPath);
    return resolved.keys.kContent;
}

/**
 * Does this resolution's file carry the public envelope?
 *
 * Only scheme-2 accounts write one. Scheme-1 files were on the disk before the envelope existed and adding
 * it now would mean rewriting every byte of every account — see `envelope.js` and the name-scheme
 * docblock in `crypto/name-cipher.js`. Their loss is only that the fork cannot name this plugin on a dead
 * row after an uninstall; everything else about them still works.
 * @param {{scheme: number, ours: boolean}} resolved A resolution
 * @returns {boolean} True if the bytes on disk begin with `stenv:`
 */
export function isEnveloped(resolved) {
    return resolved.scheme === NAME_SCHEME_MIXED && resolved.ours;
}

/**
 * The long-name companion files a resolution implies, resolved the same way its own path was.
 *
 * 🔴 THE PROBE HAS TO BE THE SAME ONE. A sidecar belongs to a specific on-disk name, so it must be computed
 * against the physical path the walk actually chose — not the one it would have chosen with no disk to look
 * at. Under scheme 2 a chat can sit inside a legacy plaintext character directory, and a sidecar computed
 * without the probe would be written beside the ENCRYPTED directory name instead: a companion file in a
 * directory that does not exist, and a long name in the one that does with nothing to decode it.
 * @param {{handle: string, logical: string, keys: any, scheme: number}} resolved A resolution
 * @returns {{physicalPath: string, content: string}[]} Companion files, relative to the user's directory
 */
function sidecarsFor(vault, resolved) {
    const userRoot = paths.userRoot(vault.dataRoot, resolved.handle);

    return paths.sidecarsFor(
        vault,
        resolved.keys.kNames,
        resolved.logical,
        resolved.scheme,
        probeUnder(userRoot),
        resolved.preferClearLeaf === true,
    );
}

/**
 * Write the long-name companion files a path needs, if any.
 * @param {{handle: string, logical: string, keys: any}} resolved A resolution
 * @returns {void}
 */
export function writeSidecars(vault, resolved) {
    if (!resolved.keys || !resolved.logical) {
        return;
    }

    const dataRoot = vault.dataRoot;

    for (const sidecar of sidecarsFor(vault, resolved)) {
        const target = paths.userRoot(dataRoot, resolved.handle, sidecar.physicalPath);

        if (!fs.existsSync(target)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, sidecar.content, 'utf-8');
        }
    }
}

/**
 * Delete the long-name companion file of a path, if it had one.
 * @param {{handle: string, logical: string, keys: any}} resolved A resolution
 * @returns {void}
 */
export function removeSidecars(vault, resolved) {
    if (!resolved.keys || !resolved.logical) {
        return;
    }

    const dataRoot = vault.dataRoot;

    for (const sidecar of sidecarsFor(vault, resolved)) {
        const target = paths.userRoot(dataRoot, resolved.handle, sidecar.physicalPath);

        // Only the LAST component's sidecar belongs to this path -- the parents' sidecars belong to the
        // directories, which are still there.
        if (sidecar.physicalPath.split('/').length === resolved.logical.split('/').length && fs.existsSync(target)) {
            fs.unlinkSync(target);
        }
    }
}
