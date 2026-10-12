/**
 * Where a plugin is allowed to point, and the one place that decides it.
 *
 * A plugin registers PATHS — a panel to fetch, a stylesheet to load, a settings fragment to show — and the
 * fork turns each into a URL the browser will request carrying the user's session cookie and CSRF token. So
 * "does this path stay inside the plugin's own mount" is a security boundary, not a typo check, and it was
 * written out longhand inside `plugin-panels.js` while it had exactly one caller.
 *
 * 🔴 EXTRACTED THE MOMENT IT GOT A SECOND CALLER, AND THAT IS THE WHOLE REASON THIS FILE EXISTS. A copied
 * boundary check is a boundary check that drifts: the copy is correct on the day it is made and then someone
 * hardens one of them. `registerSettings` (§28) needs the identical rule, so it calls the identical function.
 *
 * @see plugin-panels.js
 * @see plugin-settings.js
 */

/**
 * Resolve a plugin-supplied path against that plugin's own mount, refusing anything that leaves it.
 *
 * 🔴 THE PREFIX IS ONLY A BOUNDARY ONCE THE PATH IS RESOLVED. A registered `/../other-plugin/panel` prefixes
 * cleanly and still leaves this mount, because the browser normalises the `..` away before it sends the
 * request — landing on another plugin's router with the user's session and CSRF token. Prefixing is what the
 * design doc states as the rule; resolving here is what makes that sentence true. Parsed with the URL parser
 * rather than by hand so the `%2e%2e` and backslash spellings, which the browser also collapses, are covered
 * by the same check.
 *
 * ⚠️ THROWS, AND THE CALLER IS EXPECTED TO LET IT. Registration happens inside a plugin's `init`, so a
 * refusal lands on the author while they are looking at it — the alternative is a button, or a settings row,
 * that silently does nothing until a user clicks it days later.
 * @param {string} id The registering plugin's ID, as the loader closed over it
 * @param {string} what What is being registered, for the message ('a panel', 'settings')
 * @param {string} name The spec field being resolved, for the message
 * @param {string} value The path the plugin supplied
 * @returns {string} The absolute, mounted path
 */
export function resolveMountedPath(id, what, name, value) {
    // The plugin owns its route NAMES — the fork never hard-codes `/panel`. But it does own the MOUNT, so a
    // path that does not start at the root of the plugin's own router is a mistake worth naming.
    if (!value.startsWith('/')) {
        throw new TypeError(`Plugin '${id}' registered ${what} whose '${name}' must start with '/' — it is relative to /api/plugins/${id} (got ${JSON.stringify(value)})`);
    }

    const mounted = `/api/plugins/${id}${value}`;
    const resolved = new URL(mounted, 'http://localhost').pathname;

    if (!`${resolved}/`.startsWith(`/api/plugins/${id}/`)) {
        throw new TypeError(`Plugin '${id}' registered ${what} whose '${name}' does not resolve inside /api/plugins/${id} (got ${JSON.stringify(value)}, resolves to ${JSON.stringify(resolved)})`);
    }

    return mounted;
}

/**
 * Read a required string field off a registration spec.
 *
 * Shared for the same reason {@link resolveMountedPath} is: two registries validating "non-empty string"
 * two different ways is how one of them ends up accepting `' '`.
 * @param {string} id The registering plugin's ID
 * @param {string} what What is being registered, for the message
 * @param {any} spec The spec object
 * @param {string} name The field to read
 * @returns {string} The field's value
 */
export function requiredString(id, what, spec, name) {
    const value = spec?.[name];

    if (typeof value !== 'string' || value === '') {
        throw new TypeError(`Plugin '${id}' registered ${what} without a valid '${name}' (got ${JSON.stringify(value)})`);
    }

    return value;
}
