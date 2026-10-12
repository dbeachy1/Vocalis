// SillyTavern's own narration player bar, imported by `sillytavern/extension/index.js:51` from
// ST's web root (`/scripts/narration-player-bar.js`). Vocalis does not ship this file.
//
// ⚠️ ONLY THE TWO FUNCTIONS THE EXTENSION IMPORTS. This is a stub for the checker, not a mirror of
// ST's module — declaring more would be inventing a contract nobody here calls, and it would rot
// silently the first time ST changed it.
export declare function showNarrationPlayerBar(
    audio: HTMLAudioElement,
    opts?: { speaker?: string; onStop?: () => void },
): void;
export declare function hideNarrationPlayerBar(): void;
