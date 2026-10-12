import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { LogClass, log, initLogger, installConsoleSeam, shutdownLogger, resetLoggerForTests, redact } from '../src/logger.js';
import { LOG_LEVELS } from '../src/constants.js';
import { makeScratchDirectory } from './util/st-server.js';

/** @type {string} */
let directory;
/** @type {import('@jest/globals').jest.SpiedFunction<any>} */
let stdoutSpy;
/** @type {import('@jest/globals').jest.SpiedFunction<any>} */
let stderrSpy;

/** Everything the logger tried to put on the terminal this test. */
let terminal = [];

beforeEach(() => {
    directory = makeScratchDirectory('logger');
    terminal = [];
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(text => {
        terminal.push(String(text));
        return true;
    });
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(text => {
        terminal.push(String(text));
        return true;
    });
});

afterEach(() => {
    resetLoggerForTests();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * Reads the log file the writer is currently using.
 * @param {string} [file] Base name
 * @param {boolean} [debug] Whether to read the debug variant
 * @returns {string} File contents, or '' if it does not exist
 */
function readLog(file = 'st', debug = false) {
    const target = path.join(directory, debug ? `${file}_DEBUG.log` : `${file}.log`);
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
}

describe('classification gate', () => {
    test('writes NORMAL lines in full', () => {
        initLogger({ directory });
        log.info(LogClass.NORMAL, 'Storage provider registered.');

        expect(readLog()).toContain('Storage provider registered.');
    });

    test('suppresses SENSITIVE lines when debug mode is off', () => {
        initLogger({ directory });
        log.debug(LogClass.SENSITIVE, 'the quick brown fox jumped');

        expect(readLog()).not.toContain('the quick brown fox jumped');
    });

    test('a suppressed line leaves a stub naming only the call site', () => {
        initLogger({ directory });
        log.debug(LogClass.SENSITIVE, 'the quick brown fox jumped');

        // The stub preserves the execution trace without leaking any part of the message.
        expect(readLog()).toMatch(/\[SENSITIVE suppressed: logger\.test\.js:\d+\]/);
    });

    test('writes SENSITIVE lines when debug mode is on', () => {
        initLogger({ directory, debugMode: true });
        log.debug(LogClass.SENSITIVE, 'the quick brown fox jumped');

        expect(readLog('st', true)).toContain('the quick brown fox jumped');
    });

    test('suppression survives an object payload, not just a string', () => {
        initLogger({ directory });
        log.debug(LogClass.SENSITIVE, { prompt: 'the quick brown fox jumped', name: 'Sample Character' });

        const contents = readLog();
        expect(contents).not.toContain('the quick brown fox jumped');
        expect(contents).not.toContain('Sample Character');
    });
});

describe('the gate fails SAFE — anything that is not NORMAL is suppressed', () => {
    // 🔴 These pin `logClass !== LogClass.NORMAL` against a regression back to `=== SENSITIVE`, which
    // published on every value except the literal 1. The fork's own call sites all pass a literal, so
    // nothing here protects the fork from itself — this is the `context.logger` surface, where the
    // caller is a plugin the fork does not control and cannot lint.

    test('a plugin that forgets the class entirely does not publish', () => {
        initLogger({ directory });

        // What a plugin author writes out of console habit. The format string lands in the class
        // parameter, and under `=== SENSITIVE` both interpolated values were written in the clear
        // while the safe prose was discarded — the exact inverse of the intent.
        // @ts-expect-error deliberately calling with the wrong signature
        log.info('ingest: chat %s for %s', 'CANARY-CHAT-ID', 'CANARY-HANDLE');

        const contents = readLog();
        expect(contents).not.toContain('CANARY-CHAT-ID');
        expect(contents).not.toContain('CANARY-HANDLE');
        expect(contents).toMatch(/\[SENSITIVE suppressed: logger\.test\.js:\d+\]/);
    });

    test('an undefined class does not publish', () => {
        initLogger({ directory });
        // @ts-expect-error deliberately calling with the wrong signature
        log.warn(undefined, 'CANARY-UNDEFINED');

        expect(readLog()).not.toContain('CANARY-UNDEFINED');
    });

    test('a drifted enum value does not publish', () => {
        initLogger({ directory });

        // A plugin compiled against a future fork whose enum gained a third member. Reading LogClass
        // off the context (design §23) is what prevents this, but the gate must not depend on it.
        // @ts-expect-error deliberately calling with the wrong signature
        log.info(2, 'CANARY-DRIFTED');

        expect(readLog()).not.toContain('CANARY-DRIFTED');
    });

    test('null is not mistaken for NORMAL', () => {
        initLogger({ directory });
        // @ts-expect-error deliberately calling with the wrong signature
        log.info(null, 'CANARY-NULL');

        expect(readLog()).not.toContain('CANARY-NULL');
    });

    test('NORMAL is still published — the gate did not simply close', () => {
        initLogger({ directory });
        log.info(LogClass.NORMAL, 'Storage provider registered.');

        expect(readLog()).toContain('Storage provider registered.');
    });
});

describe('suppressed errors stay loud', () => {
    test('a suppressed error surfaces its code on the stub', () => {
        initLogger({ directory });
        const error = new Error('could not read /home/test-user/chats/SampleCharacter/chat.jsonl');
        // @ts-ignore - assigning a code the way node and the storage layer do
        error.code = 'EPROVIDER';
        log.error(LogClass.SENSITIVE, 'Failed to read', error);

        const contents = readLog();
        expect(contents).toContain('EPROVIDER');
        // ...without any part of the message that carries the path.
        expect(contents).not.toContain('SampleCharacter');
        expect(contents).not.toContain('chat.jsonl');
        expect(contents).not.toContain('Failed to read');
    });

    test('falls back to the error type when there is no code', () => {
        initLogger({ directory });
        log.error(LogClass.SENSITIVE, new TypeError('x is not a function'));

        expect(readLog()).toContain('[TypeError]');
    });

    test('a code that is not a constant does not print', () => {
        initLogger({ directory });
        const error = new Error('nope');
        // A code built out of user data must fail the shape check, not be matched by a deny-list.
        // @ts-ignore - deliberately hostile shape
        error.code = '/home/test-user/chats/SampleCharacter.jsonl';
        log.error(LogClass.SENSITIVE, error);

        // The hostile code is rejected and the safe type name is used instead — the fallback is
        // still a constant, and the path never appears.
        const contents = readLog();
        expect(contents).not.toContain('SampleCharacter');
        expect(contents).not.toContain('/home/test-user');
        expect(contents).toContain('[Error]');
    });

    test('a lowercase or overlong code does not print', () => {
        initLogger({ directory });
        const sneaky = new Error('nope');
        // @ts-ignore - deliberately hostile shape
        sneaky.code = 'my-secret-chat-title';
        log.error(LogClass.SENSITIVE, sneaky);

        const overlong = new Error('nope');
        // @ts-ignore - deliberately hostile shape
        overlong.code = 'A'.repeat(64);
        log.error(LogClass.SENSITIVE, overlong);

        const contents = readLog();
        expect(contents).not.toContain('my-secret-chat-title');
        expect(contents).not.toContain('A'.repeat(64));
    });

    test('a non-error argument never contributes a code', () => {
        initLogger({ directory });
        log.error(LogClass.SENSITIVE, { code: 'LOOKS_LIKE_A_CODE', prompt: 'secret' });

        const contents = readLog();
        expect(contents).not.toContain('LOOKS_LIKE_A_CODE');
        expect(contents).not.toContain('secret');
    });
});

describe('debug mode file separation', () => {
    test('debug mode writes to the _DEBUG file and leaves st.log alone', () => {
        initLogger({ directory, debugMode: true });
        log.info(LogClass.NORMAL, 'ordinary line');
        log.info(LogClass.SENSITIVE, 'secret line');

        expect(fs.existsSync(path.join(directory, 'st.log'))).toBe(false);
        expect(readLog('st', true)).toContain('ordinary line');
        expect(readLog('st', true)).toContain('secret line');
    });

    test('debug mode keeps the whole stream out of stdout', () => {
        initLogger({ directory, debugMode: true });
        terminal = [];
        log.info(LogClass.SENSITIVE, 'secret line');

        // A forgotten StandardOutput= in a systemd unit must not put content in the journal.
        expect(terminal.join('')).not.toContain('secret line');
    });

    test('normal mode still echoes to the terminal', () => {
        initLogger({ directory });
        terminal = [];
        log.info(LogClass.NORMAL, 'ordinary line');

        expect(terminal.join('')).toContain('ordinary line');
    });

    test('the debug banner names the file and is unmissable', () => {
        initLogger({ directory, debugMode: true });

        const printed = terminal.join('');
        expect(printed).toContain('DEBUG LOGGING IS ON');
        expect(printed).toContain('st_DEBUG.log');
    });
});

describe('startup buffering', () => {
    test('lines logged before init are flushed, in order', () => {
        log.info(LogClass.NORMAL, 'first');
        log.info(LogClass.NORMAL, 'second');
        log.info(LogClass.NORMAL, 'third');

        expect(readLog()).toBe('');

        initLogger({ directory });

        const contents = readLog();
        expect(contents.indexOf('first')).toBeGreaterThan(-1);
        expect(contents.indexOf('first')).toBeLessThan(contents.indexOf('second'));
        expect(contents.indexOf('second')).toBeLessThan(contents.indexOf('third'));
    });

    test('buffered SENSITIVE lines are gated at flush time, not capture time', () => {
        log.info(LogClass.SENSITIVE, 'the quick brown fox jumped');
        initLogger({ directory });

        expect(readLog()).not.toContain('the quick brown fox jumped');
        expect(readLog()).toMatch(/\[SENSITIVE suppressed: logger\.test\.js:\d+\]/);
    });

    test('buffered lines keep the timestamp of the call, not of the flush', () => {
        log.info(LogClass.NORMAL, 'early line');
        const flushedAt = new Date();
        initLogger({ directory });

        const stamp = readLog().match(/\[([^\]]+)\] \[INFO\] early line/);
        expect(stamp).not.toBeNull();
        expect(new Date(stamp[1]).getTime()).toBeLessThanOrEqual(flushedAt.getTime());
    });

    test('shutdown before init dumps the buffer to stderr', () => {
        log.info(LogClass.NORMAL, 'never made it to a file');
        shutdownLogger();

        expect(terminal.join('')).toContain('never made it to a file');
    });
});

describe('level gate', () => {
    test('drops anything below minLogLevel', () => {
        initLogger({ directory, minLogLevel: LOG_LEVELS.WARN });
        log.debug(LogClass.NORMAL, 'debug line');
        log.info(LogClass.NORMAL, 'info line');
        log.warn(LogClass.NORMAL, 'warn line');

        const contents = readLog();
        expect(contents).not.toContain('debug line');
        expect(contents).not.toContain('info line');
        expect(contents).toContain('warn line');
    });

    test('a below-level SENSITIVE line leaves no stub either', () => {
        initLogger({ directory, minLogLevel: LOG_LEVELS.WARN });
        log.debug(LogClass.SENSITIVE, 'secret');

        expect(readLog()).not.toContain('SENSITIVE suppressed');
    });
});

describe('formatting', () => {
    test('strips ANSI colour codes from the file', () => {
        initLogger({ directory });
        log.info(LogClass.NORMAL, '[32mgreen text[0m');

        const contents = readLog();
        expect(contents).toContain('green text');
        expect(contents).not.toContain('[32m');
    });

    test('carries a local timestamp with its offset, and a level tag', () => {
        initLogger({ directory });
        log.error(LogClass.NORMAL, 'something broke');

        expect(readLog()).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\] \[ERROR\] something broke$/m);
    });

    test('the local timestamp is the wall clock, not UTC relabelled', () => {
        initLogger({ directory });
        const before = new Date();
        log.error(LogClass.NORMAL, 'something broke');

        const stamp = /^\[([^\]]+)\]/m.exec(readLog())?.[1] ?? '';
        // Parsing the offset back out must land on the same instant the call was made...
        expect(Math.abs(new Date(stamp).getTime() - before.getTime())).toBeLessThan(5000);
        // ...and the hour written must be the local hour, which is the whole point of the change.
        expect(Number(stamp.slice(11, 13))).toBe(before.getHours());
    });

    test('timezone: utc restores the Zulu form', () => {
        initLogger({ directory, timezone: 'utc' });
        log.error(LogClass.NORMAL, 'something broke');

        expect(readLog()).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[ERROR\] something broke$/m);
    });

    test('an unrecognised timezone falls back to local rather than throwing', () => {
        initLogger({ directory, timezone: 'Mars/Olympus_Mons' });
        log.error(LogClass.NORMAL, 'something broke');

        expect(readLog()).toMatch(/[+-]\d{2}:\d{2}\] \[ERROR\] something broke$/m);
    });

    test('formats multiple arguments the way console does', () => {
        initLogger({ directory });
        log.info(LogClass.NORMAL, 'count:', 42, { ok: true });

        expect(readLog()).toContain('count: 42 { ok: true }');
    });
});

describe('rotation', () => {
    test('seeds the byte counter from the existing file, so a restart does not reset it', () => {
        const existing = path.join(directory, 'st.log');
        fs.writeFileSync(existing, 'x'.repeat(900 * 1024));

        initLogger({ directory, maxSizeMB: 1 });
        // Well under 1 MB on its own, but not on top of what was already there.
        log.info(LogClass.NORMAL, 'y'.repeat(200 * 1024));

        const archives = fs.readdirSync(directory).filter(name => name.endsWith('.log.gz'));
        expect(archives).toHaveLength(1);
    });

    test('gzips the old file and reopens an empty one', () => {
        initLogger({ directory, maxSizeMB: 1 });
        log.info(LogClass.NORMAL, 'a'.repeat(600 * 1024));
        log.info(LogClass.NORMAL, 'b'.repeat(600 * 1024));

        const archives = fs.readdirSync(directory).filter(name => name.endsWith('.log.gz'));
        expect(archives).toHaveLength(1);
        expect(archives[0]).toMatch(/^st-\d{8}-\d{6}\.log\.gz$/);

        const archived = zlib.gunzipSync(fs.readFileSync(path.join(directory, archives[0]))).toString('utf-8');
        expect(archived).toContain('a'.repeat(600 * 1024));

        // The live file holds only what was written after the rotation.
        const current = readLog();
        expect(current).toContain('b'.repeat(600 * 1024));
        expect(current).not.toContain('a'.repeat(600 * 1024));
    });

    test('keeps at most maxArchives, deleting the oldest', () => {
        initLogger({ directory, maxSizeMB: 1, maxArchives: 2 });

        // Pre-seed archives with names that sort older than anything this run produces.
        for (const stamp of ['20200101-000001', '20200101-000002', '20200101-000003']) {
            fs.writeFileSync(path.join(directory, `st-${stamp}.log.gz`), zlib.gzipSync('old'));
        }

        log.info(LogClass.NORMAL, 'c'.repeat(1100 * 1024));
        log.info(LogClass.NORMAL, 'trigger the size check');

        const archives = fs.readdirSync(directory).filter(name => name.endsWith('.log.gz')).sort();
        expect(archives).toHaveLength(2);
        expect(archives).not.toContain('st-20200101-000001.log.gz');
    });
});

describe('third-party console seam', () => {
    test('routes library output into the log as SENSITIVE', () => {
        initLogger({ directory });
        const original = { ...console };
        installConsoleSeam();

        try {
            console.log('multer staged /home/test-user/uploads/private.png');
        } finally {
            Object.assign(console, original);
        }

        const contents = readLog();
        expect(contents).not.toContain('private.png');
        expect(contents).toContain('SENSITIVE suppressed');
    });
});

/**
 * 🔴 WHAT A SUPPRESSION STUB NAMES, AND WHY THIS IS TESTED RATHER THAN REASONED ABOUT.
 *
 * `DESIGN_MEMORY_PLUGIN_API.md` §23 twice claimed a bare `console.*` suppression reports the caller's file and
 * line. It does not — it reports `unknown` — and BOTH the fork's design doc and the consumer's said the same
 * wrong thing for days, because it is exactly the kind of claim that sounds obviously true. It was found only
 * when it happened to decide a design question and someone tested it.
 *
 * The site is the one piece of information that survives suppression, so what it says is part of the §23
 * contract: it is the concrete benefit a plugin gets for adopting `context.logger` (§23.5.2). These tests
 * exist so the sentence in the doc cannot drift away from the code again.
 */
describe('what the suppression stub names', () => {
    test('🔴 a bare console.* reports `unknown`, NOT the caller — the seam frame is all there is', () => {
        // `captureCallSite` runs under `Error.stackTraceLimit = 1`, so one frame survives after the public
        // logger method is elided. For a console call that frame is the seam's own arrow inside logger.js,
        // which `parseCallSite` skips — so it falls through to `unknown`. The real caller was never captured.
        initLogger({ directory });
        const original = { ...console };
        installConsoleSeam();

        try {
            console.log('a library printing something');
        } finally {
            Object.assign(console, original);
        }

        expect(readLog()).toContain('[SENSITIVE suppressed: unknown]');
    });

    test('🔴 a bare console.ERROR does report its caller — errors pay for the deeper stack', () => {
        // The exception to the test above, and the reason it exists: the one-frame limit is priced on
        // volume, and errors have none. A real install produced five consecutive
        // `[ERROR] [SENSITIVE suppressed: unknown]` lines — an operator told that something failed five
        // times, and given nowhere to look. DEBUG and INFO keep the cheap limit; ERROR raises it.
        initLogger({ directory });
        const original = { ...console };
        installConsoleSeam();

        try {
            console.error('a library reporting a failure');
        } finally {
            Object.assign(console, original);
        }

        // The basename and a line number are the durable part. Pinning the exact line would break on
        // every edit above it and teach the next reader to delete the test.
        expect(readLog()).toMatch(/\[SENSITIVE suppressed: logger\.test\.js:\d+\]/);
        expect(readLog()).not.toContain('[SENSITIVE suppressed: unknown]');
    });

    test('✅ a direct call reports the real caller — this is what adopting context.logger buys', () => {
        initLogger({ directory });
        log.info(LogClass.SENSITIVE, 'a line the plugin logged itself');

        // The file is this one; asserting the basename and a line number is the durable part. Pinning the
        // exact line would break on every edit above it and teach the next reader to delete the test.
        expect(readLog()).toMatch(/\[SENSITIVE suppressed: logger\.test\.js:\d+\]/);
        expect(readLog()).not.toContain('[SENSITIVE suppressed: unknown]');
    });

    test('🔴 a WRAPPER collapses every call site onto the wrapper — never wrap the logger', () => {
        // The trap every consumer walks into, because wrapping is the obvious way to add a fallback for a fork
        // that has no §23. The wrapping arrow becomes the first surviving non-logger.js frame, so all of a
        // plugin's distinct diagnostics report one line. Two calls from two places, one reported site.
        initLogger({ directory });
        const wrapped = (...args) => log.info(LogClass.SENSITIVE, ...args);

        wrapped('first call from here');
        wrapped('second call from somewhere else');

        const sites = [...readLog().matchAll(/\[SENSITIVE suppressed: (logger\.test\.js:\d+)\]/g)].map(m => m[1]);
        expect(sites).toHaveLength(2);
        expect(sites[0]).toBe(sites[1]);
    });

    test('✅ but .bind() is transparent — two calls, two different sites', () => {
        // `.bind()` adds no V8 frame, so it is the safe way to pre-apply a class. This is the shape a consumer
        // should use, and the contrast with the test above is the whole point of documenting it.
        initLogger({ directory });
        const bound = log.info.bind(log, LogClass.SENSITIVE);

        bound('first call from here');
        bound('second call from somewhere else');

        const sites = [...readLog().matchAll(/\[SENSITIVE suppressed: (logger\.test\.js:\d+)\]/g)].map(m => m[1]);
        expect(sites).toHaveLength(2);
        expect(sites[0]).not.toBe(sites[1]);
    });
});

describe('the invariant', () => {
    test('no canary planted through any level reaches the log in normal mode', () => {
        initLogger({ directory });

        const canary = 'CANARY-8f3a1c-DO-NOT-LOG';
        log.debug(LogClass.SENSITIVE, canary);
        log.info(LogClass.SENSITIVE, `chat title: ${canary}`);
        log.warn(LogClass.SENSITIVE, { character: canary });
        log.error(LogClass.SENSITIVE, new Error(`failed on ${canary}`));

        expect(readLog()).not.toContain(canary);
    });

    test('the same canaries all appear in debug mode', () => {
        initLogger({ directory, debugMode: true });

        const canary = 'CANARY-8f3a1c-DO-NOT-LOG';
        log.debug(LogClass.SENSITIVE, canary);
        log.error(LogClass.SENSITIVE, new Error(`failed on ${canary}`));

        const contents = readLog('st', true);
        expect(contents.match(new RegExp(canary, 'g'))).toHaveLength(2);
    });
});

/**
 * `redact()` keeps safe log context while hiding the wrapped value. Values are visible only in debug mode,
 * which writes to the separate `_DEBUG` file.
 */
describe('🙈 redact(): the prose is published, the value is not', () => {
    test('the message survives and the value does not', () => {
        initLogger({ directory });
        log.info(LogClass.NORMAL, 'Using data root:', redact('/home/test-user/secret-place'));
        shutdownLogger();

        const written = readLog();

        // The whole point: an operator reading a default install learns WHAT happened.
        expect(written).toContain('Using data root:');
        expect(written).toContain('<redacted>');
        expect(written).not.toContain('secret-place');

        // And it is a real line, not a stub — no call-site marker at all.
        expect(written).not.toContain('SENSITIVE suppressed');
    });

    test('debug mode reveals the value, and only into the _DEBUG file', () => {
        initLogger({ directory, debugMode: true });
        log.info(LogClass.NORMAL, 'Using data root:', redact('/home/test-user/secret-place'));
        shutdownLogger();

        expect(readLog('st', true)).toContain('/home/test-user/secret-place');
        expect(readLog()).not.toContain('secret-place');
    });

    test('🔴 the mode is read at EMIT time, so lines buffered before initLogger still obey it', () => {
        // Boot lines are recorded before the writer is configured. If the marker resolved when it was
        // created, every one of them would use the default mode rather than the configured one.
        log.info(LogClass.NORMAL, 'Server directory:', redact('/opt/somewhere'));
        initLogger({ directory });
        shutdownLogger();

        const written = readLog();
        expect(written).toContain('Server directory:');
        expect(written).toContain('<redacted>');
        expect(written).not.toContain('/opt/somewhere');
    });

    test('several values in one line are each hidden', () => {
        initLogger({ directory });
        log.info(LogClass.NORMAL, 'Content file copied:', redact('Seraphina.png'), '->', redact('/data/x'));
        shutdownLogger();

        const written = readLog();
        expect(written).toContain('Content file copied:');
        expect(written).not.toContain('Seraphina');
        expect(written).not.toContain('/data/x');
        expect(written.match(/<redacted>/g)).toHaveLength(2);
    });

    test('a plain object that is not a marker is untouched', () => {
        initLogger({ directory });
        log.info(LogClass.NORMAL, 'Config:', { port: 8000 });
        shutdownLogger();

        expect(readLog()).toContain('8000');
    });

    test('⚠️ redact() does NOT downgrade a SENSITIVE line — the class still wins', () => {
        // It is a way to publish a safe sentence, never a way to relax a genuinely sensitive one. A line
        // whose SHAPE is revealing must stay SENSITIVE in full, and if an author marks it that way the
        // gate suppresses the whole thing regardless of any marker inside it.
        initLogger({ directory });
        log.info(LogClass.SENSITIVE, 'Ingested memories for:', redact('Seraphina'));
        shutdownLogger();

        const written = readLog();
        expect(written).toContain('SENSITIVE suppressed');
        expect(written).not.toContain('Ingested memories for');
        expect(written).not.toContain('Seraphina');
    });
});
