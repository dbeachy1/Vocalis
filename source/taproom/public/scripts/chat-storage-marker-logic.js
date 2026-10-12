/**
 * 🔒 THE PER-CHAT STORAGE MARKER — the PURE decision, with no DOM and no network.
 *
 * The rules the padlock has to get right (`DESIGN_MIXED_MODE.md` §6.2, §7.2, §11) are all failure-shaped in
 * the reassuring direction — a padlock over a plaintext chat is a lie somebody may act on — so they are
 * extracted here and tested directly rather than only through a browser. `chat-storage-markers.js` is the
 * thin DOM shell over this.
 *
 * ⚠️ It also holds the sentence for the NON-chat surfaces (`DESIGN_STORAGE_PROVENANCE.md` §7 surface 4 —
 * characters, worlds, backgrounds, settings), despite the file's chat-shaped name. They share
 * `identityDetail` and `formatLastSeen`, and a second module would have meant a second copy of the rules
 * about what may be said and what may never be linked. One uninstall must produce one vocabulary.
 */

/**
 * 🪪 The provenance sentence's optional second half — what the fork RECORDED about a provider it once ran.
 *
 * `DESIGN_STORAGE_PROVENANCE.md` §7. The bare id is a slug, and a user who did not install the plugin
 * themselves — a second machine, a restored backup, a year later — has nothing to go on. The registry turns
 * it into a name and a place to look.
 *
 * 🔴 **DISPLAYED, NEVER FOLLOWED** (§5, and §3.1 before it). `source` is accurate, because it was recorded
 * from a plugin that was genuinely running here; accurate is not the same as safe to action. There is no
 * link, no fetch, and no install command anywhere in this module, and there must never be one — "this chat
 * requires plugin X" must not become a one-click path to installing whatever a file names.
 *
 * ⚠️ Everything here is optional and independently absent. A provider that declared only its name gets only
 * its name. That is §6's rule that no provider is ever REQUIRED to identify itself, arriving at the surface.
 * @param {{name?: string, source?: string, lastSeen?: string}|null|undefined} identity The registry record
 * @returns {string} A trailing sentence or two, or '' when the fork knows nothing beyond the id
 */
function identityDetail(identity) {
    if (!identity || typeof identity !== 'object') {
        return '';
    }

    const parts = [];
    const seen = formatLastSeen(identity.lastSeen);

    if (seen) {
        parts.push(`Last used ${seen}.`);
    }

    // 🔴 Text. Not a link, not an anchor, not a button. See the note above.
    if (typeof identity.source === 'string' && identity.source) {
        parts.push(`Find it at ${identity.source}`);
    }

    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * Render the registry's `lastSeen` stamp as a date a human reads, or nothing at all.
 *
 * The orientation this offers — *"you had this until 12 June"* — is the difference between a user thinking
 * their data broke and remembering the afternoon they uninstalled something. It is also the field most
 * likely to be absent or malformed on an old registry, so anything unparseable yields '' rather than
 * "Invalid Date", which would be worse than saying nothing.
 * @param {string|null|undefined} iso An ISO timestamp from the registry
 * @returns {string} A formatted date, or '' if there is not one
 */
function formatLastSeen(iso) {
    if (typeof iso !== 'string' || !iso) {
        return '';
    }

    const when = new Date(iso);
    return Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * The wording for a chat whose provider is not installed (§11). This IS fork text, and that is allowed:
 * "your data is encrypted" is a claim only the provider may make, but "this row is disabled because the
 * plugin that reads it is gone, here is its name" is the fork explaining itself. The id is validated
 * server-side to `[a-z0-9-]{1,32}` or dropped to null, so what arrives is a plausible id or nothing.
 *
 * 🔴 **THE ID STAYS VISIBLE IN EVERY VARIANT** (`DESIGN_STORAGE_PROVENANCE.md` §7). A friendly name that
 * replaced it entirely would leave a user unable to check that the plugin they found is the plugin the file
 * actually names — and the id is the only half of this sentence that matches what is on the disk.
 * @param {string|null|undefined} providerId The validated provider id, or null/empty for "unknown"
 * @param {{name?: string, source?: string, lastSeen?: string}|null} [identity] What the fork recorded about
 * that provider while it was installed, or null when it has no record of it
 * @returns {string} The message to show
 */
export function unavailableMessage(providerId, identity = null) {
    return unavailableDataMessage('chat', providerId, identity);
}

/**
 * The wording for any NON-CHAT item whose provider is not installed — a character, a world info file, a
 * background, a settings file (`DESIGN_STORAGE_PROVENANCE.md` §7 surface 4).
 *
 * §3's third user moment is that a user uninstalling a provider learns about their chats and then discovers
 * everything else one silent failure at a time. The sentence is the same shape as the chat one because the
 * user's situation is the same — only the noun changes — and {@link unavailableMessage} is now this function
 * with `'chat'` passed in, so the two can never drift into saying different things about one uninstall.
 *
 * 🔴 The noun is a FORK-AUTHORED CONSTANT, never a value off the disk. Callers pass a literal from
 * {@link DATA_NOUNS}; a filename or a provider-supplied string reaching this parameter would put
 * attacker-controlled text into the sentence, which is the whole thing §3.1 forbids.
 * @param {string} noun What the item is, in the fork's own words: 'character', 'world info file', …
 * @param {string|null|undefined} providerId The validated provider id, or null/empty for "unknown"
 * @param {{name?: string, source?: string, lastSeen?: string}|null} [identity] What the fork recorded about
 * that provider while it was installed, or null when it has no record of it
 * @returns {string} The message to show
 */
export function unavailableDataMessage(noun, providerId, identity = null) {
    const subject = typeof noun === 'string' && noun ? noun : 'file';

    if (typeof providerId !== 'string' || !providerId) {
        return `This ${subject} requires a storage provider that is not installed.`;
    }

    const named = identity?.name
        ? `This ${subject} requires ${identity.name} ('${providerId}').`
        : `This ${subject} requires the '${providerId}' storage provider.`;

    return `${named}${identityDetail(identity)}`;
}

/**
 * The nouns §7 surface 4 covers, so that four call sites cannot invent four different words for one thing.
 *
 * These read as what the USER thinks they lost, not as what the server calls the directory: a person who
 * uninstalled something is looking for their characters, not for `characters/*.png`.
 */
export const DATA_NOUNS = Object.freeze({
    character: 'character',
    world: 'world info file',
    background: 'background',
    settings: 'settings file',
    group: 'group',
});

/**
 * The wording for a BACKUP whose provider is not installed (§9.1, §14.5).
 *
 * A separate sentence from {@link unavailableMessage} on purpose. §14.5 settles that a legacy plaintext
 * chat's backups stop being plaintext once a provider arrives — so the user can be looking at an unreadable
 * backup of a chat that is *sitting there readable, needing no plugin at all*, and "this chat requires…"
 * would be flatly wrong about which thing is affected. This says backup, and it says restore, because
 * restoring is what they were trying to do when they got here.
 *
 * 🔴 STILL NOT THE FORK'S CLAIM TO MAKE (§6.2). It says what the fork knows — this file needs a plugin that
 * is not here, and here is its name — and never *why*, because "your backup is encrypted" is a sentence only
 * a provider may say. A provider might be compression, or a remote store. `storage-provider-text.js` fails
 * the build over that vocabulary, and it caught this sentence's first draft.
 *
 * 🔴 Names the provider, never links to it (§3.1). The id is validated server-side to `[a-z0-9-]{1,32}` or
 * dropped to null; it is still rendered as text and must never become an install URL or a one-click fetch.
 * @param {string|null|undefined} providerId The validated provider id, or null/empty for "unknown"
 * @param {{name?: string, source?: string, lastSeen?: string}|null} [identity] What the fork recorded about
 * that provider while it was installed, or null when it has no record of it
 * @returns {string} The message to show
 */
export function unavailableBackupMessage(providerId, identity = null) {
    if (typeof providerId !== 'string' || !providerId) {
        return 'This backup requires a storage provider that is not installed.';
    }

    const named = identity?.name
        ? `This backup requires ${identity.name} ('${providerId}') to restore it.`
        : `This backup requires the '${providerId}' storage provider to restore it.`;

    return `${named}${identityDetail(identity)}`;
}

/**
 * 🪪 The sentence for a chat whose provider IS installed but wrote it in a version the installed build cannot
 * read — `DESIGN_STORAGE_PROVENANCE.md` §7 row 3, §12.1. A different sentence from {@link unavailableMessage}
 * on purpose: that one is *"install the plugin"*, and this one is *"you HAVE the plugin — update it"*, which
 * is the §3 second user moment and useless advice in the other's place.
 *
 * 🔴 The name is the LOADED provider's, resolved server-side from the provider that owns these bytes — never
 * read off the file (§4). The id keeps its place beside it, same rule as everywhere: a friendly name that
 * replaced it would leave a user unable to check the plugin they have is the plugin the file names.
 *
 * ⚠️ It does not claim a DIRECTION. A version this build does not recognise is not this build, whether the
 * number is higher or lower, and "update the plugin" is the honest advice either way — today only version 1
 * exists, so it cannot even arise, and the pre-release rule says not to design for it.
 * @param {string|null|undefined} providerId The loaded provider's validated id, or null/empty for "unknown"
 * @param {{name?: string, version?: string}|null} [identity] What the fork recorded about the loaded provider
 * @returns {string} The message to show
 */
export function updateRequiredMessage(providerId, identity = null) {
    const named = identity?.name
        ? `${identity.name} ('${providerId}')`
        : (typeof providerId === 'string' && providerId ? `the '${providerId}' storage provider` : 'the storage provider that wrote it');

    const installed = typeof identity?.version === 'string' && identity.version ? ` The installed version is ${identity.version}.` : '';

    return `This chat was written by a version of ${named} that the installed plugin cannot open. Update the plugin.${installed}`;
}

/**
 * 🪪 SURFACE 5 — the count nouns, singular and plural, for the "what did my uninstall take?" summary
 * (`DESIGN_STORAGE_PROVENANCE.md` §7 surface 5).
 *
 * The keys are the server's own type keys from `storage-provenance-summary.js`, and the values are what the
 * USER calls the thing — a person who uninstalled something is looking for their chats and characters, not
 * for `chats/*.jsonl`. It is the same vocabulary discipline as {@link DATA_NOUNS}: fork-authored words, never
 * a string off the disk. This map is a superset — surface 5 also counts chats, group chats and group
 * definitions, which surfaces 1–3 mark per row rather than by noun.
 */
const NEED_NOUNS = Object.freeze({
    chat: { one: 'chat', many: 'chats' },
    'group-chat': { one: 'group chat', many: 'group chats' },
    character: { one: 'character', many: 'characters' },
    world: { one: 'world info file', many: 'world info files' },
    group: { one: 'group', many: 'groups' },
    background: { one: 'background', many: 'backgrounds' },
    settings: { one: 'settings file', many: 'settings files' },
});

/**
 * The fixed order the counts read in — chats first, because that is what a worried user asks about first, and
 * settings last. A stable order makes the sentence deterministic and keeps a test from having to predict a
 * Map's iteration.
 */
const NEED_ORDER = Object.freeze(['chat', 'group-chat', 'character', 'world', 'group', 'background', 'settings']);

/**
 * One "3 characters" fragment, singular or plural, or '' for a type this fork has no noun for.
 * @param {string} type The server's data-type key
 * @param {number} count How many of them
 * @returns {string} The fragment, e.g. "1 world info file" or "3 characters"
 */
function countPhrase(type, count) {
    const noun = NEED_NOUNS[type];

    if (!noun || !Number.isInteger(count) || count <= 0) {
        return '';
    }

    return `${count} ${count === 1 ? noun.one : noun.many}`;
}

/**
 * Join fragments the way a sentence does: "a", "a and b", "a, b and c".
 * @param {string[]} parts The non-empty fragments
 * @returns {string} The joined list
 */
function joinList(parts) {
    if (parts.length <= 1) {
        return parts[0] ?? '';
    }

    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * How to name the provider in the summary sentence — the same rule as everywhere else in this module, in the
 * shape this sentence needs.
 *
 * 🔴 NAME FROM THE FORK'S RECORD, ID ALWAYS VISIBLE, NEVER A LINK. `identity` came from the registry the fork
 * wrote while the provider ran (§4); the id is what matches the bytes on disk and stays beside the name so a
 * user can check the plugin they find is the plugin their files name. Nothing here is ever actioned (§3.1).
 * @param {string|null|undefined} providerId The validated provider id, or null when the id itself is unknown
 * @param {{name?: string}|null|undefined} identity What the fork recorded, or null when it has no record
 * @returns {string} The provider phrase
 */
function providerNeedName(providerId, identity) {
    if (identity?.name) {
        return `${identity.name} ('${providerId}')`;
    }

    if (typeof providerId === 'string' && providerId) {
        return `the '${providerId}' storage provider`;
    }

    return 'a storage provider that is not installed';
}

/**
 * 🪪 The one-line summary for everything in an account that needs one absent provider — surface 5's payload,
 * as a sentence: *"You have 12 chats and 3 characters that need SillyTavern-Vault ('vault'). Last used 12
 * June 2026. Find it at github.com/…"*
 *
 * Pure, so it is unit-tested without a browser exactly like {@link resolveChatMarker}: the pluralisation, the
 * list-joining and the singular/plural verb agreement are all failure-shaped in small ways ("1 chats", "3
 * character", "need" where it should be "needs") that a screenshot would let slide.
 *
 * 🔴 THE SAME RULES AS THE PER-ROW SENTENCES. The nouns are {@link NEED_NOUNS}, fork constants; the provider
 * name comes from the fork's registry via {@link providerNeedName}; the id stays visible; and `source` is
 * shown, never linked. A summary is still a place a user reads what to go and install, so §3.1 governs it
 * exactly as it governs the padlock.
 * @param {{id?: string|null, identity?: object|null, total?: number, counts?: Record<string, number>}} need One
 * provider's entry from the surface-5 summary
 * @returns {string} The sentence, or '' when there is nothing to say (no counted items)
 */
export function summariseProviderNeed(need) {
    if (!need || typeof need !== 'object') {
        return '';
    }

    const counts = need.counts && typeof need.counts === 'object' ? need.counts : {};
    const fragments = NEED_ORDER.map(type => countPhrase(type, counts[type])).filter(Boolean);

    if (fragments.length === 0) {
        return '';
    }

    // Verb agreement is on the item TOTAL, not the number of fragments: "1 world info file … needs" but
    // "3 characters … need", and a single fragment can still be plural. Sum only the counts a fragment was
    // actually emitted for, so an unknown type or a zero cannot skew it.
    const total = NEED_ORDER.reduce((sum, type) => sum + (countPhrase(type, counts[type]) ? counts[type] : 0), 0);
    const items = joinList(fragments);
    const verb = total === 1 ? 'needs' : 'need';
    const name = providerNeedName(need.id ?? null, need.identity ?? null);

    return `You have ${items} that ${verb} ${name}.${identityDetail(need.identity ?? null)}`;
}

/**
 * @typedef {object} ChatMarker
 * @property {'none'|'encrypted'|'unavailable'} kind What to draw: nothing, a live padlock, or a disabled row.
 * @property {string} title The tooltip / row text. Empty when `kind` is `none`.
 */

/**
 * Decide what marker one chat's status earns.
 *
 * The rules, in the order they fire:
 * - 🔴 **Not encrypted → nothing** (§7.2). Plaintext, unknown, or a provider that could not say all collapse
 *   here. Presence is the signal; absence is the default. This is the case whose wrong answer — a padlock —
 *   is the dangerous one, so it is decided first and decided by an affirmative `encrypted === true`.
 * - **Encrypted but unavailable → the disabled row** (§11), captioned with fork text naming what it needs.
 * - 🪪 **Encrypted, provider installed, but the file's version is too new → the disabled row, "update it"**
 *   (§12.1). Ordered AFTER `unavailable` because you cannot update a plugin that is gone — provider-absent
 *   is "install", and it wins. In practice the two never co-occur: `requiresUpdate` is only ever set on a
 *   state whose provider is present, exactly the state `unavailable` is not.
 * - **Encrypted and available, but the provider gave no words → nothing** (§6.2). A marker the fork cannot
 *   caption is the fork making the encryption claim on its own. No words, no marker.
 * - Otherwise: the live padlock, captioned with the provider's own words.
 * @param {{encrypted?: boolean, unavailable?: boolean, requiresUpdate?: boolean, requiresProvider?: string|null, identity?: object|null}|null|undefined} state The status
 * @param {string} marker The provider's `storage.chatMarker` body, or '' if it stayed silent
 * @returns {ChatMarker} What to draw
 */
export function resolveChatMarker(state, marker) {
    if (!state || state.encrypted !== true) {
        return { kind: 'none', title: '' };
    }

    if (state.unavailable) {
        // `identity` is absent on a state built by an older server, and on the rows `chats.js` synthesises
        // for ids nothing on disk answers to. Both mean "no record", which is the sentence this fork drew
        // before the registry existed.
        return { kind: 'unavailable', title: unavailableMessage(state.requiresProvider, state.identity ?? null) };
    }

    if (state.requiresUpdate) {
        // The provider is here; the file is not readable by this build of it. A disabled row, because the
        // chat cannot be opened as things stand — but the sentence is "update", not "install".
        return { kind: 'unavailable', title: updateRequiredMessage(state.requiresProvider, state.identity ?? null) };
    }

    if (typeof marker !== 'string' || marker === '') {
        return { kind: 'none', title: '' };
    }

    return { kind: 'encrypted', title: marker };
}
