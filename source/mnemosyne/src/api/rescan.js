import { normal, sensitive } from '../logging.js';
import { asRuntimeDefaults, readSettings } from '../settings.js';
import { describeFailure } from '../ingest/diagnose.js';
import { rescanTurns } from '../ingest/index.js';

import { renderView, sendFragment } from './panel.js';
import { clampInt, identityOf, storeForRequest, wantsFragment } from './request.js';

/**
 * `POST /memory/rescan` — read the last N messages of the open chat again and store what is missing.
 *
 * The chat is read from disk through `context.readChat` (fork §29), and extraction runs inside this request.
 * The panel marks the control busy while the rescan is pending and replaces the view when it finishes.
 *
 * ⚠️ **It holds the request open for the whole rescan** — about one model call per 36 messages. That is the
 * point: the user asked for it to happen now and to see the result. A client that disconnects does not stop
 * it; the passes finish and the memories are kept.
 *
 * 🔴 **The store is the caller's own and so is the chat.** `storeForRequest` names the store from the
 * authenticated handle, and `readChat` is asked for that same handle's chat. There is no user parameter to
 * forge, the same property `resetMemories` rests on.
 */

/** The largest N the route accepts. Only a sanity bound: a chat longer than this is read in its last 100,000. */
const RESCAN_MAX = 100000;

/**
 * @param {import('express').Request} req Express request — `count` in the body or the query; `chatId` and
 *        the identity axes from the host's ambient parameters
 * @param {import('express').Response} res Express response
 * @param {import('../host/context.js').HostContext} host The fork, as we are allowed to see it
 * @returns {Promise<void>}
 */
export async function rescanRoute(req, res, host) {
    const store = storeForRequest(req, res);
    if (!store) return;

    const handle = /** @type {{ profile: { handle: string } }} */ (req.user).profile.handle;
    const { chatId, charId, personaId } = identityOf(req);
    const count = clampInt(req.body?.count ?? req.query?.count, 0, 0, RESCAN_MAX);

    /**
     * Answer with a sentence: the settings screen with the notice in HTML, or JSON with a status.
     * @param {number} status
     * @param {string} notice
     * @param {object} [json]
     */
    const answer = (status, notice, json = {}) => {
        if (wantsFragment(req)) {
            sendFragment(res, renderView(store, req, handle, { rescanNotice: notice }));
            return;
        }
        res.status(status).json(status >= 400 ? { error: notice } : { message: notice, ...json });
    };

    if (!chatId) {
        answer(400, 'Nothing was rescanned — open a chat first. A rescan reads the chat that is open.');
        return;
    }

    if (count < 1) {
        answer(400, 'Nothing was rescanned — enter how many messages to read, 1 or more.');
        return;
    }

    if (!host.has('readChat')) {
        answer(409, 'Nothing was rescanned — this SillyTavern is too old to read a chat on demand (plugin API 7). Update the fork.');
        return;
    }

    /** @type {ForkRecentMessage[]|null} */
    let turns;
    try {
        turns = await host.readChat(handle, chatId, { last: count });
    } catch (error) {
        const { reason, fix } = describeFailure(error);
        normal().error('[Mnemosyne] rescan: could not read the chat — %s.%s', reason, fix ? ` ${fix}` : '');
        sensitive().error('[Mnemosyne] That read was chat %s for %s: %s', chatId, handle, /** @type {Partial<Error>} */ (error)?.message ?? error);
        answer(500, `Nothing was rescanned — the chat could not be read: ${reason}.`);
        return;
    }

    if (turns === null) {
        normal().warn('[Mnemosyne] rescan: the fork has no chat under the id the panel sent.');
        sensitive().debug('[Mnemosyne] That id was %s for %s.', chatId, handle);
        answer(404, 'Nothing was rescanned — SillyTavern has no chat under this id. Reopen the chat and try again.');
        return;
    }

    // The panel carries no display name, and the extraction prompt wants one. The chat has it: the name on the
    // character's own turns, newest first. It keys nothing — `charName` is a display cache (placement.js).
    const charName = [...turns].reverse().find(t => t.role === 'assistant' && (charId ? t.charId === charId : true))?.name ?? null;

    const summary = await rescanTurns({
        handle,
        identity: { chatId, charId: charId ?? null, personaId: personaId ?? null, charName },
        turns,
        store,
        context: host,
        defaults: asRuntimeDefaults(readSettings(store)).ingest,
    });

    if (summary.busy) {
        answer(409, 'Nothing was rescanned — a memory extraction is running right now. Try again in a moment.');
        return;
    }

    answer(200, describeRescan(summary, count), { summary });
}

/**
 * The rescan's result, in plain words.
 *
 * The result uses user-facing categories rather than internal batching terminology. It names a category only
 * when an item landed there and explains what happened to each memory.
 *
 * @param {import('../ingest/index.js').RescanSummary} summary
 * @param {number} asked How many messages the user asked for — more than the chat holds means "all of it"
 * @returns {string}
 */
export function describeRescan(summary, asked) {
    const { stored, superseded, duplicate, history } = summary.tally;
    /** @param {number} n @param {string} one @param {string} many */
    const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const sentences = [];

    sentences.push(summary.turns < asked
        ? `Read all ${count(summary.turns, 'message', 'messages')} in this chat.`
        : `Read the last ${count(summary.turns, 'message', 'messages')}.`);

    if (summary.readTurns === 0) {
        // Nothing was read, so nothing can be said about what it contained.
        sentences.push('Nothing was saved.');
    } else if (stored + superseded + history + duplicate === 0) {
        sentences.push('Found nothing new worth remembering.');
    } else {
        sentences.push(`Saved ${count(stored, 'new memory', 'new memories')}.`);
        if (duplicate > 0) {
            sentences.push(`Skipped ${count(duplicate, 'memory', 'memories')} you already had.`);
        }
        if (superseded > 0) {
            sentences.push(`Updated ${count(superseded, 'older memory', 'older memories')} with newer information — the old wording is under "Show replaced".`);
        }
        if (history > 0) {
            sentences.push(`Found ${count(history, 'old fact', 'old facts')} that ${history === 1 ? 'has' : 'have'} since changed; `
                + `your current ${history === 1 ? 'memory stays' : 'memories stay'}, and the old `
                + `${history === 1 ? 'one is' : 'ones are'} under "Show replaced".`);
        }
    }

    if (summary.skippedTurns > 0) {
        sentences.push(summary.readTurns === 0
            ? 'The model\'s answer could not be understood — check that a model is loaded, then rescan again.'
            : `The model's answer for ${count(summary.skippedTurns, 'message', 'messages')} could not be understood, so those were skipped — rescan again to retry them.`);
    }

    if (summary.stopped !== null) {
        sentences.push(`It stopped early, after ${count(summary.readTurns, 'message', 'messages')}: ${summary.stopped}.${summary.fix ? ` ${summary.fix}` : ''}`);
    }

    return sentences.join(' ');
}
