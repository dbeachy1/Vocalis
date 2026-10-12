import { normal, sensitive } from '../../src/logging.js';

/**
 * Call sites that live in a file of their own, so a stack-frame assertion can name a file that is neither
 * the test nor `logging.js` and mean it.
 *
 * 🔴 THE LINE NUMBERS BELOW ARE THE ASSERTION. `tests/logging.test.js` checks that the frame the fork would
 * capture names THIS file at THESE lines. If you add or remove a line above either call, that test fails —
 * which is correct, and the fix is to update the expected line, not to loosen the check.
 */

/** @returns {void} A SENSITIVE line emitted from a known, stable line of a known file. */
export function logSensitiveFromHere() {
    sensitive().error('a suppressed line');
}
export const SENSITIVE_CALL_LINE = 14;

/** @returns {void} A NORMAL line emitted from a known, stable line of a known file. */
export function logNormalFromHere() {
    normal().error('a published line');
}
export const NORMAL_CALL_LINE = 20;
