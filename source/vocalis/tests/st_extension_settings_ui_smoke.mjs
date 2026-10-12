// Focused source smoke checks for the Vocalis Extension Settings sub-tab.
// Run with: node tests/st_extension_settings_ui_smoke.mjs
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('src/webui/partials/panel-sillytavern.html', root), 'utf8');
const module = await readFile(new URL('src/webui/js/st/extension-settings.js', root), 'utf8');
const tabs = await readFile(new URL('src/webui/js/st/tabs.js', root), 'utf8');
const http = await readFile(new URL('src/webui/js/util/http.js', root), 'utf8');

let failed = 0;
const ok = (condition, message) => {
  if (condition) console.log(`  ok   ${message}`);
  else {
    console.error(`  FAIL ${message}`);
    failed++;
  }
};

const strip = html.slice(html.indexOf('id="stTabs"'), html.indexOf('class="stwrap"'));
ok(/data-sttab="extension-settings"[^>]*>Vocalis Extension Settings</.test(strip), 'the strip exposes the extension settings tab');
ok(/<div data-stpanel="extension-settings"/.test(html), 'the extension settings pane exists');
ok(/id="stExtensionEnabled"[^>]*type="checkbox"[^>]*checked/.test(html), 'the enable switch defaults on');
ok(/id="stExtensionImmediateSend"[^>]*type="checkbox"[^>]*checked/.test(html), 'the immediate-send switch defaults on');
ok(/Enable Polish Text and Send/.test(html), 'the feature title uses title capitalization');
ok(/<textarea[^>]*id="stExtensionPrompt"/.test(html), 'the pane has a multiline prompt editor');
ok(/id="stExtensionSave" disabled>Save</.test(html), 'save starts disabled until settings are changed');
ok(/id="stExtensionRestore"[^>]*disabled>Restore default prompt</.test(html), 'restore starts disabled with the requested label');
ok(/stExtensionSettingsLoad\(\)/.test(tabs) && /case 'extension-settings'/.test(tabs), 'the router loads settings on entry');
ok(/export async function stExtensionSettingsLoad/.test(module), 'the module exports its entry loader');
ok(/export function stExtensionSettingsDirty/.test(module), 'the module exports its dirty-state query');
ok(/jput\('\/settings\/sillytavern-extension', fields\)/.test(module), 'save uses the canonical settings route and editable schema');
ok(/jdel\('\/settings\/sillytavern-extension'\)/.test(module), 'restore uses the canonical reset route');
ok(/Unsaved changes/.test(module) && /stExtensionSettingsDirty\(\)/.test(module), 'dirty edits are preserved across a late load');
ok(/save\.disabled\s*=\s*!!busy\s*\|\|\s*!stExtensionSettingsDirty\(\)/.test(module), 'save is enabled only for unsaved changes');
ok(/restore\.disabled\s*=\s*!!busy\s*\|\|\s*!defaults\s*\|\|\s*snapshot\(\)\?\.prompt\s*===\s*defaults\.prompt/.test(module), 'restore is enabled only when the prompt differs from its canonical default');
ok(!/\bconfirm\s*\(/.test(module), 'restore uses the app modal instead of a native confirmation');
ok(/import\s*\{\s*CSRF\s*\}\s*from\s*['"]\.\/uistate\.js['"]/.test(http), 'mutating helpers import the page CSRF token');
ok(/method:\s*'PUT'[\s\S]*?'X-CSRF-Token':\s*CSRF/.test(http), 'PUT sends the CSRF token');
ok(/method:\s*'DELETE'[\s\S]*?'X-CSRF-Token':\s*CSRF/.test(http), 'DELETE sends the CSRF token');

if (failed) process.exit(1);
