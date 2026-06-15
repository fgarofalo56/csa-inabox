/**
 * Azure AI Search DATA-PLANE client — full index-management surface.
 *
 * This is the backend behind the Loom `ai-search-index` editor. It targets the
 * AI Search data-plane REST API (https://<service>.search.windows.net) with AAD
 * bearer tokens (scope https://search.azure.com/.default) via the same
 * ChainedTokenCredential(UAMI → DefaultAzureCredential) the rest of Loom uses.
 *
 * The UAMI must hold "Search Index Data Contributor" + "Search Service
 * Contributor" (or at least the index-scoped data role) on the search service
 * for write ops; "Search Index Data Reader" for read/query.
 *
 * Grounded in Microsoft Learn (Data plane REST operations, api-version
 * 2024-07-01):
 *   - Indexes:    GET /indexes, GET /indexes/{n}, POST /indexes, PUT /indexes/{n}, DELETE
 *   - Statistics: GET /indexes/{n}/stats  → { documentCount, storageSize, vectorIndexSize }
 *   - Documents:  POST /indexes/{n}/docs/search, POST /indexes/{n}/docs/index
 *   - Analyze:    POST /indexes/{n}/analyze
 *   - Indexers:   GET /indexers, POST /indexers/{n}/run, POST /indexers/{n}/reset, GET /indexers/{n}/status
 *   - Data srcs:  GET /datasources
 *   - Skillsets:  GET /skillsets
 *   - Service:    GET /servicestats
 *
 * No mocks. Real AI Search REST only. Every `await r.json()` is content-type
 * guarded so an HTML error page (e.g. from a proxy / 502) never throws an
 * opaque "Unexpected token <".
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { getSearchSuffix } from './cloud-endpoints';

export const SEARCH_DATA_API = '2024-07-01';
const SEARCH_SCOPE = 'https://search.azure.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class SearchNotDeployedError extends Error {
  readonly notDeployed = true;
  service = 'Azure AI Search';
  hint: string;
  constructor(hint?: string) {
    super('Azure AI Search is not provisioned in this deployment');
    this.name = 'SearchNotDeployedError';
    this.hint =
      hint ||
      'Set LOOM_AI_SEARCH_SERVICE to a deployed Microsoft.Search/searchServices name, ' +
        'and grant the Loom UAMI the "Search Index Data Contributor" + "Search Service Contributor" roles on it ' +
        '(bicep: platform/fiab/bicep/modules/admin-plane/ai-search.bicep).';
  }
}

export class SearchDataError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `AI Search data-plane call failed (${status})`);
    this.name = 'SearchDataError';
    this.status = status;
    this.body = body;
  }
}

/** Returns true when LOOM_AI_SEARCH_SERVICE is set. */
export function isSearchConfigured(): boolean {
  return !!process.env.LOOM_AI_SEARCH_SERVICE;
}

/**
 * Honest infra-gate helper for the BFF routes. Returns `{ missing }` naming the
 * exact env var to set when AI Search isn't wired, or `null` when configured.
 * Mirrors `databricksConfigGate()` so the AI Search service routes share the
 * same `{ ok:false, code:'not_configured', missing }` 503 shape.
 */
export function searchConfigGate(): { missing: string } | null {
  return isSearchConfigured() ? null : { missing: 'LOOM_AI_SEARCH_SERVICE' };
}

/**
 * Resolve the search service name. An explicit `override` (from the item's
 * bound state) wins over the env default. Throws SearchNotDeployedError when
 * neither is set — callers surface that as the honest infra gate.
 */
export function resolveServiceName(override?: string): string {
  const svc = (override && override.trim()) || process.env.LOOM_AI_SEARCH_SERVICE || '';
  if (!svc) throw new SearchNotDeployedError();
  return svc;
}

function serviceBase(service: string): string {
  // Accept either a bare name or a fully-qualified host.
  if (service.includes('.')) return `https://${service.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  return `https://${service}.${getSearchSuffix()}`;
}

async function searchToken(): Promise<string> {
  const t = await credential.getToken(SEARCH_SCOPE);
  if (!t?.token) throw new SearchDataError(401, undefined, 'Failed to acquire AAD token for AI Search');
  return t.token;
}

/**
 * Parse a Response body as JSON, guarding on content-type. A non-JSON body
 * (HTML error page, empty 204, etc.) never throws an opaque parse error —
 * instead we surface the raw text in a SearchDataError when the status is bad,
 * or return `null` for an empty success body.
 */
async function readJsonGuarded(res: Response, ctx: string): Promise<any> {
  const ct = res.headers.get('content-type') || '';
  const isJson = ct.includes('application/json') || ct.includes('+json');
  if (res.ok) {
    if (res.status === 204) return null;
    if (!isJson) {
      const t = await res.text();
      // Empty body on a 200 is fine; otherwise we have a non-JSON success body.
      return t.trim() ? { _raw: t } : null;
    }
    const t = await res.text();
    return t.trim() ? JSON.parse(t) : null;
  }
  // Error path — capture whatever the body is for the message.
  const t = await res.text();
  let body: unknown = t;
  if (isJson && t.trim()) { try { body = JSON.parse(t); } catch { /* keep text */ } }
  const detail = (body as any)?.error?.message || (typeof body === 'string' ? body : JSON.stringify(body));
  throw new SearchDataError(res.status, body, `${ctx} failed (${res.status}): ${String(detail).slice(0, 240)}`);
}

interface CallOpts {
  service?: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  apiVersion?: string;
}

/** Issue an authenticated data-plane call to `path` (must start with `/`). */
async function call(path: string, opts: CallOpts = {}): Promise<Response> {
  const service = resolveServiceName(opts.service);
  const tok = await searchToken();
  const params = new URLSearchParams({ 'api-version': opts.apiVersion || SEARCH_DATA_API, ...(opts.query || {}) });
  const url = `${serviceBase(service)}${path}?${params.toString()}`;
  return fetchWithTimeout(url, {
    method: opts.method || 'GET',
    headers: {
      authorization: `Bearer ${tok}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

// ----------------------------------------------------------------------------
// Indexes
// ----------------------------------------------------------------------------

export interface IndexFieldSummary {
  name: string;
  type: string;
  key?: boolean;
  searchable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  facetable?: boolean;
  retrievable?: boolean;
  dimensions?: number;
  analyzer?: string;
}

export interface IndexSummary {
  name: string;
  fields: IndexFieldSummary[];
  fieldCount: number;
  vectorEnabled: boolean;
}

function summarizeIndex(raw: any): IndexSummary {
  const fields: IndexFieldSummary[] = (raw?.fields || []).map((f: any) => ({
    name: f.name,
    type: f.type,
    key: !!f.key,
    searchable: !!f.searchable,
    filterable: !!f.filterable,
    sortable: !!f.sortable,
    facetable: !!f.facetable,
    retrievable: f.retrievable !== false,
    dimensions: f.dimensions,
    analyzer: f.analyzer,
  }));
  return {
    name: raw?.name,
    fields,
    fieldCount: fields.length,
    vectorEnabled: !!raw?.vectorSearch,
  };
}

// Visual field-designer shaping also lives in the server-free module so the
// editor and the data-plane client agree on the exact field wire shape.
export type { FieldRow } from './search-field-shapes';
export {
  isVectorFieldType, fieldRowToApiField, apiFieldToRow, applyFieldRows,
  FIELD_TYPES, ANALYZERS, semanticConfigNames, vectorProfileNames,
  scoringProfileNames, facetableFieldNames,
  // Indexer schedule designer
  SCHEDULE_PRESETS, validateScheduleInterval, describeScheduleInterval,
  // Semantic configuration designer
  buildSemanticSection, parseSemanticSection, semanticEligibleFieldNames,
  // Vector search designer
  VECTOR_METRICS, defaultHnswParameters, buildVectorSearchSection,
  parseVectorSearchSection, indexHasVectorField,
} from './search-field-shapes';
export type {
  IndexerSchedule, SemanticConfig, SemanticFieldRef,
  VectorAlgorithm, VectorProfile, VectorMetric,
} from './search-field-shapes';

/** GET /indexes — list every index on the service (summary form). */
export async function listIndexes(service?: string): Promise<IndexSummary[]> {
  const res = await call('/indexes', { service, query: { $select: 'name,fields,vectorSearch' } });
  const j = await readJsonGuarded(res, 'list indexes');
  return (j?.value || []).map(summarizeIndex);
}

/** GET /indexes/{name} — full index definition (fields, vector + semantic config). 404 → null. */
export async function getIndex(name: string, service?: string): Promise<any | null> {
  const res = await call(`/indexes/${encodeURIComponent(name)}`, { service });
  if (res.status === 404) return null;
  return readJsonGuarded(res, `get index ${name}`);
}

/** POST /indexes — create a new index from a full definition. */
export async function createIndex(definition: any, service?: string): Promise<any> {
  if (!definition?.name) throw new SearchDataError(400, definition, 'create index requires definition.name');
  const res = await call('/indexes', { service, method: 'POST', body: cleanDefinition(definition) });
  return readJsonGuarded(res, `create index ${definition.name}`);
}

/** PUT /indexes/{name} — create-or-update an index definition. */
export async function updateIndex(name: string, definition: any, service?: string): Promise<any> {
  const res = await call(`/indexes/${encodeURIComponent(name)}`, {
    service, method: 'PUT', body: { ...cleanDefinition(definition), name },
  });
  return readJsonGuarded(res, `update index ${name}`);
}

/** DELETE /indexes/{name}. */
export async function deleteIndex(name: string, service?: string): Promise<void> {
  const res = await call(`/indexes/${encodeURIComponent(name)}`, { service, method: 'DELETE' });
  if (res.status === 404 || res.status === 204) return;
  await readJsonGuarded(res, `delete index ${name}`);
}

/**
 * The data-plane PUT/POST for indexes rejects `description` on a ScoringProfile
 * (valid only at index level). App bundles keep it for docs; strip at the wire.
 */
function cleanDefinition(def: any): any {
  const cleaned = { ...def };
  if (Array.isArray(cleaned.scoringProfiles)) {
    cleaned.scoringProfiles = cleaned.scoringProfiles.map((p: any) => {
      const { description: _d, ...rest } = p || {};
      return rest;
    });
  }
  return cleaned;
}

// ----------------------------------------------------------------------------
// Statistics
// ----------------------------------------------------------------------------

export interface IndexStats {
  documentCount: number;
  storageSize: number;
  vectorIndexSize?: number;
}

/** GET /indexes/{name}/stats — document count + storage. */
export async function getIndexStats(name: string, service?: string): Promise<IndexStats> {
  const res = await call(`/indexes/${encodeURIComponent(name)}/stats`, { service });
  const j = await readJsonGuarded(res, `index stats ${name}`);
  return {
    documentCount: j?.documentCount ?? 0,
    storageSize: j?.storageSize ?? 0,
    vectorIndexSize: j?.vectorIndexSize,
  };
}

// ----------------------------------------------------------------------------
// Documents — search
// ----------------------------------------------------------------------------

// Search request + body shaping live in the server-free `search-field-shapes`
// module so the `'use client'` editor can share the exact wire contract. Re-
// exported here so existing imports (`SearchRequest`, `buildSearchBody`, …) from
// the data-plane client keep working.
export type { SearchRequest, VectorQuery } from './search-field-shapes';
export { buildSearchBody } from './search-field-shapes';
import type { SearchRequest } from './search-field-shapes';
import { buildSearchBody } from './search-field-shapes';

/** POST /indexes/{name}/docs/search — run a query. Returns the raw response (value, facets, count). */
export async function searchDocuments(name: string, req: SearchRequest, service?: string): Promise<any> {
  const body = buildSearchBody(req);
  const res = await call(`/indexes/${encodeURIComponent(name)}/docs/search`, { service, method: 'POST', body });
  return readJsonGuarded(res, `search ${name}`);
}

/** POST /indexes/{name}/analyze — run text through an analyzer; returns tokens. */
export async function analyzeText(
  name: string,
  opts: { text: string; analyzer?: string; tokenizer?: string },
  service?: string,
): Promise<any> {
  const body: any = { text: opts.text };
  if (opts.analyzer) body.analyzer = opts.analyzer;
  else if (opts.tokenizer) body.tokenizer = opts.tokenizer;
  else body.analyzer = 'standard.lucene';
  const res = await call(`/indexes/${encodeURIComponent(name)}/analyze`, { service, method: 'POST', body });
  return readJsonGuarded(res, `analyze ${name}`);
}

// ----------------------------------------------------------------------------
// Indexers / data sources / skillsets
// ----------------------------------------------------------------------------

/** GET /indexers — list indexers (name, targetIndexName, dataSourceName, schedule, disabled). */
export async function listIndexers(service?: string): Promise<Array<{ name: string; targetIndexName?: string; dataSourceName?: string; skillsetName?: string; schedule?: { interval: string; startTime?: string } | null; disabled?: boolean }>> {
  const res = await call('/indexers', { service, query: { $select: 'name,targetIndexName,dataSourceName,skillsetName,schedule,disabled' } });
  const j = await readJsonGuarded(res, 'list indexers');
  return (j?.value || []).map((x: any) => ({
    name: x.name,
    targetIndexName: x.targetIndexName,
    dataSourceName: x.dataSourceName,
    skillsetName: x.skillsetName,
    schedule: x.schedule ? { interval: x.schedule.interval, startTime: x.schedule.startTime } : null,
    disabled: !!x.disabled,
  }));
}

/** GET /indexers/{name} — full indexer definition (incl. schedule + disabled). 404 → null. */
export async function getIndexer(name: string, service?: string): Promise<any | null> {
  const res = await call(`/indexers/${encodeURIComponent(name)}`, { service });
  if (res.status === 404) return null;
  return readJsonGuarded(res, `get indexer ${name}`);
}

/**
 * Update only the schedule (and optional disabled flag) on an existing indexer,
 * preserving every other property. We GET the current definition, merge the
 * new schedule, then PUT /indexers/{name}. A null/undefined `schedule` removes
 * the recurrence (omits the property on the wire). Grounded in Learn:
 *   https://learn.microsoft.com/azure/search/search-howto-schedule-indexers
 */
export async function updateIndexerSchedule(
  name: string,
  schedule: { interval: string; startTime?: string } | null,
  disabled?: boolean,
  service?: string,
): Promise<any> {
  const current = await getIndexer(name, service);
  if (!current) throw new SearchDataError(404, undefined, `indexer ${name} not found`);
  const def: any = { ...current };
  delete def['@odata.context'];
  delete def['@odata.etag'];
  if (schedule && schedule.interval) {
    def.schedule = { interval: schedule.interval, ...(schedule.startTime ? { startTime: schedule.startTime } : {}) };
  } else {
    delete def.schedule;
  }
  if (typeof disabled === 'boolean') def.disabled = disabled;
  def.name = name;
  const res = await call(`/indexers/${encodeURIComponent(name)}`, { service, method: 'PUT', body: def });
  return readJsonGuarded(res, `update indexer schedule ${name}`);
}

/** GET /indexers/{name}/status — execution status + last run result. */
export async function getIndexerStatus(name: string, service?: string): Promise<any> {
  const res = await call(`/indexers/${encodeURIComponent(name)}/status`, { service });
  return readJsonGuarded(res, `indexer status ${name}`);
}

/** POST /indexers/{name}/run — kick an on-demand run. 202/204 → ok. */
export async function runIndexer(name: string, service?: string): Promise<{ ok: true }> {
  const res = await call(`/indexers/${encodeURIComponent(name)}/run`, { service, method: 'POST' });
  if (res.status === 202 || res.status === 204 || res.ok) return { ok: true };
  await readJsonGuarded(res, `run indexer ${name}`);
  return { ok: true };
}

/** POST /indexers/{name}/reset — clear the high-water mark (full reindex on next run). */
export async function resetIndexer(name: string, service?: string): Promise<{ ok: true }> {
  const res = await call(`/indexers/${encodeURIComponent(name)}/reset`, { service, method: 'POST' });
  if (res.status === 202 || res.status === 204 || res.ok) return { ok: true };
  await readJsonGuarded(res, `reset indexer ${name}`);
  return { ok: true };
}

/** GET /datasources — list data source connections (name, type). */
export async function listDataSources(service?: string): Promise<Array<{ name: string; type?: string; container?: string }>> {
  const res = await call('/datasources', { service, query: { $select: 'name,type,container' } });
  const j = await readJsonGuarded(res, 'list datasources');
  return (j?.value || []).map((x: any) => ({ name: x.name, type: x.type, container: x?.container?.name }));
}

/** GET /skillsets — list skillsets (name, skill count). */
export async function listSkillsets(service?: string): Promise<Array<{ name: string; skillCount: number }>> {
  const res = await call('/skillsets', { service });
  const j = await readJsonGuarded(res, 'list skillsets');
  return (j?.value || []).map((x: any) => ({ name: x.name, skillCount: (x.skills || []).length }));
}

// ----------------------------------------------------------------------------
// Indexer create / delete  (PUT /indexers/{name}, DELETE /indexers/{name})
// ----------------------------------------------------------------------------

/**
 * PUT /indexers/{name} — create-or-update an indexer. An indexer needs an
 * existing data source + target index (and optionally a skillset). Per the
 * Create Indexer reference, creating also runs it.
 */
export async function createIndexer(
  def: { name: string; dataSourceName: string; targetIndexName: string; skillsetName?: string; schedule?: any; disabled?: boolean; parameters?: any },
  service?: string,
): Promise<any> {
  if (!def?.name) throw new SearchDataError(400, def, 'create indexer requires name');
  if (!def?.dataSourceName) throw new SearchDataError(400, def, 'create indexer requires dataSourceName');
  if (!def?.targetIndexName) throw new SearchDataError(400, def, 'create indexer requires targetIndexName');
  const res = await call(`/indexers/${encodeURIComponent(def.name)}`, { service, method: 'PUT', body: def });
  return readJsonGuarded(res, `create indexer ${def.name}`);
}

/** DELETE /indexers/{name}. */
export async function deleteIndexer(name: string, service?: string): Promise<void> {
  const res = await call(`/indexers/${encodeURIComponent(name)}`, { service, method: 'DELETE' });
  if (res.status === 404 || res.status === 204) return;
  await readJsonGuarded(res, `delete indexer ${name}`);
}

// ----------------------------------------------------------------------------
// Data sources — full list / create / delete
// ----------------------------------------------------------------------------

/**
 * PUT /datasources/{name} — create-or-update a data source connection.
 * `type` is e.g. azureblob | azuretable | azuresql | cosmosdb | adlsgen2.
 * `credentials.connectionString` carries the connection (or a ResourceId=…
 * managed-identity connection string). `container.name` is required for blob.
 */
export async function createDataSource(
  def: { name: string; type: string; credentials: { connectionString: string }; container: { name: string; query?: string }; description?: string },
  service?: string,
): Promise<any> {
  if (!def?.name) throw new SearchDataError(400, def, 'create data source requires name');
  if (!def?.type) throw new SearchDataError(400, def, 'create data source requires type');
  const res = await call(`/datasources/${encodeURIComponent(def.name)}`, { service, method: 'PUT', body: def });
  return readJsonGuarded(res, `create data source ${def.name}`);
}

/** DELETE /datasources/{name}. */
export async function deleteDataSource(name: string, service?: string): Promise<void> {
  const res = await call(`/datasources/${encodeURIComponent(name)}`, { service, method: 'DELETE' });
  if (res.status === 404 || res.status === 204) return;
  await readJsonGuarded(res, `delete data source ${name}`);
}

// ----------------------------------------------------------------------------
// Skillsets — create (from JSON) / delete
// ----------------------------------------------------------------------------

/** PUT /skillsets/{name} — create-or-update a skillset from a full definition. */
export async function createSkillset(def: any, service?: string): Promise<any> {
  if (!def?.name) throw new SearchDataError(400, def, 'create skillset requires name');
  if (!Array.isArray(def?.skills) || def.skills.length === 0) {
    throw new SearchDataError(400, def, 'a skillset must define at least one skill');
  }
  const res = await call(`/skillsets/${encodeURIComponent(def.name)}`, { service, method: 'PUT', body: def });
  return readJsonGuarded(res, `create skillset ${def.name}`);
}

/** DELETE /skillsets/{name}. */
export async function deleteSkillset(name: string, service?: string): Promise<void> {
  const res = await call(`/skillsets/${encodeURIComponent(name)}`, { service, method: 'DELETE' });
  if (res.status === 404 || res.status === 204) return;
  await readJsonGuarded(res, `delete skillset ${name}`);
}

// ----------------------------------------------------------------------------
// Synonym maps — list / create / delete  (GET|PUT|DELETE /synonymmaps/{name})
// ----------------------------------------------------------------------------

/** GET /synonymmaps — list synonym maps (name, rule count). */
export async function listSynonymMaps(service?: string): Promise<Array<{ name: string; ruleCount: number; format?: string }>> {
  const res = await call('/synonymmaps', { service, query: { $select: 'name,format,synonyms' } });
  const j = await readJsonGuarded(res, 'list synonym maps');
  return (j?.value || []).map((x: any) => ({
    name: x.name,
    format: x.format,
    ruleCount: typeof x.synonyms === 'string' ? x.synonyms.split('\n').filter((l: string) => l.trim()).length : 0,
  }));
}

/**
 * PUT /synonymmaps/{name} — create-or-update a synonym map. `synonyms` is the
 * solr-format rule text (newline-separated), e.g. "USA, United States\nUK => United Kingdom".
 */
export async function createSynonymMap(
  def: { name: string; synonyms: string; format?: string },
  service?: string,
): Promise<any> {
  if (!def?.name) throw new SearchDataError(400, def, 'create synonym map requires name');
  const body = { name: def.name, format: def.format || 'solr', synonyms: def.synonyms || '' };
  const res = await call(`/synonymmaps/${encodeURIComponent(def.name)}`, { service, method: 'PUT', body });
  return readJsonGuarded(res, `create synonym map ${def.name}`);
}

/** DELETE /synonymmaps/{name}. */
export async function deleteSynonymMap(name: string, service?: string): Promise<void> {
  const res = await call(`/synonymmaps/${encodeURIComponent(name)}`, { service, method: 'DELETE' });
  if (res.status === 404 || res.status === 204) return;
  await readJsonGuarded(res, `delete synonym map ${name}`);
}

// ----------------------------------------------------------------------------
// Aliases — list / create / delete  (GET|PUT|DELETE /aliases/{name})
//   An alias is a secondary name that maps to one index, letting you swap the
//   backing index without changing query code. (api-version 2024-07-01+)
// ----------------------------------------------------------------------------

/** GET /aliases — list index aliases (name → indexes). */
export async function listAliases(service?: string): Promise<Array<{ name: string; indexes: string[] }>> {
  const res = await call('/aliases', { service });
  const j = await readJsonGuarded(res, 'list aliases');
  return (j?.value || []).map((x: any) => ({ name: x.name, indexes: x.indexes || [] }));
}

/** PUT /aliases/{name} — create-or-update an alias pointing at exactly one index. */
export async function createAlias(
  def: { name: string; indexes: string[] },
  service?: string,
): Promise<any> {
  if (!def?.name) throw new SearchDataError(400, def, 'create alias requires name');
  if (!Array.isArray(def?.indexes) || def.indexes.length !== 1) {
    throw new SearchDataError(400, def, 'an alias must map to exactly one index');
  }
  const res = await call(`/aliases/${encodeURIComponent(def.name)}`, { service, method: 'PUT', body: { name: def.name, indexes: def.indexes } });
  return readJsonGuarded(res, `create alias ${def.name}`);
}

/** DELETE /aliases/{name}. */
export async function deleteAlias(name: string, service?: string): Promise<void> {
  const res = await call(`/aliases/${encodeURIComponent(name)}`, { service, method: 'DELETE' });
  if (res.status === 404 || res.status === 204) return;
  await readJsonGuarded(res, `delete alias ${name}`);
}

// ----------------------------------------------------------------------------
// Service statistics  (GET /servicestats — counters + quotas per object type)
// ----------------------------------------------------------------------------

/** GET /servicestats — counters & quotas (indexes, indexers, data sources, …). */
export async function getServiceStats(service?: string): Promise<any> {
  const res = await call('/servicestats', { service });
  return readJsonGuarded(res, 'service stats');
}
