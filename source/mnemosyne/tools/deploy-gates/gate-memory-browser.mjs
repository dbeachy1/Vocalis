/**
 * The memory-browser gate — driven against the LIVE install, in a real browser.
 *
 * The server-side suite proves the plugin *emits* regions and actions, and proves it escapes everything on the
 * way out. It cannot prove that any of it survives the trip: the fragment is sanitized by DOMPurify inside the
 * fork's popup, the host binds clicks by walking the DOM, and a region that arrives with its attribute stripped
 * or its name unmatched fails **silently** — the click does nothing, the response was 200, and no error is
 * raised anywhere. That is the seam this closes, and it is the same class of gap `gate-notify-colors.mjs`
 * describes from the other side: that one is server-side and loads no browser, this one loads a browser and
 * asserts almost nothing about the server.
 *
 * 🔴 WHAT THIS GATE DOES NOT OBSERVE, stated so a green run is not read as more than it is:
 *
 *   - **Any partition but the caller's own.** It drives `claudetest`, whose store holds only what these runs
 *     put there, and it asserts on STRUCTURE — region names, attribute counts, control presence. It never
 *     reads a memory's text back out, and it should stay that way.
 *   - **The full identity matrix.** It runs from the character-select screen, where the host sends `personaId`
 *     and `tz` and no `charId` or `chatId`. That is deliberate: the partial identity is precisely the case
 *     that found the "About me" defect (a button filtering on `u::<persona>`, a real partition holding
 *     nothing, answering an empty screen in the one feature built so a user can see their memories). A run
 *     inside an open chat would exercise the full-identity path and is worth adding when there is a scripted
 *     chat to open.
 *   - **Whether an edit's text is correct.** It opens the edit box and checks the caret can survive a redraw;
 *     it does not save one, because a save embeds and this gate is not a model test.
 *   - **The version chain, and therefore restore.** Building one needs a saved edit, which needs an embed, for
 *     the reason directly above. So "every version in the history offers its own restore" — the fix for an
 *     undo that could not be undone — is proved server-side (`plugin.test.js`, *"restore is reversible from
 *     the history"*) and not here. Worth moving into this gate the day the gate is allowed to embed.
 *
 * ⚠️ Needs Taproom's Playwright (`source/taproom/tests/node_modules`, found relative to this file; Taproom is
 * the SillyTavern fork that ships with Vocalis) — this repo does not depend on it, and a browser gate that
 * pulled a browser download into a key-holding plugin's dependency tree would be a bad trade for one script.
 * A standalone checkout of this plugin has no Taproom beside it: point `MNEMOSYNE_GATE_PLAYWRIGHT` at a
 * Playwright `index.mjs` instead. If neither resolves, the gate prints that hint and exits 2 before touching
 * the server. Set `MNEMOSYNE_GATE_BASE` to the intended test service URL before running it.
 *
 * ⚠️ Writes into `claudetest`, the throwaway account on a box that is not production, and deletes what it
 * creates — including on failure. An earlier version did not, and every run left another row behind.
 */
/* eslint-env browser */
// ⚠️ `browser` env for the whole file, because the callbacks handed to `page.evaluate` and `waitForFunction`
// are serialized and run in the PAGE, where `document` and `globalThis.SillyTavern` exist and Node's globals
// do not. Everything outside those callbacks is ordinary Node — the two worlds share a file and nothing else.
import { pathToFileURL } from 'node:url';

// ⚠️ A DYNAMIC import, because the specifier is computed at run time: this file sits at
// `source/mnemosyne/tools/deploy-gates/`, and Taproom's Playwright is at
// `source/taproom/tests/node_modules/playwright/index.mjs` — three directories up, then across. (It used to be
// an absolute `file:///` URL into one developer machine's checkout, which no other checkout could run.)
// `MNEMOSYNE_GATE_PLAYWRIGHT` overrides it with a filesystem path to a Playwright `index.mjs`.
const playwrightUrl = process.env.MNEMOSYNE_GATE_PLAYWRIGHT
    ? pathToFileURL(process.env.MNEMOSYNE_GATE_PLAYWRIGHT).href
    : new URL('../../../taproom/tests/node_modules/playwright/index.mjs', import.meta.url).href;

// 🔴 The type comes from the hand-written ambient module in `types/tools/playwright.d.ts`, whose name is a
// label and not a real package: `import(playwrightUrl)` is `Promise<any>` to TypeScript, so this annotation is
// the only thing that keeps `chromium` and everything hanging off it checked.
/** @type {typeof import('mnemosyne-gate-playwright')} */
const playwright = await import(playwrightUrl).catch((/** @type {{ message?: string }|null|undefined} */ error) => {
    console.error(`FAIL  cannot load Playwright from ${playwrightUrl} — ${String(error?.message ?? error).slice(0, 200)}`);
    console.error('      Taproom must be checked out beside this plugin with its tests/node_modules installed, or set '
        + 'MNEMOSYNE_GATE_PLAYWRIGHT to a Playwright index.mjs.');
    process.exit(2);
});
const { chromium } = playwright;

const BASE = process.env.MNEMOSYNE_GATE_BASE ?? 'https://mnemosyne.example.invalid:8001';
const USER = process.env.MNEMOSYNE_GATE_USER ?? 'claudetest';
const PASS = process.env.MNEMOSYNE_GATE_PASS ?? 'welcome';
const MARKER = `gate-browser-${Date.now()}`;

/** @type {Array<{ name: string, ok: boolean, detail: string }>} */
const results = [];
/**
 * @param {string} name What was checked, in the words the summary prints
 * @param {boolean} ok
 * @param {string} [detail] Evidence — printed on a pass as well, because a pass with the wrong evidence is
 *   how a gate that has stopped observing anything goes on reporting success
 * @returns {void}
 */
const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });   // known mkcert pair, not a trust decision
const page = await context.newPage();

/** Console errors from ANY origin, truncated. @type {string[]} */
const consoleErrors = [];
/** `<status> <path>` for every non-OK response, any origin. @type {string[]} */
const badResponses = [];
/** `<method> <path>` for Mnemosyne's own routes — this is where the host's appended identity shows up. @type {string[]} */
const pluginRequests = [];
let seededId = null;

page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('response', r => { if (!r.ok() && r.status() !== 304) badResponses.push(`${r.status()} ${r.url().replace(BASE, '')}`); });
page.on('request', r => { if (r.url().includes('/plugins/mnemosyne/')) pluginRequests.push(`${r.method()} ${r.url().replace(BASE, '')}`); });

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    // Login is two steps: pick the user, and only then does the password field exist.
    await page.waitForSelector('#userList .userSelect', { timeout: 20000 });
    await page.locator('#userList .userSelect', { hasText: USER }).first().click();
    await page.waitForSelector('#userPassword:visible', { timeout: 10000 });
    await page.fill('#userPassword', PASS);
    await page.click('#loginButton');

    // 🔴 GATE ON REAL APP STATE, NEVER ON STATIC MARKUP — `#send_form` and friends resolve on a
    // half-initialized page. And no `await import()` inside evaluate: it makes a SECOND module instance with
    // fresh module-scope state, so you read defaults instead of reality. Read `globalThis.SillyTavern` only.
    //
    // ⚠️ `getContext()` itself THROWS while the app is still initializing ("Cannot access 'chat' before
    // initialization", a TDZ error out of st-context.js), so the probe swallows that rather than failing on it.
    await page.waitForFunction(() => {
        try {
            return globalThis.SillyTavern?.getContext?.()?.characters !== undefined;
        } catch {
            return false;
        }
    }, null, { timeout: 60000 });
    check('logged in and the app finished initializing', true);

    const button = page.locator('[id^="pluginPanelButton_mnemosyne"]');
    await button.first().waitFor({ timeout: 20000 });
    check('Mnemosyne registered its panel button', await button.count() > 0);

    // Seed one memory through the real REST route, using the page's own CSRF headers, so the list has a row.
    // ⚠️ The cast is the readiness gate above written down. `SillyTavern` is declared `| undefined` because it
    // genuinely is, right up until the probe on line 83 passes — see types/tools/playwright.d.ts. Everything
    // from here on runs after that, so the assertion is about ORDER in this file, not about the fork.
    const seeded = await page.evaluate(async (marker) => {
        const res = await fetch('/api/plugins/mnemosyne/memory', {
            method: 'POST',
            headers: /** @type {SillyTavernPage} */ (globalThis.SillyTavern).getContext().getRequestHeaders(),
            body: JSON.stringify({ text: marker, tier: 'user' }),
        });
        return { status: res.status, body: res.status < 300 ? await res.json() : null };
    }, MARKER);
    seededId = seeded.body?.id ?? null;
    check('POST /memory accepted a memory', seeded.status === 201, `HTTP ${seeded.status}`);

    await button.first().click();

    const panel = page.locator('.pluginPanel').first();
    await panel.waitFor({ timeout: 15000 });

    // 🔴 The regions have to be found in the DOM, AFTER sanitizing. This is the whole point of the gate: a
    // `data-panel-region` stripped on the way in leaves a panel that renders and never responds again.
    const regions = await panel.evaluate(el =>
        [...el.querySelectorAll('[data-panel-region]')].map(n => n.getAttribute('data-panel-region')));
    check('the panel rendered', regions.length > 0, `regions: ${regions.join(', ') || 'none'}`);

    for (const name of ['header', 'toolbar', 'list', 'pager']) {
        check(`region "${name}" survived DOMPurify`, regions.includes(name));
    }

    const actions = await panel.evaluate(el => el.querySelectorAll('[data-panel-action]').length);
    check('actions survived DOMPurify', actions > 0, `${actions} action elements`);
    check('the seeded memory is listed',
        await panel.evaluate(el => el.querySelectorAll('[data-panel-region^="slot-"]').length) > 0);

    const headerText = await panel.evaluate(el =>
        el.querySelector('[data-panel-region="header"]')?.textContent?.trim() ?? '');
    check('the header explains the cadence', /Next check|Nothing checked yet/.test(headerText));
    check('the header has no undefined/NaN', !/undefined|NaN/.test(headerText));

    // ⚠️ Half an identity is not an identity. From this screen the host sends no `charId`, so the user-tier
    // button must be absent rather than filtering on `u::<persona>` and answering an empty list.
    const toolbarText = await panel.evaluate(el =>
        el.querySelector('[data-panel-region="toolbar"]')?.textContent ?? '');
    const sentCharId = pluginRequests.some(r => r.includes('charId='));
    check('the user-tier filter is offered only with a full identity',
        sentCharId === toolbarText.includes('About me'),
        sentCharId ? 'charId sent, button present' : 'no charId sent, button correctly absent');

    // 🔴 THE ROUND TRIP. Click a real action and confirm the host swapped a region, rather than the click
    // landing on nothing — the silent failure the whole protocol is written against. The replaced toggle is
    // chosen because it is idempotent and changes its own label.
    const toggle = panel.locator('[data-panel-region="toolbar"] [data-panel-action]', { hasText: 'Show replaced' }).first();
    // ⚠️ `textContent()` IS DECLARED NULLABLE AND CANNOT BE NULL HERE — the DOM returns `null` only for the
    // handful of node kinds that cannot hold text (Document, DocumentType), never for an Element, and a
    // locator that resolved to nothing at all would have REJECTED on the wait rather than handed back null.
    // The cast is that argument; it is not an assumption that the toolbar has a label.
    const before = /** @type {string} */ (await toggle.textContent());
    await toggle.click();
    await page.waitForFunction(
        was => document.querySelector('.pluginPanel [data-panel-region="toolbar"]')?.textContent?.includes('☑') !== was,
        before.includes('☑'), { timeout: 10000 });
    check('an action round-tripped and the host swapped the region', true, before.trim().slice(0, 30));

    // The state a swapped region hands forward has to read back the way `viewState` parses it — a boolean
    // stringified as "true" round-trips to false and the toggle silently switches itself off on the next click.
    check('view state round-trips as replaced=1, not replaced=true', await panel.evaluate(el =>
        [...el.querySelectorAll('[data-panel-action]')].some(n => (n.getAttribute('data-panel-params') ?? '').includes('replaced=1'))));

    const editButton = panel.locator('[data-panel-region^="slot-"] [data-panel-action]', { hasText: 'edit' }).first();
    await editButton.click();
    await page.waitForSelector('.pluginPanel textarea[name="text"]', { timeout: 10000 });
    const focusKey = await page.evaluate(() =>
        document.querySelector('.pluginPanel textarea[name="text"]')?.getAttribute('data-panel-focus'));
    check('the edit box opened via a region swap', true);
    check('the edit box carries data-panel-focus, or the caret dies on redraw', !!focusKey, focusKey ?? 'missing');

    // 🔴 THE CALENDAR IS CHECKED BY GEOMETRY, NOT BY MARKUP, AND THAT IS THE WHOLE POINT OF PUTTING IT HERE.
    // The server-side suite already asserts the table structure, and it asserted the old `<span>` grid just as
    // happily — every class was present and correct, and the thing rendered as the single line
    // `SuMoTuWeThFrSa123456789101112…` because a plugin has no way to ship the CSS those classes needed. No
    // string assertion anywhere could have caught that. Measuring where the cells actually LAND can, and only
    // a browser knows.
    await panel.locator('[data-panel-region="header"] [data-panel-action]', { hasText: '📅' }).first().click();
    await page.waitForSelector('.pluginPanel .mnemosyne-calendar', { timeout: 10000 });

    const grid = await panel.evaluate((el) => {
        // ⚠️ The `waitForSelector` above proves the DOCUMENT has a `.pluginPanel .mnemosyne-calendar`; it does
        // not prove that THIS `.pluginPanel` — the first one — is the one holding it. The fork shows a single
        // panel at a time, so the two are the same element today, and if that ever stops being true this line
        // throws inside the page and the run is caught and reported as a failure rather than passing quietly.
        // The cast records the assumption at the place that makes it.
        const table = /** @type {Element} */ (el.querySelector('.mnemosyne-calendar'));
        const cells = [...table.querySelectorAll('.mnemosyne-cell')];
        const rows = new Map();

        for (const cell of cells) {
            const top = Math.round(cell.getBoundingClientRect().top);
            rows.set(top, (rows.get(top) ?? 0) + 1);
        }

        return { tag: table.tagName, cells: cells.length, rows: [...rows.values()] };
    });

    check('the calendar is a table, so the grid needs no stylesheet of ours', grid.tag === 'TABLE', grid.tag);
    // A month is five or six weeks plus the weekday heading. One row means every cell landed on one line,
    // which is exactly the bug: laid out as inline spans with nothing styling them.
    check('the calendar lays out as a grid rather than one run-on line',
        grid.rows.length >= 5, `${grid.cells} cells across ${grid.rows.length} row(s)`);
    check('every week is seven columns wide', grid.rows.every(n => n <= 7) && grid.rows.filter(n => n === 7).length >= 4,
        `row widths: ${grid.rows.join(',')}`);

    const mineFailed = badResponses.filter(r => r.includes('/plugins/mnemosyne'));
    check('no Mnemosyne request failed', mineFailed.length === 0, mineFailed.join(' | '));
} catch (error) {
    // ⚠️ `String(error)`, not `String(error.message)`: Playwright rejects with plain objects on some paths,
    // and `.message` is then undefined — so the one line telling you WHY the gate failed said "undefined".
    //
    // 🔴 That is also why the cast says `{ message?: string }` and not `Error`. A `catch` binding is `unknown`
    // because JavaScript can throw anything, and this file has the receipts: declaring `Error` here would type
    // `.message` as a string that is always there and quietly delete the `?? error` fallback's whole reason
    // for existing. The optional message is the true statement, and the true statement keeps the fix.
    check('run completed without throwing', false,
        String(/** @type {{ message?: string }|null|undefined} */ (error)?.message ?? error).slice(0, 300));
} finally {
    // Delete what this run created, on success and on failure alike.
    if (seededId !== null) {
        try {
            const removed = await page.evaluate(async (id) => (await fetch(`/api/plugins/mnemosyne/memory/${id}`, {
                method: 'DELETE',
                headers: /** @type {SillyTavernPage} */ (globalThis.SillyTavern).getContext().getRequestHeaders(),
            })).status, seededId);
            check('the seeded memory was cleaned up', removed === 204, `HTTP ${removed}`);
        } catch (error) {
            check('the seeded memory was cleaned up', false,
                String(/** @type {{ message?: string }|null|undefined} */ (error)?.message ?? error).slice(0, 120));
        }
    }

    await browser.close();
}

console.log(`\nwhat the host appends to a Mnemosyne request:\n  ${pluginRequests.slice(0, 6).join('\n  ') || 'nothing'}`);
console.log(`non-OK responses (any origin): ${badResponses.join(' | ') || 'none'}`);
console.log(`console errors (any origin): ${consoleErrors.join(' | ') || 'none'}`);

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
