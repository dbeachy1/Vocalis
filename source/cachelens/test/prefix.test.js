import assert from 'node:assert/strict';
import test from 'node:test';

import { commonPrefixChars, describeReuse } from '../prefix.js';
import { PREFIX_FIXTURES, SYSTEM } from './fixtures.js';

/**
 * The scan without the surrogate backoff, so the astral fixture can prove the backoff changes the answer
 * rather than merely agreeing with it.
 * @param {string} a First string
 * @param {string} b Second string
 * @returns {number} Shared code units
 */
function naiveScan(a, b) {
    const limit = Math.min(a.length, b.length);
    let i = 0;

    while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) {
        i++;
    }

    return i;
}

/**
 * The fixture with this name.
 *
 * ⚠️ A NAMED LOOKUP FAILS LOUDLY HERE OR IT FAILS CONFUSINGLY LATER. `find` answers `undefined` for a
 * fixture that was renamed, and the test that dereferences it then dies on `prev` — a TypeError pointing at
 * the scanner rather than at the fixture that is no longer there. Asserting here is what makes the real
 * cause the message.
 * @param {string} name The fixture's name
 * @returns {import('./fixtures.js').PrefixFixture} It
 */
function fixtureNamed(name) {
    const fixture = PREFIX_FIXTURES.find(f => f.name === name);

    assert.ok(fixture, `no fixture named ${name}`);

    return fixture;
}

/**
 * A value of a shape the signature does not admit at all.
 *
 * 🔴 THE WRONG TYPE IS THE SUBJECT OF THE TEST BELOW, SO THE CAST IS THE ASSERTION. `commonPrefixChars`
 * takes `string|null|undefined` and the absent cases need no help — but its guard is `typeof !== 'string'`,
 * which catches anything at all, and the record it reads from is JSON nobody typed. A test that could only
 * hand it values the contract allows would leave the rest of that guard as dead code nothing had entered.
 * @param {unknown} value What the record can really hold
 * @returns {string} The same value, as the signature insists on seeing it
 */
function notAString(value) {
    return /** @type {string} */ (value);
}

for (const fixture of PREFIX_FIXTURES) {
    test(`prefix: ${fixture.name} — ${fixture.catches}`, () => {
        assert.equal(commonPrefixChars(fixture.prev, fixture.next), fixture.expectedPrefix);
    });
}

test('top-edit is the regression test for this whole design: nearly identical, nearly no reuse', () => {
    const fixture = fixtureNamed('top-edit');
    const { ratio } = describeReuse(fixture.prev, fixture.next);

    // A diff would score these ~99% identical: only three characters differ in ~100,000.
    let differing = 0;

    for (let i = 0; i < fixture.next.length; i++) {
        if (fixture.prev[i] !== fixture.next[i]) {
            differing++;
        }
    }

    assert.ok(differing <= 3, `expected a tiny edit, got ${differing} differing characters`);
    // 🔴 And the cache reuses essentially none of it. If this ever passes with a high ratio, the
    // implementation has drifted back into being a diff.
    assert.ok(ratio < 0.001, `expected near-zero reuse, got ${(ratio * 100).toFixed(2)}%`);
});

test('completion-extends: the baseline must include the reply, or reuse is under-reported by its length', () => {
    const fixture = fixtureNamed('completion-extends');
    const promptOnly = fixture.prev.slice(0, fixture.prev.lastIndexOf('Marla: Safe enough'));

    assert.equal(commonPrefixChars(fixture.prev, fixture.next), fixture.expectedPrefix);
    assert.ok(
        commonPrefixChars(promptOnly, fixture.next) < fixture.expectedPrefix,
        'comparing against the prompt alone should be strictly worse — that is the bug §4.1 describes',
    );
});

test('astral-split: the backoff moves the answer off the middle of a surrogate pair', () => {
    const fixture = fixtureNamed('astral-split');

    assert.equal(naiveScan(fixture.prev, fixture.next), SYSTEM.length + 1, 'the naive scan splits the pair');
    assert.equal(commonPrefixChars(fixture.prev, fixture.next), SYSTEM.length);
});

test('a trailing surrogate pair in two identical strings is not backed off', () => {
    assert.equal(commonPrefixChars('hello \uD83D\uDE00', 'hello \uD83D\uDE00'), 8);
});

test('a shared astral character followed by ordinary divergence keeps the whole pair', () => {
    assert.equal(commonPrefixChars('a\uD83D\uDE00b', 'a\uD83D\uDE00c'), 3);
});

test('empty-prev is no baseline, which is not zero reuse', () => {
    const fixture = fixtureNamed('empty-prev');
    const described = describeReuse(fixture.prev, fixture.next);

    assert.equal(described.hasBaseline, false);
    assert.equal(described.prefixChars, 0);
    assert.equal(described.ratio, 0);

    // And a real baseline that happens to share nothing IS zero reuse — the two must stay distinguishable.
    const nothingShared = describeReuse('zzz', fixture.next);

    assert.equal(nothingShared.hasBaseline, true);
    assert.equal(nothingShared.prefixChars, 0);
});

test('non-strings are zero, not a throw', () => {
    assert.equal(commonPrefixChars(null, 'x'), 0);
    assert.equal(commonPrefixChars('x', undefined), 0);
    assert.equal(commonPrefixChars(notAString(['x']), 'x'), 0);
});

test('no normalization: line endings and whitespace are real divergences', () => {
    assert.equal(commonPrefixChars('a\r\nb', 'a\nb'), 1);
    assert.equal(commonPrefixChars('a  b', 'a b'), 2);
    // NFC vs NFD of the same character — the backend tokenized one of them, not both.
    assert.equal(commonPrefixChars('caf\u00E9', 'cafe\u0301'), 3);
});
