import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from '@jest/globals';
import nodePersist from 'node-persist';
import { fileURLToPath } from 'node:url';

let scratch;

function prepareImage(scratchRoot, repositoryRoot) {
    const imageRoot = path.join(scratchRoot, 'image');
    fs.mkdirSync(imageRoot);
    const imageConfig = path.join(imageRoot, 'config.yaml');
    const packageConfig = path.join(repositoryRoot, 'packaging', 'taproom', 'config.yaml');
    const provisionCommand = path.join(repositoryRoot, 'packaging', 'taproom', 'provision-owner.mjs');
    fs.cpSync(path.join(repositoryRoot, 'source', 'taproom', 'src'), path.join(imageRoot, 'src'), { recursive: true });
    fs.copyFileSync(provisionCommand, path.join(imageRoot, 'provision-owner.mjs'));
    fs.copyFileSync(packageConfig, imageConfig);
    fs.chmodSync(imageConfig, 0o444);
    const modulesPath = path.join(repositoryRoot, 'source', 'taproom', 'node_modules');
    fs.symlinkSync(modulesPath, path.join(imageRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    return imageRoot;
}

function runCheck(repositoryRoot, imageRoot, configPath, dataRoot) {
    try {
        execFileSync(process.execPath, [
            path.join(imageRoot, 'provision-owner.mjs'),
            '--check',
            '--configPath', configPath,
            '--dataRoot', dataRoot,
        ], { cwd: repositoryRoot, encoding: 'utf8', timeout: 10_000 });
        return undefined;
    } catch (error) {
        return error;
    }
}

afterEach(() => {
    if (scratch) {
        fs.rmSync(scratch, { recursive: true, force: true });
        scratch = undefined;
    }
});

describe('Docker owner preflight', () => {
    test('refuses a fresh root without creating an account store', () => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'taproom-owner-check-'));
        const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
        const imageRoot = prepareImage(scratch, repositoryRoot);
        const configPath = path.join(scratch, 'instance', 'config.yaml');
        const dataRoot = path.join(scratch, 'data');
        const result = runCheck(repositoryRoot, imageRoot, configPath, dataRoot);

        expect(result?.status).toBe(1);
        expect(result?.stderr).toContain('Taproom owner is not provisioned.');
        expect(fs.existsSync(path.join(dataRoot, '_storage'))).toBe(false);
    });

    test('copies the read-only image config as an owner-writable instance config', () => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'taproom-owner-config-copy-'));
        const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
        const imageRoot = prepareImage(scratch, repositoryRoot);
        const configPath = path.join(scratch, 'instance', 'config.yaml');
        const result = runCheck(repositoryRoot, imageRoot, configPath, path.join(scratch, 'data'));

        expect(result?.status).toBe(1);
        const configMode = fs.statSync(configPath).mode & 0o777;
        if (process.platform !== 'win32') {
            expect(configMode).toBe(0o600);
        } else {
            expect(configMode & 0o200).toBe(0o200);
        }
    });

    test('preserves an existing instance config and its permissions', () => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'taproom-owner-config-'));
        const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
        const imageRoot = prepareImage(scratch, repositoryRoot);
        const configPath = path.join(scratch, 'instance', 'config.yaml');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const packageConfig = path.join(repositoryRoot, 'packaging', 'taproom', 'config.yaml');
        const original = Buffer.concat([fs.readFileSync(packageConfig), Buffer.from('\n# existing instance config\n')]);
        fs.writeFileSync(configPath, original);
        fs.chmodSync(configPath, 0o400);
        const originalMode = fs.statSync(configPath).mode & 0o777;
        const result = runCheck(repositoryRoot, imageRoot, configPath, path.join(scratch, 'data'));

        expect(result?.status).toBe(1);
        expect(result?.stderr).toContain('Taproom owner is not provisioned.');
        expect(fs.readFileSync(configPath)).toEqual(original);
        expect(fs.statSync(configPath).mode & 0o777).toBe(originalMode);
    });

    /**
     * Write accounts straight into a new account store, the way the owner provisioning command leaves it.
     * @param {string} dataRoot Data root
     * @param {Record<string, {password: string, admin: boolean, enabled: boolean}>} accounts Accounts by handle
     * @returns {Promise<void>}
     */
    async function writeAccounts(dataRoot, accounts) {
        const store = nodePersist.create({ dir: path.join(dataRoot, '_storage'), ttl: false, expiredInterval: 0 });
        await store.init();
        for (const [handle, fields] of Object.entries(accounts)) {
            await store.setItem(`user:${handle}`, { handle, name: handle, created: Date.now(), salt: 'salt', ...fields });
        }
    }

    // The start-up check is the last line of defense for the blank-password rule (the routes refuse a blank password,
    // see users-blank-password.test.js). It must keep refusing an enabled account with no password.
    test('refuses to start when an enabled account has no password, even with a passworded admin', async () => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'taproom-owner-blank-'));
        const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
        const imageRoot = prepareImage(scratch, repositoryRoot);
        const dataRoot = path.join(scratch, 'data');
        await writeAccounts(dataRoot, {
            owner: { password: 'hash', admin: true, enabled: true },
            friend: { password: '', admin: false, enabled: true },
        });
        const result = runCheck(repositoryRoot, imageRoot, path.join(scratch, 'instance', 'config.yaml'), dataRoot);

        expect(result?.status).toBe(1);
        expect(result?.stderr).toContain('no enabled passwordless accounts');
    });

    test('starts when every enabled account has a password and a passwordless one is disabled', async () => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'taproom-owner-ok-'));
        const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
        const imageRoot = prepareImage(scratch, repositoryRoot);
        const dataRoot = path.join(scratch, 'data');
        await writeAccounts(dataRoot, {
            owner: { password: 'hash', admin: true, enabled: true },
            'default-user': { password: '', admin: true, enabled: false },
        });
        const result = runCheck(repositoryRoot, imageRoot, path.join(scratch, 'instance', 'config.yaml'), dataRoot);

        expect(result).toBeUndefined();
    });
});
