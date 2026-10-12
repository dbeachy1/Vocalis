// 🔴 SOMEBODY ELSE'S RUNTIME, DESCRIBED. 8.8-m8, DESIGN_8_3_JSDOC_TYPES.md §9.
//
// `sillytavern/extension/*.js` does not run in this app. It is loaded by SillyTavern, inside
// SillyTavern's page, and its free variables — `SillyTavern`, `toastr`, `jQuery` — are provided by
// that host and exist nowhere in this repo. That is the whole reason those two files carried
// `@ts-nocheck` while the rest of the tree went to zero: without the host declared, every line
// that touches it is "Cannot find name", and the useful errors drown in the noise.
//
// ⚠️ THIS FILE IS NOT THE SAME KIND OF THING AS `dom-permissive.d.ts`, AND THE DIFFERENCE MATTERS.
// That one states things about the DOM that are FALSE, knowingly, to avoid a diff. This one states
// things about SillyTavern that are TRUE and simply unavailable to the checker, because the host's
// own sources are not in this repository. Declaring an external interface is not a lie; it is the
// only way to type against one. It is countable for the same reason, though: if SillyTavern
// changes its context API, the untruth appears HERE and nowhere else.
//
// ── SCOPE: ONLY WHAT THIS EXTENSION ACTUALLY TOUCHES ────────────────────────────────────────────
//
// `getContext()` returns a large object; the members below are the twenty-three this extension
// reads, measured rather than copied from SillyTavern's docs. Declaring more would be inventing an
// interface nobody here uses, and every extra member is one more thing that can silently drift
// out of step with the host.
//
// 📌 ADDING A MEMBER IS A NORMAL, EXPECTED EDIT — unlike dom-permissive, where it is a red flag.
// If a new feature calls `ctx().somethingElse`, declare it here in the same commit, ideally with a
// note saying what it returns and where that was checked.

interface SillyTavernContext {
    /** The live chat array. Message objects are the host's shape, hence `any` per element. */
    chat: any[];
    /**
     * Headers with the CSRF token — every fetch back into ST must carry them.
     * ⚠️ `omitContentType` matters for the multipart card upload: letting fetch set its own
     * boundary is the only way that POST works.
     */
    getRequestHeaders(opts?: { omitContentType?: boolean }): Record<string, string>;
    /** The user's power-user settings blob. */
    powerUserSettings: Record<string, any>;
    /** Names of every worldbook the host knows about. */
    getWorldInfoNames(): string[];
    /**
     * Refresh the character roster. Upstream is `export async function getCharacters()`
     * (`public/script.js:1453`) and it resolves to nothing — the roster it refreshes is read back
     * off `characters` below.
     *
     * ⚠️ THIS WAS `Promise<any> | any`, WHICH IS JUST `any`. A union with `any` collapses to
     * `any`, so the `Promise` half described nothing and every use of the result was unchecked.
     */
    getCharacters(): Promise<void>;
    /** The same roster as a property, which the host also exposes. */
    characters: any[];
    /** Repaint the worldbook picker after a book is added or renamed. */
    updateWorldInfoList(): Promise<void> | void;
    /** ST's debounced settings write. ⚠️ Debounced — NOT a durable write on its own. */
    saveSettingsDebounced(): void;
    /** Re-open the worldbook editor on a book the host already has. */
    reloadWorldInfoEditor(name?: string, load?: boolean): void;
    /** Expand `{{user}}`/`{{char}}` and friends in a string. */
    substituteParams(text: string): string;
    /**
     * Persist a worldbook. Resolves `false` when it REFUSED the write — upstream
     * (`public/scripts/world-info.js:4340`) opens `if (!name || !data) return false;`.
     *
     * 🔴 THIS WAS `Promise<void>`, WHICH ERASED THAT. A failed save and a successful one were
     * the same type, so no caller could be required to check and the checker would never suggest
     * one should. The worldbook editor persists through this call.
     */
    saveWorldInfo(name: string, data: any, immediately?: boolean): Promise<boolean>;
    /** Read a worldbook back. */
    loadWorldInfo(name: string): Promise<any>;
    /** The user's persona name — ST's own field name, kept as-is. */
    name1?: string;
    /** The active character's name in a 1:1 chat. */
    name2?: string;
    /** This extension's slice of `extension_settings`, keyed by module name. */
    extensionSettings: Record<string, any>;
    /** The active character's index, or undefined outside a 1:1 chat. */
    characterId?: string | number;
    /** The active group's id, or null outside a group chat. */
    groupId?: string | null;
    /** Every group the host knows about. */
    groups: any[];
    /** The current chat's id — changes on every chat switch, which is what §14a keys off. */
    getCurrentChatId(): string | undefined;
    /** Public quiet-generation path; it does not create or persist a chat message. */
    generateQuietPrompt(options: {
        quietPrompt: string;
        skipWIAN?: boolean;
        removeReasoning?: boolean;
        recoverReasoningOnly?: boolean;
        trimToSentence?: boolean;
    }): Promise<string>;
    /** Parse a configured inline reasoning wrapper for defense-in-depth result validation. */
    parseReasoningFromString?(value: string): { content?: string; reasoning?: string };
    /** Versioned host capability required by Vocalis Polish text and send. */
    quietGenerationCapabilities?: Readonly<{ reasoningOnlyFallback: 1 }>;
    /** ST's own modal. Returns the POPUP_RESULT the user chose. */
    callGenericPopup(content: any, type?: any, inputValue?: string, options?: any): Promise<any>;
    /**
     * The popup-kind enum. Upstream is a fixed table of five (`public/scripts/popup.js:9`); the
     * two this extension passes are declared, per this file's measured-surface rule.
     *
     * 🔴 THIS WAS `Record<string, any>`, WHICH CLAIMS EVERY STRING KEY EXISTS. `POPUP_TYPE.CONFRIM`
     * type-checked, evaluated to `undefined`, and reached `new Popup(content, undefined, …)`.
     */
    POPUP_TYPE: { CONFIRM: number; INPUT: number };
    /** The popup-outcome enum (`public/scripts/popup.js:24`). Only the one this extension compares. */
    POPUP_RESULT: { AFFIRMATIVE: number };
    /** ST's event bus and its event-name table — used to hook message rendering. */
    eventSource: {
        on(event: string, fn: (...args: any[]) => void): void;
        once(event: string, fn: (...args: any[]) => void): void;
        removeListener(event: string, fn: (...args: any[]) => void): void;
        emit(event: string, ...args: any[]): Promise<void> | void;
    };
    /**
     * ST's event-name table. The ten this extension registers on, each verified present in
     * `public/scripts/events.js`.
     *
     * 🔴 THIS WAS `Record<string, string>` AND THAT IS A LOAD-BEARING LIE, not a cosmetic one.
     * An index signature says every key exists, so a misspelled name is `undefined` at runtime —
     * and `public/lib/eventemitter.js:43` DROPS a listener registered on an undefined event with
     * nothing but a `console.trace`. Ten registrations hang off this table and the whole
     * narration path hangs off them, so one typo would silently disable the extension with no
     * error anywhere. Naming the members makes that a compile error instead.
     */
    event_types: {
        CHARACTER_MESSAGE_RENDERED: string;
        CHAT_CHANGED: string;
        CHAT_LOADED: string;
        GROUP_UPDATED: string;
        MESSAGE_DELETED: string;
        MESSAGE_EDITED: string;
        MESSAGE_SWIPED: string;
        MESSAGE_UPDATED: string;
        MORE_MESSAGES_LOADED: string;
        USER_MESSAGE_RENDERED: string;
        /** Emitted by §17's persona create so ST's own listeners see the new persona.
         *  `public/scripts/events.js:102` — `persona_created`. Found by naming these
         *  members: the old `Record<string, string>` had hidden that it was used at all. */
        PERSONA_CREATED: string;
    };
}

declare const SillyTavern: {
    /**
     * The docs-recommended global, and the ONLY entry point this extension uses — see
     * `index.js:26`. Everything else it needs hangs off the returned context.
     */
    getContext(): SillyTavernContext;
};

/**
 * The host's toast library. Four methods, which are the four this extension calls.
 *
 * ⚠️ The options argument is deliberately loose: ST ships whatever toastr version it ships, and
 * this extension only ever passes a title string or nothing.
 */
declare const toastr: {
    error(message: string, title?: string, options?: Record<string, any>): void;
    warning(message: string, title?: string, options?: Record<string, any>): void;
    info(message: string, title?: string, options?: Record<string, any>): void;
    success(message: string, title?: string, options?: Record<string, any>): void;
};

/**
 * 🔴 `$` IS jQUERY HERE, NOT VOCALIS'S `$`. In `src/webui/js/util/dom.js` the same name is
 * `document.getElementById` and returns one element; inside SillyTavern's page it is jQuery and
 * returns a COLLECTION. The web UI's modules import theirs explicitly, so the two never collide —
 * but reading this file with the other one's `$` in mind will mislead you, which is why this note
 * is here rather than in a commit message.
 *
 * ⚠️ ONLY THE MEMBERS THIS EXTENSION CALLS, measured: `.length` ×27, `.on` ×21, `.text` ×12,
 * `.append` ×10, `.get` ×9, `.toggleClass` ×8, `.attr` ×7, `.val`/`.prop`/`.addClass` ×6,
 * `.removeClass`/`.closest` ×5, `.find`/`.each` ×4, `.remove`/`.prepend`/`.data` ×2, `.css` ×1.
 *
 * That deliberate narrowness is the same argument `index.js:2865-2867` already makes about NOT
 * leaning on jQuery: its own elements use native listeners precisely so the menu is not tied to
 * "whatever subset of jQuery is present" in a given ST build. Declaring the full jQuery type would
 * quietly invite the coupling that comment refuses.
 */
interface JQueryLike {
    readonly length: number;
    /**
     * ⚠️ TWO OVERLOADS, AND THE `this` IS THE POINT. jQuery binds `this` to the matched
     * element inside a `function` handler, and this extension relies on that at ten sites
     * (`$(this).closest('.mes').attr('mesid')` is how a click finds its message). A single
     * `handler?: any` signature compiles but leaves `this` implicitly `any`, which is the
     * one thing `noImplicitThis` exists to catch.
     */
    on(events: string, selector: string, handler: (this: HTMLElement, ev: any) => any): JQueryLike;
    on(events: string, handler: (this: HTMLElement, ev: any) => any): JQueryLike;
    off(events?: string, handler?: any): JQueryLike;
    addClass(cls: string): JQueryLike;
    removeClass(cls?: string): JQueryLike;
    hasClass(cls: string): boolean;
    toggleClass(cls: string, state?: boolean): JQueryLike;
    // 🔴 GETTER AND SETTER ARE SEPARATE OVERLOADS, AND THE GETTERS RETURN WHAT jQUERY REALLY
    // RETURNS. Each of these was one signature ending in `: any`, which made this extension's
    // single busiest idiom — `$(this).closest('.mes').attr('mesid')` — completely unchecked, and
    // then fed that unchecked value into `ctx().chat[...]` and into numeric comparisons. `any` in
    // a host declaration is the same trade `dom-permissive.d.ts` was emptied to stop making: it
    // does not describe the host, it switches the checker off at the point of contact.
    //
    // ⚠️ `attr` GENUINELY RETURNS `undefined` FOR A MISSING ATTRIBUTE, and that is the case worth
    // catching here — a `.mes` without a `mesid` is exactly the shape of bug this extension has
    // had before.
    attr(name: string): string | undefined;
    attr(name: string, value: string | number | null): JQueryLike;
    /** `checked` is a boolean IDL attribute, so this overload is a fact about the DOM rather
     *  than a convenience — the three checkbox handlers in this extension read it. */
    prop(name: 'checked'): boolean;
    prop(name: string): unknown;
    prop(name: string, value: any): JQueryLike;
    val(): string | number | string[] | undefined;
    val(value: string | number): JQueryLike;
    text(): string;
    text(value: string): JQueryLike;
    html(): string;
    html(value: string): JQueryLike;
    css(name: string): string;
    css(name: string | Record<string, any>, value?: string | number): JQueryLike;
    data(key: string): unknown;
    data(key: string, value: any): JQueryLike;
    append(...content: any[]): JQueryLike;
    prepend(...content: any[]): JQueryLike;
    remove(): JQueryLike;
    empty(): JQueryLike;
    find(selector: string): JQueryLike;
    closest(selector: string): JQueryLike;
    first(): JQueryLike;
    eq(index: number): JQueryLike;
    get(): HTMLElement[];
    get(index: number): HTMLElement | undefined;
    each(fn: (this: HTMLElement, index: number, el: HTMLElement) => void): JQueryLike;
    trigger(event: string, extra?: any): JQueryLike;
}

/** The selector form. `$(fn)` is the ready handler — `index.js:3188`. */
declare function $(selectorOrElementOrFn: any): JQueryLike;
declare function jQuery(readyFn: () => void | Promise<void>): void;
