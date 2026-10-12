import process from 'node:process';

import { normal, sensitive } from './logging.js';

/**
 * THE PLUGIN'S OWN SETTINGS. Not SillyTavern's.
 *
 * 🔴 THIS USED TO BE `storageIdleLockMinutes` IN THE FORK'S config.yaml, AND THAT WAS THE BUG.
 *
 * "Lock the vault after thirty minutes of inactivity" is a security judgement. SillyTavern is not entitled
 * to make it and is not equipped to: it does not know what is being protected, or from whom, or what it
 * costs to be locked out. It knows only that nobody has clicked anything for a while. So the fork detects
 * idleness — which only it can do, because only it sees the HTTP requests — and asks the provider how long
 * is too long. The number lives here, with the key it protects.
 *
 * The fork's default, with no provider installed, is NO IDLE LOCK AT ALL. A stock SillyTavern does not grow
 * a security feature nobody asked for.
 *
 * ⚠️ Zero runtime dependencies, for ever. A config-file parser is a package, and a package in this process
 * is the threat model — it runs as the user, after unlock, holding the key. An environment variable needs
 * no parser and no library.
 */

/** How long a user may be idle before their vault is locked. 0 disables the idle lock entirely. */
const DEFAULT_IDLE_LOCK_MINUTES = 30;

/**
 * How long a user may be idle before we forget their key.
 *
 * The DEK exists in RAM and nowhere else, so an unlocked vault is only as safe as the machine holding it.
 * Almost nobody logs out — they close the tab and walk away — and `cookieSession` means the server never
 * learns that they did. Without an idle lock the honest lifetime of an open vault is "until the process
 * exits", which on a box that stays up for weeks is not a lock at all.
 *
 * Set `VAULT_IDLE_LOCK_MINUTES=0` to turn it off, or to a number of minutes to change it.
 * @returns {number} Milliseconds of inactivity before a vault is locked, or 0 for never
 */
export function idleLockMs() {
    const raw = process.env.VAULT_IDLE_LOCK_MINUTES;
    // 🔴 TRIM BEFORE THE EMPTY CHECK. Only the EXACT empty string was caught -- and a string of pure
    // whitespace converts to ZERO, not NaN. A lone space, a tab, or a newline is therefore finite and
    // non-negative, sails past the guard below, and 0 is documented above as "disables the idle lock
    // entirely". So a systemd `Environment=VAULT_IDLE_LOCK_MINUTES=` with a trailing space, or the same in
    // a .env file, turned the idle lock OFF -- silently, with no warning, on a box that stays up for weeks.
    const text = (raw ?? '').trim();
    const minutes = text === '' ? DEFAULT_IDLE_LOCK_MINUTES : Number(text);

    // A garbled value must not silently mean "no lock" — that would turn a typo into a disabled security
    // control, quietly, with everything still appearing to work. Fall back to the default and say so.
    if (!Number.isFinite(minutes) || minutes < 0) {
        // Split, and `raw` going SENSITIVE is not paranoia about an operator-set variable: the whole reason
        // we are here is that it did not parse, so whatever is in it is by definition not the number this
        // setting expects. An environment is where a pasted path or a mis-aimed secret ends up. The operator
        // does not need it echoed to learn they made a typo — the variable's NAME is the actionable half.
        normal().warn(`[vault] VAULT_IDLE_LOCK_MINUTES is not a number. Using ${DEFAULT_IDLE_LOCK_MINUTES} minutes. Enable logging.debugMode to see the value.`);
        sensitive().warn('[vault] VAULT_IDLE_LOCK_MINUTES was:', raw);
        return DEFAULT_IDLE_LOCK_MINUTES * 60 * 1000;
    }

    // ⚠️ AND A CEILING, because `setTimeout` betrays large values: anything over 2^31-1 ms overflows and
    // fires IMMEDIATELY. So a deliberate "lock after a very long time" flips to "lock instantly" -- the
    // opposite of what was asked for. The timer is the fork's, but this is the module that hands it the
    // number, so the bound belongs here. ~24 days.
    return Math.min(Math.floor(minutes * 60 * 1000), 2 ** 31 - 1);
}
