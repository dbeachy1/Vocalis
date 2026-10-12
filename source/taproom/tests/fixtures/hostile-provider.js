import fs from 'node:fs';
import path from 'node:path';

import { EPROVIDER, StorageError } from '../../src/storage.js';

/**
 * 🔴 THE HOSTILE PROVIDER.
 *
 * A Storage Provider whose every read throws. It contains no cryptography. It is a permanent test
 * fixture, and it is the scoreboard for the entire Storage Provider API.
 *
 * ## What it is for
 *
 * A locked vault and a broken vault look IDENTICAL to SillyTavern: the data is there, and it cannot be
 * read. SillyTavern's response to "cannot be read" is, in six separate places, to destroy it and
 * rebuild from source — it deletes the vector index on a SyntaxError, it re-scans the entire chat
 * corpus when stats.json will not parse, it silently repairs the character cache by rewriting it in
 * cleartext, and `data-maid` reports every one of the user's images and Data Bank files as an orphan
 * and offers to delete them.
 *
 * Those paths are live bugs today. Encryption merely guarantees you will hit them.
 *
 * So SillyTavern must survive a boot against this provider with NOTHING DELETED, NOTHING REGENERATED,
 * NOTHING REWRITTEN IN PLAINTEXT, and EVERY FAILURE LOUD. If it survives the hostile provider, it will
 * survive a locked vault.
 *
 * ## Why it reports itself READY
 *
 * `isReady()` returns TRUE, and that is the whole point. A provider that reported itself unavailable
 * would let SillyTavern take the easy path — defer the work, touch nothing, and pass without having
 * proved anything. This provider claims to be perfectly ready and then fails every single read, which
 * is the BROKEN vault rather than the merely LOCKED one. SillyTavern cannot dodge it: it has to
 * actually attempt each read, get an EPROVIDER back, and still not destroy anything.
 *
 * It is strictly the harsher of the two cases, and passing it subsumes the other.
 *
 * ## 🔴 STRUCTURE IS READABLE. CONTENT IS NOT. This is deliberate, and it is not what the design said.
 *
 * The design says "a provider whose every read throws". Taken literally — with `exists()` and
 * `readdir()` throwing too — SillyTavern bails out at the very first directory check and never gets
 * anywhere near the code this fixture exists to test. `backupUserSettings` dies on `exists(root)`
 * before it has ever heard of settings.json. `data-maid` never enumerates an image. `stats` never
 * parses a chat. The six destructive paths sit there, untouched and unproven, and the gate goes green
 * having tested nothing but an early return.
 *
 * A broken vault does not lose its directory structure. It loses its CONTENT. So:
 *
 *   exists / stat / readdir / mkdir ... TELL THE TRUTH. The tree is there; its shape is not a secret.
 *   readFile / readFileSync / createReadStream / sendFile ... ALWAYS THROW EPROVIDER.
 *
 * That is the honest model of "the bytes are on the disk and I cannot decode them", and it is strictly
 * harsher, because it marches SillyTavern all the way into `recreateStats`, into the character-cache
 * repair, and into data-maid's orphan sweep — with every single file read failing under it.
 *
 * ## The journal, and why it is the real scoreboard
 *
 * Every call is recorded to a JSONL journal before it throws. This matters more than it sounds.
 *
 * The obvious test — "boot against the provider, then check no files changed" — is VACUOUS while the
 * funnel is incomplete. If SillyTavern never calls the provider at all, it reads the plaintext behind
 * its back, finds everything perfectly readable, does no destructive work, and the data root is
 * untouched. The test passes, and it has proved exactly nothing.
 *
 * So the gate asks the harder question first: DID SILLYTAVERN EVEN ASK? The journal answers it. An
 * empty journal means the funnel leaks — user data is being read through raw `fs`, behind the API,
 * which is precisely the bug the API exists to eliminate.
 *
 * ## Expected result
 *
 * 🔴 THIS FIXTURE FAILS UNTIL F4, AND THAT IS CORRECT. Do not weaken it to make it pass.
 */

/** @type {string} */
let dataRoot = '';

/** @type {string|undefined} */
const journalPath = process.env.ST_HOSTILE_JOURNAL;

/**
 * Record a call, then let the caller decide whether to throw.
 * @param {string} op The operation attempted
 * @param {string} p The logical path it was attempted on
 * @returns {void}
 */
function journal(op, p) {
    if (!journalPath) {
        return;
    }

    const relative = path.relative(dataRoot, path.resolve(p)).split(path.sep).join('/');
    fs.appendFileSync(journalPath, JSON.stringify({ op, path: relative }) + '\n', 'utf-8');
}

/**
 * Every read lands here: recorded, then refused.
 * @param {string} op The operation attempted
 * @param {string} p The logical path that was read
 * @returns {never} Always throws
 */
function refuseRead(op, p) {
    journal(op, p);
    throw new StorageError(EPROVIDER, `The hostile provider refuses to read '${p}'. This is a test fixture, and this is what it is for.`, p);
}

/**
 * Every write lands here.
 *
 * A write is not merely an error under this fixture — it is the disaster itself. It means SillyTavern
 * failed to read the user's data and responded by overwriting it. So it is recorded loudly and refused,
 * and the boot gate asserts the journal contains none of these.
 * @param {string} op The operation attempted
 * @param {string} p The logical path that was written
 * @returns {never} Always throws
 */
function refuseWrite(op, p) {
    journal(op, p);
    throw new StorageError(EPROVIDER, `SillyTavern tried to ${op.toUpperCase()} '${p}' after failing to read it. That is the destructive behaviour this fixture exists to catch.`, p);
}

/**
 * Build the hostile provider.
 * @returns {import('../../src/storage.js').StorageProvider} The provider
 */
export default function createHostileProvider() {
    return {
        id: 'hostile-provider',

        // Everything under <DATA_ROOT>/<handle>/ is user data and is ours. Everything else — the
        // accounts store, the cookie secret, the access log, the model cache — is system data, is not
        // ours, and falls through to the plain filesystem. That rule is meant to be total.
        owns(absPath) {
            const relative = path.relative(dataRoot, path.resolve(absPath));

            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
                return false;
            }

            const handle = relative.split(path.sep)[0];
            return !!handle && !handle.startsWith('_') && !handle.includes('.');
        },

        async init(ctx) {
            dataRoot = path.resolve(ctx.dataRoot);

            if (journalPath) {
                fs.writeFileSync(journalPath, '', 'utf-8');
            }
        },

        // "I am perfectly fine. Ask me for anything." — see above.
        isReady() {
            return true;
        },

        async unlock() { /* Always ready, never unlocks. */ },
        lock() { /* Always ready, never locks. */ },
        async rekey() { /* Accepts any credential change; it has no keys to re-wrap. */ },

        // ---- content: recorded, then refused, every single time --------------------------------
        async readFile(p) { return refuseRead('readFile', p); },
        readFileSync(p) { return refuseRead('readFileSync', p); },
        createReadStream(p) { return refuseRead('createReadStream', p); },
        async sendFile(_res, p) { return refuseRead('sendFile', p); },

        // ---- structure: tells the truth, so SillyTavern walks right into the danger -------------
        exists(p) {
            journal('exists', p);
            return fs.existsSync(p);
        },
        stat(p) {
            journal('stat', p);
            return fs.statSync(p);
        },
        readdir(p, opts) {
            journal('readdir', p);
            return fs.readdirSync(p, opts);
        },

        // ---- write: recorded, then refused ----------------------------------------------------
        async writeFile(p) { return refuseWrite('writeFile', p); },
        writeFileSync(p) { return refuseWrite('writeFileSync', p); },
        createWriteStream(p) { return refuseWrite('createWriteStream', p); },
        unlink(p) { return refuseWrite('unlink', p); },
        rename(from) { return refuseWrite('rename', from); },
        copyFile(from) { return refuseWrite('copyFile', from); },
        cp(from) { return refuseWrite('cp', from); },
        rm(p) { return refuseWrite('rm', p); },

        // mkdir is the one write that is harmless and must keep working:
        // `ensurePublicDirectoriesExist` walks the structural directories at boot, and those carry no
        // user data. Creating an empty directory reveals nothing and destroys nothing.
        mkdir(p) { journal('mkdir', p); },

        // ---- the node-persist seam -------------------------------------------------------------
        //
        // The parsed-character-card cache is a node-persist store, and node-persist writes its own
        // files — no funnel will ever catch them. What it DOES offer is `parse` and `stringify`, which
        // are the only path to and from its disk. So this is where a provider's cipher goes, and this
        // is where a broken one fails.
        //
        // Without this, the gate has a hole you could drive a bus through: SillyTavern would get a
        // perfectly good CACHE HIT for every character card, never read the PNG, never call the
        // provider, and serve the user's entire character library out of a plaintext cache while the
        // vault sat there "locked".
        // 🔴 AND A TRAP, DISCOVERED THE HARD WAY — BY KILLING THE SERVER.
        //
        // node-persist's parse is:
        //
        //     parse(str) {
        //         try { return this.options.parse(str); }
        //         catch (e) { this.log('parse error: ', this.stringify(e), 'for:', str); return undefined; }
        //     }
        //
        // Two things follow, and both matter enormously to whoever writes the real provider.
        //
        // 1. IT SWALLOWS THE ERROR. A parse that throws becomes `undefined` — a silent cache MISS. And
        //    `forgiveParseErrors: false` does NOT prevent this; that flag only guards a later validity
        //    check. So a provider CANNOT signal "the data is there and I cannot decode it" through this
        //    hook. It will always look like a miss. What actually keeps SillyTavern safe is that the
        //    miss sends it to re-read the card PNG — and THAT read goes through the funnel and fails
        //    properly. The PNG is the guard, not the cache.
        //
        // 2. THE CATCH BLOCK CALLS `this.stringify(e)`. Its arguments are evaluated before `log` runs,
        //    whether logging is on or not. So if stringify ALSO throws, that throw escapes from inside
        //    an `fs.readFile` CALLBACK — an uncaught exception, and the process DIES. A real provider
        //    whose stringify throws while locked would take SillyTavern down with it.
        //
        // ∴ stringify must be TOTAL. It may never throw. This fixture models that: parse fails, and
        //   stringify quietly returns a marker instead of exploding.
        keyValueOptions(handle) {
            return {
                parse: () => {
                    journal('kv:parse', path.join(dataRoot, handle, '_cache'));
                    throw new StorageError(EPROVIDER, 'The hostile provider cannot decode the key-value store.');
                },
                stringify: (value) => {
                    journal('kv:stringify', path.join(dataRoot, handle, '_cache'));
                    return JSON.stringify(value === undefined ? null : value);
                },
            };
        },
    };
}
