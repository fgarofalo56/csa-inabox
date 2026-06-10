/**
 * Workspaces / Items API client (BFF /api/* routes, Cosmos-backed).
 */

export interface Workspace {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  capacity?: string;
  domain?: string;
  /**
   * ARM resource id of the storage account bound to this workspace for OneLake
   * lifecycle management. Absent = use the deployment-default DLZ account.
   */
  storageAccountId?: string;
  /** Derived: LOOM_ONELAKE_BASE + name. Only present on GET /api/workspaces/[id]. */
  oneLake?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of the most recent open. Optional — older docs may lack it. */
  lastAccessedAt?: string;
  /** Aggregated item count. Only present on GET /api/workspaces?count=true. */
  itemCount?: number;
}

export interface WorkspaceItem {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  description?: string;
  /** Optional folder this item lives in (null = workspace root). */
  folderId?: string | null;
  state?: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFolder {
  id: string;
  workspaceId: string;
  name: string;
  parent?: string | null;
  createdBy: string;
  createdAt: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return fetchJson<Workspace[]>('/api/workspaces');
}

/**
 * List workspaces enriched with `itemCount` per workspace. Uses a single
 * cross-partition aggregate on the items container. If the aggregate fails,
 * the BFF gracefully falls back to the un-enriched list (no `itemCount`).
 */
export async function listWorkspacesWithCounts(): Promise<Workspace[]> {
  return fetchJson<Workspace[]>('/api/workspaces?count=true');
}

export async function getWorkspace(id: string): Promise<Workspace> {
  return fetchJson<Workspace>(`/api/workspaces/${id}`);
}

export async function createWorkspace(input: {
  name: string;
  description?: string;
  capacity?: string;
  domain?: string;
}): Promise<Workspace> {
  return fetchJson<Workspace>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'description' | 'capacity' | 'domain' | 'storageAccountId'>>): Promise<Workspace> {
  return fetchJson<Workspace>(`/api/workspaces/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/workspaces/${id}`, { method: 'DELETE' });
}

export interface BulkDeleteResult {
  ok: boolean;
  deleted: string[];
  failed: Array<{ id: string; error: string }>;
}

/** Multi-delete. The server authorizes per workspace: tenant admins delete
 * anything; every caller can delete the workspaces they OWN. Non-owned ids come
 * back as per-id `forbidden`/`not_found` failures. */
export async function bulkDeleteWorkspaces(ids: string[]): Promise<BulkDeleteResult> {
  return fetchJson<BulkDeleteResult>('/api/workspaces/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

/** Probe bulk-delete affordances. `canBulkDelete` is true for any authenticated
 * user (they can delete their own workspaces); `isAdmin` marks tenant admins. */
export async function getWorkspaceAdminStatus(): Promise<{ ok: boolean; isAdmin: boolean; canBulkDelete: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/api/workspaces/bulk-delete`, { credentials: 'include' });
    if (!res.ok) return { ok: false, isAdmin: false, canBulkDelete: false };
    const j = await res.json();
    return { ok: !!j.ok, isAdmin: !!j.isAdmin, canBulkDelete: j.canBulkDelete !== false };
  } catch {
    return { ok: false, isAdmin: false, canBulkDelete: false };
  }
}

export async function listItems(workspaceId: string): Promise<WorkspaceItem[]> {
  return fetchJson<WorkspaceItem[]>(`/api/workspaces/${workspaceId}/items`);
}

export async function createItem(workspaceId: string, input: {
  itemType: string;
  displayName: string;
  description?: string;
  /** F17 custom-attribute values, keyed by attribute id. Stored on the item's state. */
  customAttributes?: Record<string, unknown>;
}): Promise<WorkspaceItem> {
  return fetchJson<WorkspaceItem>(`/api/workspaces/${workspaceId}/items`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getItem(type: string, id: string): Promise<WorkspaceItem> {
  return fetchJson<WorkspaceItem>(`/api/cosmos-items/${type}/${id}`);
}

export async function updateItem(type: string, id: string, patch: Partial<Pick<WorkspaceItem, 'displayName' | 'description' | 'state'>>): Promise<WorkspaceItem> {
  return fetchJson<WorkspaceItem>(`/api/cosmos-items/${type}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteItem(type: string, id: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/cosmos-items/${type}/${id}`, { method: 'DELETE' });
}

// --- Folders --------------------------------------------------------------

export async function listFolders(workspaceId: string): Promise<WorkspaceFolder[]> {
  const res = await fetchJson<{ ok: boolean; folders: WorkspaceFolder[] }>(
    `/api/workspaces/${workspaceId}/folders`,
  );
  return res.folders ?? [];
}

export async function createFolder(
  workspaceId: string,
  input: { name: string; parent?: string | null },
): Promise<WorkspaceFolder> {
  const res = await fetchJson<{ ok: boolean; folder: WorkspaceFolder }>(
    `/api/workspaces/${workspaceId}/folders`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return res.folder;
}

export async function renameFolder(
  workspaceId: string,
  folderId: string,
  name: string,
): Promise<WorkspaceFolder> {
  const res = await fetchJson<{ ok: boolean; folder: WorkspaceFolder }>(
    `/api/workspaces/${workspaceId}/folders`,
    { method: 'PATCH', body: JSON.stringify({ id: folderId, name }) },
  );
  return res.folder;
}

export async function deleteFolder(workspaceId: string, folderId: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(
    `/api/workspaces/${workspaceId}/folders?id=${encodeURIComponent(folderId)}`,
    { method: 'DELETE' },
  );
}

// --- Item-in-workspace ops (move / rename / delete) ----------------------

export async function patchWorkspaceItem(
  workspaceId: string,
  itemId: string,
  patch: { folderId?: string | null; displayName?: string },
): Promise<WorkspaceItem> {
  const res = await fetchJson<{ ok: boolean; item: WorkspaceItem }>(
    `/api/workspaces/${workspaceId}/items/${itemId}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return res.item;
}

export async function deleteWorkspaceItem(workspaceId: string, itemId: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(
    `/api/workspaces/${workspaceId}/items/${itemId}`,
    { method: 'DELETE' },
  );
}

// --- Task flows (F11) -----------------------------------------------------

export interface TaskFlowStep {
  id: string;
  label: string;
  /** Optional ref to a real WorkspaceItem.id this step represents. */
  itemId?: string | null;
  itemType?: string | null;
  note?: string;
  /** @xyflow/react canvas position. */
  x: number;
  y: number;
}

export interface TaskFlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface TaskFlow {
  id: string;
  workspaceId: string;
  displayName: string;
  description?: string;
  steps: TaskFlowStep[];
  edges: TaskFlowEdge[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export async function listTaskFlows(workspaceId: string): Promise<TaskFlow[]> {
  const res = await fetchJson<{ ok: boolean; flows: TaskFlow[] }>(
    `/api/workspaces/${workspaceId}/task-flows`,
  );
  return res.flows ?? [];
}

export async function createTaskFlow(
  workspaceId: string,
  input: { displayName: string; description?: string },
): Promise<TaskFlow> {
  const res = await fetchJson<{ ok: boolean; flow: TaskFlow }>(
    `/api/workspaces/${workspaceId}/task-flows`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return res.flow;
}

export async function getTaskFlow(workspaceId: string, id: string): Promise<TaskFlow> {
  const res = await fetchJson<{ ok: boolean; flow: TaskFlow }>(
    `/api/workspaces/${workspaceId}/task-flows/${id}`,
  );
  return res.flow;
}

export async function saveTaskFlow(
  workspaceId: string,
  id: string,
  patch: Partial<Pick<TaskFlow, 'steps' | 'edges' | 'displayName' | 'description'>>,
): Promise<TaskFlow> {
  const res = await fetchJson<{ ok: boolean; flow: TaskFlow }>(
    `/api/workspaces/${workspaceId}/task-flows/${id}`,
    { method: 'PUT', body: JSON.stringify(patch) },
  );
  return res.flow;
}

export async function deleteTaskFlow(workspaceId: string, id: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(
    `/api/workspaces/${workspaceId}/task-flows/${id}`,
    { method: 'DELETE' },
  );
}
