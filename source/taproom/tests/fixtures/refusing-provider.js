import createKeyedProvider from './keyed-provider.js';

/**
 * ⛔ A PROVIDER THAT REFUSES THE CONFIGURATION IT WAS GIVEN.
 *
 * Registration succeeds; `init()` throws. That is the shape of a real provider's boot check — Vault's
 * `assertUsable()` runs first thing inside `init()` and throws on a SillyTavern configuration where
 * encryption would be a decoration: accounts disabled, authentication delegated to a proxy, or an enabled
 * account with an EMPTY password. The last one is the dangerous case, because SillyTavern auto-logs in a
 * lone passwordless user, so a vault keyed from that password would have a key that is a published
 * constant. Everything would look encrypted and open instantly for anyone who reached the box.
 *
 * 🔴 THE FORK'S HALF OF THAT CONTRACT IS THAT THE REFUSAL IS FATAL. A provider saying "I cannot serve this
 * configuration" is saying that booting anyway means booting over the top of the user's data — with the
 * provider absent, SillyTavern's boot-time maintenance would set about regenerating everything it could
 * not read. So the server must NOT come up, and it must say why.
 *
 * This fixture is the fork-side test of that. What a real provider chooses to refuse is its own business
 * and is tested in its own repository; the fork only guarantees that a refusal stops the boot.
 */

/** The refusal message. Deliberately shaped like a real one: a headline, then the specific problem. */
export const REFUSAL_MESSAGE = [
    'REFUSING TO START. This SillyTavern configuration cannot support encryption at rest, and coming up',
    'anyway would look encrypted while being trivially openable by anyone who reaches this machine.',
    '',
    '  * FIXTURE: an enabled account has NO PASSWORD.',
].join('\n');

/**
 * Build the refusing provider.
 * @returns {import('../../src/storage.js').StorageProvider} The provider
 */
export default function createRefusingProvider() {
    const base = createKeyedProvider();

    return {
        ...base,

        id: 'refusing-provider',

        /**
         * Refuse, the way a real precondition check refuses.
         * @throws {Error} Always
         * @returns {void}
         */
        init() {
            throw new Error(REFUSAL_MESSAGE);
        },
    };
}
