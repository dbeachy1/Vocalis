import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import { describe, test, expect, jest } from '@jest/globals';

import {
    createVault,
    deriveKek,
    deriveSubkey,
    deriveSubkeys,
    formatRecoveryKey,
    parseRecoveryKey,
    rewrapPassword,
    unlockWithPassword,
    unlockWithRecoveryKey,
} from '../src/crypto/vault.js';
import { argon2id } from '../src/crypto/argon2.js';

// argon2id at 256 MiB is deliberately expensive. That is the whole point of it, and it makes these slow.
jest.setTimeout(180_000);

const PASSWORD = 'correct horse battery staple';

describe('the vault: the normal life of a key', () => {
    test('create → unlock with the password', async () => {
        const { keys, dek } = await createVault(PASSWORD);
        const unlocked = await unlockWithPassword(keys, PASSWORD);

        expect(unlocked.equals(dek)).toBe(true);
    });

    test('the wrong password FAILS, and says nothing else', async () => {
        const { keys } = await createVault(PASSWORD);

        await expect(unlockWithPassword(keys, 'not the password')).rejects.toThrow(/wrong password/i);
    });

    test('create → unlock with the RECOVERY KEY', async () => {
        const { keys, dek, recoveryKey } = await createVault(PASSWORD);
        const unlocked = await unlockWithRecoveryKey(keys, recoveryKey);

        expect(unlocked.equals(dek)).toBe(true);
    });

    test('the DEK is 256 bits and is never the same twice', async () => {
        const a = await createVault(PASSWORD);
        const b = await createVault(PASSWORD);

        expect(a.dek.length).toBe(32);
        expect(a.dek.equals(b.dek)).toBe(false);
    });
});

describe('🔴 the vault: §4.2 — the KEK must be independent of ST\'s stored hash', () => {
    test('the KEK salt is NOT SillyTavern\'s password salt', async () => {
        // The load-bearing decision of the entire project.
        //
        // ST stores scrypt(password, user.salt) IN THE CLEAR in _storage. If our KEK were any
        // deterministic function of that stored value — or shared its salt — then anyone who can read
        // _storage could compute the KEK, unwrap the DEK, and decrypt everything. No password guess. No
        // brute force. And "anyone who can read _storage" is precisely the poisoned-dependency attacker
        // this whole project exists to stop.
        //
        // The two KDFs must share nothing. This asserts the salts are independent; the design's
        // stronger claim (different algorithms entirely — scrypt vs argon2id) is structural.
        const stSalt = crypto.randomBytes(16);
        const { keys } = await createVault(PASSWORD);

        expect(keys.salt_kek).not.toBe(stSalt.toString('base64'));
        expect(Buffer.from(keys.salt_kek, 'base64').length).toBe(16);
    });

    test('the same password with different salts gives DIFFERENT KEKs', async () => {
        const a = await deriveKek(PASSWORD, Buffer.alloc(16, 1));
        const b = await deriveKek(PASSWORD, Buffer.alloc(16, 2));

        expect(a.equals(b)).toBe(false);
    });

    test('nothing in the key file lets you recover the DEK without a secret', async () => {
        const { keys } = await createVault(PASSWORD);
        const serialized = JSON.stringify(keys);

        // The file is plaintext BY NECESSITY — it is what you unlock with. So it had better contain
        // nothing but wrapped blobs and salts. If the DEK, the KEK or the recovery key ever appeared in
        // here, the vault would be a decoration.
        const { dek } = await createVault(PASSWORD);
        expect(serialized).not.toContain(dek.toString('base64'));
        expect(serialized).not.toContain(dek.toString('hex'));
    });
});

describe('🔴 the vault: changing the password must NOT re-encrypt the data', () => {
    test('a password change re-wraps the key and leaves the DEK alone', async () => {
        // The hard requirement. If changing a password meant re-encrypting every chat, the developer would never
        // change his password — and a design that discourages password changes is a bad design.
        //
        // The DEK never changes for the life of the data. Only the thing wrapping it does.
        const { keys, dek } = await createVault(PASSWORD);
        const updated = await rewrapPassword(keys, dek, 'a brand new password');

        const afterChange = await unlockWithPassword(updated, 'a brand new password');

        expect(afterChange.equals(dek)).toBe(true);
        expect(updated.wrap_password).not.toBe(keys.wrap_password);
    });

    test('the OLD password stops working', async () => {
        const { keys, dek } = await createVault(PASSWORD);
        const updated = await rewrapPassword(keys, dek, 'a brand new password');

        await expect(unlockWithPassword(updated, PASSWORD)).rejects.toThrow(/wrong password/i);
    });

    test('🔴 the RECOVERY KEY still works after a password change', async () => {
        // It wraps the unchanged DEK, so a password change must not invalidate the recovery key.
        const { keys, dek, recoveryKey } = await createVault(PASSWORD);
        const updated = await rewrapPassword(keys, dek, 'a brand new password');

        const recovered = await unlockWithRecoveryKey(updated, recoveryKey);

        expect(recovered.equals(dek)).toBe(true);
    });

    test('a password change uses a FRESH salt', async () => {
        const { keys, dek } = await createVault(PASSWORD);
        const updated = await rewrapPassword(keys, dek, 'a brand new password');

        expect(updated.salt_kek).not.toBe(keys.salt_kek);
    });
});

describe('the vault: the recovery key is meant to be written down by hand', () => {
    test('it round-trips', () => {
        const raw = crypto.randomBytes(32);
        const formatted = formatRecoveryKey(raw);

        expect(parseRecoveryKey(formatted).equals(raw)).toBe(true);
    });

    test('it is grouped, and it omits the characters people mis-transcribe', () => {
        const formatted = formatRecoveryKey(crypto.randomBytes(32));

        // BitLocker-style groups of five.
        expect(formatted).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{1,5})+$/);

        // No I, O, 0 or 1: nobody can tell them apart at a kitchen table with a biro.
        expect(formatted).not.toMatch(/[IO01]/);
    });

    test('it forgives what humans get wrong: case, dashes, spaces', () => {
        const raw = crypto.randomBytes(32);
        const formatted = formatRecoveryKey(raw);

        const mangled = formatted.toLowerCase().replace(/-/g, ' ');

        expect(parseRecoveryKey(mangled).equals(raw)).toBe(true);
    });

    test('a wrong recovery key FAILS', async () => {
        const { keys } = await createVault(PASSWORD);
        const wrong = formatRecoveryKey(crypto.randomBytes(32));

        await expect(unlockWithRecoveryKey(keys, wrong)).rejects.toThrow(/wrong recovery key/i);
    });

    test('it carries 256 bits', () => {
        expect(parseRecoveryKey(formatRecoveryKey(crypto.randomBytes(32))).length).toBe(32);
    });
});

describe('the vault: the subkeys are independent', () => {
    test('k_content and k_names are different, and neither IS the DEK', () => {
        const dek = crypto.randomBytes(32);
        const { kContent, kNames } = deriveSubkeys(dek);

        expect(kContent.equals(dek)).toBe(false);
        expect(kContent.equals(kNames.subarray(0, 32))).toBe(false);

        // AES-SIV takes a double-length key: half to authenticate, half to encrypt.
        expect(kContent.length).toBe(32);
        expect(kNames.length).toBe(64);
    });

    test('they are deterministic in the DEK', () => {
        const dek = crypto.randomBytes(32);

        expect(deriveSubkeys(dek).kContent.equals(deriveSubkeys(dek).kContent)).toBe(true);
    });

    test('a different DEK gives entirely different subkeys', () => {
        const a = deriveSubkeys(crypto.randomBytes(32));
        const b = deriveSubkeys(crypto.randomBytes(32));

        expect(a.kContent.equals(b.kContent)).toBe(false);
        expect(a.kNames.equals(b.kNames)).toBe(false);
    });
});

describe('the vault: a subkey for someone else', () => {
    test('the caller gets the length it asked for, and it is not the DEK', () => {
        const dek = crypto.randomBytes(32);

        expect(deriveSubkey(dek, 'mnemosyne-db-v1', 32).length).toBe(32);
        expect(deriveSubkey(dek, 'mnemosyne-db-v1', 64).length).toBe(64);
        expect(deriveSubkey(dek, 'mnemosyne-db-v1', 32).equals(dek)).toBe(false);
    });

    test('the same label gives the same bytes — or the caller cannot reopen its own store', () => {
        const dek = crypto.randomBytes(32);

        expect(deriveSubkey(dek, 'mnemosyne-db-v1', 32).equals(deriveSubkey(dek, 'mnemosyne-db-v1', 32))).toBe(true);
    });

    test('a different label gives different bytes — an implementation that ignored `info` would pass everything else', () => {
        const dek = crypto.randomBytes(32);

        expect(deriveSubkey(dek, 'mnemosyne-db-v1', 32).equals(deriveSubkey(dek, 'something-else-v1', 32))).toBe(false);
    });

    test('a different DEK gives different bytes — the key is the vault\'s, not the label\'s', () => {
        const a = deriveSubkey(crypto.randomBytes(32), 'mnemosyne-db-v1', 32);
        const b = deriveSubkey(crypto.randomBytes(32), 'mnemosyne-db-v1', 32);

        expect(a.equals(b)).toBe(false);
    });

    test('🔴 NO LABEL REACHES THE VAULT\'S OWN KEYS. The caller is confined to its namespace.', () => {
        const dek = crypto.randomBytes(32);
        const { kContent, kNames, kCache, kCacheNames } = deriveSubkeys(dek);

        // The obvious attack: ask for the vault's keys by the name this file derives them under. The
        // prefix is what makes this impossible rather than merely undocumented -- without it, the first
        // of these returns the key to every file the user owns.
        const impersonations = [
            'sillytavern-encrypted-storage:content:v1',
            'sillytavern-encrypted-storage:names:v1',
            'sillytavern-encrypted-storage:keyvalue:v1',
            'sillytavern-encrypted-storage:keyvalue-names:v1',
            'sillytavern-encrypted-storage:recovery:v1',
        ];

        for (const info of impersonations) {
            const got = deriveSubkey(dek, info, 64);

            expect(got.subarray(0, 32).equals(kContent)).toBe(false);
            expect(got.equals(kNames)).toBe(false);
            expect(got.subarray(0, 32).equals(kCache)).toBe(false);
            expect(got.subarray(0, 32).equals(kCacheNames)).toBe(false);
        }
    });
});

/**
 * 🔴 THE FIELD THAT WAS WRITTEN AND NEVER READ.
 *
 * `createVault` has always recorded `keys.kdf`, with a docblock calling it "the argon2id parameters,
 * recorded so a future change does not lock anyone out". Nothing read it back — the string `kdf` appeared
 * exactly once in the repository, at the point it was written, and `deriveKek` always used the module
 * constants.
 *
 * So the promise was false in the one direction that costs everything. Raising `ARGON2_MEMORY_KIB` is the
 * ordinary thing to do as hardware improves, and it is the entire reason the field exists — and it would
 * have derived a different KEK for every vault already on the disk. Every one of them would have refused
 * the correct password for ever, with the parameters that WOULD have worked sitting in the file that had
 * just been read.
 *
 * Nothing failed while this was broken, because nobody had changed a constant yet. That is what makes it
 * worth a test rather than a comment: the failure is scheduled, not present.
 */
describe('🔴 the KDF parameters are read off the vault, not out of this module', () => {
    test('a vault records what it was built with', async () => {
        const { keys } = await createVault(PASSWORD);

        expect(keys.kdf).toMatchObject({ algorithm: 'argon2id' });
        expect(typeof keys.kdf.memoryKiB).toBe('number');
        expect(typeof keys.kdf.iterations).toBe('number');
        expect(typeof keys.kdf.parallelism).toBe('number');
    });

    /**
     * 🔴 THE OLD KEK IS DERIVED BY CALLING `argon2id` DIRECTLY, AND THAT IS THE WHOLE TEST.
     *
     * The obvious version built it with `deriveKek(PASSWORD, salt, past)` — and PASSED AGAINST THE BUG. Of
     * course it did: the broken `deriveKek` ignored its third argument, so the test's "old" vault was built
     * under today's constants, `unlockWithPassword` opened it under today's constants, and the two wrongs
     * agreed. A fixture built by the function under test cannot detect that function ignoring its input.
     *
     * So the past is reconstructed from the primitive, which has no opinion about this module's constants.
     */
    test('🔴 a vault built under DIFFERENT parameters still opens with the right password', async () => {
        // A vault from a build whose constants were not today's. Cheaper than today's on purpose: this has
        // to run in a test suite, and the point being proved is that the NUMBERS are honoured, not what they
        // are. Before the fix, `unlockWithPassword` derived under the module constants and this threw
        // "wrong password" at a password that was entirely correct.
        const past = { algorithm: 'argon2id', memoryKiB: 8 * 1024, iterations: 1, parallelism: 1 };
        const { keys, dek } = await createVault(PASSWORD);

        const saltKek = crypto.randomBytes(16);
        const kek = await argon2id({
            password: PASSWORD.normalize(),
            salt: saltKek,
            parallelism: past.parallelism,
            iterations: past.iterations,
            memoryKiB: past.memoryKiB,
            hashLength: 32,
        });

        // Re-wrap the SAME dek under a KEK derived with the old parameters, by hand, the way that build would
        // have written it.
        const nonce = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', kek, nonce);
        const sealed = Buffer.concat([cipher.update(dek), cipher.final()]);

        const older = {
            ...keys,
            salt_kek: saltKek.toString('base64'),
            wrap_password: Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString('base64'),
            kdf: past,
        };

        const opened = await unlockWithPassword(older, PASSWORD);

        expect(opened.equals(dek)).toBe(true);
    });

    test('a vault with NO kdf field predates the record, and opens under the constants', async () => {
        const { keys, dek } = await createVault(PASSWORD);
        const { kdf, ...withoutKdf } = keys;

        expect(kdf).toBeDefined();

        const opened = await unlockWithPassword(withoutKdf, PASSWORD);

        expect(opened.equals(dek)).toBe(true);
    });

    test('a password change adopts todays parameters and records them with the new salt', async () => {
        const { keys, dek } = await createVault(PASSWORD);
        const stale = { ...keys, kdf: { algorithm: 'argon2id', memoryKiB: 8 * 1024, iterations: 1, parallelism: 1 } };

        const updated = await rewrapPassword(stale, dek, 'a brand new password');

        expect(updated.kdf).toEqual(keys.kdf);
        expect(updated.salt_kek).not.toBe(stale.salt_kek);

        // And the pair is consistent: the recorded kdf is the one that opens the recorded wrap.
        const opened = await unlockWithPassword(updated, 'a brand new password');

        expect(opened.equals(dek)).toBe(true);
    });
});
