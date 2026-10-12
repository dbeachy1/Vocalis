/* eslint-env browser */
// ^ Callbacks handed to page.evaluate()/waitForFunction() run in the PAGE, not in Node, so they legitimately
//   reach for `document`/`globalThis`. Lint sees one file and cannot tell the two contexts apart.

import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

// 🔴 THE ONLY THING THAT CAN SEE THE NARRATION PLAYER BAR.
//
// The bar is built entirely in the browser, in the TTS extension's init. There is no server half to assert.
// Two questions this suite answers that nothing else can:
//   1. Does the TTS module still LOAD? A bad import (e.g. the AudioPlayer one this feature added) breaks the
//      whole module, so init never runs — which silently kills the narrate megaphone spinner too, not just
//      the bar. A page-error probe catches that class of regression.
//   2. Is #tts_player_bar actually in the DOM after load? Its presence is proof init reached the end.
// A cold ST boot on a loaded dev box runs well past Playwright's 30s default.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('TTS narration player bar (front-end)', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('tts-player-bar-e2e');
        server = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });
        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;

        // 🔴 STEP PAST ONBOARDING, OR NOTHING BELOW RUNS. A fresh data root is a FIRST RUN; getSettings() ends
        // in doOnboarding(), which waits for a human form. Headless never fills it, so firstLoadInit blocks and
        // no extension init — including the bar — ever happens. Same clearing the panels e2e does.
        await stepPastFirstRun(path.join(scratch, 'data'));
    });

    test.afterAll(async () => {
        if (server) await server.stop();
    });

    test('the TTS module loads clean and the player bar reaches the DOM', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
        page.on('console', msg => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });

        // Base app is up once the send form is attached; extensions init around here.
        await expect(page.locator('#send_form')).toBeAttached({ timeout: 30_000 });

        // The bar's presence proves the TTS module loaded AND init ran to the end. Its ABSENCE, paired with an
        // import/parse error below, is the "no spinner, no bar" regression.
        await expect(
            page.locator('#tts_player_bar'),
            `#tts_player_bar never attached. Captured page errors:\n${errors.join('\n') || '(none)'}`,
        ).toBeAttached({ timeout: 20_000 });

        expect(errors.filter(e => /tts|audio-player|AudioPlayer/i.test(e)), errors.join('\n')).toEqual([]);
    });

    test('the bar is hidden at rest and shows when a clip plays on the shared element', async ({ page }) => {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        const bar = page.locator('#tts_player_bar');
        await expect(bar).toBeAttached({ timeout: 30_000 });

        // At rest it exists but is not shown.
        await expect(bar).toBeHidden();

        // Play a pre-rendered clip on the shared narration element (#tts_audio) — the
        // exact 'playing' event the bar keys off when playAudioData plays a real job. No TTS provider needed; we
        // synthesize a valid silent WAV in-page so it decodes and fires 'playing' reliably. Long enough that it
        // does not end (and self-hide) before the assertion runs.
        await page.evaluate(async () => {
            const el = /** @type {HTMLAudioElement} */ (document.getElementById('tts_audio'));
            const sampleRate = 8000, seconds = 30;
            const n = sampleRate * seconds;
            const buf = new ArrayBuffer(44 + n * 2);
            const dv = new DataView(buf);
            const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
            wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
            dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
            dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
            dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); wr(36, 'data'); dv.setUint32(40, n * 2, true);
            const blob = new Blob([buf], { type: 'audio/wav' });
            el.muted = true; // muted autoplay is always permitted headless
            el.src = URL.createObjectURL(blob);
            await el.play().catch(() => {});
        });

        // THE CLAIM: the player actually appears on screen when a clip plays.
        await expect(bar).toBeVisible({ timeout: 10_000 });
    });

    test('the controls work: the seek bar moves playback and pause holds without retiring the bar', async ({ page }) => {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        const bar = page.locator('#tts_player_bar');
        await expect(bar).toBeAttached({ timeout: 30_000 });

        await page.evaluate(async () => {
            const el = /** @type {HTMLAudioElement} */ (document.getElementById('tts_audio'));
            const sampleRate = 8000, seconds = 30;
            const n = sampleRate * seconds;
            const buf = new ArrayBuffer(44 + n * 2);
            const dv = new DataView(buf);
            const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
            wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
            dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
            dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
            dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); wr(36, 'data'); dv.setUint32(40, n * 2, true);
            el.muted = true;
            el.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
            await el.play().catch(() => {});
        });
        await expect(bar).toBeVisible({ timeout: 10_000 });

        // Seek: click the progress track at its midpoint → the shared element jumps to ~half of 30s.
        const progress = bar.locator('.audio-player-progress');
        await expect(progress).toBeVisible();
        const box = await progress.boundingBox();
        await progress.click({ position: { x: Math.round(box.width * 0.5), y: 3 } });
        const seeked = await page.evaluate(() => document.getElementById('tts_audio').currentTime);
        expect(seeked).toBeGreaterThan(10);
        expect(seeked).toBeLessThan(20);

        // Pause: the toggle pauses the shared element and flips the icon to play — and the bar STAYS (a pause is
        // not a stop). This behavior keeps the player available while playback is paused.
        await bar.locator('.audio-player-play-pause').click();
        expect(await page.evaluate(() => document.getElementById('tts_audio').paused)).toBe(true);
        await expect(bar.locator('.audio-player-play-pause')).toHaveClass(/fa-play/);
        await expect(bar).toBeVisible();
    });
});
