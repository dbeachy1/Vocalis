import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { DEPENDENCIES, preflight } from '../preflight.mjs';
import {
    chatBody,
    collectFiles,
    findMarker,
    getChat,
    login,
    makeMarker,
    prepareDataRoot,
    saveChat,
    startServer,
} from '../harness.mjs';
import { parseEnvelopeHeader } from '../../../src/storage-envelope.js';

/**
 * 🔗 SUITE A — a chat goes through the app and comes back, and the bytes it left behind are ciphertext.
 *
 * `PLAN_INTEGRATION_TESTS.md` §7 A2, A3 and A4, in one file because A3 has nothing to assert on until
 * A2 has put something on the disk.
 *
 * 🔴 THE CONTROL IS THE POINT OF THIS FILE, and it runs FIRST. "The marker was not found on disk" is
 * the output of a working detector over an encrypted tree and of a broken detector over ANY tree, and
 * from the passing tick those two are the same thing. So the same marker is first written through a
 * plaintext path — the identical server, the identical endpoint, the identical account, with the
 * provider as the ONLY difference — and {@link findMarker} must find it there. A detector that cannot
 * be shown to fire is not evidence of anything.
 *
 * ⚠️ The oracle is deliberately NOT Vault's own `bin/verify.js`. A control sharing its oracle with the
 * thing under test cannot fail independently of it. The positive half of the check — "these bytes are
 * an envelope, and it claims the id `vault`" — uses the FORK's `parseEnvelopeHeader`, which is the
 * other side of the contract rather than the same side of it.
 */

/**
 * ⚠️ UNIQUE PER RUN, and not a name SillyTavern ships.
 *
 * The first draft called this character `Seraphina` and the name assertion failed — because Seraphina
 * is the DEFAULT character the fork lays down in every new data root, sprites and all, during the seed
 * boot that runs before Vault is installed. Those files are pre-existing plaintext, which mixed mode
 * leaves alone by design, so the suite was reading correct behaviour as a leak. A unique name makes
 * "this string appears nowhere on disk" mean what it says: nothing but our own traffic can produce it.
 */
const CHARACTER = makeMarker('SuiteACharacter');
const PERSONA = 'Test User';
const CHAT_FILE = 'the-integration-chat';

/** Fresh per run, so a stale scratch directory can neither create a hit nor hide one. */
const MARKER = makeMarker('SUITE-A-CHAT-SECRET');

/** What the user said. The marker rides inside it, which is what must never reach the disk in clear. */
const USER_LINE = `Remember this exactly: ${MARKER}`;

const gate = preflight('suite A — the chat round trip and the bytes at rest', [DEPENDENCIES.vault]);
const suite = gate.run ? describe : describe.skip;

suite('🔗 a chat through the real Vault', () => {
    /** @type {any} */
    let vaultServer;
    /** @type {string} */
    let vaultScratch;
    /** @type {string} */
    let vaultDataRoot;

    /** Everything the plaintext control found — the proof the detector works at all. */
    let controlLeaks = [];
    /** Leaks in the encrypted tree while the server was still up. */
    let liveLeaks = [];
    /** Leaks in the encrypted tree after a clean shutdown. */
    let restLeaks = [];
    /** What the app handed back when asked for the chat it had just saved. */
    let readBack;

    beforeAll(async () => {
        // ── THE CONTROL ──────────────────────────────────────────────────────────────────────────
        // The same server, the same endpoint, the same account, the same marker — and no provider.
        // If the detector cannot find the marker HERE, every assertion below it is vacuous.
        const control = await prepareDataRoot('integration-vault-control');
        const controlBoot = await startServer({ ...control, withVault: false });

        try {
            const cookie = await login(controlBoot);
            const saved = await saveChat(controlBoot.base, cookie, CHARACTER, CHAT_FILE, chatBody(CHARACTER, PERSONA, [USER_LINE]));

            if (saved.status !== 200) {
                throw new Error(`The control could not save a chat (${saved.status}): ${JSON.stringify(saved.body)}`);
            }
        } finally {
            await controlBoot.server.stop();
        }

        controlLeaks = findMarker(control.scratch, MARKER);

        // ── THE REAL THING ───────────────────────────────────────────────────────────────────────
        const vault = await prepareDataRoot('integration-vault-at-rest');
        vaultScratch = vault.scratch;
        vaultDataRoot = vault.dataRoot;

        const boot = await startServer({ ...vault, withVault: true });
        vaultServer = boot.server;

        const cookie = await login(boot);
        const saved = await saveChat(boot.base, cookie, CHARACTER, CHAT_FILE, chatBody(CHARACTER, PERSONA, [USER_LINE]));

        if (saved.status !== 200) {
            throw new Error(`Saving through Vault failed (${saved.status}): ${JSON.stringify(saved.body)}`);
        }

        readBack = await getChat(boot.base, cookie, CHARACTER, CHAT_FILE);

        // Scanned twice on purpose. A temporary file that exists only while the server is up is still
        // a plaintext copy of the user's conversation, and a scan that only ever ran after shutdown
        // would never see one.
        liveLeaks = findMarker(vaultScratch, MARKER);

        await vaultServer.stop();
        vaultServer = null;

        restLeaks = findMarker(vaultScratch, MARKER);
    }, 240_000);

    afterAll(async () => {
        await vaultServer?.stop();
    });

    test('🧪 CONTROL: the detector finds the marker when nothing encrypted it', () => {
        // 🔴 The load-bearing test. Everything below is worthless if this one does not fail on demand.
        expect(controlLeaks.length).toBeGreaterThan(0);
        expect(controlLeaks.some(leak => leak.where === 'utf-8')).toBe(true);
    });

    test('🔁 the chat round-trips through the app with its content intact', () => {
        expect(readBack.status).toBe(200);
        expect(Array.isArray(readBack.body)).toBe(true);

        // Vacuity guard: an empty array also "contains no wrong content".
        const lines = readBack.body.filter(entry => typeof entry?.mes === 'string');
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.map(entry => entry.mes)).toContain(USER_LINE);
    });

    test('🔒 the marker is nowhere on disk while the server is running', () => {
        expect(liveLeaks).toEqual([]);
    });

    test('🔒 and nowhere on disk after a clean shutdown', () => {
        expect(restLeaks).toEqual([]);
    });

    test('📦 the chat file on disk is an envelope, and it claims the id "vault"', () => {
        const envelopes = collectFiles(vaultDataRoot)
            .map(file => ({ file, header: parseEnvelopeHeader(fs.readFileSync(file)) }))
            .filter(entry => entry.header !== null);

        // Vacuity guard: "no file failed the envelope check" is also true of an empty data root.
        expect(envelopes.length).toBeGreaterThan(0);

        // Named rather than counted, so a failure says WHICH file claimed WHAT instead of `false`.
        const foreign = envelopes.filter(entry => entry.header.providerId !== 'vault').map(entry => ({ file: entry.file, id: entry.header.providerId }));
        expect(foreign).toEqual([]);
    });

    test('🏷️ names are encrypted at rest — `venc1~`, and the plaintext title appears nowhere', () => {
        const names = collectFiles(vaultDataRoot).map(file => path.basename(file));

        expect(names.some(name => name.startsWith('venc1~'))).toBe(true);
        expect(names).not.toContain(`${CHAT_FILE}.jsonl`);

        // The character name is a DIRECTORY component rather than a file, so it is checked against the
        // whole path: a chats tree that still named the character out loud would leak who the user talks
        // to even with every message body sealed. Vault does encrypt it — the chat lands at
        // `chats/venc1~…/venc1~….jsonl` — and this is what would notice if it stopped.
        const paths = collectFiles(vaultDataRoot);
        expect(paths.filter(one => one.includes(CHARACTER))).toEqual([]);
    });
});
