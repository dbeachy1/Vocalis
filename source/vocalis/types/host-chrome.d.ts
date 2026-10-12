// 🔴 THE CHROME EXTENSION HOST, DESCRIBED. 8.8-m8, DESIGN_8_3_JSDOC_TYPES.md §9.
//
// `nomi/chrome_extension/*.js` runs inside Chrome as an extension, where `chrome` is an ambient
// global the browser injects. Like the SillyTavern declarations next door, this describes somebody
// else's runtime truthfully — it is not a widening, and nothing here is knowingly false.
//
// ── SCOPE: THREE MEMBERS, WHICH IS ALL THIS EXTENSION USES ──────────────────────────────────────
//
// Measured, not copied from the Chrome docs: `storage.sync.get`, `storage.sync.set` and
// `storage.onChanged.addListener` are the entire surface (`content.js:29,33`,
// `options.js:40,48`). The real `chrome` namespace is enormous; declaring it in full would be
// inventing an interface this repo does not use, and would let a typo in some unrelated Chrome API
// typecheck cleanly.
//
// 📌 Adding a member here is a normal edit, not a red flag — see the note in host-sillytavern.d.ts.
// The @types/chrome package exists and is deliberately NOT used: it is a large dependency for four
// call sites, and `tsconfig.json`'s `include` is an allowlist precisely so this project does not
// start type-checking vendored declarations it never reads.

/** What `chrome.storage.sync` holds for this extension: the Vocalis server URL and its token. */
interface NomiSyncedSettings {
    server: string;
    token: string;
}

interface ChromeStorageChange {
    oldValue?: string;
    newValue?: string;
}

declare const chrome: {
    storage: {
        /**
         * ⚠️ CALLBACK-STYLE, NOT THE PROMISE FORM. Both extensions pass a callback
         * (`content.js:29`, `options.js:40`), and `defaults` doubles as the shape of what comes
         * back — which is why the callback parameter is typed from it rather than as `any`.
         */
        sync: {
            get(
                defaults: NomiSyncedSettings,
                callback: (items: NomiSyncedSettings) => void,
            ): void;
            set(items: Partial<NomiSyncedSettings>, callback?: () => void): void;
        };
        /**
         * Fires when another Chrome instance syncs a change across. `content.js:33` re-reads the
         * server and token from it so an options edit reaches an already-open tab.
         */
        onChanged: {
            addListener(
                callback: (
                    changes: Record<string, ChromeStorageChange | undefined>,
                    areaName: string,
                ) => void,
            ): void;
        };
    };
};
