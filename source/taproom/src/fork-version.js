/**
 * 🔴 THE ONE PLACE TAPROOM'S OWN VERSION IS WRITTEN DOWN. BUMP IT HERE, AND NOWHERE ELSE.
 *
 * Everything that displays, logs or serves the fork's version reads it from here: `getVersion()` in
 * `util.js` (which feeds `/version`, the boot banner, and the client's `#version_display`), and anything
 * added later. If you find yourself typing the number into a second file, that second file is the bug.
 *
 * It lived in `package.json` (`forkTag` / `forkVersion`) until 0.3, which is exactly how 0.3 shipped to test-host
 * still calling itself 0.2: the number sat in a data file nobody thinks of as code, so bumping it was never
 * part of finishing a feature. A named constant in `src/` is somewhere a person looks.
 *
 * ⚠️ A NEW FILE ON PURPOSE. We pull from upstream regularly, and a file upstream does not have can never
 * produce a merge conflict. Do not move these into `constants.js` — that one is upstream's, and every fork
 * edit to it is a conflict we pay for on every pull.
 */

/**
 * The fork's name, as it appears in the version string. Identity, not a counter — this does not change.
 * @type {string}
 */
export const FORK_TAG = 'taproom';

/**
 * OUR counter, and not a semver prerelease of upstream:
 *
 *   0.1 — the log-hygiene gate.
 *   0.2 — server plugins + the storage-provider interface.
 *   0.3 — interactive plugin panels. Fork half only; the plugin half is
 *         Mnemosyne's. Note this is NOT the plugin API version, which counts separately and is at 5 —
 *         see `PLUGIN_API_VERSION` in `plugin-loader.js`.
 *   0.4 — themeable button colors: four `--SmartThemeButton*` variables in the theme system, plus a
 *         default that makes buttons look like buttons. `public/css/buttons.css`.
 *   0.5 — the same four colors reach collapsible section headers, so "blue means you can click it" holds
 *         for every control and not just buttons. No new variables. `public/css/buttons.css`.
 *   0.6 — `/api/worldinfo/delete` and `/edit` refuse a world whose storage is unavailable. The read side
 *         already 409'd and the native dropdown already disabled those entries, but both are client-side,
 *         and a caller that reads "unreadable" as "empty" could delete or overwrite real ciphertext.
 *         `src/endpoints/worldinfo.js`.
 *   0.7 — decrypted content stops escaping into transport, on two paths. A terminal express error handler,
 *         because with none registered a thrown error answered with `err.stack` — and V8 quotes the input
 *         inside a `JSON.parse` message, so a corrupt lorebook was answered with a piece of that lorebook
 *         (`src/server-main.js`). And the client half of 0.6: `_save` never checked the response, so the
 *         409 that 0.6 introduced resolved like a 200 and left the unwritten document sitting in
 *         `worldInfoCache`, where every later read found it (`public/scripts/world-info.js`).
 *   0.8 — the read side that Vocalis's character and worldbook editors sit on. A thumbnail is stored
 *         under the ORIGINAL image's filename while the generator encodes JPEG, and Content-Type is
 *         derived from that filename at both ends of the storage funnel — so every avatar thumbnail
 *         went out declared `image/png` with `ff d8 ff` in the body. `<img>` sniffs and never noticed;
 *         a client that stores the asset as what we said it was ends up with JPEG filed under `.png`
 *         (`src/endpoints/thumbnails.js`). And `/api/worldinfo/list` rows carry a `change` token
 *         (`mtime`, `size`), so an editor that imported a book can tell whether SillyTavern's copy
 *         moved before it pushes over it — the character list already had one in `date_added`, and
 *         books had nothing (`src/endpoints/worldinfo.js`).
 *   1.0 — feature complete. The gap from 0.8 is the largest one here, so it is themes and not commits:
 *         • The storage-provider layer stops answering questions it was not asked. An unreadable read
 *           came back as plaintext, a partial read as complete, an unreadable chat as `[]` (which the
 *           client then wrote back over the real one), a failed save as 200, a rename as a delete, and
 *           the Data Maid condemned a whole account when a provider was merely uninstalled.
 *         • A server→client freshness channel, so an open tab notices its data moved underneath it —
 *           plus the three ways its first cut misbehaved (reload storms, going permanently deaf, and
 *           reporting no change when there was one).
 *         • Plugin panels: several panels can share one slot, a leading slash stopped counting as a
 *           route boundary (a panel could name any route in the fork), and a panel stylesheet can no
 *           longer style the whole page. The legacy `user.css` now leaves the web root at boot.
 *         • Backups stream at the pace the client drains instead of buffering the walk, and an aborted
 *           walk closes the stream it was holding.
 *         • Retrieval means something again: the shipped embedding model was emitting noise, and the
 *           vector query threshold was not filtering what chat retrieval actually read. Both are now
 *           guarded by specs.
 *         • A character can name its own SD checkpoint and the workflow that loads it (`/sd-char-model`).
 *   1.1 — 68 commits, and the number should have moved several times inside them. Themes again:
 *         • `context.generate` actually reaches a real backend. It sent every request UNAUTHENTICATED, so
 *           it worked only against a keyless local backend — which is what development used. Then it sent
 *           sampler fields the backend's schema did not list, 400ing a connection the UI talks to fine.
 *           Then it hardcoded `stream: false`, which a reasoning model answers with a 500 while streaming
 *           the identical body correctly. Then it treated an instruct envelope that frames NOTHING as a
 *           real one and sent the prompt bare — the default state of a profile with instruct mode off.
 *           Four separate ways for automatic memory to never complete a pass, three of them invisible
 *           because they only bite on a backend development never used.
 *         • The fork can say what it actually sent. An itemized prompt record that survives returning to a
 *           chat, holds as many generations as the panel lists, names which part changed by CONTENT rather
 *           than by size, and reports a cold turn as a fact the backend stated rather than one an analyzer
 *           inferred and got wrong.
 *         • A message keeps its buttons — while the next reply is being fetched, after a streaming error,
 *           and while anything else holds the input lock. A generation that throws gives the send button
 *           back.
 *         • A character's picture reaches the chat she is already in: a thumbnail follows its card instead
 *           of six callers each remembering to invalidate it.
 *         • World Info stops fighting the KV cache. New entries no longer land on top of it, boot-built
 *           dropdowns carry their canonical name, the refresh button refreshes, and a book someone else
 *           wrote is no longer served out of this tab's cache. Two settings that silently did nothing are
 *           documented as the footguns they are.
 *         • A connection profile naming a deleted preset says so instead of failing quietly, and a refresh
 *           no longer hands your chat to the default persona.
 *   1.2 — server plugins get a home in the Extensions dialog, and stop being invisible when they break.
 *         • `registerSettings` (plugin apiVersion 6): a server plugin declares that it has settings and the
 *           fork hosts the fragment its own route returns, inline in the Extensions dialog. Independent of
 *           `registerPanel`, which is the entire point — a plugin with no business owning a chat button had
 *           no UI channel at all, and therefore nowhere to put settings. Deliberately NOT a declarative
 *           schema: that would force the FORK to persist values that live inside a user's encrypted store,
 *           and would replace working plugin UI with a generic form.
 *         • A `Server plugins` section listing every plugin the fork TRIED to load, its version and whether
 *           it started — including plugins that declare nothing at all, because "is it running" is worth
 *           answering even when there is nothing to configure.
 *         • 🔴 And the half that is worth more than the feature that prompted it: a plugin that throws
 *           during startup is no longer invisible. It was written to st.log and nowhere else, so the user
 *           got a SillyTavern that quietly did less than it did yesterday and no way on screen to find out
 *           why. Failures now carry the stage and the error's type for everyone, and the full message for
 *           an admin over a separate route — the message is routinely an absolute server path, which is not
 *           every logged-in user's to read.
 *         • A settings route that cannot answer right now — a locked vault, most obviously — answers 503
 *           with its own fragment, and the fork renders those words rather than substituting an empty form
 *           the user would then Save over their real configuration with.
 *
 *   1.3 — assistant responses that the reasoning parser receives without a closing thinking suffix are
 *         promoted from an empty visible message to normal message text, with reasoning metadata cleared.
 *         This keeps the rendered message, text-to-speech input, active swipe, and persisted chat aligned.
 *   1.4 — a plugin can read a chat without a generation in flight (plugin apiVersion 7), for Mnemosyne's
 *         "rescan the last N messages" panel action.
 *         • `context.readChat(handle, chatId, {last})` returns a chat's core turns from disk, through the
 *           storage provider, built by the same client code that builds `recentMessages` — so a turn has
 *           the same `index`, `charId` and `sendDate` whichever path delivered it. A locked vault throws
 *           rather than reading as an empty chat.
 *         • Every plugin turn carries `sendDate` (epoch ms or null), parsed server-side from every
 *           `send_date` format ST has ever written.
 *         • `context.generate()` works from a panel action after a restart: panel requests carry the
 *           user's text-completion connection and instruct envelope, captured as a generation's are.
 *   1.5 — memory works in Chat Completion, Featherless connects in a second, and cut-off thinking is not
 *         returned as a completed quiet result.
 *         • `context.generate()` runs against a Chat Completion connection (plugin apiVersion 8): the chat
 *           route captures the source, model and key SLOT the way the text route does, panel requests
 *           carry the chat connection too, and a plugin's prompt goes out as one `user` turn to the
 *           source's `/chat/completions`. OpenAI-wire sources only (`openai`, `custom`, `openrouter`).
 *         • Connecting to Featherless no longer downloads its 22,000-model list: Connect checks only the
 *           selected model, the list is fetched on demand with a "Refresh model list" button and cached
 *           on disk, and the server logs a count instead of every id.
 *         • A quiet generation whose backend reports truncation (`finish_reason: length`) and no content
 *           returns no result rather than falling back to incomplete reasoning.
 *   1.6 — a reply whose prompt ended with the opening reasoning tag is read as starting inside it. With
 *         `<think>` in the Last Assistant Prefix:
 *         Featherless sometimes leaves the reasoning in the reply text as `reasoning</think>reply`, which
 *         rendered the chain of thought as the message, and a model that skipped thinking rendered a bare
 *         `</think>`. The text before the closing tag now goes to the thinking block, streamed or not, and
 *         Start Reply With stops being the only way to get a working thinking drawer (it also glued a stray
 *         `<think>` onto every reply the provider had split properly). `public/scripts/reasoning.js`.
 *         Also carries the fixes since 1.5: compaction and branching, Featherless Refresh/Connect keeping the
 *         model list, and tool calls with no arguments sent as `{}`.
 *   1.7 — a streamed Kobold Classic or NovelAI generation tells server plugins whose chat it is. Found
 *         2026-10-10 from the Mnemosyne side. Those two streaming senders posted plain request
 *         headers and the bare body, so the generation arrived with no character, chat, persona or
 *         generation kind and no `st_recent_messages` — while the non-streaming sender and the
 *         text-generation-webui streaming sender sent all of it. A memory plugin on those paths did not know
 *         which chat it was in and never learned from one. `public/scripts/kai-settings.js`,
 *         `public/scripts/nai-settings.js`, `sendStreamingRequest` in `public/script.js`.
 *   1.8 — a background generation says it is one on every backend. Product rule, 2026-10-10: "I only want
 *         memories injected into prompts for actual replies. I don't want them for Vocalis Polish. I don't
 *         want them for generating summaries." `generateRaw` — summaries, image prompts, expression picks —
 *         sent `X-ST-Gen-Type: quiet` on Chat Completion and plain request headers on the kobold, novel and
 *         text-completions routes, where it therefore read as an ordinary reply. It is labelled `quiet`
 *         everywhere now, which is what lets a plugin keep out of it. `generateRawData` in
 *         `public/script.js`. It also stops a raw text-completion request from replacing the captured
 *         instruct envelope with nothing, which `context.generate({wrap: true})` reads as an old client.
 *         And the other half of the same rule: a plugin tells a reply from a background request by the
 *         window of recent turns, so a reply must always carry one. The startup request that tells the client
 *         how many turns to send was remembered even when it failed, which left every reply window-less until
 *         the page was reloaded. A failure is now asked again at the next generation, and the plugin buttons,
 *         which were lost to the same failed request, ask again when a chat is opened.
 *         `public/scripts/plugin-client-config.js`, `public/scripts/plugin-panels.js`.
 * ⚠️ Bump this when the fork ships a feature, not when a plugin does.
 *
 * Increment this version whenever a shipped fork change alters behavior, including defensive fixes. Update
 * it in the same change so the shipped version remains aligned with the code.
 * @type {string}
 */
export const FORK_VERSION = '1.8';

/**
 * Composes the version this fork actually is: upstream's number with our identity appended as semver
 * BUILD METADATA — `1.18.0+taproom.1.3`.
 *
 * 🔴 The upstream base is passed in and never edited here. It stays the raw value from `package.json`,
 * which is upstream's file to bump, so the next `git merge upstream` moves `1.18.0` for free and our tag +
 * counter ride along unchanged.
 *
 * ⚠️ After `+` (build metadata, sorts EQUAL to the base) and not after `-` (prerelease, sorts BELOW it), on
 * purpose: we are ahead of stock 1.18.0, not behind it.
 * @param {string} pkgVersion The raw upstream version from package.json
 * @returns {string} The full fork version string
 */
export function composeForkVersion(pkgVersion) {
    return `${pkgVersion}+${FORK_TAG}.${FORK_VERSION}`;
}
