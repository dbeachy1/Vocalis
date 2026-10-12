/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach for
//   `globalThis` and dynamic `import()` of the app's own modules. Lint sees one file and cannot tell the
//   two contexts apart.

import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';
import { analyzeGeometry, Verdict } from '../../src/prompt-cache-geometry.js';

/**
 * 🔴 CAN SILLYTAVERN COLD-TURN ITSELF? A REPRODUCTION, NOT A THEORY.
 *
 * Measurement showed that llama.cpp absorbs a deletion above the chat
 * history and cannot absorb an insertion, and three things in the assembly can produce
 * one. That is all mechanism and no evidence: it says a cold turn is POSSIBLE without showing the client
 * actually producing one, and "possible" is what every previous round of this hunt has run on.
 *
 * The candidate under test is the one the mechanism makes unavoidable rather than configurable. The prompt
 * is trimmed to a token budget, and the budget is recomputed from scratch every turn — so when a turn's
 * content is SMALLER than the last one's, room appears, and something that had been pushed out comes back.
 * Coming back means arriving above everything below it, which is the expensive direction.
 *
 * Real replies vary in length, so this drives long and short ones alternately and reads the verdicts off
 * the prompts SillyTavern actually posted. Nothing here is a model: `analyzeGeometry` is the same code the
 * server runs in production, given the same two strings.
 *
 * ⚠️ THE DEFAULT WINDOW IS 2,048 TOKENS (`script.js:628`) AND THE SHIPPED CARD FILLS IT, so the trim loop
 * is live from the first turn without configuring anything. That is deliberate — a reproduction that needs
 * a hand-tuned context is a reproduction of the tuning.
 */
test.describe.configure({ mode: 'serial', timeout: 240_000 });

/** A reply long enough to push content out of a 2,048-token window. */
const LONG_REPLY = ` ${'The shutters burst inward and the rain came with them, sheeting across the flagstones. '.repeat(24)}`;

/** And one short enough that the next turn has room it did not have before. */
const SHORT_REPLY = ' She nodded.';

test.describe('the client can put content back above the history, which is the cold direction', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    let base = '';

    test.beforeAll(async () => {
        test.setTimeout(240_000);

        const scratch = makeScratchDirectory('cold-turn-repro');
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

    test('🔴 a short reply after a long one lets evicted content back in, above everything below it', async ({ page }) => {
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

            // 🔴 FORCE THE TRIMMING REGIME, OR THIS SPEC PROVES NOTHING. The first run of it drove six turns
            // against whatever window the boot preset had loaded, and `hist` grew monotonically from 2,948
            // to 7,344 characters: nothing was ever evicted, so the mechanism under test — content coming
            // BACK after being pushed out — never had its precondition. Every pair came back TAIL_CHANGE,
            // which reads like a negative result and was really a harness that never entered the regime.
            $('#max_context').val(1600).trigger('input');
            $('#amount_gen').val(80).trigger('input');
        });

        /** @type {Array<{prompt: string, shape: string}>} */
        const turns = [];
        /** What the stub answers next. Alternated so the budget grows and shrinks the way it really does. */
        let reply = LONG_REPLY;

        await page.route('**/api/backends/text-completions/generate**', async (route) => {
            const headers = route.request().headers();
            const body = JSON.parse(route.request().postData() ?? 'null');

            if (decodeURIComponent(headers['x-st-gen-type'] ?? '') === 'normal' && typeof body?.prompt === 'string') {
                turns.push({ prompt: body.prompt, shape: headers['x-st-prompt-shape'] ?? '' });
            }

            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ text: reply }] }),
            });
        });

        // Long, long, short, long, short, short — enough alternation that at least one turn follows a
        // smaller one. Six is the fewest that gives the pattern room without making the spec slow.
        const script = [
            LONG_REPLY, LONG_REPLY, LONG_REPLY, LONG_REPLY,
            SHORT_REPLY, LONG_REPLY, SHORT_REPLY, SHORT_REPLY, LONG_REPLY, SHORT_REPLY,
        ];

        for (let turn = 0; turn < script.length; turn++) {
            reply = script[turn];

            const before = turns.length;
            await page.locator('#send_textarea').fill(`Turn ${turn}, and then what happened?`);
            await page.locator('#send_but').click();

            await expect.poll(() => turns.length > before, {
                timeout: 60_000,
                message: `Turn ${turn} never posted a 'normal' completion.`,
            }).toBe(true);
        }

        await page.unroute('**/api/backends/text-completions/generate**');

        expect(turns.length).toBe(script.length);

        // Now run production's own analysis over consecutive pairs, exactly as the server does.
        const verdicts = turns.slice(1).map((turn, i) => {
            const geometry = analyzeGeometry(turns[i].prompt, turn.prompt);
            return {
                pair: `${i} -> ${i + 1}`,
                verdict: geometry.verdict,
                reusable: geometry.reusable,
                commonPrefix: geometry.commonPrefix,
                length: geometry.length,
                shapeBefore: turns[i].shape,
                shapeAfter: turn.shape,
            };
        });

        // Printed whatever happens: when this spec fails, the sequence IS the finding, and reconstructing it
        // from an assertion message is how a real result gets thrown away.
        // eslint-disable-next-line no-console
        console.log(verdicts.map(v => `${v.pair}: ${v.verdict} ${v.reusable}/${v.length}\n    ${v.shapeBefore}\n    ${v.shapeAfter}`).join('\n'));

        // 🔴 THE PRECONDITION, ASSERTED SEPARATELY SO A HARNESS FAILURE CANNOT MASQUERADE AS A RESULT.
        // Content can only come back above the history if it was pushed out first. If the window never
        // filled, this spec has measured nothing and must say so in those words rather than reporting a
        // reassuring row of TAIL_CHANGE.
        const historyOf = (shape) => Number(new Map(String(shape).slice(3).split(';').map(p => p.split('='))).get('hist'));
        const evicted = turns.slice(1).some((turn, i) => historyOf(turn.shape) < historyOf(turns[i].shape));

        expect(evicted, `The history never shrank, so the window never filled and nothing was ever evicted — this run never entered the regime the spec is about. Histories: ${turns.map(t => historyOf(t.shape)).join(', ')}.`).toBe(true);

        const cold = verdicts.filter(v => v.verdict === Verdict.INSERTION_ABOVE);

        // 🔴 THE CLAIM. If this fails, the candidate in §8 is wrong and the doc must say so — it does not
        // mean "flaky", and it must not be softened into `toBeGreaterThanOrEqual(0)`.
        expect(cold.length, `No pair needed a forward shift, so this client never cold-turned itself in six turns. Sequence:\n${verdicts.map(v => `${v.pair}: ${v.verdict}`).join('\n')}`).toBeGreaterThan(0);

        // And what makes an insertion expensive is definitional rather than a threshold: the reuse loop
        // recovered NOTHING beyond the plain common prefix, so every character past it is reprocessed.
        // An earlier draft asserted `reusable / length < 0.5` and failed at 0.572 — an arbitrary number
        // that said nothing about the mechanism and invited being tuned until it passed.
        for (const entry of cold) {
            expect(entry.reusable).toBe(entry.commonPrefix);
        }
    });
});
