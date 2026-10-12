import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import multer from 'multer';

import createKeyedProvider from './keyed-provider.js';
import { EPROVIDER, EUNAVAILABLE, StorageError } from '../../src/storage.js';
import { UPLOADS_DIRECTORY } from '../../src/constants.js';

/**
 * 🔀 A PROVIDER WHOSE ON-DISK NAMES DIFFER FROM ITS LOGICAL ONES — the fixture gap that let a real bug ship.
 *
 * Every other fixture in this directory passes filenames straight through to `fs.readdirSync`
 * (`keyed-provider.js:392`). None of them encrypts a name. That means the entire failure class of "some
 * code path used raw `fs` and therefore saw ciphertext names it could not match" is invisible to the whole
 * suite — which is exactly how `88a0ebdd8` shipped: `/api/backups/chat/get` listed the backups directory
 * with raw `fs`, matched nothing once names were encrypted, and reported "no backups" for ever while the
 * backups sat there intact. 39 suites were green throughout.
 *
 * `DESIGN_MIXED_MODE.md` §12 therefore makes this fixture the FIRST deliverable of mixed mode rather than
 * the last. Nothing else in that spec is testable without it.
 *
 * ## What it models
 *
 * A provider installed onto an account that already has data, per §1: chats that existed before it arrived
 * stay plaintext for ever, chats created after it arrives are encrypted, and both are readable in the same
 * account at the same time.
 *
 * ⛔ The "crypto" here is base64 and a prefix. It is a STAND-IN and is not the real thing — a fixture that
 * actually encrypted would be testing AES, which is not the fork's job. What this reproduces faithfully is
 * the only property the fork's code can get wrong: **the name on disk is not the name the caller asked
 * for, and some files are not ours at all.**
 *
 * ## 🔴 The three states, and why the NAME is the discriminator
 *
 * §3 is emphatic that "try to decrypt, and if it fails assume plaintext" is wrong in the direction that
 * loses data, because it collapses *ours-but-broken* into *not-ours* and hands a damaged chat to the six
 * code paths that respond to unreadable data by regenerating it. So classification here never depends on
 * whether decoding succeeded:
 *
 * | On-disk name          | Contents            | Result                                    |
 * |-----------------------|---------------------|-------------------------------------------|
 * | carries {@link NAME_PREFIX} | valid envelope | ours, readable — decode and serve         |
 * | carries {@link NAME_PREFIX} | anything else  | 🔴 ours and BROKEN — `EPROVIDER`, never `ENOENT` |
 * | no prefix             | anything            | not ours — serve the raw bytes untouched  |
 *
 * The marked name is what makes *ours-but-broken* decidable without a key, which is what §4 means by
 * filenames being a second, separate classification problem with the same wrong answer available. It is
 * also what makes §12's test 12 and test 13 come out differently from each other: a truncated file whose
 * name is marked is broken-and-ours (`EPROVIDER`), while a plaintext file whose first bytes happen to look
 * like an envelope is simply not ours, because its name never said it was.
 */

/**
 * The marker on an encrypted filename. A reserved prefix, checkable with no key, which is the obvious
 * answer to open question §14.2 and the one this fixture assumes.
 *
 * `~` is deliberate: legal in a filename on every platform the fork supports, and vanishingly unlikely to
 * begin a real chat name. The stem is base64url, which is filename-safe by construction — no `/`, no
 * `+`, no padding — so a mangled name never needs escaping and never collides with a path separator.
 *
 * 🔴 THE REAL EXTENSION IS KEPT IN THE CLEAR, AND STEP 9 IS WHY. An encrypted name that dropped its
 * `.jsonl` would be invisible the moment the provider is gone: every list that surfaces chats —
 * `/api/characters/chats`, `/api/chats/search`, `/api/backups/chat/get` — filters raw-`fs` entries by
 * `path.extname(name) === '.jsonl'`, and with no provider installed there is nothing to demangle the name
 * back first. So an uninstalled encrypted chat with a suffix-less name simply would not appear, and §11 is
 * emphatic that it MUST appear, disabled, naming what it needs — hiding the row is how a user concludes
 * their data is gone. Encoding only the stem keeps `<name>.jsonl` → `enc~<stem>.jsonl`, which the filter
 * still recognises; the row then shows under a scrambled name (correct — the real one is encrypted) and
 * the content envelope, read keylessly, supplies the provider id.
 *
 * ⚠️ This is a constraint the lifecycle test discovered and a FINDING FOR VAULT, recorded at
 * `DESIGN_MIXED_MODE.md` §14.2: whatever real scheme Vault picks — AES-SIV names will not keep an
 * extension on their own — the on-disk name has to end in a suffix the extension-filtered listers accept,
 * or uninstalled chats vanish from every one of them. The extension leaks only the file *type*, which the
 * directory it sits in already discloses; the file's real *name* stays inside the crypto.
 */
export const NAME_PREFIX = 'enc~';

/**
 * The envelope header this fixture writes, per the §3.1 grammar `<magic>:<version>:<provider-id>:`.
 *
 * 🔴 DELIBERATELY A LITERAL, not an import from the fork's parser. The fork owns this grammar (§13) and a
 * provider is a separate program that has to agree with it from the outside. If the fixture imported the
 * fork's constant the two could drift together silently and every test would still pass; spelled out here,
 * a change to either side breaks a test, which is the entire value of having two independent statements
 * of a wire format.
 */
export const ENVELOPE_HEADER = 'stenv:1:mixed-provider:';

/** The provider id this fixture claims, and the one its envelope header carries. */
const PROVIDER_ID = 'mixed-provider';

/**
 * 🪪 What this fixture answers `describe('storage.identity')` with — `DESIGN_STORAGE_PROVENANCE.md` §6.
 *
 * Exported so a test can assert the fork rendered THESE values rather than something it invented. The name
 * is deliberately unlike anything the fork could produce on its own: a fork that hard-coded a friendly name
 * would pass a laxer assertion.
 *
 * 🔴 `id` MATCHES {@link ENVELOPE_HEADER}'s third field, and that is the interface contract, not a
 * coincidence. A declaration whose id differs from the id written into the envelopes is refused outright,
 * because it would file the registry entry under a key no file on disk will ever name.
 */
export const IDENTITY = Object.freeze({
    id: PROVIDER_ID,
    name: 'FIXTURE Mixed-Mode Provider',
    source: 'https://example.invalid/fixtures/mixed-provider',
    version: '1.2.3',
    envelopeVersions: [1],
});

/**
 * Is this a name this fixture wrote?
 * @param {string} name A single path segment
 * @returns {boolean} True if the name carries the encrypted marker
 */
function isMarkedName(name) {
    return name.startsWith(NAME_PREFIX);
}

/**
 * Logical name → on-disk name.
 *
 * Only the STEM is encoded; the extension rides along in the clear (see {@link NAME_PREFIX} for why it
 * has to). A file with no extension — `path.extname` returns `''` — mangles its whole name, which is
 * correct: nothing that is not a chat needs to survive the `.jsonl` filter.
 * @param {string} name The logical name
 * @returns {string} The marked, mangled name
 */
function mangle(name) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    return NAME_PREFIX + Buffer.from(stem, 'utf-8').toString('base64url') + ext;
}

/**
 * On-disk name → logical name.
 * @param {string} name The marked name
 * @returns {string} The logical name, or the input unchanged if it carries no marker
 */
function demangle(name) {
    if (!isMarkedName(name)) {
        return name;
    }

    const ext = path.extname(name);
    const encoded = name.slice(NAME_PREFIX.length, name.length - ext.length);
    return Buffer.from(encoded, 'base64url').toString('utf-8') + ext;
}

/**
 * The encrypted on-disk path for a logical path.
 * @param {string} p Logical absolute path
 * @returns {string} The path with its basename mangled
 */
function markedPath(p) {
    return path.join(path.dirname(p), mangle(path.basename(p)));
}

/**
 * 🔴 Resolve a logical path to what is actually on disk, WITHOUT deciding whether it is readable.
 *
 * A logical path can exist in exactly one of two forms, and the caller does not know which. Plaintext wins
 * the lookup when both somehow exist, because a plaintext file is the one that predates the provider and
 * §1 says it stays as it is for ever.
 * @param {string} p Logical absolute path
 * @returns {{ actual: string, ours: boolean }|null} What is on disk, or null if nothing is
 */
function resolve(p) {
    if (fs.existsSync(p)) {
        return { actual: p, ours: false };
    }

    const marked = markedPath(p);
    return fs.existsSync(marked) ? { actual: marked, ours: true } : null;
}

/**
 * Where a NEW write should land.
 *
 * §8: state is inherited from the source, never from the moment. A save into a chat that was already
 * plaintext keeps it plaintext — that is the property that makes step 6 of the §12 lifecycle mean
 * anything. Only a genuinely new file gets today's default, which is encrypted.
 * @param {string} p Logical absolute path
 * @returns {{ actual: string, ours: boolean }} Where to write and in which form
 */
function destination(p) {
    return resolve(p) ?? { actual: markedPath(p), ours: true };
}

/**
 * Wrap plaintext in this fixture's envelope.
 * @param {Buffer} plain The bytes as the caller supplied them
 * @returns {Buffer} The enveloped bytes
 */
function envelope(plain) {
    return Buffer.from(ENVELOPE_HEADER + plain.toString('base64'), 'utf-8');
}

/**
 * 🔴 Unwrap a file this fixture wrote, or refuse. NEVER falls back to serving the raw bytes.
 *
 * The caller has already established from the NAME that this file is ours. So every failure from here on
 * is *ours and broken* — a truncated file, a corrupted body, someone else's envelope — and the one thing
 * it must never become is `ENOENT`, because `provider.js:34` records what happens then: six separate code
 * paths in SillyTavern respond to unreadable data by deleting it and regenerating it from source. A chat
 * that is merely damaged would be repaired by being destroyed.
 * @param {Buffer} raw The bytes on disk
 * @param {string} p The logical path, for the error message
 * @returns {Buffer} The plaintext
 * @throws {StorageError} `EPROVIDER` if the file does not decode
 */
function unwrap(raw, p) {
    const text = raw.toString('utf-8');

    if (!text.startsWith(ENVELOPE_HEADER)) {
        throw new StorageError(EPROVIDER, `Storage for '${p}' is marked as ours but carries no usable envelope.`, p);
    }

    const body = text.slice(ENVELOPE_HEADER.length);
    const decoded = Buffer.from(body, 'base64');

    // base64 decoding is famously permissive, so round-trip it: anything that does not re-encode to what
    // was on disk was not valid base64, and this fixture wrote neither it nor anything like it.
    if (decoded.toString('base64') !== body) {
        throw new StorageError(EPROVIDER, `Storage for '${p}' is ours and does not decode.`, p);
    }

    return decoded;
}

/**
 * Build the mixed-mode provider.
 * @returns {import('../../src/storage.js').StorageProvider} The provider
 */
export default function createMixedProvider() {
    const base = createKeyedProvider();

    /** This provider's own copy of the data root, captured from `init`, so `handleOf` works here too. */
    let dataRoot = '';

    /**
     * Which account owns this path?
     * @param {string} p Absolute path
     * @returns {string|null} The handle, or null if the path is not under a user directory
     */
    function handleOf(p) {
        const relative = path.relative(dataRoot, path.resolve(p));

        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            return null;
        }

        const handle = relative.split(path.sep)[0];
        return handle && !handle.startsWith('_') && !handle.includes('.') ? handle : null;
    }

    /**
     * 🔒 THE LOCK GATE, AND IT DELIBERATELY APPLIES TO OUR FILES ONLY.
     *
     * This is a mixed-mode property worth stating rather than discovering: a legacy plaintext chat needs
     * no key, so a locked vault must still serve it. That is what §1 means by uninstalling — or in this
     * case simply not being unlocked yet — leaving the plaintext half of an account working normally.
     *
     * ⚠️ It matters that this gate exists at all. A fixture that served everything regardless of lock
     * state would let a lock-state or oracle test pass while proving nothing, which is the vacuous green
     * `storage-provider-login-oracle.test.js` warns about in its own header.
     * @param {string} p The path
     * @returns {void}
     * @throws {StorageError} `EUNAVAILABLE` if the file is ours and no key is in hand
     */
    function requireKeyFor(p) {
        const handle = handleOf(p);

        if (!handle || !base.isReady(handle)) {
            throw new StorageError(EUNAVAILABLE, `Storage for '${p}' is locked.`, p);
        }
    }

    /**
     * Read a logical path through the classifier.
     * @param {string} p Logical absolute path
     * @returns {Buffer} The plaintext bytes
     */
    function readThrough(p) {
        const found = resolve(p);

        if (!found) {
            // Genuinely absent. This is the ONE case that may be ENOENT, and it comes from `fs` itself
            // rather than from anything this fixture decided.
            return fs.readFileSync(p);
        }

        if (!found.ours) {
            // Not ours: no key needed, no envelope, no classification. Hand back exactly what is there.
            return fs.readFileSync(found.actual);
        }

        requireKeyFor(p);
        return unwrap(fs.readFileSync(found.actual), p);
    }

    /**
     * Write a logical path, inheriting the form the file already had.
     * @param {string} p Logical absolute path
     * @param {string|Buffer} data The bytes as the caller supplied them
     * @param {object|string} [opts] `fs.writeFileSync` options or an encoding
     * @returns {void}
     */
    function writeThrough(p, data, opts) {
        const target = destination(p);
        const encoding = typeof opts === 'string' ? opts : opts?.encoding;
        const plain = Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding || 'utf-8');

        if (!target.ours) {
            // Writing into a file that predates this provider. It stays plaintext (§8) and needs no key.
            return fs.writeFileSync(target.actual, plain);
        }

        requireKeyFor(p);
        return fs.writeFileSync(target.actual, envelope(plain));
    }

    return {
        ...base,

        id: PROVIDER_ID,

        /**
         * Capture the data root for this module's own `handleOf`, then let the base do its real work.
         * @param {object} ctx The provider context
         * @returns {Promise<void>} When the base provider has initialised
         */
        async init(ctx) {
            dataRoot = path.resolve(ctx.dataRoot);
            return await base.init(ctx);
        },

        /**
         * §6.2: the words on the padlock's tooltip are the PROVIDER'S, and the fork has none of its own.
         * This models a provider that answers the `storage.chatMarker` situation; everything else falls
         * through to the base's `describe` (the login badge, the header marker, the recovery prose), so a
         * test can prove the fork asks THIS situation separately rather than reusing another answer.
         *
         * The body is deliberately distinctive — a fork that hard-coded "This chat is encrypted" would pass
         * a laxer assertion, so the assertion checks for text only the provider could have supplied.
         * @param {string} situation The situation being described
         * @param {object} [context] Optional context the fork passes through
         * @returns {object|null} The description, or null when this provider has nothing to say
         */
        describe(situation, context) {
            if (situation === 'storage.chatMarker') {
                return { body: 'FIXTURE: this chat is encrypted at rest.' };
            }

            // 🪪 Asked once, on load, and recorded by the fork so that it can still name this plugin after
            // it is uninstalled (`DESIGN_STORAGE_PROVENANCE.md` §4). Data, not prose — the fork stores and
            // compares these fields rather than pasting them into a sentence.
            if (situation === 'storage.identity') {
                return { ...IDENTITY };
            }

            return base.describe ? base.describe(situation, context) : null;
        },

        /**
         * §6.1: is the content at this path encrypted at rest by this provider? Distinct from `owns()`,
         * which is about routing — this provider owns plaintext files it passes through in the clear.
         *
         * ⚠️ Keyless on purpose, and it answers for a LOCKED vault too (§14.3): the marker is on the name,
         * so a locked provider can still draw its own padlock. A path that does not exist is `false` rather
         * than a throw — the chat list asks about rows that may have just been deleted.
         * @param {string} p Logical absolute path
         * @returns {boolean} True if this provider encrypts the content at that path
         */
        encryptsPath(p) {
            return resolve(p)?.ours === true;
        },

        /**
         * 🪪 Which envelope version wrote the bytes at a logical path — `DESIGN_STORAGE_PROVENANCE.md` §12.1.
         *
         * The provider is the only party that can resolve a logical path to its own bytes and read the
         * header, so it is the only party that can answer this. The contract mirrors the real Vault method:
         *
         * - Ours, unlocked, header intact → the version WRITTEN ON THE FILE. 🔴 Off the bytes, not off any
         *   constant — a build that read its own `ENVELOPE_HEADER` version would pass every test that uses
         *   files it wrote while making the one case the method exists for (a file from a DIFFERENT build)
         *   permanently undetectable. So the version is parsed from the header, and a planted `stenv:99:`
         *   file reports 99.
         * - Legacy plaintext (not ours), a path that does not exist, or a locked vault → null, no throw.
         * - Ours but the header is damaged or missing → null, because *"update the plugin"* is advice about a
         *   working file and offering it for a broken one sends the user to install something that will not
         *   help.
         * @param {string} p Logical absolute path
         * @returns {number|null} The version on the file, or null when it cannot be known
         */
        envelopeVersionAt(p) {
            const found = resolve(p);

            if (!found || !found.ours) {
                return null;
            }

            const handle = handleOf(p);

            if (!handle || !base.isReady(handle)) {
                return null;
            }

            try {
                const text = fs.readFileSync(found.actual, 'utf-8');
                const match = /^stenv:(\d+):/.exec(text);
                return match ? Number(match[1]) : null;
            } catch {
                return null;
            }
        },

        // ---- reads: the classifier runs here, where the I/O is already being paid for ----------------
        async readFile(p, opts) {
            const data = readThrough(p);
            return typeof opts === 'string' ? data.toString(opts) : data;
        },
        readFileSync(p, opts) {
            const data = readThrough(p);
            const encoding = typeof opts === 'string' ? opts : opts?.encoding;
            return encoding ? data.toString(encoding) : data;
        },
        createReadStream(p) {
            // The transformation is not streamable, and for a fixture it does not need to be: read it
            // through the classifier and hand back a stream over the result. A real provider decrypting a
            // multi-megabyte chat would care; a fixture proving the fork calls the seam does not.
            return Readable.from([readThrough(p)]);
        },
        async sendFile(res, p) {
            // NOT `res.sendFile`, which would stream the file off disk and bypass the classifier entirely
            // — the caller would receive ciphertext under a mangled name. The bytes have to go through
            // `readThrough` and then be sent as a body.
            const data = readThrough(p);
            res.type(path.extname(p)).send(data);
        },

        exists(p) {
            return resolve(p) !== null;
        },
        stat(p) {
            const found = resolve(p);
            return fs.statSync(found ? found.actual : p);
        },

        /**
         * 🔴 THE UNION. This is the method whose absence from every other fixture hid a real bug.
         *
         * A mixed directory has two namespaces overlaid — legacy chats under ordinary names, new chats
         * under marked ones — and §4 requires the caller to see one list with the logical name of every
         * file in it, whichever form it is stored in.
         * @param {string} p Directory path
         * @param {object} [opts] `fs.readdirSync` options
         * @returns {Array} Logical entries
         */
        readdir(p, opts) {
            const entries = fs.readdirSync(p, opts);

            if (!opts?.withFileTypes) {
                return entries.map((name) => demangle(String(name)));
            }

            // With `withFileTypes` the caller gets Dirents and reads `.name`, so the logical name has to
            // be on the object it actually looks at. Directories are never mangled — `mkdir` passes
            // through — so only file entries ever change here.
            return entries.map((entry) => Object.create(entry, {
                name: { value: demangle(entry.name), enumerable: true },
            }));
        },

        // ---- writes: new files are ours, existing plaintext files stay plaintext (§8) ----------------
        async writeFile(p, data, opts) {
            return writeThrough(p, data, opts);
        },
        writeFileSync(p, data, opts) {
            return writeThrough(p, data, opts);
        },

        unlink(p) {
            const found = resolve(p);
            return fs.unlinkSync(found ? found.actual : p);
        },
        rename(from, to) {
            // §8: renaming is not a conversion. A file keeps the form it already had, so the destination
            // name is marked if and only if the source was.
            const found = resolve(from);

            if (!found) {
                return fs.renameSync(from, to);
            }

            return fs.renameSync(found.actual, found.ours ? markedPath(to) : to);
        },
        copyFile(from, to) {
            // A copy of a plaintext chat is plaintext; a copy of an encrypted one is encrypted.
            const found = resolve(from);

            if (!found) {
                return fs.copyFileSync(from, to);
            }

            return fs.copyFileSync(found.actual, found.ours ? markedPath(to) : to);
        },
        rm(p, opts) {
            const found = resolve(p);
            return fs.rmSync(found ? found.actual : p, opts);
        },

        /**
         * 📎 A DELIBERATE PLAINTEXT PASSTHROUGH FOR UPLOAD STAGING — and it must stay deliberate.
         *
         * This provider chooses not to protect the staging copy: an upload lands in `<userRoot>/_uploads` in
         * the clear, is consumed by the handler, and is deleted before the request ends. That is a defensible
         * choice for a fixture, and `storage-provider-upload-staging.test.js` is built to prove the staging
         * directory is emptied rather than to prove it is encrypted.
         *
         * 🔴 IT IS DECLARED RATHER THAN LEFT ABSENT BECAUSE THOSE TWO USED TO BE THE SAME THING. Omitting
         * this seam made `uploadEngine()` fall back to multer's own disk engine, which writes with raw `fs`
         * inside the provider's own tree — so a real provider that simply had not implemented the seam got
         * plaintext staging silently, and this suite asserted that `_uploads` exists, which recorded the
         * accident as correct behaviour. The fork now refuses that fallback, so a provider must SAY it wants
         * passthrough. This fixture says so.
         * @returns {any} A multer storage engine
         */
        multerStorage() {
            return multer.diskStorage({
                destination: (request, _file, cb) => {
                    const root = request.user?.directories?.root;

                    if (!root) {
                        return cb(new Error('No user directory on the request; upload staging has nowhere to go.'), '');
                    }

                    const uploadsPath = path.join(root, UPLOADS_DIRECTORY);
                    fs.mkdirSync(uploadsPath, { recursive: true });
                    cb(null, uploadsPath);
                },
            });
        },
    };
}
