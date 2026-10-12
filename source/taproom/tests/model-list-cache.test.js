import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { makeScratchDirectory } from './util/st-server.js';
import { readCachedModelList, writeCachedModelList } from '../src/model-list-cache.js';

/**
 * Unit coverage for the on-disk model-list cache (§ Featherless connect-speed fix, 2026-09-22).
 *
 * `globalThis.DATA_ROOT` is set per test to a scratch directory rather than importing a whole server —
 * the module reads it lazily inside each exported function, never at import time, so this is enough to
 * exercise the real read/write/sanitize logic without booting anything.
 */
describe('model-list-cache: on-disk cache for a text-completion backend\'s model list', () => {
    /** @type {string} */
    let root;

    beforeEach(() => {
        root = makeScratchDirectory('model-list-cache');
        globalThis.DATA_ROOT = root;
    });

    afterEach(() => {
        delete globalThis.DATA_ROOT;
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('a key with no cache file yet reads as null', () => {
        expect(readCachedModelList('api.featherless.ai')).toBeNull();
    });

    test('write then read round-trips the model list and the timestamp', () => {
        const models = [
            { id: 'zai-org/GLM-5.2', model_class: 'chat' },
            { id: 'meta-llama/Llama-4', model_class: 'chat' },
        ];

        const written = writeCachedModelList('api.featherless.ai', models);
        expect(typeof written.cachedAt).toBe('string');
        expect(new Date(written.cachedAt).toString()).not.toBe('Invalid Date');

        const read = readCachedModelList('api.featherless.ai');
        expect(read).not.toBeNull();
        expect(read.cachedAt).toBe(written.cachedAt);
        expect(read.models).toEqual(models);
    });

    test('the cache file lands under DATA_ROOT/_cache/model-lists, named for the sanitized key', () => {
        writeCachedModelList('api.featherless.ai', [{ id: 'a' }]);
        const expectedPath = path.join(root, '_cache', 'model-lists', 'api.featherless.ai.json');
        expect(fs.existsSync(expectedPath)).toBe(true);
    });

    test('writeCachedModelList creates the cache directory when it does not exist yet', () => {
        // beforeEach hands us a fresh, otherwise-empty scratch directory -- _cache/model-lists does not
        // exist until the first write, which is the mkdir -p case this pins.
        expect(fs.existsSync(path.join(root, '_cache', 'model-lists'))).toBe(false);
        writeCachedModelList('api.featherless.ai', []);
        expect(fs.existsSync(path.join(root, '_cache', 'model-lists'))).toBe(true);
    });

    test('a second write for the same key replaces the first rather than appending', () => {
        writeCachedModelList('api.featherless.ai', [{ id: 'old-model' }]);
        writeCachedModelList('api.featherless.ai', [{ id: 'new-model' }]);

        const read = readCachedModelList('api.featherless.ai');
        expect(read.models).toEqual([{ id: 'new-model' }]);
    });

    test('two different keys get two different cache files and do not collide', () => {
        writeCachedModelList('api.featherless.ai', [{ id: 'featherless-model' }]);
        writeCachedModelList('openrouter.ai', [{ id: 'openrouter-model' }]);

        expect(readCachedModelList('api.featherless.ai').models).toEqual([{ id: 'featherless-model' }]);
        expect(readCachedModelList('openrouter.ai').models).toEqual([{ id: 'openrouter-model' }]);
    });

    test('a corrupt (non-JSON) cache file reads as null rather than throwing', () => {
        const filePath = path.join(root, '_cache', 'model-lists', 'api.featherless.ai.json');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'this is not json{{{', 'utf-8');

        expect(readCachedModelList('api.featherless.ai')).toBeNull();
    });

    test('a well-formed JSON file missing the expected shape also reads as null', () => {
        const filePath = path.join(root, '_cache', 'model-lists', 'api.featherless.ai.json');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ somethingElse: true }), 'utf-8');

        expect(readCachedModelList('api.featherless.ai')).toBeNull();
    });

    test('🔴 the cache key is sanitized to [a-z0-9.-], so a hostile key cannot escape the cache directory', () => {
        // A key carrying path separators and case must not be able to write outside _cache/model-lists,
        // and must not collide with an unrelated, legitimately-named key.
        writeCachedModelList('../../evil', [{ id: 'escaped' }]);

        const modelListsDir = path.join(root, '_cache', 'model-lists');
        const entries = fs.readdirSync(modelListsDir);

        // Every file written by a sanitized key must actually be inside model-lists, and nothing should
        // have landed above it.
        expect(entries.length).toBe(1);
        expect(fs.existsSync(path.join(root, 'evil.json'))).toBe(false);
        expect(fs.existsSync(path.join(root, '_cache', 'evil.json'))).toBe(false);

        // Reading the same hostile key back must find what was written under its sanitized name.
        expect(readCachedModelList('../../evil').models).toEqual([{ id: 'escaped' }]);
    });

    test('a key that sanitizes to nothing still gets a usable, non-colliding cache file', () => {
        writeCachedModelList('///', [{ id: 'from-empty-key' }]);
        const read = readCachedModelList('///');
        expect(read).not.toBeNull();
        expect(read.models).toEqual([{ id: 'from-empty-key' }]);
    });

    test('key sanitization is case-insensitive, matching how host names are compared', () => {
        writeCachedModelList('API.Featherless.AI', [{ id: 'model-a' }]);
        expect(readCachedModelList('api.featherless.ai').models).toEqual([{ id: 'model-a' }]);
    });
});
