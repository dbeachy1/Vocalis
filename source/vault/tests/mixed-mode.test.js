import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import createProvider from '../src/index.js';
import * as session from '../src/session.js';
import { readVaultKeys, forgetNameSchemes, VAULT_KEYS_FILENAME } from '../src/vault-store.js';
import {
    ENVELOPE_HEADER,
    ENVELOPE_HEADER_BYTES,
    ENVELOPE_VERSION,
    MAX_HEADER_BYTES,
    PROVIDER_ID,
    isOurEnvelope,
    parseEnvelope,
    unwrapEnvelope,
    wrapEnvelope,
} from '../src/envelope.js';
import { isMarkedName, MARKED_NAME_PREFIX } from '../src/crypto/name-cipher.js';
import { STRUCTURAL_DIRECTORIES } from '../src/paths.js';
import { createVaultState } from '../src/vault-state.js';

/**
 * 🔀 MIXED MODE — a vault installed onto an account that already had chats in it.
 *
 * `DESIGN_MIXED_MODE.md` §1: a chat that was not encrypted when it was created stays unencrypted for ever;
 * a chat created while the provider is installed is encrypted end to end; both are readable in one account
 * at one time. §2 is why it matters — before this, installing the plugin on a live account made that
 * account impossible to log into, permanently.
 *
 * 🔴 The part that can destroy data is §3's classifier, and the tests below are ordered around it. A file
 * is ours or not by its NAME, keylessly. Never by trying to decrypt it and seeing what happens, because
 * that answer reports a DAMAGED file as somebody else's — and `provider.js` opens by naming the price:
 * SillyTavern has six code paths that respond to unreadable data by deleting it and regenerating it.
 */

const HANDLE = 'default-user';
const PASSWORD = 'correct horse battery staple';

/** @type {string} */
let dataRoot;
/** @type {any} */
let provider;

/**
 * A logical path inside the account.
 * @param {...string} parts Path components
 * @returns {string} The absolute logical path
 */
const at = (...parts) => path.join(dataRoot, HANDLE, ...parts);

/**
 * Put a plaintext file on the disk the way it would have been there BEFORE this plugin existed: raw `fs`,
 * ordinary name, no provider anywhere near it.
 * @param {string} relative Path within the account
 * @param {string} body Its contents
 * @returns {string} The absolute path
 */
function plantLegacyFile(relative, body) {
    const full = path.join(dataRoot, HANDLE, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
    return full;
}

/**
 * Every file actually on the disk under the account.
 * @param {string} [dir] Where to look
 * @param {string} [prefix] Reporting prefix
 * @returns {string[]} Relative paths
 */
function onDisk(dir = path.join(dataRoot, HANDLE), prefix = '') {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        return entry.isDirectory() ? onDisk(path.join(dir, entry.name), relative) : [relative];
    });
}


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
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mixed-'));
    fs.mkdirSync(path.join(dataRoot, HANDLE), { recursive: true });
    session.closeAll(vault);
    forgetNameSchemes(vault);

    provider = createProvider(vault);
    provider.init({
        dataRoot,
        accountsEnabled: true,
        basicAuthMode: false,
        authenticationDelegated: false,
        users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
    });
});

afterEach(() => {
    session.closeAll(vault);
    forgetNameSchemes(vault);
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

// -------------------------------------------------------------------------------------------------
// §3.1 — the envelope, which is the fork's grammar and not ours
// -------------------------------------------------------------------------------------------------

describe('🔀 the public envelope', () => {
    test('is exactly the grammar the fork parses, and names us', () => {
        // The fork reads these three fields with NO plugin loaded and no key. That is the whole reason the
        // header is not a Vault-private blob: it is what lets an uninstalled chat say what to reinstall.
        expect(ENVELOPE_HEADER).toBe(`stenv:${ENVELOPE_VERSION}:${PROVIDER_ID}:`);
        expect(PROVIDER_ID).toMatch(/^[a-z0-9-]{1,32}$/);
    });

    test('🔴 the provider id in the envelope is the SAME STRING the plugin reports everywhere else', () => {
        // §6 of DESIGN_STORAGE_PROVENANCE: a declaration whose id does not match what is on the files keys
        // to a registry entry no file will ever match, and the fork refuses it. One constant, three uses.
        expect(provider.id).toBe(PROVIDER_ID);
        expect(provider.describe('storage.identity').id).toBe(PROVIDER_ID);
    });

    test('round-trips a sealed blob', () => {
        const sealed = Buffer.from('STV1 and then some ciphertext', 'utf-8');
        const wrapped = wrapEnvelope(sealed);

        expect(wrapped.subarray(0, ENVELOPE_HEADER_BYTES).toString('ascii')).toBe(ENVELOPE_HEADER);
        expect(unwrapEnvelope(wrapped)).toEqual({ ok: true, sealed });
    });

    test('🔴 §12 test 13: a plaintext file that merely BEGINS "stenv:" is not an envelope', () => {
        // The check is structural and every field is validated. Getting this backwards classifies a
        // perfectly good legacy chat as broken ciphertext and refuses to open it, for ever.
        expect(parseEnvelope('stenv: hello, this is a chat about stenv')).toBeNull();
        expect(parseEnvelope('stenv:notaversion:vault:')).toBeNull();
        expect(parseEnvelope('stenvelope:1:vault:')).toBeNull();
        expect(isOurEnvelope('stenv: hello')).toBe(false);
    });

    test('🔴 an id longer than the cap is "unknown", never the attacker\'s string', () => {
        // §3.1: the id sits outside the crypto by necessity, so anyone who can write to the data directory
        // can set it to anything. The terminator never arrives inside the 64-byte window, so the 4 KB is
        // never read and never returned to a caller who might render it.
        const planted = `stenv:1:${'a'.repeat(4096)}:body`;
        expect(parseEnvelope(planted)).toEqual({ version: 1, providerId: null, bodyOffset: 64 });
    });

    test('🔴 an id that fails the character class reports as unknown, not as itself', () => {
        expect(parseEnvelope('stenv:1:<script>alert(1)</script>:x').providerId).toBeNull();
        expect(parseEnvelope('stenv:1:VAULT:x').providerId).toBeNull();
    });

    test('another provider\'s envelope, and a future version, are both refused BY NAME', () => {
        // Two different sentences, because they need two different actions from the user: "install
        // something else" versus "update the plugin you already have".
        expect(unwrapEnvelope(Buffer.from('stenv:1:someone-else:x')).reason).toMatch(/different storage provider/);
        expect(unwrapEnvelope(Buffer.from('stenv:9:vault:x')).reason).toMatch(/version 9.*Update the plugin/);
    });
});

// -------------------------------------------------------------------------------------------------
// §2 — the lockout, which is the thing this whole feature removes
// -------------------------------------------------------------------------------------------------

describe('🔀 installing onto an account that already has chats', () => {
    beforeEach(() => {
        plantLegacyFile('chats/Test Character 1/a quiet evening.jsonl', '{"mes":"from before the vault"}\n');
        plantLegacyFile('worlds/Sample Setting 1.json', '{"entries":{}}');
    });

    test('🔴 §12 step 2: the login SUCCEEDS', async () => {
        await expect(provider.unlock(HANDLE, PASSWORD)).resolves.toBeUndefined();
        expect(provider.isReady(HANDLE)).toBe(true);
    });

    test('🔴 §12 step 3: the existing chat is byte-identical and its mtime has not moved', async () => {
        const full = at('chats', 'Test Character 1', 'a quiet evening.jsonl');
        const before = fs.statSync(full);

        await provider.unlock(HANDLE, PASSWORD);

        expect(fs.readFileSync(full, 'utf-8')).toBe('{"mes":"from before the vault"}\n');
        expect(fs.statSync(full).mtimeMs).toBe(before.mtimeMs);
    });

    test('the legacy chat reads back THROUGH the provider, unchanged', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        expect(await provider.readFile(at('chats', 'Test Character 1', 'a quiet evening.jsonl'), 'utf-8'))
            .toBe('{"mes":"from before the vault"}\n');
    });

    test('🔴 saving into it keeps it plaintext — §1, and it is the promise the whole feature makes', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('chats', 'Test Character 1', 'a quiet evening.jsonl'), 'still plain\n');

        // Raw fs, under the original name: nothing moved it and nothing enciphered it.
        expect(fs.readFileSync(at('chats', 'Test Character 1', 'a quiet evening.jsonl'), 'utf-8')).toBe('still plain\n');
    });

    test('🔴 §12 step 4: a NEW chat in the SAME directory is encrypted and marked', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('chats', 'Test Character 1', 'a new chat.jsonl'), '{"mes":"after"}\n');

        const marked = onDisk().filter(f => isMarkedName(path.basename(f)));
        expect(marked).toHaveLength(1);

        const bytes = fs.readFileSync(path.join(dataRoot, HANDLE, marked[0]));
        expect(isOurEnvelope(bytes)).toBe(true);
        expect(bytes.toString('latin1')).not.toContain('after');
    });

    test('🔴 the new chat KEEPS ITS .jsonl SUFFIX on disk — §14.2, and uninstalled chats vanish without it', async () => {
        // Every lister that surfaces a chat filters raw `fs` entries by `path.extname(name) === '.jsonl'`,
        // and with no plugin installed there is nothing to demangle the name back first. A scheme that hid
        // the extension inside the ciphertext would make every encrypted chat disappear from exactly the
        // lists §11 insists it must appear in — the "my data is gone" outcome, caused by the fix.
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('chats', 'Test Character 1', 'a new chat.jsonl'), '{"mes":"after"}\n');

        const marked = onDisk().filter(f => isMarkedName(path.basename(f)));
        expect(path.extname(marked[0])).toBe('.jsonl');
        expect(path.basename(marked[0]).startsWith(MARKED_NAME_PREFIX)).toBe(true);

        // And the real name is nowhere in the clear.
        expect(marked[0]).not.toContain('a new chat');
    });

    test('🔴 §12 step 5: ONE listing holds both, under their logical names', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('chats', 'Test Character 1', 'a new chat.jsonl'), '{"mes":"after"}\n');

        expect(provider.readdir(at('chats', 'Test Character 1')).sort())
            .toEqual(['a new chat.jsonl', 'a quiet evening.jsonl']);
    });

    test('the account records that it holds legacy plaintext', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        expect(readVaultKeys(dataRoot, HANDLE).legacyData).toBe(true);
    });
});

// -------------------------------------------------------------------------------------------------
// §6.1 — encryptsPath, which is the only thing the padlock is drawn from
// -------------------------------------------------------------------------------------------------

describe('🔀 encryptsPath', () => {
    beforeEach(async () => {
        plantLegacyFile('chats/Test Character 1/legacy.jsonl', 'plain\n');
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('chats', 'Test Character 1', 'fresh.jsonl'), 'secret\n');
    });

    test('🔴 §12 test 14: false for plaintext, true for encrypted, and a clean answer for a missing path', () => {
        expect(provider.encryptsPath(at('chats', 'Test Character 1', 'legacy.jsonl'))).toBe(false);
        expect(provider.encryptsPath(at('chats', 'Test Character 1', 'fresh.jsonl'))).toBe(true);
        expect(() => provider.encryptsPath(at('chats', 'Nobody', 'gone.jsonl'))).not.toThrow();
        expect(provider.encryptsPath(at('chats', 'Nobody', 'gone.jsonl'))).toBe(false);
    });

    test('🔴 §14.3: a LOCKED vault still says true — the padlock must not blink out on an idle lock', () => {
        provider.lock(HANDLE);

        // A legacy file is still decidable with no key: it is sitting there under its own name.
        expect(provider.encryptsPath(at('chats', 'Test Character 1', 'legacy.jsonl'))).toBe(false);

        // Ours is not — our names are ciphertext and finding them needs the key. §14.3 rules that the
        // honest degradation is `true`: a padlock that vanished whenever a vault locked would read as
        // "your data stopped being protected" at the moment it became MORE protected.
        expect(provider.encryptsPath(at('chats', 'Test Character 1', 'fresh.jsonl'))).toBe(true);
    });

    test('it is not owns() — we own the legacy chat and do not encrypt it', () => {
        expect(provider.owns(at('chats', 'Test Character 1', 'legacy.jsonl'))).toBe(true);
        expect(provider.encryptsPath(at('chats', 'Test Character 1', 'legacy.jsonl'))).toBe(false);
    });
});

// -------------------------------------------------------------------------------------------------
// DESIGN_STORAGE_PROVENANCE §7 row 3 / §12.1 — envelopeVersionAt, the fork's only way to say
// "update the plugin" instead of drawing a padlock on a chat that will not open
// -------------------------------------------------------------------------------------------------

describe('🔀 envelopeVersionAt', () => {
    beforeEach(async () => {
        plantLegacyFile('chats/Test Character 1/legacy.jsonl', 'plain\n');
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('chats', 'Test Character 1', 'fresh.jsonl'), 'secret\n');
    });

    test('🔴 the version of one of ours, read from the LOGICAL path — which is the whole point', () => {
        // §12.1: the fork can already read an envelope off a path it can name, and while we are installed
        // it cannot name one. Nothing is on the disk at this logical path; the answer comes back anyway.
        expect(fs.existsSync(at('chats', 'Test Character 1', 'fresh.jsonl'))).toBe(false);
        expect(provider.envelopeVersionAt(at('chats', 'Test Character 1', 'fresh.jsonl'))).toBe(ENVELOPE_VERSION);
    });

    test('a legacy plaintext chat is null — no envelope, nothing to be skewed against', () => {
        expect(provider.envelopeVersionAt(at('chats', 'Test Character 1', 'legacy.jsonl'))).toBeNull();
    });

    test('🔴 a missing path is null and does NOT throw — the chat list asks about deleted rows', () => {
        expect(() => provider.envelopeVersionAt(at('chats', 'Nobody', 'gone.jsonl'))).not.toThrow();
        expect(provider.envelopeVersionAt(at('chats', 'Nobody', 'gone.jsonl'))).toBeNull();
    });

    test('🔴 a LOCKED vault is null, not a guess — §14.3, and the opposite of encryptsPath', () => {
        provider.lock(HANDLE);

        // Locked, our names are ciphertext and we cannot find the file at all. `null` means UNKNOWN, and
        // the fork disables nothing on it. The failure this pins is answering anything else: a guess here
        // would tell every row in a locked account it needs a plugin update.
        expect(provider.envelopeVersionAt(at('chats', 'Test Character 1', 'fresh.jsonl'))).toBeNull();
        expect(provider.envelopeVersionAt(at('chats', 'Test Character 1', 'legacy.jsonl'))).toBeNull();

        // And the contrast is deliberate: the padlock still draws, because being wrong about a padlock
        // costs nothing and a padlock that blinks out on an idle lock reads as lost protection.
        expect(provider.encryptsPath(at('chats', 'Test Character 1', 'fresh.jsonl'))).toBe(true);
    });

    test('the vault-keys file and paths outside the account are null', () => {
        expect(provider.envelopeVersionAt(at(VAULT_KEYS_FILENAME))).toBeNull();
        expect(provider.envelopeVersionAt(path.join(dataRoot, 'not-a-user', 'x.jsonl'))).toBeNull();
    });

    test('🔴 a DAMAGED file of ours is null, not a version — "update the plugin" is advice for a good file', () => {
        const marked = onDisk().filter(f => isMarkedName(path.basename(f)));
        expect(marked).toHaveLength(1);
        const full = path.join(dataRoot, HANDLE, marked[0]);

        // Header gone. The read path reports this properly as EPROVIDER; what it must not become is a
        // version-skew sentence, which would tell the user to go and update a plugin that is current.
        fs.writeFileSync(full, fs.readFileSync(full).subarray(ENVELOPE_HEADER_BYTES));
        expect(provider.envelopeVersionAt(at('chats', 'Test Character 1', 'fresh.jsonl'))).toBeNull();
    });

    test('🔴 it reports what is ON THE FILE, not what this build writes — the skew must be detectable', async () => {
        const marked = onDisk().filter(f => isMarkedName(path.basename(f)));
        const full = path.join(dataRoot, HANDLE, marked[0]);
        const body = fs.readFileSync(full).subarray(ENVELOPE_HEADER_BYTES);

        // A chat written by a FUTURE build of this plugin. If this returned `ENVELOPE_VERSION` from the
        // constant instead of from the bytes, the one case the method exists for would never fire — and it
        // would pass every other test in this block, all of which use files this build wrote.
        fs.writeFileSync(full, Buffer.concat([Buffer.from(`stenv:99:${PROVIDER_ID}:`, 'ascii'), body]));
        expect(provider.envelopeVersionAt(at('chats', 'Test Character 1', 'fresh.jsonl'))).toBe(99);
    });

    test('it never decrypts, and never reads more than a header', async () => {
        // A body far larger than the header window. The contract is a prefix read: the point is that a
        // 200-chat list is 200 of these, so this must not scale with the size of the chat.
        await provider.writeFile(at('chats', 'Test Character 1', 'big.jsonl'), 'x'.repeat(200_000));

        const reads = [];
        const realRead = fs.readSync;
        fs.readSync = (fd, buffer, offset, length, position) => {
            reads.push(length);
            return realRead(fd, buffer, offset, length, position);
        };

        try {
            expect(provider.envelopeVersionAt(at('chats', 'Test Character 1', 'big.jsonl'))).toBe(ENVELOPE_VERSION);
        } finally {
            fs.readSync = realRead;
        }

        expect(reads).toEqual([MAX_HEADER_BYTES]);
    });
});

// -------------------------------------------------------------------------------------------------
// §3 — the three states. This is the part that destroys data if it is wrong.
// -------------------------------------------------------------------------------------------------

describe('🔴 the three-state classifier', () => {
    beforeEach(async () => {
        plantLegacyFile('chats/Test Character 1/legacy.jsonl', 'plain\n');
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('chats', 'Test Character 1', 'fresh.jsonl'), 'secret\n');
    });

    /**
     * @returns {string} The absolute on-disk path of the one encrypted chat
     */
    function encryptedChatOnDisk() {
        const marked = onDisk().filter(f => isMarkedName(path.basename(f)));
        expect(marked).toHaveLength(1);
        return path.join(dataRoot, HANDLE, marked[0]);
    }

    test('🔴 §12 test 11: a CORRUPTED encrypted chat throws EPROVIDER, and survives', async () => {
        const full = encryptedChatOnDisk();
        const bytes = fs.readFileSync(full);
        bytes[bytes.length - 1] ^= 0xff;
        fs.writeFileSync(full, bytes);

        await expect(provider.readFile(at('chats', 'Test Character 1', 'fresh.jsonl')))
            .rejects.toMatchObject({ code: 'EPROVIDER' });

        // 🔴 The file is STILL THERE. EPROVIDER means "there is something here and I cannot read it";
        // ENOENT means "there is nothing here, go ahead and create it", and six code paths take that
        // invitation. The difference between them is the difference between a bad day and a lost chat.
        expect(fs.existsSync(full)).toBe(true);
        expect(fs.readFileSync(full).length).toBe(bytes.length);
    });

    test('🔴 §12 test 12: a TRUNCATED chat is the same answer, not ENOENT', async () => {
        const full = encryptedChatOnDisk();
        fs.writeFileSync(full, fs.readFileSync(full).subarray(0, 8));

        await expect(provider.readFile(at('chats', 'Test Character 1', 'fresh.jsonl')))
            .rejects.toMatchObject({ code: 'EPROVIDER' });
        expect(fs.existsSync(full)).toBe(true);
    });

    test('🔴 a marked name whose envelope was STRIPPED is ours-and-broken, not somebody else\'s', async () => {
        // The exact case that separates a three-state classifier from a two-state one. The bytes no longer
        // look like ours at all — but the NAME said they were, and that is what decides. A two-state
        // classifier hands these raw to SillyTavern as though they were a plaintext chat.
        const full = encryptedChatOnDisk();
        fs.writeFileSync(full, 'i am not an envelope at all');

        await expect(provider.readFile(at('chats', 'Test Character 1', 'fresh.jsonl')))
            .rejects.toMatchObject({ code: 'EPROVIDER' });
        expect(fs.readFileSync(full, 'utf-8')).toBe('i am not an envelope at all');
    });

    test('🔴 §12 test 13: a legacy chat whose first bytes LOOK like an envelope is still served', async () => {
        // Its name never said it was ours, so it is not, whatever its contents resemble. Refusing it would
        // break a perfectly good file that predates the plugin.
        plantLegacyFile('chats/Test Character 1/coincidence.jsonl', 'stenv:1:vault: not really\n');
        expect(await provider.readFile(at('chats', 'Test Character 1', 'coincidence.jsonl'), 'utf-8'))
            .toBe('stenv:1:vault: not really\n');
    });

    test('🔴 a marked name holding a VALID STV1 blob with no envelope is refused', async () => {
        // 🔴 THIS TEST EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT.
        //
        // Making `unseal` fall back to the raw bytes instead of refusing passed every other test here — the
        // content cipher's own `STV1` magic is a second keyless structural check, so a stripped envelope
        // still ended up as EPROVIDER, one layer down. That is defence in depth working, and it is also why
        // the envelope layer needs one case of its own: bytes that the LOWER check would happily accept.
        //
        // Perfectly valid ciphertext under this very key, under a name that says it is ours, with no
        // envelope on it. Only the envelope check can tell that apart, and it must, because envelope
        // version and provider id are the two things that turn "this file is broken" into "install X" or
        // "update X" — the sentences a user can actually act on.
        const full = encryptedChatOnDisk();
        fs.writeFileSync(full, fs.readFileSync(full).subarray(ENVELOPE_HEADER_BYTES));

        await expect(provider.readFile(at('chats', 'Test Character 1', 'fresh.jsonl')))
            .rejects.toMatchObject({ code: 'EPROVIDER' });
    });

    test('the encrypted chat still reads back correctly when nobody has broken it', async () => {
        expect(await provider.readFile(at('chats', 'Test Character 1', 'fresh.jsonl'), 'utf-8')).toBe('secret\n');
    });

    test('🔴 stat() reports the LOGICAL size — the envelope must come off the arithmetic', () => {
        // This becomes Content-Length. Fourteen bytes out and every response for an encrypted file hangs
        // waiting for bytes that will never arrive, with nothing throwing anywhere.
        expect(provider.stat(at('chats', 'Test Character 1', 'fresh.jsonl')).size).toBe('secret\n'.length);
        expect(provider.stat(at('chats', 'Test Character 1', 'legacy.jsonl')).size).toBe('plain\n'.length);
    });
});

// -------------------------------------------------------------------------------------------------
// The gap between "we named it" and "it predates us" — a plaintext leak with no error attached
// -------------------------------------------------------------------------------------------------

describe('🔴 a file we did not NAME is still a file we OWN', () => {
    // 🔴 THIS BLOCK EXISTS BECAUSE A MUTATION SURVIVED.
    //
    // `resolve()` decides whether to encrypt from `!step.legacy`. Changing it to `step.encrypted` reads
    // almost identically and passes all 336 other tests — and writes user data in the CLEAR for any file
    // whose on-disk NAME we did not choose. Skeleton directories are exactly that case: `chats/` keeps its
    // own name, so anything landing directly inside one has an unmarked name and fully-ours contents.
    //
    // Every real entry in `STRUCTURAL_DIRECTORIES` happens to be a directory, so no real path reaches this
    // today — which is precisely the "load-bearing invariant held together by a coincidence in a set
    // literal three files away" that `contentKey()` was written to stop relying on. So this breaks the
    // coincidence deliberately, the same way `provider.test.js` does for the locked case, and then asserts
    // the thing that actually matters: the bytes on the disk are ciphertext.
    const ROGUE = 'a-structural-entry-that-names-a-file.txt';

    beforeEach(async () => {
        STRUCTURAL_DIRECTORIES.add(ROGUE);
        await provider.unlock(HANDLE, PASSWORD);
    });

    afterEach(() => {
        STRUCTURAL_DIRECTORIES.delete(ROGUE);
    });

    test('🔴 it is ENCRYPTED on the disk, even though its name is in the clear', async () => {
        await provider.writeFile(at(ROGUE), 'the quiet part');

        // The name is unmarked — the skeleton keeps its own names, and that is correct.
        expect(fs.existsSync(at(ROGUE))).toBe(true);
        expect(isMarkedName(ROGUE)).toBe(false);

        // 🔴 And the CONTENTS are ours regardless. This is the assertion the mutation breaks.
        const bytes = fs.readFileSync(at(ROGUE));
        expect(bytes.toString('latin1')).not.toContain('the quiet part');
        expect(isOurEnvelope(bytes)).toBe(true);

        expect(await provider.readFile(at(ROGUE), 'utf-8')).toBe('the quiet part');
    });

    test('and the same is true when the account also holds genuine legacy plaintext', async () => {
        // The mixed case, so that "there is nothing legacy here" cannot be why it passes.
        plantLegacyFile('chats/Test Character 1/legacy.jsonl', 'plain\n');
        await provider.writeFile(at(ROGUE), 'still ours');

        expect(fs.readFileSync(at(ROGUE)).toString('latin1')).not.toContain('still ours');
        expect(await provider.readFile(at('chats', 'Test Character 1', 'legacy.jsonl'), 'utf-8')).toBe('plain\n');
    });
});

// -------------------------------------------------------------------------------------------------
// §8 — what happens to a chat that is copied, renamed, or branched
// -------------------------------------------------------------------------------------------------

describe('🔀 derived chats (§8)', () => {
    beforeEach(async () => {
        plantLegacyFile('chats/Test Character 1/legacy.jsonl', 'plain\n');
        await provider.unlock(HANDLE, PASSWORD);
    });

    test('🔴 renaming a legacy chat does NOT convert it — §8 row 4', () => {
        // A rename is `copyFile` + `unlink` in the fork (`src/endpoints/chats.js:590`), so this is the one
        // derived operation where the source is in our hands when the destination's state is decided.
        // Classify the target on its own and the least suspicious command in the product silently makes a
        // chat depend on a plugin it never needed.
        provider.copyFile(at('chats', 'Test Character 1', 'legacy.jsonl'), at('chats', 'Test Character 1', 'renamed.jsonl'));
        provider.unlink(at('chats', 'Test Character 1', 'legacy.jsonl'));

        expect(fs.readFileSync(at('chats', 'Test Character 1', 'renamed.jsonl'), 'utf-8')).toBe('plain\n');
        expect(provider.encryptsPath(at('chats', 'Test Character 1', 'renamed.jsonl'))).toBe(false);
        expect(provider.readdir(at('chats', 'Test Character 1'))).toEqual(['renamed.jsonl']);
    });

    test('renaming an ENCRYPTED chat does not convert it either', async () => {
        await provider.writeFile(at('chats', 'Test Character 1', 'fresh.jsonl'), 'secret\n');
        provider.copyFile(at('chats', 'Test Character 1', 'fresh.jsonl'), at('chats', 'Test Character 1', 'moved.jsonl'));
        provider.unlink(at('chats', 'Test Character 1', 'fresh.jsonl'));

        expect(await provider.readFile(at('chats', 'Test Character 1', 'moved.jsonl'), 'utf-8')).toBe('secret\n');
        expect(provider.encryptsPath(at('chats', 'Test Character 1', 'moved.jsonl'))).toBe(true);
    });

    test('🔴 §8 row 2: a branch of a plaintext chat is encrypted', async () => {
        // A branch is a separate chat, and it is a new one. `createBranch` ends at a plain POST
        // /api/chats/save under a name that does not exist yet, so the provider simply applies its default.
        await provider.writeFile(at('chats', 'Test Character 1', 'legacy - branch.jsonl'), 'plain\n');
        expect(provider.encryptsPath(at('chats', 'Test Character 1', 'legacy - branch.jsonl'))).toBe(true);
    });

    test('🔴 §9.1: the BACKUP of a legacy plaintext chat is ENCRYPTED, on purpose', async () => {
        // A decision, not a gap. `backupChat` (`src/endpoints/chats.js:43`) writes a brand-new
        // `chat_<char>_<timestamp>.jsonl` on every save — `tryWriteFileSync`, not a copy — so it takes the
        // provider's default, which is encryption. The live plaintext chat is untouched and stays readable
        // with no plugin at all; only its post-install backup tail needs one.
        //
        // Pin this behavior because a switch from a new write to `copyFile` would inherit plaintext state.
        await provider.writeFileSync(at('backups', 'chat_test_character_1_20260720-120000.jsonl'), 'plain\n');

        expect(provider.encryptsPath(at('backups', 'chat_test_character_1_20260720-120000.jsonl'))).toBe(true);
        expect(fs.readFileSync(path.join(dataRoot, HANDLE, onDisk().find(f => f.startsWith('backups/'))), 'latin1'))
            .not.toContain('plain');
    });

    test('🔴 a copy from OUTSIDE the data root is encrypted — default content must not seed in the clear', () => {
        // The bug this test exists for: "not encrypted by us" was being read as "legacy", and every path
        // outside the data root satisfies it. `checkForNewContent` seeds a new account by copying out of the
        // fork's own `default/content/`, so every seeded world, preset and sample character landed
        // unencrypted in the user's directory on the very first login, with nothing failing anywhere.
        const outside = path.join(dataRoot, 'default-content.json');
        fs.writeFileSync(outside, '{"entries":{"secret":"Sample Setting 1"}}');

        provider.copyFile(outside, at('worlds', 'Sample Setting 1.json'));

        expect(provider.encryptsPath(at('worlds', 'Sample Setting 1.json'))).toBe(true);
        expect(fs.readFileSync(path.join(dataRoot, HANDLE, onDisk().find(f => f.startsWith('worlds/'))), 'latin1'))
            .not.toContain('Sample Setting 1');
    });
});

// -------------------------------------------------------------------------------------------------
// §11 — what an uninstall looks like, which is the property the whole design is for
// -------------------------------------------------------------------------------------------------

describe('🔀 uninstall and reinstall (§11)', () => {
    test('🔴 §12 steps 9 and 10: the plaintext half survives, the encrypted half comes back', async () => {
        plantLegacyFile('chats/Test Character 1/legacy.jsonl', 'plain\n');

        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('chats', 'Test Character 1', 'fresh.jsonl'), 'secret\n');

        // "Uninstall": the plugin is gone, so nothing decodes anything. The legacy chat is exactly where it
        // was, under its own name, readable by anything that can read a file.
        expect(fs.readFileSync(at('chats', 'Test Character 1', 'legacy.jsonl'), 'utf-8')).toBe('plain\n');

        // And the encrypted one is still THERE and still says what it needs — read with no plugin, no key,
        // and no decryption, which is the whole reason the envelope is a public grammar (§3.1).
        const marked = onDisk().find(f => isMarkedName(path.basename(f)));
        expect(parseEnvelope(fs.readFileSync(path.join(dataRoot, HANDLE, marked))).providerId).toBe('vault');

        // "Reinstall": the keys never left the data directory, so the same password opens everything again.
        session.closeAll(vault);
        forgetNameSchemes(vault);
        const reinstalled = createProvider(vault);
        reinstalled.init({
            dataRoot,
            accountsEnabled: true,
            basicAuthMode: false,
            authenticationDelegated: false,
            users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
        });

        await reinstalled.unlock(HANDLE, PASSWORD);
        expect(await reinstalled.readFile(at('chats', 'Test Character 1', 'fresh.jsonl'), 'utf-8')).toBe('secret\n');
        expect(await reinstalled.readFile(at('chats', 'Test Character 1', 'legacy.jsonl'), 'utf-8')).toBe('plain\n');
    });
});

// -------------------------------------------------------------------------------------------------
// The words. §6.2: the fork has none of its own, so an unanswered situation draws nothing.
// -------------------------------------------------------------------------------------------------

describe('🔀 the strings the fork cannot write for itself', () => {
    test('storage.chatMarker says "at rest", and does not overpromise', () => {
        const marker = provider.describe('storage.chatMarker');

        expect(marker.body).toBe('This chat is encrypted at rest.');

        // 🔴 "Nobody can read it" would be FALSE while the vault is open — the server reads it fine, which
        // is how the user is reading it. A padlock that overpromises teaches somebody to treat an unlocked
        // session on a shared machine as safe.
        expect(marker.body).not.toMatch(/nobody|no one|cannot be read/i);

        // And it is about THIS CHAT, because the row beside it in a mixed account is plaintext.
        expect(marker.body).toMatch(/this chat/i);
    });

    test('storage.identity is answerable, and every field is the shape the fork validates', () => {
        const identity = provider.describe('storage.identity');

        expect(identity.id).toMatch(/^[a-z0-9-]{1,32}$/);
        expect(typeof identity.name).toBe('string');
        expect(typeof identity.source).toBe('string');
        expect(identity.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(identity.envelopeVersions).toEqual([ENVELOPE_VERSION]);
    });

    test('the version is read from the manifest, not typed out twice', async () => {
        const manifest = JSON.parse(await fs.promises.readFile(new URL('../package.json', import.meta.url), 'utf-8'));
        expect(provider.describe('storage.identity').version).toBe(manifest.version);
    });

    test('an unknown situation is still nothing, not a throw', () => {
        expect(provider.describe('storage.somethingTheForkInventedLater')).toBeNull();
    });
});
