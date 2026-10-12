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

const elements = new Map(
  ['copyLog', 'log', 'autoscroll', 'blkAutoscroll', 'blkLog'].map(id => [id, new MockElement(id)]),
);
const document = {
  getElementById: id => elements.get(id) || null,
  createElement: tag => new MockElement(tag),
};
const source = await readFile(new URL('../src/webui/js/ui/log.js', import.meta.url), 'utf8');
const importLine = "import { $ } from '../util/dom.js';";
assert.equal(source.split(importLine).length - 1, 1, 'the module has one DOM-helper import');
assert.equal(source.split('export function logInto').length - 1, 1, 'logInto has one export declaration');
const runnable = source
  .replace(importLine, 'const $ = id => document.getElementById(id);')
  .replace('export function logInto', 'function logInto')
  .concat('\nglobalThis.__logInto = logInto;\n');
// The source runs in its own context; expose its appender through that context for isolated calls.
const appenderContext = vm.createContext({ document, navigator: { clipboard: { writeText: async () => {} } } });
vm.runInContext(runnable, appenderContext);
assert.equal(typeof appenderContext.__logInto, 'function');

for (const [checkboxId, paneId] of [['autoscroll', 'log'], ['blkAutoscroll', 'blkLog']]) {
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
}

console.log('PASS: Book and Bulk auto-scroll controls jump on check, follow appends, and disable when scrolled away.');
