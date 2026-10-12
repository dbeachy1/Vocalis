import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { DEPENDENCIES, preflight } from '../preflight.mjs';
import { HANDLE, get, login, makeMarker, post, prepareDataRoot, startServer } from '../harness.mjs';

/**
 * Backups must stay scoped to the requested account. Vault keeps unlocked keys per handle, so the route
 * must not let an administrator export another user's decrypted files without that user's password.
 *
 * `createBackupArchive` starts streaming before reading every file. If a provider read fails after headers
 * are sent, the error path must not trigger an unhandled `ERR_HTTP_HEADERS_SENT` rejection or stop the server.
 */

const VICTIM = 'backupvictim';
const VICTIM_PASSWORD = 'a-different-password-entirely';
const SECRET = makeMarker('BACKUP-SCOPE-CANARY');

const gate = preflight('backup scope — an admin may not export another vault', [DEPENDENCIES.vault]);
const suite = gate.run ? describe : describe.skip;

suite('backup scope', () => {
    let boot;
    let adminCookie;
    let victimCookie;
    let dataRoot;

    beforeAll(async () => {
        const prepared = await prepareDataRoot('backup-scope');
        dataRoot = prepared.dataRoot;
        boot = await startServer({ dataRoot: prepared.dataRoot, configPath: prepared.configPath });
        adminCookie = await login(boot);

        // The seeded account is the admin. A second account is what makes "another user" meaningful.
        // ⚠️ Thrown, not `expect`ed: an assertion in `beforeAll` is a lint error here, and a throw gives a
        // better failure anyway — it names what went wrong instead of reporting three unrelated red tests.
        const created = await post(boot.base, '/api/users/create', {
            handle: VICTIM, name: VICTIM, password: VICTIM_PASSWORD,
        }, adminCookie);

        if (created.status !== 200) {
            throw new Error(`Could not create the second account: ${created.status} ${JSON.stringify(created.body)}`);
        }

        // 🔴 THE VICTIM LOGS IN, AND STAYS LOGGED IN. A locked vault would make every assertion below pass
        // for the wrong reason — "the admin got nothing" is not interesting if there was no key in memory to
        // get. The whole point is to attack the window where the key IS resident.
        victimCookie = await login(boot, VICTIM_PASSWORD, VICTIM);

        const wrote = await post(boot.base, '/api/settings/save', {
            settings: JSON.stringify({ canary: SECRET }),
        }, victimCookie);

        if (wrote.status !== 200) {
            throw new Error(`The victim could not write its canary: ${wrote.status} ${JSON.stringify(wrote.body)}`);
        }
    }, 180_000);

    afterAll(async () => {
        await boot?.server?.stop?.();
    });

    test('an admin CANNOT export another user\'s vault, even while that user is logged in', async () => {
        const response = await fetch(`${boot.base}/api/users/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
            body: JSON.stringify({ handle: VICTIM }),
        });

        expect(response.status).toBe(403);

        // Belt and braces: whatever came back, the canary must not be in it.
        const text = await response.text();
        expect(text).not.toContain(SECRET);
    }, 120_000);

    test('CONTROL: the route still works for your OWN account, so the refusal is scoped and not blanket', async () => {
        // ⚠️ WITHOUT THIS THE TEST ABOVE IS VACUOUS. A backup endpoint that 403s at everything would pass it
        // perfectly while having broken the feature for everyone.
        const response = await fetch(`${boot.base}/api/users/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
            body: JSON.stringify({ handle: HANDLE }),
        });

        expect(response.status).toBe(200);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.length).toBeGreaterThan(0);
        // A zip, i.e. a real archive rather than a JSON error served with a 200.
        expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    }, 120_000);

    test('🔴 the parsed-card cache is kept OUT, and its presence no longer kills the archive', async () => {
        // 🔴 THE LIVE FAILURE, 2026-07-22. Every backup on `:8001` died mid-stream on
        // `_cache/characters/<sha256>` with EPROVIDER — "it carries no storage envelope". Correct, and not a
        // fault: the parsed-card cache is a node-persist store that a provider covers through the key/value
        // codec rather than by sealing whole files, so there is no envelope for `readFile` to unwrap. The
        // walk was simply asking the wrong question of the wrong file.
        //
        // ⚠️ THE CONTROL COMES FIRST, because without it this test is worthless. An account that never
        // listed its characters has an EMPTY cache, and "no `_cache/` entries in the archive" would then be
        // true for a reason that has nothing to do with the exclusion. Listing populates it.
        const listed = await post(boot.base, '/api/characters/all', { shallow: true }, adminCookie);
        expect(listed.status).toBe(200);

        const cacheDirectory = path.join(dataRoot, HANDLE, '_cache', 'characters');
        const cachedFiles = fs.existsSync(cacheDirectory) ? fs.readdirSync(cacheDirectory) : [];
        expect(cachedFiles.length).toBeGreaterThan(0);

        const response = await fetch(`${boot.base}/api/users/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
            body: JSON.stringify({ handle: HANDLE }),
        });

        expect(response.status).toBe(200);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

        // Zip stores entry names uncompressed in the local file headers, so the raw bytes are enough to say
        // whether anything under `_cache/` was archived — no unzipping required.
        expect(bytes.includes(Buffer.from('_cache/'))).toBe(false);
    }, 180_000);

    test('🔴 the server is STILL ALIVE afterwards — a refused backup must not restart it', async () => {
        // The original defect did not merely leak; it crashed the process, signing out every user on the
        // box. `/api/users/me` answering at all is the assertion — if the server had gone, this fetch would
        // reject rather than return a status.
        const me = await get(boot.base, '/api/users/me', adminCookie);
        expect(me.status).toBe(200);

        const stillVictim = await get(boot.base, '/api/users/me', victimCookie);
        expect(stillVictim.status).toBe(200);
    }, 60_000);
});
