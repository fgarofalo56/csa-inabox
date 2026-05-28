/**
 * Microsoft Fabric OneLake catalog client.
 *
 * Federated catalog of every Fabric workspace item (lakehouses, warehouses,
 * KQL DBs, semantic models, mirrored DBs, notebooks, pipelines) the Console
 * UAMI can see. Backed by:
 *
 *   GET https://api.fabric.microsoft.com/v1/workspaces
 *   GET https://api.fabric.microsoft.com/v1/workspaces/{ws}/items
 *
 * Lineage uses the Fabric Admin REST lineage scan API
 * (https://api.fabric.microsoft.com/v1.0/myorg/admin/workspaces/scanResult/{id}).
 * That endpoint is a preview / capacity-gated surface — see
 * {@link OneLakeLineageNotSupportedError}.
 *
 * Item permissions: the Fabric REST currently exposes role assignments
 * per workspace (not per item) via `/admin/workspaces/{id}/users`. We expose
 * `listWorkspaceUsers` + `addWorkspaceUser` so the Permissions tab can fan
 * out per-workspace; the unified permission matrix maps a Loom role to
 * Fabric workspace roles per the convention in docs/fiab/catalog/permissions.md.
 *
 * No mocks. No `return []`. All calls hit api.fabric.microsoft.com.
 */
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_ADMIN_BASE =
  process.env.LOOM_FABRIC_ADMIN_BASE || 'https://api.fabric.microsoft.com/v1.0/myorg/admin';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

// ============================================================
// Errors
// ============================================================
export class OneLakeError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  hint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string, hint?: string) {
    super(message);
    this.name = 'OneLakeError';
    this.status = status; this.body = body; this.endpoint = endpoint; this.hint = hint;
  }
}

export class OneLakeLineageNotSupportedError extends OneLakeError {
  constructor(workspaceId: string) {
    super(
      `Fabric admin lineage scan is preview-only and requires the tenant flight flag "Enable lineage and impact analysis API". Tenant admin must enable it via Fabric admin portal → Tenant settings → Admin API settings.`,
      501,
      undefined,
      `${FABRIC_ADMIN_BASE}/workspaces/${workspaceId}/scanResult`,
      'Tenant admin → Fabric admin portal → Tenant settings → "Admin API settings" → enable "Enhance admin APIs responses with detailed metadata" and add the Loom UAMI to a security group that the setting applies to.',
    );
  }
}

// ============================================================
// Auth helper
// ============================================================
async function token(): Promise<string> {
  const t = await credential.getToken(FABRIC_SCOPE);
  if (!t?.token) throw new OneLakeError('Failed to acquire Fabric token', 401);
  return t.token;
}

async function call<T = any>(base: string, path: string, init?: { method?: string; body?: unknown; query?: Record<string, string> }): Promise<T> {
  const tok = await token();
  let url = `${base}${path}`;
  if (init?.query) {
    const qs = new URLSearchParams(init.query).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(url, {
    method: init?.method || 'GET',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json' },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  const txt = await res.text();
  let json: any = null; try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  if (!res.ok) {
    if (res.status === 501 || (res.status === 400 && /flight/i.test(txt))) {
      throw new OneLakeLineageNotSupportedError(path);
    }
    const msg = json?.errorCode ? `${json.errorCode}: ${json.message || ''}` : json?.message || txt || `${res.status}`;
    throw new OneLakeError(msg, res.status, json, url);
  }
  return (json as T) ?? ({} as T);
}

// ============================================================
// Types
// ============================================================

export interface OneLakeWorkspace {
  id: string;
  displayName: string;
  description?: string;
  type?: string;
  capacityId?: string;
}

export interface OneLakeItem {
  id: string;
  workspaceId: string;
  workspaceName?: string;
  displayName: string;
  description?: string;
  type?: string;     // Lakehouse, Warehouse, KQLDatabase, SemanticModel, MirroredDatabase, Notebook, DataPipeline, etc.
  updatedAt?: string;
  createdBy?: string;
}

export interface OneLakeSearchHit {
  source: 'onelake';
  workspace_id: string;
  workspace_name?: string;
  item_id: string;
  type: string;
  display_name: string;
  description?: string;
  updated_at?: string;
}

export interface OneLakeWorkspaceUser {
  emailAddress?: string;
  groupUserAccessRight?: 'Admin' | 'Member' | 'Contributor' | 'Viewer' | string;
  identifier?: string;
  principalType?: 'User' | 'Group' | 'ServicePrincipal' | string;
  displayName?: string;
}

// ============================================================
// Workspaces + items
// ============================================================

export async function listOneLakeWorkspaces(): Promise<OneLakeWorkspace[]> {
  const j = await call<{ value: OneLakeWorkspace[] }>(FABRIC_BASE, '/workspaces');
  return j.value || [];
}

export async function listWorkspaceItems(workspaceId: string, type?: string): Promise<OneLakeItem[]> {
  const j = await call<{ value: OneLakeItem[] }>(FABRIC_BASE, `/workspaces/${encodeURIComponent(workspaceId)}/items`, {
    query: type ? { type } : undefined,
  });
  return (j.value || []).map((i) => ({ ...i, workspaceId }));
}

/** Federated item enumeration across every workspace the UAMI can see.
 *  Each item is decorated with the parent workspace's name. */
export async function listAllOneLakeItems(workspaces?: OneLakeWorkspace[]): Promise<OneLakeItem[]> {
  const ws = workspaces ?? (await listOneLakeWorkspaces());
  const out: OneLakeItem[] = [];
  for (const w of ws) {
    try {
      const items = await listWorkspaceItems(w.id);
      for (const it of items) out.push({ ...it, workspaceName: w.displayName });
    } catch {
      // Skip workspaces the UAMI can list but not enumerate — happens when
      // it has only Viewer access. Not fatal.
    }
  }
  return out;
}

// ============================================================
// Search
// ============================================================

export async function searchOneLake(q: string, limit = 50): Promise<OneLakeSearchHit[]> {
  const ql = q.toLowerCase().trim();
  const ws = await listOneLakeWorkspaces();
  const hits: OneLakeSearchHit[] = [];
  for (const w of ws) {
    if (!ql || w.displayName.toLowerCase().includes(ql)) {
      // Surface the workspace itself as a hit row when the query matches.
      hits.push({
        source: 'onelake', workspace_id: w.id, workspace_name: w.displayName,
        item_id: w.id, type: 'Workspace', display_name: w.displayName, description: w.description,
      });
    }
    if (hits.length >= limit) break;
    let items: OneLakeItem[] = [];
    try { items = await listWorkspaceItems(w.id); } catch { continue; }
    for (const it of items) {
      if (!ql || it.displayName.toLowerCase().includes(ql) || (it.description || '').toLowerCase().includes(ql) || (it.type || '').toLowerCase().includes(ql)) {
        hits.push({
          source: 'onelake', workspace_id: w.id, workspace_name: w.displayName,
          item_id: it.id, type: it.type || 'Item', display_name: it.displayName, description: it.description,
          updated_at: it.updatedAt,
        });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

// ============================================================
// Permissions (workspace-scope; per-item permissions land via roles)
// ============================================================

export async function listWorkspaceUsers(workspaceId: string): Promise<OneLakeWorkspaceUser[]> {
  // Try Admin REST first (richer payload); fall back to v1 if 403.
  try {
    const j = await call<{ value?: OneLakeWorkspaceUser[]; users?: OneLakeWorkspaceUser[] }>(
      FABRIC_ADMIN_BASE,
      `/workspaces/${encodeURIComponent(workspaceId)}/users`,
    );
    return j.value || j.users || [];
  } catch (e: any) {
    if (e?.status !== 403 && e?.status !== 401) throw e;
  }
  const j = await call<{ value?: OneLakeWorkspaceUser[] }>(FABRIC_BASE, `/workspaces/${encodeURIComponent(workspaceId)}/roleAssignments`);
  return j.value || [];
}

export async function addWorkspaceRoleAssignment(
  workspaceId: string,
  body: { principal: { id: string; type: 'User' | 'Group' | 'ServicePrincipal' }; role: 'Admin' | 'Member' | 'Contributor' | 'Viewer' },
): Promise<void> {
  await call(FABRIC_BASE, `/workspaces/${encodeURIComponent(workspaceId)}/roleAssignments`, {
    method: 'POST',
    body,
  });
}

export async function removeWorkspaceRoleAssignment(workspaceId: string, principalId: string): Promise<void> {
  await call(FABRIC_BASE, `/workspaces/${encodeURIComponent(workspaceId)}/roleAssignments/${encodeURIComponent(principalId)}`, {
    method: 'DELETE',
  });
}

// ============================================================
// Lineage (admin scan)
// ============================================================

export interface OneLakeLineageEdge {
  source_item_id: string;
  source_type?: string;
  target_item_id: string;
  target_type?: string;
  workspace_id: string;
}

/**
 * Submits a Fabric admin scan for the workspace, polls for completion, and
 * extracts the lineage edges from the scan result. Throws
 * {@link OneLakeLineageNotSupportedError} if the tenant flight flag is off.
 */
export async function getWorkspaceLineage(workspaceId: string): Promise<OneLakeLineageEdge[]> {
  // 1. Trigger the scan.
  const scan = await call<{ id: string }>(FABRIC_ADMIN_BASE, '/workspaces/getInfo', {
    method: 'POST',
    body: { workspaces: [workspaceId] },
    query: { lineage: 'true', datasourceDetails: 'true', getArtifactUsers: 'true' },
  });
  const scanId = scan.id;
  if (!scanId) throw new OneLakeError('Admin scan did not return an id', 500, scan);

  // 2. Poll status (max 60s).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await call<{ status?: string }>(FABRIC_ADMIN_BASE, `/workspaces/scanStatus/${encodeURIComponent(scanId)}`);
    if (status.status === 'Succeeded') break;
    if (status.status === 'Failed') throw new OneLakeError(`Fabric scan failed: ${JSON.stringify(status)}`, 500);
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 3. Fetch result + extract lineage edges.
  const result = await call<any>(FABRIC_ADMIN_BASE, `/workspaces/scanResult/${encodeURIComponent(scanId)}`);
  const edges: OneLakeLineageEdge[] = [];
  for (const ws of result?.workspaces || []) {
    for (const ds of ws?.datasets || []) {
      for (const upstream of ds?.upstreamDataflows || []) {
        edges.push({
          source_item_id: upstream.targetDataflowId,
          source_type: 'Dataflow',
          target_item_id: ds.id,
          target_type: 'SemanticModel',
          workspace_id: ws.id,
        });
      }
      for (const upstream of ds?.upstreamDatasets || []) {
        edges.push({
          source_item_id: upstream.targetDatasetId,
          source_type: 'SemanticModel',
          target_item_id: ds.id,
          target_type: 'SemanticModel',
          workspace_id: ws.id,
        });
      }
    }
    for (const lh of ws?.lakehouses || []) {
      for (const item of ws?.reports || []) {
        if (item.datasetId) {
          edges.push({
            source_item_id: lh.id,
            source_type: 'Lakehouse',
            target_item_id: item.id,
            target_type: 'Report',
            workspace_id: ws.id,
          });
        }
      }
    }
  }
  return edges;
}
