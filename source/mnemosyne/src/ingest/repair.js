import { normal, sensitive } from '../logging.js';

import { parseTag } from './extraction.js';

/**
 * One-time repairs to memories an earlier build stored wrongly. Run when a user's store opens.
 */

/** The `meta` key that records the leaked-tag repair has run for this store. */
const LEAKED_TAG_KEY = 'repair_leaked_tags_v1';

/**
 * Strip a tag the parser left inside a memory's text, and file the memory under that tag.
 *
 * Earlier versions could leave a reordered tag in the text and assign default metadata. `parseTag` now handles
 * field order for new output; this repair updates already stored rows that still carry the untagged defaults.
 *
 * Only automatic memories still carrying exactly the untagged defaults are touched — that is the one path that
 * could have produced this — and only when the text opens with a complete, closed tag. The fix is in place
 * (`repairMemory`): the vector is untouched because an untagged rescue always carried a `||` index line, and
 * the index line is what was embedded.
 *
 * ⚠️ The tier is NOT changed. A memory whose tag says `user` is about the person and belongs in the user tier,
 * but it was filed in this story's partition, and moving a memory between partitions is not something the
 * store does in place. It stays where it is, still recalled in its own chat, and the count is logged.
 *
 * @param {import('../store.js').MemoryStore} store The user's open store
 * @returns {number} How many memories were repaired
 */
export function repairLeakedTags(store) {
    if (store.getMetaJson(LEAKED_TAG_KEY) === true) {
        return 0;
    }

    let fixed = 0;
    let aboutUser = 0;

    for (const row of store.listMemories({ limit: Number.MAX_SAFE_INTEGER, includeRetired: true })) {
        const md = row.metadata ?? {};

        if (row.source !== 'auto' || md.type !== 'fact' || md.importance !== 2 || md.subject !== 'world') {
            continue;
        }

        const tag = parseTag(row.text.trim());

        if (!tag) {
            continue;
        }

        store.repairMemory(row.id, {
            text: tag.rest,
            metadata: { ...md, type: tag.type, importance: tag.importance, subject: tag.subject },
        });
        fixed++;
        if (tag.subject === 'user') {
            aboutUser++;
        }
    }

    store.setMetaJson(LEAKED_TAG_KEY, true);

    if (fixed > 0) {
        normal().info(
            '[Mnemosyne] repair: removed a leftover tag from the text of %d memor%s and filed %s under that tag.%s',
            fixed, fixed === 1 ? 'y' : 'ies', fixed === 1 ? 'it' : 'them',
            aboutUser > 0 ? ` ${aboutUser} of them are about the user but stay filed under their own story.` : '',
        );
        sensitive().debug('[Mnemosyne] That repair touched memory ids in one store; no text is logged.');
    }

    return fixed;
}
