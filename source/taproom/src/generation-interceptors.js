/**
 * Server-side generation interceptors.
 *
 * SillyTavern already has generation interceptors — on the CLIENT. `runGenerationInterceptors(coreChat,
 * this_max_context, type)` lets an extension see and change what is about to be generated, and every stock
 * extension that puts text into a prompt uses that road. The server has no such thing, so a server plugin
 * cannot take part in generation at all: it can serve HTTP routes, and that is the end of its reach.
 *
 * This is that feature, on the other side of the wire. It is deliberately framed as the mirror of something
 * SillyTavern already believes in, because that is what keeps it a plausible upstream feature rather than a
 * private hook for one plugin.
 *
 * 🔴 THE FORK DECIDES NOTHING HERE. It does not know what a memory is, where in a prompt one belongs, or how
 * many of them fit. It hands over what is about to be sent, takes back a replacement, and sends that. Every
 * judgement — what to add, what to drop, whether the budget allows it — belongs to whoever registered.
 *
 * 🔴 AN INTERCEPTOR THAT SILENTLY CHANGES NOTHING IS THE FAILURE MODE TO FEAR, AND THE ANSWER IS TO REFUSE
 * THE GENERATION. A plugin whose handler throws, returns the wrong shape, or never comes back was going to
 * put something into this prompt and did not. Sending the prompt anyway does not fail — the client already
 * supplied a complete one, so the model answers and the reply looks perfectly ordinary, with the memory
 * simply missing and nothing downstream able to tell. That is the quiet failure §6.5 of
 * DESIGN_MEMORY_PLUGIN_API.md exists to forbid, so all three refuse the generation, named against the
 * plugin that caused it.
 *
 * ⚠️ DECLINING IS DIFFERENT AND STAYS SILENT. A handler that returns nothing has said "not my backend" —
 * the documented way for a chat-only plugin to sit out a text generation — and is not a failure at all.
 */

/**
 * One turn of the conversation, as a plugin receives it.
 *
 * 🔴 NOT SillyTavern's `ChatMessage`. The client normalizes before sending (§17.5) — ST's internal shape is
 * `{ mes, name, is_user, is_system, extra, … }`, with no `role` and no `content`, and forwarding it raw would
 * hand every plugin the fork's internals and break any renderer written against the chat path.
 * @typedef {object} RecentMessage
 * @property {'user'|'assistant'|'system'} role Who spoke
 * @property {string} [name] The character in a solo chat, the responding character in a group, the persona on user turns
 * @property {string} content Post-macro-substitution, PRE-instruct-render — never a template
 * @property {number} index The turn's position in the FULL chat array. The window's anchor; see §17.8.
 * @property {string|null} charId Who PRODUCED this turn, as a stable id (§22.8.2). `null` — never `''` — on
 * user, narrator and system turns, and on any turn whose character the id map does not hold. The `name` above
 * is a display name and cannot address a partition; this is what a memory plugin scopes a write to.
 * @property {number|null} sendDate When the message was sent, in epoch milliseconds (API v7). `null` when the
 * message holds no time, or one in a format the fork does not recognize — never `0` and never the current
 * time. Parsed server-side by `src/message-time.js`, the same parser `context.readChat` uses, so a turn has
 * the same `sendDate` whichever path delivered it.
 * @property {number} [promptOffset] Where this turn's RENDERED form begins in `outgoing.prompt`, as a
 * character offset (§27). The turn boundaries only ever existed in the client, at build time, and the render
 * discards them — so a plugin wanting depth-precise insertion on the text path had to guess the instruct
 * template out of the blob, and prepended to the front instead. Front placement measures at 0.1 % KV-cache
 * reuse against 97.1 % below the history (`KVCACHE_WORLDINFO_MEASUREMENTS.md`), which is what makes this
 * structural rather than cosmetic.
 *
 * 🔴 `-1` MEANS "COULD NOT BE PLACED", AND IS DIFFERENT FROM THE FIELD BEING ABSENT. Absent = a client that
 * does not ship the anchor, or the chat path, where there is no rendered string to point into and none is
 * needed. -1 = the client shipped it and this particular turn was not found in the final prompt — trimmed
 * out of the window, or transformed by a subscriber after the boundaries were taken. Both mean "do not
 * splice here"; only one of them is worth reporting as a fork problem.
 *
 * ⚠️ WHERE THE BLOCK GOES IS STILL YOURS (§6.3). This is structure, not policy: the fork says where the turns
 * are and has no opinion about what belongs between them.
 */

/**
 * What is about to be sent to a backend.
 * @typedef {object} OutgoingPrompt
 * @property {string} handle The user this generation belongs to
 * @property {'text'|'chat'|'kobold'|'novel'} backend Which family. All four generation routes call this,
 * and that is now true rather than aspirational: 'kobold' was advertised here with no call site behind it
 * for the whole life of the seam, and 'novel' was not mentioned at all despite the client shipping the
 * window to it. A plugin that only understands one family declines on the others by returning nothing.
 * @property {string} apiType The specific backend within that family, verbatim from the request
 * @property {any[]} [messages] The prompt as a structured array. Present for 'chat' ONLY.
 * @property {string} [prompt] The prompt as one rendered string. Present for 'text' and 'kobold' ONLY.
 * @property {number} [budget] The context length the client told the BACKEND to use — `max_context_length` on
 * 'kobold', `truncation_length` on 'text', and undefined on 'chat', whose body carries no input budget at all
 * (see chat-completions.js, where that undefined is deliberate and explained).
 *
 * ⚠️ THIS IS NOT THE ROOM YOU HAVE, AND IT IS LARGER THAN IT. It used to be documented as "the context limit
 * as the CLIENT computed it", which reads as a budget to measure against and is not one: the client fills the
 * prompt to `max_context - amount_gen` and then hands the backend `max_context`, so the response reservation
 * is still inside this number. A plugin comparing its prompt against it concludes it has `amount_gen` tokens
 * of space that do not exist — worse than no signal, because it looks authoritative. Do not budget against it.
 * Declare `reservesTokens` at registration and the client leaves you the room before it trims (§17.6).
 * @property {string} [charName] The active character (or group) name, if the client sent it. May be undefined.
 * @property {string} [chatId] A stable id for the current chat, if the client sent it. May be undefined.
 * @property {string} [genType] Which KIND of generation this is, verbatim from the client. Undefined = ordinary.
 * @property {string|null} [charId] The active character as a STABLE id, surviving rename (§22.4). `null` when
 * no character is selected. This — not `charName` — is what identity should be keyed on: a rename changes the
 * name, and two cards can share one.
 * @property {string|null} [personaId] The active persona as a stable id (§22.7). `null` on the default avatar.
 * Needs no minting: `user_avatar` is already stable, which is exactly what characters were not.
 * @property {RecentMessage[]} [recentMessages] The recent turns, structured, on EVERY path. READ-ONLY —
 * returning it does nothing. Sliced to the count YOU declared at registration; undefined if you declared none,
 * and undefined rather than `[]` when the client sent nothing, because absent and empty are different facts.
 */

/**
 * @typedef {object} RegisteredInterceptor
 * @property {string} id The plugin that registered it, for the log line
 * @property {(outgoing: OutgoingPrompt) => Promise<any>} handler The interceptor itself
 * @property {number|undefined} recentMessages How many turns this one asked for, or undefined if it asked for none
 * @property {number|undefined} reservesTokens How much prompt space this one asked to be left free, or
 * undefined if it asked for none
 */

/** @type {RegisteredInterceptor[]} */
import path from 'node:path';

import { getOrMintCharacterId, lookupCharacterIds } from './character-ids.js';
import { withDeadline, PluginDeadlineError, PluginContributionError, getPluginTimeoutMs } from './util.js';
import { log, LogClass } from './logger.js';
import { parseSendDate, countUnrecognized } from './message-time.js';

const interceptors = [];

/**
 * The body field the client puts the structured turns in.
 *
 * 🔴 THE ONE NAME, EXPORTED, BECAUSE THERE IS EXACTLY ONE STRIP. §17.2: a whole conversation is far too big
 * for the header channel §16.2 established, and the text path forwards `request.body` to the backend VERBATIM
 * — so this rides the body and is deleted centrally before the forward. Robust-by-construction was not on
 * offer here; this is robust-by-one-correctly-placed-strip, and a second spelling of the name is how that one
 * place quietly becomes two.
 */
export const RECENT_MESSAGES_FIELD = 'st_recent_messages';

/**
 * The largest window a plugin may declare.
 *
 * ⚠️ THIS IS A TRANSPORT CEILING, NOT A CONTENT DEFAULT (§17.6). "This does not fit in a request" is the
 * fork's business; "how much history does a memory plugin need" is emphatically not, and the moment a number
 * in here starts standing in for a plugin's own judgement §17.6 has been violated. Nothing is clamped to it —
 * a declaration above it is refused loudly, at registration, in the plugin's own `init`.
 */
const MAX_RECENT_MESSAGES = 1000;

/**
 * Validate a plugin's declared window, and say so loudly if it is nonsense.
 * @param {string} id The registering plugin
 * @param {any} declared Whatever it passed as `recentMessages`
 * @returns {number|undefined} The count, or undefined if it declared none
 */
function readWindowDeclaration(id, declared) {
    if (declared === undefined) {
        return undefined;
    }

    if (!Number.isInteger(declared) || declared <= 0) {
        throw new TypeError(`Plugin '${id}' called context.onPrompt() with a 'recentMessages' that is not a positive whole number (got ${JSON.stringify(declared)})`);
    }

    if (declared > MAX_RECENT_MESSAGES) {
        throw new TypeError(`Plugin '${id}' asked for ${declared} recent messages, which is more than the ${MAX_RECENT_MESSAGES} that fit a generation request. Nothing has been clamped — pick a number that fits.`);
    }

    return declared;
}

/**
 * The largest reservation a plugin may declare.
 *
 * ⚠️ A CEILING ON ABSURDITY, NOT A BUDGET POLICY (§17.6, exactly as above). A plugin that wants a third of the
 * window has misunderstood what this is for; one that wants 700 tokens for a memory block has not. Refused
 * loudly at registration and never clamped — a silently shrunk reservation is a plugin whose arithmetic is now
 * wrong with no way to find out, which is the failure this whole mechanism exists to remove.
 */
const MAX_RESERVED_TOKENS = 8192;

/**
 * Validate a plugin's declared prompt reservation.
 *
 * 🔴 WHY A RESERVATION EXISTS AT ALL — MEASURED, 2026-07-30, NOT REASONED. An interceptor runs AFTER the client
 * has assembled, budgeted and trimmed the prompt, and the client fills to `max_context - amount_gen` while
 * telling the backend its room is `max_context`. Those are the same number by construction, so ANY interceptor
 * that adds tokens puts the prompt over — and KoboldCpp truncates from the FRONT, which is where a prepended
 * injection sits. Two runs of one prompt against GLM-Steam-106B differing only in `max_context_length`: at
 * 48,000 the model answered from the text that displaced the block, at 49,152 it answered from the block. The
 * injection is the one part of the prompt guaranteed not to arrive, and nothing anywhere reports it — the
 * plugin cannot see what the backend then did, so it goes on saying it injected.
 *
 * ⚠️ AND THE PLUGIN CANNOT FIX THIS ITSELF, WHICH IS WHY THE FORK HAS TO. §17.6 assigns the budget judgement to
 * whoever registered — correctly — but `budget` above is the raw context size rather than the client's fill
 * target, and `context` exposes no tokenizer. The rule was assigned to the plugin and both instruments were
 * retained by the host. A declaration read here and spent client-side before the history trim is the smallest
 * thing that hands them over.
 * @param {string} id The registering plugin
 * @param {any} declared Whatever it passed as `reservesTokens`
 * @returns {number|undefined} The reservation, or undefined if it declared none
 */
function readTokenReservation(id, declared) {
    if (declared === undefined) {
        return undefined;
    }

    if (!Number.isInteger(declared) || declared <= 0) {
        throw new TypeError(`Plugin '${id}' called context.onPrompt() with a 'reservesTokens' that is not a positive whole number (got ${JSON.stringify(declared)})`);
    }

    if (declared > MAX_RESERVED_TOKENS) {
        throw new TypeError(`Plugin '${id}' asked to reserve ${declared} tokens of prompt space, which is more than the ${MAX_RESERVED_TOKENS} ceiling. Nothing has been clamped — pick a number that fits.`);
    }

    return declared;
}

/**
 * Register something that wants to see and rewrite outgoing prompts.
 *
 * Handlers run in registration order, each seeing what the previous one produced. That ordering is
 * meaningful in a way that ordering between, say, two maintenance tasks is not — two plugins both editing a
 * prompt will notice each other — so it is defined rather than incidental.
 *
 * 🔴 THE WINDOW SIZE IS YOURS AND THE FORK SHIPS NO DEFAULT (§17.6). Declare `recentMessages` and you get
 * exactly that many turns; declare nothing and you get `undefined` — not a partial window, not a guess. A
 * silent half-window is worse than an obvious absence, and "how much history does this plugin need" is
 * memory-shaped judgement that has no business being frozen into a fork API.
 *
 * 🔴 SO IS THE RESERVATION, AND IT IS THE ONE THING THE FORK MUST SPEND ON YOUR BEHALF. Declare
 * `reservesTokens` and the client subtracts it from its fill target BEFORE it trims history, so the prompt
 * arrives already sized to leave you that much room. Declare nothing and you get today's behaviour, which is
 * that anything you add overruns the backend and is discarded from the front — see `readTokenReservation`.
 * The number is static and worst-case, so it is spent on every generation including the ones where you inject
 * nothing; that is free on a short chat, where there is nothing to displace, and costs a message or two of
 * history on a full one.
 *
 * ⚠️ NOTHING VERIFIES THAT YOU KEEP TO IT, AND THAT IS A CONSIDERED DECISION RATHER THAN A GAP. The server
 * could count what you returned (`src/tokenizers`) and refuse the difference — but on a text backend it has no
 * authoritative tokenizer for the model in play, so its count and the backend's can legitimately disagree, and
 * the failure that buys is a correct plugin refused for arithmetic neither party owns. A wrong refusal is
 * worse than the over-declaration it would catch. Declare a number you can guarantee.
 * @param {string} id The registering plugin's ID
 * @param {(outgoing: OutgoingPrompt) => Promise<any>} handler Called with what is about to be sent
 * @param {{recentMessages?: number, reservesTokens?: number}} [options] What this handler wants alongside the prompt
 * @returns {void}
 */
export function onPrompt(id, handler, options = {}) {
    // 🔴 REFUSE AT REGISTRATION, BECAUSE THE ALTERNATIVE IS A PERMANENT OUTAGE FOR EVERY USER. Both numeric
    // declarations are validated here and the handler itself was not, so `context.onPrompt(this.handlePromt)`
    // — one typo — registered cleanly and then threw a TypeError at :534 on the NEXT GENERATION BY ANYONE.
    // The catch below rethrows by design, so every generation on every backend 500s for every user until the
    // operator restarts without the plugin. Worse, the log names the plugin and says "failed", sending its
    // author to read their handler body rather than their registration call.
    //
    // ⚠️ This is the one member of the family that did not check. `chat-lifecycle`'s two registrars both
    // throw on a non-function and are tested for it; `plugin-panels.register`, `notifications.notify`,
    // `context.embed` and `context.generate` all validate loudly. Boot-time is where a plugin author can
    // actually see it.
    if (typeof handler !== 'function') {
        throw new TypeError(`Plugin '${id}' called context.onPrompt() with something other than a function`);
    }

    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError(`Plugin '${id}' called context.onPrompt() with something other than an options object`);
    }

    interceptors.push({
        id,
        handler,
        recentMessages: readWindowDeclaration(id, options.recentMessages),
        reservesTokens: readTokenReservation(id, options.reservesTokens),
    });
}

/**
 * What every plugin declared it wants, for the client to read.
 *
 * ⚠️ THIS TRAVELS OUTWARD, WHICH IS A NEW DIRECTION (§17.6). Everything else here flows client → server →
 * plugin; this one has to reach the client BEFORE it builds a request, because the client is what slices the
 * conversation. It goes out on `GET /api/plugins/client-config` — §14.2(b)'s endpoint, which is keyed by
 * capability precisely so a second consumer could add a sibling key without reshaping the first.
 *
 * A plugin registering twice with two different counts gets the larger, so neither of its handlers is short
 * -changed; the per-handler slice below still hands each one exactly what it asked for.
 *
 * 🔴 THE TWO DECLARATIONS FOLD DIFFERENTLY, AND THE ASYMMETRY IS THE WHOLE POINT. One payload of recent turns
 * serves every handler, so the LARGEST window declaration satisfies all of them. Prompt space is not shared:
 * two handlers that both inject both need their own room, so reservations SUM — here across a plugin's own
 * registrations, and again in `plugin-client-config.js` across plugins. Taking the max at either level leaves
 * the second injection overrunning exactly as before, which is the bug this exists to remove. Over-reserving
 * costs a message of history; under-reserving loses a memory silently, so the fold errs upward on purpose.
 * @returns {Record<string, {recentMessages?: number, reservesTokens?: number}>} Declarations, keyed by plugin id
 */
export function listPromptDeclarations() {
    // ⚠️ NULL PROTOTYPE — THE KEY IS A PLUGIN ID AND THE ID GRAMMAR ADMITS `__proto__`. `isValidPluginID` is
    // `/^[a-z0-9_-]+$/`, which that passes. On a plain object `declarations['__proto__']` then returns
    // Object.prototype, and the write below lands ON IT — so `recentMessages` becomes a property of EVERY
    // object in the process, including the options bag in `onPrompt`, and plugins that declared no window
    // silently acquire one. Three lines, process-wide, from a directory name.
    /** @type {Record<string, {recentMessages?: number, reservesTokens?: number}>} */
    const declarations = Object.create(null);

    for (const { id, recentMessages, reservesTokens } of interceptors) {
        // ⚠️ BOTH, OR A RESERVATION-ONLY PLUGIN IS INVISIBLE. This skip used to test `recentMessages` alone,
        // because a window was the only thing anyone could declare; a plugin that wants room but no history
        // would have been dropped here and never reached the client.
        if (recentMessages === undefined && reservesTokens === undefined) {
            continue;
        }

        const declaration = declarations[id] ?? {};

        if (recentMessages !== undefined) {
            declaration.recentMessages = Math.max(recentMessages, declaration.recentMessages ?? 0);
        }

        if (reservesTokens !== undefined) {
            declaration.reservesTokens = (declaration.reservesTokens ?? 0) + reservesTokens;
        }

        declarations[id] = declaration;
    }

    return declarations;
}

/**
 * Is anyone listening?
 *
 * The endpoints check this so that a stock SillyTavern with no plugins does not build a descriptor object
 * per generation for nobody to read.
 * @returns {boolean} True if at least one interceptor is registered
 */
export function hasPromptInterceptors() {
    return interceptors.length > 0;
}

/**
 * Forget every registered interceptor. Tests only.
 * @returns {void}
 */
export function clearPromptInterceptors() {
    interceptors.length = 0;
}

/**
 * Read the character and chat identity a generation request carries out-of-band, in headers.
 *
 * 🔴 HEADERS, NOT THE BODY, AND ON PURPOSE. The text-completions path serialises `request.body` to the backend
 * VERBATIM (`text-completions.js`), so anything placed there is transmitted to the model host. These ride in
 * headers, which the backend fetch never copies — so identity cannot leak to the backend by construction,
 * rather than by remembering to strip a body field. They are URL-encoded by the client because a character
 * name is user content and may be non-ASCII, which a raw HTTP header value cannot carry.
 *
 * Absent or empty → undefined; the fields are optional on `OutgoingPrompt` and an old client sends neither.
 * @param {import('express').Request} request
 * @returns {{charName: string|undefined, chatId: string|undefined}}
 */
export function readIdentityHeaders(request) {
    const read = (name) => {
        const value = request.get(name);
        if (typeof value !== 'string' || value === '') {
            return undefined;
        }
        try {
            return decodeURIComponent(value);
        } catch {
            // A malformed percent-sequence is not worth failing a generation over — take it raw.
            return value;
        }
    };

    // 🔴 THE AVATAR HEADER IS THE ONE THAT BECOMES A PERSISTED KEY, SO IT IS THE ONE THAT IS CHECKED.
    //
    // Every previously-unseen value MINTS a row in `character-ids.json` and rewrites the whole file — a
    // decrypt plus an encrypt on an encrypted install — and `getOrMintCharacterId` asks only that it be a
    // non-empty string. Anything able to issue authenticated generations (a stale tab replaying, a
    // misbehaving client extension) therefore grows that file without bound, one full rewrite per request.
    // Traversal is already defended downstream, so what this closes is the growth, not an escape: a value
    // that could not be a real avatar filename resolves to no character rather than to a new one.
    const avatar = read('X-ST-Char-Avatar');
    const isPlausibleAvatar = typeof avatar === 'string'
        && avatar.length <= 255
        && avatar !== '.'
        && avatar !== '..'
        && !/[/\\]/.test(avatar)
        && !path.isAbsolute(avatar);

    if (avatar !== undefined && !isPlausibleAvatar) {
        log.warn(LogClass.NORMAL, 'A generation carried a character avatar header that cannot name a card. It is ignored, and this generation is unscoped.');
    }

    return {
        charName: read('X-ST-Char-Name'),
        chatId: read('X-ST-Chat-Id'),
        // §22. The avatar FILENAME, not an id — resolving it needs the server-owned map, which is a read
        // (and possibly a write) and therefore cannot happen in this synchronous header parse. The caller
        // resolves it; see `resolveIdentityIds`.
        charAvatar: isPlausibleAvatar ? avatar : undefined,
        // §22.7: already a stable id on arrival, so it passes straight through with no map behind it.
        personaId: read('X-ST-Persona-Id'),
        // §18: a generation type is a short ASCII token, so it fits the channel that cannot leak. Verbatim,
        // never bucketed into a `quiet` boolean — deciding which generations a plugin should care about is
        // policy, and collapsing `continue` and `impersonate` together leaves a plugin that needed to tell
        // them apart no way back. Absent means an ordinary user-facing generation, which is what the world
        // looked like before this existed.
        genType: read('X-ST-Gen-Type'),
        // §24: the SHAPE of the prompt — how long each part the browser assembled is, and nothing else.
        // Not for plugins to act on: it exists so the cache-geometry diagnostic can say which region a
        // divergence landed in (`prompt-cache-geometry.js`), and it is the only header here that is read
        // back out into a log line, which is why it is validated to a numbers-only grammar rather than
        // merely decoded. Anything else is dropped, so a client cannot write prose into st.log.
        promptShape: readPromptShapeHeader(request),
    };
}

/**
 * The prompt-shape header, or undefined unless it is exactly what it claims to be.
 *
 * 🔴 THIS ONE IS VALIDATED HARDER THAN THE REST BECAUSE IT IS LOGGED AS NON-SENSITIVE. The other identity
 * headers reach plugins and the prompt record; this reaches `st.log` on an install running with debugMode
 * off, where the whole point is that nothing user-derived is written. A grammar of `name=number` pairs is
 * checkable in one expression, so it is checked here rather than trusted downstream.
 * @param {import('express').Request} request The generation request
 * @returns {string|undefined} The header value, or undefined when absent or malformed
 */
function readPromptShapeHeader(request) {
    const value = request.get('X-ST-Prompt-Shape');

    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROMPT_SHAPE_LENGTH) {
        return undefined;
    }

    return /^v1(;[a-z]{1,12}=\d{1,12})+$/.test(value) ? value : undefined;
}

/**
 * Ceiling on the shape header. The shape is eleven fields of at most a few digits each; this is several
 * times that and far below Node's header cap, so a client cannot turn the diagnostic into a log flood.
 * @type {number}
 */
const MAX_PROMPT_SHAPE_LENGTH = 512;

/**
 * Is this a turn the client normalized, rather than something else entirely?
 * @param {any} turn A candidate element
 * @returns {boolean} True if it carries the whole contract
 */
function isWellFormedTurn(turn) {
    return !!turn
        && typeof turn === 'object'
        && !Array.isArray(turn)
        && (turn.role === 'user' || turn.role === 'assistant' || turn.role === 'system')
        && typeof turn.content === 'string'
        && Number.isInteger(turn.index)
        && (turn.name === undefined || typeof turn.name === 'string')
        // §22.8.2: the per-turn avatar filename, which the server swaps for a `charId` before any plugin sees
        // it. Optional, because an older client sends none and a user turn has none.
        && (turn.avatar === undefined || typeof turn.avatar === 'string')
        // API v7: the message's raw `send_date`, which the server parses into `sendDate`. Optional — an older
        // client sends none, and a message may simply have no time. Anything but a string or number is a
        // client bug, and a window with one in it is dropped whole like any other malformed turn.
        && (turn.send_date === undefined || typeof turn.send_date === 'string' || typeof turn.send_date === 'number')
        // §27: the depth anchor. Optional for the same reason — an older client sends none, and the chat path
        // has no rendered string to offset into. `-1` is the client's own "not found" and is legal; anything
        // else negative, or fractional, is not, and a malformed window is dropped WHOLE rather than in part.
        && (turn.promptOffset === undefined || (Number.isInteger(turn.promptOffset) && turn.promptOffset >= -1));
}

/**
 * Take the structured turns off the request body — and REMOVE THEM FROM IT.
 *
 * 🔴 THE DELETE IS THE WHOLE SAFETY PROPERTY, AND IT IS UNCONDITIONAL. `text-completions.js` serialises
 * `request.body` to the backend verbatim, so a window left on the body is the user's entire recent
 * conversation, structured, posted to the model host as an unrecognised field. It is deleted here whether or
 * not any plugin is listening, because "nobody registered" must not be the difference between stripped and
 * leaked. Call this ABOVE the `hasPromptInterceptors()` gate, always.
 *
 * The turns are projected onto exactly `{role, name, content, index}` rather than passed through. That is not
 * a second normalizer — the client already normalized (§17.5) — it is a projection, so ST's internal `mes`
 * and `is_user` cannot reach a plugin no matter what a client sends. A malformed window is dropped whole and
 * logged: `undefined` means "unknown", which is the honest answer and the one §17.6 made fail-safe. Half a
 * window silently is the failure mode this whole document designs against.
 * @param {import('express').Request} request The generation request
 * @returns {RecentMessage[]|undefined} The turns, or undefined if the client sent none
 */
export function takeRecentMessages(request) {
    const body = request?.body;
    if (!body || typeof body !== 'object' || !(RECENT_MESSAGES_FIELD in body)) {
        return undefined;
    }

    const raw = body[RECENT_MESSAGES_FIELD];
    delete body[RECENT_MESSAGES_FIELD];

    if (!Array.isArray(raw)) {
        log.error(LogClass.NORMAL, `A generation carried '${RECENT_MESSAGES_FIELD}' that was not an array (${typeof raw}). No recent messages will be offered to plugins for it.`);
        return undefined;
    }

    if (!raw.every(isWellFormedTurn)) {
        log.error(LogClass.NORMAL, `A generation carried a malformed '${RECENT_MESSAGES_FIELD}'. The whole window is dropped rather than passed on in part.`);
        return undefined;
    }

    // ⚠️ `avatar` IS CARRIED HERE AND IS NOT PART OF THE PLUGIN CONTRACT. It is a fork-internal key that
    // `runPromptInterceptors` trades for a `charId` and then deletes (§22.8.2). It survives this projection
    // only so the resolution has something to resolve; a plugin must never see an avatar filename, for the
    // same §17.5 reason `mes` and `is_user` do not appear above.
    return raw.map(({ role, name, content, index, avatar, send_date, promptOffset }) => {
        const turn = name === undefined ? { role, content, index } : { role, name, content, index };
        // ⚠️ `promptOffset` IS PART OF THE CONTRACT AND `avatar` IS NOT, which is why they are added the same
        // way and only one of them is removed again downstream. A projection that forgot this line would
        // strip the anchor silently: the client would compute it correctly, the wire would carry it, and the
        // plugin would receive a window with no offsets and no way to tell that from an old client.
        const anchored = promptOffset === undefined ? turn : { ...turn, promptOffset };
        // `send_date` is carried for the same reason `avatar` is: `finishTurn` replaces it with the parsed
        // `sendDate` and it never reaches a plugin in raw form.
        const dated = send_date === undefined ? anchored : { ...anchored, send_date };
        return avatar === undefined ? dated : { ...dated, avatar };
    });
}

/**
 * Turn a projected turn into exactly what a plugin receives: fork-internal keys out, resolved fields in.
 *
 * 🔴 THE ONE PLACE A TURN IS FINISHED, FOR BOTH PATHS. The generation window (`resolveIdentity`, below) and
 * `context.readChat` (`plugin-read-chat.js`) both end here, so `charId` and `sendDate` cannot mean slightly
 * different things depending on how a turn arrived. Mnemosyne compares turns across the two paths — a rescan
 * checks what it finds against what live ingest already stored — and a field that differed between them would
 * make that comparison fail without any error.
 * @param {object} turn A turn as `buildRecentMessages` produced it, possibly carrying `avatar` and `send_date`
 * @param {string|null|undefined} charId The id resolved for the turn's avatar, if any
 * @returns {RecentMessage} The plugin-facing turn
 */
export function finishTurn(turn, charId) {
    const { send_date: rawSendDate, ...rest } = turn;
    delete rest.avatar;
    return { ...rest, charId: charId ?? null, sendDate: parseSendDate(rawSendDate) };
}

/**
 * Log how many turns held a time the fork could not read, once per batch rather than once per turn.
 *
 * ⚠️ A COUNT, NOT THE VALUES, ON THE NORMAL CHANNEL. A `send_date` is fork-written metadata rather than chat
 * text, but it is still a fact about when a private conversation happened; the raw values go to SENSITIVE.
 * @param {object[]} turns Turns still carrying their raw `send_date`
 * @param {string} where Which path read them, for the log line
 * @returns {void}
 */
export function logUnrecognizedSendDates(turns, where) {
    const raws = turns.map(turn => turn.send_date);
    const count = countUnrecognized(raws);

    if (count === 0) {
        return;
    }

    log.warn(LogClass.NORMAL, `${where}: ${count} of ${turns.length} turns carry a send time in a format the fork does not recognize, so their sendDate is null. This is a fork bug; the formats are in src/message-time.js.`);
    log.warn(LogClass.SENSITIVE, `${where}: the unrecognized send times were:`, raws.filter(raw => raw !== undefined && raw !== null && raw !== '' && parseSendDate(raw) === null));
}

/**
 * Turn the avatar filenames the client sent into the stable ids a plugin scopes on (§22, §22.8.2).
 *
 * 🔴 THE ONE PLACE THIS HAPPENS, AND THE ONLY PLACE `avatar` EXISTS. The client cannot do it — the map is
 * server-owned, and a client holding a copy would be a second authority on identity. The endpoints cannot
 * sensibly do it either, because there are two of them and the rule would then have two homes. So it happens
 * here, immediately before the turns are handed out, and both `charAvatar` and every per-turn `avatar` are
 * stripped on the way past: an avatar filename is fork internals and never part of the plugin contract.
 *
 * ⚠️ MINT FIRST, THEN RESOLVE THE WINDOW. A character generating for the first time is minted by the call
 * below, and the window that follows may contain turns they have already spoken. Resolving the window first
 * would hand back `null` for the very character this generation is for.
 *
 * 🔴 AN UNREADABLE MAP DEGRADES; IT DOES NOT FAIL THE GENERATION. A locked vault is a normal state, and a
 * user who wants to chat without memory must not be stopped by it. Resolving to `null` here is SAFE for the
 * same reason `null` is the contract: it means "unknown", and a plugin skips it. What must never happen — a
 * fresh UUID minted over one that already exists — cannot, because the read threw before any write.
 * ⚠️ THE USER ROOT IS PASSED IN, NOT LOOKED UP. Resolving it here would mean importing `users.js`, which
 * reaches `secrets.js` and reads config AT MODULE SCOPE — a `process.exit(1)` when no config path is set,
 * which is every unit test that imports this file. The endpoints already hold `request.user.directories.root`,
 * so the dependency stays where it already exists and this module stays testable without a server.
 * @param {OutgoingPrompt & {charAvatar?: string, userRoot?: string}} outgoing What is about to be sent
 * @returns {Promise<OutgoingPrompt>} The same thing, with ids resolved and avatar keys removed
 */
async function resolveIdentity(outgoing) {
    const { charAvatar, userRoot: root, ...rest } = /** @type {any} */ (outgoing);
    const window = Array.isArray(rest.recentMessages) ? rest.recentMessages : undefined;

    if (window) {
        logUnrecognizedSendDates(window, 'A generation\'s recent messages');
    }

    /** Strip every fork-internal key and give every turn an explicit `charId` and `sendDate`, resolved or not. */
    const withTurnIds = (ids) => window?.map((turn, i) => finishTurn(turn, ids?.[i]));

    if (!root) {
        return { ...rest, charId: null, personaId: rest.personaId ?? null, recentMessages: withTurnIds(null) };
    }

    try {
        const charId = await getOrMintCharacterId(root, charAvatar);
        const turnIds = window ? await lookupCharacterIds(root, window.map(turn => turn.avatar)) : null;

        return { ...rest, charId, personaId: rest.personaId ?? null, recentMessages: withTurnIds(turnIds) };
    } catch (error) {
        // Named loudly, because the symptom otherwise is a memory plugin that quietly attributes everything to
        // nobody and a user who reports that "memory stopped working" with nothing in the log to explain it.
        log.error(LogClass.NORMAL, 'Character ids could not be read, so this generation carries none. A memory plugin will treat it as unscoped.');
        log.error(LogClass.SENSITIVE, 'Character ids could not be read, so this generation carries none. A memory plugin will treat it as unscoped.', error);
        return { ...rest, charId: null, personaId: rest.personaId ?? null, recentMessages: withTurnIds(null) };
    }
}

/**
 * Show every interceptor what is about to be sent, and return what they made of it.
 *
 * 🔴 THE RETURN SHAPE IS CHECKED, AND A WRONG ONE IS REFUSED. A handler that is handed `messages` and hands
 * back a string has misunderstood which backend it is on; taking it at its word would put a string where the
 * vendor converters expect an array and produce a failure a very long way from its cause. The prompt is left
 * alone and the plugin is named.
 * @param {OutgoingPrompt} outgoing What is about to be sent, with `recentMessages` as the FULL window
 * @returns {Promise<OutgoingPrompt>} What to send instead
 */
export async function runPromptInterceptors(outgoing) {
    if (interceptors.length === 0) {
        // ⚠️ AND THEREFORE NOTHING IS MINTED ON A STOCK INSTALL. Identity is resolved below this line, so a
        // SillyTavern with no server plugins never creates `character-ids.json`. That is deliberate: the map
        // exists to serve a consumer, and a fork that writes a UUID for every card the user ever opens —
        // for nobody — is a fork that changed behaviour to no purpose.
        return outgoing;
    }

    const resolved = await resolveIdentity(outgoing);

    // 🔴 THE WINDOW IS HELD ASIDE, NOT CARRIED ON `current`. It is read-only (§17.3), and every handler must
    // see the SAME turns sliced to its OWN declaration — so it is re-attached per handler below rather than
    // threaded through the chain where one plugin's slice would become the next plugin's input.
    const { recentMessages: window, ...outgoingWithoutWindow } = resolved;
    const wantsMessages = Array.isArray(outgoing.messages);
    let current = outgoingWithoutWindow;

    // 🔴 WHO ACTUALLY CHANGED IT, WHICH IS NOT THE SAME AS WHO RAN. `prompt-record.js` reports the outgoing
    // prompt back to the client, and the single most useful thing it can say is whether what left the server
    // is what the browser built. "An interceptor was registered" does not answer that — a plugin that
    // declined, or returned the string unaltered, changed nothing and must not be named as though it had.
    //
    // ⚠️ TRACKED IN A LOCAL, NOT ON `current`. Everything on `current` is spread into `scoped` and handed to
    // the next handler, so a field here would become part of what plugins see and, worse, something they
    // could set.
    /** @type {string[]} */
    const rewrittenBy = [];

    /**
     * Where each rewriting plugin's change actually begins, so a consumer never has to infer it.
     * @type {Array<{id: string, atChar: number, delta: number}>}
     */
    const rewriteSites = [];

    for (const { id, handler, recentMessages } of interceptors) {
        try {
            // Hand out a copy. A handler that mutates its argument in place instead of returning must not
            // silently reshape what the NEXT handler sees.
            //
            // 🔴 AND THE COPY HAS TO REACH `messages`, WHICH IS THE ONE THAT MATTERS. A spread copies the
            // top-level keys and nothing else, so `scoped.messages` WAS `request.body.messages` — the live
            // array the caller assigns back and hands to the vendor converters. A plugin written the way
            // the client-side `runGenerationInterceptors` teaches (mutate `messages` in place, return
            // nothing) therefore rewrote the prompt while DECLINING to, which is the exact opposite of what
            // the two lines above promise. The turn objects go too: a handler that edits `turn.mes` would
            // otherwise reach through the slice into the window every later handler still has to read.
            const scoped = { ...current };

            // ⚠️ AND THE COPY HAS TO REACH `content`, WHICH ON THE CHAT PATH IS OFTEN AN ARRAY. A per-message
            // spread is shallow, so for a multi-part or image turn — `content: [{type, text}, …]` — the parts
            // are the SAME objects. A plugin written the way the client's `runGenerationInterceptors` teaches
            // (mutate in place, return nothing) does `msg.content[0].text = …`, this loop records a DECLINE,
            // and the caller assigns the mutated array back regardless: the prompt is rewritten by a handler
            // that declined to rewrite it, which is precisely what the note above says the copy prevents. It
            // held for `content: 'a string'` and not for the array form.
            if (Array.isArray(current.messages)) {
                scoped.messages = current.messages.map((message) => {
                    if (!message || typeof message !== 'object') {
                        return message;
                    }

                    const copy = { ...message };

                    if (Array.isArray(copy.content)) {
                        copy.content = copy.content.map(part => (part && typeof part === 'object' ? { ...part } : part));
                    }

                    return copy;
                });
            }

            // Exactly what this plugin declared, and nothing more. A plugin asking for 5 must never receive
            // the 20 another plugin asked for, or its number was decorative and its budgeting a fiction.
            // The turns are copied for the same reason `messages` is: the slice is a new array holding the
            // SAME objects, so one handler editing a turn would edit it for every handler after it.
            if (recentMessages !== undefined && Array.isArray(window)) {
                scoped.recentMessages = window.slice(-recentMessages).map(turn => ({ ...turn }));
            }

            // 🔴 ON A CLOCK, AND EXPIRY IS FATAL TO THIS GENERATION — see the `catch` below. Without a
            // deadline a handler that never settles holds the user's generation open for ever: the client's
            // abort ends its own fetch, but this loop keeps awaiting, holding the request and its socket,
            // with no error and no log line, because the catch below only sees REJECTIONS and a wedge is not
            // one. Mnemosyne's handler does a vector query and may call `context.generate()` inside it, so
            // "the embedding model stalled" is an ordinary way to get here.
            const result = await withDeadline(
                handler(scoped),
                getPluginTimeoutMs('plugins.hookTimeoutMs', 60000),
                `Plugin '${id}' did not return from its prompt interceptor`,
            );

            // Declining is normal and silent: a plugin that only understands one backend family says so by
            // returning nothing when it sees the other.
            if (result === undefined || result === null) {
                continue;
            }

            if (wantsMessages) {
                if (!Array.isArray(result)) {
                    throw new PluginContributionError(`Generation interceptor from plugin '${id}' was given messages[] and returned ${typeof result}.`);
                }

                // 🔴 THE ELEMENTS ARE CHECKED TOO, OR THE SHAPE CHECK ONLY HALF-EXISTS. `Array.isArray`
                // alone lets `[{role:'system'}]`, `['text']` and `[null]` straight through to
                // `request.body.messages` and from there into `convertClaudeMessages` and friends, which
                // index `.role`, `.content` and `.parts` — producing either an opaque 400 from the vendor
                // or a TypeError hundreds of lines from the plugin that caused it. That is precisely the
                // "failure a very long way from its cause" the docblock above says this refuses.
                // SillyTavern serializes assistant tool-call turns without `content` (see `openai.js:getChat`).
                // Accept either content or tool calls so valid turns pass this shape check.
                const wellFormed = message => message !== null && typeof message === 'object' && typeof message.role === 'string'
                    && (message.content !== undefined || Array.isArray(message.tool_calls));
                if (!result.every(wellFormed)) {
                    throw new PluginContributionError(`Generation interceptor from plugin '${id}' returned an array whose elements are not well-formed messages.`);
                }

                // ⚠️ COMPARED BY VALUE, NOT BY IDENTITY. A handler that copies the array, edits nothing and
                // returns it is the shape the client-side interceptor API teaches, and identity comparison
                // would report every one of those as a rewrite — turning `rewrittenBy` into a list of who
                // ran, which is the thing the note above says it must not be.
                if (JSON.stringify(result) !== JSON.stringify(current.messages)) {
                    rewrittenBy.push(id);
                }

                current = { ...current, messages: result };
                continue;
            }

            if (typeof result !== 'string') {
                throw new PluginContributionError(`Generation interceptor from plugin '${id}' was given a prompt string and returned ${typeof result}.`);
            }

            if (result !== current.prompt) {
                rewrittenBy.push(id);

                // 🔴 WHERE IT CHANGED, NOT JUST THAT IT DID. A consumer showing "modified by <plugin>" with
                // no position has to guess, and the obvious guess — the plugin's configured depth — is a
                // setting rather than an observation: it says where the plugin MEANT to write, not where the
                // text actually landed. The §27 depth anchor degrades to prepending whenever it cannot place
                // itself, silently, so the configured depth and the real one disagree in exactly the case
                // worth reporting.
                //
                // Both strings are in hand here and nowhere else, so this is the only place the answer
                // exists. `atChar` is where this handler's edit begins; `delta` is how much longer it made
                // the prompt (negative if it removed text).
                rewriteSites.push({ id, atChar: commonPrefixLength(current.prompt ?? '', result), delta: result.length - (current.prompt?.length ?? 0) });
            }

            current = { ...current, prompt: result };
        } catch (error) {
            // 🔴 A PLUGIN THAT TRIED AND FAILED REFUSES THE GENERATION. IT DOES NOT GET SKIPPED.
            //
            // This loop used to log the failure and send the prompt anyway, on the reasoning that one
            // plugin's bug must not cost the user their chat. But look at what the user actually gets: the
            // client already sent a complete, valid prompt, so the generation SUCCEEDS — the model answers,
            // the reply looks entirely ordinary, and the only thing missing is the memory this plugin was
            // supposed to inject. Nothing downstream can tell. That is word for word the failure §6.5 of
            // DESIGN_MEMORY_PLUGIN_API.md says to design against ("the user sees a model with no memory and
            // no error anywhere. Prefer a loud failure to a quiet one") — and it is identical to what a
            // WEDGE produces, so the two cannot sensibly have opposite answers.
            //
            // Every route calling this turns the throw into a 500, which is a failure the user can see and
            // report. The plugin's author has to fix it, and a silent skip is how that never happens.
            //
            // ⚠️ DECLINING IS NOT FAILING, and is handled above, before any of this: a plugin that returns
            // nothing has said "not my backend", which is the documented way for a chat-only plugin to sit
            // out a text generation. That still continues, silently, exactly as before.
            if (error instanceof PluginDeadlineError) {
                log.error(LogClass.NORMAL, `Generation interceptor from plugin '${id}' did not return within the configured timeout. This generation is refused rather than sent without it. Fix the plugin, or raise 'plugins.hookTimeoutMs' in config.yaml.`);
                throw error;
            }

            log.error(LogClass.NORMAL, `Generation interceptor from plugin '${id}' failed. This generation is refused rather than sent without what the plugin was going to add.`);
            log.error(LogClass.SENSITIVE, `Generation interceptor from plugin '${id}' failed:`, error);
            throw error;
        }
    }

    // ⚠️ ATTACHED HERE AND NOWHERE EARLIER. The callers assign `intercepted.prompt` (or `.messages`) onto
    // `request.body` field by field and never spread this object, so an extra key cannot reach the wire. That
    // is a property of every call site, and it is the reason this is safe rather than a convention.
    return { ...current, [REWRITTEN_BY]: rewrittenBy, [REWRITE_SITES]: rewriteSites };
}

/**
 * How many leading characters two strings share.
 *
 * ⚠️ NOT SPLIT ACROSS A SURROGATE PAIR. A boundary landing between the halves of an astral character would
 * report a position that indexes into half a code point — enough to make a caller's slice render as a
 * replacement glyph, and enough to be off by one in a number presented to a human as an exact offset.
 * @param {string} a First string
 * @param {string} b Second string
 * @returns {number} Length of the shared prefix, in UTF-16 code units
 */
function commonPrefixLength(a, b) {
    const limit = Math.min(a.length, b.length);
    let i = 0;

    while (i < limit && a[i] === b[i]) {
        i++;
    }

    if (i > 0 && i < limit) {
        const previous = a.charCodeAt(i - 1);

        if (previous >= 0xD800 && previous <= 0xDBFF) {
            i -= 1;
        }
    }

    return i;
}

/**
 * Where `runPromptInterceptors` reports which plugins actually changed the prompt.
 *
 * 🔴 A SYMBOL SO IT CANNOT BE MISTAKEN FOR PART OF THE PLUGIN CONTRACT. `OutgoingPrompt` is a documented shape
 * that plugin authors write against; a plain `rewrittenBy` string key on the returned object would read as a
 * new field of it, and the next plugin to be written would try to set one. This is fork bookkeeping travelling
 * back to the endpoint that asked, and it is addressed by something no JSON, no spread into a request body and
 * no plugin's object literal can produce by accident.
 */
export const REWRITTEN_BY = Symbol('rewrittenBy');

/**
 * Where `runPromptInterceptors` reports the POSITION of each plugin's change.
 *
 * 🔴 AN OBSERVATION, NOT A SETTING, AND THAT IS THE ENTIRE POINT. A plugin's configured depth says where it
 * MEANT to write. This says where the text landed. The §27 depth anchor degrades to prepending whenever it
 * cannot place itself — silently — so the two disagree in precisely the situation a reader needs to know
 * about, and only one of them is worth printing next to a plugin's name.
 *
 * Each entry is `{ id, atChar, delta }`: the plugin, the character offset where its edit begins, and how much
 * longer it made the prompt. A symbol for the same reason as `REWRITTEN_BY` — it is fork bookkeeping
 * travelling back to the endpoint, not part of the plugin contract.
 */
export const REWRITE_SITES = Symbol('rewriteSites');
