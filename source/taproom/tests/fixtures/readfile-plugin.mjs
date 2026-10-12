import fs from 'node:fs';
import path from 'node:path';

import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * Probe for §20 — `context.readFile`.
 *
 * 🔴 THE ONE THING THIS FIXTURE EXISTS TO PROVE: that `readFile` goes through the storage provider and not
 * through `fs`. On a plaintext install those are the same answer, so a suite that only tested plaintext would
 * pass against a broken implementation. Under the seam provider the bytes on disk carry a `SEAM:` prefix, so
 * an `fs`-based implementation hands back the MARKED bytes and a provider-based one hands back the plaintext.
 * That difference is the whole capability — which is why this reads the same file BOTH ways and reports both
 * answers, rather than just asserting that one of them succeeded.
 *
 * ⚠️ IT RUNS ON A ROUTE, NOT ON `onStorageReady`. That hook fires only on an unlock TRANSITION
 * (`storage.js:377` — `!wasReady && isReady`), and the seam provider is ready from boot, so it would never
 * fire and every assertion downstream would be vacuously green. A route also lets the test choose the moment,
 * after the server is definitely up and the user's directories definitely exist.
 */

/** The file the test plants for us, relative to the user's own directory. */
const TARGET = process.env.ST_READFILE_TARGET ?? 'characters/probe.txt';

export const info = {
    id: 'readfile-probe',
    name: 'readFile probe',
    description: 'Exercises context.readFile through the provider (§20).',
};

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The plugin context
 */
export async function init(router, context) {
    if (!fixtureIsEnabled('readfile-probe')) {
        return;
    }

    /**
     * Record what a call did, whether it returned or threw.
     * @param {() => Promise<any>} attempt The call
     * @returns {Promise<string>} `OK <text>` or `THREW <message>`
     */
    async function probe(attempt) {
        try {
            const result = await attempt();
            return `OK ${Buffer.isBuffer(result) ? result.toString('utf-8') : String(result)}`;
        } catch (error) {
            return `THREW ${error?.message ?? error}`;
        }
    }

    router.get('/probe', async (request, response) => {
        const handle = String(request.query.handle ?? '');

        /** @type {Record<string, string>} */
        const out = {};

        out.present = typeof context.readFile;

        // 1. THE CAPABILITY — must be the plaintext the test planted, despite the marker on disk.
        out.read = await probe(() => context.readFile(handle, TARGET));

        // 2. THE WITNESS — the same file read the way a plugin already could, with raw `fs`. Under the
        //    provider this MUST differ from (1). If the two ever match, (1) proves nothing.
        try {
            out.direct = `OK ${fs.readFileSync(path.join(context.userDirectory(handle), TARGET), 'utf-8')}`;
        } catch (error) {
            out.direct = `THREW ${error?.message ?? error}`;
        }

        // 3. Escapes, refused before anything touches the disk.
        out.climb = await probe(() => context.readFile(handle, '../../config.yaml'));
        out.absolute = await probe(() => context.readFile(handle, path.resolve('config.yaml')));

        // 4. Missing file fails LOUD rather than coming back empty — a memory plugin reading "missing" as
        //    "this character has no card" would extract a baseline of nothing and never know.
        out.missing = await probe(() => context.readFile(handle, 'characters/does-not-exist.png'));

        // 5. A bad handle is refused exactly as `userDirectory` refuses one.
        out.badhandle = await probe(() => context.readFile('../elsewhere', TARGET));

        response.json(out);
    });
}
