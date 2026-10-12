# Downstream changes to sillytavern-mcp-client (Vocalis build)

This tree is `Moeblack/sillytavern-mcp-client` at commit `745ff270266baac57d0b428c12702518370b0ac0`
(`refactor: restructure for URL-install support`, version 0.1.0, GNU AGPL version 3, see `LICENSE`),
imported on October 10, 2026 and modified for the Vocalis Taproom image. This file is the notice of
those modifications (AGPL-3.0 section 5(a)) and records the provenance. The per-file hashes of what
was imported were recorded at import time, in the maintainers' own import record (not part of this
repository). Upstream's code is the work of its author (Moeblack); the changes below are Douglas Beachy's and
are released under the same license.

## Not imported

Build output that upstream committed: `dist/index.iife.js` and `.map`, and `plugin/index.js`, `.map`
and `index.d.ts` (the server bundle). The Taproom image build produces both from this source and
`package-lock.json` (`npm ci`, then `npm run build`); nothing built is committed.

## Why the changes

The plugin runs inside the Taproom container, which holds every user's unlocked vault. Upstream lets
any logged-in account read the whole server list (including each server's `Authorization` header)
through `config/get`, add servers, and add a `stdio` server that the plugin then starts as a command
inside that container (`server-plugin/src/index.ts`, the route table, and the stdio client in
`server-plugin/src/mcp-manager.ts`).

## Changes

1. **ESM entry shim** (`plugin/index.js`, `plugin/package.json`, `tsup.config.ts`, `.gitignore`).
   The committed `plugin/index.js` is a small shim, not upstream's bundle. It defines `require` with
   `createRequire` (the bundle contains CommonJS code that calls `require`), then loads the bundle
   with a dynamic import and re-exports `info`, `init` and `exit`. `tsup.config.ts` names the bundle
   `plugin/index.bundle.js` so the two do not collide; `plugin/package.json` marks the folder as an
   ES module package with `main: index.js`. `.gitignore` keeps the build output out of the tree.
2. **Server list path** (`server-plugin/src/index.ts`, `server-plugin/src/hardening.ts`). The path
   comes from the environment variable `TAPROOM_MCP_CONFIG` (Compose sets
   `/etc/taproom/mcp-servers.json`, in the install folder, because the folder beside the plugin is
   read-only in the image). When it is unset or blank, upstream's path (`../mcp-servers.json` beside
   the plugin folder) is used.
3. **Admin-only routes** (`server-plugin/src/index.ts`, `hardening.ts` `requireAdmin`). Every route that
   reads or changes configuration, or adds, removes, connects or disconnects a server, is registered
   behind a middleware that passes only a user whose `profile.admin` is true (the field Taproom's own
   admin middleware checks): `/servers/list`, `/servers/add`, `/servers/remove`, `/servers/connect`,
   `/servers/disconnect`, `/config/get`, `/config/set`. A refusal answers 403 and is logged with the
   route and the user handle. Tool, resource and prompt routes are unchanged (open to any logged-in
   account); item 9 adds the open `/servers/status`.
4. **HTTP transports only** (`server-plugin/src/mcp-manager.ts`, `index.ts`, `routes/servers.ts`).
   `McpManager.addServer` refuses every transport but `streamable-http`; that one rule covers the add
   route (400) and the loading of an existing config entry (logged and skipped, the other entries
   still load). The SDK's stdio client is no longer imported or constructed. `config/set` still saves
   what it is given, so an old file's stdio entries are kept, not silently deleted. The unused
   `server-plugin/src/transports/stdio.ts` and its test are left as upstream (not imported by the plugin).
5. **Secrets masked** (`server-plugin/src/hardening.ts`, `routes/config.ts`, `routes/servers.ts`).
   `config/get` and `servers/list` return every header value (and every `stdio` env value) as
   `********`, names kept. A `config/set` whose value is still the mask keeps the value already stored
   for the same server id and name; a masked value with nothing stored is dropped and logged, never
   written as the secret; any other value is a new secret and replaces the stored one.
6. **Atomic, private writes** (`server-plugin/src/hardening.ts`, `routes/config.ts`). The server list is
   written to a uniquely named temporary file in the same folder (created exclusively with mode 0600,
   flushed), then renamed over the target; a failure removes the temporary file and leaves the old file.
7. **Logging through Taproom's classified logger** (`server-plugin/src/log.ts`, used by every module).
   Taproom's console seam classifies every bare `console.*` line from a plugin as SENSITIVE, which a
   default install suppresses, so the plugin's diagnostics were invisible (found live on the Linux test
   machine). `init(router, context)` now adopts `context.logger` and `context.LogClass` the way the
   Mnemosyne plugin does (both must be present with all four methods and both class values, otherwise a
   fall back to `console`; the class values come from the fork; methods are `.bind()`-bound, never
   wrapped, so the fork captures the real call site). NORMAL lines carry only content-free facts: which
   source the server list came from (the variable name, not the path), counts (loaded, added, refused for
   a non-HTTP transport, duplicates, disabled, connected tools/resources/prompts, saved, kept, dropped,
   re-pointed), durations, route refusals (403 on an admin-only route, 400 on a refused transport), and
   the error CLASS and CODE of a failed connection, tool call or save (identifier-shaped only; the
   message is never NORMAL). Server ids and names, URLs, header names, handles, paths and error
   messages are SENSITIVE (written only with `logging.debugMode`). No line carries a header value, an
   env value or a request body. Also: `servers/connect` now masks the config inside the state it
   returns, as `servers/list` does.
8. **Tests.** `server-plugin/__tests__/hardening.test.ts` is new (path, admin, non-admin parity, stdio,
   masking, atomic write); `extension/__tests__/backend.test.ts` is new (item 9). `server-plugin/__tests__/mcp-manager.test.ts`: its fixtures used `stdio` servers, now
   `streamable-http` ones, because stdio is refused. Run with `npx vitest run`.

9. **Non-admin parity** (`server-plugin/src/index.ts`, `routes/servers.ts`, `extension/src/backend.ts`,
   `extension/src/index.ts`). On a standalone install every account uses the tools of the servers an
   administrator configured; only configuration is the administrator's. Upstream's extension probed
   `/servers/list` at start-up and counted servers from it, which item 3 makes administrator-only, so a
   non-admin account's extension would never have initialized. Now:
   - a new route `/servers/status` is open to every logged-in account and returns `id`, `name` and
     `status` per server only (no URL, no headers, no error text);
   - the extension's start-up probe calls `/tools/list` (open), and its status line (`N/M servers
     connected`) calls `/servers/status`; both live in `extension/src/backend.ts`, which
     `extension/__tests__/backend.test.ts` tests against a stand-in whose administrator-only routes
     answer 403;
   - in the settings panel, a 403 from `/servers/list` shows "Servers are configured by an administrator.
     Their tools are available to your account." and a 403 on Add Server says only an administrator can
     add or change servers.
   `index.ts` of the extension is otherwise upstream's except item 10.
10. **Add Server example** (`extension/src/index.ts`). The "Add Server (JSON)" prompt pre-fills an example;
    upstream's was a `stdio` server, which this build refuses. It is now a `streamable-http` example (`url`
    and an `Authorization` header placeholder).
11. **Re-pointed servers keep no old secrets** (`server-plugin/src/hardening.ts`, item 5). A masked header
    (or env) value is restored from the stored entry only when the stored and the incoming transport have
    the same `type`, `url` and (legacy stdio) `command`. A save that re-points a server under an existing
    id would otherwise carry its stored token to the new destination; the masked value is dropped and
    logged instead (the new destination needs its secret entered again).
12. **List failures are logged, and unadvertised lists are not requested** (`server-plugin/src/mcp-manager.ts`,
    `_refreshLists`). Upstream caught and discarded every failure to read a server's tools, resources or
    prompts, so a server whose tool list could not be read showed as "connected, 0 tools" with no trace of
    why (found live on October 10, 2026). Each failure now logs its kind with the error class and code
    (NORMAL) and the message (SENSITIVE: it can carry the URL). Resources and prompts are requested only
    when the server advertises them, so a tools-only server no longer produces two expected failures.
13. **Skipped server-list entries are reported** (`server-plugin/src/index.ts`, `hardening.ts`
    `skippedEntriesNote`, `routes/servers.ts`, `extension/src/index.ts`, `README.md`; October 11, 2026). An
    existing `mcp-servers.json` entry with a non-HTTP transport (in practice `stdio`) was skipped at load
    with only a count in the log, and the panel said "No servers." The load now remembers each skipped
    entry, logs the count and the reason (NORMAL) and each id with its transport (SENSITIVE), the admin-only
    `/servers/list` returns them as `skipped` and one sentence as `skippedNote`, and the panel shows that
    sentence (with the entries' names) beside the list. The README opens with a note that this build
    supports HTTP servers only. The entries stay in the file; nothing is deleted.
