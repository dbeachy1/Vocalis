import fs from 'node:fs';
import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT DOES NOTHING EXCEPT WRITE DOWN WHAT IT WAS HANDED.
 *
 * The fork now passes a context object as the second argument to a plugin's `init`. A context that is never
 * delivered is indistinguishable from one that works — the plugin simply reads `undefined`, does nothing, and
 * says nothing. That is exactly how `storage.multerStorage()` stayed dead for the entire life of the feature
 * while every upload staged in the clear.
 *
 * So this plugin asserts nothing and decides nothing. It records, into a journal file, precisely what arrived.
 * The test reads the journal. Before asking "does the context work", ask "did the context turn up at all".
 */

/** Where the journal goes. Set by the test, across the process boundary, because plugins run in the child. */
const journalPath = process.env.ST_PLUGIN_JOURNAL ?? '';

/** The only user any of these tests has. */
const HANDLE = 'default-user';

/** What the interceptor puts into the prompt. The test looks for this arriving at the backend. */
const INJECTED = '[[MEMORY-INJECTED-BY-PLUGIN]] ';

/**
 * A derived key, held across requests exactly as a real plugin would hold one — so that the lock handler
 * has something to actually drop, and the test can prove it was dropped rather than assume it.
 * @type {Buffer|null}
 */
let held = null;

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
 * Hex, or the word null. Never the key itself in a comparison — see `describeKey`.
 * @param {Buffer|null} key The key
 * @returns {string} Hex, or 'null'
 */
function hex(key) {
    return key ? Buffer.from(key).toString('hex') : 'null';
}

/**
 * Say what arrived WITHOUT writing key material into a file.
 *
 * ⛔ The journal is a plaintext file in a temp directory. A test fixture that prints real derived keys into
 * it is a test fixture that teaches everyone who copies it to leak keys. Length and shape are enough to
 * prove the seam works; the bytes themselves are only ever compared in-process.
 * @param {Buffer|null} key The key that came back
 * @returns {string} A description safe to write down
 */
function describeKey(key) {
    if (key === null) {
        return 'null';
    }

    return `${Buffer.isBuffer(key) ? 'Buffer' : typeof key}(${key.length})`;
}

export const info = {
    id: 'context-probe',
    name: 'Context Probe',
    description: 'Records what the fork hands a plugin at init. Test fixture; does nothing else.',
};

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The context the fork now provides
 * @returns {Promise<void>}
 */
export async function init(router, context) {
    // Another suite's shim may be sitting in the shared plugins/ directory while THIS suite's server boots
    // (see fixture-gate.mjs). Registering from here would rewrite that suite's prompts and fail its
    // assertions, so a fixture nobody asked for does nothing at all.
    if (!fixtureIsEnabled("context-probe")) {
        return;
    }
    journal(`init called with ${arguments.length} argument(s)`);
    journal(`router: ${typeof router}`);

    if (context === undefined) {
        // The whole point of the fixture. Say it loudly rather than quietly reading undefined.
        journal('context: MISSING');
        return;
    }

    journal(`context: ${typeof context}`);
    journal(`context.id: ${context.id}`);
    journal(`context keys: ${Object.keys(context).sort().join(',')}`);
    journal(`onStorageReady: ${typeof context.onStorageReady}`);

    // 🔴 A capability that cannot be called is not a capability. Registering must not throw, and must not
    // require a provider to be installed -- this fixture boots with none.
    try {
        context.onStorageReady(async () => { });
        journal('onStorageReady() registered without throwing');
    } catch (error) {
        journal(`onStorageReady() THREW: ${error.message}`);
    }

    // The provider object itself must never be reachable from here. If some future change puts it on the
    // context "for convenience", this line is what notices.
    journal(`provider reachable: ${'getStorageProvider' in context || 'provider' in context}`);

    // ⚠️ PRESENCE ONLY -- do NOT call embed() here. Five suites share this fixture, and the first embed loads
    // a real model from the network. The one suite that wants that cost has its own fixture.
    journal(`embed: ${typeof context.embed}`);
    journal(`userDirectory: ${typeof context.userDirectory}`);

    // Where this user's data lives. Cheap, keyless, and true before anyone logs in -- a path is not a key,
    // which is exactly why this one can be asked at init when deriveSubkey below cannot.
    journal(`init userDirectory: ${context.userDirectory(HANDLE)}`);

    // 🔴 A handle is joined onto a path. Something that climbs out of it must be refused rather than resolved.
    try {
        context.userDirectory('../../etc');
        journal('userDirectory traversal: ALLOWED');
    } catch {
        journal('userDirectory traversal: refused');
    }

    // ---------------------------------------------------------------------------------------------
    // The key capabilities, asked at INIT — when nobody has logged in and nothing is unlocked.
    // ---------------------------------------------------------------------------------------------

    // Whatever the answer, this is the moment a plugin is most likely to get it wrong: ask here, cache the
    // answer, and be wrong for the life of the process.
    journal(`init hasSecureStorage: ${context.hasSecureStorage(HANDLE)}`);
    journal(`init isStorageReady: ${context.isStorageReady(HANDLE)}`);
    journal(`init deriveSubkey: ${describeKey(context.deriveSubkey(HANDLE, 'probe-v1', 32))}`);

    // ---------------------------------------------------------------------------------------------
    // And again at UNLOCK, which is the only moment they can actually be true.
    // ---------------------------------------------------------------------------------------------

    context.onStorageReady(async (handle) => {
        journal(`ready fired for: ${handle}`);
        journal(`ready hasSecureStorage: ${context.hasSecureStorage(handle)}`);
        journal(`ready isStorageReady: ${context.isStorageReady(handle)}`);

        const first = context.deriveSubkey(handle, 'probe-v1', 32);
        const again = context.deriveSubkey(handle, 'probe-v1', 32);
        const other = context.deriveSubkey(handle, 'probe-v2', 32);
        const longer = context.deriveSubkey(handle, 'probe-v1', 64);

        journal(`ready deriveSubkey: ${describeKey(first)}`);

        // 🔴 A deriveSubkey that always returned null would pass every assertion that only checks for
        // absence. These are the ones that make it earn the pass.
        journal(`same label twice is stable: ${hex(first) === hex(again)}`);
        journal(`different label differs: ${hex(first) !== hex(other)}`);
        journal(`length honoured: ${longer?.length === 64}`);

        // Hold it, exactly as a plugin with an open keyed database would, so that the lock handler below
        // has something real to drop.
        held = first;
    });

    // 🔴 The generation interceptor. This is the capability the whole thing exists for: retrieval that
    // cannot reach the prompt is a database nobody reads.
    context.onPrompt(async (outgoing) => {
        journal(`prompt intercepted, backend: ${outgoing.backend}`);
        journal(`prompt handle: ${outgoing.handle}`);
        journal(`prompt apiType: ${outgoing.apiType}`);
        journal(`prompt budget: ${outgoing.budget}`);
        journal(`prompt is string: ${typeof outgoing.prompt === 'string'}`);
        journal(`prompt messages present: ${Array.isArray(outgoing.messages)}`);
        journal(`prompt charName: ${outgoing.charName}`);
        journal(`prompt chatId: ${outgoing.chatId}`);

        // 🔴 THE TWO FAMILIES ARE DIFFERENT IN KIND, and a plugin must answer in the shape it was asked.
        // Return the wrong one and the fork refuses it -- deliberately, because handing a string to the
        // vendor converters would fail a very long way from here.
        if (Array.isArray(outgoing.messages)) {
            journal(`prompt saw messages: ${JSON.stringify(outgoing.messages)}`);
            return [{ role: 'system', content: INJECTED.trim() }, ...outgoing.messages];
        }

        journal(`prompt saw: ${JSON.stringify(outgoing.prompt)}`);
        return `${INJECTED}${outgoing.prompt}`;
    });

    context.onStorageLock(async (handle) => {
        journal(`lock fired for: ${handle}`);

        // The state a plugin must be able to reach on lock, and the whole reason the notification exists.
        journal(`lock had a key to drop: ${held !== null}`);
        held = null;

        // 🔒 THE POINT OF ALL THIS. By the time we are told, the vault is shut -- so asking again must give
        // nothing back. If this says otherwise, the key outlived the vault and NFR1 is a fiction.
        journal(`lock isStorageReady: ${context.isStorageReady(handle)}`);
        journal(`lock deriveSubkey: ${describeKey(context.deriveSubkey(handle, 'probe-v1', 32))}`);
    });
}
