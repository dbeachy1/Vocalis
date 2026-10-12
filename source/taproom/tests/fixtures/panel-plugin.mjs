import fs from 'node:fs';
import { fixtureIsEnabled } from './fixture-gate.mjs';

/**
 * 🔴 A PLUGIN THAT REGISTERS UI PANELS, AND RECORDS WHAT THE FORK DID WITH THEM.
 *
 * Two things this exists to catch, neither of which a "does it return 200" test would notice:
 *
 * 1. **A registration that is silently dropped.** The whole point of §14 is that a plugin gets a button it
 *    could not otherwise draw. A `registerPanel` that accepts a spec and never surfaces it looks exactly like
 *    a plugin that chose not to register — which is why this fixture registers TWO panels and the suite
 *    asserts on all of them, in order.
 * 2. **A bad spec that is accepted.** §14.2 says a malformed registration must throw in `init`, named, rather
 *    than produce a button that does nothing when clicked days later. A validator that quietly tolerates a
 *    missing `panelPath` passes every happy-path test ever written, so the failures are journalled here as
 *    first-class evidence.
 *
 * It also serves a fragment containing a `<script>` tag. Server-side that is just bytes; the fork must NOT
 * sanitize on the way out (sanitizing is the client host's job, §14.5). The e2e half asserts the script never
 * executes — this half asserts the fork did not silently rewrite a plugin's HTML behind its back.
 */

/** Where the journal goes. Set by the test, across the process boundary, because plugins run in the child. */
const journalPath = process.env.ST_PLUGIN_JOURNAL ?? '';

/**
 * Write one line to the journal.
 * @param {string} what What happened
 * @returns {void}
 */
function journal(what) {
    if (journalPath) {
        fs.appendFileSync(journalPath, `${what}\n`, 'utf-8');
    }
}

/**
 * The fragment served by /panel. The hostile payload is deliberate — see the header.
 *
 * 🔴 `<img onerror>`, NOT `<script>`, AND THE DIFFERENCE IS THE WHOLE TEST. A `<script>` tag injected via
 * `innerHTML` **never executes** — that is the HTML5 spec, not a sanitizer doing its job. A probe built from
 * one therefore passes identically whether DOMPurify runs or not, which is a vacuously green test asserting
 * nothing. (Ours was exactly that until a mutation run caught it: removing the `sanitize()` call did not fail
 * a single test.) An `onerror` handler on a broken image DOES fire on innerHTML insertion, so it distinguishes
 * a sanitized fragment from an unsanitized one — which is the claim §14.5 actually makes.
 */
export const PANEL_FRAGMENT = '<p id="probe-fragment">panel body</p><img src="x" onerror="window.PANEL_PROBE_RAN = true">'
    // 🔴 `<style>` IS THE SECOND HALF OF THE SAME CLAIM, and it distinguishes exactly as `onerror` does above.
    // `style` is in DOMPurify's DEFAULT `ALLOWED_TAGS`, so this block used to survive verbatim — and the popup
    // is in the document, so the rule was document-wide and this really did hide SillyTavern's own send button.
    // The target is host chrome ON PURPOSE: a rule confined to the panel would prove nothing.
    + '<style>#send_but { display: none !important; }</style>'
    // Carries a class the plugin's own stylesheet styles, so the e2e can tell an injected sheet from none.
    + '<p class="probe-styled">styled by the plugin</p>';

export const info = {
    id: 'panel-probe',
    name: 'Panel Probe',
    description: 'Registers UI panels and records what the fork made of them. Test fixture.',
};

/**
 * @param {import('express').Router} router The plugin's own router
 * @param {any} context The context the fork provides
 * @returns {Promise<void>}
 */
export async function init(router, context) {
    // Another suite's shim may be sitting in the shared plugins/ directory while THIS suite's server boots
    // (see fixture-gate.mjs). Registering from here would rewrite that suite's prompts and fail its
    // assertions, so a fixture nobody asked for does nothing at all.
    if (!fixtureIsEnabled('panel-probe')) {
        return;
    }
    if (typeof context?.registerPanel !== 'function') {
        journal('registerPanel: MISSING');
        return;
    }

    // Whatever the panel route was last asked about, so the suite can prove ?chatId= arrives (§14.4).
    let lastChatId = 'none';

    router.get('/panel', (request, response) => {
        lastChatId = typeof request.query.chatId === 'string' ? request.query.chatId : 'none';
        response.type('html').send(PANEL_FRAGMENT);
    });

    router.get('/status', (request, response) => {
        response.json({ active: request.query.chatId === 'lit-chat', count: 3 });
    });

    router.get('/status-presentation', async (request, response) => {
        const isChat = request.query.backend === 'chat';

        // Make the disabled response slower so the browser test proves an obsolete Chat Completion poll cannot
        // overwrite a newer Text Completion response when the user switches APIs quickly.
        if (isChat) {
            await new Promise(resolve => setTimeout(resolve, 150));
        }

        response.json(isChat ? {
            active: false,
            disabled: true,
            count: 0,
            color: '#555b63',
            tooltip: 'disabled while structured work mode is active',
        } : { active: false, count: 0 });
    });

    // The panel's own CSS. The second rule reaches for HOST CHROME on purpose — it is what an unscoped
    // plugin stylesheet could do to the whole application, and the host's `@scope` wrapper must leave it
    // matching nothing.
    //
    // 🔴 `#send_but`, NOT `:root { --SmartThemeBodyColor }`. The obvious probe is a plugin overriding a theme
    // variable, and it is VACUOUS: SillyTavern sets those variables as INLINE styles on `documentElement`,
    // which beat any stylesheet rule whether it is scoped or not. That probe passed with the `@scope` wrapper
    // deliberately removed. An id selector against an element outside the panel distinguishes properly.
    router.get('/panel.css', (_request, response) => {
        response.type('css').send('.probe-styled { color: rgb(1, 2, 3); } #send_but { display: none !important; }');
    });

    // Lets the suite read back what the panel route saw without a second boot.
    router.get('/last-chat-id', (_request, response) => response.type('text').send(lastChatId));

    // Capability 18 (§26): raise a notification on demand, so the e2e half can prove a PUSHED colour reaches
    // the button. Driven by a route rather than at init because the suite needs to observe the before state.
    router.get('/raise', (request, response) => {
        if (typeof context.notify !== 'function') {
            journal('notify: MISSING');
            return response.status(501).type('text').send('no notify');
        }

        context.notify({
            handle: request.user?.profile?.handle,
            action: 'probe.happened',
            data: { count: 9 },
            // Deliberately different from BOTH registered iconColors, so the assertion cannot pass on a
            // registered colour that was simply left alone.
            color: 'rgb(0, 128, 0)',
            summary: 'the probe notified',
        });

        journal('notify: accepted');
        return response.type('text').send('ok');
    });

    // --- The happy path: several panels, so display ORDER is observable and provably registration order. ---

    context.registerPanel({
        icon: '🧠',
        iconColor: '#ff0000',   // ignored for an emoji: its colour is in the font (§14.3.1)
        label: 'First Panel',
        tooltip: 'the first one',
        panelPath: '/panel',
        statusPath: '/status',
        // A plugin has no other channel for CSS: it renders into a document whose stylesheet it does not own.
        // Resolved under the plugin's own mount exactly as the other two paths are.
        stylesheetPath: '/panel.css',
    });
    journal('registerPanel emoji: accepted');

    context.registerPanel({
        icon: 'fa-solid fa-brain',
        iconColor: '#c8a2ff',
        label: 'Second Panel',
        panelPath: '/panel',
        // No statusPath: a panel without status must still get a working button (§14.6).
    });
    journal('registerPanel fontawesome: accepted');

    context.registerPanel({
        icon: 'fa-solid fa-lightbulb',
        iconColor: '#ffffff',
        label: 'Status Presentation Panel',
        tooltip: 'registered fallback tooltip',
        panelPath: '/panel',
        statusPath: '/status-presentation',
    });
    journal('registerPanel status-presentation: accepted');

    // --- The refusals. Each must THROW, in init, naming this plugin. ---

    /**
     * Record whether a bad spec was refused.
     * @param {string} what Which malformation is being tried
     * @param {any} spec The spec to attempt
     * @returns {void}
     */
    const mustRefuse = (what, spec) => {
        try {
            context.registerPanel(spec);
            journal(`registerPanel ${what}: ACCEPTED`);
        } catch (error) {
            // The plugin id in the message is the difference between a usable error and an anonymous stack.
            journal(`registerPanel ${what}: refused, names plugin: ${String(error.message).includes('panel-probe')}`);
        }
    };

    mustRefuse('no spec', undefined);
    mustRefuse('array', []);
    mustRefuse('missing panelPath', { icon: '🧠', label: 'No Path' });
    mustRefuse('missing label', { icon: '🧠', panelPath: '/panel' });
    mustRefuse('empty icon', { icon: '', label: 'Empty', panelPath: '/panel' });
    mustRefuse('relative panelPath', { icon: '🧠', label: 'Relative', panelPath: 'panel' });
    mustRefuse('relative statusPath', { icon: '🧠', label: 'Relative', panelPath: '/panel', statusPath: 'status' });
    mustRefuse('relative stylesheetPath', { icon: '🧠', label: 'Relative', panelPath: '/panel', stylesheetPath: 'panel.css' });

    // A leading slash is not the boundary — the RESOLVED path is. Each of these prefixes cleanly onto
    // /api/plugins/panel-probe and still lands somewhere else once a browser normalises it away.
    mustRefuse('escaping panelPath', { icon: '🧠', label: 'Escape', panelPath: '/../other-plugin/panel' });
    mustRefuse('escaping statusPath', { icon: '🧠', label: 'Escape', panelPath: '/panel', statusPath: '/../../characters/all' });
    mustRefuse('escaping stylesheetPath', { icon: '🧠', label: 'Escape', panelPath: '/panel', stylesheetPath: '/%2e%2e/other/panel.css' });
    mustRefuse('escaping panelPath (backslash)', { icon: '🧠', label: 'Escape', panelPath: '/..\\other-plugin/panel' });
}
