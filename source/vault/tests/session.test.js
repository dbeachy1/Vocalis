import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import * as session from '../src/session.js';
import { deriveSubkeys } from '../src/crypto/vault.js';
import { createVaultState } from '../src/vault-state.js';

/**
 * 🔴 THE KEYS ARE WIPED ON LOCK, AND "ALL OF THEM" HAS TO MEAN ALL OF THEM.
 *
 * `close()` used to name five buffers and call `fill(0)` on each. Correct, and quietly fragile: the list
 * had to be kept in step with `deriveSubkeys` by hand, and forgetting was silent in the worst possible
 * direction. A subkey that is derived but never wiped survives every lock — sitting in the heap, readable
 * in a core dump, a swap file or a heap snapshot, for the life of the process. Nothing throws. Nothing
 * changes. No test notices, because there was nothing looking.
 *
 * So the test is not "are these five zeroed". It is **"is every buffer in the record zeroed"**, derived
 * from the record itself — which is the same shape the fix uses, and the only form that keeps working
 * when a sixth key is added.
 */

const HANDLE = 'default-user';

/**
 * This suite's own provider state.
 *
 * 🔴 A FRESH ONE PER TEST **IS** THE RESET. Before `vault-state.js` these keys lived in a
 * module-level Map shared by every provider in the process, so one test's unlocked account was every
 * test's unlocked account. Nothing here can leak into the next test now, because there is nothing
 * shared to leak through.
 */
let vault;

beforeEach(() => {
    vault = createVaultState();
});

afterEach(() => {
    session.closeAll(vault);
});

describe('the session key table', () => {
    test('open derives every subkey deriveSubkeys returns', () => {
        const dek = crypto.randomBytes(32);

        session.open(vault, HANDLE, dek);

        const held = session.keysFor(vault, HANDLE);
        const expected = deriveSubkeys(dek);

        // Every subkey is present and correct...
        for (const [name, value] of Object.entries(expected)) {
            expect(Buffer.isBuffer(held[name])).toBe(true);
            expect(held[name].equals(value)).toBe(true);
        }

        // ...and the DEK is there too, which is what `deriveSubkey` needs.
        expect(held.dek.equals(dek)).toBe(true);
    });

    test('🔴 close zeroes EVERY buffer in the record, not a hard-coded five', () => {
        session.open(vault, HANDLE, crypto.randomBytes(32));

        // Hold references before closing — `close` deletes the map entry, so this is the only way to see
        // the buffers afterwards. This is exactly the reference a core dump would have.
        const held = session.keysFor(vault, HANDLE);
        const buffers = Object.entries(held).filter(([, v]) => Buffer.isBuffer(v));

        // A guard on the guard: if the record ever stops holding buffers this test must fail, not pass
        // vacuously over an empty list.
        expect(buffers.length).toBeGreaterThanOrEqual(5);
        expect(buffers.some(([, v]) => v.some(byte => byte !== 0))).toBe(true);

        session.close(vault, HANDLE);

        for (const [name, value] of buffers) {
            expect({ name, zeroed: value.every(byte => byte === 0) }).toEqual({ name, zeroed: true });
        }

        expect(session.isOpen(vault, HANDLE)).toBe(false);
        expect(session.keysFor(vault, HANDLE)).toBeUndefined();
    });

    test('closeAll zeroes every account, not just the last one', () => {
        session.open(vault, 'one', crypto.randomBytes(32));
        session.open(vault, 'two', crypto.randomBytes(32));

        const held = ['one', 'two'].map(h => Object.values(session.keysFor(vault, h)).filter(Buffer.isBuffer));

        session.closeAll(vault);

        for (const buffers of held) {
            for (const value of buffers) {
                expect(value.every(byte => byte === 0)).toBe(true);
            }
        }

        expect(session.isOpen(vault, 'one')).toBe(false);
        expect(session.isOpen(vault, 'two')).toBe(false);
    });

    test('closing a vault that is not open is a no-op, not a throw', () => {
        expect(() => session.close(vault, 'nobody')).not.toThrow();
    });

    /**
     * 🔴 THE DEK MUST NOT RIDE ALONG ON A ROUTING RECORD.
     *
     * `provider/resolve.js` hangs these keys on the object `resolve()` returns — a path-resolution record
     * whose shape is documented public API, which flows through roughly twenty provider methods and is
     * passed wholesale into the sidecar calculation. While that object carried the DEK, one future
     * `sensitive().error('resolve failed', at, error)` would have written the master key to a log file.
     *
     * Nothing had done that. The safety was entirely that nobody had written the line yet.
     */
    test('🔴 providerKeys hands out the two the provider needs, and NOT the DEK', () => {
        const dek = crypto.randomBytes(32);

        session.open(vault, HANDLE, dek);

        const forProvider = session.providerKeys(vault, HANDLE);

        expect(Object.keys(forProvider).sort()).toEqual(['kContent', 'kNames']);
        expect(forProvider.dek).toBeUndefined();

        // And nothing in it IS the DEK, under any name.
        for (const value of Object.values(forProvider)) {
            expect(value.subarray(0, 32).equals(dek)).toBe(false);
        }
    });

    test('🔴 cacheKeys likewise — the key/value store never sees the DEK', () => {
        const dek = crypto.randomBytes(32);

        session.open(vault, HANDLE, dek);

        const forCache = session.cacheKeys(vault, HANDLE);

        expect(Object.keys(forCache).sort()).toEqual(['kCache', 'kCacheNames']);
        expect(forCache.dek).toBeUndefined();

        for (const value of Object.values(forCache)) {
            expect(value.subarray(0, 32).equals(dek)).toBe(false);
        }
    });

    test('🔴 the narrowed views SHARE the buffers, so close() still wipes them', () => {
        session.open(vault, HANDLE, crypto.randomBytes(32));

        // A copy here would be worse than no narrowing at all: close() zeroes the record, and a detached
        // copy would stay readable after the lock — the exact failure the narrowing exists to reduce.
        const forProvider = session.providerKeys(vault, HANDLE);
        const forCache = session.cacheKeys(vault, HANDLE);

        session.close(vault, HANDLE);

        for (const value of [...Object.values(forProvider), ...Object.values(forCache)]) {
            expect(value.every(byte => byte === 0)).toBe(true);
        }
    });

    test('both narrowed views are undefined when the vault is shut', () => {
        expect(session.providerKeys(vault, HANDLE)).toBeUndefined();
        expect(session.cacheKeys(vault, HANDLE)).toBeUndefined();
    });

    test('deriveSubkey is null when shut, and confined to its namespace when open', () => {
        expect(session.deriveSubkey(vault, HANDLE, 'plugin-label', 32)).toBeNull();

        session.open(vault, HANDLE, crypto.randomBytes(32));

        const derived = session.deriveSubkey(vault, HANDLE, 'plugin-label', 32);

        expect(Buffer.isBuffer(derived)).toBe(true);
        expect(derived).toHaveLength(32);

        // It is not any of the vault's own keys.
        for (const value of Object.values(session.keysFor(vault, HANDLE))) {
            expect(derived.equals(value.subarray(0, 32))).toBe(false);
        }
    });
});

/**
 * 🔴 THE INVARIANT AT THE PLACE IT ACTUALLY MATTERS.
 *
 * `providerKeys` excluding the DEK is only useful if `resolve()` is what calls it. This asserts the shape
 * of the record that really flows through the provider, rather than trusting that the wiring is right.
 */
describe('the resolution record the provider passes around', () => {
    test('🔴 carries kContent and kNames, and no DEK anywhere in it', async () => {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');

        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-keys-'));

        try {
            fs.mkdirSync(path.join(dataRoot, HANDLE), { recursive: true });

            const { default: createProvider } = await import('../src/provider.js');
            const { resolve } = await import('../src/provider/resolve.js');
            const { forgetNameSchemes } = await import('../src/vault-store.js');

            forgetNameSchemes(vault);

            const provider = createProvider(vault);

            provider.init({
                dataRoot,
                accountsEnabled: true,
                basicAuthMode: false,
                authenticationDelegated: false,
                users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
            });

            await provider.unlock(HANDLE, 'correct horse battery staple');

            const dek = session.keysFor(vault, HANDLE).dek;
            const at = resolve(vault, path.join(dataRoot, HANDLE, 'chats', 'a.jsonl'));

            expect(Object.keys(at.keys).sort()).toEqual(['kContent', 'kNames']);

            // Nothing reachable on the record equals the DEK — not under `keys`, not beside it.
            for (const value of [...Object.values(at.keys), ...Object.values(at)]) {
                if (Buffer.isBuffer(value)) {
                    expect(value.subarray(0, 32).equals(dek)).toBe(false);
                }
            }
        } finally {
            session.closeAll(vault);
            fs.rmSync(dataRoot, { recursive: true, force: true });
        }
    });
});
