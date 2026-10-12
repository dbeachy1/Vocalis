import { getRequestHeaders } from '../script.js';

/**
 * Fetch and cache the capability-keyed server-plugin config. Consumers interpret their own capability data;
 * this module stays independent of individual plugins.
 */

/**
 * In-flight or completed config request, shared by all consumers.
 * @type {Promise<object>|null}
 */
let pending = null;

/**
 * Whether the server has ANSWERED, with a config or with a definite "there is no such route". False while the
 * first request is in flight and after one that failed, which is what lets a later caller tell "nobody
 * registered anything" from "we never found out".
 * @type {boolean}
 */
let answered = false;

/**
 * Fetch plugin registrations. Missing routes, failed requests, and invalid response bodies resolve to `{}` so
 * older servers and installs without registrations behave like an empty config.
 *
 * 🔴 A FAILED REQUEST IS NOT REMEMBERED. This memoized the promise whatever became of it, so one dropped
 * request at startup (a server still coming up, a vault mid-unlock, a blip) answered `{}` for the life of the
 * tab: no plugin panels, and no recent-message window on any generation. Until 2026-10-10 that cost a memory
 * plugin its ingest and nothing else. It now costs it everything, because a reply that arrives with no window
 * is indistinguishable from a background request and is treated as one (Mnemosyne 1.8.0). So only an ANSWER is
 * kept; a failure is forgotten and the next caller asks again. A 404 is an answer: a server that predates the
 * route will say the same thing every time.
 *
 * ⚠️ "The next caller" is each consumer's own business: this function retries nothing by itself. The window
 * asks again at the next generation (`getRecentMessagesWindow`); the panel host asks again when a chat is
 * opened (`initPluginPanels`). {@link hasPluginClientConfig} is how a consumer knows it should.
 * @returns {Promise<object>} The config, keyed by capability
 */
export function getPluginClientConfig() {
    if (pending) {
        return pending;
    }

    const attempt = (async () => {
        try {
            const response = await fetch('/api/plugins/client-config', {
                method: 'GET',
                headers: getRequestHeaders(),
            });

            if (response.status === 404) {
                answered = true;
                return {};
            }

            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }

            const config = await response.json();
            answered = true;
            return (config && typeof config === 'object' && !Array.isArray(config)) ? config : {};
        } catch (error) {
            console.debug('Plugin client config is unavailable; it will be asked for again.', error);

            if (pending === attempt) {
                pending = null;
            }

            return {};
        }
    })();

    pending = attempt;

    return pending;
}

/**
 * Whether the server has answered {@link getPluginClientConfig}, as opposed to the `{}` a failed request
 * yields, which reads the same and means "ask again" rather than "nobody registered anything".
 * @returns {boolean}
 */
export function hasPluginClientConfig() {
    return answered;
}

/**
 * Largest recent-message window declared by any loaded plugin. Zero means no plugin requested a window.
 *
 * ⚠️ ZERO IS RIGHT WHEN NOBODY ASKED AND WRONG WHEN WE NEVER FOUND OUT. A plugin that tells replies from
 * background requests by the window (Mnemosyne 1.8.0) gives a window-less reply no memory at all, so "0
 * because the startup request failed" is a whole session without memory. See {@link promptsLearned}.
 * @type {number}
 */
let recentMessagesWindow = 0;

/**
 * Whether {@link initPluginPrompts} has read the server's answer. Until it has, every read of the window asks
 * again rather than trusting the 0 it started with.
 * @type {boolean}
 */
let promptsLearned = false;

/**
 * Total token reservation across plugins. Sum reservations because each plugin may inject separately; with no
 * reservation, late server-side text may be truncated from the prompt.
 * @type {number}
 */
let reservedPromptTokens = 0;

/**
 * Load prompt declarations at startup without blocking initialization; called again by
 * {@link getRecentMessagesWindow} for as long as the server has not answered. The client sends one shared
 * window; the server limits each plugin to its own declared count.
 * @returns {Promise<void>}
 */
export async function initPluginPrompts() {
    if (promptsLearned) {
        return;
    }

    const config = await getPluginClientConfig();

    // Checked again AFTER the await: two callers can both be waiting on the one request, and the reservation
    // below is a SUM, so the second one through would count every plugin twice.
    if (promptsLearned || !answered) {
        return;
    }

    promptsLearned = true;

    const prompts = config?.prompts;
    if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) {
        return;
    }

    for (const declaration of Object.values(prompts)) {
        if (Number.isInteger(declaration?.recentMessages) && declaration.recentMessages > recentMessagesWindow) {
            recentMessagesWindow = declaration.recentMessages;
        }

        if (Number.isInteger(declaration?.reservesTokens) && declaration.reservesTokens > 0) {
            reservedPromptTokens += declaration.reservesTokens;
        }
    }

    // The server caps individual declarations; warn here when their aggregate leaves little room for history.
    const AGGREGATE_WARNING_THRESHOLD = 8192;
    if (reservedPromptTokens > AGGREGATE_WARNING_THRESHOLD) {
        const asked = Object.entries(prompts)
            .filter(([, declaration]) => Number.isInteger(declaration?.reservesTokens) && declaration.reservesTokens > 0)
            .map(([id, declaration]) => `${id}: ${declaration.reservesTokens}`)
            .join(', ');
        console.warn(`Server plugins have reserved ${reservedPromptTokens} tokens of prompt space between them (${asked}). That much is coming out of your context before any history is added.`);
    }
}

/**
 * Return the cached generation window synchronously; generation must not wait on the config request.
 *
 * ⚠️ 0 before the config arrives is a COST, not a neutral answer: that generation goes out with no window.
 * So a read that finds the server has not answered yet asks again, without waiting: this generation is not
 * held up, and the next one has the number. Before 2026-10-10 a startup request that failed was never
 * repeated, and every generation until the page was reloaded went out window-less.
 * @returns {number} The window size, or 0 if nobody asked or the server has not answered yet
 */
export function getRecentMessagesWindow() {
    if (!promptsLearned) {
        void initPluginPrompts();
    }

    return recentMessagesWindow;
}

/**
 * Return cached prompt space for server interceptors. This is synchronous so generation never waits for config;
 * zero is used before config arrives or when no plugin declared a reservation.
 * @returns {number} Total reserved tokens across every loaded plugin, or 0 if nobody asked
 */
export function getReservedPromptTokens() {
    return reservedPromptTokens;
}
