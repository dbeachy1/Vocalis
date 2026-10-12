/**
 * Stand-in for SillyTavern's popup, capturing the content element the panel draws into.
 */

export const POPUP_TYPE = { TEXT: 1 };

/**
 * The most recent popup, so a test can read what the panel rendered.
 * @type {Popup|null}
 */
export let lastPopup = null;

export class Popup {
    /**
     * @param {object} content The element the panel will draw into
     * @param {number} type Popup type
     * @param {string} title Its title
     * @param {object} options Its options
     */
    constructor(content, type, title, options) {
        this.content = content;
        this.type = type;
        this.title = title;
        this.options = options;
        lastPopup = this;
    }

    /**
     * @returns {Promise<void>} When "shown" — the panel awaits this, so it must not resolve until the test
     *   has had its chance to inspect the content. Resolving immediately is what a dismissed popup does.
     */
    show() {
        return new Promise(() => {});
    }
}
