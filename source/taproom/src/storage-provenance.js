import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { isValidProviderId, MAX_ENVELOPE_VERSION } from './storage-envelope.js';
import { isPathUnderParent } from './util.js';
import { log, LogClass } from './logger.js';

/**
 * 🪪 THE PROVENANCE REGISTRY — turning a bare id into something a human can act on.
 *
 * `DESIGN_STORAGE_PROVENANCE.md`. The envelope already records WHICH provider wrote a file, and the fork
 * already reads it with no provider loaded and no key. What it could not do was say anything more useful
 * than repeating the slug: *"This chat requires the 'vault' storage provider."* A user who did not install
 * that plugin themselves — a second machine, a restored backup, a year later — has nothing to go on.
 *
 * ## 🔴 THE IDEA THE WHOLE THING RESTS ON, AND THE ONE THING NOT TO GET BACKWARDS
 *
 * The id on the file is UNTRUSTED. It sits outside the crypto by necessity, so anyone who can write to the
 * data directory can set it to anything. §4 therefore inverts where identity comes from:
 *
 * > **Identity is recorded while the provider is PRESENT and trusted, and looked up later when it is gone.**
 * > The file on disk supplies only a key. Everything shown to the user comes from the fork's own record of a
 * > provider it actually ran.
 *
 * A running provider may be trusted with this because it is already executing in the server process — a
 * hostile plugin does not need to lie about its name to hurt you. A file on disk may not.
 *
 * So a planted chat naming `evil-plugin` finds no record and shows the bare id, exactly as today. A planted
 * chat naming `vault` shows the REAL provider's details, which tells the user nothing false: those details
 * describe the plugin they genuinely installed, and the planted file still will not decrypt.
 *
 * ⚠️ **This is why the registry cannot live in the data directory.** An attacker who can write a planted
 * chat could write a planted registry entry beside it, and the inversion above would buy nothing. The file
 * goes next to `config.yaml` — the same trust class — and {@link registryPathFor} refuses outright to place
 * it under the data root (§9 test 7).
 *
 * 🔴 **Nothing here may become a link, a fetch, or an install command** (§3.1, §5). `source` is recorded
 * from a running plugin, which makes it ACCURATE; accuracy does not make an auto-installer safe. Show it,
 * and let the user go and get it.
 *
 * ⚠️ **An enrichment, never a dependency.** A registry that is missing, unreadable, or malformed must leave
 * every surface behaving byte-for-byte as it does with no registry at all — which is to say, as the fork
 * behaved before this file existed. Every read path here returns null rather than throwing, and the callers
 * already draw the bare-id sentence for null.
 */

/** What the registry file is called, in the server root beside `config.yaml`. */
export const REGISTRY_FILE_NAME = 'providers.json';

/** The schema version of the file itself, so a later shape change can be recognised rather than guessed. */
const REGISTRY_VERSION = 1;

/**
 * Length caps for the provider's own declared strings.
 *
 * §6: a running provider is trusted not to be HOSTILE; it is not trusted to be WELL-FORMED. A 4 MB `name` is
 * a bug rather than an attack, and it must fail exactly the same way — there is one validation path and it
 * does not care which of the two it is looking at.
 */
const MAX_NAME_LENGTH = 64;
const MAX_SOURCE_LENGTH = 192;
const MAX_VERSION_LENGTH = 32;
const MAX_ENVELOPE_VERSIONS = 16;

/**
 * A display name: printable, one line, and no angle brackets.
 *
 * The angle brackets are not because markup could execute — every surface renders this with `textContent`,
 * and §9 test 5 asserts that separately. They are because a name containing markup is a name that is trying
 * to be something else, and the cheapest moment to refuse it is before it is stored.
 */
const NAME_PATTERN = /^[^\x00-\x1f<>]{1,64}$/;

/** A version string as a human writes one: `2.3.0`, `1.0.0-beta.2`. */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

/**
 * Where a provider came from: an `http(s)` URL, or a bare package name.
 *
 * 🔴 THE SCHEME LIST IS THE POINT, AND IT IS AN ALLOW-LIST. `javascript:`, `data:` and `file:` are refused
 * because this string is going to be put in front of a user who may copy it somewhere that DOES follow it.
 * The fork never follows it — §5 is absolute about that — but "we happen not to click it" is a property of
 * today's code, and this is a property of the data.
 */
const SOURCE_PATTERN = /^(https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{1,185}|[@A-Za-z0-9][@A-Za-z0-9._/-]{0,63})$/;

/**
 * @typedef {object} ProviderIdentity
 * @property {string} id The envelope key. Equal to the provider's `id`, or the declaration is refused.
 * @property {string} [name] What a human looks for — *"SillyTavern-Vault"*.
 * @property {string} [source] Where it came from. 🔴 Display text. Never followed.
 * @property {string} [version] For telling *update the plugin* from *install the plugin*.
 * @property {number[]} [envelopeVersions] Which envelope versions this build can READ.
 * @property {string} [firstSeen] When the fork first ran it. The fork's own clock.
 * @property {string} [lastSeen] When the fork last ran it — *"you had this installed until 12 June"*.
 * @property {boolean} [conflict] Two different providers have claimed this id; show the id alone (§8).
 */

/**
 * The loaded registry, keyed by provider id. Empty until {@link loadProvenanceRegistry} says otherwise,
 * which is the state every test and every fork-without-a-registry runs in.
 * @type {Record<string, ProviderIdentity>}
 */
let entries = Object.create(null);

/**
 * Where the registry file lives, once someone has said. Null means nothing was loaded, and every read
 * answers null — the "no registry" behaviour, which is today's behaviour.
 * @type {string|null}
 */
let registryPath = null;

/**
 * Where the registry belongs, given a server root — and a refusal when that is the wrong kind of place.
 *
 * 🔴 THE DATA-ROOT CHECK IS THE THREAT MODEL, NOT A TIDINESS RULE (§9 test 7). The entire design assumes the
 * data directory is writable by an attacker — that assumption is why the id on the file is untrusted in the
 * first place. A registry sitting in there would be forgeable by exactly the party the registry exists to
 * defend against, and the forgery would be *more* convincing than the planted file, because the fork would
 * render its name with confidence.
 * @param {string} serverRoot The server's own directory — the trust class of `config.yaml`
 * @param {string} [dataRoot] The data root, refused as a parent
 * @returns {string} Absolute path to the registry file
 * @throws {Error} If the resolved path would sit inside the data root
 */
export function registryPathFor(serverRoot, dataRoot) {
    const resolved = path.resolve(serverRoot, REGISTRY_FILE_NAME);

    if (dataRoot && isPathUnderParent(path.resolve(dataRoot), resolved)) {
        throw new Error(`The storage provenance registry must not live inside the data root (${resolved}). Anything writable there is forgeable by the party this registry exists to identify.`);
    }

    return resolved;
}

/**
 * Read the registry off disk, once, at boot.
 *
 * ⚠️ NEVER THROWS, AND THE FAILURE IS SILENT ON PURPOSE. A missing file is the normal case on a fork that
 * has never run a provider. A corrupt one is a fork whose registry is worth nothing but whose chat list must
 * still draw — §5: an enrichment, never a dependency. Both land on an empty registry, and every sentence
 * downstream degrades to the bare id it already showed.
 * @param {string} filePath Absolute path to the registry file
 * @returns {void}
 */
export function loadProvenanceRegistry(filePath) {
    registryPath = filePath;
    entries = Object.create(null);

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        for (const [id, entry] of Object.entries(parsed?.providers ?? {})) {
            // 🔴 RE-VALIDATED ON THE WAY IN, not merely on the way out. The file is written by the fork, but
            // "written by the fork" is a claim about the past, and a registry that trusted its own file would
            // be one hand-edit away from rendering whatever it found there.
            const clean = sanitiseEntry(id, entry);

            if (clean) {
                entries[id] = clean;
            }
        }
    } catch {
        // Missing, unreadable, or not JSON. All three mean "no registry", which is a supported state.
    }
}

/**
 * Forget the registry. FOR TESTS ONLY — nothing in the server calls this.
 * @returns {void}
 */
export function resetProvenanceRegistry() {
    entries = Object.create(null);
    registryPath = null;
}

/**
 * What the fork knows about the provider behind an envelope id.
 *
 * 🔴 THE ONLY READ PATH, AND IT ANSWERS NULL FOR EVERYTHING IT IS NOT SURE OF: an id that fails the
 * envelope's own character class, an id nothing was ever recorded for, and an id two different providers
 * have claimed (§8). Null is not an error — it is the instruction to show the bare id, which is the
 * sentence the fork drew before any of this existed.
 * @param {string|null|undefined} id The validated provider id from an envelope header
 * @returns {ProviderIdentity|null} What is known, or null to say nothing beyond the id
 */
export function lookupProviderIdentity(id) {
    if (!isValidProviderId(id)) {
        return null;
    }

    const entry = entries[id];

    // A conflicted id has two claimants and the fork cannot say which one the user's files came from.
    // Naming either would be a guess rendered as a fact, in the one sentence that must not contain one.
    if (!entry || entry.conflict) {
        return null;
    }

    return { ...entry };
}

/**
 * Which providers has this instance ever run?
 *
 * 🔴 THE ONE QUESTION THE REGISTRY EXISTED TO ANSWER AND COULD NOT BE ASKED. Every other read here is keyed
 * by an id taken from an envelope — which presumes you already hold a file and want it named. The boot path
 * has the opposite problem: it knows a provider is NOT installed and needs to find out whether one ever was,
 * because that is the difference between a stock install and an install whose data has just become
 * unreadable. Conflicted entries are included: for this question "two providers claimed this id" still
 * answers "yes, something ran", which is all the caller is asking.
 * @returns {string[]} Every recorded provider id, in registry order
 */
export function recordedProviderIds() {
    return Object.keys(entries);
}

/**
 * Record the identity a running provider declares about itself.
 *
 * Called on provider load, every boot, after `init()` has succeeded — a provider that refused to serve this
 * configuration never ran, and the registry is a record of what actually ran.
 *
 * 🔴 THE MISMATCH RULE (§6). A declaration whose `id` differs from the provider's own id — the id it writes
 * into every envelope header — is REFUSED rather than stored. Storing it would produce a registry keyed to
 * something no file on disk will ever name: an entry that can never match, which is strictly worse than no
 * entry, because it looks like the feature is working.
 *
 * ⚠️ A MALFORMED FIELD REFUSES THE WHOLE DECLARATION, rather than being dropped on its own. The alternative
 * — store what validated, discard the rest — silently renders a half-attacker-shaped entry and gives the
 * provider no signal that it got the interface wrong. Absent is not malformed: every field but `id` is
 * optional, and a provider that declares nothing at all is recorded by id alone and degrades to today's
 * sentence everywhere, which §6 requires of it.
 * @param {string} providerId The provider's own id, as registered
 * @param {unknown} declaration Whatever `describe('storage.identity')` returned, entirely unvalidated
 * @returns {ProviderIdentity|null} What was recorded, or null if nothing could be
 */
export function recordProviderIdentity(providerId, declaration) {
    if (!isValidProviderId(providerId)) {
        return null;
    }

    const now = new Date().toISOString();
    const declared = declaration && typeof declaration === 'object' ? sanitiseEntry(providerId, declaration) : null;

    if (declaration && typeof declaration === 'object' && !declared) {
        log.warn(LogClass.NORMAL, `Storage provider '${providerId}' declared an identity that could not be validated. It is recorded by id alone.`);
    }

    const previous = entries[providerId];

    // §8: two providers claiming one id. Keep the FIRST — the user's existing files key to it — record the
    // conflict, and let every surface fall back to the bare id from here on.
    if (previous && declared && isDifferentProvider(previous, declared)) {
        log.warn(LogClass.NORMAL, `Storage provider '${providerId}' now identifies itself differently from the provider previously recorded under that id. Keeping the first record; both will be shown by id alone.`);
        entries[providerId] = { ...previous, conflict: true, lastSeen: now };
        persist();
        return null;
    }

    const merged = {
        ...previous,
        ...(declared ?? { id: providerId }),
        firstSeen: previous?.firstSeen ?? now,
        lastSeen: now,
    };

    // ⚠️ `conflict` IS THE FORK'S FLAG AND A DECLARATION MUST NOT BE ABLE TO SET IT. `sanitiseEntry` has to
    // copy it, because the same function re-reads the registry file where the flag is ours and must survive
    // — but that also let it through from `describe('storage.identity')`, three lines under a comment saying
    // it is "ignored entirely when they arrive from a declaration". A provider answering `conflict: true`
    // would have it persisted, and §8 makes that permanent: `lookupProviderIdentity` returns null for that
    // id for ever after, so every surface silently drops to the bare-id sentence and nothing ever clears it.
    delete merged.conflict;

    if (previous?.conflict) {
        merged.conflict = true;
    }

    entries[providerId] = merged;

    persist();
    return { ...entries[providerId] };
}

/**
 * Is this a different provider from the one already recorded, rather than a newer build of the same one?
 *
 * 🔴 THE LINE IS BETWEEN IDENTITY AND FACTS ABOUT IT, and drawing it in the wrong place breaks one of two
 * things. `name` and `source` are WHO the provider is: two different answers under one id is §8's collision,
 * and silently overwriting would repoint every existing file's sentence at a plugin that did not write them.
 * `version` and `envelopeVersions` are facts about the same provider that are SUPPOSED to change — treating
 * a routine upgrade as a collision would mark every provider conflicted on its second release, and the
 * "update the plugin" sentence of §7 depends on the version being current.
 * @param {ProviderIdentity} previous What was recorded before
 * @param {ProviderIdentity} declared What is being declared now
 * @returns {boolean} True if these are two different providers wearing one id
 */
function isDifferentProvider(previous, declared) {
    for (const field of ['name', 'source']) {
        // An entry recorded by id alone has nothing to disagree with, so a provider that begins declaring
        // itself is filling a blank rather than colliding.
        if (previous[field] && declared[field] && previous[field] !== declared[field]) {
            return true;
        }
    }

    return false;
}

/**
 * Validate a declaration into an entry, or refuse it entirely.
 * @param {string} id The id this entry is keyed under
 * @param {any} entry The candidate
 * @returns {ProviderIdentity|null} A clean entry, or null if any present field failed
 */
function sanitiseEntry(id, entry) {
    // 🔴 The id is checked against the envelope parser's own rule, from the envelope parser's own module.
    // Two copies of `[a-z0-9-]{1,32}` would eventually disagree, and the disagreement would be a registry
    // entry that no envelope can ever key to.
    if (!isValidProviderId(id) || !entry || typeof entry !== 'object') {
        return null;
    }

    // The declaration states its own id, and it must be the one it is being filed under (§6). Anything else
    // is a provider that has misunderstood the interface, and the mapping it is asking for is one it has
    // already told us is wrong.
    if (entry.id !== undefined && entry.id !== id) {
        return null;
    }

    /** @type {ProviderIdentity} */
    const clean = { id };

    for (const [field, pattern, cap] of [
        ['name', NAME_PATTERN, MAX_NAME_LENGTH],
        ['source', SOURCE_PATTERN, MAX_SOURCE_LENGTH],
        ['version', VERSION_PATTERN, MAX_VERSION_LENGTH],
    ]) {
        const value = entry[field];

        if (value === undefined || value === null) {
            continue;
        }

        // The length is checked BEFORE the pattern, so a 4 MB string is refused without a regex ever being
        // run over it — the same reasoning as the envelope's 64-byte window.
        if (typeof value !== 'string' || value.length > cap || !pattern.test(value)) {
            return null;
        }

        clean[field] = value;
    }

    if (entry.envelopeVersions !== undefined && entry.envelopeVersions !== null) {
        if (!Array.isArray(entry.envelopeVersions) || entry.envelopeVersions.length > MAX_ENVELOPE_VERSIONS) {
            return null;
        }

        if (!entry.envelopeVersions.every(v => Number.isInteger(v) && v >= 0 && v <= MAX_ENVELOPE_VERSION)) {
            return null;
        }

        clean.envelopeVersions = [...entry.envelopeVersions];
    }

    // Timestamps and the conflict flag are the fork's own, not the provider's — they are carried through
    // when re-reading the file and ignored entirely when they arrive from a declaration.
    for (const field of ['firstSeen', 'lastSeen']) {
        if (typeof entry[field] === 'string' && entry[field].length <= 32) {
            clean[field] = entry[field];
        }
    }

    if (entry.conflict === true) {
        clean.conflict = true;
    }

    return clean;
}

/**
 * Write the registry out.
 *
 * ⚠️ A FAILURE HERE IS LOGGED AND SWALLOWED. The registry is an enrichment; a read-only server root is a
 * perfectly ordinary deployment, and refusing to boot over one — or failing the provider load that this runs
 * inside of — would trade a missing sentence for an install that will not start.
 * @returns {void}
 */
function persist() {
    if (!registryPath) {
        return;
    }

    try {
        fs.mkdirSync(path.dirname(registryPath), { recursive: true });
        writeFileAtomicSync(registryPath, JSON.stringify({ version: REGISTRY_VERSION, providers: entries }, null, 4));
    } catch (error) {
        log.warn(LogClass.NORMAL, 'The storage provenance registry could not be written. Provider names will not be remembered.');
        log.warn(LogClass.SENSITIVE, `Provenance registry write failed at ${registryPath}:`, error);
    }
}
