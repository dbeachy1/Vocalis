/* eslint-env browser */
// The callbacks handed to page.evaluate() run in the page and deliberately use the app's public modules.

import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

/**
 * These tests feed the browser the same two DeepSeek stream shapes that matter here: a normal response
 * carrying reasoning and content, and a response carrying content with no reasoning channel at all. The
 * malformed case deliberately supplies the parser's pre-fallback state (reasoning with an empty message),
 * which is the state that used to make the visible message blank and therefore unusable by TTS.
 */
test.describe('reasoning fallback on fake DeepSeek responses', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    let base;
    let dataRoot;
    let characterName;
    let brokenChatPath;

    const when = '2026-09-16T00:00:00.000Z';
    const CHAT_NAMES = ['reasoning-normal', 'reasoning-no-block', 'reasoning-malformed'];

    function header(name) {
        return { user_name: 'User', character_name: name, create_date: when, chat_metadata: {} };
    }

    function userTurn() {
        return {
            name: 'User',
            is_user: true,
            is_system: false,
            send_date: when,
            mes: 'Continue the scene.',
            extra: {},
        };
    }

    function blankChat(name) {
        return [header(name), userTurn()];
    }

    function malformedChat(name) {
        const extra = {
            reasoning: 'Recovered answer from an old malformed turn.',
            reasoning_type: 'parsed',
            reasoning_duration: 12,
        };
        const swipeInfo = (reasoning) => ({
            send_date: when,
            gen_started: when,
            gen_finished: when,
            extra: reasoning ? { reasoning } : {},
        });

        return [
            header(name),
            userTurn(),
            {
                name,
                is_user: false,
                is_system: false,
                send_date: when,
                mes: '',
                extra,
                swipe_id: 1,
                swipes: ['An intact alternate answer.', ''],
                swipe_info: [swipeInfo('Intact alternate reasoning.'), swipeInfo(extra.reasoning)],
            },
        ];
    }

    async function openChat(page, chatName) {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            try {
                return Boolean(globalThis.SillyTavern?.getContext?.()?.characters?.length);
            } catch {
                return false;
            }
        }, null, { timeout: 60_000 });

        await page.evaluate(async (name) => {
            const context = globalThis.SillyTavern.getContext();
            await context.selectCharacterById(0);
            await context.openCharacterChat(name);
        }, chatName);
        await expect(page.locator('#chat .mes')).toHaveCount(chatName === 'reasoning-malformed' ? 2 : 1, { timeout: 30_000 });
    }

    async function configureReasoning(page) {
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            Object.assign(power_user.reasoning, {
                auto_parse: true,
                prefix: '<think>',
                suffix: '</think>',
                separator: '\\n',
            });
        });
    }

    async function fakeDeepSeekReply(page, { thinkingFrames = [], contentFrames = [], malformed = false }) {
        return page.evaluate(async ({ thinkingFrames, contentFrames, malformed }) => {
            const [{ getStreamingReply, chat_completion_sources }, scriptModule] = await Promise.all([
                import('/scripts/openai.js'),
                import('/script.js'),
            ]);
            const context = globalThis.SillyTavern.getContext();
            const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
            let content = '';

            for (const value of thinkingFrames) {
                content += getStreamingReply({ choices: [{ delta: { reasoning_content: value } }] }, state, {
                    chatCompletionSource: chat_completion_sources.DEEPSEEK,
                    overrideShowThoughts: true,
                });
            }
            for (const value of contentFrames) {
                content += getStreamingReply({ choices: [{ delta: { content: value } }] }, state, {
                    chatCompletionSource: chat_completion_sources.DEEPSEEK,
                    overrideShowThoughts: true,
                });
            }

            // This is the exact broken intermediate state reported by the client: the model result was
            // assigned to reasoning while the normal message field remained empty.
            await scriptModule.saveReply({
                type: 'normal',
                getMessage: malformed ? '' : content,
                reasoning: state.reasoning,
            });

            const id = context.chat.length - 1;
            const message = context.chat[id];
            const element = document.querySelector(`#chat .mes[mesid="${id}"]`);
            const details = element?.querySelector('.mes_reasoning_details');

            return {
                id,
                message: {
                    mes: message?.mes,
                    reasoning: message?.extra?.reasoning,
                    swipe: message?.swipes?.[message?.swipe_id],
                    swipeReasoning: message?.swipe_info?.[message?.swipe_id]?.extra?.reasoning,
                },
                dom: {
                    messageText: element?.querySelector('.mes_text')?.textContent?.trim(),
                    reasoningText: element?.querySelector('.mes_reasoning')?.textContent?.trim(),
                    hasContent: details?.getAttribute('data-has-content') ?? null,
                    display: details ? getComputedStyle(details).display : null,
                    reasoningClass: element?.classList.contains('reasoning') ?? false,
                },
                // TTS consumes ChatMessage.mes (and not the reasoning DOM), so expose the exact field it sees.
                ttsText: message?.mes,
                streamedReasoning: state.reasoning,
                streamedContent: content,
            };
        }, { thinkingFrames, contentFrames, malformed });
    }

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('reasoning-fallback-e2e');
        dataRoot = path.join(scratch, 'data');
        server = await startSillyTavern({ dataRoot, configPath: path.join(scratch, 'config.yaml') });
        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;
        await stepPastFirstRun(dataRoot);

        const avatar = fs.readdirSync(path.join(dataRoot, 'default-user', 'characters')).find(name => name.endsWith('.png'));
        if (!avatar) throw new Error('The scratch data root has no character fixture.');
        characterName = path.parse(avatar).name;
        const chatsDirectory = path.join(dataRoot, 'default-user', 'chats', characterName);
        fs.mkdirSync(chatsDirectory, { recursive: true });

        // 🔴 A REAL NEWLINE. These joined on `'\\n'` — a literal backslash-n — so every fixture chat was ONE line
        // of invalid JSON, the server parsed it to an empty chat, and the client started a fresh one with its
        // greeting. The two blank-chat tests expect one message and passed by accident; the malformed-chat test
        // expects two and could never pass, because the malformed turn it exists to repair was never loaded.
        for (const name of CHAT_NAMES.slice(0, 2)) {
            fs.writeFileSync(path.join(chatsDirectory, `${name}.jsonl`), blankChat(characterName).map(line => JSON.stringify(line)).join('\n'), 'utf8');
        }
        brokenChatPath = path.join(chatsDirectory, `${CHAT_NAMES[2]}.jsonl`);
        fs.writeFileSync(brokenChatPath, malformedChat(characterName).map(line => JSON.stringify(line)).join('\n'), 'utf8');
    });

    test.afterAll(async () => {
        await server?.stop?.();
    });

    test('normal fake thinking response keeps reasoning and visible message separate', async ({ page }) => {
        await openChat(page, 'reasoning-normal');
        await configureReasoning(page);
        const result = await fakeDeepSeekReply(page, {
            thinkingFrames: ['The model considers the scene.'],
            contentFrames: ['The answer is visible.'],
        });

        expect(result.streamedReasoning).toBe('The model considers the scene.');
        expect(result.streamedContent).toBe('The answer is visible.');
        expect(result.message.mes).toBe('The answer is visible.');
        expect(result.message.reasoning).toBe('The model considers the scene.');
        expect(result.dom.messageText).toContain('The answer is visible.');
        expect(result.dom.reasoningText).toContain('The model considers the scene.');
        expect(result.dom.hasContent).toBe('true');
        expect(result.dom.reasoningClass).toBe(true);
    });

    test('fake response with no thinking block stays visible and TTS-readable', async ({ page }) => {
        await openChat(page, 'reasoning-no-block');
        await configureReasoning(page);
        const result = await fakeDeepSeekReply(page, { contentFrames: ['Direct answer with no thinking block.'] });

        expect(result.streamedReasoning).toBe('');
        expect(result.streamedContent).toBe('Direct answer with no thinking block.');
        expect(result.message.mes).toBe('Direct answer with no thinking block.');
        expect(result.message.reasoning).toBe('');
        expect(result.ttsText).toBe('Direct answer with no thinking block.');
        expect(result.dom.messageText).toContain('Direct answer with no thinking block.');
        expect(result.dom.reasoningText).toBe('');
        expect(result.dom.hasContent).toBeNull();
        expect(result.dom.display).toBe('none');
        expect(result.dom.reasoningClass).toBe(false);
    });

    test('promotes a completed reasoning-only reply before rendering and TTS events', async ({ page }) => {
        await openChat(page, 'reasoning-no-block');
        const result = await fakeDeepSeekReply(page, {
            thinkingFrames: ['Recovered answer from a completed malformed reply.'],
            malformed: true,
        });

        expect(result.message.mes).toBe('Recovered answer from a completed malformed reply.');
        expect(result.message.reasoning).toBeUndefined();
        expect(result.message.swipe).toBe(result.message.mes);
        expect(result.message.swipeReasoning).toBeUndefined();
        expect(result.ttsText).toBe(result.message.mes);
        expect(result.dom.messageText).toContain(result.message.mes);
        expect(result.dom.reasoningText).toBe('');
        expect(result.dom.hasContent).toBeNull();
        expect(result.dom.display).toBe('none');
        expect(result.dom.reasoningClass).toBe(false);
    });

    test('repairs a persisted reasoning-only active swipe during chat load and saves it', async ({ page }) => {
        await openChat(page, 'reasoning-malformed');

        const result = await page.evaluate(() => {
            const context = globalThis.SillyTavern.getContext();
            const message = context.chat[context.chat.length - 1];
            const id = context.chat.length - 1;
            const element = document.querySelector(`#chat .mes[mesid="${id}"]`);
            const details = element?.querySelector('.mes_reasoning_details');
            return {
                message: {
                    mes: message?.mes,
                    reasoning: message?.extra?.reasoning,
                    swipe: message?.swipes?.[message?.swipe_id],
                    swipeReasoning: message?.swipe_info?.[message?.swipe_id]?.extra?.reasoning,
                    alternate: message?.swipes?.[0],
                },
                dom: {
                    messageText: element?.querySelector('.mes_text')?.textContent?.trim(),
                    reasoningText: element?.querySelector('.mes_reasoning')?.textContent?.trim(),
                    hasContent: details?.getAttribute('data-has-content') ?? null,
                    display: details ? getComputedStyle(details).display : null,
                    reasoningClass: element?.classList.contains('reasoning') ?? false,
                },
            };
        });

        expect(result.message.mes).toBe('Recovered answer from an old malformed turn.');
        expect(result.message.reasoning).toBeUndefined();
        expect(result.message.swipe).toBe(result.message.mes);
        expect(result.message.swipeReasoning).toBeUndefined();
        expect(result.message.alternate).toBe('An intact alternate answer.');
        expect(result.dom.messageText).toContain('Recovered answer from an old malformed turn.');
        expect(result.dom.reasoningText).toBe('');
        expect(result.dom.hasContent).toBeNull();
        expect(result.dom.display).toBe('none');
        expect(result.dom.reasoningClass).toBe(false);

        await expect.poll(() => {
            const lines = fs.readFileSync(brokenChatPath, 'utf8').split(/\r?\n/).filter(Boolean);
            const stored = JSON.parse(lines[2]);
            return {
                mes: stored.mes,
                reasoning: stored.extra?.reasoning,
                swipeId: stored.swipe_id,
                swipes: stored.swipes,
            };
        }, { timeout: 15_000 }).toEqual({
            mes: result.message.mes,
            reasoning: undefined,
            swipeId: 1,
            swipes: ['An intact alternate answer.', result.message.mes],
        });
    });

    test('publishes quiet fallback capability v1 and preserves selector precedence', async ({ page }) => {
        await openChat(page, 'reasoning-no-block');

        const result = await page.evaluate(async () => {
            const context = globalThis.SillyTavern.getContext();
            const { selectReasoningFallback } = await import('/scripts/reasoning-fallback.js');
            const { extractReasoningFromData } = await import('/scripts/reasoning.js');
            const previousShowThoughts = context.chatCompletionSettings.show_thoughts;
            context.chatCompletionSettings.show_thoughts = false;
            const structuredReasoning = extractReasoningFromData(
                { choices: [{ message: { reasoning_content: 'reasoning survives hidden thoughts' } }] },
                { mainApi: 'openai', chatCompletionSource: 'deepseek', ignoreShowThoughts: true },
            );
            context.chatCompletionSettings.show_thoughts = previousShowThoughts;
            return {
                capabilities: context.quietGenerationCapabilities,
                structuredReasoning,
                normal: selectReasoningFallback('  visible answer', 'reasoning that must not replace content'),
                fallback: selectReasoningFallback('  \n  ', '  recovered answer'),
                empty: selectReasoningFallback(' \n ', ' \t '),
            };
        });

        expect(result.capabilities).toEqual({ reasoningOnlyFallback: 1 });
        expect(result.structuredReasoning).toBe('reasoning survives hidden thoughts');
        expect(result.normal).toEqual({ text: '  visible answer', usedFallback: false });
        expect(result.fallback).toEqual({ text: '  recovered answer', usedFallback: true });
        expect(result.empty).toEqual({ text: '', usedFallback: false });
    });
});
