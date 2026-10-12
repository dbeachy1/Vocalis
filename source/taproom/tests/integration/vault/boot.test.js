import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { DEPENDENCIES, preflight } from '../preflight.mjs';
import { HANDLE, PASSWORD, post, prepareDataRoot, startServer } from '../harness.mjs';

/**
 * 🔗 SUITE A — the fork booted against the REAL Vault, not a fixture.
 *
 * `storage-provider-*.test.js` already proves the fork's side of this contract against fixture
 * providers, and Vault proves its own crypto against its own fixtures. Neither has ever seen the
 * other. This file is the first thing in this repository that boots SillyTavern with the actual
 * provider that ships, and it starts at the least interesting end deliberately: does it load at all,
 * and does a login open the vault.
 *
 * The boot itself lives in `../harness.mjs`, which is also what Suite B boots — so B's central claim,
 * *"the plugin did not weaken any of A's guarantees"*, is made against A's actual arrangement rather
 * than a copy of it that drifted.
 */

const WRONG_PASSWORD = 'not-that-one';

// 🔴 Throws if Vault is not installed. `PLAN_INTEGRATION_TESTS.md` §4 — a suite that cannot run must
// never report green, so the absence of the dependency is a loud failure rather than a quiet pass.
const gate = preflight('suite A — fork + Vault', [DEPENDENCIES.vault]);
const suite = gate.run ? describe : describe.skip;

suite('🔗 the fork boots against the real Vault', () => {
    /** @type {any} */
    let server;
    /** @type {string} */
    let base;

    beforeAll(async () => {
        const prepared = await prepareDataRoot('integration-vault-boot');
        const boot = await startServer({ ...prepared, withVault: true });

        server = boot.server;
        base = boot.base;
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
    });

    test('🔑 it is the real Vault that loaded, at the revision the preflight pinned', () => {
        // Vacuity guard: every assertion in this file is about a provider that actually loaded, and a
        // server that failed to boot would otherwise fail these in a way that reads like a Vault bug.
        expect(server.listening).toBe(true);
        expect(gate.resolved[0].present).toBe(true);
        expect(gate.resolved[0].revision).toMatch(/^[0-9a-f]{7,}$/);
    });

    test('✅ /api/storage/status reports encryption enabled', async () => {
        const response = await fetch(`${base}/api/storage/status`);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.enabled).toBe(true);
    });

    test('🗣️ the badge and the marker are VAULT\'s words — the fork supplies none', async () => {
        const body = await (await fetch(`${base}/api/storage/status`)).json();

        // The fork deliberately has no default to fall back on, so a non-empty string here can only
        // have come from the provider's own describe(). This is the seam no fixture exercises: real
        // strings, out of the real plugin, through the fork's anonymous endpoint.
        expect(typeof body.badge).toBe('string');
        expect(body.badge.length).toBeGreaterThan(0);
        expect(typeof body.marker).toBe('string');
        expect(body.marker.length).toBeGreaterThan(0);
    });

    test('🔓 a correct password logs in, and the vault opens behind it', async () => {
        const response = await post(base, '/api/users/login', { handle: HANDLE, password: PASSWORD });

        // The fork fails the login outright if the provider cannot make the account ready, so a 200
        // here IS the assertion that unlock() succeeded — there is no such thing as a logged-in user
        // with a shut vault.
        expect(response.status).toBe(200);
        expect(response.body.handle).toBe(HANDLE);
        expect(response.cookie).not.toBe('');
    });

    test('🔴 a wrong password is refused, and does not quietly mint a second vault', async () => {
        const response = await post(base, '/api/users/login', { handle: HANDLE, password: WRONG_PASSWORD });

        expect(response.status).toBe(403);

        // And the right password still works afterwards. This is the half that matters: a provider that
        // "helpfully" re-initialised on a failed unlock would leave the account openable by the WRONG
        // password and the original data stranded behind a key nobody holds.
        const retry = await post(base, '/api/users/login', { handle: HANDLE, password: PASSWORD });

        expect(retry.status).toBe(200);
    });
});
