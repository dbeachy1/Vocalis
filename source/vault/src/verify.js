import fs from 'node:fs';
import path from 'node:path';

import { MAGIC, HEADER_SIZE, decryptBuffer, parseHeader } from './crypto/content-cipher.js';
import { deriveSubkeys, unlockWithPassword } from './crypto/vault.js';
import { VAULT_KEYS_FILENAME, listVaultedHandles, readVaultKeys } from './vault-store.js';
import { isMarkedName, isSidecar, NAME_SCHEME_MIXED } from './crypto/name-cipher.js';
import { unwrapEnvelope } from './envelope.js';
import { namesOwnLeaf, rememberHandles, userRoot } from './paths.js';
import { foreignStoreFor, loadForeignStores } from './foreign-stores.js';
import { createVaultState } from './vault-state.js';
import { ownStoreFor } from './own-stores.js';

/**
 * The read-only walker: go and look at the disk, and say what is actually on it.
 *
 * ## The question it answers
 *
 * An in-process JavaScript library can `import fs` and write wherever it likes. Nothing in this plugin can
 * stop it — not a funnel, not a provider, not a guard. Three of them did exactly that, and it took months
 * to find them: node-persist wrote every character card in the clear, multer staged every upload in the
 * clear, and vectra inlined the verbatim text of every chat message into its own index file.
 *
 * Those three are fixed. **The fourth one has not been written yet.** Any SillyTavern extension, any new
 * dependency, any upstream refactor can add another one tomorrow, and it will not announce itself: nothing
 * breaks, no error is thrown, the app works perfectly. There is just a file on the disk with your chats in
 * it.
 *
 * So this does not try to PREVENT that — it cannot, and pretending otherwise would be theatre. It makes it
 * **impossible to do unnoticed**. Every file under a vaulted user's directory is either something we can
 * account for, or it is reported, loudly, by name.
 *
 * ## Two depths
 *
 * - **Shallow (no password).** Needs no key at all: every file must carry the `STV1` magic. Anything that
 *   does not is plaintext, and plaintext is the bug. This is the one that catches a rogue writer, and it can
 *   be run by a cron job at 3am without a secret anywhere near it.
 * - **Deep (with the password).** Also DECRYPTS every file, proving the whole account is readable and that
 *   the key on the disk really does open it. This is the one that tells you a backup is restorable.
 *
 * 🔴 It never writes anything. Not a fix, not a quarantine, not a deletion. A tool that "repairs" what it
 * does not understand is how data gets destroyed; this one reports and gets out of the way.
 */

/** What a file turned out to be. */
export const VERDICT = {
    /** Encrypted, as it should be. */
    CIPHERTEXT: 'ciphertext',
    /** The key/value store's own envelope — encrypted, under a keyed filename. */
    KEY_VALUE: 'key-value',
    /** `.vault-keys.json`. Plaintext by necessity: it is what you unlock WITH. */
    VAULT_KEYS: 'vault-keys',
    /** A long-name companion file. Holds a ciphertext name, nothing else. */
    SIDECAR: 'sidecar',
    /** Inside a registered foreign store: encrypted by its owner, under a subkey, and not by us. */
    FOREIGN: 'foreign',
    /** 🔴 Inside a foreign store, and carrying a signature its owner swore would never appear. */
    FOREIGN_PLAINTEXT: 'FOREIGN-PLAINTEXT',
    /** 🔴 NOT ENCRYPTED. Something wrote this behind the provider's back. */
    PLAINTEXT: 'PLAINTEXT',
    /**
     * Plaintext, and that is CORRECT: it predates the plugin, in a mixed-mode account. See {@link classify}
     * for what this verdict can and cannot prove.
     */
    LEGACY: 'legacy',
    /** 🔴 Encrypted, and the key on the disk does not open it. */
    UNREADABLE: 'UNREADABLE',
};

/**
 * Walk one user's directory and classify every file in it.
 * @param {string} dataRoot The data root
 * @param {string} handle The user handle
 * @param {string} [password] Their password, to also PROVE every file decrypts
 * @returns {Promise<{handle: string, deep: boolean, files: {path: string, verdict: string, detail?: string}[]}>}
 * What is there, and whether the walk that found it actually decrypted anything
 */
export async function verifyUser(dataRoot, handle, password, vault = undefined) {
    // 🔴 STANDING ALONE, IT BUILDS ITS OWN. `verify` runs from cron with no provider anywhere in the
    // process, so there is no provider state to borrow -- and borrowing a global one is exactly what this
    // whole change removed. A caller that already has a vault (the CLI, walking several accounts) passes
    // it, so the foreign-store registry is read once rather than once per account.
    const state = vault ?? createVaultState();

    state.dataRoot = dataRoot;
    const root = userRoot(dataRoot, handle);
    const keys = readVaultKeys(dataRoot, handle);

    // ⚠️ Standing alone — the cron case this tool was built for — no plugin has registered anything, because
    // no plugin has been loaded. The declarations have to come off the disk or every foreign store reads as
    // a leak, which is the whole failure being fixed here.
    loadForeignStores(state, dataRoot);

    if (!keys) {
        throw new Error(`'${handle}' has no vault — there is nothing here to verify.`);
    }

    // Only if we were given a password. The shallow walk deliberately needs no key: it is the one that
    // catches a rogue writer, and it should be runnable from cron with no secret anywhere near it.
    // ⚠️ The DEK is held separately rather than inlined, because `deriveSubkeys` does NOT return it — see
    // `session.open`, which spreads the subkeys and adds `dek` alongside. Inlined, the DEK was a temporary
    // with no name, which made it impossible to wipe and easy not to notice.
    const dek = password ? await unlockWithPassword(keys, password) : null;
    const subkeys = dek ? deriveSubkeys(dek) : null;
    // 🔴 BOTH, AND THE SECOND ONE IS WHAT KEEPS THIS TOOL SHARP. Mixed NAMES only make a plaintext file
    // *possible*; `legacyData` says whether this account ever actually had one. A vault created on an empty
    // account -- every account in existence today -- has none, so a plaintext file in it is a leak and is
    // still reported as one, exactly as before. See `createVaultFor`.
    const mixed = keys.nameScheme === NAME_SCHEME_MIXED && keys.legacyData === true;

    /** @type {{path: string, verdict: string, detail?: string}[]} */
    const files = [];

    /**
     * @param {string} directory Where to look
     * @returns {void}
     */
    function walk(directory) {
        const entries = fs.readdirSync(directory, { withFileTypes: true });

        // Same listing, same reason as `readdir` in `provider.js`: a `.nm` name is a companion or a long name
        // whose own extension is `.nm`, and only the neighbours can say which. Reporting a user's file as
        // SIDECAR would excuse it from the plaintext check that is the entire point of this tool.
        const present = new Set(entries.map(e => e.name));
        const hasSibling = (name) => present.has(name);

        for (const entry of entries) {
            const full = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                walk(full);
                continue;
            }

            if (entry.isFile()) {
                files.push(classify(state, full, path.relative(root, full), entry.name, subkeys, mixed, keys.nameScheme === NAME_SCHEME_MIXED, hasSibling));
                continue;
            }

            // 🔴 EVERYTHING ELSE WAS SILENTLY DROPPED, AND "SILENTLY" IS THE PROBLEM.
            //
            // `isDirectory()` and `isFile()` are BOTH false for a symlink, a FIFO, a socket and a device
            // node. Such an entry was neither walked, nor classified, nor counted -- there was no residual
            // branch at all -- so `report.files.length` and the "nothing readable on the disk" line were
            // both computed over a set that quietly excluded it.
            //
            // Which is a hole straight through the tool's purpose: create `chats/export.jsonl` as a SYMLINK
            // pointing at `/tmp/export.jsonl`, write cleartext through it, and verify reports the account
            // clean and exits 0. The file's own heading promises that every file under a vaulted user's
            // directory is "either something we can account for, or it is reported, loudly, by name".
            //
            // Deliberately not followed: `readdirSync` is lstat-based, and following the link would both
            // read outside the data root and let a loop hang the walk. Naming it is the whole job -- an
            // operator who sees this knows to go and look, and nothing else in the tool can tell them.
            files.push({
                path: path.relative(root, full),
                verdict: VERDICT.UNREADABLE,
                detail: entry.isSymbolicLink()
                    ? 'a SYMLINK, not a regular file -- its target is outside this walk and is not verified'
                    : 'not a regular file (socket, FIFO or device node) -- nothing here can verify it',
            });
        }
    }

    // 🔴 THE RECOVERY WRAP, CHECKED — BECAUSE THIS TOOL TELLS YOU TO BACK IT UP AND NEVER LOOKED AT IT.
    //
    // `bin/verify.js` closes every run with a paragraph about `.vault-keys.json` being the thing you must
    // keep a copy of, and VAULT_KEYS was returned from the FILENAME alone. So `wrap_recovery` -- the only
    // way back into an account whose password is forgotten -- was never unwrapped, never parsed, never even
    // measured. A partial restore that truncates it leaves a deep verify printing "nothing readable on the
    // disk" and "(decrypted, every one)"; months later the password is forgotten, the printed recovery key
    // is typed in, and the single path back fails. The one tool that could have said so said the opposite.
    //
    // ⚠️ THIS CANNOT BE A FULL CHECK, and pretending otherwise would be the same lie in a smaller font. The
    // wrap only opens under the recovery key itself, which is on a piece of paper by design and is never on
    // this machine. What IS checkable without it is the shape: present, base64, and exactly the length a
    // wrap of a 32-byte DEK produces -- a 12-byte nonce, 32 bytes of ciphertext, a 16-byte tag. Every
    // truncation, every empty string and every "the field is gone" is caught by that; only a same-length
    // corruption slips through, and that is what the caveat below says.
    const wrapProblem = describeRecoveryWrapProblem(keys.wrap_recovery);

    if (wrapProblem) {
        files.push({
            path: VAULT_KEYS_FILENAME,
            verdict: VERDICT.UNREADABLE,
            detail: `the RECOVERY WRAP is unusable: ${wrapProblem}. A forgotten password cannot be recovered from`
                + ' this account. Restore .vault-keys.json from a backup.',
        });
    }

    walk(root);

    // 🔴 WIPE THE KEYS THE DEEP WALK DERIVED. This is a full set — the DEK plus all four subkeys — and none
    // of it ever enters `vault.sessions`, so `session.close()` cannot reach it. Dropping the reference leaves
    // every one of them in the heap.
    //
    // "It is a short-lived CLI process, so who cares" is not the whole story, and this file says so itself:
    // `summarize()` exists to serve "a second consumer — an HTTP endpoint, a test, anything". A deep verify
    // triggered from the running server would leave a live key set behind on every call, in exactly the
    // long-lived process the wiping discipline is written for.
    for (const value of [dek, ...Object.values(subkeys ?? {})]) {
        if (Buffer.isBuffer(value)) {
            value.fill(0);
        }
    }

    // 🔴 THE DEPTH IS A PROPERTY OF THE WALK, NOT OF WHAT THE CALLER MEANT TO ASK FOR.
    //
    // `bin/verify.js` used to decide this for itself, from whether a password had been typed — and it was
    // wrong whenever the password did not actually reach the account (it could not: the map it built was
    // always empty for a whole-root run). It printed "(decrypted, every one)" over a keyless walk, which is
    // the one sentence this tool must never say falsely: the operator's whole reason to type a password is
    // to be told the account is RECOVERABLE, not merely encrypted.
    //
    // Reported from here, where `subkeys` either exists or does not, it cannot drift from the truth again.
    return { handle, deep: subkeys !== null, files };
}

/**
 * What is this file?
 * @param {string} full Absolute path
 * @param {string} relative Path within the user's directory
 * @param {string} name The file's own name
 * @param {{kContent: Buffer, kCache: Buffer}|null} subkeys The keys, if we have them
 * @param {boolean} mixed Does this account genuinely hold plaintext that predates the vault?
 * @param {boolean} marksNames Does this account mark its encrypted filenames?
 * @param {(name: string) => boolean} [hasSibling] Does a given name exist in the same directory?
 * @returns {{path: string, verdict: string, detail?: string}} The verdict
 */
function classify(vault, full, relative, name, subkeys, mixed, marksNames, hasSibling) {
    const at = relative.split(path.sep).join('/');

    // The key file. Plaintext by necessity -- it is what you unlock WITH -- and it gives nothing away:
    // salts and wrapped blobs are exactly what an attacker is expected to have.
    if (name === VAULT_KEYS_FILENAME) {
        return { path: at, verdict: VERDICT.VAULT_KEYS };
    }

    // A long-name companion. Holds a ciphertext name and nothing else.
    if (isSidecar(name, hasSibling)) {
        return { path: at, verdict: VERDICT.SIDECAR };
    }

    const bytes = fs.readFileSync(full);

    // A directory another plugin owns and encrypts itself, declared through `registerForeignStore`.
    //
    // 🔴 THIS IS THE ONE EXEMPTION IN THIS FILE, AND IT IS NOT A BLANKET ONE. We hold no key for a foreign
    // store, so we cannot prove its bytes are ciphertext — but the alternative was worse than imperfect, it
    // was actively corrosive: a SQLCipher database carries no `STV1` header, so it read as PLAINTEXT on
    // every run for ever, and a leak detector with a permanent false positive is one the operator learns to
    // skim. The real fourth leak then lands in a report nobody reads.
    //
    // So the claim is checked as far as it can be. The owner declares signatures that must never appear at
    // the head of one of its files, and those ARE tested — with no key, from cron. A SQLCipher store
    // declaring the plain-SQLite header catches "it was built without encryption and quietly wrote a normal
    // database": the realistic failure for such a store, invisible from inside it, and caught here.
    const foreign = foreignStoreFor(vault, at);

    if (foreign) {
        const head = bytes.subarray(0, 64);
        const broken = foreign.forbidden.find(signature => head.subarray(0, signature.length).toString('latin1') === signature);

        if (broken !== undefined) {
            return {
                path: at,
                verdict: VERDICT.FOREIGN_PLAINTEXT,
                detail: `${foreign.owner} swore this would never start with ${JSON.stringify(broken)}, and it does. Its encryption is not working.`,
            };
        }

        return {
            path: at,
            verdict: VERDICT.FOREIGN,
            detail: foreign.forbidden.length === 0
                ? `claimed by ${foreign.owner}, which declared nothing we can check — UNVERIFIABLE, not verified`
                : `encrypted by ${foreign.owner}, not by us`,
        };
    }

    // 🔀 A store WE operate that writes its own bytes -- the character-card cache, through
    // node-persist. Its own envelope, its own key, its own keyed filenames. Different format, same
    // promise: no plaintext.
    //
    // The store declares all of that in `own-stores.js`. This used to hold a second copy of the tag,
    // synchronised by a comment reading "Kept in step with key-value.js", and matched on the bare prefix
    // `_cache/` -- which is the PARENT of the real store, so anything dropped anywhere under `_cache/`
    // was judged by this store's rules.
    const own = ownStoreFor(at);

    if (own) {
        const text = bytes.toString('utf-8');

        if (!text.startsWith(own.envelope)) {
            return { path: at, verdict: VERDICT.PLAINTEXT, detail: 'a key/value entry that is not an encrypted envelope' };
        }

        if (!subkeys) {
            return { path: at, verdict: own.verdict };
        }

        try {
            decryptBuffer(subkeys.kCache, Buffer.from(text.slice(own.envelope.length), 'base64'));
            return { path: at, verdict: own.verdict };
        } catch (error) {
            return { path: at, verdict: VERDICT.UNREADABLE, detail: error.message };
        }
    }

    // 🔀 MIXED MODE, AND THE HONEST LIMIT OF THIS TOOL — `DESIGN_MIXED_MODE.md` §14.4, answered: YES, verify
    // has to learn about passthrough files, and here is exactly how far that can go.
    //
    // In a scheme-2 account some files legitimately predate the plugin and are plaintext for ever (§1).
    // Reporting them as PLAINTEXT would be a permanent false alarm on every run — precisely the corrosion
    // the foreign-store exemption above was written to stop, and worse here, because it would be dozens of
    // rows rather than one. An operator who learns to skim this report is an operator who will skim the real
    // fourth leak when it lands.
    //
    // 🔴 BUT THIS VERDICT PROVES LESS THAN THE OTHERS, AND SAYING SO IS THE POINT. A legacy chat and a file
    // a rogue extension wrote behind the provider's back look IDENTICAL on the disk: both are plaintext,
    // both sit under an unmarked name in a directory where unmarked names are expected. There is no keyless
    // test that separates them, because there is no difference to test — only a difference in history.
    //
    // So LEGACY is reported, counted, and NOT treated as a problem, and `bin/verify.js` says plainly what
    // that means. Three things keep it from being a hole:
    //
    //   - It is reachable ONLY in a scheme-2 account. Every vault created before mixed mode is scheme 1,
    //     where every file is ours by construction and PLAINTEXT still means exactly what it always did.
    //     existing scheme-1 accounts are one of those, and lose nothing.
    //   - It is refused wherever we DO name the file. A leaf inside a skeleton directory, or inside a
    //     library-named one, is ours no matter what its name looks like — `namesOwnLeaf` is what makes that
    //     distinction, and plaintext there is still a leak.
    //   - A MARKED name never reaches it. That is the three-state classifier (§3): a file whose name says it
    //     is ours and whose bytes will not open is UNREADABLE — ours and broken — never "not ours".
    if (mixed && !isMarkedName(name) && namesOwnLeaf(vault, at)) {
        return {
            path: at,
            verdict: VERDICT.LEGACY,
            detail: 'plaintext, under a name this plugin did not write — it predates the vault, and is UNVERIFIABLE rather than verified',
        };
    }

    // 🔴 THE OUTER ENVELOPE COMES OFF FIRST, and a marked name that does not carry one is BROKEN, not
    // foreign. The name already said this file is ours; §3's whole argument is that "ours and unreadable"
    // must never be reported as "not ours", because the verdicts point in opposite directions. PLAINTEXT
    // means *this leaked, go and find what wrote it*. UNREADABLE means *this is intact and the key does not
    // open it, touch NOTHING*. Confusing them here would send somebody hunting a leak that does not exist
    // while a damaged chat sits waiting to be "repaired".
    const opened = marksNames ? unwrapEnvelope(bytes) : { ok: true, sealed: bytes };
    const sealed = opened.ok ? opened.sealed : bytes;

    if (marksNames && isMarkedName(name) && !opened.ok) {
        return { path: at, verdict: VERDICT.UNREADABLE, detail: `marked as ours, and ${opened.reason}` };
    }

    // 🔴 EVERYTHING ELSE MUST BE CIPHERTEXT. This is the whole test, and it needs no key: our own files
    // start with a magic header, and anything that does not was written by something that has never heard
    // of this provider.
    if (sealed.length < HEADER_SIZE || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
        return { path: at, verdict: VERDICT.PLAINTEXT, detail: describe(bytes) };
    }

    try {
        parseHeader(sealed.subarray(0, HEADER_SIZE));
    } catch (error) {
        return { path: at, verdict: VERDICT.UNREADABLE, detail: error.message };
    }

    if (!subkeys) {
        return { path: at, verdict: VERDICT.CIPHERTEXT };
    }

    // Deep: prove it actually opens. A file that carries the right header and will not decrypt is the
    // failure a backup only discovers on the day it is needed.
    try {
        decryptBuffer(subkeys.kContent, sealed);
        return { path: at, verdict: VERDICT.CIPHERTEXT };
    } catch (error) {
        return { path: at, verdict: VERDICT.UNREADABLE, detail: error.message };
    }
}


/**
 * Is this account's recovery wrap structurally usable?
 *
 * Shape only, and deliberately so — see the caller. The wrap opens under the recovery key, which lives on
 * paper and never on this machine, so no keyless check can prove it DECRYPTS. What it can prove is that the
 * field is present and is the right size to be a wrap of a 32-byte DEK: a 12-byte GCM nonce, 32 bytes of
 * ciphertext, and a 16-byte tag. That catches every truncation and every missing field, which is what a bad
 * restore actually produces.
 * @param {unknown} wrap The `wrap_recovery` field, as read off the disk
 * @returns {string|null} What is wrong with it, or null if its shape is right
 */
function describeRecoveryWrapProblem(wrap) {
    const EXPECTED_BYTES = 12 + 32 + 16;

    if (wrap === undefined || wrap === null || wrap === '') {
        return 'it is missing';
    }

    if (typeof wrap !== 'string') {
        return `it is a ${typeof wrap}, not a string`;
    }

    const blob = Buffer.from(wrap, 'base64');

    // Node's base64 decoder drops invalid characters rather than throwing, so a re-encode round trip is what
    // actually detects garbage.
    if (blob.toString('base64').replace(/=+$/, '') !== wrap.replace(/=+$/, '')) {
        return 'it is not valid base64';
    }

    if (blob.length !== EXPECTED_BYTES) {
        return `it is ${blob.length} bytes, and a wrap of a 32-byte key is ${EXPECTED_BYTES}`;
    }

    return null;
}
/**
 * A description of what a plaintext file holds — enough to identify the writer, without transcribing the
 * leak into a second place.
 *
 * 🔴 THIS USED TO PRINT THE FIRST 48 BYTES, AND ITS DOCBLOCK CALLED THAT "SHORT, SAFE". IT WAS NEITHER.
 *
 * It is reached for exactly one verdict — PLAINTEXT — which means the bytes it is about to render are, by
 * definition, user data that leaked. For the case this tool exists to catch, a chat JSONL, the first 48
 * bytes are `{"user_name":"the developer","character_name":"…`.
 *
 * And this tool is built to run from cron: `bin/verify.js` says so, and the standard cron idiom mails
 * stdout or redirects it to a file. So finding a leak COPIED IT — into the mail spool, the journal, and the
 * operator's terminal scrollback. Three places outside the vault that did not have it a moment earlier, as
 * the direct result of running the leak detector.
 *
 * The identifying information is in the SHAPE, not the content: a magic number names the format outright,
 * and for text a length and a character profile distinguish a chat from a card from a config without
 * reproducing a single readable word.
 * @param {Buffer} bytes The file
 * @returns {string} A description that identifies the file without quoting it
 */
function describe(bytes) {
    // Magic numbers first — they are the most useful answer and they are not user data.
    const MAGIC = [
        [Buffer.from('\x89PNG\r\n\x1a\n'), 'a PNG (character card?)'],
        [Buffer.from('\xff\xd8\xff', 'latin1'), 'a JPEG'],
        [Buffer.from('GIF8'), 'a GIF'],
        [Buffer.from('RIFF'), 'a RIFF container (WAV/WEBP)'],
        [Buffer.from('OggS'), 'an Ogg stream'],
        [Buffer.from('PK\x03\x04'), 'a ZIP archive'],
        [Buffer.from('SQLite format 3\0', 'latin1'), 'a SQLite database'],
        [Buffer.from('%PDF'), 'a PDF'],
    ];

    for (const [signature, what] of MAGIC) {
        if (bytes.subarray(0, signature.length).equals(signature)) {
            return `${what}, ${bytes.length} bytes`;
        }
    }

    // Otherwise describe the shape. The first non-space character is structural rather than content — `{`
    // and `[` say JSON, `<` says markup — and it is one character, chosen from a set that carries no
    // secret.
    const head = bytes.subarray(0, 512);
    const printable = head.filter(byte => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)).length;
    const looksTextual = printable / Math.max(1, head.length) > 0.9;

    if (!looksTextual) {
        return `binary, ${bytes.length} bytes`;
    }

    const first = head.toString('latin1').trimStart()[0] ?? '';
    const shape = first === '{' || first === '[' ? 'JSON-shaped' : first === '<' ? 'markup-shaped' : 'text';

    return `${shape}, ${bytes.length} bytes`;
}

/**
 * Verify every vaulted account under a data root.
 * @param {string} dataRoot The data root
 * @param {Record<string, string>} [passwords] handle -> password, for a deep verify
 * @returns {Promise<{handle: string, files: {path: string, verdict: string, detail?: string}[]}[]>} The reports
 */
export async function verifyAll(dataRoot, passwords = {}, vault = undefined) {
    const state = vault ?? createVaultState();

    state.dataRoot = dataRoot;
    const reports = [];

    for (const handle of listVaultedHandles(dataRoot)) {
        reports.push(await verifyUser(dataRoot, handle, passwords[handle], state));
    }

    return reports;
}

/**
 * Everything that is wrong, out of a report.
 * @param {{files: {path: string, verdict: string, detail?: string}[]}} report A report
 * @returns {{path: string, verdict: string, detail?: string}[]} The problems
 */
export function problems(report) {
    // FOREIGN is not here, and that is the point of it. FOREIGN_PLAINTEXT is: a store whose owner declared a
    // signature that must never appear, and it appeared, is a plugin whose encryption is not working — which
    // is a louder finding than an unclaimed plaintext file, not a quieter one.
    return report.files.filter(file => file.verdict === VERDICT.PLAINTEXT
        || file.verdict === VERDICT.UNREADABLE
        || file.verdict === VERDICT.FOREIGN_PLAINTEXT);
}

/**
 * 🔴 THE SELF-SUFFICIENT ENTRY POINT — because the half-sufficient one classified files wrongly, silently.
 *
 * `verifyUser` already calls {@link loadForeignStores} itself, for the cron case this tool exists for: no
 * plugin has registered anything because no plugin has been loaded, and without the declarations every
 * foreign file reads as a leak. But `paths.rememberHandles` was left OUTSIDE, in `bin/verify.js` — so the
 * library was self-sufficient about one of its two pieces of boot state and not the other.
 *
 * That is a bad way to be wrong. A caller who forgets it does not get an error; `isUserHandle` falls back
 * to guessing from the disk, and the verdicts come out subtly different with nothing to say so. Both
 * pieces are done here now, so there is one way in and it is correct by default.
 * @param {string} dataRoot The data root
 * @param {Record<string, string>} [passwords] handle -> password, for a deep verify
 * @returns {Promise<{handle: string, deep: boolean, files: {path: string, verdict: string, detail?: string}[]}[]>}
 * One report per vaulted account
 */
export async function verifyDataRoot(dataRoot, passwords = {}) {
    // The provider normally learns the handles from SillyTavern's boot context. Standing alone, it has to
    // find them itself — and a vault is the definition: an account with a `.vault-keys.json` is encrypted.
    const state = createVaultState();

    state.dataRoot = dataRoot;
    rememberHandles(state, listVaultedHandles(dataRoot).map(handle => ({ handle })));

    return await verifyAll(dataRoot, passwords, state);
}

/**
 * Count one report's verdicts.
 *
 * This lived in `bin/verify.js`, which meant a second consumer — an HTTP endpoint, a test, anything —
 * had to re-derive it. It is three lines, and three lines re-derived somewhere else is how two callers
 * come to disagree about what "clean" means.
 * @param {{deep: boolean, files: {verdict: string}[]}} report A report
 * @returns {{total: number, deep: boolean, counts: Record<string, number>, problems: number, clean: boolean}}
 * The tallies
 */
export function summarize(report) {
    /** @type {Record<string, number>} */
    const counts = {};

    for (const file of report.files) {
        counts[file.verdict] = (counts[file.verdict] ?? 0) + 1;
    }

    const bad = problems(report);

    return {
        total: report.files.length,
        deep: report.deep === true,
        counts,
        problems: bad.length,
        clean: bad.length === 0,
    };
}

/**
 * Is every one of these reports clean?
 *
 * 🔴 THE DEFINITION OF "CLEAN" BELONGS BESIDE THE VERDICTS IT IS DEFINED OVER. It was in the CLI, encoded
 * as a loop and a mutable flag, which is where the exit code came from — so the one sentence an operator
 * actually acts on was the one thing no test could reach without spawning a process.
 *
 * FOREIGN and LEGACY are deliberately not problems. See {@link problems} and {@link explain}.
 * @param {{files: {verdict: string}[]}[]} reports Every report
 * @returns {boolean} True if nothing on the disk should not be there
 */
export function isClean(reports) {
    return reports.every(report => problems(report).length === 0);
}

/**
 * What a verdict MEANS, in the words an operator needs.
 *
 * 🔴 THIS BELONGS NEXT TO {@link VERDICT}, AND IT WAS IN THE CLI. `classify` even deferred to it in a
 * comment — "bin/verify.js says plainly what that means" — so the semantics of the enum lived in a file
 * that could not be imported, and no consumer but the CLI could explain its own output.
 * @param {string} verdict One of {@link VERDICT}
 * @returns {string|null} What it means, or null if it needs no explanation
 */
export function explain(verdict) {
    switch (verdict) {
    case VERDICT.PLAINTEXT:
        return 'Something wrote user data behind the provider\'s back — a library holding its own file '
                + 'descriptor, an extension calling fs directly, or a boot task that ran too early.';
    case VERDICT.UNREADABLE:
        return 'The file is encrypted and the key on this disk does not open it. Do NOT delete it. This is '
                + 'a key problem, not a data problem, and the data may still be recoverable.';
    case VERDICT.FOREIGN_PLAINTEXT:
        return 'A plugin that claimed a directory declared a signature that must never appear in it, and it '
                + 'appeared. Its own encryption is not working — go and read that plugin, not this one.';
    case VERDICT.LEGACY:
        return 'Plaintext because it PREDATES the vault, which DESIGN_MIXED_MODE.md §1 says stays that way '
                + 'for ever. Not a finding, and not proof of anything either: a file that predates the vault and '
                + 'a file some extension wrote in the clear last night look identical on the disk. If the plugin '
                + 'was not installed onto an account that already had data, this should be zero.';
    case VERDICT.FOREIGN:
        return 'Encrypted by another plugin under its own subkey, not by us. Stated on every run rather than '
                + 'folded into the clean total: an operator who does not know a plugin claimed a directory '
                + 'cannot notice when it should not have.';
    default:
        return null;
    }
}
