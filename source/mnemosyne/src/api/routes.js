import { editMemory, readMemories, reembedMemories, removeMemory, resetMemories, restoreMemory, writeMemory } from './memories.js';
import { readPanel, readPanelCss, readSettingsFragment, readStatus } from './panel.js';
import { rescanRoute } from './rescan.js';
import { applyPresetRoute, deletePresetRoute, readSettingsRoute, resetPromptRoute, savePresetRoute, writeSettingsRoute } from './settings.js';

/**
 * Mount the complete 18-route surface at `/api/plugins/mnemosyne`; the route-count test keeps this inventory in sync.
 * The fork applies `setUserDataMiddleware` and `requireLoginMiddleware` before mounting it, so handlers address
 * only the authenticated caller's store. Memory routes require an unlocked vault; `/panel` and `/status` remain
 * available while locked so the host can render its UI. `/panel.css` does not read the store.
 */

/**
 * Mount every route on the plugin's router.
 *
 * @param {import('express').Router} router This plugin's router, mounted at /api/plugins/mnemosyne
 * @param {import('../host/context.js').HostContext} host The fork, as we are allowed to see it
 * @returns {void}
 */
export function mountRoutes(router, host) {
    // Manual ingest, listing, editing and deletion operate on the authenticated caller's unlocked store.
    // See writeMemory / readMemories / removeMemory.
    router.post('/memory', (req, res) => writeMemory(req, res, host));
    router.get('/memory', (req, res) => readMemories(req, res));
    router.put('/memory/:id', (req, res) => editMemory(req, res, host));
    router.delete('/memory/:id', (req, res) => removeMemory(req, res));

    // Restore changes which existing memory is active; keep it separate from PUT, which edits one memory.
    router.post('/memory/:id/restore', (req, res) => restoreMemory(req, res));

    // Re-embed the caller's records missing vectors for the current model; each POST handles one bounded batch.
    router.post('/memory/reembed', (req, res) => reembedMemories(req, res, host));

    // Reset is scoped to the authenticated caller's store and accepts no target-user parameter. Keep it POST
    // and enforce the confirmation phrase in the handler so direct callers meet the same precondition as the UI.
    router.post('/memory/reset', (req, res) => resetMemories(req, res));

    // Reprocess recent messages from the authenticated caller's open chat, storing only missing memories.
    router.post('/memory/rescan', (req, res) => rescanRoute(req, res, host));

    // The panel and status endpoints remain renderable while the vault is locked.
    router.get('/panel', (req, res) => readPanel(req, res, host));
    router.get('/status', (req, res) => readStatus(req, res));

    // Use a query-free registered path because the fork appends ambient parameters to every registered URL.
    // This shares the settings renderer with `/panel?view=settings` without merging those parameters.
    router.get('/panel/settings', (req, res) => readSettingsFragment(req, res, host));

    // Serve CSS from a registered endpoint; it does not read the store and is available while locked.
    router.get('/panel.css', (req, res) => readPanelCss(req, res));

    // Settings live in the encrypted store. PUT merges submitted fields because the fork's clients do not send PATCH.
    router.get('/settings', (req, res) => readSettingsRoute(req, res));
    router.put('/settings', (req, res) => writeSettingsRoute(req, res));

    // A separate DELETE endpoint clears the prompt override without resubmitting the settings form's textarea.
    router.delete('/settings/template', (req, res) => resetPromptRoute(req, res));

    // Presets are named entries in the authenticated caller's store.
    router.post('/settings/presets', (req, res) => savePresetRoute(req, res));
    router.post('/settings/presets/:name/apply', (req, res) => applyPresetRoute(req, res));
    router.delete('/settings/presets/:name', (req, res) => deletePresetRoute(req, res));
}
