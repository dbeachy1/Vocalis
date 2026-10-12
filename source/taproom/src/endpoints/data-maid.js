import * as storage from '../storage.js';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import mime from 'mime-types';
import { getSettingsBackupFilePrefix } from './settings.js';
import { CHAT_BACKUPS_PREFIX } from './chats.js';
import { isPathUnderParent, tryParse } from '../util.js';
import { SETTINGS_FILE } from '../constants.js';
import { chatIdFromPath, notifyChatDeleted } from '../chat-lifecycle.js';
import { FACE_CACHE_PREFIX } from './thumbnails.js';
import { describeUnavailableData } from '../storage-status.js';
import { log, LogClass } from '../logger.js';

const sha256 = str => crypto.createHash('sha256').update(str).digest('hex');

/**
 * @typedef {object} DataMaidRawReport
 * @property {string[]} images - List of loose user images
 * @property {string[]} files - List of loose user files
 * @property {string[]} chats - List of loose character chats
 * @property {string[]} groupChats - List of loose group chats
 * @property {string[]} avatarThumbnails - List of loose avatar thumbnails
 * @property {string[]} backgroundThumbnails - List of loose background thumbnails
 * @property {string[]} personaThumbnails - List of loose persona thumbnails
 * @property {string[]} chatBackups - List of chat backups
 * @property {string[]} settingsBackups - List of settings backups
 */

/**
 * @typedef {object} DataMaidSanitizedRecord - The entry excluding the sensitive paths.
 * @property {string} name - The name of the file.
 * @property {string} hash - The SHA-256 hash of the file path.
 * @property {string} [parent] - The name of the parent directory, if applicable.
 * @property {number} [size] - The size of the file in bytes, if available.
 * @property {number} [mtime] - The last modification time of the file, if available.
 */

/**
 * @typedef {object} DataMaidSanitizedReport - The report containing loose user data.
 * @property {DataMaidSanitizedRecord[]} images - List of sanitized loose user images
 * @property {DataMaidSanitizedRecord[]} files - List of sanitized loose user files
 * @property {DataMaidSanitizedRecord[]} chats - List of sanitized loose character chats
 * @property {DataMaidSanitizedRecord[]} groupChats - List of sanitized loose group chats
 * @property {DataMaidSanitizedRecord[]} avatarThumbnails - List of sanitized loose avatar thumbnails
 * @property {DataMaidSanitizedRecord[]} backgroundThumbnails - List of sanitized loose background thumbnails
 * @property {DataMaidSanitizedRecord[]} personaThumbnails - List of sanitized loose persona thumbnails
 * @property {DataMaidSanitizedRecord[]} chatBackups - List of sanitized chat backups
 * @property {DataMaidSanitizedRecord[]} settingsBackups - List of sanitized settings backups
 */

/**
 * @typedef {object} DataMaidMessage - The chat message object.
 * @property {DataMaidMessageExtra} [extra] - The extra data object.
 * @property {DataMaidChatMetadata} [chat_metadata] - The chat metadata object.
 */

/**
 * @typedef {object} DataMaidFile - The file object.
 * @property {string} url - The file URL
 */

/**
 * @typedef {object} DataMaidMedia - The media object.
 * @property {string} url - The media URL
 */

/**
 * @typedef {object} DataMaidChatMetadata - The chat metadata object.
 * @property {DataMaidFile[]} [attachments] - The array of attachments, if any.
 * @property {string[]} [chat_backgrounds] - The array of chat background image links, if any.
 */

/**
 * @typedef {object} DataMaidMessageExtra - The extra data object.
 * @property {string} [image] - The link to the image, if any - DEPRECATED, use `media` instead.
 * @property {string} [video] - The link to the video, if any - DEPRECATED, use `media` instead.
 * @property {string[]} [image_swipes] - The links to the image swipes, if any - DEPRECATED, use `media` instead.
 * @property {DataMaidMedia[]} [media] - The links to the media, if any.
 * @property {DataMaidFile} [file] - The file object, if any - DEPRECATED, use `files` instead.
 * @property {DataMaidFile[]} [files] - The array of file objects, if any.
 */

/**
 * @typedef {object} DataMaidTokenEntry
 * @property {string} handle - The user's handle or identifier.
 * @property {{path: string, hash: string}[]} paths - The list of file paths and their hashes that can be cleaned up.
 */

/**
 * Thrown when the maid is asked to reason about data it cannot read.
 *
 * Deliberately not a `StorageError`: `storage.isStorageError` is true only for `EUNAVAILABLE`/`EPROVIDER`,
 * which only a LOADED provider raises, and the whole point of this refusal is the case where no provider
 * is loaded at all and therefore nothing throws.
 */
export class DataMaidUnavailableError extends Error {
    /**
     * @param {import('../storage-status.js').StorageState} storageState The provenance answer to send on.
     */
    constructor(storageState) {
        super('Data Maid cannot tell what is orphaned while some of this account\'s data is unreadable.');
        this.storage = storageState;
    }
}

/**
 * Service for detecting and managing loose user data files.
 * Helps identify orphaned files that are no longer referenced by the application.
 */
export class DataMaidService {
    /**
     * @type {Map<string, DataMaidTokenEntry>} Map clean-up tokens to user IDs
     */
    static TOKENS = new Map();

    /**
     * Creates a new DataMaidService instance for a specific user.
     * @param {string} handle - The user's handle.
     * @param {import('../users.js').UserDirectoryList} directories - List of user directories to scan for loose data.
     */
    constructor(handle, directories) {
        this.handle = handle;
        this.directories = directories;
    }

    /**
     * Generates a report of loose user data.
     * @returns {Promise<DataMaidRawReport>} A report containing lists of loose user data.
     */
    async generateReport() {
        this.#assertInputsReadable();

        /** @type {DataMaidRawReport} */
        const report = {
            images: await this.#collectImages(),
            files: await this.#collectFiles(),
            chats: await this.#collectChats(),
            groupChats: await this.#collectGroupChats(),
            avatarThumbnails: await this.#collectAvatarThumbnails(),
            backgroundThumbnails: await this.#collectBackgroundThumbnails(),
            personaThumbnails: await this.#collectPersonaThumbnails(),
            chatBackups: await this.#collectChatBackups(),
            settingsBackups: await this.#collectSettingsBackups(),
        };

        return report;
    }

    /**
     * Refuse to reason about orphans at all when an input the decision rests on cannot be read.
     *
     * 🔴 THE `isStorageError` GUARDS ELSEWHERE IN THIS FILE DO NOT COVER THE CASE THAT MATTERS. They fire
     * when a provider is installed and THROWING. With the provider simply *uninstalled* nothing throws:
     * `owns()` is false for every path, every read falls through to plain `fs`, and `readFile(…, 'utf-8')`
     * on ciphertext comes back as replacement characters. `tryParse` returns undefined, `.filter(Boolean)`
     * drops it, and the collector concludes the chat references nothing — so `knownImages`, `knownFiles`
     * and `knownGroupChats` come back empty and every image, Data Bank file and group chat the user owns
     * is reported loose. `#collectChats` fails differently and worse: it builds its known-folder set from
     * `characters/*.png`, which a filename-encrypting provider left mangled on disk, while chat
     * DIRECTORIES are never mangled — so nothing matches and every chat of every character is condemned.
     *
     * The user is then shown a confident list and a dialog reading "permanently delete", which is
     * `DESIGN_STORAGE_PROVIDER_API.md` §8's "the user is confirming a lie" reached from the uninstall
     * direction instead of the locked one.
     *
     * A per-read guard cannot fix this — `#collectChats` reads no file contents at all. The only honest
     * answer is to refuse the whole report, so this is a precondition rather than a rescue.
     * @throws {DataMaidUnavailableError} When any input is enveloped and unreadable.
     * @returns {void}
     */
    #assertInputsReadable() {
        /**
         * @param {string} directory Directory to list
         * @returns {string[]} Entry names, or nothing if it cannot be listed
         */
        const list = (directory) => {
            try {
                return storage.exists(directory) ? storage.readdir(directory) : [];
            } catch {
                return [];
            }
        };

        /** @type {string[]} */
        const inputs = [path.join(this.directories.root, SETTINGS_FILE)];

        for (const name of list(this.directories.characters)) {
            inputs.push(path.join(this.directories.characters, name));
        }

        for (const name of list(this.directories.groups)) {
            inputs.push(path.join(this.directories.groups, name));
        }

        for (const name of list(this.directories.groupChats)) {
            inputs.push(path.join(this.directories.groupChats, name));
        }

        for (const characterDirectory of list(this.directories.chats)) {
            const directory = path.join(this.directories.chats, characterDirectory);

            for (const name of list(directory)) {
                inputs.push(path.join(directory, name));
            }
        }

        for (const input of inputs) {
            const unavailable = describeUnavailableData(input);

            if (unavailable) {
                throw new DataMaidUnavailableError(unavailable);
            }
        }
    }


    /**
     * Sanitizes a record by hashing the file name and removing sensitive information.
     * Additionally, adds metadata like size and modification time.
     * @param {string} name The file or directory name to sanitize.
     * @param {boolean} withParent If the model should include the parent directory name.
     * @returns {Promise<DataMaidSanitizedRecord>} A sanitized record with the file name, hash, parent directory name, size, and modification time.
     */
    async #sanitizeRecord(name, withParent) {
        const stat = storage.exists(name) ? await storage.stat(name) : null;
        return {
            name: path.basename(name),
            hash: sha256(name),
            parent: withParent ? path.basename(path.dirname(name)) : void 0,
            size: stat?.size,
            mtime: stat?.mtimeMs,
        };
    }

    /**
     * Sanitizes the report by hashing the file paths and removing sensitive information.
     * @param {DataMaidRawReport} report - The raw report containing loose user data.
     * @returns {Promise<DataMaidSanitizedReport>} A sanitized report with sensitive paths removed.
     */
    async sanitizeReport(report) {
        const sanitizedReport = {
            images: await Promise.all(report.images.map(i => this.#sanitizeRecord(i, true))),
            files: await Promise.all(report.files.map(i => this.#sanitizeRecord(i, false))),
            chats: await Promise.all(report.chats.map(i => this.#sanitizeRecord(i, true))),
            groupChats: await Promise.all(report.groupChats.map(i => this.#sanitizeRecord(i, false))),
            avatarThumbnails: await Promise.all(report.avatarThumbnails.map(i => this.#sanitizeRecord(i, false))),
            backgroundThumbnails: await Promise.all(report.backgroundThumbnails.map(i => this.#sanitizeRecord(i, false))),
            personaThumbnails: await Promise.all(report.personaThumbnails.map(i => this.#sanitizeRecord(i, false))),
            chatBackups: await Promise.all(report.chatBackups.map(i => this.#sanitizeRecord(i, false))),
            settingsBackups: await Promise.all(report.settingsBackups.map(i => this.#sanitizeRecord(i, false))),
        };

        return sanitizedReport;
    }

    /**
     * Collects loose user images from the provided directories.
     * Images are considered loose if they exist in the user images directory
     * but are not referenced in any chat messages.
     * @returns {Promise<string[]>} List of paths to loose user images
     */
    async #collectImages() {
        const result = [];

        try {
            const messages = await this.#parseAllChats(x => !!x?.extra?.image || !!x?.extra?.video || Array.isArray(x?.extra?.image_swipes) || Array.isArray(x?.extra?.media));
            const knownImages = new Set();
            for (const message of messages) {
                if (message?.extra?.image) {
                    knownImages.add(message.extra.image);
                }
                if (message?.extra?.video) {
                    knownImages.add(message.extra.video);
                }
                if (Array.isArray(message?.extra?.image_swipes)) {
                    for (const swipe of message.extra.image_swipes) {
                        knownImages.add(swipe);
                    }
                }
                if (Array.isArray(message?.extra?.media)) {
                    for (const media of message.extra.media) {
                        if (media?.url) {
                            knownImages.add(media.url);
                        }
                    }
                }
            }
            const metadata = await this.#parseAllMetadata(x => Array.isArray(x?.chat_backgrounds) && x.chat_backgrounds.length > 0);
            for (const meta of metadata) {
                if (Array.isArray(meta?.chat_backgrounds)) {
                    for (const background of meta.chat_backgrounds) {
                        if (background) {
                            knownImages.add(background);
                        }
                    }
                }
            }
            const knownImageFullPaths = new Set();
            knownImages.forEach(image => {
                if (image.startsWith('http') || image.startsWith('data:')) {
                    return; // Skip URLs and data URIs
                }
                knownImageFullPaths.add(path.normalize(path.join(this.directories.root, image)));
            });
            const images = await storage.readdir(this.directories.userImages, { withFileTypes: true });
            for (const dirent of images) {
                const direntPath = path.join(dirent.parentPath, dirent.name);
                if (dirent.isFile() && !knownImageFullPaths.has(direntPath)) {
                    result.push(direntPath);
                }
                if (dirent.isDirectory()) {
                    const subdirFiles = await storage.readdir(direntPath, { withFileTypes: true });
                    for (const file of subdirFiles) {
                        const subdirFilePath = path.join(direntPath, file.name);
                        if (file.isFile() && !knownImageFullPaths.has(subdirFilePath)) {
                            result.push(subdirFilePath);
                        }
                    }
                }
            }
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to collect loose user images');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error collecting user images:', error);
        }

        return result;
    }

    /**
     * Collects loose user files from the provided directories.
     * Files are considered loose if they exist in the files directory
     * but are not referenced in chat messages, metadata, or settings.
     * @returns {Promise<string[]>} List of paths to loose user files
     */
    async #collectFiles() {
        const result = [];

        try {
            const messages = await this.#parseAllChats(x => !!x?.extra?.file?.url || (Array.isArray(x?.extra?.files) && x.extra.files.length > 0));
            const knownFiles = new Set();
            for (const message of messages) {
                if (message?.extra?.file?.url) {
                    knownFiles.add(message.extra.file.url);
                }
                if (Array.isArray(message?.extra?.files)) {
                    for (const file of message.extra.files) {
                        if (file?.url) {
                            knownFiles.add(file.url);
                        }
                    }
                }
            }
            const metadata = await this.#parseAllMetadata(x => Array.isArray(x?.attachments) && x.attachments.length > 0);
            for (const meta of metadata) {
                if (Array.isArray(meta?.attachments)) {
                    for (const attachment of meta.attachments) {
                        if (attachment?.url) {
                            knownFiles.add(attachment.url);
                        }
                    }
                }
            }
            const pathToSettings = path.join(this.directories.root, SETTINGS_FILE);
            if (storage.exists(pathToSettings)) {
                try {
                    const settingsContent = await storage.readFile(pathToSettings, 'utf-8');
                    const settings = tryParse(settingsContent);
                    if (Array.isArray(settings?.extension_settings?.attachments)) {
                        for (const file of settings.extension_settings.attachments) {
                            if (file?.url) {
                                knownFiles.add(file.url);
                            }
                        }
                    }
                    if (typeof settings?.extension_settings?.character_attachments === 'object') {
                        for (const files of Object.values(settings.extension_settings.character_attachments)) {
                            if (!Array.isArray(files)) {
                                continue;
                            }
                            for (const file of files) {
                                if (file?.url) {
                                    knownFiles.add(file.url);
                                }
                            }
                        }
                    }
                } catch (error) {
                    // An unreadable file is not an empty file. If the storage layer says the data is
                    // there and it cannot serve it, this report is built on sand -- and a data-maid
                    // report built on sand tells the user their files are garbage. Refuse to report.
                    if (storage.isStorageError(error)) {
                        throw error;
                    }

                    log.error(LogClass.NORMAL, '[Data Maid] Failed to read the settings file');
                    log.error(LogClass.SENSITIVE, '[Data Maid] Error reading settings file:', error);
                }
            }
            const knownFileFullPaths = new Set();
            knownFiles.forEach(file => {
                knownFileFullPaths.add(path.normalize(path.join(this.directories.root, file)));
            });
            const files = await storage.readdir(this.directories.files, { withFileTypes: true });
            for (const file of files) {
                const filePath = path.join(this.directories.files, file.name);
                if (file.isFile() && !knownFileFullPaths.has(filePath)) {
                    result.push(filePath);
                }
            }
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to collect loose user files');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error collecting user files:', error);
        }

        return result;
    }

    /**
     * Collects loose character chats from the provided directories.
     * Chat folders are considered loose if they don't have corresponding character files.
     * @returns {Promise<string[]>} List of paths to loose character chats
     */
    async #collectChats() {
        const result = [];

        try {
            const knownChatFolders = new Set();
            const characters = await storage.readdir(this.directories.characters, { withFileTypes: true });
            for (const file of characters) {
                if (file.isFile() && path.parse(file.name).ext === '.png') {
                    knownChatFolders.add(file.name.replace('.png', ''));
                }
            }
            const chatFolders = await storage.readdir(this.directories.chats, { withFileTypes: true });
            for (const folder of chatFolders) {
                if (folder.isDirectory() && !knownChatFolders.has(folder.name)) {
                    const chatFiles = await storage.readdir(path.join(this.directories.chats, folder.name), { withFileTypes: true });
                    for (const file of chatFiles) {
                        if (file.isFile() && path.parse(file.name).ext === '.jsonl') {
                            result.push(path.join(this.directories.chats, folder.name, file.name));
                        }
                    }
                }
            }
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to collect character chats');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error collecting character chats:', error);
        }

        return result;
    }

    /**
     * Collects loose group chats from the provided directories.
     * Group chat files are considered loose if they're not referenced by any group definition.
     * @returns {Promise<string[]>} List of paths to loose group chats
     */
    async #collectGroupChats() {
        const result = [];

        try {
            const groups = await storage.readdir(this.directories.groups, { withFileTypes: true });
            const knownGroupChats = new Set();
            for (const file of groups) {
                if (file.isFile() && path.parse(file.name).ext === '.json') {
                    try {
                        const pathToFile = path.join(this.directories.groups, file.name);
                        const fileContent = await storage.readFile(pathToFile, 'utf-8');
                        const groupData = tryParse(fileContent);
                        if (groupData?.chat_id) {
                            knownGroupChats.add(groupData.chat_id);
                        }
                        if (Array.isArray(groupData?.chats)) {
                            for (const chat of groupData.chats) {
                                knownGroupChats.add(chat);
                            }
                        }
                    } catch (error) {
                        // An unreadable file is not an empty file. If the storage layer says the data is
                        // there and it cannot serve it, this report is built on sand -- and a data-maid
                        // report built on sand tells the user their files are garbage. Refuse to report.
                        if (storage.isStorageError(error)) {
                            throw error;
                        }

                        log.error(LogClass.NORMAL, '[Data Maid] Failed to parse a group definition file');
                        log.error(LogClass.SENSITIVE, `[Data Maid] Error parsing group chat file ${file.name}:`, error);
                    }
                }
            }
            const groupChats = await storage.readdir(this.directories.groupChats, { withFileTypes: true });
            for (const file of groupChats) {
                if (file.isFile() && path.parse(file.name).ext === '.jsonl') {
                    if (!knownGroupChats.has(path.parse(file.name).name)) {
                        result.push(path.join(this.directories.groupChats, file.name));
                    }
                }
            }
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to collect group chats');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error collecting group chats:', error);
        }

        return result;
    }

    /**
     * Collects loose avatar thumbnails from the provided directories.
     * @returns {Promise<string[]>} List of paths to loose avatar thumbnails
     */
    async #collectAvatarThumbnails() {
        const result = [];

        try {
            const knownAvatars = new Set();
            const avatars = await storage.readdir(this.directories.characters, { withFileTypes: true });
            for (const file of avatars) {
                if (file.isFile()) {
                    knownAvatars.add(file.name);
                }
            }
            const avatarThumbnails = await storage.readdir(this.directories.thumbnailsAvatar, { withFileTypes: true });
            for (const file of avatarThumbnails) {
                if (file.isFile() && !knownAvatars.has(file.name)) {
                    result.push(path.join(this.directories.thumbnailsAvatar, file.name));
                }
            }

            // Square (round-avatar) thumbnails are cached under a focus-key prefix, so the name on
            // disk never matches the character's. Strip it before deciding what is an orphan —
            // comparing raw names here would condemn every live face thumbnail in the folder.
            const faceThumbnails = await storage.readdir(this.directories.thumbnailsFace, { withFileTypes: true });
            for (const file of faceThumbnails) {
                if (file.isFile() && !knownAvatars.has(file.name.replace(FACE_CACHE_PREFIX, ''))) {
                    result.push(path.join(this.directories.thumbnailsFace, file.name));
                }
            }
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to collect avatar thumbnails');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error collecting avatar thumbnails:', error);
        }

        return result;
    }

    /**
     * Collects loose background thumbnails from the provided directories.
     * @returns {Promise<string[]>} List of paths to loose background thumbnails
     */
    async #collectBackgroundThumbnails() {
        const result = [];

        try {
            const knownBackgrounds = new Set();
            const backgrounds = await storage.readdir(this.directories.backgrounds, { withFileTypes: true });
            for (const file of backgrounds) {
                if (file.isFile()) {
                    knownBackgrounds.add(file.name);
                }
            }
            const backgroundThumbnails = await storage.readdir(this.directories.thumbnailsBg, { withFileTypes: true });
            for (const file of backgroundThumbnails) {
                if (file.isFile() && !knownBackgrounds.has(file.name)) {
                    result.push(path.join(this.directories.thumbnailsBg, file.name));
                }
            }
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to collect background thumbnails');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error collecting background thumbnails:', error);
        }

        return result;
    }

    /**
     * Collects loose persona thumbnails from the provided directories.
     * @returns {Promise<string[]>} List of paths to loose persona thumbnails
     */
    async #collectPersonaThumbnails() {
        const result = [];

        try {
            const knownPersonas = new Set();
            const personas = await storage.readdir(this.directories.avatars, { withFileTypes: true });
            for (const file of personas) {
                if (file.isFile()) {
                    knownPersonas.add(file.name);
                }
            }
            const personaThumbnails = await storage.readdir(this.directories.thumbnailsPersona, { withFileTypes: true });
            for (const file of personaThumbnails) {
                if (file.isFile() && !knownPersonas.has(file.name)) {
                    result.push(path.join(this.directories.thumbnailsPersona, file.name));
                }
            }

            // See #collectAvatarThumbnails: the focus-key prefix has to come off before comparing.
            const personaFaceThumbnails = await storage.readdir(this.directories.thumbnailsPersonaFace, { withFileTypes: true });
            for (const file of personaFaceThumbnails) {
                if (file.isFile() && !knownPersonas.has(file.name.replace(FACE_CACHE_PREFIX, ''))) {
                    result.push(path.join(this.directories.thumbnailsPersonaFace, file.name));
                }
            }
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to collect persona thumbnails');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error collecting persona thumbnails:', error);
        }

        return result;
    }

    /**
     * Collects chat backups from the provided directories.
     * @returns {Promise<string[]>} List of paths to chat backups
     */
    async #collectChatBackups() {
        const result = [];

        try {
            const prefix = CHAT_BACKUPS_PREFIX;
            const backups = await storage.readdir(this.directories.backups, { withFileTypes: true });
            for (const file of backups) {
                if (file.isFile() && file.name.startsWith(prefix)) {
                    result.push(path.join(this.directories.backups, file.name));
                }
            }
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to collect chat backups');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error collecting chat backups:', error);
        }

        return result;
    }

    /**
     * Collects settings backups from the provided directories.
     * @returns {Promise<string[]>} List of paths to settings backups
     */
    async #collectSettingsBackups() {
        const result = [];

        try {
            const prefix = getSettingsBackupFilePrefix(this.handle);
            const backups = await storage.readdir(this.directories.backups, { withFileTypes: true });
            for (const file of backups) {
                if (file.isFile() && file.name.startsWith(prefix)) {
                    result.push(path.join(this.directories.backups, file.name));
                }
            }
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to collect settings backups');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error collecting settings backups:', error);
        }

        return result;
    }

    /**
     * Parses all chat files and returns an array of chat messages.
     * Searches both individual character chats and group chats.
     * @param {function(DataMaidMessage): boolean} filterFn - Filter function to apply to each message.
     * @returns {Promise<DataMaidMessage[]>} Array of chat messages
     */
    async #parseAllChats(filterFn) {
        try {
            const allChats = [];

            const groupChats = await storage.readdir(this.directories.groupChats, { withFileTypes: true });
            for (const file of groupChats) {
                if (file.isFile() && path.parse(file.name).ext === '.jsonl') {
                    const chatMessages = await this.#parseChatFile(path.join(this.directories.groupChats, file.name));
                    allChats.push(...chatMessages.filter(filterFn));
                }
            }

            const chatDirectories = await storage.readdir(this.directories.chats, { withFileTypes: true });
            for (const directory of chatDirectories) {
                if (directory.isDirectory()) {
                    const chatFiles = await storage.readdir(path.join(this.directories.chats, directory.name), { withFileTypes: true });
                    for (const file of chatFiles) {
                        if (file.isFile() && path.parse(file.name).ext === '.jsonl') {
                            const chatMessages = await this.#parseChatFile(path.join(this.directories.chats, directory.name, file.name));
                            allChats.push(...chatMessages.filter(filterFn));
                        }
                    }
                }
            }

            return allChats;
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to parse chat files while building the report');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error parsing chats:', error);
            return [];
        }
    }

    /**
     * Parses all metadata from chat files and group definitions.
     * Extracts metadata from both active and historical chat data.
     * @param {function(DataMaidChatMetadata): boolean} filterFn - Filter function to apply to each metadata entry.
     * @returns {Promise<DataMaidChatMetadata[]>} Parsed chat metadata as an array.
     */
    async #parseAllMetadata(filterFn) {
        try {
            const allMetadata = [];

            const groups = await storage.readdir(this.directories.groups, { withFileTypes: true });
            for (const file of groups) {
                if (file.isFile() && path.parse(file.name).ext === '.json') {
                    try {
                        const pathToFile = path.join(this.directories.groups, file.name);
                        const fileContent = await storage.readFile(pathToFile, 'utf-8');
                        const groupData = tryParse(fileContent);
                        if (groupData?.chat_metadata && filterFn(groupData.chat_metadata)) {
                            log.warn(LogClass.NORMAL, 'Found group chat metadata in group definition - this is deprecated behavior.');
                            allMetadata.push(groupData.chat_metadata);
                        }
                        if (groupData?.past_metadata) {
                            log.warn(LogClass.NORMAL, 'Found group past chat metadata in group definition - this is deprecated behavior.');
                            allMetadata.push(...Object.values(groupData.past_metadata).filter(filterFn));
                        }
                    } catch (error) {
                        // An unreadable file is not an empty file. If the storage layer says the data is
                        // there and it cannot serve it, this report is built on sand -- and a data-maid
                        // report built on sand tells the user their files are garbage. Refuse to report.
                        if (storage.isStorageError(error)) {
                            throw error;
                        }

                        log.error(LogClass.NORMAL, '[Data Maid] Failed to parse a group definition file');
                        log.error(LogClass.SENSITIVE, `[Data Maid] Error parsing group chat file ${file.name}:`, error);
                    }
                }
            }

            const groupChats = await storage.readdir(this.directories.groupChats, { withFileTypes: true });
            for (const file of groupChats) {
                if (file.isFile() && path.parse(file.name).ext === '.jsonl') {
                    const chatMessages = await this.#parseChatFile(path.join(this.directories.groupChats, file.name));
                    const chatMetadata = chatMessages?.[0]?.chat_metadata;
                    if (chatMetadata && filterFn(chatMetadata)) {
                        allMetadata.push(chatMetadata);
                    }
                }
            }

            const chatDirectories = await storage.readdir(this.directories.chats, { withFileTypes: true });
            for (const directory of chatDirectories) {
                if (directory.isDirectory()) {
                    const chatFiles = await storage.readdir(path.join(this.directories.chats, directory.name), { withFileTypes: true });
                    for (const file of chatFiles) {
                        if (file.isFile() && path.parse(file.name).ext === '.jsonl') {
                            const chatMessages = await this.#parseChatFile(path.join(this.directories.chats, directory.name, file.name));
                            const chatMetadata = chatMessages?.[0]?.chat_metadata;
                            if (chatMetadata && filterFn(chatMetadata)) {
                                allMetadata.push(chatMetadata);
                            }
                        }
                    }
                }
            }

            return allMetadata;
        } catch (error) {
            // An unreadable file is not an empty file. If the storage layer says the data is
            // there and it cannot serve it, this report is built on sand -- and a data-maid
            // report built on sand tells the user their files are garbage. Refuse to report.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to parse chat metadata while building the report');
            log.error(LogClass.SENSITIVE, '[Data Maid] Error parsing chats:', error);
            return [];
        }
    }

    /**
     * Parses a single chat file and returns an array of chat messages.
     * Each line in the JSONL file represents one message.
     * @param {string} filePath Path to the chat file to parse.
     * @returns {Promise<DataMaidMessage[]>} Parsed chat messages as an array.
     */
    async #parseChatFile(filePath) {
        try {
            const content = await storage.readFile(filePath, 'utf-8');
            const chatData = content.split('\n').map(tryParse).filter(Boolean);
            return chatData;
        } catch (error) {
            // 🔴 THIS RETURNED [] ON ANY ERROR, AND IT IS THE MOST DANGEROUS LINE IN SILLYTAVERN.
            //
            // data-maid decides which of the user's images and Data Bank files are "loose" by cross-
            // referencing them against the chats that mention them. An unreadable chat that comes back
            // as an EMPTY LIST OF MESSAGES does not look like a failure — it looks like a chat that
            // mentions nothing. Enough of those and the report concludes that every image the user owns
            // is an orphan, presents them as safe to delete, and POST /api/data-maid/delete unlinks the
            // lot. The deletion is user-confirmed, which sounds like a safeguard right up until you
            // notice THE USER IS CONFIRMING A LIE.
            //
            // An unreadable chat is not an empty chat. If the storage layer says the data is there and
            // it cannot serve it, the only honest report is NO REPORT.
            if (storage.isStorageError(error)) {
                throw error;
            }

            log.error(LogClass.NORMAL, '[Data Maid] Failed to read a chat file');
            log.error(LogClass.SENSITIVE, `[Data Maid] Error reading chat file ${filePath}:`, error);
            return [];
        }
    }

    /**
     * Generates a unique token for the user to clean up their data.
     * Replaces any existing token for the same user.
     * @param {string} handle - The user's handle or identifier.
     * @param {DataMaidRawReport} report - The report containing loose user data.
     * @returns {string} A unique token.
     */
    static generateToken(handle, report) {
        // Remove any existing token for this user
        for (const [token, entry] of this.TOKENS.entries()) {
            if (entry.handle === handle) {
                this.TOKENS.delete(token);
            }
        }

        const token = crypto.randomBytes(32).toString('hex');
        const tokenEntry = {
            handle,
            paths: Object.values(report).filter(v => Array.isArray(v)).flat().map(x => ({ path: x, hash: sha256(x) })),
        };
        this.TOKENS.set(token, tokenEntry);
        return token;
    }
}

export const router = express.Router();

router.post('/report', async (req, res) => {
    try {
        if (!req.user || !req.user.directories) {
            return res.sendStatus(403);
        }

        const dataMaid = new DataMaidService(req.user.profile.handle, req.user.directories);
        const rawReport = await dataMaid.generateReport();

        const report = await dataMaid.sanitizeReport(rawReport);
        const token = DataMaidService.generateToken(req.user.profile.handle, rawReport);

        return res.json({ report, token });
    } catch (error) {
        // 409 rather than the bare 500 below, so the client can say WHICH provider is missing instead of
        // "something went wrong" — the §9.1 rule 2 answer, the same one backups already gives.
        if (error instanceof DataMaidUnavailableError) {
            log.warn(LogClass.NORMAL, '[Data Maid] Refused to report: some of this account\'s data is unreadable');
            return res.status(409).json({ storage: error.storage });
        }
        log.error(LogClass.NORMAL, '[Data Maid] Failed to generate the data maid report');
        log.error(LogClass.SENSITIVE, '[Data Maid] Error generating data maid report:', error);
        return res.sendStatus(500);
    }
});

router.post('/finalize', async (req, res) => {
    try {
        if (!req.user || !req.user.directories) {
            return res.sendStatus(403);
        }

        if (!req.body.token) {
            return res.sendStatus(400);
        }

        const token = req.body.token.toString();
        if (!DataMaidService.TOKENS.has(token)) {
            return res.sendStatus(403);
        }

        const tokenEntry = DataMaidService.TOKENS.get(token);
        if (!tokenEntry || tokenEntry.handle !== req.user.profile.handle) {
            return res.sendStatus(403);
        }

        // Remove the token after finalization
        DataMaidService.TOKENS.delete(token);
        return res.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, '[Data Maid] Failed to finalize the cleanup token');
        log.error(LogClass.SENSITIVE, '[Data Maid] Error finalizing the token:', error);
        return res.sendStatus(500);
    }
});

router.get('/view', async (req, res) => {
    try {
        if (!req.user || !req.user.directories) {
            return res.sendStatus(403);
        }

        if (!req.query.token || !req.query.hash) {
            return res.sendStatus(400);
        }

        const token = req.query.token.toString();
        const hash = req.query.hash.toString();

        if (!DataMaidService.TOKENS.has(token)) {
            return res.sendStatus(403);
        }

        const tokenEntry = DataMaidService.TOKENS.get(token);
        if (!tokenEntry || tokenEntry.handle !== req.user.profile.handle) {
            return res.sendStatus(403);
        }

        const fileEntry = tokenEntry.paths.find(entry => entry.hash === hash);
        if (!fileEntry) {
            return res.sendStatus(404);
        }

        if (!isPathUnderParent(req.user.directories.root, fileEntry.path)) {
            log.warn(LogClass.SENSITIVE, '[Data Maid] Attempted access to a file outside of the user directory:', fileEntry.path);
            return res.sendStatus(403);
        }

        const pathToFile = fileEntry.path;
        const fileExists = storage.exists(pathToFile);

        if (!fileExists) {
            return res.sendStatus(404);
        }

        // Handing back the raw envelope under a MIME type guessed from the extension is not a preview, it
        // is ciphertext announced as a PNG. §9.1 rule 2 says a read of unreadable bytes refuses and names
        // what it needs, rather than serving something the viewer will render as garbage.
        const unavailable = describeUnavailableData(pathToFile);

        if (unavailable) {
            return res.status(409).json({ storage: unavailable });
        }

        const fileBuffer = await storage.readFile(pathToFile);
        const mimeType = mime.lookup(pathToFile) || 'text/plain';
        res.setHeader('Content-Type', mimeType);
        return res.send(fileBuffer);
    } catch (error) {
        log.error(LogClass.NORMAL, '[Data Maid] Failed to serve a file for viewing');
        log.error(LogClass.SENSITIVE, '[Data Maid] Error viewing file:', error);
        return res.sendStatus(500);
    }
});

router.post('/delete', async (req, res) => {
    try {
        if (!req.user || !req.user.directories) {
            return res.sendStatus(403);
        }

        const { token, hashes } = req.body;
        if (!token || !Array.isArray(hashes) || hashes.length === 0) {
            return res.sendStatus(400);
        }

        if (!DataMaidService.TOKENS.has(token)) {
            return res.sendStatus(403);
        }

        const tokenEntry = DataMaidService.TOKENS.get(token);
        if (!tokenEntry || tokenEntry.handle !== req.user.profile.handle) {
            return res.sendStatus(403);
        }

        for (const hash of hashes) {
            const fileEntry = tokenEntry.paths.find(entry => entry.hash === hash);
            if (!fileEntry) {
                continue;
            }

            if (!isPathUnderParent(req.user.directories.root, fileEntry.path)) {
                log.warn(LogClass.SENSITIVE, '[Data Maid] Attempted deletion of a file outside of the user directory:', fileEntry.path);
                continue;
            }

            const pathToFile = fileEntry.path;
            const fileExists = storage.exists(pathToFile);

            if (!fileExists) {
                continue;
            }

            await storage.unlink(pathToFile);

            // §24: THE FIFTH DELETION PATH, AND IT WAS NOT ON THE LIST. `#collectChats` and
            // `#collectGroupChats` hand this route real chat files — the ones whose character card or group
            // definition has gone — and unlinking them told a memory plugin nothing at all. Its rows for
            // those chats then persist for the life of the install with no collector behind them, and
            // because chat ids are REUSABLE (§24.1) a later chat that takes the same id inherits the stale
            // high-water mark and starts life already "extracted", ingesting nothing.
            //
            // After the unlink, so a plugin is never told a chat is gone while it is still on disk.
            const isChatFile = pathToFile.toLowerCase().endsWith('.jsonl')
                && (isPathUnderParent(req.user.directories.chats, pathToFile) || isPathUnderParent(req.user.directories.groupChats, pathToFile));

            if (isChatFile) {
                await notifyChatDeleted(req.user.profile.handle, chatIdFromPath(pathToFile));
            }
        }

        return res.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, '[Data Maid] Failed to delete the requested files');
        log.error(LogClass.SENSITIVE, '[Data Maid] Error deleting files:', error);
        return res.sendStatus(500);
    }
});
