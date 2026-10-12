import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import nodePersist from 'node-persist';

import { serverDirectory } from './preflight.mjs';
import { makeScratchDirectory, startSillyTavern } from '../util/st-server.js';

/**
 * 🔗 Shared machinery for the integration suites — the parts every one of them needs before it can
 * assert anything: a data root with a real account in it, a server booted against the REAL provider,
 * a logged-in session, and the leak detector.
 *
 * Both suites boot the same way, so the boot lives here rather than being copied. Suite B in
 * particular boots the identical arrangement as Suite A plus a plugin, and the assertion that matters
 * most there is *"the plugin did not weaken any of A's guarantees"* — which is only meaningful if B
 * really is running A's arrangement rather than a lookalike that drifted.
 */

/** The password every integration account is created with. Vault derives the KEK from this. */
export const PASSWORD = 'the-password-that-derives-the-kek';

/** The account these suites use. `default-user` is the one SillyTavern creates for itself at boot. */
export const HANDLE = 'default-user';

/**
 * A marker string that cannot occur by accident, in this run or a stale one.
 *
 * ⚠️ Fresh per call, and that is deliberate. A fixed marker would match a file left behind by an
 * earlier run of the same suite, so a leak detector built on one could report a hit that has nothing
 * to do with the code under test — or, far worse, a *clean* run could be clean only because the
 * scratch directory it scanned was not the one just written.
 * @param {string} label Something human-readable to find in a failure message
 * @returns {string} A unique marker
 */
export function makeMarker(label) {
    return `${label}-${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * POST some JSON at a server.
 * @param {string} base Server base URL
 * @param {string} route The route
 * @param {object} body The body
 * @param {string} [cookie] A session cookie
 * @returns {Promise<{status: number, body: any, cookie: string}>} The response
 */
export async function post(base, route, body, cookie) {
    const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: JSON.stringify(body),
    });

    return {
        status: response.status,
        body: await response.json().catch(() => ({})),
        // Attributes (Path, HttpOnly, SameSite…) belong in a Set-Cookie, never in a Cookie. Send them
        // back and the session simply does not parse — which looks exactly like being logged out.
        cookie: response.headers.getSetCookie().map(one => one.split(';')[0]).join('; '),
    };
}

/**
 * GET some JSON from a server.
 * @param {string} base Server base URL
 * @param {string} route The route
 * @param {string} [cookie] A session cookie
 * @returns {Promise<{status: number, body: any}>} The response
 */
export async function get(base, route, cookie) {
    const response = await fetch(`${base}${route}`, {
        headers: { ...(cookie ? { Cookie: cookie } : {}) },
    });

    return { status: response.status, body: await response.json().catch(() => ({})) };
}

/**
 * Give an account a real password.
 *
 * Vault derives the KEK from whatever the user types at login, independently of this hash — so this
 * only exists to get past SillyTavern's own auth and reach the provider.
 * @param {string} dataRoot The data root
 * @param {string} [handle] The account
 * @param {string} [password] The password
 * @returns {Promise<void>}
 */
export async function setPassword(dataRoot, handle = HANDLE, password = PASSWORD) {
    const accountsDirectory = path.join(dataRoot, '_storage');
    // 🔴 `expiredInterval: 0`, HERE AND IN EVERY TEST THAT OPENS THIS STORE ITSELF. node-persist's default
    // starts a sweep that re-reads the directory every two minutes and is never stopped. The suite deletes
    // its scratch directory in `afterAll`, the jest worker moves on to another suite, and the sweep fires
    // THERE — failing that suite with "_storage does not exists!", naming a directory it never made. Seen
    // 2026-09-23 as two suites "failed to run" with every test passing. The server's own stores already
    // run with it off (`users.js`).
    const store = nodePersist.create({ dir: accountsDirectory, expiredInterval: 0 });
    await store.init();

    const user = await store.getItem(`user:${handle}`);

    // ⚠️ CHECKED, RATHER THAN LEFT TO THROW ON THE NEXT LINE. `user.password = …` against an undefined
    // user raises "Cannot read properties of undefined", which names neither the account store it read
    // nor what was in it — and this runs inside `beforeAll`, where that TypeError is the entire report
    // the suite gives you. The seed boot awaits `initUserStorage` long before it listens, so an empty
    // store here means something genuinely unexpected happened and the evidence is worth capturing.
    if (!user) {
        const keys = await store.keys().catch(error => [`<keys() failed: ${error}>`]);
        const files = fs.existsSync(accountsDirectory) ? fs.readdirSync(accountsDirectory) : ['<no _storage directory>'];

        throw new Error(`The seed boot left no account "${handle}" in ${accountsDirectory}.\n  keys:  ${JSON.stringify(keys)}\n  files: ${JSON.stringify(files)}`);
    }

    const salt = crypto.randomBytes(16).toString('base64');

    user.password = crypto.scryptSync(password.normalize(), salt, 64).toString('base64');
    user.salt = salt;

    await store.setItem(`user:${handle}`, user);
}

/**
 * Config the child must be told about before it reads `--configPath`.
 *
 * `debugMode` is explicit on every boot so logging assertions do not depend on host configuration.
 * @param {Record<string, string>} [extra] Anything else the caller needs set
 * @returns {Record<string, string>} The environment block
 */
function configEnvironment(extra = {}) {
    return { SILLYTAVERN_LOGGING_DEBUGMODE: 'false', ...extra };
}

/**
 * A scratch data root with one real account in it, ready for a provider to be pointed at.
 *
 * Two phases, the same shape the fixture-provider suites use: boot once with NO provider so
 * SillyTavern lays down the data root and the accounts store, then set a password on the account it
 * made. A provider that arrived before the account existed would have nobody to make a vault for.
 * @param {string} label A hint for whoever finds the directory in the temp tree
 * @returns {Promise<{scratch: string, dataRoot: string, configPath: string}>} The prepared root
 */
export async function prepareDataRoot(label) {
    const scratch = makeScratchDirectory(label);
    const dataRoot = path.join(scratch, 'data');
    const configPath = path.join(scratch, 'config.yaml');

    const seed = await startSillyTavern({ dataRoot, configPath, configEnv: configEnvironment() });

    if (!seed.listening) {
        throw new Error(`Seed boot failed for "${label}".\n\n${seed.output()}`);
    }

    await seed.stop();
    await setPassword(dataRoot);

    return { scratch, dataRoot, configPath };
}

/**
 * Boot SillyTavern against the REAL storage provider, or deliberately without one.
 *
 * The provider directory uses the deployment layout. The data root is always task-owned scratch and must
 * never point at an existing user data root.
 * @param {object} options Boot options
 * @param {string} options.dataRoot The scratch data root
 * @param {string} options.configPath The scratch config
 * @param {boolean} [options.withVault] Install the real Vault. False boots the same server with no
 * provider at all, which is what makes it usable as a plaintext control.
 * @param {string} [options.pluginsPath] A plugins directory, for Suite B
 * @param {Record<string, string>} [options.configEnv] Extra config for the child
 * @param {Record<string, string>} [options.providerEnv] Environment for the PROVIDER, which runs inside the
 * child process and has no other way to be configured — Vault reads its own settings from here, deliberately,
 * because a config-file parser would be a runtime dependency and its threat model has none.
 * @returns {Promise<{server: any, base: string}>} The running server and its base URL
 */
export async function startServer({ dataRoot, configPath, withVault = true, pluginsPath, configEnv, providerEnv }) {
    // Server plugins are OFF by default in the fork and the boot harness forces them off besides, so a
    // suite that names a plugins directory has to turn them on or it would assert against a server that
    // never loaded anything — §4's forbidden green, in the shape of a plugin test with no plugin.
    //
    // 🔴 AND AUTO-UPDATE OFF. It defaults to TRUE and `git pull`s the plugins directory on every boot.
    // Suite B's plugins directory is a real checkout of Mnemosyne pinned to a revision the preflight
    // reports; a boot that quietly pulled it would make the reported revision a lie and put the network
    // in the path of a test.
    const pluginEnv = pluginsPath ? {
        SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
        SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false',
    } : {};

    const server = await startSillyTavern({
        dataRoot,
        configPath,
        storageProvidersPath: withVault ? path.join(serverDirectory, 'storage-providers') : undefined,
        pluginsPath,
        enableUserAccounts: true,
        configEnv: configEnvironment({ ...pluginEnv, ...configEnv }),
        providerEnv,
    });

    if (!server.listening) {
        throw new Error(`Boot ${withVault ? 'with the real Vault' : 'with no provider'} failed.\n\n${server.output()}`);
    }

    return { server, base: `http://127.0.0.1:${server.port}` };
}

/**
 * Log in and come back with a session cookie.
 *
 * ⚠️ Takes the whole boot rather than just its URL, so a refusal can carry the SERVER'S account of
 * itself. `403 {"error":"Incorrect credentials"}` is returned for two entirely different causes — the
 * account was not found, and the password did not match — and the endpoint deliberately does not say
 * which, because telling an anonymous caller which accounts exist is the oracle it exists to close.
 * The server's own log does distinguish them, and without it a flaky login is indistinguishable from a
 * wrong password.
 * @param {{server: any, base: string}} boot What {@link startServer} returned
 * @param {string} [password] The password to log in with
 * @param {string} [handle] The account
 * @returns {Promise<string>} A session cookie
 */
export async function login(boot, password = PASSWORD, handle = HANDLE) {
    const response = await post(boot.base, '/api/users/login', { handle, password });

    if (response.status !== 200) {
        throw new Error(`Login as "${handle}" failed with ${response.status}: ${JSON.stringify(response.body)}\n\n--- server output ---\n${boot.server.output()}`);
    }

    return response.cookie;
}

/**
 * Point a scratch data root's model cache at a shared one that survives between runs.
 *
 * 🔴 WITHOUT THIS, EVERY RUN OF SUITE B DOWNLOADS A ~100 MB EMBEDDING MODEL. `src/transformers.js` caches
 * models at `<DATA_ROOT>/_cache`, and these suites give every test a brand-new data root — so the cache is
 * empty every single time. The model is what `context.embed` loads, and `embed` is what turns a memory into
 * a vector, so Suite B cannot asserted retrieval without it.
 *
 * ⚠️ It runs on the CPU, in-process, through transformers.js. It is NOT a model on the cards, and the plan's
 * §1 constraint is about the GPUs — this does not touch them.
 *
 * The shared directory lives in `temp/`, which is gitignored wholesale, so a 100 MB download is never a
 * thing git has to think about, and it can be removed with the test-owned temporary directory.
 *
 * ⚠️ STATED BECAUSE IT AFFECTS THE LEAK SCAN: {@link collectFiles} does not descend this. A `readdirSync`
 * entry for a symlink answers `isSymbolicLink()`, not `isDirectory()`, so the walk skips it — which keeps
 * the scan off 100 MB of model weights, and equally means a leak written INSIDE the cache would not be
 * seen. Nothing writes user content there (the memory store has its own directory under the user's data),
 * so that trade is deliberate rather than overlooked.
 * @param {string} dataRoot The scratch data root
 * @returns {string} The shared cache directory now standing in for `<dataRoot>/_cache`
 */
export function shareModelCache(dataRoot) {
    const shared = path.join(serverDirectory, 'temp', 'integration-model-cache');
    const scratchCache = path.join(dataRoot, '_cache');

    fs.mkdirSync(shared, { recursive: true });

    // The seed boot may already have made a real (empty) directory here, and a symlink cannot replace one.
    if (fs.existsSync(scratchCache)) {
        fs.rmSync(scratchCache, { recursive: true, force: true });
    }

    // `junction` is honoured on Windows — where it is the one link type that needs no privileges — and
    // ignored everywhere else, which makes this the portable spelling rather than a Windows special case.
    fs.symlinkSync(shared, scratchCache, 'junction');

    return shared;
}

/**
 * Every file beneath a directory, however deep.
 * @param {string} root Where to start
 * @returns {string[]} Absolute paths
 */
export function collectFiles(root) {
    const found = [];
    const stack = [root];

    while (stack.length > 0) {
        const current = stack.pop();
        let entries;

        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            // A directory that vanished or cannot be read is not a leak. Keep walking.
            continue;
        }

        for (const entry of entries) {
            const full = path.join(current, entry.name);

            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile()) {
                found.push(full);
            }
        }
    }

    return found;
}

/**
 * One place a marker was found in the clear.
 * @typedef {object} Leak
 * @property {string} file The file it was found in
 * @property {string} where How it was encoded — or `name`, when the FILENAME carried it
 */

/**
 * 🔴 THE LEAK DETECTOR. Hunt a known string through every byte of a tree.
 *
 * ⚠️ THIS FUNCTION IS WORTHLESS UNTIL A CONTROL HAS PROVED IT CAN FIRE. "No plaintext found" is the
 * output of a working detector over an encrypted tree AND of a broken detector over anything at all,
 * and the two are indistinguishable from the passing tick. So every suite that calls this must first
 * write the same marker through a plaintext path and assert this same function finds it —
 * `PLAN_INTEGRATION_TESTS.md` §7 A3.
 *
 * ⚠️ Deliberately NOT built on Vault's own `bin/verify.js`. A control that shares its oracle with the
 * thing under test cannot fail independently of it: a verify that had stopped looking would report a
 * clean tree and a passing control at the same time. `verify` is a cross-check, never the check.
 *
 * Contents are searched as UTF-8 and UTF-16LE, and names as UTF-8. Base64 is deliberately NOT
 * searched: an embedded string's base64 depends on its bit offset within the surrounding blob, so a
 * naive encode-and-search would silently miss two alignments out of three — a check that is wrong
 * most of the time is worse than one that is honestly absent. The "encoded but not encrypted" failure
 * it would catch is caught positively instead, by asserting the bytes carry the provider's envelope.
 * @param {string} root Directory to search
 * @param {string} marker The string that must not be there
 * @returns {Leak[]} Every place it was found — empty means clean
 */
export function findMarker(root, marker) {
    const needles = [
        { where: 'utf-8', bytes: Buffer.from(marker, 'utf-8') },
        { where: 'utf-16le', bytes: Buffer.from(marker, 'utf-16le') },
    ];

    const leaks = [];

    for (const file of collectFiles(root)) {
        if (path.basename(file).includes(marker)) {
            leaks.push({ file, where: 'name' });
        }

        let content;

        try {
            content = fs.readFileSync(file);
        } catch {
            continue;
        }

        for (const needle of needles) {
            if (content.includes(needle.bytes)) {
                leaks.push({ file, where: needle.where });
            }
        }
    }

    return leaks;
}

/**
 * A chat body of the shape the client actually sends.
 * @param {string} character The character's name
 * @param {string} persona The user's persona name
 * @param {string[]} messages What was said, alternating user then assistant
 * @returns {object[]} A chat array for `POST /api/chats/save`
 */
export function chatBody(character, persona, messages) {
    return [
        { user_name: persona, character_name: character, create_date: '2026-07-21', chat_metadata: {} },
        ...messages.map((text, index) => ({
            name: index % 2 === 0 ? persona : character,
            is_user: index % 2 === 0,
            mes: text,
        })),
    ];
}

/**
 * Save a chat through the app, exactly as the client does.
 *
 * ⚠️ The leading `chats/get` is not a redundant round trip — it is what CREATES the character's chat
 * directory. A save into a directory that does not exist yet behaves differently, and the client
 * always asks first.
 * @param {string} base Server base URL
 * @param {string} cookie Session cookie
 * @param {string} character The character, which is also the directory name
 * @param {string} fileName The chat file, without extension
 * @param {object[]} chat The chat array
 * @returns {Promise<{status: number, body: any}>} The save response
 */
export async function saveChat(base, cookie, character, fileName, chat) {
    const avatarUrl = `${character}.png`;

    await post(base, '/api/chats/get', { avatar_url: avatarUrl, file_name: fileName }, cookie);

    return await post(base, '/api/chats/save', { avatar_url: avatarUrl, file_name: fileName, chat, force: true }, cookie);
}

/**
 * Fetch a plugin panel the way the CLIENT fetches one — identity and all.
 *
 * 🔴 A BARE GET OF A PANEL ROUTE IS NOT "THE PANEL WHILE CHARACTER X IS ACTIVE". The real client always
 * sends the ambient identity: `plugin-panels.js`'s `ambientParams()` puts `chatId`/`personaId`/`tz` in the
 * query and `pluginRequestHeaders()` carries the avatar in `X-ST-Char-Avatar`, which `resolvePanelIdentity`
 * resolves into the fork-minted `charId`. A request that names no character gets Mnemosyne's deliberate
 * no-identity fallback — "Everything", the user's own whole store, for browsing with no chat open — which
 * an isolation assertion then mistakes for a cross-character leak. That misread cost an evening on
 * 2026-08-05; see the Mnemosyne chat's change request of that date.
 * @param {object} options Options
 * @param {string} options.base Server base URL
 * @param {string} options.cookie Session cookie
 * @param {string} options.route The panel route
 * @param {object} [options.identity] `charAvatar`, `personaId`, `chatId` — same shape {@link generate} takes
 * @returns {Promise<{status: number, text: string}>} The response
 */
export async function panelText({ base, cookie, route, identity = {} }) {
    const query = new URLSearchParams();

    if (identity.chatId) query.set('chatId', String(identity.chatId));
    if (identity.personaId) query.set('personaId', String(identity.personaId));
    query.set('tz', 'UTC');

    const headers = { Cookie: cookie };

    if (identity.charAvatar) {
        // Percent-encoded because a header value is latin-1 — the client applies the same encoding, and
        // `resolvePanelIdentity` decodes it.
        headers['X-ST-Char-Avatar'] = encodeURIComponent(String(identity.charAvatar));
    }

    const response = await fetch(`${base}${route}?${query}`, { headers });

    return { status: response.status, text: await response.text() };
}

/**
 * GET something that is not JSON — a rendered panel, for instance.
 *
 * ⚠️ For a plugin PANEL assertion about a specific character or chat, use {@link panelText} instead — a
 * bare GET carries no identity and gets the no-chat fallback view, whatever the test believed was active.
 * @param {string} base Server base URL
 * @param {string} route The route
 * @param {string} [cookie] A session cookie
 * @returns {Promise<{status: number, text: string}>} The response
 */
export async function getText(base, route, cookie) {
    const response = await fetch(`${base}${route}`, {
        headers: { ...(cookie ? { Cookie: cookie } : {}) },
    });

    return { status: response.status, text: await response.text() };
}

/**
 * Drive one real generation through the fork, at a stub backend.
 *
 * 🔴 THE IDENTITY TRAVELS IN HEADERS, NOT THE BODY, and that is the whole reason this helper exists.
 * `readIdentityHeaders` reads `X-ST-Char-Avatar`, `X-ST-Persona-Id`, `X-ST-Chat-Id` and
 * `X-ST-Char-Name`; the fork then swaps the avatar FILENAME for a stable `charId` out of its own
 * server-side map before any plugin sees it (§22), which is precisely why a test cannot simply assert
 * on an id it chose. Send no headers and every scope key collapses to the empty axis, which looks like
 * working retrieval right up until it silently matches the wrong partition.
 * @param {object} options Options
 * @param {string} options.base Server base URL
 * @param {string} options.cookie Session cookie
 * @param {number} options.backendPort Where the stub LLM is listening
 * @param {string} options.text What the user said this turn
 * @param {object} [options.identity] `charAvatar`, `charName`, `personaId`, `chatId`
 * @returns {Promise<{status: number, body: any}>} The generation response
 */
export async function generate({ base, cookie, backendPort, text, identity = {} }) {
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };

    if (identity.charAvatar) headers['X-ST-Char-Avatar'] = encodeURIComponent(identity.charAvatar);
    if (identity.charName) headers['X-ST-Char-Name'] = encodeURIComponent(identity.charName);
    if (identity.personaId) headers['X-ST-Persona-Id'] = encodeURIComponent(identity.personaId);
    if (identity.chatId) headers['X-ST-Chat-Id'] = encodeURIComponent(identity.chatId);

    const response = await fetch(`${base}/api/backends/chat-completions/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: `http://127.0.0.1:${backendPort}/v1`,
            model: 'integration-stub',
            messages: [{ role: 'user', content: text }],
        }),
    });

    return { status: response.status, body: await response.json().catch(() => ({})) };
}

/**
 * Read a chat back through the app.
 * @param {string} base Server base URL
 * @param {string} cookie Session cookie
 * @param {string} character The character
 * @param {string} fileName The chat file, without extension
 * @returns {Promise<{status: number, body: any}>} The chat, as the app hands it to the client
 */
export async function getChat(base, cookie, character, fileName) {
    return await post(base, '/api/chats/get', { avatar_url: `${character}.png`, file_name: fileName }, cookie);
}
