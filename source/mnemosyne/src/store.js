import fs from 'node:fs';
import { createRequire } from 'node:module';

import {
    BASE_DDL, MEMORY_COLUMNS, SCHEMA_VERSION, TIER_SCENARIO,
    hydrate, scopeKey, vectorTableDdl, vectorTableName,
} from './schema.js';
import * as versions from './versions.js';

/**
 * 🔴 Loaded through createRequire, not `import`. Both packages are native CommonJS, and sqlite-vec's ESM
 * entry locates its binary with `import.meta.resolve` — which real Node 24 has and Jest's
 * --experimental-vm-modules does not. Importing it works in production and dies under test with
 * "(intermediate value).resolve is not a function". The CJS entry uses require.resolve and behaves
 * identically in both, so the tests exercise the same loader the plugin uses. Do not "modernize" this.
 */
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3-multiple-ciphers');
const sqliteVec = require('sqlite-vec');

/** @typedef {import('./schema.js').MemoryMetadata} MemoryMetadata */
/** @typedef {import('./schema.js').MemoryRow} MemoryRow */
/** @typedef {import('./schema.js').SearchHit} SearchHit */
/** @typedef {import('./schema.js').LexicalHit} LexicalHit */
/** @typedef {import('./schema.js').StoredMemoryRow} StoredMemoryRow */

/**
 * The `meta` key recording that this store's lexical index has been populated from `memories`.
 *
 * A one-time backfill marker, not a schema version: the FTS5 table is derived data, so a store that predates
 * it is upgraded in place rather than refused. See the guard in `#migrate` for why the flag exists instead of
 * counting rows in the index.
 */
const LEXICAL_INDEX_BUILT = 'lexical_index_built';

/**
 * How many live memories a partition needs before {@link MemoryStore#informativeTerms} will drop anything.
 *
 * 🔴 "Appears in half the rows" is a claim about a distribution, and a handful of memories has none. Below
 * this the rule would delete terms that are perfectly discriminating — in a two-row store, a term matching one
 * row is in half of it — and the fts5 IDF clamp it defends against has nothing to displace at that size
 * anyway. Ten is the point where "half" starts meaning something and is deliberately not tuned finer.
 */
const DF_MIN_CORPUS = 10;

/**
 * An open better-sqlite3 connection — the driver's own declaration, not a local sketch of it.
 *
 * 🔴 **`.get()` returns `unknown` and `.all()` returns `unknown[]`, and that is the whole value of naming
 * this type.** A connection typed `any` would make every `db.prepare(...)` in this file and in `versions.js`
 * unchecked, so a few hundred annotations downstream of it would type-check by being about nothing. Typed,
 * SQLite hands back what it actually hands back: a value nobody has proved anything about. Every reader
 * therefore states its expectation with a cast written *beside the SELECT the cast is a claim about*, which
 * is the only place a human can check it — no checker reads a SQL string. Move one apart from the other and
 * the drift becomes invisible again.
 *
 * ⚠️ The package is loaded through `createRequire` (above) for a runtime reason, and that does not cost the
 * declarations: TypeScript resolves `import(...)` here against the same `index.d.ts` either way, while Node
 * still loads the CommonJS entry the tests need.
 *
 * @typedef {import('better-sqlite3-multiple-ciphers').Database} SqliteDatabase
 */

/**
 * One prepared statement off that connection, with the same `unknown` result as the note above.
 *
 * @typedef {import('better-sqlite3-multiple-ciphers').Statement} SqliteStatement
 */

/**
 * One row of `embedding_models`: a model that has embedded something here, and the id that names its vector
 * table. 🔴 `id` is the table name (see {@link vectorTableName}), which is why the row is never rewritten.
 *
 * @typedef {object} EmbeddingModelRow
 * @property {number} id
 * @property {string} model The model identifier, e.g. `Xenova/all-mpnet-base-v2`.
 * @property {number} dimension Fixed at registration; see {@link MemoryStore.registerModel} for why.
 */

/**
 * A hit as the JOIN in {@link MemoryStore.search} hands it back, before `metadata` has been parsed — the
 * search-side counterpart to `StoredMemoryRow`. Derived from {@link SearchHit} rather than restated, so the
 * query's column list and the type a caller sees cannot drift apart in one direction only.
 *
 * @typedef {Omit<SearchHit, 'metadata'> & { metadata: string|null }} StoredSearchHit
 */

/**
 * An identity column's stored value: the string, or `''` when there is none.
 *
 * 🔴 `''` and never NULL, and the reason survives from v3 unchanged. `IS NULL` against a vec0 partition key
 * does filter correctly; what does not work is `scope = ?` bound to null, which is ordinary SQL three-valued
 * logic rather than anything to do with vec0. The sentinel exists so there is exactly ONE query shape instead
 * of a branch that swaps in `IS NULL`, and so identity is total: every memory has all four axes, always, even
 * when the answer on an axis is "none".
 *
 * @param {string|null} value One identity axis as the caller supplied it
 * @returns {string} the value, or the `''` sentinel
 */
function str(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * The encrypted memory store — one SQLCipher database per user.
 *
 * ## What this owns, and what it refuses to own
 *
 * It owns the file: the schema, the vectors, the text, and the search. It does **not** own the key, does not
 * derive one, and contains no cryptography of its own. A caller hands it 32 bytes; where those came from is
 * emphatically not this module's business. That keeps the whole of Mnemosyne's crypto surface at zero — the
 * key hierarchy lives in the vault, which is the one place that has earned the right to it.
 *
 * ## 🔴 The key is a parameter, never a field
 *
 * This class does not store the key, and `open()` takes it fresh every time. That is deliberate and it is
 * the shape the vault requires: the key must not be resident when the user's storage is locked, and a class
 * holding one in a field would keep it alive for exactly as long as the object lived — which, for a
 * long-lived plugin, is for ever.
 *
 * The corollary for callers, borrowed verbatim from the fork's own warning: **ask late, not at module
 * scope.** At plugin init nobody has logged in and there is no key. Ask when you need it, every time.
 */
export class MemoryStore {
    /**
     * @param {string} file Path to the SQLCipher database
     */
    constructor(file) {
        this.file = file;
        /**
         * The live connection, or null between {@link close} and the next {@link open}.
         *
         * 🔴 **Nullable, and the null is the resting state rather than an edge case.** A locked vault is the
         * normal condition of this object — see the class docblock on why no key and no connection may
         * outlive a lock. Every public method proves the connection exists by calling {@link #assertOpen},
         * whose assertion signature is what carries that proof to the reader and the checker alike.
         *
         * @type {SqliteDatabase|null}
         */
        this.db = null;
    }

    /**
     * Open the database with a raw key, creating and migrating it if needed.
     *
     * ## ⚠️ ACCEPTED GAP: THE KEY SURVIVES `close()` AS AN UNZEROABLE STRING
     *
     * NFR1 says the key must not be resident once the vault locks, and the Buffer half of that is kept:
     * `session.js` zeroes its Buffer in a `finally`, and this class holds the key in no field, so `close()`
     * drops SQLCipher's page cache and there is nothing left to clear. That much is true and is why the lock
     * path is `close()` and nothing more.
     *
     * **What is NOT true is that the key is then gone from the process.** The `PRAGMA key` below builds
     * `key.toString('hex')` and interpolates it into a template literal — two immutable V8 strings holding
     * the full key in hex, plus SQLite's own copy of the statement text taken by `sqlite3_prepare`. None of
     * them can be overwritten, none is released by `close()`, and V8 does not wipe freed heap. So a core
     * dump, a `--heapsnapshot-signal`, or a swapped page captured **after** the user logged out can still
     * yield the key in the clear.
     *
     * 🔴 **This is a dependency limitation, not a slip that can be tidied here.**
     * `better-sqlite3-multiple-ciphers` exposes no binary key API: `PRAGMA key`, `PRAGMA hexkey` and the URI
     * `hexkey=` form all take a string, so there is no way to hand it the bytes without materializing one.
     * Do not "fix" this with a scrub of the local variable — the strings are interned beyond our reach, and a
     * mitigation that looks like it works is worse than a gap that is written down.
     *
     * It sits beside the README's same-host concession and is bounded the same way: it costs nothing against
     * a stolen disk, which is the threat the encrypted store is actually built for. It costs against an
     * attacker who can read this process's memory — and one who can do that can read the plaintext too,
     * because the store is open and the vault is unlocked. Revisit if the dependency ever grows a binary key
     * binding.
     *
     * @param {Buffer} key Raw 32-byte key. NOT a password — see below.
     * @returns {this}
     */
    open(key) {
        if (this.db) {
            // Not "close and reopen": a second open means a caller has lost track of the lifecycle, and
            // silently swapping connections would leak the first one with the key still in its page cache.
            throw new Error('MemoryStore is already open');
        }

        if (!Buffer.isBuffer(key) || key.length !== 32) {
            // Loud, because the alternative is SQLCipher cheerfully treating whatever this is as a
            // passphrase and encrypting the database under a key nobody can reproduce.
            throw new TypeError(`MemoryStore.open requires a 32-byte Buffer key, got ${Buffer.isBuffer(key) ? `${key.length} bytes` : typeof key}`);
        }

        const db = new Database(this.file);

        try {
            // 🔴 ORDER MATTERS: cipher BEFORE key. And 'sqlcipher' explicitly — SQLite3MultipleCiphers defaults
            // to chacha20, which encrypts perfectly well but produces a file that is NOT SQLCipher format and
            // cannot be read by standard SQLCipher tooling. We want the real format so a future migration or a
            // forensic check with the sqlcipher CLI stays possible.
            db.pragma('cipher=\'sqlcipher\'');
            db.pragma('legacy=4');

            // 🔴 x'..' means RAW KEY, not passphrase. Without the x'' form SQLCipher runs its own PBKDF2 over
            // these bytes as though a human had typed them — a second KDF over an already-uniform key, which is
            // pure cost and zero security. The vault's DEK already paid the argon2id price.
            db.pragma(`key="x'${key.toString('hex')}'"`);

            // 🔴 THE FOUNDING BET HAS A BACK DOOR AND THIS PRAGMA IS THE ONLY THING THAT CLOSES IT.
            //
            // SQLite3MultipleCiphers encrypts the main database, the journal, the subjournal and the WAL — and
            // NOT temporary or transient databases. In this pinned build the VFS branches for
            // SQLITE_OPEN_TEMP_DB / SQLITE_OPEN_TRANSIENT_DB / SQLITE_OPEN_TEMP_JOURNAL sit inside `#if 0`,
            // under the comment "TODO: Could/Should a temporary database file be encrypted?"
            // (deps/sqlite3/sqlite3.c, the read path and the write path). Those files are handed to the real
            // VFS in the clear.
            //
            // The build sets no SQLITE_TEMP_STORE, so it defaults to 1 — "a temp file is allowed" — and this
            // connection reports `temp_store = 0` without the line below. SQLite only keeps that scratch space
            // in RAM when temp_store is 2. So any query that needs a sorter or an ephemeral b-tree bigger than
            // the page cache writes MEMORY TEXT, IN PLAINTEXT, into %TEMP% — outside the vault tree entirely,
            // and outside anything Vault will ever encrypt or erase.
            //
            // It is reachable from the API, not just in theory: `listMemories` is an ORDER BY over an unindexed
            // `created_at` with `LIMIT ?` — which uses an ephemeral b-tree — and its bound is `limit + offset`
            // with a caller-controlled `offset`. One request with a large offset materializes the whole live
            // memory set into that scratch space.
            //
            // ⚠️ `tests/encrypted-vector-store.test.js` cannot see this: it inspects the database file, and the
            // spill is a different file in a different directory. Asserted directly in the suite instead.
            db.pragma('temp_store = 2');

            sqliteVec.load(db);

            // Nothing above has read a page, so nothing above has proved the key is right. This does: a wrong
            // key makes the file unintelligible and the first real read throws. Better here, with a clear
            // message, than from somewhere deep in a query later.
            try {
                db.exec('SELECT count(*) FROM sqlite_master');
            } catch (error) {
                throw new Error(`Cannot open memory store at ${this.file} — wrong key, or the file is not a SQLCipher database: ${/** @type {Error} */ (error).message}`);
            }

            this.db = db;
            this.#migrate();
        } catch (error) {
            // 🔴 Close on EVERY failure path, not only the wrong-key probe. A throw from sqliteVec.load or
            // from the migration would otherwise leave an open SQLCipher connection — key material alive in
            // its page cache — attached to an object the caller is about to discard. better-sqlite3 handles
            // do not close themselves on garbage collection; an unclosed one lives until the process exits,
            // which is precisely the lifetime NFR1 exists to forbid.
            this.db = null;
            db.close();
            throw error;
        }

        return this;
    }

    /**
     * Close the database and drop the connection.
     *
     * Callers must invoke this when the user's storage locks. Until they do, the key lives on inside
     * SQLCipher's page cache, which is precisely what the design promises it will not do.
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    /**
     * Create the schema in a new file, or refuse an old one.
     *
     * 🔴 **There is deliberately no upgrade path.** Every schema before v4 keyed its vectors on the character's
     * *display name* and had no notion of a memory's tier. Upgrading one would mean minting a `charId` for a
     * name that may since have been renamed onto a different character, and guessing a lifetime for every
     * memory ever written — where guessing "user" leaks one story into another and guessing "scenario" throws
     * away the cross-chat memory that is the whole product. Neither guess is defensible, and Mnemosyne is
     * pre-release: no such database exists. So this refuses, loudly, with the fix in the message.
     *
     * Refusing rather than recreating is the other half of that. This code will not delete a user's memories
     * on their behalf, even memories it cannot read — the one irreversible act available here is not one to
     * take automatically.
     *
     * ⚠️ **`this.db` is CAST at each use below rather than proved, and the same goes for
     * {@link #priorSchemaVersion}.** `open()` assigns the connection on the line before it calls this, but a
     * narrowing of that property does not follow into a method's own `this` — and the only way to prove it
     * here would be to call {@link #assertOpen}, which is new runtime behavior on the one path that decides
     * whether the store opens at all. The precondition is real and narrow: there is exactly one caller, and it
     * has just assigned.
     */
    #migrate() {
        // Read the version this file was last written at BEFORE creating anything, so a brand-new file (no
        // `meta` table yet → null) is distinguishable from an existing one written by an older Mnemosyne.
        const priorVersion = this.#priorSchemaVersion();

        if (priorVersion !== null && priorVersion < SCHEMA_VERSION) {
            throw new Error(
                `The memory store at ${this.file} was written at schema v${priorVersion}, and this Mnemosyne ` +
                `needs v${SCHEMA_VERSION}. There is no upgrade: v${priorVersion} keyed memories on the character's ` +
                'display name, which a rename silently orphans, and it recorded no lifetime for a memory — so an ' +
                'automatic upgrade would have to guess, and a wrong guess leaks one story into another. ' +
                'Mnemosyne is pre-release. Delete the file and it will be recreated empty.',
            );
        }

        if (priorVersion !== null && priorVersion > SCHEMA_VERSION) {
            // A newer Mnemosyne wrote this. Opening it anyway would read columns that may have changed meaning.
            throw new Error(
                `The memory store at ${this.file} was written at schema v${priorVersion} by a NEWER Mnemosyne ` +
                `than this one (v${SCHEMA_VERSION}). Refusing to open it — upgrade Mnemosyne rather than ` +
                'downgrading the database.',
            );
        }

        /** @type {SqliteDatabase} */ (this.db).exec('BEGIN');
        try {
            for (const ddl of BASE_DDL) {
                /** @type {SqliteDatabase} */ (this.db).exec(ddl);
            }

            // 🔴 BACKFILL THE LEXICAL INDEX FOR A STORE THAT PREDATES IT, or every memory written before
            // today is invisible to keyword search for ever. The triggers in `BASE_DDL` only maintain rows
            // written from now on, and an empty FTS table is not an error state anywhere — retrieval would
            // simply return nothing from that channel and look like a model that had never learned the word.
            //
            // 🔴 **THE FLAG IS IN `meta`, BECAUSE THE INDEX CANNOT BE ASKED WHETHER IT IS EMPTY.** The
            // obvious guard — rebuild when `memories` has rows and `memories_fts` has none — cannot work and
            // fails silently: `memories_fts` is an EXTERNAL-CONTENT table, so `SELECT COUNT(*)` on it reads
            // through to `memories` and returns the content table's count. The condition is therefore never
            // true, the rebuild never runs, and every pre-existing memory stays unfindable by keyword with
            // nothing anywhere reporting it. `tests/lexical-retrieval.test.js` caught exactly that.
            //
            // ⚠️ One-time by construction rather than by inference. `'rebuild'` re-reads the whole content
            // table, which is correct once per store and wasteful on every open — and "has this store been
            // backfilled?" is a fact ABOUT the database, which is what `meta` is for.
            const lexicalBuilt = /** @type {{value: string}|undefined} */ (
                /** @type {SqliteDatabase} */ (this.db).prepare('SELECT value FROM meta WHERE key = ?').get(LEXICAL_INDEX_BUILT)
            );

            if (!lexicalBuilt) {
                // ⚠️ **IT IS A NO-OP ON EVERY STORE THAT CAN STILL BE OPENED, AND THAT IS NOT WHAT IT WAS
                // WRITTEN FOR.** The FTS table shipped in `1a78d38` under `SCHEMA_VERSION` 5 specifically so a
                // v5 store would be upgraded in place rather than refused; `a0768a6` then bumped the version to
                // 6, and the guard at the top of `#migrate` now rejects every v5 file before this line is
                // reached. So "an existing one" no longer exists: the only stores that get here are brand new
                // and empty, where `'rebuild'` reads nothing. Kept because it costs one `meta` read per open
                // and is the correct shape for the next derived table — not because it currently backfills
                // anything. See the 🔴 beside the table's DDL in `schema.js`.
                /** @type {SqliteDatabase} */ (this.db).exec(
                    'INSERT INTO memories_fts(memories_fts) VALUES(\'rebuild\')',
                );
                /** @type {SqliteDatabase} */ (this.db).prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
                    .run(LEXICAL_INDEX_BUILT, '1');
            }

            // REPLACE, not IGNORE: harmless for a fresh file, and it keeps the statement honest if a future
            // version ever does gain an in-place upgrade above.
            /** @type {SqliteDatabase} */ (this.db).prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
                .run('schema_version', String(SCHEMA_VERSION));
            /** @type {SqliteDatabase} */ (this.db).exec('COMMIT');
        } catch (error) {
            // 🔴 THE ROLLBACK MUST NOT REPLACE THE REASON THE OPEN FAILED. SQLite auto-rolls-back on
            // SQLITE_FULL, SQLITE_IOERR and a busy COMMIT — and when it has, this `ROLLBACK` raises "cannot
            // rollback - no transaction is active", which then propagates INSTEAD of the original error, out
            // through `open()` to `session.js`, which logs only `error.message`. The operator was told the
            // rollback failed and never that the disk was full, on the one path that decides whether memory
            // works at all for that user.
            try {
                /** @type {SqliteDatabase} */ (this.db).exec('ROLLBACK');
            } catch {
                // Already rolled back by SQLite. Nothing to undo, and nothing worth saying over the real error.
            }
            throw error;
        }
    }

    /**
     * The schema version this file was last written at, or null if it predates the `meta` table (a brand-new
     * file) or was never stamped. Read inside {@link #migrate} to choose between creating fresh and upgrading.
     *
     * @returns {number|null}
     */
    #priorSchemaVersion() {
        const hasMeta = /** @type {SqliteDatabase} */ (this.db).prepare(
            'SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?',
        ).get('table', 'meta');

        if (!hasMeta) {
            return null;
        }

        // `meta.value` is `TEXT NOT NULL` (schema.js), so a row that exists has a string in it — but only a
        // string. What it SPELLS is the thing this method refuses to trust; see the NaN note below.
        const row = /** @type {{ value: string }|undefined} */ (
            /** @type {SqliteDatabase} */ (this.db).prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
        );

        if (!row) {
            return null;
        }

        const version = Number(row.value);

        // 🔴 AN UNREADABLE STAMP IS THE "REFUSE LOUDLY" CASE, AND IT USED TO SLIP THROUGH BOTH GUARDS.
        //
        // `Number('')`, `Number('4.0-beta')` and `Number(<a truncated write>)` are all NaN, and NaN is not
        // null — so `#migrate` saw "a version exists" while BOTH of its comparisons were false (`NaN < n` and
        // `NaN > n` are each false). It fell through to the create-fresh path, where
        // `CREATE TABLE IF NOT EXISTS memories` adds no columns to an existing table: a v3-shaped `memories`
        // survived intact and was then stamped `4`. Every later query died with `no such column: tier`, which
        // is precisely the confusing failure the deliberate version refusal exists to replace.
        if (!Number.isInteger(version)) {
            throw new Error(
                `Memory store at ${this.file} has an unreadable schema_version (${JSON.stringify(row.value)}). ` +
                'This file was not written by Mnemosyne, or it is corrupt. Refusing to touch it — move it aside ' +
                'and let a fresh store be created.',
            );
        }

        return version;
    }

    /**
     * Refuse to do anything against a locked vault, and prove to everything downstream that `db` is live.
     *
     * 🔴 The `asserts` signature is not decoration: it is the only reason the thirty-odd `this.db.prepare(...)`
     * below type-check against a deliberately nullable field. It states exactly what the body does — return
     * normally and `db` is a connection, or throw — so the checker and the reader are told the same thing,
     * rather than the reader being told it in prose and the checker being handed an `any`.
     *
     * @returns {asserts this is { db: SqliteDatabase }}
     */
    #assertOpen() {
        if (!this.db) {
            throw new Error('Memory store is not open. The vault is locked, or open() was never called.');
        }
    }

    /**
     * Every registered model's vector table, by name.
     *
     * 🔴 **The BigInt rule, stated once instead of four times.** `deleteMemory`, `forgetChat`, `rekeyChat` and
     * `retireMemory` all walk these tables, and every one of them must bind its rowid as a **BigInt**:
     * better-sqlite3 binds a JS number via `sqlite3_bind_double`, so vec0 sees a FLOAT where it demands an
     * integer and rejects it with the actively misleading *"Only integers are allows for primary key values"*
     * [sic]. Ordinary tables hide this behind INTEGER affinity and coerce silently; virtual tables do not. The
     * same trap applies to the `retired` INTEGER **metadata** column (*"Expected integer for INTEGER metadata
     * column retired, received FLOAT"*).
     *
     * That paragraph used to appear, abbreviated and cross-referencing itself, at all four sites — the comment
     * was repeated because the loop was. It lives here now; the call sites bind BigInt and say no more.
     *
     * ⚠️ Callers read this BEFORE opening their transaction, as all four always did. The model registry is not
     * what they are mutating, and `CREATE VIRTUAL TABLE` has no business inside a data transaction.
     *
     * @this {{ db: SqliteDatabase }} Every caller has already proved the connection is live via
     *   {@link #assertOpen}, and stating it that way makes the checker enforce it at each call site rather
     *   than have this method re-assert it — which would be new runtime work on a path four operations take.
     *   Narrowed to the one member this reads, because a polymorphic `this` is not assignable to the class.
     * @returns {string[]} one table name per registered model, in registration order
     */
    #vectorTables() {
        return /** @type {EmbeddingModelRow[]} */ (this.db.prepare('SELECT id FROM embedding_models').all())
            .map(({ id }) => vectorTableName(id));
    }

    /**
     * Register an embedding model, creating its vector table, or return the existing registration.
     *
     * 🔴 A model's dimension is fixed at registration and can never change, because it is baked into its
     * table's declaration (`float[768]`). If the same model name turns up later claiming a different
     * dimension, something is badly wrong upstream — two different models sharing a name, or a caller
     * measuring wrong — and adopting the new number would silently corrupt every existing vector. Throw.
     *
     * @param {string} model Model identifier, e.g. 'Xenova/all-mpnet-base-v2'
     * @param {number} dimension Vector length this model produces
     * @returns {EmbeddingModelRow & { table: string }} the registration, and the vector table it names
     */
    registerModel(model, dimension) {
        this.#assertOpen();

        if (typeof model !== 'string' || model.length === 0) {
            throw new TypeError('registerModel requires a non-empty model identifier');
        }

        // 🔴 VALIDATE BEFORE THE INSERT, BECAUSE THE INSERT IS DURABLE AND THE FAILURE IS NOT RECOVERABLE.
        //
        // `vectorTableDdl` rejects a non-positive dimension — but it used to be called AFTER the row had
        // already autocommitted (this method is deliberately outside any caller's transaction). So a bad
        // dimension left `embedding_models` naming a `vec_N` table that had never been created, and
        // `#vectorTables()` hands that name to every delete/retire/restore/forget path: all of them threw
        // `no such table: vec_N` on every call, for ever, with no repair path, because the `existing`
        // short-circuit above means the DDL never runs a second time. The user could no longer delete a
        // memory, and `forgetChat` — what makes "scenario memories die with the chat" true rather than
        // aspirational — failed silently on every chat deletion.
        //
        // It is reachable: `retrieval.js` guards `vectors.length` (how many vectors came back) and then passes
        // `vectors[0].length` (how long the first one is). A fork `embed()` returning `[[]]` satisfies the
        // first and is 0 in the second.
        if (!Number.isInteger(dimension) || dimension < 1) {
            throw new TypeError(
                `registerModel requires a positive integer dimension for '${model}', got ${JSON.stringify(dimension)}. ` +
                'A model that reports no dimension has not embedded anything.',
            );
        }

        const existing = /** @type {EmbeddingModelRow|undefined} */ (
            this.db.prepare('SELECT id, model, dimension FROM embedding_models WHERE model = ?').get(model)
        );

        if (existing) {
            if (existing.dimension !== dimension) {
                throw new Error(
                    `Model '${model}' is registered with dimension ${existing.dimension} but was offered ${dimension}. ` +
                    'A model\'s dimension cannot change; its vectors would be meaningless. Register it under a new name.',
                );
            }

            // 🔴 Idempotent by design, and load-bearing: it is what repairs a store whose model row survived a
            // crash between the INSERT and the DDL below. `IF NOT EXISTS` makes it free in the normal case.
            this.db.exec(vectorTableDdl(existing.id, existing.dimension));

            return { ...existing, table: vectorTableName(existing.id) };
        }

        // 🔴 One transaction: the row and the table it names are the same fact, so nothing may observe one
        // without the other. Nested inside a caller's transaction this becomes a savepoint, which is correct.
        const register = this.db.transaction(() => {
            const info = this.db.prepare('INSERT INTO embedding_models(model, dimension, created_at) VALUES (?, ?, ?)')
                .run(model, dimension, Date.now());
            const id = Number(info.lastInsertRowid);

            this.db.exec(vectorTableDdl(id, dimension));

            return id;
        });

        const id = register();

        return { id, model, dimension, table: vectorTableName(id) };
    }

    /**
     * Store a memory's text and its identity. Returns its id. The vector comes separately — see
     * {@link addVector}.
     *
     * These are two calls rather than one because they fail differently. The text is the durable thing and
     * must land even if no model is registered yet; the vector is derivative and can be (re)built whenever.
     *
     * ## The identity arguments are the scoping decision, made here and never again
     *
     * `tier` says how long this memory lives and therefore which axes key it (schema.js): `user` memories key
     * on `(charId, personaId)` and cross every chat; `scenario` memories key on `chatId` and die with it. The
     * composed `scope` written alongside them is what every vector table partitions on, and it is computed
     * here, once, by {@link scopeKey} — callers never pass a partition string in.
     *
     * ⚠️ `charName` is stored but is **not** part of any key. It is the display cache; see schema.js.
     *
     * The default tier is `scenario`, and that is the conservative direction: a memory whose caller said
     * nothing about lifetime stays inside the chat it came from. The opposite default would quietly promote
     * unclassified memories into every future conversation.
     *
     * ## `indexLine` is the string that will be EMBEDDED, and `text` is the one that will be INJECTED
     *
     * They are two arguments rather than one because they are two jobs (schema.js v5, {@link embedText}). This
     * method stores both and validates only `text`, which is the durable half: a memory with no text can never
     * be re-embedded, while a memory with no index line embeds its own text and is merely less findable.
     *
     * ⚠️ **It defaults to `''`, not to `text`.** Copying the text in would make "has no distillation"
     * indistinguishable from "was distilled to exactly itself", and {@link embedText} could no longer tell a
     * hand-written memory from an extracted one. Absent stays absent.
     *
     * @param {{ text: string, indexLine?: string|null, source?: string|null, metadata?: MemoryMetadata|null, tier?: string, charId?: string|null, personaId?: string|null, chatId?: string|null, charName?: string|null, createdAt?: number }} memory
     * @returns {number} The memory id
     */
    addMemory({
        text, indexLine = '', source = null, metadata = null,
        tier = TIER_SCENARIO, charId = null, personaId = null, chatId = null, charName = null,
        createdAt = Date.now(),
    }) {
        this.#assertOpen();

        if (typeof text !== 'string' || text.length === 0) {
            throw new TypeError('addMemory requires non-empty text — a memory with no text can never be re-embedded');
        }

        // Throws on an unknown tier rather than defaulting — see scopeKey. A memory filed under a tier nobody
        // recognizes has no defensible lifetime, and this is the last point at which that is cheap to say.
        const scope = scopeKey({ tier, charId, personaId, chatId });

        const info = this.db.prepare(`
            INSERT INTO memories(text, index_line, created_at, source, metadata, tier, char_id, persona_id, chat_id, char_name, scope)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            text, str(indexLine), createdAt, source, metadata ? JSON.stringify(metadata) : null,
            tier, str(charId), str(personaId), str(chatId), str(charName), scope,
        );

        return Number(info.lastInsertRowid);
    }

    /**
     * Attach a vector to an existing memory, for one model.
     *
     * @param {number} modelId Row id from {@link registerModel}
     * @param {number} memoryId Row id from {@link addMemory}
     * @param {Float32Array|number[]} vector The embedding
     * @returns {void}
     */
    addVector(modelId, memoryId, vector) {
        this.#assertOpen();

        const model = /** @type {{ dimension: number }|undefined} */ (
            this.db.prepare('SELECT dimension FROM embedding_models WHERE id = ?').get(modelId)
        );

        if (!model) {
            throw new Error(`No embedding model registered with id ${modelId}`);
        }

        const v = vector instanceof Float32Array ? vector : Float32Array.from(vector);

        if (v.length !== model.dimension) {
            throw new Error(`Model ${modelId} produces ${model.dimension}-dimension vectors, got ${v.length}`);
        }

        // 🔴 A SINGLE NaN COMPONENT POISONS THE RANKING, NOT JUST ITS OWN ROW. `Float32Array.from` maps any
        // non-numeric element to NaN without complaint, and vec0's distance for such a row is NaN. `search`
        // then merges partitions with `(a, b) => a.distance - b.distance`, and a comparator fed NaN is
        // INCONSISTENT — so the poisoned row can sort anywhere, including ahead of genuinely near neighbors,
        // and gets injected into the prompt as the most relevant thing in the store. Nothing throws and
        // nothing looks wrong. Checked here because this is the one door every vector comes through.
        if (!v.every(Number.isFinite)) {
            throw new TypeError(
                `Refusing to store a vector for memory ${memoryId}: it contains a non-finite component. ` +
                'One NaN makes this row\'s distance NaN, which corrupts the ordering of every search it appears in.',
            );
        }

        // 🔴 The partition value and the retired flag are READ FROM `memories`, never passed in. The memory row
        // is the authoritative source for both (schema.js), which is what makes a re-embed self-correcting: walk
        // {@link unembedded}, call this, and every vector lands in the right partition with the right flag
        // without the caller having to remember either. It also means a vector can never disagree with its
        // memory about whose it is or how long it lives — the bug that would quietly defeat scoping.
        // ⚠️ `retired` comes back as SQLite's INTEGER — 0 or 1, never a boolean — and is bound onward as a
        // BigInt for the reason two paragraphs down. Typed as the number it is so nobody writes `=== true`.
        const memory = /** @type {{ scope: string, retired: number }|undefined} */ (
            this.db.prepare('SELECT scope, retired FROM memories WHERE id = ?').get(memoryId)
        );

        if (!memory) {
            throw new Error(`No memory with id ${memoryId} — a vector cannot outlive the memory it indexes`);
        }

        // 🔴 rowid MUST be BigInt. better-sqlite3 binds a JS number via sqlite3_bind_double, so vec0 sees a
        // raw FLOAT where it demands an integer and rejects it with the actively misleading error "Only
        // integers are allows for primary key values" [sic]. Ordinary tables hide this behind INTEGER
        // affinity, which silently coerces; virtual tables do not. If you ever see that error, this is why.
        // The same applies to `retired`: an INTEGER *metadata* column rejects a bound JS number just as
        // flatly ("Expected integer for INTEGER metadata column retired, received FLOAT").
        //
        // 🔴 DELETE-then-INSERT, because `INSERT OR REPLACE` does NOT replace on a partitioned vec0 table — it
        // raises UNIQUE. This is also the only way to move a memory between partitions, since UPDATE on a
        // partition key is rejected outright (schema.js). Both statements, so re-embedding is idempotent.
        this.db.transaction(() => {
            this.db.prepare(`DELETE FROM ${vectorTableName(modelId)} WHERE rowid = ?`).run(BigInt(memoryId));
            this.db.prepare(`INSERT INTO ${vectorTableName(modelId)}(rowid, scope, embedding, retired) VALUES (?, ?, ?, ?)`)
                .run(BigInt(memoryId), memory.scope, Buffer.from(v.buffer, v.byteOffset, v.byteLength), BigInt(memory.retired));
        })();
    }

    /**
     * Store one memory and its vector together, atomically — the write-path counterpart to {@link search}.
     *
     * Composes {@link registerModel} → {@link addMemory} → {@link addVector} so a caller ingesting a memory
     * makes one call and gets one answer: the memory landed, or it did not. The memory row and its vector are
     * written in a single transaction. A half-written memory — text with no vector — is a state this schema
     * tolerates only for the re-embed worklist ({@link unembedded}), where a memory deliberately outlives a
     * model; a fresh ingest wants both or neither.
     *
     * Model registration is idempotent and stays OUTSIDE the transaction: a model that gains no memory because
     * the transaction rolled back is a harmless empty registration, and keeping its `CREATE VIRTUAL TABLE` out
     * of the data transaction keeps that transaction to two plain inserts.
     *
     * ⚠️ **`vector` must be the embedding of {@link embedText}'s answer for this memory, not of `text`.** This
     * method cannot check that and does not try — it is handed a vector, not an embedder. Every caller goes
     * through `embedText` for exactly that reason; a vector built from the paragraph while the column says
     * there is an index line would put the memory at coordinates no query ever searches from, and nothing
     * would report it.
     *
     * @param {{ text: string, indexLine?: string|null, vector: Float32Array|number[], model: string, source?: string|null, metadata?: MemoryMetadata|null, tier?: string, charId?: string|null, personaId?: string|null, chatId?: string|null, charName?: string|null, createdAt?: number }} memory
     * @returns {number} The new memory's id
     */
    remember({ text, indexLine = '', vector, model, source = null, metadata = null, tier = TIER_SCENARIO, charId = null, personaId = null, chatId = null, charName = null, createdAt = Date.now() }) {
        this.#assertOpen();

        if (!(vector instanceof Float32Array) && !Array.isArray(vector)) {
            throw new TypeError('remember requires a vector — a Float32Array or number[]');
        }
        if (vector.length === 0) {
            throw new TypeError('remember requires a non-empty vector');
        }

        // The dimension is the vector's own length; registerModel freezes it for this model on first sight and
        // refuses any later disagreement. text and model are validated by addMemory/registerModel in turn.
        const registered = this.registerModel(model, vector.length);

        return this.db.transaction(() => {
            const id = this.addMemory({ text, indexLine, source, metadata, tier, charId, personaId, chatId, charName, createdAt });
            this.addVector(registered.id, id, vector);
            return id;
        })();
    }

    /**
     * Search one model's vector space for the nearest memories.
     *
     * 🔴 `modelId` is not optional and there is no default. Searching "the vectors" without saying whose is
     * the one operation this schema exists to make impossible: a query embedded by model B, compared against
     * model A's coordinates, returns ten confidently-ranked results that are arithmetically valid and
     * completely meaningless. Making the caller name the model means that can only happen on purpose.
     *
     * ## Scoping (FR3)
     *
     * Pass `scopes` — an array of partition values from {@link scopeKey} — to restrict the search; omit it to
     * search the whole pool. 🔴 The filter is a vec0 **partition key**, evaluated before `k`, so a character
     * with three memories in a pool of thousands gets all three rather than whatever survived a global top-k.
     *
     * Retrieval passes **two** scopes (see `retrievalScopes`): this persona's durable facts and this chat's
     * story. One query runs per partition and the results are merged — and that is exactly equivalent to a
     * single `k`-search over the union, not an approximation of one. Any memory in the union's top `k` is
     * necessarily in its own partition's top `k`, so nothing that would have been returned can be missed. Two
     * cheap partition-scoped scans, one correct answer.
     *
     * An empty-string component is a real scope, not "unscoped" — `s:` selects memories from no chat at all.
     * Only omitting the option (or passing null) searches everything, which nothing on the retrieval path does.
     *
     * ## Guaranteed shares (`reserve`) — DESIGN.md §8 Q5, the half that lives here
     *
     * 🔴 **Without this, the merge below is a pure distance competition and one partition can take every
     * slot.** `config.js` names the failure exactly: *"a chat dense with scenario detail can crowd out every
     * durable fact about the user — which is the tier that makes the product what it is."* It is structural,
     * not a tuning accident: `retrievalScopes` hands in two partitions, the rows are concatenated, sorted by
     * distance and truncated at `k`, so `k` scenario memories that happen to sit nearer than anything in the
     * user partition return zero user-tier facts. A long, detailed chat makes that MORE likely, which is the
     * wrong way round — the longer the story runs, the more certainly the character forgets who it is talking
     * to.
     *
     * `reserve` is `{ [scope]: minimumSlots }`. Each named partition gets its own nearest rows up to that
     * minimum first; everything else competes on distance for what is left. The result is still returned in
     * distance order, so a caller that does not care sees the shape it always saw.
     *
     * ⚠️ **The seam is here and not in `retrieval.js`, and that was decided by writing it.** `src/retrieval.js`
     * records why a `rankHits` stage there could not answer this: by the time hits reach it the merge has
     * already happened and the losers are already gone, so it could only reorder survivors. This is the merge.
     *
     * ⚠️ **A reservation is a CEILING ON CROWDING, never a floor on relevance.** It can only promote a row that
     * the partition actually returned, and the `minCosine` floor in `retrieval.js` still discards it if it is
     * not similar enough. So this cannot inject an irrelevant memory; it can only stop a relevant one being
     * displaced by a partition having a better day. Reserving more slots than a partition has rows is
     * harmless — the unused ones fall back to open competition rather than being held empty.
     *
     * @param {number} modelId Row id from {@link registerModel} — the model that embedded `vector`
     * @param {Float32Array|number[]} vector The query embedding
     * @param {number} k How many results
     * @param {{ scopes?: string[]|null, reserve?: Record<string, number>|null }} [scope] Partitions to search,
     *   or null for the whole pool; and the per-partition guaranteed shares described above
     * @returns {SearchHit[]} nearest first
     */
    search(modelId, vector, k = 10, { scopes = null, reserve = null } = {}) {
        this.#assertOpen();

        const model = /** @type {{ dimension: number }|undefined} */ (
            this.db.prepare('SELECT dimension FROM embedding_models WHERE id = ?').get(modelId)
        );

        if (!model) {
            throw new Error(`No embedding model registered with id ${modelId}`);
        }

        const v = vector instanceof Float32Array ? vector : Float32Array.from(vector);

        if (v.length !== model.dimension) {
            throw new Error(`Model ${modelId} indexes ${model.dimension}-dimension vectors, got a ${v.length}-dimension query`);
        }

        // 🔴 BOTH filters are vec0 constraints, not JOIN predicates, and that is load-bearing. vec0 applies `k`
        // while scanning, so a predicate the JOIN evaluates afterward can only discard rows that have already
        // displaced better ones — the result silently comes back short. As a partition key and a metadata
        // column these run first, and `k` then applies to what survived. This is why there is no over-fetch
        // margin here any more: there is nothing left to over-fetch against.
        //
        // One statement, run once per partition. `scope = ?` is a single equality every time — the payoff for
        // composing the three identity axes into one key (schema.js) rather than declaring three of them.
        const partitions = Array.isArray(scopes) ? scopes : [null];
        /** @param {string} predicate The extra `AND` clause, or `''` for the unscoped form */
        const select = (predicate) => this.db.prepare(`
            SELECT m.id, m.text, m.source, m.metadata, m.tier, m.char_name AS charName, m.scope, v.distance
            FROM ${vectorTableName(modelId)} v
            JOIN memories m ON m.id = v.rowid
            WHERE v.embedding MATCH ? AND v.k = ? AND v.retired = 0${predicate}
            ORDER BY v.distance
        `);

        const embedding = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
        // Prepared once and reused across the partitions, since every scoped query is the same statement with a
        // different bound value — the payoff for one composed key instead of three columns.
        const scoped = partitions.some(s => s !== null) ? select(' AND v.scope = ?') : null;

        // Each partition returns its own nearest `k`, so everything a reservation could promote is already in
        // hand — guaranteeing shares costs no extra query, only a different way of choosing among these rows.
        //
        // ⚠️ `scoped` is non-null exactly when some partition is non-null, which is the only branch that uses
        // it — a correlation between two expressions that no checker can follow, hence the cast. Loosen the
        // `some(...)` above and this stops being an annotation problem and becomes a null dereference.
        const perPartition = /** @type {StoredSearchHit[][]} */ (partitions.map(
            scope => (scope === null
                ? select('').all(embedding, k)
                : /** @type {SqliteStatement} */ (scoped).all(embedding, k, scope)),
        ));

        const rows = this.#mergeWithReserve(perPartition, partitions, k, reserve);

        return rows.map(r => ({
            id: r.id,
            text: r.text,
            source: r.source,
            metadata: r.metadata ? JSON.parse(r.metadata) : null,
            tier: r.tier,
            charName: r.charName,
            scope: r.scope,
            distance: r.distance,
        }));
    }

    /**
     * The lexical half of retrieval: BM25 over the memories' own words, for the queries a vector misses.
     *
     * ## Why this exists next to {@link search} rather than instead of part of it
     *
     * A pooled sentence embedding is weak exactly where a keyword index is strong. A rare token contributes
     * little to a mean-pooled vector, while BM25 uses its document rarity. In a representative query set,
     * top-4 contained 9 wanted rows from dense search, 10 from lexical search, and 13 after fusion. Neither
     * channel dominates; they fail on different queries.
     *
     * 🔴 **THIS RETURNS A RANKING, NOT A SCORE THE CALLER MAY COMPARE WITH A COSINE.** `bm25()` is unbounded
     * and corpus-relative — its value depends on how many other rows contain the term — while a cosine is
     * bounded and absolute. There is no threshold that means the same thing on both, which is why the caller
     * fuses on RANK (`retrieval.js`) and why `rank` is returned already computed. A caller tempted to put
     * these two numbers in one comparison is about to invent a constant that works on today's store.
     *
     * ⚠️ **`bm25()` is NEGATIVE and more negative is BETTER**, so best-first is ASCENDING. Sorting these
     * descending returns the worst matches in perfect order and nothing anywhere reports it.
     *
     * ⚠️ The 2.0 weight on `index_line` says a hit in the distilled line counts double a hit in the body.
     * The index line is the memory's own statement of what it is about, so a term appearing there is a
     * stronger claim than the same term in prose — the same reasoning that makes it the string we embed.
     *
     * @param {string} expression An FTS5 MATCH expression, as {@link toMatchExpression} builds one. Callers
     *   must not pass raw user text: a question mark, a hyphen or a bare `AND` is FTS5 *syntax*, and the
     *   query either throws or silently means something else.
     * @param {number} k How many results
     * @param {{ scopes?: string[]|null }} [scope] Partitions to search, or null for the whole pool
     * @returns {LexicalHit[]} best match first
     */
    searchLexical(expression, k = 10, { scopes = null } = {}) {
        this.#assertOpen();

        if (typeof expression !== 'string' || expression.trim() === '') {
            return [];
        }

        // ⚠️ Both filters sit in the JOIN, and unlike the vec0 search above that is correct rather than a
        // trap. `k` in a vec0 query is a MATCH constraint applied while scanning, so a predicate evaluated
        // after it silently returns short; FTS5's LIMIT is an ordinary SQL limit over the finished result
        // set, so filtering first can only remove rows that should never have been candidates.
        const scoped = Array.isArray(scopes) && scopes.length > 0;
        const placeholders = scoped ? scopes.map(() => '?').join(', ') : '';
        const statement = this.db.prepare(`
            SELECT m.id, m.text, m.source, m.metadata, m.tier, m.char_name AS charName, m.scope,
                   bm25(memories_fts, 2.0, 1.0) AS score
            FROM memories_fts
            JOIN memories m ON m.id = memories_fts.rowid
            WHERE memories_fts MATCH ? AND m.retired = 0${scoped ? ` AND m.scope IN (${placeholders})` : ''}
            ORDER BY score
            LIMIT ?
        `);

        // 🔴 A malformed MATCH expression THROWS rather than returning nothing, and a throw here would take
        // down the whole generation for a query that merely had odd punctuation in it. Retrieval is a
        // best-effort enrichment: losing the lexical channel for one turn is a worse answer, and losing the
        // user's message is a broken product.
        /** @type {{id: number, text: string, source: string|null, metadata: string|null, tier: string, charName: string, scope: string, score: number}[]} */
        let rows;

        try {
            rows = /** @type {any[]} */ (scoped
                ? statement.all(expression, ...scopes, k)
                : statement.all(expression, k));
        } catch {
            return [];
        }

        // 🔴 **THIS CHANNEL HAS NO RELEVANCE FLOOR, AND THAT IS A KNOWN GAP RATHER THAN AN OVERSIGHT.** The
        // dense channel has `minCosine`; here, ANY row sharing one ≥3-character non-stopword term is returned,
        // and `fuseByRank` can inject it with `active: true`.
        //
        // It bites hardest at the bottom of the scale, because of what SQLite does there: fts5 clamps a
        // non-positive IDF to `1e-6`, and IDF goes non-positive once a term appears in HALF the indexed rows or
        // more. Every row matching only such terms scores about `-1.5e-6` — identical to the last bit — so
        // `ORDER BY score` cannot rank them and the tie falls to rowid. Ask a store *"Anything new in the
        // workshop?"* when most memories mention the workshop and the lexical list is, literally, the oldest
        // matching memories in insertion order.
        //
        // ⚠️ **AN ABSOLUTE SCORE THRESHOLD IS NOT THE FIX.** BM25's
        // magnitude scales with corpus size, so the same cutoff that removes clamped rows from a large store
        // removes real ones from a small store: `-1e-4` discarded "Sampletown3", a specific name unique in the
        // fixture, exactly what this channel exists to catch. A
        // correct floor has to be corpus-relative: drop query TERMS whose document frequency is at or above
        // half the row count, before the MATCH is built, rather than judging rows by their score afterward.
        // That is a real change to how the expression is assembled and wants its own measurement, so it is
        // written down here rather than guessed at.
        return rows.map((r, index) => ({
            id: r.id,
            text: r.text,
            source: r.source,
            metadata: r.metadata ? JSON.parse(r.metadata) : null,
            tier: r.tier,
            charName: r.charName,
            scope: r.scope,
            score: r.score,
            rank: index,
        }));
    }

    /**
     * Merge the per-partition result sets into one `k`-sized answer, honoring guaranteed shares.
     *
     * The three steps, in order:
     *
     *   1. **Reserved seats.** Each partition named in `reserve` contributes its own nearest rows, up to its
     *      minimum — or up to however many it actually has, whichever is smaller.
     *   2. **Open competition.** Everything not already taken competes on distance for the remaining slots,
     *      which is exactly what the whole merge used to be.
     *   3. **Distance order.** The winners are sorted together, so the caller still reads nearest-first and a
     *      reserved row does not jump the queue in the rendered block — it only survives to be in it.
     *
     * 🔴 **Step 1 must take the reserved rows in DISTANCE order within their partition**, not in row order. A
     * reservation says "this partition keeps a voice", not "this partition keeps an arbitrary memory": handing
     * a seat to its 4th-nearest row when its nearest was right there is a worse answer than the crowding it
     * was meant to prevent, and it would be invisible — the block would look fine and simply be wrong.
     *
     * ⚠️ With no `reserve` this is the old behavior exactly: step 1 takes nothing, step 2 is the original
     * concat-sort-slice. That equivalence is what lets every existing caller and test stay untouched, and
     * `tests/store.test.js` asserts it directly rather than trusting this paragraph.
     *
     * @param {StoredSearchHit[][]} perPartition Rows per partition, each already in distance order, aligned
     *   to `scopes`
     * @param {Array<string|null>} scopes The partition each result set came from
     * @param {number} k Total slots
     * @param {Record<string, number>|null} reserve Per-partition minimums
     * @returns {StoredSearchHit[]} at most `k` rows, in distance order
     */
    #mergeWithReserve(perPartition, scopes, k, reserve) {
        const all = perPartition.flat();

        if (!reserve) {
            return all.sort((a, b) => a.distance - b.distance).slice(0, k);
        }

        const taken = new Set();
        /** @type {StoredSearchHit[]} */
        const seats = [];

        scopes.forEach((scope, i) => {
            const minimum = scope === null ? 0 : (reserve[scope] ?? 0);

            if (!Number.isInteger(minimum) || minimum < 1) {
                return;
            }

            // Already in distance order — the query's own ORDER BY. Slicing the front is what makes a reserved
            // seat go to the partition's BEST row, which is the point of the 🔴 above.
            for (const row of perPartition[i].slice(0, minimum)) {
                if (seats.length < k && !taken.has(row.id)) {
                    taken.add(row.id);
                    seats.push(row);
                }
            }
        });

        // Whatever is left competes exactly as it always did. Reserving more than a partition holds leaks the
        // unused slots back into this pool rather than shrinking the answer.
        const contested = all
            .filter(row => !taken.has(row.id))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, Math.max(0, k - seats.length));

        return [...seats, ...contested].sort((a, b) => a.distance - b.distance);
    }

    /**
     * How many memories are stored, across every model.
     *
     * Cheap, and it exists for one caller: retrieval declines before paying to embed a query when there is
     * nothing to retrieve. Until ingest writes the first memory this is zero, and an interceptor that embedded
     * anyway would download the model on a user's very first prompt to search an empty store.
     *
     * @returns {number}
     */
    memoryCount() {
        this.#assertOpen();
        return /** @type {{ n: number }} */ (this.db.prepare('SELECT count(*) AS n FROM memories').get()).n;
    }

    /**
     * The subset of query terms that still say something about WHICH memory you want — the lexical channel's
     * relevance floor, expressed where it can actually be computed.
     *
     * 🔴 **THE FLOOR HAS TO BE CORPUS-RELATIVE, AND AN ABSOLUTE BM25 CUTOFF WAS MEASURED AND REJECTED.**
     * fts5 clamps a non-positive IDF to `1e-6`, and IDF goes non-positive once a term appears in half the rows
     * or more — so every row matching only such terms scores identically to the last bit, `ORDER BY score`
     * cannot rank them, and SQLite breaks the tie by rowid. Ask a store *"Anything new in the workshop?"* when
     * most memories mention the workshop and the lexical list is literally the oldest matching memories in
     * insertion order, each injected with no cosine and reported as a successful recall.
     *
     * Filtering the RESULTING ROWS by score cannot fix that, because BM25's magnitude scales with corpus size:
     * a `-1e-4` cutoff that removes clamped rows from a large store removes real ones from a small store. It
     * discarded "Sampletown3", a specific name unique in the whole fixture, i.e. exactly what this channel exists
     * to catch. So the judgment is made on TERMS, against the same document frequency SQLite itself uses, and
     * before the MATCH is ever built.
     *
     * ⚠️ **BELOW {@link DF_MIN_CORPUS} ROWS IT DOES NOTHING, DELIBERATELY.** "Appears in half the rows" is a
     * statement about a distribution, and a handful of memories has no distribution: in a two-row store every
     * term that matches anything at all is in half of it, so the rule would delete the entire query. The clamp
     * it defends against also barely matters at that size, because there is nothing for a mis-ranked row to
     * displace.
     *
     * ⚠️ Returning EMPTY is a real answer, not a failure. A question whose every term is corpus-common has no
     * lexical signal in it, and the honest response is for this channel to abstain and let the dense one carry
     * the turn — which is what an empty expression makes `retrieve` do.
     *
     * 🔴 **MEASURED OVER THE WHOLE INDEX, BECAUSE THAT IS WHAT fts5 MEASURES.** This is the sentence four
     * paragraphs up — *"against the same document frequency SQLite itself uses"* — finally being true. It
     * used to count `retired = 0 AND scope IN (…)` on both sides, i.e. the pool the SEARCH draws from, and
     * that is a different corpus from the one bm25 scores against: `memories_fts` is an external-content
     * index over ALL of `memories`, retired rows and every scope included, and `bm25()` knows nothing about
     * the JOIN that filters them afterward. Its IDF is `log((N - n + 0.5) / (n + 0.5))` with N the row count
     * of the INDEX, so the clamp this guard exists to predict is decided by numbers the guard was not looking
     * at. The two disagreed in both directions:
     *
     *   • **A term common globally but rare in this scope was KEPT** — 30 of one character's 100 memories,
     *     but 520 of the 1,000 indexed rows. fts5 clamps it to `1e-6`, every matching row ties to the last
     *     bit, and `ORDER BY score` falls through to rowid: the oldest matching memories, in insertion order,
     *     injected with no cosine and reported as a successful recall. Precisely the failure described above,
     *     surviving the fix meant to stop it.
     *   • **A term rare globally but common in this scope was DROPPED** — its IDF was healthy and it would
     *     have ranked properly. That is a discriminating term thrown away.
     *
     * The `scopes` parameter is gone rather than ignored: it named a pool that has no bearing on the number
     * being predicted, and an argument that cannot affect an answer is a lie about how the answer is reached.
     *
     * ⚠️ Retired rows COUNT, and that is not an oversight. Retirement is an UPDATE, the fts5 update trigger
     * re-inserts, and nothing removes the row from the index — so retired memories are in fts5's N whether or
     * not anyone wants them to be. A guard predicting fts5 has to count what fts5 counts.
     *
     * @param {string[]} terms Candidate query terms, already lowercased and stop-worded
     * @returns {string[]} those worth searching on, in the order given
     */
    informativeTerms(terms) {
        this.#assertOpen();

        if (!Array.isArray(terms) || terms.length === 0) {
            return [];
        }

        // N, exactly as fts5 has it: every indexed row. `memories_fts` is external-content over `memories`,
        // so their row counts are the same thing counted from either end.
        const indexed = /** @type {{ n: number }} */ (
            this.db.prepare('SELECT count(*) AS n FROM memories').get()
        ).n;

        if (indexed < DF_MIN_CORPUS) {
            return terms;
        }

        // One prepared statement, reused per term. The term count is a handful — a question, not a document —
        // so this is a few indexed lookups against an index that is already open. No JOIN: the whole point is
        // that nothing outside the index may narrow this count.
        const df = this.db.prepare('SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH ?');

        return terms.filter((term) => {
            try {
                const n = /** @type {{ n: number }} */ (df.get(`"${term}"`)).n;
                // `2n < N` is `log((N - n + 0.5) / (n + 0.5)) > 0` rearranged — the exact point fts5's IDF
                // goes non-positive and gets clamped. Same inequality as before; an honest N under it now.
                return n * 2 < indexed;
            } catch {
                // A term fts5 will not parse is not a term worth dropping the query over — the same
                // best-effort rule `searchLexical` applies to a malformed expression.
                return true;
            }
        });
    }

    /**
     * The stored memories, newest first — for a management view (FR7).
     *
     * Text and metadata only; a vector is an index into a memory, not content (schema.js), and has no place in
     * a listing. Metadata is parsed back from its stored JSON, matching what {@link search} hands back.
     *
     * Retired (superseded) memories are hidden by default — a management view wanting the full history, badges
     * and all, passes `includeRetired: true`. `retired` and `superseded_by` ride along so the caller can tell
     * which is which without a second query.
     *
     * `scopes` narrows the listing the same way it narrows {@link search}, and for the same reason: ingest
     * shows this list to the extractor as "already known", so an unscoped listing would put one character's
     * memories into another's extraction prompt — a leak into the model, not merely into a UI. Ingest passes
     * both of the current generation's partitions, because a fact already known in either tier is one the
     * extractor should not raise again.
     *
     * @param {{ limit?: number, offset?: number, includeRetired?: boolean, scopes?: string[]|null }} [page]
     * @returns {MemoryRow[]} newest first
     */
    listMemories({ limit = 50, offset = 0, includeRetired = false, scopes = null } = {}) {
        this.#assertOpen();

        const filter = this.#filter({ includeRetired, scopes });

        if (!filter) {
            return [];
        }

        const rows = /** @type {StoredMemoryRow[]} */ (this.db.prepare(`
            SELECT ${MEMORY_COLUMNS}
            FROM memories
            ${filter.sql}
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?
        `).all(...[...filter.params, limit, offset]));

        return rows.map(hydrate);
    }

    /**
     * The `WHERE` clause every listing, count and calendar query shares, or null for "match nothing".
     *
     * One place rather than four, for the reason `#vectorTables` is one place: the retired rule and the
     * partition rule are a *policy* about who may see what, and a policy copied into four queries is a policy
     * that will eventually be four policies. The browse view, its pager count, the calendar's dots and the
     * day-jump offset must agree exactly — a pager that counts rows the list does not show is an off-by-N the
     * user reads as missing memories.
     *
     * 🔴 An empty `scopes` array means "these partitions, of which there are none" — an empty answer, not the
     * whole store. Guarded here rather than at each call site because `scope IN ()` is a syntax error, and
     * because the alternative reading (list everything) is the one that leaks one persona's memories into
     * another's panel.
     *
     * @param {{ includeRetired?: boolean, scopes?: string[]|null }} [page]
     * @returns {{ sql: string, params: string[] }|null}
     */
    #filter({ includeRetired = false, scopes = null } = {}) {
        const partitions = Array.isArray(scopes) ? scopes : null;

        if (partitions && partitions.length === 0) {
            return null;
        }

        const where = [
            ...(includeRetired ? [] : ['retired = 0']),
            ...(partitions ? [`scope IN (${partitions.map(() => '?').join(', ')})`] : []),
        ];

        return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params: partitions ?? [] };
    }

    /**
     * One memory by id, or null. The same shape {@link listMemories} returns, so a caller can render a single
     * row with the code that renders a list of them.
     *
     * @param {number} memoryId
     * @returns {MemoryRow|null}
     */
    getMemory(memoryId) {
        this.#assertOpen();

        const row = /** @type {StoredMemoryRow|undefined} */ (
            this.db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(memoryId)
        );
        return row ? hydrate(row) : null;
    }

    /**
     * The live memory holding exactly this text in exactly this partition, or null.
     *
     * The manual write door's duplicate check (DESIGN_REFACTOR §6 follow-up). It is deliberately **exact text,
     * not similarity** — the two doors into the store answer different questions and must not share this one.
     *
     * 🔴 Ingest dedups on cosine bands because it is judging a *model's* paraphrase of a conversation, where
     * "she moved to Sample City 4" and "she now lives in Sample City 4" are one fact stated twice. A person typing into the
     * panel is doing something else: they are exercising authority over their own store, and two similar
     * sentences they typed on purpose are two memories they meant to have. Silently keeping one would hide
     * that choice. Byte-identical text is the one case where no distinction can be lost.
     *
     * ⚠️ **Scoped, and for the write-side reason rather than the read-side one.** The same sentence in two
     * partitions is two characters knowing the same thing, which `placeInPartition` also treats as two
     * memories rather than a duplicate to collapse. An unscoped match here would let a fact about one persona
     * suppress the identical fact about another.
     *
     * ⚠️ Retired rows are excluded on purpose. A memory the user superseded and then re-typed is a deliberate
     * revival, and the row that comes back should be a live one rather than a silent no-op against history.
     *
     * @param {string} text Exact text, already trimmed by the caller
     * @param {{ tier: string, charId?: string|null, personaId?: string|null, chatId?: string|null }} identity
     * @returns {MemoryRow|null} the existing memory, in {@link listMemories}' shape, or null
     */
    findLiveByText(text, { tier, charId = null, personaId = null, chatId = null }) {
        this.#assertOpen();

        // Throws on an unknown tier rather than defaulting, exactly as `addMemory` does — this has to compose
        // the same partition the write would land in, so it must refuse the same inputs.
        const scope = scopeKey({ tier, charId, personaId, chatId });

        const row = /** @type {StoredMemoryRow|undefined} */ (this.db.prepare(
            `SELECT ${MEMORY_COLUMNS} FROM memories WHERE text = ? AND scope = ? AND retired = 0 ORDER BY id LIMIT 1`,
        ).get(text, scope));

        return row ? hydrate(row) : null;
    }

    /**
     * How many memories a {@link listMemories} with the same filter would have to page through.
     *
     * The pager's denominator. Counted rather than derived from a page, because "showing 1–20 of 70" with a
     * wrong 70 is worse than no total at all: it is the panel making a claim about the store that the store
     * does not support, in a feature whose entire purpose is that the user can trust what it says.
     *
     * @param {{ includeRetired?: boolean, scopes?: string[]|null }} [page]
     * @returns {number}
     */
    countMemories({ includeRetired = false, scopes = null } = {}) {
        this.#assertOpen();

        const filter = this.#filter({ includeRetired, scopes });

        if (!filter) {
            return 0;
        }

        return /** @type {{ n: number }} */ (
            this.db.prepare(`SELECT count(*) AS n FROM memories ${filter.sql}`).get(...filter.params)
        ).n;
    }

    /**
     * Every matching memory's `created_at`, newest first, and nothing else.
     *
     * 🔴 **Timestamps out, never day buckets.** The caller groups these into days in JavaScript, using the
     * IANA zone the browser supplied (fork panel design §7.7). SQLite cannot do it: it knows `'localtime'` —
     * the *server's* zone — and fixed numeric offsets, has no IANA zone database, and a fixed offset is wrong
     * on both sides of a DST boundary, so server-local buckets can disagree with the browser's calendar.
     *
     * Text is deliberately absent: the calendar needs to know *that* a day has memories, never what they say,
     * and a query that cannot return a statement cannot leak one into a view that only draws dots.
     *
     * @param {{ includeRetired?: boolean, scopes?: string[]|null }} [page]
     * @returns {number[]} epoch-ms timestamps, newest first
     */
    memoryTimes({ includeRetired = false, scopes = null } = {}) {
        this.#assertOpen();

        const filter = this.#filter({ includeRetired, scopes });

        if (!filter) {
            return [];
        }

        return /** @type {{ createdAt: number }[]} */ (
            this.db.prepare(`SELECT created_at AS createdAt FROM memories ${filter.sql} ORDER BY created_at DESC, id DESC`)
                .all(...filter.params)
        ).map(r => r.createdAt);
    }

    /**
     * Which of these memories have at least one earlier version behind them.
     *
     * @see {@link versions.havePredecessors} — the query and the reason it is one query for a whole page
     * @param {number[]} ids
     * @returns {Set<number>} the subset that something points at
     */
    havePredecessors(ids) {
        this.#assertOpen();

        return versions.havePredecessors(this.db, ids);
    }

    /**
     * The `source` of each of these memories, by id.
     *
     * @see {@link versions.sourcesOf} — why the browse view asks about the SUCCESSOR and not the retired row
     * @param {number[]} ids
     * @returns {Map<number, string|null>}
     */
    sourcesOf(ids) {
        this.#assertOpen();

        return versions.sourcesOf(this.db, ids);
    }

    /**
     * The earlier versions of a memory, newest first — the chain that led to this one.
     *
     * @see {@link versions.versionsOf} — the backward walk, and why it is bounded by a seen-set anyway
     * @param {number} memoryId The memory whose history is wanted
     * @param {number} [limit] Stop after this many, newest first
     * @returns {MemoryRow[]} earlier versions, most recent first; empty if this memory replaced nothing
     */
    versionsOf(memoryId, limit = 50) {
        this.#assertOpen();

        return versions.versionsOf(this.db, memoryId, limit);
    }

    /**
     * Delete a memory and every vector that indexed it, across all models.
     *
     * The text is the durable truth (schema.js), so this is the one operation that removes it on purpose. A
     * memory's vectors live in one table per model; all of them go with it in a single transaction, so a
     * memory can never survive as a dangling vector nor a vector outlive its memory.
     *
     * @param {number} memoryId Row id from {@link addMemory}
     * @returns {boolean} true if a memory was deleted, false if no memory had that id
     */
    deleteMemory(memoryId) {
        this.#assertOpen();

        const tables = this.#vectorTables();

        return this.db.transaction(() => {
            for (const table of tables) {
                this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(BigInt(memoryId));
            }
            return this.db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId).changes > 0;
        })();
    }

    /**
     * Erase every memory in this store, and leave everything that is not a memory exactly where it was.
     *
     * 🔴 **THIS IS WHY THE OPERATION EXISTS IN HERE AND NOT AS A FILE DELETE.** From outside the process the
     * only available granularity is the whole file, because it is SQLCipher and the key exists nowhere else —
     * so an operator clearing memory by hand also loses their settings, their presets and their edited
     * extraction prompt, which live in `meta` and are not memories by any reading. In here the key is already
     * open, so the two can be told apart. `meta` is the table this method must never touch, and the test that
     * matters is the one asserting a preset survives.
     *
     * What goes, and why each one is a memory rather than a preference:
     *
     *   - `memories` — the durable truth, and the thing being erased. The fts5 triggers take the lexical
     *     index out with it (`delete-all` afterward is belt to that braces; see below).
     *   - every `vec_<n>` — a vector is an INDEX INTO a memory (schema.js) and cannot outlive one. Emptied,
     *     never dropped: the table's declaration carries the model's dimension, and `embedding_models` stays
     *     so that switching back to a model you have used before is still free.
     *   - `ingest_state` — the per-chat high-water marks. Leaving them would make every open conversation
     *     start life already "extracted", so a user who reset because ingest had produced junk would sit
     *     watching it produce nothing at all until they said something new. ⚠️ Clearing them does NOT
     *     backfill: the next pass reads the window it is given and no further back (`windowSlice`), so
     *     history above that window stays unread.
     *
     * ⚠️ **`VACUUM` IS PART OF THE ANSWER, NOT A TIDY-UP.** Deleting rows returns their pages to a free list
     * inside the same file, so without it a user who just erased 12,000 memories is told the store is still
     * 13 MB — which reads as "it did not work", and is the one impression this button cannot afford to leave.
     * It runs outside the transaction because SQLite refuses it inside one.
     *
     * @returns {{ memories: number, bytesBefore: number, bytesAfter: number }} how many memories were erased,
     *          and the file's size on disk either side of it
     */
    clearMemories() {
        this.#assertOpen();

        const bytesBefore = this.#fileBytes();
        const { memories } = /** @type {{ memories: number }} */ (
            this.db.prepare('SELECT COUNT(*) AS memories FROM memories').get()
        );
        // Read before the transaction opens, like every other caller — the model registry is not what this is
        // mutating, and it must survive.
        const tables = this.#vectorTables();

        this.db.transaction(() => {
            for (const table of tables) {
                this.db.prepare(`DELETE FROM ${table}`).run();
            }

            this.db.prepare('DELETE FROM memories').run();
            this.db.prepare('DELETE FROM ingest_state').run();

            // ⚠️ The triggers have already emptied the index row by row; this makes "empty" true rather than
            // merely likely. `memories_fts` is an EXTERNAL-CONTENT table, so it holds no copy of the text to
            // check against and a `SELECT COUNT(*)` on it reads through to `memories` — meaning a stale entry
            // left by a store written before the triggers existed would be invisible to every test that could
            // be written about it, and would go on matching a memory that no longer exists. `delete-all` is
            // the one command fts5 offers that cannot leave one behind.
            this.db.prepare('INSERT INTO memories_fts(memories_fts) VALUES(\'delete-all\')').run();
        })();

        // 🔴 OUTSIDE THE TRANSACTION, AND AFTER IT. `VACUUM` inside one throws "cannot VACUUM from within a
        // transaction"; better-sqlite3's `transaction()` wrapper would surface that as a failed reset on a
        // store that had in fact been cleared correctly.
        this.db.exec('VACUUM');

        return { memories, bytesBefore, bytesAfter: this.#fileBytes() };
    }

    /**
     * How much is in here right now: the memory count and the file's size on disk.
     *
     * 🔴 **This lets the panel show current usage without erasing anything.** Previously, the only available
     * size arrived in the `clearMemories` result, so it could be read only by destroying the data measured.
     *
     * ⚠️ **The bytes are the WHOLE FILE, and the file is never a memories-only measurement.** Settings,
     * presets and the extraction prompt live in `meta` in the same file and are deliberately kept by a reset,
     * so an emptied store still reports a real size — the panel says so in words rather than leaving a user to
     * wonder why "erase everything" left 96 KB behind. Pairing the count with the size is what makes that
     * legible: `0 memories` is the claim, the KB is just the container.
     *
     * @returns {{ memories: number, bytes: number }} rows in `memories`, and this store's size on disk
     */
    usage() {
        this.#assertOpen();

        const { memories } = /** @type {{ memories: number }} */ (
            this.db.prepare('SELECT COUNT(*) AS memories FROM memories').get()
        );

        return { memories, bytes: this.#fileBytes() };
    }

    /**
     * This store's size on disk, or 0 if it cannot be measured.
     *
     * ⚠️ The FILE, not `page_count * page_size`. They agree after a VACUUM and disagree before one, and the
     * number this exists to produce is the one a user would see in a file manager — a reset that reported the
     * logical size would claim the space back before the space came back.
     *
     * Failing to `stat` is not a reason to fail a reset that has already happened, so this answers 0 and the
     * caller reports an unknown size rather than an error.
     *
     * @returns {number} bytes
     */
    #fileBytes() {
        try {
            return fs.statSync(this.file).size;
        } catch {
            return 0;
        }
    }

    /**
     * Forget one chat: delete every scenario-tier memory that belonged to it, and its ingest bookkeeping.
     *
     * This is the second half of the two-tier design (schema.js) — the half that makes "dies with the chat"
     * true rather than aspirational. Without it, scenario memories are merely *unreachable* after the chat is
     * gone: still on disk, still in every vector table, accumulating for ever.
     *
     * 🔴 **User-tier memories are deliberately untouched**, even though they carry the same `chat_id`. A fact
     * about the person you are talking to was learned *in* a chat but is not *about* it, and deleting the chat
     * is not a request to forget them. That is the whole distinction the tiers encode, and this is the one
     * method where getting it backward would destroy exactly the memories the product exists to keep.
     *
     * This DELETES rather than retires, unlike {@link retireMemory}. Retirement exists because supersession is
     * a similarity *guess* that must be recoverable; a chat being deleted is not a guess.
     *
     * ✅ **Live since fork §24** (`onChatDeleted`, fork `ae3e8d94d`). `forgetChatFor` in `src/index.js` is the
     * handler; the fork fires it for all four deletion paths — one chat, one conversation from a group, a whole
     * group, and a character deleted *with* its chats. Built ahead of that signal because the lifetime is part
     * of the schema's contract rather than a feature of whatever announced it.
     *
     * 🔴 **The `chatId` must be byte-identical to the one on `OutgoingPrompt`.** The scope key is composed at
     * write time from that string, so a differently-spelled id matches no rows and this method cheerfully
     * reports deleting zero — the one way this fails silently rather than loudly. The fork therefore derives
     * the id from the basename of the file it actually unlinked rather than from the request body, which
     * appends `.jsonl` when the client omits it: byte-identical by construction instead of by agreement
     * between two files that can drift apart. Do not "normalize" the id on the way in here.
     *
     * Not to be confused with fork §22.6, whose open deletion question is about a **character card** being
     * deleted — a different event, a different key, and one with an unanswered policy question in front of it
     * (does deleting a card mean forgetting what it knew about the user?). There is deliberately no
     * `forgetCharacter` here yet. An earlier version of this comment cited §22.6 for chat deletion, which
     * confused the fork into not knowing which signal to build.
     *
     * @param {string} chatId The chat whose scenario memories are to be forgotten
     * @returns {number} How many memories were deleted
     */
    forgetChat(chatId) {
        this.#assertOpen();

        // 🔴 AN EMPTY CHAT ID IS NOT A CHAT THAT MATCHES NOTHING. IT IS A REAL, POPULATED PARTITION.
        //
        // The docblock above says a mis-spelled id "cheerfully reports deleting zero", and that is true of a
        // WRONG id. It was never true of an EMPTY one. `scopeKey({tier: 'scenario', chatId: ''})` composes
        // `'s:'` — and `''` is a deliberate, distinct partition component meaning "no chat" (schema.js
        // `part`), which is exactly where every scenario memory written by a generation carrying no `chatId`
        // has always gone. `OutgoingPrompt.chatId` is optional, so that partition is populated on any install
        // whose client does not send one.
        //
        // So `forgetChat('')` deleted that entire partition and its vectors, returned a plausible non-zero
        // count, and `forgetChatFor` logged it as an ordinary success: "a deleted chat took N scenario
        // memories with it." Nothing anywhere raised. `null` behaved identically; `undefined` was safe only by
        // accident, because the `ingest_state` delete throws on an undefined binding late enough for the
        // transaction to roll back the deletes it had already done.
        //
        // ⚠️ `rekeyChat`, twelve lines below, has refused exactly this since it was written — same
        // contract, same silent-failure argument in its own docblock, and the guard only ever got added to
        // one of the two. Nothing on the path in front of this method validates either: the fork's
        // `onChatDeleted` id goes through `index.js` and `session.js` untouched, and `session.js` swallows
        // the throw, which is correct for a handler and is also why an unguarded delete here would never
        // surface.
        //
        // Refusing is the conservative half of an irreversible pair: a refused delete leaves rows an operator
        // can still remove, and a wrong delete leaves nothing to recover.
        if (typeof chatId !== 'string' || !chatId) {
            throw new TypeError('forgetChat requires a non-empty chat id');
        }

        const scope = scopeKey({ tier: TIER_SCENARIO, chatId });
        const tables = this.#vectorTables();

        // 🔴 COMPILED ONCE PER TABLE, NOT ONCE PER (MEMORY × TABLE). `prepare()` inside the loop compiled a
        // fresh statement for every pair — deleting a chat with 2,000 scenario memories against two registered
        // models compiled 4,000 of them, inside the write transaction, holding the lock. better-sqlite3 is
        // synchronous and the store is one connection shared by the whole user session, so that blocks the Node
        // event loop: every other Mnemosyne request, including the retrieval hook on an in-flight generation,
        // waits behind a chat deletion. `search` already hoists for exactly this reason.
        const deletes = tables.map(table => this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`));

        return this.db.transaction(() => {
            const doomed = /** @type {{ id: number }[]} */ (
                this.db.prepare('SELECT id FROM memories WHERE scope = ?').all(scope)
            );

            for (const { id } of doomed) {
                for (const statement of deletes) {
                    statement.run(BigInt(id));
                }
            }

            this.db.prepare('DELETE FROM memories WHERE scope = ?').run(scope);
            // The high-water mark goes too: it names turns in a chat that no longer exists, and leaving it
            // would make a later chat reusing the id start life already "extracted".
            this.db.prepare('DELETE FROM ingest_state WHERE chat_key = ?').run(chatId);

            return doomed.length;
        })();
    }

    /**
     * Re-key one chat: move every scenario-tier memory from the old chat id to the new one.
     *
     * The counterpart to {@link forgetChat}, and the opposite operation despite the similar shape. A rename
     * changes a chat's `chatId` **while the chat still exists** — `onChatDeleted` does not fire, so without
     * this the chat's scenario memories sit in a partition nothing will ever query again, on a conversation
     * the user is still in the middle of. Same stranding as an unhandled deletion, except the user is still
     * talking to the character that can no longer remember any of it.
     *
     * 🔴 **RE-KEY, DO NOT DELETE.** Handling a rename by calling {@link forgetChat} on the old id would
     * destroy live memories on purpose — worse than the stranding it was meant to fix. The rename is not a
     * request to forget anything, and there is no path here that deletes a memory.
     *
     * ## Why this cannot be one UPDATE
     *
     * `memories` is an ordinary table and updates fine. Every vec0 table **partitions on `scope`**, and vec0
     * 0.1.9 rejects `UPDATE` on a partition key outright ("not supported yet", schema.js) — so each affected
     * vector must be READ, DELETEd and re-INSERTed under the new partition. That is the same delete-then-insert
     * {@link addVector} performs, for the same reason, with the same BigInt rowid binding.
     *
     * 🔴 **Hence the transaction, and it is not decoration.** A crash between the delete and the insert would
     * lose vectors while their memory rows survived — the half-written state the schema tolerates only for the
     * re-embed worklist ({@link unembedded}). Wrapping the whole walk means a rename either moves everything or
     * moves nothing.
     *
     * ## What moves, and what deliberately does not
     *
     * Only **`scenario`** memories key on `chatId` (`scopeKey`), so only their partition changes; user-tier
     * rows key on `(charId, personaId)`, cross every chat, and must not be touched by a rename. The scenario
     * rows are selected by their old partition value rather than by `chat_id`, which is what makes that
     * narrowing structural instead of a filter someone can forget.
     *
     * `chat_id` itself is updated on **every** tier, because it is provenance — "the chat this was learned in"
     * — and that chat still exists under a new name. Leaving it stale would be merely untidy today and wrong
     * later: rename `B` → `A` afterward and a user-tier row still stamped with `A` would claim provenance
     * from a conversation it never saw. Nothing keys on the column; it is read back by {@link listMemories}.
     *
     * The ingest high-water mark travels with the chat, the reverse of {@link forgetChat} discarding it. The
     * messages are the same messages, so a mark left behind would re-extract the entire conversation from
     * scratch under its new name, and one abandoned under the old id would silently re-arm if that id ever
     * came back. Any mark already sitting on the *new* id is stale by construction — it describes a chat that
     * no longer answers to it — so it is dropped rather than allowed to collide with the arriving row.
     *
     * 🔴 **Both ids must be spelled exactly as `OutgoingPrompt.chatId` spells them**, the same contract and the
     * same silent failure as {@link forgetChat}: an `oldChatId` differing by so much as a `.jsonl` matches no
     * partition and reports moving zero rows. The fork derives both from the two paths it actually moved
     * (§24.4), never from the request body. Do not "normalize" either one on the way in.
     *
     * @param {string} oldChatId The chat id before the rename
     * @param {string} newChatId The chat id after it
     * @returns {number} How many memories were re-keyed
     */
    rekeyChat(oldChatId, newChatId) {
        this.#assertOpen();

        if (typeof oldChatId !== 'string' || !oldChatId || typeof newChatId !== 'string' || !newChatId) {
            throw new TypeError('rekeyChat requires two non-empty chat ids');
        }

        // The fork guarantees this never fires (§24.4: the comparison is exact and deliberately
        // case-sensitive), so this is not a case to support — it is a refusal to do a delete-then-insert whose
        // source and destination partitions are the same. Zero rows moved is the truthful answer.
        if (oldChatId === newChatId) {
            return 0;
        }

        const oldScope = scopeKey({ tier: TIER_SCENARIO, chatId: oldChatId });
        const newScope = scopeKey({ tier: TIER_SCENARIO, chatId: newChatId });
        const tables = this.#vectorTables();

        // 🔴 THREE STATEMENTS PER TABLE, NOT THREE PER (MEMORY × TABLE). See the same note in `forgetChat`:
        // renaming a chat with 2,000 scenario memories against two models compiled TWELVE THOUSAND statements
        // inside the write transaction, blocking the event loop — and a rename happens while the user is still
        // in the conversation, so the stall lands on a live chat.
        const perTable = tables.map(table => ({
            read: this.db.prepare(`SELECT embedding, retired FROM ${table} WHERE rowid = ?`),
            remove: this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`),
            insert: this.db.prepare(`INSERT INTO ${table}(rowid, scope, embedding, retired) VALUES (?, ?, ?, ?)`),
        }));

        return this.db.transaction(() => {
            const moving = /** @type {{ id: number }[]} */ (
                this.db.prepare('SELECT id FROM memories WHERE scope = ?').all(oldScope)
            );

            for (const { id } of moving) {
                for (const { read, remove, insert } of perTable) {
                    // ⚠️ `embedding` comes back as the raw BLOB better-sqlite3 gives a vec0 vector column, and
                    // is re-bound unread — this path moves a vector between partitions and never inspects one.
                    const vector = /** @type {{ embedding: Buffer, retired: number }|undefined} */ (
                        read.get(BigInt(id))
                    );

                    // This model has no vector for this memory: it is on the re-embed worklist (see
                    // `unembedded`), which is a legitimate state and not an error. Nothing to move.
                    if (!vector) {
                        continue;
                    }

                    remove.run(BigInt(id));
                    insert.run(BigInt(id), newScope, vector.embedding, BigInt(vector.retired));
                }
            }

            // The partition move on the ordinary table — scenario rows only, selected by the old partition.
            this.db.prepare('UPDATE memories SET scope = ? WHERE scope = ?').run(newScope, oldScope);
            // Provenance, across every tier. See the docblock: this is deliberately wider than the line above.
            this.db.prepare('UPDATE memories SET chat_id = ? WHERE chat_id = ?').run(newChatId, oldChatId);

            // `chat_key` is the PRIMARY KEY, so a stale row on the destination id would make this UPDATE raise
            // UNIQUE and take the whole rename down. It cannot describe the arriving chat, so it goes first.
            this.db.prepare('DELETE FROM ingest_state WHERE chat_key = ?').run(newChatId);
            this.db.prepare('UPDATE ingest_state SET chat_key = ? WHERE chat_key = ?').run(newChatId, oldChatId);

            return moving.length;
        })();
    }

    /**
     * Retire a memory, optionally recording which memory supersedes it.
     *
     * 🔴 Retirement is NOT deletion (schema.js, DESIGN_INGEST §5.3). The row and its vectors stay; the memory is
     * only marked so {@link search} stops returning it. This is deliberate: ingest supersedes on a similarity
     * guess, and a wrong guess must be recoverable — in a roleplay "no longer true" is story, and
     * {@link deleteMemory} (which really destroys text) is too sharp an instrument for it. Only a live memory can
     * be retired; retiring an already-retired one is a no-op, so the first supersession's `superseded_by` stands.
     *
     * @see {@link versions.retireMemory} — the self-supersession guard, and why the flag is mirrored into every
     *   vector table rather than only into `memories`
     * @param {number} memoryId The memory to retire
     * @param {number|null} [supersededById] The memory that replaces it, or null if simply retired
     * @returns {boolean} true if a live memory was retired, false if no live memory had that id
     */
    retireMemory(memoryId, supersededById = null) {
        this.#assertOpen();

        return versions.retireMemory(this.db, this.#vectorTables(), memoryId, supersededById);
    }

    /**
     * Correct a memory's text and metadata IN PLACE — a repair of what a parser defect wrote, never an edit.
     *
     * ⚠️ **Not versioned, unlike {@link reviseMemory}, and that is the distinction.** A version records a change
     * of what the memory SAYS. This fixes bytes that were never meant to be part of it, so a history entry holding the broken text would be noise that "Show replaced"
     * puts in front of the user. The FTS index follows through its UPDATE trigger (schema.js).
     *
     * 🔴 The caller keeps the vector valid: only use this where the change does not move what was embedded —
     * the index line, when there is one (`embedText`).
     *
     * @param {number} memoryId
     * @param {{ text: string, metadata: import('./schema.js').MemoryMetadata }} fix
     * @returns {boolean} true if a row was changed
     */
    repairMemory(memoryId, { text, metadata }) {
        this.#assertOpen();

        return this.db.prepare('UPDATE memories SET text = ?, metadata = ? WHERE id = ?')
            .run(text, JSON.stringify(metadata), memoryId).changes > 0;
    }

    /**
     * Revise a memory's text: store the new wording as a new memory and retire the old one behind it.
     *
     * ## 🔴 An edit is VERSIONED, never in place (fork panel design §14.2)
     *
     * Three edits leave three retired rows and one live one, `superseded_by` pointing forward — which is
     * exactly what ingest already does when it decides a newer memory replaces an older one. That is the
     * argument: a hand edit and an automatic supersession become **one mechanism**, so there is one chain to
     * walk, one {@link restoreMemory} to undo either, and one history to render. Two parallel histories would
     * be more code and not less. The two causes are told apart by `source`, never by structure.
     *
     * 🔴 **The new row inherits the old one's `createdAt`, and that is deliberate.** A memory's timestamp is
     * when the thing happened, not when the user last fixed a typo in it. Stamping the edit's own time would
     * move a three-day-old memory into today's group in a panel whose whole organization is days, telling the
     * user something happened this morning that did not. When the correction was made is recoverable from the
     * chain; when the memory was *about* is not, and only one of the two is worth an axis.
     *
     * ⚠️ **This does NOT re-run dedup or supersession, and must not learn to** (§14.5). A hand edit changes one
     * selected memory; silently retiring another row would modify data the user did not choose to edit.
     *
     * ⚠️ **There is no vector to clear.** The fork's §14.3 requires an edit to delete the memory's vector from
     * every model table before re-embedding — correct, and load-bearing, for an *in-place* edit, which this is
     * not. The new row is new: it has no vector anywhere, gets one for the current model only, and every other
     * model correctly finds it through {@link unembedded} if it ever returns. The old row keeps its own text
     * and its own vectors, which is what makes it a version rather than a tombstone; {@link retireMemory}
     * mirrors `retired = 1` into every vector table, and that — not deletion — is what stops {@link search}
     * returning it. Deleting them here would strip a historical row's index and put it back on every model's
     * re-embed worklist for ever.
     *
     * ⚠️ **`indexLine` distinguishes "not supplied" from "cleared", and the default is INHERIT.** `null` (or
     * absent) keeps whatever distillation the memory already had; a string — including `''` — replaces it. A
     * caller that knows nothing about v5 therefore edits the text without silently destroying the line that
     * makes the memory findable, and a panel that shows both fields can clear one deliberately. The two cases
     * are different intentions and a single `= ''` default would collapse them into the destructive one.
     *
     * @param {{ memoryId: number, text: string, indexLine?: string|null, vector: Float32Array|number[], model: string, source?: string }} revision
     * @returns {number|null} the new memory's id, or null if no LIVE memory had that id
     */
    reviseMemory({ memoryId, text, indexLine = null, vector, model, source = 'edit' }) {
        this.#assertOpen();

        if (!(vector instanceof Float32Array) && !Array.isArray(vector) || vector.length === 0) {
            throw new TypeError('reviseMemory requires a non-empty vector — a revision that cannot be searched is a deletion');
        }

        // Outside the transaction, exactly as `remember` keeps it there: an empty registration left behind by a
        // rollback is harmless, and `CREATE VIRTUAL TABLE` has no business inside a data transaction.
        const registered = this.registerModel(model, vector.length);

        return this.db.transaction(() => {
            const old = /** @type {Pick<StoredMemoryRow, 'text'|'indexLine'|'createdAt'|'metadata'|'tier'|'charId'|'personaId'|'chatId'|'charName'>|undefined} */ (
                this.db.prepare(
                    'SELECT text, index_line AS indexLine, created_at AS createdAt, metadata, tier, char_id AS charId, ' +
                    'persona_id AS personaId, chat_id AS chatId, char_name AS charName FROM memories WHERE id = ? AND retired = 0',
                ).get(memoryId)
            );

            if (!old) {
                // Already retired, already deleted, or never existed. A second click on a stale panel lands
                // here (§8.7), and it is not an error — the user's intent was already carried out.
                return null;
            }

            // 🔴 Every identity axis is inherited, not re-derived. The revision is the same memory in better
            // words: same tier, same character, same persona, same chat, and therefore the same partition. A
            // re-derivation here would need the caller to supply identity it has no reason to know, and the
            // first time it got one axis wrong the edited memory would silently move to a partition nothing
            // retrieves from — the memory-shaped hole this plugin exists to refuse.
            const id = this.addMemory({
                text,
                indexLine: indexLine === null ? old.indexLine : indexLine,
                source,
                metadata: old.metadata ? JSON.parse(old.metadata) : null,
                tier: old.tier,
                charId: old.charId,
                personaId: old.personaId,
                chatId: old.chatId,
                charName: old.charName,
                createdAt: old.createdAt,
            });

            this.addVector(registered.id, id, vector);
            this.retireMemory(memoryId, id);

            return id;
        })();
    }

    /**
     * Bring a retired memory back, retiring whatever currently stands in its place.
     *
     * The undo for both kinds of supersession — a similarity guess ingest got wrong, and an edit the user
     * regrets — because {@link reviseMemory} deliberately made them the same chain.
     *
     * @see {@link versions.restoreMemory} — the forward walk to the live head, the mid-chain re-link that keeps the
     *   history linear, the cycle the cleared `superseded_by` prevents, and why `source` becomes `restore`
     * @param {number} memoryId The retired memory to bring back
     * @returns {{ id: number, retiredId: number|null }|null} what was restored and what stood down for it, or
     *   null if no RETIRED memory had that id
     */
    restoreMemory(memoryId) {
        this.#assertOpen();

        return versions.restoreMemory(this.db, this.#vectorTables(), memoryId);
    }

    /**
     * The automatic-ingest bookkeeping for a chat, or null if extraction has never run for it.
     *
     * @param {string} chatKey The opaque per-chat key the caller assigned
     * @returns {{ chatKey: string, highWater: number, lastRun: number, failedAtTurns: number }|null}
     */
    getIngestState(chatKey) {
        this.#assertOpen();

        const row = /** @type {{ chatKey: string, highWater: number, lastRun: number, failedAtTurns: number }|undefined} */ (
            this.db.prepare(
                'SELECT chat_key AS chatKey, high_water AS highWater, last_run AS lastRun, '
                + 'failed_at_turns AS failedAtTurns FROM ingest_state WHERE chat_key = ?',
            ).get(chatKey)
        );

        return row ?? null;
    }

    /**
     * Record where automatic ingest has read to in a chat, and when it last ran (insert or replace).
     *
     * The high-water mark advances only on a successful extraction (DESIGN_INGEST §4.1); a failed or lost run
     * simply never calls this, and the next tick re-reads the same window. That is the whole recovery story, and
     * it is why the mark lives in the encrypted database rather than in memory.
     *
     * ⚠️ **`failedAtTurns` defaults to 0, meaning "the last attempt did not fail".** A successful run that
     * omits it therefore CLEARS a previous failure, which is the behavior the backoff wants: one good pass
     * ends the backoff immediately rather than making a working chat serve out the rest of a penalty.
     *
     * @param {string} chatKey The opaque per-chat key
     * @param {{ highWater: number, lastRun: number, failedAtTurns?: number }} state
     * @returns {void}
     */
    setIngestState(chatKey, { highWater, lastRun, failedAtTurns = 0 }) {
        this.#assertOpen();

        this.db.prepare(
            'INSERT OR REPLACE INTO ingest_state(chat_key, high_water, last_run, failed_at_turns) VALUES (?, ?, ?, ?)',
        ).run(chatKey, highWater, lastRun, failedAtTurns);
    }

    /**
     * A JSON value kept in the `meta` table, or null if it was never written or cannot be read.
     *
     * 🔴 **A CORRUPT VALUE READS AS ABSENT, DELIBERATELY.** `meta.value` is `TEXT NOT NULL`, so a row that
     * exists holds a string — what it SPELLS is not guaranteed, because a future version, a partial write or
     * a hand-edited database can all put something else there. The caller is settings and presets, and for
     * both of those the honest recovery from "unreadable" is "you are running the defaults", which is what
     * `null` means here. Throwing would take the user's whole memory store down over a preferences blob.
     *
     * ⚠️ This is why it does not distinguish "missing" from "unparseable". If a future caller ever needs to
     * tell those apart — to warn that settings were lost rather than never set — that is a new method, not a
     * change to this one, because every existing caller treats them the same and correctly.
     *
     * @param {string} key
     * @returns {unknown} the parsed value, or null
     */
    getMetaJson(key) {
        this.#assertOpen();

        const row = /** @type {{ value: string }|undefined} */ (
            this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
        );

        if (!row) {
            return null;
        }

        try {
            return JSON.parse(row.value);
        } catch {
            return null;
        }
    }

    /**
     * Write a JSON value into the `meta` table (insert or replace).
     *
     * ⚠️ Inside the encrypted database like everything else, and that is the point rather than a convenience:
     * a user's memory settings say how much they remember and how often, and the preset names they choose are
     * their own words. Neither belongs in a plaintext sidecar next to a store built to keep the memories
     * themselves private.
     *
     * @param {string} key
     * @param {unknown} value JSON-serializable
     * @returns {void}
     */
    setMetaJson(key, value) {
        this.#assertOpen();

        this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
    }

    /**
     * How many memories have no vector for this model — the size of {@link unembedded}'s work list.
     *
     * 🔴 THIS EXISTS SO A MODEL CHANGE CANNOT FAIL SILENTLY, which is exactly how it failed before.
     * `unembedded`'s docblock has always claimed a model change is "a background job rather than a data-loss
     * event" — but nothing called it, so the job never ran and nothing said so. The memories kept their text,
     * kept appearing in the browse list, and simply stopped being recalled, for ever. A memory that is present
     * and unfindable is the memory-shaped hole this plugin exists to refuse, and it arrived through the one
     * door nobody was watching.
     *
     * One COUNT, called where the running model first becomes known. In normal operation it is **always
     * zero** — every write path goes through {@link remember} or {@link reviseMemory}, both of which insert
     * the text and its vector in one transaction, so a memory cannot exist without a vector for the model
     * that wrote it. The only thing that can make this non-zero is the embedding model changing underneath a
     * store. That is a deliberate, rare, human act, which is why the repair is triggered rather than
     * scheduled: a timer here would return zero for ever.
     *
     * @param {number} modelId Row id from {@link registerModel}
     * @returns {number} memories needing a vector for this model
     */
    countUnembedded(modelId) {
        this.#assertOpen();

        if (!this.db.prepare('SELECT 1 FROM embedding_models WHERE id = ?').get(modelId)) {
            throw new Error(`No embedding model registered with id ${modelId}`);
        }

        return /** @type {{ n: number }} */ (this.db.prepare(`
            SELECT count(*) AS n
            FROM memories m
            WHERE NOT EXISTS (SELECT 1 FROM ${vectorTableName(modelId)} v WHERE v.rowid = m.id)
        `).get()).n;
    }

    /**
     * Memories that have no vector for this model — i.e. the re-embed work list.
     *
     * This is what makes a model change a background job rather than a data-loss event. Register the new
     * model, walk this list, embed the text, {@link addVector}. Nothing is destroyed and the old model's
     * table stays searchable throughout.
     *
     * The walker is `POST /memory/reembed`, driven a batch at a time after the warning.
     *
     * ⚠️ Both strings come back, and the caller embeds {@link embedText}'s answer rather than picking one. A
     * re-embed that fed the paragraph to a model whose original vector came from the index line would move the
     * memory to different coordinates than a fresh write would have given it — same database, two rules, and
     * only one of them matching what search compares against.
     *
     * @param {number} modelId Row id from {@link registerModel}
     * @param {number} limit Batch size
     * @returns {Array<{ id: number, text: string, indexLine: string }>}
     */
    unembedded(modelId, limit = 100) {
        this.#assertOpen();

        if (!this.db.prepare('SELECT 1 FROM embedding_models WHERE id = ?').get(modelId)) {
            throw new Error(`No embedding model registered with id ${modelId}`);
        }

        return /** @type {{ id: number, text: string, indexLine: string }[]} */ (this.db.prepare(`
            SELECT m.id, m.text, m.index_line AS indexLine
            FROM memories m
            WHERE NOT EXISTS (SELECT 1 FROM ${vectorTableName(modelId)} v WHERE v.rowid = m.id)
            ORDER BY m.id
            LIMIT ?
        `).all(limit));
    }
}
