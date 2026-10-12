import { describe, test, expect, afterEach } from '@jest/globals';

import {
    encryptsPath,
    owns,
    registerStorageProvider,
    unregisterStorageProvider,
} from '../src/storage.js';

/**
 * 🔒 `encryptsPath` — the question the per-chat padlock is drawn from (`DESIGN_MIXED_MODE.md` §6).
 *
 * The interesting behaviour is entirely in what happens when the provider does NOT give a clear yes, and
 * every one of those cases resolves to **false**.
 *
 * That is deliberately the opposite of `ownsUser`, whose silence means *yes*, and the contrast is the
 * point. `ownsUser` asks "would resetting this password destroy data?" — a wrong no is unrecoverable, a
 * wrong yes is an inconvenience. This asks "may I tell the user this chat is protected?" — and here the
 * damaging answer is the reassuring one. A padlock drawn over a plaintext chat is a false assurance
 * someone may act on, by putting something in that chat they would not otherwise have written.
 *
 * §7.2 builds the whole UI on that: presence is the signal, absence is the default, and a chat that is
 * NOT encrypted is marked with nothing at all — not a grey padlock, not a warning.
 */

/**
 * A minimal provider. `registerStorageProvider` enforces the full interface, so every member has to be
 * present even though only `encryptsPath` is exercised here.
 * @param {object} extra The members under test
 * @returns {import('../src/storage.js').StorageProvider} A registrable provider
 */
function providerWith(extra) {
    const io = {};
    for (const member of [
        'readFile', 'readFileSync', 'createReadStream', 'exists', 'stat', 'readdir',
        'writeFile', 'writeFileSync', 'createWriteStream', 'mkdir', 'unlink', 'rename',
        'copyFile', 'cp', 'rm', 'sendFile', 'rekey',
    ]) {
        io[member] = () => {
            throw new Error(`${member} is not exercised by this suite`);
        };
    }

    return {
        id: 'test-provider',
        owns: () => true,
        init: async () => {},
        isReady: () => true,
        unlock: async () => {},
        lock: () => {},
        ...io,
        ...extra,
    };
}

afterEach(() => {
    unregisterStorageProvider();
});

describe('when nothing can affirmatively say yes, the answer is no', () => {
    test('no provider installed at all', () => {
        expect(encryptsPath('/data/user-one/chats/a.jsonl')).toBe(false);
    });

    test('🔴 a provider that does not implement the capability — degrades to today\'s behaviour', () => {
        registerStorageProvider(providerWith({}));

        expect(encryptsPath('/data/user-one/chats/a.jsonl')).toBe(false);
    });

    test('🔴 a provider that THROWS has told us nothing, and nothing is not "protected"', () => {
        registerStorageProvider(providerWith({
            encryptsPath() {
                throw new Error('provider exploded');
            },
        }));

        // It must not propagate either: the chat list has to draw.
        expect(() => encryptsPath('/data/user-one/chats/a.jsonl')).not.toThrow();
        expect(encryptsPath('/data/user-one/chats/a.jsonl')).toBe(false);
    });

    test('🔴 a merely truthy answer is not a yes — the check is === true', () => {
        // A provider returning a path, a count, or anything else "helpful" must not light the padlock.
        for (const truthy of ['yes', 1, {}, [], 'false']) {
            registerStorageProvider(providerWith({ encryptsPath: () => truthy }));
            expect(encryptsPath('/data/user-one/chats/a.jsonl')).toBe(false);
            unregisterStorageProvider();
        }
    });

    test('undefined and null are no', () => {
        for (const falsy of [undefined, null]) {
            registerStorageProvider(providerWith({ encryptsPath: () => falsy }));
            expect(encryptsPath('/data/user-one/chats/a.jsonl')).toBe(false);
            unregisterStorageProvider();
        }
    });
});

describe('when the provider does say yes', () => {
    test('the answer is passed through, per path', () => {
        registerStorageProvider(providerWith({
            encryptsPath: (p) => p.endsWith('encrypted.jsonl'),
        }));

        expect(encryptsPath('/data/user-one/chats/encrypted.jsonl')).toBe(true);
        expect(encryptsPath('/data/user-one/chats/legacy.jsonl')).toBe(false);
    });

    test('🔴 owns and encryptsPath are different questions about the same path', () => {
        // The mixed-mode property in one assertion: the provider owns this path for routing, and passes
        // it through in the clear. Conflating the two is what would mark every legacy chat as protected.
        const provider = providerWith({
            owns: () => true,
            encryptsPath: () => false,
        });
        registerStorageProvider(provider);

        // ⚠️ `owns` is asserted through the FORK's seam, not off the stub. Reading `provider.owns(...)` here
        // only established that the stub returns what the stub was configured with, three lines up — an
        // assertion about a mock, inflating the apparent coverage of a test whose name promises the fork is
        // being held to something.
        expect(owns('/data/user-one/chats/legacy.jsonl')).toBe(true);
        expect(encryptsPath('/data/user-one/chats/legacy.jsonl')).toBe(false);
    });
});
