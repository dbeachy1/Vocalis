import { Buffer } from 'node:buffer';

import { describe, test, expect } from '@jest/globals';

import { cmac, sivEncrypt, sivDecrypt } from '../src/crypto/aes-siv.js';

/**
 * 🔴 RFC 5297'S OWN TEST VECTORS.
 *
 * AES-SIV is implemented here rather than imported, because Node does not expose it and the alternative
 * was an npm dependency — in a project whose entire threat model is a poisoned npm dependency.
 *
 * That trade is only defensible if the implementation is PROVEN, not merely plausible. A subtly wrong
 * SIV does not crash and does not look wrong: it produces a vault that encrypts, decrypts, round-trips
 * cleanly in every test you would think to write, and is quietly worthless. Nobody would ever find out.
 *
 * So these are not my test vectors. They are the RFC's, byte for byte, from §A.1 and §A.2. If they pass,
 * the construction is the one the standard specifies. If they fail, nothing else in this repository is
 * worth anything at all.
 */
describe('🔴 AES-SIV against RFC 5297', () => {
    test('§A.1 — deterministic authenticated encryption', () => {
        const key = Buffer.from('fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff', 'hex');
        const ad = Buffer.from('101112131415161718191a1b1c1d1e1f2021222324252627', 'hex');
        const plaintext = Buffer.from('112233445566778899aabbccddee', 'hex');

        // The RFC prints the synthetic IV and the ciphertext separately; on the wire they are
        // concatenated, IV first.
        const expected = Buffer.from('85632d07c6e8f37f950acd320a2ecc9340c02b9690c4dc04daef7f6afe5c', 'hex');

        const sealed = sivEncrypt(key, [ad], plaintext);
        expect(sealed.toString('hex')).toBe(expected.toString('hex'));

        // And it must come back.
        expect(sivDecrypt(key, [ad], sealed).toString('hex')).toBe(plaintext.toString('hex'));
    });

    test('§A.2 — nonce-based authenticated encryption, with multiple associated-data strings', () => {
        const key = Buffer.from('7f7e7d7c7b7a79787776757473727170404142434445464748494a4b4c4d4e4f', 'hex');
        const ad1 = Buffer.from('00112233445566778899aabbccddeeffdeaddadadeaddadaffeeddccbbaa99887766554433221100', 'hex');
        const ad2 = Buffer.from('102030405060708090a0', 'hex');
        const nonce = Buffer.from('09f911029d74e35bd84156c5635688c0', 'hex');
        const plaintext = Buffer.from('7468697320697320736f6d6520706c61696e7465787420746f20656e6372797074207573696e67205349562d414553', 'hex');

        const expected = Buffer.from('7bdb6e3b432667eb06f4d14bff2fbd0fcb900f2fddbe404326601965c889bf17dba77ceb094fa663b7a3f748ba8af829ea64ad544a272e9c485b62a3fd5c0d', 'hex');

        // In SIV the nonce is simply the LAST associated-data string. There is no separate nonce
        // parameter, which is exactly what makes the construction usable deterministically: leave the
        // nonce out and you get the same answer every time, on purpose.
        const sealed = sivEncrypt(key, [ad1, ad2, nonce], plaintext);
        expect(sealed.toString('hex')).toBe(expected.toString('hex'));
        expect(sivDecrypt(key, [ad1, ad2, nonce], sealed).toString('hex')).toBe(plaintext.toString('hex'));
    });

    test('AES-CMAC against RFC 4493', () => {
        // SIV is built on CMAC, so CMAC gets its own vectors. RFC 4493 §4, AES-128.
        const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');

        expect(cmac(key, Buffer.alloc(0)).toString('hex')).toBe('bb1d6929e95937287fa37d129b756746');
        expect(cmac(key, Buffer.from('6bc1bee22e409f96e93d7e117393172a', 'hex')).toString('hex')).toBe('070a16b46b4d4144f79bdd9dd04a287c');
        expect(cmac(key, Buffer.from('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411', 'hex')).toString('hex')).toBe('dfa66747de9ae63030ca32611497c827');
    });
});

describe('AES-SIV: the properties we actually rely on', () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');

    test('it is DETERMINISTIC — the same name always encrypts to the same bytes', () => {
        // This is the entire reason SIV is here. If the same filename encrypted differently each time,
        // you could never open a file again without trial-decrypting every entry in the directory.
        const name = Buffer.from('a chat.jsonl', 'utf-8');
        const ad = [Buffer.from('chats/Test Character 1', 'utf-8')];

        const first = sivEncrypt(key, ad, name);
        const second = sivEncrypt(key, ad, name);

        expect(first.toString('hex')).toBe(second.toString('hex'));
    });

    test('the parent directory is bound in — the same name under two characters encrypts DIFFERENTLY', () => {
        // Without this, `chat_1.jsonl` under two different characters would produce identical
        // ciphertext, leaking that they are the same chat name — and, worse, letting an attacker move a
        // file from one character's directory into another's and have it still authenticate.
        const name = Buffer.from('chat_1.jsonl', 'utf-8');

        const underOne = sivEncrypt(key, [Buffer.from('chats/Test User', 'utf-8')], name);
        const underTwo = sivEncrypt(key, [Buffer.from('chats/Test Character 2', 'utf-8')], name);

        expect(underOne.toString('hex')).not.toBe(underTwo.toString('hex'));
    });

    test('a transplanted name FAILS to authenticate', () => {
        const name = Buffer.from('secret.jsonl', 'utf-8');
        const sealed = sivEncrypt(key, [Buffer.from('chats/Test User', 'utf-8')], name);

        // Move the encrypted filename into another directory and try to read it there.
        expect(() => sivDecrypt(key, [Buffer.from('chats/Test Character 2', 'utf-8')], sealed)).toThrow(/authentication failed/i);
    });

    test('a single flipped bit FAILS to authenticate', () => {
        const sealed = sivEncrypt(key, [Buffer.from('chats', 'utf-8')], Buffer.from('a chat.jsonl', 'utf-8'));

        const tampered = Buffer.from(sealed);
        tampered[tampered.length - 1] ^= 0x01;

        expect(() => sivDecrypt(key, [Buffer.from('chats', 'utf-8')], tampered)).toThrow(/authentication failed/i);
    });

    test('the wrong key FAILS to authenticate, rather than returning garbage', () => {
        const sealed = sivEncrypt(key, [], Buffer.from('a chat.jsonl', 'utf-8'));
        const wrong = Buffer.alloc(64, 0xab);

        expect(() => sivDecrypt(wrong, [], sealed)).toThrow(/authentication failed/i);
    });

    test('an empty name round-trips', () => {
        const sealed = sivEncrypt(key, [], Buffer.alloc(0));
        expect(sivDecrypt(key, [], sealed).length).toBe(0);
    });
});

/**
 * 🔴 A wrong-length key must be reported as an input error, not as tampering.
 *
 * Decryption must reject an invalid key length before authentication. Otherwise a caller error is reported
 * as possible tampering or a wrong key, sending investigation toward intact stored data.
 */
describe('🔴 both directions reject a key of the wrong length', () => {
    const associated = [Buffer.from('chats'), Buffer.from('a chat.jsonl')];

    test('sivEncrypt refuses', () => {
        expect(() => sivEncrypt(Buffer.alloc(48), associated, Buffer.from('x'))).toThrow(/32- or 64-byte key/);
    });

    test('🔴 sivDecrypt refuses too, and does not call it tampering', () => {
        const sealed = sivEncrypt(Buffer.alloc(64), associated, Buffer.from('secret'));

        expect(() => sivDecrypt(Buffer.alloc(48), associated, sealed)).toThrow(/32- or 64-byte key/);
        expect(() => sivDecrypt(Buffer.alloc(48), associated, sealed)).not.toThrow(/tampered/);
    });

    test('a CORRECT key of either legal length still round-trips', () => {
        for (const length of [32, 64]) {
            const key = Buffer.alloc(length, 7);
            const sealed = sivEncrypt(key, associated, Buffer.from('secret'));

            expect(sivDecrypt(key, associated, sealed).toString()).toBe('secret');
        }
    });
});
