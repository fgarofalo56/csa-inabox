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
  if (resolveBackend() === 'analysis-services') return aasEvalDax(daxQuery);

  // loom-native: translate → Synapse serverless SQL over the backing warehouse.
  const sql = translateDaxToSql(daxQuery);
  if (!sql) throw unsupportedDaxError();

  const item = await getModelItem(modelId, tenantId);
  if (!item) throw new TabularError(`Semantic model ${modelId} not found or not owned by you.`, 404, 'loom-native');
  const db = (database && database.trim()) || modelBackingDatabase(item);

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
  return { columns: result.columns, rows, backend: 'loom-native', sql };
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
