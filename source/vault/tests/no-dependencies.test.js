import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect } from '@jest/globals';

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * ⛔ THE PLUGIN HAS NO RUNTIME DEPENDENCIES, AND THIS TEST IS WHY IT STAYS THAT WAY.
 *
 * The threat model includes untrusted packages executing in the application process. Application-layer
 * encryption keeps their access to key material within the vault boundary.
 *
 * A runtime dependency in THIS package is that threat, with a key in its hands. It would not have to
 * exfiltrate anything or break any cipher — it runs in the same process as the DEK, after unlock. It
 * could simply read it.
 *
 * So the dependency count is not a tidiness metric. It is a security boundary, and it is zero:
 *
 *   - argon2id      Node 24 core (`crypto.argon2Sync`), pinned against RFC 9106 §5.3
 *   - AES-256-GCM   Node core
 *   - HKDF, CMAC    Node core
 *   - AES-SIV       written here from RFC 5297, and checked against the RFC's own vectors
 *
 * If someone adds a package to make something convenient, this test fails and makes them argue for it.
 */
describe('⛔ zero runtime dependencies', () => {
    /** @type {any} */
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf-8'));

    test('⛔ package.json declares NO runtime dependencies', () => {
        const dependencies = Object.keys(manifest.dependencies ?? {});

        // Runtime dependencies execute in the same process as key handling, so each one expands the trusted
        // code boundary.
        expect(dependencies).toEqual([]);
    });

    test('⛔ and no optional or peer dependencies either — the same process is the same process', () => {
        expect(Object.keys(manifest.optionalDependencies ?? {})).toEqual([]);
        expect(Object.keys(manifest.peerDependencies ?? {})).toEqual([]);
    });

    test('it requires Node 24, which is what makes zero possible', () => {
        // Node 24 provides argon2id in core. Without it there is no way to derive the key without either
        // taking a dependency or writing a memory-hard KDF by hand, and both of those are worse.
        expect(manifest.engines.node).toMatch(/>=\s*24/);
    });
});
