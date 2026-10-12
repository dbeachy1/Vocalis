import fs from 'node:fs';
import path from 'node:path';

import { EUNAVAILABLE, StorageError } from '../../src/storage.js';

/**
 * 🔒 THE LOCKED PROVIDER.
 *
 * The hostile provider models a BROKEN vault: it claims to be ready and then fails every read. This one
 * models a LOCKED vault: it says plainly that it cannot serve the user yet, and it means it.
 *
 * They test different halves of the contract and neither subsumes the other.
 *
 *   hostile → isReady() TRUE, every read throws EPROVIDER.
 *             Proves SillyTavern does not DESTROY data it cannot read.
 *
 *   locked  → isReady() FALSE, every read throws EUNAVAILABLE.
 *             Proves SillyTavern does not TOUCH data it has been told to wait for — that it defers the
 *             boot-time maintenance instead of running it, that it bounces the user to the login page
 *             instead of serving them an empty account, and that the deferred work runs once they
 *             unlock.
 *
 * It contains no cryptography. `unlock` compares against a password handed to it in an environment
 * variable, which is a stand-in for a KDF and a wrapped key. What matters here is the STATE MACHINE —
 * locked, unlocked, locked again on restart — not how the key is derived.
 *
 * Once unlocked, it is a plain pass-through to the filesystem: the data really does become readable,
 * so the test can prove the whole round trip and not merely that failures fail.
 */

/** @type {string} */
let dataRoot = '';

/** @type {Set<string>} Handles whose storage is currently unlocked. */
const unlocked = new Set();

/** The password that unlocks. A real provider would derive a key; this one just compares. */
const secret = process.env.ST_LOCKED_PROVIDER_SECRET ?? 'correct-horse';

/** @type {string|undefined} */
const journalPath = process.env.ST_LOCKED_JOURNAL;

/**
 * Record a call.
 * @param {string} op The operation
 * @param {string} p The logical path
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
 * Which user owns this path?
 * @param {string} absPath Absolute path
 * @returns {string|null} The handle, or null if this is not user data
 */
function handleOf(absPath) {
    const relative = path.relative(dataRoot, path.resolve(absPath));

    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }

    const handle = relative.split(path.sep)[0];
    return handle && !handle.startsWith('_') && !handle.includes('.') ? handle : null;
}

/**
 * Refuse a read because the user's storage is not available yet.
 * @param {string} op The operation
 * @param {string} p The path
 * @returns {never} Always throws
 */
function refuse(op, p) {
    journal(op, p);
    throw new StorageError(EUNAVAILABLE, `Storage for '${p}' is locked. The user must log in.`, p);
}

/**
 * Is this path's owner unlocked?
 * @param {string} p The path
 * @returns {boolean} True if it can be served
 */
function available(p) {
    const handle = handleOf(p);
    return !!handle && unlocked.has(handle);
}

/**
 * Build the locked provider.
 * @returns {import('../../src/storage.js').StorageProvider} The provider
 */
export default function createLockedProvider() {
    return {
        id: 'locked-provider',

        owns(absPath) {
            return handleOf(absPath) !== null;
        },

        async init(ctx) {
            dataRoot = path.resolve(ctx.dataRoot);

            if (journalPath) {
                fs.writeFileSync(journalPath, '', 'utf-8');
            }
        },

        // 🔒 THE WHOLE POINT. Cold on every boot. Nothing in RAM survives a restart, so nothing about
        // being unlocked can either — and SillyTavern must not assume otherwise just because the user
        // still holds a valid session cookie.
        isReady(handle) {
            return unlocked.has(handle);
        },

        async unlock(handle, presented) {
            if (presented !== secret) {
                throw new StorageError(EUNAVAILABLE, 'Wrong secret. Storage stays locked.');
            }

            journal('unlock', path.join(dataRoot, handle));
            unlocked.add(handle);
        },

        lock(handle) {
            journal('lock', path.join(dataRoot, handle));
            unlocked.delete(handle);
        },

        // A provider that cannot re-wrap its key without the old secret must VETO the change. If it let
        // the password change go through, the user's data would be sealed under a key nobody can ever
        // produce again.
        async rekey(handle, oldSecret) {
            if (!unlocked.has(handle) && oldSecret !== secret) {
                throw new StorageError(EUNAVAILABLE, 'Cannot re-key: storage is locked and the old secret was not supplied.');
            }

            journal('rekey', path.join(dataRoot, handle));
        },

        // ---- reads: refused while locked, honest once unlocked ---------------------------------
        async readFile(p, opts) {
            if (!available(p)) return refuse('readFile', p);
            journal('readFile', p);
            return await fs.promises.readFile(p, opts);
        },
        readFileSync(p, opts) {
            if (!available(p)) return refuse('readFileSync', p);
            journal('readFileSync', p);
            return fs.readFileSync(p, opts);
        },
        createReadStream(p, opts) {
            if (!available(p)) return refuse('createReadStream', p);
            journal('createReadStream', p);
            return fs.createReadStream(p, opts);
        },
        async sendFile(res, p) {
            if (!available(p)) return refuse('sendFile', p);
            journal('sendFile', p);
            return await new Promise((resolve, reject) => {
                res.sendFile(path.resolve(p), {}, (error) => error ? reject(error) : resolve());
            });
        },

        // Structure stays visible: a locked vault still has a shape. Directory names are not secrets
        // here, and ensurePublicDirectoriesExist has to keep working before anyone has logged in.
        exists(p) {
            return fs.existsSync(p);
        },
        stat(p) {
            return fs.statSync(p);
        },
        readdir(p, opts) {
            if (!available(p)) return refuse('readdir', p);
            return fs.readdirSync(p, opts);
        },

        // ---- writes: refused while locked ------------------------------------------------------
        async writeFile(p, data, opts) {
            if (!available(p)) return refuse('writeFile', p);
            journal('writeFile', p);
            return await fs.promises.writeFile(p, data, opts);
        },
        writeFileSync(p, data, opts) {
            if (!available(p)) return refuse('writeFileSync', p);
            journal('writeFileSync', p);
            return fs.writeFileSync(p, data, opts);
        },
        createWriteStream(p) {
            if (!available(p)) return refuse('createWriteStream', p);
            return fs.createWriteStream(p);
        },
        unlink(p) {
            if (!available(p)) return refuse('unlink', p);
            journal('unlink', p);
            return fs.unlinkSync(p);
        },
        rename(from, to) {
            if (!available(from)) return refuse('rename', from);
            return fs.renameSync(from, to);
        },
        copyFile(from, to) {
            if (!available(from)) return refuse('copyFile', from);
            return fs.copyFileSync(from, to);
        },
        cp(from, to, opts) {
            if (!available(to)) return refuse('cp', to);
            return fs.cpSync(from, to, opts);
        },
        rm(p, opts) {
            if (!available(p)) return refuse('rm', p);
            journal('rm', p);
            return fs.rmSync(p, opts);
        },

        // Structural, and always permitted: an empty directory reveals nothing.
        mkdir(p, opts) {
            return fs.mkdirSync(p, opts);
        },
    };
}
