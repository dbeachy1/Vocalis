import { Buffer } from 'node:buffer';

/**
 * THE RECOVERY KEY AS A HUMAN READS IT -- and this is presentation, not cryptography.
 *
 * It was the only code in `src/crypto/` whose job was producing text for a person's eyes: an alphabet
 * chosen for people who mis-transcribe, grouping chosen for people reading aloud, and parsing forgiving
 * enough to survive a phone photograph. None of that is a security property. The key is 32 random bytes
 * either way; this decides what they LOOK like on the piece of paper the user is told to keep.
 *
 * 🔴 **THE ONE SECURITY RULE THAT DOES LIVE HERE: SAY NOTHING BACK.** `parseRecoveryKey` reports
 * the OFFSET of a bad character, never the character. An error message quoting what the user typed is a
 * fragment of a master credential in a string any caller may log -- and the rest of this system is
 * careful about exactly that (`unlockWithRecoveryKey` refuses without saying why).
 *
 * ⚠️ An honest limit, unchanged by moving the file: these build the key as immutable JS
 * strings, which cannot be zeroed. `session.js` can wipe a Buffer; nothing can wipe a String. The
 * exposure is bounded by the key being shown once and then existing only as a wrap on disk.
 */

/** How many random bytes a recovery key carries. 256 bits, the same strength as the DEK it wraps. */
export const RECOVERY_KEY_BYTES = 32;

/** Crockford-ish Base32, minus the characters people mis-transcribe. */
const BASE32_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Render a recovery key the way BitLocker does: grouped Base32, transcribable by a human with a pen.
 *
 * The recovery key must be practical to store outside the application and transcribe reliably. The alphabet
 * omits I, O, 0, and 1 to reduce copying errors.
 * @param {Buffer} key The raw 32 bytes
 * @returns {string} `XXXXX-XXXXX-XXXXX-…`
 */
export function formatRecoveryKey(key) {
    let bits = '';

    for (const byte of key) {
        bits += byte.toString(2).padStart(8, '0');
    }

    // 32 bytes is 256 bits, and 256 is not a multiple of 5. Pad up to the next whole Base32 symbol
    // (260 bits, 52 characters) — otherwise the final bit falls off the end and one key in two fails to
    // round-trip. Found by the round-trip test, which is exactly what it is for.
    while (bits.length % 5 !== 0) {
        bits += '0';
    }

    let out = '';

    for (let i = 0; i < bits.length; i += 5) {
        out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
    }

    return (out.match(/.{1,5}/g) ?? []).join('-');
}

/**
 * Parse a recovery key back from what someone typed in.
 *
 * Forgiving about the things humans get wrong — case, dashes, stray spaces — and unforgiving about the
 * things that actually matter.
 * @param {string} text The recovery key as typed
 * @returns {Buffer} The raw 32 bytes
 */
export function parseRecoveryKey(text) {
    const cleaned = text.toUpperCase().replace(/[^A-Z2-9]/g, '');
    let bits = '';

    for (const [offset, character] of [...cleaned].entries()) {
        const value = BASE32_ALPHABET.indexOf(character);

        if (value < 0) {
            // 🔴 THE OFFSET, NOT THE CHARACTER — which is what this module's one stated security rule says,
            // fifty lines up, and what the code did not do. It echoed the character straight back.
            //
            // The leak is nil TODAY and only by accident: the filter above strips everything outside
            // [A-Z2-9], so the only characters that can reach here are `I` and `O` — the two letters the
            // alphabet deliberately omits — and neither is ever part of a real key. That safety is a
            // property of a regex seven lines away, with nothing marking it load-bearing. Widen it for any
            // reason (preserve case for a friendlier message, accept a checksum character, support a wider
            // transcription alphabet) and this line starts printing fragments of a MASTER CREDENTIAL into
            // an Error the fork renders to the user verbatim and is free to log.
            //
            // The offset is the more useful answer anyway: it says WHERE to look, which is the actual
            // question someone squinting at a hand-written key has.
            throw new Error(`Invalid character in recovery key, at position ${offset + 1}.`);
        }

        bits += value.toString(2).padStart(5, '0');
    }

    const bytes = Buffer.alloc(RECOVERY_KEY_BYTES);

    if (bits.length < RECOVERY_KEY_BYTES * 8) {
        throw new Error('Recovery key is too short.');
    }

    for (let i = 0; i < RECOVERY_KEY_BYTES; i++) {
        bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }

    return bytes;
}
