import fs from 'node:fs';
import path from 'node:path';

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import { makeScratchDirectory, startSillyTavern } from './util/st-server.js';

/**
 * `GET /api/events/stream` over real HTTP, against a real server.
 *
 * 🔴 THIS FILE EXISTS FOR ONE ASSERTION THE UNIT TESTS CANNOT MAKE: that the bytes actually arrive.
 *
 * Every interesting way an event stream breaks is invisible to a test of the registry, because the
 * registry did its job — it wrote to a response. What eats the write is the middleware stack: the global
 * `compression()` in `server-main.js` buffers a response until it has enough content to be worth
 * compressing, and an event stream never produces that much at once. The stream then connects, reports
 * healthy, holds open for ever, and delivers nothing. `Cache-Control: no-transform` is what steps
 * `compression` aside, and nothing anywhere else in the codebase would fail if someone removed it.
 *
 * So: connect, write a World Book through the ordinary endpoint, and require that the event turns up on
 * the socket within a few seconds.
 */
describe('Server events: the stream over HTTP', () => {
    /** @type {string} */
    let scratch;
    /** @type {Awaited<ReturnType<typeof startSillyTavern>>} */
    let st;
    /** @type {string} */
    let base;
    /** @type {string} */
    let worldsDirectory;

    beforeAll(async () => {
        scratch = makeScratchDirectory('event-stream-http');

        st = await startSillyTavern({
            dataRoot: path.join(scratch, 'data'),
            configPath: path.join(scratch, 'config.yaml'),
        });

        if (!st.listening) throw new Error(`Boot failed.\n\n${st.output()}`);
        base = `http://127.0.0.1:${st.port}`;
        worldsDirectory = path.join(scratch, 'data', 'default-user', 'worlds');
        fs.mkdirSync(worldsDirectory, { recursive: true });
    }, 240_000);

    afterAll(async () => {
        await st?.stop();
        fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    /**
     * Open the stream and read SSE frames off it until a predicate is satisfied.
     *
     * Deliberately hand-rolled rather than using an EventSource shim: the point of this file is what
     * comes over the wire, and a library that reconnects or buffers on our behalf would hide exactly the
     * failure being tested.
     * @param {(frames: Array<{event: string, data: any, id: string|null}>) => boolean} until
     * @param {(clientId: string) => Promise<void>} [afterHello] Run once `hello` has arrived
     * @returns {Promise<Array<{event: string, data: any, id: string|null}>>}
     */
    async function collect(until, afterHello) {
        const controller = new AbortController();
        const response = await fetch(`${base}/api/events/stream`, { signal: controller.signal });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');

        // 🔴 THE ASSERTION THAT CATCHES THE COMPRESSION BUG AT ITS CAUSE rather than as a timeout twenty
        // seconds later. If this header goes missing the stream still opens and still looks fine.
        expect(response.headers.get('cache-control')).toContain('no-transform');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const frames = [];
        let buffer = '';
        let greeted = false;

        const timeout = setTimeout(() => controller.abort(), 15_000);

        try {
            while (!until(frames)) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Frames are separated by a blank line. Keep the trailing partial in the buffer.
                const chunks = buffer.split('\n\n');
                buffer = chunks.pop() ?? '';

                for (const chunk of chunks) {
                    const frame = { event: null, data: null, id: null };

                    for (const line of chunk.split('\n')) {
                        if (line.startsWith('event: ')) frame.event = line.slice(7);
                        if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
                        if (line.startsWith('id: ')) frame.id = line.slice(4);
                    }

                    if (frame.event) frames.push(frame);
                }

                if (!greeted && afterHello) {
                    const hello = frames.find(f => f.event === 'hello');

                    if (hello) {
                        greeted = true;
                        await afterHello(hello.data.clientId);
                    }
                }
            }
        } finally {
            clearTimeout(timeout);
            controller.abort();
        }

        return frames;
    }

    /**
     * @param {string} name
     * @param {Record<string, string>} [headers]
     */
    async function writeBook(name, headers = {}) {
        const response = await fetch(`${base}/api/worldinfo/edit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ name, data: { entries: {} } }),
        });

        expect(response.status).toBe(200);
    }

    test('the stream opens, greets, and is not held in a compressor', async () => {
        const frames = await collect(f => f.some(x => x.event === 'hello'));
        const hello = frames.find(f => f.event === 'hello');

        expect(hello.data.apiVersion).toBe(1);
        expect(typeof hello.data.clientId).toBe('string');

        // Per `formatEvent`: the greeting must not carry an id, or it would move a reconnecting client
        // past the replay queued behind it.
        expect(hello.id).toBeNull();
    }, 30_000);

    test('🔴 a World Book written elsewhere arrives on the socket', async () => {
        // The whole feature in one assertion. The write does NOT send a client id, so it stands for any
        // other writer — a second tab, a plugin, or Vocalis.
        const frames = await collect(
            f => f.some(x => x.event === 'worldinfo.updated'),
            async () => { await writeBook('Arrives On The Socket'); },
        );

        const event = frames.find(f => f.event === 'worldinfo.updated');

        expect(event.data.name).toBe('Arrives On The Socket');
        expect(event.data.source).toBeNull();
        expect(Number(event.id)).toBeGreaterThan(0);
    }, 30_000);

    test('a writer that identifies itself is named in `source`, so it can ignore its own echo', async () => {
        const frames = await collect(
            f => f.some(x => x.event === 'worldinfo.updated'),
            async (clientId) => { await writeBook('My Own Write', { 'X-ST-Client-Id': clientId }); },
        );

        const event = frames.find(f => f.event === 'worldinfo.updated');
        const hello = frames.find(f => f.event === 'hello');

        // The server does not filter — it labels. Dropping the echo is the client's job, and it can only
        // do it if the label is the same identity the greeting handed out.
        expect(event.data.source).toBe(hello.data.clientId);
    }, 30_000);

    test('a deletion is announced too', async () => {
        await writeBook('Doomed Book');

        const frames = await collect(
            f => f.some(x => x.event === 'worldinfo.deleted'),
            async () => {
                const response = await fetch(`${base}/api/worldinfo/delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Doomed Book' }),
                });
                expect(response.status).toBe(200);
            },
        );

        expect(frames.find(f => f.event === 'worldinfo.deleted').data.name).toBe('Doomed Book');
    }, 30_000);
});
