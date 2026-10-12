import crypto from 'node:crypto';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { decryptBuffer, encryptBuffer } from './crypto/content-cipher.js';
import * as session from './session.js';
import { unavailable } from './errors.js';
import { KEY_VALUE_STORE } from './own-stores.js';

/**
 * The node-persist seam — and the reason the character cards were sitting on the disk in the clear.
 *
 * ## What went wrong
 *
 * SillyTavern caches every parsed character card in a `node-persist` store under
 * `<DATA_ROOT>/<handle>/_cache/characters/`. node-persist does its own `fs.readFile`/`fs.writeFile` calls,
 * so **not one byte of it goes through the storage provider.** The funnel never sees it. Every guard in
 * `provider.js` was irrelevant to it.
 *
 * So while chats, character files and their filenames were all correctly ciphertext, this directory held a
 * verbatim copy of every card — name, description, personality, first message — as plain JSON, with the
 * plaintext character *filename* sitting in the key:
 *
 * ```json
 * {"key":"…/characters/default_Test_Character.png-1752…",
 *  "value":"{\"name\":\"Test Character\",\"description\":\"[Test Character's Personality= \"caring\"…"}
 * ```
 *
 * The end-to-end test did not catch it because it wrote a *chat* and never *listed characters*, so the
 * cache was empty and the grep came back clean. A test that never runs the code it is auditing does not
 * merely fail to find the bug — it agrees with it.
 *
 * ## The seam
 *
 * node-persist takes `parse` and `stringify` as first-class options, and they are the ONLY path to and from
 * its disk. Supply a pair and the store is encrypted completely, with no patching of the library. The fork
 * spreads whatever this returns into the store's constructor.
 *
 * Three constraints, all of them read out of node-persist's source rather than guessed:
 *
 * 🔴 **`stringify` MUST BE TOTAL. IT MUST NEVER THROW.** This is not a style preference — it is the
 * difference between a working server and a dead one. Inside node-persist's own `parse`:
 *
 * ```js
 * try { return this.options.parse(str); }
 * catch (e) { this.log('parse error: ', this.stringify(e), 'for:', str); return undefined; }
 * ```
 *
 * The argument to `log` is evaluated whether or not logging is on, so **`stringify` is called with an Error
 * object** on every decode failure. And that whole `catch` runs inside an `fs.readFile` **callback** — so a
 * throw escaping it is an uncaught exception with no promise to reject into, and **the process dies.**
 * (Found the way you would expect: by killing the server.)
 *
 * 🔴 **It must be a symmetric transform valid on an ARBITRARY value.** `copy()` is `parse(stringify(value))`
 * and runs on every `setItem`, against the raw value rather than the stored `{key, value, ttl}` envelope.
 *
 * 🔴 **The store reads and writes with `encoding: 'utf8'`,** so `stringify` must return a UTF-8-safe STRING.
 * Base64 — never a raw Buffer.
 *
 * ## When there is no key
 *
 * A locked vault cannot encrypt, and `stringify` is forbidden from throwing, so it cannot refuse either.
 * The one remaining option is the only safe one: write a sentinel that carries NO plaintext, and let the
 * entry come back as a hard decode failure later. It is a cache. A lost entry costs a re-parse of a PNG;
 * a leaked entry costs the developer his character cards.
 */

/**
 * Marks a blob as ours, so that anything else — plaintext JSON left over from a pre-encryption install, or
 * something an attacker wrote — is REFUSED rather than quietly accepted.
 */
const ENVELOPE = KEY_VALUE_STORE.envelope;

/**
 * What `stringify` returns when it cannot encrypt.
 *
 * It is not an error (it must not throw) and it is not plaintext (that is the entire bug being fixed). It
 * is an inert marker that `parse` will later refuse, turning the entry into a cache miss that gets rebuilt
 * from the character card. Nothing is lost, and nothing leaks.
 */
const UNAVAILABLE = `${KEY_VALUE_STORE.envelope}unavailable`;

/**
 * The options to hand node-persist, for one user's store.
 * @param {string} handle The user whose store this is
 * @returns {{parse: Function, stringify: Function, getDatumPath: Function}} node-persist options
 */
export function keyValueOptions(vault, handle) {
    return {
        // Resolved per call, NOT captured here: the store instance is created once and cached by
        // SillyTavern for the life of the process, but the vault it belongs to gets locked and unlocked.
        // A key captured at construction time would be a key that outlives the lock.
        stringify: (value) => stringify(vault, handle, value),
        parse: (text) => parse(vault, handle, text),

        // 🔴 THE FILENAME. Encrypting the CONTENTS and leaving the name alone is half a job.
        //
        // node-persist's own mapping is `path.join(dir, sha256(key))`, and the key here is a plaintext
        // path: `…/characters/Test Character.png-<mtime>`. sha256 takes no key, so anyone who can read the disk
        // can TEST A GUESS — hash a character name they suspect, with an mtime they can read straight off
        // the card, and see whether that file exists. Nothing is disclosed, but it is a working
        // confirmation oracle over character names, and it is the only keyless name left in the system.
        //
        // ⚠️ Not an option. `getDatumPath` is a method on node-persist's prototype, and its `setOptions()`
        // copies only keys it already knows about — anything else is silently dropped. The fork applies
        // this to the instance, which is why it is called with `this` bound to the store.
        getDatumPath: function (key) {
            return path.join(this.options.dir, fileNameFor(vault, handle, key));
        },
    };
}

/**
 * What to call the file holding one key/value entry.
 *
 * A KEYED hash — HMAC-SHA256 under `k_cache_names` — so it is deterministic (the store must be able to find
 * again what it wrote) but computable only by someone who already holds the DEK. To an attacker with the
 * disk it is 64 characters of hex that confirm nothing.
 *
 * 🔴 THROWS when the vault is shut, and that is correct: it cannot honestly name a file it has no key for.
 * The error carries `EUNAVAILABLE`, which SillyTavern's cache paths re-throw rather than treating as a miss
 * — because a "miss" would be repaired by re-parsing the card and writing it back out.
 * @param {string} handle The user whose store this is
 * @param {string} key The cache key — a plaintext path
 * @returns {string} The filename
 */
function fileNameFor(vault, handle, key) {
    const keys = session.cacheKeys(vault, handle);

    if (!keys) {
        // 🔴 THE SAME `StorageError` THE PROVIDER THROWS, AND IT USED NOT TO BE.
        //
        // This was a hand-rolled `Object.assign(new Error(…), { code: 'EUNAVAILABLE' })`, because
        // `StorageError` was private to `provider.js`. The code matched and nothing else did: no
        // `name: 'StorageError'`, no `.path`. `tests/provider.test.js` pins the full shape, so this object
        // would not have satisfied the contract the provider's own suite enforces — and a fork-side guard
        // written to that shape would have walked straight past it into one of the six
        // regenerate-on-unreadable-data paths, rebuilding a plaintext shadow of every card the user owns.
        throw unavailable(
            `The vault for '${handle}' is shut, so its key/value store cannot be addressed. The data is there.`,
        );
    }

    return crypto.createHmac('sha256', keys.kCacheNames).update(String(key), 'utf-8').digest('hex');
}

/**
 * Encrypt a value on its way to the disk.
 *
 * 🔴 TOTAL. NEVER THROWS. See the note above: node-persist calls this from inside an `fs.readFile` callback,
 * with an Error object, on any decode failure. A throw from here takes the whole server down.
 * @param {string} handle The user whose store this is
 * @param {any} value Anything at all — a datum, a character card, an Error
 * @returns {string} A UTF-8-safe string, and never plaintext
 */
function stringify(vault, handle, value) {
    try {
        const keys = session.cacheKeys(vault, handle);

        if (!keys) {
            return UNAVAILABLE;
        }

        const json = JSON.stringify(value);

        // JSON.stringify(undefined) is undefined, not a string. Encrypting that would throw, and throwing
        // is the one thing forbidden here.
        if (typeof json !== 'string') {
            return UNAVAILABLE;
        }

        return ENVELOPE + encryptBuffer(keys.kCache, Buffer.from(json, 'utf-8')).toString('base64');
    } catch {
        // Whatever just happened, the answer is the same: say nothing, in a way that cannot be mistaken for
        // data. Returning plaintext here would reintroduce the exact leak this file exists to close.
        return UNAVAILABLE;
    }
}

/**
 * Decrypt a value on its way off the disk.
 *
 * This one MAY throw, and should. node-persist catches it, and with `forgiveParseErrors: false` (which the
 * fork sets deliberately) the read then FAILS rather than reporting a cache miss — because a miss would be
 * repaired by re-parsing the card and writing it back out, and if the reason we could not read it was that
 * we had no key, that repair would rebuild a plaintext shadow of every card the user owns.
 * @param {string} handle The user whose store this is
 * @param {string} text What is on the disk
 * @returns {any} The value
 */
function parse(vault, handle, text) {
    if (typeof text !== 'string' || !text.startsWith(ENVELOPE)) {
        // Not ours. Refuse it -- do NOT fall back to JSON.parse. A fallback would silently accept the
        // plaintext entries this change exists to eliminate, and would go on accepting anything an attacker
        // dropped in the cache directory.
        throw new Error('This key/value entry is not a vault envelope. It must NOT be treated as a cache miss and regenerated.');
    }

    if (text === UNAVAILABLE) {
        throw new Error('This key/value entry was written while the vault was shut, so it holds nothing. It will be rebuilt.');
    }

    const keys = session.cacheKeys(vault, handle);

    if (!keys) {
        throw new Error(`The vault for '${handle}' is shut, so this key/value entry cannot be decoded. The data is there.`);
    }

    const sealed = Buffer.from(text.slice(ENVELOPE.length), 'base64');
    return JSON.parse(decryptBuffer(keys.kCache, sealed).toString('utf-8'));
}
