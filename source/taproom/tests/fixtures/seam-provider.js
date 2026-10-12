import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

/**
 * 🔴 THE SEAM PROVIDER: does SillyTavern actually CALL the library seams it advertises?
 *
 * The other fixtures test what the storage funnel does. This one tests whether three specific doors are
 * even connected to anything — because two of them were not, and it did not look like a bug from any angle.
 *
 * `multer`, `node-persist` and `vectra` all write user data with their OWN `fs` calls. They never pass
 * through `storage.*`, so every guard in the funnel is simply irrelevant to them. The fork therefore offers
 * three hooks — `multerStorage()`, `keyValueOptions()` and `vectorIndex()` — and a provider that implements
 * them takes control of those bytes.
 *
 * The catch is that a hook nobody calls is indistinguishable from a hook that works. `storage.multerStorage()`
 * was being asked for at MODULE SCOPE, long before any provider had registered, so it always answered null,
 * the plaintext fallback was installed permanently, and the seam was dead code on every install that ever
 * ran. Nothing failed. Uploads worked. They just went to the disk in the clear.
 *
 * So this provider does nothing except WRITE DOWN THAT IT WAS ASKED, into a journal file. The tests then
 * assert on that journal. It is the same trick that fixed the boot gate: before asking "did you handle it
 * correctly?", ask "did you even call me?"
 *
 * ⛔ NO CRYPTOGRAPHY HERE, AND THERE NEVER MAY BE. This is the fork's test suite, and the fork contains no
 * crypto. The "transform" is a marker prefix. It is not confidentiality and does not pretend to be — it is
 * simply something a plain `fs` write could not have produced, which is exactly what makes it evidence.
 */

/** Where the journal goes. */
const journalPath = process.env.ST_SEAM_JOURNAL ?? '';

/** Prefix marking bytes this provider wrote. Something node's own fs would never put there. */
const MARK = Buffer.from('SEAM:');

/** @type {string} */
let dataRoot = '';

/**
 * Record that a seam fired.
 * @param {string} what The seam
 * @returns {void}
 */
function journal(what) {
    if (journalPath) {
        fs.appendFileSync(journalPath, `${what}\n`, 'utf-8');
    }
}

/**
 * Which user owns this path?
 * @param {string} absPath Absolute path
 * @returns {string|null} The handle, or null
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
 * Add the marker.
 * @param {Buffer} plain The bytes
 * @returns {Buffer} Marked bytes
 */
const mark = (plain) => Buffer.concat([MARK, plain]);

/**
 * Take the marker off, if it is there.
 * @param {Buffer} stored The bytes on disk
 * @returns {Buffer} The bytes without the marker
 */
const unmark = (stored) => stored.subarray(0, MARK.length).equals(MARK) ? stored.subarray(MARK.length) : stored;

/**
 * Build the seam provider.
 * @returns {any} The provider
 */
export default function createSeamProvider() {
    return {
        id: 'seam-provider',

        owns: (absPath) => handleOf(absPath) !== null,
        ownsUser: () => false,
        isReady: () => true,
        async unlock() { /* no key, no lock: this fixture is about the seams, nothing else */ },
        lock() { },
        async rekey() { },

        async init(context) {
            dataRoot = path.resolve(context.dataRoot);
        },

        // ---- the three library seams ------------------------------------------------------------

        multerStorage() {
            journal('multerStorage() asked for');

            return {
                _handleFile(request, file, callback) {
                    journal('multerStorage._handleFile');

                    const root = request?.user?.directories?.root ?? dataRoot;
                    const destination = path.join(root, '_uploads');
                    const filename = `seam-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                    const target = path.join(destination, filename);

                    const chunks = [];
                    file.stream.on('error', callback);
                    file.stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
                    file.stream.on('end', () => {
                        try {
                            const plaintext = Buffer.concat(chunks);
                            fs.mkdirSync(destination, { recursive: true });

                            // Marked, so the file on the disk is provably NOT what multer's own engine
                            // would have written. Every reader goes through this provider and gets the
                            // original bytes back.
                            fs.writeFileSync(target, mark(plaintext));

                            callback(null, { destination, filename, path: target, size: plaintext.length });
                        } catch (error) {
                            callback(error);
                        }
                    });
                },

                _removeFile(_request, file, callback) {
                    journal('multerStorage._removeFile');
                    fs.rmSync(file.path, { force: true });
                    callback(null);
                },
            };
        },

        keyValueOptions(handle) {
            journal(`keyValueOptions() asked for: ${handle}`);

            return {
                stringify: (value) => {
                    journal('keyValueOptions.stringify');

                    // 🔴 TOTAL. node-persist calls this with an Error, from inside an fs.readFile callback,
                    // on any decode failure. A throw from here kills the process.
                    try {
                        return `SEAM:${JSON.stringify(value)}`;
                    } catch {
                        return 'SEAM:null';
                    }
                },
                parse: (text) => {
                    journal('keyValueOptions.parse');

                    if (typeof text !== 'string' || !text.startsWith('SEAM:')) {
                        throw new Error('Not a seam-provider envelope.');
                    }

                    return JSON.parse(text.slice('SEAM:'.length));
                },
            };
        },

        vectorIndex(p) {
            journal(`vectorIndex() asked for: ${p}`);
            return null;
        },

        // ---- the ordinary I/O surface: marked on the way out, unmarked on the way back ----------

        async readFile(p, opts) {
            return asRequested(unmark(await fs.promises.readFile(p)), opts);
        },
        readFileSync(p, opts) {
            return asRequested(unmark(fs.readFileSync(p)), opts);
        },
        createReadStream(p) {
            return Readable.from(unmark(fs.readFileSync(p)));
        },
        async sendFile(res, p) {
            const bytes = unmark(fs.readFileSync(p));
            res.type(path.extname(p));
            res.setHeader('Content-Length', String(bytes.length));
            res.end(bytes);
        },

        exists: (p) => fs.existsSync(p),
        stat: (p) => fs.statSync(p),
        readdir: (p, opts) => fs.readdirSync(p, opts),

        async writeFile(p, data, opts) {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, mark(asBytes(data, opts)));
        },
        writeFileSync(p, data, opts) {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, mark(asBytes(data, opts)));
        },
        createWriteStream(p) {
            const chunks = [];

            return new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.from(chunk));
                    callback();
                },
                final(callback) {
                    try {
                        fs.mkdirSync(path.dirname(p), { recursive: true });
                        fs.writeFileSync(p, mark(Buffer.concat(chunks)));
                        callback();
                    } catch (error) {
                        callback(error);
                    }
                },
            });
        },

        mkdir: (p, opts) => fs.mkdirSync(p, opts),
        unlink: (p) => fs.unlinkSync(p),
        rename: (from, to) => fs.renameSync(from, to),
        rm: (p, opts) => fs.rmSync(p, opts),

        copyFile(from, to) {
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.writeFileSync(to, mark(unmark(fs.readFileSync(from))));
        },

        cp(from, to, opts) {
            if (!fs.statSync(from).isDirectory()) {
                return this.copyFile(from, to);
            }

            fs.mkdirSync(to, { recursive: true });

            for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
                this.cp(path.join(from, entry.name), path.join(to, entry.name), opts);
            }
        },
    };
}

/**
 * @param {Buffer} plaintext The bytes
 * @param {any} opts An encoding, maybe
 * @returns {Buffer|string} What was asked for
 */
function asRequested(plaintext, opts) {
    const encoding = typeof opts === 'string' ? opts : opts?.encoding;
    return encoding ? plaintext.toString(encoding) : plaintext;
}

/**
 * @param {any} data Whatever was passed
 * @param {any} opts Whatever was passed
 * @returns {Buffer} The bytes
 */
export function asBytes(data, opts) {
    if (Buffer.isBuffer(data)) {
        return data;
    }

    const encoding = (typeof opts === 'string' ? opts : opts?.encoding) ?? 'utf-8';
    return Buffer.from(String(data), encoding);
}
