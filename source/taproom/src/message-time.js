/**
 * When a chat message was sent, as epoch milliseconds — the `sendDate` every plugin turn carries (API v7).
 *
 * 🔴 THE FORK OWNS THE CHAT FILE FORMAT, SO THE FORK PARSES IT. `send_date` is written as ISO 8601 today
 * (`getMessageTimeStamp`), but a chat is kept for years and older ones hold whatever the client wrote at the
 * time: a humanized `2024-7-12@01h31m37s123ms`, a spaced `2024-6-5 @14h 56m 50s 682ms`, a US-style
 * `June 19, 2023 2:20pm`, or a bare epoch number. Handing a plugin the raw string would make every plugin
 * re-learn that history, and each would learn a different subset of it. The formats accepted here are the
 * ones the client's own `parseTimestamp` (`public/scripts/utils.js`) accepts, so a time the chat UI can show
 * is a time a plugin gets.
 *
 * 🔴 UNRECOGNIZED IS `null`, NEVER `0` AND NEVER "NOW". A memory stamped with the moment it was extracted, or
 * with 1970, reads as a real time and is wrong in a way nothing downstream can detect. `null` says "unknown",
 * which a plugin can act on. Callers count the unrecognized ones and log them (see `countUnrecognized`), so
 * a format this file has never seen shows up in st.log instead of silently becoming a hole in the timeline.
 *
 * ⚠️ THE HUMANIZED AND US-STYLE FORMATS CARRY NO ZONE, AND ARE READ IN THE SERVER'S LOCAL TIME.
 * `humanizedDateTime` (`RossAscends-mods.js`) wrote them from the browser's local clock, so local is the
 * right reading whenever the browser and the server share a timezone — true for a home install. Upstream's
 * `parseTimestamp` reads the humanized form as UTC, which is off by the zone offset for every such message;
 * that is a display bug upstream has lived with, and copying it here would bake it into stored memories.
 */

/** English month names, for the US-style format. The client's parse uses moment's English month parser. */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** `2024-07-12T01:31:37.123Z`, with or without seconds, fraction, or zone. What `getMessageTimeStamp` writes. */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** `2024-07-12@01h31m37s123ms` and `2024-7-12@01h31m37s` — `humanizedDateTime`, with and without ms. */
const HUMANIZED_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(?:(\d{1,3})ms)?$/;

/** `2024-6-5 @14h 56m 50s 682ms` — an older spaced variant of the same. */
const SPACED_HUMANIZED_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m (\d{1,2})s (\d{1,3})ms$/;

/** `June 19, 2023 2:20pm` — the oldest format, from before the humanized one. */
const MERIDIEM_PATTERN = /^([A-Za-z]+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)$/i;

/**
 * Build a local-time instant from components, refusing any the `Date` constructor would roll over.
 *
 * ⚠️ `new Date(2024, 1, 30)` is March 1st, silently. A malformed stamp must come back `null`, not as a
 * plausible neighbouring day, so every component is checked against what the constructor made of it.
 * @param {number} year Full year
 * @param {number} month 1-12
 * @param {number} day 1-31
 * @param {number} hour 0-23
 * @param {number} minute 0-59
 * @param {number} second 0-59
 * @param {number} ms 0-999
 * @returns {number|null} Epoch milliseconds, or null when a component is out of range
 */
function localInstant(year, month, day, hour, minute, second, ms) {
    const date = new Date(year, month - 1, day, hour, minute, second, ms);

    const intact = date.getFullYear() === year
        && date.getMonth() === month - 1
        && date.getDate() === day
        && date.getHours() === hour
        && date.getMinutes() === minute
        && date.getSeconds() === second;

    // A DST gap moves the hour forward and fails the check above; that stamp could never have been written
    // by a clock in this zone, so `null` is still the honest answer for it.
    return intact ? date.getTime() : null;
}

/**
 * Parse a message's `send_date` into epoch milliseconds.
 * @param {unknown} value The `send_date` exactly as the chat file holds it
 * @returns {number|null} Epoch milliseconds, or null when absent or unrecognized
 */
export function parseSendDate(value) {
    if (typeof value === 'number') {
        // Legacy epoch numbers are MILLISECONDS — the client's `parseTimestamp` hands them to `new Date`
        // unchanged, so this reads them the way the chat UI always has.
        return Number.isFinite(value) && value >= 0 ? value : null;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const text = value.trim();

    if (text === '') {
        return null;
    }

    if (/^\d+$/.test(text)) {
        const epoch = Number(text);
        return Number.isSafeInteger(epoch) ? epoch : null;
    }

    if (ISO_PATTERN.test(text)) {
        const epoch = Date.parse(text);
        return Number.isFinite(epoch) ? epoch : null;
    }

    const humanized = HUMANIZED_PATTERN.exec(text) ?? SPACED_HUMANIZED_PATTERN.exec(text);

    if (humanized) {
        const [, year, month, day, hour, minute, second, ms] = humanized;
        return localInstant(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second), ms === undefined ? 0 : Number(ms.padStart(3, '0')));
    }

    const meridiem = MERIDIEM_PATTERN.exec(text);

    if (meridiem) {
        const [, monthName, day, year, hour, minute, suffix] = meridiem;
        const lower = monthName.toLowerCase();
        // Full names and three-letter abbreviations, as moment's English locale accepts them.
        const month = MONTHS.findIndex(name => name === lower || (lower.length === 3 && name.startsWith(lower)));
        const hour12 = Number(hour);

        if (month < 0 || hour12 < 1 || hour12 > 12) {
            return null;
        }

        const hour24 = (hour12 % 12) + (suffix.toLowerCase() === 'pm' ? 12 : 0);
        return localInstant(Number(year), month + 1, Number(day), hour24, Number(minute), 0, 0);
    }

    return null;
}

/**
 * How many of these raw `send_date` values were PRESENT but not understood.
 *
 * Absent is not counted: a message with no time is an ordinary state (a greeting inserted by an extension, a
 * very old import), and logging it would bury the one line that matters. What this counts is a time the chat
 * holds and this file cannot read — a new format, or a corrupt field — which is a fork bug to fix.
 * @param {unknown[]} rawValues Each turn's raw `send_date`
 * @returns {number} The count of present-but-unparseable values
 */
export function countUnrecognized(rawValues) {
    return rawValues.filter(raw => raw !== undefined && raw !== null && raw !== '' && parseSendDate(raw) === null).length;
}
