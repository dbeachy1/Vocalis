/**
 * Express route handlers for /tools endpoints.
 */

import type { McpManager } from '../mcp-manager.js';
import { normal, safeErrorFacts, sensitive } from '../log.js';

interface Req { body: Record<string, unknown> }
interface Res { json(data: unknown): void; status(code: number): Res }

export interface ToolRouteHandlers {
  list(req: Req, res: Res): Promise<void>;
  call(req: Req, res: Res): Promise<void>;
}

export function createToolRoutes(manager: McpManager): ToolRouteHandlers {
  return {
    async list(_req, res) {
      const tools = manager.getAllTools();
      res.json({ tools });
    },

    async call(req, res) {
      const { serverId, toolName, arguments: args } = req.body as {
        serverId?: string;
        toolName?: string;
        arguments?: Record<string, unknown>;
      };

      if (!serverId || !toolName) {
        res.status(400).json({ error: 'serverId and toolName are required' });
        return;
      }

      try {
        const result = await manager.callTool(serverId, toolName, args ?? {});
        res.json({
          content: result.content,
          structuredContent: result.structuredContent,
          isError: result.isError,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Downstream (Vocalis, October 10, 2026): a failed tool call leaves a trace; NORMAL carries class and code only.
        const { errorClass, errorCode } = safeErrorFacts(err);
        normal().warn(`[MCP Client] tools/call: failed (${errorClass}, code ${errorCode}) (500)`);
        sensitive().warn(`[MCP Client] tools/call: '${toolName}' on '${serverId}' failed: ${message}`);
        res.status(500).json({ error: message });
      }
    },
  };
}
