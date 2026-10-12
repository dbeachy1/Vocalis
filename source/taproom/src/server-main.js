// native node modules
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import net from 'node:net';
import dns from 'node:dns';
import process from 'node:process';
import http from 'node:http';
import https from 'node:https';

import cors from 'cors';
import { csrfSync } from 'csrf-sync';
import express from 'express';
import compression from 'compression';
import cookieSession from 'cookie-session';
import multer from 'multer';
import responseTime from 'response-time';
import helmet from 'helmet';
import bodyParser from 'body-parser';

// local library imports
import './fetch-patch.js';
import { serverDirectory } from './server-directory.js';

import { serverEvents, EVENT_NAMES } from './server-events.js';
import { loadPlugins } from './plugin-loader.js';
import * as storage from './storage.js';
import { loadStorageProviders } from './storage-provider-loader.js';
import {
    initUserStorage,
    getCookieSecret,
    getCookieSessionName,
    ensurePublicDirectoriesExist,
    getUserDirectoriesList,
    getUserDirectories,
    getDirectoriesHandle,
    migrateSystemPrompts,
    migrateUserData,
    recordUserActivity,
    requireLoginMiddleware,
    setUserDataMiddleware,
    shouldRedirectToLogin,
    startIdleLockSweep,
    cleanUploads,
    cleanUserUploads,
    migrateUserCss,
    migrateAccountAvatar,
    getSessionCookieAge,
    verifySecuritySettings,
    loginPageMiddleware,
    migratePublicOverrides,
    getAllEnabledUsers,
} from './users.js';

import getWebpackServeMiddleware from './middleware/webpack-serve.js';
import basicAuthMiddleware from './middleware/basicAuth.js';
import getWhitelistMiddleware from './middleware/whitelist.js';
import accessLoggerMiddleware, { getAccessLogPath, migrateAccessLog } from './middleware/accessLogWriter.js';
import multerMonkeyPatch from './middleware/multerMonkeyPatch.js';
import initRequestProxy from './request-proxy.js';
import initPrivateRequestFilter from './private-request-filter.js';
import cacheBuster from './middleware/cacheBuster.js';
import corsProxyMiddleware from './middleware/corsProxy.js';
import hostWhitelistMiddleware from './middleware/hostWhitelist.js';
import userCssMiddleware from './middleware/userCss.js';
import {
    getVersion,
    color,
    removeColorFormatting,
    getSeparator,
    safeReadFileSync,
    setWindowTitle,
    getConfigValue,
} from './util.js';
import { UPLOADS_DIRECTORY } from './constants.js';

// Routers
import { router as usersPublicRouter } from './endpoints/users-public.js';
import { router as storagePublicRouter } from './endpoints/storage-public.js';
import { router as storagePrivateRouter } from './endpoints/storage-private.js';
import { router as eventsRouter } from './endpoints/events.js';
import { init as statsInit, onExit as statsOnExit } from './endpoints/stats.js';
import { checkForNewContent } from './endpoints/content-manager.js';
import { init as settingsInit } from './endpoints/settings.js';
import { redirectDeprecatedEndpoints, ServerStartup, setupPrivateEndpoints } from './server-startup.js';
import { diskCache } from './endpoints/characters.js';
import { migrateFlatSecrets } from './endpoints/secrets.js';
import { migrateGroupChatsMetadataFormat } from './endpoints/groups.js';
import { log, LogClass, redact } from './logger.js';

// Work around a node v20.0.0, v20.1.0, and v20.2.0 bug. The issue was fixed in v20.3.0.
// https://github.com/nodejs/node/issues/47822#issuecomment-1564708870
// Safe to remove once support for Node v20 is dropped.
if (process.versions && process.versions.node && process.versions.node.match(/20\.[0-2]\.0/)) {
    // @ts-ignore
    if (net.setDefaultAutoSelectFamily) net.setDefaultAutoSelectFamily(false);
}

// Unrestrict console logs display limit
util.inspect.defaultOptions.maxArrayLength = null;
util.inspect.defaultOptions.maxStringLength = null;
util.inspect.defaultOptions.depth = 4;

/** @type {import('./command-line.js').CommandLineArguments} */
const cliArgs = globalThis.COMMAND_LINE_ARGS;

if (!cliArgs.enableIPv6 && !cliArgs.enableIPv4) {
    log.error(LogClass.NORMAL, 'error: You can\'t disable all internet protocols: at least IPv6 or IPv4 must be enabled.');
    process.exit(1);
}

// Set keep-alive preference for all HTTP/HTTPS requests.
http.globalAgent = new http.Agent({ keepAlive: cliArgs.enableKeepAlive });
https.globalAgent = new https.Agent({ keepAlive: cliArgs.enableKeepAlive });

const app = express();
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(compression());
app.use(responseTime());

app.use(bodyParser.json({ limit: '500mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));

// CORS Settings //
const corsEnabled = getConfigValue('cors.enabled', true, 'boolean');
if (corsEnabled) {
    const corsOrigin = getConfigValue('cors.origin', 'null');
    const corsMethods = getConfigValue('cors.methods', ['OPTIONS']);
    const corsAllowedHeaders = getConfigValue('cors.allowedHeaders', []);
    const corsExposedHeaders = getConfigValue('cors.exposedHeaders', []);
    const corsCredentials = getConfigValue('cors.credentials', false, 'boolean');
    const corsMaxAge = getConfigValue('cors.maxAge', null, 'number');

    /** @type {cors.CorsOptions} */
    const corsOptions = {
        origin: corsOrigin,
        methods: corsMethods,
        credentials: corsCredentials,
    };
    if (Array.isArray(corsAllowedHeaders) && corsAllowedHeaders.length > 0) {
        corsOptions.allowedHeaders = corsAllowedHeaders;
    }
    if (Array.isArray(corsExposedHeaders) && corsExposedHeaders.length > 0) {
        corsOptions.exposedHeaders = corsExposedHeaders;
    }
    if (corsMaxAge !== null && Number.isInteger(corsMaxAge)) {
        corsOptions.maxAge = corsMaxAge;
    }
    app.use(cors(corsOptions));
}

if (cliArgs.listen && cliArgs.basicAuthMode) {
    app.use(basicAuthMiddleware);
}

if (cliArgs.whitelistMode) {
    const whitelistMiddleware = await getWhitelistMiddleware();
    app.use(whitelistMiddleware);
}

app.use(hostWhitelistMiddleware);

if (cliArgs.listen) {
    app.use(accessLoggerMiddleware());
}

app.use(cookieSession({
    name: getCookieSessionName(cliArgs.port),
    sameSite: 'lax',
    httpOnly: true,
    maxAge: getSessionCookieAge(),
    secret: getCookieSecret(globalThis.DATA_ROOT),
}));

app.use(setUserDataMiddleware);

// CSRF Protection //
if (!cliArgs.disableCsrf) {
    const csrfSyncProtection = csrfSync({
        getTokenFromState: (req) => {
            if (!req.session) {
                log.error(LogClass.NORMAL, '(CSRF error) getTokenFromState: Session object not initialized');
                return;
            }
            return req.session.csrfToken;
        },
        getTokenFromRequest: (req) => {
            return req.headers['x-csrf-token']?.toString();
        },
        storeTokenInState: (req, token) => {
            if (!req.session) {
                log.error(LogClass.NORMAL, '(CSRF error) storeTokenInState: Session object not initialized');
                return;
            }
            req.session.csrfToken = token;
        },
        skipCsrfProtection: (req) => {
            return cliArgs.enableCorsProxy ? /^\/proxy\//.test(req.path) : false;
        },
        size: 32,
    });

    app.get('/csrf-token', (req, res) => {
        res.json({
            'token': csrfSyncProtection.generateToken(req),
        });
    });

    // Customize the error message
    csrfSyncProtection.invalidCsrfTokenError.message = color.red('Invalid CSRF token. Please refresh the page and try again.');
    csrfSyncProtection.invalidCsrfTokenError.stack = undefined;

    app.use(csrfSyncProtection.csrfSynchronisedProtection);
} else {
    log.warn(LogClass.NORMAL, '\nCSRF protection is disabled. This will make your server vulnerable to CSRF attacks.\n');
    app.get('/csrf-token', (req, res) => {
        res.json({
            'token': 'disabled',
        });
    });
}

// Static files
// Host index page
app.get('/', cacheBuster.middleware, (request, response) => {
    if (shouldRedirectToLogin(request)) {
        const query = request.url.split('?')[1];
        const redirectUrl = query ? `/login?${query}` : '/login';
        return response.redirect(redirectUrl);
    }

    return response.sendFile('index.html', { root: path.join(serverDirectory, 'public') });
});

// Callback endpoint for OAuth PKCE flows (e.g. OpenRouter)
app.get('/callback/:source?', (request, response) => {
    const source = request.params.source;
    const query = request.url.split('?')[1];
    const searchParams = new URLSearchParams();
    source && searchParams.set('source', source);
    query && searchParams.set('query', query);
    const path = `/?${searchParams.toString()}`;
    return response.redirect(307, path);
});

// Host login page
app.get('/login', loginPageMiddleware);

// Host frontend assets
const webpackMiddleware = getWebpackServeMiddleware();
app.use(webpackMiddleware);
app.use(express.static(path.join(serverDirectory, 'public'), {}));

// Public API
app.use('/api/users', usersPublicRouter);

// The login page has to be able to say "Encryption enabled" before anybody has logged in, so this sits above
// the auth boundary with the user list. It answers one instance-level boolean and never names the provider —
// see the header of `storage-public.js` for what it may and may not say, and why.
app.use('/api/storage', storagePublicRouter);

// Everything below this line requires authentication
app.use(requireLoginMiddleware);

// 🔴 THE PER-CHAT STORAGE MARKER, AND IT SITS HERE FOR ONE REASON: it must never be reachable anonymously.
// `storagePublicRouter` above answers one instance-level boolean and refuses to name the provider, because
// `POST /api/users/list` already hands unauthenticated callers every handle on the box — a per-chat or
// per-user encryption flag anywhere above this line would turn that into a targeting list. Same mount path,
// opposite side of the boundary, exactly as usersPublicRouter and usersPrivateRouter already are. See
// DESIGN_MIXED_MODE.md §10 and the header of storage-private.js.
app.use('/api/storage', storagePrivateRouter);

// The server→client event channel. Below the auth boundary because its payloads name a user's World Books
// and character cards; see the header of endpoints/events.js and event-stream.js.
app.use('/api/events', eventsRouter);

// 🔴 userCssMiddleware USED TO BE MOUNTED ABOVE THIS LINE — seven lines above, in fact, which meant
// GET /css/user.css served a user's own stylesheet to any unauthenticated client that asked for it.
// It is user-authored content, it now lives in the user's own directory, and serving it requires
// knowing (and proving) who the user is. So it moves below the auth boundary.
app.use(userCssMiddleware);
app.post('/api/ping', (request, response) => {
    if (request.query.extend && request.session) {
        request.session.touch = Date.now();
    }

    response.sendStatus(204);
});

if (cliArgs.enableCorsProxy) {
    app.use('/proxy/:url(*)', corsProxyMiddleware);
} else {
    app.use('/proxy/:url(*)', async (_, res) => {
        const message = 'CORS proxy is disabled. Enable it in config.yaml or use the --corsProxy flag.';
        log.info(LogClass.NORMAL, message);
        res.status(404).send(message);
    });
}

// File uploads.
//
// 🔴 UPLOADS USED TO LAND IN <DATA_ROOT>/_uploads — OUTSIDE EVERY USER DIRECTORY.
//
// That is where every import touches the disk, in the clear, BEFORE a single line of SillyTavern's own
// code runs: character PNGs, chat JSONL, world info, speech-to-text audio. A provider whose ownership
// rule is "everything under <DATA_ROOT>/<handle>/" would never have seen any of it, and every card the
// user ever imported would have hit the platter in plaintext on its way in.
//
// Uploads now stage inside the uploading user's own directory. multer's `dest` cannot express that,
// because it is a single static path — but `storage` takes precedence over `dest`, and a StorageEngine
// is called per request. By the time it runs, setUserDataMiddleware has already populated req.user, so
// the engine knows whose upload this is.
const defaultUploadStorage = multer.diskStorage({
    destination: (request, _file, cb) => {
        const root = request.user?.directories?.root ?? cliArgs.dataRoot;
        const uploadsPath = path.join(root, UPLOADS_DIRECTORY);
        fs.mkdirSync(uploadsPath, { recursive: true });
        cb(null, uploadsPath);
    },
});

/**
 * 🔴 THE PROVIDER IS NOT REGISTERED YET, AND THIS IS WHY THE SEAM WAS DEAD CODE.
 *
 * This runs at MODULE SCOPE. `loadStorageProviders()` runs far later, inside the boot sequence. So asking
 * `storage.multerStorage()` here always got `null` — every time, on every install — and the plaintext
 * fallback above was installed permanently. The engine a provider offered was never once called, and every
 * upload staged in the clear regardless.
 *
 * It failed silently and it looked exactly like working code. Resolve the engine on FIRST USE instead, by
 * which time a provider (if there is one) has registered.
 * @type {any}
 */
let resolvedUploadStorage = null;

/** @returns {any} The upload engine: the provider's if it has one, otherwise multer's own. */
function uploadEngine() {
    if (resolvedUploadStorage) {
        return resolvedUploadStorage;
    }

    const provided = storage.multerStorage();

    // 🔴 A REGISTERED PROVIDER THAT DECLINED THIS SEAM DOES NOT GET THE FALLBACK. `?? defaultUploadStorage`
    // read "no provider" and "a provider without a multerStorage" as the same thing, and they are opposites.
    // The fallback writes with raw `fs` into `<user root>/_uploads` — INSIDE the provider's own tree, past
    // the provider — and that is where every import touches the disk first: character PNGs, chat JSONL,
    // world info, speech-to-text audio. Pre-fork the same fallback staged into `<DATA_ROOT>/_uploads`,
    // outside every user directory; moving staging inside the user root is what turned a bad default into a
    // write through somebody's protection. `required` does not list this seam and the typedef marks it
    // optional, so a provider could decline it and never be told.
    //
    // ⚠️ REFUSED AT FIRST USE, NOT AT BOOT. Registration now warns for every seam a provider omits, which is
    // the right place to be noisy; refusing the whole boot would take down an install over a feature its
    // owner may never touch. This refuses the unsafe write itself, and only that.
    if (!provided && storage.hasProvider()) {
        throw new Error('The installed storage provider does not implement the multerStorage seam, so uploads would be staged past it inside its own directory. Refusing to stage the upload.');
    }

    return resolvedUploadStorage = (provided ?? defaultUploadStorage);
}

const uploadStorage = {
    _handleFile: (request, file, callback) => uploadEngine()._handleFile(request, file, callback),
    _removeFile: (request, file, callback) => uploadEngine()._removeFile(request, file, callback),
};

app.use(multer({ storage: uploadStorage, limits: { fieldSize: 500 * 1024 * 1024 } }).single('avatar'));
app.use(multerMonkeyPatch);

app.get('/version', async function (_, response) {
    const data = await getVersion();
    response.send(data);
});

redirectDeprecatedEndpoints(app);
setupPrivateEndpoints(app);

/**
 * The per-user maintenance tasks: migrations, content seeding, cache verification, backups, stats.
 *
 * Every one of them reads and rewrites user data, so every one of them must wait until that user's
 * storage can actually be served. They run at boot for available users, and on first availability for
 * the rest.
 * @param {import('./users.js').UserDirectoryList[]} directories Users whose storage is available
 * @returns {Promise<void>}
 */
async function runUserMaintenanceTasks(directories) {
    if (directories.length === 0) {
        return;
    }

    await migrateSystemPrompts(directories);
    await migrateGroupChatsMetadataFormat(directories);
    await checkForNewContent(directories);
    await diskCache.verify(directories);
    migrateFlatSecrets(directories);

    // All three of these write or list INSIDE a user's directory, so all three need that user's storage to
    // be available -- and they used to run at boot, where it is not. Against a provider they threw, were
    // caught, logged, and did nothing, every boot, for ever. They wait for the user now, like everything
    // else.
    for (const dir of directories) {
        await cleanUserUploads(dir);
        await migrateUserCss(dir);
        await migrateAccountAvatar(dir);
    }

    await settingsInit(directories);
    await statsInit(directories);
}

/**
 * Tasks that need to be run before the server starts listening.
 * @returns {Promise<void>}
 */
async function preSetupTasks() {
    const version = await getVersion();

    // Print formatted header
    log.info(LogClass.NORMAL);
    log.info(LogClass.NORMAL, `SillyTavern ${version.pkgVersion}`);
    if (version.gitBranch && version.commitDate) {
        const date = new Date(version.commitDate);
        const localDate = date.toLocaleString('en-US', { timeZoneName: 'short' });
        log.info(LogClass.NORMAL, `Running '${version.gitBranch}' (${version.gitRevision}) - ${localDate}`);
        if (!version.isLatest && ['staging', 'release'].includes(version.gitBranch)) {
            log.info(LogClass.NORMAL, 'INFO: Currently not on the latest commit.');
            log.info(LogClass.NORMAL, '      Run \'git pull\' to update. If you have any merge conflicts, run \'git reset --hard\' and \'git pull\' to reset your branch.');
        }
    }
    log.info(LogClass.NORMAL);

    const directories = await getUserDirectoriesList();

    // These tasks read or rewrite user data. Run them only when that user's storage is ready, and defer
    // the rest until the provider reports availability. Without a provider, storage is always ready and
    // startup behavior is unchanged.
    const available = directories.filter(dir => storage.isReady(getDirectoriesHandle(dir)));
    const deferred = directories.filter(dir => !storage.isReady(getDirectoriesHandle(dir)));

    if (deferred.length > 0) {
        log.info(LogClass.NORMAL, color.yellow(`Storage is not yet available for ${deferred.length} user(s). Their maintenance tasks are deferred until they log in.`));
    }

    await runUserMaintenanceTasks(available);

    // Start the idle clock on the ready notification. Request middleware runs before login establishes
    // the session, so it cannot record activity for the login request itself. This hook covers every
    // path that opens a vault, including password login, basic auth, auto-login, and recovery.
    storage.onUserStorageReady(async (handle) => {
        recordUserActivity(handle);
    });

    // And when a user's storage does become available -- they log in, the vault unlocks -- their
    // deferred maintenance runs then, on first availability rather than at boot.
    storage.onUserStorageReady(async (handle) => {
        // Split per §5.3: the fact that deferred work is running is a diagnostic, the handle it ran
        // for is user data.
        log.info(LogClass.NORMAL, 'Storage is now available for a user. Running deferred maintenance tasks.');
        log.info(LogClass.SENSITIVE, `Deferred maintenance is running for ${handle}.`);
        await runUserMaintenanceTasks([getUserDirectories(handle)]);
    });

    await cleanUploads();
    migrateAccessLog();

    // 🔒 Lock idle users. Logging out locks the vault, but almost nobody logs out — they close the tab and
    // walk away, and a cookieSession server never learns that they did. Without this, an unlocked vault
    // stays unlocked until the process exits.
    await startIdleLockSweep();

    // Keep the plugin root configurable so tests and deployments can select an isolated plugin set.
    const pluginsDirectory = getConfigValue('pluginsPath', path.join(serverDirectory, 'plugins'));
    const cleanupPlugins = await loadPlugins(app, pluginsDirectory);
    const consoleTitle = process.title;

    let isExiting = false;
    const exitProcess = async () => {
        if (isExiting) return;
        isExiting = true;
        await statsOnExit();
        if (typeof cleanupPlugins === 'function') {
            await cleanupPlugins();
        }
        diskCache.dispose();
        setWindowTitle(consoleTitle);
        process.exit();
    };

    // Set up event listeners for a graceful shutdown
    process.on('SIGINT', exitProcess);
    process.on('SIGTERM', exitProcess);
    process.on('uncaughtException', (err) => {
        log.error(LogClass.NORMAL, 'Uncaught exception');
        log.error(LogClass.SENSITIVE, 'Uncaught exception:', err);
        exitProcess();
    });

    // 🔴 A REJECTED PROMISE IS A BUG, NOT A REASON TO EVICT EVERY LOGGED-IN USER.
    //
    // Node raises an unhandled rejection as an uncaught exception when nothing is listening for it — and the
    // handler directly above answers an uncaught exception by shutting the server down. That arrangement was
    // survivable upstream, where almost nothing rejects. It is not survivable here: the storage seam THROWS
    // BY DESIGN whenever a vault is locked, which is a routine state this fork deliberately creates (idle
    // lock, restart with a live session, a provider that is simply unavailable for a moment). One request
    // handler that forgot a try/catch would therefore take the whole install down for everyone on it.
    //
    // So: say so, loudly, with the stack — and keep serving. A rejection nobody handled is a defect to fix in
    // the code that made it, and this listener is what makes it a log line to act on rather than an outage.
    process.on('unhandledRejection', (reason) => {
        log.error(LogClass.NORMAL, 'Unhandled promise rejection. The server is still running; this is a defect and should be fixed.');
        log.error(LogClass.SENSITIVE, 'Unhandled promise rejection:', reason);
    });

    // Add private request filter.
    const requestFilterOptions = {
        listen: cliArgs.listen,
        enabled: !!getConfigValue('privateAddressWhitelist.enabled', false, 'boolean'),
        privateAddressWhitelist: getConfigValue('privateAddressWhitelist.allowedRanges', ['127.0.0.0/8', '::1/128']),
        logBlocked: !!getConfigValue('privateAddressWhitelist.log.blockedRequests', true, 'boolean'),
        logAllowed: !!getConfigValue('privateAddressWhitelist.log.allowedRequests', false, 'boolean'),
        allowUnresolvedHosts: !!getConfigValue('privateAddressWhitelist.allowUnresolvedHosts', false, 'boolean'),
        enableKeepAlive: cliArgs.enableKeepAlive,
    };
    initPrivateRequestFilter(requestFilterOptions);

    // Add request proxy.
    initRequestProxy({ enabled: cliArgs.requestProxyEnabled, url: cliArgs.requestProxyUrl, bypass: cliArgs.requestProxyBypass, enableKeepAlive: cliArgs.enableKeepAlive, privateRequestFilterEnabled: requestFilterOptions.enabled });

    // Wait for frontend libs to compile
    await webpackMiddleware.runWebpackCompiler({ pruneCache: true });
}

/**
 * Tasks that need to be run after the server starts listening.
 * @param {import('./server-startup.js').ServerStartupResult} result The result of the server startup
 * @returns {Promise<void>}
 */
async function postSetupTasks(result) {
    const browserLaunchHostname = await cliArgs.getBrowserLaunchHostname(result);
    const browserLaunchUrl = cliArgs.getBrowserLaunchUrl(browserLaunchHostname);
    const browserLaunchApp = String(getConfigValue('browserLaunch.browser', 'default') ?? '');

    if (cliArgs.browserLaunchEnabled) {
        try {
            // TODO: This should be converted to a regular import when support for Node 18 is dropped
            const openModule = await import('open');
            const { default: open, apps } = openModule;

            function getBrowsers() {
                const isAndroid = process.platform === 'android';
                if (isAndroid) {
                    return {};
                }
                return {
                    'firefox': apps.firefox,
                    'chrome': apps.chrome,
                    'edge': apps.edge,
                    'brave': apps.brave,
                };
            }

            const validBrowsers = getBrowsers();
            const appName = validBrowsers[browserLaunchApp.trim().toLowerCase()];
            const openOptions = appName ? { app: { name: appName } } : {};

            log.info(LogClass.NORMAL, `Launching in a browser: ${browserLaunchApp}...`);
            await open(browserLaunchUrl.toString(), openOptions);
        } catch (error) {
            log.error(LogClass.NORMAL, 'Failed to launch the browser. Open the URL manually.');
            log.error(LogClass.SENSITIVE, 'Failed to launch the browser. Open the URL manually.', error);
        }
    }

    if (cliArgs.heartbeatInterval > 0) {
        // Convert seconds to milliseconds for the timer
        const intervalMs = cliArgs.heartbeatInterval * 1000;
        const heartbeatPath = path.join(globalThis.DATA_ROOT, 'heartbeat.json');

        // Split per §5.3: the interval is a safe value worth keeping, the path is not. `heartbeatPath`
        // is DATA_ROOT-derived and expands to `/home/<account>` or `C:\Users\<account>` on a global
        // install — §5.3.1, and line 542 below already held this same variable SENSITIVE.
        log.info(LogClass.NORMAL, `Heartbeat enabled. Updating every ${cliArgs.heartbeatInterval} seconds.`);
        log.info(LogClass.NORMAL, 'Heartbeat file:', redact(color.green(heartbeatPath)));

        const writeHeartbeat = () => {
            try {
                fs.writeFileSync(heartbeatPath, JSON.stringify({ timestamp: Date.now() }));
            } catch (err) {
                log.error(LogClass.NORMAL, 'Failed to write the heartbeat file');
                log.error(LogClass.SENSITIVE, `Failed to write heartbeat file at ${color.green(heartbeatPath)}:`, err.message);
            }
        };

        // Write immediately
        writeHeartbeat();

        // Loop using the converted milliseconds
        setInterval(writeHeartbeat, intervalMs).unref();
    }

    setWindowTitle('SillyTavern WebServer');

    let logListen = 'SillyTavern is listening on';

    if (result.useIPv6 && !result.v6Failed) {
        logListen += color.green(
            ' IPv6: ' + cliArgs.getIPv6ListenUrl().host,
        );
    }

    if (result.useIPv4 && !result.v4Failed) {
        logListen += color.green(
            ' IPv4: ' + cliArgs.getIPv4ListenUrl().host,
        );
    }

    const goToLog = `Go to: ${color.blue(browserLaunchUrl)} to open SillyTavern`;
    const plainGoToLog = removeColorFormatting(goToLog);

    log.info(LogClass.NORMAL, logListen);
    if (cliArgs.listen) {
        log.info(LogClass.NORMAL);
        log.info(LogClass.NORMAL, 'To limit connections to internal localhost only ([::1] or 127.0.0.1), change the setting in config.yaml to "listen: false".');
        // Split per §5.3: the instruction is safe prose and survives, the resolved path is DATA_ROOT-
        // derived and carries the account name (§5.3.1). This fires on every boot of a listening install.
        log.info(LogClass.NORMAL, 'Check the "access.log" file in the data directory to inspect incoming connections.');
        log.info(LogClass.SENSITIVE, color.green(getAccessLogPath()));
    }
    log.info(LogClass.NORMAL, '\n' + getSeparator(plainGoToLog.length) + '\n');
    log.info(LogClass.NORMAL, goToLog);
    log.info(LogClass.NORMAL, '\n' + getSeparator(plainGoToLog.length) + '\n');

    // The log level used to be applied here, at the very end of startup, by stubbing out console
    // methods. The writer applies it from the moment the log file opens instead — see logger.js.
    serverEvents.emit(EVENT_NAMES.SERVER_STARTED, { url: browserLaunchUrl });
}

/**
 * Registers a not-found error response if a not-found error page exists. Should only be called after all other middlewares have been registered.
 */
function apply404Middleware() {
    const notFoundWebpage = safeReadFileSync(path.join(globalThis.DATA_ROOT, '_errors', 'url-not-found.html')) ?? '';
    app.use((req, res) => {
        res.status(404).send(notFoundWebpage);
    });
}

/**
 * Registers the terminal error handler. Must be registered after every other middleware, the 404
 * included, because express only looks *forward* from the point of failure for a 4-arg handler.
 *
 * 🔴 EXPRESS'S DEFAULT ERROR HANDLER PUTS `err.stack` IN THE RESPONSE BODY, AND A STACK CAN QUOTE THE
 * USER'S OWN CONTENT BACK AT THEM.
 *
 * With no 4-arg handler registered anywhere, a thrown error falls through to express's `finalhandler`,
 * which answers with the stack whenever `NODE_ENV` is not `production` — and `NODE_ENV` is normally
 * unset here (see the comment in `server.js`). That is harmless for a `TypeError`. It is not harmless
 * for the error this tree throws most, which is `JSON.parse` against a file the user owns, because V8
 * quotes the input back inside the message:
 *
 *     JSON.parse('{"a": some_content}')
 *     → SyntaxError: Unexpected token 's', "{"a": some_con"... is not valid JSON
 *
 * So `readWorldInfoFile`'s deliberate rethrow (`endpoints/worldinfo.js`) answered a corrupt lorebook
 * with a fragment of that lorebook in the HTTP body. It only ever reached the session that asked for
 * it — the requester already owns the file — which is why this was a hazard and not a breach. But a
 * response body travels where a file does not: a client's own error log, a bug report, a screenshot.
 * In a fork whose whole premise is that this content is encrypted at rest, decrypted fragments have no
 * business in transport. The body now carries the status and nothing else, and the detail goes to the
 * log under the class that already governs content.
 *
 * ⚠️ THIS CHANGES NOTHING FOR AN ENDPOINT THAT REPORTS ITS OWN FAILURE. An error handler runs only for
 * a thrown error or an explicit `next(err)`; `response.status(400).send('...')` never reaches it. Every
 * call site under `public/` that reads an error body with `response.text()` is reading one of those
 * deliberate messages, and none of them are touched.
 *
 * ⚠️ AND `expose` IS WHY THE 4xx MESSAGES SURVIVE. `http-errors` marks anything under 500 as
 * `expose: true`, meaning the message was written to be read — body-parser's 400/413 and csrf-sync's
 * 403 (whose text this file customises above) all carry it. A bare `throw new Error(...)` from an
 * endpoint carries nothing, so it gets the status alone. Keying on the flag preserves every authored
 * message and drops every accidental one, which is the same rule finalhandler applies in production.
 *
 * 🔴 The status must be preserved for the same reason: the client branches on 403 to re-authenticate
 * (`public/scripts/user.js`). Collapsing everything to 500 would strand a locked session on a dead page.
 */
function applyErrorMiddleware() {
    app.use((err, req, res, next) => {
        // Headers already flushed: there is no response left to write, and finalhandler is the only
        // thing that can still tear the socket down. Hand it back rather than throwing on top.
        if (res.headersSent) {
            return next(err);
        }

        const status = Number(err?.status ?? err?.statusCode) || 500;

        // The router mount point is a literal from this file for anything under /api, so it names the
        // failing endpoint without quoting the request. Nothing else about a URL is publishable:
        // `/proxy/:url` embeds a whole foreign URL, and every query string is user-supplied.
        const route = /^\/api\/[^/?#]+/.exec(req.originalUrl ?? '')?.[0] ?? '<non-api>';
        const length = req.get('content-length') ?? 'unknown';

        log.error(LogClass.NORMAL, `Unhandled ${status} from ${req.method} ${route}, request body ${length} bytes:`, redact(req.originalUrl));
        // Both halves are SENSITIVE and both are wanted: the error carries the parse snippet (and, when
        // body-parser is the thrower, the raw payload on `err.body`), while `req.body` is the only
        // record of what arrived when the throw came from the handler instead. Debug mode is the switch
        // the operator already has for "show me exactly what came in".
        log.error(LogClass.SENSITIVE, 'Unhandled request error:', err);
        log.error(LogClass.SENSITIVE, 'Request body was:', req.body);

        if (err?.expose === true && typeof err.message === 'string') {
            return res.status(status).send(err.message);
        }

        return res.sendStatus(status);
    });
}

/**
 * Sets the DNS resolution order based on the command line arguments.
 */
function setDnsResolutionOrder() {
    try {
        if (cliArgs.dnsPreferIPv6) {
            dns.setDefaultResultOrder('ipv6first');
            log.info(LogClass.NORMAL, 'Preferring IPv6 for DNS resolution');
        } else {
            dns.setDefaultResultOrder('ipv4first');
            log.info(LogClass.NORMAL, 'Preferring IPv4 for DNS resolution');
        }
    } catch (error) {
        log.warn(LogClass.NORMAL, 'Failed to set DNS resolution order. Possibly unsupported in this Node version.');
    }
}

/**
 * Loads the storage provider, if one is installed.
 *
 * Load providers after the accounts store is initialized, so they can inspect account metadata, but before
 * any boot task reads or writes user data. The general plugin loader runs too late for this boundary.
 * @returns {Promise<void>}
 */
async function initStorageProviders() {
    const providersPath = getConfigValue('storageProvidersPath', path.join(serverDirectory, 'storage-providers'));

    // Providers may require a password to unlock storage, but accounts can be disabled, passwordless
    // (including automatic login), or authenticated by a proxy. Pass the account shape so each provider
    // can reject configurations it cannot support; this does not imply encryption.
    const users = await getAllEnabledUsers();

    await loadStorageProviders(providersPath, {
        dataRoot: globalThis.DATA_ROOT,
        requiredProviderId: getConfigValue('storageProvidersRequiredId', ''),
        accountsEnabled: !!getConfigValue('enableUserAccounts', false, 'boolean'),
        basicAuthMode: !!getConfigValue('basicAuthMode', false, 'boolean'),
        // The SSO settings are nested under `sso`; include them with per-user basic auth in the provider's
        // authentication summary.
        authenticationDelegated: !!getConfigValue('sso.autheliaAuth', false, 'boolean') || !!getConfigValue('sso.authentikAuth', false, 'boolean') || !!getConfigValue('perUserBasicAuth', false, 'boolean'),
        users: users.map(user => ({
            handle: user.handle,
            enabled: !!user.enabled,
            hasPassword: !!user.password,
        })),
    });
}

// User storage module needs to be initialized before starting the server
initUserStorage(globalThis.DATA_ROOT)
    .then(initStorageProviders)
    .then(setDnsResolutionOrder)
    .then(ensurePublicDirectoriesExist)
    .then(migrateUserData)
    .then(migratePublicOverrides)
    .then(verifySecuritySettings)
    .then(preSetupTasks)
    .then(apply404Middleware)
    .then(applyErrorMiddleware)
    .then(() => new ServerStartup(app, cliArgs).start())
    .then(postSetupTasks);
