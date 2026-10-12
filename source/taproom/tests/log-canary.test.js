import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * 🔴 THE CANARY TEST.
 *
 * A real SillyTavern is booted as a real subprocess, driven through a real generation with uniquely
 * marked user content, and then everything the writer emitted is read back and searched for those
 * marks. The invariant it defends is §3's:
 *
 *   > Nothing that is ciphertext at rest may appear as plaintext in a log.
 *
 * ## What this proves, and what it does not
 *
 * It is a REGRESSION NET, NOT A DISCOVERY TOOL, and the design is explicit about the difference (§6):
 * a canary proves the paths you exercised are clean and says nothing whatever about the paths you
 * never thought to exercise. The discovery was the §5.2 review pass over all 1,449 call sites. This
 * keeps that work from rotting — an upstream merge that reintroduces an unclassified log line fails
 * here rather than quietly restoring the hole.
 *
 * ## Why both modes are run, and why the debug run is the important one
 *
 * The negative assertion alone is VACUOUS and would stay green if the canaries never reached a log
 * call at all — a typo'd endpoint, a 400 nobody noticed, a mock that was never contacted. So the same
 * traffic is driven a second time with `logging.debugMode` on, where every canary MUST appear. That
 * run is what gives the quiet run its meaning: together they say "these strings reached the logger,
 * and the gate is the only reason they are not on disk."
 *
 * The debug run also pins the two properties §4.5 rests cleanup on: the whole stream goes to
 * `<base>_DEBUG.log`, and `<base>.log` is not written at all for that session.
 */

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Where `initLogger` puts the log: the install folder, not the data root (design §4.7). */
const installDirectory = path.resolve(testDirectory, '..');

/**
 * The bait.
 *
 * One mark per thing §6 names, plus the two legs of the backend exchange, so a failure says which
 * class of content escaped rather than just that something did. Every value is filename-safe and
 * distinctive enough that it cannot occur by accident — `validateFileName` rejects separators, and a
 * chat title becomes a path component.
 */
const CANARY = Object.freeze({
    /** A message the user typed. */
    MESSAGE: 'CANARY-CHAT-MESSAGE-a71f',
    /** The character's name. */
    CHARACTER: 'CANARY-CHARACTER-NAME-3c8d',
    /** The chat's title, which is also its filename. */
    CHAT_TITLE: 'CANARY-CHAT-TITLE-5e02',
    /** The persona the user speaks as. */
    PERSONA: 'CANARY-PERSONA-NAME-9b46',
    /** What the backend said back — the response leg, logged separately from the request. */
    REPLY: 'CANARY-BACKEND-REPLY-4d13',
    /**
     * A remote error body. Its own mark because it is the single most common shape in the tree
     * (§5.3.1): a status line with a vendor's error payload glued onto it, where the status is
     * `NORMAL` and the body must not be.
     */
    BACKEND_ERROR: 'CANARY-BACKEND-ERROR-2f19',
});

/**
 * Which marks appear in a body of text.
 * @param {string} haystack Text to search
 * @returns {string[]} The names of every canary found, sorted
 */
function findCanaries(haystack) {
    return Object.entries(CANARY)
        .filter(([, mark]) => haystack.includes(mark))
        .map(([name]) => name)
        .sort();
}

/** Every canary name, for the debug-mode assertion. */
const ALL_CANARIES = Object.keys(CANARY).sort();

/**
 * A fake OpenAI-compatible backend with a working leg and a failing one.
 *
 * The failing leg matters as much as the working one. `chat-completions.js` logs the remote error
 * body on failure, and an error path is where a body most often gets printed by someone who was
 * thinking about diagnosis rather than disclosure.
 * @returns {Promise<{port: number, stop: () => Promise<void>}>} The running backend
 */
async function startCanaryBackend() {
    const server = http.createServer((request, response) => {
        let raw = '';
        request.on('data', chunk => raw += chunk);
        request.on('end', () => {
            if (request.url === '/fail/v1/chat/completions') {
                response.writeHead(500, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: { message: `the model refused: ${CANARY.BACKEND_ERROR}` } }));
                return;
            }

            if (request.url === '/v1/chat/completions') {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({
                    choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: CANARY.REPLY } }],
                    created: 0,
                    model: 'canary-model',
                }));
                return;
            }

            response.writeHead(404);
            response.end();
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    return {
        port: server.address().port,
        stop: async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        },
    };
}

/**
 * POST some JSON at the server under test, and do not care what it says back.
 *
 * Status codes are deliberately not asserted on. What this test observes is what the server WROTE,
 * and a request that fails is every bit as interesting as one that succeeds — more so, because the
 * failure paths are the ones that print bodies.
 * @param {number} port Port the server is listening on
 * @param {string} url Path to post to
 * @param {object} body JSON body
 * @param {Record<string, string>} [headers] Extra headers
 * @returns {Promise<void>}
 */
async function post(port, url, body, headers = {}) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}${url}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
        await response.text();
    } catch {
        // A refused or aborted request still exercised whatever ran before it died.
    }
}

/**
 * Drive the traffic that carries the canaries.
 *
 * The order is not arbitrary. The first `chats/get` only creates the character's chat directory and
 * returns; the second one is the one that reaches `getChatData` and logs `File not found: <path>` —
 * which is how the chat TITLE and the character NAME get in front of the logger at all, both of them
 * being path components rather than payload.
 * @param {number} port The SillyTavern port
 * @param {number} backendPort The fake backend's port
 * @returns {Promise<void>}
 */
async function driveTraffic(port, backendPort) {
    const avatar = `${CANARY.CHARACTER}.png`;
    const chat = [
        { user_name: CANARY.PERSONA, character_name: CANARY.CHARACTER, create_date: '2026-07-19', chat_metadata: {} },
        { name: CANARY.PERSONA, is_user: true, mes: CANARY.MESSAGE },
    ];

    // Creates the directory, returns nothing.
    await post(port, '/api/chats/get', { avatar_url: avatar, file_name: CANARY.CHAT_TITLE });
    // Directory exists, file does not — this is the one that logs the path.
    await post(port, '/api/chats/get', { avatar_url: avatar, file_name: CANARY.CHAT_TITLE });
    await post(port, '/api/chats/save', { avatar_url: avatar, file_name: CANARY.CHAT_TITLE, chat, force: true });
    await post(port, '/api/chats/get', { avatar_url: avatar, file_name: CANARY.CHAT_TITLE });
    await post(port, '/api/characters/all', { shallow: false });

    /**
     * A generation body of the shape the client actually sends, aimed at the fake backend.
     * @param {string} suffix Path prefix selecting the working or failing leg
     * @returns {object} The request body
     */
    const generation = (suffix) => ({
        chat_completion_source: 'custom',
        custom_url: `http://127.0.0.1:${backendPort}${suffix}/v1`,
        model: 'canary-model',
        messages: [
            { role: 'system', content: `You are ${CANARY.CHARACTER}. You are speaking with ${CANARY.PERSONA}.` },
            { role: 'user', content: CANARY.MESSAGE },
        ],
        max_tokens: 40,
        temperature: 0.5,
        stream: false,
        char_name: CANARY.CHARACTER,
        user_name: CANARY.PERSONA,
    });

    // The identity headers ride along because a real client sends them, and a middleware that logged
    // request headers would be exactly the kind of regression this test exists to catch.
    const identity = {
        'X-ST-Char-Name': CANARY.CHARACTER,
        'X-ST-Chat-Id': CANARY.CHAT_TITLE,
        'X-ST-Persona-Id': CANARY.PERSONA,
    };

    await post(port, '/api/backends/chat-completions/generate', generation(''), identity);
    await post(port, '/api/backends/chat-completions/generate', generation('/fail'), identity);
}

/**
 * What one session wrote.
 * @typedef {object} SessionOutput
 * @property {string} file Contents of the log file the writer opened
 * @property {string} terminal Everything the child wrote to stdout and stderr
 * @property {string} quietPath Path of the non-debug log file for this session
 * @property {string} debugPath Path of the debug log file for this session
 */

/** Log files this run created, so they can be removed whatever happens. */
const logFilesCreated = [];

/**
 * Boot a SillyTavern with a log file of its own, drive the canary traffic, shut it down, and read
 * back everything it emitted.
 *
 * The log file goes in the install folder because that is where §4.7 puts it and this test is not
 * entitled to a different answer than the one that ships. It gets a unique base name so parallel Jest
 * workers cannot read each other's output, and both variants are deleted afterwards.
 * @param {object} options Session options
 * @param {boolean} options.debugMode Whether to turn `logging.debugMode` on
 * @param {number} options.backendPort The fake backend's port
 * @returns {Promise<SessionOutput>} What the session wrote
 */
async function runSession({ debugMode, backendPort }) {
    const label = debugMode ? 'debug' : 'quiet';
    const base = `st-canary-${label}-${process.env.JEST_WORKER_ID ?? '1'}-${process.pid}`;
    const quietPath = path.join(installDirectory, `${base}.log`);
    const debugPath = path.join(installDirectory, `${base}_DEBUG.log`);
    logFilesCreated.push(quietPath, debugPath);

    const scratch = makeScratchDirectory(`log-canary-${label}`);
    const dataRoot = path.join(scratch, 'data');
    const configPath = path.join(scratch, 'config.yaml');
    fs.mkdirSync(dataRoot, { recursive: true });

    const server = await startSillyTavern({
        dataRoot,
        configPath,
        configEnv: {
            SILLYTAVERN_LOGGING_FILE: base,
            SILLYTAVERN_LOGGING_DEBUGMODE: String(debugMode),
        },
    });

    try {
        // A throw carrying the child's output, not an `expect`. This runs inside `beforeAll`, where a
        // bare assertion reports "expected true, received false" and discards the only thing that says
        // why the server did not come up — which is precisely the diagnostic you want when this first
        // runs somewhere other than the machine it was written on.
        if (!server.listening) throw new Error(`SillyTavern did not start.\n\n${server.output()}`);
        await driveTraffic(server.port, backendPort);
    } finally {
        await server.stop();
    }

    const written = debugMode ? debugPath : quietPath;

    return {
        file: fs.existsSync(written) ? fs.readFileSync(written, 'utf-8') : '',
        terminal: server.output(),
        quietPath,
        debugPath,
    };
}

describe('log hygiene — the canary test (DESIGN_LOG_HYGIENE.md §6)', () => {
    /** @type {{port: number, stop: () => Promise<void>}} */
    let backend;
    /** @type {SessionOutput} */
    let quiet;
    /** @type {SessionOutput} */
    let debug;

    beforeAll(async () => {
        backend = await startCanaryBackend();
        // Serially, not in parallel: two boots at once double the peak load on a machine that may
        // already be running twenty-five other suites, and the boot timeout is the thing that breaks.
        quiet = await runSession({ debugMode: false, backendPort: backend.port });
        debug = await runSession({ debugMode: true, backendPort: backend.port });
    }, 480_000);

    afterAll(async () => {
        await backend?.stop();

        for (const file of logFilesCreated) {
            try {
                fs.unlinkSync(file);
            } catch {
                // Never written, or already gone. Either is fine.
            }
        }
    });

    describe('debug mode off — the shipping default', () => {
        test('no user content reaches the log file', () => {
            expect(findCanaries(quiet.file)).toEqual([]);
        });

        test('no user content reaches the terminal, which under systemd is the journal', () => {
            expect(findCanaries(quiet.terminal)).toEqual([]);
        });

        test('the suppressed lines left their call sites behind, so the trace survives', () => {
            // Without this the test above passes just as well against a log that is empty because the
            // server never ran. Evidence that the gate FIRED, repeatedly, on lines that had something
            // to say — which is the state the design intends (§4.4).
            const stubs = quiet.file.match(/\[SENSITIVE suppressed: [^\]]+\]/g) ?? [];
            const redactions = quiet.file.match(/<redacted>/g) ?? [];

            // 🔴 THIS COUNT IS A VACUITY GUARD AND MUST NOT BE QUIETLY LOWERED. It used to read
            // `stubs.length > 10`, and it broke — legitimately — when the three noisiest boot sites were
            // converted to `redact()`, which publishes the prose and hides only the value. That is the
            // gate working BETTER, not less: a `<redacted>` line proves suppression fired just as a stub
            // does, and tells the operator what happened as well. So both count, and the total threshold
            // stays where it was rather than being relaxed to fit.
            expect(stubs.length + redactions.length).toBeGreaterThan(10);

            // Both mechanisms must actually be exercised by a real boot — otherwise this could pass on
            // stubs alone while `redact()` was silently broken, or vice versa.
            expect(stubs.length).toBeGreaterThan(0);
            expect(redactions.length).toBeGreaterThan(0);

            // And the trace the test is named for: a stub that cannot name its origin is the worst thing
            // this mechanism produces — "something failed and you may not know what" — so none of them
            // may be anonymous.
            expect(stubs.filter(stub => stub.includes('unknown'))).toEqual([]);
        });

        test('🔴 the boot lines that were redacted kept their PROSE — the point of the exercise', () => {
            // 2300 stubs across 40 sites on a default install, and the top three were 1825 of them: all
            // boot lines whose prose was safe and whose only secret was a path. Three anonymous stubs at
            // startup read exactly like three failures. These now say what happened.
            expect(quiet.file).toContain('Server directory:');
            expect(quiet.file).toContain('Using config path:');
            expect(quiet.file).toContain('Using data root:');

            // ...and still not what the value was. `findCanaries` above covers user content; this covers
            // the specific paths these three lines carry.
            expect(quiet.file).toContain('<redacted>');
        });

        test('the log was written, and the debug file was not', () => {
            expect(quiet.file.length).toBeGreaterThan(0);
            expect(fs.existsSync(quiet.debugPath)).toBe(false);
        });
    });

    describe('debug mode on — the operator asked for everything', () => {
        test('every canary appears, which is what makes the quiet run mean something', () => {
            // 🔴 THE LOAD-BEARING ASSERTION. If a canary is missing here it did not reach the logger,
            // so the corresponding "it did not leak" above proved nothing at all. Any failure in this
            // test invalidates the quiet run rather than merely reporting a debug-mode bug.
            expect(findCanaries(debug.file)).toEqual(ALL_CANARIES);
        });

        test('the whole stream went to the _DEBUG file and st.log was never opened (§4.5)', () => {
            expect(fs.existsSync(debug.debugPath)).toBe(true);
            expect(fs.existsSync(debug.quietPath)).toBe(false);
        });

        test('content did not also go to the terminal, so a systemd unit cannot re-leak it', () => {
            // §4.5: in debug mode the stream goes to the file only. The banner is the deliberate
            // exception and carries no content.
            expect(findCanaries(debug.terminal)).toEqual([]);
        });

        test('the operator was warned, unmissably, on the terminal (§4.8)', () => {
            expect(debug.terminal).toContain('DEBUG LOGGING IS ON');
            expect(debug.terminal).toContain(debug.debugPath);
        });
    });
});
