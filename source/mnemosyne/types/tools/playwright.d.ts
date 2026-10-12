/**
 * Playwright, as three deploy gates in `tools/` are allowed to see it — declared under a label for a module
 * that lives in **another package's `node_modules`** (Taproom's `tests/node_modules`, found at run time).
 *
 * 🔴 **WHY THE MODULE IS NOT A DEPENDENCY.** `gate-memory-browser.mjs` loads the browser driver with a
 * dynamic `import()` of a path computed relative to the gate file (Taproom's
 * `tests/node_modules/playwright/index.mjs`, or the file named by `MNEMOSYNE_GATE_PLAYWRIGHT`). It used to
 * be an absolute `file:///` URL into one developer machine's checkout; the reasoning below is unchanged.
 * Playwright pulls a browser download and a dependency tree, and adding either to a plugin whose runtime
 * dependency set is closed at two — and which runs in a process holding a DEK-derived key — would be a bad
 * trade for one dev script. `tests/dependencies.test.js` exists to make anyone who disagrees argue for it out
 * loud.
 *
 * 🔴 **AND WHY IT THEREFORE HAS TO BE DECLARED BY HAND.** TypeScript cannot resolve a computed specifier and
 * must not: `npm run types` has to pass on a clean checkout of THIS package, where Taproom's Playwright may
 * not exist at all. An ambient module declaration is the only form that keeps the check honest in both
 * places. Its name, `mnemosyne-gate-playwright`, is a label that is never imported at run time; the gate
 * annotates its dynamic import with `typeof import('mnemosyne-gate-playwright')`, so renaming one without the
 * other turns the type check red, which is the correct place to find out.
 *
 * ⚠️ **THIS IS A SNAPSHOT OF SOMEBODY ELSE'S API AND NOTHING IN THIS REPOSITORY CAN KEEP IT TRUE.** It is not
 * generated from Playwright and it is not checked against it; there is no `playwright` in `package.json` to
 * check against. If Playwright changes a signature, this file keeps type-checking and the failure moves to the
 * gate's next run — the same bargain `types/fork-host.d.ts` makes about the fork, for the same reason, and
 * bounded the same way: the gates fail loudly, immediately, against a live server, and are run by a person
 * watching the output.
 *
 * ⚠️ **IT DECLARES WHAT THE GATES CALL, NOT WHAT PLAYWRIGHT DOES.** Every member below is reached for by
 * `gate-memory-browser.mjs`; the other two gates use `fetch` and no browser at all. Where the real return
 * value is richer than the gates use — `waitForFunction` hands back a `JSHandle`, `goto` a response — this
 * says `unknown` rather than modeling a type nothing here touches. That is the point of a hand-written stub:
 * adding a member is one line plus a sentence saying what it is for, and **widening one to clear an error is
 * how a stub quietly becomes `any`.**
 */

/**
 * ⚠️ **`NetworkResponse`/`NetworkRequest`, NOT `Response`/`Request`.** `tsconfig.tools.json` is the config
 * with `lib: DOM`, so those two names are already taken by the globals the page-side callbacks use for
 * `fetch`. Declaring Playwright's own — which are a driver's view of a network exchange and share nothing with
 * them but a noun — under the same names would shadow them inside this block and read as if the gate's
 * `await res.json()` and its `page.on('response')` were the same object. They are not.
 */
declare module 'mnemosyne-gate-playwright' {
    /** One line the page wrote to its own console. The gate keeps the errors and drops the rest. */
    interface ConsoleMessage {
        /** `'error'`, `'warning'`, `'log'` … — matched against `'error'` and nothing else. */
        type(): string;
        text(): string;
    }

    /** A response the PAGE received, observed by the driver — never the `fetch` Response inside a callback. */
    interface NetworkResponse {
        /** 🔴 A method, not a property. `r.ok` without the parens is a truthy function and every response passes. */
        ok(): boolean;
        status(): number;
        url(): string;
    }

    /** A request the page issued. The gate reads these to learn what the host appends to a plugin URL. */
    interface NetworkRequest {
        url(): string;
        method(): string;
    }

    /**
     * A resolved set of elements — resolved late, on use, which is why the gate can build one before the
     * panel exists and click it afterward.
     */
    interface Locator {
        /** Narrow to the first match. Every `.click()` in the gate goes through this, because a click on a
         *  multi-element locator throws rather than picking one. */
        first(): Locator;
        /** A locator scoped inside this one. `hasText` filters to elements whose text contains the string. */
        locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
        click(): Promise<void>;
        /** Wait for this locator to resolve to a visible element. Rejects on timeout — it never returns null. */
        waitFor(options?: { timeout?: number }): Promise<void>;
        count(): Promise<number>;
        /**
         * ⚠️ **`null` IS REAL AND THE GATE HAS TO DEAL WITH IT.** This is the DOM's `Node.textContent`, which
         * is `null` for a node that cannot have text. An element always can, so a locator that resolved to one
         * gives a string — but that is an argument the caller makes, not one this signature can.
         */
        textContent(): Promise<string | null>;
        /**
         * 🔴 **THE CALLBACK RUNS INSIDE THE BROWSER, AND `element` IS A REAL `Element` THERE.** This is the
         * whole reason `tsconfig.tools.json` exists as a second config with `lib: DOM`: the function is
         * serialized to source, shipped to the page and evaluated there, so `querySelectorAll` and
         * `getBoundingClientRect` inside it are the page's and not Node's. Typing the parameter is what makes
         * a calendar-geometry probe a checked statement rather than three lines of `any`.
         *
         * ⚠️ Nothing crosses this boundary that JSON cannot carry. `R` is what the callback returns, and a
         * callback that returns a DOM node type-checks here and fails at run time — the one hole this
         * declaration cannot close.
         */
        evaluate<R>(pageFunction: (element: Element) => R | Promise<R>): Promise<R>;
    }

    interface Page {
        /** @returns the driver's response object. Unused by the gates, so it is not modeled. */
        goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number }): Promise<unknown>;
        /**
         * ⚠️ Resolves an element handle the gates never use. Declared `unknown` on purpose: it is a *wait*
         * everywhere in this codebase, and a handle nobody holds cannot go stale.
         */
        waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
        /**
         * Poll a predicate INSIDE the page until it is truthy. Same browser-side rule as `evaluate` — see the
         * note on `Locator.evaluate`. Rejects on timeout, which is how every use of it here reports failure.
         */
        waitForFunction<A>(pageFunction: (arg: A) => unknown, arg?: A, options?: { timeout?: number; polling?: number | 'raf' }): Promise<unknown>;
        locator(selector: string, options?: { hasText?: string | RegExp }): Locator;
        fill(selector: string, value: string): Promise<void>;
        click(selector: string): Promise<void>;
        /** No argument: the callback closes over nothing, because nothing from Node is in scope in the page. */
        evaluate<R>(pageFunction: () => R | Promise<R>): Promise<R>;
        /**
         * 🔴 **`arg` IS THE ONLY WAY TO GET A NODE-SIDE VALUE INTO THE PAGE**, and it is serialized on the way.
         * A closure over a Node variable compiles, ships a function referencing a name the page has never
         * heard of, and fails inside the browser — which is why the seed and the cleanup both pass their id
         * through here rather than capturing it.
         */
        evaluate<R, A>(pageFunction: (arg: A) => R | Promise<R>, arg: A): Promise<R>;

        /** Every console line the page emits, including ones from code that is not ours. */
        on(event: 'console', handler: (message: ConsoleMessage) => void): void;
        /** Every response the page receives. The gate filters these down to the plugin's own routes. */
        on(event: 'response', handler: (response: NetworkResponse) => void): void;
        /** Every request the page issues — how the gate learns which identity axes the host appends. */
        on(event: 'request', handler: (request: NetworkRequest) => void): void;
    }

    interface BrowserContext {
        newPage(): Promise<Page>;
    }

    interface Browser {
        /** `ignoreHTTPSErrors` is for the box's known mkcert pair; it is a diagnostic, not a trust decision. */
        newContext(options?: { ignoreHTTPSErrors?: boolean }): Promise<BrowserContext>;
        close(): Promise<void>;
    }

    interface BrowserType {
        /** Headless by default, which is what the gates want and the only way they call it. */
        launch(): Promise<Browser>;
    }

    export const chromium: BrowserType;
}
