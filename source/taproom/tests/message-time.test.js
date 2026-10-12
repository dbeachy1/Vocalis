import { describe, test, expect } from '@jest/globals';

import { parseSendDate, countUnrecognized } from '../src/message-time.js';

/**
 * `sendDate` (plugin API v7) — a message's `send_date`, in whatever format the chat was written in, as epoch ms.
 *
 * 🔴 THE FAILURE THIS GUARDS IS A PLAUSIBLE WRONG TIME. `0` and "now" both look like real times to a plugin
 * that stores them against a memory, and neither can be told apart from a real one later. Everything the
 * parser does not understand must come back `null`.
 */
describe('parseSendDate', () => {
    test('ISO 8601, as getMessageTimeStamp writes it today, is exact', () => {
        expect(parseSendDate('2026-09-18T10:00:05.123Z')).toBe(Date.UTC(2026, 8, 18, 10, 0, 5, 123));
        expect(parseSendDate('2026-09-18T12:00:05+02:00')).toBe(Date.UTC(2026, 8, 18, 10, 0, 5));
    });

    test('the humanized formats read as local time, with and without milliseconds', () => {
        expect(parseSendDate('2024-07-12@01h31m37s123ms')).toBe(new Date(2024, 6, 12, 1, 31, 37, 123).getTime());
        expect(parseSendDate('2024-7-12@01h31m37s')).toBe(new Date(2024, 6, 12, 1, 31, 37, 0).getTime());
        expect(parseSendDate('2024-6-5 @14h 56m 50s 682ms')).toBe(new Date(2024, 5, 5, 14, 56, 50, 682).getTime());
    });

    test('the oldest US-style format, including 12am and 12pm', () => {
        expect(parseSendDate('June 19, 2023 2:20pm')).toBe(new Date(2023, 5, 19, 14, 20).getTime());
        expect(parseSendDate('June 19, 2023 12:05am')).toBe(new Date(2023, 5, 19, 0, 5).getTime());
        expect(parseSendDate('Jun 19, 2023 12:05pm')).toBe(new Date(2023, 5, 19, 12, 5).getTime());
    });

    test('epoch numbers and digit strings are milliseconds, as the client reads them', () => {
        expect(parseSendDate(1726650000000)).toBe(1726650000000);
        expect(parseSendDate('1726650000000')).toBe(1726650000000);
    });

    test('🔴 absent and unrecognized are null — never 0, never now', () => {
        for (const value of [undefined, null, '', '   ', 'sometime last spring', 'Smarch 3, 2023 2:20pm', -5, Number.NaN, {}, true]) {
            expect(parseSendDate(value)).toBeNull();
        }
    });

    test('a stamp the Date constructor would roll over is null, not the neighbouring day', () => {
        expect(parseSendDate('2024-2-30@10h00m00s')).toBeNull();
        expect(parseSendDate('2024-13-01@10h00m00s')).toBeNull();
        expect(parseSendDate('June 19, 2023 13:20pm')).toBeNull();
    });

    test('countUnrecognized counts only times that are present and unreadable', () => {
        expect(countUnrecognized([undefined, '', null, '2026-09-18T10:00:00Z', 'garbage', 'June 19, 2023 2:20pm', 'nope'])).toBe(2);
    });
});
