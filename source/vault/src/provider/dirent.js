/**
 * A directory entry wearing its LOGICAL name.
 *
 * 🔴 `readdir({ withFileTypes: true })` IS USED IN 38 PLACES IN THE FORK, and every one of them expects
 * objects answering `.name`, `.isFile()` and `.isDirectory()`. Returning the real `fs.Dirent` would hand
 * SillyTavern the ciphertext name; returning a bare string breaks the 38.
 *
 * 🔴 AND `parentPath` MUST BE LOGICAL TOO, BECAUSE THE WHOLE POINT IS THAT THE TWO JOIN.
 *
 * `path.join(entry.parentPath, entry.name)` is THE documented way to turn a `Dirent` back into a path, and
 * it is what node's own examples do. This class used to take `name` from the logical world and `parentPath`
 * straight off the real entry -- so joining them produced a physical directory with a plaintext name inside
 * it: a path that has never existed on the disk and never will.
 *
 * Every way that fails is quiet. Handed back to `storage.*` it is a logical path with a ciphertext prefix,
 * so it resolves somewhere else entirely or throws `ENOENT` for a file that is plainly in the listing. Used
 * with `node:fs` directly it is simply not found. Nothing reports a decryption failure, because nothing
 * decrypted anything -- which is why this survived: the failure never looks like an encryption bug.
 */

/**
 * A directory entry that answers the questions SillyTavern asks of it, under its LOGICAL name.
 */
export class LogicalDirent {
    /**
     * @param {string} name The logical name
     * @param {import('node:fs').Dirent} real The real entry
     * @param {string} [parentPath] The LOGICAL directory it was listed from. Omitted, it falls back to the
     * physical one — which keeps a caller that never joins the two working, and is the old behaviour.
     */
    constructor(name, real, parentPath) {
        this.name = name;
        this.parentPath = parentPath ?? real.parentPath;

        // `path` is node's deprecated alias for `parentPath` and some of the 38 still read it. It has to say
        // the same thing: two names for one value that disagree is worse than either answer on its own.
        this.path = this.parentPath;
        this.#real = real;
    }

    /** @type {import('node:fs').Dirent} */
    #real;

    /** @returns {boolean} True if a file */
    isFile() {
        return this.#real.isFile();
    }

    /** @returns {boolean} True if a directory */
    isDirectory() {
        return this.#real.isDirectory();
    }

    /** @returns {boolean} True if a symlink */
    isSymbolicLink() {
        return this.#real.isSymbolicLink();
    }

    /** @returns {boolean} Always false */
    isBlockDevice() {
        return false;
    }

    /** @returns {boolean} Always false */
    isCharacterDevice() {
        return false;
    }

    /** @returns {boolean} Always false */
    isFIFO() {
        return false;
    }

    /** @returns {boolean} Always false */
    isSocket() {
        return false;
    }
}
