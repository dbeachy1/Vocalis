import * as storage from './storage.js';
import { readEnvelopeHeader } from './storage-envelope.js';
import { lookupProviderIdentity } from './storage-provenance.js';

/**
 * 🔒 "WHAT IS THE STATE OF THESE BYTES?" — the one answer, shared by everything that has to ask.
 *
 * Two callers need it and they must never disagree, because a disagreement between them is a lie to the
 * user in one direction or the other:
 *
 * - `endpoints/storage-private.js` draws the per-chat padlock (`DESIGN_MIXED_MODE.md` §6, §7, §11).
 * - `endpoints/backups.js` decides whether a backup can be viewed or restored at all (§9, §14.5).
 *
 * The logic was written for the first and then wanted by the second, so it lives here rather than being
 * copied. A copy would drift, and the drift would show up as a chat list that says a file needs the 'vault'
 * plugin while the restore button beside it cheerfully hands the ciphertext to the chat importer.
 *
 * ## The three states, and why "no provider claims it" is not "plaintext"
 *
 * The provider is asked first and is the only thing that may report `encrypted` for a file it can read —
 * only it knows what it did with the bytes. When nothing claims the path, that is *usually* plaintext, but
 * it is also exactly what an encrypted file looks like after its plugin has been uninstalled. §3 calls
 * collapsing those two together the original sin; the envelope header, which is readable with no provider
 * and no key, is what keeps them apart.
 */

/**
 * @typedef {object} StorageState
 * @property {boolean} encrypted True when some provider — installed or not — encrypted these bytes.
 * @property {boolean} unavailable True when the bytes are enveloped and nothing installed can decrypt them.
 * @property {string|null} requiresProvider The validated provider id needed to read it, or null for
 * *provider unknown*. 🔴 Never the raw string from the file: {@link readEnvelopeHeader} drops an id that
 * fails `[a-z0-9-]{1,32}` to null, so an attacker's string cannot reach a caller, let alone the DOM (§3.1).
 * @property {import('./storage-provenance.js').ProviderIdentity|null} [identity] 🪪 What the fork itself
 * recorded about that provider WHILE IT WAS INSTALLED, or null when it has no record — see below.
 * @property {boolean} [requiresUpdate] 🪪 The provider IS installed, but it wrote this file in an envelope
 * version the installed build cannot read (`DESIGN_STORAGE_PROVENANCE.md` §12.1). Distinct from
 * `unavailable`, which is the provider being GONE: this one is *"you have it, update it"*, and it is the only
 * state in this design that can be true while the provider is present and answering.
 */

/** The answer for a file nobody claims and that carries no envelope: an ordinary, unremarkable file. */
const PLAINTEXT = Object.freeze({ encrypted: false, unavailable: false, requiresProvider: null, identity: null });

/**
 * 🪪 THE VERSION-SKEW CHECK — *"you have the plugin and it still will not open, so UPDATE it"* — §12.1.
 *
 * Layered on top of the `encryptsPath` state rather than folded into it, because it is a strictly optional
 * enrichment of the one branch it applies to: the file is encrypted, the provider IS installed, and the only
 * question left is whether the installed build can read the version that wrote this file.
 *
 * 🔴 EVERY GUARD HERE IS "LEARN NOTHING, DISABLE NOTHING" ON null.
 * - `envelopeVersionAt` is null for a locked vault, a legacy file, a damaged header, a missing method, and
 *   more (its contract lists seven). null is UNKNOWN, never stale — so a null file version returns the state
 *   untouched. A readable chat must never be told to update anything.
 * - `providerReadableEnvelopeVersions` is null when the provider declared no readable versions. Silence must
 *   mean readable, so that too returns the state untouched.
 * - Skew is *"the file's version is not in the declared readable set"*. It is a set-membership test, NOT a
 *   presence test: a version 1 file against a build that declares `[1]` is a perfectly ordinary readable
 *   chat and must stay unmarked.
 *
 * 🔴 THE NAME COMES FROM THE LOADED PROVIDER, NEVER FROM THE FILE (§4, and the Vault session's Q2). This
 * branch is reached because `encryptsPath` matched, i.e. the LOADED provider owns these bytes — so its own
 * id is the honest key, and `lookupProviderIdentity` on it yields the name the "update the plugin" sentence
 * needs. Reading a name off the file's own header would be the one inference §4 exists to refuse, and it
 * would be an especially soft target here because the resulting sentence is an instruction to install
 * software. A provider recorded by id alone yields a null identity, and the sentence degrades to the bare id.
 * @param {string} absPath The path already established to be encrypted by the installed provider
 * @param {StorageState} state The base "encrypted and available" state to enrich
 * @returns {StorageState} The state, with `requiresUpdate` set when the installed build cannot read the file
 */
function withVersionSkew(absPath, state) {
    const fileVersion = storage.envelopeVersionAt(absPath);
    const readableVersions = storage.providerReadableEnvelopeVersions();

    if (fileVersion === null || readableVersions === null || readableVersions.includes(fileVersion)) {
        return state;
    }

    const loadedId = storage.getStorageProvider()?.id ?? null;

    return {
        ...state,
        requiresUpdate: true,
        requiresProvider: loadedId,
        identity: lookupProviderIdentity(loadedId),
    };
}

/**
 * Describe one file's storage state.
 *
 * Never throws and never decrypts. The envelope read is a {@link readEnvelopeHeader} prefix read of the raw
 * bytes on disk — deliberately not through the storage facade, because the case this exists to serve is
 * *the provider is not installed at all*, where reading through the facade would either fail or, worse,
 * remove the very thing being inspected.
 * @param {string|null|undefined} absPath Absolute path to the file, or null when it did not resolve
 * @returns {StorageState} The state
 */
export function describeStorageState(absPath) {
    if (!absPath) {
        return { ...PLAINTEXT };
    }

    // The installed provider's own answer, when there is one. This is the ordinary case and it is the only
    // one that can report `encrypted: true` with `unavailable: false`.
    if (storage.encryptsPath(absPath)) {
        return withVersionSkew(absPath, { encrypted: true, unavailable: false, requiresProvider: null, identity: null });
    }

    const header = readEnvelopeHeader(absPath);

    if (!header) {
        return { ...PLAINTEXT };
    }

    // 🔴 THE FILE IS THERE AND WE COULD NOT LOOK. Not plaintext, and not a named provider's either — we do
    // not know, and the honest rendering of "we do not know" is the same fail-closed one we give a file
    // whose provider is gone. `requiresProvider` stays null because naming one would be a guess, and
    // `encrypted` stays false because a padlock is a claim about the bytes and we have not read them. What
    // matters is `unavailable`, which is what stops a caller writing over it.
    if (header.unreadable) {
        return { encrypted: false, unavailable: true, requiresProvider: null, identity: null };
    }

    // Enveloped, but nothing installed will decrypt it. §11: SHOW it, disabled, naming what it needs —
    // hiding it is how a user concludes their data is gone and stops looking for it.
    //
    // 🪪 AND NAME IT PROPERLY IF THE FORK EVER WATCHED THAT PROVIDER RUN
    // (`DESIGN_STORAGE_PROVENANCE.md` §4, §7). The id is all the FILE can be believed about — it sits
    // outside the crypto, so anyone who can write to the data directory can set it to anything. What turns
    // it into a name comes from somewhere else entirely: the fork's own registry, written while the plugin
    // was installed and running, and stored outside the directory this threat model assumes is hostile.
    //
    // So the id is the KEY and never the source of the answer. A planted file naming a provider that was
    // never here looks up nothing and gets today's bare-id sentence, which is exactly right.
    return {
        encrypted: true,
        unavailable: true,
        requiresProvider: header.providerId,
        identity: lookupProviderIdentity(header.providerId),
    };
}

/**
 * 🪪 "I COULD NOT READ THIS FILE — IS THAT BECAUSE ITS PLUGIN IS GONE?" — `DESIGN_STORAGE_PROVENANCE.md`
 * §7 surface 4, for the list endpoints that are not chats.
 *
 * Characters, worlds, backgrounds and settings all reach the same fork in the road: a read or a parse fails,
 * and the handler has to decide what to put in the list. Every one of them currently decides *nothing* —
 * the entry is dropped, or worse, kept with its contents silently emptied — and §3's third user moment is
 * the result: a user learns about their chats and then discovers the rest one failure at a time.
 *
 * 🔴 **AN EMPTY ITEM IS THE DANGEROUS ANSWER, NOT THE SAFE ONE.** A world info file whose bytes are an
 * envelope parses to `undefined`, and the handler's `|| {}` turns that into a world that lists normally,
 * opens normally, and is *editable* — sitting on top of the user's real entries. Saving it writes over them.
 * So this is not cosmetic: naming the file's provider is what stops the UI offering an edit box for data it
 * cannot see.
 *
 * ⚠️ Only an ENVELOPE earns this answer. An ordinary corrupt file, a truncated download, a PNG that is not a
 * character card — none of those are a missing plugin, and claiming they were would send a user hunting for
 * an uninstall that never happened. Anything without a parseable header returns null and the caller keeps
 * whatever it did before.
 * @param {string|null|undefined} absPath Absolute path to the file the caller could not read
 * @returns {StorageState|null} The state to attach to the list entry, or null when this failure has nothing
 * to do with a storage provider
 */
export function describeUnavailableData(absPath) {
    const state = describeStorageState(absPath);
    return state.unavailable ? state : null;
}
