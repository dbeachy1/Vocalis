/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach for
//   `document` and dynamic `import()` of the app's own modules. Lint sees one file and cannot tell the two
//   contexts apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(path.dirname(here));
const FIXTURE = path.join(serverDirectory, 'tests', 'fixtures', 'window-only-plugin.mjs');

/**
 * 🔴 THE SHIM GOES IN SCRATCH, AND THE SERVER IS TOLD TO LOOK THERE — both halves, or the assertion is vacuous.
 *
 * This spec used to write the shim into the repository's own `plugins/` and then boot without naming a
 * `pluginsPath`. `startSillyTavern` defaults that to `<dataRoot>/no-plugins-installed`, which deliberately does
 * not exist, so the server never saw the shim: `listPromptDeclarations()` came back empty, the window was the
 * fail-safe 0, and the §17.6 test below failed for a reason that had nothing to do with §17.6.
 *
 * Writing into the real `plugins/` was the worse half. That directory holds this install's ACTUAL plugins —
 * Mnemosyne on test-host — and a suite that boots a server against it inherits whatever the machine has installed,
 * which is the failure `tests/util/st-server.js` exists to prevent. Scratch lives under the OS temp directory,
 * so it is a fresh directory per run holding exactly one plugin.
 */
const PLUGINS_DIRECTORY = makeScratchDirectory('text-path-plugins');
const SHIM = path.join(PLUGINS_DIRECTORY, 'zz-window-only-e2e.mjs');

/**
 * 🔴 THE CLIENT HALF OF §18 AND §19, WHICH NO SERVER TEST CAN SEE.
 *
 * The server side of the instruct envelope is three string concatenations and is trivially green — it takes
 * `{prefix, suffix, stop}` and joins them. **Every way §19 can actually fail lives in the browser**, in the
 * function that DERIVES those three strings from the active template, and §19.2 is a warning about exactly
 * that: the obvious derivation reads `input_sequence`/`output_sequence`/`input_suffix`, which produces correct
 * ChatML and, for Alpaca-Single-Turn, concatenates three empty strings and reports success. A suite that only
 * exercises ChatML cannot tell the two apart.
 *
 * So this drives the two shipped presets that disagree most, in a real page, against the app's own
 * `instruct-mode.js` — and asserts the bytes. It is the §14.10.1 lesson applied before rather than after: a
 * green server suite proves nothing about the half a user actually runs.
 *
 * ⚠️ IT BOOTS ITS OWN SERVER because it needs a plugin installed to check the window declaration reaches the
 * client, and it has to step past onboarding for the reason recorded in `plugin-panels.e2e.js`.
 */
// ⚠️ 180s, NOT PLAYWRIGHT'S 30s DEFAULT, BECAUSE `beforeAll` BOOTS A REAL SERVER. A boot starved of
//    CPU by the parallel batch is a machine-load measurement, not a failing assertion, and reporting
//    it as one hides the real ones.
//
// 🔴 AND THE LINE BELOW IS ONLY HALF OF IT — `test.setTimeout()` INSIDE THE HOOK IS THE OTHER HALF.
//    `describe.configure({ timeout })` sets the budget for the TESTS and does nothing for a hook:
//    measured with a pair of throwaway specs whose `beforeAll` sleeps 40s, the one carrying only the
//    line below died with `"beforeAll" hook timeout of 30000ms exceeded` and the one calling
//    `test.setTimeout()` in the hook passed. This spec was "fixed" with the line below alone, passed
//    the next run on lighter contention, and failed again exactly as before.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('the text-path capabilities (front-end)', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('text-path-e2e');
        fs.writeFileSync(SHIM, `export { info, init } from ${JSON.stringify(new URL(`file:///${FIXTURE.split(path.sep).join('/')}`).href)};\n`, 'utf-8');

        server = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'window-only',
            },
        });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;

        // 🔴 STEP PAST ONBOARDING, OR NOTHING BELOW RUNS — see plugin-panels.e2e.js for the full diagnosis. A
        // fresh data root is a first run, `getSettings()` waits on a dialog, and `firstLoadInit` never finishes.
        await stepPastFirstRun(path.join(scratch, 'data'));
    });

    test.afterAll(async () => {
        if (server) await server.stop();
        if (fs.existsSync(SHIM)) fs.unlinkSync(SHIM);
    });

    test.beforeEach(async ({ page }) => {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        // Wait for the app's own settings to be live, because everything below reaches into module state
        // rather than clicking. `power_user.context` is populated by `getSettings()`.
        await page.waitForFunction(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            return !!power_user?.context;
        }, null, { timeout: 60_000 });
    });

    /**
     * The two shipped presets that disagree most about where framing lives, READ FROM THE REAL FILES.
     *
     * ⚠️ NOT SELECTED THROUGH THE UI, AND NOT BY NAME. A scratch data root has no seeded content, so the
     * preset dropdown is empty and `selectInstructPreset` finds nothing — which cost a debugging round. Poking
     * the settings object directly is also the better test: it pins the derivation against the exact bytes
     * upstream ships, so editing one of these JSON files shows up here rather than silently changing what
     * every wrapped plugin prompt looks like.
     * @param {string} name The preset file's base name
     * @returns {object} The preset, as shipped
     */
    function shippedPreset(name) {
        return JSON.parse(fs.readFileSync(path.join(serverDirectory, 'default', 'content', 'presets', 'instruct', `${name}.json`), 'utf-8'));
    }

    /**
     * Apply a preset to the live page and hand back the envelope it derives.
     * @param {import('@playwright/test').Page} page
     * @param {object} preset The preset object
     * @returns {Promise<{prefix: string, suffix: string, stop: string[]}>}
     */
    async function envelopeFor(page, preset) {
        return await page.evaluate(async (settings) => {
            const { power_user } = await import('/scripts/power-user.js');
            const instruct = await import('/scripts/instruct-mode.js');
            Object.assign(power_user.instruct, settings, { enabled: true });
            return instruct.getSingleTurnInstructEnvelope();
        }, preset);
    }

    test('🔴 ChatML — framing from the sequence fields, and a terminator', async ({ page }) => {
        const envelope = await envelopeFor(page, shippedPreset('ChatML'));

        expect(envelope.prefix).toBe('<|im_start|>system\n');
        expect(envelope.suffix).toBe('<|im_end|>\n<|im_start|>assistant\n');

        // A whole wrapped instruction, so a failure shows what a model would actually receive.
        expect(`${envelope.prefix}INSTRUCTION${envelope.suffix}`)
            .toBe('<|im_start|>system\nINSTRUCTION<|im_end|>\n<|im_start|>assistant\n');

        // ST's own terminator, newline-prefixed because the template wraps — not a guess at one.
        expect(envelope.stop).toContain('\n<|im_end|>');
    });

    test('⚠️ the stop list stays inside the four-slot budget, and carries no duplicates', async ({ page }) => {
        // `plugin-generate.js` caps stops at 4 and the envelope's go FIRST, so every slot the envelope takes
        // is one the plugin cannot have. The unfiltered list appends the context template's "Chat Start" and
        // "Example Separator" — transcript punctuation, irrelevant to a self-contained instruction, and BOTH
        // literally `***` on the stock templates, so one slot went to a duplicate of another slot. Found by
        // printing what a real page produced, not by reading the code.
        for (const name of ['ChatML', 'Alpaca-Single-Turn']) {
            const { stop } = await envelopeFor(page, shippedPreset(name));

            expect(new Set(stop).size).toBe(stop.length);
            expect(stop.length).toBeLessThanOrEqual(4);
            expect(stop).not.toContain('\n***');
        }
    });

    test('🔴 Alpaca-Single-Turn — the preset that breaks the obvious implementation', async ({ page }) => {
        // Its `input_sequence`, `output_sequence` and `input_suffix` are ALL "". Any derivation built from
        // those three fields produces an empty envelope here and sends the prompt completely unwrapped while
        // reporting success. This is the assertion that catches it.
        const envelope = await envelopeFor(page, shippedPreset('Alpaca-Single-Turn'));

        expect(envelope.prefix).toContain('Below is an instruction that describes a task');
        expect(envelope.prefix).toContain('### Instruction:');
        expect(envelope.suffix).toContain('### Response:');

        // Not empty. That is the whole point.
        expect(envelope.prefix).not.toBe('');
        expect(envelope.suffix).not.toBe('');
    });

    test('the two presets produce genuinely different bytes, from one code path', async ({ page }) => {
        const chatml = await envelopeFor(page, shippedPreset('ChatML'));
        const alpaca = await envelopeFor(page, shippedPreset('Alpaca-Single-Turn'));

        expect(chatml.prefix).not.toBe(alpaca.prefix);
        expect(chatml.suffix).not.toBe(alpaca.suffix);
    });

    test('the sentinel never survives into the envelope', async ({ page }) => {
        // The framing is derived by running ST's own formatters over a marker and splitting around it. A
        // marker that leaked through would be sent to the model verbatim, in every wrapped prompt.
        for (const preset of [shippedPreset('ChatML'), shippedPreset('Alpaca-Single-Turn')]) {
            const envelope = await envelopeFor(page, preset);
            expect(envelope.prefix + envelope.suffix).not.toContain('ST_ENVELOPE');
        }
    });

    test('instruct mode off yields an empty envelope, which is the truth and not a failure', async ({ page }) => {
        const envelope = await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            const instruct = await import('/scripts/instruct-mode.js');
            power_user.instruct.enabled = false;
            return instruct.getSingleTurnInstructEnvelope();
        });

        // An all-empty envelope is still an envelope: `wrap: true` becomes a no-op that SUCCEEDS, where a
        // missing one throws. With no instruct template there is genuinely no framing to apply.
        expect(envelope).toEqual({ prefix: '', suffix: '', stop: [] });
    });

    test('🔴 the generation headers carry the type and the envelope (§18, §19)', async ({ page }) => {
        const headers = await page.evaluate(async (settings) => {
            const { power_user } = await import('/scripts/power-user.js');
            const script = await import('/script.js');

            Object.assign(power_user.instruct, settings, { enabled: true });

            return {
                withType: script.getGenerationHeaders('impersonate'),
                withoutType: script.getGenerationHeaders(),
            };
        }, shippedPreset('ChatML'));

        // Verbatim, URL-encoded, exactly as `readIdentityHeaders` expects to decode it.
        expect(headers.withType['X-ST-Gen-Type']).toBe('impersonate');

        // Absent for an ordinary generation — which is what the world looked like before §18 existed, and
        // therefore what "no header" has to keep meaning.
        expect(headers.withoutType).not.toHaveProperty('X-ST-Gen-Type');

        const envelope = JSON.parse(decodeURIComponent(headers.withType['X-ST-Instruct-Envelope']));
        expect(envelope.prefix).toBe('<|im_start|>system\n');
        expect(envelope.suffix).toBe('<|im_end|>\n<|im_start|>assistant\n');
    });

    test('🔴 a plugin\'s declared window reaches the client (§17.6, outward)', async ({ page }) => {
        // The direction that did not exist before: everything else flows client → server → plugin. The
        // fixture declares 7 and registers NO panel, so a client-config keyed off panels would drop it.
        const window = await page.evaluate(async () => {
            const config = await import('/scripts/plugin-client-config.js');
            await config.initPluginPrompts();
            return { window: config.getRecentMessagesWindow(), raw: await config.getPluginClientConfig() };
        });

        expect(window.window).toBe(7);
        expect(window.raw.prompts).toEqual({ 'window-only': { recentMessages: 7 } });
        expect(window.raw.panels).toEqual([]);
    });

    /**
     * 🔴 THE `??` / `||` BUG, PINNED IN THE BROWSER BECAUSE THAT IS THE ONLY PLACE IT LIVES.
     *
     * `custom-request.js` imports from `../script.js`, which pulls in the whole application — so this is not
     * reachable from jest, and a server test cannot see it either: by the time the request arrives the field
     * is already an empty string and the server has no way to know a fallback was skipped.
     *
     * The defect: `api_server ?? getTextGenServer(api_type)` falls back only on null/undefined. `''` is not
     * nullish, so it passed through untouched. `ConnectionManagerRequestService.sendRequest` feeds this
     * `profile['api-url']` verbatim (`extensions/shared.js:476`), and a connection profile records `''` for a
     * blank Server URL — so every extension-issued generation through a such a profile sent `api_server: ''`,
     * the server concatenated `'' + '/v1/completions'`, and `fetch` threw ERR_INVALID_URL.
     *
     * Qvink Memory takes exactly this path, which is how it surfaced: four toasts reading "Response not OK".
     */
    test('🔴 a blank Server URL falls back to the configured one — the `??` vs `||` regression', async ({ page }) => {
        const resolved = await page.evaluate(async () => {
            const { TextCompletionService } = await import('/scripts/custom-request.js');
            const { textgenerationwebui_settings } = await import('/scripts/textgen-settings.js');

            // What the user actually has configured for this backend.
            textgenerationwebui_settings.server_urls['ooba'] = 'http://127.0.0.1:5000';

            const build = (api_server) => TextCompletionService.createRequestData(
                { prompt: 'p', max_tokens: 8, api_type: 'ooba', ...(api_server === undefined ? {} : { api_server }) },
            ).api_server;

            return { blank: build(''), whitespaceIsNotBlank: build('   '), missing: build(undefined), explicit: build('http://example.test:9') };
        });

        // 🔴 The regression itself. Before the fix this was `''`, which became the relative `/v1/completions`.
        expect(resolved.blank).toBe('http://127.0.0.1:5000');

        // The pre-existing nullish case must keep working — the fix widens the fallback, it does not move it.
        expect(resolved.missing).toBe('http://127.0.0.1:5000');

        // 🔴 CONTROL: a real URL is still passed through untouched. Without this, "always use the configured
        // server" would also satisfy the assertions above, and that would break every profile that legitimately
        // points somewhere other than the active backend — the exact thing connection profiles exist to do.
        expect(resolved.explicit).toBe('http://example.test:9');

        // Documented, not endorsed: `||` treats only the empty string as absent. A whitespace-only URL is still
        // garbage and still cannot be fetched — but it is now caught by the server's guard, with a message that
        // names the api type, rather than by an opaque ERR_INVALID_URL out of undici.
        expect(resolved.whitespaceIsNotBlank).toBe('   ');
    });

    /**
     * 🔴 THE REASON HAS TO REACH THE USER, OR THE SERVER'S GOOD MESSAGE IS WRITE-ONLY.
     *
     * Both backend routes answer a refusal with `{ error: true, status, response }`. `error` is a BOOLEAN, so
     * the client's `json.error?.message` was always undefined and every failure collapsed to the six words
     * "Response not OK" — identical whether the server URL is blank, the backend refused, or the request never
     * left the box.
     *
     * This is the full chain in one assertion: client builds the payload, server refuses it by name, and the
     * refusal comes back as something a person can act on. It runs against the spec's own live server, so a
     * change on either side breaks it.
     */
    test('🔴 a refusal reaches the user as the server\'s reason, not "Response not OK"', async ({ page }) => {
        const thrown = await page.evaluate(async () => {
            const { TextCompletionService } = await import('/scripts/custom-request.js');
            const { textgenerationwebui_settings } = await import('/scripts/textgen-settings.js');

            // Nothing configured anywhere — neither the caller nor the fallback can supply a URL.
            textgenerationwebui_settings.server_urls['ooba'] = '';

            try {
                await TextCompletionService.sendRequest(
                    TextCompletionService.createRequestData({ prompt: 'p', max_tokens: 8, api_type: 'ooba', api_server: '' }),
                );
                return '(no error was thrown — the request was not refused)';
            } catch (error) {
                return error.message;
            }
        });

        // 🔴 The regression: before the fix this was exactly 'Response not OK' and nothing else.
        expect(thrown).not.toBe('Response not OK');

        // It names the api type and the actual problem, which is what makes it actionable without a log dig.
        expect(thrown).toContain('ooba');
        expect(thrown).toContain('No server URL is configured');
        expect(thrown).toContain('connection profile');
    });

    /**
     * 🔴 A STALE CONNECTION PROFILE IS NAMED, BECAUSE ITS NAME IS THE ONLY THING THAT MAKES IT FIXABLE.
     *
     * A profile captures `api` and `api-url` when it is saved and never again. Switch backends afterwards and
     * the live panel shows the new one while the profile still holds the old — chat generates perfectly, and
     * every profile-driven request goes somewhere else.
     *
     * Reproduced live on :8001 before this guard existed: a profile holding `api: 'ooba'` with a blank Server
     * URL, against a live KoboldCpp connection, put `{api_type: 'ooba', api_server: ''}` on the wire. The
     * server can only name the api type — the profile's NAME is never sent — so the identifier that turns
     * this into a one-click fix has to come from the client.
     */
    test('🔴 a stale profile is refused by NAME, before anything is sent', async ({ page }) => {
        // ⚠️ `CONNECT_API_MAP` is filled by `initDefaultSlashCommands()`, which runs LATER than the
        // `power_user.context` gate `beforeEach` uses. Without this wait the profile resolves to
        // "Unknown API type ooba" — a real error, but the wrong one, and the test reads as a broken guard.
        await page.waitForFunction(
            () => Object.keys(globalThis.SillyTavern?.getContext?.()?.CONNECT_API_MAP ?? {}).length > 0,
            null,
            { timeout: 60_000 },
        );

        const result = await page.evaluate(async () => {
            const ctx = globalThis.SillyTavern.getContext();
            const cm = ctx.extensionSettings.connectionManager ??= { profiles: [], selectedProfile: '' };
            const before = cm.profiles;

            cm.profiles = [
                { id: 'stale', name: 'test-host 5001', mode: 'tc', api: 'ooba', 'api-url': '' },
                { id: 'good', name: 'test-host 5001 fresh', mode: 'tc', api: 'ooba', 'api-url': 'http://127.0.0.1:5001/' },
            ];

            const out = {};
            try {
                await ctx.ConnectionManagerRequestService.sendRequest('stale', [{ role: 'user', content: 'x' }], 8);
                out.stale = '(not refused)';
            } catch (error) {
                out.stale = error.message;
            }

            // 🔴 CONTROL: the same api type with a URL present must NOT be refused by this guard, or the check
            // would simply block every ooba profile and the assertions above would still pass.
            try {
                await ctx.ConnectionManagerRequestService.sendRequest('good', [{ role: 'user', content: 'x' }], 8);
                out.good = '(reached the backend)';
            } catch (error) {
                out.good = error.message;
            }

            cm.profiles = before;
            return out;
        });

        expect(result.stale).toContain('test-host 5001');
        expect(result.stale).toContain('ooba');
        expect(result.stale).toMatch(/re-save it while connected/i);

        // The control failed for a DIFFERENT reason — nothing is listening on 5001 in the test — which is
        // exactly the point: it got past the profile guard and actually tried.
        expect(result.good).not.toMatch(/has no Server URL/);
    });
});
