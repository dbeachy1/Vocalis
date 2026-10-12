import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import { describe, test, expect, jest } from '@jest/globals';

import { argon2id } from '../src/crypto/argon2.js';
import { ARGON2_ITERATIONS, ARGON2_MEMORY_KIB, ARGON2_PARALLELISM } from '../src/crypto/vault.js';

jest.setTimeout(180_000);

/**
 * 🔑 argon2id — the key derivation, and the only cryptography in this project we did not write ourselves.
 *
 * It comes from Node's core, which is exactly where we want it: this function derives THE KEY THAT
 * UNWRAPS EVERYTHING, and the threat this whole project exists to stop is third-party code. A poisoned
 * package inside the KDF would not need to steal anything — it could simply return a key of its choosing.
 *
 * So the plugin has ZERO dependencies, and this file is the check that the thing we got for free is
 * actually correct.
 */
describe('argon2id', () => {
    test('🔴 it is THE argon2id — RFC 9106 §5.3, byte for byte', () => {
        // Not "an argon2id". The one from the specification, checked against the specification's own test
        // vector, with the secret and associated-data inputs exercised.
        //
        // A KDF that is subtly wrong is the worst kind of bug available here: it would round-trip
        // perfectly — every vault would create, unlock, re-key and recover exactly as expected — while
        // silently producing keys with less entropy than advertised. Every test in this repo would be
        // green. Nothing would look wrong until someone competent attacked it.
        //
        // So it is not enough that it works. It has to be RIGHT, and only a published vector can say so.
        const tag = crypto.argon2Sync('argon2id', {
            message: Buffer.alloc(32, 0x01),
            nonce: Buffer.alloc(16, 0x02),
            secret: Buffer.alloc(8, 0x03),
            associatedData: Buffer.alloc(12, 0x04),
            parallelism: 4,
            passes: 3,
            memory: 32,
            tagLength: 32,
        });

        expect(Buffer.from(tag).toString('hex'))
            .toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
    });

    test('🔴 and OUR WRAPPER maps the parameters correctly — the vector above does not prove that', async () => {
        // 🔴 THE TEST ABOVE PROVES NODE IS RIGHT. IT PROVES NOTHING ABOUT THIS REPO.
        //
        // It calls `crypto.argon2Sync` directly -- `argon2id` is imported at the top of this file and never
        // invoked by it. So every claim in its comment is true of Node's primitive and none of it is true of
        // `src/crypto/argon2.js`, which sits between us and that primitive and does the one thing a thin
        // wrapper can get wrong: it renames six parameters. `password`→`message`, `salt`→`nonce`,
        // `iterations`→`passes`, `memoryKiB`→`memory`, `hashLength`→`tagLength`.
        //
        // Swap `passes` and `parallelism` there and the vector above still passes, because it does not go
        // through the wrapper -- and so do all three round-trip tests below, because they are RELATIVE
        // (deterministic, salt matters, password matters). A KDF quietly running 4 passes over 3 lanes
        // instead of 3 over 4 is exactly the "subtly wrong, everything green" outcome the comment above
        // says must not be possible.
        //
        // ⚠️ The expected value is NOT a recording of what `argon2id()` currently returns. It was computed
        // from `crypto.argon2Sync` with the mapping the wrapper is SUPPOSED to apply -- a fixture built by
        // the function under test cannot detect that function ignoring its inputs, which is the same trap
        // `vault.test.js` avoids by rebuilding the old vault from the primitive rather than from `deriveKek`.
        // Verified discriminating: swapping passes/parallelism, or message/nonce, changes this digest.
        //
        // Small `memoryKiB` deliberately -- this is a mapping check, not a cost check, and the vault's real
        // 256 MiB parameters are exercised by the test below.
        const key = await argon2id({
            password: 'correct horse battery staple',
            salt: Buffer.alloc(16, 7),
            parallelism: 4,
            iterations: 3,
            memoryKiB: 32,
            hashLength: 32,
        });

        expect(key.toString('hex'))
            .toBe('f992951bbaf3bf900a27a8bfb973a586f3bf231a1da065a7897ad44bc0872480');
    });

    test('the vault\'s own parameters produce a 32-byte key', async () => {
        const key = await argon2id({
            password: 'correct horse battery staple',
            salt: Buffer.alloc(16, 7),
            parallelism: ARGON2_PARALLELISM,
            iterations: ARGON2_ITERATIONS,
            memoryKiB: ARGON2_MEMORY_KIB,
            hashLength: 32,
        });

        expect(key).toBeInstanceOf(Buffer);
        expect(key.length).toBe(32);
    });

    test('it is deterministic, and the salt changes everything', async () => {
        const options = { password: 'p', parallelism: 1, iterations: 1, memoryKiB: 8 * 1024, hashLength: 32 };

        const a = await argon2id({ ...options, salt: Buffer.alloc(16, 1) });
        const b = await argon2id({ ...options, salt: Buffer.alloc(16, 1) });
        const c = await argon2id({ ...options, salt: Buffer.alloc(16, 2) });

        expect(a.equals(b)).toBe(true);
        expect(a.equals(c)).toBe(false);
    });

    test('the password changes everything too', async () => {
        const options = { salt: Buffer.alloc(16, 1), parallelism: 1, iterations: 1, memoryKiB: 8 * 1024, hashLength: 32 };

        const a = await argon2id({ ...options, password: 'password' });
        const b = await argon2id({ ...options, password: 'passwore' });

        expect(a.equals(b)).toBe(false);
    });
});
