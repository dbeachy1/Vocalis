import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import yaml from 'yaml';
import accountStorage from 'node-persist';

import * as storage from './storage.js';
import { loadStorageProviders } from './storage-provider-loader.js';
import { color, getConfigValue } from './util.js';
import { serverDirectory } from './server-directory.js';
import {
    initUserStorage,
    getPasswordSalt,
    getPasswordHash,
    blankPasswordRefusal,
    toKey,
} from './users.js';
import { log, LogClass, initLogger } from './logger.js';
import { LOG_LEVELS } from './constants.js';

/**
 * Initializes the storage with the data root specified in the config file.
 * @param {string} configPath - The path to the config file.
 * @returns {Promise<string>} The data root
 */
async function initStorage(configPath) {
    const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
    const dataRoot = config.dataRoot;

    if (!dataRoot) {
        log.error(LogClass.NORMAL, 'No "dataRoot" setting found in config.yaml file.');
        process.exit(1);
    }

    await initUserStorage(dataRoot);
    return dataRoot;
}

/**
 * Recovers a user account by enabling it and optionally setting a new password.
 *
 * 🔴 THIS TOOL MUST ASK THE STORAGE PROVIDER FIRST, AND IT MUST BE ABLE TO REFUSE.
 *
 * It is the same rule the HTTP routes obey -- *a password may be changed only when the key can be
 * re-wrapped, or when there is no key* -- and this is the one caller that could route around it. It talks
 * to node-persist directly, from the command line, with no server running and no session to check. If it
 * did not load the provider, it would happily reset the password of an encrypted account and orphan every
 * chat in it: still on the disk, still perfectly encrypted, and nothing in the universe able to read them
 * again.
 *
 * So it loads the provider exactly as the server does, and asks.
 * @param {string} configPath - The path to the config file.
 * @param {string} userAccount - The username of the account to recover.
 * @param {string} [userPassword] - The new password for the account. If not provided, sets an empty password.
 */
export async function recoverPassword(configPath, userAccount, userPassword) {
    // 🔴 START THE WRITER, OR EVERY LINE BELOW IS BUFFERED AND DUMPED UNGATED AT EXIT.
    //
    // `initLogger` was only ever called from server.js. This tool never called it, so `initialized` stayed
    // false for the whole run: every line landed in the pre-init buffer, and the `process.on('exit')` dump
    // published each one in full — including the SENSITIVE half of every NORMAL/SENSITIVE pair below. The
    // one file that applied the classification most carefully was the one file where it did nothing. (The
    // dump is gated now too; this is the other half of the fix, and it also puts the output back in order,
    // since un-seamed `console.*` from libraries prints immediately while a buffer does not.)
    initLogger({
        directory: serverDirectory,
        file: getConfigValue('logging.file', 'st'),
        debugMode: !!getConfigValue('logging.debugMode', false, 'boolean'),
        minLogLevel: getConfigValue('logging.minLogLevel', LOG_LEVELS.DEBUG, 'number'),
        maxSizeMB: getConfigValue('logging.maxSizeMB', 10, 'number'),
        maxArchives: getConfigValue('logging.maxArchives', 20, 'number'),
        timezone: getConfigValue('logging.timezone', 'local'),
    });

    const dataRoot = await initStorage(configPath);

    const providersPath = getConfigValue('storageProvidersPath', path.join(serverDirectory, 'storage-providers'));

    /**
     * @type {import('./users').User}
     */
    const user = await accountStorage.get(toKey(userAccount));

    // The provider is loaded so it can be ASKED, not so it can serve anything. It gets the same context
    // the server would give it, so that a provider which refuses this configuration refuses here too.
    await loadStorageProviders(providersPath, {
        dataRoot,
        accountsEnabled: !!getConfigValue('enableUserAccounts', false, 'boolean'),
        basicAuthMode: !!getConfigValue('basicAuthMode', false, 'boolean'),
        // Both SSO keys, nested, matching server-main.js — the flat names resolve to undefined.
        authenticationDelegated: !!getConfigValue('sso.autheliaAuth', false, 'boolean') || !!getConfigValue('sso.authentikAuth', false, 'boolean') || !!getConfigValue('perUserBasicAuth', false, 'boolean'),
        users: user ? [{ handle: user.handle, enabled: !!user.enabled, hasPassword: !!user.password }] : [],
    });

    if (!user) {
        log.error(LogClass.NORMAL, 'The requested user account was not found.');
        log.error(LogClass.SENSITIVE, `User "${userAccount}" not found.`);
        process.exit(1);
    }

    // 🔴 The guard. Ask before you write.
    //
    // And say WHAT THE PROVIDER SAYS. This tool cannot know why a reset is refused — it does not know what
    // a provider is. It asks, it prints the answer, and if the provider has nothing to say it falls back to
    // a sentence that claims nothing about anything.
    if (storage.ownsUser(user.handle)) {
        const text = storage.describe('password.recover', { handle: user.handle });

        log.error(LogClass.NORMAL);
        log.error(LogClass.NORMAL, color.red('The storage provider will not allow this account\'s password to be reset.'));
        log.error(LogClass.SENSITIVE, color.red(text?.title ?? `The storage provider will not allow "${userAccount}"'s password to be reset.`));

        for (const paragraph of [text?.body, ...(text?.notes ?? [])].filter(Boolean)) {
            log.error(LogClass.NORMAL);
            log.error(LogClass.NORMAL, 'The provider gave a reason, suppressed here because it may name the account:');
            log.error(LogClass.SENSITIVE, paragraph);
        }

        // 🔴 AND SAY WHAT TO DO NEXT, ON THE HALF THE OPERATOR CAN ACTUALLY READ.
        //
        // Everything above this line is either prose that claims nothing or a suppressed marker, so an
        // operator who ran this tool because they were locked out learned only that they are still locked
        // out. That is not a refusal, it is a dead end — and it read as a working refusal only because the
        // ungated buffer dump used to publish the provider's paragraph anyway. The way in for an account
        // the provider owns is the recovery key, which is a fact about this fork's design and names nobody.
        log.error(LogClass.NORMAL);
        log.error(LogClass.NORMAL, 'This account\'s data is held by the provider, so its password cannot be reset from here — doing so would orphan every chat in it.');
        log.error(LogClass.NORMAL, 'Use the account\'s recovery key instead: open the login page, choose the account, and click "Forgot password?".');
        log.error(LogClass.NORMAL, 'To read the provider\'s own reason, set \'logging.debugMode: true\' in config.yaml and run this again; it will be written to the log file rather than shown here.');

        log.error(LogClass.NORMAL);
        process.exit(1);
    }

    if (!user.enabled) {
        log.info(LogClass.NORMAL, 'User is disabled. Enabling...');
        user.enabled = true;
    }

    if (userPassword) {
        log.info(LogClass.NORMAL, 'Setting new password...');
        const salt = getPasswordSalt();
        const passwordHash = getPasswordHash(userPassword, salt);
        user.password = passwordHash;
        user.salt = salt;
    } else {
        // October 11, 2026: with a storage provider loaded (this tool loads it above) an empty password would leave an
        // enabled account that the provider, and the container's start-up check, refuse to start with. Refuse here,
        // before anything is written, and say how to give the account a real one.
        const blankRefusal = blankPasswordRefusal(userPassword);

        if (blankRefusal) {
            log.error(LogClass.NORMAL, color.red(blankRefusal));
            log.error(LogClass.NORMAL, 'Nothing was changed. Run this tool again with a password: node recover.js [account] [password]');
            process.exit(1);
        }

        log.info(LogClass.NORMAL, 'Setting an empty password...');
        user.password = '';
        user.salt = '';
    }

    await accountStorage.setItem(toKey(userAccount), user);
    log.info(LogClass.NORMAL, 'User recovered. A program will exit now.');
}
