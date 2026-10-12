import { ENVELOPE_VERSION, PROVIDER_ID } from './envelope.js';
import { VERSION } from './version.js';

/**
 * WHO WROTE THESE BYTES — the provenance record, and the one thing here that is not copy.
 *
 * The fork stores this per instance and reads it back to answer a question nobody else can: a user has
 * files they cannot open, and needs to be told **which plugin to install, and whether the one they have
 * is new enough.** `DESIGN_STORAGE_PROVENANCE.md` is the design; this is the whole of what we contribute
 * to it.
 *
 * ## ⚠️ Why it is not in `strings.js`
 *
 * It arrived through `describe()` and so was filed with the copy, which made a table of *sentences to
 * show a person* also the home of a machine-readable manifest with an `id`, a `source` URL and a list of
 * format versions. Nothing here is a sentence, none of it is translatable, and the fork validates every
 * field before rendering any of them. It also meant `strings.js` — a presentation module — imported
 * `PROVIDER_ID` and `ENVELOPE_VERSION` from the envelope, so answering "what is this plugin called?"
 * reached into the file-format layer.
 *
 * `describe('storage.identity')` still answers, because that is the interface the fork has. It just does
 * not also *define* the answer.
 */

/**
 * 🔴 **`id` MUST EQUAL THE ENVELOPE'S PROVIDER ID, AND IT IS PERMANENT.** Both come from one constant in
 * `envelope.js` so they cannot drift; the fork refuses a declaration whose id does not match what is on
 * the files, and refusing is correct — a registry entry that no file keys to is worse than none. Changing
 * the id later is not a rename, it is a breaking change to every file a user already has.
 *
 * ⚠️ **NOTHING PER-USER, EVER.** This describes the PLUGIN. A per-user answer would be a fingerprinting
 * surface, and it is handed out to anyone who can reach the endpoint that renders it. It takes no context
 * and must never learn to.
 * @returns {{id: string, name: string, source: string, version: string, envelopeVersions: number[]}}
 * The record, freshly built so a caller cannot mutate a shared one
 */
export function identity() {
    return {
        id: PROVIDER_ID,
        name: 'SillyTavern-Vault',
        source: 'https://github.com/dbeachy1/SillyTavern-Vault',
        version: VERSION,

        // Which on-disk envelope formats this build can actually read. A file claiming anything outside
        // this list is what turns "install the plugin" into "update the plugin" — a different sentence, and
        // the only one of the two that is any use to somebody who already has the plugin installed.
        envelopeVersions: [ENVELOPE_VERSION],
    };
}
