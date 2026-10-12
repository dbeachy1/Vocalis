/**
 * Ambient declarations for the four SillyTavern modules this extension imports.
 *
 * The extension lives at `public/scripts/extensions/third-party/<name>/` and reaches the app by climbing out
 * of that directory — `../../../../script.js` and friends. Outside a real install those paths land somewhere
 * above the repo and do not exist, which is the same blind spot `test/loader.mjs` closes for the runtime.
 *
 * ⚠️ WILDCARD MODULE DECLARATIONS, MATCHED ON THE TAIL OF THE SPECIFIER — the same shape as the loader's
 * basename match, and for the same reason. The number of `../` differs by module, so anchoring on the full
 * relative path would silently stop matching the first time a file moved, failing open into an implicit
 * `any` for the whole SillyTavern surface. TypeScript consults these only for specifiers that resolve to no
 * file, so a local `./attribution.js` is never caught by them.
 *
 * ⚠️ THESE DESCRIBE ONLY WHAT THE EXTENSION IMPORTS, exactly like `test/stubs/`. Anything it starts importing
 * should fail here rather than be invented, and a member that is guessed rather than checked against the real
 * app is a lie the compiler will then defend.
 */

/** A chat message as this extension reads it. Partial: SillyTavern's own shape is much wider. */
interface STChatMessage {
    mes?: string;
    is_user?: boolean;
    extra?: Record<string, unknown>;
    swipe_id?: number;
    swipe_info?: { extra?: Record<string, unknown> }[];
}

/**
 * One entry of `itemizedPrompts`, as this extension reads it.
 *
 * The section strings are the pieces the prompt was assembled from; every one of them is absent on some
 * install or some turn, which is why they are all optional rather than `string`.
 */
interface STItemizedPrompt {
    mesId?: number | string;
    /**
     * `generate_data.prompt || generate_data.input` — a string on text completion, and the MESSAGE ARRAY on
     * chat completion. Read either form through `promptTextOf` before using it as prompt text.
     */
    rawPrompt?: string | Array<{ role?: string, content?: unknown, [key: string]: unknown }>;
    /** The context window this turn was sent into. Read through `Number()`, so either form is usable. */
    this_max_context?: number | string;
    tokenizer?: string;

    // The prompt's own sections, as `sectionsOf` reads them for attribution.
    storyString?: string;
    instruction?: string;
    worldInfoString?: string;
    charDescription?: string;
    charPersonality?: string;
    scenarioText?: string;
    userPersona?: string;
    examplesString?: string;
    mesSendString?: string;
    summarizeString?: string;
    authorsNoteString?: string;
    chatVectorsString?: string;
    dataBankVectorsString?: string;

    // The two `CLIENT_COMPONENTS` entries that are not prompt sections in their own right.
    smartContextString?: unknown;
    chatInjects?: unknown;
    allAnchors?: unknown;

    /**
     * The record carries far more than the extension reads, and `componentText` indexes it by a field name
     * held in data. An undeclared field is `unknown` rather than absent, which is what forces the callers
     * to narrow instead of assuming a string.
     */
    [key: string]: unknown;
}

/** What `getContext()` hands back, narrowed to the members this extension uses. */
interface STContext {
    chat?: STChatMessage[];
    chatId?: string | null;
    /**
     * Which character is selected (`this_chid`), or which group (`selected_group`) — the other half of
     * "am I still looking at the same conversation?" alongside `chatId`.
     *
     * 🔴 CHECKED BEFORE A RAW STAMP IS WRITTEN, NOT FOR DISPLAY. `captureRawRecords` fetches over the
     * network and can resolve after the reader has moved on; `chatId` alone does not settle it, because a
     * group and a character can present the same chat file name. DESIGN_RAW_GENERATION_ROWS.md §7.4 step 8
     * and §11.3.
     */
    characterId?: string | number | null;
    groupId?: string | null;
    /**
     * The chat's own metadata object (`chat_metadata`), which SillyTavern serializes into the chat header.
     *
     * 🔴 THIS IS WHERE RAW-GENERATION MEASUREMENTS LIVE, AND THE REASON IS THE CHAT'S LIFETIME, NOT
     * CONVENIENCE. A quiet generation creates no assistant message, so there is nothing to hang a
     * `message.extra.cacheLens` stamp on — and every other store available (extension settings, local
     * storage, IndexedDB, a server-side file) either fails to travel with the chat on export/import or
     * sits outside the encryption boundary the chat already has. §7.1.
     *
     * ⚠️ THE OBJECT IS REPLACED WHOLESALE ON EVERY CHAT LOAD, WHICH IS WHAT MAKES ITS IDENTITY USABLE AS A
     * GUARD. `script.js` assigns `chat_metadata = chatHeader?.chat_metadata ?? {}` when a chat opens, and
     * `updateChatMetadata` spreads into a NEW object, so a reference captured before an await is `!==` the
     * current one exactly when something moved underneath.
     *
     * ⚠️ AND IT IS SHARED WITH EVERY OTHER EXTENSION. Cache Lens owns the `cacheLens` key and nothing else;
     * a writer that replaces the whole object discards whatever a lorebook, a summarizer or a future Cache
     * Lens version put beside it.
     */
    chatMetadata?: Record<string, unknown>;
    getTokenCountAsync: (text: string) => Promise<number>;
    saveChat?: () => Promise<void>;
    /**
     * Persist `chatMetadata` into the chat file.
     *
     * ⚠️ OPTIONAL BECAUSE AN OLDER INSTALL MAY NOT EXPOSE IT, and a capture that cannot save must degrade
     * to "kept in memory, retried on the next trigger" rather than throwing — §11.4.
     */
    saveMetadata?: () => Promise<void>;
}

declare module '*/script.js' {
    export const eventSource: {
        on(event: string, handler: (...args: unknown[]) => void): void;
    };
    export const event_types: Record<string, string>;
    export const itemizedPrompts: STItemizedPrompt[];
    export const main_api: string;
    export function getRequestHeaders(): Record<string, string>;
    /**
     * Copies `chat[id].extra` into `chat[id].swipe_info[swipe_id].extra`, which is what makes a stamp survive
     * a swipe away and back. Returns `false` and copies nothing when there is no `swipe_info`.
     */
    export function syncMesToSwipe(messageId?: number | null): boolean;
}

declare module '*/extensions.js' {
    export function getContext(): STContext;
}

declare module '*/popup.js' {
    export const POPUP_TYPE: Record<string, number>;
    export class Popup {
        /** `title` is genuinely nullable — the panel passes null to draw its own heading instead. */
        constructor(content: HTMLElement, type: number, title?: string | null, options?: Record<string, unknown>);
        show(): Promise<unknown>;
    }
}

/**
 * SillyTavern's own global, as this extension reaches it.
 *
 * Both uses are optional-chained all the way down, because the extension can be loaded before the app has
 * finished putting this together — so every level here is optional rather than assumed.
 */
declare var SillyTavern: {
    getContext?: () => STContext;
    libs?: {
        /** Bundled hasher. Absent on an install too old to carry it, which `hashPrompt` treats as "cannot hash". */
        sha256?: (text: string) => string;
    };
} | undefined;

/**
 * The toast library SillyTavern bundles and exposes globally.
 *
 * ⚠️ ONLY `info`, BECAUSE THAT IS ALL THE EXTENSION CALLS — the same rule as the module declarations above.
 * Declaring the library's whole surface would make `test/dom.js`'s deliberately minimal stub fail to satisfy
 * it, and that stub is minimal on purpose: anything the panel starts using should fail loudly there rather
 * than be quietly approximated.
 */
declare var toastr: {
    info(message: string, title?: string): void;
};

declare module '*/utils.js' {
    export function copyText(text: string): Promise<void>;
}
