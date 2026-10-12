/**
 * The notification gate — driven against the LIVE install, with no LLM and no browser.
 *
 * The server-side suite proves the plugin *calls* `context.notify()` correctly, and the fork's own
 * `plugin-panels.e2e.js` proves a class icon *takes* a pushed color. Neither proves the two halves are joined in
 * the deployment operator actually uses. This closes that seam: plant a memory through the real REST route on the
 * real service, then read `/api/plugins/notifications` exactly as the client does and assert what the button will
 * be told.
 *
 * 🔴 WHAT THIS GATE ITSELF DOES NOT OBSERVE — and where each is now covered. Stated so nobody reads a green run
 * here as the whole story, and — the reason this note was rewritten — so nobody re-derives a "needs a model"
 * blocker that has cost this project days three separate times. A recall needs a *generation*, never a GPU.
 *
 *   - **The green half and precedence.** Both are covered by the fork's `gate-recall-and-precedence.mjs`, which
 *     drives a real streaming generation through a scripted SSE backend on localhost and asserts `memory.recalled`
 *     arrives green, and that a turn doing BOTH ends purple — precedence observed live, 14/14, no language model.
 *     The embedding model retrieval needs (`Cohee/jina-embeddings-v2-base-en`, warmed at boot) is a different
 *     thing, and conflating the two is exactly what made the green half look unreachable from here.
 *   - **The pixels.** This gate is server-side and loads no browser, so what it proves is that the color is
 *     *dispatched*: `color` addressed to a button whose `iconType === 'class'` and can therefore wear it — the
 *     half that fails silently, since an emoji would pass every server-side test on both sides and paint nothing.
 *     That the cascade actually PAINTS it is the fork's `plugin-panels.e2e.js`, which asserts the browser's
 *     computed style rather than the inline `style.color` a JS write sets (an `!important` rule beats the latter).
 *
 * ⚠️ Writes into `claudetest`, the throwaway account on a box that is not production. Everything it creates is
 * named with the run marker and deleted at the end, including on failure.
 */

// Self-signed mkcert pair; this is a diagnostic against a known cert, not a trust decision.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = process.env.MNEMO_BASE ?? 'https://localhost:8001';
const HANDLE = process.env.MNEMO_HANDLE ?? 'claudetest';
// Never written into this file; supplied by the runner. GATE5_PASSWORD is accepted too, because that is the name
// the fork's gates already use and muscle memory is worth more than consistency here.
const PASSWORD = process.env.MNEMO_PASSWORD ?? process.env.GATE5_PASSWORD;

const PLUGIN_ID = 'mnemosyne';
const RUN = `NOTIFY-${process.pid}`;
const CHAT_HERE = `${RUN}-here`;
const CHAT_ELSEWHERE = `${RUN}-elsewhere`;
const PERSONA_ID = `${RUN}-persona`;
/** Distinctive enough that finding it in a payload is proof, not coincidence. */
const SECRET = `${RUN}-the-user-keeps-bees-in-a-rooftop-apiary`;

/** @type {Array<{ name: string, pass: boolean, detail: string|undefined }>} */
const results = [];
let planted = null;

/**
 * @param {string} name What was checked, in the words the summary prints
 * @param {boolean} pass
 * @param {string} [detail] Evidence. ⚠️ Optional AND frequently `undefined` at a call site that passed one:
 *   most of these are `JSON.stringify(x?.y)`, and `JSON.stringify(undefined)` is `undefined`, not `"undefined"`.
 *   That is the honest shape — a check whose evidence went missing is a check worth looking at twice.
 * @returns {void}
 */
function record(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * ⚠️ A real cookie JAR and a CSRF token. The live install has CSRF on and sets more than one cookie; dropping
 * either presents as a 403 that reads exactly like bad credentials. Learned by the fork's gate5 the hard way.
 */
const jar = new Map();
let csrfToken = '';

/**
 * Take every `Set-Cookie` off a response into the jar. `getSetCookie()` rather than `headers.get()`:
 * the login sets more than one, and `get` folds them into a single comma-joined string.
 * @param {Response} response
 * @returns {void}
 */
function absorb(response) {
    for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const index = pair.indexOf('=');
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
}

function cookieHeader() {
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * One authenticated call against the live install.
 *
 * ⚠️ `headers` IS DECLARED `Record<string, string>` RATHER THAN LEFT TO INFERENCE. From its initializer
 * alone TypeScript reads the object as having exactly one key, and the two lines that add `Cookie` and
 * `X-CSRF-Token` become errors — the two headers without which the live server answers 403 and it reads
 * exactly like bad credentials. The annotation says what the object is FOR, which is a bag of headers.
 *
 * @param {string} route Path only; `BASE` is prefixed here
 * @param {unknown} body JSON-serialized for anything but GET/DELETE. `null` sends `{}`.
 * @param {string} [method]
 */
async function call(route, body, method = 'POST') {
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json' };
    if (jar.size) headers.Cookie = cookieHeader();
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

    const response = await fetch(`${BASE}${route}`, {
        method,
        headers,
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
    });

    absorb(response);

    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    return { status: response.status, body: parsed, text };
}

/**
 * 🔴 SENDS THE JAR. Calling this bare after logging in mints a fresh anonymous session, overwrites the
 * authenticated cookie, and everything after comes back 403 — which reads as a CSRF fault and is a lost login.
 */
async function openSession() {
    const response = await fetch(`${BASE}/csrf-token`, {
        headers: jar.size ? { Cookie: cookieHeader() } : {},
    });
    absorb(response);
    const body = await response.json().catch(() => ({}));
    csrfToken = body?.token ?? '';
    if (!csrfToken) throw new Error(`No CSRF token from /csrf-token (${response.status})`);
}

async function login() {
    await openSession();
    const response = await call('/api/users/login', { handle: HANDLE, password: PASSWORD });
    if (response.status !== 200) {
        throw new Error(`Login failed (${response.status}): ${JSON.stringify(response.body)}`);
    }
    // The session cookie changed on login, so the token bound to the pre-login one is now stale.
    await openSession();
}

/** What the client sees. `dominant` is what actually drives the button.
 * @param {string} chatId The chat the client claims to be looking at — §14.4's whole subject */
async function notifications(chatId) {
    const response = await call(`/api/plugins/notifications?chatId=${encodeURIComponent(chatId)}`, null, 'GET');
    return {
        status: response.status,
        dominant: response.body?.dominant ?? {},
        list: response.body?.notifications ?? [],
        text: response.text,
    };
}

if (!PASSWORD) {
    console.error('\nSet MNEMO_PASSWORD (or GATE5_PASSWORD) to the account password. Never put it in a file.\n');
    process.exit(2);
}

console.log(`\n=== Mnemosyne notification gate against ${BASE} — run marker ${RUN} ===\n`);

try {
    await login();
    console.log('logged in, vault open\n');

    // ── 1. The button can wear a color at all ─────────────────────────────────────────────────────────
    //
    // 🔴 THE SILENT FAILURE, AND THE REASON THIS CHECK IS FIRST. `classifyIcon` in the fork is
    // `/\s/.test(icon) || icon.startsWith('fa-')`, and the client applies a pushed color only when the result is
    // 'class'. Registered as the old '🧠' every notification below still arrives, still validates, still passes —
    // and the button never changes, because an emoji's color lives in the font.
    console.log('1 — the registered icon is colorable');
    const config = await call('/api/plugins/client-config', null, 'GET');
    // Only the three fields this check is about. `iconType` is the fork's own classification of the icon it was
    // registered with, and it is the field the whole gate turns on — see the note above.
    /** @type {Array<{ id?: string, icon?: string, iconType?: string }>} */
    const panels = config.body?.panels ?? [];
    const mine = panels.find(p => p.id === PLUGIN_ID);
    record('the panel is registered', Boolean(mine), mine ? `icon ${JSON.stringify(mine.icon)}` : `saw ${panels.length} panel(s)`);
    record('its icon is a class, not an emoji', mine?.iconType === 'class', `iconType ${JSON.stringify(mine?.iconType)}`);

    // ── 2. Writing a memory pushes purple ──────────────────────────────────────────────────────────────
    console.log('\n2 — a write pushes purple, addressed to this chat');
    const write = await call('/api/plugins/mnemosyne/memory', {
        text: SECRET, tier: 'scenario', chatId: CHAT_HERE, personaId: PERSONA_ID,
    });
    record('the memory stored', write.status === 201, `status ${write.status}`);
    planted = write.body?.id ?? null;

    const here = await notifications(CHAT_HERE);
    const dominant = here.dominant[PLUGIN_ID];
    record('a notification is dominant for this plugin', Boolean(dominant), dominant ? `action ${dominant.action}` : 'none');
    record('the action is memory.added', dominant?.action === 'memory.added', JSON.stringify(dominant?.action));
    record('the color is purple', dominant?.color === 'purple', JSON.stringify(dominant?.color));
    record('it counts one memory', dominant?.data?.count === 1, `count ${JSON.stringify(dominant?.data?.count)}`);
    record('it replaced nothing', dominant?.data?.replaced === 0, `replaced ${JSON.stringify(dominant?.data?.replaced)}`);
    record('it carries a human summary', typeof dominant?.summary === 'string' && dominant.summary.length > 0, JSON.stringify(dominant?.summary));

    // ── 3. The notification channel carries no memory text ─────────────────────────────────────────────
    //
    // 🔴 THE PRIVACY CLAIM, ASSERTED RATHER THAN TRUSTED. Statements are served only by /panel, which cannot
    // answer while the vault is locked; if they leaked into the ungated notification channel as well, that gate
    // would be protecting nothing. Checked against the whole response body, not just `data`.
    console.log('\n3 — the ungated channel quotes no memory');
    record('no memory text anywhere in the notifications payload', !here.text.includes(SECRET));

    // ── 4. It is addressed to the chat it happened in ──────────────────────────────────────────────────
    //
    // §14.4: a memory written while talking to one character must not light the button in a different
    // conversation. Without `chatId` on the notify call it lands in GLOBAL and shows up in every chat.
    console.log('\n4 — another chat is not told about it');
    const elsewhere = await notifications(CHAT_ELSEWHERE);
    record('no notification leaks into a different chat', !elsewhere.dominant[PLUGIN_ID], JSON.stringify(elsewhere.dominant[PLUGIN_ID]?.action));

    // ── 5. The panel says what was remembered ──────────────────────────────────────────────────────────
    console.log('\n5 — the panel names the memory, in the right chat only');
    const panelHere = await call(`/api/plugins/mnemosyne/panel?chatId=${encodeURIComponent(CHAT_HERE)}`, null, 'GET');
    record('the panel renders', panelHere.status === 200, `status ${panelHere.status}`);
    record('the panel names the memory that was added', panelHere.text.includes(SECRET));

    const panelElsewhere = await call(`/api/plugins/mnemosyne/panel?chatId=${encodeURIComponent(CHAT_ELSEWHERE)}`, null, 'GET');
    record('a different chat\'s panel does not', panelElsewhere.status === 200 && !panelElsewhere.text.includes(SECRET), `status ${panelElsewhere.status}`);

    // ── 6. Status agrees with the dominant event ───────────────────────────────────────────────────────
    console.log('\n6 — status reports the same event the color does');
    const status = await call(`/api/plugins/mnemosyne/status?chatId=${encodeURIComponent(CHAT_HERE)}`, null, 'GET');
    record('status is 200', status.status === 200, `status ${status.status}`);
    record('status is active', status.body?.active === true, JSON.stringify(status.body?.active));
    record('its count matches the dominant notification', status.body?.count === dominant?.data?.count, `status ${JSON.stringify(status.body?.count)} vs notification ${JSON.stringify(dominant?.data?.count)}`);
} catch (error) {
    // ⚠️ `{ message?: string }` rather than `Error`: a `catch` binding is `unknown` because JavaScript can
    // throw anything, and the browser gate next door has the receipts for what that costs — its own header
    // records a failure line that read "undefined" because a rejection carried no message. Declaring the
    // message optional is what keeps the `?? error` fallback looking necessary, because it is.
    record('the gate ran to completion', false,
        String(/** @type {{ message?: string }|null|undefined} */ (error)?.message ?? error));
} finally {
    // Teardown runs even on failure: a half-finished run must not leave a memory behind in the account.
    //
    // ⚠️ IN ITS OWN try/catch, like the browser gate's. Unguarded, a network fault during the DELETE threw out
    // of `finally` — which REPLACES the original error, so a run that failed at step 4 reported a cleanup
    // problem instead, and the results summary below never printed at all.
    if (planted !== null) {
        try {
            const gone = await call(`/api/plugins/mnemosyne/memory/${planted}`, null, 'DELETE');
            record('the planted memory was removed', gone.status === 204, `status ${gone.status}`);
        } catch (error) {
            record('the planted memory was removed', false,
                String(/** @type {{ message?: string }|null|undefined} */ (error)?.message ?? error).slice(0, 120));
        }
    }
}

const failed = results.filter(r => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===\n`);
process.exit(failed.length === 0 ? 0 : 1);
