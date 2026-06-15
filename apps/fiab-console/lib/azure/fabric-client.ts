/**
 * Microsoft Fabric REST client — for the v2.4 Fabric-native editor family
 * (Notebook, Data Pipeline, Dataflow Gen2, Mirrored Database).
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ManagedIdentityCredential,
 * chained with DefaultAzureCredential for local dev.
 *
 * Scope:    https://api.fabric.microsoft.com/.default
 * Base URL: https://api.fabric.microsoft.com/v1
 *
 * Pre-requisites for real data (these surface as 401/403 errors if the
 * tenant has not bootstrapped the UAMI; the editor displays the error
 * verbatim via MessageBar):
 *
 *   1. A Power BI / Fabric admin must enable the tenant setting
 *        "Service principals can use Fabric APIs"
 *      and add a security group that contains the Console UAMI's SP.
 *
 *   2. The Console UAMI must be added to each Fabric workspace (Admin,
 *      Member, or Contributor) that the platform should be able to
 *      inspect or modify.
 *
 *   3. The UAMI's SP must exist in the customer's Fabric tenant.
 *
 * All errors are wrapped in FabricError with status + body + endpoint +
 * remediation hint so BFF routes can surface them to the editor.
 *
 * No mocks. No stubs. All calls hit api.fabric.microsoft.com.
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { armBase, armScope } from './cloud-endpoints';
import { fetchWithTimeout } from './fetch-with-timeout';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class FabricError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  hint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string, hint?: string) {
    super(message);
    this.name = 'FabricError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
    this.hint = hint;
  }
}

export function fabricHint(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'The Console UAMI is not authorized for Fabric. A Fabric admin must (1) enable "Service principals can use Fabric APIs" in tenant settings and (2) add the UAMI to the workspace as Admin, Member, or Contributor.';
  }
  if (status === 404) {
    return 'Item or workspace not found, or the UAMI does not have visibility. Verify the workspace ID and that the UAMI is added to the workspace.';
  }
  return undefined;
}

/**
 * Fabric / Power BI **capacities** are a Fabric-family concept with NO
 * Azure-native equivalent — Loom workspaces run on Azure-native compute
 * (ADLS+Delta, Synapse, ADX) by default and require no capacity binding.
 *
 * Per .claude/rules/no-fabric-dependency.md the DEFAULT path must NEVER call
 * api.fabric.microsoft.com nor surface an "enable Service principals can use
 * Fabric APIs" remediation. Capacity enumeration is therefore strictly opt-in:
 * the operator sets LOOM_CAPACITY_BACKEND=fabric (alias: LOOM_SCALING_BACKEND=
 * fabric) and grants the Console UAMI Capacity access. When unset, the capacity
 * routes return an empty list silently and the Azure-native default stands.
 */
export function fabricCapacityBackendEnabled(): boolean {
  const v = (process.env.LOOM_CAPACITY_BACKEND || process.env.LOOM_SCALING_BACKEND || '').toLowerCase();
  return v === 'fabric';
}

/** Honest, Azure-native note returned by the capacity routes on the default path. */
export const FABRIC_CAPACITY_OPT_IN_NOTE =
  'Fabric / Power BI capacities are an opt-in backend. Loom workspaces run on Azure-native compute (ADLS Gen2 + Delta, Synapse, Azure Data Explorer) by default — no capacity binding is required. To enumerate real capacities, set LOOM_CAPACITY_BACKEND=fabric and grant the Console UAMI Capacity access.';

async function getToken(): Promise<string> {
  const t = await credential.getToken(FABRIC_SCOPE);
  if (!t?.token) throw new FabricError('Failed to acquire AAD token for Fabric', 401, undefined, undefined, fabricHint(401));
  return t.token;
}

interface CallOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  acceptLongRunning?: boolean;
}

async function call<T = any>(path: string, opts: CallOpts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const token = await getToken();
  let url = `${FABRIC_BASE}${path}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    Object.entries(opts.query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.append(k, String(v));
    });
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    // 202 long-running is OK; treat as success and return headers/empty.
    if (res.status === 202 && opts.acceptLongRunning) {
      return ({ _accepted: true, location: res.headers.get('location') || undefined } as unknown) as T;
    }
    const msg = (json?.errorCode ? `${json.errorCode}: ${json.message || ''}` : json?.message || text || `${method} ${path} failed`).toString();
    throw new FabricError(msg, res.status, json || text, url, fabricHint(res.status));
  }
  if (res.status === 202) {
    return ({ _accepted: true, location: res.headers.get('location') || undefined } as unknown) as T;
  }
  return (json as T) ?? ({} as T);
}

// ============================================================
// Types — slim, only fields the editors render.
// ============================================================

export interface FabricWorkspace {
  id: string;
  displayName: string;
  description?: string;
  type?: string;
  capacityId?: string;
  capacityAssignmentProgress?: string;
}

export interface FabricItem {
  id: string;
  displayName: string;
  description?: string;
  type?: string;
  workspaceId?: string;
}

export interface FabricItemDefinition {
  format?: string;
  parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' | string }>;
}

export interface FabricJobInstance {
  id: string;
  jobType?: string;
  invokeType?: string;
  status?: string;
  rootActivityId?: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  failureReason?: { errorCode?: string; message?: string } | null;
}

export interface MirroringStatus {
  status?: 'Initializing' | 'Initialized' | 'Running' | 'Stopping' | 'Stopped' | 'Failed' | string;
}

export interface TableMirroringStatus {
  continuationToken?: string;
  data?: Array<{
    sourceSchemaName?: string;
    sourceTableName?: string;
    status?: string;
    metrics?: { processedBytes?: number; processedRows?: number; lastSyncDateTime?: string };
  }>;
}

// ============================================================
// Workspaces
// ============================================================

export async function listFabricWorkspaces(): Promise<FabricWorkspace[]> {
  const j = await call<{ value: FabricWorkspace[] }>('/workspaces');
  return j.value || [];
}

// ============================================================
// Capacities — F-SKU + P-SKU surfaced by Fabric REST
// ============================================================

export interface FabricCapacity {
  id: string;
  displayName: string;
  sku: string;           // F2 / F4 / F8 / F16 / F32 / F64 / F128 / F256 / F512 / F1024 / F2048; P1 / P2 / P3 / EM1 / EM2 / EM3
  region?: string;
  state?: string;        // Active / Suspended / Provisioning
  capacityType?: string; // 'Fabric' | 'PowerBI'
}

/**
 * List the Fabric / Power BI Premium capacities the Console UAMI can
 * see. Drives the workspace-create Capacity dropdown so the user picks
 * a real, addressable capacity instead of typing free text.
 *
 * Requires the Power BI tenant SP toggle ("Service principals can use
 * Fabric APIs") + the UAMI added as a Capacity Admin or Contributor on
 * each capacity the customer wants surfaced.
 */
export async function listFabricCapacities(): Promise<FabricCapacity[]> {
  const j = await call<{ value: FabricCapacity[] }>('/capacities');
  return j.value || [];
}

// --- ARM-side capacity SKU update -----------------------------------
// Fabric REST exposes /v1/capacities (read), but the scale-axis SKU
// change is an ARM PATCH against Microsoft.Fabric/capacities/{name}.
// Power BI Premium capacities use Microsoft.PowerBIDedicated/capacities.
// We let the caller pass the resource id so the BFF can resolve either.

const ARM_SCOPE = armScope();
const FABRIC_CAPACITY_API = '2023-11-01';
const POWERBI_CAPACITY_API = '2021-01-01';

async function getArmToken(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new FabricError('Failed to acquire ARM token for Fabric capacity', 401, undefined, undefined, fabricHint(401));
  return t.token;
}

/**
 * PATCH Microsoft.Fabric/capacities/{name} sku.name = newSku, or
 * Microsoft.PowerBIDedicated/capacities/{name} for Premium P-SKUs.
 *
 * resourceId must be the full ARM id including /providers/.
 * The Console UAMI needs Capacity Contributor (or "Power BI Embedded
 * Capacity Contributor" for PowerBIDedicated).
 */
export async function updateCapacitySku(
  resourceId: string,
  newSku: string,
): Promise<{ provisioningState?: string; sku?: { name?: string; tier?: string } }> {
  const isPowerBI = resourceId.toLowerCase().includes('/microsoft.powerbidedicated/');
  const apiVersion = isPowerBI ? POWERBI_CAPACITY_API : FABRIC_CAPACITY_API;
  const tier = isPowerBI ? 'PBIE_Azure' : 'Fabric';
  const url = `${armBase()}${resourceId}?api-version=${apiVersion}`;
  const token = await getArmToken();
  const res = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sku: { name: newSku, tier } }),
  });
  if (!res.ok && res.status !== 202) {
    const t = await res.text();
    throw new FabricError(
      `updateCapacitySku failed ${res.status}: ${t.slice(0, 300)}`,
      res.status,
      t,
      url,
      'UAMI must have Capacity Contributor on the capacity resource.',
    );
  }
  if (res.status === 202) return { provisioningState: 'Updating' };
  const j: any = await res.json().catch(() => ({}));
  return { provisioningState: j?.properties?.provisioningState, sku: j?.sku };
}

/**
 * Assign an existing Fabric/Power BI workspace to a capacity. Fabric
 * REST: POST /v1/workspaces/{id}/assignToCapacity { capacityId }.
 * Returns 202 — assignment is async; capacity binding takes 30-90s to
 * propagate before notebook/lakehouse create calls accept the workspace.
 *
 * Loom workspaces aren't 1:1 Fabric workspaces — this is intended for
 * the underlying Fabric/Power BI workspace that Loom creates lazily on
 * first PBI-backed artifact (Report, Semantic Model, etc.). When called
 * with a Loom workspace id, the route MUST first resolve the bound
 * Fabric/Power BI workspaceId via the workspace's metadata.
 */
export async function assignWorkspaceToCapacity(
  fabricWorkspaceId: string,
  capacityId: string,
): Promise<void> {
  await call<void>(
    `/workspaces/${encodeURIComponent(fabricWorkspaceId)}/assignToCapacity`,
    { method: 'POST', body: { capacityId } },
  );
}

// ============================================================
// Notebook (Fabric)
// ============================================================

export async function listNotebooks(workspaceId: string): Promise<FabricItem[]> {
  const j = await call<{ value: FabricItem[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/notebooks`);
  return j.value || [];
}

export async function getNotebook(workspaceId: string, id: string): Promise<FabricItem> {
  return call<FabricItem>(`/workspaces/${encodeURIComponent(workspaceId)}/notebooks/${encodeURIComponent(id)}`);
}

export async function getNotebookDefinition(workspaceId: string, id: string, format?: string): Promise<FabricItemDefinition | { _accepted: true; location?: string }> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/notebooks/${encodeURIComponent(id)}/getDefinition`,
    { method: 'POST', body: format ? { format } : undefined, acceptLongRunning: true },
  );
}

export async function createNotebook(
  workspaceId: string,
  body: { displayName: string; description?: string; definition?: FabricItemDefinition },
): Promise<FabricItem> {
  return call<FabricItem>(
    `/workspaces/${encodeURIComponent(workspaceId)}/notebooks`,
    { method: 'POST', body },
  );
}

export async function updateNotebookDefinition(
  workspaceId: string,
  id: string,
  definition: FabricItemDefinition,
): Promise<{ _accepted: true; location?: string }> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/notebooks/${encodeURIComponent(id)}/updateDefinition`,
    { method: 'POST', body: { definition }, acceptLongRunning: true },
  );
}

export async function deleteNotebook(workspaceId: string, id: string): Promise<void> {
  await call(`/workspaces/${encodeURIComponent(workspaceId)}/notebooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function runNotebook(
  workspaceId: string,
  id: string,
  executionData?: { parameters?: Record<string, { value: unknown; type?: string }>; configuration?: Record<string, unknown> },
): Promise<{ _accepted: true; location?: string }> {
  const body = executionData ? { executionData } : undefined;
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(id)}/jobs/instances`,
    { method: 'POST', body, query: { jobType: 'RunNotebook' }, acceptLongRunning: true },
  );
}

// ============================================================
// Long-running operation polling (async 202 follow-up)
//
// Every Fabric LRO (create/run notebook, run pipeline, refresh dataflow,
// deploy stage, git commit/update, mirroring start/stop) returns a 202 with a
// `Location` header that this client surfaces as `{ _accepted, location }`. The
// caller polls that Location URL to drive the operation to a terminal state
// (Succeeded / Failed). Without a poll the model only ever sees the receipt,
// never the result — so this closes the async gap honestly.
//
// Docs: https://learn.microsoft.com/rest/api/fabric/articles/long-running-operation
//   GET {operationUrl}          → { status, percentComplete, error }
//   GET {operationUrl}/result   → the operation's result payload (when Succeeded)
// ============================================================

export interface FabricOperationState {
  status?: 'NotStarted' | 'Running' | 'Succeeded' | 'Failed' | string;
  percentComplete?: number;
  createdTimeUtc?: string;
  lastUpdatedTimeUtc?: string;
  error?: { errorCode?: string; message?: string } | null;
  /** Retry-After hint (seconds) when Fabric returns one. */
  retryAfter?: number;
  /** The operation's result payload, fetched when the operation has Succeeded. */
  result?: unknown;
}

/**
 * Resolve a `Location` header value (or a bare operation id) into a fully
 * qualified Fabric operations URL. Fabric returns an absolute URL in the
 * Location header (`https://api.fabric.microsoft.com/v1/operations/{guid}`),
 * but we accept a relative `/operations/{guid}` path or a bare guid too so
 * callers can pass whatever they captured.
 */
function operationUrl(locationOrId: string): string {
  const v = (locationOrId || '').trim();
  if (!v) throw new FabricError('operation location/id is required', 400);
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('/')) return `${FABRIC_BASE.replace(/\/v1$/, '')}${v.startsWith('/v1') ? v : `/v1${v}`}`;
  return `${FABRIC_BASE}/operations/${encodeURIComponent(v)}`;
}

/**
 * GET a Fabric long-running-operation status by its Location URL (or operation
 * id). When the operation has Succeeded this also fetches the `/result`
 * sub-resource so the model gets the real payload, not just "Succeeded". A
 * still-running operation returns `status:'Running'` (+ `retryAfter`) so the
 * caller can poll again. Real Fabric REST — no mocks.
 */
export async function getOperationState(locationOrId: string): Promise<FabricOperationState> {
  const url = operationUrl(locationOrId);
  const token = await getToken();
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.errorCode ? `${json.errorCode}: ${json.message || ''}` : json?.message || text || `poll operation failed`).toString();
    throw new FabricError(msg, res.status, json || text, url, fabricHint(res.status));
  }
  const retryAfterHeader = res.headers.get('retry-after');
  const state: FabricOperationState = {
    status: json?.status,
    percentComplete: json?.percentComplete,
    createdTimeUtc: json?.createdTimeUtc,
    lastUpdatedTimeUtc: json?.lastUpdatedTimeUtc,
    error: json?.error ?? null,
    retryAfter: retryAfterHeader ? Number(retryAfterHeader) : undefined,
  };
  if (state.status === 'Succeeded') {
    // Fetch the result payload (best-effort — some operations have no result body).
    try {
      const rRes = await fetchWithTimeout(`${url.replace(/\/result$/, '')}/result`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        cache: 'no-store',
      });
      if (rRes.ok) {
        const rText = await rRes.text();
        try { state.result = rText ? JSON.parse(rText) : undefined; } catch { state.result = rText || undefined; }
      }
    } catch { /* result is optional — status already reflects success */ }
  }
  return state;
}

// ============================================================
// Data Pipeline (Fabric)
// ============================================================

export async function listDataPipelines(workspaceId: string): Promise<FabricItem[]> {
  const j = await call<{ value: FabricItem[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/dataPipelines`);
  return j.value || [];
}

export async function getDataPipeline(workspaceId: string, id: string): Promise<FabricItem> {
  return call<FabricItem>(`/workspaces/${encodeURIComponent(workspaceId)}/dataPipelines/${encodeURIComponent(id)}`);
}

export async function getDataPipelineDefinition(workspaceId: string, id: string): Promise<FabricItemDefinition | { _accepted: true; location?: string }> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/dataPipelines/${encodeURIComponent(id)}/getDefinition`,
    { method: 'POST', acceptLongRunning: true },
  );
}

export async function upsertDataPipeline(
  workspaceId: string,
  body: { id?: string; displayName: string; description?: string; definition?: FabricItemDefinition },
): Promise<FabricItem | { _accepted: true; location?: string }> {
  if (body.id) {
    if (body.definition) {
      return call(
        `/workspaces/${encodeURIComponent(workspaceId)}/dataPipelines/${encodeURIComponent(body.id)}/updateDefinition`,
        { method: 'POST', body: { definition: body.definition }, acceptLongRunning: true },
      );
    }
    return call<FabricItem>(
      `/workspaces/${encodeURIComponent(workspaceId)}/dataPipelines/${encodeURIComponent(body.id)}`,
      { method: 'PATCH', body: { displayName: body.displayName, description: body.description } },
    );
  }
  return call<FabricItem>(
    `/workspaces/${encodeURIComponent(workspaceId)}/dataPipelines`,
    { method: 'POST', body: { displayName: body.displayName, description: body.description, definition: body.definition } },
  );
}

export async function deleteDataPipeline(workspaceId: string, id: string): Promise<void> {
  await call(`/workspaces/${encodeURIComponent(workspaceId)}/dataPipelines/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function runDataPipeline(
  workspaceId: string,
  id: string,
  executionData?: { parameters?: Record<string, unknown> },
): Promise<{ _accepted: true; location?: string }> {
  const body = executionData ? { executionData } : undefined;
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(id)}/jobs/instances`,
    { method: 'POST', body, query: { jobType: 'Pipeline' }, acceptLongRunning: true },
  );
}

// ============================================================
// Dataflow Gen2 (Fabric)
// ============================================================

export async function listDataflows(workspaceId: string): Promise<FabricItem[]> {
  const j = await call<{ value: FabricItem[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/dataflows`);
  return j.value || [];
}

export async function getDataflow(workspaceId: string, id: string): Promise<FabricItem> {
  return call<FabricItem>(`/workspaces/${encodeURIComponent(workspaceId)}/dataflows/${encodeURIComponent(id)}`);
}

export async function getDataflowDefinition(workspaceId: string, id: string): Promise<FabricItemDefinition | { _accepted: true; location?: string }> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/dataflows/${encodeURIComponent(id)}/getDefinition`,
    { method: 'POST', acceptLongRunning: true },
  );
}

export async function upsertDataflow(
  workspaceId: string,
  body: { id?: string; displayName: string; description?: string; definition?: FabricItemDefinition },
): Promise<FabricItem | { _accepted: true; location?: string }> {
  if (body.id) {
    if (body.definition) {
      return call(
        `/workspaces/${encodeURIComponent(workspaceId)}/dataflows/${encodeURIComponent(body.id)}/updateDefinition`,
        { method: 'POST', body: { definition: body.definition }, acceptLongRunning: true },
      );
    }
    return call<FabricItem>(
      `/workspaces/${encodeURIComponent(workspaceId)}/dataflows/${encodeURIComponent(body.id)}`,
      { method: 'PATCH', body: { displayName: body.displayName, description: body.description } },
    );
  }
  return call<FabricItem>(
    `/workspaces/${encodeURIComponent(workspaceId)}/dataflows`,
    { method: 'POST', body: { displayName: body.displayName, description: body.description, definition: body.definition } },
  );
}

export async function deleteDataflow(workspaceId: string, id: string): Promise<void> {
  await call(`/workspaces/${encodeURIComponent(workspaceId)}/dataflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function refreshDataflow(
  workspaceId: string,
  id: string,
): Promise<{ _accepted: true; location?: string }> {
  // Fabric dataflows are refreshed by triggering a Refresh job on the item.
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(id)}/jobs/instances`,
    { method: 'POST', query: { jobType: 'Refresh' }, acceptLongRunning: true },
  );
}

// ============================================================
// Mirrored Database (Fabric)
// ============================================================

export async function listMirroredDatabases(workspaceId: string): Promise<FabricItem[]> {
  const j = await call<{ value: FabricItem[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/mirroredDatabases`);
  return j.value || [];
}

export async function getMirroredDatabase(workspaceId: string, id: string): Promise<FabricItem> {
  return call<FabricItem>(`/workspaces/${encodeURIComponent(workspaceId)}/mirroredDatabases/${encodeURIComponent(id)}`);
}

export async function getMirroredDatabaseDefinition(workspaceId: string, id: string): Promise<FabricItemDefinition | { _accepted: true; location?: string }> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/mirroredDatabases/${encodeURIComponent(id)}/getDefinition`,
    { method: 'POST', acceptLongRunning: true },
  );
}

export async function createMirroredDatabase(
  workspaceId: string,
  body: { displayName: string; description?: string; definition?: FabricItemDefinition },
): Promise<FabricItem | { _accepted: true; location?: string }> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/mirroredDatabases`,
    { method: 'POST', body, acceptLongRunning: true },
  );
}

export async function updateMirroredDatabaseDefinition(
  workspaceId: string,
  id: string,
  definition: FabricItemDefinition,
): Promise<{ _accepted: true; location?: string }> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/mirroredDatabases/${encodeURIComponent(id)}/updateDefinition`,
    { method: 'POST', body: { definition }, acceptLongRunning: true },
  );
}

export async function deleteMirroredDatabase(workspaceId: string, id: string): Promise<void> {
  await call(`/workspaces/${encodeURIComponent(workspaceId)}/mirroredDatabases/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function startMirroredDatabase(workspaceId: string, id: string): Promise<void> {
  await call(
    `/workspaces/${encodeURIComponent(workspaceId)}/mirroredDatabases/${encodeURIComponent(id)}/startMirroring`,
    { method: 'POST', acceptLongRunning: true },
  );
}

export async function stopMirroredDatabase(workspaceId: string, id: string): Promise<void> {
  await call(
    `/workspaces/${encodeURIComponent(workspaceId)}/mirroredDatabases/${encodeURIComponent(id)}/stopMirroring`,
    { method: 'POST', acceptLongRunning: true },
  );
}

export async function getMirroringStatus(workspaceId: string, id: string): Promise<MirroringStatus> {
  return call<MirroringStatus>(
    `/workspaces/${encodeURIComponent(workspaceId)}/mirroredDatabases/${encodeURIComponent(id)}/getMirroringStatus`,
    { method: 'POST' },
  );
}

export async function getTablesMirroringStatus(workspaceId: string, id: string): Promise<TableMirroringStatus> {
  return call<TableMirroringStatus>(
    `/workspaces/${encodeURIComponent(workspaceId)}/mirroredDatabases/${encodeURIComponent(id)}/getTablesMirroringStatus`,
    { method: 'POST' },
  );
}

// ============================================================
// Eventstream (Fabric Real-Time Intelligence)
//
// Publishes the visual-designer topology to a real Fabric Eventstream
// item via the definition-based REST API. The topology is carried as a
// Base64-encoded `eventstream.json` part (Fabric's documented format).
//
// Docs: https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/eventstream-rest-api
//
// Node-level Pause/Resume (Activate/Deactivate) is a portal-only toggle —
// it is NOT in the public REST surface — so the editor discloses that
// honestly rather than shipping a dead "Start" button.
// ============================================================

export async function listEventstreams(workspaceId: string): Promise<FabricItem[]> {
  const j = await call<{ value: FabricItem[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/eventstreams`);
  return j.value || [];
}

export async function getEventstream(workspaceId: string, id: string): Promise<FabricItem> {
  return call<FabricItem>(`/workspaces/${encodeURIComponent(workspaceId)}/eventstreams/${encodeURIComponent(id)}`);
}

export async function getEventstreamDefinition(
  workspaceId: string,
  id: string,
): Promise<FabricItemDefinition | { _accepted: true; location?: string }> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/eventstreams/${encodeURIComponent(id)}/getDefinition`,
    { method: 'POST', acceptLongRunning: true },
  );
}

/**
 * Build the Fabric Eventstream item definition from a topology object.
 * Fabric expects a single `eventstream.json` part, Base64-encoded.
 */
export function buildEventstreamDefinition(topology: unknown): FabricItemDefinition {
  const payload = Buffer.from(JSON.stringify(topology), 'utf-8').toString('base64');
  return {
    parts: [{ path: 'eventstream.json', payload, payloadType: 'InlineBase64' }],
  };
}

/**
 * Create (or update) a Fabric Eventstream with the supplied topology.
 * If `id` is provided, updates the existing item's definition; otherwise
 * creates a new Eventstream item in the workspace. Returns the created
 * item or a long-running operation handle (202).
 */
export async function publishEventstream(
  workspaceId: string,
  body: { id?: string; displayName: string; description?: string; topology: unknown },
): Promise<FabricItem | { _accepted: true; location?: string }> {
  const definition = buildEventstreamDefinition(body.topology);
  if (body.id) {
    return call(
      `/workspaces/${encodeURIComponent(workspaceId)}/eventstreams/${encodeURIComponent(body.id)}/updateDefinition`,
      { method: 'POST', body: { definition }, acceptLongRunning: true },
    );
  }
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/eventstreams`,
    { method: 'POST', body: { displayName: body.displayName, description: body.description, definition }, acceptLongRunning: true },
  );
}

export async function deleteEventstream(workspaceId: string, id: string): Promise<void> {
  await call(`/workspaces/${encodeURIComponent(workspaceId)}/eventstreams/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ============================================================
// Real-Time Hub — Microsoft / Fabric / Azure source connectors
//
// The Fabric Real-Time Hub is the tenant-wide place to discover all
// streaming data and connect to Microsoft sources. There is no separate
// "Real-Time Hub REST API"; the hub is composed on top of the Eventstream
// REST surface (create an Eventstream item whose topology includes the
// chosen source) plus per-workspace item listing.
//
// `RTH_SOURCE_TYPES` mirrors the documented Fabric Eventstream source
// `type` enum exactly:
//   AmazonKinesis, AmazonMSKKafka, ApacheKafka, AzureCosmosDBCDC,
//   AzureBlobStorageEvents, AzureEventHub, AzureIoTHub, AzureSQLDBCDC,
//   AzureSQLMIDBCDC, ConfluentCloud, CustomEndpoint,
//   FabricCapacityUtilizationEvents, GooglePubSub, MySQLCDC, PostgreSQLCDC,
//   SampleData, FabricWorkspaceItemEvents, FabricJobEvents, FabricOneLakeEvents
//
// Docs:
//   https://learn.microsoft.com/fabric/real-time-hub/real-time-hub-overview
//   https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/eventstream-rest-api
// ============================================================

/** Canonical Fabric Eventstream source `type` enum (Real-Time Hub connectors). */
export const RTH_SOURCE_TYPES = [
  'AzureEventHub',
  'AzureIoTHub',
  'AzureServiceBus',
  'AzureSQLDBCDC',
  'AzureSQLMIDBCDC',
  'AzureCosmosDBCDC',
  'PostgreSQLCDC',
  'MySQLCDC',
  'AzureBlobStorageEvents',
  'AzureEventGridCustomTopic',
  'AmazonKinesis',
  'AmazonMSKKafka',
  'ApacheKafka',
  'ConfluentCloud',
  'GooglePubSub',
  'Mqtt',
  'SampleData',
  'CustomEndpoint',
  'FabricWorkspaceItemEvents',
  'FabricJobEvents',
  'FabricOneLakeEvents',
  'FabricCapacityUtilizationEvents',
] as const;

export type RthSourceType = (typeof RTH_SOURCE_TYPES)[number];

export function isRthSourceType(t: string): t is RthSourceType {
  return (RTH_SOURCE_TYPES as readonly string[]).includes(t);
}

/**
 * Build a single-source Eventstream topology in the documented Fabric
 * shape { sources[], destinations[], operators[], streams[] }. The source
 * `type` MUST be one of `RTH_SOURCE_TYPES`; `properties` carries the
 * source-specific connection settings (e.g. dataConnectionId,
 * consumerGroupName for AzureEventHub). A DefaultStream is always emitted
 * so the new stream shows up in Real-Time Hub's All-data-streams list.
 */
export function buildSourceTopology(input: {
  displayName: string;
  sourceName: string;
  sourceType: RthSourceType;
  properties?: Record<string, unknown>;
}): {
  sources: Array<{ name: string; type: string; properties: Record<string, unknown> }>;
  destinations: never[];
  operators: never[];
  streams: Array<{ name: string; type: string; properties: Record<string, unknown> }>;
  compatibilityLevel: string;
} {
  const streamName = `${input.sourceName}-stream`;
  return {
    sources: [{ name: input.sourceName, type: input.sourceType, properties: input.properties || {} }],
    destinations: [],
    operators: [],
    streams: [{ name: streamName, type: 'DefaultStream', properties: { inputNodes: [{ name: input.sourceName }] } }],
    compatibilityLevel: '1.0',
  };
}

/**
 * Real-Time Hub "Connect source" — creates a REAL Fabric Eventstream item
 * carrying the chosen Microsoft/Fabric/Azure source. Backed by
 * POST /workspaces/{ws}/eventstreams with a Base64 eventstream.json part
 * (the same definition REST API the Eventstream editor publishes through).
 */
export async function connectEventstreamSource(
  fabricWorkspaceId: string,
  input: {
    displayName: string;
    description?: string;
    sourceName: string;
    sourceType: RthSourceType;
    properties?: Record<string, unknown>;
  },
): Promise<FabricItem | { _accepted: true; location?: string }> {
  if (!fabricWorkspaceId) throw new FabricError('fabricWorkspaceId is required', 400);
  if (!input?.displayName) throw new FabricError('displayName is required', 400);
  if (!isRthSourceType(input.sourceType)) {
    throw new FabricError(`Unsupported source type "${input.sourceType}". Allowed: ${RTH_SOURCE_TYPES.join(', ')}`, 400);
  }
  const topology = buildSourceTopology({
    displayName: input.displayName,
    sourceName: input.sourceName || 'source-1',
    sourceType: input.sourceType,
    properties: input.properties,
  });
  const definition = buildEventstreamDefinition(topology);
  return call(
    `/workspaces/${encodeURIComponent(fabricWorkspaceId)}/eventstreams`,
    {
      method: 'POST',
      body: { displayName: input.displayName, description: input.description, definition },
      acceptLongRunning: true,
    },
  );
}

// ============================================================
// KQL Databases (Real-Time Intelligence) — for Real-Time Hub
// "All data streams" KQL-table rows. Listed per workspace.
// ============================================================

export async function listKqlDatabases(workspaceId: string): Promise<FabricItem[]> {
  const j = await call<{ value: FabricItem[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/kqlDatabases`);
  return j.value || [];
}

export async function listEventhouses(workspaceId: string): Promise<FabricItem[]> {
  const j = await call<{ value: FabricItem[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/eventhouses`);
  return j.value || [];
}

// ============================================================
// Job instances (history)
// ============================================================

export async function listJobInstances(workspaceId: string, itemId: string): Promise<FabricJobInstance[]> {
  const j = await call<{ value: FabricJobInstance[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/jobs/instances`,
  );
  return j.value || [];
}

// ============================================================
// Lakehouse + OneLake shortcuts (cross-source promotion)
// ============================================================

export interface OneLakeShortcutTarget {
  adlsGen2?: {
    location: string;        // e.g. https://account.dfs.core.windows.net
    subpath: string;         // /container/folder
    connectionId?: string;   // optional managed connection id
  };
  amazonS3?: { location: string; subpath: string; connectionId?: string };
  googleCloudStorage?: { location: string; subpath: string; connectionId?: string };
  oneLake?: {
    workspaceId: string;
    itemId: string;
    path: string;
  };
}

export interface OneLakeShortcutRequest {
  /** Lakehouse / Warehouse / KQL DB hosting the shortcut. */
  itemId: string;
  /** Logical path inside the item (e.g. `Files/bronze` or `Tables/customers`). */
  path: string;
  /** Shortcut name. */
  name: string;
  /** Where the shortcut points to. Exactly one target sub-field must be set. */
  target: OneLakeShortcutTarget;
}

export interface OneLakeShortcut {
  name: string;
  path: string;
  target?: OneLakeShortcutTarget;
}

/**
 * Create an ADLS-backed (or S3 / GCS / cross-OneLake) shortcut inside a
 * Fabric Lakehouse. Backend: POST /workspaces/{ws}/items/{itemId}/shortcuts.
 *
 * Docs: https://learn.microsoft.com/rest/api/fabric/core/onelake-shortcuts/create-shortcut
 *
 * Used by the Unified Catalog `/api/catalog/shortcut` BFF route to promote
 * an arbitrary ADLS Gen2 path into a OneLake-visible asset without copying
 * bytes.
 */
export async function createOneLakeShortcut(
  workspaceId: string,
  req: OneLakeShortcutRequest,
): Promise<OneLakeShortcut> {
  if (!workspaceId) throw new FabricError('workspaceId is required', 400);
  if (!req?.itemId) throw new FabricError('itemId is required', 400);
  if (!req?.name) throw new FabricError('shortcut name is required', 400);
  if (!req?.target || Object.keys(req.target).length === 0) {
    throw new FabricError('target is required (adlsGen2 | amazonS3 | googleCloudStorage | oneLake)', 400);
  }
  return call<OneLakeShortcut>(
    `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(req.itemId)}/shortcuts`,
    {
      method: 'POST',
      body: { name: req.name, path: req.path, target: req.target },
    },
  );
}

export async function listOneLakeShortcuts(workspaceId: string, itemId: string): Promise<OneLakeShortcut[]> {
  const j = await call<{ value?: OneLakeShortcut[] }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/shortcuts`,
  );
  return j.value || [];
}

export async function deleteOneLakeShortcut(workspaceId: string, itemId: string, shortcutPath: string, shortcutName: string): Promise<void> {
  await call(
    `/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}/shortcuts/${encodeURIComponent(shortcutPath)}/${encodeURIComponent(shortcutName)}`,
    { method: 'DELETE' },
  );
}

/** Fabric item details — used by /api/catalog/asset for OneLake assets. */
export async function getFabricItem(workspaceId: string, itemId: string): Promise<FabricItem> {
  return call<FabricItem>(`/workspaces/${encodeURIComponent(workspaceId)}/items/${encodeURIComponent(itemId)}`);
}

// ============================================================
// Fabric SQL databases — the Fabric-managed SQL database type
// (Microsoft.Fabric SQLDatabase REST type), distinct from Azure SQL.
// Backs the SqlDatabaseEditor.
// ============================================================

export async function listFabricSqlDatabases(workspaceId: string): Promise<FabricItem[]> {
  const j = await call<{ value: FabricItem[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/SqlDatabases`);
  return j.value || [];
}

export async function getFabricSqlDatabase(workspaceId: string, id: string): Promise<FabricItem> {
  return call<FabricItem>(`/workspaces/${encodeURIComponent(workspaceId)}/SqlDatabases/${encodeURIComponent(id)}`);
}

/**
 * Resolve the TDS connection (server FQDN + database name) of a Fabric SQL
 * database. Fabric returns `properties.connectionString` (the SQL server,
 * `<id>.database.fabric.microsoft.com`) and `properties.databaseName`
 * (`<displayName>-<id>`). The same `mssql`/`tedious` engine the Azure SQL
 * client uses connects here with the `https://database.windows.net/.default`
 * AAD token. Returns `null` when Fabric hasn't surfaced the connection yet
 * (newly-provisioned DB), so the navigator shows the honest gate.
 */
export async function getFabricSqlDatabaseConnection(
  workspaceId: string,
  id: string,
): Promise<{ server: string; database: string } | null> {
  const item = await call<any>(
    `/workspaces/${encodeURIComponent(workspaceId)}/SqlDatabases/${encodeURIComponent(id)}`,
  );
  const props = item?.properties || {};
  const server = String(props.serverFqdn || props.connectionString || '').trim();
  const database = String(props.databaseName || item?.displayName || '').trim();
  if (!server || !database) return null;
  return { server, database };
}

export async function createFabricSqlDatabase(
  workspaceId: string,
  body: { displayName: string; description?: string; definition?: FabricItemDefinition },
): Promise<FabricItem | { _accepted: true; location?: string }> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/SqlDatabases`,
    { method: 'POST', body, acceptLongRunning: true },
  );
}

export async function deleteFabricSqlDatabase(workspaceId: string, id: string): Promise<void> {
  await call(
    `/workspaces/${encodeURIComponent(workspaceId)}/SqlDatabases/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

// ============================================================
// Deployment Pipelines (Fabric CI/CD)
//
// The Fabric Deployment Pipelines experience — dev → test → prod stages,
// each bound to a Fabric workspace, with content promotion between stages.
//
// Docs:
//   https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines
//   https://learn.microsoft.com/fabric/cicd/deployment-pipelines/pipeline-automation-fabric
//
// Surface:
//   GET  /v1/deploymentPipelines                          → list pipelines
//   GET  /v1/deploymentPipelines/{id}                     → get one pipeline
//   GET  /v1/deploymentPipelines/{id}/stages              → list stages
//   GET  /v1/deploymentPipelines/{id}/stages/{sid}/items  → items in a stage
//   POST /v1/deploymentPipelines/{id}/deploy              → deploy stage→stage (LRO)
//   GET  /v1/deploymentPipelines/{id}/operations          → deployment history
//
// Auth + gating identical to the rest of this client: Console UAMI needs an
// *admin* deployment-pipelines role and contributor on the stage workspaces.
// 401/403 surface the same FabricError hint so the BFF can show the gate.
// ============================================================

export interface DeploymentPipeline {
  id: string;
  displayName: string;
  description?: string;
}

export interface DeploymentPipelineStage {
  id: string;
  order: number;
  displayName: string;
  description?: string;
  /** Assigned workspace id — only present when a workspace is assigned. */
  workspaceId?: string;
  /** Assigned workspace name — only present when assigned + visible to caller. */
  workspaceName?: string;
  isPublic?: boolean;
}

export interface DeploymentPipelineStageItem {
  itemId: string;
  itemDisplayName: string;
  itemType: string;
  sourceItemId?: string;
  targetItemId?: string;
  lastDeploymentTime?: string;
}

export interface DeploymentPipelineOperation {
  id: string;
  type?: string;            // 'Deploy'
  status?: string;          // NotStarted | Running | Succeeded | Failed
  sourceStageId?: string;
  targetStageId?: string;
  executionStartTime?: string;
  executionEndTime?: string;
  lastUpdatedTime?: string;
  note?: string;
  performedBy?: string;
}

export interface DeployItemRef {
  sourceItemId: string;
  itemType: string;
}

export interface DeployStageRequest {
  sourceStageId: string;
  targetStageId: string;
  /** Optional selective list; when omitted Fabric deploys all supported items. */
  items?: DeployItemRef[];
  note?: string;
  /** Required only when the target stage has no assigned workspace. */
  createdWorkspaceDetails?: { name: string; capacityId?: string };
}

/** GET /v1/deploymentPipelines — every pipeline the UAMI can see. Paginates. */
export async function listDeploymentPipelines(): Promise<DeploymentPipeline[]> {
  const out: DeploymentPipeline[] = [];
  let token: string | undefined;
  let guard = 0;
  do {
    guard++;
    const j = await call<{ value: DeploymentPipeline[]; continuationToken?: string }>(
      '/deploymentPipelines',
      { query: token ? { continuationToken: token } : undefined },
    );
    for (const p of j.value || []) out.push(p);
    token = j.continuationToken;
  } while (token && guard < 50);
  return out;
}

/** GET /v1/deploymentPipelines/{id} — pipeline metadata. */
export async function getDeploymentPipeline(id: string): Promise<DeploymentPipeline> {
  return call<DeploymentPipeline>(`/deploymentPipelines/${encodeURIComponent(id)}`);
}

/** GET /v1/deploymentPipelines/{id}/stages — ordered stages (dev/test/prod). */
export async function listDeploymentPipelineStages(id: string): Promise<DeploymentPipelineStage[]> {
  const out: DeploymentPipelineStage[] = [];
  let token: string | undefined;
  let guard = 0;
  do {
    guard++;
    const j = await call<{ value: DeploymentPipelineStage[]; continuationToken?: string }>(
      `/deploymentPipelines/${encodeURIComponent(id)}/stages`,
      { query: token ? { continuationToken: token } : undefined },
    );
    for (const s of j.value || []) out.push(s);
    token = j.continuationToken;
  } while (token && guard < 50);
  out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return out;
}

/**
 * GET /v1/deploymentPipelines/{id}/stages/{stageId}/items — the supported
 * items in the workspace assigned to a stage. Returns [] when the stage has
 * no assigned workspace (Fabric 400s on an empty stage; we treat that as
 * empty rather than an error).
 */
export async function listDeploymentPipelineStageItems(
  id: string,
  stageId: string,
): Promise<DeploymentPipelineStageItem[]> {
  const j = await call<{ value: DeploymentPipelineStageItem[] }>(
    `/deploymentPipelines/${encodeURIComponent(id)}/stages/${encodeURIComponent(stageId)}/items`,
  );
  return j.value || [];
}

/**
 * POST /v1/deploymentPipelines/{id}/deploy — promote content from the source
 * stage to the (consecutive) target stage. Long-running: returns a 202 with a
 * Location/operation handle, surfaced here as { _accepted, location }.
 */
export async function deployStageContent(
  id: string,
  req: DeployStageRequest,
): Promise<{ _accepted: true; location?: string } | DeploymentPipelineOperation> {
  if (!req?.sourceStageId) throw new FabricError('sourceStageId is required', 400);
  if (!req?.targetStageId) throw new FabricError('targetStageId is required', 400);
  const body: Record<string, unknown> = {
    sourceStageId: req.sourceStageId,
    targetStageId: req.targetStageId,
  };
  if (req.items && req.items.length) body.items = req.items;
  if (req.note) body.note = req.note;
  if (req.createdWorkspaceDetails) body.createdWorkspaceDetails = req.createdWorkspaceDetails;
  return call(
    `/deploymentPipelines/${encodeURIComponent(id)}/deploy`,
    { method: 'POST', body, acceptLongRunning: true },
  );
}

/** GET /v1/deploymentPipelines/{id}/operations — deployment history. Paginates. */
export async function listDeploymentPipelineOperations(
  id: string,
): Promise<DeploymentPipelineOperation[]> {
  const out: DeploymentPipelineOperation[] = [];
  let token: string | undefined;
  let guard = 0;
  do {
    guard++;
    const j = await call<{ value: any[]; continuationToken?: string }>(
      `/deploymentPipelines/${encodeURIComponent(id)}/operations`,
      { query: token ? { continuationToken: token } : undefined },
    );
    for (const o of j.value || []) {
      out.push({
        id: o.id,
        type: o.type,
        status: o.status,
        sourceStageId: o.sourceStageId,
        targetStageId: o.targetStageId,
        executionStartTime: o.executionStartTime,
        executionEndTime: o.executionEndTime,
        lastUpdatedTime: o.lastUpdatedTime,
        note: typeof o.note === 'string' ? o.note : o.note?.content,
        performedBy: o.performedBy?.displayName || o.performedBy?.userDetails?.userPrincipalName,
      });
    }
    token = j.continuationToken;
  } while (token && guard < 50);
  return out;
}

// --- Pipeline management: create / assign / unassign --------------------
//
// Fabric REST (core/deployment-pipelines):
//   POST /v1/deploymentPipelines                                   create
//   POST /v1/deploymentPipelines/{id}/stages/{sid}/assignWorkspace assign
//   POST /v1/deploymentPipelines/{id}/stages/{sid}/unassignWorkspace unassign
//
// Docs:
//   https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines/create-deployment-pipeline
//   https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines/assign-workspace-to-stage
//   https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines/unassign-workspace-from-stage

export interface CreateDeploymentPipelineStage {
  displayName: string;
  description?: string;
  isPublic?: boolean;
}

/**
 * POST /v1/deploymentPipelines — create a new deployment pipeline with an
 * ordered set of stages (2-10). The number/names of stages are permanent.
 * Requires the Fabric admin tenant toggle "Service principals can create …
 * deployment pipelines" for SPN/UAMI callers.
 */
export async function createDeploymentPipeline(body: {
  displayName: string;
  description?: string;
  stages: CreateDeploymentPipelineStage[];
}): Promise<DeploymentPipeline & { stages?: DeploymentPipelineStage[] }> {
  if (!body?.displayName) throw new FabricError('displayName is required', 400);
  if (!Array.isArray(body.stages) || body.stages.length < 2) {
    throw new FabricError('At least 2 stages are required', 400);
  }
  return call<DeploymentPipeline & { stages?: DeploymentPipelineStage[] }>(
    '/deploymentPipelines',
    {
      method: 'POST',
      body: {
        displayName: body.displayName,
        description: body.description,
        stages: body.stages.map((s) => ({
          displayName: s.displayName,
          description: s.description,
          isPublic: !!s.isPublic,
        })),
      },
    },
  );
}

/**
 * POST /v1/deploymentPipelines/{id}/stages/{stageId}/assignWorkspace —
 * assign a Fabric workspace to a (vacant) stage. Caller must be pipeline
 * admin + workspace admin. Fails if the stage already has a workspace.
 */
export async function assignWorkspaceToStage(
  pipelineId: string,
  stageId: string,
  workspaceId: string,
): Promise<void> {
  if (!pipelineId || !stageId) throw new FabricError('pipelineId and stageId are required', 400);
  if (!workspaceId) throw new FabricError('workspaceId is required', 400);
  await call<void>(
    `/deploymentPipelines/${encodeURIComponent(pipelineId)}/stages/${encodeURIComponent(stageId)}/assignWorkspace`,
    { method: 'POST', body: { workspaceId } },
  );
}

/**
 * POST /v1/deploymentPipelines/{id}/stages/{stageId}/unassignWorkspace —
 * release the workspace from a stage. WARNING: per Fabric, unassigning loses
 * that stage's deployment history and configured deployment rules.
 */
export async function unassignWorkspaceFromStage(
  pipelineId: string,
  stageId: string,
): Promise<void> {
  if (!pipelineId || !stageId) throw new FabricError('pipelineId and stageId are required', 400);
  await call<void>(
    `/deploymentPipelines/${encodeURIComponent(pipelineId)}/stages/${encodeURIComponent(stageId)}/unassignWorkspace`,
    { method: 'POST' },
  );
}

// --- Stage compare / sync status ---------------------------------------
//
// Fabric REST exposes no dedicated "compare" endpoint; the deployment-pipeline
// home page computes the sync status client-side by PAIRING the items of two
// consecutive stages (by itemType + display name, the documented pairing rule)
// and labelling each pair:
//   Same          — present in both, identical (paired, no diff signal)
//   Different      — present in both but changed since last deploy
//   OnlyInSource   — exists in source, not in target ("New" — will be cloned)
//   NotInSource    — exists in target, not in source ("Missing from"/"Not in source")
//
// We approximate the changed/identical signal using lastDeploymentTime: a
// paired target item with no lastDeploymentTime, or a source whose pairing
// can't be confirmed, is surfaced as "Different" so the operator reviews it.
// The honest limitation: Fabric's true per-item content hash isn't in REST, so
// "Same vs Different" is a best-effort pairing signal — the deploy operation's
// preDeploymentDiffInformation is the authoritative count (surfaced post-deploy).
//
// Pairing rule docs:
//   https://learn.microsoft.com/fabric/cicd/deployment-pipelines/compare-pipeline-content
//   https://learn.microsoft.com/rest/api/fabric/core/deployment-pipelines/list-deployment-pipeline-stage-items

export type StageCompareStatus = 'Same' | 'Different' | 'OnlyInSource' | 'NotInSource';

export interface StageComparePair {
  itemType: string;
  /** Source-stage item (the one that would be deployed). */
  sourceItemId?: string;
  sourceItemDisplayName?: string;
  /** Target-stage item (the one that would be overwritten). */
  targetItemId?: string;
  targetItemDisplayName?: string;
  status: StageCompareStatus;
  lastDeploymentTime?: string;
}

export interface StageCompareResult {
  sourceStageId: string;
  targetStageId: string;
  pairs: StageComparePair[];
  summary: { same: number; different: number; onlyInSource: number; notInSource: number };
}

/**
 * Compare a source stage against a target stage by pairing their item lists.
 * Both lists come from List Stage Items (real Fabric REST). Returns per-item
 * compare rows + a roll-up summary that mirrors the green/orange indicator.
 */
export async function compareDeploymentPipelineStages(
  pipelineId: string,
  sourceStageId: string,
  targetStageId: string,
): Promise<StageCompareResult> {
  const [src, tgt] = await Promise.all([
    listDeploymentPipelineStageItems(pipelineId, sourceStageId),
    listDeploymentPipelineStageItems(pipelineId, targetStageId),
  ]);
  const key = (it: DeploymentPipelineStageItem) => `${it.itemType}::${it.itemDisplayName}`.toLowerCase();
  const tgtByKey = new Map<string, DeploymentPipelineStageItem>();
  for (const t of tgt) tgtByKey.set(key(t), t);

  const pairs: StageComparePair[] = [];
  const seenTargets = new Set<string>();

  for (const s of src) {
    const k = key(s);
    const t = tgtByKey.get(k);
    if (t) {
      seenTargets.add(k);
      // Paired. We mark "Different" when the target item has never been
      // deployed-from-this-pairing (no lastDeploymentTime) OR the pairing's
      // source/target deployment timestamps diverge — a best-effort signal.
      const different =
        !t.lastDeploymentTime ||
        (!!s.lastDeploymentTime && s.lastDeploymentTime !== t.lastDeploymentTime);
      pairs.push({
        itemType: s.itemType,
        sourceItemId: s.itemId,
        sourceItemDisplayName: s.itemDisplayName,
        targetItemId: t.itemId,
        targetItemDisplayName: t.itemDisplayName,
        status: different ? 'Different' : 'Same',
        lastDeploymentTime: t.lastDeploymentTime || s.lastDeploymentTime,
      });
    } else {
      pairs.push({
        itemType: s.itemType,
        sourceItemId: s.itemId,
        sourceItemDisplayName: s.itemDisplayName,
        status: 'OnlyInSource',
        lastDeploymentTime: s.lastDeploymentTime,
      });
    }
  }
  for (const t of tgt) {
    if (seenTargets.has(key(t))) continue;
    pairs.push({
      itemType: t.itemType,
      targetItemId: t.itemId,
      targetItemDisplayName: t.itemDisplayName,
      status: 'NotInSource',
      lastDeploymentTime: t.lastDeploymentTime,
    });
  }

  const summary = { same: 0, different: 0, onlyInSource: 0, notInSource: 0 };
  for (const p of pairs) {
    if (p.status === 'Same') summary.same++;
    else if (p.status === 'Different') summary.different++;
    else if (p.status === 'OnlyInSource') summary.onlyInSource++;
    else summary.notInSource++;
  }
  return { sourceStageId, targetStageId, pairs, summary };
}

// ============================================================
// Git integration (CI side) — connect a workspace to Azure DevOps / GitHub,
// view branch/commit/sync status, commit-to-git + update-from-git.
//
// Real Fabric REST (core/git):
//   GET  /v1/workspaces/{ws}/git/connection            connection + state
//   POST /v1/workspaces/{ws}/git/connect               connect (ADO/GitHub)
//   POST /v1/workspaces/{ws}/git/initializeConnection  initialize after connect
//   POST /v1/workspaces/{ws}/git/disconnect            disconnect
//   GET  /v1/workspaces/{ws}/git/status                per-item sync status (LRO)
//   POST /v1/workspaces/{ws}/git/commitToGit           commit (All|Selective, LRO)
//   POST /v1/workspaces/{ws}/git/updateFromGit         update workspace (LRO)
//
// Docs:
//   https://learn.microsoft.com/rest/api/fabric/core/git
//   https://learn.microsoft.com/rest/api/fabric/core/git/connect
//   https://learn.microsoft.com/rest/api/fabric/core/git/get-status
//   https://learn.microsoft.com/rest/api/fabric/core/git/commit-to-git
//   https://learn.microsoft.com/rest/api/fabric/core/git/update-from-git
//
// Gating: connect requires workspace *admin*; status/commit/update require
// *contributor*. Service-principal/UAMI connect is only allowed with a
// ConfiguredConnection (a Git provider credentials connection id). 401/403
// surface the standard FabricError hint.
// ============================================================

export type GitProviderType = 'AzureDevOps' | 'GitHub';
export type GitConnectionState = 'NotConnected' | 'Connected' | 'ConnectedAndInitialized';

export interface GitProviderDetails {
  gitProviderType: GitProviderType;
  branchName?: string;
  directoryName?: string;
  // AzureDevOps
  organizationName?: string;
  projectName?: string;
  repositoryName?: string;
  // GitHub
  ownerName?: string;
  customDomainName?: string;
}

export interface GitConnection {
  gitConnectionState: GitConnectionState;
  gitProviderDetails: GitProviderDetails | null;
  gitSyncDetails: { head?: string; lastSyncTime?: string } | null;
}

export interface GitItemChange {
  itemMetadata: {
    itemIdentifier: { logicalId?: string; objectId?: string };
    itemType: string;
    displayName: string;
  };
  workspaceChange?: 'Added' | 'Deleted' | 'Modified';
  remoteChange?: 'Added' | 'Deleted' | 'Modified';
  conflictType?: 'None' | 'Conflict' | 'SameChanges';
}

export interface GitStatus {
  workspaceHead?: string;
  remoteCommitHash?: string;
  changes: GitItemChange[];
}

/** GET /v1/workspaces/{ws}/git/connection — provider details + connection state. */
export async function getWorkspaceGitConnection(workspaceId: string): Promise<GitConnection> {
  if (!workspaceId) throw new FabricError('workspaceId is required', 400);
  const j = await call<GitConnection>(
    `/workspaces/${encodeURIComponent(workspaceId)}/git/connection`,
  );
  return {
    gitConnectionState: j?.gitConnectionState || 'NotConnected',
    gitProviderDetails: j?.gitProviderDetails || null,
    gitSyncDetails: j?.gitSyncDetails || null,
  };
}

/**
 * POST /v1/workspaces/{ws}/git/connect — connect a workspace to an
 * Azure DevOps or GitHub repo+branch. `connectionId` (a Git provider
 * credentials connection) is required for GitHub and for SPN/UAMI callers.
 */
export async function connectWorkspaceGit(
  workspaceId: string,
  details: GitProviderDetails,
  connectionId?: string,
): Promise<void> {
  if (!workspaceId) throw new FabricError('workspaceId is required', 400);
  if (!details?.gitProviderType) throw new FabricError('gitProviderType is required', 400);
  if (!details.branchName) throw new FabricError('branchName is required', 400);
  if (details.gitProviderType === 'AzureDevOps') {
    if (!details.organizationName || !details.projectName || !details.repositoryName) {
      throw new FabricError('organizationName, projectName, repositoryName are required for AzureDevOps', 400);
    }
  } else if (details.gitProviderType === 'GitHub') {
    if (!details.ownerName || !details.repositoryName) {
      throw new FabricError('ownerName and repositoryName are required for GitHub', 400);
    }
  }
  const body: Record<string, unknown> = { gitProviderDetails: details };
  if (connectionId) {
    body.myGitCredentials = { source: 'ConfiguredConnection', connectionId };
  }
  await call<void>(
    `/workspaces/${encodeURIComponent(workspaceId)}/git/connect`,
    { method: 'POST', body },
  );
}

/** POST /v1/workspaces/{ws}/git/initializeConnection — first-time sync handshake (LRO). */
export async function initializeWorkspaceGitConnection(
  workspaceId: string,
): Promise<{ _accepted: true; location?: string } | { requiredAction?: string; remoteCommitHash?: string; workspaceHead?: string }> {
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/git/initializeConnection`,
    { method: 'POST', body: {}, acceptLongRunning: true },
  );
}

/** POST /v1/workspaces/{ws}/git/disconnect — sever the Git connection. */
export async function disconnectWorkspaceGit(workspaceId: string): Promise<void> {
  await call<void>(
    `/workspaces/${encodeURIComponent(workspaceId)}/git/disconnect`,
    { method: 'POST' },
  );
}

/**
 * GET /v1/workspaces/{ws}/git/status — per-item sync status. LRO: a 202 means
 * Fabric is still computing; the route returns the accepted handle so the UI
 * can retry. On 200 returns workspaceHead + remoteCommitHash + changes[].
 */
export async function getWorkspaceGitStatus(
  workspaceId: string,
): Promise<GitStatus | { _accepted: true; location?: string }> {
  const j = await call<any>(
    `/workspaces/${encodeURIComponent(workspaceId)}/git/status`,
    { acceptLongRunning: true },
  );
  if (j?._accepted) return j;
  return {
    workspaceHead: j?.workspaceHead,
    remoteCommitHash: j?.remoteCommitHash,
    changes: Array.isArray(j?.changes) ? j.changes : [],
  };
}

/**
 * POST /v1/workspaces/{ws}/git/commitToGit — commit workspace changes to the
 * connected branch. mode 'All' commits everything; 'Selective' commits the
 * supplied item identifiers (objectId/logicalId from Git status). LRO.
 */
export async function commitWorkspaceToGit(
  workspaceId: string,
  body: {
    mode: 'All' | 'Selective';
    workspaceHead?: string;
    comment?: string;
    items?: Array<{ objectId?: string; logicalId?: string }>;
  },
): Promise<{ _accepted: true; location?: string } | void> {
  if (!workspaceId) throw new FabricError('workspaceId is required', 400);
  const mode = body?.mode === 'Selective' ? 'Selective' : 'All';
  const payload: Record<string, unknown> = { mode };
  if (body.workspaceHead) payload.workspaceHead = body.workspaceHead;
  if (body.comment) payload.comment = String(body.comment).slice(0, 300);
  if (mode === 'Selective') {
    const items = (body.items || []).filter((i) => i?.objectId || i?.logicalId);
    if (!items.length) throw new FabricError('Selective commit requires at least one item', 400);
    payload.items = items;
  }
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/git/commitToGit`,
    { method: 'POST', body: payload, acceptLongRunning: true },
  );
}

/**
 * POST /v1/workspaces/{ws}/git/updateFromGit — pull commits from the connected
 * branch into the workspace. workspaceHead + remoteCommitHash come from Git
 * status. `allowOverrideItems` lets Fabric overwrite items on conflict. LRO.
 */
export async function updateWorkspaceFromGit(
  workspaceId: string,
  body: {
    workspaceHead?: string;
    remoteCommitHash?: string;
    allowOverrideItems?: boolean;
    conflictResolutionPolicy?: 'PreferWorkspace' | 'PreferRemote';
  },
): Promise<{ _accepted: true; location?: string } | void> {
  if (!workspaceId) throw new FabricError('workspaceId is required', 400);
  const payload: Record<string, unknown> = {};
  if (body.workspaceHead) payload.workspaceHead = body.workspaceHead;
  if (body.remoteCommitHash) payload.remoteCommitHash = body.remoteCommitHash;
  payload.options = { allowOverrideItems: body.allowOverrideItems !== false };
  if (body.conflictResolutionPolicy) {
    payload.conflictResolution = {
      conflictResolutionType: 'Workspace',
      conflictResolutionPolicy: body.conflictResolutionPolicy,
    };
  }
  return call(
    `/workspaces/${encodeURIComponent(workspaceId)}/git/updateFromGit`,
    { method: 'POST', body: payload, acceptLongRunning: true },
  );
}
