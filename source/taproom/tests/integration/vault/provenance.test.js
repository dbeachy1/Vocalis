import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { DEPENDENCIES, preflight, serverDirectory } from '../preflight.mjs';
import { chatBody, login, makeMarker, post, prepareDataRoot, saveChat, startServer } from '../harness.mjs';

/**
 * 🔗 SUITE A §7.5 — the provenance surfaces report the provider that is REALLY there.
 *
 * `DESIGN_STORAGE_PROVENANCE.md` is built and its own tests pass, but every one of them asks a fixture
 * to declare an identity and then checks the fork stored what the fixture said. That proves the
 * plumbing. It cannot prove the plumbing is connected to Vault, because no fixture has ever been Vault.
 *
 * So the version assertion here is deliberately end-to-end and deliberately awkward: it reads Vault's
 * `package.json` off the disk and requires the number the fork reports to equal it. Every link has to
 * hold for that to pass — Vault reads its own manifest, declares it through `describe('storage.identity')`,
 * the fork validates it, writes it to the registry, and hands it back out of an endpoint. Vault's own
 * source carries a comment about this exact number silently becoming `'unknown'` under a test runner
 * for a while, which is the failure this shape catches and an equality against a constant would not.
 */

const CHARACTER = makeMarker('ProvenanceCharacter');
const PERSONA = 'Test User';
const CHAT_FILE = 'the-provenance-chat';

const gate = preflight('suite A — the provenance surfaces', [DEPENDENCIES.vault]);
const suite = gate.run ? describe : describe.skip;

/**
 * What Vault's manifest says about itself, read straight off the disk.
 * @returns {string} The version
 */
function vaultVersionFromDisk() {
    const manifest = path.join(serverDirectory, 'storage-providers', 'vault', 'package.json');
    return JSON.parse(fs.readFileSync(manifest, 'utf-8')).version;
}

suite('🪪 the provenance surfaces name the real Vault', () => {
    /** @type {any} */
    let server;
    /** @type {object} */
    let registry;
    /** @type {object} */
    let chatStatus;

    beforeAll(async () => {
        const prepared = await prepareDataRoot('integration-vault-provenance');
        const boot = await startServer({ ...prepared, withVault: true });

        server = boot.server;

        const cookie = await login(boot);
        const saved = await saveChat(boot.base, cookie, CHARACTER, CHAT_FILE, chatBody(CHARACTER, PERSONA, ['a chat that needs a provider to read']));

        if (saved.status !== 200) {
            throw new Error(`Saving through Vault failed (${saved.status}): ${JSON.stringify(saved.body)}`);
        }

        // ⚠️ `name` carries the EXTENSION, and the endpoint does not add one. `resolveChatPath` joins the
        // name it is given verbatim, so a bare `the-provenance-chat` resolves to a path that does not
        // exist — which comes back as an honest "plaintext" rather than an error, and reads exactly like
        // Vault having failed to encrypt anything. `chat-storage-markers.js` appends `.jsonl` before it
        // asks, and a suite that asked differently would be testing a call the client never makes.
        const status = await post(boot.base, '/api/storage/chat-status', {
            chats: [{ name: `${CHAT_FILE}.jsonl`, directory: CHARACTER }],
        }, cookie);

        if (status.status !== 200) {
            throw new Error(`chat-status refused the request (${status.status}): ${JSON.stringify(status.body)}`);
        }

        chatStatus = status.body;

        // 🔴 Beside the CONFIG, never inside the data root — `registryPathFor` refuses the latter outright,
        // because a registry sitting in the directory the threat model assumes is attacker-writable would be
        // forgeable by exactly the party it exists to identify. The suites pass `--configPath` into scratch,
        // so this is where the fork puts it.
        const registryPath = path.join(path.dirname(prepared.configPath), 'providers.json');

        if (!fs.existsSync(registryPath)) {
            throw new Error(`The fork wrote no provenance registry at ${registryPath}.`);
        }

        registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    }, 240_000);

    afterAll(async () => {
        await server?.stop();
    });

    test('📓 the registry recorded Vault, under the id that is on the files', () => {
        expect(Object.keys(registry.providers ?? {})).toContain('vault');
        expect(registry.providers.vault.name).toBe('SillyTavern-Vault');
        expect(registry.providers.vault.source).toBe('https://github.com/dbeachy1/SillyTavern-Vault');
    });

    test('🔢 the recorded version is the one in Vault\'s own package.json', () => {
        const onDisk = vaultVersionFromDisk();

        // Vacuity guard: `'unknown' === 'unknown'` would pass an equality between two failures.
        expect(onDisk).toMatch(/^\d+\.\d+\.\d+/);
        expect(registry.providers.vault.version).toBe(onDisk);
    });

    test('📼 and the envelope versions it can read are recorded as numbers', () => {
        const versions = registry.providers.vault.envelopeVersions;

        expect(Array.isArray(versions)).toBe(true);
        expect(versions.length).toBeGreaterThan(0);
        expect(versions.every(one => Number.isInteger(one))).toBe(true);
    });

    test('🔐 the chat reports as encrypted, readable, and needing "vault"', () => {
        const state = chatStatus.chats?.[`${CHAT_FILE}.jsonl`];

        // Vacuity guard: an absent entry is not a passing assertion about an entry.
        expect(state).toBeDefined();

        // 🔴 `requiresProvider` is NULL here, and that is the correct answer rather than a missing one.
        // It names what you would have to INSTALL to read the file, so it is populated only when nothing
        // installed can — `describeStorageState` returns it null on the readable path. Asserting `'vault'`
        // was wrong: it is the sentence for a chat whose plugin is GONE, and demanding it while the plugin
        // is running would have pinned the uninstalled rendering as the healthy one.
        //
        // Written as one object so a failure prints the whole state instead of `false`.
        expect(state).toMatchObject({ encrypted: true, unavailable: false, requiresProvider: null });
        expect(state.requiresUpdate).toBeFalsy();
    });

    test('🗣️ the marker on the chat list is Vault\'s sentence, not the fork\'s', () => {
        // The fork has no default to fall back on, so anything non-empty here came out of the provider.
        expect(typeof chatStatus.marker).toBe('string');
        expect(chatStatus.marker.length).toBeGreaterThan(0);
    });
});
