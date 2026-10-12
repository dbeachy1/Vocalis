import { describe, test, expect } from '@jest/globals';

import { describe as describeSituation } from '../src/strings.js';
import { idleLockMs } from '../src/settings.js';

/**
 * 🔴 THE FORK IS NOT ALLOWED TO KNOW WHAT WE ARE. SO WE HAVE TO TELL THE USER OURSELVES.
 *
 * SillyTavern is public, generic, and meant to stay mergeable upstream — where a storage provider might be
 * compression, or a remote object store, or nothing at all. It hard-coded "your data is encrypted" in six
 * places, and every one of those strings was TRUE, which is exactly what made them so easy to leave in.
 *
 * They live here now. The fork asks `describe(situation)`; we answer; with this plugin removed it asks
 * nobody, gets nothing, and renders its own stock text byte for byte.
 */
describe('🗣️  every sentence the user reads about encryption', () => {
    test('the four situations SillyTavern asks about are all answered', () => {
        for (const situation of ['password.change', 'password.recover', 'recovery.secret', 'idle.warning']) {
            const text = describeSituation(situation, { handle: 'default-user', self: true });

            expect(text).not.toBeNull();
            expect(typeof text.body).toBe('string');
            expect(text.body.length).toBeGreaterThan(20);
        }
    });

    test('🔴 an UNKNOWN situation answers null — the fork may be newer than we are', () => {
        // Not an error. A fork that has grown a new dialog asks about it, we have never heard of it, and it
        // renders its own default. The alternative — throwing — would take out a dialog over a wording gap.
        expect(describeSituation('something.invented.later', {})).toBeNull();
    });

    test('🔴 describe() NEVER throws, whatever it is handed', () => {
        // It is called while a dialog is being BUILT — sometimes one the user cannot dismiss (the
        // recovery-key wall, which is the only thing standing between them and a permanently unrecoverable
        // account). A throw here would trade a wording problem for a data-loss one.
        expect(() => describeSituation('password.change', undefined)).not.toThrow();
        expect(() => describeSituation(null, null)).not.toThrow();
        expect(() => describeSituation('recovery.secret', { handle: null })).not.toThrow();
    });

    /**
     * 🔴 SAY IT CORRECTLY.
     *
     * Changing a password RE-WRAPS the key. It re-encrypts nothing and loses nothing. What cannot be done is
     * setting a password from NOTHING — a blind reset — because the new password would wrap nothing and
     * orphan the key.
     *
     * Copy that says "changing your password will destroy your data" is a lie, and it is a lie that stops
     * people changing a password they need to change. A password change only re-wraps the key.
     */
    test('🔴 the change-password copy must NOT claim that changing a password destroys data', () => {
        const text = describeSituation('password.change', { handle: 'default-user', self: true });
        const all = [text.title, text.body, ...(text.notes ?? [])].join(' ');

        // It must AFFIRM that nothing is lost. Saying "nothing is re-encrypted" is correct and welcome —
        // what is forbidden is the claim that the data WILL become unreadable, lost, or destroyed, which is
        // what a careless writer reaches for and which is simply false.
        expect(all).toMatch(/nothing is lost/i);
        expect(all).toMatch(/re-?wrapped/i);
        expect(all).not.toMatch(/(data|chats?|it)\s+(would|will|could|may)\s+(become|be)\s+(unreadable|lost|destroyed|gone)/i);
        expect(all).not.toMatch(/lose (your|all) (data|chats)/i);
    });

    test('an admin changing SOMEONE ELSE\'s password is a different conversation, and gets no Current box', () => {
        const own = describeSituation('password.change', { handle: 'default-user', self: true });
        const other = describeSituation('password.change', { handle: 'someone-else', self: false });

        // You must prove you know your own password. You cannot possibly prove you know someone else's, so
        // SillyTavern must not draw a box demanding it — and the provider will refuse the re-key anyway.
        expect(own.fields.map(f => f.name)).toContain('current');
        expect(other.fields.map(f => f.name)).not.toContain('current');
    });

    test('the recovery-key screen tells the user what losing it costs', () => {
        const text = describeSituation('recovery.secret', { handle: 'default-user' });

        // If this screen is never read the account is silently unrecoverable and nothing anywhere says so.
        // The copy has to carry that weight; it is the entire reason the screen exists.
        expect(`${text.body} ${text.notes.join(' ')}`).toMatch(/only way back in/i);
    });
});

/**
 * 🔴 THE TWO STRINGS A STRANGER CAN READ WITHOUT SIGNING IN.
 *
 * `GET /api/storage/status` is UNAUTHENTICATED — the login page must draw its badge before anybody has a
 * session. Every other situation in this file is reached only by someone who has at least got as far as a
 * password prompt, so these two are the only ones where the audience is "whoever can reach the port".
 *
 * The fork has no wording of its own and never will: `storage-provider-text.test.js` forbids any mention of
 * encryption anywhere in its source, because a public, generic, upstreamable fork that hard-codes "your data
 * is encrypted" has decided what every storage provider must be. If we say nothing, nothing is shown.
 */
describe('🔓 the unauthenticated storage indicator', () => {
    const CONTEXTS = [
        undefined,
        {},
        null,
        // The shapes an anonymous caller must NOT be able to influence, and the shapes a future careless
        // edit might start reading. If any of these ever changes the answer, the endpoint has become an
        // oracle and this test is the thing that says so.
        { handle: 'default-user' },
        { handle: 'default-user', self: true },
        { unlocked: true },
        { unlocked: false },
    ];

    test('both places are answered, and only `body` is needed', () => {
        for (const situation of ['storage.badge', 'storage.marker']) {
            const text = describeSituation(situation);

            expect(text).not.toBeNull();
            expect(typeof text.body).toBe('string');
            expect(text.body.length).toBeGreaterThan(0);
        }
    });

    test('🔴 the two are DIFFERENT strings — the header has room for a word, not a sentence', () => {
        // They are two situations precisely because the two places have wildly different amounts of room.
        // The fork asks separately and has a test that fails if it ever asks once and reuses the answer;
        // the login page's sentence reused in the header is truncated into nonsense. Below 1000px the fork
        // drops the marker text entirely and shows just a padlock, so the marker has to survive being gone.
        const badge = describeSituation('storage.badge').body;
        const marker = describeSituation('storage.marker').body;

        expect(marker).not.toBe(badge);
        expect(marker.length).toBeLessThan(badge.length);
        expect(marker.length).toBeLessThanOrEqual(16);
    });

    test('🔴 the answer NEVER varies — a response that moved would say when somebody signed in', () => {
        // This is the login oracle the fork's `storage-provider-login-oracle.test.js` exists to close, and
        // the fork asserts the locked and unlocked responses are byte-identical. Our half of that bargain is
        // to answer from static configuration only: no session, no `isReady()`, nothing that moves. Anyone
        // on the network can poll this endpoint as often as they like.
        for (const situation of ['storage.badge', 'storage.marker']) {
            const first = describeSituation(situation, CONTEXTS[0]);

            for (const context of CONTEXTS) {
                expect(describeSituation(situation, context)).toEqual(first);
            }
        }
    });

    test('🔴 nothing per-user, and nothing about us, reaches an anonymous caller', () => {
        // `POST /api/users/list` already hands an anonymous caller every handle on the box. A per-user
        // storage flag would turn that list into a targeting list — "these three accounts are the encrypted
        // ones" — so these strings are statements about the SERVER and carry no identity at all. The fork
        // deliberately does not send our `id`; we must not smuggle it back in through the wording.
        for (const situation of ['storage.badge', 'storage.marker']) {
            const all = JSON.stringify(describeSituation(situation, { handle: 'default-user', self: true }));

            expect(all).not.toMatch(/default-user/);
            expect(all).not.toMatch(/vault/i);
            expect(all).not.toMatch(/\d+\.\d+/);
        }
    });
});

/**
 * 🔒 THE IDLE-LOCK TIMEOUT IS OURS, NOT SILLYTAVERN'S.
 *
 * It used to be `storageIdleLockMinutes` in the FORK's config.yaml — which meant a stock SillyTavern, with
 * no provider installed at all, grew a security control nobody had asked for, and the fork had decided how
 * long was too long for a key it knows nothing about.
 */
describe('🔒 the idle-lock policy', () => {
    const original = process.env.VAULT_IDLE_LOCK_MINUTES;

    afterEach(() => {
        if (original === undefined) {
            delete process.env.VAULT_IDLE_LOCK_MINUTES;
        } else {
            process.env.VAULT_IDLE_LOCK_MINUTES = original;
        }
    });

    test('defaults to thirty minutes', () => {
        delete process.env.VAULT_IDLE_LOCK_MINUTES;
        expect(idleLockMs()).toBe(30 * 60 * 1000);
    });

    test('can be turned off entirely', () => {
        process.env.VAULT_IDLE_LOCK_MINUTES = '0';
        expect(idleLockMs()).toBe(0);
    });

    test('🔴 a GARBLED value falls back to the default — a typo must not silently disable the lock', () => {
        // The dangerous failure is not "it crashes", it is "it comes up with the lock quietly switched off
        // and everything still appearing to work". `Number('thirty')` is NaN, and NaN would have become 0.
        process.env.VAULT_IDLE_LOCK_MINUTES = 'thirty';
        expect(idleLockMs()).toBe(30 * 60 * 1000);

        process.env.VAULT_IDLE_LOCK_MINUTES = '-5';
        expect(idleLockMs()).toBe(30 * 60 * 1000);
    });
});
