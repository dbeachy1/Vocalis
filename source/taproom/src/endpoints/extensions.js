import * as storage from '../storage.js';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as commandExistsSync } from 'command-exists';
import { CheckRepoActions, default as simpleGit } from 'simple-git';

import { PUBLIC_DIRECTORIES } from '../constants.js';
import { getConfigValue, isValidUrl } from '../util.js';
import { createGitClient } from '../git/client.js';
import { log, LogClass } from '../logger.js';

const gitBackend = getConfigValue('git.backend', 'auto');

/**
 * @type {Partial<import('simple-git').SimpleGitOptions>}
 */
const OPTIONS = Object.freeze({ timeout: { block: 5 * 60 * 1000 } });

// ---------------------------------------------------------------------------------------------------------------
// WHAT THIS SERVER CAN DO WITH AN EXTENSION (Taproom, October 11, 2026, pre-release audit)
// ---------------------------------------------------------------------------------------------------------------
//
// The Taproom image has no git binary, and the bundled extensions (Vocalis, Cache Lens, MCP Client) live in the
// image's read-only `public/scripts/extensions/third-party` folder, which is also this fork's "global" extension
// folder. Updating an extension, listing or switching its branches, installing for all users, and deleting or moving
// a bundled one therefore could not work, and each failed with a generic 500 (or, for delete, answered nothing the
// page checked). The page now asks `GET /api/extensions/capabilities` once and offers only what can work, and every
// route below refuses the rest with one plain sentence. Both facts are measured here, not configured: a fork run
// from a writable checkout with git installed behaves exactly as before.
//
// "Install just for me" is unaffected: `createGitClient` falls back to isomorphic-git (pure JavaScript) when there is
// no git binary, so a clone into the user's own folder needs neither git nor a writable image.

export const UPDATE_UNAVAILABLE_MESSAGE = 'This package has no git, so an installed extension cannot be updated in place. Remove it and install it again to get a newer version.';
export const GLOBAL_INSTALL_UNAVAILABLE_MESSAGE = 'Installing an extension for all users is not available in this package, because the folder for them is part of the Taproom image and cannot be written. Use "Install just for me" instead.';
export const BUNDLED_EXTENSION_MESSAGE = 'This extension comes with Taproom, so it cannot be deleted, moved, or updated on its own. It is updated with Taproom. To stop using it, turn it off with its switch.';

/** Each "unavailable" notice is logged once per process at NORMAL, so a page that polls cannot fill the log. */
const noticesLogged = new Set();

/**
 * Log a capability notice the first time it applies.
 * @param {string} key Which notice
 * @param {string} message What to log
 * @returns {void}
 */
function logNoticeOnce(key, message) {
    if (noticesLogged.has(key)) {
        return;
    }

    noticesLogged.add(key);
    log.info(LogClass.NORMAL, message);
}

/**
 * Is there a git binary this server can run? `simple-git` (update, branches, switch, version) always shells out to it.
 * @returns {boolean} True if `git` is on the PATH
 */
export function isGitAvailable() {
    return commandExistsSync('git');
}

/**
 * Can the global extension folder be written to? False in the Taproom image (read-only tree, non-root user).
 * @returns {boolean} True if an extension can be added to, changed in, or removed from the global folder
 */
export function isGlobalExtensionFolderWritable() {
    try {
        fs.accessSync(PUBLIC_DIRECTORIES.globalExtensions, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Names of the extension folders that come with the application: everything in the global folder when that folder
 * cannot be written (nothing else could have put it there). Empty when the folder is writable, because then a global
 * extension is one an administrator installed and may update, move or delete as upstream allows.
 * @returns {string[]} Folder names, as the page names them after `third-party/`
 */
export function listBundledExtensions() {
    if (isGlobalExtensionFolderWritable() || !fs.existsSync(PUBLIC_DIRECTORIES.globalExtensions)) {
        return [];
    }

    return fs.readdirSync(PUBLIC_DIRECTORIES.globalExtensions, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
}

/**
 * The single answer the page reads about what extension management can do here.
 * @returns {{update: boolean, updateMessage: string, globalInstall: boolean, globalInstallMessage: string, bundled: string[], bundledMessage: string}} Capabilities
 */
export function getExtensionCapabilities() {
    const update = isGitAvailable();
    const globalInstall = isGlobalExtensionFolderWritable();
    const bundled = listBundledExtensions();

    return {
        update,
        updateMessage: update ? '' : UPDATE_UNAVAILABLE_MESSAGE,
        globalInstall,
        globalInstallMessage: globalInstall ? '' : GLOBAL_INSTALL_UNAVAILABLE_MESSAGE,
        bundled,
        bundledMessage: bundled.length ? BUNDLED_EXTENSION_MESSAGE : '',
    };
}

/**
 * Refuse an operation that needs git when there is none, or that targets a bundled extension.
 * @param {import('express').Response} response The response to answer on
 * @param {object} what What was asked
 * @param {string} what.operation The route, for the log
 * @param {boolean} what.needsGit Whether the operation shells out to git
 * @param {boolean} what.global Whether the target is in the global folder
 * @param {string} what.extension The sanitized folder name, for the log
 * @returns {boolean} True if the request was refused and answered (the caller must return)
 */
function refuseIfUnavailable(response, { operation, needsGit, global, extension }) {
    if (needsGit && !isGitAvailable()) {
        logNoticeOnce('no-git', 'Extension updates are unavailable on this server: there is no git binary. Update, branch and version requests are refused with a plain message.');
        log.warn(LogClass.NORMAL, `Extension ${operation} refused: no git binary`);
        log.warn(LogClass.SENSITIVE, `Extension ${operation} refused for '${extension}': no git binary`);
        response.status(501).send(UPDATE_UNAVAILABLE_MESSAGE);
        return true;
    }

    if (global && !isGlobalExtensionFolderWritable()) {
        log.warn(LogClass.NORMAL, `Extension ${operation} refused: the target is a bundled extension`);
        log.warn(LogClass.SENSITIVE, `Extension ${operation} refused for '${extension}': it is in the read-only global folder`);
        response.status(409).send(BUNDLED_EXTENSION_MESSAGE);
        return true;
    }

    return false;
}

/**
 * This function extracts the extension information from the manifest file.
 * @param {string} extensionPath - The path of the extension folder
 * @returns {Promise<Object>} - Returns the manifest data as an object
 */
async function getManifest(extensionPath) {
    const manifestPath = path.join(extensionPath, 'manifest.json');

    // Check if manifest.json exists
    if (!storage.exists(manifestPath)) {
        throw new Error(`Manifest file not found at ${manifestPath}`);
    }

    const manifest = JSON.parse(storage.readFileSync(manifestPath, 'utf8'));
    return manifest;
}

/**
 * This function checks if the local repository is up-to-date with the remote repository.
 * @param {string} extensionPath - The path of the extension folder
 * @returns {Promise<Object>} - Returns the extension information as an object
 */
async function checkIfRepoIsUpToDate(extensionPath) {
    const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
    await git.fetch('origin');
    const currentBranch = await git.branch();
    const currentCommitHash = await git.revparse(['HEAD']);
    const commits = await git.log({
        from: currentCommitHash,
        to: `origin/${currentBranch.current}`,
    });

    // Fetch remote repository information
    const remotes = await git.getRemotes(true);
    if (remotes.length === 0) {
        return {
            isUpToDate: true,
            remoteUrl: '',
        };
    }

    return {
        isUpToDate: commits.total === 0,
        remoteUrl: remotes[0].refs.fetch, // URL of the remote repository
    };
}

export const router = express.Router();

/**
 * Feature flag guard: don't allow calling any of the endpoints if extensions are disabled
 * @type {import('express').RequestHandler}
 */
export const extensionsEnabledFeatureGuard = (_, response, next) => {
    const enabled = !!getConfigValue('extensions.enabled', true, 'boolean');
    if (!enabled) {
        response.sendStatus(404);
        return;
    }
    next();
};

router.use(extensionsEnabledFeatureGuard);

/**
 * What extension management can do on this server. The page reads it once and offers only what can work.
 * @param {Object} _request - HTTP Request object.
 * @param {Object} response - HTTP Response object.
 */
router.get('/capabilities', (_request, response) => {
    const capabilities = getExtensionCapabilities();
    log.debug(LogClass.NORMAL, 'Extension capabilities reported:', `update=${capabilities.update}`, `globalInstall=${capabilities.globalInstall}`, `bundled=${capabilities.bundled.length}`);
    return response.send(capabilities);
});

/**
 * HTTP POST handler function to clone a git repository from a provided URL, read the extension manifest,
 * and return extension information and path.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with a 'url' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/install', async (request, response) => {
    try {
        const { url, global, branch } = request.body;

        if (global && !request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Refused: a non-admin user tried to install a global extension.');
            log.error(LogClass.SENSITIVE, `User ${request.user.profile.handle} does not have permission to install global extensions.`);
            return response.status(403).send('Forbidden: No permission to install global extensions.');
        }

        if (global && !isGlobalExtensionFolderWritable()) {
            log.warn(LogClass.NORMAL, 'Extension install for all users refused: the global extension folder is read-only');
            return response.status(409).send(GLOBAL_INSTALL_UNAVAILABLE_MESSAGE);
        }

        if (!isValidUrl(url)) {
            return response.status(400).send('Bad Request: A valid URL is required in the request body.');
        }

        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return response.status(400).send('Bad Request: Only HTTP and HTTPS protocols are supported for the Extension URL.');
        }

        const git = createGitClient({ backend: gitBackend });

        // make sure the third-party directory exists
        if (!storage.exists(path.join(request.user.directories.extensions))) {
            storage.mkdir(path.join(request.user.directories.extensions));
        }

        if (!storage.exists(PUBLIC_DIRECTORIES.globalExtensions)) {
            storage.mkdir(PUBLIC_DIRECTORIES.globalExtensions);
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionNameSanitized = sanitize(path.basename(parsedUrl.pathname, '.git'));
        if (!extensionNameSanitized) {
            return response.status(400).send('Could not determine the extension name from the URL. Please provide a valid git repository URL.');
        }

        const extensionPath = path.join(basePath, extensionNameSanitized);
        const folderName = path.basename(extensionPath);

        if (storage.exists(extensionPath)) {
            return response.status(409).send(`Directory already exists at ${extensionPath}`);
        }

        const cloneOptions = { depth: 1 };
        if (branch) {
            cloneOptions.branch = branch;
        }
        try {
            await git.clone(parsedUrl.href, extensionPath, cloneOptions);
        } catch (cloneError) {
            // The clone can fail for reasons the user can act on (a wrong address or branch, no route to the site), and
            // the generic 500 below says nothing about any of them. Remove a half-written folder, say what to check.
            log.error(LogClass.NORMAL, `Installing extension failed: the download failed (backend ${git.backend})`);
            log.error(LogClass.SENSITIVE, 'Cloning extension failed', cloneError);
            try {
                await storage.rm(extensionPath, { recursive: true, force: true });
            } catch (removeError) {
                log.warn(LogClass.NORMAL, 'Installing extension failed, and the half-written folder could not be removed');
                log.warn(LogClass.SENSITIVE, 'Removing the half-written extension folder failed', removeError);
            }
            return response.status(502).send('The extension could not be downloaded from that address. Check the address and the branch or tag name, and that this machine can reach the site.');
        }
        log.info(LogClass.SENSITIVE, `Extension has been cloned to ${extensionPath} from ${parsedUrl.href} at ${branch || '(default)'} branch`);

        try {
            const manifest = await getManifest(extensionPath);
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                throw new Error('Manifest is not a valid JSON object.');
            }
            const { version, author, display_name } = manifest;
            return response.send({ version, author, display_name, extensionPath, folderName });
        } catch (manifestError) {
            await storage.rm(extensionPath, { recursive: true, force: true });
            throw manifestError;
        }
    } catch (error) {
        log.error(LogClass.NORMAL, 'Installing extension failed');
        log.error(LogClass.SENSITIVE, 'Importing extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * HTTP POST handler function to pull the latest updates from a git repository
 * based on the extension name provided in the request body. It returns the latest commit hash,
 * the path of the extension, the status of the repository (whether it's up-to-date or not),
 * and the remote URL of the repository.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with an 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/update', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        if (global && !request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Refused: a non-admin user tried to update a global extension.');
            log.error(LogClass.SENSITIVE, `User ${request.user.profile.handle} does not have permission to update global extensions.`);
            return response.status(403).send('Forbidden: No permission to update global extensions.');
        }

        if (refuseIfUnavailable(response, { operation: 'update', needsGit: true, global: !!global, extension: extensionNameSanitized })) {
            return;
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!storage.exists(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        const { isUpToDate, remoteUrl } = await checkIfRepoIsUpToDate(extensionPath);
        const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
        const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
        if (!isRepo) {
            throw new Error(`Directory is not a Git repository at ${extensionPath}`);
        }
        const currentBranch = await git.branch();
        if (!isUpToDate) {
            await git.pull('origin', currentBranch.current);
            log.info(LogClass.SENSITIVE, `Extension has been updated at ${extensionPath}`);
        } else {
            log.info(LogClass.SENSITIVE, `Extension is up to date at ${extensionPath}`);
        }
        await git.fetch('origin');
        const fullCommitHash = await git.revparse(['HEAD']);
        const shortCommitHash = fullCommitHash.slice(0, 7);

        return response.send({ shortCommitHash, extensionPath, isUpToDate, remoteUrl });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Updating extension failed');
        log.error(LogClass.SENSITIVE, 'Extension update error:', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/branches', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        if (global && !request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Refused: a non-admin user tried to list branches of a global extension.');
            log.error(LogClass.SENSITIVE, `User ${request.user.profile.handle} does not have permission to list branches of global extensions.`);
            return response.status(403).send('Forbidden: No permission to list branches of global extensions.');
        }

        if (refuseIfUnavailable(response, { operation: 'branches', needsGit: true, global: !!global, extension: extensionNameSanitized })) {
            return;
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!storage.exists(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
        // Unshallow the repository if it is shallow
        const isShallow = await git.revparse(['--is-shallow-repository']) === 'true';
        if (isShallow) {
            log.info(LogClass.SENSITIVE, `Unshallowing the repository at ${extensionPath}`);
            await git.fetch('origin', ['--unshallow']);
        }

        // Fetch all branches
        await git.remote(['set-branches', 'origin', '*']);
        await git.fetch('origin');
        const localBranches = await git.branchLocal();
        const remoteBranches = await git.branch(['-r', '--list', 'origin/*']);
        const result = [
            ...Object.values(localBranches.branches),
            ...Object.values(remoteBranches.branches),
        ].map(b => ({ current: b.current, commit: b.commit, name: b.name, label: b.label }));

        return response.send(result);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Listing extension branches failed');
        log.error(LogClass.SENSITIVE, 'Getting branches failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/switch', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, branch, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized || !branch) {
            return response.status(400).send('Bad Request: A valid extensionName and branch are required in the request body.');
        }

        if (global && !request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Refused: a non-admin user tried to switch branches of a global extension.');
            log.error(LogClass.SENSITIVE, `User ${request.user.profile.handle} does not have permission to switch branches of global extensions.`);
            return response.status(403).send('Forbidden: No permission to switch branches of global extensions.');
        }

        if (refuseIfUnavailable(response, { operation: 'switch', needsGit: true, global: !!global, extension: extensionNameSanitized })) {
            return;
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!storage.exists(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
        const branches = await git.branchLocal();

        if (String(branch).startsWith('origin/')) {
            const localBranch = branch.replace('origin/', '');
            if (branches.all.includes(localBranch)) {
                log.info(LogClass.SENSITIVE, `Branch ${localBranch} already exists locally, checking it out`);
                await git.checkout(localBranch);
                return response.sendStatus(204);
            }

            log.info(LogClass.SENSITIVE, `Branch ${localBranch} does not exist locally, creating it from ${branch}`);
            await git.checkoutBranch(localBranch, branch);
            return response.sendStatus(204);
        }

        if (!branches.all.includes(branch)) {
            log.error(LogClass.NORMAL, 'The requested branch does not exist locally for the extension');
            log.error(LogClass.SENSITIVE, `Branch ${branch} does not exist locally for extension '${extensionNameSanitized}'`);
            return response.status(404).send(`Branch ${branch} does not exist locally`);
        }

        // Check if the branch is already checked out
        const currentBranch = await git.branch();
        if (currentBranch.current === branch) {
            log.info(LogClass.SENSITIVE, `Branch ${branch} is already checked out`);
            return response.sendStatus(204);
        }

        // Checkout the branch
        await git.checkout(branch);
        log.info(LogClass.SENSITIVE, `Checked out branch ${branch} at ${extensionPath}`);

        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Switching extension branches failed');
        log.error(LogClass.SENSITIVE, 'Switching branches failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

router.post('/move', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, source, destination } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized || !source || !destination) {
            return response.status(400).send('Bad Request: A valid extensionName, source, and destination are required in the request body.');
        }

        if (!request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Refused: a non-admin user tried to move an extension.');
            log.error(LogClass.SENSITIVE, `User ${request.user.profile.handle} does not have permission to move extensions.`);
            return response.status(403).send('Forbidden: No permission to move extensions.');
        }

        const sourceDirectory = source === 'global' ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const destinationDirectory = destination === 'global' ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const sourcePath = path.join(sourceDirectory, extensionNameSanitized);
        const destinationPath = path.join(destinationDirectory, extensionNameSanitized);

        if (!storage.exists(sourcePath) || !storage.stat(sourcePath).isDirectory()) {
            log.error(LogClass.NORMAL, 'Extension move failed: the source directory does not exist');
            log.error(LogClass.SENSITIVE, `Source directory does not exist at ${sourcePath}`);
            return response.status(404).send('Source directory does not exist.');
        }

        // Before anything is copied. A bundled extension (source: global, in the read-only image) used to be copied
        // into the user's folder and then fail to remove the original, which left a per-user copy that shadows the
        // image's copy after every later update of Taproom.
        if (source === 'global' || destination === 'global') {
            if (!isGlobalExtensionFolderWritable()) {
                log.warn(LogClass.NORMAL, `Extension move refused: the global extension folder is read-only (${source} to ${destination})`);
                log.warn(LogClass.SENSITIVE, `Extension move refused for '${extensionNameSanitized}': the global folder is read-only`);
                return response.status(409).send(source === 'global' ? BUNDLED_EXTENSION_MESSAGE : GLOBAL_INSTALL_UNAVAILABLE_MESSAGE);
            }
        }

        if (storage.exists(destinationPath)) {
            log.error(LogClass.NORMAL, 'Extension move failed: the destination directory already exists');
            log.error(LogClass.SENSITIVE, `Destination directory already exists at ${destinationPath}`);
            return response.status(409).send('Destination directory already exists.');
        }

        if (source === destination) {
            log.error(LogClass.NORMAL, 'Source and destination directories are the same');
            return response.status(409).send('Source and destination directories are the same.');
        }

        storage.cp(sourcePath, destinationPath, { recursive: true, force: true });
        storage.rm(sourcePath, { recursive: true, force: true });
        log.info(LogClass.SENSITIVE, `Extension has been moved from ${sourcePath} to ${destinationPath}`);

        return response.sendStatus(204);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Moving extension failed');
        log.error(LogClass.SENSITIVE, 'Moving extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * HTTP POST handler function to get the current git commit hash and branch name for a given extension.
 * It checks whether the repository is up-to-date with the remote, and returns the status along with
 * the remote URL of the repository.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with an 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/version', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!storage.exists(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        // No git, or a bundled extension: there is nothing to compare, and that is not an error. Answer the same
        // "not a repository" shape this route already uses, plus the reason, and write one log line per process rather
        // than one error per extension per check. (The page reads /capabilities and does not ask at all; this covers
        // an older page or another client. A failed check used to be swallowed by the catch below, so "Notify on
        // extension updates" silently never notified.)
        if (!isGitAvailable() || (global && !isGlobalExtensionFolderWritable())) {
            const reason = !isGitAvailable() ? UPDATE_UNAVAILABLE_MESSAGE : BUNDLED_EXTENSION_MESSAGE;
            logNoticeOnce(!isGitAvailable() ? 'no-git' : 'bundled-version', !isGitAvailable()
                ? 'Extension updates are unavailable on this server: there is no git binary. Update, branch and version requests are refused with a plain message.'
                : 'Version checks skip the bundled extensions: they are updated with Taproom.');
            return response.send({ currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '', updatesUnavailable: true, reason });
        }

        const git = simpleGit({ baseDir: extensionPath, ...OPTIONS });
        let currentCommitHash;
        try {
            const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
            if (!isRepo) {
                throw new Error(`Directory is not a Git repository at ${extensionPath}`);
            }
            currentCommitHash = await git.revparse(['HEAD']);
        } catch (error) {
            // it is not a git repo, or has no commits yet, or is a bare repo
            // not possible to update it, most likely can't get the branch name either
            return response.send({ currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' });
        }

        const currentBranch = await git.branch();
        // get only the working branch
        const currentBranchName = currentBranch.current;
        await git.fetch('origin');
        log.debug(LogClass.SENSITIVE, extensionNameSanitized, currentBranchName, currentCommitHash);
        const { isUpToDate, remoteUrl } = await checkIfRepoIsUpToDate(extensionPath);

        return response.send({ currentBranchName, currentCommitHash, isUpToDate, remoteUrl });
    } catch (error) {
        log.error(LogClass.NORMAL, 'Getting extension version failed');
        log.error(LogClass.SENSITIVE, 'Getting extension version failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * HTTP POST handler function to delete a git repository based on the extension name provided in the request body.
 *
 * @param {Object} request - HTTP Request object, expects a JSON body with a 'extensionName' property.
 * @param {Object} response - HTTP Response object used to respond to the HTTP request.
 *
 * @returns {void}
 */
router.post('/delete', async (request, response) => {
    try {
        if (typeof request.body.extensionName !== 'string') {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        const { extensionName, global } = request.body;
        const extensionNameSanitized = sanitize(extensionName);
        if (!extensionNameSanitized) {
            return response.status(400).send('Bad Request: A valid extensionName is required in the request body.');
        }

        if (global && !request.user.profile.admin) {
            log.error(LogClass.NORMAL, 'Refused: a non-admin user tried to delete a global extension.');
            log.error(LogClass.SENSITIVE, `User ${request.user.profile.handle} does not have permission to delete global extensions.`);
            return response.status(403).send('Forbidden: No permission to delete global extensions.');
        }

        if (refuseIfUnavailable(response, { operation: 'delete', needsGit: false, global: !!global, extension: extensionNameSanitized })) {
            return;
        }

        const basePath = global ? PUBLIC_DIRECTORIES.globalExtensions : request.user.directories.extensions;
        const extensionPath = path.join(basePath, extensionNameSanitized);

        if (!storage.exists(extensionPath)) {
            return response.status(404).send(`Directory does not exist at ${extensionPath}`);
        }

        await storage.rm(extensionPath, { recursive: true });
        log.info(LogClass.SENSITIVE, `Extension has been deleted at ${extensionPath}`);

        return response.send(`Extension has been deleted at ${extensionPath}`);
    } catch (error) {
        log.error(LogClass.NORMAL, 'Deleting extension failed');
        log.error(LogClass.SENSITIVE, 'Deleting extension failed', error);
        return response.status(500).send('Internal Server Error. Check the server logs for more details.');
    }
});

/**
 * Discover the extension folders
 * If the folder is called third-party, search for subfolders instead
 */
router.get('/discover', function (request, response) {
    if (!storage.exists(path.join(request.user.directories.extensions))) {
        storage.mkdir(path.join(request.user.directories.extensions));
    }

    if (!storage.exists(PUBLIC_DIRECTORIES.globalExtensions)) {
        storage.mkdir(PUBLIC_DIRECTORIES.globalExtensions);
    }

    // Get all folders in system extensions folder, excluding third-party
    const builtInExtensions = storage
        .readdir(PUBLIC_DIRECTORIES.extensions)
        .filter(f => storage.stat(path.join(PUBLIC_DIRECTORIES.extensions, f)).isDirectory())
        .filter(f => f !== 'third-party')
        .map(f => ({ type: 'system', name: f }));

    // Get all folders in local extensions folder
    const userExtensions = storage
        .readdir(path.join(request.user.directories.extensions))
        .filter(f => storage.stat(path.join(request.user.directories.extensions, f)).isDirectory())
        .map(f => ({ type: 'local', name: `third-party/${f}` }));

    // Get all folders in global extensions folder
    // In case of a conflict, the extension will be loaded from the user folder
    const globalExtensions = storage
        .readdir(PUBLIC_DIRECTORIES.globalExtensions)
        .filter(f => storage.stat(path.join(PUBLIC_DIRECTORIES.globalExtensions, f)).isDirectory())
        .map(f => ({ type: 'global', name: `third-party/${f}` }))
        .filter(f => !userExtensions.some(e => e.name === f.name));

    // Combine all extensions
    const allExtensions = [...builtInExtensions, ...userExtensions, ...globalExtensions];
    log.debug(LogClass.SENSITIVE, 'Extensions available for', request.user.profile.handle, allExtensions);

    return response.send(allExtensions);
});
