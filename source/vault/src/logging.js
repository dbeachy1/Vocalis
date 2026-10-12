/**
 * The provider's voice — the seam between Vault's log lines and the fork's classified writer.
 *
 * Every `console.*` call in this plugin has always been captured: the fork installs a global console seam
 * before any provider loads. But the seam cannot know what a third party is printing, so it classifies
 * **everything** it captures `SENSITIVE`, and `logging.debugMode` is `false` on a default install — the host
 * included. Every line we emit is therefore replaced with a stub before it is written, including the ones
 * that are safe by construction.
 *
 * That cost us a real alert. When `writeVaultKeys` fails inside `ensureRecoveryKeyIsAcknowledged`, the
 * journal on a default install got exactly this:
 *
 * ```
 * [SENSITIVE suppressed: unknown] [ENOSPC]
 * ```
 *
 * …for the one condition that file's own comment calls *"invisible from the inside"* — an account with no
 * recovery key anybody has ever seen. Nothing was lost; the only signal that it happened was.
 *
 * ⚠️ **`unknown`, not `lifecycle.js:162`** — and the difference is the second half of why this module exists.
 * The fork resolves a suppressed line's origin under `Error.stackTraceLimit = 1`, and for a bare `console.*`
 * the single surviving frame is the console seam's own arrow inside `logger.js`, which its `parseCallSite`
 * skips. So the line was not merely silenced, it was anonymous: no message, no file, no line. Adopting the
 * classified logger is what makes a suppressed line name itself.
 *
 * This module is how a call site says *"this line is NORMAL, I vouch for it"*, one line at a time:
 *
 * ```js
 * normal().error('Could not write a new recovery key for an account. …');
 * sensitive().error('Recovery key write failed for', handle, error);
 * ```
 *
 * 🔴 **`NORMAL` is an assertion about the worst possible value of every interpolated argument, not the value
 * you saw while testing.** The question at a call site is not "is this string safe?" but "could this argument
 * ever hold something a user wrote?" If yes for any input the code accepts, it is `SENSITIVE` — and
 * uncertainty resolves to `SENSITIVE`, always. Over-suppression costs a quieter log. Under-suppression costs
 * plaintext on the disk of an install whose entire premise is that there isn't any.
 *
 * 🔴 **A handle, a chat id, a character or persona name, an error message, and any path under a user
 * directory are ALL user-authored**, however enum-shaped they look. `default-user` is not an enum — a person
 * chose it. An `error.message` from `node:fs` embeds the filesystem path it failed on. This is why the call
 * sites in this plugin are *split* rather than promoted: a `NORMAL` half that says what happened, and a
 * `SENSITIVE` half that carries the identifiers.
 *
 * ⚠️ **`SENSITIVE` is not a licence.** It is where identifiers go, not keys. Nothing in this plugin logs a
 * DEK, a recovery key, a password, or a byte of plaintext user content through *either* channel, and it must
 * stay that way — a `SENSITIVE` line is still written verbatim to `st_DEBUG.log` the moment an operator turns
 * `debugMode` on to diagnose something else.
 */

/**
 * The console-backed channel, used until (and unless) the fork hands us a classified logger. **Both classes
 * resolve to this same object in fallback**, because there is nothing here that could tell them apart.
 *
 * The classification is **deliberately discarded**: on a fork that does not pass a logger into the
 * storage-provider context, every `console.*` call is captured `SENSITIVE` regardless of what we would have
 * claimed, and on a fork with no seam at all it goes to stdout exactly as it always did. Either way this is
 * precisely today's behaviour, which is the point — adopting the channel must be an improvement where it
 * exists and a no-op where it does not.
 *
 * ⚠️ **The discard is fail-SAFE, and only in that direction.** A `NORMAL` line degrades to a suppressed one:
 * we lose a diagnostic. The reverse — a `SENSITIVE` line escaping because its class was dropped — cannot
 * happen here, because this never publishes anything the seam would have withheld.
 *
 * 🔴 **Accessors, not arrow functions, and not eagerly-captured references — for two different reasons, and
 * both of them bite.**
 *
 * *Why not arrows:* an arrow like `(...args) => console.error(...args)` is a wrapper, and a wrapper is a
 * frame. The fork's `captureCallSite` skips frames whose basename is `logger.js` and nothing else, so a
 * wrapper here would make every suppressed line in this plugin resolve to `logging.js:NN` — a confident,
 * wrong attribution. A bare console call resolves to `unknown` on that fork (its own docblock says so, and
 * says it is a deliberate trade), and `unknown` is at least honest. Adding a frame would make it worse than
 * doing nothing, which is not a trade worth making for a fallback path.
 *
 * *Why not `const error = console.error` at module load:* the seam replaces `console.*` during startup. Grab
 * the reference eagerly and, on any load order where we win the race, we would hold the **pre-seam** console
 * and print user data straight to stdout — bypassing the very mechanism this file exists to cooperate with.
 * A getter resolves `console.error` at call time, every time, so whatever is installed then is what we get,
 * and it adds no frame.
 *
 * Mapped to the fork's own seam method for method, so a line lands at the same level whichever path it takes.
 * Note `info` → `console.log`: that is the mapping the seam itself uses.
 */
const CONSOLE_CHANNEL = Object.freeze({
    get debug() { return console.debug; },
    get info() { return console.log; },
    get warn() { return console.warn; },
    get error() { return console.error; },
});

/**
 * Bind one classification onto a sink's four methods, so a call site names a level and not a class twice.
 *
 * 🔴 **`.bind()` rather than a wrapping function, and this is the entire reason this module is shaped the
 * way it is.** The fork captures the origin of a suppressed line with `Error.captureStackTrace(holder,
 * log.info)` under `Error.stackTraceLimit = 1` — it keeps exactly ONE frame, the immediate caller of
 * `log.info`. A wrapper function *is* that caller, so every suppressed line in Vault would report
 * `logging.js:NN` instead of the site that wrote it, collapsing every diagnostic in the plugin into one
 * useless one. The `[SENSITIVE suppressed: lifecycle.js:162]` stub — the only thing an operator gets on a
 * default install — would stop naming `lifecycle.js` at all. A **bound** function adds no frame in V8, so
 * the real site survives.
 *
 * ⚠️ This is also why {@link normal} and {@link sensitive} are accessors returning the bound object rather
 * than functions that log. `normal().error(…)` resolves the call to `normal()` and returns *before* `.error`
 * is invoked, so the stack at the moment of the logging call is the call site's own.
 *
 * @param {{debug: Function, info: Function, warn: Function, error: Function}} sink The logger to bind onto
 * @param {number} logClass The class value to bind — the FORK's when adopted, ours only in fallback
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}} Four pre-bound methods
 */
function bind(sink, logClass) {
    return Object.freeze({
        debug: sink.debug.bind(sink, logClass),
        info: sink.info.bind(sink, logClass),
        warn: sink.warn.bind(sink, logClass),
        error: sink.error.bind(sink, logClass),
    });
}

/** The `{debug,info,warn,error}` channel for each class — replaced by {@link adoptLogger}. */
let normalSink = CONSOLE_CHANNEL;
let sensitiveSink = CONSOLE_CHANNEL;

/**
 * Take the fork's classified logger, if this fork hands one to a storage provider.
 *
 * Forks may omit the classified logger from the provider context. Guard both `logger` and `LogClass` so an
 * unavailable optional channel falls back instead of making provider initialization fail.
 *
 * Use the enum values supplied by the fork. Its writer compares against its own `LogClass.SENSITIVE`; a local
 * numeric constant could drift and expose sensitive messages.
 *
 * ⚠️ **`!== undefined`, not truthiness: `NORMAL` is `0`.** A truthy test rejects a perfectly good logger and
 * silently downgrades the whole plugin to the fallback, which is the failure this module exists to end.
 *
 * Both members are checked. A fork with one and not the other is not a fork we can classify against, and
 * guessing the missing half is the exact fail-open the guard refuses.
 *
 * 🔴 **Never assign back onto `context.logger`.** The fork hands over its live logger singleton, unfrozen.
 * Something like `context.logger.info = context.logger.info.bind(context.logger, NORMAL)` looks like the
 * same idea as this function and is catastrophic: every internal `log.info(LogClass.SENSITIVE, …)` in the
 * whole server then evaluates as `info(NORMAL, SENSITIVE, …)` and **publishes**. We bind into our own
 * module state and leave theirs untouched.
 *
 * @param {any} context The boot context the fork handed the provider
 * @returns {boolean} Whether the classified channel was adopted — for the caller's own startup line
 */
export function adoptLogger(context) {
    const logger = context?.logger;
    const classes = context?.LogClass;

    const usable = !!logger
        && !!classes
        && typeof logger.debug === 'function'
        && typeof logger.info === 'function'
        && typeof logger.warn === 'function'
        && typeof logger.error === 'function'
        && classes.NORMAL !== undefined
        && classes.SENSITIVE !== undefined
        // 🔴 AND THEY MUST DIFFER. The eight clauses above survive the fork RENUMBERING its enum, which is
        // what this guard was written for -- and not the fork COLLAPSING it. Ship `{NORMAL: 0, SENSITIVE: 0}`
        // by typo or by a deprecation shim and every clause passes, `sensitiveSink` binds to the fork's
        // NORMAL value, and the writer's `logClass === LogClass.SENSITIVE` test can no longer tell them
        // apart. Every suppressed line -- handles, absolute paths, whole fs error messages -- is then
        // published to `st.log` on a default install.
        //
        // Failing open, silently, from a change in a repository this project does not control, is precisely
        // the outcome this guard exists to prevent. One clause closes it.
        && classes.NORMAL !== classes.SENSITIVE;

    if (!usable) {
        return false;
    }

    normalSink = bind(logger, classes.NORMAL);
    sensitiveSink = bind(logger, classes.SENSITIVE);
    return true;
}

/**
 * Put the sinks back to bare `console.*`. For tests, and for nothing else.
 *
 * Module state is process-global by design (the fork's own logger is too), so a suite that adopts a fake
 * logger must be able to put it back, or it leaks into every suite that runs after it.
 * @returns {void}
 */
export function resetLogging() {
    normalSink = CONSOLE_CHANNEL;
    sensitiveSink = CONSOLE_CHANNEL;
}

/**
 * Lines that carry **no user-authored value at all** — counts, booleans, string literals, and values from a
 * fixed set the fork itself defines. These survive on a default install; they are the whole point.
 *
 * Before using this, re-read the worst-possible-value rule at the top of this file. If the line interpolates
 * a handle, a path, an `Error` or its message, or anything derived from any of those — it is not this.
 * Split it.
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}} The NORMAL-bound methods
 */
export function normal() {
    return normalSink;
}

/**
 * Lines that carry anything user-authored — which here means the identifiers, and always the `Error`.
 *
 * These are suppressed on a default install and written to `st_DEBUG.log` when the operator turns
 * `logging.debugMode` on. That is the correct destination for them, not a limitation to work around.
 *
 * 💡 Pass the `Error` **object**, not `error.message`. The fork's suppression stub appends the error's
 * `code` to the suppressed line (its `safeErrorCode`), so `sensitive().error('…', handle, error)` still
 * reads `[SENSITIVE suppressed: lifecycle.js:NNN] [ENOSPC]` on a default install — the operator gets the
 * failure *class* for free while the path and the handle stay suppressed. Flattening it to
 * `${error.message}` throws that away, because the stub reads the `code` off an Error object and there is
 * no longer one to read; it also smuggles the failing path into a string that a later edit could promote to
 * `NORMAL` without noticing what is inside it.
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}} The SENSITIVE-bound methods
 */
export function sensitive() {
    return sensitiveSink;
}
