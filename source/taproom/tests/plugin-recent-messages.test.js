import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';

import {
    RECENT_MESSAGES_FIELD,
    clearPromptInterceptors,
    listPromptDeclarations,
    onPrompt,
    readIdentityHeaders,
    runPromptInterceptors,
    takeRecentMessages,
} from '../src/generation-interceptors.js';
import { log } from '../src/logger.js';
import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
// A scratch directory, not the repository's real `plugins/`. The fork now honours `pluginsPath`, so a
// suite no longer has to share one process-wide directory with every other suite AND with whatever is
// genuinely installed on the machine.
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins');

/**
 * A turn as the client sends one.
 * @param {number} index Its position in the full chat
 * @returns {object} The turn
 */
const turn = (index) => ({ role: index % 2 ? 'assistant' : 'user', name: index % 2 ? 'Aria' : 'Test User', content: `turn ${index}`, index });

describe('takeRecentMessages — the strip, which is the whole safety property', () => {
    /**
     * @param {any} body What the client posted
     * @returns {any} Something shaped enough like an Express request
     */
    const fakeRequest = (body) => ({ body });

    test('takes the turns off the body AND REMOVES THEM FROM IT', () => {
        // 🔴 THE DELETE IS THE POINT. `text-completions.js` serialises `request.body` to the backend VERBATIM,
        // so a window left on the body is the user's recent conversation, structured, posted to the model
        // host as an unrecognised field. Every other assertion in this file is downstream of this one.
        const request = fakeRequest({ prompt: 'hello', [RECENT_MESSAGES_FIELD]: [turn(0), turn(1)] });

        const taken = takeRecentMessages(request);

        expect(taken).toHaveLength(2);
        expect(request.body).not.toHaveProperty(RECENT_MESSAGES_FIELD);
        expect(request.body.prompt).toBe('hello');
    });

    test('projects onto exactly {role, name, content, index} — ST internals cannot get through', () => {
        // Not a second normalizer (the client already normalized); a projection, so that no matter what a
        // client sends, `mes` and `is_user` cannot reach a plugin.
        const request = fakeRequest({
            [RECENT_MESSAGES_FIELD]: [{ role: 'user', name: 'Test User', content: 'hi', index: 0, mes: 'hi', is_user: true, extra: {} }],
        });

        expect(takeRecentMessages(request)).toEqual([{ role: 'user', name: 'Test User', content: 'hi', index: 0 }]);
    });

    test('a nameless turn keeps no name key at all', () => {
        const request = fakeRequest({ [RECENT_MESSAGES_FIELD]: [{ role: 'system', content: 'x', index: 4 }] });

        expect(takeRecentMessages(request)).toEqual([{ role: 'system', content: 'x', index: 4 }]);
    });

    test('a malformed window is dropped WHOLE, loudly — never passed on in part', () => {
        // Half a window silently is the failure mode this document keeps designing against. `undefined` means
        // "unknown", which is the honest answer and the one §17.6 made fail-safe.
        const error = jest.spyOn(log, 'error').mockImplementation(() => { });

        expect(takeRecentMessages(fakeRequest({ [RECENT_MESSAGES_FIELD]: [turn(0), { role: 'user' }] }))).toBeUndefined();
        expect(takeRecentMessages(fakeRequest({ [RECENT_MESSAGES_FIELD]: [{ role: 'wizard', content: 'x', index: 0 }] }))).toBeUndefined();
        expect(takeRecentMessages(fakeRequest({ [RECENT_MESSAGES_FIELD]: [{ role: 'user', content: 'x', index: 1.5 }] }))).toBeUndefined();
        expect(takeRecentMessages(fakeRequest({ [RECENT_MESSAGES_FIELD]: 'not an array' }))).toBeUndefined();
        expect(error).toHaveBeenCalled();

        error.mockRestore();
    });

    test('a malformed window is STILL stripped from the body', () => {
        // Dropping it for plugins must never mean leaving it on the wire.
        const error = jest.spyOn(log, 'error').mockImplementation(() => { });
        const request = fakeRequest({ [RECENT_MESSAGES_FIELD]: 'garbage' });

        takeRecentMessages(request);

        expect(request.body).not.toHaveProperty(RECENT_MESSAGES_FIELD);
        error.mockRestore();
    });

    test('an absent field yields undefined and touches nothing', () => {
        const request = fakeRequest({ prompt: 'hello' });

        expect(takeRecentMessages(request)).toBeUndefined();
        expect(request.body).toEqual({ prompt: 'hello' });
    });

    test('an empty window is [] — a chat with no turns is not the same as no window', () => {
        expect(takeRecentMessages(fakeRequest({ [RECENT_MESSAGES_FIELD]: [] }))).toEqual([]);
    });
});

describe('the window declaration — the plugin sizes it, the fork ships no default', () => {
    beforeEach(() => clearPromptInterceptors());
    afterAll(() => clearPromptInterceptors());

    test('a declaration reaches the client-config, keyed by plugin', () => {
        onPrompt('memory', async () => undefined, { recentMessages: 50 });
        onPrompt('moderation', async () => undefined, { recentMessages: 3 });

        expect(listPromptDeclarations()).toEqual({ memory: { recentMessages: 50 }, moderation: { recentMessages: 3 } });
    });

    test('a plugin that declares nothing does not appear at all', () => {
        onPrompt('quiet', async () => undefined);

        expect(listPromptDeclarations()).toEqual({});
    });

    test('one plugin registering twice is reported at its LARGEST, so neither handler is short-changed', () => {
        onPrompt('memory', async () => undefined, { recentMessages: 5 });
        onPrompt('memory', async () => undefined, { recentMessages: 40 });

        expect(listPromptDeclarations()).toEqual({ memory: { recentMessages: 40 } });
    });

    test('🔴 nonsense is REFUSED at registration, named, and never clamped', () => {
        // Loud in the plugin's own `init` beats a plugin quietly receiving a different amount of history than
        // it budgeted for. "This does not fit" is the fork's business; "how much is right" is not, so nothing
        // is silently adjusted downward.
        for (const bad of [0, -1, 2.5, '20', null, 100000]) {
            expect(() => onPrompt('memory', async () => undefined, { recentMessages: bad })).toThrow(/memory/);
        }

        expect(() => onPrompt('memory', async () => undefined, 'nope')).toThrow(/options object/);
        expect(listPromptDeclarations()).toEqual({});
    });
});

describe('per-plugin slicing — a plugin asking for 5 never receives 20', () => {
    beforeEach(() => clearPromptInterceptors());
    afterAll(() => clearPromptInterceptors());

    /** Twenty turns, indices 0..19, as one client payload. */
    const window = Array.from({ length: 20 }, (_, index) => turn(index));

    test('each handler receives exactly its own count, from one payload', async () => {
        /** @type {Record<string, any>} */
        const seen = {};

        onPrompt('five', async (outgoing) => { seen.five = outgoing.recentMessages; }, { recentMessages: 5 });
        onPrompt('twenty', async (outgoing) => { seen.twenty = outgoing.recentMessages; }, { recentMessages: 20 });
        onPrompt('none', async (outgoing) => { seen.none = outgoing.recentMessages; });

        await runPromptInterceptors({ handle: 'test-user', backend: 'text', apiType: 'koboldcpp', prompt: 'p', recentMessages: window });

        expect(seen.five).toHaveLength(5);
        expect(seen.twenty).toHaveLength(20);
        // 🔴 The undeclared handler gets NOTHING. Mutation: hand every handler the full array and this fails.
        expect(seen.none).toBeUndefined();
    });

    test('the slice is the TAIL — the most recent turns, with their real indices', async () => {
        /** @type {any} */
        let seen;
        onPrompt('five', async (outgoing) => { seen = outgoing.recentMessages; }, { recentMessages: 5 });

        await runPromptInterceptors({ handle: 'test-user', backend: 'text', apiType: 'koboldcpp', prompt: 'p', recentMessages: window });

        expect(seen.map(t => t.index)).toEqual([15, 16, 17, 18, 19]);
    });

    test('a window shorter than the declaration is passed whole rather than padded', async () => {
        /** @type {any} */
        let seen;
        onPrompt('fifty', async (outgoing) => { seen = outgoing.recentMessages; }, { recentMessages: 50 });

        await runPromptInterceptors({ handle: 'test-user', backend: 'text', apiType: 'koboldcpp', prompt: 'p', recentMessages: window });

        expect(seen).toHaveLength(20);
    });

    test('🔴 recentMessages is READ-ONLY: rewriting the prompt still works, returning a window does nothing', async () => {
        onPrompt('rewriter', async (outgoing) => {
            outgoing.recentMessages.length = 0;   // a handler mutating what it was handed
            return `INJECTED ${outgoing.prompt}`;
        }, { recentMessages: 5 });

        /** @type {any} */
        let secondSaw;
        onPrompt('reader', async (outgoing) => { secondSaw = outgoing.recentMessages; }, { recentMessages: 5 });

        const result = await runPromptInterceptors({ handle: 'test-user', backend: 'text', apiType: 'koboldcpp', prompt: 'p', recentMessages: window });

        expect(result.prompt).toBe('INJECTED p');
        // The window is re-sliced from the original for every handler, so one plugin cannot starve the next.
        expect(secondSaw).toHaveLength(5);
    });

    test('no window sent (an older client) leaves every handler at undefined', async () => {
        /** @type {any} */
        let seen = 'untouched';
        onPrompt('five', async (outgoing) => { seen = outgoing.recentMessages; }, { recentMessages: 5 });

        await runPromptInterceptors({ handle: 'test-user', backend: 'text', apiType: 'koboldcpp', prompt: 'p' });

        expect(seen).toBeUndefined();
    });

    test('the chat path is untouched by any of this — the regression §17.4 is designed to make impossible', async () => {
        // Populating the EXISTING `messages` field on the text path would have flipped
        // `wantsMessages`, silently refusing correct string returns and silently DISCARDING array ones. A
        // separate field cannot produce that bug; this is the assertion that says so.
        onPrompt('chatty', async (outgoing) => [{ role: 'system', content: 'added' }, ...outgoing.messages], { recentMessages: 5 });

        const result = await runPromptInterceptors({
            handle: 'test-user', backend: 'chat', apiType: 'custom',
            messages: [{ role: 'user', content: 'hi' }], recentMessages: window,
        });

        expect(result.messages).toEqual([{ role: 'system', content: 'added' }, { role: 'user', content: 'hi' }]);
    });
});

describe('readIdentityHeaders — genType joins the channel that cannot leak (§18)', () => {
    /**
     * @param {Record<string, string>} headers
     * @returns {any} Something shaped enough like an Express request
     */
    const fakeRequest = (headers) => ({ get: (name) => headers[name] });

    test('the type arrives verbatim, never bucketed', () => {
        // 🔴 VERBATIM. The moment the fork collapses `continue` and `impersonate` into a `quiet` boolean, a
        // plugin that needed to tell them apart has no way back — and `impersonate` is exactly the one a
        // memory plugin must decline, because there the model is writing the USER's line.
        for (const type of ['impersonate', 'continue', 'regenerate', 'quiet', 'swipe']) {
            expect(readIdentityHeaders(fakeRequest({ 'X-ST-Gen-Type': encodeURIComponent(type) })).genType).toBe(type);
        }
    });

    test('absent means an ordinary generation, which is what the world looked like before this existed', () => {
        expect(readIdentityHeaders(fakeRequest({})).genType).toBeUndefined();
        expect(readIdentityHeaders(fakeRequest({ 'X-ST-Gen-Type': '' })).genType).toBeUndefined();
    });
});

/**
 * 🔴 THE WITNESS: A REAL BOOT, A REAL SOCKET, AND A FAKE KOBOLDCPP WRITING DOWN WHAT IT WAS SENT.
 *
 * §16's identity fields ride headers and therefore cannot leak by construction — the backend fetch builds its
 * own. §17's window is far too big for a header, so it takes the body, which `text-completions.js` forwards
 * VERBATIM. That trades robust-by-construction for robust-by-one-correctly-placed-strip, and the only thing
 * that can hold a strip honest is the far end of the wire.
 */
describe('recent messages, end to end (§17) and the generation type (§18)', () => {
    /** @type {any} */
    let backend;
    /** @type {string[]} */
    let lines = [];
    /** @type {any} */
    let clientConfig;
    /** @type {number} */
    let generateStatus = 0;
    /** Every shim installed, so afterAll can take them out again (the §12.7 lesson). */
    const installed = [];

    /** Twenty turns with a GAP where a hidden message was, exactly as the client would send them. */
    const sent = [
        ...Array.from({ length: 10 }, (_, i) => turn(i)),
        // index 10 is hidden, so it simply is not here and nothing after it is renumbered.
        ...Array.from({ length: 10 }, (_, i) => turn(i + 11)),
    ];

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-recent');
        const journalPath = path.join(scratch, 'plugin-journal.txt');

        for (const [name, fixture] of [['zz-recent-probe', 'recent-messages-plugin.mjs'], ['zz-window-only', 'window-only-plugin.mjs']]) {
            const target = path.join(PLUGINS_DIRECTORY, `${name}.mjs`);
            const source = path.join(testDirectory, 'fixtures', fixture);
            fs.writeFileSync(target, `export { info, init } from ${JSON.stringify(new URL(`file:///${source.split(path.sep).join('/')}`).href)};\n`, 'utf-8');
            installed.push(target);
        }

        /** @type {any[]} */
        const bodies = [];
        const server = http.createServer((request, response) => {
            let body = '';
            request.on('data', chunk => body += chunk.toString());
            request.on('end', () => {
                bodies.push({ url: request.url, body: JSON.parse(body || '{}'), headers: request.headers });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ choices: [{ text: 'ok' }] }));
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        backend = { url: `http://127.0.0.1:${server.address().port}`, bodies, close: () => new Promise(r => server.close(() => r(undefined))) };

        const st = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                // Only OUR fixtures register. Jest runs suites in parallel and plugins/ is shared and not

                // configurable, so another suite's shim may be on disk while this server boots (fixture-gate.mjs).

                ST_FIXTURE_IDS: 'recent-probe,window-only',

                ST_PLUGIN_JOURNAL: journalPath,
            },
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);

        clientConfig = await (await fetch(`http://127.0.0.1:${st.port}/api/plugins/client-config`)).json();

        const generate = await fetch(`http://127.0.0.1:${st.port}/api/backends/text-completions/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-ST-Gen-Type': encodeURIComponent('impersonate') },
            body: JSON.stringify({
                api_type: 'koboldcpp',
                api_server: backend.url,
                prompt: 'The rendered prompt.',
                truncation_length: 4096,
                stream: false,
                max_tokens: 16,
                st_recent_messages: sent,
            }),
        });

        generateStatus = generate.status;

        await st.stop();
        lines = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean) : [];
    }, 120_000);

    afterAll(async () => {
        await backend?.close();
        for (const target of installed) {
            if (fs.existsSync(target)) fs.unlinkSync(target);
        }
    });

    test('the generation reached the backend at all — otherwise nothing below means anything', () => {
        expect(generateStatus).toBe(200);
        expect(backend.bodies).toHaveLength(1);
        expect(backend.bodies[0].url).toBe('/v1/completions');
    });

    test('🔴 the window reached the interceptors and DID NOT reach the backend', () => {
        // The mutation that must fail this: remove the central `delete` in `takeRecentMessages`.
        expect(lines).toContain('twenty window length: 20');
        expect(backend.bodies[0].body).not.toHaveProperty('st_recent_messages');

        // And nothing else the fork added rode along either.
        expect(backend.bodies[0].body.prompt).toBe('[[SEEN-BY-RECENT-PROBE]] The rendered prompt.');
        expect(backend.bodies[0].body.truncation_length).toBe(4096);
    });

    test('🔴 each interceptor got exactly what IT declared, from one payload', () => {
        expect(lines).toContain('five window length: 5');
        expect(lines).toContain('twenty window length: 20');
        expect(lines).toContain('undeclared window: undefined');
    });

    test('the anchor survives the trip, gap and all', () => {
        // Index 10 was hidden by the user. The turns after it keep the numbers they had; nothing renumbered.
        expect(lines).toContain(`twenty window indices: ${sent.map(t => t.index).join(',')}`);
        // The last five of a conversation whose tenth turn was hidden: 16..20, not 15..19.
        expect(lines).toContain('five window indices: 16,17,18,19,20');
    });

    test('the turns arrive normalized, with no ST internals attached', () => {
        expect(lines).toContain('twenty window leaked internals: false');
        expect(lines).toContain('twenty window names: Test User,Aria,Test User,Aria,Test User,Aria,Test User,Aria,Test User,Aria,Aria,Test User,Aria,Test User,Aria,Test User,Aria,Test User,Aria,Test User');
        expect(lines).toContain('five window first content: "turn 16"');
    });

    test('🔴 the generation type arrives verbatim, and never reaches the backend (§18)', () => {
        expect(lines).toContain('five genType: impersonate');
        expect(backend.bodies[0].headers).not.toHaveProperty('x-st-gen-type');
    });

    test('a nonsense window declaration is refused in the plugin\'s own init', () => {
        for (const bad of ['0', '-1', '2.5', '"20"', '100000']) {
            expect(lines).toContain(`bad declaration ${bad}: refused`);
        }
    });

    test('🔴 client-config carries prompts as a SIBLING of panels, including a plugin with no panel', () => {
        // The shape claim from §14.10: a plugin may declare a window and register no button, and anything
        // keyed off panels would silently drop exactly that plugin. `window-only` is that plugin.
        expect(clientConfig.panels).toEqual([]);
        expect(clientConfig.prompts).toEqual({
            'recent-probe': { recentMessages: 20 },   // its largest of 5 and 20
            'window-only': { recentMessages: 7 },
        });
    });
});
