/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach for
//   `globalThis` and dynamic `import()` of the app's own modules.

import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/**
 * 🔴 A PROMPT THAT ENDS `<think>` AND A BACKEND THAT LEAVES THE REASONING IN THE TEXT.
 *
 * With `<think>` in the Last Assistant Prefix, a provider may return reasoning separately, leave it in the
 * reply as `reasoning</think>reply`, or skip reasoning and return a bare `</think>` before the answer.
 *
 * This drives a REAL streamed generation through `Generate()` with the backend stubbed at the browser, so the
 * frames go through the same SSE reader, `cleanUpMessage`, `ReasoningHandler` and finalization a live reply
 * does. The quiet (non-streamed) path is what Vocalis Polish uses and is covered separately.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const ASSISTANT = '<｜Assistant｜>';

test.describe('a reply that begins inside a thinking block the prompt opened', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    let base = '';

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('reasoning-opened-by-prompt-e2e');
        const dataRoot = path.join(scratch, 'data');
        server = await startSillyTavern({ dataRoot, configPath: path.join(scratch, 'config.yaml') });
        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;
        await stepPastFirstRun(dataRoot);
    });

    test.afterAll(async () => {
        await server?.stop?.();
    });

    /**
     * Open the shipped character on the text path with a DeepSeek template: `</think>` closes every past
     * assistant turn, and the Last Assistant Prefix opens a thinking block for the new one.
     * @param {import('@playwright/test').Page} page Page under test
     * @param {{ startReplyWith?: string, lastPrefix?: string, outputPrefix?: string, autoParse?: boolean, streaming?: boolean }} [options]
     */
    async function ready(page, { startReplyWith = '', lastPrefix = `${ASSISTANT}<think>`, outputPrefix = `${ASSISTANT}</think>`, autoParse = false, streaming = true } = {}) {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            try {
                return !!globalThis.SillyTavern?.getContext()?.characters?.length;
            } catch {
                return false;
            }
        }, null, { timeout: 60_000 });

        await page.evaluate(async ({ startReplyWith, lastPrefix, outputPrefix, autoParse, streaming }) => {
            const context = globalThis.SillyTavern.getContext();
            const script = await import('/script.js');
            const { textgenerationwebui_settings } = await import('/scripts/textgen-settings.js');
            const { power_user } = await import('/scripts/power-user.js');

            // The stock Seraphina card (character 0) carries an embedded lorebook, and selecting it the
            // first time opens a modal "import it now?" confirm that covers #send_but, so every send
            // timed out on the click. Ask for the non-blocking notice instead; this spec is about reasoning.
            power_user.world_import_dialog = false;
            await context.selectCharacterById(0);

            Object.assign(power_user.instruct, {
                enabled: true,
                input_sequence: '<｜User｜>',
                output_sequence: outputPrefix,
                output_suffix: '<｜end▁of▁sentence｜>',
                last_output_sequence: lastPrefix,
                wrap: false,
                names_behavior: 'none',
            });
            // The shipped DeepSeek reasoning template, newlines and all — the trimmed tags are what match.
            Object.assign(power_user.reasoning, { auto_parse: autoParse, prefix: '<think>\n', suffix: '\n</think>', separator: '\n\n' });
            power_user.user_prompt_bias = startReplyWith;

            textgenerationwebui_settings.server_urls[textgenerationwebui_settings.type] = 'http://127.0.0.1:1/stub';
            textgenerationwebui_settings.streaming = streaming;
            script.changeMainAPI('textgenerationwebui');
            script.setOnlineStatus('stub-model');
        }, { startReplyWith, lastPrefix, outputPrefix, autoParse, streaming });
    }

    /**
     * Answer the next text completion with the given frames — as SSE when the client asked to stream, as one
     * JSON body otherwise — and record the prompt it was sent.
     * @param {import('@playwright/test').Page} page Page under test
     * @param {Array<{ text?: string, reasoning?: string }>} frames What the backend sends, in order
     * @returns {Promise<{ prompts: string[] }>} Filled in as requests arrive
     */
    async function stubBackend(page, frames) {
        const seen = { prompts: [] };
        await page.unroute('**/api/backends/text-completions/generate**');
        await page.route('**/api/backends/text-completions/generate**', async (route) => {
            const body = JSON.parse(route.request().postData() ?? 'null');
            seen.prompts.push(body?.prompt);
            if (body?.stream) {
                const sse = frames
                    .map(frame => `data: ${JSON.stringify({ choices: [{ index: 0, text: frame.text ?? '', reasoning: frame.reasoning ?? null }] })}\n\n`)
                    .join('') + 'data: [DONE]\n\n';
                await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
            } else {
                const text = frames.map(frame => frame.text ?? '').join('');
                const reasoning = frames.map(frame => frame.reasoning ?? '').join('');
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ choices: [{ index: 0, text, reasoning: reasoning || null, finish_reason: 'stop' }] }),
                });
            }
        });
        return seen;
    }

    /**
     * Send a user message, wait for the streamed reply to finish, and read back what was stored and shown.
     * @param {import('@playwright/test').Page} page Page under test
     * @param {string} text What the user types
     */
    async function sendAndRead(page, text) {
        const before = await page.evaluate(() => globalThis.SillyTavern.getContext().chat.length);
        await page.locator('#send_textarea').fill(text);
        await page.locator('#send_but').click();

        // A new reply at the end of the chat, and the stop button gone: the stream has been finalized. Not
        // "before + 2": the user turn is not always committed in this harness (the first run showed the
        // greeting and the reply with no user message between them), and the reply is the subject here.
        await page.waitForFunction((before) => {
            const context = globalThis.SillyTavern.getContext();
            const last = context.chat[context.chat.length - 1];
            return context.chat.length > before && last && !last.is_user
                && document.body.dataset.generating !== 'true'
                && getComputedStyle(document.getElementById('mes_stop')).display === 'none';
        }, before, { timeout: 60_000 });

        return page.evaluate(() => {
            const context = globalThis.SillyTavern.getContext();
            const id = context.chat.length - 1;
            const message = context.chat[id];
            const element = document.querySelector(`#chat .mes[mesid="${id}"]`);
            return {
                mes: message.mes,
                reasoning: message.extra?.reasoning ?? '',
                swipe: message.swipes?.[message.swipe_id ?? 0],
                shownText: element?.querySelector('.mes_text')?.textContent?.trim() ?? '',
                shownReasoning: element?.querySelector('.mes_reasoning')?.textContent?.trim() ?? '',
                reasoningClass: element?.classList.contains('reasoning') ?? false,
            };
        });
    }

    test('🔴 reasoning left in the reply text goes to the thinking block, and the reply is what shows', async ({ page }) => {
        await ready(page);
        const seen = await stubBackend(page, [
            { text: 'The user wants the woman' },
            { text: ' to describe the lighthouse.\n</th' },
            { text: 'ink>\n\nThe woman looked at Test Character.' },
        ]);

        const result = await sendAndRead(page, 'What did he look like?');

        // The premise: the prompt as posted really does leave the model inside `<think>`.
        expect(seen.prompts.at(-1).endsWith(`${ASSISTANT}<think>`)).toBe(true);

        expect(result.mes).toBe('The woman looked at Test Character.');
        expect(result.swipe).toBe('The woman looked at Test Character.');
        expect(result.reasoning).toBe('The user wants the woman to describe the lighthouse.');
        expect(result.shownText).toBe('The woman looked at Test Character.');
        expect(result.shownReasoning).toContain('The user wants the woman to describe the lighthouse.');
        expect(result.reasoningClass).toBe(true);
    });

    test('🔴 a bare closing tag from a model that skipped thinking is dropped, with no thinking block', async ({ page }) => {
        await ready(page);
        // Split mid-tag on purpose: `</th` alone must not flash up as a one-line thinking block.
        await stubBackend(page, [
            { text: '</th' },
            { text: 'ink>The woman looked at Test Character, then at the doorway.' },
        ]);

        const result = await sendAndRead(page, 'Go on.');

        expect(result.mes).toBe('The woman looked at Test Character, then at the doorway.');
        expect(result.shownText).toBe('The woman looked at Test Character, then at the doorway.');
        expect(result.shownText).not.toContain('think');
        expect(result.reasoning).toBe('');
        expect(result.reasoningClass).toBe(false);
    });

    test('reasoning the provider split off itself is left exactly as it was', async ({ page }) => {
        await ready(page);
        await stubBackend(page, [
            { reasoning: 'Plan the next beat.' },
            { reasoning: ' Keep it grounded.' },
            { text: 'The woman looked at Test Character.' },
        ]);

        const result = await sendAndRead(page, 'And then?');

        expect(result.mes).toBe('The woman looked at Test Character.');
        expect(result.reasoning).toBe('Plan the next beat. Keep it grounded.');
        expect(result.reasoningClass).toBe(true);
    });

    test('a reply with no closing tag and no reasoning channel ends up as the reply, not as thinking', async ({ page }) => {
        await ready(page);
        await stubBackend(page, [
            { text: 'The woman looked at Test Character.' },
            { text: ' She said nothing.' },
        ]);

        const result = await sendAndRead(page, 'Well?');

        expect(result.mes).toBe('The woman looked at Test Character. She said nothing.');
        expect(result.shownText).toBe('The woman looked at Test Character. She said nothing.');
        expect(result.reasoning).toBe('');
        expect(result.reasoningClass).toBe(false);
    });

    test('works with Auto-Parse on as well as off', async ({ page }) => {
        await ready(page, { autoParse: true });
        await stubBackend(page, [{ text: 'Think it through.\n</think>\n\nThe woman nodded.' }]);

        const result = await sendAndRead(page, 'Yes?');

        expect(result.mes).toBe('The woman nodded.');
        expect(result.reasoning).toBe('Think it through.');
    });

    test('a non-streamed reply is split the same way', async ({ page }) => {
        await ready(page, { streaming: false });
        await stubBackend(page, [{ text: 'Think it through.\n</think>\n\nThe woman nodded.' }]);

        const result = await sendAndRead(page, 'Still there?');

        expect(result.mes).toBe('The woman nodded.');
        expect(result.reasoning).toBe('Think it through.');
    });

    /**
     * A quiet prompt ends with the ordinary Assistant Message Prefix, not the Last
     * one — measured here, `…### Input:Polish the draft.\n<｜Assistant｜></think>` — so thinking is CLOSED for
     * it and there is nothing to split. The `<think>` tag on a polished message came from Start Reply
     * With alone. This pins both halves: the prompt shape, and a reply passed through untouched.
     * @param {import('@playwright/test').Page} page Page under test
     * @returns {Promise<string>} The quiet result
     */
    async function polish(page) {
        return page.evaluate(async () => {
            const context = globalThis.SillyTavern.getContext();
            return context.generateQuietPrompt({ quietPrompt: 'Polish the draft.', removeReasoning: true, recoverReasoningOnly: true });
        });
    }

    test('a quiet generation (Vocalis Polish) on this template has thinking closed, and its reply is untouched', async ({ page }) => {
        await ready(page);
        const seen = await stubBackend(page, [{ text: 'I step beside Test Character and glance back.' }]);

        const result = await polish(page);

        expect(seen.prompts.at(-1).slice(-120)).toMatch(/<｜Assistant｜><\/think>\s*$/);
        expect(result).toBe('I step beside Test Character and glance back.');
    });

    test('🔴 a quiet generation whose prompt DOES open the block gets the reply, not the chain of thought', async ({ page }) => {
        await ready(page, { outputPrefix: `${ASSISTANT}<think>` });
        const seen = await stubBackend(page, [{ text: 'The user wants this tightened.\n</think>\n\nI step beside Test Character.' }]);

        const result = await polish(page);

        expect(seen.prompts.at(-1).slice(-120)).toMatch(/<think>\s*$/);
        expect(result).toBe('I step beside Test Character.');
    });

    test('Start Reply With `<think>` still parses as it did, and is not split twice', async ({ page }) => {
        // The old configuration: the tag comes from Start Reply With, `cleanUpMessage` puts it back on the
        // front of the reply, and the ordinary Auto-Parse path takes it from there. `<think>\n`, because that
        // parser matches the template's prefix verbatim, newline included — with a bare `<think>` it never
        // matched even before this change.
        await ready(page, { startReplyWith: '<think>\n', lastPrefix: ASSISTANT, autoParse: true });
        const seen = await stubBackend(page, [{ text: 'Think it through.\n</think>\n\nThe woman nodded.' }]);

        const result = await sendAndRead(page, 'Again?');

        expect(seen.prompts.at(-1)).toMatch(/<｜Assistant｜><think>\s*$/);
        expect(result.mes).toBe('The woman nodded.');
        expect(result.reasoning).toBe('Think it through.');
    });
});
