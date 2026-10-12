import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

import * as lifecycle from '../src/lifecycle.js';
import * as session from '../src/session.js';
import { adoptLogger, resetLogging } from '../src/logging.js';
import { describe as describeSituation } from '../src/strings.js';
import { idleLockMs } from '../src/settings.js';
import { vaultKeysPath } from '../src/vault-store.js';
import { createVaultState } from '../src/vault-state.js';

jest.setTimeout(180_000);

/**
 * 🔴 EVERY LINE THIS PLUGIN LOGS, CHECKED AGAINST THE WORST POSSIBLE VALUE OF WHAT IT INTERPOLATES.
 *
 * `tests/logging.test.js` proves the CHANNEL works. This proves the CALL SITES use it correctly, which is a
 * different and more easily broken thing: the channel cannot tell you that the string you marked `NORMAL`
 * has a handle in it.
 *
 * The rule these tests encode, from `src/logging.js`:
 *
 *   **`NORMAL` is an assertion about the worst possible value of every interpolated argument, not the value
 *   you saw while testing.** A handle, a path, an `Error` or its message, and anything derived from them are
 *   all user-authored however enum-shaped they look. `default-user` is not an enum — a person chose it.
 *
 * So every test here does the same two things: assert the NORMAL half says enough to act on, and assert it
 * contains NONE of the identifiers. The second assertion is the one that catches a well-meaning future edit
 * that "helpfully" puts the handle back into the visible line.
 */

const HANDLE = 'default-user';
const PASSWORD = 'correct horse battery staple';

/** @type {string} */
let dataRoot;
/** @type {Array<{level: string, logClass: number, args: any[]}>} */
let lines;

const NORMAL = 0;
const SENSITIVE = 1;

/** Adopt a recording logger shaped like the fork's. @returns {void} */
function recordEverything() {
    lines = [];
    const record = (level) => (logClass, ...args) => void lines.push({ level, logClass, args });

    const adopted = adoptLogger({
        logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
        LogClass: { NORMAL, SENSITIVE },
    });

    // If this ever goes false the whole suite silently passes while testing nothing, because every
    // expectation below is over `lines`, and `lines` would simply stay empty.
    expect(adopted).toBe(true);
}

/** Everything written at one class, flattened to a single searchable string. @param {number} logClass @returns {string} */
function textAt(logClass) {
    return lines
        .filter((line) => line.logClass === logClass)
        .map((line) => line.args.map((arg) => (arg instanceof Error ? `${arg.message}` : String(arg))).join(' '))
        .join('\n');
}


/**
 * This suite's own provider state.
 *
 * 🔴 A FRESH ONE PER TEST **IS** THE RESET. Before `vault-state.js` the modules held six
 * globals between them, so a test had to remember which `reset*()` calls applied to it -- and
 * `tests/verify.test.js` records a test that passed with its guard DELETED because the shared
 * `dataRoot` was already set by a previous `beforeEach`. Nothing here can do that now: a provider
 * built around this object cannot see any other test's state, because there is no other state to see.
 */
let vault;
beforeEach(() => {
    vault = createVaultState();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-logclass-'));
    fs.mkdirSync(path.join(dataRoot, HANDLE), { recursive: true });
    session.closeAll(vault);
    recordEverything();
});

afterEach(() => {
    session.closeAll(vault);
    resetLogging();
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('🚨 the UNRECOVERABLE warning — the line this whole change exists for', () => {
    /** The recovery key stashed by the first, successful login — see {@link loginWithAnUnwritableKeysFile}. */
    let stashedBeforeTheFailure;

    /**
     * Drive a login into the failing-write branch of `ensureRecoveryKeyIsAcknowledged`.
     *
     * 🔴 THE SABOTAGE HAS TO LAND ON THE WRITE AND NOWHERE ELSE. `unlock` READS the keys file before the
     * re-arm ever runs, so making the keys file itself unopenable just throws in `readVaultKeys` and the
     * branch under test is never reached — the first version of this helper did exactly that and the suite
     * "passed" a test of nothing. `writeVaultKeys` writes `<keys>.tmp` and renames it, so a DIRECTORY
     * squatting on the temp path makes the write, and only the write, throw EISDIR — from the real `fs`,
     * not a mock. That matters: the branch under test is a `catch`, and a catch tested against a fake throw
     * proves only that `throw` works.
     * @returns {Promise<void>}
     */
    async function loginWithAnUnwritableKeysFile() {
        lifecycle.init(vault, {
            dataRoot,
            accountsEnabled: true,
            basicAuthMode: false,
            authenticationDelegated: false,
            users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
        });

        // First login creates the vault and writes the keys file normally. It also stashes a recovery key,
        // and it must: `recovery_acknowledged` has to still be false for the re-arm to fire at all below.
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
        stashedBeforeTheFailure = lifecycle.pendingRecoveryKey(vault, HANDLE);
        session.closeAll(vault);

        const temporaryPath = `${vaultKeysPath(dataRoot, HANDLE)}.tmp`;
        fs.mkdirSync(temporaryPath);

        try {
            recordEverything();
            await lifecycle.unlock(vault, HANDLE, PASSWORD);
        } finally {
            fs.rmSync(temporaryPath, { recursive: true, force: true });
        }
    }

    test('🔴 the operator is TOLD, on a default install, that an account is unrecoverable', async () => {
        // The regression. Before the split this produced `[SENSITIVE suppressed: lifecycle.js:162]` and
        // nothing else, for the one condition lifecycle.js itself calls "invisible from the inside".
        await loginWithAnUnwritableKeysFile();

        const published = textAt(NORMAL);

        expect(published).toContain('UNRECOVERABLE');
        expect(published).toContain('recovery key');
        expect(published).toMatch(/retried at their next login/i);
    });

    test('🔴 and the published half names NOBODY — no handle, no path, no error text', async () => {
        // A handle is user-authored, and an fs error message embeds the absolute path it failed on. Either
        // one in the NORMAL half publishes user data in the clear on an install whose entire premise is that
        // there isn't any. This is why the line was split rather than promoted.
        await loginWithAnUnwritableKeysFile();

        const published = textAt(NORMAL);

        expect(published).not.toContain(HANDLE);
        expect(published).not.toContain(dataRoot);
        expect(published).not.toMatch(/EISDIR|EPERM|EACCES|ENOSPC|ENOENT/);
        expect(published).not.toContain(path.sep + HANDLE);
    });

    test('the suppressed half carries the handle and the Error, so debugMode answers "who"', async () => {
        // The NORMAL half is only honest if the detail is genuinely reachable. It tells the operator to turn
        // debugMode on; this asserts that doing so actually answers the question.
        await loginWithAnUnwritableKeysFile();

        const suppressed = lines.filter((line) => line.logClass === SENSITIVE);
        const recoveryFailure = suppressed.find((line) => String(line.args[0]).includes('Recovery key write failed'));

        expect(recoveryFailure).toBeDefined();
        expect(recoveryFailure.args).toContain(HANDLE);
    });

    test('🔴 the Error is passed as an OBJECT, not flattened to error.message', async () => {
        // The fork's suppression stub appends the error's `code`, so a suppressed line still reads
        // `[SENSITIVE suppressed: lifecycle.js:NNN] [EISDIR]` — the operator gets the failure CLASS for free
        // while the path stays suppressed. `${error.message}` throws that away AND smuggles the path into a
        // string that a later edit could promote without noticing what is inside it.
        await loginWithAnUnwritableKeysFile();

        const recoveryFailure = lines.find((line) => String(line.args[0]).includes('Recovery key write failed'));

        // Structural, not `instanceof`: under jest's VM modules the `fs` that threw lives in a different
        // realm, so its Error has a different constructor and `instanceof Error` is false here for a
        // genuine Error. `Object.prototype.toString` is realm-independent.
        const passed = recoveryFailure.args.find((arg) => Object.prototype.toString.call(arg) === '[object Error]');

        expect(passed).toBeDefined();

        // The `code` is the entire reason this is an object rather than a string: the fork's `safeErrorCode`
        // reads it off the argument to append `[EISDIR]` to the suppression stub, which is the only detail
        // an operator gets without turning debugMode on.
        expect(passed.code).toBe('EISDIR');
    });

    test('the login still succeeds — a logging change must not have made this fatal', async () => {
        // The catch deliberately does not fail the login: the old wrap is still on disk and the DEK has not
        // moved, so nothing is lost. Pinned here because both halves of the split sit in that catch, and an
        // exception thrown from a logger would convert a soft warning into a lockout.
        await loginWithAnUnwritableKeysFile();

        expect(lifecycle.isReady(vault, HANDLE)).toBe(true);
    });

    test('🔴 the key it FAILED to persist is never stashed for display', async () => {
        // The order is load-bearing: showing a key whose wrap did not reach the disk is worse than showing
        // none, because the user files it away believing they are covered. What must hold here is that the
        // failed re-arm left the stash exactly as it found it — the key from the earlier SUCCESSFUL write is
        // still pending and still valid, and the newly minted one was dropped on the floor with its wrap.
        await loginWithAnUnwritableKeysFile();

        expect(stashedBeforeTheFailure).toBeTruthy();
        expect(lifecycle.pendingRecoveryKey(vault, HANDLE)).toBe(stashedBeforeTheFailure);
    });
});

describe('⚙️  the garbled idle-lock setting', () => {
    /** @type {string|undefined} */
    let saved;

    beforeEach(() => {
        saved = process.env.VAULT_IDLE_LOCK_MINUTES;
    });

    afterEach(() => {
        if (saved === undefined) {
            delete process.env.VAULT_IDLE_LOCK_MINUTES;
        } else {
            process.env.VAULT_IDLE_LOCK_MINUTES = saved;
        }
    });

    test('the operator learns the variable is wrong and what is being used instead', () => {
        process.env.VAULT_IDLE_LOCK_MINUTES = 'half an hour';

        expect(idleLockMs()).toBe(30 * 60 * 1000);

        const published = textAt(NORMAL);
        expect(published).toContain('VAULT_IDLE_LOCK_MINUTES');
        expect(published).toContain('30');
    });

    test('🔴 but the VALUE is suppressed — an environment is where a pasted secret ends up', () => {
        // This is not paranoia about an operator-set variable. We are in this branch precisely BECAUSE it
        // did not parse, so whatever is in it is by definition not the number this setting expects. The
        // variable's name is the actionable half; its contents are not needed to fix a typo.
        process.env.VAULT_IDLE_LOCK_MINUTES = 'hunter2-pasted-in-the-wrong-window';

        idleLockMs();

        expect(textAt(NORMAL)).not.toContain('hunter2');
        expect(textAt(SENSITIVE)).toContain('hunter2-pasted-in-the-wrong-window');
    });

    test('a valid setting logs nothing at all', () => {
        process.env.VAULT_IDLE_LOCK_MINUTES = '5';

        expect(idleLockMs()).toBe(5 * 60 * 1000);
        expect(lines).toEqual([]);
    });
});

describe('🗣️  describe() — the situation key is ours, the Error is not', () => {
    test('a throwing template splits: the situation is published, the Error is not', () => {
        // `null` defeats the `= {}` default (which only fires for undefined), so the template's destructure
        // throws — a real throw from the real code path, not a mock.
        expect(describeSituation('password.change', null)).toBeNull();

        expect(textAt(NORMAL)).toContain('password.change');
        expect(textAt(SENSITIVE)).toContain('password.change');
    });

    test('🔴 the situation key is safe to publish ONLY because it is one of our own literals', () => {
        // Every key reaching that log line is an own-property of the SITUATIONS table defined at the top of
        // strings.js — a string this repo wrote. If a future edit ever lets a caller-supplied key through to
        // the NORMAL line, this is the assumption that broke.
        expect(describeSituation('not-a-situation-anyone-defined', {})).toBeNull();
        expect(lines).toEqual([]);
    });

    test('🔴 an inherited Object.prototype key is not a situation, and returns null', () => {
        // A plain object literal inherits from Object.prototype, so a bare `SITUATIONS[situation]` lookup
        // finds `toString`, calls it, and returns the string '[object Object]' — which is not nullish, so it
        // sailed past the `??` and this function returned garbage instead of the null its contract promises.
        // The fork would then read `.body` off a string. `Object.hasOwn` is what closed it.
        for (const inherited of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
            expect(describeSituation(inherited, {})).toBeNull();
        }

        expect(lines).toEqual([]);
    });

    test('a real situation still answers normally, and logs nothing', () => {
        const text = describeSituation('password.change', { handle: HANDLE, self: true });

        expect(text).not.toBeNull();
        expect(typeof text.body).toBe('string');
        expect(lines).toEqual([]);
    });
});

describe('🚨 the legacy-data notice — a handle published for a week', () => {
    /**
     * Turn encryption on for an account that ALREADY has a file in it, which is the only way to reach the
     * notice: `createVaultFor` logs it exactly when `listUserContent` came back non-empty.
     * @returns {Promise<void>}
     */
    async function encryptAnAccountThatAlreadyHadData() {
        // A file that predates the vault. Not one of the four names `listUserContent` skips as
        // SillyTavern's own boot artefacts, or the branch never fires and this tests nothing.
        fs.mkdirSync(path.join(dataRoot, HANDLE, 'chats'), { recursive: true });
        fs.writeFileSync(path.join(dataRoot, HANDLE, 'chats', 'an old chat.jsonl'), 'from before the vault');

        lifecycle.init(vault, {
            dataRoot,
            accountsEnabled: true,
            basicAuthMode: false,
            authenticationDelegated: false,
            users: [{ handle: HANDLE, enabled: true, hasPassword: true }],
        });

        recordEverything();
        await lifecycle.unlock(vault, HANDLE, PASSWORD);
    }

    test('the operator is told, on a default install, that the account holds legacy plaintext', async () => {
        await encryptAnAccountThatAlreadyHadData();

        const published = textAt(NORMAL);

        expect(published).toMatch(/before encryption was turned on/i);
        expect(published).toMatch(/1 file/);
    });

    test('🔴 and the published half names NOBODY', async () => {
        // The regression. This line interpolated `handle` straight into `normal()` — the one case
        // `src/logging.js` names explicitly — while its neighbour sixty lines up split correctly. It was
        // invisible because a fork with no classified logger captures everything SENSITIVE, so the
        // published half only exists once the seam is adopted. Which is what this branch does.
        await encryptAnAccountThatAlreadyHadData();

        expect(textAt(NORMAL)).not.toContain(HANDLE);

        // And the identifier still has to be reachable with debugMode on, or the notice is useless.
        expect(textAt(SENSITIVE)).toContain(HANDLE);
    });
});

describe('🧹 no NORMAL call site in src/ interpolates something a user wrote', () => {
    /**
     * 🔴 THE GENERAL FORM OF THE BUG ABOVE, CHECKED STATICALLY.
     *
     * Every runtime test here can only cover a call site some test happens to drive. `lifecycle.js:240` was
     * never driven, so it published a handle for a week with a full suite passing over it. The channel
     * cannot catch this — `normal()` has no idea what you interpolated — and neither can review, reliably,
     * because the correct split sits sixty lines away and looks the same at a glance.
     *
     * So: read the source, find every `normal()` call, and fail on one that interpolates an identifier the
     * module docblock names as user-authored. It is a blunt instrument and deliberately so. A call site with
     * a genuine reason to interpolate one of these names should be reaching for `sensitive()` instead; if it
     * truly is not, it can say so by naming the variable something this list does not match, which is a
     * decision a human has made on purpose rather than by omission.
     */
    test('🔴 no `normal()` line in src/ interpolates a handle, a path, a name or an error', () => {
        // ⚠️ `fileURLToPath`, NOT `new URL(...).pathname.slice(1)`. That idiom is Windows-only: on Linux and
        // macOS it strips the LEADING SLASH off an absolute path, so `readdirSync` throws ENOENT and both of
        // these guards die on any POSIX machine. The tempting fix — wrap it in try/catch — would convert
        // them into permanent silent passes, which is strictly worse than the crash.
        const sourceRoot = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');

        // From `src/logging.js`: "A handle, a chat id, a character or persona name, an error message, and
        // any path under a user directory are ALL user-authored, however enum-shaped they look."
        // 🔴 THE LIST HAD NO WORD FOR A SECRET IN IT. Not `password`, not `key`, not `secret`, not `dek`, not
        // `recoveryKey`. `logging.js` says a recovery key must never go through EITHER channel — and
        // `normal().warn(\`minted ${recoveryKey}\`)` matched none of these fifteen names, so the guard would
        // have stayed green while a master credential was written to `st.log` on a default install. The
        // fifteen original entries are all identifiers; the categories the module actually cares about most
        // were the ones missing.
        //
        // Also added: `target`/`source` (absolute paths built from `dataRoot` in `foreign-stores.js` — the
        // rule was being enforced against a variable's NAME, so renaming `dataRoot` to `target` defeated it),
        // and the generic carriers `value`, `content`, `plaintext`, `data`, `bytes`, `name`, `user`,
        // `account`, `path`.
        const userAuthored = new RegExp(
            '\\b(' + [
                // Identifiers and paths — the original list.
                'handle', 'error', 'filename', 'fileName', 'logical', 'physical', 'absPath',
                'dataRoot', 'userRoot', 'title', 'persona', 'character', 'chatId', 'directory', 'entry',
                // Paths under other names.
                'target', 'source', 'path', 'name',
                // Secrets. A `normal()` line must never carry one of these under any circumstances.
                'password', 'passphrase', 'secret', 'key', 'keys', 'dek', 'kek', 'subkey', 'subkeys',
                'recoveryKey', 'recoverySecret', 'wrap', 'salt',
                // Payloads.
                'value', 'content', 'plaintext', 'data', 'bytes', 'raw', 'user', 'account',
            ].join('|') + ')\\b',
        );

        /**
         * ⚠️ THE ONE DOCUMENTED EXEMPTION, AND IT IS ABOUT WHOSE STRING IT IS.
         *
         * A foreign store's `directory` and `owner` are declared by a PLUGIN, in its own source, as constants
         * — `provider.js` says so where it exposes the hook: "Not per-user: a plugin's layout is the same in
         * every account." They are not user-authored, and they are already written to
         * `_vault/vault-foreign-stores.json` **in the clear, by design**, because `verify` has to read them
         * from cron with no key. Suppressing them in the log would hide a fact that is sitting on the disk
         * in plaintext two directories away.
         *
         * Scoped to the one module and the two names on purpose. A `handle` in `foreign-stores.js` still
         * fails, and a `directory` anywhere else still fails.
         */
        const exempt = { 'foreign-stores.js': /^\s*(directory|owner|record\.\w+)\s*$/ };

        /** @type {string[]} */
        const offenders = [];

        // Vacuity guards — see the assertions at the end of this test.
        /** @type {string[]} */
        const scanned = [];
        /** @type {string[]} */
        const calls = [];

        /**
         * The argument text of every `normal().<level>(…)` call in a source file, parens balanced.
         * @param {string} code The file's source
         * @returns {{args: string, line: number}[]} One entry per call
         */
        const normalCalls = (code) => {
            const found = [];
            const opener = /\bnormal\(\)\s*\.\s*(?:log|info|warn|error|debug)\s*\(/g;

            for (let match = opener.exec(code); match !== null; match = opener.exec(code)) {
                let depth = 1;
                let index = match.index + match[0].length;

                while (index < code.length && depth > 0) {
                    if (code[index] === '(') depth++;
                    else if (code[index] === ')') depth--;
                    index++;
                }

                found.push({
                    args: code.slice(match.index + match[0].length, index - 1),
                    line: code.slice(0, match.index).split(/\r?\n/).length,
                });
            }

            return found;
        };

        /** @param {string} directory @returns {void} */
        const walk = (directory) => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const full = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    walk(full);
                    continue;
                }

                if (!entry.name.endsWith('.js')) {
                    continue;
                }

                const code = fs.readFileSync(full, 'utf-8');
                scanned.push(path.basename(full));

                for (const call of normalCalls(code)) {
                    calls.push(`${path.basename(full)}:${call.line}`);
                    // Only what is INTERPOLATED can carry a user's text. A `${...}` hole, or a bare
                    // identifier passed as its own argument. Prose mentioning the word "handle" is fine —
                    // and it is everywhere in this repo, so the literals have to come out before anything
                    // else is read. (Splitting the arguments on `,` without doing that cut a single-quoted
                    // sentence in half at "could not be read," and flagged the word "error" in its tail.)
                    const holes = [...call.args.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]);
                    const withoutLiterals = call.args
                        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
                        .replace(/'(?:[^'\\]|\\.)*'/g, '\'\'')
                        .replace(/"(?:[^"\\]|\\.)*"/g, '\'\'');
                    const bareArgs = withoutLiterals.split(',').map(a => a.trim()).filter(Boolean);

                    const allowed = exempt[path.basename(full)];
                    const risky = [...holes, ...bareArgs]
                        .filter(fragment => !(allowed && allowed.test(fragment)))
                        .filter(fragment => userAuthored.test(fragment));

                    if (risky.length > 0) {
                        offenders.push(`${path.basename(full)}:${call.line} — ${risky.join(', ')}`);
                    }
                }
            }
        };

        walk(sourceRoot);

        expect(offenders).toEqual([]);

        // 🔴 AND PROVE THE SCAN ACTUALLY HAPPENED. `expect(offenders).toEqual([])` on its own is green when
        // the walk reads zero files and green when the opener regex matches zero call sites — and this test
        // is the ONLY thing standing between chat text and `st.log`, because the runtime tests below cover
        // handles and env vars but not names, titles or content.
        //
        // The failure is not hypothetical: hoist the channel to a local (`const log = normal();`) and the
        // opener stops matching, `offenders` stays empty, and the guard reports success having checked
        // nothing at all. A count is what tells the difference between "found no offenders" and "looked
        // nowhere".
        expect(scanned.length).toBeGreaterThan(20);
        expect(calls.length).toBeGreaterThan(5);
    });
});

describe('🧹 no call site in src/ still prints through a bare console', () => {
    test('🔴 every console.* in src/ lives in logging.js, where it is the fallback sink', () => {
        // The seam captures `console.*` as SENSITIVE, so a bare console call anywhere else is a line that
        // vanishes on every default install — the exact defect this change fixes, reintroduced. Cheap to
        // check, and it catches the next one at review time rather than in production silence.
        const sourceRoot = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
        /** @type {string[]} */
        const offenders = [];
        /** @type {string[]} */
        const scanned = [];

        /** @param {string} directory @returns {void} */
        const walk = (directory) => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const full = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                    continue;
                }
                if (!entry.name.endsWith('.js') || entry.name === 'logging.js') {
                    continue;
                }

                const code = fs.readFileSync(full, 'utf-8');
                scanned.push(entry.name);
                // Split on `\r?\n`, not `\n`: a trailing `\r` survives the split, and `.` does not match
                // `\r` in JS, so `/^\s*(\/\/|\*).*$/` silently fails to match every comment line in a CRLF
                // checkout — which is this one. That made this test report `paths.js:163`, a docblock.
                for (const [index, line] of code.split(/\r?\n/).entries()) {
                    // Comments talk ABOUT console calls in several files; only real calls count.
                    const withoutComments = line.replace(/^\s*(\/\/|\*).*$/, '');
                    if (/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(withoutComments)) {
                        offenders.push(`${path.basename(full)}:${index + 1}`);
                    }
                }
            }
        };

        walk(sourceRoot);

        expect(offenders).toEqual([]);

        // Same vacuity guard as the scanner above: an empty `offenders` must mean "checked and clean", never
        // "never looked". See the longer note there.
        expect(scanned.length).toBeGreaterThan(20);
    });
});
