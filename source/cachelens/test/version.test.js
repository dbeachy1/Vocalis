import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { VERSION } from '../version.js';

/**
 * `version.js` holds a literal so a stale tab reports the version of its loaded modules. This test checks that
 * literal against the manifest and package metadata used by SillyTavern's extension list.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read one of the repo's own JSON files.
 *
 * ⚠️ DECLARED WITH `version` OPTIONAL ON PURPOSE. A manifest that has lost the field entirely is the
 * failure these tests exist to catch, and typing it as always-present would move that from a red test to a
 * red compile — the assertion below is what should report it.
 * @param {string} name A JSON file at the repo root
 * @returns {{version?: string}} Its contents, narrowed to the one field these tests read
 */
function readJson(name) {
    return JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
}

test('the version in the code is the version in the manifest', () => {
    assert.equal(VERSION, readJson('manifest.json').version);
});

test('the version in the code is the version in package.json', () => {
    assert.equal(VERSION, readJson('package.json').version);
});

test('the version is a real version and not a placeholder', () => {
    // A guard that accepts '' or 'dev' passes while the header prints something meaningless.
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
});
