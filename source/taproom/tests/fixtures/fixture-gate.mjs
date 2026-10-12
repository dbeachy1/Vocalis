/**
 * 🔴 WHY A FIXTURE PLUGIN HAS TO ASK PERMISSION BEFORE IT REGISTERS ANYTHING.
 *
 * `server-main.js` builds the plugins directory as `path.join(serverDirectory, 'plugins')` — no config value,
 * no environment override (§10.0). A test therefore cannot point a booting server at a scratch directory; every
 * plugin suite installs its shim into the repository's one real `plugins/` and removes it afterwards.
 *
 * Jest runs test FILES in parallel. So while suite A's server is booting, suite B's shim is sitting in that
 * same directory — and A's server loads it, B's fixture registers a prompt interceptor, and A's assertion about
 * what reached the backend fails against a prompt some other suite's plugin rewrote. It is not a flake: it is
 * two suites sharing one process-wide directory, and it gets likelier with every plugin suite added. Adding a
 * fourth turned it from latent into reliable.
 *
 * The gate: a booting suite names the fixtures it MEANT to load, and every other fixture that happens to be on
 * disk registers nothing. Inert, not absent — the loader still loads it, which is closer to what a real install
 * does anyway.
 *
 * ⚠️ AN UNSET VARIABLE MEANS "EVERYTHING", so a suite that has not been taught about this behaves exactly as it
 * did before. New plugin suites should set it.
 * @param {string} id The fixture's own `info.id`
 * @returns {boolean} Whether this fixture should register anything in this process
 */
export function fixtureIsEnabled(id) {
    const enabled = process.env.ST_FIXTURE_IDS;

    if (typeof enabled !== 'string' || enabled === '') {
        return true;
    }

    return enabled.split(',').map(one => one.trim()).includes(id);
}
