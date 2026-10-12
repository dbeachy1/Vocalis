import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * `/api/worldinfo/list` carries a `change` token so a client that imported a book can tell whether
 * SillyTavern's copy moved before it pushes over the top of it.
 *
 * 🔴 THE ASYMMETRY IS THE POINT, AND IT IS THE THING TO PROTECT. The token may report "changed" when
 * nothing was edited — an atomic write leaves the temp file's stamp, and a provider resealing on key
 * rotation rewrites every file it owns. It must never report "unchanged" about a book that was
 * written. A spurious warning costs a click; a missed one costs the edits.
 *
 * ⚠️ Deliberately not a content hash. `/list` happens to read every file today, so hashing would be
 * nearly free — and would be a promise this endpoint could not keep the day that read is made lazy.
 *
 * The character list already had a token of its own in `date_added` (the card file's ctime, which
 * moves on every write despite the name). Books had nothing at all, which is the gap this closes.
 */
describe('World info list: the change token', () => {
    /** @type {string} */
    let scratch;
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let st;
    /** @type {string} */
    let base;
    /** @type {string} */
    let worldsDirectory;

    /** An envelope naming a provider that is not installed — the shape of an unreadable book. */
    const ENVELOPED = Buffer.from('stenv:1:never-installed:VGhpcyBpcyBub3QgcGxhaW50ZXh0Lg==', 'utf-8');

    const ORDINARY = 'A Listed World';
    const UNREADABLE = 'venc1~EEEEFFFFGGGGHHHH';

    beforeAll(async () => {
        scratch = makeScratchDirectory('worldinfo-change-token');

        st = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);
        base = `http://127.0.0.1:${st.port}`;
        worldsDirectory = path.join(scratch, 'data', 'default-user', 'worlds');

        fs.mkdirSync(worldsDirectory, { recursive: true });
        fs.writeFileSync(path.join(worldsDirectory, `${ORDINARY}.json`), JSON.stringify({ entries: {} }));
        fs.writeFileSync(path.join(worldsDirectory, `${UNREADABLE}.json`), ENVELOPED);
    }, 240_000);

    afterAll(async () => {
        await st?.stop();
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    /**
     * @param {string} name The world to find in the listing
     * @returns {Promise<any>} Its row
     */
    async function rowFor(name) {
        const response = await fetch(`${base}/api/worldinfo/list`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });

        expect(response.status).toBe(200);
        const rows = await response.json();
        return rows.find((/** @type {any} */ row) => row.file_id === name);
    }

    test('every listed world carries an mtime and a size', async () => {
        const row = await rowFor(ORDINARY);

        expect(row).toBeDefined();
        expect(typeof row.change.mtime).toBe('number');
        expect(row.change.mtime).toBeGreaterThan(0);
        expect(row.change.size).toBe(fs.statSync(path.join(worldsDirectory, `${ORDINARY}.json`)).size);
    });

    test('🔴 writing the book moves the token — the assertion the whole field exists for', async () => {
        const before = (await rowFor(ORDINARY)).change;

        // Through the endpoint, not the filesystem: this is the write a client actually performs, and
        // it is the one whose invisibility to the caller was the problem.
        const write = await fetch(`${base}/api/worldinfo/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: ORDINARY, data: { entries: { 0: { uid: 0, key: ['added'], content: 'x' } } } }),
        });
        expect(write.status).toBe(200);

        const after = (await rowFor(ORDINARY)).change;

        // Size alone would be enough here, so mtime is asserted separately — otherwise a token that
        // never moved would still pass on any edit that changed the length.
        expect(after.mtime).toBeGreaterThanOrEqual(before.mtime);
        expect(after).not.toEqual(before);
    });

    test('reading the book does not move it, so a poll cannot invent a change', async () => {
        const before = (await rowFor(ORDINARY)).change;

        // Asserted before the comparison, because `undefined === undefined` — without this the test
        // passes cheerfully against a build that has no token at all, which is exactly what it was
        // observed doing when the field was reverted to check it fails for the right reason.
        expect(before).toEqual({ mtime: expect.any(Number), size: expect.any(Number) });

        const read = await fetch(`${base}/api/worldinfo/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: ORDINARY }),
        });
        expect(read.status).toBe(200);

        expect((await rowFor(ORDINARY)).change).toEqual(before);
    });

    test('a book the fork cannot read still lists, still says so, and still has a token', async () => {
        // The unavailable row is the one most likely to lose a field added later — it is built in its own
        // branch. A client watching for ST-side changes needs the token most on a book it cannot read,
        // because it has nothing else to compare.
        const row = await rowFor(UNREADABLE);

        expect(row).toBeDefined();
        expect(row.storage.unavailable).toBe(true);
        expect(row.change.size).toBe(ENVELOPED.length);
    });
});
