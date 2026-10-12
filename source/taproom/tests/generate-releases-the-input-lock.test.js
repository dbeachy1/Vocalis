import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, test, expect } from '@jest/globals';

const require = createRequire(import.meta.url);
const espree = require('espree');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });

/**
 * 🔴 A GENERATION THAT THROWS MUST GIVE THE SEND BUTTON BACK.
 *
 * `Generate()` takes the input lock on its way in — `deactivateSendButtons()`, which hides
 * `#send_but`, `#mes_continue` and `#mes_impersonate` — and then runs about a thousand lines of
 * prompt assembly, world info, token counting and event emits before it reaches
 * `finishGenerating().then(onSuccess, onError)`, where the only other cleanup lives.
 *
 * That whole span had no `try`. A throw in it stranded the lock, and nothing else clears it: the
 * send controls stayed hidden until the user contrived to start another generation somehow. It is
 * the same failure shape as the one that took the message buttons away
 * (`message-actions-flag-has-one-writer`), one layer up — a lock with no owner and no exit.
 *
 * The repair is a wrapper rather than a `try` around the body, because wrapping the body means
 * re-indenting the whole function: a thousand-line diff against upstream for a six-line fix, on a
 * fork that has to keep merging from upstream. So the body became `generateInternal()`, private,
 * and the exported `Generate()` is the guard.
 *
 * These tests run the REAL wrapper — lifted out of `public/script.js` by its AST — against stubs.
 */

/** The named function's node, wherever it is declared. @type {(name: string) => object} */
function functionNamed(name) {
    let found = null;
    (function walk(node) {
        if (found || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id?.name === name) {
            found = node;
            return;
        }
        for (const key of Object.keys(node)) if (node[key] && typeof node[key] === 'object') walk(node[key]);
    })(ast);
    if (!found) throw new Error(`no function ${name}() in public/script.js`);
    return found;
}

/** Body source of a named function, braces stripped. @type {(name: string) => string} */
const bodyOf = (name) => {
    const fn = functionNamed(name);
    return source.slice(fn.body.range[0] + 1, fn.body.range[1] - 1);
};

const AsyncFunction = Object.getPrototypeOf(async function () { /* shape only */ }).constructor;

/**
 * The real `Generate()` wrapper, lifted and made callable as
 * `(type, options, dryRun, generateInternal, unblockGeneration)` — its two free identifiers are
 * supplied as trailing parameters so each test can hand it a different body and recorder.
 * @returns {Function} The wrapper
 */
const realGenerate = () => new AsyncFunction(
    'type', 'options', 'dryRun', 'generateInternal', 'unblockGeneration', bodyOf('Generate'),
);

/** @returns {{calls: any[], unblock: Function}} A recorder for unblockGeneration */
function recorder() {
    const calls = [];
    return { calls, unblock: (type) => calls.push(type) };
}

describe('🔴 Generate() releases the input lock even when it throws', () => {
    describe('the wrapper behaves', () => {
        test('a throw in the body unblocks, with the generation type', async () => {
            const { calls, unblock } = recorder();
            const boom = new Error('prompt assembly blew up');

            await expect(
                realGenerate()('normal', {}, false, async () => { throw boom; }, unblock),
            ).rejects.toBe(boom);
            expect(calls).toEqual(['normal']);
        });

        test('the error is re-thrown, not swallowed — callers still see the failure', async () => {
            const { unblock } = recorder();
            const boom = new Error('nope');

            await expect(
                realGenerate()('quiet', {}, false, async () => { throw boom; }, unblock),
            ).rejects.toThrow('nope');
        });

        test('a normal return passes straight through and unblocks nothing extra', async () => {
            const { calls, unblock } = recorder();
            const result = await realGenerate()(
                'normal', { quiet_prompt: 'x' }, false, async () => 'the reply', unblock,
            );

            expect(result).toBe('the reply');
            expect(calls).toEqual([]);
        });

        test('type, options and dryRun all reach the body unchanged', async () => {
            const seen = [];
            const options = { quiet_prompt: 'hello', depth: 2 };
            await realGenerate()(
                'swipe', options, true, async (...args) => { seen.push(args); return null; }, () => { },
            );

            expect(seen).toEqual([['swipe', options, true]]);
        });
    });

    describe('the shape that makes the guard unavoidable', () => {
        test('Generate is exported and generateInternal is not', () => {
            expect(source).toContain('export async function Generate(');
            expect(source).toContain('async function generateInternal(');
            expect(source).not.toContain('export async function generateInternal(');
        });

        test('the only caller of generateInternal is the wrapper', () => {
            const callers = [];
            (function walk(node) {
                if (!node || typeof node !== 'object') return;
                if (Array.isArray(node)) return node.forEach(walk);
                if (node.type === 'CallExpression' && node.callee?.name === 'generateInternal') {
                    callers.push(node.loc.start.line);
                }
                for (const key of Object.keys(node)) if (node[key] && typeof node[key] === 'object') walk(node[key]);
            })(ast);

            expect(callers).toHaveLength(1);
            const wrapper = functionNamed('Generate');
            expect(callers[0]).toBeGreaterThan(wrapper.loc.start.line);
            expect(callers[0]).toBeLessThan(wrapper.loc.end.line);
        });

        test('the body still takes the lock — otherwise there is nothing to release', () => {
            const internal = functionNamed('generateInternal');
            const body = source.slice(internal.range[0], internal.range[1]);

            expect(body).toContain('deactivateSendButtons();');
        });
    });

    describe('releasing twice is free, which is what makes the wrapper safe', () => {
        test('hideStopButton() only acts, and only emits, when the button is actually shown', () => {
            // unblockGeneration -> activateSendButtons -> hideStopButton. On a path that already
            // unblocked, this second pass must not re-emit GENERATION_ENDED at extensions.
            const body = source.slice(source.indexOf('function hideStopButton()'), source.indexOf('class StreamingProcessor'));

            expect(body).toMatch(/!== 'none'/);
            expect(body).toContain('GENERATION_ENDED');
        });
    });
});
