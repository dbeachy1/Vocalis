// Downstream tests (Vocalis, October 10, 2026) for extension/src/backend.ts; see DOWNSTREAM-CHANGES.md.
// A non-admin account must be able to initialize the extension: the probe and the status line may only use routes
// that are open to every logged-in account.
import { describe, it, expect, vi } from 'vitest';
import { fetchServerStatus, isAdminRefusal, probeBackend } from '../src/backend.js';

/** A fetch stand-in for a NON-ADMIN account: the administrator-only routes answer 403. */
function memberFetch(overrides: Record<string, () => any> = {}) {
  const adminOnly = ['/servers/list', '/servers/add', '/servers/remove', '/servers/connect', '/servers/disconnect', '/config/get', '/config/set'];
  return vi.fn(async (url: string) => {
    const route = url.replace('/api/plugins/mcp-client', '');
    if (adminOnly.includes(route)) return { ok: false, status: 403, json: async () => ({}) };
    if (overrides[route]) return overrides[route]();
    if (route === '/tools/list') return { ok: true, status: 200, json: async () => ({ tools: [] }) };
    if (route === '/servers/status') {
      return { ok: true, status: 200, json: async () => ({ servers: [{ id: 'a', name: 'A', status: 'connected' }, { id: 'b', name: 'B', status: 'error' }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('backend probe and status for a non-admin account', () => {
  it('the probe succeeds for a non-admin account and never touches an administrator-only route', async () => {
    const doFetch = memberFetch();
    expect(await probeBackend(doFetch)).toBe(true);
    expect(doFetch.mock.calls.map((c) => c[0])).toEqual(['/api/plugins/mcp-client/tools/list']);
  });

  it('the probe is false when the plugin is absent or the request fails', async () => {
    expect(await probeBackend(async () => ({ ok: false, status: 404, json: async () => ({}) }))).toBe(false);
    expect(await probeBackend(async () => { throw new Error('network'); })).toBe(false);
  });

  it('the status line counts connected servers from the open status route', async () => {
    const doFetch = memberFetch();
    expect(await fetchServerStatus(doFetch)).toEqual({ connected: 1, total: 2 });
    expect(doFetch.mock.calls.map((c) => c[0])).toEqual(['/api/plugins/mcp-client/servers/status']);
  });

  it('the status line throws when the route does not answer ok', async () => {
    await expect(fetchServerStatus(async () => ({ ok: false, status: 500, json: async () => ({}) }))).rejects.toThrow('500');
  });

  it('isAdminRefusal recognizes the 403 error the settings panel gets from an administrator-only route', () => {
    expect(isAdminRefusal(new Error('403 Forbidden'))).toBe(true);
    expect(isAdminRefusal(new Error('500 Internal Server Error'))).toBe(false);
    expect(isAdminRefusal('403')).toBe(false);
  });
});
