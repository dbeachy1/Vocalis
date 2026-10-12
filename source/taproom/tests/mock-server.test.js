import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { MockServer } from './util/mock-server.js';

describe('MockServer tests', () => {
    /** @type {MockServer} */
    const mockServer = new MockServer({ port: 3000, host: '127.0.0.1' });

    beforeAll(async () => {
        await mockServer.start();
    });

    afterAll(async () => {
        await mockServer.stop();
    });

    test('should provide OpenAI-compatible endpoint', async () => {
        const requestBody = {
            model: 'gpt-4o',
            max_tokens: 400,
            messages: [
                { role: 'user', content: 'Hello, world!' },
            ],
        };
        const response = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });
        const expectedResponse = { 'choices': [{ 'finish_reason': 'stop', 'index': 0, 'message': { 'role': 'assistant', 'reasoning_content': 'gpt-4o\n1\n400', 'content': 'Hello, world!' } }], 'created': 0, 'model': 'gpt-4o' };
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual(expectedResponse);
    });
});

/**
 * 🎬 SCRIPTED REPLIES — `PLAN_INTEGRATION_TESTS.md` §6.
 *
 * The echo above is deterministic, which is most of what a stub needs, but it cannot say *"reply with
 * THIS text"* — and a memory test has to plant a fact on one turn and ask about it on a later one. Two
 * turns that must differ, and a test that must know which is which.
 *
 * 🔴 The fallback to the echo is not politeness, it is the compatibility contract: every existing suite
 * depends on the echo and none of them call `script()`, so an empty queue must behave exactly as this
 * server always has. The last test here is the one that pins that.
 */
describe('🎬 MockServer scripted replies', () => {
    /** @type {MockServer} */
    let server;

    /**
     * Ask the stub for one completion.
     * @param {string} content What the user said
     * @returns {Promise<string>} The assistant's reply
     */
    async function ask(content) {
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'stub', max_tokens: 10, messages: [{ role: 'user', content }] }),
        });

        return (await response.json()).choices[0].message.content;
    }

    beforeAll(async () => {
        // Not 3000: the suite above holds that port for its whole lifetime, and jest may run these files
        // in the same process.
        server = new MockServer({ port: 3001, host: '127.0.0.1' });
        await server.start();
    });

    afterAll(async () => {
        await server.stop();
    });

    test('hands out queued replies in order, one per request', async () => {
        server.script(['first reply', 'second reply']);

        expect(server.repliesRemaining).toBe(2);
        expect(await ask('anything')).toBe('first reply');
        expect(await ask('anything')).toBe('second reply');
        expect(server.repliesRemaining).toBe(0);
    });

    test('falls back to the echo once the queue is dry — the compatibility contract', async () => {
        expect(server.repliesRemaining).toBe(0);
        expect(await ask('echo me')).toBe('echo me');
    });

    test('records every prompt it was sent, which is the half that proves retrieval', async () => {
        const before = server.requests.length;
        await ask('a prompt worth inspecting');

        const last = server.requests[server.requests.length - 1];

        expect(server.requests.length).toBe(before + 1);
        expect(last.messages[0].content).toBe('a prompt worth inspecting');
    });

    test('refuses anything that is not an array of strings', () => {
        // @ts-expect-error — deliberately wrong, which is the point.
        expect(() => server.script('one reply')).toThrow(TypeError);
        // @ts-expect-error — deliberately wrong, which is the point.
        expect(() => server.script([1, 2])).toThrow(TypeError);
    });
});
