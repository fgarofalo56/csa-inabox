/**
 * Shared, sovereign-cloud-aware ARM control-plane fetcher.
 *
 * Unifies the per-client `armFetch()` helpers (synapse-pool-arm.ts,
 * kusto-arm-client.ts, …) behind one importable surface so new ARM calls don't
 * re-implement token acquisition + error handling. Cloud endpoint + scope come
 * from cloud-endpoints (AZURE_CLOUD / LOOM_ARM_ENDPOINT aware).
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential({clientId:
 * LOOM_UAMI_CLIENT_ID}), DefaultAzureCredential) — the same chain every other
 * ARM client uses. The Console UAMI must hold the relevant Azure RBAC role for
 * each call (e.g. Contributor on the Synapse workspace for OAP writes); a 403
 * is surfaced verbatim so the caller can show an honest remediation gate.
 *
 * No mocks. Every function hits real ARM.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import { fetchWithTimeout } from './fetch-with-timeout';

const ARM_SCOPE = armScope();

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Build a fully-qualified ARM URL from a bare `/subscriptions/...` path. */
function armUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${armBase()}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function armFetch(path: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token');
  // Per-request timeout so a hung ARM call can't make the BFF route (and the
  // page) spin forever. 202 LROs are polled by the caller; each poll round-trip
  // inherits this same per-request ceiling. `timeoutMs` lets a PagingBudget hand
  // a nextLink walk's REMAINING wall clock down to one page (#2557/#2582).
  return fetchWithTimeout(armUrl(path), {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  }, timeoutMs); // undefined => the shared DEFAULT_SERVER_FETCH_TIMEOUT_MS
}

async function jsonOrThrow<T = any>(res: Response, label: string): Promise<T> {
  if (!res.ok && res.status !== 202) {
    const body = await res.text().catch(() => '');
    throw new Error(`ARM ${label} failed ${res.status}: ${body.slice(0, 600)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** GET an ARM resource by bare path (api-version included by the caller). */
export async function armGet<T = any>(path: string, timeoutMs?: number): Promise<T> {
  return jsonOrThrow<T>(await armFetch(path, undefined, timeoutMs), `GET ${path}`);
}

// ---------------------------------------------------------------------------
// 429-aware GET — an OPT-IN wrapper. Nothing else in this file retries.
//
// ── WHY THIS IS A SEPARATE FUNCTION AND NOT A CHANGE TO armGet (#4243) ─────
// This module is shared by dozens of consumers, several of which run inside
// bounded BFF request budgets or poll loops that do their own pacing. Adding
// retries to the default path would silently multiply their latency and their
// call volume — the exact ARM-budget pressure that caused #4243 in the first
// place. So `armGet`/`armPost`/… keep their existing single-shot semantics
// bit-for-bit, and a caller that WANTS bounded throttle handling (the estate
// pause path's discovery reads) opts in here.
//
// deploy-integrity R6: the retry is bounded and FAILS CLOSED — on exhaustion,
// or when ARM demands a wait longer than the caller's budget, it throws an
// `ArmThrottledError` that says exactly what was observed (R7: never converts
// "I was throttled" into any other claim).
// ---------------------------------------------------------------------------

/**
 * A GET that stayed throttled. Distinct from a generic ARM failure so callers
 * can classify the affected row as "throttled", not generic indeterminate.
 */
export class ArmThrottledError extends Error {
  readonly status = 429 as const;
  readonly path: string;
  /** How many requests were actually issued before giving up. */
  readonly attempts: number;
  /** The last Retry-After ARM sent, in seconds, when it sent one. */
  readonly retryAfterSeconds?: number;
  constructor(opts: { path: string; attempts: number; retryAfterSeconds?: number }) {
    super(
      `ARM GET ${opts.path} was throttled (429) and stayed throttled after ${opts.attempts} `
        + `attempt(s)${opts.retryAfterSeconds !== undefined
          ? ` (ARM last asked for a ${opts.retryAfterSeconds}s wait)`
          : ''}. Nothing was read — this is a statement about the control plane's rate limit, `
        + 'not about the resource.',
    );
    this.name = 'ArmThrottledError';
    this.path = opts.path;
    this.attempts = opts.attempts;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export interface ArmThrottleRetryOptions {
  timeoutMs?: number;
  /** Total attempts INCLUDING the first. Default 3. Must be >= 1. */
  maxAttempts?: number;
  /**
   * Ceiling on any single wait, ms. Default 10s — a BFF request budget, not an
   * ARM one. A Retry-After LONGER than this fails closed immediately rather
   * than hanging the route: sleeping out a 600s penalty inside a request would
   * just move the outage.
   */
  maxDelayMs?: number;
  /** Injectable for tests. Defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** `Retry-After` is either delta-seconds or an HTTP-date. null = absent/bogus. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

/**
 * GET with bounded 429 retry honoring `Retry-After`. Non-429 responses behave
 * EXACTLY like `armGet` (same success shape, same thrown error text), so this
 * is a superset, never a semantic fork.
 */
export async function armGetWithRetry<T = any>(
  path: string,
  opts: ArmThrottleRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const maxDelayMs = opts.maxDelayMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastRetryAfterSeconds: number | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await armFetch(path, undefined, opts.timeoutMs);
    if (res.status !== 429) return jsonOrThrow<T>(res, `GET ${path}`);

    // Release the connection; the 429 body carries nothing we act on.
    await res.text().catch(() => '');
    const waitMs = retryAfterMs(res.headers.get('retry-after'));
    if (waitMs !== null) lastRetryAfterSeconds = Math.round(waitMs / 1000);

    if (attempt === maxAttempts) break;
    if (waitMs !== null && waitMs > maxDelayMs) {
      // ARM asked for more patience than this caller's budget. Fail closed NOW
      // with the truth, rather than sleeping into a timeout.
      throw new ArmThrottledError({
        path,
        attempts: attempt,
        retryAfterSeconds: lastRetryAfterSeconds as number,
      });
    }
    // Honor Retry-After when ARM sent one; otherwise a bounded default backoff.
    await sleep(waitMs ?? Math.min(maxDelayMs, 1000 * 2 ** (attempt - 1)));
  }
  throw new ArmThrottledError({
    path,
    attempts: maxAttempts,
    ...(lastRetryAfterSeconds !== undefined ? { retryAfterSeconds: lastRetryAfterSeconds } : {}),
  });
}

/** PATCH an ARM resource by bare path. */
export async function armPatch<T = any>(path: string, body: unknown): Promise<T> {
  return jsonOrThrow<T>(
    await armFetch(path, { method: 'PATCH', body: JSON.stringify(body) }),
    `PATCH ${path}`,
  );
}

/** PUT an ARM resource by bare path. */
export async function armPut<T = any>(path: string, body: unknown): Promise<T> {
  return jsonOrThrow<T>(
    await armFetch(path, { method: 'PUT', body: JSON.stringify(body) }),
    `PUT ${path}`,
  );
}

/** POST an ARM action by bare path (e.g. listKeys / regenerateKeys). Body defaults to `{}`. */
export async function armPost<T = any>(path: string, body: unknown = {}): Promise<T> {
  return jsonOrThrow<T>(
    await armFetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    `POST ${path}`,
  );
}

/** DELETE an ARM resource by bare path (api-version included by the caller).
 *  Tolerates 200/202/204 and a 404 (already-deleted = idempotent success). */
export async function armDelete(path: string): Promise<void> {
  const res = await armFetch(path, { method: 'DELETE' });
  if (!res.ok && res.status !== 202 && res.status !== 204 && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`ARM DELETE ${path} failed ${res.status}: ${body.slice(0, 600)}`);
  }
}

// ---------------------------------------------------------------------------
// Synapse workspace Outbound Access / trusted-service bypass (OAP)
// ---------------------------------------------------------------------------
//
// In the Synapse workspace ARM resource, the "Allow Azure services and
// resources to access this workspace" network toggle is the boolean property
// `properties.trustedServiceBypassEnabled` on
//   Microsoft.Synapse/workspaces/{ws}?api-version=2021-06-01
// (PATCH with { properties: { trustedServiceBypassEnabled: <bool> } }). This
// property exists in Commercial, GCC, GCC-High and DoD — armBase() resolves the
// per-cloud ARM host so no Fabric / Power BI host is ever touched.

const SYNAPSE_API = '2021-06-01';

function synapseWorkspacePath(sub: string, rg: string, ws: string): string {
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Synapse/workspaces/${encodeURIComponent(ws)}?api-version=${SYNAPSE_API}`;
}

export interface SynapseOapState {
  trustedServiceBypassEnabled: boolean;
  provisioningState: string;
}

/** Read the Synapse workspace OAP (trusted-service bypass) toggle. */
export async function getSynapseWorkspaceOap(
  sub: string,
  rg: string,
  ws: string,
): Promise<SynapseOapState> {
  const body = await armGet<{ properties?: { trustedServiceBypassEnabled?: boolean; provisioningState?: string } }>(
    synapseWorkspacePath(sub, rg, ws),
  );
  return {
    trustedServiceBypassEnabled: !!body?.properties?.trustedServiceBypassEnabled,
    provisioningState: body?.properties?.provisioningState || 'Unknown',
  };
}

/** Set the Synapse workspace OAP (trusted-service bypass) toggle. */
export async function setSynapseWorkspaceOap(
  sub: string,
  rg: string,
  ws: string,
  enabled: boolean,
): Promise<{ trustedServiceBypassEnabled: boolean }> {
  const body = await armPatch<{ properties?: { trustedServiceBypassEnabled?: boolean } }>(
    synapseWorkspacePath(sub, rg, ws),
    { properties: { trustedServiceBypassEnabled: enabled } },
  );
  return { trustedServiceBypassEnabled: !!body?.properties?.trustedServiceBypassEnabled };
}
