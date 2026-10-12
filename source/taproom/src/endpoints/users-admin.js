import * as storage from '../storage.js';

import accountStorage from 'node-persist';
import express from 'express';
import lodash from 'lodash';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import {
    KEY_PREFIX,
    toKey,
    requireAdminMiddleware,
    getUserAvatar,
    getAllUserHandles,
    getPasswordSalt,
    getPasswordHash,
    blankPasswordRefusal,
    passwordIsRequired,
    getUserDirectories,
    ensurePublicDirectoriesExist,
    forgetUserActivity,
} from '../users.js';
import { DEFAULT_USER } from '../constants.js';
import { log, LogClass, redact } from '../logger.js';

export const router = express.Router();

/**
 * Slugifies a given text string.
 * - Converts to lowercase
 * - Trims whitespace
 * - Replaces spaces and special characters with hyphens
 * - Removes leading and trailing hyphens
 * - Uses lodash.deburr to remove diacritical marks
 * @param {string} text Text to slugify
 * @returns {string} Slugified text
 */
function slugify(text) {
    return lodash.deburr(String(text ?? '').toLowerCase().trim()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

router.post('/get', requireAdminMiddleware, async (_request, response) => {
    try {
        /** @type {import('../users.js').User[]} */
        const users = await accountStorage.values(x => x.key.startsWith(KEY_PREFIX));

        /** @type {Promise<import('../users.js').UserViewModel>[]} */
        const viewModelPromises = users
            .map(user => new Promise(resolve => {
                getUserAvatar(user.handle).then(avatar =>
                    resolve({
                        handle: user.handle,
                        name: user.name,
                        avatar: avatar,
                        admin: user.admin,
                        enabled: user.enabled,
                        created: user.created,
                        password: !!user.password,
                    }),
                );
            }));

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        log.error(LogClass.NORMAL, 'User list failed');
        log.error(LogClass.SENSITIVE, 'User list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/disable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            log.warn(LogClass.NORMAL, 'Disable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            log.warn(LogClass.NORMAL, 'Disable user failed: Cannot disable yourself');
            return response.status(400).json({ error: 'Cannot disable yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.error(LogClass.NORMAL, 'Disable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = false;
        await accountStorage.setItem(toKey(request.body.handle), user);

        // Locking a user out of the UI while leaving their vault open in this process is half a lockout.
        // Same reasoning as /delete above; a disable is an admin saying "not this person, not now".
        try {
            await storage.lock(request.body.handle);
            forgetUserActivity(request.body.handle);
        } catch (error) {
            log.error(LogClass.NORMAL, 'The account was disabled, but its storage key could not be dropped.');
            log.error(LogClass.SENSITIVE, 'Lock-after-disable failed:', error);
        }

        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'User disable failed');
        log.error(LogClass.SENSITIVE, 'User disable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/enable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            log.warn(LogClass.NORMAL, 'Enable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.error(LogClass.NORMAL, 'Enable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        // An enabled account with no password stops the container from starting (see BLANK_PASSWORD_REFUSAL in
        // users.js). The one account that can be in that state is a disabled one: the bootstrap `default-user` that
        // owner provisioning leaves disabled, or an account created before blank passwords were refused. Enabling it
        // is the same mistake as creating it, so it gets the same refusal.
        if (passwordIsRequired() && !user.password) {
            log.warn(LogClass.NORMAL, 'Enable user refused: the account has no password and this server requires one');
            return response.status(400).json({
                error: 'This account has no password, and every account here needs one, so it cannot be enabled. Create a new account with a password instead.',
            });
        }

        user.enabled = true;
        await accountStorage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'User enable failed');
        log.error(LogClass.SENSITIVE, 'User enable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/promote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            log.warn(LogClass.NORMAL, 'Promote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.error(LogClass.NORMAL, 'Promote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = true;
        await accountStorage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'User promote failed');
        log.error(LogClass.SENSITIVE, 'User promote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/demote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            log.warn(LogClass.NORMAL, 'Demote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            log.warn(LogClass.NORMAL, 'Demote user failed: Cannot demote yourself');
            return response.status(400).json({ error: 'Cannot demote yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.error(LogClass.NORMAL, 'Demote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = false;
        await accountStorage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'User demote failed');
        log.error(LogClass.SENSITIVE, 'User demote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/create', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle || !request.body.name) {
            log.warn(LogClass.NORMAL, 'Create user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const blankRefusal = blankPasswordRefusal(request.body.password);

        if (blankRefusal) {
            log.warn(LogClass.NORMAL, 'Create user refused: blank password on a server that requires one');
            return response.status(400).json({ error: blankRefusal });
        }

        const handles = await getAllUserHandles();
        const handle = slugify(request.body.handle);

        if (!handle) {
            log.warn(LogClass.NORMAL, 'Create user failed: Invalid handle');
            return response.status(400).json({ error: 'Invalid handle' });
        }

        if (handles.some(x => x === handle)) {
            log.warn(LogClass.NORMAL, 'Create user failed: User with that handle already exists');
            return response.status(409).json({ error: 'User already exists' });
        }

        const salt = getPasswordSalt();
        const password = request.body.password ? getPasswordHash(request.body.password, salt) : '';

        const newUser = {
            handle: handle,
            name: request.body.name || 'Anonymous',
            created: Date.now(),
            password: password,
            salt: salt,
            admin: !!request.body.admin,
            enabled: true,
        };

        await accountStorage.setItem(toKey(handle), newUser);

        // Create user directories
        log.info(LogClass.NORMAL, 'Creating data directories for', redact(newUser.handle));
        await ensurePublicDirectoriesExist();
        const directories = getUserDirectories(newUser.handle);
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
        return response.json({ handle: newUser.handle });
    } catch (error) {
        log.error(LogClass.NORMAL, 'User create failed');
        log.error(LogClass.SENSITIVE, 'User create failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/delete', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            log.warn(LogClass.NORMAL, 'Delete user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            log.warn(LogClass.NORMAL, 'Delete user failed: Cannot delete yourself');
            return response.status(400).json({ error: 'Cannot delete yourself' });
        }

        if (request.body.handle === DEFAULT_USER.handle) {
            log.warn(LogClass.NORMAL, 'Delete user failed: Cannot delete default user');
            return response.status(400).json({ error: 'Sorry, but the default user cannot be deleted. It is required as a fallback.' });
        }

        // 🔴 THE HANDLE MUST NAME A REAL ACCOUNT BEFORE ANYTHING IS REMOVED. This was the only one of the
        // six admin mutation routes without this check, and it is the one that deletes a directory tree:
        // `getUserDirectories` joins the handle onto DATA_ROOT, so `"."` resolves to DATA_ROOT ITSELF and
        // the purge below takes every user — `_storage/` with them, so the accounts cannot even be
        // recovered. `validateFileName` would not have caught it either; its regex is separators and NUL,
        // and `.` passes clean.
        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.error(LogClass.NORMAL, 'Delete user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        // ⚠️ PURGE FIRST, THEN FORGET THE ACCOUNT. The other order meant a failed `rm` left an encrypted
        // directory behind with no account record — and therefore no password that could ever open it again.
        if (request.body.purge) {
            const directories = getUserDirectories(request.body.handle);
            log.info(LogClass.SENSITIVE, 'Deleting data directories for', request.body.handle);
            await storage.rm(directories.root, { recursive: true, force: true });
        }

        await accountStorage.removeItem(toKey(request.body.handle));

        // 🔴 AND DROP THE KEY. Logout does this (users-private.js says why: "the key stays in this process's
        // memory, and the vault they believe they just shut is still wide open"), and deleting the account
        // is a strictly stronger signal that got no equivalent. Worse for the purge case: if the provider
        // decides `ownsUser` by whether a vault file exists, the `rm` above just deleted it, so the idle
        // sweep skips this handle for ever and NOTHING drops the key for the life of the process.
        try {
            await storage.lock(request.body.handle);
            forgetUserActivity(request.body.handle);
        } catch (error) {
            // The account is gone either way; this must not turn a completed delete into a 500.
            log.error(LogClass.NORMAL, 'The account was deleted, but its storage key could not be dropped. Restart the server to be certain it is gone.');
            log.error(LogClass.SENSITIVE, 'Lock-after-delete failed:', error);
        }

        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'User delete failed');
        log.error(LogClass.SENSITIVE, 'User delete failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/slugify', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.text) {
            log.warn(LogClass.NORMAL, 'Slugify failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const text = slugify(request.body.text);

        return response.send(text);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Slugify failed');
        log.error(LogClass.SENSITIVE, 'Slugify failed:', error);
        return response.sendStatus(500);
    }
});
