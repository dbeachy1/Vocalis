import { getRequestHeaders } from '../script.js';
import { t } from './i18n.js';
import { getPluginClientConfig } from './plugin-client-config.js';
import { fetchPluginFragment, mountPluginFragment, sanitizePanel } from './plugin-panels.js';

/**
 * Render the server-plugin inventory and registered settings in the Extensions dialog. Plugins may run
 * without a panel, so this inventory also exposes load and startup failures. Keep it generic: display only
 * the records and fragments supplied by the server.
 * @see src/plugin-inventory.js
 * @see src/plugin-settings.js
 */

/** The container id a plugin's settings fragment gets, and therefore the `@scope` root of its stylesheet. */
function settingsContainerId(id) {
    return `pluginSettings-${id}`;
}

/**
 * Teardown callbacks for expanded fragments. Run them before removing their containers so the shared action
 * slot in `plugin-panels.js` cannot retain a detached fragment.
 * @type {Set<() => void>}
 */
const mountedFragments = new Set();

/**
 * Take down every expanded settings fragment. Called when the Extensions dialog closes.
 * @returns {void}
 */
export function teardownServerPlugins() {
    for (const teardown of mountedFragments) {
        try {
            teardown();
        } catch (error) {
            console.error('A plugin settings fragment failed to unmount.', error);
        }
    }

    mountedFragments.clear();
}

/**
 * Fetch detailed diagnostics only when the server authorizes them. Messages can contain filesystem paths, so
 * the server enforces admin access; a 403 simply leaves the non-admin with the failure stage and plugin name.
 * @returns {Promise<Map<string, string>>} Source name → message, empty for a non-admin or an older server
 */
async function fetchDiagnostics() {
    try {
        const response = await fetch('/api/plugins/diagnostics', { method: 'GET', headers: getRequestHeaders() });

        if (!response.ok) {
            return new Map();
        }

        const body = await response.json();
        const rows = Array.isArray(body?.serverPlugins) ? body.serverPlugins : [];

        return new Map(rows.filter(row => row?.message).map(row => [row.source, String(row.message)]));
    } catch (error) {
        console.debug('Plugin diagnostics are unavailable.', error);
        return new Map();
    }
}

/**
 * Expand or collapse one plugin's settings, fetching the fragment the first time it is opened.
 * @param {object} registration The settings registration from the server
 * @param {HTMLElement} body The element the fragment renders into
 * @param {HTMLElement} toggle The control that was activated, so its state can follow
 * @returns {Promise<void>}
 */
async function toggleSettings(registration, body, toggle) {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';

    if (expanded) {
        // Unmount and refetch on the next open so changes from another tab are visible.
        for (const teardown of mountedFragments) {
            teardown();
        }

        mountedFragments.clear();
        body.innerHTML = '';
        body.classList.add('displayNone');
        toggle.setAttribute('aria-expanded', 'false');
        return;
    }

    body.classList.remove('displayNone');
    toggle.setAttribute('aria-expanded', 'true');
    body.textContent = t`Loading...`;

    /** @type {{ok: boolean, status: number, html: string}} */
    let fragment;

    try {
        fragment = await fetchPluginFragment(registration.settingsUrl);
    } catch (error) {
        console.error(`Plugin '${registration.id}' could not be asked for its settings.`, error);
        body.innerHTML = sanitizePanel(`<p class="pluginSettings_problem">${t`These settings could not be loaded.`}</p>`);
        return;
    }

    const html = fragment.html ?? '';

    // A non-empty 503 fragment can explain an expected unavailable state, such as a locked vault. Preserve
    // the plugin's message instead of showing defaults that could overwrite its configuration.
    const speaksForItself = (fragment.ok || fragment.status === 503) && html.trim() !== '';

    if (!speaksForItself) {
        // Other failures and empty responses indicate a broken route, not an empty settings form.
        body.innerHTML = sanitizePanel(`<p class="pluginSettings_problem">${t`These settings could not be loaded.`} <small>(${fragment.status})</small></p>`);
        return;
    }

    body.innerHTML = '';

    const teardown = await mountPluginFragment({
        host: {
            id: registration.id,
            label: registration.label,
            containerId: settingsContainerId(registration.id),
            stylesheetUrl: registration.stylesheetUrl,
        },
        container: body,
        html,
        // The dialog owns scrolling; this fragment has no separate scroller to restore.
        scroller: null,
    });

    mountedFragments.add(teardown);
}

/**
 * Build one plugin's row.
 * @param {object} plugin The inventory record
 * @param {object|undefined} registration Its settings registration, if it made one
 * @param {string|undefined} message The full error text, if this user may see it
 * @returns {HTMLElement}
 */
function buildRow(plugin, registration, message) {
    const block = document.createElement('div');
    block.classList.add('serverPlugin_block');
    block.classList.toggle('serverPlugin_failed', plugin.status === 'failed');
    block.dataset.source = plugin.source;

    const header = document.createElement('div');
    header.classList.add('serverPlugin_header');

    const heading = document.createElement('div');
    heading.classList.add('serverPlugin_heading');

    const name = document.createElement('span');
    name.classList.add('serverPlugin_name');
    name.textContent = plugin.name;

    const version = document.createElement('span');
    version.classList.add('serverPlugin_version');
    version.textContent = plugin.version ? `v${plugin.version}` : '';

    heading.append(name, version);

    const status = document.createElement('span');
    status.classList.add('serverPlugin_status');

    if (plugin.status === 'loaded') {
        status.classList.add('serverPlugin_status_loaded');
        status.textContent = t`Loaded`;
    } else {
        status.classList.add('serverPlugin_status_failed');
        // Show the failure stage separately so users can distinguish load, manifest, and startup errors.
        status.textContent = {
            import: t`Failed to load`,
            manifest: t`Invalid plugin`,
            init: t`Failed to start`,
        }[plugin.stage] ?? t`Failed`;
    }

    header.append(heading, status);
    block.append(header);

    if (plugin.description) {
        const description = document.createElement('div');
        description.classList.add('serverPlugin_description');
        description.textContent = plugin.description;
        block.append(description);
    }

    if (plugin.status === 'failed') {
        const detail = document.createElement('div');
        detail.classList.add('serverPlugin_error');

        // Plugin identity and error code are safe to show generally; detailed messages are admin-only.
        const parts = [t`In` + ` ${plugin.source}`];

        if (plugin.code) {
            parts.push(plugin.code);
        }

        detail.textContent = message ? `${parts.join(' · ')} — ${message}` : parts.join(' · ');
        block.append(detail);
    }

    if (registration) {
        const toggle = document.createElement('div');
        toggle.classList.add('menu_button', 'menu_button_icon', 'serverPlugin_settingsToggle');
        toggle.setAttribute('role', 'button');
        toggle.tabIndex = 0;
        toggle.setAttribute('aria-expanded', 'false');

        const icon = document.createElement('i');
        icon.classList.add('fa-solid', 'fa-sliders');

        const label = document.createElement('span');
        label.textContent = registration.label;

        toggle.append(icon, label);

        const body = document.createElement('div');
        body.classList.add('serverPlugin_settingsBody', 'displayNone');

        const activate = () => void toggleSettings(registration, body, toggle);

        toggle.addEventListener('click', activate);
        toggle.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
            }
        });

        if (registration.description) {
            const hint = document.createElement('div');
            hint.classList.add('serverPlugin_description');
            hint.textContent = registration.description;
            block.append(hint);
        }

        block.append(toggle, body);
    }

    return block;
}

/**
 * Build the section, or return null when no server plugins are installed.
 * @returns {Promise<HTMLElement|null>} The section, ready to append to the dialog
 */
export async function buildServerPluginsSection() {
    const config = await getPluginClientConfig();
    const plugins = Array.isArray(config?.serverPlugins) ? config.serverPlugins : [];

    if (plugins.length === 0) {
        return null;
    }

    const registrations = new Map(
        (Array.isArray(config?.settings) ? config.settings : []).map(entry => [entry.id, entry]),
    );

    const failed = plugins.some(plugin => plugin.status === 'failed');
    const messages = failed ? await fetchDiagnostics() : new Map();

    const container = document.createElement('div');
    container.classList.add('marginBot10', 'serverPlugins_info');

    const heading = document.createElement('h3');
    heading.textContent = t`Server Plugins:`;
    container.append(heading);

    // Put failures first so they remain easy to find in a long inventory.
    const ordered = [...plugins].sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed'));

    for (const plugin of ordered) {
        container.append(buildRow(plugin, plugin.id ? registrations.get(plugin.id) : undefined, messages.get(plugin.source)));
    }

    return container;
}
