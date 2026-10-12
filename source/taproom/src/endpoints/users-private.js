import * as storage from '../storage.js';
import path from 'node:path';
import crypto from 'node:crypto';

import accountStorage from 'node-persist';
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import { getUserAvatar, toKey, getPasswordHash, getPasswordSalt, blankPasswordRefusal, createBackupArchive, ensurePublicDirectoriesExist, setUserAvatar, getAccountVersion, forgetUserActivity, idleLockStatus, parseIdleLockMinutes, setUserIdleLockMinutes } from '../users.js';
import { SETTINGS_FILE } from '../constants.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { color, Cache, getConfigValue } from '../util.js';
import { log, LogClass } from '../logger.js';
import { getIpAddress, retryAfter } from '../express-common.js';

const RESET_POINTS = getConfigValue('rateLimiting.accountsResetMaxAttempts', 5, 'number');
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const RESET_CACHE = new Cache(5 * 60 * 1000);

const generateResetCode = () => Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');

export const router = express.Router();
const resetLimiter = new RateLimiterMemory({
    points: RESET_POINTS > 0 ? RESET_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});

router.post('/logout', async (request, response) => {
    try {
        if (!request.session) {
            log.error(LogClass.NORMAL, 'Session not available');
            return response.sendStatus(500);
        }

        const handle = request.session.handle;

        // 🔴 LOGGING OUT MUST LOCK THE STORAGE. Upstream, logout only drops the session cookie — which is
        // all it CAN mean when the data is plaintext on the disk anyway. With a provider it means much
        // less than the user thinks: the key stays in this process's memory, and the vault they believe
        // they just shut is still wide open to anything running in here. `storage.lock()` existed for
        // exactly this and was called by nobody; "log out, restart, or crash → locked" was two-thirds true.
        //
        // We lock BEFORE clearing the session, deliberately. If locking fails, this request must fail
        // loudly with the session intact — the user is still logged in and knows it. Clearing the session
        // first and then failing to lock would produce the one state that must never exist: a user who
        // believes they are out, and a key that is still in RAM.
        //
        // ⚠️ THE CONSEQUENCE, STATED: a lock is per-USER, not per-session, and `cookieSession` keeps no
        // server-side session list — so this process cannot know whether that user is also logged in
        // somewhere else, and it cannot count. Logging out therefore locks the vault EVERYWHERE: another
        // device with a live session for the same account is bounced to /login on its next request (see
        // the isReady check in setUserDataMiddleware, which already handles exactly this). That is the
        // correct trade. The alternative is a logout that does not lock, which is not a logout.
        if (handle) {
            await storage.lock(handle);
            forgetUserActivity(handle);
        }

        request.session.handle = null;
        request.session.csrfToken = null;
        request.session.version = null;
        request.session = null;
        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Logout failed');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

/**
 * 🔒 How long has this user got before their storage locks itself?
 *
 * The client polls this so it can warn them BEFORE it happens, instead of letting them find out by being
 * bounced to the login page halfway through a sentence.
 *
 * ⚠️ This route is in `NOT_ACTIVITY`, so asking does not postpone the answer. If polling it counted as
 * activity, an open tab would hold the vault open for ever and the idle lock would quietly do nothing —
 * while looking, from every angle, like it worked.
 */
router.get('/idle-status', async (request, response) => {
    try {
        return response.json(await idleLockStatus(request.user.profile.handle));
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error reading idle status');
        log.error(LogClass.SENSITIVE, 'Error reading idle status:', error);
        return response.sendStatus(500);
    }
});

/**
 * 🔒 The user sets their own idle lock, in whole minutes. 0 means never, and is the default.
 *
 * 🔴 THEIR OWN, AND ONLY THEIR OWN — `request.user.profile.handle`, never a handle from the body. This is
 * not an admin route wearing a different name. An admin setting someone else's lock to zero would be
 * reaching into another person's vault policy, and setting it to one minute would be a denial of service
 * they could not see the cause of. Every other per-account route in this file that an admin may legitimately
 * use for someone else takes a handle; this one deliberately does not, so there is nothing to get wrong.
 */
router.post('/idle-lock', async (request, response) => {
    try {
        const minutes = parseIdleLockMinutes(request.body.minutes);

        if (minutes === null) {
            log.warn(LogClass.NORMAL, 'Idle lock change refused: the value was not a whole number of minutes in range');
            return response.status(400).json({ error: 'The idle lock must be a whole number of minutes, from 0 (never) upwards.' });
        }

        await setUserIdleLockMinutes(request.user.profile.handle, minutes);
        return response.json(await idleLockStatus(request.user.profile.handle));
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error saving the idle lock setting');
        log.error(LogClass.SENSITIVE, 'Error saving the idle lock setting:', error);
        return response.sendStatus(500);
    }
});

/**
 * 🔒 "I am still here." The button in the countdown modal.
 *
 * There is nothing to do in the handler: this route is NOT in `NOT_ACTIVITY`, so simply arriving here has
 * already reset the idle clock in `setUserDataMiddleware`. We only report the new deadline back.
 */
router.post('/idle-keepalive', async (request, response) => {
    try {
        return response.json(await idleLockStatus(request.user.profile.handle));
    } catch (error) {
        log.error(LogClass.NORMAL, 'Error extending idle lock');
        log.error(LogClass.SENSITIVE, 'Error extending idle lock:', error);
        return response.sendStatus(500);
    }
});

router.get('/me', async (request, response) => {
    try {
        if (!request.user) {
            return response.sendStatus(403);
        }

        const user = request.user.profile;
        const viewModel = {
            handle: user.handle,
            name: user.name,
            avatar: await getUserAvatar(user.handle),
            admin: user.admin,
            password: !!user.password,
            created: user.created,
        };

        return response.json(viewModel);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to read the current user profile');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/change-avatar', async (request, response) => {
    try {
        if (!request.body.handle) {
            log.warn(LogClass.NORMAL, 'Change avatar failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Change avatar failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        // Avatar is not a data URL or not an empty string
        if (!request.body.avatar.startsWith('data:image/') && request.body.avatar !== '') {
            log.warn(LogClass.NORMAL, 'Change avatar failed: Invalid data URL');
            return response.status(400).json({ error: 'Invalid data URL' });
        }

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.error(LogClass.NORMAL, 'Change avatar failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        // The avatar is user content, so it goes into the user's own directory as a file — not into the
        // accounts database, which is the one store that can never be encrypted.
        setUserAvatar(request.body.handle, request.body.avatar);

        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Change avatar failed');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/change-password', async (request, response) => {
    try {
        if (!request.body.handle) {
            log.warn(LogClass.NORMAL, 'Change password failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Change password failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.error(LogClass.NORMAL, 'Change password failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            log.error(LogClass.NORMAL, 'Change password failed: User is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        // A blank new password is refused before anything is re-keyed or written (see BLANK_PASSWORD_REFUSAL in
        // users.js for why). The Vault provider's rekey refuses it too, but this route must not depend on that.
        const blankRefusal = blankPasswordRefusal(request.body.newPassword);

        if (blankRefusal) {
            log.warn(LogClass.NORMAL, 'Change password refused: the new password was blank on a server that requires one');
            return response.status(400).json({ error: blankRefusal });
        }

        // Upstream's rule, unchanged: a non-admin must know their old password; an admin need not. Whether
        // that is ENOUGH is not SillyTavern's call to make — a provider that keys itself from this password
        // may demand more, and it says so by refusing to re-key below. The fork does not second-guess it.
        if (!request.user.profile.admin && user.password && user.password !== getPasswordHash(request.body.oldPassword, user.salt)) {
            log.error(LogClass.NORMAL, 'Change password failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
        }

        // 🔴 RE-KEY BEFORE YOU RE-HASH, AND HONOUR A VETO.
        //
        // A provider may derive its key from this password. If SillyTavern changes the password without
        // telling it, the provider is left holding a wrapped key whose only pre-image no longer exists,
        // and the user's data is ORPHANED FOREVER -- still there, still encrypted, permanently
        // unreadable. Not leaked. Worse than leaked: gone.
        //
        // So the provider gets the old secret and the new one, and gets to REFUSE. If it cannot re-wrap
        // -- because it was not given the old secret and is not already unlocked -- it throws, and the
        // password change is rejected rather than pushed through.
        //
        // NOTE: this used to say that an admin changing their OWN password while unlocked does not need
        // the old one, because the key is in memory and can just be re-wrapped. That shortcut was REMOVED
        // by the vault (its commit `4963508`, "rekey() gave the key away to anyone holding a live
        // session") — a live session was enough to re-wrap the DEK under an attacker-chosen password.
        // Every rekey now goes through the provider's old-secret check, including an admin's own.
        try {
            await storage.rekey(request.body.handle, request.body.oldPassword ?? null, request.body.newPassword ?? '');
        } catch (error) {
            log.error(LogClass.NORMAL, 'Change password failed: the storage provider refused to re-key');
            log.error(LogClass.SENSITIVE, 'Change password failed: the storage provider refused to re-key', request.body.handle, error);

            // 🔴 DO NOT INVENT THE REASON. This used to say "Your data would have become unreadable" for
            // every refusal — but the provider may equally have refused because the old password was simply
            // WRONG, and telling that user their data nearly died is a lie that will send them looking for
            // a recovery key they do not need. The provider knows why it said no. Let it say so.
            const reason = error instanceof Error && error.message ? error.message : 'The storage provider refused the password change.';
            return response.status(403).json({ error: reason });
        }

        if (request.body.newPassword) {
            const salt = getPasswordSalt();
            user.password = getPasswordHash(request.body.newPassword, salt);
            user.salt = salt;
        } else {
            user.password = '';
            user.salt = '';
        }

        await accountStorage.setItem(toKey(request.body.handle), user);

        // Update session version to keep the current session valid after password change
        if (request.session && request.session.handle === user.handle) {
            request.session.version = getAccountVersion(user);
        }

        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Change password failed');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/backup', async (request, response) => {
    try {
        const allowFullDataBackup = !!getConfigValue('backups.allowFullDataBackup', true, 'boolean');

        if (!allowFullDataBackup) {
            log.warn(LogClass.NORMAL, 'Backup failed: Full data backup is disabled in configuration');
            return response.status(403).json({ error: 'Full data backup is disabled' });
        }

        const handle = request.body.handle;

        if (!handle) {
            log.warn(LogClass.NORMAL, 'Backup failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Backup failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        // 🔴 AND IT MUST NAME A REAL ACCOUNT. `createBackupArchive` walks `getUserDirectories(handle).root`,
        // which is DATA_ROOT joined with the handle — so `"."` walks DATA_ROOT itself and ships EVERY user's
        // `secrets.json` (only the ROOT one is excluded) plus `_storage/`, i.e. the account records, scrypt
        // hashes and salts that `users.js` calls the one place where anything you put is permanently in the
        // clear. Checked after the authorization test above, so this never becomes a handle oracle.
        const account = await accountStorage.getItem(toKey(handle));

        if (!account) {
            log.error(LogClass.NORMAL, 'Backup failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        // 🔴 AN ADMIN MAY NOT CROSS INTO AN ENCRYPTED ACCOUNT. THIS IS THE ONE ROUTE THAT COULD.
        //
        // Upstream lets an admin name any handle here, and upstream is right to: with no provider the files
        // are plaintext on disk and an operator can read them anyway, so the route grants nothing it did not
        // already have. Under a provider that stops being true, and this rule silently became the only way
        // to defeat encryption at rest from inside the application.
        //
        // The key is not the leak, and locking down `keysFor` would be the wrong fix — the server MUST hold
        // an unlocked user's key or it cannot serve them their own chats. The leak is that the request names
        // SOMEONE ELSE'S handle and this endpoint reads LOGICAL, decrypted bytes (see `createBackupArchive`).
        // While the owner is logged in their key is in memory, so an admin's archive would come out in the
        // clear without anyone ever knowing their password. The account owner is the only party who should
        // be able to export their own vault, so scope it to them.
        //
        // ⚠️ `ownsUser` answers YES when it does not know, which is what we want here: an unrecognised
        // provider is assumed to be protecting something.
        if (handle !== request.user.profile.handle && storage.ownsUser(handle)) {
            log.error(LogClass.NORMAL, 'Backup refused: cross-user export of a provider-held account');
            log.error(LogClass.SENSITIVE, 'Backup refused: admin', request.user.profile.handle, 'asked for', handle);
            return response.status(403).json({
                error: 'This account\'s storage is held by a provider and can only be exported by its owner.',
            });
        }

        // ⚠️ REFUSE BEFORE STREAMING, NOT DURING. `createBackupArchive` sets the attachment header and pipes
        // immediately, so a failure discovered mid-walk cannot be reported — the status is already sent. A
        // shut vault is the ordinary case (nobody is logged in), not an error, so answer it here.
        if (!storage.isReady(handle)) {
            log.warn(LogClass.NORMAL, 'Backup failed: storage for this account is not currently readable');
            return response.status(409).json({ error: 'This account\'s storage is locked. Sign in and try again.' });
        }

        await createBackupArchive(handle, response);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Backup failed');
        log.error(LogClass.SENSITIVE, 'Backup failed', error);

        // 🔴 THIS `return` USED TO TAKE THE SERVER DOWN. `createBackupArchive` starts streaming before it
        // reads anything, so by the time a read fails the status line and the attachment header are already
        // on the wire. `sendStatus` then throws ERR_HTTP_HEADERS_SENT — from inside a `catch`, in an async
        // handler Express does not wrap, which makes it an unhandled rejection and takes the process with
        // it. A failed backup became a restart for every logged-in user on the box.
        //
        // Once the response has started the only honest signal left is an abrupt end: the client sees a
        // truncated archive rather than a valid one, which is exactly what happened.
        if (response.headersSent) {
            return response.destroy();
        }

        return response.sendStatus(500);
    }
});

router.post('/reset-settings', async (request, response) => {
    try {
        const password = request.body.password;

        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(password, request.user.profile.salt)) {
            log.warn(LogClass.NORMAL, 'Reset settings failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
        }

        const pathToFile = path.join(request.user.directories.root, SETTINGS_FILE);
        await storage.rm(pathToFile, { force: true });
        await checkForNewContent([request.user.directories], [CONTENT_TYPES.SETTINGS]);

        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Reset settings failed');
        log.error(LogClass.SENSITIVE, 'Reset settings failed', error);
        return response.sendStatus(500);
    }
});

router.post('/change-name', async (request, response) => {
    try {
        if (!request.body.name || !request.body.handle) {
            log.warn(LogClass.NORMAL, 'Change name failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Change name failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.warn(LogClass.NORMAL, 'Change name failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.name = request.body.name;
        await accountStorage.setItem(toKey(request.body.handle), user);

        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Change name failed');
        log.error(LogClass.SENSITIVE, 'Change name failed', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step1', async (request, response) => {
    try {
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        const rateLimit = await resetLimiter.get(ip);

        // Check for existing rate limits, but allow requesting a new code unless locked out
        if (rateLimit !== null && rateLimit.consumedPoints > resetLimiter.points) {
            throw rateLimit;
        }

        // Same split as the recovery code in users-public.js: the code must reach the operator's
        // console or the flow is broken, the name must not reach the log.
        const resetCode = generateResetCode();
        log.info(LogClass.NORMAL);
        log.info(LogClass.NORMAL, color.magenta('Your account reset code is: ') + color.red(resetCode));
        log.info(LogClass.NORMAL);
        log.info(LogClass.SENSITIVE, `Account reset code issued for ${request.user.profile.name}.`);
        RESET_CACHE.set(request.user.profile.handle, resetCode);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            log.error(LogClass.NORMAL, 'Account reset step 1 failed: Rate limited');
            log.error(LogClass.SENSITIVE, 'Reset step 1 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        log.error(LogClass.NORMAL, 'Account reset step 1 failed');
        log.error(LogClass.SENSITIVE, 'Reset step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step2', async (request, response) => {
    try {
        if (!request.body.code) {
            log.warn(LogClass.NORMAL, 'Reset step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(request.body.password, request.user.profile.salt)) {
            log.warn(LogClass.NORMAL, 'Reset step 2 failed: Incorrect password');
            return response.status(400).json({ error: 'Incorrect password' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        const rateLimit = await resetLimiter.get(ip);

        if (rateLimit !== null && rateLimit.consumedPoints > resetLimiter.points) {
            throw rateLimit;
        }

        const code = RESET_CACHE.get(request.user.profile.handle);

        if (!code || code !== request.body.code) {
            await resetLimiter.consume(ip);
            log.warn(LogClass.NORMAL, 'Reset step 2 failed: Incorrect code');
            return response.status(400).json({ error: 'Incorrect code' });
        }

        log.info(LogClass.SENSITIVE, 'Resetting account data:', request.user.profile.handle);
        await storage.rm(request.user.directories.root, { recursive: true, force: true });

        await ensurePublicDirectoriesExist();
        await checkForNewContent([request.user.directories]);

        await resetLimiter.delete(ip);
        RESET_CACHE.remove(request.user.profile.handle);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            log.error(LogClass.NORMAL, 'Account reset step 2 failed: Rate limited');
            log.error(LogClass.SENSITIVE, 'Reset step 2 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        log.error(LogClass.NORMAL, 'Account reset step 2 failed');
        log.error(LogClass.SENSITIVE, 'Reset step 2 failed:', error);
        return response.sendStatus(500);
    }
});

// ---------------------------------------------------------------------------------------------
// The recovery secret
// ---------------------------------------------------------------------------------------------
//
// 🔴 A storage provider that keys a user's data from their password CANNOT reset that password. There is
// no administrative override, on purpose -- an override that works with mere box access is itself the
// backdoor. The recovery secret is the only way back in, and it exists in exactly one place: this response,
// once. If it is not shown, the account is silently unrecoverable.
//
// So these two routes are not a nicety. They are the difference between "the data is encrypted" and "the
// data is encrypted and remains accessible after a restart."
//
// THE HANDLE COMES FROM THE SESSION, NEVER FROM THE BODY. A route that took a handle from the request would
// hand one logged-in user the keys to another's account.

router.get('/recovery-secret', async (request, response) => {
    try {
        const handle = request.user.profile.handle;
        const secret = storage.pendingRecoverySecret(handle);

        // The overwhelmingly common case: nothing pending, nothing to show, get on with your day.
        if (!secret) {
            return response.json({ secret: null, text: null });
        }

        log.info(LogClass.SENSITIVE, color.yellow(`Showing ${request.user.profile.name} their recovery key. They will keep being shown it until they confirm they have saved it.`));

        // 🔴 The SECRET is the provider's, and so is the EXPLANATION. SillyTavern knows only that something
        // must be put in front of the user; it does not know what losing it would cost them, so it does not
        // get to say. It draws the screen — which a server-side provider can never do — and the provider
        // fills in the words.
        return response.json({ secret, text: storage.describe('recovery.secret', { handle }) });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Could not read the recovery secret');
        log.error(LogClass.SENSITIVE, 'Could not read the recovery secret:', error);
        return response.sendStatus(500);
    }
});

/**
 * Can this user ask for a new recovery secret? Used to decide whether to offer the button at all.
 */
router.get('/recovery-secret/capability', async (request, response) => {
    try {
        const handle = request.user.profile.handle;

        return response.json({
            canRegenerate: storage.canRegenerateRecoverySecret(handle),
            text: storage.describe('recovery.regenerate', { handle }),
        });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Could not read the recovery capability');
        log.error(LogClass.SENSITIVE, 'Could not read the recovery capability:', error);
        return response.sendStatus(500);
    }
});

/**
 * 🔑 Issue a NEW recovery secret, retiring the old one.
 *
 * 🔴 IT TAKES THE PASSWORD, AND BEING LOGGED IN IS NOT A SUBSTITUTE FOR IT.
 *
 * This is the same trap as `rekey`, and it is worth spelling out because the shortcut is so tempting: the
 * user is already authenticated, the provider is already unlocked, the secret could simply be minted. But a
 * recovery secret opens the account FOR EVER, from anywhere, with nothing else — so a button that minted one
 * on the strength of a live session alone would be a one-click key-theft tool for anyone who got hold of
 * one. A borrowed desk. A stolen cookie. A hostile UI extension.
 *
 * Being signed in proves the storage is open. It does not prove who opened it.
 *
 * SillyTavern's job is only to give them somewhere to type it and to carry it across. Whether it is
 * *required* is the provider's call, and it says so by throwing — whereupon we report its own words.
 *
 * THE HANDLE COMES FROM THE SESSION, NEVER FROM THE BODY. A route that took a handle would let one
 * logged-in user mint a permanent key to somebody else's account.
 */
router.post('/recovery-secret/regenerate', async (request, response) => {
    try {
        const handle = request.user.profile.handle;

        try {
            await storage.regenerateRecoverySecret(handle, request.body.password ?? '');
        } catch (error) {
            log.error(LogClass.NORMAL, 'Could not issue a new recovery key: the storage provider refused');
            log.error(LogClass.SENSITIVE, 'Could not issue a new recovery key for', handle, error);
            const reason = error instanceof Error && error.message ? error.message : 'The storage provider refused to issue a new recovery key.';
            return response.status(403).json({ error: reason });
        }

        // The provider now has a fresh secret pending. The client picks it up from /recovery-secret and puts
        // it on the same unskippable screen as the one shown at first login — which is right: it is exactly
        // as important, and exactly as irreplaceable.
        log.info(LogClass.SENSITIVE, color.yellow(`${request.user.profile.name} asked for a new recovery key. Any previous one has been retired.`));
        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Could not issue a new recovery key');
        log.error(LogClass.SENSITIVE, 'Could not issue a new recovery key:', error);
        return response.sendStatus(500);
    }
});

/**
 * The provider's own version of the change-password dialog.
 *
 * 🔴 THIS IS WHY THE HOOK EXISTS AT ALL. A provider may key a user's data from their password, in which
 * case changing it is not the trivial act SillyTavern thinks it is, and the boxes to show, what to call
 * them, and what to warn about are all things only the provider knows. It gets to say. With no provider —
 * or a provider with nothing to add — this answers null and SillyTavern draws the dialog it always has.
 *
 * The FIELD NAMES stay SillyTavern's (`current`, `password`, `confirm`), because they are the credential
 * slots this application actually has and can actually send back. A provider chooses which to show and what
 * to call them; it cannot invent a fourth, because there would be nowhere for the answer to go.
 *
 * ⚠️ A handle other than your own is admin-only. The dialog for someone else's account is a different
 * conversation (you cannot be asked for a password you do not know), and it must not be a way to ask the
 * server questions about accounts that are not yours.
 */
router.get('/password-form', async (request, response) => {
    try {
        const self = request.user.profile.handle;
        const handle = String(request.query.handle || self);

        if (handle !== self && !request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Password form denied: a non-admin asked about another account');
            log.error(LogClass.SENSITIVE, 'Password form denied:', self, 'is not an admin and asked about', handle);
            return response.sendStatus(403);
        }

        return response.json({ text: storage.describe('password.change', { handle, self: handle === self }) });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Could not read the password form');
        log.error(LogClass.SENSITIVE, 'Could not read the password form:', error);
        return response.sendStatus(500);
    }
});

router.post('/recovery-secret/acknowledge', async (request, response) => {
    try {
        storage.acknowledgeRecoverySecret(request.user.profile.handle);
        log.info(LogClass.SENSITIVE, color.green(`${request.user.profile.name} confirmed they have saved their recovery key.`));
        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Could not acknowledge the recovery secret');
        log.error(LogClass.SENSITIVE, 'Could not acknowledge the recovery secret:', error);
        return response.sendStatus(500);
    }
});
