import fs from 'node:fs';
import path from 'node:path';

import { normal, sensitive } from './logging.js';
import { dropForHandle } from './session-state.js';
import { MemoryStore } from './store.js';
import { repairLeakedTags } from './ingest/repair.js';

/**
 * A user's memory session: the open store, the file it lives in, and the events that open and shut it.
 *
 * ## What this module owns
 *
 * One SQLCipher connection per unlocked user, and the whole lifecycle around it — where the database file
 * goes, the subkey label it is encrypted under, opening on unlock, shutting on lock, and the two chat-lifetime
 * signals (deletion and rename) that act on an open store. Everything here is keyed on a handle, and nothing
 * here knows what a memory is.
 *
 * ## 🔴 What this module is really defending
 *
 * The database key is derived from the user's vault. That buys three properties, and all three are only real
 * if this file keeps them:
 *
 *   - **No new secret.** The user manages one password. Memory rides on it.
 *   - **Memory locks with the vault.** When they log out, the key goes. That is NFR1, and it is a promise
 *     this file keeps by hand — nothing else will keep it for us. {@link closeFor} is where.
 *   - **Recovery is free.** The recovery key derives the DEK, so it derives kMemoryDb. Confirmed by the
 *     Vault chat rather than assumed.
 *
 * ## 🔴 The key is a parameter, never a field — here as well as in MemoryStore
 *
 * {@link openFor} asks for the key at the one moment it can exist (the user has just unlocked), hands it to
 * `MemoryStore.open`, and zeroes it in a `finally`. Nothing in this module holds one, and nothing may start:
 * "ask late, not at module scope" is the rule, and at plugin init there are no users, no unlocked vaults and
 * no keys to ask about.
 */

/** The subkey label. 🔴 FROZEN once any database exists — Vault derives under
 * `sillytavern-encrypted-storage:plugin:` + this, and changing either half locks every user out of their own
 * memory for ever. Adding a new label is free; changing this one is data loss. */
const SUBKEY_LABEL = 'mnemosyne-db-v1';

/** SQLCipher wants 32 bytes. */
const KEY_BYTES = 32;

/**
 * The one directory Mnemosyne writes into, relative to a user's own directory.
 *
 * 🔴 SHARED BY THE PATH AND THE DECLARATION, ON PURPOSE. This string is the file we write ({@link
 * databasePath}) *and* the claim we make about it ({@link FOREIGN_STORE}), and the two must never drift.
 * Written out twice, renaming the directory in one place leaves the other declaring a directory nothing
 * uses — which fails in the worst available way: the audit keeps reporting the real store as plaintext,
 * and the declaration that was supposed to stop it looks present in the source.
 */
const MEMORY_DIRECTORY = 'memory';

/**
 * Where a user's memory database lives: `<userDirectory>/memory/store.db`.
 *
 * The path comes from `context.userDirectory(handle)` — the same per-user root the fork gets from
 * `users.getUserDirectories(handle).root`. This replaced a `globalThis.DATA_ROOT` read: a plugin has no
 * business reaching into the fork's globals, and the context now hands over exactly the one path we may know
 * and no more (capability 6).
 *
 * ⚠️ The path is not the key. `userDirectory` answers even while the vault is shut — it says where the file
 * goes, not whether we may open it. `hasSecureStorage`/`deriveSubkey` answer that; this does not.
 *
 * The file is SQLCipher's, written by native code, so it does not pass through Vault's storage funnel and is
 * not double-encrypted. It is already ciphertext — but it carries no `STV1` magic, which is why the
 * directory has to be declared at boot; see {@link FOREIGN_STORE} (NFR7).
 *
 * @param {import('./host/context.js').HostContext} host The fork, as we are allowed to see it
 * @param {string} handle User handle
 * @returns {string} Absolute path to the database
 */
function databasePath(host, handle) {
    return path.join(host.userDirectory(handle), MEMORY_DIRECTORY, 'store.db');
}

/**
 * The claim Mnemosyne makes about {@link MEMORY_DIRECTORY}: it is ours, and what is in it is already
 * encrypted — by us, under the subkey the provider gave us, not by the provider's own envelope.
 *
 * 🔴 THE OTHER HALF OF `deriveSubkey`. Taking a derived key and writing our own database produces a file
 * that is properly protected and, to a storage provider's audit, **indistinguishable from a leak**: the
 * shallow test is "every file starts with `STV1`", and a SQLCipher file starts with sixteen bytes of random
 * salt. Undeclared, `store.db` is reported as PLAINTEXT on every audit run for ever — and that is worse than
 * a cosmetic wart, because a leak detector with a permanent false positive is one the operator learns to
 * skim, so the next real leak lands in a report nobody reads. The confidentiality was never at risk. The
 * detector was.
 *
 * The declaration also keeps the directory's own NAME resolvable. A provider that name-encrypts everything
 * else admits a directory as structural only via its own fixed sets or via a foreign-store registration;
 * undeclared, anything that routes this path through the provider — a backup sweep, a `readdir` of the user
 * root — hands the literal string `memory` to its name decryptor, which throws. Vault's source records
 * having hit exactly that.
 *
 * ⚠️ `forbidden` IS LOAD-BEARING, NOT A FORMALITY. It is what makes the claim checkable without our
 * cooperation: `SQLite format 3\0` is the header of an *unencrypted* SQLite database, so declaring it means
 * the audit catches "SQLCipher was built without encryption support and quietly wrote a plain database".
 * That failure is invisible from inside this plugin, and it is realistic — npm's `allow-scripts` gate
 * reported `better-sqlite3-multiple-ciphers` install scripts as *not covered* during the the host install; the
 * binary was hand-verified to encrypt, but that is exactly the class of thing that regresses silently on a
 * rebuild. A store that declares nothing is reported as unverifiable rather than trusted, which buys us
 * nothing at all.
 *
 * Contract: the Taproom fork's storage provider API.
 * @type {{directory: string, owner: string, forbidden: string[]}}
 */
export const FOREIGN_STORE = {
    directory: MEMORY_DIRECTORY,
    owner: 'Mnemosyne',
    // 🔴 The trailing NUL is part of the signature, not a typo: the real header is sixteen bytes,
    // 'SQLite format 3' plus a terminating 0x00. Drop it and the signature is fifteen bytes of a
    // sixteen-byte header — still a correct prefix match here, but it stops being the documented constant,
    // and the next person to compare it against SQLite's file-format spec finds a mismatch and "fixes" it.
    forbidden: ['SQLite format 3\0'],
};

/**
 * Open stores, by handle. One SQLCipher connection per unlocked user, and none for anybody else.
 * @type {Map<string, MemoryStore>}
 */
const stores = new Map();

/** Handles we have already refused, so the log says it once rather than on every unlock. */
const refused = new Set();

/**
 * The store for an unlocked user, or null.
 *
 * ⚠️ Callers must not hold what this returns across a request boundary. It is valid only while the user's
 * vault is open, and on lock it is closed out from under any reference still pointing at it.
 *
 * @param {string} handle User handle
 * @returns {MemoryStore|null} The store, or null if the user is locked or has no vault
 */
export function storeFor(handle) {
    return stores.get(handle) ?? null;
}

/**
 * Open a user's store on unlock, or refuse loudly and permanently.
 *
 * @param {string} handle The user whose vault just opened
 * @param {import('./host/context.js').HostContext} host The fork, as we are allowed to see it
 * @returns {void}
 */
export function openFor(handle, host) {
    if (stores.has(handle)) {
        return;
    }

    // 🔴 THE WHOLE BODY IS INSIDE THE TRY, AND IT USED TO START AT THE `MemoryStore.open` CALL.
    //
    // `hasSecureStorage` and `deriveSubkey` are PROVIDER calls — a third party's code — and either can throw:
    // a provider fault, a rejected subkey label, a handle the provider refuses. They sat above the try, so a
    // throw propagated out of `openFor`, out of the `async (handle) => openFor(handle, host)` arrow in
    // `index.js`, and into the fork's `notifyUserStorageReady`, which catches it and logs "A deferred
    // storage-ready task failed for a user" — naming NO PLUGIN (`src/storage.js`).
    //
    // So memory was disabled for that user for their entire session, and nothing anywhere said Mnemosyne was
    // involved. That is precisely the silent death `index.js`'s header claims this module makes loud, arriving
    // through the two lines that were outside the handler written to prevent it.
    try {
        openStore(handle, host);
    } catch (error) {
        normal().error(
            '[Mnemosyne] The storage provider failed while opening memory for a user, so memory is DISABLED ' +
            'for that session. This is a fault in the provider, not in the vault being locked. Details ' +
            'suppressed.',
        );
        // ⚠️ `{ message?: string }` RATHER THAN `Error`, IN EVERY CATCH IN THIS FILE. A `catch` binding is
        // `unknown` because JavaScript can throw anything, and half of what lands here is a third party's —
        // the storage provider above, better-sqlite3 below. Declaring `Error` would type `.message` as a
        // string that is always present; declaring it optional says the true thing, which is that a thrown
        // value may carry no message at all. This one line already knew that: it is the only catch here that
        // falls back to the error itself, and the fallback is what the annotation now agrees with.
        sensitive().error('[Mnemosyne] That provider failure was for %s: %s', handle,
            /** @type {{ message?: string }|null|undefined} */ (error)?.message ?? error);
    }
}

/**
 * The body of {@link openFor}, so that every provider call it makes is inside one handler.
 *
 * @param {string} handle The user whose vault just opened
 * @param {import('./host/context.js').HostContext} host The fork, as we are allowed to see it
 * @returns {void}
 */
function openStore(handle, host) {
    // 🔴 hasSecureStorage, NOT ownsUser. They look interchangeable and are opposites: ownsUser answers a
    // question about password resets and deliberately says YES when it does not know, because a wrong "no"
    // there destroys data. Here that default is catastrophic — a provider with no deriveSubkey would report
    // ownsUser: true, we would read that as "vault present, merely locked", and we would wait for ever for a
    // key that is never coming. The fork's own mutation test found that swapping these fails exactly one
    // assertion out of nine: it would have shipped looking perfect.
    if (!host.hasSecureStorage(handle)) {
        if (!refused.has(handle)) {
            refused.add(handle);
            // 🔴 The single most important line this plugin can emit, and until §23 nobody could see it: it is
            // the difference between "memory is broken" and "memory was never going to work here". It is
            // entirely literal apart from the handle, so the whole instruction survives as NORMAL.
            normal().error(
                '[Mnemosyne] REFUSING TO START for a user: no storage provider is installed that can ' +
                'derive a key. Mnemosyne stores encrypted long-term memory and has no key of its own — it ' +
                'requires SillyTavern-Vault. Install Vault, or remove Mnemosyne. Memory is DISABLED for ' +
                'that user; nothing will be stored and nothing will be recalled.',
            );
            sensitive().error('[Mnemosyne] The user refused above is %s.', handle);
        }
        return;
    }

    // 🔴 ASK LATE. This is the only moment the key can exist — the user has just unlocked. Asking at init
    // would return null (nobody has logged in yet) and caching that null would disable memory for the life
    // of the process while looking exactly like working code.
    const key = host.deriveSubkey(handle, SUBKEY_LABEL, KEY_BYTES);

    if (!key) {
        // hasSecureStorage said yes and the vault is meant to be open, so this is not the ordinary "locked"
        // case — something is wrong rather than merely not ready. Do not retry silently.
        normal().error(
            '[Mnemosyne] No key for a user despite storage reporting itself available. Memory is disabled ' +
            'for that session.',
        );
        sensitive().error('[Mnemosyne] The user with no key is %s.', handle);
        return;
    }

    try {
        const file = databasePath(host, handle);

        // 🔴 The memory/ directory is OURS to create. The fork guarantees the user's root exists; nothing
        // guarantees our subdirectory, and better-sqlite3 does not create parent directories. Without this
        // line, a brand-new user's first unlock dies with SQLITE_CANTOPEN in the catch below — and memory is
        // silently disabled for exactly the users who never saw it work. (The tests deliberately do NOT
        // pre-create the directory, so removing this line fails them.)
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const store = new MemoryStore(file).open(key);
        stores.set(handle, store);

        // One-time repairs of what earlier builds stored wrongly. A failure here must not cost the user their
        // memory, so it is logged and the store stays open.
        try {
            repairLeakedTags(store);
        } catch (error) {
            normal().error('[Mnemosyne] repair: could not fix leftover tags in a store. Details suppressed.');
            sensitive().error('[Mnemosyne] That repair failure was for %s: %s', handle, /** @type {{ message?: string }} */ (error).message);
        }
        // 🔴 The count, not the handle. "A store is open" is the fact an operator needs, and saying how many
        // are open says it without naming anyone — the one genuinely NORMAL thing about this event.
        normal().info('[Mnemosyne] Memory unlocked for a user — %d store(s) now open.', stores.size);
        sensitive().debug('[Mnemosyne] That unlock was for %s.', handle);
    } catch (error) {
        // The path in `file` is under a user directory and the Error's message may quote it, so neither can
        // appear in the NORMAL half.
        normal().error('[Mnemosyne] Could not open a memory store — memory is disabled for that user. Details suppressed.');
        sensitive().error('[Mnemosyne] That failure was for %s: %s', handle, /** @type {{ message?: string }} */ (error).message);
    } finally {
        // The store holds no reference to this — MemoryStore.open() takes the key as a parameter and keeps
        // it in no field, which is the whole reason "drop the key on lock" is close() and nothing more.
        //
        // ⚠️ This zeroes the BUFFER, and the buffer is not the only copy. `PRAGMA key` needs a string, so
        // open() unavoidably materializes the key as hex in the V8 heap, where it cannot be overwritten and
        // survives close(). Stated in full in MemoryStore.open()'s docblock — an accepted gap, recorded
        // rather than mitigated, because every available mitigation is theater.
        key.fill(0);
    }
}

/**
 * Shut a user's store when their vault shuts.
 *
 * 🔒 This is NFR1, and it is kept here or it is not kept at all. The derived key's entire promise is that it
 * dies with the vault; a promise nothing enforces is a wish. By the time this runs the vault is already
 * closed — `deriveSubkey` returns null and `isStorageReady` is false — so there is nothing to read or write,
 * only to let go of.
 *
 * @param {string} handle The user whose vault shut
 * @returns {void}
 */
export function closeFor(handle) {
    const store = stores.get(handle);

    // 🔴 THE CLEAR-ON-LOCK HAPPENS EVEN WHEN THERE WAS NO STORE, AND IT DID NOT USED TO.
    //
    // The `if (!store) return` guard sat above these three lines, which reads as "nothing was open, so there
    // is nothing to clean up". That is false in exactly the case that matters. A user whose `openFor` FAILED
    // — a plaintext install with no vault, a read-only user directory, the schema-version refusal — still
    // generates: every turn calls `retrieve()`, gets no store, and reaches `noteInjection(..., { reason:
    // 'locked' })`, which writes a record carrying their `chatId` into `lastRecall`. On logout this returned
    // before `dropForHandle`, so that record survived for the life of the PROCESS. And `refused` could never
    // be cleared for the very handles that are in it, because being in `refused` means having no store —
    // so it grew monotonically and a user whose vault was fixed stayed refused until a restart.
    //
    // NFR1 is "every per-user record dies with the vault", not "…dies with the vault if one opened".
    stores.delete(handle);
    refused.delete(handle);
    // 🔒 EVERY per-user record dies with the vault (NFR1) — the recalled-memory view and the just-remembered
    // view alike, because both hold statements exactly as sensitive as the store they came from. This used to
    // be one `delete` per record, listed here by hand, which kept the promise only for as long as everyone
    // adding a cache remembered to come back and add a line. `session-state.js` clears every map that declared
    // itself per-user, so a new record joins this path by existing rather than by being remembered.
    dropForHandle(handle);

    if (!store) {
        return;                                               // nothing was ever opened; the records are gone
    }

    try {
        store.close();
        normal().info('[Mnemosyne] Memory locked for a user — %d store(s) still open.', stores.size);
        sensitive().debug('[Mnemosyne] That lock was for %s.', handle);
    } catch (error) {
        // Say it, but never rethrow: this runs on the logout path, and taking a logout down because a
        // database handle misbehaved would be a worse bug than the one being reported.
        normal().error('[Mnemosyne] Error closing a memory store on logout. Details suppressed.');
        sensitive().error('[Mnemosyne] That failure was for %s: %s', handle, /** @type {{ message?: string }} */ (error).message);
    }
}

/**
 * Tell the storage provider that `memory/` is ours and already encrypted. See {@link FOREIGN_STORE} for
 * what the claim says and why every field of it matters.
 *
 * 🔴 AT BOOT, NOT AT FIRST WRITE — and this is the opposite of the rule next door. `deriveSubkey` must be
 * asked late because at init nobody has unlocked and the answer would be a cached `null`. This needs no key
 * and no user, so there is nothing to wait for; and the provider's shallow audit is designed to run **from
 * cron, in a separate process that loads no plugins at all**, reading a registry persisted to disk. A
 * declaration made only when Mnemosyne happens to write is a declaration that process may never have seen —
 * so it would go on reporting our store as a leak, which is the entire failure this call exists to end.
 *
 * ⚠️ A FAILURE HERE MUST NOT TAKE MEMORY DOWN WITH IT. The cost of no declaration is a noisy audit; the
 * cost of throwing out of `init` is that the plugin never loads and nobody has any memory at all. That is
 * not a trade worth making, and it is the provider's own precedent — Vault swallows its registry-write
 * failure for exactly this reason rather than refusing to boot a user's storage over it. So this reports
 * loudly and returns.
 *
 * @param {import('./host/context.js').HostContext} host The fork, as we are allowed to see it
 * @returns {void}
 */
export function declareForeignStore(host) {
    if (!host.has('registerForeignStore')) {
        // `host.announce()` has already reported the missing capability and its effect. The message lives in
        // src/host/capabilities.js.
        return;
    }

    try {
        if (host.registerForeignStore(FOREIGN_STORE)) {
            normal().info(
                '[Mnemosyne] Declared memory/ as an encrypted foreign store; a storage audit will report ' +
                'it as owned rather than as a leak.',
            );
            return;
        }

        // Not an error, and deliberately not logged as one: `false` means no storage provider is installed,
        // which is the plaintext deployment, where there is no audit to confuse. It is still said out loud,
        // because `false` means the declaration reached NOBODY — and on an install that was supposed to have
        // a provider, this line is the first evidence of it. The louder REFUSING TO START follows at the
        // first unlock (see openFor); this one arrives at boot, before any user has tried.
        normal().warn(
            '[Mnemosyne] No storage provider took the foreign-store declaration for memory/. On a plaintext ' +
            'install that is expected — there is no audit to tell. On an encrypted one it means the ' +
            'declaration reached nobody, and the memory database will be reported as a leak.',
        );
    } catch (error) {
        // The declaration is a frozen constant, so the provider rejecting it means the contract moved under
        // us — worth an error, not worth taking memory offline for. Message only: this one is ours, but the
        // rest of the error is the provider's and is not classified for us.
        normal().error(
            '[Mnemosyne] The storage provider REFUSED Mnemosyne\'s foreign-store declaration for memory/. ' +
            'Memory still works; storage audits will report its database as PLAINTEXT until this is fixed. ' +
            'Enable logging.debugMode for the reason.',
        );
        sensitive().error('[Mnemosyne] The foreign-store declaration was refused because: %s', /** @type {{ message?: string }} */ (error).message);
    }
}

/**
 * Forget a chat's scenario memories when the chat itself is deleted.
 *
 * This is the second half of the tier contract (`schema.js`): `scenario` memories are keyed on `chatId` and
 * are documented to **die with the chat**. `MemoryStore.forgetChat` was built ahead of the signal because the
 * lifetime is part of the schema's promise; the fork shipped the signal as §24 (`onChatDeleted`), and this
 * function is the join. Without it the rows are not merely unreachable — they persist in `memories` and in
 * every vec0 vector table for the life of the install, with no garbage collector behind them and none planned.
 *
 * The fork fires this for **all four** deletion paths — a single chat, one conversation deleted from a group,
 * a whole group, and a character deleted *with* its chats. Overlapping paths are deliberate and are not
 * deduplicated on either side: forgetting an already-forgotten chat deletes nothing and costs nothing, whereas
 * a path that stays silent leaves orphans that nothing will ever report.
 *
 * ⚠️ **The vault is necessarily OPEN whenever this runs, so "locked" is not a case to handle here.** The fork
 * announces only after the file is actually unlinked, and on a vault install `unlink` throws while shut — so a
 * locked vault fails the delete and never announces. Verified in Vault's `provider.unlink` / `requireKeys`
 * rather than assumed, because the obvious-looking defensive version of this function (queue the id, replay it
 * on next unlock) would be a plaintext list of chat ids on disk, defending a state that cannot occur.
 *
 * 🔴 **A missing store therefore means memory is off for this user, not merely asleep** — no Vault installed,
 * or `openFor` already failed loudly. Dropping the signal is the honest response: on a plaintext install
 * nothing was ever written, so there is nothing to forget, and in the failure cases the operator has already
 * been told at `error` level that memory is disabled. There is no later event to replay on — `onStorageReady`
 * has already fired and failed — so a queue would defer the work to a session that may never come.
 *
 * @param {string} handle The user whose chat was deleted
 * @param {string} chatId The chat id, spelled exactly as `OutgoingPrompt.chatId` spells it
 * @returns {void}
 */
export function forgetChatFor(handle, chatId) {
    const store = stores.get(handle);

    if (!store) {
        // Deliberately `debug`, not `warn`: on a plaintext install this fires on every chat deletion for ever
        // and reports a no-op, so at any louder level it is pure noise that trains an operator to ignore the
        // channel. The genuinely alarming cases (no provider, no key, store would not open) are already
        // reported as errors by openFor, once, at the moment they happen.
        normal().debug('[Mnemosyne] A chat was deleted for a user with no open store; nothing to forget.');
        sensitive().debug('[Mnemosyne] That deletion was for %s, chat %s.', handle, chatId);
        return;
    }

    try {
        const forgotten = store.forgetChat(chatId);
        // The count is safe to promote: a number of rows says nothing about what was in them. The chat id is
        // not — it derives from a name the user typed — so it rides the SENSITIVE half with the handle.
        normal().info('[Mnemosyne] A deleted chat took %d scenario memor%s with it.', forgotten, forgotten === 1 ? 'y' : 'ies');
        sensitive().debug('[Mnemosyne] That was chat %s for %s.', chatId, handle);
    } catch (error) {
        // Never rethrow. The fork logs a throwing handler against nobody in particular and carries on, so a
        // throw here would not take the deletion down — but it would be reported without the one detail that
        // makes it actionable, and this is the last moment the chat id exists anywhere at all.
        normal().error('[Mnemosyne] Could not forget a deleted chat; its scenario memories remain. Details suppressed.');
        sensitive().error('[Mnemosyne] That failure was for %s, chat %s: %s', handle, chatId, /** @type {{ message?: string }} */ (error).message);
    }
}

/**
 * Follow a chat's memories when the chat is renamed.
 *
 * The other way a `chatId` stops being the one memories were written under — and the quiet one. A rename
 * changes the id **while the chat is still alive**, so `onChatDeleted` never fires and nothing here would
 * otherwise run: the scenario memories stay on disk, perfectly intact, in a partition no future generation
 * will ever query. The user keeps talking to a character that has silently forgotten the entire conversation,
 * and no error is raised anywhere in the system. The fork shipped the signal as §24.4 (`onChatRenamed`); this
 * function is the join, and `MemoryStore.rekeyChat` is the work.
 *
 * 🔴 **This re-keys and never deletes.** The tempting one-liner — `forgetChat(oldChatId)` — would destroy live
 * memories deliberately, on a conversation still in progress, in the name of tidying up after a rename the
 * user made for cosmetic reasons.
 *
 * One signal covers solo AND group chats: `/api/chats/rename` branches on `is_group` internally (§24.4), so
 * there is no second subscription to forget. `oldChatId === newChatId` never arrives — the fork refuses it,
 * exactly so a partition can never be asked to re-key onto itself.
 *
 * ⚠️ **The vault is necessarily OPEN here, for the same reason it is in `forgetChatFor`** — §24.6: the signal
 * fires only after `storage.unlink` succeeds, and on a vault install that throws while shut, so a locked vault
 * fails the rename and never announces. No replay queue, and here the argument is sharper than for deletion: a
 * queue would be a plaintext list of chat *names* on disk, on an install whose whole premise is encryption at
 * rest.
 *
 * Unlike deletion, the fork **awaits** this before answering the request, and that matters: the client takes
 * its new chat id from the response, so the re-key is guaranteed to finish before the next generation writes
 * under the new id. There is no race to defend against.
 *
 * @param {string} handle The user whose chat was renamed
 * @param {string} oldChatId The chat id before the rename, spelled as `OutgoingPrompt.chatId` spells it
 * @param {string} newChatId The chat id after it, spelled the same way
 * @returns {void}
 */
export function rekeyChatFor(handle, oldChatId, newChatId) {
    const store = stores.get(handle);

    if (!store) {
        // `debug` for the reason forgetChatFor gives: on a plaintext install this fires on every rename for
        // ever and reports a no-op. The alarming cases were already reported once, by openFor.
        normal().debug('[Mnemosyne] A chat was renamed for a user with no open store; nothing to re-key.');
        sensitive().debug('[Mnemosyne] That rename was for %s, chat %s → %s.', handle, oldChatId, newChatId);
        return;
    }

    try {
        const moved = store.rekeyChat(oldChatId, newChatId);
        // The count promotes for the same reason the deletion count does — a number of rows says nothing about
        // what was in them. Both ids derive from names the user typed, so they ride the SENSITIVE half.
        normal().info('[Mnemosyne] A renamed chat took %d scenario memor%s with it.', moved, moved === 1 ? 'y' : 'ies');
        sensitive().debug('[Mnemosyne] That was chat %s → %s for %s.', oldChatId, newChatId, handle);
    } catch (error) {
        // Never rethrow: a throwing handler does not take the rename down (§24.4) and the file has already
        // moved by the time we are called. But the memories are now stranded under an id nothing will query,
        // which is exactly the state this function exists to prevent — so it is reported at error level with
        // the ids on the suppressed half, because they are the only way to find the rows again.
        normal().error('[Mnemosyne] Could not re-key a renamed chat; its scenario memories are stranded under the old id. Details suppressed.');
        sensitive().error('[Mnemosyne] That failure was for %s, chat %s → %s: %s', handle, oldChatId, newChatId, /** @type {{ message?: string }} */ (error).message);
    }
}

/**
 * Test seam: shut every open store and forget every handle. Not part of the plugin contract.
 *
 * 🔴 Lives HERE, beside the maps it clears, rather than in `index.js`'s `_reset` reaching across for them.
 * That is the same argument `session-state.js` makes about the lock path: state is reset by the module that
 * owns it, so a future addition to this module cannot be left out of the reset by an author who never looked
 * at the other file.
 *
 * @returns {void}
 */
export function _resetSessions() {
    for (const store of stores.values()) {
        store.close();
    }
    stores.clear();
    refused.clear();
}
