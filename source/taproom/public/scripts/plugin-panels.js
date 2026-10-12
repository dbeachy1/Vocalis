import { DOMPurify } from '../lib.js';

import { characters, getCurrentChatId, getInstructEnvelopeHeader, getRequestHeaders, main_api, this_chid } from '../script.js';
import { getTextGenModel, getTextGenServer, textgenerationwebui_settings } from './textgen-settings.js';
import { getChatCompletionModel, oai_settings } from './openai.js';
import { eventSource, event_types } from './events.js';
import { user_avatar } from './personas.js';
import { getPluginClientConfig, hasPluginClientConfig } from './plugin-client-config.js';
import { POPUP_TYPE, Popup, callGenericPopup } from './popup.js';

/**
 * Generic client host for server-plugin panels. It renders registered buttons and plugin fragments without
 * depending on any particular plugin; server plugins cannot draw into the browser page directly.
 */

const CONTAINER_ID = 'pluginPanelButtons';

/**
 * Bounded delays for checking notifications after generation-end work completes, in milliseconds.
 */
const FOLLOW_UP_DELAYS_MS = [750, 2000, 5000, 10000];

/** @type {Array<object>} Panels as served by /api/plugins/client-config, in registration order. */
let registered = [];

/**
 * Mounted panel buttons paired with their registrations. Store element references because one plugin may
 * register multiple panels and a plugin id alone does not identify a button.
 * @type {Array<{panel: object, button: HTMLElement}>}
 */
let mounted = [];

/**
 * Monotonic identity for a complete status refresh.
 *
 * Chat and API changes can start a new poll while the previous network request is still in flight. Only the
 * newest refresh may paint the buttons; otherwise a slow response for the API the user just left can restore
 * stale presentation and interactivity after the new mode has already answered.
 */
let statusRefreshEpoch = 0;

/**
 * Current chat identity for plugin requests. Omit it when no chat is open, and return parameters so callers
 * merge it safely with queries already present on registered paths.
 * @returns {URLSearchParams} Carrying `chatId`, or empty when no chat is open
 */
function chatIdParams() {
    const params = new URLSearchParams();
    const chatId = getCurrentChatId();

    if (chatId) {
        params.set('chatId', String(chatId));
    }

    return params;
}

/**
 * Map the selected client API to the backend name used by server-plugin status routes. This lets status update
 * immediately when the user changes APIs, before another generation begins.
 * @returns {string|undefined} The current interceptor backend, when the client has selected one
 */
function currentPluginBackend() {
    switch (main_api) {
        case 'openai': return 'chat';
        case 'textgenerationwebui': return 'text';
        case 'kobold':
        case 'koboldhorde': return 'kobold';
        case 'novel': return 'novel';
        default: return main_api || undefined;
    }
}

/** @returns {URLSearchParams} Chat identity plus the API mode visible in the browser right now. */
function statusParams() {
    const params = chatIdParams();
    const backend = currentPluginBackend();

    if (backend) {
        params.set('backend', backend);
    }

    return params;
}

/**
 * Host-owned query keys. Plugin action parameters cannot override request scope; `charAvatar` travels in a
 * header and is not part of this list.
 */
const RESERVED_QUERY_KEYS = ['chatId', 'tz', 'personaId', 'charId'];

/** The region a failed action renders into, if the panel declared one (§7.9). */
const ERROR_REGION = 'panel-error';

/**
 * Active fragment session, or null. It owns the current host and container for delegated actions; teardown must
 * clear it before its container is detached.
 * @type {{host: FragmentHost, container: HTMLElement, scroller: HTMLElement|null, pending: boolean}|null}
 */
let live = null;

/**
 * True while {@link openPanel} is between its first `await` and the popup being on screen.
 *
 * `live` cannot serve as this flag: it is not assigned until after the panel's HTML has arrived, which is
 * precisely the window a key auto-repeat fires in.
 */
let opening = false;

/**
 * Return the character avatar only when the current chat belongs to the selected character. In group chats,
 * `this_chid` can remain set to the last speaker, so chat identity must match before sending character scope.
 * Return undefined when scope is ambiguous; missing scope is safer than attributing a request to the wrong
 * character.
 * @returns {string|undefined} The avatar filename, or undefined in a group / with no character
 */
function currentCharAvatar() {
    const chatId = getCurrentChatId();
    const character = this_chid !== undefined ? characters[this_chid] : undefined;

    return character?.chat && chatId && character.chat === chatId ? character.avatar : undefined;
}

/**
 * Build host-owned request context: the current chat, viewer time zone, and selected persona when available.
 * @returns {URLSearchParams}
 */
function ambientParams() {
    const params = new URLSearchParams();
    const chatId = getCurrentChatId();

    if (chatId) {
        params.set('chatId', String(chatId));
    }
    if (user_avatar) {
        params.set('personaId', String(user_avatar));
    }

    params.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

    return params;
}

/**
 * Merge host context into a registered URL while preserving its existing query. Host-owned values replace
 * conflicting plugin values, so request scope cannot be overridden by registration-time parameters.
 * @param {string} url A registered URL on the plugin's own mount, query and all
 * @returns {string} Path and query, ready to fetch
 */
function withAmbientParams(url) {
    return mergeQuery(url, ambientParams());
}

/**
 * Merge query parameters using `set`, so host values override conflicts and no second query string is added.
 * @param {string} url A registered URL on the plugin's own mount, query and all
 * @param {URLSearchParams} params What the host is adding
 * @returns {string} Path and query, ready to fetch
 */
function mergeQuery(url, params) {
    // Resolve against the page origin for query editing, then return a relative same-origin URL.
    const target = new URL(url, window.location.origin);

    for (const [key, value] of params) {
        target.searchParams.set(key, value);
    }

    return `${target.pathname}${target.search}`;
}

/**
 * Headers for panel fetches and actions. Status polling omits character identity to avoid resolving and
 * decrypting character metadata on every poll.
 * @param {boolean} form True if the body is form-encoded rather than absent
 * @returns {Record<string, string>}
 */
function pluginRequestHeaders(form) {
    const headers = getRequestHeaders({ omitContentType: true });
    const avatar = currentCharAvatar();

    if (avatar) {
        // Header values are latin-1; encode filenames and let the server decode them during identity resolution.
        headers['X-ST-Char-Avatar'] = encodeURIComponent(String(avatar));
    }

    // Text-generation settings let plugin actions call `context.generate()` before another generation runs.
    if (main_api === 'textgenerationwebui') {
        headers['X-ST-Connection'] = encodeURIComponent(JSON.stringify({
            api_type: textgenerationwebui_settings.type,
            api_server: getTextGenServer(textgenerationwebui_settings.type),
            model: getTextGenModel(textgenerationwebui_settings),
        }));

        const envelope = getInstructEnvelopeHeader();
        if (envelope !== undefined) {
            headers['X-ST-Instruct-Envelope'] = envelope;
        }
    }

    // Send the selected source and user-configured URLs; the server resolves fixed URLs and secrets itself.
    if (main_api === 'openai') {
        headers['X-ST-Connection'] = encodeURIComponent(JSON.stringify({
            family: 'chat',
            chat_completion_source: oai_settings.chat_completion_source,
            custom_url: oai_settings.custom_url || '',
            reverse_proxy: oai_settings.reverse_proxy || '',
            model: getChatCompletionModel(),
        }));
    }

    if (form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    return headers;
}

/**
 * Sanitize plugin and host-built panel markup. Forbid `<style>` elements because panel content shares the
 * document and an unscoped rule could affect SillyTavern's UI. Keep inline `style` attributes, which apply only
 * to their panel element.
 * @param {string} html Markup from a plugin, or host-built markup on the same path
 * @returns {string} Sanitized markup
 */
export function sanitizePanel(html) {
    return DOMPurify.sanitize(html, { FORBID_TAGS: ['style'] });
}

/**
 * Host-specific values shared by panel popups and settings fragments. Both use the same rendering and action
 * lifecycle.
 * @typedef {object} FragmentHost
 * @property {string} id The plugin, and therefore the only mount its fragment may address
 * @property {string} label What to call it when something goes wrong
 * @property {string} containerId The DOM id its container carries, and therefore its `@scope` root
 * @property {string} [stylesheetUrl] Its own CSS, fetched from its own router
 */

/**
 * The DOM id a panel's container carries, and therefore the `@scope` root its CSS is confined to.
 * @param {object} panel The registered panel
 * @returns {string}
 */
/**
 * Conservatively detect whether plugin CSS can close the host's `@scope` wrapper. Ignore braces inside
 * comments and strings; refuse if nesting goes below zero or is nonzero at the end. False positives only leave
 * the panel unstyled, while accepting an escape could affect the whole page.
 * @param {string} css The plugin's stylesheet
 * @returns {boolean} True if it must be refused
 */
function escapesItsScope(css) {
    let depth = 0;

    for (let i = 0; i < css.length; i++) {
        const c = css[i];

        if (c === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            i = end === -1 ? css.length : end + 1;
            continue;
        }

        if (c === '"' || c === '\'') {
            for (i++; i < css.length; i++) {
                if (css[i] === '\\') {
                    i++;
                    continue;
                }

                if (css[i] === c) {
                    break;
                }
            }

            continue;
        }

        if (c === '{') {
            depth++;
            continue;
        }

        if (c === '}') {
            depth--;

            // Returning to zero ends a top-level rule; only a negative depth escapes the wrapper.
            if (depth < 0) {
                return true;
            }
        }
    }

    return depth !== 0;
}

function panelContainerId(panel) {
    return `pluginPanel-${panel.id}`;
}

/**
 * Container ids whose stylesheets have been fetched. Each host has its own `@scope` root, so caching is by
 * container rather than plugin id.
 */
const stylesheetsInjected = new Set();

/**
 * Fetch and inject a plugin stylesheet under the host's `@scope`, confining its selectors to that container.
 * Theme variables can still cascade into the panel. Load or scope failures are logged and leave the panel
 * usable but unstyled.
 * @param {FragmentHost} host The host rendering the fragment
 * @returns {Promise<void>}
 */
async function injectStylesheet(host) {
    if (!host.stylesheetUrl || stylesheetsInjected.has(host.containerId)) {
        return;
    }

    // Claim before fetching so concurrent opens share one request.
    stylesheetsInjected.add(host.containerId);

    try {
        const response = await fetch(host.stylesheetUrl, { headers: getRequestHeaders({ omitContentType: true }) });

        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }

        // Reject CSS that could close the wrapper and escape its scope; refusing it degrades to an unstyled
        // panel, while accepting it could affect the whole document.
        const css = await response.text();

        if (escapesItsScope(css)) {
            throw new Error('the stylesheet closes its own @scope block, which would let it style the whole page');
        }

        const style = document.createElement('style');
        style.dataset.pluginPanelStyles = host.containerId;
        style.textContent = `@scope (#${host.containerId}) { ${css} }`;
        document.head.appendChild(style);
    } catch (error) {
        // Keep the failed request claimed to avoid retrying a broken stylesheet on every open.
        console.error(`Plugin panel '${host.id}' could not load its stylesheet. The panel will render unstyled.`, error);
    }
}

/**
 * Sanitize the response, then replace matching regions within this panel's container only. Empty sanitized
 * regions are still applied so removed markup does not remain visible.
 * @param {HTMLElement} container The panel's content element
 * @param {string} html The plugin's response body
 * @returns {number} How many regions were applied
 */
function applyRegions(container, html) {
    const template = document.createElement('template');
    template.innerHTML = sanitizePanel(html);

    let applied = 0;

    for (const incoming of [...template.content.children]) {
        const name = incoming.getAttribute('data-panel-region');

        if (!name) {
            // Not an error worth showing a user, but always a plugin bug: a top-level element in an action
            // response that names no region can never be placed.
            console.warn('A plugin panel returned a top-level element with no data-panel-region; ignoring it.', incoming);
            continue;
        }

        // `root` is the whole panel body. It cannot be an ordinary outerHTML swap because the element it
        // would replace is the host's own container — the thing holding the popup together (§5.2).
        if (name === 'root') {
            // Move sanitized nodes directly. Serializing and reparsing sanitizer output can reintroduce
            // mutation-XSS or namespace-confusion issues.
            container.replaceChildren(...incoming.childNodes);
            applied++;
            continue;
        }

        const target = container.querySelector(`[data-panel-region="${CSS.escape(name)}"]`);

        if (!target) {
            // A stale action may target a region no longer present in the current view.
            console.debug(`A plugin panel returned region '${name}', which is not on screen; ignoring it.`);
            continue;
        }

        if (incoming.hasAttribute('data-panel-remove')) {
            target.remove();
        } else {
            target.replaceWith(incoming);
        }

        applied++;
    }

    return applied;
}

/**
 * Remember which control had focus, and where the caret was, so a swap does not steal it (§7.5).
 * @param {HTMLElement} container
 * @returns {{key: string, start?: number, end?: number}|null}
 */
function captureFocus(container) {
    const active = document.activeElement;

    if (!active || !container.contains(active)) {
        return null;
    }

    const key = active.getAttribute?.('data-panel-focus');

    if (!key) {
        return null;
    }

    // A text input reports a caret; a button reports nothing, and asking is cheaper than sniffing the tag.
    return typeof (/** @type {any} */ (active).selectionStart) === 'number'
        ? { key, start: /** @type {any} */ (active).selectionStart, end: /** @type {any} */ (active).selectionEnd }
        : { key };
}

/**
 * Put focus and the caret back after a swap, if the element that had it still exists.
 * @param {HTMLElement} container
 * @param {{key: string, start?: number, end?: number}|null} snapshot
 * @returns {void}
 */
function restoreFocus(container, snapshot) {
    if (!snapshot) {
        return;
    }

    const target = /** @type {any} */ (container.querySelector(`[data-panel-focus="${CSS.escape(snapshot.key)}"]`));

    if (!target?.focus) {
        return;
    }

    target.focus();

    if (typeof snapshot.start === 'number' && typeof target.setSelectionRange === 'function') {
        try {
            target.setSelectionRange(snapshot.start, snapshot.end);
        } catch {
            // The element came back as something without a caret. Focus still landed, which is the half
            // that matters.
        }
    }
}

/**
 * Show that an action failed, in the panel if it can, in a popup if it cannot (§7.9, mirroring §14.6).
 * @param {HTMLElement} container
 * @param {FragmentHost} host
 * @param {unknown} error
 * @returns {Promise<void>}
 */
async function showActionError(container, host, error) {
    const message = String(/** @type {any} */ (error)?.message ?? error);
    const region = container.querySelector(`[data-panel-region="${ERROR_REGION}"]`);

    console.error(`Plugin panel '${host.id}' action failed.`, error);

    if (region) {
        region.innerHTML = sanitizePanel(`<p class="pluginPanel-error">${escapeText(message)}</p>`);
        return;
    }

    await callGenericPopup(
        sanitizePanel(`<h3>${escapeText(host.label)}</h3><p>That action could not be completed.</p><p><small>${escapeText(message)}</small></p>`),
        POPUP_TYPE.TEXT,
    );
}

/**
 * Escape text for interpolation into host-built markup.
 *
 * The host builds only two strings containing values it did not author — an error message and a plugin's
 * registered label — and both go through here before the DOMPurify pass rather than relying on it. Sanitizing
 * would *delete* a `<` rather than show it, which turns a diagnostic into a shorter, wronger diagnostic.
 * @param {string} text
 * @returns {string}
 */
function escapeText(text) {
    return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]);
}

/**
 * Gather the named inputs inside a region, for an action that declared `data-panel-form` (§6.3).
 * @param {HTMLElement} container
 * @param {string} regionName
 * @returns {URLSearchParams}
 */
function collectForm(container, regionName) {
    const params = new URLSearchParams();
    const region = container.querySelector(`[data-panel-region="${CSS.escape(regionName)}"]`);

    if (!region) {
        console.warn(`A plugin panel action names form region '${regionName}', which is not on screen.`);
        return params;
    }

    for (const input of region.querySelectorAll('[name]')) {
        const field = /** @type {any} */ (input);

        // An unchecked box sends nothing, exactly as an HTML form would — so a plugin reading "is it set"
        // reads presence, and does not have to know the difference between "false" and "off".
        if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) {
            continue;
        }

        params.append(field.name, String(field.value ?? ''));
    }

    return params;
}

/**
 * Run one action: request, swap, restore (§6).
 * @param {HTMLElement} element The element that was activated
 * @returns {Promise<void>}
 */
async function runAction(element) {
    if (!live || live.pending) {
        // §7.3. A queue here would let a double-tap on delete remove two rows.
        return;
    }

    // Capture this session before awaiting. The panel may close or another panel may open while the request
    // runs, so continuations must not read or mutate whichever session later occupies `live`.
    const session = live;
    const { host, container } = session;

    // Claim before the confirmation await to prevent concurrent actions; the finally releases the claim on
    // every return and failure path.
    session.pending = true;

    try {
        return await performAction(element, session, host, container);
    } finally {
        // Only if this session is still the live one; see the capture note above.
        if (session === live) {
            session.pending = false;
        }

        // The element may have been swapped out from under us by its own response; the class went with it.
        element.classList.remove('pluginPanel-pending');
        element.removeAttribute('aria-busy');
    }
}

/**
 * The body of one panel action, with its session already claimed. Split out so {@link runAction} owns the
 * pending flag in a single `finally` and every early return here releases it.
 * @param {Element} element The clicked or key-bound element carrying the action attributes
 * @param {object} session The fragment session captured at the top of `runAction`
 * @param {FragmentHost} host The plugin whose fragment this is
 * @param {HTMLElement} container The fragment's container element
 * @returns {Promise<void>}
 */
async function performAction(element, session, host, container) {
    const path = element.getAttribute('data-panel-action');

    // Resolve before checking the mount. Browser URL normalization can remove traversal segments from an
    // untrusted fragment path, so validate the final pathname before sending its session and CSRF headers.
    const mountPrefix = `/api/plugins/${host.id}/`;
    const resolvedPath = path?.startsWith('/') && !/[?#]/.test(path)
        ? new URL(`/api/plugins/${host.id}${path}`, window.location.origin).pathname
        : null;

    if (!resolvedPath || !`${resolvedPath}/`.startsWith(mountPrefix)) {
        // Never send an action outside the plugin's own router.
        console.error(`Plugin panel '${host.id}' declared an action path that does not resolve inside its own router; ignoring it.`, path);
        return;
    }

    const confirmText = element.getAttribute('data-panel-confirm');

    if (confirmText && !(await Popup.show.confirm(host.label, confirmText))) {
        return;
    }

    const method = (element.getAttribute('data-panel-method') || 'GET').toUpperCase();
    const hasBody = method === 'POST' || method === 'PUT';

    const supplied = new URLSearchParams(element.getAttribute('data-panel-params') || '');
    const formRegion = element.getAttribute('data-panel-form');

    if (formRegion) {
        for (const [key, value] of collectForm(container, formRegion)) {
            supplied.append(key, value);
        }
    }

    for (const key of RESERVED_QUERY_KEYS) {
        supplied.delete(key);
    }

    // Build from the registered plugin id, not fragment content. Keep ambient context in the query for every
    // method; POST and PUT carry only action parameters in the body.
    const query = ambientParams();

    if (!hasBody) {
        for (const [key, value] of supplied) {
            query.append(key, value);
        }
    }

    const url = `${resolvedPath}?${query}`;

    element.classList.add('pluginPanel-pending');
    element.setAttribute('aria-busy', 'true');

    const focus = captureFocus(container);
    const scrollTop = session.scroller?.scrollTop ?? 0;

    try {
        const response = await fetch(url, {
            method,
            headers: pluginRequestHeaders(hasBody),
            ...(hasBody ? { body: supplied.toString() } : {}),
        });

        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }

        const body = await response.text();

        // A successful empty response such as 204 means no regions need updating.
        if (body.trim() !== '') {
            applyRegions(container, body);
        }

        if (session.scroller) {
            session.scroller.scrollTop = scrollTop;
        }

        restoreFocus(container, focus);
    } catch (error) {
        // Report inline only while this fragment is still active; detached panels should not open a new popup.
        if (session === live) {
            await showActionError(container, host, error);
        } else {
            console.error(`Plugin panel '${host.id}' action failed after its panel was closed.`, error);
        }
    }
}

/**
 * Fetch and display a plugin panel. Sanitize its fragment before inserting it, then use delegated listeners so
 * controls remain active after region replacement.
 * @param {object} panel The registered panel
 * @returns {Promise<void>}
 */
async function openPanel(panel) {
    // Prevent key-repeat from opening multiple modals while the panel fetch is pending. Concurrent opens can
    // otherwise replace the shared action slot or route a key action through the wrong panel.
    if (opening) {
        return;
    }

    opening = true;

    let html;

    /**
     * This panel, as the shared fragment machinery sees it. The popup is one of two hosts now (§28), and the
     * container id is what keeps their stylesheets from being confused for each other.
     * @type {FragmentHost}
     */
    const host = {
        id: panel.id,
        label: panel.label,
        containerId: panelContainerId(panel),
        stylesheetUrl: panel.stylesheetUrl,
    };

    // Fetch styles in parallel with the panel fragment.
    const stylesheetReady = injectStylesheet(host);

    try {
        const response = await fetch(withAmbientParams(panel.panelUrl), {
            method: 'GET',
            headers: pluginRequestHeaders(false),
        });

        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }

        html = await response.text();
    } catch (error) {
        // Report the failed route instead of opening an empty popup.
        console.error(`Plugin panel '${host.id}' failed to load.`, error);
        // The label and error message are plugin-supplied; escape both before building host markup.
        opening = false;
        await callGenericPopup(
            sanitizePanel(`<h3>${escapeText(host.label)}</h3><p>This panel could not be loaded.</p><p><small>${escapeText(String(/** @type {any} */ (error).message ?? error))}</small></p>`),
            POPUP_TYPE.TEXT,
        );
        return;
    }

    const popup = new Popup(sanitizePanel(html), POPUP_TYPE.TEXT, '', { wide: true, large: true });
    const container = popup.content;

    container.classList.add('pluginPanel');
    // The `@scope` root injectStylesheet writes its rules against. Set even when the plugin registered no
    // stylesheet: it costs nothing, and a panel whose id appears only sometimes is a debugging trap.
    container.id = host.containerId;
    await stylesheetReady;

    const deactivate = activateFragment(host, container, popup.body ?? container);

    // The popup is on screen and `live` is its session; another open may now proceed if this one closes.
    opening = false;

    try {
        await popup.show();
    } finally {
        deactivate();
    }
}

/**
 * Claim the shared action slot and bind delegated listeners. Because listeners belong to the container,
 * controls inserted by later region swaps work without rebinding.
 * @param {FragmentHost} host The plugin whose fragment this is
 * @param {HTMLElement} container The element the fragment was rendered into
 * @param {HTMLElement|null} scroller Whatever scrolls, so an action can put the scroll position back
 * @returns {() => void} Teardown. Idempotent, and safe to call after another fragment has taken over
 */
function activateFragment(host, container, scroller) {
    const session = { host, container, scroller, pending: false };
    live = session;

    const onClick = (event) => {
        const action = /** @type {HTMLElement} */ (event.target)?.closest?.('[data-panel-action]');

        if (action && container.contains(action)) {
            event.preventDefault();
            // `closest` is typed as returning `Element`; every action element is an HTMLElement in practice,
            // and `runAction` reads `classList` and `getAttribute` off it.
            void runAction(/** @type {HTMLElement} */ (action));
        }
    };

    const onKeyDown = (event) => {
        // The document listener may outlive this fragment briefly; inactive sessions must ignore keys.
        if (live !== session) {
            return;
        }

        const active = /** @type {HTMLElement} */ (document.activeElement);
        const onAction = active?.closest?.('[data-panel-action]');

        // Enter and Space on a focused action, matching how the panel BUTTONS already behave. Skipped for
        // anything a user might be typing into, where Space is a space.
        if ((event.key === 'Enter' || event.key === ' ') && onAction && container.contains(onAction)
            && !['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) {
            event.preventDefault();
            void runAction(/** @type {HTMLElement} */ (onAction));
            return;
        }

        const named = { PageUp: 'pageup', PageDown: 'pagedown', Escape: 'escape' }[event.key];

        if (!named) {
            return;
        }

        // Only if this panel asked for the key. A panel that renders no pager must not swallow PageUp from
        // the page behind it, and Escape must keep closing the popup for every panel that does not claim it.
        const bound = container.querySelector(`[data-panel-key="${named}"]`);

        if (bound) {
            event.preventDefault();
            void runAction(/** @type {HTMLElement} */ (bound));
        }
    };

    container.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);

    return () => {
        container.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKeyDown);

        // Do not clear a newer fragment's session when this one closes.
        if (live === session) {
            live = null;
        }
    };
}

/**
 * Fetch a plugin fragment and return its status with the body. Callers can render a plugin-provided 503
 * explanation for temporarily unavailable settings instead of substituting defaults. Shared request handling
 * keeps panel and settings hosts consistent.
 * @param {string} url The registered, already-resolved URL on the plugin's own mount
 * @returns {Promise<{ok: boolean, status: number, html: string}>}
 */
export async function fetchPluginFragment(url) {
    const response = await fetch(withAmbientParams(url), {
        method: 'GET',
        headers: pluginRequestHeaders(false),
    });

    return { ok: response.ok, status: response.status, html: await response.text() };
}

/**
 * Mount a settings fragment in an existing container using the same sanitizing, scoped styles, and action
 * lifecycle as a panel. The caller must run the returned teardown before removing the container.
 * @param {object} options
 * @param {FragmentHost} options.host The plugin whose fragment this is
 * @param {HTMLElement} options.container An empty element, already in the document
 * @param {string} options.html The fragment exactly as the plugin's route returned it
 * @param {HTMLElement|null} [options.scroller] Whatever scrolls, if anything does
 * @returns {Promise<() => void>} Teardown, to be called when the fragment comes off screen
 */
export async function mountPluginFragment({ host, container, html, scroller = null }) {
    container.id = host.containerId;
    container.innerHTML = sanitizePanel(html);

    // Wait for scoped styles before revealing the settings fragment to avoid an unstyled flash.
    await injectStylesheet(host);

    return activateFragment(host, container, scroller);
}

/**
 * Ask one plugin how its button should rest, and apply that presentation.
 *
 * A missing or failing `statusUrl` is treated as inactive, never as an error (§14.6): a plugin without status
 * still gets a working button. `color` and `tooltip` are optional dynamic presentation: they let a plugin
 * explain an intentionally inactive state without raising a notification (which would mark the button active).
 * Both fall back to the values registered with the panel when absent.
 * @param {object} panel The registered panel
 * @param {number} epoch Identity of the complete refresh that started this request
 * @returns {Promise<void>}
 */
async function refreshStatus({ panel, button }, epoch) {
    if (!button || !panel.statusUrl) {
        return;
    }

    try {
        // Status paths may already contain a query; merge host parameters so chat identity is not fused into
        // a registered value.
        const response = await fetch(mergeQuery(panel.statusUrl, statusParams()), {
            method: 'GET',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }

        const status = await response.json();

        if (epoch !== statusRefreshEpoch) {
            return;
        }

        button.classList.toggle('pluginPanelButton--active', !!status?.active);
        applyDisabledState(button, status?.disabled === true);
        button.dataset.count = Number.isFinite(status?.count) ? String(status.count) : '';
        if (typeof status?.color === 'string' && status.color) {
            button.dataset.statusColor = status.color;
        } else {
            delete button.dataset.statusColor;
        }
        if (typeof status?.tooltip === 'string' && status.tooltip) {
            button.dataset.statusTooltip = status.tooltip;
        } else {
            delete button.dataset.statusTooltip;
        }
        applyRestingPresentation(panel, button);
    } catch (error) {
        if (epoch !== statusRefreshEpoch) {
            return;
        }

        console.debug(`Plugin panel '${panel.id}' status check failed; treating as inactive.`, error);
        button.classList.remove('pluginPanelButton--active');
        applyDisabledState(button, false);
        button.dataset.count = '';
        delete button.dataset.statusColor;
        delete button.dataset.statusTooltip;
        applyRestingPresentation(panel, button);
    }
}

/**
 * Make a panel button genuinely non-interactive when its plugin says the current mode cannot use it.
 *
 * Presentation alone is not disablement: a dim button that still opens its panel contradicts both its tooltip
 * and ordinary UI semantics. The event handlers also check the dataset, so programmatic clicks cannot bypass
 * the removed pointer affordance or keyboard tab stop.
 * @param {HTMLElement} button The mounted panel button
 * @param {boolean} disabled Whether activation must be refused
 * @returns {void}
 */
function applyDisabledState(button, disabled) {
    if (disabled) {
        button.dataset.statusDisabled = 'true';
        button.classList.remove('interactable');
        button.setAttribute('aria-disabled', 'true');
        button.tabIndex = -1;
        return;
    }

    delete button.dataset.statusDisabled;
    button.classList.add('interactable');
    button.removeAttribute('aria-disabled');
    button.tabIndex = 0;
}

/**
 * Put a button back to its polled status presentation, or what its plugin registered when no override exists.
 *
 * The resting state is used whenever no notification is currently dominant for that plugin. Shares the emoji
 * rule with `createButton`: an emoji's colour is in the font, so both registered and status colours are ignored.
 * @param {object} panel The registered panel
 * @param {HTMLElement} button Its button
 * @returns {void}
 */
function applyRestingPresentation(panel, button) {
    const color = button.dataset.statusColor || panel.iconColor;
    if (panel.iconType === 'class' && color) {
        button.style.setProperty('color', color);
    } else {
        button.style.removeProperty('color');
    }

    button.title = button.dataset.statusTooltip || panel.tooltip || panel.label;
}

/**
 * Apply pushed notification presentation. Fetch the shared notification store once and read only the generic
 * color, summary, and optional count fields; action-specific data remains opaque to the host.
 * @returns {Promise<void>}
 */
async function refreshNotifications() {
    if (mounted.length === 0) {
        return;
    }

    try {
        // Use the same query merge for the host route for consistent request construction.
        const response = await fetch(mergeQuery('/api/plugins/notifications', chatIdParams()), {
            method: 'GET',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }

        const dominant = (await response.json())?.dominant ?? {};

        for (const { panel, button } of mounted) {
            // Panel ids are directory names and may match inherited object keys; test own properties only.
            const one = Object.hasOwn(dominant, panel.id) ? dominant[panel.id] : undefined;

            if (!one) {
                // Restore registered status and clear notification-only presentation.
                applyRestingPresentation(panel, button);

                // Remove notification text and counts so user content cannot linger in DOM attributes after
                // the notification ends or the chat changes.
                delete button.dataset.count;
                continue;
            }

            button.classList.add('pluginPanelButton--active');

            if (Number.isFinite(one.data?.count)) {
                button.dataset.count = String(one.data.count);
            }

            if (one.summary) {
                button.title = one.summary;
            }

            // Apply colors only to class icons; emoji colors come from their font.
            if (one.color && panel.iconType === 'class') {
                // Use CSSOM setters rather than interpolating plugin values into a stylesheet.
                button.style.setProperty('color', one.color);
            }
        }
    } catch (error) {
        // §14.6: a failure here is "nothing pushed", never an error state. The polled status still stands.
        console.debug('Plugin notifications could not be read; leaving polled status as-is.', error);
    }
}

/** @returns {Promise<void>} Re-polls every registered panel's status, then applies anything pushed. */
async function refreshAllStatuses() {
    const epoch = ++statusRefreshEpoch;
    await Promise.all(mounted.map(entry => refreshStatus(entry, epoch)));

    if (epoch !== statusRefreshEpoch) {
        return;
    }

    await refreshNotifications();
}

/**
 * Re-poll on a short bounded schedule after generation end. Plugins may notify after their fire-and-forget
 * work completes, so one immediate poll can miss the update; the fixed schedule avoids a page-lifetime timer.
 * @returns {void}
 */
function refreshAfterGeneration() {
    void refreshAllStatuses();

    for (const delay of FOLLOW_UP_DELAYS_MS) {
        setTimeout(() => void refreshNotifications(), delay);
    }
}

/**
 * Build one button.
 * @param {object} panel The registered panel
 * @param {number} index Its position in the registry — a plugin may register several, so the id needs it
 * @returns {HTMLElement} The button
 */
function createButton(panel, index) {
    const button = document.createElement('div');
    // The index is what makes this unique: `panel.id` is the PLUGIN's id, and one plugin may own several
    // buttons. A duplicated DOM id is invalid HTML and breaks any lookup by it.
    button.id = `pluginPanelButton_${panel.id}_${index}`;
    button.classList.add('pluginPanelButton', 'interactable');
    button.tabIndex = 0;
    button.setAttribute('aria-label', panel.label);
    button.title = panel.tooltip || panel.label;

    if (panel.iconType === 'class') {
        // A FontAwesome glyph: colourable, theme-sized, and visually one of ST's own controls.
        button.classList.add(...panel.icon.split(/\s+/).filter(Boolean));
        if (panel.iconColor) {
            // ⚠️ SET AS A PROPERTY, NEVER INTERPOLATED INTO A STYLESHEET (§14.3.1). This is plugin-supplied
            // text landing in the page's own origin; letting the browser reject a malformed value is the
            // whole point of going through the CSSOM instead of building a rule string.
            button.style.setProperty('color', panel.iconColor);
        }
    } else {
        // An emoji is content, not a class -- and its colour lives in the font, so `iconColor` is ignored.
        button.classList.add('pluginPanelButton--emoji');
        button.textContent = panel.icon;
    }

    button.addEventListener('click', () => {
        if (button.dataset.statusDisabled !== 'true') {
            void openPanel(panel);
        }
    });
    button.addEventListener('keydown', (event) => {
        if (button.dataset.statusDisabled !== 'true' && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            void openPanel(panel);
        }
    });

    return button;
}

/**
 * Draw the buttons for every registered panel.
 *
 * Registration order is the display order, stated rather than left to chance — the same rule
 * `generation-interceptors.js` applies to handler order, and for the same reason: two plugins both drawing a
 * button will notice each other's position.
 * @returns {void}
 */
function render() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) {
        return;
    }

    container.innerHTML = '';
    mounted = registered.map((panel, index) => {
        const button = createButton(panel, index);
        container.appendChild(button);
        return { panel, button };
    });
}

/**
 * Start the panel host.
 *
 * A stock SillyTavern with no plugins draws nothing and binds no listeners: the fetch returns an empty list
 * and this returns early.
 * @returns {Promise<void>}
 */
export async function initPluginPanels() {
    // One endpoint carries everything the client needs to know about loaded plugins, keyed by capability —
    // panels are just the first key. Read our own and ignore the rest, so a fork that has grown other keys
    // does not surprise this host. The fetch itself lives in plugin-client-config.js because §17's window
    // declaration reads the same response; it never rejects, and a missing route yields `{}`.
    const config = await getPluginClientConfig();

    // 🔴 A REQUEST THAT FAILED IS NOT "NO PANELS". It yields `{}` exactly as a server with no plugins does,
    // and this used to return on it for good, so one dropped request at startup meant no plugin buttons
    // until the page was reloaded, with nothing on screen to say a plugin was even installed. Ask again when
    // a chat is next opened: it is the first thing a user does, and it is when a missing button is noticed.
    // `once`, and re-armed only while the server has still not answered, so a success registers the listeners
    // below exactly one time. Found 2026-10-10 beside the same fault in the recent-message window.
    if (!hasPluginClientConfig()) {
        eventSource.once(event_types.CHAT_CHANGED, () => void initPluginPanels());
        return;
    }

    registered = config?.panels;

    if (!Array.isArray(registered) || registered.length === 0) {
        return;
    }

    render();
    await refreshAllStatuses();

    // The event fires once for each completed generation; follow it with bounded polls because plugin work may
    // still be running.
    eventSource.on(event_types.GENERATION_ENDED, () => refreshAfterGeneration());

    // Status is per-chat, so refresh when the active conversation changes.
    eventSource.on(event_types.CHAT_CHANGED, () => void refreshAllStatuses());

    // Reflect API-mode changes immediately; the server interceptor remains the enforcement boundary.
    eventSource.on(event_types.MAIN_API_CHANGED, () => void refreshAllStatuses());
}
