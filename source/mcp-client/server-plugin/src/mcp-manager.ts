/**
 * MCP Connection Manager.
 * Manages connections to multiple MCP servers using the official MCP SDK.
 *
 * Downstream change (Vocalis, October 10, 2026; see DOWNSTREAM-CHANGES.md): HTTP transports only. `addServer` refuses
 * every transport but `streamable-http`, and the SDK's stdio client is no longer imported or constructed.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  McpServerConfig,
  McpServerState,
  McpToolDefinition,
  McpToolResult,
  McpResource,
  McpResourceContent,
  McpPrompt,
  McpPromptMessage,
  ConnectionStatus,
  ServerCapabilities,
  ToolResultContent,
} from './types.js';
import { isHttpTransport, transportRefusal } from './hardening.js';
import { normal, safeErrorFacts, sensitive } from './log.js';

// ============================================================
// Types
// ============================================================

/** Minimal interface matching the MCP SDK Client methods we use. */
export interface IMcpClient {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  getServerCapabilities(): ServerCapabilities | undefined;
  listTools(params?: { cursor?: string }): Promise<{ tools: McpToolDefinition[]; nextCursor?: string }>;
  listResources(params?: { cursor?: string }): Promise<{ resources: McpResource[]; nextCursor?: string }>;
  listPrompts(params?: { cursor?: string }): Promise<{ prompts: McpPrompt[]; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content: ToolResultContent[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
  readResource(params: { uri: string }): Promise<{ contents: McpResourceContent[] }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<{
    messages: McpPromptMessage[];
    description?: string;
  }>;
  setNotificationHandler?(method: string, handler: (...args: unknown[]) => void): void;
}

export type ClientFactory = (config: McpServerConfig) => IMcpClient;

// ============================================================
// Internal state per server
// ============================================================

interface ServerEntry {
  config: McpServerConfig;
  status: ConnectionStatus;
  error?: string;
  client?: IMcpClient;
  transport?: StreamableHTTPClientTransport;
  capabilities?: ServerCapabilities;
  tools: McpToolDefinition[];
  resources: McpResource[];
  prompts: McpPrompt[];
}

// ============================================================
// McpManager
// ============================================================

export class McpManager {
  private _servers = new Map<string, ServerEntry>();
  private _clientFactory: ClientFactory | null = null;

  /** Inject a mock/custom client factory (for testing or custom transports). */
  _setClientFactory(factory: ClientFactory): void {
    this._clientFactory = factory;
  }

  // ---- Server CRUD ----

  addServer(config: McpServerConfig): void {
    // Downstream (Vocalis, October 10, 2026): HTTP transports only. A `stdio` server would start an arbitrary
    // command inside the Taproom container, which holds every unlocked vault. Refused here, so the add route and the
    // loading of an existing config entry share one rule.
    if (!isHttpTransport(config.transport)) {
      throw new Error(transportRefusal(config.transport));
    }
    if (this._servers.has(config.id)) {
      throw new Error(`Server '${config.id}' already exists`);
    }
    this._servers.set(config.id, {
      config,
      status: 'disconnected',
      tools: [],
      resources: [],
      prompts: [],
    });
  }

  removeServer(id: string): void {
    const entry = this._servers.get(id);
    if (entry?.client && entry.status === 'connected') {
      entry.client.close().catch(() => {});
    }
    this._servers.delete(id);
  }

  getServers(): McpServerState[] {
    return Array.from(this._servers.values()).map(e => this._toState(e));
  }

  getServerState(id: string): McpServerState | undefined {
    const entry = this._servers.get(id);
    return entry ? this._toState(entry) : undefined;
  }

  // ---- Connect / Disconnect ----

  async connect(id: string): Promise<void> {
    const entry = this._servers.get(id);
    if (!entry) throw new Error(`Server '${id}' not found`);

    const started = Date.now();
    entry.status = 'connecting';
    entry.error = undefined;

    try {
      if (this._clientFactory) {
        // Use injected factory (tests or custom)
        const client = this._clientFactory(entry.config);
        entry.client = client;
        await client.connect(entry.config.transport);
      } else {
        // Use real MCP SDK
        const { client, transport } = this._createRealClient(entry.config);
        entry.client = client as unknown as IMcpClient;
        entry.transport = transport;
        await client.connect(transport);
      }

      entry.capabilities = entry.client.getServerCapabilities() ?? {};
      entry.status = 'connected';

      // Fetch initial lists
      await this._refreshLists(entry);
      // Downstream (Vocalis, October 10, 2026): a connection leaves a trace. NORMAL carries counts only.
      normal().info(
        `[MCP Client] connect: connected, ${entry.tools.length} tool(s), ${entry.resources.length} resource(s), `
        + `${entry.prompts.length} prompt(s) (${Date.now() - started} ms)`,
      );
      sensitive().info(`[MCP Client] connect: '${id}' connected`);
    } catch (err) {
      entry.status = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
      entry.client = undefined;
      entry.transport = undefined;
      // Class and code only in NORMAL: the message can carry the server URL or a token. Id and message are SENSITIVE.
      const { errorClass, errorCode } = safeErrorFacts(err);
      normal().warn(`[MCP Client] connect: failed (${errorClass}, code ${errorCode}) after ${Date.now() - started} ms`);
      sensitive().warn(`[MCP Client] connect: '${id}' failed: ${entry.error}`);
    }
  }

  async disconnect(id: string): Promise<void> {
    const entry = this._servers.get(id);
    if (!entry) return;

    if (entry.client) {
      try { await entry.client.close(); } catch { /* best-effort */ }
    }

    entry.status = 'disconnected';
    entry.client = undefined;
    entry.transport = undefined;
    entry.tools = [];
    entry.resources = [];
    entry.prompts = [];
  }

  async shutdownAll(): Promise<void> {
    const ids = Array.from(this._servers.keys());
    await Promise.allSettled(ids.map(id => this.disconnect(id)));
  }

  // ---- Aggregation ----

  getAllTools(): Array<McpToolDefinition & { serverId: string }> {
    const result: Array<McpToolDefinition & { serverId: string }> = [];
    for (const [id, entry] of this._servers) {
      if (entry.status === 'connected') {
        for (const tool of entry.tools) {
          result.push({ ...tool, serverId: id });
        }
      }
    }
    return result;
  }

  getAllResources(): Array<McpResource & { serverId: string }> {
    const result: Array<McpResource & { serverId: string }> = [];
    for (const [id, entry] of this._servers) {
      if (entry.status === 'connected') {
        for (const res of entry.resources) {
          result.push({ ...res, serverId: id });
        }
      }
    }
    return result;
  }

  getAllPrompts(): Array<McpPrompt & { serverId: string }> {
    const result: Array<McpPrompt & { serverId: string }> = [];
    for (const [id, entry] of this._servers) {
      if (entry.status === 'connected') {
        for (const prompt of entry.prompts) {
          result.push({ ...prompt, serverId: id });
        }
      }
    }
    return result;
  }

  // ---- Operations ----

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const entry = this._servers.get(serverId);
    if (!entry?.client || entry.status !== 'connected') {
      throw new Error(`Server '${serverId}' not connected`);
    }

    const result = await entry.client.callTool({
      name: toolName,
      arguments: args,
    });

    return {
      content: result.content as ToolResultContent[],
      structuredContent: result.structuredContent,
      isError: result.isError,
    };
  }

  async readResource(serverId: string, uri: string): Promise<McpResourceContent[]> {
    const entry = this._servers.get(serverId);
    if (!entry?.client || entry.status !== 'connected') {
      throw new Error(`Server '${serverId}' not connected`);
    }
    const result = await entry.client.readResource({ uri });
    return result.contents as McpResourceContent[];
  }

  async getPrompt(
    serverId: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<{ messages: McpPromptMessage[]; description?: string }> {
    const entry = this._servers.get(serverId);
    if (!entry?.client || entry.status !== 'connected') {
      throw new Error(`Server '${serverId}' not connected`);
    }
    return entry.client.getPrompt({ name: promptName, arguments: args }) as any;
  }

  // ---- Real MCP SDK Client creation ----

  private _createRealClient(config: McpServerConfig) {
    const client = new Client(
      { name: 'sillytavern-mcp-client', version: '0.1.0' },
      { capabilities: { roots: { listChanged: true } } },
    );

    let transport: StreamableHTTPClientTransport;

    // Downstream (Vocalis, October 10, 2026): the upstream `stdio` branch (StdioClientTransport) is removed, not just
    // unreachable, so this build cannot start a command even if a refused entry were ever to reach here.
    if (config.transport.type === 'streamable-http') {
      transport = new StreamableHTTPClientTransport(
        new URL(config.transport.url),
        {
          requestInit: {
            headers: config.transport.headers ?? {},
          },
        },
      );
    } else {
      throw new Error(`Unsupported transport type: '${(config.transport as any).type}'.`);
    }

    return { client, transport };
  }

  // ---- Internal ----

  private async _refreshLists(entry: ServerEntry): Promise<void> {
    if (!entry.client) return;

    // Downstream (Vocalis, October 10, 2026): upstream swallowed every list failure, so a server whose tool list
    // could not be read showed as "connected, 0 tools" with no trace of why (found live against a real server).
    // Each failure is now logged: kind, error class and code in NORMAL; the message (it can carry the URL) in
    // SENSITIVE. A server that does not advertise resources or prompts is not asked for them.
    const caps = entry.capabilities ?? {};
    const note = (kind: string, err: unknown) => {
      const { errorClass, errorCode } = safeErrorFacts(err);
      normal().warn(`[MCP Client] list ${kind}: failed (${errorClass}, code ${errorCode}); treating it as empty`);
      sensitive().warn(`[MCP Client] list ${kind}: '${entry.config.id}' failed: ${err instanceof Error ? err.message : String(err)}`);
    };

    try {
      const toolsResult = await entry.client.listTools();
      entry.tools = toolsResult.tools as McpToolDefinition[];
    } catch (err) { entry.tools = []; note('tools', err); }

    if (caps.resources) {
      try {
        const resourcesResult = await entry.client.listResources();
        entry.resources = resourcesResult.resources as McpResource[];
      } catch (err) { entry.resources = []; note('resources', err); }
    } else {
      entry.resources = [];
    }

    if (caps.prompts) {
      try {
        const promptsResult = await entry.client.listPrompts();
        entry.prompts = promptsResult.prompts as McpPrompt[];
      } catch (err) { entry.prompts = []; note('prompts', err); }
    } else {
      entry.prompts = [];
    }
  }

  private _toState(entry: ServerEntry): McpServerState {
    return {
      config: entry.config,
      status: entry.status,
      error: entry.error,
      capabilities: entry.capabilities,
      tools: entry.tools,
      resources: entry.resources,
      prompts: entry.prompts,
    };
  }
}
