import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');

/**
 * Every browser spec that boots a REAL SillyTavern server, found by looking rather than by remembering.
 *
 * 🔴 THE HAND-WRITTEN LIST WAS WRONG THE DAY IT WAS READ, WHICH IS THE ARGUMENT FOR NOT HAVING ONE.
 * `playwright.config.js` carried these names literally, with a comment saying the list is derivable and
 * that two specs had already gone missing from it. A third was missing when this replaced it:
 * `plugin-panel-actions` boots a server and was absent, so `npm run test:e2e` — and therefore
 * `npm test` — swept it into the parallel batch alongside the DOM-only specs, in exactly the
 * configuration the list exists to prevent. A list that must be updated by whoever adds a spec is a
 * list that eventually is not, and the way it fails is a flake somewhere else.
 *
 * The signal is calling `startSillyTavern`: that function is what puts a real server on a real port,
 * and the port is the resource these specs must not share carelessly. Nothing else about a spec matters
 * to this question.
 *
 * ⚠️ IT READS SOURCE TEXT, so a spec that reaches `startSillyTavern` through some future indirection
 * would go unseen. That is the failure mode of the literal list too, and this one at least cannot drift
 * for a spec that calls it plainly, which all of them do.
 * @returns {Array<string>} Spec base names, without the `.e2e.js` suffix, sorted
 */
export function serverBootingSpecs() {
    return fs.readdirSync(frontendDirectory)
        .filter(name => name.endsWith('.e2e.js'))
        .filter(name => fs.readFileSync(path.join(frontendDirectory, name), 'utf-8').includes('startSillyTavern('))
        .map(name => name.replace(/\.e2e\.js$/, ''))
        .sort();
}
