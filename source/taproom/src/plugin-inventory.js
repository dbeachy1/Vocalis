/**
 * Track every server-plugin load attempt for the Extensions dialog, including plugins without UI settings.
 * Non-admins receive only a safe error code or type name; full messages may expose server paths and are
 * available to admins through `/api/plugins/diagnostics` and to the log.
 * @see plugin-loader.js
 */

/**
 * Accept only short constant-like codes. Uppercase type names for comparison so built-ins such as `TypeError`
 * pass, while path-like values fail closed.
 */
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * One load attempt.
 * @typedef {object} PluginRecord
 * @property {string} source The top-level name in the plugins directory — the stable key for one attempt
 * @property {string} [id] The plugin's declared ID, absent when it never got far enough to have one
 * @property {string} name Display name; falls back to `source` when the manifest was never read
 * @property {string} [description] From the plugin's `info`
 * @property {string} [version] From the plugin's `info`, when it declares one
 * @property {'loaded'|'failed'} status
 * @property {'import'|'manifest'|'init'} [stage] Where it failed. Absent when it loaded
 * @property {string} [code] The error's `code` or type name, when one passed {@link SAFE_CODE_PATTERN}
 * @property {string} [message] The full error message. ADMIN-ONLY — never leaves {@link listForAdmin}
 */

/** @type {PluginRecord[]} */
const records = [];

/**
 * The error's code or type name, if it has one that is safe to show.
 * @param {any} error The thrown value
 * @returns {string|undefined} A short constant, or undefined if nothing qualified
 */
function safeCode(error) {
    if (typeof error?.code === 'string' && SAFE_CODE_PATTERN.test(error.code)) {
        return error.code;
    }

    const name = String(error?.name ?? '');

    return SAFE_CODE_PATTERN.test(name.toUpperCase()) ? name : undefined;
}

/**
 * Record a plugin that started cleanly.
 * @param {string} source The top-level plugins-directory entry it came from
 * @param {{id: string, name: string, description?: string, version?: string}} info The plugin's own manifest
 * @returns {void}
 */
export function recordLoaded(source, info) {
    /** @type {PluginRecord} */
    const record = {
        source,
        id: info.id,
        name: info.name,
        status: 'loaded',
    };

    if (typeof info.description === 'string' && info.description !== '') {
        record.description = info.description;
    }

    // Optional in the manifest and not required by the loader, so most plugins will have none. Reported when
    // present because "which version is running" is half of every support conversation.
    if (typeof info.version === 'string' && info.version !== '') {
        record.version = info.version;
    }

    records.push(record);
}

/**
 * Record a failed load attempt. The declared id and manifest fields may be unavailable when import or manifest
 * loading fails, so `source` remains the stable identifier.
 * @param {string} source The top-level plugins-directory entry it came from
 * @param {'import'|'manifest'|'init'} stage Where it failed
 * @param {any} error The thrown value
 * @param {{id?: string, name?: string, description?: string, version?: string}} [info] Whatever was known
 * @returns {void}
 */
export function recordFailure(source, stage, error, info = {}) {
    /** @type {PluginRecord} */
    const record = {
        source,
        name: info.name || source,
        status: 'failed',
        stage,
    };

    if (typeof info.id === 'string' && info.id !== '') {
        record.id = info.id;
    }

    if (typeof info.description === 'string' && info.description !== '') {
        record.description = info.description;
    }

    const code = safeCode(error);

    if (code) {
        record.code = code;
    }

    const message = String(error?.message ?? error ?? '');

    if (message !== '') {
        record.message = message;
    }

    records.push(record);
}

/**
 * Remove failed attempts for directories that later loaded successfully. The loader may fall back from a
 * manifest entry to `index.js`, so only the final load outcome should appear in the inventory.
 * @returns {void}
 */
export function finalize() {
    const loaded = new Set(records.filter(record => record.status === 'loaded').map(record => record.source));

    for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].status === 'failed' && loaded.has(records[i].source)) {
            records.splice(i, 1);
        }
    }
}

/**
 * The inventory as any logged-in user may see it — no error messages.
 * @returns {PluginRecord[]} Copies, in load order
 */
export function listPlugins() {
    // eslint-disable-next-line no-unused-vars
    return records.map(({ message, ...rest }) => ({ ...rest }));
}

/**
 * The inventory with the full error text. Admins only — see the header.
 * @returns {PluginRecord[]} Copies, in load order
 */
export function listForAdmin() {
    return records.map(record => ({ ...record }));
}

/**
 * Did anything at all get attempted?
 *
 * The client asks so that a stock SillyTavern with no plugins draws no section, rather than an empty heading.
 * @returns {boolean} True if at least one load was attempted
 */
export function hasPlugins() {
    return records.length > 0;
}

/**
 * Forget everything. Tests only — the §12.7 lesson, applied to one more registry.
 * @returns {void}
 */
export function clearInventory() {
    records.length = 0;
}
