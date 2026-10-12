import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Writes that cannot be torn.
 *
 * 🔴 A HALF-WRITTEN CIPHERTEXT DOES NOT DECRYPT TO HALF A CHAT. It decrypts to nothing, and it does so
 * with an authentication failure that is indistinguishable from tampering -- so a torn write here is not
 * a damaged file, it is a lost file that cannot even be diagnosed. Write beside it, then rename: rename
 * is atomic within a filesystem, so the destination is either the old bytes or all of the new ones.
 *
 * ## Three things "write beside it, then rename" does not give you on its own
 *
 * The rename is necessary and it is not sufficient, and each of these was missing here:
 *
 * 1. **A temp name that is unique per WRITE.** It was `${target}.tmp-${process.pid}`, which is unique per
 *    process and per target -- and two concurrent writes to one path are neither. Both writers opened the
 *    same temp with `O_TRUNC`, both wrote from offset zero, and then one rename consumed the file and the
 *    other got ENOENT for a file that plainly exists. The interleaving case is worse: the committed bytes
 *    are a prefix of one payload and a tail of the other, which is a permanently undecryptable file.
 *    `process.pid` bought cross-process safety only, and `createVaultProvider` is a factory -- there are
 *    two providers in one process by design.
 *
 * 2. **Removing the temp when anything fails.** A surviving temp is NOT inert. It sits in the vault
 *    namespace under a name the decoder will parse on the next `readdir`: a short one decodes back to the
 *    original logical name and the chat appears TWICE, the phantom outliving any attempt to delete it; a
 *    long one has no `.nm` companion and takes out the entire directory listing. Rename failing is routine
 *    on Windows (EPERM/EBUSY onto an open target), and ENOSPC mid-write is routine everywhere.
 *
 * 3. **fsync.** `rename(2)` is atomic for the DIRECTORY ENTRY. It says nothing about whether the data the
 *    entry points at ever reached the disk. Without an fsync of the file before the rename, power loss can
 *    leave the new name pointing at unwritten blocks -- zero bytes under a name that says it is ours,
 *    which is EPROVIDER for ever on a file the caller was told was written. ext4's `data=ordered`
 *    heuristic usually hides this; it is a heuristic, and it does not hold on XFS, on `data=writeback`,
 *    or on a network filesystem.
 */

/**
 * A temp path that no concurrent write can collide with.
 * @param {string} target Where the file is really going
 * @returns {string} A sibling path, unique per call
 */
function temporaryFor(target) {
    return `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Force a directory's own entries to disk, if this platform can.
 *
 * Best effort: on Linux, syncing the directory makes the rename durable. Windows cannot open a directory as a
 * file (`fs.open(dir, 'r')` fails with EPERM), so this step is skipped there rather than failing the write.
 * @param {string} directory The directory to sync
 * @returns {Promise<void>}
 */
async function syncDirectory(directory) {
    let handle;

    try {
        handle = await fs.promises.open(directory, 'r');
        await handle.sync();
    } catch {
        // Windows, or a filesystem that does not permit it. See above.
    } finally {
        await handle?.close();
    }
}

/**
 * @param {string} directory The directory to sync
 * @returns {void}
 */
function syncDirectorySync(directory) {
    let fd;

    try {
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
    } catch {
        // See `syncDirectory`.
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}

/**
 * Write a file atomically: a torn write is a lost file, and here it would be a lost file that cannot even
 * be diagnosed, because half a ciphertext does not decrypt to half a chat -- it decrypts to nothing.
 * @param {string} target Where it goes
 * @param {Buffer} bytes What goes there
 * @returns {Promise<void>}
 */
export async function atomicWrite(target, bytes) {
    const directory = path.dirname(target);
    const temporary = temporaryFor(target);

    await fs.promises.mkdir(directory, { recursive: true });

    try {
        const handle = await fs.promises.open(temporary, 'w');

        try {
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle.close();
        }

        await fs.promises.rename(temporary, target);
    } catch (error) {
        // The temp must not survive the failure -- see (2) in the module docblock. `force` so that a
        // failure BEFORE the file existed does not throw a second, misleading error over the first.
        await fs.promises.rm(temporary, { force: true });
        throw error;
    }

    await syncDirectory(directory);
}

/**
 * @param {string} target Where it goes
 * @param {Buffer} bytes What goes there
 * @returns {void}
 */
export function atomicWriteSync(target, bytes) {
    const directory = path.dirname(target);
    const temporary = temporaryFor(target);

    fs.mkdirSync(directory, { recursive: true });

    try {
        const fd = fs.openSync(temporary, 'w');

        try {
            fs.writeFileSync(fd, bytes);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }

        fs.renameSync(temporary, target);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }

    syncDirectorySync(directory);
}
