import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import * as storage from '../storage.js';
import { log, LogClass } from '../logger.js';

export const router = express.Router();

router.post('/save', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    const filename = path.join(request.user.directories.themes, sanitize(`${request.body.name}.json`));
    storage.writeFileSync(filename, JSON.stringify(request.body, null, 4), 'utf8');

    return response.sendStatus(200);
});

router.post('/delete', (request, response) => {
    if (!request.body || !request.body.name) {
        return response.sendStatus(400);
    }

    try {
        const filename = path.join(request.user.directories.themes, sanitize(`${request.body.name}.json`));
        if (!storage.exists(filename)) {
            log.error(LogClass.NORMAL, 'The theme to delete was not found on disk');
            log.error(LogClass.SENSITIVE, 'Theme file not found:', filename);
            return response.sendStatus(404);
        }
        storage.unlink(filename);
        return response.sendStatus(200);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to delete theme');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});
