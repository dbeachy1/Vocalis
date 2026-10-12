import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { describe, registerStorageProvider } from './storage.js';
import { loadProvenanceRegistry, recordProviderIdentity, registryPathFor, recordedProviderIds } from './storage-provenance.js';
import { serverDirectory } from './server-directory.js';
import { color, getConfigFilePath } from './util.js';
import { log, LogClass } from './logger.js';

/**
 * Loads storage providers.
 *
 * This is deliberately NOT `plugin-loader.js`, and storage providers are deliberately NOT ordinary
 * server plugins. Three reasons, and they all matter:
 *
 * 1. 🔴 BOOT ORDER. `loadPlugins()` runs at the end of boot, long after SillyTavern has already read
 *    and rewritten the user's chats, settings, secrets and stats. A provider registered there would
 *    be registered too late to have protected any of it. Storage providers load FIRST — immediately
 *    after the accounts store is up (so a provider can know who the users are) and before anything
 *    else touches a single byte of user data.
 *
 * 2. A storage provider is trusted with every byte of user data. Ordinary plugins live in a directory
 *    that SillyTavern `git pull`s on every boot (`plugin-loader.js`, `enableServerPluginsAutoUpdate`).
 *    Keeping storage providers out of that directory is worth the extra concept.
 *
 * 3. `enableServerPlugins` (default false) must not gate storage. If a provider is installed, the
 *    user's data is behind it, and booting without it would be booting without their data.
 *
 * With no provider installed, this does nothing at all and SillyTavern is byte-for-byte its usual self.
 */

/**
 * Load and register a storage provider from a directory, if one is installed.
 *
 * At most one provider may be registered, so at most one may be installed. A provider module's default
 * export is a factory returning the provider object.
 * @param {string} providersPath Path to the storage providers directory
 * @param {import('./storage.js').StorageProviderEnvironment} environment What the provider is being asked
 * to serve. The logging channel is added here, so callers do not assemble it — see {@link loadStorageProviders}.
 * @returns {Promise<void>}
 */
/**
 * 🔴 SAY SO WHEN A PROVIDER THAT ONCE RAN IS NO LONGER THERE.
 *
 * The two early returns below are the ONLY non-fatal paths in this loader, and they produce the same end
 * state as the fatal ones: a stock SillyTavern running over a data root full of data it cannot read. Every
 * other failure — a bad import, a non-function factory, a rejected registration, an `init()` refusal — kills
 * the boot on purpose, because booting without a provider whose data is behind it means the boot-time
 * maintenance tasks set about regenerating that data.
 *
 * These two said NOTHING. A mistyped `storageProvidersPath`, a failed plugin update, a renamed directory: the
 * install boots clean, login succeeds (`ownsUser` is false, so nothing tries to unlock), old chats render as
 * §11 dead rows WITH A PLAUSIBLE EXPLANATION, and everything written from then on is written in the clear
 * into the provider's own tree. The registry is loaded above these returns for precisely this case, and
 * then nothing consulted it.
 *
 * ⚠️ A WARNING, NOT A REFUSAL. Uninstalling a provider is a thing a user is allowed to do, and §11 exists to
 * make that state navigable rather than fatal. What is not allowed is doing it silently.
 * @returns {void}
 */
function warnIfAProviderIsMissing() {
    const recorded = recordedProviderIds();

    if (recorded.length === 0) {
        return;
    }

    log.warn(LogClass.NORMAL, color.yellow('No storage provider is installed, but this instance has run one before:'), recorded.join(', '));
    log.warn(LogClass.NORMAL, color.yellow('Data written by it cannot be read, and anything saved from now on will be written without it.'));
}

export async function loadStorageProviders(providersPath, environment) {
    const requiredProviderId = environment?.requiredProviderId;

    // 🔴 THE REGISTRY LOADS ABOVE EVERY EARLY RETURN, AND THAT IS THE WHOLE POINT OF IT.
    //
    // `DESIGN_STORAGE_PROVENANCE.md` §5. The case the registry exists to serve is *the provider is not
    // installed any more* — which is exactly the case where the two returns below fire and nothing else in
    // this function runs. Loading it after them would produce a registry that is populated only when it is
    // not needed and empty whenever it is, and the symptom would be silent: the bare-id sentence, which is
    // also the correct output for a fork that has no registry at all.
    try {
        // Beside `config.yaml` — the trust class §5 asks for — and only falling back to the server
        // directory when nothing has set a config path, which is the CLI and test case.
        const configPath = getConfigFilePath();
        const trustedRoot = configPath ? path.dirname(configPath) : serverDirectory;

        loadProvenanceRegistry(registryPathFor(trustedRoot, environment?.dataRoot));
    } catch (error) {
        // `registryPathFor` refuses a path inside the data root, and that refusal must not stop a boot. A
        // fork with no registry draws the sentences it drew before the registry existed.
        log.warn(LogClass.NORMAL, 'The storage provenance registry could not be located, so provider names will not be remembered.');
        log.warn(LogClass.SENSITIVE, 'Provenance registry path was refused:', error);
    }

    if (!fs.existsSync(providersPath)) {
        if (requiredProviderId) {
            throw new Error(`Required storage provider '${requiredProviderId}' is missing: ${providersPath} does not exist.`);
        }
        warnIfAProviderIsMissing();
        return;
    }

    const entries = fs.readdirSync(providersPath).filter(file => isModule(file) || fs.statSync(path.join(providersPath, file)).isDirectory());

    if (entries.length === 0) {
        if (requiredProviderId) {
            throw new Error(`Required storage provider '${requiredProviderId}' is missing: ${providersPath} is empty.`);
        }
        warnIfAProviderIsMissing();
        return;
    }

    if (entries.length > 1) {
        throw new Error(`Only one storage provider may be installed, but ${entries.length} were found in ${providersPath}: ${entries.join(', ')}. Remove all but one.`);
    }

    const providerPath = resolveEntryPoint(path.join(providersPath, entries[0]));

    // 🔴 A failure here is FATAL, and deliberately so. If a provider is installed, the user's data is
    // behind it. Booting without it would mean booting with the user's data unreadable — and then
    // SillyTavern's boot-time maintenance tasks would set about "helpfully" regenerating all of it.
    // Refuse to start instead.
    const module = await import(url.pathToFileURL(providerPath).toString());
    const factory = module.default;

    if (typeof factory !== 'function') {
        throw new Error(`Storage provider at ${providerPath} must default-export a factory function.`);
    }

    const provider = await factory();

    if (requiredProviderId && provider?.id !== requiredProviderId) {
        throw new Error(`Required storage provider '${requiredProviderId}', but '${provider?.id ?? 'unknown'}' was loaded from ${providerPath}.`);
    }

    registerStorageProvider(provider);

    // 🔴 THE LOGGING CHANNEL IS ADDED HERE, NOT BY THE CALLERS, AND THAT IS DELIBERATE.
    //
    // Two entry points assemble an environment and load a provider — `server-main.js` at boot and
    // `recover-password.js` for the CLI — and they assemble it independently. Adding `logger` at both call
    // sites would be the same two lines written twice, and the recovery path is exactly the one nobody
    // would remember to update. A provider that has a logger on one path and not the other is
    // indistinguishable, from the inside, from one whose lines are all being suppressed.
    //
    // Why a provider needs this at all: `installConsoleSeam()` rewrites `console.*` to
    // `log.*(LogClass.SENSITIVE, …)` before any provider loads, and the writer replaces every SENSITIVE
    // line with a stub unless `logging.debugMode` is on. So without this, EVERY line a provider prints is
    // suppressed on a default install and it has no way to say otherwise — including the one warning that
    // matters most, that a user's data is unrecoverable. This is the opt-in, and like the plugin channel
    // it is opt-in PER CALL SITE: bare `console.*` still resolves to SENSITIVE.
    //
    // ⚠️ RE-EXPORTED UNCHANGED, NEVER WRAPPED — and that applies on the provider's side too. `record()`
    // passes the public method itself to `Error.captureStackTrace` under `Error.stackTraceLimit = 1`, so
    // exactly one frame survives. A wrapping arrow function *becomes* that frame, and every suppressed
    // line in the provider would then name this file instead of the site that wrote it. `.bind()` adds no
    // V8 frame and is safe.
    //
    // ⚠️ `log` IS THE LIVE SINGLETON AND IT IS NOT FROZEN. A provider that assigns to it — say
    // `ctx.logger.info = ctx.logger.info.bind(null, ctx.LogClass.NORMAL)` as a shorthand — re-points the
    // logger the whole server uses, and every internal SENSITIVE-classed `info` call then evaluates as
    // `info(NORMAL, SENSITIVE, …)` and PUBLISHES. It cannot be frozen here: `logger.test.js` and
    // `util.test.js` spy on these methods, and `jest.spyOn` on a frozen object throws. Providers are
    // trusted with every byte of user data, so this is a footgun and not a boundary — but say so, because
    // binding onto the context is the obvious way to write the shorthand.
    //
    // 🔴 And a failure in init() is fatal for the same reason registration is: a provider that says it
    // cannot serve this configuration is telling you that booting anyway means booting over the top of
    // the user's data.
    await provider.init({ ...environment, logger: log, LogClass });

    // 🪪 RECORD WHO THIS IS, WHILE IT IS STILL HERE TO ASK (`DESIGN_STORAGE_PROVENANCE.md` §4, §5).
    //
    // The provider id on a file is untrusted — it lives outside the crypto, so anyone who can write to the
    // data directory can set it to anything. A RUNNING provider is a different matter: it is already
    // executing in this process, and a hostile plugin does not need to lie about its name to hurt you. So
    // identity is taken now, while it can be trusted, and looked up later when the plugin is gone and the
    // only thing left is a slug in a header.
    //
    // ⚠️ AFTER `init()`, NEVER BEFORE. A provider that refuses this configuration throws out of `init` and
    // the boot ends; recording it above that line would enter a provider into the record of "what this
    // instance has run" on the strength of a load that did not survive.
    recordProviderIdentity(provider.id, describe('storage.identity'));

    log.info(LogClass.NORMAL, color.green(`Storage provider '${provider.id}' registered. All user data is served through it.`));
}

/**
 * Is this file a JavaScript module we can import?
 * @param {string} file File name
 * @returns {boolean} True if importable
 */
function isModule(file) {
    return ['.js', '.mjs', '.cjs'].includes(path.extname(file));
}

/**
 * Resolve a provider entry point — either the file itself, or a directory's index/main.
 * @param {string} providerPath Path to a provider file or directory
 * @returns {string} Path to the module to import
 */
function resolveEntryPoint(providerPath) {
    if (!fs.statSync(providerPath).isDirectory()) {
        return providerPath;
    }

    const packagePath = path.join(providerPath, 'package.json');

    if (fs.existsSync(packagePath)) {
        const main = JSON.parse(fs.readFileSync(packagePath, 'utf-8'))?.main;

        if (main) {
            return path.join(providerPath, main);
        }
    }

    const index = ['index.js', 'index.mjs', 'index.cjs'].map(f => path.join(providerPath, f)).find(f => fs.existsSync(f));

    if (!index) {
        throw new Error(`Storage provider at ${providerPath} has no entry point (no package.json "main", no index.js).`);
    }

    return index;
}
