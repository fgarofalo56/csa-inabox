/**
 * Workspaces API client.
 *
 * Talks to /api/workspaces on the BFF, which proxies to Cosmos DB
 * workspace-registry container using the Console UAMI.
 */

export interface Workspace {
  id: string;
  name: string;
  itemCount: number;
  capacitySku: string;
  region: string;
  domainName: string;
  createdAt: string;
  ownerEntraOid: string;
}

export interface Item {
  id: string;
  workspaceId: string;
  name: string;
  type:
    | 'lakehouse'
    | 'warehouse'
    | 'notebook'
    | 'semantic-model'
    | 'activator-rule'
    | 'data-agent'
    | 'mirror';
  createdAt: string;
  updatedAt: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res.json();
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return fetchJson<Workspace[]>('/api/workspaces');
}

export async function getWorkspace(id: string): Promise<Workspace> {
  return fetchJson<Workspace>(`/api/workspaces/${id}`);
}

export async function listItems(workspaceId: string, type?: Item['type']): Promise<Item[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : '';
  return fetchJson<Item[]>(`/api/workspaces/${workspaceId}/items${qs}`);
}

export async function createWorkspace(input: {
  name: string;
  capacitySku: string;
  region: string;
  domainName: string;
}): Promise<Workspace> {
  return fetchJson<Workspace>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
