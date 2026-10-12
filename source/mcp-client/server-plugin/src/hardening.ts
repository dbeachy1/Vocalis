/**
 * Downstream addition (Vocalis, October 10, 2026). NOT part of upstream Moeblack/sillytavern-mcp-client (745ff27).
 * See DOWNSTREAM-CHANGES.md at the root of this source tree for the full list and the reasons.
 *
 * Why this file exists: the plugin runs inside the Taproom container, which holds every user's unlocked vault.
 * Upstream lets any logged-in account read the whole server list (including each server's Authorization header)
 * through `config/get`, add servers, and add a `stdio` server that the plugin then starts as a command inside
 * the container. These helpers close that, and keep the secrets-bearing server list safe on disk.
 *
 *  - requireAdmin:          Express middleware; only an administrator account passes (Taproom's own rule).
 *  - isHttpTransport:       the only transport this build runs (`streamable-http`).
 *  - maskServerConfig:      returns a copy with header (and env) VALUES masked, names kept.
 *  - restoreMaskedSecrets:  on a save, a value that comes back as the mask keeps the stored secret.
 *  - resolveConfigPath:     server-list path from TAPROOM_MCP_CONFIG, upstream's path when unset.
 *  - writeFileAtomic:       temporary file in the same folder, mode 0600, then rename.
 *
 * Nothing here logs a header value, an env value or a request body.
 */

import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import type { McpServerConfig, TransportConfig } from './types.js';
import { normal, sensitive } from './log.js';

/** What a header (or env) value is replaced with when the server list is handed to a browser. */
export const MASKED_SECRET = '********';

/** The environment variable that names the server-list file (Compose sets it to /etc/taproom/mcp-servers.json). */
export const CONFIG_PATH_ENV = 'TAPROOM_MCP_CONFIG';

// ============================================================
// Admin-only routes
// ============================================================

interface AdminRequest {
  user?: { profile?: { admin?: boolean; handle?: string } };
  route?: { path?: unknown };
}

interface AdminResponse {
  sendStatus(code: number): unknown;
}

/**
 * Express middleware: lets the request through only when Taproom's authenticated user is an administrator
 * (`request.user.profile.admin`, the same field Taproom's own `requireAdminMiddleware` checks). A request with no
 * user, or a non-admin user, gets 403 and the handler never runs.
 */
export function requireAdmin(req: AdminRequest, res: AdminResponse, next: () => void): void {
  const admin = Boolean(req.user?.profile?.admin);
  if (!admin) {
    const handle = req.user?.profile?.handle;
    // The route is published only when it is one of this plugin's own registered paths (express's `req.route.path`
    // is the literal we registered, not the request URL); the handle is user-authored, so it goes in a SENSITIVE line.
    const registered = req.route?.path;
    const route = typeof registered === 'string' && /^\/(servers|config)\/[a-z]+$/.test(registered) ? registered : '(unregistered)';
    normal().warn(`[MCP Client] Refused a non-admin request to the admin-only route ${route}: 403`);
    sensitive().warn(`[MCP Client] The refused request to ${route} came from user ${typeof handle === 'string' && handle ? handle : 'none'}`);
    res.sendStatus(403);
    return;
  }
  next();
}

// ============================================================
// Transport policy
// ============================================================

/** True only for a `streamable-http` transport with a string URL. `stdio` and unknown types are refused. */
export function isHttpTransport(transport: unknown): transport is Extract<TransportConfig, { type: 'streamable-http' }> {
  if (!transport || typeof transport !== 'object') return false;
  const t = transport as { type?: unknown; url?: unknown };
  return t.type === 'streamable-http' && typeof t.url === 'string';
}

/** The text of the error for a refused transport (the same text for add and for load). */
export function transportRefusal(transport: unknown): string {
  const type = transport && typeof transport === 'object' ? String((transport as { type?: unknown }).type) : 'none';
  return `Transport '${type}' is not allowed in this build: only streamable-http servers are supported.`;
}

/** An entry of an existing server list that was skipped at load because its transport is not HTTP. */
export interface SkippedEntry {
  id: string;
  name: string;
  /** The transport type as written in the file (`stdio` for every entry upstream could have written). */
  transport: string;
}

/** The transport type of a server-list entry as written in the file, for the skipped-entry report. */
export function transportTypeOf(transport: unknown): string {
  if (!transport || typeof transport !== 'object') return 'none';
  const type = (transport as { type?: unknown }).type;
  return typeof type === 'string' && type ? type : 'none';
}

/**
 * Downstream (Vocalis, October 11, 2026, pre-release audit): the one sentence the administrator's page shows when an
 * existing server list had entries this build skipped, so that "No servers." is not the whole answer. Empty when
 * nothing was skipped. Names are the administrator's own text and the page escapes them; the route that carries this
 * sentence is admin-only.
 */
export function skippedEntriesNote(skipped: SkippedEntry[]): string {
  if (skipped.length === 0) return '';
  const names = skipped.map((entry) => entry.name || entry.id || '(unnamed)').join(', ');
  const types = [...new Set(skipped.map((entry) => entry.transport))];
  const onlyStdio = types.length === 1 && types[0] === 'stdio';
  const count = skipped.length;
  const entries = count === 1 ? '1 entry in the server list was' : `${count} entries in the server list were`;
  const reason = onlyStdio
    ? (count === 1 ? 'it is a stdio server' : 'they are stdio servers')
    : `${count === 1 ? 'it uses' : 'they use'} a transport other than HTTP (${types.join(', ')})`;
  return `${entries} skipped because ${reason}: ${names}. This build supports HTTP (streamable-http) servers only. The entries are still in the server list file and are not deleted.`;
}

// ============================================================
// Secret masking
// ============================================================

type StringMap = Record<string, string>;

function maskMap(map: unknown): StringMap | undefined {
  if (!map || typeof map !== 'object') return undefined;
  const out: StringMap = {};
  for (const name of Object.keys(map as StringMap)) out[name] = MASKED_SECRET;
  return out;
}

/**
 * A deep copy of one server entry with every header value (and every stdio env value, for a legacy entry that
 * still carries one) replaced by {@link MASKED_SECRET}. Header and env NAMES are kept.
 */
export function maskServerConfig<T extends McpServerConfig>(config: T): T {
  const copy = JSON.parse(JSON.stringify(config)) as T;
  const transport = copy.transport as unknown as { headers?: unknown; env?: unknown } | undefined;
  if (transport && typeof transport === 'object') {
    if (transport.headers !== undefined) transport.headers = maskMap(transport.headers);
    if (transport.env !== undefined) transport.env = maskMap(transport.env);
  }
  return copy;
}

export interface RestoreResult {
  servers: McpServerConfig[];
  /** Masked values replaced with the stored secret. */
  restored: number;
  /** Masked values with no stored secret to restore (the header or env entry is dropped, never saved as the mask). */
  dropped: string[];
  /** Ids of servers whose transport type or url changed under an existing id (stored secrets not carried over). The caller logs them. */
  repointed: string[];
}

/**
 * Prepares a save: any header (or env) value that equals the mask is replaced by the value already stored for the
 * same server id and the same name, but ONLY when the stored and the incoming transport point at the same place (equal
 * `type` and `url`, and equal `command` for a legacy stdio entry). A save that re-points a server (a new URL under an
 * existing id) must not carry the stored token to the new destination, so a masked value there is treated like one with
 * nothing stored. When nothing is stored for it, or the target changed, the entry is dropped (so the mask itself is
 * never written as a secret) and reported in `dropped` as `<serverId>:<name>`. Values that differ from the mask are
 * new secrets and are kept as sent.
 */
export function restoreMaskedSecrets(incoming: McpServerConfig[], existing: McpServerConfig[]): RestoreResult {
  const byId = new Map<string, McpServerConfig>();
  for (const server of existing) {
    if (server && typeof server.id === 'string') byId.set(server.id, server);
  }

  let restored = 0;
  const dropped: string[] = [];
  const repointed: string[] = [];

  const servers = incoming.map((server) => {
    const copy = JSON.parse(JSON.stringify(server)) as McpServerConfig;
    const transport = copy.transport as unknown as { headers?: StringMap; env?: StringMap } | undefined;
    const storedTransport = byId.get(copy.id)?.transport as unknown as
      { type?: unknown; url?: unknown; command?: unknown; headers?: StringMap; env?: StringMap } | undefined;
    if (!transport || typeof transport !== 'object') return copy;
    // The stored secrets are usable only when the server still points where it did.
    const incomingTransport = transport as { type?: unknown; url?: unknown; command?: unknown };
    const sameTarget = Boolean(storedTransport)
      && storedTransport!.type === incomingTransport.type
      && storedTransport!.url === incomingTransport.url
      && storedTransport!.command === incomingTransport.command;
    const stored = sameTarget ? storedTransport : undefined;
    if (storedTransport && !sameTarget) repointed.push(copy.id);

    for (const kind of ['headers', 'env'] as const) {
      const map = transport[kind];
      if (!map || typeof map !== 'object') continue;
      for (const name of Object.keys(map)) {
        if (map[name] !== MASKED_SECRET) continue;
        const keep = stored?.[kind]?.[name];
        if (typeof keep === 'string') {
          map[name] = keep;
          restored += 1;
        } else {
          delete map[name];
          dropped.push(`${copy.id}:${name}`);
        }
      }
    }
    return copy;
  });

  return { servers, restored, dropped, repointed };
}

// ============================================================
// Server-list file
// ============================================================

/**
 * The server-list path: the value of TAPROOM_MCP_CONFIG when it is set and non-blank (made absolute), otherwise
 * `fallback` (upstream's path, beside the plugin).
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv, fallback: string): string {
  const configured = env[CONFIG_PATH_ENV]?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    // NORMAL names only the source (the variable name is a constant); the path itself is SENSITIVE.
    normal().info(`[MCP Client] Server list source: ${CONFIG_PATH_ENV}`);
    sensitive().info(`[MCP Client] Server list path: ${resolved}`);
    return resolved;
  }
  normal().info(`[MCP Client] Server list source: upstream default (${CONFIG_PATH_ENV} is not set)`);
  sensitive().info(`[MCP Client] Server list path: ${fallback}`);
  return fallback;
}

/**
 * Writes `data` to `filePath` atomically with mode 0600: a uniquely named temporary file in the SAME folder
 * (created exclusively, mode 0600, flushed to disk), then a rename over the target. A failure removes the
 * temporary file and leaves the previous file untouched. The same folder matters: a rename is atomic only within
 * one filesystem, and Compose binds the whole folder, not the file, for this reason.
 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(data, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, filePath);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}
