/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach for
//   `globalThis` and dynamic `import()` of the app's own modules. Lint sees one file and cannot tell the
//   two contexts apart.

import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/**
 * 🔴 A MESSAGE THE CONTEXT WINDOW HAS DROPPED MUST NEVER COME BACK.
 *
 * Re-admitting one is the single change a prefix KV cache cannot absorb: it arrives ABOVE everything
 * already cached, and llama.cpp's reuse loop only ever advances its cache pointer, so cached content can
 * slide earlier and never later. The test below verifies that a
 * shrinking injected prompt does not re-admit messages already removed from the cached prefix.
 *
 * 🔴 THE TRIGGER IS A PLAIN `IN_CHAT` EXTENSION PROMPT, WHICH IS THE POINT. `doChatInject` takes the same
 * path for a World Info `@ D` entry, a summary, a vector recall or a memory plugin — `chatInjects` is built
 * from `injectedIndices` regardless of who filled them. So this tests the class, not one extension, which
 * is why the fix cannot be an extension-side convention about holding a constant size.
 *
 * ⚠️ THE NUMBERS BELOW ARE COMPUTED, NOT TUNED. Re-admission requires the budget freed by the injection
 * vanishing to exceed the budget consumed by the turn that frees it. Four earlier attempts guessed at
 * window/injection/reply sizes and produced specs that passed identically with the fix disabled — a red
 * test reached by fiddling is a test fitted to its author's expectation. The backend is stubbed here, so
 * reply length is an exact input: a ~150-character reply spends ~35 tokens per turn, the injection is
 * ~4,000 characters (~900 tokens), and dropping it therefore frees an order of magnitude more than any
 * turn consumes. The condition is arithmetic and cannot fail to occur.
 *
 * ⚠️ AND THE ASSERTION IS THE INVARIANT ITSELF, NOT A REUSE PERCENTAGE. An injection anchored at depth
 * re-anchors to the tail every turn, so `INSERTION_ABOVE` near the BOTTOM of the prompt is legitimate and
 * cheap; keying on the verdict flags it, and keying on a reuse floor flags ordinary early-chat growth.
 * Each user message carries a unique marker, and the rule is simply that once a marker has left the
 * prompt it never appears in one again.
 */
test.describe.configure({ mode: 'serial', timeout: 240_000 });

/** Short and constant, so each turn adds a known, small amount of budget. */
const REPLY = ' She considered the question, and then did not answer it, which was itself an answer.';

/** Large enough that removing it frees far more than a turn consumes. */
const INJECTION = `[Recalled: ${'the obelisk was raised in the ninth year and the river changed course. '.repeat(55)}]`;

/** Enough turns with the injection present that the window fills and drops messages. */
const TURNS_WITH_INJECTION = 14;

/**
 * Then it vanishes — the fatal transition — and enough turns follow to watch the window recover.
 *
 * ⚠️ THE RECOVERY IS THE HALF THAT MAKES THE FIX ACCEPTABLE. Holding the floor is useless if it holds
 * forever: a window stuck at five messages would be worse than the bug it prevents. The mark never falls,
 * but it stops BINDING — new messages are all newer than it, so the window refills with them until the
 * token budget is the constraint again and ordinary eviction resumes.
 */
const TURNS_WITHOUT = 20;

test.describe('an evicted message never comes back', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    let base = '';

    test.beforeAll(async () => {
        test.setTimeout(240_000);

        const scratch = makeScratchDirectory('evicted-stay-evicted');
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

    test('🔴 a depth injection vanishing does not re-admit what the window already dropped', async ({ page }) => {
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

            // Room for the injection AND several messages, but not for many — so the window fills within a
            // few turns while the injection is present. Too small and the injection does not fit at all and
            // `inj` reads 0 on every turn; too large and nothing is ever evicted. Both were observed.
            $('#max_context').val(2000).trigger('input');
            $('#amount_gen').val(60).trigger('input');
        });

        /** @type {Array<{prompt: string, shape: string}>} */
        const turns = [];

        await page.route('**/api/backends/text-completions/generate**', async (route) => {
            const headers = route.request().headers();
            const body = JSON.parse(route.request().postData() ?? 'null');

            if (decodeURIComponent(headers['x-st-gen-type'] ?? '') === 'normal' && typeof body?.prompt === 'string') {
                turns.push({ prompt: body.prompt, shape: headers['x-st-prompt-shape'] ?? '' });
            }

            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ text: REPLY }] }),
            });
        });

        const total = TURNS_WITH_INJECTION + TURNS_WITHOUT;

        for (let turn = 0; turn < total; turn++) {
            const injected = turn < TURNS_WITH_INJECTION;

            await page.evaluate(async ({ text, on }) => {
                const script = await import('/script.js');
                const { extension_prompt_types } = await import('/script.js');

                // The same door a World Info `@ D` entry, a summary or a memory plugin goes through.
                script.setExtensionPrompt('EVICTION_SPEC', on ? text : '', extension_prompt_types.IN_CHAT, 4, false);
            }, { text: INJECTION, on: injected });

            const before = turns.length;
            await page.locator('#send_textarea').fill(`MARKER${turn}Q and then what happened?`);
            await page.locator('#send_but').click();

            await expect.poll(() => turns.length > before, {
                timeout: 60_000,
                message: `Turn ${turn} never posted a 'normal' completion.`,
            }).toBe(true);
        }

        await page.unroute('**/api/backends/text-completions/generate**');

        expect(turns.length).toBe(total);

        const field = (shape, name) => Number(new Map(shape.slice(3).split(';').map((pair) => {
            const [key, value] = pair.split('=');
            return [key, Number(value)];
        })).get(name) ?? 0);

        const messageCounts = turns.map(t => field(t.shape, 'msgs'));
        const injections = turns.map(t => field(t.shape, 'inj'));

        // Preconditions. A run that skips either of these proves nothing while looking like a pass, which is
        // how four earlier attempts at this spec went green against a disabled fix.
        expect(Math.max(...injections), `The injection never reached the prompt. Injections: ${injections.join(', ')}.`).toBeGreaterThan(1000);
        expect(Math.min(...injections), `The injection never went away, so the transition under test never happened. Injections: ${injections.join(', ')}.`).toBe(0);

        // ⚠️ "THE COUNT WENT DOWN" IS THE WRONG PRECONDITION AND IT COST A RUN. With the injection present
        // `msgs` sat flat at 5 for twelve turns while the chat grew past 28: the window was not shrinking,
        // it was ROTATING — one message leaving for each one arriving. What matters is that a specific
        // message left, so ask that instead.
        console.log(`msgs: ${messageCounts.join(', ')}`);
        console.log(`inj:  ${injections.join(', ')}`);

        const markerPresence = Array.from({ length: total }, (_, marker) => turns.map(t => t.prompt.includes(`MARKER${marker}Q`)));
        // ⚠️ AND "LEFT AND STAYED GONE" IS WRONG TOO. The pattern under test is present -> absent ->
        // PRESENT AGAIN, so the last appearance is the final turn and a lastIndexOf test never fires. Ask
        // only that a message was absent at some point after it first appeared; whether it returned is the
        // invariant's job, not the precondition's.
        const somethingLeft = markerPresence.some((present) => {
            const first = present.indexOf(true);
            return first >= 0 && present.slice(first).some(seen => !seen);
        });

        expect(somethingLeft, `No message ever left the window, so nothing could be re-admitted. msgs: ${messageCounts.join(', ')}.`).toBe(true);

        // 🔴 THE INVARIANT. For every marker, the turns whose prompt contains it must be one unbroken run:
        // it enters, it stays, it leaves, and it never returns. A gap is a re-admission.
        const returned = [];

        for (let marker = 0; marker < total; marker++) {
            const token = `MARKER${marker}Q`;
            const present = markerPresence[marker];
            const first = present.indexOf(true);

            if (first < 0) {
                continue;
            }

            const last = present.lastIndexOf(true);
            const gap = present.slice(first, last + 1).some(seen => !seen);

            if (gap) {
                returned.push(`${token}: ${present.map(seen => (seen ? '#' : '.')).join('')}`);
            }
        }

        expect(returned.length, `A message left the context window and later came back — the window moved backwards, which is the one change a prefix cache cannot absorb.\n${returned.join('\n')}\nmsgs: ${messageCounts.join(', ')}\ninj: ${injections.join(', ')}`).toBe(0);

        // 🔴 AND THE WINDOW MUST COME BACK. Immediately after the collapse the floor pins the window to
        // the few messages newer than it. Every turn after adds two more, all newer than the floor, so the
        // window grows again until the budget binds. If this ever stops being true the fix has traded a
        // cache miss for a permanently truncated context, which is the worse bug.
        const atCollapse = messageCounts[TURNS_WITH_INJECTION];
        const atEnd = messageCounts[messageCounts.length - 1];

        expect(atEnd, `The window never recovered after the injection vanished — the floor is pinning it permanently instead of merely refusing to move backwards. msgs: ${messageCounts.join(', ')}.`).toBeGreaterThan(atCollapse + 5);
    });
});
