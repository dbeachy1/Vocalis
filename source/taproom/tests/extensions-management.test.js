import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';

import { setConfigFilePath } from '../src/util.js';
import { PUBLIC_DIRECTORIES } from '../src/constants.js';
import { makeScratchDirectory } from './util/st-server.js';

/**
 * EXTENSION MANAGEMENT THAT CANNOT WORK MUST SAY SO, ONCE, IN A SENTENCE (Taproom, October 11, 2026, pre-release audit).
 *
 * The Taproom image has no git and its bundled extensions sit in a read-only folder that is also the fork's "global"
 * extension folder. Update, branch listing, branch switching, install-for-all-users, and deleting or moving a bundled
 * extension used to fail with a generic 500 (or, for delete, with nothing the page checked); `/version` swallowed its
 * error so update notifications silently never came. These tests drive the real `extensions.js` router against real
 * folders, in the two situations that matter: this package (no git, global folder not writable) and a fork run from a
 * writable checkout (the old behavior must be unchanged).
 *
 * "No git" is made real by replacing `command-exists`, the one place the fork asks whether a git binary exists (the
 * update routes through `isGitAvailable`, and the clone backend choice in `git/client.js`). Jest's `process.env` is
 * a copy that child processes never see, so changing PATH would not reach `command-exists`. "Read-only global folder"
 * is made real by making `fs.accessSync(<global folder>, W_OK)` fail for that one folder, because Windows cannot make a
 * directory unwritable by mode bits and this suite has to run there too.
 */

/** Whether the replaced `command-exists` says a git binary exists. */
const machine = { hasGit: false };
const commandExistsSync = jest.fn(() => machine.hasGit);
jest.unstable_mockModule('command-exists', () => ({ sync: commandExistsSync, default: { sync: commandExistsSync } }));

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

/** @type {typeof import('../src/endpoints/extensions.js')} */
let extensions;
/** @type {typeof import('../src/git/client.js')} */
let gitClient;
/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let base;
/** @type {string} */
let root;
/** @type {string} */
let globalFolder;
/** @type {string} */
let userFolder;

const originalGlobalFolder = PUBLIC_DIRECTORIES.globalExtensions;
const realAccessSync = fs.accessSync;
let globalFolderReadOnly = false;

/**
 * Lay down one extension folder with a manifest.
 * @param {string} parent Folder to put it in
 * @param {string} name Folder name
 * @returns {void}
 */
function makeExtension(parent, name) {
    fs.mkdirSync(path.join(parent, name), { recursive: true });
    fs.writeFileSync(path.join(parent, name, 'manifest.json'), JSON.stringify({ display_name: name, version: '1.0.0' }));
}

/**
 * POST JSON.
 * @param {string} route Route under /extensions
 * @param {object} body Body
 * @returns {Promise<{status: number, text: string, body: any}>} The response
 */
async function post(route, body) {
    const response = await fetch(`${base}/extensions${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }
    return { status: response.status, text, body: parsed };
}

beforeAll(async () => {
    setConfigFilePath(path.join(path.dirname(testDirectory), 'default', 'config.yaml'));
    extensions = await import('../src/endpoints/extensions.js');
    gitClient = await import('../src/git/client.js');

    root = makeScratchDirectory('extensions-management');
    userFolder = path.join(root, 'user-extensions');
    globalFolder = path.join(root, 'public', 'scripts', 'extensions', 'third-party');

    // Make the global folder "read-only" on demand, for that folder only.
    fs.accessSync = (target, mode) => {
        if (globalFolderReadOnly && typeof target === 'string' && path.resolve(target) === path.resolve(globalFolder) && (mode ?? 0) & fs.constants.W_OK) {
            throw Object.assign(new Error('EACCES: permission denied (simulated read-only image folder)'), { code: 'EACCES' });
        }
        return realAccessSync(target, mode);
    };

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        request.user = {
            profile: { handle: 'owner', admin: true },
            directories: { extensions: userFolder },
        };
        next();
    });
    app.use('/extensions', extensions.router);
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

afterAll(async () => {
    fs.accessSync = realAccessSync;
    PUBLIC_DIRECTORIES.globalExtensions = originalGlobalFolder;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
    fs.rmSync(userFolder, { recursive: true, force: true });
    fs.rmSync(globalFolder, { recursive: true, force: true });
    fs.mkdirSync(userFolder, { recursive: true });
    fs.mkdirSync(globalFolder, { recursive: true });
    makeExtension(globalFolder, 'Vocalis');
    makeExtension(globalFolder, 'taproom-cache-lens');
    makeExtension(userFolder, 'Mine');
    PUBLIC_DIRECTORIES.globalExtensions = globalFolder;
});

afterEach(() => {
    machine.hasGit = false;
    globalFolderReadOnly = false;
});

describe('this package: no git, a read-only global folder', () => {
    beforeEach(() => {
        machine.hasGit = false;
        globalFolderReadOnly = true;
    });

    test('GET /capabilities is the one place the page learns all of it', async () => {
        const response = await fetch(`${base}/extensions/capabilities`);
        const capabilities = await response.json();

        expect(response.status).toBe(200);
        expect(capabilities.update).toBe(false);
        expect(capabilities.updateMessage).toBe(extensions.UPDATE_UNAVAILABLE_MESSAGE);
        expect(capabilities.updateMessage).toMatch(/no git/);
        expect(capabilities.globalInstall).toBe(false);
        expect(capabilities.globalInstallMessage).toBe(extensions.GLOBAL_INSTALL_UNAVAILABLE_MESSAGE);
        expect(capabilities.bundled.sort()).toEqual(['Vocalis', 'taproom-cache-lens']);
        expect(capabilities.bundledMessage).toBe(extensions.BUNDLED_EXTENSION_MESSAGE);
    });

    test.each([
        ['update', { extensionName: 'Mine' }],
        ['update', { extensionName: 'Vocalis', global: true }],
        ['branches', { extensionName: 'Mine' }],
        ['switch', { extensionName: 'Mine', branch: 'main' }],
    ])('POST /%s answers 501 with the one plain sentence instead of a generic 500', async (route, body) => {
        const { status, text } = await post(`/${route}`, body);

        expect(status).toBe(501);
        expect(text).toBe(extensions.UPDATE_UNAVAILABLE_MESSAGE);
    });

    test('POST /version answers "nothing to compare" with the reason, not an error', async () => {
        const { status, body } = await post('/version', { extensionName: 'Mine' });

        expect(status).toBe(200);
        expect(body).toMatchObject({ currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '', updatesUnavailable: true });
        expect(body.reason).toBe(extensions.UPDATE_UNAVAILABLE_MESSAGE);
    });

    test('install for all users is refused with a plain sentence and creates nothing', async () => {
        const { status, text } = await post('/install', { url: 'https://example.invalid/author/NewOne', global: true });

        expect(status).toBe(409);
        expect(text).toBe(extensions.GLOBAL_INSTALL_UNAVAILABLE_MESSAGE);
        expect(fs.existsSync(path.join(globalFolder, 'NewOne'))).toBe(false);
    });

    test('install just for me does not need git: with none the clone backend is the built-in one', () => {
        expect(gitClient.createGitClient({ backend: 'auto' }).backend).toBe('builtin');
    });

    test('a failed download answers one plain sentence and leaves no folder behind', async () => {
        const { status, text } = await post('/install', { url: 'http://127.0.0.1:9/author/Unreachable.git' });

        expect(status).toBe(502);
        expect(text).toMatch(/could not be downloaded from that address/);
        expect(fs.existsSync(path.join(userFolder, 'Unreachable'))).toBe(false);
    });

    test('deleting a bundled extension is refused and the folder is untouched', async () => {
        const { status, text } = await post('/delete', { extensionName: 'Vocalis', global: true });

        expect(status).toBe(409);
        expect(text).toBe(extensions.BUNDLED_EXTENSION_MESSAGE);
        expect(fs.existsSync(path.join(globalFolder, 'Vocalis', 'manifest.json'))).toBe(true);
    });

    test('deleting an extension installed just for me still works', async () => {
        const { status } = await post('/delete', { extensionName: 'Mine', global: false });

        expect(status).toBe(200);
        expect(fs.existsSync(path.join(userFolder, 'Mine'))).toBe(false);
    });

    test('moving a bundled extension is refused BEFORE anything is copied into the user folder', async () => {
        const { status, text } = await post('/move', { extensionName: 'Vocalis', source: 'global', destination: 'local' });

        expect(status).toBe(409);
        expect(text).toBe(extensions.BUNDLED_EXTENSION_MESSAGE);
        expect(fs.existsSync(path.join(userFolder, 'Vocalis'))).toBe(false);
        expect(fs.existsSync(path.join(globalFolder, 'Vocalis', 'manifest.json'))).toBe(true);
    });

    test('moving a personal extension to "all users" is refused and nothing is copied', async () => {
        const { status, text } = await post('/move', { extensionName: 'Mine', source: 'local', destination: 'global' });

        expect(status).toBe(409);
        expect(text).toBe(extensions.GLOBAL_INSTALL_UNAVAILABLE_MESSAGE);
        expect(fs.existsSync(path.join(globalFolder, 'Mine'))).toBe(false);
        expect(fs.existsSync(path.join(userFolder, 'Mine', 'manifest.json'))).toBe(true);
    });
});

describe('this package, if a git binary were present: a bundled extension still cannot be updated', () => {
    beforeEach(() => {
        machine.hasGit = true;
        globalFolderReadOnly = true;
    });

    test.each([
        ['update', { extensionName: 'Vocalis', global: true }],
        ['branches', { extensionName: 'Vocalis', global: true }],
        ['switch', { extensionName: 'Vocalis', global: true, branch: 'main' }],
    ])('POST /%s of a bundled extension answers the "comes with Taproom" sentence', async (route, body) => {
        const { status, text } = await post(`/${route}`, body);

        expect(status).toBe(409);
        expect(text).toBe(extensions.BUNDLED_EXTENSION_MESSAGE);
    });

    test('version of a bundled extension is "nothing to compare", not an error', async () => {
        const { status, body } = await post('/version', { extensionName: 'Vocalis', global: true });

        expect(status).toBe(200);
        expect(body).toMatchObject({ isUpToDate: true, currentCommitHash: '', updatesUnavailable: true });
        expect(body.reason).toBe(extensions.BUNDLED_EXTENSION_MESSAGE);
    });

    test('capabilities say updating works but the bundled extensions are listed', async () => {
        const capabilities = await (await fetch(`${base}/extensions/capabilities`)).json();

        expect(capabilities.update).toBe(true);
        expect(capabilities.bundled.sort()).toEqual(['Vocalis', 'taproom-cache-lens']);
    });
});

describe('a fork run from a writable checkout keeps its old behavior', () => {
    test('capabilities offer everything that has what it needs, and nothing is bundled', async () => {
        machine.hasGit = true;
        const capabilities = await (await fetch(`${base}/extensions/capabilities`)).json();

        expect(capabilities).toEqual({
            update: true,
            updateMessage: '',
            globalInstall: true,
            globalInstallMessage: '',
            bundled: [],
            bundledMessage: '',
        });
    });

    test('a global extension can be moved to the user folder and deleted', async () => {
        const moved = await post('/move', { extensionName: 'Vocalis', source: 'global', destination: 'local' });
        expect(moved.status).toBe(204);
        expect(fs.existsSync(path.join(userFolder, 'Vocalis', 'manifest.json'))).toBe(true);
        expect(fs.existsSync(path.join(globalFolder, 'Vocalis'))).toBe(false);

        const deleted = await post('/delete', { extensionName: 'taproom-cache-lens', global: true });
        expect(deleted.status).toBe(200);
        expect(fs.existsSync(path.join(globalFolder, 'taproom-cache-lens'))).toBe(false);
    });
});
