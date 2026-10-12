import { describe, test, expect } from '@jest/globals';

import { KEY_VALUE_STORE, OWN_STORES, ownStoreDirectories, ownStoreFor, ownStoreSkeleton } from '../src/own-stores.js';
import { STRUCTURAL_DIRECTORIES } from '../src/paths.js';
import { VERDICT } from '../src/verify.js';

/**
 * 🔴 ONE DECLARATION, AND THE FOUR FACTS THAT USED TO BE FOUR STRING LITERALS IN FOUR FILES.
 *
 * The character-card cache was described in `key-value.js` (the tag), `verify.js` (the tag AGAIN, kept in
 * step by a comment, plus a bare `_cache/` prefix), and `paths.js` (twice — skeleton, and library-named).
 * None referenced each other, and the string `_cache` did not appear in the module that operates the store.
 *
 * `foreign-stores.js` already made this exact argument about OTHER plugins' stores — *"The thing that must
 * be general is the declaration"* — and it had never been applied to our own.
 *
 * These tests check the declaration against every consumer of it. They are what makes the abstraction
 * worth having: the point is not fewer literals, it is that a store cannot be half-registered.
 */
describe('own stores: the declaration and everything that reads it', () => {
    test('every store declares all four facts', () => {
        expect(OWN_STORES.length).toBeGreaterThan(0);

        for (const store of OWN_STORES) {
            expect(typeof store.directory).toBe('string');
            expect(store.directory.length).toBeGreaterThan(0);
            expect(Array.isArray(store.skeleton)).toBe(true);
            expect(typeof store.envelope).toBe('string');
            expect(typeof store.verdict).toBe('string');
        }
    });

    test('🔴 every store directory is skeleton — or it cannot be created at boot, while locked', () => {
        // SillyTavern and the fork build these before anyone has logged in. A directory whose name needed
        // a key could not be created at all: `mkdir` would raise EUNAVAILABLE during boot.
        for (const store of OWN_STORES) {
            expect(store.skeleton).toContain(store.directory);

            for (const directory of store.skeleton) {
                expect(STRUCTURAL_DIRECTORIES.has(directory)).toBe(true);
            }
        }
    });

    test('🔴 every ancestor of a store directory is skeleton too', () => {
        // `isAllStructural` walks component by component, so a store at `a/b/c` with only `a/b/c` declared
        // fails at `a` — while locked, at boot, which is the one time it must not.
        for (const store of OWN_STORES) {
            const parts = store.directory.split('/');

            for (let i = 1; i <= parts.length; i++) {
                expect(STRUCTURAL_DIRECTORIES.has(parts.slice(0, i).join('/'))).toBe(true);
            }
        }
    });

    test('🔴 every store verdict is a real VERDICT, or verify reports a value nothing handles', () => {
        for (const store of OWN_STORES) {
            expect(Object.values(VERDICT)).toContain(store.verdict);
        }
    });

    test('🔴 no store envelope collides with the provider\'s own, or with another store\'s', () => {
        // `envelope.js` argues at length that `esk1:` must NOT be reused as the provider's outer
        // marker. The converse holds: a store must not adopt `stenv:` either, and two stores sharing a tag
        // would make a file from one decryptable-looking under the other's key.
        const tags = OWN_STORES.map(store => store.envelope);

        expect(new Set(tags).size).toBe(tags.length);

        for (const tag of tags) {
            expect(tag.startsWith('stenv:')).toBe(false);
        }
    });

    test('ownStoreFor matches files INSIDE a store, and not the store directory itself', () => {
        expect(ownStoreFor(`${KEY_VALUE_STORE.directory}/abc123`)).toBe(KEY_VALUE_STORE);
        expect(ownStoreFor(KEY_VALUE_STORE.directory)).toBeUndefined();
        expect(ownStoreFor('chats/Test Character 1/a.jsonl')).toBeUndefined();
    });

    test('🔴 ownStoreFor does not match a sibling under a shared parent', () => {
        // The regression this narrowing fixes. `verify.js` matched on `_cache/`, the PARENT of the real
        // store, so a file in any other directory under `_cache/` was judged by the key/value store's
        // rules — measured against an envelope it was never written with, and reported as a leak.
        const parent = KEY_VALUE_STORE.directory.split('/').slice(0, -1).join('/');

        expect(parent).not.toBe('');
        expect(ownStoreFor(`${parent}/something-else/a-file`)).toBeUndefined();
    });

    test('the helpers agree with the declarations they summarise', () => {
        expect(ownStoreDirectories()).toEqual(OWN_STORES.map(s => s.directory));
        expect(ownStoreSkeleton()).toEqual(OWN_STORES.flatMap(s => s.skeleton));
    });
});
