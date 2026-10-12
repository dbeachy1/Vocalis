// st/extension-settings.js — Vocalis's server-owned Polish Text and Send settings.
//
// This pane deliberately keeps only an in-memory snapshot. The prompt is not copied into
// SillyTavern's extension settings or localStorage; Vocalis remains the source of truth.
// Loading on every entry is safe because a dirty editor is never repainted over.

import { $ } from '../util/dom.js';
import { errText, jdel, jget, jput } from '../util/http.js';
import { modal } from '../ui/modal.js';

/** The three client-authored fields accepted by the settings PUT route. */
/** @typedef {{enabled: boolean, immediate_send: boolean, prompt: string}} StExtensionFields */

/** The canonical editor response returned by all three settings routes. */
/** @typedef {StExtensionFields & {schema_version: number, revision: string, defaults: StExtensionFields}} StExtensionSettings */

/** @returns {{enabled: HTMLInputElement, immediate: HTMLInputElement, prompt: HTMLTextAreaElement}|null} */
function controls() {
  const enabled = /** @type {HTMLInputElement|null} */ ($('stExtensionEnabled'));
  const immediate = /** @type {HTMLInputElement|null} */ ($('stExtensionImmediateSend'));
  const prompt = /** @type {HTMLTextAreaElement|null} */ ($('stExtensionPrompt'));
  return enabled && immediate && prompt ? { enabled, immediate, prompt } : null;
}

/** @returns {StExtensionFields|null} */
function snapshot() {
  const c = controls();
  return c ? { enabled: c.enabled.checked, immediate_send: c.immediate.checked, prompt: c.prompt.value } : null;
}

/** @param {StExtensionFields|null} a @param {StExtensionFields|null} b @returns {boolean} */
function sameFields(a, b) {
  return !!a && !!b && a.enabled === b.enabled && a.immediate_send === b.immediate_send && a.prompt === b.prompt;
}

/** @type {StExtensionFields|null} */
let loaded = null;
/** @type {StExtensionFields|null} */
let baseline = snapshot();
/** @type {StExtensionFields|null} */
let defaults = null;
/** @type {Promise<StExtensionSettings|null>|null} */
let loadPromise = null;
/** @type {'load'|'save'|'restore'|null} */
let busy = null;
let operation = 0;
let restorePending = false;

/** @param {string} message @param {'neutral'|'success'|'error'} [kind] */
function status(message, kind = 'neutral') {
  const el = /** @type {HTMLElement|null} */ ($('stExtensionSettingsStatus'));
  if (!el) return;
  el.textContent = message;
  el.dataset.state = kind;
  el.style.color = kind === 'error' ? 'var(--err)' : kind === 'success' ? 'var(--ok)' : 'var(--mut)';
}

/** @param {StExtensionSettings} settings */
function paint(settings) {
  const c = controls();
  if (!c) return;
  c.enabled.checked = settings.enabled;
  c.immediate.checked = settings.immediate_send;
  c.prompt.value = settings.prompt;
  loaded = { enabled: settings.enabled, immediate_send: settings.immediate_send, prompt: settings.prompt };
  baseline = { ...loaded };
  defaults = { ...settings.defaults };
  const rev = /** @type {HTMLElement|null} */ ($('stExtensionSettingsRevision'));
  if (rev) rev.textContent = settings.revision ? `revision ${settings.revision.slice(0, 12)}` : '';
}

/** @param {unknown} value @returns {StExtensionSettings} */
function canonical(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid extension settings response');
  const s = /** @type {Partial<StExtensionSettings>} */ (value);
  if (
    s.schema_version !== 1 ||
    typeof s.enabled !== 'boolean' ||
    typeof s.immediate_send !== 'boolean' ||
    typeof s.prompt !== 'string' ||
    !s.prompt.trim() ||
    typeof s.revision !== 'string' ||
    !s.defaults ||
    typeof s.defaults.enabled !== 'boolean' ||
    typeof s.defaults.immediate_send !== 'boolean' ||
    typeof s.defaults.prompt !== 'string' ||
    !s.defaults.prompt.trim()
  )
    throw new Error('invalid extension settings response');
  return /** @type {StExtensionSettings} */ (s);
}

/** @param {unknown} error @param {string} action */
function failure(error, action) {
  const statusCode = /** @type {ErrLike} */ (error).status;
  if (statusCode === 423) return `Vocalis is locked — unlock it to ${action} extension settings.`;
  if (statusCode === 401) return `You are not authorized to ${action} extension settings.`;
  if (statusCode === 403) return errText(error);
  return `${action[0].toUpperCase() + action.slice(1)} extension settings failed: ${errText(error)}`;
}

/** @param {'load'|'save'|'restore'|null} next */
function setBusy(next) {
  busy = next;
  updateActions();
  const c = controls();
  if (c) {
    c.enabled.disabled = next === 'save' || next === 'restore';
    c.immediate.disabled = next === 'save' || next === 'restore';
    c.prompt.disabled = next === 'save' || next === 'restore';
  }
}

/** Keep mutations unavailable unless they would change the server-owned state. */
function updateActions() {
  const save = /** @type {HTMLButtonElement|null} */ ($('stExtensionSave'));
  const restore = /** @type {HTMLButtonElement|null} */ ($('stExtensionRestore'));
  if (save) save.disabled = !!busy || !stExtensionSettingsDirty();
  if (restore) restore.disabled = !!busy || !defaults || snapshot()?.prompt === defaults.prompt;
}

/** Whether typing would be lost if the pane were reloaded. */
export function stExtensionSettingsDirty() {
  return !sameFields(snapshot(), loaded || baseline);
}

/** Load canonical settings when entering the sub-tab, preserving unsaved edits. */
export async function stExtensionSettingsLoad() {
  if (!controls()) return null;
  if (stExtensionSettingsDirty()) {
    status('Unsaved changes — press Save to apply them.');
    return null;
  }
  if (loadPromise) return loadPromise;
  const id = ++operation;
  setBusy('load');
  status('Loading…');
  loadPromise = (async () => {
    try {
      const settings = canonical(await jget('/settings/sillytavern-extension'));
      // A caller may have edited the form while the request was in flight (including a test or
      // assistive-technology event), so a late response must not erase that work.
      if (id !== operation || stExtensionSettingsDirty()) {
        status('Unsaved changes — press Save to apply them.');
        return null;
      }
      paint(settings);
      status('Loaded.', 'success');
      return settings;
    } catch (error) {
      if (id === operation) status(failure(error, 'load'), 'error');
      return null;
    } finally {
      if (id === operation) {
        setBusy(null);
        loadPromise = null;
      }
    }
  })();
  return loadPromise;
}

async function save() {
  if (busy || !stExtensionSettingsDirty()) return;
  const fields = snapshot();
  if (!fields) return;
  if (!fields.prompt.trim()) {
    status('The polishing prompt cannot be empty.', 'error');
    return;
  }
  const id = ++operation;
  setBusy('save');
  status('Saving…');
  try {
    // Do not send schema_version or revision back: both are server-owned fields.
    const settings = canonical(await jput('/settings/sillytavern-extension', fields));
    if (id !== operation) return;
    paint(settings);
    status('Saved.', 'success');
  } catch (error) {
    if (id === operation) status(failure(error, 'save'), 'error');
  } finally {
    if (id === operation) setBusy(null);
  }
}

async function restore() {
  if (busy || restorePending || !defaults || snapshot()?.prompt === defaults.prompt) return;
  restorePending = true;
  try {
    const confirmed = await modal(
      'Restore default prompt?',
      '<p>This replaces your current polishing prompt and switches both options back to their defaults.</p>' +
        '<p class="small muted">Your current settings will no longer be in effect after the reset.</p>',
      [
        { label: 'Cancel', value: false },
        { label: 'Restore default prompt', class: 'danger', value: true },
      ],
    );
    if (!confirmed) return;
    const id = ++operation;
    setBusy('restore');
    status('Restoring…');
    try {
      const settings = canonical(await jdel('/settings/sillytavern-extension'));
      if (id !== operation) return;
      paint(settings);
      status('Default prompt restored.', 'success');
    } catch (error) {
      if (id === operation) status(failure(error, 'restore'), 'error');
    } finally {
      if (id === operation) setBusy(null);
    }
  } finally {
    restorePending = false;
  }
}

const c = controls();
if (c) {
  [c.enabled, c.immediate, c.prompt].forEach(el =>
    el.addEventListener('input', () => {
      if (!busy) {
        updateActions();
        status(stExtensionSettingsDirty() ? 'Unsaved changes — press Save to apply them.' : '');
      }
    }),
  );
  c.enabled.addEventListener('change', () => {
    if (!busy) {
      updateActions();
      status(stExtensionSettingsDirty() ? 'Unsaved changes — press Save to apply them.' : '');
    }
  });
  const saveButton = /** @type {HTMLButtonElement|null} */ ($('stExtensionSave'));
  const restoreButton = /** @type {HTMLButtonElement|null} */ ($('stExtensionRestore'));
  if (saveButton) saveButton.addEventListener('click', save);
  if (restoreButton) restoreButton.addEventListener('click', restore);
  updateActions();
}
