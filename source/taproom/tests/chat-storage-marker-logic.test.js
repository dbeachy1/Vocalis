import { describe, test, expect } from '@jest/globals';

import { DATA_NOUNS, resolveChatMarker, summariseProviderNeed, unavailableBackupMessage, unavailableDataMessage, unavailableMessage, updateRequiredMessage } from '../public/scripts/chat-storage-marker-logic.js';

/**
 * 🔒 THE PADLOCK'S DECISION, TESTED WITHOUT A BROWSER — `DESIGN_MIXED_MODE.md` §6.2, §7.2, §11.
 *
 * The DOM half of the marker (revealing an <i>, setting a title) is thin and browser-territory. The half
 * that is easy to get wrong is the DECISION, and every wrong answer here is failure-shaped in the reassuring
 * direction: a padlock over a plaintext chat is a lie a user may act on by typing something into it they
 * would not otherwise have written. So the decision is a pure function and it is tested directly, the same
 * discipline as `plugin-recent-messages-client.test.js`.
 *
 * The three rules under test:
 * - §7.2 — a chat that is not affirmatively encrypted gets NOTHING. Not a grey padlock, not a warning.
 * - §6.2 — an encrypted chat whose provider supplied no words gets no marker either; a marker the fork
 *   cannot caption is the fork making the encryption claim on its own.
 * - §11  — an encrypted chat with no provider is SHOWN, disabled, naming what it needs (fork text), and the
 *   attacker-controlled id never reaches that text because the server has already dropped it to null.
 */

describe('resolveChatMarker — §7.2, nothing unless a chat affirmatively earned it', () => {
    test('a plaintext chat gets no marker', () => {
        expect(resolveChatMarker({ encrypted: false }, 'ignored')).toEqual({ kind: 'none', title: '' });
    });

    test('a chat the endpoint could not classify (no `encrypted` field) gets no marker', () => {
        expect(resolveChatMarker({}, 'ignored')).toEqual({ kind: 'none', title: '' });
    });

    test('a missing status gets no marker rather than throwing', () => {
        expect(resolveChatMarker(undefined, 'ignored')).toEqual({ kind: 'none', title: '' });
        expect(resolveChatMarker(null, 'ignored')).toEqual({ kind: 'none', title: '' });
    });

    test('🔴 only `encrypted === true` counts — a truthy-but-not-true value is still "no"', () => {
        // This mirrors the server's own `=== true` strictness (storage.js encryptsPath) and §7.2's rule that
        // every path which is not an affirmative yes resolves to no. A provider that returned something
        // merely truthy has not said "protected", and a padlock over it would be the dangerous lie.
        expect(resolveChatMarker({ encrypted: 'yes' }, 'has words')).toEqual({ kind: 'none', title: '' });
        expect(resolveChatMarker({ encrypted: 1 }, 'has words')).toEqual({ kind: 'none', title: '' });
    });
});

describe('resolveChatMarker — §6.2, the words are the provider\'s or there is no marker', () => {
    test('encrypted and available, with the provider\'s words → the live padlock captioned with them', () => {
        expect(resolveChatMarker({ encrypted: true, unavailable: false }, 'This chat is encrypted at rest.'))
            .toEqual({ kind: 'encrypted', title: 'This chat is encrypted at rest.' });
    });

    test('🔴 encrypted, but the provider gave no words → no marker at all', () => {
        // §6.2: a provider that returns nothing for storage.chatMarker gets no tooltip AND no icon. There is
        // deliberately no fork-side default sentence to fall back on — that would be the fork making the
        // claim after all, one branch down.
        expect(resolveChatMarker({ encrypted: true, unavailable: false }, '')).toEqual({ kind: 'none', title: '' });
        expect(resolveChatMarker({ encrypted: true }, undefined)).toEqual({ kind: 'none', title: '' });
    });
});

describe('resolveChatMarker — §11, an unavailable chat is shown and named, never hidden', () => {
    test('encrypted but no provider → the disabled row, naming the provider it needs', () => {
        expect(resolveChatMarker({ encrypted: true, unavailable: true, requiresProvider: 'vault' }, ''))
            .toEqual({ kind: 'unavailable', title: 'This chat requires the \'vault\' storage provider.' });
    });

    test('🔴 unavailable wins over an available provider\'s words — it is not readable, whatever is installed', () => {
        // A stale or unrelated marker string must never turn a dead row into a green one.
        expect(resolveChatMarker({ encrypted: true, unavailable: true, requiresProvider: 'vault' }, 'This chat is encrypted at rest.'))
            .toEqual({ kind: 'unavailable', title: 'This chat requires the \'vault\' storage provider.' });
    });

    test('🔴 a null provider id (the server dropped a hostile one) → the generic message, never the id', () => {
        // §3.1: the endpoint validates the envelope id to [a-z0-9-]{1,32} or returns null. So `requiresProvider`
        // is a plausible id or null — the <script> / 4 KB cases of §12 test 9a arrive here as null, and the
        // wording must not interpolate them. This is the last line before an attacker's string would reach
        // the DOM, and it does not.
        const result = resolveChatMarker({ encrypted: true, unavailable: true, requiresProvider: null }, '');
        expect(result).toEqual({ kind: 'unavailable', title: 'This chat requires a storage provider that is not installed.' });
        expect(result.title).not.toContain('<');
    });
});

describe('unavailableMessage — fork wording, and the id is only ever a plain string', () => {
    test('a validated id is named', () => {
        expect(unavailableMessage('vault')).toBe('This chat requires the \'vault\' storage provider.');
    });

    test('null, undefined, or empty → the generic "not installed" message, no interpolation', () => {
        expect(unavailableMessage(null)).toBe('This chat requires a storage provider that is not installed.');
        expect(unavailableMessage(undefined)).toBe('This chat requires a storage provider that is not installed.');
        expect(unavailableMessage('')).toBe('This chat requires a storage provider that is not installed.');
    });
});

describe('unavailableBackupMessage — §9.1, the sentence a user gets when a restore cannot happen', () => {
    test('🔴 it says BACKUP and it says RESTORE, not "this chat"', () => {
        // §14.5 settles that a legacy plaintext chat's backups stop being plaintext once a provider is
        // installed. So the unreadable backup can belong to a chat that is itself readable with no plugin at
        // all, and borrowing the chat wording would tell the user their chat is affected when it is not. The
        // two sentences are separate for that reason and must stay separate.
        const message = unavailableBackupMessage('vault');
        expect(message).toBe('This backup requires the \'vault\' storage provider to restore it.');
        expect(message).toContain('backup');
        expect(message).toContain('restore');
        expect(message).not.toContain('This chat');
    });

    test('🔴 a null id (the server dropped a hostile one) → generic wording, nothing interpolated', () => {
        const message = unavailableBackupMessage(null);
        expect(message).toBe('This backup requires a storage provider that is not installed.');
        expect(unavailableBackupMessage(undefined)).toBe(message);
        expect(unavailableBackupMessage('')).toBe(message);
        expect(message).not.toContain('<');
    });

    test('🔴 it says what is MISSING, never why — the encryption claim is the provider\'s (§6.2)', () => {
        // The first draft of this sentence read "This backup is encrypted. Install the 'vault' plugin…" and
        // storage-provider-text.js failed the build over it, correctly: a provider might be compression or a
        // remote store, and the fork does not get to say what it is. That guard is the real enforcement —
        // this is the same rule asserted where the sentence lives.
        for (const message of [unavailableBackupMessage('vault'), unavailableBackupMessage(null)]) {
            expect(message).not.toMatch(/encrypt|decrypt|cipher|plaintext/i);
        }
    });

    test('🔴 the message names the provider and never links to it (§3.1)', () => {
        // The id is display text, full stop. A "click here to install it" built out of a string an attacker
        // wrote into a file is a one-click path to installing whatever that file names.
        const message = unavailableBackupMessage('vault');
        expect(message).not.toMatch(/https?:\/\//);
        expect(message).not.toContain('<a');
    });
});

/**
 * 🪪 THE SENTENCE THE PROVENANCE REGISTRY UPGRADES — `DESIGN_STORAGE_PROVENANCE.md` §7.
 *
 * Everything above is the sentence with no registry, and it stays exactly as it was: §5 makes the registry an
 * ENRICHMENT and never a dependency, so every one of those tests is also the regression test for a fork whose
 * registry is missing, empty, or has no record of the id in front of it.
 *
 * What is new is the case where the fork DOES have a record — one it wrote itself, while that provider was
 * installed and running here (§4). The id keeps its place in every variant, because it is the only half of
 * the sentence that matches what is on the disk.
 */
describe('🪪 §7 the upgraded sentence, when the fork recorded the provider while it ran', () => {
    /** A registry record of the shape `storage-provenance.js` hands back. */
    const IDENTITY = Object.freeze({
        id: 'vault',
        name: 'SillyTavern-Vault',
        source: 'https://github.com/example/sillytavern-vault',
        version: '2.3.0',
        lastSeen: '2026-06-12T09:30:00.000Z',
    });

    test('the chat sentence names the provider, and KEEPS the id beside it', () => {
        const message = unavailableMessage('vault', IDENTITY);

        expect(message).toContain('SillyTavern-Vault');
        // 🔴 §7: a friendly name that REPLACED the id would leave a user unable to check that the plugin
        // they found is the plugin the file names. Both, always.
        expect(message).toContain('\'vault\'');
    });

    test('the backup sentence does the same, and still says backup and restore', () => {
        const message = unavailableBackupMessage('vault', IDENTITY);

        expect(message).toContain('SillyTavern-Vault');
        expect(message).toContain('\'vault\'');
        expect(message).toContain('backup');
        expect(message).toContain('restore');
        expect(message).not.toContain('This chat');
    });

    test('it offers the orientation of when the plugin was last here', () => {
        // "You had this until June" is the difference between "my data broke" and "I remember uninstalling
        // that". The exact format is the browser's locale; that it is a real date is what matters here.
        const message = unavailableMessage('vault', IDENTITY);

        expect(message).toMatch(/Last used .*2026/);
        expect(message).not.toContain('Invalid Date');
    });

    test('🔴 the source is shown as text and is never turned into a link', () => {
        // §5, and §3.1 before it. Recording `source` from a running plugin makes it ACCURATE; that does not
        // make an auto-installer safe. There is no anchor, no href, no install command — the user goes and
        // gets it themselves.
        const message = unavailableMessage('vault', IDENTITY);

        expect(message).toContain('github.com/example/sillytavern-vault');
        expect(message).not.toContain('<a');
        expect(message).not.toContain('href');
        expect(message).not.toMatch(/npm install|git clone/i);
    });

    test('🔴 it still says what is missing and never why — §6.2 survives the upgrade', () => {
        // The registry stores names and versions, which are facts. It must not have grown the fork a
        // vocabulary for what a provider DOES. `storage-provider-text.js` fails the build over that, and
        // this asserts it where the sentence is actually built.
        for (const message of [unavailableMessage('vault', IDENTITY), unavailableBackupMessage('vault', IDENTITY)]) {
            expect(message).not.toMatch(/encrypt|decrypt|cipher|plaintext/i);
        }
    });

    test('a record holding only a name says only the name', () => {
        // §6: no provider is ever REQUIRED to identify itself, and a partial declaration is a supported
        // answer rather than a broken one. Each field is independently absent.
        const message = unavailableMessage('vault', { id: 'vault', name: 'Just A Name' });

        expect(message).toBe('This chat requires Just A Name (\'vault\').');
    });

    test('a record holding no name at all falls back to the bare-id sentence, plus what it does know', () => {
        const message = unavailableMessage('vault', { id: 'vault', source: 'https://example.invalid/p' });

        expect(message).toContain('This chat requires the \'vault\' storage provider.');
        expect(message).toContain('https://example.invalid/p');
    });

    test('🔴 no record → byte-for-byte the sentence this fork drew before the registry existed', () => {
        // The case a planted id lands in (§9.3), the case a user restoring someone else\'s backup lands in,
        // and the case every fork with no registry lands in. It has to stay the boring one.
        for (const noRecord of [null, undefined, {}, 'not an object', 0]) {
            expect(unavailableMessage('vault', noRecord)).toBe('This chat requires the \'vault\' storage provider.');
            expect(unavailableBackupMessage('vault', noRecord)).toBe('This backup requires the \'vault\' storage provider to restore it.');
        }
    });

    test('🔴 a record cannot resurrect an id the server already dropped to null', () => {
        // The id is the KEY to the record, so a null id means there was nothing to look one up with. If a
        // record still arrived somehow, naming it would be attributing a file to a provider on no evidence
        // at all — the generic sentence is the only honest one.
        expect(unavailableMessage(null, IDENTITY)).toBe('This chat requires a storage provider that is not installed.');
        expect(unavailableBackupMessage(null, IDENTITY)).toBe('This backup requires a storage provider that is not installed.');
    });

    test('a malformed lastSeen is dropped rather than rendered', () => {
        const message = unavailableMessage('vault', { id: 'vault', name: 'A Name', lastSeen: 'not a date' });

        expect(message).toBe('This chat requires A Name (\'vault\').');
        expect(message).not.toContain('Invalid Date');
    });

    test('resolveChatMarker carries the record through to the row', () => {
        const result = resolveChatMarker({ encrypted: true, unavailable: true, requiresProvider: 'vault', identity: IDENTITY }, '');

        expect(result.kind).toBe('unavailable');
        expect(result.title).toContain('SillyTavern-Vault');
    });

    test('a state from an older server, with no identity field at all, is unchanged', () => {
        const result = resolveChatMarker({ encrypted: true, unavailable: true, requiresProvider: 'vault' }, '');

        expect(result).toEqual({ kind: 'unavailable', title: 'This chat requires the \'vault\' storage provider.' });
    });
});

/**
 * 🪪 §7 SURFACE 4 — THE SENTENCE FOR EVERYTHING THAT IS NOT A CHAT.
 *
 * §3's third user moment: a user uninstalls a provider, is told about their chats, and then discovers
 * characters, worlds, backgrounds and settings one silent failure at a time. These are the words that
 * close that gap, and they are the chat sentence with one noun swapped — deliberately, because the user's
 * situation is identical and two vocabularies for one uninstall would be the drift §6.2 keeps warning about.
 */
describe('🪪 §7 surface 4 — characters, worlds, backgrounds and settings get named too', () => {
    /** The same registry record shape the chat surfaces receive. */
    const IDENTITY = Object.freeze({
        id: 'vault',
        name: 'SillyTavern-Vault',
        source: 'https://github.com/example/sillytavern-vault',
        lastSeen: '2026-06-12T09:30:00.000Z',
    });

    test('each data type says what IT is, so the user knows which thing is affected', () => {
        expect(unavailableDataMessage(DATA_NOUNS.character, 'vault'))
            .toBe('This character requires the \'vault\' storage provider.');
        expect(unavailableDataMessage(DATA_NOUNS.world, 'vault'))
            .toBe('This world info file requires the \'vault\' storage provider.');
        expect(unavailableDataMessage(DATA_NOUNS.background, 'vault'))
            .toBe('This background requires the \'vault\' storage provider.');
        expect(unavailableDataMessage(DATA_NOUNS.settings, 'vault'))
            .toBe('This settings file requires the \'vault\' storage provider.');
    });

    test('the registry upgrades it exactly as it upgrades the chat sentence, id kept', () => {
        const message = unavailableDataMessage(DATA_NOUNS.character, 'vault', IDENTITY);

        expect(message).toContain('SillyTavern-Vault');
        expect(message).toContain('\'vault\'');
        expect(message).toMatch(/Last used .*2026/);
        expect(message).toContain('github.com/example/sillytavern-vault');
    });

    test('🔴 a null id (the server dropped a hostile one) → generic wording, nothing interpolated', () => {
        for (const noun of Object.values(DATA_NOUNS)) {
            for (const id of [null, undefined, '']) {
                const message = unavailableDataMessage(noun, id);
                expect(message).toBe(`This ${noun} requires a storage provider that is not installed.`);
                expect(message).not.toContain('<');
            }
        }
    });

    test('🔴 the noun is the fork\'s and never the disk\'s — a missing one degrades, it does not interpolate', () => {
        // Every caller passes a DATA_NOUNS literal. This is the guard for the day one of them passes a
        // filename instead: the sentence must stay a sentence rather than becoming a place to put a name
        // that came off the disk.
        expect(unavailableDataMessage(undefined, 'vault')).toBe('This file requires the \'vault\' storage provider.');
        expect(unavailableDataMessage('', 'vault')).toBe('This file requires the \'vault\' storage provider.');
        expect(unavailableDataMessage(null, null)).toBe('This file requires a storage provider that is not installed.');
    });

    test('🔴 §6.2 survives here too — what is missing, never why, and never a link', () => {
        for (const noun of Object.values(DATA_NOUNS)) {
            const message = unavailableDataMessage(noun, 'vault', IDENTITY);
            expect(message).not.toMatch(/encrypt|decrypt|cipher|plaintext|unseal/i);
            expect(message).not.toContain('<a');
            expect(message).not.toContain('href');
            expect(message).not.toMatch(/npm install|git clone/i);
        }
    });

    test('🔴 the chat sentence is unchanged by being built out of this one', () => {
        // unavailableMessage now delegates here with 'chat'. That refactor is only safe if the wording it
        // produced before is the wording it produces now — byte for byte, with and without a record.
        expect(unavailableMessage('vault')).toBe('This chat requires the \'vault\' storage provider.');
        expect(unavailableMessage(null)).toBe('This chat requires a storage provider that is not installed.');
        expect(unavailableMessage('vault', IDENTITY)).toBe(unavailableDataMessage('chat', 'vault', IDENTITY));
    });
});

/**
 * 🪪 §7 ROW 3 / §12.1 — "YOU HAVE THE PLUGIN AND IT STILL WILL NOT OPEN, SO UPDATE IT."
 *
 * The third state of an encrypted chat, and the one that could not be built until the provider grew
 * `envelopeVersionAt()`: the provider IS installed, but it wrote this file in a version the installed build
 * cannot read. That is a different sentence from "install the plugin" — the user already has it — and this
 * block asserts the sentence, and that `resolveChatMarker` draws the disabled row for it without ever
 * confusing it with the provider-gone case.
 */
describe('🪪 §12.1 updateRequiredMessage — the version-skew sentence', () => {
    const IDENTITY = Object.freeze({ id: 'vault', name: 'SillyTavern-Vault', version: '2.3.0' });

    test('it says UPDATE, names the plugin, and keeps the id', () => {
        const message = updateRequiredMessage('vault', IDENTITY);

        expect(message).toContain('SillyTavern-Vault');
        expect(message).toContain('\'vault\'');
        expect(message).toMatch(/update the plugin/i);
        // The installed version is offered as orientation — "I have 2.3.0, I need newer".
        expect(message).toContain('2.3.0');
    });

    test('🔴 it is NOT the "install the plugin" sentence — the user already has it', () => {
        const message = updateRequiredMessage('vault', IDENTITY);

        // "requires … that is not installed" would be a flat lie here: it IS installed.
        expect(message).not.toMatch(/is not installed/);
        expect(message).not.toMatch(/requires .* storage provider\.?$/);
    });

    test('🔴 §6.2 survives — says what is wrong, never why, and never a link', () => {
        const message = updateRequiredMessage('vault', IDENTITY);

        expect(message).not.toMatch(/encrypt|decrypt|cipher|plaintext|unseal/i);
        expect(message).not.toContain('<a');
        expect(message).not.toContain('href');
    });

    test('no record → the bare id, still telling the user to update', () => {
        expect(updateRequiredMessage('vault')).toBe('This chat was written by a version of the \'vault\' storage provider that the installed plugin cannot open. Update the plugin.');
    });

    test('🔴 a null id (server dropped a hostile one) → generic wording, nothing interpolated', () => {
        const message = updateRequiredMessage(null);

        expect(message).toContain('the storage provider that wrote it');
        expect(message).toMatch(/update the plugin/i);
        expect(message).not.toContain('<');
    });
});

describe('🪪 §12.1 resolveChatMarker — the skew is a disabled row, distinct from provider-gone', () => {
    const IDENTITY = Object.freeze({ id: 'vault', name: 'SillyTavern-Vault', version: '2.3.0' });

    test('requiresUpdate → a disabled row captioned with the UPDATE sentence', () => {
        const result = resolveChatMarker({ encrypted: true, unavailable: false, requiresUpdate: true, requiresProvider: 'vault', identity: IDENTITY }, 'FIXTURE marker');

        expect(result.kind).toBe('unavailable');
        expect(result.title).toMatch(/update the plugin/i);
        expect(result.title).toContain('SillyTavern-Vault');
    });

    test('🔴 the provider\'s live marker does NOT win over a skew — the chat still cannot be opened', () => {
        // A skewed chat's provider is installed and answering `storage.chatMarker`, so a naive path would draw
        // the green padlock over a file that will not load. The skew has to be decided before the marker.
        const result = resolveChatMarker({ encrypted: true, unavailable: false, requiresUpdate: true, requiresProvider: 'vault', identity: IDENTITY }, 'This chat is protected.');

        expect(result.kind).toBe('unavailable');
        expect(result.title).not.toBe('This chat is protected.');
    });

    test('🔴 provider-GONE wins over update — you cannot update a plugin that is not there', () => {
        // The two are mutually exclusive in practice (one needs the provider present, the other absent), but
        // if a state ever carried both, "install" is the correct advice and must not be shadowed by "update".
        const result = resolveChatMarker({ encrypted: true, unavailable: true, requiresUpdate: true, requiresProvider: 'vault', identity: IDENTITY }, '');

        expect(result.kind).toBe('unavailable');
        expect(result.title).toMatch(/requires SillyTavern-Vault/);
        expect(result.title).not.toMatch(/update the plugin/i);
    });

    test('🔴 no requiresUpdate → an ordinary readable chat is UNTOUCHED (silence means readable)', () => {
        // The whole risk of the skew check: a version-1 file against a build that reads [1] must stay green.
        // A state with no `requiresUpdate` is exactly that, and it must still get the live padlock.
        const result = resolveChatMarker({ encrypted: true, unavailable: false, requiresProvider: null, identity: null }, 'FIXTURE: this chat is encrypted at rest.');

        expect(result).toEqual({ kind: 'encrypted', title: 'FIXTURE: this chat is encrypted at rest.' });
    });
});

/**
 * 🪪 §7 SURFACE 5 — THE ACCOUNT-WIDE SUMMARY SENTENCE, TESTED WITHOUT A BROWSER.
 *
 * The server hands the client grouped counts; this turns one provider's group into the line a user reads.
 * Every wrong answer is small and reassuring-looking — "1 chats", "3 character", "need" where it should be
 * "needs", a provider named without its id — so it is a pure function tested directly, the same discipline as
 * `resolveChatMarker` above.
 */
describe('summariseProviderNeed — §7 surface 5, one provider\'s worth of lost data as a sentence', () => {
    const IDENTITY = Object.freeze({
        id: 'vault',
        name: 'SillyTavern-Vault',
        source: 'https://github.com/example/sillytavern-vault',
        lastSeen: '2026-06-12T09:30:00.000Z',
    });

    test('names the provider, keeps the id, pluralises, and joins with "and"', () => {
        const sentence = summariseProviderNeed({ id: 'vault', identity: IDENTITY, total: 15, counts: { chat: 12, character: 3 } });

        expect(sentence).toContain('12 chats and 3 characters');
        expect(sentence).toContain('SillyTavern-Vault (\'vault\')');
        expect(sentence).toMatch(/that need /); // plural verb for 15 items
        // 🔴 source is shown as text, never as a link, exactly as the per-row sentences.
        expect(sentence).toContain('Find it at https://github.com/example/sillytavern-vault');
        expect(sentence).toContain('Last used');
    });

    test('🔴 a single item uses the singular noun AND the singular verb', () => {
        const sentence = summariseProviderNeed({ id: 'vault', identity: IDENTITY, total: 1, counts: { world: 1 } });

        expect(sentence).toContain('1 world info file');
        expect(sentence).not.toContain('world info files');
        expect(sentence).toMatch(/that needs /);
    });

    test('three types read as "a, b and c"', () => {
        const sentence = summariseProviderNeed({ id: 'vault', identity: IDENTITY, total: 6, counts: { chat: 2, character: 3, background: 1 } });

        expect(sentence).toContain('2 chats, 3 characters and 1 background');
    });

    test('the count order is fixed (chats first, settings last), not the object\'s key order', () => {
        const sentence = summariseProviderNeed({ id: 'vault', identity: IDENTITY, total: 3, counts: { settings: 1, chat: 1, group: 1 } });

        expect(sentence).toContain('1 chat, 1 group and 1 settings file');
    });

    test('🔴 no registry record → bare id, still no link, still counts', () => {
        const sentence = summariseProviderNeed({ id: 'unknown-plugin', identity: null, total: 4, counts: { chat: 4 } });

        expect(sentence).toBe('You have 4 chats that need the \'unknown-plugin\' storage provider.');
    });

    test('🔴 an unknown id (validation dropped it to null) still names the loss without inventing a provider', () => {
        const sentence = summariseProviderNeed({ id: null, identity: null, total: 2, counts: { character: 2 } });

        expect(sentence).toBe('You have 2 characters that need a storage provider that is not installed.');
    });

    test('an unknown data type contributes nothing and cannot skew the verb', () => {
        // A type the fork has no noun for is dropped rather than rendered as a raw key. If it were the only
        // thing, the sentence is empty; alongside a known type it neither appears nor changes "need"/"needs".
        expect(summariseProviderNeed({ id: 'vault', identity: IDENTITY, total: 9, counts: { mystery: 9 } })).toBe('');

        const mixed = summariseProviderNeed({ id: 'vault', identity: IDENTITY, total: 10, counts: { world: 1, mystery: 9 } });
        expect(mixed).toContain('1 world info file');
        expect(mixed).not.toContain('mystery');
        expect(mixed).toMatch(/that needs /); // one KNOWN item → singular
    });

    test('an empty or malformed group yields the empty string, never a half-sentence', () => {
        expect(summariseProviderNeed(null)).toBe('');
        expect(summariseProviderNeed({})).toBe('');
        expect(summariseProviderNeed({ id: 'vault', counts: {} })).toBe('');
        expect(summariseProviderNeed({ id: 'vault', counts: { chat: 0 } })).toBe('');
    });
});
