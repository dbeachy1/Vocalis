/**
 * Express route handlers for /config endpoints.
 * Handles reading/writing the persistent mcp-servers.json configuration.
 *
 * Downstream changes (Vocalis, October 10, 2026; see DOWNSTREAM-CHANGES.md):
 *  - get returns every header (and env) value masked; names are kept.
 *  - set keeps the stored secret for any header (or env) value that comes back as the mask, unless the server was
 *    re-pointed (its type or url changed), in which case that masked value is dropped.
 *  - set writes atomically (temporary file in the same folder, then rename) with mode 0600.
 *  - Both routes are registered admin-only in index.ts (requireAdmin); the handlers themselves do not know the user.
 *  - Logging goes through the fork's classified logger (log.ts): NORMAL carries counts and error class/code only;
 *    server ids, header names and error messages are SENSITIVE.
 */

import fs from 'fs/promises';
import type { McpServerConfig } from '../types.js';
import { maskServerConfig, restoreMaskedSecrets, writeFileAtomic } from '../hardening.js';
import { errorMessage, normal, safeErrorFacts, sensitive } from '../log.js';

export interface ConfigRouteHandlers {
  get(req: unknown, res: { json(data: unknown): void; status(code: number): any }): Promise<void>;
  set(req: { body: Record<string, unknown> }, res: { json(data: unknown): void; status(code: number): any }): Promise<void>;
}

/** Reads the stored server list; a missing file is an empty list, an unreadable or invalid one is logged and empty. */
async function readStoredServers(configPath: string): Promise<McpServerConfig[]> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as { servers?: unknown };
    return Array.isArray(config?.servers) ? (config.servers as McpServerConfig[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      const { errorClass, errorCode } = safeErrorFacts(err);
      normal().warn(`[MCP Client] Could not read the server list for config (${errorClass}, code ${errorCode})`);
      // A JSON.parse message quotes the file, so the message is SENSITIVE.
      sensitive().warn(`[MCP Client] Server list read failure: ${errorMessage(err)}`);
    }
    return [];
  }
}

export function createConfigRoutes(configPath: string): ConfigRouteHandlers {
  return {
    async get(_req, res) {
      const servers = (await readStoredServers(configPath)).map((s) => maskServerConfig(s));
      normal().info(`[MCP Client] config/get: ${servers.length} server(s), header values masked`);
      res.json({ servers });
    },

    async set(req, res) {
      const { servers } = req.body as { servers?: McpServerConfig[] };
      if (!Array.isArray(servers)) {
        normal().warn('[MCP Client] config/set: refused, no servers array (400)');
        res.status(400).json({ error: 'servers array is required' });
        return;
      }
      try {
        const existing = await readStoredServers(configPath);
        const { servers: merged, restored, dropped, repointed } = restoreMaskedSecrets(servers, existing);
        await writeFileAtomic(configPath, JSON.stringify({ servers: merged }, null, 2));
        normal().info(
          `[MCP Client] config/set: saved ${merged.length} server(s) (was ${existing.length}); `
          + `${restored} masked secret(s) kept, ${dropped.length} masked value(s) dropped, ${repointed.length} server(s) re-pointed`,
        );
        if (dropped.length || repointed.length) {
          // Server ids and header names are admin-authored labels.
          sensitive().info(`[MCP Client] config/set: dropped [${dropped.join(', ')}]; re-pointed [${repointed.join(', ')}]`);
        }
        res.json({ ok: true });
      } catch (err) {
        const { errorClass, errorCode } = safeErrorFacts(err);
        normal().error(`[MCP Client] config/set failed (${errorClass}, code ${errorCode}) (500)`);
        // A filesystem error message names the path.
        sensitive().error(`[MCP Client] config/set failure: ${errorMessage(err)}`);
        res.status(500).json({ error: errorMessage(err) });
      }
    },
  };
}
