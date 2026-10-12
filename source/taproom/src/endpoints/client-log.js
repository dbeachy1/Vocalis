/**
 * A narrow, default-deny path from browser code into the server's log.
 *
 * Browser-only failures may occur before a request reaches server-owned code, leaving only a transient
 * toast. This route records a bounded, filtered diagnostic that remains available after a page reload.
 *
 * 🔴 AND WHY IT IS SHAPED LIKE A SIEVE AND NOT A PIPE. `DESIGN_LOG_HYGIENE.md` §7 lists the browser
 * console as deliberately out of scope, and the *reason* it is out of scope is that it never reaches
 * disk: "Chrome does not persist console output to disk by default." This route is precisely the
 * thing that sentence assumed did not exist. So it is built so that the §3 invariant — *nothing that
 * is ciphertext at rest may appear as plaintext in a log* — survives its existence:
 *
 *   · The sender does not get to classify. Nothing the client sends is trusted as safe because the
 *     client said so; §4.1 rejects exactly that shape of defence ("a deny-list fails open").
 *   · Numbers and booleans are `NORMAL`. §5.3.1 settled it: "Counts and durations stay NORMAL even
 *     when they measure user content."
 *   · **Every client string is `SENSITIVE`**, with three exceptions, each of which is a registered
 *     or mechanically-bounded identifier rather than free text — see SOURCES, EVENT_PATTERN and
 *     CODE_PATTERN below. A character name is in scope per §3, and "Seraphina" is a perfectly
 *     ordinary-looking word; that is why no general "it looks like an enum" promotion exists here.
 *   · Both lines are always emitted, so the `NORMAL` one is never a bare suppression stub — §5.3.1:
 *     "At ERROR, a split is always required: no error line may be suppressed in its entirety."
 *
 * The consequence, stated plainly so nobody is surprised by it: with debug mode off, the log says
 * *which* failure fired, with its numbers. The verbatim provider message rides the `SENSITIVE` line
 * and reaches disk only in `st_DEBUG.log`. That is the design working, not a gap in it.
 *
 * ⚠️ AND IT CAN FILL A LOG. A browser loop posting failures is a log-rotation event, which destroys
 * history — the opposite of what this was built for. Hence the per-source budget below.
 */

import express from 'express';

import { log, LogClass } from '../logger.js';

export const router = express.Router();

/**
 * 🔴 THE ALLOWLIST IS WHAT MAKES THE SOURCE NAME SAFE TO PRINT UNSUPPRESSED. A slug the client
 * invents is still a client string; a slug that has to match one of these is effectively a
 * server-side constant that the client merely selects. That is the same reasoning §5.3.1 uses to
 * make plugin IDs `NORMAL` — *which component failed* is the entire operator value of the line —
 * except that here the set is closed, so it is a stronger claim, not a weaker one.
 *
 * Adding a source is a deliberate edit to this file by someone who has read the note above it.
 */
const SOURCES = Object.freeze(['vocalis-polish']);

/**
 * Lower-case and underscores only, so the event cannot carry prose. A chat title, a character name
 * or a sentence of dialogue does not survive this pattern: no spaces, no capitals, no punctuation.
 * Paired with a registered source, that is enough to print it.
 */
const EVENT_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** Same argument as EVENT_PATTERN. This is the failure code — `generate`, `no_text`, `macros`. */
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** Field names are identifiers, not data. Anything else is dropped rather than logged. */
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Per-string ceiling. A provider error is a sentence or a small JSON body; this is generous. */
const MAX_STRING = 2000;

/** Per-report ceiling on how many fields are considered at all. */
const MAX_FIELDS = 40;

/**
 * The budget, and why it is per source rather than per user: a runaway extension is one piece of
 * code misbehaving, and holding every account that happens to be running it to one shared budget is
 * what stops the flood. `WINDOW_MS` is deliberately long enough that a burst of real failures — a
 * provider outage across several tabs — still lands whole.
 */
const BUDGET = 30;
const WINDOW_MS = 60_000;

/** @type {Map<string, {count:number, windowStart:number, suppressed:number}>} */
const budgets = new Map();

/**
 * Consume one unit of a source's budget.
 * @param {string} source Registered source name
 * @param {number} now Milliseconds since the epoch
 * @returns {{allowed:boolean, justExceeded:boolean, suppressed:number}} Whether to log it
 */
function spendBudget(source, now) {
    const state = budgets.get(source) || { count: 0, windowStart: now, suppressed: 0 };
    if (now - state.windowStart >= WINDOW_MS) {
        // A window that expired while over budget owes the operator one line saying how much it ate.
        const suppressed = state.suppressed;
        state.count = 0;
        state.windowStart = now;
        state.suppressed = 0;
        budgets.set(source, state);
        if (suppressed > 0) {
            log.warn(LogClass.NORMAL, `[client-log] ${source} dropped ${suppressed} report(s) over its ${BUDGET}/minute budget`);
        }
    }
    state.count += 1;
    budgets.set(source, state);
    if (state.count <= BUDGET) {
        return { allowed: true, justExceeded: false, suppressed: state.suppressed };
    }
    state.suppressed += 1;
    return { allowed: false, justExceeded: state.suppressed === 1, suppressed: state.suppressed };
}

/** Exposed so a test can drive the budget without waiting a minute of wall clock. @returns {void} */
export function resetClientLogBudgets() {
    budgets.clear();
}

/**
 * Split one report's fields into the two classes, by the type of the value and nothing else.
 * @param {unknown} fields Whatever the client sent as `fields`
 * @returns {{safe:string[], held:string[]}} Rendered `key=value` fragments per class
 */
function classifyFields(fields) {
    /** @type {string[]} */
    const safe = [];
    /** @type {string[]} */
    const held = [];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        return { safe, held };
    }
    for (const [key, value] of Object.entries(fields).slice(0, MAX_FIELDS)) {
        if (!FIELD_PATTERN.test(key)) {
            continue;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            safe.push(`${key}=${value}`);
            continue;
        }
        if (typeof value === 'boolean') {
            safe.push(`${key}=${value}`);
            continue;
        }
        if (typeof value === 'string' && value.length > 0) {
            // Newlines would forge log records, so the report arrives as one line per field.
            held.push(`${key}=${value.slice(0, MAX_STRING).replace(/[\r\n]+/g, ' ⏎ ')}`);
        }
    }
    return { safe, held };
}

/**
 * Record one browser-side failure.
 *
 * Always answers 204 on a well-formed report, including one the budget dropped: the sender is
 * reporting a failure it has already handled, and a second failure on the reporting path is not
 * something a user can act on. Malformed bodies still get a 400, because that is a bug in the
 * sender and it should be visible to whoever is writing it.
 */
router.post('/', (request, response) => {
    const body = request.body || {};
    const source = String(body.source ?? '');
    const event = String(body.event ?? '');
    const code = body.code == null ? '' : String(body.code);

    if (!SOURCES.includes(source) || !EVENT_PATTERN.test(event) || (code && !CODE_PATTERN.test(code))) {
        return response.status(400).send({ error: 'unrecognized source, event or code' });
    }

    const budget = spendBudget(source, Date.now());
    if (!budget.allowed) {
        if (budget.justExceeded) {
            log.warn(LogClass.NORMAL, `[client-log] ${source} exceeded its ${BUDGET}/minute budget; further reports this minute are dropped`);
        }
        return response.sendStatus(204);
    }

    const { safe, held } = classifyFields(body.fields);
    const label = `[client-log] ${source} ${event}${code ? ` code=${code}` : ''}`;

    // Two calls, in this order, every time. The first is what an operator sees with debug mode off,
    // and it is why this route does not merely produce a suppression stub.
    log.error(LogClass.NORMAL, safe.length ? `${label} ${safe.join(' ')}` : label);
    log.error(LogClass.SENSITIVE, `${label} detail:`, held.length ? held.join(' | ') : '(no detail supplied)');

    return response.sendStatus(204);
});
