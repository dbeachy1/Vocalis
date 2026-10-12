/**
 * The fork, declared — every method Mnemosyne calls on the `context` object, and not one it does not.
 *
 * 🔴 **THIS IS THE COUPLING, AND IT IS THE ONLY ONE.** Mnemosyne has no relative import into the fork's `src/`
 * and must never grow one; everything it is allowed to know about SillyTavern arrives
 * through the object below. That makes this file the written-down form of a dependency that was previously
 * spread across fourteen untyped pass-throughs in `src/host/context.js` — reachable only by reading both
 * projects at once and holding them in your head.
 *
 * 🔴 **TAKEN FROM THE FORK'S SOURCE, NOT FROM ITS DESIGN DOC.** `DESIGN_MEMORY_PLUGIN_API.md` is two thousand
 * lines written across a dozen sittings and its sections contradict each other in places. Every signature here
 * was read off `SillyTavern/src/plugin-loader.js` and `src/generation-interceptors.js` — the code that
 * actually constructs the context and calls the interceptor — with the doc used only for the *why*. Section
 * numbers are cited so the argument stays findable; the shapes are not from there.
 *
 * ⚠️ **AND IT IS A SNAPSHOT OF SOMEBODY ELSE'S FILE.** Nothing in this repository can make it stay true. If
 * the fork changes a signature, this file keeps type-checking and the failure moves to runtime, inside the
 * fork's process — which is the same class of failure `capabilities.js` exists to make loud, arriving through
 * the door that looks safest. Two things bound it: the members are declared **optional**, so a call site
 * cannot forget that a fork may not have one, and `capabilities.js` still guards at runtime. The declaration
 * describes the shape; the table decides whether to call.
 *
 * 🔴 **EVERY MEMBER IS OPTIONAL, AND THAT IS THE POINT RATHER THAN CAUTION.** the host runs a fork that predates
 * several of these. `HostContext` exists precisely because "does this fork have X?" is a real question with a
 * different answer per install, and a non-optional declaration here would make the type system assert the one
 * thing the whole capability table was built to deny.
 */

/** One turn of the conversation, as `onPrompt` delivers it. Fork §17. */
interface ForkRecentMessage {
    /** Who spoke. */
    role: 'user' | 'assistant' | 'system';
    /** Display name — the character in a solo chat, the persona on user turns. ⚠️ A name cannot address a partition. */
    name?: string;
    /** Post-macro-substitution, pre-instruct-render. Never a template. */
    content: string;
    /** Position in the FULL chat array — the window's anchor (fork §17.8), not an index into the window. */
    index: number;
    /**
     * Who PRODUCED this turn, as a stable id (fork §22.8.2). 🔴 `null` — never `''` — on user, narrator and
     * system turns, and on any turn whose character the fork's id map does not hold. This is what a write is
     * scoped by; `name` above is a display name and is not an identity.
     *
     * ⚠️ **OPTIONAL, and the `?` carries a different fact from the `| null`.** `null` means *this fork
     * told us, and the answer is nobody* — a user turn, or a character its id map does not hold. **Absent**
     * means *this fork predates §22.8.2 and never tells us at all*, which is a different install and a
     * different degradation: `speakersIn` collapses the group fan-out to the trigger character alone, and a
     * test pins exactly that. Declaring it required would make that supported install unrepresentable, which
     * is the same mistake as declaring a `ForkContext` method non-optional — see this file's header.
     */
    charId?: string | null;
    /**
     * Where this turn's RENDERED form begins in `prompt`, as a character offset (fork §27). Absent on the
     * chat path, which has no rendered blob, and on a client too old to send it.
     */
    promptOffset?: number;
    /**
     * When this turn was sent, as epoch milliseconds (fork §29, apiVersion 7). Parsed by the fork from the
     * message's `send_date`, whatever format the chat file holds it in.
     *
     * ⚠️ `null` and absent are different facts, the same split as `charId`: `null` means *this fork parsed the
     * message and it carries no time it could read*; absent means *this fork predates §29*. Neither is ever
     * `0` or the current time, so a number here is always a real send time.
     */
    sendDate?: number | null;
}

/**
 * What is about to be sent to the backend, as `onPrompt` hands it over.
 *
 * ⚠️ **`messages` and `prompt` are mutually exclusive and neither is guaranteed.** `chat` carries `messages`;
 * `text`, `kobold` and `novel` carry `prompt`. A handler that reads one without checking `backend` reads
 * `undefined` on the other path — silently, because an interceptor that returns nothing is a legal decline.
 */
interface ForkOutgoingPrompt {
    /** The user this generation belongs to. */
    handle: string;
    /** Which family of backend. A plugin that only understands one declines on the others by returning nothing. */
    backend: 'text' | 'chat' | 'kobold' | 'novel';
    /** The specific backend within that family, verbatim from the request. */
    apiType: string;
    /** The prompt as a structured array. Present for `'chat'` ONLY. */
    messages?: unknown[];
    /**
     * The prompt as one rendered string. Present for `'text'`, `'kobold'` AND `'novel'`.
     *
     * ⚠️ An earlier version of this line said "`'text'` and `'kobold'` ONLY", which was wrong in the direction
     * that matters: a reader concluded the `novel` path carried neither field and therefore could not be
     * handled at all. `novelai.js:201-208` sends `prompt: req.body.input`. The declaration was right; only the
     * prose lied.
     */
    prompt?: string;
    /**
     * ⚠️ **NOT THE ROOM YOU HAVE, AND LARGER THAN IT.** The client fills the prompt to
     * `max_context - amount_gen` and then hands the backend `max_context`, so the response reservation is
     * still inside this number. Budgeting against it concludes there is space that does not exist. Declare
     * `reservesTokens` at registration instead (fork §17.6).
     */
    budget?: number;
    /** The active character or group name, if the client sent it. Prose, never a key. */
    charName?: string;
    /** A stable id for the current chat, if the client sent it. */
    chatId?: string;
    /** Which KIND of generation this is, verbatim from the client. Undefined means an ordinary one. */
    genType?: string;
    /** The active character as a stable id (fork §22.4). `null` when no character is selected. */
    charId?: string | null;
    /** The active persona as a stable id (fork §22.7). `null` on the default avatar. */
    personaId?: string | null;
    /**
     * The recent turns, structured, on every path. READ-ONLY — mutating or returning it does nothing.
     * Sliced to the count declared at registration; `undefined` rather than `[]` when the client sent
     * nothing, because absent and empty are different facts.
     */
    recentMessages?: ForkRecentMessage[];
}

/**
 * The fork's classified logger (fork §23). 🔴 The first argument is the class, and it is the fork's own value —
 * see `adoptLogger`, which takes `LogClass` from the same context rather than defining its own. A local copy
 * that drifted would publish a line this plugin had marked `SENSITIVE`.
 */
interface ForkLogger {
    debug(logClass: unknown, ...args: unknown[]): void;
    info(logClass: unknown, ...args: unknown[]): void;
    warn(logClass: unknown, ...args: unknown[]): void;
    error(logClass: unknown, ...args: unknown[]): void;
}

/**
 * The context object the fork's plugin loader hands `init`.
 *
 * ⚠️ It also carries an index signature, and that is not a hedge: `HostContext.#detect` looks members up **by
 * name from the capability table** (`typeof this.raw[cap.name] === 'function'`), which is a dynamic lookup no
 * declared member list can express. The signature is what lets that stay written as it is instead of being
 * cast around, and `unknown` is what keeps the result from being used without a check.
 */
interface ForkContext {
    /**
     * The fork's monotonic plugin-API version (fork §26.7). Absent on a fork predating the notion, which
     * `HostContext` reads as 0 — older than everything.
     */
    apiVersion?: number;

    /** Classified logging (fork §23). Both halves are needed; `adoptLogger` checks all six members. */
    logger?: ForkLogger;
    /** The class constants themselves. Values are opaque and are never reproduced locally — see `adoptLogger`. */
    LogClass?: { NORMAL?: unknown; SENSITIVE?: unknown };

    /**
     * Embed a BATCH of texts. 🔴 Never a bare string — the fork refuses one, because a string is an array of
     * characters to anything that iterates it and `embed('hello')` would otherwise return five vectors.
     *
     * ⚠️ The first call may be slow and may throw: it loads the model, downloading it unless
     * `extensions.models.autoDownload` is false. Failure is loud and the caller's to handle.
     *
     * 🔴 `model` is the ONLY thing that knows which model this install uses (fork §13.3) — never hard-code it,
     * and never infer it from the fork's source, which is actively misleading on the point.
     */
    embed?(texts: string[]): Promise<{ vectors: number[][]; model: string | null }>;

    /**
     * Run a completion on the user's own backend — the extraction call and the uncertain-band confirm.
     *
     * ⚠️ Needs a prior generation this process: the fork routes to the connection that user's last generation
     * used, so a call at boot has nowhere to send and throws. 🔴 Fails loud, always — never a silent empty
     * string. `wrap: true` puts the prompt in the backend's instruct envelope and is what stops an RP-tuned
     * model *continuing* an instruction instead of following it.
     *
     * 🔴 Below `apiVersion` 8 this drives TEXT-completion connections only: the fork's chat route captures no
     * connection and `generate` refuses every api_type outside its OpenAI-completions family. That is the
     * `chatGenerate` capability row, and why `ingestFrom` never calls this for a chat generation on an older
     * fork. From 8, a captured chat connection is driven as one `user` message on
     * `/chat/completions`, and `wrap` needs no envelope there — the chat template frames it.
     */
    generate?(params: {
        handle: string;
        prompt: string;
        maxTokens?: number;
        temperature?: number;
        stop?: string[];
        wrap?: boolean;
        /** GBNF, honored from `apiVersion >= 3`. An older fork ignores the field — which is why it is gated. */
        grammar?: string;
        repPen?: number;
    }): Promise<{
        text: string;
        /**
         * Why the backend stopped, its own string passed through verbatim — `apiVersion >= 5`, and OPTIONAL
         * at every version because a backend may not send one (verified against the fork's
         * `src/plugin-loader.js:891`, not taken from its changelog).
         *
         * 🔴 **IT IS HOW AN EMPTY ANSWER IS TOLD FROM A TRUNCATED ONE, AND ON A THINKING MODEL THAT MATTERS.**
         * DeepSeek-V4-Pro spends 1,200–1,900 tokens reasoning before it writes a character of the answer, and
         * that reasoning is billed against the same ceiling. When the ceiling is too low the call resolves
         * with `text: ''` and `finishReason: 'length'` — byte-identical, in `text`, to a model that had
         * nothing to say. Without this field the two are indistinguishable, and ingest treats both as garbage
         * and retries the identical call under the identical ceiling, which cannot ever succeed.
         */
        finishReason?: string;
    }>;

    /**
     * A character card's decrypted bytes, by the fork's minted id (fork §25) — never by name, never by filename.
     *
     * 🔴 `null` and a throw are different answers. `null` means the id names no card, which is ordinary.
     * Everything else throws, **including a locked vault**, because reading "locked" as "no card" would extract
     * a baseline of nothing and never learn it had been wrong. The PNG parse is ours (`src/card.js`) — the fork
     * interprets nothing (fork §20.1).
     */
    readCharacterCard?(handle: string, charId: string): Promise<Buffer | null>;

    /**
     * A chat's core turns read from disk, on demand (fork §29, apiVersion 7) — the Rescan button's source.
     *
     * The turns are built by the same client functions that build `recentMessages`, imported by the fork
     * rather than copied, so `index`, `charId` and `sendDate` match that window exactly. `chatId` is spelled
     * as `OutgoingPrompt.chatId` and as a panel request's `?chatId=`. `last` returns the trailing N core turns;
     * omitted, the whole chat.
     *
     * 🔴 `null` and a throw are different answers, as with `readCharacterCard`: `null` means no chat has that
     * id. Everything else throws, **a locked vault included**, so a locked vault can never read as an empty
     * chat and report a rescan that did nothing as a success.
     *
     * ⚠️ `content` is the stored text of the active swipe. The generation window's `content` can differ on a
     * turn with attached files or prompt-only regex scripts, which only the client can apply (fork §29 reply
     * §4). Nothing here compares source text between the two paths, so the difference is harmless.
     */
    readChat?(handle: string, chatId: string, options?: { last?: number }): Promise<ForkRecentMessage[] | null>;

    /** Whether a provider that can derive keys is installed for this user. 🔴 NOT `ownsUser` — see `openFor`. */
    hasSecureStorage?(handle: string): boolean;

    /**
     * Derive Mnemosyne's database subkey. 🔴 ASK LATE — only ever valid in the moment after a user unlocks;
     * `null` when there is no key material to derive from.
     */
    deriveSubkey?(handle: string, info: string, length: number): Buffer | null;

    /** The user's own directory root. Where the file goes — never whether we may open it. */
    userDirectory?(handle: string): string;

    /** Declare `memory/` as ours and already encrypted. Returns false if no provider was listening. */
    registerForeignStore?(store: { directory: string; owner: string; forbidden?: string[] }): boolean;

    /**
     * Subscribe to outgoing prompts. 🔴 The second argument declares the conversation window ingest needs —
     * omit it and `recentMessages` is `undefined` on every call, for ever, silently.
     */
    onPrompt?(
        handler: (outgoing: ForkOutgoingPrompt) => Promise<unknown>,
        options?: { recentMessages?: number; reservesTokens?: number },
    ): void;

    /** A user's vault opened. */
    onStorageReady?(handler: (handle: string) => Promise<void> | void): void;
    /** A user's vault shut. 🔒 Where NFR1 is kept. */
    onStorageLock?(handler: (handle: string) => Promise<void> | void): void;
    /** A chat was deleted (fork §24) — its scenario-tier memories die with it. */
    onChatDeleted?(handler: (handle: string, chatId: string) => Promise<void> | void): void;
    /** A chat was renamed (fork §24.4). Without it, a rename strands every memory of that conversation. */
    onChatRenamed?(handler: (handle: string, oldChatId: string, newChatId: string) => Promise<void> | void): void;

    /**
     * Register the panel button (fork capability 7). Absent on a fork with no panel support.
     *
     * ⚠️ `stylesheetPath` (fork §10.3) was MISSING from this declaration and `index.js` passes it — so the one
     * member that had drifted was a member a working call site depends on. It is here because
     * `plugin-panels.js:127` honors it, NOT because `plugin-loader.js:811`'s JSDoc lists it: that block was
     * never updated for §10.3 and is the copy this file was first read off. **Which is precisely the hazard
     * this file's header names** — a snapshot of somebody else's source, and one of its two sources was stale.
     * When two places in the fork disagree, the one that consumes the field wins.
     */
    registerPanel?(spec: {
        icon: string;
        iconColor?: string;
        label: string;
        tooltip?: string;
        panelPath: string;
        statusPath?: string;
        /** A path on this plugin's own router — the panel's CSS (fork §10.3). Never CSS itself. */
        stylesheetPath?: string;
    }): void;

    /**
     * Register a settings screen in the Extensions dialog (fork §28, apiVersion 6). Absent below that.
     *
     * 🔴 **INDEPENDENT OF `registerPanel`** — settings and no panel, a panel and no settings, both, or
     * neither. Calling it twice REPLACES the registration rather than adding a second row.
     *
     * The fork passes no identity: the route is same-origin with the session cookie, so `settingsPath` reads
     * `request.user.profile.handle` exactly as every other route here does. A handle handed in would be a
     * second, forgeable source of truth.
     */
    registerSettings?(spec: {
        label: string;
        /** One line under the label. Optional. */
        description?: string;
        /** A path on this plugin's own router — the settings fragment. */
        settingsPath: string;
        /** A path on this plugin's own router — the fragment's CSS. Never CSS itself. */
        stylesheetPath?: string;
    }): void;

    /** Push a UI notification (fork §26, capability 18). Needs `apiVersion >= 2` as well as the method. */
    notify?(spec: {
        handle: string;
        action: string;
        data?: object;
        chatId?: string;
        color?: string;
        summary?: string;
    }): void;

    /** See the note on this interface: the capability table looks members up by name, at runtime. */
    [member: string]: unknown;
}
