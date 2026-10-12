/**
 * SillyTavern Server Plugin entry point.
 * Exports: info, init(router), exit()
 *
 * Downstream changes (Vocalis, October 10, 2026; see DOWNSTREAM-CHANGES.md at the root of this source tree):
 *  - The server list path comes from the TAPROOM_MCP_CONFIG environment variable; upstream's path beside the plugin
 *    is the fallback when it is unset.
 *  - Every route that reads or changes configuration, or adds, removes, connects or disconnects a server
 *    (/servers/* except /servers/status, and /config/*), is registered behind requireAdmin. Tool, resource and prompt
 *    calls stay available to any logged-in account, as upstream, and so does /servers/status (id, name, status only),
 *    which the extension uses so a non-admin account initializes it.
 *  - A `stdio` entry in an existing config file is refused when the file is loaded (McpManager.addServer refuses it),
 *    and the refusal is logged, not swallowed. October 11, 2026 (pre-release audit): each skipped entry is also kept in
 *    `skippedEntries`, named in a SENSITIVE log line with the reason, counted in the NORMAL summary, and returned by the
 *    admin-only `/servers/list` as `skipped` and `skippedNote`, so the page says why the list is empty or short
 *    instead of "No servers."
 *  - `init(router, context)` adopts Taproom's classified logger (context.logger, context.LogClass) via log.ts: NORMAL
 *    lines carry counts and error class/code only; ids, names, URLs, header names, paths and error messages are SENSITIVE.
 */

import type { Router } from 'express';
import { McpManager } from './mcp-manager.js';
import { createToolRoutes } from './routes/tools.js';
import { createResourceRoutes } from './routes/resources.js';
import { createPromptRoutes } from './routes/prompts.js';
import { createServerRoutes } from './routes/servers.js';
import { createConfigRoutes } from './routes/config.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import type { McpClientConfig, McpServerConfig } from './types.js';
import { isHttpTransport, requireAdmin, resolveConfigPath, transportTypeOf, type SkippedEntry } from './hardening.js';
import { adoptLogger, errorMessage, normal, safeErrorFacts, sensitive, type ForkLogContext } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const info = {
  id: 'mcp-client',
  name: 'MCP Client',
  description: 'Model Context Protocol client for SillyTavern — connect to external MCP servers for tools, resources, and prompts.',
};

const manager = new McpManager();
/** Entries of the existing server list that the last load skipped because their transport is not HTTP. */
let skippedEntries: SkippedEntry[] = [];
/** Upstream's server list path (beside the plugin folder); used only when TAPROOM_MCP_CONFIG is unset. */
const upstreamConfigPath = path.join(__dirname, '..', 'mcp-servers.json');

async function loadServersFromConfig(configPath: string): Promise<void> {
  const started = Date.now();
  skippedEntries = [];
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const cfg = JSON.parse(raw) as McpClientConfig;
    const servers = Array.isArray(cfg?.servers) ? cfg.servers : [];

    let added = 0;
    let refusedTransport = 0;
    let duplicates = 0;
    let skippedDisabled = 0;
    for (const server of servers) {
      const s = server as McpServerConfig;
      if (s?.enabled === false) { skippedDisabled += 1; continue; }
      try {
        manager.addServer(s);
        added += 1;
      } catch (err) {
        // Either a transport this build refuses (stdio) or a duplicate id. Both are logged; neither stops the load.
        if (isHttpTransport(s?.transport)) {
          duplicates += 1;
        } else {
          refusedTransport += 1;
          skippedEntries.push({ id: String(s?.id ?? ''), name: String(s?.name ?? ''), transport: transportTypeOf(s?.transport) });
        }
        // The id and the message are admin-authored text (the message names the transport type): SENSITIVE.
        sensitive().warn(`[MCP Client] Not loading server '${s?.id}' from the config: ${errorMessage(err)}`);
      }
    }

    // Auto-connect enabled servers (only those that were actually added)
    const loaded = new Set(manager.getServers().map((state) => state.config.id));
    const toConnect = servers
      .filter((s) => (s as McpServerConfig)?.enabled !== false)
      .filter((s) => (s as McpServerConfig)?.autoConnect)
      .map((s) => (s as McpServerConfig).id)
      .filter((id) => Boolean(id) && loaded.has(id));

    for (const id of toConnect) {
      // best-effort: don't block init if a server fails
      // (McpManager.connect records and logs its own failures; this catch is for anything it did not expect.)
      manager.connect(id).catch((err) => {
        const { errorClass, errorCode } = safeErrorFacts(err);
        normal().warn(`[MCP Client] Auto-connect failed unexpectedly (${errorClass}, code ${errorCode})`);
        sensitive().warn(`[MCP Client] Auto-connect of '${id}' failed: ${errorMessage(err)}`);
      });
    }
    if (skippedEntries.length > 0) {
      // The names are SENSITIVE (admin-authored); the count and the reason are not. The page shows the names to an administrator.
      normal().warn(`[MCP Client] ${skippedEntries.length} server list entr${skippedEntries.length === 1 ? 'y was' : 'ies were'} skipped: this build supports HTTP (streamable-http) servers only and refuses stdio servers`);
      sensitive().warn(`[MCP Client] Skipped (stdio is not supported in this build; HTTP servers only): ${skippedEntries.map((entry) => `'${entry.id}' (${entry.transport})`).join(', ')}`);
    }
    normal().info(
      `[MCP Client] Loaded server list: ${servers.length} entr${servers.length === 1 ? 'y' : 'ies'} in file, `
      + `${added} added, ${refusedTransport} refused (non-HTTP transport), ${duplicates} duplicate, ${skippedDisabled} disabled, `
      + `${toConnect.length} auto-connecting (${Date.now() - started} ms)`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      normal().info('[MCP Client] No server list file yet; starting with no servers.');
    } else {
      const { errorClass, errorCode } = safeErrorFacts(err);
      normal().warn(`[MCP Client] Could not load the server list (${errorClass}, code ${errorCode})`);
      // A JSON.parse message quotes the file, so the message is SENSITIVE.
      sensitive().warn(`[MCP Client] Server list load failure: ${errorMessage(err)}`);
    }
  }
}

export async function init(router: Router, context?: ForkLogContext): Promise<void> {
  // Downstream (Vocalis, October 10, 2026): adopt Taproom's classified logger first, so every line below is classified
  // by this plugin instead of being suppressed wholesale as SENSITIVE. Falls back to console when the context lacks it.
  const classified = adoptLogger(context);
  normal().info(`[MCP Client] Logging: ${classified ? 'Taproom classified logger adopted' : 'console fallback (no classified logger in the plugin context)'}`);

  const configPath = resolveConfigPath(process.env, upstreamConfigPath);

  // Load persistent server list (best-effort)
  await loadServersFromConfig(configPath);

  const toolRoutes = createToolRoutes(manager);
  const resourceRoutes = createResourceRoutes(manager);
  const promptRoutes = createPromptRoutes(manager);
  const serverRoutes = createServerRoutes(manager, () => skippedEntries);
  const configRoutes = createConfigRoutes(configPath);

  // Tools
  router.post('/tools/list', (req, res) => toolRoutes.list(req as any, res as any));
  router.post('/tools/call', (req, res) => toolRoutes.call(req as any, res as any));

  // Resources
  router.post('/resources/list', (req, res) => resourceRoutes.list(req as any, res as any));
  router.post('/resources/read', (req, res) => resourceRoutes.read(req as any, res as any));

  // Prompts
  router.post('/prompts/list', (req, res) => promptRoutes.list(req as any, res as any));
  router.post('/prompts/get', (req, res) => promptRoutes.get(req as any, res as any));

  // Server status: open to every logged-in account (id, name and status only), so a non-admin account's extension can
  // start and show how many of the administrator's servers are connected.
  router.post('/servers/status', (req, res) => serverRoutes.status(req as any, res as any));

  // Servers (admin only: they read the server list, or add, remove, connect or disconnect a server)
  router.post('/servers/list', requireAdmin, (req, res) => serverRoutes.list(req as any, res as any));
  router.post('/servers/add', requireAdmin, (req, res) => serverRoutes.add(req as any, res as any));
  router.post('/servers/remove', requireAdmin, (req, res) => serverRoutes.remove(req as any, res as any));
  router.post('/servers/connect', requireAdmin, (req, res) => serverRoutes.connect(req as any, res as any));
  router.post('/servers/disconnect', requireAdmin, (req, res) => serverRoutes.disconnect(req as any, res as any));

  // Config (admin only: it reads and writes the server list and its secrets)
  router.post('/config/get', requireAdmin, (req, res) => configRoutes.get(req as any, res as any));
  router.post('/config/set', requireAdmin, (req, res) => configRoutes.set(req as any, res as any));

  normal().info('[MCP Client] Plugin initialized. Routes registered at /api/plugins/mcp-client/*');
}

export async function exit(): Promise<void> {
  await manager.shutdownAll();
  normal().info('[MCP Client] Plugin shutdown complete.');
}
