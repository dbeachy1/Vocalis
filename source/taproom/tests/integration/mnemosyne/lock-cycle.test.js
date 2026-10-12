import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { MockServer } from '../../util/mock-server.js';
import { getFreePort, releasePort } from '../../util/st-server.js';
import { DEPENDENCIES, preflight, serverDirectory } from '../preflight.mjs';
import { generate, get, login, makeMarker, post, prepareDataRoot, shareModelCache, startServer } from '../harness.mjs';

/**
 * 🔴 SUITE B §7 B5 — A MEMORY SURVIVES A LOCK/UNLOCK CYCLE.
 *
 * The plan calls this *the real question for a memory system and the one unit tests cannot ask*, and the
 * reason is the same one `vault/lock-unlock.test.js` was written for, one layer up. Locking is easy to
 * get right in a way that loses everything: drop the key, and on the next unlock derive a fresh one,
 * open a NEW empty store, and serve it. Every "is it locked" assertion passes in that world, the plugin
 * reports itself healthy, retrieval returns cleanly — and the user's memories are gone.
 *
 * Mnemosyne's store is SQLCipher keyed from a subkey of the user's own key, so it must close when the
 * vault locks and re-open when it unlocks. Two components have to agree about that, across a seam
 * neither repository can test alone:
 *
 *   - Vault decides WHEN a user's storage is open, and locks it on an idle sweep with the session cookie
 *     still perfectly valid.
 *   - Mnemosyne hooks the fork's storage lifecycle to open and close its own store alongside.
 *
 * ## The three-legged shape, because two of the legs are worthless alone
 *
 * "The memory came back after unlocking" means nothing unless it was there BEFORE (an assertion about a
 * store that never worked) and gone WHILE LOCKED (an assertion satisfied by a store that never closed).
 * So the same planted fact is checked at all three points, and the evidence is what the fork actually
 * put in front of the model each time — `MockServer.requests`, not the panel, because the panel is
 * Mnemosyne's report of itself while the prompt is ground truth.
 *
 * ⚠️ THE COUNT IS CHECKED TOO, AND IT IS THE REAL GUARD AGAINST THE FAILURE ABOVE. A retrieval that
 * works after unlocking proves the store opened; it does not prove it is the SAME store. An empty store
 * that re-derived its key would fail retrieval, yes — but a store that lost only some rows would not,
 * and `status.count` is the cheap way to say "all of it came back, not just the row we asked for".
 *
 * 🔴 THE LOCK IS THE IDLE SWEEP, NOT A LOGOUT, for the reason Suite A records: logout destroys the
 * session, so any later refusal is explained by "not logged in" and says nothing about storage. Under
 * the idle lock the cookie is untouched. The idle clock also RESETS on every authenticated request,
 * which is why the whole of setup can take as long as it likes before the wait begins — and why the
 * wait must be a genuine sleep rather than a polling loop that would keep postponing the thing it is
 * waiting for.
 */

const PERSONA_ID = 'persona-test-user';
const AVATAR = 'LockCycleCharacter.png';
const CHAT_ID = 'the-lock-cycle-chat';

/** The remembered fact. Never typed by anyone — see `log-hygiene.test.js` for why that is load-bearing. */
const SECRET = makeMarker('B5-SURVIVES-THE-LOCK');
const MEMORY_TEXT = `The user's chosen safe word is ${SECRET}, and it must be remembered.`;

/** What the user asks each time. Semantically near the memory, free of the secret. */
const QUERY = 'What is my chosen safe word?';

/**
 * 0.25 minutes = 15 s.
 *
 * ⚠️ DELIBERATELY FIVE TIMES SUITE A'S WINDOW, and the first version of this file used Suite A's 3 s
 * and failed in setup with `Planting the memory failed (403)`. Suite A boots no plugin: there, login
 * returns and the very next request follows immediately. Here, unlocking also opens a SQLCipher store
 * and warms an embedder, and that work happens with NO request in flight — so the idle clock runs out
 * before the test's first call and the vault locks underneath the setup it was meant to observe.
 *
 * The window only has to outlast the quiet gap the plugin's own unlock creates; the sweep is still
 * driven by real idleness, so nothing about what this file asserts is weakened by the larger number.
 */
const IDLE_MINUTES = 0.25;
const IDLE_MS = IDLE_MINUTES * 60 * 1000;

const gate = preflight('suite B — memory across a lock cycle', [DEPENDENCIES.vault, DEPENDENCIES.mnemosyne]);
const suite = gate.run ? describe : describe.skip;

suite('🔐 §7 B5: memory survives the vault locking and opening again', () => {
    /** @type {any} */
    let server;
    /** @type {string} */
    let base;
    /** @type {MockServer} */
    let backend;
    /** @type {number} */
    let backendPort;

    /** What the fork sent the model on each of the three turns. */
    let promptBefore = '';
    let promptWhileLocked = '';
    let promptAfter = '';

    /** Whether the idle sweep actually shut the vault. */
    let locked = false;
    /** What the plugin said about itself before the lock and after the unlock. */
    let statusBefore;
    let statusAfter;

    beforeAll(async () => {
        backendPort = await getFreePort();
        backend = new MockServer({ port: backendPort, host: '127.0.0.1' });
        await backend.start();

        const prepared = await prepareDataRoot('integration-mnemosyne-lock-cycle');
        shareModelCache(prepared.dataRoot);

        const boot = await startServer({
            ...prepared,
            withVault: true,
            pluginsPath: path.join(serverDirectory, 'plugins'),
            providerEnv: { VAULT_IDLE_LOCK_MINUTES: String(IDLE_MINUTES) },
        });

        server = boot.server;
        base = boot.base;

        const cookie = await login(boot);

        // ⚠️ VAULT'S NUMBER ONLY RECOMMENDS SINCE 2026-07-27 — the user has to ask for the lock, and until
        // they do, `VAULT_IDLE_LOCK_MINUTES` above arms nothing. Without this LEG 2 never locks, and a suite
        // about what survives a lock would be reporting on a lock that never happened.
        const armed = await post(base, '/api/users/idle-lock', { minutes: IDLE_MINUTES }, cookie);

        if (armed.status !== 200) {
            throw new Error(`Could not arm the idle lock (${armed.status}): ${JSON.stringify(armed.body)}`);
        }

        const planted = await post(base, '/api/plugins/mnemosyne/memory', {
            text: MEMORY_TEXT, tier: 'scenario', chatId: CHAT_ID, personaId: PERSONA_ID,
        }, cookie);

        if (planted.status !== 201) {
            throw new Error(`Planting the memory failed (${planted.status}): ${JSON.stringify(planted.body)}`);
        }

        const identity = { charAvatar: AVATAR, personaId: PERSONA_ID, chatId: CHAT_ID };

        // ── LEG 1: it works at all ───────────────────────────────────────────────────────────────
        const first = await generate({ base, cookie, backendPort, text: QUERY, identity });

        if (first.status !== 200) {
            throw new Error(`The generation before the lock failed (${first.status}): ${JSON.stringify(first.body)}\n\n${server.output()}`);
        }

        promptBefore = JSON.stringify(backend.requests[backend.requests.length - 1] ?? {});
        statusBefore = await get(base, '/api/plugins/mnemosyne/status', cookie);

        // ── LEG 2: idle until the vault shuts ────────────────────────────────────────────────────
        // A sleep, not a poll. Every authenticated request is activity and resets the idle clock, so a
        // loop that asked "are we locked yet?" would keep the vault open for ever.
        await new Promise(resolve => setTimeout(resolve, IDLE_MS * 2.5));

        locked = (await fetch(`${base}/api/users/me`, { headers: { Cookie: cookie } })).status === 403;

        const during = await generate({ base, cookie, backendPort, text: QUERY, identity });
        // Whatever the server answered, the question is what reached the MODEL. A refusal that still
        // handed the backend a prompt carrying the memory would be the disclosure this file is about.
        promptWhileLocked = during.status === 200
            ? JSON.stringify(backend.requests[backend.requests.length - 1] ?? {})
            : '';

        // ── LEG 3: unlock with the same password, and demand it all back ─────────────────────────
        const reopened = await login(boot);

        const third = await generate({ base, cookie: reopened, backendPort, text: QUERY, identity });

        if (third.status !== 200) {
            throw new Error(`The generation after unlocking failed (${third.status}): ${JSON.stringify(third.body)}\n\n${server.output()}`);
        }

        promptAfter = JSON.stringify(backend.requests[backend.requests.length - 1] ?? {});
        statusAfter = await get(base, '/api/plugins/mnemosyne/status', reopened);
    }, 600_000);

    afterAll(async () => {
        await server?.stop();
        await backend?.stop();
        releasePort(backendPort);
    });

    test('✅ CONTROL: before the lock, the memory reaches the model', () => {
        // 🔴 The vacuity guard for the whole file. Everything below is a statement about a memory system
        // that worked; against one that never retrieved anything, leg 2 passes for free and leg 3 is the
        // only real assertion left — and it would be testing a store that had nothing to lose.
        expect(promptBefore).toContain(SECRET);
    });

    test('🔒 the idle sweep shut the vault, with the session cookie untouched', () => {
        expect(locked).toBe(true);
    });

    test('🔴 while locked, the memory does NOT reach the model', () => {
        // The disclosure half. Mnemosyne's store is keyed from the user's own key, so a store still open
        // after the vault shut is a memory system serving a user's private history out of a vault that
        // believes itself locked.
        expect(promptWhileLocked).not.toContain(SECRET);
    });

    test('🔓 and after unlocking, the same memory comes back', () => {
        // The failure this file exists to catch: a cycle that quietly re-derived a key and opened a NEW
        // empty store would answer every request cleanly, report itself healthy, and have lost the lot.
        expect(promptAfter).toContain(SECRET);
    });

    test('🧮 all of it came back — not merely the row we asked about', () => {
        // Retrieval proves *a* store opened. The count proves it is the same one. A store that lost some
        // rows but kept the queried one would satisfy the test above and nothing else here.
        expect(statusBefore.status).toBe(200);
        expect(statusAfter.status).toBe(200);
        expect(statusAfter.body.count).toBe(statusBefore.body.count);
        expect(statusAfter.body.count).toBeGreaterThan(0);
    });
});
