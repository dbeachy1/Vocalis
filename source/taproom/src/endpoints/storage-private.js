import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import * as storage from '../storage.js';
import { describeStorageState } from '../storage-status.js';
import { summariseUnavailableData } from '../storage-provenance-summary.js';
import { isPathUnderParent } from '../util.js';

/**
 * 🔒 THE PER-CHAT STORAGE MARKER — authenticated, and deliberately a different endpoint from the public one.
 *
 * `storage-public.js` answers one instance-level boolean for the login page and is anonymous. This answers a
 * per-chat question for the chat list, and `DESIGN_MIXED_MODE.md` §10 is explicit that the two must not be
 * the same endpoint or the same response:
 *
 * - 🔴 **Authenticated, always.** An anonymous caller must not learn whether a chat exists, let alone whether
 *   it is encrypted.
 * - 🔴 **The anonymous endpoint is never widened to carry this.** `POST /api/users/list` already hands
 *   unauthenticated callers every handle on the box; a per-user or per-chat encryption flag anywhere
 *   anonymous turns that list into a targeting list — *these accounts have vaults worth attacking, those do
 *   not.* This router lives below `requireLoginMiddleware` for that reason and no other.
 * - 🔴 **The provider id appears HERE and nowhere anonymous.** §3.1 accepts the fingerprinting cost of
 *   naming the provider on disk, because someone reading the disk can already fingerprint the ciphertext
 *   format — but only through an authenticated endpoint.
 *
 * ## Why the provider id is safe to send and still not safe to trust
 *
 * It comes from {@link describeStorageState}, which reads the envelope header and validates the id against
 * `[a-z0-9-]{1,32}`, returning **null** rather than the claimed string when it fails. So what crosses the
 * wire is either a plausible id or nothing; a planted `<script>` is already gone by the time this file sees
 * it (§12 test 9a).
 *
 * ⚠️ That still does not make it a name to ACT on. §3.1: render it as text, never as markup, and never build
 * a URL, an install command or a fetch out of it. "This chat requires plugin X" must not become a one-click
 * path to installing whatever a planted file names.
 */
export const router = express.Router();

/** The most chats one request may ask about. A chat list is paged; an unbounded loop over `stat` is not. */
const MAX_CHATS_PER_REQUEST = 500;

/**
 * 🪪 The surface-5 summary, cached per user for the life of the process (§11.3). Keyed by the user's own root
 * directory — one entry per account, never shared — and only ever holding this instance's own scan results,
 * so it is not a place any untrusted input lands. Cleared by nothing but a restart, which is exactly when the
 * loaded provider set can change.
 * @type {Map<string, import('../storage-provenance-summary.js').UnavailableSummary>}
 */
const summaryCache = new Map();

/**
 * Resolve one requested chat to an absolute path inside this user's own chats directory.
 *
 * 🔴 THE GROUP ROOT IS A SIBLING, NOT A SUBDIRECTORY. Character chats live in `chats/<character>/<chat>`,
 * group chats in a flat `group chats/<chat>` next to it, and `isPathUnderParent` is checked against
 * whichever root was chosen — so a request that asks for a group chat can never be walked back into the
 * character tree, or the reverse, by any spelling of the name.
 * @param {import('express').Request} request The request, for the user's directories
 * @param {string} directory The character directory, or an empty string for a loose chat
 * @param {string} name The chat file name
 * @param {boolean} group Whether this name is a group chat, and so lives under `group chats/`
 * @returns {string|null} The absolute path, or null if it escapes the root it was resolved against
 */
function resolveChatPath(request, directory, name, group) {
    const root = group ? request.user.directories.groupChats : request.user.directories.chats;
    const segments = [root];

    // Both segments are sanitised individually. `isPathUnderParent` below is the guard that actually
    // matters; this makes the common case impossible rather than merely detected.
    //
    // A group chat directory is FLAT — `chats/group/<id>.jsonl` does not exist — so a `directory` sent
    // alongside `group: true` is meaningless and is dropped rather than joined. Honouring it would be a
    // second spelling for the same file and a second thing the traversal guard has to be right about.
    if (directory && !group) {
        segments.push(sanitize(String(directory)));
    }

    segments.push(sanitize(String(name)));

    const resolved = path.join(...segments);
    return isPathUnderParent(root, resolved) ? resolved : null;
}

/**
 * The per-chat storage marker, in one round trip.
 *
 * Batched deliberately: §6.1 notes a 200-chat list is 200 provider calls, and 200 HTTP requests on top of
 * that would be a self-inflicted wound. The provider call stays once per chat either way.
 */
router.post('/chat-status', (request, response) => {
    // 🔴 DEFENCE IN DEPTH, NOT THE DEFENCE. The mount below `requireLoginMiddleware` in server-main.js is
    // what actually keeps anonymous callers out, and it must stay there. This guard exists because the
    // failure mode of getting that wrong was discovered to be silent: mounted above the boundary, this
    // handler reached for `request.user.directories` and threw, which express turned into a 500 — an error
    // response, carrying no chat names, that looked exactly like a refusal to a test asserting only "some
    // error". So refuse explicitly rather than crash, and let the 403 be a 403 wherever this ends up.
    // One request is either about character chats or about group chats, never a mixture — the chat list it
    // feeds is built from one or the other and never shows both at once. A per-request flag rather than a
    // per-entry one keeps the two roots from being interleaved inside a single loop.
    const group = request.body?.group === true;

    if (!(group ? request.user?.directories?.groupChats : request.user?.directories?.chats)) {
        return response.sendStatus(403);
    }

    const requested = Array.isArray(request.body?.chats) ? request.body.chats : [];

    if (requested.length > MAX_CHATS_PER_REQUEST) {
        return response.status(400).send({ error: 'Too many chats in one request.' });
    }

    // ⚠️ NULL PROTOTYPE, BECAUSE THE KEYS ARE CHAT NAMES AND A CHAT NAME IS THE USER'S TO CHOOSE. A chat
    // called `__proto__` does not create an own property on a plain object literal — it reassigns the
    // prototype — so its entry simply vanished from the response, and the §11 dead row this endpoint exists
    // to draw was silently dropped for exactly that chat. Not exploitable, but the failure lands on the one
    // row that most needed drawing.
    /** @type {Record<string, import('../storage-status.js').StorageState>} */
    const chats = Object.create(null);

    for (const entry of requested) {
        const name = typeof entry === 'string' ? entry : entry?.name;

        if (typeof name !== 'string' || !name) {
            continue;
        }

        const directory = typeof entry === 'object' && entry !== null ? String(entry.directory ?? '') : '';
        chats[name] = describeStorageState(resolveChatPath(request, directory, name, group));
    }

    // 🔴 THE WORDS ARE THE PROVIDER'S, AND THE FORK HAS NONE OF ITS OWN. The same rule storage-public.js
    // states: SillyTavern cannot say "your data is encrypted", because it does not know that — a provider
    // might be compression, or a remote object store. A provider that returns nothing for this situation
    // gets no tooltip, and there is deliberately no fork-side default to fall back on.
    const marker = storage.describe('storage.chatMarker')?.body ?? null;

    return response.json({ chats, marker });
});

/**
 * 🪪 SURFACE 5 — THE ONE-SCAN "WHAT DID MY UNINSTALL TAKE?" SUMMARY (`DESIGN_STORAGE_PROVENANCE.md` §7
 * surface 5). Grouped counts of the account's unavailable data, by the provider it needs.
 *
 * 🔴 AUTHENTICATED, LIKE EVERYTHING IN THIS ROUTER, AND FOR THE SAME REASON. This walks one user's data root
 * and names the providers behind it — per-user data that must never become an anonymous oracle (§9 test 9,
 * `DESIGN_MIXED_MODE.md` §10). It answers only for `request.user`, and the mount below
 * `requireLoginMiddleware` is what enforces that.
 *
 * ⚠️ CACHED UNTIL REBOOT, per §11.3. A full walk is the per-file cost of surface 4 times every data type, so
 * it is not run on every render — it is behind a button, and the result is kept per user for the life of the
 * process. That the provider SET only changes at boot (providers load once, on start) is what makes
 * "until reboot" the right lifetime and not merely a convenient one: the answer cannot go stale in the one
 * dimension that would matter. `refresh: true` recomputes anyway, so a user who has since deleted the
 * affected files can re-scan without restarting.
 */
router.post('/unavailable-summary', (request, response) => {
    // Defence in depth behind the auth mount, exactly as `/chat-status`: refuse rather than throw if this
    // ever ends up reachable without a resolved user, so the failure is an honest 403 and not a 500 that a
    // test could mistake for a refusal.
    const root = request.user?.directories?.root;

    if (!root) {
        return response.sendStatus(403);
    }

    const cached = summaryCache.get(root);

    if (cached && request.body?.refresh !== true) {
        return response.json(cached);
    }

    // ⚠️ `refresh: true` DELIBERATELY RE-WALKS, EVERY TIME, AND THAT IS A TESTED CONTRACT.
    //
    // The review asked for a throttle here: the walk is fully synchronous and can cost on the order of
    // 150,000 blocking syscalls, so an authenticated user can stall the instance by asking repeatedly. The
    // mechanics of that are real. The fix is not, at least not this one — `storage-provenance-summary.test.js`
    // pins "the result is cached until asked to refresh", and two further cases plant a file and immediately
    // re-scan to see it. A time-based throttle serves the stale answer to exactly those callers, which turns
    // the one escape hatch a user has after deleting affected files into a button that lies to them.
    //
    // Serialising with an in-flight promise buys nothing either: the walk is synchronous, so two requests
    // cannot overlap in the first place — the cost is sequential by construction.
    //
    // Left as it is on purpose. It is authenticated, it answers only for the caller's own account, and the
    // honest fix is to make the walk asynchronous and yield between data types, which is a change to the
    // scanner rather than a guard on this route.
    const summary = summariseUnavailableData(request.user.directories);
    summaryCache.set(root, summary);

    return response.json(summary);
});
