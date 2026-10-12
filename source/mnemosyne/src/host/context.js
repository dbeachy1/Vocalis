import { normal } from '../logging.js';

import { AT_BOOT, AT_USE, CAPABILITIES } from './capabilities.js';

/**
 * `ForkContext` with the optionality taken off — for the ONE line after a guard has established the member.
 *
 * 🔴 **THIS IS NOT A CLAIM THAT ANY FORK HAS ALL OF IT. It is the opposite claim, written down.** Every member
 * of `ForkContext` is optional because "does this fork have X?" has a different answer per install, and
 * {@link HostContext#has} is what answers it — a `Set` lookup by string, filled by {@link HostContext.#detect}
 * looking members up by name at construction. TypeScript cannot see through either, so a guarded pass-through
 * below restates its own guard as a cast.
 *
 * ⚠️ **A cast of this type that is not directly underneath the guard that earns it is a lie**, and it is the
 * exact lie `capabilities.js` was built to end: the checker will stay green while the call throws on a fork
 * that does not have the method. Keep them adjacent, and where a pass-through has no guard of its own, say in
 * prose which caller's check it is leaning on — or that it is simply assumed present, and what breaks if not.
 *
 * @typedef {Required<ForkContext>} PresentForkContext
 */

/**
 * The fork, as Mnemosyne is allowed to see it.
 *
 * Everything Mnemosyne knows about SillyTavern arrives through the `context` the fork hands `init`. This class
 * wraps it once, decides at construction what this particular fork can do, and hands out pass-throughs that
 * already know their own guard. Call sites stop asking `typeof context.x === 'function'` and stop remembering
 * which capability needs an `apiVersion` check as well.
 *
 * ## 🔴 Why an adapter, and why this one is worth its weight
 *
 * The fork is the fastest-moving thing this plugin depends on — nine capabilities so far, several landing
 * days apart, each with a different degradation. `capabilities.js` says why that made a table necessary. This
 * class is the other half: **detection happens once, in one place, and the answer is a value rather than a
 * check scattered through the codebase.**
 *
 * ⚠️ **It is duck-type compatible with the raw context on purpose.** Every method the plugin uses is exposed
 * under the same name with the same signature, so a `HostContext` can be passed anywhere a raw context was —
 * which is what let this land without rewriting every function signature in `ingest.js`. {@link HostContext.from}
 * makes that idempotent, so a module can accept either and normalize, and the tests that build a bare fake
 * context keep working unchanged.
 *
 * ## What this class must never become
 *
 * 🔴 **No policy.** It answers *can the fork do X* and *do X*. It does not decide whether Mnemosyne wants to —
 * that judgment stays at the call site, because it is a memory judgment, which is precisely the class of
 * decision the fork refuses to make for us (§18.3, §20.1, §22.4) and is not one to hide in an adapter either.
 * The `genType` policy, the tier classification, the retrieval scoping: none of them belong here.
 *
 * 🔴 **No caching of anything user-shaped.** Capability detection is about the *fork* and is the same for
 * every user, which is why doing it once at boot is safe. A key, a handle, a store or a derived subkey must
 * never be held here — `index.js`'s "ask late, not at module scope" rule applies to this object exactly as it
 * applies to everything else that lives beyond one request.
 */
export class HostContext {
    /**
     * @param {ForkContext|null|undefined} raw The fork's plugin context. ⚠️ Nullable because it genuinely
     *        arrives that way: stock SillyTavern calls `init(router)` with no second argument at all, and the
     *        `?? {}` below is what makes such a host detect as a fork with zero capabilities rather than throw
     *        during construction. `index.js` refuses to start on it separately, and says so out loud.
     * @param {{ classifiedLogging?: boolean }} [detected] Answers computed elsewhere and handed in rather than
     *        recomputed. `classifiedLogging` is `adoptLogger`'s verdict — see {@link HostContext#has}.
     */
    constructor(raw, { classifiedLogging = false } = {}) {
        /** 🔴 The raw context. Reachable, because a pass-through cannot be written for a capability nobody has
         *  needed yet — but reaching for it is the signal that a row is missing from `capabilities.js`.
         *  @type {ForkContext} */
        this.raw = raw ?? {};

        /**
         * The fork's monotonic API version, or 0 for a fork that predates the notion (fork §26.7).
         * `Number(undefined)` is `NaN` and every `NaN >= n` is false, so the `?? 0` is what makes an absent
         * version read as "older than everything" rather than as a comparison that silently fails closed by
         * accident.
         */
        this.apiVersion = Number(this.raw.apiVersion ?? 0) || 0;

        /** @type {Set<string>} */
        this.present = new Set();

        for (const cap of CAPABILITIES) {
            if (this.#detect(cap, classifiedLogging)) {
                this.present.add(cap.name);
            }
        }
    }

    /**
     * Normalize to a `HostContext`, whether given one or a raw context.
     *
     * Idempotent, so a module can accept either and not care which it got. That is what lets `ingest.js` keep
     * taking a `context` parameter — `init` passes the wrapper, a test passes a bare object literal, and both
     * arrive here as the same thing.
     *
     * @param {HostContext|ForkContext|null|undefined} context
     * @returns {HostContext}
     */
    static from(context) {
        return context instanceof HostContext ? context : new HostContext(context);
    }

    /**
     * Is one capability usable on this fork?
     *
     * Three kinds, and the distinction is load-bearing rather than bookkeeping — see `capabilities.js`:
     * a `method` must exist; a `version` capability is a parameter the fork only honors from some
     * `apiVersion`; an `external` one was decided elsewhere and handed to the constructor.
     *
     * 🔴 `minApiVersion` composes with the method check rather than replacing it. `notify` needs both, because
     * a loader can carry the method without the contract behind it.
     *
     * @param {{ name: string, kind: string, minApiVersion: number|null }} cap
     * @param {boolean} classifiedLogging
     * @returns {boolean}
     */
    #detect(cap, classifiedLogging) {
        if (cap.minApiVersion !== null && this.apiVersion < cap.minApiVersion) {
            return false;
        }

        if (cap.kind === 'version') {
            return true;                                       // the version gate above is the whole test
        }

        if (cap.kind === 'external') {
            // 🔴 Handed in, never recomputed. `adoptLogger` checks four methods and both class values, and it
            // is the thing that actually adopts the channel — so asking a second question here, in slightly
            // different words, would create a way for "we report the logger as present" and "we are actually
            // using it" to disagree. One source of truth, and it is the one that does the work.
            return classifiedLogging;
        }

        return typeof this.raw[cap.name] === 'function';
    }

    /**
     * Can this fork do the named thing?
     * @param {string} name A `capabilities.js` row name
     * @returns {boolean}
     */
    has(name) {
        return this.present.has(name);
    }

    /**
     * Say what this fork can and cannot do, once, at boot.
     *
     * 🔴 **This is the line that did not exist before, and it is the reason the table does.** Previously an
     * operator learned about missing capabilities piecemeal, in whatever order `init` happened to touch them,
     * and only for the four that bothered to warn. the host runs a fork predating five of them; "which of these do
     * I have?" was a question with no answer short of reading the source of both projects.
     *
     * Every absent capability that costs something says so in its own words (`capabilities.js` `absence`),
     * because a generic "capability X missing" tells an operator nothing about whether to care.
     *
     * ⚠️ Must run AFTER `adoptLogger`, or the whole report is classified SENSITIVE and suppressed on a default
     * install — which would make the one diagnostic about a degraded fork invisible on exactly the installs
     * that are degraded. `init` orders these two adjacently for that reason.
     *
     * @returns {void}
     */
    announce() {
        const missing = CAPABILITIES.filter(cap => !this.has(cap.name));

        // The positive half is a plain list of names and section numbers — fixed strings from the table, no
        // user-authored value anywhere, so it survives on a default install where it is worth something.
        normal().info(
            '[Mnemosyne] Fork capabilities: %d of %d present (apiVersion %d). Present: %s.',
            CAPABILITIES.length - missing.length,
            CAPABILITIES.length,
            this.apiVersion,
            CAPABILITIES.filter(cap => this.has(cap.name)).map(cap => cap.name).join(', ') || 'none',
        );

        for (const cap of missing) {
            if (cap.report === AT_BOOT && cap.absence) {
                normal().warn(cap.absence);
            }
        }
    }

    /**
     * The `absence` message for a capability reported at its point of use rather than at boot.
     *
     * Exists so the *text* still lives in the table while *when it is said* stays with the caller — see
     * `readBaseline`, which reports per user through ingest's say-once channel because the cost is only paid
     * by an install that actually extracts.
     *
     * @param {string} name
     * @returns {string} the message, or '' if this capability has none
     */
    absenceOf(name) {
        const cap = CAPABILITIES.find(c => c.name === name);
        return (cap?.report === AT_USE && cap.absence) || '';
    }

    // ---------------------------------------------------------------------------------------------------
    // Pass-throughs. Each is the fork's method under the fork's name, so a HostContext can stand in for a raw
    // context. Guarded ones return a neutral value rather than throwing: an older fork degrades, never dies.
    // ---------------------------------------------------------------------------------------------------

    /**
     * Embed an ARRAY of texts. 🔴 Never a bare string — the fork takes an array and returns {vectors, model}.
     *
     * 🔴 Throws a NAMED error on a fork that has no `embed`, rather than the bare
     * `TypeError: this.raw.embed is not a function` an unguarded pass-through produced. Both are caught by the
     * caller and both suppress their detail on a default install, so the difference is not what the operator
     * reads — it is that the boot report now states the same fact once, permanently, in `capabilities.js`.
     *
     * 🔴 `model` comes back WITH the vectors and is the only thing that knows which model this install uses
     * (fork §13.3). It is `string|null`, and the null is not decoration: `retrieve` declines the turn on it
     * rather than filing vectors under a name it guessed.
     *
     * @param {Parameters<PresentForkContext['embed']>[0]} texts
     * @returns {ReturnType<PresentForkContext['embed']>}
     */
    embed(texts) {
        if (!this.has('embed')) {
            throw new Error('This fork has no context.embed, so nothing can be embedded. See the boot report.');
        }

        return /** @type {PresentForkContext} */ (this.raw).embed(texts);
    }

    /**
     * Run a generation on the user's own backend (the extraction call, and the uncertain-band confirm).
     *
     * 🔴 Guarded for the reason `capabilities.js` gives at length: this was an unguarded pass-through with no
     * row in the table at all, so on a fork without `generate` every ingest pass that cleared the trigger gate
     * threw `this.raw.generate is not a function`, was caught, and reported as "Details suppressed." Automatic
     * memory never worked and the boot report never mentioned the reason.
     *
     * ⚠️ `spec.grammar` is in the declared shape but is honored only from `apiVersion >= 3`; an older fork
     * ignores the key silently, which is why `grammar` has a `kind: 'version'` row of its own rather than
     * riding on this method's presence. Passing it unguarded type-checks and does nothing — ask `has('grammar')`.
     *
     * @param {Parameters<PresentForkContext['generate']>[0]} spec
     * @returns {ReturnType<PresentForkContext['generate']>}
     */
    generate(spec) {
        if (!this.has('generate')) {
            throw new Error('This fork has no context.generate, so extraction cannot run. See the boot report.');
        }

        return /** @type {PresentForkContext} */ (this.raw).generate(spec);
    }

    /**
     * A character card's decrypted bytes, by the fork's minted id — never by name, never by filename (§25).
     *
     * 🔴 `null` and a throw are DIFFERENT ANSWERS and the caller must keep them apart: `null` means the id
     * names no card, which is ordinary after a delete. Everything else throws, **a locked vault included** —
     * reading "locked" as "no card" would extract a baseline of nothing and never learn it had been wrong.
     *
     * ⚠️ **UNGUARDED HERE, AND GUARDED ONE LEVEL UP INSTEAD.** The capability is `report: AT_USE` rather than
     * `AT_BOOT` — an install that never extracts never pays for its absence — so the check lives with the only
     * caller, `readBaseline` in ingest/baseline.js, which asks `has('readCharacterCard')`, reports
     * `absenceOf(...)` once per user and extracts without a baseline. The cast below is earned by that check
     * and by nothing in this method. 🔴 A second caller without one turns it back into
     * `readCharacterCard is not a function`; if one ever appears, the guard belongs here.
     *
     * @param {Parameters<PresentForkContext['readCharacterCard']>[0]} handle
     * @param {Parameters<PresentForkContext['readCharacterCard']>[1]} charId
     * @returns {ReturnType<PresentForkContext['readCharacterCard']>}
     */
    readCharacterCard(handle, charId) {
        return /** @type {PresentForkContext} */ (this.raw).readCharacterCard(handle, charId);
    }

    /**
     * A chat's core turns, read from disk now rather than delivered with a generation (fork §29).
     *
     * 🔴 Guarded HERE, unlike `readCharacterCard`: the Rescan route is a user's click, and a fork without the
     * method must answer that click with a sentence, not a `TypeError`. `null` still means "no such chat" and
     * every other failure — a locked vault above all — still throws, straight from the fork.
     *
     * @param {Parameters<PresentForkContext['readChat']>[0]} handle
     * @param {Parameters<PresentForkContext['readChat']>[1]} chatId
     * @param {Parameters<PresentForkContext['readChat']>[2]} [options]
     * @returns {ReturnType<PresentForkContext['readChat']>}
     */
    readChat(handle, chatId, options) {
        if (!this.has('readChat')) {
            throw new Error('This fork cannot read a chat on demand (plugin API 7, context.readChat), so a rescan cannot run. Update the fork.');
        }

        return /** @type {PresentForkContext} */ (this.raw).readChat(handle, chatId, options);
    }

    /**
     * Push a UI notification, or do nothing on a fork that cannot hear it.
     *
     * ⚠️ `spec.chatId` is `string|undefined` and NOT `string|null` — the fork validates the field it is given,
     * and a null there is not a chat id. `activity.js` omits the key rather than sending null for exactly that
     * reason; the type is what stops the shortcut.
     *
     * @param {Parameters<PresentForkContext['notify']>[0]} spec
     * @returns {boolean} whether it went
     */
    notify(spec) {
        if (!this.has('notify')) {
            return false;
        }
        /** @type {PresentForkContext} */ (this.raw).notify(spec);
        return true;
    }

    /**
     * Whether a storage provider that can derive keys is installed for this user. 🔴 NOT `ownsUser` — see openFor.
     *
     * ⚠️ UNGUARDED AND ASSUMED PRESENT. It has no `capabilities.js` row at all, so a fork without it throws
     * `hasSecureStorage is not a function` out of `openFor` — which is the storage-provider API this plugin
     * cannot degrade past anyway. The cast says "assumed", not "checked".
     *
     * @param {Parameters<PresentForkContext['hasSecureStorage']>[0]} handle
     * @returns {boolean}
     */
    hasSecureStorage(handle) {
        return /** @type {PresentForkContext} */ (this.raw).hasSecureStorage(handle);
    }

    /**
     * Derive our database subkey. 🔴 ASK LATE — only ever valid in the moment after a user unlocks.
     *
     * 🔴 `null` is a real answer and never an error: it means there is no key material to derive from right
     * now. ⚠️ Unguarded and assumed present, for the same reason as `hasSecureStorage` above.
     *
     * @param {Parameters<PresentForkContext['deriveSubkey']>[0]} handle
     * @param {Parameters<PresentForkContext['deriveSubkey']>[1]} label The fork calls this `info` — a
     *        domain-separation label, ours to choose. See `SUBKEY_LABEL` in session.js.
     * @param {Parameters<PresentForkContext['deriveSubkey']>[2]} bytes
     * @returns {Buffer|null}
     */
    deriveSubkey(handle, label, bytes) {
        return /** @type {PresentForkContext} */ (this.raw).deriveSubkey(handle, label, bytes);
    }

    /**
     * The user's own directory root — where the file goes, never whether we may open it.
     *
     * ⚠️ Unguarded and assumed present, like `hasSecureStorage`.
     *
     * @param {Parameters<PresentForkContext['userDirectory']>[0]} handle
     * @returns {string}
     */
    userDirectory(handle) {
        return /** @type {PresentForkContext} */ (this.raw).userDirectory(handle);
    }

    /**
     * Declare `memory/` as ours and already encrypted.
     *
     * ⚠️ UNGUARDED HERE even though it HAS a `capabilities.js` row (`report: AT_BOOT`): `declareForeignStore`
     * in session.js asks `has('registerForeignStore')` and returns before reaching this, so the cast is earned
     * there. Its `try` is for a provider that throws, not for a fork that has no method.
     *
     * @param {Parameters<PresentForkContext['registerForeignStore']>[0]} declaration
     * @returns {boolean} whether a provider took it
     */
    registerForeignStore(declaration) {
        return /** @type {PresentForkContext} */ (this.raw).registerForeignStore(declaration);
    }

    /**
     * Register the UI panel button, or do nothing on a fork with no panel support.
     *
     * ⚠️ `stylesheetPath` (fork §10.3) reaches the fork through here, and it was briefly the one field this
     * file knew about and `types/fork-host.d.ts` did not — because the fork's own `plugin-loader.js:811` JSDoc
     * was never updated for §10.3, and that block is what the declaration was first read off. It is honored:
     * `SillyTavern/src/plugin-panels.js:127` reads it and mints `entry.stylesheetUrl`. The declaration carries
     * it now, so the local intersection that used to sit on this `@param` is gone. **When two places in the
     * fork disagree, the one that CONSUMES the field wins.**
     *
     * @param {Parameters<PresentForkContext['registerPanel']>[0]} spec
     * @returns {void}
     */
    registerPanel(spec) {
        if (!this.has('registerPanel')) {
            return;
        }
        /** @type {PresentForkContext} */ (this.raw).registerPanel(spec);
    }

    /**
     * Register the settings screen in the Extensions dialog, or do nothing on a fork with no §28.
     *
     * 🔴 SEPARATE FROM {@link registerPanel} AND DELIBERATELY SO. The fork made the two independent, and this
     * plugin uses both: the same `/panel?view=settings` route is reached from the panel's own settings button
     * and from the Extensions dialog. **One route, two hosts** — a settings form implemented twice would
     * drift, and the drift is silent.
     *
     * ⚠️ Guarded is not safe. On a fork that HAS it, the spec is validated and a bad field throws, exactly as
     * `registerPanel` does — which is why {@link module:index~init} calls both before it takes on any handler
     * it cannot take back.
     *
     * @param {Parameters<PresentForkContext['registerSettings']>[0]} spec
     * @returns {void}
     */
    registerSettings(spec) {
        if (!this.has('registerSettings')) {
            return;
        }
        /** @type {PresentForkContext} */ (this.raw).registerSettings(spec);
    }

    /**
     * Subscribe to outgoing prompts. The second argument declares the window ingest needs — never omit it.
     *
     * 🔴 `options` is typed optional because the fork's signature says so, and that is precisely the trap: omit
     * it and `recentMessages` is `undefined` on every call, for ever, silently. See `registerInterceptor` in
     * index.js for what both keys buy. ⚠️ Unguarded and assumed present — a fork with no `onPrompt` is a fork
     * on which Mnemosyne can do nothing at all, so there is no degradation to describe.
     *
     * @param {Parameters<PresentForkContext['onPrompt']>[0]} handler
     * @param {Parameters<PresentForkContext['onPrompt']>[1]} [options]
     * @returns {void}
     */
    onPrompt(handler, options) {
        return /** @type {PresentForkContext} */ (this.raw).onPrompt(handler, options);
    }

    /**
     * A user's vault opened.
     *
     * ⚠️ Unguarded and assumed present: without it no store is ever opened and the plugin is inert.
     *
     * @param {Parameters<PresentForkContext['onStorageReady']>[0]} handler
     * @returns {void}
     */
    onStorageReady(handler) {
        return /** @type {PresentForkContext} */ (this.raw).onStorageReady(handler);
    }

    /**
     * A user's vault shut. 🔒 Where NFR1 is kept.
     *
     * ⚠️ Unguarded and assumed present — and this is the one whose absence is a *promise* broken rather than a
     * feature missing: memory that never closes is memory that outlives the vault.
     *
     * @param {Parameters<PresentForkContext['onStorageLock']>[0]} handler
     * @returns {void}
     */
    onStorageLock(handler) {
        return /** @type {PresentForkContext} */ (this.raw).onStorageLock(handler);
    }

    /**
     * A chat was deleted, or nothing on a fork without the signal.
     *
     * @param {Parameters<PresentForkContext['onChatDeleted']>[0]} handler
     * @returns {boolean} whether it subscribed
     */
    onChatDeleted(handler) {
        if (!this.has('onChatDeleted')) {
            return false;
        }
        /** @type {PresentForkContext} */ (this.raw).onChatDeleted(handler);
        return true;
    }

    /**
     * A chat was renamed, or nothing on a fork without the signal.
     *
     * @param {Parameters<PresentForkContext['onChatRenamed']>[0]} handler
     * @returns {boolean} whether it subscribed
     */
    onChatRenamed(handler) {
        if (!this.has('onChatRenamed')) {
            return false;
        }
        /** @type {PresentForkContext} */ (this.raw).onChatRenamed(handler);
        return true;
    }
}
