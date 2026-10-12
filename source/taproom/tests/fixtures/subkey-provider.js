import crypto from 'node:crypto';

import createKeyedProvider from './keyed-provider.js';

/**
 * 🔑 A PROVIDER THAT OFFERS KEY DERIVATION — the other half of the `keyed-provider` pair.
 *
 * `keyed-provider` deliberately does NOT implement `deriveSubkey`, which makes it the fixture for the trap:
 * it reports `ownsUser: true`, so anything reading `ownsUser` as "can I get a key here?" concludes yes and
 * waits for ever. This one implements it, so the two together cover both sides of `hasSecureStorage()`.
 *
 * ⛔ The derivation here is a STAND-IN and is not the real thing. The fork's job is to forward the question
 * and return the answer; that is what these tests are for. What a real provider derives from, and how, is its
 * own business and lives in its own repository — which is the entire point of the seam.
 */

/** Not a real key. A fixed input so the test can assert the same label twice yields the same bytes. */
const IKM = Buffer.from('subkey-provider-test-ikm-not-a-secret', 'utf-8');

/**
 * Build the subkey provider.
 * @returns {import('../../src/storage.js').StorageProvider} The provider
 */
export default function createSubkeyProvider() {
    const base = createKeyedProvider();

    return {
        ...base,

        id: 'subkey-provider',

        /**
         * 🔒 NO KEY WHILE LOCKED. This is policy, and policy is the provider's — the fork must not be the
         * one deciding it. A locked user gets null, and the caller is expected to wait rather than give up.
         * @param {string} handle User handle
         * @param {string} info Domain-separation label, chosen by the caller
         * @param {number} length Bytes required
         * @returns {Buffer|null} Key material, or null while locked
         */
        deriveSubkey(handle, info, length) {
            if (!base.isReady(handle)) {
                return null;
            }

            // Salted by handle, separated by the caller's label. Two labels MUST NOT collide -- a provider
            // that ignored `info` would hand the same bytes to every caller, and the test says so.
            return Buffer.from(crypto.hkdfSync('sha256', IKM, Buffer.from(handle, 'utf-8'), info, length));
        },
    };
}
