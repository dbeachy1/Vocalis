import { getRequestHeaders } from '../script.js';
import { resolveChatMarker } from './chat-storage-marker-logic.js';

/**
 * 🔒 THE PER-CHAT STORAGE MARKER — the green padlock, `DESIGN_MIXED_MODE.md` §7.
 *
 * A chat that was encrypted end to end gets a padlock; a chat that was never encrypted gets NOTHING —
 * not a grey padlock, not an open one, not a warning. §7.2 is the whole design of it: presence is the
 * signal, absence is the default. A warning that appears on most rows for most of a week stops being read,
 * at which point its absence means nothing either. So the only thing this module ever adds is a marker on a
 * row that genuinely earned one.
 *
 * ## Three rules this module did not get to choose
 *
 * 1. 🔴 **The tooltip words are the PROVIDER'S, and the fork has none of its own.** SillyTavern does not
 *    know whether a provider encrypts, compresses, or ships the bytes elsewhere, so it cannot say "your data
 *    is encrypted" — only the provider can. The words come from `describe('storage.chatMarker')`, surfaced
 *    by the endpoint as `marker`. A provider that stays quiet gets no tooltip AND no icon (§6.2): a marker
 *    the fork cannot caption is a claim the fork is making on its own, one branch further down.
 *
 * 2. 🔴 **The "requires provider" text on an unavailable row IS the fork's** — and that is a different
 *    statement. It is not "your data is encrypted" (a claim only the provider may make); it is "this row is
 *    disabled because the plugin that reads it is gone, here is its name so you can put it back" (§11). The
 *    name comes from the envelope, validated server-side to `[a-z0-9-]{1,32}` or dropped to null, so what
 *    arrives is a plausible id or nothing — never an attacker's string. It is still rendered with
 *    `textContent`, never markup: validated is not the same as trusted.
 *
 * 3. ⚠️ **Any failure shows no marker and never disturbs the list.** No provider, an old fork without the
 *    endpoint, a request that simply failed — all four collapse to "draw nothing", which is exactly today's
 *    UI. Nothing here throws into the chat list, and a chat list that failed to gain a padlock is a chat
 *    list that still works.
 */

/**
 * Ask the authenticated per-chat endpoint about a batch of chats. Batched because §6.1 notes a 200-chat
 * list is already 200 provider calls; 200 HTTP round trips on top would be a self-inflicted wound.
 * @param {Array<{name: string, directory: string}>} chats The chats to ask about
 * @param {boolean} [group] Whether these are group chats, which live in a different directory entirely
 * @returns {Promise<{chats: Object, marker: string}|null>} The status map and the provider's marker, or null
 */
/**
 * Monotonic ticket for the header marker, so only the newest chat switch may draw. See
 * {@link updateChatHeaderMarker} for why an out-of-order reply is a correctness problem here and not a
 * cosmetic one.
 * @type {number}
 */
let headerMarkerTicket = 0;

async function fetchChatStatus(chats, group = false) {
    if (!Array.isArray(chats) || chats.length === 0) {
        return null;
    }

    try {
        const response = await fetch('/api/storage/chat-status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ chats, group }),
        });

        // Not-ok is not an error to surface: it is a fork old enough not to have the endpoint, or an install
        // with no provider. Either way the answer is "no markers", which is today's behaviour.
        if (!response.ok) {
            return null;
        }

        return await response.json();
    } catch {
        return null;
    }
}

/**
 * Draw one row's marker from its status. All the "should there be a marker, and what does it say" logic
 * lives in {@link resolveChatMarker}, which is pure and tested; this only applies the answer to the DOM.
 * @param {Element|null} icon The padlock element inside the row
 * @param {Element} block The row itself
 * @param {{encrypted?: boolean, unavailable?: boolean, requiresProvider?: string|null}|undefined} state Status
 * @param {string} marker The provider's tooltip words for an available encrypted chat
 * @returns {void}
 */
function drawRowMarker(icon, block, state, marker) {
    if (!icon) {
        return;
    }

    const result = resolveChatMarker(state, marker);
    if (result.kind === 'none') {
        return;
    }

    if (result.kind === 'unavailable') {
        block.classList.add('select_chat_block_unavailable');

        // The preview is useless for a chat that cannot be decrypted, so replace it with the reason. This
        // is the difference between "my chats are broken" and "I uninstalled the wrong thing, put it back".
        const preview = block.querySelector('.select_chat_block_mes');
        if (preview) {
            preview.textContent = result.title;
        }

        // 🔴 AND CLEAR THE NUMBERS, WHICH WERE INVENTED. `getChatInfo` takes its enveloped-file branch and
        // returns defaults — 0 messages, the file's mtime, and the size of bytes nobody could read — and the
        // list writes all three into the row. So a dead row read "(1.2mb, 0 💬)" with a plausible date for a
        // chat sitting there intact with hundreds of messages in it, on the exact screen a worried user is
        // checking to find out whether their data survived.
        //
        // The fork already decided this, in its own words, for synthesised GROUP dead rows: "No size, no
        // count, no date: nothing here was measured, and inventing '0kb, 0 💬' for a chat that is sitting
        // there intact would be the fork stating something it does not know." Character rows never got it.
        for (const selector of ['.chat_file_size', '.chat_messages_num', '.chat_messages_date']) {
            const field = block.querySelector(selector);

            if (field) {
                field.textContent = '';
            }
        }

        icon.classList.add('select_chat_block_marker_unavailable');
    }

    // textContent semantics: `title` is a plain attribute, browser-escaped, and the id inside it is already
    // validated server-side. Never innerHTML.
    icon.setAttribute('title', result.title);
    icon.style.display = '';
}

/**
 * The server's own per-request cap. Kept in step with `MAX_CHATS_PER_REQUEST` in
 * `src/endpoints/storage-private.js`; a mismatch here shows up as a 400 that blanks the whole list.
 */
const MAX_CHATS_PER_REQUEST = 500;

/**
 * Ask about any number of chats, in batches the server will accept, and merge the answers.
 * @param {Array<{name: string, directory: string}>} chats Every chat on the list
 * @param {boolean} group True when these are a group's chats
 * @returns {Promise<{chats: Object<string, object>, marker: string}|null>} The merged answer, or null if
 * every batch failed
 */
async function fetchChatStatusChunked(chats, group) {
    /** @type {Object<string, object>} */
    const merged = Object.create(null);
    let marker = '';
    let answered = false;

    for (let start = 0; start < chats.length; start += MAX_CHATS_PER_REQUEST) {
        const status = await fetchChatStatus(chats.slice(start, start + MAX_CHATS_PER_REQUEST), group);

        if (!status?.chats) {
            continue;
        }

        answered = true;
        Object.assign(merged, status.chats);

        if (typeof status.marker === 'string' && status.marker) {
            marker = status.marker;
        }
    }

    return answered ? { chats: merged, marker } : null;
}

/**
 * Decorate every row in the "Manage chat files" list with its storage marker.
 *
 * Called after the list is built, for character chats and group chats alike — the same `#select_chat_div`
 * serves both. The two live in different directories (`chats/<character>/` and a flat `group chats/`), which
 * the endpoint cannot infer from a name, so the caller says which it is asking about.
 * @param {string} directory The character directory (the avatar name without its extension), or '' for a group
 * @param {boolean} [group] True when the rows are a group's chats
 * @param {Object<string, {encrypted?: boolean, unavailable?: boolean, requiresProvider?: string|null}>} [serverStates]
 * States the list endpoint supplied for rows the status endpoint cannot answer for, keyed by row `file_name`
 * @returns {Promise<void>}
 */
export async function applyChatStorageMarkers(directory, group = false, serverStates = {}) {
    const named = Array.from(document.querySelectorAll('#select_chat_div .select_chat_block'))
        .map((block) => {
            // 🔴 THE ROW'S `file_name` HAS NO EXTENSION, AND THIS ENDPOINT RESOLVES A REAL FILE. The list is
            // built from the chat SEARCH response, whose `file_name` is the chat id (`my-chat`), while the
            // status endpoint joins the name onto `chats/<directory>/` and asks the disk about it. Sending
            // the bare id resolved to a path that does not exist, every chat came back "not encrypted", and
            // §7.2 then correctly drew nothing — so the padlock and the §11 dead row were both silently
            // absent from the chat list while the message-bar padlock worked, because ITS call site (the
            // CHAT_CHANGED handler in script.js) appends the extension itself. Found by driving a browser;
            // no server test could see it, because the endpoint was being asked the wrong question and
            // answering it correctly.
            const id = block.getAttribute('file_name');
            return { block, id, name: id && !id.endsWith('.jsonl') ? `${id}.jsonl` : id };
        })
        .filter((entry) => entry.name);

    if (named.length === 0) {
        return;
    }

    // 🔴 CHUNKED, BECAUSE THE SERVER REFUSES THE WHOLE REQUEST AND NOT JUST THE OVERFLOW. The endpoint
    // caps a batch at MAX_CHATS_PER_REQUEST and answers 400 for the entire thing, and this list is NOT paged
    // — `displayPastChats` renders every chat a character has, and the search endpoint applies no limit. So
    // one character with 501 chats got a 400, `fetchChatStatus` mapped not-ok to null, and EVERY padlock and
    // EVERY §11 dead row vanished from that list at once: each unreadable chat then rendered as an ordinary
    // clickable row previewed "[The chat is empty]", which is one click from overwriting it.
    //
    // ⚠️ Chunking rather than raising the cap. A bigger number is the same cliff further along, and the cap
    // is protecting the server from an unbounded `stat` loop — which is a real thing to protect.
    const status = await fetchChatStatusChunked(named.map((entry) => ({ name: entry.name, directory })), group);

    // A server-supplied state still has to be drawn even when the status request failed outright — those
    // rows are the ones whose chats are UNREADABLE, so falling back to "draw nothing" would hide exactly
    // the rows §11 exists to show.
    if (!status?.chats && Object.keys(serverStates).length === 0) {
        return;
    }

    const marker = typeof status?.marker === 'string' ? status.marker : '';
    for (const { block, id, name } of named) {
        // 🔴 THE SERVER'S STATE WINS, AND ONLY IT CAN BE RIGHT HERE. It is supplied for a row whose bytes
        // are on disk under a name this fork cannot read, so the status endpoint — which resolves a path —
        // has no path to resolve and correctly answers "ordinary file". Preferring its answer would turn
        // the dead row back into a silent, empty, clickable one.
        // ⚠️ `Object.hasOwn`, NOT a truthiness test — a chat name is the user's to choose. A chat called
        // `constructor` or `toString` reads an inherited function off the prototype, which is not nullish, so
        // `??` short-circuited on it and the server's real answer was never consulted. It then failed toward
        // "no marker", dropping the dead row for precisely that chat.
        const state = Object.hasOwn(serverStates, id)
            ? serverStates[id]
            : (status?.chats && Object.hasOwn(status.chats, name) ? status.chats[name] : undefined);
        drawRowMarker(block.querySelector('.select_chat_block_encrypted_marker'), block, state, marker);
    }
}

/**
 * Show or hide the padlock in the message bar for the chat that is currently open (§7.1, second placement),
 * so the state is visible during use and not only when choosing a file.
 *
 * Always resets first, so a padlock from a previous chat can never linger over a plaintext one — a stale
 * lock is the §7.2 failure (a false claim of protection) in its most dangerous form.
 * @param {{name: string, directory: string, group?: boolean}|null} chat The open chat, or null if none is
 * @returns {Promise<void>}
 */
export async function updateChatHeaderMarker(chat) {
    const icon = document.getElementById('chatEncryptedMarker');
    if (!icon) {
        return;
    }

    // 🔴 RESETTING FIRST ONLY DEFENDS AGAINST ORDERED REPLIES, AND THESE ARE NOT ORDERED. CHAT_CHANGED
    // fires this per switch without awaiting it, so switching from an encrypted chat to a plaintext one
    // leaves two POSTs in flight. The plaintext one resets and returns at `kind === 'none'`, touching
    // nothing; if the encrypted one then lands second — different file sizes, different provider work,
    // separate connections, no ordering guarantee — it writes its padlock over the chat the user is now
    // looking at. A green lock captioned "your data is encrypted", on a chat that is not. That is the
    // §7.2 failure in its most dangerous form, which is exactly what the comment above says must not
    // happen. So each call takes a ticket, and only the newest one is allowed to draw.
    const ticket = ++headerMarkerTicket;

    icon.style.display = 'none';
    icon.removeAttribute('title');
    icon.classList.remove('select_chat_block_marker_unavailable');

    // A group chat has no character directory and never will — the directory is flat — so requiring one
    // would mean the marker silently never draws for a group, which is the failure this whole module is
    // written to avoid rather than a safe default.
    if (!chat?.name || (!chat.group && !chat.directory)) {
        return;
    }

    const status = await fetchChatStatus([{ name: chat.name, directory: chat.directory }], chat.group === true);

    // A newer switch has already reset the icon and is answering for a different chat. Anything written
    // from here would be that chat's marker under this one's name.
    if (ticket !== headerMarkerTicket) {
        return;
    }

    const marker = typeof status?.marker === 'string' ? status.marker : '';
    const result = resolveChatMarker(status?.chats?.[chat.name], marker);

    if (result.kind === 'none') {
        return;
    }

    if (result.kind === 'unavailable') {
        icon.classList.add('select_chat_block_marker_unavailable');
    }

    icon.setAttribute('title', result.title);
    icon.style.display = '';
}
