/**
 * The persistent storage marker in the main UI header.
 *
 * 🔴 EVERY WORD COMES FROM THE STORAGE PROVIDER, AND THERE IS NO FALLBACK.
 *
 * SillyTavern does not know whether a provider encrypts, compresses, or forwards the bytes somewhere else,
 * so it has nothing of its own to say about them. It asks the only component that knows and repeats the
 * answer verbatim. A provider that stays quiet gets no marker — not a stock sentence, because a stock
 * sentence would be the fork making the claim after all, one branch further down.
 *
 * The header asks `'storage.marker'`, which is a DIFFERENT situation from the login page's
 * `'storage.badge'`. The two places have very different amounts of room — a word here, a sentence there —
 * and a provider is entitled to answer one and not the other, or to answer them differently.
 *
 * ⚠️ FOUR OUTCOMES COLLAPSE TO "SHOW NOTHING", AND ALL FOUR ARE CORRECT: no provider installed, a provider
 * with nothing to say, a fork old enough not to have the endpoint, and a request that simply failed. The
 * marker is a claim about the server, and a claim that could not be verified must not be made. Nothing here
 * throws, and nothing here blocks the UI coming up.
 */

/**
 * 🔴 THIS MODULE STARTS ITSELF, AND IS LOADED BY ITS OWN `<script>` TAG RATHER THAN FROM `script.js`.
 *
 * The obvious home for the call was `firstLoadInit()`, next to the other `void`-ed startup calls. It was
 * there, and it did not run: `firstLoadInit()` is a long sequence of awaits — personas, slash commands,
 * scrapers, settings — and anything that stalls partway leaves every line below it unreached. Observed on a
 * real boot, where the app came up, the header rendered, and the marker never appeared because init was
 * still grinding away above it.
 *
 * That dependency is backwards. `void` protects the APP from a slow marker; nothing was protecting the
 * MARKER from a slow app. This thing needs precisely two facts — the header element exists, and the server
 * answered — and neither has anything to do with personas or scrapers. So it waits for the DOM and nothing
 * else.
 *
 * ⚠️ IT MUST STAY IDEMPOTENT. It is exported as well as self-starting, so a caller may still invoke it, and
 * running twice must simply draw the same thing again.
 */

/**
 * Ask the server what it does with user data, and draw the marker if it says anything.
 * @returns {Promise<void>}
 */
export async function initStorageIndicator() {
    try {
        const response = await fetch('/api/storage/status');

        if (!response.ok) {
            return;
        }

        const status = await response.json();

        if (status?.enabled !== true || !status?.marker) {
            return;
        }

        const text = document.getElementById('storageMarkerText');
        const marker = document.getElementById('storageMarker');

        if (!text || !marker) {
            return;
        }

        // `textContent`, never `innerHTML`: the provider's words are DATA. A storage provider is trusted
        // with every byte of user data, but that is not the same as being entitled to inject markup into
        // the page, and the distinction costs nothing to keep.
        text.textContent = String(status.marker);
        marker.style.display = '';
    } catch {
        // An install whose server does not answer this is not a reason to disturb somebody's session.
    }
}

// `document.readyState` is checked rather than assuming: this module is loaded with `type="module"`, which
// is deferred, so the DOM is normally already parsed by the time it runs — but a dynamic import from
// anywhere else would not carry that guarantee, and a missed event would mean a marker that never appears.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void initStorageIndicator(), { once: true });
} else {
    void initStorageIndicator();
}
