/**
 * Generic image metadata service.
 * Provides on-demand metadata generation with file mtime-based caching.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import * as storage from '../storage.js';
import express from 'express';
import { Jimp } from '../jimp.js';
import { getConfigValue, isPathUnderParent, uuidv4 } from '../util.js';
import { log, LogClass } from '../logger.js';

export const METADATA_FILE = 'image-metadata.json';

/**
 * @typedef {Object} ImageMetadata
 * @property {string} [hash] - SHA-256 hash of the image file.
 * @property {number} [aspectRatio] - Aspect ratio (width / height) of the image.
 * @property {boolean} [isAnimated] - Whether the image is animated.
 * @property {string} [dominantColor] - Dominant color in hex format (e.g., '#RRGGBB').
 * @property {string[]} folderIds - Array of virtual folder IDs the image belongs to.
 * @property {number} [addedTimestamp] - Timestamp when the image was added.
 * @property {number} [thumbnailResolution] - Thumbnail resolution (width * height) for cache invalidation.
 * @property {number} [mtime] - File modification time for cache invalidation (internal use).
 */

/**
 * @typedef {Object} MetadataIndex
 * @property {number} version - Metadata version.
 * @property {Object.<string, ImageMetadata>} images - Mapping of relative paths to their metadata.
 * @property {Array<{id: string, name: string, thumbnailFile: string}>} folders - Virtual folders.
 */

/**
 * @typedef {'bg' | 'avatar' | 'persona' | 'face' | 'persona-face'} ThumbnailType
 */

/**
 * Thumbnail dimensions per type.
 *
 * ⚠️ For `bg`, `avatar` and `persona` these are a **target pixel area**, not exact dimensions —
 * the generated thumbnail keeps the source's aspect ratio and merely matches `width * height`.
 * A character cropped to 1:2 stays 1:2. Only the square `face` types are literal dimensions.
 *
 * `avatar`/`persona` are 144x216 rather than upstream's 96x144 because the rectangular chat
 * avatar renders ~60 CSS px wide, which is 120 device px on a HiDPI screen — 96 was already
 * soft before this fork let the rectangle grow taller.
 *
 * @type {Record<string, number[]>}
 */
export const thumbnailDimensions = {
    'bg': getConfigValue('thumbnails.dimensions.bg', [160, 90]),
    'avatar': getConfigValue('thumbnails.dimensions.avatar', [144, 216]),
    'persona': getConfigValue('thumbnails.dimensions.persona', [144, 216]),
    'face': getConfigValue('thumbnails.dimensions.face', [256, 256]),
    'persona-face': getConfigValue('thumbnails.dimensions.personaFace', [256, 256]),
};

/**
 * Gets the configured resolution for a given thumbnail type.
 * @param {ThumbnailType} type Thumbnail type
 * @returns {number} Resolution (width * height)
 */
export function getThumbnailResolution(type) {
    const dims = thumbnailDimensions[type];
    if (Array.isArray(dims) && dims.length >= 2) {
        return Number(dims[0]) * Number(dims[1]);
    }
    return 0;
}

/**
 * Checks if a buffer contains an animated PNG (APNG) by looking for the 'acTL' chunk.
 * @param {Buffer} buffer The file buffer.
 * @returns {boolean}
 */
export function isAnimatedApng(buffer) {
    return buffer.subarray(0, 200).includes('acTL');
}

/**
 * Checks if a WebP buffer is animated by looking for 'ANIM' or 'ANMF' chunks.
 * @param {Buffer} buffer The WebP file buffer (can be full file or header)
 * @returns {boolean} True if the WebP is animated
 */
export function isAnimatedWebP(buffer) {
    const headerBuffer = buffer.length > 200 ? buffer.subarray(0, 200) : buffer;
    return headerBuffer.includes('ANIM') || headerBuffer.includes('ANMF');
}

/**
 * Calculate average color using Jimp.
 * Resizes the image to 1x1 to efficiently get the average color.
 * @param {Buffer} buffer The image buffer.
 * @returns {Promise<string>} The average color as a hex string (e.g., '#RRGGBB').
 */
async function getAverageColorWithJimp(buffer) {
    try {
        const image = await Jimp.read(buffer);
        image.resize({ w: 1, h: 1 });

        const colorInt = image.getPixelColor(0, 0);
        const r = (colorInt >> 24) & 255;
        const g = (colorInt >> 16) & 255;
        const b = (colorInt >> 8) & 255;

        const toHex = (c) => c.toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    } catch (error) {
        log.warn(LogClass.SENSITIVE, '[Jimp] Failed to calculate average color:', error.message);
        return '#808080';
    }
}

/**
 * Generates metadata for a single image file.
 * @param {string} filePath - The full path to the image file.
 * @param {ThumbnailType} type - The thumbnail type for resolution calculation.
 * @returns {Promise<ImageMetadata>} A metadata object. Throws an error if processing fails.
 */
export async function generateImageMetadata(filePath, type) {
    // 🔴 THROUGH THE FUNNEL. This is a user's image, in the user's own directory. Read it with raw `fs` and
    // a transforming provider hands back bytes that are not an image at all — so the hash is a hash of the
    // wrong thing and `imageSize` reports "could not determine dimensions" on a file that is perfectly fine.
    const buffer = /** @type {Buffer} */ (await storage.readFile(filePath));
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const dimensions = imageSize(buffer);

    if (!dimensions || !dimensions.width || !dimensions.height) {
        throw new Error('Could not determine image dimensions.');
    }

    const aspectRatio = dimensions.width / dimensions.height;
    let isAnimated = false;

    switch (dimensions.type) {
        case 'gif':
            isAnimated = true;
            break;
        case 'png':
            isAnimated = isAnimatedApng(buffer);
            break;
        case 'webp':
            isAnimated = isAnimatedWebP(buffer);
            break;
    }

    let dominantColor;
    if (isAnimated) {
        dominantColor = '#808080';
    } else {
        dominantColor = await getAverageColorWithJimp(buffer);
    }

    let addedTimestamp;
    try {
        const stats = storage.stat(filePath);
        addedTimestamp = Math.floor(stats.birthtimeMs || stats.mtimeMs);
    } catch {
        addedTimestamp = Date.now();
    }

    return {
        hash,
        aspectRatio: parseFloat(aspectRatio.toFixed(4)),
        isAnimated,
        dominantColor,
        folderIds: [],
        addedTimestamp,
        thumbnailResolution: getThumbnailResolution(type),
    };
}

/**
 * One promise chain per user, so read-modify-write on their index cannot interleave.
 * @type {Map<string, Promise<any>>}
 */
const writeChains = new Map();

/**
 * Runs `work` with exclusive access to one user's metadata index.
 *
 * 🔴 EVERY MUTATOR IN THIS FILE READS, AWAITS, THEN WRITES — AND THE AWAIT IS WHERE THE OTHER ONE GETS IN.
 *
 * Opening the UI fires `POST /api/backgrounds/all`, which reads the index and then runs an await-heavy
 * generation loop: a `storage.readFile` plus a Jimp decode PER BACKGROUND. While that is in flight the user
 * clicks "new folder"; that handler reads the same index, appends its folder, writes. Then the backgrounds
 * handler finishes its loop and writes ITS copy — read before the folder existed — straight over the top.
 * The folder is gone, with a 200 on both requests and nothing logged. `images` would regenerate on the next
 * pass; `folders` and every hand-assigned `folderIds` would not.
 *
 * The provider seam widens the window considerably, because every one of those reads is now a decrypt.
 *
 * This is the same fix, for the same reason, as `serialise()` in character-ids.js — whose comment describes
 * the identical shape from the other direction ("two generations racing on a never-seen card would both
 * read absent, both mint, and the loser's UUID would be written over").
 * @param {string} userDataRoot Path to the user data directory root
 * @param {() => Promise<any>} work What to do while holding it
 * @returns {Promise<any>} Whatever `work` returned
 */
function serialise(userDataRoot, work) {
    // Chain onto whatever is in flight, and swallow ITS failure here so one caller's error does not reject
    // every caller queued behind it. The original promise is what the original caller awaits, so the error
    // is still delivered — exactly once, to the request that caused it.
    const previous = writeChains.get(userDataRoot) ?? Promise.resolve();
    const next = previous.catch(() => { }).then(work);

    writeChains.set(userDataRoot, next.catch(() => { }));
    return next;
}

/**
 * Reads the centralized metadata index from the user data root.
 * @param {string} userDataRoot - Path to the user data directory root
 * @returns {Promise<MetadataIndex>} The metadata index
 */
export async function readMetadataIndex(userDataRoot) {
    const indexPath = path.join(userDataRoot, METADATA_FILE);
    try {
        // 🔴 THROUGH THE FUNNEL, AND THE CATCH MUST NOT EAT A PROVIDER ERROR.
        //
        // This file is written with `storage.writeFile` and used to be read with a raw `fs.readFile`. Under
        // a transforming provider that read returned bytes JSON could not parse, the bare catch below turned
        // that into an EMPTY INDEX, and the very next `writeMetadataIndex` wrote the empty index over the
        // real one. `images` would eventually regenerate. `folders` — which the user made by hand — would
        // not. Silently, with no error, on an application that looked like it was working perfectly.
        //
        // "I could not read it" and "there is nothing there" are opposite facts, and this catch was the
        // place they got confused. ENOENT still means "no index yet, start a fresh one", which is why the
        // catch survives at all; a provider error means the index EXISTS and is not readable right now, and
        // it must propagate so the caller fails instead of rebuilding.
        const rawData = /** @type {string} */ (await storage.readFile(indexPath, 'utf8'));
        return JSON.parse(rawData);
    } catch (error) {
        if (storage.isStorageError(error)) {
            throw error;
        }

        // 🔴 AND ENOENT IS THE ONLY THING THAT MEANS "NOTHING THERE". Everything written above this line
        // was true and half-applied: the provider case was handled and the ordinary one was not, so a
        // `SyntaxError` out of `JSON.parse` — or an EACCES, or an EMFILE under a burst of thumbnail
        // requests — still returned a pristine empty index. The very next `writeMetadataIndex` then put
        // that over the real file. `images` regenerates; `folders` and every hand-assigned `folderIds`
        // do not. Silently, with a 200, on an app that looked like it was working perfectly.
        if (error?.code === 'ENOENT') {
            return { version: 1, images: {}, folders: [] };
        }

        throw error;
    }
}

/**
 * Writes the centralized metadata index to the user data root.
 * @param {string} userDataRoot - Path to the user data directory root
 * @param {MetadataIndex} metadata - The metadata to write
 */
export async function writeMetadataIndex(userDataRoot, metadata) {
    const indexPath = path.join(userDataRoot, METADATA_FILE);
    const jsonString = JSON.stringify(metadata, null, 4);
    await storage.writeFile(indexPath, jsonString, 'utf8');
}

/**
 * Gets metadata for multiple images, generating on-demand as needed.
 * Uses relative paths from the user data root as keys in the centralized index.
 * @param {string} userDataRoot - Path to the user data directory root
 * @param {string[]} relativePaths - Array of relative paths from userDataRoot
 * @param {ThumbnailType} type - The thumbnail type for resolution calculation.
 * @returns {Promise<{results: Object.<string, ImageMetadata>, generatedCount: number}>} Results map and count of newly generated
 */
async function getOrGenerateMetadataBatchUnserialised(userDataRoot, relativePaths, type) {
    /** @type {Object.<string, ImageMetadata>} */
    const results = {};
    const index = await readMetadataIndex(userDataRoot);
    let indexModified = false;
    let generatedCount = 0;

    for (const relativePath of relativePaths) {
        // Normalize the path to use forward slashes for consistent keys
        const posixPath = relativePath.replaceAll(path.sep, path.posix.sep);
        const fullPath = path.join(userDataRoot, relativePath);

        let stats;
        try {
            // Logical, not physical. A provider may store this file under another name entirely, in which
            // case a raw fs.stat of the logical path finds nothing and every image is skipped for ever.
            stats = storage.stat(fullPath);
        } catch {
            continue; // File doesn't exist, skip
        }

        const currentMtime = stats.mtimeMs;
        const cached = index.images[posixPath];

        // If cached and not modified, use cached
        if (cached && cached.mtime === currentMtime) {
            results[relativePath] = cached;
            continue;
        }

        // Generate new metadata
        try {
            const metadata = await generateImageMetadata(fullPath, type);
            metadata.mtime = currentMtime;

            // Preserve folderIds if they existed
            if (cached?.folderIds) {
                metadata.folderIds = cached.folderIds;
            }

            index.images[posixPath] = metadata;
            results[relativePath] = metadata;
            indexModified = true;
            generatedCount++;
        } catch (error) {
            log.warn(LogClass.SENSITIVE, `[ImageMetadata] Failed to generate metadata for ${relativePath}:`, error.message);
        }
    }

    // Write index if modified
    if (indexModified) {
        await writeMetadataIndex(userDataRoot, index);
    }

    return { results, generatedCount };
}

/**
 * Removes metadata for an image from the centralized index.
 * @param {string} userDataRoot - Path to the user data directory root
 * @param {string} relativePath - The relative path to remove
 */
async function removeMetadataUnserialised(userDataRoot, relativePath) {
    const posixPath = relativePath.replaceAll(path.sep, path.posix.sep);
    const index = await readMetadataIndex(userDataRoot);
    if (index.images[posixPath]) {
        delete index.images[posixPath];

        // Clear any folder thumbnailFile references that point to the deleted file
        const deletedFileName = path.posix.basename(posixPath);
        if (Array.isArray(index.folders)) {
            for (const folder of index.folders) {
                if (folder.thumbnailFile === deletedFileName) {
                    folder.thumbnailFile = '';
                }
            }
        }

        await writeMetadataIndex(userDataRoot, index);
    }
}

/**
 * Updates metadata for an image (e.g., after rename).
 * @param {string} userDataRoot - Path to the user data directory root
 * @param {string} oldRelativePath - The old relative path
 * @param {string} newRelativePath - The new relative path
 * @returns {Promise<ImageMetadata|null>} The updated metadata
 */
async function renameMetadataUnserialised(userDataRoot, oldRelativePath, newRelativePath) {
    const posixOldPath = oldRelativePath.replaceAll(path.sep, path.posix.sep);
    const posixNewPath = newRelativePath.replaceAll(path.sep, path.posix.sep);
    const index = await readMetadataIndex(userDataRoot);
    const data = index.images[posixOldPath];

    if (!data) {
        throw new Error(`Image '${oldRelativePath}' not found in metadata.`);
    }

    delete index.images[posixOldPath];
    index.images[posixNewPath] = data;

    // Update any folder thumbnailFile references that point to the old filename
    const oldFileName = path.posix.basename(posixOldPath);
    const newFileName = path.posix.basename(posixNewPath);
    if (oldFileName !== newFileName && Array.isArray(index.folders)) {
        for (const folder of index.folders) {
            if (folder.thumbnailFile === oldFileName) {
                folder.thumbnailFile = newFileName;
            }
        }
    }

    await writeMetadataIndex(userDataRoot, index);

    return data;
}

/**
 * Cleans up orphaned entries from the metadata index.
 * Iterates over all entries and removes those whose files no longer exist.
 * @param {string} userDataRoot - Path to the user data directory root
 * @returns {Promise<string[]>} Array of removed paths
 */
async function cleanupOrphanedMetadataUnserialised(userDataRoot) {
    const index = await readMetadataIndex(userDataRoot);
    const orphanedPaths = [];

    for (const relativePath of Object.keys(index.images)) {
        const fullPath = path.resolve(userDataRoot, relativePath);

        if (!isPathUnderParent(userDataRoot, fullPath)) {
            orphanedPaths.push(relativePath);
            delete index.images[relativePath];
            continue;
        }

        // 🔴 THIS DELETES. So it must be certain, and a raw fs.access cannot be.
        //
        // A provider may store this image under a different name on the disk — that is expressly allowed,
        // and the plugin this fork exists for does exactly that. `fs.access` on the LOGICAL path would then
        // fail for every single image, and this loop would cheerfully prune the entire index as "orphaned"
        // while every file was sitting there, present and intact.
        //
        // Ask the funnel. And if the funnel says "the data is there and I cannot reach it right now", that
        // is not an orphan either — let it throw rather than delete on a question we could not answer.
        if (!storage.exists(fullPath)) {
            orphanedPaths.push(relativePath);
            delete index.images[relativePath];
        }
    }

    if (orphanedPaths.length > 0) {
        await writeMetadataIndex(userDataRoot, index);
        log.info(LogClass.NORMAL, `[ImageMetadata] Cleaned up ${orphanedPaths.length} orphaned metadata entries`);
    }

    return orphanedPaths;
}

/**
 * Creates a new virtual folder.
 * @param {string} userDataRoot
 * @param {string} name
 * @returns {Promise<{id: string, name: string, thumbnailFile: string}>}
 */
async function createFolderUnserialised(userDataRoot, name) {
    const index = await readMetadataIndex(userDataRoot);
    const id = uuidv4();
    const folder = { id, name, thumbnailFile: '' };
    index.folders.push(folder);
    await writeMetadataIndex(userDataRoot, index);
    return folder;
}

/**
 * Sets thumbnail files for multiple folders in a single atomic read-modify-write.
 * Folders not found in the index are silently skipped.
 * @param {string} userDataRoot
 * @param {{id: string, thumbnailFile: string}[]} updates
 * @returns {Promise<void>}
 */
async function setFolderThumbnailsBatchUnserialised(userDataRoot, updates) {
    const index = await readMetadataIndex(userDataRoot);
    for (const { id, thumbnailFile } of updates) {
        const folder = index.folders.find(f => f.id === id);
        if (folder) {
            folder.thumbnailFile = thumbnailFile;
        }
    }
    await writeMetadataIndex(userDataRoot, index);
}

/**
 * Renames or updates a virtual folder.
 * @param {string} userDataRoot
 * @param {string} folderId
 * @param {{name?: string, thumbnailFile?: string}} updates
 * @returns {Promise<{id: string, name: string, thumbnailFile: string}>}
 */
async function updateFolderUnserialised(userDataRoot, folderId, updates) {
    const index = await readMetadataIndex(userDataRoot);
    const folder = index.folders.find(f => f.id === folderId);
    if (!folder) throw new Error(`Folder '${folderId}' not found.`);
    if (updates.name !== undefined) folder.name = updates.name;
    if (updates.thumbnailFile !== undefined) folder.thumbnailFile = updates.thumbnailFile;
    await writeMetadataIndex(userDataRoot, index);
    return folder;
}

/**
 * Deletes a virtual folder and removes its ID from all images.
 * @param {string} userDataRoot
 * @param {string} folderId
 * @returns {Promise<void>}
 */
async function deleteFolderUnserialised(userDataRoot, folderId) {
    const index = await readMetadataIndex(userDataRoot);
    const idx = index.folders.findIndex(f => f.id === folderId);
    if (idx === -1) throw new Error(`Folder '${folderId}' not found.`);
    index.folders.splice(idx, 1);
    // Remove folderId from all images
    for (const meta of Object.values(index.images)) {
        if (Array.isArray(meta.folderIds)) {
            const fi = meta.folderIds.indexOf(folderId);
            if (fi !== -1) meta.folderIds.splice(fi, 1);
        }
    }
    await writeMetadataIndex(userDataRoot, index);
}

/**
 * Assigns images to a folder.
 * @param {string} userDataRoot
 * @param {string} folderId
 * @param {string[]} relativePaths
 * @returns {Promise<void>}
 */
async function assignImagesToFolderUnserialised(userDataRoot, folderId, relativePaths) {
    const index = await readMetadataIndex(userDataRoot);
    if (!index.folders.some(f => f.id === folderId)) {
        throw new Error(`Folder '${folderId}' not found.`);
    }
    for (const rp of relativePaths) {
        const posixPath = rp.replaceAll(path.sep, path.posix.sep);

        // Validate: must be a backgrounds/ path, and no path-traversal segments
        const normalized = path.posix.normalize(posixPath);
        if (!normalized.startsWith('backgrounds/') || normalized.split('/').some(seg => seg === '..')) {
            throw new Error(`Invalid background path: '${posixPath}'`);
        }

        // Validate: skip silently on missing files
        const absPath = path.join(userDataRoot, normalized);
        if (!storage.exists(absPath)) {
            log.warn(LogClass.SENSITIVE, `[ImageMetadata] Skipping missing background file: '${posixPath}'`);
            continue;
        }

        let meta = index.images[normalized];
        if (!meta) {
            // Create a stub entry so folderIds can be stored even before full metadata generation
            meta = { folderIds: [] };
            index.images[normalized] = meta;
        }
        if (!Array.isArray(meta.folderIds)) meta.folderIds = [];
        if (!meta.folderIds.includes(folderId)) {
            meta.folderIds.push(folderId);
        }
    }
    await writeMetadataIndex(userDataRoot, index);
}

/**
 * Unassigns images from a folder.
 * @param {string} userDataRoot
 * @param {string} folderId
 * @param {string[]} relativePaths
 * @returns {Promise<void>}
 */
async function unassignImagesFromFolderUnserialised(userDataRoot, folderId, relativePaths) {
    const index = await readMetadataIndex(userDataRoot);
    for (const rp of relativePaths) {
        const posixPath = rp.replaceAll(path.sep, path.posix.sep);
        const meta = index.images[posixPath];
        if (!meta || !Array.isArray(meta.folderIds)) continue;
        const fi = meta.folderIds.indexOf(folderId);
        if (fi !== -1) meta.folderIds.splice(fi, 1);
    }
    await writeMetadataIndex(userDataRoot, index);
}


/**
 * The public forms of the mutators above, each holding this user's index for the whole of its
 * read-modify-write. The inner `Unserialised` functions keep the original bodies and must NOT call one
 * another: the chain is not re-entrant, so a nested call would wait on the entry that is already running.
 * Every caller today is a route handler, and that is the property to preserve.
 */

export async function getOrGenerateMetadataBatch(userDataRoot, relativePaths, type) {
    return serialise(userDataRoot, () => getOrGenerateMetadataBatchUnserialised(userDataRoot, relativePaths, type));
}

export async function removeMetadata(userDataRoot, relativePath) {
    return serialise(userDataRoot, () => removeMetadataUnserialised(userDataRoot, relativePath));
}

export async function renameMetadata(userDataRoot, oldRelativePath, newRelativePath) {
    return serialise(userDataRoot, () => renameMetadataUnserialised(userDataRoot, oldRelativePath, newRelativePath));
}

export async function cleanupOrphanedMetadata(userDataRoot) {
    return serialise(userDataRoot, () => cleanupOrphanedMetadataUnserialised(userDataRoot));
}

export async function createFolder(userDataRoot, name) {
    return serialise(userDataRoot, () => createFolderUnserialised(userDataRoot, name));
}

export async function setFolderThumbnailsBatch(userDataRoot, updates) {
    return serialise(userDataRoot, () => setFolderThumbnailsBatchUnserialised(userDataRoot, updates));
}

export async function updateFolder(userDataRoot, folderId, updates) {
    return serialise(userDataRoot, () => updateFolderUnserialised(userDataRoot, folderId, updates));
}

export async function deleteFolder(userDataRoot, folderId) {
    return serialise(userDataRoot, () => deleteFolderUnserialised(userDataRoot, folderId));
}

export async function assignImagesToFolder(userDataRoot, folderId, relativePaths) {
    return serialise(userDataRoot, () => assignImagesToFolderUnserialised(userDataRoot, folderId, relativePaths));
}

export async function unassignImagesFromFolder(userDataRoot, folderId, relativePaths) {
    return serialise(userDataRoot, () => unassignImagesFromFolderUnserialised(userDataRoot, folderId, relativePaths));
}

export const router = express.Router();

/**
 * POST /api/image-metadata/folders/get
 * List all virtual folders.
 */
router.post('/folders/get', async function (request, response) {
    try {
        const index = await readMetadataIndex(request.user.directories.root);
        return response.json(index.folders || []);
    } catch (error) {
        log.error(LogClass.NORMAL, '[ImageMetadata] Failed to list image folders');
        log.error(LogClass.SENSITIVE, '[ImageMetadata] Folders list error:', error);
        return response.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /api/image-metadata/folders/create
 * Create a new folder. Body: { name: string }
 */
router.post('/folders/create', async function (request, response) {
    try {
        const { name } = request.body;
        if (!name || typeof name !== 'string') {
            return response.status(400).json({ error: '"name" is required.' });
        }
        const folder = await createFolder(request.user.directories.root, name.trim());
        return response.json(folder);
    } catch (error) {
        log.error(LogClass.NORMAL, '[ImageMetadata] Failed to create an image folder');
        log.error(LogClass.SENSITIVE, '[ImageMetadata] Folder create error:', error);
        return response.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /api/image-metadata/folders/set-thumbnails
 * Batch-set thumbnail files for multiple folders in one write. Body: { updates: [{id, thumbnailFile}] }
 */
router.post('/folders/set-thumbnails', async function (request, response) {
    try {
        const { updates } = request.body;
        if (!Array.isArray(updates) || updates.some(u => !u.id || typeof u.thumbnailFile !== 'string')) {
            return response.status(400).json({ error: '"updates" must be an array of {id, thumbnailFile}.' });
        }
        await setFolderThumbnailsBatch(request.user.directories.root, updates);
        return response.json({ ok: true });
    } catch (error) {
        log.error(LogClass.NORMAL, '[ImageMetadata] Failed to set image folder thumbnails');
        log.error(LogClass.SENSITIVE, '[ImageMetadata] Folder set-thumbnails error:', error);
        return response.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /api/image-metadata/folders/update
 * Update a folder. Body: { id: string, name?: string, thumbnailFile?: string }
 */
router.post('/folders/update', async function (request, response) {
    try {
        const { id, ...updates } = request.body;
        if (!id || typeof id !== 'string') {
            return response.status(400).json({ error: '"id" is required.' });
        }
        const folder = await updateFolder(request.user.directories.root, id, updates);
        return response.json(folder);
    } catch (error) {
        if (error.message.includes('not found')) {
            return response.status(404).json({ error: error.message });
        }
        log.error(LogClass.NORMAL, '[ImageMetadata] Failed to update an image folder');
        log.error(LogClass.SENSITIVE, '[ImageMetadata] Folder update error:', error);
        return response.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /api/image-metadata/folders/delete
 * Delete a folder and unassign all images. Body: { id: string }
 */
router.post('/folders/delete', async function (request, response) {
    try {
        const { id } = request.body;
        if (!id || typeof id !== 'string') {
            return response.status(400).json({ error: '"id" is required.' });
        }
        await deleteFolder(request.user.directories.root, id);
        return response.json({ ok: true });
    } catch (error) {
        if (error.message.includes('not found')) {
            return response.status(404).json({ error: error.message });
        }
        log.error(LogClass.NORMAL, '[ImageMetadata] Failed to delete an image folder');
        log.error(LogClass.SENSITIVE, '[ImageMetadata] Folder delete error:', error);
        return response.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /api/image-metadata/folders/assign
 * Assign images to a folder. Body: { id: string, paths: string[] }
 */
router.post('/folders/assign', async function (request, response) {
    try {
        const { id, paths } = request.body;
        if (!id || typeof id !== 'string') {
            return response.status(400).json({ error: '"id" is required.' });
        }
        if (!Array.isArray(paths)) {
            return response.status(400).json({ error: '"paths" array is required.' });
        }
        await assignImagesToFolder(request.user.directories.root, id, paths);
        return response.json({ ok: true });
    } catch (error) {
        if (error.message.includes('not found')) {
            return response.status(404).json({ error: error.message });
        }
        log.error(LogClass.NORMAL, '[ImageMetadata] Failed to assign images to a folder');
        log.error(LogClass.SENSITIVE, '[ImageMetadata] Folder assign error:', error);
        return response.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /api/image-metadata/folders/unassign
 * Unassign images from a folder. Body: { id: string, paths: string[] }
 */
router.post('/folders/unassign', async function (request, response) {
    try {
        const { id, paths } = request.body;
        if (!id || typeof id !== 'string') {
            return response.status(400).json({ error: '"id" is required.' });
        }
        if (!Array.isArray(paths)) {
            return response.status(400).json({ error: '"paths" array is required.' });
        }
        await unassignImagesFromFolder(request.user.directories.root, id, paths);
        return response.json({ ok: true });
    } catch (error) {
        log.error(LogClass.NORMAL, '[ImageMetadata] Failed to unassign images from a folder');
        log.error(LogClass.SENSITIVE, '[ImageMetadata] Folder unassign error:', error);
        return response.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /api/image-metadata
 * Get metadata for image(s) by path.
 */
router.post('/', async function (request, response) {
    try {
        const { path: singlePath, paths, type } = request.body;

        if (!singlePath && !paths) {
            return response.status(400).json({ error: 'Either "path" or "paths" is required.' });
        }

        const userDataRoot = request.user.directories.root;

        // Helper to validate a path is under user data directory
        const validatePath = (relativePath) => {
            const fullPath = path.resolve(userDataRoot, relativePath);
            if (!isPathUnderParent(userDataRoot, fullPath)) {
                throw new Error(`Path "${relativePath}" is outside the user data directory.`);
            }
            return relativePath;
        };

        // Handle single path
        if (singlePath && !paths) {
            const relativePath = validatePath(singlePath);
            const fullPath = path.join(userDataRoot, relativePath);

            if (!storage.exists(fullPath)) {
                return response.status(404).json({ error: 'File not found.' });
            }

            const { results: metadataResults } = await getOrGenerateMetadataBatch(userDataRoot, [relativePath], type);
            const metadata = metadataResults[relativePath];

            if (!metadata) {
                return response.status(404).json({ error: 'Could not generate metadata for file.' });
            }

            return response.json(metadata);
        }

        // Handle multiple paths
        if (paths && Array.isArray(paths)) {
            /** @type {Object.<string, ImageMetadata|{error: string}>} */
            const results = {};
            const validPaths = [];

            // Validate all paths first
            for (const relativePath of paths) {
                try {
                    validatePath(relativePath);
                    validPaths.push(relativePath);
                } catch (error) {
                    results[relativePath] = { error: error.message };
                }
            }

            // Process all valid paths in a single batch
            const { results: batchMetadata } = await getOrGenerateMetadataBatch(userDataRoot, validPaths, type);

            for (const relativePath of validPaths) {
                if (batchMetadata[relativePath]) {
                    results[relativePath] = batchMetadata[relativePath];
                } else {
                    results[relativePath] = { error: 'File not found or could not process.' };
                }
            }

            return response.json(results);
        }

        return response.status(400).json({ error: 'Invalid request format.' });
    } catch (error) {
        log.error(LogClass.NORMAL, '[ImageMetadata] Image metadata request failed');
        log.error(LogClass.SENSITIVE, '[ImageMetadata] API error:', error);
        return response.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /api/image-metadata/all
 * Get all metadata from the index.
 * @body {string} [prefix] - Optional path prefix to filter results
 */
router.post('/all', async function (request, response) {
    try {
        const userDataRoot = request.user.directories.root;
        const prefix = String(request.body.prefix || '');
        const index = await readMetadataIndex(userDataRoot);

        // If prefix specified, filter to only matching paths
        if (prefix) {
            const filteredImages = {};
            for (const [key, value] of Object.entries(index.images)) {
                if (key.startsWith(prefix)) {
                    filteredImages[key] = value;
                }
            }
            return response.json({ version: index.version, images: filteredImages });
        }

        return response.json(index);
    } catch (error) {
        log.error(LogClass.NORMAL, '[ImageMetadata] Failed to read the image metadata index');
        log.error(LogClass.SENSITIVE, '[ImageMetadata] Failed to read metadata index:', error);
        return response.status(500).json({ error: 'Internal server error.' });
    }
});

/**
 * POST /api/image-metadata/cleanup
 * Clean up orphaned metadata entries (files that no longer exist).
 */
router.post('/cleanup', async function (request, response) {
    try {
        const userDataRoot = request.user.directories.root;
        const removed = await cleanupOrphanedMetadata(userDataRoot);
        return response.json({ removed, count: removed.length });
    } catch (error) {
        log.error(LogClass.NORMAL, '[ImageMetadata] Failed to clean up orphaned image metadata');
        log.error(LogClass.SENSITIVE, '[ImageMetadata] Cleanup error:', error);
        return response.status(500).json({ error: 'Internal server error.' });
    }
});
