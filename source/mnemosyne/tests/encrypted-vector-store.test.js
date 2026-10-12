import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

/**
 * Both of these are native CommonJS packages, and they are loaded through createRequire rather than a bare
 * `import`. That is not ceremony, and it is not a Jest workaround to be deleted later:
 *
 * sqlite-vec ships index.mjs and index.cjs. The ESM one locates its .dll/.so via `import.meta.resolve`,
 * which real Node 24 has but Jest's --experimental-vm-modules does NOT provide, so `import`ing it under
 * test dies with the splendidly opaque "(intermediate value).resolve is not a function". The CJS one uses
 * require.resolve and works in both places.
 *
 * So createRequire is the path that behaves identically under test and in production, which is exactly the
 * property you want from the file that certifies the encryption is real. A test that loads the library
 * differently from the way the plugin loads it is testing a different library.
 */
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3-multiple-ciphers');
const sqliteVec = require('sqlite-vec');

/**
 * An open connection, named by the driver's OWN declaration — the same typedef `src/store.js` uses, and for
 * the same reason.
 *
 * 🔴 `.get()` is `unknown` and `.all()` is `unknown[]` under it, which is the entire value of naming the type
 * here rather than letting `createRequire`'s `any` flow through. This file's job is to prove what came back
 * out of SQLCipher really is what went in; a connection typed `any` would let every assertion below be about
 * a value nobody had checked the shape of. Typed, each SELECT has to state its expectation in a cast written
 * beside the SQL the cast is a claim about — the only place a human can check the two against each other,
 * since no checker reads a SQL string.
 *
 * ⚠️ `createRequire` is a RUNTIME choice (see above) and costs nothing here: TypeScript resolves the
 * `import(...)` below against the package's own `index.d.ts` either way, while Node still loads the CommonJS
 * entry the `import.meta.resolve` note explains.
 *
 * @typedef {import('better-sqlite3-multiple-ciphers').Database} SqliteDatabase
 */

/**
 * 🔴 THIS IS THE THESIS OF THE WHOLE PLUGIN, EXPRESSED AS TESTS. IF THIS FILE GOES RED, STOP.
 *
 * Mnemosyne bets that you can have an unbounded semantic memory whose vectors are ciphertext on disk. Every
 * other design decision — SQLite over a server DB, one file per user, a key derived from the vault DEK —
 * rests on that single bet, and if it is wrong the project has no foundation to stand on. So it is not
 * enough for the bet to be plausible. It has to be checked, and re-checked on every run, forever.
 *
 * These assertions began life as a standalone proof-of-concept (a poc.cjs script in a separate scratch folder, untracked
 * scratch) written before any plugin code existed, precisely to find out whether to write any. It passed
 * 11/11. They live here now so the proof cannot be tidied away, and so it keeps being true.
 *
 * Four things get proven, and the fourth is the one people skip:
 *
 *   [1] SQLCipher and sqlite-vec load into the SAME connection. The founding bet. If these two cannot
 *       coexist, there is no encrypted vector index and the design is dead.
 *   [2] Search is CORRECT, not merely functional. sqlite-vec's top-10 is checked against a brute-force
 *       cosine ground truth computed here. "It returned some rows" is not evidence of a working index.
 *   [3] The disk is ciphertext. No SQLite header, no plaintext canary, and it refuses to open with no key
 *       or the wrong key.
 *   [4] 🔴 THE LEAK CHECK HAS TEETH. An unencrypted control database is built with the same code and the
 *       same canary, and [4] asserts that the check DOES find the canary there.
 *
 * Why [4] is load-bearing: a test that greps a file for a string and finds nothing passes just as happily
 * when the grep is broken, the canary was never written, or the file is empty. [3] alone cannot tell
 * "encrypted" from "I looked for the wrong thing". [4] is what turns [3] from a green tick into evidence.
 * A leak detector that has never once detected a leak is not a detector; it is a decoration.
 *
 * If you are tempted to delete [4] because "we don't ship an unencrypted mode" — that is the point. It is
 * not testing a feature. It is testing the test.
 */

const DIM = 384;
const N = 1000;
const CANARY = 'MNEMOSYNE_CANARY_PLAINTEXT_MUST_NOT_APPEAR_ON_DISK';

/**
 * 🔴 The key hierarchy, mirroring the real design.
 *
 * Vault's src/session.js derives sibling subkeys from the DEK (kContent, kNames, kCache, kCacheNames).
 * Mnemosyne adds kMemoryDb as one more sibling, so the memory store locks and unlocks with the vault and
 * there is no new secret for the user to manage, and none to lose.
 *
 * Note what is NOT here: a password. The DEK already paid the argon2id cost. Running a second KDF over it
 * would buy nothing — the input is already a uniformly random 32 bytes, which is exactly what HKDF wants.
 *
 * @param {Buffer} dek The vault's data-encryption key — 32 uniformly random bytes
 * @returns {Buffer} kMemoryDb, the 32-byte subkey the store is opened with
 */
const deriveMemoryDbKey = (dek) => Buffer.from(
    crypto.hkdfSync('sha256', dek, Buffer.alloc(0), Buffer.from('mnemosyne-db-v1'), 32),
);

/**
 * Deterministic RNG, so a failure is reproducible rather than a story about last Tuesday.
 *
 * @param {number} a The seed
 * @returns {() => number} a generator of floats in [0, 1)
 */
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * One random unit vector — the stand-in for an embedding.
 *
 * @param {() => number} rand A generator from {@link mulberry32}
 * @param {number} d How many dimensions
 * @returns {Float32Array} a vector of length 1
 */
function unitVec(rand, d) {
    const v = new Float32Array(d);
    let norm = 0;
    for (let i = 0; i < d; i++) { v[i] = rand() * 2 - 1; norm += v[i] * v[i]; }
    norm = Math.sqrt(norm);
    for (let i = 0; i < d; i++) v[i] /= norm;
    return v;
}

/**
 * Cosine similarity of two UNIT vectors, which is just their dot product — the brute-force ground truth [2]
 * grades sqlite-vec against.
 *
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
const cosine = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
};

/**
 * Open a database. Pass key = null for the unencrypted control of [4].
 * @param {string} file Path to the database file
 * @param {Buffer|null} key Raw 32-byte key, or null for no encryption
 * @returns {SqliteDatabase} an open connection with the vec0 extension loaded
 */
function openDb(file, key) {
    const db = new Database(file);

    if (key) {
        // 🔴 ORDER MATTERS: cipher BEFORE key. And 'sqlcipher' explicitly, because
        // SQLite3MultipleCiphers defaults to chacha20 — which encrypts perfectly well but produces a file
        // that is NOT SQLCipher format and cannot be opened by standard SQLCipher tooling. We want the
        // real thing, so that a future migration, forensic check, or `sqlcipher` CLI session is possible.
        db.pragma('cipher=\'sqlcipher\'');
        db.pragma('legacy=4');

        // x'..' means RAW KEY, not password. Without the x'' form SQLCipher would run its own PBKDF2 over
        // these bytes as though they were a passphrase — a second KDF over an already-uniform key, which
        // is pure cost for zero security. The DEK did that work already.
        db.pragma(`key="x'${key.toString('hex')}'"`);
    }

    sqliteVec.load(db);
    return db;
}

/**
 * Fill a connection with {@link N} vectors and their canary-bearing payload rows.
 *
 * @param {SqliteDatabase} db An open connection, encrypted or not
 * @param {() => number} rand A generator from {@link mulberry32}
 * @returns {Float32Array[]} the vectors as they were written, in rowid order — [2]'s ground truth
 */
function populate(db, rand) {
    db.exec(`CREATE VIRTUAL TABLE memories USING vec0(embedding float[${DIM}])`);
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, text TEXT)');

    const insVec = db.prepare('INSERT INTO memories(rowid, embedding) VALUES (?, ?)');
    const insTxt = db.prepare('INSERT INTO payload(id, text) VALUES (?, ?)');
    /** @type {Float32Array[]} */
    const vecs = [];

    db.transaction(() => {
        for (let i = 1; i <= N; i++) {
            const v = unitVec(rand, DIM);
            vecs.push(v);

            // 🔴 rowid MUST be BigInt, and this cost a debug cycle to learn. better-sqlite3 binds a JS
            // number via sqlite3_bind_double, so vec0 sees a raw FLOAT where it demands an integer and
            // rejects it with the actively misleading error "Only integers are allows for primary key
            // values" [sic]. Ordinary tables hide this behind INTEGER affinity, which silently coerces.
            // Virtual tables do not. If you ever see that error, this line is why.
            insVec.run(BigInt(i), Buffer.from(v.buffer));
            insTxt.run(i, `${CANARY} :: memory record ${i}`);
        }
    })();

    return vecs;
}

/** @type {string} */
let workDir;
/** @type {string} */
let encFile;
/** @type {string} */
let plainFile;
/** @type {Float32Array[]} */
let vecs;
/** @type {Buffer} */
let encBytes;
/** @type {Buffer} */
let memoryDbKey;

beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosyne-proof-'));
    encFile = path.join(workDir, 'mnemosyne-encrypted.db');
    plainFile = path.join(workDir, 'control-unencrypted.db');

    // The DEK stands in for Vault's, and is thrown away; kMemoryDb is what the store actually holds.
    memoryDbKey = deriveMemoryDbKey(crypto.randomBytes(32));

    const db = openDb(encFile, memoryDbKey);
    vecs = populate(db, mulberry32(42));
    db.close();

    encBytes = fs.readFileSync(encFile);
});

afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

describe('[1] SQLCipher and sqlite-vec live in the same connection', () => {
    /** @type {SqliteDatabase} */
    let db;

    beforeAll(() => { db = openDb(encFile, memoryDbKey); });
    afterAll(() => { db.close(); });

    test('the cipher is really SQLCipher, not the library default', () => {
        // If this ever reads 'chacha20', the file is still encrypted but is no longer SQLCipher format,
        // and every promise made about standard tooling being able to read it is quietly broken.
        expect(String(db.pragma('cipher', { simple: true }))).toBe('sqlcipher');
    });

    test('sqlite-vec reports a version, so its extension really loaded', () => {
        const row = db.prepare('SELECT vec_version() AS v').get();

        // 🔴 The `toBeDefined` is what earns the cast below, and it is an assertion this test wanted anyway:
        // `vec_version()` returning NO ROW is the exact shape of "the extension did not load", which is the
        // failure [1] exists to catch. Without it the old `.get().v` would have died on a TypeError instead
        // of on the claim being tested.
        expect(row).toBeDefined();
        expect(/** @type {{ v: string }} */ (row).v).toMatch(/^v?\d+\.\d+\.\d+$/);
    });

    test(`all ${N} vectors of ${DIM} dimensions are readable back through the cipher`, () => {
        const row = db.prepare('SELECT count(*) AS c FROM memories').get();

        expect(row).toBeDefined();
        expect(/** @type {{ c: number }} */ (row).c).toBe(N);
        expect(vecs).toHaveLength(N);
    });
});

describe('[2] search is correct, not merely functional', () => {
    /**
     * The query is vector #500 deliberately nudged off course. Querying with a vector that is stored
     * verbatim would pass even against a store that merely echoed back what it was handed; perturbing it
     * means only genuine nearest-neighbor search finds #500. The brute-force cosine says what the true
     * answer is, so sqlite-vec is graded against arithmetic, not against itself.
     */
    const target = 500;
    /** @type {SqliteDatabase} */
    let db;
    /** @type {Float32Array} */
    let query;
    /** @type {number[]} */
    let truth;

    beforeAll(() => {
        db = openDb(encFile, memoryDbKey);

        const q = Float32Array.from(vecs[target - 1]);
        for (let i = 0; i < DIM; i += 8) q[i] += 0.05;
        const n = Math.sqrt(q.reduce((s, x) => s + x * x, 0));
        for (let i = 0; i < DIM; i++) q[i] /= n;
        query = q;

        truth = vecs
            .map((v, i) => ({ id: i + 1, sim: cosine(query, v) }))
            .sort((a, b) => b.sim - a.sim)
            .slice(0, 10)
            .map((r) => r.id);
    });

    afterAll(() => { db.close(); });

    /**
     * ⚠️ The cast states what this SELECT returns, and it sits on the same expression as the SQL because
     * nothing else can check the two against each other — `.all()` is `unknown[]` by the driver's own
     * declaration, since SQLite promises nothing about a column list.
     *
     * @param {number} k How many neighbors to ask vec0 for
     * @returns {number[]} the matching rowids, nearest first
     */
    const search = (k) => /** @type {{ rowid: number }[]} */ (db
        .prepare('SELECT rowid FROM memories WHERE embedding MATCH ? AND k = ? ORDER BY distance')
        .all(Buffer.from(query.buffer), k))
        .map((r) => r.rowid);

    test('top-1 is the planted neighbor, despite the perturbation', () => {
        expect(search(10)[0]).toBe(target);
    });

    test('top-10 matches the brute-force cosine ground truth exactly, in order', () => {
        expect(search(10)).toEqual(truth);
    });

    test('the payload decrypts in RAM and reads back verbatim', () => {
        const row = db.prepare('SELECT text FROM payload WHERE id = ?').get(target);

        // 🔴 A missing row and a wrong row are different failures, and only one of them was distinguishable
        // before: destructuring `undefined` threw where this now says which half of the claim broke. The
        // round trip through the cipher is the point, so "there is a row at all" is worth stating out loud.
        expect(row).toBeDefined();
        const { text } = /** @type {{ text: string }} */ (row);

        expect(text).toContain(`memory record ${target}`);
    });
});

describe('[3] the disk is ciphertext', () => {
    test('there is no SQLite header — the file does not even look like a database', () => {
        expect(encBytes.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');
    });

    test('the canary is absent from the raw bytes', () => {
        expect(encBytes.includes(Buffer.from(CANARY))).toBe(false);
    });

    test('it cannot be opened with no key at all', () => {
        expect(() => {
            const db = new Database(encFile);
            try {
                db.prepare('SELECT count(*) FROM payload').get();
            } finally {
                db.close();
            }
        }).toThrow();
    });

    test('it cannot be opened with the WRONG key', () => {
        expect(() => {
            const db = openDb(encFile, crypto.randomBytes(32));
            try {
                db.prepare('SELECT count(*) FROM payload').get();
            } finally {
                db.close();
            }
        }).toThrow();
    });
});

describe('[4] 🔴 the control — proving the leak check can detect a leak', () => {
    /**
     * Everything in [3] is a negative assertion, and negative assertions rot silently. This builds the same
     * database with the same code and the same canary, with encryption OFF, and demands that [3]'s checks
     * FIRE. If this describe block ever goes green in the wrong direction — control shows no header, no
     * canary — then [3] has been passing for free and proving nothing.
     */
    /** @type {Buffer} */
    let plainBytes;

    beforeAll(() => {
        const db = openDb(plainFile, null);
        populate(db, mulberry32(42));
        db.close();
        plainBytes = fs.readFileSync(plainFile);
    });

    test('the control DOES have a SQLite header — so the header check is looking in the right place', () => {
        expect(plainBytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    });

    test('the control DOES leak the canary — so the canary check has teeth', () => {
        expect(plainBytes.includes(Buffer.from(CANARY))).toBe(true);
    });
});
