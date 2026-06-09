/**
 * aas-client — Power BI / Azure Analysis Services (AAS) **enhanced-refresh**
 * client for the Direct-Lake-shim.
 *
 * WHY A SEPARATE CLIENT (not powerbi-client.ts)
 * ---------------------------------------------
 * The Direct-Lake-shim achieves Direct-Lake-style freshness on Azure (no
 * Fabric F-SKU required) by driving Power BI Premium **enhanced refresh** over
 * the Analysis Services / XMLA data plane — partition-scoped, incremental, and
 * triggered by ADLS `_delta_log` Event Grid notifications. That is a distinct
 * concern (and a distinct AAD audience — `aasScope()`, the `analysis.*` host,
 * NOT the Power BI REST audience) from the broad workspace navigation in
 * powerbi-client.ts, so it lives in its own file: smaller surface, sovereign-
 * aware via cloud-endpoints, and unit-testable in isolation.
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ManagedIdentityCredential,
 * chained with DefaultAzureCredential for local dev — same pattern as the
 * other Loom Azure clients.
 *
 * Enhanced-refresh REST (Power BI Premium / PPU; works on Azure with no Fabric
 * dependency — the host is the sovereign Power BI host from getPbiGovHost()):
 *   POST   {base}/groups/{ws}/datasets/{id}/refreshes        → queue (202)
 *   GET    {base}/groups/{ws}/datasets/{id}/refreshes?$top=N → history
 *   GET    {base}/groups/{ws}/datasets/{id}/refreshes/{rid}  → one run
 *   https://learn.microsoft.com/power-bi/connect-data/asynchronous-refresh
 *
 * No mocks. Every function calls real Power BI REST and surfaces the engine's
 * error verbatim via AasError so the BFF route can render it.
 */

import { aasScope, getPbiGovHost } from './cloud-endpoints';

// The @azure/identity credential is created lazily on first token request (via
// dynamic import) so this module carries no top-level Azure-SDK import — the
// pure, env-driven helpers (shimEnabled / aasApiBase / SHIM_DISABLED_HINT) stay
// unit-testable in isolation without the SDK on the resolution path.
let _credentialPromise: Promise<{ getToken: (scope: string) => Promise<{ token: string } | null> }> | null = null;
async function getCredential() {
  if (!_credentialPromise) {
    _credentialPromise = (async () => {
      const { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } = await import('@azure/identity');
      const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
      return uamiClientId
        ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
        : new DefaultAzureCredential();
    })();
  }
  return _credentialPromise;
}

export class AasError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

/** Power BI enhanced-refresh REST base — sovereign-correct Power BI host + /v1.0/myorg. */
export function aasApiBase(): string {
  const explicit = process.env.LOOM_POWERBI_BASE;
  if (explicit) return explicit.replace(/\/+$/, '');
  return `${getPbiGovHost()}/v1.0/myorg`;
}

/**
 * True when the Direct-Lake-shim is explicitly enabled. The shim is an opt-in
 * Azure-native fast-path (it requires a Power BI Premium / PPU workspace +
 * XMLA endpoint), so it is gated by an env flag rather than running by default.
 * When false, the BFF route renders the honest setup MessageBar instead of
 * calling the enhanced-refresh REST.
 */
export function shimEnabled(): boolean {
  return (process.env.LOOM_DIRECT_LAKE_SHIM_ENABLED || '').toLowerCase() === 'true';
}

/** The exact, honest setup copy shown when the shim isn't enabled. Cloud-invariant. */
export const SHIM_DISABLED_HINT =
  'True Direct Lake sub-second freshness requires a Fabric F-SKU (unavailable in Gov). ' +
  'This shim achieves 5–30 s via AAS incremental refresh via Power BI Premium XMLA. ' +
  'Set LOOM_DIRECT_LAKE_SHIM_ENABLED=true to activate.';

async function getToken(): Promise<string> {
  const credential = await getCredential();
  const t = await credential.getToken(aasScope());
  if (!t?.token) throw new AasError(`Failed to acquire AAD token for ${aasScope()}`, 401);
  return t.token;
}

interface CallOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

/** Low-level REST call returning { json, location } so callers can read the 202 Location header. */
async function call<T = any>(path: string, opts: CallOpts = {}): Promise<{ json: T; location: string | null }> {
  const method = opts.method ?? 'GET';
  const token = await getToken();
  let url = `${aasApiBase()}${path}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    Object.entries(opts.query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.append(k, String(v));
    });
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || json?.message || text || `AAS ${method} ${path} failed`).toString();
    throw new AasError(msg, res.status, json || text, url);
  }
  return { json: (json as T) ?? ({} as T), location: res.headers.get('location') };
}

// ============================================================
// Types
// ============================================================

export type AasRefreshType = 'Full' | 'DataOnly' | 'ClearValues' | 'Calculate' | 'Defragment' | 'Automatic';
export type AasCommitMode = 'transactional' | 'partialBatch';

export interface AasRefreshObject {
  table: string;
  /** Partition name — omit for a whole-table refresh. */
  partition?: string;
}

export interface ShimRefreshRequest {
  type: AasRefreshType;
  commitMode?: AasCommitMode;
  /** Empty / omitted → refresh the whole model. */
  objects?: AasRefreshObject[];
  /** Number of retries on a transient failure (enhanced-refresh `retryCount`). */
  retryCount?: number;
}

export interface AasClientConfig {
  /** Power BI workspace (group) id. */
  workspaceId: string;
  /** Power BI dataset (semantic model) id. */
  datasetId: string;
}

export interface ShimRefreshRun {
  requestId: string;
  refreshType?: string;
  status?: string;          // 'Completed' | 'Failed' | 'Unknown' (in progress) | 'Disabled' | 'Cancelled'
  startTime?: string;
  endTime?: string;
  /** Duration in ms when both start+end are present. */
  durationMs?: number;
  error?: string;
}

function toRun(r: any): ShimRefreshRun {
  const start = r?.startTime ? new Date(r.startTime).getTime() : NaN;
  const end = r?.endTime ? new Date(r.endTime).getTime() : NaN;
  const durationMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
  // serviceExceptionJson holds the engine error for a failed run.
  let error: string | undefined;
  if (r?.serviceExceptionJson) {
    try { error = JSON.parse(r.serviceExceptionJson)?.errorDescription || r.serviceExceptionJson; }
    catch { error = String(r.serviceExceptionJson); }
  }
  return {
    requestId: r?.requestId || r?.id || '',
    refreshType: r?.refreshType,
    status: r?.status,
    startTime: r?.startTime,
    endTime: r?.endTime,
    durationMs,
    error,
  };
}

// ============================================================
// Enhanced-refresh operations
// ============================================================

/**
 * POST .../refreshes — queue an enhanced (async) refresh. Power BI returns 202
 * with the new refresh id in the `Location` response header
 * (`.../refreshes/{refreshId}`). We parse it out and return it so the caller
 * can poll status. `objects` scopes the refresh to specific tables/partitions
 * (the Direct-Lake-shim sweet spot); omit for a whole-model refresh.
 */
export async function triggerShimRefresh(
  cfg: AasClientConfig,
  req: ShimRefreshRequest,
): Promise<{ refreshId: string }> {
  const body: Record<string, unknown> = {
    type: req.type,
    commitMode: req.commitMode ?? 'transactional',
    retryCount: req.retryCount ?? 2,
  };
  if (req.objects && req.objects.length) body.objects = req.objects;
  const { location } = await call(
    `/groups/${encodeURIComponent(cfg.workspaceId)}/datasets/${encodeURIComponent(cfg.datasetId)}/refreshes`,
    { method: 'POST', body },
  );
  const refreshId = location ? (location.split('/').pop() || location) : '';
  return { refreshId };
}

/** GET .../refreshes/{refreshId} — status of a single enhanced-refresh run. */
export async function getShimRefreshStatus(
  cfg: AasClientConfig,
  refreshId: string,
): Promise<ShimRefreshRun> {
  const { json } = await call<any>(
    `/groups/${encodeURIComponent(cfg.workspaceId)}/datasets/${encodeURIComponent(cfg.datasetId)}/refreshes/${encodeURIComponent(refreshId)}`,
  );
  return toRun(json);
}

/**
 * GET .../refreshes?$top=N — refresh history (newest first). Used by the
 * Direct Lake (shim) status panel to show the last N shim runs. Falls back to
 * an empty list on 404/400 (model has never been refreshed) rather than
 * erroring.
 */
export async function listShimRefreshHistory(
  cfg: AasClientConfig,
  top = 10,
): Promise<ShimRefreshRun[]> {
  try {
    const { json } = await call<{ value: any[] }>(
      `/groups/${encodeURIComponent(cfg.workspaceId)}/datasets/${encodeURIComponent(cfg.datasetId)}/refreshes`,
      { query: { $top: top } },
    );
    return (json.value || []).map(toRun);
  } catch (e) {
    if (e instanceof AasError && (e.status === 404 || e.status === 400)) return [];
    throw e;
  }
}
