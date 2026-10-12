import { describe, test, expect, beforeEach } from '@jest/globals';

import { adoptLogger, normal, resetLogging, sensitive } from '../src/logging.js';
import { readTape, recordLine, resetTape } from '../src/log-tape.js';

/**
 * The in-memory tape behind the panel's log view.
 *
 * 🔴 **One property carries the whole feature, and it is the second test.** The tape is rendered to the user
 * and built to be pasted into a bug report, so it is safe only for as long as it holds nothing user-authored.
 * `logging.js` already draws that line — `normal()` carries no user value, `sensitive()` carries all of it —
 * and the tape's safety is entirely inherited from teeing exactly one of those two channels. A change that
 * teed both would leak conversation into a panel and into whatever the user pasted it into, and it would look
 * like a small refactor.
 */
describe('the log tape', () => {
    beforeEach(() => {
        resetLogging();
        resetTape();
    });

    test('records what the normal channel published, formatted as the log saw it', () => {
        normal().info('[Mnemosyne] ingest: %d/%d fresh turns — waiting.', 4, 12);

        expect(readTape()).toEqual([
            expect.objectContaining({ level: 'info', text: '[Mnemosyne] ingest: 4/12 fresh turns — waiting.' }),
        ]);
    });

    // 🔴 THE GUARD. See the describe block.
    test('never records the sensitive channel', () => {
        sensitive().debug('[Mnemosyne] That count was for chat %s (%s).', 'chat-abc', 'test-user');
        sensitive().error('[Mnemosyne] That decline was for %s: %s', 'test-user', 'boom');

        expect(readTape()).toEqual([]);
    });

    test('keeps every level the normal channel offers', () => {
        normal().debug('d');
        normal().info('i');
        normal().warn('w');
        normal().error('e');

        expect(readTape().map(l => l.level)).toEqual(['debug', 'info', 'warn', 'error']);
    });

    test('is bounded, and drops the OLDEST lines when it fills', () => {
        for (let i = 0; i < 350; i++) {
            recordLine('info', [`line ${i}`], i);
        }

        const tape = readTape();

        expect(tape).toHaveLength(300);
        expect(tape[0].text).toBe('line 50');
        expect(tape[tape.length - 1].text).toBe('line 349');
    });

    test('hands out a copy, so a render cannot see the tape mutate underneath it', () => {
        recordLine('info', ['one']);
        const snapshot = readTape();
        recordLine('info', ['two']);

        expect(snapshot).toHaveLength(1);
        expect(readTape()).toHaveLength(2);
    });

    // A logger that can fail its caller is worse than one that drops a line — this is called from inside the
    // logging seam, on the path of every operational message the plugin emits.
    //
    // ⚠️ **Scoped to the TAPE, not to the whole call.** An earlier version of this asserted that
    // `normal().info('%s', hostile)` never throws, and it failed — but the throw came from `console.log`
    // formatting the argument, which is the underlying sink's behavior and predates the tee entirely. The
    // property this module owes is narrower and is the one asserted here: whatever it is handed, the recording
    // step neither throws nor takes the line's sink down with it.
    test('never throws, whatever it is handed', () => {
        const circular = /** @type {Record<string, unknown>} */ ({});
        circular.self = circular;
        const hostile = { get [Symbol.toPrimitive]() { throw new Error('nope'); } };

        expect(() => recordLine('info', [circular])).not.toThrow();
        expect(() => recordLine('info', ['%s', hostile])).not.toThrow();
    });

    // 🔴 RECORDED BEFORE IT IS PUBLISHED, so a sink that fails still leaves the line on the tape. The tape is
    // what the panel shows, and a diagnostic that loses exactly the lines emitted while something was going
    // wrong would be worse than useless.
    test('keeps the line even when the sink underneath it throws', () => {
        const exploding = {
            debug() {}, info() { throw new Error('sink is down'); }, warn() {}, error() {},
        };
        adoptLogger({ logger: exploding, LogClass: { NORMAL: 'N', SENSITIVE: 'S' } });

        expect(() => normal().info('[Mnemosyne] still worth recording')).toThrow('sink is down');
        expect(readTape().map(l => l.text)).toEqual(['[Mnemosyne] still worth recording']);
    });
});
