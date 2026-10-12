/**
 * Every tunable number Mnemosyne has, in one place.
 *
 * These are initial defaults, not calibrated values. Validate tuning against the real embedder and backend;
 * tests refer to the exported values symbolically rather than duplicating them.
 *
 * Card-size limits remain beside their single consumer: they are correctness bounds, not tuning settings.
 *
 * Memory scope is structural, not configurable.
 *
 * Schema v4 partitions encode owner and lifetime. Widening a read could expose another persona's memories,
 * so no setting may bypass the partition boundary.
 */

/**
 * What the panel says when a Chat Completion generation cannot be learned from on this fork.
 *
 * Recall works for either backend. Extraction requires a captured generation connection: older fork APIs
 * expose only text completions, while plugin API 8 adds `chatGenerate`. The capability gate declines only
 * unsupported chat extraction, and the panel reports that state rather than silently skipping ingestion.
 *
 * `reason` and `fix` are `noteOutcome` fields, rendered verbatim by `renderAlert` — content-free prose about
 * the fork, safe on the NORMAL channel.
 */
export const CHAT_INGEST_NEEDS_FORK = Object.freeze({
    reason: 'this fork cannot run the extraction call against a Chat Completion backend (plugin API 8 adds it)',
    fix: 'Recall still works in Chat Completion. To store new memories automatically, update the fork, or switch this chat to Text Completion.',
});

export const MEMORY_DEFAULTS = Object.freeze({
    /**
     * How many memories to retrieve per prompt, across BOTH tiers — the user-fact and scenario-fact partitions
     * are searched separately and merged, and this is the size of the merged answer (MemoryStore.search).
     *
     * Initial default; the useful count and scoring weights still need real-backend evaluation.
     *
     * The two tiers no longer compete for all of it on distance alone — see {@link reserveUserTier}.
     */
    retrievalK: 5,
    /**
     * Slots in `retrievalK` the **user tier** keeps whatever the scenario tier's distances look like.
     *
     * Reserve this many retrieval slots for user-partition memories before filling the remainder from scenario
     * memory. The reservation guarantees representation only: `minCosine` still rejects weak matches. Each slot
     * reduces scenario capacity; zero restores the unreserved merge. Calibrate against real recall data.
     */
    reserveUserTier: 2,
    /**
     * The similarity floor a memory must clear to be injected at all (FR5).
     *
     * Similarity floor for injecting a retrieved memory. Search returns nearest rows without thresholding, so this
     * guard prevents weak matches from consuming prompt slots. The default is uncalibrated: tune against real
     * queries and stored memories; `retrieve` logs the nearest declined score for that evaluation.
     */
    minCosine: 0.25,
});

/**
 * Initial thresholds, cadences, and caps. Calibrate against the real embedder and backend; tests use these
 * exported values symbolically.
 */
/**
 * `Object.freeze` preserves literal values in `typeof INGEST_DEFAULTS`, but callers pass modified copies.
 * `Widen` makes the parameter accept those overrides without changing the exported constants.
 *
 * @typedef {Widen<typeof INGEST_DEFAULTS>} IngestDefaults
 */

export const INGEST_DEFAULTS = Object.freeze({
    // Trigger (§4.1)
    // Fire once this many messages have accumulated past the high-water mark. A smaller window asks the
    // model to rank less, so less is dropped by its own judgment. Costs twice the extraction calls.
    triggerMessages: 6,
    /**
     * The FIRST pass in a chat fires on this many instead, once, and never again for that chat.
     *
     * Run once when a chat has no ingest-state row so its opening context can be captured before the normal
     * message interval. The character-card baseline avoids relearning facts already stated in the card; `lastRun`
     * starts at zero, so retry backoff does not suppress this first pass.
     */
    firstPassMessages: 5,
    /**
     * Number of fresh turns required before retrying a failed extraction.
     *
     * Turn-based backoff uses the same event axis as `triggerMessages`, so elapsed time and typing speed do not
     * change when an extraction runs. `failedAtTurns` remains zero unless the prior attempt failed; healthy chats
     * are not delayed. This separate gate prevents a persistent backend failure from triggering an extraction on
     * every generation, while `inFlight` limits concurrent work per user.
     */
    retryBackoffTurns: 6,           // tracks triggerMessages: one more interval's worth of turns before a retry
    // Window (§4.1)
    windowMax: 40,                  // at most this many recent messages go to the extractor
    windowContextTail: 4,           // ...plus this many already-extracted messages above the mark, for scene continuity
    // What we DECLARE to the fork at registration (fork §17.6). Derived, not picked: windowMax (40) +
    // windowContextTail (4) + 6 slack to locate the high-water anchor and absorb a swipe/edit without losing it.
    // 🔴 The fork holds NO default and will never invent one — declare nothing and `recentMessages` arrives
    // undefined, so ingest never fires at all. Move this if windowMax is ever tuned against the host's real embedder.
    recentMessages: 50,
    /**
     * 🔴 **MOVED. The reservation is no longer a constant here — see `declaredReserveTokens()` in
     * `src/settings.js`, which is what `init` actually declares.**
     *
     * It had to move the moment `maxLength` and `retrievalK` became user settings. A reservation is a promise
     * to the fork about the largest block we will ever inject, made ONCE at plugin init before any user's
     * store is open; a constant derived from the DEFAULT `maxLength` would be a promise made on behalf of
     * settings nobody has loaded, and the first user to raise the knob would break it silently. So the
     * declaration is derived from the settings schema's MAXIMA instead.
     *
     * ⚠️ Left as a comment rather than deleted, because the number appears in half a dozen explanations
     * across `retrieval.js` and `api/memories.js` that are still correct about everything except where it
     * lives. A reader who greps for it here should be sent one hop onward, not left thinking it was dropped.
     *
     * ⚠️ **A constant nothing declares is worse than no constant.** Keeping `reservesTokens: 1700` beside a
     * registration that declares 4254 is exactly the drift that produced today's two defects — a documented
     * invariant with nothing enforcing it. `tests/plugin.test.js` now checks the real declaration.
     */
    // Extraction (§4.2 / §5)
    maxMemories: 6,                 // at most this many memories per pass — the cap forces the model to rank
    maxFailedAttempts: 2,           // after this many garbage outputs on the same window, force past it (lose coverage, never wedge)
    // Existing-memory context (§5.3 tier 4)
    existingContextK: 20,           // how many existing memories to show the extractor as "already known"
    // Quality filter (§5.3 tier 2)
    minLength: 10,
    /**
     * Above this a statement is CLIPPED to this length (at a sentence boundary) and stored — see `fitLength`.
     *
     * Oversize statements are clipped at a sentence boundary and stored. The extraction prompt states this
     * limit and requests enough detail for a useful memory; this cap is a backstop for outputs that exceed it.
     * Keeping a clipped statement avoids permanently losing useful content, while the minimum-length filter
     * remains independent so concise facts are not rejected merely for being brief.
     */
    maxLength: 1500,
    // Dedup / supersession, stated as COSINE similarity (§5.3 tier 4). Converted to L2 at the boundary, once,
    // because store.search returns L2 distance and mixing the units is the design's landmine 1.
    //
    // These thresholds are empirical for the selected embedding model and calibration corpus; they are not
    // portable across models. Re-measure before changing the model or either threshold. Paraphrase and
    // state-change scores overlap, so the uncertain band and state-change marker remain necessary.
    duplicateCosine: 0.90,          // ≥ this and no state-change marker → duplicate, drop (band 0.84–0.92, midpoint 0.90)
    supersedeCosine: 0.60,          // ≥ this → the uncertain band, adjudicated by the model (band 0.52–0.68, midpoint 0.60)
    // The uncertain-band confirm (§5.3 tier 4) costs one tiny generate call. Set false for latency-averse setups
    // — the cost of skipping is redundant near-facts, never corruption.
    confirmUncertain: true,
    // The two generate() calls, whose parameters were inline literals at their call sites until 8/11. They are
    // tuning knobs exactly like everything above — `temperature: 0.2` on the extraction is a first cut nobody
    // has tested against a real backend — and a knob spelled out at its call site is a knob nobody finds.
    // 🔴 `repPen` rides ONLY with the grammar: it exists to trim the shorter repeats a `line{1,N}` grammar can
    // produce at low temperature, and sending it without one changes an unconstrained call for no reason.
    /**
     * The ceiling on the extraction call.
     *
     * 🔴 **IT WAS 400, AND 400 COULD NOT HOLD A FULL PASS.** The worst case this prompt is allowed to produce
     * is `maxMemories` (6) statements of up to `maxLength` (500) characters each, plus a `[fact:2:char] ` tag
     * on every line — a little over 3,000 characters, which at the ~4.7 chars/token this file already uses for
     * Latin prose is roughly 660 tokens, and considerably more for a denser script. The model was being cut
     * off mid-statement whenever it filled the cap it was given.
     *
     * That is worse than losing the tail, because `parseExtraction` had no completeness check: a guillotined
     * final line still carries its tag, still has no second `[`, still clears `minLength`, so `LINE_RE`
     * matched it and `passesQuality` passed it. The half-sentence was stored, retrieved, and injected into
     * every future prompt — permanently, since the pass returns `lines` and the high-water mark advances past
     * the window that produced it. `maxLength` was raised 280 → 500 without this number moving, which is what
     * made a marginal budget an inadequate one.
     *
     * ⚠️ Derived, not picked, and deliberately generous: `maxTokens` is a CEILING, not a reservation. A model
     * that has three memories to report emits three and stops, so headroom costs nothing on a normal pass and
     * buys the worst case room to finish its last sentence. The margin is what pays for a script that
     * tokenizes denser than the estimate.
     *
     * 🔴 Keep this derived from `maxMemories` and `maxLength`. Raising either without raising this is exactly
     * the drift that caused the defect, so `tests/ingest.test.js` recomputes it and fails if they part company.
     *
     * 🔴 **THIS IS THE ANSWER BUDGET, NOT THE WIRE CEILING — SEE `extractReasoningTokens`.** It is what
     * `parseExtraction` measures the reply against, and it must keep meaning "how long may the ANSWER be",
     * because that is the question {@link looksGuillotined} asks. The number sent to the backend is this plus
     * the reasoning allowance below; do not collapse the two back into one.
     */
    extractMaxTokens: 2400,
    /**
     * The ceiling actually sent to the backend — a RUNAWAY GUARD, not a budget.
     *
     * 🔴 **THESE ARE TWO DIFFERENT NUMBERS AND CONFLATING THEM BROKE AUTOMATIC MEMORY ON A REAL INSTALL.**
     * `extractMaxTokens` above answers "how long may the ANSWER be" and is derived from `maxMemories` and
     * `maxLength`. That is a sound estimate and a completely wrong thing to put on the wire, because the wire
     * ceiling also has to cover whatever the model spends BEFORE the answer.
     *
     * DeepSeek-V4-Pro on Featherless streams its chain of thought in a separate `reasoning` field and the
     * answer in `text`. The fork's `generate` returns only `{ text }`, so Mnemosyne never sees a character of
     * the reasoning — but every one of those tokens is billed against `max_tokens`. Measured on one 519-char
     * window: 1487 tokens to a natural stop, of which the reasoning alone was 5987 characters and the answer
     * 484. Sent a 1000-token ceiling, the same model hit the cap mid-thought and returned an EMPTY `text`,
     * which `parseExtraction` calls garbage — so the high-water mark never advanced and the window was retried
     * for ever. Not one pass could complete.
     *
     * ⚠️ **The backend does not need this field at all** — removing it entirely, Featherless ran the model to
     * its own stop and returned a clean answer. What it buys is the runaway case: at `extractTemperature` 0.2
     * with a repeating line format, a model can loop. That was meant to be bounded by the GBNF grammar's
     * `line{1,N}` — but the fork's `filterBodyForBackend` DROPS `grammar` for every OpenAI-schema backend, so
     * on Featherless this number is the only bound there is.
     *
     * ⚠️ So size it as a guard, not as an allowance: high enough that no legitimate extraction approaches it,
     * which is why it is not `extractMaxTokens` plus a fudge factor. A ceiling is not a reservation — a model
     * that answers in 1487 tokens is billed for 1487.
     */
    extractCeilingTokens: 12000,
    extractTemperature: 0.2,
    extractRepPen: 1.15,
    // The uncertain-band confirm answers one word. 🔴 temperature 0 — this is a classification, not prose.
    confirmMaxTokens: 10,
    confirmTemperature: 0,
});

/**
 * What a user has to type, exactly, before "Reset all memories" will do anything.
 *
 * 🔴 **THE ONLY CONSTANT IN THIS FILE THAT MUST NEVER BECOME A SETTING**, which is precisely why it is here
 * rather than in `settings.js` beside the knobs it sits next to on screen. A confirmation phrase the user can
 * change is not a confirmation; it is a field they can empty, and an empty required phrase turns the most
 * destructive control in the plugin into a single click. It is a number-free constant in a file of tunables
 * on purpose, and the sentence you are reading is what stops the next person moving it.
 *
 * ⚠️ **ONE STRING, TWO READERS, AND THAT IS THE POINT.** `panel-view.js` renders it into the instruction and
 * `api/memories.js` compares against it, and they must be the same string — a panel that asks for one phrase
 * while the route demands another produces a button that cannot be made to work, and the user has no way to
 * see why. Both import it from here; neither spells it out.
 *
 * ⚠️ **The check folds case and trims surrounding whitespace, but otherwise requires an exact match.** The
 * phrase is the consent; a longer sentence that merely contains it is not accepted.
 *
 * 🔴 **The server enforces the confirmation.** The fork's `Popup.show.confirm` is a yes/no dialog; it cannot
 * collect a phrase. The settings screen collects the text, and `resetMemories` validates it so every client
 * follows the same rule.
 */
export const RESET_PHRASE = 'erase all my memories';
