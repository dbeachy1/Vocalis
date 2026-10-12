/**
 * The settings doors: read the knobs, change them, and save or apply a named preset.
 *
 * 🔴 **THE SAME LOCK POLICY AS `/memory`, AND FOR THE SAME REASON.** Settings live inside the encrypted
 * store, so a locked vault cannot answer and must say so with a 409 rather than inventing the defaults — a
 * panel that showed built-in values to a user whose real settings are merely unreadable would invite them to
 * "fix" it by saving, which would then overwrite what they had.
 *
 * ⚠️ Every route here is behind the fork's `requireLoginMiddleware`, so `storeForRequest` resolves the
 * caller's own store and a preset name can never address anybody else's.
 */

import { DEFAULT_EXTRACTION_TEMPLATE, TEMPLATE_PLACEHOLDERS } from '../ingest/extraction.js';
import {
    DEFAULT_PRESET_NAME,
    SETTINGS_SCHEMA,
    deletePreset,
    isDefaultPreset,
    readPresets,
    readSettings,
    savePreset,
    writeSettings,
    readPromptTemplate,
    writePromptTemplate,
} from '../settings.js';

import { normal, sensitive } from '../logging.js';
import { renderView, sendFragment } from './panel.js';
import { storeForRequest, wantsFragment } from './request.js';

/**
 * Refuse a preset save with a 400, and say why in the log — the fork's panel shows only "400 Bad Request" and
 * drops the body, so without this line the reason exists nowhere a user can find it.
 *
 * @param {import('express').Response} res
 * @param {string} reason Content-free; the name itself goes to the sensitive channel only
 * @param {string} error The body sent back
 * @param {string} name
 * @returns {void}
 */
function refusePreset(res, reason, error, name) {
    normal().warn('[Mnemosyne] preset save refused: %s.', reason);
    sensitive().debug('[Mnemosyne] That refused preset name was %s.', JSON.stringify(name));
    res.status(400).json({ error });
}

/**
 * Everything the settings view needs in one response: the current values, the schema that describes them
 * (labels, tooltips, ranges), and the saved presets.
 *
 * 🔴 **THE SCHEMA SHIPS WITH THE VALUES, DELIBERATELY.** The panel is server-rendered, so this is really for
 * anything else that wants to drive the plugin — and a client holding its own copy of the ranges is a second
 * authority on what is valid, which is how a UI ends up offering a value the server then clamps without
 * saying so.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
export function readSettingsRoute(req, res) {
    const store = storeForRequest(req, res);

    if (!store) {
        return;
    }

    // ⚠️ The stored template AND the built-in default, because they are different questions: `template` is
    // what is running, `defaultTemplate` is what "reset" goes back to and what an editor should start from.
    // Sending only the first would make an unedited user's editor open empty.
    res.status(200).json({
        settings: readSettings(store),
        schema: SETTINGS_SCHEMA,
        presets: readPresets(store).map(p => p.name),
        template: readPromptTemplate(store),
        defaultTemplate: DEFAULT_EXTRACTION_TEMPLATE,
        placeholders: TEMPLATE_PLACEHOLDERS,
    });
}

/**
 * Change some settings. The body is a PATCH — whatever fields it carries are folded over what is stored.
 *
 * ⚠️ **Answers with the settings as they NOW STAND, including any clamping.** A form that asked for
 * `maxLength: 99999` gets back the maximum, and the panel re-renders from the answer rather than from what it
 * sent. Otherwise the input keeps showing a number the server did not accept, which reads as the save having
 * failed.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
export function writeSettingsRoute(req, res) {
    const store = storeForRequest(req, res);

    if (!store) {
        return;
    }

    const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? /** @type {Record<string, unknown>} */ (req.body)
        : {};

    writeSettings(store, patch);

    // 🔴 ONLY WHEN THE FIELD IS ACTUALLY PRESENT. The numeric form and the prompt editor post to the same
    // route, and a numeric save that carried no `template` key must not be read as "clear the template".
    if ('template' in patch) {
        writePromptTemplate(store, patch.template);
    }

    if (wantsFragment(req)) {
        sendFragment(res, renderView(store, req, /** @type {string} */ (req.user?.profile?.handle)));
        return;
    }

    res.status(200).json({ settings: readSettings(store), template: readPromptTemplate(store) });
}

/**
 * Save the current settings under a name.
 *
 * Presets let operators keep model-specific extraction and memory settings together when switching backends.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
export function savePresetRoute(req, res) {
    const store = storeForRequest(req, res);

    if (!store) {
        return;
    }

    // 🔴 `presetName`, NOT `name` — AND THIS IS WHY SAVE-AS-PRESET NEVER WORKED FROM THE PANEL. The input was
    // `<input name="name">`, and the fork runs every panel fragment through DOMPurify, whose anti-clobbering
    // rule (SANITIZE_DOM) deletes any `name`/`id` whose value is a property of `document` or of a form —
    // and `HTMLFormElement.name` is one. The attribute vanished, `collectForm` skipped the unnamed input, the
    // body arrived with no name, and every save was a 400 "a preset needs a name". The route tests posted
    // `{ name }` straight at the handler and never passed through the sanitizer, so they could not see it.
    // Tests exercise this field through the same form-name sanitization as the panel.
    const name = typeof req.body?.presetName === 'string' ? req.body.presetName : '';

    if (name.trim() === '') {
        refusePreset(res, 'no name was sent', 'a preset needs a name', name);
        return;
    }

    // 🔴 A DOT SEGMENT SURVIVES `encodeURIComponent` AND IS THEN RESOLVED AWAY BY THE CLIENT. The panel builds
    // its Load and Delete actions as `/settings/presets/${encodeURIComponent(name)}/apply`, and `.` and `..`
    // encode to themselves — so the fork's client, which normalizes with `new URL(...).pathname` before it
    // checks the mount boundary, turns a preset named `..` into `/settings/apply`. No route matches, and the
    // user gets "That action could not be completed" on a preset they can see in the list and can never load or
    // remove. (It is not a traversal: `/` IS percent-encoded, so nothing escapes the plugin's own mount — the
    // fork's boundary check is intact. It is a preset that can only ever be created.)
    //
    // ⚠️ Refused at the door rather than escaped at the call site, because the name is also a `meta` key's
    // content and is rendered in three places; one rule at the only place a name is created is the version that
    // cannot be forgotten by the fourth renderer.
    // 🔴 THE RESERVED NAME, REFUSED WITH A REASON RATHER THAN SILENTLY IGNORED. `savePreset` already declines
    // it — that is where the rule lives — but a save that answers 200 and changes nothing is indistinguishable
    // from a save that worked, and the user would discover it only by loading `default` later and getting
    // something other than what they saved.
    if (isDefaultPreset(name)) {
        refusePreset(res, 'the name is the reserved built-in preset',
            `'${DEFAULT_PRESET_NAME}' is the built-in preset and cannot be overwritten — it is the `
                + 'known-good state to roll back to. Save yours under another name.', name);
        return;
    }

    if (name.trim() === '.' || name.trim() === '..') {
        refusePreset(res, 'the name is a dot path segment',
            'a preset cannot be named "." or ".." — those are path segments, and the name becomes part '
                + 'of the address used to load and delete it. Any other name is fine.', name);
        return;
    }

    // The CURRENT settings, not the body: "save this preset" means the state you are looking at. Letting the
    // body carry settings too would make it possible to save a preset that was never applied and never seen.
    const template = readPromptTemplate(store);
    const rows = savePreset(store, name, readSettings(store), template);

    normal().info('[Mnemosyne] preset saved (%s extraction prompt); %d presets stored.',
        template ? 'custom' : 'built-in', rows.length);
    sensitive().debug('[Mnemosyne] That preset was named %s.', JSON.stringify(name));

    if (wantsFragment(req)) {
        sendFragment(res, renderView(store, req, /** @type {string} */ (req.user?.profile?.handle)));
        return;
    }

    res.status(200).json({ presets: rows.map(p => p.name) });
}

/**
 * Apply a saved preset, making it the current settings.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
export function applyPresetRoute(req, res) {
    const store = storeForRequest(req, res);

    if (!store) {
        return;
    }

    const name = String(req.params?.name ?? '');
    const found = readPresets(store).find(p => p.name === name);

    if (!found) {
        // 404 rather than a silent no-op: the panel would otherwise re-render unchanged and look like the
        // click did nothing, which is indistinguishable from a preset whose values happened to match.
        res.status(404).json({ error: `no preset named '${name}'` });
        return;
    }

    writeSettings(store, found.settings);
    // 🔴 THE PROMPT MOVES WITH THE NUMBERS. A preset saved while running the built-in carries `''`, which
    // correctly CLEARS an override the user set afterward — loading a preset means "put me back in that
    // state", and leaving a stray override behind would give them a state that was never saved by anyone.
    writePromptTemplate(store, found.template);

    if (wantsFragment(req)) {
        sendFragment(res, renderView(store, req, /** @type {string} */ (req.user?.profile?.handle)));
        return;
    }

    res.status(200).json({ settings: readSettings(store), template: readPromptTemplate(store) });
}

/**
 * Delete a saved preset.
 *
 * ⚠️ Unknown names answer 200, not 404 — unlike apply. Deleting something that is already gone has the
 * outcome the caller asked for, and the list this button was rendered from may be one request stale.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
export function deletePresetRoute(req, res) {
    const store = storeForRequest(req, res);

    if (!store) {
        return;
    }

    // 🔴 The built-in is not deletable, and this says so rather than answering the usual cheerful 200. The
    // panel renders no Delete control for it, so reaching here means something other than the panel asked.
    if (isDefaultPreset(req.params?.name)) {
        res.status(400).json({
            error: `'${DEFAULT_PRESET_NAME}' is the built-in preset and cannot be deleted — it is the `
                + 'known-good state to roll back to.',
        });
        return;
    }

    const rows = deletePreset(store, String(req.params?.name ?? ''));

    if (wantsFragment(req)) {
        sendFragment(res, renderView(store, req, /** @type {string} */ (req.user?.profile?.handle)));
        return;
    }

    res.status(200).json({ presets: rows.map(p => p.name) });
}

/**
 * Clear the user's prompt override, putting them back on the shipped prompt.
 *
 * 🔴 **A ROUTE, BECAUSE THE BUTTON HAD NO WAY TO SAY "EMPTY".** "Reset to the built-in prompt" was a `PUT
 * /settings` carrying `key: 'template'` — but `data-panel-key` is the fork's KEYBOARD-SHORTCUT attribute
 * (`pageup`/`pagedown`/`escape` are the only values ever read) and is never sent with the request. So the body
 * held no `template` key at all, `writeSettingsRoute`'s `if ('template' in patch)` was false, and the button
 * did precisely nothing: the user got the confirmation dialog, confirmed, and kept their override.
 *
 * ⚠️ It cannot be fixed with `form:` either, which is the obvious alternative. The only form region on that
 * screen contains the prompt textarea itself, so submitting it would send the CURRENT text — the exact thing
 * being discarded. "Clear it" is its own verb and now has its own address.
 *
 * ⚠️ DELETE rather than PUT deliberately: it carries no body, so its parameters ride in the query, which is
 * also the one method on this screen that was never affected by the body/query bug in `viewState`.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {void}
 */
export function resetPromptRoute(req, res) {
    const store = storeForRequest(req, res);

    if (!store) {
        return;
    }

    // `''` is what "track the shipped prompt" is spelled as — see `writePromptTemplate` for why storing a
    // verbatim copy of the default instead would freeze this user on today's wording for ever.
    writePromptTemplate(store, '');

    if (wantsFragment(req)) {
        sendFragment(res, renderView(store, req, /** @type {string} */ (req.user?.profile?.handle)));
        return;
    }

    res.status(200).json({ template: readPromptTemplate(store) });
}
