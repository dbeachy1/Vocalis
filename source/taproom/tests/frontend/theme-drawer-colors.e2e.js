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
 * 🔴 WHAT THIS GUARDS. Taproom 0.5 extends the four button colors to collapsible section headers, so that
 * "blue means you can click it" is true of every control and not just of buttons. The whole feature is
 * CSS, and every way it can fail is a cascade fact that no unit test can see:
 *
 *   - The dressed-up headers (`.standoutHeader`, the extension settings panels) are painted with a
 *     `linear-gradient`, which is a background IMAGE. An image paints over the color beneath it, so
 *     setting only `background-color` leaves the bar black while `--SmartThemeButtonBgColor` reads back
 *     exactly right. `background-image: none` is what makes the color visible, and nothing else in the
 *     codebase would notice if it were dropped.
 *   - `#extensions_settings .inline-drawer-toggle.inline-drawer-header` is an id-level selector. A rule
 *     written at two classes loses to it and does nothing -- silently, and only inside the extensions
 *     panel, which is the half of the UI most likely to be looked at last.
 *   - The rule deliberately does NOT match a bare `.inline-drawer-header`. That is the load-bearing half
 *     of the affordance: a World Info entry row and a static `.standoutHeader` heading are not click
 *     targets, and colouring them would make blue mean nothing again. A future simplification of the
 *     selector to `.inline-drawer-header` would look tidier and would break the feature's premise, so
 *     both negatives are asserted here.
 *
 * So: load the REAL `style.css` and the REAL `buttons.css` in the order `index.html` links them, build
 * the header shapes the app actually ships, and measure what the browser resolves.
 */

/** The stylesheets `index.html` links, in the order it links them. Order is the thing under test. */
const CSS = [
    'public/css/fontawesome.min.css',
    'public/css/solid.min.css',
    'public/style.css',
    'public/css/world-info.css',
    'public/css/st-tailwind.css',
    'public/css/buttons.css',
].map(rel => pathToFileURL(path.join(repoRoot, rel)).href);

/** The button colors, which 0.5 reuses rather than adding its own. */
const BG = 'rgba(90, 120, 170, 0.35)';
const BORDER = 'rgba(140, 175, 225, 0.6)';
const HOVER_BG = 'rgba(110, 150, 210, 0.6)';

/**
 * The header shapes the app ships, cut down to what decides their paint.
 *
 * `#bare` and `#standout` are the two clickable kinds -- one undressed, one carrying the gradient.
 * `#extension` is the same thing inside the id-level selector. `#heading` and `#wiRow` are the two
 * non-clickable shapes that must stay out of it.
 */
function makePage() {
    const scratch = makeScratchDirectory('theme-drawer-colors');
    const links = CSS.map(href => `<link rel="stylesheet" href="${href}">`).join('\n');
    const file = path.join(scratch, 'drawers.html');
    fs.writeFileSync(file, `<!DOCTYPE html>
<meta charset="utf-8">
${links}
<style>
/* Headers carry \`transition: all\`, so a freshly written color is mid-animation and \`getComputedStyle\`
   reports the interpolated value -- which, a millisecond after the write, is the OLD one. Same trap the
   button spec documents; what is under test is which color a header resolves to, not how it gets there. */
* { transition: none !important; }
</style>
<body>
<div class="inline-drawer">
    <div id="bare" class="inline-drawer-toggle inline-drawer-header">
        <b>Click to expand</b>
        <div id="bareIcon" class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
    </div>
</div>
<div class="inline-drawer">
    <div id="standout" class="standoutHeader inline-drawer-toggle inline-drawer-header">
        <b>Click to expand</b>
        <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
    </div>
</div>
<div class="inline-drawer">
    <div id="noPadding" class="inline-drawer-toggle inline-drawer-header padding0">
        <b>A header that lays out its own row</b>
    </div>
</div>
<div id="extensions_settings">
    <div class="inline-drawer">
        <div id="extension" class="inline-drawer-toggle inline-drawer-header">
            <b>Some extension</b>
        </div>
    </div>
</div>
<h4 id="heading" class="standoutHeader">A section title, not a control</h4>
<div class="world_entry">
    <form class="world_entry_form">
        <div class="inline-drawer">
            <div id="wiRow" class="inline-drawer-header gap5px padding0">
                <span class="drag-handle">&#9776;</span>
                <div id="wiIcon" class="inline-drawer-toggle fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
            </div>
        </div>
    </form>
</div>
</body>`, 'utf-8');
    return pathToFileURL(file).href;
}

/** Rendered color properties of one element, as the browser resolves them. */
function paintOf(page, selector) {
    return page.evaluate((selector) => {
        const style = getComputedStyle(document.querySelector(selector));
        return {
            background: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            border: style.borderTopColor,
            color: style.color,
            filter: style.filter,
            paddingLeft: style.paddingLeft,
        };
    }, selector);
}

/** Apply theme colors the way `applyThemeColor` does — inline custom properties on `<html>`. */
function setThemeColors(page, colors) {
    return page.evaluate((colors) => {
        for (const [property, value] of Object.entries(colors)) {
            document.documentElement.style.setProperty(property, value);
        }
    }, colors);
}

test.describe('collapsible headers take the button colors (Taproom 0.5)', () => {
    test('a header you can click is filled and bordered, not bold text on the panel', async ({ page }) => {
        await page.goto(makePage());
        const paint = await paintOf(page, '#bare');

        expect(paint.background).toBe(BG);
        expect(paint.border).toBe(BORDER);

        // The panel color. Upstream gives this header no fill at all, so it renders as the panel behind
        // it; if the fill ever equals this again the feature has regressed to the thing it was written
        // for -- a control that is indistinguishable from a line of text.
        const panel = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBlurTintColor').trim());
        expect(paint.background).not.toBe(panel);
    });

    test('the gradient is cleared, so the color underneath it can be seen', async ({ page }) => {
        await page.goto(makePage());

        // 🔴 THE TRAP. `.standoutHeader` paints `linear-gradient(348deg, …)`, a background IMAGE, over
        // whatever color is set. Drop `background-image: none` and this bar stays black while every
        // variable reads back correctly -- the failure mode where the feature looks plumbed and the one
        // header the user actually complained about is the one that did not change.
        const paint = await paintOf(page, '#standout');
        expect(paint.backgroundImage).toBe('none');
        expect(paint.background).toBe(BG);
    });

    test('the extensions panel is reached too, past its id-level selector', async ({ page }) => {
        await page.goto(makePage());

        // `#extensions_settings .inline-drawer-toggle.inline-drawer-header` outranks any two-class rule.
        // Written without the id, this assertion is the only thing that fails.
        const paint = await paintOf(page, '#extension');
        expect(paint.backgroundImage).toBe('none');
        expect(paint.background).toBe(BG);
    });

    test('a static heading keeps the gradient, which is what makes the blue mean anything', async ({ page }) => {
        await page.goto(makePage());
        const paint = await paintOf(page, '#heading');

        // `.standoutHeader` on an `<h4>` is a section title with nothing to click. If a future tidy-up
        // widens the selector to a bare `.inline-drawer-header` or to `.standoutHeader`, this catches it.
        expect(paint.backgroundImage).toContain('linear-gradient');
        expect(paint.background).not.toBe(BG);
    });

    test('a World Info entry row is not painted, but its chevron is', async ({ page }) => {
        await page.goto(makePage());

        // The row is `.inline-drawer-header` WITHOUT the toggle class, and `world-info.css` sets
        // `cursor: initial` on it because the row is not the click target. Filling it would claim that a
        // row holding a drag handle and a kill switch opens the entry.
        expect((await paintOf(page, '#wiRow')).background).not.toBe(BG);

        // The chevron inside it IS the click target, and it is the whole affordance there.
        expect((await paintOf(page, '#wiIcon')).color).toBe(BORDER);
    });

    test('the chevron is colored and its dimming filter is cleared', async ({ page }) => {
        await page.goto(makePage());
        const paint = await paintOf(page, '#bareIcon');

        // Upstream ships `filter: brightness(75%)` on the one glyph whose entire job is to say "this
        // opens", which dims it below the label beside it.
        expect(paint.color).toBe(BORDER);
        expect(paint.filter).toBe('none');
    });

    test('hovering takes the hover fill instead of a brightness blowout', async ({ page }) => {
        await page.goto(makePage());
        await page.hover('#bare');

        const paint = await paintOf(page, '#bare');
        expect(paint.background).toBe(HOVER_BG);
        // `style.css` hovers these with `filter: brightness(150%)`. Left in place it stacks on the hover
        // fill and washes the chosen color out; the color is the hover state now.
        expect(paint.filter).toBe('none');
    });

    test('the pickers repaint headers, because they are the same four variables', async ({ page }) => {
        await page.goto(makePage());
        await setThemeColors(page, {
            '--SmartThemeButtonBgColor': 'rgb(10, 20, 30)',
            '--SmartThemeButtonBorderColor': 'rgb(40, 50, 60)',
            '--SmartThemeButtonTextColor': 'rgb(70, 80, 90)',
        });

        // 0.5 adds no variable and no picker of its own. Theme Colors already round-trips these four
        // through `settings.json` (0.4), so headers inherit that plumbing whole -- which is the argument
        // for reusing them rather than adding a fifth.
        for (const selector of ['#bare', '#standout', '#extension']) {
            const paint = await paintOf(page, selector);
            expect(paint.background, selector).toBe('rgb(10, 20, 30)');
            expect(paint.border, selector).toBe('rgb(40, 50, 60)');
            expect(paint.color, selector).toBe('rgb(70, 80, 90)');
        }

        expect((await paintOf(page, '#bareIcon')).color).toBe('rgb(40, 50, 60)');
    });

    test('a header that lays itself out keeps its zero padding', async ({ page }) => {
        await page.goto(makePage());

        // Upstream's `padding: 5px 0` leaves a filled bar's label touching its rounded edge, so the rule
        // adds horizontal padding -- except where `padding0` says the header packs its own controls.
        //
        // ⚠️ `#noPadding` deliberately does NOT carry `standoutHeader`. Creator's Notes, the one header in
        // `index.html` written this way, carries both -- and upstream's `.standoutHeader
        // .inline-drawer-header { padding: 5px }` outranks `padding0` at two classes to one, so it already
        // renders at 5px with or without this fork. Writing the fixture that way tested upstream's
        // cascade, not the guard.
        expect((await paintOf(page, '#bare')).paddingLeft).toBe('5px');
        expect((await paintOf(page, '#noPadding')).paddingLeft).toBe('0px');
    });
});
