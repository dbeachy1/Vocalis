import crypto from 'node:crypto';
import path from 'node:path';

/**
 * The vectra replacement — the one library that could not be wrapped, only replaced.
 *
 * ## Why it had to be rewritten rather than hooked
 *
 * vectra `require`s `node:fs` at module scope. Its constructor takes exactly one argument, a folder path.
 * There is no `options.fs`, no storage adapter, no serializer hook, no seam of any kind. It writes its own
 * `index.json` and reads it back itself, and nothing in SillyTavern can intercept that.
 *
 * ## And what it stores is the worst of the lot
 *
 * Not embeddings. **The verbatim source text.** SillyTavern calls:
 *
 * ```js
 * store.upsertItem({ vector, metadata: { hash: item.hash, text: item.text, index: item.index } })
 * ```
 *
 * `metadata.text` is the raw chunk — chat messages, World Info entries, Data Bank documents — and vectra
 * inlines all metadata straight into `index.json`, because SillyTavern calls `createIndex()` with no
 * arguments so nothing is ever written to a metadata sidecar.
 *
 * Encrypting `chats/` and leaving this alone would have been close to pointless: the entire conversation
 * would be sitting in `vectors/.../index.json` in cleartext, in a file the funnel never touched.
 *
 * ## What this is
 *
 * A drop-in for the ten methods SillyTavern actually uses, backed by the provider — so the index is one
 * ordinary encrypted file, with an encrypted name, like everything else. It is not a general vectra
 * replacement and does not pretend to be.
 *
 * 🔴 THE FILTER IS THE DANGEROUS PART. `listItemsByMetadata()` feeds `deleteItem()` — SillyTavern uses it to
 * decide which vectors to destroy. A filter that silently matched more than it should would delete the
 * wrong vectors; one that silently matched everything would empty the collection. So the supported subset
 * is exactly what SillyTavern asks for, and anything else THROWS rather than guessing.
 */

/** The one file per collection. vectra's own name, so a collection is recognisable on the disk. */
const INDEX_FILE = 'index.json';

/**
 * The Euclidean norm, precomputed per item exactly as vectra does, so queries are a dot product.
 * @param {number[]} vector The vector
 * @returns {number} Its norm
 */
function normOf(vector) {
    let sum = 0;

    for (const value of vector) {
        sum += value * value;
    }

    return Math.sqrt(sum);
}

/**
 * Cosine similarity, from vectors whose norms are already known.
 * @param {number[]} a First vector
 * @param {number} normA Its norm
 * @param {number[]} b Second vector
 * @param {number} normB Its norm
 * @returns {number} The similarity, -1..1
 */
function similarity(a, normA, b, normB) {
    if (!normA || !normB) {
        return 0;
    }

    let dot = 0;
    const length = Math.min(a.length, b.length);

    for (let i = 0; i < length; i++) {
        dot += a[i] * b[i];
    }

    return dot / (normA * normB);
}

/**
 * Does one item's metadata satisfy the filter?
 *
 * 🔴 A DELIBERATELY SMALL SUBSET, AND IT THROWS ON ANYTHING ELSE.
 *
 * SillyTavern uses exactly one form: `{ hash: { '$in': [...] } }`, to find the vectors belonging to a set of
 * message hashes so it can DELETE them. Every operator here is therefore load-bearing on data destruction,
 * and the failure mode of a helpful guess is that the wrong chat's vectors get deleted — or, if an
 * unrecognised operator quietly matched nothing, that deletions silently stopped working and the index grew
 * stale for ever.
 *
 * Neither is worth the convenience of pretending to support Mongo's query language. If SillyTavern starts
 * using an operator that is not here, this throws, loudly, on the first call — which is a bug report, not a
 * data loss.
 * @param {Record<string, any>} metadata The item's metadata
 * @param {Record<string, any>} filter The filter
 * @returns {boolean} True if it matches
 */
function matches(metadata, filter) {
    for (const [key, condition] of Object.entries(filter ?? {})) {
        const value = metadata?.[key];

        // A bare value means equality.
        if (condition === null || typeof condition !== 'object') {
            if (value !== condition) {
                return false;
            }

            continue;
        }

        for (const [operator, operand] of Object.entries(condition)) {
            switch (operator) {
            // 🔴 A NON-ARRAY OPERAND IS A CALLER BUG, AND `$nin` USED TO ANSWER IT IN THE DESTRUCTIVE
            // DIRECTION. `$in` had the guard (`!Array.isArray(operand)` → no match); `$nin` did not, so a
            // scalar where an array was meant fell straight through the `&&` to `break`, i.e. "this item
            // matches". `{ hash: { $nin: hashes[0] } }` therefore selected the ENTIRE COLLECTION, and this
            // function's one job is choosing what gets deleted -- the caller loops `deleteItem` over the
            // result and `endUpdate` writes the emptied index out atomically. Silent, total, no error.
            // `{ hash: {} }` had the same shape via a zero-iteration inner loop.
            //
            // Throwing rather than guessing either way is what the `default:` branch below already decides
            // for an unknown operator, for exactly this reason. The fork only ever passes an array to `$in`
            // and never uses `$nin`, so nothing legitimate is refused.
            case '$in':
            case '$nin':
                if (!Array.isArray(operand)) {
                    throw new Error(
                        `The encrypted vector index needs an array for '${operator}', not ` +
                            `${typeof operand}. Refusing to guess: this filter chooses which vectors are ` +
                            'DELETED, and treating a stray scalar as "matches everything" empties the ' +
                            'whole collection.',
                    );
                }

                if (operand.includes(value) !== (operator === '$in')) {
                    return false;
                }

                break;

            case '$eq':
                if (value !== operand) {
                    return false;
                }

                break;

            case '$ne':
                if (value === operand) {
                    return false;
                }

                break;

            default:
                // 🔴 DO NOT GUESS. This function decides what gets deleted.
                throw new Error(
                    `The encrypted vector index does not support the metadata operator '${operator}'. ` +
                        'Refusing to guess what it means: this filter chooses which vectors are DELETED, and a ' +
                        'wrong guess destroys the wrong data. Implement it in src/vector-index.js.',
                );
            }
        }
    }

    return true;
}

/**
 * A vectra-compatible index, stored as a single encrypted file through the provider.
 */
class EncryptedVectorIndex {
    /**
     * @param {any} provider The storage provider — every byte goes through it
     * @param {string} folderPath The LOGICAL folder for this collection
     */
    constructor(provider, folderPath) {
        this.provider = provider;

        // SillyTavern reads `.folderPath` when it reports a corrupted index. Keep it.
        this.folderPath = folderPath;
        this.indexPath = path.join(folderPath, INDEX_FILE);

        /** @type {{items: any[]}|null} The staged copy, between beginUpdate() and endUpdate(). */
        this.pending = null;
    }

    /**
     * Read the index off the disk, through the provider.
     * @returns {{version: number, items: any[]}} The index
     */
    read() {
        if (!this.provider.exists(this.indexPath)) {
            return { version: 1, items: [] };
        }

        // 🔴 A decrypt failure throws EPROVIDER out of here, and it MUST propagate. SillyTavern's
        // regenerateCorruptedIndexErrorHandler responds to a corrupt index by calling deleteIndex() -- the
        // whole vector store, gone. It is guarded on `instanceof SyntaxError`, and EPROVIDER is not one, so
        // "unreadable" never gets mistaken for "corrupt". Do not catch this and return an empty index: that
        // would silently rebuild the collection and throw away the real one.
        const raw = this.provider.readFileSync(this.indexPath, 'utf-8');
        const parsed = JSON.parse(raw);

        return { version: parsed.version ?? 1, items: parsed.items ?? [] };
    }

    /**
     * Write the index back, through the provider.
     * @param {{items: any[]}} index The index
     * @returns {void}
     */
    write(index) {
        this.provider.mkdir(this.folderPath, { recursive: true });
        // ⚠️ ROUND-TRIP THE VERSION rather than stamping 1. `read()` recovers whatever the file claimed, and
        // hardcoding the write silently RELABELS a version-2 index as version 1 -- so a newer build that
        // wrote it, and a future migration that keys off the field, both lose the only marker saying what
        // shape the items are actually in. Defaulted here, not assumed.
        this.provider.writeFileSync(this.indexPath, JSON.stringify({ version: index.version ?? 1, items: index.items }), 'utf-8');
    }

    /** @returns {Promise<boolean>} True if this collection exists */
    async isIndexCreated() {
        return this.provider.exists(this.indexPath);
    }

    /** @returns {Promise<void>} */
    async createIndex() {
        this.write({ items: [] });
    }

    /** @returns {Promise<void>} */
    async deleteIndex() {
        this.provider.rm(this.folderPath, { recursive: true, force: true });
    }

    /** @returns {Promise<void>} */
    async beginUpdate() {
        this.pending = this.read();
    }

    /** @returns {Promise<void>} */
    async endUpdate() {
        if (!this.pending) {
            throw new Error('endUpdate() without beginUpdate().');
        }

        // 🔴 CLEAR THE TRANSACTION EVEN IF THE WRITE FAILS. `this.pending = null` used to sit AFTER the
        // write, so a throw -- a locked vault, ENOSPC, EPROVIDER -- left the failed snapshot in place. The
        // next `upsertItem` on this instance then appended to a transaction that had already failed once,
        // and the following `endUpdate` wrote the whole stale set back out as if nothing had happened.
        try {
            this.write(this.pending);
        } finally {
            this.pending = null;
        }
    }

    /** @returns {Promise<void>} Abandon a staged update */
    async cancelUpdate() {
        this.pending = null;
    }

    /**
     * Insert or replace an item.
     * @param {{id?: string, vector: number[], metadata: object}} item The item
     * @returns {Promise<object>} The stored item, with its id
     */
    async upsertItem(item) {
        if (!this.pending) {
            throw new Error('upsertItem() must be called between beginUpdate() and endUpdate().');
        }

        const stored = {
            id: item.id ?? crypto.randomUUID(),
            vector: item.vector ?? [],
            norm: normOf(item.vector ?? []),
            metadata: item.metadata ?? {},
        };

        const existing = this.pending.items.findIndex(candidate => candidate.id === stored.id);

        if (existing >= 0) {
            this.pending.items[existing] = stored;
        } else {
            this.pending.items.push(stored);
        }

        return stored;
    }

    /**
     * Delete an item by id.
     * @param {string} id The item id
     * @returns {Promise<void>}
     */
    async deleteItem(id) {
        if (!this.pending) {
            throw new Error('deleteItem() must be called between beginUpdate() and endUpdate().');
        }

        this.pending.items = this.pending.items.filter(item => item.id !== id);
    }

    /** @returns {Promise<object[]>} Every item */
    async listItems() {
        return (this.pending ?? this.read()).items;
    }

    /**
     * Every item whose metadata matches.
     * @param {Record<string, any>} filter The filter
     * @returns {Promise<object[]>} The matching items
     */
    async listItemsByMetadata(filter) {
        return (this.pending ?? this.read()).items.filter(item => matches(item.metadata, filter));
    }

    /**
     * The `topK` items closest to a vector.
     * @param {number[]} vector The query vector
     * @param {number} topK How many to return
     * @param {Record<string, any>} [filter] An optional metadata filter
     * @returns {Promise<{item: object, score: number}[]>} The results, best first
     */
    async queryItems(vector, topK, filter) {
        const norm = normOf(vector);
        const candidates = filter
            ? (this.pending ?? this.read()).items.filter(item => matches(item.metadata, filter))
            : (this.pending ?? this.read()).items;

        return candidates
            .map(item => ({ item, score: similarity(vector, norm, item.vector, item.norm ?? normOf(item.vector)) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    /** @returns {Promise<{items: number, version: number}>} Index statistics */
    async getIndexStats() {
        const index = this.pending ?? this.read();
        return { items: index.items.length, version: index.version ?? 1 };
    }
}

/**
 * Build a vector index for a collection.
 * @param {any} provider The storage provider
 * @param {string} folderPath The LOGICAL folder for the collection
 * @returns {any} A vectra-compatible index
 */
export default function createVectorIndex(provider, folderPath) {
    return new EncryptedVectorIndex(provider, folderPath);
}
