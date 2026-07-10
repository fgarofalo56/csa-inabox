/**
 * tabular-eval-client.ts — Azure-native tabular model evaluation client.
 *
 * Backs the `tabular_*` Copilot tools (Semantic Link parity: read the model,
 * list its tables + measures, evaluate DAX) with ZERO Power BI / Fabric
 * dependency on the default path. This is the engine behind "Semantic Link
 * read" — a notebook / DAX Copilot persona reads a Loom semantic model and
 * pulls real values WITHOUT touching the Power BI REST host.
 *
 * The pure core (backend selection, metadata extraction, DAX→SQL translation,
 * XMLA envelope builders + parser) lives in `tabular-model.ts`; this file adds
 * the credential + Synapse SQL execution + Cosmos item lookup + AAS XMLA fetch.
 *
 * Backend dispatch (resolveBackend, in tabular-model.ts):
 *   1. isGovCloud() → loom-native ALWAYS (AAS is not in Azure Government).
 *   2. LOOM_SEMANTIC_BACKEND === 'analysis-services' AND LOOM_AAS_SERVER set
 *      → AAS XMLA path (opt-in, Commercial + GCC only).
 *   3. otherwise → loom-native (the DEFAULT).
 *
 * loom-native:
 *   - Metadata (tables/measures) is read straight from the semantic-model
 *     item's `state.content` (a SemanticModelContent) in Cosmos.
 *   - DAX evaluation translates a constrained set of DAX patterns to T-SQL and
 *     executes them against the Synapse serverless SQL pool over the model's
 *     backing warehouse/lakehouse tables. No mock data.
 *
 * analysis-services (opt-in):
 *   - XMLA SOAP Discover/Execute against the Azure `asazure.windows.net`
 *     resource (NOT Power BI / Fabric). Token scope from cloud-endpoints.
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential({ clientId:
 *   LOOM_UAMI_CLIENT_ID }), DefaultAzureCredential) — same as every Azure
 *   client in this directory. Config is env-only (loom-no-freeform-config).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { aasScope, aasXmlaUrl } from './cloud-endpoints';
import { listOwnedItems } from '@/app/api/items/_lib/item-crud';
import { executeQuery, serverlessTarget } from './synapse-sql-client';
import {
  buildQueryCacheKey,
  getCachedResult,
  setCachedResult,
  deriveFreshnessToken,
} from './query-result-cache';
import { recordCacheHit, recordCacheMiss } from '@/lib/perf/cache-counters';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  TabularError,
  resolveBackend,
  extractContent,
  modelBackingDatabase,
  translateDaxToSql,
  unsupportedDaxError,
  buildDiscoverEnvelope,
  buildExecuteEnvelope,
  parseRowset,
  parseXmlaColumns,
} from './tabular-model';
import type {
  TableMeta,
  MeasureMeta,
  ModelSummary,
  TabularQueryResult,
} from './tabular-model';

// Re-export the pure surface so callers import everything from one place.
export {
  TabularError,
  resolveBackend,
  extractContent,
  modelBackingDatabase,
  translateDaxToSql,
} from './tabular-model';
export type {
  TableMeta,
  MeasureMeta,
  ModelSummary,
  TabularQueryResult,
  Backend,
} from './tabular-model';

// ---------------------------------------------------------------------------
// Credential (module singleton — same pattern as the other clients)
// ---------------------------------------------------------------------------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ---------------------------------------------------------------------------
// Model lookup (Cosmos) — used by both backends to resolve a model item
// ---------------------------------------------------------------------------

/** List every semantic-model item the tenant owns. */
export async function listModels(tenantId: string): Promise<ModelSummary[]> {
  const items = await listOwnedItems('semantic-model', tenantId);
  return items.map((it) => ({
    id: it.id,
    displayName: it.displayName,
    workspaceId: it.workspaceId,
    description: it.description,
  }));
}

/** Fetch a single semantic-model item by id (tenant-scoped). */
export async function getModelItem(modelId: string, tenantId: string): Promise<WorkspaceItem | null> {
  const all = await listOwnedItems('semantic-model', tenantId);
  return all.find((it) => it.id === modelId) ?? null;
}

// ---------------------------------------------------------------------------
// listTables / listMeasures
// ---------------------------------------------------------------------------

export async function listTables(modelId: string, tenantId: string): Promise<TableMeta[]> {
  if (resolveBackend() === 'analysis-services') return aasListTables();
  const item = await getModelItem(modelId, tenantId);
  if (!item) throw new TabularError(`Semantic model ${modelId} not found or not owned by you.`, 404, 'loom-native');
  const { tables, measures } = extractContent(item);
  return tables.map((t) => ({
    name: t.name,
    columns: t.columns,
    measureNames: measures.filter((m) => m.table === t.name).map((m) => m.name),
  }));
}

export async function listMeasures(modelId: string, tenantId: string): Promise<MeasureMeta[]> {
  if (resolveBackend() === 'analysis-services') return aasListMeasures();
  const item = await getModelItem(modelId, tenantId);
  if (!item) throw new TabularError(`Semantic model ${modelId} not found or not owned by you.`, 404, 'loom-native');
  return extractContent(item).measures;
}

// ---------------------------------------------------------------------------
// evalDax
// ---------------------------------------------------------------------------

export async function evalDax(
  modelId: string,
  daxQuery: string,
  tenantId: string,
  database?: string,
): Promise<TabularQueryResult> {
  const backend = resolveBackend();

  // PSR-5: consult the always-on result cache first. A report re-issues the SAME
  // aggregate DAX constantly (page loads, cross-filter, multiple users) — each is
  // otherwise a full serverless/XMLA round-trip. The key folds the model identity,
  // the DAX text, the backend surface, the optional database override, and a
  // freshness token so a refresh/rebind transparently strands stale keys. The AAS
  // path has no observable Delta version, so its freshness is coarse (server+db)
  // and the short default TTL bounds staleness.
  let item: WorkspaceItem | null = null;
  let freshness: string;
  if (backend === 'analysis-services') {
    freshness = `aas:${(process.env.LOOM_AAS_SERVER ?? '').trim()}:${aasDatabase()}`;
  } else {
    item = await getModelItem(modelId, tenantId);
    if (!item) throw new TabularError(`Semantic model ${modelId} not found or not owned by you.`, 404, 'loom-native');
    freshness = deriveFreshnessToken({ _ts: (item as { _ts?: number })._ts, state: (item as { state?: unknown }).state });
  }
  const cacheKey = buildQueryCacheKey({
    modelId,
    sql: daxQuery,
    storageMode: backend,
    backend,
    freshness,
    parameters: database && database.trim() ? [{ name: 'database', value: database.trim() }] : [],
  });

  const cached = await getCachedResult(cacheKey, modelId);
  if (cached) {
    recordCacheHit('tabular');
    return {
      columns: cached.columns ?? (cached.rows[0] ? Object.keys(cached.rows[0]) : []),
      rows: cached.rows,
      backend,
      sql: cached.sql,
    };
  }
  recordCacheMiss('tabular');

  let out: TabularQueryResult;
  if (backend === 'analysis-services') {
    out = await aasEvalDax(daxQuery);
  } else {
    // loom-native: translate → Synapse serverless SQL over the backing warehouse.
    const sql = translateDaxToSql(daxQuery);
    if (!sql) throw unsupportedDaxError();
    const db = (database && database.trim()) || modelBackingDatabase(item!);

    let result;
    try {
      result = await executeQuery(serverlessTarget(db || 'master'), sql);
    } catch (e: any) {
      throw new TabularError(
        `Evaluating DAX against the Synapse serverless pool failed: ${e?.message || e}. ` +
          "Confirm the model's table maps to a real warehouse/lakehouse table and pass `database` if the table lives in a non-default Synapse database.",
        502,
        'loom-native',
      );
    }

    // executeQuery returns { columns: string[], rows: unknown[][] } — zip to
    // objects so the result renders directly in LoomDataTable (T7).
    const rows = result.rows.map((r) => {
      const o: Record<string, unknown> = {};
      result.columns.forEach((c, i) => { o[c] = (r as unknown[])[i]; });
      return o;
    });
    out = { columns: result.columns, rows, backend: 'loom-native', sql };
  }

  await setCachedResult(
    cacheKey,
    modelId,
    { rows: out.rows, columns: out.columns, sql: out.sql, rowCount: out.rows.length, producedBy: backend },
    { backend },
  );
  return out;
}

/**
 * PSR-5 model-warm / prime. Runs a trivial keep-alive against the tabular
 * backend so the first real visit avoids a cold spin-up (serverless pool wake /
 * AAS VertiScan page-in). NO model dependency on the loom-native path — a bare
 * `SELECT 1` wakes the serverless pool + primes the connection; the AAS path
 * evaluates a constant row to page the model into memory. Opt-in (call from a
 * scheduler or the editor "keep warm"); never on the request hot path.
 */
export async function warmSemanticModel(
  modelId: string,
  tenantId: string,
  database?: string,
): Promise<{ warmed: boolean; backend: string; ms: number; detail?: string }> {
  const backend = resolveBackend();
  const started = Date.now();
  try {
    if (backend === 'analysis-services') {
      await xmlaPost(buildExecuteEnvelope(aasDatabase(), 'EVALUATE ROW("loom_warm", 1)'), 'Execute');
      return { warmed: true, backend, ms: Date.now() - started };
    }
    const item = await getModelItem(modelId, tenantId);
    if (!item) throw new TabularError(`Semantic model ${modelId} not found or not owned by you.`, 404, 'loom-native');
    const db = (database && database.trim()) || modelBackingDatabase(item) || 'master';
    await executeQuery(serverlessTarget(db), 'SELECT 1 AS loom_warm');
    return { warmed: true, backend, ms: Date.now() - started };
  } catch (e: any) {
    // Warming is best-effort — report the failure honestly, never throw upstream.
    return { warmed: false, backend, ms: Date.now() - started, detail: e?.message || String(e) };
  }
}

// ===========================================================================
// AAS XMLA path (opt-in alternative backend; Azure-native, not Power BI/Fabric)
// ===========================================================================

function aasServer(): string {
  const s = (process.env.LOOM_AAS_SERVER ?? '').trim();
  if (!s) throw new TabularError('LOOM_AAS_SERVER is not set.', undefined, 'analysis-services');
  return s;
}

function aasDatabase(): string {
  return (process.env.LOOM_AAS_DATABASE ?? 'model').trim() || 'model';
}

async function aasToken(): Promise<string> {
  const token = await credential.getToken(aasScope(aasServer()));
  if (!token?.token) throw new TabularError('Failed to acquire an Azure Analysis Services token.', 401, 'analysis-services');
  return token.token;
}

async function xmlaPost(envelope: string, soapAction: 'Discover' | 'Execute'): Promise<string> {
  const url = aasXmlaUrl(aasServer(), aasDatabase());
  const token = await aasToken();
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      SOAPAction: `"urn:schemas-microsoft-com:xml-analysis:${soapAction}"`,
      authorization: `Bearer ${token}`,
    },
    body: envelope,
    cache: 'no-store',
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new TabularError(`AAS XMLA ${soapAction} error ${resp.status}: ${body.slice(0, 400)}`, resp.status, 'analysis-services');
  }
  return resp.text();
}

async function aasListTables(): Promise<TableMeta[]> {
  const xml = await xmlaPost(buildDiscoverEnvelope('TMSCHEMA_TABLES', aasDatabase()), 'Discover');
  return parseRowset(xml)
    .filter((r) => r['IsHidden'] !== 'true')
    .map((r) => ({ name: r['Name'] ?? '', columns: [], measureNames: [] }));
}

async function aasListMeasures(): Promise<MeasureMeta[]> {
  const db = aasDatabase();
  const tablesXml = await xmlaPost(buildDiscoverEnvelope('TMSCHEMA_TABLES', db), 'Discover');
  const tableMap = Object.fromEntries(parseRowset(tablesXml).map((r) => [r['ID'] ?? r['TableID'], r['Name']]));
  const measuresXml = await xmlaPost(buildDiscoverEnvelope('TMSCHEMA_MEASURES', db), 'Discover');
  return parseRowset(measuresXml).map((r) => ({
    name: r['Name'] ?? '',
    table: tableMap[r['TableID']] ?? r['TableID'] ?? '',
    expression: r['Expression'] ?? '',
    formatString: r['FormatString'] || undefined,
  }));
}

async function aasEvalDax(daxQuery: string): Promise<TabularQueryResult> {
  const xml = await xmlaPost(buildExecuteEnvelope(aasDatabase(), daxQuery), 'Execute');
  const schemaCols = parseXmlaColumns(xml);
  const rawRows = parseRowset(xml);
  const cols = schemaCols.length ? schemaCols : Array.from(new Set(rawRows.flatMap((r) => Object.keys(r))));
  const rows = rawRows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const c of cols) o[c] = r[c] ?? r[c.replace(/[[\]]/g, '')] ?? null;
    return o;
  });
  return { columns: cols, rows, backend: 'analysis-services' };
}
