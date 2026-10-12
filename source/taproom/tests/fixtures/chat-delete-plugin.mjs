import fs from 'node:fs';

import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * Probe for §24 — `context.onChatDeleted`.
 *
 * Journals one line per signal, so the suite can assert on **which** chats were announced and, just as
 * importantly, which were not. The negative case matters more than the positive one here: a card deleted
 * WITHOUT its chats must announce nothing, and a bug there destroys live memories for a chat that still
 * exists on disk.
 */

/** Where the journal goes. Set by the test, across the process boundary — plugins run in the child. */
const journalPath = process.env.ST_PLUGIN_JOURNAL ?? '';

export const info = {
    id: 'chat-delete-probe',
    name: 'chat delete probe',
    description: 'Records chat-deleted signals (§24).',
};

/**
 * @param {import('express').Router} _router Unused
 * @param {any} context The plugin context
 */
export async function init(_router, context) {
    if (!fixtureIsEnabled('chat-delete-probe')) {
        return;
    }

    if (journalPath) {
        fs.appendFileSync(journalPath, `onChatDeleted: ${typeof context.onChatDeleted}\n`, 'utf-8');
    }

    context.onChatDeleted((handle, chatId) => {
        if (journalPath) {
            fs.appendFileSync(journalPath, `deleted ${handle} ${chatId}\n`, 'utf-8');
        }
    });
}
