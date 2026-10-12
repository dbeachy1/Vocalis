/**
 * EVERY SENTENCE THAT IS ONLY TRUE BECAUSE THE DATA IS ENCRYPTED.
 *
 * 🔴 THIS FILE EXISTS TO KEEP THE FORK IGNORANT, AND THAT IS THE WHOLE POINT.
 *
 * SillyTavern must not know what a storage provider is. It cannot: the fork is public, generic, and meant
 * to be mergeable upstream, where a provider might be compression, or a remote object store, or nothing at
 * all. A fork that hard-codes "your data is encrypted" has decided what every provider must be, and has
 * quietly become OUR fork rather than a fork of SillyTavern.
 *
 * But the user still has to be told the truth, and the truth here is severe: forget your password and
 * without the recovery key your chats are gone for ever. Nobody can soften that, and nobody but us can say
 * it, because nobody but us knows it.
 *
 * So SillyTavern draws the screens — it is the only party with a screen — and asks us what to put on them.
 * `describe(situation)` is that question. Every string below is an answer to it. With this plugin removed,
 * SillyTavern asks nobody, gets nothing, and renders its own stock text byte for byte.
 *
 * ⚠️ A REFUSAL IS NOT DESCRIBED HERE. When we throw from `unlock`, `rekey` or `recover`, the fork shows the
 * Error's own `message` verbatim — so the sentence the user reads lives at the throw site, next to the
 * condition that caused it, where it cannot drift out of sync with the reason. Do not add refusal copy to
 * this file; it would be a second, staler answer to a question already answered.
 *
 * 🔴 AND SAY IT CORRECTLY. Changing a password RE-WRAPS the key. It re-encrypts nothing and loses nothing.
 * What cannot be done is setting a password from NOTHING — a blind reset — because the new password would
 * wrap nothing and orphan the key. Copy that says "changing your password will destroy your data" is a lie,
 * and it is a lie that will stop people changing a password they need to change.
 */

import { normal, sensitive } from './logging.js';
import { identity } from './identity.js';


/**
 * The field names are SillyTavern's, not ours — they are the credential slots it actually has and can
 * actually send back. We choose which to show and what to call them.
 */

/** @type {Record<string, (context: any) => object>} */
const SITUATIONS = {
    /**
     * The change-password dialog.
     *
     * The current password is REQUIRED even when the vault is already open, and the sentence below is the
     * only warning the user gets that this is not the trivial act it looks like. An unlocked vault proves
     * the vault is open. It does not prove who opened it — see `rekey()` in lifecycle.js, which is where
     * that rule is actually enforced.
     */
    'password.change': ({ self }) => (self ? {
        title: 'Change your password',
        body: 'Your password unwraps the key to your encrypted data, so you must enter your current one to change it. Nothing is re-encrypted and nothing is lost — the same key is simply re-wrapped under the new password.',
        fields: [
            { name: 'current', label: 'Current password', placeholder: '', required: true },
            { name: 'password', label: 'New password', placeholder: '', required: true },
            { name: 'confirm', label: 'Confirm new password', placeholder: '', required: true },
        ],
        submitLabel: 'Change password',
    } : {
        title: 'Change another user\'s password',
        body: 'This account\'s data is encrypted under its own password, which you do not have. Only the account holder can change it — from their own settings, or with their recovery key if they have forgotten it.',
        fields: [
            { name: 'password', label: 'New password', placeholder: '', required: true },
            { name: 'confirm', label: 'Confirm new password', placeholder: '', required: true },
        ],
        submitLabel: 'Change password',
    }),

    /**
     * A BLIND password reset was refused — and the recovery key is the way in.
     *
     * 🔴 LEAD WITH THE DOOR THAT IS OPEN, NOT THE ONE THAT IS SHUT.
     *
     * This copy used to open with *"its password cannot be reset"*, which is FALSE and was worse than
     * merely false: it is the first thing a locked-out user reads, and it tells someone who is holding
     * their recovery key that there is no point in trying.
     *
     * The password can always be reset. What cannot be done is resetting it from NOTHING — SillyTavern's
     * console-code reset, which proves only that the caller can read the server's terminal. It never
     * reaches the user's key, so the new password would wrap nothing and orphan the data.
     *
     * The recovery key DOES reach the key. It unwraps the same DEK by the other wrap, re-seals it under the
     * new password, and loses nothing. It is a reset. It is simply the only one that works.
     *
     * Say what to do, then say what it costs if they cannot.
     */
    'password.recover': () => ({
        title: 'Enter your recovery key to reset your password',
        body: 'Your data is encrypted with your password, so a password reset has to reach the key — and only your recovery key can. Enter the one you were given when you created your account, along with the new password you want. Nothing is lost and nothing is re-encrypted.',
        notes: ['If you have neither your password nor your recovery key, this account cannot be recovered — by anyone, including the server administrator.'],
        fields: [
            { name: 'current', label: 'Recovery key', placeholder: 'Recovery key', required: true },
        ],
    }),

    /**
     * The user wants a NEW recovery key — they lost the old one, or they think it leaked.
     *
     * 🔴 THE CURRENT PASSWORD IS THE WHOLE FEATURE. Minting a recovery key needs only the DEK, and the DEK
     * is already in RAM while they are signed in — so a button that "just works when logged in" would hand
     * a permanent key to anyone who reached a live session. See `regenerateRecoveryKey` in lifecycle.js.
     *
     * Say plainly that the old key dies. A user who keeps the old slip of paper and believes it still works
     * has a recovery key that opens nothing, and will not discover it until the day it matters.
     */
    'recovery.regenerate': () => ({
        title: 'Generate a new recovery key',
        body: 'Enter your current password and we will issue a new recovery key. Your data is not touched and nothing is re-encrypted — the key to it is simply re-sealed under a new recovery key as well as your password.',
        notes: ['Your OLD recovery key stops working immediately. Destroy it, and write the new one down in its place.'],
        fields: [
            { name: 'current', label: 'Current password', placeholder: '', required: true },
        ],
        submitLabel: 'Generate new key',
    }),

    /**
     * The recovery key, being put in front of the user for the only time it will ever exist.
     *
     * 🔴 If this is never read, the account is silently unrecoverable and NOTHING anywhere says so. It is
     * re-offered at every login until the user ticks the box themselves, because "SillyTavern rendered it"
     * is not evidence that a human wrote it down.
     */
    'recovery.secret': () => ({
        title: 'Save your recovery key',
        body: 'Your data is encrypted with your password. If you ever forget it, this recovery key is the only way back in — nobody, not even the server administrator, can recover your account without one of the two.',
        notes: ['This replaces any recovery key you were shown before; an older one will no longer work. Write this one down and keep it somewhere safe and offline. Anyone who has it can decrypt this account.'],
        submitLabel: 'Done',
    }),

    /**
     * The idle lock is about to fire.
     *
     * "Nothing is lost" is the important half. The data is safe on the disk; what is lost is anything typed
     * and not yet sent, and the user deserves the chance to send it.
     */
    'idle.warning': () => ({
        title: 'Locking your data',
        body: 'You have been inactive, so your encrypted data is about to be locked and you will need to sign in again. Nothing is lost — but anything you have typed and not sent will be.',
        submitLabel: 'Stay signed in',
    }),

    /**
     * 🔴 THE TWO BELOW ARE SERVED TO AN ANONYMOUS STRANGER. EVERY OTHER SITUATION IN THIS FILE IS NOT.
     *
     * `GET /api/storage/status` answers WITHOUT a session, because the login page has to draw its badge
     * before anybody has signed in. Everything else here is reached only by someone who has at least got as
     * far as a password prompt. Three rules follow from that, and all three are load-bearing:
     *
     * 1. **They are public statements about the SERVER, not about a user.** No handle, no version, no more
     *    of this plugin's identity than is worth telling somebody who just port-scanned the box. The fork
     *    deliberately does not send our `id`, and we must not smuggle it back in through the wording.
     * 2. **They take NO context, and nothing per-user may be reported.** `POST /api/users/list` already
     *    hands an anonymous caller every handle on the box; a per-user storage flag would turn that list
     *    into a targeting list — "these three accounts are the encrypted ones".
     * 3. 🔴 **They MUST NOT vary with vault state.** Never consult `isReady()`, a session, or anything that
     *    moves. An answer that differed between a locked and an unlocked vault is a login oracle: anyone on
     *    the network could poll the endpoint and learn exactly when a user signs in. Static configuration
     *    only — which, since these are two literals, is what a literal buys us for free. Keep it that way.
     *
     * Only `body` is read; the fork drops title, notes, fields and submitLabel before rendering. Returning
     * null shows nothing in that place, which is supported and is the honest answer if the claim ever stops
     * being true.
     */

    /**
     * The LOGIN PAGE, under the account picker, in green with a padlock. Room for a short sentence, and it
     * is rendered with `.text()` — our words are data and cannot inject markup.
     */
    'storage.badge': () => ({
        body: 'Encryption enabled',
    }),

    /**
     * The MAIN UI HEADER, top-right of the viewport, small and dimmed, on screen the whole session.
     *
     * Room for a word or two — longer is cut off, and below 1000px the fork drops the text entirely and
     * shows just the padlock. It is a SEPARATE situation from the badge for exactly this reason: the login
     * page's sentence reused up here would be truncated into nonsense, and the fork has a test that fails if
     * it ever asks once and reuses the answer.
     */
    'storage.marker': () => ({
        body: 'Encrypted',
    }),

    /**
     * 🔀 THE PER-CHAT PADLOCK'S TOOLTIP — `DESIGN_MIXED_MODE.md` §6.2.
     *
     * Unlike the two above, this one is AUTHENTICATED and per-chat: the fork asks `encryptsPath()` about a
     * specific file and, when the answer is yes, asks us for the words. No answer here means no padlock at
     * all, by design — §6.2 is emphatic that the fork must not own a single sentence about what a provider
     * does, because a provider might be compression or a remote object store.
     *
     * 🔴 **"AT REST" IS LOAD-BEARING AND IT IS NOT HEDGING.** The tempting sentence is "nobody can read
     * this chat", and it is FALSE while the vault is open — the server reads it perfectly well, which is
     * how the user is reading it. A padlock that overpromises teaches someone to treat an unlocked session
     * on a shared machine as safe. What is true, and what the padlock actually earns, is that the bytes on
     * the disk are ciphertext: back the file up, lose the drive, or hand the machine to somebody without
     * the password, and there is nothing in it to read.
     *
     * ⚠️ It also has to stay true of a chat in a MIXED account, where the row next to it has no padlock and
     * is plaintext. So it says "this chat", never "your data".
     */
    'storage.chatMarker': () => ({
        body: 'This chat is encrypted at rest.',
    }),

    /**
     * 🔀 WHO WE ARE, so a user who uninstalls reads a name instead of a slug — `DESIGN_STORAGE_PROVENANCE.md` §6.
     *
     * Every file we write carries `stenv:1:vault:` in the clear, which is what lets the fork say *"This chat
     * requires the 'vault' storage provider"* with no plugin loaded and no key. That sentence is honest but
     * it is barely actionable: `vault` is a slug, and a user staring at it does not know what to search for.
     * This is the mapping from the slug to something they can go and find.
     *
     * ⚠️ The record itself, and the rules its fields obey, live in `identity.js` — it is a
     * machine-readable manifest rather than a sentence, and this file is for sentences. It arrives through
     * `describe()` because that is the interface the fork has, not because it is copy.
     */
    'storage.identity': () => identity(),
};

/**
 * Tell SillyTavern what to say about a situation it is about to draw.
 *
 * 🔴 NEVER THROW, AND NEVER RETURN GARBAGE. This is called while a dialog is being built, sometimes one the
 * user cannot dismiss (the recovery-key wall). A throw here would take out the screen that exists to stop
 * an account becoming permanently unrecoverable — trading a wording problem for a data-loss one.
 *
 * An unknown situation is not an error: the fork may be newer than this plugin and asking about something
 * we have never heard of. Say nothing, and it renders its own default.
 * @param {string} situation Which situation SillyTavern is drawing
 * @param {object} [context] Facts about it, as the fork's storage.js documents
 * @returns {object|null} What to say, or null to let SillyTavern say its own thing
 */
export function describe(situation, context = {}) {
    // `Object.hasOwn`, not a bare lookup: a plain object literal inherits from `Object.prototype`, so
    // `SITUATIONS['toString']` finds a function, calls it, and returns the string '[object Object]' —
    // which is not nullish, so it sails past the `??` and this function returns garbage instead of the
    // null its own contract promises. It also makes `situation` below provably one of OUR OWN literals,
    // which is what lets the NORMAL line name it.
    if (!Object.hasOwn(SITUATIONS, situation)) {
        return null;
    }

    try {
        return SITUATIONS[situation](context) ?? null;
    } catch (error) {
        // Split. The situation key is one of the literals defined at the top of this file — no user ever
        // typed it — so it can be named in the clear. The Error cannot: these templates interpolate
        // `context`, which carries the handle, and an Error's message would carry it straight back out.
        normal().error(`[vault] Could not describe '${situation}'. Enable logging.debugMode for the cause.`);
        sensitive().error(`[vault] Could not describe '${situation}':`, error);
        return null;
    }
}
