import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { MemoryStore } from '../src/store.js';
import { TIER_USER, scopeKey } from '../src/schema.js';
import { fuseByRank, toMatchExpression } from '../src/retrieval.js';

/**
 * The lexical half of retrieval — FTS5/BM25 — and the rank fusion that joins it to the vector half.
 *
 * 🔴 **WHY A SECOND CHANNEL EXISTS AT ALL, since that is what these tests are really defending.** A pooled
 * sentence embedding is structurally weak on rare tokens: a proper noun that appears in exactly one memory
 * barely moves a mean-pooled vector, which is the opposite of what BM25 does with it. In a representative set,
 * top-4 contained 9 wanted rows from dense search, 10 from lexical search, and 13 after fusion. The channels
 * fail on different queries, so either one alone can miss a correct row.
 *
 * ⚠️ These tests use REAL text and the real FTS5 tokenizer, deliberately, where the vector tests use
 * hand-built vectors. A synthetic keyword index would test nothing: the whole question is whether SQLite's
 * tokenizer and BM25 do what the merge assumes, and a fake would be built from the same assumption.
 */

const key = () => Buffer.from(crypto.hkdfSync('sha256', crypto.randomBytes(32), Buffer.alloc(0), Buffer.from('mnemosyne-db-v1'), 32));

/** @type {string} */
let dir;
/** @type {MemoryStore} */
let store;

const CHAR = 'char-1';
const PERSONA = 'test-user.png';
const USER_SCOPE = scopeKey({ tier: TIER_USER, charId: CHAR, personaId: PERSONA });

/**
 * @param {string} text The memory body
 * @param {string} indexLine Its distilled index line
 * @returns {number} the new row's id
 */
function remember(text, indexLine) {
    return store.addMemory({ text, indexLine, tier: TIER_USER, charId: CHAR, personaId: PERSONA });
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosyne-lex-'));
    store = new MemoryStore(path.join(dir, 'memory.db')).open(key());
});

afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('toMatchExpression — user text becomes something FTS5 can match, never something it can parse', () => {
    test('a rare proper noun survives, and the question scaffolding does not', () => {
        expect(toMatchExpression('What do you remember about the Sampletown3?')).toBe('"sampletown3"');
    });

    test('🔴 a question mark does not reach MATCH', () => {
        // A trailing '?' is FTS5 syntax and throws SQLITE_ERROR at prepare time. The whole generation would
        // fail for a turn whose only sin was ending in a question mark.
        expect(toMatchExpression('mainspring?')).toBe('"mainspring"');
    });

    test('🔴 the word "not" becomes a literal, not a negation', () => {
        // This is the one that would be silently wrong rather than loudly broken: bare NOT is an FTS5
        // operator, so "clock not working" would return rows containing "clock" and NOT "working" — the
        // complement of the question. Quoting every term makes it a literal by construction.
        const expression = toMatchExpression('clock not working');

        expect(expression).toContain('"not"');
        expect(expression).not.toMatch(/(^|\s)NOT(\s|$)/);
    });

    test('🔴 AND, OR and NEAR never survive as operators', () => {
        // ⚠️ Asserted STRUCTURALLY, and the two earlier versions of this test show why. Checking that each
        // operator comes back quoted failed on "and"/"or", which are stopwords and get dropped outright —
        // safer still, but not what the assertion said. Checking that no bare operator appears then failed on
        // the ` OR ` separator this function emits ITSELF. The real invariant is the shape: every surviving
        // term is quoted, and the only unquoted text is the separator.
        const WELL_FORMED = /^"[^"]+"( OR "[^"]+")*$/;

        for (const operator of ['and', 'or', 'near', 'not']) {
            const expression = toMatchExpression(`workshop ${operator} bench`);

            expect(expression).toMatch(WELL_FORMED);
        }

        // The two that are not stopwords must still be searchable as words rather than silently vanishing.
        expect(toMatchExpression('workshop near bench')).toContain('"near"');
        expect(toMatchExpression('clock not working')).toContain('"not"');
    });

    test('terms are OR-ed, so a memory matching one rare word still ranks', () => {
        expect(toMatchExpression('Sampletown3 regulator')).toBe('"sampletown3" OR "regulator"');
    });

    test('repeated terms are deduplicated rather than self-weighted', () => {
        expect(toMatchExpression('clock clock clock')).toBe('"clock"');
    });

    test('a question made entirely of stopwords yields nothing, and that is not an error', () => {
        // The caller must treat '' as "skip this channel". Passing it to MATCH is a syntax error.
        expect(toMatchExpression('What do you remember about me?')).toBe('');
    });

    test('non-string input is refused rather than coerced', () => {
        expect(toMatchExpression(/** @type {any} */ (null))).toBe('');
        expect(toMatchExpression(/** @type {any} */ (undefined))).toBe('');
    });

    test('accents and non-Latin scripts are kept as terms', () => {
        // `unicode61 remove_diacritics 2` folds the accent at index time; the extractor must not drop the word.
        expect(toMatchExpression('Zoë Bäcker')).toBe('"zoë" OR "bäcker"');
    });
});

describe('searchLexical — BM25 over the memories, scoped and filtered like the vector search', () => {
    test('finds a memory by a rare proper noun the whole store shares no other token with', () => {
        const wanted = remember('A Sampletown3 regulator sits half-stripped on the bench.', 'the Sampletown3 regulator');
        remember('The user has a cat called Sample Character 12.', 'the cat, Sample Character 12');

        const hits = store.searchLexical(toMatchExpression('Tell me about the Sampletown3'), 10, { scopes: [USER_SCOPE] });

        expect(hits.map(h => h.id)).toEqual([wanted]);
    });

    test('🔴 rank is 0-based and ascending, whatever bm25 does with its sign', () => {
        remember('Test Character 5 the clockmaker repaired the regulator in his Sample City 6 workshop.', 'Test Character 5, clockmaker, Sample City 6');
        remember('The harbor at Sample City 6 has a ferry.', 'Sample City 6 harbor');

        const hits = store.searchLexical(toMatchExpression('Test Character 5 Sample City 6 clockmaker'), 10, { scopes: [USER_SCOPE] });

        expect(hits.length).toBeGreaterThan(1);
        expect(hits.map(h => h.rank)).toEqual(hits.map((_, i) => i));
        // bm25() is negative and more negative is better, so a correctly ordered list ascends.
        expect(hits[0].score).toBeLessThanOrEqual(hits[1].score);
    });

    test('a retired memory is excluded, exactly as it is from the vector search', () => {
        const kept = remember('The user still owns the Sampletown3 regulator.', 'the Sampletown3 regulator');
        const gone = remember('The user sold the Sampletown3 regulator.', 'the Sampletown3 regulator, sold');

        store.retireMemory(gone, kept);

        const hits = store.searchLexical(toMatchExpression('Sampletown3'), 10, { scopes: [USER_SCOPE] });

        expect(hits.map(h => h.id)).toEqual([kept]);
    });

    test('🔴 a memory in another partition is never returned, however well it matches', () => {
        // Confidentiality, not relevance: crossing a persona is the failure `retrievalScopes` exists to
        // prevent, and a second retrieval channel that quietly ignored scope would reintroduce it.
        store.addMemory({
            text: 'A Sampletown3 regulator, in someone else\'s memory.',
            indexLine: 'the Sampletown3 regulator',
            tier: TIER_USER,
            charId: CHAR,
            personaId: 'someone-else.png',
        });

        const hits = store.searchLexical(toMatchExpression('Sampletown3'), 10, { scopes: [USER_SCOPE] });

        expect(hits).toEqual([]);
    });

    test('an empty or whitespace expression returns nothing instead of reaching MATCH', () => {
        remember('Anything at all.', 'anything');

        expect(store.searchLexical('', 10, { scopes: [USER_SCOPE] })).toEqual([]);
        expect(store.searchLexical('   ', 10, { scopes: [USER_SCOPE] })).toEqual([]);
    });

    test('🔴 a malformed expression returns nothing rather than throwing', () => {
        // Retrieval is a best-effort enrichment riding on someone's message. Losing this channel for one
        // turn is a worse answer; throwing loses the message.
        remember('The user keeps a workshop.', 'the workshop');

        expect(() => store.searchLexical('"unclosed AND (', 10, { scopes: [USER_SCOPE] })).not.toThrow();
        expect(store.searchLexical('"unclosed AND (', 10, { scopes: [USER_SCOPE] })).toEqual([]);
    });

    test('k bounds the result set', () => {
        for (let i = 0; i < 8; i++) {
            remember(`Memory number ${i} about the workshop bench.`, 'the workshop bench');
        }

        expect(store.searchLexical(toMatchExpression('workshop bench'), 3, { scopes: [USER_SCOPE] })).toHaveLength(3);
    });

    test('the index line outweighs the body, so a memory ABOUT a term beats one merely mentioning it', () => {
        const about = remember('It sits on the bench.', 'the Sampletown3 regulator');
        remember('The user once mentioned a Sampletown3 in passing while talking about the harbor, the ferry and the town.', 'the harbor and the ferry');

        const hits = store.searchLexical(toMatchExpression('Sampletown3'), 10, { scopes: [USER_SCOPE] });

        expect(hits[0].id).toBe(about);
    });
});

describe('🔴 the FTS index tracks the memories table, or it silently goes stale', () => {
    test('a memory added after the table exists is findable', () => {
        const id = remember('Test Character 5 repaired clocks in Sample City 6.', 'Test Character 5, the clockmaker');

        expect(store.searchLexical(toMatchExpression('Test Character 5'), 10, { scopes: [USER_SCOPE] }).map(h => h.id)).toEqual([id]);
    });

    test('🔴 an UPDATE to a memory re-indexes it under the new words and drops the old ones', () => {
        // ⚠️ Written as raw SQL on purpose. `reviseMemory` is insert-plus-retire rather than an UPDATE, so
        // the plugin's own edit path does not exercise this trigger today — which is exactly why it needs a
        // test. An untested trigger for a statement nobody currently issues is the one that breaks silently
        // the day someone adds an in-place update, and the symptom would be search results for text that is
        // no longer in the database.
        const id = remember('Testcharacter5 repaired clocks.', 'Testcharacter5, the clockmaker');

        /** @type {any} */ (store).db
            .prepare('UPDATE memories SET text = ?, index_line = ? WHERE id = ?')
            .run('Testauthor1 repaired clocks.', 'Testauthor1, the clockmaker', id);

        expect(store.searchLexical(toMatchExpression('Testauthor1'), 10, { scopes: [USER_SCOPE] }).map(h => h.id)).toEqual([id]);
        expect(store.searchLexical(toMatchExpression('Testcharacter5'), 10, { scopes: [USER_SCOPE] })).toEqual([]);
    });

    test('a deleted memory stops matching', () => {
        const id = remember('Test Character 5 repaired clocks.', 'Test Character 5, the clockmaker');

        expect(store.searchLexical(toMatchExpression('Test Character 5'), 10, { scopes: [USER_SCOPE] }).map(h => h.id)).toEqual([id]);

        store.deleteMemory(id);

        expect(store.searchLexical(toMatchExpression('Test Character 5'), 10, { scopes: [USER_SCOPE] })).toEqual([]);
    });
});

describe('🔴 a store written before the lexical index existed is backfilled, not left half-empty', () => {
    test('every pre-existing memory is findable after the reopen that adds the index', () => {
        // The triggers only maintain rows written from now on. Without the backfill in `#migrate`, every
        // memory a user already had would be invisible to keyword search for ever — and nothing would report
        // it, because an empty lexical result is indistinguishable from "no match". This is the whole reason
        // the change could ship without bumping SCHEMA_VERSION and destroying existing stores.
        const backfillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosyne-backfill-'));
        const file = path.join(backfillDir, 'memory.db');
        const dbKey = key();

        try {
            const older = new MemoryStore(file).open(dbKey);
            const id = older.addMemory({
                text: 'Test Character 5 repaired clocks in Sample City 6.',
                indexLine: 'Test Character 5, the clockmaker',
                tier: TIER_USER,
                charId: CHAR,
                personaId: PERSONA,
            });

            // Strip the index, its triggers AND the backfill marker, which together are exactly the shape a
            // store had on disk before this change. ⚠️ Deleting the marker is part of the fixture, not a
            // convenience: the marker ships in the same commit as the table, so "indexed once, then the table
            // vanished" is not a state a real store can reach, and a fixture that produced it would be
            // testing the recovery of an impossible database instead of the upgrade of a real one.
            /** @type {any} */ (older).db.exec(
                'DROP TRIGGER memories_fts_insert;'
                + 'DROP TRIGGER memories_fts_update;'
                + 'DROP TRIGGER memories_fts_delete;'
                + 'DROP TABLE memories_fts;'
                + 'DELETE FROM meta WHERE key = \'lexical_index_built\'',
            );
            older.close();

            const reopened = new MemoryStore(file).open(dbKey);

            try {
                const hits = reopened.searchLexical(toMatchExpression('Test Character 5 Sample City 6'), 10, { scopes: [USER_SCOPE] });

                expect(hits.map(h => h.id)).toEqual([id]);
            } finally {
                reopened.close();
            }
        } finally {
            fs.rmSync(backfillDir, { recursive: true, force: true });
        }
    });
});

describe('fuseByRank — the two channels merge on rank, never on score', () => {
    /**
     * @param {number} id The memory id
     * @param {number} distance Its vec0 distance
     * @returns {any} a SearchHit-shaped row
     */
    const dense = (id, distance) => ({ id, text: `m${id}`, source: null, metadata: null, tier: TIER_USER, charName: '', scope: USER_SCOPE, distance });

    /**
     * @param {number} id The memory id
     * @param {number} rank Its position in the lexical list
     * @returns {any} a LexicalHit-shaped row
     */
    const lex = (id, rank) => ({ id, text: `m${id}`, source: null, metadata: null, tier: TIER_USER, charName: '', scope: USER_SCOPE, score: -1 - rank, rank });

    test('a memory both channels found outranks one only a single channel found', () => {
        const fused = fuseByRank([dense(1, 0.9), dense(2, 0.5)], [lex(2, 0), lex(3, 1)], 10);

        // 2 is in both lists, so its reciprocal ranks add. 1 and 3 each appear once.
        expect(fused[0].id).toBe(2);
    });

    test('🔴 a lexical-only memory still places, which is the entire point of the second channel', () => {
        // The measured case: "What happened when I was fourteen?" returned NOTHING above the dense floor.
        const fused = fuseByRank([], [lex(6, 0), lex(3, 1)], 10);

        expect(fused.map(h => h.id)).toEqual([6, 3]);
    });

    test('🔴 a lexical-only memory carries an infinite distance, never a fabricated one', () => {
        // The panel reports "best cos" off `distance`. A synthesized 0 there would claim a perfect vector
        // match for a memory the vector channel never returned.
        const [hit] = fuseByRank([], [lex(6, 0)], 10);

        expect(hit.distance).toBe(Number.POSITIVE_INFINITY);
    });

    test('a dense hit keeps its real distance through the fusion', () => {
        const [hit] = fuseByRank([dense(1, 0.42)], [], 10);

        expect(hit.distance).toBeCloseTo(0.42, 10);
    });

    test('k truncates the fused list', () => {
        const fused = fuseByRank([dense(1, 0.1), dense(2, 0.2), dense(3, 0.3)], [lex(4, 0)], 2);

        expect(fused).toHaveLength(2);
    });

    test('both channels empty fuses to nothing rather than throwing', () => {
        expect(fuseByRank([], [], 5)).toEqual([]);
    });

    test('🔴 ordering is by fused rank, not by distance', () => {
        // 2 is far away by cosine but top of the lexical list; 1 is nearest by cosine but absent lexically.
        // A merge that quietly re-sorted by distance at the end would undo the fusion entirely.
        const fused = fuseByRank([dense(1, 0.10), dense(2, 0.95)], [lex(2, 0)], 10);

        expect(fused.map(h => h.id)).toEqual([2, 1]);
    });
});

/**
 * 🔴 The lexical channel's relevance floor, which it shipped without.
 *
 * The dense channel has `minCosine`; this one admitted any row sharing a single ≥3-character non-stopword
 * term. That is worst at the bottom of the scale, where fts5 clamps a non-positive IDF to `1e-6`: every row
 * matching only corpus-common terms scores identically to the last bit, so `ORDER BY score` cannot rank them
 * and SQLite falls back to rowid. The lexical list becomes "the oldest matching memories, in insertion
 * order", injected with no cosine and reported as a successful recall.
 *
 * ⚠️ **AN ABSOLUTE BM25 CUTOFF WAS TRIED FIRST AND REVERTED**, and this suite is what caught it: BM25's
 * magnitude scales with corpus size, so a threshold that removes clamped rows from a large store removes real
 * ones from a small store. It discarded "Sampletown3" — unique in the whole fixture — and took nine tests with
 * it. The judgment has to be made on TERMS, against document frequency, before the MATCH exists.
 */
describe('🔴 informativeTerms — a term in half the corpus says nothing about which memory you want', () => {
    /** Twelve memories, eleven of which mention the workshop; one carries a term found nowhere else. */
    function seedCommonAndRare() {
        for (let i = 0; i < 11; i += 1) {
            remember(`Test User tidied the workshop bench on day ${i}.`, `the workshop; day ${i}`);
        }
        remember('The Sampletown3 regulator hangs above the workshop bench.', 'the Sampletown3 regulator');
    }

    test('a corpus-common term is dropped and a rare one is kept', () => {
        seedCommonAndRare();

        // "workshop" is in 12 of 12 live rows; "sampletown3" is in 1.
        expect(store.informativeTerms(['workshop', 'sampletown3'])).toEqual(['sampletown3']);
    });

    test('🔴 a question of nothing but common terms yields an EMPTY expression, so the channel abstains', () => {
        seedCommonAndRare();

        // The alternative is what shipped: twelve tied rows ordered by rowid, injected as a recall.
        // ⚠️ Every surviving term here really is corpus-common — "workshop" and "bench" are both in all
        // twelve rows. A first draft used "Anything new in the workshop?" and failed correctly: "new" is in
        // NO memory, so its document frequency is 0 and it is the most informative term imaginable. It simply
        // matches nothing, which is the channel answering rather than the floor rejecting.
        const expression = toMatchExpression('What about the workshop bench?', {
            keep: terms => store.informativeTerms(terms),
        });

        expect(expression).toBe('');
    });

    test('⚠️ a term in NO memory is informative, not common — document frequency 0 is the far end of the scale', () => {
        seedCommonAndRare();

        expect(store.informativeTerms(['mainspring'])).toEqual(['mainspring']);
    });

    test('🔴 the rare term still reaches MATCH through the same path, and finds its memory', () => {
        seedCommonAndRare();

        const expression = toMatchExpression('Tell me about the Sampletown3 in the workshop', {
            keep: terms => store.informativeTerms(terms),
        });

        expect(expression).toBe('"sampletown3"');
        expect(store.searchLexical(expression, 10, { scopes: [USER_SCOPE] })).toHaveLength(1);
    });

    test('⚠️ below the minimum corpus it drops NOTHING — "half the rows" needs rows to be half of', () => {
        // In a two-row store every term that matches anything is in half of it, so the rule would delete the
        // whole query. This is the guard that stops the floor eating small stores, which is exactly how the
        // rejected score-based version failed.
        remember('The Sampletown3 regulator hangs above the bench.', 'the Sampletown3 regulator');
        remember('Test User tidied the workshop bench.', 'the workshop');

        expect(store.informativeTerms(['sampletown3', 'workshop', 'bench']))
            .toEqual(['sampletown3', 'workshop', 'bench']);
    });

    test('an empty term list is answered without touching the database', () => {
        expect(store.informativeTerms([])).toEqual([]);
    });

    /**
     * 🔴 THE FLOOR IS MEASURED OVER THE WHOLE INDEX, BECAUSE THAT IS THE CORPUS fts5 SCORES AGAINST.
     *
     * This used to count `retired = 0 AND scope IN (…)` — the pool the SEARCH draws from — while `bm25()`
     * computes its IDF over `memories_fts`, an external-content index holding ALL of `memories`: retired rows
     * and every other scope. The two corpora disagree in both directions, and the guard was reading the one
     * that has no bearing on the clamp it exists to predict.
     *
     * Below: "workshop" is in 1 of this character's 2 live memories (in-scope frequency 50%, which the old
     * code dropped) but in only 1 of 21 indexed rows, so fts5's IDF for it is healthy and it ranks perfectly
     * well. It is a discriminating term, and it was being thrown away.
     */
    test('🔴 a term rare in the INDEX is kept even when it is common within this scope', () => {
        // Twenty memories about another character entirely — the rest of the index, none mentioning workshop.
        for (let i = 0; i < 20; i += 1) {
            store.addMemory({
                text: `Test Character 1 forged a hinge on day ${i}.`, indexLine: `a hinge; day ${i}`,
                tier: TIER_USER, charId: 'char-test-1', personaId: PERSONA,
            });
        }
        // Two of ours, one of which mentions the workshop: half of OUR scope, a twenty-first of the index.
        remember('Test User tidied the workshop bench.', 'the workshop');
        remember('Test User drinks his coffee black.', 'coffee, black');

        expect(store.informativeTerms(['workshop'])).toEqual(['workshop']);
    });

    test('🔴 a term in half the INDEX is dropped even where it is rare in this scope', () => {
        // The mirror image, and the one that produced tied rows ordered by rowid. "hinge" is in 20 of 21
        // indexed rows — fts5 clamps its IDF to 1e-6 whatever scope is being searched — but in 0 of ours, so
        // the old scoped count called it maximally informative and let it through.
        for (let i = 0; i < 20; i += 1) {
            store.addMemory({
                text: `Test Character 1 forged a hinge on day ${i}.`, indexLine: `a hinge; day ${i}`,
                tier: TIER_USER, charId: 'char-test-1', personaId: PERSONA,
            });
        }
        remember('Test User tidied the workshop bench.', 'the workshop');

        expect(store.informativeTerms(['hinge'])).toEqual([]);
    });

    test('retired memories count toward the floor, because nothing removes them from the fts5 index', () => {
        // Retirement is an UPDATE; the fts5 update trigger re-inserts. So a retired row is still in fts5's N
        // whether or not anyone wants it to be, and a guard predicting fts5 has to count what fts5 counts.
        const ids = [];
        for (let i = 0; i < 20; i += 1) {
            ids.push(remember(`Test User tidied the workshop bench on day ${i}.`, `the workshop; day ${i}`));
        }
        remember('Test User drinks his coffee black.', 'coffee, black');

        // Retire every workshop memory. They leave the SEARCH pool and stay in the INDEX.
        for (const id of ids) {
            store.retireMemory(id);
        }

        expect(store.informativeTerms(['workshop'])).toEqual([]);
    });
});
