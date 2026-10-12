import { parseCard, renderBaseline } from '../card.js';
import { HostContext } from '../host/context.js';
import { normal, sensitive } from '../logging.js';

import { reportOnce } from './faults.js';

/**
 * The character baseline: what the card already states, so the extractor does not store it back as though it
 * had discovered it (`DESIGN_INGEST.md` §5).
 *
 * One function, and it is here alone because its error policy is unusually specific and easy to "simplify"
 * into a bug — see the three markers on {@link readBaseline}. `src/card.js` does the parsing and makes the
 * field judgments; this decides what a failure at each stage MEANS.
 */

/**
 * Read the character's card and render the extraction baseline — the facts the card already states, so the
 * extractor does not store them back as though it had discovered them (`DESIGN_INGEST.md` §5).
 *
 * 🔴 **BY ID, NEVER BY NAME, AND THE FORK RESOLVES IT.** `context.readCharacterCard(handle, charId)` hands back
 * the card's decrypted bytes and deliberately never its filename (fork §25). That is not an inconvenience to be
 * routed around: names are renameable and two cards can share one, so composing `characters/${charName}.png`
 * would sometimes load the WRONG character's card — and a wrong baseline is worse than none, because it tells
 * the extractor that another character's facts are already known and silently suppresses real memories. Reading
 * the fork's `character-ids.json` to reverse the map is the same mistake wearing a better disguise; it was
 * offered to the fork and refused (fork §25.8), because it hands back avatar filenames by another route.
 *
 * 🔴 **A THROW FROM `readCharacterCard` IS NOT "NO CARD" AND MUST NOT BE CAUGHT.** The fork already answers
 * `null` for every ordinary absence — an id in no map, a card deleted out from under a live map. Everything
 * that remains is a locked vault or a broken store, and swallowing *those* into an empty baseline is precisely
 * the failure this feature was designed against: an extraction that quietly believes the character has no card
 * and never learns it was wrong. Let it propagate; `maybeIngest` declines the ingest, the high-water mark stays
 * put, and the next turn tries again. ⚠️ Note this is the OPPOSITE of `context.readFile`, which throws on a
 * missing file — there the caller named the path and a miss means the caller was wrong; here the fork resolved
 * the id, so a miss is news about the card.
 *
 * ⚠️ **The parse is caught, and only the parse.** A card that is not a PNG is a permanent property of a file on
 * disk, not a transient fault, so propagating it would decline this character's every future extraction for
 * ever — total memory loss where a missing baseline would have cost only a little duplication. Note the
 * asymmetry with `parseCard`'s own docblock, which argues for throwing: that was written when the *caller*
 * supplied the path and bad bytes therefore meant a bad path. With the fork resolving the id that inference is
 * gone, and the same reasoning that makes the fork's `ENOENT → null` right makes this catch right.
 *
 * @param {string} handle
 * @param {string|null} charId The fork's minted id for this character (§22), never a name or a filename
 * @param {ForkContext|import('../host/context.js').HostContext} context Either form, and that is the point of
 *        the `HostContext.from` below rather than an accident: `init` hands ingest the wrapper, a test hands it
 *        a bare object, and both arrive here as the same thing.
 * @returns {Promise<string>} The baseline block's contents, or '' when there is nothing to say
 */
export async function readBaseline(handle, charId, context) {
    // ⚠️ Guarded because the plugin has to run against fork builds older than §25 (`1f34805c5`) — including the
    // one on the host — where the method is simply absent and calling it is a TypeError rather than a graceful
    // nothing. The contract itself is not in doubt.
    //
    // 🔴 Reported HERE and not in the boot report, which is why capabilities.js marks this row `AT_USE`: an
    // install that never runs an extraction never pays this cost, and announcing it at boot would report a
    // degradation that may never happen. The message text still lives in the table; only the timing is local.
    const host = HostContext.from(context);

    if (!host.has('readCharacterCard')) {
        reportOnce(handle, 'no-read-card', host.absenceOf('readCharacterCard'));
        return '';
    }

    // No id means no character to read a card for: a narrator or system generation, or a fork too old to mint
    // ids (§22), whose identity collapses to a single shared partition. Not a fault — nothing to say.
    if (!charId) {
        return '';
    }

    const bytes = await host.readCharacterCard(handle, charId);

    if (!bytes) {
        return '';                                            // the id names no card: deleted, or re-imported
    }

    try {
        return renderBaseline(parseCard(bytes));
    } catch (error) {
        // 🔴 `error.message` IS CARD CONTENT, AND IT USED TO GO OUT ON THE NORMAL CHANNEL.
        //
        // This line published the parser's complaint to the plaintext log, on the reasoning that a complaint is
        // "content-free". It is not, and the counter-example is the most likely failure this catch will ever
        // see: `parseCard` ends in `JSON.parse`, and V8 can include input text in the SyntaxError message, so a
        // card whose metadata is not JSON can put the first characters of decrypted card text into
        // `st.log`, on a default install, with `debugMode` off. `logging.js` states the rule this broke in as
        // many words: an Error message whose text you do not control is not publishable — split it.
        //
        // The class of the failure is what an operator actually needs, and the class is safe to publish.
        //
        // ⚠️ `Partial<Error>` is the whole claim being made about a caught value, and it is deliberately weak:
        // `throw` takes anything, so both fields are read as possibly-absent and both call sites already cope
        // with that — hence the `?? 'Error'` below and the `%s` above, which prints `undefined` rather than
        // throwing a second time inside the handler for the first.
        normal().warn('[Mnemosyne] ingest: a character card would not parse (%d bytes) — extracting without a ' +
            'baseline for it. Reason: %s.', bytes.length, /** @type {Partial<Error>} */ (error)?.name ?? 'Error');
        sensitive().warn('[Mnemosyne] That card belongs to character %s (%s). The parser said: %s',
            charId, handle, /** @type {Partial<Error>} */ (error)?.message);
        return '';
    }
}
