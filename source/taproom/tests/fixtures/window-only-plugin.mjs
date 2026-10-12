import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT DECLARES A PROMPT WINDOW AND REGISTERS NO PANEL AT ALL.
 *
 * This fixture exists to hold one shape honest. §14.2(b)'s client endpoint was first specced as a bare array
 * of panels; §17.6 then needed a per-plugin turn count to travel OUTWARD to the client, and anything keyed off
 * panels would have silently dropped exactly this plugin — the one with a window and no button. The endpoint
 * is keyed by capability instead, and `prompts` is a SIBLING of `panels` rather than a field inside it.
 *
 * If someone later collapses the two, this plugin disappears from the client's view of the world and its
 * window is never sent. The test that reads `prompts` for this id is what notices.
 */

export const info = {
    id: 'window-only',
    name: 'Window Only',
    description: 'Declares a recent-message window and nothing else. Test fixture.',
};

/**
 * @param {import('express').Router} _router The plugin's own router
 * @param {any} context The context the fork provides
 * @returns {Promise<void>}
 */
export async function init(_router, context) {
    // Another suite's shim may be sitting in the shared plugins/ directory while THIS suite's server boots
    // (see fixture-gate.mjs). Registering from here would rewrite that suite's prompts and fail its
    // assertions, so a fixture nobody asked for does nothing at all.
    if (!fixtureIsEnabled("window-only")) {
        return;
    }
    context.onPrompt(async () => undefined, { recentMessages: 7 });
}
