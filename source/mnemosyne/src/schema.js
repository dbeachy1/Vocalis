/**
 * The schema — and the one idea it exists to encode.
 *
 * 🔴 A VECTOR IS AN INDEX INTO A MEMORY. IT IS NOT THE MEMORY.
 *
 * The memory is the text. The vector is one model's opinion about where that text sits in a space that model
 * invented, and it is disposable: given the text, any vector can be rebuilt at any time. Get this backward
 * and every model change becomes a data-loss event. Get it right and a model change is a background job.
 *
 * Everything below follows from that:
 *
 *   memories        the durable truth. Text and identity. Never deleted because a model changed. A memory can be
 *                   `retired` (superseded, not deleted) — still stored, just excluded from search.
 *   embedding_models one row per model that has ever embedded anything here. Names its vector table.
 *   vec_<n>         one virtual table per model. Holds vectors for that model and nothing else.
 *   ingest_state    one row per chat: the automatic-ingest high-water mark, last-run time, and the
 *                   fresh-turn count at the last FAILED attempt (0 when the last one succeeded).
 *
 * ## Why one table per model, and not a `model` column
 *
 * Not a style choice — `vec0` makes it structural. The dimension is baked into the table's declaration:
 *
 *     CREATE VIRTUAL TABLE vec_1 USING vec0(embedding float[768])
 *
 * `float[768]` is part of the schema. A 384-dimension vector cannot go in that table at all, so two models
 * of differing dimension could never share one. And two models of the SAME dimension must not share one
 * either, which is the more dangerous case: nothing would error. The vectors would mingle, the arithmetic
 * would run, and search would return ten confidently-ranked results drawn from two incompatible coordinate
 * systems. Silently, for ever. One table per model makes that unrepresentable rather than merely forbidden.
 *
 * SillyTavern reached the same conclusion by a different road: its own vector storage lives at
 * `vectors/<source>/<collectionId>/<model>` (`src/endpoints/vectors.js`, via `getModelScope()`), so a model
 * change lands in a different directory and the old index is simply never consulted. Same answer, and it is
 * the only answer that works.
 *
 * ## What a model change costs
 *
 * A new row in `embedding_models`, a new empty vector table, and a re-embed that reads text out of
 * `memories` and writes vectors into the new table. The old table stays until someone drops it — it costs
 * disk and nothing else, and it means switching back is free. **No memory is ever lost to a model change**,
 * because the text was always the thing being kept.
 */

/**
 * Bump when the shape below changes in a way an existing database cannot simply be opened with.
 *
 * History:
 *   1 → memories / embedding_models / meta, one vec table per model.
 *   2 → memories gains `retired` + `superseded_by` (write-time supersession, DESIGN_INGEST §5.3), and a new
 *       `ingest_state` table holds the automatic-ingest high-water marks.
 *   3 → character scoping moves INTO vec0. `memories.character` becomes a real column (was buried in the
 *       metadata JSON), and each vector table gains a `character` partition key plus a `retired` metadata
 *       column, so both filters run BEFORE vec0 applies `k`.
 *   4 → identity stops being a display name, and scoping becomes two-tier. `memories.character` (the
 *       character's NAME) is replaced by `char_id` / `persona_id` / `chat_id` / `tier`, and the vec0
 *       partition key becomes the composed {@link scopeKey} derived from them. `char_name` survives as a
 *       display cache and nothing keys on it ever again. See "Identity" below.
 *   5 → what is EMBEDDED stops being what is INJECTED. `memories` gains `index_line`: a one-sentence
 *       distillation the extractor writes alongside the memory, which is what gets embedded, while `text`
 *       stays the full paragraph that gets injected. See {@link embedText} for why.
 *   6 → automatic ingest stops having ANY wall-clock logic. `ingest_state` gains `failed_at_turns`, which
 *       splits a field that had two unrelated jobs: `last_run` throttled ingestion and backed off a failing
 *       backend. The backoff now uses the turn count tracked by the trigger, independently of typing speed.
 *       See INGEST_DEFAULTS.
 *
 * ⚠️ **v6 is here and the FTS5 lexical index is NOT, and that difference is the rule.** The index arrived in
 * the same week without a bump because it stores no truth: it is derived from `memories` and rebuildable
 * from it, so an older store is backfilled rather than refused. This one changes what a stored row MEANS —
 * `last_run` no longer implies "and therefore do not run again yet" — which is exactly what the guard is for.
 *
 * 🔴 **There is no migration path, on purpose.** `MemoryStore.#migrate` REFUSES to open a database stamped
 * below this version rather than upgrading it. v1–v3 databases keyed their vectors on a display name, so an
 * upgrade would have to invent a `charId` for each one and guess a tier for every memory ever written — and
 * a wrong guess on the tier is precisely the cross-chat leak this version exists to prevent. Mnemosyne is
 * pre-release and there are no such databases; writing migration code for data that does not exist would be
 * inventing the risk it was meant to avoid. Delete the file and let it be recreated.
 */
export const SCHEMA_VERSION = 6;

/**
 * What to hand the embedder for a memory: its distilled index line when it has one, otherwise its text.
 *
 * ## 🔴 A VECTOR IS AN INDEX INTO A MEMORY, AND v5 IS THAT SENTENCE TAKEN LITERALLY
 *
 * The vector is an index and the text is the memory. Using the same string for both lets a multi-topic memory
 * embed toward an average of its subjects and match none well. The indexed sentence focuses retrieval while
 * the stored paragraph retains the complete memory.
 *
 * The richer the memory, the worse this gets, which is the perverse part: improving extraction made recall
 * WORSE. A one-topic vector is a direction; a four-topic vector is a centroid.
 *
 * So the extractor now writes two things — the paragraph a future conversation should READ, and a short
 * line naming what it is ABOUT — and they go to different places. The line is embedded and nothing else
 * ever sees it; the paragraph is injected and never embedded.
 *
 * ⚠️ **Do NOT answer a low score by lowering `minCosine`.** 0.232 really is a poor match for a query naming
 * the memory's own subject; a floor wide enough to admit it admits every unrelated memory at the same
 * distance. Fix what is embedded, not what is accepted.
 *
 * ⚠️ **Empty means "no line", and it is a legitimate state rather than a defect.** A memory written by hand
 * through `POST /memory`, or by any pre-v5 path, has no distillation and embeds its own text — which is
 * exactly today's behavior and is correct for a short curated memory. That is why the column defaults to
 * `''` and why this function exists at all: every embedding site calls it, so "which string gets embedded"
 * is decided once instead of five times. The sites are `ingest/index.js`, both routes in `api/memories.js`,
 * and the re-embed worklist — and a re-embed that used a different rule than the original write would file
 * a vector in coordinates nothing searches from.
 *
 * @param {{ indexLine?: string|null, text: string }} memory
 * @returns {string} the string to embed
 */
export function embedText({ indexLine, text }) {
    return typeof indexLine === 'string' && indexLine.trim() !== '' ? indexLine : text;
}

/**
 * ## Identity: three axes, and not one of them is a name
 *
 * A memory belongs to a *relationship*, and a relationship needs stable ends. Until v4 the character end was
 * `charName` — the display name — which is not an identity at all:
 *
 *   - **It does not survive a rename.** SillyTavern's `POST /api/characters/rename` rewrites the card, the
 *     avatar filename AND the chats folder, then deletes the old PNG. Every handle changes at once. Because
 *     the character is a vec0 *partition key* (evaluated before `k`, which is the whole point of it), the old
 *     memories do not merely rank lower — they become **unreachable**, and ingest starts a fresh partition
 *     under the new name. Nothing warns; the symptom is "the character has forgotten everything", days later.
 *   - **The avatar filename is no better.** Rename changes that too — SillyTavern hand-migrates every
 *     avatar-keyed subsystem (tags, lore, author's notes) precisely because it is not stable.
 *   - **Names are not unique.** Two cards may share one, and they collapsed into a single partition. That is
 *     a *write* bug, not just a recall one: one character's memory could `supersede()` another's.
 *   - **And a rename genuinely means "same character."** ST preserves the card, the entire chat history, tags,
 *     lorebook and group memberships across one, and offers to rewrite the name inside every past message.
 *     Memory treating it as a new identity would make it the only subsystem in SillyTavern that does.
 *
 * So the fork mints what SillyTavern never had (fork `DESIGN_MEMORY_PLUGIN_API.md` §22), and we key on it:
 *
 *   `charId`     an opaque per-install UUID the fork keeps in its own `character-ids.json`, re-keyed inside
 *                the same operation that renames the PNG. 🔴 The fork can key on the avatar filename safely
 *                precisely because the fork is what changes it. A plugin cannot see a rename happen.
 *   `personaId`  SillyTavern's `user_avatar`, surfaced as-is — nothing is minted. Persona storage got this
 *                right by accident: a persona avatar is named `${Date.now()}.png`, and there is no rename
 *                endpoint for one at all. **One filename encodes identity, the other encodes a display name.**
 *   `chatId`     the per-chat id, already used for the ingest high-water mark.
 *
 * `charName` still arrives and is still used — in the extraction prompt, where a human-readable name is
 * exactly right, and in this table as a display cache refreshed on every write. ⚠️ **A name stored for
 * display is a cache, not a record.** After v4 every name anywhere in this store is either prose or a stale
 * label, and nothing may key on one.
 */

/** A memory about the person on the other side of the screen. Keyed `(charId, personaId)`; crosses every chat. */
export const TIER_USER = 'user';

/** A memory about what happened in one story. Keyed `chatId`; dies with the chat. */
export const TIER_SCENARIO = 'scenario';

/**
 * ## The two tiers, and why one scope was wrong
 *
 * The case that breaks a single scope: the same character in two chats, one in ancient Egypt and one in
 * space. Scenario facts must not cross. Facts about *the user* must.
 *
 * | Kind of fact | Example | Key | Lifetime |
 * |---|---|---|---|
 * | About the user | "Test User prefers quiet evenings" | `(charId, personaId)` | crosses every chat |
 * | About the scenario | "we stole the scarab in Sample City 4" | `chatId` | dies with the chat |
 *
 * The first tier is the reason this plugin exists — a character who remembers *you* between conversations.
 * The second is what stops that becoming nonsense.
 *
 * 🔴 **`personaId` is not an optional refinement.** Two personas are two different people to the same
 * character. Separate personas must not surface one persona's private memories in another. On the character
 * axis a scoping error costs recall quality; **here it costs the user's
 * privacy** — the same argument that scopes the dedup/supersession search and not merely retrieval.
 *
 * This also *reverses* a v3-era decision (DESIGN_INGEST §8 item 3), and the reversal is the point rather than
 * a change of mind. Back then `subject: user` memories were refused a cross-chat life because there was only
 * one axis, so carrying them across would have leaked one persona's fiction into another's. Adding the
 * persona axis removes that objection exactly: the fact now travels with the persona it belongs to.
 *
 * @param {{ tier: string, charId?: string|null, personaId?: string|null, chatId?: string|null }} identity
 * @returns {string} The vec0 partition value
 */
export function scopeKey({ tier, charId = null, personaId = null, chatId = null }) {
    if (tier === TIER_USER) {
        return `u:${part(charId)}:${part(personaId)}`;
    }
    if (tier === TIER_SCENARIO) {
        return `s:${part(chatId)}`;
    }

    // No default tier. A memory whose tier nobody stated has no defensible lifetime — guessing "user" leaks
    // one story into another and guessing "scenario" silently discards the cross-chat memory that is the
    // product. Callers state it; this throws rather than choose.
    throw new TypeError(`scopeKey requires tier '${TIER_USER}' or '${TIER_SCENARIO}', got ${JSON.stringify(tier)}`);
}

/**
 * One component of a scope key, escaped so the composition is injective.
 *
 * 🔴 The escaping is not fussiness. `u:<charId>:<personaId>` with an unescaped separator means two different
 * identities can compose to the same partition string — which is a scoping collision, the exact bug class v4
 * exists to end, arriving by a different door. `%` first, then `:`, so the escape is reversible in principle
 * and unambiguous in practice. (`encodeURIComponent` is NOT usable here: it leaves `:` untouched.)
 *
 * A missing id becomes `''` — a real, distinct partition meaning "no character" or "no persona", never a
 * license to match anything. See {@link scopeKey}'s totality note in MemoryStore.search.
 *
 * @param {string|null} value One identity axis, as {@link scopeKey} destructured it
 * @returns {string} the escaped component, or `''` when there is no id
 */
function part(value) {
    return typeof value === 'string' ? value.replace(/%/g, '%25').replace(/:/g, '%3A') : '';
}

/**
 * The two partitions a generation should recall from: this persona's durable facts about themselves, and
 * this chat's story so far.
 *
 * Both, always — they are the two halves of one answer, and which half a given memory landed in was the
 * extractor's call rather than the caller's. A caller that passed only one would silently retrieve half a
 * memory store.
 *
 * @param {{ charId?: string|null, personaId?: string|null, chatId?: string|null }} identity
 * @returns {string[]} Partition values for {@link MemoryStore.search}
 */
export function retrievalScopes({ charId = null, personaId = null, chatId = null } = {}) {
    return [
        scopeKey({ tier: TIER_USER, charId, personaId }),
        scopeKey({ tier: TIER_SCENARIO, chatId }),
    ];
}

/**
 * Tables that exist exactly once, regardless of how many models have been used.
 *
 * Note what is NOT here: any vector table. Those are per-model and created on demand by
 * {@link vectorTableDdl}, because their dimension is not known until a model introduces itself.
 */
export const BASE_DDL = [
    // The durable truth. If this survives, everything else can be rebuilt.
    //
    // `retired` / `superseded_by` are supersession, not deletion (DESIGN_INGEST §5.3): when ingest decides a
    // newer memory replaces an older one, the old row is marked `retired = 1` with `superseded_by` pointing at
    // the replacement. Retired rows are excluded from search but keep their text and vectors, because in a
    // roleplay "no longer true" is story, and destroying it on a similarity guess is not recoverable.
    //
    // 🔴 `tier` / `char_id` / `persona_id` / `chat_id` are the identity (see above), and `scope` is the single
    // value composed from them by {@link scopeKey} — the vec0 partition key. `scope` is STORED rather than
    // derived at read time for the same reason `character` was promoted to a column in v3: a partition value
    // needs an authoritative source to be rebuilt from, and every vector table's partition is rebuilt from
    // this one. It is written only by `addMemory`, only ever through `scopeKey`, so it cannot drift from the
    // axes it was composed of.
    //
    // ⚠️ `char_name` is a DISPLAY CACHE and nothing may key on it. It is refreshed on every write (charName
    // arrives on every generation, so it is free) and is last-known, not authoritative.
    // ⚠️ `index_line` is what gets EMBEDDED; `text` is what gets INJECTED. They are separate columns rather
    // than one field with two readers because they are two different jobs — see {@link embedText}. It is NOT
    // NULL DEFAULT '' rather than nullable so that "the extractor wrote no distillation" and "this memory was
    // typed in by hand" are the same state and read the same way; nothing branches on which of the two it is.
    `CREATE TABLE IF NOT EXISTS memories (
        id            INTEGER PRIMARY KEY,
        text          TEXT    NOT NULL,
        index_line    TEXT    NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        source        TEXT,
        metadata      TEXT,
        tier          TEXT    NOT NULL DEFAULT '${TIER_SCENARIO}',
        char_id       TEXT    NOT NULL DEFAULT '',
        persona_id    TEXT    NOT NULL DEFAULT '',
        chat_id       TEXT    NOT NULL DEFAULT '',
        char_name     TEXT    NOT NULL DEFAULT '',
        scope         TEXT    NOT NULL DEFAULT '',
        retired       INTEGER NOT NULL DEFAULT 0,
        superseded_by INTEGER
    )`,

    // Storage is unbounded by requirement (FR2), and every management read filters on `scope` — so this is the
    // one index the table earns. The vector tables need no equivalent: partitioning IS their index.
    'CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope)',

    // Scenario memories die with their chat (see the tier table above), which is a delete keyed on `chat_id`
    // across every tier — see `MemoryStore.forgetChat`.
    'CREATE INDEX IF NOT EXISTS memories_chat ON memories(chat_id)',

    // ## The lexical half of retrieval (FTS5 + BM25)
    //
    // 🔴 **A DENSE VECTOR AND A KEYWORD INDEX FAIL ON DIFFERENT QUERIES, AND THAT IS THE ENTIRE ARGUMENT.**
    // In a representative query set, top-4 contained 9 wanted memories from dense search, 10 from lexical search,
    // and 13 after fusion. The two rows that make the case are opposites — a family-relation query finds nothing
    // lexically, because no memory contains the word "dad", and *"What happened when I was fourteen?"*
    // returns nothing dense at all, because the index lines do not mention the age and the query falls
    // under `minCosine`. Either channel alone loses one of those; together they lose neither. Pooled
    // sentence embeddings are structurally weak on rare tokens — a specific place name like "Sampletown3" barely
    // moves a mean-pooled vector — which is exactly the content a roleplay memory is made of.
    //
    // 🔴 **THIS DID NOT BUMP `SCHEMA_VERSION`, DELIBERATELY — AND TWO COMMITS LATER SOMETHING ELSE DID.**
    // The intent was sound and is worth keeping written down: the version guard refuses to open an older
    // store and tells the user to delete it, which is right for a change to what a column MEANS and wrong
    // for this table, which holds no truth of its own. It is an index derived from `memories` and rebuildable
    // from it at any time, so a v5 store could gain it, be backfilled, and lose nothing.
    //
    // ⚠️ **THAT IS NO LONGER WHAT HAPPENS, AND THE SENTENCE USED TO CLAIM IT STILL WAS.** This table landed in
    // `1a78d38` while `SCHEMA_VERSION` was 5; `a0768a6` then took it to 6 for an unrelated reason. `#migrate`
    // refuses any file stamped below the current version BEFORE it reaches the DDL, so a v5 store — the entire
    // population the backfill was written for — is now told to delete itself, and the backfill in `store.js`
    // can only ever run on a store that is brand new and empty, where `'rebuild'` is a no-op. The care taken
    // here bought nothing in the end; it is left intact because the reasoning is right and the next derived
    // table should follow it, not because it is currently doing any work.
    //
    // ⚠️ `content='memories'` is an EXTERNAL-CONTENT table: it stores the inverted index and not a second
    // copy of the text. That matters more than usual here, because every byte of this database is encrypted
    // and the copy would have been a second encrypted copy of the same private sentences.
    //
    // ⚠️ External content means the table does not carry `scope` or `retired`, so both filters live in a
    // JOIN back to `memories`. Unlike the vec0 search above, that is CORRECT rather than a trap: `k` in a
    // vec0 query is a MATCH constraint applied during the scan, so a predicate evaluated after it returns
    // short — but FTS5's `LIMIT` is an ordinary SQL limit applied to the finished result set, so filtering
    // before it loses nothing.
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        index_line,
        text,
        content='memories',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
    )`,

    // 🔴 An external-content FTS5 table is NOT maintained automatically. Without these three triggers it is
    // populated once and then silently drifts: new memories are unfindable lexically, edited ones match on
    // their old wording, and deleted ones keep matching for ever. Nothing reports it, because every query
    // still succeeds and simply returns the wrong set.
    //
    // ⚠️ The `'delete'` command rows are the documented way to retract a row from an external-content index,
    // and they must be given the OLD column values — FTS5 uses them to locate the tokens it is unindexing.
    // Passing `new.*` there corrupts the index in a way that only shows up as missing search results later.
    `CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, index_line, text) VALUES (new.id, new.index_line, new.text);
    END`,
    `CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, index_line, text)
            VALUES ('delete', old.id, old.index_line, old.text);
    END`,
    `CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, index_line, text)
            VALUES ('delete', old.id, old.index_line, old.text);
        INSERT INTO memories_fts(rowid, index_line, text) VALUES (new.id, new.index_line, new.text);
    END`,

    // 🔴 One row per model that has ever embedded anything in this database, and rows are never rewritten
    // to point at a different table. `id` is what names the vector table, so reusing an id would silently
    // adopt another model's vectors as your own.
    `CREATE TABLE IF NOT EXISTS embedding_models (
        id          INTEGER PRIMARY KEY,
        model       TEXT    NOT NULL UNIQUE,
        dimension   INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
    )`,

    // Schema version and anything else that is about the database rather than in it.
    `CREATE TABLE IF NOT EXISTS meta (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL
    )`,

    // Automatic-ingest bookkeeping: how far into each chat extraction has already read (the high-water mark)
    // and when it last ran, so the every-N-messages trigger and the failure backoff survive restarts and
    // lock/unlock.
    // `chat_key` is an opaque per-chat string the caller supplies; the store never interprets it. Living inside
    // the encrypted database is the point — the mark is as private as the memories it governs.
    // 🔴 `failed_at_turns` IS A TURN COUNT, NOT A TIMESTAMP, AND THAT IS THE WHOLE POINT.
    //
    // Ingestion has no wall-clock pacing or retry logic. Backoff uses the same turn-count axis as the trigger,
    // so identical conversation content does not behave differently based on typing speed.
    //
    // The problem a backoff solves is real: the trigger is a fresh-turn count, and after a failure the mark
    // does not advance, so that count only grows. A persistent fault (backend down, a fork with no
    // `generate`) would otherwise fire a full extraction on EVERY generation, for ever, each one burning a
    // GPU pass that competes with the user's own reply. But the fix belongs on the SAME AXIS as the trigger:
    // remember how many fresh turns there were when the attempt failed, and require a further
    // `retryBackoffTurns` before trying again. Ten minutes of silence changes nothing; ten more messages do.
    //
    // ⚠️ 0 means "the last attempt did not fail", which is the common case and the default for a fresh row.
    // A successful run clears it by omission — see `setIngestState`.
    `CREATE TABLE IF NOT EXISTS ingest_state (
        chat_key        TEXT    PRIMARY KEY,
        high_water      INTEGER NOT NULL,
        last_run        INTEGER NOT NULL,
        failed_at_turns INTEGER NOT NULL DEFAULT 0
    )`,
];

/**
 * What the extractor tagged a memory with, parsed back from the JSON column.
 *
 * 🔴 **Deliberately an open bag, and the openness is not laziness.** `POST /memory` accepts whatever object a
 * caller sends (`api/memories.js`), and automatic ingest writes four keys of its own — `type`, `importance`,
 * `subject` and `extractedAt` (`ingest/placement.js`). Declaring only those four would make the annotation
 * false for every hand-written memory, and declaring them as required would make it false for every memory
 * written before ingest existed. A reader takes a value out of here and proves what it is; nothing in this
 * plugin may branch on a metadata key without checking it first.
 *
 * ⚠️ Identity is NOT in here and must not come back. It was, before v4; it is four real columns now, and a
 * second copy in a JSON blob is a second copy to disagree with the first.
 *
 * @typedef {Record<string, unknown>} MemoryMetadata
 */

/**
 * A memory as everything outside `store.js` sees it: exactly {@link MEMORY_COLUMNS}, with `metadata` already
 * parsed by {@link hydrate}.
 *
 * 🔴 **One type because there is one shape, and the panel is why that matters.** Four queries return "a
 * memory" — the browse listing, the single row read back after an edit, the version chain, and the row an
 * edit reads before revising it — and the panel renders a list and a single row with the same functions. The
 * column list was already shared for that reason; this is the same argument reaching the type.
 *
 * ⚠️ `retired` is an INTEGER out of SQLite (0 or 1), not a boolean, and `supersededBy` is `null` on a live
 * row. Both are the database's shapes rather than the ones a caller would choose, and they are stated that
 * way here on purpose: a caller writing `if (row.retired)` is correct, and a caller writing
 * `row.retired === true` is a bug this annotation is meant to catch.
 *
 * ⚠️ `charName` is a display cache. Nothing keys on it — see the identity note above.
 *
 * @typedef {object} MemoryRow
 * @property {number} id
 * @property {string} text The memory itself. The durable truth; everything else is bookkeeping. This is the
 *           string that is INJECTED into a prompt, and it is never the string that is embedded.
 * @property {string} indexLine The distillation that is EMBEDDED in its place, or `''` when there is none and
 *           the text embeds itself. See {@link embedText}; never null, so a caller can compare it to `''`.
 * @property {number} createdAt Epoch milliseconds.
 * @property {string|null} source Provenance: `'auto'` from ingest, or whatever a manual write supplied.
 * @property {MemoryMetadata|null} metadata
 * @property {string} tier {@link TIER_USER} or {@link TIER_SCENARIO}.
 * @property {string} charId
 * @property {string} personaId
 * @property {string} chatId
 * @property {string} charName Last-known display name. A cache, not a record.
 * @property {string} scope The composed vec0 partition — see {@link scopeKey}.
 * @property {number} retired 1 when superseded. SQLite integer, not a boolean.
 * @property {number|null} supersededBy The id that replaced this one, or null.
 */

/**
 * One result of {@link MemoryStore.search} — a subset of {@link MemoryRow} plus the vec0 distance.
 *
 * 🔴 **`distance` is L2 and is NOT a similarity.** Smaller is nearer. Every threshold in `config.js` is stated
 * as a cosine and converted at the point of comparison (`similarity.js`), because a number that reads like a
 * score but sorts backward is exactly the kind of thing that gets compared with the wrong operator once and
 * then silently for ever.
 *
 * ⚠️ Deliberately narrower than {@link MemoryRow}: a search hit does not carry the identity columns, because
 * a retrieval result is scoped by construction and re-reading its axes invites filtering that vec0 already did.
 *
 * @typedef {object} SearchHit
 * @property {number} id
 * @property {string} text
 * @property {string|null} source
 * @property {MemoryMetadata|null} metadata
 * @property {string} tier
 * @property {string} charName
 * @property {string} scope
 * @property {number} distance L2 distance from the query vector. Smaller is nearer.
 */

/**
 * One result of {@link MemoryStore.searchLexical} — the same memory fields, ranked by BM25 instead.
 *
 * 🔴 **`score` IS NOT COMPARABLE WITH `SearchHit.distance`, AND `rank` EXISTS SO NOBODY TRIES.** A cosine is
 * bounded and absolute; BM25 is unbounded and corpus-relative, so the same `score` means different things in
 * two stores and in one store on two days. There is no constant that converts between them and no threshold
 * that means the same thing on both — which is why the fusion in `retrieval.js` reads `rank` and never
 * `score`, and why `score` is carried at all only so a log line can show why a row placed where it did.
 *
 * ⚠️ **`score` is NEGATIVE and more negative is BETTER**, which is SQLite's convention and the opposite of
 * every other score in this codebase. `rank` is the safe field: 0 is the best match, ascending.
 *
 * @typedef {object} LexicalHit
 * @property {number} id
 * @property {string} text
 * @property {string|null} source
 * @property {MemoryMetadata|null} metadata
 * @property {string} tier
 * @property {string} charName
 * @property {string} scope
 * @property {number} score Raw `bm25()`. Negative, more negative is better, comparable only within one query.
 * @property {number} rank 0-based position in this result set. 0 is the best match.
 */

/**
 * Every column a caller outside the store is allowed to see of a memory, aliased to the camelCase shape the
 * rest of the plugin speaks.
 *
 * One list, because four queries return "a memory" — the browse listing, a single row after an edit, the
 * version chain, and the row an edit reads before revising it — and a panel that renders a list and a row
 * with the same function needs them to be the same object. The vector is not here and never will be: a vector
 * is an index into a memory, not content (see this file's header).
 *
 * ⚠️ It lives beside the DDL that defines those columns, and beside {@link hydrate}, because two modules now
 * read memory rows — `store.js` for the browse listing and single-row fetch, `versions.js` for the chain —
 * and a column list duplicated across them is one edit away from a panel that renders a list and a row with
 * different fields.
 */
export const MEMORY_COLUMNS = `
    id, text, index_line AS indexLine, created_at AS createdAt, source, metadata,
    tier, char_id AS charId, persona_id AS personaId, chat_id AS chatId, char_name AS charName,
    scope, retired, superseded_by AS supersededBy
`;

/**
 * A row of {@link MEMORY_COLUMNS} exactly as SQLite hands it back, before {@link hydrate} has run.
 *
 * ⚠️ It differs from {@link MemoryRow} in one column and one column only: `metadata` is still the JSON
 * **string** that was stored, because SQLite has no object type and the column is TEXT. Stating it as a
 * derivation of `MemoryRow` rather than as a second column list is what stops the two drifting — a column
 * added to `MEMORY_COLUMNS` and to `MemoryRow` arrives here for free, and one added only here cannot.
 *
 * @typedef {Omit<MemoryRow, 'metadata'> & { metadata: string|null }} StoredMemoryRow
 */

/**
 * A memory row as the rest of the plugin wants it: metadata parsed back from its stored JSON.
 *
 * ⚠️ `JSON.parse` is trusted here and that is not an oversight: the only writer of this column is
 * `MemoryStore.addMemory`, which stringifies an object it was handed. A row whose `metadata` is not valid
 * JSON was not written by this plugin, and throwing is the right answer to that.
 *
 * @param {StoredMemoryRow} row
 * @returns {MemoryRow}
 */
export function hydrate(row) {
    return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
}

/**
 * The name of the vector table for a model, derived from its row id rather than its name.
 *
 * Model names are attacker-adjacent strings — they arrive from configuration and contain slashes and dots
 * (`Xenova/all-mpnet-base-v2`). Interpolating one into DDL would be a SQL injection with extra steps. The
 * integer id cannot be anything but an integer.
 *
 * @param {number} modelId Row id from `embedding_models`
 * @returns {string} The table name
 */
export function vectorTableName(modelId) {
    if (!Number.isInteger(modelId) || modelId < 1) {
        throw new TypeError(`vectorTableName requires a positive integer model id, got ${modelId}`);
    }

    return `vec_${modelId}`;
}

/**
 * DDL for one model's vector table.
 *
 * ## 🔴 Both filters live IN the vec0 table, and that is the whole point
 *
 * vec0 applies its `k` limit while scanning, so anything filtered *after* the scan — in a JOIN, or in JS —
 * filters rows that have already displaced better ones. This table therefore declares `scope` as a
 * **partition key** and `retired` as a **metadata column**, both of which vec0 evaluates BEFORE `k`. A
 * character with five memories in a pool of ten thousand returns all five; a hundred nearer retired rows
 * cannot crowd out a live one. Filtering either of these in the JOIN instead would silently return short.
 *
 * ## Why ONE composed partition key and not three
 *
 * The identity has three axes, so three partition keys looks like the natural shape. It is not, for two
 * reasons. First, a user-tier memory has no `chat_id` and a scenario-tier memory has no persona — so two of
 * three columns would always be an empty sentinel, and "which sentinels are set" would be the real tier
 * marker, encoded by absence. Second and decisively, **a composed key makes the tier a property of the
 * partition itself**: a memory cannot be in both tiers, a query cannot forget to filter one axis, and every
 * lookup is the same single-column equality. The v3 note below on TEXT keys still applies and is the reason
 * this stays a string rather than becoming an integer id.
 *
 * Three things vec0 0.1.9 will not let you do with this shape, each verified against the pinned build:
 *
 *   1. **`UPDATE` on the partition key is rejected** ("not supported yet"). Re-scoping a memory means DELETE
 *      + INSERT of the vector row. This is why `retired` is a metadata column and not a second partition key
 *      — retirement must be updatable in place.
 *   2. **`INSERT OR REPLACE` is rejected** — it raises UNIQUE rather than replacing. Re-embedding an existing
 *      memory is DELETE-then-INSERT. See `MemoryStore.addVector`.
 *   3. **An INTEGER metadata column will not accept a JS number.** Same trap as the rowid: better-sqlite3
 *      binds a number as a double and vec0 rejects it with "Expected integer for INTEGER metadata column
 *      retired, received FLOAT". `retired` must be bound as a BigInt. A TEXT partition key sidesteps the
 *      equivalent trap on `scope`, which is one reason the key is a composed string rather than a number.
 *
 * @param {number} modelId Row id from `embedding_models`
 * @param {number} dimension Vector length this model produces — becomes part of the table's declaration
 * @returns {string} The CREATE VIRTUAL TABLE statement
 */
export function vectorTableDdl(modelId, dimension) {
    if (!Number.isInteger(dimension) || dimension < 1) {
        throw new TypeError(`vectorTableDdl requires a positive integer dimension, got ${dimension}`);
    }

    // The rowid of this table is the `memories.id` it indexes. That is the join, and it is why no foreign
    // key is declared: vec0 virtual tables do not support them. The invariant is maintained in code.
    return `CREATE VIRTUAL TABLE IF NOT EXISTS ${vectorTableName(modelId)} USING vec0(
        scope     TEXT PARTITION KEY,
        embedding float[${dimension}],
        retired   INTEGER
    )`;
}
