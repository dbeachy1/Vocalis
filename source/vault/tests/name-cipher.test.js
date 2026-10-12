import crypto from 'node:crypto';

import { describe, test, expect } from '@jest/globals';

import { deriveSubkeys } from '../src/crypto/vault.js';
import {
    MAX_ENCRYPTED_NAME_LENGTH,
    NAME_SCHEME_MIXED,
    decryptName,
    encryptName,
    isLongName,
    isSidecar,
    loadName,
    storeName,
} from '../src/crypto/name-cipher.js';

const { kNames } = deriveSubkeys(crypto.randomBytes(32));

describe('filename encryption', () => {
    test('a name round-trips', () => {
        const encrypted = encryptName(kNames, 'chats/Test Character 1', 'a chat.jsonl');

        expect(encrypted).not.toContain('a chat');
        expect(decryptName(kNames, 'chats/Test Character 1', encrypted)).toBe('a chat.jsonl');
    });

    test('it is DETERMINISTIC — you can open a file by name instead of scanning the directory', () => {
        const a = encryptName(kNames, 'characters', 'Test Character 1.png');
        const b = encryptName(kNames, 'characters', 'Test Character 1.png');

        expect(a).toBe(b);
    });

    test('the parent directory is bound in', () => {
        // Otherwise `chat_1.jsonl` under two characters encrypts identically, which leaks that they are
        // the same name — and lets an attacker move a file between characters undetected.
        const underCharacterOne = encryptName(kNames, 'chats/Test Character 1', 'chat_1.jsonl');
        const underCharacterTwo = encryptName(kNames, 'chats/Test Character 2', 'chat_1.jsonl');

        expect(underCharacterOne).not.toBe(underCharacterTwo);
        expect(() => decryptName(kNames, 'chats/Test Character 2', underCharacterOne)).toThrow(/authentication failed/i);
    });

    test('the encrypted name is filesystem-safe', () => {
        // base64url: no slashes, no plus signs, nothing that would create a directory by accident.
        const encrypted = encryptName(kNames, 'chats', 'a chat: with / awkward \\ characters?.jsonl');

        expect(encrypted).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test('unicode survives', () => {
        const name = '日本語のキャラクター.png';

        expect(decryptName(kNames, 'characters', encryptName(kNames, 'characters', name))).toBe(name);
    });
});

describe('🔴 the long-name fallback — "not an edge case, it is Tuesday"', () => {
    // Encryption plus base64url inflates a name ~1.4x against a hard 255-byte limit, and SillyTavern
    // builds chat filenames as `<character name> - <timestamp>.jsonl`. The design calls this the single
    // most likely thing to ship broken, and says to test it with a deliberately absurd name NOW rather
    // than discover it only after importing a card with a long title.
    //
    // So here is the absurd name.
    const ABSURD = 'Test Character 1 the Sample Archive Guardian of the Sample Woodland and Keeper of the Seventh Seal - 2026-07-13@04h20m00s000ms.jsonl';

    test('a normal name does NOT need the fallback', () => {
        const stored = storeName(kNames, 'chats/Test Character 1', 'a chat.jsonl');

        expect(stored.isLong).toBe(false);
        expect(stored.sidecarName).toBeUndefined();
        expect(stored.fileName.length).toBeLessThanOrEqual(MAX_ENCRYPTED_NAME_LENGTH);
    });

    test('🔴 an absurd name DOES, and it does not explode', () => {
        const stored = storeName(kNames, 'chats/Test Character 1', ABSURD);

        expect(stored.isLong).toBe(true);
        expect(stored.sidecarName).toBe(`${stored.fileName}.nm`);
        expect(stored.sidecarContent.length).toBeGreaterThan(MAX_ENCRYPTED_NAME_LENGTH);

        // And the thing that actually goes on disk is short enough to BE on disk.
        expect(stored.fileName.length).toBeLessThan(255);
        expect(stored.sidecarName.length).toBeLessThan(255);
    });

    test('🔴 and it comes back', () => {
        const stored = storeName(kNames, 'chats/Test Character 1', ABSURD);

        // Stand in for the filesystem: the provider will read the companion file here.
        const sidecars = { [stored.sidecarName]: stored.sidecarContent };
        const recovered = loadName(kNames, 'chats/Test Character 1', stored.fileName, (name) => sidecars[name]);

        expect(recovered).toBe(ABSURD);
    });

    test('a short name round-trips through the same path, without a companion file', () => {
        const stored = storeName(kNames, 'chats/Test Character 1', 'a chat.jsonl');
        const recovered = loadName(kNames, 'chats/Test Character 1', stored.fileName, () => {
            throw new Error('Should not have looked for a companion file.');
        });

        expect(recovered).toBe('a chat.jsonl');
    });

    test('a MISSING companion file is a loud error, not a silently wrong name', () => {
        const stored = storeName(kNames, 'chats/Test Character 1', ABSURD);

        expect(() => loadName(kNames, 'chats/Test Character 1', stored.fileName, () => undefined))
            .toThrow(/companion file .* is missing/i);
    });

    test('companion files are recognisable, so the provider can hide them from readdir', () => {
        // 🔴 If a sidecar ever leaked into a directory listing, SillyTavern would try to parse it as a
        // chat — and data-maid would report it as an orphan and offer to delete it.
        const stored = storeName(kNames, 'chats/Test Character 1', ABSURD);

        expect(isSidecar(stored.sidecarName)).toBe(true);
        expect(isLongName(stored.fileName)).toBe(true);

        expect(isSidecar(stored.fileName)).toBe(false);
        expect(isLongName(stored.sidecarName)).toBe(false);
    });

    test('the fallback is still deterministic', () => {
        const a = storeName(kNames, 'chats/Test Character 1', ABSURD);
        const b = storeName(kNames, 'chats/Test Character 1', ABSURD);

        expect(a.fileName).toBe(b.fileName);
        expect(a.sidecarContent).toBe(b.sidecarContent);
    });

    test('a genuinely ridiculous name — 400 characters — still works', () => {
        const ridiculous = `${'A'.repeat(380)} - a chat.jsonl`;
        const stored = storeName(kNames, 'chats', ridiculous);
        const sidecars = { [stored.sidecarName]: stored.sidecarContent };

        expect(stored.fileName.length).toBeLessThan(255);
        expect(loadName(kNames, 'chats', stored.fileName, (n) => sidecars[n])).toBe(ridiculous);
    });
});

describe('🔴 a long name whose own extension is `.nm` — the companion-file ambiguity', () => {
    // A long marked name carries its logical extension in the clear, so a logical name over ~113 characters
    // ending in `.nm` is stored as `venl1~<digest>.nm` — character for character the shape of the companion
    // file belonging to `venl1~<digest>`. Judged on the name alone the two are indistinguishable, and the
    // old classifier called both of them companions: the user's file was encrypted correctly, written
    // correctly, and then hidden from `readdir`, the UI and `data-maid` for as long as it existed.
    //
    // What settles it is the directory. Only one of the two readings puts a `.nm.nm` on disk.
    const LOGICAL = `${'B'.repeat(200)} - notes.nm`;
    const stored = storeName(kNames, 'chats', LOGICAL, NAME_SCHEME_MIXED);
    const listing = new Set([stored.fileName, stored.sidecarName]);
    const hasSibling = (name) => listing.has(name);
    const readSidecar = (name) => (name === stored.sidecarName ? stored.sidecarContent : undefined);

    test('the collision is real — this name really is stored in the companion-file shape', () => {
        // If this ever stops holding, the rest of this block is testing nothing.
        expect(stored.isLong).toBe(true);
        expect(stored.fileName.endsWith('.nm')).toBe(true);
        expect(stored.sidecarName).toBe(`${stored.fileName}.nm`);
    });

    test('given the listing, the user\'s file is a long name and NOT a companion', () => {
        expect(isSidecar(stored.fileName, hasSibling)).toBe(false);
        expect(isLongName(stored.fileName, hasSibling)).toBe(true);
    });

    test('and it round-trips, instead of decoding as garbage', () => {
        // `isLongName` returning false is not a cosmetic misfiling: `loadName` would take the digest for
        // ciphertext and try to decrypt it, which throws — and `readdir` skips an entry it cannot decode.
        expect(loadName(kNames, 'chats', stored.fileName, readSidecar, hasSibling)).toBe(LOGICAL);
    });

    test('its OWN companion is still hidden — the fix must not un-hide bookkeeping', () => {
        expect(isSidecar(stored.sidecarName, hasSibling)).toBe(true);
        expect(isLongName(stored.sidecarName, hasSibling)).toBe(false);
    });

    test('an ordinary long name is unaffected: companion hidden, file listed', () => {
        const ordinary = storeName(kNames, 'chats', `${'C'.repeat(200)} - a chat.jsonl`, NAME_SCHEME_MIXED);
        const both = new Set([ordinary.fileName, ordinary.sidecarName]);
        const near = (name) => both.has(name);

        expect(isSidecar(ordinary.sidecarName, near)).toBe(true);
        expect(isSidecar(ordinary.fileName, near)).toBe(false);
        expect(isLongName(ordinary.fileName, near)).toBe(true);
    });

    test('⚠️ with NO listing the answer is the old one, and that is the deliberate floor', () => {
        // A caller with no directory in hand cannot tell the two apart. "Companion" is the safer guess:
        // hiding a file is recoverable, whereas offering a companion to SillyTavern as a chat invites
        // `data-maid` to delete the only copy of somebody's filename. Every caller that CAN answer, does.
        expect(isSidecar(stored.fileName)).toBe(true);
        expect(isLongName(stored.fileName)).toBe(false);
    });
});
