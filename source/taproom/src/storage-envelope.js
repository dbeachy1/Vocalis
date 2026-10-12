import fs from 'node:fs';

/**
 * 🔀 THE ENVELOPE HEADER — the only part of an encrypted file the fork is allowed to understand.
 *
 * `DESIGN_MIXED_MODE.md` §3 needs a structural marker so the three states stay separate: ours-and-readable,
 * ours-and-broken, and not-ours. §3.1 then adds a requirement that reshapes it — **a chat whose provider is
 * gone must still be able to say which provider it needs**, so the user reads "install the 'vault' plugin"
 * instead of staring at a dead row.
 *
 * That is only possible if the fork can read the provider's name with no provider loaded and no key. So the
 * header is not a Vault-private blob; it is a shared public grammar that every storage provider writes and
 * this module parses:
 *
 *     <magic>:<version>:<provider-id>:<the provider's own opaque remainder>
 *
 * The fork reads the first three fields and never looks past the third colon. Everything after it belongs
 * to the provider (§13).
 *
 * ## 🔴 The provider id is UNTRUSTED DISPLAY TEXT
 *
 * It sits OUTSIDE the crypto by necessity — it has to be readable without a key — so anyone who can write
 * to the data directory can set it to anything at all. §3.1 is explicit about what follows:
 *
 * - **Character-class and length-cap it on read.** `[a-z0-9-]{1,32}` and nothing else. A file whose id
 *   fails reports as *provider unknown*, NEVER as its claimed id. That is why {@link parseEnvelopeHeader}
 *   returns `providerId: null` rather than the raw string — a caller cannot accidentally render what an
 *   attacker wrote, because it never reaches them.
 * - **Render as text, never as markup.**
 * - 🔴 **Never build a URL, an install command, or a fetch out of it.** "This chat requires plugin X" must
 *   not become a one-click path to installing whatever a planted file names. Show the id; let the user go
 *   and find it. The temptation to add a helpful *Install* button is precisely the vulnerability.
 *
 * ## Why this reads raw `fs` and not the storage facade
 *
 * Deliberate, and it is the whole point. The header describes the bytes AS THEY SIT ON DISK. Reading
 * through the provider would either decrypt them — removing the very thing being inspected — or fail,
 * because the case this exists to serve is *the provider is not installed at all*.
 */

/**
 * The magic. Fork-owned (§13), because a marker every provider has to agree on cannot belong to any one of
 * them.
 *
 * This answers the fork's half of open question §14.1: a provider may NOT reuse its own private envelope
 * (Vault's `esk1:`) as the outer marker, because the first three fields are a public grammar. Its format
 * begins after the third colon, where the fork never looks.
 */
export const ENVELOPE_MAGIC = 'stenv';

/** The longest a valid provider id may be (§3.1). */
export const MAX_PROVIDER_ID_LENGTH = 32;

/**
 * The most of a file this module will ever look at.
 *
 * A valid header is at most `stenv:` + 4 version digits + `:` + 32 id characters + `:` = 44 bytes, so 64 is
 * generous. The cap is not an optimisation — it is the length check of §3.1 and it is what makes §12's 4 KB
 * planted id a non-event: the terminating colon never arrives inside the window, so the id is rejected
 * without the 4 KB ever being read, let alone returned to a caller.
 */
export const MAX_HEADER_BYTES = 64;

/** `[a-z0-9-]{1,32}` and nothing else. Anchored at both ends so a partial match cannot pass. */
const PROVIDER_ID_PATTERN = new RegExp(`^[a-z0-9-]{1,${MAX_PROVIDER_ID_LENGTH}}$`);

/** Up to four digits, so a version cannot be used to consume the whole window. */
const VERSION_PATTERN = /^[0-9]{1,4}$/;

/** The largest envelope version the grammar above can express — four digits and no more. */
export const MAX_ENVELOPE_VERSION = 9999;

/**
 * Is this a provider id the fork is willing to handle at all?
 *
 * 🔴 EXPORTED SO THERE IS EXACTLY ONE COPY OF THE RULE. `storage-provenance.js` keys its registry by this
 * same id, and a second, separately-written `[a-z0-9-]{1,32}` would eventually drift from this one. The
 * drift would not look like a bug: it would look like a registry entry that simply never matches the file
 * naming it, which is the failure mode hardest to notice and hardest to explain.
 * @param {unknown} id The candidate id
 * @returns {boolean} True if it passes the same check {@link parseEnvelopeHeader} applies
 */
export function isValidProviderId(id) {
    return typeof id === 'string' && PROVIDER_ID_PATTERN.test(id);
}

/**
 * @typedef {object} EnvelopeHeader
 * @property {number} version The envelope version.
 * @property {string|null} providerId The provider id, or **null** when the file carried one that failed
 * validation. Null means *provider unknown* and is never the attacker's string.
 * @property {boolean} [unreadable] True when the file is THERE and could not be opened, so nothing can be
 * said about its contents either way. Distinct from a null return, which means genuinely absent. See
 * {@link readEnvelopeHeader}.
 */

/**
 * Parse an envelope header out of the first bytes of a file.
 *
 * 🔴 A FULL STRUCTURAL CHECK, NOT A PREFIX SUBSTRING (§12 test 13). Every field is validated — magic,
 * version shape, and the id's character class — so a plaintext chat whose first bytes coincidentally begin
 * `stenv:` is correctly reported as not an envelope rather than being treated as a broken encrypted file.
 * Getting that backwards would refuse to open a legitimate chat.
 * @param {Buffer|string} bytes The leading bytes of the file
 * @returns {EnvelopeHeader|null} The header, or null if these bytes are not an envelope at all
 */
export function parseEnvelopeHeader(bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf-8');

    // 🔴 `latin1`, NOT `utf-8`, AND THE REASON IS ARITHMETIC RATHER THAN CHARACTERS.
    //
    // What sits in this window after the third colon is the provider's opaque remainder, and for a real
    // provider that is CIPHERTEXT — arbitrary bytes. Decoded as UTF-8, any valid multi-byte sequence in it
    // collapses several bytes into ONE code unit, and any invalid one becomes U+FFFD; either way the
    // string's length and every index into it stop matching the buffer, by an amount that depends on the
    // file's contents. Measured on a real Vault-shaped body: 28 bytes decoded to 23 code units.
    //
    // Nothing here is wrong today, because both terminators arrive at bytes 6 and 14 — inside the ASCII
    // header, before any binary — and this function returns only a number and a validated id. The hazard is
    // the next change: the moment anything computes an offset into this string (a body offset, a slice, a
    // length) it is wrong by a ciphertext-dependent amount, which is close to the worst shape of bug this
    // codebase can produce. `latin1` is the identity map from bytes to code units, so indices are byte
    // indices, permanently.
    //
    // Behaviour for every valid header is unchanged: the magic, the digits, the colons and the id's
    // `[a-z0-9-]` class are all ASCII, where latin1 and utf-8 agree byte for byte. Raised by the
    // SillyTavern-Vault session, which hit it from the other side and made the same change.
    const window = buffer.subarray(0, MAX_HEADER_BYTES).toString('latin1');
    const prefix = `${ENVELOPE_MAGIC}:`;

    if (!window.startsWith(prefix)) {
        return null;
    }

    const afterMagic = window.slice(prefix.length);
    const versionEnd = afterMagic.indexOf(':');

    if (versionEnd < 1 || !VERSION_PATTERN.test(afterMagic.slice(0, versionEnd))) {
        return null;
    }

    const version = Number(afterMagic.slice(0, versionEnd));
    const afterVersion = afterMagic.slice(versionEnd + 1);
    const idEnd = afterVersion.indexOf(':');

    // No terminator inside the window means the id is longer than the cap allows -- the 4 KB case. The file
    // is still structurally an envelope; it is its ID that is unusable, so this is `provider unknown`
    // rather than `not ours`. Reporting it as not-ours would hand a broken encrypted chat to the
    // regenerate paths, which is the §3 mistake.
    if (idEnd < 0) {
        return { version, providerId: null };
    }

    const claimed = afterVersion.slice(0, idEnd);
    return { version, providerId: PROVIDER_ID_PATTERN.test(claimed) ? claimed : null };
}

/**
 * Read a file's envelope header, if it has one.
 *
 * A short prefix read — never a full read, and never a decrypt. §6.1 notes the chat-list endpoint calls
 * this once per chat, so a 200-chat list is 200 of these; it stays cheap only as long as it reads
 * {@link MAX_HEADER_BYTES} and stops.
 * @param {string} absPath Absolute path to the file on disk
 * @returns {EnvelopeHeader|null} The header, or null if the file is not an envelope, is unreadable, or
 * does not exist. A missing file is not an error here: the chat list asks about rows that may have just
 * been deleted.
 */
export function readEnvelopeHeader(absPath) {
    /** @type {number|undefined} */
    let handle;

    try {
        handle = fs.openSync(absPath, 'r');
        const buffer = Buffer.alloc(MAX_HEADER_BYTES);
        const read = fs.readSync(handle, buffer, 0, MAX_HEADER_BYTES, 0);
        return parseEnvelopeHeader(buffer.subarray(0, read));
    } catch (error) {
        // 🔴 ABSENT AND UNREADABLE ARE NOT THE SAME ANSWER, AND COLLAPSING THEM FAILS OPEN.
        //
        // Only the missing-file case is "no envelope" — that is the one the chat list needs, because it asks
        // about rows that may have just been deleted, and it is the only one the docstring ever justified.
        // Every other errno was being given the same answer, which is the dangerous direction: on EACCES,
        // EIO or EMFILE the file is THERE and we simply could not look, and reporting "not an envelope"
        // tells `describeUnavailableData` there is nothing to protect. The fail-closed guards then stand
        // down — a World Book lists, opens and is EDITABLE on top of the user's real entries, and saving
        // writes over them; a backup is served as raw bytes into the chat importer; the padlock quietly
        // disappears, and §7.2 makes its absence the signal that a chat is NOT protected.
        //
        // So: absent is null, and anything else is "present, and we cannot say" — which the caller must
        // treat as unavailable rather than as plaintext.
        const code = /** @type {{code?: string}} */ (error)?.code;

        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
            return null;
        }

        return { version: 0, providerId: null, unreadable: true };
    } finally {
        if (handle !== undefined) {
            fs.closeSync(handle);
        }
    }
}

/**
 * Is this file encrypted by some provider, whether or not that provider is installed?
 *
 * The question §11 needs answered with no provider loaded, so a chat whose plugin has been uninstalled can
 * be shown in the list as present-but-unavailable rather than hidden. Hiding the row is how a user
 * concludes their data is gone and stops looking for it.
 * @param {string} absPath Absolute path to the file on disk
 * @returns {boolean} True if the file carries a valid envelope header
 */
export function hasEnvelope(absPath) {
    return readEnvelopeHeader(absPath) !== null;
}
