/**
 * aas-client — TMSL (Tabular Model Scripting Language) builders + the optional
 * write surfaces for the Loom semantic-model "Model view" (relationships +
 * hierarchies).
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the semantic
 * model's Azure-native DEFAULT is the Loom-native tabular layer — relationships
 * and hierarchies are persisted in Cosmos (see _lib/semantic-model-store.ts)
 * and the canvas + hierarchy editor render fully with NEITHER a Fabric/Power BI
 * workspace NOR an Analysis Services server. The TMSL produced here is shown
 * read-only in the editor (the "model.bim" preview) so the operator sees exactly
 * what would be written.
 *
 * Two OPT-IN write backends are provided, each honestly gated:
 *   • Azure Analysis Services (XMLA-over-HTTP) — selected when
 *     LOOM_AAS_XMLA_ENDPOINT is set. AAS is the azure-native, no-Fabric option.
 *   • Microsoft Fabric / Power BI Premium (REST updateDefinition) — selected
 *     ONLY when LOOM_SEMANTIC_MODEL_BACKEND=fabric (per the opt-in rule). Never
 *     on the default path.
 *
 * All TMSL builder functions are pure (no I/O) and unit-tested. The write
 * functions return `{ ok, error }` rather than throwing on a non-fatal fault so
 * the BFF route can persist to Cosmos first and surface the backend result as a
 * MessageBar without failing the whole request.
 *
 * TMSL refs:
 *   relationship object  — https://learn.microsoft.com/analysis-services/tmsl/relationships-object-tmsl
 *   hierarchy object     — https://learn.microsoft.com/analysis-services/tmsl/hierarchies-object-tmsl
 *   createOrReplace      — https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
 *   alter command        — https://learn.microsoft.com/analysis-services/tmsl/alter-command-tmsl
 *   XMLA Execute/Command — https://learn.microsoft.com/analysis-services/xmla/xml-elements-commands
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { buildModelBimTmsl, type TmslRelationship, AasError, aasDefaultDatabase } from './aas-tmsl';

// Re-export the pure TMSL builders + helpers + types so callers can import them
// from aas-client (routes do). The builders + network-free helpers live in
// aas-tmsl.ts (zero @azure/identity imports) so they stay trivially
// unit-testable without the credential chain.
export {
  // TMSL builders
  buildCreateOrReplaceRelationshipTmsl,
  buildDeleteRelationshipTmsl,
  buildAlterTableHierarchyTmsl,
  buildModelBimTmsl,
  // Network-free AAS helpers (moved to aas-tmsl for testability — re-exported
  // here so every existing `import { AasError } from './aas-client'` keeps working)
  AasError,
  isAasConfigured,
  aasDefaultDatabase,
  xmlaUrl,
  requireXmlaUrl,
  resolveDatabase,
  buildSoapEnvelope,
  extractFault,
  parseXmlaRows,
} from './aas-tmsl';
export type {
  TmslCardinality, TmslCrossFilter, TmslRelationship,
  TmslHierarchyLevel, TmslHierarchy, TmslColumn, TmslTable,
} from './aas-tmsl';

const AAS_XMLA_ENDPOINT = process.env.LOOM_AAS_XMLA_ENDPOINT;
const AAS_SCOPE = process.env.LOOM_AAS_SCOPE || 'https://*.asazure.windows.net/.default';
const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

/** Azure Analysis Services (XMLA) write availability — azure-native, no Fabric. */
export function aasConfig(): { available: boolean; endpoint?: string } {
  return AAS_XMLA_ENDPOINT ? { available: true, endpoint: AAS_XMLA_ENDPOINT } : { available: false };
}

/**
 * Fabric / Power BI write availability. Per no-fabric-dependency.md this is
 * STRICTLY opt-in: the operator must set LOOM_SEMANTIC_MODEL_BACKEND=fabric.
 * Never true on the default path.
 */
export function fabricWriteEnabled(): boolean {
  return process.env.LOOM_SEMANTIC_MODEL_BACKEND === 'fabric';
}

// ---------------------------------------------------------------------------
// Azure Analysis Services — XMLA over HTTP (SOAP Execute/Command/Statement).
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function soapEnvelope(tmslJson: string, database: string): string {
  // The TMSL JSON is carried verbatim as the <Statement> text of an XMLA
  // Execute/Command. XML-escape it so braces/quotes survive the SOAP transport.
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<Body>' +
    '<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">' +
    '<Command><Statement>' + xmlEscape(tmslJson) + '</Statement></Command>' +
    '<Properties><PropertyList>' +
    '<Catalog>' + xmlEscape(database) + '</Catalog>' +
    '</PropertyList></Properties>' +
    '</Execute>' +
    '</Body>' +
    '</Envelope>'
  );
}

/**
 * Post a TMSL command to the Azure Analysis Services XMLA HTTP endpoint. Returns
 * `{ ok:false, error }` (does not throw) on an XMLA fault so the caller can keep
 * the Cosmos write and surface the backend result.
 */
export async function executeAasXmla(tmslJson: string, database: string): Promise<{ ok: boolean; error?: string }> {
  if (!AAS_XMLA_ENDPOINT) {
    return { ok: false, error: 'LOOM_AAS_XMLA_ENDPOINT is not set — XMLA write is not configured.' };
  }
  let token: string;
  try {
    const t = await credential.getToken(AAS_SCOPE);
    if (!t?.token) return { ok: false, error: `Failed to acquire AAD token for ${AAS_SCOPE}.` };
    token = t.token;
  } catch (e: any) {
    return { ok: false, error: `Token acquisition failed: ${e?.message || String(e)}` };
  }
  try {
    const res = await fetchWithTimeout(AAS_XMLA_ENDPOINT, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'text/xml; charset=utf-8',
        'soapaction': '"urn:schemas-microsoft-com:xml-analysis:Execute"',
      },
      body: soapEnvelope(tmslJson, database),
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `XMLA HTTP ${res.status}: ${text.slice(0, 600)}` };
    }
    // An XMLA fault returns HTTP 200 with a <soap:Fault>/<Exception>/<Error>
    // element in the body — treat that as a backend error.
    if (/<(soap:)?Fault\b/i.test(text) || /<Error\b/i.test(text) || /<Exception\b/i.test(text)) {
      return { ok: false, error: `XMLA fault: ${text.slice(0, 600)}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Fabric / Power BI Premium — REST updateDefinition (opt-in only).
// ---------------------------------------------------------------------------

/**
 * Overwrite a Fabric semantic model's `model.bim` via the REST
 * updateDefinition endpoint. Follows the 202 long-running-operation poll.
 * Opt-in only (gated by fabricWriteEnabled() in the caller).
 */
export async function updateFabricSemanticModelTmsl(
  workspaceId: string,
  semanticModelId: string,
  tmslFullModel: string,
): Promise<{ ok: boolean; error?: string }> {
  let token: string;
  try {
    const t = await credential.getToken(FABRIC_SCOPE);
    if (!t?.token) return { ok: false, error: `Failed to acquire AAD token for ${FABRIC_SCOPE}.` };
    token = t.token;
  } catch (e: any) {
    return { ok: false, error: `Token acquisition failed: ${e?.message || String(e)}` };
  }
  const payloadB64 = Buffer.from(tmslFullModel, 'utf8').toString('base64');
  const url =
    `${FABRIC_BASE}/workspaces/${encodeURIComponent(workspaceId)}` +
    `/semanticModels/${encodeURIComponent(semanticModelId)}/updateDefinition`;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        definition: {
          parts: [{ path: 'model.bim', payload: payloadB64, payloadType: 'InlineBase64' }],
        },
      }),
      cache: 'no-store',
    });
    if (res.status === 200 || res.status === 201) return { ok: true };
    if (res.status === 202) {
      // Long-running operation — poll the Location header until terminal.
      const loc = res.headers.get('location');
      if (!loc) return { ok: true };
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2_000));
        const poll = await fetchWithTimeout(loc, { headers: { 'authorization': `Bearer ${token}` }, cache: 'no-store' });
        if (poll.status === 200 || poll.status === 201) return { ok: true };
        if (poll.status !== 202) {
          const t = await poll.text();
          const j = (() => { try { return JSON.parse(t); } catch { return null; } })();
          const status = j?.status || j?.error?.code;
          if (status && /succeed/i.test(String(status))) return { ok: true };
          if (status && /fail|error/i.test(String(status))) {
            return { ok: false, error: `Fabric LRO ${status}: ${t.slice(0, 400)}` };
          }
        }
      }
      return { ok: false, error: 'Fabric updateDefinition timed out after 30s (still running).' };
    }
    const text = await res.text();
    return { ok: false, error: `Fabric HTTP ${res.status}: ${text.slice(0, 600)}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/*
 * aas-client.ts — Azure Analysis Services / Power BI tabular client (feature
 * sets A/B/C below). The Model view XMLA write surfaces are declared above;
 * the following sections add the composite TMSL builder, AAS async-refresh +
 * DAX query, and the Direct-Lake shim. All share the credential + scope
 * constants declared once at the top of this module.
 *
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
 *    `analysis.* powerbi/api` resource, NOT the AAS `*.asazure.windows.net`
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

import { detectLoomCloud, aasScope, aasModelUrl, pbiRestScope, getPbiGovHost, armBase, armScope, isGovCloud, aasConnectionUri } from './cloud-endpoints';
import { sanitizeAasName, skuTier } from './aas-naming';

// Re-export the pure naming helpers (defined in aas-naming.ts so they stay
// unit-testable without the ARM SDK) for back-compat with existing callers.
export { sanitizeAasName, skuTier } from './aas-naming';
import type { TmslCalcGroup, FieldParamDef } from './powerbi-client';
import {
  type AasRow,
  type AasTable,
  type AasQueryResult,
  type DaxVisual,
  type DaxWellField,
  resolveAasBinding,
  buildDaxFromVisual,
  buildDaxFromWells,
  flattenAasRows,
} from './aas-dax';

// Re-export the pure helpers so existing call sites can keep importing from
// aas-client. The pure logic lives in aas-dax (no @azure/identity) so it stays
// unit-testable without the credential chain.
export {
  resolveAasBinding,
  buildDaxFromVisual,
  buildDaxFromWells,
  flattenAasRows,
};
export type { AasRow, AasTable, AasQueryResult, DaxVisual, DaxWellField };

// FABRIC_BASE / FABRIC_SCOPE / AAS_SCOPE / uamiClientId / credential are
// declared once at the top of this module (Model view section) and are shared
// by all feature sets below.

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

// AasError is defined in aas-tmsl.ts and re-exported above (with the other
// network-free helpers). It is still in scope here via the import statement.

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
  const r = await fetchWithTimeout(`${modelBase()}/refreshes`, {
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
  const r = await fetchWithTimeout(`${modelBase()}/refreshes/${encodeURIComponent(refreshId)}`, {
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
  const res = await fetchWithTimeout(url, {
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
  const res = await fetchWithTimeout(url, {
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
  const res = await fetchWithTimeout(url, {
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

// ===========================================================================
// Calculation Groups + Field Parameters (PR #973) — opt-in AAS XMLA backend
// (LOOM_SEMANTIC_BACKEND=aas). The Loom-native default stores these in Cosmos
// and emits them in TMSL at provision time; AAS is never on the default path.
// ===========================================================================

/**
 * Returns null when AAS is reachable in the active cloud, or a gate object
 * describing why it is not (GCC-High / IL5 / DoD). The caller surfaces this as
 * an honest MessageBar rather than pretending to write. The Loom-native path
 * (Cosmos + provision-time TMSL) remains fully functional in every gated cloud.
 */
export function aasAvailabilityGate(): { unavailable: true; cloud: string; detail: string } | null {
  if (isGovCloud()) {
    const cloud = detectLoomCloud();
    return {
      unavailable: true,
      cloud,
      detail:
        `Azure Analysis Services is not available in ${cloud}. ` +
        'Calculation groups + field parameters are still fully supported on the ' +
        'Loom-native backend (LOOM_SEMANTIC_BACKEND=loom-native, the default): ' +
        'they are stored with this item and emitted in TMSL when the model is ' +
        'provisioned to a tabular engine.',
    };
  }
  return null;
}

/** XMLA endpoint host (no scheme) for an `asazure://host/server` URI. */
export function aasXmlaHost(serverUri: string): string {
  const m = serverUri.match(/^asazure:\/\/([^/]+)\//i);
  if (m) return m[1];
  return serverUri.replace(/^https?:\/\//i, '').split('/')[0];
}

/** Server (database catalog host) name for an `asazure://host/server` URI. */
export function aasServerName(serverUri: string): string {
  const parts = serverUri.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || serverUri;
}

async function calcGroupXmlaToken(host: string): Promise<string> {
  const scope = `https://${host}/.default`;
  const t = await credential.getToken(scope);
  if (!t?.token) throw new AasError(`Failed to acquire XMLA token for ${scope}`, 401);
  return t.token;
}

/**
 * Build the SOAP/XMLA Execute envelope that runs a TMSL command against an AAS
 * database. The TMSL JSON goes in <Statement> (XML-escaped); the target
 * database is named in the Catalog property.
 */
export function buildTmslExecuteEnvelope(tmslJson: string, database: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<Body>' +
    '<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">' +
    `<Command><Statement>${xmlEscape(tmslJson)}</Statement></Command>` +
    '<Properties><PropertyList>' +
    `<Catalog>${xmlEscape(database)}</Catalog>` +
    '</PropertyList></Properties>' +
    '</Execute>' +
    '</Body>' +
    '</Envelope>'
  );
}

/**
 * Execute a TMSL script (createOrReplace / alter / etc.) against an AAS model
 * over SOAP/XMLA. Returns { ok: true } on success; throws AasError with the
 * engine's <Description> on a TMSL error.
 *
 * @param serverUri asazure://{region}.asazure.windows.net/{serverName}
 * @param database  model (database) name on that server
 * @param tmslJson  TMSL JSON string
 */
export async function executeTmsl(
  serverUri: string,
  database: string,
  tmslJson: string,
): Promise<{ ok: true }> {
  const host = aasXmlaHost(serverUri);
  const serverName = aasServerName(serverUri);
  const token = await calcGroupXmlaToken(host);
  const url = `https://${host}/servers/${serverName}/`;
  const envelope = buildTmslExecuteEnvelope(tmslJson, database);
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'text/xml; charset=utf-8',
      soapaction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: envelope,
    cache: 'no-store',
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new AasError(`AAS XMLA ${res.status}: ${text.slice(0, 400)}`, res.status, undefined, url);
  }
  // A SOAP 200 can still carry a TMSL <Error>/<Exception>; surface the message.
  if (/<(Error|Exception)\b/i.test(text)) {
    const desc = text.match(/<Description>([\s\S]*?)<\/Description>/i)?.[1];
    throw new AasError(`TMSL error: ${desc || text.slice(0, 400)}`, 422, undefined, url);
  }
  return { ok: true };
}

/**
 * TMSL `createOrReplace` for a calculation-group table. Mirrors the TOM shape:
 * a calculationGroup with precedence + calculationItems, plus the mandatory
 * Name (string) + Ordinal (int64, hidden) columns and a calculationGroup
 * partition source.
 */
export function buildCalcGroupTmsl(database: string, cg: TmslCalcGroup): string {
  return JSON.stringify({
    createOrReplace: {
      object: { database, table: cg.name },
      table: {
        name: cg.name,
        calculationGroup: {
          precedence: cg.precedence,
          calculationItems: cg.items.map((ci) => ({
            name: ci.name,
            expression: ci.expression,
            ...(ci.formatStringDefinition
              ? { formatStringDefinition: { expression: ci.formatStringDefinition } }
              : {}),
            ...(typeof ci.ordinal === 'number' ? { ordinal: ci.ordinal } : {}),
          })),
        },
        columns: [
          {
            name: cg.name,
            dataType: 'string',
            sourceColumn: 'Name',
            sortByColumn: 'Ordinal',
            summarizeBy: 'none',
            annotations: [{ name: 'SummarizationSetBy', value: 'Automatic' }],
          },
          {
            name: 'Ordinal',
            dataType: 'int64',
            isHidden: true,
            sourceColumn: 'Ordinal',
            summarizeBy: 'sum',
            annotations: [{ name: 'SummarizationSetBy', value: 'Automatic' }],
          },
        ],
        partitions: [
          { name: 'Partition', mode: 'import', source: { type: 'calculationGroup' } },
        ],
      },
    },
  });
}

/**
 * The DAX calculated-table body for a field parameter, using NAMEOF():
 *   { ("Total Sales", NAMEOF('Sales'[Amount]), 0), ... }
 */
export function buildFieldParamDax(fp: FieldParamDef): string {
  const rows = fp.fields
    .map(
      (f, i) =>
        `\t("${(f.displayName || '').replace(/"/g, '""')}", NAMEOF(${f.fieldRef}), ${
          typeof f.order === 'number' ? f.order : i
        })`,
    )
    .join(',\n');
  return `{\n${rows}\n}`;
}

/**
 * TMSL `createOrReplace` for a field-parameter calculated table. The three
 * positional values map to: the visible label column, the hidden field
 * reference, and the hidden sort order.
 */
export function buildFieldParamTmsl(database: string, fp: FieldParamDef): string {
  return JSON.stringify({
    createOrReplace: {
      object: { database, table: fp.name },
      table: {
        name: fp.name,
        columns: [
          { name: fp.name, dataType: 'string', sourceColumn: '[Value1]', summarizeBy: 'none' },
          {
            name: 'Fields',
            dataType: 'string',
            sourceColumn: '[Value2]',
            summarizeBy: 'none',
            isHidden: true,
          },
          {
            name: 'Order',
            dataType: 'int64',
            sourceColumn: '[Value3]',
            summarizeBy: 'sum',
            isHidden: true,
            sortByColumn: 'Order',
          },
        ],
        partitions: [
          {
            name: 'Partition',
            mode: 'import',
            source: { type: 'calculated', expression: buildFieldParamDax(fp) },
          },
        ],
        annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// ARM control plane — list AAS servers (used to surface a target picker).
// ---------------------------------------------------------------------------

export interface AasServer {
  name: string;
  location?: string;
  sku?: { name?: string; tier?: string; capacity?: number };
  properties?: { state?: string; serverFullName?: string; provisioningState?: string };
}

/** List Microsoft.AnalysisServices/servers in a resource group. */
export async function listAasServers(
  subscriptionId: string,
  resourceGroup: string,
): Promise<AasServer[]> {
  const t = await credential.getToken(armScope());
  if (!t?.token) throw new AasError('Failed to acquire ARM token', 401);
  const url =
    `${armBase()}/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(resourceGroup)}` +
    '/providers/Microsoft.AnalysisServices/servers?api-version=2017-08-01';
  const res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${t.token}` }, cache: 'no-store' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new AasError(j?.error?.message || `ARM ${res.status}`, res.status, undefined, url);
  return (j.value || []) as AasServer[];
}

// ===========================================================================
// Automatic aggregations (PR #974) — XMLA `alternateOf` write surface.
//
// Authoring surface that genuinely requires the XMLA endpoint (the Power BI
// REST push-dataset path can't express it): a hidden, Import-mode aggregation
// table whose every column carries an `alternateOf` (BaseTable / BaseColumn +
// Summarization) so the AS engine automatically rewrites matching queries to
// the small agg table and falls through to the DirectQuery detail table.
//
// Backend is endpoint-agnostic (no hard Fabric dependency, per
// no-fabric-dependency.md): LOOM_POWERBI_XMLA_ENDPOINT is an HTTPS XMLA URL —
// an Azure Analysis Services server by default (.asazure.windows.net/xmla,
// .asazure.usgovcloudapi.net in Gov); a Power BI Premium / Fabric capacity XMLA
// endpoint is an opt-in alternative selected purely by what URL is configured.
//
// Refs: AlternateOf / Summarization (GroupBy|Sum|Count|Min|Max)
//   https://learn.microsoft.com/dotnet/api/microsoft.analysisservices.tabular.alternateof
//   https://learn.microsoft.com/power-bi/transform-model/aggregations-advanced
//   https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
// ===========================================================================

/**
 * The configured XMLA endpoint HTTPS URL (no trailing slash), or null when
 * unset. Read at call time (not module load) so a test / runtime that sets the
 * env var late still sees it.
 */
export function xmlaEndpoint(): string | null {
  const v = (process.env.LOOM_POWERBI_XMLA_ENDPOINT || '').trim();
  return v ? v.replace(/\/+$/, '') : null;
}

/**
 * Honest infra-gate for the XMLA write surface. Returns null when an endpoint
 * is configured (the route should attempt the real call); otherwise a
 * structured remediation the editor renders in a MessageBar — NEVER a crash,
 * NEVER a fake success. Per no-vaporware.md.
 */
export function xmlaConfigGate(): { missing: string; detail: string } | null {
  if (xmlaEndpoint()) return null;
  return {
    missing: 'LOOM_POWERBI_XMLA_ENDPOINT',
    detail:
      'No XMLA endpoint is configured, so aggregation tables cannot be written to the model. ' +
      'Set LOOM_POWERBI_XMLA_ENDPOINT to an HTTPS XMLA URL — for the Azure-native default this is an ' +
      'Azure Analysis Services server (https://<server>.asazure.windows.net/xmla, or .asazure.usgovcloudapi.net ' +
      'in Gov); a Power BI Premium / Fabric capacity XMLA endpoint (https://api.powerbi.com/xmla, ' +
      'https://api.powerbigov.us/xmla in Gov) is an opt-in alternative. The Console UAMI must be a ' +
      'Member/Contributor of the workspace (or an AAS administrator) and the model must be at ' +
      'compatibility level 1460 or higher.',
  };
}

/**
 * AAD `.default` scope for Analysis Services / Power BI XMLA tokens. The
 * resource audience is `analysis.windows.net` in Commercial/GCC and
 * `analysis.usgovcloudapi.net` in GCC-High / IL5 / DoD — hard-coding the
 * Commercial scope silently fails XMLA auth in Gov, so it derives from
 * `isGovCloud()` (the same split powerbi-client + the Direct Lake path use).
 */
export function xmlaScope(): string {
  return isGovCloud()
    ? 'https://analysis.usgovcloudapi.net/powerbi/api/.default'
    : 'https://analysis.windows.net/powerbi/api/.default';
}

async function getAggXmlaToken(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new AasError(`Failed to acquire AAD token for ${scope}`, 401);
  return t.token;
}

/** AS aggregation summarization types (SummarizationType: GroupBy|Sum|Count|Min|Max). */
export type AggSummarization = 'GroupBy' | 'Sum' | 'Count' | 'Min' | 'Max';

/**
 * One column of the aggregation table, mapped via `alternateOf` to a column
 * (or — for `Count` of rows — a table) in the DirectQuery detail table.
 */
export interface AltMap {
  /** Column name in the (new) aggregation table. */
  aggColumn: string;
  /** TMSL column dataType: string | int64 | double | decimal | dateTime | boolean. */
  dataType: string;
  /** Aggregation summarization. GroupBy = grain key; Sum/Count/Min/Max = measure. */
  summarization: AggSummarization;
  /** Detail (DirectQuery) table the agg column is an alternate source of. */
  detailTable: string;
  /**
   * Detail column the agg column maps to. Required for GroupBy/Sum/Min/Max.
   * Optional for `Count` — when omitted the column counts detail-table ROWS
   * (a table-level `alternateOf` with only `baseTable`).
   */
  detailColumn?: string;
}

export interface AggTableTmslParams {
  /** XMLA catalog / semantic model (database) name. */
  database: string;
  /** Name of the new aggregation table (created hidden, Import mode). */
  aggTableName: string;
  /** Power Query (M) expression for the agg table's single partition. */
  partitionExpression: string;
  /** The per-column aggregation mappings (at least one). */
  altMaps: AltMap[];
}

/**
 * The TMSL `alternateOf` object for one column. Per the TOM/TMSL serialization
 * a column-level mapping emits BOTH `baseTable` (qualifying table) and
 * `baseColumn`; a row-count mapping emits `baseTable` only.
 */
export function altMapToTmsl(m: AltMap): Record<string, unknown> {
  const out: Record<string, unknown> = { summarization: m.summarization, baseTable: m.detailTable };
  if (m.detailColumn && m.detailColumn.trim()) out.baseColumn = m.detailColumn.trim();
  return out;
}

/**
 * Build a TMSL `createOrReplace` command (as a JSON string) that creates the
 * aggregation table: hidden, single M partition, one column per AltMap each
 * carrying its `alternateOf`. The AS engine uses this metadata to automatically
 * route matching queries to this table. Pure function — no Azure dependency.
 */
export function buildAggTableTmsl(params: AggTableTmslParams): string {
  const { database, aggTableName, partitionExpression, altMaps } = params;
  const columns = altMaps.map((m) => ({
    name: m.aggColumn,
    dataType: (m.dataType || 'double'),
    // Aggregation columns are not user-visible; the detail columns are.
    isHidden: m.summarization === 'GroupBy' ? false : true,
    alternateOf: altMapToTmsl(m),
  }));
  const command = {
    createOrReplace: {
      object: { database, table: aggTableName },
      table: {
        name: aggTableName,
        // Aggregation tables are hidden from report authors and are Import mode
        // (the small pre-aggregated cache over the DirectQuery detail table).
        isHidden: true,
        partitions: [
          {
            name: `${aggTableName}-partition`,
            mode: 'import',
            source: { type: 'm', expression: partitionExpression },
          },
        ],
        columns,
      },
    },
  };
  return JSON.stringify(command);
}

/**
 * Wrap a TMSL JSON command in the XMLA SOAP `Execute` envelope. The TMSL is
 * sent as the `<Statement>` text; `<Catalog>` selects the model. Pure string
 * builder (exported for the test to assert the body shape).
 */
export function buildSoapExecuteEnvelope(catalog: string, tmslJson: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<Body>' +
    '<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">' +
    `<Command><Statement>${esc(tmslJson)}</Statement></Command>` +
    '<Properties><PropertyList>' +
    `<Catalog>${esc(catalog)}</Catalog>` +
    '</PropertyList></Properties>' +
    '</Execute>' +
    '</Body>' +
    '</Envelope>'
  );
}

/**
 * Extract an XMLA fault / exception message from a SOAP response body. XMLA
 * returns HTTP 200 even for command errors, embedding the error as a SOAP
 * `<faultstring>` or an `<Exception>`/`<Error>` element. Returns null when the
 * response carries no error.
 */
export function parseXmlaFault(xml: string): string | null {
  const fault = xml.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  if (fault) return fault[1].trim();
  const exc = xml.match(/<Exception[^>]*\bmessage="([^"]*)"/i);
  if (exc) return exc[1].trim();
  const err = xml.match(/<Error[^>]*\bDescription="([^"]*)"/i);
  if (err) return err[1].trim();
  return null;
}

/**
 * Execute an aggregation TMSL command against the configured XMLA endpoint
 * (LOOM_POWERBI_XMLA_ENDPOINT) via a SOAP `Execute` POST. Resolves
 * `{ ok: true }` on success; throws `AasError` on an HTTP error OR an embedded
 * XMLA fault (HTTP 200 + `<faultstring>`). Distinct from `executeTmsl` (the
 * Model-view calc-group/relationship path that targets an asazure:// server
 * URI) — this one targets the single configured XMLA endpoint URL.
 */
export async function executeAggTmsl(catalog: string, tmslJson: string): Promise<{ ok: true }> {
  const endpoint = xmlaEndpoint();
  if (!endpoint) {
    throw new AasError('LOOM_POWERBI_XMLA_ENDPOINT is not configured', 503);
  }
  const token = await getAggXmlaToken(xmlaScope());
  const envelope = buildSoapExecuteEnvelope(catalog, tmslJson);
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'text/xml; charset=utf-8',
      'soapaction': '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: envelope,
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    const fault = parseXmlaFault(text);
    throw new AasError(fault || text || `XMLA Execute failed (${res.status})`, res.status, text, endpoint);
  }
  const fault = parseXmlaFault(text);
  if (fault) throw new AasError(fault, 400, text, endpoint);
  return { ok: true };
}

// ===========================================================================
// Datamart migration assistant (PR #978) — AAS server provision/get over ARM
// (Microsoft.AnalysisServices/servers@2017-08-01). Used by the datamart→
// Synapse Serverless + AAS migration route. Azure-native default — no Fabric.
//
// UAMI ARM role:  Contributor on the AAS resource group (granted in aas.bicep).
// UAMI AAS admin: set via properties.asAdministrators.members using the SP
//   identifier format `app:<applicationId>@<tenantId>` — the correct format for
//   service principals in AAS (UPNs + SP `app:` identifiers only; SP object IDs
//   are NOT supported by AAS asAdministrators).
// ===========================================================================

const AAS_API_VERSION = '2017-08-01';

export class AasClientError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AasClientError';
    this.status = status;
    this.body = body;
  }
}

export class AasNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`AAS not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'AasNotConfiguredError';
  }
}

export interface AasConfig {
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  sku: string;
}

/** Read AAS config from env, throwing AasNotConfiguredError (→ honest 503 gate). */
export function readAasConfig(): AasConfig {
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup =
    process.env.LOOM_AAS_RG || process.env.LOOM_DLZ_RG || process.env.LOOM_ADMIN_RG || '';
  const location = process.env.LOOM_AAS_LOCATION || process.env.LOOM_LOCATION || 'eastus2';
  const missing: string[] = [];
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!resourceGroup) missing.push('LOOM_AAS_RG (or LOOM_DLZ_RG / LOOM_ADMIN_RG)');
  if (missing.length) throw new AasNotConfiguredError(missing);
  return { subscriptionId, resourceGroup, location, sku: process.env.LOOM_AAS_SKU || 'B1' };
}

async function aasArmToken(): Promise<string> {
  const t = await credential.getToken(armScope());
  if (!t?.token) throw new AasClientError('Failed to acquire ARM token for AAS', 401);
  return t.token;
}

/**
 * Shape returned by provisionAasServer/getAasServer. Distinct from the
 * `AasServer` ARM-list shape above — this one is normalized for the migration
 * receipt (always has connectionUri + provisioningState computed/derived).
 */
export interface ProvisionedAasServer {
  name: string;
  id: string;
  provisioningState: string;
  state: string;
  serverFullName: string;
  connectionUri: string;
  location: string;
  sku: string;
}

function aasServerPath(cfg: AasConfig, serverName: string): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.AnalysisServices/servers/${serverName}?api-version=${AAS_API_VERSION}`;
}

function shapeProvisionedServer(j: any, cfg: AasConfig, serverName: string): ProvisionedAasServer {
  const props = j?.properties || {};
  return {
    name: serverName,
    id: j?.id || '',
    provisioningState: props.provisioningState || 'Unknown',
    state: props.state || 'Unknown',
    serverFullName: props.serverFullName || aasConnectionUri(serverName, cfg.location),
    connectionUri: aasConnectionUri(serverName, cfg.location),
    location: j?.location || cfg.location,
    sku: j?.sku?.name || cfg.sku,
  };
}

/**
 * Provision (idempotent PUT) an AAS server. Returns when ARM accepts the request
 * (200/201/202 — provisioning then continues async). Poll via getAasServer()
 * until provisioningState === 'Succeeded'. The console UAMI's SP identifier
 * (`app:<appId>@<tenantId>`) must be in asAdministrators for data-plane access.
 */
export async function provisionAasServer(opts: {
  serverName: string;
  /** AAS admin SP identifier — `app:<applicationId>@<tenantId>`. */
  adminSpIdentifier: string;
}): Promise<ProvisionedAasServer> {
  const cfg = readAasConfig();
  const tok = await aasArmToken();
  const body = {
    location: cfg.location,
    sku: { name: cfg.sku, tier: skuTier(cfg.sku), capacity: 1 },
    properties: {
      asAdministrators: { members: [opts.adminSpIdentifier] },
      managedMode: 1,
    },
    tags: { 'loom-managed': 'true', 'loom-purpose': 'datamart-migration' },
  };
  const res = await fetchWithTimeout(aasServerPath(cfg, opts.serverName), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${tok}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok && res.status !== 202) {
    const msg = j?.error?.message || text || `ARM AAS PUT failed (${res.status})`;
    throw new AasClientError(String(msg), res.status, j);
  }
  return shapeProvisionedServer(j, cfg, opts.serverName);
}

/** GET an AAS server. Returns null on 404. */
export async function getAasServer(serverName: string): Promise<ProvisionedAasServer | null> {
  const cfg = readAasConfig();
  const tok = await aasArmToken();
  const res = await fetchWithTimeout(aasServerPath(cfg, serverName), {
    headers: { authorization: `Bearer ${tok}`, accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    throw new AasClientError(j?.error?.message || `ARM GET AAS failed (${res.status})`, res.status, j);
  }
  return shapeProvisionedServer(j, cfg, serverName);
}

// ===========================================================================
// Single-measure save (PR #980) — Monaco DAX editor's "Save to model (XMLA)"
// path. Wraps the per-server executeTmsl() with the convenience-shape callers
// expect: an opts object that includes optional formatString / displayFolder,
// plus an evaluator that returns the just-saved measure's value to prove the
// write took (no fake "Saved!" toast, per no-vaporware.md). Honest 501 when
// LOOM_AAS_SERVER / LOOM_AAS_DATABASE are unset.
// ===========================================================================

import {
  buildMeasureUpsertTmsl as buildMeasureUpsertTmslPure,
  buildMeasureEvalQuery as buildMeasureEvalQueryPure,
} from './aas-tmsl';

// Re-export the pure measure builders so callers (and tests) can import them
// from aas-client alongside the network functions.
export { buildMeasureUpsertTmsl, buildMeasureEvalQuery } from './aas-tmsl';

// isAasConfigured + aasDefaultDatabase are defined in aas-tmsl.ts and re-exported
// from the top of this file. They are in scope here via the AasError import.

function resolveAasMeasureDatabase(database?: string): string {
  const db = (database || aasDefaultDatabase()).trim();
  if (!db) {
    throw new AasError(
      'LOOM_AAS_DATABASE is not configured. Set it to the AAS model database name.',
      501,
    );
  }
  return db;
}

function requireAasServer(): string {
  const server = (process.env.LOOM_AAS_SERVER || '').trim();
  if (!server) {
    throw new AasError(
      'LOOM_AAS_SERVER is not configured. Set it to the AAS connection string ' +
        '(asazure://<region>.asazure.windows.net/<serverName>).',
      501,
    );
  }
  return server;
}

/**
 * Upsert a single measure (with optional formatString + displayFolder) via TMSL
 * createOrReplace over XMLA. Throws AasError(501) when the AAS server / database
 * are not configured (honest infra-gate, no mock); AasError(422) on a TMSL
 * fault; AasError(<status>) on HTTP error.
 */
export async function upsertMeasure(opts: {
  database?: string;
  tableName: string;
  measureName: string;
  expression: string;
  formatString?: string;
  displayFolder?: string;
}): Promise<void> {
  const server = requireAasServer();
  const db = resolveAasMeasureDatabase(opts.database);
  const tmsl = buildMeasureUpsertTmslPure({
    database: db,
    tableName: opts.tableName,
    measureName: opts.measureName,
    expression: opts.expression,
    formatString: opts.formatString,
    displayFolder: opts.displayFolder,
  });
  await executeTmsl(server, db, JSON.stringify(tmsl));
}

/**
 * Evaluate a single measure and return its raw value — used to confirm a
 * just-saved measure (with its dynamic format string) computes against the live
 * model. Reuses the AAS data-plane DAX query endpoint via executeAasQuery.
 */
export async function evaluateMeasure(opts: {
  database?: string;
  tableName: string;
  measureName: string;
}): Promise<{ value: unknown; rows: Record<string, unknown>[] }> {
  const server = requireAasServer();
  const db = resolveAasMeasureDatabase(opts.database);
  const m = server.match(/^(?:asazure|https?):\/\/([^/]+)\/([^/?#]+)/i);
  if (!m) throw new AasError('LOOM_AAS_SERVER is malformed: "' + server + '"', 400);
  const region = m[1].split('.')[0];
  const serverName = m[2];
  const dax = buildMeasureEvalQueryPure(opts.tableName, opts.measureName);
  const result = await executeAasQuery(region, serverName, db, dax);
  const rows: Record<string, unknown>[] =
    ((result?.results?.[0]?.tables?.[0]?.rows as Record<string, unknown>[]) || []);
  const first = rows[0] || {};
  const value = Object.values(first)[0];
  return { value, rows };
}

// ===========================================================================
// Column metadata editor (PR #984) — Tables tab column editor surface.
//
// XMLA Alter/Create command path for editing per-column metadata (data
// category, format string, summarize-by, display folder, sort-by, hidden) and
// adding calculated columns / calculated tables. Backend selection:
//   1. LOOM_AAS_SERVER_URL  — asazure://<region>.asazure.windows.net/<name>
//   2. LOOM_POWERBI_XMLA_ENDPOINT — Power BI Premium XMLA endpoint URL
// Distinct from the older LOOM_AAS_SERVER (asazure://...) used by the
// async-refresh + measure paths above. The TMSL builders are pure and the
// transport (postXmla / command / discover / readModel) calls the real XMLA
// endpoint — no mocks, per no-vaporware.md.
// ===========================================================================

export type TmslSummarizeBy =
  | 'default' | 'none' | 'sum' | 'min' | 'max' | 'count' | 'average' | 'distinctCount';
export type TmslDataType =
  | 'string' | 'int64' | 'double' | 'dateTime' | 'decimal' | 'boolean' | 'binary' | 'unknown' | 'variant';
export type TmslColumnType = 'data' | 'calculated' | 'rowNumber' | 'calculatedTableColumn';

/** Complete column definition (Alter requires ALL read-write props, not a partial patch). */
export interface TmslColumnDef {
  name: string;
  dataType: TmslDataType;
  type?: TmslColumnType;
  dataCategory?: string;
  isHidden?: boolean;
  summarizeBy?: TmslSummarizeBy;
  formatString?: string;
  displayFolder?: string;
  sortByColumn?: string;
  expression?: string; // calculated columns only
}

export interface TmslCalcColumnDef extends Omit<TmslColumnDef, 'type'> {
  expression: string; // required for a calculated column
}

/** Parsed model column row (from a TMSCHEMA Discover, enums resolved). */
export interface ColEditorModelColumn {
  name: string;
  type: TmslColumnType;
  dataType: TmslDataType | string;
  dataCategory?: string;
  isHidden: boolean;
  summarizeBy?: TmslSummarizeBy | string;
  formatString?: string;
  displayFolder?: string;
  sortByColumn?: string;
  expression?: string;
}

export interface ColEditorModelMeasure {
  name: string;
  expression?: string;
  formatString?: string;
  displayFolder?: string;
  isHidden?: boolean;
}

export interface ColEditorModelTable {
  name: string;
  isCalculatedTable: boolean;
  calculatedExpression?: string;
  columns: ColEditorModelColumn[];
  measures: ColEditorModelMeasure[];
}

// TMSL command shapes (also the exact JSON sent to the engine).
export interface TmslAlterCommand {
  alter: {
    object: { database: string; table: string; column: string };
    column: Record<string, unknown>;
  };
}
export interface TmslCreateColumnCommand {
  create: {
    parentObject: { database: string; table: string };
    column: Record<string, unknown>;
  };
}
export interface TmslCreateTableCommand {
  create: {
    parentObject: { database: string };
    table: Record<string, unknown>;
  };
}

export interface AasXmlaConfig {
  xmlaUrl: string;
  scope: string;
  database: string;
  backend: 'analysis-services' | 'powerbi';
}

import { pbiXmlaScope as colCloudPbiXmlaScope, cloudBoundaryLabel as colCloudBoundaryLabel } from './cloud-endpoints';

/**
 * Derive the XMLA HTTP URL + AAD token scope from the configured backend.
 * Returns null when neither LOOM_AAS_SERVER_URL nor LOOM_POWERBI_XMLA_ENDPOINT
 * is set. Distinct from readAasConfig()/LOOM_AAS_SERVER which targets the
 * async-refresh REST surface.
 */
export function aasXmlaConfig(): AasXmlaConfig | null {
  const raw = (process.env.LOOM_AAS_SERVER_URL || '').trim();
  const database = (process.env.LOOM_AAS_DATABASE || 'loomdb').trim();
  if (raw.startsWith('asazure://')) {
    const stripped = raw.replace('asazure://', '');
    const slash = stripped.indexOf('/');
    const host = slash >= 0 ? stripped.slice(0, slash) : stripped;
    const serverName = slash >= 0 ? stripped.slice(slash + 1).replace(/\/+$/, '') : '';
    if (host && serverName) {
      // The host-specific .default scope (the audience must be the AAS server
      // host, not the wildcard). cloud-endpoints.aasScope() is the no-arg
      // data-plane form, so we compute the host scope inline here.
      return {
        xmlaUrl: `https://${host}/servers/${serverName}/models/${database}/xmla`,
        scope: `https://${host}/.default`,
        database,
        backend: 'analysis-services',
      };
    }
  }
  const pbiXmla = (process.env.LOOM_POWERBI_XMLA_ENDPOINT || '').trim();
  if (pbiXmla) {
    const xmlaUrl = pbiXmla.replace(/^powerbi:\/\//, 'https://').replace(/\/+$/, '');
    return {
      xmlaUrl,
      scope: colCloudPbiXmlaScope(),
      database: (process.env.LOOM_AAS_DATABASE || '').trim(),
      backend: 'powerbi',
    };
  }
  return null;
}

/**
 * Honest config / availability gate for the COLUMN EDITOR path (PR #984).
 * Distinct from aasConfigGate() above (which gates the async-refresh path on
 * LOOM_AAS_SERVER/LOOM_AAS_MODEL). Returns null when an XMLA backend is ready.
 */
export function aasColumnEditorGate(): { missing: string; detail: string } | null {
  const cfg = aasXmlaConfig();
  if (cfg) return null;
  if (isGovCloud()) {
    return {
      missing: 'LOOM_POWERBI_XMLA_ENDPOINT',
      detail:
        `Azure Analysis Services is not available in the current cloud boundary (${colCloudBoundaryLabel()}). ` +
        'Column metadata editing (data category, format string, summarize-by, display folder, sort-by, hidden, ' +
        'calculated columns/tables) requires an XMLA endpoint. In Azure Government, set LOOM_POWERBI_XMLA_ENDPOINT ' +
        'to a licensed Power BI Premium XMLA endpoint, or edit the model with Power BI Desktop / Tabular Editor ' +
        'against a Commercial Azure Analysis Services instance reachable from your network.',
    };
  }
  return {
    missing: 'LOOM_AAS_SERVER_URL or LOOM_POWERBI_XMLA_ENDPOINT',
    detail:
      'Neither LOOM_AAS_SERVER_URL (Azure Analysis Services) nor LOOM_POWERBI_XMLA_ENDPOINT (Power BI Premium) ' +
      'is configured. Set one to enable column metadata editing — data category, format string, summarize-by, ' +
      'display folder, sort-by, hidden toggle, and calculated columns / tables. Deploy AAS with ' +
      'platform/fiab/bicep/modules/admin-plane/analysis-services.bicep (loomSemanticBackend=analysis-services).',
  };
}

// ---------------------------------------------------------------------------
// Column editor TMSL builders (pure)
// ---------------------------------------------------------------------------

function compactObj(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

function tmslColumnBody(col: TmslColumnDef, includeName: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = compactObj({
    name: includeName ? col.name : undefined,
    dataType: col.dataType,
    dataCategory: col.dataCategory,
    summarizeBy: col.summarizeBy,
    formatString: col.formatString,
    displayFolder: col.displayFolder,
    sortByColumn: col.sortByColumn,
    expression: col.expression,
    type: col.type,
  });
  if (col.isHidden !== undefined) body.isHidden = col.isHidden;
  return body;
}

export function buildAlterColumnTmsl(
  database: string,
  tableName: string,
  column: TmslColumnDef,
): TmslAlterCommand {
  return {
    alter: {
      object: { database, table: tableName, column: column.name },
      column: tmslColumnBody(column, true),
    },
  };
}

export function buildCreateCalcColumnTmsl(
  database: string,
  tableName: string,
  column: TmslCalcColumnDef,
): TmslCreateColumnCommand {
  const body = tmslColumnBody({ ...column, type: 'calculated' }, true);
  body.type = 'calculated';
  body.expression = column.expression;
  return {
    create: {
      parentObject: { database, table: tableName },
      column: body,
    },
  };
}

export function buildCreateCalcTableTmsl(
  database: string,
  tableName: string,
  daxExpression: string,
): TmslCreateTableCommand {
  return {
    create: {
      parentObject: { database },
      table: {
        name: tableName,
        partitions: [
          {
            name: tableName,
            mode: 'import',
            source: {
              type: 'calculated',
              expression: daxExpression,
            },
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Measure-structure TMSL builders (audit-T82) — Copilot model-structure pane.
//
// These power the "Copilot edits model structure" surface: rename a measure,
// set/clear a measure's business description, set/clear a table description.
// Each is a pure TMSL command object fed to command()/executeXmlaCommand() on
// the opt-in XMLA backend. The DEFAULT (no-fabric) path persists the same edit
// to the Loom-native Cosmos model store — these builders only run when an XMLA
// endpoint is configured (honest gate otherwise). Per no-fabric-dependency.md
// the structure edits are 100% functional Azure-native without any of these.
// ---------------------------------------------------------------------------

export interface TmslAlterMeasureCommand {
  alter: {
    object: { database: string; table: string; measure: string };
    measure: Record<string, unknown>;
  };
}
export interface TmslAlterTableCommand {
  alter: {
    object: { database: string; table: string };
    table: Record<string, unknown>;
  };
}

/**
 * Rename a measure (TMSL Alter — the alter object's `measure.name` is the NEW
 * name; the object path holds the OLD name). The expression MUST be carried
 * forward because an Alter replaces the read-write measure body.
 */
export function buildRenameMeasureTmsl(
  database: string,
  tableName: string,
  currentName: string,
  newName: string,
  expression: string,
  opts: { description?: string; formatString?: string; displayFolder?: string } = {},
): TmslAlterMeasureCommand {
  return {
    alter: {
      object: { database, table: tableName, measure: currentName },
      measure: compactObj({
        name: newName,
        expression,
        description: opts.description,
        formatString: opts.formatString,
        displayFolder: opts.displayFolder,
      }),
    },
  };
}

/**
 * Set (or clear, when description is undefined/empty) a measure's business
 * description via TMSL Alter. The expression is carried forward (Alter replaces
 * the whole read-write body).
 */
export function buildSetMeasureDescriptionTmsl(
  database: string,
  tableName: string,
  measureName: string,
  expression: string,
  description: string | undefined,
  opts: { formatString?: string; displayFolder?: string } = {},
): TmslAlterMeasureCommand {
  return {
    alter: {
      object: { database, table: tableName, measure: measureName },
      measure: compactObj({
        name: measureName,
        expression,
        description: description && description.trim() ? description.trim() : undefined,
        formatString: opts.formatString,
        displayFolder: opts.displayFolder,
      }),
    },
  };
}

/** Set (or clear) a table's description via TMSL Alter. */
export function buildSetTableDescriptionTmsl(
  database: string,
  tableName: string,
  description: string | undefined,
): TmslAlterTableCommand {
  return {
    alter: {
      object: { database, table: tableName },
      table: compactObj({
        name: tableName,
        description: description && description.trim() ? description.trim() : undefined,
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// XMLA SOAP transport for the column-editor surface
// ---------------------------------------------------------------------------

const COL_XMLA_NS = 'urn:schemas-microsoft-com:xml-analysis';
const COL_SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';

function colXmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function colXmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function buildExecuteEnvelope(tmslJson: string, catalog: string): string {
  return (
    `<Envelope xmlns="${COL_SOAP_NS}"><Body>` +
    `<Execute xmlns="${COL_XMLA_NS}">` +
    `<Command><Statement>${colXmlEscape(tmslJson)}</Statement></Command>` +
    `<Properties><PropertyList>${catalog ? `<Catalog>${colXmlEscape(catalog)}</Catalog>` : ''}</PropertyList></Properties>` +
    `</Execute></Body></Envelope>`
  );
}

export function buildDiscoverEnvelope(
  requestType: string,
  restrictions: Record<string, string>,
  catalog: string,
): string {
  const restr = Object.entries(restrictions)
    .map(([k, v]) => `<${k}>${colXmlEscape(String(v))}</${k}>`)
    .join('');
  return (
    `<Envelope xmlns="${COL_SOAP_NS}"><Body>` +
    `<Discover xmlns="${COL_XMLA_NS}">` +
    `<RequestType>${colXmlEscape(requestType)}</RequestType>` +
    `<Restrictions><RestrictionList>${restr}</RestrictionList></Restrictions>` +
    `<Properties><PropertyList>${catalog ? `<Catalog>${colXmlEscape(catalog)}</Catalog>` : ''}<Format>Tabular</Format></PropertyList></Properties>` +
    `</Discover></Body></Envelope>`
  );
}

function colExtractFault(xml: string): string | null {
  const fs = xml.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  if (fs) return colXmlUnescape(fs[1].trim());
  const err = xml.match(/<Error[^>]*\bDescription="([^"]*)"/i);
  if (err) return colXmlUnescape(err[1].trim());
  const ex = xml.match(/<Exception[^>]*\bMessage="([^"]*)"/i);
  if (ex) return colXmlUnescape(ex[1].trim());
  return null;
}

export function parseExecuteResponse(xml: string): void {
  const fault = colExtractFault(xml);
  if (fault) throw new AasError(fault, 502, xml.slice(0, 2000));
}

export function parseRowset(xml: string): Record<string, string>[] {
  const fault = colExtractFault(xml);
  if (fault) throw new AasError(fault, 502, xml.slice(0, 2000));
  const rows: Record<string, string>[] = [];
  const rowRe = /<row[\s>]([\s\S]*?)<\/row>/gi;
  let m: RegExpExecArray | null;
  const normalized = xml.replace(/<row>/gi, '<row >');
  while ((m = rowRe.exec(normalized)) !== null) {
    const inner = m[1];
    const fields: Record<string, string> = {};
    const fieldRe = /<([A-Za-z_][\w.:-]*)[^>]*>([\s\S]*?)<\/\1>/g;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(inner)) !== null) {
      const tag = f[1].includes(':') ? f[1].split(':').pop()! : f[1];
      fields[tag] = colXmlUnescape(f[2].trim());
    }
    rows.push(fields);
  }
  return rows;
}

async function colGetToken(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new AasError(`Failed to acquire AAD token for ${scope}`, 401);
  return t.token;
}

async function postXmla(envelope: string, scope: string, xmlaUrl: string): Promise<string> {
  const token = await colGetToken(scope);
  let res: Response;
  try {
    res = await fetchWithTimeout(xmlaUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"${COL_XMLA_NS}:Execute"`,
      },
      body: envelope,
    });
  } catch (e: any) {
    throw new AasError(`XMLA request failed: ${e?.message || String(e)}`, 502);
  }
  const text = await res.text();
  if (!res.ok) {
    const fault = colExtractFault(text) || `XMLA HTTP ${res.status}`;
    throw new AasError(fault, res.status, text.slice(0, 2000));
  }
  return text;
}

/**
 * Execute a TMSL command (Alter / Create / CreateOrReplace / Delete) via XMLA
 * against the column-editor configured backend. Returns the serialized TMSL.
 * Distinct from executeTmsl() above (server-URI form) — `command` uses the
 * aasXmlaConfig() endpoint.
 */
export async function command(statement: object, database?: string): Promise<{ tmsl: string }> {
  const cfg = aasXmlaConfig();
  if (!cfg) throw new AasError('No XMLA backend configured (set LOOM_AAS_SERVER_URL or LOOM_POWERBI_XMLA_ENDPOINT)', 412);
  const db = database || cfg.database;
  const tmsl = JSON.stringify(statement);
  const envelope = buildExecuteEnvelope(tmsl, db);
  const xml = await postXmla(envelope, cfg.scope, cfg.xmlaUrl);
  parseExecuteResponse(xml);
  return { tmsl };
}

export async function discover(
  requestType: string,
  restrictions: Record<string, string> = {},
  database?: string,
): Promise<Record<string, string>[]> {
  const cfg = aasXmlaConfig();
  if (!cfg) throw new AasError('No XMLA backend configured (set LOOM_AAS_SERVER_URL or LOOM_POWERBI_XMLA_ENDPOINT)', 412);
  const db = database || cfg.database;
  const envelope = buildDiscoverEnvelope(requestType, restrictions, db);
  const xml = await postXmla(envelope, cfg.scope, cfg.xmlaUrl);
  return parseRowset(xml);
}

// ---------------------------------------------------------------------------
// TMSCHEMA enum decoders
// ---------------------------------------------------------------------------

const COL_COLUMN_TYPE: Record<string, TmslColumnType> = {
  '1': 'data', '2': 'calculated', '3': 'rowNumber', '4': 'calculatedTableColumn',
};
const COL_DATA_TYPE: Record<string, TmslDataType> = {
  '1': 'unknown', '2': 'string', '6': 'int64', '8': 'double', '9': 'dateTime',
  '10': 'decimal', '11': 'boolean', '17': 'binary', '19': 'unknown', '20': 'variant',
};
const COL_SUMMARIZE_BY: Record<string, TmslSummarizeBy> = {
  '1': 'default', '2': 'none', '3': 'sum', '4': 'min', '5': 'max',
  '6': 'count', '7': 'average', '8': 'distinctCount',
};
const COL_PARTITION_CALCULATED = '2';

function colDecode<T>(map: Record<string, T>, raw: string | undefined, fallback?: T): T | string | undefined {
  if (raw === undefined || raw === '') return fallback;
  return map[raw] ?? raw;
}

/**
 * Read the full tabular model (tables + columns + measures) via TMSCHEMA
 * Discover rowsets, resolving the integer enums + ID joins into friendly
 * names. Real backend read for the editor's Tables tab.
 */
export async function readModel(database?: string): Promise<ColEditorModelTable[]> {
  const cfg = aasXmlaConfig();
  if (!cfg) throw new AasError('No XMLA backend configured', 412);
  const db = database || cfg.database;

  const [tablesRows, colsRows, measuresRows, partRows] = await Promise.all([
    discover('TMSCHEMA_TABLES', {}, db),
    discover('TMSCHEMA_COLUMNS', {}, db),
    discover('TMSCHEMA_MEASURES', {}, db).catch(() => [] as Record<string, string>[]),
    discover('TMSCHEMA_PARTITIONS', {}, db).catch(() => [] as Record<string, string>[]),
  ]);

  const tableById = new Map<string, string>();
  for (const t of tablesRows) {
    const id = t.ID || t.TableID;
    const name = t.Name || t.ExplicitName || t.InferredName;
    if (id && name) tableById.set(id, name);
  }

  const colNameById = new Map<string, string>();
  for (const c of colsRows) {
    const id = c.ID || c.ColumnID;
    const name = c.ExplicitName || c.InferredName || c.Name;
    if (id && name) colNameById.set(id, name);
  }

  const calcTableExpr = new Map<string, string>();
  for (const p of partRows) {
    const tid = p.TableID;
    const type = p.Type || p.SourceType;
    if (tid && type === COL_PARTITION_CALCULATED) {
      calcTableExpr.set(tid, p.QueryDefinition || p.Expression || '');
    }
  }

  const colsByTable = new Map<string, ColEditorModelColumn[]>();
  for (const c of colsRows) {
    const tid = c.TableID;
    if (!tid) continue;
    const name = c.ExplicitName || c.InferredName || c.Name || '';
    if (!name || name.startsWith('RowNumber-')) continue;
    const typeRaw = c.Type;
    if (typeRaw === '3') continue;
    const col: ColEditorModelColumn = {
      name,
      type: (colDecode(COL_COLUMN_TYPE, typeRaw, 'data') as TmslColumnType),
      dataType: (colDecode(COL_DATA_TYPE, c.ExplicitDataType || c.InferredDataType, 'string') as string),
      dataCategory: c.DataCategory || undefined,
      isHidden: c.IsHidden === 'true' || c.IsHidden === '1',
      summarizeBy: (colDecode(COL_SUMMARIZE_BY, c.SummarizeBy, 'default') as string),
      formatString: c.FormatString || undefined,
      displayFolder: c.DisplayFolder || undefined,
      sortByColumn: c.SortByColumnID ? colNameById.get(c.SortByColumnID) : undefined,
      expression: c.Expression || undefined,
    };
    const arr = colsByTable.get(tid) || [];
    arr.push(col);
    colsByTable.set(tid, arr);
  }

  const measuresByTable = new Map<string, ColEditorModelMeasure[]>();
  for (const m of measuresRows) {
    const tid = m.TableID;
    if (!tid) continue;
    const measure: ColEditorModelMeasure = {
      name: m.Name || m.ExplicitName || '',
      expression: m.Expression || undefined,
      formatString: m.FormatString || undefined,
      displayFolder: m.DisplayFolder || undefined,
      isHidden: m.IsHidden === 'true' || m.IsHidden === '1',
    };
    const arr = measuresByTable.get(tid) || [];
    arr.push(measure);
    measuresByTable.set(tid, arr);
  }

  const out: ColEditorModelTable[] = [];
  for (const [id, name] of tableById) {
    out.push({
      name,
      isCalculatedTable: calcTableExpr.has(id),
      calculatedExpression: calcTableExpr.get(id) || undefined,
      columns: colsByTable.get(id) || [],
      measures: measuresByTable.get(id) || [],
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ===========================================================================
// DirectQuery source binder (PR #989) — wires a Loom semantic model into
// DirectQuery mode against an Azure-native source (Synapse Serverless /
// Dedicated, Azure SQL, or Azure Data Explorer) via AAS XMLA TMSL commands.
// Renamed primitives (dq*) to avoid colliding with the async-refresh /
// column-editor / aggregations / measure surfaces declared above which share
// shorter names (aasConfigGate, command).
// ===========================================================================

import { aasSuffix as dqAasSuffix } from './cloud-endpoints';

/** The four Azure-native DirectQuery source families the binder supports. */
export type DqSourceType = 'synapse-serverless' | 'synapse-dedicated' | 'azure-sql' | 'adx';

export interface DqSourceConfig {
  sourceType: DqSourceType;
  server: string;
  database: string;
  secretRef?: string;
  tables: string[];
  appliedAt?: string;
}

/**
 * Honest config gate for the DirectQuery binder. Returns `{missing, detail}`
 * when LOOM_AAS_SERVER / LOOM_AAS_REGION / LOOM_AAS_MODEL are absent, else
 * null. Distinct from `aasConfigGate()` above (the asazure:// connection
 * string form used by the async-refresh path).
 */
export function dqSourceConfigGate(): { missing: string; detail: string } | null {
  if (!process.env.LOOM_AAS_SERVER) return {
    missing: 'LOOM_AAS_SERVER',
    detail: 'Set LOOM_AAS_SERVER (bare server name, e.g. "loom-aas"), LOOM_AAS_REGION (e.g. "eastus2") and LOOM_AAS_MODEL to enable DirectQuery source binding via Azure Analysis Services. The Console UAMI must also be an Analysis Services server administrator on that server.',
  };
  if (!process.env.LOOM_AAS_REGION) return {
    missing: 'LOOM_AAS_REGION',
    detail: 'Set LOOM_AAS_REGION (Azure region of the AAS server, e.g. "eastus2") alongside LOOM_AAS_SERVER.',
  };
  if (!process.env.LOOM_AAS_MODEL) return {
    missing: 'LOOM_AAS_MODEL',
    detail: 'Set LOOM_AAS_MODEL (the tabular model / database name on the AAS server).',
  };
  return null;
}

function dqServerBase(): string {
  const server = process.env.LOOM_AAS_SERVER!;
  const region = process.env.LOOM_AAS_REGION!;
  return `https://${region}.${dqAasSuffix()}/servers/${server}`;
}

function dqModelBase(): string {
  return `${dqServerBase()}/models/${encodeURIComponent(process.env.LOOM_AAS_MODEL!)}`;
}

async function dqGetToken(): Promise<string> {
  const t = await credential.getToken(aasScope());
  if (!t?.token) throw new AasError('Failed to acquire AAD token for Azure Analysis Services', 401);
  return t.token;
}

function dqEscapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Send one TMSL command to the AAS XMLA endpoint via a SOAP `Execute` envelope.
 * Distinct from `executeTmsl(serverUri,...)` and `command(statement,...)` above:
 * uses the LOOM_AAS_SERVER + REGION + MODEL trio directly.
 */
export async function executeDqCommand(tmsl: object): Promise<void> {
  const gate = dqSourceConfigGate();
  if (gate) {
    const e = new AasError(gate.detail, 503);
    (e as any).code = 'not_configured';
    (e as any).missing = gate.missing;
    throw e;
  }

  const model = process.env.LOOM_AAS_MODEL!;
  const token = await dqGetToken();
  const stmt = JSON.stringify(tmsl);

  const soapBody = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    '  <SOAP-ENV:Body>',
    '    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">',
    '      <Command>',
    `        <Statement>${dqEscapeXml(stmt)}</Statement>`,
    '      </Command>',
    '      <Properties>',
    '        <PropertyList>',
    `          <Catalog>${dqEscapeXml(model)}</Catalog>`,
    '        </PropertyList>',
    '      </Properties>',
    '    </Execute>',
    '  </SOAP-ENV:Body>',
    '</SOAP-ENV:Envelope>',
  ].join('\n');

  const res = await fetchWithTimeout(`${dqModelBase()}/xmla`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'text/xml; charset=utf-8',
      soapaction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: soapBody,
    cache: 'no-store',
  });

  const text = await res.text();
  if (!res.ok || /<(\w+:)?fault/i.test(text) || /<Error\b/i.test(text)) {
    const fault =
      text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i)?.[1] ||
      text.match(/<Error[^>]*\bDescription="([^"]*)"/i)?.[1] ||
      text.slice(0, 400);
    throw new AasError(`AAS XMLA command failed: ${fault}`, res.ok ? 500 : res.status, text);
  }
}

/**
 * Build the TMSL command sequence that puts the given tables into DirectQuery
 * mode against a single source. Pure function — no I/O — so unit-testable.
 */
export function buildDqTmsl(
  server: string,
  database: string,
  tables: string[],
  sourceType: DqSourceType,
): object[] {
  const model = process.env.LOOM_AAS_MODEL || 'LoomModel';
  const dsName = 'LoomDQSource';
  const isAdx = sourceType === 'adx';

  const datasourceCommand = {
    createOrReplace: {
      parentObject: { database: model },
      dataSource: {
        name: dsName,
        type: 'structured',
        connectionDetails: {
          protocol: isAdx ? 'kusto' : 'tds',
          address: { server, database },
        },
        credential: { AuthenticationKind: 'ServiceAccount', kind: 'OAuth2' },
      },
    },
  };

  const partitionCommands = tables.map((table) => ({
    createOrReplace: {
      parentObject: { database: model, table },
      partition: {
        name: table,
        mode: 'directQuery',
        dataView: 'full',
        source: {
          type: 'query',
          query: isAdx ? table : `SELECT * FROM [dbo].[${table}]`,
          dataSource: dsName,
        },
      },
    },
  }));

  return [datasourceCommand, ...partitionCommands];
}

/**
 * Apply DirectQuery source binding to the configured AAS model: createOrReplace
 * the DataSource, then each table partition in DirectQuery mode.
 */
export async function applyDqSource(config: DqSourceConfig): Promise<void> {
  const commands = buildDqTmsl(config.server, config.database, config.tables, config.sourceType);
  for (const cmd of commands) {
    await executeDqCommand(cmd);
  }
}

// ===========================================================================
// Connected-metric DAX scalar runner (Scorecard editor's "Connect to data")
// ===========================================================================
//
// Used by the Scorecard editor's "connected metric" binder: a goal can be
// bound to a DAX measure/expression living in a Power BI semantic model (or an
// Azure Analysis Services tabular model surfaced through Power BI), and the
// goal's *current value* is then pulled live from that model.
//
// Execution path (default — Azure-native, NO real Fabric dependency):
//   Power BI REST `executeQueries`
//     POST /v1.0/myorg/groups/{ws}/datasets/{id}/executeQueries
//   This is the only public JSON-over-HTTP DAX *query* path. AAS VertiPaq and
//   Power BI datasets share the same query engine, so this is the correct
//   Azure-native runner for both. The endpoint base is cloud-correct via
//   LOOM_POWERBI_BASE (Commercial: api.powerbi.com, GCC-High/IL5:
//   api.powerbigov.us) and the AAD scope `analysis.windows.net/powerbi/api`
//   is cloud-invariant — see powerbi-client.ts.
//
// Standalone AAS (opt-in): LOOM_AAS_SERVER, when set, names a dedicated AAS
//   server (asazure://<region>.asazure.windows.net/<server>). Raw AAS
//   data-plane DAX execution speaks XMLA (SOAP + native ADOMD.NET binding),
//   which is not available in the Node.js BFF runtime. That path surfaces an
//   HONEST structured 503 gate (no vaporware) directing the operator to bind a
//   Power BI dataset instead, or to run the metric through a Power BI model
//   built on the same AAS source.
// ===========================================================================

import { executeDatasetQueries as cmExecuteDatasetQueries, PowerBiError as CmPowerBiError } from './powerbi-client';
import { aasSuffix as cmAasSuffix } from './cloud-endpoints';

/** A goal's binding to a live DAX measure in a Power BI / AAS tabular model. */
export interface ConnectedMetric {
  /** Power BI workspace (group) id that owns the dataset. */
  workspaceId: string;
  /** Power BI dataset / semantic-model id the measure lives in. */
  datasetId: string;
  /**
   * DAX scalar expression to evaluate — either a measure reference
   * (`[Total Revenue]`) or an inline expression (`SUM(Sales[Amount])`).
   */
  daxExpression: string;
}

/** True when a standalone AAS server is configured (opt-in XMLA path). */
export function hasStandaloneAas(): boolean {
  return !!process.env.LOOM_AAS_SERVER;
}

/**
 * Honest gate for the standalone-AAS XMLA path. XMLA-over-HTTP DAX execution
 * requires native ADOMD.NET bindings not present in the Next.js Node runtime,
 * so rather than pretend, we throw a precise, actionable AasError.
 */
export function aasXmlaGate(): never {
  const server = process.env.LOOM_AAS_SERVER || '';
  throw new AasError(
    `Connected metrics against the standalone Azure Analysis Services server (${server || `*.${cmAasSuffix()}`}) ` +
      `require the XMLA endpoint, which the Loom BFF cannot reach (XMLA needs native ADOMD.NET bindings). ` +
      `Bind this goal to a Power BI semantic model instead — Power BI's executeQueries REST path evaluates ` +
      `the same DAX over the same VertiPaq engine and is fully supported here.`,
    503,
    undefined,
    undefined,
    'aas_xmla_not_supported',
    'Publish the AAS tabular model as a Power BI semantic model (or import it into one) and bind the goal to that dataset.',
  );
}

/** Result row key produced by `EVALUATE ROW("Value", <expr>)`. */
const CM_VALUE_KEY = '[Value]';

/**
 * Evaluate a DAX scalar expression against the bound dataset and return the
 * single numeric value (or null when the result set is empty / null).
 *
 * Wraps the expression in `EVALUATE ROW("Value", <expr>)` so any scalar DAX —
 * a bare measure reference or an inline aggregation — yields exactly one row
 * with the `[Value]` column.
 */
export async function evaluateDaxScalar(metric: ConnectedMetric): Promise<number | null> {
  if (!metric?.workspaceId || !metric?.datasetId || !metric?.daxExpression) {
    throw new AasError('connected metric is missing workspaceId, datasetId, or daxExpression', 400, undefined, undefined, 'bad_metric');
  }
  // Standalone AAS server is opt-in and goes through XMLA, which we don't
  // support in-process — gate honestly. (The default Power BI path below needs
  // no AAS server at all.)
  if (hasStandaloneAas() && process.env.LOOM_METRIC_BACKEND === 'aas-xmla') {
    aasXmlaGate();
  }

  const expr = metric.daxExpression.trim();
  const query = `EVALUATE ROW("Value", ${expr})`;
  try {
    const j = await cmExecuteDatasetQueries(metric.workspaceId, metric.datasetId, query);
    const row = j?.results?.[0]?.tables?.[0]?.rows?.[0];
    if (!row) return null;
    // Power BI labels the column `[Value]`; fall back to the first column if a
    // future serializer changes the key.
    const raw = (row as Record<string, unknown>)[CM_VALUE_KEY] ?? Object.values(row)[0];
    if (raw === null || raw === undefined) return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      throw new AasError(`DAX expression returned a non-numeric value (${String(raw)})`, 422, undefined, undefined, 'non_numeric');
    }
    return n;
  } catch (e) {
    if (e instanceof AasError) throw e;
    if (e instanceof CmPowerBiError) {
      throw new AasError(
        e.message || `DAX execution failed (${e.status})`,
        e.status,
        undefined,
        undefined,
        'dax_exec_failed',
        e.status === 401 || e.status === 403
          ? 'The Console UAMI must be a Member/Contributor on the Power BI workspace and the tenant must allow service principals to use Power BI APIs.'
          : undefined,
      );
    }
    throw new AasError((e as Error)?.message || String(e), 502, undefined, undefined, 'dax_exec_failed');
  }
}

// ---------------------------------------------------------------------------
// Dashboard-tile DAX backend (PR #997) — pure-Azure executor used by
// /api/items/dashboard/[id]/tile-query. Re-uses the module-level `credential`
// + `aasScope()` for AAD; delegates pure helpers to ./aas-xmla so they stay
// unit-testable without @azure/identity.
// ---------------------------------------------------------------------------

import {
  AAS_MAX_ROWS as TILE_AAS_MAX_ROWS,
  type AasXmlaTabularResult,
  // Aliased to avoid colliding with the local `aasXmlaGate()` (a `: never`
  // throw-gate used by evaluateDaxScalar). This is the pure, non-throwing
  // `{ missing, hint } | null` variant from ./aas-xmla, re-exported below as
  // `aasDashboardTileGate` for the tile-query route's lazy fall-through.
  aasXmlaGate as aasXmlaPureGate,
  resolveAasXmlaTarget,
  buildAasXmlaUrl as buildTileXmlaUrl,
  buildExecuteEnvelope as buildTileDaxEnvelope,
  decodeXmlEntities as decodeTileXmlEntities,
  parseRowset as parseTileRowset,
} from './aas-xmla';

/**
 * Resolve the configured AAS server address + model. Throws an `AasError` (503)
 * with a precise remediation hint when `LOOM_AAS_SERVER` / `LOOM_AAS_MODEL`
 * are unset (per no-vaporware.md — surface the env var, never silently fall
 * through). Delegates to `aas-xmla.resolveAasXmlaTarget`.
 */
export function resolveAasTarget(): { server: string; model: string } {
  return resolveAasXmlaTarget();
}

/**
 * Execute a DAX query (an `EVALUATE` statement) against the AAS tabular model
 * over the XMLA HTTP endpoint and return tabular columns + rows. Real SOAP
 * round-trip — no mock data (per no-vaporware.md). Pure-Azure host
 * (`*.asazure.windows.net` / `*.asazure.usgovcloudapi.net`) — never a Fabric
 * host (per no-fabric-dependency.md).
 */
export async function executeDax(
  server: string,
  model: string,
  dax: string,
): Promise<AasXmlaTabularResult> {
  const started = Date.now();
  const url = buildTileXmlaUrl(server);
  const tok = await credential.getToken(aasScope());
  if (!tok?.token) throw new AasError('Failed to acquire AAS token', 401);
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok.token}`,
      'content-type': 'text/xml; charset=utf-8',
      soapaction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: buildTileDaxEnvelope(model, dax),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 600);
    const m = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(text);
    if (m) detail = decodeTileXmlEntities(m[1]);
    throw new AasError(`AAS XMLA ${res.status}: ${detail}`, res.status, text.slice(0, 600));
  }
  const { columns, rows } = parseTileRowset(text);
  const truncated = rows.length > TILE_AAS_MAX_ROWS;
  return {
    columns,
    rows: truncated ? rows.slice(0, TILE_AAS_MAX_ROWS) : rows,
    rowCount: rows.length,
    executionMs: Date.now() - started,
    truncated,
  };
}

// Re-export the pure-helper gate for callers that want a non-throwing variant
// (tile-query route's lazy fall-through). Name kept stable for compatibility
// with the dashboard-tiles PR.
export { aasXmlaPureGate as aasDashboardTileGate };

// ---------------------------------------------------------------------------
// Paginated-report (RDL) support: run a DAX dataset query against an Azure
// Analysis Services model and return a column/row-array shape (what the RDL
// renderer consumes). Thin adapter over `executeAasQuery` (the mature AAS
// REST /query path) — Azure-native, no Fabric/Power BI dependency.
// ---------------------------------------------------------------------------
export async function executeDaxQuery(
  target: { region: string; server: string; database: string },
  statement: string,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const out = await executeAasQuery(target.region, target.server, target.database, statement);
  const rows = ((out as { results?: { tables?: { rows?: Record<string, unknown>[] }[] }[] })
    ?.results?.[0]?.tables?.[0]?.rows ?? []) as Record<string, unknown>[];
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) };
}

// ---------------------------------------------------------------------------
// Plan-metrics writeback (audit-T13) — write an approved plan's task status +
// approval state into the semantic model as a calculated `_PlanTasks` table
// plus a `_PlanMetrics` measures table, so plan progress is queryable alongside
// the rest of the model. Pure TMSL builders (vitest-covered) that run through
// the existing executeTmsl()/executeAasXmla() XMLA path — NO new infrastructure
// and NO Fabric/Power BI workspace requirement (Azure Analysis Services is a
// standalone Azure resource; per no-fabric-dependency.md).
//
// Refs:
//   DATATABLE (calculated-table literal):
//     https://learn.microsoft.com/dax/datatable-function-dax
//   createOrReplace (TMSL):
//     https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
// ---------------------------------------------------------------------------

/** One plan task as written into the model (mirrors the editor's PlanTask). */
export interface PlanMetricTask {
  title: string;
  owner: string;
  due: string;
  status: 'todo' | 'doing' | 'done';
}

/** Approval outcome surfaced as a measure / table column on the model. */
export type PlanApprovalStatus = 'none' | 'pending' | 'approved' | 'rejected';

/** Escape a string for a DAX double-quoted literal (double up internal quotes). */
function daxStr(s: string): string {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}

/**
 * The DAX DATATABLE(...) literal backing the `_PlanTasks` calculated table.
 * Columns: Title (STRING), Owner (STRING), Due (STRING — kept as text so an
 * empty due date is representable), Status (STRING). An empty task list still
 * produces a valid (zero-row) DATATABLE so the createOrReplace never faults.
 */
export function buildPlanDataTableDax(tasks: PlanMetricTask[]): string {
  const rows = (tasks || [])
    .map((t) => `\t\t{ ${daxStr(t.title)}, ${daxStr(t.owner)}, ${daxStr(t.due)}, ${daxStr(t.status)} }`)
    .join(',\n');
  return (
    'DATATABLE(\n' +
    '\t"Title", STRING,\n' +
    '\t"Owner", STRING,\n' +
    '\t"Due", STRING,\n' +
    '\t"Status", STRING,\n' +
    `\t{\n${rows}\n\t}\n` +
    ')'
  );
}

/**
 * TMSL `createOrReplace` for the `_PlanTasks` calculated table — one calculated
 * partition whose source expression is the DATATABLE() literal above.
 */
export function buildPlanTasksTableTmsl(database: string, tasks: PlanMetricTask[]): string {
  return JSON.stringify({
    createOrReplace: {
      object: { database, table: '_PlanTasks' },
      table: {
        name: '_PlanTasks',
        columns: [
          { name: 'Title', dataType: 'string', sourceColumn: '[Title]', summarizeBy: 'none' },
          { name: 'Owner', dataType: 'string', sourceColumn: '[Owner]', summarizeBy: 'none' },
          { name: 'Due', dataType: 'string', sourceColumn: '[Due]', summarizeBy: 'none' },
          { name: 'Status', dataType: 'string', sourceColumn: '[Status]', summarizeBy: 'none' },
        ],
        partitions: [
          { name: 'Partition', mode: 'import', source: { type: 'calculated', expression: buildPlanDataTableDax(tasks) } },
        ],
        annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
      },
    },
  });
}

/**
 * TMSL `createOrReplace` for the `_PlanMetrics` measures table. It is a hidden
 * single-row calculated table carrying an ApprovalStatus text column plus the
 * three plan-status measures:
 *   [PlanDone%]      DIVIDE(done rows, all rows) * 100
 *   [PlanOverdue]    rows with a past Due and Status <> "done"
 *   [ApprovalStatus] MAX('_PlanMetrics'[ApprovalStatusValue])
 */
export function buildPlanMetricsTableTmsl(database: string, approvalStatus: PlanApprovalStatus): string {
  return JSON.stringify({
    createOrReplace: {
      object: { database, table: '_PlanMetrics' },
      table: {
        name: '_PlanMetrics',
        isHidden: true,
        columns: [
          { name: 'ApprovalStatusValue', dataType: 'string', sourceColumn: '[ApprovalStatusValue]', summarizeBy: 'none', isHidden: true },
        ],
        partitions: [
          {
            name: 'Partition',
            mode: 'import',
            source: { type: 'calculated', expression: `{ ( ${daxStr(approvalStatus)} ) }` },
          },
        ],
        measures: [
          {
            name: 'PlanDone%',
            expression:
              'DIVIDE( COUNTROWS( FILTER( \'_PlanTasks\', \'_PlanTasks\'[Status] = "done" ) ), COUNTROWS( \'_PlanTasks\' ) ) * 100',
            formatString: '0.0',
          },
          {
            name: 'PlanOverdue',
            expression:
              'COUNTROWS( FILTER( \'_PlanTasks\', \'_PlanTasks\'[Due] <> "" && \'_PlanTasks\'[Due] < FORMAT( TODAY(), "yyyy-mm-dd" ) && \'_PlanTasks\'[Status] <> "done" ) )',
            formatString: '0',
          },
          {
            name: 'ApprovalStatus',
            expression: 'MAX( \'_PlanMetrics\'[ApprovalStatusValue] )',
          },
        ],
        annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
      },
    },
  });
}

/**
 * Both TMSL `createOrReplace` scripts (the `_PlanTasks` backing table first,
 * then the `_PlanMetrics` measures table) for a plan writeback. Returned in
 * dependency order so a caller can execute them sequentially against the same
 * XMLA endpoint.
 */
export function buildPlanStatusMeasuresTmsl(
  database: string,
  tasks: PlanMetricTask[],
  approvalStatus: PlanApprovalStatus,
): { tasksTmsl: string; metricsTmsl: string } {
  return {
    tasksTmsl: buildPlanTasksTableTmsl(database, tasks),
    metricsTmsl: buildPlanMetricsTableTmsl(database, approvalStatus),
  };
}
