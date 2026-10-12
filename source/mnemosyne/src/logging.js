/**
 * The engine's voice — the seam between Mnemosyne's log lines and the fork's classified writer.
 *
 * `DESIGN.md` §5.6 states the rule this module exists to serve: **never log memory text, and never log
 * conversation text.** That rule is about what we *say*. This module is about whether anyone *hears* it.
 *
 * The fork installs a global console seam before any plugin loads, so our `console.*` calls have always been
 * captured — we were never leaking to stdout and never needed a logger of our own. But the seam cannot know
 * what a third party is printing, so it classifies **everything** it captures `SENSITIVE`, and
 * `logging.debugMode` is `false` on a default install. Every line we emit is therefore replaced before it is
 * written, including the ones that are safe by construction. Fork §23 (`context.logger` / `context.LogClass`)
 * is the way to say *"this line is NORMAL, I vouch for it"* — one call site at a time.
 *
 * ```js
 * normal().info('ingest: done — %d stored, %d superseded, %d duplicates.', s, u, d);
 * sensitive().debug('ingest: that was chat %s for %s.', chatId, handle);
 * ```
 *
 * 🔴 **`NORMAL` is an assertion about the worst possible value of every interpolated argument, not the value
 * you saw while testing.** The question at each call site is not "is this string safe?" but "could this
 * argument ever hold something a user wrote?" If yes for any input the code accepts, it is `SENSITIVE` — and
 * uncertainty resolves to `SENSITIVE`, always. Over-suppression costs a quieter log; under-suppression costs a
 * plaintext conversation on disk. (Fork §23.5.1, reproduced because it is the rule, not a reference.)
 *
 * 🔴 **The mistake this codebase is most exposed to: a handle, a chat id, a character or persona name, and any
 * path under a user directory are ALL user-authored**, however enum-shaped they look. `default-user` is not an
 * enum — a person chose it. A UUID-shaped `chatId` is not a constant — it derives from a chat name they typed.
 * Nearly every line in this plugin carries at least one of these, which is why most call sites here are split
 * in two rather than promoted: a `NORMAL` half carrying counts and durations, and a `SENSITIVE` half carrying
 * the identifiers.
 *
 * ⚠️ **This does not relax §5.6 by one inch.** `SENSITIVE` is not a license to log memory text — it is where
 * identifiers go. Nothing in this plugin logs a memory statement, an extractor payload, or a recalled hit's
 * text through *either* channel, and the mutation-checked suites in `tests/ingest.test.js` and
 * `tests/plugin.test.js` are what keep that true.
 */

/**
 * Whatever a `catch` actually caught.
 *
 * 🔴 **`catch (error)` binds `unknown`, and that is a fact about JavaScript rather than a strictness setting.**
 * `throw 'nope'` and `Promise.reject(null)` are both legal, and half the throws this plugin catches come from
 * the fork or from `context.embed`, which are third parties free to produce either — `retrieval.js` carries a
 * comment about the day `error.message` threw a `TypeError` out of the one function that promised never to
 * throw. Reading a caught value through this shape is what keeps `error?.message` honest: the `?.` is load-
 * bearing and the property is `unknown` because whatever was on the object is whatever was on the object.
 *
 * ⚠️ It is deliberately NOT `Error`. Asserting that would make the checker agree with the assumption that
 * already failed once, which is worse than no annotation.
 *
 * @typedef {{ message?: unknown }} Thrown
 */

import { recordLine } from './log-tape.js';

/**
 * The classification vocabulary used when the fork gave us none — same names and same values as fork
 * `logger.js`, so the fallback shim behaves identically in shape.
 *
 * 🔴 These are the FALLBACK values and they are never handed to the fork. See {@link adoptLogger} for why
 * that distinction is load-bearing rather than fussy.
 */
const FALLBACK_CLASS = Object.freeze({ NORMAL: 0, SENSITIVE: 1 });

/**
 * The console-backed shim, used until (and unless) the fork hands us a classified logger.
 *
 * The class argument is accepted and **deliberately discarded**: on a fork without §23 every `console.*` call
 * is captured `SENSITIVE` regardless of what we would have claimed, and on a fork without the seam at all it
 * goes to stdout exactly as it always did. Either way this is precisely today's behavior, which is the point
 * — adopting §23 must be an improvement where it is available and a no-op where it is not.
 *
 * ⚠️ **The discard is fail-SAFE, and only in that direction.** A `NORMAL` line degrades to a suppressed one:
 * we lose a diagnostic. The reverse — a `SENSITIVE` line escaping because a class was dropped — cannot happen
 * here, because the shim never publishes anything the seam would have withheld.
 *
 * Mapped to match the fork's own seam (`logger.js` `installConsoleSeam`) method for method, so a line lands at
 * the same level whichever path it takes.
 *
 * ⚠️ Typed as a `ForkLogger` rather than as its own shape, because {@link bind} has to accept this and the
 * fork's `context.logger` through the same parameter — the whole point of the fallback is that the two are
 * interchangeable from here down. Declaring it as the fork's interface is what makes a drift between them an
 * error in this file rather than a surprise at the one call site that adopted the real one.
 *
 * @type {ForkLogger}
 */
const CONSOLE_SINK = Object.freeze({
    debug: (/** @type {unknown} */ logClass, /** @type {unknown[]} */ ...args) => console.debug(...args),
    info: (/** @type {unknown} */ logClass, /** @type {unknown[]} */ ...args) => console.log(...args),
    warn: (/** @type {unknown} */ logClass, /** @type {unknown[]} */ ...args) => console.warn(...args),
    error: (/** @type {unknown} */ logClass, /** @type {unknown[]} */ ...args) => console.error(...args),
});

/** Pre-bound `{debug,info,warn,error}` pairs for each class — rebuilt by {@link adoptLogger}. See {@link bind}. */
let normalSink = tee(bind(CONSOLE_SINK, FALLBACK_CLASS.NORMAL));
let sensitiveSink = bind(CONSOLE_SINK, FALLBACK_CLASS.SENSITIVE);

/**
 * One classification's four methods, with the class value already bound onto each.
 *
 * 🔴 **This is what `normal()` and `sensitive()` hand back, and it is deliberately NOT a `ForkLogger`.** The
 * class argument is gone from the signature because {@link bind} has already supplied it — that is the whole
 * point of the split, and a shape that still accepted one would let a call site pass a second, contradicting
 * class into a channel that had already been vouched for.
 *
 * @typedef {{
 *     debug(...args: unknown[]): void,
 *     info(...args: unknown[]): void,
 *     warn(...args: unknown[]): void,
 *     error(...args: unknown[]): void,
 * }} ClassifiedSink
 */

/**
 * Bind one classification onto a sink's four methods, so a call site names a level and not a class twice.
 *
 * 🔴 **`.bind()` rather than a wrapping arrow, and this is the whole reason this module is shaped the way it
 * is.** The fork captures the call site of a suppressed line with `Error.captureStackTrace(holder, log.info)`
 * under `Error.stackTraceLimit = 1` — it keeps exactly ONE frame, the immediate caller of `log.info`. A
 * wrapper function is that caller, so every suppressed line in the plugin would report `logging.js:NN` instead
 * of the site that wrote it, collapsing 36 distinct diagnostics into one useless one. A **bound** function adds
 * no frame in V8, so the real site survives.
 *
 * Verified empirically against the fork's actual `logger.js` before this module was written, not reasoned
 * about: a wrapping arrow reported `wrapper.js:6`; `.bind()` through a getter reported the true `caller3.js:4`.
 *
 * ⚠️ This is also why {@link normal} and {@link sensitive} are getters returning the bound object rather than
 * methods that log. `normal().info(…)` resolves the getter *before* `.info` is invoked, so the stack at the
 * moment of the call is the call site's own. `normal.info(…)` as a wrapper would not be.
 *
 * @param {ForkLogger} sink Either {@link CONSOLE_SINK} or the fork's own `context.logger` — see the ⚠️ there
 * @param {unknown} logClass The class value to bind. 🔴 **Deliberately `unknown` and not `number`.** Ours are
 *        `0`/`1` (see {@link FALLBACK_CLASS}), but the adopted ones are the FORK's `LogClass` values, whatever
 *        it currently spells them as — reading them off the context is the entire leak-prevention argument in
 *        {@link adoptLogger}, and typing this `number` would be this file asserting the one thing that argument
 *        refuses to assume.
 * @returns {ClassifiedSink}
 */
function bind(sink, logClass) {
    return Object.freeze({
        debug: sink.debug.bind(sink, logClass),
        info: sink.info.bind(sink, logClass),
        warn: sink.warn.bind(sink, logClass),
        error: sink.error.bind(sink, logClass),
    });
}

/**
 * Wrap a bound normal sink so every line it publishes is also kept on the in-memory tape.
 *
 * 🔴 **THE NORMAL CHANNEL ONLY, AND THAT IS LOAD-BEARING TWICE OVER.** What makes the tape publishable is that
 * it holds only lines carrying no user-authored value (see `log-tape.js`), and `sensitiveSink` is deliberately
 * never passed through here. It is also what makes the wrapper *free*: the fork captures a line's call site
 * with `Error.captureStackTrace(holder, boundary)` under `stackTraceLimit = 1`, and its own gate for doing so
 * is `logClass !== LogClass.NORMAL && !debugMode` (fork `logger.js:554`). A NORMAL line therefore has no site
 * captured, so the extra frame this wrapper adds is one that nothing reads.
 *
 * ⚠️ **The bind-not-wrap rule in {@link bind} is not being broken, it is being applied.** That rule exists to
 * protect the sites of SUPPRESSED lines, which are exactly the ones this function never touches. The single
 * case where the fork captures a site for a NORMAL line is its pre-`initLogger` buffer (`logger.js:548`), and
 * a plugin cannot be loaded that early — the fork opens its log file in `server.js` long before it loads us.
 *
 * @param {ClassifiedSink} sink The already-bound normal sink
 * @returns {ClassifiedSink}
 */
function tee(sink) {
    /** @param {'debug'|'info'|'warn'|'error'} level @returns {(...args: unknown[]) => void} */
    const teed = (level) => (...args) => {
        recordLine(level, args);
        sink[level](...args);
    };

    return Object.freeze({
        debug: teed('debug'),
        info: teed('info'),
        warn: teed('warn'),
        error: teed('error'),
    });
}

/**
 * Take the fork's classified logger if this fork has one (capability 13, fork §23).
 *
 * 🔴 **GUARDED, like every other capability this plugin consumes.** An unguarded call is a `TypeError` in
 * `init` on any fork predating §23. The guard applies across supported forks, not only a particular deployment.
 * Use the same pattern as the `context.embed` and `context.registerPanel` guards in
 * `index.js`. **Fail-safe direction: when in doubt, fall back.** A suppressed line costs a quieter log; a
 * throw here costs the whole plugin.
 *
 * 🔴 **The class values come from the FORK, never from our own constants, and this is a leak-prevention
 * decision rather than tidiness.** The fork's writer decides suppression with `logClass === LogClass.SENSITIVE`.
 * If it ever renumbered its enum and we kept passing our own `1`, that comparison would go false and every line
 * we had marked `SENSITIVE` would be treated as `NORMAL` and **published** — a plaintext leak caused by a
 * change in a repo we do not control, failing open, silently. Reading the values off the context we were handed
 * cannot drift: whatever the fork means by `SENSITIVE` is what we send.
 *
 * Both members are checked. A fork with one and not the other is not a fork we can classify against, and
 * guessing the missing half is the exact fail-open this guard exists to refuse.
 *
 * @param {ForkContext|null|undefined} context The fork's plugin context. ⚠️ Both `logger` and `LogClass` are
 *        OPTIONAL on it, which is the declaration's way of carrying the fact this function exists for: a fork
 *        predating §23 has neither, and the six checks below are what turn that into a fallback rather than a
 *        `TypeError`.
 *        🔴 **AND THE WHOLE CONTEXT IS NULLABLE, WHICH THE TAG USED TO DENY.** The body opens
 *        `context?.logger`, and that `?.` is the fail-safe that stops `init` throwing on a stock SillyTavern
 *        which calls `init(router)` with no second argument at all. `logging.test.js` passes `undefined` and
 *        `null` deliberately — it is the only thing holding that optional chain in place — so the old
 *        non-nullable tag made the suite's own cases unstatable, and would have justified deleting the `?.`
 *        as dead defensiveness.
 * @returns {boolean} Whether the classified channel was adopted — for the caller's own startup line
 */
export function adoptLogger(context) {
    const logger = context?.logger;
    const classes = context?.LogClass;

    const usable = logger
        && classes
        && typeof logger.info === 'function'
        && typeof logger.warn === 'function'
        && typeof logger.error === 'function'
        && typeof logger.debug === 'function'
        && classes.NORMAL !== undefined
        && classes.SENSITIVE !== undefined;

    if (!usable) {
        return false;
    }

    normalSink = tee(bind(logger, classes.NORMAL));
    sensitiveSink = bind(logger, classes.SENSITIVE);
    return true;
}

/**
 * Put the sinks back to bare `console.*`. For tests, and for nothing else.
 *
 * Module state is process-global by design (the fork's own logger is too), so a suite that adopts a fake
 * logger must be able to put it back or it leaks into every suite that runs after it.
 *
 * @returns {void}
 */
export function resetLogging() {
    normalSink = tee(bind(CONSOLE_SINK, FALLBACK_CLASS.NORMAL));
    sensitiveSink = bind(CONSOLE_SINK, FALLBACK_CLASS.SENSITIVE);
}

/**
 * Lines that carry **no user-authored value at all** — counts, durations, booleans, model names from a fixed
 * list, and string literals. These survive on a default install; they are the whole point of §23.
 *
 * Before using this, re-read the worst-possible-value rule at the top of this file. If the line interpolates a
 * handle, a chat id, a character or persona name, an id derived from any of them, a path, or an `Error`
 * message whose text you do not control — it is not this. Split it.
 *
 * ⚠️ The returned methods take `unknown[]`, which is the truth and not a shrug: `%s`/`%d` formatting accepts
 * anything, so the checker has nothing useful to say about an argument's TYPE here. The rule this module is
 * about — is this value user-authored? — is not one a type can express, and pretending otherwise by narrowing
 * these to `string|number` would read as an enforced guarantee while enforcing nothing.
 *
 * @returns {ClassifiedSink}
 */
export function normal() {
    return normalSink;
}

/**
 * Lines that carry anything user-authored — which in this plugin is most of them, and always the identifiers.
 *
 * These are suppressed on a default install and published to `st_DEBUG.log` when the operator turns
 * `logging.debugMode` on. That is the correct destination for them, not a limitation to work around.
 *
 * @returns {ClassifiedSink}
 */
export function sensitive() {
    return sensitiveSink;
}
