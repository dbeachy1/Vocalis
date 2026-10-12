/**
 * Stand-in for SillyTavern's `script.js`, resolved in place of it by `test/loader.mjs`.
 *
 * ⚠️ ONLY WHAT THE EXTENSION IMPORTS. `index.js` takes five bindings and `record.js` lazily takes a sixth;
 * anything else it starts importing should fail here rather than be invented.
 */

import { context } from './extensions.js';

/**
 * 🔴 MANY LISTENERS PER EVENT, BECAUSE THE REAL `eventSource` HAS MANY AND A STUB THAT SILENTLY KEEPS ONE
 * HIDES THE BUG IT WOULD CAUSE. This used to be a `Map<string, Function>` whose `on` called `set`, so a
 * second registration for the same event REPLACED the first and vanished without a word. Raw-generation
 * capture adds work to `MESSAGE_RECEIVED`, which already had a listener — under the old stub, wiring that
 * as a second listener would have looked correct in every test while the measurement stamp stopped being
 * written in the real app. `test/stubs` exists to be faithful about failure, not only about success.
 */
export const eventSource = {
    /** @type {Map<string, Function[]>} */
    handlers: new Map(),
    /**
     * @param {string} event Event name
     * @param {Function} handler What to call
     * @returns {void}
     */
    on(event, handler) {
        const existing = this.handlers.get(event) ?? [];

        existing.push(handler);
        this.handlers.set(event, existing);
    },
    /**
     * Fire an event at everything listening for it, in registration order.
     *
     * ⚠️ AWAITS EACH HANDLER, because the core awaits `MESSAGE_RECEIVED` — and `index.js` deliberately
     * returns nothing from that handler so the reply is not held off screen. A test that wants to observe
     * what the handler kicked off has to await the work itself, not this call.
     * @param {string} event Event name
     * @param {...unknown} args What to pass
     * @returns {Promise<void>} When every listener has settled
     */
    async emit(event, ...args) {
        for (const handler of this.handlers.get(event) ?? []) {
            await handler(...args);
        }
    },
    /**
     * Forget every registration, so one test's `init()` does not leak listeners into the next.
     * @returns {void}
     */
    reset() {
        this.handlers.clear();
    },
};

export const event_types = {
    MESSAGE_RECEIVED: 'message_received',
    CHAT_CHANGED: 'chat_changed',
    GENERATION_TIMINGS: 'generation_timings',
    /**
     * Fired when a generation finishes, INCLUDING one that produced no chat message — which is precisely
     * why raw capture hangs off it. A `quiet` formatter request emits this and never emits
     * `MESSAGE_RECEIVED` for a new message id, so it is the only lifecycle event that sees the request at
     * all. DESIGN_RAW_GENERATION_ROWS.md §7.4.
     */
    GENERATION_ENDED: 'generation_ended',
};

/**
 * Mutable on purpose: a test pushes the turns it wants rows for.
 * @type {STItemizedPrompt[]}
 */
export const itemizedPrompts = [];

export let main_api = 'textgenerationwebui';

/**
 * @param {string} api The api to pretend to be on
 * @returns {void}
 */
export function setMainApi(api) {
    main_api = api;
}

/**
 * @returns {Record<string, string>} Headers for a request to SillyTavern's own API
 */
export function getRequestHeaders() {
    return { 'Content-Type': 'application/json' };
}

/**
 * The real one copies the whole of `chat[id].extra` into `chat[id].swipe_info[swipe_id].extra`, which is
 * what makes a stamp survive a swipe away and back. This is the same copy, over the same objects, so a test
 * can then run the restore by hand and see whether the stamp was in the copy.
 *
 * ⚠️ IT IS THE STUB'S JOB TO BE FAITHFUL ABOUT THE FAILURE, NOT ONLY THE SUCCESS. The real function returns
 * `false` and copies nothing when there is no `swipe_info`, and the streaming trap is invisible unless a
 * test can reproduce that shape.
 *
 * ⚠️ AND IT READS THE CHAT OFF THE CONTEXT RATHER THAN KEEPING ITS OWN. In the real app `chat` is a module
 * global that `getContext().chat` points AT, so they cannot disagree; a stub with two copies would let a
 * test set one of them and quietly prove nothing.
 * @param {number|null} messageId Which message
 * @returns {boolean} Whether anything was copied
 */
export function syncMesToSwipe(messageId = null) {
    const message = messageId === null ? undefined : context.chat?.[messageId];

    if (!message || !Array.isArray(message.swipe_info) || message.swipe_info.length === 0) {
        return false;
    }

    const info = message.swipe_info[message.swipe_id ?? 0];

    if (!info) {
        return false;
    }

    info.extra = structuredClone(message.extra ?? {});

    return true;
}
