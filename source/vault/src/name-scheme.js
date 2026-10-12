/**
 * HOW ONE ACCOUNT'S FILENAMES ARE ENCODED -- a shared vocabulary, and nothing else.
 *
 * These two numbers are written into `.vault-keys.json` and read by five modules. They lived in
 * `crypto/name-cipher.js`, which meant `crypto/vault.js` had to import the FILENAME CIPHER in order to
 * record which scheme a new account uses -- the only upward import anywhere in `src/crypto/`, and a
 * layering inversion: the key hierarchy is the bottom of this design and the on-disk name grammar is near
 * the top.
 *
 * Nothing about the values needs the cipher. They are a discriminator, agreed between whoever writes the
 * keys file and whoever reads a name. Putting them where both can reach them costs nothing and lets every
 * arrow in `src/crypto/` point downwards again.
 *
 * ⚠️ FROZEN. They are persisted per account and never inferred -- guessing wrong about a live
 * account means serving ciphertext as plaintext to machinery that repairs files by rewriting them.
 */

/** Bare base64url names; the account is entirely ours. Every vault created before mixed mode. */
export const NAME_SCHEME_LEGACY = 1;

/** Marked names; unmarked entries in the same directory are plaintext files that predate us. */
export const NAME_SCHEME_MIXED = 2;
