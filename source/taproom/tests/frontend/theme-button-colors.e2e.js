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
 * 🔴 WHAT THIS GUARDS, AND WHY IT IS A RENDER SPEC RATHER THAN A UNIT TEST.
 *
 * Taproom 0.4 gives the theme system four button colors. The JS half is small and boring -- read a value,
 * `setProperty` it on `<html>` -- and every way it can fail is a CSS fact, not a JS one:
 *
 *   - `.menu_button` ships `filter: grayscale(0.5)`, so a correctly plumbed color arrives desaturated and
 *     the feature looks broken rather than absent. `buttons.css` clears it; nothing else would notice if
 *     that line were dropped.
 *   - `buttons.css` wins over `style.css` only because `index.html` links it second. Load order is not
 *     visible in either file.
 *   - `--SmartThemeButtonTextColor` is defined as `var(--SmartThemeBodyColor)`, and `power_user`'s default
 *     for it is `getComputedStyle(...).getPropertyValue(...)`. That only works if custom properties are
 *     substituted at computed-value time; if a browser handed back the literal `var(--SmartThemeBodyColor)`
 *     the fork would store that string in `settings.json` and feed it to a color picker.
 *
 * So: load the REAL `style.css` and the REAL `buttons.css` into a blank page, in the order `index.html`
 * links them, and measure. `power-user.js` itself cannot be imported here -- it pulls in `script.js` and
 * the whole app -- so the JS contract is pinned by `tests/theme-button-colors.test.js` instead, and this
 * file pins what those JS writes actually do to a button.
 */

/** The stylesheets `index.html` links, in the order it links them. Order is the thing under test. */
const CSS = [
    'public/css/fontawesome.min.css',
    'public/css/solid.min.css',
    'public/style.css',
    'public/css/buttons.css',
].map(rel => pathToFileURL(path.join(repoRoot, rel)).href);

/**
 * The defaults `buttons.css` is expected to give the properties, AS AUTHORED.
 *
 * ⚠️ `0.60`, not `0.6`. Reading a custom property hands back the author's token stream verbatim -- unlike
 * reading `backgroundColor`, which is a real color and comes out normalised. That matters beyond this file:
 * these exact strings are what `power_user` initialises to, what gets written into `settings.json` and a
 * saved theme, and what the color picker is handed at boot.
 *
 * `--SmartThemeButtonTextColor` is absent on purpose -- it is `var(--SmartThemeBodyColor)`, so it has no
 * literal of its own and is checked against the body color instead.
 */
const DEFAULTS = {
    '--SmartThemeButtonBgColor': 'rgba(90, 120, 170, 0.35)',
    '--SmartThemeButtonBorderColor': 'rgba(140, 175, 225, 0.60)',
    '--SmartThemeButtonHoverBgColor': 'rgba(110, 150, 210, 0.60)',
};

/** Build a page carrying the button kinds `buttons.css` speaks about, and hand back its file:// URL. */
function makePage() {
    const scratch = makeScratchDirectory('theme-button-colors');
    const links = CSS.map(href => `<link rel="stylesheet" href="${href}">`).join('\n');
    const file = path.join(scratch, 'buttons.html');
    fs.writeFileSync(file, `<!DOCTYPE html>
<meta charset="utf-8">
${links}
<style>
/*
 * 🔴 TRANSITIONS OFF, AND THIS IS NOT COSMETIC. \`.menu_button\` carries \`transition:
 * var(--animation-duration-2x)\` -- a bare duration, which is the \`all\` shorthand -- so a background
 * color that has just been changed is MID-ANIMATION, and \`getComputedStyle\` faithfully reports the
 * interpolated value. In practice that is the OLD color, because the read happens within a millisecond
 * of the write. The first version of this spec failed on exactly that and read as "setting the variable
 * does nothing", which is the same symptom a genuinely unplumbed variable produces. What is under test
 * here is which color a button resolves to, not how it gets there.
 */
* { transition: none !important; }
</style>
<body>
<div id="ordinary" class="menu_button">Save</div>
<div id="danger" class="menu_button menu_button_danger_outline">Delete</div>
<div id="disabled" class="menu_button disabled">Nope</div>
<div id="qr--bar"><div class="qr--buttons"><div id="qr" class="qr--button">Quick Reply</div></div></div>
</body>`, 'utf-8');
    return pathToFileURL(file).href;
}

/** Rendered color properties of one element, as the browser resolves them. */
function paintOf(page, selector) {
    return page.evaluate((selector) => {
        const style = getComputedStyle(document.querySelector(selector));
        return {
            background: style.backgroundColor,
            border: style.borderTopColor,
            color: style.color,
            filter: style.filter,
        };
    }, selector);
}

/** Apply button colors the way `applyThemeColor` does — inline custom properties on `<html>`. */
function setThemeColors(page, colors) {
    return page.evaluate((colors) => {
        for (const [property, value] of Object.entries(colors)) {
            document.documentElement.style.setProperty(property, value);
        }
    }, colors);
}

/** Undo them the way `resetButtonColorsNotIn` does, and report what the stylesheet gives back. */
function clearThemeColors(page, properties) {
    return page.evaluate((properties) => {
        const out = {};
        for (const property of properties) {
            document.documentElement.style.removeProperty(property);
            out[property] = getComputedStyle(document.documentElement).getPropertyValue(property).trim();
        }
        return out;
    }, properties);
}

test.describe('themeable button colors (Taproom 0.4)', () => {
    test('a button with no theme reads as a button, not as a line of text', async ({ page }) => {
        await page.goto(makePage());
        const paint = await paintOf(page, '#ordinary');

        expect(paint.background).toBe('rgba(90, 120, 170, 0.35)');
        expect(paint.border).toBe('rgba(140, 175, 225, 0.6)');

        // The panel color. If the fill ever equals this again, the whole feature has regressed to the
        // problem it was written for: a button the same color as the thing behind it.
        const panel = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBlurTintColor').trim());
        expect(paint.background).not.toBe(panel);
    });

    test('the grayscale filter is cleared, so a chosen color survives to the screen', async ({ page }) => {
        await page.goto(makePage());

        // 🔴 THE TRAP. `.menu_button { filter: grayscale(0.5) }` in `style.css` desaturates whatever fill it
        // is given. With it in place every picker in the Theme Colors block still "works" -- the property
        // is set, the value is stored, the theme saves -- and every color comes out grey.
        expect((await paintOf(page, '#ordinary')).filter).toBe('none');
    });

    test('setting the properties repaints the button, which is what the pickers do', async ({ page }) => {
        await page.goto(makePage());
        await setThemeColors(page, {
            '--SmartThemeButtonBgColor': 'rgb(10, 20, 30)',
            '--SmartThemeButtonBorderColor': 'rgb(40, 50, 60)',
            '--SmartThemeButtonTextColor': 'rgb(70, 80, 90)',
        });

        const paint = await paintOf(page, '#ordinary');
        expect(paint.background).toBe('rgb(10, 20, 30)');
        expect(paint.border).toBe('rgb(40, 50, 60)');
        expect(paint.color).toBe('rgb(70, 80, 90)');
    });

    test('clearing the properties gives back the default, which is how a pre-0.4 theme loads', async ({ page }) => {
        await page.goto(makePage());
        await setThemeColors(page, {
            '--SmartThemeButtonBgColor': 'rgb(10, 20, 30)',
            '--SmartThemeButtonBorderColor': 'rgb(40, 50, 60)',
            '--SmartThemeButtonHoverBgColor': 'rgb(70, 80, 90)',
        });

        // Selecting a theme that names none of them must not leave the previous theme's buttons behind.
        // `resetButtonColorsNotIn` removes the inline property and re-reads; this is that read.
        const restored = await clearThemeColors(page, Object.keys(DEFAULTS));
        expect(restored).toEqual(DEFAULTS);
        expect((await paintOf(page, '#ordinary')).background).toBe('rgba(90, 120, 170, 0.35)');
    });

    test('the text color resolves through var(), which the power_user default depends on', async ({ page }) => {
        await page.goto(makePage());

        // `buttons.css` sets `--SmartThemeButtonTextColor: var(--SmartThemeBodyColor)`. Custom properties
        // are substituted at computed-value time, so this must come back as a color and not as the literal
        // text `var(--SmartThemeBodyColor)` -- `power_user.button_text_color` is initialised from exactly
        // this read, and a `var(...)` string there would be saved into themes and handed to a color picker.
        const { buttonText, bodyColor } = await page.evaluate(() => {
            const style = getComputedStyle(document.documentElement);
            return {
                buttonText: style.getPropertyValue('--SmartThemeButtonTextColor').trim(),
                bodyColor: style.getPropertyValue('--SmartThemeBodyColor').trim(),
            };
        });

        expect(buttonText).not.toContain('var(');
        expect(buttonText).toBe(bodyColor);
    });

    test('the delete button keeps its own colors and takes no fill', async ({ page }) => {
        await page.goto(makePage());
        const paint = await paintOf(page, '#danger');

        // An outline variant has no fill by definition. Without the explicit `transparent` in `buttons.css`
        // it picks up the ordinary button's blue and stops announcing itself as destructive.
        expect(paint.background).toBe('rgba(0, 0, 0, 0)');
        expect(paint.border).not.toBe('rgba(140, 175, 225, 0.6)');
    });

    test('Quick Reply buttons consume the same four variables', async ({ page }) => {
        await page.goto(makePage());
        expect((await paintOf(page, '#qr')).background).toBe('rgba(90, 120, 170, 0.35)');

        await setThemeColors(page, { '--SmartThemeButtonBgColor': 'rgb(10, 20, 30)' });
        // The selector duplicates the extension's own id-level specificity. A bare `.qr--button` rule loses
        // to `#qr--bar > .qr--buttons .qr--button` and does nothing -- silently, and only for Quick Replies.
        expect((await paintOf(page, '#qr')).background).toBe('rgb(10, 20, 30)');
    });

    test('an enabled button takes the hover fill, and a disabled one does not', async ({ page }) => {
        await page.goto(makePage());

        // ⚠️ DRIVEN BY `.active`, NOT BY A REAL HOVER. `.menu_button.disabled` is `pointer-events: none`, so
        // Playwright cannot hover it and neither can the browser's hit-testing -- a `page.hover` here waits
        // out its timeout and then proves nothing either way. The shipped rule matches
        // `:not(.disabled):not([disabled]):hover, …:not(…).active`, so the `.active` half exercises the same
        // guards without needing a pointer.
        await page.evaluate(() => {
            document.querySelector('#ordinary').classList.add('active');
            document.querySelector('#disabled').classList.add('active');
        });

        expect((await paintOf(page, '#ordinary')).background).toBe('rgba(110, 150, 210, 0.6)');
        // The guards are copied from the `style.css` rule `buttons.css` replaces. Dropping them while
        // rewriting the hover color would make disabled controls light up as though they were clickable.
        expect((await paintOf(page, '#disabled')).background).not.toBe('rgba(110, 150, 210, 0.6)');
    });
});
