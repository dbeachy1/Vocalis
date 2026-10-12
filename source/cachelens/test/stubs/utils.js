/**
 * Stand-in for SillyTavern's `utils.js`.
 */

/**
 * What the panel last asked to be copied.
 * @type {string|null}
 */
export let copied = null;

/**
 * @param {string} text The text
 * @returns {Promise<void>} When "copied"
 */
export async function copyText(text) {
    copied = text;
}
