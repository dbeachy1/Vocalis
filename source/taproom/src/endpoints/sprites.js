import path from 'node:path';

import express from 'express';
import mime from 'mime-types';
import sanitize from 'sanitize-filename';
import * as storage from '../storage.js';

import { getImageBuffers } from '../util.js';
import { log, LogClass } from '../logger.js';

/**
 * Gets the path to the sprites folder for the provided character name
 * @param {import('../users.js').UserDirectoryList} directories - User directories
 * @param {string} name - The name of the character
 * @param {boolean} isSubfolder - Whether the name contains a subfolder
 * @returns {string | null} The path to the sprites folder. Null if the name is invalid.
 */
function getSpritesPath(directories, name, isSubfolder) {
    if (isSubfolder) {
        const nameParts = name.split('/');
        const characterName = sanitize(nameParts[0]);
        const subfolderName = sanitize(nameParts[1]);

        if (!characterName || !subfolderName) {
            return null;
        }

        return path.join(directories.characters, characterName, subfolderName);
    }

    name = sanitize(name);

    if (!name) {
        return null;
    }

    return path.join(directories.characters, name);
}

/**
 * Imports base64 encoded sprites from RisuAI character data.
 * The sprites are saved in the character's sprites folder.
 * The additionalAssets and emotions are removed from the data.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {object} data RisuAI character data
 * @returns {void}
 */
export function importRisuSprites(directories, data) {
    try {
        const name = data?.data?.name;
        const risuData = data?.data?.extensions?.risuai;

        // Not a Risu AI character
        if (!risuData || !name) {
            return;
        }

        let images = [];

        if (Array.isArray(risuData.additionalAssets)) {
            images = images.concat(risuData.additionalAssets);
        }

        if (Array.isArray(risuData.emotions)) {
            images = images.concat(risuData.emotions);
        }

        // No sprites to import
        if (images.length === 0) {
            return;
        }

        // Create sprites folder if it doesn't exist
        const spritesPath = getSpritesPath(directories, name, false);

        // Invalid sprites path
        if (!spritesPath) {
            return;
        }

        // Create sprites folder if it doesn't exist
        if (!storage.exists(spritesPath)) {
            storage.mkdir(spritesPath, { recursive: true });
        }

        // Path to sprites is not a directory. This should never happen.
        if (!storage.stat(spritesPath).isDirectory()) {
            return;
        }

        // Split per §5.3: the count is a number and stays visible, the character name is user-authored.
        log.info(LogClass.NORMAL, `RisuAI: Found ${images.length} sprites for a character. Writing to disk.`);
        log.info(LogClass.SENSITIVE, 'RisuAI: sprite import character:', name);
        const files = storage.readdir(spritesPath);

        outer: for (const [label, fileBase64] of images) {
            // Remove existing sprite with the same label
            for (const file of files) {
                if (path.parse(file).name === label) {
                    log.warn(LogClass.SENSITIVE, `RisuAI: The sprite ${label} for ${name} already exists. Skipping.`);
                    continue outer;
                }
            }

            const filename = label + '.png';
            const pathToFile = path.join(spritesPath, sanitize(filename));
            storage.writeFileSync(pathToFile, fileBase64, { encoding: 'base64' });
        }

        // Remove additionalAssets and emotions from data (they are now in the sprites folder)
        delete data.data.extensions.risuai.additionalAssets;
        delete data.data.extensions.risuai.emotions;
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to import RisuAI sprites for a character');
        log.error(LogClass.SENSITIVE, error);
    }
}

export const router = express.Router();

router.get('/get', function (request, response) {
    const name = String(request.query.name);
    const isSubfolder = name.includes('/');
    const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);
    let sprites = [];

    try {
        if (spritesPath && storage.exists(spritesPath) && storage.stat(spritesPath).isDirectory()) {
            sprites = storage.readdir(spritesPath)
                .filter(file => {
                    const mimeType = mime.lookup(file);
                    return mimeType && mimeType.startsWith('image/');
                })
                .map((file) => {
                    const pathToSprite = path.join(spritesPath, file);
                    const mtime = storage.stat(pathToSprite).mtime?.toISOString().replace(/[^0-9]/g, '').slice(0, 14);

                    const fileName = path.parse(pathToSprite).name.toLowerCase();
                    // Extract the label from the filename via regex, which can be suffixed with a sub-name, either connected with a dash or a dot.
                    // Examples: joy.png, joy-1.png, joy.expressive.png
                    const label = fileName.match(/^(.+?)(?:[-\\.].*?)?$/)?.[1] ?? fileName;

                    return {
                        label: label,
                        path: `/characters/${name}/${file}` + (mtime ? `?t=${mtime}` : ''),
                    };
                });
        }
    } catch (err) {
        log.error(LogClass.NORMAL, 'Failed to list sprites for a character');
        log.error(LogClass.SENSITIVE, err);
    }
    return response.send(sprites);
});

router.post('/delete', async (request, response) => {
    const label = request.body.label;
    const name = String(request.body.name);
    const isSubfolder = name.includes('/');
    const spriteName = request.body.spriteName || label;

    if (!spriteName || !name) {
        return response.sendStatus(400);
    }

    try {
        const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);

        // No sprites folder exists, or not a directory
        if (!spritesPath || !storage.exists(spritesPath) || !storage.stat(spritesPath).isDirectory()) {
            return response.sendStatus(404);
        }

        const files = storage.readdir(spritesPath);

        // Remove existing sprite with the same label
        for (const file of files) {
            if (path.parse(file).name === spriteName) {
                storage.unlink(path.join(spritesPath, file));
            }
        }

        return response.sendStatus(200);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to delete a sprite');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/upload-zip', async (request, response) => {
    const file = request.file;
    const name = String(request.body.name);
    const isSubfolder = name.includes('/');

    if (!file || !name) {
        return response.sendStatus(400);
    }

    try {
        const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);

        // Invalid sprites path
        if (!spritesPath) {
            return response.sendStatus(400);
        }

        // Create sprites folder if it doesn't exist
        if (!storage.exists(spritesPath)) {
            storage.mkdir(spritesPath, { recursive: true });
        }

        // Path to sprites is not a directory. This should never happen.
        if (!storage.stat(spritesPath).isDirectory()) {
            return response.sendStatus(404);
        }

        const spritePackPath = path.join(file.destination, file.filename);
        const sprites = await getImageBuffers(spritePackPath);
        const files = storage.readdir(spritesPath);

        for (const [filename, buffer] of sprites) {
            // Remove existing sprite with the same label
            const existingFile = files.find(file => path.parse(file).name === path.parse(filename).name);

            if (existingFile) {
                storage.unlink(path.join(spritesPath, existingFile));
            }

            // Write sprite buffer to disk
            const pathToSprite = path.join(spritesPath, sanitize(filename));
            storage.writeFileSync(pathToSprite, buffer);
        }

        // Remove uploaded ZIP file
        storage.unlink(spritePackPath);
        return response.send({ ok: true, count: sprites.length });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to upload a sprite pack ZIP');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});

router.post('/upload', async (request, response) => {
    const file = request.file;
    const label = request.body.label;
    const name = String(request.body.name);
    const isSubfolder = name.includes('/');
    const spriteName = request.body.spriteName || label;

    if (!file || !label || !name) {
        return response.sendStatus(400);
    }

    try {
        const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);

        // Invalid sprites path
        if (!spritesPath) {
            return response.sendStatus(400);
        }

        // Create sprites folder if it doesn't exist
        if (!storage.exists(spritesPath)) {
            storage.mkdir(spritesPath, { recursive: true });
        }

        // Path to sprites is not a directory. This should never happen.
        if (!storage.stat(spritesPath).isDirectory()) {
            return response.sendStatus(404);
        }

        const files = storage.readdir(spritesPath);

        // Remove existing sprite with the same label
        for (const file of files) {
            if (path.parse(file).name === spriteName) {
                storage.unlink(path.join(spritesPath, file));
            }
        }

        const filename = spriteName + path.parse(file.originalname).ext;
        const spritePath = path.join(file.destination, file.filename);
        const pathToFile = path.join(spritesPath, sanitize(filename));
        // Copy uploaded file to sprites folder
        storage.cp(spritePath, pathToFile);
        // Remove uploaded file
        storage.unlink(spritePath);
        return response.send({ ok: true });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to upload a sprite');
        log.error(LogClass.SENSITIVE, error);
        return response.sendStatus(500);
    }
});
