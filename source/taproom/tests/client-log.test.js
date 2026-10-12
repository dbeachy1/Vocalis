import { describe, test, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { router, resetClientLogBudgets } from '../src/endpoints/client-log.js';
import { initLogger, resetLoggerForTests } from '../src/logger.js';
import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * 🔴 THIS ROUTE IS THE ONE PLACE A BROWSER CAN WRITE INTO `st.log`, so the thing under test is not
 * "does it log" — it is *what it refuses to log unsuppressed*. `DESIGN_LOG_HYGIENE.md` §7 records
 * the browser console as out of scope precisely because it never reaches disk; this route is what
 * that sentence assumed away, and these tests are the reason it stays assumed-away safely.
 *
 * Everything runs against the REAL writer, reading the REAL file back, because the invariant in §3
 * is about bytes on disk. A test that asserted on mock calls would prove the handler's intent and
 * say nothing about the file, which is the only artifact that matters here.
 */

/** @type {string} */
let directory;
/** @type {import('@jest/globals').jest.SpiedFunction<any>} */
let stdoutSpy;
/** @type {import('@jest/globals').jest.SpiedFunction<any>} */
let stderrSpy;

beforeEach(() => {
    directory = makeScratchDirectory('client-log');
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    resetClientLogBudgets();
});

afterEach(() => {
    resetLoggerForTests();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * Reads back whichever file the writer opened for this test.
 * @param {boolean} [debug] Read `st_DEBUG.log` instead of `st.log`
 * @returns {string} Contents, or '' when the file was never created
 */
function readLog(debug = false) {
    const target = path.join(directory, debug ? 'st_DEBUG.log' : 'st.log');
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
}

/** The POST handler, taken straight off the router — Express's own dispatch is not under test. */
const handler = router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post).route.stack[0].handle;

/**
 * Drives the handler once and reports what it answered.
 * @param {object} body Request body
 * @returns {{status:number, payload:any}} What the handler sent
 */
function post(body) {
    const result = { status: 200, payload: undefined };
    const response = {
        status(code) {
            result.status = code;
            return this;
        },
        send(payload) {
            result.payload = payload;
            return this;
        },
        sendStatus(code) {
            result.status = code;
            return this;
        },
    };
    handler({ body }, response);
    return result;
}

/** A well-formed Vocalis polish report, with one field of each classifiable type. */
function polishReport(overrides = {}) {
    return {
        source: 'vocalis-polish',
        event: 'polish_failed',
        code: 'generate',
        fields: {
            durationMs: 4192,
            inputChars: 238,
            immediateSend: false,
            backend: 'Error: Got response status 500 | payload: {"error":{"message":"model is overloaded"}}',
            host: 'Chat Completion API — model is overloaded',
        },
        ...overrides,
    };
}

describe('the classification split', () => {
    test('with debug mode off, the log names the failure and its numbers but not the provider text', () => {
        initLogger({ directory });

        expect(post(polishReport()).status).toBe(204);

        const written = readLog();
        expect(written).toContain('[client-log] vocalis-polish polish_failed code=generate');
        expect(written).toContain('durationMs=4192');
        expect(written).toContain('inputChars=238');
        expect(written).toContain('immediateSend=false');
        // 🔴 The whole point. A remote error body is `SENSITIVE` per §5.3.1 ("a status line with a
        // remote error body glued onto it: status and statusText go NORMAL, the body goes to its
        // own SENSITIVE line"), and it must not be on disk with the gate closed.
        expect(written).not.toContain('model is overloaded');
        expect(written).not.toContain('Chat Completion API');
    });

    test('no error line is suppressed in its entirety', () => {
        initLogger({ directory });

        // Nothing but strings: the `NORMAL` half has no values of its own to carry.
        post(polishReport({ code: undefined, fields: { backend: 'model is overloaded' } }));

        // §5.3.1: "At ERROR, a split is always required: no error line may be suppressed in its
        // entirety." The operator must still learn which source and which event fired.
        const lines = readLog().trim().split('\n').filter(line => line.includes('client-log'));
        expect(lines.some(line => line.includes('vocalis-polish polish_failed') && !line.includes('suppressed'))).toBe(true);
    });

    test('with debug mode on, the provider text reaches disk verbatim', () => {
        initLogger({ directory, debugMode: true });

        post(polishReport());

        const written = readLog(true);
        expect(written).toContain('model is overloaded');
        expect(written).toContain('Chat Completion API');
        // §4.5 — the debug run writes the whole stream to its own file and leaves `st.log` alone.
        expect(readLog()).toBe('');
    });
});

describe('what the route refuses', () => {
    test('an unregistered source is rejected outright', () => {
        initLogger({ directory });

        expect(post(polishReport({ source: 'some-other-extension' })).status).toBe(400);
        expect(readLog()).not.toContain('some-other-extension');
    });

    test('an event or code carrying prose is rejected, so neither can smuggle content', () => {
        initLogger({ directory });

        // A chat title, a character name and a sentence all fail the lower-case-slug pattern that
        // makes these two fields safe to print unsuppressed.
        expect(post(polishReport({ event: 'Seraphina asks about the lantern' })).status).toBe(400);
        expect(post(polishReport({ event: 'Seraphina' })).status).toBe(400);
        expect(post(polishReport({ code: 'She hands me the lantern' })).status).toBe(400);
        expect(readLog()).not.toContain('Seraphina');
        expect(readLog()).not.toContain('lantern');
    });

    test('a field name that is not an identifier is dropped rather than logged', () => {
        initLogger({ directory, debugMode: true });

        post(polishReport({ fields: { 'I whisper, "hello"': 12, durationMs: 7 } }));

        expect(readLog(true)).toContain('durationMs=7');
        expect(readLog(true)).not.toContain('I whisper');
    });

    test('a newline in a value cannot forge a second log record', () => {
        initLogger({ directory, debugMode: true });

        post(polishReport({ fields: { backend: 'first line\n2026-01-01 00:00:00 [INFO] forged' } }));

        const written = readLog(true);
        expect(written).toContain('first line ⏎ 2026-01-01');
        expect(written.split('\n').filter(line => line.includes('forged')).length).toBe(1);
    });

    test('a long value is capped', () => {
        initLogger({ directory, debugMode: true });

        post(polishReport({ fields: { backend: 'x'.repeat(9000) } }));

        expect(readLog(true)).not.toContain('x'.repeat(2001));
    });
});

describe('the budget', () => {
    test('a runaway sender is cut off and the log says so once', () => {
        initLogger({ directory });

        for (let attempt = 0; attempt < 60; attempt++) {
            expect(post(polishReport()).status).toBe(204);
        }

        const written = readLog();
        // 30 reports, one `NORMAL` line each, plus exactly one line saying the rest were dropped.
        expect(written.split('\n').filter(line => line.includes('polish_failed')).length).toBe(30);
        expect(written.split('\n').filter(line => line.includes('exceeded its 30/minute budget')).length).toBe(1);
    });
});

describe('the route is actually reachable', () => {
    /**
     * 🔴 EVERYTHING ABOVE CALLS THE HANDLER DIRECTLY, WHICH PROVES NOTHING ABOUT IT BEING MOUNTED.
     * A route that is written and never registered in `server-startup.js` passes every test above
     * and 404s in the browser — and the sender treats a 404 as "older build, stop trying", so the
     * symptom would be silence, which is the exact failure this whole feature exists to end. So a
     * real SillyTavern is booted and posted to over real HTTP.
     *
     * The boot lives in `beforeAll` for the same reason the canary's does: it is the slow part, it
     * is shared, and a throw here carries the child's output instead of an assertion that discards
     * the only thing saying why the server never came up.
     */
    /** @type {{accepted:number, refused:number, written:string}} */
    let session;

    beforeAll(async () => {
        const scratch = makeScratchDirectory('client-log-live');
        const base = `st-client-log-${process.env.JEST_WORKER_ID ?? '1'}-${process.pid}`;
        const logPath = path.join(process.cwd(), '..', `${base}.log`);
        fs.mkdirSync(path.join(scratch, 'data'), { recursive: true });

        const server = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
            configEnv: { SILLYTAVERN_LOGGING_FILE: base },
        });

        try {
            if (!server.listening) throw new Error(`SillyTavern did not start.

${server.output()}`);

            const post = body => fetch(`http://127.0.0.1:${server.port}/api/client-log`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            const accepted = await post(polishReport());
            const refused = await post(polishReport({ source: 'not-registered' }));
            session = { accepted: accepted.status, refused: refused.status, written: '' };
        } finally {
            await server.stop();
        }

        session.written = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
        fs.rmSync(logPath, { force: true });
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }, 240_000);

    test('a real SillyTavern accepts a registered report and refuses an unregistered one', () => {
        expect(session.accepted).toBe(204);
        expect(session.refused).toBe(400);
    });

    test('and what it wrote to its own log is the classified line, not the provider text', () => {
        expect(session.written).toContain('[client-log] vocalis-polish polish_failed code=generate');
        expect(session.written).toContain('durationMs=4192');
        expect(session.written).not.toContain('model is overloaded');
        expect(session.written).not.toContain('not-registered');
    });
});
