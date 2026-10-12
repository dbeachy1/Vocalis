import fs from 'node:fs';
import path from 'node:path';

import writeFileAtomic, { sync as writeFileAtomicSync } from 'write-file-atomic';
import { log, LogClass } from './logger.js';
// ⚠️ Imports nothing itself, so this cannot close a cycle back into storage.
import * as notifications from './plugin-notifications.js';
import { clearConnectionFor } from './plugin-generate.js';
import { clearFor as clearEventStreamFor } from './event-stream.js';

/**
 * THE STORAGE PROVIDER API.
 *
 * SillyTavern reads and writes user data through this module, and only through this module. A plugin
 * may register a Storage Provider behind it, in which case every byte of user data that enters or
 * leaves the disk passes through code the provider controls. With no provider registered, everything
 * here is a thin pass-through to node:fs and SillyTavern behaves exactly as it always has.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ ⛔ THIS FILE CONTAINS NO CRYPTOGRAPHY, AND NEITHER DOES ANY OTHER FILE IN THIS FORK.         │
 * │                                                                                             │
 * │ No keys, no ciphers, no KDFs. If a `crypto` import ever appears in this fork's diff,        │
 * │ something has gone wrong. Encryption is a *provider* concern, and providers live outside    │
 * │ this repository. That split is not cosmetic — it is what keeps this diff small, generic,    │
 * │ and mergeable against upstream.                                                             │
 * └─────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * THE CONTRACT: every path crossing this API is a *logical* path — the path SillyTavern would use if
 * no provider existed. If a provider stores a file somewhere else, or under a different name, that is
 * entirely its own business and SillyTavern never learns of it. `readdir()` returns logical names.
 * `stat()` reports the logical size.
 */

/**
 * The provider is not ready for this user (for example, it is locked).
 *
 * 🔴 THE DATA EXISTS. It is not missing, and it is not corrupt. Never handle this by regenerating,
 * resetting, pruning or deleting.
 */
export const EUNAVAILABLE = 'EUNAVAILABLE';

/**
 * The provider failed to decode the file: wrong key, tampering, or corruption.
 *
 * 🔴 THE DATA EXISTS. Never handle this by regenerating, resetting, pruning or deleting.
 */
export const EPROVIDER = 'EPROVIDER';

/**
 * An error raised by a Storage Provider.
 *
 * These carry a `code` of {@link EUNAVAILABLE} or {@link EPROVIDER}, and they are deliberately NOT
 * `SyntaxError`s — SillyTavern has six separate code paths that respond to a `SyntaxError` by
 * destroying the data that produced it and rebuilding it from source. A provider error means the data
 * is *there and unreadable*, which is the exact opposite of the situation those paths assume.
 *
 * 🔴 THE FAIL-SAFE RULE, and it is the most important rule in this file:
 *
 *     EUNAVAILABLE and EPROVIDER must NEVER be handled by regenerating, resetting, pruning or
 *     deleting. They propagate. A request fails; a file is not touched.
 *
 *     Only ENOENT may trigger a "create it from scratch" path.
 */
export class StorageError extends Error {
    /**
     * @param {string} code One of {@link EUNAVAILABLE} or {@link EPROVIDER}
     * @param {string} message Human-readable explanation
     * @param {string} [path] The logical path that could not be served
     */
    constructor(code, message, path) {
        super(message);
        this.name = 'StorageError';
        this.code = code;
        this.path = path;
    }
}

/**
 * Is this a provider error — that is, does it mean "the data is there and I cannot read it"?
 *
 * Every `catch` block in SillyTavern that reacts to a read or parse failure by writing or unlinking
 * must consult this and re-throw when it is true.
 * @param {unknown} error The error to test
 * @returns {boolean} True if the data exists but could not be read
 */
export function isStorageError(error) {
    const code = /** @type {{code?: unknown}} */ (error)?.code;
    return code === EUNAVAILABLE || code === EPROVIDER;
}

/**
 * The facts about this installation, as assembled by whoever is about to load a provider.
 *
 * The account facts are here because a provider may need a SECRET to become ready, and several ordinary
 * SillyTavern configurations never produce one — accounts turned off entirely, a user with an EMPTY
 * password (which does not mean "check against empty"; it means *no password check happens at all*), or
 * authentication delegated to a proxy so SillyTavern never sees a password. A provider that needs a secret
 * must be able to see that at boot and refuse.
 *
 * None of this is about encryption. It is the shape of the accounts, which any provider might care about.
 *
 * @typedef {object} StorageProviderEnvironment
 * @property {string} dataRoot The data root being served
 * @property {boolean} accountsEnabled `enableUserAccounts` — false means there is no login at all
 * @property {boolean} basicAuthMode Authentication is via a `Basic` header
 * @property {boolean} authenticationDelegated Authelia or a proxy is authenticating; ST never sees a password
 * @property {{handle: string, enabled: boolean, hasPassword: boolean}[]} users The enabled accounts
 */

/**
 * What a provider is being asked to serve. Handed to `init()` once, at boot.
 *
 * This is the {@link StorageProviderEnvironment} the caller assembled, plus the logging channel — which
 * `storage-provider-loader.js` adds on the way past rather than each caller building it. See the comment
 * at that call for why it belongs there and not at the call sites.
 *
 * @typedef {StorageProviderEnvironment & {
 *   logger: typeof import('./logger.js').log,
 *   LogClass: typeof import('./logger.js').LogClass,
 * }} StorageProviderContext
 */

/**
 * A field in a dialog the provider has asked SillyTavern to draw.
 *
 * The NAMES are SillyTavern's, not the provider's — they are the credential slots this application
 * already has, and they are what it will send back. A provider chooses which of them to show and what to
 * call them; it cannot invent a fourth, because there would be nowhere for the answer to go.
 *
 * @typedef {object} ProviderField
 * @property {'current'|'password'|'confirm'} name Which credential slot this box fills
 * @property {string} [label] The label to show. Omitted: SillyTavern's own.
 * @property {string} [placeholder] Placeholder text. Omitted: SillyTavern's own.
 * @property {boolean} [required] Refuse to submit an empty box. Default false.
 */

/**
 * What a provider wants to say to the user about a situation SillyTavern is about to draw.
 *
 * 🔴 THIS EXISTS BECAUSE THE FORK MUST NOT KNOW WHAT A PROVIDER IS.
 *
 * SillyTavern can draw a dialog; a server-side provider cannot, and never will be able to. But the
 * SENTENCES in that dialog are the provider's business, not SillyTavern's — only the provider knows
 * whether losing a password means "pick a new one" or "your data is gone for ever", and SillyTavern must
 * not guess, hard-code, or paraphrase. Every string that is only true BECAUSE of what the provider does
 * comes from the provider.
 *
 * ⚠️ Returning null (or having no `describe` at all) is not an error and is not a fallback into
 * provider-flavoured prose. It means SillyTavern renders its OWN default for that situation — which,
 * with no provider installed, is what it has always rendered, byte for byte.
 *
 * @typedef {object} ProviderText
 * @property {string} [title] A heading.
 * @property {string} [body] The main sentence or two.
 * @property {string[]} [notes] Further paragraphs, in order.
 * @property {ProviderField[]} [fields] For a situation that is a FORM: which boxes to draw, and what to
 * call them. Omitted: SillyTavern draws its own.
 * @property {string} [submitLabel] The confirm button's label.
 */

/**
 * 🪪 What a provider says about ITSELF, for `describe('storage.identity')`.
 *
 * Not prose, and deliberately not a {@link ProviderText}: these are facts the fork records while the
 * provider is installed and repeats after it is gone, so that *"this chat requires 'vault'"* can become
 * *"this chat requires SillyTavern-Vault, which you had until 12 June"*. Every
 * validation rule has a reason, stated beside it.
 *
 * @typedef {object} ProviderIdentityText
 * @property {string} id 🔴 MUST equal this provider's `id` and the id it writes into envelope headers, and
 * it must never change between versions. `[a-z0-9-]{1,32}`.
 * @property {string} [name] What a human looks for — *"SillyTavern-Vault"*. One line, no markup, ≤64 chars.
 * @property {string} [source] Where to get it: an `http(s)` URL or a package name, ≤192 chars. 🔴 Shown to
 * the user as text and NEVER followed, fetched, or turned into an install command.
 * @property {string} [version] This build's version, so the fork can tell *update the plugin* from
 * *install the plugin*.
 * @property {number[]} [envelopeVersions] Which envelope versions this build can READ. A file whose header
 * names a version outside this list is one this build cannot open, and the fork says so in those words
 * rather than drawing a padlock over a chat that will not load.
 */

/**
 * A Storage Provider. A plain object; at most one may be registered.
 *
 * @typedef {object} StorageProvider
 * @property {string} id A stable identifier, used in logs.
 *
 * @property {number} [idleLockMs] How long the provider RECOMMENDS a user's storage stay unlocked with
 * nobody doing anything. 🔴 A RECOMMENDATION, AND SINCE 2026-07-27 NOT THE APPLIED VALUE — the property
 * name is inherited and now overstates its authority, but it is the plugin API and renaming it would
 * break every provider already written against it. What it does now: it is offered to the user as the
 * suggested setting, labelled with the provider's name, and it is applied only if they choose it.
 *
 * The user's own setting decides, and defaults to NEVER. "Lock after thirty minutes" is a security
 * judgement that depends on who else can reach the machine — which neither the provider nor SillyTavern
 * can see, and the person sitting at it can. A provider that omits this recommends nothing, and the
 * dropdown simply offers the fork's own presets.
 *
 * What SillyTavern still owns, because a provider cannot do it: noticing that nobody is there. It sees
 * the HTTP requests; the provider sees only storage calls, and cannot tell a user's click from a
 * background stats write. So the mechanism lives here and the number comes from the user.
 *
 * @property {(situation: string, context?: object) => ProviderText|ProviderIdentityText|null} [describe]
 * Tell the user about a situation, in the provider's own words. See {@link ProviderText}. Return null — or
 * omit this entirely — and SillyTavern uses its own default text, unchanged. One situation,
 * `'storage.identity'`, is answered with a {@link ProviderIdentityText} instead: data about the provider,
 * not words for the user.
 *
 * The situations SillyTavern asks about, and nothing else:
 *
 *   'password.change'   The change-password dialog. `fields` and `submitLabel` are honoured here.
 *                       context: `{ handle, self }` — `self` is false when an admin is changing someone
 *                       else's password, which is a different conversation and may want different boxes.
 *   'password.recover'  A password reset was refused, or a recovery key is being asked for. Shown on the
 *                       login page and printed by `recover.js`. context: `{ handle }`
 *   'recovery.secret'   A recovery secret is being shown to the user for the first time.
 *                       context: `{ handle }`
 *   'idle.warning'      The user is about to be idle-locked. context: `{ handle }`
 *   'recovery.regenerate' A recovery secret is being minted again, replacing one already issued.
 *                       Asked by `users-private.js:412`. context: `{ handle }`
 *   'storage.badge'     The standing badge on the LOGIN PAGE, saying what this server does with user data.
 *                       There is room for a short sentence here.
 *   'storage.marker'    The persistent marker in the MAIN UI HEADER, seen on every screen for as long as
 *                       the user is signed in. Room for a word or two at most; anything longer is simply
 *                       cut off by the header. Answer it separately from 'storage.badge' rather than
 *                       reusing that text — the two have very different amounts of space, and a provider
 *                       may reasonably want "Encrypted" in the header and a full sentence at login.
 *   'storage.chatMarker' The per-chat padlock and its tooltip (`DESIGN_MIXED_MODE.md` §6/§7). Asked by
 *                       `endpoints/storage-private.js`; a provider that stays quiet gets NO marker drawn,
 *                       because a padlock the fork cannot caption is a claim the fork would be making on
 *                       its own behalf. This situation is live and was missing from this list.
 *   'storage.identity'  🪪 WHO THIS PROVIDER IS — and the ONLY situation answered with DATA rather than
 *                       prose. See {@link ProviderIdentityText}. Asked once, on load, and stored in the
 *                       fork's provenance registry so that the fork can still say what a file needs after
 *                       this plugin is gone (`DESIGN_STORAGE_PROVENANCE.md` §6). Takes no context.
 *
 * 🪪 'storage.identity' IS UNLIKE THE OTHERS AND MUST BE READ AS DATA, NOT WORDS:
 *
 *   - The fork STORES it, COMPARES it and re-renders it long after this provider is uninstalled. It does not
 *     paste it into a sentence the way `title`/`body`/`notes` are pasted.
 *   - 🔴 `id` MUST equal this provider's own `id` — the one it writes into every envelope header. A
 *     mismatch is REFUSED outright rather than stored: an entry keyed to something no file will ever name
 *     is worse than no entry, because it looks like the feature is working.
 *   - 🔴 `id` IS PERMANENT. Changing it between versions is not a rename — it is a breaking change to the
 *     user's data, because every file already on disk becomes unattributable to the plugin that wrote it.
 *   - 🔴 Every field is VALIDATED before it is stored, and a malformed one refuses the whole declaration. A
 *     running provider is trusted not to be hostile; it is not trusted to be well-formed, and a 4 MB `name`
 *     fails exactly the way a planted one does.
 *   - 🔴 `source` is DISPLAYED, NEVER FOLLOWED. Recording it from a running plugin makes it accurate; that
 *     does not make an auto-installer safe. The fork builds no URL, no fetch and no install command out of
 *     it — §3.1 of `DESIGN_MIXED_MODE.md` stands, and this design routes around it rather than relaxing it.
 *
 * Optional, exactly like `encryptsPath` and `ownsUser`. A provider that does not answer is recorded by id
 * alone and every surface degrades to the sentence it shows today. No provider is ever REQUIRED to identify
 * itself.
 *
 * 🔴 BOTH STORAGE SITUATIONS ARE UNLIKE EVERY OTHER ONE ABOVE, IN THREE WAYS:
 *
 *   1. **They take NO context.** They are the only situations that are not about a user — they describe the
 *      SERVER. Nothing per-user may be reported here: `POST /api/users/list` already hands an anonymous
 *      caller every handle on the box, and a per-user storage flag would turn that into a targeting list.
 *   2. **They are served to an ANONYMOUS caller.** `GET /api/storage/status` answers both without a
 *      session, because the login page must draw its badge before anybody has signed in — and the marker
 *      rides along on the same request. Every other situation here is reached only by somebody who has at
 *      least got as far as a password prompt. Write both as public statements about the server: no handle,
 *      no version, no more of the provider's identity than is worth telling a stranger.
 *   3. **Only `body` is honoured.** A badge has no room for a title, notes, fields or a button, and the
 *      fork drops them before answering.
 *
 * Returning null for either — or omitting `describe` entirely — shows NOTHING AT ALL in that place. There
 * is no fork default and there must never be one: a default would be SillyTavern saying what a provider
 * does, which is the thing this whole mechanism exists to prevent. The two are independent; answering one
 * and not the other is fine and shows exactly one of them.
 *
 * ⚠️ A REFUSAL IS NOT DESCRIBED HERE. When a provider throws — from `unlock`, `rekey` or `recover` — its
 * error's own `message` is what the user is shown, verbatim. That is already the contract, it is already
 * the only thing that can be right (the provider is the only party that knows WHY it said no), and
 * `describe` must not be used to second-guess it.
 *
 * @property {(absPath: string) => boolean} owns Does this provider own the given path? False means
 * `storage.*` falls straight through to node:fs. The rule is expected to be total and trivial: a path
 * is user data if and only if it lives under `<DATA_ROOT>/<handle>/`.
 *
 * @property {(absPath: string) => boolean} [encryptsPath] Is the content at this path encrypted at rest
 * by this provider? 🔴 DISTINCT FROM {@link owns}, which is about ROUTING: in mixed mode a provider owns
 * plenty of paths it passes through in the clear, because a chat that was not encrypted when it was
 * created stays that way for ever (`DESIGN_MIXED_MODE.md` §1). Optional, like `ownsUser`; a provider
 * without it renders no marker at all, which degrades to exactly today's behaviour.
 *
 * ⚠️ Expected to be keyless and cheap. The chat-list endpoint calls it once per chat, so a 200-chat list
 * is 200 calls: a short prefix read on a file the endpoint already `stat`s, never a full decrypt (§6.1).
 * It must answer for a LOCKED account too — the marker lives outside the crypto precisely so a locked
 * provider can still draw its own padlock (§14.3) — and it must not throw on a path that does not exist,
 * because the chat list asks about rows that may have just been deleted.
 *
 * @property {(ctx: StorageProviderContext) => Promise<void>} init Called once, at boot, before any user
 * data is touched by anything. 🔴 May THROW to refuse a configuration it cannot serve — and that refusal
 * is fatal, deliberately. A provider saying "I cannot work like this" is saying that booting anyway means
 * booting over the top of the user's data.
 * @property {(handle: string) => boolean} isReady Can this user's data be served right now? False
 * means SillyTavern defers per-user maintenance work and reads throw {@link EUNAVAILABLE}.
 * @property {(handle: string, secret: string) => Promise<void>} unlock Make a user's storage ready.
 * @property {(handle: string) => void} lock Make a user's storage unavailable again.
 * @property {(handle: string) => boolean} [ownsUser] Does this provider hold a key for this user that
 * is derived from their password? If so, SillyTavern must never reset that password blindly. Optional;
 * when absent, a registered provider is ASSUMED to own every user, because the fail-safe answer to "would
 * a reset destroy this user's data?" is yes.
 * @property {(handle: string, recoverySecret: string, newSecret: string) => Promise<void>} [recover]
 * The second door. Given a recovery secret the user kept outside the machine, re-key to a new secret and
 * make the storage ready. Throws if the secret is wrong. Optional: a provider without one has no way back
 * in from a forgotten password, and SillyTavern will say so rather than pretend otherwise.
 * @property {(handle: string) => string|null} [pendingRecoverySecret] A recovery secret the provider has
 * minted and needs SillyTavern to SHOW THE USER. Null when there is nothing pending, which is the normal
 * case. Asking must not consume it — see {@link pendingRecoverySecret}.
 * @property {(handle: string) => void} [acknowledgeRecoverySecret] The user has confirmed they saved it.
 * This, and only this, is what tells the provider to stop offering it.
 * @property {(handle: string, secret: string) => Promise<void>} [regenerateRecoverySecret] Issue a NEW
 * recovery secret, retiring any previous one, and offer it through {@link pendingRecoverySecret}. Takes the
 * user's own secret (their password) as proof of identity. 🔴 THROWS if that proof is wrong, and the caller
 * must let it — see {@link regenerateRecoverySecret} for why SillyTavern must not "helpfully" skip it just
 * because the user is already logged in. Optional; a provider without one simply offers no such button.
 * @property {(handle: string, oldSecret: string|null, newSecret: string) => Promise<void>} rekey
 * Change the secret. 🔴 MAY THROW — that is how a provider vetoes a credential change it cannot
 * honour, and it is what stops a password reset from silently orphaning a user's data forever.
 *
 * @property {(p: string, opts?: any) => Promise<Buffer|string>} readFile
 * @property {(p: string, opts?: any) => Buffer|string} readFileSync
 * @property {(p: string, opts?: {start?: number, end?: number}) => import('node:stream').Readable} createReadStream
 * 🔴 MUST support ranges. Browsers seek into audio and video with `Range:`.
 * @property {(p: string) => boolean} exists
 * @property {(p: string) => fs.Stats} stat 🔴 `.size` MUST be the LOGICAL size — it becomes
 * `Content-Length`. Report a transformed on-disk size and every HTTP response truncates or hangs.
 * @property {(p: string, opts?: any) => string[]|import('node:fs').Dirent[]} readdir 🔴 Returns LOGICAL
 * names. And it MUST honour `{ withFileTypes: true }`: SillyTavern uses that form in 38 places, and
 * expects objects answering `.name` (the LOGICAL name), `.isFile()` and `.isDirectory()`. A provider
 * that only ever returns strings will break the character scan, the chat listing and every data-maid
 * sweep. The design said `string[]`; the code says otherwise, and the code wins.
 *
 * @property {(p: string, data: any, opts?: any) => Promise<void>} writeFile Atomic. ⚠️ `opts` may be an
 * encoding, and it is not decoration: `'base64'` means `data` is a base64 STRING that must be DECODED
 * to bytes before it is stored. A provider that ignores it will transform the wrong bytes.
 * @property {(p: string, data: any, opts?: any) => void} writeFileSync Atomic. Same warning.
 * @property {(p: string, opts?: any) => import('node:stream').Writable} createWriteStream ⚠️ `opts` is
 * node:fs's, and `{ flags: 'wx' }` in particular must be honoured: a provider that ignores it turns an
 * exclusive create into a truncating one, and two concurrent writers of the same path corrupt each other.
 * @property {(p: string, opts?: any) => void} mkdir
 * @property {(p: string) => void} unlink
 * @property {(from: string, to: string) => void} rename
 * @property {(from: string, to: string) => void} copyFile
 * @property {(from: string, to: string, opts?: any) => void} cp Copy a file OR a whole tree. Needed
 * because renaming a character copies its entire chats directory, and content seeding copies trees.
 * @property {(p: string, opts?: any) => void} rm
 *
 * @property {(res: import('express').Response, p: string, opts?: any) => Promise<void>} sendFile
 *
 * ⚠️ THE THREE BELOW ARE CALLED BY THE FORK AND WERE ABSENT FROM THIS CONTRACT. `jsconfig.json` sets
 * `checkJs` with `strictNullChecks`, so dereferencing them off `provider` is a type error against the
 * project's own configuration — invisible today only because `npm run lint` has no `tsc` step. More to
 * the point, this block is what a provider author reads, and three live methods were not in it.
 * @property {(p: string) => number|null} [envelopeVersionAt] Which envelope version wrote the bytes at a
 * logical path, or null if the provider cannot say. See `DESIGN_STORAGE_PROVENANCE.md` §12.1.
 * @property {(handle: string, label: string) => any} [deriveSubkey] Hand a caller a key derived from this
 * user's, namespaced by `label`, so a plugin never holds the user's own key.
 * @property {(handle: string, store: any) => void} [registerForeignStore] Adopt a store the provider did
 * not create, so it locks and rekeys with everything else.
 *
 * @property {() => any} [multerStorage] The library seams. Added in F3; see the design doc §7.5.
 * @property {(handle: string) => {parse: Function, stringify: Function}} [keyValueOptions]
 * @property {(p: string) => any} [vectorIndex]
 */

/**
 * The single registered provider, or null.
 * @type {StorageProvider|null}
 */
let provider = null;

/**
 * Register a Storage Provider. At most one may exist.
 * @param {StorageProvider} newProvider The provider to register
 * @returns {void}
 */
export function registerStorageProvider(newProvider) {
    if (provider) {
        throw new Error(`A storage provider is already registered ('${provider.id}'); '${newProvider?.id}' cannot also register. Only one provider may exist.`);
    }

    if (!newProvider || typeof newProvider !== 'object') {
        throw new Error('A storage provider must be an object.');
    }

    // `unlock`, `lock` and `rekey` are in this list because they are called WITHOUT a typeof check —
    // `unlock` at :375, `lock` at :448, `rekey` at :508, where the `?.` guards a null provider and not
    // a missing member. A provider without them registers cleanly and then TypeErrors on the first
    // login. `recover` is deliberately NOT here: it is optional and :574 refuses it by name.
    const required = ['id', 'owns', 'init', 'isReady', 'readFile', 'readFileSync', 'createReadStream', 'exists', 'stat', 'readdir', 'writeFile', 'writeFileSync', 'createWriteStream', 'mkdir', 'unlink', 'rename', 'copyFile', 'cp', 'rm', 'sendFile', 'unlock', 'lock', 'rekey'];
    const missing = required.filter(key => key === 'id' ? typeof newProvider.id !== 'string' : typeof newProvider[key] !== 'function');

    if (missing.length > 0) {
        throw new Error(`Storage provider '${newProvider.id}' is missing required members: ${missing.join(', ')}`);
    }

    // ⚠️ SAY SO WHEN A LIBRARY SEAM IS DECLINED. These three are optional because a provider can legitimately
    // ship without them, but a provider could omit ALL THREE and boot in total silence — and each one it
    // omits is a library the fork then lets write through to the plain filesystem, inside the vault root,
    // for data the provider was installed to protect. `DESIGN_STORAGE_PROVIDER_API.md` §7.5 lists them as
    // part of the contract; nothing enforced it and nothing mentioned it. A warning is not a refusal: only
    // `vectorIndex` is fatal at the call site, because it is the one whose cleartext is permanent at rest.
    const seams = ['multerStorage', 'keyValueOptions', 'vectorIndex'];
    const declined = seams.filter(seam => typeof newProvider[seam] !== 'function');

    for (const seam of declined) {
        log.warn(LogClass.NORMAL, `Storage provider '${newProvider.id}' does not implement the '${seam}' seam. Data handled by that library will NOT pass through the provider.`);
    }

    provider = newProvider;
}

/**
 * Get the registered provider, if any.
 * @returns {StorageProvider|null} The provider, or null if SillyTavern is running on the plain filesystem
 */
export function getStorageProvider() {
    return provider;
}

/**
 * Drop the registered provider. FOR TESTS ONLY — nothing in the server calls this.
 * @returns {void}
 */
export function unregisterStorageProvider() {
    provider = null;
}

/**
 * Does a provider own this path? False for every path when no provider is registered.
 * @param {string} p Logical path
 * @returns {boolean} True if the registered provider owns the path
 */
export function owns(p) {
    return !!provider && provider.owns(p);
}

/**
 * Is this user's storage ready to be read and written?
 *
 * Always true when no provider is registered — the plain filesystem is never unavailable, so upstream
 * behaviour is unchanged and every boot-time task fires exactly as it does today.
 * @param {string} handle User handle
 * @returns {boolean} True if the user's data can be served
 */
export function isReady(handle) {
    return !provider || provider.isReady(handle);
}

/**
 * Handlers waiting for a user's storage to become available.
 * @type {((handle: string) => Promise<void>)[]}
 */
const readyHandlers = [];

/**
 * Run something when a user's storage becomes available.
 *
 * 🔴 THIS EXISTS BECAUSE EVERY USER-DATA TASK IN SILLYTAVERN'S BOOT RUNS BEFORE ANYONE HAS LOGGED IN.
 *
 * `migrateSystemPrompts`, `migrateGroupChatsMetadataFormat`, `checkForNewContent`, `diskCache.verify`,
 * `migrateFlatSecrets`, `settingsInit` and `statsInit` all read and rewrite the user's chats, settings,
 * secrets and stats — at boot, unattended, before the server is even listening. A provider that cannot
 * serve a user's data yet (because nobody has unlocked it) would watch SillyTavern do all of that
 * against data it cannot read, and respond in the six ways catalogued in the design: by deleting it,
 * regenerating it, or quietly rewriting it.
 *
 * So the work has to WAIT. A provider reports a user unavailable; SillyTavern defers their maintenance
 * until it hears otherwise.
 *
 * The generic framing, which is what keeps this upstreamable: *a provider may report a user's storage
 * as unavailable, and SillyTavern must tolerate that and defer per-user maintenance until it becomes
 * available.* For the default filesystem there is no such thing as unavailable — `isReady` is always
 * true, every task fires at boot exactly as it does today, and upstream sees no behavioural change at
 * all.
 * @param {(handle: string) => Promise<void>} handler Called with the handle whose storage is now ready
 * @returns {void}
 */
export function onUserStorageReady(handler) {
    readyHandlers.push(handler);
}

/**
 * Announce that a user's storage is now available, and run whatever was waiting on it.
 * @param {string} handle User handle
 * @returns {Promise<void>}
 */
export async function notifyUserStorageReady(handle) {
    for (const handler of readyHandlers) {
        try {
            await handler(handle);
        } catch (error) {
            log.error(LogClass.NORMAL, 'A deferred storage-ready task failed for a user');
            log.error(LogClass.SENSITIVE, `Deferred storage task failed for ${handle}:`, error);
        }
    }
}

/**
 * Make a user's storage ready.
 * @param {string} handle User handle
 * @param {string} secret The user's secret (in practice, their login password)
 * @returns {Promise<void>}
 */
export async function unlock(handle, secret) {
    if (!provider) {
        return;
    }

    const wasReady = provider.isReady(handle);
    await provider.unlock(handle, secret);

    // 🔴 ANNOUNCE ONCE PER OPENING, NOT ONCE PER CALLER. `wasReady` is read BEFORE this await and consulted
    // after it — a check-then-act spanning a KEK derivation of hundreds of milliseconds. Every concurrent
    // unlock of the same handle therefore read `wasReady === false` and every one of them announced. That is
    // not a rare interleaving: under `perUserBasicAuth` EVERY request unlocks, static assets included, so a
    // single page load issued dozens in parallel. Each announcement runs `runUserMaintenanceTasks`, so ~20
    // copies of migrateSystemPrompts, checkForNewContent, diskCache.verify, migrateFlatSecrets,
    // cleanUserUploads, migrateAccountAvatar, settingsInit and statsInit ran against ONE user's directory at
    // once — duplicated seeded content, lost updates on settings.json, one run renaming a file another had
    // already moved, one deleting what another was staging. Upstream ran these once at boot and had no ready
    // notification at all, so the concurrency arrived with this hook.
    //
    // ⚠️ THE GUARD IS HERE AND NOT AROUND `provider.unlock`, DELIBERATELY. Sharing one in-flight unlock
    // between callers would also collapse the duplicate derivations, but it would let a caller presenting
    // the WRONG secret take the result of a concurrent unlock that presented the right one. Every caller
    // still proves its own secret to the provider; only the announcement is made once.
    //
    // The set is cleared by `lock()`, so the next genuine opening announces again.
    if (!wasReady && provider.isReady(handle) && !announcedReady.has(handle)) {
        announcedReady.add(handle);
        await notifyUserStorageReady(handle);
    }
}

/**
 * Handles whose storage has been announced ready and not yet shut. See {@link unlock}.
 * @type {Set<string>}
 */
const announcedReady = new Set();

/**
 * Handlers waiting for a user's storage to be shut.
 * @type {((handle: string) => Promise<void>)[]}
 */
const lockHandlers = [];

/**
 * Run something when a user's storage is shut.
 *
 * 🔴 THIS EXISTS BECAUSE ANYTHING HOLDING A KEY DERIVED FROM THIS USER'S STORAGE MUST DROP IT, AND ONLY
 * SILLYTAVERN KNOWS WHEN. A component that derived a subkey (see `deriveSubkey`) is holding key material
 * whose whole promise is that it dies with the vault. It cannot see the vault. It cannot poll for it
 * without keeping the key resident for exactly as long as it was trying not to. So it is told.
 *
 * ⚠️ HOOK THE FUNNEL, NOT THE CALLERS. There is more than one way a vault shuts — an explicit logout, and
 * the idle sweep — and there will be more later. The same argument is already written down for the READY
 * side (`server-main.js`, the activity clock): hooking the notification rather than the call sites means
 * every path is covered, including any path added after this comment. Registering here rather than in
 * `users-private.js` is the whole point.
 *
 * The default filesystem never shuts, so with no provider registered this never fires and upstream sees no
 * behavioural change at all.
 * @param {(handle: string) => Promise<void>} handler Called with the handle whose storage has been shut
 * @returns {void}
 */
export function onUserStorageLock(handler) {
    lockHandlers.push(handler);
}

/**
 * Announce that a user's storage has been shut, and run whatever was waiting on it.
 *
 * A handler that throws is logged and skipped. One plugin failing to close its database must not leave the
 * next plugin holding a key, and must not fail the logout that caused it.
 * @param {string} handle User handle
 * @returns {Promise<void>}
 */
export async function notifyUserStorageLock(handle) {
    for (const handler of lockHandlers) {
        try {
            await handler(handle);
        } catch (error) {
            log.error(LogClass.NORMAL, 'A storage-lock handler failed for a user');
            log.error(LogClass.SENSITIVE, `Storage lock handler failed for ${handle}:`, error);
        }
    }
}

/**
 * Make a user's storage unavailable.
 *
 * 🔑 THE KEY IS GONE BEFORE THE FIRST `await`. `provider.lock()` is synchronous and runs first, so the
 * provider's key material is dropped the instant this is called — the notification that follows cannot
 * delay it, and a handler that hangs cannot keep the vault open. The awaiting is only so that whoever
 * locked knows the handlers finished; the security property does not depend on it.
 *
 * Only a real transition notifies, mirroring `unlock`: locking a user who is already locked says nothing.
 * @param {string} handle User handle
 * @returns {Promise<void>}
 */
export async function lock(handle) {
    // 🔴 THE IN-MEMORY DROPS HAPPEN WITH OR WITHOUT A PROVIDER, AND THEY GO FIRST.
    //
    // These three maps hold decrypted user content — a notification's `data` may quote a memory a plugin
    // just wrote, the captured connection carries the character and persona names, the replay buffer names
    // World Books and avatars. NONE of that is about encryption: it is the user's content sitting in process
    // memory, and logout means drop it. They were below the `!provider` early return, so on a PLAINTEXT
    // install — the ordinary SillyTavern — nothing ever dropped any of it. `users-private.js` calls this on
    // logout precisely so it would, and it silently did nothing there; the notifications a user saw before
    // logging out were served straight back to whoever logged in next.
    //
    // 🔑 SYNCHRONOUS, AND BEFORE THE FIRST `await`, for the same reason `provider.lock()` is: a handler that
    // hangs must not be able to keep any of this alive. Cleared here rather than through `lockHandlers` for
    // that same reason.
    notifications.clearFor(handle);
    clearConnectionFor(handle);
    clearEventStreamFor(handle);

    // The store is shut, so the next opening is a genuine one and must announce. See `unlock`.
    announcedReady.delete(handle);

    if (!provider) {
        return;
    }

    const wasReady = provider.isReady(handle);

    // ⚠️ A PROVIDER THAT THROWS ON THE WAY OUT MUST NOT TAKE THE REST WITH IT. This call was unguarded, so a
    // throw skipped everything after it — and `notifyUserStorageLock` never fired, meaning anything holding
    // a subkey went on holding it after a logout or an idle lock. That matters MOST when a lock has gone
    // wrong. The clearing above already happened; the error is re-raised so the caller still learns of it.
    try {
        provider.lock(handle);
    } catch (error) {
        log.error(LogClass.NORMAL, 'The storage provider failed to lock a user; everything held for them in memory was dropped anyway.');
        log.error(LogClass.SENSITIVE, `provider.lock('${handle}') threw:`, error);
        throw error;
    }

    if (wasReady && !provider.isReady(handle)) {
        await notifyUserStorageLock(handle);
    }
}

/**
 * How long does the provider RECOMMEND a user's storage stay unlocked with the user doing nothing?
 *
 * 🔴 A RECOMMENDATION. NOT THE ANSWER. Read the name: this used to be `idleLockMs()` and it used to be
 * applied verbatim, and that was wrong in a way that took a user complaint to see. Three parties have a
 * legitimate say here and only one of them is the provider:
 *
 *   - **The provider** knows what is being protected and can say what it thinks is prudent. That is this.
 *   - **SillyTavern** is the only party that can SEE idleness — the provider is handed storage calls, and
 *     cannot tell a human clicking Send from a stats file being flushed in the background. So the
 *     mechanism is ours: the clock, the sweep, the warning.
 *   - 🔴 **The user** owns the data, sits in front of the machine, and is the only one who knows whether
 *     anyone else can reach it. They decide. `users.js` resolves this recommendation against their
 *     setting, and their setting wins — including when their setting is "never".
 *
 * Being logged out of your own chat on your own desktop, mid-sentence, because a plugin's default said
 * thirty minutes, is not a security win. It is how a fork gets uninstalled. See `users.js` §THE IDLE LOCK
 * for the resolution order, and `DESIGN_ENCRYPTED_STORAGE.md` §5.6 for why the default is "never".
 *
 * ⚠️ ASK LATE, NOT AT MODULE SCOPE. Providers register during boot, after every module has been imported.
 * A constant initialised at the top of a file would read this before any provider existed, get 0 for ever,
 * and the feature would be dead code that looked exactly like working code. That has already happened once
 * in this fork, to `multerStorage()`, and every upload in the application staged in the clear because of it.
 * @returns {number} Milliseconds the provider suggests; 0 means it suggests nothing
 */
export function idleLockRecommendationMs() {
    const ms = Number(provider?.idleLockMs ?? 0);

    return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Is there a provider at all?
 *
 * The idle lock asks this rather than asking for a number, because with the number now coming from the
 * USER the sweep can no longer decide at boot whether it will ever have work to do. What it can still
 * decide — and must, because a stock SillyTavern may not grow a timer it never had — is whether locking
 * is a concept that applies here at all. With no provider, nothing is lockable and there is no sweep.
 * @returns {boolean} True if a storage provider is registered
 */
export function hasProvider() {
    return !!provider;
}

/**
 * Ask the provider to describe a situation to the user, in its own words.
 *
 * 🔴 NULL MEANS "USE YOUR OWN DEFAULT", AND THE DEFAULT IS UPSTREAM'S. It does not mean "invent something
 * that sounds like a provider wrote it". With no provider installed this always returns null, and every
 * caller must then render exactly the text SillyTavern has always rendered.
 *
 * See {@link ProviderText} for the situations, and for why this exists at all.
 *
 * ⚠️ `'storage.identity'` comes back through here too, and it is DATA rather than words — see
 * {@link ProviderIdentityText}. The object check below is all this function does to it on purpose:
 * validating identity fields here would put the rule in two places, and it belongs in
 * `storage-provenance.js`, which is the only thing that stores them.
 * @param {string} situation Which situation is being drawn
 * @param {object} [context] Facts about it — see {@link StorageProvider.describe}
 * @returns {ProviderText|ProviderIdentityText|null} What to say, or null to say SillyTavern's own thing
 */
export function describe(situation, context) {
    // ⚠️ THE ONE PROVIDER-CALLBACK FORWARDER THAT DID NOT CATCH, AND TWO CALLERS DEPEND ON IT NOT THROWING.
    // `ownsUser`, `encryptsPath` and `envelopeVersionAt` all wrap theirs and each says why. A provider with
    // an ordinary `switch (situation) { default: throw }` — ordinary because the fork asks about nine
    // situations today and will add more — took out the whole chat list (storage-private.js has no try/catch
    // of its own), the backups list, `summariseUnavailableData` which documents itself as never throwing,
    // the ANONYMOUS status badge on the login page, and `recordProviderIdentity` at boot, which would have
    // killed the boot AFTER a successful `init()`. Only the return SHAPE was validated.
    let text;

    try {
        text = provider?.describe?.(situation, context);
    } catch (error) {
        log.warn(LogClass.NORMAL, 'The storage provider could not describe a situation; falling back to the fork\'s own wording.');
        log.warn(LogClass.SENSITIVE, `Provider describe('${situation}') threw:`, error);
        return null;
    }

    // A provider that answers with something that is not an object is answering nothing. Do not let a
    // malformed reply become a rendering error in a dialog the user cannot then dismiss.
    return text && typeof text === 'object' ? text : null;
}

/**
 * Change a user's secret.
 *
 * 🔴 This MAY THROW, and a caller must never swallow it. A provider that cannot re-key throws, and the
 * credential change must then be refused. Pushing a reset through anyway would orphan the user's data.
 * @param {string} handle User handle
 * @param {string|null} oldSecret The current secret, if known
 * @param {string} newSecret The new secret
 * @returns {Promise<void>}
 */
export async function rekey(handle, oldSecret, newSecret) {
    await provider?.rekey(handle, oldSecret, newSecret);
}

/**
 * Does a provider hold a key for this user that is derived from their password?
 *
 * 🔴 THE GUARD ON THE BLIND RESET.
 *
 * SillyTavern ships a password reset that needs no old password: `/recover-step1` prints a code to the
 * server console, `/recover-step2` trades that code for a new password. Against the plain filesystem that
 * is fine — the data is sitting there in plaintext, so anyone who can read the console to get the code can
 * already read every chat directly. The reset hands out nothing that box access did not already give.
 *
 * Against a provider keyed from that password it is a catastrophe. The reset overwrites the password with
 * no key in hand, and the only pre-image of the wrapping key ceases to exist. The data is not leaked. It
 * is ORPHANED — still on the disk, still perfectly encrypted, permanently unreadable. That is worse than
 * leaked, and it is silent.
 *
 * So the rule is one sentence, and both cases fall out of it: **a secret may be changed only when the key
 * can be re-wrapped, or when there is no key.** This asks which one we are in.
 *
 * When the answer is unknown — a provider that does not implement `ownsUser` — the answer is YES. A wrong
 * "no" destroys data; a wrong "yes" merely makes someone use their recovery key.
 * @param {string} handle User handle
 * @returns {boolean} True if resetting this user's password without their old one would orphan their data
 */
export function ownsUser(handle) {
    if (!provider) {
        return false;
    }

    if (typeof provider.ownsUser !== 'function') {
        return true;
    }

    try {
        return provider.ownsUser(handle);
    } catch {
        // A provider that throws here has told us nothing, and the safe reading of nothing is the same as
        // the safe reading of silence: assume it owns them. This guard is not decoration — `ownsUser` is
        // reached from the ANONYMOUS user list, and an exception escaping there rejects a promise nobody
        // is positioned to catch.
        return true;
    }
}

/**
 * Is the content at this path encrypted at rest by the installed provider?
 *
 * The question the per-chat padlock is drawn from (`DESIGN_MIXED_MODE.md` §6). It is NOT {@link owns}: in
 * mixed mode a provider owns a great many paths it passes through in the clear, because a chat that was
 * not encrypted when it was created stays unencrypted for ever. Only the provider knows which is which,
 * so only the provider can be asked.
 *
 * 🔴 UNKNOWN MEANS FALSE HERE, WHICH IS THE OPPOSITE OF {@link ownsUser} — and the difference is not an
 * inconsistency, it is the same principle applied to a different question. `ownsUser` asks "would resetting
 * this password destroy data?", where a wrong "no" is unrecoverable and a wrong "yes" merely inconveniences
 * someone, so silence means yes. This asks "may I tell the user their chat is protected?", where the
 * damaging answer is the reassuring one: a padlock drawn over a plaintext chat is a lie that someone may
 * act on. So a provider that cannot say gets no marker, and §7.2 makes that the whole design of the UI —
 * presence is the signal, absence is the default, and plaintext chats are marked with nothing at all.
 *
 * Never throws: a chat may be deleted between the list being built and this being asked.
 * @param {string} p Absolute path
 * @returns {boolean} True only if the provider affirmatively says it encrypts this path
 */
export function encryptsPath(p) {
    if (typeof provider?.encryptsPath !== 'function') {
        return false;
    }

    try {
        return provider.encryptsPath(p) === true;
    } catch {
        // A provider that throws here has told us nothing, and "nothing" is not "protected".
        return false;
    }
}

/**
 * Which envelope version wrote the bytes at a logical path, according to the loaded provider — or null.
 *
 * 🪪 `DESIGN_STORAGE_PROVENANCE.md` §12.1. The one skew this design has to catch — *"you have the plugin and
 * it still will not open, because the file was written by a build yours does not understand"* — cannot be
 * seen from the fork side, because while a name-encrypting provider is installed the fork cannot name the
 * file on disk to read its header. Only the provider can resolve a logical path to its own bytes, so only the
 * provider can answer this, which is the same conclusion §6.1 reached for {@link encryptsPath}.
 *
 * 🔴 null MEANS UNKNOWN, AND THAT IS SEVEN SITUATIONS COLLAPSED ON PURPOSE (the provider's own contract): a
 * locked vault, a legacy plaintext file, a path that no longer exists, a damaged header, a scheme with no
 * envelope, a provider that does not implement the method, and a provider that is simply gone. None of them
 * is a skew, and code that read null as "stale" or "not ours" would tell every row in a locked account to go
 * and update a current plugin. The only correct handling upstream is: learn nothing, disable nothing.
 *
 * Wrapped exactly like {@link encryptsPath} — optional, `typeof`-guarded, and it swallows a throw — with one
 * addition: a shape check. A hostile or broken provider may return anything, and `undefined` must never
 * compare its way into a skew, so a non-integer (or a negative) is treated as "did not answer" → null.
 * @param {string} p Absolute logical path
 * @returns {number|null} The envelope version on the file, or null when it cannot be known
 */
export function envelopeVersionAt(p) {
    if (typeof provider?.envelopeVersionAt !== 'function') {
        return null;
    }

    try {
        const version = provider.envelopeVersionAt(p);
        return Number.isInteger(version) && version >= 0 ? version : null;
    } catch {
        return null;
    }
}

/**
 * The envelope versions the loaded provider declares it can READ — a validated `number[]`, or null.
 *
 * 🔴 READ LIVE FROM THE DECLARATION, NOT FROM THE REGISTRY (§12.1, and the Vault session's finding on it).
 * The skew check is the one surface in this whole design that fires ONLY while the provider is installed, so
 * `describe('storage.identity')` is available and cannot be stale. The registry is the wrong source here for
 * a specific reason: a declaration with one malformed field is recorded by id alone (`recordProviderIdentity`
 * refuses the whole thing), so a provider that is loaded, running, and answering {@link envelopeVersionAt}
 * correctly could have NO `envelopeVersions` in the registry — and skew detection would switch itself off
 * silently for a working provider. Reading the field live, and validating just this field here, closes that.
 *
 * ⚠️ null when the provider declares nothing, declares an empty list, or declares a list with no usable
 * integers. That is silence, and 🔴 **silence must mean readable** — no declared versions disables nothing,
 * or every install whose provider predates this field goes dark.
 * @returns {number[]|null} The readable versions, or null when the provider has not usefully said
 */
export function providerReadableEnvelopeVersions() {
    const declared = describe('storage.identity')?.envelopeVersions;

    if (!Array.isArray(declared) || declared.length === 0) {
        return null;
    }

    const clean = declared.filter(v => Number.isInteger(v) && v >= 0);
    return clean.length > 0 ? clean : null;
}

/**
 * Is there a way back in for a user who has forgotten their password?
 * @param {string} handle User handle
 * @returns {boolean} True if `recover()` can be called for this user
 */
export function canRecover(handle) {
    return ownsUser(handle) && typeof provider?.recover === 'function';
}

/**
 * The second door: re-key from a recovery secret the user kept outside the machine.
 *
 * This is the ONLY way back in once a provider owns a user, and it is deliberately the only way. An
 * unconditional server-side reset that works with mere box access *is itself the backdoor* — anyone with
 * root could run it and take the account without ever proving they are the owner. A recovery secret held
 * off the machine is proof; a code printed to the machine's own console is not.
 *
 * One action solves both halves: it restores access to the data AND lets the caller set a new password.
 * Lose the recovery secret and you lose both. One rule, not two.
 *
 * 🔴 THROWS on a wrong secret, and the caller must let it. A recovery that "succeeds" without unwrapping
 * anything would reset the password and orphan the data — the exact disaster this exists to prevent.
 * @param {string} handle User handle
 * @param {string} recoverySecret The recovery key
 * @param {string} newSecret The new password to re-wrap under
 * @returns {Promise<void>}
 */
export async function recover(handle, recoverySecret, newSecret) {
    if (!provider) {
        throw new Error('No storage provider is registered, so there is nothing to recover.');
    }

    if (typeof provider.recover !== 'function') {
        throw new Error(`Storage provider '${provider.id}' has no recovery path. A forgotten password cannot be recovered.`);
    }

    const wasReady = provider.isReady(handle);
    await provider.recover(handle, recoverySecret, newSecret);

    // Recovery proves possession and leaves the user unlocked — they are about to log in. So whatever was
    // deferred at boot fires now, exactly as it would after a normal unlock.
    if (!wasReady && provider.isReady(handle)) {
        await notifyUserStorageReady(handle);
    }
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

/**
 * Read a file.
 * @param {string} p Logical path
 * @param {any} [opts] Encoding or options, as node:fs takes them
 * @returns {Promise<Buffer|string>} The file's logical contents
 */
export async function readFile(p, opts) {
    if (owns(p)) {
        return await provider.readFile(p, opts);
    }

    return await fs.promises.readFile(p, opts);
}

/**
 * Read a file, synchronously.
 * @param {string} p Logical path
 * @param {any} [opts] Encoding or options, as node:fs takes them
 * @returns {Buffer|string} The file's logical contents
 */
export function readFileSync(p, opts) {
    if (owns(p)) {
        return provider.readFileSync(p, opts);
    }

    return fs.readFileSync(p, opts);
}

/**
 * Open a readable stream over a file. Ranges are supported and must remain so: browsers seek into
 * audio and video served out of the user's image directory.
 * @param {string} p Logical path
 * @param {{start?: number, end?: number}} [opts] Byte range, in LOGICAL bytes
 * @returns {import('node:stream').Readable} A stream of the file's logical contents
 */
export function createReadStream(p, opts) {
    if (owns(p)) {
        return provider.createReadStream(p, opts);
    }

    return fs.createReadStream(p, opts);
}

/**
 * Does a file exist?
 * @param {string} p Logical path
 * @returns {boolean} True if the file exists
 */
export function exists(p) {
    if (owns(p)) {
        return provider.exists(p);
    }

    return fs.existsSync(p);
}

/**
 * Stat a file. `.size` is the LOGICAL size — it becomes `Content-Length` on the way out.
 * @param {string} p Logical path
 * @returns {fs.Stats} Stats, with a logical size
 */
export function stat(p) {
    if (owns(p)) {
        return provider.stat(p);
    }

    return fs.statSync(p);
}

/**
 * List a directory. Returns LOGICAL names.
 * @param {string} p Logical path
 * @param {any} [opts] Options, as node:fs takes them
 * @returns {string[]} Logical entry names
 */
export function readdir(p, opts) {
    if (owns(p)) {
        return provider.readdir(p, opts);
    }

    return fs.readdirSync(p, opts);
}

// ---------------------------------------------------------------------------------------------
// Write — every write through this API is atomic
// ---------------------------------------------------------------------------------------------

/**
 * Write a file atomically.
 *
 * ⚠️ `opts` is load-bearing. It is usually an encoding, and `'base64'` in particular means `data` is a
 * base64 STRING that must be DECODED into bytes on the way to disk — that is how sprites and Data Bank
 * uploads are written. A provider that ignores it will faithfully transform the wrong bytes.
 * @param {string} p Logical path
 * @param {any} data The logical contents
 * @param {any} [opts] Encoding or options, as write-file-atomic takes them
 * @returns {Promise<void>}
 */
export async function writeFile(p, data, opts) {
    if (owns(p)) {
        return await provider.writeFile(p, data, opts);
    }

    await writeFileAtomic(p, data, opts);
}

/**
 * Write a file atomically, synchronously. See {@link writeFile} on why `opts` matters.
 * @param {string} p Logical path
 * @param {any} data The logical contents
 * @param {any} [opts] Encoding or options, as write-file-atomic takes them
 * @returns {void}
 */
export function writeFileSync(p, data, opts) {
    if (owns(p)) {
        return provider.writeFileSync(p, data, opts);
    }

    writeFileAtomicSync(p, data, opts);
}

/**
 * Open a writable stream over a file.
 * @param {string} p Logical path
 * @param {any} [opts] Options, as node:fs takes them — notably `{ flags: 'wx' }`
 * @returns {import('node:stream').Writable} A stream accepting logical contents
 */
export function createWriteStream(p, opts) {
    // ⚠️ `opts` IS FORWARDED, AND IT WAS BEING DROPPED. The asset download passes `{ flags: 'wx' }` — the
    // exclusive-create that makes a second concurrent download of the same filename fail with EEXIST
    // instead of interleaving into the first one's temp file. This signature took one parameter, so both
    // the provider call and the `fs` fallback silently discarded it and two writers opened the same path
    // for truncating write, producing a corrupt file that then gets copied in as a valid-looking asset.
    if (owns(p)) {
        return provider.createWriteStream(p, opts);
    }

    return fs.createWriteStream(p, opts);
}

/**
 * Create a directory.
 * @param {string} p Logical path
 * @param {any} [opts] Options, as node:fs takes them
 * @returns {void}
 */
export function mkdir(p, opts) {
    if (owns(p)) {
        return provider.mkdir(p, opts);
    }

    fs.mkdirSync(p, opts);
}

/**
 * Delete a file.
 * @param {string} p Logical path
 * @returns {void}
 */
export function unlink(p) {
    if (owns(p)) {
        return provider.unlink(p);
    }

    fs.unlinkSync(p);
}

/**
 * Rename a file.
 * @param {string} from Logical source path
 * @param {string} to Logical destination path
 * @returns {void}
 */
export function rename(from, to) {
    if (owns(from) || owns(to)) {
        return provider.rename(from, to);
    }

    fs.renameSync(from, to);
}

/**
 * Copy a file.
 * @param {string} from Logical source path
 * @param {string} to Logical destination path
 * @returns {void}
 */
export function copyFile(from, to) {
    if (owns(from) || owns(to)) {
        return provider.copyFile(from, to);
    }

    fs.copyFileSync(from, to);
}

/**
 * Copy a file or a whole directory tree.
 *
 * This is an addition to the interface as originally designed, and it is not optional. SillyTavern
 * does recursive directory copies of user data in several places — renaming a character copies its
 * entire chats directory, and seeding default content copies whole trees of characters and presets.
 * `copyFile` cannot express that, and a provider that never sees these calls would miss entire
 * directories of the user's data.
 * @param {string} from Logical source path
 * @param {string} to Logical destination path
 * @param {any} [opts] Options, as node:fs takes them (notably `recursive`)
 * @returns {void}
 */
export function cp(from, to, opts) {
    if (owns(from) || owns(to)) {
        return provider.cp(from, to, opts);
    }

    fs.cpSync(from, to, opts);
}

/**
 * Remove a file or directory tree.
 * @param {string} p Logical path
 * @param {any} [opts] Options, as node:fs takes them
 * @returns {void}
 */
export function rm(p, opts) {
    if (owns(p)) {
        return provider.rm(p, opts);
    }

    fs.rmSync(p, opts);
}

/**
 * A recovery secret the provider has minted and wants shown to the user.
 *
 * 🔴 THIS IS THE ONLY WAY BACK INTO AN ENCRYPTED ACCOUNT, AND IF IT IS NEVER DISPLAYED, NOTHING SAYS SO.
 *
 * A provider that keys a user's data from their password has, by construction, no way to reset that
 * password — see {@link ownsUser}. The recovery secret IS the second door. The provider cannot store it (a
 * stored recovery secret is a second copy of the key, sitting next to the data, which defeats the whole
 * point), so it lives in the provider's memory and in exactly one other place: in front of the user's eyes,
 * if SillyTavern puts it there.
 *
 * ⚠️ ASKING DOES NOT CONSUME IT. Only {@link acknowledgeRecoverySecret} does. A destructive read here would
 * mean a page refresh at the wrong moment silently threw away the only copy — so ask as often as you like,
 * and keep asking until the user says they have it.
 *
 * Returns null when there is nothing pending, which is the normal case on almost every login.
 * @param {string} handle User handle
 * @returns {string|null} The secret to show the user, or null
 */
export function pendingRecoverySecret(handle) {
    return provider?.pendingRecoverySecret?.(handle) ?? null;
}

/**
 * The user says they have saved their recovery secret. Tell the provider to stop offering it.
 *
 * This is the user's own assertion, and nothing else can stand in for it. "SillyTavern rendered it" is not
 * evidence that a human wrote it down, and a provider that assumed otherwise would stop offering a secret
 * nobody ever read.
 * @param {string} handle User handle
 * @returns {void}
 */
export function acknowledgeRecoverySecret(handle) {
    provider?.acknowledgeRecoverySecret?.(handle);
}

/**
 * Can this user ask for a NEW recovery secret, replacing the one they have?
 * @param {string} handle User handle
 * @returns {boolean} True if {@link regenerateRecoverySecret} will do anything
 */
export function canRegenerateRecoverySecret(handle) {
    return ownsUser(handle) && typeof provider?.regenerateRecoverySecret === 'function';
}

/**
 * Issue a NEW recovery secret for a user, retiring the old one.
 *
 * 🔴 SILLYTAVERN MUST PASS THE SECRET THROUGH, AND MUST NOT DECIDE THAT IT IS UNNECESSARY.
 *
 * The temptation here is obvious and it is a trap. The user is already logged in — SillyTavern has already
 * checked their password, the provider is already unlocked — so why ask again? Because *being signed in is
 * not the same as knowing the password*, and a recovery secret is not an ordinary read.
 *
 * A recovery secret opens the account FOR EVER, from anywhere, with nothing else. If merely having a live
 * session were enough to mint one, then anyone who reached a live session — a borrowed desk, a stolen
 * cookie, a hostile UI extension — could mint one, write it down, and keep the account permanently. It would
 * outlive the logout, the restart and the idle lock, which are the whole boundary of the design.
 *
 * So SillyTavern's job is to give the user somewhere to type their password and to CARRY IT, exactly as it
 * does for `rekey`. Whether the provider demands it is the provider's call, expressed by throwing. What
 * SillyTavern must never do is fail to ask, because then no provider *can* demand it.
 *
 * 🔴 THROWS on a bad secret, and the caller must let it: report the provider's own message and change
 * nothing.
 * @param {string} handle User handle
 * @param {string} secret The user's current secret, as proof of identity
 * @returns {Promise<void>}
 */
export async function regenerateRecoverySecret(handle, secret) {
    if (!provider || typeof provider.regenerateRecoverySecret !== 'function') {
        throw new Error('This account\'s storage provider cannot issue a new recovery key.');
    }

    await provider.regenerateRecoverySecret(handle, secret);
}

// ---------------------------------------------------------------------------------------------
// Library seams — the places a third-party library writes user data itself
// ---------------------------------------------------------------------------------------------

/**
 * Options to hand to a `node-persist` store so that a provider controls its bytes.
 *
 * node-persist takes `parse` and `stringify` as first-class options — they default to JSON's, and they
 * are the ONLY path to and from its disk. So supplying a pair transforms the store completely, with
 * zero patching of the library. It is the one library seam we get for free.
 *
 * Two constraints a provider must respect, both read out of the library's source rather than guessed:
 *
 * - `copy()` is implemented as `parse(stringify(value))` and runs on EVERY `setItem`, against the raw
 *   value rather than the stored envelope. So the pair has to be a pure symmetric transform that is
 *   valid on an arbitrary value — not something that only works on a `{key, value, ttl}` object.
 * - The store reads and writes with `encoding: 'utf8'`. Whatever `stringify` returns must therefore be
 *   a UTF-8-safe STRING — base64 or hex, never a raw Buffer.
 *
 * A provider may ALSO return `getDatumPath(key)`, which is how node-persist decides what to call the file
 * it writes. It is not an option — it is a method on the library's prototype, and `setOptions()` silently
 * drops anything it does not recognise — so the caller applies it to the instance instead. It matters
 * because the default is `path.join(dir, sha256(key))` and the key is a PLAINTEXT PATH: an unkeyed hash of
 * a filename is a confirmation oracle for anyone who can read the disk.
 *
 * With no provider registered this returns nothing and node-persist keeps its JSON defaults.
 * @param {string} handle User handle whose store this is
 * @returns {object} Options to spread into the store's constructor, plus an optional `getDatumPath`
 */
export function keyValueOptions(handle) {
    return provider?.keyValueOptions?.(handle) ?? {};
}

/**
 * A multer StorageEngine, so uploads are written by the provider rather than straight to disk.
 *
 * multer's `storage` option takes precedence over `dest`, and the engine contract is just two methods.
 * By the time it runs, `setUserDataMiddleware` has already populated `req.user` — so the engine knows
 * whose upload it is.
 *
 * Returns null with no provider registered, which tells the caller to fall back to a plain `dest`.
 * @returns {any} A multer StorageEngine, or null
 */
export function multerStorage() {
    return provider?.multerStorage?.() ?? null;
}

/**
 * A replacement for `vectra.LocalIndex`, backed by the provider.
 *
 * vectra is the one library with no seam at all. It `require`s node:fs at module scope, its constructor
 * takes exactly one argument (a folder path), and it offers no `options.fs`, no storage adapter and no
 * serializer hook. It reads and writes its own index.json and nothing here can intercept it.
 *
 * That would be a footnote, except for WHAT IT STORES: SillyTavern upserts `metadata.text` — the
 * VERBATIM source chunk. Not the embedding, the text. Chat messages, World Info entries, Data Bank
 * documents, all inlined into one JSON file, because ST calls createIndex() with no arguments so
 * nothing is ever written to a sidecar.
 *
 * ∴ vectra cannot be wrapped. It has to be REPLACED. The fork does not do that — it just opens the
 * door and lets a provider walk through it. Everything SillyTavern touches sits behind `getIndex()` in a
 * single file, so the surface a provider must implement is small:
 *
 *     isIndexCreated, createIndex, beginUpdate, upsertItem, endUpdate,
 *     deleteItem, listItems, listItemsByMetadata, queryItems, getIndexStats
 *
 * ⚠️ AND TWO MORE THAT THIS LIST USED TO OMIT, which is not a documentation nit: the corrupt-index recovery
 * path calls BOTH of them, so a provider that implemented exactly what it was told to would TypeError from
 * inside an error handler. `getIndexStats` is the reverse case — listed, and never actually called.
 *
 *     deleteIndex()   discard the index entirely, for the corrupt-index recovery path
 *     folderPath      a string, for the log line that names what is being discarded
 *
 * Both are treated as optional at the call site (`vectors.js`, `regenerateCorruptedIndexErrorHandler`): a
 * provider that omits them gets a refusal and a 500 rather than a hung request, because recovery that
 * cannot run must say so rather than crash.
 *
 * Returns null with no provider, and SillyTavern goes on using vectra exactly as it always has.
 * @param {string} p Logical path to the index folder
 * @returns {any} A vectra-compatible index, or null
 */
export function vectorIndex(p) {
    return provider?.vectorIndex?.(p) ?? null;
}

/**
 * Can this user's storage supply key material at all?
 *
 * 🔴 THIS EXISTS BECAUSE `null` FROM `deriveSubkey()` IS AMBIGUOUS, AND THE TWO MEANINGS NEED OPPOSITE
 * RESPONSES. "No provider is installed" means *give up and say so* — there is no key here and there never
 * will be. "The user is locked" means *wait* — this is normal, temporary, and resolves when they log in.
 * A caller that cannot tell them apart either gives up on a vault that was merely locked, or waits for ever
 * on a key that is never coming.
 *
 * ⚠️ THIS IS NOT `ownsUser()`, AND IT MUST NOT BE BUILT ON IT. Two different questions look like this one:
 *
 *   (a) does the installed provider offer derivation at all?  — knowable, definitively, right now
 *   (b) does THIS user have a key sitting there this instant? — not knowable, and not what anyone needs
 *
 * Only (a) belongs here, and the reasons are symmetrical:
 *
 * `ownsUser` answers a question about password resets, and deliberately answers YES when it does not know
 * (`storage.js:540`) — a wrong "no" there destroys data, so the safe default is "yes". That default is
 * exactly backwards for (a): a provider with no `deriveSubkey` would report `ownsUser: true`, and a caller
 * reading that as "vault present, just locked" would wait for ever for a key that does not exist.
 *
 * 🔴 AND IT IS WRONG IN THE OTHER DIRECTION TOO, WHICH COST A REAL BUG. A provider may create a user's vault
 * LAZILY, on their first unlock — the real one does; `ownsUser` there is "does a vault file exist yet". So
 * before anyone has ever logged in, `ownsUser` is false for every user on a perfectly good encrypted
 * install. A version of this function built on it answers "there is no secure storage here" to a plugin
 * doing a startup check, and that plugin fails loudly on a machine that is working correctly. Answering (a)
 * alone is immune: a provider that offers derivation offers it, whether or not anyone has logged in yet.
 *
 * ∴ per-user liveness is `isReady()`'s job, and "is there a key for me right this second" is
 * `deriveSubkey()` returning null. This one says only whether waiting for either could ever be worth it.
 * @param {string} handle User handle. Unused today — a provider that wants to answer per-user can be given
 * the chance later, but nothing may make the answer *narrower* than "could this ever yield a key".
 * @returns {boolean} True if a provider is installed that can derive keys
 */
export function hasSecureStorage(handle) {
    return !!provider && typeof provider.deriveSubkey === 'function';
}

/**
 * Derive a named subkey from the provider's key material for this user.
 *
 * A component that needs to protect its own data has two choices: invent a second secret for the user to
 * manage and lose, or bind itself to the one they already have. This is the second. The provider already
 * holds key material for an unlocked user; this lets it mint a *derived*, domain-separated key from it,
 * so that whatever is protected locks and unlocks with the user's storage and there is no new secret in
 * the world.
 *
 * ⛔ THE FORK DERIVES NOTHING. This is a forwarding call and must stay one. Whatever the derivation is —
 * HKDF or otherwise — belongs to the provider, in the provider's own repository, where it cannot conflict
 * with an upstream release. Every line of crypto that is not in this file is a line that never has to be
 * merged.
 *
 * The `info` label is the CALLER'S. Domain separation is their business; this function must not namespace
 * it, validate it, or interpret it. Two different labels must yield two different keys, which is the
 * provider's contract to keep, not ours to enforce.
 *
 * Returns null in three cases the caller must tell apart — no provider, no derivation offered, or the user
 * is locked. Use `hasSecureStorage()` to distinguish the first two from the third; a bare null is not
 * enough to act on.
 * @param {string} handle User handle
 * @param {string} info Domain-separation label, chosen by the caller
 * @param {number} length Bytes required
 * @returns {Buffer|null} Key material, or null
 */
export function deriveSubkey(handle, info, length) {
    return provider?.deriveSubkey?.(handle, info, length) ?? null;
}

/**
 * Declare that a directory belongs to the caller, which encrypts it itself.
 *
 * 🔴 THIS IS THE OTHER HALF OF `deriveSubkey`, AND THE ONE THAT IS EASY TO SKIP. A plugin that takes a
 * derived key and opens its own encrypted database has produced a file that is genuinely protected and,
 * to a provider's leak detector, **indistinguishable from a leak** — a SQLCipher database is sixteen bytes
 * of random salt where the provider expects its own envelope header. So the audit reports it as plaintext.
 * Not once: on every run, for ever.
 *
 * A leak detector with a permanent false positive is a leak detector nobody reads, and the real leak lands
 * in a report the operator has been trained to skim past. The confidentiality was never at risk; the
 * DETECTOR was. This call is how that is avoided, and a plugin holding a subkey that never makes it is
 * quietly corroding the thing that would catch its own mistakes.
 *
 * ⛔ THE FORK CLASSIFIES NOTHING. This is a forwarding call and must stay one. What a declaration means,
 * how it is checked, whether it is persisted and what an audit does with it are the provider's business,
 * in the provider's own repository. The fork does not know what a leak looks like and must not learn.
 *
 * ⚠️ IT THROWS, AND THE THROW MUST REACH THE CALLER. A provider refuses a declaration with no directory,
 * no owner, or one climbing out of the user's directory. Swallowing that would leave a plugin believing
 * its store was declared when it was not — which is exactly the state this call exists to prevent, now
 * with the plugin's confidence attached to it.
 *
 * Returns false with no provider installed, and that is not an error: an install with no encryption has no
 * leak detector to confuse. A plugin should still check, because false means the declaration reached
 * nobody.
 * @param {{directory: string, owner: string, forbidden?: string[]}} store Directory (relative to the user's
 * own directory), who owns it, and head-of-file signatures that must never appear in it
 * @returns {boolean} True if a provider took the declaration; false if there was nobody to tell
 */
export function registerForeignStore(store) {
    if (!provider?.registerForeignStore) {
        return false;
    }

    provider.registerForeignStore(store);
    return true;
}

// ---------------------------------------------------------------------------------------------
// Serve
// ---------------------------------------------------------------------------------------------

/**
 * Send a file in an HTTP response.
 *
 * ⚠️ A provider implementing this must set `Content-Type` itself. Express's own `sendFile` infers it
 * from the file extension; a provider that reads into a buffer and calls `res.send()` gets no such
 * favour, and every avatar in the application turns into `application/octet-stream`.
 * @param {import('express').Response} res The response to write to
 * @param {string} p Logical path
 * @param {any} [opts] Options, as Express's `sendFile` takes them
 * @returns {Promise<void>}
 */
export async function sendFile(res, p, opts) {
    if (owns(p)) {
        return await provider.sendFile(res, p, opts);
    }

    // Express's sendFile requires an absolute path unless it is given a `root`. Every caller here
    // passes an absolute logical path, so resolve and hand it over — and let Express go on inferring
    // Content-Type from the extension exactly as it does today. A provider does NOT get that for free;
    // see the warning above.
    return await new Promise((resolve, reject) => {
        res.sendFile(path.resolve(p), opts ?? {}, (error) => error ? reject(error) : resolve());
    });
}
