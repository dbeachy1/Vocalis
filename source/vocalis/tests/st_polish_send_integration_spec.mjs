// Cross-boundary contract checks for the real Polish text and send runtime.
//
// The fixture below deliberately models only the public boundaries that the extension is
// allowed to use: the pairing settings read, the host quiet-generation API, the composer DOM,
// and the ordinary Send click.  It does not copy prompt assembly, validation, or operation
// state-machine logic from production.  The send handler records what crossed the boundary and
// then consumes the composer/file input exactly once, which makes attachment preservation
// observable without creating a second sending implementation.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'vocalis-polish-integration-'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function settings(prompt, immediateSend = true, enabled = true) {
  return {
    schema_version: 1,
    enabled,
    immediate_send: immediateSend,
    prompt,
    revision: `${prompt}-${immediateSend}-${enabled}`,
  };
}

class Classes {
  constructor(value = '') {
    this.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  add(value) {
    this.values.add(String(value));
  }
  remove(value) {
    this.values.delete(String(value));
  }
  contains(value) {
    return this.values.has(String(value));
  }
  toggle(value, force) {
    if (force === undefined) {
      if (this.values.has(String(value))) this.values.delete(String(value));
      else this.values.add(String(value));
    } else if (force) this.values.add(String(value));
    else this.values.delete(String(value));
  }
}

class Element {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.attrs = new Map();
    this.classList = new Classes();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.files = [];
    this.style = {};
    this.textContent = '';
    this.innerHTML = '';
    this.tabIndex = -1;
  }

  set id(value) {
    this._id = String(value);
  }
  get id() {
    return this._id || '';
  }
  set className(value) {
    this.classList = new Classes(value);
  }
  get className() {
    return [...this.classList.values].join(' ');
  }
  setAttribute(name, value) {
    this.attrs.set(String(name), String(value));
  }
  getAttribute(name) {
    return this.attrs.get(String(name));
  }
  addEventListener(type, listener) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }
  click() {
    this.dispatchEvent(new Event('click'));
  }
  focus() {
    this.focused = true;
  }
  setSelectionRange(start, end) {
    this.selection = [start, end];
  }
  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }
  insertAdjacentElement(position, child) {
    equal(position, 'afterend', 'fixture only supports the afterend insertion used by Vocalis');
    const parent = this.parentElement;
    assert(parent, 'cannot insert a control without a composer parent');
    if (child.parentElement) child.parentElement.removeChild(child);
    const index = parent.children.indexOf(this);
    parent.children.splice(index + 1, 0, child);
    child.parentElement = parent;
    return child;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return index > 0 ? this.parentElement.children[index - 1] : null;
  }
}

class Document {
  constructor(sendHandler) {
    this.listeners = new Map();
    this.body = new Element('body');
    this.form = new Element('div');
    this.form.id = 'rightSendForm';
    this.send = new Element('div');
    this.send.id = 'send_but';
    this.textarea = new Element('textarea');
    this.textarea.id = 'send_textarea';
    this.fileInput = new Element('input');
    this.fileInput.id = 'file_form_input';
    this.form.appendChild(this.send);
    this.form.appendChild(this.textarea);
    this.form.appendChild(this.fileInput);
    this.body.appendChild(this.form);
    this.send.addEventListener('click', sendHandler);
  }

  getElementById(id) {
    const visit = node => {
      if (node.id === id) return node;
      for (const child of node.children) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this.body);
  }

  createElement(tagName) {
    return new Element(tagName);
  }

  addEventListener(type, listener) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }
}

function installGlobals() {
  globalThis.Event = class {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
}

// Drains microtasks until a SYNCHRONOUS in-process predicate holds. Not the CDP `waitFor` that the
// browser specs copy (and that test_spec_guards pins by that name): nothing here evaluates in a
// page, so there is no page exception to treat as "not yet".
async function settleUntil(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function makeScenario(
  mod,
  { capability = 1, initialSettings = settings('initial prompt'), quietResult = 'The polished message.', delayedQuiet = false } = {},
) {
  let currentSettings = initialSettings;
  let chatId = 'controlled-chat';
  let quietCalls = [];
  let fetchCalls = [];
  let sendCalls = [];
  let quietResolve = null;
  let quietReject = null;
  let failures = [];
  let clientLogPosts = [];

  const sendHandler = () => {
    const text = doc.textarea.value;
    const attachments = doc.fileInput.files;
    sendCalls.push({ text, attachments });
    // This is the only host behavior represented here: ordinary Send consumes the composer and
    // its pending file input. It is intentionally not a second copy of Vocalis's handoff logic.
    doc.textarea.value = '';
    doc.fileInput.files = [];
    runtime.onRendered();
  };
  const doc = new Document(sendHandler);

  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url: String(url), headers: init.headers || {} });
    return {
      ok: true,
      status: 200,
      json: async () => currentSettings,
    };
  };

  const context = {
    quietGenerationCapabilities: capability == null ? undefined : Object.freeze({ reasoningOnlyFallback: capability }),
    getCurrentChatId: () => chatId,
    parseReasoningFromString: value => ({ content: value, reasoning: '' }),
    generateQuietPrompt: async options => {
      quietCalls.push(options);
      if (delayedQuiet) {
        return new Promise((resolve, reject) => {
          quietResolve = resolve;
          quietReject = reject;
        });
      }
      return typeof quietResult === 'function' ? quietResult(options) : quietResult;
    },
  };
  const runtime = mod.initializePolishSend({
    document: doc,
    getContext: () => context,
    getSettings: () => ({ enabled: true, serverUrl: 'https://vocalis.test', pairToken: 'pair-token' }),
    toast: { error: (message, title) => failures.push({ message, title }), info: () => {}, success: () => {} },
    postClientLog: async (url, init) => {
      clientLogPosts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 204 };
    },
    log: () => {},
  });

  return {
    doc,
    context,
    runtime,
    failures,
    clientLogPosts,
    get currentSettings() {
      return currentSettings;
    },
    set currentSettings(value) {
      currentSettings = value;
    },
    get chatId() {
      return chatId;
    },
    set chatId(value) {
      chatId = value;
    },
    quietCalls,
    fetchCalls,
    sendCalls,
    resolveQuiet(value = quietResult) {
      assert(quietResolve, 'no delayed quiet request is pending');
      const resolve = quietResolve;
      quietResolve = null;
      quietReject = null;
      resolve(value);
    },
    rejectQuiet(error = new Error('controlled quiet failure')) {
      assert(quietReject, 'no delayed quiet request is pending');
      const reject = quietReject;
      quietResolve = null;
      quietReject = null;
      reject(error);
    },
  };
}

async function run() {
  installGlobals();
  await cp(new URL('../sillytavern/extension/polish-send.js', import.meta.url), join(root, 'polish-send.mjs'));
  await cp(new URL('../sillytavern/extension/vocalis-stream.js', import.meta.url), join(root, 'vocalis-stream.js'));
  const mod = await import(pathToFileURL(join(root, 'polish-send.mjs')));

  // Settings propagation, required quiet options, attachment preservation, and the real Send
  // handoff all cross the production module in one controlled operation.
  {
    const scenario = makeScenario(mod, { quietResult: 'I whisper, "Hello, Test Character."' });
    await scenario.runtime.refresh();
    scenario.currentSettings = settings('latest saved prompt');
    scenario.doc.textarea.value = 'I whisper, says hello.';
    const attachment = { name: 'controlled-fixture.txt' };
    scenario.doc.fileInput.files = [attachment];
    await scenario.runtime.activate();

    equal(scenario.quietCalls.length, 1, 'one quiet generation request crosses the host boundary');
    const quietOptions = scenario.quietCalls[0];
    equal(quietOptions.skipWIAN, false, "quiet generation keeps World Info and Author's Note enabled");
    equal(quietOptions.removeReasoning, true, 'quiet generation removes reasoning from final content');
    equal(quietOptions.recoverReasoningOnly, true, 'quiet generation opts into reasoning-only recovery');
    equal(quietOptions.trimToSentence, false, 'quiet generation preserves deliberate trailing fragments');
    assert(quietOptions.quietPrompt.includes('latest saved prompt'), 'the latest settings snapshot governs the click');
    equal(scenario.sendCalls.length, 1, 'the polished text is handed to the ordinary Send click once');
    equal(scenario.sendCalls[0].text, 'I whisper, "Hello, Test Character."', 'the real Send handler receives only the candidate');
    equal(scenario.sendCalls[0].attachments[0], attachment, 'the existing attachment reaches ordinary Send untouched');
    equal(scenario.doc.fileInput.files.length, 0, 'attachment consumption remains owned by ordinary Send');
    assert(scenario.fetchCalls.length >= 2, 'settings refresh occurs at initialization and immediately before polish');
    assert(
      scenario.fetchCalls.every(call => call.headers.Authorization === 'Bearer pair-token'),
      'settings reads carry the pairing bearer',
    );
    equal(scenario.runtime.state, 'IDLE', 'successful real Send handoff returns to idle');
  }

  // A missing or wrong capability version gates only the green control and cannot trigger a
  // quiet request or a normal send.
  {
    const scenario = makeScenario(mod, { capability: 0 });
    await scenario.runtime.refresh();
    scenario.doc.textarea.value = 'This must remain ordinary.';
    await scenario.runtime.activate();
    const control = scenario.doc.getElementById('vocalis_polish_send');
    assert(control, 'the control remains present when the host capability is unavailable');
    equal(control.getAttribute('aria-disabled'), 'true', 'unsupported host capability disables the green control');
    equal(scenario.quietCalls.length, 0, 'unsupported host capability starts no quiet generation');
    equal(scenario.sendCalls.length, 0, 'unsupported host capability sends nothing');
    equal(scenario.doc.textarea.value, 'This must remain ordinary.', 'ordinary composer text remains untouched');
  }

  // Duplicate activation is synchronously ignored, and a concurrent composer edit prevents a
  // late quiet result from replacing or sending the user's newer text.
  {
    const scenario = makeScenario(mod, { delayedQuiet: true });
    await scenario.runtime.refresh();
    scenario.doc.textarea.value = 'Original dictated text.';
    const first = scenario.runtime.activate();
    const second = scenario.runtime.activate();
    await settleUntil(() => scenario.quietCalls.length === 1, 'the first quiet request');
    equal(scenario.quietCalls.length, 1, 'duplicate activation produces one quiet request');
    scenario.doc.textarea.value = 'User edited while polishing.';
    scenario.resolveQuiet('Edited but stale result.');
    await first;
    await second;
    equal(scenario.sendCalls.length, 0, 'a concurrent composer edit produces no send');
    equal(scenario.doc.textarea.value, 'User edited while polishing.', 'a concurrent edit is never overwritten');
    equal(scenario.runtime.state, 'IDLE', 'a stale operation releases its slot');
  }

  // A chat switch is the other cross-boundary freshness guard. Ordinary Send during the same
  // delay remains allowed and must be the only message sent.
  {
    const scenario = makeScenario(mod, { delayedQuiet: true });
    await scenario.runtime.refresh();
    scenario.doc.textarea.value = 'Chat-bound dictated text.';
    const polish = scenario.runtime.activate();
    await settleUntil(() => scenario.quietCalls.length === 1, 'the delayed quiet request');
    scenario.chatId = 'different-controlled-chat';
    scenario.resolveQuiet('Late result from the old chat.');
    await polish;
    equal(scenario.sendCalls.length, 0, 'a chat switch produces no late send');
    equal(scenario.doc.textarea.value, 'Chat-bound dictated text.', 'chat switch preserves the original composer');

    const ordinary = makeScenario(mod, { delayedQuiet: true });
    await ordinary.runtime.refresh();
    ordinary.doc.textarea.value = 'Ordinary Send wins.';
    const delayed = ordinary.runtime.activate();
    await settleUntil(() => ordinary.quietCalls.length === 1, 'ordinary-send race quiet request');
    ordinary.doc.send.click();
    ordinary.resolveQuiet('Stale polish must not send.');
    await delayed;
    equal(ordinary.sendCalls.length, 1, 'ordinary Send remains usable during polishing');
    equal(ordinary.sendCalls[0].text, 'Ordinary Send wins.', 'ordinary Send sends the unpolished composer text');
  }

  // 🔴 SillyTavern catches some streaming errors after showing a transient toast, so
  // `generateQuietPrompt` can resolve with empty text. Preserve the provider's message in the
  // persistent Vocalis report when the empty result crosses that boundary.
  {
    const hostToastr = { error: () => {}, info: () => {}, success: () => {}, warning: () => {} };
    globalThis.toastr = hostToastr;
    const scenario = makeScenario(mod, {
      quietResult: () => {
        globalThis.toastr.error('model is overloaded, try again later', 'Chat Completion API');
        return '';
      },
    });
    await scenario.runtime.refresh();
    scenario.doc.textarea.value = 'Dictated text that never got polished.';
    await scenario.runtime.activate();

    equal(scenario.sendCalls.length, 0, 'an empty generation sends nothing');
    equal(scenario.doc.textarea.value, 'Dictated text that never got polished.', 'the draft survives an empty generation');
    equal(scenario.failures.length, 1, 'an empty generation raises exactly one failure report');
    const report = scenario.failures[0];
    assert(report.title.includes('no_text'), `the report names the failing check: ${report.title}`);
    assert(report.message.includes('validatePolishResult'), 'the report says where in the code it refused');
    assert(report.message.includes('model is overloaded'), "the report quotes SillyTavern's own error toast");
    equal(globalThis.toastr.error, hostToastr.error, "the host's toastr.error is restored after the operation");

    // Send the report to Taproom's `/api/client-log` as separate fields. The fork classifies
    // values individually: numbers and booleans remain visible while strings require debug mode.
    // A pre-joined blob would put numeric counts behind that gate.
    await settleUntil(() => scenario.clientLogPosts.length === 1, 'the client-log report');
    const posted = scenario.clientLogPosts[0];
    equal(posted.url, '/api/client-log', 'the report goes to the fork route that writes st.log');
    equal(posted.body.source, 'vocalis-polish', 'the report names a source the fork has registered');
    equal(posted.body.event, 'polish_failed', 'the event is the lower-case slug the fork accepts');
    equal(posted.body.code, 'no_text', 'the failure code crosses as its own field, so it is logged unsuppressed');
    assert(typeof posted.body.fields.inputChars === 'number', 'counts cross as numbers, which the fork logs in the clear');
    assert(posted.body.fields.where.includes('validatePolishResult'), 'the site crosses as its own field');
    assert(posted.body.fields.sillytavern.includes('model is overloaded'), "SillyTavern's own error text is carried to the log");
    for (const key of Object.keys(posted.body.fields)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) throw new Error(`the fork would drop the field name ${key}`);
    }
    delete globalThis.toastr;
  }

  console.log('st_polish_send_integration_spec: ok');
}

try {
  await run();
} finally {
  await rm(root, { recursive: true, force: true });
  if (existsSync(root)) throw new Error(`owned temp root survived: ${root}`);
}
