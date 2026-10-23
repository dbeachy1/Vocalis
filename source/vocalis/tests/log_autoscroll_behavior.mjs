import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class MockElement {
  constructor(id = '') {
    this.id = id;
    this.checked = true;
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.clientHeight = 40;
    this.children = [];
    this.listeners = new Map();
    this.innerHTML = '';
    this.className = '';
    this.onclick = null;
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name) {
    for (const listener of this.listeners.get(name) || []) listener({ target: this });
  }

  querySelector(selector) {
    if (selector !== '.ph') return null;
    return this.children.find(child => child.className.split(/\s+/).includes('ph')) || null;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

const elements = new Map(['copyLog', 'log', 'autoscroll', 'blkAutoscroll', 'blkLog'].map(id => [id, new MockElement(id)]));
const document = {
  getElementById: id => elements.get(id) || null,
  createElement: tag => new MockElement(tag),
};
// A browser calls a ResizeObserver when a pane changes size, including when its tab hides it
// (size 0) or shows it again. `resize(pane)` stands in for that.
/** @type {Map<MockElement, () => void>} */
const observers = new Map();
class MockResizeObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe(el) {
    observers.set(el, () => this.callback([{ target: el }]));
    this.callback([{ target: el }]); // a browser reports the first size right away
  }
}
const resize = el => observers.get(el)();
// `uiFontApply` announces a font-size change on window; `fontSize()` stands in for that.
/** @type {(() => void)[]} */
const fontListeners = [];
const window = {
  addEventListener: (name, listener) => {
    if (name === 'vocalis:fontsize') fontListeners.push(listener);
  },
};
const fontSize = () => fontListeners.forEach(listener => listener());

const source = await readFile(new URL('../src/webui/js/ui/log.js', import.meta.url), 'utf8');
const importLine = "import { $ } from '../util/dom.js';";
assert.equal(source.split(importLine).length - 1, 1, 'the module has one DOM-helper import');
assert.equal(source.split('export function logInto').length - 1, 1, 'logInto has one export declaration');
assert.equal(source.split('export function followWhenShown').length - 1, 1, 'followWhenShown has one export declaration');
const runnable = source
  .replace(importLine, 'const $ = id => document.getElementById(id);')
  .replace('export function logInto', 'function logInto')
  .replace('export function followWhenShown', 'function followWhenShown')
  .concat('\nglobalThis.__logInto = logInto;\nglobalThis.__followWhenShown = followWhenShown;\n');
// The source runs in its own context; expose its helpers through that context for isolated calls.
const appenderContext = vm.createContext({
  document,
  window,
  navigator: { clipboard: { writeText: async () => {} } },
  ResizeObserver: MockResizeObserver,
});
vm.runInContext(runnable, appenderContext);
assert.equal(typeof appenderContext.__logInto, 'function');
assert.equal(typeof appenderContext.__followWhenShown, 'function');

for (const [checkboxId, paneId] of [
  ['autoscroll', 'log'],
  ['blkAutoscroll', 'blkLog'],
]) {
  const checkbox = elements.get(checkboxId);
  const pane = elements.get(paneId);

  pane.scrollTop = 17;
  pane.scrollHeight = 500;
  checkbox.checked = false;
  checkbox.dispatch('change');
  assert.equal(pane.scrollTop, 17, `${paneId}: unchecking does not move the pane`);

  checkbox.checked = true;
  checkbox.dispatch('change');
  assert.equal(pane.scrollTop, 500, `${paneId}: checking jumps to the current tail immediately`);
  pane.dispatch('scroll');
  assert.equal(checkbox.checked, true, `${paneId}: the programmatic tail scroll keeps follow mode enabled`);

  pane.scrollTop = 0;
  pane.clientHeight = 100;
  pane.scrollHeight = 500;
  checkbox.checked = true;
  pane.dispatch('scroll');
  assert.equal(checkbox.checked, false, `${paneId}: scrolling away disables follow mode`);

  pane.scrollTop = 380;
  checkbox.checked = true;
  pane.dispatch('scroll');
  assert.equal(checkbox.checked, true, `${paneId}: the bottom slack keeps follow mode enabled`);

  pane.scrollHeight = 640;
  appenderContext.__logInto(pane, '<b>new log entry</b>', undefined, checkbox.checked);
  assert.equal(pane.scrollTop, 640, `${paneId}: the next append follows the tail when enabled`);

  checkbox.checked = false;
  pane.scrollTop = 21;
  pane.scrollHeight = 720;
  appenderContext.__logInto(pane, '<b>another entry</b>', undefined, checkbox.checked);
  assert.equal(pane.scrollTop, 21, `${paneId}: appends stay in place when follow mode is disabled`);

  // Lines arrive while the tab is hidden. A hidden pane measures zero and cannot scroll, so the
  // browser keeps the old position and the append's scroll does nothing.
  checkbox.checked = true;
  pane.scrollTop = 400;
  pane.clientHeight = 0;
  resize(pane);
  pane.dispatch('scroll');
  assert.equal(checkbox.checked, true, `${paneId}: a hidden pane does not turn auto-scroll off`);
  // Shown again: the old position, more text below it.
  pane.clientHeight = 100;
  pane.scrollHeight = 900;
  resize(pane);
  assert.equal(pane.scrollTop, 900, `${paneId}: coming back on screen shows the last line when auto-scroll is on`);

  checkbox.checked = false;
  pane.scrollTop = 50;
  pane.clientHeight = 0;
  resize(pane);
  pane.clientHeight = 100;
  pane.scrollHeight = 1000;
  resize(pane);
  assert.equal(pane.scrollTop, 50, `${paneId}: coming back on screen stays put when auto-scroll is off`);
}

// A log with no auto-scroll control follows while it is at its tail, and stops when scrolled up.
{
  const pane = new MockElement('plainLog');
  pane.clientHeight = 100;
  pane.scrollHeight = 500;
  pane.scrollTop = 400;
  appenderContext.__followWhenShown(pane);
  pane.dispatch('scroll');
  pane.clientHeight = 0;
  resize(pane);
  pane.clientHeight = 100;
  pane.scrollHeight = 800;
  resize(pane);
  assert.equal(pane.scrollTop, 800, 'plain log: at the tail when hidden, it shows the last line when shown again');

  pane.scrollTop = 100;
  pane.dispatch('scroll');
  pane.clientHeight = 0;
  resize(pane);
  pane.dispatch('scroll'); // hidden: must not count as reading back or as returning to the tail
  pane.clientHeight = 100;
  pane.scrollHeight = 1200;
  resize(pane);
  assert.equal(pane.scrollTop, 100, 'plain log: scrolled up to read back, it stays put when shown again');

  // A bigger font re-wraps the text: more of it, the same pane.
  pane.scrollHeight = 1500;
  fontSize();
  assert.equal(pane.scrollTop, 100, 'plain log: reading back, a font-size change leaves it where it is');
  pane.scrollTop = 1400;
  pane.dispatch('scroll');
  pane.scrollHeight = 1800;
  fontSize();
  assert.equal(pane.scrollTop, 1800, 'plain log: at the tail, a font-size change keeps it on the last line');
}

console.log(
  'PASS: Book and Bulk auto-scroll controls jump on check, follow appends, disable when scrolled away, and show the last line when their tab comes back.',
);
