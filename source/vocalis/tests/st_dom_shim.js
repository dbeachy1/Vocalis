// A jQuery subset, backed by the REAL DOM, big enough to run SillyTavern's Vocalis extension.
//
// 🔴 What this is and is not. st_button_colors_spec.mjs says a hand-rolled stand-in for
// SillyTavern "would be a test of the stand-in", and for the CSS cascade that is right — the
// browser's own engine is the thing under test there. It is NOT right for the button's state
// machine, and that reasoning is exactly how 5.4 shipped a button that never left yellow: the
// poll-arming control flow was pure JavaScript over a Map and two timers, it depended on
// SillyTavern for nothing but `#chat .mes` lookups, and no test ever ran it.
//
// So the split is deliberate. This file stands in for jQuery's DOM plumbing only. Everything
// under test — when a probe fires, when the poll arms, which class lands on which button — is
// the real `index.js`, unmodified, loaded as the real ES module. If the shim is wrong the spec
// fails loudly; it cannot make a broken state machine look healthy, because it never decides
// anything the state machine decides.
//
// Every method here is one `index.js` actually calls. Adding one it does not call is how a
// shim starts drifting into a framework.
'use strict';

function nodesFor(sel, ctx) {
  if (sel == null) return [];
  if (typeof sel === 'function') return []; // jQuery(fn) — handled by ready()
  if (sel === document || sel === window) return [sel];
  if (sel instanceof Node) return [sel];
  if (Array.isArray(sel)) return sel;
  if (sel.__isJq) return sel.nodes;
  const s = String(sel).trim();
  if (s.startsWith('<')) {
    // $('<div class=x>…</div>')
    const t = document.createElement('template');
    t.innerHTML = s;
    return Array.from(t.content.childNodes).filter(n => n.nodeType === 1);
  }
  const root = ctx ? (ctx.__isJq ? ctx.nodes[0] : ctx) : document;
  return root ? Array.from(root.querySelectorAll(s)) : [];
}

// Delegated handlers, kept per (root, type) exactly as jQuery does: the listener sits on the
// root and matches at dispatch time, which is what lets `injectButtons` bind `.vocalis_narrate`
// before any such button exists.
const delegated = new WeakMap();

function ensureDelegation(root, type) {
  let byType = delegated.get(root);
  if (!byType) {
    byType = new Map();
    delegated.set(root, byType);
  }
  if (byType.has(type)) return byType.get(type);
  const handlers = [];
  byType.set(type, handlers);
  root.addEventListener(
    type,
    ev => {
      for (const { selector, fn } of handlers.slice()) {
        if (!selector) {
          fn.call(root, ev);
          continue;
        }
        const match = ev.target && ev.target.closest ? ev.target.closest(selector) : null;
        if (match && (root === document || root.contains(match))) fn.call(match, ev);
      }
    },
    false,
  );
  return handlers;
}

function Jq(nodes) {
  this.nodes = nodes;
  this.__isJq = true;
  this.length = nodes.length;
}

Jq.prototype.each = function (fn) {
  this.nodes.forEach((n, i) => fn.call(n, i, n));
  return this;
};
Jq.prototype.find = function (sel) {
  const out = [];
  for (const n of this.nodes) out.push(...Array.from(n.querySelectorAll(sel)));
  return new Jq(out);
};
Jq.prototype.closest = function (sel) {
  const out = [];
  for (const n of this.nodes) {
    const m = n.closest ? n.closest(sel) : null;
    if (m && !out.includes(m)) out.push(m);
  }
  return new Jq(out);
};
Jq.prototype.attr = function (name, val) {
  if (val === undefined) return this.nodes.length ? this.nodes[0].getAttribute(name) : undefined;
  for (const n of this.nodes) n.setAttribute(name, val);
  return this;
};
Jq.prototype.addClass = function (names) {
  for (const n of this.nodes) for (const c of String(names).split(/\s+/).filter(Boolean)) n.classList.add(c);
  return this;
};
Jq.prototype.removeClass = function (names) {
  for (const n of this.nodes) for (const c of String(names).split(/\s+/).filter(Boolean)) n.classList.remove(c);
  return this;
};
Jq.prototype.toggleClass = function (names, on) {
  for (const n of this.nodes) {
    for (const c of String(names).split(/\s+/).filter(Boolean)) {
      if (on === undefined) n.classList.toggle(c);
      else n.classList.toggle(c, !!on);
    }
  }
  return this;
};
Jq.prototype.hasClass = function (c) {
  return this.nodes.some(n => n.classList.contains(c));
};
Jq.prototype.text = function (t) {
  if (t === undefined) return this.nodes.length ? this.nodes[0].textContent : '';
  for (const n of this.nodes) n.textContent = t;
  return this;
};
Jq.prototype.val = function (v) {
  if (v === undefined) return this.nodes.length ? this.nodes[0].value : undefined;
  for (const n of this.nodes) n.value = v;
  return this;
};
Jq.prototype.prop = function (name, v) {
  if (v === undefined) return this.nodes.length ? this.nodes[0][name] : undefined;
  for (const n of this.nodes) n[name] = v;
  return this;
};
Jq.prototype.css = function (name, v) {
  for (const n of this.nodes) n.style[name] = v;
  return this;
};
Jq.prototype.append = function (what) {
  for (const n of this.nodes) for (const c of nodesFor(what)) n.appendChild(c);
  return this;
};
// 7.0-m2i — `refreshBookList` rebuilds the worldbook picker, and it runs inside `wireSettings`,
// so a missing method here is not one failed check: the extension never finishes init and every
// check in the spec fails on the wrong subject. (That is what `window.__bootError` reported, and
// why it stays.)
Jq.prototype.empty = function () {
  for (const n of this.nodes) while (n.firstChild) n.removeChild(n.firstChild);
  return this;
};
Jq.prototype.prepend = function (what) {
  for (const n of this.nodes) {
    const kids = nodesFor(what);
    for (let i = kids.length - 1; i >= 0; i--) n.insertBefore(kids[i], n.firstChild);
  }
  return this;
};
Jq.prototype.remove = function () {
  for (const n of this.nodes) if (n.parentNode) n.parentNode.removeChild(n);
  return this;
};
// `.on(type, selector, fn)` delegates; `.on(type, fn)` binds direct. Space-separated types are
// used by the extension ('pointerleave pointercancel'), so both forms have to split.
Jq.prototype.on = function (types, selectorOrFn, maybeFn) {
  const selector = typeof selectorOrFn === 'string' ? selectorOrFn : null;
  const fn = typeof selectorOrFn === 'function' ? selectorOrFn : maybeFn;
  if (typeof fn !== 'function') return this;
  for (const type of String(types).split(/\s+/).filter(Boolean)) {
    for (const n of this.nodes) {
      if (selector) ensureDelegation(n, type).push({ selector, fn });
      else n.addEventListener(type, ev => fn.call(n, ev), false);
    }
  }
  return this;
};

const readyQueue = [];
let domIsReady = false;

export function installJQuery(win = window) {
  const $ = function (sel, ctx) {
    if (typeof sel === 'function') {
      // jQuery(fn) — the init entry
      if (domIsReady) sel($);
      else readyQueue.push(sel);
      return new Jq([]);
    }
    return new Jq(nodesFor(sel, ctx));
  };
  $.fn = Jq.prototype;
  win.$ = $;
  win.jQuery = $;
  return $;
}

// Called by the spec once the fixture DOM exists, so the extension's init runs against a page
// that already has messages on it — which is the state SillyTavern hands it.
export function fireReady() {
  domIsReady = true;
  const q = readyQueue.splice(0);
  return Promise.all(q.map(fn => fn(window.$)));
}
