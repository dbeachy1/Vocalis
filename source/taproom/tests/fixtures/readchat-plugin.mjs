import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * Probe for plugin API v7 — `context.readChat`, called the way a panel route calls it.
 *
 * ⚠️ IT RUNS ON A ROUTE, NOT ON `onStorageReady`, for the reason `readcard-plugin.mjs` gives: the seam provider
 * is ready from boot, so a hook-driven probe would never run and the suite would pass having tested nothing.
 */

export const info = {
    id: 'readchat-probe',
    name: 'readChat probe',
    description: 'Exercises context.readChat (plugin API v7).',
};

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The plugin context
 */
export async function init(router, context) {
    if (!fixtureIsEnabled('readchat-probe')) {
        return;
    }

    /**
     * What a call did: its JSON result, `NULL`, or `THREW <message>` — null and a throw kept apart, because the
     * contract turns on the difference.
     * @param {() => Promise<any>} attempt The call
     * @returns {Promise<any>}
     */
    async function probe(attempt) {
        try {
            const result = await attempt();
            return result === null ? 'NULL' : result;
        } catch (error) {
            return `THREW ${error?.name}: ${error?.message ?? error}`;
        }
    }

    router.get('/probe', async (request, response) => {
        // The handle from the session, and the chat id from the query — exactly what a panel action has.
        const handle = String(request.query.handle ?? '');
        const chatId = String(request.query.chatId ?? '');

        response.json({
            apiVersion: context.apiVersion,
            present: typeof context.readChat,
            solo: await probe(() => context.readChat(handle, chatId)),
            last: await probe(() => context.readChat(handle, chatId, { last: 1 })),
            group: await probe(() => context.readChat(handle, String(request.query.groupId ?? ''))),
            unknown: await probe(() => context.readChat(handle, 'no such chat')),
            badLast: await probe(() => context.readChat(handle, chatId, { last: 0 })),
            badLastType: await probe(() => context.readChat(handle, chatId, { last: '5' })),
            badOptions: await probe(() => context.readChat(handle, chatId, 'last')),
            climbing: await probe(() => context.readChat(handle, '../escape')),
            badHandle: await probe(() => context.readChat('../elsewhere', chatId)),
        });
    });
}
