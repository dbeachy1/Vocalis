import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 🔴 A SUITE THAT CANNOT RUN MUST NEVER REPORT GREEN.
 *
 * This is `PLAN_INTEGRATION_TESTS.md` §4, and it is the rule the integration suites exist under. An
 * integration suite whose dependency is missing has exactly two acceptable outcomes: fail loudly, or
 * skip loudly and name what was missing. Passing quietly is the one forbidden outcome, because a
 * green tick meaning "Vault was not installed, so nothing was checked" reports safety that was never
 * verified, to someone who will believe it.
 *
 * ⚠️ So the DEFAULT here is to throw. Skipping is opt-in, via `ST_INTEGRATION_PERMISSIVE=1`, and it
 * still prints the whole report. The deployment already learned this shape the hard way: while
 * `debugMode` is on, `st.log` is not written at all, so the absence of conversation content in it
 * proves nothing. An absent marker in a file nobody wrote is not evidence, and neither is a passing
 * test that never executed.
 *
 * The revision reporting is not decoration. A green integration run has to be attributable to
 * specific commits of specific dependencies, rather than to "whatever happened to be on disk that
 * day" — the three repositories move independently and are routinely out of step with each other.
 */

const integrationDirectory = path.dirname(fileURLToPath(import.meta.url));

/** The repository root: `tests/integration` up two levels. */
export const serverDirectory = path.dirname(path.dirname(integrationDirectory));

/**
 * The dependencies these suites can ask for.
 *
 * `relativePath` mirrors how each one is installed in a real deployment, because that is the layout
 * the server itself resolves — a suite that looked somewhere else would be testing an arrangement
 * that never ships.
 */
export const DEPENDENCIES = {
    vault: {
        key: 'vault',
        name: 'SillyTavern-Vault',
        relativePath: path.join('storage-providers', 'vault'),
        installHint: 'git clone https://github.com/dbeachy1/SillyTavern-Vault.git storage-providers/vault && (cd storage-providers/vault && npm install)',
    },
    mnemosyne: {
        key: 'mnemosyne',
        name: 'SillyTavern-Mnemosyne',
        relativePath: path.join('plugins', 'SillyTavern-Mnemosyne'),
        installHint: 'git clone https://github.com/dbeachy1/SillyTavern-Mnemosyne.git plugins/SillyTavern-Mnemosyne && (cd plugins/SillyTavern-Mnemosyne && npm install)',
    },
};

/**
 * The short git revision of a checkout.
 *
 * ⚠️ Returns a *description* on failure, never an empty string. A blank revision in the report would
 * read as "no revision" and get skimmed past; "unknown — not a git checkout" is a thing a reader
 * stops at, which is the whole point of printing it.
 * @param {string} absolutePath Directory to inspect
 * @returns {string} The short revision, or a human-readable reason it could not be determined
 */
export function gitRevision(absolutePath) {
    try {
        return execFileSync('git', ['-C', absolutePath, 'rev-parse', '--short', 'HEAD'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || 'unknown — git printed nothing';
    } catch {
        return 'unknown — not a git checkout';
    }
}

/**
 * Locate one dependency and pin what was found.
 * @param {object} dependency An entry from {@link DEPENDENCIES}
 * @param {string} [root] The repository root to resolve against
 * @returns {{key: string, name: string, absolutePath: string, present: boolean, revision: string|null, installHint: string}} What was found
 */
export function resolveDependency(dependency, root = serverDirectory) {
    const absolutePath = path.join(root, dependency.relativePath);
    const present = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory();

    return {
        key: dependency.key,
        name: dependency.name,
        installHint: dependency.installHint,
        absolutePath,
        present,
        revision: present ? gitRevision(absolutePath) : null,
    };
}

/**
 * The block printed above every integration run, present or missing.
 * @param {string} suiteName The suite being gated
 * @param {Array<object>} resolved Output of {@link resolveDependency}
 * @returns {string} A multi-line report
 */
export function formatReport(suiteName, resolved) {
    const lines = [`integration preflight — ${suiteName}`];

    for (const one of resolved) {
        lines.push(one.present
            ? `  ✅ ${one.name} @ ${one.revision}  (${one.absolutePath})`
            : `  ❌ ${one.name} NOT FOUND at ${one.absolutePath}`);
    }

    const missing = resolved.filter(one => !one.present);

    if (missing.length > 0) {
        lines.push('', 'This suite asserts on real dependencies and cannot substitute for one that is absent.', 'To install:');

        for (const one of missing) {
            lines.push(`  ${one.installHint}`);
        }
    }

    return lines.join('\n');
}

/**
 * Gate a suite on its dependencies.
 *
 * 🔴 Throws when something is missing. That is deliberate and it is the default: the alternative to
 * a loud failure here is a suite that reports green having checked nothing.
 *
 * Set `ST_INTEGRATION_PERMISSIVE=1` to downgrade a missing dependency to a skip — for a machine that
 * is knowingly without one, such as a dev box where only the fork is checked out. The report is
 * printed either way, so a skip still names what was missing.
 * @param {string} suiteName The suite being gated, for the report
 * @param {Array<object>} dependencies Entries from {@link DEPENDENCIES}
 * @param {object} [options] Options
 * @param {string} [options.root] Repository root to resolve against
 * @param {boolean} [options.permissive] Skip instead of failing when something is missing
 * @param {Function} [options.print] Where the report goes
 * @returns {{run: boolean, resolved: Array<object>, report: string}} Whether the suite may run
 */
export function preflight(suiteName, dependencies, options = {}) {
    const {
        root = serverDirectory,
        permissive = process.env.ST_INTEGRATION_PERMISSIVE === '1',
        print = console.log,
    } = options;

    const resolved = dependencies.map(one => resolveDependency(one, root));
    const report = formatReport(suiteName, resolved);
    const missing = resolved.filter(one => !one.present);

    if (missing.length > 0 && !permissive) {
        // The report rides inside the error rather than going to `print` as well. A thrown message is
        // the one thing every runner surfaces; printing it too just says the same thing twice in the
        // output of a run that is already failing.
        throw new Error(`${report}\n\nRefusing to run "${suiteName}" with ${missing.length === 1 ? 'a missing dependency' : 'missing dependencies'}. Set ST_INTEGRATION_PERMISSIVE=1 to skip instead of failing.`);
    }

    print(report);

    return { run: missing.length === 0, resolved, report };
}
