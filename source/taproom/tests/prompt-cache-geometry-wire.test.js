import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { initLogger, resetLoggerForTests } from '../src/logger.js';
import { readIdentityHeaders } from '../src/generation-interceptors.js';
import { recordOutgoingPrompt, clearRecords } from '../src/prompt-record.js';
import { makeScratchDirectory } from './util/st-server.js';
import { formatPromptShape } from '../public/scripts/prompt-shape.js';
import { describeLayout, describePartDiff } from '../src/prompt-cache-geometry.js';

/**
 * The diagnostic must reach the configured log file when `debugMode: false` drops every SENSITIVE line. Asserting the
 * verdict out of `analyzeGeometry` proves the arithmetic; only reading it back out of `st.log` proves the
 * feature. These tests are the second thing.
 *
 * 🔴 AND THEY ARE THE PRIVACY TEST TOO. The canary below takes the prompts apart and asserts that no run of
 * either one survives into the log. A regression here would not fail anything else: the lines would still
 * appear, still be correct, and quietly carry conversation into a file that is supposed to be safe to paste.
 */

/** @type {string} */
let directory;
/** @type {import('@jest/globals').jest.SpiedFunction<any>} */
let stdoutSpy;
/** @type {import('@jest/globals').jest.SpiedFunction<any>} */
let stderrSpy;

const HANDLE = 'geometry-test-user';
const SECRET = 'CONFIDENTIAL-MARKER-9f3a';
const HEADER_LINE = 'SYSTEM HEADER LINE';
const BODY = Array.from({ length: 200 }, (_, i) => `${SECRET} message ${i} ${'z'.repeat(120)}`);

beforeEach(() => {
    directory = makeScratchDirectory('prompt-cache-geometry');
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // debugMode off, exactly as the encrypted install runs.
    initLogger({ directory });
    clearRecords(HANDLE);
});

afterEach(() => {
    clearRecords(HANDLE);
    resetLoggerForTests();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * @returns {string} What was written to st.log
 */
function readLog() {
    const target = path.join(directory, 'st.log');
    return fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
}

/**
 * A request carrying only the headers a generation sends.
 * @param {Record<string, string>} headers Header values by name
 * @returns {any} Something `readIdentityHeaders` can read
 */
function requestWith(headers) {
    return { get: (name) => headers[name] };
}

/**
 * @param {string} prompt The outgoing prompt
 * @param {string} [shape] The shape header value
 * @returns {void}
 */
function send(prompt, shape) {
    recordOutgoingPrompt({ handle: HANDLE, backend: 'text', apiType: 'llamacpp', chatId: 'chat-1', genType: 'normal', prompt, shape });
}

describe('the shape header survives the trip from client to log', () => {
    test('a well-formed shape is read off the request', () => {
        const identity = readIdentityHeaders(requestWith({ 'X-ST-Prompt-Shape': 'v1;story=1000;ex=0;hist=8000;cont=0;wi=512' }));

        expect(identity.promptShape).toBe('v1;story=1000;ex=0;hist=8000;cont=0;wi=512');
    });

    test('a shape carrying anything but numbers is dropped, so a client cannot write prose into st.log', () => {
        expect(readIdentityHeaders(requestWith({ 'X-ST-Prompt-Shape': 'v1;story=SOME INJECTED TEXT' })).promptShape).toBeUndefined();
        expect(readIdentityHeaders(requestWith({ 'X-ST-Prompt-Shape': `v1;story=1;${'x'.repeat(600)}=2` })).promptShape).toBeUndefined();
        expect(readIdentityHeaders(requestWith({})).promptShape).toBeUndefined();
    });
});

describe('a cold turn announces itself in st.log with debugMode off', () => {
    test('an insertion above the history is logged as a cold turn, and named', () => {
        const cached = [HEADER_LINE, ...BODY].join('\n');
        const next = [HEADER_LINE, `WORLDBOOK ${'y'.repeat(900)}`, ...BODY].join('\n');

        send(cached, 'v1;story=19;ex=0;hist=100000;cont=0;wi=0');
        send(next, 'v1;story=930;ex=0;hist=100000;cont=0;wi=911');

        const written = readLog();

        expect(written).toContain('PREDICTED COLD');
        expect(written).toContain('INSERTION_ABOVE');
        // The cause is named as a size change, which is the half that needs no offset arithmetic.
        expect(written).toContain('wi 0->911 (+911)');
    });

    test('an ordinary evict-and-append turn is not reported cold', () => {
        const cached = [HEADER_LINE, ...BODY].join('\n');
        const next = [HEADER_LINE, ...BODY.slice(10), 'a new user turn', 'a new reply'].join('\n');

        send(cached, 'v1;story=19;ex=0;hist=100000;cont=0;wi=0');
        send(next, 'v1;story=19;ex=0;hist=99000;cont=0;wi=0');

        const written = readLog();

        expect(written).toContain('DELETION_ABOVE');
        expect(written).not.toContain('PREDICTED COLD');
    });

    test('🔴 a turn that reprocesses most of the prompt is cold even when nothing was displaced', () => {
        // The window rolled over completely: the cached history is gone rather than pushed down, so the
        // verdict is TAIL_CHANGE and the cost is still most of the prompt. Keying the warning on the shape
        // instead of the cost meant this logged nothing at all, and anyone grepping COLD TURN would have
        // concluded their slow turns had some other cause. Caught by cold-turn-reproduction.e2e.js.
        const cached = [HEADER_LINE, ...BODY.slice(0, 40)].join('\n');
        const next = [HEADER_LINE, ...BODY.slice(120, 160)].join('\n');

        send(cached, 'v1;story=19;ex=0;hist=6000;cont=0');
        send(next, 'v1;story=19;ex=0;hist=6000;cont=0');

        const written = readLog();

        expect(written).toContain('TAIL_CHANGE');
        expect(written).toContain('PREDICTED COLD');
        expect(written).toContain('gone rather than moved');
    });

    test('a cheap tail edit is not called cold, however little the reuse loop recovered', () => {
        // The other side of the same coin: reuse recovers nothing past the common prefix here too, but the
        // prefix is nearly the whole prompt. A warning here would be noise on every ordinary turn.
        const cached = [HEADER_LINE, ...BODY].join('\n');
        const next = [HEADER_LINE, ...BODY.slice(0, -1), 'the last message, rewritten'].join('\n');

        send(cached, 'v1;story=19;ex=0;hist=100000;cont=0');
        send(next, 'v1;story=19;ex=0;hist=100000;cont=0');

        const written = readLog();

        expect(written).toContain('TAIL_CHANGE');
        expect(written).not.toContain('PREDICTED COLD');
    });

    test('the first generation has nothing to compare against and says nothing', () => {
        send([HEADER_LINE, ...BODY].join('\n'), 'v1;story=19;hist=100000');

        expect(readLog()).not.toContain('Prompt cache geometry');
    });

    test('a generation type the client invented is not echoed into the log', () => {
        const cached = [HEADER_LINE, ...BODY].join('\n');

        recordOutgoingPrompt({ handle: HANDLE, backend: 'text', chatId: 'c', genType: 'normal', prompt: cached });
        recordOutgoingPrompt({ handle: HANDLE, backend: 'text', chatId: 'c', genType: 'PROSE THE CLIENT CHOSE', prompt: `${cached}\nmore` });

        const written = readLog();

        expect(written).toContain('Prompt cache geometry');
        expect(written).not.toContain('PROSE THE CLIENT CHOSE');
        expect(written).toContain('[text/other]');
    });
});

describe('nothing from either prompt reaches the log', () => {
    test('no run of the conversation survives into st.log', () => {
        const cached = [HEADER_LINE, ...BODY].join('\n');
        const next = [HEADER_LINE, `WORLDBOOK ${'y'.repeat(900)}`, ...BODY, `${SECRET} a brand new reply`].join('\n');

        send(cached, 'v1;story=19;ex=0;hist=100000;cont=0;wi=0');
        send(next, 'v1;story=930;ex=0;hist=100000;cont=0;wi=911');

        const written = readLog();

        expect(written).toContain('Prompt cache geometry');
        expect(written).not.toContain(SECRET);
        expect(written).not.toContain('WORLDBOOK');
        expect(written).not.toContain(HEADER_LINE);

        // Anything longer than a handful of characters from the prompt would be a leak; check real runs of
        // it rather than trusting that the three markers above are the only way text could escape.
        for (let start = 0; start + 24 <= next.length; start += 97) {
            expect(written).not.toContain(next.slice(start, start + 24));
        }
    });
});

describe('a log line names its message, so nothing has to be reconciled against a screenshot', () => {
    test('the message id rides the shape and appears on every line for that generation', () => {
        const cached = [HEADER_LINE, ...BODY].join('\n');
        const next = [HEADER_LINE, `INSERTED ${'y'.repeat(900)}`, ...BODY].join('\n');

        send(cached, 'v1;story=19;ex=0;hist=100000;cont=0;mesid=390');
        send(next, 'v1;story=930;ex=0;hist=100000;cont=0;mesid=391');

        const written = readLog();

        // On the geometry line, on the parts line, and on the warning — the warning especially, because
        // `grep 'COLD TURN'` is the whole workflow and a hit that cannot be placed is a hit worth little.
        expect(written).toContain('(msg 391)');
        expect(written).toContain('PREDICTED COLD');
        expect(written.split('\n').filter(line => line.includes('PREDICTED COLD'))[0]).toContain('(msg 391)');
    });

    test('a client too old to send a message id still logs, just without the label', () => {
        const cached = [HEADER_LINE, ...BODY].join('\n');
        const next = [HEADER_LINE, `INSERTED ${'y'.repeat(900)}`, ...BODY].join('\n');

        send(cached, 'v1;story=19;ex=0;hist=100000;cont=0');
        send(next, 'v1;story=930;ex=0;hist=100000;cont=0');

        const written = readLog();

        expect(written).toContain('Prompt cache geometry');
        expect(written).not.toContain('(msg ');
    });
});

describe('the backend\'s own measurement is logged beside the prediction', () => {
    test('a measurement is reported against the seq it belongs to, not the seq that carried it', () => {
        send([HEADER_LINE, ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0;mesid=390');
        send([HEADER_LINE, ...BODY, 'a new reply'].join('\n'),
            'v1;story=19;ex=0;hist=100000;cont=0;mesid=391;pseq=1;pcached=1880;pproc=43689;pms=55120');

        const written = readLog();

        // seq 1 is what was measured; seq 2 is merely what carried the numbers home.
        expect(written).toContain('seq 1 MEASURED by the backend: reused 1880 of 45569 tokens (4.1%), processed 43689, prefill 55120 ms.');
    });

    test('🔴 a backend that reused nothing is reported as nothing, not as absent', () => {
        send([HEADER_LINE, ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0');
        send([HEADER_LINE, ...BODY, 'a new reply'].join('\n'),
            'v1;story=19;ex=0;hist=100000;cont=0;pseq=1;pcached=0;pproc=45550;pms=54800');

        // The first generation after a restart reads exactly this, and it is the most informative
        // measurement there is. A zero must survive the trip as a zero.
        expect(readLog()).toContain('seq 1 MEASURED by the backend: reused 0 of 45550 tokens (0.0%)');
    });

    test('a request carrying no measurement logs no MEASURED line', () => {
        send([HEADER_LINE, ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0;mesid=390');
        send([HEADER_LINE, ...BODY, 'a new reply'].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0;mesid=391');

        expect(readLog()).not.toContain('MEASURED');
    });
});

describe('the shape the browser writes', () => {
    test('the message id is always carried', () => {
        expect(formatPromptShape({ story: 'abc', messageId: 391 })).toContain(';mesid=391');
    });

    test('🔴 the measured fields are omitted entirely when there is no measurement', () => {
        const shape = formatPromptShape({ story: 'abc', messageId: 391 });

        // Not `pcached=0` — that is a real reading, and the two must never be the same line.
        expect(shape).not.toContain('pseq');
        expect(shape).not.toContain('pcached');
    });

    test('a measurement of zero reuse is still a measurement and is sent', () => {
        const shape = formatPromptShape({
            story: 'abc',
            messageId: 391,
            measured: { seq: 4, cached: 0, processed: 45550, ms: 54800 },
        });

        expect(shape).toContain(';pseq=4;pcached=0;pproc=45550;pms=54800');
    });

    test('every field is a number, so nothing a client sends can become prose in st.log', () => {
        const shape = formatPromptShape({
            story: 'abc',
            messageId: 391,
            measured: { seq: 4, cached: 1880, processed: 43689, ms: 55120 },
        });

        for (const pair of shape.slice(3).split(';')) {
            expect(pair).toMatch(/^[a-z]{1,12}=\d+$/);
        }
    });
});

describe('an offset can be placed without inferring the bounds', () => {
    test('every top-level part is printed with absolute start and end', () => {
        const shape = new Map([['story', 9929], ['ex', 2300], ['hist', 187491], ['cont', 0]]);

        expect(describeLayout(shape)).toBe('story 0..9929, ex 9929..12229, hist 12229..199720, cont 199720..199720');
    });

    test('a missing part counts as zero rather than shifting everything after it', () => {
        const shape = new Map([['story', 100], ['hist', 50]]);

        expect(describeLayout(shape)).toBe('story 0..100, ex 100..100, hist 100..150, cont 150..150');
    });

    test('no shape says so instead of printing bounds that would be invented', () => {
        expect(describeLayout(null)).toBe('no shape to place offsets against');
    });

    test('🔴 the bounds are logged even when no part changed size', () => {
        // The failure this exists for: `parts:` omits every unchanged field, so a part that changed
        // CONTENT under a constant length is invisible there while being the whole cause.
        send([HEADER_LINE, ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0');
        send([HEADER_LINE.replace('SYSTEM', 'SYSTEQ'), ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0');

        const written = readLog();

        expect(written).toContain('layout: story 0..19, ex 19..19, hist 19..100019, cont 100019..100019');
    });
});

describe('which part changed CONTENT, which is what a size delta cannot say', () => {
    const shape = (story, ex, hist) => new Map([['story', story], ['ex', ex], ['hist', hist], ['cont', 0]]);

    test('🔴 a part that mutates without resizing is named, and called out as SAME LENGTH', () => {
        // The 2026-08-27 case: identical sizes on both sides, so `parts:` reported nothing at all.
        const before = 'STORYAAAAA' + 'EXAMPLE___' + 'HISTORY___';
        const after = 'STORYBBBBB' + 'EXAMPLE___' + 'HISTORY___';

        const line = describePartDiff(before, shape(10, 10, 10), after, shape(10, 10, 10));

        expect(line).toContain('story CHANGED at 5 of 10 (SAME LENGTH)');
        expect(line).toContain('ex IDENTICAL');
        expect(line).toContain('hist IDENTICAL');
    });

    test('an unchanged part is stated as identical rather than omitted', () => {
        const text = 'STORYAAAAA' + 'EXAMPLE___' + 'HISTORY___';

        expect(describePartDiff(text, shape(10, 10, 10), text, shape(10, 10, 10)))
            .toBe('story IDENTICAL, ex IDENTICAL, hist IDENTICAL, cont IDENTICAL');
    });

    test('a resized part reports its delta instead of SAME LENGTH', () => {
        const before = 'STORYAAAAA' + 'EX__' + 'HISTORY___';
        const after = 'STORYAAAAA' + 'EXAMPLE___' + 'HISTORY___';

        const line = describePartDiff(before, shape(10, 4, 10), after, shape(10, 10, 10));

        expect(line).toContain('story IDENTICAL');
        expect(line).toContain('ex CHANGED at 2 of 10 (+6)');
    });

    test('a drift between the parts and the prompt is admitted, not hidden', () => {
        // The shape is measured before `getCombinedPrompt` strips carriage returns, so boundaries are
        // exact only when the prompt carried none. Saying so beats reporting a confident wrong offset.
        const line = describePartDiff('AAAA', shape(2, 1, 1), 'AAAAAA', shape(2, 1, 1));

        expect(line).toContain('offsets approximate: parts total 4, prompt is 6 (+2)');
    });

    test('no shape on one side says so rather than comparing nothing', () => {
        expect(describePartDiff('a', null, 'b', shape(1, 0, 0)))
            .toBe('no shape on one side, so parts cannot be compared');
    });

    test('🔴 the content line reaches st.log, and carries no text from either prompt', () => {
        send([HEADER_LINE, ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0');
        send([HEADER_LINE.replace('SYSTEM', 'SYSTEQ'), ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0');

        const written = readLog();

        expect(written).toContain('content: story CHANGED at');
        expect(written).not.toContain(SECRET);
        expect(written).not.toContain(HEADER_LINE);
    });
});

describe('🔴 the COLD TURN warning is the backend speaking, not the analyzer guessing', () => {
    test('a measured miss warns, and names the seq the backend actually measured', () => {
        send([HEADER_LINE, ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0');
        send([HEADER_LINE, ...BODY, 'a reply'].join('\n'),
            'v1;story=19;ex=0;hist=100000;cont=0;pseq=1;pcached=2120;pproc=42770;pms=53445');

        const written = readLog();

        expect(written).toContain('seq 1: COLD TURN. The backend reused 4.7% and had to process 42770 of 44890 tokens.');
    });

    test('a measured hit does not warn, however the line-level estimate reads', () => {
        // The 2026-08-27 failure: six consecutive turns predicted ~5% reusable while the backend reused
        // 78-88%, because `replayReuseLoop` compares whole LINES and llama.cpp compares tokens. A history
        // line differing by two characters keeps nearly all its tokens. `grep 'COLD TURN'` cried wolf.
        send([HEADER_LINE, ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0');
        send([HEADER_LINE.replace('SYSTEM', 'SYSTEQ'), ...BODY].join('\n'),
            'v1;story=19;ex=0;hist=100000;cont=0;pseq=1;pcached=38254;pproc=6741;pms=20362');

        const written = readLog();

        // The estimate may still say it expects a cold turn — that is its job and it is labelled as such.
        expect(written).toContain('MEASURED by the backend: reused 38254');
        expect(written).not.toContain('COLD TURN. The backend');
    });

    test('the measurement audits the prediction out loud when the two disagree', () => {
        // ⚠️ seq 1 HAS NO PREDICTION TO AUDIT, and that is correct rather than a gap: the first
        // generation has no predecessor, so no geometry was ever computed for it. Comparison starts at 2.
        send([HEADER_LINE, ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0');
        send([HEADER_LINE.replace('SYSTEM', 'SYSTEP'), ...BODY].join(String.fromCharCode(10)), 'v1;story=19;ex=0;hist=100000;cont=0');
        send([HEADER_LINE.replace('SYSTEM', 'SYSTEQ'), ...BODY].join('\n'),
            'v1;story=19;ex=0;hist=100000;cont=0;pseq=2;pcached=38254;pproc=6741;pms=20362');

        // Both numbers were already in st.log three lines apart on the night this happened, and the
        // contradiction still went unnoticed for hours. Now the line says so itself.
        expect(readLog()).toContain('OFF BY');
    });

    test('no measurement means no measured warning, rather than a warning about nothing', () => {
        send([HEADER_LINE, ...BODY].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0');
        send([HEADER_LINE, ...BODY, 'a reply'].join('\n'), 'v1;story=19;ex=0;hist=100000;cont=0');

        expect(readLog()).not.toContain('COLD TURN. The backend');
    });
});
