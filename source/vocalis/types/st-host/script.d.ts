// SillyTavern's own `script.js`, imported DYNAMICALLY by `sillytavern/extension/index.js` from
// ST's web root (`/script.js`). Vocalis does not ship this file.
//
// 🔴 WHY THE EXTENSION REACHES FOR IT AT ALL. Sending a new picture from Vocalis left SillyTavern
// showing the old one until a hard reload: `getCharacters()` and `getUserAvatars(true)` re-render
// the row from the same URL it had before, and the URL is the browser's cache key.
// `bustAvatarThumbnails` primes both thumbnail shapes with
// `cache: 'reload'` and repaints every `<img>` on the page that names the file — the same call
// their own avatar-change paths make (`script.js:8557`, `personas.js:488`, `personas.js:2183`).
//
// ⚠️ NOT ON `getContext()`, WHICH IS WHY THIS FILE EXISTS. The extension context exports
// `getThumbnailUrl` and stops there, so the only way to the function is the module itself.
//
// ⚠️ IMPORTED DYNAMICALLY, INSIDE A TRY/CATCH, for `personas.d.ts`'s reason: a static import of
// somebody else's file takes the whole extension down when they move it, and this one is only
// ever a repaint. A SillyTavern that renames it must cost a refresh, never the pairing channel.
//
// ⚠️ ONLY THE ONE FUNCTION THE EXTENSION CALLS. A stub for the checker, not a mirror of ST's
// module — `script.js` exports hundreds of symbols and declaring more here would invent a
// contract nobody calls and rot the first time ST changed it.
export declare function bustAvatarThumbnails(kind: 'character' | 'persona', file: string): Promise<number>;
