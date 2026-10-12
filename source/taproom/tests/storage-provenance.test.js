import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';

import {
    REGISTRY_FILE_NAME,
    loadProvenanceRegistry,
    lookupProviderIdentity,
    recordProviderIdentity,
    registryPathFor,
    resetProvenanceRegistry,
} from '../src/storage-provenance.js';
import { makeScratchDirectory } from './util/st-server.js';

/**
 * 🪪 THE PROVENANCE REGISTRY — `DESIGN_STORAGE_PROVENANCE.md` §5, §6, §8, and tests 2 and 4–7 of §9.
 *
 * The design's whole idea is an inversion, and these tests exist to hold it in place: **identity is recorded
 * while the provider is present and trusted, and looked up later when it is gone.** The id on a file is
 * attacker-controlled — it lives outside the crypto because it must be readable with no key — so nothing
 * about a provider may be believed on the strength of a file naming it.
 *
 * That makes the interesting cases the refusals, and they are what most of this file is. A registry that
 * cheerfully stores whatever a provider declares would render an attacker's name with the fork's own
 * confidence, one uninstall later.
 */

/** @type {string} */
let scratch;

/** Every scratch directory made here, removed at the end. */
const scratches = [];

beforeEach(() => {
    resetProvenanceRegistry();
    scratch = makeScratchDirectory('provenance');
    scratches.push(scratch);
});

afterAll(() => {
    resetProvenanceRegistry();
    for (const dir of scratches) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * §9 test 5's table: hostile and merely broken declarations, which §6 insists must fail the same way.
 *
 * The two kinds are deliberately mixed together in one list, because there is one validation path and it
 * does not care which of them it is looking at — a 4 MB `name` is a bug rather than an attack, and it has to
 * fail exactly as a planted one does or the code has grown a second, softer rule for well-meaning providers.
 */
const MALFORMED_DECLARATIONS = [
    { label: 'markup in the name', bad: { name: '<script>alert(1)</script>' } },
    { label: 'a 4 MB name', bad: { name: 'a'.repeat(4 * 1024 * 1024) } },
    { label: 'a name one character over the cap', bad: { name: 'a'.repeat(65) } },
    { label: 'a newline smuggled into the name', bad: { name: 'Real Name\nThis chat is safe to delete' } },
    { label: 'a javascript: source', bad: { source: 'javascript:alert(1)' } },
    { label: 'a data: source', bad: { source: 'data:text/html,<script>alert(1)</script>' } },
    { label: 'a file: source', bad: { source: 'file:///etc/passwd' } },
    { label: 'markup in the version', bad: { version: '<b>2.3</b>' } },
    { label: 'a non-string name', bad: { name: { nested: 'Real Name' } } },
    { label: 'a non-array envelopeVersions', bad: { envelopeVersions: 1 } },
    { label: 'a non-integer envelope version', bad: { envelopeVersions: [1.5] } },
    { label: 'an envelope version outside the four-digit grammar', bad: { envelopeVersions: [100000] } },
    { label: 'a negative envelope version', bad: { envelopeVersions: [-1] } },
    { label: 'an absurd number of envelope versions', bad: { envelopeVersions: Array.from({ length: 17 }, (_value, index) => index) } },
];

/** §9 test 6's table: every way a registry file can be worth nothing. All of them must cost only itself. */
const UNUSABLE_REGISTRY_FILES = [
    { label: 'empty', contents: '' },
    { label: 'not JSON', contents: 'this is not json {{{' },
    { label: 'JSON of the wrong shape', contents: '[1,2,3]' },
    { label: 'JSON with no providers key', contents: '{"version":1}' },
    { label: 'providers that is not an object', contents: '{"version":1,"providers":"nope"}' },
];

/** A well-formed declaration, of the shape §6 specifies. */
const DECLARATION = Object.freeze({
    id: 'testprov',
    name: 'SillyTavern-TestProv',
    source: 'https://github.com/example/sillytavern-testprov',
    version: '2.3.0',
    envelopeVersions: [1],
});

/**
 * Point the registry at a fresh file in the scratch directory and load it.
 * @returns {string} The registry path
 */
function useRegistry() {
    const file = registryPathFor(scratch);
    loadProvenanceRegistry(file);
    return file;
}

/**
 * Read the registry file back as the fork wrote it.
 * @param {string} file The registry path
 * @returns {any} The parsed file
 */
function readRegistry(file) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe('recording a provider that is present, so it can be named once it is gone', () => {
    test('a full declaration round-trips, and survives the plugin being uninstalled', () => {
        const file = useRegistry();
        recordProviderIdentity('testprov', DECLARATION);

        // §9 test 1, in the small: the process restarts, no provider loads at all, and the fork still knows
        // the name. This is the entire point of writing it to disk rather than holding it in memory.
        resetProvenanceRegistry();
        loadProvenanceRegistry(file);

        const found = lookupProviderIdentity('testprov');
        expect(found.name).toBe('SillyTavern-TestProv');
        expect(found.version).toBe('2.3.0');
        expect(found.source).toBe('https://github.com/example/sillytavern-testprov');
        expect(found.envelopeVersions).toEqual([1]);
    });

    test('the fork stamps its own clock, and firstSeen survives later boots', () => {
        const file = useRegistry();
        const first = recordProviderIdentity('testprov', DECLARATION);

        expect(first.firstSeen).toEqual(expect.any(String));
        expect(first.lastSeen).toEqual(expect.any(String));

        // A second boot must not restate when the user first had it — that date IS the orientation the
        // sentence offers ("you had this installed until…"), and resetting it every boot would erase it.
        loadProvenanceRegistry(file);
        const second = recordProviderIdentity('testprov', DECLARATION);
        expect(second.firstSeen).toBe(first.firstSeen);
    });

    test('a routine version bump is an upgrade, not a collision', () => {
        // 🔴 The counterpart to the §8 conflict test below, and the reason `isDifferentProvider` looks at
        // name and source rather than at everything. A registry that flagged a conflict on the second
        // release of every provider would mark them all id-only, permanently, and the "update the plugin"
        // sentence of §7 needs the version to be the CURRENT one.
        useRegistry();
        recordProviderIdentity('testprov', DECLARATION);
        recordProviderIdentity('testprov', { ...DECLARATION, version: '2.4.0', envelopeVersions: [1, 2] });

        const found = lookupProviderIdentity('testprov');
        expect(found.version).toBe('2.4.0');
        expect(found.envelopeVersions).toEqual([1, 2]);
        expect(found.conflict).toBeUndefined();
    });
});

/** §9 test 2. The half that proves the design: a fork that only behaves when the provider is chatty. */
describe('§9.2 a provider that declares nothing degrades to today, and nothing throws', () => {
    test('no declaration at all is recorded by id alone', () => {
        useRegistry();

        expect(() => recordProviderIdentity('testprov', null)).not.toThrow();
        expect(() => recordProviderIdentity('testprov', undefined)).not.toThrow();

        const found = lookupProviderIdentity('testprov');
        expect(found.id).toBe('testprov');
        expect(found.name).toBeUndefined();
        expect(found.source).toBeUndefined();
    });

    test('a declaration with only some fields keeps those and stays silent about the rest', () => {
        useRegistry();
        recordProviderIdentity('testprov', { id: 'testprov', name: 'Minimal' });

        const found = lookupProviderIdentity('testprov');
        expect(found.name).toBe('Minimal');
        expect(found.version).toBeUndefined();
        expect(found.source).toBeUndefined();
    });

    test('an id nothing was ever recorded for answers null, not a guess', () => {
        useRegistry();
        recordProviderIdentity('testprov', DECLARATION);

        expect(lookupProviderIdentity('never-installed')).toBeNull();
    });
});

/**
 * §9 test 3, in the small — the case §4's trust model exists to keep boring.
 *
 * A user restoring someone else's backup, or a data directory from another machine, meets an id that was
 * never installed here. The answer must be the bare id and nothing else, and in particular there must be
 * nowhere for a name or a URL to come from.
 */
describe('🔴 §9.3 a planted id finds no record, and cannot borrow another provider\'s identity', () => {
    test('a planted id gets nothing, even while a real provider is recorded', () => {
        useRegistry();
        recordProviderIdentity('testprov', DECLARATION);

        expect(lookupProviderIdentity('evil-plugin')).toBeNull();
    });

    test('an id that fails the envelope character class never reaches the registry at all', () => {
        useRegistry();
        recordProviderIdentity('testprov', DECLARATION);

        for (const bad of ['<script>alert(1)</script>', '../../etc/passwd', 'TestProv', 'test prov', '', 'a'.repeat(33)]) {
            expect(lookupProviderIdentity(bad)).toBeNull();
            expect(recordProviderIdentity(bad, { ...DECLARATION, id: bad })).toBeNull();
        }

        // And nothing hostile was written to the file on the way past.
        expect(fs.readFileSync(registryPathFor(scratch), 'utf-8')).not.toContain('script');
    });

    test('lookup tolerates the null the envelope parser hands back for an unusable id', () => {
        useRegistry();

        expect(lookupProviderIdentity(null)).toBeNull();
        expect(lookupProviderIdentity(undefined)).toBeNull();
    });
});

/**
 * §9 test 4. A declaration whose `id` is not the id the provider writes into its envelopes.
 *
 * Every file on disk would key to an entry that can never match. That is strictly worse than no entry: it
 * looks exactly like a working feature, right up until a user needs it.
 */
describe('🔴 §9.4 a declaration whose id contradicts the provider is refused', () => {
    test('the mismatched declaration is not stored, and the provider is kept by id alone', () => {
        useRegistry();
        recordProviderIdentity('testprov', { ...DECLARATION, id: 'something-else' });

        const found = lookupProviderIdentity('testprov');
        expect(found.id).toBe('testprov');
        expect(found.name).toBeUndefined();

        // 🔴 And emphatically not filed under the id it claimed, which would be the mapping it just told us
        // is wrong, stored anyway.
        expect(lookupProviderIdentity('something-else')).toBeNull();
    });
});

/**
 * §9 test 5. Hostile and merely broken fields, which §6 insists must fail the same way — there is one
 * validation path and it does not care which of the two it is looking at.
 */
describe('🔴 §9.5 malformed and hostile fields are refused, never stored, never half-stored', () => {
    for (const { label, bad } of MALFORMED_DECLARATIONS) {
        test(`${label} refuses the whole declaration`, () => {
            useRegistry();
            recordProviderIdentity('testprov', { ...DECLARATION, ...bad });

            const found = lookupProviderIdentity('testprov');

            // 🔴 Recorded by id alone — NOT partially populated from the fields that happened to validate. A
            // half-stored entry renders an attacker-shaped record beside trustworthy ones, and tells the
            // provider nothing about having got the interface wrong.
            expect(found.id).toBe('testprov');
            expect(found.name).toBeUndefined();
            expect(found.source).toBeUndefined();
            expect(found.version).toBeUndefined();
            expect(found.envelopeVersions).toBeUndefined();
        });
    }

    test('none of it reaches the file on disk either', () => {
        const file = useRegistry();
        recordProviderIdentity('testprov', {
            ...DECLARATION,
            name: '<script>alert(1)</script>',
            source: 'javascript:alert(1)',
        });

        const raw = fs.readFileSync(file, 'utf-8');
        expect(raw).not.toContain('script');
        expect(raw).not.toContain('javascript:');
    });

    test('a hand-edited registry file is re-validated on the way in, not trusted for having been ours', () => {
        // The file is written by the fork, but "written by the fork" is a claim about the past. Anyone who
        // can edit it can put a name in it; the check on read is what stops that name being rendered.
        const file = registryPathFor(scratch);
        fs.writeFileSync(file, JSON.stringify({
            version: 1,
            providers: {
                testprov: { id: 'testprov', name: '<img src=x onerror=alert(1)>', source: 'javascript:alert(1)' },
                'good-one': { id: 'good-one', name: 'Perfectly Fine' },
            },
        }));

        loadProvenanceRegistry(file);

        expect(lookupProviderIdentity('testprov')).toBeNull();
        expect(lookupProviderIdentity('good-one').name).toBe('Perfectly Fine');
    });

    test('the good fields of an acceptable declaration are still stored — the refusals are not a blanket', () => {
        // A validation rule that refused everything would pass every test above and deliver nothing.
        useRegistry();
        recordProviderIdentity('a-provider', {
            id: 'a-provider',
            name: 'Provider (Community Build) 1.0',
            source: '@example/st-provider',
            version: '1.0.0-beta.2',
            envelopeVersions: [0, 1, 2],
        });

        expect(lookupProviderIdentity('a-provider')).toMatchObject({
            name: 'Provider (Community Build) 1.0',
            source: '@example/st-provider',
            version: '1.0.0-beta.2',
            envelopeVersions: [0, 1, 2],
        });
    });
});

/** §9 test 6. The registry is an enrichment; losing it must cost nothing but the enrichment. */
describe('§9.6 a registry that is missing, empty or corrupt behaves as no registry at all', () => {
    test('missing entirely: lookups answer null and nothing throws', () => {
        // The normal case on a fork that has never run a provider, and therefore the one that must be
        // silent rather than merely survivable.
        const file = path.join(scratch, REGISTRY_FILE_NAME);

        expect(() => loadProvenanceRegistry(file)).not.toThrow();
        expect(lookupProviderIdentity('testprov')).toBeNull();
    });

    for (const { label, contents } of UNUSABLE_REGISTRY_FILES) {
        test(`${label}: lookups answer null and nothing throws`, () => {
            const file = path.join(scratch, REGISTRY_FILE_NAME);
            fs.writeFileSync(file, contents);

            expect(() => loadProvenanceRegistry(file)).not.toThrow();
            expect(lookupProviderIdentity('testprov')).toBeNull();
        });
    }

    test('a registry that was never loaded at all answers null rather than throwing', () => {
        // The state a fork runs in before this feature existed, and the state every unrelated unit test
        // runs in. It must be a supported one.
        expect(() => lookupProviderIdentity('testprov')).not.toThrow();
        expect(lookupProviderIdentity('testprov')).toBeNull();
    });

    test('recording without a loaded registry does not throw, it simply is not persisted', () => {
        expect(() => recordProviderIdentity('testprov', DECLARATION)).not.toThrow();
    });

    test('a registry deleted between boots comes back empty rather than stale', () => {
        const file = useRegistry();
        recordProviderIdentity('testprov', DECLARATION);
        fs.rmSync(file);

        loadProvenanceRegistry(file);
        expect(lookupProviderIdentity('testprov')).toBeNull();
    });
});

/**
 * 🔴 §9 test 7 — and the assertion is on the PATH, not on the intention.
 *
 * The whole design assumes the data directory is writable by an attacker; that assumption is why the id on a
 * file is untrusted in the first place. A registry living in there would be forgeable by exactly the party
 * it exists to identify, and the forgery would be more convincing than the planted file, because the fork
 * would render its name with confidence.
 */
describe('🔴 §9.7 the registry cannot be placed inside the data root', () => {
    test('it lands in the server root, beside config.yaml', () => {
        expect(registryPathFor(scratch)).toBe(path.join(scratch, REGISTRY_FILE_NAME));
    });

    test('a data root that contains the server root is refused outright', () => {
        const dataRoot = path.join(scratch, 'data');
        const serverRoot = path.join(dataRoot, 'server');

        expect(() => registryPathFor(serverRoot, dataRoot)).toThrow(/data root/i);
    });

    test('the data root being the server root itself is refused', () => {
        expect(() => registryPathFor(scratch, scratch)).toThrow(/data root/i);
    });

    test('a sibling data root is fine — the rule is containment, not name similarity', () => {
        const serverRoot = path.join(scratch, 'SillyTavern');
        const dataRoot = path.join(scratch, 'SillyTavern-data');

        expect(() => registryPathFor(serverRoot, dataRoot)).not.toThrow();
    });

    test('a relative data root spelling cannot sneak past the check', () => {
        const dataRoot = path.join(scratch, 'data');
        const serverRoot = path.join(dataRoot, 'sub', '..', 'server');

        expect(() => registryPathFor(serverRoot, path.join(dataRoot, 'x', '..'))).toThrow(/data root/i);
    });
});

/**
 * §8. Two providers claiming one id.
 *
 * Keep the first — the user's existing files key to it — record the conflict, and show the id alone from
 * then on. Silently overwriting would repoint every existing file's sentence at a plugin that did not write
 * a byte of them.
 */
describe('🔴 §8 two providers claiming one id: keep the first, name neither', () => {
    test('a second, different provider under the same id conflicts the entry', () => {
        useRegistry();
        recordProviderIdentity('testprov', DECLARATION);
        recordProviderIdentity('testprov', { ...DECLARATION, name: 'Somebody Else Entirely', source: 'https://example.invalid/other' });

        // Neither name is shown: the fork cannot say which one wrote the user's files, and a guess rendered
        // as a fact is the one thing this sentence must never contain.
        expect(lookupProviderIdentity('testprov')).toBeNull();
    });

    test('the FIRST record is what is kept on disk, not the interloper', () => {
        const file = useRegistry();
        recordProviderIdentity('testprov', DECLARATION);
        recordProviderIdentity('testprov', { ...DECLARATION, name: 'Somebody Else Entirely' });

        const stored = readRegistry(file).providers.testprov;
        expect(stored.name).toBe('SillyTavern-TestProv');
        expect(stored.conflict).toBe(true);
    });

    test('a conflict is permanent — the original provider coming back does not clear it', () => {
        useRegistry();
        recordProviderIdentity('testprov', DECLARATION);
        recordProviderIdentity('testprov', { ...DECLARATION, name: 'Somebody Else Entirely' });
        recordProviderIdentity('testprov', DECLARATION);

        // Two plugins have now demonstrably worn this id on this instance. Which of them wrote any given
        // file is not knowable from the file, and never becomes knowable later.
        expect(lookupProviderIdentity('testprov')).toBeNull();
    });

    test('an id-only record is filled in rather than conflicted when a provider starts declaring itself', () => {
        // Nothing was claimed the first time, so there is nothing to contradict. Treating this as a
        // collision would permanently silence any provider that added a declaration in a later release.
        useRegistry();
        recordProviderIdentity('testprov', null);
        recordProviderIdentity('testprov', DECLARATION);

        expect(lookupProviderIdentity('testprov').name).toBe('SillyTavern-TestProv');
    });
});

describe('the registry is a map from the start, so more than one provider fits (§8)', () => {
    test('two providers coexist, each answering for its own id', () => {
        const file = useRegistry();
        recordProviderIdentity('testprov', DECLARATION);
        recordProviderIdentity('other-prov', { id: 'other-prov', name: 'Another Provider' });

        loadProvenanceRegistry(file);
        expect(lookupProviderIdentity('testprov').name).toBe('SillyTavern-TestProv');
        expect(lookupProviderIdentity('other-prov').name).toBe('Another Provider');
    });

    test('🔴 an uninstalled provider is never garbage-collected — that entry is the entire point', () => {
        // A registry that pruned the ids it no longer sees would delete exactly the rows a user needs, at
        // exactly the moment they need them: the boot after the uninstall.
        const file = useRegistry();
        recordProviderIdentity('testprov', DECLARATION);

        // A later boot with a DIFFERENT provider installed, or none at all.
        loadProvenanceRegistry(file);
        recordProviderIdentity('other-prov', { id: 'other-prov', name: 'Another Provider' });

        loadProvenanceRegistry(file);
        expect(lookupProviderIdentity('testprov').name).toBe('SillyTavern-TestProv');
    });

    test('a caller cannot mutate the registry through the object it is handed', () => {
        useRegistry();
        recordProviderIdentity('testprov', DECLARATION);

        lookupProviderIdentity('testprov').name = 'Tampered';
        expect(lookupProviderIdentity('testprov').name).toBe('SillyTavern-TestProv');
    });
});
