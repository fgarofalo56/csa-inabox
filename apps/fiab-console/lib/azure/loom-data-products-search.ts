/**
 * Data-marketplace AI Search wiring — the `loom-data-products` index.
 *
 * This is the consumer-discovery counterpart to `loom-search.ts`'s
 * `loom-items` index. It powers the F14/F18 Data Marketplace surface:
 *
 *   - Audience  : data consumers (any signed-in user), not workspace authors.
 *   - Scope     : ONLY `data-product` items, and ONLY when Published.
 *   - Faceting  : governance domain, product type, owner, glossary terms, CDEs.
 *   - Publish    : every consumer query injects `publishStatus eq 'Published'`,
 *                 so a Draft / Deprecated product is invisible to consumers
 *                 even though its doc may exist in the index.
 *
 * Strategy is identical to loom-search.ts — push-from-BFF (Cosmos is
 * PE-locked, so no AI-Search indexer is possible). `item-crud.ts` mirrors
 * every data-product create / update / delete into this index. Search is a
 * derived store: writes are best-effort and never throw.
 *
 * Azure-native by default: this needs only `LOOM_AI_SEARCH_SERVICE` (a
 * Microsoft.Search/searchServices name — bicep
 * platform/fiab/bicep/modules/admin-plane/ai-search.bicep). No Microsoft
 * Fabric / Power BI dependency. When the env var is unset, every export
 * degrades gracefully (search returns a not-configured signal; writes
 * no-op) so the editor can surface an honest infra gate.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  ManagedIdentityCredential,
  DefaultAzureCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

const SEARCH_API = '2024-07-01';
const SEARCH_SCOPE = 'https://search.azure.com/.default';
export const DATA_PRODUCTS_INDEX = 'loom-data-products';

/** The publish states a data product can be in. Only `Published` is consumer-visible. */
export type PublishStatus = 'Draft' | 'Published' | 'Deprecated';
export const PUBLISH_STATUSES: PublishStatus[] = ['Draft', 'Published', 'Deprecated'];

/** The wire shape of a document in the loom-data-products index. */
export interface DataProductDoc {
  id: string;
  tenantId: string;
  workspaceId: string;
  displayName: string;
  description?: string;
  domain?: string;
  domainName?: string;
  productType?: string;
  owner?: string;
  glossaryTerms?: string[];
  CDEs?: string[];
  publishStatus: PublishStatus;
  sla?: string;
  url: string;
  /** governed (default) | self-serve | request — drives the subscribe flow. */
  accessModel?: string;
  touchedAt: string; // ISO-8601
}

export interface DataProductHit extends DataProductDoc {
  '@search.score'?: number;
}

/** Honest infra-gate helper. Returns the env var to set, or null when wired. */
export function dataProductsSearchGate(): { missing: string } | null {
  return process.env.LOOM_AI_SEARCH_SERVICE ? null : { missing: 'LOOM_AI_SEARCH_SERVICE' };
}

export function isDataProductsSearchConfigured(): boolean {
  return !!process.env.LOOM_AI_SEARCH_SERVICE;
}

function serviceName(): string {
  const s = process.env.LOOM_AI_SEARCH_SERVICE;
  if (!s) throw new Error('LOOM_AI_SEARCH_SERVICE not set');
  return s;
}

function serviceBase(service: string): string {
  if (service.includes('.')) {
    return `https://${service.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  }
  return `https://${service}.search.windows.net`;
}

async function searchToken(): Promise<string> {
  const t = await credential.getToken(SEARCH_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire AAD token for AI Search');
  return t.token;
}

/**
 * The index definition. `glossaryTerms` and `CDEs` are
 * `Collection(Edm.String)` so they facet as multi-value fields and filter
 * with the OData lambda syntax `field/any(t: t eq '<val>')`.
 */
export const DATA_PRODUCTS_INDEX_DEFINITION = {
  fields: [
    { name: 'id', type: 'Edm.String', key: true, filterable: true, retrievable: true },
    { name: 'tenantId', type: 'Edm.String', filterable: true, retrievable: true },
    { name: 'workspaceId', type: 'Edm.String', filterable: true, retrievable: true },
    { name: 'displayName', type: 'Edm.String', searchable: true, sortable: true, retrievable: true,
      analyzer: 'standard.lucene' },
    { name: 'description', type: 'Edm.String', searchable: true, retrievable: true, analyzer: 'standard.lucene' },
    { name: 'domain', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
    { name: 'domainName', type: 'Edm.String', filterable: true, facetable: true, retrievable: true, searchable: true },
    { name: 'productType', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
    { name: 'owner', type: 'Edm.String', filterable: true, facetable: true, retrievable: true, searchable: true },
    { name: 'glossaryTerms', type: 'Collection(Edm.String)', filterable: true, facetable: true, retrievable: true, searchable: true },
    { name: 'CDEs', type: 'Collection(Edm.String)', filterable: true, facetable: true, retrievable: true, searchable: true },
    { name: 'publishStatus', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
    { name: 'sla', type: 'Edm.String', retrievable: true },
    { name: 'url', type: 'Edm.String', retrievable: true },
    { name: 'accessModel', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
    { name: 'touchedAt', type: 'Edm.DateTimeOffset', sortable: true, filterable: true, retrievable: true },
  ],
};

/** Default facet expressions requested on every consumer query. */
export const DEFAULT_FACETS = [
  'domainName,count:50',
  'productType,count:30',
  'owner,count:50',
  'glossaryTerms,count:100',
  'CDEs,count:100',
];

const SELECT =
  'id,tenantId,workspaceId,displayName,description,domain,domainName,productType,owner,glossaryTerms,CDEs,publishStatus,sla,url,accessModel,touchedAt';

/** Idempotent: create the `loom-data-products` index if absent, and reconcile
 *  its schema when it already exists so newly-added fields (e.g. accessModel)
 *  are appended to a pre-existing live index. Azure AI Search permits additive
 *  field changes via PUT without a reindex; an additive PUT failure on an
 *  existing index is treated as non-fatal (the index still works — the new
 *  field just isn't present, and callers degrade gracefully). */
export async function ensureDataProductsIndex(): Promise<{ created: boolean; ok: boolean; error?: string }> {
  if (!isDataProductsSearchConfigured()) {
    return { created: false, ok: false, error: 'LOOM_AI_SEARCH_SERVICE not set' };
  }
  try {
    const svc = serviceName();
    const tok = await searchToken();
    const base = serviceBase(svc);
    const get = await fetchWithTimeout(`${base}/indexes/${DATA_PRODUCTS_INDEX}?api-version=${SEARCH_API}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    if (get.status === 200) {
      // EXISTING index: reconcile ADDITIVELY against the LIVE definition so we
      // never overwrite live field attributes (which would 400 on drift). Read
      // the live fields, append only the fields our code defines that are
      // absent (e.g. a newly-added accessModel), and PUT the merged definition.
      let live: any = null;
      try { live = await get.json(); } catch { live = null; }
      const liveFields: any[] = Array.isArray(live?.fields) ? live.fields : [];
      const liveNames = new Set(liveFields.map((f) => String(f?.name)));
      const wantFields = (DATA_PRODUCTS_INDEX_DEFINITION as any).fields as any[];
      const missing = wantFields.filter((f) => !liveNames.has(f.name));
      if (missing.length === 0) return { created: false, ok: true };
      const mergedBody = { ...live, fields: [...liveFields, ...missing] };
      const put = await fetchWithTimeout(`${base}/indexes/${DATA_PRODUCTS_INDEX}?api-version=${SEARCH_API}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify(mergedBody),
      });
      if (!put.ok) {
        const t = await put.text();
        // Non-fatal: index is still searchable; callers degrade (strip the field).
        return { created: false, ok: true, error: `additive field add skipped (${put.status}): ${t.slice(0, 160)}` };
      }
      return { created: false, ok: true };
    }
    // ABSENT: create from our full definition.
    const put = await fetchWithTimeout(`${base}/indexes/${DATA_PRODUCTS_INDEX}?api-version=${SEARCH_API}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: DATA_PRODUCTS_INDEX, ...DATA_PRODUCTS_INDEX_DEFINITION }),
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

/** Best-effort upsert. Never throws — the index is derived, never authoritative.
 *  Resilient to index schema drift: if the doc carries a property the live index
 *  doesn't have yet (e.g. accessModel on an older index), it reconciles the
 *  index + retries, then as a last resort strips unknown fields and retries so
 *  the product ALWAYS indexes (the field just isn't searchable until the schema
 *  catches up). Without this a single new field silently de-indexed every
 *  product (the create→publish→Discover break). */
export async function upsertDataProductDoc(doc: DataProductDoc): Promise<void> {
  if (!isDataProductsSearchConfigured()) return;
  try {
    const svc = serviceName();
    const tok = await searchToken();
    const url = `${serviceBase(svc)}/indexes/${DATA_PRODUCTS_INDEX}/docs/index?api-version=${SEARCH_API}`;
    const post = (d: Record<string, unknown>) => fetchWithTimeout(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: [{ '@search.action': 'mergeOrUpload', ...d }] }),
    });
    // The AI Search "index documents" API returns HTTP 200 even when a doc
    // fails — the per-document status is in the body's `value[].status`. So a
    // failure can be EITHER a non-2xx HTTP code (batch/schema error) OR a 200
    // with a per-doc error. Treat both as failure.
    const failureOf = async (r: Response): Promise<string | null> => {
      const text = await r.text();
      if (!r.ok) return `HTTP ${r.status}: ${text.slice(0, 240)}`;
      try {
        const j = JSON.parse(text);
        const bad = (j?.value || []).find((v: any) => typeof v?.statusCode === 'number' && v.statusCode >= 400);
        if (bad) return `doc ${bad.key}: ${bad.statusCode} ${bad.errorMessage || ''}`.slice(0, 240);
      } catch { /* non-JSON 200 — treat as success */ }
      return null;
    };

    // Ensure the index exists + reconcile its schema on first write.
    await ensureDataProductsIndex();
    let fail = await failureOf(await post(doc as unknown as Record<string, unknown>));
    if (fail) {
      // Unknown field (index predates a doc field) → reconcile + retry; then
      // strip optional new fields and retry so the doc still indexes.
      await ensureDataProductsIndex();
      fail = await failureOf(await post(doc as unknown as Record<string, unknown>));
      if (fail) {
        const { accessModel, ...rest } = doc as DataProductDoc & Record<string, unknown>;
        void accessModel;
        fail = await failureOf(await post(rest));
      }
    }
    if (fail) {
      // Surface the real reason in container logs (best-effort index, never
      // throws) — this was silently swallowed, hiding why products never indexed.
      console.warn(`[loom-data-products] upsert of ${doc.id} failed: ${fail}`);
    }
  } catch (e: any) {
    console.warn(`[loom-data-products] upsert threw: ${e?.message || String(e)}`);
  }
}

/** Best-effort delete by index doc id. Tolerates the legacy `dp:` colon form —
 *  the stored key uses `dp_` (colons are invalid AI Search keys), so sanitize. */
export async function deleteDataProductDoc(id: string): Promise<void> {
  if (!isDataProductsSearchConfigured()) return;
  try {
    const svc = serviceName();
    const tok = await searchToken();
    const key = id.replace(/:/g, '_');
    await fetchWithTimeout(`${serviceBase(svc)}/indexes/${DATA_PRODUCTS_INDEX}/docs/index?api-version=${SEARCH_API}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: [{ '@search.action': 'delete', id: key }] }),
    });
  } catch {
    /* swallow */
  }
}

function esc(v: string): string {
  return escapeSqlLiteral(v);
}

export interface DataProductSearchOpts {
  q?: string;
  tenantId: string;
  /** Extra OData filter from consumer-selected facets, ANDed with the mandatory ones. */
  filter?: string;
  top?: number;
  skip?: number;
  facets?: string[];
  orderBy?: string;
}

export interface DataProductSearchResult {
  results: DataProductHit[];
  facets: Record<string, Array<{ value: string; count: number }>>;
  count: number;
  /** Raw Azure AI Search response body — surfaced in the editor receipt. */
  raw: unknown;
}

/**
 * Tenant-scoped, Published-only consumer query against loom-data-products.
 *
 * The `q` string is passed to AI Search verbatim with `queryType: 'simple'`.
 * Per the simple query syntax, a double-quoted token (e.g. `"sales report"`)
 * is matched as a contiguous, ordered PHRASE — that is the exact-match path
 * the marketplace search bar hints at.
 *
 * Two filters are ALWAYS injected and cannot be overridden by the caller:
 *   tenantId eq '<oid>'  AND  publishStatus eq 'Published'
 * so a Draft / Deprecated product never reaches a consumer.
 */
export async function searchDataProducts(opts: DataProductSearchOpts): Promise<DataProductSearchResult> {
  const { q, tenantId, filter, top = 25, skip = 0, facets = DEFAULT_FACETS, orderBy } = opts;
  const svc = serviceName();
  const tok = await searchToken();

  const mandatory = [`tenantId eq '${esc(tenantId)}'`, `publishStatus eq 'Published'`];
  const all = filter && filter.trim() ? [...mandatory, `(${filter.trim()})`] : mandatory;
  const body: Record<string, unknown> = {
    search: q && q.trim() ? q : '*',
    queryType: 'simple',
    searchMode: 'all',
    filter: all.join(' and '),
    facets,
    count: true,
    top,
    skip,
    select: SELECT,
  };
  if (orderBy) body.orderby = orderBy;

  const url = `${serviceBase(svc)}/indexes/${DATA_PRODUCTS_INDEX}/docs/search?api-version=${SEARCH_API}`;
  const doSearch = () => fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  let res = await doSearch();
  if (!res.ok) {
    const t = await res.text();
    // Index not created yet (404) → behave like an empty result so a brand-new
    // tenant sees an empty marketplace, not an error.
    if (res.status === 404) {
      await ensureDataProductsIndex();
      return { results: [], facets: {}, count: 0, raw: { note: 'index created on first query; no documents yet' } };
    }
    // Schema drift: the live index predates a newly-added selectable/filterable
    // field (e.g. accessModel) → reconcile the index (additive PUT) and retry.
    // Self-heals without a manual reindex (no-vaporware). If the field still
    // can't be added (non-additive drift), fall back to a select that strips
    // the new field so search NEVER hard-fails on schema drift.
    if (res.status === 400 && /Could not find a property named|Invalid expression/i.test(t)) {
      await ensureDataProductsIndex();
      res = await doSearch();
      if (!res.ok) {
        const t2 = await res.text();
        if (res.status === 400 && /Could not find a property named|Invalid expression/i.test(t2)) {
          // Final fallback: drop the optional accessModel field from $select.
          body.select = SELECT.split(',').filter((f) => f.trim() !== 'accessModel').join(',');
          res = await doSearch();
          if (!res.ok) {
            const t3 = await res.text();
            throw new Error(`loom-data-products search failed (${res.status}): ${t3.slice(0, 240)}`);
          }
        } else {
          throw new Error(`loom-data-products search failed (${res.status}): ${t2.slice(0, 240)}`);
        }
      }
    } else {
      throw new Error(`loom-data-products search failed (${res.status}): ${t.slice(0, 240)}`);
    }
  }
  const j: any = await res.json();
  const facetsOut: Record<string, Array<{ value: string; count: number }>> = {};
  const rawFacets = j['@search.facets'] || {};
  for (const k of Object.keys(rawFacets)) {
    facetsOut[k] = (rawFacets[k] || []).map((f: any) => ({ value: String(f.value), count: f.count }));
  }
  return {
    results: (j.value || []) as DataProductHit[],
    facets: facetsOut,
    count: typeof j['@odata.count'] === 'number' ? j['@odata.count'] : (j.value || []).length,
    raw: j,
  };
}

/**
 * Project a Cosmos `data-product` item into an index doc. Reads the optional
 * marketplace metadata off `item.state`. `publishStatus` defaults to `Draft`
 * so a freshly-created product is NOT consumer-visible until explicitly
 * published. `domainName` is resolved by the caller (it has the domain map);
 * here we fall back to the raw domain id.
 */
export function docForDataProduct(
  item: WorkspaceItem,
  tenantId: string,
  domainName?: string,
): DataProductDoc {
  const state = (item.state || {}) as Record<string, unknown>;
  const asArray = (v: unknown): string[] | undefined => {
    if (Array.isArray(v)) {
      const out = v.map((x) => String(x).trim()).filter(Boolean);
      return out.length ? out : undefined;
    }
    if (typeof v === 'string' && v.trim()) {
      const out = v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
      return out.length ? out : undefined;
    }
    return undefined;
  };
  const ps = String(state.publishStatus || 'Draft') as PublishStatus;
  const domain = state.domain ? String(state.domain) : undefined;
  return {
    // AI Search document keys may only contain letters, digits, _, -, =.
    // A colon (the old `dp:` prefix) is INVALID and 400'd every upsert
    // ("Invalid document key") — which is why no data product ever indexed.
    // Use an underscore separator; the GUID's dashes are allowed.
    id: `dp_${item.id}`,
    tenantId,
    workspaceId: item.workspaceId,
    displayName: item.displayName,
    description: item.description,
    domain,
    domainName: domainName || (state.domainName ? String(state.domainName) : domain),
    productType: state.productType ? String(state.productType) : undefined,
    owner: state.owner ? String(state.owner) : item.createdBy,
    glossaryTerms: asArray(state.glossaryTerms),
    CDEs: asArray(state.CDEs),
    publishStatus: PUBLISH_STATUSES.includes(ps) ? ps : 'Draft',
    sla: state.sla ? String(state.sla) : undefined,
    url: `/items/data-product/${item.id}`,
    accessModel: state.accessModel ? String(state.accessModel) : 'governed',
    touchedAt: item.updatedAt || item.createdAt,
  };
}

/**
 * Build a consumer OData filter from selected facet values. Single-value
 * fields use `eq`; the collection fields (`glossaryTerms`, `CDEs`) use the
 * `any(t: t eq '<v>')` lambda. Values inside one field are ORed; different
 * fields are ANDed — matching the Azure portal facet behaviour.
 */
export function buildFacetFilter(selected: Record<string, string[]>): string {
  const collectionFields = new Set(['glossaryTerms', 'CDEs']);
  const clauses: string[] = [];
  for (const field of Object.keys(selected)) {
    const vals = (selected[field] || []).filter(Boolean);
    if (vals.length === 0) continue;
    if (collectionFields.has(field)) {
      const ors = vals.map((v) => `${field}/any(t: t eq '${esc(v)}')`);
      clauses.push(ors.length === 1 ? ors[0] : `(${ors.join(' or ')})`);
    } else {
      const ors = vals.map((v) => `${field} eq '${esc(v)}'`);
      clauses.push(ors.length === 1 ? ors[0] : `(${ors.join(' or ')})`);
    }
  }
  return clauses.join(' and ');
}
