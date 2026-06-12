/**
 * Governance catalog AI Search wiring (`loom-governance-items` index).
 *
 * Strategy: push-from-BFF — identical to `loom-search.ts`. Cosmos is PE-locked,
 * so a native AI Search → Cosmos indexer would need a shared private link from
 * the search service to the Cosmos PE that isn't set up. Instead the BFF mirrors
 * every item create / update / delete into this index, and a one-shot admin
 * reindex endpoint (/api/admin/governance-catalog/reindex) does a full backfill.
 *
 * The catalog page queries this index — with FACETS (real per-value counts) and
 * a discoverability filter — when LOOM_AI_SEARCH_SERVICE is set; it falls back
 * to the Cosmos query only when AI Search is entirely absent (no-vaporware:
 * degrades gracefully when the infra isn't deployed). There is NO substring-only
 * fallback while AI Search is configured.
 *
 * Pure filter/projection shaping (buildCatalogFilter, docForGovernanceItem, the
 * index field definition, the data-type predicate) lives in the server-free
 * `governance-catalog-shapes` module and is re-exported here.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  ManagedIdentityCredential,
  DefaultAzureCredential,
} from '@azure/identity';
import { searchEndpointBase, searchAadScope } from './cloud-endpoints';
import { buildSearchBody } from './search-field-shapes';
import {
  GOVERNANCE_CATALOG_INDEX,
  GOVERNANCE_CATALOG_INDEX_FIELDS,
  CATALOG_FACET_FIELDS,
  CATALOG_SELECT,
  buildCatalogFilter,
  type CatalogSearchOpts,
  type GovernanceCatalogDoc,
  type GovernanceCatalogHit,
  type GovernanceCatalogSearchResult,
  type FacetBucket,
} from './governance-catalog-shapes';

// Re-export the shapes so existing imports (route, item-crud, reindex) keep
// pulling everything from this module.
export {
  CATALOG_DATA_ITEM_TYPES,
  isCatalogDataType,
  buildCatalogFilter,
  docForGovernanceItem,
  GOVERNANCE_CATALOG_INDEX,
} from './governance-catalog-shapes';
export type {
  GovernanceCatalogDoc,
  GovernanceCatalogHit,
  GovernanceCatalogSearchResult,
  FacetBucket,
  CatalogSearchOpts,
} from './governance-catalog-shapes';

const credential = new ChainedTokenCredential(
  ...((process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID)
    ? [new ManagedIdentityCredential({ clientId: process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID })]
    : []),
  new DefaultAzureCredential(),
);

const SEARCH_API = '2024-07-01';
const INDEX = GOVERNANCE_CATALOG_INDEX;

const INDEX_DEFINITION = { fields: GOVERNANCE_CATALOG_INDEX_FIELDS };

/** Returns true when LOOM_AI_SEARCH_SERVICE is set. */
export function isGovernanceCatalogSearchConfigured(): boolean {
  return !!process.env.LOOM_AI_SEARCH_SERVICE;
}

function service(): string {
  const s = process.env.LOOM_AI_SEARCH_SERVICE;
  if (!s) throw new Error('LOOM_AI_SEARCH_SERVICE not set');
  return s;
}

async function token(): Promise<string> {
  const t = await credential.getToken(searchAadScope());
  if (!t?.token) throw new Error('Failed to acquire AAD token for AI Search');
  return t.token;
}

/** Idempotent: creates the `loom-governance-items` index if absent. */
export async function ensureGovernanceCatalogIndex(): Promise<{ created: boolean; ok: boolean; error?: string }> {
  if (!isGovernanceCatalogSearchConfigured()) {
    return { created: false, ok: false, error: 'LOOM_AI_SEARCH_SERVICE not set' };
  }
  try {
    const base = searchEndpointBase(service());
    const tok = await token();
    const get = await fetchWithTimeout(`${base}/indexes/${INDEX}?api-version=${SEARCH_API}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    if (get.status === 200) return { created: false, ok: true };
    const put = await fetchWithTimeout(`${base}/indexes/${INDEX}?api-version=${SEARCH_API}`, {
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
    return { created: false, ok: false, error: e?.message || String(e) };
  }
}

/** Best-effort upsert. Never throws — the index is a derived projection. */
export async function upsertGovernanceItem(doc: GovernanceCatalogDoc): Promise<void> {
  if (!isGovernanceCatalogSearchConfigured()) return;
  try {
    const base = searchEndpointBase(service());
    const tok = await token();
    await fetchWithTimeout(`${base}/indexes/${INDEX}/docs/index?api-version=${SEARCH_API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: [{ '@search.action': 'mergeOrUpload', ...doc }] }),
    });
  } catch { /* swallow — best-effort */ }
}

/** Best-effort batch upsert (used by the reindex backfill). Never throws. */
export async function upsertGovernanceItems(docs: GovernanceCatalogDoc[]): Promise<{ ok: boolean; error?: string }> {
  if (!isGovernanceCatalogSearchConfigured() || docs.length === 0) return { ok: true };
  try {
    const base = searchEndpointBase(service());
    const tok = await token();
    const res = await fetchWithTimeout(`${base}/indexes/${INDEX}/docs/index?api-version=${SEARCH_API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: docs.map((d) => ({ '@search.action': 'mergeOrUpload', ...d })) }),
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, error: `batch index POST ${res.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Best-effort delete. */
export async function deleteGovernanceItem(id: string): Promise<void> {
  if (!isGovernanceCatalogSearchConfigured()) return;
  try {
    const base = searchEndpointBase(service());
    const tok = await token();
    await fetchWithTimeout(`${base}/indexes/${INDEX}/docs/index?api-version=${SEARCH_API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: [{ '@search.action': 'delete', id }] }),
    });
  } catch { /* swallow */ }
}

/**
 * Tenant-scoped catalog query with facets. Returns null when AI Search isn't
 * configured so the caller can fall back to the Cosmos query.
 */
export async function searchGovernanceCatalog(opts: CatalogSearchOpts): Promise<GovernanceCatalogSearchResult | null> {
  if (!isGovernanceCatalogSearchConfigured()) return null;
  const base = searchEndpointBase(service());
  const tok = await token();
  const body = buildSearchBody({
    search: opts.q || '*',
    queryType: 'simple',
    searchMode: 'any',
    top: opts.top ?? 100,
    filter: buildCatalogFilter(opts),
    facets: CATALOG_FACET_FIELDS,
    select: CATALOG_SELECT,
    orderby: opts.q ? undefined : 'updatedAt desc',
    count: true,
  });
  if (typeof opts.skip === 'number' && opts.skip > 0) body.skip = opts.skip;
  const res = await fetchWithTimeout(`${base}/indexes/${INDEX}/docs/search?api-version=${SEARCH_API}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`loom-governance-items search failed (${res.status}): ${t.slice(0, 240)}`);
  }
  const j: any = await res.json();
  const rawFacets = (j['@search.facets'] || {}) as Record<string, Array<{ value: string; count: number }>>;
  const mapFacet = (name: string): FacetBucket[] | undefined =>
    Array.isArray(rawFacets[name])
      ? rawFacets[name].map((f) => ({ value: String(f.value), count: f.count }))
      : undefined;
  return {
    total: typeof j['@odata.count'] === 'number' ? j['@odata.count'] : (j.value || []).length,
    hits: (j.value || []) as GovernanceCatalogHit[],
    facets: {
      itemType: mapFacet('itemType'),
      domainId: mapFacet('domainId'),
      endorsement: mapFacet('endorsement'),
      sensitivity: mapFacet('sensitivity'),
      classifications: mapFacet('classifications'),
    },
  };
}
