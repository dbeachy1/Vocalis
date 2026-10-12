import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { diffManifests, isUserData, takeManifest } from './util/data-root-manifest.js';
import { installStorageProvider, makeScratchDirectory, pokeDestructiveEndpoints, readJournal, startSillyTavern } from './util/st-server.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const HOSTILE_PROVIDER = path.join(testDirectory, 'fixtures', 'hostile-provider.js');

/**
 * The bait.
 *
 * A chat that REFERENCES an image, and the image it references. This is what makes the data-maid test
 * mean something. Without it the user's image directory is empty, data-maid finds nothing to
 * misclassify, and the most dangerous endpoint in SillyTavern sails through the gate untested.
 *
 * With it: a working SillyTavern reads the chat, sees the reference, and knows the image is in use. A
 * SillyTavern that cannot read the chat sees NO references at all — and concludes that the image is an
 * orphan, and offers to delete it. The user, looking at a report they have every reason to trust,
 * says yes.
 * @param {string} dataRoot The data root to plant it in
 * @returns {{image: string, chat: string, file: string}} The planted paths
 */
function plantTheBait(dataRoot) {
    const userRoot = path.join(dataRoot, 'default-user');

    const image = path.join(userRoot, 'user', 'images', 'keepsake.png');
    const file = path.join(userRoot, 'user', 'files', 'notes.txt');
    const chat = path.join(userRoot, 'chats', 'TestCharacter', 'a chat.jsonl');

    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(chat), { recursive: true });

    fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a-not-really-a-png', 'utf-8'));
    fs.writeFileSync(file, 'A Data Bank document the user cares about.');

    // data-maid resolves `extra.image` relative to the user's root, so this is a live reference.
    const messages = [
        { user_name: 'User', create_date: '2026-07-13', chat_metadata: {} },
        { name: 'TestCharacter', mes: 'Look at this.', extra: { image: 'user/images/keepsake.png' } },
    ];
    fs.writeFileSync(chat, messages.map(m => JSON.stringify(m)).join('\n'));

    return { image, chat, file };
}

/**
 * 🔴 THE HARD GATE.
 *
 * SillyTavern is booted against a storage provider whose every content read throws, and is then driven
 * through the endpoints that destroy things. It must come out the other side having deleted nothing,
 * regenerated nothing, and rewritten nothing.
 *
 * ## Two false greens, and what they taught
 *
 * **The first draft passed.** "Boot against a hostile provider, assert no files changed" is VACUOUS
 * while the funnel is incomplete: if SillyTavern never calls the provider, it reads the plaintext
 * behind its back, finds it all perfectly readable, does no destructive work, and the data root comes
 * through pristine. Green. Proving nothing. Fixed by making the provider JOURNAL every call, and asking
 * the prior question — did you go through the front door? — before asking did you break anything.
 *
 * **The second draft passed at F2**, two milestones early. It only ever tested BOOT. But not one of the
 * six destructive paths runs at boot: data-maid's orphan sweep, the self-deleting vector index and the
 * self-repairing character cache are all REQUEST-time code. A gate that never makes an HTTP request has
 * never once exercised the thing it exists to prevent. Fixed by holding the server open and driving it.
 *
 * The lesson both times: a scoreboard that is green while the job is unfinished is worse than no
 * scoreboard, because it ends the investigation. When this goes green, ask what it is NOT testing.
 */
describe('🔴 the hard gate: SillyTavern must survive a hostile storage provider', () => {
    /** @type {string} */
    let scratch;
    /** @type {import('./util/st-server.js').BootResult} */
    let boot;
    /** @type {ReturnType<typeof diffManifests>} */
    let damage;
    /** @type {ReturnType<typeof readJournal>} */
    let journal;
    /** @type {import('./util/st-server.js').EndpointResult[]} */
    let endpoints;

    beforeAll(async () => {
        scratch = makeScratchDirectory('boot-gate');
        const dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const providersPath = path.join(scratch, 'storage-providers');
        const journalPath = path.join(scratch, 'journal.jsonl');

        // 1. Boot once on the plain filesystem, and drive the same endpoints, so the data root is a
        //    complete and realistic one: the default user, their settings, stats, the bundled
        //    characters, backgrounds and presets, and a warm character cache. This is the plaintext
        //    install we are about to threaten.
        const seed = await startSillyTavern({ dataRoot, configPath });

        if (!seed.listening) {
            throw new Error(`The seed boot never came up, so the gate cannot run.\n\n${seed.output()}`);
        }

        await pokeDestructiveEndpoints(seed.port);
        await seed.stop();

        // 1b. Plant a chat that references an image, and the image it references. Without this the
        //     user's image directory is empty and data-maid has nothing to misclassify — the most
        //     dangerous endpoint in the codebase would sail through untested.
        plantTheBait(dataRoot);

        // 2. Photograph it, byte for byte.
        const before = takeManifest(dataRoot);

        if (![...before.keys()].some(isUserData)) {
            throw new Error('The seed boot produced no user data, so this test would prove nothing.');
        }

        // 3. Now do it again against a provider that refuses to decode a single byte — and this time
        //    drive the endpoints that delete things.
        installStorageProvider(providersPath, HOSTILE_PROVIDER);
        const hostile = await startSillyTavern({ dataRoot, configPath, storageProvidersPath: providersPath, journalPath });

        endpoints = hostile.listening ? await pokeDestructiveEndpoints(hostile.port) : [];
        boot = await hostile.stop();

        // 4. Count the bodies, and read back what the provider was actually asked to do.
        damage = diffManifests(before, takeManifest(dataRoot), isUserData);
        journal = readJournal(journalPath);
    }, 240_000);

    afterAll(() => {
        if (scratch) {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    // ---- preconditions: if these fail, the gate is not testing anything at all ------------------

    test('the hostile provider was registered', () => {
        expect(boot.output).toContain('hostile-provider');
    });

    test('SillyTavern SURVIVED the boot', () => {
        // Refusing to read is not permission to fall over. A locked vault must still serve a login
        // page, so a broken one must too.
        expect(boot.listening).toBe(true);
    });

    test('the destructive endpoints were actually reached', () => {
        // Guards against the whole request-time half of this gate silently not running.
        expect(endpoints.map(e => e.label)).toContain('data-maid/report');
        expect(endpoints.length).toBeGreaterThan(0);
    });

    // ---- did SillyTavern go through the front door? ---------------------------------------------

    test('🔴 SillyTavern ASKED THE PROVIDER for the user\'s data', () => {
        // If this is empty, every assertion below is vacuous: ST is reading user data through raw `fs`,
        // the provider is decorative, and an encryption plugin behind it would protect nothing at all.
        expect(journal.reads.length).toBeGreaterThan(0);
    });

    test('🔴 every boot-time subsystem that reads user content went through the provider', () => {
        // A regression guard with teeth. stats.js used to alias `fs.promises.readFile` into a local
        // const — an alias is not a call site, so it hid the ENTIRE stats subsystem (every line of every
        // chat) from any grep for `fs.readFile(`. Revert that alias and this goes red.
        const touched = journal.reads.map(entry => entry.path);
        const wanted = [
            { label: 'statsInit (stats.json)', match: p => p === 'default-user/stats.json' },
            { label: 'checkForNewContent (content.log)', match: p => p === 'default-user/content.log' },
            { label: 'settingsInit (backups/)', match: p => p.startsWith('default-user/backups/') },
        ];

        expect(wanted.filter(w => !touched.some(w.match)).map(w => w.label)).toEqual([]);
    });

    test('🔴 the character cache went through the provider, and did NOT rebuild itself in plaintext', () => {
        // The subtlest hole in the whole design, and it hides behind a CACHE HIT.
        //
        // The parsed-card cache is a node-persist store, and node-persist writes its own files — no
        // funnel catches them. If the provider does not control that store's serializer, SillyTavern
        // gets a perfectly good cache hit for every character, never reads the PNG, never calls the
        // provider at all, and cheerfully serves the user's entire character library out of a plaintext
        // cache while the vault sits there "locked". Nothing errors. Nothing looks wrong.
        //
        // So: the store's serializer must reach the provider (kv:parse), and when it fails, the endpoint
        // must FAIL — not fall through, re-parse the PNG, and write the entry back out in cleartext,
        // which is precisely what forgiveParseErrors:true used to make it do.
        const wentThroughProvider = journal.all.some(entry => entry.op === 'kv:parse');
        const characters = endpoints.find(e => e.label === 'characters/all');

        expect(wentThroughProvider).toBe(true);
        expect(characters.status).toBeGreaterThanOrEqual(400);
    });

    // ---- having failed to read it, did it destroy anything? -------------------------------------

    test('NOTHING WAS DELETED', () => {
        // data-maid reports every image and Data Bank file as an orphan when the chats that reference
        // them cannot be parsed, and then offers to delete them. The vector index hard-deletes itself
        // on a SyntaxError, with no prompt at all.
        expect(damage.deleted).toEqual([]);
    });

    test('NOTHING WAS REGENERATED OR REWRITTEN', () => {
        // stats.json is the loud one: a parse failure re-scans every line of every chat of every
        // character and overwrites it. The character cache is the quiet one — a decode failure is a
        // silent miss, and the miss is repaired by writing the card back in CLEARTEXT.
        expect(damage.modified).toEqual([]);
    });

    test('NOTHING NEW WAS WRITTEN', () => {
        expect(damage.created).toEqual([]);
    });

    test('SillyTavern never tried to WRITE data it had failed to READ', () => {
        // The same property caught at the other end. The manifest proves nothing landed on disk; the
        // journal proves ST never even reached for the pen. It is the stronger statement, and it still
        // holds in the case where a write happens to be a no-op.
        expect(journal.writes.map(entry => `${entry.op} ${entry.path}`)).toEqual([]);
    });

    test('🔴 data-maid REFUSED to report, rather than reporting the user\'s files as orphans', () => {
        // The single most dangerous endpoint in SillyTavern. #parseChatFile returns [] on any throw, so
        // unreadable chats mean an EMPTY set of known images — and every image the user owns is then
        // classified as an orphan and offered up for deletion. The user confirms, believing the report.
        //
        // It must REFUSE. An unreadable chat is not an absent chat, and a report built on unreadable
        // chats is not a report, it is a trap.
        const report = endpoints.find(e => e.label === 'data-maid/report');

        expect(report).toBeDefined();
        expect(report.status).toBeGreaterThanOrEqual(400);
    });

    // ---- was it loud? ---------------------------------------------------------------------------

    test('every failure was LOUD', () => {
        // A broken store must be an error, never an empty result. Silence is the precondition for every
        // destructive path in the codebase.
        expect(boot.output).toContain('EPROVIDER');
    });

    test('no failure was mistaken for CORRUPTION', () => {
        // The distinction the entire fail-safe contract rests on. A provider error means "the data is
        // there and I cannot decode it". A SyntaxError means "the data is garbage" — and SillyTavern
        // answers *that* by deleting the vector index, re-scanning the chat corpus, or rewriting the
        // character cache in cleartext. If a provider failure ever surfaces as a SyntaxError, every
        // destructive path in the codebase is armed.
        expect(boot.output).not.toContain('SyntaxError');
    });
});

/**
 * 🔴 THE TOTALITY GATE (F3).
 *
 * The Storage Provider API rests on one rule, and the rule has to be TOTAL:
 *
 *     provider.owns(p)  ⟺  p is under <DATA_ROOT>/<handle>/
 *
 * If that holds, a provider's ownership test is one line and cannot be forgotten. Today SillyTavern
 * breaks it in four places, and every one of them is a leak that a naive implementation — one that
 * scopes itself to the user directory template and stops there — would miss completely.
 *
 * This suite runs against STOCK SillyTavern, with no provider at all. It does not care what a provider
 * would do. It asserts the shape of the data root itself: that no user data is written anywhere a
 * provider would never think to look.
 */
describe('🔴 the totality gate: no user data outside a user directory', () => {
    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;

    beforeAll(async () => {
        scratch = makeScratchDirectory('totality');
        dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');

        const server = await startSillyTavern({ dataRoot, configPath });

        if (!server.listening) {
            throw new Error(`Stock SillyTavern never came up.\n\n${server.output()}`);
        }

        // Warm the parsed-card cache. It is populated lazily, on the app-load path, so a boot alone
        // does not fill it — which is exactly how it stays invisible.
        await pokeDestructiveEndpoints(server.port);
        await server.stop();
    }, 180_000);

    afterAll(() => {
        if (scratch) {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    test('🔴 the parsed-card cache does not live outside a user directory', () => {
        // <DATA_ROOT>/_cache/characters holds every character card FULLY PARSED and in cleartext JSON:
        // description, personality, first_mes, system_prompt, the lot. The filename is a sha256, which
        // sounds reassuring right up until you read the body — the key is stored INSIDE the file, and
        // the key is the card's absolute path. So it leaks the character's real filename too.
        //
        // Encrypting characters/ and leaving this behind achieves precisely nothing.
        const cachedCards = path.join(dataRoot, '_cache', 'characters');
        const entries = fs.existsSync(cachedCards) ? fs.readdirSync(cachedCards) : [];

        expect(entries).toEqual([]);
    });

    test('boot and the app-load path stage nothing in the global uploads directory', () => {
        // <DATA_ROOT>/_uploads is where EVERY import lands in the clear before a single line of
        // SillyTavern's code runs: character PNGs, chat JSONL, world info, speech-to-text audio.
        //
        // ⚠️ THIS IS A REGRESSION GUARD, NOT THE PROOF THAT THE STAGING MOVED, and it used to be named as
        // though it were the latter. This suite performs no multipart request — `pokeDestructiveEndpoints`
        // sends five JSON POSTs — and multer creates the directory lazily inside its per-request
        // `destination` callback, so this is empty on stock upstream too and cannot tell the fork from it.
        // Driving a real upload here would need a CSRF round-trip, because the CSRF middleware is mounted
        // above multer. The property IS covered, under a provider and with a real staged file, by
        // `storage-provider-upload-staging.test.js` and `storage-provider-seams.test.js`.
        //
        // What it still earns its place for: if anything ever started staging globally at BOOT or on the
        // app-load path, this catches it, and neither of those suites is looking there.
        const uploads = path.join(dataRoot, '_uploads');
        const entries = fs.existsSync(uploads) ? fs.readdirSync(uploads) : [];

        expect(entries).toEqual([]);
    });

    // ⚠️ ALSO A REGRESSION GUARD RATHER THAN A DEMONSTRATION. No avatar is ever set in this suite, and the
    // fork no longer has a code path that would write one here — `toAvatarKey` is passed to `getItem` and
    // `removeItem` inside the one-way migration in users.js and to `setItem` nowhere at all. So the corpus
    // scanned below has never contained an image and this is true before and after the fix. Left in place
    // because it is nearly free and the day someone reintroduces an avatar write is the day it matters;
    // renamed so nobody reads it as evidence the migration works.
    test('the accounts store has not reacquired user content', () => {
        // <DATA_ROOT>/_storage is the accounts DB, and it must stay readable while everything else is
        // locked — you cannot check a password without it. That is fine, because a scrypt verifier is
        // not a secret. What is NOT fine is that it also holds the user's avatar, as a base64 data URI:
        // a 744 KB JPEG sitting in a key-value store, served to unauthenticated clients on the login
        // page. It is user content, and it has no business being in the one store we cannot encrypt.
        const accounts = path.join(dataRoot, '_storage');
        const files = fs.existsSync(accounts) ? fs.readdirSync(accounts) : [];
        const withImages = files.filter(f => {
            const contents = fs.readFileSync(path.join(accounts, f), 'utf-8');
            return contents.includes('data:image');
        });

        expect(withImages).toEqual([]);
    });

    test('🔴 user CSS does not live outside a user directory', () => {
        // <DATA_ROOT>/_css is user-authored content living outside every user directory — which puts it
        // outside the provider's reach. Nothing serves it any more (userCssMiddleware reads per-user
        // files, below the auth boundary), so what this pins is the at-rest rule: the directory's one
        // sanctioned occupant is the TRANSIENT parking spot migratePublicOverrides uses to get a legacy
        // web-root user.css out of `public/` at boot, and a fresh install has no legacy file — so after
        // two boots of a fresh install it must hold nothing at all.
        const css = path.join(dataRoot, '_css');
        const entries = fs.existsSync(css) ? fs.readdirSync(css) : [];

        expect(entries).toEqual([]);
    });
});
