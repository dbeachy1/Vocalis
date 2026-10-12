import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import createVaultProvider from '../src/provider.js';
import * as session from '../src/session.js';
import { LogicalDirent } from '../src/provider/dirent.js';
import { createVaultState } from '../src/vault-state.js';

const HANDLE = 'default-user';
const PASSWORD = 'correct horse battery staple';

/** @type {string} */
let dataRoot;
/** @type {any} */
let provider;
/** @type {any} */
let vault;

/**
 * A LOGICAL path, which in this provider is an absolute one under the data root.
 * @param {...string} parts Path segments below the user's directory
 * @returns {string} The logical path
 */
function at(...parts) {
    return path.join(dataRoot, HANDLE, ...parts);
}

beforeEach(async () => {
    vault = createVaultState();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dirent-'));
    fs.mkdirSync(path.join(dataRoot, HANDLE), { recursive: true });
    session.closeAll(vault);

    provider = createVaultProvider(vault);
    provider.init({
        dataRoot,
        accountsEnabled: true,
        basicAuthMode: false,
        authenticationDelegated: false,
        users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
    });

    await provider.unlock(HANDLE, PASSWORD);
    provider.mkdir(at('chats', 'Test Character 1'), { recursive: true });
    provider.writeFileSync(at('chats', 'Test Character 1', 'a chat.jsonl'), Buffer.from('{"mes":"hello"}'));
});

afterEach(() => {
    session.closeAll(vault);
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * 🔴 A LOGICAL NAME ON A PHYSICAL DIRECTORY BUILDS A PATH THAT HAS NEVER EXISTED.
 *
 * `path.join(entry.parentPath, entry.name)` is the documented way to turn a `Dirent` back into a path, and
 * it is what node's own examples do. `LogicalDirent` took `name` from the logical world and `parentPath`
 * straight off the real entry, so joining them produced a ciphertext directory with a plaintext filename in
 * it — resolving to nothing, in either world.
 *
 * Every way it fails is quiet. Nothing reports a decryption failure, because nothing decrypted anything.
 */
describe('a directory entry joins back into a path that works', () => {
    test('🔴 parentPath + name is a LOGICAL path the provider can actually read', () => {
        const [entry] = provider.readdir(at('chats', 'Test Character 1'), { withFileTypes: true });

        expect(entry.name).toBe('a chat.jsonl');

        const rejoined = path.join(entry.parentPath, entry.name);

        // This is the assertion. Before the fix, `rejoined` was a ciphertext directory plus a plaintext name.
        expect(rejoined).toBe(at('chats', 'Test Character 1', 'a chat.jsonl'));
        expect(provider.readFileSync(rejoined, 'utf-8')).toBe('{"mes":"hello"}');
    });

    test('`path` is node\'s deprecated alias and must not disagree with `parentPath`', () => {
        // Two names for one value that say different things is worse than either answer alone.
        const [entry] = provider.readdir(at('chats', 'Test Character 1'), { withFileTypes: true });

        expect(entry.path).toBe(entry.parentPath);
    });

    test('the parent is the directory that was ASKED for, so the caller gets back what it would have written', () => {
        const [entry] = provider.readdir(at('chats'), { withFileTypes: true });

        expect(entry.name).toBe('Test Character 1');
        expect(entry.isDirectory()).toBe(true);
        expect(entry.parentPath).toBe(at('chats'));
    });

    test('the physical name is nowhere in what the caller is handed', () => {
        // The reason this class exists at all: `readdir` must never leak a ciphertext name.
        const [entry] = provider.readdir(at('chats', 'Test Character 1'), { withFileTypes: true });
        const physical = fs.readdirSync(path.dirname(
            fs.readdirSync(path.join(dataRoot, HANDLE), { recursive: true, withFileTypes: true })
                .filter(e => e.isFile() && !e.name.endsWith('.vault-keys.json'))
                .map(e => path.join(e.parentPath, e.name))[0],
        ));

        expect(physical.some(name => name === entry.name)).toBe(false);
    });

    test('⚠️ with no logical parent it falls back to the physical one — the old behaviour, kept deliberately', () => {
        // A caller that never joins the two is unaffected either way, and a silent `undefined` here would be
        // worse than the bug this fixed: `path.join(undefined, name)` throws.
        const real = fs.readdirSync(path.join(dataRoot, HANDLE), { withFileTypes: true })[0];
        const fallback = new LogicalDirent('whatever.jsonl', real);

        expect(fallback.parentPath).toBe(real.parentPath);
        expect(fallback.path).toBe(real.parentPath);
    });

    test('the type predicates still come from the REAL entry, not from the name', () => {
        const [file] = provider.readdir(at('chats', 'Test Character 1'), { withFileTypes: true });
        const [directory] = provider.readdir(at('chats'), { withFileTypes: true });

        expect(file.isFile()).toBe(true);
        expect(file.isDirectory()).toBe(false);
        expect(directory.isDirectory()).toBe(true);
        expect(directory.isFile()).toBe(false);
        expect(file.isSymbolicLink()).toBe(false);
    });
});
