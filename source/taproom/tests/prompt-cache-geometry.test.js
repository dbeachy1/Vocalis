import { describe, test, expect } from '@jest/globals';

import { analyzeGeometry, parsePromptShape, describeShapeChange, locateRegion, Verdict } from '../src/prompt-cache-geometry.js';

/**
 * The three shapes below are the ones measured against the real backend,
 * and the reason the analyzer exists:
 *
 *     ~300 tokens deleted above the history   -> 100.0 % cached
 *     ~300 tokens inserted above the history  ->   0.1 % cached   (identical with `--cache-reuse` OFF)
 *     ~300 tokens inserted below everything   ->  97.1 % cached
 *
 * A change that made the analyzer call an insertion absorbable would be invisible in use — every cold turn
 * would simply be reported warm, and the next person chasing a 55-second prefill would be sent to look
 * somewhere else. So the direction is asserted, not just the offsets.
 */
const HEADER = 'SYSTEM HEADER LINE';
const BODY = Array.from({ length: 300 }, (_, i) => `msg ${i} ${'z'.repeat(120)}`);
const CACHED = [HEADER, ...BODY].join('\n');

describe('the reuse loop is one-directional, and the analyzer says which direction', () => {
    test('eviction above the history plus new content below is absorbed', () => {
        const next = [HEADER, ...BODY.slice(20), 'a new user turn', 'a new reply'].join('\n');
        const geometry = analyzeGeometry(CACHED, next);

        expect(geometry.verdict).toBe(Verdict.DELETION_ABOVE);
        expect(geometry.reusable / geometry.length).toBeGreaterThan(0.95);
    });

    test('an insertion above the history is not, and takes everything below it', () => {
        const next = [HEADER, `WORLDBOOK ENTRY ${'y'.repeat(900)}`, ...BODY, 'a new user turn'].join('\n');
        const geometry = analyzeGeometry(CACHED, next);

        expect(geometry.verdict).toBe(Verdict.INSERTION_ABOVE);
        expect(geometry.reusable / geometry.length).toBeLessThan(0.05);
        // The stall point is the thing worth naming a cause for: it is where the insertion begins.
        expect(geometry.stalledAtChar).toBe(HEADER.length + 1);
    });

    test('an insertion below everything is nearly free', () => {
        const next = [HEADER, ...BODY, 'a nudge injected at depth 0'].join('\n');
        const geometry = analyzeGeometry(CACHED, next);

        expect(geometry.verdict).toBe(Verdict.APPEND_ONLY);
        expect(geometry.reusable / geometry.length).toBeGreaterThan(0.95);
    });

    test('🔴 a rewritten tail is not an insertion, however little the loop recovered', () => {
        // Both shapes leave the reuse loop having recovered nothing past the common prefix, so a classifier
        // reading only that number calls this cold. It is not: nothing moved, and everything above the last
        // message is still cached. `cold-turn-reproduction.e2e.js` caught this labelling turns that reused
        // 7,991 of 8,062 characters as COLD.
        const next = [HEADER, ...BODY.slice(0, -1), 'the last message, rewritten entirely'].join('\n');
        const geometry = analyzeGeometry(CACHED, next);

        expect(geometry.verdict).toBe(Verdict.TAIL_CHANGE);
        expect(geometry.reusable / geometry.length).toBeGreaterThan(0.95);
    });

    test('a swipe that extends the last message is a tail change, not a cold turn', () => {
        const next = [HEADER, ...BODY, 'a continuation of the reply'].join('\n');

        // Pure append: the previous prompt is still a leading prefix, so this is the cheapest shape there is.
        expect(analyzeGeometry(CACHED, next).verdict).toBe(Verdict.APPEND_ONLY);
    });

    test('an identical prompt is reused whole', () => {
        const geometry = analyzeGeometry(CACHED, CACHED);

        expect(geometry.verdict).toBe(Verdict.IDENTICAL);
        expect(geometry.reusable).toBe(geometry.length);
    });

    test('a deletion that also appends still reports the deletion, not a replacement', () => {
        // The ordinary warm turn does both at once, and an analyzer that only understood one edit at a time
        // would call this a wholesale rewrite and report every normal turn as cold.
        const next = [HEADER, ...BODY.slice(5), 'tail one', 'tail two', 'tail three'].join('\n');

        expect(analyzeGeometry(CACHED, next).verdict).toBe(Verdict.DELETION_ABOVE);
    });
});

/**
 * 🔴 THE PRIVACY CONTRACT, ASSERTED RATHER THAN DOCUMENTED. The whole feature is only allowed to log as
 * `LogClass.NORMAL` — i.e. to appear in `st.log` on an install running with debugMode off — because nothing
 * it produces is derived from the text beyond lengths and offsets. A field carrying an excerpt "just for
 * context" would be a quiet privacy regression in a fork whose headline property is that the conversation is
 * not written anywhere, and it would look perfectly reasonable in review.
 */
describe('the analysis carries numbers, never text', () => {
    test('every value in the geometry is a number or a verdict keyword', () => {
        const secret = 'CONFIDENTIAL-MARKER-9f3a';
        const cached = [HEADER, `${secret} one`, ...BODY].join('\n');
        const next = [HEADER, `${secret} two`, ...BODY, 'and a tail'].join('\n');

        const geometry = analyzeGeometry(cached, next);
        const verdicts = Object.values(Verdict);

        for (const [key, value] of Object.entries(geometry)) {
            if (key === 'verdict') {
                expect(verdicts).toContain(value);
                continue;
            }

            expect(typeof value).toBe('number');
            expect(Number.isFinite(value)).toBe(true);
        }

        expect(JSON.stringify(geometry)).not.toContain(secret);
        expect(JSON.stringify(geometry)).not.toContain('CONFIDENTIAL');
    });
});

describe('the shape header is input, and is treated as such', () => {
    test('a well-formed shape parses to its fields', () => {
        const shape = parsePromptShape('v1;story=2103;ex=0;hist=192840;cont=0;wi=512');

        expect(shape?.get('story')).toBe(2103);
        expect(shape?.get('hist')).toBe(192840);
        expect(shape?.get('wi')).toBe(512);
    });

    test('anything that is not numbers is refused', () => {
        expect(parsePromptShape(undefined)).toBeNull();
        expect(parsePromptShape('')).toBeNull();
        expect(parsePromptShape('v1;story=oops')).toBeNull();
        expect(parsePromptShape('v1;story=-5')).toBeNull();
        expect(parsePromptShape('v2;story=10')).toBeNull();
    });

    test('an unknown field is carried, not dropped', () => {
        // The wire format is deliberately generic so the server needs no copy of the client's field list.
        // A parser that filtered to a hard-coded set would silently ignore the next field somebody adds.
        expect(parsePromptShape('v1;newthing=42')?.get('newthing')).toBe(42);
    });
});

describe('an offset is turned into a place', () => {
    const shape = parsePromptShape('v1;story=1000;ex=500;hist=8000;cont=0');

    test('offsets land in the region that contains them', () => {
        expect(locateRegion(shape, 0)).toMatch(/story string/);
        expect(locateRegion(shape, 999)).toMatch(/story string/);
        expect(locateRegion(shape, 1000)).toMatch(/example messages/);
        expect(locateRegion(shape, 1500)).toMatch(/chat history/);
        expect(locateRegion(shape, 9499)).toMatch(/chat history/);
    });

    test('an offset past everything the client described says so rather than guessing', () => {
        expect(locateRegion(shape, 99999)).toBe('past the assembled parts');
    });

    test('with no shape there is no region, and it does not pretend otherwise', () => {
        expect(locateRegion(null, 42)).toBe('unknown');
    });
});

describe('what changed size since last turn', () => {
    test('changed parts are listed largest first', () => {
        const before = parsePromptShape('v1;story=1000;wi=0;hist=8000');
        const after = parsePromptShape('v1;story=1512;wi=512;hist=7900');

        const described = describeShapeChange(before, after);

        expect(described).toBe('story 1000->1512 (+512), wi 0->512 (+512), hist 8000->7900 (-100)');
    });

    test('no change is said plainly', () => {
        const shape = parsePromptShape('v1;story=1000');

        expect(describeShapeChange(shape, shape)).toBe('every part the same size as last turn');
    });

    test('a missing shape is reported as missing, not as no change', () => {
        // These mean opposite things to whoever is reading the log: "nothing moved" would send them looking
        // at the backend, when in fact the client simply never said.
        expect(describeShapeChange(null, parsePromptShape('v1;story=1'))).toMatch(/no shape to compare/);
    });
});

describe('🔴 the reported offset is a character, not the start of a line', () => {
    test('a change mid-line is reported at the character, not at the line start', () => {
        // The live failure, reduced: a prompt part begins mid-line, and the replay works in lines, so the
        // line-granular offset points into the part BEFORE the one that changed. Three turns were logged as
        // diverging in the example messages while that block was byte-identical.
        const before = 'aaaa\nSTORY-END EX-END HIST-STARTS-HERE\nzzzz';
        const after = 'aaaa\nSTORY-END EX-END HIST-STARTQ\nzzzz';

        const geometry = analyzeGeometry(before, after);

        // Line 1 begins at 5. The characters agree well past that.
        expect(geometry.commonPrefix).toBe(5);
        expect(geometry.atChar).toBeGreaterThan(5);
        expect(after.slice(0, geometry.atChar)).toBe(before.slice(0, geometry.atChar));
        expect(after[geometry.atChar]).not.toBe(before[geometry.atChar]);
    });

    test('the reuse arithmetic is untouched — only the reported offset moved', () => {
        const before = 'aaaa\nbbbb\ncccc';
        const after = 'aaaa\nbbbQ\ncccc';

        const geometry = analyzeGeometry(before, after);

        // `commonPrefix` still lands on the line boundary, because the replay counts lines.
        expect(geometry.commonPrefix).toBe(5);
        expect(geometry.atChar).toBe(8);
    });

    test('identical prompts report the end, as before', () => {
        const text = 'aaaa\nbbbb';

        expect(analyzeGeometry(text, text).atChar).toBe(text.length);
    });
});
