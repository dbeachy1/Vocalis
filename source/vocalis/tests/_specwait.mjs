// Waiting for the thing itself, in the browser specs. No fixed sleeps.
//
// Doug, 2026-10-12: "Real engineers don't do sleeps in specs because they're inherently
// indeterminate. They vary by system load. You cannot rely on them. That's why they're flaky."
// Measured that day: in a full `-n 16` run three browser specs failed, a different set each run,
// and five copies of ace_library_tools_browser_spec.mjs run at once failed three times in five. That
// spec slept 600 ms for a debounced save and then reloaded the page; under load the save had not
// been sent yet, so the reload read the old value.
//
// A sleep states how long the author's machine took. Each helper here names an EVENT instead, and
// the spec's own `waitFor(cdp, expression, deadline)` waits for it. The deadline is only a bound on
// a hang; a passing run never waits it out.
//
// Everything exported is a page EXPRESSION (a string), because every spec carries its own CDP
// `evaluate` and `waitFor`. Use them as `await evaluate(cdp, X)` or `await waitFor(cdp, X, ms)`.
//
// Which one, for which sleep:
//
//   "sleep, then check a save landed"            -> wait on the SERVER: `uiStateIs`, or a `fetch` of
//                                                   the route that reads the value back.
//   "sleep N poll cycles, then check it held"    -> `INSTALL_FETCH_LOG` before the step, read
//                                                   `fetchCount`, then wait for `fetchCountAtLeast`.
//   "sleep, then check a dialog did NOT open"    -> `watch` BEFORE the action, wait for the action's
//                                                   own completion signal, then assert `!saw`.
//   "sleep for a transition or smooth scroll"    -> `TRANSITIONS_FINISHED`, `NEXT_FRAME`, or scroll
//                                                   with `behavior: 'instant'` and do not wait.
//   "sleep until the list has stopped changing"  -> `INSTALL_NET_IDLE` before the first action, then
//                                                   wait for `NET_IDLE` and one `NEXT_FRAME`.
//
// ⚠️ A boot-time request can only be seen by a log that is there before the page's scripts run:
// install with `Page.addScriptToEvaluateOnNewDocument` (see ace_draft_twotab_spec.mjs).
// ⚠️ A `scrollend` listener must ignore an event that arrives with the page still at the top: an
// instant jump to the top made just before queues a stale one (see ss_songs_bulk_browser_spec.mjs).
//
// ⚠️ A page navigation throws all of this away with the document. Install again after
// `Page.navigate`, the same way the specs re-arm their error collectors.

const q = v => JSON.stringify(v);

// ── a second load of the page: wait for the NEW document ─────────────────────────────────────
//
// `Page.reload` and `Page.navigate` answer as soon as the browser has STARTED. The old page stays
// current until the server's reply arrives, and it already satisfies "complete, __uiReady,
// __bootDone", so a boot gate asked straight after a reload can be answered by the page that is
// about to be destroyed. What followed, on 2026-10-12 in folders_browser_spec.mjs and
// ace_library_tools_browser_spec.mjs: PUBLISH_SPEC_SURFACE ran in the new page before its bundle
// had, found no registry, and imported a SECOND copy of every module. The spec then drove the
// copy while the real app, with nothing loaded, repainted the same list as "No uploaded voices."
// It showed as a one-off red under load, and was written off as lost requests until the saved
// output was read: a list painted empty over a `state.vlist` that held both voices.
//
// So: evaluate STAMP_OUTGOING just before the reload, and put ON_NEW_DOCUMENT in the gate after
// it. A new document has a fresh global, so the stamp cannot survive into it, and reading a
// property of `window` never throws in either. (clips_favorites_browser_spec.mjs has done this
// since 7.3 as `__preReload`; this is the same thing, in one place.)
export const STAMP_OUTGOING = `(window.__specOutgoing = 1)`;
export const ON_NEW_DOCUMENT = `!window.__specOutgoing`;

/**
 * NODE side, the one helper here that is not a page expression: keep every request Chrome could
 * not complete, and every answer of 400 or more, and print them if the spec ends red.
 *
 * 🔴 WHY A REQUEST FAILED, IN CHROME'S OWN WORDS. On 2026-10-12 a full `-n 16` run lost a spec to
 * `TypeError: Failed to fetch` on a plain GET, and another to a list that painted empty because a
 * fetch behind it had quietly failed. The page's error does not say why. Chrome's network layer
 * does. With eight copies of wbedit_browser_spec.mjs at once it said `net::ERR_ADDRESS_IN_USE`:
 * the test server (Werkzeug, the one the product ships on) closes the connection after every
 * response, so each request takes a new local port, and Windows keeps a closed port reserved for
 * a minute or two. One run of that spec is 2,079 requests (counted at the server); eight at once
 * held 13,483 of the machine's 16,384 dynamic ports. That limit is machine-wide, so anything else
 * making connections at the same time counts against it.
 *
 * `send` is the spec's CDP send; `subscribe(fn)` must call `fn` with each parsed CDP message.
 * Canceled loads (a download, a navigation away) are not failures. Returns the live list.
 */
export async function reportNetworkFailures(send, subscribe) {
  const urls = new Map(),
    failures = [];
  subscribe(m => {
    if (m.method === 'Network.requestWillBeSent') urls.set(m.params.requestId, `${m.params.request.method} ${m.params.request.url}`);
    else if (m.method === 'Network.responseReceived') {
      if (m.params.response.status >= 400)
        failures.push(`${urls.get(m.params.requestId) || m.params.response.url} -> HTTP ${m.params.response.status}`);
    } else if (m.method === 'Network.loadingFinished') urls.delete(m.params.requestId);
    else if (m.method === 'Network.loadingFailed') {
      if (!m.params.canceled) failures.push(`${urls.get(m.params.requestId) || '(unknown request)'} -> ${m.params.errorText}`);
      urls.delete(m.params.requestId);
    }
  });
  await send('Network.enable');
  process.on('exit', code => {
    if (code && failures.length)
      console.error(`  (${failures.length} request(s) failed or were refused during this run: ${failures.slice(0, 14).join(' | ')})`);
  });
  return failures;
}

/**
 * Record every `fetch` the page makes: `{url, method, status}` pushed when the RESPONSE arrives
 * (status 0 for a network failure). Idempotent. Install it before the step whose requests matter.
 *
 * 🔴 THE ENTRY IS PUSHED BEFORE THE PAGE'S OWN CODE SEES THE RESPONSE. The wrapper's `.then` is
 * attached before the promise is handed back, so it runs first. "The response arrived" is therefore
 * NOT "the page has painted from it". To assert on what a poll painted, wait for ONE MORE response
 * than the paints you need: when response n+1 arrives, the page finished with response n long ago.
 */
export const INSTALL_FETCH_LOG = `(() => {
    if (window.__specFetch) return true;
    const log = [], real = window.fetch;
    window.fetch = function (...a) {
        const req = a[0], init = a[1] || {};
        const url = String(req && req.url ? req.url : req);
        const method = String(init.method || (req && req.method) || 'GET').toUpperCase();
        const p = real.apply(this, a);
        p.then(r => log.push({ url, method, status: r.status }), () => log.push({ url, method, status: 0 }));
        return p;
    };
    window.__specFetch = {
        log,
        count: (part, method) => log.filter(e => e.url.includes(part) && (!method || e.method === method)).length,
    };
    return true;
})()`;

/** How many responses have arrived for URLs containing `part` (optionally one HTTP method). */
export const fetchCount = (part, method) => `window.__specFetch.count(${q(part)}, ${q(method || '')})`;

/** True once at least `n` such responses have arrived. For `waitFor`. */
export const fetchCountAtLeast = (part, n, method) => `${fetchCount(part, method)} >= ${Number(n)}`;

/**
 * Count what the page has in flight: every `fetch` and every response body still being read.
 * Idempotent. Install it before the first action whose loading you will wait out, and AFTER any
 * fake `fetch` the spec installs, so the fake's routes are counted too.
 *
 * "The list has finished arriving" is `NET_IDLE` seen from a later task: each step of a load chain
 * continues in the microtasks that run right after the last body is read, and the decrement is
 * attached before the promise reaches the page's code, so the count cannot read zero between a
 * response arriving and the code that continues from it. Wait for `NET_IDLE`, then `NEXT_FRAME`
 * for the paint. A page that never goes idle is an error for the spec to throw, not a pass.
 *
 * ⚠️ It does not see work a page starts from a timer after going idle. Where that matters, wait
 * for the effect itself.
 */
export const INSTALL_NET_IDLE = `(() => {
    if (window.__specNet) return true;
    const net = (window.__specNet = { n: 0 });
    const hold = p => { net.n++; const done = () => { net.n--; }; p.then(done, done); return p; };
    const real = window.fetch;
    window.fetch = function (...a) { return hold(real.apply(this, a)); };
    for (const m of ['json', 'text', 'blob', 'arrayBuffer', 'formData']) {
        const orig = Response.prototype[m];
        Response.prototype[m] = function (...a) { return hold(orig.apply(this, a)); };
    }
    return true;
})()`;

/** True while nothing counted by `INSTALL_NET_IDLE` is in flight. For `waitFor`. */
export const NET_IDLE = `window.__specNet.n === 0`;

/**
 * Page SOURCE (a statement, not an expression) that counts the short timers page code has armed:
 * every `setTimeout` of `capMs` or less from the moment it is set until it fires or is cleared,
 * and, unless `intervals` is false, every `setInterval` of `capMs` or less until it is cleared.
 * `window.__timersPending()` is the count; `TIMERS_DRAINED` is the expression to wait for.
 *
 * For the specs that build a fake page around the extension: interpolate it into the page's script
 * BEFORE the code under test is imported, so it sees every timer that code sets. "The debounces
 * have fired and the poll has stopped" is then the count reaching zero, on any machine, where the
 * specs used to sleep a multiple of the poll interval. If a timer the check is afraid of WERE
 * armed, waiting for zero runs it, and the request it makes is then seen.
 *
 * ⚠️ A timer longer than `capMs` is invisible to it: pick the cap from the timers that matter.
 * No backticks in the source, so it can sit inside a template literal.
 */
export const trackTimers = (capMs, { intervals = true } = {}) => `(() => {
    if (window.__timersPending) return;
    const armed = new Set(), cap = ${Number(capMs)};
    const setT = window.setTimeout.bind(window), clearT = window.clearTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => {
        if (typeof fn !== 'function' || !(Number(ms) <= cap)) return setT(fn, ms, ...args);
        const id = setT(() => { armed.delete(id); fn(...args); }, ms);
        armed.add(id);
        return id;
    };
    window.clearTimeout = id => { armed.delete(id); clearT(id); };
    if (${intervals ? 'true' : 'false'}) {
        const setI = window.setInterval.bind(window), clearI = window.clearInterval.bind(window);
        window.setInterval = (fn, ms, ...args) => {
            const id = setI(fn, ms, ...args);
            if (typeof fn === 'function' && Number(ms) <= cap) armed.add(id);
            return id;
        };
        window.clearInterval = id => { armed.delete(id); clearI(id); };
    }
    window.__timersPending = () => armed.size;
})();`;

/** True once no timer counted by `trackTimers` is armed. For `waitFor`. */
export const TIMERS_DRAINED = `window.__timersPending() === 0`;

/**
 * Start recording whether `predicate` (a page expression) is EVER true, from now on. Checked at
 * once and on every DOM change, so a dialog that opens and closes between two polls is still seen.
 * This is how "it never asked" is asserted without sleeping and hoping.
 */
export const watch = (name, predicate) => `(() => {
    window.__specSeen = window.__specSeen || {};
    window.__specSeen[${q(name)}] = false;
    const test = () => { try { if (${predicate}) window.__specSeen[${q(name)}] = true; } catch (e) {} };
    test();
    new MutationObserver(test).observe(document.documentElement,
        { subtree: true, childList: true, attributes: true, characterData: true });
    return true;
})()`;

/** Has the predicate given to `watch(name, …)` been true at any moment since? */
export const saw = name => `!!(window.__specSeen && window.__specSeen[${q(name)}])`;

/** True once the server's saved UI state holds `value` under `key`: the debounced write landed. */
export const uiStateIs = (key, value) =>
  `fetch('/ui-state', { cache: 'no-store' }).then(r => r.json()).then(j => j[${q(key)}] === ${q(value)})`;

/** Resolves true when every CSS transition and animation now running has finished or been canceled. */
// FINITE ones only. The page has animations that never end (the `.spin` spinner, an indeterminate
// bar), and waiting on one of those hangs the evaluate for as long as it is on screen.
export const TRANSITIONS_FINISHED = `Promise.all(document.getAnimations()
    .filter(a => { const t = a.effect && a.effect.getComputedTiming(); return t && Number.isFinite(t.endTime); })
    .map(a => a.finished.catch(() => null))).then(() => true)`;

/** Resolves true after the browser has painted: two animation frames from now. */
export const NEXT_FRAME = `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`;
