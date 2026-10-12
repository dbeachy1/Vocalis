import util from 'node:util';

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

import { adoptLogger, normal, resetLogging, sensitive } from '../src/logging.js';

/**
 * The classified-logging seam (fork §23, capability 13).
 *
 * Two things are being protected here and they fail in opposite directions:
 *
 *  1. 🔴 **Fail-safe:** a fork without `context.logger` must fall back to `console.*` rather than throw. the host —
 *     the only deployment that exists — runs a fork that predates §23, so an unguarded call would be a
 *     `TypeError` in `init` on the one machine anyone will actually run this on.
 *  2. 🔴 **Fail-closed:** the class values handed to the fork must be the fork's own. If the plugin shipped its
 *     own `SENSITIVE` constant and the fork ever renumbered, `logClass === LogClass.SENSITIVE` would go false
 *     and every withheld line would be PUBLISHED — a plaintext leak, silent, caused by a change in a repo this
 *     one does not control.
 *
 * The fixtures deliberately use `'N'`/`'S'` rather than `0`/`1` so that a hard-coded constant cannot pass by
 * coincidence. That is the whole point of the fixture: with 0/1 these tests would still pass against the bug.
 */

/** @type {ReturnType<typeof fakeLogger>} */
let sink;
/** @type {import('jest-mock').SpiedFunction<typeof console.log>} */
let consoleLog;
/** @type {import('jest-mock').SpiedFunction<typeof console.warn>} */
let consoleWarn;
/** @type {import('jest-mock').SpiedFunction<typeof console.error>} */
let consoleError;
/** @type {import('jest-mock').SpiedFunction<typeof console.debug>} */
let consoleDebug;

/**
 * A fake fork logger recording `[class, level, formatted]` for every call.
 *
 * 🔴 **`logger` is declared as the fork's own `ForkLogger`, not as a shape of its own, and that is a check
 * rather than a convenience.** This object is the stand-in for `context.logger` — the thing whose first
 * argument is the class value the whole file is about. Declaring it as the interface means a fork that
 * renamed a level, or reordered the class argument, turns this file red instead of leaving a fake that agrees
 * with an API nobody ships any more.
 *
 * ⚠️ **`calls[n][0]` is `unknown` on purpose.** The class is whatever the fork spells it as; the fixtures
 * below deliberately spell it `'N'`/`'S'` so a plugin-side `0`/`1` cannot pass by coincidence. Narrowing this
 * to `string` would quietly re-admit exactly the assumption the fixtures exist to deny.
 *
 * @returns {{ calls: [unknown, string, string][], logger: ForkLogger }}
 */
function fakeLogger() {
    /** @type {[unknown, string, string][]} */
    const calls = [];
    /** @param {string} level */
    const at = (level) =>
        (/** @type {unknown} */ logClass, /** @type {unknown[]} */ ...args) =>
            calls.push([logClass, level, util.format(...args)]);
    return {
        calls,
        logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    };
}

const FORK_CLASS = Object.freeze({ NORMAL: 'N', SENSITIVE: 'S' });

beforeEach(() => {
    sink = fakeLogger();
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleDebug = jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
    resetLogging();
    jest.restoreAllMocks();
});

describe('a fork WITH context.logger — the classified channel', () => {
    test('adoptLogger reports success and routes both classes to the fork', () => {
        expect(adoptLogger({ logger: sink.logger, LogClass: FORK_CLASS })).toBe(true);

        normal().info('%d stored', 3);
        sensitive().debug('for %s', 'test-user-1');

        expect(sink.calls).toEqual([
            ['N', 'info', '3 stored'],
            ['S', 'debug', 'for test-user-1'],
        ]);
    });

    test('🔴 the class values are the FORK\'s, never constants of our own', () => {
        adoptLogger({ logger: sink.logger, LogClass: FORK_CLASS });

        normal().warn('published');
        sensitive().warn('withheld');

        // The assertion that catches a hard-coded 0/1: these fixtures use 'N'/'S', so a plugin shipping its own
        // enum would send 0 and 1 here and fail. In production that same bug publishes every SENSITIVE line.
        expect(sink.calls.map(c => c[0])).toEqual(['N', 'S']);
        expect(sink.calls.map(c => c[0])).not.toContain(0);
        expect(sink.calls.map(c => c[0])).not.toContain(1);
    });

    test('all four levels are forwarded, and nothing reaches the console', () => {
        adoptLogger({ logger: sink.logger, LogClass: FORK_CLASS });

        normal().debug('d');
        normal().info('i');
        normal().warn('w');
        normal().error('e');

        expect(sink.calls.map(c => c[1])).toEqual(['debug', 'info', 'warn', 'error']);
        // 🔴 Once adopted, the console seam must not ALSO get the line. A double-write would publish through
        // one path what was withheld through the other, which is the leak wearing a different hat.
        expect(consoleLog).not.toHaveBeenCalled();
        expect(consoleWarn).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
        expect(consoleDebug).not.toHaveBeenCalled();
    });

    test('format placeholders are left to the writer, not pre-formatted here', () => {
        adoptLogger({ logger: sink.logger, LogClass: FORK_CLASS });

        // The fork's writer does the substitution (it calls util.formatWithOptions), so the plugin must pass
        // the format string and its arguments through untouched rather than building a string itself. The fake
        // formats them the same way, so what is really asserted is that nothing was lost or reordered.
        normal().info('%s: %d of %d', 'ingest', 2, 6);
        expect(sink.calls[0][2]).toBe('ingest: 2 of 6');
    });
});

describe('a fork WITHOUT context.logger — the fallback that keeps Test Host alive', () => {
    test('🔴 adoptLogger reports failure instead of throwing, on a context with no logger at all', () => {
        expect(adoptLogger({})).toBe(false);
        expect(() => normal().info('still works')).not.toThrow();
        expect(consoleLog).toHaveBeenCalled();
    });

    test('🔴 a null or undefined context does not throw either', () => {
        // `adoptLogger` accepts a missing context at runtime even though its JSDoc type is non-nullable.
        // Keep that tolerance covered until the upstream declaration accepts `ForkContext|null|undefined`.
        expect(adoptLogger(/** @type {ForkContext} */ (/** @type {unknown} */ (undefined)))).toBe(false);
        expect(adoptLogger(/** @type {ForkContext} */ (/** @type {unknown} */ (null)))).toBe(false);
        expect(() => sensitive().error('still works')).not.toThrow();
    });

    test('every level falls back to the console method the fork\'s own seam would have used', () => {
        adoptLogger({});

        normal().debug('d');
        normal().info('i');
        normal().warn('w');
        normal().error('e');

        // Mapped to match fork `logger.js` installConsoleSeam: info→console.log, so a line keeps its level
        // whichever path it takes.
        expect(consoleDebug).toHaveBeenCalledWith('d');
        expect(consoleLog).toHaveBeenCalledWith('i');
        expect(consoleWarn).toHaveBeenCalledWith('w');
        expect(consoleError).toHaveBeenCalledWith('e');
    });

    test('the class is dropped rather than passed on — console.* has no vocabulary for it', () => {
        adoptLogger({});

        sensitive().info('%s happened', 'something');

        // The class must NOT leak into the formatted output as a stray leading argument. Passing it through
        // would print `1 something happened` on every line of an old fork's log.
        expect(consoleLog).toHaveBeenCalledWith('%s happened', 'something');
    });

    describe('a half-built context is treated as no context — the fail-CLOSED half', () => {
        /**
         * 🔴 **`unknown`, and the table is the fixture rather than the annotation being lazy.** Three of these
         * five are shapes `ForkContext` says cannot exist — a `logger` missing two of its four levels, a
         * `LogClass` missing `SENSITIVE`, a `logger` that is a string. That declaration describes the fork we
         * expect; `adoptLogger`'s six checks exist for the fork we get, and a table typed as `ForkContext`
         * would have had to drop those three rows and would then be testing the expected fork five times.
         *
         * ⚠️ Which is the security half of it: the refused rows are the ones where guessing the missing half
         * would be guessing whether to publish.
         *
         * @type {[string, unknown][]}
         */
        const halfBuilt = [
            ['logger but no LogClass', { logger: fakeLogger().logger }],
            ['LogClass but no logger', { LogClass: FORK_CLASS }],
            ['a logger missing a level', { logger: { info: () => {}, warn: () => {} }, LogClass: FORK_CLASS }],
            ['a LogClass missing SENSITIVE', { logger: fakeLogger().logger, LogClass: { NORMAL: 'N' } }],
            ['a logger that is not an object', { logger: 'yes please', LogClass: FORK_CLASS }],
        ];

        test.each(halfBuilt)('%s → refused, falls back', (_label, context) => {
            // The cast is the table's, described above: what is being handed to `adoptLogger` here is what a
            // fork that half-implements §23 hands `init`, which is precisely what the declaration excludes.
            expect(adoptLogger(/** @type {ForkContext} */ (context))).toBe(false);
            expect(() => sensitive().warn('safe')).not.toThrow();
            expect(consoleWarn).toHaveBeenCalledWith('safe');
        });
    });

    test('🔴 refusing a half-built context never publishes through the half that DID exist', () => {
        // The dangerous shape: a fork with a working logger but no vocabulary. Guessing a class here would be
        // guessing whether to publish, and the wrong guess is a leak — so the whole capability is refused.
        const half = fakeLogger();
        expect(adoptLogger({ logger: half.logger })).toBe(false);

        sensitive().info('a chat id');

        expect(half.calls).toEqual([]);              // nothing reached the fork's writer unclassified
        expect(consoleLog).toHaveBeenCalledWith('a chat id');   // ...it went to the seam, which suppresses it
    });
});

describe('resetLogging', () => {
    test('puts an adopted logger back, so a test cannot leak its fake into the next suite', () => {
        adoptLogger({ logger: sink.logger, LogClass: FORK_CLASS });
        normal().info('adopted');
        expect(sink.calls).toHaveLength(1);

        resetLogging();
        normal().info('after reset');

        expect(sink.calls).toHaveLength(1);          // the fake heard nothing further
        expect(consoleLog).toHaveBeenCalledWith('after reset');
    });
});
