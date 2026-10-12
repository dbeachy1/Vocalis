/* eslint-env browser */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(path.dirname(here));
const presetPath = path.join(serverDirectory, 'default', 'content', 'presets', 'instruct', 'DeepSeek V4.1 Flash (chat).json');
const v41Preset = JSON.parse(fs.readFileSync(presetPath, 'utf-8'));
const MODEL_ID = 'deepseek-ai/DeepSeek-V4.1-Flash';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('DeepSeek V4.1 chat formatting', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    let base = '';

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('deepseek-v41-instruct');
        const dataRoot = path.join(scratch, 'data');
        server = await startSillyTavern({ dataRoot, configPath: path.join(scratch, 'config.yaml') });
        if (!server.listening) throw new Error(`Boot failed.\n\n${server.output()}`);
        base = `http://127.0.0.1:${server.port}`;
        await stepPastFirstRun(dataRoot);
    });

    test.afterAll(async () => {
        await server?.stop?.();
    });

    async function ready(page) {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            try {
                return !!globalThis.SillyTavern?.getContext()?.characters?.length;
            } catch {
                return false;
            }
        }, null, { timeout: 60_000 });
        await page.evaluate(async () => {
            const context = globalThis.SillyTavern.getContext();
            await context.selectCharacterById(0);
            const script = await import('/script.js');
            const { textgenerationwebui_settings } = await import('/scripts/textgen-settings.js');
            textgenerationwebui_settings.server_urls[textgenerationwebui_settings.type] = 'http://127.0.0.1:1/stub';
            textgenerationwebui_settings.streaming = false;
            script.changeMainAPI('textgenerationwebui');
            script.setOnlineStatus('stub-model');
        });
        const lorePrompt = page.getByRole('dialog').filter({ hasText: 'This character has an embedded World/Lorebook.' });
        if (await lorePrompt.isVisible().catch(() => false)) {
            await lorePrompt.getByRole('button', { name: 'No' }).click();
        }
    }

    test('fresh Featherless activation is exact and later user choices persist', async ({ page }) => {
        await ready(page);
        await page.locator('#advanced-formatting-button .drawer-toggle').click();
        await expect(page.locator('#instruct_enabled_label')).toBeVisible();
        const result = await page.evaluate(({ preset, modelId }) => {
            return (async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const instruct = await import('/scripts/instruct-mode.js');
                if (!instruct.instruct_presets.some(item => item.name === preset.name)) {
                    throw new Error('The packaged instruct preset was not loaded');
                }

                const freshSettingsMarker = power_user.instruct_api_activation_configured === false;
                power_user.instruct.enabled = true;
                power_user.instruct.preset = 'ChatML';
                await instruct.loadInstructMode({});
                instruct.selectInstructPreset('Alpaca', { quiet: true });
                power_user.instruct.enabled = false;
                $('#instruct_enabled').prop('checked', false);
                const initializationStayedPristine = freshSettingsMarker
                    && !power_user.instruct_api_activation_configured;

                const activated = instruct.autoSelectInstructPreset(modelId, 'featherless');
                const fresh = {
                    activated,
                    preset: power_user.instruct.preset,
                    enabled: power_user.instruct.enabled,
                    configured: power_user.instruct_api_activation_configured,
                    utilityPrefix: power_user.instruct.single_turn_story_string_prefix,
                    emptyStoryPrefix: power_user.instruct.empty_story_string_prefix,
                    coalescesUsers: power_user.instruct.coalesce_adjacent_user_messages,
                };
                return { initializationStayedPristine, fresh };
            })();
        }, { preset: v41Preset, modelId: MODEL_ID });

        expect(result.initializationStayedPristine).toBe(true);
        expect(result.fresh).toEqual({
            activated: true,
            preset: v41Preset.name,
            enabled: true,
            configured: true,
            utilityPrefix: v41Preset.single_turn_story_string_prefix,
            emptyStoryPrefix: v41Preset.empty_story_string_prefix,
            coalescesUsers: true,
        });

        await page.locator('#instruct_enabled_label').click();
        const disabledStillRemains = await page.evaluate(async modelId => {
            const { power_user } = await import('/scripts/power-user.js');
            const instruct = await import('/scripts/instruct-mode.js');
            instruct.autoSelectInstructPreset(modelId, 'featherless');
            return !power_user.instruct.enabled && power_user.instruct_api_activation_configured;
        }, MODEL_ID);
        expect(disabledStillRemains).toBe(true);

        await page.locator('#instruct_enabled_label').click();
        await page.locator('#instruct_presets').selectOption('ChatML');
        const customRemains = await page.evaluate(async modelId => {
            const { power_user } = await import('/scripts/power-user.js');
            const instruct = await import('/scripts/instruct-mode.js');
            instruct.autoSelectInstructPreset(modelId, 'featherless');
            return power_user.instruct.preset === 'ChatML' && power_user.instruct.empty_story_string_prefix === null;
        }, MODEL_ID);
        expect(customRemains).toBe(true);

        await page.locator('#instruct_presets').selectOption(v41Preset.name);
        const loadedPresetFields = await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            return {
                preset: power_user.instruct.preset,
                prefix: power_user.instruct.single_turn_story_string_prefix,
                emptyPrefix: power_user.instruct.empty_story_string_prefix,
                coalesce: power_user.instruct.coalesce_adjacent_user_messages,
            };
        });
        expect(loadedPresetFields).toEqual({
            preset: v41Preset.name,
            prefix: v41Preset.single_turn_story_string_prefix,
            emptyPrefix: v41Preset.empty_story_string_prefix,
            coalesce: true,
        });

        const wrongApiDoesNotActivate = await page.evaluate(({ modelId }) => {
            return (async () => {
                const { power_user } = await import('/scripts/power-user.js');
                const instruct = await import('/scripts/instruct-mode.js');
                power_user.instruct.enabled = false;
                power_user.instruct.preset = 'Alpaca';
                power_user.instruct_api_activation_configured = false;
                instruct.autoSelectInstructPreset(modelId, 'openrouter');
                return power_user.instruct.preset === 'Alpaca' && !power_user.instruct.enabled;
            })();
        }, { modelId: MODEL_ID });
        expect(wrongApiDoesNotActivate).toBe(true);
    });

    test('the wrapped utility uses the canonical V4.1 single-user prefix', async ({ page }) => {
        await ready(page);
        const envelope = await page.evaluate(async settings => {
            const { power_user } = await import('/scripts/power-user.js');
            const instruct = await import('/scripts/instruct-mode.js');
            Object.assign(power_user.instruct, settings, { enabled: true });
            return instruct.getSingleTurnInstructEnvelope();
        }, v41Preset);

        expect(envelope.prefix).toBe('<｜begin▁of▁sentence｜><｜User｜>');
        expect(envelope.suffix).toBe('<｜Assistant｜></think>');
        expect(envelope.stop).toContain('<｜end▁of▁sentence｜>');
    });

    test('the formatter matches the pinned canonical role and generation boundaries', async ({ page }) => {
        await ready(page);
        const rendered = await page.evaluate(async settings => {
            const instruct = await import('/scripts/instruct-mode.js');
            const { power_user } = await import('/scripts/power-user.js');
            const { extension_prompt_types } = await import('/script.js');
            const role = (name, text, isUser, isNarrator = false) => instruct.formatInstructModeChat(
                name,
                text,
                isUser,
                isNarrator,
                false,
                'Test User',
                'Test Character',
                false,
                settings,
            );
            const story = text => instruct.formatInstructModeStoryString(text, {
                customInstruct: settings,
                customContext: { ...power_user.context, story_string_position: extension_prompt_types.IN_PROMPT },
            });
            const emptyWithPrefix = story('');
            const emptyWithoutPrefix = instruct.formatInstructModeStoryString('', {
                customInstruct: { ...settings, empty_story_string_prefix: null },
                customContext: { ...power_user.context, story_string_position: extension_prompt_types.IN_PROMPT },
            });
            const emptyWithEmptyPrefix = instruct.formatInstructModeStoryString('', {
                customInstruct: { ...settings, empty_story_string_prefix: '' },
                customContext: { ...power_user.context, story_string_position: extension_prompt_types.IN_PROMPT },
            });
            const emptyInChat = instruct.formatInstructModeStoryString('', {
                customInstruct: settings,
                customContext: { ...power_user.context, story_string_position: extension_prompt_types.IN_CHAT },
            });
            const cue = instruct.formatInstructModePrompt('', false, '', 'Test User', 'Test Character', false, false, settings);
            const adjacent = instruct.coalesceAdjacentUserMessages([
                { role: 'user', content: 'U1' },
                { role: 'user', content: 'U2' },
            ]);
            const separated = [
                { role: 'user', content: 'U1' },
                { role: 'system', content: 'SYS2' },
                { role: 'user', content: 'U2' },
            ];
            const coreTurns = [
                { index: 20, is_user: true, name: 'Test User', mes: 'U1' },
                { index: 21, is_user: true, name: 'Test User', mes: 'U2' },
            ];
            const projectedTurns = instruct.coalesceAdjacentUserTurns(coreTurns);
            return {
                systemOnly: story('SYS'),
                emptyWithPrefix,
                emptyWithoutPrefix,
                emptyWithEmptyPrefix,
                emptyInChat,
                singleUser: `${emptyWithPrefix}${role('Test User', 'USR', true)}${cue}`,
                systemAndUser: `${story('SYS')}${role('Test User', 'USR', true)}${cue}`,
                assistantHistory: `${story('SYS')}${role('Test User', 'U1', true)}${role('Test Character', 'A1', false)}${role('Test User', 'U2', true)}${cue}`,
                adjacentUsers: `${story('SYS')}${adjacent.map(message => message.role === 'system'
                    ? role('System', message.content, false, true)
                    : role('Test User', message.content, true)).join('')}${cue}`,
                systemBoundary: `${story('SYS')}${role('Test User', 'U1', true)}${role('System', 'SYS2', false, true)}${role('Test User', 'U2', true)}${cue}`,
                separatedRolesRemainDistinct: separated.map(message => message.role).join(','),
                projectionPreservesSourceBoundary: projectedTurns[0]._skipPromptRender
                    && projectedTurns[1].mes === 'U1\n\nU2'
                    && projectedTurns[1].index === 20
                    && coreTurns.map(message => message.index).join(',') === '20,21',
            };
        }, v41Preset);

        expect(rendered.systemOnly).toBe('<｜begin▁of▁sentence｜><｜System｜>SYS');
        expect(rendered.emptyWithPrefix).toBe('<｜begin▁of▁sentence｜>');
        expect(rendered.emptyWithoutPrefix).toBe('');
        expect(rendered.emptyWithEmptyPrefix).toBe('');
        expect(rendered.emptyInChat).toBe('');
        expect(rendered.singleUser).toBe('<｜begin▁of▁sentence｜><｜User｜>USR<｜Assistant｜></think>');
        expect(rendered.systemAndUser).toBe('<｜begin▁of▁sentence｜><｜System｜>SYS<｜User｜>USR<｜Assistant｜></think>');
        expect(rendered.assistantHistory).toBe('<｜begin▁of▁sentence｜><｜System｜>SYS<｜User｜>U1<｜Assistant｜></think>A1<｜end▁of▁sentence｜><｜User｜>U2<｜Assistant｜></think>');
        expect(rendered.adjacentUsers).toBe('<｜begin▁of▁sentence｜><｜System｜>SYS<｜User｜>U1\n\nU2<｜Assistant｜></think>');
        expect(rendered.systemBoundary).toBe('<｜begin▁of▁sentence｜><｜System｜>SYS<｜User｜>U1<｜System｜>SYS2<｜User｜>U2<｜Assistant｜></think>');
        expect(rendered.separatedRolesRemainDistinct).toBe('user,system,user');
        expect(rendered.projectionPreservesSourceBoundary).toBe(true);
    });

    test('ordinary text generation coalesces adjacent users without changing stored turns or crossing an injected system turn', async ({ page }) => {
        await ready(page);
        await page.evaluate(async settings => {
            const script = await import('/script.js');
            const { power_user } = await import('/scripts/power-user.js');
            Object.assign(power_user.instruct, settings, { enabled: true });
            power_user.instruct.preset = settings.name;
            power_user.instruct_api_activation_configured = true;
            power_user.context.story_string = '';
            await script.sendMessageAsUser('TEST_USER_ONE', null);
            await script.sendMessageAsUser('TEST_USER_TWO', null);
            await script.sendMessageAsUser('TEST_USER_THREE', null);
            await script.sendMessageAsUser('TEST_USER_FOUR', null);
            script.setExtensionPrompt(
                'deepseek-v41-test-system-boundary',
                'TEST_SYSTEM_BOUNDARY',
                script.extension_prompt_types.IN_CHAT,
                1,
                false,
                script.extension_prompt_roles.SYSTEM,
            );
        }, v41Preset);

        /** @type {Array<{prompt: string, userMessages: string[]}>} */
        const captured = [];
        await page.route('**/api/backends/text-completions/generate**', async route => {
            const body = JSON.parse(route.request().postData() ?? 'null');
            const userMessages = await page.evaluate(async () => {
                const { chat } = await import('/script.js');
                return chat.filter(message => message.is_user).map(message => message.mes);
            });
            captured.push({ prompt: body.prompt, userMessages });
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ text: 'TEST_ASSISTANT_REPLY' }] }),
            });
        });

        await page.locator('#send_textarea').fill('TEST_CURRENT_USER');
        await page.locator('#send_but').click();
        await expect.poll(() => captured.length, { timeout: 60_000 }).toBe(1);

        const { prompt, userMessages } = captured[0];
        expect(prompt.startsWith('<｜begin▁of▁sentence｜>')).toBe(true);
        expect(prompt).toContain('<｜User｜>TEST_USER_ONE\n\nTEST_USER_TWO\n\nTEST_USER_THREE\n\nTEST_USER_FOUR<｜System｜>TEST_SYSTEM_BOUNDARY');
        expect(prompt.indexOf('TEST_USER_FOUR')).toBeLessThan(prompt.indexOf('TEST_SYSTEM_BOUNDARY'));
        expect(prompt.indexOf('TEST_SYSTEM_BOUNDARY')).toBeLessThan(prompt.indexOf('TEST_CURRENT_USER'));
        expect(userMessages).toEqual([
            'TEST_USER_ONE',
            'TEST_USER_TWO',
            'TEST_USER_THREE',
            'TEST_USER_FOUR',
            'TEST_CURRENT_USER',
        ]);
    });
});
