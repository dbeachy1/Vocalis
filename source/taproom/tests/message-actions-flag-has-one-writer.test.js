import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, test, expect } from '@jest/globals';

const require = createRequire(import.meta.url);
const espree = require('espree');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'public', 'script.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });

/**
 * 🔴 THE FLAG THAT HIDES A MESSAGE'S BUTTONS MUST HAVE EXACTLY ONE WRITER.
 *
 * The companion spec `tests/frontend/message-actions-survive-the-input-lock.e2e.js` proves the CSS
 * half: an extension holding the input lock no longer hides the last message's actions. This proves
 * the half a stylesheet cannot — that the new flag stays narrow.
 *
 * `data-generating` went wrong precisely because it had SEVEN writers inside `script.js` and an open
 * door for more: `deactivateSendButtons()` is exported and sits on the public context, so any
 * extension may hold the lock, and `SillyTavern-MessageSummarize` does whenever its `block_chat`
 * setting is on. One unbalanced holder and the row was gone until the next message rendered, because
 * nothing un-hides it — `.last_mes` just moves off the message you were looking at.
 *
 * So `data-generating-message` is only worth having while these three properties hold:
 *
 *   ONE WRITER   — set in exactly one place, `markUIGenStarted()`. If a second appears, this fails,
 *                  and a second writer must be justified rather than added silently.
 *   NOT EARLY    — and never in the generation body. Before the first token there is no new message,
 *                  so a flag set at generation start hides a FINISHED message's buttons.
 *   OPEN EXIT    — cleared by `activateSendButtons()`, which every unblock path reaches, so anything
 *                  able to release the input lock also releases the row. Locking is narrow;
 *                  unlocking is deliberately wide.
 */

/** Every place in script.js that writes `document.body.dataset.<name>`. @type {(name: string) => object[]} */
function writesOf(name) {
    const found = [];
    (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        const isDatasetMember = n => n?.type === 'MemberExpression'
            && n.property?.name === name
            && n.object?.type === 'MemberExpression'
            && n.object.property?.name === 'dataset';
        if (node.type === 'AssignmentExpression' && isDatasetMember(node.left)) {
            found.push({ kind: 'set', line: node.loc.start.line });
        }
        if (node.type === 'UnaryExpression' && node.operator === 'delete' && isDatasetMember(node.argument)) {
            found.push({ kind: 'delete', line: node.loc.start.line });
        }
        for (const key of Object.keys(node)) if (node[key] && typeof node[key] === 'object') walk(node[key]);
    })(ast);
    return found;
}

/**
 * The named function's node, wherever it is declared.
 *
 * ⚠️ A CLASS METHOD IS NOT A NAMED FUNCTION. `markUIGenStarted` is a `MethodDefinition` whose value is
 * an ANONYMOUS FunctionExpression — matching on `node.id.name` alone finds nothing and this throws,
 * which is how it failed the moment the flag moved onto `StreamingProcessor`. The MethodDefinition is
 * returned rather than its value, so `range`/`loc` span the whole method including its name.
 * @param {string} name Function or method name
 * @returns {object} The AST node
 */
function functionNamed(name) {
    let found = null;
    (function walk(node) {
        if (found || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id?.name === name) {
            found = node;
            return;
        }
        if (node.type === 'MethodDefinition' && node.key?.name === name) {
            found = node;
            return;
        }
        for (const key of Object.keys(node)) if (node[key] && typeof node[key] === 'object') walk(node[key]);
    })(ast);
    if (!found) throw new Error(`no function or method ${name}() in public/script.js`);
    return found;
}

/** Body source of a named function, braces stripped. @type {(name: string) => string} */
const bodyOf = (name) => {
    const node = functionNamed(name);
    const body = node.type === 'MethodDefinition' ? node.value.body : node.body;
    return source.slice(body.range[0] + 1, body.range[1] - 1);
};

/** Run a lifted body with its free identifiers supplied. @type {(body: string, params: string[]) => Function} */
const lift = (body, params) => new Function(...params, body);

/** Calls to the input lock inside script.js — only the ones we can count; the export is open. */
const inputLockHolders = source.match(/deactivateSendButtons\(\)/g) || [];

describe('🔴 data-generating-message: one writer, never quiet, wide exit', () => {
    describe('ONE WRITER', () => {
        test('exactly one place sets it, and it is markUIGenStarted()', () => {
            const sets = writesOf('generatingMessage').filter(w => w.kind === 'set');
            expect(sets).toHaveLength(1);

            const marker = functionNamed('markUIGenStarted');
            expect(sets[0].line).toBeGreaterThan(marker.loc.start.line);
            expect(sets[0].line).toBeLessThan(marker.loc.end.line);
        });

        test('for contrast, the input lock it replaced has many holders and an open door', () => {
            // Not a requirement — a record of WHY the new flag is kept narrow. deactivateSendButtons
            // is exported, so the writers inside this file are only the ones we can count.
            expect(inputLockHolders.length).toBeGreaterThan(1);
            expect(source).toContain('export function deactivateSendButtons');
        });
    });

    describe('🔴 NOT BEFORE THE MESSAGE EXISTS', () => {
        /*
         * The timing is separate from flag ownership: the previous message remains the last message until
         * the first token arrives.
         *
         * Between "generation started" and "first token arrived" there is NO new message: `.last_mes`
         * is still the previous, FINISHED one. A flag set at the top of a generation therefore
         * stripped the buttons off a completed message for the whole latency of the request, and they
         * came back only because the first token appended a new row and `.last_mes` moved off it.
         *
         * `markUIGenStarted()` is called by `onStartStreaming` AFTER `saveReply` and
         * `#checkDomElements`, so the message the rule is about genuinely exists by then. These two
         * assertions are what stop the write drifting back up to the start of a generation.
         */
        test('the generation body does not set it — nothing hides before a row exists', () => {
            const [set] = writesOf('generatingMessage').filter(w => w.kind === 'set');
            const body = functionNamed('generateInternal');
            const insideGenerate = set.line > body.loc.start.line && set.line < body.loc.end.line;

            expect(insideGenerate).toBe(false);
        });

        test('it sits with the deactivate that announces a reply is being written', () => {
            const marker = functionNamed('markUIGenStarted');
            const body = source.slice(marker.range[0], marker.range[1]);

            expect(body).toContain('deactivateSendButtons();');
            expect(source).toContain('this.markUIGenStarted();');
        });
    });

    describe('OPEN EXIT', () => {
        test('activateSendButtons() clears both the input lock and the message flag', () => {
            const body = bodyOf('activateSendButtons');
            const fakeBody = { dataset: { generating: 'true', generatingMessage: 'true' } };
            lift(body, ['is_send_press', 'hideStopButton', 'showSwipeButtons', 'document'])(
                true, () => { }, () => { }, { body: fakeBody },
            );

            expect(fakeBody.dataset.generating).toBeUndefined();
            expect(fakeBody.dataset.generatingMessage).toBeUndefined();
        });

        test('🔴 deactivateSendButtons() takes the input lock and NOTHING else', () => {
            // This is the whole fix in one assertion: an extension calling this — which is the only
            // thing on the public context — locks input and cannot touch the message row.
            const fakeBody = { dataset: {} };
            lift(bodyOf('deactivateSendButtons'), ['showStopButton', 'hideSwipeButtons', 'document'])(
                () => { }, () => { }, { body: fakeBody },
            );

            expect(fakeBody.dataset.generating).toBe('true');
            expect(fakeBody.dataset.generatingMessage).toBeUndefined();
            expect(Object.keys(fakeBody.dataset)).toEqual(['generating']);
        });

        test('the only deletion of the message flag is in activateSendButtons()', () => {
            const deletes = writesOf('generatingMessage').filter(w => w.kind === 'delete');
            expect(deletes).toHaveLength(1);

            const activate = functionNamed('activateSendButtons');
            expect(deletes[0].line).toBeGreaterThan(activate.loc.start.line);
            expect(deletes[0].line).toBeLessThan(activate.loc.end.line);
        });
    });

    describe('the stylesheet still agrees with all of this', () => {
        const css = fs.readFileSync(path.join(repoRoot, 'public', 'style.css'), 'utf8');

        test('the message row is keyed on the message flag, not on the input lock', () => {
            const rule = css.slice(css.indexOf('#chat .last_mes .mes_buttons') - 400, css.indexOf('#chat .last_mes .mes_buttons'));
            const selector = rule.slice(rule.lastIndexOf('body:is('));

            expect(selector).toContain('[data-generating-message="true"]');
            expect(selector).toContain('[data-swiping="true"]');
            expect(selector).not.toContain('[data-generating="true"]');
        });

        test('and the input lock still hides the send controls', () => {
            const start = css.indexOf('body:is([data-generating="true"], [data-swiping="true"])');
            expect(start).toBeGreaterThan(-1);

            const rule = css.slice(start, css.indexOf('}', start));
            expect(rule).toContain('#send_but');
            expect(rule).toContain('#mes_continue');
            expect(rule).toContain('#mes_impersonate');
            expect(rule).not.toContain('.mes_buttons');
        });
    });
});
