/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory } from '../util/st-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/*
 * 🔴 WHY A PURE-CSS RENDER SPEC AND NOT A SERVER BOOT.
 *
 * What is under test is glyph geometry: `.mes_buttons` is `justify-content: flex-end` around a
 * content-sized box, so ANY button whose icon class is swapped at runtime re-flows every icon to its
 * left. That is a layout fact of the shipped stylesheet plus the shipped webfont — booting ST adds
 * nothing to it, and the states we need (a narration mid-generation) can't be reached headlessly
 * without a TTS server anyway. So we load the real style.css and the real fa-solid webfont into a
 * blank page and measure.
 *
 * Reproduced by hand first (Vocalis narrate button, 2026-07-24): idle `fa-volume-high` 26px,
 * generating `fa-spinner` 22px, playing `fa-stop` 18px — the row jumped twice per narration.
 */
const CSS = [
    'public/css/fontawesome.min.css',
    'public/css/solid.min.css',
    'public/style.css',
    // `.mes_translate` / `.mes_narrate` ship as `display: none` and are switched back on by a body
    // class (`body.translate`, `body.tts`) — without this file and those classes on <body> they
    // measure 0 wide and every width assertion below passes for the wrong reason.
    'public/css/toggle-dependent.css',
].map(rel => pathToFileURL(path.join(repoRoot, rel)).href);

/**
 * The Vocalis TTS extension is a THIRD-PARTY extension: it is gitignored here
 * (`public/scripts/extensions/third-party/`) and its source of truth is its own repository. So look
 * for it, and skip rather than fail when this checkout has no copy to measure.
 * @returns {string|null} directory holding the extension's style.css, or null
 */
function findVocalisExtension() {
    const candidates = [
        process.env.VOCALIS_EXTENSION_DIR,
        path.join(repoRoot, 'public/scripts/extensions/third-party/Vocalis'),
        path.join(repoRoot, '..', 'Vocalis', 'sillytavern', 'extension'),
    ].filter(Boolean);
    return candidates.find(dir => fs.existsSync(path.join(dir, 'style.css'))) ?? null;
}

/** Build a page carrying a realistic message button row and hand back its file:// URL. */
function makePage(extraCss) {
    const scratch = makeScratchDirectory('mes-buttons-icon-reflow');
    const links = [...CSS, ...extraCss].map(href => `<link rel="stylesheet" href="${href}">`).join('\n');
    const file = path.join(scratch, 'row.html');
    fs.writeFileSync(file, `<!DOCTYPE html>
<meta charset="utf-8">
${links}
<body class="tts translate">
<div class="ch_name flex-container justifySpaceBetween" style="width: 400px">
    <div class="flex-container flex1 alignitemscenter"><span class="name_text">Test</span></div>
    <div class="mes_buttons">
        <div class="extraMesButtons" style="display: flex">
            <div id="swapped" class="mes_button vocalis_narrate fa-solid fa-volume-high"></div>
            <div id="translate" class="mes_button mes_translate fa-solid fa-language"></div>
            <div id="narrate" class="mes_button mes_narrate fa-solid fa-bullhorn"></div>
            <div id="copy" class="mes_button mes_copy fa-solid fa-copy"></div>
        </div>
        <div id="edit" class="mes_button mes_edit fa-solid fa-pencil"></div>
    </div>
</div>
</body>`, 'utf-8');
    return pathToFileURL(file).href;
}

/**
 * Widths of one element across a list of icon classes, measured after the webfont has loaded.
 *
 * ⚠️ A 0 here is not a measurement, it is a broken fixture — a hidden button reports 0 for every
 * state, which silently satisfies both "all states equal" and "nothing moved". Caught in the first
 * run of this spec: `.mes_translate` is `display: none` until `body.translate` is set.
 */
async function widthsAcrossStates(page, selector, states) {
    const widths = await page.evaluate(async ({ selector, states }) => {
        await document.fonts.ready;
        const el = document.querySelector(selector);
        const base = [...el.classList].filter(c => !c.startsWith('fa-') || c === 'fa-solid');
        const out = {};
        for (const state of states) {
            el.className = [...base, ...state.split(' ')].join(' ');
            out[state] = Number(el.getBoundingClientRect().width.toFixed(2));
        }
        return out;
    }, { selector, states });

    expect(Math.min(...Object.values(widths)), `${selector} measured 0 wide — fixture is hiding it`)
        .toBeGreaterThan(0);
    return widths;
}

/** Left edge of every button in the row, keyed by id — what a re-flow moves. */
async function rowLayout(page, swappedTo) {
    const layout = await page.evaluate(async (swappedTo) => {
        await document.fonts.ready;
        const swapped = document.getElementById('swapped');
        const base = [...swapped.classList].filter(c => !c.startsWith('fa-') || c === 'fa-solid');
        swapped.className = [...base, ...swappedTo.split(' ')].join(' ');
        const out = {};
        for (const el of document.querySelectorAll('.mes_buttons [id]')) {
            out[el.id] = Number(el.getBoundingClientRect().x.toFixed(2));
        }
        const row = document.querySelector('.mes_buttons').getBoundingClientRect();
        out['#row'] = Number(row.x.toFixed(2));
        out['#rowWidth'] = Number(row.width.toFixed(2));
        return out;
    }, swappedTo);

    // Same trap as widthsAcrossStates: a collapsed row makes "nothing moved" vacuously true.
    expect(layout['#rowWidth'], 'the button row measured 0 wide — fixture is hiding it').toBeGreaterThan(0);
    return layout;
}

// The three states Vocalis puts on its narrate button (sillytavern/extension/index.js, setBtnState).
const VOCALIS_STATES = ['fa-volume-high', 'fa-spinner fa-spin', 'fa-stop'];

test.describe('message button row geometry', () => {
    test('the shipped glyphs really do differ in width (the hazard this guards)', async ({ page }) => {
        await page.goto(makePage([]));
        const widths = await widthsAcrossStates(page, '#translate', VOCALIS_STATES);

        // No fixed-width rule on `.mes_translate`, so this is the raw Font Awesome advance. If these
        // three ever come out equal the rest of the suite is proving nothing — fail loudly instead.
        const distinct = new Set(Object.values(widths));
        expect(distinct.size, `expected three different widths, got ${JSON.stringify(widths)}`).toBe(3);
    });

    test('the core narrate button does not re-flow the row (bullhorn <-> spinner)', async ({ page }) => {
        await page.goto(makePage([]));
        const widths = await widthsAcrossStates(page, '#narrate', ['fa-bullhorn', 'fa-spinner fa-spin']);
        // Core swaps between two glyphs that happen to share an advance. Nothing enforces that, so
        // this is the canary: if a future Font Awesome bump breaks the coincidence, the fork's own
        // narrate button starts jumping and this tells us before a user does.
        expect(widths['fa-bullhorn']).toBe(widths['fa-spinner fa-spin']);
    });

    test('the Vocalis narrate button holds one width across all three states', async ({ page }) => {
        const dir = findVocalisExtension();
        // Conditional, not a parked test: the file under test belongs to another repository and is
        // gitignored here (see findVocalisExtension).
        // eslint-disable-next-line playwright/no-skipped-test
        test.skip(!dir,'Vocalis extension not present in this checkout (set VOCALIS_EXTENSION_DIR)');

        await page.goto(makePage([pathToFileURL(path.join(dir, 'style.css')).href]));
        const widths = await widthsAcrossStates(page, '#swapped', VOCALIS_STATES);
        const distinct = new Set(Object.values(widths));
        expect(distinct.size, `states must share one width, got ${JSON.stringify(widths)}`).toBe(1);

        // …and the widest glyph must still fit inside that width, or the fix trades a jump for a clip.
        const fits = await page.evaluate(async () => {
            await document.fonts.ready;
            const el = document.getElementById('swapped');
            return el.scrollWidth <= el.clientWidth;
        });
        expect(fits, 'fa-volume-high is clipped by the fixed width').toBe(true);
    });

    test('nothing in the row moves when the Vocalis button changes state', async ({ page }) => {
        const dir = findVocalisExtension();
        // Conditional, not a parked test: the file under test belongs to another repository and is
        // gitignored here (see findVocalisExtension).
        // eslint-disable-next-line playwright/no-skipped-test
        test.skip(!dir,'Vocalis extension not present in this checkout (set VOCALIS_EXTENSION_DIR)');

        await page.goto(makePage([pathToFileURL(path.join(dir, 'style.css')).href]));
        const idle = await rowLayout(page, 'fa-volume-high');
        const generating = await rowLayout(page, 'fa-spinner fa-spin');
        const playing = await rowLayout(page, 'fa-stop');

        expect(generating).toEqual(idle);
        expect(playing).toEqual(idle);
    });
});
