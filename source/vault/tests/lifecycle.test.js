import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

import * as lifecycle from '../src/lifecycle.js';
import * as session from '../src/session.js';
import { formatRecoveryKey } from '../src/crypto/vault.js';
import { assertUsable } from '../src/preconditions.js';
import { hasVault, readVaultKeys, vaultKeysPath } from '../src/vault-store.js';
import { createVaultState } from '../src/vault-state.js';
import { deriveSubkeys, deriveRecoveryWrappingKey } from '../src/crypto/kdf.js';
import { wrapEnvelope } from '../src/envelope.js';
import { encryptBuffer } from '../src/crypto/content-cipher.js';

jest.setTimeout(180_000);

const HANDLE = 'default-user';
const PASSWORD = 'correct horse battery staple';

/** @type {string} */
let dataRoot;

/**
 * A context that passes the precondition check.
 * @param {object} overrides Anything to change
 * @returns {any} The context
 */
function context(overrides = {}) {
    return {
        dataRoot,
        accountsEnabled: true,
        basicAuthMode: false,
        authenticationDelegated: false,
        users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
        ...overrides,
    };
}


/**
 * This suite's own provider state.
 *
 * 🔴 A FRESH ONE PER TEST **IS** THE RESET. Before `vault-state.js` the modules held six
 * globals between them, so a test had to remember which `reset*()` calls applied to it -- and
 * `tests/verify.test.js` records a test that passed with its guard DELETED because the shared
 * `dataRoot` was already set by a previous `beforeEach`. Nothing here can do that now: a provider
 * built around this object cannot see any other test's state, because there is no other state to see.
 */
let vault;
beforeEach(() => {
    vault = createVaultState();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-lifecycle-'));
    fs.mkdirSync(path.join(dataRoot, HANDLE), { recursive: true });
    session.closeAll(vault);
});

afterEach(() => {
    session.closeAll(vault);
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * 🔴 THE BOOT PRECONDITION CHECK.
 *
 * Three ordinary SillyTavern configurations do not break this plugin loudly. They break it QUIETLY: the
 * vault gets made, the files go on the disk as ciphertext, everything looks encrypted — and the key is
 * available to anyone who walks up to the machine. Encryption theatre, which is worse than no encryption,
 * because you stop worrying about the thing you should still be worrying about.
 */
describe('🔴 preconditions: refuse to come up as a decoration', () => {
    test('🔴 enableUserAccounts: false is REFUSED — and it is SillyTavern\'s default', () => {
        // No login page, no password ever entered, nothing to derive a key from.
        expect(() => assertUsable(context({ accountsEnabled: false })))
            .toThrow(/REFUSING TO START[\s\S]*enableUserAccounts is FALSE/);
    });

    test('🔴 AN EMPTY PASSWORD IS REFUSED — the quiet one', () => {
        // The genuinely dangerous case, because everything looks right: accounts are on, there is a login
        // page, the user has an account. But SillyTavern guards every password check with
        // `if (user.password && …)`, so an empty password does not mean "check against empty" — it means
        // NO CHECK AT ALL, and `tryAutoLogin` walks a lone passwordless user straight in.
        //
        // A vault keyed from an empty password has a key that is a published constant.
        expect(() => assertUsable(context({ users: [{ handle: HANDLE, enabled: true, hasPassword: false }] })))
            .toThrow(/NO PASSWORD/);
    });

    test('🔴 delegated authentication is REFUSED', () => {
        // Authelia or a proxy authenticates; SillyTavern never sees a password, so it cannot give us one.
        expect(() => assertUsable(context({ authenticationDelegated: true })))
            .toThrow(/delegated/i);
    });

    test('a DISABLED passwordless account does not block the boot', () => {
        // It cannot log in, so it cannot be the hole. Refusing here would be a false positive that stops
        // a perfectly good install for no reason.
        expect(() => assertUsable(context({
            users: [
                { handle: HANDLE, enabled: true, hasPassword: true },
                { handle: 'retired', enabled: false, hasPassword: false },
            ],
        }))).not.toThrow();
    });

    test('a healthy configuration is accepted', () => {
        expect(() => assertUsable(context())).not.toThrow();
    });
});

describe('the vault lifecycle', () => {
    test('first unlock CREATES the vault, and hands back a recovery key exactly once', async () => {
        lifecycle.init(vault, context());

        expect(lifecycle.ownsUser(vault, HANDLE)).toBe(false);
        expect(lifecycle.isReady(vault, HANDLE)).toBe(false);

        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
        expect(lifecycle.ownsUser(vault, HANDLE)).toBe(true);
        expect(fs.existsSync(vaultKeysPath(dataRoot, HANDLE))).toBe(true);

        // A recovery key is waiting to be shown, and ASKING FOR IT DOES NOT CONSUME IT: it is pending until
        // the user says they wrote it down, not until something read it out of a Map. (It used to be
        // destructive, which meant a browser refresh at the wrong moment silently threw away the only copy.)
        const recoveryKey = lifecycle.pendingRecoveryKey(vault, HANDLE);
        expect(recoveryKey).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{1,5})+$/);
        expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBe(recoveryKey);

        // And it is the real one: it opens this vault.
        lifecycle.lock(vault, HANDLE);
        await lifecycle.recover(vault, HANDLE, recoveryKey, 'a brand new password');
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
    });

    test('the key file contains no key — only wraps and a salt', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const dek = session.keysFor(vault, HANDLE).dek;
        const raw = fs.readFileSync(vaultKeysPath(dataRoot, HANDLE), 'utf-8');

        // It is plaintext by necessity — it is what you unlock WITH. So it had better be useless.
        expect(raw).not.toContain(dek.toString('base64'));
        expect(raw).not.toContain(dek.toString('hex'));
        expect(raw).not.toContain(PASSWORD);
    });

    test('a second unlock with the right password opens the SAME vault', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        const first = Buffer.from(session.keysFor(vault, HANDLE).dek);

        lifecycle.lock(vault, HANDLE);
        expect(lifecycle.isReady(vault, HANDLE)).toBe(false);

        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        expect(session.keysFor(vault, HANDLE).dek.equals(first)).toBe(true);
    });

    test('🔴 a WRONG password fails, and does NOT re-initialise the vault', async () => {
        // The nightmare: a typo at the login page silently creates a second vault over the top of the
        // first, and every chat in the account becomes unreachable. So a wrong password must be a plain,
        // boring failure that touches nothing.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const keysBefore = fs.readFileSync(vaultKeysPath(dataRoot, HANDLE), 'utf-8');
        lifecycle.lock(vault, HANDLE);

        await expect(lifecycle.unlock(vault, HANDLE, 'not the password')).rejects.toThrow(/wrong password/i);

        expect(lifecycle.isReady(vault, HANDLE)).toBe(false);
        expect(fs.readFileSync(vaultKeysPath(dataRoot, HANDLE), 'utf-8')).toBe(keysBefore);
    });

    test('🔴 locking WIPES the keys, it does not merely forget them', async () => {
        // A Buffer that is only dereferenced sits in the heap, readable, until the garbage collector gets
        // round to it. A core dump or a heap snapshot taken in that window contains the key.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const dek = session.keysFor(vault, HANDLE).dek;
        expect(dek.some(byte => byte !== 0)).toBe(true);

        lifecycle.lock(vault, HANDLE);

        expect(dek.every(byte => byte === 0)).toBe(true);
        expect(session.keysFor(vault, HANDLE)).toBeUndefined();
    });

    test('🔴 an empty password is refused even here, behind the precondition check', async () => {
        lifecycle.init(vault, context());
        await expect(lifecycle.unlock(vault, HANDLE, '')).rejects.toThrow(/cannot be empty/i);
        expect(hasVault(dataRoot, HANDLE)).toBe(false);
    });

    /**
     * 🔴 ALL THREE DOORS, AND ALL THREE SAY WHY.
     *
     * The rule was enforced in three places with three different sentences, and only `unlock` had a test.
     * The worst of the three was `recover`'s — *"A new password is required."* — which is the entire
     * message the fork shows, verbatim, to somebody recovering an account they are locked out of. It
     * states a requirement and not one word of the reason, which is the difference between a rule that
     * sounds arbitrary and one that sounds like a warning.
     *
     * So this asserts the REASON, not just the refusal. A future edit that trims the message back to
     * "a password is required" fails here.
     */
    test('🔴 every door that keys the DEK refuses an empty password, and explains itself', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const recoveryKey = lifecycle.pendingRecoveryKey(vault, HANDLE);

        for (const attempt of [
            () => lifecycle.unlock(vault, HANDLE, ''),
            () => lifecycle.rekey(vault, HANDLE, PASSWORD, ''),
            () => lifecycle.recover(vault, HANDLE, recoveryKey, ''),
        ]) {
            const error = await attempt().then(() => null, e => e);

            expect(error).toBeInstanceOf(Error);
            expect(error.message).toMatch(/cannot be empty/i);

            // The reason, which is what the user actually needs: an empty password is not checked at all.
            expect(error.message).toMatch(/does not CHECK an empty password/);
            expect(error.message).toMatch(/published constant/);

            // 🔴 And NOT the handle. An Error's message travels — into logs, bug reports, screenshots —
            // and `logging.js` calls a handle user-authored. Two of these used to interpolate it.
            expect(error.message).not.toContain(HANDLE);
        }
    });

    test('the recovery-key button keeps its OWN refusal, because it is a different rule', async () => {
        // Proof of identity, not "this password is too weak to key anything". Routing it through the
        // shared rule would have told the user the wrong thing about why they are being asked.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        await expect(lifecycle.regenerateRecoveryKey(vault, HANDLE, '')).rejects.toThrow(/we have to know it is you/i);
    });
});

/**
 * 🔴 THE NO-MIGRATION RULE, ENFORCED.
 *
 * There is no migration utility, by decision. The consequence has to be caught at the door: if encryption
 * is switched on for an account that already holds plaintext data, every existing file would become
 * present-but-permanently-unreadable. The provider would try to decrypt files that were never encrypted,
 * fail, and correctly refuse to serve them — for ever, because nothing will ever go back and encrypt them.
 *
 * Nothing gets destroyed. It just all stops working, silently, and looks exactly like corruption.
 */
describe('🔀 turning encryption on for an account that already has data', () => {
    test('🔴 the login SUCCEEDS — this is the lockout in §2, and it is gone', async () => {
        // This test used to assert the opposite, and the opposite was a PERMANENT LOCKOUT. `unlock()` runs
        // on every login, so an account that refused vault creation refused the login, every time, for ever
        // — see `createVaultFor`. `DESIGN_MIXED_MODE.md` §12 step 2 makes this the regression test for the
        // whole feature.
        fs.mkdirSync(path.join(dataRoot, HANDLE, 'chats', 'Test Character 1'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, HANDLE, 'chats', 'Test Character 1', 'a chat.jsonl'), '{"mes":"hello"}\n');

        lifecycle.init(vault, context());

        await expect(lifecycle.unlock(vault, HANDLE, PASSWORD)).resolves.toBeUndefined();
        expect(hasVault(dataRoot, HANDLE)).toBe(true);
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
    });

    test('🔴 but it REFUSES when the existing data is OUR ciphertext — a lost key file, not a new account', async () => {
        // 🔴 THE DIFFERENCE BETWEEN THE TEST ABOVE AND THIS ONE IS THE DIFFERENCE BETWEEN A FEATURE AND AN
        // ACCOUNT-DESTROYING BUG, AND `createVaultFor` COULD NOT TELL THEM APART.
        //
        // It decided "is this a new vault?" purely on whether `.vault-keys.json` was present, and that file
        // is a DOTFILE — `cp -r data/user/*` misses it, so does a GUI copy with hidden files off, so does a
        // partial backup. The directory left behind is still full of ciphertext WE wrote.
        //
        // What happened next: a fresh DEK, `legacyData: true` (because the file count never looked at a
        // file), which permanently disables verify's leak alarm for the account — and then, under scheme 2,
        // every unmarked name reads as somebody else's plaintext, so the real ciphertext is passed to
        // SillyTavern raw, fails to parse, and is regenerated from nothing. A successful login and an empty
        // account.
        //
        // So: same shape as the passing test above, one byte different at the front of the file.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        // A real encrypted file, written through the real write path, so the envelope is genuine.
        const written = path.join(dataRoot, HANDLE, 'chats', 'kept.jsonl');
        fs.mkdirSync(path.dirname(written), { recursive: true });
        fs.writeFileSync(written, wrapEnvelope(encryptBuffer(session.providerKeys(vault, HANDLE).kContent, Buffer.from('{"mes":"hello"}\n'))));

        // Now lose the key file, exactly as a dotfile-skipping restore would.
        fs.rmSync(vaultKeysPath(dataRoot, HANDLE));
        lifecycle.lock(vault, HANDLE);
        expect(hasVault(dataRoot, HANDLE)).toBe(false);

        await expect(lifecycle.unlock(vault, HANDLE, PASSWORD)).rejects.toThrow(/REFUSING TO CREATE A VAULT/);

        // And it refused rather than half-doing it: no new keys file, no session.
        expect(hasVault(dataRoot, HANDLE)).toBe(false);
        expect(lifecycle.isReady(vault, HANDLE)).toBe(false);
        // The ciphertext is still sitting there, untouched, waiting for the real key file to come back.
        expect(fs.existsSync(written)).toBe(true);
    });

    test('🔴 and the chat that was already there is UNTOUCHED — same bytes, same name, same path', async () => {
        const chatPath = path.join(dataRoot, HANDLE, 'chats', 'Test Character 1', 'a chat.jsonl');
        fs.mkdirSync(path.dirname(chatPath), { recursive: true });
        fs.writeFileSync(chatPath, '{"mes":"hello"}\n');
        const before = fs.statSync(chatPath);

        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        // §1: "installing the plugin on a live system does not touch existing data". Not re-encrypted, not
        // moved, not renamed, not even opened — the mtime is the assertion that nothing rewrote it.
        expect(fs.readFileSync(chatPath, 'utf-8')).toBe('{"mes":"hello"}\n');
        expect(fs.statSync(chatPath).mtimeMs).toBe(before.mtimeMs);
    });

    test('🔴 the account is FLAGGED as holding legacy plaintext, and that is what keeps `verify` honest', async () => {
        fs.mkdirSync(path.join(dataRoot, HANDLE, 'chats', 'Test Character 1'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, HANDLE, 'chats', 'Test Character 1', 'a chat.jsonl'), '{"mes":"hello"}\n');

        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        // The one bit that tells the walker a plaintext file in here might be legitimate. Without it, every
        // legacy chat reads as a leak for ever; with it set wrongly, a real leak reads as a legacy chat.
        expect(readVaultKeys(dataRoot, HANDLE).legacyData).toBe(true);
    });

    test('an account with nothing in it is NOT flagged — so a plaintext file there is still a leak', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        expect(readVaultKeys(dataRoot, HANDLE).legacyData).toBe(false);
    });

    test('the files SillyTavern creates for an empty account do not count as data', async () => {
        // settings.json, stats.json and secrets.json are written at boot for a brand-new account. If they
        // counted as "existing data", a fresh install could never be encrypted at all.
        for (const file of ['settings.json', 'stats.json', 'secrets.json']) {
            fs.writeFileSync(path.join(dataRoot, HANDLE, file), '{}');
        }

        lifecycle.init(vault, context());
        await expect(lifecycle.unlock(vault, HANDLE, PASSWORD)).resolves.toBeUndefined();
        expect(hasVault(dataRoot, HANDLE)).toBe(true);
    });
});

describe('changing the password', () => {
    test('🔴 two key-file operations at once are SERIALISED — the second must not silently revert the first', async () => {
        // 🔴 THIS RACE WAS UNREACHABLE BY ACCIDENT UNTIL argon2 MOVED OFF THE MAIN THREAD.
        //
        // Every entry point here reads the whole keys record, does slow work, and writes back a spread of
        // the snapshot it read. That was safe only because every `await` in lifecycle.js used to resolve
        // synchronously -- all the I/O is fs.*Sync and argon2id wrapped crypto.argon2Sync -- so a whole
        // unlock/rekey/recover ran in one uninterrupted macrotask. `crypto.argon2` is a real suspension,
        // ~143ms wide, in the middle of every one of them.
        //
        // Measured with the lock removed, this exact pair reports "regen ok | rekey ok" and leaves
        // wrap_recovery UNCHANGED: rekey's stale write-back discards the recovery key that
        // regenerateRecoveryKey had just minted AND HANDED TO THE USER TO WRITE DOWN. A key on paper that
        // opens nothing is the one outcome this file says is worse than having no recovery key at all.
        //
        // Serialised, the second operation sees the true state and fails honestly, because its password
        // really is stale by then. An error the user can act on, instead of a silent void.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        lifecycle.acknowledgeRecoveryKey(vault, HANDLE);

        const before = readVaultKeys(dataRoot, HANDLE);

        const results = await Promise.allSettled([
            lifecycle.rekey(vault, HANDLE, PASSWORD, 'a totally different password'),
            lifecycle.regenerateRecoveryKey(vault, HANDLE, PASSWORD),
        ]);

        // Called first, so it runs first and wins.
        expect(results[0].status).toBe('fulfilled');

        // And the loser LOSES LOUDLY rather than overwriting the winner with a stale snapshot.
        expect(results[1].status).toBe('rejected');
        expect(results[1].reason.message).toMatch(/wrong password/i);

        // The rekey survived intact -- both of its fields, not one of them.
        const after = readVaultKeys(dataRoot, HANDLE);
        expect(after.salt_kek).not.toBe(before.salt_kek);
        expect(after.wrap_password).not.toBe(before.wrap_password);

        // And the new password genuinely opens the vault afterwards.
        lifecycle.lock(vault, HANDLE);
        await expect(lifecycle.unlock(vault, HANDLE, 'a totally different password')).resolves.toBeUndefined();
    });

    test('🔑 re-wraps the key and does NOT re-encrypt the data', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const dekBefore = Buffer.from(session.keysFor(vault, HANDLE).dek);
        const wrapBefore = readVaultKeys(dataRoot, HANDLE).wrap_password;

        await lifecycle.rekey(vault, HANDLE, PASSWORD, 'a brand new password');

        // The key did not move. That is the whole point of the two layers: a password change is a few
        // hundred milliseconds whether the account holds one chat or fifty gigabytes.
        expect(session.keysFor(vault, HANDLE).dek.equals(dekBefore)).toBe(true);
        expect(readVaultKeys(dataRoot, HANDLE).wrap_password).not.toBe(wrapBefore);

        lifecycle.lock(vault, HANDLE);
        await lifecycle.unlock(vault, HANDLE, 'a brand new password');
        expect(session.keysFor(vault, HANDLE).dek.equals(dekBefore)).toBe(true);
    });

    test('🔴 the old password stops working', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        await lifecycle.rekey(vault, HANDLE, PASSWORD, 'a brand new password');
        lifecycle.lock(vault, HANDLE);

        await expect(lifecycle.unlock(vault, HANDLE, PASSWORD)).rejects.toThrow(/wrong password/i);
    });

    test('🔴 THE VETO: locked, and no old password ⇒ REFUSE', async () => {
        // This is an admin resetting somebody else's password. The DEK cannot be reached — the vault is
        // shut and the old password was not supplied — so it cannot be re-wrapped. Letting the change
        // through would leave the key wrapped under a password that no longer exists anywhere on earth,
        // and every file in the account would be orphaned. Silently.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        lifecycle.lock(vault, HANDLE);

        await expect(lifecycle.rekey(vault, HANDLE, null, 'reset by an admin'))
            .rejects.toThrow(/current password/i);

        // And the old password still opens it, because nothing was written.
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
    });

    /**
     * 🔴 THIS TEST USED TO ASSERT THE OPPOSITE, AND IT WAS WRONG.
     *
     * It was called "UNLOCKED and no old password ⇒ ALLOWED — the key is right there", and it passed, and it
     * was a test that agreed with a bug. `rekey()` used to short-circuit: if the session was open the DEK was
     * already in RAM, so it re-wrapped straight from memory and never asked for the old password at all.
     *
     * Nothing failed. The data was never in any danger — the key was re-wrapped perfectly. That is exactly
     * why it survived: there was no error to notice, and the test that should have caught it had been written
     * to bless it instead.
     *
     * What it actually did was GIVE THE KEY AWAY. SillyTavern lets an admin change a password without knowing
     * the old one and does not even render the field — harmless when a password is a gate, because an admin
     * can read the files anyway. But here the password WRAPS THE KEY. So anyone who reached a live session —
     * a borrowed desk, a stolen cookie, a hostile UI extension — could set a password THEY know and walk away
     * with a permanent key to the vault. Temporary session access became PERMANENT key access, outliving the
     * logout, the restart and the idle lock that are otherwise the whole boundary of this design.
     *
     * An unlocked vault proves the vault is open. It does not prove who opened it.
     */
    test('🔴 UNLOCKED and no old password ⇒ STILL REFUSED. Being signed in is not knowing the password.', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        // The vault is WIDE OPEN. The DEK is in RAM, right here, and re-wrapping it would succeed —
        // which is precisely the temptation this guard exists to refuse.
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
        const dekBefore = Buffer.from(session.keysFor(vault, HANDLE).dek);
        const wrapBefore = readVaultKeys(dataRoot, HANDLE).wrap_password;

        await expect(lifecycle.rekey(vault, HANDLE, null, 'a password an attacker chose'))
            .rejects.toThrow(/current password/i);

        // A WRONG old password is refused too — it is not enough to put something in the box.
        await expect(lifecycle.rekey(vault, HANDLE, 'not the password', 'a password an attacker chose'))
            .rejects.toThrow(/wrong password/i);

        // Nothing was written: the wrap is untouched, and the real password still opens the vault.
        expect(readVaultKeys(dataRoot, HANDLE).wrap_password).toBe(wrapBefore);

        lifecycle.lock(vault, HANDLE);
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        expect(session.keysFor(vault, HANDLE).dek.equals(dekBefore)).toBe(true);

        // ...and the attacker's password does not.
        lifecycle.lock(vault, HANDLE);
        await expect(lifecycle.unlock(vault, HANDLE, 'a password an attacker chose')).rejects.toThrow(/wrong password/i);
    });

    /**
     * 🔴 THE SAME PASSWORD IS NOT A PASSWORD CHANGE — AND IT REPORTED SUCCESS.
     *
     * Re-wrapping the DEK under the identical password WORKS. Nothing throws, the vault opens, the wrap is
     * rewritten, SillyTavern re-hashes the password and shows "Password changed successfully" in green.
     *
     * So a user rotating a credential they believe has leaked was told, in green, that they were now safe.
     * They were not. Nothing had changed. There is no error anywhere in this flow to catch — which is
     * exactly why it needed someone to notice it in a browser rather than in a log.
     *
     * ⚠️ AND IT IS REFUSED HERE, IN THE PLUGIN, NOT IN THE FORK. It reads like form validation, but it is a
     * statement about what re-wrapping a key does and does not accomplish, and that is ours to know. Stock
     * SillyTavern, with no provider, has always let you set the same password again — and it still does,
     * because with no key in the picture the act is genuinely harmless and genuinely idempotent.
     */
    test('🔴 the SAME password is refused — "changed successfully" was a lie', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const wrapBefore = readVaultKeys(dataRoot, HANDLE).wrap_password;

        await expect(lifecycle.rekey(vault, HANDLE, PASSWORD, PASSWORD))
            .rejects.toThrow(/must be different/i);

        // Nothing was rewritten. The refusal happens BEFORE the wrap is touched, so a user who tries this
        // is exactly where they started rather than one silent re-wrap further along.
        expect(readVaultKeys(dataRoot, HANDLE).wrap_password).toBe(wrapBefore);

        // And the account is entirely undamaged: the password still opens it.
        lifecycle.lock(vault, HANDLE);
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
    });

    /**
     * 🔴 THE "NEW RECOVERY KEY" BUTTON IS A KEY-THEFT BUTTON IF IT TRUSTS THE SESSION.
     *
     * Minting a recovery key needs only the DEK, and while the user is signed in the DEK is sitting right
     * there in RAM. So the button could simply work. And then anyone who reached a live session — a borrowed
     * desk, a stolen cookie, a hostile UI extension — clicks it once, writes the key down, and owns the
     * account FOR EVER: past the logout, past the restart, past the idle lock, which are the entire boundary
     * of this design.
     *
     * It is the same hole `rekey()` had, in different clothes. The rule does not change:
     *
     *     An unlocked vault proves the vault is OPEN. It does not prove WHO OPENED IT.
     */
    test('🔴 a NEW recovery key demands the password — an open vault is NOT enough', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        lifecycle.acknowledgeRecoveryKey(vault, HANDLE);

        // The vault is WIDE OPEN. The DEK is in RAM. Minting from it would succeed — which is the temptation.
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
        expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBeNull();

        const wrapBefore = readVaultKeys(dataRoot, HANDLE).wrap_recovery;

        await expect(lifecycle.regenerateRecoveryKey(vault, HANDLE, '')).rejects.toThrow(/current password/i);
        await expect(lifecycle.regenerateRecoveryKey(vault, HANDLE, 'not the password')).rejects.toThrow(/wrong password/i);

        // 🔴 AND NOTHING WAS ISSUED, AND NOTHING WAS WRITTEN. A refusal that still rotated the wrap would be
        // worse than useless: the user's real recovery key on paper would have silently stopped working.
        expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBeNull();
        expect(readVaultKeys(dataRoot, HANDLE).wrap_recovery).toBe(wrapBefore);
    });

    test('🔑 with the password, a new key is issued and the nag is re-armed', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const oldKey = lifecycle.pendingRecoveryKey(vault, HANDLE);
        expect(oldKey).toBeTruthy();
        lifecycle.acknowledgeRecoveryKey(vault, HANDLE);
        expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBeNull();

        await lifecycle.regenerateRecoveryKey(vault, HANDLE, PASSWORD);

        const newKey = lifecycle.pendingRecoveryKey(vault, HANDLE);
        expect(newKey).toBeTruthy();
        expect(newKey).not.toBe(oldKey);

        // 🔴 The nag is re-armed. This key has been read by NOBODY, so the account is in precisely the state
        // it is in at first login: a recovery wrap whose key exists only in this process's memory. If the
        // user never writes it down, they must be asked again — and `recovery_acknowledged` is what asks.
        expect(readVaultKeys(dataRoot, HANDLE).recovery_acknowledged).toBe(false);
    });

    /**
     * 🔴 AND THE OLD KEY IS DEAD. There is only ever ONE recovery wrap, and minting overwrites it.
     *
     * The ordering of this test is the point. "The old key does not open the vault" is trivially true of a
     * key that never opened it — so the old key is USED, successfully, on this very vault, BEFORE the new one
     * is issued. Only then does its failure afterwards mean anything.
     *
     * This matters to a real person holding a real piece of paper: a user who keeps the old slip believing it
     * still works has a recovery key that opens nothing, and will not discover that until the day it is the
     * only thing they have left. The copy says so out loud, and this proves the copy is true.
     */
    test('🔑 ...and the OLD key, which DID work, is dead the moment a new one is issued', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const oldKey = lifecycle.pendingRecoveryKey(vault, HANDLE);
        lifecycle.acknowledgeRecoveryKey(vault, HANDLE);

        // 1. THE OLD KEY WORKS. Prove it here, on this vault, or everything below is vacuous.
        lifecycle.lock(vault, HANDLE);
        await lifecycle.recover(vault, HANDLE, oldKey, PASSWORD);
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);

        // 2. Issue a replacement.
        await lifecycle.regenerateRecoveryKey(vault, HANDLE, PASSWORD);
        const newKey = lifecycle.pendingRecoveryKey(vault, HANDLE);

        // 3. The new key opens the vault...
        lifecycle.lock(vault, HANDLE);
        await lifecycle.recover(vault, HANDLE, newKey, 'a password set with the new key');
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);

        // 4. ...and the old one — the one that demonstrably worked in step 1 — no longer does.
        lifecycle.lock(vault, HANDLE);
        await expect(lifecycle.recover(vault, HANDLE, oldKey, 'a password set with the dead key'))
            .rejects.toThrow(/wrong recovery key/i);
    });

    test('🔑 and the ORDINARY change still works: old password in hand, key re-wrapped, nothing re-encrypted', async () => {
        // The other half. A design that made password changes hard would be a bad design.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const dekBefore = Buffer.from(session.keysFor(vault, HANDLE).dek);

        await expect(lifecycle.rekey(vault, HANDLE, PASSWORD, 'changed while logged in')).resolves.toBeUndefined();

        // The key did not move, and the session stayed open — the user is standing right there.
        expect(session.keysFor(vault, HANDLE).dek.equals(dekBefore)).toBe(true);

        lifecycle.lock(vault, HANDLE);
        await lifecycle.unlock(vault, HANDLE, 'changed while logged in');
        expect(session.keysFor(vault, HANDLE).dek.equals(dekBefore)).toBe(true);
    });

    test('an account with no vault is not blocked from changing its password', async () => {
        // Nothing is keyed from it, so there is nothing to orphan.
        lifecycle.init(vault, context());
        await expect(lifecycle.rekey(vault, 'someone-else', null, 'whatever')).resolves.toBeUndefined();
    });
});

describe('🔑 the recovery key', () => {
    test('🔴 if the new wrap cannot be WRITTEN, the key is never SHOWN', async () => {
        // 🔴 THE ORDER IS THE WHOLE TEST. Write the wrap, THEN offer the key.
        //
        // Offer first and write second, and a failed write hands the user a recovery key, on paper, in a
        // safe, that opens nothing. That is strictly worse than having no recovery key at all: with no key
        // they know they are exposed, and with a dead one they believe they are covered, right up until the
        // day they need it.
        //
        // Failing the login instead would be worse still -- locked out of your own chats because a nag
        // could not be written. So: log loudly, offer nothing, let them in, try again next login.
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

        try {
            lifecycle.init(vault, context());
            await lifecycle.unlock(vault, HANDLE, PASSWORD);
            lifecycle.lock(vault, HANDLE);

            const keysFile = vaultKeysPath(dataRoot, HANDLE);
            const before = fs.readFileSync(keysFile, 'utf-8');

            // Make the write fail without touching the read: writeVaultKeys writes `<keys>.tmp` and renames
            // it over the top. A DIRECTORY sitting at that temp path makes the write throw EISDIR, while
            // the real key file stays perfectly readable.
            fs.mkdirSync(`${keysFile}.tmp`);

            // The login still succeeds...
            await expect(lifecycle.unlock(vault, HANDLE, PASSWORD)).resolves.toBeUndefined();
            expect(lifecycle.isReady(vault, HANDLE)).toBe(true);

            // ...but NOTHING is offered, because nothing was persisted.
            expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBeNull();

            // The old wrap is untouched: nothing was lost, and the account is exactly as it was.
            expect(fs.readFileSync(keysFile, 'utf-8')).toBe(before);

            // And it SAID SO. This is the one condition that is invisible from the inside -- the account
            // quietly has no recovery key anybody has seen -- so silence here would be the bug.
            expect(errors).toHaveBeenCalledWith(expect.stringMatching(/UNRECOVERABLE/));
        } finally {
            errors.mockRestore();
        }
    });

    test('🔴 ...and the NEXT login re-arms it. A failed write must not latch.', async () => {
        // 🔴 THIS IS THE OTHER HALF OF THE TEST ABOVE, AND IT IS THE HALF THAT MATTERS LONGEST.
        //
        // "Log loudly and let them in" is only survivable because the user gets asked again. Without that,
        // the failed write is the §16.7 failure mode wearing a different hat: an account that is silently,
        // permanently unrecoverable, that looks perfectly healthy, and that never asks for anything.
        //
        // It became load-bearing when the fork removed the console-code reset path (§9.1): the recovery key
        // is now the ONLY way back into a locked account. The re-arm is correct BY CONSTRUCTION -- the catch
        // block returns without touching the disk, so `recovery_acknowledged` is still false next time --
        // but "correct by construction" is exactly the kind of thing a refactor breaks in silence. So it is
        // pinned here: anything that records the failure in the keys file will fail this test, which is the
        // point.
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

        try {
            lifecycle.init(vault, context());
            await lifecycle.unlock(vault, HANDLE, PASSWORD);
            lifecycle.lock(vault, HANDLE);

            const keysFile = vaultKeysPath(dataRoot, HANDLE);

            // Same trick as above: a directory at the temp path makes the write fail, the read succeed.
            fs.mkdirSync(`${keysFile}.tmp`);
            await lifecycle.unlock(vault, HANDLE, PASSWORD);
            expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBeNull();

            // The disk must still say "not acknowledged" -- that flag IS the re-arm.
            expect(readVaultKeys(dataRoot, HANDLE).recovery_acknowledged).not.toBe(true);

            // Now let the write succeed, and log in again exactly as the user would.
            lifecycle.lock(vault, HANDLE);
            fs.rmdirSync(`${keysFile}.tmp`);
            await lifecycle.unlock(vault, HANDLE, PASSWORD);

            // Asked again -- and this time there is a key.
            const recoveryKey = lifecycle.pendingRecoveryKey(vault, HANDLE);
            expect(recoveryKey).toBeTruthy();

            // 🔴 And it is a REAL key, not merely a non-null string. A re-arm that offered a key which did
            // not open the vault would pass every assertion above and still leave the account dead.
            lifecycle.lock(vault, HANDLE);
            await lifecycle.recover(vault, HANDLE, recoveryKey, 'the password after recovery');
            expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
        } finally {
            errors.mockRestore();
        }
    });

    test('🔑 it opens the vault and sets a new password, in one step', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const dekBefore = Buffer.from(session.keysFor(vault, HANDLE).dek);
        const recoveryKey = lifecycle.pendingRecoveryKey(vault, HANDLE);

        lifecycle.lock(vault, HANDLE);

        await lifecycle.recover(vault, HANDLE, recoveryKey, 'the password after recovery');

        // 🔑 The account AND the data, together, because under encryption they were never two things.
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
        expect(session.keysFor(vault, HANDLE).dek.equals(dekBefore)).toBe(true);

        lifecycle.lock(vault, HANDLE);
        await lifecycle.unlock(vault, HANDLE, 'the password after recovery');
        expect(session.keysFor(vault, HANDLE).dek.equals(dekBefore)).toBe(true);
    });

    test('🔴 a WRONG recovery key throws, and changes NOTHING', async () => {
        // The fork's route re-keys first and only then changes the password. It can only rely on that if
        // a failure here is total: nothing written, nothing opened.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        lifecycle.pendingRecoveryKey(vault, HANDLE);
        lifecycle.lock(vault, HANDLE);

        const before = fs.readFileSync(vaultKeysPath(dataRoot, HANDLE), 'utf-8');

        // A WELL-FORMED key that is simply not the right one. (My first draft used a made-up string that
        // was too short, so it died in the parser and never reached the crypto — proving nothing about
        // whether a wrong-but-valid key is rejected. Which is the case that actually matters.)
        const wrongButValid = formatRecoveryKey(crypto.randomBytes(32));

        await expect(lifecycle.recover(vault, HANDLE, wrongButValid, 'nope'))
            .rejects.toThrow(/wrong recovery key/i);

        expect(fs.readFileSync(vaultKeysPath(dataRoot, HANDLE), 'utf-8')).toBe(before);
        expect(lifecycle.isReady(vault, HANDLE)).toBe(false);

        // The original password still works.
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
    });

    test('🔴 a recovery key nobody saved is MINTED AGAIN at the next login', async () => {
        // THE FAILURE THIS PREVENTS IS SILENT AND PERMANENT.
        //
        // The key is not stored, only its wrap is. So if the vault is created and the key is never shown --
        // the browser died, the tab was closed, the response was lost -- the account ends up with a recovery
        // wrap whose key does not exist anywhere in the universe. There is then NO way back from a forgotten
        // password, and nothing anywhere says so.
        //
        // Minting one needs only the DEK, and the DEK is in hand at every login. So: mint another, and ask
        // again. "You get one shot and then you are silently doomed" was never an acceptable design.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const first = lifecycle.pendingRecoveryKey(vault, HANDLE);
        expect(first).not.toBeNull();

        // Nobody acknowledged it. Simulate the whole process going away with the key still in RAM.
        lifecycle.lock(vault, HANDLE);
        expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBeNull();

        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const second = lifecycle.pendingRecoveryKey(vault, HANDLE);
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);

        // 🔴 And the NEW one must actually work -- the wrap has to have reached the disk BEFORE it was ever
        // offered for display. A key on a piece of paper that opens nothing is worse than no key at all,
        // because the user believes they are covered.
        lifecycle.lock(vault, HANDLE);
        await lifecycle.recover(vault, HANDLE, second, 'password set by recovery');
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
    });

    test('🔴 the SUPERSEDED key stops working — there is exactly one live recovery key', async () => {
        // The re-mint overwrites wrap_recovery. If the old key still opened the vault, then every unread
        // key ever minted would remain live for ever, and "the recovery key" would be a growing set of
        // secrets rather than one. the developer is told on screen that this replaces the previous key; that
        // sentence had better be true.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const superseded = lifecycle.pendingRecoveryKey(vault, HANDLE);

        lifecycle.lock(vault, HANDLE);
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        lifecycle.lock(vault, HANDLE);

        await expect(lifecycle.recover(vault, HANDLE, superseded, 'nope'))
            .rejects.toThrow(/wrong recovery key/i);
    });

    test('🔑 once the user says they saved it, they are never asked again', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const saved = lifecycle.pendingRecoveryKey(vault, HANDLE);
        lifecycle.acknowledgeRecoveryKey(vault, HANDLE);

        // Acknowledging drops our copy: it is on paper now, and that is the only place it should be.
        expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBeNull();

        // 🔴 And the acknowledgement is on the DISK, not in RAM -- a restart must not resurrect the nag,
        // because a nag that returns after every restart would re-mint and silently invalidate the key
        // the developer has already filed away in his safe.
        expect(readVaultKeys(dataRoot, HANDLE).recovery_acknowledged).toBe(true);

        lifecycle.lock(vault, HANDLE);
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBeNull();

        // And the key they saved still opens the vault -- it was NOT quietly rotated out from under them.
        lifecycle.lock(vault, HANDLE);
        await lifecycle.recover(vault, HANDLE, saved, 'a later password');
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
    });

    test('🔴 a password change does not resurrect the nag, nor rotate the saved key', async () => {
        // rekey() writes the vault-keys file. If it dropped recovery_acknowledged on the floor, the next
        // login would re-mint -- and the piece of paper in the safe would quietly become a lie, which is
        // the exact failure the whole recovery path exists to prevent.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const saved = lifecycle.pendingRecoveryKey(vault, HANDLE);
        lifecycle.acknowledgeRecoveryKey(vault, HANDLE);

        await lifecycle.rekey(vault, HANDLE, PASSWORD, 'second password');

        expect(readVaultKeys(dataRoot, HANDLE).recovery_acknowledged).toBe(true);

        lifecycle.lock(vault, HANDLE);
        await lifecycle.unlock(vault, HANDLE, 'second password');

        expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBeNull();

        lifecycle.lock(vault, HANDLE);
        await lifecycle.recover(vault, HANDLE, saved, 'third password');
        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
    });

    test('🔑 it SURVIVES a password change — the paper in the safe stays true', async () => {
        // The recovery key wraps the unchanged DEK and must remain valid after each password change.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const recoveryKey = lifecycle.pendingRecoveryKey(vault, HANDLE);
        const dekBefore = Buffer.from(session.keysFor(vault, HANDLE).dek);

        await lifecycle.rekey(vault, HANDLE, PASSWORD, 'second password');
        await lifecycle.rekey(vault, HANDLE, 'second password', 'third password');
        lifecycle.lock(vault, HANDLE);

        // Two password changes later, the original recovery key still opens it.
        await lifecycle.recover(vault, HANDLE, recoveryKey, 'fourth password');
        expect(session.keysFor(vault, HANDLE).dek.equals(dekBefore)).toBe(true);
    });
});

describe('🔴 the vault-keys file itself', () => {
    test('🔴 an unknown format version REFUSES rather than guesses', async () => {
        // If a future version writes a format this one does not understand, the safe move is to stop.
        // The alternative — treat the account as un-vaulted — would serve ciphertext as if it were
        // plaintext and turn SillyTavern's boot-time repair machinery loose on it.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const keysPath = vaultKeysPath(dataRoot, HANDLE);
        const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
        keys.version = 999;
        fs.writeFileSync(keysPath, JSON.stringify(keys));

        expect(() => readVaultKeys(dataRoot, HANDLE)).toThrow(/understands versions 1 and 2/i);
    });

    test('it is written atomically, and no temp file is left behind', async () => {
        // A torn write here is the end of the account, so the rename is the commit point.
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);

        const leftovers = fs.readdirSync(path.join(dataRoot, HANDLE)).filter(f => f.endsWith('.tmp'));
        expect(leftovers).toEqual([]);
    });
});

describe('🔴 the frozen wire constants, pinned to bytes', () => {
    // 🔴 kdf.js MARKS THESE LABELS "FROZEN WIRE CONSTANT — changing an existing one is data loss", AND
    // NOTHING ANYWHERE CHECKED THEM.
    //
    // Every existing test of the key hierarchy is RELATIVE: deterministic in the DEK, a different DEK gives
    // different keys, a different label gives different bytes. All three stay green if somebody renames
    // 'sillytavern-encrypted-storage:content:v1' to 'vault:content:v1' -- which is exactly the tidy-up the
    // EncryptedStorage → Vault rename invited. Every vault on every disk would become permanently
    // undecryptable, with a green suite and the correct password in hand.
    //
    // This is the same class of hole the AES-SIV RFC vectors close one layer down: a wrong-but-self-
    // consistent implementation passes every round-trip test there is. The only thing that catches it is a
    // known answer.
    //
    // ⚠️ IF YOU ARE HERE BECAUSE THIS TEST FAILED: do not update the expected values. They are the on-disk
    // format. A change here means every existing vault has just been orphaned, and the fix is to put the
    // label back.
    const DEK = Buffer.alloc(32, 0x2a);

    test('🔴 deriveSubkeys is byte-for-byte what every vault on disk was built with', () => {
        const subkeys = deriveSubkeys(DEK);

        expect(subkeys.kContent.toString('hex'))
            .toBe('e96ff3ef81ad932006f922b7d2cbe1e65ae38b6ac8142d353d58c81f3f2893f5');
        expect(subkeys.kNames.toString('hex'))
            .toBe('bec588b32007021a2944953a29202dd5e89a809dfba3935f189007ea2ddd0059eda929c0338cbdf886cc7dd1edfcfe95a3bfabfff56f3b8bdee6cb8410894406');
        expect(subkeys.kCache.toString('hex'))
            .toBe('a4737a69ba994db69389e62593a94213bad0b809acbe245bd468b50f0ae75e5e');
        expect(subkeys.kCacheNames.toString('hex'))
            .toBe('c776a32c4b75a3cacfdef724a21772da2df29012a84a329cc5d9f09a2e0360d4');
    });

    test('🔴 and so is the recovery wrapping key — the only way back into a forgotten account', () => {
        expect(deriveRecoveryWrappingKey(Buffer.alloc(32, 0x2a)).toString('hex'))
            .toBe('0773e3e1adebab379c7a48ce221663ecad4d404888eb845a88c17a3a8989c6f2');
    });
});

describe('🔴 a tampered key envelope', () => {
    // No test anywhere flipped a byte in wrap_password or wrap_recovery. Every reference to those fields
    // compared whole base64 strings for equality. The nearest coverage reached the GCM tag via a WRONG KEY,
    // which is a different path: the key is right here and the BLOB is damaged.
    test('🔴 a corrupted wrap_password does not open, and does not claim the password is wrong', async () => {
        lifecycle.init(vault, context());
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        lifecycle.lock(vault, HANDLE);

        const keysPath = vaultKeysPath(dataRoot, HANDLE);
        const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));

        // Flip one bit in the middle of the wrapped blob, leaving it the right length and valid base64.
        const blob = Buffer.from(keys.wrap_password, 'base64');
        blob[20] ^= 0x01;
        keys.wrap_password = blob.toString('base64');
        fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2));

        // It must FAIL. What it must not do is succeed, and it must not create a second vault.
        await expect(lifecycle.unlock(vault, HANDLE, PASSWORD)).rejects.toThrow();
        expect(lifecycle.isReady(vault, HANDLE)).toBe(false);

        // And the file is untouched by the failed attempt -- no re-initialisation, no overwrite.
        const after = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
        expect(after.wrap_password).toBe(keys.wrap_password);
        expect(after.salt_kek).toBe(keys.salt_kek);
    });
});
