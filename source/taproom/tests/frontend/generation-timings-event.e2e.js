/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach for
//   `window`, `Response` and `TextEncoder`. Lint sees one file and cannot tell the two contexts apart.

import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/**
 * 🔴 THE HALF THAT NODE CANNOT REACH: DOES THE TIMINGS EVENT ACTUALLY FIRE?
 *
 * llama.cpp reports `prompt_n`, `prompt_ms` and `cache_n` on every completion, and SillyTavern threw all of
 * it away — `generateTextGenWithStreaming` destructured four fields off each SSE chunk and dropped the rest.
 * `cache_n` is the only MEASURED answer to "did the KV cache work"; everything else a client can say about
 * reuse is a prediction. So the fork now keeps it and emits `event_types.GENERATION_TIMINGS`.
 *
 * A server-side assertion cannot prove the browser consumes the event. This spec checks that the client
 * listens for the event and reads `cache_n` from the forwarded timing payload.
 *
 * ⚠️ `fetch` IS STUBBED, AND THAT IS THE POINT RATHER THAN A SHORTCUT. What is under test is the client's
 * handling of a response, so the response is authored here — a real backend would make this spec need a GPU,
 * a loaded model and a working connection profile to assert something none of them affect. The canned bytes
 * below reproduce the event shape expected from the backend.
 */
test.describe.configure({ timeout: 180_000 });

test.describe('GENERATION_TIMINGS — the browser has to actually emit it', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    let base = '';

    test.beforeAll(async () => {
        // ⚠️ 180s IN THE HOOK TOO. `describe.configure` sets the budget for TESTS and does nothing for a
        //    hook, and this one boots a real server — see data-type-markers.e2e.js for the measurement.
        test.setTimeout(180_000);

        const scratch = makeScratchDirectory('generation-timings');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');

        server = await startSillyTavern({ dataRoot, configPath });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }

        base = `http://127.0.0.1:${server.port}`;
        await stepPastFirstRun(dataRoot);
    });

    test.afterAll(async () => {
        await server?.stop?.();
    });

    test('the streaming path scrapes `timings` off the SSE and emits it with the record seq', async ({ page }) => {
        await page.goto(base, { waitUntil: 'domcontentloaded' });

        // The app has to have finished wiring `eventSource` before anything can subscribe to it.
        await page.waitForFunction(() => Boolean(window.SillyTavern?.getContext), null, { timeout: 60_000 });

        const observed = await page.evaluate(async () => {
            const { generateTextGenWithStreaming } = await import('./scripts/textgen-settings.js');
            const { eventSource, event_types } = await import('./script.js');

            // Exactly what the live llama.cpp sent on 2026-08-25, including the field the client used to
            // drop. The middle chunk carries no timings, so a scrape that only looks at the LAST chunk
            // before `[DONE]` and a scrape that takes the last one SEEN are distinguishable here.
            const chunks = [
                'data: {"content":"ack","stop":false}\n\n',
                'data: {"content":"nowledged","stop":false}\n\n',
                'data: {"content":"","stop":true,"timings":{"cache_n":34,"prompt_n":42,"prompt_ms":323.791,"predicted_n":8}}\n\n',
                'data: [DONE]\n\n',
            ];

            const encoder = new TextEncoder();
            const body = new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) {
                        controller.enqueue(encoder.encode(chunk));
                    }
                    controller.close();
                },
            });

            const realFetch = window.fetch;
            window.fetch = async () => new Response(body, {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                    // The correlation handle the four backend endpoints set (`src/prompt-record.js`).
                    'X-ST-Prompt-Seq': '5',
                },
            });

            /** @type {any} */
            let payload = null;
            const listener = (data) => { payload = data; };
            eventSource.on(event_types.GENERATION_TIMINGS, listener);

            try {
                const generator = await generateTextGenWithStreaming(
                    { prompt: 'STREAM PROBE. One word.' },
                    new AbortController().signal,
                    { type: 'normal' },
                );

                let text = '';
                for await (const step of generator()) {
                    text = step.text;
                }

                return { text, payload };
            } finally {
                window.fetch = realFetch;
                eventSource.removeListener(event_types.GENERATION_TIMINGS, listener);
            }
        });

        // The stream still works — a scrape that broke the generator would be a far worse bug than a
        // missing measurement, so it is asserted first.
        expect(observed.text).toBe('acknowledged');

        // 🔴 THE ASSERTION THIS SPEC EXISTS FOR. Node can prove the bytes arrive; only this can prove
        // anything in the browser ever hears about them.
        expect(observed.payload).not.toBeNull();
        expect(observed.payload.raw.cache_n).toBe(34);
        expect(observed.payload.raw.prompt_n).toBe(42);

        // Passed through UNALTERED, not normalised into fork-invented names: a consumer must be able to
        // tell a field the backend omitted from one a normaliser dropped.
        expect(observed.payload.raw.prompt_ms).toBe(323.791);

        // And correlated, so a consumer can line the numbers up with the prompt record they belong to.
        expect(observed.payload.seq).toBe('5');
    });

    test('a backend that reports no timings emits nothing at all', async ({ page }) => {
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(window.SillyTavern?.getContext), null, { timeout: 60_000 });

        const observed = await page.evaluate(async () => {
            const { generateTextGenWithStreaming } = await import('./scripts/textgen-settings.js');
            const { eventSource, event_types } = await import('./script.js');

            const encoder = new TextEncoder();
            const body = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"content":"hi","stop":false}\n\n'));
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                },
            });

            const realFetch = window.fetch;
            window.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

            let fired = 0;
            const listener = () => { fired += 1; };
            eventSource.on(event_types.GENERATION_TIMINGS, listener);

            try {
                const generator = await generateTextGenWithStreaming({ prompt: 'x' }, new AbortController().signal, { type: 'normal' });
                let text = '';
                for await (const step of generator()) {
                    text = step.text;
                }
                return { text, fired };
            } finally {
                window.fetch = realFetch;
                eventSource.removeListener(event_types.GENERATION_TIMINGS, listener);
            }
        });

        expect(observed.text).toBe('hi');

        // ⚠️ NOT EVERY BACKEND REPORTS, AND NOT EVERY BUILD OF THE ONES THAT DO. An event carrying `null`
        // would be worse than silence: a subscriber would have to distinguish "measured nothing" from "not
        // measured", and the whole value of these numbers is that they are measured rather than guessed.
        expect(observed.fired).toBe(0);
    });
});
