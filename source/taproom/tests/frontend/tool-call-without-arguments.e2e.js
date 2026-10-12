/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/*
 * Parameterless tool calls may omit `arguments`. The server persists `{}` for new calls and replays
 * older calls with missing parameters as `{}` so the chat remains usable.
 */

test.describe.configure({ mode: 'serial', timeout: 240_000 });

test.describe('a tool call with no arguments', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let scratch;

    test.beforeEach(async () => {
        test.setTimeout(240_000);
        scratch = makeScratchDirectory('tool-call-no-arguments-e2e');
        const dataRoot = path.join(scratch, 'data');
        server = await startSillyTavern({
            dataRoot,
            configPath: path.join(scratch, 'config.yaml'),
        });
        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;
        await stepPastFirstRun(dataRoot);
    });

    test.afterEach(async () => {
        if (server) await server.stop();
        server = null;
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
        scratch = null;
    });

    /**
     * Send a message and wait for every generation it causes — the tool round included — to finish.
     * @param {import('@playwright/test').Page} page The page
     * @param {string} text The message
     */
    async function send(page, text) {
        await page.evaluate((message) => {
            $('#send_textarea').val(message).trigger('input');
            $('#send_but').trigger('click');
        }, text);
        await page.waitForFunction(() => $('#mes_stop').is(':visible'), null, { timeout: 30_000 }).catch(() => {});
        await page.waitForFunction(
            () => $('#send_but').is(':visible') && !$('#mes_stop').is(':visible'),
            null,
            { timeout: 60_000 },
        );
    }

    /**
     * The `arguments` of every replayed tool call in a request body.
     * @param {any} body A chat-completion request body
     * @returns {any[]} One entry per tool call, `undefined` where the field is missing
     */
    function replayedArguments(body) {
        return (body?.messages ?? [])
            .filter(message => Array.isArray(message.tool_calls))
            .flatMap(message => message.tool_calls.map(call => call.function?.arguments));
    }

    test('is saved and replayed as {}, and an old saved one is repaired on replay', async ({ page }) => {
        /** @type {any[]} */
        const requests = [];

        await page.route('**/api/backends/chat-completions/status', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: [{ id: 'mock-model' }] }),
        }));
        await page.route('**/api/backends/chat-completions/generate', (route) => {
            requests.push(JSON.parse(route.request().postData() ?? '{}'));
            // The first request is answered with the shape GLM-5.2 produced: a call to a parameterless tool,
            // and no `arguments` key anywhere. Everything after it gets a plain reply.
            const message = requests.length === 1
                ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping_tool' } }] }
                : { role: 'assistant', content: 'All done.' };
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ index: 0, message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }),
            });
        });

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            try {
                const ctx = globalThis.SillyTavern?.getContext?.();
                return (ctx?.characters?.length ?? 0) > 0 && !!ctx.getRequestHeaders?.()['X-CSRF-Token'];
            } catch {
                return false;
            }
        }, null, { timeout: 120_000 });

        /*
         * ⚠️ `Generate()` returns immediately while `online_status === 'no_connection'`, and everything in the
         * API drawer is `display:none`, so jQuery triggers rather than clicks. Streaming off so the mock can
         * answer with one JSON body; function calling on, or no tool is ever offered.
         */
        const status = await page.evaluate(async () => {
            $('#main_api').val('openai').trigger('change');
            $('#chat_completion_source').val('custom').trigger('change');
            $('#custom_api_url_text').val('http://127.0.0.1:9/v1').trigger('input');
            $('#stream_toggle').prop('checked', false).trigger('change');
            $('#openai_function_calling').prop('checked', true).trigger('input');
            globalThis.SillyTavern.getContext().registerFunctionTool({
                name: 'ping_tool',
                displayName: 'Ping',
                description: 'Takes no parameters.',
                parameters: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {} },
                action: async () => 'pong',
            });
            $('#api_button_openai').trigger('click');
            for (let attempt = 0; attempt < 150; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                // Re-fetched every poll: `onlineStatus` is a plain property, not a getter.
                const onlineStatus = globalThis.SillyTavern.getContext().onlineStatus;
                if (onlineStatus && onlineStatus !== 'no_connection') {
                    return onlineStatus;
                }
            }
            return globalThis.SillyTavern.getContext().onlineStatus;
        });
        expect(status, 'connecting to the mock backend').not.toBe('no_connection');

        const opened = await page.evaluate(async () => {
            const ctx = globalThis.SillyTavern.getContext();
            await ctx.selectCharacterById(ctx.characters.findIndex(character => character.name === 'Seraphina'));
            for (let attempt = 0; attempt < 100; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (String(ctx.getCurrentChatId() ?? '').startsWith('Seraphina')) {
                    return true;
                }
            }
            return false;
        });
        expect(opened, 'opening Seraphina').toBe(true);

        await send(page, 'Run the ping tool.');

        expect(requests.length, 'the tool round made a second request').toBeGreaterThanOrEqual(2);
        expect(replayedArguments(requests[1]), 'the call is replayed with {} instead of no arguments').toEqual(['{}']);

        const saved = await page.evaluate(() => globalThis.SillyTavern.getContext().chat
            .flatMap(message => message.extra?.tool_invocations ?? [])
            .map(invocation => invocation.parameters));
        expect(saved, 'the invocation is saved with {}').toEqual(['{}']);

        // The chat an older build wrote: the same invocation, with no parameters on it at all.
        await page.evaluate(() => {
            for (const message of globalThis.SillyTavern.getContext().chat) {
                for (const invocation of message.extra?.tool_invocations ?? []) {
                    delete invocation.parameters;
                }
            }
        });

        const before = requests.length;
        await send(page, 'Again.');

        expect(requests.length, 'the next message made a request').toBeGreaterThan(before);
        expect(replayedArguments(requests[before]), 'an old invocation with no parameters is replayed as {}').toEqual(['{}']);
    });
});
