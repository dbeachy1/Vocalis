import path from 'node:path';

import express from 'express';
import _ from 'lodash';
import * as storage from '../storage.js';
import bytes from 'bytes';

import { SETTINGS_FILE } from '../constants.js';
import { describeUnavailableData } from '../storage-status.js';
import { getConfigValue, generateTimestamp, removeOldBackups } from '../util.js';
import { getAllUserHandles, getUserDirectories, getDirectoriesHandle } from '../users.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { log, LogClass } from '../logger.js';

const ENABLE_EXTENSIONS = !!getConfigValue('extensions.enabled', true, 'boolean');
const ENABLE_EXTENSIONS_AUTO_UPDATE = !!getConfigValue('extensions.autoUpdate', true, 'boolean');
const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');
const ENABLE_REQUEST_COMPRESSION = !!getConfigValue('performance.requestCompression.enabled', false, 'boolean');
const REQUEST_COMPRESSION_MIN = bytes.parse(getConfigValue('performance.requestCompression.minPayloadSize', '256kb'));
const REQUEST_COMPRESSION_MAX = bytes.parse(getConfigValue('performance.requestCompression.maxPayloadSize', '8mb'));
const REQUEST_COMPRESSION_TIMEOUT = Number(getConfigValue('performance.requestCompression.timeout', 3000, 'number'));

// 10 minutes
const AUTOSAVE_INTERVAL = 10 * 60 * 1000;

/**
 * Map of functions to trigger settings autosave for a user.
 * @type {Map<string, function>}
 */
const AUTOSAVE_FUNCTIONS = new Map();

/**
 * Backs up settings on the autosave timer, tolerating storage that has become unavailable.
 *
 * The throttle below fires on a trailing edge, up to AUTOSAVE_INTERVAL after the request that armed it.
 * A storage provider may have become unavailable in the meantime -- an encrypted provider locks a user's
 * storage when they log out or go idle, which is routine, not a failure. Unlike every other caller of
 * backupUserSettings, a timer callback has no error boundary above it: an escaping StorageError is an
 * unhandled exception and takes the process down. So this one skips the backup instead. The next backup
 * happens whenever the user is active again, which is the only time the data can be read anyway.
 * @param {string} handle User handle
 * @returns {void}
 */
function autoSaveIfAvailable(handle) {
    try {
        backupUserSettings(handle, true);
    } catch (error) {
        if (storage.isStorageError(error)) {
            return;
        }

        throw error;
    }
}

/**
 * Triggers autosave for a user every 10 minutes.
 * @param {string} handle User handle
 * @returns {void}
 */
function triggerAutoSave(handle) {
    if (!AUTOSAVE_FUNCTIONS.has(handle)) {
        const throttledAutoSave = _.throttle(() => autoSaveIfAvailable(handle), AUTOSAVE_INTERVAL);
        AUTOSAVE_FUNCTIONS.set(handle, throttledAutoSave);
    }

    const functionToCall = AUTOSAVE_FUNCTIONS.get(handle);
    if (functionToCall && typeof functionToCall === 'function') {
        functionToCall();
    }
}

/**
 * Reads and parses files from a directory.
 * @param {string} directoryPath Path to the directory
 * @param {string} fileExtension File extension
 * @returns {Array} Parsed files
 */
function readAndParseFromDirectory(directoryPath, fileExtension = '.json') {
    const files = storage
        .readdir(directoryPath)
        .filter(x => path.parse(x).ext == fileExtension)
        .sort();

    const parsedFiles = [];

    files.forEach(item => {
        try {
            const file = storage.readFileSync(path.join(directoryPath, item), 'utf-8');
            parsedFiles.push(fileExtension == '.json' ? JSON.parse(file) : file);
        } catch {
            // skip
        }
    });

    return parsedFiles;
}

/**
 * Gets a sort function for sorting strings.
 * @param {*} _
 * @returns {(a: string, b: string) => number} Sort function
 */
function sortByName(_) {
    return (a, b) => a.localeCompare(b);
}

/**
 * Gets backup file prefix for user settings.
 * @param {string} handle User handle
 * @returns {string} File prefix
 */
export function getSettingsBackupFilePrefix(handle) {
    return `settings_${handle}_`;
}

function readPresetsFromDirectory(directoryPath, options = {}) {
    const {
        sortFunction,
        removeFileExtension = false,
        fileExtension = '.json',
    } = options;

    const files = storage.readdir(directoryPath).sort(sortFunction).filter(x => path.parse(x).ext == fileExtension);
    const fileContents = [];
    const fileNames = [];

    files.forEach(item => {
        try {
            const file = storage.readFileSync(path.join(directoryPath, item), 'utf8');
            JSON.parse(file);
            fileContents.push(file);
            fileNames.push(removeFileExtension ? item.replace(/\.[^/.]+$/, '') : item);
        } catch {
            // skip
            log.warn(LogClass.SENSITIVE, `${item} is not a valid JSON`);
        }
    });

    return { fileContents, fileNames };
}

/**
 * Backs up the settings of the given users.
 * @param {import('../users.js').UserDirectoryList[]} [directoriesList] Users to back up. Defaults to all.
 * @returns {Promise<void>}
 */
async function backupSettings(directoriesList) {
    try {
        const userHandles = directoriesList
            ? directoriesList.map(getDirectoriesHandle)
            : await getAllUserHandles();

        for (const handle of userHandles) {
            backupUserSettings(handle, true);
        }
    } catch (err) {
        log.error(LogClass.NORMAL, 'Could not backup settings file');
        log.error(LogClass.SENSITIVE, 'Could not backup settings file', err);
    }
}

/**
 * Makes a backup of the user's settings file.
 * @param {string} handle User handle
 * @param {boolean} preventDuplicates Prevent duplicate backups
 * @returns {void}
 */
function backupUserSettings(handle, preventDuplicates) {
    const userDirectories = getUserDirectories(handle);

    if (!storage.exists(userDirectories.root)) {
        return;
    }

    const backupFile = path.join(userDirectories.backups, `${getSettingsBackupFilePrefix(handle)}${generateTimestamp()}.json`);
    const sourceFile = path.join(userDirectories.root, SETTINGS_FILE);

    if (preventDuplicates && isDuplicateBackup(handle, sourceFile)) {
        return;
    }

    if (!storage.exists(sourceFile)) {
        return;
    }

    storage.copyFile(sourceFile, backupFile);
    removeOldBackups(userDirectories.backups, `settings_${handle}`);
}

/**
 * Checks if the backup would be a duplicate.
 * @param {string} handle User handle
 * @param {string} sourceFile Source file path
 * @returns {boolean} True if the backup is a duplicate
 */
function isDuplicateBackup(handle, sourceFile) {
    const latestBackup = getLatestBackup(handle);
    if (!latestBackup) {
        return false;
    }
    return areFilesEqual(latestBackup, sourceFile);
}

/**
 * Returns true if the two files are equal.
 * @param {string} file1 File path
 * @param {string} file2 File path
 */
function areFilesEqual(file1, file2) {
    if (!storage.exists(file1) || !storage.exists(file2)) {
        return false;
    }

    const content1 = storage.readFileSync(file1);
    const content2 = storage.readFileSync(file2);
    return content1.toString() === content2.toString();
}

/**
 * Gets the latest backup file for a user.
 * @param {string} handle User handle
 * @returns {string|null} Latest backup file. Null if no backup exists.
 */
function getLatestBackup(handle) {
    const userDirectories = getUserDirectories(handle);
    const backupFiles = storage.readdir(userDirectories.backups)
        .filter(x => x.startsWith(getSettingsBackupFilePrefix(handle)))
        .map(x => ({ name: x, ctime: storage.stat(path.join(userDirectories.backups, x)).ctimeMs }));
    const latestBackup = backupFiles.sort((a, b) => b.ctime - a.ctime)[0]?.name;
    if (!latestBackup) {
        return null;
    }
    return path.join(userDirectories.backups, latestBackup);
}

export const router = express.Router();

router.post('/save', function (request, response) {
    try {
        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
        storage.writeFileSync(pathToSettings, JSON.stringify(request.body, null, 4), 'utf8');
        triggerAutoSave(request.user.profile.handle);
        response.send({ result: 'ok' });
    } catch (err) {
        log.error(LogClass.NORMAL, 'Failed to save settings');
        log.error(LogClass.SENSITIVE, err);

        // 🔴 A FAILED WRITE MUST NOT ANSWER 200. `response.send(object)` delegates to `res.json` and never
        // touches the status line, so the client's only check — `result.ok` — read a lost save as a
        // successful one and the "Settings could not be saved" toast never fired. The body leaked an
        // absolute path too: `StorageError` and Node's own fs errors assign `code`/`path` as plain
        // properties, so they are own-enumerable and survive `JSON.stringify`. Matches `/get` below.
        response.sendStatus(500);
    }
});

// Wintermute's code
router.post('/get', (request, response) => {
    let settings;
    const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);

    try {
        settings = storage.readFileSync(pathToSettings, 'utf8');
    } catch (e) {
        // 🪪 §7 surface 4, and the one whose silent version costs the most. A LOCKED provider throws here.
        const locked = describeUnavailableData(pathToSettings);
        return locked ? response.status(409).send({ storage: locked }) : response.sendStatus(500);
    }

    // 🔴 …AND AN UNINSTALLED ONE DOES NOT THROW AT ALL. With no provider registered the read is plain `fs`,
    // so it SUCCEEDS and hands back an envelope, which this endpoint then sent on as `settings` — a string
    // the client feeds straight to `JSON.parse`. Every settings this user has ever chosen, one throw away
    // from the client deciding it has no settings and saving its defaults over the file.
    //
    // Refuse instead, and say which plugin. `settings: null` would be the more polite answer and the wrong
    // one: "no settings" is precisely the state that invites the client to write fresh ones.
    const unavailable = describeUnavailableData(pathToSettings);

    if (unavailable) {
        return response.status(409).send({ storage: unavailable });
    }

    // NovelAI Settings
    const { fileContents: novelai_settings, fileNames: novelai_setting_names }
        = readPresetsFromDirectory(request.user.directories.novelAI_Settings, {
            sortFunction: sortByName(request.user.directories.novelAI_Settings),
            removeFileExtension: true,
        });

    // OpenAI Settings
    const { fileContents: openai_settings, fileNames: openai_setting_names }
        = readPresetsFromDirectory(request.user.directories.openAI_Settings, {
            sortFunction: sortByName(request.user.directories.openAI_Settings), removeFileExtension: true,
        });

    // TextGenerationWebUI Settings
    const { fileContents: textgenerationwebui_presets, fileNames: textgenerationwebui_preset_names }
        = readPresetsFromDirectory(request.user.directories.textGen_Settings, {
            sortFunction: sortByName(request.user.directories.textGen_Settings), removeFileExtension: true,
        });

    //Kobold
    const { fileContents: koboldai_settings, fileNames: koboldai_setting_names }
        = readPresetsFromDirectory(request.user.directories.koboldAI_Settings, {
            sortFunction: sortByName(request.user.directories.koboldAI_Settings), removeFileExtension: true,
        });

    const worldFiles = storage
        .readdir(request.user.directories.worlds)
        .filter(file => path.extname(file).toLowerCase() === '.json')
        .sort((a, b) => a.localeCompare(b));
    const world_names = worldFiles.map(item => path.parse(item).name);

    const themes = readAndParseFromDirectory(request.user.directories.themes);
    const movingUIPresets = readAndParseFromDirectory(request.user.directories.movingUI);
    const quickReplyPresets = readAndParseFromDirectory(request.user.directories.quickreplies);

    const instruct = readAndParseFromDirectory(request.user.directories.instruct);
    const context = readAndParseFromDirectory(request.user.directories.context);
    const sysprompt = readAndParseFromDirectory(request.user.directories.sysprompt);
    const reasoning = readAndParseFromDirectory(request.user.directories.reasoning);

    response.send({
        settings,
        koboldai_settings,
        koboldai_setting_names,
        world_names,
        novelai_settings,
        novelai_setting_names,
        openai_settings,
        openai_setting_names,
        textgenerationwebui_presets,
        textgenerationwebui_preset_names,
        themes,
        movingUIPresets,
        quickReplyPresets,
        instruct,
        context,
        sysprompt,
        reasoning,
        enable_extensions: ENABLE_EXTENSIONS,
        enable_extensions_auto_update: ENABLE_EXTENSIONS_AUTO_UPDATE,
        enable_accounts: ENABLE_ACCOUNTS,
        request_compression: {
            enabled: ENABLE_REQUEST_COMPRESSION,
            minPayloadSize: REQUEST_COMPRESSION_MIN || 0,
            maxPayloadSize: REQUEST_COMPRESSION_MAX || 0,
            timeout: REQUEST_COMPRESSION_TIMEOUT || 0,
        },
    });
});

router.post('/get-snapshots', async (request, response) => {
    try {
        const snapshots = storage.readdir(request.user.directories.backups);
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);
        const userSnapshots = snapshots.filter(x => x.startsWith(userFilesPattern));

        const result = userSnapshots.map(x => {
            const stat = storage.stat(path.join(request.user.directories.backups, x));
            return { date: stat.ctimeMs, name: x, size: stat.size };
        });

        response.json(result);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to list settings snapshots');
        log.error(LogClass.SENSITIVE, error);
        response.sendStatus(500);
    }
});

router.post('/load-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!storage.exists(snapshotPath)) {
            return response.sendStatus(404);
        }

        const content = storage.readFileSync(snapshotPath, 'utf8');

        response.send(content);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to read settings snapshot');
        log.error(LogClass.SENSITIVE, error);
        response.sendStatus(500);
    }
});

router.post('/make-snapshot', async (request, response) => {
    try {
        backupUserSettings(request.user.profile.handle, false);
        response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to make a settings snapshot');
        log.error(LogClass.SENSITIVE, error);
        response.sendStatus(500);
    }
});

router.post('/restore-snapshot', getFileNameValidationFunction('name'), async (request, response) => {
    try {
        const userFilesPattern = getSettingsBackupFilePrefix(request.user.profile.handle);

        if (!request.body.name || !request.body.name.startsWith(userFilesPattern)) {
            return response.status(400).send({ error: 'Invalid snapshot name' });
        }

        const snapshotName = request.body.name;
        const snapshotPath = path.join(request.user.directories.backups, snapshotName);

        if (!storage.exists(snapshotPath)) {
            return response.sendStatus(404);
        }

        const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);

        // 🔴 DO NOT DELETE THE LIVE SETTINGS BEFORE THE REPLACEMENT IS IN HAND. `copyFile` overwrites, so
        // the `rm` that used to stand here bought nothing and cost everything: the delete needs no key and
        // succeeds, then the copy throws — an unavailable provider, a snapshot enveloped by one that is
        // gone, a version skew — and the user's live settings are simply GONE. The 500 is the honest part;
        // the next `/get` sees ENOENT and the client writes fresh defaults over the hole. Restoring a
        // snapshot is what somebody does when something has ALREADY gone wrong, so it is the last operation
        // that should be able to make things worse. A failed copy now leaves the original exactly as it was.
        storage.copyFile(snapshotPath, pathToSettings);

        response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to restore settings snapshot');
        log.error(LogClass.SENSITIVE, error);
        response.sendStatus(500);
    }
});

/**
 * Initializes the settings endpoint
 */
/**
 * Initializes the settings subsystem.
 * @param {import('../users.js').UserDirectoryList[]} [directoriesList] Users whose storage is available
 * @returns {Promise<void>}
 */
export async function init(directoriesList) {
    if (directoriesList) {
        seedVocalisBrowserUrl(directoriesList, process.env.VOCALIS_BROWSER_URL);
    }
    await backupSettings(directoriesList);
}

/**
 * Seeds the configured browser-reachable Vocalis URL into a user's protected settings file only when the
 * extension has no URL value yet. An explicit empty value is a user choice and is preserved.
 * @param {import('../users.js').UserDirectoryList[]} directoriesList Users whose storage is available
 * @param {string|undefined} configuredUrl The nonsecret deployment URL passed through the environment
 * @returns {void}
 */
function seedVocalisBrowserUrl(directoriesList, configuredUrl) {
    const browserUrl = configuredUrl?.trim().replace(/\/+$/, '');
    if (!browserUrl) {
        return;
    }

    for (const directories of directoriesList) {
        const settingsPath = path.join(directories.root, SETTINGS_FILE);
        if (!storage.exists(settingsPath)) {
            continue;
        }

        let userSettings;
        try {
            userSettings = JSON.parse(storage.readFileSync(settingsPath, 'utf8'));
        } catch (error) {
            if (error instanceof SyntaxError) {
                log.warn(LogClass.NORMAL, 'Skipped Vocalis URL default because a user settings file is invalid JSON.');
                continue;
            }

            throw error;
        }

        if (!userSettings || typeof userSettings !== 'object' || Array.isArray(userSettings)) {
            continue;
        }

        if (userSettings.extension_settings === undefined || userSettings.extension_settings === null) {
            userSettings.extension_settings = {};
        }
        const extensionSettings = userSettings.extension_settings;
        if (typeof extensionSettings !== 'object' || Array.isArray(extensionSettings)) {
            continue;
        }

        if (extensionSettings.vocalis === undefined || extensionSettings.vocalis === null) {
            extensionSettings.vocalis = {};
        }
        const vocalisSettings = extensionSettings.vocalis;
        if (typeof vocalisSettings !== 'object' || Array.isArray(vocalisSettings)
            || Object.prototype.hasOwnProperty.call(vocalisSettings, 'serverUrl')) {
            continue;
        }

        vocalisSettings.serverUrl = browserUrl;
        storage.writeFileSync(settingsPath, JSON.stringify(userSettings, null, 4), 'utf8');
    }
}
