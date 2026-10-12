/* eslint-env browser */
// ^ The callbacks handed to page.evaluate() run in the PAGE, not in Node, so they legitimately reach for
//   `document` and dynamic `import()` of the app's own modules. Lint sees one file and cannot tell the two
//   contexts apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.dirname(path.dirname(here));
const FIXTURE = path.join(serverDirectory, 'tests', 'fixtures', 'depth-anchor-plugin.mjs');

/**
 * 🔴 A PLUGIN MUST DECLARE A WINDOW OR THERE IS NOTHING ON THE WIRE TO ANCHOR (§17.6).
 *
 * The fork ships no default window: `st_recent_messages` is absent unless some plugin asked for turns. A
 * stock boot therefore posts a prompt with no window at all, and every assertion below would fail for a
 * reason that has nothing to do with the depth anchor — which is precisely how the first run of this spec
 * failed. The shim goes in SCRATCH and the server is told to look there, both halves, for the reason
 * `plugin-text-path.e2e.js` records at length: the repository's own `plugins/` holds this install's real
 * plugins, and a suite that boots against it inherits whatever the machine has installed.
 */
const PLUGINS_DIRECTORY = makeScratchDirectory('depth-anchor-plugins');
const SHIM = path.join(PLUGINS_DIRECTORY, 'zz-depth-anchor-e2e.mjs');

/**
 * 🔴 THE DEPTH ANCHOR, MEASURED AGAINST A REAL RENDER (§27).
 *
 * `tests/plugin-depth-anchor.test.js` proves the two ends: the pure locator finds the right occurrence, and
 * the wire carries `promptOffset` through the projection. Neither of them touches the part most likely to be
 * quietly wrong — **the client threading**. Which turn an entry of `mesSend` came from is carried through
 * `chat2` -> `arrMes` (sparse, then unsparsed) -> a reverse -> a shift-off-the-oldest trim -> a
 * `structuredClone`, and every one of those stages is a chance for the number to end up one turn out. An
 * off-by-one there is not a crash: it is a memory block spliced into the middle of a neighbouring message,
 * on a prompt that still looks entirely ordinary.
 *
 * So this drives a REAL generation in a REAL page and reads the bytes off the wire. The backend is stubbed at
 * the browser, not the server, so the request that gets captured is byte-for-byte the one SillyTavern would
 * have posted to a model host.
 *
 * ⚠️ THE SEEDED CHAT REPEATS ITSELF ON PURPOSE. Two "Okay." turns and two "Go on." turns are what a forward
 * search would collapse onto one offset, and a fixture of distinct messages would pass either way.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

/**
 * 🔴 ONE SEEDED CHAT PER TEST, BECAUSE A GENERATION IS A WRITE.
 *
 * These tests run serially against one server, and each of them sends a message and receives a stubbed
 * reply — which SillyTavern persists to the chat's JSONL, exactly as it would for a user. Sharing a chat
 * therefore hands the second test a nine-message conversation and the third a ten-message one, so the
 * fixture's deliberate repeats ("Okay." twice, "Go on." twice) stop being what the test was written
 * against. The first run failed on precisely that. A chat each is cheaper than re-seeding between tests
 * and cannot race the server's own writes.
 */
const CHAT_NAMES = [
    'depth-anchor-chat-a', 'depth-anchor-chat-b', 'depth-anchor-chat-c', 'depth-anchor-chat-d', 'depth-anchor-chat-e',
    'depth-anchor-chat-f', 'depth-anchor-chat-g',
];

test.describe('the depth anchor on a real generation (front-end)', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let characterName;

    /**
     * The seeded conversation. Deliberately repetitive — see the note above.
     * @param {string} name The character's name
     * @returns {object[]} The JSONL lines
     */
    function buildChat(name) {
        const when = new Date('2026-08-25T00:00:00.000Z').toISOString();
        const turns = [
            [false, 'The lantern gutters and goes out.'],
            [true, 'Okay.'],
            [false, 'Something moves in the dark.'],
            [true, 'Go on.'],
            [false, 'It is only the wind against the shutters.'],
            [true, 'Okay.'],
            [false, 'The wind rises, and the shutters give.'],
            [true, 'Go on.'],
        ];

        return [
            { user_name: 'User', character_name: name, create_date: when, chat_metadata: {} },
            ...turns.map(([isUser, mes]) => ({
                name: isUser ? 'User' : name,
                is_user: isUser,
                is_system: false,
                send_date: when,
                mes,
                extra: {},
            })),
        ];
    }

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('depth-anchor-e2e');
        const dataRoot = path.join(scratch, 'data');

        fs.writeFileSync(SHIM, `export { info, init } from ${JSON.stringify(new URL(`file:///${FIXTURE.split(path.sep).join('/')}`).href)};\n`, 'utf-8');

        server = await startSillyTavern({
            dataRoot,
            configPath: path.join(scratch, 'config.yaml'),
            pluginsPath: PLUGINS_DIRECTORY,
            providerEnv: {
                SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
                ST_FIXTURE_IDS: 'depth-anchor',
            },
        });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;

        // 🔴 STEP PAST ONBOARDING, OR NOTHING BELOW RUNS — a fresh data root is a first run, and
        // `getSettings()` ends at `doOnboarding()`, which waits for a human that headless never sends.
        await stepPastFirstRun(dataRoot);

        const avatar = fs.readdirSync(path.join(dataRoot, 'default-user', 'characters')).find(n => n.endsWith('.png'));
        if (!avatar) {
            throw new Error('The data root shipped no character, so there is nothing to hang a chat on.');
        }
        characterName = path.parse(avatar).name;

        const chatsDirectory = path.join(dataRoot, 'default-user', 'chats', characterName);
        fs.mkdirSync(chatsDirectory, { recursive: true });
        for (const name of CHAT_NAMES) {
            fs.writeFileSync(
                path.join(chatsDirectory, `${name}.jsonl`),
                buildChat(characterName).map(line => JSON.stringify(line)).join('\n'),
                'utf-8',
            );
        }
    });

    test.afterAll(async () => {
        if (server) await server.stop();
    });

    /**
     * Open the seeded chat with the shipped character selected, and put the client on the text path.
     * @param {import('@playwright/test').Page} page Page under test
     * @param {string} chatName Which of the seeded chats to open — one per test, see CHAT_NAMES
     * @returns {Promise<void>} When the chat is loaded and the client believes it is connected
     */
    async function openSeededChat(page, chatName) {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });

        // `getContext()` throws during early boot (a TDZ on script.js's module bindings), so the poll has to
        // swallow that and retry rather than reject.
        await page.waitForFunction(() => {
            try {
                return !!globalThis.SillyTavern?.getContext()?.characters?.length;
            } catch {
                return false;
            }
        }, null, { timeout: 60_000 });

        await page.evaluate(async (chatName) => {
            const context = globalThis.SillyTavern.getContext();
            await context.selectCharacterById(0);
            await context.openCharacterChat(chatName);
        }, chatName);

        await expect(page.locator('#chat .mes')).toHaveCount(8, { timeout: 30_000 });

        // 🔴 THE DECLARATION HAS TO HAVE LANDED, OR EVERY ASSERTION BELOW IS VACUOUS. `getRecentMessagesWindow()`
        // fails safe to 0 when the client-config carries no `prompts` entry, and a 0 window means no
        // `st_recent_messages` at all — which reads as "the anchor is broken" when it means "the fixture never
        // registered".
        await expect.poll(async () => await page.evaluate(async () => {
            const { getRecentMessagesWindow } = await import('/scripts/plugin-client-config.js');
            return getRecentMessagesWindow();
        }), { timeout: 30_000, message: 'The depth-anchor fixture never reached the client, so no window was declared.' }).toBe(20);

        // The text path, with the client believing it has a backend. `page.route` answers the POST, so no
        // model host is involved and none needs to be reachable — but `Generate` refuses to send while
        // `online_status` is `no_connection`, which is the honest gate and not one to bypass another way.
        await page.evaluate(async () => {
            const script = await import('/script.js');
            const { textgenerationwebui_settings } = await import('/scripts/textgen-settings.js');

            textgenerationwebui_settings.server_urls[textgenerationwebui_settings.type] = 'http://127.0.0.1:1/stub';
            textgenerationwebui_settings.streaming = false;

            script.changeMainAPI('textgenerationwebui');
            script.setOnlineStatus('stub-model');
        });
    }

    /**
     * Send a message and hand back the request body SillyTavern actually posted.
     * @param {import('@playwright/test').Page} page Page under test
     * @param {string} text What the user types
     * @returns {Promise<any>} The parsed POST body
     */
    async function captureGeneration(page, text) {
        /** @type {any} */
        let captured = null;

        await page.route('**/api/backends/text-completions/generate**', async (route) => {
            captured = JSON.parse(route.request().postData() ?? 'null');
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ text: ' The shutters burst inward.' }] }),
            });
        });

        await page.locator('#send_textarea').fill(text);
        await page.locator('#send_but').click();

        await expect.poll(() => captured !== null, {
            timeout: 60_000,
            message: 'SillyTavern never posted a text completion, so there is nothing to read the anchor off.',
        }).toBe(true);

        return captured;
    }

    test('🔴 every anchored turn points at its OWN text in the prompt that is actually sent', async ({ page }) => {
        await openSeededChat(page, CHAT_NAMES[0]);

        const body = await captureGeneration(page, 'And then?');
        const window = body?.st_recent_messages;

        // If this fails the rest is vacuous: there is no window, so there is nothing to anchor.
        expect(Array.isArray(window)).toBe(true);
        expect(window.length).toBeGreaterThanOrEqual(8);
        expect(typeof body.prompt).toBe('string');

        // 🔴 THE CONTRACT: present on every turn of a rendered path, even when it is -1.
        for (const turn of window) {
            expect(Number.isInteger(turn.promptOffset)).toBe(true);
            expect(turn.promptOffset).toBeGreaterThanOrEqual(-1);
        }

        const anchored = window.filter(turn => turn.promptOffset >= 0);

        // Every turn of a seeded eight-message chat fits a default context, so every one of them should have
        // been placed. A -1 here means the threading lost a turn, not that the prompt was trimmed.
        expect(anchored.length).toBe(window.length);

        for (const turn of anchored) {
            // The offset is the start of the RENDERED turn — the name prefix and instruct framing come first,
            // then the content — so the content sits just after it, not exactly on it.
            const fromHere = body.prompt.slice(turn.promptOffset, turn.promptOffset + 400);
            expect(fromHere).toContain(turn.content);
        }
    });

    test('🔴 IDENTICAL TURNS GET DIFFERENT OFFSETS — the off-by-one this fixture exists to catch', async ({ page }) => {
        await openSeededChat(page, CHAT_NAMES[1]);

        const body = await captureGeneration(page, 'Keep going.');
        const window = body.st_recent_messages.filter(turn => turn.promptOffset >= 0);

        // Ascending, strictly. Two turns sharing an offset is a forward search collapsing repeats; a
        // descending pair is the reverse in `arrMes` not being carried through.
        const offsets = window.map(turn => turn.promptOffset);
        expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
        expect(new Set(offsets).size).toBe(offsets.length);

        // And specifically the repeats, named, so a failure says which pair collapsed.
        const okays = window.filter(turn => turn.content === 'Okay.').map(turn => turn.promptOffset);
        const goOns = window.filter(turn => turn.content === 'Go on.').map(turn => turn.promptOffset);
        expect(okays.length).toBe(2);
        expect(goOns.length).toBe(2);
        expect(okays[0]).toBeLessThan(okays[1]);
        expect(goOns[0]).toBeLessThan(goOns[1]);
    });

    test('🔴 splicing at the last turn\'s offset leaves everything above it byte-identical', async ({ page }) => {
        await openSeededChat(page, CHAT_NAMES[2]);

        const body = await captureGeneration(page, 'What now?');
        const window = body.st_recent_messages;
        const last = window.at(-1);

        expect(last.promptOffset).toBeGreaterThan(0);

        // This is exactly what a memory plugin does with the number, and the property it is buying: the
        // prefix is untouched, so a backend's KV cache still matches on all of it, and the block lands below
        // the history rather than in front of it.
        const injected = `${body.prompt.slice(0, last.promptOffset)}[MEMORY BLOCK]\n${body.prompt.slice(last.promptOffset)}`;

        expect(injected.startsWith(body.prompt.slice(0, last.promptOffset))).toBe(true);
        expect(injected).toContain('[MEMORY BLOCK]\n');
        // The last turn survives whole, immediately after the block — not cut in half by it, which is what an
        // offset one character out would do and what nothing downstream would ever report.
        expect(injected.slice(injected.indexOf('[MEMORY BLOCK]\n') + '[MEMORY BLOCK]\n'.length)).toContain(last.content);

        // And the block really is below the history: the second-to-last turn is still above it.
        const previous = window.at(-2);
        expect(injected.indexOf(previous.content)).toBeLessThan(injected.indexOf('[MEMORY BLOCK]'));
    });

    /**
     * 🔴 A STREAMED GENERATION IS STILL A GENERATION — AND ON TWO BACKENDS A SERVER PLUGIN WAS SHOWN A BARE ONE.
     *
     * `sendStreamingRequest` has four senders. Two of them — Kobold Classic and NovelAI — posted plain
     * `getRequestHeaders()` and the bare body: no character, chat, persona or generation kind in the headers
     * (§16, §18, §22) and no `st_recent_messages` (§17). The non-streaming sender sent all of it, and the two
     * server routes' own comments said the client always did, so nothing looked wrong from either end. A
     * memory plugin on those paths did not know whose chat it was in, placed its block at the front of the
     * prompt and never learned anything. Found 2026-10-10 from the plugin side.
     *
     * So this reads the request off the wire for each of them, on a real generation with streaming on.
     */
    for (const [api, url, chatName] of /** @type {const} */ ([
        ['kobold', '**/api/backends/kobold/generate**', CHAT_NAMES[3]],
        ['novel', '**/api/novelai/generate**', CHAT_NAMES[4]],
    ])) {
        test(`🔴 a streamed ${api} generation carries the window and says whose chat it is`, async ({ page }) => {
            await openSeededChat(page, chatName);

            await page.evaluate(async (api) => {
                const script = await import('/script.js');

                if (api === 'kobold') {
                    const { kai_settings, kai_flags } = await import('/scripts/kai-settings.js');
                    kai_settings.streaming_kobold = true;
                    // What a status check against a new enough KoboldCpp sets; no model host exists here.
                    kai_flags.can_use_streaming = true;
                } else {
                    const { nai_settings } = await import('/scripts/nai-settings.js');
                    nai_settings.streaming_novel = true;
                }

                script.changeMainAPI(api);
                script.setOnlineStatus('stub-model');
            }, api);

            /** @type {{headers: Record<string, string>, body: any}|null} */
            let captured = null;

            await page.route(url, async (route) => {
                captured = { headers: route.request().headers(), body: JSON.parse(route.request().postData() ?? 'null') };
                await route.fulfill({
                    status: 200,
                    contentType: 'text/event-stream',
                    body: 'data: {"token":" The shutters burst inward."}\n\n',
                });
            });

            // ⚠️ SENT FROM INSIDE THE PAGE, NOT TYPED INTO THE MESSAGE BOX. Run after the three tests above,
            // `fill()` on `#send_textarea` left the box empty here — no code set its value, the text simply
            // never landed, which is what a keystroke going to another focused element looks like once the
            // API panel has been switched. The click then generated a reply to the chat as it stood, with no
            // new user turn, and the assertions below were about a message that was never sent (2026-10-10).
            // What is under test is the request a generation posts, so the turn is added the way the send
            // button adds it and the generation is started directly.
            await page.evaluate(async () => {
                const script = await import('/script.js');
                await script.sendMessageAsUser('And then?', '');
                void script.Generate('normal');
            });

            await expect.poll(() => captured !== null, {
                timeout: 60_000,
                message: `SillyTavern never posted a streamed ${api} generation, so there is nothing to read.`,
            }).toBe(true);

            const { headers, body } = /** @type {{headers: Record<string, string>, body: any}} */ (captured);

            // If this fails the test proved nothing: the request that was captured was not a streamed one.
            expect(body.streaming).toBe(true);

            // The window, ending on what the user just typed.
            expect(Array.isArray(body.st_recent_messages)).toBe(true);
            expect(body.st_recent_messages.length).toBeGreaterThanOrEqual(8);
            expect(body.st_recent_messages.at(-1).content).toBe('And then?');
            expect(body.st_recent_messages.at(-1).role).toBe('user');

            // And whose chat it is. Header names arrive lower-cased; values are URL-encoded by the client.
            expect(decodeURIComponent(headers['x-st-chat-id'])).toBe(chatName);
            // ⚠️ `characterName` is the card's FILE stem, which is what names the avatar; the display name is
            // the card's own and only has to be there.
            expect(decodeURIComponent(headers['x-st-char-avatar'])).toBe(`${characterName}.png`);
            expect(headers['x-st-char-name']).toBeTruthy();
            expect(headers['x-st-gen-type']).toBe('normal');
        });
    }

    /**
     * 🔴 A BACKGROUND GENERATION HAS TO SAY IT IS ONE, ON EVERY BACKEND.
     *
     * `generateRaw` is what the built-in extensions call for a summary, an image prompt or an expression pick.
     * Its OpenAI branch has always sent `X-ST-Gen-Type: quiet`. The branch for the other three backends sent
     * plain `getRequestHeaders()`, so the same request arrived with no kind at all — which §18.2 defines as an
     * ordinary user-facing generation. A memory plugin told to stay out of background requests could keep that
     * promise on Chat Completion and nowhere else (2026-10-10).
     *
     * ⚠️ And it carries NO window. A raw generation is not a turn of the conversation, and the absence is the
     * other half of how a plugin tells: only `Generate()` builds `st_recent_messages`.
     */
    test('🔴 a raw generation on the text path is labelled quiet, and carries no window', async ({ page }) => {
        await openSeededChat(page, CHAT_NAMES[5]);

        /** @type {{headers: Record<string, string>, body: any}|null} */
        let captured = null;

        await page.route('**/api/backends/text-completions/generate**', async (route) => {
            captured = { headers: route.request().headers(), body: JSON.parse(route.request().postData() ?? 'null') };
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ choices: [{ text: ' A storm, and a broken shutter.' }] }),
            });
        });

        const summary = await page.evaluate(async () => {
            const script = await import('/script.js');
            return await script.generateRaw({ prompt: 'Summarize the scene in one line.' });
        });

        // The stubbed reply came back, so the request that was captured is the one `generateRaw` made.
        expect(summary).toContain('broken shutter');
        expect(captured).not.toBeNull();

        const { headers, body } = /** @type {{headers: Record<string, string>, body: any}} */ (captured);

        expect(headers['x-st-gen-type']).toBe('quiet');
        expect(decodeURIComponent(headers['x-st-chat-id'])).toBe(CHAT_NAMES[5]);
        expect(body).not.toHaveProperty('st_recent_messages');
    });

    /**
     * 🔴 ONE DROPPED REQUEST AT STARTUP MUST NOT COST THE WINDOW FOR THE WHOLE SESSION.
     *
     * The client learns how many turns to send from `/api/plugins/client-config`, once, at startup. The promise
     * was memoized whatever became of it, so a request that failed answered "nobody asked" until the page was
     * reloaded and every reply went out with no window. That used to cost a memory plugin its ingest. It now
     * costs it everything: a reply with no window cannot be told from a background request (2026-10-10).
     */
    test('🔴 a startup config request that fails is asked again, and the window arrives', async ({ page }) => {
        let requests = 0;

        await page.route('**/api/plugins/client-config', async (route) => {
            requests += 1;

            if (requests === 1) {
                await route.abort();
                return;
            }

            await route.continue();
        });

        // `openSeededChat` waits for the declared window to reach the client. With the failure remembered it
        // never does, and this times out there; that wait is the assertion.
        await openSeededChat(page, CHAT_NAMES[6]);

        expect(requests).toBeGreaterThan(1);
    });

});
