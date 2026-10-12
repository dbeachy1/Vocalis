import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll, beforeEach, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * 🔴 A WORLD THE FORK CANNOT READ MUST NOT BE DELETABLE OR OVERWRITABLE.
 *
 * `loadWorldInfo` already 409s on an unreadable world so the native editor hides instead of opening an empty
 * one over the user's real data, and `markUnavailableWorlds()` disables the matching `<option>` with a ⚠ so
 * it cannot even be picked. Both of those are CLIENT-side, and this suite exists because a client is the
 * wrong place to keep a rule about destroying data.
 *
 * The case that produced it, 2026-08-02: the `Lore-Library-Lite` extension replaces the World Info UI and
 * builds its own lorebook list from `world_names`, so it inherits neither guard. Its delete handler asks
 * `getEntryCount(data)`, which returns `0` for the `null` an unreadable world produces — so its own "you must
 * empty the lorebook first" check passes, and the user is offered *"Permanently delete empty lorebook X"* for
 * a lorebook that is not empty. Nothing about that is specific to one extension; any caller that reads
 * "unreadable" as "zero entries" reaches the same place, which is why the fix is on the server.
 *
 * ## Why an enveloped file with NO provider installed is the honest fixture
 *
 * That is the real shape of the danger. With nothing registered, `storage.exists` and `storage.unlink` are
 * plain `fs` against the file's own scrambled on-disk name — the file IS found and unlinking it WOULD
 * succeed. `describeStorageState` reads the envelope header off the raw bytes without decrypting anything,
 * so it can still tell that these bytes belong to somebody. No provider fixture is needed, and using one
 * would test a weaker thing: with a provider loaded, `owns()` would reroute the call and the plain-`fs`
 * destruction this guards could not happen in the first place.
 *
 * ⚠️ The assertion that matters is **the bytes are still on disk afterwards**, not the status code. A 409
 * with the file already gone would be a passing test over a lost lorebook.
 */
describe('🔴 World info: an unreadable world survives delete and edit', () => {
    /** @type {string} */
    let scratch;
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let st;
    /** @type {string} */
    let base;
    /** @type {string} */
    let worldsDirectory;

    /**
     * An envelope header in the fork's own wire format — `stenv:<version>:<provider-id>:` — naming a provider
     * that is not installed here. Spelled out rather than imported, for the reason `fixtures/mixed-provider.js`
     * gives: two independent statements of a wire format catch drift that one shared constant hides.
     */
    const ENVELOPED = Buffer.from('stenv:1:never-installed:VGhpcyBpcyBub3QgcGxhaW50ZXh0Lg==', 'utf-8');

    /** The unreadable world. Named as the on-disk name would look with its provider gone. */
    const UNREADABLE = 'venc1~AAAABBBBCCCCDDDD';

    /** An ordinary world, so every refusal below is proved to be about the envelope and not about the route. */
    const ORDINARY = 'An Ordinary World';

    beforeAll(async () => {
        scratch = makeScratchDirectory('worldinfo-unavailable-guard');

        st = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);
        base = `http://127.0.0.1:${st.port}`;
        worldsDirectory = path.join(scratch, 'data', 'default-user', 'worlds');

        fs.mkdirSync(worldsDirectory, { recursive: true });
    }, 240_000);

    // 🔴 REBUILT BEFORE EVERY TEST, AND THAT IS NOT TIDINESS. Written once in `beforeAll`, the first test to
    // delete the fixture silently disarms every test after it: with the guard removed, `delete` really does
    // unlink the file, and the `edit` cases that follow then write a NEW world and pass — reporting green for
    // an unguarded endpoint. Each test gets its own bytes, so each one fails on its own account.
    beforeEach(() => {
        fs.writeFileSync(path.join(worldsDirectory, `${UNREADABLE}.json`), ENVELOPED);
        fs.writeFileSync(path.join(worldsDirectory, `${ORDINARY}.json`), JSON.stringify({ entries: {} }));
    });

    afterAll(async () => {
        await st?.stop();
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    /**
     * @param {string} route Route under `/api/worldinfo`
     * @param {any} body JSON body
     * @returns {Promise<{status: number, body: any}>} The response
     */
    async function post(route, body) {
        const response = await fetch(`${base}/api/worldinfo/${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        const text = await response.text();

        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = text;
        }

        return { status: response.status, body: parsed };
    }

    /**
     * @param {string} name World name
     * @returns {string} Absolute path to its file
     */
    function fileFor(name) {
        return path.join(worldsDirectory, `${name}.json`);
    }

    test('🔴 delete refuses an unreadable world, names the provider, and leaves the ciphertext on disk', async () => {
        const { status, body } = await post('delete', { name: UNREADABLE });

        expect(status).toBe(409);
        expect(body?.storage?.unavailable).toBe(true);
        expect(body?.storage?.requiresProvider).toBe('never-installed');

        // The assertion the status code is only a proxy for.
        expect(fs.existsSync(fileFor(UNREADABLE))).toBe(true);
        expect(fs.readFileSync(fileFor(UNREADABLE))).toEqual(ENVELOPED);
    });

    test('🔴 edit refuses to overwrite an unreadable world, and the bytes are unchanged', async () => {
        const { status, body } = await post('edit', { name: UNREADABLE, data: { entries: {} } });

        expect(status).toBe(409);
        expect(body?.storage?.unavailable).toBe(true);
        expect(fs.readFileSync(fileFor(UNREADABLE))).toEqual(ENVELOPED);
    });

    test('an ordinary world is still editable, so the guard is about the envelope and not the route', async () => {
        const { status } = await post('edit', { name: ORDINARY, data: { entries: { 0: { uid: 0, key: ['x'] } } } });

        expect(status).toBe(200);
        expect(JSON.parse(fs.readFileSync(fileFor(ORDINARY), 'utf-8')).entries['0'].uid).toBe(0);
    });

    test('a NEW world can still be created, because a path with no file describes as plaintext', async () => {
        const { status } = await post('edit', { name: 'Brand New', data: { entries: {} } });

        expect(status).toBe(200);
        expect(fs.existsSync(fileFor('Brand New'))).toBe(true);
    });

    test('and an ordinary world is still deletable', async () => {
        const { status } = await post('delete', { name: ORDINARY });

        expect(status).toBe(200);
        expect(fs.existsSync(fileFor(ORDINARY))).toBe(false);
    });
});
