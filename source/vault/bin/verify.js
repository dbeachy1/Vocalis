#!/usr/bin/env node
import process from 'node:process';

import { VERDICT, explain, isClean, problems, summarize, verifyDataRoot, verifyUser } from '../src/verify.js';
import { listVaultedHandles } from '../src/vault-store.js';

/**
 * `verify` — go and look at the disk, and say what is actually on it.
 *
 *     node bin/verify.js --data-root=/path/to/SillyTavern/data
 *     node bin/verify.js --data-root=… --handle=test-user --password   (reads the password from STDIN)
 *
 * 🔴 THE PASSWORD IS NEVER AN ARGUMENT. `--password` takes no value: it reads one line from stdin. A
 * password on the command line is visible in `ps` to every process on the box, and it lands in the shell
 * history — which, on a machine whose threat model is "a package running as me reads things", is not a
 * detail.
 *
 * Exit status is 0 when the disk is clean, 1 when it is not, 2 for a usage error or when there was nothing
 * to verify, and 3 when the tool itself failed, so cron can be told to care about the difference.
 *
 * 🔴 3 EXISTS BECAUSE "I FOUND PLAINTEXT" AND "I FELL OVER" MUST NOT SHARE A CODE. Every internal failure
 * used to land on 1 — a wrong password, an EACCES on a subdirectory, an ENOTDIR from a mistyped root — so
 * the nightly alert said THE VAULT HAS FINDINGS when in fact nothing had been inspected at all. That is the
 * worst available failure for an auditing tool: it cries wolf in the one direction that trains the operator
 * to stop reading, and the day it means it, it reads identically.
 *
 * ⚠️ **THIS FILE DECIDES NOTHING.** Argv, stdin, stdout, exit code — that is the whole of its job. What a
 * verdict means, what counts as clean, and how the tallies are computed all live in `src/verify.js`, next
 * to the enum they are defined over. They used to live here, which meant the sentence an operator actually
 * acts on was the one thing no test could reach, and 159 lines of shipped logic had no tests at all. That
 * is where the `--password`-without-`--handle` bug lived, being read past.
 */

// This module uses top-level `await`, so anything that throws out of it becomes an unhandled rejection —
// which Node reports by printing a stack trace and exiting 1, i.e. indistinguishable from "the disk is
// dirty". Claim it, say plainly that nothing was verified, and exit 3. See the note above.
process.on('unhandledRejection', (error) => {
    console.error('verify could not complete. NOTHING WAS VERIFIED -- this is not a report about your disk.');
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(3);
});

const args = new Map(process.argv.slice(2).map(a => {
    const [key, ...rest] = a.replace(/^--/, '').split('=');
    return [key, rest.length ? rest.join('=') : true];
}));

const dataRoot = args.get('data-root');

if (!dataRoot || dataRoot === true) {
    console.error('usage: node bin/verify.js --data-root=<path> [--handle=<handle>] [--password]');
    console.error('       --password takes no value; it reads one line from stdin.');
    process.exit(2);
}

/**
 * Read a password from stdin, so it never appears in `ps` or in the shell history.
 * @returns {Promise<string>} The password
 */
async function readPassword() {
    process.stderr.write('Password (input is not echoed by your terminal only if you piped it): ');

    let input = '';

    for await (const chunk of process.stdin) {
        input += chunk;
    }

    return input.split('\n')[0].trim();
}

const password = args.has('password') ? await readPassword() : undefined;
const handle = typeof args.get('handle') === 'string' ? String(args.get('handle')) : undefined;

// 🔴 A PASSWORD BELONGS TO ONE ACCOUNT, AND THE TOOL HAS TO SAY SO RATHER THAN GUESS.
//
// One vaulted account is unambiguous, so the password is applied to it. More than one is not, and there is
// no sound way to spread a single password across accounts it may not open — `unlockWithPassword` would
// throw partway through the run. So it stops, and names them, before it has read a single file.
const vaulted = listVaultedHandles(dataRoot);

if (password && !handle && vaulted.length > 1) {
    console.error(`--password needs --handle when there is more than one encrypted account under ${dataRoot}.`);
    console.error(`A password unwraps ONE account's keys, and this data root holds ${vaulted.length}: ${vaulted.join(', ')}.`);
    console.error('Re-run naming the one you have the password for, or drop --password for a keyless pass over all of them.');
    process.exit(2);
}

const deepFor = password ? (handle ?? vaulted[0]) : undefined;

const reports = handle
    ? [await verifyUser(dataRoot, handle, password)]
    : await verifyDataRoot(dataRoot, deepFor ? { [deepFor]: password } : {});

if (reports.length === 0) {
    // 🔴 "NOTHING TO VERIFY" IS NOT "CLEAN", AND IT USED TO EXIT 0 AS IF IT WERE.
    //
    // This is what a typo in a cron entry looks like: `--data-root=…/dat` instead of `…/data` produces no
    // vaulted accounts, and the job then reports success every night for a year while auditing nothing. The
    // more frightening version is the same output from the right path: if `.vault-keys.json` goes missing
    // from every account — a partial restore, a `cp -r` that skipped dotfiles — the accounts are now
    // unopenable, and the tool's answer was `exit 0`.
    //
    // Exit 2, the usage/environment code, because that is what this is: the tool cannot do its job. It is
    // deliberately NOT 1 — 1 means "I looked and the disk is dirty", and the whole point here is that
    // nothing was looked at.
    console.error(`No encrypted accounts under ${dataRoot}. Nothing was verified.`);
    console.error('This is not a clean bill of health -- it means there was nothing here to check. If you');
    console.error('expected accounts at this path, check --data-root, and check that .vault-keys.json still');
    console.error('exists in each account directory (it is a dotfile, and shell globs and GUI copies skip it).');
    process.exit(2);
}

/**
 * Verdicts that explain themselves whenever they appear, even on a clean run.
 *
 * LEGACY because a number that looks verified and is not needs saying every time. FOREIGN because it is
 * the one thing here taken partly on trust — an operator who does not know a plugin claimed a directory
 * cannot notice when it should not have.
 */
const ALWAYS_EXPLAIN = new Set([VERDICT.LEGACY, VERDICT.FOREIGN]);

/** Verdicts that mean something is wrong. Kept in step with `problems()` by asking it. */
const IS_A_PROBLEM = (verdict) => problems({ files: [{ path: '', verdict }] }).length > 0;

/** @type {Set<string>} Every verdict seen, so each is explained once at the end rather than per account. */
const seen = new Set();

for (const report of reports) {
    const { counts, deep } = summarize(report);
    const bad = problems(report);

    for (const verdict of Object.keys(counts)) {
        seen.add(verdict);
    }

    console.log('');
    console.log(`${report.handle} — ${report.files.length} files`);

    // 🔴 `deep`, NEVER whether a password was typed. They are different questions — "was a password
    // given?" and "did THIS account's files actually get decrypted?" — and the gap between them is where
    // this tool told an operator their backup was proven restorable when nothing had been opened.
    console.log(`  ciphertext:  ${counts[VERDICT.CIPHERTEXT] ?? 0}${deep ? ' (decrypted, every one)' : ' (header checked; pass --password to decrypt)'}`);
    console.log(`  key/value:   ${counts[VERDICT.KEY_VALUE] ?? 0}`);
    console.log(`  sidecars:    ${counts[VERDICT.SIDECAR] ?? 0}`);

    if (counts[VERDICT.LEGACY]) {
        console.log(`  legacy:      ${counts[VERDICT.LEGACY]}  (plaintext from before the vault — see below)`);
    }

    if (counts[VERDICT.FOREIGN]) {
        console.log(`  foreign:     ${counts[VERDICT.FOREIGN]}  (encrypted by another plugin under its own subkey — see below)`);
    }

    console.log(`  vault keys:  ${counts[VERDICT.VAULT_KEYS] ?? 0}  (plaintext by necessity — it is what you unlock WITH)`);

    if (bad.length === 0) {
        console.log('  ✅ nothing readable on the disk.');

        for (const file of report.files.filter(f => f.verdict === VERDICT.FOREIGN)) {
            console.log(`     foreign    ${file.path}  — ${file.detail}`);
        }

        continue;
    }

    console.log('');
    console.log(`  🔴 ${bad.length} FILE(S) THAT SHOULD NOT LOOK LIKE THIS:`);

    for (const file of bad) {
        console.log(`     ${file.verdict.padEnd(18)} ${file.path}`);

        if (file.detail) {
            console.log(`                ${file.detail}`);
        }
    }
}

console.log('');

// Every verdict that turned up and has something to say, explained once — and the words come from
// `src/verify.js`, so a second consumer says the same thing about the same finding.
for (const verdict of seen) {
    const meaning = explain(verdict);

    if (meaning && (ALWAYS_EXPLAIN.has(verdict) || IS_A_PROBLEM(verdict))) {
        console.log(`${verdict}: ${meaning}`);
        console.log('');
    }
}

if (!isClean(reports)) {
    console.log('Nothing has been changed. This tool only ever looks.');
    process.exit(1);
}

// Any account walked keylessly, whether or not a password was typed for some other one. On a multi-account
// root a deep pass over one account leaves the rest shallow, and the advisory is about them.
const shallow = reports.filter(report => !report.deep);

if (shallow.length > 0) {
    const which = shallow.length === reports.length ? 'every file' : `every file in ${shallow.map(r => r.handle).join(', ')}`;
    console.log(`Shallow pass: ${which} carries the STV1 header. Re-run with --password to also DECRYPT them,`);
    console.log('which is what proves the account is actually recoverable rather than merely encrypted.');
}

console.log('');
console.log('⚠️  Back up .vault-keys.json. The password does not decrypt your data — it unwraps THAT FILE, and');
console.log('   the file holds the key. Lose it and every chat is unreadable for ever, with the correct');
console.log('   password in hand and a perfect backup of everything else.');

process.exit(0);
