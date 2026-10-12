import assert from 'node:assert/strict';
import test from 'node:test';

import { attributeOffset, changedClientComponents, locateSections, unplacedClientComponents } from '../attribution.js';
import {
    AUTHORS_NOTE,
    CHAR_DESCRIPTION,
    EXAMPLES,
    PREFIX_FIXTURES,
    SYSTEM,
    TURNS,
    WI_NEW,
    WI_SHARED_HEAD,
    buildPrompt,
    sectionsFor,
    storyStringFor,
} from './fixtures.js';

const PROMPT = buildPrompt(WI_NEW);
const SPANS = locateSections(PROMPT, sectionsFor(WI_NEW));

/**
 * @param {string} needle Text known to be in the prompt
 * @returns {number} An offset a few characters into it
 */
function offsetInside(needle) {
    const at = PROMPT.indexOf(needle);

    assert.ok(at >= 0, `fixture is broken: ${JSON.stringify(needle.slice(0, 20))} is not in the prompt`);

    return at + 2;
}

test('middle-edit: the divergence is attributed to World Info', () => {
    const fixture = PREFIX_FIXTURES.find(f => f.name === 'middle-edit');

    assert.ok(fixture, 'fixture is broken: there is no middle-edit case in PREFIX_FIXTURES');
    assert.equal(fixture.expectedPrefix, SYSTEM.length + WI_SHARED_HEAD.length);
    assert.equal(attributeOffset(SPANS, fixture.expectedPrefix), 'World Info');
});

test('the innermost section wins over the block that contains it', () => {
    assert.equal(attributeOffset(SPANS, offsetInside(CHAR_DESCRIPTION)), 'Character Definition');
    assert.equal(attributeOffset(SPANS, offsetInside(SYSTEM)), 'System Prompt');
});

test('sections outside the story string are named too', () => {
    assert.equal(attributeOffset(SPANS, offsetInside(EXAMPLES)), 'Examples');
    assert.equal(attributeOffset(SPANS, offsetInside(TURNS[1])), 'Chat History (turn 1)');
});

test('an injection with no fixed position still resolves inside the history', () => {
    assert.equal(attributeOffset(SPANS, offsetInside(AUTHORS_NOTE)), "Author's Note");
});

test('an offset past the end of everything is unattributed, not the last section', () => {
    assert.equal(attributeOffset(SPANS, PROMPT.length + 10), null);
    assert.equal(attributeOffset(SPANS, -1), null);
});

test('🔴 a section string that appears twice names nothing', () => {
    const repeated = 'Marla nods.\n';
    const prompt = SYSTEM + repeated + CHAR_DESCRIPTION + repeated;
    const spans = locateSections(prompt, [
        { name: 'System Prompt', text: SYSTEM },
        { name: 'Ambiguous', text: repeated },
        { name: 'Character Definition', text: CHAR_DESCRIPTION },
    ]);

    assert.equal(attributeOffset(spans, SYSTEM.length + 2), null);
    // The unambiguous neighbours are unaffected — refusing to answer is per-section, not per-prompt.
    assert.equal(attributeOffset(spans, 2), 'System Prompt');
    assert.equal(attributeOffset(spans, prompt.indexOf(CHAR_DESCRIPTION) + 2), 'Character Definition');
});

test('a section that is not in the prompt at all names nothing', () => {
    const prompt = SYSTEM + CHAR_DESCRIPTION;
    const spans = locateSections(prompt, [
        { name: 'System Prompt', text: SYSTEM },
        { name: 'World Info', text: 'a lorebook entry that was trimmed out of this prompt\n' },
        { name: 'Character Definition', text: CHAR_DESCRIPTION },
    ]);

    assert.deepEqual(spans.map(s => s.name), ['System Prompt', 'Character Definition']);
});

test('a section echoed later in the prompt is unattributed, even though it is anchored forward', () => {
    // The character description is echoed inside the examples block, as real prompts often do. Forward
    // anchoring cannot save it: both occurrences are still ahead of the cursor, so the section is ambiguous
    // and the honest answer is silence.
    const prompt = SYSTEM + CHAR_DESCRIPTION + '<START>\n' + CHAR_DESCRIPTION;
    const spans = locateSections(prompt, [
        { name: 'Character Definition', text: CHAR_DESCRIPTION },
        { name: 'Examples', text: '<START>\n' + CHAR_DESCRIPTION },
    ]);

    assert.equal(spans.find(s => s.name === 'Character Definition'), undefined);
    assert.equal(attributeOffset(spans, SYSTEM.length + 2), null);
    // The examples block is a longer, unique string, so it is placed and answers for its own span.
    assert.equal(attributeOffset(spans, prompt.lastIndexOf(CHAR_DESCRIPTION) + 2), 'Examples');
});

test('forward anchoring rescues a section whose text also appeared before it', () => {
    // The lorebook entry is quoted in the system prompt and then appears for real further down. Anchoring
    // the search past the system prompt leaves exactly one occurrence in the remaining span.
    const preamble = 'Remember this: ' + WI_NEW;
    const prompt = preamble + CHAR_DESCRIPTION + WI_NEW;
    const spans = locateSections(prompt, [
        { name: 'System Prompt', text: preamble },
        { name: 'Character Definition', text: CHAR_DESCRIPTION },
        { name: 'World Info', text: WI_NEW },
    ]);

    assert.equal(attributeOffset(spans, prompt.lastIndexOf(WI_NEW) + 2), 'World Info');
    assert.equal(attributeOffset(spans, 2), 'System Prompt');
});

test('an unplaceable parent still lets its children be found', () => {
    // Instruct formatting wrapped the story string, so the concatenation the record holds is not in the
    // prompt verbatim — but the lorebook text inside it is, and World Info is the answer worth having.
    const prompt = '<|im_start|>system\n' + storyStringFor(WI_NEW) + '<|im_end|>\n' + TURNS[0];
    const sections = sectionsFor(WI_NEW);

    sections[0].text = 'a story string that never appears in this prompt';

    const spans = locateSections(prompt, sections);

    assert.equal(spans.find(s => s.name === 'Story String'), undefined);
    assert.equal(attributeOffset(spans, prompt.indexOf(WI_NEW) + 2), 'World Info');
});

test('a child cannot be found outside the window its parent occupies', () => {
    // The lorebook entry is quoted again in the chat history; searching the story string must not reach it.
    const story = SYSTEM + WI_NEW;
    const prompt = story + TURNS[0] + WI_NEW;
    const spans = locateSections(prompt, [
        {
            name: 'Story String',
            text: story,
            children: [{ name: 'World Info', text: WI_NEW }],
        },
        { name: 'Chat History', text: TURNS[0] + WI_NEW },
    ]);

    const worldInfo = spans.find(s => s.name === 'World Info');

    // Asserted, not assumed: the child being dropped altogether would otherwise throw here rather than fail,
    // and "placed, but in the wrong window" is the thing this test exists to tell apart from it.
    assert.ok(worldInfo, 'the child was not placed at all');
    assert.equal(worldInfo.start, SYSTEM.length);
    assert.equal(attributeOffset(spans, prompt.lastIndexOf(WI_NEW) + 2), 'Chat History');
});

test('an empty or absent section text is skipped rather than matching everywhere', () => {
    const spans = locateSections(SYSTEM + CHAR_DESCRIPTION, [
        { name: 'Empty', text: '' },
        { name: 'Missing', text: undefined },
        { name: 'System Prompt', text: SYSTEM },
    ]);

    assert.deepEqual(spans.map(s => s.name), ['System Prompt']);
});

test('an empty prompt locates nothing and attributes nothing', () => {
    assert.deepEqual(locateSections('', sectionsFor(WI_NEW)), []);
    assert.equal(attributeOffset([], 0), null);
});

// 🔴 THE HALF NO SERVER PLUGIN LIST CAN EVER COVER. World Info, the author's note, summaries and vectors are
// applied in the browser, so `rewrittenBy` is silent about them by construction. A user whose World Book
// rewrote his prompt every turn saw one server plugin named and nothing about the World Book.
test('client-side components that changed are named', () => {
    const previous = { worldInfoString: 'ashwood', authorsNoteString: 'be brief', summarizeString: 's' };
    const current = { worldInfoString: 'greyhollow', authorsNoteString: 'be brief', summarizeString: 's' };

    assert.deepEqual(changedClientComponents(previous, current), ['World Info']);
});

test('an unchanged component is not named, however large it is', () => {
    const big = { worldInfoString: 'x'.repeat(40_000) };

    assert.deepEqual(changedClientComponents(big, { ...big }), []);
});

// ⚠️ A COMPONENT THAT WENT AWAY IS A CHANGE. Absent and empty read alike, so a World Book that stopped
// activating is named and one that was never there is not.
test('a component that was removed counts as changed, and one never present does not', () => {
    assert.deepEqual(changedClientComponents({ authorsNoteString: 'note' }, {}), ["Author's Note"]);
    assert.deepEqual(changedClientComponents({}, {}), []);
    assert.deepEqual(changedClientComponents({ worldInfoString: '' }, {}), []);
});

// ⚠️ NO PREVIOUS TURN MEANS NO ANSWER, NOT "NOTHING CHANGED". An empty list here would claim a comparison
// that was never made.
test('with nothing to compare against the answer is null, not an empty list', () => {
    assert.equal(changedClientComponents(null, { worldInfoString: 'a' }), null);
    assert.equal(changedClientComponents({ worldInfoString: 'a' }, undefined), null);
});

test('every client-side component the itemized record holds is covered', () => {
    const previous = {
        worldInfoString: 'a',
        authorsNoteString: 'a',
        summarizeString: 'a',
        chatVectorsString: 'a',
        dataBankVectorsString: 'a',
    };
    const current = Object.fromEntries(Object.keys(previous).map(key => [key, 'b']));

    assert.deepEqual(changedClientComponents(previous, current), [
        'World Info',
        "Author's Note",
        'Summary',
        'Vector Memories',
        'Data Bank',
    ]);
});

// 🔴 AN INCOMPLETE LIST IS THE SAME FAILURE AS A LABEL THAT CLAIMED COMPLETENESS, JUST QUIETER. The fork
// document lists eight client-side components; the first version of this covered five.
test('depth injections and other extension prompts are covered too', () => {
    assert.deepEqual(changedClientComponents({ chatInjects: 'a' }, { chatInjects: 'b' }), ['Depth Injections']);
    assert.deepEqual(changedClientComponents({ allAnchors: 'a' }, { allAnchors: 'b' }), ['Other Extensions']);
    assert.deepEqual(changedClientComponents({ smartContextString: 'a' }, {}), ['Smart Context']);
});

// ⚠️ A field of an unexpected shape must not turn into "nothing changed".
test('a component that is not a string is still compared', () => {
    assert.deepEqual(changedClientComponents({ chatInjects: ['a'] }, { chatInjects: ['b'] }), ['Depth Injections']);
    assert.deepEqual(changedClientComponents({ chatInjects: ['a'] }, { chatInjects: ['a'] }), []);
});

// ⚠️ A COMPONENT THAT IS NOT FOUND IS INFORMATION, NOT AN ERROR. A World Info entry can activate and then be
// trimmed by the context limiter, and its absence from the prompt is the only evidence that happened.
test('a component the prompt does not contain is named', () => {
    const itemized = { worldInfoString: 'ashwood', authorsNoteString: 'be brief' };

    assert.deepEqual(unplacedClientComponents(itemized, 'SYSTEM ashwood User: hi'), ["Author's Note"]);
    assert.deepEqual(unplacedClientComponents(itemized, 'SYSTEM ashwood be brief User: hi'), []);
});

test('an empty component is not reported as missing', () => {
    assert.deepEqual(unplacedClientComponents({ worldInfoString: '' }, 'SYSTEM User: hi'), []);
    assert.deepEqual(unplacedClientComponents({}, 'SYSTEM User: hi'), []);
    assert.deepEqual(unplacedClientComponents(null, 'SYSTEM'), []);
    assert.deepEqual(unplacedClientComponents({ worldInfoString: 'a' }, ''), []);
});

// 🔴 `indexOf`, NOT `locateSections`: that one omits a section it could not place UNAMBIGUOUSLY, and
// reporting "appears twice" as "not in the prompt" would be a false claim about the user's lorebook.
test('a component appearing twice is present, not missing', () => {
    assert.deepEqual(unplacedClientComponents({ worldInfoString: 'ash' }, 'ash and ash again'), []);
});
