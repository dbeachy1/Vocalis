import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';
import { bootSillyTavern, makeScratchDirectory } from './util/st-server.js';

// `users.js` pulls in a chain that reads the config at module scope and `process.exit(1)`s without one, so
// it cannot be imported statically — a static import is hoisted above `beforeAll` and the module would exit
// while Jest was still collecting this file. Same reason as users-accounts-directory-guard.test.js.
/** @type {typeof import('../src/users.js')} */
let users;

/**
 * 🔴 THE LEGACY GLOBAL user.css MUST LEAVE THE WEB ROOT AT BOOT, UNCONDITIONALLY.
 *
 * `express.static(public)` is mounted above the auth boundary, so `public/css/user.css` — user-authored
 * content — is served to any unauthenticated client for as long as it exists. Handing each account its
 * own copy is per-user maintenance and can wait for ever: the per-user migration removes the original
 * only once EVERY account has taken a copy, and an account whose owner never logs in again keeps that
 * condition false permanently. Getting the file OUT OF THE WEB ROOT is the one step that needs no user
 * and no key, so `relocateLegacyUserCss` does it at boot, every boot, before the server listens.
 *
 * What is pinned here, in order of how much it matters:
 *
 *   1. The move itself — content arrives at the parking spot, and the web-root copy is GONE.
 *   2. 🔴 The web-root copy is removed EVEN WHEN the parked copy already exists. A crash between copy
 *      and unlink would otherwise leave the original in the web root for ever: every later boot would
 *      see the parked copy and walk away. This is the case that distinguishes this function from the
 *      skip-if-migrated error-page entries above it in migratePublicOverrides — and the parked copy
 *      WINS on conflict, because a divergent web-root stylesheet is the exposure all over again.
 *   3. A clean install stays clean — no file, no move, and no `_css` directory conjured out of nothing
 *      (storage-provider-boot-gate.test.js asserts `_css` is empty on a fresh install; this function
 *      must not be the thing that trips it).
 *   4. A failure is swallowed, like every other entry in the boot migration map: a stylesheet that
 *      cannot be moved must not stop the boot.
 */
describe('🎨 the legacy user.css leaves the web root at boot', () => {
    /** @type {string} */
    let root;
    /** @type {string} */
    let publicCss;
    /** @type {string} */
    let parkedCss;

    beforeAll(async () => {
        const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
        setConfigFilePath(path.join(serverDirectory, 'default', 'config.yaml'));
        users = await import('../src/users.js');
    });

    beforeEach(() => {
        root = makeScratchDirectory('legacy-css');
        publicCss = path.join(root, 'public', 'css', 'user.css');
        parkedCss = path.join(root, 'data', '_css', 'user.css');
        fs.mkdirSync(path.dirname(publicCss), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('moves the web-root stylesheet to the parking spot', () => {
        fs.writeFileSync(publicCss, 'body { color: rebeccapurple; }');

        users.relocateLegacyUserCss(publicCss, parkedCss);

        expect(fs.existsSync(publicCss)).toBe(false);
        expect(fs.readFileSync(parkedCss, 'utf-8')).toBe('body { color: rebeccapurple; }');
    });

    test('🔴 removes the web-root copy even when the parked copy already exists — and the parked copy wins', () => {
        // The state a crash between copy and unlink leaves behind. If this boot skips because the
        // destination exists — the semantics of the error-page entries — the web-root copy survives
        // every boot from now on, served to strangers. The divergent contents prove which copy wins.
        fs.writeFileSync(publicCss, '/* the copy still inside the web root */');
        fs.mkdirSync(path.dirname(parkedCss), { recursive: true });
        fs.writeFileSync(parkedCss, '/* the copy already parked */');

        users.relocateLegacyUserCss(publicCss, parkedCss);

        expect(fs.existsSync(publicCss)).toBe(false);
        expect(fs.readFileSync(parkedCss, 'utf-8')).toBe('/* the copy already parked */');
    });

    test('a clean install stays clean — no parked directory appears', () => {
        users.relocateLegacyUserCss(publicCss, parkedCss);

        expect(fs.existsSync(publicCss)).toBe(false);
        expect(fs.existsSync(path.dirname(parkedCss))).toBe(false);
    });

    test('a failure is swallowed, and the boot goes on', () => {
        // The parking spot's parent "directory" is a FILE, so mkdir refuses and the move cannot
        // happen. The function must neither throw nor delete the original: a stylesheet it could not
        // park is a stylesheet it must not destroy.
        fs.writeFileSync(publicCss, 'body { color: teal; }');
        fs.mkdirSync(path.join(root, 'data'), { recursive: true });
        fs.writeFileSync(path.join(root, 'data', '_css'), 'not a directory');

        expect(() => users.relocateLegacyUserCss(publicCss, parkedCss)).not.toThrow();
        expect(fs.readFileSync(publicCss, 'utf-8')).toBe('body { color: teal; }');
    });

    test('a DIRECTORY squatting on the parking spot does not get the original deleted', () => {
        // "Parked copy wins" is a policy about a copy. exists() is type-blind, so without the isFile
        // guard this state — operator-manufactured, but permanent once made — would skip the copy and
        // then delete the web-root original: the only real copy, destroyed in favour of a directory.
        fs.writeFileSync(publicCss, 'body { color: crimson; }');
        fs.mkdirSync(parkedCss, { recursive: true });

        expect(() => users.relocateLegacyUserCss(publicCss, parkedCss)).not.toThrow();
        expect(fs.readFileSync(publicCss, 'utf-8')).toBe('body { color: crimson; }');
    });

    test('🔗 the production call site exists and points at the web root and the parking spot', () => {
        // Every other test here calls the export directly, so none of them would notice the one
        // regression that undoes the whole fix: migratePublicOverrides losing the call — an upstream
        // merge resolving that function in upstream's favour is exactly how it would happen — or the
        // two arguments swapping. A boot-level pin cannot be written safely (the production paths are
        // the repository's own web root, shared by every parallel suite), so the call site is pinned
        // in source.
        const source = fs.readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'users.js'), 'utf-8');
        const body = source.split('export async function migratePublicOverrides')[1]?.split('\nexport ')[0] ?? '';

        expect(body).toContain('relocateLegacyUserCss(');
        expect(body).toMatch(/relocateLegacyUserCss\(\s*path\.join\(serverDirectory, 'public', 'css', 'user\.css'\),\s*path\.join\(globalThis\.DATA_ROOT, '_css', 'user\.css'\),?\s*\)/);
    });
});

/**
 * 🔴 THE SEEDED PLACEHOLDER MUST NOT COUNT AS "HAVING YOUR OWN user.css".
 *
 * checkForNewContent runs before migrateUserCss in the same maintenance pass, and the content index
 * ships a user.css stub — so on the first pass after an upgrade, every user "has" a user.css before the
 * migration ever looks. Counting the stub meant two things, both wrong: the legacy stylesheet was never
 * copied to anyone, and the everyone-has-their-own check was satisfied by stubs — so the parked file,
 * by then the ONLY copy of the user's custom styles, was deleted. This boots the real server against a
 * data root with a parked legacy stylesheet and asserts the whole chain: the content must land in the
 * user's directory (over the seeded stub), and only then may the parked copy go.
 */
describe('🎨 the parked stylesheet reaches the user, not the void', () => {
    const LEGACY_CSS = 'body { --marker: legacy-custom-styles-survive; }';

    /** @type {string} */
    let scratch;
    /** @type {string} */
    let dataRoot;

    beforeAll(async () => {
        scratch = makeScratchDirectory('css-migration-boot');
        dataRoot = path.join(scratch, 'data');
        const configPath = path.join(scratch, 'config.yaml');
        const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

        // The state relocateLegacyUserCss leaves behind: a parked legacy stylesheet, no per-user copies.
        fs.mkdirSync(path.join(dataRoot, '_css'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, '_css', 'user.css'), LEGACY_CSS);
        fs.copyFileSync(path.join(serverDirectory, 'default', 'config.yaml'), configPath);

        // Two boots: the first creates default-user and seeds content; the second runs the maintenance
        // pass with the account fully established. The bug reproduces on whichever pass seeds the stub.
        await bootSillyTavern({ dataRoot, configPath });
        await bootSillyTavern({ dataRoot, configPath });
    }, 300_000);

    test('🔴 the user received the LEGACY styles, not the seeded stub', () => {
        const userCss = path.join(dataRoot, 'default-user', 'user.css');

        expect(fs.existsSync(userCss)).toBe(true);
        expect(fs.readFileSync(userCss, 'utf-8')).toBe(LEGACY_CSS);
    });

    test('and only then was the parked copy removed', () => {
        // Meaningful only because the test above proves the content ARRIVED — removal alone is also
        // what the bug did.
        expect(fs.existsSync(path.join(dataRoot, '_css', 'user.css'))).toBe(false);
    });
});
