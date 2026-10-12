import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import createVaultProvider from '../src/provider.js';
import * as session from '../src/session.js';
import { VERDICT, explain, isClean, problems, summarize, verifyAll, verifyDataRoot, verifyUser } from '../src/verify.js';
import { flushForeignStores, foreignStoreFor, registerForeignStore, resetForeignStores } from '../src/foreign-stores.js';
import { createVaultState } from '../src/vault-state.js';

const HANDLE = 'default-user';
const PASSWORD = 'correct horse battery staple';

/** @type {string} */
let dataRoot;
/** @type {any} */
let provider;
/** @type {string} */
let userDir;


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
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
    userDir = path.join(dataRoot, HANDLE);
    fs.mkdirSync(userDir, { recursive: true });
    session.closeAll(vault);

    provider = createVaultProvider(vault);
    provider.init({
        dataRoot,
        accountsEnabled: true,
        basicAuthMode: false,
        authenticationDelegated: false,
        users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
    });

    await provider.unlock(HANDLE, PASSWORD);

    // A normal, healthy account: a chat and a character, written through the provider.
    provider.mkdir(path.join(userDir, 'chats', 'Test Character 1'), { recursive: true });
    provider.writeFileSync(path.join(userDir, 'chats', 'Test Character 1', 'a quiet evening.jsonl'), 'I have been waiting for you.');
    provider.writeFileSync(path.join(userDir, 'characters', 'Test Character 1.png'), Buffer.from('PNG-ish bytes'));
});

afterEach(() => {
    session.closeAll(vault);
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

/**
 * 🔴 THE ONE QUESTION THIS PLUGIN CANNOT ANSWER FROM THE INSIDE.
 *
 * An in-process JavaScript library can `import fs` and write wherever it likes. Nothing here can stop it —
 * not the funnel, not the provider, not a single guard. THREE OF THEM DID EXACTLY THAT, and each one took
 * months to find: node-persist wrote every character card in the clear, multer staged every upload in the
 * clear, and vectra inlined the verbatim text of every chat message into its own index.
 *
 * Those three are fixed. **The fourth has not been written yet.** An extension, a new dependency, an
 * upstream refactor — any of them can add one tomorrow, and it will not announce itself. Nothing breaks. No
 * error is thrown. The application works perfectly. There is simply a file on the disk with your chats in
 * it, and no test in this repository is looking for it.
 *
 * So the walker does not try to PREVENT that. It cannot, and pretending otherwise would be theatre. It
 * makes it impossible to do UNNOTICED.
 */
describe('🔴 the verify walker: what is ACTUALLY on the disk', () => {
    test('a healthy account is clean', async () => {
        const report = await verifyUser(dataRoot, HANDLE);

        expect(problems(report)).toEqual([]);
        expect(report.files.filter(f => f.verdict === VERDICT.CIPHERTEXT).length).toBeGreaterThan(0);
    });

    test('🔴 and it is NOT VACUOUS — it really did look at files', async () => {
        // The trap this project keeps falling into: a walker that found nothing because it walked nothing
        // would report a clean bill of health for an empty disk, for ever.
        const report = await verifyUser(dataRoot, HANDLE);

        expect(report.files.length).toBeGreaterThanOrEqual(3);
    });

    test('🔴 A ROGUE EXTENSION WRITING PLAINTEXT IS CAUGHT — by name', async () => {
        // This is the whole point. Some future SillyTavern extension imports fs, writes a "helpful" cache of
        // the conversation next to the encrypted one, and nothing anywhere complains. It works. It is
        // correct. It is a plaintext copy of conversation data.
        fs.mkdirSync(path.join(userDir, 'extensions', 'helpful-plugin'), { recursive: true });
        fs.writeFileSync(
            path.join(userDir, 'extensions', 'helpful-plugin', 'conversation-cache.json'),
            JSON.stringify({ character: 'Test Character 1', text: 'I have been waiting for you.' }),
        );

        const report = await verifyUser(dataRoot, HANDLE);
        const found = problems(report);

        expect(found).toHaveLength(1);
        expect(found[0].verdict).toBe(VERDICT.PLAINTEXT);
        expect(found[0].path).toBe('extensions/helpful-plugin/conversation-cache.json');

        // 🔴 AND IT DESCRIBES THE FILE WITHOUT TRANSCRIBING IT. This used to assert the opposite — that the
        // detail CONTAINED 'Test Character 1' — which is the leak detector copying the leak.
        //
        // `describe()` printed the first 48 bytes, and its docblock called that "short, safe". It is reached
        // only for PLAINTEXT, so by definition those bytes are user data that has escaped; for the case this
        // tool exists to catch they are `{"user_name":"the developer","character_name":"…`. And the tool is built for
        // cron, where the standard idiom mails stdout or redirects it to a file — so FINDING a leak copied it
        // into the mail spool, the journal and the operator's scrollback. Three new places, as a direct
        // result of running the detector.
        //
        // The identifying information is in the shape, not the content: a magic number names a format
        // outright, and a length plus a structural first character separates a chat from a card from a config
        // without reproducing one readable word.
        expect(found[0].detail).toMatch(/JSON-shaped, \d+ bytes/);
        expect(found[0].detail).not.toContain('Test Character 1');
        expect(found[0].detail).not.toContain('I have been waiting for you.');
    });

    test('🔴 a TRUNCATED RECOVERY WRAP is reported — the tool told you to back up the thing it never checked', async () => {
        // bin/verify.js closes every run with a paragraph about .vault-keys.json being what you must keep a
        // copy of -- and VAULT_KEYS was returned from the FILENAME alone, so `wrap_recovery` was never
        // unwrapped, parsed, or even measured. A restore that truncates it leaves a deep verify printing
        // "nothing readable on the disk"; months later the password is forgotten, the recovery key on paper
        // is typed in, and the only path back fails. This is the check that would have said so.
        const keysPath = path.join(userDir, '.vault-keys.json');
        const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));

        expect(typeof keys.wrap_recovery).toBe('string');
        keys.wrap_recovery = keys.wrap_recovery.slice(0, 20);
        fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2));

        const found = problems(await verifyUser(dataRoot, HANDLE));
        const wrap = found.find(f => (f.detail ?? '').includes('RECOVERY WRAP'));

        expect(wrap).toBeDefined();
        expect(wrap.detail).toMatch(/bytes/);
    });

    test('🔴 a SYMLINK is reported, not silently skipped — isFile() and isDirectory() are both false for one', async () => {
        // Both branches of the walker were false for a symlink, and there was no residual branch, so such an
        // entry was neither walked nor classified nor COUNTED. An extension that creates chats/export.jsonl
        // as a link to /tmp and writes cleartext through it got a clean report and exit 0.
        // Deliberately OUTSIDE the data root, which is the whole point of the scenario.
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-outside-'));
        const target = path.join(outside, 'outside.jsonl');
        fs.writeFileSync(target, 'cleartext, written through a link, outside the vault entirely');

        const link = path.join(userDir, 'chats', 'export.jsonl');
        fs.mkdirSync(path.dirname(link), { recursive: true });

        try {
            fs.symlinkSync(target, link);
        } catch {
            // Windows needs elevation or developer mode for symlinks. Nothing to assert if we cannot make one.
            return;
        }

        const found = problems(await verifyUser(dataRoot, HANDLE));
        const reported = found.find(f => f.path.replace(/\\/g, '/') === 'chats/export.jsonl');

        expect(reported).toBeDefined();
        expect(reported.detail).toMatch(/SYMLINK/);
        // And it does NOT follow it: the target is outside the walk and its contents are never read.
        expect(reported.detail).not.toContain('cleartext');
    });

    test('🔴 it needs NO PASSWORD to catch that — so cron can run it at 3am', async () => {
        // The shallow pass is the one that matters operationally, and it is exactly the one that must not
        // require a secret. Our files carry a magic header; a rogue writer's do not. No key needed to tell
        // the difference.
        fs.writeFileSync(path.join(userDir, 'oops.json'), '{"mes":"I have been waiting for you."}');

        const report = await verifyUser(dataRoot, HANDLE, undefined);

        expect(problems(report).map(p => p.path)).toEqual(['oops.json']);
    });

    test('🔴 a file that is encrypted but WILL NOT OPEN is reported as UNREADABLE, not plaintext', async () => {
        // The two failures are opposite and must never be confused. PLAINTEXT means "this leaked".
        // UNREADABLE means "this is intact and the key does not open it" -- and the correct response to that
        // is to touch NOTHING, because the file is the only copy of something.
        const chat = fs.readdirSync(path.join(userDir, 'chats'), { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => path.join(entry.parentPath, entry.name))[0];

        const sealed = fs.readFileSync(chat);
        sealed[sealed.length - 1] ^= 0xff;
        fs.writeFileSync(chat, sealed);

        const report = await verifyUser(dataRoot, HANDLE, PASSWORD);
        const found = problems(report);

        expect(found).toHaveLength(1);
        expect(found[0].verdict).toBe(VERDICT.UNREADABLE);
    });

    test('a corrupted file passes the SHALLOW pass and fails the DEEP one — which is why the deep one exists', async () => {
        const chat = fs.readdirSync(path.join(userDir, 'chats'), { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => path.join(entry.parentPath, entry.name))[0];

        const sealed = fs.readFileSync(chat);
        sealed[sealed.length - 1] ^= 0xff;
        fs.writeFileSync(chat, sealed);

        // The header is intact, so a keyless walk cannot tell. It is still ciphertext, and it is still
        // wrong -- and a backup you never tried to decrypt is a backup you have not got.
        expect(problems(await verifyUser(dataRoot, HANDLE))).toEqual([]);
        expect(problems(await verifyUser(dataRoot, HANDLE, PASSWORD))).toHaveLength(1);
    });

    test('.vault-keys.json is expected plaintext, and is NOT reported', async () => {
        const report = await verifyUser(dataRoot, HANDLE);
        const keyFile = report.files.find(f => f.path === '.vault-keys.json');

        expect(keyFile.verdict).toBe(VERDICT.VAULT_KEYS);
        expect(problems(report)).toEqual([]);
    });

    test('🔴 a PLAINTEXT key/value entry is caught too — that was the real leak', async () => {
        // The character cache, as it actually shipped: node-persist writing every card as plain JSON, in a
        // directory the funnel never touched.
        const cache = path.join(userDir, '_cache', 'characters');
        fs.mkdirSync(cache, { recursive: true });
        fs.writeFileSync(path.join(cache, 'deadbeef'), '{"key":"…/characters/Test Character 1.png","value":"{\\"name\\":\\"Test Character 1\\"}"}');

        const found = problems(await verifyUser(dataRoot, HANDLE));

        expect(found).toHaveLength(1);
        expect(found[0].verdict).toBe(VERDICT.PLAINTEXT);
        expect(found[0].path).toBe('_cache/characters/deadbeef');
    });

    test('the walker NEVER writes anything', async () => {
        const before = fs.readdirSync(userDir, { recursive: true }).sort();

        await verifyUser(dataRoot, HANDLE, PASSWORD);

        expect(fs.readdirSync(userDir, { recursive: true }).sort()).toEqual(before);
    });

    test('verifyAll finds every vaulted account, and ignores everything else', async () => {
        // SillyTavern's own directories sit beside the users. content.log is a FILE in the data root, and an
        // early version of the path splitter decided it was a user called "content.log".
        fs.mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, 'content.log'), 'not a user');

        const reports = await verifyAll(dataRoot);

        expect(reports.map(r => r.handle)).toEqual([HANDLE]);
    });

    test('a wrong password is refused, rather than reporting the whole account unreadable', async () => {
        await expect(verifyUser(dataRoot, HANDLE, 'not the password')).rejects.toThrow(/wrong password/i);
    });
});

describe('🔴 foreign stores: the exemption that must not become a hole', () => {
    // A consumer that took a subkey and opened a SQLCipher database under the user directory. Vault has
    // no relationship with any such plugin — this is a shape, not a partner.
    const SQLCIPHER_STORE = { directory: 'memory', owner: 'a-sqlcipher-plugin', forbidden: ['SQLite format 3\u0000'] };

    // A SQLCipher file opens with 16 bytes of random salt — no magic, nothing to recognise it by, which is
    // exactly why the shallow "must start with STV1" test called it a leak.
    const SQLCIPHER = Buffer.concat([Buffer.from('f1e2d3c4b5a69788c7d6e5f401928374', 'hex'), Buffer.from('sealed pages')]);

    // A PLAIN SQLite file announces itself in its first 16 bytes. This is what a broken SQLCipher writes.
    const PLAIN_SQLITE = Buffer.concat([Buffer.from('SQLite format 3\u0000', 'latin1'), Buffer.from('readable pages')]);

    /**
     * Put a file where such a store would live — with raw fs, never through the provider.
     * @param {Buffer} bytes What to write
     * @returns {void}
     */
    function writeStore(bytes) {
        fs.mkdirSync(path.join(userDir, 'memory'), { recursive: true });
        fs.writeFileSync(path.join(userDir, 'memory', 'store.db'), bytes);
    }

    afterEach(() => {
        resetForeignStores(vault);
    });

    test('🔴 UNREGISTERED, it reads as PLAINTEXT — the behaviour that must NOT change', async () => {
        // The exemption is opt-in and nothing else moves. A directory nobody claimed is still evidence.
        writeStore(SQLCIPHER);

        const report = await verifyUser(dataRoot, HANDLE);
        const store = report.files.find(f => f.path === 'memory/store.db');

        expect(store.verdict).toBe(VERDICT.PLAINTEXT);
        expect(problems(report).map(f => f.path)).toContain('memory/store.db');
    });

    test('🔴 REGISTERED, it stops being a standing false alarm', async () => {
        // The actual bug: this fired on EVERY run, for ever, on a correctly-encrypted file. An operator who
        // sees a permanent PLAINTEXT finding learns to skim the report, and the real fourth leak then lands
        // in a report nobody reads. The confidentiality was never at risk; the DETECTOR was.
        provider.registerForeignStore(SQLCIPHER_STORE);
        writeStore(SQLCIPHER);

        const report = await verifyUser(dataRoot, HANDLE);
        const store = report.files.find(f => f.path === 'memory/store.db');

        expect(store.verdict).toBe(VERDICT.FOREIGN);
        expect(store.detail).toContain('a-sqlcipher-plugin');
        expect(problems(report)).toHaveLength(0);
    });

    test('🔴 but the claim is CHECKED — a broken SQLCipher is caught, not waved through', async () => {
        // The exemption's whole justification. "SQLCipher was built without encryption support and quietly
        // wrote a normal database" is the realistic failure for this store, it is invisible from inside
        // the owning plugin, and the shallow pass catches it with no key and no cooperation.
        provider.registerForeignStore(SQLCIPHER_STORE);
        writeStore(PLAIN_SQLITE);

        const report = await verifyUser(dataRoot, HANDLE);
        const store = report.files.find(f => f.path === 'memory/store.db');

        expect(store.verdict).toBe(VERDICT.FOREIGN_PLAINTEXT);
        expect(store.detail).toContain('a-sqlcipher-plugin');
        expect(problems(report).map(f => f.path)).toContain('memory/store.db');
    });

    test('a store that declares nothing checkable is reported UNVERIFIABLE, not verified', async () => {
        provider.registerForeignStore({ directory: 'memory', owner: 'silent-plugin' });
        writeStore(SQLCIPHER);

        const report = await verifyUser(dataRoot, HANDLE);
        const store = report.files.find(f => f.path === 'memory/store.db');

        expect(store.verdict).toBe(VERDICT.FOREIGN);
        expect(store.detail).toContain('UNVERIFIABLE');
    });

    test('the exemption reaches ONLY the claimed directory', async () => {
        // A registration must not become a general amnesty. A plaintext file one level up is still a leak.
        provider.registerForeignStore(SQLCIPHER_STORE);
        writeStore(SQLCIPHER);
        fs.writeFileSync(path.join(userDir, 'leaked.txt'), 'I have been waiting for you.');

        const report = await verifyUser(dataRoot, HANDLE);

        expect(problems(report).map(f => f.path)).toEqual(['leaked.txt']);
    });

    test('🔴 a SEPARATE PROCESS sees the registration — this is the cron case', async () => {
        // The shallow verify is meant to run from cron, which loads no plugins. An in-memory-only registry
        // would be empty there and every foreign file would go straight back to reading as PLAINTEXT — the
        // exact failure being fixed. The declaration is persisted, so it outlives the process that made it.
        provider.registerForeignStore(SQLCIPHER_STORE);
        writeStore(SQLCIPHER);

        // Forget everything, as a fresh `node bin/verify.js` would have.
        resetForeignStores(vault);

        const report = await verifyUser(dataRoot, HANDLE);
        expect(report.files.find(f => f.path === 'memory/store.db').verdict).toBe(VERDICT.FOREIGN);
    });

    test('the registry is written OUTSIDE every vault, so it is not evidence about itself', async () => {
        // A registry inside the tree being audited would be a file the audit must make an exception for,
        // and one the audit's own subject can edit. A `_`-prefixed directory at the data root is reserved
        // to SillyTavern and is never walked.
        //
        // 🔴 IT MUST ALSO BE AN UNOCCUPIED ONE — `_storage` is the node-persist account store, which parses
        // every file in its directory at `init()` and dies on one that is not a datum. See `registryPath`.
        provider.registerForeignStore(SQLCIPHER_STORE);

        expect(fs.existsSync(path.join(dataRoot, '_vault', 'vault-foreign-stores.json'))).toBe(true);
        expect(fs.existsSync(path.join(dataRoot, '_storage', 'vault-foreign-stores.json'))).toBe(false);

        writeStore(SQLCIPHER);
        const report = await verifyUser(dataRoot, HANDLE);
        expect(report.files.map(f => f.path)).not.toContain('vault-foreign-stores.json');
    });

    test('an anonymous claim is refused — the owner is what makes the report actionable', () => {
        expect(() => provider.registerForeignStore({ directory: 'memory' })).toThrow(/owner/i);
        expect(() => provider.registerForeignStore({ owner: 'a-sqlcipher-plugin' })).toThrow(/directory/i);
        expect(() => provider.registerForeignStore({ directory: '../../etc', owner: 'x' })).toThrow(/inside/i);
    });
});

describe('foreign stores: the provider stops mangling the names too', () => {
    afterEach(() => {
        resetForeignStores(vault);
    });

    test('🔴 a readdir of the user root does not throw on the claimed directory', () => {
        // Before the registry, `memory` was in neither STRUCTURAL_DIRECTORIES nor LIBRARY_NAMED_DIRECTORIES,
        // so `decodeName` handed the literal string `memory` to `decryptName`. paths.js already records what
        // happens then: "trying to AES-SIV them would simply throw. (It did.)"
        provider.registerForeignStore({ directory: 'memory', owner: 'a-sqlcipher-plugin' });
        fs.mkdirSync(path.join(userDir, 'memory'), { recursive: true });

        const listing = provider.readdir(userDir);

        expect(listing).toContain('memory');
    });

    test('the owner names its own files, and they come back unchanged', () => {
        provider.registerForeignStore({ directory: 'memory', owner: 'a-sqlcipher-plugin' });
        fs.mkdirSync(path.join(userDir, 'memory'), { recursive: true });
        fs.writeFileSync(path.join(userDir, 'memory', 'store.db'), 'x');

        expect(provider.readdir(path.join(userDir, 'memory'))).toEqual(['store.db']);
    });

    test('and a directory NOBODY claimed still gets its name encrypted', () => {
        // The registry grants exactly what was asked for and nothing next to it.
        provider.mkdir(path.join(userDir, 'chats', 'Test Character 1'), { recursive: true });

        const onDisk = fs.readdirSync(path.join(userDir, 'chats'));

        expect(onDisk).not.toContain('Test Character 1');
    });
});

/**
 * 🔴 Tested against `foreign-stores.js` DIRECTLY, and that is not laziness.
 *
 * The first version of these went through the provider, and it was VACUOUS. `lifecycle`'s `dataRoot` is
 * module-level state shared by every provider instance in the process, and the suite's `beforeEach` has
 * already set it — so a freshly-created provider does not see the pre-init condition at all, and the test
 * passed happily with the guard deleted. Mutation testing caught it; nothing else would have.
 *
 * The condition being tested is "persist was handed no data root", so it is tested by handing persist no
 * data root.
 */
describe('🔴 registration before init: the load order we do not control', () => {
    /** Where a relative write would land. Must track `REGISTRY_DIRECTORY`, or this test checks nothing. */
    const strayDirectory = path.join(process.cwd(), '_vault');

    /**
     * 🔴 ITS OWN, DELIBERATELY UN-INITIALISED — and this is now the real condition rather than a stand-in.
     *
     * These tests used to fake "init has not run" by passing `''` as the data root, because the data root
     * was a module global there was no other way to reach. A fresh `createVaultState()` HAS an empty data
     * root, because that is what a provider looks like before `init`. The test no longer describes the
     * condition; it is in it.
     */
    let preInit;

    beforeEach(() => {
        preInit = createVaultState();
    });

    test('🔴 a registration made BEFORE init does not write to a RELATIVE path', () => {
        // `lifecycle.dataRoot` is '' until init runs, and plugin load order is the fork's business, not
        // ours — a plugin may well declare before the storage provider has been initialised.
        //
        // `path.join('', '_vault', …)` does NOT throw. It yields the relative path
        // `_vault/vault-foreign-stores.json`, which lands in the process working directory — the
        // SillyTavern install, not the data root. Silently, in the wrong place, and invisible to every
        // later `verify`, which is the failure this whole module exists to prevent.
        const strayExisted = fs.existsSync(strayDirectory);

        registerForeignStore(preInit, { directory: 'memory', owner: 'a-plugin', forbidden: ['PLAIN'] });

        expect(fs.existsSync(strayDirectory)).toBe(strayExisted);
    });

    test('🔴 and the flush writes it once the data root IS known', () => {
        // The in-memory half is live immediately, but a declaration that never reaches the disk is one a
        // separate `verify` process never learns about.
        const lateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'late-'));

        try {
            registerForeignStore(preInit, { directory: 'memory', owner: 'a-plugin', forbidden: ['PLAIN'] });
            expect(fs.existsSync(path.join(lateRoot, '_vault', 'vault-foreign-stores.json'))).toBe(false);

            preInit.dataRoot = lateRoot;
            flushForeignStores(preInit);

            const written = JSON.parse(fs.readFileSync(path.join(lateRoot, '_vault', 'vault-foreign-stores.json'), 'utf-8'));
            expect(written.stores.map(s => s.directory)).toEqual(['memory']);
            expect(written.stores[0].forbidden).toEqual(['PLAIN']);
        } finally {
            fs.rmSync(lateRoot, { recursive: true, force: true });
        }
    });

    test('the registration is live in memory immediately, flushed or not', () => {
        // Persistence is for the OTHER process. This one must behave correctly from the moment of the call.
        registerForeignStore(preInit, { directory: 'memory', owner: 'a-plugin' });

        // Against `preInit`, which is the vault it was registered into. Asserting against a DIFFERENT
        // vault would now correctly fail -- and before Part 3 it could not have, because there was only
        // ever one registry in the process for every provider to share.
        expect(foreignStoreFor(preInit, 'memory/store.db')).toMatchObject({ owner: 'a-plugin' });
        expect(foreignStoreFor(vault, 'memory/store.db')).toBeUndefined();
    });

    test('flushing with nothing registered writes nothing at all', () => {
        const lateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));

        try {
            preInit.dataRoot = lateRoot;
            flushForeignStores(preInit);
            expect(fs.existsSync(path.join(lateRoot, '_storage'))).toBe(false);
        } finally {
            fs.rmSync(lateRoot, { recursive: true, force: true });
        }
    });
});

/**
 * 🔴 THE PARTS THAT USED TO LIVE IN `bin/verify.js`.
 *
 * Counting the verdicts, deciding what "clean" means, and saying what a verdict MEANS were all in the CLI.
 * So the sentence an operator actually acts on — the exit code — was the one thing no test could reach
 * without spawning a process, and `classify()` deferred the semantics of its own enum outward in a comment
 * ("bin/verify.js says plainly what that means") to a file nothing could import.
 *
 * They are beside `VERDICT` now, which is the only place they can be checked against it.
 */
describe('the verify library: tallies, policy and meaning', () => {
    test('summarize counts every verdict and carries the depth', async () => {
        const report = await verifyUser(dataRoot, HANDLE);
        const summary = summarize(report);

        expect(summary.total).toBe(report.files.length);
        expect(summary.deep).toBe(false);
        expect(summary.clean).toBe(true);
        expect(summary.problems).toBe(0);
        expect(summary.counts[VERDICT.CIPHERTEXT]).toBeGreaterThan(0);
        expect(summary.counts[VERDICT.VAULT_KEYS]).toBe(1);

        // The counts must add up to the files walked, or something is being classified twice or not at all.
        const summed = Object.values(summary.counts).reduce((a, b) => a + b, 0);

        expect(summed).toBe(report.files.length);
    });

    test('summarize reports deep when a password was actually used', async () => {
        const report = await verifyUser(dataRoot, HANDLE, PASSWORD);

        expect(summarize(report).deep).toBe(true);
    });

    test('🔴 a plaintext file makes the summary dirty, and isClean false', async () => {
        // Write directly to the plaintext `extensions/` skeleton, behind the provider's back. A logical
        // path such as `chats/<handle>/` is encrypted on disk and is not a filesystem path.
        fs.mkdirSync(path.join(userDir, 'extensions', 'rogue'), { recursive: true });
        fs.writeFileSync(path.join(userDir, 'extensions', 'rogue', 'leaked.json'), 'in the clear');

        const report = await verifyUser(dataRoot, HANDLE);
        const summary = summarize(report);

        expect(summary.clean).toBe(false);
        expect(summary.problems).toBe(1);
        expect(summary.counts[VERDICT.PLAINTEXT]).toBe(1);
        expect(isClean([report])).toBe(false);
    });

    test('isClean is true only when EVERY report is clean', async () => {
        const clean = await verifyUser(dataRoot, HANDLE);

        expect(isClean([clean])).toBe(true);
        expect(isClean([clean, { files: [{ path: 'x', verdict: VERDICT.PLAINTEXT }] }])).toBe(false);

        // FOREIGN and LEGACY are deliberately not problems — that is the whole point of them.
        expect(isClean([{ files: [{ path: 'x', verdict: VERDICT.FOREIGN }] }])).toBe(true);
        expect(isClean([{ files: [{ path: 'x', verdict: VERDICT.LEGACY }] }])).toBe(true);
    });

    test('🔴 isClean agrees with problems(), for every verdict there is', async () => {
        // The two must never drift: one decides the exit code, the other decides what is printed. If a new
        // verdict is added to only one of them, an operator gets a list of findings and a green exit.
        for (const verdict of Object.values(VERDICT)) {
            const report = { files: [{ path: 'x', verdict }] };

            expect(isClean([report])).toBe(problems(report).length === 0);
        }
    });

    test('every verdict that is a problem explains itself', () => {
        for (const verdict of Object.values(VERDICT)) {
            if (problems({ files: [{ path: 'x', verdict }] }).length > 0) {
                expect(typeof explain(verdict)).toBe('string');
            }
        }

        // And the two that are NOT problems but still have to say something on every run.
        expect(typeof explain(VERDICT.LEGACY)).toBe('string');
        expect(typeof explain(VERDICT.FOREIGN)).toBe('string');

        // A verdict that needs no explanation says nothing, rather than inventing one.
        expect(explain(VERDICT.CIPHERTEXT)).toBeNull();
        expect(explain('not a verdict at all')).toBeNull();
    });

    test('🔴 verifyDataRoot needs no boot context — it finds the handles itself', async () => {
        // The half-sufficient version left `rememberHandles` in the CLI, so a caller who forgot it got
        // subtly different verdicts and no error. This is the cron path, and it has to be correct alone.
        const reports = await verifyDataRoot(dataRoot);

        expect(reports).toHaveLength(1);
        expect(reports[0].handle).toBe(HANDLE);
        expect(reports[0].deep).toBe(false);
        expect(isClean(reports)).toBe(true);
    });

    test('verifyDataRoot passes a password through to the account it names', async () => {
        const reports = await verifyDataRoot(dataRoot, { [HANDLE]: PASSWORD });

        expect(reports[0].deep).toBe(true);
    });
});
