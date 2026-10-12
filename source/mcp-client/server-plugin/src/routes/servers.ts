/**
 * Express route handlers for /servers endpoints.
 *
 * Downstream changes (Vocalis, October 10, 2026; see DOWNSTREAM-CHANGES.md): `list` masks header values; `add` logs
 * and relays the manager's refusal of a non-HTTP transport. All five routes are registered admin-only in index.ts.
 * October 11, 2026 (pre-release audit): `list` also returns `skipped` (the entries of the existing server list that
 * this build skipped at load because their transport is not HTTP) and `skippedNote` (one sentence saying so), so the
 * page can say why the list is empty or short.
 */

import type { McpManager } from '../mcp-manager.js';
import type { McpServerConfig } from '../types.js';
import { isHttpTransport, maskServerConfig, skippedEntriesNote, type SkippedEntry } from '../hardening.js';
import { errorMessage, normal, safeErrorFacts, sensitive } from '../log.js';

interface Req { body: Record<string, unknown> }
interface Res { json(data: unknown): void; status(code: number): Res }

export interface ServerRouteHandlers {
  list(req: Req, res: Res): Promise<void>;
  status(req: Req, res: Res): Promise<void>;
  add(req: Req, res: Res): Promise<void>;
  remove(req: Req, res: Res): Promise<void>;
  connect(req: Req, res: Res): Promise<void>;
  disconnect(req: Req, res: Res): Promise<void>;
}

export function createServerRoutes(manager: McpManager, getSkipped: () => SkippedEntry[] = () => []): ServerRouteHandlers {
  return {
    async list(_req, res) {
      // Downstream (Vocalis, October 10, 2026): header values never leave the server, not even to an admin's browser.
      const servers = manager.getServers().map((state) => ({ ...state, config: maskServerConfig(state.config) }));
      const skipped = getSkipped();
      res.json({ servers, skipped, skippedNote: skippedEntriesNote(skipped) });
    },

    // Downstream (Vocalis, October 10, 2026): the one /servers route open to every logged-in account. Id, name and
    // connection status only: no URL, no headers, no error text (an error message can carry a URL or a token), so a
    // non-admin extension can show "N/M servers connected" without any configuration.
    async status(_req, res) {
      const servers = manager.getServers().map((state) => ({
        id: state.config.id,
        name: state.config.name,
        status: state.status,
      }));
      res.json({ servers });
    },

    async add(req, res) {
      const config = req.body as unknown as McpServerConfig;
      if (!config.id || !config.name || !config.transport) {
        res.status(400).json({ error: 'id, name, and transport are required' });
        return;
      }
      try {
        // Downstream (Vocalis, October 10, 2026): addServer refuses every transport but streamable-http.
        manager.addServer(config);
        normal().info('[MCP Client] servers/add: added a streamable-http server');
        sensitive().info(`[MCP Client] servers/add: added '${config.id}'`);
        res.json({ ok: true });
      } catch (err) {
        const message = errorMessage(err);
        // The reason is one of two: a transport this build refuses, or anything else (a duplicate id). The transport
        // type is admin-supplied text, so only the category is NORMAL; the id and the message are SENSITIVE.
        const reason = isHttpTransport(config.transport) ? 'rejected (duplicate id or invalid)' : 'non-HTTP transport refused';
        normal().warn(`[MCP Client] servers/add: ${reason} (400)`);
        sensitive().warn(`[MCP Client] servers/add: refused '${config.id}': ${message}`);
        res.status(400).json({ error: message });
      }
    },

    async remove(req, res) {
      const { id } = req.body as { id?: string };
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      manager.removeServer(id);
      res.json({ ok: true });
    },

    async connect(req, res) {
      const { id } = req.body as { id?: string };
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      try {
        await manager.connect(id);
        // Downstream (Vocalis, October 10, 2026): the state embeds the server's config, so it is masked like the list.
        const state = manager.getServerState(id);
        normal().info(`[MCP Client] servers/connect: status ${state?.status ?? 'unknown'}`);
        res.json({ ok: true, state: state ? { ...state, config: maskServerConfig(state.config) } : state });
      } catch (err) {
        const message = errorMessage(err);
        const { errorClass, errorCode } = safeErrorFacts(err);
        normal().warn(`[MCP Client] servers/connect: failed (${errorClass}, code ${errorCode}) (500)`);
        sensitive().warn(`[MCP Client] servers/connect: failure for '${id}': ${message}`);
        res.status(500).json({ error: message });
      }
    },

    async disconnect(req, res) {
      const { id } = req.body as { id?: string };
      if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
      }
      await manager.disconnect(id);
      res.json({ ok: true });
    },
  };
}
