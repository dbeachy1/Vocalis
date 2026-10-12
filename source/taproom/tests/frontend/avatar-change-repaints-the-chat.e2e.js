/* eslint-env browser */
// ^ Callbacks handed to page.evaluate() run in the PAGE, not in Node. Lint sees one file and cannot
//   tell the two contexts apart.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { test, expect } from '@playwright/test';

import { makeScratchDirectory, startSillyTavern, stepPastFirstRun } from '../util/st-server.js';

/*
 * 🔴 CHANGING A CHARACTER'S PICTURE LEFT THE OPEN CHAT WEARING THE OLD ONE.
 *
 * Saving a character's avatar must repaint matching images in the open chat. Round avatars use
 * `/thumbnail/face` rather than the legacy `/thumbnail` URL, so the old selector no longer matched them.
 *
 * ⚠️ AND A CORRECTION, KEPT HERE BECAUSE THE TEST BELOW WAS WRITTEN FOR THE WRONG REASON. This
 * comment used to claim that the old repaint's technique — blank `img.src`, put it back — fires an
 * `error` event, which a message avatar answers by replacing the `<img>` with the `missing-avatar`
 * placeholder for good, and therefore that pointing the old selector at the right URL would have
 * destroyed every avatar in the chat. That was reasoned from the spec and never measured. Measured,
 * it is false: the synchronous reassignment aborts the empty load before its error task runs, and
 * Chromium fires `load`. The technique works.
 *
 * `the avatar survives the repaint` stays, because a repaint that leaves an element broken is worth
 * asserting whatever the mechanism, and because it earned its keep immediately — it caught a fixture
 * that seeded the persona into `avatars/` instead of `User Avatars/`, which 404'd the thumbnail and
 * would otherwise have let the persona test pass on an avatar that never loaded.
 *
 * ## Why the picture is read out of a canvas
 *
 * Asserting on the `src` attribute proves only that a string changed. The complaint is about pixels
 * — the chat showing a picture that is no longer on disk — so the test samples what the browser
 * actually decoded and drew. A solid magenta upload makes that unambiguous against Seraphina's
 * portrait, and the BEFORE sample is load-bearing: "the avatar is magenta" passes for free if the
 * fixture never had a different avatar to begin with.
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

/**
 * CRC-32 table, for the PNG chunk checksums below.
 * @type {Int32Array}
 */
const CRC_TABLE = (() => {
    const table = new Int32Array(256);

    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c;
    }

    return table;
})();

/**
 * CRC-32 of a buffer, as PNG defines it.
 * @param {Buffer} buffer Bytes to check
 * @returns {number} The checksum
 */
function crc32(buffer) {
    let c = 0xFFFFFFFF;

    for (const byte of buffer) {
        c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
    }

    return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Encodes a solid-colour PNG.
 *
 * ⚠️ WRITTEN OUT RATHER THAN ASKED OF JIMP. The server's own encoder is `@jimp/wasm-png`, and its
 * wasm module refuses to initialise inside the Playwright runner — `Error: not implemented... yet...`
 * out of `__wbg_init`. A fixture image is thirty lines of deflate and four chunks; carrying a wasm
 * dependency into the test process to draw one rectangle is the worse trade.
 * @param {number} width Image width
 * @param {number} height Image height
 * @param {[number, number, number]} rgb Colour to fill with
 * @returns {Buffer} PNG bytes
 */
function solidColourPng(width, height, [r, g, b]) {
    const stride = width * 3 + 1;
    const raw = Buffer.alloc(stride * height);

    for (let y = 0; y < height; y++) {
        const row = y * stride;
        raw[row] = 0; // Filter type: none.

        for (let x = 0; x < width; x++) {
            raw[row + 1 + x * 3] = r;
            raw[row + 2 + x * 3] = g;
            raw[row + 3 + x * 3] = b;
        }
    }

    /**
     * @param {string} type Four-character chunk type
     * @param {Buffer} data Chunk payload
     * @returns {Buffer} The framed chunk
     */
    const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length, 0);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(crc32(body), 0);
        return Buffer.concat([length, body, checksum]);
    };

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;  // Bit depth.
    header[9] = 2;  // Colour type: truecolour.

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** The chat the character is sitting in when the avatar changes. */
const CHAT_NAME = 'avatar-repaint-fixture';

/** The colour uploaded over the shipped portrait. Nothing in a real card is this. */
const MAGENTA = { r: 255, g: 0, b: 255 };

/** The character list's copy of the same avatar, rendered from the same face URL. */
const LIST_AVATAR = '#rm_print_characters_block .character_select .avatar';

/** The persona whose picture the second half of this spec changes. */
const PERSONA_FILE = 'persona-fixture.png';

/** What that persona starts out as, so "it turned magenta" is a change and not the initial state. */
const BLUE = { r: 0, g: 0, b: 255 };

/** The user message's avatar in the seeded chat — a `persona-face` thumbnail, not a character one. */
const USER_AVATAR = '#chat .mes[is_user="true"] .avatar img';

test.describe('Avatar change: the open chat repaints', () => {
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let characterName;
    /** @type {string} */
    let replacementPath;

    /**
     * A two-message chat, so the card save does NOT rebuild it for free.
     *
     * ⚠️ ONE MESSAGE WOULD HIDE THE BUG ENTIRELY. `createOrEditCharacter` regenerates the greeting
     * and reloads the chat when it holds nothing but an untouched first message — which repaints
     * every avatar as a side effect. A chat that has been used is the case that requires an explicit repaint
     * where the repaint has to do its own job.
     * @param {string} name Character name
     * @returns {object[]} Chat file lines
     */
    function buildChat(name) {
        return [
            { user_name: 'User', character_name: name, create_date: new Date().toISOString(), chat_metadata: {} },
            { name: name, is_user: false, is_system: false, send_date: new Date().toISOString(), mes: 'Hello there.', extra: {} },
            { name: 'User', is_user: true, is_system: false, send_date: new Date().toISOString(), mes: 'Hello yourself.', extra: {} },
        ];
    }

    /**
     * The colour the browser has actually drawn for the first message avatar.
     *
     * Sampled from the centre through a canvas rather than read off the `src`, because a repaint
     * that changes the URL and loads the same cached bytes is exactly the failure being ruled out.
     * @param {import('@playwright/test').Page} page Page under test
     * @param {string} [selector] Which avatar to sample; defaults to the first message's
     * @returns {Promise<{r: number, g: number, b: number, src: string, missing: boolean}>} What is on screen
     */
    function readAvatarPixel(page, selector = '#chat .mes .avatar img') {
        return page.evaluate((where) => {
            const img = /** @type {HTMLImageElement} */ (document.querySelector(where));

            if (!img) {
                return { r: -1, g: -1, b: -1, src: '', missing: !!document.querySelector('#chat .mes .missing-avatar') };
            }

            if (!img.complete || !img.naturalWidth) {
                return { r: -1, g: -1, b: -1, src: img.getAttribute('src') ?? '', missing: false };
            }

            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            const context = canvas.getContext('2d');
            // The centre of the image, scaled down to the single pixel being read.
            context.drawImage(img, Math.floor(img.naturalWidth / 4), Math.floor(img.naturalHeight / 4), Math.floor(img.naturalWidth / 2), Math.floor(img.naturalHeight / 2), 0, 0, 1, 1);
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data;

            return { r, g, b, src: img.getAttribute('src') ?? '', missing: false };
        }, selector);
    }

    /**
     * Whether a sampled pixel is the given colour.
     *
     * Loose, because the thumbnail is re-encoded as JPEG on the way out and a flat colour comes back
     * a few values off.
     * @param {{r: number, g: number, b: number}} pixel Sampled pixel
     * @param {{r: number, g: number, b: number}} colour Colour to compare against
     * @returns {boolean} True if the pixel is that colour
     */
    function isColour(pixel, colour) {
        return Math.abs(pixel.r - colour.r) < 24 && Math.abs(pixel.g - colour.g) < 24 && Math.abs(pixel.b - colour.b) < 24;
    }

    /**
     * Whether a sampled pixel is the uploaded magenta.
     * @param {{r: number, g: number, b: number}} pixel Sampled pixel
     * @returns {boolean} True if this is the new picture
     */
    function isMagenta(pixel) {
        return isColour(pixel, MAGENTA);
    }

    /**
     * Opens the seeded chat with the shipped character selected.
     * @param {import('@playwright/test').Page} page Page under test
     * @returns {Promise<void>} When the first message avatar has loaded
     */
    async function openSeededChat(page) {
        await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });

        // `getContext()` throws during early boot (a TDZ on script.js's module bindings), so the poll
        // has to swallow that and retry rather than reject.
        await page.waitForFunction(() => {
            try {
                return !!globalThis.SillyTavern?.getContext()?.characters?.length;
            } catch {
                return false;
            }
        }, null, { timeout: 60_000 });

        await page.evaluate(async () => {
            await globalThis.SillyTavern.getContext().selectCharacterById(0);
        });

        await page.evaluate(async (chatName) => {
            await globalThis.SillyTavern.getContext().openCharacterChat(chatName);
        }, CHAT_NAME);

        await expect(page.locator('#chat .mes .avatar img').first()).toBeAttached({ timeout: 30_000 });
        await page.waitForFunction(() => {
            const img = /** @type {HTMLImageElement} */ (document.querySelector('#chat .mes .avatar img'));
            return !!img && img.complete && img.naturalWidth > 0;
        }, null, { timeout: 30_000 });
    }

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const scratch = makeScratchDirectory('avatar-repaint-e2e');
        dataRoot = path.join(scratch, 'data');

        server = await startSillyTavern({
            dataRoot,
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!server.listening) {
            throw new Error(`Boot failed.\n\n${server.output()}`);
        }
        base = `http://127.0.0.1:${server.port}`;

        // 🔴 STEP PAST ONBOARDING, OR NOTHING BELOW RUNS — a fresh data root is a first run, and
        // `getSettings()` ends at `doOnboarding()`, which waits for a human that headless never sends.
        const settingsFiles = await stepPastFirstRun(dataRoot);

        // A persona of our own, blue, and selected — the shipped default is `img/user-default.png`,
        // which is not a thumbnail URL at all, so a fresh data root has no `persona-face` avatar on
        // screen to go stale. Seeded on disk rather than uploaded so the chat renders it on first paint.
        // ⚠️ `User Avatars`, with the space — that is what `directories.avatars` resolves to
        //    (src/constants.js). Seeding `avatars/` instead 404s the thumbnail, which the
        //    `missing-avatar` assertion in the test below caught rather than passing vacuously.
        const avatarsDirectory = path.join(dataRoot, 'default-user', 'User Avatars');
        fs.mkdirSync(avatarsDirectory, { recursive: true });
        fs.writeFileSync(path.join(avatarsDirectory, PERSONA_FILE), solidColourPng(512, 512, [BLUE.r, BLUE.g, BLUE.b]));

        for (const file of settingsFiles) {
            const settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
            settings.user_avatar = PERSONA_FILE;
            fs.writeFileSync(file, JSON.stringify(settings, null, 4), 'utf-8');
        }

        const avatar = fs.readdirSync(path.join(dataRoot, 'default-user', 'characters')).find(n => n.endsWith('.png'));
        if (!avatar) {
            throw new Error('The data root shipped no character, so there is nothing to hang a chat on.');
        }
        characterName = path.parse(avatar).name;

        const chatsDirectory = path.join(dataRoot, 'default-user', 'chats', characterName);
        fs.mkdirSync(chatsDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(chatsDirectory, `${CHAT_NAME}.jsonl`),
            buildChat(characterName).map(line => JSON.stringify(line)).join('\n'),
            'utf-8',
        );

        // Tall enough that the square crop has real pixels to take, and flat enough that one sample
        // describes the whole image.
        replacementPath = path.join(scratch, 'magenta-avatar.png');
        fs.writeFileSync(replacementPath, solidColourPng(512, 768, [MAGENTA.r, MAGENTA.g, MAGENTA.b]));
    });

    test.afterAll(async () => {
        if (server) await server.stop();
    });

    test('the chat shows the new picture without a reload', async ({ page }) => {
        await openSeededChat(page);

        const before = await readAvatarPixel(page);

        // The fixture has to start out square-cropped and NOT magenta, or the assertion below passes
        // for reasons that have nothing to do with the repaint.
        expect(before.src).toContain('/thumbnail/face');
        expect(isMagenta(before)).toBe(false);

        // The crop dialog waits for a human. Turning it off is what the setting is for, and it is the
        // same `read_avatar_load` path either way.
        await page.evaluate(() => {
            globalThis.SillyTavern.getContext().powerUserSettings.never_resize_avatars = true;
        });

        await page.locator('#add_avatar_button').setInputFiles(replacementPath);

        await expect.poll(async () => isMagenta(await readAvatarPixel(page)), {
            timeout: 45_000,
            message: 'The message avatar never picked up the new picture. This is the bug: the repaint after a card save only knew the rectangular thumbnail URL.',
        }).toBe(true);

        // The character list is built from the same face URL and can be equally stale. Asserting it
        // here verifies every copy on the page, not just the open chat.
        const inList = await readAvatarPixel(page, `${LIST_AVATAR} img`);
        expect(inList.src).toContain('/thumbnail/face');
        expect(isMagenta(inList)).toBe(true);
    });

    test('the avatar survives the repaint', async ({ page }) => {
        // The previous test left the card magenta; this one is about the ELEMENT, not the colour.
        await openSeededChat(page);

        const shown = await readAvatarPixel(page);
        expect(shown.missing).toBe(false);
        expect(isMagenta(shown)).toBe(true);

        await page.evaluate(async () => {
            const context = globalThis.SillyTavern.getContext();
            context.powerUserSettings.never_resize_avatars = true;
        });

        await page.locator('#add_avatar_button').setInputFiles(replacementPath);

        await expect.poll(async () => (await readAvatarPixel(page)).src, { timeout: 45_000 })
            .toContain('/thumbnail/face');

        // A repaint must not leave an avatar in the state the error handler answers by replacing the
        // <img> with this placeholder — whatever would have caused it. See the correction up top.
        await expect(page.locator('#chat .mes .missing-avatar')).toHaveCount(0);
        await expect(page.locator('#chat .mes .avatar img').first()).toBeAttached();
    });

    test('a persona picture reaches the chat the same way', async ({ page }) => {
        // 🔴 THE SAME GAP EXISTED FOR PERSONAS, IN BOTH OF THEIR CACHE-BUST SITES: they primed
        // `/thumbnail?type=persona`, while every persona avatar on screen is `persona-face`. The
        // character path above shares the helper but not the `kind` branch, and an untested branch
        // is a branch that is wrong exactly as often as it is unread.
        await openSeededChat(page);

        const before = await readAvatarPixel(page, USER_AVATAR);
        expect(before.src).toContain('type=persona-face');
        expect(isColour(before, BLUE)).toBe(true);

        await page.evaluate(() => {
            globalThis.SillyTavern.getContext().powerUserSettings.never_resize_avatars = true;
        });

        // ⚠️ DISPATCHED, NOT CLICKED. This is the app's own handler — it is what fills in
        // `#avatar_upload_overwrite`, which is the difference between replacing this persona and
        // creating a new one — but the button lives in a drawer that is closed, and opening the
        // persona panel is not what is under test. The file then arrives through the real input the
        // handler would have opened a picker for.
        await page.locator('#persona_set_image_button').dispatchEvent('click');
        await page.locator('#avatar_upload_file').setInputFiles(replacementPath);

        await expect.poll(async () => isMagenta(await readAvatarPixel(page, USER_AVATAR)), {
            timeout: 45_000,
            message: 'The user message avatar never picked up the new persona picture.',
        }).toBe(true);

        // Same check as the character half, and the one that caught the `User Avatars` fixture bug.
        await expect(page.locator('#chat .mes .missing-avatar')).toHaveCount(0);
    });

    test('the new picture is what the server had all along', async ({ page }) => {
        // A fresh page and request rule out a stale cache primed by the save.
        await openSeededChat(page);

        const afterReload = await readAvatarPixel(page);
        expect(isMagenta(afterReload)).toBe(true);
    });
});
