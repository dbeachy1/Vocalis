import { describe, test, expect, afterEach, jest } from '@jest/globals';

import { adoptLogger, normal, resetLogging, sensitive } from '../src/logging.js';
import {
    NORMAL_CALL_LINE,
    SENSITIVE_CALL_LINE,
    logNormalFromHere,
    logSensitiveFromHere,
} from './helpers/log-call-site.js';

/**
 * 🔴 THE PLUGIN'S LOUDEST WARNING WAS INVISIBLE ON EVERY INSTALL THAT EXISTS, AND THAT IS WHAT THIS IS FOR.
 *
 * The fork installs a global console seam before any storage provider loads, and it classifies everything it
 * captures `SENSITIVE` — it cannot do otherwise, since it has no idea what a third party is about to print.
 * `logging.debugMode` is off on a default install, so every SENSITIVE line is replaced by a stub. The result,
 * for the one condition `lifecycle.js` calls "invisible from the inside":
 *
 *     [SENSITIVE suppressed: lifecycle.js:162] [ENOSPC]
 *
 * Nothing was lost — the re-arm still works. The only *signal* that an account has no recovery key anybody
 * has ever seen was lost, which is the same thing from the operator's chair.
 *
 * These tests pin the four properties that make the fix safe rather than merely working:
 *
 *   1. it degrades to `console.*` on a fork that hands a provider no logger — which is EVERY fork today;
 *   2. it sends the FORK's class values, never its own, so a renumbered enum cannot silently publish;
 *   3. it never writes to the fork's logger object, which is handed over live and unfrozen;
 *   4. a suppressed line still names its own call site, not this module.
 */

/**
 * A stand-in for the fork's classified logger that records what it was handed.
 * @param {object} [classes] The class vocabulary this fake fork uses
 * @returns {any} The fake logger, with a `lines` array
 */
function fakeLogger(classes = { NORMAL: 0, SENSITIVE: 1 }) {
    /** @type {Array<{level: string, logClass: number, args: any[]}>} */
    const lines = [];
    const record = (level) => (logClass, ...args) => void lines.push({ level, logClass, args });

    return {
        lines,
        classes,
        logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
    };
}

/**
 * Everything a fake fork hands a provider, shaped like the real context.
 * @param {object} [classes] The class vocabulary
 * @returns {any} A context plus the recorder
 */
function forkContext(classes) {
    const fake = fakeLogger(classes);
    return { fake, context: { logger: fake.logger, LogClass: fake.classes } };
}

/** Every line the fork's logger received at the given class. @param {any} fake @param {number} logClass @returns {any[]} */
function linesAt(fake, logClass) {
    return fake.lines.filter((line) => line.logClass === logClass);
}

afterEach(() => {
    resetLogging();
    jest.restoreAllMocks();
});

describe('🔇 the guard — a fork that hands a provider no logger is the NORMAL case, not an error', () => {
    // Forks may omit the optional logger from storage-provider context. An unguarded logger call would throw
    // during initialization and prevent the provider from serving data.
    test.each([
        ['nothing at all', undefined],
        ['null', null],
        ['a context with no logger', { dataRoot: '/tmp/x' }],
        ['a logger but no LogClass', { logger: fakeLogger().logger }],
        ['a LogClass but no logger', { LogClass: { NORMAL: 0, SENSITIVE: 1 } }],
        ['a logger missing .debug', { logger: { info() {}, warn() {}, error() {} }, LogClass: { NORMAL: 0, SENSITIVE: 1 } }],
        ['a logger missing .error', { logger: { debug() {}, info() {}, warn() {} }, LogClass: { NORMAL: 0, SENSITIVE: 1 } }],
        ['a LogClass missing SENSITIVE', { logger: fakeLogger().logger, LogClass: { NORMAL: 0 } }],
        ['a LogClass missing NORMAL', { logger: fakeLogger().logger, LogClass: { SENSITIVE: 1 } }],
    ])('refuses to adopt %s, and says so rather than throwing', (_description, context) => {
        expect(adoptLogger(context)).toBe(false);
    });

    test('🔴 a half-usable fork is refused WHOLE — never one channel adopted and one left behind', () => {
        // Guessing the missing half is the exact fail-open the guard exists to refuse: a fork with NORMAL
        // and no SENSITIVE would tempt you to default SENSITIVE to 1, and if that guess were wrong every
        // identifier this plugin logs would publish.
        const { fake } = forkContext();

        expect(adoptLogger({ logger: fake.logger, LogClass: { NORMAL: 0 } })).toBe(false);

        normal().error('after a refused adoption');
        sensitive().error('after a refused adoption');

        expect(fake.lines).toEqual([]);
    });

    test('falls back to console.* and nothing throws', () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(adoptLogger({})).toBe(false);

        expect(() => {
            normal().error('visible');
            sensitive().warn('also visible, because there is no seam to hide it');
        }).not.toThrow();

        expect(error).toHaveBeenCalledWith('visible');
        expect(warn).toHaveBeenCalledWith('also visible, because there is no seam to hide it');
    });

    test('the fallback never drops the message, only the classification', () => {
        // Fail-safe direction: a NORMAL line degrading to a suppressed one costs a diagnostic. The reverse
        // cannot happen, because the fallback publishes nothing the seam would have withheld — it IS the
        // seam's input.
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});

        sensitive().error('an identifier', 'default-user');

        expect(error).toHaveBeenCalledWith('an identifier', 'default-user');
    });
});

describe('🔢 the class values come from the fork, never from our own constants', () => {
    test('adopts, and routes each channel to the value the fork itself uses', () => {
        const { fake, context } = forkContext();

        expect(adoptLogger(context)).toBe(true);

        normal().info('published');
        sensitive().info('suppressed');

        expect(linesAt(fake, 0).map((line) => line.args[0])).toEqual(['published']);
        expect(linesAt(fake, 1).map((line) => line.args[0])).toEqual(['suppressed']);
    });

    test('🔴 a fork that RENUMBERED its enum still gets the right class — this is the silent-leak guard', () => {
        // The fork decides suppression with `logClass === LogClass.SENSITIVE`. Hard-code our own `1` and the
        // day it renumbers, that comparison goes false, every line marked SENSITIVE is treated as NORMAL,
        // and identifiers publish in the clear — failing open, silently, because of a change in a repo we do
        // not control. Reading the values off the context we were handed cannot drift.
        const { fake, context } = forkContext({ NORMAL: 7, SENSITIVE: 9 });

        expect(adoptLogger(context)).toBe(true);

        normal().error('published');
        sensitive().error('suppressed');

        expect(linesAt(fake, 7).map((line) => line.args[0])).toEqual(['published']);
        expect(linesAt(fake, 9).map((line) => line.args[0])).toEqual(['suppressed']);
        expect(linesAt(fake, 1)).toEqual([]);
    });

    test('🔴 NORMAL === 0 is adopted, not mistaken for absent', () => {
        // `classes.NORMAL !== undefined`, not truthiness. `NORMAL` IS `0` in the fork. A truthy test rejects
        // a perfectly good logger and silently downgrades the whole plugin to the fallback — which is the
        // exact failure this module was written to end.
        const { fake, context } = forkContext({ NORMAL: 0, SENSITIVE: 1 });

        expect(adoptLogger(context)).toBe(true);

        normal().warn('zero is a class, not a missing one');

        expect(fake.lines).toEqual([{ level: 'warn', logClass: 0, args: ['zero is a class, not a missing one'] }]);
    });

    test('all four levels are bound, at both classes', () => {
        const { fake, context } = forkContext();
        adoptLogger(context);

        for (const level of ['debug', 'info', 'warn', 'error']) {
            normal()[level]('n');
            sensitive()[level]('s');
        }

        expect(fake.lines.map((line) => `${line.level}:${line.logClass}`)).toEqual([
            'debug:0', 'debug:1', 'info:0', 'info:1', 'warn:0', 'warn:1', 'error:0', 'error:1',
        ]);
    });
});

describe('🔴 the fork\'s logger is READ, never written', () => {
    test('adopting does not touch a single method on the fork\'s logger object', () => {
        // The fork hands over its LIVE logger singleton, unfrozen. The tempting one-liner —
        //   context.logger.info = context.logger.info.bind(context.logger, NORMAL)
        // — looks like binding and is catastrophic: every internal `log.info(LogClass.SENSITIVE, …)` in the
        // whole server then evaluates as `info(NORMAL, SENSITIVE, …)` and PUBLISHES. Nothing in the fork
        // refuses it, so this test is the only thing that would notice.
        const { fake, context } = forkContext();
        const before = { ...context.logger };

        adoptLogger(context);
        normal().info('n');
        sensitive().info('s');

        for (const level of ['debug', 'info', 'warn', 'error']) {
            expect(context.logger[level]).toBe(before[level]);
        }
        expect(Object.keys(context.logger)).toEqual(Object.keys(before));
        expect(context.LogClass).toEqual(fake.classes);
    });

    test('the fork still gets its own class argument first, exactly as its signature says', () => {
        const { fake, context } = forkContext();
        adoptLogger(context);

        sensitive().error('Recovery key write failed for', 'default-user', new Error('ENOSPC'));

        const [line] = fake.lines;
        expect(line.logClass).toBe(1);
        expect(line.args[0]).toBe('Recovery key write failed for');
        expect(line.args[1]).toBe('default-user');
        expect(line.args[2]).toBeInstanceOf(Error);
    });

    test('the bound objects are frozen, so nobody can reclassify a channel at runtime', () => {
        expect(Object.isFrozen(normal())).toBe(true);
        expect(Object.isFrozen(sensitive())).toBe(true);
    });
});

describe('🧭 a suppressed line still names its own call site', () => {
    /**
     * What the fork actually does to attribute a suppressed line, reproduced exactly.
     *
     * `Error.stackTraceLimit = 1` keeps ONE frame, and `captureStackTrace(holder, fn)` elides `fn` and
     * everything above it — so the single surviving frame is `fn`'s immediate caller. If we reached the fork
     * through a wrapping function, the wrapper IS that caller, and every suppressed line in this plugin would
     * be attributed to `logging.js` instead of the site that wrote it.
     * @returns {any} A logger that records the frame it would have blamed
     */
    function frameCapturingLogger() {
        /** @type {string[]} */
        const frames = [];
        // The arguments are deliberately ignored: this fake exists to answer "which frame would the fork
        // have blamed", not "what was said".
        const capture = function capture() {
            const limit = Error.stackTraceLimit;
            Error.stackTraceLimit = 1;
            const holder = {};
            Error.captureStackTrace(holder, capture);
            Error.stackTraceLimit = limit;
            frames.push(holder.stack);
        };

        return { frames, logger: { debug: capture, info: capture, warn: capture, error: capture } };
    }

    test('🔴 a SENSITIVE line is attributed to the file and line that wrote it, NOT to logging.js', () => {
        // This is the assertion the whole module shape exists to satisfy. `[SENSITIVE suppressed:
        // lifecycle.js:162]` is the ONLY thing an operator sees on a default install; if it says
        // `logging.js:71` instead, every diagnostic in the plugin has collapsed into one useless one and
        // nothing else in this file would have noticed.
        const { frames, logger } = frameCapturingLogger();
        adoptLogger({ logger, LogClass: { NORMAL: 0, SENSITIVE: 1 } });

        logSensitiveFromHere();

        expect(frames).toHaveLength(1);
        expect(frames[0]).toContain('log-call-site.js');
        expect(frames[0]).toContain(`log-call-site.js:${SENSITIVE_CALL_LINE}:`);
        expect(frames[0]).not.toContain('logging.js');
    });

    test('a NORMAL line is attributed the same way', () => {
        const { frames, logger } = frameCapturingLogger();
        adoptLogger({ logger, LogClass: { NORMAL: 0, SENSITIVE: 1 } });

        logNormalFromHere();

        expect(frames[0]).toContain(`log-call-site.js:${NORMAL_CALL_LINE}:`);
        expect(frames[0]).not.toContain('logging.js');
    });

    test('the accessors return the bound object rather than logging themselves', () => {
        // `normal()` resolving to a frozen object of pre-bound methods is what keeps the stack clean:
        // `normal().error(…)` finishes the `normal()` call BEFORE `.error` is invoked. A `normal.error(…)`
        // wrapper could not do this, and no lint rule would catch the difference.
        const { context } = forkContext();
        adoptLogger(context);
        const channel = normal();

        expect(typeof channel.error).toBe('function');
        expect(normal()).toBe(channel);
        expect(normal()).not.toBe(sensitive());
    });

    test('🔴 the FALLBACK adds no frame either — it must not be worse than doing nothing', () => {
        // The fork skips frames named `logger.js` and nothing else, so a wrapper here would resolve every
        // suppressed line to `logging.js:NN`: a confident, wrong attribution. A bare console call resolves
        // to `unknown` on that fork by its own deliberate design, and `unknown` is honest. This asserts the
        // fallback hands back the live `console` method itself, with nothing of ours in between.
        resetLogging();

        expect(normal().error).toBe(console.error);
        expect(normal().warn).toBe(console.warn);
        expect(normal().debug).toBe(console.debug);
        expect(normal().info).toBe(console.log);
        expect(sensitive().error).toBe(console.error);
    });

    test('🔴 the fallback resolves console.* at CALL time, never captured at module load', () => {
        // The seam replaces `console.*` during startup. A reference grabbed eagerly at import time could be
        // the PRE-seam console on an unlucky load order — printing user data straight to stdout and
        // bypassing the whole mechanism. The getter is what makes that impossible.
        resetLogging();
        const replacement = jest.fn();
        const original = console.error;

        try {
            console.error = replacement;
            sensitive().error('after the seam moved');
        } finally {
            console.error = original;
        }

        expect(replacement).toHaveBeenCalledWith('after the seam moved');
    });
});

describe('♻️  resetLogging', () => {
    test('puts the sinks back on console so one suite cannot leak into the next', () => {
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        const { fake, context } = forkContext();
        adoptLogger(context);

        normal().error('to the fork');
        resetLogging();
        normal().error('to the console');

        expect(fake.lines.map((line) => line.args[0])).toEqual(['to the fork']);
        expect(error).toHaveBeenCalledWith('to the console');
    });
});
