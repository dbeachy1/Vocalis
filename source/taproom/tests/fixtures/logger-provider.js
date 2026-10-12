import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';

/**
 * 🔴 A STORAGE PROVIDER THAT LOGS FOUR WAYS, SO THE LOG FILE CAN BE ASKED WHICH ONES SURVIVED.
 *
 * The provider counterpart to `logger-plugin.mjs`, and it exists for a reason that fixture does not cover:
 * a storage provider is loaded by `storage-provider-loader.js`, not `plugin-loader.js`, and for a long time
 * only the plugin path handed out `{ logger, LogClass }`. A provider therefore had every line it printed
 * rewritten to SENSITIVE by `installConsoleSeam()` and suppressed on any default install — including the
 * one warning a provider is most obliged to make, that a user's data has become unrecoverable.
 *
 * The claim is only worth something if the fork's writer honours it AND still suppresses everything else,
 * and neither half can be proved from inside the provider, because the provider cannot see what was
 * written. So this fixture only *emits*. Every assertion lives in the test, against the log file the
 * server wrote.
 *
 * ⛔ IT OWNS NOTHING. `owns()` returns false, so every path falls straight through to node:fs and the boot
 * is a byte-for-byte ordinary one. This fixture is about the logging channel and must not perturb anything
 * else; the storage funnel has its own fixtures. The I/O surface below exists only because
 * `registerStorageProvider` requires all 23 members to be present, and it is a plain pass-through.
 */

/** Where the journal goes. Set by the test, across the process boundary, because the provider runs in the child. */
const journalPath = process.env.ST_PROVIDER_LOG_JOURNAL ?? '';

/**
 * The canaries. Deliberately absurd strings: they must be impossible to confuse with real log content, and
 * `indexOf` on the log file has to be an honest question.
 */
export const CANARY = Object.freeze({
    /** Content-free and vouched for — the ONLY one that may appear in `st.log` on a default install. */
    NORMAL: 'CANARY-PROVIDER-NORMAL-c4a7',
    /** Vouched-for lines are not a way around classification: naming SENSITIVE must still suppress. */
    SENSITIVE: 'CANARY-PROVIDER-SENSITIVE-9e02',
    /** The accident case. Bare `console.*` from a provider must be caught by the seam like anyone else's. */
    CONSOLE: 'CANARY-PROVIDER-CONSOLE-5f31',
});

/**
 * Write one line to the journal.
 * @param {string} what What happened
 * @returns {void}
 */
function journal(what) {
    if (journalPath) {
        fs.appendFileSync(journalPath, `${what}\n`, 'utf-8');
    }
}

/**
 * Build the logging-probe provider.
 * @returns {any} The provider
 */
export default function createLoggerProvider() {
    return {
        id: 'logger-provider',

        owns: () => false,
        ownsUser: () => false,
        isReady: () => true,
        async unlock() { /* owns nothing, locks nothing */ },
        lock() { },
        async rekey() { },

        /**
         * @param {any} context The context the fork provides
         * @returns {Promise<void>}
         */
        async init(context) {
            journal(`logger: ${typeof context.logger}`);
            journal(`LogClass: ${typeof context.LogClass}`);

            // 🔴 The context must expose the logger and the vocabulary, and NOTHING ELSE from logger.js. A
            // provider that can reach initLogger or shutdownLogger can redirect, close or rotate the
            // operator's log — strictly worse than the problem this channel set out to fix.
            journal(`initLogger reachable: ${'initLogger' in context}`);
            journal(`shutdownLogger reachable: ${'shutdownLogger' in context}`);
            journal(`installConsoleSeam reachable: ${'installConsoleSeam' in context}`);

            // The environment must still arrive intact. Adding the channel must not have displaced the
            // facts a provider decides whether to refuse a configuration on.
            journal(`dataRoot: ${typeof context.dataRoot === 'string' && context.dataRoot.length > 0}`);
            journal(`accountsEnabled: ${typeof context.accountsEnabled}`);
            journal(`users: ${Array.isArray(context.users)}`);

            if (typeof context.logger !== 'object' || typeof context.LogClass !== 'object') {
                // Say it loudly. A missing channel would otherwise look identical to a working one whose
                // lines were all suppressed — the exact ambiguity this suite exists to remove.
                journal('logger: MISSING');
                return;
            }

            journal(`LogClass.NORMAL: ${context.LogClass.NORMAL}`);
            journal(`LogClass.SENSITIVE: ${context.LogClass.SENSITIVE}`);

            // The line the channel exists for: content-free, operationally useful, and vouched for. This is
            // the shape of Vault's "could not write a recovery key" warning, which is the real motivation.
            context.logger.warn(context.LogClass.NORMAL, `${CANARY.NORMAL} — a recovery key could not be written for an account.`);

            // Naming a class is not a way around classification. This one must be suppressed like any other.
            context.logger.warn(context.LogClass.SENSITIVE, `handle was: ${CANARY.SENSITIVE}`);

            // The accident case — the debugging line nobody removed. The seam must still catch it.
            console.log(`provider debug: ${CANARY.CONSOLE}`);

            journal('logger provider emitted all three lines');
        },

        // ---- the pass-through I/O surface: present so registration succeeds, never reached -------------

        async readFile(p, opts) {
            return await fs.promises.readFile(p, opts);
        },
        readFileSync: (p, opts) => fs.readFileSync(p, opts),
        createReadStream: (p, opts) => Readable.from(fs.readFileSync(p, opts)),
        async sendFile(res, p) {
            res.sendFile(p);
        },

        exists: (p) => fs.existsSync(p),
        stat: (p) => fs.statSync(p),
        readdir: (p, opts) => fs.readdirSync(p, opts),

        async writeFile(p, data, opts) {
            await fs.promises.writeFile(p, data, opts);
        },
        writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
        createWriteStream(p) {
            const chunks = [];

            return new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.from(chunk));
                    callback();
                },
                final(callback) {
                    try {
                        fs.writeFileSync(p, Buffer.concat(chunks));
                        callback();
                    } catch (error) {
                        callback(error);
                    }
                },
            });
        },

        mkdir: (p, opts) => fs.mkdirSync(p, opts),
        unlink: (p) => fs.unlinkSync(p),
        rename: (from, to) => fs.renameSync(from, to),
        copyFile: (from, to) => fs.copyFileSync(from, to),
        cp: (from, to, opts) => fs.cpSync(from, to, opts),
        rm: (p, opts) => fs.rmSync(p, opts),
    };
}
