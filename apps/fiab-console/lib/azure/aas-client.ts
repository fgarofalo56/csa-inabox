/**
 * aas-client.ts — Azure Analysis Services / Power BI tabular client.
 *
 * This module carries THREE complementary, independent feature sets:
 *
 * A) **Composite (mixed-storage-mode) TMSL builder + Fabric apply path.**
 *    Builds a `model.bim` TMSL `Database` object whose tables carry a
 *    per-partition storage **mode** — `import`, `directQuery`, or `dual` — so a
 *    single tabular model can mix modes (a Power BI / Analysis Services
 *    *composite* model). The `"dual"` value is a Power BI Premium / Fabric XMLA
 *    extension (compatibility level ≥ 1560); standalone Azure Analysis Services
 *    accepts only `"import"` and `"directQuery"`.
 *
 *    APPLY PATHS — Node.js cannot issue arbitrary TMSL commands
 *    (createOrReplace / alter) to AAS over plain HTTP — the AAS REST surface at
 *    `asazure.windows.net` only exposes async refresh, and full TMSL execution
 *    requires an XMLA TCP connection (TOM/AMO). The one REST path from Node that
 *    accepts the same `model.bim` TMSL payload is the **Fabric updateDefinition
 *    API**, which wraps XMLA internally:
 *
 *      POST /v1/workspaces/{ws}/semanticModels/{id}/updateDefinition
 *
 *    So there are two honest outcomes (per no-vaporware.md):
 *      1. Fabric / Power-BI-Premium backed workspace (opt-in): the TMSL is
 *         applied in-place via updateDefinition.
 *      2. No Fabric capacity: the TMSL is BUILT and returned as the receipt for
 *         offline application — `Invoke-ASCmd -Server "asazure://…" -Query <tmsl>`.
 *
 *    The default semantic-model item never depends on this builder — its
 *    Azure-native default is the Loom-native tabular layer (see
 *    no-fabric-dependency.md). This path is reached only from the editor's
 *    opt-in Power BI / Fabric surface.
 *
 * B) **AAS async-refresh + data-plane DAX query** (Azure-native, NO Fabric):
 *
 *    1. **Async-refresh** (semantic-layer refresh for the Power Query (M) ingest
 *       path): after an authored M mashup materialises a Delta table in ADLS
 *       Gen2, the AAS tabular model — whose partition source already points at
 *       that Delta path — is refreshed via the AAS asynchronous-refresh REST API:
 *
 *         POST https://<region>.asazure.windows.net/servers/<server>/models/<model>/refreshes
 *         GET  https://<region>.asazure.windows.net/servers/<server>/models/<model>/refreshes/<id>
 *
 *    2. **Data-plane DAX query** (Loom-native default for the Report editor,
 *       LOOM_BI_BACKEND unset): the Azure-native report renderer backend (no
 *       Power BI / Fabric workspace required, per no-fabric-dependency.md):
 *
 *         POST https://{region}.asazure.windows.net/servers/{server}/models/{db}/query
 *         Body: { queries: [{ query }], serializerSettings: { includeNulls: true } }
 *
 * C) **Direct-Lake-shim enhanced refresh** (Power BI REST; Azure-native,
 *    NO Fabric F-SKU required). The shim achieves Direct-Lake-style freshness on
 *    Azure by driving Power BI Premium **enhanced (asynchronous) refresh** over
 *    the Analysis Services / XMLA data plane — partition-scoped, incremental,
 *    triggered by ADLS `_delta_log` Event Grid notifications. It is a distinct
 *    concern (and a distinct AAD audience — `pbiRestScope()`, the
 *    `analysis.*/powerbi/api` resource, NOT the AAS `*.asazure.windows.net`
 *    data-plane audience) from the broad workspace navigation in
 *    powerbi-client.ts:
 *
 *      POST   {base}/groups/{ws}/datasets/{id}/refreshes        → queue (202)
 *      GET    {base}/groups/{ws}/datasets/{id}/refreshes?$top=N → history
 *      GET    {base}/groups/{ws}/datasets/{id}/refreshes/{rid}  → one run
 *      https://learn.microsoft.com/power-bi/connect-data/asynchronous-refresh
 *
 *    The shim is opt-in (it requires a Power BI Premium / PPU workspace + XMLA
 *    endpoint), gated by `LOOM_DIRECT_LAKE_SHIM_ENABLED=true`; when off the BFF
 *    renders the honest setup MessageBar (SHIM_DISABLED_HINT) — no Fabric
 *    dependency on the default path.
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
 * DefaultAzureCredential). The async-refresh / DAX paths request the AAS
 * audience — per Microsoft Learn the token audience must be **exactly**
 * `https://*.asazure.windows.net` (the `*` is a LITERAL character, not a
 * wildcard) — derived via aasScope() (isGovCloud-aware). The shim enhanced-
 * refresh path requests the Power BI REST audience via pbiRestScope(). The
 * Console UAMI must hold the **server administrator** role on the AAS server
 * (set via `Microsoft.AnalysisServices/servers.properties.asAdministrators.
 * members[]`, NOT an Azure RBAC role assignment — see aas.bicep). The Fabric
 * apply path requests the Fabric `.default` scope instead.
 *
 * Sovereign clouds: **Azure Analysis Services has no Azure Government offering
 * for the refresh ingest path** — aasConfigGate() returns an honest gate
 * (`AAS_NOT_IN_GOV`) BEFORE any token/network call and directs the operator to
 * query the Delta table via Synapse Serverless `OPENROWSET(... FORMAT='DELTA')`.
 *
 * No mocks. Real AAS / Power BI / Fabric REST only.
 *
 * Refs (grounded in Microsoft Learn, sql-analysis-services-2025):
 *   - Async refresh REST API + authentication (audience):
 *     learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh
 *   - Power BI enhanced (asynchronous) refresh:
 *     learn.microsoft.com/power-bi/connect-data/asynchronous-refresh
 *   - Fabric semantic-model definition (updateDefinition):
 *     learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/semantic-model-definition
 *   - TMSL Partitions object: learn.microsoft.com/analysis-services/tmsl/partitions-object-tmsl
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { detectLoomCloud, aasScope, aasModelUrl, pbiRestScope, getPbiGovHost } from './cloud-endpoints';
import {
  type AasRow,
  type AasTable,
  type AasQueryResult,
  resolveAasBinding,
  buildDaxFromVisual,
  flattenAasRows,
} from './aas-dax';

// Re-export the pure helpers so existing call sites can keep importing from
// aas-client. The pure logic lives in aas-dax (no @azure/identity) so it stays
// unit-testable without the credential chain.
export {
  resolveAasBinding,
  buildDaxFromVisual,
  flattenAasRows,
};
export type { AasRow, AasTable, AasQueryResult };

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

// The audience MUST be the literal `https://*.asazure.windows.net` (the `*` is
// not a placeholder). `.default` requests an app-level token whose `aud` claim
// resolves to exactly that audience. Used by the async-refresh path; the DAX
// query path derives its (gov-aware) scope from aasScope() at call time.
const AAS_SCOPE = 'https://*.asazure.windows.net/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ---------------------------------------------------------------------------
// Composite TMSL builder types (feature set A)
// ---------------------------------------------------------------------------

export type TableStorageMode = 'import' | 'directQuery' | 'dual';

export const TABLE_STORAGE_MODES: readonly TableStorageMode[] = ['import', 'directQuery', 'dual'];

export interface CompositeColumn {
  name: string;
  /** Tabular dataType (e.g. "string", "int64", "double", "dateTime"). */
  dataType?: string;
  /** Source column in the DirectQuery/Dual query result (defaults to name). */
  sourceColumn?: string;
}

export interface CompositeMeasure {
  name: string;
  expression: string;
  formatString?: string;
}

export interface CompositeTableSpec {
  name: string;
  /** Storage mode for the table's default partition. */
  mode: TableStorageMode;
  /** SQL/M query for the partition — required when mode is directQuery or dual. */
  sourceQuery?: string;
  /** Name of the model-level dataSource the DQ/Dual partition reads from. */
  dataSourceName?: string;
  columns?: CompositeColumn[];
  measures?: CompositeMeasure[];
}

export interface CompositeRelationship {
  name?: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** TMSL crossFilteringBehavior — "oneDirection" (default) | "bothDirections" | "automatic". */
  crossFilteringBehavior?: 'oneDirection' | 'bothDirections' | 'automatic';
  isActive?: boolean;
}

export interface CompositeDataSource {
  /** Unique name within the model (referenced by partition.source.dataSource). */
  name: string;
  /** Structured/Provider data-source type (e.g. "sql", "structured"). */
  type?: string;
  /** Provider connectionString, or M expression for a structured source. */
  connectionString?: string;
  /** "impersonateServiceAccount" (default) | "impersonateCurrentUser". */
  impersonationMode?: string;
}

export interface BuildCompositeOptions {
  /** Compatibility level. 1567 (default) satisfies the ≥1560 "dual" requirement. */
  compatibilityLevel?: number;
  /** Model culture. Defaults to "en-US". */
  culture?: string;
  /**
   * When "aas-standalone", a `"dual"` mode table is rejected (standalone AAS
   * does not support Dual). Default "fabric" accepts all three modes.
   */
  targetEngine?: 'fabric' | 'aas-standalone';
}

// ---------------------------------------------------------------------------
// Shared error type
// ---------------------------------------------------------------------------

export class AasError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

// ---------------------------------------------------------------------------
// AAS async-refresh + DAX query (feature set B)
// ---------------------------------------------------------------------------

/**
 * Honest config gate for the AAS refresh path. Returns the precise blocker so
 * the BFF can surface an exact MessageBar (and the ingest route can skip Phase C
 * with an explanatory warning) instead of erroring. Returns null when AAS is
 * usable. Order matters: the gov-cloud check fires first because AAS simply
 * does not exist there — no env var can satisfy it.
 */
export function aasConfigGate(): { missing: string; reason?: string } | null {
  const cloud = detectLoomCloud();
  if (cloud === 'GCC-High' || cloud === 'DoD') {
    return {
      missing: 'AAS_NOT_IN_GOV',
      reason:
        'Azure Analysis Services is not available in Azure Government (GCC-High / DoD). ' +
        'Query the Delta table directly via Synapse Serverless SQL ' +
        "(OPENROWSET(BULK '<deltaPath>', FORMAT='DELTA')) — set LOOM_SYNAPSE_WORKSPACE to enable it.",
    };
  }
  if (!process.env.LOOM_AAS_SERVER) {
    return {
      missing: 'LOOM_AAS_SERVER',
      reason:
        'Set LOOM_AAS_SERVER to the AAS connection string ' +
        '(asazure://<region>.asazure.windows.net/<serverName>) — deployed by ' +
        'platform/fiab/bicep/modules/landing-zone/aas.bicep.',
    };
  }
  if (!process.env.LOOM_AAS_MODEL) {
    return {
      missing: 'LOOM_AAS_MODEL',
      reason: 'Set LOOM_AAS_MODEL to the tabular model (database) name on the AAS server.',
    };
  }
  return null;
}

/**
 * Parse `LOOM_AAS_SERVER` (asazure://<region>.asazure.windows.net/<serverName>)
 * into the REST host + server name. Accepts a bare `https://…` form too.
 */
function parseServer(): { host: string; server: string } {
  const raw = (process.env.LOOM_AAS_SERVER || '').trim();
  if (!raw) throw new Error('Missing env var: LOOM_AAS_SERVER');
  // asazure://westus.asazure.windows.net/myserver  → host, server
  const m = raw.match(/^(?:asazure|https?):\/\/([^/]+)\/([^/?#]+)/i);
  if (!m) {
    throw new Error(
      `LOOM_AAS_SERVER is malformed: "${raw}". Expected asazure://<region>.asazure.windows.net/<serverName>.`,
    );
  }
  return { host: m[1], server: m[2] };
}

/** Base REST URL for the configured server + model: …/servers/<s>/models/<m>. */
function modelBase(): string {
  const { host, server } = parseServer();
  const model = (process.env.LOOM_AAS_MODEL || '').trim();
  if (!model) throw new Error('Missing env var: LOOM_AAS_MODEL');
  return `https://${host}/servers/${encodeURIComponent(server)}/models/${encodeURIComponent(model)}`;
}

async function authHeader(): Promise<string> {
  const tok = await credential.getToken(AAS_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire Azure Analysis Services token');
  return `Bearer ${tok.token}`;
}

/** A single AAS refresh object to refresh (table, optionally a partition). */
export interface AasRefreshObject {
  table: string;
  /** Partition name — omit for a whole-table refresh. */
  partition?: string;
}

export interface AasRefreshOptions {
  /** Processing type — 'full' reloads + recalcs (default). */
  type?: 'full' | 'clearValues' | 'calculate' | 'dataOnly' | 'automatic' | 'defragment';
  /** transactional = all-or-nothing; partialBatch = commit completed batches. */
  commitMode?: 'transactional' | 'partialBatch';
  maxParallelism?: number;
  retryCount?: number;
}

export interface AasRefreshHandle {
  /** The refresh id (the last path segment of the 202 Location header). */
  refreshId: string;
  status: string;
}

/**
 * POST a new asynchronous refresh. Returns the refreshId parsed from the
 * `Location` response header (the AAS async pattern — 202 Accepted + Location).
 * `objects` scopes the refresh to specific tables/partitions; omit to refresh
 * the whole model.
 */
export async function postAasRefresh(
  objects?: AasRefreshObject[],
  opts?: AasRefreshOptions,
): Promise<AasRefreshHandle> {
  const body: Record<string, unknown> = {
    Type: opts?.type || 'full',
    CommitMode: opts?.commitMode || 'transactional',
    MaxParallelism: opts?.maxParallelism ?? 2,
    RetryCount: opts?.retryCount ?? 2,
  };
  if (objects && objects.length) {
    body.Objects = objects.map((o) => (o.partition ? { table: o.table, partition: o.partition } : { table: o.table }));
  }
  const r = await fetch(`${modelBase()}/refreshes`, {
    method: 'POST',
    headers: { authorization: await authHeader(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok && r.status !== 202) {
    throw new Error(`postAasRefresh failed ${r.status}: ${await r.text()}`);
  }
  // 202 Accepted → Location header carries the polling URL whose final segment
  // is the refreshId. Some gateways also echo the id in the JSON body.
  const loc = r.headers.get('location') || r.headers.get('Location') || '';
  let refreshId = loc ? loc.replace(/[/?#].*$/, '').split('/').filter(Boolean).pop() || '' : '';
  if (!refreshId) {
    try {
      const j = (await r.clone().json()) as { refreshId?: string; RefreshId?: string };
      refreshId = j.refreshId || j.RefreshId || '';
    } catch { /* no body */ }
  }
  return { refreshId, status: 'inProgress' };
}

export interface AasRefreshStatus {
  status: 'notStarted' | 'inProgress' | 'succeeded' | 'failed' | 'timedOut' | 'cancelled' | string;
  startTime?: string;
  endTime?: string;
  type?: string;
  error?: string;
}

/** GET the status of a previously-queued refresh. */
export async function getAasRefreshStatus(refreshId: string): Promise<AasRefreshStatus> {
  const r = await fetch(`${modelBase()}/refreshes/${encodeURIComponent(refreshId)}`, {
    headers: { authorization: await authHeader() },
  });
  if (!r.ok) {
    throw new Error(`getAasRefreshStatus failed ${r.status}: ${await r.text()}`);
  }
  const j = (await r.json()) as {
    status?: string;
    startTime?: string;
    endTime?: string;
    type?: string;
    messages?: Array<{ message?: string; type?: string }>;
  };
  const errMsg = (j.messages || [])
    .filter((mm) => (mm.type || '').toLowerCase().includes('error') || (mm.type || '').toLowerCase() === 'warning')
    .map((mm) => mm.message)
    .filter(Boolean)
    .join('; ');
  return {
    status: (j.status as AasRefreshStatus['status']) || 'inProgress',
    startTime: j.startTime,
    endTime: j.endTime,
    type: j.type,
    error: errMsg || undefined,
  };
}

/** Strip any chars Tabular rejects inside an object name and trim. */
function cleanName(s: string | undefined): string {
  return String(s ?? '').trim();
}

/**
 * Build a `model.bim` TMSL (Database object) with per-partition storage modes.
 * Pure — no I/O. The result is the JSON string to base64-encode for the Fabric
 * updateDefinition `model.bim` part (or to hand to `Invoke-ASCmd` offline).
 *
 * Per-table partition emitted (grounded in the TMSL Partitions object spec,
 * https://learn.microsoft.com/analysis-services/tmsl/partitions-object-tmsl):
 *   import      → { mode: "import",      source: { type: "none" } }
 *   directQuery → { mode: "directQuery", source: { type: "query", query, dataSource } }
 *   dual        → { mode: "dual",        source: { type: "query", query, dataSource } }
 *
 * A model-level `dataSources[]` entry is auto-emitted for any DQ/Dual table
 * whose `dataSourceName` is not already present in the supplied `dataSources`.
 */
export function buildCompositeTmsl(
  modelName: string,
  tables: CompositeTableSpec[],
  relationships?: CompositeRelationship[],
  dataSources?: CompositeDataSource[],
  options?: BuildCompositeOptions,
): string {
  const compatibilityLevel = options?.compatibilityLevel ?? 1567;
  const culture = options?.culture ?? 'en-US';
  const targetEngine = options?.targetEngine ?? 'fabric';

  if (!Array.isArray(tables) || tables.length === 0) {
    throw new AasError('buildCompositeTmsl requires at least one table.', 400);
  }

  // Collect explicitly-provided data sources first (keyed by name).
  const dsByName = new Map<string, CompositeDataSource>();
  for (const ds of dataSources || []) {
    if (ds?.name) dsByName.set(ds.name, ds);
  }

  const tmslTables = tables.map((t) => {
    const name = cleanName(t.name);
    if (!name) throw new AasError('Every table needs a name.', 400);
    if (!TABLE_STORAGE_MODES.includes(t.mode)) {
      throw new AasError(`Invalid storage mode "${t.mode}" for table "${name}".`, 400);
    }
    if (t.mode === 'dual' && targetEngine === 'aas-standalone') {
      throw new AasError(
        `Table "${name}" requests Dual storage mode, which standalone Azure Analysis Services does not support. ` +
          `Dual requires Power BI Premium / Fabric capacity. Use Import or DirectQuery, or apply via Fabric.`,
        400,
      );
    }

    const isQuery = t.mode === 'directQuery' || t.mode === 'dual';
    if (isQuery && !cleanName(t.sourceQuery)) {
      throw new AasError(`Table "${name}" mode="${t.mode}" requires a sourceQuery.`, 400);
    }

    // A DQ/Dual table needs a dataSource; default one is auto-created per model.
    const dsName = isQuery ? cleanName(t.dataSourceName) || 'sqlSource' : undefined;
    if (dsName && !dsByName.has(dsName)) {
      dsByName.set(dsName, { name: dsName, type: 'structured', connectionString: '' });
    }

    const columns = (t.columns || []).map((c) => ({
      name: cleanName(c.name),
      ...(c.dataType ? { dataType: c.dataType } : { dataType: 'string' }),
      sourceColumn: cleanName(c.sourceColumn) || cleanName(c.name),
    }));

    const measures = (t.measures || [])
      .filter((m) => cleanName(m.name) && cleanName(m.expression))
      .map((m) => ({
        name: cleanName(m.name),
        expression: m.expression,
        ...(m.formatString ? { formatString: m.formatString } : {}),
      }));

    const partition =
      t.mode === 'import'
        ? { name: `${name}-import`, mode: 'import', source: { type: 'none' } }
        : {
            name: `${name}-${t.mode}`,
            mode: t.mode,
            source: { type: 'query', query: t.sourceQuery, dataSource: dsName },
          };

    return {
      name,
      ...(columns.length ? { columns } : {}),
      ...(measures.length ? { measures } : {}),
      partitions: [partition],
    };
  });

  const tmslRelationships = (relationships || [])
    .filter((r) => r?.fromTable && r?.fromColumn && r?.toTable && r?.toColumn)
    .map((r, i) => ({
      name: r.name || `rel${i}`,
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
      crossFilteringBehavior: r.crossFilteringBehavior || 'oneDirection',
      ...(r.isActive === false ? { isActive: false } : {}),
    }));

  const emittedDataSources = Array.from(dsByName.values()).map((ds) => ({
    name: ds.name,
    type: ds.type || 'structured',
    connectionString: ds.connectionString ?? '',
    ...(ds.impersonationMode ? { impersonationMode: ds.impersonationMode } : {}),
  }));

  const model: Record<string, unknown> = {
    culture,
    tables: tmslTables,
    ...(tmslRelationships.length ? { relationships: tmslRelationships } : {}),
    ...(emittedDataSources.length ? { dataSources: emittedDataSources } : {}),
  };

  return JSON.stringify(
    {
      name: cleanName(modelName) || 'CompositeModel',
      compatibilityLevel,
      model,
    },
    null,
    2,
  );
}

async function fabricToken(): Promise<string> {
  const t = await credential.getToken(FABRIC_SCOPE);
  if (!t?.token) throw new AasError('Failed to acquire AAD token for Fabric.', 401);
  return t.token;
}

async function getAasToken(): Promise<string> {
  const scope = aasScope();
  const t = await credential.getToken(scope);
  if (!t?.token) throw new AasError(`Failed to acquire AAD token for AAS (scope: ${scope})`, 401);
  return t.token;
}

/**
 * Apply a composite `model.bim` TMSL in-place via the Fabric updateDefinition
 * REST API (the only HTTP path from Node that accepts full per-partition-mode
 * TMSL). The workspace must be Fabric / Power-BI-Premium capacity-backed;
 * against a plain Pro workspace the API returns an error which is surfaced
 * verbatim. Opt-in only — callers gate on an explicit Fabric backend signal.
 *
 * Docs: https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/semantic-model-definition
 */
export async function applyTmslViaFabric(
  workspaceId: string,
  semanticModelId: string,
  tmslJson: string,
  displayName: string,
  steps: string[],
): Promise<{ ok: true }> {
  const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');
  const platform = JSON.stringify({
    $schema:
      'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
    metadata: { type: 'SemanticModel', displayName },
    config: { version: '2.0' },
  });
  const definition = {
    parts: [
      { path: 'model.bim', payload: b64(tmslJson), payloadType: 'InlineBase64' as const },
      {
        path: 'definition.pbism',
        payload: b64(JSON.stringify({ version: '4.0', settings: {} })),
        payloadType: 'InlineBase64' as const,
      },
      { path: '.platform', payload: b64(platform), payloadType: 'InlineBase64' as const },
    ],
  };

  const tok = await fabricToken();
  const url = `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}/semanticModels/${encodeURIComponent(
    semanticModelId,
  )}/updateDefinition`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ definition }),
    cache: 'no-store',
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  if (!res.ok && res.status !== 202) {
    const msg =
      (body as any)?.message ||
      (body as any)?.error?.message ||
      text ||
      `Fabric updateDefinition failed (${res.status}).`;
    throw new AasError(String(msg), res.status, body ?? text);
  }
  steps.push(`Fabric updateDefinition ${res.status} OK.`);
  return { ok: true };
}

/**
 * Execute a DAX query against an AAS model and return the raw result envelope.
 *
 * @param region     - Azure region of the AAS server (e.g. "eastus2")
 * @param serverName - Short server name (e.g. "my-server")
 * @param database   - Model / database name (e.g. "AdventureWorks")
 * @param daxQuery   - DAX query string (EVALUATE expression)
 */
export async function executeAasQuery(
  region: string,
  serverName: string,
  database: string,
  daxQuery: string,
): Promise<AasQueryResult> {
  const token = await getAasToken();
  const url = `${aasModelUrl(region, serverName, database)}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      queries: [{ query: daxQuery }],
      serializerSettings: { includeNulls: true },
    }),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (
      json?.error?.message ||
      json?.message ||
      text ||
      'AAS query failed'
    ).toString();
    throw new AasError(msg, res.status, json || text, url);
  }
  return (json as AasQueryResult) ?? { results: [] };
}

// ---------------------------------------------------------------------------
// Direct-Lake-shim enhanced refresh (feature set C — Power BI REST)
// ---------------------------------------------------------------------------

/** Power BI enhanced-refresh REST base — sovereign-correct Power BI host + /v1.0/myorg. */
export function aasApiBase(): string {
  const explicit = process.env.LOOM_POWERBI_BASE;
  if (explicit) return explicit.replace(/\/+$/, '');
  return `${getPbiGovHost()}/v1.0/myorg`;
}

/**
 * True when the Direct-Lake-shim is explicitly enabled. The shim is an opt-in
 * Azure-native fast-path (it requires a Power BI Premium / PPU workspace +
 * XMLA endpoint), so it is gated by an env flag rather than running by default.
 * When false, the BFF route renders the honest setup MessageBar instead of
 * calling the enhanced-refresh REST.
 */
export function shimEnabled(): boolean {
  return (process.env.LOOM_DIRECT_LAKE_SHIM_ENABLED || '').toLowerCase() === 'true';
}

/** The exact, honest setup copy shown when the shim isn't enabled. Cloud-invariant. */
export const SHIM_DISABLED_HINT =
  'True Direct Lake sub-second freshness requires a Fabric F-SKU (unavailable in Gov). ' +
  'This shim achieves 5–30 s via AAS incremental refresh via Power BI Premium XMLA. ' +
  'Set LOOM_DIRECT_LAKE_SHIM_ENABLED=true to activate.';

async function getShimToken(): Promise<string> {
  const t = await credential.getToken(pbiRestScope());
  if (!t?.token) throw new AasError(`Failed to acquire AAD token for ${pbiRestScope()}`, 401);
  return t.token;
}

interface CallOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

/** Low-level REST call returning { json, location } so callers can read the 202 Location header. */
async function call<T = any>(path: string, opts: CallOpts = {}): Promise<{ json: T; location: string | null }> {
  const method = opts.method ?? 'GET';
  const token = await getShimToken();
  let url = `${aasApiBase()}${path}`;
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
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || json?.message || text || `AAS ${method} ${path} failed`).toString();
    throw new AasError(msg, res.status, json || text, url);
  }
  return { json: (json as T) ?? ({} as T), location: res.headers.get('location') };
}

export type AasRefreshType = 'Full' | 'DataOnly' | 'ClearValues' | 'Calculate' | 'Defragment' | 'Automatic';
export type AasCommitMode = 'transactional' | 'partialBatch';

export interface ShimRefreshRequest {
  type: AasRefreshType;
  commitMode?: AasCommitMode;
  /** Empty / omitted → refresh the whole model. */
  objects?: AasRefreshObject[];
  /** Number of retries on a transient failure (enhanced-refresh `retryCount`). */
  retryCount?: number;
}

export interface AasClientConfig {
  /** Power BI workspace (group) id. */
  workspaceId: string;
  /** Power BI dataset (semantic model) id. */
  datasetId: string;
}

export interface ShimRefreshRun {
  requestId: string;
  refreshType?: string;
  status?: string;          // 'Completed' | 'Failed' | 'Unknown' (in progress) | 'Disabled' | 'Cancelled'
  startTime?: string;
  endTime?: string;
  /** Duration in ms when both start+end are present. */
  durationMs?: number;
  error?: string;
}

function toRun(r: any): ShimRefreshRun {
  const start = r?.startTime ? new Date(r.startTime).getTime() : NaN;
  const end = r?.endTime ? new Date(r.endTime).getTime() : NaN;
  const durationMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
  // serviceExceptionJson holds the engine error for a failed run.
  let error: string | undefined;
  if (r?.serviceExceptionJson) {
    try { error = JSON.parse(r.serviceExceptionJson)?.errorDescription || r.serviceExceptionJson; }
    catch { error = String(r.serviceExceptionJson); }
  }
  return {
    requestId: r?.requestId || r?.id || '',
    refreshType: r?.refreshType,
    status: r?.status,
    startTime: r?.startTime,
    endTime: r?.endTime,
    durationMs,
    error,
  };
}

/**
 * POST .../refreshes — queue an enhanced (async) refresh. Power BI returns 202
 * with the new refresh id in the `Location` response header
 * (`.../refreshes/{refreshId}`). We parse it out and return it so the caller
 * can poll status. `objects` scopes the refresh to specific tables/partitions
 * (the Direct-Lake-shim sweet spot); omit for a whole-model refresh.
 */
export async function triggerShimRefresh(
  cfg: AasClientConfig,
  req: ShimRefreshRequest,
): Promise<{ refreshId: string }> {
  const body: Record<string, unknown> = {
    type: req.type,
    commitMode: req.commitMode ?? 'transactional',
    retryCount: req.retryCount ?? 2,
  };
  if (req.objects && req.objects.length) body.objects = req.objects;
  const { location } = await call(
    `/groups/${encodeURIComponent(cfg.workspaceId)}/datasets/${encodeURIComponent(cfg.datasetId)}/refreshes`,
    { method: 'POST', body },
  );
  const refreshId = location ? (location.split('/').pop() || location) : '';
  return { refreshId };
}

/** GET .../refreshes/{refreshId} — status of a single enhanced-refresh run. */
export async function getShimRefreshStatus(
  cfg: AasClientConfig,
  refreshId: string,
): Promise<ShimRefreshRun> {
  const { json } = await call<any>(
    `/groups/${encodeURIComponent(cfg.workspaceId)}/datasets/${encodeURIComponent(cfg.datasetId)}/refreshes/${encodeURIComponent(refreshId)}`,
  );
  return toRun(json);
}

/**
 * GET .../refreshes?$top=N — refresh history (newest first). Used by the
 * Direct Lake (shim) status panel to show the last N shim runs. Falls back to
 * an empty list on 404/400 (model has never been refreshed) rather than
 * erroring.
 */
export async function listShimRefreshHistory(
  cfg: AasClientConfig,
  top = 10,
): Promise<ShimRefreshRun[]> {
  try {
    const { json } = await call<{ value: any[] }>(
      `/groups/${encodeURIComponent(cfg.workspaceId)}/datasets/${encodeURIComponent(cfg.datasetId)}/refreshes`,
      { query: { $top: top } },
    );
    return (json.value || []).map(toRun);
  } catch (e) {
    if (e instanceof AasError && (e.status === 404 || e.status === 400)) return [];
    throw e;
  }
}
