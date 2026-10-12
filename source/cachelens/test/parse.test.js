import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 🔴 THE SUITE CANNOT IMPORT `panel.js` OR `index.js`, SO NOTHING WAS CHECKING THEY PARSE. Both statically
 * import SillyTavern's `script.js`, which does not exist outside a browser — that is why the decisions worth
 * testing live in `bar.js`, `prefix.js`, `attribution.js` and `record.js`. The gap is that a SYNTAX error in
 * either of the two unimportable modules leaves the whole suite green while the extension will not load at
 * all, and two such commits were pushed to `main` exactly that way: an apostrophe inside a single-quoted
 * string, and 84 passing tests.
 *
 * `node --check` needs no imports resolved, so it reaches the files nothing else can.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The parser's own complaint, dug out of whatever `execFileSync` threw.
 *
 * ⚠️ A CATCH BINDING IS `unknown`, AND THAT IS THE TRUTH RATHER THAN A NUISANCE. The syntax error arrives on
 * the child's `stderr`, but nothing promises the throw carries one — or is even an Error. Narrowing keeps
 * the parser's message where it exists and still prints something where it does not, which is exactly the
 * case a guard reporting a failure cannot afford to go quiet on.
 * @param {unknown} error Whatever was thrown
 * @returns {string} What to print beside the failing file
 */
function complaintOf(error) {
    if (error instanceof Error) {
        return 'stderr' in error && error.stderr ? String(error.stderr) : error.message;
    }

    return String(error);
}

test('every module in the extension parses', () => {
    const files = readdirSync(ROOT).filter(name => name.endsWith('.js'));

    // A guard that silently checks nothing is worse than no guard: it reports success for having looked at
    // an empty list.
    assert.ok(files.length >= 5, `expected the extension's modules, found ${files.join(', ') || 'none'}`);

    for (const file of files) {
        try {
            execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' });
        } catch (error) {
            assert.fail(`${file} does not parse:\n${complaintOf(error)}`);
        }
    }
});
