/**
 * Plugin settings — a server plugin declares that it HAS settings, the Extensions dialog hosts them.
 *
 * The sibling of `plugin-panels.js`, and it exists because that one is not enough. A panel is a button beside
 * the chat input: a plugin that has no business owning one — a storage provider, a logging shim, anything
 * that is not conversational — registers no panel, and therefore has no UI at all. No settings, no version,
 * no way for a user to see it is even installed. Worst of all, no failure surface: a plugin that throws in
 * `init` is invisible, and the user gets a SillyTavern that quietly does less than it did yesterday.
 *
 * 🔴 SETTINGS ARE NOT HUNG OFF A PANEL, AND THAT IS THE POINT. A plugin may register settings and no panel,
 * a panel and no settings, both, or neither. Hanging settings off `registerPanel` would fix the case that was
 * never broken and leave the icon-less plugin exactly where it was.
 *
 * 🔴 THE FORK RENDERS WHAT THE PLUGIN RETURNS AND NOTHING ELSE — the same contract `registerPanel` states,
 * for the same reason: the server cannot draw. It is deliberately NOT a declarative schema the fork renders a
 * generic form from, and the reason is not taste:
 *
 *   - A schema forces the FORK to persist the values, and for an encrypted store that is wrong. Mnemosyne's
 *     settings live inside the user's encrypted database, keyed to their vault. The fork holds no key to it
 *     and must not: that is the whole property the store exists to have.
 *   - A schema throws away UI that already works. A plugin with a built, styled, tested settings panel would
 *     have it replaced by a lowest-common-denominator form.
 *
 * ⚠️ AND IT CONCEDES NO TRUST. A server plugin already runs arbitrary Node in the host process; rendering the
 * HTML it returns costs exactly nothing that was not conceded the moment it was installed.
 */

import { resolveMountedPath, requiredString } from './plugin-mount-path.js';

/** What this registry calls itself in a refusal message. */
const WHAT = 'settings';

/**
 * A registered settings declaration, as the front-end will receive it.
 * @typedef {object} RegisteredSettings
 * @property {string} id The plugin that registered it
 * @property {string} label The row's title in the Extensions dialog
 * @property {string} [description] One line under the label, if the plugin wants one
 * @property {string} settingsUrl Absolute path the client GETs for the settings fragment
 * @property {string} [stylesheetUrl] Absolute path the client GETs for the fragment's own CSS
 */

/** @type {RegisteredSettings[]} */
const registrations = [];

/**
 * Register a plugin's settings.
 *
 * ⚠️ `id` IS SUPPLIED BY THE LOADER, NOT THE PLUGIN. `createPluginContext` closes over it, so a plugin cannot
 * register settings that claim to belong to somebody else — the same discipline `registerPanel` uses.
 *
 * ⚠️ ONE REGISTRATION PER PLUGIN, and a second one REPLACES the first rather than adding a row. Panels are a
 * list on purpose (two buttons are two buttons); settings are a plugin's single settings screen, and two rows
 * with the same label in one dialog is a bug every time, never an intent.
 * @param {string} id The registering plugin's ID
 * @param {{label: string, description?: string, settingsPath: string, stylesheetPath?: string}} spec
 * @returns {void}
 */
export function register(id, spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new TypeError(`Plugin '${id}' called context.registerSettings() with something other than a spec object`);
    }

    const label = requiredString(id, WHAT, spec, 'label');
    const settingsPath = requiredString(id, WHAT, spec, 'settingsPath');

    /** @type {RegisteredSettings} */
    const entry = {
        id,
        label,
        settingsUrl: resolveMountedPath(id, WHAT, 'settingsPath', settingsPath),
    };

    if (typeof spec.description === 'string' && spec.description !== '') {
        entry.description = spec.description;
    }

    // Same meaning, same route rule and the same host-side `@scope` wrapper as a panel's. A settings fragment
    // renders INSIDE the Extensions dialog rather than in a popup of its own, so the confinement matters more
    // here, not less: an unscoped sheet would be styling the dialog it is a guest in.
    if (spec.stylesheetPath !== undefined) {
        entry.stylesheetUrl = resolveMountedPath(id, WHAT, 'stylesheetPath', requiredString(id, WHAT, spec, 'stylesheetPath'));
    }

    const existing = registrations.findIndex(registration => registration.id === id);

    if (existing === -1) {
        registrations.push(entry);
    } else {
        registrations[existing] = entry;
    }
}

/**
 * Every settings declaration, in registration order.
 * @returns {RegisteredSettings[]} A copy, so a caller cannot reorder the registry
 */
export function listSettings() {
    return registrations.map(entry => ({ ...entry }));
}

/**
 * Forget every registration. Tests only.
 * @returns {void}
 */
export function clearSettings() {
    registrations.length = 0;
}
