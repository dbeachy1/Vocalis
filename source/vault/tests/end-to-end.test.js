import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawn } from 'node:child_process';

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';

jest.setTimeout(600_000);

/**
 * 🔴 THE REAL THING: REAL SILLYTAVERN, REAL ENCRYPTION, REAL DISK.
 *
 * Every other test in this repository tests a piece. This one tests the claim.
 *
 * It boots the actual SillyTavern fork as a subprocess, with this plugin installed as a storage provider,
 * drives it over HTTP the way a browser would, and then goes and reads the raw bytes on the disk to see
 * whether they gave anything away.
 *
 * Nothing here is mocked, stubbed or faked. If this passes, the thing works.
 *
 * It found two real bugs the unit tests could not have:
 *
 *   1. `<DATA_ROOT>/content.log` — a file living directly in the data root — was mistaken for a user called
 *      "content.log". The provider claimed it and tried to decrypt SillyTavern's own global content log.
 *      SillyTavern SWALLOWED the resulting error and silently seeded no default content: no themes, no
 *      presets, no backgrounds, and nothing to say why.
 *
 *   2. The cutover only works in one order. See the comment on the wipe, below.
 */

const FORK = process.env.ST_FORK_PATH ?? path.resolve(path.dirname(process.cwd()), 'taproom');
const PLUGIN = process.cwd();
const PASSWORD = 'correct-horse-battery-staple';
const HANDLE = 'default-user';

const forkIsPresent = fs.existsSync(path.join(FORK, 'server.js'));
const describeIfFork = forkIsPresent ? describe : describe.skip;

/** @returns {Promise<number>} A free port */
const freePort = () => new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
});

/**
 * Every file actually on the disk under a directory.
 * @param {string} dir Where to look
 * @param {string} prefix Reporting prefix
 * @returns {string[]} Relative paths
 */
function walk(dir, prefix = '') {
    if (!fs.existsSync(dir)) {
        return [];
    }

    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        return entry.isDirectory() ? walk(path.join(dir, entry.name), relative) : [relative];
    });
}

describeIfFork('🔴 end to end: real SillyTavern, real encryption', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;
    /** @type {string} */
    let configPath;
    /** @type {string} */
    let providers;
    /** @type {string} */
    let userDir;

    /** @type {any} */
    let server;
    /** @type {string} */
    let cookie;

    /** @type {string[]} */
    let filesOnDisk;
    /** @type {string} */
    let everyByteOnDisk;

    /** @type {number} */
    let filesWhileLocked;
    /** @type {boolean} */
    let deferred;
    /** @type {number} */
    let staleCookieStatus;
    /** @type {any} */
    let chatAfterRestart;
    /** @type {number} */
    let defaultContentRestored;
    /** @type {string[]} */
    let cacheFiles;
    /** @type {string[]} */
    let cacheContents;
    /** @type {any} */
    let characterList;
    /** @type {any} */
    let importResponse;

    /**
     * Boot SillyTavern.
     * @param {boolean} withProvider Whether to install the encryption provider
     * @returns {Promise<any>} The running server
     */
    async function boot(withProvider) {
        const port = await freePort();
        const env = {
            ...process.env,
            SILLYTAVERN_DATAROOT: dataRoot,
            SILLYTAVERN_LISTEN: 'false',
            SILLYTAVERN_BROWSERLAUNCH_ENABLED: 'false',
            SILLYTAVERN_ENABLESERVERPLUGINS: 'false',
            NODE_ENV: 'test',
        };

        if (withProvider) {
            env.SILLYTAVERN_STORAGEPROVIDERSPATH = providers;
            env.SILLYTAVERN_ENABLEUSERACCOUNTS = 'true';
        }

        const child = spawn(process.execPath, [
            'server.js', `--dataRoot=${dataRoot}`, `--configPath=${configPath}`,
            `--port=${port}`, '--listen=false', '--autorun=false', '--disableCsrf',
        ], { cwd: FORK, env, stdio: ['ignore', 'pipe', 'pipe'] });

        let output = '';
        child.stdout.on('data', chunk => output += chunk);
        child.stderr.on('data', chunk => output += chunk);

        // 🔴 THE FIRST BOOT PAYS FOR A COLD WEBPACK BUILD, EVERY SINGLE RUN, AND 45 SECONDS DID NOT COVER IT.
        //
        // This was `i < 90` — 90 × 500 ms — while the `beforeAll` around it is given 600_000 ms. That gap was
        // the bug: somebody deliberately allowed the setup ten minutes and then let the poll give up at
        // forty-five seconds.
        //
        // It is not a slow machine and it is not a flake. The fork puts webpack's cache under DATA_ROOT
        // (`webpack.config.js`, `getWebpackRoot`), and this helper hands it a fresh `mkdtemp` every run — so
        // the cache is cold BY CONSTRUCTION and can never warm up between runs. Every e2e run compiles
        // SillyTavern's frontend libraries from scratch, in production mode, inside the boot budget. On this
        // machine that is comfortably over 45 s, so both e2e suites failed 100% of the time, which is how
        // sixteen red tests sat behind a "seed boot failed" message that looked environmental.
        //
        // Four minutes, and the enclosing timeout is still the real ceiling.
        let up = false;
        for (let i = 0; i < 480; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (child.exitCode !== null) break;
            try {
                await fetch(`http://127.0.0.1:${port}/`);
                up = true;
                break;
            } catch { /* not listening yet */ }
        }

        // 🔴 A BOOT THAT FAILED STILL LEFT A SILLYTAVERN RUNNING. Every caller does
        // `if (!x.up) throw new Error(...)` — and the `stop()` on the line after it therefore never ran, so
        // the child survived the test file that spawned it, kept its handles open on the scratch tree, and
        // made the `afterAll` cleanup fail with ENOTEMPTY. That is the second failure stacked on the first:
        // the suite reported "Test suite failed to run" and left the temp tree on disk.
        //
        // Kill it here, where we already know it did not come up, rather than trusting nine call sites to
        // remember.
        if (!up) {
            child.kill();
        }

        return {
            port, up,
            output: () => output,
            // 🔴 THE FALLBACK TIMER MUST BE CLEARED, AND NOT CLEARING IT LEAKED A WORKER ON EVERY RUN.
            //
            // This was `child.on('exit', r); child.kill(); setTimeout(r, 3000);`. The child exits
            // promptly, so `on('exit')` settles the promise — and the three-second timer stays ARMED,
            // holding the event loop open long after the test has finished. Jest then reports
            //
            //     A worker process has failed to exit gracefully and has been force exited.
            //     ... Active timers can also cause this, ensure that .unref() was called on them.
            //
            // which names the cause exactly, and which this repo read past for long enough that I first
            // diagnosed it as a Jest/ESM quirk and proposed capping `maxWorkers`. That would have hidden
            // it. It reproduces only when the file runs in a WORKER — a single-file run goes in-band,
            // where the leaked timer is the main process's problem and nobody complains.
            //
            // The timer is a fallback for a child that will not die. Clear it when the child does die.
            stop: () => new Promise(r => {
                const fallback = setTimeout(r, 3000);

                child.on('exit', () => {
                    clearTimeout(fallback);
                    r();
                });

                child.kill();
            }),
        };
    }

    /**
     * POST some JSON.
     * @param {number} port The port
     * @param {string} route The route
     * @param {any} body The body
     * @param {string} [auth] A cookie
     * @returns {Promise<any>} The response
     */
    async function post(port, route, body, auth) {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: auth } : {}) },
            body: JSON.stringify(body),
        });

        const text = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = text;
        }

        return {
            status: response.status,
            body: parsed,
            cookie: response.headers.getSetCookie().map(c => c.split(';')[0]).join('; '),
        };
    }

    /**
     * Upload a file the way the browser does: multipart, through multer.
     *
     * 🔴 THIS IS THE ONLY PATH THAT EXERCISES THE MULTER SEAM. Every import -- every character card, chat,
     * world info, sprite pack and avatar -- stages on the disk HERE, written by multer's own fs, before one
     * line of SillyTavern's code runs. It was landing in plaintext.
     * @param {number} port The port
     * @param {string} route The route
     * @param {Buffer} bytes The file
     * @param {string} filename Its name
     * @param {Record<string, string>} fields Other form fields
     * @param {string} auth A cookie
     * @returns {Promise<any>} The response
     */
    async function upload(port, route, bytes, filename, fields, auth) {
        const form = new FormData();
        form.append('avatar', new Blob([bytes]), filename);

        for (const [key, value] of Object.entries(fields)) {
            form.append(key, value);
        }

        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
            method: 'POST',
            headers: { Cookie: auth },
            body: form,
        });

        return { status: response.status, body: await response.text() };
    }

    beforeAll(async () => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'st-e2e-'));
        dataRoot = path.join(scratch, 'data');
        configPath = path.join(scratch, 'config.yaml');
        providers = path.join(scratch, 'storage-providers');
        userDir = path.join(dataRoot, HANDLE);

        // 1. A stock SillyTavern install. This is what creates the ACCOUNT.
        const seed = await boot(false);
        if (!seed.up) throw new Error(`Seed boot failed.\n\n${seed.output()}`);
        await seed.stop();

        // Give the account a password, the way the admin UI would.
        const { default: nodePersist } = await import('node-persist');
        const store = nodePersist.create({ dir: path.join(dataRoot, '_storage') });
        await store.init();
        const user = await store.getItem(`user:${HANDLE}`);
        const salt = crypto.randomBytes(16).toString('base64');
        user.password = crypto.scryptSync(PASSWORD.normalize(), salt, 64).toString('base64');
        user.salt = salt;
        await store.setItem(`user:${HANDLE}`, user);

        // 2. 🔴 THE CUTOVER, AND THE ORDER IS THE WHOLE TRICK.
        //
        //    Empty the account, but KEEP the account. There is no migration utility, by decision -- and the
        //    plugin enforces that by refusing to encrypt an account that already holds data, because doing
        //    so would leave every existing plaintext file present-but-permanently-unreadable.
        //
        //    A "fresh" SillyTavern install is NOT empty: it seeds ~196 files of default content (themes,
        //    presets, backgrounds, a sample character) on first boot. So the wipe has to happen AFTER the
        //    account exists and BEFORE the first boot with the provider.
        //
        //    And then the magic: SillyTavern re-seeds all of it after unlock, as deferred maintenance --
        //    and that write goes THROUGH the provider. The default content lands encrypted. Nothing is
        //    lost, and nothing has to be migrated.
        fs.rmSync(userDir, { recursive: true, force: true });

        // 3. Install this plugin as the storage provider.
        fs.mkdirSync(providers, { recursive: true });
        fs.cpSync(PLUGIN, path.join(providers, 'vault'), {
            recursive: true,
            filter: src => !src.includes('node_modules') && !src.includes(`${path.sep}.git`),
        });

        // 4. Boot SillyTavern with real encryption.
        server = await boot(true);
        if (!server.up) throw new Error(`Encrypted boot failed.\n\n${server.output()}`);

        deferred = /deferred until they log in/i.test(server.output());
        filesWhileLocked = walk(userDir).length;

        // 5. Log in. This creates the vault, unlocks it, and runs the deferred maintenance.
        const login = await post(server.port, '/api/users/login', { handle: HANDLE, password: PASSWORD });
        expect(login.status).toBe(200);
        cookie = login.cookie;

        defaultContentRestored = walk(userDir).length;

        // 6. Write a chat, through SillyTavern, exactly as the browser would.
        const saved = await post(server.port, '/api/chats/save', {
            ch_name: 'Seraphina',
            file_name: 'a quiet evening',
            avatar_url: 'Seraphina.png',
            chat: [{ name: 'Seraphina', is_user: false, mes: 'I have been waiting for you.' }],
        }, cookie);
        expect(saved.status).toBe(200);

        // 6b. 🔴 LIST THE CHARACTERS. THIS IS THE LINE WHOSE ABSENCE COST US THE FOURTH FALSE GREEN.
        //
        //     Every assertion below was passing while `<U>/_cache/characters/` sat there holding every
        //     character card IN THE CLEAR -- name, description, personality, the lot -- because nothing in
        //     this test had ever caused a card to be READ. The cache was empty, so there was nothing in it
        //     to find, so the grep came back clean and the suite went green and the leak lived for two
        //     milestones.
        //
        //     A test that never exercises the code path it is auditing is not a weak test. It is a test that
        //     agrees with the bug.
        // 6a. IMPORT A CHARACTER CARD THROUGH THE REAL UPLOAD PATH.
        //
        //     multer stages it on the disk before SillyTavern sees it, with its own fs, outside the funnel.
        //     This is the only thing in the suite that exercises that seam -- and it is also what proves the
        //     two libraries that used to read the staged file with their OWN file descriptors (Jimp, yauzl)
        //     now go through the provider. If they did not, this import would fail: they would be handed
        //     ciphertext and report a corrupt image.
        const card = fs.readFileSync(path.join(FORK, 'default', 'content', 'default_Seraphina.png'));
        importResponse = await upload(
            server.port,
            '/api/characters/import',
            card,
            'imported_card.png',
            { file_type: 'png' },
            cookie,
        );

        expect(importResponse.status).toBe(200);

        const characters = await post(server.port, '/api/characters/all', {}, cookie);
        expect(characters.status).toBe(200);
        characterList = characters.body;

        // node-persist writes through a queue that flushes on a tick. Let it land before we go looking, or
        // we will be grepping a disk the leak has not reached yet -- and calling that a pass.
        await new Promise(resolve => setTimeout(resolve, 1500));

        // 6c. And go and look at the CACHE ITSELF, separately from everything else.
        //
        //     Because "the grep found no plaintext" is exactly as true of an ENCRYPTED cache as it is of an
        //     EMPTY one, and the difference between those two is the whole fix. If implementing the seam had
        //     broken the cache writes, this directory would be empty, the grep would come back clean, and
        //     the suite would go green for precisely the reason it went green while the leak was live.
        const cacheDirectory = path.join(userDir, '_cache', 'characters');
        cacheFiles = walk(cacheDirectory);
        cacheContents = cacheFiles.map(f => fs.readFileSync(path.join(cacheDirectory, f), 'utf-8'));

        // 7. Now go and look at the actual disk.
        filesOnDisk = walk(userDir);
        everyByteOnDisk = filesOnDisk
            .map(f => fs.readFileSync(path.join(userDir, f)).toString('latin1'))
            .join('\n');

        await server.stop();

        // 8. Restart. Cold vault, valid cookie.
        server = await boot(true);
        if (!server.up) throw new Error(`Restart failed.\n\n${server.output()}`);

        const stale = await fetch(`http://127.0.0.1:${server.port}/api/users/me`, { headers: { Cookie: cookie } });
        staleCookieStatus = stale.status;

        const back = await post(server.port, '/api/users/login', { handle: HANDLE, password: PASSWORD });
        chatAfterRestart = await post(server.port, '/api/chats/get', {
            ch_name: 'Seraphina', file_name: 'a quiet evening', avatar_url: 'Seraphina.png',
        }, back.cookie);
    }, 600_000);

    afterAll(async () => {
        await server?.stop();

        if (scratch) {
            // ⚠️ `force` DOES NOT RETRY, AND ON WINDOWS THAT IS THE WHOLE PROBLEM. A child that has only just
            // been killed still holds handles for a moment, and the antivirus/indexer takes its own look —
            // so `rmSync` hits ENOTEMPTY/EBUSY, throws out of `afterAll`, and Jest escalates the whole file
            // to "Test suite failed to run" on top of whatever the real failure was. `maxRetries` exists for
            // exactly this and costs nothing when the tree is already free.
            fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });

    // ---- the claim ------------------------------------------------------------------------------

    test('🔴 THE MESSAGE IS NOT ON THE DISK', () => {
        expect(everyByteOnDisk).not.toContain('I have been waiting for you.');
    });

    test('🔴 NEITHER IS THE CHARACTER\'S NAME — not in a file, not in a FILENAME', () => {
        // SillyTavern ships a sample character called Seraphina, so her name is genuinely all over a stock
        // install. Here it appears nowhere at all: not in the bytes, not in a path.
        expect(everyByteOnDisk).not.toContain('Seraphina');
        expect(filesOnDisk.filter(f => f.includes('Seraphina'))).toEqual([]);
    });

    // ---- the character-card cache: node-persist, which never touches the provider ------------------
    //
    // Populate the character-card cache before checking confidentiality; an empty cache would make a
    // plaintext scan vacuous. Verify that entries exist, are ciphertext, and remain readable by the host.

    test('🔴 the cache was actually POPULATED — without this, the grep below proves NOTHING', () => {
        expect(cacheFiles.length).toBeGreaterThan(0);
    });

    test('🔴 and every single entry is CIPHERTEXT', () => {
        // Every entry, not "no plaintext anywhere": a single plaintext entry among ciphertext ones is the
        // whole leak back again, and a grep for one name would not necessarily find it.
        for (const entry of cacheContents) {
            expect(entry.startsWith('esk1:')).toBe(true);
        }

        const everyCacheByte = cacheContents.join('\n');

        expect(everyCacheByte).not.toContain('Seraphina');
        expect(everyCacheByte).not.toContain('caring');
        expect(everyCacheByte).not.toContain('description');
        expect(everyCacheByte).not.toContain('personality');

        // The plaintext character FILENAME used to sit in the key of every entry, in the clear, even before
        // you got to the value.
        expect(everyCacheByte).not.toContain('.png');
    });

    // ---- multer: every import touches the disk before SillyTavern sees it -------------------------

    test('🔑 a character card IMPORTS — staged on the disk as ciphertext the whole way', () => {
        // multer staged the upload ENCRYPTED, and SillyTavern then read it back, parsed the PNG, extracted
        // the card and wrote it to characters/ — every step through the funnel.
        //
        // This is also what proves the two libraries that used to open the staged file with their OWN file
        // descriptors now go through the provider. Jimp was the instructive one: handed ciphertext it threw,
        // and a catch "rescued" it by returning the correctly-decrypted bytes from storage, so the import
        // still 200'd while silently dropping the crop and resize. A status code alone would not have caught
        // that, which is why tests/multer-storage.test.js goes and looks at the staged bytes directly.
        expect(importResponse.status).toBe(200);
        expect(importResponse.body).toContain('file_name');
    });

    test('🔴 and NOTHING was left behind in the upload staging directory', () => {
        // The upload handler removes staged files after processing, so assert that no residue survives.
        // Ciphertext-at-rest while a staged file exists is covered in `tests/multer-storage.test.js`.
        expect(filesOnDisk.filter(f => f.startsWith('_uploads/'))).toEqual([]);
    });

    test('🔴 and the cache FILENAMES are keyed — not a free confirmation oracle', () => {
        // node-persist names each file `sha256(key)`, and the key is a plaintext path. sha256 takes NO KEY,
        // so an attacker holding the disk could test a guess: hash a character name they suspect, with an
        // mtime they can read straight off the card, and see whether that file exists. It discloses nothing
        // and confirms everything, and it was the last keyless name anywhere in the system.
        //
        // Reconstruct the attack here, against the real disk, with the real filenames.
        const cardPath = path.join(userDir, 'characters', 'default_Seraphina.png');
        const guesses = [];

        // The attacker does not know the physical name of the card -- but they can see every file's mtime,
        // and they know the shape of the key. So: try every mtime on the disk against the name they suspect.
        for (const file of filesOnDisk) {
            const mtime = fs.statSync(path.join(userDir, file)).mtimeMs;
            guesses.push(crypto.createHash('sha256').update(`${cardPath}-${mtime}`, 'utf-8').digest('hex'));
            guesses.push(crypto.createHash('sha256').update(cardPath, 'utf-8').digest('hex'));
        }

        // Not one of those guesses names a file that exists.
        expect(cacheFiles.filter(name => guesses.includes(path.basename(name)))).toEqual([]);

        // The names ARE 64 hex characters -- they are hashes. They are simply hashes the attacker cannot
        // compute, because they are keyed to a DEK that only exists in RAM after a login.
        for (const name of cacheFiles) {
            expect(path.basename(name)).toMatch(/^[0-9a-f]{64}$/);
        }
    });

    test('🔑 and SillyTavern reads the cards straight back THROUGH the encrypted cache', () => {
        // The seam could have "passed" the greps by simply breaking the cache. It did not: the card came
        // back, with her name on it, decrypted, through the store that holds nothing but ciphertext.
        expect(JSON.stringify(characterList)).toContain('Seraphina');
    });

    test('🔴 NEITHER IS THE CHAT TITLE — the chat LIST is a secret too', () => {
        // Encrypting contents and leaving names alone would be close to pointless: the path
        // `chats/<who>/<what>.jsonl` puts the name of everyone you talk to, and the title of every
        // conversation you have ever had, in the clear.
        expect(everyByteOnDisk).not.toContain('a quiet evening');
        expect(filesOnDisk.filter(f => f.includes('a quiet evening'))).toEqual([]);
    });

    test('and SillyTavern reads it straight back, as if nothing were happening', () => {
        expect(JSON.stringify(chatAfterRestart.body)).toContain('I have been waiting for you.');
    });

    // ---- the whole data root, not just the user directory ----------------------------------------

    test('🔴 THE SWEEP: not one secret anywhere under the DATA ROOT', () => {
        // 🔴 THE WHOLE DATA ROOT, not `<DATA_ROOT>/<handle>/`.
        //
        // Every other assertion here looks inside the user's directory, because that is where the provider's
        // writ runs. Which means every one of them is blind to the failure mode that matters most: data
        // landing SOMEWHERE ELSE.
        //
        // That is not hypothetical. Uploads used to stage in `<DATA_ROOT>/_uploads` — outside every user
        // directory, where a provider whose ownership rule is "everything under <DATA_ROOT>/<handle>/" would
        // never even have looked. Every character card the user ever imported hit the platter in plaintext,
        // in a directory none of these tests were watching. F3 moved it. If anything ever moves it back — a
        // fallback engine, a new library, a refactor — this is the test that notices.
        //
        // So: walk the entire data root, read every byte, and look for anything the user would mind losing.
        const everything = walk(dataRoot)
            .map(f => fs.readFileSync(path.join(dataRoot, f)).toString('latin1'))
            .join('\n');

        // The chat.
        expect(everything).not.toContain('I have been waiting for you.');
        // The character, her card, and the personality inlined in it.
        expect(everything).not.toContain('Seraphina');
        expect(everything).not.toContain('compassionate');
        // The chat's title.
        expect(everything).not.toContain('a quiet evening');

        // And not in a FILENAME either, anywhere in the tree.
        expect(walk(dataRoot).filter(f => /Seraphina|quiet evening/i.test(f))).toEqual([]);
    });

    test('🔴 and the sweep is not vacuous — there is a great deal of data there', () => {
        // The trap this whole project keeps falling into: an empty tree passes every plaintext grep ever
        // written. Say out loud that the data root is full of the user's data, and that all of it is
        // ciphertext.
        expect(walk(dataRoot).length).toBeGreaterThan(150);
        expect(filesOnDisk.length).toBeGreaterThan(150);
    });

    // ---- the lock -------------------------------------------------------------------------------

    test('🔒 NOTHING was written while the vault was shut', () => {
        // The boot gate's whole premise, now against real encryption rather than a fixture.
        expect(deferred).toBe(true);
        expect(filesWhileLocked).toBe(0);
    });

    test('🔒 after a restart, a VALID SESSION COOKIE IS NOT ENOUGH', () => {
        // The cookie survives (cookie-secret.txt is on disk). The key does not (it was in RAM). the developer's tab
        // is still open and still authenticated -- and must still be made to log in again.
        expect(staleCookieStatus).toBe(403);
    });

    // ---- the cutover ----------------------------------------------------------------------------

    test('🔴 SillyTavern\'s DEFAULT CONTENT came back — encrypted', () => {
        // A "fresh" install is not empty: SillyTavern seeds ~196 files of themes, presets, backgrounds and
        // a sample character. The cutover wipes them, and SillyTavern puts them all back after unlock, as
        // deferred maintenance -- through the provider, so they land as ciphertext.
        //
        // This is the test that caught `<DATA_ROOT>/content.log` being mistaken for a user. The provider
        // claimed SillyTavern's global content log, failed to decrypt it, and SillyTavern SWALLOWED the
        // error and seeded nothing: no themes, no presets, no backgrounds, and no clue why.
        expect(defaultContentRestored).toBeGreaterThan(150);

        // And it is all ciphertext -- if any of it had been written in plaintext, the assertions above
        // would have found "Seraphina" in the sample card.
        expect(filesOnDisk.length).toBeGreaterThan(150);
    });
});
