/**
 * The seven fixtures DESIGN.md §7.2 requires, plus the section layout the middle-edit one is attributed
 * against. Hand-written triples: no live model, no network, no tokenizer.
 *
 * 🔴 EVERY `expectedPrefix` IS DERIVED FROM HOW THE STRING WAS BUILT, never by scanning it. A fixture whose
 * expectation is computed the way the implementation computes it asserts nothing at all.
 */

/** A stand-in for the fixed head of a prompt — a system prompt that never changes between turns. */
export const SYSTEM = 'You are Marla, the keeper of the Rusty Tap. Stay in character.\n';

export const WI_OLD = '[Lore: Sample Town] Sample Town is a mining town in the north, three days by cart.\n';
export const WI_NEW = '[Lore: Greyhollow] Greyhollow sits at the river fork, two days by barge.\n';

/** The two lorebook entries share this much before they part. */
export const WI_SHARED_HEAD = '[Lore: ';

export const CHAR_DESCRIPTION = 'Marla is fifty, broad-shouldered, and has run the Rusty Tap for twenty years.\n';
export const CHAR_PERSONALITY = "Marla's personality: wry, watchful, slow to anger and slower to forgive.\n";
export const SCENARIO = 'Scenario: a wet evening in the taproom, the fire banked low.\n';
export const EXAMPLES = '<START>\nUser: Any rooms free?\nMarla: Depends who is asking.\n';

/** Chat turns, as they appear inside the history block. Long enough to be locatable on their own. */
export const TURNS = [
    'User: I am looking for the road to the mine.\n',
    'Marla: You and every other fool this season.\n',
    'User: Is it safe after dark?\n',
];

/** An injection that lands between turns rather than at a fixed place in the template. */
export const AUTHORS_NOTE = '[Keep replies under three sentences.]\n';

/**
 * Build a whole prompt around one lorebook entry.
 * @param {string} worldInfo The World Info block to embed
 * @returns {string} The assembled prompt
 */
export function buildPrompt(worldInfo) {
    return SYSTEM + worldInfo + CHAR_DESCRIPTION + CHAR_PERSONALITY + SCENARIO
        + EXAMPLES
        + TURNS[0] + AUTHORS_NOTE + TURNS[1] + TURNS[2];
}

/**
 * The story-string block of `buildPrompt`, as the itemized record would hold it.
 * @param {string} worldInfo The World Info block to embed
 * @returns {string} The block
 */
export function storyStringFor(worldInfo) {
    return SYSTEM + worldInfo + CHAR_DESCRIPTION + CHAR_PERSONALITY + SCENARIO;
}

/** The chat-history block of `buildPrompt`. */
export const HISTORY = TURNS[0] + AUTHORS_NOTE + TURNS[1] + TURNS[2];

/**
 * The section tree for a prompt built by `buildPrompt`, in the shape `attribution.js` takes.
 * @param {string} worldInfo Which lorebook entry the prompt was built with
 * @returns {import('../attribution.js').SectionSpec[]} The sections, in prompt order
 */
export function sectionsFor(worldInfo) {
    return [
        {
            name: 'Story String',
            text: storyStringFor(worldInfo),
            children: [
                { name: 'System Prompt', text: SYSTEM },
                { name: 'World Info', text: worldInfo },
                { name: 'Character Definition', text: CHAR_DESCRIPTION },
                { name: 'Character Personality', text: CHAR_PERSONALITY },
                { name: 'Scenario', text: SCENARIO },
            ],
        },
        { name: 'Examples', text: EXAMPLES },
        {
            name: 'Chat History',
            text: HISTORY,
            orderedChildren: false,
            children: [
                { name: "Author's Note", text: AUTHORS_NOTE },
                { name: 'Chat History (turn 0)', text: TURNS[0] },
                { name: 'Chat History (turn 1)', text: TURNS[1] },
                { name: 'Chat History (turn 2)', text: TURNS[2] },
            ],
        },
    ];
}

/** ~100,000 characters of filler that is byte-identical between the two prompts of the top-edit fixture. */
const FILLER = 'The tavern keeper nods slowly and says nothing more about it. '.repeat(1650);

/** The first 40 characters of the top-edit prompts — everything before the word that changes. */
const TOP_HEAD = 'You are Marla, the keeper of the Rusty T';

/**
 * @typedef {object} PrefixFixture
 * @property {string} name
 * @property {string} prev The baseline — what the cache holds. Empty when there is none.
 * @property {string} next The prompt being sent
 * @property {number} expectedPrefix Characters the backend could reuse
 * @property {string} catches What getting it wrong would look like
 */

/** @type {PrefixFixture[]} */
export const PREFIX_FIXTURES = [
    {
        name: 'identical',
        prev: buildPrompt(WI_OLD),
        next: buildPrompt(WI_OLD),
        expectedPrefix: buildPrompt(WI_OLD).length,
        catches: 'full reuse reported as anything less than full',
    },
    {
        name: 'append-only',
        prev: buildPrompt(WI_OLD),
        next: buildPrompt(WI_OLD) + '\nUser: hi',
        expectedPrefix: buildPrompt(WI_OLD).length,
        catches: 'the healthy case — a turn that only grew at the end',
    },
    {
        name: 'top-edit',
        prev: TOP_HEAD + 'ap. Stay in character.\n' + FILLER,
        next: TOP_HEAD + 'un. Stay in character.\n' + FILLER,
        expectedPrefix: TOP_HEAD.length,
        catches: '🔴 the diff-vs-prefix bug. A diff scores this ~99%; the truth is ~0%',
    },
    {
        name: 'middle-edit',
        prev: buildPrompt(WI_OLD),
        next: buildPrompt(WI_NEW),
        expectedPrefix: SYSTEM.length + WI_SHARED_HEAD.length,
        catches: 'a lorebook entry swapped mid-prompt; attribution must land in World Info',
    },
    {
        name: 'completion-extends',
        // The cache after turn N holds prompt_N *and* the reply it generated. Turn N+1's prompt contains
        // that reply, so its reusable prefix runs past the end of prompt_N.
        prev: buildPrompt(WI_OLD) + 'Marla: Safe enough if you keep to the cart road.\n',
        next: buildPrompt(WI_OLD) + 'Marla: Safe enough if you keep to the cart road.\n' + 'User: And after the fork?\n',
        expectedPrefix: buildPrompt(WI_OLD).length + 'Marla: Safe enough if you keep to the cart road.\n'.length,
        catches: '§4.1 — comparing against the prompt alone under-reports by the whole reply',
    },
    {
        name: 'astral-split',
        // Same high surrogate, different low one: the naive scan stops one code unit into the pair.
        prev: SYSTEM + '\uD83D\uDE00 she says.',
        next: SYSTEM + '\uD83D\uDE01 she says.',
        expectedPrefix: SYSTEM.length,
        catches: '§7.1 backoff — a phantom one-character divergence that never resolves',
    },
    {
        name: 'empty-prev',
        prev: '',
        next: buildPrompt(WI_OLD),
        expectedPrefix: 0,
        catches: 'the first turn of a chat — no bar at all, never a zero bar',
    },
];

/** The completion half of the completion-extends fixture, for tests that assemble the baseline themselves. */
export const COMPLETION = 'Marla: Safe enough if you keep to the cart road.\n';
