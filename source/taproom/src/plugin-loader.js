import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import express from 'express';
import { default as git, CheckRepoActions } from 'simple-git';
import { sync as commandExistsSync } from 'command-exists';
import { getConfigValue, color, isPathUnderParent, withDeadline, PluginDeadlineError, getPluginTimeoutMs } from './util.js';
import * as storage from './storage.js';
import * as chatLifecycle from './chat-lifecycle.js';
import * as interceptors from './generation-interceptors.js';
import * as panels from './plugin-panels.js';
import * as pluginSettings from './plugin-settings.js';
import * as inventory from './plugin-inventory.js';
import * as notifications from './plugin-notifications.js';
import * as pluginGenerate from './plugin-generate.js';
import * as pluginReadChat from './plugin-read-chat.js';
import { setAdditionalHeadersByType } from './additional-headers.js';
import { readSecret } from './endpoints/secrets.js';
import * as users from './users.js';
import { lookupAvatarById } from './character-ids.js';
import { resolvePanelIdentity } from './plugin-identity.js';
import { getTransformersBatchVectorWithModel } from './vectors/embedding.js';
import { log, LogClass, redact } from './logger.js';

/**
 * The version of the plugin context, handed to every plugin as `context.apiVersion`.
 *
 * 🔴 BUMP THIS WHEN YOU ADD A CAPABILITY OR CHANGE THE SHAPE OF ONE, and add a line below. A plugin's only way
 * to know what it is talking to is this number, so an addition that does not move it is invisible and a
 * plugin written against it will feature-detect forever.
 *
 * ⚠️ Compare with `>=`. It only ever counts up, and it is NOT SillyTavern's own version.
 *
 *   1 — the context as it stood through capability 7 (panels): logger, storage, chat lifecycle, onPrompt,
 *       embed, generate, registerPanel, registerForeignStore. Numbered retroactively; a host without
 *       `apiVersion` at all is older than this and predates the notion.
 *   2 — adds `notify()` (plugin notifications) and `apiVersion` itself.
 *   3 — `generate()` accepts `grammar` (a GBNF string, constrained decoding) and `repPen` (repetition
 *       penalty). Both optional; a plugin that wants constrained output feature-detects on `>= 3`.
 *       ⚠️ ACCEPTS, not honours: this says the HOST takes the parameter, never that the user's backend
 *       implements it. The fork drops it for backends that would reject it; a backend that merely ignores
 *       it returns unconstrained text. See `generate()` below.
 *   4 — interactive panels. A panel fragment may declare
 *       `data-panel-region` and `data-panel-action`; the host performs the request against the plugin's own
 *       router and swaps the named regions it gets back. Every request to a plugin router now carries
 *       `chatId`, `tz`, `personaId` and a resolved `charId`. No change to `registerPanel` — a plugin that
 *       emits neither attribute is unaffected, which is why this is detectable only by version.
 *   5 — `generate()` resolves to `{ text, finishReason }` rather than `{ text }`. Additive and
 *       source-compatible, so nothing written against 1–4 breaks; a plugin that needs to tell "the model had
 *       nothing to say" from "the model ran out of tokens before it got to the answer" feature-detects on
 *       `>= 5`. ⚠️ `finishReason` is the backend's own string passed through VERBATIM and is optional — a
 *       backend that never sends one leaves it `undefined`, so treat its absence as "unknown", never as a
 *       clean stop.
 *   6 — adds `registerSettings()`, and a `Server plugins` section in the Extensions dialog that lists every
 *       plugin the fork tried to load. Additive: a plugin written against 1–5 is unaffected and appears in
 *       the list regardless, because the inventory is built by the LOADER and not by anything a plugin says.
 *       ⚠️ REGISTERING SETTINGS DOES NOT REQUIRE REGISTERING A PANEL, and that is the whole reason this
 *       exists — until now `registerPanel` was a server plugin's only UI channel, so a plugin with no
 *       business owning a chat button had nowhere to put settings at all. Feature-detect on `>= 6`, or on
 *       `typeof context.registerSettings === 'function'`; a plugin that wants to run against 5 as well must
 *       guard the call, because an unguarded one throws in `init` and takes the whole plugin down with it.
 *   7 — adds `readChat(handle, chatId, {last?})`: a chat's core turns read from disk, for work that has no
 *       generation (a panel's "rescan" action). Every turn — here and in `recentMessages` — now carries
 *       `sendDate`, epoch milliseconds or `null`. And `generate()` no longer needs a prior generation when
 *       it is called while handling a panel request: panel requests carry the user's current text-completion
 *       connection and instruct envelope, and the fork captures them exactly as a generation does. Feature-
 *       detect on `>= 7` or `typeof context.readChat === 'function'`; `sendDate` is absent below 7.
 *   8 — `generate()` runs against a Chat Completion connection. The chat
 *       route captures the user's connection exactly as the text route does, panel requests carry it in
 *       chat mode too, and `generate()` posts `{model, messages: [{role: 'user', content: prompt}], ...}` to
 *       the source's `/chat/completions`. Same signature, no new parameter. `wrap: true` is satisfied without
 *       an envelope on a chat connection — the chat template is the framing. Covered: the OpenAI-wire sources
 *       (`openai`, `custom`, `openrouter`); the vendor-converted ones (Claude, Gemini, Cohere, Mistral, ...)
 *       are refused with the existing "is not supported yet" sentence. Feature-detect on `>= 8`.
 */
export const PLUGIN_API_VERSION = 8;

/**
 * One instance for every plugin mount; it holds no per-plugin state. `readSecret` rides along for a chat
 * connection's key (API 8), injected for the reason `setAdditionalHeadersByType` is — see plugin-generate.js.
 */
const capturePanelConnection = pluginGenerate.panelConnectionCapture(setAdditionalHeadersByType, readSecret);

const enableServerPlugins = !!getConfigValue('enableServerPlugins', false, 'boolean');
const enableServerPluginsAutoUpdate = !!getConfigValue('enableServerPluginsAutoUpdate', true, 'boolean');

/**
 * Map of loaded plugins.
 * @type {Map<string, any>}
 */
const loadedPlugins = new Map();

/**
 * Ids that have been HANDED to an `init`, whether or not it succeeded.
 *
 * Separate from {@link loadedPlugins}, which is the count reported at boot and must mean "working". This
 * one exists so that a plugin whose `init` threw cannot be loaded a second time by the directory loader's
 * `package.json` → `index.js` fallback, which for `"main": "index.js"` resolves to the same cached module.
 * @type {Set<string>}
 */
const attemptedPluginIds = new Set();

/**
 * Determine if a file is a CommonJS module.
 * @param {string} file Path to file
 * @returns {boolean} True if file is a CommonJS module
 */
const isCommonJS = (file) => path.extname(file) === '.js' || path.extname(file) === '.cjs';

/**
 * Determine if a file is an ECMAScript module.
 * @param {string} file Path to file
 * @returns {boolean} True if file is an ECMAScript module
 */
const isESModule = (file) => path.extname(file) === '.mjs';

/**
 * Load and initialize server plugins from a directory if they are enabled.
 * @param {import('express').Express} app Express app
 * @param {string} pluginsPath Path to plugins directory
 * @returns {Promise<Function>} Promise that resolves when all plugins are loaded. Resolves to a "cleanup" function to
 * be called before the server shuts down.
 */
export async function loadPlugins(app, pluginsPath) {
    try {
        const exitHooks = [];
        const emptyFn = () => { };

        // Server plugins are disabled.
        if (!enableServerPlugins) {
            return emptyFn;
        }

        // Plugins directory does not exist.
        if (!fs.existsSync(pluginsPath)) {
            return emptyFn;
        }

        const files = fs.readdirSync(pluginsPath);

        // No plugins to load.
        if (files.length === 0) {
            return emptyFn;
        }

        await updatePlugins(pluginsPath);

        // 🔴 MOUNTED BEFORE THE PLUGINS THEMSELVES, AND THAT IS THE POINT. Plugins mount at
        // /api/plugins/<id>, so a plugin whose id is literally "client-config" would otherwise shadow this
        // route and the client would silently receive that plugin's 404 instead of the registry. Express takes
        // the first match, so the fork's own route is registered first and wins. The handler reads the registry
        // at REQUEST time, so mounting before anything has registered costs nothing.
        //
        // ⚠️ AN OBJECT KEYED BY CAPABILITY, NOT A BARE ARRAY OF PANELS, AND NOT KEYED BY PLUGIN ID.
        //
        // This is "what the client needs to know about the plugins that are loaded", and panels are merely the
        // first thing it needs to know. §17 (recentMessages) has to send a per-plugin count OUTWARD to the
        // client too, and it CANNOT ride a panels-shaped response: a plugin may declare a prompt window and
        // register no panel at all, so anything keyed off panels would silently drop exactly those plugins. It
        // adds a sibling key here instead.
        //
        // Capability-keyed rather than plugin-keyed because panels are ORDERED — registration order is button
        // order — and a map keyed by plugin id makes that order implicit and fragile, besides assuming one
        // panel per plugin for ever. §17's data is naturally plugin-keyed, and can be so inside its own key.
        //
        // Already behind auth, and deliberately not re-checking it: `loadPlugins` is called from
        // `server-main.js` well below `requireLoginMiddleware`, so the logged-out never reach this handler.
        app.get('/api/plugins/client-config', (_request, response) => response.json({
            panels: panels.listPanels(),
            // §28. A sibling key for exactly the reason the note above gives: a plugin may declare settings
            // and register no panel — that is the case this capability exists for — so anything hung off
            // `panels` would silently drop the plugins it is meant to surface.
            settings: pluginSettings.listSettings(),
            // Every load ATTEMPT, which is not the same list as either of the two above and cannot be
            // derived from them. A plugin that declares nothing still belongs here, and a plugin that
            // FAILED belongs here most of all: until now its only trace was a line in st.log.
            //
            // ⚠️ NO ERROR MESSAGES ON THIS ROUTE. `import()` failures carry absolute server paths, and this
            // response goes to every logged-in user. The shape of the error travels; the text is on
            // /api/plugins/diagnostics, which is admin-only. See plugin-inventory.js.
            serverPlugins: inventory.listPlugins(),
            // §17.6's outward-travelling declaration: the client must know how many turns to slice BEFORE it
            // builds a request, and it sends the largest anybody asked for. A SIBLING KEY, not an entry under
            // `panels` — a plugin may declare a window and register no panel, and anything hung off panels
            // would silently drop exactly those plugins.
            prompts: interceptors.listPromptDeclarations(),
            // The host's own context version, so the CLIENT can reason about the fork it is running against for
            // the same reason a plugin can. Static, unlike everything on /notifications below.
            apiVersion: PLUGIN_API_VERSION,
        }));

        // ⚠️ A SEPARATE ROUTE FROM client-config, DELIBERATELY. `client-config` is the static registry — what
        // plugins are loaded and what they declared — and is identical for every user. This is per-user,
        // per-chat, and changes on every turn. Folding live state into the registry response would make a cheap
        // cacheable thing uncacheable and would leak one user's events into another's response shape.
        //
        // 🔴 SCOPED TO THE AUTHENTICATED CALLER, NEVER TO A HANDLE FROM THE QUERY. `request.user.profile.handle`
        // is the logged-in user; a handle taken from the query string would let anyone read anyone's
        // notifications, and those carry plugin-supplied content.
        //
        // 🔴 THE ERROR TEXT, AND ONLY FOR AN ADMIN. `client-config` carries the inventory every user is
        // entitled to — what is installed, what loaded, and what KIND of error stopped the rest. The message
        // itself is routinely an absolute path out of the server's filesystem (`Cannot find module
        // '/home/…/plugins/…'`), which is a disclosure on a multi-user install and is useless to a user who
        // cannot reach that filesystem anyway. The person who can act on it is the person who installed the
        // plugin, so they get it here and everyone else gets a row that says which plugin is broken.
        //
        // A separate route rather than a conditional key, so `client-config` keeps the property its own note
        // claims for it: identical for every user, and therefore cacheable.
        app.get('/api/plugins/diagnostics', (request, response) => {
            if (!request.user?.profile?.admin) {
                return response.sendStatus(403);
            }

            return response.json({ serverPlugins: inventory.listForAdmin() });
        });

        // Mounted before the plugins themselves for the same shadowing reason as client-config above.
        app.get('/api/plugins/notifications', (request, response) => {
            const handle = request.user?.profile?.handle;

            if (!handle) {
                // Not an error: the panel host treats a failure as "nothing to show", and a logged-out client
                // asking for notifications has genuinely got none rather than got a problem.
                return response.json({ notifications: [], dominant: {} });
            }

            const chatId = typeof request.query?.chatId === 'string' ? request.query.chatId : undefined;

            return response.json({
                notifications: notifications.listFor(handle, chatId),
                dominant: notifications.dominantFor(handle, chatId),
            });
        });

        for (const file of files) {
            const pluginFilePath = path.join(pluginsPath, file);

            // 🔴 THE TOP-LEVEL ENTRY NAME IS THE INVENTORY'S KEY, AND IT IS DECIDED HERE BECAUSE HERE IS THE
            // ONLY PLACE THAT KNOWS IT. Below this line a directory becomes a package.json becomes an
            // index.js, and each of those can fail on its own — but they are all one plugin from the user's
            // side, and one row in the dialog. It is also what they actually see in their plugins folder,
            // which is what makes a failure row actionable when the manifest never parsed and there is no
            // plugin id to name.
            const source = file;

            if (fs.statSync(pluginFilePath).isDirectory()) {
                await loadFromDirectory(app, pluginFilePath, exitHooks, source);
                continue;
            }

            // Not a JavaScript file.
            if (!isCommonJS(file) && !isESModule(file)) {
                continue;
            }

            await loadFromFile(app, pluginFilePath, exitHooks, source);
        }

        // Drops the manifest failure recorded for a directory that then loaded fine from its index.js — see
        // the note on `finalize`. Runs after the loop and before anything can read the inventory, because
        // `client-config` is mounted above but only ever answers a request, and no request has been served
        // yet: the server is not listening until `loadPlugins` returns.
        inventory.finalize();

        if (loadedPlugins.size > 0) {
            log.info(LogClass.NORMAL, `${loadedPlugins.size} server plugin(s) are currently loaded. Make sure you know exactly what they do, and only install plugins from trusted sources!`);
        }

        // Call all plugin "exit" functions at once and wait for them to finish.
        //
        // ⚠️ `allSettled`, AND EACH CALL WRAPPED, BECAUSE ONE PLUGIN MUST NOT END EVERYONE ELSE'S SHUTDOWN.
        // `Promise.all(exitHooks.map(fn => fn()))` calls the hooks synchronously inside the map, so a hook
        // that throws synchronously aborts the map itself: every later plugin's `exit` never runs — a memory
        // plugin's flush-to-disk simply skipped — and the throw escapes `cleanupPlugins()` into an async
        // SIGINT handler, where `diskCache.dispose()` and `process.exit()` are then never reached. With
        // `isExiting` already true a second Ctrl-C does nothing, so the process hangs until systemd kills it.
        return () => Promise.allSettled(exitHooks.map(exitFn => Promise.resolve().then(exitFn)));
    } catch (error) {
        log.error(LogClass.NORMAL, 'Plugin loading failed.');
        log.error(LogClass.SENSITIVE, 'Plugin loading failed.', error);
        return () => { };
    }
}

/**
 * Loads a plugin from a directory, trying its package.json first and then a bare index file.
 * @param {import('express').Express} app Express app
 * @param {string} pluginDirectoryPath Path to the plugin's directory
 * @param {Array<Function>} exitHooks Array of functions to be run on plugin exit
 * @param {string} source The top-level plugins-directory entry this came from, for the inventory
 * @returns {Promise<void>}
 */
async function loadFromDirectory(app, pluginDirectoryPath, exitHooks, source) {
    const files = fs.readdirSync(pluginDirectoryPath);

    // No plugins to load.
    if (files.length === 0) {
        return;
    }

    // Plugin is an npm package.
    const packageJsonFilePath = path.join(pluginDirectoryPath, 'package.json');
    if (fs.existsSync(packageJsonFilePath)) {
        if (await loadFromPackage(app, packageJsonFilePath, exitHooks, source)) {
            return;
        }
    }

    // Plugin is a module file.
    const fileTypes = ['index.js', 'index.cjs', 'index.mjs'];

    for (const fileType of fileTypes) {
        const filePath = path.join(pluginDirectoryPath, fileType);
        if (fs.existsSync(filePath)) {
            if (await loadFromFile(app, filePath, exitHooks, source)) {
                return;
            }
        }
    }
}

/**
 * Loads and initializes a plugin from an npm package.
 * @param {import('express').Express} app Express app
 * @param {string} packageJsonPath Path to package.json file
 * @param {Array<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @param {string} source The top-level plugins-directory entry this came from, for the inventory
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was loaded successfully
 */
async function loadFromPackage(app, packageJsonPath, exitHooks, source) {
    try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.main) {
            const pluginFilePath = path.join(path.dirname(packageJsonPath), packageJson.main);
            // The manifest is the plugin's own, so its `name` and `version` are better than the directory
            // name — and are the only version a plugin gets, since `info` is not required to carry one.
            return await loadFromFile(app, pluginFilePath, exitHooks, source, {
                name: typeof packageJson.name === 'string' ? packageJson.name : undefined,
                version: typeof packageJson.version === 'string' ? packageJson.version : undefined,
            });
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to load a plugin from its package.json');
        log.error(LogClass.SENSITIVE, `Failed to load plugin from ${packageJsonPath}: ${error}`);
        // Not necessarily fatal for this plugin: `loadFromDirectory` falls through to index.js next, and a
        // success there removes this record in `finalize()`. Recorded anyway, because when there is no
        // index.js this is the only thing that will ever be said about a plugin the user installed.
        inventory.recordFailure(source, 'manifest', error);
    }
    return false;
}

/**
 * Loads and initializes a plugin from a file.
 * @param {import('express').Express} app Express app
 * @param {string} pluginFilePath Path to plugin directory
 * @param {Array.<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @param {string} source The top-level plugins-directory entry this came from, for the inventory
 * @param {{name?: string, version?: string}} [packageInfo] What the package.json said, when there was one
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was loaded successfully
 */
async function loadFromFile(app, pluginFilePath, exitHooks, source, packageInfo = {}) {
    try {
        const fileUrl = url.pathToFileURL(pluginFilePath).toString();
        const plugin = await import(fileUrl);
        log.info(LogClass.NORMAL, 'Initializing plugin from', redact(pluginFilePath));
        return await initPlugin(app, plugin, exitHooks, source, packageInfo);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Failed to load a plugin from its entry point file');
        log.error(LogClass.SENSITIVE, `Failed to load plugin from ${pluginFilePath}: ${error}`);
        // 🔴 THE ONE THE USER HAS NO OTHER WAY TO SEE. A syntax error or a missing dependency throws out of
        // `import()` before the plugin has a manifest, an id, or a single line of its own code running, so
        // there is nothing to name it by except the folder it sits in — and until this row existed, a
        // SillyTavern that quietly lost a feature overnight said nothing at all about why.
        inventory.recordFailure(source, 'import', error, packageInfo);
        return false;
    }
}

/**
 * Check whether a plugin ID is valid (only lowercase alphanumeric, hyphens, and underscores).
 * @param {string} id The plugin ID to check
 * @returns {boolean} True if the plugin ID is valid.
 */
function isValidPluginID(id) {
    return /^[a-z0-9_-]+$/.test(id);
}

/**
 * Is this one ordinary path segment, rather than something that would climb out of the directory it is
 * joined to?
 *
 * Deliberately not a match against the handle *grammar* (`slugify` mints `[a-z0-9-]`): handles predate that
 * function, and a check that rejects a real user's real handle is worse than no check at all.
 * @param {string} segment The candidate
 * @returns {boolean} True if joining it somewhere stays somewhere
 */
function isPlainPathSegment(segment) {
    return segment.length > 0 && segment !== '.' && segment !== '..' && !/[/\\]/.test(segment) && !path.isAbsolute(segment);
}

/**
 * Build the context object handed to a plugin alongside its router.
 *
 * A plugin gets an Express router and, until now, nothing else — no way to reach anything SillyTavern knows.
 * The only alternative was to climb back up by relative path (`import '../../src/storage.js'`), which hard-codes
 * this fork's internal layout into every plugin that does it. So we introduce, explicitly, by name.
 *
 * 🔴 NAMED CAPABILITIES, NEVER THE PROVIDER ITSELF. There is deliberately no `getStorageProvider()` here.
 * Handing a plugin the provider object hands it `unlock`, `rekey` and `recover` along with everything else.
 *
 * ⚠️ ASK LATE, NOT AT MODULE SCOPE. Every capability below must reach into `storage` when it is CALLED, never
 * when this object is built. Plugins load well after providers register, so resolving eagerly would work
 * today and start failing silently the moment someone reorders the boot chain — returning null for ever while
 * looking exactly like working code. That has already happened once in this fork, to `multerStorage()`, and
 * every upload in the application staged in the clear because of it.
 * @param {string} id The plugin's ID, so that a plugin misbehaving inside a callback can be named
 * @returns {object} The context passed as the second argument to the plugin's `init`
 */
function createPluginContext(id) {
    return {
        id,

        /**
         * What version of the HOST this plugin is talking to.
         *
         * 🔴 THE PROBLEM THIS SOLVES: a plugin ships once and runs against whatever fork it lands in. Today the
         * only way to ask "does this host have capability X" is `typeof context.x === 'function'`, which works
         * but only answers one method at a time and says nothing about a method whose SHAPE changed. A plugin
         * that wants to support an older SillyTavern has to feature-detect every call site and can never tell
         * "not built yet" from "built differently".
         *
         * ⚠️ MONOTONIC INTEGER, NOT SEMVER, AND NOT THE APPLICATION'S VERSION. It counts additions to this
         * context, nothing else — SillyTavern's own version moves for a thousand reasons that do not concern a
         * plugin. Compare with `>=`, never `===`: a plugin pinned to an exact number breaks on the next
         * addition, which is the failure this is meant to prevent rather than cause.
         *
         * ⚠️ Feature detection stays correct and stays recommended for a single call. This is for the cases
         * detection cannot express, and it is why {@link PLUGIN_API_VERSION} carries its own changelog.
         */
        apiVersion: PLUGIN_API_VERSION,

        /**
         * The fork's logger, so a plugin can vouch for a line it knows is safe.
         *
         * `installConsoleSeam()` already captures every `console.*` call a plugin makes and classifies it
         * `SENSITIVE`, which means a content-free operational line — three counts and a chat id — is suppressed
         * on a default install alongside everything else. That fail-safe is right and is not weakened here:
         * bare `console.*` still resolves to `SENSITIVE`. This is the opt-in, and it is opt-in PER CALL SITE.
         * The only way to publish a line is to reach for this and name a class.
         *
         * ⚠️ RE-EXPORTED UNCHANGED, NEVER WRAPPED — AND THAT APPLIES ON THE PLUGIN'S SIDE TOO. `record()`
         * passes `log.info` itself as the stack boundary, so `captureCallSite` elides frames up to and
         * including it and reports the CALLER. Wrapping this here would make every suppressed plugin line
         * report a `plugin-loader.js` site; wrapping it in the *plugin* is the same bug one module along, and
         * it is the likelier of the two because wrapping is the obvious way to add a fallback for a fork
         * without §23. A wrapping arrow function *becomes* the first surviving non-`logger.js` frame, so every
         * diagnostic in that plugin collapses onto the single line where the wrapper is defined. `.bind()`
         * adds no V8 frame and is safe. (Verified against the real logger, not reasoned about.)
         *
         * ✅ THIS IS ALSO THE ONLY WAY A PLUGIN'S SUPPRESSED LINES NAME A SITE AT ALL. A bare `console.*`
         * suppression reads `[SENSITIVE suppressed: unknown]`, because the one frame captured under
         * `Error.stackTraceLimit = 1` is the seam's own arrow at `logger.js:526`, which `parseCallSite` skips.
         * Adopting this turns that into `yourfile.js:123`. See §23.5.2.
         *
         * 🔴 `NORMAL` IS AN ASSERTION ABOUT THE WORST POSSIBLE VALUE of every argument you interpolate, not
         * about the value you saw while testing. A user handle, a chat id, a character or persona name, and any
         * path under a user directory are all user-authored, however enum-shaped they look. If you are not
         * certain, it is `SENSITIVE` — that tiebreak is absolute. See §23.5 of `DESIGN_MEMORY_PLUGIN_API.md`.
         * @type {typeof log}
         */
        logger: log,

        /**
         * The classification vocabulary for {@link logger}, the same one the fork uses internally.
         *
         * Deliberately the same `LogClass` and the same rules rather than a plugin-specific scheme: a second
         * set of rules for plugins would be a second thing to get wrong.
         * @type {typeof LogClass}
         */
        LogClass,

        /**
         * Run something when a user's storage becomes available — they log in, a vault unlocks.
         *
         * Hooking the READY notification means every path that opens a user's storage is covered — password
         * login, basic auth, the auto-login middleware, and recovery — including any path added later.
         * @param {(handle: string) => Promise<void>} handler Called with the handle whose storage is now ready
         * @returns {void}
         */
        onStorageReady(handler) {
            storage.onUserStorageReady(handler);
        },

        /**
         * Run something when a user's storage is shut — they log out, or the idle sweep locks them.
         *
         * 🔑 IF YOU HOLD A KEY FROM `deriveSubkey`, DROP IT HERE. That is what this is for. A derived key
         * whose whole promise is that it dies with the vault does not keep that promise by itself, and
         * nothing else will tell you.
         *
         * The user's storage is already shut by the time this runs, so do not expect to read or write it.
         * Throwing is logged and does not fail the logout that caused it — nor does it stop the next
         * handler, so do not rely on being the only one.
         * @param {(handle: string) => Promise<void>} handler Called with the handle whose storage was shut
         * @returns {void}
         */
        onStorageLock(handler) {
            storage.onUserStorageLock(handler);
        },

        /**
         * Run something when a chat is deleted — **whatever deleted it** (§24).
         *
         * ```js
         * context.onChatDeleted(async (handle, chatId) => { await store.forgetChat(handle, chatId); });
         * ```
         *
         * 🔴 THE ID IS SPELLED EXACTLY AS `OutgoingPrompt.chatId` SPELLS IT. That is the contract, and it is
         * the one thing that makes this feature usable: a consumer keys its rows at write time on the id it
         * was handed during generation, so an id here that differed by so much as a `.jsonl` would match zero
         * rows **and report success**. The fork derives it from the basename of the file it actually deleted,
         * so the two are identical by construction rather than by agreement.
         *
         * ⚠️ EVERY DELETION PATH FIRES, AND SOME OVERLAP. Deleting one chat, deleting one conversation from a
         * group, deleting a character *with* its chats, and deleting a whole group all emit. Do not try to
         * dedupe across them — forgetting an already-forgotten chat should be a no-op for you, and the
         * expensive mistake is the opposite one: a path that stays silent leaves rows nothing will ever
         * reach again, because there is no garbage collector behind them.
         *
         * ⚠️ **A CARD DELETED WITHOUT ITS CHATS FIRES NOTHING, DELIBERATELY.** The chat files stay on disk
         * with unchanged names, so anything keyed on `chatId` is still reachable and still correct — and a
         * card delete is usually a re-import. Note this is the opposite of what happens to anything keyed on
         * `charId`, which a re-import orphans (§22.6). Different keys, different fates, same event.
         *
         * ⚠️ A RENAMED chat does not fire this. Renaming is not deleting, and the memories are still wanted —
         * they have moved. Use {@link onChatRenamed} for that (§24.4).
         * @param {(handle: string, chatId: string) => Promise<void>|void} handler Called with the owner and the chat id
         * @returns {void}
         */
        onChatDeleted(handler) {
            chatLifecycle.onChatDeleted(handler);
        },

        /**
         * Run something when a chat is renamed, keeping its contents (§24.4).
         *
         * ```js
         * context.onChatRenamed(async (handle, oldChatId, newChatId) => {
         *     await store.rekeyChat(handle, oldChatId, newChatId);
         * });
         * ```
         *
         * 🔴 RE-KEY, DO NOT DELETE. The chat still exists and the user is very likely still in it — only its
         * id changed. A consumer that handled this by forgetting `oldChatId` would destroy live memories for a
         * conversation in progress, which is strictly worse than the problem this signal exists to solve.
         *
         * 🔴 BOTH IDS ARE SPELLED EXACTLY AS `OutgoingPrompt.chatId` SPELLS THEM, same contract as
         * {@link onChatDeleted} and the same silent failure behind it: an `oldChatId` differing by so much as
         * a `.jsonl` re-keys zero rows **and reports success**. The fork derives both from the two paths it
         * actually moved, never from the request body, because the endpoint sanitises its inputs.
         *
         * ⚠️ ONE SIGNAL COVERS SOLO AND GROUP CHATS BOTH. There is no separate group rename to subscribe to.
         *
         * ⚠️ RENAMING A CHARACTER FIRES NOTHING HERE, AND THAT IS CORRECT. It moves the chats *folder* and
         * rewrites the speaker name *inside* each file, but a `chatId` is a basename — so every chat id it
         * owns is unchanged and there is nothing to re-key. What a character rename does affect is `charId`,
         * which §22 carries across for you.
         *
         * ⚠️ `oldChatId === newChatId` never fires. You will not be asked to re-key a partition onto itself.
         * @param {(handle: string, oldChatId: string, newChatId: string) => Promise<void>|void} handler Called with the owner and both ids
         * @returns {void}
         */
        onChatRenamed(handler) {
            chatLifecycle.onChatRenamed(handler);
        },

        /**
         * Can this user's storage supply key material at all?
         *
         * FALSE means there is no key here and there never will be — an ordinary plaintext install, which is
         * a supported configuration and not an error. A plugin that needs a key should say so plainly and
         * stop, rather than retrying for ever.
         * @param {string} handle User handle
         * @returns {boolean} True if a provider is installed that can derive keys for this user
         */
        hasSecureStorage(handle) {
            return storage.hasSecureStorage(handle);
        },

        /**
         * Is this user's storage unlocked right now?
         *
         * ⚠️ TRUE ON ITS OWN MEANS NOTHING. With no provider installed there is nothing to unlock, so this
         * answers TRUE — the plain filesystem is never unavailable. It is only meaningful together with
         * `hasSecureStorage()`:
         *
         *     !hasSecureStorage(handle)                  -> no provider. Give up, loudly.
         *     hasSecureStorage(handle) && !isStorageReady -> locked. Wait; this is normal.
         *     hasSecureStorage(handle) && isStorageReady  -> ask for the key.
         * @param {string} handle User handle
         * @returns {boolean} True if the user's data can be read and written
         */
        isStorageReady(handle) {
            return storage.isReady(handle);
        },

        /**
         * Derive a named subkey from the user's storage key material.
         *
         * ⚠️ ASK WHEN YOU NEED IT, NOT IN `init`. At init time nobody has logged in and nothing is unlocked,
         * so this returns null — and a plugin that calls it once at startup and caches the answer has cached
         * null for the life of the process. Call it at the point of use.
         *
         * The `info` label is yours. Pick one, keep it stable, and never reuse it for two purposes: the same
         * label yields the same bytes for ever, and that is the whole point of it.
         * @param {string} handle User handle
         * @param {string} info Domain-separation label, chosen by you
         * @param {number} length Bytes required
         * @returns {Buffer|null} Key material, or null if unavailable — see isStorageReady/hasSecureStorage
         */
        deriveSubkey(handle, info, length) {
            return storage.deriveSubkey(handle, info, length);
        },

        /**
         * Declare a directory as yours, and encrypted by you.
         *
         * 🔴 IF YOU CALLED `deriveSubkey` AND WROTE A FILE WITH THE RESULT, YOU MUST CALL THIS. Your file is
         * properly encrypted and, to the storage provider's audit, identical to a leak — it does not carry
         * the provider's envelope, because you wrote it. Undeclared, it is reported as plaintext on every
         * audit run for ever, which trains the operator to ignore the report that would have caught a real
         * leak. Declaring it also keeps the directory's own name readable to the provider, which a provider
         * that name-encrypts otherwise has no way to resolve.
         *
         * ⚠️ DECLARE IT ONCE, IN `init`, NOT AT THE POINT OF USE. Unlike `deriveSubkey` this needs no key
         * and no unlocked user, so there is nothing to wait for — and the audit is meant to run from cron,
         * in a process that loaded no plugins at all. A declaration made only when you happen to write is a
         * declaration the audit may never have seen.
         *
         * `forbidden` is what makes the claim checkable without your cooperation: the head-of-file bytes
         * that must never appear in your directory. A SQLCipher store declares `SQLite format 3\0` — the
         * header of an UNENCRYPTED SQLite database — so "the library was built without encryption support
         * and quietly wrote a plain database" is caught by the audit with no key. Declaring nothing is
         * allowed and reports your files as unverifiable rather than verified.
         *
         * Throws if the declaration is malformed or the directory climbs out of the user's own directory.
         * @param {{directory: string, owner: string, forbidden?: string[]}} store The claim
         * @returns {boolean} True if a provider took it; false if none is installed and nobody was listening
         */
        registerForeignStore(store) {
            return storage.registerForeignStore(store);
        },

        /**
         * See and rewrite a prompt before it is sent to a backend.
         *
         * This is the server-side mirror of the client's `runGenerationInterceptors`, and it is the only way
         * a server plugin can take part in generation at all. A model knows nothing except what is in the
         * prompt; anything a plugin wants it to know has to go through here.
         *
         * You are handed EITHER `messages` (an array, for chat completions) OR `prompt` (one rendered
         * string, for text completions and kobold) — never both. Return a replacement of the same kind, or
         * nothing at all to leave it alone. Returning nothing is how a plugin that only understands one
         * family declines the other; that is normal and silent.
         *
         * ⚠️ `budget` IS UNDEFINED ON THE CHAT PATH. Text completions carries the context limit because the
         * backend needs it; chat completions does not send one at all. Do not assume a number is there.
         *
         * 🔴 ASK FOR `recentMessages` AND YOU GET THE CONVERSATION'S TURNS ON EVERY PATH — structured, and on
         * the text path too, where the prompt is otherwise one instruct-rendered blob you would have to guess
         * at. You choose the number; there is no default and no partial window. Each turn carries an `index`
         * into the FULL chat array, which is the anchor: hidden and system messages leave GAPS in it, so count
         * the turns above your high-water mark, never subtract two indices and call the difference a count.
         *
         * ⚠️ `recentMessages` IS READ-ONLY. Returning it changes nothing — you still return a string on the
         * text path and an array on the chat path, exactly as before.
         * @param {(outgoing: import('./generation-interceptors.js').OutgoingPrompt) => Promise<any>} handler
         * Called with what is about to be sent
         * @param {{recentMessages?: number}} [options] How many recent turns you want, if any
         * @returns {void}
         */
        onPrompt(handler, options) {
            interceptors.onPrompt(id, handler, options ?? {});
        },

        /**
         * Turn text into vectors, using the embedding model SillyTavern already has.
         *
         * This is the application's own local `transformers` embedding source — the one behind the
         * `transformers` option in the Vector Storage extension — handed to plugins rather than reimplemented
         * by them. It runs in-process, needs no service, no key and no network once the model is cached, and
         * it is available on a plaintext install exactly as it is on an encrypted one.
         *
         * 🔴 THE MODEL COMES BACK WITH THE VECTORS, AND YOU MUST KEEP THEM TOGETHER. Vectors only mean
         * anything alongside other vectors from the same model. File them under the name you are given here —
         * as SillyTavern's own `vectors/<source>/<collectionId>/<model>` layout does — and a model change
         * becomes a re-embed rather than a silent corruption. Two models of equal dimension sharing a table
         * compare cleanly and return nonsense.
         *
         * 🔴 DO NOT HARD-CODE THE MODEL'S NAME OR ITS DIMENSION — NOT EVEN FROM READING THIS FILE. It is
         * `extensions.models.embedding` in `config.yaml`, it differs per install, and the source is actively
         * misleading about it: `transformers.js` falls back to `Xenova/all-mpnet-base-v2`, but
         * `default/config.yaml` ships an `embedding:` line naming a different model, so on any install created
         * from it the fallback is never reached. Three separate attempts to name this model from the source
         * were wrong. The name returned here is the only thing that actually knows.
         *
         * Vectors are unit-normalised, so cosine similarity is a plain dot product.
         *
         * ⚠️ THE FIRST CALL MAY BE SLOW AND MAY THROW. It loads the model, downloading it if it is not cached
         * — and `extensions.models.autoDownload: false` means it will not download at all. Failure is loud and
         * yours to handle; there is no vector to fall back on.
         * @param {string[]} texts The texts to embed. A batch: one model load, many vectors.
         * @returns {Promise<{vectors: number[][], model: string|null}>} The vectors and the model that made them
         */
        async embed(texts) {
            // 🔴 A STRING IS AN ARRAY OF CHARACTERS TO ANYTHING THAT ITERATES IT, and the batch path iterates.
            // `embed('hello')` would return five vectors — one per letter — cheerfully and in the right shape.
            // Nothing downstream could ever notice. Refuse the shape here instead.
            if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string')) {
                throw new TypeError(`Plugin '${id}' called context.embed() with something other than an array of strings`);
            }

            return await getTransformersBatchVectorWithModel(texts);
        },

        /**
         * Where this user's data lives on disk — the directory their chats and characters are under.
         *
         * A plugin with data of its own should put it beneath this, so that it moves, backs up and is deleted
         * with the user it belongs to. Use a subdirectory named for your plugin, and create it yourself; this
         * answers where, not what.
         *
         * 🔴 THIS IS DELIBERATELY NOT `DATA_ROOT`. The root would hand over every other user's directory and
         * the server's caches along with the one directory a plugin has business in. `globalThis.DATA_ROOT`
         * happens to be reachable — a plugin shares the process — but reaching for it hard-codes the fork's
         * internals into the plugin and breaks silently the moment they move. That coupling is the thing this
         * context exists to abolish.
         *
         * ⚠️ THE PATH IS NOT THE KEY. This says where the file goes, not whether you may read it. On an
         * encrypted install the directory exists while the vault is shut. `hasSecureStorage`/`isStorageReady`
         * answer that question; this one does not.
         * @param {string} handle User handle — as handed to you by `onStorageReady`/`onStorageLock`
         * @returns {string} Absolute path to the user's own directory
         */
        userDirectory(handle) {
            // Not a security boundary — a plugin runs in-process and has `fs`, so this stops no one who means
            // it. It stops a *bug*: `getUserDirectories` joins the handle onto a path and caches whatever it
            // was given, so a handle that is really a path segment of someone else's making would both escape
            // the user's directory and poison that cache for the rest of the process.
            if (typeof handle !== 'string' || !isPlainPathSegment(handle)) {
                throw new TypeError(`Plugin '${id}' called context.userDirectory() with something other than a user handle: ${JSON.stringify(handle)}`);
            }

            return users.getUserDirectories(handle).root;
        },

        /**
         * Read a file out of a user's own directory — **through the storage provider**, so it decrypts.
         *
         * ```js
         * const bytes = await context.readFile(handle, 'settings.json');
         * ```
         *
         * 🔴 THIS IS THE WHOLE CAPABILITY, AND IT IS NOT ABOUT CHARACTER CARDS. `userDirectory()` already told
         * you where a user's files live, and a plugin has `fs` in-process — so a plugin could always *find*
         * them. On an **encrypted install a raw `fs` read returns ciphertext**, and there is no way to ask the
         * fork to decrypt it. That is the gap. Routing through `storage.readFile` closes it and costs a plain
         * install nothing.
         *
         * 🔴 IT IS NOT THE ROAD TO A CHARACTER CARD — USE `readCharacterCard`. This docblock used to show
         * `characters/Seraphina.png` here, and that example was wrong in a way worth preserving as a warning:
         * it assumed the card is named after the character, which is precisely the name-is-identity assumption
         * §22 exists to destroy. A plugin is handed a `charId` and never an avatar filename (§22.8.2), so it
         * cannot spell that path — and guessing it loads *the wrong character's card*. See §25.
         *
         * 🔴 IT FAILS LOUD, ALWAYS (§6.5). A missing file, a locked vault and an unreadable file all throw,
         * named with your plugin id. None of them returns empty, because a memory plugin that reads "vault
         * locked" as "this character has no card" would extract a baseline of nothing and never know.
         *
         * ⚠️ THE PATH EXISTING SAYS NOTHING ABOUT WHETHER IT CAN BE READ RIGHT NOW — same caveat as
         * `userDirectory`. On an encrypted install the file is on disk while the vault is shut.
         * `hasSecureStorage`/`isStorageReady` answer that; this throws if you ask anyway.
         * @param {string} handle User handle — as handed to you by `onStorageReady`/`onStorageLock`
         * @param {string} relativePath Path **relative to that user's directory**. Absolute paths and anything
         * climbing out with `..` are refused.
         * @returns {Promise<Buffer>} The file's decrypted contents
         */
        async readFile(handle, relativePath) {
            if (typeof handle !== 'string' || !isPlainPathSegment(handle)) {
                throw new TypeError(`Plugin '${id}' called context.readFile() with something other than a user handle: ${JSON.stringify(handle)}`);
            }

            if (typeof relativePath !== 'string' || relativePath === '') {
                throw new TypeError(`Plugin '${id}' called context.readFile() with something other than a relative path: ${JSON.stringify(relativePath)}`);
            }

            const root = users.getUserDirectories(handle).root;
            const resolved = path.resolve(root, relativePath);

            // Same reasoning as `userDirectory`'s handle check: not a security boundary, because a plugin has
            // `fs` and shares the process. It stops a BUG — a relative path assembled from a character name or
            // a chat id that turns out to climb, reading (or, once there is a write counterpart, poisoning)
            // another user's tree. `path.resolve` also absorbs an absolute `relativePath`, which is why the
            // check is on the RESOLVED path rather than on the argument.
            if (!isPathUnderParent(root, resolved)) {
                throw new Error(`Plugin '${id}' called context.readFile() with a path outside the user's directory: ${JSON.stringify(relativePath)}`);
            }

            try {
                return /** @type {Buffer} */ (await storage.readFile(resolved));
            } catch (error) {
                // Rethrown rather than passed through so the plugin is named — an ENOENT from deep inside the
                // storage funnel otherwise arrives with no indication of who asked for it or why.
                throw new Error(`Plugin '${id}' could not read ${JSON.stringify(relativePath)} for user ${JSON.stringify(handle)}: ${/** @type {any} */ (error)?.message ?? error}`, { cause: error });
            }
        },

        /**
         * Read a character's card by the id you were handed — **bytes, never a path**.
         *
         * ```js
         * const bytes = await context.readCharacterCard(handle, charId);   // Buffer, or null
         * ```
         *
         * 🔴 THIS EXISTS BECAUSE §20 AND §22 COLLIDE, AND NEITHER IS WRONG. §20 gave a plugin the ability to
         * read a file; §22.8.2 forbids it from learning the only string that names a card. So `readFile` handed
         * out a reader for a file whose name the contract will not disclose. This closes that gap from the fork
         * side, where the map already lives, rather than by weakening §22.
         *
         * 🔴 IT RETURNS BYTES AND NOT A RESOLVED PATH, AND THAT IS THE REQUIREMENT RATHER THAN A STYLE CHOICE.
         * Handing back the filename would defeat §22.8.2 exactly as thoroughly as never having stripped it —
         * the caller would hold an avatar filename again, and the rename hazard §22 was built to kill would be
         * back. Bytes keep the invariant whole: a plugin learns what is *in* a card and never what it is called.
         *
         * ⚠️ THE FORK INTERPRETS NOTHING, PER §20.1. This resolves an id against a map it already owns and
         * hands over a file it already knows how to read. It does not parse the PNG, choose fields, or truncate
         * — those are memory-extraction judgments and putting them here would freeze one plugin's product
         * decisions into a shared API. **A card is a `.png` with its JSON in a `tEXt` chunk; that parse is
         * yours.**
         *
         * 🔴 `null` AND A THROW ARE DIFFERENT ANSWERS AND THE DIFFERENCE IS LOAD-BEARING. `null` means the id
         * resolves to no card — deleted, or re-imported under a fresh id. That is an ordinary state. Everything
         * else throws, **including a locked vault**, because a memory plugin reading "vault locked" as "this
         * character has no card" would extract a baseline of nothing and never learn it had been wrong.
         * @param {string} handle User handle — as handed to you by `onStorageReady`/`onStorageLock`
         * @param {string} charId The id from `OutgoingPrompt.charId` (or a `recentMessages` turn's `charId`)
         * @returns {Promise<Buffer|null>} The card's decrypted bytes, or `null` if the id names no card
         */
        async readCharacterCard(handle, charId) {
            if (typeof handle !== 'string' || !isPlainPathSegment(handle)) {
                throw new TypeError(`Plugin '${id}' called context.readCharacterCard() with something other than a user handle: ${JSON.stringify(handle)}`);
            }

            if (typeof charId !== 'string' || charId === '') {
                throw new TypeError(`Plugin '${id}' called context.readCharacterCard() with something other than a character id: ${JSON.stringify(charId)}`);
            }

            const directories = users.getUserDirectories(handle);

            // A locked vault throws HERE, before any of the below — `readCharacterIds` propagates provider
            // errors and treats only ENOENT as "start fresh" (see its comment). That is what makes the
            // fail-loud promise above true without this function testing for it.
            const avatar = await lookupAvatarById(directories.root, charId);

            if (avatar === null) {
                return null;
            }

            // ⚠️ THE AVATAR FILENAME IS NOT TRUSTED EVEN THOUGH IT CAME OUT OF OUR OWN MAP. Its keys originate
            // in the client's `X-ST-Char-Avatar` header, so the map is only as clean as whatever was sent —
            // a key with a `..` in it would climb out of `characters/` here. Same reasoning as `readFile`'s
            // check: not a security boundary, but the difference between a bug that reads the wrong file and
            // a bug that says so.
            const resolved = path.resolve(directories.characters, avatar);

            if (!isPathUnderParent(directories.characters, resolved)) {
                throw new Error(`Plugin '${id}' resolved character id ${JSON.stringify(charId)} to a path outside the characters directory: ${JSON.stringify(avatar)}`);
            }

            try {
                return /** @type {Buffer} */ (await storage.readFile(resolved));
            } catch (error) {
                // 🔴 A MISSING FILE IS `null` HERE, WHERE `readFile` THROWS — the two contracts differ on
                // purpose. There, the caller named the path and a miss means they were wrong about it. Here the
                // caller named an ID and the fork resolved it, so a miss means the map outlived the card: an
                // ordinary state after a delete, and one the plugin is entitled to handle rather than catch.
                // Every OTHER error still throws, so "cannot read" never quietly becomes "no card".
                if (/** @type {any} */ (error)?.code === 'ENOENT') {
                    return null;
                }

                throw new Error(`Plugin '${id}' could not read the character card for id ${JSON.stringify(charId)} for user ${JSON.stringify(handle)}: ${/** @type {any} */ (error)?.message ?? error}`, { cause: error });
            }
        },

        /**
         * Read a chat's core turns on demand — the same turns, in the same shape and numbering, that
         * `recentMessages` carries during a generation.
         *
         * ```js
         * const turns = await context.readChat(handle, chatId, { last: 200 });   // Turn[], or null
         * // Turn = { role, name?, content, index, charId, sendDate }
         * ```
         *
         * 🔴 THIS EXISTS FOR WORK THAT HAS NO GENERATION. `recentMessages` exists only while one is in flight, so
         * a panel action — "rescan the last N messages" — had no way to see the chat at all. Pass the `chatId`
         * your panel request was handed (`?chatId=`, apiVersion 4) or that `OutgoingPrompt.chatId` carried; the
         * two are spelled the same. Solo and group chats both work.
         *
         * 🔴 `index` IS THE SAME NUMBER `recentMessages` GIVES THE SAME TURN — the position in the full chat
         * array, captured before hidden messages are dropped (§17.8.1) — so a high-water mark kept against one
         * is valid against the other. Hidden and system messages are excluded by the predicate `Generate()`
         * uses, imported rather than copied. `charId` follows §22.8.2 exactly. `sendDate` is epoch
         * milliseconds or `null`, parsed by the same code for both paths.
         *
         * ⚠️ `content` IS THE STORED TEXT OF THE ACTIVE SWIPE. The generation window's content is the same text
         * after client-only steps the server cannot repeat: prompt-only regex scripts, attached-file text and
         * appended titles, and a fresh macro pass on the first message. Where a chat uses none of those the two
         * are identical; where it does, `content` here is the message as the user sees it in the chat, and the
         * window's is the message as the model saw it. Tool-call records are excluded here (the server cannot
         * know whether the connection uses tools); their indices stay as gaps. See `plugin-read-chat.js`.
         *
         * 🔴 `null` AND A THROW ARE DIFFERENT ANSWERS, as in `readCharacterCard`. `null` means no chat has that
         * id — deleted, or renamed (a renamed chat is found under its NEW id at once). Everything else throws,
         * **including a locked vault**, because a rescan that read "locked" as "empty" would report success
         * having done nothing. Two chats with the same id also throw, rather than guess which you meant.
         * @param {string} handle User handle — as handed to you by `onStorageReady`/`onStorageLock` or a request
         * @param {string} chatId The chat id, spelled as `OutgoingPrompt.chatId` spells it
         * @param {{last?: number}} [options] `last`: return only the trailing N core turns (a positive integer)
         * @returns {Promise<Array<{role: string, name?: string, content: string, index: number, charId: string|null, sendDate: number|null}>|null>}
         */
        async readChat(handle, chatId, options) {
            if (typeof handle !== 'string' || !isPlainPathSegment(handle)) {
                throw new TypeError(`Plugin '${id}' called context.readChat() with something other than a user handle: ${JSON.stringify(handle)}`);
            }

            // A plain path segment for the same reason the handle is one: the id becomes a filename, and an id
            // with a separator in it would climb out of the chats directory.
            if (typeof chatId !== 'string' || !isPlainPathSegment(chatId)) {
                throw new TypeError(`Plugin '${id}' called context.readChat() with something other than a chat id: ${JSON.stringify(chatId)}`);
            }

            if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
                throw new TypeError(`Plugin '${id}' called context.readChat() with options that are not an object: ${JSON.stringify(options)}`);
            }

            const last = options?.last;

            if (last !== undefined && (!Number.isInteger(last) || last <= 0)) {
                throw new TypeError(`Plugin '${id}' called context.readChat() with a 'last' that is not a positive whole number (got ${JSON.stringify(last)})`);
            }

            return await pluginReadChat.readChat({
                pluginId: id,
                handle,
                directories: users.getUserDirectories(handle),
                chatId,
                last,
            });
        },

        /**
         * Put a button beside the chat input, and serve the HTML it shows.
         *
         * A server plugin cannot draw anything — the page is a separate program and the server does not render
         * into it. This registers an icon with the fork's bundled button host, which draws it and, on click,
         * fetches `panelPath` from YOUR router and shows the fragment it returns.
         *
         * 🔴 THE FORK RENDERS WHAT YOU RETURN AND NOTHING ELSE. It does not know or care what the panel is
         * about. The mirror of `onPrompt`: there you hand back a prompt, here you hand back HTML.
         *
         * `icon` is either an emoji (`'🧠'`) or a FontAwesome class list (`'fa-solid fa-brain'`). FontAwesome
         * is already bundled, so it costs nothing, and unlike an emoji it takes `iconColor` and theme sizing.
         *
         * ⚠️ A BAD SPEC THROWS HERE, IN YOUR `init`. That is on purpose: the alternative is a button that
         * silently does nothing until a user clicks it.
         *
         * Panel and status requests are same-origin with the session cookie, so read
         * `request.user.profile.handle` in those routes exactly as you do in your others — the fork passes no
         * identity. It does pass `?chatId=` when a chat is open (absent when none is).
         * @param {{icon: string, iconColor?: string, label: string, tooltip?: string, panelPath: string, statusPath?: string}} spec
         * @returns {void}
         */
        registerPanel(spec) {
            // `id` is closed over, never taken from the spec: a plugin cannot register on another's behalf.
            panels.register(id, spec);
        },

        /**
         * Put a row in the Extensions dialog's `Server plugins` section, and serve the settings it opens.
         *
         * The sibling of `registerPanel`, and the answer to the case that one cannot reach. A panel is a
         * button beside the chat input, so a plugin with no business owning one — a storage provider, a
         * logging shim — had no UI channel whatsoever, and therefore nowhere to put settings.
         *
         * 🔴 THIS IS INDEPENDENT OF `registerPanel`. Register settings and no panel, a panel and no settings,
         * both, or neither. A plugin that calls only this one gets no chat button, which is the point.
         *
         * 🔴 THE FORK RENDERS WHAT YOU RETURN AND NOTHING ELSE — the same contract as `registerPanel`, and
         * deliberately not a declarative schema the fork renders a form from. A schema would force the FORK
         * to persist your values, which is wrong for anything living in an encrypted store the fork holds no
         * key to. Your route does the write, exactly as your panel's actions already do.
         *
         * 🔴 IF YOU CANNOT READ YOUR SETTINGS RIGHT NOW, SAY SO — DO NOT RENDER DEFAULTS. A vault that is
         * locked is the ordinary case, not an error, and a form showing shipped defaults where the user's
         * real values should be is a data-loss bug the moment they press Save. Answer **503** with a fragment
         * explaining what to do (`log in first`), and the host renders it as your own words rather than as a
         * failure. The fork will never substitute an empty form for a settings route it could not read.
         *
         * ⚠️ A BAD SPEC THROWS HERE, IN YOUR `init`, exactly as `registerPanel`'s does — the alternative is a
         * settings row that does nothing when a user finally clicks it.
         *
         * ⚠️ CALLING IT TWICE REPLACES YOUR REGISTRATION rather than adding a second row. Panels are a list
         * because two buttons are two buttons; a plugin has one settings screen.
         *
         * `stylesheetPath` means what it means for a panel, and matters more: the fragment renders inside the
         * Extensions dialog, so the host wraps your CSS in `@scope` against your own container. Build from
         * the theme's `--SmartTheme*` variables and they cascade in as usual.
         *
         * The settings request is same-origin with the session cookie, so read
         * `request.user.profile.handle` in that route exactly as you do in your others. The fork passes no
         * identity, deliberately: a handle handed in would be a second, forgeable source of truth for whose
         * settings are being written.
         * @param {{label: string, description?: string, settingsPath: string, stylesheetPath?: string}} spec
         * @returns {void}
         */
        registerSettings(spec) {
            // Closed over for the same reason as everywhere else: not registrable on another's behalf.
            pluginSettings.register(id, spec);
        },

        /**
         * Tell the host something happened, so its button can show it.
         *
         * 🔴 THE POINT IS TIMING, NOT CONVENIENCE. `registerPanel`'s `statusPath` is PULLED, on the client's
         * schedule — only on `GENERATION_ENDED` and `CHAT_CHANGED`. Anything a plugin does deliberately off the
         * critical path finishes after both: Mnemosyne ingests memories fire-and-forget so a reply never waits
         * on an embedding, so the memory lands seconds after the generation ended and the poll that would have
         * seen it has already run. The button then lights one turn late, describing the previous turn. Calling
         * this at the moment the event happens is how a plugin escapes that, and no amount of correct code
         * inside the plugin substitutes for it.
         *
         * ⚠️ GENERIC ON PURPOSE, AND IT STAYS THAT WAY. `action` is your own opaque verb and `data` is your own
         * bag; the fork stores and returns them and parses neither. Do not expect the host to interpret either,
         * and do not ask it to — see the §14.1 rule this family is built on.
         *
         * ⚠️ COLOUR AND PRECEDENCE ARE YOURS. Supply `color` and the button wears it while your notification is
         * the most recent one. When two of your notifications land in one turn the LATEST wins, so ordering your
         * calls in the order the work happens gives you precedence for free — recall then write means the write
         * decides the colour, with nothing for the fork to rank.
         *
         * ⚠️ Pass `chatId` unless the event genuinely is not about one conversation. Without it the
         * notification is reported in EVERY chat, which for anything conversation-shaped is the staleness bug
         * §14.4 exists to prevent.
         *
         * 🔴 `data` MAY BE READ BACK BY THE CLIENT, so treat it as something the user will see. It is dropped on
         * logout and on vault lock, but it is not encrypted at rest in memory and it is not a place to park
         * anything you would not put on the screen.
         * @param {{handle: string, action: string, data?: object, chatId?: string, color?: string, summary?: string}} spec
         * @returns {void}
         */
        notify(spec) {
            // `id` is closed over for the same reason it is in registerPanel: a plugin cannot raise a
            // notification in another plugin's name.
            notifications.notify(id, spec);
        },

        /**
         * Run one completion against the backend this user is already talking to.
         *
         * The sibling of `embed`, for text rather than vectors — but where `embed` uses a local model that needs
         * no user, `generate` reaches a real backend, so it needs to know **whose** backend. Pass the handle;
         * it is the one you were handed by `onPrompt`/`onStorageReady`. The fork routes to the connection that
         * user's most recent generation used (see plugin-generate.js), so the plugin never names a backend and
         * needs no config to work.
         *
         * ⚠️ IT NEEDS A CAPTURED CONNECTION. One is captured by every text-completion generation and, since
         * apiVersion 7, by every panel request (the panel host sends the user's current connection and instruct
         * envelope), so a call made while handling a panel action works on the first click after a restart.
         * A call at boot, before that user has generated or opened a panel, still has nowhere to send and
         * throws — as does any call when the user's API is not text completion.
         *
         * ⚠️ `wrap` PUTS YOUR PROMPT IN THE BACKEND'S INSTRUCT ENVELOPE, and defaults to false. Without it, an
         * instruct-tuned model — test-host's KoboldCPP, for one — is handed an instruction it was never fine-tuned
         * to recognise, and an RP-tuned model will happily *continue* it as prose instead of *following* it.
         * The fork supplies the envelope the client computed; the decision to use it stays yours, because some
         * prompts should not be wrapped and the fork cannot know which. The envelope's terminators go into
         * `stop` FIRST and the cap is 4, so passing 4 stops of your own costs you some of them.
         *
         * 🔴 FAIL LOUD. No connection, an unsupported backend, a non-OK response — all throw, never a silent
         * empty string. `wrap: true` with no envelope captured throws too, rather than send your prompt bare —
         * and an envelope that frames NOTHING (`prefix` and `suffix` both empty, which is what the client
         * computes when the user has instruct mode off) counts as no envelope, because sending your prompt
         * through it would be sending it bare. Treat any throw as "retry next tick".
         *
         * 🔴 `finishReason` (apiVersion >= 5) IS HOW YOU TELL AN EMPTY ANSWER FROM A TRUNCATED ONE, AND ON A
         * REASONING MODEL YOU NEED IT. The chain of thought is billed against `maxTokens` and then discarded
         * before you see anything, so a ceiling that looks generous for the answer is easily short of what the
         * answer COSTS — the call comes back with `text: ''` and `finishReason: 'length'`, which is identical,
         * from the text alone, to a model that had nothing to say. Treat `'length'` as "raise the ceiling and
         * retry", never as an answer. It is the backend's own string, passed through verbatim, and it is
         * optional: absent means the backend did not say, which is not the same as a clean stop.
         *
         * `grammar` (apiVersion >= 3) constrains the backend's decoding to a GBNF grammar, so a backend that
         * HONOURS it cannot emit output that violates it. It is threaded to the backend's grammar sampler
         * (KoboldCpp honours it on the completions endpoint). It composes with `wrap` — the envelope frames the
         * prompt, the grammar shapes the output. `repPen` sets the repetition penalty (maps to the backend's
         * `rep_pen` sampler), useful when a grammar with no natural stop would otherwise let a low-temperature
         * model loop.
         *
         * 🔴 `grammar` AND `repPen` ARE ADVISORY, AND `has('grammar')` IS A FACT ABOUT THE FORK, NOT THE BACKEND.
         * The capability says this host will *accept* the parameter; it cannot promise the backend behind the
         * user's connection implements it, because the plugin does not choose that backend and the user may
         * change it mid-session. The fork drops both fields for any backend whose API schema does not list them
         * (Featherless, TogetherAI, InfermaticAI, vLLM, generic OpenAI — see `filterBodyForBackend`), so asking
         * for a grammar can never turn a working generation into a 400. What it CAN do is return unconstrained
         * text from a backend that ignored it.
         *
         * ⚠️ SO PARSE DEFENSIVELY EVEN WITH A GRAMMAR. A plugin that treats `has('grammar')` as a guarantee of
         * well-formed output will break the first time the user switches to a backend without a grammar
         * sampler. Constrained decoding is an optimisation here, never a contract.
         * @param {{handle: string, prompt: string, maxTokens?: number, temperature?: number, stop?: string[], wrap?: boolean, grammar?: string, repPen?: number}} params
         * @returns {Promise<{text: string, finishReason?: string}>} The completion text, and why the model stopped
         */
        async generate(params) {
            if (!params || typeof params !== 'object' || Array.isArray(params)) {
                throw new TypeError(`Plugin '${id}' called context.generate() with something other than a params object`);
            }
            if (typeof params.handle !== 'string' || !params.handle) {
                throw new TypeError(`Plugin '${id}' called context.generate() without a user handle`);
            }
            if (typeof params.prompt !== 'string' || !params.prompt) {
                throw new TypeError(`Plugin '${id}' called context.generate() without a non-empty prompt`);
            }

            return await pluginGenerate.generate({ ...params, wrap: params.wrap === true });
        },
    };
}

/**
 * Initializes a plugin module.
 * @param {import('express').Express} app Express app
 * @param {any} plugin Plugin module
 * @param {Array.<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @param {string} source The top-level plugins-directory entry this came from, for the inventory
 * @param {{name?: string, version?: string}} [packageInfo] What the package.json said, when there was one
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was initialized successfully
 */
async function initPlugin(app, plugin, exitHooks, source, packageInfo = {}) {
    /**
     * Log a manifest problem and put it in the inventory under the same message.
     *
     * ⚠️ ONE MESSAGE, TWO DESTINATIONS, AND THEY MUST NOT DRIFT. The log line is for whoever is tailing
     * st.log; the row is for whoever opens the Extensions dialog and finds a plugin they installed is not
     * there. Writing them separately is how the dialog ends up saying something subtly different from the log
     * about the same failure, which is worse than either one alone.
     * @param {string} message What went wrong
     * @param {object} [known] Whatever of the manifest was readable
     * @returns {false} Always, so callers can `return refuse(...)`
     */
    const refuse = (message, known = {}) => {
        log.error(LogClass.NORMAL, `Failed to load plugin module; ${message}`);
        inventory.recordFailure(source, 'manifest', new TypeError(message), { ...packageInfo, ...known });
        return false;
    };

    const info = plugin.info || plugin.default?.info;
    if (typeof info !== 'object') {
        return refuse('plugin info not found');
    }

    // "name" and "description" feed the `Server plugins` section of the Extensions dialog (§28) — which is
    // the UI this comment used to say "it would be nice to have", built at last. They were required before
    // anything read them, and that foresight is why every plugin already has both.
    for (const field of ['id', 'name', 'description']) {
        if (typeof info[field] !== 'string') {
            return refuse(`plugin info missing field '${field}'`);
        }
    }

    const init = plugin.init || plugin.default?.init;
    if (typeof init !== 'function') {
        return refuse('no init function', { id: info.id, name: info.name, description: info.description });
    }

    const { id } = info;

    if (!isValidPluginID(id)) {
        return refuse(`invalid plugin ID '${id}'`, { name: info.name, description: info.description });
    }

    if (attemptedPluginIds.has(id)) {
        return refuse(`plugin ID '${id}' is already in use`, { name: info.name, description: info.description });
    }

    // Allow the plugin to register API routes under /api/plugins/[plugin ID] via a router
    const router = express.Router();

    // 🔴 CLAIM THE ID BEFORE RUNNING `init`, NOT AFTER, OR A FAILED LOAD CAN BE RE-ENTERED.
    //
    // The guard above used to test `loadedPlugins`, which is set only once `init` has RETURNED. So an
    // `init` that threw left the id unclaimed — and `loadFromDirectory`, having seen `loadFromPackage`
    // return false, falls through to `index.js`, which for the overwhelmingly common `"main": "index.js"`
    // is the SAME FILE. `import()` hands back the cached module and `init` runs a second time, with the
    // guard still false. The result is every registration made twice: two panel buttons, and an
    // interceptor that fires twice per generation and injects twice.
    attemptedPluginIds.add(id);

    try {
        // A second argument costs nothing to a plugin that does not want it: JavaScript ignores surplus
        // arguments, so every plugin ever written against `init(router)` keeps working, untouched and unaware.
        //
        // 🔴 AND IT IS ON A CLOCK, BECAUSE BOOT BLOCKS ON IT. `loadPlugins` is awaited in the "before the
        // server starts listening" phase, so an `init` that never settles — `await someHandshake()` against
        // a host that is down is an ordinary thing for a memory plugin to want — is a SillyTavern that never
        // opens a port. Alive, consuming CPU, no error, last line "Initializing plugin from …". The design
        // doc rules exactly this unacceptable for the CLIENT-side panel call (§14.10) and the server-side
        // sibling did it anyway, with no `void`-call escape available.
        await withDeadline(
            init(router, createPluginContext(id)),
            getPluginTimeoutMs('plugins.initTimeoutMs', 30000),
            `Plugin '${id}' did not finish initializing`,
        );
    } catch (error) {
        // 🔴 A WEDGE STOPS THE BOOT. It does not get skipped so the server can come up "mostly working".
        // Starting without a plugin the operator installed means their memory plugin is silently absent —
        // the install looks healthy and quietly does half of what it was built to do. This is a bug in the
        // plugin, and it is the plugin's author who has to fix it, so say which one and refuse to start.
        if (error instanceof PluginDeadlineError) {
            log.error(LogClass.NORMAL, `Plugin '${id}' did not finish initializing within the configured timeout, so it has wedged the startup it blocks. SillyTavern will not start without it.`);
            log.error(LogClass.NORMAL, 'Fix the plugin, remove it from the plugins directory, or raise \'plugins.initTimeoutMs\' in config.yaml if it legitimately needs longer.');
            process.exit(1);
        }

        // The id stays claimed. A plugin that half-registered and then threw is not a plugin to try again:
        // its panel, interceptor and prompt-window declaration are already in the registries, and a second
        // pass would duplicate whichever of them it managed before failing.
        log.error(LogClass.NORMAL, `Plugin '${id}' threw while initializing. It is not loaded, and its id stays reserved so it cannot be loaded twice.`);
        log.error(LogClass.SENSITIVE, `Plugin '${id}' init error:`, error);
        // 🔴 THE SHARPEST EDGE §28 EXISTS FOR. This plugin parsed, declared itself, and then threw — so it is
        // installed, correctly named, and absent, which from the chat window is indistinguishable from a
        // plugin that was never installed at all. It gets a row saying so, with its own name on it.
        inventory.recordFailure(source, 'init', error, { ...packageInfo, id, name: info.name, description: info.description });
        return false;
    }

    loadedPlugins.set(id, plugin);
    inventory.recordLoaded(source, { ...packageInfo, id, name: info.name, description: info.description });

    // Add API routes to the app if the plugin registered any
    if (router.stack.length > 0) {
        // 🔴 IN FRONT OF THE WHOLE MOUNT, NOT JUST THE PANEL ROUTE. An interactive panel's actions go to
        // routes the plugin named itself (`/memory/137`), not to `/panel`, and they need the same ambient
        // identity. It is also what strips a client-supplied
        // `charAvatar` before any plugin handler can read one (§25.8).
        // The connection capture rides the same mount for the same reason: a panel ACTION is where a plugin
        // calls `context.generate()` with no generation behind it (API v7).
        app.use(`/api/plugins/${id}`, resolvePanelIdentity, capturePanelConnection, router);
    }

    const exit = plugin.exit || plugin.default?.exit;
    if (typeof exit === 'function') {
        exitHooks.push(exit);
    }

    return true;
}

/**
 * Automatically update all git plugins in the ./plugins directory
 * @param {string} pluginsPath Path to plugins directory
 */
async function updatePlugins(pluginsPath) {
    if (!enableServerPluginsAutoUpdate) {
        return;
    }

    const directories = fs.readdirSync(pluginsPath)
        .filter(file => !file.startsWith('.'))
        .filter(file => fs.statSync(path.join(pluginsPath, file)).isDirectory());

    if (directories.length === 0) {
        return;
    }

    log.info(LogClass.NORMAL, color.blue('Auto-updating server plugins... Set'), color.yellow('enableServerPluginsAutoUpdate: false'), color.blue('in config.yaml to disable this feature.'));

    if (!commandExistsSync('git')) {
        log.error(LogClass.NORMAL, color.red('Git is not installed. Please install Git to enable auto-updating of server plugins.'));
        return;
    }

    let pluginsToUpdate = 0;

    for (const directory of directories) {
        try {
            const pluginPath = path.join(pluginsPath, directory);
            const pluginRepo = git(pluginPath);

            const isRepo = await pluginRepo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
            if (!isRepo) {
                continue;
            }

            await pluginRepo.fetch();
            const commitHash = await pluginRepo.revparse(['HEAD']);
            const trackingBranch = await pluginRepo.revparse(['--abbrev-ref', '@{u}']);
            const commits = await pluginRepo.log({
                from: commitHash,
                to: trackingBranch,
            });

            if (commits.total === 0) {
                continue;
            }

            pluginsToUpdate++;
            await pluginRepo.pull();
            const latestCommit = await pluginRepo.revparse(['HEAD']);
            log.info(LogClass.NORMAL, `Plugin ${color.green(directory)} updated to commit ${color.cyan(latestCommit)}`);
        } catch (error) {
            log.error(LogClass.NORMAL, color.red(`Failed to update plugin ${directory}`));
            log.error(LogClass.SENSITIVE, color.red(`Failed to update plugin ${directory}: ${error.message}`));
        }
    }

    if (pluginsToUpdate === 0) {
        log.info(LogClass.NORMAL, 'All plugins are up to date.');
    }
}
