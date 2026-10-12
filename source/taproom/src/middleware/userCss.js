import path from 'node:path';

import * as storage from '../storage.js';
import { log, LogClass } from '../logger.js';

/**
 * Serves the user's own CSS file, if they have one.
 *
 * 🔴 THIS USED TO READ <DATA_ROOT>/_css/user.css AND SERVE IT TO ANYONE WHO ASKED.
 *
 * The middleware was mounted seven lines BEFORE requireLoginMiddleware, so `GET /css/user.css` was
 * answered for unauthenticated clients — and the file was keyed off the global DATA_ROOT rather than
 * any user directory, so there was no `req.user` to attribute it to even in principle. User-authored
 * content, served to strangers, living outside every user directory.
 *
 * It is now user data like everything else: it lives at <DATA_ROOT>/<handle>/user.css, it is served
 * only to the user who owns it, and only when their storage can actually be read.
 *
 * The consequence is deliberate and worth stating plainly: a user whose storage cannot be read gets an
 * UNSTYLED page. That is the correct trade. The alternative is decrypting a file for someone who has
 * not yet proved who they are.
 * @type {import('express').Handler}
 */
export function userCssMiddleware(req, res, next) {
    if (req.method !== 'GET' || req.path !== '/css/user.css') {
        return next();
    }

    const directories = req.user?.directories;

    if (!directories) {
        return next();
    }

    const userCssPath = path.resolve(path.join(directories.root, 'user.css'));

    try {
        if (!storage.exists(userCssPath)) {
            return next();
        }

        storage.sendFile(res, userCssPath).catch((error) => {
            log.error(LogClass.NORMAL, 'Failed to serve user.css');
            log.error(LogClass.SENSITIVE, 'Failed to serve user.css:', error);

            if (!res.headersSent) {
                res.sendStatus(500);
            }
        });
    } catch (error) {
        // Storage that cannot be read is not a styling emergency. Fall through and let the page render
        // unstyled rather than failing the whole request.
        log.error(LogClass.NORMAL, 'Could not read user.css');
        log.error(LogClass.SENSITIVE, 'Could not read user.css:', error);
        return next();
    }
}

export default userCssMiddleware;
