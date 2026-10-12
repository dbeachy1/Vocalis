import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { MockServer } from '../../util/mock-server.js';
import { getFreePort, releasePort } from '../../util/st-server.js';
import { DEPENDENCIES, preflight, serverDirectory } from '../preflight.mjs';
import {
    collectFiles,
    findMarker,
    generate,
    getText,
    login,
    makeMarker,
    post,
    prepareDataRoot,
    shareModelCache,
    startServer,
} from '../harness.mjs';

/**
 * 🔴 THE ASSERTION ONLY THIS REPOSITORY CAN MAKE — `PLAN_INTEGRATION_TESTS.md` §7, and the plan calls
 * it the highest-value item in it: with the REAL Vault and the REAL Mnemosyne installed, no
 * conversation content reaches `st.log`.
 *
 * `tests/log-canary.test.js` has proved the fork's own log hygiene since `DESIGN_LOG_HYGIENE.md` §6 was
 * written, and it is a good test — but it proves it against FIXTURE plugins and providers. The real
 * ones are the only two that will ever run in a deployment, they run IN-PROCESS with the fork, and
 * they log through `context.logger` on paths no fixture reproduces. Both of them decide their own
 * classification, one call site at a time, in repositories this one does not control:
 *
 *   - `storage-providers/vault/src/logging.js` — reads `LogClass` off the context it was handed rather
 *     than using its own constants, precisely so a renumbered enum cannot turn its `SENSITIVE` lines
 *     into published ones.
 *   - `plugins/SillyTavern-Mnemosyne/src/logging.js` — the same, plus its own §5.6 rule that memory
 *     text is never logged through EITHER channel.
 *
 * Every one of those is a claim made in another repository. This file is where the three are checked
 * together, in one process, against a running stack — which is the only place the claim is true or
 * false.
 *
 * ## The control, which is the half that matters
 *
 * "No canary found in the log" is equally the output of a working gate and of traffic that never
 * reached a log call site at all — a typo'd route, a 404 nobody noticed, a plugin that silently failed
 * to load. So the identical traffic is driven a second time with `logging.debugMode` on, where every
 * canary MUST appear. That run is what gives the quiet run its meaning: together they say *these
 * strings reached the logger, and the classification gate is the only reason they are not on disk*.
 *
 * ⚠️ Two further vacuity guards are specific to THIS file, because the canary pair above would hold
 * just as well against a stack with neither dependency in it — which is the exact thing being tested:
 *
 *   - Mnemosyne's `[Mnemosyne] Recalled …` line is `NORMAL`, so it SURVIVES into the quiet log. Its
 *     presence there proves the plugin was loaded and retrieval actually hit during the very run whose
 *     log is being called clean.
 *   - The chat saved during that same run is checked to be ciphertext at rest. That proves Vault was
 *     live, and it states `DESIGN_LOG_HYGIENE.md` §3 literally, on one string, in one run: *nothing
 *     that is ciphertext at rest may appear as plaintext in a log*.
 *
 * ## It was verified by breaking it, twice
 *
 * `DESIGN_LOG_HYGIENE.md` §6.2 sets the standard: *a canary test that has never failed for the right
 * reason is decoration.* Two mutations, each reverted, each red for exactly the right canaries:
 *
 *   1. `chat-completions.js`'s `'Chat Completion request:'` flipped `SENSITIVE` → `NORMAL` — the same
 *      call site §6.2 used, so the two verifications are comparable. Red naming `MESSAGE` and
 *      `SECRET`: the user's words, and the memory Mnemosyne had injected into the same body.
 *   2. `plugin-loader.js` handing plugins a `LogClass` whose `SENSITIVE` collides with `NORMAL` — the
 *      enum-drift fail-open Mnemosyne's own `logging.js` says it fears. Red naming `CHARACTER`,
 *      `CHAT_ID` and `PERSONA`, in the file AND on the terminal. **That is the seam no test in any of
 *      the three repositories covered before this file.**
 *
 * ⚠️ A third mutation was tried first and was WRONG, which is worth recording because it looks right:
 * handing plugins `SENSITIVE: 99` — a merely *renumbered* enum — and the suite stayed green. Correctly.
 * The fork's gate is `logClass !== LogClass.NORMAL` rather than `=== SENSITIVE` (`logger.js`), so an
 * unrecognised class still suppresses and only a value that COLLIDES with `NORMAL` can publish. The
 * green was the fork's fail-safe working, not this test failing to look.
 *
 * 🔴 THE DEBUG LOG GOES IN `temp/`, UNDER A NAME UNIQUE TO THIS RUN — the same rule
 * `memory-isolation.test.js` learned. `logging.file` is a base name joined onto the server directory,
 * so a base of `temp/<something>` lands in the folder that is gitignored wholesale, and `afterAll`
 * removes it. A bare `debugMode` would write `st_DEBUG.log` into the REPOSITORY ROOT — the shared,
 * conventional name a concurrent suite or a real install is also writing.
 */

/** The account's persona, which becomes half of the user-tier scope key. */
const PERSONA = makeMarker('LOGHYGIENE-PERSONA');
/** The character. `makeMarker`, never `Seraphina` — she is the fork's default card and is laid down in plaintext. */
const CHARACTER = makeMarker('LOGHYGIENE-CHARACTER');
/** The chat, client-supplied and passed through untouched, so it reaches Mnemosyne's scope key verbatim. */
const CHAT_ID = makeMarker('LOGHYGIENE-CHATID');
/** What the user typed this turn. */
const MESSAGE = makeMarker('LOGHYGIENE-USER-SAID');
/** What the stub model said back, queued through `MockServer.script()`. */
const REPLY = makeMarker('LOGHYGIENE-MODEL-REPLIED');

/**
 * A remembered fact, and the one canary that is never typed by anybody.
 *
 * 🔴 IT MUST NOT APPEAR IN THE USER'S MESSAGE, for the reason `memory-isolation.test.js` records at
 * length: a secret that the user just said is in the outgoing prompt because they said it, so both the
 * claim and its control would pass without retrieval happening at all. This string exists only inside
 * the stored memory. Its route into the log — if the gate were off — is the fork logging the request
 * body it sends the backend, which by then carries the memory Mnemosyne injected.
 */
const SECRET = makeMarker('LOGHYGIENE-REMEMBERED');

/** The stored sentence. The only place {@link SECRET} is ever written. */
const MEMORY_TEXT = `The user's private recovery phrase is ${SECRET}, and it must never be repeated.`;

/** What the user asks. Semantically near the memory, and free of the secret. */
const QUERY = `What is my private recovery phrase? ${MESSAGE}`;

/**
 * The bait, one mark per class of content, so a failure names WHAT escaped rather than merely that
 * something did.
 *
 * ⚠️ Every entry has to have a route to a log call site or the negative assertion built on it is
 * decoration. The route is named for each, and the debug run is what proves the route is real.
 */
const CANARY = Object.freeze({
    /** The user's own words. Fork: `log.debug(SENSITIVE, '<api> request:', body)`. */
    MESSAGE,
    /** The model's answer. Fork: `log.debug(SENSITIVE, '<api> response:', …)`. */
    REPLY,
    /** The character's name. Mnemosyne: `That recall was for %s, character %s, scopes […]`. */
    CHARACTER,
    /** The chat id. Mnemosyne: the `s:<chatId>` half of the same scope line. */
    CHAT_ID,
    /** The persona. Mnemosyne: the `u:<charId>:<personaId>` half of it. */
    PERSONA,
    /** A remembered fact the user did NOT say this turn. Fork: the injected prompt body. */
    SECRET,
});

/** Every canary name, for the debug-mode assertion. */
const ALL_CANARIES = Object.keys(CANARY).sort();

/**
 * Which marks appear in a body of text.
 * @param {string} haystack Text to search
 * @returns {string[]} The names of every canary found, sorted
 */
function findCanaries(haystack) {
    return Object.entries(CANARY)
        .filter(([, mark]) => haystack.includes(mark))
        .map(([name]) => name)
        .sort();
}

/**
 * The two shapes a suppressed line can take, counted.
 *
 * A stub replaced the whole line; a `redact()` published the prose and hid only the value. Both are
 * the gate firing, and this suite's threshold is on the total for the reason `log-canary.test.js`
 * records: converting a noisy site from one to the other must not look like a regression.
 * @param {string} text A log file's contents
 * @returns {{stubs: string[], redactions: string[]}} What was found
 */
function suppressionsIn(text) {
    return {
        stubs: text.match(/\[SENSITIVE suppressed: [^\]]+\]/g) || [],
        redactions: text.match(/<redacted>/g) || [],
    };
}

const gate = preflight('suite B — real-stack log hygiene', [DEPENDENCIES.vault, DEPENDENCIES.mnemosyne]);
const suite = gate.run ? describe : describe.skip;

/** Log files this run created, so they go whatever happens. */
const logFilesCreated = [];

/**
 * What one session wrote, and what it did.
 * @typedef {object} SessionOutput
 * @property {string} file Contents of the log file the writer opened for this session
 * @property {string} terminal Everything the child wrote to stdout and stderr
 * @property {string} quietPath Path of the non-debug log file
 * @property {string} debugPath Path of the debug log file
 * @property {string} dataRoot The scratch data root, for the at-rest check
 * @property {string} prompt What the fork actually sent the model, as JSON
 * @property {string} panel What Mnemosyne's panel reported afterwards
 */

/**
 * Boot the whole stack, drive one memory-carrying generation and one chat through it, shut it down,
 * and read back everything it wrote.
 * @param {object} options Session options
 * @param {boolean} options.debugMode Whether to turn `logging.debugMode` on
 * @returns {Promise<SessionOutput>} What the session wrote
 */
async function runSession({ debugMode }) {
    const label = debugMode ? 'debug' : 'quiet';
    const base = path.posix.join('temp', `mnemosyne-log-hygiene-${label}-${process.pid}`);
    const quietPath = path.join(serverDirectory, `${base}.log`);
    const debugPath = path.join(serverDirectory, `${base}_DEBUG.log`);

    logFilesCreated.push(quietPath, debugPath);

    // `initLogger` opens the file with `fs.openSync(…, 'a')` and creates no directories, so a missing
    // `temp/` would cost this suite the only file it reads.
    fs.mkdirSync(path.dirname(quietPath), { recursive: true });

    const backendPort = await getFreePort();
    const backend = new MockServer({ port: backendPort, host: '127.0.0.1' });
    await backend.start();

    // One scripted reply, so the assistant's turn is a mark of its own rather than an echo of the
    // user's — otherwise REPLY and MESSAGE would be the same string and the two routes could not be
    // told apart.
    backend.script([REPLY]);

    const prepared = await prepareDataRoot(`integration-mnemosyne-log-hygiene-${label}`);
    shareModelCache(prepared.dataRoot);

    const boot = await startServer({
        ...prepared,
        withVault: true,
        pluginsPath: path.join(serverDirectory, 'plugins'),
        configEnv: {
            SILLYTAVERN_LOGGING_DEBUGMODE: String(debugMode),
            SILLYTAVERN_LOGGING_FILE: base,
        },
    });

    let prompt = '';
    let panel = '';

    try {
        const cookie = await login(boot);

        // A SCENARIO memory, keyed on the client-supplied chatId. Deliberately not the user tier: the
        // user tier is keyed on a `charId` the fork mints server-side, which a test cannot choose —
        // `memory-isolation.test.js` documents that whole problem. The scenario tier needs no such
        // bootstrap, and what this file is asking has nothing to do with which tier answered.
        const planted = await post(boot.base, '/api/plugins/mnemosyne/memory', {
            text: MEMORY_TEXT, tier: 'scenario', chatId: CHAT_ID, personaId: PERSONA, charName: CHARACTER,
        }, cookie);

        if (planted.status !== 201) {
            throw new Error(`Planting the memory failed (${planted.status}): ${JSON.stringify(planted.body)}`);
        }

        const driven = await generate({
            base: boot.base,
            cookie,
            backendPort,
            text: QUERY,
            identity: { charAvatar: `${CHARACTER}.png`, charName: CHARACTER, personaId: PERSONA, chatId: CHAT_ID },
        });

        if (driven.status !== 200) {
            throw new Error(`Generation failed (${driven.status}): ${JSON.stringify(driven.body)}\n\n${boot.server.output()}`);
        }

        prompt = JSON.stringify(backend.requests[backend.requests.length - 1] ?? {});
        panel = (await getText(boot.base, '/api/plugins/mnemosyne/panel', cookie)).text;
    } finally {
        await boot.server.stop();
        await backend.stop();
        releasePort(backendPort);
    }

    const written = debugMode ? debugPath : quietPath;

    return {
        file: fs.existsSync(written) ? fs.readFileSync(written, 'utf-8') : '',
        terminal: boot.server.output(),
        quietPath,
        debugPath,
        dataRoot: prepared.dataRoot,
        prompt,
        panel,
    };
}

suite('🔴 real-stack log hygiene — the fork, the real Vault and the real Mnemosyne', () => {
    /** @type {SessionOutput} */
    let quiet;
    /** @type {SessionOutput} */
    let debug;

    beforeAll(async () => {
        // Serially. Two full stacks at once double the peak load on a machine that may already be
        // running the rest of the suite, and the boot timeout is what breaks first.
        quiet = await runSession({ debugMode: false });
        debug = await runSession({ debugMode: true });
    }, 900_000);

    afterAll(() => {
        // Both files hold this suite's own synthetic conversation in clear text. They are in `temp/`,
        // which is gitignored wholesale, but cleartext conversation on the disk of a repository whose
        // entire point is that there isn't any goes when the suite goes.
        for (const file of logFilesCreated) {
            fs.rmSync(file, { force: true });
        }
    });

    describe('the stack really was running — without this the rest is decoration', () => {
        test('🔑 both dependencies resolved, and the preflight pinned both revisions', () => {
            expect(gate.resolved).toHaveLength(2);

            for (const one of gate.resolved) {
                expect(one.present).toBe(true);
                expect(one.revision).toMatch(/^[0-9a-f]{7,}$/);
            }
        });

        test('🧠 Mnemosyne was loaded and retrieval HIT, in the quiet run itself', () => {
            // 🔴 The guard that makes this a real-stack test rather than a second copy of
            // `log-canary.test.js`. `[Mnemosyne] Recalled …` is a NORMAL line, so it survives the gate
            // and appears in the quiet log — which is exactly what is wanted here: proof, inside the
            // artefact under examination, that the plugin ran and found something. A plugin that failed
            // to load is otherwise SILENT, and every negative assertion below would pass beautifully
            // against a stack that never loaded it.
            expect(quiet.file).toMatch(/\[Mnemosyne\] Recalled \d+ memor/);

            // …and it recalled something, rather than reporting a clean nothing.
            expect(quiet.file).not.toMatch(/\[Mnemosyne\] Recalled 0 memories/);
        });

        test('🧾 the memory reached the model, so the secret really was in play', () => {
            // The other half of the same guard, on the SECRET canary specifically. It is the one string
            // no participant typed, so unless retrieval put it in the outgoing prompt it never entered
            // the process at all and "it did not leak" would be a statement about nothing.
            expect(quiet.prompt).toContain(SECRET);
            expect(debug.prompt).toContain(SECRET);
        });

        test('🔒 Vault was live: the same run\'s chat is ciphertext at rest', () => {
            // `DESIGN_LOG_HYGIENE.md` §3, stated literally and on one string: nothing that is ciphertext
            // at rest may appear as plaintext in a log. The at-rest half is here; the log half is below.
            expect(findMarker(quiet.dataRoot, SECRET)).toEqual([]);

            const names = collectFiles(quiet.dataRoot).map(one => path.basename(one));

            expect(names.some(name => name.startsWith('venc1~'))).toBe(true);
        });
    });

    describe('debug mode off — the shipping default, and the claim', () => {
        test('🔴 NO CONVERSATION CONTENT REACHED st.log, with the real Vault and the real Mnemosyne', () => {
            expect(findCanaries(quiet.file)).toEqual([]);
        });

        test('🔴 and none reached the terminal, which under systemd is the journal', () => {
            expect(findCanaries(quiet.terminal)).toEqual([]);
        });

        test('🧷 the suppressed lines left their call sites behind, so the trace survives', () => {
            // Evidence that the gate FIRED rather than that there was nothing to say. Without this, the
            // two tests above pass just as well against a log nobody wrote.
            const { stubs, redactions } = suppressionsIn(quiet.file);

            expect(stubs.length + redactions.length).toBeGreaterThan(10);

            // And a stub that cannot name its origin is the worst thing this mechanism produces —
            // "something happened and you may not know what". None may be anonymous.
            expect(stubs.filter(stub => stub.includes('unknown'))).toEqual([]);
        });

        test('📖 the log was still worth reading — the operator half of both dependencies survived', () => {
            // The point of the exercise, and the reason neither dependency simply routes everything to
            // SENSITIVE and calls it done. Both split their call sites in two: what happened is NORMAL
            // and survives, who it happened to is SENSITIVE and does not.
            expect(quiet.file).toMatch(/\[Mnemosyne\]/);
            expect(quiet.file).toContain('Using data root:');
        });

        test('🚫 the debug file was not written at all', () => {
            expect(quiet.file.length).toBeGreaterThan(0);
            expect(fs.existsSync(quiet.debugPath)).toBe(false);
        });
    });

    describe('debug mode on — the operator asked for everything', () => {
        test('🔴 EVERY canary appears, which is what makes the quiet run mean something', () => {
            // 🔴 THE LOAD-BEARING ASSERTION OF THIS FILE. A canary missing here did not reach a log call
            // site, so the corresponding "it did not leak" above proved nothing whatever. A failure in
            // this test invalidates the quiet run rather than reporting a debug-mode bug.
            expect(findCanaries(debug.file)).toEqual(ALL_CANARIES);
        });

        test('🧠 and Mnemosyne\'s identifiers are among them, on its own sensitive channel', () => {
            // Named specifically because it is the seam this file exists for: these three reach the log
            // through the PLUGIN's classification decisions, not the fork's. If Mnemosyne ever mislabels
            // that line `NORMAL`, the quiet run above turns red — this is the line that proves the quiet
            // run was actually asking about Mnemosyne at all.
            expect(debug.file).toMatch(/\[Mnemosyne\] That recall was for /);
            expect(debug.file).toContain(CHARACTER);
            expect(debug.file).toContain(CHAT_ID);
            expect(debug.file).toContain(PERSONA);
        });

        test('🚫 content did not also go to the terminal, so a systemd unit cannot re-leak it', () => {
            expect(findCanaries(debug.terminal)).toEqual([]);
        });

        test('📣 the operator was warned, unmissably, and st.log was never opened (§4.5, §4.8)', () => {
            expect(fs.existsSync(debug.debugPath)).toBe(true);
            expect(fs.existsSync(debug.quietPath)).toBe(false);
            expect(debug.terminal).toContain('DEBUG LOGGING IS ON');
        });
    });
});
