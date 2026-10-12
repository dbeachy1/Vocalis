import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { MemoryStore } from '../src/store.js';
import { SCHEMA_VERSION, TIER_SCENARIO, TIER_USER, embedText, retrievalScopes, scopeKey, vectorTableName } from '../src/schema.js';
// ⚠️ The one import here that is not the store, and it earns its place: `clearMemories`'s whole claim is that
// it erases memories and NOT settings, and the only honest way to assert that is through the module that
// actually reads them back. Asserting on raw `meta` keys instead would prove the rows survived while leaving
// "and the settings screen still shows them" untested.
import { readPresets, readPromptTemplate, readSettings, savePreset, writePromptTemplate, writeSettings } from '../src/settings.js';

/**
 * The store's tests. The center of gravity is "two models never mix" — everything else is plumbing.
 *
 * Note what these do NOT re-prove: that the disk is ciphertext, that sqlite-vec agrees with brute force,
 * that the leak check has teeth. Those live in encrypted-vector-store.test.js, which owns the founding bet.
 * This file assumes that bet is won and tests the thing built on top of it.
 */

/**
 * The value, proven present, so the line after it can read a field off it.
 *
 * 🔴 AN ASSERTION, NOT A CAST, and that difference is the whole reason this exists. `getMemory`,
 * `getIngestState`, `MemoryStore.db` and `Array.find` are all honestly nullable, and every use below is a row
 * the lines directly above it just wrote. So a null here means the WRITE broke — and the failure has to say
 * so HERE, rather than three lines later as a property read on `undefined`, which names the reader and not
 * the bug.
 *
 * @template T
 * @param {T|null|undefined} value
 * @returns {T} the same value, with the null ruled out by the two assertions above the return
 */
function present(value) {
    expect(value).not.toBeNull();
    expect(value).toBeDefined();

    return /** @type {T} */ (value);
}

/**
 * An argument of the wrong type, on purpose — the negative tests, and nothing else.
 *
 * 🔴 THE GUARDS THESE TESTS COVER EXIST BECAUSE MNEMOSYNE'S CALLERS ARE NOT TYPE-CHECKED. `open`,
 * `addVector`, `forgetChat`, `rekeyChat` and `scopeKey` are reached from the fork's plugin loader and from a
 * browser panel, neither of which this checker has ever seen — so "the parameter says it cannot happen" is not
 * a thing any of them may rest on. Naming the violation at the call site is what keeps the guard testable
 * without widening the parameter the guard is about, which would delete the claim instead of proving it.
 *
 * @template T
 * @param {unknown} value What a caller outside this repository can, and does, actually send
 * @returns {T} the same value, typed as the parameter that is about to refuse it
 */
function wrongType(value) {
    return /** @type {T} */ (value);
}

const key = () => Buffer.from(crypto.hkdfSync('sha256', crypto.randomBytes(32), Buffer.alloc(0), Buffer.from('mnemosyne-db-v1'), 32));

/**
 * A deterministic unit vector that leans hard in one direction, so nearest-neighbor results are obvious.
 *
 * @param {number} dim How many components
 * @param {number} lean Which one carries the weight
 * @returns {Float32Array}
 */
function vec(dim, lean) {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) v[i] = i === lean ? 1 : 0.001;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    for (let i = 0; i < dim; i++) v[i] /= n;
    return v;
}

/** @type {string} */
let dir;
/** @type {MemoryStore} */
let store;
/** @type {Buffer} */
let dbKey;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosyne-store-'));
    dbKey = key();
    store = new MemoryStore(path.join(dir, 'memory.db')).open(dbKey);
});

afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('opening', () => {
    test('a 32-byte key opens it, and the schema is there', () => {
        const stamp = /** @type {{ value: string }} */ (present(store.db).prepare('SELECT value FROM meta WHERE key = ?').get('schema_version'));

        expect(stamp.value).toBe(String(SCHEMA_VERSION));
    });

    /**
     * 🔴 THE LAST PLACE PLAINTEXT COULD STILL REACH A DISK, AND NO OTHER TEST CAN SEE IT.
     *
     * `encrypted-vector-store.test.js` proves the database file is ciphertext. It cannot prove anything about a
     * DIFFERENT file in a DIFFERENT directory, and that is exactly what this guards.
     *
     * SQLite3MultipleCiphers encrypts the main database, the journal, the subjournal and the WAL. It does NOT
     * encrypt temporary or transient databases: in the pinned build the `SQLITE_OPEN_TEMP_DB`,
     * `SQLITE_OPEN_TRANSIENT_DB` and `SQLITE_OPEN_TEMP_JOURNAL` branches of the cipher VFS sit inside `#if 0`,
     * under the comment *"TODO: Could/Should a temporary database file be encrypted?"* — both on the read path
     * and on the write path. Anything SQLite puts there is handed to the real VFS in the clear.
     *
     * The build sets no `SQLITE_TEMP_STORE`, so it defaults to permitting a temp FILE, and a fresh connection
     * reports `temp_store = 0`. SQLite keeps sorter output and ephemeral b-trees in RAM only at 2. That matters
     * because `listMemories` is an `ORDER BY created_at` over an unindexed column with `LIMIT ?` — an ephemeral
     * b-tree — and its bound is `limit + offset` with a caller-controlled offset. One request with a large
     * offset pulls the entire live memory set through that scratch space and out to `%TEMP%`, outside the vault
     * tree, where nothing will ever encrypt or erase it.
     *
     * If this assertion fails, memory text can be written to disk unencrypted. It is the founding bet.
     */
    test('🔴 temp_store is MEMORY — the cipher VFS leaves temp files in the CLEAR, so there must be none', () => {
        expect(present(store.db).pragma('temp_store', { simple: true })).toBe(2);
    });

    test('🔴 an unreadable schema_version is refused loudly, not stamped over a foreign schema', () => {
        // `Number('4.0-beta')` is NaN, and NaN is not null — so #migrate saw "a version exists" while BOTH of
        // its comsamplecity1ons were false, fell through to create-fresh, and CREATE TABLE IF NOT EXISTS added no
        // columns to the existing table. A foreign schema survived intact and was stamped current; every later
        // query then died with `no such column: tier` instead of the deliberate, actionable refusal.
        present(store.db).prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '4.0-beta');
        store.close();

        expect(() => new MemoryStore(path.join(dir, 'memory.db')).open(dbKey))
            .toThrow(/unreadable schema_version/i);
    });

    test('🔴 the WRONG key is rejected at open, not later from inside some query', () => {
        store.close();

        expect(() => new MemoryStore(path.join(dir, 'memory.db')).open(key()))
            .toThrow(/wrong key|not a SQLCipher database/i);
    });

    test('🔴 a password-shaped key is refused rather than silently used as a passphrase', () => {
        // If this ever stops throwing, SQLCipher will PBKDF2 the string and encrypt under a key nobody can
        // reproduce. Loud beats clever.
        expect(() => new MemoryStore(path.join(dir, 'x.db')).open(wrongType('hunter2')))
            .toThrow(/32-byte Buffer/);
        expect(() => new MemoryStore(path.join(dir, 'x.db')).open(crypto.randomBytes(16)))
            .toThrow(/32-byte Buffer/);
    });

    test('open() on an already-open store throws rather than silently leaking the first connection', () => {
        expect(() => store.open(dbKey)).toThrow(/already open/);
    });

    test('a FAILED open leaves no connection behind — db stays null, nothing to hold a key', () => {
        // The wrong-key path here stands in for every failure inside open(): whatever throws, the native
        // handle must be closed and the store must look never-opened. An unclosed better-sqlite3 handle
        // does not die with its object — it lives, key in page cache, until the process exits.
        store.close();
        const again = new MemoryStore(path.join(dir, 'memory.db'));

        expect(() => again.open(key())).toThrow(/wrong key|not a SQLCipher database/i);
        expect(again.db).toBeNull();

        store = new MemoryStore(path.join(dir, 'memory.db')).open(dbKey);
    });

    test('reopening with the same key finds the data again', () => {
        const id = store.addMemory({ text: 'the cat jumped over the lazy dog' });
        store.close();

        store = new MemoryStore(path.join(dir, 'memory.db')).open(dbKey);

        const row = /** @type {{ text: string }} */ (present(store.db).prepare('SELECT text FROM memories WHERE id = ?').get(id));

        expect(row.text).toBe('the cat jumped over the lazy dog');
    });

    test('using a closed store says so, rather than throwing on a null', () => {
        store.close();

        expect(() => store.addMemory({ text: 'x' })).toThrow(/not open|locked/i);
        store = new MemoryStore(path.join(dir, 'memory.db')).open(dbKey);
    });
});

describe('model registration', () => {
    test('registering a model creates its own vector table, named by id', () => {
        const m = store.registerModel('Test Character 9/all-mpnet-base-v2', 768);

        expect(m.id).toBe(1);
        expect(m.table).toBe('vec_1');
        expect(present(store.db).prepare('SELECT name FROM sqlite_master WHERE name = ?').get('vec_1')).toBeDefined();
    });

    test('registering the same model twice is idempotent — it does not mint a second table', () => {
        const a = store.registerModel('Test Character 9/all-mpnet-base-v2', 768);
        const b = store.registerModel('Test Character 9/all-mpnet-base-v2', 768);

        expect(b.id).toBe(a.id);
        expect(/** @type {{ c: number }} */ (present(store.db).prepare('SELECT count(*) c FROM embedding_models').get()).c).toBe(1);
    });

    test('🔴 a model changing its dimension is refused — its existing vectors would become nonsense', () => {
        store.registerModel('some/model', 768);

        expect(() => store.registerModel('some/model', 384))
            .toThrow(/dimension cannot change|registered with dimension 768/i);
    });

    test('the model name never reaches the DDL — table names come from the integer id', () => {
        // Model names arrive from config and contain slashes and dots. If one were interpolated into DDL,
        // this is where it would show up as an injection.
        const m = store.registerModel('evil/model"; DROP TABLE memories; --', 8);

        expect(m.table).toBe(vectorTableName(m.id));
        expect(present(store.db).prepare('SELECT name FROM sqlite_master WHERE name = ?').get('memories')).toBeDefined();
    });
});

describe('storing and searching', () => {
    /**
     * 🔴 ONE NaN POISONS THE RANKING, NOT JUST ITS OWN ROW. `Float32Array.from` maps any non-numeric element to
     * NaN silently, and vec0's distance for that row is then NaN. `search` merges partitions with
     * `(a, b) => a.distance - b.distance`, and a comparator fed NaN is INCONSISTENT — so the poisoned row can
     * sort anywhere, including ahead of genuinely near neighbors, and gets injected into the prompt as the
     * most relevant thing in the store. Nothing throws and nothing looks wrong.
     */
    test('🔴 a vector with a non-finite component is refused rather than corrupting every future search', () => {
        const m = store.registerModel('m', 8);
        const id = store.addMemory({ text: 'poison' });

        for (const bad of [[NaN, 0, 0, 0, 0, 0, 0, 0], [Infinity, 0, 0, 0, 0, 0, 0, 0], wrongType(['x', 0, 0, 0, 0, 0, 0, 0])]) {
            expect(() => store.addVector(m.id, id, bad)).toThrow(/non-finite/i);
        }
    });

    test('🔴 a memory cannot supersede itself — the chain would report history it cannot walk', () => {
        const id = store.remember({ text: 'only', vector: vec(8, 0), model: 'm' });

        expect(() => store.retireMemory(id, id)).toThrow(/cannot supersede itself/i);
    });

    test('a memory round-trips with its metadata', () => {
        const m = store.registerModel('m', 8);
        const id = store.addMemory({ text: 'hello', source: 'chat', metadata: { character: 'Ada' } });
        store.addVector(m.id, id, vec(8, 0));

        const [hit] = store.search(m.id, vec(8, 0), 1);

        expect(hit.id).toBe(id);
        expect(hit.text).toBe('hello');
        expect(hit.source).toBe('chat');
        expect(hit.metadata).toEqual({ character: 'Ada' });
    });

    test('search returns nearest first', () => {
        const m = store.registerModel('m', 8);
        const near = store.addMemory({ text: 'near' });
        const far = store.addMemory({ text: 'far' });
        store.addVector(m.id, near, vec(8, 0));
        store.addVector(m.id, far, vec(8, 7));

        const hits = store.search(m.id, vec(8, 0), 2);

        expect(hits.map(h => h.text)).toEqual(['near', 'far']);
    });

    describe('guaranteed tier shares — DESIGN.md §8 Q5, the crowding fix', () => {
        const IDENTITY = { charId: 'c1', personaId: 'p1', chatId: 'chat-7' };

        /**
         * A vector at a controllable distance from `off(0)`: larger `t`, steadily farther.
         *
         * ⚠️ NOT `vec(dim, lean)`. That helper is one-hot, so every lean except the query's own is EXACTLY
         * equidistant from it — which makes "the scenario tier is nearer" unexpressible and silently produces a
         * fixture whose ordering is arbitrary. This tilts one axis against another so distance is monotonic in
         * `t`, which is the only way to state the crowding these tests are about.
         *
         * @param {number} t How far to tilt axis 1 against axis 0
         * @returns {Float32Array}
         */
        function off(t) {
            const v = new Float32Array(8);
            v[0] = 1;
            v[1] = t;
            const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
            return v.map(x => x / n);
        }

        /**
         * A store where the scenario tier is denser AND nearer than the user tier — the shape a long, detailed
         * chat produces, and the one that used to return zero durable facts about the user.
         *
         * Five scenario memories at t = 0.1…0.5, two user memories at t = 1.0 and 1.2. Every scenario memory is
         * strictly nearer to an `off(0)` query than either user memory, so on pure distance the scenario tier
         * wins all five slots.
         */
        function crowdedStore() {
            const m = store.registerModel('m', 8);

            for (let i = 1; i <= 5; i++) {
                store.remember({ text: `scene ${i}`, vector: off(i / 10), model: 'm', tier: TIER_SCENARIO, ...IDENTITY });
            }
            store.remember({ text: 'user fact A', vector: off(1.0), model: 'm', tier: TIER_USER, ...IDENTITY });
            store.remember({ text: 'user fact B', vector: off(1.2), model: 'm', tier: TIER_USER, ...IDENTITY });

            return m;
        }

        test('🔴 without a reservation the scenario tier takes every slot — this is the defect', () => {
            const m = crowdedStore();
            const scopes = retrievalScopes(IDENTITY);

            const hits = store.search(m.id, off(0), 5, { scopes });

            // The longer the story runs the more certainly this happens, which is exactly backward.
            expect(hits).toHaveLength(5);
            expect(hits.every(h => h.tier === TIER_SCENARIO)).toBe(true);
        });

        test('a reservation keeps the user tier in the answer', () => {
            const m = crowdedStore();
            const [userScope] = retrievalScopes(IDENTITY);

            const hits = store.search(m.id, off(0), 5, {
                scopes: retrievalScopes(IDENTITY),
                reserve: { [userScope]: 2 },
            });

            expect(hits).toHaveLength(5);
            expect(hits.filter(h => h.tier === TIER_USER)).toHaveLength(2);
            expect(hits.filter(h => h.tier === TIER_SCENARIO)).toHaveLength(3);
        });

        test('🔴 a reserved seat goes to that partition\'s NEAREST row, not an arbitrary one', () => {
            const m = crowdedStore();
            const [userScope] = retrievalScopes(IDENTITY);

            const hits = store.search(m.id, off(0), 5, {
                scopes: retrievalScopes(IDENTITY),
                reserve: { [userScope]: 1 },
            });

            // 'user fact A' is at lean 6, 'B' at lean 7, so A is nearer to a lean-0 query. Handing the seat to
            // B would be a worse answer than the crowding, and would look fine in the rendered block.
            expect(hits.filter(h => h.tier === TIER_USER).map(h => h.text)).toEqual(['user fact A']);
        });

        test('the answer stays in distance order — a reserved row does not jump the queue', () => {
            const m = crowdedStore();
            const [userScope] = retrievalScopes(IDENTITY);

            const hits = store.search(m.id, off(0), 5, {
                scopes: retrievalScopes(IDENTITY),
                reserve: { [userScope]: 2 },
            });

            const distances = hits.map(h => h.distance);
            expect(distances).toEqual([...distances].sort((a, b) => a - b));
            // It survives to be in the block; it does not pretend to be the most relevant thing in it.
            expect(hits[0].tier).toBe(TIER_SCENARIO);
        });

        test('reserving more than a partition holds leaks the unused slots back, never shrinks the answer', () => {
            const m = crowdedStore();
            const [userScope] = retrievalScopes(IDENTITY);

            const hits = store.search(m.id, off(0), 5, {
                scopes: retrievalScopes(IDENTITY),
                reserve: { [userScope]: 4 },   // the user partition has only 2
            });

            expect(hits).toHaveLength(5);
            expect(hits.filter(h => h.tier === TIER_USER)).toHaveLength(2);
        });

        test('⚠️ reserve: 0 and no reserve are the old pure-distance merge, exactly', () => {
            const m = crowdedStore();
            const [userScope] = retrievalScopes(IDENTITY);
            const scopes = retrievalScopes(IDENTITY);

            const none = store.search(m.id, off(0), 5, { scopes });
            const zero = store.search(m.id, off(0), 5, { scopes, reserve: { [userScope]: 0 } });

            // This equivalence is what lets every existing caller and test stay untouched.
            expect(zero.map(h => h.id)).toEqual(none.map(h => h.id));
        });

        test('a reservation never invents a hit — an empty partition contributes nothing', () => {
            const m = store.registerModel('m', 8);
            store.remember({ text: 'scene', vector: off(0), model: 'm', tier: TIER_SCENARIO, ...IDENTITY });
            const [userScope] = retrievalScopes(IDENTITY);

            const hits = store.search(m.id, off(0), 5, {
                scopes: retrievalScopes(IDENTITY),
                reserve: { [userScope]: 2 },
            });

            // A reservation is a ceiling on crowding, never a floor on relevance — it can only promote a row
            // the partition actually returned.
            expect(hits.map(h => h.text)).toEqual(['scene']);
        });
    });

    describe('countUnembedded — making a model change visible instead of silent', () => {
        test('it is ZERO in normal operation, because no write path can skip the vector', () => {
            const m = store.registerModel('m', 8);
            store.remember({ text: 'one', vector: vec(8, 0), model: 'm' });
            store.remember({ text: 'two', vector: vec(8, 1), model: 'm' });

            // The property the whole "trigger, not timer" decision rests on. If this can ever be non-zero
            // without a model change, the repair needs scheduling after all.
            expect(store.countUnembedded(m.id)).toBe(0);
        });

        test('🔴 a model change strands every existing memory, and this is what says so', () => {
            const oldModel = store.registerModel('old', 8);
            store.remember({ text: 'one', vector: vec(8, 0), model: 'old' });
            store.remember({ text: 'two', vector: vec(8, 1), model: 'old' });

            const newModel = store.registerModel('new', 8);

            // The memories still exist and still have their text — they are simply invisible to a search run
            // under the new model. That is the silent failure this count exists to end.
            expect(store.memoryCount()).toBe(2);
            expect(store.countUnembedded(newModel.id)).toBe(2);
            expect(store.countUnembedded(oldModel.id)).toBe(0);
            expect(store.search(newModel.id, vec(8, 0), 10)).toHaveLength(0);
        });

        test('it tracks the repair, and the old model stays searchable throughout', () => {
            const oldModel = store.registerModel('old', 8);
            const id = store.remember({ text: 'one', vector: vec(8, 0), model: 'old' });
            store.remember({ text: 'two', vector: vec(8, 1), model: 'old' });
            const newModel = store.registerModel('new', 8);

            store.addVector(newModel.id, id, vec(8, 0));

            expect(store.countUnembedded(newModel.id)).toBe(1);
            // ⚠️ Nothing was destroyed or overwritten — a re-embed adds a vector in the new model's table and
            // leaves the old one intact, so changing the model back is not a second data loss.
            expect(store.countUnembedded(oldModel.id)).toBe(0);
            expect(store.search(oldModel.id, vec(8, 0), 10)).toHaveLength(2);
        });

        test('an unregistered model is an error, not a silent zero', () => {
            // A zero here would read as "nothing to repair" and is the most dangerous possible wrong answer.
            expect(() => store.countUnembedded(999)).toThrow(/No embedding model registered/);
        });
    });

    test('a memory with no text is refused — it could never be re-embedded', () => {
        expect(() => store.addMemory({ text: '' })).toThrow(/non-empty text/);
    });

    test('a vector of the wrong length is refused', () => {
        const m = store.registerModel('m', 8);
        const id = store.addMemory({ text: 'x' });

        expect(() => store.addVector(m.id, id, vec(4, 0))).toThrow(/8-dimension|got 4/);
    });

    test('a query of the wrong length is refused', () => {
        const m = store.registerModel('m', 8);

        expect(() => store.search(m.id, vec(4, 0), 1)).toThrow(/8-dimension|4-dimension query/);
    });
});

describe('remember — text and vector together, the write-path primitive', () => {
    test('a remembered memory is searchable, and remember returns its id', () => {
        const id = store.remember({ text: 'hello', vector: vec(8, 0), model: 'm' });

        expect(id).toEqual(expect.any(Number));
        const [hit] = store.search(store.registerModel('m', 8).id, vec(8, 0), 1);
        expect(hit.id).toBe(id);
        expect(hit.text).toBe('hello');
    });

    test('it registers the model on first sight, idempotently across memories', () => {
        store.remember({ text: 'one', vector: vec(8, 0), model: 'm' });
        store.remember({ text: 'two', vector: vec(8, 1), model: 'm' });

        expect(/** @type {{ c: number }} */ (present(store.db).prepare('SELECT count(*) c FROM embedding_models').get()).c).toBe(1);
        expect(store.memoryCount()).toBe(2);
    });

    test('it carries source and metadata through, exactly as addMemory does', () => {
        const id = store.remember({ text: 'hi', vector: vec(8, 0), model: 'm', source: 'chat', metadata: { character: 'Ada' } });
        const [hit] = store.search(store.registerModel('m', 8).id, vec(8, 0), 1);

        expect(hit.id).toBe(id);
        expect(hit.source).toBe('chat');
        expect(hit.metadata).toEqual({ character: 'Ada' });
    });

    test('🔴 a vector disagreeing with the model\'s frozen dimension is refused, and stores nothing', () => {
        store.registerModel('m', 8); // freeze m at 8 dimensions

        expect(() => store.remember({ text: 'x', vector: vec(4, 0), model: 'm' }))
            .toThrow(/dimension cannot change|registered with dimension 8/i);
        // The refusal lands before any write — no orphan memory row left behind.
        expect(store.memoryCount()).toBe(0);
    });

    test('an empty or non-array vector is refused, and stores nothing', () => {
        expect(() => store.remember({ text: 'x', vector: [], model: 'm' })).toThrow(/non-empty vector/);
        expect(() => store.remember({ text: 'x', vector: wrongType('nope'), model: 'm' })).toThrow(/requires a vector/);
        expect(store.memoryCount()).toBe(0);
    });

    test('a closed store says so, rather than throwing on a null db', () => {
        store.close();
        expect(() => store.remember({ text: 'x', vector: vec(8, 0), model: 'm' })).toThrow(/not open|locked/i);
        store = new MemoryStore(path.join(dir, 'memory.db')).open(dbKey);
    });
});

describe('listing and deleting — the management surface', () => {
    test('listMemories returns newest first, with source and metadata parsed back', () => {
        store.remember({ text: 'first', vector: vec(8, 0), model: 'm', source: 'chat', metadata: { turn: 1 } });
        store.remember({ text: 'second', vector: vec(8, 1), model: 'm' });

        const list = store.listMemories();

        // created_at ties within a test; the id DESC tiebreak keeps newest-first deterministic.
        expect(list.map(m => m.text)).toEqual(['second', 'first']);
        expect(list[1].source).toBe('chat');
        expect(list[1].metadata).toEqual({ turn: 1 });
        expect(list[0].metadata).toBeNull();
    });

    test('listMemories paginates with limit and offset', () => {
        for (let i = 0; i < 5; i++) store.remember({ text: `m${i}`, vector: vec(8, i % 8), model: 'm' });

        expect(store.listMemories({ limit: 2 })).toHaveLength(2);
        expect(store.listMemories({ limit: 2, offset: 4 })).toHaveLength(1);
    });

    test('deleteMemory removes the memory and its vectors across EVERY model', () => {
        const a = store.registerModel('model-a', 8);
        const b = store.registerModel('model-b', 8);
        const id = store.addMemory({ text: 'gone soon' });
        store.addVector(a.id, id, vec(8, 0));
        store.addVector(b.id, id, vec(8, 1));

        expect(store.deleteMemory(id)).toBe(true);
        expect(store.memoryCount()).toBe(0);

        // No dangling index survives in either model's table.
        expect(store.search(a.id, vec(8, 0), 5)).toHaveLength(0);
        expect(store.search(b.id, vec(8, 1), 5)).toHaveLength(0);
    });

    test('deleting a memory that is not there is false, not an error', () => {
        expect(store.deleteMemory(999)).toBe(false);
    });

    test('a closed store refuses to list or delete', () => {
        store.close();
        expect(() => store.listMemories()).toThrow(/not open|locked/i);
        expect(() => store.deleteMemory(1)).toThrow(/not open|locked/i);
        store = new MemoryStore(path.join(dir, 'memory.db')).open(dbKey);
    });
});

describe('🔴 two models never mix — the reason this schema exists', () => {
    test('two models of the SAME dimension keep entirely separate spaces', () => {
        // The dangerous case. Different dimensions are caught by vec0 itself; two 8-dimension models would
        // happily share a table and return arithmetically valid nonsense for ever.
        const a = store.registerModel('model-a', 8);
        const b = store.registerModel('model-b', 8);

        const id = store.addMemory({ text: 'the cat jumped over the lazy dog' });
        store.addVector(a.id, id, vec(8, 0));

        expect(store.search(a.id, vec(8, 0), 5)).toHaveLength(1);

        // Model B has never embedded anything. It must find NOTHING — not model A's vector.
        expect(store.search(b.id, vec(8, 0), 5)).toHaveLength(0);
    });

    test('the same memory can hold a vector in each model, and each search finds its own', () => {
        const a = store.registerModel('model-a', 8);
        const b = store.registerModel('model-b', 8);
        const id = store.addMemory({ text: 'shared' });

        store.addVector(a.id, id, vec(8, 0));
        store.addVector(b.id, id, vec(8, 7));

        // Same memory, different coordinates in each space. Both point back to the one text.
        expect(store.search(a.id, vec(8, 0), 1)[0].text).toBe('shared');
        expect(store.search(b.id, vec(8, 7), 1)[0].text).toBe('shared');
        expect(/** @type {{ c: number }} */ (present(store.db).prepare('SELECT count(*) c FROM memories').get()).c).toBe(1);
    });

    test('searching an unregistered model is an error, not an empty result', () => {
        expect(() => store.search(999, vec(8, 0), 1)).toThrow(/No embedding model registered/);
    });
});

describe('re-embedding — why a model change is a background job, not data loss', () => {
    test('a new model reports every existing memory as work to do', () => {
        const a = store.registerModel('model-a', 8);
        const ids = ['one', 'two', 'three'].map(text => store.addMemory({ text }));
        ids.forEach(id => store.addVector(a.id, id, vec(8, 0)));

        const b = store.registerModel('model-b', 384);

        expect(store.unembedded(a.id)).toHaveLength(0);
        expect(store.unembedded(b.id).map(r => r.text)).toEqual(['one', 'two', 'three']);
    });

    test('🔴 the text survives a model change, so the vectors can be rebuilt from it', () => {
        const a = store.registerModel('old', 8);
        const id = store.addMemory({ text: 'the cat jumped over the lazy dog' });
        store.addVector(a.id, id, vec(8, 0));

        // The user switches embedding model. Nothing is deleted.
        const b = store.registerModel('new', 16);
        const [work] = store.unembedded(b.id);

        expect(work.text).toBe('the cat jumped over the lazy dog');

        // Re-embed from that text, and the memory is searchable in the new space.
        store.addVector(b.id, work.id, vec(16, 3));

        expect(store.search(b.id, vec(16, 3), 1)[0].text).toBe('the cat jumped over the lazy dog');
        expect(store.unembedded(b.id)).toHaveLength(0);

        // And the old space still works — switching back is free.
        expect(store.search(a.id, vec(8, 0), 1)[0].text).toBe('the cat jumped over the lazy dog');
    });

    test('unembedded batches', () => {
        const m = store.registerModel('m', 8);
        for (let i = 0; i < 10; i++) store.addMemory({ text: `m${i}` });

        expect(store.unembedded(m.id, 3)).toHaveLength(3);
    });
});

describe('schema v2 — the shape the retirement + ingest features need', () => {
    test('the memories table carries the retirement columns', () => {
        const cols = /** @type {{ name: string }[]} */ (present(store.db).prepare('PRAGMA table_info(memories)').all()).map(c => c.name);
        expect(cols).toEqual(expect.arrayContaining(['retired', 'superseded_by']));
    });

    test('the ingest_state table exists', () => {
        const table = present(store.db).prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'ingest_state');
        expect(table).toBeTruthy();
    });
});

/**
 * 🔴 SCHEMA v5 — THE STRING THAT IS EMBEDDED IS NOT THE STRING THAT IS INJECTED
 *
 * `text` is the memory: the paragraph a future conversation reads. `index_line` is the distillation the
 * vector is built from. The whole point is that they can differ, and the failure mode of getting it wrong is
 * silent — the memory stores, reads back correctly, and simply stops being retrieved.
 */
describe('schema v5 — the index line is stored beside the memory, not instead of it', () => {
    test('both fields round-trip, and the index line is not the text', () => {
        const id = store.remember({
            text: 'Test Character 8 taught Test User escapements on a Sample Town 3 regulator he carried out of Sample Region in 1948.',
            indexLine: 'Test Character 8, escapements, the Sample Town 3 regulator, Sample Region 1948',
            vector: vec(8, 0), model: 'm',
        });

        const row = present(store.getMemory(id));
        expect(row.text).toContain('Test Character 8 taught Test User escapements');
        expect(row.indexLine).toBe('Test Character 8, escapements, the Sample Town 3 regulator, Sample Region 1948');
    });

    /**
     * ⚠️ The default is `''` and deliberately NOT a copy of the text: copying would make "has no distillation"
     * indistinguishable from "was distilled to exactly itself", and `embedText` could no longer tell a
     * hand-written memory from an extracted one.
     */
    test('a memory written without one has an empty index line, and embeds its own text', () => {
        const id = store.remember({ text: 'Test User prefers short scenes.', vector: vec(8, 0), model: 'm' });
        const row = present(store.getMemory(id));

        expect(row.indexLine).toBe('');
        expect(embedText(row)).toBe('Test User prefers short scenes.');
    });

    test('embedText prefers the index line, and falls back on blank or whitespace', () => {
        expect(embedText({ indexLine: 'the subjects', text: 'the paragraph' })).toBe('the subjects');
        expect(embedText({ indexLine: '', text: 'the paragraph' })).toBe('the paragraph');
        expect(embedText({ indexLine: '   ', text: 'the paragraph' })).toBe('the paragraph');
        expect(embedText({ indexLine: null, text: 'the paragraph' })).toBe('the paragraph');
        expect(embedText({ text: 'the paragraph' })).toBe('the paragraph');
    });

    /**
     * 🔴 ABSENT MEANS KEEP. A caller that predates v5 sends `{ text }` and means "fix this wording", never
     * "throw away the line that makes this memory findable" — and nothing would report that loss: the row
     * still reads correctly and simply stops being retrieved.
     */
    test('reviseMemory INHERITS the index line when none is supplied', () => {
        const id = store.remember({
            text: 'Test Character 1 works at the forge.', indexLine: 'Test Character 1, the forge, her work',
            vector: vec(8, 0), model: 'm',
        });

        const newId = present(store.reviseMemory({ memoryId: id, text: 'Test Character 1 works at the forge in Sample Town 2.', vector: vec(8, 0), model: 'm' }));

        expect(present(store.getMemory(newId)).indexLine).toBe('Test Character 1, the forge, her work');
    });

    test('...and REPLACES it when one is, including with an empty string to clear it', () => {
        const id = store.remember({ text: 'Test Character 1 works at the forge.', indexLine: 'Test Character 1, the forge', vector: vec(8, 0), model: 'm' });

        const revised = present(store.reviseMemory({ memoryId: id, text: 'Test Character 1 works at the forge.', indexLine: 'Test Character 1, the forge in Sample Town 2', vector: vec(8, 0), model: 'm' }));
        expect(present(store.getMemory(revised)).indexLine).toBe('Test Character 1, the forge in Sample Town 2');

        const cleared = present(store.reviseMemory({ memoryId: revised, text: 'Test Character 1 works at the forge.', indexLine: '', vector: vec(8, 0), model: 'm' }));
        expect(present(store.getMemory(cleared)).indexLine).toBe('');
    });

    /**
     * ⚠️ A re-embed that fed the paragraph while the original write fed the index line would put the same
     * memory at two different points depending on which path last touched it — one database, two rules.
     */
    test('the re-embed worklist carries both fields, so a repair embeds what a fresh write would have', () => {
        store.remember({ text: 'the paragraph, at length', indexLine: 'the subjects', vector: vec(8, 0), model: 'm' });
        const other = store.registerModel('other-model', 8);

        const [pending] = store.unembedded(other.id, 10);

        expect(pending.text).toBe('the paragraph, at length');
        expect(pending.indexLine).toBe('the subjects');
        expect(embedText(pending)).toBe('the subjects');
    });

    test('the memories table carries index_line, NOT NULL and defaulting to the empty string', () => {
        const col = /** @type {{ name: string, notnull: number, dflt_value: string }[]} */ (
            present(store.db).prepare('PRAGMA table_info(memories)').all()
        ).find(c => c.name === 'index_line');

        expect(col).toBeTruthy();
        expect(present(col).notnull).toBe(1);
        expect(present(col).dflt_value).toBe('\'\'');
        expect(SCHEMA_VERSION).toBe(6);
    });
});

describe('schema v4 — identity is ids, and the partition key is composed from them', () => {
    test('the memories table carries the identity columns, each defaulting to the empty string', () => {
        const cols = /** @type {{ name: string, notnull: number }[]} */ (present(store.db).prepare('PRAGMA table_info(memories)').all());

        for (const name of ['tier', 'char_id', 'persona_id', 'chat_id', 'char_name', 'scope']) {
            const col = cols.find(c => c.name === name);
            expect(col).toBeDefined();
            expect(present(col).notnull).toBe(1);
        }

        // 🔴 And the name is GONE. If this column ever comes back, something has started keying on a display
        // name again — the exact bug v4 exists to end.
        expect(cols.find(c => c.name === 'character')).toBeUndefined();
    });

    test('an identity nobody supplied is stored as empty strings, never null', () => {
        const id = store.addMemory({ text: 'nothing named' });
        const row = present(store.listMemories({}).find(m => m.id === id));

        expect(row.charId).toBe('');
        expect(row.personaId).toBe('');
        expect(row.chatId).toBe('');
        expect(row.charName).toBe('');
        expect(row.tier).toBe(TIER_SCENARIO);          // the conservative default: stays in its own chat
    });

    test('the vector table declares scope as a partition key and retired as a metadata column', () => {
        const m = store.registerModel('m', 8);
        const ddl = /** @type {{ sql: string }} */ (present(store.db).prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(vectorTableName(m.id))).sql;

        expect(ddl).toMatch(/scope\s+TEXT\s+PARTITION KEY/i);
        expect(ddl).toMatch(/retired\s+INTEGER/i);
    });

    test('scopeKey composes each tier from the axes that key it, and ignores the ones that do not', () => {
        expect(scopeKey({ tier: TIER_USER, charId: 'c1', personaId: 'p1', chatId: 'IGNORED' })).toBe('u:c1:p1');
        expect(scopeKey({ tier: TIER_SCENARIO, chatId: 'chat-7', charId: 'IGNORED' })).toBe('s:chat-7');
    });

    test('a missing axis is the empty string — a real partition, not a wildcard', () => {
        expect(scopeKey({ tier: TIER_USER })).toBe('u::');
        expect(scopeKey({ tier: TIER_SCENARIO })).toBe('s:');
        expect(scopeKey({ tier: TIER_USER, charId: 'c1' })).toBe('u:c1:');
    });

    test('🔴 scopeKey is injective — two identities can never compose to one partition', () => {
        // Without escaping, charId 'a:b' + persona 'c' and charId 'a' + persona 'b:c' both spell "u:a:b:c",
        // and two different people share one memory partition. That is the v3 bug arriving by another door.
        expect(scopeKey({ tier: TIER_USER, charId: 'a:b', personaId: 'c' }))
            .not.toBe(scopeKey({ tier: TIER_USER, charId: 'a', personaId: 'b:c' }));

        // The escape character itself must escape, or 'a%3Ab' and 'a:b' collide.
        expect(scopeKey({ tier: TIER_USER, charId: 'a%3Ab', personaId: '' }))
            .not.toBe(scopeKey({ tier: TIER_USER, charId: 'a:b', personaId: '' }));
    });

    test('🔴 a tier nobody stated is refused, never guessed', () => {
        // Guessing 'user' promotes a scene into every future conversation; guessing 'scenario' buries a durable
        // fact in one chat. Neither is recoverable by the user, so neither is available to the code.
        expect(() => scopeKey({ tier: wrongType(undefined) })).toThrow(/requires tier/);
        expect(() => scopeKey({ tier: 'whatever' })).toThrow(/requires tier/);
        expect(() => store.addMemory({ text: 'x', tier: 'nonsense' })).toThrow(/requires tier/);
    });

    test('retrievalScopes asks for both tiers, user first', () => {
        expect(retrievalScopes({ charId: 'c1', personaId: 'p1', chatId: 'chat-7' }))
            .toEqual(['u:c1:p1', 's:chat-7']);
        expect(retrievalScopes()).toEqual(['u::', 's:']);
    });
});

describe('🔴 two-tier scoping — the filter that runs before k (FR3)', () => {
    const ELARA = { charId: 'char-test-1', personaId: 'test-user.png', chatId: 'chat-1', charName: 'Test Character 1' };
    const MARCUS = { charId: 'char-test-2', personaId: 'test-user.png', chatId: 'chat-2', charName: 'Test Character 2' };

    /**
     * Plant `n` memories in one tier of one identity, clustered around `lean`, nearest first.
     *
     * @param {{ charId: string, personaId: string, chatId: string, charName: string }} identity
     * @param {string} tier
     * @param {number} n How many
     * @param {number} lean Which axis they cluster on
     * @param {string} label Text prefix, so a hit says which fixture it came from
     * @returns {void}
     */
    const plant = (identity, tier, n, lean, label) => {
        for (let i = 0; i < n; i++) {
            const v = vec(8, lean);
            v[7 - lean] += i * 0.01;                    // fan them out slightly, preserving order
            store.remember({ text: `${label}-${i}`, vector: v, model: 'm', tier, ...identity });
        }
    };

    test('a scoped search returns only that partition, and an unscoped one returns everything', () => {
        plant(ELARA, TIER_USER, 3, 0, 'test-character-1');
        plant(MARCUS, TIER_USER, 3, 0, 'test-character-2');
        const m = store.registerModel('m', 8).id;

        const scoped = store.search(m, vec(8, 0), 10, { scopes: [scopeKey({ tier: TIER_USER, ...ELARA })] });
        expect(scoped).toHaveLength(3);
        expect(scoped.every(h => h.text.startsWith('test-character-1'))).toBe(true);

        expect(store.search(m, vec(8, 0), 10)).toHaveLength(6);
    });

    test('🔴 THE POINT: a crowded pool cannot squeeze out a character with few memories', () => {
        // 200 of Test Character 1's memories sit NEARER the query than any of Test Character 2's three. Under a post-hoc filter —
        // top-k first, discard the wrong character after — Test Character 2 returns ZERO no matter how large the margin,
        // because k rows are chosen before anything knows whose they are. As a vec0 partition key the filter
        // runs first, so k applies to Test Character 2's three and all three come back.
        plant(ELARA, TIER_USER, 200, 0, 'test-character-1');
        plant(MARCUS, TIER_USER, 3, 7, 'test-character-2');
        const m = store.registerModel('m', 8).id;

        const hits = store.search(m, vec(8, 0), 5, { scopes: [scopeKey({ tier: TIER_USER, ...MARCUS })] });

        expect(hits).toHaveLength(3);
        expect(hits.every(h => h.text.startsWith('test-character-2'))).toBe(true);
    });

    test('🔴 a user-tier memory crosses chats — the reason the plugin exists', () => {
        // Learned in chat-1, recalled in chat-99: the character remembers the person, not the conversation.
        store.remember({ text: 'Test User is afraid of heights', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        const m = store.registerModel('m', 8).id;

        const laterChat = { ...ELARA, chatId: 'chat-99' };
        const hits = store.search(m, vec(8, 0), 5, { scopes: retrievalScopes(laterChat) });

        expect(hits.map(h => h.text)).toEqual(['Test User is afraid of heights']);
    });

    test('🔴 a scenario memory does NOT cross chats — the ancient-Egypt-and-space case', () => {
        // Same character, two stories. What happened in Sample City 4 must not follow her into orbit.
        store.remember({ text: 'we stole the scarab in Sample City 4', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });
        const m = store.registerModel('m', 8).id;

        expect(store.search(m, vec(8, 0), 5, { scopes: retrievalScopes(ELARA) })).toHaveLength(1);
        expect(store.search(m, vec(8, 0), 5, { scopes: retrievalScopes({ ...ELARA, chatId: 'chat-space' }) })).toHaveLength(0);
    });

    test('🔴 a user-tier memory does NOT cross personas — this one is confidentiality, not relevance', () => {
        // Two personas can share a character while representing different users. Memories must not cross between them.
        store.remember({ text: 'Test User is afraid of heights', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        const m = store.registerModel('m', 8).id;

        const asMitchell = { ...ELARA, personaId: 'test-character-13.png' };
        expect(store.search(m, vec(8, 0), 5, { scopes: retrievalScopes(asMitchell) })).toHaveLength(0);
    });

    test('🔴 a rename cannot orphan a memory — the whole point of keying on an id', () => {
        // The v3 bug, as a test. `charName` changes; `charId` does not; the memory is still there.
        store.remember({ text: 'she trusts Test User now', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        const m = store.registerModel('m', 8).id;

        const renamed = { ...ELARA, charName: 'Renamed Test Character 1' };
        expect(store.search(m, vec(8, 0), 5, { scopes: retrievalScopes(renamed) })).toHaveLength(1);
    });

    test('🔴 two characters sharing a display name stay separate — the write bug, not just the read one', () => {
        // Under v3 these collapsed into one partition, so one Test Character 1 could supersede the other Test Character 1's memories.
        const other = { charId: 'char-other', personaId: 'test-user.png', chatId: 'chat-3', charName: 'Test Character 1' };
        store.remember({ text: 'the first one', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        store.remember({ text: 'the second one', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...other });
        const m = store.registerModel('m', 8).id;

        expect(store.search(m, vec(8, 0), 5, { scopes: retrievalScopes(ELARA) }).map(h => h.text)).toEqual(['the first one']);
        expect(store.search(m, vec(8, 0), 5, { scopes: retrievalScopes(other) }).map(h => h.text)).toEqual(['the second one']);
    });

    test('retrieval merges both tiers and returns the k nearest overall', () => {
        // Two partitions searched separately, one answer. The merge must rank across them rather than
        // concatenating — a scenario hit nearer than a user hit has to come first.
        store.remember({ text: 'user-far', vector: vec(8, 7), model: 'm', tier: TIER_USER, ...ELARA });
        store.remember({ text: 'scenario-near', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });
        const m = store.registerModel('m', 8).id;

        expect(store.search(m, vec(8, 0), 5, { scopes: retrievalScopes(ELARA) }).map(h => h.text))
            .toEqual(['scenario-near', 'user-far']);
    });

    test('🔴 the merged result honors k — two partitions do not quietly return 2k', () => {
        plant(ELARA, TIER_USER, 5, 0, 'user');
        plant(ELARA, TIER_SCENARIO, 5, 0, 'scenario');
        const m = store.registerModel('m', 8).id;

        expect(store.search(m, vec(8, 0), 3, { scopes: retrievalScopes(ELARA) })).toHaveLength(3);
    });

    test('each hit says which tier it came from, so a broken axis is visible', () => {
        store.remember({ text: 'about you', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        const m = store.registerModel('m', 8).id;

        const [hit] = store.search(m, vec(8, 0), 5, { scopes: retrievalScopes(ELARA) });
        expect(hit.tier).toBe(TIER_USER);
        expect(hit.charName).toBe('Test Character 1');
        expect(hit.scope).toBe('u:char-test-1:test-user.png');
    });

    test('🔴 and the same for retirement: many nearer retired rows cannot squeeze out the live ones', () => {
        // This is what replaced the over-fetch margin. 60 retired rows nearer than the live ones is three times
        // the margin the old code allowed (k*2+10 = 20 at k=5), so this fails outright against a post-hoc filter.
        const retired = [];
        for (let i = 0; i < 60; i++) {
            const v = vec(8, 0);
            v[7] += i * 0.001;
            retired.push(store.remember({ text: `retired-${i}`, vector: v, model: 'm' }));
        }
        store.remember({ text: 'live-a', vector: vec(8, 7), model: 'm' });
        store.remember({ text: 'live-b', vector: vec(8, 6), model: 'm' });
        for (const id of retired) store.retireMemory(id);

        const hits = store.search(store.registerModel('m', 8).id, vec(8, 0), 5);

        expect(hits.map(h => h.text).sort()).toEqual(['live-a', 'live-b']);
    });

    test('an empty identity is a real scope — the memories belonging to nobody, not a wildcard', () => {
        store.remember({ text: 'orphan', vector: vec(8, 0), model: 'm', tier: TIER_USER });
        store.remember({ text: 'hers', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        const m = store.registerModel('m', 8).id;

        expect(store.search(m, vec(8, 0), 10, { scopes: ['u::'] }).map(h => h.text)).toEqual(['orphan']);
        expect(store.search(m, vec(8, 0), 10, { scopes: null })).toHaveLength(2);   // null → unscoped
        expect(store.search(m, vec(8, 0), 10)).toHaveLength(2);                     // omitted → unscoped
    });

    test('retiring a memory hides it from a scoped search too — the flag reaches every vector table', () => {
        const id = store.remember({ text: 'hers', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        const m = store.registerModel('m', 8).id;

        expect(store.search(m, vec(8, 0), 10, { scopes: retrievalScopes(ELARA) })).toHaveLength(1);
        store.retireMemory(id);
        expect(store.search(m, vec(8, 0), 10, { scopes: retrievalScopes(ELARA) })).toHaveLength(0);
    });

    test('listMemories scopes the same way, and is unscoped by default', () => {
        store.addMemory({ text: 'hers', tier: TIER_USER, ...ELARA });
        store.addMemory({ text: 'his', tier: TIER_USER, ...MARCUS });
        store.addMemory({ text: 'the scene', tier: TIER_SCENARIO, ...ELARA });

        expect(store.listMemories({}).map(m => m.text).sort()).toEqual(['hers', 'his', 'the scene']);
        expect(store.listMemories({ scopes: [scopeKey({ tier: TIER_USER, ...ELARA })] }).map(m => m.text)).toEqual(['hers']);
        expect(store.listMemories({ scopes: retrievalScopes(ELARA) }).map(m => m.text).sort()).toEqual(['hers', 'the scene']);
    });

    test('listMemories with an empty scope list is an empty answer, not the whole store', () => {
        store.addMemory({ text: 'hers', tier: TIER_USER, ...ELARA });

        expect(store.listMemories({ scopes: [] })).toEqual([]);
    });
});

describe('forgetChat — making "dies with the chat" true rather than aspirational', () => {
    const ELARA = { charId: 'char-test-1', personaId: 'test-user.png', chatId: 'chat-1', charName: 'Test Character 1' };

    test('it deletes the chat\'s scenario memories and their vectors', () => {
        store.remember({ text: 'the scene', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });
        const m = store.registerModel('m', 8).id;

        expect(store.forgetChat('chat-1')).toBe(1);
        expect(store.memoryCount()).toBe(0);
        expect(store.search(m, vec(8, 0), 5)).toHaveLength(0);   // no dangling vector left behind
    });

    test('🔴 it leaves user-tier memories alone, even though they carry the same chat_id', () => {
        // A user-tier fact can be learned in a chat without being about that chat.
        store.remember({ text: 'Test User is afraid of heights', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        store.remember({ text: 'we stole the scarab', vector: vec(8, 1), model: 'm', tier: TIER_SCENARIO, ...ELARA });

        expect(store.forgetChat('chat-1')).toBe(1);
        expect(store.listMemories({}).map(m => m.text)).toEqual(['Test User is afraid of heights']);
    });

    test('it takes the high-water mark with it, so a reused chat id does not start life already extracted', () => {
        store.setIngestState('chat-1', { highWater: 40, lastRun: 1000 });

        store.forgetChat('chat-1');

        expect(store.getIngestState('chat-1')).toBeNull();
    });

    test('forgetting a chat with no memories is zero, not an error', () => {
        expect(store.forgetChat('never-existed')).toBe(0);
    });

    test('🔴 an EMPTY chat id is refused, because it names a real partition rather than no partition', () => {
        // The test above is about a WRONG id, which matches nothing and correctly reports zero. An empty id
        // is a different animal: `scopeKey({tier: 'scenario', chatId: ''})` composes `'s:'`, and `''` is a
        // deliberate, distinct partition component meaning "no chat" (schema.js `part`) - which is exactly
        // where every scenario memory written by a generation carrying no `chatId` has always been filed.
        // `OutgoingPrompt.chatId` is optional, so that partition is populated on any install whose client
        // does not send one.
        store.remember({
            text: 'written by a generation that carried no chat id',
            vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, charId: 'char-test-1', personaId: 'test-user.png',
        });
        expect(store.memoryCount()).toBe(1);

        // It used to delete that whole partition and return a plausible non-zero count, which
        // `forgetChatFor` then logged as an ordinary success. `rekeyChat` has refused the same input since
        // it was written; the guard only ever got added to one of the two.
        expect(() => store.forgetChat('')).toThrow(TypeError);
        expect(() => store.forgetChat(wrongType(null))).toThrow(TypeError);
        expect(() => store.forgetChat(wrongType(undefined))).toThrow(TypeError);

        // 🔴 And nothing was taken on the way out. A refused delete leaves rows an operator can still
        // remove; a wrong delete leaves nothing to recover.
        expect(store.memoryCount()).toBe(1);
    });
});

describe('rekeyChat — a rename must move memories, never destroy them', () => {
    const ELARA = { charId: 'char-test-1', personaId: 'test-user.png', chatId: 'chat-1', charName: 'Test Character 1' };
    const before = [scopeKey({ tier: TIER_SCENARIO, chatId: 'chat-1' })];
    const after = [scopeKey({ tier: TIER_SCENARIO, chatId: 'chat-2' })];

    test('🔴 the memories SURVIVE and become searchable under the new id', () => {
        // The whole point. The failure this replaces is silent: the rows stay perfect and unreachable, on a
        // conversation the user is still in the middle of.
        store.remember({ text: 'we stole the scarab', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });
        const m = store.registerModel('m', 8).id;

        expect(store.rekeyChat('chat-1', 'chat-2')).toBe(1);

        expect(store.memoryCount()).toBe(1);                                        // nothing destroyed
        expect(store.search(m, vec(8, 0), 5, { scopes: after }).map(h => h.id)).toHaveLength(1);
        expect(store.search(m, vec(8, 0), 5, { scopes: before })).toHaveLength(0);   // and gone from the old one
    });

    test('the vector moves partition intact — same embedding, not a re-embed', () => {
        // 🔴 vec0 rejects UPDATE on a partition key, so this is a read/DELETE/INSERT. If the blob were mangled
        // in the round trip the memory would still be "found", just at the wrong distance — silently worse
        // recall rather than an error. Compare the actual distance against an untouched control.
        const m = store.registerModel('m', 8).id;
        store.remember({ text: 'moved', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });
        store.remember({ text: 'control', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA, chatId: 'chat-9' });

        const controlDistance = store.search(m, vec(8, 0), 1, { scopes: [scopeKey({ tier: TIER_SCENARIO, chatId: 'chat-9' })] })[0].distance;
        store.rekeyChat('chat-1', 'chat-2');
        const movedDistance = store.search(m, vec(8, 0), 1, { scopes: after })[0].distance;

        expect(movedDistance).toBeCloseTo(controlDistance, 6);
    });

    test('🔴 user-tier memories keep their partition — a rename is not a re-scoping of anything durable', () => {
        // They carry the same chat_id but key on (charId, personaId). Moving them would be the mirror of the
        // forgetChat bug: quietly relocating facts about the user because a chat got a new name.
        const m = store.registerModel('m', 8).id;
        store.remember({ text: 'Test User is afraid of heights', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });

        store.rekeyChat('chat-1', 'chat-2');

        const hers = [scopeKey({ tier: TIER_USER, ...ELARA })];
        expect(store.search(m, vec(8, 0), 5, { scopes: hers }).map(h => h.id)).toHaveLength(1);
        expect(store.listMemories({ scopes: hers })[0].scope).toBe(scopeKey({ tier: TIER_USER, ...ELARA }));
    });

    test('chat_id follows on every tier, because it is provenance and the chat still exists', () => {
        store.addMemory({ text: 'hers', tier: TIER_USER, ...ELARA });
        store.addMemory({ text: 'the scene', tier: TIER_SCENARIO, ...ELARA });

        store.rekeyChat('chat-1', 'chat-2');

        expect(store.listMemories({}).map(m => m.chatId)).toEqual(['chat-2', 'chat-2']);
    });

    test('the high-water mark travels, so the renamed chat is not re-extracted from scratch', () => {
        // The reverse of forgetChat, which discards it. Same messages, same chat — only the name changed.
        store.setIngestState('chat-1', { highWater: 40, lastRun: 1000 });

        store.rekeyChat('chat-1', 'chat-2');

        expect(store.getIngestState('chat-1')).toBeNull();
        expect(store.getIngestState('chat-2')).toMatchObject({ highWater: 40, lastRun: 1000 });
    });

    test('a stale mark already sitting on the NEW id is replaced, not collided with', () => {
        // chat_key is the PRIMARY KEY: without the pre-delete this raises UNIQUE and takes the rename down.
        store.setIngestState('chat-1', { highWater: 40, lastRun: 1000 });
        store.setIngestState('chat-2', { highWater: 5, lastRun: 1 });

        expect(() => store.rekeyChat('chat-1', 'chat-2')).not.toThrow();
        expect(store.getIngestState('chat-2')).toMatchObject({ highWater: 40, lastRun: 1000 });
    });

    test('a memory awaiting re-embedding re-keys fine — a missing vector is not an error', () => {
        // The one half-written state the schema tolerates (see unembedded). It must not abort the rename.
        store.registerModel('m', 8);
        const id = store.addMemory({ text: 'no vector yet', tier: TIER_SCENARIO, ...ELARA });

        expect(store.rekeyChat('chat-1', 'chat-2')).toBe(1);
        expect(store.unembedded(store.registerModel('m', 8).id).map(r => r.id)).toEqual([id]);
    });

    test('vectors move in EVERY model\'s table, not just the first', () => {
        const a = store.registerModel('a', 8).id;
        const b = store.registerModel('b', 8).id;
        const id = store.addMemory({ text: 'two models', tier: TIER_SCENARIO, ...ELARA });
        store.addVector(a, id, vec(8, 0));
        store.addVector(b, id, vec(8, 0));

        store.rekeyChat('chat-1', 'chat-2');

        expect(store.search(a, vec(8, 0), 5, { scopes: after }).map(h => h.id)).toEqual([id]);
        expect(store.search(b, vec(8, 0), 5, { scopes: after }).map(h => h.id)).toEqual([id]);
    });

    test('a retired memory stays retired across the move', () => {
        // `retired` is a vec0 metadata column carried by hand through the delete/insert. Dropping it would
        // silently resurrect superseded memories into search results.
        const m = store.registerModel('m', 8).id;
        const id = store.remember({ text: 'no longer true', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });
        store.retireMemory(id);

        store.rekeyChat('chat-1', 'chat-2');

        expect(store.search(m, vec(8, 0), 5, { scopes: after })).toHaveLength(0);
        expect(store.listMemories({ scopes: after, includeRetired: true }).map(r => r.id)).toEqual([id]);
    });

    test('another chat\'s memories are untouched', () => {
        const m = store.registerModel('m', 8).id;
        store.remember({ text: 'ours', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });
        store.remember({ text: 'theirs', vector: vec(8, 1), model: 'm', tier: TIER_SCENARIO, ...ELARA, chatId: 'chat-other' });

        store.rekeyChat('chat-1', 'chat-2');

        const others = [scopeKey({ tier: TIER_SCENARIO, chatId: 'chat-other' })];
        expect(store.search(m, vec(8, 1), 5, { scopes: others })).toHaveLength(1);
    });

    test('renaming a chat with no memories is zero, not an error', () => {
        expect(store.rekeyChat('never-existed', 'still-does-not')).toBe(0);
    });

    test('a self-rename is refused as a no-op rather than round-tripping a partition onto itself', () => {
        // The fork guarantees it never fires. If it ever did, the delete-then-insert has nowhere to go.
        const m = store.registerModel('m', 8).id;
        store.remember({ text: 'unchanged', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });

        expect(store.rekeyChat('chat-1', 'chat-1')).toBe(0);
        expect(store.search(m, vec(8, 0), 5, { scopes: before })).toHaveLength(1);
    });

    test('an empty or non-string id is refused loudly, not treated as the "" partition', () => {
        expect(() => store.rekeyChat('', 'chat-2')).toThrow(/two non-empty chat ids/);
        expect(() => store.rekeyChat('chat-1', wrongType(null))).toThrow(/two non-empty chat ids/);
    });
});

describe('🔴 the vec0 write rules a partitioned table imposes', () => {
    const ELARA = { charId: 'char-test-1', personaId: 'test-user.png', chatId: 'chat-1', charName: 'Test Character 1' };
    const hers = [scopeKey({ tier: TIER_USER, ...ELARA })];

    test('addVector reads the partition value from the memory, so a re-embed cannot land in the wrong one', () => {
        const m = store.registerModel('m', 8).id;
        const id = store.addMemory({ text: 'hers', tier: TIER_USER, ...ELARA });

        // The caller never says which partition — that would be a second source of truth, free to disagree.
        store.addVector(m, id, vec(8, 0));

        expect(store.search(m, vec(8, 0), 10, { scopes: hers }).map(h => h.id)).toEqual([id]);
        expect(store.search(m, vec(8, 0), 10, { scopes: ['u::'] })).toHaveLength(0);
    });

    test('re-embedding the same memory replaces its vector rather than colliding or duplicating', () => {
        // 🔴 INSERT OR REPLACE raises UNIQUE on a partitioned vec0 table; addVector must DELETE-then-INSERT.
        // A regression here throws "UNIQUE constraint failed" — or, worse, silently doubles the row.
        const m = store.registerModel('m', 8).id;
        const id = store.addMemory({ text: 'hers', tier: TIER_USER, ...ELARA });

        store.addVector(m, id, vec(8, 0));
        expect(() => store.addVector(m, id, vec(8, 7))).not.toThrow();

        const hits = store.search(m, vec(8, 7), 10, { scopes: hers });
        expect(hits).toHaveLength(1);                      // one row, not two
        expect(hits[0].id).toBe(id);
        expect(store.search(m, vec(8, 7), 1, { scopes: hers })[0].distance)
            .toBeLessThan(store.search(m, vec(8, 0), 1, { scopes: hers })[0].distance);
    });

    test('a vector for a memory that does not exist is refused', () => {
        const m = store.registerModel('m', 8).id;
        expect(() => store.addVector(m, 123456, vec(8, 0))).toThrow(/no memory with id/i);
    });

    test('retiring propagates as a BigInt-bound metadata update, not a silent no-op', () => {
        const m = store.registerModel('m', 8).id;
        const id = store.remember({ text: 'once true', vector: vec(8, 0), model: 'm' });

        store.retireMemory(id);

        const row = /** @type {{ retired: number|bigint }} */ (present(store.db).prepare(`SELECT retired FROM ${vectorTableName(m)} WHERE rowid = ?`).get(BigInt(id)));
        expect(Number(row.retired)).toBe(1);
    });
});

describe('retirement — supersede without destroying (DESIGN_INGEST §5.3)', () => {
    test('a retired memory drops out of search, and search still returns k live results past it', () => {
        const near = store.remember({ text: 'near', vector: vec(8, 0), model: 'm' });
        store.remember({ text: 'mid', vector: vec(8, 1), model: 'm' });
        store.remember({ text: 'far', vector: vec(8, 2), model: 'm' });
        const modelId = store.registerModel('m', 8).id;

        expect(store.search(modelId, vec(8, 0), 1)[0].text).toBe('near');

        store.retireMemory(near);

        // 'near' was the top hit; retiring it must not shrink the result below k. `retired` is a vec0 metadata
        // column filtered BEFORE k, so the two live rows are simply what k selects from.
        const hits = store.search(modelId, vec(8, 0), 2);
        expect(hits).toHaveLength(2);
        expect(hits.map(h => h.text)).not.toContain('near');
        expect(hits.map(h => h.text).sort()).toEqual(['far', 'mid']);
    });

    test('🔴 retirement is not deletion — the text stays, it is only hidden from search', () => {
        const id = store.remember({ text: 'once true', vector: vec(8, 0), model: 'm' });
        store.retireMemory(id);

        // Still counted, still on disk — deleteMemory is the only thing that removes text, and this is not it.
        expect(store.memoryCount()).toBe(1);
        expect(store.listMemories({ includeRetired: true })).toHaveLength(1);
    });

    test('the default listing hides retired memories; includeRetired shows them, flagged and linked', () => {
        const old = store.addMemory({ text: 'the older fact' });
        const fresh = store.addMemory({ text: 'the newer fact' });
        store.retireMemory(old, fresh);

        expect(store.listMemories().map(r => r.text)).toEqual(['the newer fact']);

        const all = store.listMemories({ includeRetired: true });
        expect(all.map(r => r.text)).toEqual(['the newer fact', 'the older fact']);

        const retired = present(all.find(r => r.id === old));
        expect(retired.retired).toBe(1);
        expect(retired.supersededBy).toBe(fresh);
    });

    test('retiring an already-retired memory is a no-op — the first supersession stands', () => {
        const id = store.addMemory({ text: 'x' });
        const first = store.addMemory({ text: 'first replacement' });

        expect(store.retireMemory(id, first)).toBe(true);
        expect(store.retireMemory(id, 999)).toBe(false);

        const rec = present(store.listMemories({ includeRetired: true }).find(r => r.id === id));
        expect(rec.supersededBy).toBe(first);
    });

    test('retiring an unknown id reports false rather than pretending', () => {
        expect(store.retireMemory(123456)).toBe(false);
    });
});

describe('reviseMemory — an edit is versioned, not in place (fork panel design §14.2)', () => {
    /**
     * One edit, and it is expected to LAND — `present` is the assertion that says so.
     *
     * 🔴 `reviseMemory` answers null for an id that is retired or absent, and every chain below builds its
     * next step on the id this returns. Without the check a refused edit would surface as a null id three or
     * four calls later, blaming whichever method finally dereferenced it. The one test that WANTS the null
     * calls `reviseMemory` directly, because using this helper there would assert the opposite of its claim.
     *
     * @param {number} id The memory to revise
     * @param {string} text The new wording
     * @returns {number} the new memory's id
     */
    const revise = (id, text) => present(store.reviseMemory({ memoryId: id, text, vector: vec(8, 1), model: 'm' }));

    test('the old wording is retired behind the new one, pointing forward', () => {
        const first = store.remember({ text: 'she lives in Sample City 5', vector: vec(8, 0), model: 'm' });
        const second = revise(first, 'she lives in Sample City 3');

        expect(second).not.toBe(first);
        expect(store.listMemories().map(r => r.text)).toEqual(['she lives in Sample City 3']);

        const old = present(store.getMemory(first));
        expect(old.retired).toBe(1);
        expect(old.supersededBy).toBe(second);
        expect(old.text).toBe('she lives in Sample City 5');       // the text is kept — this is a version, not a tombstone
    });

    test('🔴 three edits leave three retired rows and one live one, in one walkable chain', () => {
        const a = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm' });
        const b = revise(a, 'v2');
        const c = revise(b, 'v3');
        const d = revise(c, 'v4');

        expect(store.listMemories().map(r => r.text)).toEqual(['v4']);
        expect(store.listMemories({ includeRetired: true })).toHaveLength(4);
        expect(store.versionsOf(d).map(r => r.text)).toEqual(['v3', 'v2', 'v1']);
    });

    /**
     * 🔴 RESTORING A MIDDLE VERSION USED TO FORK THE HISTORY AND LOSE A BRANCH SILENTLY.
     *
     * The chain's invariant — stated in `versionsOf` and relied on by it — is that at most one row ever points
     * at a given memory. Restoring the TAIL keeps that for free; restoring a MIDDLE version did not. With
     * A -> B -> C, restoring B set C.superseded_by = B while A.superseded_by = B already, so both pointed at B.
     * `versionsOf` reads `WHERE superseded_by = ?` with `.get()` — one row — so C vanished from the history
     * entirely: still stored, still in an includeRetired listing, but unreachable from the panel's walk and
     * from restoreMemory's own forward walk, so it could never be restored again.
     *
     * The panel reaches this with any retired id, and the history view is exactly where a user picks a middle
     * version, so it is a normal path rather than an edge case.
     */
    test('🔴 restoring a MID-CHAIN version keeps every version reachable', () => {
        const a = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm' });
        const b = revise(a, 'v2');
        const c = revise(b, 'v3');

        expect(store.restoreMemory(b)).toMatchObject({ id: b, retiredId: c });

        // b is live again...
        expect(store.listMemories().map(r => r.text)).toEqual(['v2']);
        // ...and BOTH other versions are still in its history, in the truthful order: c was the most recent.
        expect(store.versionsOf(b).map(r => r.text)).toEqual(['v3', 'v1']);

        // 🔴 The invariant itself: exactly one row points at any given memory.
        const rows = store.listMemories({ includeRetired: true });
        const targets = rows.map(r => r.supersededBy).filter(x => x !== null);
        expect(new Set(targets).size).toBe(targets.length);
    });

    test('🔴 and the version that stood down can be restored again afterward', () => {
        const a = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm' });
        const b = revise(a, 'v2');
        const c = revise(b, 'v3');

        store.restoreMemory(b);
        // Before the fix this returned null: c was unreachable from the forward walk.
        expect(store.restoreMemory(c)).toMatchObject({ id: c });
        expect(store.listMemories().map(r => r.text)).toEqual(['v3']);
    });

    test('🔴 the revision inherits createdAt — an edit is not a new memory event', () => {
        // Stamping the edit's own time would move a three-day-old memory into today's group in a panel whose
        // whole organization is days, telling the user something happened this morning that did not.
        const then = Date.now() - 3 * 86400 * 1000;
        const first = store.addMemory({ text: 'old news', createdAt: then });
        store.addVector(store.registerModel('m', 8).id, first, vec(8, 0));

        const second = revise(first, 'old news, corrected');
        expect(present(store.getMemory(second)).createdAt).toBe(then);
    });

    test('🔴 every identity axis is inherited, so the revision lands in the SAME partition', () => {
        const identity = { tier: TIER_USER, charId: 'char-test-1', personaId: 'test-user.png', charName: 'Test Character 1' };
        const first = store.remember({ text: 'he is uneasy about flying', vector: vec(8, 0), model: 'm', ...identity });
        const second = revise(first, 'he is terrified of flying');

        const before = present(store.getMemory(first));
        const after = present(store.getMemory(second));

        expect(after.scope).toBe(before.scope);
        expect(after.scope).toBe(scopeKey({ tier: TIER_USER, charId: 'char-test-1', personaId: 'test-user.png' }));
        expect(after.tier).toBe(TIER_USER);
        expect(after.charName).toBe('Test Character 1');
    });

    test('🔴 the revision is searchable and the old wording is not — the vectors moved with the flag', () => {
        const modelId = store.registerModel('m', 8).id;
        const first = store.remember({ text: 'she lives in Sample City 5', vector: vec(8, 0), model: 'm' });
        revise(first, 'she lives in Sample City 3');

        const hits = store.search(modelId, vec(8, 1), 5);
        expect(hits.map(h => h.text)).toEqual(['she lives in Sample City 3']);
    });

    test('⚠️ the OTHER model\'s table keeps the old row\'s vector, and finds the new row unembedded', () => {
        // The fork's §14.3 requires an in-place edit to clear every model's vector; a versioned edit has
        // nothing to clear, and clearing anyway would strip a historical row's index and put it back on every
        // model's re-embed worklist for ever. This pins the behavior that argument depends on.
        const older = store.registerModel('older-model', 8).id;
        const first = store.remember({ text: 'v1', vector: vec(8, 0), model: 'older-model' });
        const second = revise(first, 'v2');                                  // embedded with 'm' only

        expect(store.unembedded(older).map(r => r.id)).toEqual([second]);     // the new row, correctly, is unembedded
        expect(store.unembedded(store.registerModel('m', 8).id).map(r => r.id)).toEqual([first]);
    });

    test('editing a retired memory is refused — there is nothing there to change', () => {
        const first = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm' });
        revise(first, 'v2');

        expect(store.reviseMemory({ memoryId: first, text: 'v3', vector: vec(8, 1), model: 'm' })).toBeNull();      // already superseded
        expect(store.reviseMemory({ memoryId: 999999, text: 'v3', vector: vec(8, 1), model: 'm' })).toBeNull();     // never existed
    });

    test('a revision with no vector is refused rather than stored unsearchable', () => {
        const first = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm' });
        expect(() => store.reviseMemory({ memoryId: first, text: 'v2', vector: [], model: 'm' })).toThrow(/vector/i);
    });
});

describe('restoreMemory — the undo for both kinds of supersession', () => {
    /**
     * The same asserted edit the `reviseMemory` describe above defines — see its docblock for why the null is
     * checked here, once, rather than at each call below that chains on the id it returns.
     *
     * @param {number} id The memory to revise
     * @param {string} text The new wording
     * @returns {number} the new memory's id
     */
    const revise = (id, text) => present(store.reviseMemory({ memoryId: id, text, vector: vec(8, 1), model: 'm' }));

    test('🔴 the revived row\'s own superseded_by is CLEARED — otherwise the chain is a two-element cycle', () => {
        const a = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm' });
        const c = revise(a, 'v2');

        expect(store.restoreMemory(a)).toEqual({ id: a, retiredId: c });

        const revived = present(store.getMemory(a));
        expect(revived.retired).toBe(0);
        expect(revived.supersededBy).toBeNull();          // ← the cycle trap. A→C and C→A would loop for ever.
        expect(present(store.getMemory(c)).supersededBy).toBe(a);

        // The proof that it is not a cycle: walking the history from the live row terminates.
        expect(store.versionsOf(a).map(r => r.text)).toEqual(['v2']);
    });

    test('🔴 the LIVE head stands down, not the direct successor — otherwise two rows are live at once', () => {
        const a = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm' });
        const b = revise(a, 'v2');
        const c = revise(b, 'v3');

        expect(store.restoreMemory(a)).toEqual({ id: a, retiredId: c });

        // Exactly one live row, and it is the one asked for. Retiring `b` instead would have been a no-op —
        // it was already retired — leaving 'v1' and 'v3' both searchable and contradicting each other.
        expect(store.listMemories().map(r => r.text)).toEqual(['v1']);
    });

    test('a restored memory is searchable again — the flag was mirrored back into the vector tables', () => {
        const modelId = store.registerModel('m', 8).id;
        const a = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm' });
        revise(a, 'v2');

        expect(store.search(modelId, vec(8, 0), 5).map(h => h.text)).toEqual(['v2']);
        store.restoreMemory(a);
        expect(store.search(modelId, vec(8, 0), 5).map(h => h.text)).toEqual(['v1']);
    });

    test('restoring something already live, or absent, reports null rather than pretending', () => {
        const live = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm' });

        expect(store.restoreMemory(live)).toBeNull();        // a second click on a stale panel
        expect(store.restoreMemory(999999)).toBeNull();
    });

    test('a memory retired with no successor simply comes back, standing nobody down', () => {
        const id = store.addMemory({ text: 'retired by hand' });
        store.retireMemory(id, null);

        expect(store.restoreMemory(id)).toEqual({ id, retiredId: null });
        expect(present(store.getMemory(id)).retired).toBe(0);
    });

    test('an ingest supersession restores exactly like an edit — one mechanism, by design', () => {
        const old = store.remember({ text: 'she lives in Sample City 5', vector: vec(8, 0), model: 'm', source: 'auto' });
        const fresh = store.remember({ text: 'she lives in Sample City 3', vector: vec(8, 1), model: 'm', source: 'auto' });
        store.retireMemory(old, fresh);                       // what placeCandidate does

        expect(store.restoreMemory(old)).toEqual({ id: old, retiredId: fresh });
        expect(store.listMemories().map(r => r.text)).toEqual(['she lives in Sample City 5']);
    });

    test('🔴 the revived row is stamped `restore`, because that is how the panel names who retired the other', () => {
        // The browse view reads "why is this row retired" off the SUCCESSOR's source. Leave an auto-extracted
        // memory's `auto` in place through a restore and the row the user just stood down is described as
        // "replaced as the story moved on" — the engine claiming an action that was unambiguously the user's.
        const a = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm', source: 'auto' });
        const b = revise(a, 'v2');

        store.restoreMemory(a);

        expect(present(store.getMemory(a)).source).toBe('restore');
        expect(store.sourcesOf([a]).get(a)).toBe('restore');
        expect(present(store.getMemory(b)).supersededBy).toBe(a);       // so the panel asks `a` about `b`
    });

    test('🔴 a restore is itself restorable — the round trip goes both ways, any number of times', () => {
        // The undo has to be undoable. Restoring `a` retires `b`; `b` must then be reachable and restorable in
        // exactly the same way, or the panel's "restore" is a one-way door onto whichever version you left.
        const a = store.remember({ text: 'v1', vector: vec(8, 0), model: 'm' });
        const b = revise(a, 'v2');

        expect(store.restoreMemory(a)).toEqual({ id: a, retiredId: b });
        expect(store.versionsOf(a).map(r => r.id)).toEqual([b]);   // `b` is what the history offers back

        expect(store.restoreMemory(b)).toEqual({ id: b, retiredId: a });
        expect(store.listMemories().map(r => r.text)).toEqual(['v2']);
        expect(store.versionsOf(b).map(r => r.id)).toEqual([a]);

        // And again, so nothing accumulates a cycle or a second live row across repeated flips.
        expect(store.restoreMemory(a)).toEqual({ id: a, retiredId: b });
        expect(store.listMemories().map(r => r.text)).toEqual(['v1']);
        expect(present(store.getMemory(a)).supersededBy).toBeNull();
    });
});

describe('the browse view\'s reads — one filter, four queries, no disagreement', () => {
    test('countMemories counts exactly what listMemories would page through', () => {
        for (let i = 0; i < 5; i++) store.addMemory({ text: `m${i}`, tier: TIER_SCENARIO, chatId: 'c' });
        const retired = store.addMemory({ text: 'gone', tier: TIER_SCENARIO, chatId: 'c' });
        store.retireMemory(retired);

        expect(store.countMemories()).toBe(5);
        expect(store.countMemories({ includeRetired: true })).toBe(6);
        expect(store.countMemories({ scopes: [scopeKey({ tier: TIER_SCENARIO, chatId: 'c' })] })).toBe(5);
        expect(store.countMemories({ scopes: [scopeKey({ tier: TIER_SCENARIO, chatId: 'other' })] })).toBe(0);
        expect(store.countMemories({ scopes: [] })).toBe(0);      // "these partitions, of which there are none"
    });

    test('memoryTimes returns timestamps in the same order the listing does, and no text', () => {
        const a = store.addMemory({ text: 'oldest', createdAt: 1000 });
        store.addMemory({ text: 'newest', createdAt: 3000 });
        store.addMemory({ text: 'middle', createdAt: 2000 });

        expect(store.memoryTimes()).toEqual([3000, 2000, 1000]);
        expect(store.listMemories().map(r => r.createdAt)).toEqual([3000, 2000, 1000]);
        expect(JSON.stringify(store.memoryTimes())).not.toContain('oldest');
        expect(a).toBeGreaterThan(0);
    });

    test('getMemory hands back one row in the same shape a listing does, or null', () => {
        const id = store.addMemory({ text: 'one', metadata: { tag: 'x' } });

        expect(store.getMemory(id)).toMatchObject({ id, text: 'one', metadata: { tag: 'x' }, retired: 0 });
        expect(store.getMemory(999999)).toBeNull();
    });

    test('havePredecessors names only the rows something points at', () => {
        const a = store.addMemory({ text: 'v1' });
        const b = store.addMemory({ text: 'v2' });
        const lonely = store.addMemory({ text: 'never edited' });
        store.retireMemory(a, b);

        expect(store.havePredecessors([a, b, lonely])).toEqual(new Set([b]));
        expect(store.havePredecessors([])).toEqual(new Set());
    });

    test('🔴 versionsOf terminates on a chain that has been corrupted into a cycle', () => {
        // The invariant says this cannot happen — `retireMemory` carries `AND retired = 0`, so at most one row
        // points at any memory. The seen-set is there for the day some other method breaks that, because the
        // alternative is a hung request rendering a panel. Forced here by writing the cycle directly.
        const a = store.addMemory({ text: 'a' });
        const b = store.addMemory({ text: 'b' });
        present(store.db).prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(b, a);
        present(store.db).prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(a, b);

        expect(store.versionsOf(a).length).toBeLessThanOrEqual(2);
    });
});

describe('ingest_state — the per-chat high-water mark', () => {
    test('a chat with no history reads back null', () => {
        expect(store.getIngestState('chat-A')).toBeNull();
    });

    test('setting then getting round-trips, and a second set replaces the first', () => {
        store.setIngestState('chat-A', { highWater: 12, lastRun: 1000 });
        expect(store.getIngestState('chat-A')).toEqual({ chatKey: 'chat-A', highWater: 12, lastRun: 1000, failedAtTurns: 0 });

        store.setIngestState('chat-A', { highWater: 20, lastRun: 2000 });
        expect(store.getIngestState('chat-A')).toEqual({ chatKey: 'chat-A', highWater: 20, lastRun: 2000, failedAtTurns: 0 });
    });

    test('🔴 a write that omits failedAtTurns CLEARS it — one good pass ends a backoff', () => {
        // v6 splits "when did this last run" from "when did it last fail", and the clearing is the half that
        // is easy to leave out. A backoff that survived the first successful extraction would keep throttling
        // a chat that is working again, and the symptom — memory that comes back slowly after an outage — is
        // not one anybody would trace to this line.
        store.setIngestState('chat-A', { highWater: 5, lastRun: 0, failedAtTurns: 9_000 });
        expect(present(store.getIngestState('chat-A')).failedAtTurns).toBe(9_000);

        store.setIngestState('chat-A', { highWater: 9, lastRun: 10_000 });

        expect(present(store.getIngestState('chat-A')).failedAtTurns).toBe(0);
    });

    test('different chats keep independent marks', () => {
        store.setIngestState('chat-A', { highWater: 20, lastRun: 2000 });
        store.setIngestState('chat-B', { highWater: 3, lastRun: 500 });

        expect(present(store.getIngestState('chat-A')).highWater).toBe(20);
        expect(present(store.getIngestState('chat-B')).highWater).toBe(3);
    });
});

describe('🔴 there is no migration — an older database is refused, not upgraded', () => {
    /**
     * Rewind the on-disk stamp to `version`, leaving everything else alone, then close.
     *
     * @param {number} version
     * @returns {void}
     */
    const stampAs = (version) => {
        present(store.db).prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(version), 'schema_version');
        store.close();
    };

    test('a pre-v4 database is refused with the reason and the fix, and is NOT touched', () => {
        // Every schema before v4 keyed vectors on a display name and recorded no tier. Upgrading would mean
        // minting an id for a name that may have been renamed onto a different character, and guessing a
        // lifetime for every memory — where a wrong guess leaks one story into another. So: refuse.
        const file = path.join(dir, 'memory.db');
        store.addMemory({ text: 'written by an older Mnemosyne' });
        stampAs(3);
        const before = fs.statSync(file).size;

        expect(() => new MemoryStore(file).open(dbKey)).toThrow(/schema v3.*needs v4|no upgrade/is);

        // 🔴 The file is still there, byte for byte. Refusing must never mean destroying — this code does not
        // delete a user's memories on their behalf, least of all ones it has decided it cannot read. (It cannot
        // be reopened to check the rows: the guard that refused it refuses again, which is the point.)
        expect(fs.statSync(file).size).toBe(before);
    });

    test('a NEWER database is refused too, rather than read with columns that may have changed meaning', () => {
        stampAs(SCHEMA_VERSION + 1);

        expect(() => new MemoryStore(path.join(dir, 'memory.db')).open(dbKey))
            .toThrow(/NEWER Mnemosyne|upgrade Mnemosyne/i);
    });

    test('a fresh file is created at the current version without complaint', () => {
        const fresh = new MemoryStore(path.join(dir, 'fresh.db')).open(key());
        try {
            const stamp = /** @type {{ value: string }} */ (present(fresh.db).prepare('SELECT value FROM meta WHERE key = ?').get('schema_version'));

            expect(stamp.value).toBe(String(SCHEMA_VERSION));
        } finally {
            fresh.close();
        }
    });
});

describe('clearMemories — start fresh WITHOUT losing the settings', () => {
    const ELARA = { charId: 'char-test-1', personaId: 'test-user.png', chatId: 'chat-1', charName: 'Test Character 1' };

    test('it erases every memory and every vector', () => {
        store.remember({ text: 'the scene', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });
        store.remember({ text: 'Test User is afraid of heights', vector: vec(8, 1), model: 'm', tier: TIER_USER, ...ELARA });
        const m = store.registerModel('m', 8).id;

        expect(store.clearMemories().memories).toBe(2);

        expect(store.memoryCount()).toBe(0);
        expect(store.listMemories({})).toHaveLength(0);
        // 🔴 Not just unreachable through `memories` — actually gone from the vector table. A dangling vector
        // would keep consuming one of the `k` slots on every search for ever, so recall would silently degrade
        // rather than fail, which is the failure mode nobody reports.
        expect(store.search(m, vec(8, 0), 5)).toHaveLength(0);
        expect(/** @type {{ n: number }} */ (present(store.db)
            .prepare(`SELECT COUNT(*) AS n FROM ${vectorTableName(m)}`).get()).n).toBe(0);
    });

    test('🔴 the settings, the presets and the edited prompt all survive — the whole reason this is not a file delete', () => {
        // Deleting store.db from a shell clears the memories AND these, because from outside the process the
        // file is opaque SQLCipher bytes and the only granularity available is the whole thing. This method
        // exists precisely to tell them apart, so this is the assertion that justifies its existence.
        writeSettings(store, { retrievalK: 6, maxLength: 2200 });
        savePreset(store, 'local 8B', readSettings(store), 'a prompt of my own');
        writePromptTemplate(store, 'MY OWN EXTRACTION PROMPT');
        store.remember({ text: 'a memory to erase', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });

        store.clearMemories();

        expect(readSettings(store).retrievalK).toBe(6);
        expect(readSettings(store).maxLength).toBe(2200);
        expect(readPresets(store).map(p => p.name)).toEqual(['default', 'local 8B']);
        expect(readPromptTemplate(store)).toBe('MY OWN EXTRACTION PROMPT');
        expect(store.memoryCount()).toBe(0);
    });

    test('the model registry survives, so switching back to a model you have used is still free', () => {
        // A vector is an index into a memory and is disposable; the REGISTRATION is not. Dropping it would
        // strand the vector table it names — see registerModel's own note on that failure.
        store.remember({ text: 'x', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });

        store.clearMemories();

        expect(store.registerModel('m', 8).id).toBe(1);
    });

    test('it clears every chat\'s high-water mark, so ingest is not left thinking it has read everything', () => {
        store.setIngestState('chat-1', { highWater: 40, lastRun: 1000 });
        store.setIngestState('chat-2', { highWater: 12, lastRun: 2000 });

        store.clearMemories();

        expect(store.getIngestState('chat-1')).toBeNull();
        expect(store.getIngestState('chat-2')).toBeNull();
    });

    test('the store is fully usable afterward — remember and search round-trip', () => {
        store.remember({ text: 'before', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        store.clearMemories();

        store.remember({ text: 'after', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        const m = store.registerModel('m', 8).id;

        expect(store.search(m, vec(8, 0), 5)).toHaveLength(1);
        expect(store.listMemories({}).map(r => r.text)).toEqual(['after']);
    });

    test('the lexical index goes too, rather than matching memories that no longer exist', () => {
        store.remember({ text: 'the scarab was stolen from the museum', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });
        expect(store.searchLexical('scarab', 5, { scopes: [scopeKey({ tier: TIER_SCENARIO, chatId: 'chat-1' })] })).toHaveLength(1);

        store.clearMemories();

        expect(store.searchLexical('scarab', 5, { scopes: [scopeKey({ tier: TIER_SCENARIO, chatId: 'chat-1' })] })).toHaveLength(0);
    });

    test('🔴 it reports the size either side, and the file actually shrinks — VACUUM is part of the answer', () => {
        // Without the VACUUM the pages go to a free list inside the same file and the size is unchanged, so a
        // user who just erased everything is told the store is exactly as big as it was. That reads as "it did
        // not work", which is the one impression this operation cannot afford to leave.
        for (let i = 0; i < 400; i++) {
            store.remember({
                text: `memory number ${i} `.padEnd(1024, 'x'),
                vector: vec(8, i % 8), model: 'm', tier: TIER_SCENARIO, ...ELARA,
            });
        }

        const result = store.clearMemories();

        expect(result.memories).toBe(400);
        expect(result.bytesBefore).toBeGreaterThan(400 * 1024);
        expect(result.bytesAfter).toBeLessThan(result.bytesBefore / 2);
        // The reported "after" is the real file, not a number this method made up.
        expect(fs.statSync(path.join(dir, 'memory.db')).size).toBe(result.bytesAfter);
    });

    test('clearing an empty store reports zero rather than failing', () => {
        const result = store.clearMemories();

        expect(result.memories).toBe(0);
        expect(result.bytesAfter).toBeGreaterThan(0);   // the schema is still there
    });

    test('it refuses on a closed store like every other write', () => {
        store.close();

        expect(() => store.clearMemories()).toThrow(/not open|locked/i);
    });
});

/**
 * 🔴 THE MEASUREMENT THAT DOES NOT DESTROY WHAT IT MEASURES.
 *
 * Before `usage()` the only size this plugin could report came back from `clearMemories`, so the answer to
 * a store's size was available only to a user who had just erased it.
 */
describe('usage — how much is in the store, read without erasing it', () => {
    const ELARA = { charId: 'char-test-1', personaId: 'test-user.png', chatId: 'chat-1', charName: 'Test Character 1' };

    test('it counts the memories and measures the real file', () => {
        store.remember({ text: 'the scene', vector: vec(8, 0), model: 'm', tier: TIER_SCENARIO, ...ELARA });
        store.remember({ text: 'Test User is afraid of heights', vector: vec(8, 1), model: 'm', tier: TIER_USER, ...ELARA });

        const usage = store.usage();

        expect(usage.memories).toBe(2);
        // The bytes are the file on disk, not a number this method made up — the same property `clearMemories`
        // is held to, and the reason the panel's line can be compared against a file manager.
        expect(usage.bytes).toBe(fs.statSync(path.join(dir, 'memory.db')).size);
    });

    test('reading it changes nothing — the memories are still there afterward', () => {
        store.remember({ text: 'still here', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });

        store.usage();
        store.usage();

        expect(store.memoryCount()).toBe(1);
    });

    test('an emptied store reports no memories and a file that is still there', () => {
        store.remember({ text: 'about to go', vector: vec(8, 0), model: 'm', tier: TIER_USER, ...ELARA });
        store.clearMemories();

        const usage = store.usage();

        expect(usage.memories).toBe(0);
        // ⚠️ NOT zero bytes, and the panel says so in words: the settings, presets and prompt a reset keeps
        // live in this same file. A line that showed only the size would read as "the reset did not work".
        expect(usage.bytes).toBeGreaterThan(0);
    });

    test('it refuses on a closed store rather than reporting a stale number', () => {
        store.close();

        expect(() => store.usage()).toThrow(/not open|locked/i);
    });
});
