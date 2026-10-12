/**
 * Downstream tests (Vocalis, October 10, 2026) for the Taproom hardening patches; see DOWNSTREAM-CHANGES.md.
 * Not part of upstream Moeblack/sillytavern-mcp-client (745ff27).
 *
 *  (2) server list path from TAPROOM_MCP_CONFIG, upstream's path when unset
 *  (3) every configuration route and every add/connect route is admin-only
 *  (4) stdio refused on add and when an existing config entry is loaded
 *  (5) config/get and servers/list mask header values; a save keeps the stored secret for an unchanged mask
 *  (6) the server list is written atomically with mode 0600
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  MASKED_SECRET,
  isHttpTransport,
  maskServerConfig,
  requireAdmin,
  resolveConfigPath,
  restoreMaskedSecrets,
  skippedEntriesNote,
  writeFileAtomic,
} from '../src/hardening.js';
import { McpManager } from '../src/mcp-manager.js';
import { adoptLogger, normal, resetLogging, safeErrorFacts, sensitive } from '../src/log.js';
import { createConfigRoutes } from '../src/routes/config.js';
import { createServerRoutes } from '../src/routes/servers.js';
import type { McpServerConfig } from '../../shared/types.js';

const SECRET = 'Bearer test-secret-value-1';
const OTHER_SECRET = 'Bearer test-secret-value-2';
const posix = process.platform !== 'win32';

function httpServer(id: string, headers: Record<string, string> = { Authorization: SECRET }): McpServerConfig {
  return { id, name: `Server ${id}`, transport: { type: 'streamable-http', url: `https://mcp.invalid/${id}`, headers }, enabled: true };
}

function stdioServer(id: string): McpServerConfig {
  return { id, name: `Stdio ${id}`, transport: { type: 'stdio', command: 'node', args: ['x.js'], env: { TOKEN: SECRET } }, enabled: true };
}

function makeRes() {
  const res: { statusCode?: number; body?: unknown; sent?: number; json: any; status: any; sendStatus: any } = {
    json: vi.fn((data: unknown) => { res.body = data; return res; }),
    status: vi.fn((code: number) => { res.statusCode = code; return res; }),
    sendStatus: vi.fn((code: number) => { res.sent = code; return res; }),
  };
  return res;
}

type Handler = (req: any, res: any, next: () => void) => unknown;

/** Runs an Express-style handler chain: each handler may call next(); asynchronous handlers are awaited. */
async function invoke(handlers: Handler[], req: Record<string, unknown>) {
  const res = makeRes();
  let index = 0;
  const pending: Promise<unknown>[] = [];
  const next = () => {
    const handler = handlers[index++];
    if (handler) pending.push(Promise.resolve(handler(req, res, next)));
  };
  next();
  while (pending.length) await pending.shift();
  return res;
}

function fakeRouter() {
  const routes = new Map<string, Handler[]>();
  return { routes, post: (route: string, ...handlers: Handler[]) => { routes.set(route, handlers); } };
}

const ADMIN = { user: { profile: { admin: true, handle: 'owner' } }, body: {} };
const MEMBER = { user: { profile: { admin: false, handle: 'friend' } }, body: {} };
const ANONYMOUS = { body: {} };

const ADMIN_ONLY_ROUTES = [
  '/servers/list', '/servers/add', '/servers/remove', '/servers/connect', '/servers/disconnect',
  '/config/get', '/config/set',
];
const OPEN_ROUTES = ['/tools/list', '/tools/call', '/resources/list', '/resources/read', '/prompts/list', '/prompts/get', '/servers/status'];

let dir: string;
let configFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-hardening-'));
  configFile = path.join(dir, 'mcp-servers.json');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  resetLogging();
  vi.restoreAllMocks();
  delete process.env.TAPROOM_MCP_CONFIG;
  await fs.rm(dir, { recursive: true, force: true });
});

/** Loads a fresh copy of the plugin entry (it holds module-level state) and runs init against a fake router. */
async function loadPlugin(context?: unknown) {
  vi.resetModules();
  const mod = await import('../src/index.js');
  // resetModules gives the plugin its own copy of hardening.js; the middleware identity check needs that same copy.
  const freshHardening = await import('../src/hardening.js');
  const router = fakeRouter();
  await mod.init(router as any, context as any);
  return { mod, router, loadedRequireAdmin: freshHardening.requireAdmin };
}

describe('(2) server list path from TAPROOM_MCP_CONFIG', () => {
  it('uses the environment value, made absolute, when it is set', () => {
    const resolved = resolveConfigPath({ TAPROOM_MCP_CONFIG: configFile }, path.join(dir, 'upstream.json'));
    expect(resolved).toBe(path.resolve(configFile));
  });

  it('trims the value and falls back to upstream\'s path when it is unset or blank', () => {
    const fallback = path.join(dir, 'upstream.json');
    expect(resolveConfigPath({}, fallback)).toBe(fallback);
    expect(resolveConfigPath({ TAPROOM_MCP_CONFIG: '   ' }, fallback)).toBe(fallback);
    expect(resolveConfigPath({ TAPROOM_MCP_CONFIG: `  ${configFile}  ` }, fallback)).toBe(path.resolve(configFile));
  });

  it('loads servers from, and saves to, the file the environment names', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [httpServer('from-env')] }));
    process.env.TAPROOM_MCP_CONFIG = configFile;
    const { router } = await loadPlugin();

    const list = await invoke(router.routes.get('/servers/list')!, ADMIN);
    expect((list.body as any).servers.map((s: any) => s.config.id)).toEqual(['from-env']);

    const save = await invoke(router.routes.get('/config/set')!, { ...ADMIN, body: { servers: [httpServer('saved-here')] } });
    expect(save.body).toEqual({ ok: true });
    expect(JSON.parse(await fs.readFile(configFile, 'utf-8')).servers.map((s: any) => s.id)).toEqual(['saved-here']);
  });
});

describe('(3) admin-only routes', () => {
  it('requireAdmin lets an administrator through and refuses a member and an anonymous request with 403', async () => {
    const reached = vi.fn();
    const asAdmin = await invoke([requireAdmin, (_r, res) => { reached('admin'); res.json({}); }], ADMIN);
    expect(reached).toHaveBeenCalledWith('admin');
    expect(asAdmin.sent).toBeUndefined();

    reached.mockClear();
    const asMember = await invoke([requireAdmin, () => reached('member')], MEMBER);
    const asAnonymous = await invoke([requireAdmin, () => reached('anonymous')], ANONYMOUS);
    expect(reached).not.toHaveBeenCalled();
    expect(asMember.sent).toBe(403);
    expect(asAnonymous.sent).toBe(403);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Refused a non-admin request'));
  });

  it('registers requireAdmin first on every servers and config route, and on no other route', async () => {
    const { router, loadedRequireAdmin } = await loadPlugin();
    for (const route of ADMIN_ONLY_ROUTES) {
      const handlers = router.routes.get(route);
      expect(handlers, route).toBeDefined();
      expect(handlers![0], route).toBe(loadedRequireAdmin);
    }
    for (const route of OPEN_ROUTES) {
      const handlers = router.routes.get(route);
      expect(handlers, route).toBeDefined();
      expect(handlers![0], route).not.toBe(loadedRequireAdmin);
    }
    expect(router.routes.size).toBe(ADMIN_ONLY_ROUTES.length + OPEN_ROUTES.length);
  });

  it('refuses a non-admin account on every admin route without touching the server list, and serves an admin', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [httpServer('keep')] }));
    process.env.TAPROOM_MCP_CONFIG = configFile;
    const before = await fs.readFile(configFile, 'utf-8');
    const { router } = await loadPlugin();

    for (const route of ADMIN_ONLY_ROUTES) {
      const body = { id: 'x', name: 'x', transport: { type: 'streamable-http', url: 'https://mcp.invalid/x' }, servers: [] };
      const member = await invoke(router.routes.get(route)!, { ...MEMBER, body });
      expect(member.sent, route).toBe(403);
      expect(member.json, route).not.toHaveBeenCalled();
      const anonymous = await invoke(router.routes.get(route)!, { ...ANONYMOUS, body });
      expect(anonymous.sent, route).toBe(403);
    }
    expect(await fs.readFile(configFile, 'utf-8')).toBe(before);

    const admin = await invoke(router.routes.get('/config/get')!, ADMIN);
    expect((admin.body as any).servers).toHaveLength(1);
  });
});

describe('(3b) non-admin parity: the routes a non-admin extension needs stay open and carry no configuration', () => {
  it('serves tools/list and servers/status to a member, and servers/status shows id, name and status only', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [httpServer('shared')] }));
    process.env.TAPROOM_MCP_CONFIG = configFile;
    const { router } = await loadPlugin();

    const tools = await invoke(router.routes.get('/tools/list')!, MEMBER);
    expect(tools.body).toEqual({ tools: [] });
    expect(tools.sent).toBeUndefined();

    const status = await invoke(router.routes.get('/servers/status')!, MEMBER);
    expect(status.sent).toBeUndefined();
    expect(status.body).toEqual({ servers: [{ id: 'shared', name: 'Server shared', status: 'disconnected' }] });
    const text = JSON.stringify(status.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('mcp.invalid');
    expect(text).not.toContain('Authorization');
  });

  it('servers/status leaves out the error text of a failed server (it can carry a URL or a token)', async () => {
    const manager = new McpManager();
    manager.addServer(httpServer('bad'));
    manager._setClientFactory(() => ({ connect: async () => { throw new Error(`failed https://mcp.invalid/x?token=${SECRET}`); } }) as any);
    await manager.connect('bad');
    const res = makeRes();
    await createServerRoutes(manager).status({ body: {} }, res as any);
    expect(res.body).toEqual({ servers: [{ id: 'bad', name: 'Server bad', status: 'error' }] });
  });
});

describe('(4) stdio is refused', () => {
  it('isHttpTransport accepts only streamable-http with a url', () => {
    expect(isHttpTransport({ type: 'streamable-http', url: 'https://mcp.invalid/x' })).toBe(true);
    expect(isHttpTransport({ type: 'streamable-http' })).toBe(false);
    expect(isHttpTransport({ type: 'stdio', command: 'node' })).toBe(false);
    expect(isHttpTransport({ type: 'sse', url: 'https://mcp.invalid/x' })).toBe(false);
    expect(isHttpTransport(undefined)).toBe(false);
  });

  it('McpManager.addServer refuses stdio and unknown transports and accepts streamable-http', () => {
    const manager = new McpManager();
    expect(() => manager.addServer(stdioServer('s'))).toThrow(/stdio.*not allowed/);
    expect(() => manager.addServer({ id: 'u', name: 'u', transport: { type: 'websocket' } as any })).toThrow(/not allowed/);
    expect(manager.getServers()).toEqual([]);
    manager.addServer(httpServer('h'));
    expect(manager.getServers().map((s) => s.config.id)).toEqual(['h']);
  });

  it('the servers/add route answers 400 for stdio and adds nothing', async () => {
    const manager = new McpManager();
    const routes = createServerRoutes(manager);
    const res = makeRes();
    await routes.add({ body: stdioServer('s') as any }, res as any);
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toMatch(/stdio/);
    expect(manager.getServers()).toEqual([]);
  });

  it('refuses a stdio entry in an existing config file when loading, loads the HTTP entries, and logs the refusal', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [stdioServer('old-stdio'), httpServer('good')] }));
    process.env.TAPROOM_MCP_CONFIG = configFile;
    const { router } = await loadPlugin();

    const list = await invoke(router.routes.get('/servers/list')!, ADMIN);
    expect((list.body as any).servers.map((s: any) => s.config.id)).toEqual(['good']);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Not loading server 'old-stdio'"));
  });

  it('reports each skipped entry: the admin list carries them and one sentence naming them, and the log says why', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [stdioServer('old-stdio'), stdioServer('second'), httpServer('good')] }));
    process.env.TAPROOM_MCP_CONFIG = configFile;
    const { router } = await loadPlugin();

    const list = await invoke(router.routes.get('/servers/list')!, ADMIN);
    const body = list.body as any;
    expect(body.servers.map((s: any) => s.config.id)).toEqual(['good']);
    expect(body.skipped).toEqual([
      { id: 'old-stdio', name: 'Stdio old-stdio', transport: 'stdio' },
      { id: 'second', name: 'Stdio second', transport: 'stdio' },
    ]);
    expect(body.skippedNote).toBe(
      '2 entries in the server list were skipped because they are stdio servers: Stdio old-stdio, Stdio second. '
      + 'This build supports HTTP (streamable-http) servers only. The entries are still in the server list file and are not deleted.',
    );
    // The count and the reason in the summary; each skipped entry named, with the reason, in the line that may name it.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('2 server list entries were skipped: this build supports HTTP (streamable-http) servers only and refuses stdio servers'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Not loading server 'old-stdio' from the config: Transport 'stdio' is not allowed in this build: only streamable-http servers are supported."));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Skipped (stdio is not supported in this build; HTTP servers only): 'old-stdio' (stdio), 'second' (stdio)"));
  });

  it('reports nothing when nothing was skipped, and the note is empty', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [httpServer('good')] }));
    process.env.TAPROOM_MCP_CONFIG = configFile;
    const { router } = await loadPlugin();

    const list = await invoke(router.routes.get('/servers/list')!, ADMIN);
    expect((list.body as any).skipped).toEqual([]);
    expect((list.body as any).skippedNote).toBe('');
    expect(skippedEntriesNote([])).toBe('');
  });

  it('skippedEntriesNote reads right for one entry and for a transport other than stdio', () => {
    expect(skippedEntriesNote([{ id: 'a', name: 'Alpha', transport: 'stdio' }]))
      .toMatch(/^1 entry in the server list was skipped because it is a stdio server: Alpha\. /);
    expect(skippedEntriesNote([{ id: 'a', name: '', transport: 'sse' }, { id: 'b', name: 'Beta', transport: 'stdio' }]))
      .toMatch(/^2 entries in the server list were skipped because they use a transport other than HTTP \(sse, stdio\): a, Beta\. /);
  });

  it('keeps a refused stdio entry in the file when another server is saved (nothing is silently dropped)', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [stdioServer('old-stdio')] }));
    const routes = createConfigRoutes(configFile);
    const current = makeRes();
    await routes.get({}, current);
    const servers = [...(current.body as any).servers, httpServer('new')];
    await routes.set({ body: { servers } }, makeRes());
    const stored = JSON.parse(await fs.readFile(configFile, 'utf-8')).servers;
    expect(stored.map((s: any) => s.id)).toEqual(['old-stdio', 'new']);
    // The stdio entry's env secret was masked on the way out and restored on the way back in.
    expect(stored[0].transport.env.TOKEN).toBe(SECRET);
  });
});

describe('(5) masking', () => {
  it('maskServerConfig masks header and env values, keeps their names, and does not touch the original', () => {
    const original = httpServer('a', { Authorization: SECRET, 'X-Other': 'abc' });
    const masked = maskServerConfig(original);
    expect(masked.transport).toEqual({
      type: 'streamable-http',
      url: 'https://mcp.invalid/a',
      headers: { Authorization: MASKED_SECRET, 'X-Other': MASKED_SECRET },
    });
    expect((original.transport as any).headers.Authorization).toBe(SECRET);
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect((maskServerConfig(stdioServer('s')).transport as any).env).toEqual({ TOKEN: MASKED_SECRET });
  });

  it('config/get returns masked values with names kept, and the secret is not in the response', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [httpServer('a')] }));
    const res = makeRes();
    await createConfigRoutes(configFile).get({}, res);
    const servers = (res.body as any).servers;
    expect(servers[0].transport.headers).toEqual({ Authorization: MASKED_SECRET });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('config/get answers an empty list when there is no file', async () => {
    const res = makeRes();
    await createConfigRoutes(configFile).get({}, res);
    expect(res.body).toEqual({ servers: [] });
  });

  it('servers/list masks the header values of the loaded servers', async () => {
    const manager = new McpManager();
    manager.addServer(httpServer('a'));
    const res = makeRes();
    await createServerRoutes(manager).list({ body: {} }, res as any);
    const servers = (res.body as any).servers;
    expect(servers[0].config.transport.headers).toEqual({ Authorization: MASKED_SECRET });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    // The manager still holds the real value for connecting.
    expect((manager.getServers()[0].config.transport as any).headers.Authorization).toBe(SECRET);
  });

  it('servers/connect returns the state with the header values masked', async () => {
    const manager = new McpManager();
    manager.addServer(httpServer('a'));
    manager._setClientFactory(() => ({
      connect: async () => {}, close: async () => {}, getServerCapabilities: () => ({}),
      listTools: async () => ({ tools: [] }), listResources: async () => ({ resources: [] }), listPrompts: async () => ({ prompts: [] }),
    }) as any);
    const res = makeRes();
    await createServerRoutes(manager).connect({ body: { id: 'a' } }, res as any);
    expect((res.body as any).state.status).toBe('connected');
    expect((res.body as any).state.config.transport.headers).toEqual({ Authorization: MASKED_SECRET });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('a save keeps the stored secret when the masked value comes back unchanged', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [httpServer('a')] }));
    const routes = createConfigRoutes(configFile);
    const got = makeRes();
    await routes.get({}, got);
    const servers = [...(got.body as any).servers, httpServer('b', { Authorization: OTHER_SECRET })];
    const res = makeRes();
    await routes.set({ body: { servers } }, res);
    expect(res.body).toEqual({ ok: true });
    const stored = JSON.parse(await fs.readFile(configFile, 'utf-8')).servers;
    expect(stored[0].transport.headers.Authorization).toBe(SECRET);
    expect(stored[1].transport.headers.Authorization).toBe(OTHER_SECRET);
    expect(JSON.stringify(stored)).not.toContain(MASKED_SECRET);
  });

  it('a new value replaces the stored secret', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [httpServer('a')] }));
    const res = makeRes();
    await createConfigRoutes(configFile).set({ body: { servers: [httpServer('a', { Authorization: OTHER_SECRET })] } }, res);
    expect(JSON.parse(await fs.readFile(configFile, 'utf-8')).servers[0].transport.headers.Authorization).toBe(OTHER_SECRET);
  });

  it('a masked value with nothing stored for it is dropped, never written as the secret', async () => {
    const res = makeRes();
    await createConfigRoutes(configFile).set({ body: { servers: [httpServer('fresh', { Authorization: MASKED_SECRET, 'X-Keep': 'plain' })] } }, res);
    const header = JSON.parse(await fs.readFile(configFile, 'utf-8')).servers[0].transport.headers;
    expect(header).toEqual({ 'X-Keep': 'plain' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('fresh:Authorization'));
  });

  it('re-pointing a server\'s URL with a masked Authorization does NOT carry the stored token to the new URL', async () => {
    await fs.writeFile(configFile, JSON.stringify({ servers: [httpServer('a')] }));
    const routes = createConfigRoutes(configFile);
    const got = makeRes();
    await routes.get({}, got);
    const repointed = (got.body as any).servers.map((s: any) => ({
      ...s,
      transport: { ...s.transport, url: 'https://attacker.invalid/collect' },
    }));
    expect(repointed[0].transport.headers.Authorization).toBe(MASKED_SECRET);

    await routes.set({ body: { servers: repointed } }, makeRes());

    const stored = JSON.parse(await fs.readFile(configFile, 'utf-8')).servers;
    expect(stored[0].transport.url).toBe('https://attacker.invalid/collect');
    expect(stored[0].transport.headers).toEqual({});
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(JSON.stringify(stored)).not.toContain(MASKED_SECRET);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('re-pointed [a]'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('a:Authorization'));
  });

  it('a changed transport type also drops the masked value, and an unchanged target keeps it', () => {
    const stored = [httpServer('a')];
    const retyped = restoreMaskedSecrets(
      [{ ...httpServer('a', { Authorization: MASKED_SECRET }), transport: { type: 'stdio', command: 'x', env: { Authorization: MASKED_SECRET } } as any }],
      stored,
    );
    expect(retyped.restored).toBe(0);
    expect(retyped.dropped).toEqual(['a:Authorization']);
    expect(retyped.repointed).toEqual(['a']);
    const same = restoreMaskedSecrets([httpServer('a', { Authorization: MASKED_SECRET })], stored);
    expect(same.restored).toBe(1);
    expect(same.repointed).toEqual([]);
    expect((same.servers[0].transport as any).headers.Authorization).toBe(SECRET);
  });

  it('restoreMaskedSecrets matches by server id and header name', () => {
    const result = restoreMaskedSecrets(
      [httpServer('a', { Authorization: MASKED_SECRET }), httpServer('b', { Authorization: MASKED_SECRET })],
      [httpServer('b', { Authorization: OTHER_SECRET })],
    );
    expect(result.restored).toBe(1);
    expect(result.dropped).toEqual(['a:Authorization']);
    expect((result.servers[1].transport as any).headers.Authorization).toBe(OTHER_SECRET);
  });
});

describe('(7) classified logging through Taproom\'s context.logger', () => {
  const PRIVATE_ID = 'private-label-7';
  const STDIO_ID = 'stdio-private-9';
  const URL = 'https://secret-host.invalid/tok-ABC';
  const HEADER_NAME = 'X-Secret-Header';
  const HEADER_VALUE = 'hv-123456';
  const MESSAGE_TOKEN = 'tok-in-message';
  const HANDLE = 'alice-handle';
  const NORMAL = 'fork-normal';
  const SENSITIVE = 'fork-sensitive';

  /** A stand-in for context.logger and context.LogClass; the class values are deliberately not 0 and 1. */
  function forkContext() {
    const lines: Array<{ level: string; cls: unknown; text: string }> = [];
    const record = (level: string) => (cls: unknown, ...args: unknown[]) => { lines.push({ level, cls, text: args.map(String).join(' ') }); };
    const logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
    return { context: { logger, LogClass: { NORMAL, SENSITIVE } }, lines };
  }

  it('adopts the fork logger when both the logger and the class values are present, and binds rather than wraps', () => {
    const { context, lines } = forkContext();
    expect(adoptLogger(context)).toBe(true);
    normal().info('n-line');
    sensitive().warn('s-line');
    expect(lines).toEqual([
      { level: 'info', cls: NORMAL, text: 'n-line' },
      { level: 'warn', cls: SENSITIVE, text: 's-line' },
    ]);
    // A bound function adds no stack frame, so the fork captures the real call site of a suppressed line.
    expect(normal().info.name).toMatch(/^bound /);
    expect(sensitive().warn.name).toMatch(/^bound /);
  });

  it('falls back to console when the context is absent or incomplete, and the lines still arrive', () => {
    const { context } = forkContext();
    const noClass = { logger: context.logger };
    const noLogger = { LogClass: context.LogClass };
    const missingMethod = { logger: { info: context.logger.info, warn: context.logger.warn, error: context.logger.error }, LogClass: context.LogClass };
    const missingValue = { logger: context.logger, LogClass: { NORMAL } };
    for (const bad of [undefined, null, {}, noClass, noLogger, missingMethod, missingValue]) {
      expect(adoptLogger(bad as any)).toBe(false);
    }
    normal().info('fallback-normal');
    sensitive().warn('fallback-sensitive');
    expect(console.log).toHaveBeenCalledWith('fallback-normal');
    expect(console.warn).toHaveBeenCalledWith('fallback-sensitive');
  });

  it('the plugin init adopts the context it is given, and without one logs to console', async () => {
    const { context, lines } = forkContext();
    await loadPlugin(context);
    expect(lines.some((l) => l.cls === NORMAL && /Taproom classified logger adopted/.test(l.text))).toBe(true);

    vi.mocked(console.log).mockClear();
    await loadPlugin();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('console fallback'));
  });

  it('safeErrorFacts returns an identifier-shaped class and code and nothing else', () => {
    const refused: any = new Error(`connect failed ${URL}?token=${MESSAGE_TOKEN}`);
    refused.code = 'ECONNREFUSED';
    expect(safeErrorFacts(refused)).toEqual({ errorClass: 'Error', errorCode: 'ECONNREFUSED' });
    const odd: any = new Error('x');
    odd.name = `Weird ${URL}`;
    odd.code = `code with ${HEADER_VALUE}`;
    expect(safeErrorFacts(odd)).toEqual({ errorClass: 'unknown', errorCode: 'none' });
    const numeric: any = new Error('x');
    numeric.code = -32000;
    expect(safeErrorFacts(numeric).errorCode).toBe('-32000');
    expect(safeErrorFacts('a thrown string')).toEqual({ errorClass: 'string', errorCode: 'none' });
  });

  it('NORMAL lines never carry a server id, URL, header name or value, handle, path or error message; SENSITIVE lines do', async () => {
    await fs.writeFile(configFile, JSON.stringify({
      servers: [httpServerAt(PRIVATE_ID, URL, { [HEADER_NAME]: HEADER_VALUE }), stdioServer(STDIO_ID)],
    }));
    process.env.TAPROOM_MCP_CONFIG = configFile;
    const { context, lines } = forkContext();
    adoptLogger(context); // this test file's own copy of log.ts (the connect case below runs in it)
    const { router } = await loadPlugin(context);
    const call = (route: string, req: Record<string, unknown>) => invoke(router.routes.get(route)!, req);

    // Admin reads the list, then saves it re-pointed with the masked header, adds stdio, adds a duplicate.
    const got = await call('/config/get', ADMIN);
    const servers = (got.body as any).servers.map((s: any) => (s.id === PRIVATE_ID
      ? { ...s, transport: { ...s.transport, url: 'https://other-host.invalid/elsewhere' } } : s));
    await call('/config/set', { ...ADMIN, body: { servers } });
    await call('/servers/add', { ...ADMIN, body: stdioServer('another-stdio-id') });
    await call('/servers/add', { ...ADMIN, body: httpServerAt(PRIVATE_ID, URL, { [HEADER_NAME]: HEADER_VALUE }) });
    // A non-admin account named HANDLE is refused on a registered route.
    await call('/config/get', { user: { profile: { admin: false, handle: HANDLE } }, route: { path: '/config/get' }, body: {} });
    // A failed connection whose message carries the URL and a token.
    const manager = new McpManager();
    manager.addServer(httpServerAt('conn-private-id', URL, { [HEADER_NAME]: HEADER_VALUE }));
    manager._setClientFactory(() => ({
      connect: async () => { throw Object.assign(new Error(`connect ECONNREFUSED ${URL}?token=${MESSAGE_TOKEN}`), { code: 'ECONNREFUSED' }); },
    }) as any);
    await manager.connect('conn-private-id');
    // A server that connects but whose tool list cannot be read (found live October 10, 2026: upstream swallowed
    // it and reported "0 tools" with no trace). It advertises no resources or prompts, so they are not asked for.
    const lister = new McpManager();
    lister.addServer(httpServerAt('list-private-id', URL, { [HEADER_NAME]: HEADER_VALUE }));
    const listClient = {
      connect: async () => {},
      close: async () => {},
      getServerCapabilities: () => ({ tools: {} }),
      listTools: async () => { throw Object.assign(new Error(`invalid tools from ${URL}?token=${MESSAGE_TOKEN}`), { code: -32602 }); },
      listResources: vi.fn(async () => ({ resources: [] })),
      listPrompts: vi.fn(async () => ({ prompts: [] })),
    };
    lister._setClientFactory(() => listClient as any);
    await lister.connect('list-private-id');
    expect(lister.getServerState('list-private-id')?.tools).toEqual([]);
    expect(listClient.listResources).not.toHaveBeenCalled();
    expect(listClient.listPrompts).not.toHaveBeenCalled();

    const forbidden = [PRIVATE_ID, STDIO_ID, 'another-stdio-id', 'conn-private-id', 'list-private-id', URL, 'secret-host', 'other-host', HEADER_NAME,
      HEADER_VALUE, MESSAGE_TOKEN, HANDLE, path.basename(dir), configFile];
    const normalLines = lines.filter((l) => l.cls === NORMAL);
    const sensitiveLines = lines.filter((l) => l.cls === SENSITIVE);
    for (const line of normalLines) {
      for (const secret of forbidden) expect(line.text, `NORMAL line leaks ${secret}`).not.toContain(secret);
    }
    // Every line used one of the fork's two class values (never a constant of our own).
    expect(lines.every((l) => l.cls === NORMAL || l.cls === SENSITIVE)).toBe(true);

    const normalText = normalLines.map((l) => l.text).join('\n');
    expect(normalText).toContain('Server list source: TAPROOM_MCP_CONFIG');
    expect(normalText).toMatch(/Loaded server list: 2 entries in file, 1 added, 1 refused \(non-HTTP transport\), 0 duplicate/);
    expect(normalText).toContain('config/get: 2 server(s), header values masked');
    expect(normalText).toMatch(/config\/set: saved 2 server\(s\) \(was 2\); 1 masked secret\(s\) kept, 1 masked value\(s\) dropped, 1 server\(s\) re-pointed/);
    expect(normalText).toContain('servers/add: non-HTTP transport refused (400)');
    expect(normalText).toContain('servers/add: rejected (duplicate id or invalid) (400)');
    expect(normalText).toContain('Refused a non-admin request to the admin-only route /config/get: 403');
    expect(normalText).toContain('connect: failed (Error, code ECONNREFUSED)');
    expect(normalText).toContain('list tools: failed (Error, code -32602); treating it as empty');

    const sensitiveText = sensitiveLines.map((l) => l.text).join('\n');
    expect(sensitiveText).toContain(`Not loading server '${STDIO_ID}'`);
    expect(sensitiveText).toContain(configFile);
    expect(sensitiveText).toContain(`user ${HANDLE}`);
    expect(sensitiveText).toContain('re-pointed [private-label-7]');
    expect(sensitiveText).toContain(`'conn-private-id' failed: connect ECONNREFUSED ${URL}?token=${MESSAGE_TOKEN}`);
    expect(sensitiveText).toContain(`list tools: 'list-private-id' failed: invalid tools from ${URL}?token=${MESSAGE_TOKEN}`);
  });
});

function httpServerAt(id: string, url: string, headers: Record<string, string>): McpServerConfig {
  return { id, name: `Name of ${id}`, transport: { type: 'streamable-http', url, headers }, enabled: true };
}

describe('(6) atomic write with mode 0600', () => {
  it.runIf(posix)('creates the file with mode 0600 and leaves no temporary file', async () => {
    await writeFileAtomic(configFile, '{"servers":[]}');
    expect((await fs.stat(configFile)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dir)).toEqual(['mcp-servers.json']);
  });

  it.runIf(posix)('narrows an existing wider file to 0600', async () => {
    await fs.writeFile(configFile, 'old', { mode: 0o644 });
    await fs.chmod(configFile, 0o644);
    await writeFileAtomic(configFile, 'new');
    expect((await fs.stat(configFile)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(configFile, 'utf-8')).toBe('new');
  });

  it('replaces the content and creates the folder when it is missing', async () => {
    const nested = path.join(dir, 'a', 'b', 'mcp-servers.json');
    await writeFileAtomic(nested, 'one');
    await writeFileAtomic(nested, 'two');
    expect(await fs.readFile(nested, 'utf-8')).toBe('two');
    expect(await fs.readdir(path.dirname(nested))).toEqual(['mcp-servers.json']);
  });

  it('writes the temporary file in the same folder as the target, then renames it', async () => {
    const seen: string[] = [];
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(((file: any, ...rest: any[]) => { seen.push(String(file)); return (realOpen as any)(file, ...rest); }) as any);
    await writeFileAtomic(configFile, 'x');
    expect(seen).toHaveLength(1);
    expect(path.dirname(seen[0])).toBe(path.dirname(configFile));
    expect(path.basename(seen[0])).not.toBe(path.basename(configFile));
  });

  it('leaves the previous file untouched and removes the temporary file when the rename fails', async () => {
    // A directory at the target path makes the final rename fail on every platform.
    await fs.mkdir(configFile);
    await fs.writeFile(path.join(configFile, 'inner.txt'), 'keep');
    await expect(writeFileAtomic(configFile, 'new')).rejects.toBeDefined();
    expect((await fs.readdir(dir)).sort()).toEqual(['mcp-servers.json']);
    expect(await fs.readFile(path.join(configFile, 'inner.txt'), 'utf-8')).toBe('keep');
  });

  it.runIf(posix)('config/set writes the saved list with mode 0600', async () => {
    const res = makeRes();
    await createConfigRoutes(configFile).set({ body: { servers: [httpServer('a')] } }, res);
    expect(res.body).toEqual({ ok: true });
    expect((await fs.stat(configFile)).mode & 0o777).toBe(0o600);
  });

  it('config/set rejects a body without a servers array and writes nothing', async () => {
    const res = makeRes();
    await createConfigRoutes(configFile).set({ body: {} }, res);
    expect(res.statusCode).toBe(400);
    await expect(fs.stat(configFile)).rejects.toBeDefined();
  });
});
