/**
 * Loom-items AI Search wiring.
 *
 * Strategy: push-from-BFF (no Cosmos indexer; Cosmos is PE-locked).
 * The BFF mirrors every item + workspace create / update / delete into
 * the `loom-items` index. /api/search/items queries the index when
 * LOOM_AI_SEARCH_SERVICE is set; falls back to Cosmos CONTAINS when it
 * isn't (no-vaporware: degrades gracefully).
 *
 * Index schema (loom-items):
 *   id           string  key
 *   kind         string  filterable, facetable   (workspace | item)
 *   itemType     string  filterable               (slug, only for items)
 *   tenantId     string  filterable               (== workspaces.tenantId / session.claims.oid)
 *   workspaceId  string  filterable
 *   displayName  string  searchable, sortable
 *   description  string  searchable
 *   url          string  retrievable              (for client routing)
 *   touchedAt    DateTimeOffset  sortable
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, ManagedIdentityCredential, DefaultAzureCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { FoundryError, NotDeployedError } from './foundry-client';

const credential = new ChainedTokenCredential(
  new AcaManagedIdentityCredential(),
  ...((process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID)
    ? [new ManagedIdentityCredential({ clientId: process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID })]
    : []),
  new DefaultAzureCredential(),
);

function searchService(): string {
  const s = process.env.LOOM_AI_SEARCH_SERVICE;
  if (!s) throw new NotDeployedError('Azure AI Search',
    'AI Search not provisioned in this deployment. Set LOOM_AI_SEARCH_SERVICE.');
  return s;
}

async function searchToken(): Promise<string> {
  const t = await credential.getToken('https://search.azure.com/.default');
  if (!t?.token) throw new Error('Failed to acquire token for AI Search');
  return t.token;
}

const SEARCH_API = '2024-07-01';
const INDEX = 'loom-items';

export interface LoomDoc {
  id: string;
  kind: 'workspace' | 'item';
  itemType?: string;
  tenantId: string;
  workspaceId?: string;
  displayName: string;
  description?: string;
  url: string;
  touchedAt: string;          // ISO-8601
}

export interface LoomHit extends LoomDoc {
  '@search.score'?: number;
}

const INDEX_DEFINITION = {
  fields: [
    { name: 'id', type: 'Edm.String', key: true, filterable: true, retrievable: true },
    { name: 'kind', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
    { name: 'itemType', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
    { name: 'tenantId', type: 'Edm.String', filterable: true, retrievable: true },
    { name: 'workspaceId', type: 'Edm.String', filterable: true, retrievable: true },
    { name: 'displayName', type: 'Edm.String', searchable: true, sortable: true, retrievable: true,
      analyzer: 'standard.lucene' },
    { name: 'description', type: 'Edm.String', searchable: true, retrievable: true,
      analyzer: 'standard.lucene' },
    { name: 'url', type: 'Edm.String', retrievable: true },
    { name: 'touchedAt', type: 'Edm.DateTimeOffset', sortable: true, retrievable: true, filterable: true },
  ],
};

/** Returns true when LOOM_AI_SEARCH_SERVICE is set + reachable. */
export function isSearchConfigured(): boolean {
  return !!process.env.LOOM_AI_SEARCH_SERVICE;
}

/** Idempotent: creates the `loom-items` index if absent, leaves alone otherwise. */
export async function ensureLoomIndex(): Promise<{ created: boolean; ok: boolean; error?: string }> {
  if (!isSearchConfigured()) return { created: false, ok: false, error: 'LOOM_AI_SEARCH_SERVICE not set' };
  try {
    const svc = searchService();
    const tok = await searchToken();
    const get = await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}?api-version=${SEARCH_API}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    if (get.status === 200) return { created: false, ok: true };
    const put = await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}?api-version=${SEARCH_API}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: INDEX, ...INDEX_DEFINITION }),
    });
    if (!put.ok) {
      const t = await put.text();
      return { created: false, ok: false, error: `ensure index PUT ${put.status}: ${t.slice(0, 200)}` };
    }
    return { created: true, ok: true };
  } catch (e: any) {
    if (e instanceof NotDeployedError) return { created: false, ok: false, error: e.message };
    return { created: false, ok: false, error: e?.message || String(e) };
  }
}

/** Best-effort upsert. Never throws — search is a derived index, never authoritative. */
export async function upsertLoomDoc(doc: LoomDoc): Promise<void> {
  if (!isSearchConfigured()) return;
  try {
    const svc = searchService();
    const tok = await searchToken();
    await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}/docs/index?api-version=${SEARCH_API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: [{ '@search.action': 'mergeOrUpload', ...doc }] }),
    });
  } catch { /* swallow — index is best-effort */ }
}

/** Best-effort delete. */
export async function deleteLoomDoc(id: string): Promise<void> {
  if (!isSearchConfigured()) return;
  try {
    const svc = searchService();
    const tok = await searchToken();
    await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}/docs/index?api-version=${SEARCH_API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: [{ '@search.action': 'delete', id }] }),
    });
  } catch { /* swallow */ }
}

/**
 * Tenant-scoped hybrid query. Returns null if search not configured so
 * the caller can fall back to Cosmos CONTAINS.
 */
export async function searchLoomItems(opts: {
  q: string; tenantId: string; top?: number; kind?: 'workspace' | 'item';
}): Promise<LoomHit[] | null> {
  if (!isSearchConfigured()) return null;
  const { q, tenantId, top = 25, kind } = opts;
  const svc = searchService();
  const tok = await searchToken();
  const filters: string[] = [`tenantId eq '${tenantId.replace(/'/g, "''")}'`];
  if (kind) filters.push(`kind eq '${kind}'`);
  const body = {
    search: q || '*',
    queryType: 'simple',
    searchMode: 'any',
    top,
    filter: filters.join(' and '),
    select: 'id,kind,itemType,tenantId,workspaceId,displayName,description,url,touchedAt',
  };
  const res = await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}/docs/search?api-version=${SEARCH_API}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new FoundryError(res.status, t, `loom-items search failed: ${t.slice(0, 240)}`);
  }
  const j: any = await res.json();
  return j.value as LoomHit[];
}

/** Convenience for callers that just want a doc shape from a workspace / item record. */
export function docForWorkspace(ws: { id: string; tenantId: string; name: string; description?: string; updatedAt?: string; createdAt: string }): LoomDoc {
  return {
    id: `ws:${ws.id}`,
    kind: 'workspace',
    tenantId: ws.tenantId,
    workspaceId: ws.id,
    displayName: ws.name,
    description: ws.description,
    url: `/workspaces/${ws.id}`,
    touchedAt: ws.updatedAt || ws.createdAt,
  };
}

export function docForItem(it: {
  id: string; workspaceId: string; itemType: string;
  displayName: string; description?: string;
  updatedAt?: string; createdAt: string;
}, tenantId: string): LoomDoc {
  return {
    id: `it:${it.id}`,
    kind: 'item',
    itemType: it.itemType,
    tenantId,
    workspaceId: it.workspaceId,
    displayName: it.displayName,
    description: it.description,
    url: `/items/${it.itemType}/${it.id}`,
    touchedAt: it.updatedAt || it.createdAt,
  };
}
