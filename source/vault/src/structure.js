import { ownStoreSkeleton } from './own-stores.js';

/**
 * SillyTavern's fixed directory skeleton.
 *
 * ## Why this is its own module rather than living in `paths.js`
 *
 * It was in `paths.js`, which is where it is used most. But `foreign-stores.js` needs it too — a plugin
 * claiming `chats` as its own store must be refused, and refusing requires knowing what `chats` is — and
 * `paths.js` already imports `foreign-stores.js`. Importing back would have made a cycle between the module
 * that classifies paths and the module that records who owns them.
 *
 * The list depends on nothing except the own-store declarations, so it is a leaf. Both importers now point
 * down at it instead of sideways at each other. `paths.js` re-exports it, so every existing importer —
 * including three test files — is unaffected.
 */

/**
 * The skeleton, relative to `<DATA_ROOT>/<handle>/`.
 *
 * 🔴 THIS MUST TRACK `USER_DIRECTORY_TEMPLATE` IN THE FORK (`src/constants.js`).
 *
 * If SillyTavern adds a directory to that template and this set does not learn about it, the provider will
 * treat the new directory's name as a variable component and try to encrypt it — at boot, while locked,
 * with no key. That surfaces as EUNAVAILABLE on a `mkdir` during boot, which is loud, and fatal, and
 * therefore safe: it stops, rather than quietly writing user data somewhere SillyTavern will never look.
 */
export const STRUCTURAL_DIRECTORIES = new Set([
    'thumbnails',
    'thumbnails/bg',
    'thumbnails/avatar',
    'thumbnails/persona',
    'worlds',
    'user',
    'User Avatars',
    'user/images',
    'user/workflows',
    'user/files',
    'groups',
    'group chats',
    'chats',
    'characters',
    'backgrounds',
    'NovelAI Settings',
    'KoboldAI Settings',
    'OpenAI Settings',
    'TextGen Settings',
    'themes',
    'movingUI',
    'extensions',
    'instruct',
    'context',
    'QuickReplies',
    'assets',
    'vectors',
    'backups',
    'sysprompt',
    'reasoning',

    // 🔀 And every directory an OWN store needs — see `own-stores.js`. These used to be two string
    // literals here plus one more in `LIBRARY_NAMED_DIRECTORIES` plus a tag in `key-value.js` plus a
    // tag and a path prefix in `verify.js`, none of which referenced each other. A store declares
    // itself once now, and this reads the declaration.
    ...ownStoreSkeleton(),
]);
