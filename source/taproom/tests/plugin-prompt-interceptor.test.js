import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

// A scratch directory, not the repository's real `plugins/`. The fork now honours `pluginsPath`, so a
// suite no longer has to share one process-wide directory with every other suite AND with whatever is
// genuinely installed on the machine.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');
const CONTEXT_FIXTURE = path.join(testDirectory, 'fixtures', 'context-plugin.mjs');

/** What the fixture injects. Must match `INJECTED` in context-plugin.mjs. */
const INJECTED = '[[MEMORY-INJECTED-BY-PLUGIN]] ';
/** What the client "sent". */
const ORIGINAL_PROMPT = 'The original prompt the client rendered.';
/** The budget the client fits the prompt to, and sends because the backend needs it too. */
const BUDGET = 4096;
/** Identity the client sends in headers. Non-ASCII and a space, to prove the encode/decode round-trip. */
const CHAR_NAME = 'Aria ✨';
const CHAT_ID = 'chat 2026-07-17';

/** Every shim we installed, so afterAll can take them out again. */
const installed = [];

/**
 * Turn an absolute path into something an `import` statement will accept on any platform.
 * @param {string} absolutePath The path to import
 * @returns {string} A file:// URL
 */
function pathToImportSpecifier(absolutePath) {
    return new URL(`file:///${absolutePath.split(path.sep).join('/')}`).href;
}

/**
 * Install the probe plugin. See `plugin-context.test.js` for why this writes into the real `plugins/`.
 * @param {string} name Base name for the installed shim
 * @returns {void}
 */
function installProbe(name) {
    const target = path.join(PLUGINS_DIRECTORY, `${name}.mjs`);
    fs.writeFileSync(target, `export { info, init } from ${JSON.stringify(pathToImportSpecifier(CONTEXT_FIXTURE))};\n`, 'utf-8');
    installed.push(target);
}

/**
 * 🔴 A FAKE KOBOLDCPP THAT WRITES DOWN WHAT IT WAS ACTUALLY SENT.
 *
 * This is the only witness that matters. A test that asserts the interceptor RAN proves the interceptor ran;
 * it does not prove the rewritten prompt survived the twenty lines between the hook and the socket. The
 * backend is the far end of the wire, and what arrives here is, by definition, what the model would have
 * seen.
 * @returns {Promise<{url: string, bodies: any[], close: () => Promise<void>}>} The fake backend
 */
async function startFakeBackend() {
    /** @type {any[]} */
    const bodies = [];

    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => body += chunk.toString());
        request.on('end', () => {
            try {
                bodies.push({ url: request.url, body: JSON.parse(body), headers: request.headers });
            } catch {
                bodies.push({ url: request.url, body: null, raw: body, headers: request.headers });
            }

            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ text: 'ok' }] }));
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = /** @type {any} */ (server.address());

    return {
        url: `http://127.0.0.1:${port}`,
        bodies,
        close: () => new Promise(resolve => server.close(() => resolve(undefined))),
    };
}

/**
 * 🔴 CAN A SERVER PLUGIN ACTUALLY CHANGE WHAT THE MODEL SEES?
 *
 * A model has no memory and reads no database. Everything it appears to know arrived in the prompt. So the
 * whole of a memory plugin's value rests on one thing: can it put text into the prompt from the server?
 * Retrieval that cannot reach the prompt is a database nobody reads.
 *
 * SillyTavern has generation interceptors on the CLIENT (`runGenerationInterceptors`), and every stock
 * extension that puts text into a prompt uses them. The server has none. This is that feature, mirrored --
 * and this suite drives it end to end, through a real boot, into a real socket, with a fake KoboldCPP at the
 * far end writing down what it was sent.
 */
describe('the server-side generation interceptor', () => {
    /** @type {any} */
    let backend;
    /** @type {string[]} */
    let lines = [];
    /** @type {number} */
    let generateStatus = 0;

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-prompt');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const journalPath = path.join(scratch, 'plugin-journal.txt');

        installProbe('zz-prompt-probe');
        backend = await startFakeBackend();

        // No provider and no accounts: an interceptor needs neither. The default user is auto-logged-in, so
        // `request.user` is populated and the hook still gets a handle.
        const server = await startSillyTavern({
            dataRoot,
            configPath,
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                // Only OUR fixtures register. Jest runs suites in parallel and plugins/ is shared and not
                // configurable, so another suite's shim may be on disk while this server boots (fixture-gate.mjs).
                ST_FIXTURE_IDS: 'context-probe',
                ST_PLUGIN_JOURNAL: journalPath,
            },
        });

        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);

        // Drive a real generation. CSRF is disabled by the harness, so this is the same request the client
        // would make.
        const generate = await fetch(`http://127.0.0.1:${server.port}/api/backends/text-completions/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-ST-Char-Name': encodeURIComponent(CHAR_NAME),
                'X-ST-Chat-Id': encodeURIComponent(CHAT_ID),
            },
            body: JSON.stringify({
                api_type: 'koboldcpp',
                api_server: backend.url,
                prompt: ORIGINAL_PROMPT,
                truncation_length: BUDGET,
                stream: false,
                max_tokens: 16,
            }),
        });

        generateStatus = generate.status;

        await server.stop();
        lines = fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
            : [];
    }, 120_000);

    afterAll(async () => {
        await backend?.close();

        for (const target of installed) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the generation reached the backend at all — otherwise nothing below means anything', () => {
        expect(generateStatus).toBe(200);
        expect(backend.bodies.length).toBeGreaterThan(0);
        expect(backend.bodies[0].url).toBe('/v1/completions');
    });

    test('the interceptor fires, and is told which backend and which user', () => {
        expect(lines).toContain('prompt intercepted, backend: text');
        expect(lines).toContain('prompt handle: default-user');
        expect(lines).toContain('prompt apiType: koboldcpp');
    });

    test('it is handed the rendered string, not a messages array', () => {
        expect(lines).toContain('prompt is string: true');
        expect(lines).toContain('prompt messages present: false');
        expect(lines).toContain(`prompt saw: ${JSON.stringify(ORIGINAL_PROMPT)}`);
    });

    test('🔴 the token budget is there, with no client change and nothing plumbed', () => {
        // The claim that the server never sees this was the single most expensive wrong belief in the
        // handoff. The client sends it because KoboldCPP needs it too. This is the assertion that keeps
        // anyone from "fixing" it again.
        expect(lines).toContain(`prompt budget: ${BUDGET}`);
    });

    test('🔴 the rewritten prompt reaches the BACKEND — the only witness that counts', () => {
        // Not "the interceptor ran". What the model would actually have seen.
        const sent = backend.bodies[0].body;
        expect(sent.prompt).toBe(`${INJECTED}${ORIGINAL_PROMPT}`);
    });

    test('⚠️ and nothing else was added to the body on the way', () => {
        // text-completions serialises request.body VERBATIM. Anything the fork bolted on for its own
        // convenience would be transmitted to KoboldCPP, and a strict backend would reject the lot.
        const sent = backend.bodies[0].body;
        expect(sent).not.toHaveProperty('budget');
        expect(sent).not.toHaveProperty('handle');
        expect(sent).not.toHaveProperty('backend');
        expect(sent).not.toHaveProperty('charName');
        expect(sent).not.toHaveProperty('chatId');
        expect(sent.truncation_length).toBe(BUDGET);
    });

    test('🔴 character and chat identity reach the interceptor, decoded — and never the backend', () => {
        // Sent as URL-encoded headers; the interceptor sees them decoded...
        expect(lines).toContain(`prompt charName: ${CHAR_NAME}`);
        expect(lines).toContain(`prompt chatId: ${CHAT_ID}`);

        // ...and the backend fetch, which builds its own headers, never forwards the client's. Robust by
        // construction: identity is not in the body (asserted above) and not in the headers that left for the
        // backend. This is the whole reason it rides out-of-band instead of in request.body.
        const sent = backend.bodies[0];
        expect(sent.headers).not.toHaveProperty('x-st-char-name');
        expect(sent.headers).not.toHaveProperty('x-st-chat-id');
    });
});

/**
 * 🔴 THE OTHER FAMILY — and the reason this suite exists at all.
 *
 * The chat path was written, reviewed, and shipped 412 green tests with a MISSING IMPORT: every generation
 * through it would have thrown `ReferenceError: hasPromptInterceptors is not defined`. Nothing noticed,
 * because every test drove the text path. Lint caught it; the tests did not.
 *
 * So the chat path gets its own witness. One insertion point above the vendor dispatch is supposed to reach
 * all twenty backends -- this drives one of them and checks the far end of the wire.
 */
describe('the generation interceptor on the chat completions path', () => {
    /** @type {any} */
    let backend;
    /** @type {string[]} */
    let lines = [];
    /** @type {number} */
    let generateStatus = 0;

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-prompt-chat');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const journalPath = path.join(scratch, 'plugin-journal.txt');

        installProbe('zz-prompt-chat-probe');
        backend = await startFakeBackend();

        const server = await startSillyTavern({
            dataRoot,
            configPath,
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                // Only OUR fixtures register. Jest runs suites in parallel and plugins/ is shared and not
                // configurable, so another suite's shim may be on disk while this server boots (fixture-gate.mjs).
                ST_FIXTURE_IDS: 'context-probe',
                ST_PLUGIN_JOURNAL: journalPath,
            },
        });

        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);

        // 'custom' is the one source that needs no API key and takes a URL, so it can be pointed at a fake
        // backend without planting secrets. It falls through to the generic OpenAI-shaped sender.
        const generate = await fetch(`http://127.0.0.1:${server.port}/api/backends/chat-completions/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-ST-Char-Name': encodeURIComponent(CHAR_NAME),
                'X-ST-Chat-Id': encodeURIComponent(CHAT_ID),
            },
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: backend.url,
                model: 'test-model',
                messages: [{ role: 'user', content: ORIGINAL_PROMPT }],
                stream: false,
            }),
        });

        generateStatus = generate.status;

        await server.stop();
        lines = fs.existsSync(journalPath)
            ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean)
            : [];
    }, 120_000);

    afterAll(async () => {
        await backend?.close();

        // 🔴 TAKE THE SHIM BACK OUT. This suite installed one and left it behind on every run since it was
        // written — `plugins/` is gitignored, so nothing ever said so. What stayed is not inert: it
        // re-exports the context probe, which registers a prompt interceptor that injects
        // `[[MEMORY-INJECTED-BY-PLUGIN]]` into everything it sees. Any later boot with server plugins enabled
        // — a real one included — would load it and rewrite real prompts.
        for (const target of installed) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the generation reached the backend at all', () => {
        expect(generateStatus).toBe(200);
        expect(backend.bodies.length).toBeGreaterThan(0);
        expect(backend.bodies[0].url).toBe('/chat/completions');
    });

    test('the interceptor fires, and is handed messages[] rather than a string', () => {
        expect(lines).toContain('prompt intercepted, backend: chat');
        expect(lines).toContain('prompt apiType: custom');
        expect(lines).toContain('prompt messages present: true');
        expect(lines).toContain('prompt is string: false');
    });

    test('⚠️ the budget is undefined here, and that is the truth rather than an oversight', () => {
        // Chat completions does not send the input context budget -- `openai_max_context` stays in the
        // browser. If this ever becomes a number, someone plumbed it and this test should be updated
        // rather than deleted.
        expect(lines).toContain('prompt budget: undefined');
    });

    test('🔴 the rewritten messages reach the BACKEND, through the vendor conversion', () => {
        const sent = backend.bodies[0].body;
        expect(sent.messages[0]).toEqual({ role: 'system', content: INJECTED.trim() });
        expect(sent.messages[1]).toEqual({ role: 'user', content: ORIGINAL_PROMPT });
    });

    test('🔴 character and chat identity reach the chat-path interceptor too', () => {
        expect(lines).toContain(`prompt charName: ${CHAR_NAME}`);
        expect(lines).toContain(`prompt chatId: ${CHAT_ID}`);
    });
});
