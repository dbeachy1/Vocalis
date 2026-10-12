/**
 * Plugin UI panels — a server plugin registers an icon, the bundled front-end draws it.
 *
 * The client-side mirror of `generation-interceptors.js`: that module lets a server plugin take part in
 * generation, this one lets it surface something a user can *see*. A server plugin gets an Express router and
 * nothing that renders — it cannot draw a pixel, because the page is a separate program (§14.0). So the fork
 * ships one generic button host and this registry tells it what to draw.
 *
 * 🔴 THE FORK LEARNS NOTHING ABOUT WHAT THE PANEL IS FOR. It renders what the plugin returns and lights what
 * the plugin flags. Memory is merely consumer #1 — see §3 and §14.1 of DESIGN_MEMORY_PLUGIN_API.md. Nothing in
 * this file may grow a special case for a particular plugin.
 *
 * A bad registration THROWS, and does so at registration rather than at render time. A plugin that misspells
 * `panelPath` should find out while its `init` runs, named, and not by a user clicking a button that silently
 * does nothing three days later — the §6.5 fail-loud rule, applied to setup instead of to prompts.
 */

import { resolveMountedPath, requiredString } from './plugin-mount-path.js';

/** What this registry calls itself in a refusal message. Kept verbatim so existing messages do not change. */
const WHAT = 'a panel';

/**
 * A registered panel, as the front-end will receive it.
 * @typedef {object} RegisteredPanel
 * @property {string} id The plugin that registered it
 * @property {string} icon Emoji, or a FontAwesome class list
 * @property {'emoji'|'class'} iconType Which of the two `icon` is, decided here so the client need not sniff
 * @property {string} [iconColor] CSS color, honoured for `iconType === 'class'` only
 * @property {string} label aria-label and popup title
 * @property {string} [tooltip] Hover text
 * @property {string} panelUrl Absolute path the client GETs for the panel fragment
 * @property {string} [statusUrl] Absolute path the client polls for
 *   `{ active, count?, color?, tooltip? }`
 * @property {string} [stylesheetUrl] Absolute path the client GETs for the panel's own CSS (§10.3)
 */

/** @type {RegisteredPanel[]} */
const panels = [];

/**
 * Which kind of button face is this?
 *
 * §14.3.1: an emoji cannot be recoloured (its colour is in the font), a FontAwesome glyph can. The fork already
 * bundles FontAwesome for every control in the application, so the class form costs no dependency and no asset
 * fetch. Decided here, once, so the client does not reimplement the sniff and drift from it.
 * @param {string} icon The registered icon string
 * @returns {'emoji'|'class'} Which form it is
 */
function classifyIcon(icon) {
    return /\s/.test(icon) || icon.startsWith('fa-') ? 'class' : 'emoji';
}

/**
 * Register a panel for a plugin.
 *
 * ⚠️ `id` IS SUPPLIED BY THE LOADER, NOT THE PLUGIN. `createPluginContext` closes over it, so a plugin cannot
 * register a panel that claims to belong to somebody else — the same discipline `onPrompt` uses for its log
 * lines.
 * @param {string} id The registering plugin's ID
 * @param {{icon: string, iconColor?: string, label: string, tooltip?: string, panelPath: string, statusPath?: string, stylesheetPath?: string}} spec
 * @returns {void}
 */
export function register(id, spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new TypeError(`Plugin '${id}' called context.registerPanel() with something other than a spec object`);
    }

    const required = (name) => requiredString(id, WHAT, spec, name);

    const icon = required('icon');
    const label = required('label');
    const panelPath = required('panelPath');

    // §14.7 and §6.2, both now stated once in `plugin-mount-path.js` — `registerSettings` needs the identical
    // rule, and a boundary check with two copies is a boundary check that drifts.
    const relative = (name, value) => resolveMountedPath(id, WHAT, name, value);

    /** @type {RegisteredPanel} */
    const entry = {
        id,
        icon,
        iconType: classifyIcon(icon),
        label,
        panelUrl: relative('panelPath', panelPath),
    };

    if (typeof spec.iconColor === 'string' && spec.iconColor !== '') {
        entry.iconColor = spec.iconColor;
    }
    if (typeof spec.tooltip === 'string' && spec.tooltip !== '') {
        entry.tooltip = spec.tooltip;
    }
    if (spec.statusPath !== undefined) {
        entry.statusUrl = relative('statusPath', required('statusPath'));
    }

    // §10.3. A plugin renders into a document whose stylesheet it does not own and cannot extend, so every
    // class it emits matches nothing unless the host happens to ship a rule for it. That is not a cosmetic
    // gap: Mnemosyne's month grid arrived as one run-on line of digits, and its scope selector showed three
    // identical buttons with no indication which filter the list was under — a filtered view that looked
    // unfiltered. The failure is silent, with a 200, and passes every test.
    //
    // 🔴 THE HOST DOES THE SCOPING, NOT THE PLUGIN — see `injectStylesheet` on the client. This field is a
    // path, not CSS: what arrives is fetched from the plugin's own router like every other panel route, so
    // the same §6.2 rule applies and a fragment can no more supply a stylesheet than it can supply an
    // action URL.
    if (spec.stylesheetPath !== undefined) {
        entry.stylesheetUrl = relative('stylesheetPath', required('stylesheetPath'));
    }

    panels.push(entry);
}

/**
 * Every registered panel, in registration order.
 *
 * Order is registration order and that is deliberate rather than incidental, exactly as it is for interceptors
 * (`generation-interceptors.js`): two plugins both drawing a button will notice each other's position, so the
 * rule is stated instead of left to chance.
 * @returns {RegisteredPanel[]} A copy, so a caller cannot reorder the registry
 */
export function listPanels() {
    return panels.map(panel => ({ ...panel }));
}

/**
 * Did anybody register?
 *
 * The front-end asks so that a stock SillyTavern with no plugins draws no host at all.
 * @returns {boolean} True if at least one panel is registered
 */
export function hasPanels() {
    return panels.length > 0;
}

/**
 * Forget every registered panel. Tests only.
 *
 * The §12.7 lesson: a test that installs a fixture plugin and does not unregister leaves a live registration
 * in the process for every suite that follows it.
 * @returns {void}
 */
export function clearPanels() {
    panels.length = 0;
}
