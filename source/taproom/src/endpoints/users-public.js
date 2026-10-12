import * as storage from '../storage.js';

import crypto from 'node:crypto';

import accountStorage from 'node-persist';
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getIpAddress, retryAfter } from '../express-common.js';
import { color, Cache, getConfigValue } from '../util.js';
import { KEY_PREFIX, getPublicUserAvatar, toKey, getPasswordHash, getPasswordSalt, getAccountVersion, blankPasswordRefusal } from '../users.js';
import { log, LogClass, redact } from '../logger.js';

const DISCREET_LOGIN = getConfigValue('enableDiscreetLogin', false, 'boolean');
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const LOGIN_POINTS = getConfigValue('rateLimiting.accountsLoginMaxAttempts', 5, 'number');
const RECOVER_POINTS = getConfigValue('rateLimiting.accountsRecoverMaxAttempts', 5, 'number');


export const router = express.Router();
const loginLimiter = new RateLimiterMemory({
    points: LOGIN_POINTS > 0 ? LOGIN_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});
const recoverLimiter = new RateLimiterMemory({
    points: RECOVER_POINTS > 0 ? RECOVER_POINTS : Number.MAX_SAFE_INTEGER,
    duration: 300,
});

/** Codes printed to the server console by `/recover-step1`, waiting to be traded in by `/recover-step2`. */
const MFA_CACHE = new Cache(5 * 60 * 1000);

const generateRecoveryCode = () => Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');

/**
 * Why did the provider say no?
 *
 * 🔴 REPEAT ITS ANSWER. DO NOT COMPOSE ONE.
 *
 * The provider is the only party that knows why it refused, and SillyTavern is in no position to guess: a
 * refusal may mean the password was simply wrong, or that the request was impossible, and telling a user
 * with a typo that their data nearly died would send them hunting for a recovery key they do not need.
 *
 * The fallback is used only when a provider throws something with nothing to say, and it deliberately
 * asserts NOTHING about what the provider is or does.
 * @param {unknown} error Whatever the provider threw
 * @param {string} fallback What to say if it said nothing
 * @returns {string} The message to show the user
 */
function providerReason(error, fallback) {
    return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The provider's own account of why a password cannot simply be reset, and how to get back in.
 *
 * 🔴 SILLYTAVERN DOES NOT KNOW WHY. It knows only that `ownsUser()` said yes, which means a blind reset
 * would destroy something. What that something is, and what the user should do instead, is the provider's
 * to say — so it says it, and if it says nothing we fall back to a sentence that claims nothing.
 *
 * `recoveryKeyRequired` is asked of the API, not assumed. A provider may own a user and have no way back
 * in at all; sending that user to a recovery-key box they can never fill would be a dead end dressed up as
 * a door.
 * @param {string} handle User handle
 * @returns {{error: string, recoveryKeyRequired: boolean, recovery: import('../storage.js').ProviderText|null}} The refusal
 */
function passwordResetRefusal(handle) {
    const canRecover = storage.canRecover(handle);
    const text = storage.describe('password.recover', { handle });

    return {
        error: text?.body ?? 'The storage provider for this account does not allow its password to be reset.',
        recoveryKeyRequired: canRecover,
        recovery: canRecover ? text : null,
    };
}

/**
 * Set a user's password, and keep any live session of theirs valid.
 * @param {import('../users.js').User} user The user
 * @param {string} newPassword The new password, or '' to clear it
 * @param {import('express').Request} request The request, so an existing session can be re-versioned
 * @returns {Promise<void>}
 */
async function setPassword(user, newPassword, request) {
    const salt = newPassword ? getPasswordSalt() : '';
    user.password = newPassword ? getPasswordHash(newPassword, salt) : '';
    user.salt = salt;
    await accountStorage.setItem(toKey(user.handle), user);

    if (request.session && request.session.handle === user.handle) {
        request.session.version = getAccountVersion(user);
    }
}

router.post('/list', async (_request, response) => {
    try {
        if (DISCREET_LOGIN) {
            return response.sendStatus(204);
        }

        /** @type {import('../users.js').User[]} */
        const users = await accountStorage.values(x => x.key.startsWith(KEY_PREFIX));

        /** @type {Promise<import('../users.js').UserViewModel>[]} */
        // ⚠️ A PLAIN ASYNC MAP, BECAUSE THE OLD SHAPE COULD NOT FAIL. This was `new Promise(async resolve =>
        // ...)` with no reject: upstream's avatar lookup could not throw, but this fork's asks the provider,
        // and a provider that throws for one handle left that promise permanently unsettled — the request
        // hung, and the rejection escaped to a listener that was not there. On an anonymous endpoint.
        const viewModelPromises = users
            .filter(x => x.enabled)
            .map(async user => ({
                handle: user.handle,
                name: user.name,
                created: user.created,
                avatar: await getPublicUserAvatar(user.handle),
                password: !!user.password,
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

router.post('/login', async (request, response) => {
    try {
        if (!request.body.handle) {
            log.warn(LogClass.NORMAL, 'Login failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await loginLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.error(LogClass.NORMAL, 'Login failed: User not found');
            log.error(LogClass.SENSITIVE, 'Login failed: User', request.body.handle, 'not found');
            return response.status(403).json({ error: 'Incorrect credentials' });
        }

        if (!user.enabled) {
            log.warn(LogClass.SENSITIVE, 'Login failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        if (user.password && user.password !== getPasswordHash(request.body.password, user.salt)) {
            log.warn(LogClass.NORMAL, 'Login failed: Incorrect password for', redact(user.handle));
            return response.status(403).json({ error: 'Incorrect credentials' });
        }

        if (!request.session) {
            log.error(LogClass.NORMAL, 'Session not available');
            return response.sendStatus(500);
        }

        // 🔴 THIS IS ONE OF ONLY THREE PLACES IN SILLYTAVERN WHERE THE PASSWORD EXISTS IN PLAINTEXT.
        //
        // A provider may need a secret to become ready, and the only moment it can possibly have one is
        // the moment the user types it. Once this handler returns, the password is gone.
        //
        // The fork does not know or care what the provider does with it. It hands it over, and if the
        // provider cannot make the user's storage ready, the login FAILS — because a "successful" login
        // that leaves the data unreadable is not a successful login, it is a confusing one.
        try {
            await storage.unlock(user.handle, request.body.password);
        } catch (error) {
            log.error(LogClass.NORMAL, 'Login failed: the storage provider could not unlock this account');
            log.error(LogClass.SENSITIVE, 'Login failed: the storage provider could not unlock', user.handle, error);

            // Do not invent the reason. The provider is the only party that knows why it said no; repeat
            // what it said. See the same pattern on /change-password.
            return response.status(403).json({ error: providerReason(error, 'The storage provider could not make this account\'s data available.') });
        }

        await loginLimiter.delete(ip);
        request.session.handle = user.handle;
        request.session.version = getAccountVersion(user);
        log.info(LogClass.SENSITIVE, 'Login successful:', user.handle, 'from', ip, 'at', new Date().toLocaleString());
        return response.json({ handle: user.handle });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            log.error(LogClass.NORMAL, 'Login failed: Rate limited');
            log.error(LogClass.SENSITIVE, 'Login failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or recover your password.' });
        }

        log.error(LogClass.NORMAL, 'Login failed');
        log.error(LogClass.SENSITIVE, 'Login failed:', error);
        return response.sendStatus(500);
    }
});

// ---------------------------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------------------------
//
// 🔴 THERE ARE TWO DOORS BACK IN, AND EXACTLY ONE OF THEM IS OPEN AT A TIME.
//
// SillyTavern's own reset -- /recover-step1 prints a code to the SERVER CONSOLE, /recover-step2 trades
// it for a new password, no old password required -- is safe against the plain filesystem and fatal
// against an encrypting provider.
//
// Safe, because the data is already plaintext on the disk. Whoever can read the console to get the code
// can just read the chats. The reset gives an attacker nothing that box access did not already give.
//
// Fatal, because a provider keyed from the password holds a wrapped key whose ONLY pre-image is that
// password. Overwrite it with no key in hand and the data is not leaked -- it is ORPHANED. Every chat
// still on the disk, still perfectly encrypted, and nothing in the universe able to read it again. That
// is worse than leaked, and it is silent.
//
// So the rule is one sentence, and both doors fall out of it:
//
//     A password may be changed only when the key can be re-wrapped, or when there is no key.
//
// No provider  -> no key      -> the console reset is allowed, exactly as upstream.
// A provider   -> there is a key -> the console reset is REFUSED, and /recover-with-key is the way in,
//                                because a recovery key held off the machine is proof of ownership.
//                                A code printed to the machine's own console is not.

router.post('/recover-step1', async (request, response) => {
    try {
        if (!request.body.handle) {
            log.warn(LogClass.NORMAL, 'Recover step 1 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await recoverLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.error(LogClass.NORMAL, 'Recover step 1 failed: User not found');
            log.error(LogClass.SENSITIVE, 'Recover step 1 failed: User', request.body.handle, 'not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            log.error(LogClass.NORMAL, 'Recover step 1 failed: User is disabled');
            log.error(LogClass.SENSITIVE, 'Recover step 1 failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        // 🔴 The guard. A console code cannot unwrap anything.
        if (storage.ownsUser(user.handle)) {
            log.error(LogClass.NORMAL, 'Recover step 1 refused: storage for this account is held by a provider. A blind reset would orphan their data.');
            log.error(LogClass.SENSITIVE, 'Recover step 1 refused: storage for', user.handle, 'is held by a provider. A blind reset would orphan their data.');
            // 🔴 THE REASON IS THE PROVIDER'S TO GIVE, NOT OURS TO INVENT. SillyTavern does not know what
            // this provider is — only that it said a blind reset would destroy something. The client turns
            // this into the recovery prompt; a caller holding a curl gets the provider's own words.
            return response.status(403).json(passwordResetRefusal(user.handle));
        }

        // Split per §5.3, and the split is the whole point here. The code has to be printed or the
        // recovery flow has no delivery mechanism at all — the operator reads it off the console.
        // But it is upstream's line that carried `user.name` alongside it, and a display name is
        // encrypted at rest, so printing it would defeat §3 for the sake of a greeting. The code
        // itself is a freshly generated random number, single-use and consumed by step 2 — not user
        // data, and the one part that must stay visible.
        const mfaCode = generateRecoveryCode();
        log.info(LogClass.NORMAL);
        log.info(LogClass.NORMAL, color.blue('Your password recovery code is: ') + color.magenta(mfaCode));
        log.info(LogClass.NORMAL);
        log.info(LogClass.SENSITIVE, `Password recovery code issued for ${user.name}.`);
        MFA_CACHE.set(user.handle, mfaCode);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            log.error(LogClass.NORMAL, 'Recover step 1 failed: Rate limited');
            log.error(LogClass.SENSITIVE, 'Recover step 1 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        log.error(LogClass.NORMAL, 'Recover step 1 failed');
        log.error(LogClass.SENSITIVE, 'Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step2', async (request, response) => {
    try {
        if (!request.body.handle || !request.body.code) {
            log.warn(LogClass.NORMAL, 'Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        const rateLimit = await recoverLimiter.get(ip);

        if (rateLimit !== null && rateLimit.consumedPoints > recoverLimiter.points) {
            throw rateLimit;
        }

        if (!user) {
            log.error(LogClass.NORMAL, 'Recover step 2 failed: User not found');
            log.error(LogClass.SENSITIVE, 'Recover step 2 failed: User', request.body.handle, 'not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            log.warn(LogClass.SENSITIVE, 'Recover step 2 failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        // 🔴 The same guard, again. Step 1 already refuses, so no legitimate caller can be holding a code
        // -- but a provider may have been registered between the two requests, and this is the request
        // that actually writes the password. Guard the thing that does the damage, not just the thing
        // that leads to it.
        if (storage.ownsUser(user.handle)) {
            log.error(LogClass.NORMAL, 'Recover step 2 refused: storage for this account is held by a provider. A blind reset would orphan their data.');
            log.error(LogClass.SENSITIVE, 'Recover step 2 refused: storage for', user.handle, 'is held by a provider. A blind reset would orphan their data.');
            // 🔴 THE REASON IS THE PROVIDER'S TO GIVE, NOT OURS TO INVENT. SillyTavern does not know what
            // this provider is — only that it said a blind reset would destroy something. The client turns
            // this into the recovery prompt; a caller holding a curl gets the provider's own words.
            return response.status(403).json(passwordResetRefusal(user.handle));
        }

        // A blank new password is refused before the code is looked at, so a refused attempt neither spends the
        // rate limit nor the code. Under a provider the guard above has already answered, so this is the
        // backstop for a server whose provider check ever lets one through (see BLANK_PASSWORD_REFUSAL in users.js).
        const blankRefusal = blankPasswordRefusal(request.body.newPassword);

        if (blankRefusal) {
            log.warn(LogClass.NORMAL, 'Recover step 2 refused: the new password was blank on a server that requires one');
            return response.status(400).json({ error: blankRefusal });
        }

        const mfaCode = MFA_CACHE.get(user.handle);

        if (request.body.code !== mfaCode) {
            await recoverLimiter.consume(ip);
            log.warn(LogClass.NORMAL, 'Recover step 2 failed: Incorrect code');
            return response.status(403).json({ error: 'Incorrect code' });
        }

        await setPassword(user, request.body.newPassword ?? '', request);

        await recoverLimiter.delete(ip);
        MFA_CACHE.remove(user.handle);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            log.error(LogClass.NORMAL, 'Recover step 2 failed: Rate limited');
            log.error(LogClass.SENSITIVE, 'Recover step 2 failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        log.error(LogClass.NORMAL, 'Recover step 2 failed');
        log.error(LogClass.SENSITIVE, 'Recover step 2 failed:', error);
        return response.sendStatus(500);
    }
});

/**
 * The second door: recover an encrypted account with the recovery key.
 *
 * One action, both halves. The provider unwraps the data key with the recovery secret and re-wraps it
 * under the new password; SillyTavern then sets that password. Access to the account and access to the
 * data are restored together, because under encryption they are the same thing.
 *
 * 🔴 THE ORDER IS LOAD-BEARING. The provider re-keys FIRST. Only if that succeeds does the password
 * change. Reverse them and a wrong recovery key would leave the user with a new password and a vault
 * that no longer opens to it -- locked out by their own recovery attempt.
 */
router.post('/recover-with-key', async (request, response) => {
    try {
        if (!request.body.handle || !request.body.recoveryKey || !request.body.newPassword) {
            log.warn(LogClass.NORMAL, 'Recovery failed: Missing required fields');
            return response.status(400).json({ error: 'A handle, a recovery key and a new password are all required.' });
        }

        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);
        await recoverLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await accountStorage.getItem(toKey(request.body.handle));

        if (!user) {
            log.error(LogClass.NORMAL, 'Recovery failed: User not found');
            log.error(LogClass.SENSITIVE, 'Recovery failed: User', request.body.handle, 'not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            log.error(LogClass.NORMAL, 'Recovery failed: User is disabled');
            log.error(LogClass.SENSITIVE, 'Recovery failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        if (!storage.canRecover(user.handle)) {
            log.error(LogClass.NORMAL, 'Recovery failed: there is no recovery path for this account');
            log.error(LogClass.SENSITIVE, 'Recovery failed: there is no recovery path for', user.handle);
            return response.status(400).json({ error: 'The storage provider for this account offers no way to recover it.' });
        }

        // The provider goes first, and it is allowed to refuse. A wrong key throws here, and the password
        // below is never touched.
        try {
            await storage.recover(user.handle, request.body.recoveryKey, request.body.newPassword);
        } catch (error) {
            log.error(LogClass.NORMAL, 'Recovery failed: the storage provider rejected the recovery key');
            log.error(LogClass.SENSITIVE, 'Recovery failed: the storage provider rejected the recovery key for', user.handle, error);
            return response.status(403).json({ error: providerReason(error, 'The storage provider rejected that recovery key.') });
        }

        await setPassword(user, request.body.newPassword, request);

        await recoverLimiter.delete(ip);
        log.info(LogClass.SENSITIVE, color.green(`${user.name} recovered their account with their recovery key. Their storage is unlocked and their password has been changed.`));
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            log.error(LogClass.NORMAL, 'Recovery failed: Rate limited');
            log.error(LogClass.SENSITIVE, 'Recovery failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER));
            return retryAfter(response, error).status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        log.error(LogClass.NORMAL, 'Recovery failed');
        log.error(LogClass.SENSITIVE, 'Recovery failed:', error);
        return response.sendStatus(500);
    }
});
