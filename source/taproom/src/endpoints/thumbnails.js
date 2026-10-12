import path from 'node:path';
import crypto from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp, JimpMime } from '../jimp.js';
import * as storage from '../storage.js';
import { imageSize as sizeOf } from 'image-size';

import { getConfigValue, invalidateFirefoxCache, isPathUnderParent } from '../util.js';
import { getThumbnailResolution, isAnimatedWebP, isAnimatedApng, thumbnailDimensions as dimensions } from './image-metadata.js';
import { ResizeStrategy } from '@jimp/plugin-resize';
import { log, LogClass } from '../logger.js';

export const publicRouter = express.Router();
export const apiRouter = express.Router();

export const SKIPPED_EXTENSIONS = new Set(['.apng', '.mp4', '.webm', '.avi', '.mkv', '.flv', '.gif']);
export const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.apng']);

const thumbnailsEnabled = !!getConfigValue('thumbnails.enabled', true, 'boolean');
const quality = Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.quality', 95, 'number'))));
const pngFormat = String(getConfigValue('thumbnails.format', 'jpg')).toLowerCase().trim() === 'png';

/**
 * What {@link processSingleImage} actually encodes, as a MIME type.
 *
 * 🔴 IT IS NOT THE CACHE FILE'S EXTENSION, AND THE DIFFERENCE WAS BEING SERVED AS A LIE. A cached
 * thumbnail is stored under the ORIGINAL image's filename — `thumbnails/avatar/Cleo.png` — while the
 * generator encodes JPEG unless `thumbnails.format` says `png`. Content-Type is derived from that
 * filename at both ends of the funnel (Express's `sendFile`, and a provider's own `res.type(extname)`),
 * so every avatar thumbnail this server has ever sent went out declared `image/png` with `ff d8 ff` in
 * the body.
 *
 * Nothing in the app noticed because `<img>` sniffs images and ignores the declaration. A programmatic
 * client does not — it stores the asset as what the server said it was, and ends up with JPEG bytes
 * filed under `.png`. Vocalis is about to be exactly that client (`C10`).
 * @type {string}
 */
const THUMBNAIL_MIME = pngFormat ? 'image/png' : 'image/jpeg';

/**
 * 🔴 BUMP THIS WHENEVER THE GENERATED PIXELS CHANGE.
 *
 * A cached thumbnail is only considered stale when the *original* is newer than it (see
 * `generateThumbnail`). Editing the generation code moves no mtime, so without this marker every
 * thumbnail produced by an older version of this file would be served forever — a character
 * cropped to 1:2 would keep showing the 2:3 thumbnail that was cut for it months ago, and the
 * only cure would be a manual wipe that nobody remembers to do on deploy.
 *
 * 2 — avatar/persona preserve the source aspect ratio at a 144x216 target area
 *     (was: cover() to exactly 96x144, which re-cropped everything to 2:3).
 */
const THUMBNAIL_GENERATION = '2';

/**
 * Records which generation produced the cached thumbnails. Lives directly in `thumbnails/` rather
 * than in a type subfolder, so the data-maid orphan sweep — which treats every file in a type
 * folder that has no matching character as junk — never sees it.
 */
const GENERATION_MARKER = '.generation';

/** Marker paths already verified this process run. @type {Set<string>} */
const checkedGenerations = new Set();

/**
 * @typedef {'bg' | 'avatar' | 'persona' | 'face' | 'persona-face'} ThumbnailType
 */

/**
 * Discards cached thumbnails that an older version of this file generated.
 *
 * Runs at most once per user per process; the marker read is the only cost on the warm path.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 */
export function ensureThumbnailGeneration(directories) {
    const markerPath = path.join(directories.thumbnails, GENERATION_MARKER);
    if (checkedGenerations.has(markerPath)) {
        return;
    }

    try {
        const current = storage.exists(markerPath)
            ? String(storage.readFileSync(markerPath, 'utf-8')).trim()
            : '';

        if (current !== THUMBNAIL_GENERATION) {
            // Only the types this fork changed. `bg` generation is untouched, so its cache is valid.
            for (const folder of [directories.thumbnailsAvatar, directories.thumbnailsPersona]) {
                if (!folder || !storage.exists(folder)) {
                    continue;
                }

                for (const entry of storage.readdir(folder, { withFileTypes: true })) {
                    if (entry.isFile()) {
                        storage.unlink(path.join(folder, entry.name));
                    }
                }
            }

            storage.writeFileSync(markerPath, THUMBNAIL_GENERATION);
            log.info(LogClass.NORMAL, `[Thumbnails] Cleared the avatar thumbnail cache for generation ${THUMBNAIL_GENERATION}`);
        }
    } catch (error) {
        // A cache we failed to clear is a stale cache, not a broken server. Log and carry on;
        // the next process start will try again.
        log.warn(LogClass.NORMAL, '[Thumbnails] Could not verify the thumbnail cache generation');
        log.warn(LogClass.SENSITIVE, '[Thumbnails] Could not verify the thumbnail cache generation', error);
    }

    checkedGenerations.add(markerPath);
}


/**
 * Gets a path to thumbnail folder based on the type.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Thumbnail type
 * @returns {string} Path to the thumbnails folder
 */
function getThumbnailFolder(directories, type) {
    let thumbnailFolder;

    switch (type) {
        case 'bg':
            thumbnailFolder = directories.thumbnailsBg;
            break;
        case 'avatar':
            thumbnailFolder = directories.thumbnailsAvatar;
            break;
        case 'persona':
            thumbnailFolder = directories.thumbnailsPersona;
            break;
        case 'face':
            thumbnailFolder = directories.thumbnailsFace;
            break;
        case 'persona-face':
            thumbnailFolder = directories.thumbnailsPersonaFace;
            break;
    }

    return thumbnailFolder;
}

/**
 * Gets a path to the original images folder based on the type.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Thumbnail type
 * @returns {string} Path to the original images folder
 */
function getOriginalFolder(directories, type) {
    let originalFolder;

    switch (type) {
        case 'bg':
            originalFolder = directories.backgrounds;
            break;
        case 'avatar':
            originalFolder = directories.characters;
            break;
        case 'persona':
            originalFolder = directories.avatars;
            break;
        // The square types read the same originals as their rectangular counterparts — there is only
        // ever one image per character, so the circle is always a region of the card itself.
        case 'face':
            originalFolder = directories.characters;
            break;
        case 'persona-face':
            originalFolder = directories.avatars;
            break;
    }

    return originalFolder;
}

/**
 * The square cache cut from the same source as a rectangular thumbnail.
 * @param {ThumbnailType} type Type being invalidated
 * @returns {ThumbnailType|null} The face cache derived from it, or null if there is none
 */
function faceCacheFor(type) {
    switch (type) {
        case 'avatar':
            return 'face';
        case 'persona':
            return 'persona-face';
        default:
            return null;
    }
}

/**
 * Removes the generated thumbnail from the disk.
 *
 * 🔴 AND THE SQUARE CROPS CUT FROM THE SAME PICTURE, WHICH NOTHING INVALIDATED AT ALL. The face caches
 * could not even be addressed through this function: a face thumbnail is stored under the focus key
 * `<centered|8hex>__<file>` from `getFaceCacheName`, so `path.join(folder, sanitize(file))` named a path
 * that never exists. Replace a character's picture and `thumbnails/avatar/Cleo.png` went while
 * `thumbnails/face/centered__Cleo.png` stayed — and `serveThumbnail` gates only on the cached file
 * existing, so with round avatars on every message showed the OLD PICTURE permanently. The data maid does
 * not collect it either: the stripped name still matches a live character, so it is not an orphan. Delete
 * a character and re-import one reusing the filename and the previous character's face is served as the
 * new one's.
 *
 * ⚠️ DONE HERE RATHER THAN AT THE CALL SITES. All six callers pass 'avatar' or 'persona', and adding a
 * second call beside each would be correct exactly until somebody adds a seventh. The square crop is cut
 * from the same source image, so invalidating that source must invalidate its crops — that is a property
 * of the data, not of the caller.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Type of the thumbnail
 * @param {string} file Name of the file
 */
export function invalidateThumbnail(directories, type, file) {
    const folder = getThumbnailFolder(directories, type);
    if (folder === undefined) throw new Error('Invalid thumbnail type');

    const pathToThumbnail = path.join(folder, sanitize(file));

    if (storage.exists(pathToThumbnail)) {
        storage.unlink(pathToThumbnail);
    }

    const faceType = faceCacheFor(type);

    if (faceType) {
        const faceFolder = getThumbnailFolder(directories, faceType);

        // Every variant, keeping none — the source is gone or replaced, so no crop of it is still valid.
        if (faceFolder !== undefined) {
            pruneFaceVariants(faceFolder, sanitize(file), null);
        }
    }
}

/**
 * A square region of an image, as fractions of its dimensions.
 *
 * `x`/`y` are the square's top-left corner as a fraction of image width and height respectively;
 * `w` is its side length as a fraction of image **width** — the same pixel value is used for both
 * axes, so the region is always square regardless of how tall the source is.
 * @typedef {{x: number, y: number, w: number}} FocusRect
 */

/**
 * Whether a thumbnail type is one of the square, focus-croppable ones.
 * @param {ThumbnailType} type Thumbnail type
 * @returns {boolean}
 */
function isFaceType(type) {
    return type === 'face' || type === 'persona-face';
}

/**
 * Parses a `x,y,w` focus parameter into a rectangle.
 *
 * Anything malformed or out of range yields null, which callers treat as "centred square" — the
 * behaviour every avatar had before focus rects existed. Never throws: a bad query string should
 * give the user a plainly-framed avatar, not a broken image.
 * @param {any} value Raw query parameter
 * @returns {FocusRect?} The parsed rectangle, or null
 */
export function parseFocusRect(value) {
    if (typeof value !== 'string' || !value) {
        return null;
    }

    const parts = value.split(',').map(Number);
    if (parts.length !== 3 || !parts.every(Number.isFinite)) {
        return null;
    }

    const [x, y, w] = parts;
    if (w <= 0 || w > 1 || x < 0 || x > 1 || y < 0 || y > 1) {
        return null;
    }

    return { x, y, w };
}

/**
 * Cache filename for a square thumbnail.
 *
 * 🔴 THE FOCUS IS IN THE FILENAME, AND THAT IS THE INVALIDATION STRATEGY. Staleness here is
 * decided by comparing the original's mtime against the cached file, and moving a focus rect
 * changes no image on disk — so a shared filename would serve the old square forever, and every
 * caller that repositioned a face would have to remember to invalidate by hand. Keying the cache
 * by the focus means a repositioned face simply requests a URL that has never been cached.
 *
 * The key is a prefix rather than a suffix so the real extension stays in final position, where
 * `path.extname` and the extension allowlists still find it.
 * @param {string} file Original filename
 * @param {FocusRect?} focus Focus rectangle, or null for the centred square
 * @returns {string} Filename to cache the square thumbnail under
 */
export function getFaceCacheName(file, focus) {
    if (!focus) {
        return `centered__${file}`;
    }

    const key = crypto.createHash('sha256')
        .update(`${focus.x.toFixed(4)},${focus.y.toFixed(4)},${focus.w.toFixed(4)}`)
        .digest('hex')
        .slice(0, 8);

    return `${key}__${file}`;
}

/**
 * Matches the focus key that {@link getFaceCacheName} prefixes onto a cached square thumbnail.
 * Anchored and narrow so a character whose file is genuinely named `centered__x.png` keeps working.
 */
export const FACE_CACHE_PREFIX = /^(?:centered|[0-9a-f]{8})__/;

/**
 * Deletes cached square thumbnails of `file` that were cut for a different focus rect.
 *
 * Keying the cache by focus means every reposition mints a new file and abandons the old one.
 * Without this the folder would accumulate one dead thumbnail per adjustment, forever — slow
 * growth that nothing else would ever notice, since the abandoned files still belong to a live
 * character and so are not orphans the data maid would collect.
 * @param {string} thumbnailFolder Folder holding the square thumbnails
 * @param {string} file Original filename
 * @param {string|null} keepName Cache filename to preserve, or null to remove every variant — which is
 * what `invalidateThumbnail` wants when the source image itself is gone or replaced
 */
function pruneFaceVariants(thumbnailFolder, file, keepName) {
    try {
        for (const entry of storage.readdir(thumbnailFolder, { withFileTypes: true })) {
            if (!entry.isFile() || entry.name === keepName) {
                continue;
            }

            if (entry.name.replace(FACE_CACHE_PREFIX, '') === file) {
                storage.unlink(path.join(thumbnailFolder, entry.name));
            }
        }
    } catch (error) {
        // Housekeeping. A failure here wastes disk, it does not break the avatar.
        log.warn(LogClass.SENSITIVE, '[Thumbnails] Could not prune stale face thumbnails:', error);
    }
}

/**
 * Resolves a focus rectangle to pixel coordinates within an image, clamped to its bounds.
 * @param {FocusRect?} focus Focus rectangle, or null for the centred square
 * @param {number} width Image width in pixels
 * @param {number} height Image height in pixels
 * @returns {{x: number, y: number, side: number}} Square region in pixels
 */
function resolveFocusSquare(focus, width, height) {
    if (!focus) {
        const side = Math.min(width, height);
        return { x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), side };
    }

    const side = Math.min(Math.max(1, Math.round(focus.w * width)), width, height);
    const x = Math.min(Math.max(0, Math.round(focus.x * width)), width - side);
    const y = Math.min(Math.max(0, Math.round(focus.y * height)), height - side);

    return { x, y, side };
}

/**
 * Whether a cached thumbnail was cut from a version of the original that is no longer on disk.
 *
 * ⚠️ `ctimeMs` ON THE CACHED SIDE, matching `generateThumbnail`'s own comparison. A thumbnail is
 * written once and never touched again, so its creation time IS the moment its source was read;
 * mtime would say the same thing on every platform that has both, and ctime is the one that also
 * moves if the file is replaced in place.
 *
 * Never throws: a stat that fails is answered "not stale", because the alternative is regenerating
 * every avatar on the page every time something goes wrong with the filesystem.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Thumbnail type
 * @param {string} file Original filename
 * @param {string} pathToCachedFile Absolute path to the cached thumbnail
 * @returns {boolean} True if the original has changed since the thumbnail was cut
 */
function isCachedThumbnailStale(directories, type, file, pathToCachedFile) {
    try {
        const originalFolder = getOriginalFolder(directories, type);
        const pathToOriginalFile = path.join(originalFolder, file);

        if (!storage.exists(pathToOriginalFile)) {
            return false;
        }

        return storage.stat(pathToOriginalFile).mtimeMs > storage.stat(pathToCachedFile).ctimeMs;
    } catch {
        return false;
    }
}

/**
 * Generates or retrieves a thumbnail for a given file.
 * @param {import('../users.js').UserDirectoryList} directories - User's directory configuration.
 * @param {ThumbnailType} type - Type of thumbnail ('bg', 'avatar', 'persona', 'face', 'persona-face').
 * @param {string} file - The filename of the image.
 * @param {boolean} [forceGenerate=false] - Whether to force generation even if a thumbnail exists.
 * @param {boolean|null} [isKnownAnimated=null] - If true, skips generation. If false, assumes static. If null, checks.
 * @param {FocusRect?} [focus=null] - Square region to crop, for the `face` types only. Null means the centred square.
 * @returns {Promise<{path: string|null, aspectRatio: number|null, resolution: number|null}>} Path to thumbnail, its aspect ratio, and resolution.
 */
export async function generateThumbnail(directories, type, file, forceGenerate = false, isKnownAnimated = null, focus = null) {
    // If the caller has already determined the file is animated, skip processing.
    if (isKnownAnimated) {
        return { path: null, aspectRatio: null, resolution: null };
    }

    const thumbnailFolder = getThumbnailFolder(directories, type);
    const originalFolder = getOriginalFolder(directories, type);
    if (thumbnailFolder === undefined || originalFolder === undefined) throw new Error('Invalid thumbnail type');
    ensureThumbnailGeneration(directories);
    const pathToCachedFile = path.join(thumbnailFolder, isFaceType(type) ? getFaceCacheName(file, focus) : file);

    try {
        const pathToOriginalFile = path.join(originalFolder, file);

        // Check if thumbnail already exists and return it if not forcing regeneration
        if (!forceGenerate && storage.exists(pathToCachedFile)) {
            try {
                // Check if original image was updated after thumbnail creation
                const originalFileExists = storage.exists(pathToOriginalFile);
                if (originalFileExists) {
                    const originalStat = storage.stat(pathToOriginalFile);
                    const cachedStat = storage.stat(pathToCachedFile);

                    if (originalStat.mtimeMs > cachedStat.ctimeMs) {
                        // Original file changed, regenerate thumbnail
                        forceGenerate = true;
                    }
                }

                if (!forceGenerate) {
                    const buffer = storage.readFileSync(pathToCachedFile);
                    const fileDimensions = sizeOf(buffer);
                    const ratio = (fileDimensions.height > 0) ? (fileDimensions.width / fileDimensions.height) : 1.0;
                    // When a thumbnail exists, return the current resolution from config so the JSON can be updated.
                    const resolution = getThumbnailResolution(type);
                    return { path: pathToCachedFile, aspectRatio: ratio, resolution };
                }
            } catch (e) {
                forceGenerate = true;
            }
        }
        if (!storage.exists(pathToOriginalFile)) {
            log.error(LogClass.NORMAL, '[generateThumbnail] Cannot generate thumbnail, original file not found');
            log.error(LogClass.SENSITIVE, `[generateThumbnail] Cannot generate thumbnail, original file not found: ${pathToOriginalFile}`);
            return { path: null, aspectRatio: null, resolution: null };
        }

        const fileExtension = path.extname(file).toLowerCase();

        // For WebP files, we must check if they are animated, as Jimp cannot process them.
        // If isKnownAnimated is false, we assume the caller knows it is static and skip this check.
        if (fileExtension === '.webp' && isKnownAnimated !== false) {
            const buffer = storage.readFileSync(pathToOriginalFile);
            const isAnimated = isAnimatedWebP(buffer);
            if (isAnimated) {
                // The client is expected to handle it.
                return { path: null, aspectRatio: null, resolution: null };
            }
        }

        // For PNG files, check if they are actually APNGs.
        if (fileExtension === '.png' && isKnownAnimated !== false) {
            const buffer = storage.readFileSync(pathToOriginalFile);
            const isAnimated = isAnimatedApng(buffer);
            if (isAnimated) {
                // The client is expected to handle it.
                return { path: null, aspectRatio: null, resolution: null };
            }
        }

        if (SKIPPED_EXTENSIONS.has(fileExtension)) {
            return { path: null, aspectRatio: null, resolution: null };
        }

        // Process the image to generate thumbnail
        const result = await processSingleImage(file, originalFolder, pathToCachedFile, type, focus);
        if (result.success) {
            return { path: pathToCachedFile, aspectRatio: result.aspectRatio ?? null, resolution: result.resolution ?? null };
        } else {
            log.error(LogClass.NORMAL, '[generateThumbnail] Failed to process image');
            log.error(LogClass.SENSITIVE, `[generateThumbnail] Failed to process image ${file}:`, result.error);
            return { path: null, aspectRatio: null, resolution: null };
        }
    } catch (error) {
        log.error(LogClass.NORMAL, '[generateThumbnail] Unexpected error processing image');
        log.error(LogClass.SENSITIVE, `[generateThumbnail] Unexpected error processing ${file}:`, error);
        return { path: null, aspectRatio: null, resolution: null };
    }
}

/**
 * Processes a single image to generate its thumbnail.
 * @param {string} file - The filename of the image.
 * @param {string} originalFolder - Path to the original image folder.
 * @param {string} pathToCachedFile - Full path to write the thumbnail to. Not derivable from `file`: the square types key their cache filename by the focus rect.
 * @param {ThumbnailType} type - The type of thumbnail to generate.
 * @param {FocusRect?} [focus=null] - Square region to crop, for the `face` types only.
 * @returns {Promise<{success: boolean, filename?: string, error?: string, aspectRatio?: number, resolution?: number}>} Result of the processing.
 */
async function processSingleImage(file, originalFolder, pathToCachedFile, type, focus = null) {
    const pathToOriginalFile = path.join(originalFolder, file);

    try {
        const fileBuffer = storage.readFileSync(pathToOriginalFile);
        const image = await Jimp.read(fileBuffer);

        // Calculate aspect ratio from original image dimensions
        const originalWidth = image.bitmap.width;
        const originalHeight = image.bitmap.height;
        const aspectRatio = (originalHeight > 0) ? (originalWidth / originalHeight) : 1.0;

        const thumbImage = image.clone();
        const thumbnailResolution = getThumbnailResolution(type);

        if (type === 'bg' || type === 'avatar' || type === 'persona') {
            // 🔴 PRESERVE THE SOURCE ASPECT RATIO. Upstream sent `avatar`/`persona` through
            // `cover({w: 96, h: 144})`, which re-cropped every avatar back to 2:3 no matter how the
            // user had cropped it. That crop was invisible — it happened after the card was saved,
            // so a 1:2 card looked correct on disk and arrived at the browser as 2:3 anyway, and no
            // amount of CSS downstream could get the lost pixels back. Matching a pixel *area*
            // instead of fixed dimensions keeps whatever shape the user chose.
            const [configWidth, configHeight] = dimensions[type];
            const targetPixelArea = configWidth * configHeight;

            // Calculate thumbnail dimensions to maintain target pixel area while preserving aspect ratio
            // For aspect ratio w:h, if area = w*h and ratio = w/h, then:
            // w = sqrt(area * ratio) and h = sqrt(area / ratio)
            let thumbWidth = Math.max(1, Math.round(Math.sqrt(targetPixelArea * aspectRatio)));
            let thumbHeight = Math.max(1, Math.round(Math.sqrt(targetPixelArea / aspectRatio)));

            // Never upscale — a thumbnail larger than its source is bytes without detail.
            if (thumbWidth > originalWidth || thumbHeight > originalHeight) {
                thumbWidth = originalWidth;
                thumbHeight = originalHeight;
            }

            thumbImage.resize({ w: thumbWidth, h: thumbHeight, mode: ResizeStrategy.BILINEAR });
        } else if (isFaceType(type)) {
            // The round avatar. Cut from the card at full resolution rather than panned over a
            // small rectangular thumbnail in CSS — that is what makes a zoomed-in face sharp
            // instead of a handful of upscaled pixels.
            const [configWidth, configHeight] = dimensions[type];
            const square = resolveFocusSquare(focus, originalWidth, originalHeight);

            thumbImage.crop({ x: square.x, y: square.y, w: square.side, h: square.side });
            thumbImage.cover({ w: configWidth, h: configHeight });
        }

        const buffer = pngFormat
            ? await thumbImage.getBuffer(JimpMime.png)
            : await thumbImage.getBuffer(JimpMime.jpeg, { quality: quality, jpegColorSpace: 'ycbcr' });

        storage.writeFileSync(pathToCachedFile, buffer);

        if (isFaceType(type)) {
            pruneFaceVariants(path.dirname(pathToCachedFile), file, path.basename(pathToCachedFile));
        }

        return { success: true, aspectRatio, resolution: thumbnailResolution };
    } catch (error) {
        log.warn(LogClass.SENSITIVE, `[Thumbnails] Failed to process image ${file}:`, error);
        return { success: false, filename: file, error: error.message };
    }
}

/**
 * Public endpoint for serving thumbnails.
 *
 * 🔴 REGISTERED AT TWO PATHS, AND THE SECOND ONE IS LOad-BEARING. The square `face` types are served
 * from `/thumbnail/face`, not `/thumbnail?type=face`, because third-party code reconstructs avatar
 * URLs from scratch and only knows the types that existed when it was written.
 *
 * The Moonlit Echoes theme is the live example: its avatar observer re-points every `.mes .avatar
 * img` after render, rebuilding the URL as `/thumbnail?type=<t>&file=<f>` for `avatar` and
 * `persona` and falling back to a BARE `/<filename>` for anything else. A `face` URL hit that
 * fallback, so every message avatar loaded correctly and was then rewritten to `/Cleo.png`, which
 * 404s — avatars that worked for one second and then turned into placeholders.
 *
 * That extension skips any URL whose pathname does not end in `thumbnail`, so a distinct path makes
 * it reconstruct our URL byte-for-byte and leave it alone. Any extension pattern-matching
 * `/thumbnail?type=` gets the same protection for free.
 *
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
async function serveThumbnail(request, response) {
    try {
        const { file: rawFile, type, animated, focus: rawFocus } = request.query;
        if (typeof rawFile !== 'string' || typeof type !== 'string') return response.sendStatus(400);
        if (!(type === 'bg' || type === 'avatar' || type === 'persona' || type === 'face' || type === 'persona-face')) {
            return response.sendStatus(400);
        }

        // Malformed focus degrades to the centred square rather than 400ing — a bad query string
        // should cost the user a plainly-framed avatar, not a broken image in every message.
        const focus = isFaceType(type) ? parseFocusRect(rawFocus) : null;

        const file = sanitize(rawFile);
        if (file !== rawFile) return response.sendStatus(403);

        // Before any cache hit — a stale-generation thumbnail is served from cache without ever
        // reaching generateThumbnail, so checking only in there would never fire.
        ensureThumbnailGeneration(request.user.directories);

        // 🔴 CONFINE THE PATH. Upstream got this for free from Express's `sendFile(file, { root: folder })`,
        // which refuses to escape its root. `storage.sendFile` takes an absolute path and has no root to
        // refuse against, so the check that came with the old call has to be written out. The `sanitize()`
        // above already makes traversal unreachable — this is the second lock on the same door, and it is
        // the one that keeps holding if someone ever loosens the first.
        const serveOriginal = async () => {
            const folder = getOriginalFolder(request.user.directories, type);
            const pathToOriginalFile = path.resolve(path.join(folder, file));
            if (!isPathUnderParent(folder, pathToOriginalFile)) return response.sendStatus(403);
            if (!storage.exists(pathToOriginalFile)) return response.sendStatus(404);
            invalidateFirefoxCache(pathToOriginalFile, request, response);
            return await storage.sendFile(response, pathToOriginalFile);
        };

        if (!thumbnailsEnabled) {
            return await serveOriginal();
        }

        const animatedEnabled = animated === 'true';
        const fileExtension = path.extname(file).toLowerCase();
        const isAnimatedFormat = SKIPPED_EXTENSIONS.has(fileExtension);

        // Serve original for animated formats or GIFs
        if (animatedEnabled && isAnimatedFormat) {
            return await serveOriginal();
        }

        if (fileExtension === '.gif') {
            return await serveOriginal();
        }

        const thumbnailFolder = getThumbnailFolder(request.user.directories, type);
        const pathToCachedFile = path.join(thumbnailFolder, isFaceType(type) ? getFaceCacheName(file, focus) : file);

        if (!isPathUnderParent(thumbnailFolder, path.resolve(pathToCachedFile))) {
            return response.sendStatus(403);
        }

        // 🔴 A CACHED THUMBNAIL WHOSE ORIGINAL HAS MOVED ON IS NOT A CACHE HIT. This used to read
        // `if (!storage.exists(...))` alone, so freshness rested entirely on every path that rewrites a
        // card image remembering to call `invalidateThumbnail` — six call sites today, and correct
        // exactly until someone adds a seventh. `generateThumbnail` has always carried the mtime
        // comparison and it was dead code from here, because the only branch that reached it was the
        // one where nothing was cached.
        //
        // Staleness is a property of the two files, not of the caller who happened to write one of
        // them: if the original is newer than the crop taken from it, the crop is of a picture that no
        // longer exists. Two `stat` calls against reading and sending the file we are about to send
        // anyway, and the whole class — a replaced avatar surfacing the old face until someone empties
        // the cache by hand — stops depending on anyone's memory.
        if (!storage.exists(pathToCachedFile) || isCachedThumbnailStale(request.user.directories, type, file, pathToCachedFile)) {
            const thumbResult = await generateThumbnail(request.user.directories, type, file, false, null, focus);
            // If generation failed (path is null), serve the original file
            if (!thumbResult.path) {
                return await serveOriginal();
            }
        }

        if (storage.exists(pathToCachedFile)) {
            invalidateFirefoxCache(pathToCachedFile, request, response);

            // 🔴 SENT BY HAND, BECAUSE `sendFile` CANNOT BE TOLD THE TRUTH ABOUT THESE BYTES. Both
            // implementations behind `storage.sendFile` derive Content-Type from the path's extension —
            // Express's own, and the vault provider's `res.type(path.extname(p))` — and the extension here
            // is the ORIGINAL image's, not the generated thumbnail's. Setting the header first does not
            // survive either: `res.type()` in the provider overwrites unconditionally. See
            // {@link THUMBNAIL_MIME}.
            //
            // A thumbnail is tens of KB, so buffering costs nothing that streaming was buying, and
            // `res.send` still computes an ETag and answers a conditional request from it.
            const buffer = await storage.readFile(path.resolve(pathToCachedFile));
            response.type(THUMBNAIL_MIME);
            return response.send(buffer);
        }

        // Send a 404 so the frontend can display a placeholder
        return response.sendStatus(404);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed getting thumbnail');
        log.error(LogClass.SENSITIVE, 'Failed getting thumbnail', error);
        return response.sendStatus(500);
    }
}

publicRouter.get('/', serveThumbnail);

// The square types. See serveThumbnail's header for why these do NOT live on `/thumbnail`.
publicRouter.get('/face', serveThumbnail);

export const router = express.Router();
router.use(publicRouter);
router.use(apiRouter);
