import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll } from '@jest/globals';

import { DEPENDENCIES, formatReport, gitRevision, preflight, resolveDependency, serverDirectory } from './integration/preflight.mjs';
import { makeScratchDirectory } from './util/st-server.js';

/**
 * 🔴 The preflight is the thing standing between "this suite checked nothing" and "this suite
 * reported green", so it is tested here, in the UNIT suite, rather than in the integration suites it
 * guards.
 *
 * That placement is the point. The integration suites cannot run on a machine without Vault and
 * Mnemosyne installed — which is exactly the machine where a broken preflight does its damage, and
 * exactly the machine this file runs on. Testing the gate only inside the thing it gates would mean
 * the gate is unverified precisely when it matters.
 *
 * No dependency is installed or needed here: every case drives a scratch root.
 */

/** A root with nothing installed in it. */
let emptyRoot;
/** A root with a directory sitting where Vault would be. */
let populatedRoot;

/**
 * Swallow the report so the suite output stays readable; the assertions read it from the return.
 * @returns {void}
 */
function quiet() { }

beforeAll(() => {
    emptyRoot = makeScratchDirectory('preflight-empty');
    populatedRoot = makeScratchDirectory('preflight-populated');
    fs.mkdirSync(path.join(populatedRoot, DEPENDENCIES.vault.relativePath), { recursive: true });
});

describe('🚦 the integration preflight', () => {
    describe('🔴 when a dependency is missing', () => {
        test('it THROWS by default — never a quiet pass', () => {
            expect(() => preflight('suite A', [DEPENDENCIES.vault], { root: emptyRoot, print: quiet }))
                .toThrow(/Refusing to run "suite A"/);
        });

        test('the failure names the path it looked at and how to install it', () => {
            let message = '';

            try {
                preflight('suite A', [DEPENDENCIES.vault], { root: emptyRoot, print: quiet });
            } catch (error) {
                message = error.message;
            }

            // Vacuity guard: if nothing threw, the assertions below would pass against an empty string.
            expect(message).not.toBe('');
            expect(message).toContain(path.join(emptyRoot, DEPENDENCIES.vault.relativePath));
            expect(message).toContain(DEPENDENCIES.vault.installHint);
        });

        test('🟡 permissive mode skips instead — and still says what was missing', () => {
            const result = preflight('suite A', [DEPENDENCIES.vault], { root: emptyRoot, permissive: true, print: quiet });

            expect(result.run).toBe(false);
            expect(result.report).toContain('NOT FOUND');
            expect(result.report).toContain(DEPENDENCIES.vault.name);
        });

        test('a missing dependency is reported even when another one is present', () => {
            const result = preflight('suite B', [DEPENDENCIES.vault, DEPENDENCIES.mnemosyne], { root: populatedRoot, permissive: true, print: quiet });

            expect(result.run).toBe(false);
            expect(result.resolved.find(one => one.key === 'vault').present).toBe(true);
            expect(result.resolved.find(one => one.key === 'mnemosyne').present).toBe(false);
        });
    });

    describe('✅ when the dependency is there', () => {
        test('it runs, and the report carries the revision', () => {
            const result = preflight('suite A', [DEPENDENCIES.vault], { root: populatedRoot, print: quiet });

            expect(result.run).toBe(true);
            expect(result.report).toContain(DEPENDENCIES.vault.name);
            expect(result.report).toContain(result.resolved[0].revision);
        });

        test('the report is actually PRINTED — an unattributable green run is the failure mode', () => {
            const printed = [];

            preflight('suite A', [DEPENDENCIES.vault], { root: populatedRoot, print: line => printed.push(line) });

            expect(printed).toHaveLength(1);
            expect(printed[0]).toContain(DEPENDENCIES.vault.name);
        });
    });

    describe('🔎 the revision it pins', () => {
        test('a real checkout resolves to a real short hash', () => {
            expect(gitRevision(serverDirectory)).toMatch(/^[0-9a-f]{7,}$/);
        });

        test('⚠️ a directory that is not a checkout says so — it never comes back blank', () => {
            const revision = gitRevision(populatedRoot);

            expect(revision).toBe('unknown — not a git checkout');
            expect(revision).not.toBe('');
        });

        test('a missing dependency has no revision at all, rather than a fake one', () => {
            expect(resolveDependency(DEPENDENCIES.vault, emptyRoot).revision).toBeNull();
        });
    });

    test('📁 it resolves against the real repository root by default', () => {
        expect(fs.existsSync(path.join(serverDirectory, 'package.json'))).toBe(true);
        expect(resolveDependency(DEPENDENCIES.mnemosyne).absolutePath)
            .toBe(path.join(serverDirectory, 'plugins', 'SillyTavern-Mnemosyne'));
    });

    test('🧾 the report names every dependency it was asked about', () => {
        const resolved = [DEPENDENCIES.vault, DEPENDENCIES.mnemosyne].map(one => resolveDependency(one, emptyRoot));
        const report = formatReport('suite B', resolved);

        expect(report).toContain('suite B');
        expect(report).toContain(DEPENDENCIES.vault.name);
        expect(report).toContain(DEPENDENCIES.mnemosyne.name);
    });
});
