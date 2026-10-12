/**
 * Stand-in for SillyTavern's `extensions.js`.
 */

/**
 * What `getContext()` hands back. A test assigns to this before building rows.
 *
 * ⚠️ `chatId` IS THE ONE THE EXTENSION READS — `index.js` takes `getContext()?.chatId` and never calls
 * a getter for it. This stub used to carry `getCurrentChatId()` instead, which nothing under test has ever
 * called, so the field that IS read was missing and every test injected it by hand.
 */
export const context = {
    /** @type {STChatMessage[]} */
    chat: [],
    /** @type {string|null} */
    chatId: 'chat-under-test',
    /**
     * The identity half of "am I still in the same conversation?", which `chatId` alone does not settle.
     * @type {string|number|null}
     */
    characterId: 'character-under-test',
    /** @type {string|null} */
    groupId: null,
    /**
     * The chat's own metadata, where raw-generation stamps live.
     *
     * 🔴 A REAL OBJECT WHOSE IDENTITY CHANGES THE WAY THE APP CHANGES IT, because that identity is the
     * guard `captureRawRecords` checks before it writes. `switchChat` below replaces it wholesale, exactly
     * as `script.js` does on a chat load — a stub that mutated one object in place could never fail the
     * check, so every wrong-chat test would pass by construction.
     * @type {Record<string, unknown>}
     */
    chatMetadata: {},
    getTokenCountAsync: async (/** @type {string} */ text) => Math.ceil(text.length / 4),
    // `saveChat` is `saveChatConditional` in the real app. Counted rather than ignored, because "the stamp
    // is on the message" and "the stamp reached the chat file" are different claims and only the second one
    // survives leaving the chat.
    saves: 0,
    async saveChat() {
        context.saves++;
    },
    /**
     * Counted for the same reason as `saves`: "the stamp is in `chatMetadata`" and "the stamp reached the
     * chat header" are different claims, and §7.4 step 9 requires that an unchanged merge saves NOTHING —
     * which is only checkable against a count.
     */
    metadataSaves: 0,
    async saveMetadata() {
        context.metadataSaves++;
    },
};

/**
 * Move to another chat, the way the app does it.
 *
 * ⚠️ REPLACES `chatMetadata` RATHER THAN CLEARING IT, because `script.js` assigns a fresh object on every
 * chat load (`chat_metadata = chatHeader?.chat_metadata ?? {}`). The identity change is the whole point:
 * a capture that started before the switch must detect it and write nothing.
 * @param {string|null} chatId The chat now open
 * @param {Record<string, unknown>} [metadata] Its metadata, empty by default
 * @returns {void}
 */
export function switchChat(chatId, metadata = {}) {
    context.chatId = chatId;
    context.chat = [];
    context.chatMetadata = metadata;
}

/**
 * Put the stub back to its starting state between tests.
 * @returns {void}
 */
export function resetContext() {
    context.chat = [];
    context.chatId = 'chat-under-test';
    context.characterId = 'character-under-test';
    context.groupId = null;
    context.chatMetadata = {};
    context.saves = 0;
    context.metadataSaves = 0;
}

/**
 * @returns {object} The context
 */
export function getContext() {
    return context;
}
