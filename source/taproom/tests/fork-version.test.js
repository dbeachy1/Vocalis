import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORK_TAG, FORK_VERSION, composeForkVersion } from '../src/fork-version.js';
import { getVersion } from '../src/util.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 0.3 shipped to test-host announcing itself as `1.18.0+taproom.0.2`, because the number lived in package.json
 * where bumping it was nobody's step. These tests exist so the next stale version is a red suite and not a
 * thing Test User notices in the banner.
 */
describe('the fork version has exactly one source', () => {
    test('the version served to the client is the constant, not a copy of it', async () => {
        const version = await getVersion();

        expect(version.forkVersion).toBe(FORK_VERSION);
        expect(version.forkTag).toBe(FORK_TAG);
        expect(version.fullVersion).toBe(`${version.pkgVersion}+${FORK_TAG}.${FORK_VERSION}`);
    });

    test('composing is the same operation everywhere, so the banner cannot drift from the constant', () => {
        expect(composeForkVersion('1.18.0')).toBe(`1.18.0+${FORK_TAG}.${FORK_VERSION}`);
        expect(composeForkVersion('99.0.0')).toBe(`99.0.0+${FORK_TAG}.${FORK_VERSION}`);
    });

    test('the number has not crept back into package.json, where it went stale before', () => {
        const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

        // Not "they match" -- they must not BOTH exist. A second copy that happens to agree today is the
        // exact state 0.2/0.3 was in, and it agrees right up until someone bumps one of them.
        expect(pkgJson.forkVersion).toBeUndefined();
        expect(pkgJson.forkTag).toBeUndefined();
    });

    test('the upstream base is still upstream\'s to bump, and we did not fork it', () => {
        const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

        // `version` stays the raw upstream semver: the Horde User-Agent and the settings version-change
        // check both read it bare, and a merge from upstream must be able to move it without touching us.
        expect(pkgJson.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(pkgJson.version).not.toContain(FORK_TAG);
    });

    test('the fork half survives a package.json that cannot be read', async () => {
        // pkgVersion falls back to 'UNKNOWN' when the read throws. Before the move the fork half went null
        // with it and the whole suffix vanished; a constant cannot fail that way, and that is the point.
        expect(composeForkVersion('UNKNOWN')).toBe(`UNKNOWN+${FORK_TAG}.${FORK_VERSION}`);
    });
});
