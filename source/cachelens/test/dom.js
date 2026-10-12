/**
 * The smallest DOM the panel actually uses, so its rendering can be tested outside a browser.
 *
 * 🔴 THIS EXISTS BECAUSE `panel.js` SHIPPED BROKEN WITH THE SUITE GREEN. It statically imports SillyTavern's
 * `script.js`, so nothing in `test/` could reach it, and an apostrophe inside a single-quoted string reached
 * `main` twice. `node --check` catches a file that will not parse; this catches one that parses and then
 * throws — the next failure along, and the one the unit tests structurally cannot see.
 *
 * ⚠️ NOT A DOM IMPLEMENTATION, AND MUST NOT GROW INTO ONE. It covers exactly the surface `panel.js` touches
 * (an inventory, not a guess: append, className, textContent, classList.add, style, title, dataset,
 * addEventListener, createTextNode, replaceChildren, setAttribute, getAttribute) plus the one call
 * `index.js`'s `init()` makes, `getElementById`. Anything either starts using that is missing here should
 * fail loudly rather than be quietly approximated — a shim that invents behaviour tests the shim.
 *
 * 🔴 `setAttribute`/`getAttribute` ADDED FOR THE RAW ROW'S `aria-label` (DESIGN_RAW_GENERATION_ROWS.md §10).
 * A raw row's accessible label is set through the real DOM API, not a bespoke property, because that is what
 * `panel.js` actually calls — the same "cover exactly what is touched, nothing invented" rule the rest of
 * this file already follows for `title`, `dataset` and the others.
 *
 * `dispatch` accepts optional event details so tests can exercise the row head's keyboard toggle. Enter and
 * Space activate it, and handlers may call `preventDefault()` without the shim throwing.
 */

/**
 * A text node, as `createTextNode` makes one — the only non-`Element` thing that gets appended.
 * @typedef {object} TextNode
 * @property {string} textContent
 * @property {Element[]} children
 */

class ClassList {
    /**
     * @param {Element} owner The element
     */
    constructor(owner) {
        this.owner = owner;
    }

    /**
     * @param {string} name A class
     * @returns {void}
     */
    add(name) {
        const classes = new Set(this.owner.className.split(' ').filter(Boolean));

        classes.add(name);
        this.owner.className = [...classes].join(' ');
    }

    /**
     * @param {string} name A class
     * @returns {boolean} Whether it is present
     */
    contains(name) {
        return this.owner.className.split(' ').includes(name);
    }
}

class Element {
    /**
     * @param {string} tag Element name
     */
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.className = '';
        /** @type {(Element|TextNode)[]} */
        this.children = [];
        this.text = '';
        this.title = '';
        /** @type {Record<string, string>} */
        this.style = {};
        /** @type {Record<string, string|undefined>} */
        this.dataset = {};
        /** @type {Record<string, string>} */
        this.attributes = {};
        /** @type {Map<string, Function>} */
        this.listeners = new Map();
        this.classList = new ClassList(this);
    }

    /**
     * @param {string} name The attribute
     * @param {string} value Its value
     * @returns {void}
     */
    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    /**
     * @param {string} name The attribute
     * @returns {string|null} Its value, or null when it was never set — the real DOM's own default
     */
    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }

    /**
     * @param {...(Element|TextNode)} nodes Children
     * @returns {void}
     */
    append(...nodes) {
        this.children.push(...nodes);
    }

    /**
     * @param {...Element} nodes Replacements
     * @returns {void}
     */
    replaceChildren(...nodes) {
        this.children = [...nodes];
    }

    /**
     * @param {string} event Event name
     * @param {Function} handler What to call
     * @returns {void}
     */
    addEventListener(event, handler) {
        this.listeners.set(event, handler);
    }

    /**
     * @param {string} event Event name
     * @param {Record<string, unknown>} [detail] Extra event fields to merge in for keyboard and bubbled-event tests.
     * `stopPropagation` and `preventDefault` are no-ops, so handlers may call them when details omit them.
     *
     * `target` defaults to the dispatching element. Tests can pass a descendant target to model a bubbled event,
     * because this shim does not implement DOM bubbling.
     * @returns {void}
     */
    dispatch(event, detail = {}) {
        this.listeners.get(event)?.({ stopPropagation() {}, preventDefault() {}, target: this, ...detail });
    }

    /** @returns {string} The element's text, its children's included */
    get textContent() {
        return this.text + this.children.map(child => child.textContent ?? '').join('');
    }

    /**
     * ⚠️ Assigning text clears children, as the real thing does. The panel relies on this nowhere, but a
     * shim that quietly kept them would hide a bug rather than reveal one.
     */
    set textContent(value) {
        this.text = String(value);
        this.children = [];
    }

    /**
     * @param {string} selector A `.class` selector — the only form the tests need
     * @returns {Element[]} Every descendant matching it
     */
    querySelectorAll(selector) {
        const wanted = selector.replace(/^\./, '');
        /** @type {Element[]} */
        const found = [];
        /**
         * @param {Element|TextNode} node Where to walk from
         * @returns {void}
         */
        const walk = (node) => {
            for (const child of node.children ?? []) {
                // A text node has no classes and no descendants worth visiting; only elements match.
                if (child instanceof Element && child.classList.contains(wanted)) {
                    found.push(child);
                }

                walk(child);
            }
        };

        walk(this);

        return found;
    }

    /**
     * @param {string} selector A `.class` selector
     * @returns {Element|null} The first match
     */
    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }
}

/**
 * Install the shim on `globalThis`, replacing anything already there.
 * @returns {{root: () => Element}} A fresh root element factory
 */
export function installDom() {
    // 🔴 THE CAST IS THE POINT OF THE FILE, NOT A CONCESSION. This is a deliberate subset of `Document` —
    // see the header — so it cannot satisfy the real interface and must not be grown until it does. The cast
    // states that the substitution is intended; the header states what it covers.
    globalThis.document = /** @type {Document} */ (/** @type {unknown} */ ({
        /** @param {string} tag Element name */
        createElement: tag => new Element(tag),
        /** @param {string} value The text */
        createTextNode: value => ({ textContent: String(value), children: [] }),
        // `init()` hangs its menu button off `#extensionsMenu`, and answering null is what the real DOM
        // does outside a SillyTavern page. It is here so a test can run the real `init()` and exercise the
        // event wiring — which is where the stamp is written, and therefore the half of §14.4 that a test
        // calling `captureMeasurement` directly would never touch.
        getElementById: () => null,
    }));
    // Exactly the surface the panel touches, per the header — it calls `toastr.info` and nothing else.
    globalThis.toastr = { info() {} };

    return { root: () => new Element('div') };
}

export { Element };
