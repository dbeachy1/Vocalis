import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * A byte-exact census of a data root.
 *
 * The boot gate works by taking one of these before SillyTavern boots against the hostile provider and
 * another one after, then proving that nothing under any user's directory moved. Hashes, not mtimes:
 * a file that is rewritten with identical content has still been rewritten, but for the purpose of
 * "did we lose the user's data" identical bytes are identical bytes, and mtimes are too noisy to
 * assert on.
 */

/**
 * A single file's census entry.
 * @typedef {object} ManifestEntry
 * @property {number} size Size in bytes
 * @property {string} sha256 Hex digest of the contents
 */

/**
 * Walk a directory tree and hash every file in it.
 * @param {string} root Directory to walk
 * @returns {Map<string, ManifestEntry>} Map of POSIX-style relative path to entry
 */
export function takeManifest(root) {
    /** @type {Map<string, ManifestEntry>} */
    const manifest = new Map();

    if (!fs.existsSync(root)) {
        return manifest;
    }

    /**
     * @param {string} dir Directory to descend into
     * @returns {void}
     */
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const absolute = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                walk(absolute);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const contents = fs.readFileSync(absolute);
            const relative = path.relative(root, absolute).split(path.sep).join('/');

            manifest.set(relative, {
                size: contents.length,
                sha256: crypto.createHash('sha256').update(contents).digest('hex'),
            });
        }
    }

    walk(root);
    return manifest;
}

/**
 * What changed between two manifests?
 * @param {Map<string, ManifestEntry>} before The census taken before the boot
 * @param {Map<string, ManifestEntry>} after The census taken after the boot
 * @param {(relativePath: string) => boolean} [filter] Only consider paths matching this
 * @returns {{deleted: string[], modified: string[], created: string[]}} The damage
 */
export function diffManifests(before, after, filter = () => true) {
    const deleted = [];
    const modified = [];
    const created = [];

    for (const [relative, entry] of before) {
        if (!filter(relative)) {
            continue;
        }

        const now = after.get(relative);

        if (!now) {
            deleted.push(relative);
            continue;
        }

        if (now.sha256 !== entry.sha256) {
            modified.push(relative);
        }
    }

    for (const relative of after.keys()) {
        if (filter(relative) && !before.has(relative)) {
            created.push(relative);
        }
    }

    return {
        deleted: deleted.sort(),
        modified: modified.sort(),
        created: created.sort(),
    };
}

/**
 * Is this path user data — that is, does it live under `<DATA_ROOT>/<handle>/`?
 *
 * This is the same total rule the Storage Provider API rests on. Everything else directly under the
 * data root is system data: `_storage` (the accounts DB), `_cache` (tokenizer blobs), `_uploads`,
 * `_webpack`, `_errors`, `cookie-secret.txt`, `access.log`, `heartbeat.json`. A provider never sees any
 * of it, so the boot gate does not hold SillyTavern to account for it either.
 * @param {string} relativePath POSIX-style path relative to the data root
 * @returns {boolean} True if the path belongs to a user
 */
export function isUserData(relativePath) {
    const segments = relativePath.split('/');

    if (segments.length < 2) {
        return false;
    }

    const handle = segments[0];
    return !handle.startsWith('_') && !handle.includes('.');
}
