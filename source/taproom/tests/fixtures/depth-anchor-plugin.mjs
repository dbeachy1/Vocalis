import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT DECLARES A WINDOW BIG ENOUGH TO HOLD THE WHOLE SEEDED CHAT (§27).
 *
 * The depth anchor rides `st_recent_messages`, and the client sends that field **only when some plugin has
 * declared a window** (§17.6 — the fork ships no default, on purpose). So a browser spec that boots a stock
 * server gets no window, no offsets, and an assertion that fails for a reason that has nothing to do with the
 * anchor. That is exactly how the first run of `plugin-depth-anchor.e2e.js` failed.
 *
 * ⚠️ IT DOES NOT REUSE `window-only`, WHICH DECLARES 7. The spec's fixture chat is eight turns plus the one
 * being sent, and a window of 7 would silently drop the oldest turns — so an assertion about "every turn was
 * placed" would be measuring the window size rather than the threading. 20 covers the fixture with room to
 * spare, and the number is this spec's own so neither suite can move the other's.
 *
 * ⚠️ AND IT DECLINES EVERY PROMPT. Returning nothing is the documented way to sit out a generation (§6), so
 * the prompt the spec reads off the wire is the one SillyTavern built — not one this fixture edited.
 */

export const info = {
    id: 'depth-anchor',
    name: 'Depth Anchor',
    description: 'Declares a large recent-message window so the depth anchor is on the wire. Test fixture.',
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
    if (!fixtureIsEnabled('depth-anchor')) {
        return;
    }

    context.onPrompt(async () => undefined, { recentMessages: 20 });
}
