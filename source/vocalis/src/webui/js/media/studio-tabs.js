import { UIS } from '../util/uistate.js';

const PANELS = new Set(['stems', 'speech']);

/** Show one retained Voice Studio panel and remember the selection.
 * @param {string} name */
export function switchStudioPanel(name) {
  const selected = PANELS.has(name) ? name : 'stems';
  try {
    UIS.setItem('vocalis-vstab', selected);
  } catch (e) {}
  document.querySelectorAll('#vsTabs [data-vstab]').forEach(button => {
    button.classList.toggle('active', /** @type {HTMLElement} */ (button).dataset.vstab === selected);
  });
  document.querySelectorAll('[data-vspanel]').forEach(panel => {
    const el = /** @type {HTMLElement} */ (panel);
    el.style.display = el.dataset.vspanel === selected ? '' : 'none';
  });
}

document.querySelector('#vsTabs')?.addEventListener('click', event => {
  const name = /** @type {HTMLElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest('[data-vstab]')
  )?.dataset.vstab;
  if (name) switchStudioPanel(name);
});

let saved = 'stems';
try {
  saved = UIS.getItem('vocalis-vstab') || 'stems';
} catch (e) {}
switchStudioPanel(saved);
