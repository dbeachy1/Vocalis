/**
 * When applied, this middleware will ensure the request contains the required header for basic authentication and only
 * allow access to the endpoint after successful authentication.
 */
import * as storage from '../storage.js';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import accountStorage from 'node-persist';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getAllUserHandles, toKey, getPasswordHash, isUnattendedPath } from '../users.js';
import { getConfigValue, safeReadFileSync } from '../util.js';
import { getIpAddress, retryAfter } from '../express-common.js';
import { log, LogClass } from '../logger.js';

const PER_USER_BASIC_AUTH = !!getConfigValue('perUserBasicAuth', false, 'boolean');
const ENABLE_ACCOUNTS = !!getConfigValue('enableUserAccounts', false, 'boolean');
const PREFER_REAL_IP_HEADER = !!getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const BASIC_AUTH_ATTEMPTS = getConfigValue('rateLimiting.basicAuthMaxAttempts', 5, 'number');

const basicAuthLimiter = new RateLimiterMemory({
    points: BASIC_AUTH_ATTEMPTS > 0 ? BASIC_AUTH_ATTEMPTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});

const basicAuthMiddleware = async function (request, response, callback) {
    const unauthorizedResponse = (res) => {
        const unauthorizedWebpage = safeReadFileSync(path.join(globalThis.DATA_ROOT, '_errors', 'unauthorized.html')) ?? '';
        res.set('WWW-Authenticate', 'Basic realm="SillyTavern", charset="UTF-8"');
        return res.status(401).send(unauthorizedWebpage);
    };

    try {
        const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);

        const basicAuthUserName = getConfigValue('basicAuthUser.username');
        const basicAuthUserPassword = getConfigValue('basicAuthUser.password');
        const authHeader = request.headers.authorization;

        if (!authHeader) {
            return unauthorizedResponse(response);
        }

        const [scheme, credentials] = authHeader.split(' ');

        if (scheme !== 'Basic' || !credentials) {
            return unauthorizedResponse(response);
        }

        const rateLimit = await basicAuthLimiter.get(ip);

        if (rateLimit !== null && rateLimit.consumedPoints > basicAuthLimiter.points) {
            throw rateLimit;
        }

        const usePerUserAuth = PER_USER_BASIC_AUTH && ENABLE_ACCOUNTS;
        const [username, ...passwordParts] = Buffer.from(credentials, 'base64')
            .toString('utf8')
            .split(':');
        const password = passwordParts.join(':');

        if (!usePerUserAuth && username === basicAuthUserName && password === basicAuthUserPassword) {
            await basicAuthLimiter.delete(ip);
            return callback();
        } else if (usePerUserAuth) {
            const userHandles = await getAllUserHandles();
            for (const userHandle of userHandles) {
                if (username === userHandle) {
                    const user = await accountStorage.getItem(toKey(userHandle));
                    if (user && user.enabled && (user.password && user.password === getPasswordHash(password, user.salt))) {
                        // 🔴 A REQUEST THE USER DID NOT MAKE MUST NOT RE-OPEN A VAULT THE SWEEP JUST SHUT.
                        //
                        // This middleware runs 22 lines before `setUserDataMiddleware`, which is where
                        // NOT_ACTIVITY is normally consulted — so under `perUserBasicAuth` the browser's own
                        // 30-second `/api/users/idle-status` poll arrived here first, carrying cached
                        // credentials, and unlocked. `storage.unlock` does not short-circuit on an already
                        // ready store either: `wasReady` gates only the notification, so a re-unlock of a
                        // SHUT store fires `notifyUserStorageReady`, which calls `recordUserActivity` and
                        // resets the very clock that had just run out. An open tab on another desktop could
                        // hold a vault open for ever, and it would look exactly like the feature working.
                        //
                        // The password is still checked above — this only declines to act on it. Letting the
                        // request through unlocked is correct: `setUserDataMiddleware` answers it 403, which
                        // is what the poll is asking to be told.
                        if (!isUnattendedPath(request.path) || storage.isReady(userHandle)) {
                            // The third and last place the password exists. See the note in users-public.js.
                            await storage.unlock(userHandle, password);
                        }

                        await basicAuthLimiter.delete(ip);
                        return callback();
                    }
                }
            }
        }

        await basicAuthLimiter.consume(ip);
        return unauthorizedResponse(response);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            log.error(LogClass.NORMAL, 'Basic auth failed: rate limited.');
            log.error(LogClass.SENSITIVE, 'Basic auth failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER), request.method, request.originalUrl);
            return retryAfter(response, error).sendStatus(429);
        }
        log.error(LogClass.NORMAL, 'Basic auth error');
        log.error(LogClass.SENSITIVE, 'Basic auth error:', error);
        return response.sendStatus(500);
    }
};

export default basicAuthMiddleware;
