import fs from 'node:fs';

import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * Probe for §24.4 — `context.onChatRenamed`.
 *
 * Registers for BOTH chat signals and journals each with its own prefix, because the assertion that matters
 * most is a negative one about the other signal: a rename must never arrive as a deletion. A consumer that
 * heard "deleted" for a rename would discard the memories of a chat the user is still in the middle of, which
 * is a worse outcome than the stranded rows §24.4 exists to prevent.
 */

/** Where the journal goes. Set by the test, across the process boundary — plugins run in the child. */
const journalPath = process.env.ST_PLUGIN_JOURNAL ?? '';

export const info = {
    id: 'chat-rename-probe',
    name: 'chat rename probe',
    description: 'Records chat-renamed signals (§24.4).',
};

/**
 * @param {import('express').Router} _router Unused
 * @param {any} context The plugin context
 */
export async function init(_router, context) {
    if (!fixtureIsEnabled('chat-rename-probe')) {
        return;
    }

    if (journalPath) {
        fs.appendFileSync(journalPath, `onChatRenamed: ${typeof context.onChatRenamed}\n`, 'utf-8');
    }

    context.onChatRenamed((handle, oldChatId, newChatId) => {
        if (journalPath) {
            fs.appendFileSync(journalPath, `renamed ${handle} ${oldChatId} -> ${newChatId}\n`, 'utf-8');
        }
    });

    // Registered so the suite can prove a rename does not arrive here. Without this the "no deletion was
    // announced" assertion would pass even if the fork never wired deletion at all.
    context.onChatDeleted((handle, chatId) => {
        if (journalPath) {
            fs.appendFileSync(journalPath, `deleted ${handle} ${chatId}\n`, 'utf-8');
        }
    });
}
