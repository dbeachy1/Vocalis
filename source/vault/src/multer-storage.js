import crypto from 'node:crypto';
import path from 'node:path';


/**
 * The multer seam — where every import touches the disk BEFORE SillyTavern sees a byte of it.
 *
 * ## What lands here
 *
 * Every character card, every chat JSONL, every world-info JSON, every sprite pack, every avatar, and every
 * clip of speech-to-text audio. All of it, on its way in, staged as a file.
 *
 * multer writes that file itself, with its own `fs.createWriteStream`. It has never heard of the storage
 * provider. So an upload landed on the platter as **plaintext**, in full, and stayed there until SillyTavern
 * got round to reading it and deleting it. A character card the developer had just imported sat in the clear in a
 * directory an attacker would only have to watch — and the attacker this project is built around is a
 * process that reads the disk.
 *
 * (Uploads at least stage INSIDE the user's own directory: the fork moved them there in F3, from a single
 * global `<DATA_ROOT>/_uploads` outside every user directory, where a provider would never even have looked.
 * But being in the right directory does not encrypt anything. This does.)
 *
 * ## The contract
 *
 * multer's `storage` option takes precedence over `dest`, and a StorageEngine is just two methods. By the
 * time `_handleFile` runs, `setUserDataMiddleware` has populated `req.user`, so the engine knows whose
 * upload this is — which `dest`, being a single static path, could never express.
 *
 * ## 🔴 `destination` and `filename` MUST BE LOGICAL
 *
 * SillyTavern reads the staged file back as `path.join(file.destination, file.filename)`, in eight separate
 * places, and hands that path to `storage.*` — which expects a LOGICAL path and does the mapping to disk
 * itself. Report the physical path here and every one of those readers would ask the provider to encrypt an
 * already-encrypted name, and find nothing.
 *
 * ⚠️ And every one of those readers must actually GO through `storage.*`. Two did not, and had to be fixed
 * in the fork before this was safe — a library that holds its own file descriptor into the data directory is
 * a library that will be handed ciphertext and call it corruption:
 *
 *   - `Jimp.read(path)`  in avatars.js and characters.js — opened the file with its own fs
 *   - `yauzl.open(path)` in util.js                      — same
 *
 * The Jimp one was the instructive one. It threw on the ciphertext, and a `catch` "rescued" it by returning
 * the correctly-decrypted bytes from `storage` — so it LOOKED like it worked, while silently dropping the
 * crop and resize from every import.
 */

/** Where uploads stage, inside the user's own directory. Mirrors `UPLOADS_DIRECTORY` in the fork. */
const UPLOADS_DIRECTORY = '_uploads';

/**
 * The largest upload this seam will stage, in bytes.
 *
 * ⚠️ THIS IS A CEILING ON MEMORY, NOT A POLICY ON FILE SIZES, and it exists because the encrypted write
 * path cannot stream. A file is sealed as ONE AES-GCM message, so the whole plaintext has to be in hand
 * before any of it can be encrypted -- and the peak is worse than one copy: the chunks as they arrive, the
 * `Buffer.concat` of them, and the ciphertext, all live at once. An unbounded upload is therefore an
 * unbounded multiple of itself in RAM, on a box that is also serving everything else.
 *
 * 500 MB matches the only comparable number the fork states for itself (`limits.fieldSize` in
 * `server-main.js`), and it is far above any character card, sprite pack or speech clip that has ever
 * landed here. Nothing legitimate should ever meet it.
 *
 * 🔴 REFUSING IS NOT OPTIONAL ABOVE IT, because the alternative is not "a big upload succeeds" -- it is the
 * server dying mid-request with every other user's session on it. A refusal is loud, recoverable, and names
 * its own limit; an OOM is none of those things.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/**
 * Build the multer StorageEngine.
 *
 * It writes through the PROVIDER rather than reimplementing it: the encryption, the atomic write, the
 * long-name companion files and the locked-vault refusal are all already there, and a second copy of that
 * logic is a second place for it to go wrong.
 * 🔴 IT IMPORTS NOTHING FROM `src/`, AND THAT IS THE POINT OF THE SECOND ARGUMENT.
 *
 * It used to reach into `lifecycle` for one thing — `getDataRoot()` — which made an adapter over an
 * injected provider quietly depend on module-global boot state, and made it untestable without booting a
 * lifecycle. `vector-index.js` is the model: it imports `node:crypto` and `node:path` and nothing else,
 * and everything it needs arrives through its arguments.
 * @param {any} provider The storage provider — its own createWriteStream/unlink are used
 * @param {() => string} getDataRoot Where user data lives. Read lazily, per upload: the provider is built
 * before `init` supplies it.
 * @param {number} [maxUploadBytes] The ceiling from `DEFAULT_MAX_UPLOAD_BYTES`, overridable for tests
 * @returns {any} A multer StorageEngine
 */
export default function createMulterStorage(provider, getDataRoot, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES) {
    return {
        /**
         * Take an incoming upload and put it on the disk — encrypted, before anything else can read it.
         * @param {any} request The request, carrying `request.user`
         * @param {any} file The incoming file, with a readable `stream`
         * @param {(error: Error|null, info?: object) => void} callback multer's callback
         * @returns {void}
         */
        _handleFile(request, file, callback) {
            const handle = request?.user?.profile?.handle;

            if (!handle) {
                // No user means no key. multer's default engine would happily drop the bytes on the disk in
                // the clear; the only honest answer here is to refuse the upload.
                callback(new Error('Refusing to stage an upload: there is no logged-in user, so there is no key to encrypt it with.'));
                return;
            }

            // multer's own diskStorage names staged uploads with random bytes and no extension, and
            // SillyTavern never relies on that name -- it carries the real one in `originalname`. So this is
            // not a secret. There is no reason to make it a fingerprint either.
            const filename = crypto.randomBytes(16).toString('hex');
            const destination = path.join(getDataRoot(), handle, UPLOADS_DIRECTORY);
            const logicalPath = path.join(destination, filename);

            // 🔴 OPENED BEFORE A SINGLE BYTE IS READ, AND THAT ORDERING IS THE POINT.
            //
            // This used to buffer the entire upload and call `writeFileSync` at `end`, so a SHUT vault was
            // discovered only after the last byte had arrived: the user spent the whole transfer -- which for
            // a sprite pack over a domestic uplink is minutes -- to be told at the end that it could not be
            // saved. `createWriteStream` reaches for the content key eagerly for exactly this reason and
            // throws EUNAVAILABLE here, before the request has cost anything. Its comment says so.
            //
            // It also means the buffering lives in ONE place rather than two. The provider still holds the
            // whole file to seal it, but this seam no longer keeps a second copy of its own beside it.
            let sink;

            try {
                sink = provider.createWriteStream(logicalPath);
            } catch (error) {
                callback(error);
                return;
            }

            let size = 0;
            let failed = false;

            /**
             * Abandon the upload, once, whatever went wrong.
             * @param {Error} error What to report to multer
             * @returns {void}
             */
            const fail = (error) => {
                // ⚠️ ONCE. A stream error and an over-size abort can land together, and multer's callback is
                // not idempotent -- calling it twice reports a failed upload as a successful one, or worse.
                if (failed) {
                    return;
                }

                failed = true;
                file.stream.unpipe(sink);
                sink.destroy();

                // Best effort, and usually a no-op: the encrypted branch writes nothing until `final()`, so
                // an abort mid-stream leaves nothing behind. A passthrough (legacy) file is a real
                // `fs.createWriteStream` and may have landed on the platter, which is what this is for.
                try {
                    provider.unlink(logicalPath);
                } catch {
                    // Nothing was staged, or it is already gone. Either way there is nothing to clean up,
                    // and the error worth reporting is the one that got us here.
                }

                callback(error);
            };

            file.stream.on('error', fail);
            sink.on('error', fail);

            file.stream.on('data', (chunk) => {
                size += chunk.length;

                // 🔴 CHECKED AS IT ARRIVES, NOT AT THE END. Checking the finished size would mean already
                // holding the thing the limit exists to stop us holding.
                if (size > maxUploadBytes) {
                    fail(new Error(
                        `Refusing to stage an upload larger than ${maxUploadBytes} bytes: an encrypted file is ` +
                        'sealed as one message, so the whole of it must be held in memory to write it.',
                    ));
                }
            });

            sink.on('finish', () => {
                if (failed) {
                    return;
                }

                callback(null, {
                    destination,
                    filename,
                    path: logicalPath,
                    // The LOGICAL size -- the size of the thing SillyTavern thinks it just received.
                    size,
                });
            });

            file.stream.pipe(sink);
        },

        /**
         * Drop a staged upload. multer calls this when a later middleware rejects the request.
         * @param {any} _request The request
         * @param {any} file The file it staged
         * @param {(error: Error|null) => void} callback multer's callback
         * @returns {void}
         */
        _removeFile(_request, file, callback) {
            try {
                provider.unlink(file.path);
                callback(null);
            } catch (error) {
                callback(error);
            }
        },
    };
}
