import { Buffer } from 'node:buffer';

/**
 * The OUTER envelope — the only bytes of ours a stranger is meant to be able to read.
 *
 * ## Why this exists at all, when `STV1` already marks our files
 *
 * `content-cipher.js` puts a `STV1` magic at the head of every encrypted file, and for a long time that was
 * enough: it told *us* the file was ours. It cannot tell anyone else, because nothing outside this plugin
 * knows what `STV1` means — and the moment that matters is precisely the moment this plugin is **not
 * installed**.
 *
 * `DESIGN_MIXED_MODE.md` §11: a user who removes the plugin must not find their encrypted chats have
 * silently vanished from every list. The row has to still be there, disabled, saying **which plugin to put
 * back**. SillyTavern can only draw that row if it can read the provider's name off the file with no
 * provider loaded and no key. So the marker cannot be ours to define:
 *
 *     stenv:<version>:<provider-id>:<our own opaque remainder>
 *
 * The fork owns the first three fields (`src/storage-envelope.js`, `ENVELOPE_MAGIC`) because a marker every
 * provider must agree on cannot belong to one of them. Ours begins at the fourth, where the fork never
 * looks — and what sits there is exactly the `STV1` file the content cipher already produced, unchanged.
 *
 * 🔴 **This answers §14.1: `esk1:` may NOT be reused as the outer marker.** The key-value store's envelope
 * is a Vault-private tag with no version field and no provider field; wearing it on the outside would make
 * every chat unattributable to a fork that has never heard of us. The two are unrelated and both stay.
 *
 * ## What it is not
 *
 * 🔴 **It is a ROUTING boundary, not a security one, and nothing here is authenticated.** The header is in
 * the clear, it is outside the AEAD, and anyone who can write to the data directory can forge or strip it.
 * That is fine and it is by design — it discloses only "this file is encrypted", which the ciphertext
 * behind it already screams. An attacker who strips it turns a readable chat into a corrupt one, which is
 * vandalism they could do more cheaply with `rm`.
 *
 * What it must never become is a *decision procedure for whether to trust the bytes*. The authenticity
 * check is GCM's, one layer down, and it is unchanged.
 *
 * ## ⚠️ And this is why it does not live in `src/crypto/`
 *
 * It did, and the placement said something false about it. There is no cryptography in this file: it
 * imports `node:buffer` and nothing else, it authenticates nothing, and every byte it writes is in the
 * clear. Filing it under `crypto/` invited exactly the reading the section above spends a paragraph
 * refusing — that the header is something to trust.
 *
 * It also dragged a presentation module into the crypto directory. `strings.js` imports `PROVIDER_ID`
 * and `ENVELOPE_VERSION` from here to build the user-facing `storage.identity` record, so answering
 * "what is this plugin called?" meant reaching into `src/crypto/` for a product identifier.
 *
 * ## 🔴 The header length is load-bearing arithmetic
 *
 * `stat().size` becomes `Content-Length`, and `provider.js` computes the logical size from the on-disk size
 * with no key and no read. Prepending a header moves that arithmetic by exactly
 * {@link ENVELOPE_HEADER_BYTES}, and getting it wrong does not throw — it makes every HTTP response for an
 * encrypted file truncate by fourteen bytes or hang waiting for fourteen that never come. The header is a
 * FIXED-LENGTH ASCII literal for this reason: a variable-length one would make the logical size unknowable
 * without reading the file.
 */

/** Fork-owned (`src/storage-envelope.js`). Ours only in the sense that we must write it exactly. */
export const ENVELOPE_MAGIC = 'stenv';

/**
 * 🔴 PERMANENT. Changing it orphans every file a user already has.
 *
 * It is not a display name and it is not a version — it is the join key between bytes on a disk and a
 * plugin a human has to go and find. `DESIGN_STORAGE_PROVENANCE.md` §8 is explicit that changing it is "a
 * breaking change for the user's data, not a rename". It must also equal the `id` this plugin reports from
 * `describe('storage.identity')` and the `id` on the provider object, or the fork refuses the declaration
 * as inconsistent — `tests/envelope.test.js` pins all three together.
 *
 * The fork validates it as `[a-z0-9-]{1,32}` on read; `vault` is well inside that.
 */
export const PROVIDER_ID = 'vault';

/**
 * The envelope format version — NOT the plugin's version, and not the content cipher's.
 *
 * It changes only when the bytes after the third colon change shape in a way an older build cannot read.
 * A file whose version we do not know is *ours and unreadable* (`EPROVIDER`), never *not ours*: the fork
 * turns that into "update the plugin", which is a different sentence from "install the plugin" and is the
 * one the user can act on.
 */
export const ENVELOPE_VERSION = 1;

/** What we write, byte for byte. */
export const ENVELOPE_HEADER = `${ENVELOPE_MAGIC}:${ENVELOPE_VERSION}:${PROVIDER_ID}:`;

/** How much longer an enveloped file is than the `STV1` blob inside it. See the docblock: this is arithmetic. */
export const ENVELOPE_HEADER_BYTES = Buffer.byteLength(ENVELOPE_HEADER, 'ascii');

/**
 * The most of a file we will look at to find a header.
 *
 * Mirrors the fork's `MAX_HEADER_BYTES`. The cap is not an optimisation — it is the length check. A planted
 * file whose "provider id" is four kilobytes long never has its terminating colon arrive inside the window,
 * so it is rejected without the four kilobytes ever being read.
 */
export const MAX_HEADER_BYTES = 64;

/** `[a-z0-9-]{1,32}`, anchored, exactly as the fork validates it. */
const PROVIDER_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

/** Up to four digits, so a version cannot be used to eat the whole window. */
const VERSION_PATTERN = /^[0-9]{1,4}$/;

/**
 * @typedef {object} ParsedEnvelope
 * @property {number} version The envelope version the file claims.
 * @property {string|null} providerId The provider id, or **null** when the file carried one that failed
 * validation. Null means *unknown*, and is never the string an attacker wrote.
 * @property {number} bodyOffset Where the provider's own bytes begin.
 */

/**
 * Parse an envelope header off the front of some bytes.
 *
 * 🔴 A FULL STRUCTURAL CHECK, NOT A PREFIX SUBSTRING — and `DESIGN_MIXED_MODE.md` §12 test 13 exists
 * because getting this backwards is a data-loss bug in the quiet direction. A legacy plaintext chat whose
 * first line happens to begin `stenv:` must come back as *not an envelope*, or a perfectly good file is
 * classified as broken ciphertext and refused for ever. Every field is validated: the magic, the version's
 * shape, the id's character class, and the presence of the terminating colon inside the window.
 * @param {Buffer|string} bytes The leading bytes of a file
 * @returns {ParsedEnvelope|null} The header, or null if these bytes are not an envelope at all
 */
export function parseEnvelope(bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf-8');

    // 🔴 `latin1`, not `utf-8`. The window is a fixed byte count cut out of the middle of a binary file, so
    // its tail is very likely a partial multi-byte sequence -- and `utf-8` would silently replace that with
    // U+FFFD, which is three bytes where one was. Every offset computed from the decoded string would then
    // be wrong by an amount that depends on the ciphertext. `latin1` is the identity map from bytes to code
    // units, so an index into the string is an index into the buffer. The header itself is pure ASCII, so
    // nothing about the grammar cares which of the two is used -- only the arithmetic does.
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

    const afterVersion = afterMagic.slice(versionEnd + 1);
    const idEnd = afterVersion.indexOf(':');
    const version = Number(afterMagic.slice(0, versionEnd));

    // No terminator inside the window: the id is longer than the cap allows. The file is still structurally
    // an envelope, so this is *provider unknown* rather than *not ours* -- calling it not-ours would hand a
    // broken encrypted file to the six paths that regenerate on unreadable data.
    if (idEnd < 0) {
        return { version, providerId: null, bodyOffset: MAX_HEADER_BYTES };
    }

    const claimed = afterVersion.slice(0, idEnd);
    const bodyOffset = prefix.length + versionEnd + 1 + idEnd + 1;

    return {
        version,
        providerId: PROVIDER_ID_PATTERN.test(claimed) ? claimed : null,
        bodyOffset,
    };
}

/**
 * Wrap a sealed `STV1` blob in the public envelope.
 * @param {Buffer} sealed The output of the content cipher
 * @returns {Buffer} The bytes to put on disk
 */
export function wrapEnvelope(sealed) {
    return Buffer.concat([Buffer.from(ENVELOPE_HEADER, 'ascii'), sealed]);
}

/**
 * Strip our envelope, or say why we cannot.
 *
 * 🔴 THE CALLER HAS ALREADY ESTABLISHED FROM THE NAME THAT THIS FILE IS OURS, so every failure here is
 * *ours and broken* rather than *not ours*, and the distinction is the whole of §3. This function therefore
 * never falls back to returning the raw bytes: a caller that got the plaintext-shaped answer would serve
 * ciphertext to SillyTavern, which parses it, fails, and regenerates the chat from nothing.
 *
 * It returns a reason rather than throwing so that the provider can raise its own `StorageError` with the
 * logical path attached — this module has no idea what path it is looking at, and an error that cannot name
 * the file is an error nobody can act on.
 * @param {Buffer} raw The bytes on disk
 * @returns {{ok: true, sealed: Buffer}|{ok: false, reason: string}} The `STV1` blob, or why not
 */
export function unwrapEnvelope(raw) {
    const parsed = parseEnvelope(raw);

    if (!parsed) {
        return { ok: false, reason: 'it carries no storage envelope, so it was not written by this plugin in a form this plugin can recognise' };
    }

    if (parsed.providerId !== PROVIDER_ID) {
        // Either a validation failure (null) or genuinely another provider's file living under a name that
        // says it is ours. Both are unreadable here, and neither may be reported as its claimed id -- §3.1
        // is emphatic that the id is untrusted display text and must never be echoed back as fact.
        return { ok: false, reason: `it was written by a different storage provider (${parsed.providerId === null ? 'whose name failed validation' : `'${parsed.providerId}'`})` };
    }

    if (parsed.version !== ENVELOPE_VERSION) {
        return { ok: false, reason: `it uses storage envelope version ${parsed.version}, and this build understands version ${ENVELOPE_VERSION}. Update the plugin` };
    }

    return { ok: true, sealed: raw.subarray(parsed.bodyOffset) };
}

/**
 * Is this file one of ours, judged from its first bytes alone?
 *
 * Keyless and cheap by construction — `DESIGN_MIXED_MODE.md` §6.1 notes the chat list asks this once per
 * chat, so a 200-chat list is 200 of these. It must stay a prefix check and must never become a decrypt.
 * @param {Buffer} bytes The leading bytes of a file
 * @returns {boolean} True if the bytes carry OUR envelope specifically
 */
export function isOurEnvelope(bytes) {
    return parseEnvelope(bytes)?.providerId === PROVIDER_ID;
}
