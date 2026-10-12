/**
 * Everything Mnemosyne asks of the fork, in one table.
 *
 * 🔴 **THIS FILE EXISTS TO ANSWER ONE QUESTION: "what can this fork do?"** Before it, that question had no
 * answer anywhere. Nine capabilities were guarded across four modules in five different idioms — a six-way
 * `typeof` chain in `logging.js`, a bare `typeof` with a warning in `index.js`, a `typeof` **and** an
 * `apiVersion` comparison in `activity.js`, a `reportOnce` in `ingest.js`, a silent version check in the
 * middle of the extraction call — and the only way to learn what an install supported was to read all four
 * modules and reconstruct it.
 *
 * That mattered more here than tidiness usually does, because **the whole point of every guard is that its
 * absence is invisible.** `index.js`'s header names the two failures this plugin exists to make loud, and
 * both are silent by nature. Adding a capability used to mean remembering, unprompted, to guard it, choose a
 * degradation, write a warning in the right voice, and split that warning correctly across NORMAL and
 * SENSITIVE. Four chances to forget. Now it is a row.
 *
 * ## Adding a capability
 *
 * Add a row. `HostContext` picks up detection, the boot report and the pass-through automatically. The row is
 * also the documentation: `absence` is what an operator reads when their fork is too old, so write it as the
 * *consequence* ("memories from deleted chats accumulate on disk for ever"), never as the symptom ("method
 * missing").
 *
 * ## 🔴 `absence` is a NORMAL-channel string and must stay one
 *
 * These messages are published on a default install (`logging.js`), so every one of them must be free of
 * user-authored values — no handle, no chat id, no character name, no path. They are fixed prose about a
 * fork, identical for every user on the install, which is exactly what makes them safe to publish and
 * genuinely actionable without naming anybody. **There is deliberately no way to interpolate a value into
 * one.** If a future capability's absence can only be explained by naming something a user typed, that is a
 * `sensitive()` line at the call site, not a row here.
 *
 * ⚠️ Several of these strings are asserted verbatim by `tests/plugin.test.js`. That is not incidental
 * coupling to be refactored away — the tests are checking that a fork missing a capability is *told what it
 * costs*, which is the entire feature. Rewording is fine; deleting the consequence is not.
 */

/**
 * When an absent capability is announced.
 *
 * - `'boot'` — said once, from `init`, as part of the startup report. Right for anything install-wide whose
 *   absence is a permanent property of the fork.
 * - `'use'` — said by the call site, once per user, when the capability is first wanted. Right only where the
 *   boot report would be misleading: `readCharacterCard` costs nothing on an install that never runs an
 *   extraction, and announcing it at boot would report a degradation that may never occur.
 * - `'silent'` — no message. Right where the degradation is genuinely invisible *and* harmless: no panel
 *   button, no push notification. Nothing is lost that an operator could act on.
 */
export const AT_BOOT = 'boot';
export const AT_USE = 'use';
export const SILENT = 'silent';

/**
 * The capabilities, in the order the boot report says them.
 *
 * `kind`:
 *   - `'method'`  — present when the context exposes a function of this name.
 *   - `'version'` — not a method at all, but a *parameter* the fork only honors from some `apiVersion`. The
 *     grammar on the extraction call is the case: an older fork ignores an unknown `grammar` key silently, so
 *     the gate keeps the request byte-identical there rather than relying on that.
 *   - `'external'`— detected elsewhere and reported here. `logger` is the only one: `adoptLogger` owns the
 *     adoption because it must run before anything can log, and its verdict is handed in rather than
 *     recomputed, so the two can never disagree about what "usable" means.
 *
 * `minApiVersion` composes with `kind: 'method'` — `notify` needs both the method AND `apiVersion >= 2`,
 * because a loader can have the method without the contract.
 */
export const CAPABILITIES = Object.freeze([
    Object.freeze({
        name: 'logger',
        section: 'plugin API §23',
        kind: 'external',
        minApiVersion: null,
        report: AT_BOOT,
        absence:
            '[Mnemosyne] This fork has no context.logger (plugin API §23), so every line Mnemosyne writes is ' +
            'classified SENSITIVE and suppressed unless logging.debugMode is on. Memory still works; you just ' +
            'cannot watch it. Update the fork to fix it.',
    }),
    Object.freeze({
        name: 'registerForeignStore',
        section: 'storage provider API §11.1',
        kind: 'method',
        minApiVersion: null,
        report: AT_BOOT,
        absence:
            '[Mnemosyne] This fork has no context.registerForeignStore, so Mnemosyne cannot declare its ' +
            'memory/ directory as an encrypted foreign store. Memory still works, but any storage audit ' +
            'will report the memory database as PLAINTEXT on every run — it is encrypted, and the audit ' +
            'has no way to be told. Update the fork to fix it.',
    }),
    Object.freeze({
        name: 'onChatDeleted',
        section: 'plugin API §24',
        kind: 'method',
        minApiVersion: null,
        report: AT_BOOT,
        absence:
            '[Mnemosyne] This fork has no context.onChatDeleted (plugin API §24), so memories from deleted ' +
            'chats cannot be cleaned up and will accumulate on disk for ever. Memory still works. Update the ' +
            'fork to fix it.',
    }),
    Object.freeze({
        name: 'onChatRenamed',
        section: 'plugin API §24.4',
        kind: 'method',
        minApiVersion: null,
        report: AT_BOOT,
        absence:
            '[Mnemosyne] This fork has no context.onChatRenamed (plugin API §24.4), so renaming a chat will ' +
            'strand its memories: the conversation continues, and the character can no longer recall any of ' +
            'it. Memory still works otherwise. Update the fork to fix it.',
    }),
    Object.freeze({
        name: 'readCharacterCard',
        section: 'plugin API §25',
        kind: 'method',
        minApiVersion: null,
        // Per-user and per-use, not boot: an install that never runs an extraction never pays this cost, and
        // announcing it at boot would report a degradation that may never happen. See readBaseline.
        report: AT_USE,
        absence:
            '[Mnemosyne] ingest: this fork has no context.readCharacterCard, so extractions run without a ' +
            'character baseline. The first pass for each character will re-extract facts its card already ' +
            'states, and that first copy is permanent.',
    }),
    Object.freeze({
        name: 'embed',
        section: 'plugin API §13',
        kind: 'method',
        minApiVersion: null,
        // 🔴 WAS `SILENT`, ON A JUSTIFICATION THAT WAS NOT TRUE. The old note read "retrieval and ingest both
        // fail visibly and immediately without it" — they do not. Both wrap their work in a catch that logs
        // "Details suppressed." on the NORMAL channel and puts the reason on `sensitive()`, which is OFF on a
        // default install. So the actual experience was: memory never works, and the only published line says
        // nothing about why. A boot report is not a duplicate of that; it is the only statement of it.
        report: AT_BOOT,
        absence:
            '[Mnemosyne] This fork has no context.embed (plugin API §13), so nothing can be turned into a ' +
            'vector: no memory will ever be recalled and no memory will ever be stored. Mnemosyne is loaded ' +
            'but inert. Update the fork to fix it.',
    }),
    Object.freeze({
        // 🔴 THE CAPABILITY WITH NO ROW AT ALL, WHICH IS THE ONE FAILURE THIS TABLE EXISTS TO PREVENT.
        //
        // `context.generate` is among the newest fork capabilities — it landed alongside `readCharacterCard` —
        // and it had no entry here, while `HostContext#generate` was an unguarded pass-through. On a fork with
        // storage and logging but no `generate`, every ingest pass that cleared the trigger gate reached
        // `runExtraction`, called it, and died with `TypeError: this.raw.generate is not a function`, caught
        // and reported as "ingest declined after an error — Details suppressed."
        //
        // Automatic memory therefore never worked, for ever, and the boot report — whose entire purpose is to
        // answer "which of these do I have?" — listed every capability except the missing one.
        name: 'generate',
        section: 'plugin API §19',
        kind: 'method',
        minApiVersion: null,
        report: AT_BOOT,
        absence:
            '[Mnemosyne] This fork has no context.generate (plugin API §19), so nothing can run the extraction ' +
            'call: automatic ingest will never store a memory. Manual writes and recall still work. Update the ' +
            'fork to fix it.',
    }),
    Object.freeze({
        name: 'notify',
        section: 'plugin API §26 (capability 18)',
        kind: 'method',
        // 🔴 `>=` and not `===`: apiVersion is a monotonic integer (fork §26.7), so pinning an exact value
        // would break on the next addition the fork makes. A host with no apiVersion predates the notion
        // entirely and reads as 0.
        minApiVersion: 2,
        // Degrades to a button that never changes color. Nothing is lost and nothing is actionable.
        report: SILENT,
        absence: null,
    }),
    Object.freeze({
        name: 'registerPanel',
        section: 'plugin API capability 7',
        kind: 'method',
        minApiVersion: null,
        report: SILENT,
        absence: null,
    }),
    Object.freeze({
        name: 'registerSettings',
        section: 'plugin API §28',
        kind: 'method',
        // ⚠️ NO `minApiVersion`, EVEN THOUGH §28 ARRIVED WITH apiVersion 6. The method's presence is the
        // honest signal and the only one that cannot go stale: a fork that has it is a fork that shipped §28,
        // and pinning 6 here would add a second thing to remember on the next bump for no protection. The
        // `notify` row pins a version because a loader can carry that method without the contract; nothing
        // about a settings row degrades that way — the fork validates the spec at registration and either
        // draws the row or does not exist.
        minApiVersion: null,
        // Degrades to no settings row in the Extensions dialog. The in-panel settings button — the same route
        // — is still there, so nothing is unreachable and there is nothing for an operator to do.
        report: SILENT,
        absence: null,
    }),
    Object.freeze({
        name: 'readChat',
        section: 'plugin API §29',
        kind: 'method',
        // ⚠️ The method's presence is not enough on its own: §29 also added `sendDate` to every turn and made
        // `generate()` work from a panel request, and the Rescan button needs all three. apiVersion 7 is the
        // version that shipped them together.
        minApiVersion: 7,
        // Degrades to a Rescan button that says the fork is too old to read a chat. Automatic ingest is
        // untouched, so there is nothing to report at boot.
        report: SILENT,
        absence: null,
    }),
    Object.freeze({
        name: 'grammar',
        section: 'plugin API v3',
        // Not a method — a parameter on context.generate that only a v3 fork honors. See
        // buildExtractionGrammar: an older fork ignores an unknown `grammar` key, and gating on the version
        // keeps the request byte-identical there rather than depending on that.
        kind: 'version',
        minApiVersion: 3,
        report: SILENT,
        absence: null,
    }),
    Object.freeze({
        name: 'chatGenerate',
        section: 'plugin API v8',
        // Not a method either — `context.generate` exists from v1, but until apiVersion 8 it can only replay
        // a TEXT-completion connection: its chat route captured nothing, and `generate` refused every
        // api_type outside the OpenAI-completions family. Below 8, an ingest pass fired from a Chat
        // Completion generation would either throw on every turn or — worse — extract against whatever
        // text backend this user last used, which is the wrong model with the wrong key. So the interceptor
        // asks this row before it fires ingest on the chat path, and declines through the panel when it is
        // absent (see CHAT_INGEST_NEEDS_FORK). Recall is unaffected and never consults it.
        kind: 'version',
        minApiVersion: 8,
        // Not boot: an install that never uses Chat Completion never pays for this. The decline is reported
        // per user, on the chat path, where it is actionable — a panel banner and one log line.
        report: SILENT,
        absence: null,
    }),
]);
