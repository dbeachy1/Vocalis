/**
 * Backend calls the extension makes for ANY logged-in account (probe and status), kept out of index.ts so they can be
 * tested without a browser.
 *
 * Downstream addition (Vocalis, October 10, 2026; see DOWNSTREAM-CHANGES.md). Not part of upstream
 * Moeblack/sillytavern-mcp-client (745ff27). Upstream probed `/servers/list` and counted servers from it; in this build
 * that route (and every other route that reads or changes configuration) is admin-only, so a non-admin account's
 * probe would fail and the extension would never initialize for it, although non-admin accounts use the tools of the
 * servers an administrator configured. The probe now uses `/tools/list` and the status uses `/servers/status`, both
 * open to every logged-in account and neither carrying configuration or secrets.
 */

/** The slice of `fetch` these helpers need (the extension passes a wrapper that adds SillyTavern's request headers). */
export type BackendFetch = (
  url: string,
  init: { method: 'POST'; body: string },
) => Promise<{ ok: boolean; status?: number; json(): Promise<any> }>;

export interface ServerStatusSummary {
  connected: number;
  total: number;
}

const BASE = '/api/plugins/mcp-client';

/** True when the plugin answers; uses a route every logged-in account may call. */
export async function probeBackend(doFetch: BackendFetch): Promise<boolean> {
  try {
    const resp = await doFetch(`${BASE}/tools/list`, { method: 'POST', body: '{}' });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Connected and total server counts from the non-secret status route; throws when the plugin does not answer ok. */
export async function fetchServerStatus(doFetch: BackendFetch): Promise<ServerStatusSummary> {
  const resp = await doFetch(`${BASE}/servers/status`, { method: 'POST', body: '{}' });
  if (!resp.ok) throw new Error(`${resp.status ?? 'error'} from servers/status`);
  const data = await resp.json();
  const servers: Array<{ status?: string }> = Array.isArray(data?.servers) ? data.servers : [];
  return { connected: servers.filter((s) => s.status === 'connected').length, total: servers.length };
}

/** True for the error `fetchJson` raises for a 403 (an administrator-only route called by a non-admin account). */
export function isAdminRefusal(error: unknown): boolean {
  return error instanceof Error && /^403\b/.test(error.message);
}
