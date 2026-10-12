import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect } from '@jest/globals';

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * ⛔ EXACTLY TWO RUNTIME DEPENDENCIES, PINNED EXACTLY. THIS TEST IS WHY IT STAYS THAT WAY.
 *
 * SillyTavern-Vault — the sibling project, the one that owns the DEK this plugin's key derives from — ships
 * ZERO runtime dependencies, and has a test just like this one asserting it. That is the standard, and
 * Mnemosyne CANNOT meet it. sqlite-vec and SQLCipher are native code. There is no encrypted vector index
 * without them, and no amount of cleverness here changes that.
 *
 * So the two are an ACCEPTED RISK, decided deliberately and on the record: a user who installs a poisoned
 * sqlite has a poisoned sqlite, and nothing in this package saves them from it. That is a documented gap,
 * conceded the same way the Vault README concedes the same-host attacker. This test does not re-litigate it.
 *
 * What it defends is the boundary drawn around that concession, and there are two halves:
 *
 *   1. THE SET IS CLOSED. Two packages, by name. The argument "we accepted native deps already, so what's
 *      one more" is exactly the argument this test exists to refuse. Every package here runs in the same
 *      process as a DEK-derived key, after unlock, with the plaintext in reach. It does not have to break a
 *      cipher or exfiltrate a file — it can simply read the key. A third one gets argued for out loud.
 *
 *   2. THE VERSIONS DO NOT FLOAT. This is the half that is still entirely ours, and it is the whole reason
 *      the pins are exact. "sqlite-vec is malicious today" is the user's risk and we took it knowingly.
 *      "sqlite-vec silently became malicious overnight, because we wrote ^0.1.9 and npm did as it was told"
 *      would be OUR doing. A caret is a standing instruction to install code nobody has read into the
 *      process holding the key, forever, unattended. We are not issuing that instruction.
 *
 * package-lock.json is the other half of (2), and it is committed. When it changes, read it like code.
 */

/** The complete set. Adding to this list is a security decision, not a packaging one. */
const ALLOWED_RUNTIME_DEPENDENCIES = [
    'better-sqlite3-multiple-ciphers',
    'sqlite-vec',
];

/** @type {any} */
const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf-8'));

describe('⛔ the runtime dependency set is closed', () => {
    test('⛔ package.json declares EXACTLY the two accepted native dependencies', () => {
        const dependencies = Object.keys(manifest.dependencies ?? {}).sort();

        // Native runtime dependencies execute in-process and expand the update and trust surface. SQLCipher
        // and sqlite-vec are the two required native dependencies; additions need an explicit design decision.
        expect(dependencies).toEqual([...ALLOWED_RUNTIME_DEPENDENCIES].sort());
    });

    test('⛔ and no optional or peer dependencies either — the same process is the same process', () => {
        // An optionalDependency is not optional to an attacker. If it installs, it runs.
        expect(Object.keys(manifest.optionalDependencies ?? {})).toEqual([]);
        expect(Object.keys(manifest.peerDependencies ?? {})).toEqual([]);
    });
});

describe('⛔ the runtime dependency versions do not float', () => {
    // Anything that is not a bare, complete semver literal. Ranges, wildcards, tags, git URLs, tarball URLs,
    // and file paths are all ways of saying "install whatever is there at the time", which is the one thing
    // we will not say.
    const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

    for (const name of ALLOWED_RUNTIME_DEPENDENCIES) {
        test(`⛔ ${name} is pinned to an exact version, not a range`, () => {
            const specifier = (manifest.dependencies ?? {})[name];

            expect(specifier).toBeDefined();

            // Catches ^1.2.3, ~1.2.3, >=1.2.3, 1.x, *, latest, git+https://…, file:…, and 1.2.3 || 1.2.4.
            expect(specifier).toMatch(EXACT_SEMVER);
        });
    }

    test('⛔ package-lock.json is committed — the pins only bind the top level, the lockfile binds the tree', () => {
        // Exact pins in package.json say nothing about what better-sqlite3-multiple-ciphers itself depends on.
        // The lockfile is the only artifact that pins transitively, and a lockfile that is not committed is
        // a lockfile that does not exist.
        const lockfilePath = path.join(repositoryRoot, 'package-lock.json');

        expect(fs.existsSync(lockfilePath)).toBe(true);

        const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf-8'));

        expect(lockfile.lockfileVersion).toBeGreaterThanOrEqual(2);
    });

    test('⛔ the lockfile resolves the two to exactly what package.json pins — no drift between them', () => {
        const lockfile = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf-8'));

        for (const name of ALLOWED_RUNTIME_DEPENDENCIES) {
            const resolved = lockfile.packages?.[`node_modules/${name}`];

            expect(resolved).toBeDefined();
            expect(resolved.version).toBe(manifest.dependencies[name]);
        }
    });

    /**
     * ⛔ A VERSION IS NOT A PACKAGE. The test above proves the lockfile AGREES with package.json about a
     * version string — and a version string is not what npm installs. `resolved` is the URL it fetches and
     * `integrity` is the hash it checks, so a lockfile edited to keep `"version": "0.1.9"` while pointing
     * `resolved` at some other host installs someone else's tarball into the process holding a DEK-derived
     * key, and every assertion above still passes.
     *
     * That is the same failure this file already refuses in its other half — "install whatever is there at the
     * time" — arriving through the field nobody was reading. The lockfile is committed and read like code
     * precisely so this is checkable; this makes the check automatic.
     */
    test('⛔ every runtime package resolves to the public registry, over HTTPS', () => {
        const lockfile = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf-8'));

        // The two pins plus their platform-specific siblings — sqlite-vec ships one prebuilt per platform, and
        // an attacker only needs the one that matches the target.
        const runtime = Object.entries(lockfile.packages ?? {})
            .filter(([spec, meta]) => spec.startsWith('node_modules/') && !meta.dev && meta.resolved);

        expect(runtime.length).toBeGreaterThan(0);

        for (const [spec, meta] of runtime) {
            expect(`${spec} -> ${meta.resolved}`).toMatch(/-> https:\/\/registry\.npmjs\.org\//);
            // An integrity hash is what makes the URL's answer verifiable. Without one, a compromised mirror
            // or a MITM on the fetch is undetectable.
            expect(`${spec} integrity=${meta.integrity ?? 'MISSING'}`).toMatch(/integrity=sha(256|512)-/);
        }
    });

    test('⛔ nothing rewrites the tree behind the lockfile — no overrides, resolutions, or install scripts we own', () => {
        // `overrides` is a second way to swap a transitive package, and it lives in package.json rather than
        // the lockfile, so the pins above say nothing about it.
        expect(manifest.overrides).toBeUndefined();
        expect(manifest.resolutions).toBeUndefined();

        // A postinstall in THIS package would run on every install, in the same process tree as the key. The
        // two native dependencies have their own, which is the accepted risk; adding one here is not.
        for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
            expect(manifest.scripts?.[hook]).toBeUndefined();
        }
    });
});

describe('the platform floor', () => {
    test('it requires Node 24, the same floor as the vault it derives its key from', () => {
        // Not for argon2 — that is Vault's problem, and Vault's reason. Mnemosyne's reason is simpler: it
        // loads into the same process as Vault, so it does not get to want an older Node than Vault does.
        expect(manifest.engines.node).toMatch(/>=\s*24/);
    });
});
