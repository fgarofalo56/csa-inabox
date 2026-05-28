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

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
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
  const res = await fetch(url, {
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
