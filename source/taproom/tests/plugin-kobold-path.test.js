import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIRECTORY = makeScratchDirectory('plugins-kobold');

/**
 * A turn as the client sends one.
 * @param {number} index Its position in the full chat
 * @returns {object} The turn
 */
const turn = (index) => ({ role: index % 2 ? 'assistant' : 'user', name: index % 2 ? 'Aria' : 'Test User', content: `turn ${index}`, index });

/**
 * 🔴 THE KOBOLD PATH, WHICH THE CONTRACT PROMISED AND THE CODE DID NOT DELIVER.
 *
 * `OutgoingPrompt.backend` has always been documented as `'text'`, `'chat'` or `'kobold'`. Only the first two
 * had a call site. So on KoboldAI Classic a memory plugin registered successfully, declared a window, and was
 * then never consulted — while the client went on attaching `st_recent_messages` to every one of those
 * requests, on a route that never stripped it either.
 *
 * Both halves are asserted here, from the two ends that can actually tell:
 *   - the PLUGIN's journal says it was called, and called as 'kobold';
 *   - the BACKEND STUB says it received the rewritten prompt and no `st_recent_messages`.
 *
 * NovelAI gained the same two lines in the same shape and is NOT covered here: its route hardcodes
 * `https://api.novelai.net`, so an end-to-end spec would have to make a real request to a real vendor from
 * the unit suite. Verified by inspection only, and said out loud rather than implied by silence.
 */
describe('🔴 the kobold path reaches a plugin, and does not carry the window to the backend', () => {
    /** @type {any} */
    let backend;
    /** @type {string[]} */
    let lines = [];
    /** @type {number} */
    let generateStatus = 0;
    /** Every shim installed, so afterAll can take them out again. */
    const installed = [];

    /** Ten turns, exactly as the client would send them. */
    const sent = Array.from({ length: 10 }, (_, i) => turn(i));

    beforeAll(async () => {
        const scratch = makeScratchDirectory('plugin-kobold');
        const journalPath = path.join(scratch, 'plugin-journal.txt');

        const target = path.join(PLUGINS_DIRECTORY, 'zz-backend-probe.mjs');
        const source = path.join(testDirectory, 'fixtures', 'backend-probe-plugin.mjs');
        fs.writeFileSync(target, `export { info, init } from ${JSON.stringify(new URL(`file:///${source.split(path.sep).join('/')}`).href)};\n`, 'utf-8');
        installed.push(target);

        /** @type {any[]} */
        const bodies = [];
        const server = http.createServer((request, response) => {
            let body = '';
            request.on('data', chunk => body += chunk.toString());
            request.on('end', () => {
                bodies.push({ url: request.url, body: JSON.parse(body || '{}') });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ results: [{ text: 'ok' }] }));
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
                ST_FIXTURE_IDS: 'backend-probe',
                ST_PLUGIN_JOURNAL: journalPath,
            },
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);

        const generate = await fetch(`http://127.0.0.1:${st.port}/api/backends/kobold/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_server: backend.url,
                prompt: 'The rendered prompt.',
                max_context_length: 4096,
                max_length: 16,
                streaming: false,
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
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
            }
        }
    });

    test('the plugin ran at all — otherwise every assertion below is vacuous', () => {
        expect(lines.length).toBeGreaterThan(0);
    });

    test('🔴 THE CAPABILITY: the interceptor fired, and was told it was on the kobold path', () => {
        expect(lines).toContain('saw backend: kobold');
        expect(lines).toContain('saw apiType: kobold');
    });

    test('the prompt it was handed is the one the client sent', () => {
        expect(lines).toContain('saw prompt: "The rendered prompt."');
    });

    test('the declared window arrived, sliced to what this plugin asked for', () => {
        expect(lines).toContain('saw window length: 4');
    });

    test('the context budget came across, so a plugin knows how much room it has', () => {
        expect(lines).toContain('saw budget: 4096');
    });

    test('🔴 THE REWRITE IS WHAT REACHES THE BACKEND — running and being used are different claims', () => {
        expect(generateStatus).toBe(200);
        expect(backend.bodies.length).toBeGreaterThan(0);
        expect(backend.bodies[0].body.prompt).toBe('[[SEEN-BY-BACKEND-PROBE]] The rendered prompt.');
    });

    test('🔴 THE STRIP: st_recent_messages does not reach the model host', () => {
        expect(backend.bodies[0].body).not.toHaveProperty('st_recent_messages');
        expect(JSON.stringify(backend.bodies[0].body)).not.toContain('turn 0');
    });
});
