import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

import createProvider from '../src/index.js';
import * as session from '../src/session.js';
import { STRUCTURAL_DIRECTORIES } from '../src/paths.js';
import { ENVELOPE_HEADER_BYTES } from '../src/envelope.js';
import { NAME_SCHEME_MIXED } from '../src/crypto/name-cipher.js';
import { resetForeignStores } from '../src/foreign-stores.js';
import { forgetNameSchemes } from '../src/vault-store.js';
import { createVaultState } from '../src/vault-state.js';

jest.setTimeout(180_000);

const HANDLE = 'default-user';
const PASSWORD = 'correct horse battery staple';

/** @type {string} */
let dataRoot;
/** @type {any} */
let provider;

/**
 * The absolute logical path of something in the user's directory.
 * @param {...string} parts Path parts
 * @returns {string} Absolute logical path
 */
function at(...parts) {
    return path.join(dataRoot, HANDLE, ...parts);
}

/**
 * Everything actually on the disk under the user's directory, as relative paths.
 * @returns {string[]} What is really there
 */
function whatIsReallyOnDisk() {
    const root = path.join(dataRoot, HANDLE);
    /** @type {string[]} */
    const found = [];

    /**
     * @param {string} directory Where to look
     * @param {string} prefix Reporting prefix
     * @returns {void}
     */
    function walk(directory, prefix) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

            if (entry.isDirectory()) {
                walk(path.join(directory, entry.name), relative);
            } else {
                found.push(relative);
            }
        }
    }

    walk(root, '');
    return found;
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
beforeEach(async () => {
    vault = createVaultState();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-'));
    fs.mkdirSync(path.join(dataRoot, HANDLE), { recursive: true });
    session.closeAll(vault);

    provider = createProvider(vault);
    await provider.init({
        dataRoot,
        accountsEnabled: true,
        basicAuthMode: false,
        authenticationDelegated: false,
        users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
    });
});

afterEach(() => {
    session.closeAll(vault);
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * 🔴 THE POINT OF THE ENTIRE PROJECT, IN ONE SUITE.
 *
 * Everything else — the fork, the funnel, the gates, the key lifecycle — exists so that this is true:
 * what SillyTavern reads and writes is the truth, and what is on the disk is noise.
 */
describe('🔴 what is on the disk', () => {
    test('🔴 THE CONTENT IS NOT THERE. Not the message, not the character, not the title.', async () => {
        await provider.unlock(HANDLE, PASSWORD);

        provider.mkdir(at('chats', 'Test Character 1'), { recursive: true });
        await provider.writeFile(
            at('chats', 'Test Character 1', 'a quiet evening.jsonl'),
            '{"name":"Test Character 1","mes":"I have been waiting for you."}\n',
        );

        // Read every byte on the disk and go looking for the secrets.
        const everything = whatIsReallyOnDisk()
            .map(relative => fs.readFileSync(path.join(dataRoot, HANDLE, relative)).toString('latin1'))
            .join('\n');

        expect(everything).not.toContain('Test Character 1');
        expect(everything).not.toContain('I have been waiting for you');
        expect(everything).not.toContain('mes');
    });

    test('🔴 AND NEITHER ARE THE NAMES. The chat LIST is a secret too.', async () => {
        await provider.unlock(HANDLE, PASSWORD);

        provider.mkdir(at('chats', 'Test Character 1'), { recursive: true });
        await provider.writeFile(at('chats', 'Test Character 1', 'a quiet evening.jsonl'), 'x');
        await provider.writeFile(at('characters', 'Test Character 1.png'), 'x');

        // Encrypting contents and leaving names alone would be close to pointless: the path
        // `chats/<who>/<what>.jsonl` puts the name of everyone you talk to, and the title of every
        // conversation you have ever had, in the clear. `characters/` would be a directory listing of
        // somebody's inner life.
        const names = whatIsReallyOnDisk().join('\n');

        expect(names).not.toContain('Test Character 1');
        expect(names).not.toContain('a quiet evening');

        // The skeleton, though, is readable -- and has to be, because SillyTavern builds it at boot while
        // every vault is still shut. It gives nothing away: that SillyTavern is installed was never a
        // secret.
        expect(names).toContain('chats/');
        expect(names).toContain('characters/');
    });

    test('🔴 the ciphertext is not the plaintext, even for a one-byte file', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('worlds', 'x.json'), 'a');

        const onDisk = whatIsReallyOnDisk().filter(f => f.startsWith('worlds/'));
        expect(onDisk).toHaveLength(1);

        const bytes = fs.readFileSync(path.join(dataRoot, HANDLE, onDisk[0]));

        // A 16-byte header, then the block, then a 16-byte GCM tag. Never one byte.
        expect(bytes.length).toBeGreaterThan(1);

        // 🔀 The public envelope comes first, then the content cipher's own header. The outer one is the
        // only part a stranger is meant to read, and it is what lets the fork say "this chat requires the
        // 'vault' storage provider" with no plugin loaded — see `envelope.js`.
        expect(bytes.subarray(0, ENVELOPE_HEADER_BYTES).toString('ascii')).toBe('stenv:1:vault:');
        expect(bytes.subarray(ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + 4).toString('ascii')).toBe('STV1');
    });
});

describe('the round trip', () => {
    beforeEach(async () => {
        await provider.unlock(HANDLE, PASSWORD);
    });

    test('a file written comes back identical', async () => {
        const content = '{"chat":"hello"}\n{"chat":"world"}\n';

        provider.mkdir(at('chats', 'Test User'), { recursive: true });
        await provider.writeFile(at('chats', 'Test User', 'c.jsonl'), content);

        expect(await provider.readFile(at('chats', 'Test User', 'c.jsonl'), 'utf-8')).toBe(content);
    });

    test('⚠️ an encoding means what it says — utf-8 returns a STRING, not a Buffer', async () => {
        // A caller that gets a Buffer where it expected a string usually does not crash. It quietly does
        // the wrong thing, like writing "[object Object]" into a settings file.
        await provider.writeFile(at('worlds', 'w.json'), '{"a":1}');

        expect(typeof await provider.readFile(at('worlds', 'w.json'), 'utf-8')).toBe('string');
        expect(Buffer.isBuffer(await provider.readFile(at('worlds', 'w.json')))).toBe(true);
        expect(Buffer.isBuffer(provider.readFileSync(at('worlds', 'w.json')))).toBe(true);
    });

    test('⚠️ base64 means DECODE — the bytes are the image, not the base64 text', async () => {
        // `writeFile(p, data, 'base64')` means "data is a base64 STRING; decode it and store the bytes".
        // A provider that ignores it encrypts the base64 TEXT instead of the PNG, and the file comes back
        // as gibberish that is, infuriatingly, exactly the right length.
        const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xDE, 0xAD, 0xBE, 0xEF]);

        await provider.writeFile(at('characters', 'x.png'), png.toString('base64'), 'base64');

        const back = await provider.readFile(at('characters', 'x.png'));
        expect(Buffer.isBuffer(back)).toBe(true);
        expect(back.equals(png)).toBe(true);
    });

    test('binary survives — every byte value', async () => {
        const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

        await provider.writeFile(at('backgrounds', 'b.bin'), all);
        expect((await provider.readFile(at('backgrounds', 'b.bin'))).equals(all)).toBe(true);
    });

    test('a file bigger than one block survives', async () => {
        // The cipher works in 64 KiB blocks with a per-block tag. Off-by-one errors at the block boundary
        // are the classic bug and they only show up above 64 KiB.
        const big = Buffer.alloc(200_000);
        for (let i = 0; i < big.length; i++) {
            big[i] = i % 251;
        }

        await provider.writeFile(at('backgrounds', 'big.bin'), big);
        expect((await provider.readFile(at('backgrounds', 'big.bin'))).equals(big)).toBe(true);
    });

    test('the sync path agrees with the async one', async () => {
        provider.writeFileSync(at('worlds', 's.json'), 'sync');
        expect(await provider.readFile(at('worlds', 's.json'), 'utf-8')).toBe('sync');

        await provider.writeFile(at('worlds', 'a.json'), 'async');
        expect(provider.readFileSync(at('worlds', 'a.json'), 'utf-8')).toBe('async');
    });
});

describe('🔴 stat and readdir: the two that break HTTP if they lie', () => {
    beforeEach(async () => {
        await provider.unlock(HANDLE, PASSWORD);
    });

    test('🔴 stat().size is the LOGICAL size — it becomes Content-Length', async () => {
        // Report the on-disk size and every HTTP response either truncates or hangs forever, waiting for
        // bytes that do not exist.
        const content = Buffer.alloc(5000, 0x41);
        await provider.writeFile(at('backgrounds', 'bg.png'), content);

        expect(provider.stat(at('backgrounds', 'bg.png')).size).toBe(5000);

        // And the file on the disk really IS bigger, so this is not a no-op.
        const physical = whatIsReallyOnDisk().find(f => f.startsWith('backgrounds/'));
        expect(fs.statSync(path.join(dataRoot, HANDLE, physical)).size).toBeGreaterThan(5000);
    });

    test('stat still answers isDirectory() and mtime', async () => {
        provider.mkdir(at('chats', 'Bob'), { recursive: true });

        const stats = provider.stat(at('chats', 'Bob'));
        expect(stats.isDirectory()).toBe(true);

        await provider.writeFile(at('chats', 'Bob', 'c.jsonl'), 'x');
        const fileStats = provider.stat(at('chats', 'Bob', 'c.jsonl'));
        expect(fileStats.isFile()).toBe(true);
        expect(fileStats.mtimeMs).toBeGreaterThan(0);
    });

    test('🔴 readdir returns LOGICAL names', async () => {
        provider.mkdir(at('chats', 'Test Character 1'), { recursive: true });
        await provider.writeFile(at('chats', 'Test Character 1', 'a quiet evening.jsonl'), 'x');
        await provider.writeFile(at('chats', 'Test Character 1', 'another one.jsonl'), 'x');

        const names = provider.readdir(at('chats', 'Test Character 1'));
        expect(names.sort()).toEqual(['a quiet evening.jsonl', 'another one.jsonl']);

        expect(provider.readdir(at('chats'))).toEqual(['Test Character 1']);
    });

    test('🔴 a stray file NOBODY can decode does not take the whole listing with it', async () => {
        // 🔴 THIS WAS A 500 ON THE ENTIRE CHAT LIST, PERMANENTLY, FROM ONE FILE.
        //
        // `decodeName` throws for any name it cannot account for, and `readdir` mapped it over every entry
        // with no per-entry guard -- so one undecodable name failed the whole call, and failed it with a bare
        // `Error` rather than a `StorageError`, which means `isStorageError()` is false and the fork's
        // fail-safe re-throws do not fire.
        //
        // The trigger is mundane, which is the point. Windows drops `Thumbs.db` and `desktop.ini` into
        // directories on its own; macOS drops `.DS_Store`; editors leave swap files; and a crashed atomic
        // write used to leave a `.tmp-<pid>`. Any one of them, in a scheme-1 account -- the host's live install,
        // and scheme 1 is kept "for ever" -- and the user's chats are unreachable until somebody SSHes in.
        provider.mkdir(at('chats', 'Test Character 1'), { recursive: true });
        await provider.writeFile(at('chats', 'Test Character 1', 'a quiet evening.jsonl'), 'hello');

        // Straight onto the disk, behind the provider's back, exactly as a partial restore would leave it.
        // A MARKED name whose ciphertext is not ciphertext: it claims to be ours, so every scheme routes it
        // to `decryptName`, and SIV rejects it. (An UNMARKED stray is only fatal under scheme 1, where an
        // unrecognised name has nowhere to go; under scheme 2 it is correctly passed through as legacy.)
        const chatsDirectory = path.join(dataRoot, HANDLE, 'chats');
        const [encryptedSeraphina] = fs.readdirSync(chatsDirectory);
        const physical = path.join(chatsDirectory, encryptedSeraphina);
        fs.writeFileSync(path.join(physical, 'venc1~thisisnotciphertext.jsonl'), 'truncated by a bad restore');

        const names = provider.readdir(at('chats', 'Test Character 1'));

        // The real chat is still listed...
        expect(names).toContain('a quiet evening.jsonl');
        // ...and the intruder is skipped rather than returned raw, which would hand SillyTavern a name it
        // would then try to open.
        expect(names).not.toContain('venc1~thisisnotciphertext.jsonl');

        // And it is still READABLE through the provider -- the guard must not have broken the happy path.
        expect(await provider.readFile(at('chats', 'Test Character 1', 'a quiet evening.jsonl'), 'utf-8')).toBe('hello');
    });

    test('🔴 readdir honours withFileTypes — SillyTavern uses that form in 38 places', async () => {
        provider.mkdir(at('chats', 'Test Character 1'), { recursive: true });
        await provider.writeFile(at('chats', 'Test Character 1', 'c.jsonl'), 'x');

        const entries = provider.readdir(at('chats'), { withFileTypes: true });
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe('Test Character 1');
        expect(entries[0].isDirectory()).toBe(true);
        expect(entries[0].isFile()).toBe(false);

        const files = provider.readdir(at('chats', 'Test Character 1'), { withFileTypes: true });
        expect(files[0].name).toBe('c.jsonl');
        expect(files[0].isFile()).toBe(true);
    });
});

describe('🔴 the long-name fallback, end to end', () => {
    beforeEach(async () => {
        await provider.unlock(HANDLE, PASSWORD);
    });

    // Encryption plus base64url inflates a name ~1.4x against a hard 255-byte limit, and SillyTavern builds
    // chat filenames as `<character name> - <timestamp>.jsonl`. A character with a long name does not
    // produce an edge case; it produces Tuesday.
    const ABSURD = 'Test Character 1 the Sample Archive Guardian of the Sample Woodland and Keeper of the Seventh Seal - 2026-07-13@04h20m00s000ms.jsonl';

    test('🔴 an absurd chat name round-trips, through a real directory', async () => {
        provider.mkdir(at('chats', 'Test Character 1'), { recursive: true });
        await provider.writeFile(at('chats', 'Test Character 1', ABSURD), 'the chat');

        expect(await provider.readFile(at('chats', 'Test Character 1', ABSURD), 'utf-8')).toBe('the chat');
        expect(provider.readdir(at('chats', 'Test Character 1'))).toEqual([ABSURD]);
    });

    test('🔴 the companion file is INVISIBLE to SillyTavern', async () => {
        // If a `.nm` sidecar leaked into a directory listing, SillyTavern would try to parse it as a chat --
        // and data-maid would report it as an orphan and offer to delete it. Deleting a sidecar loses the
        // name of the file it belongs to, permanently.
        provider.mkdir(at('chats', 'Test Character 1'), { recursive: true });
        await provider.writeFile(at('chats', 'Test Character 1', ABSURD), 'x');

        // It really is there, on the disk...
        const real = whatIsReallyOnDisk().filter(f => f.endsWith('.nm'));
        expect(real).toHaveLength(1);

        // ...and SillyTavern cannot see it.
        expect(provider.readdir(at('chats', 'Test Character 1'))).toEqual([ABSURD]);
        expect(provider.readdir(at('chats', 'Test Character 1'), { withFileTypes: true })).toHaveLength(1);
    });

    test('a long DIRECTORY name works too — a character with a long name', async () => {
        const longCharacter = 'Test Character 1 the Sample Archive Guardian of the Sample Woodland and Keeper of the Seventh Seal and Bearer of the Lantern';

        provider.mkdir(at('chats', longCharacter), { recursive: true });
        await provider.writeFile(at('chats', longCharacter, 'c.jsonl'), 'x');

        expect(provider.readdir(at('chats'))).toEqual([longCharacter]);
        expect(await provider.readFile(at('chats', longCharacter, 'c.jsonl'), 'utf-8')).toBe('x');
    });
});

describe('🔴 locked: the fail-safe contract', () => {
    test('🔴 reading while locked throws EUNAVAILABLE — it does NOT say "not found"', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('worlds', 'w.json'), 'secret');
        provider.lock(HANDLE);

        // ENOENT means "there is nothing here, go ahead and create it". EUNAVAILABLE means "there is
        // something here and I cannot read it". SillyTavern has six code paths that respond to the first by
        // deleting and regenerating. Confusing them destroys the data.
        await expect(provider.readFile(at('worlds', 'w.json'))).rejects.toMatchObject({ code: 'EUNAVAILABLE' });
        expect(() => provider.readFileSync(at('worlds', 'w.json'))).toThrow(expect.objectContaining({ code: 'EUNAVAILABLE' }));
        expect(() => provider.readdir(at('worlds'))).toThrow(expect.objectContaining({ code: 'EUNAVAILABLE' }));
    });

    test('🔴 exists() while locked THROWS — it does not return false', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('worlds', 'w.json'), 'secret');
        provider.lock(HANDLE);

        // A `false` here is an invitation to create the file from scratch, over the top of the real one.
        expect(() => provider.exists(at('worlds', 'w.json'))).toThrow(expect.objectContaining({ code: 'EUNAVAILABLE' }));
    });

    test('🔴 writing while locked throws, and writes NOTHING', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        provider.lock(HANDLE);

        await expect(provider.writeFile(at('worlds', 'w.json'), 'x')).rejects.toMatchObject({ code: 'EUNAVAILABLE' });
        expect(fs.existsSync(path.join(dataRoot, HANDLE, 'worlds'))).toBe(false);
    });

    test('🔑 the SKELETON can still be built while locked — this is why it stays plaintext', () => {
        // `ensurePublicDirectoriesExist` runs mkdir across every user's tree at boot, before anyone has
        // logged in. If the skeleton needed a key, SillyTavern could not boot.
        expect(() => provider.mkdir(at('chats'), { recursive: true })).not.toThrow();
        expect(() => provider.mkdir(at('user', 'images'), { recursive: true })).not.toThrow();
        expect(() => provider.mkdir(at('thumbnails', 'bg'), { recursive: true })).not.toThrow();

        expect(fs.existsSync(path.join(dataRoot, HANDLE, 'chats'))).toBe(true);
        expect(fs.existsSync(path.join(dataRoot, HANDLE, 'user', 'images'))).toBe(true);
    });

    test('🔴🔴 rm -r ON A SKELETON DIRECTORY WHILE LOCKED DOES NOT DELETE THE CHATS', async () => {
        // THE ONE THAT NEARLY GOT AWAY, and the single most dangerous bug found in this project so far.
        //
        // `chats/` is skeleton, so it resolves with no key. `rm('<U>/chats', {recursive:true})` therefore
        // used to SUCCEED while the vault was shut — and delete every chat the user had ever had. The whole
        // premise of the boot gate is that SillyTavern must destroy nothing it cannot read, and here was
        // the provider itself, cheerfully obliging.
        //
        // It got through because the carve-out that lets `mkdir chats/` work at boot (which SillyTavern
        // genuinely needs) also let `rm chats/` work. Creating the skeleton without a key is fine.
        // Destroying its contents without a key is not.
        await provider.unlock(HANDLE, PASSWORD);
        provider.mkdir(at('chats', 'Test Character 1'), { recursive: true });
        await provider.writeFile(at('chats', 'Test Character 1', 'irreplaceable.jsonl'), 'the only copy');
        provider.lock(HANDLE);

        expect(() => provider.rm(at('chats'), { recursive: true, force: true }))
            .toThrow(expect.objectContaining({ code: 'EUNAVAILABLE' }));

        // And the proof that actually matters: it is still there, and it still reads back.
        await provider.unlock(HANDLE, PASSWORD);
        expect(await provider.readFile(at('chats', 'Test Character 1', 'irreplaceable.jsonl'), 'utf-8')).toBe('the only copy');
    });

    test('deleting a WHOLE ACCOUNT is still allowed while locked — that one is on purpose', async () => {
        // An admin removing a user is destroying the account deliberately, and there is nothing left to
        // protect. It is deleting something INSIDE a locked account that is the accident.
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('worlds', 'w.json'), 'x');
        provider.lock(HANDLE);

        expect(() => provider.rm(at(), { recursive: true, force: true })).not.toThrow();
        expect(fs.existsSync(path.join(dataRoot, HANDLE))).toBe(false);
    });

    test('🔑 the vault-keys file is readable while locked — it is what you unlock WITH', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        provider.lock(HANDLE);

        const keys = await provider.readFile(at('.vault-keys.json'), 'utf-8');

        // Version 2 is a mixed-mode-capable vault; `nameScheme` is the field that means something and the
        // version bump is what stops an older build reading the file and getting it wrong. See
        // `crypto/vault.js`. What this test is actually about is that the file came back AT ALL while
        // locked — it is what you unlock with, so it can never need the key it contains.
        expect(JSON.parse(keys).version).toBe(2);
        expect(JSON.parse(keys).nameScheme).toBe(NAME_SCHEME_MIXED);
    });

    test('🔴 a file we cannot DECRYPT throws EPROVIDER, not ENOENT', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at('worlds', 'w.json'), 'secret');

        // Corrupt it on the disk, the way a failing SSD or a bad restore would.
        const physical = whatIsReallyOnDisk().find(f => f.startsWith('worlds/'));
        const full = path.join(dataRoot, HANDLE, physical);
        const bytes = fs.readFileSync(full);
        bytes[bytes.length - 1] ^= 0xFF;
        fs.writeFileSync(full, bytes);

        await expect(provider.readFile(at('worlds', 'w.json'))).rejects.toMatchObject({ code: 'EPROVIDER' });

        // And the file is STILL THERE. We refused to read it; we did not tidy it away.
        expect(fs.existsSync(full)).toBe(true);
    });
});

describe('the rest of the interface', () => {
    beforeEach(async () => {
        await provider.unlock(HANDLE, PASSWORD);
    });

    test('rename moves a file and it is still readable', async () => {
        provider.mkdir(at('chats', 'Test User'), { recursive: true });
        await provider.writeFile(at('chats', 'Test User', 'old.jsonl'), 'content');

        provider.rename(at('chats', 'Test User', 'old.jsonl'), at('chats', 'Test User', 'new.jsonl'));

        expect(provider.readdir(at('chats', 'Test User'))).toEqual(['new.jsonl']);
        expect(await provider.readFile(at('chats', 'Test User', 'new.jsonl'), 'utf-8')).toBe('content');
    });

    test('🔴 copyFile ACROSS DIRECTORIES works — a byte copy would not', async () => {
        // The parent directory is bound into the ciphertext of the NAME. A copy that just moved the bytes
        // would produce a file whose name decrypts under the wrong parent. It happens to work within one
        // directory, which is exactly how this bug would hide.
        provider.mkdir(at('chats', 'Test User'), { recursive: true });
        provider.mkdir(at('chats', 'Bob'), { recursive: true });
        await provider.writeFile(at('chats', 'Test User', 'c.jsonl'), 'shared');

        provider.copyFile(at('chats', 'Test User', 'c.jsonl'), at('chats', 'Bob', 'c.jsonl'));

        expect(await provider.readFile(at('chats', 'Bob', 'c.jsonl'), 'utf-8')).toBe('shared');
        expect(provider.readdir(at('chats', 'Bob'))).toEqual(['c.jsonl']);
    });

    test('cp copies a whole tree', async () => {
        provider.mkdir(at('chats', 'Test User'), { recursive: true });
        await provider.writeFile(at('chats', 'Test User', 'one.jsonl'), '1');
        await provider.writeFile(at('chats', 'Test User', 'two.jsonl'), '2');

        provider.cp(at('chats', 'Test User'), at('chats', 'Clone'), { recursive: true });

        expect(provider.readdir(at('chats', 'Clone')).sort()).toEqual(['one.jsonl', 'two.jsonl']);
        expect(await provider.readFile(at('chats', 'Clone', 'two.jsonl'), 'utf-8')).toBe('2');
    });

    test('unlink removes a file, and its companion file with it', async () => {
        const long = 'a'.repeat(200) + '.jsonl';

        provider.mkdir(at('chats', 'Test User'), { recursive: true });
        await provider.writeFile(at('chats', 'Test User', long), 'x');
        expect(whatIsReallyOnDisk().filter(f => f.endsWith('.nm'))).toHaveLength(1);

        provider.unlink(at('chats', 'Test User', long));

        expect(provider.readdir(at('chats', 'Test User'))).toEqual([]);
        expect(whatIsReallyOnDisk().filter(f => f.endsWith('.nm'))).toHaveLength(0);
    });

    test('rm -r removes a directory', async () => {
        provider.mkdir(at('chats', 'Test User'), { recursive: true });
        await provider.writeFile(at('chats', 'Test User', 'c.jsonl'), 'x');

        provider.rm(at('chats', 'Test User'), { recursive: true, force: true });

        expect(provider.readdir(at('chats'))).toEqual([]);
    });

    test('createReadStream honours a RANGE — browsers seek into audio and video', async () => {
        const content = Buffer.from('0123456789abcdefghij');
        await provider.writeFile(at('user', 'files', 'a.bin'), content);

        const stream = provider.createReadStream(at('user', 'files', 'a.bin'), { start: 5, end: 9 });
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }

        expect(Buffer.concat(chunks).toString()).toBe('56789');
    });

    test('createReadStream with no range gives the whole file', async () => {
        await provider.writeFile(at('user', 'files', 'b.bin'), 'the whole thing');

        const chunks = [];
        for await (const chunk of provider.createReadStream(at('user', 'files', 'b.bin'))) {
            chunks.push(chunk);
        }

        expect(Buffer.concat(chunks).toString()).toBe('the whole thing');
    });

    test('createWriteStream encrypts what is piped into it', async () => {
        await new Promise((done, fail) => {
            const stream = provider.createWriteStream(at('user', 'files', 'c.bin'));
            stream.on('finish', done);
            stream.on('error', fail);
            stream.write('hello ');
            stream.write('world');
            stream.end();
        });

        expect(await provider.readFile(at('user', 'files', 'c.bin'), 'utf-8')).toBe('hello world');

        const physical = whatIsReallyOnDisk().find(f => f.startsWith('user/files/'));
        expect(fs.readFileSync(path.join(dataRoot, HANDLE, physical)).toString('latin1')).not.toContain('hello world');
    });

    test('owns() is true for user data and false for SillyTavern\'s own directories', () => {
        expect(provider.owns(at('chats', 'x'))).toBe(true);
        expect(provider.owns(path.join(dataRoot, '_storage', 'anything'))).toBe(false);
        expect(provider.owns(path.join(dataRoot, '_uploads', 'x'))).toBe(false);
    });

    test('a path outside the data root is not ours, and passes straight through', async () => {
        const outside = path.join(dataRoot, '_storage');
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(outside, 'plain.json'), 'not encrypted');

        expect(provider.owns(path.join(outside, 'plain.json'))).toBe(false);
        expect(await provider.readFile(path.join(outside, 'plain.json'), 'utf-8')).toBe('not encrypted');
    });
});

/**
 * Key material for other plugins. Vault does not know who calls this, and must not: it hands out a key for
 * a name, and what the caller keeps under it is the caller's business.
 */
describe('deriveSubkey: a key for another plugin', () => {
    test('an unlocked user gets exactly the bytes it asked for', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        const key = provider.deriveSubkey(HANDLE, 'mnemosyne-db-v1', 32);

        expect(Buffer.isBuffer(key)).toBe(true);
        expect(key.length).toBe(32);
    });

    test('a LOCKED user gets null, and NOT an exception — locked is normal, not an error', () => {
        // No unlock. This is every user, every morning, before they log in.
        expect(() => provider.deriveSubkey(HANDLE, 'mnemosyne-db-v1', 32)).not.toThrow();
        expect(provider.deriveSubkey(HANDLE, 'mnemosyne-db-v1', 32)).toBe(null);
    });

    test('an unknown handle gets null, and NOT an exception', () => {
        expect(() => provider.deriveSubkey('nobody', 'mnemosyne-db-v1', 32)).not.toThrow();
        expect(provider.deriveSubkey('nobody', 'mnemosyne-db-v1', 32)).toBe(null);
    });

    test('locking takes the key away again', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        expect(provider.deriveSubkey(HANDLE, 'mnemosyne-db-v1', 32)).not.toBe(null);

        provider.lock(HANDLE);
        expect(provider.deriveSubkey(HANDLE, 'mnemosyne-db-v1', 32)).toBe(null);
    });

    test('🔴 the SAME bytes across a lock/unlock cycle — or the caller\'s store is lost on every logout', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        const before = provider.deriveSubkey(HANDLE, 'mnemosyne-db-v1', 32);

        provider.lock(HANDLE);
        await provider.unlock(HANDLE, PASSWORD);
        const after = provider.deriveSubkey(HANDLE, 'mnemosyne-db-v1', 32);

        expect(after.equals(before)).toBe(true);
    });

    test('the label is honoured: two names, two keys', async () => {
        await provider.unlock(HANDLE, PASSWORD);

        const db = provider.deriveSubkey(HANDLE, 'mnemosyne-db-v1', 32);
        const other = provider.deriveSubkey(HANDLE, 'some-other-plugin-v1', 32);

        expect(db.equals(other)).toBe(false);
    });
});

describe('bytes in, the same bytes out — whatever shape they arrived in', () => {
    // An 8-byte PNG signature. Short, and every byte matters: `String(new Uint8Array(...))` turns it into
    // the 24-character text "137,80,78,71,13,10,26,10", which is a perfectly valid file of the wrong
    // length containing none of the original bytes.
    const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

    test('🔴 a Uint8Array is stored as BYTES, not as the text of its decimal digits', async () => {
        // The live path was POST /api/images/upload, which handed the provider `new Uint8Array(buffer)`.
        // `Buffer.isBuffer` is false for that, so it fell through to `String(data)` and the upload was
        // silently not an image any more. On a no-provider install `write-file-atomic` takes a TypedArray
        // natively, so this broke ONLY on a vaulted install — the user got a 200 either way.
        await provider.unlock(HANDLE, PASSWORD);

        await provider.writeFile(at('user', 'images', 'p.png'), new Uint8Array(PNG_SIGNATURE));

        const back = await provider.readFile(at('user', 'images', 'p.png'));
        expect(Buffer.isBuffer(back)).toBe(true);
        expect([...back]).toEqual(PNG_SIGNATURE);
        expect(back.length).toBe(8);
    });

    test('a view over PART of a larger ArrayBuffer stores only its own window', async () => {
        // `Buffer.from(data.buffer, ...)` without the offset and length would take the whole backing
        // store — a different, longer file, and one that leaks whatever else shared the buffer.
        await provider.unlock(HANDLE, PASSWORD);

        const backing = new Uint8Array([0xff, 0xff, ...PNG_SIGNATURE, 0xff, 0xff]);
        const window = backing.subarray(2, 10);

        await provider.writeFile(at('user', 'images', 'w.png'), window);

        expect([...await provider.readFile(at('user', 'images', 'w.png'))]).toEqual(PNG_SIGNATURE);
    });

    test('a DataView is bytes too — node:fs takes one, so the contract says we do', async () => {
        await provider.unlock(HANDLE, PASSWORD);

        const view = new DataView(new Uint8Array(PNG_SIGNATURE).buffer);
        provider.writeFileSync(at('user', 'images', 'd.png'), view);

        expect([...provider.readFileSync(at('user', 'images', 'd.png'))]).toEqual(PNG_SIGNATURE);
    });

    test('a base64 string still means "decode this and store the bytes"', async () => {
        // The original bug this docblock warns about, pinned so the TypedArray fix does not undo it.
        await provider.unlock(HANDLE, PASSWORD);

        await provider.writeFile(at('user', 'images', 'b.png'), Buffer.from(PNG_SIGNATURE).toString('base64'), 'base64');

        expect([...await provider.readFile(at('user', 'images', 'b.png'))]).toEqual(PNG_SIGNATURE);
    });
});

describe('🔴 a foreign store\'s bytes pass straight through — locked or unlocked', () => {
    // A consumer that took a subkey and opened a SQLCipher database under the user's directory. Vault has no
    // relationship with any such plugin; this is a SHAPE, not a partner. See foreign-stores.js.
    const STORE = { directory: 'memory', owner: 'a-sqlcipher-plugin', forbidden: ['SQLite format 3\u0000'] };

    // 16 bytes of random salt and then sealed pages. No magic number, nothing to recognise it by — and, in
    // particular, no `stenv:` envelope and no `STV1` header, because we did not write it.
    const SQLCIPHER = Buffer.concat([Buffer.from('f1e2d3c4b5a69788c7d6e5f401928374', 'hex'), Buffer.from('sealed pages')]);

    /**
     * Put a file where such a store keeps one — with raw fs, exactly as its owner does. It holds its own
     * descriptor and never comes through this provider at all.
     * @returns {string} The absolute path it landed on
     */
    function plantStore() {
        const target = at('memory', 'store.db');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, SQLCIPHER);
        return target;
    }

    /**
     * Every file in the account, read through the provider for its LOGICAL bytes.
     *
     * This is the shape of the fork's `createBackupArchive`, and it is deliberately not `fs`: an archive of
     * raw ciphertext would be unrestorable, so a backup reads through the provider. That is what makes the
     * backup the first caller to touch every file in an account, and therefore the first to notice.
     * @param {string} directory Where to start
     * @returns {Record<string, Buffer>} Logical path → bytes
     */
    function backupWalk(directory) {
        /** @type {Record<string, Buffer>} */
        const archive = {};

        for (const entry of provider.readdir(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            Object.assign(archive, entry.isDirectory() ? backupWalk(full) : { [full]: provider.readFileSync(full) });
        }

        return archive;
    }

    /**
     * Turn this account's vault into the shape every vault had before mixed mode: version 1, no name scheme,
     * every name in it ours by construction. The DEK is untouched and the session stays open — only the
     * classification changes.
     * @returns {void}
     */
    function makeSchemeOne() {
        const keysPath = at('.vault-keys.json');
        const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));

        delete keys.nameScheme;
        delete keys.legacyData;
        keys.version = 1;

        fs.writeFileSync(keysPath, JSON.stringify(keys), 'utf-8');
        forgetNameSchemes(vault);
    }

    afterEach(() => {
        resetForeignStores(vault);
        forgetNameSchemes(vault);
    });

    test('🔴 UNLOCKED, its file reads back verbatim — this is the backup that died mid-stream', async () => {
        // The live symptom: `POST /api/users/backup` returned 200 and then the connection dropped part-way
        // through the archive, for every account that had a foreign store in it.
        //
        // The mechanism: while LOCKED, `resolve` has a branch that serves a name sitting in the clear. While
        // UNLOCKED there was none, so a foreign store's file — never encrypted by us, under a name we never
        // rewrote — went down the path that unwraps an envelope and decrypts, and there is no envelope on it.
        await provider.unlock(HANDLE, PASSWORD);
        provider.registerForeignStore(STORE);
        plantStore();

        expect(provider.readFileSync(at('memory', 'store.db')).equals(SQLCIPHER)).toBe(true);
        expect((await provider.readFile(at('memory', 'store.db'))).equals(SQLCIPHER)).toBe(true);
    });

    test('🔴 and the whole-account walk completes — backup, export, integrity check, migration', async () => {
        // Not only about backups. ANYTHING that walks a user's entire tree hits the same wall, and each of
        // them is a feature whose entire job is to touch every file exactly once.
        await provider.unlock(HANDLE, PASSWORD);
        provider.registerForeignStore(STORE);
        plantStore();
        await provider.writeFile(at('chats', 'Test Character 1', 'a quiet evening.jsonl'), 'I have been waiting for you.');

        const archive = backupWalk(at());

        expect(archive[at('memory', 'store.db')].equals(SQLCIPHER)).toBe(true);
        expect(archive[at('chats', 'Test Character 1', 'a quiet evening.jsonl')].toString()).toBe('I have been waiting for you.');
    });

    test('🔴 stat reports the size that is really there — it becomes Content-Length', async () => {
        // The envelope arithmetic subtracts a header these bytes do not carry, so the number comes out short
        // and entirely plausible. Every HTTP response for the file would then promise fewer bytes than it
        // sends, or more than exist, and nothing would throw.
        await provider.unlock(HANDLE, PASSWORD);
        provider.registerForeignStore(STORE);
        plantStore();

        expect(provider.stat(at('memory', 'store.db')).size).toBe(SQLCIPHER.length);
    });

    test('🔴 LOCKED, it reads back verbatim too — they are not ours in either state', async () => {
        // Their owner encrypted them and their owner restores them. Our lock is not what is protecting them,
        // and refusing them while shut would be a promise we are not the one keeping. It is the same
        // reasoning as §1's legacy files: a shut vault is a weaker version of an uninstalled one.
        await provider.unlock(HANDLE, PASSWORD);
        provider.registerForeignStore(STORE);
        plantStore();
        provider.lock(HANDLE);

        expect(provider.readFileSync(at('memory', 'store.db')).equals(SQLCIPHER)).toBe(true);
        expect(provider.stat(at('memory', 'store.db')).size).toBe(SQLCIPHER.length);
        expect(provider.readdir(at('memory'))).toEqual(['store.db']);
    });

    test('a write through the provider lands verbatim, and does NOT get a second layer', async () => {
        // Encrypting a foreign store's bytes would be encrypting an encryption — and worse, it would put
        // them behind a key its owner does not have, so the owner's own reads (which use raw fs) would get
        // ciphertext it cannot open.
        await provider.unlock(HANDLE, PASSWORD);
        provider.registerForeignStore(STORE);

        await provider.writeFile(at('memory', 'store.db'), SQLCIPHER);

        expect(fs.readFileSync(path.join(dataRoot, HANDLE, 'memory', 'store.db')).equals(SQLCIPHER)).toBe(true);
    });

    test('🔴 a copy OUT of the store into the account is encrypted — the exemption does not travel', async () => {
        // "Not encrypted by us" is not the same as "legacy", and conflating them writes user data in the
        // clear. A foreign file copied anywhere else is a NEW file in that account, and §8 says a new file
        // is encrypted.
        await provider.unlock(HANDLE, PASSWORD);
        provider.registerForeignStore(STORE);
        plantStore();

        provider.mkdir(at('user', 'files'), { recursive: true });
        provider.copyFile(at('memory', 'store.db'), at('user', 'files', 'copied.db'));

        const onDisk = whatIsReallyOnDisk().filter(f => f.startsWith('user/files/'));
        expect(onDisk).toHaveLength(1);
        expect(fs.readFileSync(path.join(dataRoot, HANDLE, onDisk[0])).equals(SQLCIPHER)).toBe(false);
        expect((await provider.readFile(at('user', 'files', 'copied.db'))).equals(SQLCIPHER)).toBe(true);
    });

    test('🔴 encryptsPath says false, locked and unlocked — the same answer to the same question', async () => {
        // It asks "did WE put these bytes in this state?", and the answer is no in both states. A capability
        // that changed its mind at the idle lock would be reporting on our key rather than on the file.
        await provider.unlock(HANDLE, PASSWORD);
        provider.registerForeignStore(STORE);
        plantStore();

        expect(provider.encryptsPath(at('memory', 'store.db'))).toBe(false);
        expect(provider.envelopeVersionAt(at('memory', 'store.db'))).toBe(null);

        provider.lock(HANDLE);

        expect(provider.encryptsPath(at('memory', 'store.db'))).toBe(false);
        expect(provider.envelopeVersionAt(at('memory', 'store.db'))).toBe(null);
    });

    test('🔴 and a directory NOBODY claimed is untouched by any of this', async () => {
        // The exemption is opt-in and reaches exactly what was claimed. An unregistered directory of the
        // same shape is still ours: its name is encrypted and its contents are sealed.
        await provider.unlock(HANDLE, PASSWORD);
        provider.registerForeignStore(STORE);

        await provider.writeFile(at('worlds', 'store.db'), SQLCIPHER);

        expect(whatIsReallyOnDisk()).not.toContain('worlds/store.db');
        expect(provider.encryptsPath(at('worlds', 'store.db'))).toBe(true);
    });

    test('🔴 in a SCHEME-1 account too — there is nothing "legacy" about a foreign store', async () => {
        // The passthrough rule this fixes was written as "mixed mode, and not ours", and a foreign store is
        // neither of those things. In a scheme-1 account every name is ours by construction — there is no
        // plaintext half and no clear-name branch to fall into — so nothing here is rescued by accident: the
        // bytes go straight into the content cipher, which has never seen them before.
        await provider.unlock(HANDLE, PASSWORD);
        provider.registerForeignStore(STORE);
        plantStore();
        makeSchemeOne();

        expect(provider.readFileSync(at('memory', 'store.db')).equals(SQLCIPHER)).toBe(true);
        expect(provider.stat(at('memory', 'store.db')).size).toBe(SQLCIPHER.length);
    });

    test('🔴 and it is the REGISTRATION that puts these bytes in our hands — not the disk layout', async () => {
        // Worth pinning, because it is counter-intuitive and it is why this bug was invisible for so long:
        // an UNCLAIMED `memory/store.db` in a mixed account already reads back fine, through an entirely
        // different mechanism — its name is sitting there in the clear, so `walk` classifies it as a file
        // that predates the vault and passes it through. Claiming the directory is what makes both of its
        // components ours-by-name, which is what routed the content into the cipher.
        //
        // So the two paths must agree, and only one of them is the one under test. If a future change makes
        // this test fail while the ones above still pass, the registered path has stopped mattering and
        // those tests have gone quietly vacuous.
        await provider.unlock(HANDLE, PASSWORD);
        plantStore();

        expect(provider.readFileSync(at('memory', 'store.db')).equals(SQLCIPHER)).toBe(true);

        provider.registerForeignStore(STORE);

        expect(provider.readFileSync(at('memory', 'store.db')).equals(SQLCIPHER)).toBe(true);
    });
});

describe('🔴 the key is unreachable without a guard, by construction', () => {
    // These eight methods dereferenced `at.keys.kContent` with no `requireKeys` call. They were safe, but
    // only by an accident of a different module: `resolve()` throws for any path with a non-structural
    // component, and every entry of STRUCTURAL_DIRECTORIES happens to be a DIRECTORY, so no fully-
    // structural path can name a FILE, so the locked case was unreachable.
    //
    // That is a load-bearing invariant held together by a coincidence in a set literal three files away.
    // These tests break the coincidence on purpose — add one file-shaped structural entry — and assert the
    // degradation is EUNAVAILABLE, which the fork's `isStorageError()` recognises and refuses to "repair",
    // rather than TypeError, which it does not.
    const ROGUE = 'a-structural-entry-that-names-a-file.txt';

    beforeEach(() => {
        STRUCTURAL_DIRECTORIES.add(ROGUE);
    });

    afterEach(() => {
        STRUCTURAL_DIRECTORIES.delete(ROGUE);
    });

    test('🔴 all eight give EUNAVAILABLE, and not one of them gives a TypeError', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at(ROGUE), 'x');
        provider.lock(HANDLE);

        const isRefusal = expect.objectContaining({ name: 'StorageError', code: 'EUNAVAILABLE' });

        await expect(provider.readFile(at(ROGUE))).rejects.toMatchObject({ code: 'EUNAVAILABLE' });
        await expect(provider.sendFile({}, at(ROGUE))).rejects.toMatchObject({ code: 'EUNAVAILABLE' });
        await expect(provider.writeFile(at(ROGUE), 'y')).rejects.toMatchObject({ code: 'EUNAVAILABLE' });

        expect(() => provider.readFileSync(at(ROGUE))).toThrow(isRefusal);
        expect(() => provider.createReadStream(at(ROGUE))).toThrow(isRefusal);
        expect(() => provider.writeFileSync(at(ROGUE), 'y')).toThrow(isRefusal);
        expect(() => provider.createWriteStream(at(ROGUE))).toThrow(isRefusal);
        expect(() => provider.copyFile(at(ROGUE), at(ROGUE + '.bak'))).toThrow(isRefusal);
    });

    test('and the file is still there afterwards, byte for byte', async () => {
        // The whole reason the error CLASS matters: a TypeError is not a StorageError, so none of the
        // fork's fail-safe re-throws fire and a regenerate-on-unreadable-data path is free to rewrite it.
        await provider.unlock(HANDLE, PASSWORD);
        await provider.writeFile(at(ROGUE), 'the only copy');
        provider.lock(HANDLE);

        await expect(provider.writeFile(at(ROGUE), 'clobbered')).rejects.toMatchObject({ code: 'EUNAVAILABLE' });

        await provider.unlock(HANDLE, PASSWORD);
        expect(await provider.readFile(at(ROGUE), 'utf-8')).toBe('the only copy');
    });
});

describe('🔴 path containment — the guard the whole product rests on, and it had NO test at all', () => {
    // `paths.split()` is what stops a caller reaching outside the account it named, and nothing anywhere
    // exercised it: `paths.js` is imported by three test files, for the STRUCTURAL_DIRECTORIES constant only.
    // Its 500 lines were covered incidentally through the provider and never once with hostile input.
    //
    // These pin the behaviour in BOTH directions, because "it throws" and "it silently reads another
    // account's file" are both consistent with a green suite that never asks.
    test('🔴 `..` cannot climb out of the account, however many times you write it', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        provider.mkdir(at('chats'), { recursive: true });
        await provider.writeFile(at('chats', 'mine.jsonl'), 'my own chat');

        // A sibling account, with a file that must stay unreachable from ours.
        const otherDir = path.join(dataRoot, 'someone-else', 'chats');
        fs.mkdirSync(otherDir, { recursive: true });
        fs.writeFileSync(path.join(otherDir, 'theirs.jsonl'), 'SOMEBODY ELSE PRIVATE CHAT');

        const escape = at('chats', '..', '..', 'someone-else', 'chats', 'theirs.jsonl');

        // Whatever it does, it must not hand us their bytes.
        let served = null;
        try {
            served = await provider.readFile(escape, 'utf-8');
        } catch {
            served = null;
        }

        expect(served).not.toBe('SOMEBODY ELSE PRIVATE CHAT');
    });

    test('🔴 an absolute path outside the data root is not served as ours', async () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
        const secret = path.join(outside, 'secret.txt');
        fs.writeFileSync(secret, 'NOT PART OF ANY VAULT');

        // `owns()` is the fork's routing question, and it is the only containment there is for a path that
        // is not under the data root at all. It must say no.
        expect(provider.owns(secret)).toBe(false);

        fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5 });
    });

    test('🔴 a null byte in a name never reaches the filesystem -- encryption neutralises it', async () => {
        await provider.unlock(HANDLE, PASSWORD);
        provider.mkdir(at('chats'), { recursive: true });

        // ⚠️ I expected this to be REFUSED and it is not, which turns out to be the better answer -- so the
        // test pins the REASON rather than my guess.
        //
        // The classic poisoned-null-byte attack works by getting `evil .jsonl` to a syscall that stops
        // reading at the NUL and opens `evil` instead. Here the logical name is ENCRYPTED before it is ever
        // a path, and AES-SIV output is rendered base64url -- an alphabet with no NUL in it -- so the byte is
        // DATA, not syntax, and there is nothing for a filesystem to truncate. The property that hides the
        // name removes the injection with it.
        await provider.writeFile(at('chats', 'evil'+' '+'.jsonl'), 'x');

        // Nothing on the disk carries the byte...
        for (const relative of whatIsReallyOnDisk()) {
            expect(relative.includes(' ')).toBe(false);
        }

        // ...and it round-trips exactly, NUL included, because it was only ever content.
        expect(await provider.readFile(at('chats', 'evil'+' '+'.jsonl'), 'utf-8')).toBe('x');
    });
});
