import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import path from 'node:path';

import { DEPENDENCIES, preflight, serverDirectory } from '../preflight.mjs';
import { HANDLE, login, makeMarker, post, prepareDataRoot, shareModelCache, startServer } from '../harness.mjs';

/**
 * A backup must complete for an account that contains Mnemosyne's foreign store. Vault does not own or
 * encrypt that store, so the backup walk must preserve the provider's ownership boundary.
 *
 * `createBackupArchive` reads each path through the storage provider. This integration test creates a
 * nonempty foreign store and checks that the export survives the backup walk. Failure output comes from
 * the task-owned scratch server.
 */

const SECRET = makeMarker('BACKUP-FOREIGN-STORE');

const gate = preflight('backup with a foreign store present', [DEPENDENCIES.vault, DEPENDENCIES.mnemosyne]);
const suite = gate.run ? describe : describe.skip;

suite('backup with a foreign store present', () => {
    let boot;
    let cookie;

    beforeAll(async () => {
        const prepared = await prepareDataRoot('backup-foreign');
        shareModelCache(prepared.dataRoot);

        // ⚠️ `pluginsPath` is not optional here. Without it the server boots with no Mnemosyne, the memory
        // route 404s, and — worse for this file — no foreign store is ever created, so a backup would sail
        // through and report the bug fixed.
        boot = await startServer({
            ...prepared,
            withVault: true,
            pluginsPath: path.join(serverDirectory, 'plugins'),
        });
        cookie = await login(boot);

        // Force the foreign store into existence with something actually in it: an empty or absent store
        // would make this pass for the wrong reason.
        const remembered = await post(boot.base, '/api/plugins/mnemosyne/memory', {
            text: `${SECRET} the user keeps bees on the bakery roof`,
            tier: 'scenario',
            chatId: 'backup-foreign-chat',
        }, cookie);

        if (remembered.status !== 201) {
            throw new Error(`Could not plant a memory: ${remembered.status} ${JSON.stringify(remembered.body)}`);
        }
    }, 600_000);

    afterAll(async () => {
        await boot?.server?.stop?.();
    });

    // A foreign `memory/` root must resolve to provider-owned passthrough before the Vault lock gate.
    // Treating its SQLCipher file as a Vault envelope fails because it has no `stenv:` wrapper.
    test('a user can export their own account with a foreign store inside it', async () => {
        const response = await fetch(`${boot.base}/api/users/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ handle: HANDLE }),
        });

        let bytes;
        let transportError;

        try {
            bytes = Buffer.from(await response.arrayBuffer());
        } catch (error) {
            // A mid-stream abort surfaces here, not as a status — exactly what the live install did.
            transportError = error;
        }

        if (transportError || response.status !== 200 || !bytes?.length) {
            throw new Error(
                `Backup failed: status ${response.status}, ${bytes?.length ?? 0} bytes, ` +
                `transport ${transportError?.message ?? 'ok'}\n\n--- server output ---\n${boot.server.output()}`,
            );
        }

        // A real zip, not a JSON error served with a 200.
        expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    }, 180_000);

    test('the server survives the attempt either way', async () => {
        const me = await fetch(`${boot.base}/api/users/me`, { headers: { Cookie: cookie } });
        expect(me.status).toBe(200);
    }, 60_000);
});
