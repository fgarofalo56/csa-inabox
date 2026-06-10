/**
 * Pure request/field shaping for Azure AI Search — NO server imports.
 *
 * Split out of `search-index-client.ts` (which pulls in `@azure/identity` and is
 * server-only) so the Search Explorer query-options builder and the visual index
 * field designer in the `'use client'` editor can share the exact same wire
 * shaping the data-plane client uses — and so both are unit-testable without a
 * live service or a credential.
 *
 * Grounded in Microsoft Learn:
 *   - Search - POST (semantic ranking + vector query):
 *     https://learn.microsoft.com/rest/api/searchservice/documents/search-post
 *     https://learn.microsoft.com/azure/search/semantic-how-to-query-request
 *     https://learn.microsoft.com/azure/search/vector-search-how-to-query
 *   - Create / Update Index (field attributes, vector field rules):
 *     https://learn.microsoft.com/azure/search/search-how-to-create-search-index#configure-field-definitions
 *     https://learn.microsoft.com/rest/api/searchservice/indexes/create-or-update
 */

// ----------------------------------------------------------------------------
// Search Explorer — query options
// ----------------------------------------------------------------------------

export interface VectorQuery {
  /** `text` → integrated vectorization (server embeds `text`); `vector` → raw k-NN. */
  kind: 'vector' | 'text';
  vector?: number[];
  text?: string;
  /** Comma-separated vector field name(s) to query. */
  fields: string;
  k?: number;
  exhaustive?: boolean;
}

export interface SearchRequest {
  search?: string;
  filter?: string;
  top?: number;
  select?: string;
  orderby?: string;
  /** Comma-separated fields the query scopes full-text matching to. */
  searchFields?: string;
  facets?: string[];
  /** Vector queries (k-NN / hybrid). */
  vectorQueries?: VectorQuery[];
  queryType?: 'simple' | 'full' | 'semantic';
  /**
   * `any` (default — OR the terms) or `all` (AND the terms). Mirrors the
   * portal Search Explorer "searchMode" toggle. Grounded in Learn (Search -
   * POST: searchMode `any`|`all`).
   */
  searchMode?: 'any' | 'all';
  /**
   * Name of a scoring profile embedded in the index
   * (`index.scoringProfiles[].name`) used to bias the relevance score.
   * Grounded in Learn (Search - POST: `scoringProfile`).
   */
  scoringProfile?: string;
  /**
   * Inputs for the scoring profile's functions, each `"name-value1,value2"`.
   * Grounded in Learn (Search - POST: `scoringParameters` as a string array).
   */
  scoringParameters?: string[];
  /**
   * Comma-separated searchable field names to hit-highlight, each optionally
   * suffixed `-N` to cap the highlights (e.g. `title-3,description-10`).
   * Grounded in Learn (Search - POST: `highlight`).
   */
  highlight?: string;
  /** Override the highlight open tag (default `<em>`). */
  highlightPreTag?: string;
  /** Override the highlight close tag (default `</em>`). */
  highlightPostTag?: string;
  /**
   * Required when queryType=semantic — the name of a semantic configuration
   * embedded in the index (`index.semantic.configurations[].name`). Grounded in
   * Learn: semantic ranking requires `queryType:'semantic'` + `semanticConfiguration`.
   */
  semanticConfiguration?: string;
  /** Semantic answers, e.g. `extractive` / `extractive|count-3`. Semantic only. */
  answers?: string;
  /** Semantic captions, e.g. `extractive` / `extractive|highlight-true`. Semantic only. */
  captions?: string;
  count?: boolean;
}

/**
 * Build the POST /docs/search request body from a SearchRequest. Pure +
 * exported so the request-shaping contract is unit-testable without a live
 * service. Grounded in Microsoft Learn (Search - POST, semantic ranking, vector
 * query): `queryType:'semantic'` pairs with `semanticConfiguration`; semantic
 * `answers`/`captions` are only meaningful for a semantic query; vectorQueries
 * use `kind:'text'` (integrated vectorization) or `kind:'vector'` (raw k-NN).
 */
export function buildSearchBody(req: SearchRequest): any {
  const body: any = {};
  body.search = req.search && req.search.length ? req.search : '*';
  if (req.filter) body.filter = req.filter;
  if (typeof req.top === 'number') body.top = req.top;
  if (req.select) body.select = req.select;
  if (req.orderby) body.orderby = req.orderby;
  if (req.searchFields) body.searchFields = req.searchFields;
  if (req.facets?.length) body.facets = req.facets;
  if (req.queryType) body.queryType = req.queryType;
  if (req.searchMode) body.searchMode = req.searchMode;
  if (req.count !== undefined) body.count = req.count;
  // Scoring profile + its function inputs (relevance boosting).
  if (req.scoringProfile) body.scoringProfile = req.scoringProfile;
  if (req.scoringParameters?.length) body.scoringParameters = req.scoringParameters;
  // Hit highlighting (per-field, with optional custom tags).
  if (req.highlight) {
    body.highlight = req.highlight;
    if (req.highlightPreTag) body.highlightPreTag = req.highlightPreTag;
    if (req.highlightPostTag) body.highlightPostTag = req.highlightPostTag;
  }
  // Semantic parameters only ride along on a semantic query.
  if (req.queryType === 'semantic') {
    if (req.semanticConfiguration) body.semanticConfiguration = req.semanticConfiguration;
    if (req.answers) body.answers = req.answers;
    if (req.captions) body.captions = req.captions;
  }
  if (req.vectorQueries?.length) {
    body.vectorQueries = req.vectorQueries.map((v) => {
      const out: any = { kind: v.kind, fields: v.fields };
      if (v.kind === 'text' && v.text) out.text = v.text;
      if (v.kind === 'vector' && Array.isArray(v.vector)) out.vector = v.vector;
      if (typeof v.k === 'number') out.k = v.k;
      if (v.exhaustive !== undefined) out.exhaustive = v.exhaustive;
      return out;
    });
  }
  return body;
}

// ----------------------------------------------------------------------------
// Visual index field designer — field rows
// ----------------------------------------------------------------------------

/**
 * One row of the visual field designer (the editable grid behind the index
 * Schema tab) — everything the portal per-field grid edits.
 */
export interface FieldRow {
  name: string;
  type: string;
  key?: boolean;
  searchable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  facetable?: boolean;
  retrievable?: boolean;
  analyzer?: string;
  dimensions?: number;
  vectorSearchProfile?: string;
}

/** Edm types the designer's type picker offers (per Learn supported data types). */
export const FIELD_TYPES: string[] = [
  'Edm.String',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.Double',
  'Edm.Boolean',
  'Edm.DateTimeOffset',
  'Edm.GeographyPoint',
  'Collection(Edm.String)',
  'Collection(Edm.Single)',
];

/** Built-in language analyzers the designer offers for string fields. */
export const ANALYZERS: string[] = [
  'standard.lucene',
  'keyword',
  'simple',
  'stop',
  'whitespace',
  'pattern',
  'en.microsoft',
  'en.lucene',
];

/** A field is a vector field when its type is a `Collection(Edm.*)` numeric vector type. */
export function isVectorFieldType(type: string): boolean {
  return /^Collection\(Edm\.(Single|Half|Int16|Int8|Byte)\)$/.test((type || '').trim());
}

/**
 * Normalize one designer row into a valid Azure AI Search field definition.
 *
 * Pure + exported so the field-designer's create/update payload is unit-testable
 * without a live service. Grounded in Microsoft Learn (Create/Update Index —
 * "filterable, sortable, facetable, analyzer … are ignored for vector fields";
 * vector fields require `dimensions` + `vectorSearchProfile`; the key field must
 * be `Edm.String` and `retrievable`). We drop the ignored attributes so the wire
 * payload is exactly what the portal would send, and only emit `analyzer`/
 * `dimensions`/`vectorSearchProfile` where they're valid.
 */
export function fieldRowToApiField(row: FieldRow): any {
  const type = (row.type || 'Edm.String').trim();
  const vector = isVectorFieldType(type);
  const f: any = {
    name: row.name,
    type,
    key: !!row.key,
    // Per Learn, a key field must be retrievable; otherwise honor the flag (default true).
    retrievable: row.key ? true : row.retrievable !== false,
    searchable: !!row.searchable,
  };
  if (vector) {
    // Vector fields: filterable/sortable/facetable/analyzer are ignored — omit them.
    f.filterable = false;
    f.sortable = false;
    f.facetable = false;
    if (typeof row.dimensions === 'number' && row.dimensions > 0) f.dimensions = row.dimensions;
    if (row.vectorSearchProfile) f.vectorSearchProfile = row.vectorSearchProfile;
  } else {
    f.filterable = !!row.filterable;
    f.sortable = !!row.sortable;
    f.facetable = !!row.facetable;
    if (row.searchable && row.analyzer) f.analyzer = row.analyzer;
  }
  return f;
}

/** Shape an index definition's raw field into an editable designer row. */
export function apiFieldToRow(f: any): FieldRow {
  return {
    name: f?.name ?? '',
    type: f?.type ?? 'Edm.String',
    key: !!f?.key,
    searchable: !!f?.searchable,
    filterable: !!f?.filterable,
    sortable: !!f?.sortable,
    facetable: !!f?.facetable,
    retrievable: f?.retrievable !== false,
    analyzer: f?.analyzer,
    dimensions: typeof f?.dimensions === 'number' ? f.dimensions : undefined,
    vectorSearchProfile: f?.vectorSearchProfile,
  };
}

/**
 * Merge an edited field-designer grid back into an existing index definition,
 * preserving every non-field section (vectorSearch, semantic, scoringProfiles,
 * analyzers, suggesters, etc.). Pure + exported for round-trip testing.
 */
export function applyFieldRows(existing: any, rows: FieldRow[]): any {
  return { ...(existing || {}), fields: rows.map(fieldRowToApiField) };
}

/** Names of the semantic configurations embedded in an index definition. */
export function semanticConfigNames(index: any): string[] {
  const cfgs = index?.semantic?.configurations;
  if (!Array.isArray(cfgs)) return [];
  return cfgs.map((c: any) => c?.name).filter((n: any): n is string => typeof n === 'string' && !!n);
}

/** Names of the vector-search profiles embedded in an index definition. */
export function vectorProfileNames(index: any): string[] {
  const profs = index?.vectorSearch?.profiles;
  if (!Array.isArray(profs)) return [];
  return profs.map((p: any) => p?.name).filter((n: any): n is string => typeof n === 'string' && !!n);
}

/** Names of the scoring profiles embedded in an index definition. */
export function scoringProfileNames(index: any): string[] {
  const profs = index?.scoringProfiles;
  if (!Array.isArray(profs)) return [];
  return profs.map((p: any) => p?.name).filter((n: any): n is string => typeof n === 'string' && !!n);
}

/** Names of the index's facetable, retrievable fields (valid faceting targets). */
export function facetableFieldNames(index: any): string[] {
  const fields = index?.fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f: any) => f?.facetable && !isVectorFieldType(f?.type || ''))
    .map((f: any) => f?.name)
    .filter((n: any): n is string => typeof n === 'string' && !!n);
}

// ----------------------------------------------------------------------------
// Indexer schedule designer
//
// An indexer schedule is `{ interval, startTime }` on the indexer definition
// (PUT /indexers/{name}). `interval` is an XSD dayTimeDuration subset:
// `P[nD][T[nH][nM]]` — minimum 5 minutes (PT5M), maximum 24 hours (P1D / PT24H).
// Removing a schedule = omit it; pausing = `disabled: true` on the indexer.
// Grounded in Microsoft Learn:
//   https://learn.microsoft.com/azure/search/search-howto-schedule-indexers
//   https://learn.microsoft.com/rest/api/searchservice/indexers/create-or-update
// ----------------------------------------------------------------------------

/** One indexer schedule (the recurrence applied to PUT /indexers/{name}). */
export interface IndexerSchedule {
  /** XSD dayTimeDuration, e.g. `PT2H`, `PT30M`, `P1D`. */
  interval: string;
  /** Optional UTC ISO-8601 datetime to anchor the first run. */
  startTime?: string;
}

/** Schedule recurrence presets the designer offers (Custom = author the interval). */
export const SCHEDULE_PRESETS: { label: string; interval: string }[] = [
  { label: 'Every 5 minutes', interval: 'PT5M' },
  { label: 'Every 15 minutes', interval: 'PT15M' },
  { label: 'Every 30 minutes', interval: 'PT30M' },
  { label: 'Hourly', interval: 'PT1H' },
  { label: 'Every 2 hours', interval: 'PT2H' },
  { label: 'Every 6 hours', interval: 'PT6H' },
  { label: 'Every 12 hours', interval: 'PT12H' },
  { label: 'Daily', interval: 'P1D' },
  { label: 'Custom', interval: '' },
];

/**
 * Validate an indexer schedule interval against the Azure AI Search rules:
 * the XSD dayTimeDuration subset `P[nD][T[nH][nM]]`, minimum 5 minutes,
 * maximum 24 hours. Returns null when valid, or a human-readable error.
 * Pure + exported for unit testing.
 */
export function validateScheduleInterval(interval: string): string | null {
  const v = (interval || '').trim().toUpperCase();
  if (!v) return 'Interval is required (e.g. PT2H, PT30M, P1D).';
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(v);
  if (!m || (!m[1] && !m[2] && !m[3])) {
    return 'Interval must be an ISO-8601 duration like PT5M, PT2H, or P1D.';
  }
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const minutes = m[3] ? parseInt(m[3], 10) : 0;
  const totalMinutes = days * 24 * 60 + hours * 60 + minutes;
  if (totalMinutes < 5) return 'Minimum schedule interval is 5 minutes (PT5M).';
  if (totalMinutes > 24 * 60) return 'Maximum schedule interval is 24 hours (P1D / PT24H).';
  return null;
}

/** Human-readable label for an interval (maps known presets, else echoes the interval). */
export function describeScheduleInterval(interval?: string): string {
  if (!interval) return '—';
  const preset = SCHEDULE_PRESETS.find((p) => p.interval && p.interval === interval.trim().toUpperCase());
  return preset ? preset.label : interval;
}

// ----------------------------------------------------------------------------
// Semantic configuration designer
//
// Lives inside the index definition at `index.semantic.configurations[]`. A
// configuration prioritizes a title field, content fields, and keyword fields
// for semantic ranking. The service must have `semanticSearch` set to
// `free`/`standard` (the Loom service is `standard`). Saved via PUT /indexes.
// Grounded in Microsoft Learn:
//   https://learn.microsoft.com/azure/search/semantic-how-to-configure
// ----------------------------------------------------------------------------

/** A single prioritized field reference inside a semantic configuration. */
export interface SemanticFieldRef { fieldName: string; }

/** One semantic configuration (index.semantic.configurations[]). */
export interface SemanticConfig {
  name: string;
  prioritizedFields: {
    titleField?: SemanticFieldRef;
    prioritizedContentFields?: SemanticFieldRef[];
    prioritizedKeywordsFields?: SemanticFieldRef[];
  };
}

/** Build the `index.semantic` section from a designer's configs. */
export function buildSemanticSection(configs: SemanticConfig[]): any {
  return {
    configurations: (configs || []).map((c) => {
      const pf: any = {};
      if (c.prioritizedFields?.titleField?.fieldName) {
        pf.titleField = { fieldName: c.prioritizedFields.titleField.fieldName };
      }
      const content = (c.prioritizedFields?.prioritizedContentFields || [])
        .filter((f) => f?.fieldName)
        .map((f) => ({ fieldName: f.fieldName }));
      if (content.length) pf.prioritizedContentFields = content;
      const keywords = (c.prioritizedFields?.prioritizedKeywordsFields || [])
        .filter((f) => f?.fieldName)
        .map((f) => ({ fieldName: f.fieldName }));
      if (keywords.length) pf.prioritizedKeywordsFields = keywords;
      return { name: c.name, prioritizedFields: pf };
    }),
  };
}

/** Parse the `index.semantic.configurations[]` into editable designer configs. */
export function parseSemanticSection(index: any): SemanticConfig[] {
  const cfgs = index?.semantic?.configurations;
  if (!Array.isArray(cfgs)) return [];
  return cfgs.map((c: any) => ({
    name: c?.name ?? '',
    prioritizedFields: {
      titleField: c?.prioritizedFields?.titleField?.fieldName
        ? { fieldName: c.prioritizedFields.titleField.fieldName }
        : undefined,
      prioritizedContentFields: Array.isArray(c?.prioritizedFields?.prioritizedContentFields)
        ? c.prioritizedFields.prioritizedContentFields
            .filter((f: any) => f?.fieldName)
            .map((f: any) => ({ fieldName: f.fieldName }))
        : [],
      prioritizedKeywordsFields: Array.isArray(c?.prioritizedFields?.prioritizedKeywordsFields)
        ? c.prioritizedFields.prioritizedKeywordsFields
            .filter((f: any) => f?.fieldName)
            .map((f: any) => ({ fieldName: f.fieldName }))
        : [],
    },
  }));
}

/** Searchable string fields are the only valid semantic-config targets. */
export function semanticEligibleFieldNames(index: any): string[] {
  const fields = index?.fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .filter((f: any) => f?.searchable && /Edm\.String/.test(f?.type || '') && !isVectorFieldType(f?.type || ''))
    .map((f: any) => f?.name)
    .filter((n: any): n is string => typeof n === 'string' && !!n);
}

// ----------------------------------------------------------------------------
// Vector search designer
//
// Lives inside `index.vectorSearch.algorithms[]` + `index.vectorSearch.profiles[]`.
// An algorithm is `hnsw` (graph) or `exhaustiveKnn` (brute force); a profile
// binds a name to an algorithm (and optionally a vectorizer). Saved via PUT
// /indexes. Grounded in Microsoft Learn:
//   https://learn.microsoft.com/azure/search/vector-search-how-to-create-index
//   https://learn.microsoft.com/azure/search/vector-search-ranking
// ----------------------------------------------------------------------------

export type VectorMetric = 'cosine' | 'dotProduct' | 'euclidean' | 'hamming';
export const VECTOR_METRICS: VectorMetric[] = ['cosine', 'dotProduct', 'euclidean', 'hamming'];

/** One vector-search algorithm configuration. */
export interface VectorAlgorithm {
  name: string;
  kind: 'hnsw' | 'exhaustiveKnn';
  hnswParameters?: { m?: number; efConstruction?: number; efSearch?: number; metric?: VectorMetric };
  exhaustiveKnnParameters?: { metric?: VectorMetric };
}

/** One vector-search profile (binds a profile name to an algorithm). */
export interface VectorProfile { name: string; algorithm: string; vectorizer?: string; }

/** Default HNSW parameters (the Azure defaults: m=4, efConstruction=400, efSearch=500, cosine). */
export function defaultHnswParameters(): NonNullable<VectorAlgorithm['hnswParameters']> {
  return { m: 4, efConstruction: 400, efSearch: 500, metric: 'cosine' };
}

/** Build the `index.vectorSearch` section from a designer's algorithms + profiles. */
export function buildVectorSearchSection(algorithms: VectorAlgorithm[], profiles: VectorProfile[]): any {
  const algos = (algorithms || []).map((a) => {
    const out: any = { name: a.name, kind: a.kind };
    if (a.kind === 'hnsw') {
      const p = a.hnswParameters || defaultHnswParameters();
      out.hnswParameters = {
        m: typeof p.m === 'number' ? p.m : 4,
        efConstruction: typeof p.efConstruction === 'number' ? p.efConstruction : 400,
        efSearch: typeof p.efSearch === 'number' ? p.efSearch : 500,
        metric: p.metric || 'cosine',
      };
    } else {
      const p = a.exhaustiveKnnParameters || {};
      out.exhaustiveKnnParameters = { metric: p.metric || 'cosine' };
    }
    return out;
  });
  const profs = (profiles || [])
    .filter((p) => p?.name && p?.algorithm)
    .map((p) => {
      const out: any = { name: p.name, algorithm: p.algorithm };
      if (p.vectorizer) out.vectorizer = p.vectorizer;
      return out;
    });
  return { algorithms: algos, profiles: profs };
}

/** Parse `index.vectorSearch` into editable algorithms + profiles. */
export function parseVectorSearchSection(index: any): { algorithms: VectorAlgorithm[]; profiles: VectorProfile[] } {
  const vs = index?.vectorSearch || {};
  const algorithms: VectorAlgorithm[] = Array.isArray(vs.algorithms)
    ? vs.algorithms.map((a: any) => {
        const kind: VectorAlgorithm['kind'] = a?.kind === 'exhaustiveKnn' ? 'exhaustiveKnn' : 'hnsw';
        if (kind === 'hnsw') {
          const p = a?.hnswParameters || {};
          return {
            name: a?.name ?? '',
            kind,
            hnswParameters: {
              m: typeof p.m === 'number' ? p.m : 4,
              efConstruction: typeof p.efConstruction === 'number' ? p.efConstruction : 400,
              efSearch: typeof p.efSearch === 'number' ? p.efSearch : 500,
              metric: (p.metric as VectorMetric) || 'cosine',
            },
          };
        }
        const p = a?.exhaustiveKnnParameters || {};
        return { name: a?.name ?? '', kind, exhaustiveKnnParameters: { metric: (p.metric as VectorMetric) || 'cosine' } };
      })
    : [];
  const profiles: VectorProfile[] = Array.isArray(vs.profiles)
    ? vs.profiles.map((p: any) => ({ name: p?.name ?? '', algorithm: p?.algorithm ?? '', vectorizer: p?.vectorizer }))
    : [];
  return { algorithms, profiles };
}

/** True when an index has at least one vector field (the gate for the vector designer). */
export function indexHasVectorField(index: any): boolean {
  const fields = index?.fields;
  if (!Array.isArray(fields)) return false;
  return fields.some((f: any) => isVectorFieldType(f?.type || ''));
}
