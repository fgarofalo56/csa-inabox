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
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceItem {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  description?: string;
  state?: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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

export async function updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'description' | 'capacity' | 'domain'>>): Promise<Workspace> {
  return fetchJson<Workspace>(`/api/workspaces/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/workspaces/${id}`, { method: 'DELETE' });
}

export async function listItems(workspaceId: string): Promise<WorkspaceItem[]> {
  return fetchJson<WorkspaceItem[]>(`/api/workspaces/${workspaceId}/items`);
}

export async function createItem(workspaceId: string, input: {
  itemType: string;
  displayName: string;
  description?: string;
}): Promise<WorkspaceItem> {
  return fetchJson<WorkspaceItem>(`/api/workspaces/${workspaceId}/items`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getItem(type: string, id: string): Promise<WorkspaceItem> {
  return fetchJson<WorkspaceItem>(`/api/items/${type}/${id}`);
}

export async function updateItem(type: string, id: string, patch: Partial<Pick<WorkspaceItem, 'displayName' | 'description' | 'state'>>): Promise<WorkspaceItem> {
  return fetchJson<WorkspaceItem>(`/api/items/${type}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteItem(type: string, id: string): Promise<void> {
  await fetchJson<{ ok: boolean }>(`/api/items/${type}/${id}`, { method: 'DELETE' });
}
