/**
 * Character cards — reading the JSON a SillyTavern card hides inside a PNG.
 *
 * 🔴 WHY THIS EXISTS AT ALL. The extraction prompt (`DESIGN_INGEST.md` §5) needs a **baseline**: the facts the
 * card already states, so the extractor does not store them again as though it had discovered them. The fork
 * **permanently refused** to put a `characterCard` field on `OutgoingPrompt` (fork §20.1) — deciding which
 * card fields matter, how to truncate them, and what a group chat means are all memory judgments it will not
 * freeze into a shared API. It gave us `context.readFile` instead and told us to make those judgments
 * ourselves. This module is where they are made.
 *
 * ⚠️ NO PNG LIBRARY, AND THAT IS DELIBERATE. `DESIGN.md`'s two-dependency rule is not a style preference: this
 * process holds a key derived from the user's vault DEK, and every package that runs beside it is another
 * supply chain that can reach it. A PNG chunk walk is fifty lines of pure arithmetic over a Buffer. It is not
 * worth a dependency, and `package.json`'s dependency note is the argument in full.
 *
 * ## The format, in one paragraph
 *
 * A PNG is an 8-byte signature followed by chunks. Each chunk is a 4-byte big-endian length, a 4-byte ASCII
 * type, that many bytes of data, and a 4-byte CRC. Text rides in `tEXt` chunks, whose data is
 * `keyword\0value` in Latin-1. SillyTavern writes the card as base64-encoded JSON under the keyword `chara`
 * (character card V2), and V3 cards additionally under `ccv3`. We read `ccv3` in preference to `chara` when
 * both are present, because a V3 writer emits both and the V2 copy is the lossy one.
 */

/**
 * A parsed card, exactly as its JSON decoded — never validated, never reshaped.
 *
 * 🔴 **A bag of unknowns, and that is the honest type rather than a shrug.** A card is a file people download
 * and trade: V1 puts the fields at the top level and V2/V3 nest them under `data`, writers add keys of their
 * own, and any field may be missing or hold something other than a string. Declaring `description: string`
 * here would state about a stranger's file the one thing nothing has checked — and would make {@link excerpt}'s
 * `typeof` test look like belt-and-braces when it is the only thing standing between a card that carries a
 * number and a `TypeError` inside an extraction.
 *
 * @typedef {Record<string, unknown>} CharacterCard
 */

/** The 8 bytes every PNG starts with. Anything else is not a PNG and is refused rather than guessed at. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** Chunk framing: 4-byte length + 4-byte type, then data, then a 4-byte CRC. */
const LENGTH_BYTES = 4;
const TYPE_BYTES = 4;
const CRC_BYTES = 4;

/**
 * The largest `tEXt` chunk this parser will turn into a string.
 *
 * Generous by three orders of magnitude — a full V2 card with a long description, greeting and example
 * dialogue is tens of kilobytes, base64'd — and the point is not to be tight. It is that a chunk length is a
 * number a hostile file chooses, and the only other bound on it is the file's own size.
 */
const MAX_TEXT_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * 🔴 A hard ceiling on how much card prose reaches the extraction prompt, per field.
 *
 * Card descriptions are routinely thousands of tokens — some are longer than the conversation window they
 * would be sharing the prompt with. The baseline exists to say "you already know this", which needs the
 * *gist*, not the text; an untruncated card would crowd out the very conversation we are extracting from and
 * make the whole pass worse than having no baseline at all. Truncation is therefore a correctness measure,
 * not a politeness.
 */
const FIELD_CHARS = 600;

/** And a ceiling on the assembled block, for the same reason applied to the sum of its parts. */
const BASELINE_CHARS = 2000;

/**
 * The card fields that belong in a memory baseline, in the order they are rendered.
 *
 * 🔴 THIS LIST IS THE MEMORY JUDGMENT THE FORK REFUSED TO MAKE, so it is worth saying why each is here.
 * `description`, `personality` and `scenario` are the card's standing claims about who this character is and
 * what situation they are in — exactly the material an extractor would otherwise "discover" in the first
 * conversation and store for ever.
 *
 * ⚠️ `first_mes` and `mes_example` are deliberately EXCLUDED. They are *sample dialogue* — demonstrations of
 * voice, not assertions of fact — and a baseline that included them would tell the extractor that things the
 * character merely said once are already-known truths. `creator_notes`, `system_prompt` and
 * `post_history_instructions` are excluded because they are instructions to the *engine*, not facts about the
 * character, and feeding engine instructions into an extraction prompt is a prompt-injection surface for no
 * benefit.
 */
const BASELINE_FIELDS = Object.freeze([
    ['description', 'Description'],
    ['personality', 'Personality'],
    ['scenario', 'Scenario'],
]);

/**
 * Walk a PNG's chunks and collect its `tEXt` entries.
 *
 * 🔴 EVERY READ IS BOUNDS-CHECKED AGAINST THE BUFFER, not against the length the file claims. A card is a file
 * from the internet — people trade them — so a chunk header that says "the next 4GB are mine" is an input to
 * handle, not an impossibility. An unchecked `subarray` would not throw here; it would silently return a short
 * buffer and we would decode garbage, which is the failure that looks like a working parse.
 *
 * The CRC is skipped rather than verified. We are not repairing images: a corrupt chunk yields JSON that fails
 * to parse, and that path is already handled. Verifying it would mean implementing CRC-32 to reject files that
 * the next step rejects anyway.
 *
 * @param {Buffer} bytes The PNG file
 * @returns {Map<string, string>} keyword → value, in file order (later duplicates win, as PNG allows)
 */
function readTextChunks(bytes) {
    const chunks = new Map();

    if (!Buffer.isBuffer(bytes) || bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error('not a PNG file');
    }

    let at = PNG_SIGNATURE.length;

    while (at + LENGTH_BYTES + TYPE_BYTES <= bytes.length) {
        const length = bytes.readUInt32BE(at);
        // 🔴 latin1, NOT ascii. Node's `ascii` decoder MASKS EACH BYTE TO 7 BITS, so a chunk typed with the
        // high bit set compares equal to a legitimate type: `\xC9\xC5\xCE\xC4` decodes as "IEND" and ends the
        // walk before the real `chara` chunk is reached — the card then parses to null, `renderBaseline`
        // returns '', and extraction proceeds with NO baseline, silently re-storing everything the card
        // already says as though it had been discovered. The mirror case (`\xF4\xC5\xD8\xF4` → "tEXt") feeds
        // arbitrary bytes to the keyword split. The chunk DATA below already uses latin1, for the same reason.
        const type = bytes.toString('latin1', at + LENGTH_BYTES, at + LENGTH_BYTES + TYPE_BYTES);
        const dataAt = at + LENGTH_BYTES + TYPE_BYTES;
        const nextAt = dataAt + length + CRC_BYTES;

        // The claimed length runs past the end of the file: truncated download, or a lie. Either way there is
        // nothing further to read, and continuing would mean trusting an offset the file made up.
        if (length > bytes.length || nextAt > bytes.length) {
            break;
        }

        // 🔴 A CEILING ON WHAT WE WILL MATERIALIZE AS A STRING, and it gates the DECODE rather than the walk.
        //
        // The bounds check above only proves the chunk fits inside the file, so a 600 MB PNG may legitimately
        // declare a 600 MB tEXt chunk. `data.toString('latin1', …)` would then build a ~600 MB string, and the
        // base64 decode plus the utf8 decode after it roughly double that — inside the process holding the
        // vault key. Past Node's ~512 MB string limit that is a clean RangeError which `readBaseline` catches;
        // below it, it is an OOM that takes down SillyTavern and every unlocked vault in it.
        //
        // ⚠️ Skipped, never `break`, and applied only to tEXt: a large IDAT is an ordinary large image, and
        // refusing to walk past one would make big cards unreadable. No real card's metadata is near this.
        if (type === 'tEXt' && length > MAX_TEXT_CHUNK_BYTES) {
            at = nextAt;
            continue;
        }

        if (type === 'tEXt') {
            const data = bytes.subarray(dataAt, dataAt + length);
            const split = data.indexOf(0);

            // A tEXt chunk with no NUL has no keyword, so there is nothing to key it by. Skip it rather than
            // inventing one.
            if (split > 0) {
                // 🔴 latin1, per the PNG spec, and NOT utf8. The payload here is base64 — ASCII either way —
                // but a keyword or a stray non-base64 tEXt decoded as utf8 would mangle bytes ≥ 0x80 into
                // replacement characters, and a parser that is right by accident stops being right when
                // someone hands it a card written by different software.
                chunks.set(data.toString('latin1', 0, split), data.toString('latin1', split + 1));
            }
        }

        // 🔴 IEND terminates the image. Anything after it is trailing junk, not chunks — some tools append
        // their own data there, and walking into it would be walking into arbitrary bytes.
        if (type === 'IEND') {
            break;
        }

        at = nextAt;
    }

    return chunks;
}

/**
 * Pull the character card JSON out of PNG bytes.
 *
 * ⚠️ **Returns `null` for "this PNG carries no card", and THROWS for "this is not a PNG".** The distinction is
 * the point: a plain image with no `chara` chunk is an ordinary, expected thing and the caller should proceed
 * without a baseline. Bytes that are not a PNG at all mean we were handed something other than what we asked
 * for, and silently treating that as "no card" would hide a wrong path or a truncated read behind a
 * degraded-but-working extraction.
 *
 * @param {Buffer} bytes The card PNG
 * @returns {CharacterCard|null} The card JSON, or null if this PNG carries none
 */
export function parseCard(bytes) {
    const chunks = readTextChunks(bytes);
    // V3 first: a V3 writer emits BOTH, and `chara` is then the down-converted copy. Preferring `chara`
    // because it is the better-known keyword would mean deliberately reading the lossy one.
    const encoded = chunks.get('ccv3') ?? chunks.get('chara');

    if (!encoded) {
        return null;
    }

    try {
        // 🔴 utf8 on the way OUT, latin1 on the way in. The base64 payload decodes to UTF-8 JSON — card text is
        // full of accented names and smart quotes — so decoding it as latin1 would mojibake every one of them
        // into the baseline and, from there, into stored memories.
        const json = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        return json && typeof json === 'object' ? json : null;
    } catch {
        // Corrupt or truncated payload. Not a card, and not worth failing an extraction over.
        return null;
    }
}

/**
 * Trim a card field to one line-preserving excerpt, or '' if it has nothing in it.
 *
 * @param {unknown} value A field off a {@link CharacterCard} — anything, including nothing. Only a string is
 *        usable, and every other type leaves here as `''` rather than as a stringified surprise in a prompt.
 * @param {number} limit
 * @returns {string}
 */
function excerpt(value, limit) {
    if (typeof value !== 'string') {
        return '';
    }

    // Card fields are written for a prompt, so they arrive with hard-wrapped newlines and runs of blank lines.
    // Collapsing them costs nothing and buys back budget that would otherwise be spent on whitespace.
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

/**
 * Render a card as the extraction prompt's CHARACTER BASELINE block (`DESIGN_INGEST.md` §5).
 *
 * Both card generations are handled: V2 and V3 nest the real fields under `data`, while the original V1 cards
 * put them at the top level. Reading `data` first and falling back keeps a decade of cards working without a
 * version check that would have to be right about which spec a file claims to follow.
 *
 * @param {CharacterCard|null} card The parsed card, or null
 * @returns {string} The block's contents, or '' when there is nothing worth saying
 */
export function renderBaseline(card) {
    const fields = card?.data && typeof card.data === 'object' ? card.data : card;

    if (!fields || typeof fields !== 'object') {
        return '';
    }

    const parts = [];

    for (const [key, label] of BASELINE_FIELDS) {
        // The cast says only what the guard above already established: this is *some* object, and a card's own
        // keys are whatever its writer chose. Reading one that is not there yields `undefined`, which is a value
        // {@link excerpt} handles — so the index is a lookup in a bag of unknowns, never a claim about the shape.
        const text = excerpt(/** @type {CharacterCard} */ (fields)[key], FIELD_CHARS);

        if (text) {
            parts.push(`${label}: ${text}`);
        }
    }

    const block = parts.join('\n');
    return block.length <= BASELINE_CHARS ? block : `${block.slice(0, BASELINE_CHARS).trimEnd()}…`;
}
