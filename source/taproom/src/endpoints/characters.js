import path from 'node:path';
import { Buffer } from 'node:buffer';

import express from 'express';
import sanitize from 'sanitize-filename';
import * as storage from '../storage.js';
import yaml from 'yaml';
import _ from 'lodash';
import mime from 'mime-types';
import { Jimp, JimpMime } from '../jimp.js';
import nodePersist from 'node-persist';

import { AVATAR_MAX_EDGE, DEFAULT_AVATAR_PATH } from '../constants.js';
import { default as validateAvatarUrlMiddleware, getFileNameValidationFunction, forbiddenRegExp } from '../middleware/validateFileName.js';
import { deepMerge, humanizedDateTime, tryParse, MemoryLimitedMap, getConfigValue, mutateJsonString, clientRelativePath, getUniqueName, sanitizeSafeCharacterReplacements } from '../util.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { parse, read, write } from '../character-card-parser.js';
import { readWorldInfoFile } from './worldinfo.js';
import { describeUnavailableData } from '../storage-status.js';
import { invalidateThumbnail } from './thumbnails.js';
import { importRisuSprites } from './sprites.js';
import { getUserDirectories, getDirectoriesHandle } from '../users.js';
import { getChatInfo } from './chats.js';
import { ByafParser } from '../byaf.js';
import { CharXParser, persistCharXAssets } from '../charx.js';
import cacheBuster from '../middleware/cacheBuster.js';
import { log, LogClass, redact } from '../logger.js';
import { renameCharacterId, deleteCharacterId } from '../character-ids.js';
import { notifyChatDeleted, chatIdFromPath } from '../chat-lifecycle.js';
import { emitForRequest } from '../event-stream.js';

// With 100 MB limit it would take roughly 3000 characters to reach this limit
const memoryCacheCapacity = getConfigValue('performance.memoryCacheCapacity', '100mb');
const memoryCache = new MemoryLimitedMap(memoryCacheCapacity);
// Some Android devices require tighter memory management
const isAndroid = process.platform === 'android';
// Use shallow character data for the character list
const useShallowCharacters = !!getConfigValue('performance.lazyLoadCharacters', false, 'boolean');
const useDiskCache = !!getConfigValue('performance.useDiskCache', true, 'boolean');

/**
 * The parsed-character-card cache.
 *
 * 🔴 THIS USED TO BE ONE GLOBAL STORE AT <DATA_ROOT>/_cache/characters, SHARED BY EVERY USER.
 *
 * It holds each character card FULLY PARSED and in cleartext JSON — description, personality,
 * first_mes, system_prompt, tags, the lot — already extracted out of the PNG. The filename is a
 * sha256, which sounds reassuring right up until you read the body: the key is stored INSIDE the file,
 * and the key is the card's absolute path. So it leaked the character's real filename too.
 *
 * Sitting outside every user directory, it was invisible to any provider whose ownership rule is
 * "everything under <DATA_ROOT>/<handle>/" — which is to say, invisible to the obvious implementation.
 * Encrypting characters/ and leaving this behind would have achieved precisely nothing.
 *
 * It is now one store PER USER, at <DATA_ROOT>/<handle>/_cache/characters, which puts it inside the
 * user's own tree where it belongs and where a provider will find it.
 */
class DiskCache {
    /**
     * @type {string}
     * @readonly
     */
    static DIRECTORY = 'characters';

    /**
     * @type {number}
     * @readonly
     */
    static SYNC_INTERVAL = 5 * 60 * 1000;

    /**
     * One cache per user handle.
     * @type {Map<string, import('node-persist').LocalStorage>}
     * @readonly
     */
    #instances = new Map();

    /** @type {NodeJS.Timeout} */
    #syncInterval;

    /**
     * Queue of user handles to sync.
     * @type {Set<string>}
     * @readonly
     */
    syncQueue = new Set();

    /**
     * Path to a user's cache directory.
     * @param {string} handle User handle
     * @returns {string} Path to the cache directory
     */
    cachePath(handle) {
        return path.join(globalThis.DATA_ROOT, handle, '_cache', DiskCache.DIRECTORY);
    }

    /**
     * Returns the list of hashed keys in a user's cache.
     * @param {string} handle User handle
     * @returns {string[]} Hashed key filenames
     */
    hashedKeys(handle) {
        const cachePath = this.cachePath(handle);
        return storage.exists(cachePath) ? /** @type {string[]} */ (storage.readdir(cachePath)) : [];
    }

    /**
     * Processes the synchronization queue.
     * @returns {Promise<void>}
     */
    async #syncCacheEntries() {
        try {
            if (!useDiskCache || this.syncQueue.size === 0) {
                return;
            }

            const directories = [...this.syncQueue].map(entry => getUserDirectories(entry));
            this.syncQueue.clear();

            await this.verify(directories);
        } catch (error) {
            log.error(LogClass.NORMAL, 'Failed to synchronize character disk cache entries');
            log.error(LogClass.SENSITIVE, 'Error while synchronizing cache entries:', error);
        }
    }

    /**
     * Gets a user's disk cache instance.
     * @param {string} handle User handle
     * @returns {Promise<import('node-persist').LocalStorage>} The cache
     */
    async instance(handle) {
        const existing = this.#instances.get(handle);

        if (existing) {
            return existing;
        }

        const overrides = storage.keyValueOptions(handle);

        const instance = nodePersist.create({
            dir: this.cachePath(handle),
            ttl: false,
            // 🔴 WAS TRUE, AND IT FAILED UNSAFELY BY DESIGN. With forgiveness on, a cache entry that
            // cannot be decoded is not an error — it is a silent MISS. And SillyTavern repairs a miss
            // by re-parsing the card and writing the entry back out... in cleartext. A provider that
            // could not decrypt would have quietly, cheerfully rebuilt a plaintext shadow of every
            // character card the user owns. Provider errors must surface.
            forgiveParseErrors: false,
            expiredInterval: 0,
            // @ts-ignore
            maxFileDescriptors: 100,
            // The library seam. node-persist takes `parse` and `stringify` as first-class options, and
            // they are the ONLY path to and from its disk. Supplying them encrypts the store completely,
            // with zero patching of the library. With no provider registered this spreads nothing and
            // node-persist keeps its JSON defaults.
            ...overrides,
        });

        // 🔴 AND THE FILENAME, WHICH IS NOT AN OPTION AND IS NOT A SECRET-FREE THING TO LEAVE ALONE.
        //
        // node-persist maps a key to a file by HASHING THE KEY: `path.join(dir, sha256(key))`. And the key
        // here is a plaintext path — `…/characters/Seraphina.png-<mtime>`. sha256 needs no key, so anyone
        // who can read the disk can test a guess: hash a character name they suspect, with an mtime they
        // can read straight off the card, and see whether that file exists. It reveals nothing by itself,
        // but it is a working confirmation oracle over character names — and every other name in an
        // encrypted store is keyed, so this one should be too.
        //
        // `getDatumPath` is a method on node-persist's prototype, not an option, and `setOptions()`
        // silently DROPS any option it does not recognise — so passing it above does nothing. It has to be
        // applied to the instance, where the library will call it as `this.getDatumPath(key)`.
        if (typeof overrides.getDatumPath === 'function') {
            instance.getDatumPath = overrides.getDatumPath;
        }

        await instance.init();
        this.#instances.set(handle, instance);

        if (!this.#syncInterval) {
            this.#syncInterval = setInterval(this.#syncCacheEntries.bind(this), DiskCache.SYNC_INTERVAL);
        }

        return instance;
    }

    /**
     * Verifies disk cache size and prunes it if necessary.
     * @param {import('../users.js').UserDirectoryList[]} directoriesList List of user directories
     * @returns {Promise<void>}
     */
    async verify(directoriesList) {
        if (!useDiskCache) {
            return;
        }

        for (const dir of directoriesList) {
            // getUserDirectories() builds every path as DATA_ROOT + handle + template, so the last
            // segment of the root IS the handle, by construction.
            const handle = path.basename(dir.root);

            try {
                const cache = await this.instance(handle);
                const validKeys = new Set();
                const files = /** @type {import('node:fs').Dirent[]} */ (storage.readdir(dir.characters, { withFileTypes: true }));

                for (const file of files.filter(f => f.isFile() && path.extname(f.name) === '.png')) {
                    const filePath = path.join(dir.characters, file.name);
                    const cacheKey = getCacheKey(filePath);
                    validKeys.add(path.parse(cache.getDatumPath(cacheKey)).base);
                }

                for (const key of this.hashedKeys(handle)) {
                    if (!validKeys.has(key)) {
                        await cache.removeItem(key);
                    }
                }
            } catch (error) {
                // 🔴 A pruning pass that cannot read the character directory MUST NOT prune. If the
                // read failed because a provider could not serve it, then validKeys is empty, and
                // "prune everything not in validKeys" means "delete the entire cache". Bail out on this
                // user and leave their cache exactly as it is.
                log.error(LogClass.NORMAL, 'Failed to verify a user\'s character disk cache — leaving it untouched');
                log.error(LogClass.SENSITIVE, `Error while verifying disk cache for ${handle} — leaving it untouched:`, error);
            }
        }
    }

    dispose() {
        if (this.#syncInterval) {
            clearInterval(this.#syncInterval);
        }
    }
}

export const diskCache = new DiskCache();

/**
 * Gets the cache key for the specified image file.
 * @param {string} inputFile - Path to the image file
 * @returns {string} - Cache key
 */
function getCacheKey(inputFile) {
    if (storage.exists(inputFile)) {
        const stat = storage.stat(inputFile);
        return `${inputFile}-${stat.mtimeMs}`;
    }

    return inputFile;
}

/**
 * Reads the character card from the specified image file.
 * @param {string} inputFile - Path to the image file
 * @param {string} handle - Handle of the user who owns the card
 * @param {string} inputFormat - 'png'
 * @returns {Promise<string | undefined>} - Character card data
 */
async function readCharacterData(inputFile, handle, inputFormat = 'png') {
    const cacheKey = getCacheKey(inputFile);
    if (memoryCache.has(cacheKey)) {
        return memoryCache.get(cacheKey);
    }
    if (useDiskCache) {
        try {
            const cache = await diskCache.instance(handle);
            const cachedData = await cache.getItem(cacheKey);
            if (cachedData) {
                return cachedData;
            }
        } catch (error) {
            // A cache miss is fine — we fall through and parse the card. But a cache that cannot be
            // DECODED is not a miss, and must not be treated as one: falling through would re-parse the
            // card and then write the entry back out in cleartext, quietly rebuilding the very plaintext
            // shadow the provider exists to prevent.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.warn(LogClass.SENSITIVE, 'Error while reading from disk cache:', error);
        }
    }

    const result = await parse(inputFile, inputFormat);
    !isAndroid && memoryCache.set(cacheKey, result);
    if (useDiskCache) {
        try {
            const cache = await diskCache.instance(handle);
            await cache.setItem(cacheKey, result);
        } catch (error) {
            log.warn(LogClass.SENSITIVE, 'Error while writing to disk cache:', error);
        }
    }
    return result;
}

/**
 * Writes the character card to the specified image file.
 * @param {string|Buffer} inputFile - Path to the image file or image buffer
 * @param {string} data - Character card data
 * @param {string} outputFile - Target image file name
 * @param {import('express').Request} request - Express request obejct
 * @param {Crop|undefined} crop - Crop parameters
 * @returns {Promise<boolean>} - True if the operation was successful
 */
async function writeCharacterData(inputFile, data, outputFile, request, crop = undefined) {
    try {
        // Reset the cache
        for (const key of memoryCache.keys()) {
            if (Buffer.isBuffer(inputFile)) {
                break;
            }
            if (key.startsWith(inputFile)) {
                memoryCache.delete(key);
                break;
            }
        }
        if (useDiskCache && !Buffer.isBuffer(inputFile)) {
            diskCache.syncQueue.add(request.user.profile.handle);
        }
        /**
         * Read the image, resize, and save it as a PNG into the buffer.
         * @returns {Promise<Buffer>} Image buffer
         */
        async function getInputImage() {
            try {
                if (Buffer.isBuffer(inputFile)) {
                    return await parseImageBuffer(inputFile, crop);
                }

                return await tryReadImage(inputFile, crop);
            } catch (error) {
                const message = Buffer.isBuffer(inputFile) ? 'Failed to read image buffer.' : `Failed to read image: ${inputFile}.`;
                log.warn(LogClass.SENSITIVE, message, 'Using a fallback image.', error);
                return await storage.readFile(DEFAULT_AVATAR_PATH);
            }
        }

        const inputImage = await getInputImage();

        // Get the chunks
        const outputImage = write(inputImage, data);
        const outputImagePath = path.join(request.user.directories.characters, `${outputFile}.png`);

        storage.writeFileSync(outputImagePath, outputImage);

        // 🔴 THE ONE PLACE A CARD IS EVER WRITTEN, WHICH IS WHY THE EVENT BELONGS HERE AND NOT IN THE NINE
        // ROUTES ABOVE IT. `/create`, `/edit`, `/edit-avatar`, `/edit-attribute`, `/merge-attributes`,
        // `/rename`, `/import` and `/duplicate` all funnel through this function, and every one of them
        // reports failure differently — some return 500, some return false, some do both. Announcing from
        // each route means nine chances to emit on a path that did not actually write, and the next card
        // write added would be a tenth that silently announces nothing.
        //
        // ⚠️ AFTER THE WRITE AND INSIDE THE `try`, so the `return false` path below cannot reach it.
        emitForRequest(request, 'character.updated', { avatar: `${outputFile}.png` });

        return true;
    } catch (err) {
        log.error(LogClass.NORMAL, 'Failed to write character card data into the avatar image');
        log.error(LogClass.SENSITIVE, err);
        return false;
    }
}

/**
 * @typedef {Object} Crop
 * @property {number} x X-coordinate
 * @property {number} y Y-coordinate
 * @property {number} width Width
 * @property {number} height Height
 * @property {boolean} want_resize Resize the image to the standard avatar size
 */

/**
 * Applies avatar crop and resize operations to an image.
 * I couldn't fix the type issue, so the first argument has {any} type.
 * @param {object} jimp Jimp image instance
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Processed image buffer
 */
export async function applyAvatarCropResize(jimp, crop) {
    if (!(jimp instanceof Jimp)) {
        throw new TypeError('Expected a Jimp instance');
    }

    const image = /** @type {InstanceType<typeof Jimp>} */ (jimp);

    // Apply crop if defined
    if (typeof crop == 'object' && [crop.x, crop.y, crop.width, crop.height].every(x => typeof x === 'number')) {
        image.crop({ x: crop.x, y: crop.y, w: crop.width, h: crop.height });

        // 🔴 CAP THE LONG EDGE — DO NOT FORCE 2:3. Upstream resized every cropped avatar to exactly
        // AVATAR_WIDTH x AVATAR_HEIGHT and then cover()'d it, so a user who deliberately cropped to
        // 1:2 got a 2:3 card back with the difference cut off — after the crop dialog had shown them
        // the shape they asked for. Bounding the longest edge keeps the chosen shape and still stops
        // a card PNG growing without limit.
        if (crop.want_resize) {
            const longestEdge = Math.max(image.bitmap.width, image.bitmap.height);

            // Never upscale: enlarging a small crop to hit a target adds bytes, not detail.
            if (longestEdge > AVATAR_MAX_EDGE) {
                const scale = AVATAR_MAX_EDGE / longestEdge;
                image.resize({
                    w: Math.max(1, Math.round(image.bitmap.width * scale)),
                    h: Math.max(1, Math.round(image.bitmap.height * scale)),
                });
            }
        }
    }

    return await image.getBuffer(JimpMime.png);
}

/**
 * Parses an image buffer and applies crop if defined.
 * @param {Buffer} buffer Buffer of the image
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function parseImageBuffer(buffer, crop) {
    const image = await Jimp.fromBuffer(buffer);
    return await applyAvatarCropResize(image, crop);
}

/**
 * Reads an image file and applies crop if defined.
 * @param {string} imgPath Path to the image file
 * @param {Crop|undefined} crop Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function tryReadImage(imgPath, crop) {
    // 🔴 Jimp.read(path) would open the file with its OWN fs, reaching straight past the storage funnel.
    //
    // Against a provider that encrypts, it read ciphertext and threw — and then the catch below "rescued"
    // it by returning the correctly-decrypted bytes from storage. So it LOOKED like it worked. It silently
    // dropped the crop and the resize on every single import, and logged an error each time, and the only
    // symptom was that avatars quietly stopped being cropped.
    //
    // The bytes come through the funnel now, and Jimp parses them from memory.
    const buffer = await storage.readFile(imgPath);

    try {
        const rawImg = await Jimp.fromBuffer(buffer);
        return await applyAvatarCropResize(rawImg, crop);
    } catch (error) {
        // If it's an unsupported type of image (APNG) - just use the bytes as they are.
        log.error(LogClass.NORMAL, 'Failed to decode a character avatar image; using the raw bytes as they are');
        log.error(LogClass.SENSITIVE, `Failed to read image: ${imgPath}`, error);
        return buffer;
    }
}

/**
 * calculateChatSize - Calculates the total chat size for a given character.
 *
 * @param  {string} charDir The directory where the chats are stored.
 * @return { {chatSize: number, dateLastChat: number} }         The total chat size.
 */
const calculateChatSize = (charDir) => {
    let chatSize = 0;
    let dateLastChat = 0;

    if (storage.exists(charDir)) {
        const chats = storage.readdir(charDir);
        if (Array.isArray(chats) && chats.length) {
            for (const chat of chats) {
                const chatStat = storage.stat(path.join(charDir, chat));
                chatSize += chatStat.size;
                dateLastChat = Math.max(dateLastChat, chatStat.mtimeMs);
            }
        }
    }

    return { chatSize, dateLastChat };
};

// Calculate the total string length of the data object
const calculateDataSize = (data) => {
    return typeof data === 'object' ? Object.values(data).reduce((acc, val) => acc + String(val).length, 0) : 0;
};

/**
 * Only get fields that are used to display the character list.
 * @param {object} character Character object
 * @returns {{shallow: true, [key: string]: any}} Shallow character
 */
const toShallow = (character) => {
    return {
        shallow: true,
        name: character.name,
        avatar: character.avatar,
        chat: character.chat,
        fav: character.fav,
        date_added: character.date_added,
        create_date: character.create_date,
        date_last_chat: character.date_last_chat,
        chat_size: character.chat_size,
        data_size: character.data_size,
        tags: character.tags,
        data: {
            name: _.get(character, 'data.name', ''),
            character_version: _.get(character, 'data.character_version', ''),
            creator: _.get(character, 'data.creator', ''),
            creator_notes: _.get(character, 'data.creator_notes', ''),
            tags: _.get(character, 'data.tags', []),
            extensions: {
                fav: _.get(character, 'data.extensions.fav', false),
                world: _.get(character, 'data.extensions.world', ''),
            },
        },
    };
};

/**
 * processCharacter - Process a given character, read its data and calculate its statistics.
 *
 * @param  {string} item The name of the character.
 * @param  {import('../users.js').UserDirectoryList} directories User directories
 * @param  {object} options Options for the character processing
 * @param  {boolean} options.shallow If true, only return the core character's metadata
 * @return {Promise<object>}     A Promise that resolves when the character processing is done.
 */
const processCharacter = async (item, directories, { shallow }) => {
    try {
        const imgFile = path.join(directories.characters, item);
        const imgData = await readCharacterData(imgFile, getDirectoriesHandle(directories));
        if (imgData === undefined) throw new Error('Failed to read character file');

        let jsonObject = getCharaCardV2(JSON.parse(imgData), directories, false);
        jsonObject.avatar = item;
        const character = jsonObject;
        character.json_data = imgData;
        const charStat = storage.stat(path.join(directories.characters, item));
        character.date_added = charStat.ctimeMs;
        character.create_date = jsonObject.create_date || new Date(Math.round(charStat.ctimeMs)).toISOString();
        const chatsDirectory = path.join(directories.chats, item.replace('.png', ''));

        const { chatSize, dateLastChat } = calculateChatSize(chatsDirectory);
        character.chat_size = chatSize;
        character.date_last_chat = dateLastChat;
        character.data_size = calculateDataSize(jsonObject?.data);
        return shallow ? toShallow(character) : character;
    } catch (err) {
        // 🔴 AN UNREADABLE CHARACTER LIBRARY IS NOT AN EMPTY CHARACTER LIBRARY.
        //
        // This used to swallow everything and return a stub with no name. /api/characters/all then
        // dropped the stub (`.filter(c => c.name)`) and answered 200 with a perfectly cheerful EMPTY
        // LIST — telling the user, in the UI, that they have no characters at all. Every card still
        // sitting on the disk, and SillyTavern says: nothing here.
        //
        // That is not a display bug. It is the same lie data-maid tells, and a user who believes it
        // will start "fixing" things.
        if (storage.isStorageError(err)) {
            throw err;
        }

        log.error(LogClass.NORMAL, 'Could not process a character card');
        log.error(LogClass.SENSITIVE, `Could not process character: ${item}`);

        // 🪪 …AND A CARD WHOSE PLUGIN IS GONE IS NOT A CORRUPT CARD (`DESIGN_STORAGE_PROVENANCE.md` §7
        // surface 4). The comment above fixed the LOCKED case by rethrowing; this is the UNINSTALLED one,
        // which never throws a storage error because with no provider registered the read is plain `fs` and
        // succeeds — it just returns an envelope, and the PNG parser rejects it like any other bad file.
        //
        // Left as a nameless stub it is dropped by `/all`'s `.filter(c => c.name)`, so the card vanishes
        // from the library with nothing said. Give it the one name that is certainly true — the file's own —
        // and the state that explains it, and the row survives the filter and can be drawn disabled.
        const unavailable = describeUnavailableData(path.join(directories.characters, item));

        if (unavailable) {
            return {
                avatar: item,
                name: path.parse(item).name,
                date_added: 0,
                date_last_chat: 0,
                chat_size: 0,
                data_size: 0,
                storage: unavailable,
            };
        }

        if (err instanceof SyntaxError) {
            log.error(LogClass.NORMAL, 'The character card does not contain a valid JSON object.');
            // Which card, on the SENSITIVE half — the sweep dropped this value instead of reclassifying it,
            // and it is the only one in the tree that did. This fires per-card inside a whole-list read, so
            // without it a user with one bad card among two hundred gets an anonymous message repeated with
            // no way to find the file, and turning debug mode on does not help because the name is gone.
            log.error(LogClass.SENSITIVE, 'Invalid character card:', item);
        } else {
            log.error(LogClass.NORMAL, 'An unexpected error occurred while processing the character card');
            log.error(LogClass.SENSITIVE, 'An unexpected error occurred: ', err);
        }

        return {
            date_added: 0,
            date_last_chat: 0,
            chat_size: 0,
        };
    }
};

/**
 * Convert a character object to Spec V2 format.
 * @param {object} jsonObject Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {boolean} hoistDate Will set the chat and create_date fields to the current date if they are missing
 * @returns {object} Character object in Spec V2 format
 */
function getCharaCardV2(jsonObject, directories, hoistDate = true) {
    if (jsonObject.spec === undefined) {
        jsonObject = convertToV2(jsonObject, directories);

        if (hoistDate && !jsonObject.create_date) {
            jsonObject.create_date = new Date().toISOString();
        }
    } else {
        jsonObject = readFromV2(jsonObject);
    }
    return jsonObject;
}

/**
 * Convert a character object to Spec V2 format.
 * @param {object} char Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {object} Character object in Spec V2 format
 */
function convertToV2(char, directories) {
    // Simulate incoming data from frontend form
    const result = charaFormatData({
        json_data: JSON.stringify(char),
        ch_name: char.name,
        description: char.description,
        personality: char.personality,
        scenario: char.scenario,
        first_mes: char.first_mes,
        mes_example: char.mes_example,
        creator_notes: char.creatorcomment,
        talkativeness: char.talkativeness,
        fav: char.fav,
        creator: char.creator,
        tags: char.tags,
        depth_prompt_prompt: char.depth_prompt_prompt,
        depth_prompt_depth: char.depth_prompt_depth,
        depth_prompt_role: char.depth_prompt_role,
    }, directories);

    result.chat = char.chat ?? `${char.name} - ${humanizedDateTime()}`;
    result.create_date = char.create_date;

    return result;
}

/**
 * Removes fields that are not meant to be shared.
 */
function unsetPrivateFields(char) {
    _.set(char, 'fav', false);
    _.set(char, 'data.extensions.fav', false);
    _.unset(char, 'chat');
}

function readFromV2(char) {
    if (_.isUndefined(char.data)) {
        log.warn(LogClass.SENSITIVE, `Char ${char.name} has Spec v2 data missing`);
        return char;
    }

    // If 'json_data' was already saved, don't let it propagate
    _.unset(char, 'json_data');

    const fieldMappings = {
        name: 'name',
        description: 'description',
        personality: 'personality',
        scenario: 'scenario',
        first_mes: 'first_mes',
        mes_example: 'mes_example',
        talkativeness: 'extensions.talkativeness',
        fav: 'extensions.fav',
        tags: 'tags',
    };

    _.forEach(fieldMappings, (v2Path, charField) => {
        //console.info(`Migrating field: ${charField} from ${v2Path}`);
        const v2Value = _.get(char.data, v2Path);
        if (_.isUndefined(v2Value)) {
            let defaultValue = undefined;

            // Backfill default values for missing ST extension fields
            if (v2Path === 'extensions.talkativeness') {
                defaultValue = 0.5;
            }

            if (v2Path === 'extensions.fav') {
                defaultValue = false;
            }

            if (!_.isUndefined(defaultValue)) {
                //console.warn(`Spec v2 extension data missing for field: ${charField}, using default value: ${defaultValue}`);
                char[charField] = defaultValue;
            } else {
                log.warn(LogClass.SENSITIVE, `Char ${char.name} has Spec v2 data missing for unknown field: ${charField}`);
                return;
            }
        }
        if (!_.isUndefined(char[charField]) && !_.isUndefined(v2Value) && String(char[charField]) !== String(v2Value)) {
            log.warn(LogClass.SENSITIVE, `Char ${char.name} has Spec v2 data mismatch with Spec v1 for field: ${charField}`, char[charField], v2Value);
        }
        char[charField] = v2Value;
    });

    char.chat = char.chat ?? `${char.name} - ${humanizedDateTime()}`;

    return char;
}

/**
 * Format character data to Spec V2 format.
 * @param {object} data Character data
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns
 */
function charaFormatData(data, directories) {
    // This is supposed to save all the foreign keys that ST doesn't care about
    const char = tryParse(data.json_data) || {};

    // Prevent erroneous 'json_data' recursive saving
    _.unset(char, 'json_data');

    // Checks if data.alternate_greetings is an array, a string, or neither, and acts accordingly. (expected to be an array of strings)
    const getAlternateGreetings = data => {
        if (Array.isArray(data.alternate_greetings)) return data.alternate_greetings;
        if (typeof data.alternate_greetings === 'string') return [data.alternate_greetings];
        return [];
    };

    // Spec V1 fields
    _.set(char, 'name', data.ch_name);
    _.set(char, 'description', data.description || '');
    _.set(char, 'personality', data.personality || '');
    _.set(char, 'scenario', data.scenario || '');
    _.set(char, 'first_mes', data.first_mes || '');
    _.set(char, 'mes_example', data.mes_example || '');

    // Old ST extension fields (for backward compatibility, will be deprecated)
    _.set(char, 'creatorcomment', data.creator_notes || '');
    _.set(char, 'avatar', 'none');
    _.set(char, 'chat', data.ch_name + ' - ' + humanizedDateTime());
    _.set(char, 'talkativeness', data.talkativeness || 0.5);
    _.set(char, 'fav', data.fav == 'true');
    _.set(char, 'tags', typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || []);

    // Spec V2 fields
    _.set(char, 'spec', 'chara_card_v2');
    _.set(char, 'spec_version', '2.0');
    _.set(char, 'data.name', data.ch_name);
    _.set(char, 'data.description', data.description || '');
    _.set(char, 'data.personality', data.personality || '');
    _.set(char, 'data.scenario', data.scenario || '');
    _.set(char, 'data.first_mes', data.first_mes || '');
    _.set(char, 'data.mes_example', data.mes_example || '');

    // New V2 fields
    _.set(char, 'data.creator_notes', data.creator_notes || '');
    _.set(char, 'data.system_prompt', data.system_prompt || '');
    _.set(char, 'data.post_history_instructions', data.post_history_instructions || '');
    _.set(char, 'data.tags', typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || []);
    _.set(char, 'data.creator', data.creator || '');
    _.set(char, 'data.character_version', data.character_version || '');
    _.set(char, 'data.alternate_greetings', getAlternateGreetings(data));

    // ST extension fields to V2 object
    _.set(char, 'data.extensions.talkativeness', data.talkativeness || 0.5);
    _.set(char, 'data.extensions.fav', data.fav == 'true');
    _.set(char, 'data.extensions.world', data.world || '');

    // Spec extension: depth prompt
    const depth_default = 4;
    const role_default = 'system';
    const depth_value = !isNaN(Number(data.depth_prompt_depth)) ? Number(data.depth_prompt_depth) : depth_default;
    const role_value = data.depth_prompt_role ?? role_default;
    _.set(char, 'data.extensions.depth_prompt.prompt', data.depth_prompt_prompt ?? '');
    _.set(char, 'data.extensions.depth_prompt.depth', depth_value);
    _.set(char, 'data.extensions.depth_prompt.role', role_value);

    if (data.world) {
        try {
            const file = readWorldInfoFile(directories, data.world, false);

            // File was imported - save it to the character book
            if (file && file.originalData) {
                _.set(char, 'data.character_book', file.originalData);
            }

            // File was not imported - convert the world info to the character book
            if (file && file.entries) {
                _.set(char, 'data.character_book', convertWorldInfoToCharacterBook(data.world, file.entries));
            }
        } catch {
            log.warn(LogClass.SENSITIVE, `Failed to read world info file: ${data.world}. Character book will not be available.`);
        }
    }

    if (data.extensions) {
        try {
            const extensions = JSON.parse(data.extensions);
            // Deep merge the extensions object
            _.set(char, 'data.extensions', deepMerge(char.data.extensions, extensions));
        } catch {
            log.warn(LogClass.SENSITIVE, `Failed to parse extensions JSON: ${data.extensions}`);
        }
    }

    return char;
}

/**
 * @param {string} name Name of World Info file
 * @param {object} entries Entries object
 */
function convertWorldInfoToCharacterBook(name, entries) {
    /** @type {{ entries: object[]; name: string }} */
    const result = { entries: [], name };

    for (const index in entries) {
        const entry = entries[index];

        const originalEntry = {
            id: entry.uid,
            keys: entry.key,
            secondary_keys: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            insertion_order: entry.order,
            enabled: !entry.disable,
            position: entry.position == 0 ? 'before_char' : 'after_char',
            use_regex: true, // ST keys are always regex
            extensions: {
                ...entry.extensions,
                position: entry.position,
                exclude_recursion: entry.excludeRecursion,
                display_index: entry.displayIndex,
                probability: entry.probability ?? null,
                useProbability: entry.useProbability ?? false,
                depth: entry.depth ?? 4,
                selectiveLogic: entry.selectiveLogic ?? 0,
                outlet_name: entry.outletName ?? '',
                group: entry.group ?? '',
                group_override: entry.groupOverride ?? false,
                group_weight: entry.groupWeight ?? null,
                prevent_recursion: entry.preventRecursion ?? false,
                delay_until_recursion: entry.delayUntilRecursion ?? false,
                scan_depth: entry.scanDepth ?? null,
                match_whole_words: entry.matchWholeWords ?? null,
                use_group_scoring: entry.useGroupScoring ?? false,
                case_sensitive: entry.caseSensitive ?? null,
                automation_id: entry.automationId ?? '',
                role: entry.role ?? 0,
                vectorized: entry.vectorized ?? false,
                sticky: entry.sticky ?? null,
                cooldown: entry.cooldown ?? null,
                delay: entry.delay ?? null,
                match_persona_description: entry.matchPersonaDescription ?? false,
                match_character_description: entry.matchCharacterDescription ?? false,
                match_character_personality: entry.matchCharacterPersonality ?? false,
                match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
                match_scenario: entry.matchScenario ?? false,
                match_creator_notes: entry.matchCreatorNotes ?? false,
                triggers: entry.triggers ?? [],
                ignore_budget: entry.ignoreBudget ?? false,
            },
        };

        result.entries.push(originalEntry);
    }

    return result;
}

/**
 * Import a character from a YAML file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromYaml(uploadPath, context, preservedFileName) {
    const fileText = storage.readFileSync(uploadPath, 'utf8');
    storage.unlink(uploadPath);
    const yamlData = yaml.parse(fileText);
    log.info(LogClass.NORMAL, 'Importing from YAML');
    yamlData.name = sanitize(yamlData.name);
    const fileName = preservedFileName || getPngName(yamlData.name, context.request.user.directories);
    let char = convertToV2({
        'name': yamlData.name,
        'description': yamlData.context ?? '',
        'first_mes': yamlData.greeting ?? '',
        'create_date': new Date().toISOString(),
        'chat': `${yamlData.name} - ${humanizedDateTime()}`,
        'personality': '',
        'creatorcomment': '',
        'avatar': 'none',
        'mes_example': '',
        'scenario': '',
        'talkativeness': 0.5,
        'creator': '',
        'tags': '',
    }, context.request.user.directories);
    const result = await writeCharacterData(DEFAULT_AVATAR_PATH, JSON.stringify(char), fileName, context.request);
    return result ? fileName : '';
}

/**
 * Imports a character card from CharX (ZIP) file.
 * @param {string} uploadPath
 * @param {object} params
 * @param {import('express').Request} params.request
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromCharX(uploadPath, { request }, preservedFileName) {
    const fileBuffer = storage.readFileSync(uploadPath);
    // Create a properly-sized ArrayBuffer (Node's buffer pool can cause oversized .buffer)
    const data = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
    storage.unlink(uploadPath);

    const parser = new CharXParser(data);
    const { card, avatar, auxiliaryAssets, extractedBuffers } = await parser.parse();

    // Apply standard character transformations
    if (card.data?.name) {
        card.data.name = sanitize(card.data.name);
    }
    card.name = sanitize(card.data?.name || card.name);
    let processedCard = readFromV2(card);
    unsetPrivateFields(processedCard);
    processedCard.create_date = new Date().toISOString();

    const fileName = preservedFileName || getPngName(processedCard.name, request.user.directories);
    // Use the actual character name for asset folders, not the unique filename
    // ST's sprite system looks up by character name, not PNG filename
    const characterFolder = processedCard.name;

    if (auxiliaryAssets.length > 0) {
        try {
            const summary = persistCharXAssets(auxiliaryAssets, extractedBuffers, request.user.directories, characterFolder);
            if (summary.sprites || summary.backgrounds || summary.misc) {
                log.info(LogClass.NORMAL, `CharX: Imported ${summary.sprites} sprite(s), ${summary.backgrounds} background(s), ${summary.misc} misc asset(s).`);
                log.info(LogClass.SENSITIVE, `CharX: auxiliary assets were imported for ${characterFolder}`);
            }
        } catch (error) {
            log.warn(LogClass.SENSITIVE, `CharX: Failed to persist auxiliary assets for ${characterFolder}`, error);
        }
    }

    const result = await writeCharacterData(avatar, JSON.stringify(processedCard), fileName, request);
    return result ? fileName : '';
}

async function importFromByaf(uploadPath, { request }, preservedFileName) {
    const data = (await storage.readFile(uploadPath)).buffer;
    await storage.unlink(uploadPath);
    log.info(LogClass.NORMAL, 'Importing from BYAF');

    const byafData = await new ByafParser(data).parse();
    const card = readFromV2(byafData.card);
    const fileName = preservedFileName || getPngName(sanitize(byafData.character.displayName || card.name, { replacement: sanitizeSafeCharacterReplacements }), request.user.directories);

    // Don't import chats and images if the character is being replaced or updated, instead of newly imported.
    if (!preservedFileName) {
        /**
         * @param {Partial<ByafScenario>} scenario
        */
        const createChatAsCurrentPersona = (scenario) => {
            const chatName = sanitize(`${scenario.title || card.name} - ${humanizedDateTime()} imported.jsonl`, { replacement: sanitizeSafeCharacterReplacements });
            const filePath = path.join(request.user.directories.chats, path.basename(fileName), chatName);
            const dir = path.dirname(filePath);
            if (!storage.exists(dir)) storage.mkdir(dir, { recursive: true });
            storage.writeFileSync(filePath, ByafParser.getChatFromScenario(scenario, request.body.user_name, card.name, byafData.chatBackgrounds), 'utf8');
            log.info(LogClass.SENSITIVE, `Created ${chatName} chat from BYAF import`);
            return chatName;
        };

        // Upload backgrounds
        for (const bg of byafData.chatBackgrounds) {
            const extension = path.extname(bg.paths?.[0]) || '.png';
            const baseName = `${path.basename(fileName)}_bg`;
            const filePath = path.join(request.user.directories.userImages, fileName);
            if (!storage.exists(filePath)) storage.mkdir(filePath, { recursive: true });
            const file = getUniqueName(baseName, (name) => storage.exists(path.join(filePath, `${name}${extension}`)));
            if (Buffer.isBuffer(bg.data)) {
                const newFile = `${file}${extension}`;
                storage.writeFileSync(path.join(filePath, newFile), bg.data);
                bg.name = clientRelativePath(request.user.directories.root, path.join(filePath, newFile)); // Update background name to the new file
                log.info(LogClass.SENSITIVE, `Created ${newFile} background from BYAF import`);
            }
        }

        const chats = [];
        // Create chats for each scenario
        if (Array.isArray(byafData.scenarios)) {
            for (const scenario of byafData.scenarios) {
                chats.push(createChatAsCurrentPersona(scenario));
            }
        }

        // Update the default chat if there are any so we open to an existing chat instead of creating a new one and opening that.
        if (chats.length > 0) {
            card.chat = path.basename(chats[0], path.extname(chats[0]));
        }

        // Save alternate icons for the character.
        for (const icon of byafData.images.slice(1)) {
            // BYAF does not support character expressions, so using the same structure will not result in conflicts,
            // even if the expression system did not tolerate additional icons that are not mapped to expressions.
            // This will not yet allow changing icons within the UI but at least the icons will be available for manual selection, rather than being lost.
            const altImagesFolder = path.join(request.user.directories.characters, sanitize(card.name));
            if (!storage.exists(altImagesFolder)) storage.mkdir(altImagesFolder, { recursive: true });
            const extension = path.extname(icon.filename) || '.png';
            const file = getUniqueName(`${sanitize(icon.label, { replacement: sanitizeSafeCharacterReplacements }) || 'alt'}`, (name) => storage.exists(path.join(altImagesFolder, `${name}${extension}`)));
            if (Buffer.isBuffer(icon.image)) {
                storage.writeFileSync(path.join(altImagesFolder, `${file}${extension}`), icon.image);
                log.info(LogClass.SENSITIVE, `Created ${file}${extension} alternate icon from BYAF import`);
            }
        }
    }

    const result = await writeCharacterData(byafData.images[0].image, JSON.stringify(card), fileName, request);

    return result ? fileName : '';
}

/**
 * Import a character from a JSON file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromJson(uploadPath, { request }, preservedFileName) {
    const data = storage.readFileSync(uploadPath, 'utf8');
    storage.unlink(uploadPath);

    let jsonData = JSON.parse(data);

    if (jsonData.spec !== undefined) {
        log.info(LogClass.NORMAL, 'Importing from json with spec:', redact(jsonData.spec));
        importRisuSprites(request.user.directories, jsonData);
        unsetPrivateFields(jsonData);
        if (jsonData.data?.name) {
            jsonData.data.name = sanitize(jsonData.data.name);
        }
        jsonData.name = sanitize(jsonData.data?.name || jsonData.name);
        jsonData = readFromV2(jsonData);
        jsonData.create_date = new Date().toISOString();
        const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);
        const char = JSON.stringify(jsonData);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, char, pngName, request);
        return result ? pngName : '';
    } else if (jsonData.name !== undefined) {
        log.info(LogClass.NORMAL, 'Importing from v1 json');
        jsonData.name = sanitize(jsonData.name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);
        let char = {
            'name': jsonData.name,
            'description': jsonData.description ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': jsonData.personality ?? '',
            'first_mes': jsonData.first_mes ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
            'mes_example': jsonData.mes_example ?? '',
            'scenario': jsonData.scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        let charJSON = JSON.stringify(char);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, charJSON, pngName, request);
        return result ? pngName : '';
    } else if (jsonData.char_name !== undefined) {
        //json Pygmalion notepad
        log.info(LogClass.NORMAL, 'Importing from gradio json');
        jsonData.char_name = sanitize(jsonData.char_name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        const pngName = preservedFileName || getPngName(jsonData.char_name, request.user.directories);
        let char = {
            'name': jsonData.char_name,
            'description': jsonData.char_persona ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': '',
            'first_mes': jsonData.char_greeting ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
            'mes_example': jsonData.example_dialogue ?? '',
            'scenario': jsonData.world_scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        const charJSON = JSON.stringify(char);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, charJSON, pngName, request);
        return result ? pngName : '';
    }

    return '';
}

/**
 * Import a character from a PNG file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromPng(uploadPath, { request }, preservedFileName) {
    const imgData = await readCharacterData(uploadPath, request.user.profile.handle);
    if (imgData === undefined) throw new Error('Failed to read character data');

    let jsonData = JSON.parse(imgData);

    if (jsonData.data?.name) {
        jsonData.data.name = sanitize(jsonData.data.name);
    }
    jsonData.name = sanitize(jsonData.data?.name || jsonData.name);
    const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);

    if (jsonData.spec !== undefined) {
        log.info(LogClass.NORMAL, 'Found a character card file with spec:', redact(jsonData.spec));
        importRisuSprites(request.user.directories, jsonData);
        unsetPrivateFields(jsonData);
        jsonData = readFromV2(jsonData);
        jsonData.create_date = new Date().toISOString();
        const char = JSON.stringify(jsonData);
        const result = await writeCharacterData(uploadPath, char, pngName, request);
        storage.unlink(uploadPath);
        return result ? pngName : '';
    } else if (jsonData.name !== undefined) {
        log.info(LogClass.NORMAL, 'Found a v1 character file.');

        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }

        let char = {
            'name': jsonData.name,
            'description': jsonData.description ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': jsonData.personality ?? '',
            'first_mes': jsonData.first_mes ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
            'mes_example': jsonData.mes_example ?? '',
            'scenario': jsonData.scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        const charJSON = JSON.stringify(char);
        const result = await writeCharacterData(uploadPath, charJSON, pngName, request);
        storage.unlink(uploadPath);
        return result ? pngName : '';
    }

    return '';
}

export const router = express.Router();

router.post('/create', getFileNameValidationFunction('file_name'), async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        request.body.ch_name = sanitize(request.body.ch_name);

        const char = JSON.stringify(charaFormatData(request.body, request.user.directories));
        const internalName = request.body.file_name || getPngName(request.body.ch_name, request.user.directories);
        const avatarName = `${internalName}.png`;
        const chatsPath = path.join(request.user.directories.chats, internalName);

        if (!storage.exists(chatsPath)) storage.mkdir(chatsPath);

        // 🔴 `writeCharacterData` REPORTS FAILURE BY RETURNING FALSE, NOT BY THROWING — it catches
        // everything internally. So the surrounding try/catch here never fires on a failed write, and these
        // call sites answered a card that was never written with the card's own filename and a 200. Every
        // import path in this file already checks this return; the mutating ones did not.
        if (!request.file) {
            if (!await writeCharacterData(DEFAULT_AVATAR_PATH, char, internalName, request)) {
                log.error(LogClass.NORMAL, 'Character creation failed: the card could not be written.');
                return response.sendStatus(500);
            }
            return response.send(avatarName);
        } else {
            const crop = tryParse(request.query.crop);
            const uploadPath = path.join(request.file.destination, request.file.filename);
            const written = await writeCharacterData(uploadPath, char, internalName, request, crop);
            storage.unlink(uploadPath);
            if (!written) {
                log.error(LogClass.NORMAL, 'Character creation failed: the card could not be written.');
                return response.sendStatus(500);
            }
            return response.send(avatarName);
        }
    } catch (err) {
        log.error(LogClass.NORMAL, 'Failed to create character');
        log.error(LogClass.SENSITIVE, err);
        response.sendStatus(500);
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.avatar_url || !request.body.new_name) {
        return response.sendStatus(400);
    }

    const oldAvatarName = request.body.avatar_url;
    const newName = sanitize(request.body.new_name);
    const oldInternalName = path.parse(request.body.avatar_url).name;
    const newInternalName = getPngName(newName, request.user.directories);
    const newAvatarName = `${newInternalName}.png`;

    const oldAvatarPath = path.join(request.user.directories.characters, oldAvatarName);

    const oldChatsPath = path.join(request.user.directories.chats, oldInternalName);
    const newChatsPath = path.join(request.user.directories.chats, newInternalName);

    try {
        // Read old file, replace name int it
        const rawOldData = await readCharacterData(oldAvatarPath, request.user.profile.handle);
        if (rawOldData === undefined) throw new Error('Failed to read character file');

        const oldData = getCharaCardV2(JSON.parse(rawOldData), request.user.directories);
        _.set(oldData, 'data.name', newName);
        _.set(oldData, 'name', newName);
        const newData = JSON.stringify(oldData);

        // 🔴 CHECK THE WRITE BEFORE DESTROYING THE ORIGINAL. `writeCharacterData` reports failure by
        // returning false — it catches everything — and this call site discarded that, then went on to
        // unlink the old card a few lines below. A provider write that failed (locked vault, ENOSPC, a PNG
        // encode throw) therefore produced: nothing at the new name, nothing at the old name, chats moved
        // to a folder with no card, and HTTP 200. The character was simply gone, and the user was told the
        // rename worked. Every import path in this file already checks this return; the mutating ones did not.
        const written = await writeCharacterData(oldAvatarPath, newData, newInternalName, request);
        if (!written) {
            log.error(LogClass.NORMAL, 'Rename aborted: the renamed character could not be written. The original is untouched.');
            return response.sendStatus(500);
        }

        // Rename chats folder
        if (storage.exists(oldChatsPath) && !storage.exists(newChatsPath)) {
            storage.cp(oldChatsPath, newChatsPath, { recursive: true });
            storage.rm(oldChatsPath, { recursive: true, force: true });
        }

        // Remove the old character file
        storage.unlink(oldAvatarPath);

        // ⚠️ THE OTHER HALF OF THE RENAME, AND WITHOUT IT A RENAME LOOKS LIKE A DUPLICATE. `writeCharacterData`
        // has already announced the NEW avatar; nothing has yet said the old one is gone, so a listening tab
        // would show both until it was reloaded — which is the staleness this channel exists to remove,
        // reintroduced by the one operation that both creates and destroys.
        emitForRequest(request, 'character.deleted', { avatar: oldAvatarName });

        // 🔴 §22: CARRY THE STABLE ID ACROSS, AND THIS IS THE WHOLE POINT OF THE FEATURE. Everything above
        // has just changed the character's identity as far as the rest of the app is concerned — new display
        // name, new avatar filename, new chats folder, and every avatar-keyed subsystem hand-migrated by the
        // client. The one thing that must NOT change is the id a memory plugin filed its memories under.
        //
        // ⚠️ It is safe to key the map on a filename precisely BECAUSE this line exists: the fork is what
        // renames the avatar, so it is the fork's job to move the id with it. A plugin keying on the avatar
        // itself had no such hook, which is why the avatar failed as an identity for them and works here.
        // ⚠️ GUARDED, BECAUSE BY THIS LINE THE RENAME IS ALREADY A FACT ON DISK. The card is written under the
        // new name, the chats folder is moved, the old card is unlinked and `character.deleted` has been
        // emitted — so a throw here answered 500 for an operation that fully succeeded. The client reads a
        // non-ok as total failure: it skips `renameTagKey`, `charLore`, `note.chara`, `active_character` and
        // `renameGroupMember`, then reloads. Every avatar-keyed reference in settings and in every group is
        // then pointing at an avatar that no longer exists — the dangling-reference class, produced by the
        // fork's own consistency mechanism. And it is not rare: `character-ids.json` is written through the
        // provider, so with one uninstalled `readCharacterIds` rethrows on EVERY rename, permanently.
        //
        // A missed id carries its own cost (§22: memories filed under the old id are orphaned), so this is
        // loud. But telling the client the truth — the rename happened, migrate your keys — is strictly
        // better than letting it believe nothing happened when everything did.
        try {
            await renameCharacterId(request.user.directories.root, oldAvatarName, newAvatarName);
        } catch (err) {
            log.error(LogClass.NORMAL, 'The character was renamed, but its durable id could not be carried across. Memories filed under the old id will not follow it.');
            log.error(LogClass.SENSITIVE, 'renameCharacterId failed:', err);
        }

        // Return new avatar name to ST
        return response.send({ avatar: newAvatarName });
    } catch (err) {
        log.error(LogClass.NORMAL, 'Failed to rename character');
        log.error(LogClass.SENSITIVE, err);
        return response.sendStatus(500);
    }
});

router.post('/edit', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body) {
        log.warn(LogClass.NORMAL, 'Error: no response body detected');
        response.status(400).send('Error: no response body detected');
        return;
    }

    if (request.body.ch_name === '' || request.body.ch_name === undefined || request.body.ch_name === '.') {
        log.warn(LogClass.NORMAL, 'Error: invalid name.');
        response.status(400).send('Error: invalid name.');
        return;
    }

    let char = charaFormatData(request.body, request.user.directories);
    char.chat = request.body.chat;
    char.create_date = request.body.create_date;
    char = JSON.stringify(char);
    let targetFile = (request.body.avatar_url).replace('.png', '');

    try {
        if (!request.file) {
            const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
            if (!await writeCharacterData(avatarPath, char, targetFile, request)) {
                log.error(LogClass.NORMAL, 'Character edit failed: the card could not be written.');
                return response.sendStatus(500);
            }
        } else {
            const crop = tryParse(request.query.crop);
            const newAvatarPath = path.join(request.file.destination, request.file.filename);
            const written = await writeCharacterData(newAvatarPath, char, targetFile, request, crop);
            storage.unlink(newAvatarPath);

            if (!written) {
                log.error(LogClass.NORMAL, 'Character edit failed: the card could not be written.');
                return response.sendStatus(500);
            }

            // 🔴 AFTER THE WRITE, NEVER BEFORE IT. `serveThumbnail` regenerates only when the cached
            // file is ABSENT, so a request arriving between an early invalidation and the new card
            // landing on disk regenerates the thumbnail from the OLD image and caches it again — and
            // nothing invalidates it a second time, so that character wears its previous picture
            // until someone empties the cache by hand. Invalidating afterwards can at worst serve one
            // stale response while the write is in flight, which the next request corrects.
            invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);

            // Bust cache to reload the new avatar
            cacheBuster.bust(request, response);
        }

        return response.sendStatus(200);
    } catch (err) {
        log.error(LogClass.NORMAL, 'An error occurred, character edit invalidated.');
        log.error(LogClass.SENSITIVE, 'Character edit error:', err);
        return response.sendStatus(500);
    }
});

router.post('/edit-avatar', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.file) {
            return response.status(400).send('Error: no file uploaded');
        }

        if (!request.body || !request.body.avatar_url) {
            return response.status(400).send('Error: no avatar_url in request body');
        }

        const uploadPath = path.join(request.file.destination, request.file.filename);
        if (!storage.exists(uploadPath)) {
            return response.status(400).send('Error: uploaded file does not exist');
        }
        const characterPath = path.join(request.user.directories.characters, request.body.avatar_url);
        if (!storage.exists(characterPath)) {
            return response.status(400).send('Error: character file does not exist');
        }
        const data = await readCharacterData(characterPath, request.user.profile.handle);
        if (!data) {
            return response.status(400).send('Error: failed to read character data');
        }

        const crop = tryParse(request.query.crop);
        const fileName = request.body.avatar_url.replace('.png', '');
        const written = await writeCharacterData(uploadPath, data, fileName, request, crop);

        // Remove uploaded temp file
        storage.unlink(uploadPath);

        if (!written) {
            log.error(LogClass.NORMAL, 'Avatar edit failed: the card could not be written.');
            return response.sendStatus(500);
        }

        // Reset images caches
        cacheBuster.bust(request, response);
        invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);

        return response.sendStatus(200);
    } catch (err) {
        log.error(LogClass.NORMAL, 'An error occurred while editing a character avatar');
        log.error(LogClass.SENSITIVE, 'Avatar edit error:', err);
        return response.sendStatus(500);
    }
});

/**
 * Handle a POST request to edit a character attribute.
 *
 * This function reads the character data from a file, updates the specified attribute,
 * and writes the updated data back to the file.
 *
 * @param {Object} request - The HTTP request object.
 * @param {Object} response - The HTTP response object.
 * @returns {void}
 */
router.post('/edit-attribute', validateAvatarUrlMiddleware, async function (request, response) {
    log.debug(LogClass.SENSITIVE, request.body);
    if (!request.body) {
        log.warn(LogClass.NORMAL, 'Error: no response body detected');
        return response.status(400).send('Error: no response body detected');
    }

    if (request.body.ch_name === '' || request.body.ch_name === undefined || request.body.ch_name === '.') {
        log.warn(LogClass.NORMAL, 'Error: invalid name.');
        return response.status(400).send('Error: invalid name.');
    }

    if (request.body.field === 'json_data') {
        log.warn(LogClass.NORMAL, 'Error: cannot edit json_data field.');
        return response.status(400).send('Error: cannot edit json_data field.');
    }

    try {
        const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
        const charJSON = await readCharacterData(avatarPath, request.user.profile.handle);
        if (typeof charJSON !== 'string') throw new Error('Failed to read character file');

        const char = JSON.parse(charJSON);
        //check if the field exists
        if (char[request.body.field] === undefined && char.data[request.body.field] === undefined) {
            log.warn(LogClass.NORMAL, 'Error: invalid field.');
            response.status(400).send('Error: invalid field.');
            return;
        }
        char[request.body.field] = request.body.value;
        char.data[request.body.field] = request.body.value;
        let newCharJSON = JSON.stringify(char);
        const targetFile = (request.body.avatar_url).replace('.png', '');
        if (!await writeCharacterData(avatarPath, newCharJSON, targetFile, request)) {
            log.error(LogClass.NORMAL, 'Character attribute edit failed: the card could not be written.');
            return response.sendStatus(500);
        }

        return response.sendStatus(200);
    } catch (err) {
        log.error(LogClass.NORMAL, 'An error occurred, character attribute edit invalidated.');
        log.error(LogClass.SENSITIVE, 'Character attribute edit error:', err);
        return response.sendStatus(500);
    }
});

/**
 * Sentinel value that signals a field should be completely removed (unset)
 * from the character card rather than being set to any value. Use this in
 * the merge payload wherever a key should be deleted.
 *
 * Both the server and the frontend share this constant so that callers can
 * explicitly opt into deletion without overloading `null`.
 * @type {string}
 */
const UNSET_SENTINEL = '__@@UNSET@@__';

/** Maximum number of characters processed in parallel during bulk merge */
const BULK_MERGE_CONCURRENCY = 10;

/**
 * Recursively walks `source` and removes any key from `target` whose
 * corresponding value in `source` equals the {@link UNSET_SENTINEL}.
 * Called after {@link deepMerge} so that the sentinel gets replaced by
 * an actual key deletion.
 * @param {object} target The merged character object to clean up
 * @param {object} source The original update payload (pre-merge clone)
 */
function processUnsetSentinels(target, source) {
    for (const key of Object.keys(source)) {
        if (source[key] === UNSET_SENTINEL) {
            _.unset(target, key);
        } else if (_.isPlainObject(source[key]) && _.isPlainObject(target[key])) {
            processUnsetSentinels(target[key], source[key]);
        }
    }
}

/**
 * Reads a character card, applies a merge update (with sentinel-based
 * unsetting), validates the result, and writes it back.
 * @param {string} avatarPath Full path to the character PNG
 * @param {string} avatar     Avatar filename (e.g. "char.png")
 * @param {object} updateData The merge payload to apply
 * @param {import("express").Request} request Express request object
 * @param {((data: any) => boolean) | null} [shouldSkip] Optional function to determine if a character should be skipped based on its original data (used for bulk merge filtering)
 * @returns {Promise<{ok: boolean, error?: string, skipped?: boolean}>} Result of the merge operation, including any validation error
 */
async function mergeCharacterUpdate(avatarPath, avatar, updateData, request, shouldSkip = null) {
    const pngStringData = await readCharacterData(avatarPath, request.user.profile.handle);
    if (!pngStringData) {
        return { ok: false, error: 'Invalid character file' };
    }

    let character = JSON.parse(pngStringData);

    if (typeof shouldSkip === 'function' && shouldSkip(character)) {
        return { ok: false, skipped: true };
    }

    const update = _.cloneDeep(updateData);
    _.unset(update, 'json_data');
    _.unset(character, 'json_data');

    character = deepMerge(character, update);
    processUnsetSentinels(character, update);

    const validator = new TavernCardValidator(character);
    //Accept either V1 or V2.
    if (!validator.validate()) {
        return { ok: false, error: validator.lastValidationError ?? 'Validation failed' };
    }

    const targetImg = avatar.replace('.png', '');
    if (!await writeCharacterData(avatarPath, JSON.stringify(character), targetImg, request)) {
        return { ok: false, error: 'The character card could not be written.' };
    }

    return { ok: true };
}

/**
 * Handle a POST request to edit character properties.
 *
 * Operates in two modes depending on the request body:
 *
 * **Single mode** (default behavior) — when `avatar` (string) is present:
 *   Merges the request body with the selected character and validates the
 *   result against TavernCard V2 specification.
 *
 * **Bulk mode** — when `avatars` (array) is present:
 *   Applies the same merge to multiple characters in parallel. Supports:
 *   - An explicit list of avatars, or all characters when the array is empty
 *   - An optional server-side `filter` so only characters where a given
 *     JSON path exists and is non-null are updated
 *
 * In both modes, any value equal to the sentinel `__@@UNSET@@__` will cause
 * that key to be **deleted** from the character card instead of being set.
 *
 * @param {import("express").Request} request - The HTTP request object
 * @param {import("express").Response} response - The HTTP response object
 * @returns {void}
 */
router.post('/merge-attributes', getFileNameValidationFunction('avatar'), async function (request, response) {
    try {
        // ── Bulk mode: avatars array is present ──────────────────
        if (Array.isArray(request.body.avatars)) {
            const { avatars, data, filter } = request.body;

            if (!_.isPlainObject(data)) {
                return response.status(400).send({ message: 'No valid update data provided.' });
            }

            // Determine which avatar files to process
            let targetAvatars;
            if (avatars.length > 0) {
                for (const avatar of avatars) {
                    if (typeof avatar !== 'string' || forbiddenRegExp.test(avatar) || path.extname(avatar).toLowerCase() !== '.png') {
                        return response.status(400).send({ message: `Invalid avatar filename: ${avatar}` });
                    }
                }
                targetAvatars = avatars;
            } else {
                // Empty array → scan all characters in the directory
                const files = storage.readdir(request.user.directories.characters);
                targetAvatars = files.filter(file => path.extname(file).toLowerCase() === '.png');
            }

            const updated = [];
            const skipped = [];
            const failed = [];

            /**
             * Process a single character in bulk: read, filter, merge, validate, write.
             * @param {string} avatar Avatar filename
             */
            const processOne = async (avatar) => {
                const avatarPath = path.join(request.user.directories.characters, avatar);

                try {
                    /** @type {(character: object) => boolean} */
                    let shouldSkip = () => false;

                    // Apply optional server-side filter before updating the card
                    if (filter && typeof filter.path === 'string') {
                        shouldSkip = (character) => {
                            const value = _.get(character, filter.path);
                            return value === undefined;
                        };
                    }

                    const result = await mergeCharacterUpdate(avatarPath, avatar, data, request, shouldSkip);
                    if (result.ok) {
                        updated.push(avatar);
                    } else if (result.skipped) {
                        skipped.push(avatar);
                    } else {
                        log.warn(LogClass.SENSITIVE, `Bulk merge failed for ${avatar}:`, result.error);
                        failed.push(avatar);
                    }
                } catch (error) {
                    log.error(LogClass.NORMAL, 'Bulk attribute merge failed for a character');
                    log.error(LogClass.SENSITIVE, `Bulk merge failed for ${avatar}:`, error);
                    failed.push(avatar);
                }
            };

            // Process in parallel with a concurrency limit
            for (let i = 0; i < targetAvatars.length; i += BULK_MERGE_CONCURRENCY) {
                const batch = targetAvatars.slice(i, i + BULK_MERGE_CONCURRENCY);
                await Promise.allSettled(batch.map(processOne));
            }

            return response.send({ updated, skipped, failed });
        }

        // ── Single mode (default behavior) ───────────────────────
        const update = request.body;
        const avatarPath = path.join(request.user.directories.characters, update.avatar);

        const result = await mergeCharacterUpdate(avatarPath, update.avatar, update, request);
        if (result.ok) {
            response.sendStatus(200);
        } else {
            log.warn(LogClass.SENSITIVE, result.error);
            response.status(400).send({ message: `Validation failed for ${update.avatar}`, error: result.error });
        }
    } catch (exception) {
        response.status(500).send({ message: 'Unexpected error while saving character.', error: exception.toString() });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body || !request.body.avatar_url) {
        return response.sendStatus(400);
    }

    if (request.body.avatar_url !== sanitize(request.body.avatar_url)) {
        log.error(LogClass.NORMAL, 'Malicious filename prevented');
        return response.sendStatus(403);
    }

    const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
    if (!storage.exists(avatarPath)) {
        return response.sendStatus(400);
    }

    try {
        storage.unlink(avatarPath);
    } catch (err) {
        log.error(LogClass.NORMAL, 'Failed to delete the character card.');
        log.error(LogClass.SENSITIVE, 'Failed to delete the character card:', err);
        return response.sendStatus(500);
    }

    invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);

    // The card is gone from disk as of the `unlink` above; everything below this point is cleanup of things
    // that referred to it. Announcing here rather than at the end means a tab does not keep offering a
    // character that no longer exists just because chat-folder removal went on to fail.
    emitForRequest(request, 'character.deleted', { avatar: request.body.avatar_url });

    let dir_name = (request.body.avatar_url.replace('.png', ''));

    if (!dir_name.length) {
        log.error(LogClass.NORMAL, 'Malicious dirname prevented');
        return response.sendStatus(403);
    }

    // 🔴 §24: ENUMERATE BEFORE THE `rm`, BECAUSE AFTERWARDS THERE IS NOTHING LEFT TO NAME. The delete below
    // removes the character's whole chat folder recursively and never mentions an individual file, so a
    // plugin keyed on `chatId` would be told nothing at all — and its scenario rows for every one of those
    // chats would persist for the life of the install, with no garbage collector behind them.
    //
    // ⚠️ ONLY WHEN THE CHATS ACTUALLY GO. If `delete_chats` is false the card is deleted and the chat files
    // stay on disk, and firing here would be destructive: the chat FILENAMES are unchanged, so those scenario
    // memories are still reachable and still correct. They key on `chatId` alone with no character axis, which
    // is exactly the property that makes them survive their character — and a card delete is usually a
    // re-import. Note this cuts the opposite way from §22's `charId` reasoning, and both are right: a card
    // delete orphans the USER tier (new `charId` on re-import) while the SCENARIO tier survives it (same
    // `chatId`). Different keys, different fates, same event.
    if (request.body.delete_chats == true) {
        const chatFolder = path.join(request.user.directories.chats, sanitize(dir_name));

        /** @type {string[]} */
        let doomedChats = [];

        try {
            doomedChats = storage.exists(chatFolder)
                ? storage.readdir(chatFolder).filter(file => file.toLowerCase().endsWith('.jsonl'))
                : [];
        } catch (err) {
            // A folder we cannot list is not a reason to refuse the delete the user asked for. It does mean a
            // plugin will not hear about those chats, so say so rather than swallowing it.
            log.error(LogClass.NORMAL, 'Could not enumerate the character\'s chats before deleting them; plugins will not be told about these chats.');
            log.error(LogClass.SENSITIVE, 'Chat enumeration error:', err);
        }

        try {
            await storage.rm(chatFolder, { recursive: true, force: true });
        } catch (err) {
            log.error(LogClass.NORMAL, 'Failed to delete the character\'s chat folder');
            log.error(LogClass.SENSITIVE, err);
            return response.sendStatus(500);
        }

        // After the `rm`, so a plugin is never told a chat is gone while it is still on disk.
        for (const chatFile of doomedChats) {
            await notifyChatDeleted(request.user.profile.handle, chatIdFromPath(chatFile));
        }
    }

    // §22: forget the id, so a DIFFERENT card that later takes this filename cannot inherit this character's
    // identity — and with it, someone else's memories.
    //
    // ⚠️ THIS DOES NOT DESTROY ANY MEMORIES, AND THAT ASYMMETRY IS §22.6's OPEN QUESTION, LEFT OPEN. Deleting
    // a card is often a re-import, so destroying the plugin's data here would make that unrecoverable and the
    // fork does not own that call. What this does mean is that a re-import mints a NEW id and its old
    // memories are orphaned rather than resurfaced. That is the honest failure: unreachable, not misattributed.
    //
    // ⚠️ AND IT IS GUARDED, BECAUSE `readCharacterIds` RETHROWS EVERYTHING THAT IS NOT ENOENT — which is
    // correct of it, and meant an unreadable map (a locked vault, most obviously) rejected this handler.
    // Express 4 does not forward a rejected async handler, so that was not a 500: it was silence on the wire
    // and, until the listener added alongside this review, a process exit for every user on the install.
    try {
        await deleteCharacterId(request.user.directories.root, request.body.avatar_url);
    } catch (err) {
        // The card is already gone, so this cannot be undone — but it must not pass for success. A stale row
        // here is exactly how a later card that takes this filename inherits a stranger's memories.
        log.error(LogClass.NORMAL, 'The character was deleted, but its durable id could not be forgotten. A card later given this same filename could inherit its identity.');
        log.error(LogClass.SENSITIVE, 'deleteCharacterId failed:', err);
        return response.sendStatus(500);
    }

    return response.sendStatus(200);
});

/**
 * HTTP POST endpoint for the "/api/characters/all" route.
 *
 * This endpoint is responsible for reading character files from the `charactersPath` directory,
 * parsing character data, calculating stats for each character and responding with the data.
 * Stats are calculated only on the first run, on subsequent runs the stats are fetched from
 * the `charStats` variable.
 * The stats are calculated by the `calculateStats` function.
 * The characters are processed by the `processCharacter` function.
 *
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/all', async function (request, response) {
    try {
        const files = storage.readdir(request.user.directories.characters);
        const pngFiles = files.filter(file => file.endsWith('.png'));
        const processingPromises = pngFiles.map(file => processCharacter(file, request.user.directories, { shallow: useShallowCharacters }));
        const data = (await Promise.all(processingPromises)).filter(c => c.name);
        return response.send(data);
    } catch (err) {
        log.error(LogClass.NORMAL, 'Failed to list characters');
        log.error(LogClass.SENSITIVE, err);
        const isRangeError = err instanceof RangeError;
        response.status(500).send({ overflow: isRangeError, error: true });
    }
});

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);
        const item = request.body.avatar_url;
        const filePath = path.join(request.user.directories.characters, item);

        if (!storage.exists(filePath)) {
            return response.sendStatus(404);
        }

        const data = await processCharacter(item, request.user.directories, { shallow: false });

        return response.send(data);
    } catch (err) {
        log.error(LogClass.NORMAL, 'Failed to get character');
        log.error(LogClass.SENSITIVE, err);
        response.sendStatus(500);
    }
});

router.post('/chats', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        const characterDirectory = (request.body.avatar_url).replace('.png', '');
        const chatsDirectory = path.join(request.user.directories.chats, characterDirectory);

        if (!storage.exists(chatsDirectory)) {
            return response.send({ error: true });
        }

        const files = storage.readdir(chatsDirectory, { withFileTypes: true });
        const jsonFiles = files.filter(file => file.isFile() && path.extname(file.name) === '.jsonl').map(file => file.name);

        if (jsonFiles.length === 0) {
            return response.send([]);
        }

        if (request.body.simple) {
            return response.send(jsonFiles.map(file => ({ file_name: file, file_id: path.parse(file).name })));
        }

        const jsonFilesPromise = jsonFiles.map((file) => {
            const withMetadata = !!request.body.metadata;
            const pathToFile = path.join(request.user.directories.chats, characterDirectory, file);
            return getChatInfo(pathToFile, {}, withMetadata);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to list the character\'s chats');
        log.error(LogClass.SENSITIVE, error);
        return response.send({ error: true });
    }
});

/**
 * Gets the name for the uploaded PNG file.
 * @param {string} file File name
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} - The name for the uploaded PNG file
 */
function getPngName(file, directories) {
    file = sanitize(file);
    return getUniqueName(file, (name) => storage.exists(path.join(directories.characters, `${name}.png`)),
        { nameBuilder: (base, i) => i === 0 ? base : `${base}${i}`, startIndex: 0, maxTries: 10000 }) ?? file;
}

/**
 * Gets the preserved name for the uploaded file if the request is valid.
 * @param {import("express").Request} request - Express request object
 * @returns {string | undefined} - The preserved name if the request is valid, otherwise undefined
 */
function getPreservedName(request) {
    return typeof request.body.preserved_name === 'string' && request.body.preserved_name.length > 0
        ? path.parse(request.body.preserved_name).name
        : undefined;
}

router.post('/import', async function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);

    const uploadPath = path.join(request.file.destination, request.file.filename);
    const format = request.body.file_type;
    const preservedFileName = getPreservedName(request);

    const formatImportFunctions = {
        'yaml': importFromYaml,
        'yml': importFromYaml,
        'json': importFromJson,
        'png': importFromPng,
        'charx': importFromCharX,
        'byaf': importFromByaf,
    };

    try {
        const importFunction = formatImportFunctions[format];

        if (!importFunction) {
            throw new Error(`Unsupported format: ${format}`);
        }

        const fileName = await importFunction(uploadPath, { request, response }, preservedFileName);

        if (!fileName) {
            log.warn(LogClass.NORMAL, 'Failed to import character');
            return response.sendStatus(400);
        }

        if (preservedFileName) {
            invalidateThumbnail(request.user.directories, 'avatar', `${preservedFileName}.png`);
        }

        response.send({ file_name: fileName });
    } catch (err) {
        log.error(LogClass.NORMAL, 'Failed to import character');
        log.error(LogClass.SENSITIVE, err);
        response.send({ error: true });
    }
});

// ✅ §22 needs NOTHING here, and that is worth saying rather than leaving as an apparent omission. A duplicate
// is written under a new avatar filename, so it has no entry in the id map and mints its own id on first
// generation — §22.9 item 3 holds for free. Copying the original's id across would be the bug: two cards, one
// identity, sharing a memory partition neither of them knows about.
router.post('/duplicate', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.avatar_url) {
            log.warn(LogClass.NORMAL, 'avatar URL not found in request body');
            log.debug(LogClass.SENSITIVE, request.body);
            return response.sendStatus(400);
        }
        let filename = path.join(request.user.directories.characters, sanitize(request.body.avatar_url));
        if (!storage.exists(filename)) {
            log.error(LogClass.NORMAL, 'Character to duplicate was not found on disk');
            log.error(LogClass.SENSITIVE, 'file for dupe not found', filename);
            return response.sendStatus(404);
        }
        let suffix = 1;
        let newFilename = filename;

        // If filename ends with a _number, increment the number
        const nameParts = path.basename(filename, path.extname(filename)).split('_');
        const lastPart = nameParts[nameParts.length - 1];

        let baseName;

        if (!isNaN(Number(lastPart)) && nameParts.length > 1) {
            suffix = parseInt(lastPart) + 1;
            baseName = nameParts.slice(0, -1).join('_'); // construct baseName without suffix
        } else {
            baseName = nameParts.join('_'); // original filename is completely the baseName
        }

        newFilename = path.join(request.user.directories.characters, `${baseName}_${suffix}${path.extname(filename)}`);

        while (storage.exists(newFilename)) {
            let suffixStr = '_' + suffix;
            newFilename = path.join(request.user.directories.characters, `${baseName}${suffixStr}${path.extname(filename)}`);
            suffix++;
        }

        storage.copyFile(filename, newFilename);
        log.info(LogClass.SENSITIVE, `${filename} was copied to ${newFilename}`);
        response.send({ path: path.parse(newFilename).base });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to duplicate character');
        log.error(LogClass.SENSITIVE, error);
        return response.send({ error: true });
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.format || !request.body.avatar_url) {
            return response.sendStatus(400);
        }

        let filename = path.join(request.user.directories.characters, sanitize(request.body.avatar_url));

        if (!storage.exists(filename)) {
            return response.sendStatus(404);
        }

        switch (request.body.format) {
            case 'png': {
                const rawBuffer = await storage.readFile(filename);
                const rawData = read(rawBuffer);
                const mutatedData = mutateJsonString(rawData, unsetPrivateFields);
                const mutatedBuffer = write(rawBuffer, mutatedData);
                const contentType = mime.lookup(filename) || 'image/png';
                response.setHeader('Content-Type', contentType);
                response.setHeader('Content-Disposition', `attachment; filename="${encodeURI(path.basename(filename))}"`);
                return response.send(mutatedBuffer);
            }
            case 'json': {
                try {
                    const json = await readCharacterData(filename, request.user.profile.handle);
                    if (json === undefined) return response.sendStatus(400);
                    const jsonObject = getCharaCardV2(JSON.parse(json), request.user.directories);
                    unsetPrivateFields(jsonObject);
                    return response.type('json').send(JSON.stringify(jsonObject, null, 4));
                } catch {
                    return response.sendStatus(400);
                }
            }
        }

        return response.sendStatus(400);
    } catch (err) {
        log.error(LogClass.NORMAL, 'Character export failed');
        log.error(LogClass.SENSITIVE, 'Character export error:', err);
        response.sendStatus(500);
    }
});
