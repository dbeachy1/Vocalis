import { MEMORY_DEFAULTS } from '../config.js';
import { DEFAULT_EXTRACTION_TEMPLATE, TEMPLATE_PLACEHOLDERS } from '../ingest/extraction.js';
import { readPresets, readPromptTemplate, readSettings } from '../settings.js';
import {
    PAGE_SIZE, dayKey, renderAlert, renderBrowser, renderCalendar, renderError, renderHeader, renderList,
    renderLockedPanel, renderLog, renderPager, renderPanel, renderPrompt, renderRecalled, renderRegions,
    renderRow, renderSettings, renderToolbar,
} from '../panel-view.js';
import { PANEL_CSS } from '../panel-css.js';
import { TIER_SCENARIO, TIER_USER, scopeKey } from '../schema.js';
import { getGate, getIngest, getOutcome, getRecall, getRecalls } from '../session-state.js';
import { readTape } from '../log-tape.js';
import { storeFor } from '../session.js';

import { chatIdOf, clampInt, identityOf } from './request.js';

/**
 * The routes behind the memory button (capability 7, extended by the fork's interactive-panel protocol): the
 * fragment, the status light, and every partial re-render an action asks for.
 *
 * 🔴 NEITHER PANEL ROUTE GOES THROUGH `storeForRequest`, and that is the whole design of this file. Its
 * 409-on-lock is right for a route that answers with content and wrong for these: the fork's client turns any
 * non-OK status into "This panel could not be loaded", so a locked vault would be reported to the user as
 * BROKEN memory rather than as locked memory. Both read the authenticated handle directly and answer 200
 * either way — the panel with a fragment that names nothing, the status with an unlit icon.
 *
 * What this module decides is *what the user is looking at*; how it reads is `src/panel-view.js`, which holds
 * no state, performs no I/O, and makes no decisions.
 *
 * ## 🔴 Every render is a pure function of the request
 *
 * There is no per-user UI state between requests and there must never be one (fork panel design §4). Page,
 * scope, the replaced toggle, which row has its edit box open — all of it arrives in the query string and
 * leaves in the `data-panel-params` of the next action. That is what makes a stale click harmless: there is
 * no cache to invalidate, no half-updated view, and no race between two clicks. A buggy fragment renders
 * wrong once and the next interaction fixes it.
 *
 * ## The shapes
 *
 * 🔴 **DECLARED IN `panel-view.js`, AND ONLY THERE.** This module builds every record below and that one reads
 * every field of them, so the renderer is where they are written down — see the block under `PAGE_SIZE` there
 * for the argument. The aliases here exist so a signature in this file reads as one line rather than as a
 * `import(…)` expression repeated twenty times; they add no shape of their own, and none of them may grow one.
 */

/** @typedef {import('../panel-view.js').BrowseSpec} BrowseSpec */
/** @typedef {import('../panel-view.js').GateRecord} GateRecord */
/** @typedef {import('../panel-view.js').IngestRecord} IngestRecord */
/** @typedef {import('../panel-view.js').PanelIdentity} PanelIdentity */
/** @typedef {import('../panel-view.js').PanelViewName} PanelViewName */
/** @typedef {import('../panel-view.js').RecallRecord} RecallRecord */
/** @typedef {import('../panel-view.js').ViewState} ViewState */
/** @typedef {import('../schema.js').MemoryRow} MemoryRow */
/** @typedef {import('../store.js').MemoryStore} MemoryStore */

/**
 * A record, but only if it belongs to the conversation being looked at.
 *
 * 🔴 THE PER-CHAT GATE (fork §14.4). Both records are per-user, one deep, and the user switches chats — so
 * without this the panel happily shows what was recalled in the chat they left, described as though it happened
 * here. The fork appends `?chatId=<current>` to both routes for exactly this comparison.
 *
 * ⚠️ Mismatch is the only thing that hides a record. An absent `chatId` on either side means the correlation
 * cannot be made — an older fork that sends none, or a generation that carried none — and hiding on *unknown*
 * would silently blank the panel on those installs, trading a staleness bug for a total one.
 *
 * ⚠️ **GENERIC BECAUSE IT MUST HAND BACK EXACTLY WHAT IT WAS GIVEN.** Three different records go through here
 * — recall, write and gate — and each caller needs its own record's fields on the way out. Declaring the
 * parameter as the union of the three would return that union to every caller, so `panelState` would hand the
 * header a "recall" that might be a gate decision. The constraint is the one field this function reads.
 *
 * @template {{ chatId?: string|null }} T
 * @param {T|undefined} rec A recall, write or gate record (src/session-state.js)
 * @param {string|null} chatId The chat the panel is being viewed from
 * @param {{ requireChatId?: boolean }} [opts] Whether a record carrying no `chatId` is refused — see below
 * @returns {T|undefined} the record, or undefined if it is about a different conversation
 */
export function forThisChat(rec, chatId, { requireChatId = false } = {}) {
    if (rec?.chatId && chatId && rec.chatId !== chatId) {
        return undefined;
    }

    // 🔴 A WRITE RECORD WITH NO `chatId` CANNOT BE CORRELATED, SO IT MUST NOT LIGHT EVERY CHAT.
    //
    // The test above only hides a record on a MISMATCH, so a record whose `chatId` is null passed everywhere.
    // `POST /api/plugins/mnemosyne/memory {"text": "…", "tier": "user"}` — the exact call the README documents
    // — carries no chatId, so `announceWrites` stores null: open any unrelated conversation and `GET /status`
    // reported `active: true`, lighting the memory icon as though something had just been remembered there.
    //
    // Only the WRITE channel opts in. A recall record is rewritten on every reply (retrieve() always calls
    // noteInjection, declines included; a background request writes none, as of 1.8.0) so an uncorrelatable
    // one is about the last reply by construction; a write record persists until the next write, which is
    // what makes a stale one misleading.
    if (requireChatId && rec && !rec.chatId) {
        return undefined;
    }

    return rec;
}

/**
 * The two records the panel and the status light are built from, filtered to what actually happened on the turn
 * being looked at.
 *
 * 🔴 THE RECENCY GATE IS NOT SYMMETRIC, AND IT HAS TO BE HERE. A recall record is rewritten on EVERY REPLY
 * — every path through retrieve() calls noteInjection, declines included — so it is always about the last one.
 * (A background request is not a reply and writes nothing, as of 1.8.0; it cannot make either record stale.)
 * A write record is only written when something was actually stored, so it survives untouched across every later
 * turn that stored nothing. Without this, a memory written at 10:00 is still announced as "remembered from this
 * conversation" at 10:30, on a turn that remembered nothing: the icon claiming work it did not just do, which is
 * the one thing this panel must never do. Comparing the two timestamps is enough — if a recall is newer than the
 * write, the write belongs to an earlier turn.
 *
 * @param {string} handle The authenticated caller
 * @param {string|null} chatId The chat the panel is being viewed from
 * @returns {{ recall: RecallRecord|undefined, ingest: IngestRecord|undefined }}
 */
export function panelState(handle, chatId) {
    const recall = forThisChat(getRecall(handle), chatId);
    const written = forThisChat(getIngest(handle), chatId, { requireChatId: true });
    const ingest = written && (!recall || written.at >= recall.at) ? written : undefined;

    return { recall, ingest };
}

/**
 * Everything the browse view needs, read from the request and settled once.
 *
 * ⚠️ Every value fails closed. `view` falls back to browse rather than to an unknown branch, ids that are not
 * positive integers become null rather than NaN, and an absent identity axis narrows what the toolbar offers
 * rather than widening what the list shows.
 *
 * ⚠️ `forceView` exists for ONE caller — `readSettingsFragment`, whose route IS the view and therefore cannot
 * carry it in the query. It is a literal from this module, never anything a request said, so it skips the
 * allow-list below rather than laundering a client value past it.
 *
 * @param {import('express').Request} req Express request
 * @param {{ forceView?: PanelViewName|null }} [opts] A view the ROUTE has already decided
 * @returns {ViewState} the view state, plus the identity it was resolved against
 */
export function viewState(req, { forceView = null } = {}) {
    const identity = identityOf(req);

    // 🔴 **BODY FIRST, THEN QUERY — AND READING THE QUERY ALONE BROKE EVERY POST AND PUT THE PANEL MAKES.**
    // The fork puts an action's `data-panel-params` (and its collected form) into the QUERY for GET and DELETE
    // and into the BODY for POST and PUT — `plugin-panels.js`: `const hasBody = method === 'POST' || method ===
    // 'PUT'` … `if (!hasBody) { …append to query… }` … `body: supplied.toString()`. This function read
    // `req.query` for all of it, so on a PUT the query held only the ambient axes and every field below fell to
    // its default: `view` to `browse`, `regions` to `[]`.
    //
    // What that looked like: press **Save settings** and the settings screen is replaced, in place, by the whole
    // memory browser. The values were saved; the screen jumped. Same for Save as preset and Load preset — and
    // NOT for Delete preset, because DELETE carries no body, which is exactly the asymmetry that gives it away.
    // The memory routes lost `offset`, `scope`, `edit` and `expand` the same way, so every add or edit silently
    // returned the user to page 1 of "Everything". `api/request.js`'s `stringParam` already reads body-then-
    // query for precisely this reason; this function never got the same treatment.
    //
    // ⚠️ **THE AMBIENT AXES ARE DELIBERATELY NOT MERGED.** `chatId`, `personaId`, `charId` and `tz` are the
    // fork's `RESERVED_QUERY_KEYS`: it strips them from `supplied` and re-adds them to the query on every
    // method, so they are host-supplied context rather than anything the fragment said. `identityOf(req)` and
    // `tz` below therefore keep reading `req.query` alone — merging them would let a fragment's own markup
    // nominate the identity a request is resolved against, which is the one thing here that must stay the
    // host's to say.
    /** @param {string} name @returns {unknown} */
    const p = (name) => {
        const supplied = /** @type {Record<string, unknown>|undefined} */ (req.body)?.[name];
        return supplied === undefined ? req.query?.[name] : supplied;
    };
    // ⚠️ **THE `string` CASTS BELOW DESCRIBE `parseInt`, NOT THE ARGUMENT** — the same reading `clampInt` is
    // written against, and for the same reason. `req.query` values are `unknown` because Express yields a
    // string, an array of strings or a nested object depending on what the client sent, and `parseInt`'s
    // first specified step is `ToString(argument)`; `lib.es5.d.ts` narrows the parameter to `string` because
    // that is the only case worth writing down, not because the rest are illegal. `?edit[]=5&edit[]=9`
    // stringifies to `5,9` and parses to 5, and `?edit=%7B%7D` to `[object Object]` and NaN — both land on
    // the guard below, which is what actually decides the answer.
    /** @param {string} name */
    const id = (name) => {
        const n = Number.parseInt(/** @type {string} */ (p(name)), 10);
        return Number.isInteger(n) && n > 0 ? n : null;
    };

    // ⚠️ A slot is a POSITION, so 0 is a legitimate value — the first row on the page. Parsed separately from
    // the entity ids above, whose 0 would mean "no such memory".
    const slotIndex = Number.parseInt(/** @type {string} */ (p('slot')), 10);
    const requested = p('scope');
    const scopes = availableScopes(identity);
    // A scope the host gave us no identity for degrades to "everything" rather than to an empty list. A wider
    // answer than asked for is recoverable by clicking a narrower button; showing nothing would read as memory
    // loss. "Wider" is bounded by `scopesFor` — the union of this identity's own partitions, not the store.
    const scope = typeof requested === 'string' && scopes.has(requested) ? requested : 'all';

    // ⚠️ A named allow-list, not a pass-through. `view` reaches `renderView`'s branch table, and an unknown
    // value has to land on `browse` rather than on nothing — the same fail-closed rule every field here follows.
    const named = ['calendar', 'prompt', 'log', 'settings'];

    // Read once each: both are tested and then used, and `p` is a function call rather than a property access.
    const month = p('month');
    const regions = p('regions');

    return {
        // ⚠️ **THREE CASTS, AND ALL THREE ARE THE `includes` TEST WRITTEN DOWN.** It compares by SameValueZero,
        // so an array or a nested object is unequal to every name in the list and takes the `browse` branch —
        // casting the argument to `string` describes the comparison rather than promising the value is one. A
        // TRUE result proves two further things TypeScript cannot carry out of `Array.prototype.includes`: the
        // value is one of the two names, and `req.query` was present at all (`types/express.d.ts` declares it
        // optional because a request may carry none — and on such a request `includes(undefined)` is false, so
        // this branch never runs). The inner cast is needed because the member access is checked first.
        view: forceView ?? (named.includes(/** @type {string} */ (p('view')))
            ? /** @type {PanelViewName} */ (p('view'))
            : 'browse'),
        offset: clampInt(p('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
        scope,
        replaced: p('replaced') === '1',
        recalled: p('recalled') === '1',
        edit: id('edit'),
        expand: id('expand'),
        add: p('add') === '1',
        // Whether the settings screen's reset confirmation is open. Read the same way as every other flag —
        // and like them it only decides what is DRAWN. What authorizes the reset is the phrase typed into the
        // box, checked by `resetMemories` against the store, never here.
        danger: p('danger') === '1',
        slot: Number.isInteger(slotIndex) && slotIndex >= 0 ? slotIndex : null,
        // How far back through the recall history the prompt view is looking. 0 is the most recent turn, and
        // an out-of-range value is clamped where the history's length is known rather than guessed at here.
        turn: clampInt(p('turn'), 0, 0, Number.MAX_SAFE_INTEGER),
        month: typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) ? month : null,
        regions: typeof regions === 'string' ? regions.split(',').filter(Boolean) : [],
        // ⚠️ `tz` stays on the QUERY — it is one of the fork's `RESERVED_QUERY_KEYS`, stripped from the body on
        // every method and re-added to the query by the host. See the note on `p` above.
        tz: typeof req.query?.tz === 'string' && req.query.tz ? req.query.tz : 'UTC',
        identity,
        scopesAvailable: scopes,
    };
}

/**
 * Which of the three scope buttons this request has the identity to support.
 *
 * `all` always; `story` when the host sent a chat; `me` when it sent **both** halves of the user-tier key.
 * See `identityOf` for why "sent an empty string" and "sent nothing" have to be told apart.
 *
 * 🔴 **BOTH axes, not either.** The user-tier partition is `u:<charId>:<personaId>` — two components, and a
 * missing one composes to `''`, which `scopeKey` documents as a real and *distinct* partition ("no
 * character"), never a wildcard. So offering "About me" on a persona alone builds `u::<persona>` and lists
 * the memories that have no character at all, which is almost never what the user has: outside a chat
 * the host can send `personaId` and `tz` but no `charId`, so the button would appear, filter on a
 * partition holding nothing, and answered "About me" with an empty screen. In a feature whose whole purpose
 * is that a user can see their memories, an empty list is indistinguishable from having lost them.
 *
 * Inside a chat every axis arrives and the button is available. This partial-identity case needs a host
 * context that sends only some identity fields.
 *
 * @param {PanelIdentity} identity
 * @returns {Set<string>}
 */
export function availableScopes({ chatId, charId, personaId }) {
    const scopes = new Set(['all']);

    if (chatId) scopes.add('story');
    if (charId !== undefined && personaId !== undefined) scopes.add('me');

    return scopes;
}

/**
 * The partition keys a named scope stands for, or null for the whole store.
 *
 * 🔴 Composed by `scopeKey` from identity the host supplied, never assembled by hand here. The escaping in
 * `scopeKey` is what keeps the composition injective, and a second place that builds partition strings is a
 * second place that can get that wrong.
 *
 * 🔴 **`all` IS THE UNION OF THE OTHER TWO, NOT THE WHOLE DATABASE.** It used to return null, and null in
 * `#filter` means "every partition there is" — so "Everything" listed other characters' user facts and other
 * chats' scenario memories, each rendered with a tier label reading "this story". A memory from a chat the
 * user was not in, captioned as belonging to the one they are, reads as the engine having leaked their
 * conversations into each other; the store had done nothing of the kind, and the panel is the only place a
 * user can check that. The three buttons are one control, so they must partition one set: story ∪ me is
 * exactly what this character, this persona and this chat can recall, which is also exactly what
 * `retrievalScopes` puts in the prompt. Anything wider is a different user's-eye view than the one the
 * feature promises.
 *
 * Built by asking `availableScopes` rather than by repeating its two conditions, because the button that is
 * offered and the partition it filters on have to be the same decision — a second copy is a second answer,
 * and the one that drifts is the one nobody is looking at.
 *
 * ⚠️ Null survives for the case that has no identity at all to compose from — the host sent no chat and no
 * character, so there is no narrower honest answer and the whole store is what "Everything" can mean. Never
 * an empty array: `#filter` reads that as "no partitions, therefore no rows", which would answer a panel
 * whose entire purpose is showing the user their memories with a blank screen.
 *
 * @param {string} scope One of `story`, `me`, `all`
 * @param {PanelIdentity} identity From `identityOf`
 * @returns {string[]|null}
 */
export function scopesFor(scope, identity) {
    const { chatId, charId, personaId } = identity;

    if (scope === 'story') {
        return [scopeKey({ tier: TIER_SCENARIO, chatId })];
    }
    if (scope === 'me') {
        return [scopeKey({ tier: TIER_USER, charId: charId ?? null, personaId: personaId ?? null })];
    }

    const union = [...availableScopes(identity)]
        .filter(named => named !== 'all')
        // ⚠️ The `null` this function can return belongs to the `all` branch, which is the one just filtered
        // out: `story` and `me` each compose exactly one partition key and can only ever return a one-element
        // array. Without the cast the union would carry a null that cannot occur, because `flatMap` flattens
        // an array result and passes anything else through as an ELEMENT — so a `string[]|null` return type
        // becomes `(string|null)[]` here, and the header would have to guard against a null partition key.
        .flatMap(named => /** @type {string[]} */ (scopesFor(named, identity)));

    return union.length > 0 ? union : null;
}

/**
 * Which memories the last reply actually recalled, as `id → cosine similarity`.
 *
 * 🔴 THE RECORD ALREADY CARRIED THE IDS AND THE PANEL WAS NOT ASKING. `noteInjection` has written
 * `hits: [{ id, tier, text, score }]` on every generation since v4 — the log has been printing those ids all
 * along — while the browse view listed the store and marked nothing, so a user told "5 memories recalled" and
 * clicking through to look at them saw an undifferentiated list. This function is the whole of the missing
 * question.
 *
 * ⚠️ Empty whenever there is nothing honest to say: no record, a decline (`active !== true`), or a record about
 * a different conversation — {@link forThisChat}, the same per-chat gate the status light uses. The record is
 * one deep and rewritten by every generation *including* declines, so it is always about the last turn and can
 * never go stale mid-chat.
 *
 * @param {string} handle The authenticated caller
 * @param {{ chatId: string|null }} identity The generation axes this panel is being viewed under
 * @returns {Map<number, number>} memory id → the similarity it was retrieved at
 */
function recalledNow(handle, identity) {
    const recall = forThisChat(getRecall(handle), identity.chatId);

    if (recall?.active !== true) {
        return new Map();
    }

    return new Map((recall.hits ?? [])
        .filter(hit => Number.isInteger(hit?.id))
        // ⚠️ The tuple cast is what makes this a Map entry rather than a two-element array. TypeScript infers
        // `number[]` for an array literal with no contextual type, and the `Map` constructor wants a pair —
        // there is no way to give the callback that context short of saying so here.
        .map(hit => /** @type {[number, number]} */ ([hit.id, hit.score])));
}

/**
 * The recalled memories as rows, newest first — the list behind the "Just recalled" filter.
 *
 * 🔴 **SCOPE-CHECKED, even though these ids came from a scoped search.** `getMemory` is by primary key and
 * knows nothing about partitions, so this is the one read in the browse view that could put a row on screen
 * that the scope buttons could not. It cannot cross users (a record is per-handle, behind that handle's own
 * vault), but {@link forThisChat} deliberately allows a record through when either side carries no `chatId` —
 * so on a host that sends none, "what your last reply used" could otherwise mean a different conversation's
 * rows, rendered under this one's tier labels. That is the failure `scopesFor('all')` was tightened for; the
 * same union is applied here.
 *
 * ⚠️ Sorted by `createdAt`, NOT by score. Every list this panel draws is newest-first and {@link renderList}
 * groups it into days on that assumption — ranked order would scatter the day separators. The rank is not lost:
 * it rides in each badge's tooltip.
 *
 * @param {MemoryStore} store The caller's open store
 * @param {Map<number, number>} recalled From {@link recalledNow}
 * @param {PanelIdentity} identity From `identityOf`
 * @returns {MemoryRow[]} rows in `listMemories` shape
 */
function recalledRows(store, recalled, identity) {
    if (recalled.size === 0) {
        return [];
    }

    const allowed = scopesFor('all', identity);

    // ⚠️ The cast is the `row !== null` in the filter, carried across it. `Array.prototype.filter` hands back
    // the element type it was given unless its predicate is a type guard, and this one cannot be — it also
    // tests the scope, which is the check the docblock above is entirely about. Everything that survives both
    // halves is a row.
    return /** @type {MemoryRow[]} */ ([...recalled.keys()]
        .map(id => store.getMemory(id))
        // A recalled memory can have been deleted since the reply that used it — a gap, not an error.
        .filter(row => row !== null && (allowed === null || allowed.includes(row.scope))))
        .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
}

/**
 * Read everything the browse view renders from, in one place, so a full render and a partial one can never
 * disagree about what is in the store.
 *
 * @param {MemoryStore} store The caller's open MemoryStore
 * @param {ViewState} view From `viewState`
 * @param {string} handle The authenticated caller
 * @returns {BrowseSpec} the render spec `panel-view.js` consumes
 */
function browseSpec(store, view, handle) {
    // The user's own knobs, read once for the header below. See the 🔴 on `firstPassMessages`.
    const tuned = readSettings(store);

    const { identity } = view;
    const scopes = scopesFor(view.scope, identity);
    const page = { includeRetired: view.replaced, scopes };

    // What the last reply actually used, as `id → similarity`. Every row on this page is checked against it, so
    // the answer to "which of these five did it use" is on the rows themselves — and the filter below is how you
    // find them when they are not all on the page you are looking at.
    const recalled = recalledNow(handle, identity);
    const recalledMemories = recalledRows(store, recalled, identity);

    const memories = view.recalled ? recalledMemories : store.listMemories({ limit: PAGE_SIZE, offset: view.offset, ...page });
    const total = view.recalled ? recalledMemories.length : store.countMemories(page);
    const ids = memories.map(m => m.id);
    const predecessors = store.havePredecessors(ids);

    // 🔴 The chain is walked ONLY for the row the user expanded. `superseded_by` has no index, so walking every
    // row of every page on every click is how a panel that felt instant stops being one — see havePredecessors.
    // ⚠️ Annotated, not inferred: a bare `new Map()` is `Map<any, any>`, and an `any` here would travel all the
    // way into `renderRow`'s `versions` unchecked — the one field on this spec that carries memory statements.
    /** @type {Map<number, MemoryRow[]>} */
    const versionsFor = new Map();

    if (view.expand !== null && predecessors.has(view.expand)) {
        versionsFor.set(view.expand, store.versionsOf(view.expand));
    }

    // Why each retired row on this page is retired, which is the SUCCESSOR's source — see `sourcesOf`. The
    // expanded chain's rows are asked about too, since each of them was superseded by the next.
    const successors = [
        ...memories.map(m => m.supersededBy),
        ...[...versionsFor.values()].flat().map(v => v.supersededBy),
    ].filter(id => id !== null);
    const sources = store.sourcesOf(successors);

    // Counts for the header are per-partition and independent of the filter the user is looking through: the
    // sentence is about the store, not about the page. Only the partitions we have the identity to compose.
    //
    // ⚠️ `total` is the SAME set the "Everything" button shows, which is why it asks `scopesFor` for it rather
    // than passing null. The header and that button are two statements about one thing, and a total counting
    // partitions the list will never display is the header quietly contradicting the only view that could
    // check it — "You have 137 memories" over a list that can reach 6 of them.
    const counts = {
        total: store.countMemories({ includeRetired: false, scopes: scopesFor('all', identity) }),
        user: view.scopesAvailable.has('me') ? store.countMemories({ scopes: scopesFor('me', identity) }) : null,
        scenario: view.scopesAvailable.has('story') ? store.countMemories({ scopes: scopesFor('story', identity) }) : null,
    };

    return {
        view,
        memories,
        total,
        counts,
        predecessors,
        versionsFor,
        sources,
        recalled,
        // 🔴 The rows themselves, for the section pinned at the top of the view — the SAME array the
        // `recalled=1` filter puts into `memories` above, read once here so the section and the filtered list
        // cannot disagree about what the last reply used.
        recalledMemories,
        // Counted from what is actually in the store, never from the record's own `count`: a memory recalled for
        // the last reply and deleted a moment later is gone, and a toggle offering to show six rows that can
        // only produce five is the panel making a claim the list then contradicts.
        recalledCount: recalledMemories.length,
        // The floor `declineSentence` quotes back on a `below-threshold` decline. The prompt view has always
        // been handed it at its own call site; the recall section renders the same sentence, so it travels on
        // the spec rather than being read from `config.js` twice.
        minCosine: MEMORY_DEFAULTS.minCosine,
        // The record itself, for the header's "What was sent" control — which is offered on DECLINES too, so
        // it cannot be driven by `recalled` (empty on a decline) or by `recalledCount` (zero on one). Those
        // two answer "which stored memories were used"; this answers "did retrieval run at all this turn".
        recall: forThisChat(getRecall(handle), identity.chatId),
        editing: view.edit,
        adding: view.add,
        tz: view.tz,
        now: Date.now(),
        // 🔴 ONLY WHEN THE PAGE IS ACTUALLY ABOUT ONE CHARACTER. This took the first row that happened to carry
        // a `charName`, and then the header said "<Test User> remembers 12 things about you" over a list that was
        // not the user's. Two ways in: a group chat, where scenario memories in `s:<chatId>` are written under
        // several characters; and no chat open at all, where the host sends no `chatId`, `scopesFor('all')`
        // returns null (= the whole store), and the header captioned every memory the user has under one
        // arbitrary character's name.
        //
        // `scopesAvailable.has('me')` is the honest test: it is true exactly when the identity the host
        // supplied names a single character. Otherwise the header falls back to the "You have…" wording it
        // already has for this case.
        charName: view.scopesAvailable?.has('me') ? (memories.find(m => m.charName)?.charName ?? null) : null,
        gate: forThisChat(getGate(handle), identity.chatId),
        // 🔴 NOT filtered by chat, unlike `gate` and `recall`. Those describe one conversation's progress; a
        // failing extractor describes the INSTALL, and it fails identically in whichever chat the user opens
        // next. Filtering it would hide the banner the moment they switched chats to see whether the problem
        // followed them — which is the first thing anyone does, and the answer is yes.
        outcome: getOutcome(handle),
        // 🔴 The FIRST-pass threshold, not `triggerMessages`. The only header branch that prints a threshold is
        // the one with no gate record — the opening of the chat, where `ingest/index.js` uses this number. Once
        // a gate record exists the countdown carries its own `needed` and no threshold is printed at all.
        // 🔴 THE USER'S VALUES, NOT THE CONSTANTS. Both are printed as statements about what the engine WILL
        // DO — "next check on your next reply", "each pass stores at most N memories" — and both became
        // settable in v1.0. Reading the shipped constants here would make the panel describe an engine nobody
        // is running, which is worse than printing nothing: this panel exists to be the one trustworthy
        // account of work you cannot see, and a header confidently reporting the default while ingest uses
        // your value is a lie with nothing anywhere to catch it.
        firstPassMessages: tuned.firstPassMessages,
        maxMemories: tuned.maxMemories,
        // The replaced-count is the retired rows in the current partition — what the checkbox is offering to
        // show, so it must be counted the same way the list would count them.
        replacedCount: store.countMemories({ includeRetired: true, scopes }) - store.countMemories({ includeRetired: false, scopes }),
        scopesAvailable: view.scopesAvailable,
    };
}

/**
 * Every region the browse view can return, by name, each a thunk so only what was asked for is built.
 *
 * ⚠️ `memory-<slot>` is registered under the slot the ACTION named, not under the memory's id. An edit is
 * versioned, so the row's occupant changes identity on save while the element in the user's browser does not
 * — see `renderRow`. Registering it by id would name an element that does not exist, the host would log a
 * `console.debug`, and the row would silently stop responding after its first edit.
 *
 * @param {BrowseSpec} spec From `browseSpec`
 * @param {MemoryRow|null} row The memory occupying the slot this action touched, if any
 * @param {boolean} removed Whether the slot's memory is gone and the element should be deleted
 * @returns {Record<string, () => string>}
 */
function regionsOf(spec, row, removed) {
    const { view } = spec;
    // ⚠️ Annotated rather than inferred, because the two `slot-<n>` entries below are added by computed key.
    // Left to infer, this object's type would be exactly the six names spelled out here and a computed key
    // would be an error — the region set is deliberately open, and {@link renderRegions} is what closes it
    // again by only rendering names it can find.
    // ⚠️ `alert` IS REGISTERED AND NOTHING EVER ASKS FOR IT. Every `regions:` list the panel emits is drawn
    // from root / list / pager / toolbar / header / recalled / slot-N, so this entry is unreachable from our own
    // markup today. Kept rather than deleted, and stated rather than left to be rediscovered: the banner
    // reports the last INGEST outcome, which changes on a chat turn and never on a panel action, so there is no
    // action that ought to be naming it — a partial re-render that refreshed it would be redrawing something
    // that cannot have changed. If an action ever does need it, it is already here and correct.
    /** @type {Record<string, () => string>} */
    const regions = {
        root: () => renderBrowser(spec),
        alert: () => renderAlert(spec),
        header: () => renderHeader(spec),
        toolbar: () => renderToolbar(spec),
        recalled: () => renderRecalled(spec),
        list: () => renderList(spec.memories, view, spec),
        pager: () => renderPager(spec),
        'panel-error': () => renderError(null),
    };

    if (removed && view.slot !== null) {
        // 🔴 `data-panel-remove` DELETES the region rather than replacing it (fork §5.2), and it exists for
        // exactly this case. Without it a deletion would have to redraw the whole list to take one line away.
        regions[`slot-${view.slot}`] = () => `<div data-panel-region="slot-${view.slot}" data-panel-remove></div>`;
        return regions;
    }

    if (row && view.slot !== null) {
        regions[`slot-${view.slot}`] = () => renderRow(row, view, {
            // ⚠️ The cast is the `view.slot !== null` two lines up, carried into the thunk. TypeScript keeps a
            // narrowing on a VARIABLE inside a closure — which is why `row` needs no cast — and drops one on a
            // PROPERTY, because in general something could assign to it before the closure runs. Nothing does:
            // `view` is `spec.view`, settled once by `viewState` from the request and never written to.
            slot: /** @type {number} */ (view.slot),
            versions: spec.versionsFor.get(row.id) ?? [],
            // 🔴 THE SAME QUESTION THE LIST RENDER ASKS, AND IT USED TO ASK A DIFFERENT ONE. The list uses
            // `predecessors.has(id)` — "does this row have EARLIER versions", which is what `versionsOf`
            // answers and what the history control opens. This added `|| row.supersededBy !== null`, which is
            // the OPPOSITE question: "does it have a SUCCESSOR". So with "Show replaced" on, any row-local
            // action on a retired leaf row (open the edit box, cancel) brought it back wearing a "history"
            // control it had not had — and clicking it set `expand=<id>`, which `browseSpec` only walks
            // `if (predecessors.has(view.expand))`. False. So `versions` stayed empty, the label re-rendered as
            // "history", and the control opened nothing, for ever.
            hasVersions: spec.predecessors.has(row.id),
            editing: view.edit === row.id,
            // 🔴 The partial render has to know this too, or a row loses its badge the moment anything touches
            // it — open the edit box on a recalled memory, cancel, and it comes back looking un-recalled. The
            // fragment and the whole-list render read the same map for exactly that reason.
            recalledAt: spec.recalled.get(row.id),
            sources: spec.sources,
            tz: spec.tz,
            now: spec.now,
        });
    }

    return regions;
}

/**
 * Render whatever this request asked for: the whole fragment, or only the regions an action disturbed.
 *
 * Shared by `GET /panel` and by every action route, so a partial re-render is built from exactly the same
 * spec — and therefore exactly the same store reads — as a full one.
 *
 * @param {MemoryStore|null} store The caller's open store, or `null` when the caller could not open one and is
 *   asking for the ONE view that reads no store — see the log branch below. Every other branch dereferences it,
 *   so `null` is only ever passed together with a request whose view is `log`.
 * @param {import('express').Request} req Express request
 * @param {string} handle The authenticated caller
 * @param {{ rowId?: number|null, removed?: boolean, forceView?: PanelViewName|null, notice?: string,
 *   rescanNotice?: string }} [opts]
 *   The memory now occupying the touched slot, if an action moved one; or that the slot is now empty.
 *   `forceView` is for a route that IS a view — see `viewState`. `notice` is a sentence about what the action
 *   just did, rendered by the view that asked for it — ⚠️ it comes from the ROUTE, never from the request, so
 *   nothing a client sends can put text on this screen. `rescanNotice` is the rescan route's sentence, from
 *   the route in the same way, rendered beside the Rescan control rather than under the reset.
 * @returns {string} an HTML fragment
 */
export function renderView(store, req, handle, { rowId = null, removed = false, forceView = null, notice = '', rescanNotice = '' } = {}) {
    const view = viewState(req, { forceView });

    // 🔴 ABOVE EVERY STORE READ, and unlike the two views below it does not even take the store as an input.
    // The log exists to be readable when something is broken, and "something is broken" includes the store
    // itself — a view that touched it would be unavailable in precisely the situation it was built for.
    //
    // 🔒 **THE ADMIN TEST LIVES HERE AND NOT ONLY IN `readPanel`, because this function has other callers.**
    // Every memory and settings route re-renders through it, and each passes the request straight in — so a
    // `view=log` parameter on `PUT /memory/:id` would have reached this branch with the store gate already
    // satisfied. One check at the branch covers every door; a check at one caller covers one door. See
    // `renderLog` for what the shared tape actually exposes about the other accounts on the install.
    if (view.view === 'log') {
        return renderLog({ tape: readTape(), view, denied: !req.user?.profile?.admin });
    }

    // 🔒 Past this line every branch reads the store, so a caller that had none has asked for something that
    // cannot be answered. `readPanel` only passes null together with the log view above; this is what makes
    // that contract checkable rather than a comment, and it fails to the same locked panel a locked vault gets.
    if (!store) {
        return renderLockedPanel();
    }

    // 🔴 ABOVE THE BROWSE SPEC, LIKE `log` AND `prompt`, because it reads the store's `meta` table and none of
    // its memories. Building a browse spec first would page and scope-filter rows nothing here renders.
    if (view.view === 'settings') {
        return renderSettings({
            settings: readSettings(store),
            presets: readPresets(store).map(p => ({ name: p.name, custom: p.template !== '', builtIn: p.builtIn })),
            template: readPromptTemplate(store),
            defaultTemplate: DEFAULT_EXTRACTION_TEMPLATE,
            placeholders: TEMPLATE_PLACEHOLDERS,
            view,
            notice,
            rescanNotice,
            // ⚠️ READ ON EVERY RENDER, not cached: this screen re-renders after the reset that changes it, and
            // a stale count there would be the one number on the page that says the button did nothing. It is
            // a `COUNT(*)` and a `stat`, which is cheap enough to pay for on a screen a user opens by hand.
            usage: store.usage(),
            // 🔴 `forceView` IS THE SIGNAL, AND IT IS ALREADY HERE. It is set by exactly one caller —
            // `readSettingsFragment`, the fork's §28 Extensions-dialog door, whose ROUTE is the view — so a
            // non-null value means "this fragment is the settings screen on its own, not a panel showing it".
            // Back belongs to the panel: in the Extensions dialog it fetches `/panel`, gets a `root` region,
            // and replaces the settings form with the entire memory browser embedded in the dialog, with no
            // way back short of collapsing and re-opening the plugin row.
            standalone: forceView !== null,
        });
    }

    if (view.view === 'calendar') {
        const times = store.memoryTimes({ includeRetired: view.replaced, scopes: scopesFor(view.scope, view.identity) });
        const now = Date.now();
        // The month to open on: the one asked for, else the newest memory's, else this one.
        const month = view.month ?? dayKey(times[0] ?? now, view.tz).slice(0, 7);

        return renderCalendar({ times, month, view, tz: view.tz, now });
    }

    if (view.view === 'prompt') {
        // 🔴 NO STORE READ AT ALL, and that is the point of putting it above `browseSpec`. This view renders
        // recall records and nothing else — the block as it was sent, not the rows it was built from. Going
        // through the store would mean re-reading memories that may have been edited or deleted since the
        // reply, which is precisely the drift that makes "what was actually sent" unanswerable.
        //
        // 🔴 FILTERED TO THIS CONVERSATION BY THE SAME GATE THE REST OF THE PANEL USES. The buffer is
        // per-handle and a user moves between chats, so without this, paging back would walk out of the
        // conversation being read and describe another one's prompts as this one's — §14.4's staleness bug,
        // with more turns to hide in.
        const history = getRecalls(handle).filter(rec => forThisChat(rec, view.identity.chatId) !== undefined);
        // Clamped HERE, where the length is known. `viewState` cannot do it: a `turn` past the end must land on
        // the oldest record we still hold rather than on a blank page, and it has no way to know where that is.
        const turn = Math.min(view.turn, Math.max(0, history.length - 1));

        return renderPrompt({
            recall: history[turn],
            view,
            minCosine: MEMORY_DEFAULTS.minCosine,
            turn,
            total: history.length,
        });
    }

    const spec = browseSpec(store, view, handle);
    // Which memory occupies the touched slot: the one an action just created or changed, else the one the
    // request names by id (a row-local GET — opening an edit box, expanding a chain, canceling).
    // ⚠️ The `string` cast describes `parseInt` rather than the argument — see the note in {@link viewState}.
    const rowTarget = rowId ?? (Number.parseInt(/** @type {string} */ (req.query?.id), 10) || null);
    // 🔴 SCOPE-CHECKED, for the same reason `recalledRows` states and this path did not honor. `getMemory` is
    // a primary-key lookup with no partition filter, and `?id=` is caller-supplied — so a hand-built
    // `GET /panel?regions=slot-0&slot=0&id=<any id>` rendered that memory into the current chat's panel, with
    // `tierLabel` captioning a scenario memory from an unrelated conversation as "this story". It cannot cross
    // users (the store is the caller's own file) and the panel never emits such a link, but "no UI produces
    // it" is not a check — and mislabeling one chat's memories as another's is exactly what 78486ec fixed.
    const allowed = scopesFor('all', view.identity);
    const candidate = !removed && rowTarget !== null ? store.getMemory(rowTarget) : null;
    const row = candidate && (allowed === null || allowed.includes(candidate.scope)) ? candidate : null;
    const available = regionsOf(spec, row, removed);

    if (view.regions.length === 0) {
        return renderBrowser(spec);
    }

    return renderRegions(view.regions, available);
}

/**
 * GET /panel — the fragment the fork shows when the user clicks the icon.
 *
 * 🔴 FEATURE-DETECTED ON `apiVersion >= 4`, and the fallback is not a lesser browse view — it is the recall
 * readout, unchanged (fork §11.2). A host below 4 honors no actions, so every control this module renders
 * would arrive as an inert `<div>`: a screen full of buttons that do nothing, which is worse than not
 * offering them. The old readout is a complete, working answer to a smaller question, so that is what a v3
 * host gets.
 *
 * 🔴 A LOCKED VAULT GETS ITS OWN 200 FRAGMENT, NOT A 409. See the module header.
 *
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response
 * @param {import('../host/context.js').HostContext} host The fork, as we are allowed to see it
 * @param {{ forceView?: PanelViewName|null }} [opts] A view the ROUTE decided — see `readSettingsFragment`
 * @returns {void}
 */
export function readPanel(req, res, host, { forceView = null } = {}) {
    const handle = req.user?.profile?.handle;

    if (!handle) {
        // Behind requireLoginMiddleware this should be unreachable; refuse rather than guess a user.
        res.status(401).json({ error: 'not authenticated' });
        return;
    }

    // 🔒 **THE LOG IS RESOLVED ABOVE THE STORE GATE, because `renderView`'s own comment says it must be and its
    // caller then made it impossible.** That comment reads: *"the log exists to be readable when something is
    // broken, and 'something is broken' includes the store itself."* True — and the store gate below runs first,
    // so it never held. `openFor` swallows an open failure (`session.js`: *"Details suppressed"*) and leaves the
    // handle out of `stores`, so a user whose vault is UNLOCKED but whose `store.db` will not open is told
    // "Memory is locked. Unlock your vault…" — which is false — and `renderLockedPanel` offers no route to the
    // one screen that would name the cause. The log takes no store argument, so hoisting it is the whole fix.
    //
    // 🔒 **AND IT IS ADMIN-ONLY, because the tape is PROCESS-GLOBAL.** `log-tape.js` records every `normal()`
    // line from every user — the logging seam has no handle to filter on — and this route served the whole tape
    // to whoever asked. The argument in that module is that a normal line carries no content, which is true and
    // is not the same as carrying nothing: "3 store(s) now open", "the store now holds 47 memories", "Stored
    // memory 41 … nearest cos 0.412", "Recalled 3 memories … ids [12,44,51]" are, in aggregate and timestamped
    // to the second, an activity log of the other accounts on the box — when they are online, how fast they
    // chat, how much they are accumulating. On a plugin whose premise is a per-user encrypted store, that is a
    // cross-tenant leak of metadata, and the panel's own copy ("safe to put in front of a user") was written
    // about the reader rather than about the people being read.
    //
    // ⚠️ The admin test itself is NOT here — it is on `renderView`'s log branch, because every memory and
    // settings route re-renders through that function too and one check at the branch covers all of them.
    // What this hoist decides is only WHETHER THE STORE IS REQUIRED, and for this one view it is not.
    if (viewState(req, { forceView }).view === 'log') {
        sendFragment(res, renderView(null, req, handle, { forceView }));
        return;
    }

    // 🔒 The lock check decides WHICH renderer runs, and that is the gate that lets any of them show memory
    // statements at all — renderLockedPanel takes no arguments and so can name nothing. See src/panel-view.js.
    const store = storeFor(handle);

    if (!store) {
        sendFragment(res, renderLockedPanel());
        return;
    }

    if (!(host?.apiVersion >= 4)) {
        const state = panelState(handle, chatIdOf(req));
        sendFragment(res, renderPanel(state.recall, state.ingest));
        return;
    }

    sendFragment(res, renderView(store, req, handle, { forceView }));
}

/**
 * GET /panel/settings — the SAME settings screen, for the fork's Extensions dialog (fork §28).
 *
 * 🔴 **A SECOND DOOR, NOT A SECOND IMPLEMENTATION.** It renders through `readPanel` and therefore through
 * `renderSettings`, which stays the only place the form exists. A settings screen written twice would drift,
 * and the drift would be silent — see `registerSettingsScreen` in index.js.
 *
 * Register a query-free address so the settings view does not depend on host-specific query merging. The route
 * selects the settings view; `runAction` separately merges action parameters with the ambient context.
 *
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response
 * @param {import('../host/context.js').HostContext} host The fork, as we are allowed to see it
 * @returns {void}
 */
export function readSettingsFragment(req, res, host) {
    readPanel(req, res, host, { forceView: 'settings' });
}

/**
 * GET /panel.css — the panel's own stylesheet (fork §10.3), which the host fetches once and injects wrapped in
 * `@scope (#pluginPanel-mnemosyne)`.
 *
 * 🔴 **NO AUTHENTICATION DECISION AND NO STORE.** It is a constant string of CSS: it names no memory, reads no
 * vault, and must answer the same whether the caller's vault is open, locked, or absent — a stylesheet that
 * 404s while locked would leave a user's panel unstyled at exactly the moment they are trying to work out what
 * is wrong with it. The route still sits behind the fork's login middleware like every other.
 *
 * @param {import('express').Request} _req Express request — nothing on it changes the answer
 * @param {import('express').Response} res Express response
 * @returns {void}
 */
export function readPanelCss(_req, res) {
    res.status(200).set('Content-Type', 'text/css; charset=utf-8').send(PANEL_CSS);
}

/**
 * Send an HTML fragment. Always 200 — see the module header for why a panel never answers with a status.
 * @param {import('express').Response} res Express response
 * @param {string} html The fragment, already escaped by `panel-view.js`
 * @returns {void}
 */
export function sendFragment(res, html) {
    res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(html);
}

/**
 * GET /status — whether the icon lights, and the badge count (capability 7, B4).
 *
 * 🔴 Always 200, even locked or idle — an unlit icon, not an error. So this does NOT use storeForRequest (whose
 * 409-on-lock is right for content but wrong for a status light); it reads the authenticated handle directly and,
 * on lock, finds no record (it was dropped) and reports inactive. Cheap: no DB, no embed, just the in-memory view.
 *
 * @param {import('express').Request} req Express request
 * @param {import('express').Response} res Express response
 * @returns {void}
 */
export function readStatus(req, res) {
    const handle = req.user?.profile?.handle;

    if (!handle) {
        res.status(401).json({ active: false, count: 0 });
        return;
    }

    const { recall, ingest } = panelState(handle, chatIdOf(req));

    // ✅ `?backend=` IS STILL SENT AND NO LONGER READ. The fork's panel host puts the browser's selected API on
    // every status poll (and re-polls on MAIN_API_CHANGED) because 1.4.0 asked it to, so the light bulb could
    // go dark the moment a user switched to Chat Completion. Nothing is dark by mode any more — recall runs on
    // every backend — so the poll answers from the records alone, and the parameter is simply unused. Left
    // in the fork's client; a field nobody reads costs nothing and removing it would be a request for its own
    // sake.

    // 🔴 The badge counts THE DOMINANT EVENT, not the store and not the turn's total — the same rule the color
    // follows, because they are the same badge. The fork's client sets it from `data.count` on whichever
    // notification is dominant (plugin-panels.js `refreshNotifications`), and a poll that answered "4" while the
    // push that just painted the button purple said "1" would make the number flicker between two meanings for
    // no gain. Writes are dominant over recalls here for the same reason purple is: they happen second.
    const dominant = ingest?.active === true ? ingest : recall;

    res.status(200).json({ active: dominant?.active === true, count: dominant?.active ? dominant.count : 0 });
}
