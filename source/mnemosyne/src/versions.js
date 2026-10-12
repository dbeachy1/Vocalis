import { MEMORY_COLUMNS, hydrate } from './schema.js';

/** @typedef {import('./schema.js').MemoryRow} MemoryRow */
/** @typedef {import('./schema.js').StoredMemoryRow} StoredMemoryRow */
/** @typedef {import('./store.js').SqliteDatabase} SqliteDatabase */

/**
 * The three columns the chain itself is made of, as SQLite returns them.
 *
 * ⚠️ `retired` is an INTEGER (0 or 1) and `supersededBy` is `null` on a live row or on a memory retired with
 * no successor — the database's shapes rather than the ones a walk would choose. Both walks below test them
 * as exactly that (`=== 0`, `!== null`), and a `!row.retired` written against a boolean would be a different
 * function on the same data.
 *
 * @typedef {object} ChainRow
 * @property {number} id
 * @property {number} retired
 * @property {number|null} supersededBy
 */

/**
 * The memory version chain: how a memory is retired behind its replacement, how that history is walked, and
 * how it is undone.
 *
 * ## The one invariant, stated once for the whole module
 *
 * 🔴 **At most one row ever points at a given memory via `superseded_by`.** {@link retireMemory} keeps it with
 * `AND retired = 0` (a second supersession of the same row is a no-op, so the first one's pointer stands), and
 * {@link restoreMemory} keeps it by re-linking the predecessor before it clears its own pointer. Everything
 * here relies on it: it is what makes chains linear, which is what lets {@link versionsOf} read the previous
 * version with a single `.get()` instead of disambiguating a set.
 *
 * Both walks are nonetheless bounded by a seen-set. A `while` loop over a structure whose acyclicity is an
 * invariant kept in *another function* is one bug in that other place away from hanging the request that
 * renders a panel, and the cost of not finding out that way is a `Set`.
 *
 * ## Why free functions taking `db`, and not methods
 *
 * These five were methods on `MemoryStore`, which owns rather more than they need: the connection and crypto
 * lifecycle, schema migration, memory CRUD, the vector tables, and chat lifecycle. The chain is the coherent
 * piece that comes away cleanly — it touches exactly two things, the `memories` table and the per-model vector
 * tables, and both can be handed in.
 *
 * ⚠️ **`tables` is passed in, never computed here.** The caller reads its vector tables BEFORE opening a
 * transaction, as it always did: the model registry is not what these functions are mutating, and
 * `CREATE VIRTUAL TABLE` has no business inside a data transaction. A module that looked the tables up itself
 * would quietly move that read inside the transaction of whichever caller forgot.
 *
 * ⚠️ **Nothing here asserts the store is open.** `MemoryStore` does that at its own boundary, where the error
 * message can say something true about the vault being locked. These take a live `db` or they are a
 * programming error.
 *
 * ## 🔴 The BigInt rule
 *
 * Every rowid and every `retired` value bound against a vector table goes as a **BigInt**. better-sqlite3
 * binds a JS number via `sqlite3_bind_double`, so vec0 sees a FLOAT where it demands an integer and rejects it
 * with the actively misleading *"Only integers are allows for primary key values"* [sic]. Ordinary tables hide
 * this behind INTEGER affinity and coerce silently; virtual tables do not. The same trap applies to the
 * `retired` INTEGER **metadata** column (*"Expected integer for INTEGER metadata column retired, received
 * FLOAT"*). The full note lives on `MemoryStore.#vectorTables`, which is where the table list comes from.
 */

/**
 * Which of these memories have at least one earlier version behind them.
 *
 * One query for a whole page, so the browse view can decide where to draw the "earlier versions"
 * affordance without walking a chain per row. 🔴 The walk itself ({@link versionsOf}) is only worth paying
 * for on the rows that have something to walk, and `superseded_by` carries no index — on a personal store
 * that is a scan of a few thousand rows and nobody notices, but doing it twenty times per click, on every
 * click, is how a panel that felt instant stops being one.
 *
 * @param {SqliteDatabase} db An open better-sqlite3 database
 * @param {number[]} ids
 * @returns {Set<number>} the subset that something points at
 */
export function havePredecessors(db, ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return new Set();
    }

    // ⚠️ The cast names `superseded_by`'s ALIAS, not its column: what comes back is the id of a memory that
    // something points AT, which is the question this function answers. Read it as `memories.id` and the
    // meaning inverts while the shape stays identical — the reason the claim is written beside the query.
    const rows = /** @type {{ id: number }[]} */ (db.prepare(
        `SELECT DISTINCT superseded_by AS id FROM memories WHERE superseded_by IN (${ids.map(() => '?').join(', ')})`,
    ).all(...ids));

    return new Set(rows.map(r => r.id));
}

/**
 * The `source` of each of these memories, by id.
 *
 * 🔴 For the browse view this answers "why is this row retired", and the row it has to ask about is the
 * **successor**, not the retired row itself. A retired memory still carries the source it was *written*
 * with — `auto`, `manual`, null — which says how it was created and nothing about how it was replaced;
 * `reviseMemory` stamps `edit` on the new row, so the reason lives one link forward. One query for a whole
 * page, because a successor may well be on a different page and cannot be read off the rows in hand.
 *
 * @param {SqliteDatabase} db An open better-sqlite3 database
 * @param {number[]} ids
 * @returns {Map<number, string|null>}
 */
export function sourcesOf(db, ids) {
    // 🔴 THE SAME GUARD ITS SIBLING OPENS WITH. `havePredecessors`, twenty lines up, begins
    // `if (!Array.isArray(ids) || ids.length === 0) return new Set();` — same caller (the panel's browse
    // view), same call shape, same argument. This one went straight to `ids.filter(...)` and threw a bare
    // `TypeError: ids.filter is not a function` on anything that was not an array, including the
    // `undefined` a caller gets from a row with no versions. Two functions answering two halves of one
    // question should not disagree about what an absent list means.
    if (!Array.isArray(ids)) {
        return new Map();
    }

    const wanted = [...new Set(ids.filter(id => Number.isInteger(id)))];

    if (wanted.length === 0) {
        return new Map();
    }

    const rows = /** @type {{ id: number, source: string|null }[]} */ (db.prepare(
        `SELECT id, source FROM memories WHERE id IN (${wanted.map(() => '?').join(', ')})`,
    ).all(...wanted));

    return new Map(rows.map(r => /** @type {[number, string|null]} */ ([r.id, r.source])));
}

/**
 * The earlier versions of a memory, newest first — the chain that led to this one.
 *
 * Walks `superseded_by` **backward**: the row that this memory replaced, then the row that one replaced,
 * and so on. Both causes of supersession are in here together and that is the point (fork panel design
 * §14.2) — a correction ingest made and a correction the user typed are one history, distinguished by
 * `source` rather than by living in separate tables.
 *
 * 🔴 The single `.get()` per step is what the module header's invariant buys; the seen-set is why not
 * trusting it costs nothing.
 *
 * @param {SqliteDatabase} db An open better-sqlite3 database
 * @param {number} memoryId The memory whose history is wanted
 * @param {number} [limit] Stop after this many, newest first
 * @returns {MemoryRow[]} earlier versions, most recent first; empty if this memory replaced nothing
 */
export function versionsOf(db, memoryId, limit = 50) {
    const previous = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE superseded_by = ?`);
    const seen = new Set([memoryId]);
    /** @type {MemoryRow[]} */
    const chain = [];

    let current = memoryId;

    while (chain.length < limit) {
        const row = /** @type {StoredMemoryRow|undefined} */ (previous.get(current));

        if (!row || seen.has(row.id)) {
            break;
        }

        seen.add(row.id);
        chain.push(hydrate(row));
        current = row.id;
    }

    return chain;
}

/**
 * Retire a memory, optionally recording which memory supersedes it.
 *
 * 🔴 Retirement is NOT deletion (schema.js, DESIGN_INGEST §5.3). The row and its vectors stay; the memory is
 * only marked so `search` stops returning it. This is deliberate: ingest supersedes on a similarity
 * guess, and a wrong guess must be recoverable — in a roleplay "no longer true" is story, and
 * `deleteMemory` (which really destroys text) is too sharp an instrument for it. Only a live memory can
 * be retired; retiring an already-retired one is a no-op, so the first supersession's `superseded_by` stands.
 *
 * @param {SqliteDatabase} db An open better-sqlite3 database
 * @param {string[]} tables Every registered model's vector table, read before the transaction
 * @param {number} memoryId The memory to retire
 * @param {number|null} [supersededById] The memory that replaces it, or null if simply retired
 * @returns {boolean} true if a live memory was retired, false if no live memory had that id
 */
export function retireMemory(db, tables, memoryId, supersededById = null) {
    // 🔴 A MEMORY CANNOT SUPERSEDE ITSELF. Nothing validated this, and `retireMemory(5, 5)` wrote
    // `id=5, superseded_by=5` — a self-loop that `havePredecessors` reports as "this row has earlier
    // versions", so the panel renders the history expander, while `versionsOf(5)` returns `[]` because its
    // seen-set breaks on the first step. An expander that opens onto nothing.
    //
    // Not reachable from today's API — `placeCandidate` always passes the freshly-stored id — so this is a
    // guard against the next caller rather than a live defect. It is cheap, and the failure it prevents is
    // one that looks like a rendering bug and is actually a corrupt chain.
    if (supersededById !== null && supersededById === memoryId) {
        throw new TypeError(`retireMemory: a memory cannot supersede itself (id ${memoryId})`);
    }

    return db.transaction(() => {
        const retired = db.prepare(
            'UPDATE memories SET retired = 1, superseded_by = ? WHERE id = ? AND retired = 0',
        ).run(supersededById, memoryId).changes > 0;

        if (!retired) {
            return false;                 // already retired, or no such memory — leave the vectors alone
        }

        // 🔴 The flag is mirrored into every vector table because that is where `search` reads it: as
        // a vec0 metadata column filtered before `k`. Updating only `memories` would leave a retired memory
        // fully searchable. This is exactly why `retired` is a metadata column and `character` is the
        // partition key and not the other way round — vec0 permits UPDATE on the former, rejects it on the
        // latter. `retired` binds as BigInt for the same reason it does in `addVector` (module header).
        for (const table of tables) {
            db.prepare(`UPDATE ${table} SET retired = ? WHERE rowid = ?`).run(1n, BigInt(memoryId));
        }

        return true;
    })();
}

/**
 * Bring a retired memory back, retiring whatever currently stands in its place.
 *
 * The undo for both kinds of supersession — a similarity guess ingest got wrong, and an edit the user
 * regrets — because `MemoryStore.reviseMemory` deliberately made them the same chain.
 *
 * 🔴 **The revived row's own `superseded_by` MUST be cleared.** A was retired by C; the user restores A;
 * A goes live and C is retired pointing at A. If A still points at C the chain is a two-element cycle,
 * and anything walking version history — {@link versionsOf}, the panel's expander, a future prune —
 * loops for ever. This is the one line in this function that has no visible symptom until something hangs.
 *
 * ⚠️ **The head of the chain is retired, not the direct successor.** Restoring A means "A is the truth
 * now", and after A→B→C the live memory is C, not B. Retiring B would be a no-op (it is already retired)
 * and would leave both A and C live: one statement and its correction, both searchable, contradicting each
 * other in the same prompt. So the walk goes forward to whatever is actually live and retires that.
 *
 * 🔴 **The revived row's `source` becomes `restore`, and the panel needs it to.** The browse view answers
 * "why is this row retired" from the SUCCESSOR's source (see {@link sourcesOf}) — so after a restore, the
 * row that stood down is described by whatever source the revived row happened to carry. Leaving an
 * auto-extracted memory's `auto` in place made the panel say "replaced as the story moved on" about a row
 * the *user* had just replaced by hand, which is the black-box impression the whole history feature exists
 * to remove. `reviseMemory` already sets this precedent: `source` records how a row came to be current, and
 * how its text was first written stays recoverable from the chain either way.
 *
 * @param {SqliteDatabase} db An open better-sqlite3 database
 * @param {string[]} tables Every registered model's vector table, read before the transaction
 * @param {number} memoryId The retired memory to bring back
 * @returns {{ id: number, retiredId: number|null }|null} what was restored and what stood down for it, or
 *   null if no RETIRED memory had that id
 */
export function restoreMemory(db, tables, memoryId) {
    const forward = db.prepare('SELECT id, retired, superseded_by AS supersededBy FROM memories WHERE id = ?');

    return db.transaction(() => {
        const row = /** @type {ChainRow|undefined} */ (forward.get(memoryId));

        if (!row || row.retired === 0) {
            // Never existed, or is already live — the second being a double-click on a stale panel, whose
            // intent has already been carried out. Neither is an error.
            return null;
        }

        // Walk forward to the live head. Bounded by a seen-set for the same reason `versionsOf` is: the
        // chain is linear by construction, and a loop that trusts an invariant kept in another function is
        // one bug away from hanging a request.
        const seen = new Set([memoryId]);
        let head = row;

        while (head.retired !== 0 && head.supersededBy !== null && !seen.has(head.supersededBy)) {
            seen.add(head.supersededBy);
            const next = /** @type {ChainRow|undefined} */ (forward.get(head.supersededBy));

            if (!next) {
                break;                    // the chain names a memory that was deleted outright; stop here
            }

            head = next;
        }

        // A memory retired with no successor at all (`retireMemory(id, null)`) has nothing to stand down.
        const retiredId = head.retired === 0 && head.id !== memoryId ? head.id : null;

        if (retiredId !== null) {
            // 🔴 RE-LINK THE PREDECESSOR FIRST, OR RESTORING A MID-CHAIN VERSION FORKS THE HISTORY.
            //
            // The chain's invariant — stated in this module's header and relied on by `versionsOf` — is that
            // AT MOST ONE row ever points at a given memory. Restoring the TAIL keeps that for free. Restoring
            // a middle version did not:
            //
            //   revise(A) -> B, revise(B) -> C   leaves   A.superseded_by = B,  B.superseded_by = C,  C live
            //
            // Restore B: the walk finds the live head C, `retireMemory(C, B)` sets C.superseded_by = B, and
            // B's own pointer is cleared below. Now BOTH A and C point at B. `versionsOf` reads
            // `WHERE superseded_by = ?` with `.get()` — one row, in rowid order — so it returns A and C
            // silently vanishes from the history. C's text is still stored and still appears in a
            // `includeRetired` listing, but it is unreachable from the panel's walk and from this function's
            // own forward walk, so it can never be restored again.
            //
            // Handing A's pointer to C instead makes the chain linear again — B (live) <- C <- A — which is
            // also the truthful order: C was the most recent version before B was brought back.
            //
            // The panel reaches this with any retired id (`POST /memory/:id/restore` accepts one), and the
            // history view is exactly where a user picks a middle version, so this is a normal path.
            db.prepare('UPDATE memories SET superseded_by = ? WHERE superseded_by = ? AND id != ?')
                .run(retiredId, memoryId, retiredId);

            retireMemory(db, tables, retiredId, memoryId);
        }

        // 🔴 `superseded_by = NULL` in the same statement that clears `retired`. See the cycle note above.
        // `source` goes with them for the reason in the header: it is what tells the panel who retired the
        // row that just stood down.
        db.prepare('UPDATE memories SET retired = 0, superseded_by = NULL, source = ? WHERE id = ?')
            .run('restore', memoryId);

        // The flag is mirrored into every vector table because that is where `search` reads it — the exact
        // mirror of what `retireMemory` does, and `0n` for the same BigInt reason (module header).
        for (const table of tables) {
            db.prepare(`UPDATE ${table} SET retired = ? WHERE rowid = ?`).run(0n, BigInt(memoryId));
        }

        return { id: memoryId, retiredId };
    })();
}
