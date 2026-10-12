/**
 * Stable character identity — the avatar filename → UUID map that §22 is built on.
 *
 * 🔴 WHY THIS EXISTS. A character's identity used to be its display NAME, and a rename changed it. Anything
 * keyed on the name — a memory store's partitions, most of all — silently pointed at a stranger the moment the
 * user renamed a card. The avatar filename is not a fallback either: `renameCharacter` mints a NEW avatar
 * filename from the new display name and hand-migrates every avatar-keyed subsystem in the app
 * (`public/script.js:7220+`).
 *
 * 🔴 THE TRICK, STATED PLAINLY: the fork can key on the avatar filename precisely BECAUSE the fork is what
 * changes it. The avatar failed as a key for a plugin because a rename moved it out from under them. It does
 * not fail here, because `renameCharacterId()` below runs in the same request that does the renaming. The
 * plugin gets a UUID that never moves; the churn stays on this side of the wall.
 */

import path from 'node:path';

import * as storage from './storage.js';
import { uuidv4 } from './util.js';

export const CHARACTER_IDS_FILE = 'character-ids.json';

/**
 * @typedef {object} CharacterIdIndex
 * @property {number} version Index version
 * @property {Object.<string, string>} ids Avatar filename → UUID
 */

/**
 * Serialises read-modify-write on the map, per user.
 *
 * ⚠️ §22.6 listed first-sight minting under concurrency as an open question. This is the answer, and it is the
 * boring one: the server is a single process, so a promise chain per user root is enough. Two generations
 * racing on a never-seen card would otherwise both read "absent", both mint, and the loser's UUID would be
 * written over — orphaning every memory already filed under it in the same breath that created it.
 * @type {Map<string, Promise<any>>}
 */
const writeChains = new Map();

/**
 * Runs `work` with exclusive access to one user's map.
 * @param {string} userDataRoot Path to the user data directory root
 * @param {() => Promise<any>} work What to do while holding it
 * @returns {Promise<any>} Whatever `work` returned
 */
function serialise(userDataRoot, work) {
    // Chain onto whatever is in flight, and swallow ITS failure here so one caller's error does not reject
    // every caller queued behind it. The original promise is what the original caller awaits, so the error is
    // still delivered — exactly once, to the request that caused it.
    const previous = writeChains.get(userDataRoot) ?? Promise.resolve();
    const next = previous.catch(() => { }).then(work);

    writeChains.set(userDataRoot, next.catch(() => { }));
    return next;
}

/**
 * Reads the map.
 *
 * 🔴 A PROVIDER ERROR MUST PROPAGATE; ONLY ENOENT MEANS "START FRESH". This is the lesson `image-metadata.js`
 * learned the hard way (`readMetadataIndex`, and read its comment), and the stakes are higher here. There, a
 * swallowed provider error rebuilt an empty index and lost the user's hand-made folders. Here it would hand
 * back an empty map, and the very next mint would issue a BRAND NEW UUID for a character that already had
 * one — permanently orphaning every memory filed under the old id, on an encrypted install that was merely
 * locked rather than broken.
 *
 * "I cannot read it" and "there is nothing there" are opposite facts. This is where they must not be confused.
 * @param {string} userDataRoot Path to the user data directory root
 * @returns {Promise<CharacterIdIndex>} The map, or a fresh empty one if it does not exist yet
 */
export async function readCharacterIds(userDataRoot) {
    const indexPath = path.join(userDataRoot, CHARACTER_IDS_FILE);

    try {
        const raw = /** @type {string} */ (await storage.readFile(indexPath, 'utf8'));
        const parsed = JSON.parse(raw);

        // A file that exists but holds something other than the expected shape is corruption, not absence.
        // Treating it as absence would re-mint, so refuse instead and let the caller fail loudly.
        if (!parsed || typeof parsed !== 'object' || typeof parsed.ids !== 'object' || parsed.ids === null) {
            throw new Error(`${CHARACTER_IDS_FILE} exists but is not a character id index`);
        }

        return { version: Number(parsed.version) || 1, ids: parsed.ids };
    } catch (error) {
        // ENOENT is the ONLY absence. A provider error, a parse failure and a wrong shape all mean the map
        // exists and cannot be trusted right now, and every one of them must fail the caller rather than
        // resolve to an empty map that the next mint would write over the real one.
        if (/** @type {any} */ (error)?.code === 'ENOENT') {
            return { version: 1, ids: {} };
        }

        throw error;
    }
}

/**
 * Writes the map.
 * @param {string} userDataRoot Path to the user data directory root
 * @param {CharacterIdIndex} index The map to write
 */
export async function writeCharacterIds(userDataRoot, index) {
    const indexPath = path.join(userDataRoot, CHARACTER_IDS_FILE);
    await storage.writeFile(indexPath, JSON.stringify(index, null, 4), 'utf8');
}

/**
 * Looks a character's id up. **Never mints.**
 *
 * 🔴 THE LOOKUP/MINT SPLIT IS THE `null` CONTRACT, AND IT IS LOAD-BEARING (§22.8.2). Per-turn resolution runs
 * over up to 40 historical turns, which can name characters that were deleted, imported from a chat older than
 * this map, or renamed outside the app. Minting there would grow the map without bound with ids for characters
 * nobody can address, and — worse — would hand a plugin a confident-looking id for a character that no longer
 * exists. Minting happens only where a character is actually generating (`getOrMintCharacterId`). Everywhere
 * else absence resolves to `null`, and a plugin skips it.
 * @param {string} userDataRoot Path to the user data directory root
 * @param {string} avatar Avatar filename, e.g. `Marcus.png`
 * @returns {Promise<string|null>} The id, or `null` if this avatar has never been minted
 */
export async function lookupCharacterId(userDataRoot, avatar) {
    if (typeof avatar !== 'string' || avatar === '') {
        return null;
    }

    const index = await readCharacterIds(userDataRoot);
    return index.ids[avatar] ?? null;
}

/**
 * Runs the map backwards: id → avatar filename. **Never mints.**
 *
 * 🔴 THE RESULT IS FORK INTERNALS AND MUST NOT REACH A PLUGIN (§22.8.2, §25). An avatar filename is the exact
 * thing `resolveIdentity` strips on the way past, and handing one back through any plugin-facing surface would
 * undo that as thoroughly as never having stripped it. The one caller is `context.readCharacterCard`, which
 * uses it to reach the file and returns BYTES. If you are adding a second caller, check that it does the same.
 *
 * ⚠️ A LINEAR SCAN, NOT A MAINTAINED REVERSE INDEX, AND THAT IS THE CHEAPER MISTAKE. The map holds one entry
 * per card the user has ever generated with — tens, not thousands — so the scan is free at this size. A second
 * persisted index would have to be written by `getOrMintCharacterId`, `renameCharacterId` and
 * `deleteCharacterId` in lockstep with the forward one, and the failure mode when they drift is a plugin
 * reading *another character's card*: silent, and indistinguishable from correct output.
 * @param {string} userDataRoot Path to the user data directory root
 * @param {string} charId The UUID handed to a plugin on `OutgoingPrompt.charId`
 * @returns {Promise<string|null>} The avatar filename, or `null` if no card carries that id
 */
export async function lookupAvatarById(userDataRoot, charId) {
    if (typeof charId !== 'string' || charId === '') {
        return null;
    }

    const index = await readCharacterIds(userDataRoot);
    return Object.keys(index.ids).find(avatar => index.ids[avatar] === charId) ?? null;
}

/**
 * Looks a character's id up, minting one on first sight.
 * @param {string} userDataRoot Path to the user data directory root
 * @param {string} avatar Avatar filename, e.g. `Marcus.png`
 * @returns {Promise<string|null>} The id, or `null` if there is no avatar to key on
 */
export async function getOrMintCharacterId(userDataRoot, avatar) {
    if (typeof avatar !== 'string' || avatar === '') {
        return null;
    }

    return await serialise(userDataRoot, async () => {
        const index = await readCharacterIds(userDataRoot);

        if (index.ids[avatar]) {
            return index.ids[avatar];
        }

        const minted = uuidv4();
        index.ids[avatar] = minted;
        await writeCharacterIds(userDataRoot, index);
        return minted;
    });
}

/**
 * Moves an id from one avatar filename to another, keeping it the same string.
 *
 * ⚠️ THIS IS THE WHOLE POINT OF §22 AND IT IS ONE LINE OF BEHAVIOUR: the id does not change. The old key is
 * removed so a future card that happens to reuse the filename cannot inherit a stranger's identity.
 * @param {string} userDataRoot Path to the user data directory root
 * @param {string} oldAvatar The avatar filename before the rename
 * @param {string} newAvatar The avatar filename after it
 * @returns {Promise<string|null>} The (unchanged) id, or `null` if the old avatar had none
 */
export async function renameCharacterId(userDataRoot, oldAvatar, newAvatar) {
    if (typeof oldAvatar !== 'string' || typeof newAvatar !== 'string' || oldAvatar === '' || newAvatar === '') {
        return null;
    }

    return await serialise(userDataRoot, async () => {
        const index = await readCharacterIds(userDataRoot);
        const existing = index.ids[oldAvatar];

        if (!existing) {
            // Never minted — nothing to carry across. The card mints on its next generation under the new name,
            // which is the same position a freshly imported card is in.
            return null;
        }

        delete index.ids[oldAvatar];
        index.ids[newAvatar] = existing;
        await writeCharacterIds(userDataRoot, index);
        return existing;
    });
}

/**
 * Forgets a character's id.
 *
 * ⚠️ The id is gone; a re-import of the same card mints a fresh one and its memories do not come back. §22.6
 * leaves *whether a plugin should destroy memories on delete* to the plugin — this only stops the fork from
 * handing the same id to a different card that later takes the filename.
 * @param {string} userDataRoot Path to the user data directory root
 * @param {string} avatar Avatar filename
 * @returns {Promise<string|null>} The id that was removed, or `null` if there was none
 */
export async function deleteCharacterId(userDataRoot, avatar) {
    if (typeof avatar !== 'string' || avatar === '') {
        return null;
    }

    return await serialise(userDataRoot, async () => {
        const index = await readCharacterIds(userDataRoot);
        const existing = index.ids[avatar];

        if (!existing) {
            return null;
        }

        delete index.ids[avatar];
        await writeCharacterIds(userDataRoot, index);
        return existing;
    });
}

/**
 * Resolves many avatar filenames at once, for the per-turn ids on `recentMessages` (§22.8.2).
 *
 * ⚠️ ONE READ FOR THE WHOLE WINDOW. A 40-turn window would otherwise be 40 reads of the same file, and on an
 * encrypted install every one of those is a decrypt. Lookup-only, per the split documented on
 * `lookupCharacterId`.
 * @param {string} userDataRoot Path to the user data directory root
 * @param {Array<string|null|undefined>} avatars Avatar filenames, in order, with gaps for turns that have none
 * @returns {Promise<Array<string|null>>} Ids, positionally parallel to `avatars`, `null` where unresolvable
 */
export async function lookupCharacterIds(userDataRoot, avatars) {
    if (!Array.isArray(avatars) || avatars.length === 0) {
        return [];
    }

    const index = await readCharacterIds(userDataRoot);
    return avatars.map(avatar => (typeof avatar === 'string' && avatar !== '' ? index.ids[avatar] ?? null : null));
}
