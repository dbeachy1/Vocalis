import crypto from 'node:crypto';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { keyValueOptions } from '../src/key-value.js';
import * as session from '../src/session.js';
import { createVaultState } from '../src/vault-state.js';

const HANDLE = 'default-user';

/** A character card, as SillyTavern actually caches them. */
const CARD = {
    name: 'Test Character 1',
    description: '[Test Character 1\'s Personality= "caring", "protective", "compassionate"]',
    personality: 'caring',
    first_mes: 'I have been waiting for you.',
};

/** @type {{parse: Function, stringify: Function}} */
let store;


/**
 * This suite's own provider state.
 *
 * 🔴 A FRESH ONE PER TEST **IS** THE RESET. Before `vault-state.js` the modules held six
 * globals between them, so a test had to remember which `reset*()` calls applied to it -- and
 * `tests/verify.test.js` records a test that passed with its guard DELETED because the shared
 * `dataRoot` was already set by a previous `beforeEach`. Nothing here can do that now: a provider
 * built around this object cannot see any other test's state, because there is no other state to see.
 */
let vault;
beforeEach(() => {
    vault = createVaultState();
    session.closeAll(vault);
    session.open(vault, HANDLE, crypto.randomBytes(32));
    store = /** @type {any} */ (keyValueOptions(vault, HANDLE));
});

afterEach(() => {
    session.closeAll(vault);
});

/**
 * 🔴 The storage seam must cover node-persist's direct filesystem writes.
 *
 * node-persist writes the character-card cache through its own `fs` calls, bypassing the storage provider.
 * The cache therefore needs an explicit encrypted storage seam; a test that never populates it cannot
 * establish disk confidentiality.
 */
describe('🔴 the key/value seam: node-persist writes its own bytes', () => {
    test('a value round-trips', () => {
        const restored = store.parse(store.stringify(CARD));
        expect(restored).toEqual(CARD);
    });

    test('🔴 and what lands on the disk contains NONE of it', () => {
        const onDisk = store.stringify(CARD);

        expect(onDisk).not.toContain('Test Character 1');
        expect(onDisk).not.toContain('caring');
        expect(onDisk).not.toContain('waiting for you');
        expect(onDisk).not.toContain('description');
        expect(onDisk.startsWith('esk1:')).toBe(true);
    });

    test('🔴 two different vaults cannot read each other', () => {
        const sealed = store.stringify(CARD);

        // A different DEK entirely -- a different user, or the same user after a rekey that (wrongly)
        // changed the data key.
        session.closeAll(vault);
        session.open(vault, HANDLE, crypto.randomBytes(32));

        expect(() => keyValueOptions(vault, HANDLE).parse(sealed)).toThrow();
    });
});

/**
 * 🔴 THE FILENAME IS A SECRET TOO, AND node-persist WANTED TO HASH IT WITH sha256.
 *
 * Its default is `path.join(dir, sha256(key))`, and the key here is a plaintext path:
 * `…/characters/Test Character 1.png-<mtime>`. sha256 takes no key. So an attacker holding the disk can TEST A
 * GUESS: hash a character name they suspect, with an mtime they can read straight off the card, and see
 * whether that file exists. Nothing is disclosed — but it confirms, and it was the only keyless name left
 * anywhere in the system.
 *
 * The replacement is HMAC-SHA256 under its own subkey: still deterministic (the store has to find again
 * what it wrote), but computable only by someone who already holds the DEK.
 */
describe('🔴 the filename: a keyed hash, not a free confirmation oracle', () => {
    /** The store, as node-persist calls it: `this` is the instance, and `this.options.dir` is the folder. */
    const store_ = (options) => ({ options: { dir: '/data/default-user/_cache/characters' }, ...options });

    /**
     * @param {any} opts The options
     * @param {string} key The cache key
     * @returns {string} The basename node-persist would write
     */
    const nameFor = (opts, key) => path.basename(opts.getDatumPath.call(store_(), key));

    const KEY = '/data/default-user/characters/Test Character 1.png-1752000000000';

    test('🔴 IT IS NOT sha256(key) — the unkeyed hash is the whole bug', () => {
        const unkeyed = crypto.createHash('sha256').update(KEY, 'utf-8').digest('hex');

        expect(nameFor(store, KEY)).not.toBe(unkeyed);
    });

    test('🔴 and it gives the character name away in no other form either', () => {
        const name = nameFor(store, KEY);

        expect(name).not.toContain('Test Character 1');
        expect(name).not.toContain('.png');
        expect(name).toMatch(/^[0-9a-f]{64}$/);
    });

    test('it is DETERMINISTIC — the store has to find again what it wrote', () => {
        expect(nameFor(store, KEY)).toBe(nameFor(store, KEY));

        // And a different entry is a different file, or the cache would collide with itself.
        expect(nameFor(store, KEY)).not.toBe(nameFor(store, `${KEY}-other`));
    });

    test('🔴 a DIFFERENT VAULT names the same key differently — the hash is keyed to the user', () => {
        const mine = nameFor(store, KEY);

        session.closeAll(vault);
        session.open(vault, HANDLE, crypto.randomBytes(32));

        expect(nameFor(keyValueOptions(vault, HANDLE), KEY)).not.toBe(mine);
    });

    test('🔴 a LOCKED vault cannot name a file, and says so rather than guessing', () => {
        // Falling back to the plaintext key, or to sha256, would put the oracle straight back — and quietly,
        // in exactly the circumstance nobody is watching.
        session.closeAll(vault);

        expect(() => nameFor(store, KEY)).toThrow(/shut/i);

        try {
            nameFor(store, KEY);
        } catch (error) {
            // EUNAVAILABLE, so SillyTavern re-throws it instead of treating it as a cache miss and
            // "repairing" the entry by writing the card back out.
            expect(error.code).toBe('EUNAVAILABLE');
        }
    });
});

/**
 * 🔴 `stringify` MUST BE TOTAL. IT MUST NEVER THROW. THIS IS NOT A STYLE POINT.
 *
 * node-persist's own `parse` is:
 *
 *     try { return this.options.parse(str); }
 *     catch (e) { this.log('parse error: ', this.stringify(e), 'for:', str); return undefined; }
 *
 * The argument to `log` is evaluated whether or not logging is enabled, so `stringify` is handed an ERROR
 * OBJECT on every decode failure. And that catch block runs inside an `fs.readFile` CALLBACK — so a throw
 * escaping it is an uncaught exception with no promise to reject into, and THE SERVER DIES.
 *
 * The design document said to set `forgiveParseErrors: false` and let decode failures surface. It was read
 * out of the docs rather than the source, and it is wrong twice over: the flag does not prevent the swallow,
 * and the swallow path is itself a way to kill the process.
 */
describe('🔴 stringify is TOTAL — a throw here kills the server', () => {
    test('🔴 an ERROR object — the exact value node-persist hands it on a decode failure', () => {
        expect(() => store.stringify(new Error('boom'))).not.toThrow();
    });

    test('🔴 a value JSON cannot even represent', () => {
        // JSON.stringify throws a TypeError on a BigInt, and on a circular reference. Both would escape
        // through the fs callback.
        expect(() => store.stringify({ big: 10n })).not.toThrow();

        const circular = { name: 'x' };
        circular.self = circular;
        expect(() => store.stringify(circular)).not.toThrow();
    });

    test('🔴 undefined — JSON.stringify(undefined) is not a string', () => {
        expect(() => store.stringify(undefined)).not.toThrow();
        expect(typeof store.stringify(undefined)).toBe('string');
    });

    test('🔴 and with the vault SHUT', () => {
        session.closeAll(vault);

        expect(() => store.stringify(CARD)).not.toThrow();
        expect(() => store.stringify(new Error('boom'))).not.toThrow();
    });

    test('🔴 a locked stringify writes a SENTINEL, never the plaintext', () => {
        // It cannot encrypt, and it is forbidden from throwing. The one remaining safe answer is to say
        // nothing -- in a form that cannot later be mistaken for data. Falling back to plaintext JSON here
        // would be the original leak, reintroduced by the very function that exists to close it.
        session.closeAll(vault);

        const onDisk = store.stringify(CARD);

        expect(onDisk).not.toContain('Test Character 1');
        expect(onDisk).not.toContain('caring');
        expect(() => store.parse(onDisk)).toThrow();
    });
});

/**
 * 🔴 `parse` MUST REFUSE ANYTHING THAT IS NOT OURS.
 *
 * A decode failure must never look like a cache MISS, because SillyTavern repairs a miss by re-parsing the
 * character card and writing the entry back out — and if the reason we could not read it was that we had no
 * key, that "repair" would cheerfully rebuild a plaintext shadow of every card the user owns.
 *
 * `forgiveParseErrors: false` in the fork is what turns a throw here into a hard read failure instead of a
 * silent miss. This end holds up the other end of that bargain.
 */
describe('🔴 parse refuses what it cannot vouch for', () => {
    test('🔴 PLAINTEXT JSON IS REFUSED — it must never be silently accepted', () => {
        // The tempting "compatibility" fallback: if it does not look encrypted, just JSON.parse it. That
        // single line would keep every pre-existing plaintext entry working, silently, for ever -- and it
        // would accept anything an attacker chose to drop into the cache directory.
        expect(() => store.parse(JSON.stringify({ key: 'k', value: CARD })))
            .toThrow(/not a vault envelope/i);
    });

    test('🔴 a TAMPERED envelope is refused', () => {
        const sealed = store.stringify(CARD);
        const body = Buffer.from(sealed.slice('esk1:'.length), 'base64');

        body[body.length - 1] ^= 0xff;

        expect(() => store.parse(`esk1:${body.toString('base64')}`)).toThrow();
    });

    test('🔴 a locked parse throws — it does NOT report a miss', () => {
        const sealed = store.stringify(CARD);
        session.closeAll(vault);

        expect(() => store.parse(sealed)).toThrow(/shut/i);
    });

    test('garbage is refused', () => {
        expect(() => store.parse('')).toThrow();
        expect(() => store.parse(null)).toThrow();
        expect(() => store.parse('esk1:not-base64-at-all!!')).toThrow();
    });
});

/**
 * node-persist's `copy()` is `parse(stringify(value))`, and it runs on EVERY `setItem` — against the raw
 * value, not the `{key, value, ttl}` envelope it eventually writes. So the pair has to be a pure symmetric
 * transform over arbitrary values, not something that only works on a datum.
 */
describe('the pair is a symmetric transform on ARBITRARY values, because copy() needs it to be', () => {
    test.each([
        ['a card', CARD],
        ['a datum', { key: 'x/y.png-123', value: JSON.stringify(CARD), ttl: null }],
        ['a string', 'just a string'],
        ['a number', 42],
        ['null', null],
        ['an array', [1, 'two', { three: 3 }]],
        ['unicode', { name: '日本語 — Séraphine ✨' }],
    ])('copy() round-trips %s', (_label, value) => {
        expect(store.parse(store.stringify(value))).toEqual(value);
    });
});
