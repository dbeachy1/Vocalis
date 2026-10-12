import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { makeScratchDirectory } from './util/st-server.js';

/**
 * 🔀 THE FIXTURE THAT CLOSES THE GAP — tested, because an untested fixture proves nothing.
 *
 * `DESIGN_MIXED_MODE.md` §12 opens by naming a hole in this suite: no fixture provider encrypts
 * filenames, so every one of them passes names straight through to `fs.readdirSync`. The entire failure
 * class of "this code path used raw `fs` and therefore could not see a file whose on-disk name is
 * ciphertext" was invisible to all 39 suites — which is how `88a0ebdd8` shipped a `/api/backups/chat/get`
 * that reported "no backups" for ever while the backups sat there intact.
 *
 * `tests/fixtures/mixed-provider.js` exists to make that class visible. This file proves the fixture
 * itself behaves, because a fixture with a bug in it produces confident green tests about nothing.
 *
 * ## What is asserted here, and what is not
 *
 * These are unit tests against the provider object. They deliberately do NOT boot a server — the ten-step
 * lifecycle in §12 does that, and it comes later. What is proved here is the fixture's contract:
 *
 *   - a file it writes is on disk under a name the caller never used, carrying an envelope
 *   - a file that predates it is served back byte-identical and is never rewritten
 *   - `readdir` returns the union of both namespaces under logical names
 *   - 🔴 the three states of §3 stay separate, including the one that loses data when they collapse
 */

/** @type {typeof import('./fixtures/mixed-provider.js').default} */
let createMixedProvider;
/** @type {typeof import('./fixtures/mixed-provider.js')} */
let fixture;

const HANDLE = 'user-one';
const LOCKED_HANDLE = 'user-two';
const PASSWORD = 'correct-horse';

/** @type {string} */
let dataRoot;
/** @type {string} */
let chatsDir;
/** @type {import('../src/storage.js').StorageProvider} */
let provider;

/** A chat that was written before the provider was ever installed. */
const LEGACY_NAME = 'legacy-chat.jsonl';
const LEGACY_BODY = '{"name":"a chat from before the plugin"}\n';

/** A chat created while the provider is installed. */
const NEW_NAME = 'new-chat.jsonl';
const NEW_BODY = '{"name":"a chat from after the plugin"}\n';

/**
 * Everything raw `fs` can see in the chats directory. This is the caller that mixed mode breaks.
 * @returns {string[]} On-disk names
 */
function onDisk() {
    return fs.readdirSync(chatsDir).sort();
}

// This suite had no teardown at all, so its scratch directory leaked on EVERY run — not only on a crash. The
// manifest sweep would have reclaimed it eventually now that the directory is recorded, but a suite that
// knows when it is finished should not make the sweep do its work.
afterAll(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

beforeAll(async () => {
    dataRoot = makeScratchDirectory('mixed');
    chatsDir = path.join(dataRoot, HANDLE, 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.mkdirSync(path.join(dataRoot, LOCKED_HANDLE, 'chats'), { recursive: true });

    // 🔴 PLANTED WITH RAW `fs`, BEFORE THE PROVIDER EXISTS. That is the whole point: this file was not
    // written through the provider and the provider must never treat it as its own.
    fs.writeFileSync(path.join(chatsDir, LEGACY_NAME), LEGACY_BODY);

    // The keyed base reads its configuration at module scope, so the environment has to be set before the
    // import rather than before the call. Same reason as session-cookie-name.test.js.
    process.env.ST_KEYED_STATE = path.join(dataRoot, 'vaults.json');
    process.env.ST_KEYED_HANDLE = HANDLE;
    process.env.ST_KEYED_PASSWORD = PASSWORD;
    process.env.ST_KEYED_RECOVERY_KEY = 'recovery-not-a-secret';

    fixture = await import('./fixtures/mixed-provider.js');
    createMixedProvider = fixture.default;

    provider = createMixedProvider();
    await provider.init({ dataRoot });
    await provider.unlock(HANDLE, PASSWORD);
});

describe('the mixed-mode fixture — names on disk are not the names the caller used', () => {
    test('🔴 a chat written through the provider is NOT on disk under the name it was written with', () => {
        provider.writeFileSync(path.join(chatsDir, NEW_NAME), NEW_BODY);

        // This is the assertion no other fixture in this directory can make, and the one that would have
        // caught 88a0ebdd8: raw `fs` cannot find the file by the name the application knows it by.
        expect(onDisk()).not.toContain(NEW_NAME);
        expect(onDisk().some((n) => n.startsWith(fixture.NAME_PREFIX))).toBe(true);
    });

    test('its bytes on disk carry the envelope header, and are not the plaintext', () => {
        const marked = onDisk().find((n) => n.startsWith(fixture.NAME_PREFIX));
        const raw = fs.readFileSync(path.join(chatsDir, marked), 'utf-8');

        expect(raw.startsWith(fixture.ENVELOPE_HEADER)).toBe(true);
        expect(raw).not.toContain('a chat from after the plugin');
    });

    test('reading it back through the provider returns exactly what was written', () => {
        expect(provider.readFileSync(path.join(chatsDir, NEW_NAME), 'utf-8')).toBe(NEW_BODY);
    });

    test('🔴 the legacy chat is served byte-identical and its file was never rewritten', () => {
        expect(provider.readFileSync(path.join(chatsDir, LEGACY_NAME), 'utf-8')).toBe(LEGACY_BODY);

        // Still under its own name, still plaintext, still not enveloped.
        expect(onDisk()).toContain(LEGACY_NAME);
        expect(fs.readFileSync(path.join(chatsDir, LEGACY_NAME), 'utf-8')).toBe(LEGACY_BODY);
    });

    test('🔴 saving into the legacy chat keeps it plaintext — state is inherited, not chosen (§8)', () => {
        const updated = LEGACY_BODY + '{"mes":"a reply typed after the plugin arrived"}\n';
        provider.writeFileSync(path.join(chatsDir, LEGACY_NAME), updated);

        expect(onDisk()).toContain(LEGACY_NAME);
        expect(fs.readFileSync(path.join(chatsDir, LEGACY_NAME), 'utf-8')).toBe(updated);
        expect(provider.readFileSync(path.join(chatsDir, LEGACY_NAME), 'utf-8')).toBe(updated);
    });

    test('🔴 readdir returns the UNION under logical names — both chats, one list (§4)', () => {
        const listed = provider.readdir(chatsDir).sort();

        expect(listed).toEqual([LEGACY_NAME, NEW_NAME].sort());
        // And the on-disk truth it is hiding is genuinely different, or this proves nothing.
        expect(onDisk()).not.toEqual(listed);
    });

    test('readdir with withFileTypes puts the logical name on the Dirent the caller reads', () => {
        const names = provider.readdir(chatsDir, { withFileTypes: true }).map((d) => d.name).sort();

        expect(names).toEqual([LEGACY_NAME, NEW_NAME].sort());
    });

    test('exists and stat resolve a logical name to whichever form is on disk', () => {
        expect(provider.exists(path.join(chatsDir, NEW_NAME))).toBe(true);
        expect(provider.exists(path.join(chatsDir, LEGACY_NAME))).toBe(true);
        expect(provider.exists(path.join(chatsDir, 'no-such-chat.jsonl'))).toBe(false);
        expect(provider.stat(path.join(chatsDir, NEW_NAME)).isFile()).toBe(true);
    });
});

describe('encryptsPath — the question the padlock is drawn from (§6.1)', () => {
    test('true for a chat this provider encrypts, false for one it passes through', () => {
        expect(provider.encryptsPath(path.join(chatsDir, NEW_NAME))).toBe(true);
        expect(provider.encryptsPath(path.join(chatsDir, LEGACY_NAME))).toBe(false);
    });

    test('a path that does not exist answers cleanly instead of throwing', () => {
        // The chat list asks about rows that may have just been deleted, so this must not throw.
        expect(() => provider.encryptsPath(path.join(chatsDir, 'gone.jsonl'))).not.toThrow();
        expect(provider.encryptsPath(path.join(chatsDir, 'gone.jsonl'))).toBe(false);
    });
});

/**
 * 🔴 §3's three states. Collapsing "ours but broken" into "not ours" is the mistake that loses data,
 * because SillyTavern has six code paths that respond to unreadable data by regenerating it from source.
 * These are §12's tests 11, 12 and 13.
 */
describe('the classifier — ours-but-broken must never look like not-ours', () => {
    /**
     * The on-disk path of the encrypted chat.
     * @returns {string} Absolute path
     */
    function markedPath() {
        return path.join(chatsDir, onDisk().find((n) => n.startsWith(fixture.NAME_PREFIX)));
    }

    test('🔴 a corrupted encrypted chat throws EPROVIDER — never ENOENT — and SURVIVES on disk', () => {
        const victim = markedPath();
        const before = fs.readFileSync(victim);

        fs.writeFileSync(victim, fixture.ENVELOPE_HEADER + '!!!! not base64 !!!!');

        let thrown;
        try {
            provider.readFileSync(path.join(chatsDir, NEW_NAME), 'utf-8');
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeDefined();
        expect(thrown.code).toBe('EPROVIDER');
        expect(thrown.code).not.toBe('ENOENT');

        // 🔴 The file is still there. Nothing regenerated it, nothing pruned it.
        expect(fs.existsSync(victim)).toBe(true);
        fs.writeFileSync(victim, before);
    });

    test('🔴 a chat truncated shorter than its envelope is EPROVIDER, and survives', () => {
        const victim = markedPath();
        const before = fs.readFileSync(victim);

        fs.writeFileSync(victim, 'sten');

        let thrown;
        try {
            provider.readFileSync(path.join(chatsDir, NEW_NAME), 'utf-8');
        } catch (error) {
            thrown = error;
        }

        expect(thrown?.code).toBe('EPROVIDER');
        expect(fs.existsSync(victim)).toBe(true);
        fs.writeFileSync(victim, before);
    });

    test('🔴 a PLAINTEXT file whose contents merely resemble an envelope is passed through, not refused', () => {
        // §12 test 13. The name is the discriminator, so a file nobody marked is not ours no matter what
        // its first bytes happen to say. Refusing this would break a legitimate chat; treating the
        // truncated file above as plaintext would destroy a real one. Both directions matter.
        const impostorName = 'looks-like-ours.jsonl';
        const impostorBody = fixture.ENVELOPE_HEADER + 'this is just text somebody typed\n';
        fs.writeFileSync(path.join(chatsDir, impostorName), impostorBody);

        expect(provider.readFileSync(path.join(chatsDir, impostorName), 'utf-8')).toBe(impostorBody);
        expect(provider.encryptsPath(path.join(chatsDir, impostorName))).toBe(false);

        fs.unlinkSync(path.join(chatsDir, impostorName));
    });
});

/**
 * 🔒 The lock gate. A fixture that served everything regardless of lock state would let a lock-state or
 * oracle test pass while proving nothing — the vacuous green `storage-provider-login-oracle.test.js`
 * warns about in its own header.
 */
describe('a locked account — plaintext still works, ours does not', () => {
    test('🔴 a legacy plaintext chat is readable while locked, because it needs no key', () => {
        const lockedChats = path.join(dataRoot, LOCKED_HANDLE, 'chats');
        const name = path.join(lockedChats, 'user-two-legacy.jsonl');
        fs.writeFileSync(name, 'plaintext user-two\n');

        expect(provider.isReady(LOCKED_HANDLE)).toBe(false);
        expect(provider.readFileSync(name, 'utf-8')).toBe('plaintext user-two\n');
    });

    test('writing a NEW chat for a locked account is refused with EUNAVAILABLE', () => {
        const lockedChats = path.join(dataRoot, LOCKED_HANDLE, 'chats');

        let thrown;
        try {
            provider.writeFileSync(path.join(lockedChats, 'user-two-new.jsonl'), 'nope');
        } catch (error) {
            thrown = error;
        }

        expect(thrown?.code).toBe('EUNAVAILABLE');
    });
});
