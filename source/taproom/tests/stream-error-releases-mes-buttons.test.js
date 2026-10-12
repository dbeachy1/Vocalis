import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeEach } from '@jest/globals';

const require = createRequire(import.meta.url);
// eslint's own parser, already present as a dependency of the declared `eslint` devDependency.
const espree = require('espree');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'public', 'script.js');
const source = fs.readFileSync(scriptPath, 'utf8');

/**
 * 🔴 THE LAST MESSAGE LOST ITS ENTIRE BUTTON ROW UNTIL THE CHARACTER SPOKE AGAIN.
 *
 * The row includes SillyTavern and extension controls, and `style.css` hides it while the body carries
 * `data-generating`:
 *
 *     body:is([data-generating="true"], ...) :is(..., #chat .last_mes .mes_buttons, ...) { display: none }
 *
 * That rule is right. What was wrong is that the flag outlived the generation.
 *
 * ## The loop, which is four steps long and only the first one is rare
 *
 *   1. Any streaming error, once. `onErrorStreaming()` set `isStopped` and — unlike its sibling
 *      `onStopStreaming()` 27 lines below — never set `isFinished`. The generator's `catch` returns
 *      before the `this.isFinished = true` at the end, so the flag stayed false forever.
 *   2. `isStreamFinished` is therefore false, `finishGenerating()` falls out returning `undefined`,
 *      and `onSuccess()` bails on `if (!data) return` — so its `streamingProcessor = null` never
 *      ran. A dead processor is now pinned as the module's live one.
 *   3. Any later QUIET generation — auto-summary, title generation, an extension's background call,
 *      i.e. exactly what fires when a chat loads — sets `data-generating` on its way in.
 *   4. On its way out, `unblockGeneration('quiet')` sees `streamingProcessor && !isFinished`,
 *      early-returns, and never reaches `activateSendButtons()` — where the `delete` lives.
 *
 * The next non-quiet reply built a fresh processor and cleared the flag, masking the stale processor until
 * another reply was sent.
 *
 * ## Why `isFinished`, and not a bigger repair
 *
 * The same `!isFinished` corpse was silently switching off two other subsystems that guard on it:
 * character expressions (`extensions/expressions/index.js`) and the auto-summary
 * (`extensions/memory/index.js`) both refuse to run while a processor claims to be mid-stream. One
 * assignment restores all three, and the negative control below pins that it did not simply disarm
 * the guard: a genuinely live stream must still block a quiet unblock.
 *
 * ## What this test runs
 *
 * The REAL shipped source of those five functions, lifted out of `public/script.js` by its AST and
 * called against stubs. `public/script.js` cannot be imported here — it is a browser module with
 * thousands of lines of DOM setup at import time — but its function bodies are ordinary code, and
 * running them is worth more than asserting that a line of text is present. If an upstream merge
 * reverts the assignment, this fails on behaviour rather than on a grep.
 */

const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });

/**
 * Body text of a top-level function declaration, `export`ed or not.
 * @param {string} name Function name
 * @returns {string} Source of the body, braces stripped
 */
function topLevelFunctionBody(name) {
    for (const node of ast.body) {
        const fn = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
        if (fn?.type === 'FunctionDeclaration' && fn.id?.name === name) {
            return source.slice(fn.body.range[0] + 1, fn.body.range[1] - 1);
        }
    }
    throw new Error(`no top-level function ${name}() in public/script.js`);
}

/**
 * Body text of a method on a top-level class.
 * @param {string} className Class name
 * @param {string} methodName Method name
 * @returns {string} Source of the body, braces stripped
 */
function classMethodBody(className, methodName) {
    for (const node of ast.body) {
        const cls = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
        if (cls?.type !== 'ClassDeclaration' || cls.id?.name !== className) continue;
        for (const member of cls.body.body) {
            if (member.type === 'MethodDefinition' && member.key?.name === methodName) {
                return source.slice(member.value.body.range[0] + 1, member.value.body.range[1] - 1);
            }
        }
    }
    throw new Error(`no ${className}#${methodName}() in public/script.js`);
}

/**
 * Turn a lifted body into something callable, with its free identifiers supplied as parameters.
 * @param {string} body Source of the body
 * @param {string[]} params Names the body reads from module scope
 * @returns {Function} The callable
 */
const lift = (body, params) => new Function(...params, body);

/** The single fake `<body>` these functions manipulate. @type {{dataset: object}} */
let fakeBody;
/** Recorded calls, so a silent early return is distinguishable from a completed unblock. @type {any[]} */
let calls;

beforeEach(() => {
    fakeBody = { dataset: {} };
    calls = [];
});

/**
 * `document` as these functions use it: one body, one dataset.
 * @returns {object} The stub
 */
const fakeDocument = () => ({ body: fakeBody });

/**
 * Runs the real `deactivateSendButtons()` — what every generation does on the way in.
 * @returns {void}
 */
function deactivateSendButtons() {
    lift(topLevelFunctionBody('deactivateSendButtons'), ['showStopButton', 'hideSwipeButtons', 'document'])(
        () => calls.push('showStopButton'),
        () => calls.push('hideSwipeButtons'),
        fakeDocument(),
    );
}

/**
 * Runs the real `activateSendButtons()` — the only deleter of `data-generating` in the codebase.
 * @returns {void}
 */
function activateSendButtons() {
    calls.push('activateSendButtons');
    lift(topLevelFunctionBody('activateSendButtons'), ['is_send_press', 'hideStopButton', 'showSwipeButtons', 'document'])(
        true,
        () => calls.push('hideStopButton'),
        () => calls.push('showSwipeButtons'),
        fakeDocument(),
    );
}

/**
 * Runs the real `unblockGeneration()` against a given processor.
 * @param {string|undefined} type Generation type
 * @param {object|null} streamingProcessor The module's current processor
 * @returns {void}
 */
function unblockGeneration(type, streamingProcessor) {
    lift(topLevelFunctionBody('unblockGeneration'), ['type', 'streamingProcessor', 'is_send_press', 'activateSendButtons', 'setGenerationProgress', 'flushEphemeralStoppingStrings', 'flushWIInjections'])(
        type,
        streamingProcessor,
        true,
        activateSendButtons,
        () => calls.push('setGenerationProgress'),
        () => calls.push('flushEphemeralStoppingStrings'),
        () => calls.push('flushWIInjections'),
    );
}

/**
 * A processor in the state `Generate()` hands it over in: neither stopped nor finished.
 * @returns {object} The processor
 */
const liveProcessor = () => ({
    isStopped: false,
    isFinished: false,
    type: 'normal',
    abortController: { abort: () => calls.push('abort') },
    markUIGenStopped: () => calls.push('markUIGenStopped'),
});

/**
 * Runs the real `StreamingProcessor#onErrorStreaming()` on a processor.
 * @param {object} processor The processor
 * @returns {object} The same processor, after the error path
 */
function onErrorStreaming(processor) {
    lift(classMethodBody('StreamingProcessor', 'onErrorStreaming'), ['eventSource', 'event_types']).call(
        processor,
        { emit: (...args) => calls.push(['emit', ...args]) },
        { MESSAGE_RECEIVED: 'message_received', CHARACTER_MESSAGE_RENDERED: 'character_message_rendered' },
    );
    return processor;
}

/**
 * Runs the real `StreamingProcessor#onStopStreaming()` on a processor.
 * @param {object} processor The processor
 * @returns {object} The same processor, after the stop path
 */
function onStopStreaming(processor) {
    lift(classMethodBody('StreamingProcessor', 'onStopStreaming'), []).call(processor);
    return processor;
}

describe('🔴 A streaming error must not leave the last message without its buttons', () => {
    describe('the defect: an errored stream reported itself unfinished forever', () => {
        test('onErrorStreaming() marks the stream finished, as onStopStreaming() always did', () => {
            expect(onErrorStreaming(liveProcessor()).isFinished).toBe(true);
            expect(onStopStreaming(liveProcessor()).isFinished).toBe(true);
        });

        test('it still marks the stream stopped, so isStreamFinished stays false', () => {
            // `finishGenerating()` gates the tool-call and onFinishStreaming blocks on
            // `!isStopped && isFinished`. Setting isFinished must not resurrect either of them.
            const processor = onErrorStreaming(liveProcessor());
            expect(processor.isStopped).toBe(true);
            expect(!processor.isStopped && processor.isFinished).toBe(false);
        });

        test('it still tears the request down and tells the UI generation stopped', () => {
            onErrorStreaming(liveProcessor());
            expect(calls).toContain('abort');
            expect(calls).toContain('markUIGenStopped');
        });
    });

    describe('the symptom: a quiet generation after an error', () => {
        test('clears data-generating, so .last_mes .mes_buttons is not hidden', () => {
            const corpse = onErrorStreaming(liveProcessor());

            // A summary / title / extension call, of the kind that fires when a chat loads.
            deactivateSendButtons();
            expect(fakeBody.dataset.generating).toBe('true');

            unblockGeneration('quiet', corpse);

            expect(calls).toContain('activateSendButtons');
            expect(fakeBody.dataset.generating).toBeUndefined();
        });

        test('the pre-fix processor reproduces it: activateSendButtons() is never reached', () => {
            // The exact state the old onErrorStreaming() left behind: stopped, but not finished.
            const preFix = { ...liveProcessor(), isStopped: true, isFinished: false };

            deactivateSendButtons();
            unblockGeneration('quiet', preFix);

            expect(calls).not.toContain('activateSendButtons');
            expect(fakeBody.dataset.generating).toBe('true');
        });
    });

    describe('the guard still guards', () => {
        test('a genuinely live stream still blocks a parallel quiet unblock', () => {
            deactivateSendButtons();
            unblockGeneration('quiet', liveProcessor());

            expect(calls).not.toContain('activateSendButtons');
            expect(fakeBody.dataset.generating).toBe('true');
        });

        test('a non-quiet unblock is never gated on the processor at all', () => {
            deactivateSendButtons();
            unblockGeneration('normal', liveProcessor());

            expect(calls).toContain('activateSendButtons');
            expect(fakeBody.dataset.generating).toBeUndefined();
        });

        test('an unblock with no processor at all clears the flag', () => {
            deactivateSendButtons();
            unblockGeneration('quiet', null);

            expect(fakeBody.dataset.generating).toBeUndefined();
        });
    });

    describe('the leak itself', () => {
        test('the streaming branch drops the processor when the stream did not finish', () => {
            // `onSuccess()` bails on `if (!data) return` before its own `streamingProcessor = null`,
            // so the error path has to release the corpse itself or it stays pinned — which makes
            // the stop button report that it stopped a stream that ended minutes ago.
            const branch = source.slice(source.indexOf('if (isStreamFinished) {'), source.indexOf('return await sendGenerationRequest('));
            const afterFinishedBlock = branch.slice(branch.indexOf('fromStream'));
            expect(afterFinishedBlock).toContain('streamingProcessor = null;');
        });
    });
});
