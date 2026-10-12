import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { MockServer } from '../../util/mock-server.js';
import { getFreePort, releasePort } from '../../util/st-server.js';
import { DEPENDENCIES, preflight, serverDirectory } from '../preflight.mjs';
import { generate, login, makeMarker, panelText, post, prepareDataRoot, shareModelCache, startServer } from '../harness.mjs';

/**
 * 🔴 SUITE B §7 B7 — A MEMORY TOLD TO ONE CHARACTER MUST NOT SURFACE WHILE TALKING TO ANOTHER.
 *
 * This assertion has the most serious failure mode: everything
 * else in these suites fails by losing data, and this one fails by DISCLOSING it — handing one
 * character's confidences to another, in the user's own words, inside a product whose whole premise is
 * that those words are private.
 *
 * It cannot be borrowed from Mnemosyne's own suite. Scoping is a property of the entire chain: what the
 * fork resolves as identity, what Mnemosyne keys the memory on, and what its vector search filters by.
 * A unit test of the store proves the store filters on the key it was handed; it cannot prove the fork
 * hands it the right key, and that seam is the only thing these suites exist for.
 *
 * ⚠️ EVERY NEGATIVE HERE IS PAIRED WITH A POSITIVE, because "character B did not recall it" is equally
 * the output of a retrieval that returns nothing to anybody — a broken embedder, an empty store, a query
 * that silently failed. The same planted fact is required to reach character A. Neither half is worth
 * anything alone.
 *
 * 🔴 HOW THE TEST LEARNS `charId`, WHICH IS THE AWKWARD PART AND IS NOT AVOIDABLE.
 *
 * The client never sees a `charId`. It sends an avatar FILENAME and the fork swaps it for a stable id
 * out of a server-owned map (§22) — deliberately, so that a plugin can never be handed a filename. So a
 * test cannot plant a memory under "character A's id" by choosing one: it has to find out what the fork
 * minted. Mnemosyne logs the scope keys it searched, but only on a retrieval that HIT, which is circular
 * — you need a memory in scope to learn the scope.
 *
 * The circle is broken with the SCENARIO tier, which is keyed on `chatId`, and `chatId` is client-supplied
 * and passes through untouched. Plant a scenario memory in a known chat, generate in that chat as
 * character A, and the resulting hit logs BOTH scopes — including `u:<charId>:<personaId>`. That is where
 * the real id comes from, and it is why this suite runs with `debugMode` on: the scope line is on the
 * sensitive channel, which is silent otherwise.
 *
 * 🔴 AND THE DEBUG LOG GOES IN `temp/`, UNDER A NAME UNIQUE TO THIS RUN. The first version of this file
 * set `debugMode` and nothing else, which sent the sensitive stream to `st_DEBUG.log` in the REPOSITORY
 * ROOT — the shared, conventional name, which a concurrently running suite or a real install would also
 * be writing. `logging.file` is a base name joined onto the server directory, so a base of
 * `temp/<something>` lands it in the folder that is gitignored wholesale, and `afterAll` removes it.
 * This suite reads only the file it just told the server to write, containing only its own synthetic
 * strings.
 */

const PERSONA_ID = 'persona-test-user';
const AVATAR_A = 'IntegrationCharacterA.png';
const AVATAR_B = 'IntegrationCharacterB.png';

/**
 * The string that must never reach character B.
 *
 * 🔴 IT MUST NOT APPEAR IN WHAT THE USER TYPES, AND THE FIRST VERSION OF THIS FILE GOT THAT WRONG.
 * It sent the secret itself as the user's message, so the outgoing prompt contained it because the
 * USER had just said it — nothing to do with retrieval. That made the isolation assertion fail for the
 * wrong reason and, far worse, made its paired control PASS for the wrong reason: "A's turn carried the
 * memory" was true of any turn at all. The secret now rides inside a stored sentence, and the question
 * asked at generation time is a different string that merely means something similar.
 */
const SECRET = makeMarker('A-TOLD-ME-IN-CONFIDENCE');

/** What gets stored — the only place the secret is ever written. */
const MEMORY_TEXT = `The user's private recovery phrase is ${SECRET}, and it must never be repeated.`;

/** What the user asks at generation time. Semantically close, and free of the secret. */
const QUERY = 'What is my private recovery phrase?';

/** Something to make the bootstrap retrieval hit, so Mnemosyne logs the scopes it used. */
const BOOTSTRAP_FACT = 'the bootstrap fact that exists only to produce a hit';

/** Unique to this run, and inside `temp/` rather than beside `st.log`. See the header. */
const LOG_BASE = path.posix.join('temp', `mnemosyne-isolation-${process.pid}`);
const DEBUG_LOG = path.join(serverDirectory, `${LOG_BASE}_DEBUG.log`);

const gate = preflight('suite B — cross-character memory isolation', [DEPENDENCIES.vault, DEPENDENCIES.mnemosyne]);
const suite = gate.run ? describe : describe.skip;

/**
 * Pull the user-tier scope out of Mnemosyne's own log line, and with it the fork-minted charId.
 *
 * The line is `... scopes [u:<charId>:<personaId>, s:<chatId>]`. Only the `u:` scope is wanted; the
 * persona is known, so whatever sits between the two colons is the id the fork minted for that avatar.
 * @param {string} output The server's stdout
 * @returns {string[]} Every distinct charId seen, oldest first
 */
function charIdsFromLog(output) {
    const seen = [];

    for (const match of output.matchAll(/scopes \[u:([^:\]]*):/g)) {
        if (match[1] && !seen.includes(match[1])) {
            seen.push(match[1]);
        }
    }

    return seen;
}

suite('🔴 memories do not cross between characters', () => {
    /** @type {any} */
    let server;
    /** @type {string} */
    let base;
    /** @type {string} */
    let cookie;
    /** @type {MockServer} */
    let backend;
    /** @type {number} */
    let backendPort;

    /** The fork-minted ids for the two avatars. */
    let charIdA = null;
    let charIdB = null;

    /** What the panel said after generating as A, then as B, with only A's memory planted. */
    let panelAsA = '';
    let panelAsB = '';
    /** What the fork actually sent the model on each of those two turns. */
    let promptAsA = '';
    let promptAsB = '';

    beforeAll(async () => {
        // `initLogger` opens the file with `fs.openSync(..., 'a')` and creates no directories, so a
        // missing `temp/` would silently cost this suite its only source of scope keys.
        fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });

        backendPort = await getFreePort();
        backend = new MockServer({ port: backendPort, host: '127.0.0.1' });
        await backend.start();

        const prepared = await prepareDataRoot('integration-mnemosyne-isolation');
        shareModelCache(prepared.dataRoot);

        const boot = await startServer({
            ...prepared,
            withVault: true,
            pluginsPath: path.join(serverDirectory, 'plugins'),
            // ⚠️ ON, DELIBERATELY, AND STATED RATHER THAN INHERITED — the plan requires every integration
            // suite to set this explicitly. The scope keys this test needs are on the sensitive channel,
            // which is silent unless debug logging is on. The file goes in `temp/`; see the header.
            configEnv: {
                SILLYTAVERN_LOGGING_DEBUGMODE: 'true',
                SILLYTAVERN_LOGGING_FILE: LOG_BASE,
            },
        });

        server = boot.server;
        base = boot.base;
        cookie = await login(boot);

        // ── BOOTSTRAP: learn what the fork minted for each avatar ────────────────────────────────
        // A scenario memory is keyed on chatId, which the client controls, so this hits without anyone
        // needing to know a charId — and the hit is what makes Mnemosyne log the scopes.
        for (const [avatar, chatId] of [[AVATAR_A, 'bootstrap-a'], [AVATAR_B, 'bootstrap-b']]) {
            const planted = await post(base, '/api/plugins/mnemosyne/memory', {
                text: BOOTSTRAP_FACT, tier: 'scenario', chatId, personaId: PERSONA_ID,
            }, cookie);

            if (planted.status !== 201) {
                throw new Error(`Bootstrap plant failed (${planted.status}): ${JSON.stringify(planted.body)}`);
            }

            const driven = await generate({
                base, cookie, backendPort,
                text: BOOTSTRAP_FACT,
                identity: { charAvatar: avatar, personaId: PERSONA_ID, chatId },
            });

            if (driven.status !== 200) {
                throw new Error(`Bootstrap generation for ${avatar} failed (${driven.status}): ${JSON.stringify(driven.body)}`);
            }
        }

        const debugLog = fs.existsSync(DEBUG_LOG) ? fs.readFileSync(DEBUG_LOG, 'utf-8') : '';

        [charIdA, charIdB] = charIdsFromLog(debugLog);

        if (!charIdA || !charIdB) {
            // Loud, and carrying the evidence. Every downstream assertion here is about two DISTINCT
            // partitions, so a missing id is not a detail to work around — it means the suite cannot ask
            // its question, and the plan's §4 says that must never be a quiet pass.
            const mnemosyne = debugLog.split('\n').filter(line => line.includes('[Mnemosyne]')).slice(-15).join('\n');

            throw new Error(`Could not learn both charIds. Saw ${JSON.stringify(charIdsFromLog(debugLog))}.\n`
                + `Debug log ${fs.existsSync(DEBUG_LOG) ? `is ${debugLog.length} bytes` : 'DOES NOT EXIST'} at ${DEBUG_LOG}.\n`
                + `Last Mnemosyne lines:\n${mnemosyne || '(none)'}`);
        }

        // ── THE ACTUAL TEST: one durable fact, told to A ─────────────────────────────────────────
        const secret = await post(base, '/api/plugins/mnemosyne/memory', {
            text: MEMORY_TEXT, tier: 'user', charId: charIdA, personaId: PERSONA_ID, charName: 'IntegrationCharacterA',
        }, cookie);

        if (secret.status !== 201) {
            throw new Error(`Planting the secret failed (${secret.status}): ${JSON.stringify(secret.body)}`);
        }

        // A FRESH chat for both turns, so the scenario tier cannot supply the answer and the only thing
        // that can produce a hit is the user-tier scope — which is where charId lives.
        const chatId = 'the-isolation-chat';

        // 🔴 The panel fetches carry the SAME identity the generation turns carry — header and query, as the
        // real client sends on every panel fetch (`ambientParams()` + `pluginRequestHeaders()`). A bare GET
        // here does not mean "B's panel": with no identity Mnemosyne deliberately answers with the user's
        // whole store (the no-chat browsing view), and this suite spent an evening reading that fallback as
        // a cross-character leak. With identity present, "Everything" is bounded to this character's user
        // tier plus this chat's scenario tier, and B7 is actually the question being asked.
        await generate({ base, cookie, backendPort, text: QUERY, identity: { charAvatar: AVATAR_A, personaId: PERSONA_ID, chatId } });
        panelAsA = (await panelText({ base, cookie, route: '/api/plugins/mnemosyne/panel', identity: { charAvatar: AVATAR_A, personaId: PERSONA_ID, chatId } })).text;
        promptAsA = JSON.stringify(backend.requests[backend.requests.length - 1] ?? {});

        await generate({ base, cookie, backendPort, text: QUERY, identity: { charAvatar: AVATAR_B, personaId: PERSONA_ID, chatId } });
        panelAsB = (await panelText({ base, cookie, route: '/api/plugins/mnemosyne/panel', identity: { charAvatar: AVATAR_B, personaId: PERSONA_ID, chatId } })).text;
        promptAsB = JSON.stringify(backend.requests[backend.requests.length - 1] ?? {});
    }, 600_000);

    afterAll(async () => {
        await server?.stop();
        await backend?.stop();
        releasePort(backendPort);

        // The debug log holds this suite's own synthetic conversation in clear text. It is in `temp/`,
        // which is gitignored wholesale, but it is still cleartext on the disk of a repository whose
        // entire point is that conversation content is not — so it goes when the suite goes.
        for (const suffix of ['_DEBUG.log', '.log']) {
            fs.rmSync(path.join(serverDirectory, `${LOG_BASE}${suffix}`), { force: true });
        }
    });

    test('🆔 the fork minted DIFFERENT ids for the two avatars', () => {
        // If this failed, everything below would pass for the wrong reason: one id means one partition,
        // and "no leak between characters" would be a statement about a single character.
        expect(charIdA).toBeTruthy();
        expect(charIdB).toBeTruthy();
        expect(charIdA).not.toBe(charIdB);
    });

    test('✅ CONTROL: character A DOES recall what it was told', () => {
        // 🔴 The load-bearing half. Without it, the isolation assertion below is satisfied by a retrieval
        // that never returns anything to anyone.
        expect(String(panelAsA)).toContain(SECRET);
    });

    test('🔴 and character B does NOT — not in the panel', () => {
        expect(String(panelAsB)).not.toContain(SECRET);
    });

    test('🔴 and not in the prompt the fork actually sent the model', () => {
        // The panel is Mnemosyne's report of itself. This is the ground truth: what left the fork. A
        // retrieval that leaked into the prompt but drew no panel entry would still be a disclosure.
        expect(promptAsB).not.toContain(SECRET);
    });

    test('🧾 the control holds on the prompt too — A\'s turn really carried the memory', () => {
        // Pinned separately from the panel for the same reason: the panel could report a hit that never
        // reached the model, which would mean the memory system does nothing at all.
        expect(promptAsA).toContain(SECRET);
    });
});
