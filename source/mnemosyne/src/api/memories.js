import { announceWrites } from '../announce.js';
import { RESET_PHRASE } from '../config.js';
import { normal, sensitive } from '../logging.js';
// ⚠️ THE FORMATTER LIVES WITH THE OTHER PRESENTATION, and this file is now one of its two callers rather than
// its owner. The settings screen prints the same size for a store nobody is erasing (`renderSettings`), and
// two byte formatters would eventually disagree about what 96 KB is called — on the one screen where the
// before number and the after number are read side by side.
import { humanBytes } from '../panel-view.js';
import { TIER_SCENARIO, TIER_USER, embedText } from '../schema.js';
import { dropForHandle } from '../session-state.js';
import { readSettings } from '../settings.js';
import { INDEX_MAX } from '../ingest/extraction.js';

import { renderView, sendFragment } from './panel.js';
import { clampInt, identityOf, stringParam, storeForRequest, wantsFragment } from './request.js';

/**
 * The memory API: the manual write door, and the management surface (FR7).
 *
 * `POST /memory` is a curated memory arriving by hand — the same destination automatic ingest reaches without
 * one, and deliberately the *only* other door into the store. `GET` / `DELETE` are how a human drives and
 * debugs the engine.
 *
 * ⚠️ These are HTTP handlers and they own the HTTP-shaped decisions: status codes, what a malformed body
 * earns, what a missing row means. They own no memory policy. The tier rule below is *enforced* here because
 * this is the boundary an untrusted caller crosses, but what a tier MEANS belongs to `src/schema.js` and
 * nothing in this file decides it.
 */

/**
 * The authenticated caller, as every handler below is entitled to read it — but only after `storeForRequest`
 * has returned a store.
 *
 * 🔴 **THIS IS A PROOF THAT CROSSED A FUNCTION BOUNDARY, NOT A WIDENING.** `types/express.d.ts` declares
 * `user`, `profile` and `handle` all optional on purpose: that optionality is what forces `storeForRequest` to
 * answer 401 rather than guess a user, and it must stay. But `storeForRequest` has *already made* the check by
 * the time any line below runs — a non-null store means a truthy handle was read out of this very object — and
 * TypeScript cannot carry a narrowing out of a function that returns something else. So each handler restates
 * it with `/** @type {VouchedCaller} *\/ (req.user)`, one cast per use, at the site that depends on it.
 *
 * ⚠️ **A cast written ABOVE the `if (!store) return` would be a lie**, and would be the exact bug this plugin
 * cannot afford: reading a handle nobody proved, in the one place a handle decides whose memory is opened.
 * The order of the three lines each handler starts with is load-bearing, not habit.
 *
 * @typedef {{ profile: { handle: string } }} VouchedCaller
 */

/**
 * Normalize a browser's line endings to the ones the store holds.
 *
 * 🔴 **A `<textarea>` SUBMITS CRLF, AND THE "AN EDIT THAT CHANGES NOTHING IS NOT A VERSION" CHECK COMPARED
 * RAW.** HTML says a textarea's value is normalized to CRLF on submission, so any memory whose text or index
 * line contains a newline came back from the panel unequal to the `\n`-separated string that was rendered into
 * it. Open the edit box on a two-line memory, change nothing, press Save: a model call, a new row, the old one
 * retired, and a link in the version chain recording a change that never happened — which is precisely what
 * that check exists to prevent, and which `restoreMemory` then has to walk past.
 *
 * ⚠️ The same defect, in the same shape, as the one `63dfc7f` fixed for the prompt template one file over —
 * `writePromptTemplate` normalizes and this did not. Fixed here rather than in the store because the store is
 * not where the browser is: `reviseMemory` is called by importers and tests too, and `\r\n` is a fact about
 * one transport rather than about memories.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeBreaks(value) {
    return value.replace(/\r\n/g, '\n');
}

/**
 * The one length rule, applied to every door a memory can arrive through.
 *
 * 🔴 `reservesTokens` IS A PROMISE TO THE FORK, AND THE MANUAL DOORS USED TO BREAK IT SILENTLY. `config.js`
 * derives that reservation from "`retrievalK` memories of at most `maxLength` chars each", and until now
 * `maxLength` was enforced only by `passesQuality` — which is on the INGEST path. So the extractor was held to
 * 500 characters while `POST /memory` (the call the README documents) and `PUT /memory/:id` accepted anything
 * at all. One long note pasted into the panel's "+ Add" box overran the reservation by thousands of tokens,
 * and `config.js` spells out the consequence: the backend discards from the front of the prompt, which is
 * exactly where the memory block sits on the text path. Memory silently stops working and nothing reports it.
 *
 * ⚠️ 400 rather than truncation, deliberately. Cutting a user's own words in half without telling them is how
 * you get a memory that asserts something they did not write.
 *
 * 🔴 **THE LIMIT IS THIS USER'S, NOT THE BUILT-IN ONE.** `maxLength` became a setting the moment the panel
 * grew a settings view, and the ingest path reads it per user (`asRuntimeDefaults(readSettings(store))` in
 * `src/index.js`). This gate read `INGEST_DEFAULTS.maxLength` instead — the compiled-in default — so a user
 * who raised the knob got the two halves of one rule disagreeing: the extractor wrote memories at the new
 * size while the panel's "+ Add" box refused them, quoting a number the user had already changed. A knob that
 * governs one door and not the next one along is worse than no knob, because the error message is confident
 * and wrong.
 *
 * @param {import('../store.js').MemoryStore} store This caller's open store — the settings live in it
 * @param {string} text The trimmed candidate text
 * @param {import('express').Response} res Express response — a 400 is sent on rejection
 * @returns {boolean} true if the caller may proceed
 */
function withinMaxLength(store, text, res) {
    const maxLength = readSettings(store).maxLength;

    if (text.length <= maxLength) {
        return true;
    }

    res.status(400).json({
        error: `a memory can be at most ${maxLength} characters; this one is ${text.length}. ` +
            'Split it into separate memories — each one is retrieved on its own merits, so several short ' +
            'memories recall better than one long one.',
    });
    return false;
}

/**
 * The write path, stage one: a curated memory arrives as an HTTP POST, is embedded, and is stored.
 *
 * This is the manual entrance to memory — `POST /api/plugins/mnemosyne/memory` with a JSON `{ text }` (and
 * optional `source`/`metadata`) — and the first thing that puts anything in the store for retrieve() to find.
 * Automatic ingest — turning a conversation into curated memories rather than hand-posted ones — is the larger
 * job that grows behind this same door. 400 if there is no text; 500 if embedding or
 * storage fails.
 *
 * @param {import('express').Request} req Express request — carries the authenticated user and the parsed JSON body
 * @param {import('express').Response} res Express response
 * @param {import('../host/context.js').HostContext} context The fork, as we are allowed to see it
 * @returns {Promise<void>}
 */
export async function writeMemory(req, res, context) {
    const store = storeForRequest(req, res);
    if (!store) return;

    const handle = /** @type {VouchedCaller} */ (req.user).profile.handle;
    const text = normalizeBreaks(stringParam(req, 'text') ?? '').trim();

    if (!text) {
        res.status(400).json({ error: 'a non-empty "text" is required' });
        return;
    }

    if (!withinMaxLength(store, text, res)) return;

    // ⚠️ Optional, and its ABSENCE is the normal case on this route. A memory somebody typed by hand is already
    // short and already about one thing, so it embeds itself perfectly well — `embedText` falls back to the
    // text and that is the right answer, not a degraded one. The field exists here because the panel's editor
    // shows both fields and an importer carrying extracted memories has a line to preserve; neither should have
    // to go through the automatic path to keep it.
    const indexLine = (stringParam(req, 'indexLine') ?? '').trim();

    if (indexLine.length > INDEX_MAX) {
        res.status(400).json({
            error: `an index line can be at most ${INDEX_MAX} characters; this one is ${indexLine.length}. ` +
                'It names what the memory is about so the memory can be found — past that length it stops ' +
                'being an index and starts having the same averaging problem as the memory itself.',
        });
        return;
    }

    // Optional provenance. A string source (e.g. 'chat', 'manual') and an object metadata (tags…) ride along if
    // supplied; anything of the wrong shape is dropped rather than argued with.
    //
    // ⚠️ The cast is `schema.js`'s own contract restated, not a widening: `MemoryMetadata` is a deliberately
    // open bag because this route accepts whatever object a caller sends, and `typeof x === 'object'` plus
    // truthiness is the whole of what can be proved about one. Nothing downstream branches on a key without
    // checking it first, which is the property that makes the open bag safe rather than merely convenient.
    const source = typeof req.body?.source === 'string' ? req.body.source : null;
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object'
        ? /** @type {import('../schema.js').MemoryMetadata} */ (req.body.metadata)
        : null;

    // ⚠️ Optional, and only ever supplied by a caller restoring or importing history — the panel's own "+ Add"
    // does not send one, because a memory a user types now happened now. `addMemory` has always accepted it;
    // this route used to drop it on the floor, which made an import land every memory in the same instant and
    // collapse into one day group.
    //
    // ⚠️ The `??` IS WHAT LETS A JSON NUMBER THROUGH, and that is the case that actually arrives: an importer
    // sends `{"createdAt": 1723459200000}`, which `stringParam` correctly declines because it is not a string,
    // so the fallback reads the raw body value and `parseInt` stringifies it. The `string` cast describes
    // `parseInt`'s declaration rather than this argument — see `clampInt` in request.js for the full note.
    const createdAt = Number.parseInt(/** @type {string} */ (stringParam(req, 'createdAt') ?? req.body?.createdAt), 10);

    // 🔴 `tier` is REQUIRED and has no default, which is the one place this route is deliberately harder to
    // call than it could be. A memory's tier decides which partition it lands in, and a partition nothing
    // retrieves from is a memory that was accepted, stored, and will never be seen again — the silent failure
    // this plugin exists to refuse. Guessing on the caller's behalf cannot be done safely in either direction:
    // `user` promotes a scene into every future conversation, `scenario` buries a durable fact in one chat.
    // So the caller states it. (src/schema.js `scopeKey` refuses the same way, for the same reason.)
    const tier = stringParam(req, 'tier');

    if (tier !== TIER_USER && tier !== TIER_SCENARIO) {
        res.status(400).json({
            error: `"tier" must be "${TIER_USER}" (a durable fact about the user — keyed on charId+personaId, ` +
                `crosses every chat) or "${TIER_SCENARIO}" (something true in one story — keyed on chatId, dies ` +
                'with the chat). There is no default: the wrong guess either leaks a memory across stories or ' +
                'hides it in one.',
        });
        return;
    }

    // The identity axes. Ids, not names — `charName` rides along only as the display cache (src/schema.js), and
    // a caller that sends only a name has named nothing that can be keyed on.
    //
    // ⚠️ The query is consulted as well as the body, because the panel's "+ Add" is an action and its identity
    // arrives the way every panel request's does: appended by the host (fork §6.4). An API caller still sends
    // them in the body and is unaffected — `stringParam` prefers the body when both are present.
    const identity = identityOf(req);
    const charId = stringParam(req, 'charId') ?? identity.charId ?? null;
    const personaId = stringParam(req, 'personaId') ?? identity.personaId ?? null;
    const chatId = stringParam(req, 'chatId') ?? null;
    const charName = stringParam(req, 'charName');

    try {
        // 🔴 THE SAME TEXT POSTED TWICE IS ONE MEMORY, AND THIS IS CHECKED BEFORE THE EMBED.
        //
        // A double-click on the panel's "+ Add" is an ordinary thing for a person to do, and it used to store
        // two byte-identical rows. Both are then live, both match every search, and both consume a slot in the
        // `retrievalK` budget — so a duplicate does not merely clutter the browse list, it displaces a
        // different memory from the prompt. The panel shows them as two rows a user cannot tell apart.
        //
        // ⚠️ **Exact text only, never similarity.** See `MemoryStore.findLiveByText` for the argument; the
        // short version is that ingest is judging a model's paraphrase and this door is judging a person's own
        // words, and silently collapsing two sentences someone typed on purpose is the black-box behavior the
        // memory browser exists to end.
        //
        // ⚠️ Returning the existing row is NOT an error, and the codebase already answers repeat actions this
        // way: `reviseMemory` and `restoreMemory` both return null on a second click at a stale panel because
        // the user's intent was already carried out. A 409 would make the panel report a failure for an action
        // that succeeded the first time and is in the state the user asked for.
        //
        // Before the embed because embedding is the expensive half and a duplicate has nothing to embed. It
        // also means this path works on a backend with no model at all, which the manual door otherwise needs.
        const existing = store.findLiveByText(text, { tier, charId, personaId, chatId });

        if (existing) {
            normal().info('[Mnemosyne] Manual write matched existing memory %d exactly — not stored twice.', existing.id);
            sensitive().debug('[Mnemosyne] That duplicate was for %s, character %s.', handle, JSON.stringify(charName ?? ''));

            // No `announceWrites`: nothing was written, and lighting the "remembered something" icon for a
            // no-op is the panel telling the user a thing that did not happen.
            if (wantsFragment(req)) {
                sendFragment(res, renderView(store, req, handle));
                return;
            }

            res.status(200).json({ id: existing.id, duplicate: true });
            return;
        }

        // 🔴 Model and its dimension come from embed at runtime, never a constant (§5.4) — the same contract
        // retrieve() keeps. An array in, {vectors, model} out, the table keyed on the model that actually ran.
        const { vectors, model } = await context.embed([embedText({ indexLine, text })]);

        if (!model || !vectors.length) {
            res.status(500).json({ error: 'the embedding model returned nothing' });
            return;
        }

        const id = store.remember({
            text, indexLine, vector: vectors[0], model, source, metadata, tier, charId, personaId, chatId, charName,
            ...(Number.isInteger(createdAt) && createdAt > 0 ? { createdAt } : {}),
        });
        // Shape, never the text — the same rule the automatic path follows; see logInjection's note. `tier` is
        // one of two constants and the row id names a memory without quoting it, so the operator half is real.
        normal().info('[Mnemosyne] Stored memory %d — manual, tier %s, model %s.', id, tier, model);
        sensitive().debug('[Mnemosyne] That memory was for %s, character %s.', handle, JSON.stringify(charName ?? ''));
        // The manual door into memory lights the same icon as the automatic one — through the same function,
        // now, so it cannot drift from it. A user who posts a memory by hand and sees nothing happen has no way
        // to tell it landed, which was the same blindness ingest had, arriving through a different door.
        // `replaced: null`: no supersession on this path, because the manual route stores what it is given.
        announceWrites(context, { handle, chatId, items: [{ text, replaced: null }] });

        if (wantsFragment(req)) {
            sendFragment(res, renderView(store, req, handle));
            return;
        }

        res.status(201).json({ id, model });
    } catch (error) {
        normal().error('[Mnemosyne] Failed to store a memory on the manual write path. Details suppressed.');
        // ⚠️ `{ message?: string }` RATHER THAN `Error`, IN EVERY CATCH IN THIS FILE. A `catch` binding is
        // `unknown` because JavaScript can throw anything, and the fork's own code has been observed rejecting
        // with a plain object (see the note in tools/deploy-gates/gate-memory-browser.mjs). Claiming `Error`
        // here would type `.message` as a string that is always there; claiming an optional one says what is
        // actually true — the detail may be missing, and `%s` will then print "undefined", which is a fault
        // report worth recognizing rather than one worth asserting away.
        sensitive().error('[Mnemosyne] That failure was for %s: %s', handle, /** @type {{ message?: string }} */ (error).message);
        res.status(500).json({ error: 'could not store the memory' });
    }
}

/**
 * The read path for management (FR7): `GET /api/plugins/mnemosyne/memory` lists the caller's memories, newest
 * first. `?limit=` (1–500, default 50) and `?offset=` page through them. This is "view your memories", not the
 * retrieval that feeds a prompt — that is retrieve(), and it runs itself.
 *
 * `?scope=` narrows to one partition and may be repeated to ask for several; omitting it lists the whole
 * store. Note this is the OPPOSITE default to retrieval, and deliberately so: retrieval feeds a prompt and
 * must not cross characters or personas, whereas this is the user looking at their own memories and "show me
 * everything I have" is the useful answer.
 *
 * The values are the composed partition keys from `scopeKey` (`u:<charId>:<personaId>`, `s:<chatId>`), which
 * is a raw shape for a query string — but this route drives and debugs the engine, and
 * a partition is exactly the thing worth asking about when a memory has gone missing. Every row carries its
 * own `scope` back, so the values do not have to be constructed blind.
 *
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response
 * @returns {void}
 */
export function readMemories(req, res) {
    const store = storeForRequest(req, res);
    if (!store) return;

    const limit = clampInt(req.query?.limit, 50, 1, 500);
    const offset = clampInt(req.query?.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // Express gives a string for one `?scope=`, an array for several, and undefined for none. Normalize to the
    // array MemoryStore.listMemories wants, or null for "the whole store".
    const raw = req.query?.scope;
    const scopes = raw === undefined ? null : [raw].flat().filter(s => typeof s === 'string');

    // `?includeRetired=1` adds the superseded rows — the version history the store has always kept and this
    // route has never exposed. Off by default, because a listing that mixes a corrected fact with the fact it
    // corrected, unmarked, is worse than one that shows only what is current. `retired` and `supersededBy`
    // ride along on every row so a caller can tell which is which.
    const includeRetired = req.query?.includeRetired === '1' || req.query?.includeRetired === 'true';

    res.status(200).json({ memories: store.listMemories({ limit, offset, includeRetired, scopes }) });
}

/**
 * Delete one memory (FR7): `DELETE /api/plugins/mnemosyne/memory/:id`. The id addresses the caller's own store
 * and nobody else's (see storeForRequest), so a wrong id is simply a 404 — never a reach into another user.
 * 400 if the id is not a positive integer; 204 on success.
 *
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response
 * @returns {void}
 */
export function removeMemory(req, res) {
    const store = storeForRequest(req, res);
    if (!store) return;

    const id = memoryId(req, res);
    if (id === null) return;

    if (!store.deleteMemory(id)) {
        res.status(404).json({ error: 'no such memory' });
        return;
    }

    normal().info('[Mnemosyne] Deleted memory %d.', id);
    sensitive().debug('[Mnemosyne] That deletion was for %s.', /** @type {VouchedCaller} */ (req.user).profile.handle);

    if (wantsFragment(req)) {
        sendFragment(res, renderView(store, req, /** @type {VouchedCaller} */ (req.user).profile.handle, { removed: true }));
        return;
    }

    res.status(204).end();
}

/**
 * Edit a memory: `PUT /api/plugins/mnemosyne/memory/:id` with a new `text`.
 *
 * 🔴 **VERSIONED, NOT IN PLACE.** The old wording is retired behind the new one rather than overwritten — see
 * `MemoryStore.reviseMemory`, which carries the argument. The practical consequence for a caller is that the
 * id in the URL is *not* the id that comes back: this creates a memory and returns the new one.
 *
 * ⚠️ **This does not announce.** The manual write path lights the notification icon because a new memory is
 * something the engine learned; a correction the user typed themselves is something they already know, and an
 * icon that lit for it would be claiming work on the user's own behalf. Deliberate, not an omission.
 *
 * 400 if there is no text; 404 if no LIVE memory has that id — already retired, already deleted, or never
 * there, all of which are the same answer to "change this": there is nothing here to change.
 *
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response
 * @param {import('../host/context.js').HostContext} context The fork, as we are allowed to see it
 * @returns {Promise<void>}
 */
export async function editMemory(req, res, context) {
    const store = storeForRequest(req, res);
    if (!store) return;

    const handle = /** @type {VouchedCaller} */ (req.user).profile.handle;
    const id = memoryId(req, res);
    if (id === null) return;

    const text = normalizeBreaks(stringParam(req, 'text') ?? '').trim();

    if (!text) {
        res.status(400).json({ error: 'a memory needs some text — to remove it entirely, delete it instead' });
        return;
    }

    if (!withinMaxLength(store, text, res)) return;

    // 🔴 ABSENT MEANS KEEP, NOT CLEAR — and the two are told apart by `undefined`, never by emptiness.
    //
    // A caller that predates v5 sends `{ text }` and means "fix this wording", not "throw away the line that
    // makes this memory findable". A panel editor that shows both fields sends both, and an emptied box really
    // does mean clear it. Collapsing those into one `?? ''` would make every old client silently un-index every
    // memory it touched, and nothing would report it: the row still reads correctly in the browse list and
    // simply stops being retrieved.
    // 🔴 **NOT `stringParam`, AND THAT IS THE WHOLE OF THIS BUG.** `stringParam` returns a value only when
    // `value.length > 0`, so it maps an EMPTY string to `null` — which is the right rule for `text`, where empty
    // means "no text supplied", and exactly the wrong one here, where the distinction this block is built on is
    // between an ABSENT field and an EMPTY one. The panel's edit form always submits `indexLine`, so clearing
    // the box submits `indexLine=''`, which arrived as `null` and took the "absent means keep it" branch: the
    // old line was inherited, `indexUnchanged` came out true, and the route answered `unchanged: true` having
    // written nothing. Emptying the box did nothing, for ever, and the comment above asserted the opposite.
    //
    // `store.reviseMemory({ indexLine: '' })` clears correctly and is pinned by `tests/store.test.js` — the
    // store was always right, which is why the suite stayed green while the door in front of it was shut.
    const suppliedIndexLine = /** @type {Record<string, unknown>|undefined} */ (req.body)?.indexLine
        ?? /** @type {Record<string, unknown>|undefined} */ (req.query)?.indexLine;
    const rawIndexLine = typeof suppliedIndexLine === 'string' ? suppliedIndexLine : null;
    const indexLine = rawIndexLine === null ? null : normalizeBreaks(rawIndexLine).trim();

    if (indexLine !== null && indexLine.length > INDEX_MAX) {
        res.status(400).json({
            error: `an index line can be at most ${INDEX_MAX} characters; this one is ${indexLine.length}.`,
        });
        return;
    }

    try {
        // 🔴 AN EDIT THAT CHANGES NOTHING IS NOT A VERSION. Opening the edit box, changing your mind, and
        // pressing Save is an ordinary thing to do, and it used to cost a model call and then write a new row
        // with byte-identical text, retiring the old one behind it. That is worse than the duplicate `POST`
        // creates: it puts a link in the version chain recording a change that never happened, so the panel's
        // history expander offers the user two identical texts to choose between and `restoreMemory` has a
        // meaningless step to walk. The chain is the record of how a memory's wording actually moved.
        //
        // ⚠️ Byte-identical only, and against the LIVE row, for the same reasons the POST path checks that way
        // (see `MemoryStore.findLiveByText`). A retired or missing id falls through to `reviseMemory`, which
        // returns null and earns the 404 below — the answer to "change this" when there is nothing here.
        const current = store.getMemory(id);

        // ⚠️ BOTH fields, because either one changing is a real edit. Comparing only the text would swallow an
        // edit that rewrote the index line alone — the field the user changes precisely BECAUSE the memory is
        // not being found — and answer `unchanged: true` to a request that changed something.
        const indexUnchanged = indexLine === null || (current !== null && current.indexLine === indexLine);

        if (current && current.retired === 0 && current.text === text && indexUnchanged) {
            normal().info('[Mnemosyne] Edit of memory %d changed nothing — no version written.', id);

            if (wantsFragment(req)) {
                sendFragment(res, renderView(store, req, handle, { rowId: id }));
                return;
            }

            // `replaced: null` because nothing was: the id in the URL is still the live memory, which is the
            // one difference a caller has to be able to see against the versioned path's response.
            res.status(200).json({ id, replaced: null, unchanged: true });
            return;
        }

        // 🔴 Embedded with whatever model is running NOW, and the model that ran is what keys the vector's
        // table — the same contract every other write path keeps (§5.4). Never a constant.
        // ⚠️ The vector must come from what WILL be stored, so the fallback is resolved against the line the
        // revision is about to carry — the supplied one, or the one being inherited — never against the text
        // alone. `reviseMemory` inherits on null and this must make the same choice, or an edit would file its
        // vector under different coordinates than the memory it belongs to.
        const keptIndexLine = indexLine === null ? (current?.indexLine ?? '') : indexLine;
        const { vectors, model } = await context.embed([embedText({ indexLine: keptIndexLine, text })]);

        if (!model || !vectors.length) {
            res.status(500).json({ error: 'the embedding model returned nothing' });
            return;
        }

        const newId = store.reviseMemory({ memoryId: id, text, indexLine, vector: vectors[0], model, source: 'edit' });

        if (newId === null) {
            res.status(404).json({ error: 'no such memory, or it has already been replaced' });
            return;
        }

        normal().info('[Mnemosyne] Edited memory %d — stored as %d, model %s.', id, newId, model);
        sensitive().debug('[Mnemosyne] That edit was for %s.', handle);

        if (wantsFragment(req)) {
            sendFragment(res, renderView(store, req, handle, { rowId: newId }));
            return;
        }

        res.status(200).json({ id: newId, replaced: id, model });
    } catch (error) {
        normal().error('[Mnemosyne] Failed to edit a memory. Details suppressed.');
        sensitive().error('[Mnemosyne] That failure was for %s: %s', handle, /** @type {{ message?: string }} */ (error).message);
        res.status(500).json({ error: 'could not edit the memory' });
    }
}

/**
 * Bring back a superseded memory: `POST /api/plugins/mnemosyne/memory/:id/restore`.
 *
 * The undo for both kinds of supersession, because `reviseMemory` deliberately made them one chain: a
 * similarity guess ingest got wrong, and an edit the user regrets, are restored by the same call.
 *
 * No embedding is involved — the memory and its vectors were never deleted, only flagged. That is the whole
 * reason retirement exists rather than deletion (`MemoryStore.retireMemory`).
 *
 * 404 if no RETIRED memory has that id, which includes "it is already live" — a second click on a stale panel,
 * whose intent has already been carried out.
 *
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response
 * @returns {void}
 */
export function restoreMemory(req, res) {
    const store = storeForRequest(req, res);
    if (!store) return;

    const handle = /** @type {VouchedCaller} */ (req.user).profile.handle;
    const id = memoryId(req, res);
    if (id === null) return;

    const restored = store.restoreMemory(id);

    if (!restored) {
        res.status(404).json({ error: 'no such memory, or it is already the current one' });
        return;
    }

    normal().info('[Mnemosyne] Restored memory %d%s.', id,
        restored.retiredId === null ? '' : ` — memory ${restored.retiredId} stood down for it`);
    sensitive().debug('[Mnemosyne] That restore was for %s.', handle);

    if (wantsFragment(req)) {
        sendFragment(res, renderView(store, req, handle, { rowId: id }));
        return;
    }

    res.status(200).json(restored);
}

/**
 * Re-embed a batch of memories that have no vector for the running model: `POST /memory/reembed`.
 *
 * ## 🔴 The repair for a model change, and why it is triggered rather than scheduled
 *
 * When the embedding model changes, existing memories keep their text but lose findability until they are
 * re-embedded. `MemoryStore.unembedded` exposes this work list for an explicit repair operation.
 *
 * It is a **trigger, not a timer**, and that is a decision rather than laziness. Every write path goes
 * through `remember` or `reviseMemory`, both of which store the text and its vector in one transaction, so
 * a memory cannot exist without a vector for the model that wrote it. The work list is therefore *always*
 * empty except after a model change — a deliberate, rare, human act. A periodic scan would be a query
 * returning zero rows for ever. `retrieve`'s `warnIfUnembedded` is what tells somebody to press the button.
 *
 * ## ⚠️ A batch per call, and the caller loops
 *
 * Embedding costs seconds per memory (~6s on the host). A route that walked the whole list would hold an HTTP
 * request open for hours on a large store and compete with the user's own generations for the whole time.
 * So one bounded batch per call, with `remaining` in the response, and the caller repeats until it is 0.
 * That also makes the repair interruptible: stop at any point and the memories already done stay done.
 *
 * ⚠️ **Nothing is destroyed and nothing is overwritten.** `addVector` adds this model's vector; the old
 * model's table is untouched and stays searchable if the model is ever changed back. The memory text — the
 * durable truth — is never rewritten, only read.
 *
 * ⚠️ It repairs the CALLER'S OWN store and no one else's (`storeForRequest`), so it needs no admin right and
 * cannot reach another user's memories.
 *
 * @param {import('express').Request} req Express request — optional `{ batch }`, clamped
 * @param {import('express').Response} res Express response
 * @param {import('../host/context.js').HostContext} context The fork, as we are allowed to see it
 * @returns {Promise<void>}
 */
export async function reembedMemories(req, res, context) {
    const store = storeForRequest(req, res);
    if (!store) return;

    const handle = /** @type {VouchedCaller} */ (req.user).profile.handle;
    const batch = clampInt(req.body?.batch, 25, 1, 200);

    try {
        // 🔴 The model comes from a live embed, never a constant or a stored name — the same contract every
        // other path keeps. Embedding one short probe is also the cheapest way to learn which model is
        // running, and it is what decides which table the repair is filling.
        const probe = await context.embed(['model probe']);

        if (!probe.model || !probe.vectors.length) {
            res.status(500).json({ error: 'the embedding model returned nothing' });
            return;
        }

        const registered = store.registerModel(probe.model, probe.vectors[0].length);
        const pending = store.unembedded(registered.id, batch);

        if (pending.length === 0) {
            res.status(200).json({ model: probe.model, embedded: 0, remaining: 0, done: true });
            return;
        }

        // One embed call for the batch — `context.embed` takes an array precisely so a re-embed is one model
        // load and many vectors rather than the reverse.
        // ⚠️ `embedText`, not `row.text`: a repair that embedded the paragraph while the original write embedded
        // the index line would put the same memory at two different points depending on which path last touched
        // it. See schema.js — there is one rule and every site calls it.
        const { vectors, model } = await context.embed(pending.map(row => embedText(row)));

        if (!model || vectors.length !== pending.length) {
            res.status(500).json({ error: 'the embedding model returned the wrong number of vectors' });
            return;
        }

        // ⚠️ If the model reported here differs from the probe's, the pipeline changed underneath this
        // request. Filing these vectors under the probe's table would mix two models' coordinates in one
        // space, which is the one thing `registerModel` exists to make impossible. Refuse instead.
        if (model !== probe.model) {
            res.status(500).json({
                error: `the embedding model changed mid-repair (${probe.model} → ${model}); nothing was written`,
            });
            return;
        }

        pending.forEach((row, index) => store.addVector(registered.id, row.id, vectors[index]));

        const remaining = store.countUnembedded(registered.id);

        // Counts and a model name: no memory text, and the ids name rows without quoting them.
        normal().info(
            '[Mnemosyne] Re-embedded %d memories for %s; %d remaining.', pending.length, model, remaining,
        );
        sensitive().debug('[Mnemosyne] That repair was for %s.', handle);

        res.status(200).json({ model, embedded: pending.length, remaining, done: remaining === 0 });
    } catch (error) {
        normal().error('[Mnemosyne] A re-embed batch failed. Details suppressed.');
        sensitive().error('[Mnemosyne] That failure was for %s: %s', handle, /** @type {{ message?: string }} */ (error).message);
        res.status(500).json({ error: 'could not re-embed' });
    }
}

/**
 * Erase every memory this user has, and keep everything that is not a memory: `POST /memory/reset`.
 *
 * ## 🔴 Why another user cannot reach this, structurally rather than by a check
 *
 * There is **no user parameter anywhere in this route** — not in the path, not in the body, not in the query.
 * The store comes from `storeForRequest`, which reads `req.user.profile.handle` and nothing else, so the only
 * store this handler can name is the caller's own. A malicious logged-in user has no field in which to name a
 * victim, which is a stronger property than validating one: there is nothing to validate.
 *
 * Underneath that sits the key. Another user's `store.db` is encrypted under a subkey derived from *their*
 * vault, which this process holds only while they are themselves unlocked, and `stores` is keyed by handle —
 * so even a bug that produced the wrong handle would also need an open vault for that account.
 *
 * ## 🔴 The typed phrase is checked HERE, not only in the dialog
 *
 * The panel collects it, but a confirmation that lives only in the client is a confirmation any other client
 * skips — and this route is reachable by anything holding the caller's session. So the phrase is a
 * *precondition of the operation*, not a UI courtesy: no `confirm`, no reset, 400. That is also what makes the
 * route safe to expose at all, and it is why POST rather than GET, which a link or an `<img>` could fire.
 *
 * ⚠️ **The per-user session records go with the memories.** `lastRecall` holds the ids that were injected into
 * the last reply, and after this they name rows that do not exist — the panel would render "💡 Just recalled"
 * for memories the user just erased. `dropForHandle` clears every registered per-user map and bumps the lock
 * epoch, so an in-flight generation cannot write one back afterward either.
 *
 * @param {import('express').Request} req Express request — requires `confirm` to be {@link RESET_PHRASE}
 * @param {import('express').Response} res Express response
 * @returns {void}
 */
export function resetMemories(req, res) {
    const store = storeForRequest(req, res);
    if (!store) return;

    const handle = /** @type {VouchedCaller} */ (req.user).profile.handle;
    // Trim surrounding whitespace and fold case, but preserve internal spacing and require an exact phrase.
    const typed = (stringParam(req, 'confirm') ?? '').trim().toLowerCase();

    if (typed !== RESET_PHRASE) {
        // 🔴 The refusal is not an error state to be logged as a fault: an empty box is what happens when
        // somebody opens the confirmation and thinks better of it, which is the control working.
        if (wantsFragment(req)) {
            sendFragment(res, renderView(store, req, handle, {
                notice: typed === ''
                    ? `Nothing was deleted. Type ${RESET_PHRASE} in the box to confirm.`
                    : `Nothing was deleted — that did not match. Type ${RESET_PHRASE} exactly.`,
            }));
            return;
        }

        res.status(400).json({ error: `reset requires confirm: '${RESET_PHRASE}'` });
        return;
    }

    const { memories, bytesBefore, bytesAfter } = store.clearMemories();

    // 🔒 Counts and sizes only — never a memory, never a chat id. The same rule every line in this plugin's
    // log follows, and it is load-bearing here: the log is plaintext on disk and this event is the one that
    // most invites writing down what was destroyed.
    normal().warn('[Mnemosyne] MEMORY RESET: %d memories erased at a user\'s request. %s → %s.',
        memories, humanBytes(bytesBefore), humanBytes(bytesAfter));
    sensitive().debug('[Mnemosyne] That reset was for %s.', handle);

    dropForHandle(handle);

    if (wantsFragment(req)) {
        sendFragment(res, renderView(store, req, handle, {
            notice: memories === 0
                ? 'There were no memories to erase. Your settings are untouched.'
                : `Erased ${memories} ${memories === 1 ? 'memory' : 'memories'} — ${humanBytes(bytesBefore)} → ${humanBytes(bytesAfter)}. Your settings, presets and prompt are untouched.`,
        }));
        return;
    }

    res.status(200).json({ memories, bytesBefore, bytesAfter });
}

/**
 * The memory id from the URL, or null after this function has already sent a 400.
 *
 * ⚠️ The id addresses the caller's own store and nobody else's (see `storeForRequest`), which is what makes it
 * safe to accept from a URL at all — so a wrong one is a 404 rather than a reach into another user.
 *
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response
 * @returns {number|null}
 */
function memoryId(req, res) {
    const id = Number(req.params?.id);

    if (!Number.isInteger(id) || id < 1) {
        res.status(400).json({ error: 'memory id must be a positive integer' });
        return null;
    }

    return id;
}
