import { describe, test, expect, beforeEach, afterAll } from '@jest/globals';

import {
    addStream,
    removeStream,
    emit,
    emitForRequest,
    getStreamCount,
    resetForTests,
    RESYNC,
    CLIENT_ID_HEADER,
} from '../src/event-stream.js';

/**
 * The server→client event channel, at the level of the registry itself.
 *
 * The integration side — that a real browser-shaped client actually receives these over HTTP, past
 * `compression()` and past the auth boundary — is `event-stream-http.test.js`. This file is about the
 * decisions that are easy to get subtly, silently wrong: who an event reaches, what a reconnecting client
 * is told it missed, and which events are allowed to move that client's position in the stream.
 */
describe('Server events: the registry', () => {
    /**
     * A response that records what was written to it.
     * @param {{ failAfter?: number }} [options]
     */
    function fakeResponse({ failAfter = Infinity } = {}) {
        const written = [];

        return {
            written,
            write(chunk) {
                if (written.length >= failAfter) {
                    throw new Error('socket is gone');
                }

                written.push(chunk);
                return true;
            },
            /** Every `event:` name written, in order, excluding keepalives and the `retry:` preamble. */
            events() {
                return written
                    .flatMap(chunk => chunk.split('\n'))
                    .filter(line => line.startsWith('event: '))
                    .map(line => line.slice('event: '.length));
            },
            /** The parsed `data:` payloads, in order. */
            payloads() {
                return written
                    .flatMap(chunk => chunk.split('\n'))
                    .filter(line => line.startsWith('data: '))
                    .map(line => JSON.parse(line.slice('data: '.length)));
            },
            /** The `id:` values written, in order, as numbers. */
            ids() {
                return written
                    .flatMap(chunk => chunk.split('\n'))
                    .filter(line => line.startsWith('id: '))
                    .map(line => Number(line.slice('id: '.length)));
            },
        };
    }

    beforeEach(() => {
        resetForTests();
    });

    afterAll(() => {
        resetForTests();
    });

    test('a connecting client is greeted with its own client id', () => {
        const response = fakeResponse();
        addStream('test-user', response, undefined);

        expect(response.events()).toEqual(['hello']);
        expect(typeof response.payloads()[0].clientId).toBe('string');
        expect(response.payloads()[0].clientId.length).toBeGreaterThan(0);
    });

    test('two connections get different client ids', () => {
        const first = fakeResponse();
        const second = fakeResponse();

        addStream('test-user', first, undefined);
        addStream('test-user', second, undefined);

        expect(first.payloads()[0].clientId).not.toBe(second.payloads()[0].clientId);
    });

    test('🔴 hello carries no id, so it cannot advance a client past events it has not received', () => {
        // The failure this guards: `hello` is written BEFORE the replay behind it. With an id, a client that
        // reconnected at position 1 would be moved to 3 by the greeting, and a disconnect during the replay
        // of 2 and 3 would mean it asks for "everything after 3" next time. Those events are gone for good,
        // the client believes it is current, and nothing anywhere reports a problem.
        emit('test-user', 'worldinfo.updated', { name: 'A' });
        emit('test-user', 'worldinfo.updated', { name: 'B' });
        emit('test-user', 'worldinfo.updated', { name: 'C' });

        const response = fakeResponse();
        addStream('test-user', response, '1');

        // Three ids on the wire would mean hello contributed one. Only the two replayed events may.
        expect(response.events()).toEqual(['hello', 'worldinfo.updated', 'worldinfo.updated']);
        expect(response.ids()).toEqual([2, 3]);
    });

    test('🔴 an event reaches only the handle it belongs to', () => {
        // The payloads name World Books and character avatars. On a multi-user box, widening this would
        // hand every logged-in user a live feed of what everyone else is editing.
        const mine = fakeResponse();
        const theirs = fakeResponse();

        addStream('test-user', mine, undefined);
        addStream('someone-else', theirs, undefined);

        emit('test-user', 'worldinfo.updated', { name: 'Ixlandia' });

        expect(mine.events()).toEqual(['hello', 'worldinfo.updated']);
        expect(theirs.events()).toEqual(['hello']);
    });

    test('an event with nobody connected is still recorded for replay', () => {
        // Callers must never guard on whether anyone is listening, so the registry has to make that safe.
        emit('test-user', 'worldinfo.updated', { name: 'Written While Away' });

        const response = fakeResponse();
        addStream('test-user', response, '0');

        // Last-Event-ID 0 means "I have nothing", which is a fresh connection, not a gap.
        expect(response.events()).toEqual(['hello']);
    });

    test('a reconnecting client is sent exactly what it missed', () => {
        emit('test-user', 'worldinfo.updated', { name: 'A' });
        emit('test-user', 'worldinfo.updated', { name: 'B' });
        emit('test-user', 'worldinfo.updated', { name: 'C' });

        const response = fakeResponse();
        addStream('test-user', response, '1');

        expect(response.payloads().slice(1).map(p => p.name)).toEqual(['B', 'C']);
    });

    test('a client that is already current is sent nothing to replay', () => {
        emit('test-user', 'worldinfo.updated', { name: 'A' });

        const response = fakeResponse();
        addStream('test-user', response, '1');

        expect(response.events()).toEqual(['hello']);
    });

    test('🔴 a client whose position has fallen off the buffer is told to resync, not told nothing', () => {
        // THE failure mode of this whole mechanism. When the buffer has evicted everything the client
        // missed, the "events after your position" query returns an EMPTY list — which is byte-identical to
        // the answer given to a client that is perfectly up to date. Reading it as "you are current" tells
        // the client it knows everything at the exact moment it knows least.
        for (let i = 0; i < 150; i++) {
            emit('test-user', 'worldinfo.updated', { name: `Book ${i}` });
        }

        const response = fakeResponse();
        addStream('test-user', response, '2');

        expect(response.events()).toEqual(['hello', RESYNC]);
        expect(response.payloads()[1].reason).toBe('gap');
    });

    test('resync advances the client, so it is not resent on every later reconnect', () => {
        for (let i = 0; i < 150; i++) {
            emit('test-user', 'worldinfo.updated', { name: `Book ${i}` });
        }

        const first = fakeResponse();
        addStream('test-user', first, '2');
        const resyncId = first.ids().at(-1);

        expect(resyncId).toBe(150);

        // A client that reconnects again from where resync left it is current, not gapped — otherwise every
        // network blip for the rest of the session costs a full reload.
        const second = fakeResponse();
        addStream('test-user', second, String(resyncId));

        expect(second.events()).toEqual(['hello']);
    });

    test('a removed stream stops receiving', () => {
        const response = fakeResponse();
        const stream = addStream('test-user', response, undefined);

        removeStream(stream);
        emit('test-user', 'worldinfo.updated', { name: 'After Close' });

        expect(response.events()).toEqual(['hello']);
        expect(getStreamCount()).toBe(0);
    });

    test('⚠️ a dead socket is dropped and does not stop delivery to everyone else', () => {
        // A client that vanished can leave a response whose `write` throws while its `close` event is still
        // queued. An uncaught throw inside the emit loop would take out every other connected tab.
        const dead = fakeResponse({ failAfter: 2 });
        const alive = fakeResponse();

        addStream('test-user', dead, undefined);
        addStream('test-user', alive, undefined);

        expect(() => emit('test-user', 'worldinfo.updated', { name: 'Ixlandia' })).not.toThrow();

        expect(alive.events()).toEqual(['hello', 'worldinfo.updated']);
        expect(getStreamCount()).toBe(1);
    });

    describe('emitForRequest', () => {
        /**
         * @param {string|undefined} handle
         * @param {string|undefined} clientId
         */
        function fakeRequest(handle, clientId) {
            return {
                user: handle ? { profile: { handle } } : undefined,
                get(name) {
                    return name === CLIENT_ID_HEADER ? clientId : undefined;
                },
            };
        }

        test('tags the event with the caller so a writer can ignore its own echo', () => {
            const response = fakeResponse();
            addStream('test-user', response, undefined);

            emitForRequest(fakeRequest('test-user', 'tab-one'), 'worldinfo.updated', { name: 'Ixlandia' });

            expect(response.payloads()[1]).toEqual({ name: 'Ixlandia', source: 'tab-one' });
        });

        test('a caller that sent no client id yields a null source, not a missing key', () => {
            // A listener asks `data.source === myId`. An absent key answers that correctly; the explicit
            // null just makes the wire format the same shape either way.
            const response = fakeResponse();
            addStream('test-user', response, undefined);

            emitForRequest(fakeRequest('test-user', undefined), 'worldinfo.updated', { name: 'Ixlandia' });

            expect(response.payloads()[1].source).toBeNull();
        });

        test('a request with no user emits nothing at all', () => {
            const response = fakeResponse();
            addStream('test-user', response, undefined);

            expect(() => emitForRequest(fakeRequest(undefined, undefined), 'worldinfo.updated', { name: 'X' })).not.toThrow();
            expect(response.events()).toEqual(['hello']);
        });
    });
});
