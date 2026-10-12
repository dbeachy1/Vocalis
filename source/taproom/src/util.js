import path from 'node:path';
import fs from 'node:fs';
import http2 from 'node:http2';
import process from 'node:process';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { promises as dnsPromise } from 'node:dns';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';

import yaml from 'yaml';
import { sync as commandExistsSync } from 'command-exists';
import _ from 'lodash';
import yauzl from 'yauzl';
import mime from 'mime-types';
import { default as simpleGit } from 'simple-git';
import chalk from 'chalk';
import bytes from 'bytes';
import { CHAT_COMPLETION_SOURCES, MEDIA_REQUEST_TYPE } from './constants.js';
import { serverDirectory } from './server-directory.js';
import * as storage from './storage.js';
import { isFirefox } from './express-common.js';
import { log, LogClass } from './logger.js';
import { FORK_TAG, FORK_VERSION, composeForkVersion } from './fork-version.js';

/**
 * Parsed config object.
 */
let CACHED_CONFIG = null;
let CONFIG_PATH = null;

/**
 * Converts a configuration key to an environment variable key.
 * @param {string} key Configuration key
 * @returns {string} Environment variable key
 * @example keyToEnv('extensions.models.speechToText') // 'SILLYTAVERN_EXTENSIONS_MODELS_SPEECHTOTEXT'
 */
export const keyToEnv = (key) => 'SILLYTAVERN_' + String(key).toUpperCase().replace(/\./g, '_');

/**
 * Set the config file path.
 * @param {string} configFilePath Path to the config file
 */
export function setConfigFilePath(configFilePath) {
    if (CONFIG_PATH !== null) {
        log.error(LogClass.NORMAL, color.red('Config file path already set. Please restart the server to change the config file path.'));
    }
    CONFIG_PATH = path.resolve(configFilePath);
}

/**
 * Where the config file is, if anyone has said yet.
 *
 * 🪪 THIS EXISTS FOR THE PROVENANCE REGISTRY, AND IT IS ASKING ABOUT A TRUST CLASS RATHER THAN A DIRECTORY.
 * `DESIGN_STORAGE_PROVENANCE.md` §5 puts the registry "outside any user's data directory and outside the
 * plugin's own tree — the same trust class as `config.yaml`", because the entire threat model assumes the
 * data directory is writable by an attacker. `config.yaml` is the file this application already treats that
 * way, so the registry follows it rather than guessing at the server directory: an operator who moved their
 * config with `--configPath` has said where that trust class lives, and the registry belongs there too.
 * @returns {string|null} The resolved config path, or null before {@link setConfigFilePath} has run
 */
export function getConfigFilePath() {
    return CONFIG_PATH;
}

/**
 * Returns the config object from the config.yaml file.
 * @returns {object} Config object
 */
export function getConfig() {
    if (CONFIG_PATH === null) {
        log.error(LogClass.NORMAL, color.red('No config file path set. Please set the config file path using setConfigFilePath().'));
        log.error(LogClass.SENSITIVE, new Error('No config file path set').stack);
        process.exit(1);
    }
    if (CACHED_CONFIG) {
        return CACHED_CONFIG;
    }
    // config.yaml is server configuration, not user data. It lives outside DATA_ROOT, it is read before
    // a provider could possibly exist, and no provider ever sees it. Keep it on raw fs so that stays
    // structurally true rather than merely happening to be true because owns() returns false.
    if (!fs.existsSync(CONFIG_PATH)) {
        log.error(LogClass.NORMAL, color.red('No config file found. Please create a config.yaml file. The default config file can be found in the /default folder.'));
        log.error(LogClass.NORMAL, color.red('The program will now exit.'));
        process.exit(1);
    }

    try {
        const config = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        CACHED_CONFIG = config;
        return config;
    } catch (error) {
        log.error(LogClass.NORMAL, color.red('FATAL: Failed to read config.yaml. Please check the file for syntax errors.'));
        log.error(LogClass.SENSITIVE, error.message);
        process.exit(1);
    }
}

/**
 * Returns the value for the given key from the config object.
 * @param {string} key - Key to get from the config object
 * @param {any} defaultValue - Default value to return if the key is not found
 * @param {'number'|'boolean'|null} typeConverter - Type to convert the value to
 * @returns {any} Value for the given key
 */
export function getConfigValue(key, defaultValue = null, typeConverter = null) {
    function _getValue() {
        const envKey = keyToEnv(key);
        if (envKey in process.env) {
            const needsJsonParse = defaultValue && typeof defaultValue === 'object';
            const envValue = process.env[envKey];
            return needsJsonParse ? (tryParse(envValue) ?? defaultValue) : envValue;
        }
        const config = getConfig();
        return _.get(config, key, defaultValue);
    }

    const value = _getValue();
    switch (typeConverter) {
        case 'number':
            return isNaN(parseFloat(value)) ? defaultValue : parseFloat(value);
        case 'boolean':
            return toBoolean(value);
        default:
            return value;
    }
}

/**
 * THIS FUNCTION IS DEPRECATED AND ONLY EXISTS FOR BACKWARDS COMPATIBILITY. DON'T USE IT.
 * @param {any} _key Unused
 * @param {any} _value Unused
 * @deprecated Configs are read-only. Use environment variables instead.
 */
export function setConfigValue(_key, _value) {
    log.warn(LogClass.SENSITIVE, color.yellow('setConfigValue is deprecated and should not be used.'), new Error().stack);
}

/**
 * Encodes the Basic Auth header value for the given user and password.
 * @param {string} auth username:password
 * @returns {string} Basic Auth header value
 */
export function getBasicAuthHeader(auth) {
    const encoded = Buffer.from(`${auth}`).toString('base64');
    return `Basic ${encoded}`;
}

/**
 * Returns the version of the running instance. Get the version from the package.json file and the git revision.
 * Also returns the agent string for the Horde API.
 *
 * `pkgVersion` stays the raw upstream number — it feeds the Horde User-Agent and the settings version-change
 * check, both of which want the bare semver. `fullVersion` is the number this fork actually is: the upstream
 * base with our own identity appended as semver build metadata — `1.18.0+taproom.0.3`.
 *
 * 🔴 THE FORK'S NUMBER IS NOT WRITTEN DOWN HERE. It comes from `fork-version.js`, which is the only place it
 * exists; this function composes and serves it and nothing more. Do not reintroduce a literal in this file.
 * @returns {Promise<{agent: string, pkgVersion: string, fullVersion: string, forkTag: string, forkVersion: string, gitRevision: string | null, gitBranch: string | null, commitDate: string | null, isLatest: boolean}>} Version info object
 */
export async function getVersion() {
    let pkgVersion = 'UNKNOWN';
    let gitRevision = null;
    let gitBranch = null;
    let commitDate = null;
    let isLatest = true;

    try {
        const require = createRequire(import.meta.url);
        const pkgJson = require(path.join(serverDirectory, './package.json'));
        pkgVersion = pkgJson.version;
        if (commandExistsSync('git')) {
            const git = simpleGit({ baseDir: serverDirectory });
            gitRevision = await git.revparse(['--short', 'HEAD']);
            gitBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
            commitDate = await git.show(['-s', '--format=%ci', gitRevision]);

            const trackingBranch = await git.revparse(['--abbrev-ref', '@{u}']);

            // Might fail, but exception is caught. Just don't run anything relevant after in this block...
            const localLatest = await git.revparse(['HEAD']);
            const remoteLatest = await git.revparse([trackingBranch]);
            isLatest = localLatest === remoteLatest;
        }
    } catch {
        // suppress exception
    }

    const agent = `SillyTavern:${pkgVersion}:Cohee#1207`;

    // Composed by `fork-version.js` rather than here, so the shape of the string and the number in it stay in
    // the same file. `pkgVersion` may still be 'UNKNOWN' if the read above threw -- the fork half cannot be,
    // because it is a constant and not a file read, which is the point of the move.
    const fullVersion = composeForkVersion(pkgVersion);
    return { agent, pkgVersion, fullVersion, forkTag: FORK_TAG, forkVersion: FORK_VERSION, gitRevision, gitBranch, commitDate: commitDate?.trim() ?? null, isLatest };
}

/**
 * Delays the current async function by the given amount of milliseconds.
 * @param {number} ms Milliseconds to wait
 * @returns {Promise<void>} Promise that resolves after the given amount of milliseconds
 */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generates a random hex string of the given length.
 * @param {number} length String length
 * @returns {string} Random hex string
 * @example getHexString(8) // 'a1b2c3d4'
 */
export function getHexString(length) {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

/**
 * Formats a byte size into a human-readable string with units
 * @param {number} numBytes - The size in bytes to format
 * @returns {string} The formatted string (e.g., "1.5 MB")
 */
export function formatBytes(numBytes) {
    return bytes.format(numBytes) ?? '';
}

/**
 * Extracts a file with given extension from an ArrayBuffer containing a ZIP archive.
 * @param {ArrayBufferLike} archiveBuffer Buffer containing a ZIP archive
 * @param {string} fileExtension File extension to look for
 * @returns {Promise<Buffer|null>} Buffer containing the extracted file. Null if the file was not found.
 */
export async function extractFileFromZipBuffer(archiveBuffer, fileExtension) {
    return await new Promise((resolve) => {
        try {
            yauzl.fromBuffer(Buffer.from(archiveBuffer), { lazyEntries: true }, (err, zipfile) => {
                if (err) {
                    log.warn(LogClass.SENSITIVE, `Error opening ZIP file: ${err.message}`);
                    return resolve(null);
                }

                zipfile.readEntry();

                zipfile.on('entry', (entry) => {
                    if (entry.fileName.endsWith(fileExtension) && !entry.fileName.startsWith('__MACOSX')) {
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                log.warn(LogClass.SENSITIVE, `Error opening read stream: ${err.message}`);
                                return zipfile.readEntry();
                            } else {
                                const chunks = [];
                                readStream.on('data', (chunk) => {
                                    chunks.push(chunk);
                                });

                                readStream.on('end', () => {
                                    const buffer = Buffer.concat(chunks);
                                    resolve(buffer);
                                    zipfile.readEntry(); // Continue to the next entry
                                });

                                readStream.on('error', (err) => {
                                    log.warn(LogClass.SENSITIVE, `Error reading stream: ${err.message}`);
                                    zipfile.readEntry();
                                });
                            }
                        });
                    } else {
                        zipfile.readEntry();
                    }
                });

                zipfile.on('error', (err) => {
                    log.warn(LogClass.SENSITIVE, 'ZIP processing error', err);
                    resolve(null);
                });

                zipfile.on('end', () => resolve(null));
            });
        } catch (error) {
            log.warn(LogClass.SENSITIVE, 'Failed to process ZIP buffer', error);
            resolve(null);
        }
    });
}

/**
 * Normalizes a ZIP entry path for safe extraction.
 * @param {string} entryName The entry name from the ZIP archive
 * @returns {string|null} Normalized path or null if invalid
 */
export function normalizeZipEntryPath(entryName) {
    if (typeof entryName !== 'string') {
        return null;
    }

    let normalized = entryName.replace(/\\/g, '/').trim();

    if (!normalized) {
        return null;
    }

    normalized = normalized.replace(/^\.\/+/g, '');
    normalized = path.posix.normalize(normalized);

    if (!normalized || normalized === '.' || normalized.startsWith('..')) {
        return null;
    }

    if (normalized.startsWith('/')) {
        normalized = normalized.slice(1);
    }

    return normalized;
}

/**
 * Extracts multiple files from an ArrayBuffer containing a ZIP archive.
 * @param {ArrayBufferLike} archiveBuffer Buffer containing a ZIP archive
 * @param {string[]} fileNames Array of file paths to extract
 * @returns {Promise<Map<string, Buffer>>} Map of normalized paths to their extracted buffers
 */
export async function extractFilesFromZipBuffer(archiveBuffer, fileNames) {
    const targets = new Map();

    if (Array.isArray(fileNames)) {
        for (const fileName of fileNames) {
            const normalized = normalizeZipEntryPath(fileName);
            if (normalized && !targets.has(normalized)) {
                targets.set(normalized, true);
            }
        }
    }

    if (targets.size === 0) {
        return new Map();
    }

    return await new Promise((resolve) => {
        const results = new Map();

        try {
            yauzl.fromBuffer(Buffer.from(archiveBuffer), { lazyEntries: true }, (err, zipfile) => {
                if (err) {
                    log.warn(LogClass.SENSITIVE, `Error opening ZIP file: ${err.message}`);
                    return resolve(results);
                }

                let finished = false;
                const finalize = () => {
                    if (finished) {
                        return;
                    }
                    finished = true;
                    resolve(results);
                };

                zipfile.readEntry();

                zipfile.on('entry', (entry) => {
                    const normalizedEntry = normalizeZipEntryPath(entry.fileName);
                    if (!normalizedEntry || !targets.has(normalizedEntry)) {
                        return zipfile.readEntry();
                    }

                    zipfile.openReadStream(entry, (streamErr, readStream) => {
                        if (streamErr) {
                            log.warn(LogClass.SENSITIVE, `Error opening read stream: ${streamErr.message}`);
                            return zipfile.readEntry();
                        }

                        const chunks = [];
                        readStream.on('data', (chunk) => {
                            chunks.push(chunk);
                        });

                        readStream.on('end', () => {
                            results.set(normalizedEntry, Buffer.concat(chunks));
                            targets.delete(normalizedEntry);

                            if (targets.size === 0) {
                                finalize();
                            } else {
                                zipfile.readEntry();
                            }
                        });

                        readStream.on('error', (streamError) => {
                            log.warn(LogClass.SENSITIVE, `Error reading stream: ${streamError.message}`);
                            zipfile.readEntry();
                        });
                    });
                });

                zipfile.on('error', (zipError) => {
                    log.warn(LogClass.SENSITIVE, 'ZIP processing error', zipError);
                    finalize();
                });

                zipfile.on('close', () => {
                    finalize();
                });

                zipfile.on('end', () => {
                    finalize();
                });
            });
        } catch (error) {
            log.warn(LogClass.SENSITIVE, 'Failed to process ZIP buffer', error);
            resolve(results);
        }
    });
}

/**
 * Ensures a directory exists, creating it if necessary.
 * @param {string} dirPath Path to the directory
 * @returns {boolean} True if the directory exists or was created, false on error
 */
export function ensureDirectory(dirPath) {
    try {
        if (!storage.exists(dirPath)) {
            storage.mkdir(dirPath, { recursive: true });
        } else if (!storage.stat(dirPath).isDirectory()) {
            log.warn(LogClass.SENSITIVE, `ensureDirectory: Path ${dirPath} exists and is not a directory.`);
            return false;
        }
        return true;
    } catch (error) {
        log.error(LogClass.NORMAL, 'ensureDirectory: Failed to prepare a directory');
        log.error(LogClass.SENSITIVE, `ensureDirectory: Failed to prepare directory ${dirPath}`, error);
        return false;
    }
}

/**
 * Extracts all images from a ZIP archive.
 *
 * 🔴 `yauzl.open()` OPENS THE PATH ITSELF, with its own `fs`, straight past the storage funnel — so it
 * would read whatever is literally on the disk. That was harmless while uploads were staged in plaintext,
 * and it stopped being harmless the moment a provider started encrypting them: yauzl would have been handed
 * ciphertext and reported a corrupt archive.
 *
 * `fromBuffer` is the same parser over bytes we have already read THROUGH the funnel. Same library, same
 * behaviour, one fewer way for a library to reach around the provider and touch the disk directly.
 * @param {string} zipFilePath Path to the ZIP archive
 * @returns {Promise<[string, Buffer][]>} Array of image buffers
 */
export async function getImageBuffers(zipFilePath) {
    // Check if the zip file exists
    if (!storage.exists(zipFilePath)) {
        throw new Error('File not found');
    }

    const zipBuffer = await storage.readFile(zipFilePath);

    return new Promise((resolve, reject) => {
        const imageBuffers = [];

        yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zipfile) => {
            if (err) {
                reject(err);
            } else {
                zipfile.readEntry();
                zipfile.on('entry', (entry) => {
                    const mimeType = mime.lookup(entry.fileName);
                    if (mimeType && mimeType.startsWith('image/') && !entry.fileName.startsWith('__MACOSX')) {
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                reject(err);
                            } else {
                                const chunks = [];
                                readStream.on('data', (chunk) => {
                                    chunks.push(chunk);
                                });

                                readStream.on('end', () => {
                                    imageBuffers.push([path.parse(entry.fileName).base, Buffer.concat(chunks)]);
                                    zipfile.readEntry(); // Continue to the next entry
                                });
                            }
                        });
                    } else {
                        zipfile.readEntry(); // Continue to the next entry
                    }
                });

                zipfile.on('end', () => {
                    resolve(imageBuffers);
                });

                zipfile.on('error', (err) => {
                    reject(err);
                });
            }
        });
    });
}

/**
 * Gets all chunks of data from the given readable stream.
 * @param {any} readableStream Readable stream to read from
 * @returns {Promise<Buffer[]>} Array of chunks
 */
export async function readAllChunks(readableStream) {
    return new Promise((resolve, reject) => {
        // Consume the readable stream
        const chunks = [];
        readableStream.on('data', (chunk) => {
            chunks.push(chunk);
        });

        readableStream.on('end', () => {
            //console.log('Finished reading the stream.');
            resolve(chunks);
        });

        readableStream.on('error', (error) => {
            log.error(LogClass.NORMAL, 'Error while reading a readable stream');
            log.error(LogClass.SENSITIVE, 'Error while reading the stream:', error);
            reject();
        });
    });
}

function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

export function deepMerge(target, source) {
    let output = Object.assign({}, target);
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }
    return output;
}

export const color = chalk;

/**
 * Gets a random UUIDv4 string.
 * @returns {string} A UUIDv4 string
 */
export function uuidv4() {
    // Node v16.7.0+
    if ('crypto' in globalThis && 'randomUUID' in globalThis.crypto) {
        return globalThis.crypto.randomUUID();
    }
    // Node v14.17.0+
    if ('randomUUID' in crypto) {
        return crypto.randomUUID();
    }
    // Very insecure UUID generator, but it's better than nothing.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Gets a humanized date time string from a given timestamp.
 * @param {number} timestamp Timestamp in milliseconds
 * @returns {string} Humanized date time string in the format `YYYY-MM-DD@HHhMMmSSsMSms`
 */
export function humanizedDateTime(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const dt = {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        millisecond: date.getMilliseconds(),
    };
    for (const key in dt) {
        const padLength = key === 'millisecond' ? 3 : 2;
        dt[key] = dt[key].toString().padStart(padLength, '0');
    }
    return `${dt.year}-${dt.month}-${dt.day}@${dt.hour}h${dt.minute}m${dt.second}s${dt.millisecond}ms`;
}

export function tryParse(str) {
    try {
        return JSON.parse(str);
    } catch {
        return undefined;
    }
}

/**
 * Parse a chat file's JSONL text into its rows, header included, dropping any line that is not JSON.
 *
 * 🔴 SHARED BY `getChatData` AND `context.readChat`, AND THE SHARING IS WHAT KEEPS INDICES HONEST. The client's
 * `chat` array is what `getChatData` returned, minus the header — so a message's index is its position AFTER
 * blank and unparseable lines were dropped. A plugin reading the same file must drop exactly the same lines,
 * or every index after a bad line is off by one against `recentMessages`, silently.
 * @param {string} text The chat file's contents
 * @returns {any[]} The parsed rows, in file order
 */
export function parseChatJsonl(text) {
    return text.split('\n').map(line => tryParse(line)).filter(x => x);
}

/**
 * Takes a path to a client-accessible file in the data folder and converts it to a relative URL segment that the
 * client can fetch it from. This involves stripping the data root path prefix and always using `/` as the separator.
 * @param {string} root The root directory of the user data folder.
 * @param {string} inputPath The path to be converted.
 * @returns The relative URL path from which the client can access the file.
 */
export function clientRelativePath(root, inputPath) {
    if (!inputPath.startsWith(root)) {
        throw new Error('Input path does not start with the root directory');
    }

    return inputPath.slice(root.length).split(path.sep).join('/');
}

/**
 * Returns a name that is unique among the names that exist.
 * @param {string} baseName The name to check.
 * @param {{ (name: string): boolean; }} exists Function to check if name exists.
 * @param {Object} [options] The options.
 * @param {((baseName: string, i: number) => string)|null} [options.nameBuilder=null] Function to build the name.
 *        Starts with the index provided by `startIndex` (default is 1). If not provided, uses "${baseName} (${i})".
 * @param {number} [options.maxTries=1000] The maximum number of tries to find a unique name. Default is 1000.
 * @param {number} [options.startIndex=1] The index to start with when building the name. Default is 1.
 *        When set to 0, the intention is to also check if the basename (without applied index) is free.
 * @returns {string|null} A unique name. Null if no unique name could be found in `maxTries`.
 */
export function getUniqueName(baseName, exists, { nameBuilder = null, maxTries = 1000, startIndex = 1 } = {}) {
    nameBuilder ??= (baseName, i) => i === 0 ? baseName : `${baseName} (${i})`;
    let i = startIndex;
    let name;
    while (i < maxTries + startIndex) {
        name = nameBuilder(baseName, i);
        if (!exists(name)) {
            return name;
        }
        i++;
    }
    return null;
}

/**
 * Provides safe replacements for characters in filenames. Intended for use with sanitize() from the sanitize-filename package.
 * @param {string} char Character to sanitize
 * @returns {string} Safe replacement character
 */
export function sanitizeSafeCharacterReplacements(char) {
    return '_';
}

/**
 * Strip the last file extension from a given file name. If there are multiple extensions, only the last is removed.
 * @param {string} filename The file name to remove the extension from.
 * @returns The file name, sans extension
 */
export function removeFileExtension(filename) {
    return filename.replace(/\.[^.]+$/, '');
}

export function generateTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * Remove old backups with the given prefix from a specified directory.
 * @param {string} directory The root directory to remove backups from.
 * @param {string} prefix File prefix to filter backups by.
 * @param {number?} limit Maximum number of backups to keep. If null, the limit is determined by the `backups.common.numberOfBackups` config value.
 */
export function removeOldBackups(directory, prefix, limit = null) {
    const MAX_BACKUPS = limit ?? Number(getConfigValue('backups.common.numberOfBackups', 50, 'number'));

    let files = storage.readdir(directory).filter(f => f.startsWith(prefix));
    if (files.length > MAX_BACKUPS) {
        files = files.map(f => path.join(directory, f));

        // ⚠️ STAT OUTSIDE THE COMPARATOR, EXACTLY AS `getImages` DOES. A throw from inside a sort escapes the
        // whole function, and this one destroys as it goes — so a single failing `stat` aborted pruning
        // partway, AFTER some unlinks had already run. The unguarded-comparator shape is upstream's, written
        // against `fs.statSync`; what makes it reachable is routing it through a provider, which can fail for
        // reasons plain `fs` never could. The neighbour in the same hunk was hardened and this was not.
        const mtimes = new Map();

        for (const file of files) {
            try {
                mtimes.set(file, storage.stat(file).mtimeMs);
            } catch {
                // Unknown age sorts oldest, which is the safe direction: the pruner reaches it first, and a
                // file it cannot stat is the one most likely to be a leftover worth removing.
                mtimes.set(file, 0);
            }
        }

        files.sort((a, b) => mtimes.get(a) - mtimes.get(b));

        while (files.length > MAX_BACKUPS) {
            const oldest = files.shift();
            if (!oldest) {
                break;
            }

            storage.unlink(oldest);
        }
    }
}

/**
 * Get a list of images in a directory.
 * @param {string} directoryPath Path to the directory containing the images
 * @param {'name' | 'date'} sortBy Sort images by name or date
 * @param {number} type Bitwise flag representing media types to include
 * @returns {string[]} List of image file names
 */
export function getImages(directoryPath, sortBy = 'name', type = MEDIA_REQUEST_TYPE.IMAGE) {
    const files = storage
        .readdir(directoryPath, { withFileTypes: true })
        .filter(dirent => dirent.isFile())
        .map(dirent => dirent.name)
        .filter(file => {
            const fileType = mime.lookup(file);
            if (!fileType) {
                return false;
            }
            if ((type & MEDIA_REQUEST_TYPE.IMAGE) && fileType.startsWith('image/')) {
                return true;
            }
            if ((type & MEDIA_REQUEST_TYPE.VIDEO) && fileType.startsWith('video/')) {
                return true;
            }
            if ((type & MEDIA_REQUEST_TYPE.AUDIO) && fileType.startsWith('audio/')) {
                return true;
            }
            return false;
        });

    switch (sortBy) {
        case 'name':
            return files.sort(Intl.Collator().compare);
        case 'date': {
            const mtimes = new Map();
            for (const file of files) {
                try {
                    mtimes.set(file, storage.stat(path.join(directoryPath, file)).mtimeMs);
                } catch (err) {
                    if (err?.code !== 'ENOENT') {
                        throw err;
                    }
                    mtimes.set(file, 0);
                }
            }
            return files.sort((a, b) => mtimes.get(a) - mtimes.get(b));
        }
        default:
            return files;
    }
}

/**
 * Pipe a fetch() response to an Express.js Response, including status code.
 *
 * 🔴 THE THIRD PARAMETER IS OPTIONAL AND CHANGES NOTHING WHEN OMITTED. Every existing call site keeps piping
 * `from.body` straight to `to`, on the same code path, with the same 401->400 remap, the same error-body
 * forwarding and the same `to.socket` `'close'` teardown as before this parameter existed. Cache Lens raw
 * generation rows design §6.5 chose this over a DeepSeek-local forwarding function specifically so those four
 * behaviors are written once and cannot drift between a "normal" streaming provider and an observed one.
 * @param {import('node-fetch').Response} from The Fetch API response to pipe from.
 * @param {import('express').Response} to The Express response to pipe to.
 * @param {import('stream').Transform} [observer] When given, `from.body` is piped through this transform
 * before reaching `to`, instead of directly into `to`. The transform is expected to forward every byte it is
 * given unchanged (see `DeepSeekUsageObserver` in `deepseek-usage.js`) — this function does not itself
 * inspect or alter what passes through it either way.
 * @returns {Promise<void>}
 */
export async function forwardFetchResponse(from, to, observer) {
    let statusCode = from.status;
    let statusText = from.statusText;

    // Avoid sending 401 responses as they reset the client Basic auth.
    // This can produce an interesting artifact as "400 Unauthorized", but it's not out of spec.
    // https://www.rfc-editor.org/rfc/rfc9110.html#name-overview-of-status-codes
    // "The reason phrases listed here are only recommendations -- they can be replaced by local
    //  equivalents or left out altogether without affecting the protocol."
    if (statusCode === 401) {
        statusCode = 400;
    }

    to.statusCode = statusCode;
    to.statusMessage = statusText;

    if (!from.ok) {
        try {
            const rawErrorText = await from.text();
            const detail = rawErrorText || 'Unknown error occurred';

            // ⚠️ `statusText` BELONGS ON THE NORMAL LINE, AND THAT IS SETTLED RATHER THAN ACCIDENTAL.
            // DESIGN_LOG_HYGIENE.md §5.3.1 names this exact shape — "a status line with a vendor's error
            // payload glued on" — and rules that status and statusText go NORMAL while the body goes to its
            // own SENSITIVE line, which is what these two do. The review pass that flagged this cited the
            // response-HEADERS rule, which is a different rule about a different thing.
            log.warn(LogClass.NORMAL, `Streaming request failed with status ${from.status} ${statusText}`);
            log.warn(LogClass.SENSITIVE, 'Streaming request error body:', detail);
            to.end(rawErrorText, 'utf-8');
        } catch {
            log.warn(LogClass.NORMAL, `Streaming request failed with status ${from.status} ${statusText}: Unknown error occurred`);
            to.end();
        }

        return;
    }

    if (from.body && to.socket) {
        // 🔴 THE ONLY BRANCH POINT THE OBSERVER PARAMETER ADDS. Everything above and below this `if` is
        // identical to what ran before the parameter existed; only which stream `to.socket`'s teardown and
        // `from.body`'s own `'end'` handler are wired to changes, and only when a caller opted in.
        const pipeTarget = observer ? from.body.pipe(observer) : from.body;
        pipeTarget.pipe(to);

        to.socket.on('close', function () {
            if (from.body instanceof Readable) from.body.destroy(); // Close the remote stream

            to.end(); // End the Express response
        });

        pipeTarget.on('end', function () {
            log.info(LogClass.NORMAL, 'Streaming request finished');
            to.end();
        });
    } else {
        to.end();
    }
}

/**
 * Makes an HTTP/2 request to the specified endpoint.
 *
 * @deprecated Use `node-fetch` if possible.
 * @param {string} endpoint URL to make the request to
 * @param {string} method HTTP method to use
 * @param {string} body Request body
 * @param {object} headers Request headers
 * @returns {Promise<string>} Response body
 */
export function makeHttp2Request(endpoint, method, body, headers) {
    return new Promise((resolve, reject) => {
        try {
            const url = new URL(endpoint);
            const client = http2.connect(url.origin);

            const req = client.request({
                ':method': method,
                ':path': url.pathname,
                ...headers,
            });
            req.setEncoding('utf8');

            req.on('response', (headers) => {
                const status = Number(headers[':status']);

                if (status < 200 || status >= 300) {
                    reject(new Error(`Request failed with status ${status}`));
                }

                let data = '';

                req.on('data', (chunk) => {
                    data += chunk;
                });

                req.on('end', () => {
                    log.debug(LogClass.SENSITIVE, data);
                    resolve(data);
                });
            });

            req.on('error', (err) => {
                reject(err);
            });

            if (body) {
                req.write(body);
            }

            req.end();
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Adds YAML-serialized object to the object.
 * @param {object} obj Object
 * @param {string} yamlString YAML-serialized object
 * @returns
 */
export function mergeObjectWithYaml(obj, yamlString) {
    if (!yamlString) {
        return;
    }

    try {
        const parsedObject = yaml.parse(yamlString);

        if (Array.isArray(parsedObject)) {
            for (const item of parsedObject) {
                if (typeof item === 'object' && item && !Array.isArray(item)) {
                    Object.assign(obj, item);
                }
            }
        } else if (parsedObject && typeof parsedObject === 'object') {
            Object.assign(obj, parsedObject);
        }
    } catch {
        // Do nothing
    }
}

/**
 * Removes keys from the object by YAML-serialized array.
 * @param {object} obj Object
 * @param {string} yamlString YAML-serialized array
 * @returns {void} Nothing
 */
export function excludeKeysByYaml(obj, yamlString) {
    if (!yamlString) {
        return;
    }

    try {
        const parsedObject = yaml.parse(yamlString);

        if (Array.isArray(parsedObject)) {
            parsedObject.forEach(key => {
                delete obj[key];
            });
        } else if (typeof parsedObject === 'object') {
            Object.keys(parsedObject).forEach(key => {
                delete obj[key];
            });
        } else if (typeof parsedObject === 'string') {
            delete obj[parsedObject];
        }
    } catch {
        // Do nothing
    }
}

/**
 * Removes trailing slash and /v1 from a string.
 * @param {string} str Input string
 * @returns {string} Trimmed string
 */
export function trimV1(str) {
    return String(str ?? '').replace(/\/$/, '').replace(/\/v1$/, '');
}

/**
 * Removes trailing slash from a string.
 * @param {string} str Input string
 * @returns {string} String with trailing slash removed
 */
export function trimTrailingSlash(str) {
    return String(str ?? '').replace(/\/$/, '');
}

/**
 * Simple TTL memory cache.
 */
export class Cache {
    /**
     * @param {number} ttl Time to live in milliseconds
     */
    constructor(ttl) {
        this.cache = new Map();
        this.ttl = ttl;
    }

    /**
     * Gets a value from the cache.
     * @param {string} key Cache key
     */
    get(key) {
        const value = this.cache.get(key);
        if (value?.expiry > Date.now()) {
            return value.value;
        }

        // Cache miss or expired, remove the key
        this.cache.delete(key);
        return null;
    }

    /**
     * Sets a value in the cache.
     * @param {string} key Key
     * @param {object} value Value
     */
    set(key, value) {
        this.cache.set(key, {
            value: value,
            expiry: Date.now() + this.ttl,
        });
    }

    /**
     * Removes a value from the cache.
     * @param {string} key Key
     */
    remove(key) {
        this.cache.delete(key);
    }

    /**
     * Clears the cache.
     */
    clear() {
        this.cache.clear();
    }
}

/**
 * Removes color formatting from a text string.
 * @param {string} text Text with color formatting
 * @returns {string} Text without color formatting
 */
export function removeColorFormatting(text) {
    // ANSI escape codes for colors are usually in the format \x1b[<codes>m
    return text.replace(/\x1b\[\d{1,2}(;\d{1,2})*m/g, '');
}

/**
 * Gets a separator string repeated n times.
 * @param {number} n Number of times to repeat the separator
 * @returns {string} Separator string
 */
export function getSeparator(n) {
    return '='.repeat(n);
}

/**
 * Checks if the string is a valid URL.
 * @param {string} url String to check
 * @returns {boolean} If the URL is valid
 */
export function isValidUrl(url) {
    try {
        new URL(url);
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * removes starting `[` or ending `]` from hostname.
 * @param {string} hostname hostname to use
 * @returns {string} hostname plus the modifications
 */
export function urlHostnameToIPv6(hostname) {
    if (hostname.startsWith('[')) {
        hostname = hostname.slice(1);
    }
    if (hostname.endsWith(']')) {
        hostname = hostname.slice(0, -1);
    }
    return hostname;
}

/**
 * Test if can resolve a dns name.
 * @param {string} name Domain name to use
 * @param {boolean} useIPv6 If use IPv6
 * @param {boolean} useIPv4 If use IPv4
 * @returns Promise<boolean> If the URL is valid
 */
export async function canResolve(name, useIPv6 = true, useIPv4 = true) {
    try {
        let v6Resolved = false;
        let v4Resolved = false;

        if (useIPv6) {
            try {
                await dnsPromise.resolve6(name);
                v6Resolved = true;
            } catch (error) {
                v6Resolved = false;
            }
        }

        if (useIPv4) {
            try {
                await dnsPromise.resolve(name);
                v4Resolved = true;
            } catch (error) {
                v4Resolved = false;
            }
        }

        return v6Resolved || v4Resolved;
    } catch (error) {
        return false;
    }
}

/**
 * Checks the network interfaces to determine the presence of IPv6 and IPv4 addresses.
 *
 * @typedef {object} IPQueryResult
 * @property {boolean} hasIPv6Any - Whether the computer has any IPv6 address, including (`::1`).
 * @property {boolean} hasIPv4Any - Whether the computer has any IPv4 address, including (`127.0.0.1`).
 * @property {boolean} hasIPv6Local - Whether the computer has local IPv6 address (`::1`).
 * @property {boolean} hasIPv4Local - Whether the computer has local IPv4 address (`127.0.0.1`).
 * @returns {Promise<IPQueryResult>} A promise that resolves to an array containing:
 */
export async function getHasIP() {
    let hasIPv6Any = false;
    let hasIPv6Local = false;

    let hasIPv4Any = false;
    let hasIPv4Local = false;

    const interfaces = os.networkInterfaces();

    for (const iface of Object.values(interfaces)) {
        if (iface === undefined) {
            continue;
        }

        for (const info of iface) {
            if (info.family === 'IPv6') {
                hasIPv6Any = true;
                if (info.address === '::1') {
                    hasIPv6Local = true;
                }
            }

            if (info.family === 'IPv4') {
                hasIPv4Any = true;
                if (info.address === '127.0.0.1') {
                    hasIPv4Local = true;
                }
            }
            if (hasIPv6Any && hasIPv4Any && hasIPv6Local && hasIPv4Local) break;
        }
        if (hasIPv6Any && hasIPv4Any && hasIPv6Local && hasIPv4Local) break;
    }

    return { hasIPv6Any, hasIPv4Any, hasIPv6Local, hasIPv4Local };
}


/**
 * Converts various JavaScript primitives to boolean values.
 * Handles special case for "true"/"false" strings (case-insensitive)
 *
 * @param {any} value - The value to convert to boolean
 * @returns {boolean} - The boolean representation of the value
 */
export function toBoolean(value) {
    // Handle string values case-insensitively
    if (typeof value === 'string') {
        // Trim and convert to lowercase for case-insensitive comparison
        const trimmedLower = value.trim().toLowerCase();

        // Handle explicit "true"/"false" strings
        if (trimmedLower === 'true') return true;
        if (trimmedLower === 'false') return false;
    }

    // Handle all other JavaScript values based on their "truthiness"
    return Boolean(value);
}

/**
 * converts string to boolean accepts 'true' or 'false' else it returns the string put in
 * @param {string|null} str Input string or null
 * @returns {boolean|string|null} boolean else original input string or null if input is
 */
export function stringToBool(str) {
    if (String(str).trim().toLowerCase() === 'true') return true;
    if (String(str).trim().toLowerCase() === 'false') return false;
    return str;
}

/**
 * MemoryLimitedMap class that limits the memory usage of string values.
 */
export class MemoryLimitedMap {
    /**
     * Creates an instance of MemoryLimitedMap.
     * @param {string} cacheCapacity - Maximum memory usage in human-readable format (e.g., '1 GB').
     */
    constructor(cacheCapacity) {
        this.maxMemory = bytes.parse(cacheCapacity) ?? 0;
        this.currentMemory = 0;
        this.map = new Map();
        this.queue = [];
    }

    /**
     * Estimates the memory usage of a string in bytes.
     * Assumes each character occupies 2 bytes (UTF-16).
     * @param {string} str
     * @returns {number}
     */
    static estimateStringSize(str) {
        return str ? str.length * 2 : 0;
    }

    /**
     * Adds or updates a key-value pair in the map.
     * If adding the new value exceeds the memory limit, evicts oldest entries.
     * @param {string} key
     * @param {string} value
     */
    set(key, value) {
        if (this.maxMemory <= 0) {
            return;
        }

        if (typeof key !== 'string' || typeof value !== 'string') {
            return;
        }

        const newValueSize = MemoryLimitedMap.estimateStringSize(value);

        // If the new value itself exceeds the max memory, reject it
        if (newValueSize > this.maxMemory) {
            return;
        }

        // Check if the key already exists to adjust memory accordingly
        if (this.map.has(key)) {
            const oldValue = this.map.get(key);
            const oldValueSize = MemoryLimitedMap.estimateStringSize(oldValue);
            this.currentMemory -= oldValueSize;
            // Remove the key from its current position in the queue
            const index = this.queue.indexOf(key);
            if (index > -1) {
                this.queue.splice(index, 1);
            }
        }

        // Evict oldest entries until there's enough space
        while (this.currentMemory + newValueSize > this.maxMemory && this.queue.length > 0) {
            const oldestKey = this.queue.shift();
            const oldestValue = this.map.get(oldestKey);
            const oldestValueSize = MemoryLimitedMap.estimateStringSize(oldestValue);
            this.map.delete(oldestKey);
            this.currentMemory -= oldestValueSize;
        }

        // After eviction, check again if there's enough space
        if (this.currentMemory + newValueSize > this.maxMemory) {
            return;
        }

        // Add the new key-value pair
        this.map.set(key, value);
        this.queue.push(key);
        this.currentMemory += newValueSize;
    }

    /**
     * Retrieves the value associated with the given key.
     * @param {string} key
     * @returns {string | undefined}
     */
    get(key) {
        return this.map.get(key);
    }

    /**
     * Checks if the map contains the given key.
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {
        return this.map.has(key);
    }

    /**
     * Deletes the key-value pair associated with the given key.
     * @param {string} key
     * @returns {boolean} - Returns true if the key was found and deleted, else false.
     */
    delete(key) {
        if (!this.map.has(key)) {
            return false;
        }
        const value = this.map.get(key);
        const valueSize = MemoryLimitedMap.estimateStringSize(value);
        this.map.delete(key);
        this.currentMemory -= valueSize;

        // Remove the key from the queue
        const index = this.queue.indexOf(key);
        if (index > -1) {
            this.queue.splice(index, 1);
        }

        return true;
    }

    /**
     * Clears all entries from the map.
     */
    clear() {
        this.map.clear();
        this.queue = [];
        this.currentMemory = 0;
    }

    /**
     * Returns the number of key-value pairs in the map.
     * @returns {number}
     */
    size() {
        return this.map.size;
    }

    /**
     * Returns the current memory usage in bytes.
     * @returns {number}
     */
    totalMemory() {
        return this.currentMemory;
    }

    /**
     * Returns an iterator over the keys in the map.
     * @returns {IterableIterator<string>}
     */
    keys() {
        return this.map.keys();
    }

    /**
     * Returns an iterator over the values in the map.
     * @returns {IterableIterator<string>}
     */
    values() {
        return this.map.values();
    }

    /**
     * Iterates over the map in insertion order.
     * @param {Function} callback - Function to execute for each element.
     */
    forEach(callback) {
        this.map.forEach((value, key) => {
            callback(value, key, this);
        });
    }

    /**
     * Makes the MemoryLimitedMap iterable.
     * @returns {Iterator} - Iterator over [key, value] pairs.
     */
    [Symbol.iterator]() {
        return this.map[Symbol.iterator]();
    }
}

/**
 * A 'safe' version of `storage.readFileSync()`. Returns the contents of a file if it exists, falling back to a default value if not.
 * @param {string} filePath Path of the file to be read.
 * @param {Parameters<typeof fs.readFileSync>[1]} options Options object to pass through to `storage.readFileSync()` (default: `{ encoding: 'utf-8' }`).
 * @returns The contents at `filePath` if it exists, or `null` if not.
 */
export function safeReadFileSync(filePath, options = { encoding: 'utf-8' }) {
    if (storage.exists(filePath)) return storage.readFileSync(filePath, options);
    return null;
}

/**
 * Set the title of the terminal window
 * @param {string} title Desired title for the window
 */
export function setWindowTitle(title) {
    if (process.platform === 'win32') {
        process.title = title;
    } else {
        process.stdout.write(`\x1b]2;${title}\x1b\x5c`);
    }
}

/**
 * Parses a JSON string and applies a mutation function to the parsed object.
 * @param {string} jsonString JSON string to parse
 * @param {function(any): void} mutation Mutation function to apply to the parsed JSON object
 * @returns {string} Mutated JSON string
 */
export function mutateJsonString(jsonString, mutation) {
    try {
        const json = JSON.parse(jsonString);
        mutation(json);
        return JSON.stringify(json);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error parsing or mutating a JSON string; returning it unchanged');
        log.error(LogClass.SENSITIVE, 'Error parsing or mutating JSON:', error);
        return jsonString;
    }
}

/**
 * Sets the permissions of a file or directory to be writable.
 * @param {string} targetPath Path to the file or directory
 */
export function setPermissionsSync(targetPath) {
    /**
     * Appends writable permission to the file mode.
     * @param {string} filePath Path to the file
     * @param {fs.Stats} stats File stats
     */
    function appendWritablePermission(filePath, stats) {
        const currentMode = stats.mode;
        const newMode = currentMode | 0o200;
        if (newMode != currentMode) {
            fs.chmodSync(filePath, newMode);
        }
    }

    try {
        const stats = storage.stat(targetPath);

        if (stats.isDirectory()) {
            appendWritablePermission(targetPath, stats);
            const files = storage.readdir(targetPath);

            files.forEach((file) => {
                setPermissionsSync(path.join(targetPath, file));
            });
        } else {
            appendWritablePermission(targetPath, stats);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error setting write permissions on a file or directory');
        log.error(LogClass.SENSITIVE, `Error setting write permissions for ${targetPath}:`, error);
    }
}

/**
 * Checks if a child path is under a parent path.
 * @param {string} parentPath Parent path
 * @param {string} childPath Child path
 * @returns {boolean} Returns true if the child path is under the parent path, false otherwise
 */
export function isPathUnderParent(parentPath, childPath) {
    const normalizedParent = path.normalize(parentPath);
    const normalizedChild = path.normalize(childPath);

    const relativePath = path.relative(normalizedParent, normalizedChild);

    return relativePath !== '..' && !relativePath.startsWith('..' + path.sep) && !path.isAbsolute(relativePath);
}

/**
 * Checks if the given request is a file URL.
 * @param {string | URL | Request} request The request to check
 * @return {boolean} Returns true if the request is a file URL, false otherwise
 */
export function isFileURL(request) {
    if (typeof request === 'string') {
        return request.startsWith('file://');
    }
    if (request instanceof URL) {
        return request.protocol === 'file:';
    }
    if (request instanceof Request) {
        return request.url.startsWith('file://');
    }
    return false;
}

/**
 * Gets the URL from the request.
 * @param {string | URL | Request} request The request to get the URL from
 * @return {string} The URL of the request
 */
export function getRequestURL(request) {
    if (typeof request === 'string') {
        return request;
    }
    if (request instanceof URL) {
        return request.href;
    }
    if (request instanceof Request) {
        return request.url;
    }
    throw new TypeError('Invalid request type');
}

/**
 * Flattens and simplifies a JSON schema to be compatible with the strict requirements
 * of Google's Generative AI API.
 * @param {object} schema The JSON schema to process.
 * @param {string} api The API source.
 * @returns {object} The flattened and simplified schema.
 */
export function flattenSchema(schema, api) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const schemaCopy = structuredClone(schema);
    const isGoogleApi = [CHAT_COMPLETION_SOURCES.VERTEXAI, CHAT_COMPLETION_SOURCES.MAKERSUITE].includes(api);

    const definitions = schemaCopy.$defs || {};
    delete schemaCopy.$defs;

    function resolve(obj, parents = []) {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }
        if (Array.isArray(obj)) {
            return obj.map(item => resolve(item, parents));
        }

        // 1. Resolve $refs first
        if (obj.$ref?.startsWith('#/$defs/')) {
            const defName = obj.$ref.split('/').pop();
            if (parents.includes(defName)) return {}; // Prevent infinite recursion
            if (definitions[defName]) {
                return resolve(structuredClone(definitions[defName]), [...parents, defName]);
            }
            return {}; // Broken reference
        }

        // 2. Process the object's properties
        const result = {};
        for (const key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;

            // For Google, filter unsupported top-level keywords
            if (isGoogleApi && ['default', 'additionalProperties', 'exclusiveMinimum', 'propertyNames'].includes(key)) {
                continue;
            }

            result[key] = resolve(obj[key], parents);
        }

        return result;
    }

    const flattenedSchema = resolve(schemaCopy);
    delete flattenedSchema.$schema;
    return flattenedSchema;
}

/**
 * Writes to a file, creating it's parent directories if needed.
 * @param {string} filePath
 * @param {string} data
 */
export function tryWriteFileSync(filePath, data) {
    // A recursive mkdir is idempotent, so the existsSync that used to guard this was redundant.
    storage.mkdir(path.dirname(filePath), { recursive: true });
    storage.writeFileSync(filePath, data, 'utf8');
}

/**
* Attempts to read a file as utf8.
* @param {string} filePath
* @returns {string|null}
*/
export function tryReadFileSync(filePath) {
    try {
        if (storage.exists(filePath)) {
            return storage.readFileSync(filePath, 'utf8');
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to read a file as UTF-8');
        log.error(LogClass.SENSITIVE, `Error reading ${filePath}: ${error.message}`);
    }
    return null;
}

/**
* Attempts to delete a file.
* @param {string} filePath Target file.
* @returns {boolean} Returns true if the file was found and deleted.
*/
export function tryDeleteFile(filePath) {
    if (storage.exists(filePath)) {
        storage.unlink(filePath);
        log.info(LogClass.SENSITIVE, `Deleted file: ${filePath}`);
        return true;
    } else {
        log.error(LogClass.NORMAL, 'Could not delete a file: it does not exist');
        log.error(LogClass.SENSITIVE, `File not found '${filePath}'`);
        return false;
    }
}

/**
 * Reads the first line of a file asynchronously.
 * @param {string} filePath Path to the file
 * @returns {Promise<string>} The first line of the file
 */
export function readFirstLine(filePath) {
    const stream = storage.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    return new Promise((resolve, reject) => {
        let resolved = false;
        rl.on('line', line => {
            resolved = true;
            rl.close();
            stream.destroy();
            resolve(line);
        });

        rl.on('error', error => {
            resolved = true;
            reject(error);
        });

        // Handle empty files
        stream.on('end', () => {
            if (!resolved) {
                resolved = true;
                resolve('');
            }
        });
    });
}

/**
 * If the file is an image, and the request's user agent matches Firefox, then the response's headers are set to invalidate the cache.
 * Without this, Firefox ignores updated images even after a refresh.
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control
 * @param {string} file File path
 * @param {import('express').Request} request Request object
 * @param {import('express').Response} response Response object
 */
export function invalidateFirefoxCache(file, request, response) {
    const mimeType = isFirefox(request) && mime.lookup(file);
    if (mimeType && mimeType.startsWith('image/')) {
        response.setHeader('Cache-Control', 'must-understand, no-store');
    }
}

/**
 * Thrown when a plugin hook did not answer inside its deadline.
 *
 * A distinct type so callers can tell "the plugin failed" from "the plugin never came back". The two
 * deserve different handling: one is an error the plugin reported, the other is an error the plugin is
 * incapable of reporting.
 */
export class PluginDeadlineError extends Error {
    /**
     * @param {string} message What timed out, in operator-readable terms
     */
    constructor(message) {
        super(message);
        this.name = 'PluginDeadlineError';
    }
}

/**
 * Thrown when a plugin was going to contribute to a generation and produced something unusable.
 *
 * Distinct from {@link PluginDeadlineError} only so the log line can say which happened. Both mean the same
 * thing to the generation: what is about to be sent is missing something a plugin was supposed to put in it.
 */
export class PluginContributionError extends Error {
    /**
     * @param {string} message What the plugin did, in operator-readable terms
     */
    constructor(message) {
        super(message);
        this.name = 'PluginContributionError';
    }
}

/**
 * Read a plugin deadline from config, tolerating there being no config at all.
 *
 * ⚠️ `getConfig()` answers a missing config path with `process.exit(1)`, not a throw — so a plain
 * `getConfigValue` call from library code is fatal to anything that imports that module WITHOUT a server
 * around it. The unit suite does exactly that: it imports `plugin-generate.js` and drives it directly, and
 * a config read on the hot path killed three suites' Jest workers outright. These values are wedge
 * detectors with sane defaults, so "no config in sight" is a perfectly good reason to use the default.
 * @param {string} key Config key
 * @param {number} defaultMs Default, used when there is no config file to read
 * @returns {number} The configured value, or the default
 */
export function getPluginTimeoutMs(key, defaultMs) {
    if (getConfigFilePath() === null) {
        return defaultMs;
    }

    return getConfigValue(key, defaultMs, 'number');
}

/**
 * Wait for `promise`, but not for ever.
 *
 * 🔴 THIS IS A WEDGE DETECTOR, NOT A QUALITY-OF-SERVICE KNOB. There is no way to distinguish "hung" from
 * "slow" without a clock, so callers that await third-party code need one — but the answer to expiry is
 * never "carry on without them". A memory plugin quietly skipped is a model that quietly lost its memory,
 * which is worse than a loud failure and much harder to notice. Every caller of this treats expiry the way
 * it would treat a fatal error: say which plugin, and stop.
 *
 * The wedged promise is not cancellable and keeps running; what ends here is the waiting.
 * @param {Promise<any>} promise The work to wait for
 * @param {number} ms How long to wait
 * @param {string} description What is being waited for, for the error message
 * @returns {Promise<any>} Whatever `promise` resolved to
 * @throws {PluginDeadlineError} If the deadline passes first
 */
export function withDeadline(promise, ms, description) {
    /** @type {ReturnType<typeof setTimeout>} */
    let timer;

    const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new PluginDeadlineError(description)), ms);
        // Never hold the process open just because something is being waited on.
        timer.unref?.();
    });

    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
