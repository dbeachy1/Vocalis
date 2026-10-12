// The browser half of the Session Unlock Key's redemption, shared by the /health poll in
// sys/model.js and the 401 path in util/http.js.
//
// 🔴 WHY THIS IS ITS OWN LEAF, AND WHY THERE IS ONE IN-FLIGHT PROMISE (2026-10-09, M1 on the AMD test host).
// ⏏ Free Vocalis VRAM restarts the server, which comes back LOCKED. The tab was meant to notice
// that on its next /health poll and POST the SUK back — but every other poller kept running, and
// the first one to land (`/comfyui/status`, a second after startup) got the locked-gate 401, and
// `jget` navigated to /login. The redemption never ran; the user was signed out by a button whose
// own dialog promises "The web UI stays up". So a locked 401 now redeems too — and the SUK is
// SINGLE-USE, so two redemptions racing would spend it twice and the loser would delete the fresh
// key the winner just stored. Every caller therefore shares the one promise below.
//
// Leaf on purpose: http.js and sys/model.js both import it, and model.js imports http.js.

/** @type {Promise<boolean> | null} */
let inflight = null;

/**
 * Redeem this tab's SUK to re-open a vault that a restart locked. Resolves true when the vault is
 * open again (the server minted a fresh SUK, now stored), false when there was no key, the server
 * rejected it (the key is dropped), or the server was unreachable mid-restart (the key is kept).
 * @returns {Promise<boolean>}
 */
export function redeemSuk() {
  if (inflight) return inflight;
  const suk = sessionStorage.getItem('vocalis-suk');
  if (!suk) return Promise.resolve(false);
  inflight = (async () => {
    try {
      const r = await fetch('/vault/unlock-suk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suk }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.suk) {
        sessionStorage.setItem('vocalis-suk', d.suk);
        return true;
      }
      // 401 = suk_rejected: the server restarted with a different keyfile, or the wrap was
      // revoked by a logout elsewhere. The key is dead and retrying it forever would just be
      // noise — drop it and let the next 401 from any real request send us to the login page.
      sessionStorage.removeItem('vocalis-suk');
      return false;
    } catch (e) {
      return false; // the server is mid-restart — /health will tell us again in a moment
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * For a 401 response: when it is the locked-vault 401 (`{"error": "locked"}`) and this tab holds a
 * SUK, redeem it. Resolves true when the vault is open again and the request is worth one retry.
 * A plain sign-in 401, or a failed redemption, resolves false.
 * @param {Response} r
 * @returns {Promise<boolean>}
 */
export async function reopenIfLocked(r) {
  if (!sessionStorage.getItem('vocalis-suk')) return false;
  const body = await r
    .clone()
    .json()
    .catch(() => ({}));
  if (body.error !== 'locked') return false;
  if (inflight) return inflight;
  // This request may have been refused just before another caller (the /health poll, or a
  // sibling 401) re-opened the vault. Ask before spending the key: /health answers while locked.
  try {
    const h = await (await fetch('/health')).json();
    if (h && h.locked === false) return true;
  } catch (e) {
    /* mid-restart — fall through and let the redemption decide */
  }
  return redeemSuk();
}
