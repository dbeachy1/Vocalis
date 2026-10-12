/**
 * The log writer. Fork-only module.
 *
 * This module is the only thing in the codebase permitted to write to the log file, and after the
 * codemod (design §5.1) it is the only thing permitted to call `console.*` at all. Its job is to
 * enforce one invariant:
 *
 *   > Nothing that is ciphertext at rest may appear as plaintext in a log.
 *
 * It does that by classification, not by redaction — every call site names its own class, and
 * anything classified `SENSITIVE` is dropped unless the operator has explicitly turned debug mode
 * on. Deny-lists were considered and rejected (design §4.1): they fail open, they cannot see
 * string interpolation, and they cannot be proven.
 *
 * Imports are restricted to node builtins and dependency-free fork modules on purpose. This module
 * is imported at the very top of `server.js`, before config exists, so anything it pulls in would
 * be hoisted into the earliest moment of startup.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { formatWithOptions } from 'node:util';

import { LOG_LEVELS } from './constants.js';

/**
 * Whether a log call may carry user-derived data.
 *
 * The class is a property of the *call*, not of an individual argument. A line that mixes safe
 * prose with a user string is split into two calls — see design §4.3.
 *
 * @typedef {typeof LogClass[keyof typeof LogClass]} LogClassValue
 */
export const LogClass = Object.freeze({
    /** Contains no user-derived data. Always written. */
    NORMAL: 0,
    /** May contain user-derived data. Written only when debug mode is on. */
    SENSITIVE: 1,
});

/** Level -> display tag, for the file prefix. */
const LEVEL_TAGS = Object.freeze({
    [LOG_LEVELS.DEBUG]: 'DEBUG',
    [LOG_LEVELS.INFO]: 'INFO',
    [LOG_LEVELS.WARN]: 'WARN',
    [LOG_LEVELS.ERROR]: 'ERROR',
});

/**
 * Upper bound on lines held before the file handle opens. Startup logging is a few dozen lines; a
 * cap this size is never reached in practice and exists so that a failure to ever call
 * `initLogger` degrades into dropped lines rather than unbounded memory growth.
 */
const MAX_BUFFERED_RECORDS = 10000;

/**
 * How many stack frames to collect when one is not enough — for ERROR records, and on any runtime
 * without `Error.captureStackTrace` to elide by function reference. Ten is what was measured to reach
 * a bare `console.error`'s real caller past the console seam's own frame. See {@link captureCallSite}
 * for why this is not the default.
 */
const DEEP_STACK_FRAMES = 10;

/** Matches ANSI SGR sequences, so colourised strings do not put escape codes in the file. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B\[[0-9;]*m/g;

/**
 * A log call captured before the writer was ready.
 * @typedef {object} BufferedRecord
 * @property {Date} timestamp When the call happened, not when it was flushed.
 * @property {number} level One of `LOG_LEVELS`.
 * @property {LogClassValue} logClass Classification supplied by the call site.
 * @property {any[]} args Raw arguments, formatted lazily at flush time.
 * @property {string} site `file.js:line` of the caller, for the suppression stub.
 */

/** @type {BufferedRecord[]} */
let buffer = [];
let droppedFromBuffer = 0;

/** @type {number|null} Open file descriptor, or null while buffering. */
let fileDescriptor = null;
/** @type {string} Absolute path of the file `fileDescriptor` refers to. */
let filePath = '';
/** @type {number} Bytes written to the current file, seeded from its size at startup (§4.4). */
let bytesWritten = 0;

let initialized = false;
let debugMode = false;
let minLogLevel = LOG_LEVELS.DEBUG;
let maxSizeBytes = 10 * 1024 * 1024;
let maxArchives = 20;
/** @type {boolean} Whether file timestamps are UTC. Default is the machine's local zone (§4.7). */
let useUtc = false;

/** Guards against a write failure looping back into the logger. */
let writeFailed = false;

/**
 * Strips ANSI colour codes. The terminal echo keeps them; the file does not.
 * @param {string} text Text to strip
 * @returns {string} Text with SGR sequences removed
 */
function stripAnsi(text) {
    return text.replace(ANSI_PATTERN, '');
}

/**
 * Resolves the caller's `file.js:line`, skipping frames inside this module.
 *
 * Only ever called when a line is actually being suppressed or buffered, so the cost is not paid
 * on lines that get written in full.
 *
 * ⚠️ A BARE `console.*` BELOW ERROR LEVEL RESOLVES TO `unknown`, AND THAT IS A DELIBERATE TRADE RATHER
 * THAN A BUG. Under `stackTraceLimit = 1` exactly one frame survives, and for a console call that frame
 * is `installConsoleSeam`'s own arrow below — which `parseCallSite` skips as a `logger.js` frame. The real
 * caller was never captured. Raising the limit to 10 does fix it (measured), but this function runs for
 * EVERY suppressed line on a default install, which is the whole of a plugin's and every library's output,
 * so it would put ten frames of stack collection on a hot path. A plugin that wants its sites named should
 * adopt `context.logger` (§23.5.2), which reports them exactly and costs nothing extra. `tests/logger.test.js`
 * pins all of this — including that a WRAPPER around the logger collapses every site onto itself, while
 * `.bind()` is transparent.
 *
 * 🔴 ERRORS ARE THE EXCEPTION, AND THEY PAY FOR THE DEEPER STACK. The trade above is priced on volume:
 * DEBUG and INFO are the hot path, so one frame is right for them. Errors are not — they are rare by
 * nature, and they are the one case where the site is the whole value of the line. A real install
 * produced five consecutive `[ERROR] [SENSITIVE suppressed: unknown]` entries, which told the operator
 * that something failed five times and gave them nothing whatsoever to look at. That is the worst
 * outcome this stub can produce, and it is cheap to avoid precisely because errors are rare.
 *
 * @param {Function} boundary The public logger method to elide the stack up to
 * @param {number} level The record's level. At or above `ERROR` the stack limit is raised so a bare
 * `console.error` still names its caller.
 * @returns {string} `file.js:line`, or `unknown` if the stack could not be parsed
 */
function captureCallSite(boundary, level) {
    const previousLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = level >= LOG_LEVELS.ERROR ? DEEP_STACK_FRAMES : 1;

    /** @type {{stack?: string}} */
    const holder = {};
    if (typeof Error.captureStackTrace === 'function') {
        Error.captureStackTrace(holder, boundary);
    } else {
        // Not V8. Keep more frames, since we cannot elide by function reference.
        Error.stackTraceLimit = DEEP_STACK_FRAMES;
        holder.stack = new Error().stack;
    }

    Error.stackTraceLimit = previousLimit;
    return parseCallSite(holder.stack ?? '');
}

/**
 * Pulls the first non-logger frame out of a stack string.
 * @param {string} stack Stack trace text
 * @returns {string} `file.js:line`, or `unknown`
 */
function parseCallSite(stack) {
    const frames = stack.split('\n').filter(line => line.trimStart().startsWith('at '));
    for (const frame of frames) {
        const match = frame.match(/([^\s()]+):(\d+):\d+\)?\s*$/);
        if (!match) {
            continue;
        }
        const file = match[1].replace(/^file:\/\/\/?/, '');
        const base = path.basename(file);
        if (base === 'logger.js') {
            continue;
        }
        return `${base}:${match[2]}`;
    }
    return 'unknown';
}

/**
 * Formats call arguments the way `console` would, minus colour.
 * @param {any[]} args Arguments as passed to the logger
 * @returns {string} Formatted single-line-prefixed message
 */
function formatArgs(args) {
    return formatWithOptions({ colors: false }, ...unwrapRedactions(args));
}

/**
 * Marks ONE VALUE as the sensitive part of an otherwise publishable line.
 *
 * 🔴 THE PROBLEM THIS SOLVES: `[SENSITIVE suppressed: users.js:832]` TELLS THE OPERATOR NOTHING.
 *
 * A default install produced 2300 of those stubs across 40 sites, and the top three accounted for 1825
 * of them — every one of which was a boot line whose *prose* was completely safe and whose only secret
 * was a path. The operator lost the sentence to protect the noun. Three consecutive stubs at startup say
 * "three things happened, and you may not know what any of them were", which is indistinguishable from
 * three failures and is exactly how a real problem hides.
 *
 * So: classify the line `NORMAL`, and wrap the value.
 *
 *     log.info(LogClass.NORMAL, 'Using data root:', redact(dataRoot));
 *
 *     debugMode off →  Using data root: <redacted>          (in st.log, always)
 *     debugMode on  →  Using data root: /home/test-user/…        (in st_DEBUG.log only)
 *
 * ⚠️ **THE CLASS IS THE AUTHOR'S JOB AND THIS DOES NOT DO IT FOR THEM.** A `NORMAL` line is PUBLISHED —
 * that is what the class means — so everything outside the `redact()` call is a promise that the prose
 * carries nothing user-derived. This is not a way to downgrade a genuinely sensitive line; a line whose
 * *shape* is revealing ("Ingested 4 memories for character X") stays `SENSITIVE` in full.
 *
 * 🔴 **AND THIS IS WHY IT IS EXPLICIT RATHER THAN INFERRED.** The tempting version is for the logger to
 * print the first string argument of a suppressed line and redact the rest, needing no call-site change
 * at all. It is unsafe and must not be built: `log.info(SENSITIVE, \`chat ${id} failed\`, error)` has a
 * leading string argument that is already interpolated by the time the logger sees it, and publishing it
 * leaks the id. The runtime cannot distinguish a static label from a template literal. The call site can,
 * so the call site decides.
 * @param {any} value The value to hide unless debug mode is on
 * @returns {{[REDACTED]: any}} A marker the formatter understands
 */
export function redact(value) {
    return { [REDACTED]: value };
}

/** Brand for {@link redact}. A symbol so no ordinary logged object can collide with it. */
const REDACTED = Symbol('redacted');

/**
 * Replaces every {@link redact} marker with either its value or a placeholder, per the current mode.
 *
 * Resolved at EMIT time rather than at call time, deliberately: `initLogger` may not have run when an
 * early boot line is recorded, and those buffered lines must reflect the mode that is finally
 * configured, not the default that happened to be in force when they were queued.
 * @param {any[]} args Arguments as passed to the logger
 * @returns {any[]} Arguments with markers resolved
 */
function unwrapRedactions(args) {
    if (!args.some(arg => arg !== null && typeof arg === 'object' && REDACTED in arg)) {
        return args;
    }

    return args.map(arg => {
        if (arg === null || typeof arg !== 'object' || !(REDACTED in arg)) {
            return arg;
        }

        return debugMode ? arg[REDACTED] : '<redacted>';
    });
}

/**
 * Shape an error code has to have before it may appear on a suppression stub.
 *
 * This is a whitelist by shape, not a deny-list of known-bad values, so it fails closed: anything
 * that is not screaming-snake-case and short does not print. `ENOENT`, `EACCES`, `EPROVIDER` and
 * `EUNAVAILABLE` pass; a code someone built out of a filename does not.
 *
 * ⚠️ That sentence is exact for `error.code` and NOT exact for `error.name`, which is tested against
 * this pattern uppercased so that CamelCase built-ins survive. See the note in {@link safeErrorCode}.
 */
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * Extracts the error code or type from a suppressed call's arguments.
 *
 * A suppressed error is loud — the stub names the call site — but until this it was anonymous, and
 * "a broken store must never be silent" is a property this fork rests destructive paths on. The
 * code is a constant from a fixed set, which §5.3 permits explicitly; the message and the stack,
 * which can embed a chat path or a character name, stay suppressed.
 *
 * @param {any[]} args Arguments as passed to the logger
 * @returns {string} ` [CODE]`, or an empty string if nothing safe was found
 */
function safeErrorCode(args) {
    for (const arg of args) {
        if (!(arg instanceof Error)) {
            continue;
        }
        const code = typeof arg.code === 'string' && SAFE_CODE_PATTERN.test(arg.code)
            ? arg.code
            // ⚠️ The name is shape-tested UPPERCASED and then printed as written, deliberately: built-in
            // type names are CamelCase (`TypeError`, `RangeError`) and would fail the screaming-snake
            // pattern otherwise. The cost is that the name arm is really "identifier-shaped, ≤32 chars,
            // any case" — an error carrying `name = 'CairoHeistChat'` would print verbatim. Nothing
            // assigns a user-derived `name` today; if anything ever does, this arm is where it escapes.
            : (SAFE_CODE_PATTERN.test(String(arg.name).toUpperCase()) ? String(arg.name) : '');
        if (code) {
            return ` [${code}]`;
        }
    }
    return '';
}

/**
 * Zero-pads a number for the timestamp formatters below.
 * @param {number} value Number to pad
 * @param {number} [width] Target width
 * @returns {string} Padded string
 */
function pad(value, width = 2) {
    return String(value).padStart(width, '0');
}

/**
 * Formats a log timestamp, honouring `logging.timezone`.
 *
 * The default is LOCAL, because the reader of a log is nearly always sitting in the timezone the
 * server runs in, and correlating a report of "it broke around 3pm" against a Zulu stamp is a
 * subtraction the operator should not have to do. This also puts the line prefix in the same zone
 * as the rotated archive names, which have always been local — see {@link archiveTimestamp}.
 *
 * The local form keeps the UTC offset (`2026-07-21T15:04:05.123-07:00`) rather than dropping it.
 * A bare local stamp is ambiguous for exactly one hour a year, when a DST fall-back repeats it,
 * and that is the hour someone is most likely to be reading a log to work out what happened.
 * Offsets keep the line valid ISO-8601, so anything that parsed the old Zulu form still parses.
 *
 * @param {Date} date When the call happened
 * @returns {string} An ISO-8601 timestamp, `Z` when UTC is configured
 */
function formatTimestamp(date) {
    if (useUtc) {
        return date.toISOString();
    }

    // `getTimezoneOffset` is minutes to ADD to local to reach UTC, so it is the negation of the
    // offset an ISO-8601 string carries: UTC-7 reports +420 and must print as `-07:00`.
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes < 0 ? '-' : '+';
    const absolute = Math.abs(offsetMinutes);

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
        `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/**
 * Builds the line written to the file. Unlike the terminal echo, the file carries a timestamp and
 * a level tag, because a file outlives the session that produced it.
 * @param {Date} timestamp When the call happened
 * @param {number} level One of `LOG_LEVELS`
 * @param {string} message Already-formatted message text
 * @returns {string} A complete line, newline included
 */
function buildFileLine(timestamp, level, message) {
    const tag = LEVEL_TAGS[level] ?? 'INFO';
    return `[${formatTimestamp(timestamp)}] [${tag}] ${stripAnsi(message)}\n`;
}

/**
 * Writes to the open file, rotating first if this line would cross the size cap.
 * @param {string} line Complete line including its trailing newline
 * @returns {void}
 */
function writeToFile(line) {
    if (fileDescriptor === null || writeFailed) {
        return;
    }

    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytesWritten + bytes > maxSizeBytes && bytesWritten > 0) {
        rotate();
    }

    try {
        // ⚠️ LOOP ON THE RETURN VALUE. `fs.writeSync` may write FEWER bytes than it was given (a signal, a
        // full disk), and discarding that count truncated the line on disk while still counting it whole —
        // so the file gained a corrupt entry and the rotation counter drifted high, rotating early.
        const buffer = Buffer.from(line, 'utf8');
        let offset = 0;

        while (offset < buffer.length) {
            offset += fs.writeSync(/** @type {number} */ (fileDescriptor), buffer, offset, buffer.length - offset);
        }

        bytesWritten += bytes;
    } catch (error) {
        // Never let a logging failure take the server down, and never recurse into the logger.
        writeFailed = true;
        process.stderr.write(`Log write failed, continuing without a log file: ${error}\n`);
    }
}

/**
 * Closes, compresses and reopens the log file.
 *
 * The handle is closed *before* the file is touched because Windows will not rename or read an
 * open file, and this fork runs on Windows (design §4.6).
 * @returns {void}
 */
function rotate() {
    if (fileDescriptor === null) {
        return;
    }

    try {
        fs.closeSync(fileDescriptor);
        fileDescriptor = null;

        const stamp = archiveTimestamp(new Date());
        const base = filePath.replace(/\.log$/, '');

        // The stamp has one-second resolution, and two rotations inside one second are reachable (debug
        // mode, large payloads, a low `maxSizeMB`). Writing over the older archive would silently discard
        // it, so disambiguate instead.
        let archivePath = `${base}-${stamp}.log.gz`;
        for (let n = 2; fs.existsSync(archivePath); n++) {
            archivePath = `${base}-${stamp}-${n}.log.gz`;
        }

        // Same mode as the live file, and for the same reason: an archive of a debug log is a gzipped copy
        // of the same cleartext, and it outlives the session that produced it.
        fs.writeFileSync(archivePath, zlib.gzipSync(fs.readFileSync(filePath)), debugMode ? { mode: 0o600 } : undefined);
        fs.unlinkSync(filePath);

        pruneArchives();
    } catch (error) {
        process.stderr.write(`Log rotation failed: ${error}\n`);
    } finally {
        try {
            fileDescriptor = fs.openSync(filePath, 'a');

            // ⚠️ SEED FROM THE FILE, NOT FROM ZERO — THE ROTATION ABOVE MAY HAVE FAILED. Assuming zero
            // here is design §4.4's own warning applied in the one place it was forgotten: if the gzip or
            // the unlink threw (a read-only directory, or on Windows an AV scanner or an open `tail`
            // holding st.log and giving EBUSY), the oversized file is still on disk and reopened in append
            // mode. A zeroed counter then tells `writeToFile` the file is empty, so the cap is defeated and
            // the log grows by another `maxSizeMB` before it tries again — and again, until the disk fills.
            bytesWritten = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
        } catch (error) {
            writeFailed = true;
            process.stderr.write(`Could not reopen the log after rotation: ${error}\n`);
        }
    }
}

/**
 * Formats a rotation timestamp as `YYYYMMDD-HHMMSS`.
 *
 * Follows `logging.timezone` for the same reason the line prefix does: an operator reading a
 * directory listing to find "the log from this morning" is matching filenames against the clock on
 * the wall. A filename cannot carry an offset, so the two forms are indistinguishable on sight —
 * which is precisely why this must not diverge from {@link formatTimestamp}.
 *
 * @param {Date} date Date to format
 * @returns {string} Timestamp suitable for a filename
 */
function archiveTimestamp(date) {
    const parts = useUtc
        ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
        : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
    const [year, month, day, hours, minutes, seconds] = parts;
    return `${year}${pad(month)}${pad(day)}-${pad(hours)}${pad(minutes)}${pad(seconds)}`;
}

/**
 * Deletes the oldest archives beyond `maxArchives`.
 * @returns {void}
 */
function pruneArchives() {
    const directory = path.dirname(filePath);
    const prefix = path.basename(filePath).replace(/\.log$/, '');
    // ⚠️ `(-\d+)?` MATCHES THE DISAMBIGUATED ARCHIVES, WHICH THIS USED TO MISS ENTIRELY. `rotate()` appends
    // `-2`, `-3` … when two rotations land inside the same second — its own comment says that is reachable,
    // and on the debug base, where every prompt and response body is written, it is easy. Those names failed
    // this anchored pattern, so they were neither counted toward `maxArchives` nor ever deleted: retention
    // silently bypassed and disk growth unbounded, with each file a compressed copy of a conversation.
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}-\\d{6}(-\\d+)?\\.log\\.gz$`);

    const archives = fs.readdirSync(directory)
        .filter(name => pattern.test(name))
        .sort();

    for (const name of archives.slice(0, Math.max(0, archives.length - maxArchives))) {
        try {
            fs.unlinkSync(path.join(directory, name));
        } catch {
            // A file we cannot delete is not worth failing a log write over.
        }
    }
}

/**
 * Emits one already-classified record. This is the single point where the class gate is applied.
 * @param {BufferedRecord} record Record to emit
 * @returns {void}
 */
function emit(record) {
    if (record.level < minLogLevel) {
        return;
    }

    // 🔴 THE GATE IS `!== NORMAL`, NOT `=== SENSITIVE`, AND THE DIFFERENCE IS THE WHOLE CONTRACT.
    // Testing for SENSITIVE means only the exact value 1 suppresses, so a missing class, a drifted
    // plugin enum, or a format string passed where the class belongs all PUBLISH. That last one is
    // not hypothetical: `context.logger.info('chat %s for %s', chatId, handle)` is what a plugin
    // author writes out of console habit — the format string is eaten as the class and the two
    // user-derived values are written in the clear, with the safe prose discarded. Design §23.3:
    // "Publishing requires a deliberate act, and the absence of one always resolves to suppressed."
    const suppressed = record.logClass !== LogClass.NORMAL && !debugMode;
    const message = suppressed
        ? `[SENSITIVE suppressed: ${record.site}]${safeErrorCode(record.args)}`
        : formatArgs(record.args);

    writeToFile(buildFileLine(record.timestamp, record.level, message));

    // In debug mode the stream goes to the file only, so that a forgotten `StandardOutput=` in a
    // systemd unit cannot put conversation content into the journal. The startup banner (§4.8)
    // tells the operator where the output went.
    //
    // ⚠️ UNLESS THE FILE IS NOT WORKING, IN WHICH CASE SILENCE IS THE WORST OF THE THREE OPTIONS. If
    // `initLogger` could not open the log (a read-only install directory, a permissions change) then
    // `writeToFile` is a no-op, and suppressing the terminal as well left debug mode with NO output at
    // all — not even a crash-time ERROR — for an operator who turned it on precisely because they were
    // diagnosing something. The journal risk that motivates the suppression is real, but it is strictly
    // better taken than losing the diagnostics entirely.
    if (!debugMode || writeFailed) {
        const stream = record.level >= LOG_LEVELS.WARN ? process.stderr : process.stdout;

        try {
            stream.write(`${message}\n`);
        } catch {
            // Logging must never crash the caller, and a bare `stream.write` can: Node builds the global
            // `console` with `ignoreErrors: true`, so the `console.*` calls this writer replaced were each
            // wrapped in a try/catch with a temporary no-op 'error' listener. Nothing here inherited that.
            // Pipe the server's stdout into something that goes away (`npm start | head`, a journald
            // restart) and the next line raises EPIPE — which, unhandled, is an uncaught exception, which
            // on this server means process exit. See also the module-load listeners below.
        }
    }
}

/**
 * Records a call, either emitting it or buffering it until the writer is ready.
 * @param {number} level One of `LOG_LEVELS`
 * @param {LogClassValue} logClass Classification supplied by the call site
 * @param {any[]} args Arguments as passed
 * @param {Function} boundary The public method, for call-site capture
 * @returns {void}
 */
function record(level, logClass, args, boundary) {
    const timestamp = new Date();

    if (!initialized) {
        // The class gate cannot be applied yet — `debugMode` is not known until config is read —
        // so the site is captured for every buffered line and the decision is made at flush.
        if (buffer.length >= MAX_BUFFERED_RECORDS) {
            droppedFromBuffer++;
            return;
        }
        buffer.push({ timestamp, level, logClass, args, site: captureCallSite(boundary, level) });
        return;
    }

    // Same `!== NORMAL` test as the gate in emit(), and for the same reason: a record that is going
    // to be suppressed must carry its call site, whatever made it suppressed.
    const site = logClass !== LogClass.NORMAL && !debugMode ? captureCallSite(boundary, level) : '';
    emit({ timestamp, level, logClass, args, site });
}

/**
 * The logger. Every method takes its classification as the first argument.
 *
 * ```js
 * log.debug(LogClass.NORMAL,    'Storage provider registered.');
 * log.debug(LogClass.SENSITIVE, request.body);
 * ```
 */
export const log = {
    /**
     * @param {LogClassValue} logClass Classification for this call
     * @param {...any} args Values to log
     * @returns {void}
     */
    debug(logClass, ...args) {
        record(LOG_LEVELS.DEBUG, logClass, args, log.debug);
    },
    /**
     * @param {LogClassValue} logClass Classification for this call
     * @param {...any} args Values to log
     * @returns {void}
     */
    info(logClass, ...args) {
        record(LOG_LEVELS.INFO, logClass, args, log.info);
    },
    /**
     * @param {LogClassValue} logClass Classification for this call
     * @param {...any} args Values to log
     * @returns {void}
     */
    warn(logClass, ...args) {
        record(LOG_LEVELS.WARN, logClass, args, log.warn);
    },
    /**
     * @param {LogClassValue} logClass Classification for this call
     * @param {...any} args Values to log
     * @returns {void}
     */
    error(logClass, ...args) {
        record(LOG_LEVELS.ERROR, logClass, args, log.error);
    },
};

/**
 * Opens the log file and flushes everything buffered during startup.
 *
 * Must be called once config is readable. Everything logged before this point is held in memory
 * and written here in order, so there is no window in which output escapes to the old path
 * (design §4.4).
 *
 * @param {object} options Writer configuration
 * @param {string} options.directory Directory to write the log into
 * @param {string} [options.file] Base name; `.log` is appended
 * @param {boolean} [options.debugMode] Write the whole stream, sensitive included, to `<base>_DEBUG.log`
 * @param {number} [options.minLogLevel] Minimum level to write
 * @param {number} [options.maxSizeMB] Rotate once the file passes this size
 * @param {number} [options.maxArchives] Keep at most this many `.gz` archives
 * @param {string} [options.timezone] `local` (default) or `utc`; anything else falls back to local
 * @returns {void}
 */
export function initLogger({ directory, file = 'st', debugMode: debug = false, minLogLevel: level = LOG_LEVELS.DEBUG, maxSizeMB = 10, maxArchives: archives = 20, timezone = 'local' }) {
    if (initialized) {
        return;
    }

    debugMode = debug;
    minLogLevel = level;
    maxSizeBytes = Math.max(1, maxSizeMB) * 1024 * 1024;
    maxArchives = Math.max(0, archives);
    // Only `utc` opts out. A typo resolves to local rather than throwing, because the logger is the
    // one module that must survive bad config: it is initialised before anything can report the error.
    useUtc = String(timezone).trim().toLowerCase() === 'utc';

    // The uppercase suffix is deliberate: it is meant to be obvious in a directory listing that
    // this file holds cleartext conversation content.
    filePath = path.join(directory, debugMode ? `${file}_DEBUG.log` : `${file}.log`);

    try {
        // ⚠️ 0600 IN DEBUG MODE, BECAUSE THIS FILE HOLDS CONVERSATION CONTENT BY DESIGN. fs defaults to
        // 0666 & ~umask — typically 0644 — so `st_DEBUG.log` was world-readable on the box: any local
        // account could read chats, character names and personas out of it. That is strictly broader than
        // the journal exposure §2 of DESIGN_LOG_HYGIENE.md set out to remove, which at least required
        // membership of `adm`. The operator was warned the content would be in the clear; they were not
        // warned it would be readable by everyone. The `chmod` covers a file that already exists at 0644
        // from an earlier run, since the mode argument only applies at creation.
        fileDescriptor = fs.openSync(filePath, 'a', debugMode ? 0o600 : undefined);

        if (debugMode) {
            try {
                fs.chmodSync(filePath, 0o600);
            } catch {
                // Best effort — Windows has no meaningful equivalent, and a failure here must not stop boot.
            }
        }

        // Seed from the existing size rather than zero, or a restart lets the file grow past the
        // cap by however much was already there (§4.4).
        bytesWritten = fs.statSync(filePath).size;
    } catch (error) {
        writeFailed = true;
        process.stderr.write(`Could not open the log file at ${filePath}: ${error}\n`);
    }

    initialized = true;

    const pending = buffer;
    buffer = [];
    for (const entry of pending) {
        emit(entry);
    }

    if (droppedFromBuffer > 0) {
        log.warn(LogClass.NORMAL, `${droppedFromBuffer} log lines were dropped before the log file was opened.`);
        droppedFromBuffer = 0;
    }

    if (debugMode) {
        printDebugBanner();
    } else {
        warnAboutSurvivingDebugLogs(directory, file);
    }
}

/**
 * 🔴 THE BANNER TOLD THEM TO DELETE ONE FILE. ROTATION HAD ALREADY MADE TWENTY MORE.
 *
 * `st_DEBUG.log` rotates like any other log: past `maxSizeMB` — trivially reached when every assembled
 * prompt and response body is written — it is gzipped to `st_DEBUG-<stamp>.log.gz` and a fresh file starts,
 * up to `maxArchives`. The §4.8 banner names only `filePath`, so an operator who followed it exactly (turn
 * debugMode off, delete the file it named) was left with up to twenty gzipped copies of their chats,
 * character names and personas on disk indefinitely. Nothing else collects them: `pruneArchives` runs only
 * from `rotate()`, and once debug mode is off that base never rotates again.
 *
 * Said at the moment it is actionable — the boot AFTER debug mode was turned off, which is exactly when the
 * operator believes they are finished and has stopped looking.
 * @param {string} directory Log directory
 * @param {string} file Base log name, without extension
 * @returns {void}
 */
function warnAboutSurvivingDebugLogs(directory, file) {
    try {
        const live = `${file}_DEBUG.log`;
        const archive = new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_DEBUG-\\d{8}-\\d{6}(-\\d+)?\\.log\\.gz$`);

        const survivors = fs.readdirSync(directory).filter(name => name === live || archive.test(name));

        if (survivors.length === 0) {
            return;
        }

        log.warn(LogClass.NORMAL, `Debug logging is off, but ${survivors.length} debug log file(s) are still in ${directory}. They contain chat messages, character names and personas in clear text: ${survivors.join(', ')}`);
    } catch {
        // A directory we cannot list is not a reason to fail a boot.
    }
}

/**
 * Warns, unmissably, that this session writes conversation content in the clear (design §4.8).
 * @returns {void}
 */
function printDebugBanner() {
    const banner = [
        '',
        '****************************************************************************',
        '*                                                                          *',
        '*   DEBUG LOGGING IS ON. SENSITIVE INFORMATION IS BEING WRITTEN IN CLEAR   *',
        '*   TEXT: your chat messages, character names and personas.                *',
        '*                                                                          *',
        `*   File:     ${filePath}`,
        `*   Archives: ${filePath.replace(/\.log$/, '')}-*.log.gz`,
        '*                                                                          *',
        '*   Set logging.debugMode to false in config.yaml and DELETE THOSE FILES   *',
        '*   when you are done debugging. Rotation makes gzipped copies of this     *',
        '*   file as it grows; deleting only the file above leaves them behind.     *',
        '*                                                                          *',
        '****************************************************************************',
        '',
    ].join('\n');

    // Straight to stderr: the banner is the one thing that must appear on the terminal even
    // though debug mode otherwise routes the whole stream to the file.
    process.stderr.write(`${banner}\n`);
    writeToFile(buildFileLine(new Date(), LOG_LEVELS.WARN, banner));
}

/**
 * Routes third-party `console.*` output into the log, classified `SENSITIVE`.
 *
 * Once the codemod has landed, nothing in `src/` calls `console`. What remains is library output —
 * express, multer, vectra — which would otherwise go to stdout and land in the journal. We cannot audit
 * what a library prints and some of them print user data, so failing closed on code we do not control is
 * the only defensible default (design §4.2).
 *
 * ⚠️ WHAT THIS DOES *NOT* CATCH, WHICH THIS COMMENT USED TO CLAIM IT DID: anything that writes to stdio
 * without going through `console`. `util.debuglog` (i.e. `NODE_DEBUG=http`) formats and calls
 * `process.stderr.write` itself, and the `debug` npm package — a dependency of express, body-parser,
 * compression, cookie-parser and multer here — resolves a raw `process.stderr` and writes to that. So an
 * operator who sets `NODE_DEBUG` or `DEBUG=express:*` to diagnose something gets request bodies and
 * headers on stdio, and therefore in the journal, with this seam reporting nothing. Closing that route
 * means wrapping the streams themselves; until then, do not set those variables on an encrypted install.
 *
 * @returns {void}
 */
export function installConsoleSeam() {
    globalThis.console.log = (...args) => log.info(LogClass.SENSITIVE, ...args);
    globalThis.console.debug = (...args) => log.debug(LogClass.SENSITIVE, ...args);
    globalThis.console.info = (...args) => log.info(LogClass.SENSITIVE, ...args);
    globalThis.console.warn = (...args) => log.warn(LogClass.SENSITIVE, ...args);
    globalThis.console.error = (...args) => log.error(LogClass.SENSITIVE, ...args);
    // `console.dir` does NOT route through `console.log` — Node's implementation calls its internal
    // write path directly — so patching the five above leaves it printing raw. It exists to dump an
    // object, which is exactly the shape of call that carries user data.
    globalThis.console.dir = (...args) => log.info(LogClass.SENSITIVE, ...args);
}

/**
 * Flushes anything still buffered to stderr and closes the file.
 *
 * If the process dies before `initLogger` runs, the buffer is dumped in the clear — safe at that
 * point, because no user data has been loaded that early in startup (design §4.4).
 * @returns {void}
 */
export function shutdownLogger() {
    if (!initialized) {
        for (const entry of buffer) {
            // 🔴 THE GATE APPLIES HERE TOO, BECAUSE "TOO EARLY FOR USER DATA" IS NOT TRUE OF EVERY CALLER.
            //
            // The reasoning in the doc comment above holds for the SERVER, which calls `initLogger` a few
            // lines into startup: anything still buffered at that point really did happen before any user
            // data was loaded. It does not hold for the CLI entry points. `recover.js` never calls
            // `initLogger` at all, so `initialized` stays false for the whole run, EVERY line lands in this
            // buffer, and this loop then published each one in full — including the SENSITIVE half of every
            // carefully split pair in `recover-password.js`, which names the account and carries the
            // provider's own prose about it. The one file that applied the discipline most carefully was
            // the one file where it did nothing.
            //
            // Same gate as `emit`, for the same reason, so there is one rule and not two.
            const suppressed = entry.logClass !== LogClass.NORMAL && !debugMode;
            const message = suppressed
                ? `[SENSITIVE suppressed: ${entry.site}]${safeErrorCode(entry.args)}`
                : formatArgs(entry.args);

            process.stderr.write(buildFileLine(entry.timestamp, entry.level, message));
        }
        buffer = [];
        return;
    }

    if (fileDescriptor !== null) {
        try {
            fs.closeSync(fileDescriptor);
        } catch {
            // Nothing useful to do while shutting down.
        }
        fileDescriptor = null;
    }
    initialized = false;
    writeFailed = false;
}

// A fatal error during startup — a malformed config.yaml, a missing path — calls process.exit()
// while the writer is still buffering, and without this the diagnostic explaining why the server
// died would be discarded along with the buffer. Dumping it is safe at that point for the reason
// given in `shutdownLogger`: nothing has loaded any user data yet.
process.on('exit', () => {
    if (!initialized && buffer.length > 0) {
        shutdownLogger();
    }
});

// An asynchronous EPIPE arrives as an 'error' EVENT on the stream, not as a throw from `write`, and an
// 'error' event with no listener is raised rather than delivered. The try/catch in `emit` cannot see that
// one, so the stream needs a listener of its own — which is exactly what Node's own `console` installs
// around every write, and what a bare `stream.write` does not inherit. There is nothing useful to do with
// the error: the destination is gone, and the log file (if there is one) already has the line.
process.stdout.on('error', () => { });
process.stderr.on('error', () => { });

/**
 * Resets every module-level value. Test seam only — production code opens the log once.
 * @returns {void}
 */
export function resetLoggerForTests() {
    if (fileDescriptor !== null) {
        try {
            fs.closeSync(fileDescriptor);
        } catch {
            // Ignored.
        }
    }
    buffer = [];
    droppedFromBuffer = 0;
    fileDescriptor = null;
    filePath = '';
    bytesWritten = 0;
    initialized = false;
    debugMode = false;
    minLogLevel = LOG_LEVELS.DEBUG;
    maxSizeBytes = 10 * 1024 * 1024;
    maxArchives = 20;
    useUtc = false;
    writeFailed = false;
}
