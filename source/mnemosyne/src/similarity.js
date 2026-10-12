/**
 * The embedding space's units, and the one conversion between them.
 *
 * `MemoryStore.search` returns **L2 distance**, because that is what vec0 computes. Every threshold in this
 * project is stated as **cosine similarity**, because that is the unit a human can reason about — "0.85 means
 * near-identical" is a judgment someone can make, and "0.548 means near-identical" is not. So there is a
 * boundary, and this module is it.
 *
 * 🔴 **`DESIGN_INGEST.md`'s landmine 1 is mixing the two units**, and the shape below is what refuses it: the
 * pair is one fact about the embedding space, stated once, in one place, rather than two conversions living
 * beside their separate callers where they can drift out of step with each other.
 *
 * ## The relation, and the assumption underneath it
 *
 * The fork's embeddings are **unit-normalized**, so the relation is exact rather than approximate:
 *
 *     cos = 1 − d²/2          d = √(2(1 − cos))
 *
 * ⚠️ **That normalization is the whole justification and it is an assumption about the fork, not a theorem.**
 * If a future embedding path ever returned un-normalized vectors, both functions below would go quietly and
 * uselessly wrong — every threshold comparison would still evaluate, still return a boolean, and mean nothing.
 * If the embedding source changes, this assumption is the thing to re-check first.
 *
 * ✅ **The normalization survives a model change**, which is the form the question actually
 * arrives in. The normalization is done by the *runtime*, not by the model: `context.embed()` reaches
 * `getTransformersBatchVectorWithModel` → `getTransformersVector`, and the fork's single call site
 * (`src/vectors/embedding.js:11`) passes `{ pooling: 'mean', normalize: true }` unconditionally. So
 * swapping `extensions.models.embedding` cannot un-normalize the vectors, and a sentence-transformers
 * `-dot-` model — whose *card* says its embeddings are un-normalized — arrives here unit-length anyway.
 *
 * 🔴 **Which is not a license to load a `-dot-` model.** Its magnitudes encode a learned preference for
 * longer passages, and L2-normalizing them away at inference discards exactly that. Prefer a `-cos-`
 * model because of what it was TRAINED for, not out of a fear about this relation, which holds either
 * way. The thing that would genuinely break this is a change to the fork's call site, not to the config.
 *
 * ## Which direction to use, and when
 *
 * 🔴 **Convert the THRESHOLD to L2, once, and compare distances directly. Never convert distances one at a
 * time.** A search returns `k` distances and a threshold is one number; converting the threshold is one
 * `Math.sqrt` per pass instead of one per hit, and — much more importantly — it keeps the comparison in the
 * units the database actually returned, so there is no rounding trip between the number vec0 computed and the
 * number the decision is made on. See `placeInPartition` in `ingest/`.
 *
 * {@link l2ToCosine} is therefore for **display and logging only**: turning a distance back into the number a
 * human reads in a log line ("nearest cos 0.83") beside the threshold it was compared against.
 *
 * ## Why this is not in `ingest/`, where it used to live
 *
 * Its own docblock in `src/ingest.js` had the right instinct — *"the pair is one fact about the embedding
 * space"* — and drew the wrong conclusion from it, because a fact about the embedding space is not a fact
 * about ingest. Retrieval needs `l2ToCosine` too, for the score it puts on the panel, and reached into
 * `ingest.js` to get it: the only backward edge in the module graph, present solely because this pair had no
 * home of its own. Now it has one, and both callers are downstream of it.
 */

/**
 * A cosine-similarity threshold, as the L2 distance `MemoryStore.search` actually returns.
 *
 * A HIGHER cosine (more similar) is a LOWER distance, so a `cos ≥ t` test becomes `distance ≤ cosineToL2(t)`.
 * Getting that inversion backward is silent: the comparison still runs, and selects the complement.
 *
 * @param {number} cosine
 * @returns {number} the equivalent L2 distance
 */
export function cosineToL2(cosine) {
    // 🔴 `Math.max(0, NaN)` IS `NaN`. The clamp looks like it guards this and does not.
    //
    // A NaN threshold propagates: `Math.sqrt(NaN)` is NaN, and every downstream `distance <= NaN` is FALSE.
    // In `placement.js` that silently classifies every candidate as novel — dedup stops dropping duplicates,
    // supersession stops replacing anything, nothing throws, and the store fills with copies. In `retrieval.js`
    // it would reject every hit and memory would appear to be off. That is precisely the silent-wrong-answer
    // failure the module header warns about, arriving through the expression that appears to prevent it.
    if (!Number.isFinite(cosine)) {
        throw new TypeError(`cosineToL2 requires a finite cosine, got ${JSON.stringify(cosine)}`);
    }
    return Math.sqrt(Math.max(0, 2 * (1 - cosine)));
}

/**
 * The exact inverse: an L2 distance back to cosine similarity.
 *
 * 🔴 Display and logging only — see the module header. A threshold comparison converts the *threshold*, once,
 * at the boundary; it never converts distances one at a time.
 *
 * @param {number} distance
 * @returns {number} cosine similarity in [-1, 1]
 */
export function l2ToCosine(distance) {
    return 1 - (distance * distance) / 2;
}
