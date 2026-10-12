import express from 'express';

import * as storage from '../storage.js';

/**
 * 🔴 THE ONE QUESTION AN ANONYMOUS CALLER MAY ASK ABOUT STORAGE: "does this server encrypt user data?"
 *
 * The login page needs to say "Encryption enabled" before anybody has logged in, so the answer has to be
 * available without a session. That makes this an unauthenticated endpoint on a fork whose entire premise is
 * that user data is not readable, so what it may and may not say is worth stating precisely.
 *
 * ⚠️ INSTANCE-LEVEL, NEVER PER-USER, AND THAT IS THE WHOLE DESIGN. `POST /api/users/list` already hands an
 * unauthenticated caller every handle on the box — that is upstream behaviour and it draws the account
 * picker. If this flag were per-user, that list would become a TARGETING LIST: "these accounts have vaults
 * worth attacking, those do not." The question answered here is about the SERVER, and a server either has a
 * provider installed or it does not.
 *
 * ⚠️ IT DOES NOT NAME THE PROVIDER. Not its id, not its version. An anonymous caller learning that this box
 * runs a particular provider at a particular version is free fingerprinting for a vulnerability that has not
 * been found yet, and it buys the user interface nothing — "encrypted" is the entire message.
 *
 * 🔴 AND IT MUST NOT VARY WITH PROVIDER STATE. `getStorageProvider()` answers whether a provider REGISTERED
 * at boot. It does not consult `isReady()`, and it must never be made to: a response that differed between a
 * locked and an unlocked vault would let anyone on the network poll this endpoint and learn exactly when a
 * user is logged in. That is the oracle `tests/storage-provider-login-oracle.test.js` exists to prevent, and
 * closing it on `/api/users/list` while opening it here would be an own goal.
 *
 * Deliberately NOT bolted onto `/api/users/list`, which returns **204 with no body** when `enableDiscreetLogin`
 * is on. Riding on it would silently take the badge down on exactly the installs most likely to want it.
 */
export const router = express.Router();

/**
 * The provider's badge and marker words, taken once and then never re-asked. See the note inside `/status`:
 * re-asking per request would make §10's "must not vary with lock state" a property of provider behaviour
 * rather than of this endpoint.
 * @type {{badge: string|null, marker: string|null}|null}
 */
let describedOnce = null;

router.get('/status', (_request, response) => {
    const enabled = storage.getStorageProvider() !== null;

    // 🔴 THE WORDS ARE THE PROVIDER'S. THE FORK HAS NONE OF ITS OWN, AND MUST NOT GROW ANY.
    //
    // SillyTavern cannot say "your data is encrypted", because it does not know that: a provider might be
    // compression, or a remote object store. Only the provider knows what it does with the bytes, so only
    // the provider gets to describe it — the same rule, and the same `describe()` machinery, already used
    // for the recovery screens and the idle warning.
    //
    // A provider that says nothing shows NOTHING. There is deliberately no fork-side default to fall back
    // on: a default would be SillyTavern making the claim after all, one branch further down.
    //
    // Only `body` crosses the wire. `describe` may return a title, notes, fields and a button label; a
    // badge has room for none of them, and this is an anonymous endpoint, so the narrowest thing that can
    // work is the only thing that goes.
    //
    // TWO SITUATIONS, ASKED SEPARATELY, because the two places have very different amounts of room: the
    // login page can hold a sentence, the header a word. A provider that answers only one gets exactly one.
    // Both ride on this single anonymous request rather than putting the marker behind auth, so that a
    // provider author has ONE rule to remember — everything you write here is public — instead of a
    // per-situation audience they have to look up and can get wrong in the dangerous direction.
    // 🔴 SNAPSHOT ONCE, SO THE ANONYMOUS ANSWER IS INVARIANT BY CONSTRUCTION. §10's guarantee is that this
    // endpoint must not vary with lock state — otherwise anyone on the network can poll it and learn exactly
    // when a user is logged in, which is the precise attack §10 names. Asking the provider on every request
    // made that guarantee a property of the PROVIDER's good behaviour: a `describe` whose wording changed
    // once a key was in hand would leak the transition, and the fork would have handed it out. The test that
    // proves byte-identical locked and unlocked responses proves it for the fixture provider only.
    //
    // §10's owner is the fork, so the fork enforces it. Taken on first call rather than at module load,
    // because providers register after this module is evaluated; from then on every caller gets the same
    // two strings for the life of the process — which is also exactly as long as the provider set can last.
    if (describedOnce === null) {
        describedOnce = {
            badge: enabled ? (storage.describe('storage.badge')?.body ?? null) : null,
            marker: enabled ? (storage.describe('storage.marker')?.body ?? null) : null,
        };
    }

    return response.json({ enabled, badge: describedOnce.badge, marker: describedOnce.marker });
});
