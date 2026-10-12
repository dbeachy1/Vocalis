import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const powerUser = read('public/scripts/power-user.js');
const indexHtml = read('public/index.html');
const buttonsCss = read('public/css/buttons.css');

/**
 * 🔴 WHY THIS READS SOURCE TEXT INSTEAD OF CALLING ANYTHING.
 *
 * Taproom 0.4's four button colors have to be wired into `power-user.js` in six separate places, and the
 * two that are plain object literals -- the `power_user` defaults and `getThemeObject` -- fail SILENTLY
 * when a key is missing. Nothing throws, nothing looks wrong, the picker moves the color: the theme just
 * quietly does not save it, and the user finds out after a reload. That is the exact failure the upstream
 * pattern invites, because ten colors are ten hand-written copies of one line in six places.
 *
 * `power-user.js` cannot be imported here to check it properly -- it pulls in `script.js` and effectively
 * the whole front end, which is why the plumbing had no test before. So this reads the file, takes
 * `BUTTON_THEME_COLORS` as the source of truth, and insists every site agrees with it.
 *
 * ⚠️ IT IS PATTERN MATCHING, so a legitimate refactor of any of these sites will fail it. That is
 * deliberate and the failure message says what to do; the alternative is no check at all. What it CANNOT
 * see is whether the wiring works -- `tests/frontend/theme-button-colors.e2e.js` renders real buttons
 * against the real stylesheets for that half.
 */
const table = powerUser.match(/const BUTTON_THEME_COLORS = \[([\s\S]*?)\n\];/);

const COLORS = [...(table?.[1] ?? '').matchAll(
    /\{ key: '([^']+)', property: '([^']+)', selector: '([^']+)', type: '([^']+)' \}/g,
)].map(([, key, property, selector, type]) => ({ key, property, selector, type }));

describe('the four button colors are wired everywhere they have to be', () => {
    test('the table this whole file is checked against was actually found', () => {
        // If the table is renamed or reshaped, every test below would iterate an empty list and pass
        // vacuously — a green suite checking nothing, which is worse than a red one.
        expect(table).not.toBeNull();
        expect(COLORS.map(c => c.key)).toEqual([
            'button_bg_color',
            'button_border_color',
            'button_text_color',
            'button_hover_bg_color',
        ]);
    });

    describe.each(COLORS)('$key', ({ key, property, selector, type }) => {
        test('has a default read from the stylesheet, so the picker opens on the real color', () => {
            expect(powerUser).toContain(`${key}: readButtonColor('${property}'),`);
        });

        test('is in themeProperties, or selecting a theme will not apply it', () => {
            expect(powerUser).toContain(`{ key: '${key}', selector: '${selector}', type: '${type}' },`);
        });

        test('is in getThemeObject, or it silently does not save and does not import', () => {
            // `getNewTheme` copies only keys that already exist on this object, so an omission here breaks
            // BOTH halves of the round trip -- and neither one reports anything.
            expect(powerUser).toContain(`${key}: power_user.${key},`);
        });

        test('has a picker in the Theme Colors block', () => {
            expect(indexHtml).toContain(`<toolcool-color-picker id="${selector.slice(1)}">`);
        });

        test('is defined and consumed by buttons.css', () => {
            // Defined in `:root` (the default) and read by at least one rule (the thing that paints).
            expect(buttonsCss).toContain(`${property}:`);
            expect(buttonsCss).toContain(`var(${property},`);
        });
    });

    test('applyThemeColor can reach all four, and the theme loader resets the ones a theme omits', () => {
        // Both are table-driven rather than hand-plumbed, so what matters is that the calls still exist.
        expect(powerUser).toContain('const buttonColor = BUTTON_THEME_COLORS.find(x => x.type === type);');
        expect(powerUser).toContain('resetButtonColorsNotIn(theme);');
    });

    test('the reset runs AFTER the theme loop, or button text lands one theme behind', () => {
        // 🔴 A REAL BUG, CAUGHT ON THE LIVE INSTALL AND EASY TO REINTRODUCE. The default for
        // `--SmartThemeButtonTextColor` is `var(--SmartThemeBodyColor)`, so resolving it reads the body
        // color -- and before the loop has run, that is still the OUTGOING theme's. Selecting Azure gave
        // the labels the previous theme's body color; selecting Cappuccino gave them Azure's. The other
        // three colors were correct throughout, which is exactly why it was invisible.
        const loop = powerUser.indexOf('for (const { key, selector, type, action } of themeProperties) {');
        const reset = powerUser.indexOf('resetButtonColorsNotIn(theme);');
        expect(loop).toBeGreaterThan(-1);
        expect(reset).toBeGreaterThan(loop);
    });

    test('the reset writes the restored value back, rather than trusting the picker to do it', () => {
        // Setting `color` on a toolcool picker fires `change` synchronously, so the DOM happens to end up
        // right today. `power_user` must hold it too -- `getThemeObject` saves from there, so a value that
        // is only implied by the stylesheet is one the next "Save theme" writes wrong.
        const body = powerUser.match(/function resetButtonColorsNotIn\(theme\) \{[\s\S]*?\n\}/)?.[0] ?? '';
        expect(body).toContain('power_user[key] = readButtonColor(property);');
        expect(body).toContain('applyThemeColor(type);');
    });

    test('the pickers are read at boot and written on change', () => {
        // Without the first loop the pickers open black and the first nudge writes black into the theme;
        // without the second, moving a picker does nothing at all.
        const loops = powerUser.match(/for \(const \{[^}]*\} of BUTTON_THEME_COLORS\)/g) ?? [];
        expect(loops.length).toBeGreaterThanOrEqual(2);
        expect(powerUser).toContain('$(selector).attr(\'color\', power_user[key]);');
        expect(powerUser).toContain('power_user[key] = evt.detail.rgba;');
    });

    test('every default is opaque about its alpha, because three of the four have one', () => {
        // The pickers ship transparency support; a default written as a hex or a bare `rgb()` would be a
        // silent decision to drop it. `--SmartThemeButtonTextColor` is `var(--SmartThemeBodyColor)` and
        // inherits whatever the body color is, so it is not one of these.
        const root = buttonsCss.match(/:root \{([\s\S]*?)\}/)?.[1] ?? '';
        expect(root.match(/rgba\(/g) ?? []).toHaveLength(3);
        expect(root).toContain('--SmartThemeButtonTextColor: var(--SmartThemeBodyColor);');
    });
});
