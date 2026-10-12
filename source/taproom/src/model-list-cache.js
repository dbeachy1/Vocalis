import fs from 'node:fs';
import path from 'node:path';

import { log, LogClass, redact } from './logger.js';

/**
 * On-disk cache for a text-completion backend's full model list.
 *
 * Large catalogs can make repeated Connect requests and browser parsing slow. Some providers send
 * `Cache-Control: private, no-store` without an `ETag`, so the client cannot cheaply check for changes.
 * Keep the last response and let the user request a refresh explicitly.
 *
 * One JSON file per cache key (normally a host name, e.g. `api.featherless.ai`), so a second
 * text-completion backend that also happens to serve a huge catalog gets its own cache file rather
 * than clobbering this one.
 */

/** Where cache files for every key live, relative to `DATA_ROOT` — the fork's established home for
 * on-disk caches that are not user data (see `transformers.js` and `tokenizers.js`, which both use a
 * sibling `_cache` directory under `DATA_ROOT` for the same reason: something the app can regenerate,
 * not something the user owns). */
const CACHE_SUBDIRECTORY = path.join('_cache', 'model-lists');

/**
 * Turn a cache key into a filesystem-safe filename stem.
 *
 * Anything outside `[a-z0-9.-]` is dropped rather than escaped or percent-encoded — a host name never
 * legitimately contains it, and dropping strips path separators too, which is what keeps a hostile key
 * from ever writing outside {@link CACHE_SUBDIRECTORY}. A key that sanitizes to nothing gets a fixed
 * fallback name instead of an empty filename, which would otherwise collide every such caller onto the
 * same file.
 * @param {string} key The cache key, normally a host name like `api.featherless.ai`
 * @returns {string} A safe, non-empty filename stem
 */
function sanitizeKey(key) {
    const cleaned = String(key ?? '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
    return cleaned.length > 0 ? cleaned : 'unknown-host';
}

/**
 * @param {string} key Cache key — see {@link sanitizeKey}
 * @returns {string} Absolute path to that key's cache file
 */
function cacheFilePath(key) {
    return path.join(globalThis.DATA_ROOT, CACHE_SUBDIRECTORY, `${sanitizeKey(key)}.json`);
}

/**
 * A cached model list.
 * @typedef {object} CachedModelList
 * @property {string} cachedAt ISO-8601 timestamp of when this list was written
 * @property {any[]} models The model list, exactly as the backend returned it
 */

/**
 * Read a cached model list, if one exists and is readable.
 *
 * 🔴 A CORRUPT OR UNREADABLE FILE READS AS `null`, NOT AS A THROW. The cache is a convenience the
 * server writes to and reads from itself — nothing else depends on it existing or being well-formed —
 * so a torn write (process killed mid-`writeFileSync`, a full disk) has to degrade into "no cache,
 * fetch it again" rather than take the whole status route down with it.
 * @param {string} key Cache key, normally a host name like `api.featherless.ai`
 * @returns {CachedModelList|null} The cached list, or null if there is none or it could not be read
 */
export function readCachedModelList(key) {
    const filePath = cacheFilePath(key);

    if (!fs.existsSync(filePath)) {
        log.debug(LogClass.NORMAL, `Model list cache miss for key '${key}' — no cache file at`, redact(filePath));
        return null;
    }

    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        /** @type {any} */
        const parsed = JSON.parse(raw);

        if (typeof parsed?.cachedAt !== 'string' || !Array.isArray(parsed?.models)) {
            // Never model CONTENTS in the log — only the shape check that failed and where.
            log.warn(LogClass.NORMAL, `Model list cache file for key '${key}' is missing cachedAt or models — treating it as absent. Path`, redact(filePath));
            return null;
        }

        log.info(LogClass.NORMAL, `Model list cache read for key '${key}': ${parsed.models.length} models, ${Buffer.byteLength(raw, 'utf-8')} bytes, cached at ${parsed.cachedAt}. Path`, redact(filePath));
        return { cachedAt: parsed.cachedAt, models: parsed.models };
    } catch (error) {
        // Logged once, at warn, so "why did this refetch the whole list" has an answer on disk instead
        // of a silent fallback to the no-cache path. No model contents reach the log here either.
        log.warn(LogClass.NORMAL, `Model list cache file for key '${key}' could not be read — treating it as absent. Path`, redact(filePath));
        log.warn(LogClass.SENSITIVE, error);
        return null;
    }
}

/**
 * Write a model list to the on-disk cache, replacing whatever was there for this key.
 * @param {string} key Cache key, normally a host name like `api.featherless.ai`
 * @param {any[]} models The model list to cache, exactly as the backend returned it
 * @returns {CachedModelList} The record that was written, so a caller does not have to regenerate the
 * same timestamp to report it back to the client
 */
export function writeCachedModelList(key, models) {
    const filePath = cacheFilePath(key);
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });

    /** @type {CachedModelList} */
    const record = { cachedAt: new Date().toISOString(), models };
    const serialized = JSON.stringify(record);
    fs.writeFileSync(filePath, serialized, 'utf-8');

    log.info(LogClass.NORMAL, `Model list cache written for key '${key}': ${models.length} models, ${Buffer.byteLength(serialized, 'utf-8')} bytes, cached at ${record.cachedAt}. Path`, redact(filePath));
    return record;
}
