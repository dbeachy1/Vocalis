/**
 * The `Range` header, parsed.
 *
 * ## Why this exists at all
 *
 * `res.sendFile()` reads from the disk itself, so the provider cannot use it for an encrypted file -- it
 * would send ciphertext. The encrypted branch therefore decrypts and writes the bytes out itself, and in
 * doing so it inherited none of the behaviour `send` gives away for free. `Range` was the one that mattered:
 * every request got `200` and the whole body.
 *
 * A browser asks for a range when it seeks in an `<audio>` or `<video>` element. Answering `200` with the
 * whole file is not a protocol error and nothing crashes -- which is exactly why it survived. It just means
 * dragging the scrubber re-downloads the entire clip, and some players will not seek at all without a `206`.
 *
 * ## What is deliberately NOT honoured
 *
 * A multi-range request (`bytes=0-99, 200-299`) returns `undefined` here, so the caller sends the whole body
 * with `200`. That is what `send` itself does: assembling a `multipart/byteranges` response is a good deal of
 * machinery for something no browser sends for media playback.
 *
 * ⚠️ AND NOTHING HERE READS A FILE. It is given the size and returns arithmetic, so every edge case below is
 * testable without a disk.
 */

/**
 * @typedef {object} ByteRange
 * @property {number} start First byte to send, inclusive
 * @property {number} end Last byte to send, inclusive
 */

/**
 * Work out which bytes a `Range` header is asking for.
 *
 * 🔴 THE THREE ANSWERS ARE DIFFERENT AND THE CALLER MUST TELL THEM APART:
 *
 *   `undefined`            -> no usable range. Send the whole body, `200`, exactly as before.
 *   `{ unsatisfiable }`    -> a range that cannot be met. `416`, with `Content-Range: bytes  * /<size>`.
 *   `{ start, end }`       -> `206`, with `Content-Range` and only those bytes.
 *
 * Collapsing the middle one into the first is the tempting simplification and it is wrong: a client that
 * asked for byte 5,000 of a 100-byte file has made a mistake, and answering `200` with the whole file tells
 * it the request succeeded. It then writes those bytes at offset 5,000.
 * @param {unknown} header The raw `Range` header, if there was one
 * @param {number} size The full length of the body, in bytes
 * @returns {ByteRange|{unsatisfiable: true}|undefined} What to send
 */
export function parseByteRange(header, size) {
    if (typeof header !== 'string') {
        return undefined;
    }

    // Only `bytes` is a defined unit, and only a single range is handled here. Anything else -- a multi-range
    // list, a unit we do not know, plain rubbish -- falls through to the whole body, which is always a valid
    // answer to a range request.
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

    if (!match) {
        return undefined;
    }

    const [, rawStart, rawEnd] = match;

    // `bytes=-` is neither a range nor an error; there is nothing in it to honour.
    if (rawStart === '' && rawEnd === '') {
        return undefined;
    }

    let start;
    let end;

    if (rawStart === '') {
        // A SUFFIX range: `bytes=-500` means the LAST 500 bytes, not the first 500. Getting this backwards
        // serves the wrong half of the file with a `206` that claims it is the right half.
        const suffix = Number(rawEnd);

        // "the last zero bytes" cannot be satisfied -- and it is not the same as "no range given".
        if (suffix === 0) {
            return { unsatisfiable: true };
        }

        start = Math.max(0, size - suffix);
        end = size - 1;
    } else {
        start = Number(rawStart);

        // An end past the last byte is clamped, not refused: asking for more than exists is explicitly
        // allowed, and `bytes=0-` (everything from the start) is the commonest range a player sends.
        end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    }

    // ⚠️ `start >= size` CATCHES THE EMPTY FILE TOO. With `size === 0` there is no byte 0 to serve, so every
    // range over it is unsatisfiable -- which is what RFC 9110 says, and what a naive `start > end` misses.
    if (start > end || start >= size) {
        return { unsatisfiable: true };
    }

    return { start, end };
}
