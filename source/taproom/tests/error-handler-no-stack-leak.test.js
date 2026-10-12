import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * 🔴 A 500 MUST NOT QUOTE THE USER'S FILE BACK OVER HTTP.
 *
 * Until `applyErrorMiddleware` existed (`src/server-main.js`) this tree registered no 4-arg express
 * handler at all, so a thrown error fell through to express's `finalhandler`, which answers with
 * `err.stack` whenever `NODE_ENV` is not `production` — and `NODE_ENV` is normally unset here. That is
 * harmless for a `TypeError` and not harmless for the error this tree throws most, which is
 * `JSON.parse` against a file the user owns: V8's "Unexpected token" message quotes a window of the
 * input back inside the message.
 *
 *     JSON.parse('{"content": SOMETHING}')
 *     → SyntaxError: Unexpected token 'S', ..."content": SOMETHIN"... is not valid JSON
 *
 * `readWorldInfoFile`'s deliberate rethrow (`src/endpoints/worldinfo.js`) therefore answered a corrupt
 * lorebook with a fragment of that lorebook in the HTTP body.
 *
 * ## What this is and is not
 *
 * It was a HAZARD, not a breach: the body only ever reached the session that asked for it, and that
 * session already owns the file. The reason it still had to go is that a response body travels where a
 * file does not — a client's own error log, a bug report, a screenshot — and in a fork whose premise is
 * that this content is encrypted at rest, decrypted fragments have no business in transport. The
 * The Vocalis worldbook editor round-trips books from an authenticated session and
 * would have captured any non-2xx body into its own logs.
 *
 * ## Why the canary is planted in the middle of the fixture
 *
 * V8 quotes a window AROUND the error position, not the head of the input, so a canary at the front
 * would prove nothing about a book whose damage is in entry 400. The fixture puts the mark immediately
 * before the syntax error, which is the worst case and the one a regression would actually reproduce.
 *
 * ⚠️ THE NON-VACUITY CHECK IS THE POINT OF `the parse error really does carry the canary`. Every
 * assertion here is a negative — "the body does not contain X" — and a negative passes just as happily
 * when the request 404s, when the file was never read, or when the canary was never in the error to
 * begin with. That test pins the premise: these exact bytes produce an error whose message quotes the
 * mark. Without it the rest of this file is green regardless of what the server does.
 */
describe('🔴 The error handler does not leak file content or stack traces', () => {
    /** @type {string} */
    let scratch;
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let st;
    /** @type {string} */
    let base;
    /** @type {string} */
    let worldsDirectory;

    /** The mark. Distinctive enough that a substring match cannot collide with anything express emits. */
    const CANARY = 'ZZCANARY-9f3a1c-lorebook-body-text';

    /**
     * Unparseable, PLAINTEXT, and damaged right after the canary.
     *
     * 🔴 Plaintext deliberately: enveloped bytes would trip the `describeUnavailableData` guard in
     * `/api/worldinfo/get` and return a clean 409 long before anything threw, testing the other feature
     * and reporting green for this one. The unquoted value is what steers V8 into the "Unexpected
     * token" message family — the only one that quotes the input.
     */
    const CORRUPT = `{"entries": {"0": {"uid": 0, "content": ${CANARY}}}}`;

    /** An ordinary world, so the 500 below is proved to be about these bytes and not about the route. */
    const ORDINARY = 'An Ordinary World';
    const CORRUPT_NAME = 'A Damaged World';

    beforeAll(async () => {
        scratch = makeScratchDirectory('error-handler-no-stack-leak');

        st = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);
        base = `http://127.0.0.1:${st.port}`;
        worldsDirectory = path.join(scratch, 'data', 'default-user', 'worlds');

        fs.mkdirSync(worldsDirectory, { recursive: true });
        fs.writeFileSync(path.join(worldsDirectory, `${CORRUPT_NAME}.json`), CORRUPT);
        fs.writeFileSync(path.join(worldsDirectory, `${ORDINARY}.json`), JSON.stringify({ entries: {} }));
    }, 240_000);

    afterAll(async () => {
        await st?.stop();
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    /**
     * @param {string} url Absolute URL
     * @param {RequestInit} [init] Fetch options
     * @returns {Promise<{status: number, text: string}>} Status and raw body, unparsed
     */
    async function raw(url, init = {}) {
        const response = await fetch(url, init);
        return { status: response.status, text: await response.text() };
    }

    test('the parse error really does carry the canary, so the assertions below are not vacuous', () => {
        let message = '';
        try {
            JSON.parse(CORRUPT);
        } catch (err) {
            message = String(err.message);
        }

        expect(message).toContain('ZZCANARY');
    });

    test('🔴 a 500 from an unparseable world carries neither the content nor a stack trace', async () => {
        const { status, text } = await raw(`${base}/api/worldinfo/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: CORRUPT_NAME }),
        });

        // The route really did fail on these bytes — not a 404, not a 409, not a cheerful empty world.
        expect(status).toBe(500);

        // The assertion the whole file exists for.
        expect(text).not.toContain('ZZCANARY');
        expect(text).not.toContain('CANARY');

        // And no stack, by any of the three things one always contains.
        expect(text).not.toContain('SyntaxError');
        expect(text).not.toContain('worldinfo.js');
        expect(text).not.toMatch(/\n\s+at /);
    });

    test('an ordinary world still reads back, so the 500 is about the bytes and not the route', async () => {
        const { status, text } = await raw(`${base}/api/worldinfo/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: ORDINARY }),
        });

        expect(status).toBe(200);
        expect(JSON.parse(text)).toEqual({ entries: {} });
    });

    test('an authored 4xx message survives, because `expose` is what separates the two', async () => {
        // body-parser rejects this with an http-errors 400, which carries `expose: true`. Collapsing it
        // to a bare status would have been the easy over-correction, and it would strand every caller
        // that reads a 4xx body — including the CSRF 403 whose text `server-main.js` customises.
        const { status, text } = await raw(`${base}/api/worldinfo/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"name": ',
        });

        expect(status).toBe(400);
        expect(text.length).toBeGreaterThan(0);
    });

    test('the 404 page still answers, so registering the handler last did not shadow it', async () => {
        const { status } = await raw(`${base}/api/definitely-not-a-route`, { method: 'POST' });

        expect(status).toBe(404);
    });
});
