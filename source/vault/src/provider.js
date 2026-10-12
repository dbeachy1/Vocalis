import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { Buffer } from 'node:buffer';

import { parseByteRange } from './byte-range.js';
import { plaintextLength } from './crypto/content-cipher.js';
import { ENVELOPE_HEADER_BYTES, parseEnvelope } from './envelope.js';
import { keyValueOptions } from './key-value.js';
import createMulterStorage from './multer-storage.js';
import createVectorIndex from './vector-index.js';
import * as lifecycle from './lifecycle.js';
import * as paths from './paths.js';
import * as session from './session.js';
import { idleLockMs } from './settings.js';
import { sensitive } from './logging.js';
import { describe } from './strings.js';
import { foreignStoreFor, registerForeignStore } from './foreign-stores.js';
import { createVaultState } from './vault-state.js';
import {
    contentKey,
    isEnveloped,
    isPassthrough,
    removeSidecars,
    requireKeys,
    resolve,
    resolveCopyTarget,
    writeSidecars,
} from './provider/resolve.js';
import { asBytes, asRequested, openBytes, readHeaderPrefix, sealBytes } from './provider/codec.js';
import { undecodable } from './errors.js';
import { LogicalDirent } from './provider/dirent.js';
import { atomicWrite, atomicWriteSync } from './provider/atomic.js';
/**
 * The Storage Provider: every byte of user data, on its way to and from the disk.
 *
 * SillyTavern speaks LOGICAL paths and LOGICAL sizes throughout — the paths and sizes it would see if this
 * plugin did not exist. Behind this interface the names are ciphertext, the contents are ciphertext, and
 * the sizes on disk are larger than the sizes SillyTavern is told about. It never finds out.
 *
 * ## The three things that will break if you get them wrong
 *
 * 🔴 **`stat().size` MUST be the LOGICAL size.** It becomes `Content-Length`. Report the on-disk size and
 * every HTTP response either truncates or hangs forever waiting for bytes that do not exist. The header is
 * built so that the plaintext length is recoverable from the ciphertext length arithmetically — **with no
 * key** — which is also what lets `stat` keep working while the vault is shut.
 *
 * 🔴 **`readdir()` MUST return LOGICAL names, and MUST honour `{ withFileTypes: true }`.** SillyTavern uses
 * that form in 38 places and expects objects answering `.name`, `.isFile()` and `.isDirectory()`.
 *
 * 🔴 **A failure to decrypt is NOT a missing file.** It throws `EPROVIDER`, never `ENOENT`. SillyTavern has
 * six separate code paths that respond to unreadable data by deleting it and regenerating it from source.
 * `ENOENT` means "there is nothing here, feel free to create it". `EPROVIDER` means "there is something
 * here and I cannot read it", which is the exact opposite, and confusing the two destroys the data.
 */

/**
 * Build the provider.
 *
 * ⚠️ The parameter is a seam, not a back door. Production calls this with no arguments and gets state
 * nothing else can reach. A caller that wants to INSPECT the state -- a test asserting that a key was
 * wiped, or that a handle was remembered -- builds its own and passes it in, which is honest about what
 * it is doing and needs no `provider.__internals` hatch to exist in shipped code.
 * @param {import('./vault-state.js').VaultState} [vault] State to use. Omitted means a fresh one.
 * @returns {any} A Storage Provider, as the fork's `src/storage.js` defines one
 */
export default function createVaultProvider(vault = createVaultState()) {
    // 🔴 THE STATE IS PER PROVIDER, AND THAT PARAMETER IS WHAT MAKES THE FACTORY A FACTORY.
    //
    // Everything behind this object used to be module-global -- the data root, the key table, the known
    // handles, the foreign-store registry, the scheme cache, the pending recovery keys. Two providers in
    // one process were one provider with two front doors, sharing six things including the KEYS.
    // `vault-state.js` has the full account, and `tests/verify.test.js` records what it cost.

    const provider = {
        id: 'vault',

        // ---- lifecycle: see lifecycle.js ---------------------------------------------------------
        owns(absPath) {
            return paths.split(vault, absPath) !== null;
        },
        ownsUser: (handle) => lifecycle.ownsUser(vault, handle),
        init: (context) => lifecycle.init(vault, context),
        isReady: (handle) => lifecycle.isReady(vault, handle),
        unlock: (handle, secret) => lifecycle.unlock(vault, handle, secret),
        lock: (handle) => lifecycle.lock(vault, handle),
        // Key material for other plugins, derived from this user's DEK and locked to it. `null` when shut.
        // Vault does not know or care who calls this or what they store under it: capability, not policy.
        deriveSubkey: (handle, info, length) => session.deriveSubkey(vault, handle, info, length),
        // The other half of deriveSubkey, and the one that is easy to skip. A plugin that takes a key and
        // writes its own encrypted files must SAY SO, or `verify` reports every one of them as a leak on
        // every run — see foreign-stores.js. Not per-user: a plugin's layout is the same in every account.
        registerForeignStore: (store) => registerForeignStore(vault, store),
        rekey: (handle, oldSecret, newSecret) => lifecycle.rekey(vault, handle, oldSecret, newSecret),
        recover: (handle, recoverySecret, newSecret) => lifecycle.recover(vault, handle, recoverySecret, newSecret),
        pendingRecoverySecret: (handle) => lifecycle.pendingRecoveryKey(vault, handle),
        acknowledgeRecoverySecret: (handle) => lifecycle.acknowledgeRecoveryKey(vault, handle),

        // 🔴 A new recovery key on demand — and it takes the PASSWORD, not the session. The DEK is already
        // in RAM while the user is signed in, so a version of this that trusted the session would be a
        // one-click key exfiltration button for anyone who reached a live one. See lifecycle.js.
        regenerateRecoverySecret: (handle, secret) => lifecycle.regenerateRecoveryKey(vault, handle, secret),

        // ---- policy: OURS, not SillyTavern's ----------------------------------------------------
        //
        // 🔴 THE FORK MUST NOT DECIDE ANY OF THIS, AND UNTIL TODAY IT DID.
        //
        // It owned the idle timeout (thirty minutes, in ITS config.yaml) and it owned every sentence the
        // user read about encryption — hard-coded into a public, generic, upstreamable fork that is not
        // supposed to know what a provider even is. Both have moved here, where the key is.
        //
        // `idleLockMs` is a NUMBER, not a function: the fork reads it lazily, at boot, after we register.
        // `describe` is how every string the user sees about encryption gets to their eyes without
        // SillyTavern ever having to contain one. See strings.js.
        idleLockMs: idleLockMs(),
        describe: (situation, context) => describe(situation, context),

        /**
         * 🔀 IS THE CONTENT AT THIS PATH ENCRYPTED AT REST BY US? — `DESIGN_MIXED_MODE.md` §6.1.
         *
         * The fork draws the padlock and cannot know the answer; we know it and cannot draw. This is the
         * whole of the interface between those two facts.
         *
         * 🔴 **NOT `owns()`, and the difference is the feature.** `owns()` is a routing question and still
         * answers yes for everything under the data root (§5) — including a legacy plaintext chat, whose
         * I/O we handle and whose bytes we pass through untouched. This asks something narrower: did WE put
         * these bytes in this state? A provider that conflated the two would put a padlock on every row in
         * a mixed account, which is worse than no padlock at all, because it would be a lie about exactly
         * the rows the user needs the truth about.
         *
         * ⚠️ **A PREFIX-READ-SHAPED ANSWER, NEVER A DECRYPT.** The chat list calls this once per chat, so a
         * 200-chat list is 200 of these. It resolves a path and classifies the resulting NAME; it opens
         * nothing and decrypts nothing.
         *
         * ⚠️ **A path that does not exist is `false`, not a throw** (§12 test 14). The chat list asks about
         * rows that may have just been deleted, and a capability that threw would take out the whole list.
         * @param {string} p Logical absolute path
         * @returns {boolean} True if this plugin encrypts the content at that path
         */
        encryptsPath(p) {
            try {
                const dataRoot = vault.dataRoot;
                const owned = paths.split(vault, p);

                // Not user data, the account root itself, an account with no vault, or the one file that is
                // plaintext by necessity because it is what you unlock WITH.
                if (!owned || !owned.relative || !lifecycle.ownsUser(vault, owned.handle) || paths.isVaultKeys(owned.relative)) {
                    return false;
                }

                // A directory another plugin claimed and encrypts itself. `false` is the honest answer to
                // the question actually being asked — did WE put these bytes in this state — and it is the
                // SAME answer locked and unlocked, which the keyless degradation below could not give: it
                // reasons from "is it sitting here in the clear?", and a foreign file is, without that
                // meaning any of the things that test normally means. The registry needs no key, so this
                // costs nothing to answer honestly in either state.
                if (foreignStoreFor(vault, owned.relative)) {
                    return false;
                }

                // 🔴 §14.3: A LOCKED VAULT STILL DRAWS ITS OWN PADLOCK, and it has to answer with no key.
                //
                // 🔴 IT MUST NOT GO THROUGH `resolve()` TO DO IT. `resolve` throws EUNAVAILABLE for any
                // non-structural path while the vault is shut, so routing this through it and catching the
                // throw answers `false` for every encrypted chat in a locked account — the padlock blinks
                // out on every row the moment the vault idle-locks, which reads as *your data stopped being
                // protected* at exactly the moment it became more protected.
                //
                // Half the question is still decidable without a key, and it is the half that matters: a
                // legacy file is sitting on the disk under its own name, so finding it there is proof it
                // predates us. What is NOT decidable is whether one of OUR files exists, because our names
                // are ciphertext. §14.3 rules that the honest degradation is `true` — and being wrong about
                // a file that is not there costs nothing, because the caller enumerated the row before
                // asking about it.
                if (!lifecycle.isReady(vault, owned.handle)) {
                    const inClear = paths.userRoot(dataRoot, owned.handle, owned.relative);
                    return !(paths.namesOwnLeaf(vault, owned.relative) && fs.existsSync(inClear));
                }

                const at = resolve(vault, p);
                return !isPassthrough(at) && fs.existsSync(at.physical);
            } catch {
                // `encryptsPath` is decoration on a list. It must never be the reason the list fails to
                // render, so anything unexpected degrades to "no padlock" rather than to an exception.
                return false;
            }
        },

        /**
         * 🔀 WHICH ENVELOPE VERSION IS THE FILE AT THIS PATH WRITTEN IN? — `DESIGN_STORAGE_PROVENANCE.md`
         * §7 row 3 and §12.1.
         *
         * This is the one sentence in that design the fork cannot build alone, and the reason is worth
         * stating because §8 of the design gets it wrong: it says the version "is already in the header, so
         * this needs no new on-disk data". True of the DATA and false of the ACCESS. The fork is handed a
         * LOGICAL path — `chats/Test Character/my-chat.jsonl` — and everywhere else in that design that is fine,
         * because every other case serves the state where the provider is GONE, and with it gone the
         * on-disk name IS the logical name. This check is the only one that fires while the provider is
         * INSTALLED, and at that moment our names are `venc1~<ciphertext>.jsonl`: nothing exists at the
         * logical path, the fork's `readEnvelopeHeader` returns null, and the check silently never runs.
         * The mapping back is keyed, so we are the only party that can answer.
         *
         * What it buys is §3's second user moment, which today has no words anywhere: *"I have the plugin
         * installed and the chat still will not open."* With the version in hand the fork compares it
         * against the `envelopeVersions` we declared in `storage.identity` and says **update the plugin**,
         * instead of drawing a padlock over a chat that will not load.
         *
         * ⚠️ **OPTIONAL, AND SILENCE MEANS READABLE.** `null` is *unknown*, never *stale*. The fork
         * disables nothing on a null, which is what lets a provider that predates this method — or one that
         * declares no versions at all — keep behaving exactly as it does today. Guessing here would be
         * strictly worse than saying nothing: a wrong "update the plugin" disables a chat that opens fine.
         *
         * ⚠️ **A PREFIX READ, NEVER A DECRYPT** — same budget as {@link encryptsPath}, for the same reason.
         * The chat list calls this once per row, so a 200-chat list is 200 of these. It opens the file,
         * reads at most 64 bytes, and closes it.
         *
         * ⚠️ **A path that does not exist is `null`, not a throw.** The chat list asks about rows that may
         * have just been deleted.
         * @param {string} p Logical absolute path
         * @returns {number|null} The envelope version of the file there, or null if that is not knowable
         */
        envelopeVersionAt(p) {
            try {
                const owned = paths.split(vault, p);

                // Same gate as `encryptsPath`: not user data, the account root itself, an account with no
                // vault, or the plaintext key file. None of them carry an envelope.
                if (!owned || !owned.relative || !lifecycle.ownsUser(vault, owned.handle) || paths.isVaultKeys(owned.relative)) {
                    return null;
                }

                // 🔴 A LOCKED VAULT ANSWERS `null`, AND IT MUST STOP HERE TO DO IT — §14.3's trap, in the
                // one shape where the honest answer is the opposite of `encryptsPath`'s.
                //
                // `encryptsPath` degrades to `true` while locked, and that is right for it: being wrong
                // about a padlock on a file that is not there costs nothing, and blinking the padlock out
                // on an idle lock would read as "your data stopped being protected". Nothing here is that
                // cheap. Our names are ciphertext, so with no key we cannot find the file, let alone read
                // its header — and `resolve()` would not tell us that, it would throw EUNAVAILABLE into
                // the catch below and land on the same `null` by accident. Stating it costs one branch and
                // makes the guarantee legible: a locked account reports *unknown* for every row, the fork
                // assumes every row is readable, and nothing is disabled on a key we do not have.
                if (!lifecycle.isReady(vault, owned.handle)) {
                    return null;
                }

                const at = resolve(vault, p);

                // 🔴 `isEnveloped`, not `!isPassthrough`. They agree on the two obvious rows and part
                // company on a scheme-1 account, whose files ARE ours and carry no envelope at all because
                // they were written before the envelope existed. Reading the bytes of one and asking what
                // version it claims is a question about a header that is not there; the answer is not
                // knowable, so it is `null`, and it is null without touching the disk.
                if (!isEnveloped(at)) {
                    return null;
                }

                // A file of ours whose header does not parse is damaged or foreign, and that is a state the
                // read path already reports properly as EPROVIDER. `null` here, so the fork's *"update the
                // plugin"* sentence — which is advice about a working file — is not offered for a broken
                // one.
                return parseEnvelope(readHeaderPrefix(at.physical))?.version ?? null;
            } catch {
                // Same reasoning as `encryptsPath`: this decorates a list, and must never be the reason the
                // list fails to render. Anything unexpected — a deleted row, a directory, a permission —
                // degrades to "unknown", which disables nothing.
                return null;
            }
        },

        // ---- library seams: the places a library writes user data with its own fs calls ----------
        //
        // 🔴 node-persist NEVER PASSES THROUGH THIS PROVIDER. It reads and writes its own bytes. Without
        // this hook every character card sat in `_cache/characters/` in the clear, behind every guard in
        // this file, and the funnel was none the wiser. See key-value.js.
        keyValueOptions: (handle) => keyValueOptions(vault, handle),

        // ---- reads -------------------------------------------------------------------------------

        async readFile(p, opts) {
            const at = resolve(vault, p);

            return asRequested(openBytes(at, await fs.promises.readFile(at.physical), p), opts);
        },

        readFileSync(p, opts) {
            const at = resolve(vault, p);

            return asRequested(openBytes(at, fs.readFileSync(at.physical), p), opts);
        },

        createReadStream(p, opts) {
            const at = resolve(vault, p);

            if (isPassthrough(at)) {
                return fs.createReadStream(at.physical, opts);
            }

            // 🔴 RANGES ARE NOT OPTIONAL. Browsers seek into audio and video with `Range:`, and Express's
            // static handling issues ranged reads for large files. A provider that ignores start/end
            // silently returns the whole file for a range request, and the browser gets bytes it did not
            // ask for at offsets it did not expect.
            //
            // The file is decrypted whole and then sliced. That is honest but not free: it costs the
            // plaintext in memory for the duration. Acceptable here -- SillyTavern's user data is chats,
            // cards and images, not video libraries -- and the block cipher is built so this can be made
            // properly streaming later without changing the format on disk.
            const plaintext = openBytes(at, fs.readFileSync(at.physical), p);

            const start = opts?.start ?? 0;
            const end = opts?.end === undefined ? plaintext.length - 1 : opts.end;

            return Readable.from(plaintext.subarray(start, end + 1));
        },

        // 🔴 A LOCKED `exists()` THROWS. It does not return false.
        //
        // `false` here means "there is nothing there, go ahead and create it" -- and SillyTavern would,
        // straight over the top of the real file. `resolve()` throws EUNAVAILABLE and that propagates,
        // which is the fail-safe answer: the request fails, and nothing is written.
        exists(p) {
            return fs.existsSync(resolve(vault, p).physical);
        },

        stat(p) {
            const at = resolve(vault, p);
            const stats = fs.statSync(at.physical);

            if (isPassthrough(at) || stats.isDirectory()) {
                return stats;
            }

            // 🔴 THE LOGICAL SIZE. This becomes Content-Length. It is computed from the on-disk size by
            // arithmetic -- no key needed -- which is deliberate: `stat` has to keep working on a file
            // whose contents we cannot read.
            //
            // 🔴 AND THE ENVELOPE COMES OFF FIRST. It is a fixed-length prefix that the content cipher has
            // never heard of, so leaving it in the number would offset every logical size by exactly its
            // fourteen bytes -- silently, because nothing here would throw and the value looks entirely
            // plausible. Every HTTP response for an encrypted file would then declare itself fourteen bytes
            // longer than the body it is about to send, and the client would sit waiting for them. This is
            // why `envelope.js` insists the header be a FIXED-length literal: a variable one would
            // make the logical size unknowable without opening the file.
            // 🔴 WRAP IT. `plaintextLength` throws PLAIN Errors for a file too short to hold a header, for a
            // zero-block file, and for a final block shorter than its tag -- and `stat` was the one read-side
            // path that did not funnel its failure through `undecodable()`. A bare Error is not a
            // `StorageError`, so `isStorageError()` is false, the fork's fail-safe re-throws do not fire, and
            // a regenerate-on-unreadable path is free to overwrite a file that is merely DAMAGED.
            //
            // Reachable from a partial restore, a truncated copy, or a disk-full artefact left by any tool.
            let size;

            try {
                size = plaintextLength(stats.size - (isEnveloped(at) ? ENVELOPE_HEADER_BYTES : 0));
            } catch (error) {
                throw undecodable(`Could not size '${p}': ${error.message}. The file is intact on disk; it must NOT be deleted or regenerated.`, p);
            }

            return new Proxy(stats, {
                get(target, property, receiver) {
                    if (property === 'size') {
                        return size;
                    }

                    const value = Reflect.get(target, property, receiver);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },

        readdir(p, opts) {
            const at = resolve(vault, p);

            // 🔴 A structural directory RESOLVES without a key, but its contents cannot be DECODED without
            // one. Without this, `readdir('<U>/worlds')` while locked fell into AES-SIV with an undefined
            // key and threw a TypeError -- which is not a StorageError, so nothing in the fork would have
            // treated it as "unreadable data" and refused to touch it.
            //
            // A foreign store is the one directory where that does not apply: its owner chose those names,
            // so there is nothing to decode and no key to need. Demanding one would refuse a listing a shut
            // vault has no reason to refuse — and would stop a whole-tree walk at the same directory the
            // read path was just taught to serve.
            if (!at.foreign) {
                requireKeys(at, p);
            }

            const entries = fs.readdirSync(at.physical, { withFileTypes: true });

            const readSidecar = (name) => {
                const sidecarPath = path.join(at.physical, name);
                return fs.existsSync(sidecarPath) ? fs.readFileSync(sidecarPath, 'utf-8') : undefined;
            };

            // 🔴 THE LISTING IS WHAT TELLS A COMPANION FROM A LONG NAME ENDING IN `.nm`, and this is the one
            // place that has it for free. `venl1~<digest>.nm` reads either way on its own; whether
            // `venl1~<digest>.nm.nm` sits beside it decides. Built once as a Set rather than asked per entry
            // with `existsSync`, so an ambiguity that needs a neighbour costs a lookup and not a syscall.
            const present = new Set(entries.map(e => e.name));
            const hasSibling = (name) => present.has(name);

            const visible = entries
                // 🔴 The companion files must never be seen. SillyTavern would try to parse a `.nm` sidecar
                // as a chat, and data-maid would offer to delete it as an orphan -- which would lose the
                // name of the file it belongs to, permanently.
                .filter(entry => !paths.isHidden(entry.name, hasSibling))
                .map(entry => {
                    // Past `requireKeys`, either this is not our data at all, or the key is in hand.
                    //
                    // 🔀 THIS IS THE UNION (§4). A mixed directory overlays two namespaces — legacy chats
                    // under their own names, ours under marked ones — and the caller gets ONE list holding
                    // the logical name of every file in it, whichever form it is stored in. `decodeName`
                    // does the classifying, keylessly and per name, and hands an unmarked one straight back.
                    //
                    // 🔴 `!at.foreign` IS NOT AN OPTIMISATION, IT IS THE GUARD. `decodeName` would return
                    // these names untouched anyway (`isLibraryNamed` sees to that), but it is reached here
                    // through `at.keys.kNames` — and a foreign directory is now listable with no keys at
                    // all, so that dereference would be `undefined.kNames`: a TypeError, which is not a
                    // StorageError, which is the one failure shape this file exists to never produce.
                    // 🔴 ONE UNDECODABLE ENTRY MUST NOT TAKE THE WHOLE DIRECTORY WITH IT.
                    //
                    // `decodeName` throws for any name it cannot account for, and this was a bare `.map`, so
                    // ONE bad entry made the entire listing throw -- and threw a plain `Error`, not a
                    // `StorageError`, so `isStorageError()` is false and none of the fork's fail-safe
                    // re-throws fire. The user's whole chat list is a 500, permanently, until somebody finds
                    // and deletes the offending file by hand.
                    //
                    // `paths.js` already argues this exact point ("`readdir` failing takes out the whole
                    // directory, not one row") and then only defends the scheme-2 unmarked case. Scheme 1
                    // accounts, which retain their scheme, had no equivalent,
                    // so ANY name we did not write was fatal: a `Thumbs.db`, a `.DS_Store`, an editor swap
                    // file, a backup tool's dropping, or a stale `.tmp-<pid>` from a crashed atomic write.
                    //
                    // Skipping the entry is the only safe answer. It is not ours, we cannot name it, and the
                    // alternatives are worse in both directions: returning the raw on-disk name would hand
                    // SillyTavern a ciphertext string to open, and failing the call hides every readable file
                    // beside it. A file that is skipped is still on the disk, still in `verify`'s report, and
                    // still findable -- it is simply not offered to a caller that could only mishandle it.
                    let name;

                    try {
                        name = at.handle && !at.foreign
                            ? paths.decodeName(vault, at.keys.kNames, at.logical, entry.name, readSidecar, at.scheme, hasSibling)
                            : entry.name;
                    } catch (error) {
                        // SENSITIVE: the physical name is derived from a logical one, so it is user data.
                        sensitive().warn(
                            `[vault] skipping an entry in a directory listing that could not be decoded: ${entry.name}`,
                            error,
                        );

                        return null;
                    }

                    // 🔴 `p`, NOT `at.physical`. `path.join(entry.parentPath, entry.name)` is how a `Dirent`
                    // is turned back into a path, and the logical name has to join onto a logical directory
                    // or it builds one that has never existed. `p` is what the caller asked for, so what it
                    // gets back is what it would have written itself.
                    return new LogicalDirent(name, entry, p);
                })
                .filter(Boolean);

            return opts?.withFileTypes ? visible : visible.map(entry => entry.name);
        },

        async sendFile(res, p, opts) {
            const at = resolve(vault, p);

            if (isPassthrough(at)) {
                return await new Promise((resolve_, reject) => {
                    res.sendFile(at.physical, opts ?? {}, (error) => error ? reject(error) : resolve_());
                });
            }

            // res.sendFile() reads from the disk itself, so it cannot be used: it would send ciphertext.
            // Send the plaintext directly, and let Express work out the content type from the LOGICAL name.
            const plaintext = openBytes(at, await fs.promises.readFile(at.physical), p);
            const options = opts ?? {};

            res.type(path.extname(p));

            // 🔴 `opts` WAS ACCEPTED AND THEN DROPPED ON THE FLOOR, and the passthrough branch three lines up
            // forwards it -- so the same call behaved one way for a legacy file and another for an encrypted
            // one. That is the shape of bug this provider exists to not have: a caller cannot see which
            // branch it took, so it cannot know which contract it got.
            //
            // ⚠️ NOT EVERYTHING IN `opts` IS HONOURED, AND THE REST IS LISTED HERE RATHER THAN LEFT TO BE
            // REDISCOVERED. `root` and `dotfiles` are `send`'s path resolution, which does not apply -- the
            // path was resolved by `resolve()` before we got here. `maxAge`/`cacheControl`/`immutable` are
            // not set because Express accepts a string duration (`'1d'`) that only the `ms` package parses,
            // and this project has no runtime dependencies; a half-parsed cache lifetime is worse than none.
            for (const [name, value] of Object.entries(options.headers ?? {})) {
                res.setHeader(name, value);
            }

            if (options.lastModified !== false) {
                // The ciphertext's mtime IS the plaintext's mtime -- every write replaces the whole file.
                res.setHeader('Last-Modified', (await fs.promises.stat(at.physical)).mtime.toUTCString());
            }

            const acceptRanges = options.acceptRanges !== false;

            res.setHeader('Accept-Ranges', acceptRanges ? 'bytes' : 'none');

            const range = acceptRanges ? parseByteRange(res.req?.headers?.range, plaintext.length) : undefined;

            if (range && 'unsatisfiable' in range) {
                // 🔴 416, NOT 200. See `parseByteRange`: answering a bad range with the whole body tells the
                // client its request succeeded, and it writes those bytes at the offset it asked for.
                res.status(416);
                res.setHeader('Content-Range', `bytes */${plaintext.length}`);
                res.end();
                return;
            }

            if (range) {
                const slice = plaintext.subarray(range.start, range.end + 1);

                res.status(206);
                res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${plaintext.length}`);
                res.setHeader('Content-Length', String(slice.length));
                res.end(slice);
                return;
            }

            res.setHeader('Content-Length', String(plaintext.length));
            res.end(plaintext);
        },

        // ---- writes ------------------------------------------------------------------------------

        async writeFile(p, data, opts) {
            const at = resolve(vault, p);
            writeSidecars(vault, at);

            await atomicWrite(at.physical, sealBytes(at, asBytes(data, opts), p));
        },

        writeFileSync(p, data, opts) {
            const at = resolve(vault, p);
            writeSidecars(vault, at);

            atomicWriteSync(at.physical, sealBytes(at, asBytes(data, opts), p));
        },

        createWriteStream(p, opts) {
            const at = resolve(vault, p);
            writeSidecars(vault, at);

            // 🔴 APPEND IS A TRUNCATE HERE, SO REFUSE IT RATHER THAN PERFORM IT. This method took no options
            // at all, and `node:fs` -- whose semantics this provider claims to mirror -- makes
            // `{ flags: 'a' }` an append. The encrypted branch below buffers only the chunks IT is given and
            // atomically writes them over the WHOLE file, so a caller appending one message to a chat would
            // silently lose every message already in it. No error, no partial write, just the file replaced
            // by its newest fragment.
            //
            // It cannot be honoured either: appending would mean decrypting the existing file, concatenating,
            // and re-encrypting under a fresh nonce -- which is a read the caller did not ask for and a
            // rewrite of data they are not holding. Refusing is the honest answer, and it is loud.
            const flags = typeof opts === 'string' ? opts : opts?.flags;

            if (!isPassthrough(at) && typeof flags === 'string' && flags.includes('a')) {
                throw new Error(
                    `createWriteStream cannot append to an encrypted file (flags: '${flags}'). Every write ` +
                    'replaces the whole file, so an append would silently discard its existing contents. ' +
                    'Read it, concatenate, and write it back instead.',
                );
            }

            if (isPassthrough(at)) {
                // Forwarded, so a legacy file behaves exactly as node:fs would -- flags, mode, start and all.
                return fs.createWriteStream(at.physical, opts);
            }

            // Buffer the whole stream, encrypt it, write it. Same trade as createReadStream, and the same
            // reasoning: correctness first, and the on-disk format already supports doing it block by block
            // later without a migration.
            const chunks = [];
            const target = at.physical;
            const resolved = at;

            // 🔴 EAGERLY, AND THE RESULT IS DISCARDED — THIS CALL IS THE POINT, NOT ITS VALUE.
            //
            // `sealBytes` in `final()` would reach the key too, but not until the LAST CHUNK. So a locked
            // vault would accept the stream, take every byte the caller wrote, and only then refuse — and
            // an upload that fails at the end has already spent the whole transfer. Asking here means
            // `createWriteStream` itself throws EUNAVAILABLE, before the caller writes anything.
            contentKey(at, p);

            return new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.from(chunk));
                    callback();
                },
                final(callback) {
                    try {
                        atomicWriteSync(target, sealBytes(resolved, Buffer.concat(chunks), p));
                        callback();
                    } catch (error) {
                        callback(error);
                    }
                },
            });
        },

        mkdir(p, opts) {
            const at = resolve(vault, p);

            // 🔴 A DIRECTORY IS A NAME TOO, AND THIS WAS THE ONE WRITE PATH THAT FORGOT IT. Every other
            // method that brings a name into existence writes its companions first -- `writeFile` (above),
            // `writeFileSync`, `createWriteStream`, `rename`, `copyFile`. `mkdir` did not, so a directory
            // whose encrypted name is over `MAX_ENCRYPTED_NAME_LENGTH` was created as `venl1~<sha256>` with
            // nothing on disk recording what it is called. Around 115 characters of character name does it.
            //
            // The next `readdir` of the PARENT then throws: `loadName` sees a long name, asks for the
            // companion, gets nothing, and raises a bare `Error` -- not a `StorageError`, so `isStorageError`
            // is false and none of the fork's fail-safe re-throws fire. That is the user's whole chat list
            // gone, permanently, not one row.
            //
            // `cp` reaches this in-tree: it calls `this.mkdir` before recursing, so copying an empty
            // long-named directory produced exactly this orphan. The suite missed it because the long-name
            // test writes a FILE inside the directory straight afterwards, and that write's own
            // `writeSidecars` walks the whole path and back-fills the parent's companion.
            //
            // Locked and unencrypted paths are unaffected: `writeSidecars` returns immediately when there
            // are no keys, which is what boot's structural `mkdir`s are.
            writeSidecars(vault, at);

            return fs.mkdirSync(at.physical, opts);
        },

        unlink(p) {
            const at = resolve(vault, p);
            requireKeys(at, p);

            fs.unlinkSync(at.physical);
            removeSidecars(vault, at);
        },

        rename(from, to) {
            const source = resolve(vault, from);

            // 🔴 THE TARGET INHERITS FROM THE SOURCE, THE SAME WAY `copyFile`'s DOES -- AND THIS RESOLVED IT
            // INDEPENDENTLY, WHICH MOVES BYTES ACROSS THE ENCRYPTION BOUNDARY WITHOUT CONVERTING THEM.
            //
            // `resolveCopyTarget` exists precisely for this and `rename` was the one caller that did not use
            // it, which is a duplication the refactor removed everywhere else. Resolving `to` on its own
            // classifies it by probing the disk, so both directions were reachable and both are silent:
            //
            //   encrypted -> a name that already exists in the clear: the target classifies LEGACY, so the
            //   provider thereafter serves our CIPHERTEXT as though it were plaintext. That is the input the
            //   six regenerate-on-unreadable paths respond to by rebuilding the file from nothing.
            //
            //   legacy -> a fresh name: the target classifies as ours, so PLAINTEXT JSONL ends up under a
            //   marked name. Every read then runs `unseal`, `parseEnvelope` returns null, and the file is
            //   EPROVIDER for ever -- "intact on disk and it must NOT be deleted or regenerated" -- for a
            //   working chat, because somebody typed a new title.
            const target = resolveCopyTarget(vault, source, to);

            requireKeys(source, from);
            requireKeys(target, to);

            // Same classification on both ends: the bytes are already in the right form, so this is a real
            // rename and stays one. The content is not bound to its filename -- only the NAME's ciphertext
            // binds the parent -- so moving the bytes under a new physical name is sound, and `writeSidecars`
            // records what that new name means.
            if (isPassthrough(source) === isPassthrough(target)) {
                writeSidecars(vault, target);
                fs.renameSync(source.physical, target.physical);
                removeSidecars(vault, source);
                return;
            }

            // ⚠️ Different classification: a byte move is not a valid rename, because the bytes have to
            // change form. Go through plaintext exactly as `copyFile` does, then drop the source -- which is
            // also, incidentally, how the fork performs a rename in the first place.
            this.copyFile(from, to);
            this.unlink(from);
        },

        copyFile(from, to) {
            const source = resolve(vault, from);
            const target = resolveCopyTarget(vault, source, to);

            // 🔴 NOT a byte copy. The filename is bound into the ciphertext of the NAME, and the content's
            // nonce is per-file -- but more importantly, `from` and `to` may sit under different parents,
            // and a plain copy of the bytes would be perfectly valid ciphertext under the wrong name. It
            // happens to work today, and it is exactly the kind of thing that stops working invisibly.
            // Go through plaintext.
            writeSidecars(vault, target);

            const plaintext = openBytes(source, fs.readFileSync(source.physical), from);

            atomicWriteSync(target.physical, sealBytes(target, plaintext, to));
        },

        cp(from, to, opts) {
            const source = resolve(vault, from);

            if (!fs.existsSync(source.physical)) {
                throw Object.assign(new Error(`ENOENT: no such file or directory, cp '${from}'`), { code: 'ENOENT' });
            }

            if (!fs.statSync(source.physical).isDirectory()) {
                return this.copyFile(from, to);
            }

            if (!opts?.recursive) {
                throw new Error(`cp '${from}' is a directory; pass { recursive: true }`);
            }

            this.mkdir(to, { recursive: true });

            for (const entry of this.readdir(from, { withFileTypes: true })) {
                this.cp(path.join(from, entry.name), path.join(to, entry.name), opts);
            }
        },

        // A locked structural directory can resolve without a key, but deleting its contents must still fail.
        // Removing the whole account is an explicit administrative deletion and remains allowed while locked.
        rm(p, opts) {
            const at = resolve(vault, p);

            if (at.logical !== '') {
                requireKeys(at, p);
            }

            fs.rmSync(at.physical, opts);
            removeSidecars(vault, at);
        },
    };

    // 🔴 THE OTHER PLACE A LIBRARY WRITES USER DATA WITH ITS OWN fs.
    //
    // multer stages every upload -- every character card, chat, world info, sprite pack and avatar -- and it
    // wrote them in the clear, straight past everything above. The engine writes THROUGH this provider, so
    // it inherits the encryption, the atomic write and the locked-vault refusal rather than reimplementing
    // them. See multer-storage.js.
    provider.multerStorage = (maxUploadBytes) => createMulterStorage(provider, () => vault.dataRoot, maxUploadBytes);

    // 🔴 AND THE THIRD: vectra, which cannot be wrapped because it has no seam at all -- and which stores
    // the VERBATIM SOURCE TEXT of every vectorised chat message, World Info entry and Data Bank document
    // inline in its own index.json. Encrypting chats/ and leaving that alone would have been theatre.
    //
    // It is not wrapped. It is REPLACED. See vector-index.js.
    provider.vectorIndex = (folderPath) => createVectorIndex(provider, folderPath);

    return provider;
}
