/**
 * A resolve hook that puts `test/stubs/` where SillyTavern would be.
 *
 * The extension lives at `public/scripts/extensions/third-party/<name>/`, so it reaches the app by climbing
 * out of that directory — `../../../../script.js` and friends. Outside a real install those paths land
 * somewhere above the repo and do not exist, which is why `panel.js` and `index.js` cannot be imported by a
 * test and why a broken one shipped twice.
 *
 * ⚠️ MATCHED ON THE BASENAME OF THE CLIMB, NOT ON A FULL PATH. The number of `../` differs by module
 * (`record.js` climbs one more than `panel.js`), and an absolute-path match would silently stop working the
 * first time a file moved — failing open, into the same blind spot this exists to close.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const STUBS = join(dirname(fileURLToPath(import.meta.url)), 'stubs');
const STUBBED = new Set(['script.js', 'popup.js', 'utils.js', 'extensions.js']);

/**
 * @param {string} specifier The import specifier
 * @param {object} context Node's resolve context
 * @param {Function} next The default resolver
 * @returns {object} The resolution
 */
export function resolve(specifier, context, next) {
    const climb = /^(?:\.\.\/)+([^/]+\.js)$/.exec(specifier);

    if (climb && STUBBED.has(climb[1])) {
        return { url: pathToFileURL(join(STUBS, climb[1])).href, shortCircuit: true };
    }

    return next(specifier, context);
}
