import createVaultProvider from './provider.js';
import { createVaultState } from './vault-state.js';

/**
 * Encryption at rest for SillyTavern.
 *
 * The fork's storage-provider loader imports this file and calls the default export. Everything else --
 * every key, every cipher, every byte of the crypto -- lives behind it, in this package, and nowhere in
 * SillyTavern itself.
 *
 * See README.md for the threat model, and `src/provider.js` for the interface.
 * @param {import('./vault-state.js').VaultState} [vault] State to use. Omitted means a fresh one, which
 * is what the fork's loader wants; a caller that needs to inspect the state passes its own.
 * @returns {any} The provider
 */
export default function createProvider(vault) {
    return createVaultProvider(vault ?? createVaultState());
}
