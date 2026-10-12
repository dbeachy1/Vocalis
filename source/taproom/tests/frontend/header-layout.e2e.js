/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory } from '../util/st-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const publicDir = path.join(repoRoot, 'public');

/*
 * 🔴 WHAT THIS GUARDS: THE HEADER ROW SURVIVING A THEME.
 *
 * `#top-settings-holder` is a flex row of drawer buttons that themes restyle constantly, and the fork adds
 * two things to it that upstream never had — the home button and the storage marker. Both were written
 * against the geometry of ONE stylesheet, and both broke the moment a real theme was installed:
 *
 *   - `#homeButton` hard-coded `width: 100%`. Identical to a `.drawer` under core, where every drawer is
 *     also `width: 100%` — but an ID beats a class, so under a theme that makes drawers content-sized the
 *     house alone kept demanding the whole bar and swallowed all the slack in it.
 *   - `#storageMarker` was `position: fixed; right: 10px`, which cleared the buttons only because core's
 *     header is 50vw and leaves empty margin. A theme that widens the header spends that margin, and the
 *     buttons land underneath the marker.
 *
 * Both are pure layout facts of the shipped stylesheet, so this measures the shipped stylesheet: the real
 * `index.html` markup with its real CSS, in a browser, with the scripts stripped. Booting a server would add
 * nothing — no server state moves these boxes.
 *
 * ⚠️ THE THEME IS SIMULATED, ON PURPOSE. `MOONLIT` below is the two declarations from Moonlit Echoes that
 * caused the report, not the whole 100KB theme, because a third-party theme is gitignored here and its
 * source of truth is its own repository — a spec that needs it installed is a spec that silently skips. The
 * real file is measured too when a checkout happens to have it (see the last test).
 */

/** The Moonlit Echoes declarations that reshape the header — a full-width holder and content-sized slots. */
const MOONLIT = `
    #top-settings-holder { width: auto; }
    .drawer { width: auto; padding: 0 0.8%; height: var(--topBarBlockSize); }
`;

/** The pre-fix rules, kept as the canary: with these back, the assertions below must fail. */
const REGRESSED = `
    #homeButton { width: 100%; }
    #storageMarker { position: fixed; right: 10px; top: 0; z-index: 3006; }
`;

/**
 * Where this checkout keeps the Moonlit Echoes stylesheet, if it has one at all.
 * @returns {string|null} path to the theme's style.css, or null
 */
function findMoonlitTheme() {
    const candidates = [
        process.env.MOONLIT_THEME_CSS,
        path.join(publicDir, 'scripts/extensions/third-party/SillyTavern-MoonlitEchoesTheme/style.css'),
    ].filter(Boolean);
    return candidates.find(file => fs.existsSync(file)) ?? null;
}

/**
 * The real `index.html`, made loadable from `file://`.
 *
 * Two edits and no more: `<base href="/">` becomes this checkout's `public/`, or every relative stylesheet
 * resolves to the filesystem root and the page renders unstyled — which would pass every assertion here for
 * the worst possible reason. And `<script>` blocks come out, because the markup is what is under test and a
 * half-initialised app measuring its own header is noise, not signal.
 * @returns {string} file:// URL of the scratch copy
 */
function makeHeaderPage() {
    const scratch = makeScratchDirectory('header-layout');
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8')
        .replace('<base href="/">', `<base href="${pathToFileURL(publicDir).href}/">`)
        .replace(/<script\b[\s\S]*?<\/script>/g, '');

    const file = path.join(scratch, 'index.html');
    fs.writeFileSync(file, html, 'utf-8');
    return pathToFileURL(file).href;
}

/**
 * Load the header, reveal the storage marker the way `storage-indicator.js` does, and optionally layer a
 * theme over the top.
 * @param {import('@playwright/test').Page} page The page
 * @param {string} [themeCss] Extra CSS applied after every core stylesheet, as a theme would be
 * @param {{width: number, height: number}} [viewport] Screen to measure at; desktop by default
 * @returns {Promise<void>}
 */
async function openHeader(page, themeCss, viewport = { width: 1600, height: 900 }) {
    await page.setViewportSize(viewport);
    await page.goto(makeHeaderPage(), { waitUntil: 'domcontentloaded' });

    if (themeCss) {
        await page.addStyleTag({ content: themeCss });
    }

    await page.evaluate(async () => {
        await document.fonts.ready;
        // What storage-indicator.js does when a provider answers: fill in the provider's word and clear the
        // inline `display: none`. An empty marker measures ~0 wide and would clear every button by default.
        document.getElementById('storageMarkerText').textContent = 'Encrypted';
        document.getElementById('storageMarker').style.display = '';
    });

    await settle(page);
}

/**
 * Wait for the header to stop moving.
 *
 * 🔴 WITHOUT THIS THE THEME TESTS PASS WITHOUT TESTING ANYTHING, AND THEY DID. Moonlit Echoes puts
 * `transition: all 0.8s ease` on `#top-settings-holder`, so the header it widens to the viewport is still
 * 50vw the instant its stylesheet lands — the exact geometry the theme is being loaded to get AWAY from.
 * Measured there, "nothing overlaps the marker" is a statement about core CSS wearing a theme's name.
 * Caught by a computed width of 800px on a rule that plainly said `auto`.
 * @param {import('@playwright/test').Page} page The page
 * @returns {Promise<void>}
 */
async function settle(page) {
    // Two consecutive matching samples, not one: an ease curve barely moves in its first frames, so a single
    // repeat can be read at the very start of the animation as easily as at the end of it.
    await expect.poll(async () => await page.evaluate(() => {
        const width = document.getElementById('top-settings-holder').getBoundingClientRect().width;
        const samples = [...(window.__headerWidths ?? []), width].slice(-3);
        window.__headerWidths = samples;
        return samples.length === 3 && new Set(samples).size === 1;
    }), { timeout: 5000, intervals: [100] }).toBe(true);
}

/**
 * Geometry of every direct child of the header row, plus the row itself.
 * @param {import('@playwright/test').Page} page The page
 * @returns {Promise<{holder: {left: number, right: number, width: number}, items: Array<{name: string, left: number, right: number, width: number}>}>}
 */
async function headerGeometry(page) {
    const geometry = await page.evaluate(() => {
        const holder = document.getElementById('top-settings-holder');
        const box = el => {
            const r = el.getBoundingClientRect();
            return { left: Number(r.left.toFixed(2)), right: Number(r.right.toFixed(2)), width: Number(r.width.toFixed(2)) };
        };

        return {
            holder: box(holder),
            items: [...holder.children].map(el => ({ name: el.id || el.className, ...box(el) })),
        };
    });

    // A collapsed header satisfies "nothing overlaps" vacuously, and a stylesheet that failed to load is
    // exactly how that happens. Same trap the message-button spec documents.
    expect(geometry.holder.width, 'the header measured 0 wide — the page is unstyled, not passing').toBeGreaterThan(200);
    return geometry;
}

/**
 * Every header item whose box intersects the storage marker's.
 * @param {{items: Array<{name: string, left: number, right: number}>}} geometry From {@link headerGeometry}
 * @returns {Array<string>} names of the overlapping items
 */
function itemsUnderTheMarker(geometry) {
    const marker = geometry.items.find(item => item.name === 'storageMarker');
    expect(marker, 'the storage marker is not a child of #top-settings-holder any more').toBeTruthy();
    expect(marker.width, 'the storage marker measured 0 wide').toBeGreaterThan(0);

    // Half a pixel of tolerance: sub-pixel flex distribution can leave adjacent boxes sharing an edge.
    return geometry.items
        .filter(item => item.name !== 'storageMarker')
        .filter(item => item.right > marker.left + 0.5 && marker.right > item.left + 0.5)
        .map(item => item.name);
}

/** Widths of the home button and of the drawers around it. */
function slotWidths(geometry) {
    const home = geometry.items.find(item => item.name === 'homeButton');
    expect(home, '#homeButton is not a child of #top-settings-holder any more').toBeTruthy();

    const drawers = geometry.items.filter(item => item.name !== 'homeButton' && item.name !== 'storageMarker');
    expect(drawers.length, 'no drawer buttons found in the header').toBeGreaterThan(3);
    return { home: home.width, drawers: drawers.map(d => d.width) };
}

test.describe('header row layout', () => {
    test('the storage marker has the row to itself under core CSS', async ({ page }) => {
        await openHeader(page);
        expect(itemsUnderTheMarker(await headerGeometry(page))).toEqual([]);
    });

    test('the storage marker is in flow, which is what reserves it the space', async ({ page }) => {
        await openHeader(page);
        const position = await page.evaluate(() => getComputedStyle(document.getElementById('storageMarker')).position);

        // `fixed`/`absolute` is the failure mode this spec exists for: an out-of-flow marker can only dodge
        // the buttons, and a theme is free to move them back underneath it.
        expect(position, 'an out-of-flow marker takes no space, so nothing stops a theme covering it').toBe('static');
    });

    test('the home button takes an ordinary slot, not the whole bar', async ({ page }) => {
        await openHeader(page);
        const { home, drawers } = slotWidths(await headerGeometry(page));

        // Under core every `.drawer` is `width: 100%` and they divide the bar evenly, so an equal share is
        // both the intended look and proof the button is being sized by `.drawer` rather than by itself.
        for (const drawer of drawers) {
            expect(Math.abs(home - drawer), `home button ${home}px vs drawer ${drawer}px`).toBeLessThan(1);
        }
    });

    test('a phone-width screen, where core itself widens the bar to the viewport', async ({ page }) => {
        // `mobile-styles.css` gives `#top-settings-holder` the full `100dvw` below 1000px, so the margin the
        // old marker retreated into does not exist on a phone either — it was sitting on the last button on
        // every handset, with no theme involved. The wording is dropped at this width; the padlock is not.
        await openHeader(page, undefined, { width: 500, height: 900 });
        const geometry = await headerGeometry(page);

        expect(itemsUnderTheMarker(geometry)).toEqual([]);
        expect(geometry.items.at(-1).right).toBeLessThanOrEqual(geometry.holder.right + 0.5);
    });

    test('a theme that reshapes the header keeps both — Moonlit Echoes geometry', async ({ page }) => {
        await openHeader(page, MOONLIT);
        const geometry = await headerGeometry(page);

        expect(itemsUnderTheMarker(geometry)).toEqual([]);

        // The house must not swallow the slack in a header the theme just widened to the viewport.
        const { home } = slotWidths(geometry);
        expect(home, 'the home button is absorbing the bar').toBeLessThan(geometry.holder.width / 4);
    });

    test('the hazard is real: the pre-fix rules put buttons under the marker', async ({ page }) => {
        await openHeader(page, `${MOONLIT}\n${REGRESSED}`);
        const geometry = await headerGeometry(page);

        // If this ever comes back empty the rest of the file is proving nothing — either the theme stopped
        // reshaping the header or the fixture stopped rendering it.
        expect(itemsUnderTheMarker(geometry).length,
            'the old rules no longer collide, so these tests are guarding nothing').toBeGreaterThan(0);
    });

    test('the real Moonlit Echoes stylesheet, when this checkout has it', async ({ page }) => {
        const themePath = findMoonlitTheme();
        // `public/scripts/extensions/third-party/` is gitignored: the theme belongs to its own repository
        // and most checkouts have no copy. Conditional, not a parked test.
        // eslint-disable-next-line playwright/no-skipped-test
        test.skip(!themePath, 'Moonlit Echoes not installed in this checkout (set MOONLIT_THEME_CSS)');

        await openHeader(page, fs.readFileSync(themePath, 'utf-8'));
        const geometry = await headerGeometry(page);

        expect(itemsUnderTheMarker(geometry)).toEqual([]);
        expect(slotWidths(geometry).home).toBeLessThan(geometry.holder.width / 4);
    });
});
