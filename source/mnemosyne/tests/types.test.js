import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect } from '@jest/globals';

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 🔴 THE GATE THAT MAKES THE ANNOTATIONS MEAN ANYTHING. WITHOUT IT, 0.2.0 BUILT NOTHING.
 *
 * Nothing in this project is compiled. `src/index.js` is loaded by the fork's plugin loader straight off disk,
 * and Node runs exactly the bytes in the repository — so a wrong `@param` costs nothing at load time, breaks
 * no build, and is invisible for ever. That is not a hypothetical: this tree carried four hundred JSDoc tags
 * before `tsc` was ever pointed at it, and among them were an `@param {…} context` naming a parameter that did
 * not exist, two `import('./generation-interceptors.js')` references to a module that lives in a DIFFERENT
 * REPOSITORY, an `import('./store.js')` from a directory containing no `store.js`, and a `@param` order no
 * caller could satisfy. Nobody wrote any of those on purpose. Comments simply are not checked, so they drift,
 * and a drifted comment is worse than no comment because it is believed.
 *
 * So the annotations are only worth what this test is worth. `npm run types` exists for a human iterating;
 * **this** is what stops a false one reaching `main`, because it runs in the same `npm test` that gates a
 * deploy. Delete it and the JSDoc reverts to decoration within a month.
 *
 * ⚠️ **IT IS SLOW, AND THAT IS THE PRICE OF IT BEING TRUE.** Two `tsc` invocations, several seconds each.
 * There is no cheaper honest version — a checker that reads only the files a change touched cannot see the
 * call site in another module that the change just falsified, which is the entire class of error this catches.
 *
 * 🔴 **AND IT IS THREE CONFIGS, NOT ONE, DELIBERATELY — each one buying a guarantee the others cannot.**
 *
 *   - `tsconfig.json` covers `src/` with **NO `lib: DOM`**, because Mnemosyne is a server plugin:
 *     `panel-view.js` builds markup as strings and has never had a `document`. With DOM in scope,
 *     `document.createElement(…)` inside a renderer would type-check cleanly and fail at runtime, on a user's
 *     install, in a process holding a decrypted store.
 *   - `tsconfig.tools.json` covers `tools/` and **needs `DOM`**, because the callbacks handed to Playwright's
 *     `page.evaluate()` execute inside the browser page.
 *   - `tsconfig.tests.json` covers `tests/` and **needs Jest's globals**, which `src/` must never see —
 *     `describe`, `test` and `expect` have no business resolving inside a plugin loaded into somebody else's
 *     server.
 *
 * No single `lib` and no single `types` array is right for all three, so merging any two to save a few seconds
 * here trades a real guarantee for a shorter command.
 *
 * ⚠️ **THE THIRD ONE WAS ADDED LAST, AND THAT ORDER IS THE POINT.** `tests/` measured 1,636 errors under
 * these flags — and it measured MORE after `src/` reached zero than before, because a mock compared against
 * `any` yesterday is compared against a real shape today. **A test suite cannot be checked before the code it
 * tests is.** Wiring this third case in before `tests/` was green would have put `main` in a state that fails
 * its own gate, which is the one thing a gate must never teach anyone to tolerate.
 */

/**
 * Run one config and hand back whatever `tsc` said.
 *
 * `node node_modules/typescript/bin/tsc` rather than `node_modules/.bin/tsc`: the `.bin` entry is a shell
 * shim on POSIX and a `.cmd` on Windows, and this suite runs on both. Going straight at the JS entry point
 * needs no shell at all.
 *
 * ⚠️ `tsc` exits non-zero when it finds errors, which `execFileSync` raises — so the throw is the ORDINARY
 * path here, not the exceptional one, and the diagnostics are on stdout rather than stderr. Letting the
 * exception escape would report "command failed" and throw away the one thing worth reading.
 *
 * @param {string} config A tsconfig path, relative to the repository root
 * @returns {string} `tsc`'s diagnostics verbatim, or `''` when it found nothing to say
 */
function typeCheck(config) {
    try {
        execFileSync(
            process.execPath,
            [path.join('node_modules', 'typescript', 'bin', 'tsc'), '-p', config, '--pretty', 'false'],
            { cwd: repositoryRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
        );

        return '';
    } catch (error) {
        // 🔴 `catch` binds `unknown` — see `Thrown` in `src/logging.js` for why that is a fact about JavaScript
        // rather than a strictness setting. The two extra members are what `execFileSync` decorates its Error
        // with, and they are `string` because `encoding: 'utf-8'` is passed above; they are OPTIONAL because a
        // spawn that never ran the child at all (a missing `node`, a bad cwd) throws a plain ENOENT Error
        // carrying neither. `?.` is kept on every read below for the same reason it is load-bearing there:
        // `throw null` is legal, and this catch is standing under somebody else's `throw`.
        const thrown = /** @type {(import('../src/logging.js').Thrown & { stdout?: string, stderr?: string })|null|undefined} */ (error);
        const output = `${thrown?.stdout ?? ''}${thrown?.stderr ?? ''}`.trim();

        // A `tsc` that could not run at all — a missing install, a malformed config — produces no diagnostic
        // lines, and reporting that as "0 type errors" would be the exact silent pass this file exists to
        // prevent. Say what happened instead.
        return output || `tsc could not be run for ${config}: ${thrown?.message ?? 'no output'}`;
    }
}

describe('🔴 every JSDoc annotation is a CHECKED statement, not prose', () => {
    test('src/ type-checks under strict, with no DOM in scope', () => {
        // The whole diagnostic block is the failure message. A count would tell a reader that something is
        // wrong and not one thing about what.
        expect(typeCheck('tsconfig.json')).toBe('');
    }, 180_000);

    test('tools/ type-checks under strict, with the browser-side callbacks in scope', () => {
        expect(typeCheck('tsconfig.tools.json')).toBe('');
    }, 180_000);

    test('tests/ type-checks under strict, so the fixtures cannot drift from what they stand in for', () => {
        // 🔴 A FIXTURE IS AN ASSERTION ABOUT A SHAPE, and until this ran nothing checked it. The mocks in
        // this directory stand in for the fork and for the store, and a mock that has drifted is a test
        // asserting against a system that no longer exists — green, confident, and measuring nothing. That is
        // not hypothetical: turning this on found `embed` returning `Float32Array[]` where the fork returns
        // `number[][]`, half-built contexts missing required members, and four `src/` annotations narrower
        // than the code they described.
        expect(typeCheck('tsconfig.tests.json')).toBe('');
    }, 180_000);
});
