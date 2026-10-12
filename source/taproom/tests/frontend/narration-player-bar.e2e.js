/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach
//   for `document`/`window`/`Audio`. Lint sees one file and cannot tell the two contexts apart.

import path from 'node:path';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

// The shared narration bar (public/scripts/narration-player-bar.js) is what Vocalis and the
// built-in TTS both point at. This drives it the exact way an engine does — hand it a fresh audio
// element that is playing — and proves it appears, labels the speaker, seeks, pauses (without
// retiring), and that its stop button runs the engine's stop handler and hides the bar.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('shared narration player bar (front-end)', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('narration-bar-e2e');
        server = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });
        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;

        // Step past first-run onboarding, or firstLoadInit blocks and the page never finishes.
        await stepPastFirstRun(path.join(scratch, 'data'));
    });

    test.afterAll(async () => {
        if (server) await server.stop();
    });

    test('imports clean, shows on a clip, and seek / pause / stop all work', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
        page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#send_form')).toBeAttached({ timeout: 30_000 });

        // Drive the shared module the way Vocalis will: import it, hand it a fresh Audio() playing a
        // clip. A 30s silent-but-valid WAV so it decodes, has a known duration, and does not end mid-test.
        const ok = await page.evaluate(async () => {
            const mod = await import('/scripts/narration-player-bar.js');
            const sampleRate = 8000, seconds = 30, n = sampleRate * seconds;
            const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
            const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
            wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
            dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
            dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
            dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); wr(36, 'data'); dv.setUint32(40, n * 2, true);
            const el = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
            el.muted = true;
            window.__narrEl = el;
            window.__stopped = false;
            await el.play().catch(() => {});
            mod.showNarrationPlayerBar(el, { speaker: 'Elara', onStop: () => { window.__stopped = true; el.pause(); } });
            return true;
        });
        expect(ok).toBe(true);
        expect(errors.filter(e => /narration|audio-player/i.test(e)), errors.join('\n')).toEqual([]);

        const bar = page.locator('#narration_player_bar');
        await expect(bar).toBeVisible({ timeout: 10_000 });
        await expect(bar.locator('.narration-player-speaker')).toHaveText('Elara');

        // Seek: click the track midpoint → the bound element jumps to ~half of 30s.
        const progress = bar.locator('.audio-player-progress');
        await expect(progress).toBeVisible();
        const box = await progress.boundingBox();
        await progress.click({ position: { x: Math.round(box.width * 0.5), y: 3 } });
        const seeked = await page.evaluate(() => window.__narrEl.currentTime);
        expect(seeked).toBeGreaterThan(10);
        expect(seeked).toBeLessThan(20);

        // Pause: toggle pauses the element and flips the icon, and the bar STAYS (pause is not stop).
        await bar.locator('.audio-player-play-pause').click();
        expect(await page.evaluate(() => window.__narrEl.paused)).toBe(true);
        await expect(bar.locator('.audio-player-play-pause')).toHaveClass(/fa-play/);
        await expect(bar).toBeVisible();

        // Stop: runs the engine's own stop handler (Vocalis cancels the render there) and retires the bar.
        await bar.locator('.narration-player-stop').click();
        expect(await page.evaluate(() => window.__stopped)).toBe(true);
        await expect(bar).toBeHidden();
    });
});
