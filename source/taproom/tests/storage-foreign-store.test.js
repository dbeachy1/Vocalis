import { describe, test, expect, afterEach } from '@jest/globals';

import {
    registerForeignStore,
    registerStorageProvider,
    unregisterStorageProvider,
} from '../src/storage.js';

/**
 * 🗄️ `registerForeignStore` — the other half of `deriveSubkey`, and the half that was missing.
 *
 * A plugin that takes a derived subkey and opens its own encrypted database has produced a file that is
 * genuinely protected and, to the provider's audit, **identical to a leak**: it carries the plugin's
 * encryption, not the provider's envelope. Undeclared, it is reported as plaintext on every audit run for
 * ever — and a leak detector with a permanent false positive is one nobody reads, which is how a real leak
 * ends up in a report the operator has been trained to skim.
 *
 * 🔴 THIS SUITE EXISTS BECAUSE THE BRIDGE WAS ABSENT, NOT WRONG. The real provider (Vault) implemented
 * `registerForeignStore` on its provider surface and documented the exact chain it expected — *"the plugin
 * calls `context.registerForeignStore(…)`, `plugin-loader.js` forwards to `storage.js`, `storage.js`
 * forwards to whatever provider is installed"* — and the fork forwarded none of it. `context
 * .registerForeignStore` was `undefined`, so no plugin could declare anything however much it wanted to,
 * and the consuming plugin's store was on course to be reported as a leak the first time it was written.
 *
 * The behaviour under test is therefore mostly about NOT interfering: the fork does not know what a leak
 * looks like, must not classify, must not validate, and must not swallow a refusal.
 */

/**
 * A minimal provider. `registerStorageProvider` enforces the full interface, so every member has to be
 * present even though only `registerForeignStore` is exercised here.
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

describe('nobody to tell', () => {
    test('no provider installed is FALSE, not a throw — an unencrypted install has no audit to confuse', () => {
        expect(registerForeignStore({ directory: 'memory', owner: 'Mnemosyne' })).toBe(false);
    });

    test('🔴 a provider that does not offer the capability is FALSE, and does not blow up the plugin', () => {
        registerStorageProvider(providerWith({}));

        expect(registerForeignStore({ directory: 'memory', owner: 'Mnemosyne' })).toBe(false);
    });

    test('🔴 false is not a detail a plugin may ignore — it means the declaration reached NOBODY', () => {
        // Documenting the contract: there is no third answer. Either a provider took it, or the store is
        // undeclared and will be audited as if the plugin had written plaintext.
        expect(registerForeignStore({ directory: 'memory', owner: 'Mnemosyne' })).toBe(false);

        registerStorageProvider(providerWith({ registerForeignStore: () => {} }));

        expect(registerForeignStore({ directory: 'memory', owner: 'Mnemosyne' })).toBe(true);
    });
});

describe('forwarding, and nothing more', () => {
    test('the declaration reaches the provider and the call reports TRUE', () => {
        const seen = [];
        registerStorageProvider(providerWith({ registerForeignStore: (store) => seen.push(store) }));

        const declared = { directory: 'memory', owner: 'Mnemosyne', forbidden: ['SQLite format 3\0'] };

        expect(registerForeignStore(declared)).toBe(true);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toEqual(declared);
    });

    test('🔴 the object arrives AS GIVEN — the fork does not normalise, rename or copy fields', () => {
        const seen = [];
        registerStorageProvider(providerWith({ registerForeignStore: (store) => seen.push(store) }));

        // Trailing slash, backslashes, an empty forbidden list: all of it is the provider's to interpret.
        // `paths.js` speaks one dialect and the fork does not know which; normalising here would mean two
        // places that both believe they own the spelling.
        const declared = { directory: 'memory\\vectors/', owner: 'Mnemosyne', forbidden: [] };

        registerForeignStore(declared);

        expect(seen[0].directory).toBe('memory\\vectors/');
        expect(seen[0].forbidden).toEqual([]);
    });

    test('🔴 an unknown extra field survives — the contract is the provider\'s to widen, not ours to police', () => {
        const seen = [];
        registerStorageProvider(providerWith({ registerForeignStore: (store) => seen.push(store) }));

        registerForeignStore({ directory: 'memory', owner: 'Mnemosyne', somethingLater: 42 });

        expect(seen[0].somethingLater).toBe(42);
    });
});

describe('🔴 a refusal must reach the plugin', () => {
    test('a provider that throws is NOT swallowed into a false', () => {
        registerStorageProvider(providerWith({
            registerForeignStore: () => {
                throw new Error('A foreign store must be inside the user\'s directory');
            },
        }));

        // Swallowing this would leave the plugin believing its store was declared when it was not — the
        // exact state this call exists to prevent, now with the plugin's confidence attached to it.
        expect(() => registerForeignStore({ directory: '../../etc', owner: 'Mnemosyne' }))
            .toThrow(/inside the user's directory/);
    });

    test('🔴 the fork does NOT pre-validate — a hostile directory reaches the provider to be refused there', () => {
        const seen = [];
        registerStorageProvider(providerWith({ registerForeignStore: (store) => seen.push(store) }));

        // If the fork refused this itself it would be a second opinion about path safety, drifting from the
        // provider's, and the provider's is the one that decides where the file actually goes.
        registerForeignStore({ directory: '../../etc', owner: 'Mnemosyne' });

        expect(seen[0].directory).toBe('../../etc');
    });

    test('a declaration missing its owner is likewise the provider\'s to refuse, not ours', () => {
        registerStorageProvider(providerWith({
            registerForeignStore: () => {
                throw new Error('A foreign store needs both a directory and an owner');
            },
        }));

        expect(() => registerForeignStore({ directory: 'memory' })).toThrow(/directory and an owner/);
    });
});
