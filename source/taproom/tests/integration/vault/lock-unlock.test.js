import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { DEPENDENCIES, preflight } from '../preflight.mjs';
import { chatBody, getChat, login, makeMarker, post, prepareDataRoot, saveChat, startServer } from '../harness.mjs';

/**
 * 🔗 SUITE A §7.6 — unreadable while locked, and INTACT again after unlocking.
 *
 * The second half is the one that matters and the one no unit test can ask. Locking is easy to get right
 * in a way that loses data: drop the key, and on the next unlock derive a NEW one, re-initialise, and
 * hand back an empty vault that works perfectly and contains nothing. Every "is it locked" assertion
 * passes in that world. So this file locks a vault with real content in it and then requires the same
 * content back through the app.
 *
 * 🔴 The lock is driven by the IDLE timer rather than by logout, and that is what makes the first half
 * mean anything. Logout destroys the session too, so a refusal afterwards is explained by "not logged
 * in" and says nothing about the vault. Under the idle lock the cookie survives untouched — it lives on
 * the client and nothing expired it — so the ONLY thing that can turn a request into a 403 is
 * `setUserDataMiddleware` finding the storage shut.
 *
 * Vault's idle lock is `VAULT_IDLE_LOCK_MINUTES`, an environment variable rather than a config key: the
 * plugin has zero runtime dependencies by design, and a config-file parser is a dependency. Since
 * 2026-07-27 it only RECOMMENDS — the applied number is the user's own setting, so `beforeAll` arms it
 * explicitly through `/api/users/idle-lock` and the environment variable merely says what the panel
 * suggests. See `users.js` §THE IDLE LOCK.
 */

const CHARACTER = makeMarker('LockCharacter');
const PERSONA = 'Test User';
const CHAT_FILE = 'the-lock-chat';
const MARKER = makeMarker('SUITE-A-LOCK-SECRET');
const USER_LINE = `Hold on to this across the lock: ${MARKER}`;

/** 0.05 minutes = 3 s, which the fork sweeps every 750 ms (`idleSweepMs` is lockMs/4, floored at 500). */
const IDLE_MINUTES = 0.05;
const IDLE_MS = IDLE_MINUTES * 60 * 1000;

const gate = preflight('suite A — lock and unlock', [DEPENDENCIES.vault]);
const suite = gate.run ? describe : describe.skip;

/**
 * Is this cookie still good — that is, is the vault still open?
 * @param {string} base Base URL
 * @param {string} cookie The session cookie
 * @returns {Promise<number>} The status code
 */
async function probe(base, cookie) {
    const response = await fetch(`${base}/api/users/me`, { headers: { Cookie: cookie } });
    return response.status;
}

/**
 * Wait out the idle window, then ask once whether the vault shut.
 *
 * ⚠️ A SLEEP, NOT A POLLING LOOP, and the difference is the whole mechanism. Every authenticated request
 * IS activity, and activity resets the idle clock — so a loop that polled `/api/users/me` until it saw a
 * 403 would postpone the lock with each poll and wait for ever. The way to observe an idle lock is to be
 * genuinely idle. `storage-provider-idle-lock.test.js` has the same shape for the same reason.
 * @param {string} base Base URL
 * @param {string} cookie The session cookie
 * @returns {Promise<boolean>} True if the vault was shut when we finally looked
 */
async function waitForLock(base, cookie) {
    await new Promise(resolve => setTimeout(resolve, IDLE_MS * 2.5));
    return await probe(base, cookie) === 403;
}

suite('🔒 a vault locks, and gives everything back when it opens', () => {
    /** @type {any} */
    let server;
    /** @type {string} */
    let base;

    /** The chat as it read before the lock — the vacuity guard for everything after it. */
    let beforeLock;
    /** Whether the idle sweep actually shut the vault inside the deadline. */
    let locked = false;
    /** What `/api/chats/get` answered while the vault was shut. */
    let whileLocked;
    /** The chat as it read after logging back in. */
    let afterUnlock;

    beforeAll(async () => {
        const prepared = await prepareDataRoot('integration-vault-lock');
        const boot = await startServer({
            ...prepared,
            withVault: true,
            providerEnv: { VAULT_IDLE_LOCK_MINUTES: String(IDLE_MINUTES) },
        });

        server = boot.server;
        base = boot.base;

        const cookie = await login(boot);

        // ⚠️ VAULT'S NUMBER ONLY RECOMMENDS SINCE 2026-07-27 — the user has to ask for the lock, and until
        // they do, `VAULT_IDLE_LOCK_MINUTES` above arms nothing. Without this the vault never shuts and the
        // whole suite passes vacuously: "unreadable while locked" is trivially satisfied by never locking.
        const armed = await post(base, '/api/users/idle-lock', { minutes: IDLE_MINUTES }, cookie);

        if (armed.status !== 200) {
            throw new Error(`Could not arm the idle lock (${armed.status}): ${JSON.stringify(armed.body)}`);
        }

        const saved = await saveChat(base, cookie, CHARACTER, CHAT_FILE, chatBody(CHARACTER, PERSONA, [USER_LINE]));

        if (saved.status !== 200) {
            throw new Error(`Saving through Vault failed (${saved.status}): ${JSON.stringify(saved.body)}`);
        }

        beforeLock = await getChat(base, cookie, CHARACTER, CHAT_FILE);

        locked = await waitForLock(base, cookie);

        // The same cookie, now against a shut vault. Whatever comes back must not be the conversation.
        whileLocked = await getChat(base, cookie, CHARACTER, CHAT_FILE);

        // And now open it again, with the same password that made it in the first place.
        const reopened = await login(boot);
        afterUnlock = await getChat(base, reopened, CHARACTER, CHAT_FILE);
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
    });

    test('📖 before the lock, the chat reads back through the app', () => {
        // 🔴 The vacuity guard for the whole file. "Not readable while locked" proves nothing unless it
        // was readable first — an empty vault satisfies every later assertion here perfectly.
        expect(beforeLock.status).toBe(200);
        expect(JSON.stringify(beforeLock.body)).toContain(MARKER);
    });

    test('🔒 the idle sweep shut the vault, with the session cookie untouched', () => {
        expect(locked).toBe(true);
    });

    test('🙅 while locked, the app does not serve the conversation', () => {
        // The refusal itself is `setUserDataMiddleware` finding the storage shut — but the assertion that
        // matters is about the CONTENT, not the status code. A future refactor that started answering 200
        // with an empty body would still be correct here; one that leaked the marker would not.
        expect(JSON.stringify(whileLocked.body ?? '')).not.toContain(MARKER);
    });

    test('🔓 and after unlocking, every byte of it is still there', () => {
        expect(afterUnlock.status).toBe(200);

        const lines = (Array.isArray(afterUnlock.body) ? afterUnlock.body : []).filter(entry => typeof entry?.mes === 'string');

        // Vacuity guard again, and this is the failure the file exists to catch: a lock/unlock cycle that
        // silently re-initialised the vault would answer 200 with an empty array, which is a passing
        // "no error" and a total loss of the user's data.
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.map(entry => entry.mes)).toContain(USER_LINE);
    });

    test('🚪 logging out locks it too — the other half of the contract', async () => {
        const cookie = await login({ server, base });

        expect(await probe(base, cookie)).toBe(200);

        const out = await post(base, '/api/users/logout', {}, cookie);
        expect(out.status).toBe(204);

        // The cookie is dead either way after a logout, so this is deliberately the weaker of the two
        // assertions in this file. It is here because logout locking the vault is a promise the fork makes
        // in `users-private.js` — upstream logout only drops the cookie and leaves the key in RAM.
        expect(await probe(base, cookie)).toBe(403);
    }, 120_000);
});
