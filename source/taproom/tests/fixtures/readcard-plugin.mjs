import fs from 'node:fs';
import path from 'node:path';

import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * Probe for §25 — `context.readCharacterCard`.
 *
 * 🔴 WHAT THIS PROVES THAT §20's PROBE CANNOT: that a plugin holding **only an id** can reach a card. §20 gave
 * a plugin `readFile`, and §22.8.2 forbids it from learning the avatar filename — so the reader existed and
 * nothing could name a file to hand it. The test's whole point is therefore that this fixture is **never told
 * the avatar filename** for the card it reads, and the avatar filename is deliberately not derivable from any
 * display name.
 *
 * ⚠️ The ONE place a filename is used is the witness read below, and it comes from an environment variable the
 * test sets — not from the API. If it ever comes from `context`, the capability has leaked a path and §22.8.2
 * is broken, which is precisely what `nopath` asserts against.
 *
 * ⚠️ IT RUNS ON A ROUTE, NOT ON `onStorageReady` — same reasoning as `readfile-plugin.mjs`: that hook fires
 * only on an unlock transition and the seam provider is ready from boot, so assertions hung off it would never
 * run and the suite would be green having tested nothing.
 */

/** The id of a character whose card is really on disk. */
const KNOWN_ID = process.env.ST_READCARD_ID ?? '';

/** An id that IS in the map but whose card file was never planted — a deleted card. */
const ORPHAN_ID = process.env.ST_READCARD_ORPHAN_ID ?? '';

/** 🔴 For the WITNESS READ ONLY. The capability under test must never tell us this. */
const AVATAR_FOR_WITNESS = process.env.ST_READCARD_AVATAR ?? '';

export const info = {
    id: 'readcard-probe',
    name: 'readCharacterCard probe',
    description: 'Exercises context.readCharacterCard by id (§25).',
};

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The plugin context
 */
export async function init(router, context) {
    if (!fixtureIsEnabled('readcard-probe')) {
        return;
    }

    /**
     * Record what a call did, whether it returned, returned null, or threw.
     *
     * ⚠️ `null` is reported as its own answer rather than folded into the string, because §25's contract turns
     * on `null` and a throw being DIFFERENT outcomes. A probe that stringified both would pass whichever way
     * the implementation went.
     * @param {() => Promise<any>} attempt The call
     * @returns {Promise<string>} `OK <text>`, `NULL`, or `THREW <message>`
     */
    async function probe(attempt) {
        try {
            const result = await attempt();

            if (result === null) {
                return 'NULL';
            }

            return `OK ${Buffer.isBuffer(result) ? result.toString('utf-8') : String(result)}`;
        } catch (error) {
            return `THREW ${error?.message ?? error}`;
        }
    }

    router.get('/probe', async (request, response) => {
        const handle = String(request.query.handle ?? '');

        /** @type {Record<string, string>} */
        const out = {};

        out.present = typeof context.readCharacterCard;

        // 1. THE CAPABILITY — an id, and nothing else, reaches the card's decrypted bytes.
        out.read = await probe(() => context.readCharacterCard(handle, KNOWN_ID));

        // 2. THE WITNESS — the same file read the way a plugin already could, with raw `fs`. Under the seam
        //    provider this MUST differ from (1); if the two ever match, (1) proves nothing about decryption.
        try {
            const direct = path.join(context.userDirectory(handle), 'characters', AVATAR_FOR_WITNESS);
            out.direct = `OK ${fs.readFileSync(direct, 'utf-8')}`;
        } catch (error) {
            out.direct = `THREW ${error?.message ?? error}`;
        }

        // 3. An id nothing carries. Ordinary state, so `null` — not a throw.
        out.unknown = await probe(() => context.readCharacterCard(handle, 'e2f0a1c4-nobody-minted-this'));

        // 4. An id the map still knows whose card is GONE. Also `null`: the map outlived the file, which is
        //    what a deleted card looks like from here.
        out.orphan = await probe(() => context.readCharacterCard(handle, ORPHAN_ID));

        // 5. Argument checks, refused before anything touches the disk.
        out.badhandle = await probe(() => context.readCharacterCard('../elsewhere', KNOWN_ID));
        out.emptyid = await probe(() => context.readCharacterCard(handle, ''));

        response.json(out);
    });
}
