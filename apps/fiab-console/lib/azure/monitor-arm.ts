/**
 * Azure Monitor client — ARM transport substrate.
 *
 * The auth + HTTP + memoization layer that every Monitor surface sits on,
 * extracted verbatim from monitor-client.ts so that file (and any future
 * sibling carved out of it — action groups, scheduled query rules,
 * diagnostic settings) shares ONE credential chain, ONE error type and ONE
 * TTL memo instead of each re-deriving them.
 *
 * This module deliberately knows nothing about Monitor's domain: no metric
 * catalog, no alert shapes, no KQL. It is the substrate, so it has no import
 * back into monitor-client.ts and the dependency edge stays acyclic:
 *
 *     monitor-arm.ts  ←  monitor-client.ts  ←  routes / provisioners
 *
 * Auth: ChainedTokenCredential(ACA MSI, UAMI, DefaultAzureCredential),
 * identical to every other Loom ARM client. The UAMI needs "Monitoring
 * Reader" on the Loom subscription/RGs to read metrics, activity log and
 * resource health, and Contributor-equivalent rights on the alert RG for the
 * write paths (action groups, scheduled query rules, diagnostic settings).
 *
 * Sovereign clouds: the ARM host and token scope come from cloud-endpoints
 * (armBase/armScope), so Commercial / GCC-High / IL5 are all covered by the
 * same code path — see .claude/rules/cloud-parity.md.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import { walkPagedList } from './paging-budget';

// Sovereign-cloud ARM host + scope (Commercial / GCC-High / IL5).
const ARM = armBase();
const ARM_SCOPE = armScope();

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class MonitorError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'MonitorError';
    this.status = status;
    this.body = body;
  }
}

export class MonitorNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`Monitor not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'MonitorNotConfiguredError';
  }
}

// ----------------------------------------------------------------------------
// token + fetch helpers
// ----------------------------------------------------------------------------

export async function token(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new MonitorError(`Failed to acquire token for ${scope}`, 401);
  return t.token;
}

export async function armGet(path: string, timeoutMs?: number): Promise<any> {
  const tk = await token(ARM_SCOPE);
  const url = path.startsWith('http') ? path : `${ARM}${path}`;
  const res = await fetchWithTimeout(url, {
    headers: { authorization: `Bearer ${tk}`, accept: 'application/json' },
    cache: 'no-store',
  }, timeoutMs); // undefined => the shared DEFAULT_SERVER_FETCH_TIMEOUT_MS
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `ARM GET failed (${res.status})`).toString();
    throw new MonitorError(msg, res.status, json || text);
  }
  return json;
}

/**
 * Walk an ARM `nextLink` list BOUNDED by the shared paging budget (page cap +
 * wall clock, #2557/#2582). Every hand-rolled `guard < N` in this module capped
 * PAGES only — N pages x the 30s per-request ceiling is minutes of unbounded
 * await on a request path. A deadline inside a page fetch truncates (rows kept)
 * instead of throwing a `MonitorError` a caller would show as "no data".
 */
export async function armPagedList<T = any>(
  label: string,
  firstPath: string,
  maxPages: number,
): Promise<T[]> {
  return walkPagedList<T>(label, (next, timeoutMs) => armGet(next ?? firstPath, timeoutMs), { maxPages });
}

export async function armPut(path: string, body: unknown): Promise<any> {
  const tk = await token(ARM_SCOPE);
  const url = path.startsWith('http') ? path : `${ARM}${path}`;
  const res = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${tk}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `ARM PUT failed (${res.status})`).toString();
    throw new MonitorError(msg, res.status, json || text);
  }
  return json;
}

export async function armPost(path: string, body: unknown, timeoutMs?: number): Promise<{ status: number; json: any; operationLocation?: string }> {
  const tk = await token(ARM_SCOPE);
  const url = path.startsWith('http') ? path : `${ARM}${path}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tk}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  }, timeoutMs); // undefined => the shared DEFAULT_SERVER_FETCH_TIMEOUT_MS
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `ARM POST failed (${res.status})`).toString();
    throw new MonitorError(msg, res.status, json || text);
  }
  const operationLocation =
    res.headers.get('azure-asyncoperation') || res.headers.get('location') || undefined;
  return { status: res.status, json, operationLocation };
}

export async function armPatch(path: string, body: unknown): Promise<any> {
  const tk = await token(ARM_SCOPE);
  const url = path.startsWith('http') ? path : `${ARM}${path}`;
  const res = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${tk}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `ARM PATCH failed (${res.status})`).toString();
    throw new MonitorError(msg, res.status, json || text);
  }
  return json;
}

export async function armDelete(path: string): Promise<void> {
  const tk = await token(ARM_SCOPE);
  const url = path.startsWith('http') ? path : `${ARM}${path}`;
  const res = await fetchWithTimeout(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tk}`, accept: 'application/json' },
    cache: 'no-store',
  });
  // 200 (deleted) and 204 (deleted, no body) are success; 404 = already gone.
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
    const msg = (json?.error?.message || text || `ARM DELETE failed (${res.status})`).toString();
    throw new MonitorError(msg, res.status, json || text);
  }
}

// ----------------------------------------------------------------------------
// TTL cache — server-side memo for the heavy Monitor read paths
// ----------------------------------------------------------------------------
//
// The Monitor surface re-runs the same expensive Azure reads on every tab
// revisit and every Refresh click: the resource inventory (one ARM list per
// Loom RG), the resource-health crawl, and the activity-feed KQL. None of
// those change second-to-second, so a short module-level TTL memo serves
// tab-revisits and Refresh-spam from process memory instead of re-hitting
// Azure — without changing first-paint semantics. In-flight de-duplication
// (we cache the Promise, not the resolved value) means N concurrent callers
// share ONE Azure round-trip. Pure in-process Map — no new dependency, no env
// requirement, no Fabric. Failures are evicted so the next call retries Azure.

interface CacheEntry<T> { at: number; val: Promise<T>; }
const _monitorCache = new Map<string, CacheEntry<unknown>>();

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = _monitorCache.get(key) as CacheEntry<T> | undefined;
  if (hit && now - hit.at < ttlMs) return hit.val;
  const entry: CacheEntry<T> = {
    at: now,
    val: fn().catch((e) => {
      // Don't cache failures — evict (only if still ours) so the next call retries.
      if (_monitorCache.get(key) === (entry as CacheEntry<unknown>)) _monitorCache.delete(key);
      throw e;
    }),
  };
  _monitorCache.set(key, entry as CacheEntry<unknown>);
  return entry.val;
}

/** Drop all memoized Monitor reads (test hook / explicit hard-refresh path). */
export function clearMonitorCache(): void { _monitorCache.clear(); }
