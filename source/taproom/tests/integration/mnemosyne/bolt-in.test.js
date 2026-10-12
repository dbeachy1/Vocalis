import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { DEPENDENCIES, preflight, serverDirectory } from '../preflight.mjs';
import {
    chatBody,
    collectFiles,
    findMarker,
    get,
    getChat,
    login,
    makeMarker,
    prepareDataRoot,
    saveChat,
    shareModelCache,
    startServer,
} from '../harness.mjs';

/**
 * 🔗 SUITE B, FIRST LIGHT — the fork, the real Vault and the real Mnemosyne, all three at once.
 *
 * Nothing in any of the three repositories has ever booted this arrangement. Vault does not know
 * Mnemosyne exists; Mnemosyne does not know Vault's key management exists; the fork is the only place
 * that imports both concepts, which is why the plan puts these suites here.
 *
 * 🔴 THE ASSERTION THAT MATTERS MOST IN THIS FILE IS THE LAST ONE, AND IT IS NOT ABOUT MNEMOSYNE.
 * `PLAN_INTEGRATION_TESTS.md` §7 B1: everything Suite A proved must STILL be true with the plugin
 * installed. A plugin runs in-process, after unlock, holding a key derived from the user's — it is
 * exactly the component that could quietly write a plaintext copy of a conversation next to the
 * encrypted one, and no test in Suite A would notice, because Suite A boots without it.
 *
 * So the same marker, the same leak detector, and the same round trip as `vault/chat-at-rest.test.js`
 * are run again here with Mnemosyne loaded. Duplication on purpose: the point is not that the check
 * exists, it is that it is made in this configuration.
 */

/**
 * The two lines Mnemosyne's `warmUpEmbeddings` can END on. One of them must eventually appear, and
 * which one it is IS §7 B2's third clause.
 */
const WARM_UP_SETTLED = /\[Mnemosyne\] Embedding model ready|\[Mnemosyne\] Could not warm the embedding model/;

/**
 * Waits until the boot warm-up has settled, then returns everything the server has written.
 *
 * ⚠️ Warming is deliberately FIRE-AND-FORGET — Mnemosyne must not await it, because the fork awaits
 * `init()` inside its plugin-boot loop and a model download would otherwise stall the whole server's
 * boot. So unlike everything else in this file, the warm-up is NOT finished when the server is
 * listening, and reading the output at that moment would assert on a race. This gives it a bounded
 * window instead.
 *
 * On timeout it returns the output anyway rather than throwing, so the caller fails as a readable
 * assertion — "the ready line never came" — instead of as a bare Jest timeout with nothing in it.
 *
 * @param {any} server The running server handle
 * @param {number} timeoutMs How long to allow; generous, because a cold model cache downloads ~100 MB
 * @returns {Promise<string>} Everything the server wrote to stdout and stderr
 */
async function waitForWarmUp(server, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const output = server.output();

        if (WARM_UP_SETTLED.test(output)) {
            return output;
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }

    return server.output();
}

const CHARACTER = makeMarker('SuiteBCharacter');
const PERSONA = 'Test User';
const CHAT_FILE = 'the-mnemosyne-chat';
const MARKER = makeMarker('SUITE-B-CHAT-SECRET');
const USER_LINE = `Remember this exactly: ${MARKER}`;

const gate = preflight('suite B — fork + Vault + Mnemosyne', [DEPENDENCIES.vault, DEPENDENCIES.mnemosyne]);
const suite = gate.run ? describe : describe.skip;

suite('🧠 the fork boots with the real Vault AND the real Mnemosyne', () => {
    /** @type {any} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let bootOutput = '';

    /** What `GET /api/plugins/mnemosyne/status` answered. */
    let status;
    /** The registry the browser reads to find out which plugins registered what. */
    let clientConfig;
    /** The chat as the app handed it back, with the plugin loaded. */
    let readBack;
    /** Leaks found in the whole scratch tree with all three components running. */
    let leaks = [];

    beforeAll(async () => {
        const prepared = await prepareDataRoot('integration-mnemosyne-bolt-in');

        scratch = prepared.scratch;
        dataRoot = prepared.dataRoot;

        // The embedding model is ~100 MB and every test gets a fresh data root, so without this the
        // model is downloaded again on every single run. See the note on `shareModelCache`.
        shareModelCache(dataRoot);

        const boot = await startServer({
            ...prepared,
            withVault: true,
            // ⚠️ The repository's REAL `plugins/`, for the same reason Suite A uses the real
            // `storage-providers/`: it is the layout a deployment resolves, and a suite that invented a
            // different one would be asserting on an arrangement that never ships.
            pluginsPath: path.join(serverDirectory, 'plugins'),
        });

        server = boot.server;
        base = boot.base;

        const cookie = await login(boot);

        const saved = await saveChat(base, cookie, CHARACTER, CHAT_FILE, chatBody(CHARACTER, PERSONA, [USER_LINE]));

        if (saved.status !== 200) {
            throw new Error(`Saving with Mnemosyne loaded failed (${saved.status}): ${JSON.stringify(saved.body)}`);
        }

        readBack = await getChat(base, cookie, CHARACTER, CHAT_FILE);
        status = await get(base, '/api/plugins/mnemosyne/status', cookie);
        clientConfig = await get(base, '/api/plugins/client-config', cookie);

        leaks = findMarker(scratch, MARKER);
        bootOutput = await waitForWarmUp(server);
    }, 300_000);

    afterAll(async () => {
        await server?.stop();
    });

    test('🔑 both dependencies resolved, and the preflight pinned both revisions', () => {
        // Vacuity guard for the whole suite: these assertions are about a build of Vault and a build of
        // Mnemosyne, and a green run has to be attributable to specific commits of each rather than to
        // whatever happened to be on disk that day.
        expect(gate.resolved).toHaveLength(2);

        for (const one of gate.resolved) {
            expect(one.present).toBe(true);
            expect(one.revision).toMatch(/^[0-9a-f]{7,}$/);
        }
    });

    test('🧠 Mnemosyne actually loaded — it answers on its own mounted router', () => {
        // 🔴 The bolt-in assertion. A plugin that failed to load is silent: `loadPlugins` logs and carries
        // on, the server boots perfectly, and every other test in this file would still pass while
        // testing a two-component stack. Its router answering is the only proof it is there.
        expect(status.status).toBe(200);

        // The body shape too, so a 200 from some catch-all could not stand in for the plugin's own
        // handler. `readStatus` answers `{active, count}` and 401s when it cannot see a session, so this
        // also pins that the plugin is seeing our logged-in user rather than an anonymous request.
        expect(status.body).toHaveProperty('active');
        expect(status.body).toHaveProperty('count');
    });

    test('🚫 and it did not fall over on the way up', () => {
        // Mnemosyne's own source is emphatic that its worst failure mode is silent: install cleanly, log
        // nothing, never work. The fork logs a plugin whose init() threw, so the boot output is where
        // that shows up.
        expect(bootOutput).not.toMatch(/Failed to load plugin|plugin.*threw|Mnemosyne.*failed/i);
    });

    test('🔥 §7 B2: the embedding model WARMED at boot, and did not fail trying', () => {
        // 🔴 THE CLAUSE THIS FILE WAS MISSING. §7 B2 is three claims — the plugin loads, it registers,
        // and its embedding model warms at boot — and only the first two were asserted. The third has
        // the same silent failure mode as the other two: `warmUpEmbeddings` catches its own rejection
        // by design (warming is an optimisation, not a precondition), logs "Could not warm …" and
        // carries on. The boot-failure assertion above does NOT catch that — it looks for a plugin
        // that THREW, and a warm-up that failed did not throw. So the whole stack would come up, every
        // other test here would pass, and the cost this exists to move off a user's first message
        // would be sitting right back on it, unannounced.
        expect(bootOutput).toMatch(/\[Mnemosyne\] Warming the embedding model in the background/);
        expect(bootOutput).not.toMatch(/\[Mnemosyne\] Could not warm the embedding model/);
    });

    test('🔥 and it reported the model READY — the warm-up finished, not merely started', () => {
        // The line above proves it was ATTEMPTED, which is not what B2 claims. This is the claim.
        // Readable here at all because Mnemosyne classifies the identifier and the duration NORMAL —
        // a model name is a config value from a fixed list and a duration is a number — so with
        // debugMode off the line goes to stdout (`src/logger.js` emit) rather than being suppressed.
        expect(bootOutput).toMatch(/\[Mnemosyne\] Embedding model ready \(.+\) in \d+ms\./);
    });

    test('🔁 the chat still round-trips with all three components running', () => {
        expect(readBack.status).toBe(200);

        const lines = (Array.isArray(readBack.body) ? readBack.body : []).filter(entry => typeof entry?.mes === 'string');

        expect(lines.length).toBeGreaterThan(0);
        expect(lines.map(entry => entry.mes)).toContain(USER_LINE);
    });

    test('🔴 §7 B1: THE PLUGIN DID NOT WEAKEN THE PROVIDER — no plaintext anywhere', () => {
        // The same detector, the same marker and the same tree as Suite A, re-run in the configuration
        // Suite A cannot reach. `vault/chat-at-rest.test.js` owns the control that proves this detector
        // can fire; this file owns the claim that it stays silent with a plugin in the process.
        expect(leaks).toEqual([]);
    });

    test('🏷️ names are still encrypted, and the character is still not on disk in clear', () => {
        const paths = collectFiles(dataRoot);

        expect(paths.map(one => path.basename(one)).some(name => name.startsWith('venc1~'))).toBe(true);
        expect(paths.filter(one => one.includes(CHARACTER))).toEqual([]);
    });

    test('🎛️ it registered its panel, so the CLIENT can see it too', () => {
        // ⚠️ THIS TEST REPLACED A VACUOUS ONE. The first version asserted that `<dataRoot>/default-user`
        // exists — which the fork creates for every account whether or not any plugin ever loads, so it
        // was green in exactly the world it was meant to detect. `client-config` is the registry the
        // browser reads, so a panel here is the plugin having registered through the fork's own
        // capability rather than merely having answered on its router.
        const panels = clientConfig.body?.panels ?? [];
        const owners = panels.map(panel => panel.pluginId ?? panel.id);

        expect(clientConfig.status).toBe(200);
        expect(owners).toContain('mnemosyne');
    });
});
