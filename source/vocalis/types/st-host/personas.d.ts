// SillyTavern's own persona module, imported DYNAMICALLY by `sillytavern/extension/index.js`
// from ST's web root (`/scripts/personas.js`). Vocalis does not ship this file.
//
// 🔴 WHY THE EXTENSION REACHES FOR IT AT ALL. `getUserAvatars` is what repaints
// `#user_avatar_block` and — through `navigateToAvatar` — pages the list to a given entry. Their
// own `createDummyPersona` calls it after making a persona; ours could not, because it is not on
// `getContext()`. So a persona created from Vocalis existed in `power_user.personas` AND in
// `/api/avatars/get` and appeared in neither until the page was reloaded.
//
// ⚠️ IMPORTED DYNAMICALLY, INSIDE A TRY/CATCH, unlike `narration-player-bar` next door. That one
// is a static import at the top of the file, so a rename over there takes the extension down with
// it — acceptable for a feature, not for a repaint. A SillyTavern that moves this module must
// cost a refresh, never the pairing channel.
//
// ⚠️ ONLY THE ONE FUNCTION THE EXTENSION CALLS. A stub for the checker, not a mirror of ST's
// module: declaring more would invent a contract nobody here calls and rot the first time ST
// changed it. `openPageAt` is an avatar filename, and passing it is what makes the new persona
// VISIBLE rather than merely present — the list paginates at five.
export declare function getUserAvatars(doRender?: boolean, openPageAt?: string): Promise<string[]>;

// ⚠️ `getUserAvatar` IS HERE BECAUSE THE STRING IT BUILDS IS A CACHE KEY. `bustAvatar` re-primes
// the full-size persona picture — the one behind the zoomed-avatar popup, which no thumbnail URL
// addresses — and a prime that lands on a URL one character different from the one the `<img>`
// asks for is a second cache entry, not a refreshed one. Their `USER_AVATAR_PATH` is not
// exported, so this is the only way to build the same string they do.
export declare function getUserAvatar(avatarImg: string): string;
