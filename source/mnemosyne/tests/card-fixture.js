import zlib from 'node:zlib';

/**
 * Real character-card PNGs, built byte by byte, shared by every suite that needs one.
 *
 * 🔴 THESE ARE ACTUAL PNGs AND THAT IS THE POINT. The risk in `src/card.js` is entirely in the arithmetic —
 * chunk offsets, the NUL split, latin1 versus utf8, what happens after IEND — and a fixture that returned a
 * canned object would exercise none of it. The ingest suite needs the same guarantee for a different reason:
 * a fake card that skipped the parse would let a broken `readBaseline` pass by handing it a shape the real
 * `context.readCharacterCard` never returns.
 *
 * This module lives outside `*.test.js` on purpose — jest's default `testMatch` ignores it, so it is a helper
 * rather than a suite with no tests in it.
 */

/**
 * 🔴 The parser's OWN card type, imported rather than restated. A fixture that declared its own shape would be
 * free to drift from `src/card.js`, and a fixture that has drifted is a suite testing a card format nobody
 * ships — which is the failure this milestone is for.
 *
 * @typedef {import('../src/card.js').CharacterCard} CharacterCard
 */

/**
 * CRC-32, only so the fixtures are well-formed PNGs rather than shapes that happen to parse.
 *
 * @param {Buffer} buffer The chunk's type bytes followed by its data — never the length or the CRC itself
 * @returns {number} The unsigned 32-bit checksum, as `writeUInt32BE` wants it
 */
function crc32(buffer) {
    // zlib ships it; this is a test helper, not plugin code, so it costs no dependency and no runtime surface.
    return zlib.crc32 ? zlib.crc32(buffer) : legacyCrc32(buffer);
}

/**
 * Node < 22.2 has no zlib.crc32. Same polynomial, 20 lines, keeps the suite portable.
 *
 * @param {Buffer} buffer
 * @returns {number}
 */
function legacyCrc32(buffer) {
    let crc = 0xFFFFFFFF;

    for (const byte of buffer) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
        }
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * One PNG chunk, framed: 4-byte big-endian length, 4-byte type, the data, 4-byte CRC.
 *
 * ⚠️ `type` is a **latin1** string and the suites rely on that: `chunk('\xC9\xC5\xCE\xC4', …)` builds the
 * high-bit type that `card.test.js` proves does not masquerade as `IEND`. Typing this `string` rather than a
 * union of the four real types is what keeps that fixture expressible.
 *
 * 🔴 The length written here is `data.length` — the REAL length. A fixture that wants a lying header edits the
 * bytes afterward (`bytes.writeUInt32BE(0xFFFFFF, 8)`), so the lie stays visible at the call site.
 *
 * @param {string} type Four latin1 characters
 * @param {Buffer} data The chunk payload, which may be empty
 * @returns {Buffer}
 */
export function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);

    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));

    return Buffer.concat([length, typed, crc]);
}

/**
 * A `tEXt` chunk: `keyword\0value`, both latin1, exactly as the PNG spec says and as `src/card.js` reads it.
 *
 * @param {string} keyword `chara`, `ccv3`, or whatever an ordinary image happens to carry
 * @param {string} value The payload — base64 for a card chunk, prose for anything else
 * @returns {Buffer}
 */
export function textChunk(keyword, value) {
    return chunk('tEXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(value, 'latin1'),
    ]));
}

export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
export const IHDR = chunk('IHDR', Buffer.alloc(13));
export const IEND = chunk('IEND', Buffer.alloc(0));

/**
 * A PNG carrying the given tEXt entries, in order, framed exactly as a real card is.
 *
 * @param {Array<[string, string]>} entries `[keyword, value]` pairs — order matters, because a later duplicate
 *        wins in the parser's map and one suite depends on that
 * @returns {Buffer}
 */
export function png(entries) {
    return Buffer.concat([SIGNATURE, IHDR, ...entries.map(([k, v]) => textChunk(k, v)), IEND]);
}

/**
 * A card PNG whose `chara` chunk holds this object, encoded the way SillyTavern encodes it.
 *
 * ⚠️ The card is a {@link CharacterCard} — `src/card.js`'s own typedef, a bag of unknowns — rather than a shape
 * restated here. The suites feed this V1 cards, V2 cards, a V3 card and cards with fields the spec never
 * mentioned, because that is what people actually trade; a fixture that declared `description: string` would
 * refuse the very inputs the parser exists to survive.
 *
 * @param {CharacterCard} card
 * @param {string} [keyword] The tEXt keyword to file it under — `ccv3` for the V3-wins fixtures
 * @returns {Buffer}
 */
export function cardPng(card, keyword = 'chara') {
    return png([[keyword, Buffer.from(JSON.stringify(card), 'utf8').toString('base64')]]);
}

/** The card the suites play against: a V2 card with every baseline field filled and both excluded ones too. */
export const V2_CARD = Object.freeze({
    spec: 'chara_card_v2',
    data: {
        name: 'Test Character 1',
        description: 'A blacksmith in the village of Sample Town 4. Has a burn scar on her right forearm.',
        personality: 'Blunt, loyal, slow to trust.',
        scenario: 'You have come to her forge to commission a blade.',
        first_mes: 'She looks up from the anvil. "You again."',
        mes_example: '<START>\n{{char}}: "Mind the sparks."',
    },
});
