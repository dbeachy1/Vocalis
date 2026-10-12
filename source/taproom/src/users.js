// Native Node Modules
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';

// Express and other dependencies
import accountStorage from 'node-persist';
import express from 'express';
import mime from 'mime-types';
import archiver from 'archiver';
import _ from 'lodash';
import * as storage from './storage.js';
import sanitize from 'sanitize-filename';
import ipMatching from 'ip-matching';

import { USER_DIRECTORY_TEMPLATE, DEFAULT_USER, PUBLIC_DIRECTORIES, getPublicBackupDirectory, SETTINGS_FILE, UPLOADS_DIRECTORY } from './constants.js';
import { getConfigValue, color, delay, generateTimestamp, invalidateFirefoxCache, isPathUnderParent, setPermissionsSync } from './util.js';
import { allowKeysExposure, readSecret, writeSecret, SECRETS_FILE } from './endpoints/secrets.js';
import { getContentOfType } from './endpoints/content-manager.js';
import { serverDirectory } from './server-directory.js';
import { filterValidIpPatterns, getIpFromRequest } from './express-common.js';
import { extensionsEnabledFeatureGuard } from './endpoints/extensions.js';
import { log, LogClass, redact } from './logger.js';

export const KEY_PREFIX = 'user:';
const AVATAR_PREFIX = 'avatar:';
const ENABLE_ACCOUNTS = getConfigValue('enableUserAccounts', false, 'boolean');
const AUTHELIA_AUTH = getConfigValue('sso.autheliaAuth', false, 'boolean');
const AUTHENTIK_AUTH = getConfigValue('sso.authentikAuth', false, 'boolean');
const PER_USER_BASIC_AUTH = getConfigValue('perUserBasicAuth', false, 'boolean');
const ANON_CSRF_SECRET = crypto.randomBytes(64).toString('base64');
const TRUSTED_PROXIES = filterValidIpPatterns(getConfigValue('sso.trustedProxies', ['127.0.0.1', '::1']) ?? [], (entry, message) => `${color.red('Warning')}: Ignoring invalid sso.trustedProxies entry ${color.yellow(entry)} - ${message}`);

/**
 * 🔒 THE IDLE LOCK. The mechanism is SillyTavern's; the policy is the provider's.
 *
 * `storage.lock()` is called on logout — but almost nobody logs out. They close the tab, or they walk away,
 * and neither of those is a request. SillyTavern uses `cookieSession`, so the session lives entirely in a
 * cookie on the client: when it expires, THE SERVER NEVER FINDS OUT. It simply stops hearing from them, and
 * goes on holding whatever the provider gave it.
 *
 * Only SillyTavern can see that. A provider is handed storage calls and cannot tell a human clicking Send
 * from a stats file being flushed in the background — so it cannot detect idleness, and it cannot draw a
 * warning either. That is why the machinery is here.
 *
 * 🔴 BUT THE NUMBER IS THE USER'S. Resolution order, and there are only three steps:
 *
 *   1. **No provider owns this user** → never. Their files are plain files; "locking" them would protect
 *      nothing while ending their session for fun. A stock SillyTavern grows no timer, no clock and no
 *      line in its log. This step is not negotiable and is checked first.
 *   2. **The user has chosen a number** (`idleLockMinutes` on their account record) → that, and `0` is a
 *      real choice meaning never.
 *   3. **Otherwise** → `IDLE_LOCK_DEFAULT_MINUTES`, which is 0. Never.
 *
 * ⚠️ NOTE WHAT IS *NOT* IN THAT LIST: the provider's own number. `provider.idleLockMs` is a
 * RECOMMENDATION — the account panel offers it as the suggested option, labelled with the provider's
 * name, and applies it only when the user picks it. Automatically applying a provider recommendation would
 * impose an unexpected timeout; the account owner chooses whether to enable it.
 *
 * ⚠️ THE VALUE IS PER USER AND CHANGES AT RUNTIME, so nothing here may be decided once at boot. The sweep
 * runs whenever a provider is registered, re-reads the shortest lock in play each tick to set its own
 * cadence, and skips every user whose answer is never.
 *
 * ⚠️ THE TRAP, AND IT IS THE WHOLE REASON THIS IS NOT A ONE-LINER: **an open tab talks to the server by
 * itself.** `user.js` pings `/api/ping?extend=1` every ten minutes for as long as the page is open, to keep
 * the session cookie alive. Count that as activity and an abandoned tab is immortal — the storage would
 * never lock, and the feature would look like it worked. Activity means the USER did something. A keepalive
 * is the opposite of the user doing something: it is what happens when they don't.
 *
 * Also excluded is the client's own poll of `/idle-status`, for the same reason. Asking "when will I be
 * locked out?" must never be the thing that postpones it.
 *
 * 🔴 And the event stream, which is the same rule with a longer fuse. `GET /api/events/stream` is opened
 * by the browser and RE-opened by the browser, automatically, on every network blip, every proxy idle
 * close and every laptop resume — the SSE `retry:` field exists to make that happen and there is nobody at
 * the keyboard when it does. Counting a reconnect as activity would mean a tab left open on another
 * desktop postpones the idle lock for ever, and the store never re-locks. The failure would be silent and
 * would look exactly like the feature working.
 */

/** Requests that are NOT the user doing something. See above — getting this wrong silently kills it. */
const NOT_ACTIVITY = new Set(['/api/ping', '/api/users/idle-status', '/api/events/stream']);

/**
 * 🔴 THE WAY BACK IN. Nothing here may be gated on being already in.
 *
 * These are the endpoints that exist FOR the logged-out and the locked: the login page's own traffic and
 * the two ways back from a forgotten password. Every one of them must answer while `isReady()` is false —
 * that is the whole point of them.
 *
 * `setUserDataMiddleware` invalidates the session and returns 403 when the session names a user whose
 * storage is not ready. For the app's own endpoints that is exactly right. For these it is circular:
 * logging in is the CURE for a locked store, and gating the cure on the disease means the first login
 * after every restart is answered with 403 before the password is ever looked at.
 *
 * Keep this in step with the routes in `endpoints/users-public.js`. A new public route that is not listed
 * here will appear to work — right up until someone tries it with a stale session, which is precisely
 * when a public route matters.
 */
const PUBLIC_AUTH_PATHS = new Set([
    '/csrf-token',
    '/api/users/list',
    '/api/users/login',
    '/api/users/recover-step1',
    '/api/users/recover-step2',
    '/api/users/recover-with-key',
    // The login page and its fixed branding assets must load while a stale session is being cleared.
    '/login',
    '/favicon.ico',
    '/img/logo.png',
    '/img/apple-icon-144x144.png',
    // The login page's storage badge. Anonymous and instance-level by construction (see storage-public.js);
    // gating it just makes the badge silently vanish for exactly the users who need to read it.
    '/api/storage/status',
]);

/**
 * Is this request a browser typing an address, rather than the app calling an API?
 *
 * A fetch() that is refused can be handled in code. A top-level navigation that is refused becomes an
 * unstyled error page with no way forward, so the two deserve different answers to the same refusal.
 * @param {import('express').Request} request Request object
 * @returns {boolean} True if this is a top-level document navigation
 */
function isDocumentNavigation(request) {
    return request.method === 'GET' && String(request.get('accept') ?? '').includes('text/html');
}

/**
 * How often to sweep for idle users.
 *
 * Often enough that the lock lands roughly when it was advertised, never so often that it burns the CPU.
 * At a thirty-minute lock this is every fifteen seconds; a short lock sweeps proportionally faster, which
 * is also what makes the idle lock testable in less than a minute.
 *
 * ⚠️ Fed by the SHORTEST lock any user has chosen, not by one global number — see `shortestIdleLockMs`.
 * @param {number} lockMs The shortest lock currently in play
 * @returns {number} The sweep interval
 */
function idleSweepMs(lockMs) {
    return Math.min(15_000, Math.max(500, Math.floor(lockMs / 4)));
}

/**
 * handle -> the last time that user actually did something.
 * @type {Map<string, number>}
 */
const LAST_ACTIVITY = new Map();

/**
 * 🔒 handle -> that user's chosen idle lock, in minutes. 0 is a real answer, and it means never.
 *
 * A cache of the `idleLockMinutes` field on the account record, because the sweep runs on a timer and must
 * not do disk I/O per user per tick. Primed for every account when the sweep starts, refreshed whenever
 * the setting is saved.
 *
 * 🔴 `undefined` HERE MEANS "NOT LOADED", NOT "NEVER". The two must never collapse into each other: a cache
 * miss that reads as 0 is a security control that silently switches itself off, which is exactly the
 * failure mode that is impossible to notice from the outside. Every read goes through
 * `userIdleLockMinutes`, which loads on a miss rather than guessing.
 * @type {Map<string, number>}
 */
const IDLE_LOCK_MINUTES = new Map();

/**
 * 🔴 THE FORK'S DEFAULT, AND IT IS "NEVER".
 *
 * Upstream SillyTavern has no idle lock, so anyone arriving at this fork who has not asked for one must
 * find it behaving exactly as the application they already know. A security feature that switches itself
 * on and logs people out of their own machine mid-sentence is not a safer product, it is an uninstall.
 *
 * A provider may RECOMMEND a number (`storage.idleLockRecommendationMs()`); the account panel offers it,
 * labelled, as the suggested choice. Nothing applies it but the user.
 *
 */
const IDLE_LOCK_DEFAULT_MINUTES = 0;

/** The longest lock we will accept, in minutes. Four weeks — past this the setting is indistinguishable
 * from "never", and accepting an arbitrarily huge number just invites an overflow into a negative delay. */
const IDLE_LOCK_MAX_MINUTES = 40320;

/**
 * The sweep, and the cadence it is currently running at.
 *
 * Held together because they change together: `armIdleSweep` compares the cadence it wants against the one
 * running to decide whether the timer needs replacing at all, and a cadence that drifted out of step with
 * its timer would make that comparison quietly wrong.
 * @type {{timer: NodeJS.Timeout|null, cadence: number}}
 */
const IDLE_SWEEP = { timer: null, cadence: 0 };

/**
 * Cache for user directories.
 * @type {Map<string, UserDirectoryList>}
 */
const DIRECTORIES_CACHE = new Map();
/**
 * The avatar shown for an account that has not set one — including EVERY account on the login page, which
 * is the screen most users see this on.
 *
 * 🔴 `user-default.png`, NOT `default-user.png`. The words were transposed here and nowhere else: the file
 * shipped in `public/img/` is `user-default.png`, and `public/script.js`, `default/content/settings.json`
 * and `default/content/index.json` all name it correctly. Only this constant asked for a file that has
 * never existed, so every avatar it fed rendered as a broken image and every one of those requests was a
 * 403 in the console. Inherited from upstream `8ec509c77` ("Unify default user avatars"), which unified
 * the other three call sites onto the right name and left this one behind.
 */
const PUBLIC_USER_AVATAR = '/img/user-default.png';
const COOKIE_SECRET_PATH = 'cookie-secret.txt';

const STORAGE_KEYS = {
    csrfSecret: 'csrfSecret',
    /**
     * @deprecated Read from COOKIE_SECRET_PATH in DATA_ROOT instead.
     */
    cookieSecret: 'cookieSecret',
};

/**
 * @typedef {Object} User
 * @property {string} handle - The user's short handle. Used for directories and other references
 * @property {string} name - The user's name. Displayed in the UI
 * @property {number} created - The timestamp when the user was created
 * @property {string} password - Scrypt hash of the user's password
 * @property {string} salt - Salt used for hashing the password
 * @property {boolean} enabled - Whether the user is enabled
 * @property {boolean} admin - Whether the user is an admin (can manage other users)
 * @property {number} [idleLockMinutes] - 🔒 How long this user may idle before their storage locks. 0, and
 * absent, both mean never. Lives on the ACCOUNT record rather than in their settings because the sweep must
 * be able to read it for a user whose vault is shut — the whole point is deciding when to shut it.
 */

/**
 * @typedef {Object} UserViewModel
 * @property {string} handle - The user's short handle. Used for directories and other references
 * @property {string} name - The user's name. Displayed in the UI
 * @property {string} avatar - The user's avatar image
 * @property {boolean} [admin] - Whether the user is an admin (can manage other users)
 * @property {boolean} password - Whether the user is password protected
 * @property {boolean} [enabled] - Whether the user is enabled
 * @property {number} [created] - The timestamp when the user was created
 */

/**
 * @typedef {Object} UserDirectoryList
 * @property {string} root - The root directory for the user
 * @property {string} thumbnails - The directory where the thumbnails are stored
 * @property {string} thumbnailsBg - The directory where the background thumbnails are stored
 * @property {string} thumbnailsAvatar - The directory where the avatar thumbnails are stored
 * @property {string} thumbnailsPersona - The directory where the persona thumbnails are stored
 * @property {string} thumbnailsFace - The directory where the square (round-avatar) character thumbnails are stored
 * @property {string} thumbnailsPersonaFace - The directory where the square (round-avatar) persona thumbnails are stored
 * @property {string} worlds - The directory where the WI are stored
 * @property {string} user - The directory where the user's public data is stored
 * @property {string} avatars - The directory where the avatars are stored
 * @property {string} userImages - The directory where the images are stored
 * @property {string} groups - The directory where the groups are stored
 * @property {string} groupChats - The directory where the group chats are stored
 * @property {string} chats - The directory where the chats are stored
 * @property {string} characters - The directory where the characters are stored
 * @property {string} backgrounds - The directory where the backgrounds are stored
 * @property {string} novelAI_Settings - The directory where the NovelAI settings are stored
 * @property {string} koboldAI_Settings - The directory where the KoboldAI settings are stored
 * @property {string} openAI_Settings - The directory where the OpenAI settings are stored
 * @property {string} textGen_Settings - The directory where the TextGen settings are stored
 * @property {string} themes - The directory where the themes are stored
 * @property {string} movingUI - The directory where the moving UI data is stored
 * @property {string} extensions - The directory where the extensions are stored
 * @property {string} instruct - The directory where the instruct templates is stored
 * @property {string} context - The directory where the context templates is stored
 * @property {string} quickreplies - The directory where the quick replies are stored
 * @property {string} assets - The directory where the assets are stored
 * @property {string} comfyWorkflows - The directory where the ComfyUI workflows are stored
 * @property {string} files - The directory where the uploaded files are stored
 * @property {string} vectors - The directory where the vectors are stored
 * @property {string} backups - The directory where the backups are stored
 * @property {string} sysprompt - The directory where the system prompt data is stored
 * @property {string} reasoning - The directory where the reasoning templates are stored
 */

/**
 * Ensures that the content directories exist.
 * @returns {Promise<import('./users.js').UserDirectoryList[]>} - The list of user directories
 */
export async function ensurePublicDirectoriesExist() {
    for (const [name, dir] of Object.entries(PUBLIC_DIRECTORIES)) {
        const directory = name === 'backups' ? getPublicBackupDirectory() : dir;
        if (!storage.exists(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
    }

    const userHandles = await getAllUserHandles();
    const directoriesList = userHandles.map(handle => getUserDirectories(handle));
    for (const handle of userHandles) {
        ensureUserDirectoriesExist(handle);
    }
    return directoriesList;
}

/**
 * Creates one user's directories, if their storage can serve writes yet.
 *
 * A provider cannot resolve paths for a locked user. Defer directory creation until storage is ready,
 * or boot can fail when a required directory is missing.
 * @param {string} handle User handle
 */
function ensureUserDirectoriesExist(handle) {
    if (!storage.isReady(handle)) {
        return;
    }

    for (const dir of Object.values(getUserDirectories(handle))) {
        storage.mkdir(dir, { recursive: true });
    }
}

// Users skipped above because their storage was locked at boot get their directories the moment it
// opens. For the plain filesystem `isReady` is always true, so this never fires and boot is unchanged.
storage.onUserStorageReady(async (handle) => {
    ensureUserDirectoriesExist(handle);
});

/**
 * Prints an error message and exits the process if necessary
 * @param {string} message The error message to print
 * @returns {void}
 */
function logSecurityAlert(message) {
    const { basicAuthMode, whitelistMode } = globalThis.COMMAND_LINE_ARGS;
    if (basicAuthMode || whitelistMode) return; // safe!
    log.error(LogClass.NORMAL, color.red(message));
    if (getConfigValue('securityOverride', false, 'boolean')) {
        log.warn(LogClass.NORMAL, color.red('Security has been overridden. If it\'s not a trusted network, change the settings.'));
        return;
    }
    process.exit(1);
}

/**
 * Verifies the security settings and prints warnings if necessary
 * @returns {Promise<void>}
 */
export async function verifySecuritySettings() {
    const { listen, basicAuthMode, whitelistMode } = globalThis.COMMAND_LINE_ARGS;

    // Skip all security checks as listen is set to false
    if (!listen) {
        return;
    }

    if (!ENABLE_ACCOUNTS) {
        logSecurityAlert('Your current SillyTavern configuration is insecure (listening to non-localhost). Enable whitelisting, basic authentication or user accounts.');
    }

    const users = await getAllEnabledUsers();
    const unprotectedUsers = users.filter(x => !x.password);
    const unprotectedAdminUsers = unprotectedUsers.filter(x => x.admin);

    if (unprotectedUsers.length > 0) {
        log.warn(LogClass.NORMAL, color.blue('A friendly reminder that the following users are not password protected:'));
        // The handle is the secret; "one of these is an admin" is the whole point of the warning and
        // must survive. Renders `<redacted> (admin)` — the count is already disclosed by line 247.
        unprotectedUsers.forEach(x => log.warn(LogClass.NORMAL, redact(color.yellow(x.handle)), color.red(x.admin ? '(admin)' : '')));
        log.info(LogClass.NORMAL);
        log.warn(LogClass.NORMAL, `Consider setting a password in the admin panel or by using the ${color.blue('recover.js')} script.`);
        log.info(LogClass.NORMAL);

        // A lone passwordless user is automatically logged in on every request, so the login page is
        // unavailable. Report this separately: a whitelist limits network reachability but does not
        // authenticate the user. Keep the warning nonfatal for existing single-user installations;
        // `logSecurityAlert()` either suppresses it under whitelist/basic-auth or exits the process.
        if (users.length === 1 && unprotectedUsers.length === 1) {
            log.error(LogClass.NORMAL, color.red('SECURITY: there is no login on this server.'));
            log.error(LogClass.NORMAL, color.red(
                'It has exactly one enabled account and that account has no password, so SillyTavern signs ' +
                'every visitor in automatically. The login page never appears, and clearing cookies does not ' +
                'help. Anyone who can reach this address is already inside.',
            ));

            if (whitelistMode) {
                log.error(LogClass.NORMAL, color.red(
                    'Whitelisting is on, which limits WHO can reach it — it is not a password, and it does ' +
                    'not make this authenticated.',
                ));
            }

            log.error(LogClass.NORMAL, color.red('Set a password on that account to close this.'));
            log.info(LogClass.NORMAL);
        }

        if (unprotectedAdminUsers.length > 0) {
            logSecurityAlert('If you are not using basic authentication or whitelisting, you should set a password for all admin users.');
        }
    }

    if (basicAuthMode) {
        const perUserBasicAuth = getConfigValue('perUserBasicAuth', false, 'boolean');
        if (perUserBasicAuth && !ENABLE_ACCOUNTS) {
            log.error(LogClass.NORMAL, color.red(
                'Per-user basic authentication is enabled, but user accounts are disabled. This configuration may be insecure.',
            ));
        } else if (!perUserBasicAuth) {
            const basicAuthUserName = getConfigValue('basicAuthUser.username', '');
            const basicAuthUserPassword = getConfigValue('basicAuthUser.password', '');
            if (!basicAuthUserName || !basicAuthUserPassword) {
                log.warn(LogClass.NORMAL, color.yellow(
                    'Basic Authentication is enabled, but username or password is not set or empty!',
                ));
            }
        }
    }
}

/**
 * Sweeps away upload staging left behind by a previous run, for one user.
 *
 * 🔴 THIS IS PER-USER MAINTENANCE, AND IT NEEDS THAT USER'S STORAGE TO BE AVAILABLE.
 *
 * It was a boot-time task, and against the plain filesystem that was fine. Against a provider it is not: a
 * staged upload's NAME may be transformed on disk, so listing the directory is a read of user data, and at
 * boot there is no key. It would have thrown, been caught, logged, and swept nothing — for ever, because
 * boot is the only time it ever ran.
 *
 * So it joins the other per-user maintenance tasks and waits for `onUserStorageReady`. With no provider,
 * storage is always ready, every user is swept at boot, and nothing about this is observable.
 * @param {import('./users.js').UserDirectoryList} directories The user's directories
 * @returns {Promise<void>}
 */
export async function cleanUserUploads(directories) {
    const uploadsPath = path.join(directories.root, UPLOADS_DIRECTORY);

    try {
        if (!storage.exists(uploadsPath)) {
            return;
        }

        const uploads = /** @type {string[]} */ (storage.readdir(uploadsPath));

        if (!uploads.length) {
            return;
        }

        log.debug(LogClass.SENSITIVE, `Cleaning uploads folder (${uploads.length} files): ${uploadsPath}`);
        uploads.forEach(file => storage.unlink(path.join(uploadsPath, file)));
    } catch (err) {
        log.error(LogClass.NORMAL, 'Could not clean the uploads folder');
        log.error(LogClass.SENSITIVE, `Could not clean uploads at ${uploadsPath}:`, err);
    }
}

/**
 * Sweeps the legacy global upload directory.
 *
 * Uploads stage inside each user's own directory now. This one is for anyone upgrading from a version that
 * staged them in a single <DATA_ROOT>/_uploads — outside every user directory, where a storage provider
 * would never have seen them, which is exactly why they were moved.
 *
 * It sits outside every user directory, so it needs no key and runs at boot.
 * @returns {Promise<void>}
 */
export async function cleanUploads() {
    const uploadsPath = path.join(globalThis.DATA_ROOT, UPLOADS_DIRECTORY);

    try {
        if (!storage.exists(uploadsPath)) {
            return;
        }

        const uploads = /** @type {string[]} */ (storage.readdir(uploadsPath));

        if (!uploads.length) {
            return;
        }

        log.debug(LogClass.SENSITIVE, `Cleaning legacy uploads folder (${uploads.length} files): ${uploadsPath}`);
        uploads.forEach(file => storage.unlink(path.join(uploadsPath, file)));
    } catch (err) {
        log.error(LogClass.NORMAL, 'Could not clean the legacy uploads folder');
        log.error(LogClass.SENSITIVE, `Could not clean uploads at ${uploadsPath}:`, err);
    }
}

/**
 * Gets a list of all user directories.
 * @returns {Promise<import('./users.js').UserDirectoryList[]>} - The list of user directories
 */
export async function getUserDirectoriesList() {
    const userHandles = await getAllUserHandles();
    const directoriesList = userHandles.map(handle => getUserDirectories(handle));
    return directoriesList;
}

/**
 * Perform migration from the old user data format to the new one.
 */
export async function migrateUserData() {
    const publicDirectory = path.join(process.cwd(), 'public');

    // No need to migrate if the characters directory doesn't exists
    if (!storage.exists(path.join(publicDirectory, 'characters'))) {
        return;
    }

    const TIMEOUT = 10;

    log.info(LogClass.NORMAL);
    log.info(LogClass.NORMAL, color.magenta('Preparing to migrate user data...'));
    log.info(LogClass.SENSITIVE, `All public data will be moved to the ${globalThis.DATA_ROOT} directory.`);
    log.info(LogClass.NORMAL, 'This process may take a while depending on the amount of data to move.');
    log.info(LogClass.NORMAL, 'Migration backups will be placed under the configured data root.');
    log.info(LogClass.NORMAL, `The process will start in ${TIMEOUT} seconds. Press Ctrl+C to cancel.`);

    for (let i = TIMEOUT; i > 0; i--) {
        log.info(LogClass.NORMAL, `${i}...`);
        await delay(1000);
    }

    log.info(LogClass.NORMAL, color.magenta('Starting migration... Do not interrupt the process!'));

    const userDirectories = getUserDirectories(DEFAULT_USER.handle);

    const dataMigrationMap = [
        {
            old: path.join(publicDirectory, 'assets'),
            new: userDirectories.assets,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'backgrounds'),
            new: userDirectories.backgrounds,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'characters'),
            new: userDirectories.characters,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'chats'),
            new: userDirectories.chats,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'context'),
            new: userDirectories.context,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'group chats'),
            new: userDirectories.groupChats,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'groups'),
            new: userDirectories.groups,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'instruct'),
            new: userDirectories.instruct,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'KoboldAI Settings'),
            new: userDirectories.koboldAI_Settings,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'movingUI'),
            new: userDirectories.movingUI,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'NovelAI Settings'),
            new: userDirectories.novelAI_Settings,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'OpenAI Settings'),
            new: userDirectories.openAI_Settings,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'QuickReplies'),
            new: userDirectories.quickreplies,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'TextGen Settings'),
            new: userDirectories.textGen_Settings,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'themes'),
            new: userDirectories.themes,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'user'),
            new: userDirectories.user,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'User Avatars'),
            new: userDirectories.avatars,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'worlds'),
            new: userDirectories.worlds,
            file: false,
        },
        {
            old: path.join(publicDirectory, 'scripts/extensions/third-party'),
            new: userDirectories.extensions,
            file: false,
        },
        {
            old: path.join(process.cwd(), 'thumbnails'),
            new: userDirectories.thumbnails,
            file: false,
        },
        {
            old: path.join(process.cwd(), 'vectors'),
            new: userDirectories.vectors,
            file: false,
        },
        {
            old: path.join(process.cwd(), 'secrets.json'),
            new: path.join(userDirectories.root, 'secrets.json'),
            file: true,
        },
        {
            old: path.join(publicDirectory, 'settings.json'),
            new: path.join(userDirectories.root, 'settings.json'),
            file: true,
        },
        {
            old: path.join(publicDirectory, 'stats.json'),
            new: path.join(userDirectories.root, 'stats.json'),
            file: true,
        },
    ];

    const currentDate = new Date().toISOString().split('T')[0];
    const backupDirectory = path.join(getPublicBackupDirectory(), '_migration', currentDate);

    if (!storage.exists(backupDirectory)) {
        fs.mkdirSync(backupDirectory, { recursive: true });
    }

    const errors = [];

    for (const migration of dataMigrationMap) {
        log.info(LogClass.SENSITIVE, `Migrating ${migration.old} to ${migration.new}...`);

        try {
            if (!storage.exists(migration.old)) {
                log.info(LogClass.SENSITIVE, color.yellow(`Skipping migration of ${migration.old} as it does not exist.`));
                continue;
            }

            if (migration.file) {
                // Copy the file to the new location
                fs.cpSync(migration.old, migration.new, { force: true });
                // Move the file to the backup location
                fs.cpSync(
                    migration.old,
                    path.join(backupDirectory, path.basename(migration.old)),
                    { recursive: true, force: true },
                );
                fs.rmSync(migration.old, { recursive: true, force: true });
            } else {
                // Copy the directory to the new location
                fs.cpSync(migration.old, migration.new, { recursive: true, force: true });
                // Move the directory to the backup location
                fs.cpSync(
                    migration.old,
                    path.join(backupDirectory, path.basename(migration.old)),
                    { recursive: true, force: true },
                );
                fs.rmSync(migration.old, { recursive: true, force: true });
            }
        } catch (error) {
            log.error(LogClass.NORMAL, color.red('Error migrating a legacy data directory to its new location'));
            log.error(LogClass.SENSITIVE, color.red(`Error migrating ${migration.old} to ${migration.new}:`), error.message);
            errors.push(migration.old);
        }
    }

    if (errors.length > 0) {
        log.info(LogClass.NORMAL, color.red('Migration completed with errors. Move the following files manually:'));
        log.error(LogClass.NORMAL, color.red(`${errors.length} path(s) could not be migrated and are listed below.`));
        errors.forEach(error => log.error(LogClass.SENSITIVE, error));
    }

    log.info(LogClass.NORMAL, color.green('Migration completed!'));
}

/**
 * Migrates instruct-mode system prompts into their own directory.
 * @param {UserDirectoryList[]} [directoriesList] Users to migrate. Defaults to every user.
 * @returns {Promise<void>}
 */
export async function migrateSystemPrompts(directoriesList) {
    /**
     * Gets the default system prompts.
     * @returns {Promise<any[]>} - The list of default system prompts
     */
    async function getDefaultSystemPrompts() {
        try {
            return getContentOfType('sysprompt', 'json');
        } catch {
            return [];
        }
    }

    const directories = directoriesList ?? await getUserDirectoriesList();
    for (const directory of directories) {
        try {
            const migrateMarker = path.join(directory.sysprompt, '.migrated');
            if (storage.exists(migrateMarker)) {
                continue;
            }
            const backupsPath = path.join(directory.backups, '_sysprompt');
            storage.mkdir(backupsPath, { recursive: true });
            const defaultPrompts = await getDefaultSystemPrompts();
            const instucts = storage.readdir(directory.instruct);
            let migratedPrompts = [];
            for (const instruct of instucts) {
                const instructPath = path.join(directory.instruct, instruct);
                const sysPromptPath = path.join(directory.sysprompt, instruct);
                if (path.extname(instruct) === '.json' && !storage.exists(sysPromptPath)) {
                    const instructData = JSON.parse(storage.readFileSync(instructPath, 'utf8'));
                    if ('system_prompt' in instructData && 'name' in instructData) {
                        const backupPath = path.join(backupsPath, `${instructData.name}.json`);
                        storage.cp(instructPath, backupPath, { force: true });
                        const syspromptData = { name: instructData.name, content: instructData.system_prompt };
                        migratedPrompts.push(syspromptData);
                        delete instructData.system_prompt;
                        storage.writeFileSync(instructPath, JSON.stringify(instructData, null, 4));
                    }
                }
            }
            // Only leave unique contents
            migratedPrompts = _.uniqBy(migratedPrompts, 'content');
            // Only leave contents that are not in the default prompts
            migratedPrompts = migratedPrompts.filter(x => !defaultPrompts.some(y => y.content === x.content));
            for (const sysPromptData of migratedPrompts) {
                sysPromptData.name = `[Migrated] ${sysPromptData.name}`;
                const syspromptPath = path.join(directory.sysprompt, `${sysPromptData.name}.json`);
                storage.writeFileSync(syspromptPath, JSON.stringify(sysPromptData, null, 4));
                log.info(LogClass.SENSITIVE, `Migrated system prompt ${sysPromptData.name} for ${directory.root.split(path.sep).pop()}`);
            }
            storage.writeFileSync(migrateMarker, '');
        } catch (error) {
            log.error(LogClass.NORMAL, 'Error migrating system prompts for a user');
            log.error(LogClass.SENSITIVE, 'Error migrating system prompts:', error);
        }
    }
}

export async function migratePublicOverrides() {
    const migrationMap = [
        {
            oldPath: path.join(serverDirectory, 'public', 'error', 'forbidden-by-whitelist.html'),
            newPath: path.join(globalThis.DATA_ROOT, '_errors', 'forbidden-by-whitelist.html'),
        },
        {
            oldPath: path.join(serverDirectory, 'public', 'error', 'host-not-allowed.html'),
            newPath: path.join(globalThis.DATA_ROOT, '_errors', 'host-not-allowed.html'),
        },
        {
            oldPath: path.join(serverDirectory, 'public', 'error', 'unauthorized.html'),
            newPath: path.join(globalThis.DATA_ROOT, '_errors', 'unauthorized.html'),
        },
        {
            oldPath: path.join(serverDirectory, 'public', 'error', 'url-not-found.html'),
            newPath: path.join(globalThis.DATA_ROOT, '_errors', 'url-not-found.html'),
        },
    ];

    for (const { oldPath, newPath } of migrationMap) {
        try {
            if (storage.exists(newPath)) {
                continue;
            }
            if (storage.exists(oldPath)) {
                storage.mkdir(path.dirname(newPath), { recursive: true });
                storage.cp(oldPath, newPath, { force: true });
                storage.unlink(oldPath);
                setPermissionsSync(newPath);
                log.info(LogClass.SENSITIVE, `Migrated ${path.basename(oldPath)} to data root.`);
            }
        } catch (error) {
            log.error(LogClass.NORMAL, 'Error migrating a file to the data root');
            log.error(LogClass.SENSITIVE, `Error migrating ${oldPath} to ${newPath}:`, error);
        }
    }

    // 🔴 user.css used to be migrated here too, and it CANNOT BE.
    //
    // It lands at <DATA_ROOT>/<handle>/user.css — inside the user's directory, because it is user-authored
    // content and therefore user data. Which means writing it needs that user's storage to be AVAILABLE,
    // and this function runs at BOOT, where no vault is open and there is no key in the process.
    //
    // Against a provider it threw EUNAVAILABLE on the first user, the catch swallowed it, and the migration
    // was abandoned for EVERYONE -- every boot, for ever, with an error in the log and nothing else to show
    // for it. It failed safe, which is why it took a real deployment to notice.
    //
    // So it is per-user maintenance now, and it waits for the user like everything else. See migrateUserCss.
    //
    // ⚠️ EXCEPT FOR ONE STEP, WHICH MUST NOT WAIT: getting the file out of the web root. express.static
    // mounts `public/` above the auth boundary (server-main.js), so a legacy `public/css/user.css` is
    // served to any unauthenticated client for as long as it exists — and per-user maintenance can keep it
    // alive for ever, because the original is only removed once EVERY account has its own copy, and an
    // account whose owner never logs in again never gets one. Parking it at <DATA_ROOT>/_css/user.css
    // needs no key, ends the exposure on the first boot, and feeds the same per-user fan-out it always
    // did: findLegacyUserCss already lists the parking spot as a legacy location.
    relocateLegacyUserCss(
        path.join(serverDirectory, 'public', 'css', 'user.css'),
        path.join(globalThis.DATA_ROOT, '_css', 'user.css'),
    );
}

/**
 * Moves the legacy global user.css out of the web root, unconditionally, at boot.
 *
 * Giving each user their own copy has to wait for each user's storage (see migrateUserCss); getting the
 * file out of the web root waits for nobody, because the parking spot sits outside every user directory.
 *
 * 🔴 THE WEB-ROOT COPY IS REMOVED EVEN WHEN THE PARKED COPY ALREADY EXISTS. The migrations above skip
 * entirely once their destination exists, and for error pages that is fine. Here a crash between the
 * copy and the removal would otherwise leave the original in the web root for ever — every later boot
 * would see the parked copy and walk away, which is exactly the exposure this function exists to end.
 * And if the two ever genuinely differ, the parked copy still wins: a hand-planted web-root stylesheet
 * is the exposure all over again, not a thing to preserve.
 *
 * Exported for tests; production has exactly one call site, above.
 * @param {string} publicCssPath The legacy stylesheet inside the web root
 * @param {string} parkedCssPath Its parking spot outside the web root
 * @returns {void}
 */
export function relocateLegacyUserCss(publicCssPath, parkedCssPath) {
    try {
        if (!storage.exists(publicCssPath)) {
            return;
        }

        if (!storage.exists(parkedCssPath)) {
            storage.mkdir(path.dirname(parkedCssPath), { recursive: true });
            // Atomic, not cp: a crash mid-copy would otherwise leave a TORN parked file — which the next
            // boot's exists() check takes as the authoritative copy before deleting the intact original
            // beneath it. The funnel's write is write-file-atomic on this (non-provider) path.
            storage.writeFileSync(parkedCssPath, storage.readFileSync(publicCssPath));
            setPermissionsSync(parkedCssPath);
        } else if (!storage.stat(parkedCssPath).isFile()) {
            // "Parked copy wins" is a policy about a COPY. If something else is squatting on the path — a
            // directory, most plausibly — removing the web-root original would destroy the only copy in
            // existence. Leave the exposure standing and say so; only an operator can have made this state.
            log.error(LogClass.NORMAL, 'The legacy user.css parking spot is occupied by something that is not a file; the web-root copy was NOT removed.');
            return;
        }

        storage.unlink(publicCssPath);
        log.info(LogClass.NORMAL, 'Moved the legacy user.css out of the web root.');
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error moving the legacy user.css out of the web root');
        log.error(LogClass.SENSITIVE, `Error moving ${publicCssPath} to ${parkedCssPath}:`, error);
    }
}

/**
 * The legacy global user.css, wherever it still is.
 *
 * It lives OUTSIDE every user directory, so finding it needs no key and works at boot.
 * @returns {string|undefined} The legacy path, if there is one
 */
function findLegacyUserCss() {
    return [
        path.join(serverDirectory, 'public', 'css', 'user.css'),
        path.join(globalThis.DATA_ROOT, '_css', 'user.css'),
    ].find(p => storage.exists(p));
}

/**
 * Gives one user their own copy of the legacy global user.css.
 *
 * 🔴 PER-USER MAINTENANCE. It writes inside the user's directory, so it needs their storage to be available
 * — which at boot, behind an encrypting provider, it is not.
 *
 * The legacy file is global and predates multi-user, so there is no principled way to decide whose it is.
 * Everyone who exists gets a copy and can delete what they do not want; that is the only option that loses
 * nobody's stylesheet. And the original is removed only once EVERY user has their own — anyone still locked
 * keeps it alive until they log in, because deleting it sooner would rob them of a stylesheet they never
 * got a copy of.
 * @param {import('./users.js').UserDirectoryList} directories The user's directories
 * @returns {Promise<void>}
 */
export async function migrateUserCss(directories) {
    const legacyPath = findLegacyUserCss();

    if (!legacyPath) {
        return;
    }

    try {
        // 🔴 THE CONTENT SEEDER GETS THERE FIRST, AND ITS PLACEHOLDER MUST NOT COUNT. checkForNewContent
        // runs earlier in the same maintenance pass (runUserMaintenanceTasks), and the content index ships
        // a user.css stub — so by the time this migration looks, every user "has" a user.css. Counting the
        // stub meant the legacy stylesheet was never copied to anyone, and the moment every account had
        // been seeded, the only remaining copy of it was deleted below. A file byte-equal to the shipped
        // stub is an absence with a timestamp, not a customisation: copy over it, and do not let it
        // satisfy the everyone-has-their-own check either.
        const placeholder = fs.readFileSync(path.join(serverDirectory, 'default', 'content', 'user.css'), 'utf-8').trim();

        /** @param {string} cssPath @returns {Promise<boolean>} */
        const hasTheirOwn = async (cssPath) =>
            storage.exists(cssPath) && String(await storage.readFile(cssPath)).trim() !== placeholder;

        const newPath = path.join(directories.root, 'user.css');

        if (!await hasTheirOwn(newPath)) {
            // Atomic, not cp: a crash mid-copy must not leave a torn user.css that the check below then
            // counts as this user's own. writeFile is the funnel's atomic write on both branches.
            await storage.writeFile(newPath, await storage.readFile(legacyPath));
            setPermissionsSync(newPath);
            log.info(LogClass.NORMAL, 'Migrated user.css into the directory of', redact(path.basename(directories.root)));
        }

        // The original can only go once everyone has their own — and we can only ask that of a user whose
        // storage is available. With no provider, everyone is always available and this is a no-op change:
        // the legacy file is removed on the same boot, exactly as it always was.
        //
        // ⚠️ Degenerate corner, accepted: a legacy stylesheet whose content EQUALS the shipped stub can
        // never satisfy this check, so the parked file lingers. It is unserved and identical to the stub —
        // there is nothing left to lose by keeping it.
        const handles = await getAllUserHandles();
        let everyoneHasTheirOwn = handles.length > 0;

        for (const handle of handles) {
            if (!storage.isReady(handle) || !await hasTheirOwn(path.join(getUserDirectories(handle).root, 'user.css'))) {
                everyoneHasTheirOwn = false;
                break;
            }
        }

        if (everyoneHasTheirOwn) {
            storage.unlink(legacyPath);
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error migrating the legacy user.css into per-user directories');
        log.error(LogClass.SENSITIVE, 'Error migrating user.css:', error);
    }
}

/**
 * Moves a user's account avatar out of the accounts database and into their own directory.
 *
 * 🔴 PER-USER MAINTENANCE, AND WITHOUT IT AN UPGRADE SILENTLY LOSES THE PICTURE.
 *
 * The account avatar used to live in `_storage` as a base64 data URI, under `avatar:<handle>`. It is user
 * content, so it is now an ordinary file in the user's own directory — see {@link setUserAvatar}. But
 * nothing was reading the old key any more, so every user who had ever set an avatar simply lost it on the
 * first boot after the upgrade, with no error and nothing in the log. That is true with no provider
 * installed too: it is a plain data-loss bug, and it has nothing to do with storage providers.
 *
 * It writes inside the user's directory, so it needs their storage available and waits like everything else.
 * @param {import('./users.js').UserDirectoryList} directories The user's directories
 * @returns {Promise<void>}
 */
export async function migrateAccountAvatar(directories) {
    const handle = getDirectoriesHandle(directories);

    try {
        const legacyAvatar = await accountStorage.getItem(toAvatarKey(handle));

        if (!legacyAvatar) {
            return;
        }

        // Never overwrite an avatar they have already set through the new path.
        if (!findAccountAvatar(directories)) {
            setUserAvatar(handle, legacyAvatar);
            log.info(LogClass.NORMAL, 'Migrated the account avatar of', redact(handle), 'into their own directory.');
        }

        // Only once it is safely on disk. A crash between the two leaves the old copy in place, and the
        // migration simply runs again next time — which is the safe direction to fail.
        await accountStorage.removeItem(toAvatarKey(handle));
    } catch (error) {
        log.error(LogClass.NORMAL, 'Could not migrate an account avatar into its own directory');
        log.error(LogClass.SENSITIVE, `Could not migrate the account avatar of ${handle}:`, error);
    }
}

/**
 * Converts a user handle to a storage key.
 * @param {string} handle User handle
 * @returns {string} The key for the user storage
 */
export function toKey(handle) {
    return `${KEY_PREFIX}${handle}`;
}

/**
 * Converts a user handle to a storage key for avatars.
 * @param {string} handle User handle
 * @returns {string} The key for the avatar storage
 */
export function toAvatarKey(handle) {
    return `${AVATAR_PREFIX}${handle}`;
}

/**
 * Names `node-persist` gives its own files: `path.join(dir, sha256(key))`, so 64 lowercase hex digits.
 * The accounts store takes no `getDatumPath` override — see {@link initUserStorage} — so this is exact
 * for `_storage/` rather than a guess.
 * @type {RegExp}
 */
const DATUM_FILENAME = /^[0-9a-f]{64}$/;

/**
 * Refuse the accounts store if something that is not ours is sitting in it.
 *
 * `node-persist` parses every file as a datum during initialization and rejects malformed entries
 * (`forgiveParseErrors` is disabled), preventing the server from starting. This check reports foreign
 * filenames so provider-owned files are not mistaken for account-store corruption. Providers must keep
 * registries outside `_storage/`, which is reserved for the accounts database; see
 * DESIGN_STORAGE_PROVIDER_API.md §11.1.2.
 *
 * The password-recovery tool opens the same store through this function, so it receives the same diagnosis.
 * @param {string} directory The accounts store directory
 * @returns {void}
 */
function assertAccountsDirectoryIsOurs(directory) {
    if (!storage.exists(directory)) {
        return;
    }

    // Names only. Nothing here reads the contents of an account file, and it does not need to.
    const foreign = /** @type {string[]} */ (storage.readdir(directory))
        .filter(name => !DATUM_FILENAME.test(name));

    if (foreign.length === 0) {
        return;
    }

    throw new Error(
        `REFUSING TO START. '${directory}' is SillyTavern's account store, and it contains ${foreign.length} file(s) ` +
        `that SillyTavern did not write: ${foreign.join(', ')}.\n\n` +
        'That directory is a node-persist store. It parses EVERY file in itself as an account record when it ' +
        'opens, and a file that is not one is a fatal error rather than a skipped file — so SillyTavern cannot ' +
        'boot, and neither can `recover.js`, while it is there.\n\n' +
        'This is almost always a storage provider or plugin keeping its own state in the wrong place. Such ' +
        'a component needs a directory it OWNS — an `_`-prefixed name of its own at the data root, not ' +
        'this one. See docs/DESIGN_STORAGE_PROVIDER_API.md §11.1.2.\n\n' +
        'Move the file(s) somewhere else. Nothing has been changed here.',
    );
}

/**
 * Initializes the user storage.
 * @param {string} dataRoot The root directory for user data
 * @returns {Promise<void>}
 */
export async function initUserStorage(dataRoot) {
    log.info(LogClass.NORMAL, 'Using data root:', redact(color.green(dataRoot)));

    const accountsDirectory = path.join(dataRoot, '_storage');

    assertAccountsDirectoryIsOurs(accountsDirectory);

    await accountStorage.init({
        dir: accountsDirectory,
        ttl: false, // Never expire
        expiredInterval: 0,
    });

    const keys = await getAllUserHandles();

    // If there are no users, create the default user
    if (keys.length === 0) {
        await accountStorage.setItem(toKey(DEFAULT_USER.handle), DEFAULT_USER);
    }
}

/**
 * Get the cookie secret from the config. If it doesn't exist, generate a new one.
 * @param {string} dataRoot The root directory for user data
 * @returns {string} The cookie secret
 */
export function getCookieSecret(dataRoot) {
    const cookieSecretPath = path.join(dataRoot, COOKIE_SECRET_PATH);

    if (storage.exists(cookieSecretPath)) {
        const stat = storage.stat(cookieSecretPath);
        if (stat.size > 0) {
            return storage.readFileSync(cookieSecretPath, 'utf8');
        }
    }

    const oldSecret = getConfigValue(STORAGE_KEYS.cookieSecret);
    if (oldSecret) {
        log.info(LogClass.NORMAL, 'Migrating cookie secret from config.yaml...');
        storage.writeFileSync(cookieSecretPath, oldSecret, { encoding: 'utf8' });
        return oldSecret;
    }

    log.warn(LogClass.NORMAL, color.yellow('Cookie secret is missing from data root. Generating a new one...'));
    const secret = crypto.randomBytes(64).toString('base64');
    storage.writeFileSync(cookieSecretPath, secret, { encoding: 'utf8' });
    return secret;
}

/**
 * Generates a random password salt.
 * @returns {string} The password salt
 */
export function getPasswordSalt() {
    return crypto.randomBytes(16).toString('base64');
}

/**
 * Get the session name for the current server.
 *
 * 🔴 THE PORT IS PART OF THE IDENTITY, BECAUSE COOKIES ARE NOT PORT-SCOPED.
 *
 * `https://host:8000` and `https://host:8001` are different origins to almost everything in a browser
 * EXCEPT the cookie jar, which keys on host alone. Two SillyTavern instances on one machine therefore
 * shared a cookie name while signing with different secrets — each holds its own `cookie-secret.txt`
 * under its own data root — so logging into one INVALIDATED THE OTHER: the browser sent the second
 * instance's cookie to the first, the signature failed to verify, and the user got a 403 on
 * `/api/users/login` with no way to tell why. Logging back in bounced them out of the other one, for ever.
 *
 * Hashing the port alongside the hostname gives each instance its own cookie, and the two sessions stop
 * touching. This is not exotic — a second instance on another port is how you test a branch, run an
 * encrypted install beside a plaintext one, or serve two profiles off one box.
 *
 * ⚠️ Changing this changes the cookie name, so every existing session is dropped once, on the first boot
 * after the upgrade. Users log in again and it does not recur.
 * @param {number|string} [port] The port this server listens on. Omitted only where no server is
 * listening (tooling, tests) — two instances that both omit it collide again, which is the bug above.
 * @returns {string} The session name
 */
export function getCookieSessionName(port) {
    // Hash hostname AND port: the hostname alone is not unique to an instance, and the cookie jar
    // ignores the port that would otherwise have distinguished them.
    const hostname = os.hostname() || 'localhost';
    const identity = port === undefined ? hostname : `${hostname}:${port}`;
    const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 8);
    return `session-${suffix}`;
}

export function getSessionCookieAge() {
    // Defaults to "no expiration" if not set
    const configValue = getConfigValue('sessionTimeout', -1, 'number');

    // Convert to milliseconds
    if (configValue > 0) {
        return configValue * 1000;
    }

    // "No expiration" is just 400 days as per RFC 6265
    if (configValue < 0) {
        return 400 * 24 * 60 * 60 * 1000;
    }

    // 0 means session cookie is deleted when the browser session ends
    // (depends on the implementation of the browser)
    return undefined;
}

/**
 * Hashes a password using scrypt with the provided salt.
 * @param {string} password Password to hash
 * @param {string} salt Salt to use for hashing
 * @returns {string} Hashed password
 */
export function getPasswordHash(password, salt) {
    return crypto.scryptSync(password.normalize(), salt, 64).toString('base64');
}

/**
 * The sentence an account holder or administrator reads when a blank password is refused.
 *
 * Taproom (October 11, 2026, pre-release audit): the page offered "[ No password ]" and the server stored it. An
 * enabled account with no password makes the container refuse to start (`provision-owner.mjs --check` in the
 * entrypoint, and the Vault provider's own start-up check), and with `restart: unless-stopped` that is a restart
 * loop that cannot be undone from the page. So the server refuses it, in every route that writes a password.
 */
export const BLANK_PASSWORD_REFUSAL = 'A password is required. Every account on this server must have one, so a blank password cannot be used.';

/**
 * Do accounts on this server need a password?
 *
 * Yes whenever a storage provider is registered: a provider keys the account's data from the password, and the
 * Vault provider refuses to start with any enabled account that has none. `storage.hasProvider()` is the one
 * authority for "this server runs with a provider" (it is what `/api/storage/status` and the idle-lock sweep
 * ask), and in this package a provider is always loaded (`storageProvidersRequiredId: vault`). A fork run with no
 * provider keeps the old behavior: a blank password is allowed there.
 * @returns {boolean} True if a blank password must be refused
 */
export function passwordIsRequired() {
    return storage.hasProvider();
}

/**
 * Decide whether a password about to be stored may be stored.
 * @param {unknown} password The password as the request supplied it
 * @returns {string|null} The refusal sentence, or null when the password may be used
 */
export function blankPasswordRefusal(password) {
    if (!passwordIsRequired()) {
        return null;
    }

    return typeof password === 'string' && password.length > 0 ? null : BLANK_PASSWORD_REFUSAL;
}

/**
 * Get the CSRF secret from the storage.
 * @param {import('express').Request} [request] HTTP request object
 * @returns {string} The CSRF secret
 */
export function getCsrfSecret(request) {
    if (!request || !request.user) {
        return ANON_CSRF_SECRET;
    }

    let csrfSecret = readSecret(request.user.directories, STORAGE_KEYS.csrfSecret);

    if (!csrfSecret) {
        csrfSecret = crypto.randomBytes(64).toString('base64');
        writeSecret(request.user.directories, STORAGE_KEYS.csrfSecret, csrfSecret);
    }

    return csrfSecret;
}

/**
 * Gets a list of all user handles.
 * @returns {Promise<string[]>} - The list of user handles
 */
export async function getAllUserHandles() {
    const keys = await accountStorage.keys(x => x.key.startsWith(KEY_PREFIX));
    const handles = keys.map(x => x.replace(KEY_PREFIX, ''));
    return handles;
}

/**
 * Gets the directories listing for the provided user.
 * @param {string} handle User handle
 * @returns {UserDirectoryList} User directories
 */
export function getUserDirectories(handle) {
    // 🔴 A HANDLE IS ONE PATH SEGMENT, AND THIS IS THE FUNNEL THAT MUST SAY SO. Every caller builds a real
    // filesystem path out of what comes back, so a handle that is not a segment aims those paths somewhere
    // it was never meant to reach: `"."` yields DATA_ROOT itself, and `".."` its parent. Two callers were
    // reached that way (admin `/delete` and `/backup`, both fixed at the route), but a per-route check is
    // only ever as good as the next route somebody adds — the containment belongs here, once.
    //
    // ⚠️ `path.basename` is NOT sufficient on its own: it answers '.' for '.' and '..' for '..', so both
    // walk straight through it. They are named explicitly for that reason.
    if (!handle || handle === '.' || handle === '..' || path.basename(handle) !== handle) {
        throw new Error(`Invalid user handle: ${JSON.stringify(handle)}`);
    }

    if (DIRECTORIES_CACHE.has(handle)) {
        const cache = DIRECTORIES_CACHE.get(handle);
        if (cache) {
            return cache;
        }
    }

    const directories = structuredClone(USER_DIRECTORY_TEMPLATE);
    for (const key in directories) {
        directories[key] = path.join(globalThis.DATA_ROOT, handle, USER_DIRECTORY_TEMPLATE[key]);
    }
    DIRECTORIES_CACHE.set(handle, directories);
    return directories;
}

/**
 * Gets the handle of the user who owns a directory list.
 *
 * `getUserDirectories()` builds every path as `DATA_ROOT + handle + template`, so the last segment of
 * the root IS the handle, by construction. Several call sites are handed a UserDirectoryList without
 * the handle that produced it, and now need it back in order to reach that user's own stores.
 * @param {UserDirectoryList} directories User directories
 * @returns {string} The owning handle
 */
export function getDirectoriesHandle(directories) {
    return path.basename(directories.root);
}

/**
 * The extensions an account avatar may be stored under.
 * @type {string[]}
 * @readonly
 */
const ACCOUNT_AVATAR_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

/**
 * Finds a user's account avatar file, if they have set one.
 * @param {UserDirectoryList} directories User directories
 * @returns {string|null} Path to the avatar, or null
 */
function findAccountAvatar(directories) {
    for (const extension of ACCOUNT_AVATAR_EXTENSIONS) {
        const avatarPath = path.join(directories.user, `avatar.${extension}`);

        if (storage.exists(avatarPath)) {
            return avatarPath;
        }
    }

    return null;
}

/**
 * Sets (or clears) a user's account avatar.
 *
 * 🔴 THIS USED TO BE STORED IN THE ACCOUNTS DATABASE, AS A BASE64 DATA URI.
 *
 * <DATA_ROOT>/_storage is the one store that can never be encrypted: you need the account record in
 * order to check the password, and you need to check the password in order to get anywhere at all. The
 * recursion has to stop somewhere and it stops there. That is fine, because a scrypt verifier is not a
 * secret — but it means _storage is the one place where anything you put is permanently in the clear.
 *
 * And SillyTavern was putting the user's photograph in it. A 744 KB JPEG, base64-encoded, in a key-value
 * database, served to unauthenticated clients on the login page.
 *
 * It is user content. It now lives in the user's own directory, as an ordinary file, where a provider
 * can protect it like everything else.
 * @param {string} handle User handle
 * @param {string} dataUrl A `data:image/...;base64,...` URL, or an empty string to reset to the default
 * @returns {void}
 */
export function setUserAvatar(handle, dataUrl) {
    const directories = getUserDirectories(handle);

    // 🔴 VALIDATE BEFORE DESTROYING. The delete used to come first, so a payload this regex rejects took the
    // user's existing avatar with it and THEN threw — a 500, and the old picture gone with nothing put in
    // its place. The route's own check does not save us: it tests `startsWith('data:image/')`, which is
    // strictly weaker than this, so `data:image/` with nothing after it walks through the route and fails
    // here. Anything the caller cannot replace must not be removed until the replacement is in hand.
    const parsed = dataUrl ? /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl) : null;

    if (dataUrl && !parsed) {
        throw new Error('Account avatar must be a base64 image data URL.');
    }

    // Clear any existing avatar: the new one may have a different extension, and two avatar.* files would
    // be ambiguous. Safe here — either there is a validated replacement below, or the caller asked for the
    // default back.
    for (const extension of ACCOUNT_AVATAR_EXTENSIONS) {
        const existing = path.join(directories.user, `avatar.${extension}`);

        if (storage.exists(existing)) {
            storage.unlink(existing);
        }
    }

    // An empty string means "go back to the default avatar", and is not an error.
    if (!parsed) {
        return;
    }

    const subtype = parsed[1].toLowerCase();
    const extension = ACCOUNT_AVATAR_EXTENSIONS.includes(subtype) ? subtype : 'png';

    storage.mkdir(directories.user, { recursive: true });

    // 'base64' is not decoration: it tells the writer that the payload is a base64 STRING which must be
    // DECODED into bytes on its way to the disk.
    storage.writeFileSync(path.join(directories.user, `avatar.${extension}`), parsed[2], 'base64');
}

/**
 * Gets the avatar URL for the provided user.
 * @param {string} handle User handle
 * @returns {Promise<string>} User avatar URL
 */
export async function getUserAvatar(handle) {
    try {
        const directory = getUserDirectories(handle);

        // The account avatar the user uploaded, if any.
        const accountAvatar = findAccountAvatar(directory);

        if (accountAvatar) {
            const mimeType = mime.lookup(accountAvatar);
            const base64Content = storage.readFileSync(accountAvatar, 'base64');
            return `data:${mimeType};base64,${base64Content}`;
        }

        // Fallback to reading from files if custom avatar is not set
        const pathToSettings = path.join(directory.root, SETTINGS_FILE);
        const settings = storage.exists(pathToSettings) ? JSON.parse(storage.readFileSync(pathToSettings, 'utf8')) : {};
        const avatarFile = settings?.power_user?.default_persona || settings?.user_avatar;
        if (!avatarFile) {
            return PUBLIC_USER_AVATAR;
        }
        const avatarPath = path.join(directory.avatars, sanitize(avatarFile));
        if (!storage.exists(avatarPath)) {
            return PUBLIC_USER_AVATAR;
        }
        const mimeType = mime.lookup(avatarPath);
        const base64Content = storage.readFileSync(avatarPath, 'base64');
        return `data:${mimeType};base64,${base64Content}`;
    } catch {
        // Ignore errors
        return PUBLIC_USER_AVATAR;
    }
}

/**
 * The avatar to show on the LOGIN SCREEN, which is by definition unauthenticated.
 *
 * 🔴 This may NOT be `getUserAvatar`, and the reason is subtle enough that it hid in plain sight.
 *
 * A storage provider may require a user to be authenticated before it will serve their data — that is the
 * whole point of the `EUNAVAILABLE` contract. But `getUserAvatar` reads through the provider and swallows
 * every error, so its behaviour on the login screen depends on whether that user's storage happens to be
 * available *at that moment*:
 *
 * - storage unavailable → the read throws → the catch returns the default avatar;
 * - storage available (the user is logged in in some other session) → **the read SUCCEEDS**, and an
 *   anonymous caller is handed that user's own avatar.
 *
 * Both halves are bugs, and the second is the worse one. It is not merely that user-authored content
 * leaks: it is that the response **differs by storage state**, which turns the public user list into an
 * anonymous *"is this person logged in right now?"* oracle. Encrypting the avatar does not close that —
 * an unlocked server answers it from memory, cheerfully, with the correct key.
 *
 * So the answer must not depend on provider state at all. If a provider owns this user, the login screen
 * gets the default avatar — always, whatever the provider could or could not do for us right now.
 * @param {string} handle User handle
 * @returns {Promise<string>} User avatar URL, safe to serve to an anonymous caller
 */
export async function getPublicUserAvatar(handle) {
    if (storage.ownsUser(handle)) {
        return PUBLIC_USER_AVATAR;
    }

    return getUserAvatar(handle);
}

/**
 * Coerce whatever arrived into a number of minutes we are willing to store, or null if we are not.
 *
 * Rejects rather than clamps, and that is deliberate: a value silently rounded to something else is a
 * setting whose UI lies about what it did. The caller turns null into a 400 and the user sees why.
 *
 * ⚠️ NOT RESTRICTED TO WHOLE MINUTES, THOUGH THE DROPDOWN ONLY OFFERS THEM. The two limits are enforced in
 * different places on purpose: the UI is where a fat-fingered `0.5` should be caught, because there it can
 * be caught *before* it costs the user anything and with an explanation attached. Here, the only question
 * is whether the number is one this server can safely hold and count down from. Refusing a fraction at this
 * layer as well would buy no protection and would make a three-second lock — the only kind a test suite can
 * wait out — unreachable through the real API, so the lock would only ever be tested through a hand-seeded
 * file. That is how you end up with a green suite that has never once exercised the route.
 * @param {unknown} value The proposed setting
 * @returns {number|null} Minutes, or null if the value is not a usable one
 */
export function parseIdleLockMinutes(value) {
    // 🔴 A MISSING FIELD IS NOT A ZERO, AND JAVASCRIPT DISAGREES. `Number(null)`, `Number('')`, `Number([])`
    // and `Number(false)` are all 0 — so a client that forgot the field, or sent an empty box, would arrive
    // here indistinguishable from a user deliberately choosing Never, and would silently switch off a
    // security control on their behalf. Only an actual number, or a string that holds one, may speak.
    if (typeof value !== 'number' && typeof value !== 'string') {
        return null;
    }

    const raw = typeof value === 'string' ? value.trim() : value;

    if (raw === '') {
        return null;
    }

    const minutes = Number(raw);

    if (!Number.isFinite(minutes) || minutes < 0 || minutes > IDLE_LOCK_MAX_MINUTES) {
        return null;
    }

    return minutes;
}

/**
 * 🔒 What has this user chosen for their idle lock?
 *
 * Loads from the account record on a cache miss rather than assuming — see `IDLE_LOCK_MINUTES` for why a
 * miss must never be read as "never".
 * @param {string} handle User handle
 * @returns {Promise<number>} Their chosen minutes, or the fork's default if they have never chosen
 */
export async function userIdleLockMinutes(handle) {
    if (!handle) {
        return IDLE_LOCK_DEFAULT_MINUTES;
    }

    const cached = IDLE_LOCK_MINUTES.get(handle);
    if (cached !== undefined) {
        return cached;
    }

    const user = /** @type {User|undefined} */ (await accountStorage.getItem(toKey(handle)));
    const stored = parseIdleLockMinutes(user?.idleLockMinutes);
    const minutes = stored === null ? IDLE_LOCK_DEFAULT_MINUTES : stored;

    IDLE_LOCK_MINUTES.set(handle, minutes);
    return minutes;
}

/**
 * 🔒 How long may THIS user idle before their storage locks?
 *
 * The resolution order in §THE IDLE LOCK, in code. Step 1 is first and is the one that keeps a stock
 * SillyTavern free of all of this.
 * @param {string} handle User handle
 * @returns {Promise<number>} Milliseconds of inactivity before this user is locked; 0 means never
 */
export async function userIdleLockMs(handle) {
    if (!handle || !storage.ownsUser(handle)) {
        return 0;
    }

    return await userIdleLockMinutes(handle) * 60_000;
}

/**
 * 🔒 Save this user's idle lock choice.
 *
 * @param {string} handle User handle
 * @param {number} minutes Whole minutes; 0 means never
 * @returns {Promise<void>}
 */
export async function setUserIdleLockMinutes(handle, minutes) {
    const user = /** @type {User|undefined} */ (await accountStorage.getItem(toKey(handle)));

    if (!user) {
        throw new Error('No such user');
    }

    user.idleLockMinutes = minutes;
    await accountStorage.setItem(toKey(handle), user);
    IDLE_LOCK_MINUTES.set(handle, minutes);

    // 🔴 START THE CLOCK NOW, NOT ON THEIR NEXT REQUEST. Turning the lock on from a tab that then sits
    // untouched must arm it — and the only reason this user might be absent from the activity map is that
    // the lock was off when they logged in, which is precisely the case being fixed. Without this they are
    // unlocked until they click something, having asked to be locked when they stop clicking.
    if (minutes > 0 && storage.ownsUser(handle)) {
        LAST_ACTIVITY.set(handle, Date.now());
    }

    await armIdleSweep();
}

/**
 * The user did something. Reset their idle clock.
 *
 * ⚠️ Gated on a provider EXISTING, not on the lock being on. The setting is per user and changeable at
 * runtime, so refusing to record activity while it is off would leave whoever turns it on with a stale
 * timestamp — or none — and lock them out immediately for the crime of enabling it.
 * @param {string} handle User handle
 * @returns {void}
 */
export function recordUserActivity(handle) {
    if (storage.hasProvider() && handle) {
        LAST_ACTIVITY.set(handle, Date.now());
    }
}

/**
 * They are gone — logged out, already locked, or deleted outright. Stop counting.
 *
 * ⚠️ Drops the cached SETTING as well as the clock, which costs one disk read at their next login and buys
 * two things. A deleted account cannot leave its lock behind to be inherited by the next account created
 * with the same handle — handles are reusable, and that entry would otherwise outlive the user it belonged
 * to. And a setting changed out of band is picked up on the next login rather than at the next restart.
 * @param {string} handle User handle
 * @returns {void}
 */
export function forgetUserActivity(handle) {
    LAST_ACTIVITY.delete(handle);
    IDLE_LOCK_MINUTES.delete(handle);
}

/**
 * Is this a request the user did not make? See `NOT_ACTIVITY` at the top of this file.
 *
 * Exported as a question rather than as the set itself, because the set is the single source of truth for
 * two separate rules now — whether a request resets the idle clock, and whether it may re-open a vault that
 * the sweep has already shut. `basicAuth` needs the second and must not be able to answer it differently.
 * @param {string} path Request path
 * @returns {boolean} True if this request happened without the user
 */
export function isUnattendedPath(path) {
    return NOT_ACTIVITY.has(path);
}

/**
 * How long until this user's storage locks itself?
 *
 * The client polls this to put a countdown in front of the user before it happens, rather than letting them
 * discover it by being bounced to the login page mid-sentence.
 *
 * `idleLockMs` is reported so the client can size its warning against it — a sixty-second countdown in
 * front of a thirty-second lock would be on the screen permanently.
 *
 * `text` is the PROVIDER's own words for what is about to happen, and null when it has none. SillyTavern
 * does not know why this storage locks, so it does not get to explain it.
 *
 * This is also what the account panel reads to draw the setting, hence the last three fields. `available`
 * is the one that decides whether the control is drawn at all: with no provider owning this user there is
 * nothing to lock, so offering to schedule it would be offering a switch wired to nothing.
 * @param {string} handle User handle
 * @returns {Promise<{enabled: boolean, msUntilLock: number|null, idleLockMs: number, available: boolean, configuredMinutes: number, recommendedMinutes: number, text: import('./storage.js').ProviderText|null}>} The status
 */
export async function idleLockStatus(handle) {
    // Nothing to lock if no provider owns this user: their data is plain files, and "locking" them would
    // protect nothing while breaking their session for fun.
    const available = !!handle && storage.ownsUser(handle);

    if (!available) {
        return { enabled: false, msUntilLock: null, idleLockMs: 0, available: false, configuredMinutes: 0, recommendedMinutes: 0, text: null };
    }

    const configuredMinutes = await userIdleLockMinutes(handle);
    // ⚠️ NOT ROUNDED. Rounding here turned a provider that recommends anything under thirty seconds into one
    // that recommends nothing — the client could not tell "no advice" from "advice too small to survive the
    // maths", and the panel silently stopped attributing it. Rounding is presentation, so the client does it.
    const recommendedMinutes = storage.idleLockRecommendationMs() / 60_000;
    const lockMs = configuredMinutes * 60_000;

    // Available but switched off — which is the default. The panel still needs the numbers to draw the
    // dropdown; the client keys its countdown off `enabled` and leaves the user alone.
    if (!lockMs) {
        return { enabled: false, msUntilLock: null, idleLockMs: 0, available: true, configuredMinutes, recommendedMinutes, text: null };
    }

    const since = LAST_ACTIVITY.get(handle) ?? Date.now();
    const remaining = lockMs - (Date.now() - since);

    return {
        enabled: true,
        msUntilLock: Math.max(0, remaining),
        idleLockMs: lockMs,
        available: true,
        configuredMinutes,
        recommendedMinutes,
        text: storage.describe('idle.warning', { handle }),
    };
}

/**
 * 🔒 Start the sweep that actually locks idle users.
 *
 * This has to be a TIMER, not a check on the way through a request. The case that matters most is the
 * browser being closed entirely — and a closed browser sends no requests, so a lazily-evaluated lock would
 * sit there for ever waiting for a knock that never comes. Precisely the user we most want locked.
 * @returns {NodeJS.Timeout|null} The sweep timer, or null if the idle lock is off
 */
export async function startIdleLockSweep() {
    // 🔴 NO PROVIDER: there is no idle lock, and we say nothing about it. A stock SillyTavern must not grow
    // a timer, a clock, or a warning in its log because of a feature nobody asked for. This is the ONLY
    // thing that can be settled once — every other input to the lock is per user and mutable at runtime.
    if (!storage.hasProvider()) {
        return null;
    }

    // Prime the cache for every account in one pass, so the sweep itself never touches the disk. Also the
    // only way to know the shortest lock in play before the first tick, which is what sets the cadence.
    await primeIdleLockCache();

    const enabled = [...IDLE_LOCK_MINUTES.values()].filter(minutes => minutes > 0);

    // Say what is true, and say nothing when nothing is on. A line claiming a lock that no account has
    // chosen is exactly the kind of log that gets read back later as proof the feature was working.
    if (enabled.length) {
        log.info(LogClass.NORMAL, color.blue('Storage idle lock:'), `${enabled.length} account(s) have chosen one; the shortest is ${Math.min(...enabled)} minute(s), after which they must log in again.`);
    } else {
        log.info(LogClass.NORMAL, color.blue('Storage idle lock:'), 'no account has one set, so nothing will be locked for idleness.');
    }

    return await armIdleSweep();
}

/**
 * 🔒 Load every account's chosen lock into `IDLE_LOCK_MINUTES`.
 *
 * 🔴 THE CACHE IS NOT AN OPTIMISATION HERE — IT IS THE ONLY INPUT `shortestIdleLockMs` HAS, and entries
 * leave it while the server runs. `forgetUserActivity` drops one on logout, on delete, and — the case that
 * bites — from `setUserDataMiddleware` when a user's storage is found shut, which is precisely what the
 * sweep itself just did to them. So the sweep's own success erases the evidence that anyone wanted a lock,
 * and a later re-arm computes its cadence off a map that has quietly emptied.
 * @returns {Promise<void>}
 */
async function primeIdleLockCache() {
    for (const handle of await getAllUserHandles()) {
        await userIdleLockMinutes(handle);
    }
}

/**
 * The shortest lock any account has currently chosen.
 *
 * Sets the sweep's cadence, and answers "is anyone using this at all?" — a provider being installed is no
 * longer enough to mean somebody wants their vault locked on a timer.
 * @returns {number} Milliseconds, or 0 if no account has a lock
 */
function shortestIdleLockMs() {
    let shortest = 0;

    for (const minutes of IDLE_LOCK_MINUTES.values()) {
        if (minutes > 0 && (!shortest || minutes < shortest)) {
            shortest = minutes;
        }
    }

    return shortest * 60_000;
}

/**
 * 🔒 One pass over everyone we are counting.
 *
 * `storage.lock()` is async — it notifies whatever was holding a key derived from this user's storage, and
 * waits for those handlers before moving to the next idle user. The key itself is dropped synchronously
 * inside `lock()`, before any of that, so a slow handler delays only this sweep.
 * @returns {Promise<void>}
 */
async function sweepIdleUsers() {
    const now = Date.now();

    for (const [handle, since] of LAST_ACTIVITY) {
        if (!storage.ownsUser(handle)) {
            LAST_ACTIVITY.delete(handle);
            continue;
        }

        // ⚠️ Asked per user, per tick, and awaited rather than read straight out of the cache: an account
        // created after the sweep started is not in it, and treating that miss as 0 would mean the one
        // user whose setting we never loaded is the one user we never lock. Cache hits do not touch disk.
        const lockMs = await userIdleLockMinutes(handle) * 60_000;

        if (!lockMs || now - since < lockMs) {
            continue;
        }

        // 🔴 FORGET THEM ONLY ONCE THE VAULT IS ACTUALLY SHUT, AND NEVER LET ONE USER'S FAILURE END THE
        // SWEEP. Dropping the entry first meant a `lock()` that threw left the key resident with the
        // user no longer in the only map this sweep walks — never retried, for the life of the process,
        // which is precisely the state the idle lock exists to prevent. And an uncaught throw in an
        // async interval callback is an unhandled rejection: survivable now, but it would still end
        // this tick and skip every user after them.
        try {
            log.info(LogClass.SENSITIVE, color.blue(`Locking storage for '${handle}':`), 'idle. They will need to log in again.');
            await storage.lock(handle);
            LAST_ACTIVITY.delete(handle);
        } catch (error) {
            log.error(LogClass.NORMAL, 'Could not lock idle storage for a user. It stays open, and the next sweep will try again.');
            log.error(LogClass.SENSITIVE, `Could not lock idle storage for '${handle}'. It stays open, and the next sweep will try again.`, error);
        }
    }
}

/**
 * 🔒 Match the sweep to what the accounts are actually asking for, starting or stopping it as needed.
 *
 * 🔴 CALLED AGAIN WHENEVER A SETTING CHANGES, AND THAT IS NOT A REFINEMENT — IT IS THE FEATURE. The cadence
 * is derived from the shortest lock in play, so a user who turns a five-minute lock on while the sweep is
 * idling at its fifteen-second ceiling would otherwise be swept on a schedule chosen before their setting
 * existed. Re-arming here is what makes the setting take effect now rather than eventually.
 * @returns {Promise<NodeJS.Timeout|null>} The sweep timer, or null if nobody has a lock
 */
async function armIdleSweep() {
    // 🔴 NO PROVIDER, NO TIMER — RE-CHECKED HERE AND NOT ONLY AT BOOT. `/api/users/idle-lock` is a normal
    // authenticated route: the account panel hides the control when nothing owns the user, but hiding a
    // control is not a check, and a saved setting must not be able to conjure a sweep into a stock install
    // that has nothing to lock. The setting is still stored — a provider installed later finds it waiting.
    const hasProvider = storage.hasProvider();

    // 🔴 RELOAD BEFORE ASKING. `shortestIdleLockMs` reads the cache directly — it is the one reader that
    // does not go through `userIdleLockMinutes`, so a handle missing from the map reads as "no lock" rather
    // than "not loaded", and the invariant this file states at IDLE_LOCK_MINUTES is broken exactly here.
    // Boot happened to be safe only because it primed first; every other re-arm did not.
    if (hasProvider) {
        await primeIdleLockCache();
    }

    const shortest = hasProvider ? shortestIdleLockMs() : 0;
    const cadence = shortest ? idleSweepMs(shortest) : 0;

    if (cadence === IDLE_SWEEP.cadence) {
        return IDLE_SWEEP.timer;
    }

    if (IDLE_SWEEP.timer) {
        clearInterval(IDLE_SWEEP.timer);
    }

    IDLE_SWEEP.cadence = cadence;
    IDLE_SWEEP.timer = cadence ? setInterval(sweepIdleUsers, cadence) : null;

    // Do not hold the process open just to run the sweep.
    IDLE_SWEEP.timer?.unref?.();
    return IDLE_SWEEP.timer;
}

/**
 * Stop sweeping. For shutdown and for tests; a live interval outlives the suite that created it.
 * @returns {void}
 */
export function stopIdleLockSweep() {
    if (IDLE_SWEEP.timer) {
        clearInterval(IDLE_SWEEP.timer);
    }

    IDLE_SWEEP.timer = null;
    IDLE_SWEEP.cadence = 0;
}

/**
 * Checks if the user should be redirected to the login page.
 * @param {import('express').Request} request Request object
 * @returns {boolean} Whether the user should be redirected to the login page
 */
export function shouldRedirectToLogin(request) {
    return ENABLE_ACCOUNTS && !request.user;
}

/**
 * Tries auto-login if there is only one user and it's not password protected.
 * or another configured method such authlia or basic
 * @param {import('express').Request} request Request object
 * @param {boolean} basicAuthMode If Basic auth mode is enabled
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
export async function tryAutoLogin(request, basicAuthMode) {
    if (!ENABLE_ACCOUNTS || request.user || !request.session) {
        return false;
    }

    if (!request.query.noauto) {
        if (await singleUserLogin(request)) {
            return true;
        }

        if (AUTHELIA_AUTH && await autheliaUserLogin(request)) {
            return true;
        }

        if (AUTHENTIK_AUTH && await authentikUserLogin(request)) {
            return true;
        }

        if (basicAuthMode && PER_USER_BASIC_AUTH && await basicUserLogin(request)) {
            return true;
        }
    }

    return false;
}

/**
 * Tries auto-login if there is only one user and it's not password protected.
 * @param {import('express').Request} request Request object
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
async function singleUserLogin(request) {
    if (!request.session) {
        return false;
    }

    const userHandles = await getAllUserHandles();
    if (userHandles.length === 1) {
        const user = await accountStorage.getItem(toKey(userHandles[0]));
        if (user && !user.password) {
            request.session.handle = userHandles[0];
            request.session.version = getAccountVersion(user);
            return true;
        }
    }
    return false;
}

/**
 * Attempts auto-login using an Authelia header.
 * https://www.authelia.com/integration/trusted-header-sso/introduction/
 * @param {import('express').Request} request Request object
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
async function autheliaUserLogin(request) {
    return headerUserLogin(request, 'Remote-User');
}

/**
 * Attempts auto-login using an Authentik header.
 * https://docs.goauthentik.io/add-secure-apps/providers/proxy/forward_auth/
 * @param {import('express').Request} request Request object
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
async function authentikUserLogin(request) {
    return headerUserLogin(request, 'X-Authentik-Username');
}

/**
 * Check if the request can authenticate SSO users based on the trusted proxies configuration and the request's IP address.
 * @param {string} ip The IP address of the request
 * @return {boolean} If the request is from a trusted proxy based on the configuration
 */
function isRequestFromTrustedProxy(ip) {
    if (!Array.isArray(TRUSTED_PROXIES)) {
        log.warn(LogClass.NORMAL, color.yellow('sso.trustedProxies is not an array. Please check your config.yaml. SSO auto-login will not work.'));
        return false;
    }

    // Bypass magic value check if the user explicitly configured
    if (TRUSTED_PROXIES.length === 1 && TRUSTED_PROXIES[0] === '*') {
        log.warn(LogClass.NORMAL, color.yellow('sso.trustedProxies is set to accept all IPs. This is not recommended for production environments.'));
        return true;
    }

    // If the IP is missing or unknown, we can't trust it
    if (!ip || ip === 'unknown') {
        return false;
    }

    // At least one entry in the trusted proxies list must match the request IP for it to be considered trusted
    for (const entry of TRUSTED_PROXIES) {
        try {
            // This will throw if the entry is not a valid IP or CIDR
            const match = ipMatching.getMatch(entry);
            if (ipMatching.matches(ip, match)) {
                return true;
            }
        } catch (e) {
            continue;
        }
    }

    return false;
}

/**
 * Tries auto-login with a given header.
 * @param {import('express').Request} request Request object
 * @param {string} [header='Remote-User'] The header to use for the trusted user
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
async function headerUserLogin(request, header = 'Remote-User') {
    if (!request.session) {
        return false;
    }

    const remoteUser = request.get(header);
    if (!remoteUser) {
        return false;
    }
    log.debug(LogClass.SENSITIVE, `Attempting auto-login for user from header ${header}: ${remoteUser}`);

    const ip = getIpFromRequest(request);
    const isTrusted = isRequestFromTrustedProxy(ip);
    if (!isTrusted) {
        log.warn(LogClass.SENSITIVE, color.yellow(`Received ${header} header from untrusted IP ${ip}. Ignoring for auto-login.`));
        return false;
    }

    const userHandles = await getAllUserHandles();
    for (const userHandle of userHandles) {
        if (remoteUser.toLowerCase() === userHandle) {
            const user = await accountStorage.getItem(toKey(userHandle));
            if (user && user.enabled) {
                request.session.handle = userHandle;
                request.session.version = getAccountVersion(user);
                return true;
            }
        }
    }
    return false;
}

/**
 * Tries auto-login with basic auth username.
 * @param {import('express').Request} request Request object
 * @returns {Promise<boolean>} Whether auto-login was performed
 */
async function basicUserLogin(request) {
    if (!request.session) {
        return false;
    }

    const authHeader = request.headers.authorization;

    if (!authHeader) {
        return false;
    }

    const [scheme, credentials] = authHeader.split(' ');

    if (scheme !== 'Basic' || !credentials) {
        return false;
    }

    const [username, ...passwordParts] = Buffer.from(credentials, 'base64')
        .toString('utf8')
        .split(':');
    const password = passwordParts.join(':');

    const userHandles = await getAllUserHandles();
    for (const userHandle of userHandles) {
        if (username === userHandle) {
            const user = await accountStorage.getItem(toKey(userHandle));
            // Verify pass again here just to be sure
            if (user && user.enabled && user.password && user.password === getPasswordHash(password, user.salt)) {
                // The second of the three places the password exists. See the note in users-public.js.
                await storage.unlock(userHandle, password);
                request.session.handle = userHandle;
                request.session.version = getAccountVersion(user);
                return true;
            }
        }
    }

    return false;
}

/**
 * Gets the account version tag for the provided user.
 * @param {User} user User account object
 * @returns {string} Account version tag
 */
export function getAccountVersion(user) {
    return crypto.createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([user.handle, user.password, user.salt]))
        .digest('hex');
}

/**
 * Middleware to add user data to the request object.
 * @param {import('express').Request} request Request object
 * @param {import('express').Response} response Response object
 * @param {import('express').NextFunction} next Next function
 */
export async function setUserDataMiddleware(request, response, next) {
    // If user accounts are disabled, use the default user
    if (!ENABLE_ACCOUNTS) {
        const handle = DEFAULT_USER.handle;
        const directories = getUserDirectories(handle);
        request.user = {
            profile: DEFAULT_USER,
            directories: directories,
        };
        return next();
    }

    if (!request.session) {
        log.error(LogClass.NORMAL, 'Session not available');
        return response.sendStatus(500);
    }

    // If user accounts are enabled, get the user from the session
    let handle = request.session?.handle;

    // If we have the only user and it's not password protected, use it
    if (!handle) {
        return next();
    }

    // 🔴 Never gate the way back in. See PUBLIC_AUTH_PATHS: both checks below answer a stale session with
    // 403, and a stale session is the NORMAL state of an open tab after a restart. Applied to /login that
    // is a closed door with the key on the inside — the request never reaches the handler, so the password
    // is never checked, and the user is told "Forbidden" for typing it correctly.
    //
    // None of these routes read `request.user` (they cannot — they serve people who do not have one yet),
    // so leaving it unset costs them nothing.
    if (PUBLIC_AUTH_PATHS.has(request.path)) {
        return next();
    }

    /** @type {User} */
    const user = await accountStorage.getItem(toKey(handle));

    if (!user) {
        log.error(LogClass.NORMAL, 'User not found for the requested handle');
        log.error(LogClass.SENSITIVE, 'User not found:', handle);
        return next();
    }

    if (!user.enabled) {
        log.error(LogClass.NORMAL, 'User account is disabled');
        log.error(LogClass.SENSITIVE, 'User is disabled:', handle);
        return next();
    }

    if (Object.hasOwn(request.session, 'version')) {
        if (request.session.version !== getAccountVersion(user)) {
            log.warn(LogClass.SENSITIVE, 'User data has changed since the session was created. Invalidating session for user:', handle);
            request.session.handle = null;
            request.session.csrfToken = null;
            request.session.version = null;
            request.session = null;
            return response.sendStatus(403);
        }
    } else {
        // If there is no version in the session, it means it's an old session. Upgrade it by adding the version.
        request.session.version = getAccountVersion(user);
    }

    // 🔴 THE LOCKED CONTRACT — AND IT COSTS ALMOST NO CLIENT DIFF, WHICH IS WHY IT GOES HERE.
    //
    // AUTHENTICATED and UNLOCKED are two different things, and SillyTavern has never had to tell them
    // apart before. The session cookie is persisted (cookie-secret.txt survives a restart), but nothing
    // in RAM does. So after a restart SillyTavern will cheerfully consider the user logged in while the
    // provider sits there unable to read a single byte of their data.
    //
    // Now look at the check immediately above: SillyTavern ALREADY knows how to say "your session is no
    // longer valid, log in again" — it invalidates the session and returns 403, and the client already
    // handles that by redirecting to the login page.
    //
    // So a locked store reuses exactly that. No new status code. No new UI. No client change at all.
    // The user is bounced to /login, types their password, the provider unlocks, and everything
    // downstream simply works. Reuse the mechanism; do not invent a 423 the client would have to learn.
    if (!storage.isReady(handle)) {
        log.warn(LogClass.NORMAL, 'Storage is not available for user:', redact(handle), '- they must log in again to unlock it.');
        forgetUserActivity(handle);
        request.session.handle = null;
        request.session.csrfToken = null;
        request.session.version = null;
        request.session = null;

        // A browser that just typed an address gets the door, not the word "Forbidden". `noauto` is what
        // stops this from becoming a redirect loop on an auto-login install: `tryAutoLogin` honours it and
        // declines to re-establish the very session that was just found to be locked, so the login page is
        // actually reached and a password can actually be typed.
        if (isDocumentNavigation(request)) {
            return response.redirect('/login?noauto=1');
        }

        return response.sendStatus(403);
    }

    // 🔒 The user is here, authenticated, and their storage is open. That is the idle clock reset — unless
    // this request is one of the two that happen WITHOUT them (see NOT_ACTIVITY: the session keepalive an
    // open tab sends by itself, and the client's own poll asking how long it has left).
    if (!NOT_ACTIVITY.has(request.path)) {
        recordUserActivity(handle);
    }

    const directories = getUserDirectories(handle);
    request.user = {
        profile: user,
        directories: directories,
    };

    // Touch the session if loading the home page
    if (request.method === 'GET' && request.path === '/') {
        request.session.touch = Date.now();
    }

    return next();
}

/**
 * Middleware to add user data to the request object.
 * @param {import('express').Request} request Request object
 * @param {import('express').Response} response Response object
 * @param {import('express').NextFunction} next Next function
 */
export function requireLoginMiddleware(request, response, next) {
    if (!request.user) {
        return response.sendStatus(403);
    }

    return next();
}

/**
 * Middleware to host the login page.
 * @param {import('express').Request} request Request object
 * @param {import('express').Response} response Response object
 */
export async function loginPageMiddleware(request, response) {
    if (!ENABLE_ACCOUNTS) {
        log.info(LogClass.NORMAL, 'User accounts are disabled. Redirecting to index page.');
        return response.redirect('/');
    }

    try {
        const { basicAuthMode } = globalThis.COMMAND_LINE_ARGS;
        const autoLogin = await tryAutoLogin(request, basicAuthMode);

        if (autoLogin) {
            return response.redirect('/');
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error during auto-login');
        log.error(LogClass.SENSITIVE, 'Error during auto-login:', error);
    }

    return response.sendFile('login.html', { root: path.join(serverDirectory, 'public') });
}

/**
 * Creates a route handler for serving files from a specific directory.
 * @param {(req: import('express').Request) => string} directoryFn A function that returns the directory path to serve files from
 * @returns {import('express').RequestHandler}
 */
function createRouteHandler(directoryFn) {
    return async (req, res) => {
        try {
            const directory = directoryFn(req);
            const filePath = decodeURIComponent(req.params[0]);
            const fullPath = path.join(directory, filePath);
            if (!isPathUnderParent(directory, path.resolve(fullPath))) {
                return res.sendStatus(403);
            }
            const exists = storage.exists(fullPath);
            if (!exists) {
                return res.sendStatus(404);
            }

            invalidateFirefoxCache(filePath, req, res);
            return await storage.sendFile(res, fullPath);
        } catch (error) {
            // A provider error means the data is THERE and unreadable -- never that it is absent. Say
            // so out loud. A silent 500 for a locked vault sends the operator hunting the wrong bug.
            log.error(LogClass.NORMAL, 'Failed to serve a user file: the data is present but could not be read');
            log.error(LogClass.SENSITIVE, `Failed to serve ${req.params[0]}:`, error);
            return res.sendStatus(500);
        }
    };
}

/**
 * Creates a route handler for serving extensions.
 * @param {(req: import('express').Request) => string} directoryFn A function that returns the directory path to serve files from
 * @returns {import('express').RequestHandler}
 */
function createExtensionsRouteHandler(directoryFn) {
    return async (req, res) => {
        try {
            const directory = directoryFn(req);
            const filePath = decodeURIComponent(req.params[0]);
            const localPath = path.join(directory, filePath);
            if (!isPathUnderParent(directory, path.resolve(localPath))) {
                return res.sendStatus(403);
            }
            const existsLocal = storage.exists(localPath);
            if (existsLocal) {
                return await storage.sendFile(res, localPath);
            }

            const globalPath = path.join(PUBLIC_DIRECTORIES.globalExtensions, filePath);
            if (!isPathUnderParent(PUBLIC_DIRECTORIES.globalExtensions, path.resolve(globalPath))) {
                return res.sendStatus(403);
            }
            const existsGlobal = storage.exists(globalPath);
            if (existsGlobal) {
                // Global extensions live in the repo, not in a user directory. No provider owns them,
                // so this falls through to the plain filesystem -- which is correct: they are shipped
                // code, not the user's data.
                return await storage.sendFile(res, path.resolve(globalPath));
            }

            return res.sendStatus(404);
        } catch (error) {
            log.error(LogClass.NORMAL, 'Failed to serve an extension file');
            log.error(LogClass.SENSITIVE, `Failed to serve extension file ${req.params[0]}:`, error);
            return res.sendStatus(500);
        }
    };
}

/**
 * Verifies that the current user is an admin.
 * @param {import('express').Request} request Request object
 * @param {import('express').Response} response Response object
 * @param {import('express').NextFunction} next Next function
 * @returns {any}
 */
export function requireAdminMiddleware(request, response, next) {
    if (!request.user) {
        return response.sendStatus(403);
    }

    if (request.user.profile.admin) {
        return next();
    }

    log.warn(LogClass.SENSITIVE, 'Unauthorized access to admin endpoint:', request.originalUrl);
    return response.sendStatus(403);
}

/**
 * Creates an archive of the user's data root directory.
 * @param {string} handle User handle
 * @param {import('express').Response} response Express response object to write to
 * @returns {Promise<void>} Resolves when the archive has been handed off — or early, with the archive
 * aborted, if the client has gone away. Rejects, also after aborting, if a read fails.
 */
export async function createBackupArchive(handle, response) {
    const directories = getUserDirectories(handle);

    log.info(LogClass.SENSITIVE, 'Backup requested for', handle);
    const archive = archiver('zip');

    archive.on('error', function (err) {
        log.error(LogClass.NORMAL, 'Backup archive failed.');
        log.error(LogClass.SENSITIVE, 'Backup archive failed:', err);

        // ⚠️ THE SAME DEFECT THIS FORK ALREADY FIXED ONE FRAME UP (see users-private.js's /backup route).
        // By the time archiver can emit `error` the attachment headers are long gone, so `status().send()`
        // throws ERR_HTTP_HEADERS_SENT — synchronously, inside an EventEmitter, where it is an uncaught
        // exception rather than a rejection. A failed backup used to be a restart for everybody.
        if (response.headersSent) {
            return response.destroy();
        }

        return response.status(500).send({ error: err.message });
    });

    // On stream closed we can end the request
    archive.on('end', function () {
        log.info(LogClass.NORMAL, 'Archive wrote %d bytes', archive.pointer());
        response.end(); // End the Express response
    });

    const timestamp = generateTimestamp();

    // Set the archive name
    response.attachment(`${handle}-${timestamp}.zip`);

    // This is the streaming magic
    // @ts-ignore
    archive.pipe(response);

    // 🔴 archiver USED TO GLOB THE DIRECTORY AND STREAM THE FILES ITSELF.
    //
    // That is the one call in the codebase that cannot be hooked. It never asks SillyTavern to read a
    // file, so there is no readFile and no createReadStream to intercept -- it simply ZIPs whatever
    // bytes are physically on the disk. Under a transforming provider it would produce an archive full
    // of unreadable garbage, and the user would not find out until they tried to restore it.
    //
    // So we walk the tree ourselves and hand archiver the LOGICAL bytes, file by file.
    //
    // And note what this endpoint IS: a deliberate, user-initiated plaintext export of their entire
    // data directory. That is not a leak, it is the backup button, and under a provider it becomes the
    // one sanctioned way plaintext ever leaves. It requires a readable store by construction, because
    // the archive is assembled out of successful reads.
    // ⚠️ ABORT THE ARCHIVE IF A READ FAILS, AND ONLY THEN RETHROW. Without this the rejection unwinds to the
    // caller while `archive` is still piped to a live response, so nothing ever finalises it: the client is
    // left holding an open connection to a zip that will never end. The caller cannot fix that from outside
    // — it has no handle on the archiver — so the cleanup has to happen here, next to the thing that owns it.
    //
    // ⚠️ ONE ENTRY IN FLIGHT AT A TIME, AND THE RESPONSE SETS THE PACE. Reading whole files into Buffers
    // let the loop run at provider speed while archiver drained at client speed, so resident memory
    // tracked the size of the entire account — in the one process serving every user. Handing archiver a
    // stream is not enough on its own, either: archiver consumes queued entries strictly one at a time,
    // so opening every stream up front pins an fd (and a provider read context) per file. Hence the pump:
    // append one stream, wait for archiver to finish that entry, then walk on.
    //
    // 🔴 A SOURCE STREAM'S FAILURE NEVER REACHES THE ARCHIVE, SO THE LOOP MUST OWN IT. archiver pipes
    // every appended stream into a PassThrough of its own the moment it is appended (archiver-utils,
    // normalizeInputSource) — and pipe() does not forward errors, so the error handling further down
    // archiver's chain is listening on the wrapper, never on our stream. A provider read failing
    // mid-stream would be an 'error' event with no listener: an uncaught exception, taking the process
    // down. So every source gets OUR listener before archiver ever sees it, and a failure is raced into
    // the loop, where the catch below aborts the archive and rethrows — the same invariant the
    // readFile-into-a-Buffer version enforced, by the only route streams leave open.
    //
    // And the race against 'close' is the same bug through a different door: a client that disconnects
    // mid-download stops draining the archive, and without the race the walk would go on reading the
    // whole account into archiver's buffers with nobody consuming them. When the response is gone, stop.
    try {
        const closed = new Promise((resolve) => {
            if (response.closed) return resolve('closed');
            response.once('close', () => resolve('closed'));
        });

        for (const logicalPath of walkFiles(directories.root)) {
            const name = path.relative(directories.root, logicalPath).split(path.sep).join('/');

            if (isExcludedFromBackup(name)) {
                continue;
            }

            // The stream is created FIRST, so a synchronous createReadStream throw leaves no orphaned
            // promise behind — and its error listener is attached before archive.append can start the
            // wrapper pipe consuming it. `on`, not `once`: a standard stream latches after one 'error',
            // but this stream is whatever the provider handed back, and a second emit from an
            // out-of-contract stream would otherwise be an uncaught 'error' event — a process crash.
            const source = storage.createReadStream(logicalPath);
            const failed = new Promise((_, reject) => source.on('error', reject));
            // Armed BEFORE append, and that ordering is load-bearing: append() never throws — every
            // failure is an emit, sometimes synchronous (QUEUECLOSED) — and only a listener that already
            // exists turns that emit into this promise's rejection instead of nothing.
            const appended = once(archive, 'entry').then(() => 'entry');

            try {
                archive.append(source, { name });

                if (await Promise.race([appended, failed, closed]) === 'closed') {
                    archive.abort();
                    return;
                }
            } finally {
                // A completed entry has already ended the stream, and destroy() on an ended stream is a
                // no-op — this is for the OTHER exits. Aborting the archive kills archiver's queue but
                // never touches the source it was consuming, so on the disconnect path (and any error
                // that was not the source's own) the stream would sit paused for ever, holding its fd
                // and whatever read context the provider gave it, until garbage collection got curious.
                source.destroy();
            }
        }
    } catch (error) {
        archive.abort();
        throw error;
    }

    // ⚠️ finalize() returns a promise that CAN reject (aborted state, double call, a module error beating
    // the module's 'end') — and a discarded rejection is an unhandledRejection, i.e. the process-killing
    // failure class this endpoint has been patched for twice. Every reachable cause today also fires the
    // archive's 'error' event, which the standing handler above already reports and cleans up after — the
    // promise is the same error's second delivery channel, so it is swallowed, not double-handled.
    archive.finalize().catch(() => {});
}

/**
 * Walks a directory tree, yielding the logical path of every file in it.
 *
 * Symlinks are yielded as neither files nor directories, and are therefore skipped -- which preserves
 * the `follow: false` the glob used to pass.
 * @param {string} root Directory to walk
 * @returns {Generator<string>} Logical paths of every file beneath it
 */
function* walkFiles(root) {
    const entries = /** @type {import('node:fs').Dirent[]} */ (storage.readdir(root, { withFileTypes: true }));

    for (const entry of entries) {
        const fullPath = path.join(root, entry.name);

        if (entry.isDirectory()) {
            yield* walkFiles(fullPath);
        } else if (entry.isFile()) {
            yield fullPath;
        }
    }
}

/**
 * Should this file be kept out of the user's backup archive?
 *
 * Preserves exactly what the old `ignore` glob patterns excluded: the secrets file, and the plaintext
 * copies of it that the flat-secrets migration leaves lying around in backups/.
 * @param {string} name POSIX-style path, relative to the user's root
 * @returns {boolean} True if it must not be archived
 */
function isExcludedFromBackup(name) {
    // 🔴 `_cache/` IS DERIVED, AND UNDER A PROVIDER IT IS NOT EVEN A READABLE FILE.
    //
    // Observed on the live encrypted install 2026-07-22: every backup of an account that had ever browsed
    // its characters died mid-archive on
    // `_cache/characters/<sha256>` with EPROVIDER — "it carries no storage envelope". That is correct and
    // not a fault. The parsed-card cache is a node-persist store, and a provider covers it through the
    // key/value codec (`keyValueOptions`) rather than by sealing whole files, so there is no envelope for
    // `readFile` to unwrap. Asking for the logical bytes of one is asking the wrong question.
    //
    // Excluding it is right on its own terms anyway: it is a CACHE, rebuilt from `characters/` on demand.
    // Shipping it inside an archive adds weight, and restoring it risks reinstating a stale parse of a card
    // the user has since edited. Nothing is lost by leaving it out.
    //
    // ⚠️ AND IT SITS ABOVE `allowKeysExposure` DELIBERATELY. That flag answers "may this archive contain
    // the user's secrets?", which is a policy question. This is not one — it is "can this file be read at
    // all through the provider", and the answer does not change because an operator opted into exposing
    // keys. Below the flag, setting it would resurrect exactly the crash this fixes.
    if (name === '_cache' || name.startsWith('_cache/')) {
        return true;
    }

    if (allowKeysExposure) {
        return false;
    }

    return name === SECRETS_FILE || /^backups\/secrets_migration_.*\.json$/.test(name);
}

/**
 * Gets all of the users.
 * @returns {Promise<User[]>}
 */
async function getAllUsers() {
    if (!ENABLE_ACCOUNTS) {
        return [];
    }
    /**
     * @type {User[]}
     */
    const users = await accountStorage.values();
    return users;
}

/**
 * Gets all of the enabled users.
 * @returns {Promise<User[]>}
 */
export async function getAllEnabledUsers() {
    const users = await getAllUsers();
    return users.filter(x => x.enabled);
}

/**
 * Express router for serving files from the user's directories.
 */
export const router = express.Router();
router.use('/backgrounds/*', createRouteHandler(req => req.user.directories.backgrounds));
router.use('/characters/*', createRouteHandler(req => req.user.directories.characters));
router.use('/User%20Avatars/*', createRouteHandler(req => req.user.directories.avatars));
router.use('/assets/*', createRouteHandler(req => req.user.directories.assets));
router.use('/user/images/*', createRouteHandler(req => req.user.directories.userImages));
router.use('/user/files/*', createRouteHandler(req => req.user.directories.files));
router.use('/scripts/extensions/third-party/*', extensionsEnabledFeatureGuard, createExtensionsRouteHandler(req => req.user.directories.extensions));
