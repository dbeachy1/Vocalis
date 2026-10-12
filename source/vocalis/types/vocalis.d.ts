// The project's REAL types. 8.3, DESIGN_8_3_JSDOC_TYPES.md §7.
//
// 🔴 KEEP THIS FILE AND `dom-permissive.d.ts` APART, AND THE DISTINCTION IS THE POINT. Everything
// here is a true statement about what the code does. Everything there is a deliberate widening
// paid for a reason. A reader who wants to know whether a type can be trusted should be able to
// answer it by which file it is in, so do not let a convenient lie drift into this one.
//
// ⚠️ WRITTEN AS `.d.ts` RATHER THAN AS JSDoc `@typedef`, deliberately. Structural declarations are
// clumsy in JSDoc and pleasant in TypeScript, and this file is never bundled, never served and
// never parsed by a browser — `tsconfig.json` is the only thing that reads it. Use-site
// annotations stay in JSDoc, in the `.js`, where the code is.

declare global {
    /**
     * The running count a SillyTavern import sweep reports back through `sweepDone`.
     *
     * ⚠️ `stop` IS A SENTENCE, NOT A FLAG. `PUSH_FAIL.locked` / `.rejected` are strings written for
     * the user to read, and this field carries the one that ended the run.
     * ⚠️ `errors` holds ERROR CLASSES, never messages — `sillytavern/extension/index.js`'s B.5 note
     * records why: SillyTavern's `loadWorldInfo` builds a SyntaxError by quoting the lorebook
     * source it choked on, and that string was going across the wire, into the vault, and onto the
     * screen.
     */
    interface SweepTally {
        books: number;
        cards: number;
        personas: number;
        unchanged: number;
        errors: string[];
        stop: string;
    }

    /**
     * 🔴 WHAT A CAUGHT VALUE IS SAFELY TREATED AS. 8.8-m7, `useUnknownInCatchVariables`.
     *
     * JavaScript can throw anything, so `catch (e)` gives `unknown` under that flag and every
     * `e.message` in the tree stops compiling. There were 258 of them.
     *
     * ⚠️ THE OBVIOUS FIX - casting to `Error`, or to `HttpError` below - IS A LIE, AND THE CODE
     * ITSELF SAYS SO. Nearly every one of those sites reads `e.message || 'the request failed'`.
     * That fallback is the original author recording that the thrown value might not carry a
     * message at all; asserting `Error` would tell the checker `.message` is always a string and
     * quietly make the fallback look redundant.
     *
     * So this is the WEAKEST TRUE STATEMENT: it may be an object, it may have a `message`, and
     * when it came from `util/http.js` it also has `status` and `body` (:66-67, :96-97, :122-123).
     * Every member is optional, so `.message` stays `string | undefined` and the `||` fallback
     * remains both required and checked - which is the behavior that was always there.
     *
     * 📌 Prefer narrowing where a site genuinely wants to distinguish causes: `e instanceof Error`
     * is better than this type and costs a real branch. This exists for the ~250 sites that just
     * want to show the user a sentence, where adding a branch would be a behavior change.
     */
    interface ErrLike {
        message?: string;
        /**
         * The DOMException / Error `name`, e.g. `'AbortError'`, `'QuotaExceededError'`.
         *
         * ⚠️ CONTROL FLOW, NOT DECORATION. `vocalis_stream_player.js` suppresses the error
         * entirely when a fetch was aborted on purpose (:137, :147, :340), and :307
         * RE-THROWS anything that is not a QuotaExceededError. Reading it off `unknown`
         * needed a bespoke `{name?: string}` cast at four sites; naming it here is the same
         * statement made once.
         */
        name?: string;
        status?: number;
        body?: HttpErrorBody;
    }

    /**
     * What `util/http.js`'s four helpers throw on a non-2xx response.
     *
     * 🔴 THIS SHAPE IS A CONTRACT AND DRIFT IN IT IS A REAL BUG — `util/http.js`'s own header says
     * so, and names the incidents: the KoboldCpp tab branched on `e.body.error` to render a real
     * sentence, `e.body` was always undefined, every branch fell through to `e.message` — which is
     * the machine-readable CODE — and users saw `kobold_loaded` instead of a sentence.
     * Typing it is how that stops being a comment somebody has to read and starts being checked.
     *
     * ⚠️ `message` IS THE SENTENCE, `body.error` IS THE CODE, and the helpers prefer
     * `j.message || j.error || r.statusText` in that order for exactly that reason.
     */
    interface HttpError extends Error {
        /** The HTTP status. Callers branch on 401/404/409/422/423 by number. */
        status: number;
        /** The parsed JSON error body, or `{}` when the response was not JSON. */
        body: HttpErrorBody;
    }

    /**
     * The error envelope the Flask side returns.
     *
     * 🔴 `error` IS POLYMORPHIC AND BOTH FORMS ARE LOAD-BEARING. It is a machine-readable string
     * code on most routes (`'cards_busy'`, `'no_gpu'`, `'exists'`, `'batch_running'`,
     * `'entries_without_keywords'`), but an OBJECT on `/clips/scenes/<ref>/enhance` and
     * `/clips/scenes/<ref>/edit`. `scenes/scenes.js` unwraps all three shapes by hand and carries a
     * comment recording that `jpost` once stringified the object into the UI.
     */
    interface HttpErrorBody {
        /** The human sentence. Preferred over `error` when both are present. */
        message?: string;
        /** A code to branch on — or, on the two scene routes, a nested envelope. */
        error?: string | { message: string; job_id?: string };
        /** 409 on `/wbedit/documents/<id>/edit` carries the revision the caller lost to. */
        latest?: number;
        /**
         * 422 on the same route names the entries that have no keywords.
         *
         * ⚠️ WAS `unknown[]` UNTIL 8.8-m7, WHICH MADE ITS ONLY CONSUMER CAST. The shape is not
         * open: `wbedit/formats/worldbook.py`'s `inert_entries` (:108-114) appends exactly
         * `{"label", "entry"}` per offender, and both are always set. `label` is the sentence's
         * name for it; `entry` is the LOCATOR the editor marks rows by - `["entries", ckey]` on a
         * compiled book, `[ckey]` otherwise - which is why it is a list and why the client
         * compares locators rather than labels (a `comment` is neither unique nor required).
         *
         * 📌 This now matches `wb/edit.js`'s `wbMarkKeyless` parameter exactly, which had been
         * carrying the real shape in its own JSDoc while this said `unknown[]`.
         */
        entries?: { label: string; entry: (string | number)[] }[];
        /** 409 on the `/train/import*` routes names the file that would be overwritten. */
        name?: string;
        /**
         * The two 409s on `/train/start`, which are the only bodies here the client does more
         * with than print. `web/train.py:763` sends `{gpu, busy_with}` for "that card is already
         * training"; `:779-781` sends `{name, training, registry, voices}` for "a training of
         * this name already exists".
         *
         * ⚠️ `voices` IS THE ONE THAT HAD TO BE NAMED. `training.js:1883` does
         * `(e.body.voices || []).length` and `.join(', ')`, which the `[k: string]: unknown`
         * index signature cannot support — so it was carrying a local `string[]` assertion. It is
         * `voicetrain.deployed_from()` (`src/voicetrain.py:1858`), built as
         * `[v["name"] for v in voices ...]`, so `string[]` is what it is. The rest are only
         * interpolated or `esc()`d, and `unknown` is fine for those.
         */
        gpu?: number;
        busy_with?: string;
        training?: boolean;
        registry?: boolean;
        voices?: string[];
        [k: string]: unknown;
    }

    interface Window {
        /**
         * 🔴 `__uiReady` AND `__bootDone` ARE NOT THE SAME EVENT, AND CONFLATING THEM DOES NOT FAIL
         * A SPEC — IT MAKES ONE VACUOUS. `__uiReady` means the modules have RUN; `__bootDone` means
         * the page is WIRED and its boot data has arrived. A click landing between the two is
         * **dropped in silence**, which is why a harness that waits on the wrong one passes while
         * proving nothing. Typing them here is the cheapest place to state the difference so the
         * next person picks the right one.
         */
        __uiReady?: boolean;
        /** The modules ran AND the boot `allSettled` list resolved. See `__uiReady` above. */
        __bootDone?: boolean;
        /**
         * 🔴 WHICH TRANSPORT THE HARDWARE STRIP IS ACTUALLY ON — `'stream'`, `'poll'` or `'off'`.
         * 9.0.8 replaced a 4 Hz poll with one held SSE connection AND kept the poll as the
         * fallback, so "the strip is painting" no longer proves the new path works: a spec that
         * only waits for numbers passes identically when the stream is dead and the fallback is
         * carrying it. This is what makes that assertion non-vacuous.
         */
        __stripTransport?: 'stream' | 'poll' | 'off';
        /** A tab selected before the UI was wired, replayed once boot completes. */
        __pendingTab?: string;
        /** The account-local UI state the server substitutes into `index.html` at render. */
        __UI_STATE__?: Record<string, string>;
        /**
         * ⚠️ A GLOBAL FROM A NON-MODULE SCRIPT. `vocalis_stream_player.js` is loaded with a plain
         * `<script src>` before the module bundle, so this is not importable and every reference
         * to it is a bare global.
         */
        VocalisStreamPlayer?: VocalisStreamPlayerApi;
        /**
         * The File System Access API's Save-As dialog — `wb/dl.js`, 11.1.8.
         *
         * 🔴 **NOT IN `lib.dom.d.ts` AS OF TYPESCRIPT 5.9**, although `FileSystemFileHandle` and
         * `FileSystemWritableFileStream` (which this resolves to and which it opens) both are. It
         * is declared here rather than cast away at the call site so the handle keeps its real
         * type and `createWritable()`/`write()`/`close()` stay checked.
         *
         * ⚠️ **OPTIONAL BECAUSE IT GENUINELY IS.** Chrome and Edge have it; Firefox and Safari do
         * not, and `wbDownload` falls back to the `<a download>` it has always used. A `?` here is
         * what forces that branch to exist — declaring it unconditionally would typecheck a page
         * that throws on load in the other half of the browsers.
         */
        showSaveFilePicker?: (options?: {
            id?: string;
            suggestedName?: string;
            startIn?: string;
            excludeAcceptAllOption?: boolean;
            types?: { description?: string; accept: Record<string, string[]> }[];
        }) => Promise<FileSystemFileHandle>;
    }

    /**
     * Expando properties this app parks ON DOM nodes rather than in a side table.
     *
     * ⚠️ THESE ARE A REAL CONVENTION, NOT AN ACCIDENT, so they are declared here rather than
     * widened away in `dom-permissive.d.ts` — each one is a per-element latch whose whole purpose
     * is to live and die with the node. Declaring them keeps a typo (`_wbPicBnd`) an error.
     */
    interface Element {
        /** `ui/audition.js` — this element's audition is running. */
        _audRunning?: boolean;
        /** `wb/face.js` — the picture input has already been wired; do not bind twice. */
        _wbPicBound?: boolean;
        /**
         * `wb/pass.js` — the entry's text as it arrived, kept for §6.3's live diff.
         *
         * ⚠️ A PROPERTY RATHER THAN `dataset`, DELIBERATELY: this is user-provided lore, and an attribute
         * would write a second copy of it into the markup where every DOM dump and innerHTML read
         * carries it. That reasoning is at the assignment site; declaring it here is what keeps a
         * typo an error rather than a silent `undefined` diff.
         */
        _wbOriginal?: string;
        /** A debounce/timeout handle parked on the element it belongs to. */
        _t?: number;
        /** The rows a list element was last painted from, for identity-preserving repaints. */
        _items?: unknown[];
        /** The signature an element was last rendered with, so an unchanged repaint can bail. */
        __sig?: string;
    }

    /**
     * The handle `VocalisStreamPlayer.play()` hands back.
     *
     * ⚠️ `util/appstate.js` parks one of these in `state.pgStream`, which is why that object is
     * documented as holding a LIVE HANDLE rather than data.
     */
    interface VocalisStreamHandle {
        /** User stop. Aborts the fetch, which is what cancels the server-side render. */
        stop(): void;
    }

    /**
     * Options for `VocalisStreamPlayer.play()`. Measured against every `opts.*` read in
     * `src/webui/vocalis_stream_player.js` — the three modes the header comment describes are
     * expressed here as three groups of optional fields rather than a union, because the helper
     * itself only ever tests them for presence.
     */
    /**
     * 🔴 THE SILLYTAVERN EXTENSION'S PLAYER TAKES A DIFFERENT SHAPE, AND CONFLATING THE TWO WAS
     * THE FIRST THING m8 TRIED. `sillytavern/extension/vocalis-stream.js` exports its own
     * `playStream`, and it is NOT `VocalisStreamOpts` below with a couple of extras — the two
     * disagree on how the server is addressed AND on what the callbacks receive:
     *
     *   - it takes `serverBase` + `token` and builds the URLs itself, where the web UI's player is
     *     handed `registerUrl`/`streamUrl`/`statusUrl` already made;
     *   - `onPlaying` receives the `<audio>` element, where the web UI's takes nothing;
     *   - `onError` receives a second `info` argument carrying the locked/unauthorized
     *     distinction, which §6.2 needs to tell "set your token" apart from "the vault is shut".
     *
     * ⚠️ THAT LAST ONE IS WHY THEY MUST STAY SEPARATE. A locked vault must never render as an auth
     * problem — the token may be perfectly right and merely unverifiable — and the `info` argument
     * is how the caller tells them apart. Widening the web UI's `onError` to carry it would put a
     * parameter on a callback that nothing there passes; narrowing this one would delete the
     * distinction. They are two contracts, so there are two types.
     */
    interface VocalisExtStreamOpts {
        /** e.g. `https://vocalis.example:7871` — this player appends the route paths itself. */
        serverBase: string;
        /** The pairing token, pasted once from the Vocalis web UI. */
        token?: string;
        /** The `/v1/audio/speech` payload. */
        body?: unknown;
        /** Receives the element, so the caller can wire its own controls to it. */
        onPlaying?: (audio: HTMLAudioElement) => void;
        onEnded?: () => void;
        /** `info` carries the locked/unauthorized distinction — see the warning above. */
        onError?: (msg: string, info?: Record<string, unknown>) => void;
        onTruncated?: (retry: () => void) => void;
    }

    interface VocalisStreamOpts {
        /** Register-and-stream mode: JSON-stringified and POSTed to `registerUrl`. */
        body?: unknown;
        /** Defaults to `/webui/stream`. */
        registerUrl?: string;
        /** Pre-registered mode: the caller already POSTed and holds the one-time URLs. */
        streamUrl?: string;
        /** Pre-registered mode: polled once playback ends, to tell complete from truncated. */
        statusUrl?: string;
        /**
         * Visible-player mode: native controls over the live stream. Typed to admit `VEl` because
         * every caller reaches its `<audio>` through `$`, which returns `VEl` by design — see the
         * lie written down at `util/dom.js`. The helper needs a real media element at runtime.
         */
        audioEl?: HTMLAudioElement | VEl;
        /** Resume-behind (seconds): hold playback until this point is buffered, then start there. */
        startAt?: number;
        /** Audio audibly started. */
        onPlaying?: () => void;
        /** Finished, and `statusUrl` confirmed it was complete. */
        onEnded?: () => void;
        /** Failed before or without audio. */
        onError?: (msg: string) => void;
        /** Ended early. Call `retry()` to re-run with the same options. */
        onTruncated?: (retry: () => VocalisStreamHandle) => void;
    }

    /**
     * 🔴 A NAMESPACE OBJECT, NOT A CONSTRUCTOR. `vocalis_stream_player.js:249` ends with
     * `window.VocalisStreamPlayer = { play }` and all three call sites say
     * `VocalisStreamPlayer.play({…})` — nothing anywhere does `new VocalisStreamPlayer(…)`.
     * Declaring it as a constructor type made `.play` a lookup on the constructor itself, which
     * is why `pg/playground.js`, `ui/audition.js` and `vocalis_stream_player.js` each carried a
     * TS2339/TS2353 for a call that has always been correct.
     */
    interface VocalisStreamPlayerApi {
        play(opts: VocalisStreamOpts): VocalisStreamHandle;
    }

    /**
     * ⚠️ REFERENCED BARE, NOT AS `window.VocalisStreamPlayer`. `vocalis_stream_player.js` is a
     * plain `<script src>` that runs before the module bundle, so `pg/playground.js:298` says
     * `VocalisStreamPlayer.play(…)` with no import and no qualifier.
     */
    const VocalisStreamPlayer: VocalisStreamPlayerApi;

    // ─────────────────────────────────────────────────────────────────────────────────────
    // `util/appstate.js`'s `state`, and the four server payloads it parks.
    //
    // 🔴 THIS IS THE SHARED VOCABULARY, AND IT IS DECLARED HERE SO IT CANNOT MOVE UNDER
    // ANYBODY. DESIGN_8_3 §11.2: type errors are not file-local, so declaring `state.chapters`
    // as `Chapter[]` produces errors in `book/`, `media/` and `scenes/`. If that lands while
    // the feature directories are being annotated in parallel, every writer's error list moves
    // under every other writer and nobody can verify their own work. So `util/` and these
    // declarations are frozen BEFORE any fan-out, and the annotation agents consume them
    // read-only.
    //
    // ⚠️ EVERY FIELD BELOW WAS READ OFF THE ROUTE THAT PRODUCES IT, not off a call site's
    // guess — `/gpus` (web/system.py + runtime/gpu.py's `gpu_registry`), `/book/parse`
    // (web/books.py:725), `/library`, `/voices` (web/voices.py:819 + `rt_voices.meta`).

    /**
     * One local CUDA card, as `/gpus` publishes it.
     *
     * 🔴 `allows` IS THE SERVER'S OWN PREDICATE, NOT A HINT. It is computed by the same
     * `enabled AND authorized(...)` the routes enforce (`pool.local_card_permissions`), which is
     * why `util/appstate.js`'s `cardsFor()` reads it and must never re-implement it — three
     * pickers each rolling their own is how they came to offer cards their route would refuse.
     *
     * ⚠️ ABSENT MEANS ALLOWED, deliberately: a page held open across an upgrade has pre-8.0
     * rows cached in `state.gpus`, and hiding every card because the key is missing would take
     * the feature away rather than filter it.
     */
    interface GpuCard {
        /** The CUDA ordinal. `cuda:${index}` is the wire form the routes take. */
        index: number;
        /** `torch.cuda.get_device_name(index)`. */
        name: string;
        /** subsystem → may this card run it. Missing key, or missing map, means yes. */
        allows?: Record<string, boolean>;
    }

    /** A parsed book chapter — `/book/parse`'s `chapters`, and the `sections` an SSE replay carries. */
    interface Chapter {
        /** 0-based, and the `data-ch` attribute the done-marks are keyed on. */
        index: number;
        title: string;
        /** Absent on the SSE `sections` replay, which carries render status instead. */
        words?: number;
        /** ⚠️ `state.bookChars` is the SUM of these, and it is what the ETA line is quoted from. */
        chars?: number;
        status?: string;
        duration_s?: number;
    }

    /** One complete audiobook export attached to a rendered book. */
    interface FullAudiobook {
        file: string;
        /** Plaintext byte size, measured through vault_fs. */
        size: number;
    }

    /** A rendered book on the shelf — one row of `/library`. */
    interface BookRow {
        /** The output directory's name, and this row's identity everywhere. */
        book: string;
        /** Friendly title shown in the Library; falls back to `book` for older responses. */
        display_name?: string;
        /** Current human label for the voice, when one is available. */
        voice_label?: string;
        /**
         * 8.9 — the id of the virtual folder this book is filed in, or absent/null for unfiled.
         * Stamped by the server (`folders.for_rows`, scope `books`, keyed on `book`).
         * 📌 The scope is NOT in `folders.RENAME_MOVES_REF`: there is no rename route for a book,
         * so this key cannot move. Adding one means adding the hook — that register is where it
         * gets recorded, and a test fails by name if the two disagree.
         */
        folder?: string | null;
        /** Chapters finished, of `chapters` total. */
        done?: number;
        chapters?: number;
        voice?: string;
        total_duration_s?: number;
        rendered_at?: number;
        /** Actual completed audiobook filename, either Opus or MP3, when one exists. */
        full_mp3?: string | null;
        /** Logical size of the completed audiobook file. */
        full_size?: number | null;
        /** Every available canonical complete-book export, in preferred format order. */
        full_audiobooks?: FullAudiobook[];
        /**
         * ⚠️ FALSE MEANS "IMPORTED", NOT "BROKEN". No `vocalis-book.yaml`, so voice and params
         * were never recorded; it plays and downloads normally.
         */
        has_sidecar?: boolean;
        /** Recorded render fields exist; distinct from a minimal rename-only sidecar. */
        has_render_metadata?: boolean;
    }

    /** One voice in the store — a row of `/voices` (`name`/`size`/`label` plus `rt_voices.meta`). */
    interface VoiceRow {
        /** The file name, including extension. The identity the routes take. */
        name: string;
        /** ⚠️ THE PLAINTEXT SIZE (M10 §4.6), not the ciphertext's. */
        size?: number;
        /** The display name, or `''`. */
        label?: string;
        /** `'uploaded'` or `'created'`. ⚠️ ABSENT READS AS `'uploaded'` at every call site. */
        origin?: string;
        favorite?: boolean;
        added?: number;
        added_exact?: number;
        /**
         * 8.9 — the id of the virtual folder this voice is filed in, or absent/null for unfiled.
         * Stamped by the server (`folders.for_rows`, scope `voices_tts`), never derived in the
         * client: the server owns the scope's stable key, and a second opinion about identity
         * here would be a second thing to get wrong.
         */
        folder?: string | null;
    }

    /**
     * The `eta` SSE event, parked whole in `state.eta`.
     *
     * 🔴 `measured:false` IS NOT A CUE TO FALL BACK — there is nothing to fall back to, and a
     * made-up number in this slot is what quoted a ten-hour book as sixteen for a month.
     * `book/job.js`'s `subLine()` renders "measuring…" instead, deliberately.
     */
    interface EtaEvent {
        type?: string;
        /** Has THIS box been timed? If not, nothing below is quotable. */
        measured?: boolean;
        eta_s?: number;
        /**
         * How much text is left to render. ⚠️ ALWAYS ON THE WIRE — `web/books.py:449` and `:513`
         * both send it beside `measured`/`rate`/`eta_s` — but nothing in the front end reads it
         * today. Declared because this type's job is to describe the route, not the current
         * readers; the next person to want a "N chars left" line should find it already true.
         */
        chars_left?: number | null;
        /**
         * Chars per second, rendered with `.toFixed(1)`.
         *
         * ⚠️ ALWAYS ON THE WIRE AND NULLABLE - not absent. `web/books.py:447` sends
         * `{"rate": seed}` and `:512` sends `{"rate": live or seed}`; both are `None` until this
         * box has been timed. Declared `number` alone until 8.8-m6, which is why `job.js` had to
         * assert it.
         *
         * 📌 `measured` truthy IMPLIES this is a non-zero number - both emitters derive `measured`
         * from the same expression they put here (`bool(seed)` / `bool(live or seed)`). That is
         * the invariant `subLine()`'s `!e.measured` guard relies on, and it is why the cast there
         * is TRUE rather than hopeful.
         */
        rate?: number | null;
        /** Where the rate was measured, e.g. `'on this box'`. */
        from?: string;
    }

    /**
     * One ACE-Step backend's row in `/acestep/status`.
     *
     * 🔴 DECLARED CENTRALLY BECAUSE TWO DIRECTORIES READ THE SAME POLL AND TWO WRITERS DECLARED IT
     * SEPARATELY. `sys/acestep.js` owns the poll (`ACE_SUBS`/`fanout`) and `ace/cards.js`
     * subscribes through `onAceStatus` — one route, one subscription, so a local typedef in each
     * is two statements about one payload that are free to drift. They immediately did, and the
     * checker caught it as a TS2345 on the `onAceStatus(...)` argument.
     *
     * ⚠️ AND THEY DISAGREED ABOUT `loading`, WHICH IS THE POINT OF WRITING IT DOWN ONCE.
     * `sys/acestep.js` said `boolean`; `ace/cards.js` said `string`. `ace/cards.js` was right —
     * `runtime/acestep.py:674` stores `_LOADING[device] = model`, so `loading_model(dev)` returns
     * the MODEL NAME being loaded, and `cards.js:155` renders it (`loading ${esc(b.loading)}…`).
     * The wrong one was never read, so nothing was broken; it was simply untrue.
     *
     * 📌 NOT TO BE CONFUSED WITH `/acestep/start`'s `"loading": True`, which really is a boolean
     * on a DIFFERENT payload (`web/acestep.py:666`). Same key, two routes, two types — the same
     * trap as `avatar` in `st/chars.js`.
     */
    interface AceBackend {
        /** `cuda:0` — the card this backend serves. */
        device: string;
        /** Stable local child identifier. */
        service?: string;
        url?: string;
        up?: boolean;
        /**
         * 🔴 A THREE-STATE VALUE. `null` means the backend did not answer — never render that as
         * "not loaded"; xl-sft is 19 GB and "40 seconds into arriving" must not read as "did
         * nothing".
         */
        model_loaded?: boolean | null;
        model?: string | null;
        /** The model name currently being loaded, or absent/null when none is. See above. */
        loading?: string | null;
        /** May this card hold a model at all — the ⚙ Settings tick. */
        authorized?: boolean;
        /** Owned child state, separate from HTTP reachability and model readiness. */
        unit?: string | null;
        /** A render or model operation currently holds this card. */
        busy?: boolean;
    }

    /**
     * `/acestep/status`. ⚠️ `available:false` is the WHOLE body on a box with ACE-Step not
     * installed — every other field is then simply absent, never a placeholder.
     */
    interface AceStatus {
        available?: boolean;
        /** Authorized backends — what the header's `×N` counts. */
        instances?: number;
        installed?: number;
        /** Number of active or starting owned children; `null` means a stop is unconfirmed. */
        running?: number | null;
        backends?: AceBackend[];
    }

    /**
     * The one object the whole front end shares — `util/appstate.js`'s `state`.
     *
     * 🔴 SEVEN FIELDS ARE NOT IN THE INITIALIZER AND THAT IS NOT AN OVERSIGHT: `books`,
     * `bookLive`, `chapsDone`, `eta`, `vlist`, `pgResume` and `pgLibClip` are created by their
     * first writer. They are declared here because a store whose members depend on which code
     * has run yet is exactly the shape a typo disappears into — `state.pgLibclip` would have
     * been a silent `undefined` forever.
     *
     * ⚠️ IT IS MUTATED, NEVER REASSIGNED. `state = {...}` would give one module a fresh object
     * while every other reader keeps the old one. The header at `util/appstate.js` is the long
     * version.
     */
    interface AppState {
        /** This box's local cards. Written once by `sys/devices.js`'s `loadGpus()`. */
        gpus: GpuCard[];
        /** The running book render's job id, or null. */
        jobId: string | null;
        /** The book render's live SSE connection. Closed and nulled by `endJob()`. */
        es: EventSource | null;
        running: boolean;
        chapters: Chapter[];
        /** Which chapter indices are already rendered — pre-marked from the sidecar on resume. */
        chapsDone?: number[] | null;
        /** The book whose output panel is open, or null. */
        curBook: string | null;
        /** Sum of every chapter's `chars`. The ETA line's input. */
        bookChars: number;
        /** `/library`'s rows, kept so the filter can re-render without refetching. */
        books?: BookRow[];
        /** Names of books being rendered right now, badged in the library list. */
        bookLive?: string[];
        /** The last `eta` SSE event. Null while a fresh job is starting. */
        eta?: EtaEvent | null;
        /** `/voices`, kept so the filter and the sort re-render without refetching. */
        vlist?: VoiceRow[];

        // ── the Playground's parallel set of the same ──────────────────────────────────
        pgJobId: string | null;
        pgEs: EventSource | null;
        pgRunning: boolean;
        /**
         * ⚠️ A LIVE HANDLE, NOT DATA — which is why `state` is not serializable and must never
         * be sent anywhere.
         */
        pgStream: VocalisStreamHandle | null;
        /** Seconds of audio produced so far, against the enhance cap. */
        pgAudioS: number;
        /** The clip a resume is armed on, by ref. */
        pgResume?: string | null;
        /** The library clip whose player row is open, by ref. */
        pgLibClip?: string | null;
        /**
         * ref → the enhance job running on that row.
         *
         * 🔴 A MAP, NOT ONE JOB ID: an enhancement takes ONE card, so on a two-card box two of
         * them run side by side (4.1-M16). The row that started each one is where it lives —
         * its ■ cancels that job and nothing else.
         */
        pgEnh: Map<string, { jid: string; name: string }>;
    }

    /**
     * One row of `/acestep/library`'s `songs`, i.e. `runtime/acelib.py`'s `Song.to_dict()` (:102).
     * The tray keeps the last payload in `SONGS` so a click has the whole song to hand, and hands
     * it to the form through `ace:loadsong`.
     *
     * ⚠️ `template` and `settings` ARE MEANINGFULLY `{}` — `from_dict` (:116) uses `isinstance`
     * rather than `or None` precisely because an empty object means "recorded, all defaults", and
     * collapsing it to null would make loading such a row leave the Advanced boxes untouched
     * instead of clearing them.
     */
    interface AceLibSong {
        id: string;
        name: string;
        template_id?: string | null;
        caption?: string | null;
        lyrics?: string | null;
        model?: string | null;
        seed?: number | null;
        device?: string | null;
        favorite?: boolean;
        created_at?: number | null;
        template?: Record<string, unknown> | null;
        settings?: Record<string, unknown> | null;
        rendered?: unknown;
    }

    /**
     * 🔴 THE APP'S OWN EVENTS, DECLARED SO NOTHING HAS TO CAST THEM. 8.8-m7.
     *
     * `document.addEventListener('ace:template', ev => ...)` gives `ev: Event`, and `Event` has no
     * `detail` - so each of these handlers used to open with a cast to `CustomEvent`. Two things
     * were wrong with that. It had to be repeated at every read inside the handler, which is
     * exactly the shape Prettier retargets (DESIGN_8_3 §9b); and writing `@param {CustomEvent} ev`
     * on the listener instead is UNSOUND - under `strictFunctionTypes` a listener demanding
     * `CustomEvent` is not assignable where one taking `Event` is expected, which is how m7 found
     * all four of them.
     *
     * Augmenting the event map is the honest fix and the one TypeScript is built for: a true
     * statement about what `document.dispatchEvent` is handed, made ONCE, at the source. `ev` is
     * then inferred as the right `CustomEvent<...>` with no annotation on the listener at all, and
     * `ev.detail` is typed instead of `any`.
     *
     * ⚠️ THE DETAIL SHAPES ARE READ OFF THE DISPATCH SITES, NOT INVENTED. Adding an event without
     * adding it here is silent: the name falls back to plain `Event` and the casts creep back.
     */
    interface DocumentEventMap {
        /** `ace/cards.js:611` - the models each live backend actually has loaded. */
        'ace:cardmodels': CustomEvent<{
            models: string[];
            byDevice: Record<string, { tasks?: Record<string, string[]>; task_models?: Record<string, string[]> }>;
        }>;
        /** `ace/form.js:1273,1381,1465` - the selected template, or `null` for "all". */
        'ace:template': CustomEvent<{ id: string | null }>;
        /** `ace/tray.js:483` - the song a library row asked the form to load. */
        'ace:loadsong': CustomEvent<{ song: AceLibSong }>;
        /** `ace/tray.js:506` - whether a forever-render is running. */
        'ace:forever': CustomEvent<{ on: boolean }>;
    }
}

export {};
