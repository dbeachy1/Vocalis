import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import {
    ENVELOPE_MAGIC,
    MAX_HEADER_BYTES,
    MAX_PROVIDER_ID_LENGTH,
    hasEnvelope,
    parseEnvelopeHeader,
    readEnvelopeHeader,
} from '../src/storage-envelope.js';

import { ENVELOPE_HEADER as FIXTURE_HEADER } from './fixtures/mixed-provider.js';
import { makeScratchDirectory } from './util/st-server.js';

/**
 * 🔀 THE ENVELOPE HEADER PARSER — `DESIGN_MIXED_MODE.md` §3.1.
 *
 * Two jobs, and the second is a security boundary.
 *
 * **Structural classification.** §3 needs ours-and-broken to stay distinguishable from not-ours, because
 * collapsing them hands a damaged chat to the six SillyTavern code paths that respond to unreadable data
 * by regenerating it from source. A parser that matched on a prefix substring instead of the full grammar
 * would put a legitimate plaintext chat that happens to begin `stenv:` into the broken-encrypted bucket.
 *
 * **The id is attacker-controlled.** It lives outside the crypto because it must be readable with no key,
 * so anyone who can write to the data directory can set it to anything. §12's test 9a plants
 * `<script>alert(1)</script>` and a 4 KB string. Neither may ever reach a caller: the parser returns
 * `providerId: null` — *provider unknown* — rather than handing back what was written, so a caller cannot
 * render it even by mistake.
 */

/** @type {string} */
let scratch;

beforeAll(() => {
    scratch = makeScratchDirectory('envelope');
});

afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * Write a file with the given first bytes.
 * @param {string} name File name
 * @param {string} contents Contents
 * @returns {string} Absolute path
 */
function planted(name, contents) {
    const p = path.join(scratch, name);
    fs.writeFileSync(p, contents);
    return p;
}

describe('parsing a well-formed header', () => {
    test('reads the version and the provider id, and stops at the third colon', () => {
        const header = parseEnvelopeHeader('stenv:1:vault:whatever the provider put here');

        expect(header).toEqual({ version: 1, providerId: 'vault' });
    });

    test('the opaque remainder is never inspected, however strange it is', () => {
        const header = parseEnvelopeHeader('stenv:1:vault:::::not:even:slightly:well:formed');

        expect(header).toEqual({ version: 1, providerId: 'vault' });
    });

    test('accepts a Buffer, which is what a prefix read actually produces', () => {
        expect(parseEnvelopeHeader(Buffer.from('stenv:2:some-provider:xyz'))).toEqual({
            version: 2,
            providerId: 'some-provider',
        });
    });

    test('🔴 agrees with the header the fixture independently writes', () => {
        // The fixture spells its header out as a literal rather than importing this module, so that the two
        // sides of a wire format cannot drift together silently. This is the test that catches it if they
        // ever disagree.
        expect(parseEnvelopeHeader(FIXTURE_HEADER + 'body')).toEqual({
            version: 1,
            providerId: 'mixed-provider',
        });
    });
});

describe('🔴 not an envelope at all — the full structural check of §12 test 13', () => {
    test('an ordinary plaintext chat', () => {
        expect(parseEnvelopeHeader('{"name":"an ordinary chat"}\n')).toBeNull();
    });

    test('a plaintext file whose first bytes merely resemble the magic', () => {
        // Refusing this would break a legitimate chat, so it must be null and not "broken envelope".
        expect(parseEnvelopeHeader('stenvelope of a letter I pasted into a chat')).toBeNull();
        expect(parseEnvelopeHeader('stenv is a word I typed')).toBeNull();
    });

    test('the magic alone, with nothing after it', () => {
        expect(parseEnvelopeHeader('stenv:')).toBeNull();
        expect(parseEnvelopeHeader('stenv')).toBeNull();
    });

    test('a non-numeric or empty version', () => {
        expect(parseEnvelopeHeader('stenv::vault:body')).toBeNull();
        expect(parseEnvelopeHeader('stenv:one:vault:body')).toBeNull();
        expect(parseEnvelopeHeader('stenv:1x:vault:body')).toBeNull();
    });

    test('a version long enough to swallow the window', () => {
        expect(parseEnvelopeHeader(`stenv:${'9'.repeat(40)}:vault:body`)).toBeNull();
    });

    test('empty input', () => {
        expect(parseEnvelopeHeader('')).toBeNull();
        expect(parseEnvelopeHeader(Buffer.alloc(0))).toBeNull();
    });
});

/**
 * §12 test 9a. The file is structurally an envelope, so it is still OURS — reporting it as not-ours would
 * hand a broken encrypted chat to the regenerate paths. What is unusable is the id, so the answer is
 * *provider unknown*.
 */
describe('🔴 a planted provider id is rejected and never returned', () => {
    test('markup is rejected — and the caller receives null, not the markup', () => {
        const header = parseEnvelopeHeader('stenv:1:<script>alert(1)</script>:body');

        expect(header).not.toBeNull();
        expect(header.version).toBe(1);
        expect(header.providerId).toBeNull();
        // The point of the whole exercise: the string cannot be rendered because it never arrives.
        expect(JSON.stringify(header)).not.toContain('script');
    });

    test('a 4 KB id is rejected without the 4 KB ever being read', () => {
        const header = parseEnvelopeHeader(`stenv:1:${'a'.repeat(4096)}:body`);

        expect(header).toEqual({ version: 1, providerId: null });
    });

    test('an id one character over the cap is rejected; one exactly at the cap is accepted', () => {
        const tooLong = 'a'.repeat(MAX_PROVIDER_ID_LENGTH + 1);
        const exact = 'a'.repeat(MAX_PROVIDER_ID_LENGTH);

        expect(parseEnvelopeHeader(`stenv:1:${tooLong}:body`).providerId).toBeNull();
        expect(parseEnvelopeHeader(`stenv:1:${exact}:body`).providerId).toBe(exact);
    });

    test('uppercase, spaces, dots, slashes and path traversal are all rejected', () => {
        for (const bad of ['Vault', 'my vault', 'va.ult', 'va/ult', '../../etc/passwd', 'vault!', '']) {
            expect(parseEnvelopeHeader(`stenv:1:${bad}:body`).providerId).toBeNull();
        }
    });

    test('the character class accepts exactly lowercase, digits and hyphen', () => {
        expect(parseEnvelopeHeader('stenv:1:abc-123:body').providerId).toBe('abc-123');
    });

    test('🔴 a BINARY body behind the header — the real shape, and the one nothing tested', () => {
        // 🔴 THE WINDOW IS DECODED AS `latin1` BECAUSE THE BODY IS CIPHERTEXT, NOT TEXT.
        //
        // Every other case in this file has an ASCII body, so the whole suite would pass with a decoder
        // that mangles arbitrary bytes. A real provider writes its own opaque remainder immediately after
        // the third colon — for SillyTavern-Vault that is `STV1` and then raw AES-GCM output — and decoded
        // as UTF-8 a valid multi-byte sequence in there collapses several BYTES into one CODE UNIT.
        //
        // The header still parses either way today, because both terminators land at bytes 6 and 14 inside
        // the ASCII part. This test exists for the change after next: it pins the decoder, so that anyone
        // who later computes an offset into that window gets a BYTE offset rather than one that drifts with
        // the file's contents. Raised by the Vault session, which hit it from the other side.
        const body = Buffer.from([0x53, 0x54, 0x56, 0x31, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x92, 0xa9, 0x41, 0x00, 0xff]);
        const file = Buffer.concat([Buffer.from('stenv:1:vault:', 'latin1'), body]);

        expect(parseEnvelopeHeader(file)).toEqual({ version: 1, providerId: 'vault' });

        // And the same bytes off a real disk, which is how every caller actually reaches this.
        const p = planted('binary-body.jsonl', file);
        expect(readEnvelopeHeader(p)).toEqual({ version: 1, providerId: 'vault' });
        expect(hasEnvelope(p)).toBe(true);
    });

    test('🔴 a lone 0x3A in a binary body cannot forge the id terminator into something valid', () => {
        // A raw ciphertext byte may happen to be `:`. If one is mistaken for the third colon the claimed id
        // is whatever binary preceded it — which must fail `[a-z0-9-]{1,32}` and come back as null, never as
        // an attacker-shaped string. Belt and braces on the character class, with real bytes.
        const file = Buffer.concat([Buffer.from('stenv:1:', 'latin1'), Buffer.from([0xff, 0x80, 0x3a, 0x41, 0x42])]);
        const header = parseEnvelopeHeader(file);

        expect(header.version).toBe(1);
        expect(header.providerId).toBeNull();
    });

    test('🔴 never reads more than the cap, whatever the file claims', () => {
        // A guard against a future "just read a bit more to be helpful" change: the window is the length
        // check, so widening it silently reintroduces the 4 KB case.
        expect(MAX_HEADER_BYTES).toBeLessThanOrEqual(64);
        expect(ENVELOPE_MAGIC).toBe('stenv');
    });
});

describe('reading a header off disk', () => {
    test('reads an enveloped file', () => {
        const p = planted('encrypted.jsonl', 'stenv:1:vault:ciphertext-goes-here');

        expect(readEnvelopeHeader(p)).toEqual({ version: 1, providerId: 'vault' });
        expect(hasEnvelope(p)).toBe(true);
    });

    test('a plaintext chat has no envelope', () => {
        const p = planted('plain.jsonl', '{"name":"plain"}\n');

        expect(readEnvelopeHeader(p)).toBeNull();
        expect(hasEnvelope(p)).toBe(false);
    });

    test('a file shorter than the window does not throw', () => {
        const p = planted('tiny.jsonl', 'st');

        expect(readEnvelopeHeader(p)).toBeNull();
        expect(hasEnvelope(p)).toBe(false);
    });

    test('an empty file does not throw', () => {
        const p = planted('empty.jsonl', '');

        expect(readEnvelopeHeader(p)).toBeNull();
    });

    test('🔴 a missing file answers cleanly instead of throwing', () => {
        // The chat list asks about rows that may have just been deleted, so this must never throw.
        const missing = path.join(scratch, 'no-such-file.jsonl');

        expect(() => readEnvelopeHeader(missing)).not.toThrow();
        expect(readEnvelopeHeader(missing)).toBeNull();
        expect(hasEnvelope(missing)).toBe(false);
    });

    test('a directory answers cleanly instead of throwing', () => {
        const dir = path.join(scratch, 'a-directory');
        fs.mkdirSync(dir, { recursive: true });

        expect(() => readEnvelopeHeader(dir)).not.toThrow();
        expect(readEnvelopeHeader(dir)).toBeNull();
    });
});
