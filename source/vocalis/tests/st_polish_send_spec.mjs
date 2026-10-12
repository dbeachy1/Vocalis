// Focused contract checks for the Vocalis Polish text and send runtime. The production module is
// copied into an owned temporary module directory because Node treats this repository's .js files
// as CommonJS while SillyTavern loads them as browser ES modules.
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Each section reports `  ok   …` so the wrapper's assert_spec_ran can prove the spec ran to the
// end rather than merely exiting 0. Every failure throws, so reaching an ok() means it passed.
const ok = what => console.log(`  ok   ${what}`);

const root = await mkdtemp(join(tmpdir(), 'vocalis-polish-send-'));
try {
  const style = await readFile(new URL('../sillytavern/extension/style.css', import.meta.url), 'utf8');
  if (!/\.vocalis_polish_send\s*\{[^}]*\border:\s*2;/s.test(style)) {
    throw new Error("the polish action must share Taproom's order-2 Send control");
  }
  if (!/\.vocalis_polish_send\s*\{[^}]*\bflex:\s*0\s+0\s+calc\(var\(--bottomFormBlockSize\)\s*\+\s*0\.35rem\);/s.test(style)) {
    throw new Error('the polish action must reserve space for its quote marks');
  }
  if (!/#rightSendForm\.vocalis_polish_send_rail\s*>\s*#send_but\.displayNone\s*\{[^}]*display:\s*flex\s*!important;/s.test(style)) {
    throw new Error('the Vocalis-owned rail must keep Taproom’s default Send plane visible');
  }
  if (!/#rightSendForm\.vocalis_polish_send_pair\s*\{[^}]*flex:\s*0\s+0\s+calc\([^}]*flex-wrap:\s*nowrap;/s.test(style)) {
    throw new Error('the paired control rail must not wrap when host state changes');
  }
  if (
    !/#send_form:not\(\.compact\)\s+#rightSendForm\.vocalis_polish_send_pair\s*>\s*#send_but\s*,\s*\n?\s*#send_form:not\(\.compact\)\s+#rightSendForm\.vocalis_polish_send_pair\s*>\s*\.vocalis_polish_send\s*\{[^}]*align-self:\s*center;/s.test(
      style,
    )
  ) {
    throw new Error('the paired send planes must center in a tall non-compact composer');
  }
  if (
    !/#rightSendForm\.vocalis_polish_send_rail:not\(\.vocalis_polish_send_pair\)\s*\{[^}]*flex:\s*0\s+0\s+calc\([^}]*flex-wrap:\s*nowrap;/s.test(
      style,
    )
  ) {
    throw new Error('the disabled Polish state must collapse to a one-button rail');
  }
  if (
    !/#rightSendForm\.vocalis_polish_send_rail\s*>\s*\.mes_stop\s*\{[^}]*flex:\s*0\s+0\s+var\(--bottomFormBlockSize\);[^}]*width:\s*var\(--bottomFormBlockSize\);[^}]*height:\s*var\(--bottomFormBlockSize\);[^}]*align-self:\s*center;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s.test(
      style,
    )
  ) {
    throw new Error('Taproom’s generation Stop control must retain the paired row geometry');
  }
  if (!/#send_textarea\.vocalis_polish_composer_busy\s*\{[^}]*cursor:\s*wait;/s.test(style)) {
    throw new Error('the composer must visibly indicate an active polish operation');
  }
  if (
    /vocalis-polish-spin|\.vocalis_polish_send\.vocalis_polish_busy\s+\.fa-paper-plane\s*\{[^}]*\b(?:animation|transform)\s*:/s.test(style)
  ) {
    throw new Error('the asymmetric paper-plane glyph must not move out of alignment while busy');
  }
  ok('the paired Send rail CSS contract holds');
  await cp(new URL('../sillytavern/extension/polish-send.js', import.meta.url), join(root, 'polish-send.mjs'));
  await cp(new URL('../sillytavern/extension/vocalis-stream.js', import.meta.url), join(root, 'vocalis-stream.js'));
  const mod = await import(pathToFileURL(join(root, 'polish-send.mjs')));

  const assembled = mod.assemblePolishPrompt('Prompt', 'Say {{user}} hello', 'op');
  if (!assembled.prompt.includes('Say [[[VOCALIS_MACRO_op_0]]] hello')) throw new Error('macro was not protected');
  const valid = mod.validatePolishResult('Say {{user}} hello', 'Say [[[VOCALIS_MACRO_op_0]]] hello', assembled.macros, {});
  if (!valid.ok || valid.value !== 'Say {{user}} hello') throw new Error('macro did not round-trip');
  ok('macros are protected and round-trip');
  // The validator checks structural integrity, not the meaning of ordinary prose. These cases cover
  // refusal-like wording, prefaces, fences/scene breaks, and low overlap as valid text.
  const cantDraft = "I can't help but grin at her energy, and I say, well, thank you again. do you have a couch I could sleep on tonight?";
  const cantPolished =
    'I can’t help but grin at her energy, and I say, "Well, thank you again. Do you have a couch I could sleep on tonight?"';
  const draft100 = 'She hands me the lantern and I follow her down the long hallway, counting doors as we pass them.';
  for (const [draft, output] of [
    [cantDraft, cantPolished],
    ['Unable to sleep, I pace the long hallway until the candles burn down to stubs.', 'Unable to sleep, I pace the long hallway.'],
    ['Error is the word the guard uses, and I nod.', 'Error is the word the guard uses, and I nod.'],
    ['She hands me the lantern.', "I can't help with that request."],
    [draft100, 'Here is the polished text: she hands me the lantern.'],
    [draft100, 'She hands me the lantern.\n\n~~~\n\nLater, I follow her down the hallway.'],
    [draft100, 'Something utterly different, sharing almost no words with the draft at all, twice as long as it was.'],
  ]) {
    const checked = mod.validatePolishResult(draft, output, [], {});
    if (!checked.ok || checked.value !== output) throw new Error(`text was rejected as ${checked.reason}`);
  }
  const metrics = mod.similarityMetrics(cantDraft, cantPolished);
  if (metrics.coverage < 0.9 || !(metrics.lengthRatio > 0.9 && metrics.lengthRatio < 1.1)) throw new Error('similarity metrics are wrong');
  ok('text is never rejected for what it says, and its shape is measured');
  // Mechanical failures are still refused.
  if (mod.validatePolishResult('hello', `x ${assembled.end}`, [], {}).reason !== 'no_text')
    throw new Error('leaked delimiter was accepted');
  if (mod.validatePolishResult('hello', '<think>plan</think>', [], {}).reason !== 'reasoning')
    throw new Error('bare reasoning was accepted');
  if (mod.validatePolishResult('Say {{user}} hello', 'Say hello', assembled.macros, {}).reason !== 'macros') {
    throw new Error('a dropped macro placeholder was accepted');
  }
  for (const gone of ['preface', 'model_error', 'changed_too_much', 'formatting']) {
    if (mod.polishFailureMessage(gone) !== 'Polish did not return a usable revision. Your draft is unchanged.') {
      throw new Error(`${gone} still has a dedicated message`);
    }
  }
  const finalWins = mod.validatePolishResult(
    'A conservative edit keeps these words in place.',
    'A conservative edit keeps these words in place.',
    [],
    {
      parseReasoningFromString: () => ({ content: 'A conservative edit keeps these words in place.', reasoning: 'private reasoning' }),
    },
  );
  if (!finalWins.ok || finalWins.value.includes('private reasoning')) throw new Error('final content did not win');
  const reasoningFallback = mod.validatePolishResult(
    'A conservative edit keeps these words in place.',
    'A conservative edit keeps these words in place.',
    [],
    {
      parseReasoningFromString: () => ({ content: '', reasoning: 'A conservative edit keeps these words in place.' }),
    },
  );
  if (!reasoningFallback.ok) throw new Error('reasoning-only fallback was rejected');
  if (mod.validatePolishResult('A conservative edit keeps these words in place.', '', [], {}).ok)
    throw new Error('blank response was accepted');
  ok('mechanical failures and the reasoning channel are still handled');

  // A failure should retain the backend's useful message and payload instead of exposing only a
  // generic UI error or leaving the server log as the sole diagnostic.
  const objectThrow = mod.describeThrown(Object.assign(new Error({ error: { message: 'model is overloaded' } }), {}));
  if (objectThrow.message !== '') throw new Error('an [object Object] message must not be reported as the backend message');
  const jsonThrow = mod.describeThrown({ error: { message: 'model is overloaded' }, status: 503 });
  if (jsonThrow.message !== 'model is overloaded' || !jsonThrow.payload.includes('overloaded')) {
    throw new Error('a thrown response JSON did not surrender its message');
  }
  if (mod.describeThrown(new Error('Got response status 500')).message !== 'Got response status 500') {
    throw new Error('a plain Error message was lost');
  }
  if (!/HTTP 500/.test(mod.diagnoseGenerationError('Error', 'Got response status 500'))) {
    throw new Error('an HTTP status was not diagnosed');
  }
  if (!/unauthorized/i.test(mod.diagnoseGenerationError('Error', 'Got response status 401'))) {
    throw new Error('an auth failure was not diagnosed');
  }
  if (!/aborted/i.test(mod.diagnoseGenerationError('AbortError', ''))) throw new Error('an abort was not diagnosed');

  // When an Error has no message or payload, its stack is the remaining diagnostic. Preserve the
  // call site so an empty-message throw is still actionable.
  const silent = mod.describeThrown(
    Object.assign(new Error(undefined), {
      stack: [
        'Error',
        '    at onSuccess (https://test-server.invalid:8001/script.js:6392:19)',
        '    at async Generate (https://test-server.invalid:8001/script.js:6549:16)',
        '    at async Object.activate (https://test-server.invalid:8001/scripts/extensions/third-party/vocalis/polish-send.js:824:22)',
      ].join('\n'),
    }),
  );
  if (silent.message !== '' || silent.payload !== '') throw new Error('a message-less Error reported a message or a payload');
  if (!/script\.js:6392:19/.test(silent.stack) || !/onSuccess/.test(silent.stack)) {
    throw new Error('the throw site was discarded — a message-less Error then carries nothing at all');
  }
  if (/test-server\.invalid:8001/.test(silent.stack)) throw new Error('the compacted stack must not carry the origin on every frame');
  if (!/vocalis\/polish-send\.js/.test(silent.stack)) throw new Error('a nested path lost the directory that identifies it');
  if (mod.describeStack(new Error('no stack here')) === undefined) throw new Error('describeStack must always return a string');
  if (mod.describeStack('a thrown string') !== '' || mod.describeStack(null) !== '') {
    throw new Error('a value with no stack must produce no throw site');
  }
  const silentWhy = mod.diagnoseGenerationError('Error', '', silent.stack);
  if (!/onSuccess/.test(silentWhy) || !/nothing here is a verdict on your model backend/i.test(silentWhy)) {
    throw new Error('an empty SillyTavern error was not diagnosed as a SillyTavern-side throw');
  }
  if (!mod.formatPolishFailure({ code: 'generate', stack: silent.stack }).html.includes('Threw at')) {
    throw new Error('the report did not show the throw site');
  }
  const redacted = mod.redactDraft(
    'provider echoed: I lean against the doorway and wait for her',
    'I lean against the doorway and wait for her',
    'op',
  );
  if (redacted.includes('doorway') || !redacted.includes('«draft»')) throw new Error('the draft reached a displayed message');
  const rendered = mod.formatPolishFailure({
    code: 'generate',
    why: 'because the provider said so',
    backend: 'Error: model is overloaded',
    host: ['Chat Completion API — model is overloaded'],
    facts: { durationMs: 12 },
  });
  if (!rendered.title.includes('generate')) throw new Error('the report did not name its failure code');
  for (const fragment of [
    'What failed',
    'Where',
    'polish-send.js',
    'Likely cause',
    'Backend said',
    'model is overloaded',
    'SillyTavern said',
  ]) {
    if (!rendered.html.includes(fragment)) throw new Error(`the report omitted ${fragment}`);
    if (!rendered.text.includes(fragment)) throw new Error(`the logged report omitted ${fragment}`);
  }
  if (mod.formatPolishFailure({ code: 'no_text', backend: '<img src=x onerror=alert(1)>' }).html.includes('<img'))
    throw new Error('a backend message was not escaped before being rendered as HTML');
  if (Object.keys(mod.POLISH_FAILURE_SITES).some(code => !mod.POLISH_FAILURE_SITES[code].where.includes('polish-send.js')))
    throw new Error('every failure site must name where in the code it refused');
  ok('every failure carries its site, its likely cause, and the backend’s own words');

  class Classes {
    constructor(value = '') {
      this.values = new Set(value.split(/\s+/).filter(Boolean));
    }
    add(value) {
      this.values.add(value);
    }
    contains(value) {
      return this.values.has(value);
    }
    toggle(value, on) {
      if (on) this.values.add(value);
      else this.values.delete(value);
    }
  }
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.listeners = {};
      this.attrs = {};
      this.classList = new Classes();
      this.hidden = false;
      this.disabled = false;
      this.value = '';
    }
    set id(value) {
      this._id = value;
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
      this.attrs[name] = String(value);
    }
    getAttribute(name) {
      return this.attrs[name];
    }
    addEventListener(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    }
    removeEventListener(name, fn) {
      this.listeners[name] = (this.listeners[name] || []).filter(listener => listener !== fn);
    }
    insertAdjacentElement(_, child) {
      const i = this.parentElement?.children.indexOf(this) ?? -1;
      child.parentElement = this.parentElement;
      this.parentElement.children.splice(i + 1, 0, child);
    }
    get previousElementSibling() {
      const i = this.parentElement?.children.indexOf(this) ?? -1;
      return i > 0 ? this.parentElement.children[i - 1] : null;
    }
    dispatchEvent(event) {
      for (const fn of this.listeners[event.type] || []) fn(event);
    }
    focus() {}
    setSelectionRange() {}
    click() {
      for (const fn of this.listeners.click || []) fn({});
    }
  }
  class Document {
    constructor() {
      this.listeners = {};
      this.body = new Element('body');
      this.send = new Element('div');
      this.send.id = 'send_but';
      this.form = new Element('div');
      this.form.id = 'rightSendForm';
      this.textarea = new Element('textarea');
      this.textarea.id = 'send_textarea';
      this.form.children.push(this.send, this.textarea);
      this.send.parentElement = this.form;
      this.textarea.parentElement = this.form;
      this.body.children.push(this.form);
      this.form.parentElement = this.body;
    }
    getElementById(id) {
      const visit = node => (node.id === id ? node : node.children.map(visit).find(Boolean));
      return visit(this.body);
    }
    createElement(tag) {
      return new Element(tag);
    }
    addEventListener(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    }
    dispatchEvent(event) {
      for (const fn of this.listeners[event.type] || []) fn(event);
    }
  }
  const doc = new Document();
  const mutationObservers = [];
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.observations = [];
      mutationObservers.push(this);
    }
    observe(target, options) {
      this.observations.push({ target, options });
    }
    disconnect() {}
  };
  globalThis.getComputedStyle = element => ({
    display: element.id === 'send_but' && doc.body.getAttribute('data-generating') === 'true' ? 'none' : 'flex',
    visibility: 'visible',
  });
  let quietCalls = 0;
  let lastQuietPrompt = '';
  /** @type {(value: string) => void} */
  let resolveQuietResult;
  /** @type {() => void} */
  let signalQuietStarted;
  const quietStarted = new Promise(resolve => {
    signalQuietStarted = resolve;
  });
  let extensionEnabled = true;
  let deferredSettingsResponse = null;
  // A Vocalis that has just restarted refuses every request until someone logs in — the
  // before-request gate answers 401 {"error":"locked"} (vocalis_server.py _require_unlocked).
  let vocalisLocked = false;
  globalThis.fetch = async () => {
    if (deferredSettingsResponse) {
      const response = deferredSettingsResponse;
      deferredSettingsResponse = null;
      return response;
    }
    return vocalisLocked
      ? { ok: false, status: 401, json: async () => ({ error: 'locked', message: 'Vocalis is locked. Log in to unlock.' }) }
      : {
          ok: true,
          status: 200,
          json: async () => ({ schema_version: 1, enabled: extensionEnabled, immediate_send: false, prompt: 'Prompt', revision: 'r' }),
        };
  };
  let currentChatId = 'chat';
  const context = {
    quietGenerationCapabilities: Object.freeze({ reasoningOnlyFallback: 1 }),
    getCurrentChatId: () => currentChatId,
    parseReasoningFromString: value => ({ content: value, reasoning: '' }),
    generateQuietPrompt: async options => {
      quietCalls++;
      if (options.skipWIAN !== false || !options.removeReasoning || !options.recoverReasoningOnly || options.trimToSentence)
        throw new Error('quiet options mismatch');
      if (quietCalls === 2) throw new Error('quiet generation failed');
      // A real model answers with the PROTECTED text — the macro placeholder still in it. Echoing
      // the draft's own `{{user}}` instead made this fixture's "successful" polish fail validation
      // as a dropped macro, which stayed invisible while a rejected polish looked like a quiet
      // no-op. Hand back exactly what was sent, delimiters stripped.
      lastQuietPrompt = String(options.quietPrompt || '');
      signalQuietStarted();
      return new Promise(resolve => {
        resolveQuietResult = resolve;
      });
    },
  };
  const errors = [];
  const runtime = mod.initializePolishSend({
    document: doc,
    getContext: () => context,
    getSettings: () => ({ enabled: true, serverUrl: 'https://vocalis', pairToken: 'token' }),
    toast: { error: (message, title, toastOptions) => errors.push({ message, title, toastOptions }), info: () => {}, success: () => {} },
    log: () => {},
  });
  await runtime.refresh();
  const control = doc.getElementById('vocalis_polish_send');
  if (!control || control.previousElementSibling !== doc.send) throw new Error('control was not reconciled');
  if (control.title !== 'Polish Text and Send' || control.getAttribute('aria-label') !== 'Polish Text and Send') {
    throw new Error('the feature title must use title capitalization');
  }
  if (!/textarea\.disabled\s*=\s*busy;/.test(await readFile(join(root, 'polish-send.mjs'), 'utf8'))) {
    throw new Error('the composer must be disabled while polish is active');
  }
  if (!doc.form.classList.contains('vocalis_polish_send_rail') || !doc.form.classList.contains('vocalis_polish_send_pair')) {
    throw new Error('composer was not marked as a Vocalis-owned paired control rail');
  }
  ok('the control is reconciled beside Send');
  extensionEnabled = false;
  await runtime.refresh();
  if (
    !control.hidden ||
    doc.form.classList.contains('vocalis_polish_send_pair') ||
    !doc.form.classList.contains('vocalis_polish_send_rail')
  ) {
    throw new Error('disabling Polish Text and Send did not hide only its icon and collapse paired-rail width');
  }
  let disabledEnterPrevented = false;
  let disabledEnterStopped = false;
  doc.textarea.value = 'Default Send must retain this draft';
  doc.dispatchEvent({
    type: 'keydown',
    target: doc.textarea,
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: () => {
      disabledEnterPrevented = true;
    },
    stopImmediatePropagation: () => {
      disabledEnterStopped = true;
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  if (disabledEnterPrevented || disabledEnterStopped || quietCalls !== 0 || doc.textarea.disabled) {
    throw new Error('disabled Polish Text and Send still intercepted Enter or started polishing');
  }
  // Enter with one modifier held. Returns what the handler did with the event.
  let sendClicks = 0;
  doc.send.addEventListener('click', () => sendClicks++);
  const modifiedEnter = modifier => {
    const seen = { prevented: false, stopped: false };
    doc.dispatchEvent({
      type: 'keydown',
      target: doc.textarea,
      key: 'Enter',
      shiftKey: modifier === 'shift',
      ctrlKey: modifier === 'ctrl',
      altKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault: () => {
        seen.prevented = true;
      },
      stopImmediatePropagation: () => {
        seen.stopped = true;
      },
    });
    return seen;
  };
  const disabledCtrl = modifiedEnter('ctrl');
  if (disabledCtrl.prevented || disabledCtrl.stopped || sendClicks !== 0) {
    throw new Error("disabled Polish Text and Send took Ctrl+Enter away from Taproom's regenerate");
  }
  extensionEnabled = true;
  await runtime.refresh();
  if (
    control.hidden ||
    !doc.form.classList.contains('vocalis_polish_send_rail') ||
    !doc.form.classList.contains('vocalis_polish_send_pair')
  ) {
    throw new Error('re-enabling Polish Text and Send did not restore its paired control');
  }
  doc.body.setAttribute('data-generating', 'true');
  const bodyObserver = mutationObservers.find(observer => observer.observations.some(entry => entry.target === doc.body));
  bodyObserver?.callback([]);
  if (control.hidden) throw new Error('control disappeared when Taproom hid Send');
  doc.body.setAttribute('data-generating', 'false');
  bodyObserver?.callback([]);
  if (control.hidden) throw new Error('control disappeared after Taproom restored Send');
  ok('disabling releases Enter; re-enabling and host repaints keep the control');
  doc.textarea.value = 'Send this exactly as typed';
  // Shift+Enter inserts a composer newline; Polish must not intercept it.
  const newline = modifiedEnter('shift');
  await new Promise(resolve => setTimeout(resolve, 0));
  if (newline.prevented || newline.stopped || sendClicks !== 0 || quietCalls !== 0) {
    throw new Error('Polish took Shift+Enter away from its newline');
  }
  const direct = modifiedEnter('ctrl');
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!direct.prevented || !direct.stopped) throw new Error("Ctrl+Enter fell through to Taproom's regenerate while Polish is on");
  if (sendClicks !== 1) throw new Error(`Ctrl+Enter clicked Send ${sendClicks} times, not once`);
  if (quietCalls !== 0 || doc.textarea.disabled || doc.textarea.value !== 'Send this exactly as typed') {
    throw new Error('Ctrl+Enter polished the draft instead of sending it as typed');
  }
  ok('Ctrl+Enter sends the draft as typed, and Shift+Enter stays a newline');
  let enterPrevented = false;
  let propagationStopped = false;
  doc.textarea.value = 'Say {{user}} hello';
  doc.dispatchEvent({
    type: 'keydown',
    target: doc.textarea,
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: () => {
      enterPrevented = true;
    },
    stopImmediatePropagation: () => {
      propagationStopped = true;
    },
  });
  if (!enterPrevented || !propagationStopped) throw new Error('plain Enter did not route to the polish action');
  await quietStarted;
  if (doc.textarea.disabled !== true || !doc.textarea.classList.contains('vocalis_polish_composer_busy')) {
    throw new Error('plain Enter did not start the Polish-and-Send operation or disable the composer');
  }
  const sent = /_BEGIN>>>\n([\s\S]*?)\n<<<VOCALIS_TEXT_/.exec(lastQuietPrompt);
  if (!sent) throw new Error('the assembled prompt did not carry the draft between its delimiters');
  resolveQuietResult(sent[1]);
  await new Promise(resolve => setTimeout(resolve, 0));
  if (quietCalls !== 1 || doc.textarea.value !== 'Say {{user}} hello' || doc.textarea.disabled === true) {
    throw new Error('Enter-to-Polish did not restore the composer after polishing once');
  }
  if (errors.length) throw new Error(`a successful polish raised a failure report: ${errors[0].title}`);
  ok('Enter polishes once and restores the composer');
  doc.textarea.value = 'Preserve this on failure';
  await runtime.activate();
  if (doc.textarea.disabled === true || doc.textarea.value !== 'Preserve this on failure' || errors.length !== 1) {
    throw new Error('a polish error did not restore the composer, preserve the draft, and show exactly one error');
  }
  const failure = errors[0];
  if (!failure.title.includes('Polish failed') || !failure.message.includes('quiet generation failed')) {
    throw new Error('the failure report did not quote what SillyTavern actually threw');
  }
  if (!failure.message.includes('generateQuietPrompt') || !failure.message.includes('Likely cause')) {
    throw new Error('the failure report did not say where it failed or what is likely wrong');
  }
  // It has to survive being read: toastr's default five-second fade is how the last one got away.
  if (failure.toastOptions?.timeOut !== 0 || failure.toastOptions?.escapeHtml !== false || !failure.toastOptions?.closeButton) {
    throw new Error('the failure report must stay on screen until it is dismissed');
  }
  ok('a generation error preserves the draft and reports what, where, and why');

  // An unknown settings snapshot must not be treated as Polish being disabled. Otherwise Enter can
  // fall back to the host's plain-send behavior before the runtime has loaded its settings.
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const drain = async () => {
    for (let i = 0; i < 20; i++) await tick();
  };
  vocalisLocked = true;
  await runtime.refresh();
  if (runtime.settings !== null) throw new Error('fixture: a refused settings read must leave the snapshot unknown');
  const clicksBefore = sendClicks;
  const errorsBefore = errors.length;
  const callsBefore = quietCalls;
  doc.textarea.value = 'Polish me once Vocalis answers';
  const lockedEnter = modifiedEnter();
  await drain();
  if (!lockedEnter.prevented || !lockedEnter.stopped)
    throw new Error('Enter fell through to the plain send while the settings were unknown');
  if (sendClicks !== clicksBefore) throw new Error('Enter did a plain send of an unpolished draft while Vocalis was refusing requests');
  if (quietCalls !== callsBefore || doc.textarea.value !== 'Polish me once Vocalis answers' || doc.textarea.disabled) {
    throw new Error('a refused settings read did not leave the draft untouched');
  }
  if (errors.length !== errorsBefore + 1 || !/locked/.test(errors[errors.length - 1].message)) {
    throw new Error("Enter against a refusing Vocalis did not report Vocalis's own reason");
  }
  ok('with the settings unknown, Enter asks Vocalis and reports its refusal instead of a plain send');

  const lockedCtrl = modifiedEnter('ctrl');
  await drain();
  if (!lockedCtrl.prevented || sendClicks !== clicksBefore + 1)
    throw new Error('Ctrl+Enter did not send as typed while the settings were unknown');
  ok('with the settings unknown, Ctrl+Enter still sends as typed');

  // Vocalis is back, and nothing has told the tab. The next Enter must polish.
  vocalisLocked = false;
  doc.textarea.value = 'Polish me once Vocalis answers';
  const recovered = modifiedEnter();
  for (let i = 0; i < 50 && quietCalls === callsBefore; i++) await tick();
  if (!recovered.prevented || quietCalls !== callsBefore + 1) throw new Error('Enter did not polish once Vocalis answered again');
  const resent = /_BEGIN>>>\n([\s\S]*?)\n<<<VOCALIS_TEXT_/.exec(lastQuietPrompt);
  if (!resent) throw new Error('the recovered polish did not carry the draft');
  resolveQuietResult(resent[1]);
  await drain();
  if (doc.textarea.disabled || sendClicks !== clicksBefore + 1 || errors.length !== errorsBefore + 1) {
    throw new Error('the recovered polish did not complete cleanly');
  }
  ok('Enter polishes again as soon as Vocalis answers, with nothing else re-reading the settings');

  // The green button had the same hole: it refused on a null snapshot without asking again.
  vocalisLocked = true;
  await runtime.refresh();
  vocalisLocked = false;
  doc.textarea.value = 'Polish me from the button';
  const buttonPress = runtime.activate();
  for (let i = 0; i < 50 && quietCalls === callsBefore + 1; i++) await tick();
  if (quietCalls !== callsBefore + 2) throw new Error('the Polish button refused on unknown settings instead of asking Vocalis');
  resolveQuietResult(/_BEGIN>>>\n([\s\S]*?)\n<<<VOCALIS_TEXT_/.exec(lastQuietPrompt)[1]);
  await buttonPress;
  if (errors.length !== errorsBefore + 1) throw new Error('the recovered button polish raised a failure report');
  ok('the Polish button asks Vocalis when the settings are unknown');

  // Unknown, then Vocalis answers that Polish is OFF: Enter is the plain send it always was.
  vocalisLocked = true;
  await runtime.refresh();
  vocalisLocked = false;
  extensionEnabled = false;
  doc.textarea.value = 'Polish is off, so send me plainly';
  modifiedEnter();
  await drain();
  if (sendClicks !== clicksBefore + 2 || quietCalls !== callsBefore + 2 || errors.length !== errorsBefore + 1) {
    throw new Error('Enter did not fall back to the plain send once Vocalis said Polish is off');
  }
  ok('once Vocalis says Polish is off, Enter is the plain send');

  // A settings response belongs to the Enter gesture that requested it. If the user switches
  // chats while it is in flight, neither the disabled fallback nor the enabled polish may adopt
  // the new chat's composer.
  const deferredSettings = () => {
    let resolve;
    const promise = new Promise(done => (resolve = done));
    deferredSettingsResponse = promise;
    return resolve;
  };
  const switchChatDuringUnknownEnter = async (enabled, click = false) => {
    vocalisLocked = true;
    await runtime.refresh();
    vocalisLocked = false;
    extensionEnabled = enabled;
    currentChatId = 'chat-a';
    doc.textarea.value = 'Draft owned by chat A';
    const resolveSettings = deferredSettings();
    const clicks = sendClicks;
    const quiet = quietCalls;
    const switched = click ? (control.dispatchEvent(new Event('click')), { prevented: true }) : modifiedEnter();
    await tick();
    currentChatId = 'chat-b';
    doc.textarea.value = 'Unfinished draft owned by chat B';
    resolveSettings({
      ok: true,
      status: 200,
      json: async () => ({ schema_version: 1, enabled, immediate_send: false, prompt: 'Prompt', revision: 'deferred' }),
    });
    await drain();
    if (!switched.prevented || sendClicks !== clicks || quietCalls !== quiet) {
      throw new Error(`unknown-settings Enter used chat B after switching while enabled=${enabled}`);
    }
    if (doc.textarea.value !== 'Unfinished draft owned by chat B' || doc.textarea.disabled) {
      throw new Error('a deferred settings response changed chat B’s composer');
    }
  };
  await switchChatDuringUnknownEnter(false);
  await switchChatDuringUnknownEnter(true);
  await switchChatDuringUnknownEnter(true, true);
  currentChatId = 'chat';
  extensionEnabled = true;
  await runtime.refresh();
  ok('deferred settings cannot send or polish a different chat draft');
  // Exercise the listener with an actual event: a MouseEvent must never become the optional
  // saved gesture passed by the Enter path.
  doc.textarea.value = 'Polish this button-click draft';
  const beforeClick = quietCalls;
  control.dispatchEvent(new Event('click'));
  await drain();
  if (quietCalls !== beforeClick + 1) throw new Error('the green button click did not start polishing');
  resolveQuietResult(/_BEGIN>>>\n([\s\S]*?)\n<<<VOCALIS_TEXT_/.exec(lastQuietPrompt)[1]);
  await drain();
  if (doc.textarea.disabled || doc.textarea.value !== 'Polish this button-click draft') {
    throw new Error('the green button click did not complete cleanly');
  }
  ok('the green button event starts and completes polishing');
  console.log('st_polish_send_spec: ok');
} finally {
  await rm(root, { recursive: true, force: true });
  if ((await import('node:fs')).existsSync(root)) throw new Error(`owned temp root survived: ${root}`);
}
