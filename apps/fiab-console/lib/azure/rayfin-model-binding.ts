/**
 * rayfin-model-binding — Azure-native backend for the model-bound Rayfin app
 * builder (Microsoft Fabric "Apps" workload, Build 2026 #28: build a web app
 * backed by a semantic model).
 *
 * Fabric's model-bound app reads its data from a semantic model. The
 * no-fabric-dependency.md DEFAULT here is the same Azure-native semantic layer
 * Loom uses everywhere else — an **Azure Analysis Services** tabular model:
 *   • list bindable models      → ARM list of AAS databases (aas-server-client)
 *   • introspect a bound model  → DAX INFO functions over XMLA (real metadata)
 *   • preview app data          → real DAX EVALUATE over XMLA (executeDax)
 *
 * No Fabric / Power BI workspace is required: the full builder works with only
 * the AAS env vars set, and renders an honest infra-gate (the exact env var to
 * set) when they are not — never an empty grid (per no-vaporware.md).
 *
 * Opt-in Fabric/Power BI binding is a future alternative selected explicitly;
 * the default path below only ever reaches `*.asazure.*` hosts.
 *
 * Refs:
 *   Fabric apps overview — https://learn.microsoft.com/fabric/apps/overview
 *   INFO.MEASURES (DAX)  — https://learn.microsoft.com/dax/info-measures-function-dax
 *   INFO.TABLES (DAX)    — https://learn.microsoft.com/dax/info-tables-function-dax
 *   INFO.COLUMNS (DAX)   — https://learn.microsoft.com/dax/info-columns-function-dax
 */
import {
  aasServerConfigGate,
  envAasServerName,
  envAasServerRegion,
  listDatabases,
  type AasDatabaseLite,
} from './aas-server-client';
import { executeDax, AasError } from './aas-client';
import type { AasXmlaTabularResult } from './aas-xmla';
import { aasSuffix } from './cloud-endpoints';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

/** Honest infra gate for the model-binding backend (Azure-native AAS default). */
export interface ModelBindingGate {
  /** The first missing env var (e.g. LOOM_AAS_SERVER_NAME). */
  missing: string;
  /** Human remediation detail for the MessageBar. */
  detail: string;
}

/** Returns the gate when AAS is not configured, else null. */
export function modelBindingGate(): ModelBindingGate | null {
  return aasServerConfigGate();
}

/**
 * The AAS data-plane server address the DAX executor needs, in the form
 * `<region>.<suffix>/<serverName>` (no scheme), derived from the env-pinned
 * server name + region. isGov-aware via aasSuffix().
 */
export function resolveAasDataPlaneServer(): string {
  const name = envAasServerName();
  const region = envAasServerRegion();
  if (!name || !region) {
    throw new AasError(
      'Azure Analysis Services not configured: set LOOM_AAS_SERVER_NAME and LOOM_AAS_REGION.',
      503,
    );
  }
  return `${region}.${aasSuffix()}/${name}`;
}

/** A semantic model the app can bind to (an AAS tabular database). */
export interface BindableModel {
  name: string;
  storageMode?: string;
  state?: string;
  compatibilityLevel?: number;
}

/** List the bindable semantic models on the env-pinned AAS server (real ARM). */
export async function listBindableModels(): Promise<BindableModel[]> {
  const dbs: AasDatabaseLite[] = await listDatabases();
  return dbs.map((d) => ({
    name: d.name,
    storageMode: d.storageMode,
    state: d.state,
    compatibilityLevel: d.compatibilityLevel,
  }));
}

/** A measure on the bound model (introspected live via INFO.MEASURES()). */
export interface ModelMeasure {
  name: string;
  table?: string;
  expression?: string;
  formatString?: string;
  description?: string;
}

/** A table on the bound model. */
export interface ModelTable {
  name: string;
  hidden?: boolean;
}

/** A column on the bound model (usable as a group-by dimension). */
export interface ModelColumn {
  table: string;
  name: string;
  dataType?: string;
  hidden?: boolean;
}

/** Full metadata of a bound model: what an app can read. */
export interface ModelMetadata {
  model: string;
  tables: ModelTable[];
  columns: ModelColumn[];
  measures: ModelMeasure[];
}

function cell(row: unknown[], cols: string[], name: string): string | undefined {
  const i = cols.findIndex((c) => c.toLowerCase().endsWith(name.toLowerCase()));
  if (i < 0) return undefined;
  const v = row[i];
  return v == null ? undefined : String(v);
}

function toBool(v: string | undefined): boolean {
  return v === 'true' || v === 'True' || v === '1';
}

/**
 * Introspect a bound semantic model with three real DAX INFO queries
 * (tables, columns, measures). INFO.* functions are supported on AAS tabular
 * models (compat level 1500+) and return engine-truth metadata over XMLA — no
 * mock data. Returns the shaped metadata the builder binds controls against.
 */
export async function introspectModel(model: string): Promise<ModelMetadata> {
  const server = resolveAasDataPlaneServer();
  const run = (dax: string) => executeDax(server, model, dax);

  // INFO.TABLES(): [ID], [Name], [IsHidden], ...
  const tablesRes = await run('EVALUATE INFO.TABLES()');
  const tablesById = new Map<string, ModelTable>();
  const idToTableName = new Map<string, string>();
  for (const r of tablesRes.rows) {
    const id = cell(r, tablesRes.columns, 'ID');
    const name = cell(r, tablesRes.columns, 'Name');
    if (!name) continue;
    if (id) idToTableName.set(id, name);
    tablesById.set(name, { name, hidden: toBool(cell(r, tablesRes.columns, 'IsHidden')) });
  }

  // INFO.COLUMNS(): [TableID], [ExplicitName] (or [InferredName]), [IsHidden],
  // [ExplicitDataType]. ExplicitName is the model column; skip RowNumber cols.
  const colsRes = await run('EVALUATE INFO.COLUMNS()');
  const columns: ModelColumn[] = [];
  for (const r of colsRes.rows) {
    const tableId = cell(r, colsRes.columns, 'TableID');
    const explicit = cell(r, colsRes.columns, 'ExplicitName');
    const inferred = cell(r, colsRes.columns, 'InferredName');
    const name = explicit || inferred;
    const table = (tableId && idToTableName.get(tableId)) || cell(r, colsRes.columns, 'Table');
    if (!name || !table || name.startsWith('RowNumber-')) continue;
    columns.push({
      table,
      name,
      dataType: cell(r, colsRes.columns, 'ExplicitDataType') || cell(r, colsRes.columns, 'DataType'),
      hidden: toBool(cell(r, colsRes.columns, 'IsHidden')),
    });
  }

  // INFO.MEASURES(): [TableID], [Name], [Expression], [FormatString], [Description]
  const measRes = await run('EVALUATE INFO.MEASURES()');
  const measures: ModelMeasure[] = [];
  for (const r of measRes.rows) {
    const name = cell(r, measRes.columns, 'Name');
    if (!name) continue;
    const tableId = cell(r, measRes.columns, 'TableID');
    measures.push({
      name,
      table: (tableId && idToTableName.get(tableId)) || cell(r, measRes.columns, 'Table'),
      expression: cell(r, measRes.columns, 'Expression'),
      formatString: cell(r, measRes.columns, 'FormatString'),
      description: cell(r, measRes.columns, 'Description'),
    });
  }

  return {
    model,
    tables: Array.from(tablesById.values()).filter((t) => !t.hidden),
    columns: columns.filter((c) => !c.hidden),
    measures,
  };
}

/** A field reference on the bound model. */
export interface FieldRef {
  table: string;
  column: string;
}

/**
 * Build a real DAX SUMMARIZECOLUMNS query for the app's read view: group by the
 * chosen dimension columns and project the chosen measures. This is exactly the
 * query a model-bound app issues to render a table/chart against its model.
 *
 * SUMMARIZECOLUMNS(groupBy..., "Measure", [Measure], ...) — the canonical
 * Tabular aggregation query (https://learn.microsoft.com/dax/summarizecolumns-function-dax).
 * A measures-only selection (no group-by) emits a single-row ROW() projection.
 */
export function buildReadViewDax(opts: {
  groupBy: FieldRef[];
  measures: string[];
  topN?: number;
}): string {
  const groupRefs = (opts.groupBy || [])
    .map((f) => `'${escapeSqlLiteral(f.table)}'[${f.column.replace(/]/g, '')}]`);
  const measureProjections = (opts.measures || [])
    .map((m) => {
      const safe = m.replace(/]/g, '');
      const label = m.replace(/"/g, '""');
      return `"${label}", [${safe}]`;
    });

  if (groupRefs.length === 0 && measureProjections.length === 0) {
    throw new AasError('Select at least one measure or group-by field to preview.', 400);
  }

  const topN = opts.topN && opts.topN > 0 ? Math.min(opts.topN, 1000) : 100;

  // Measures-only → single ROW() card. Otherwise SUMMARIZECOLUMNS, bounded by TOPN.
  if (groupRefs.length === 0) {
    return `EVALUATE\nROW(${measureProjections.join(', ')})`;
  }
  const inner = measureProjections.length
    ? `SUMMARIZECOLUMNS(\n  ${groupRefs.join(',\n  ')},\n  ${measureProjections.join(',\n  ')}\n)`
    : `SUMMARIZECOLUMNS(\n  ${groupRefs.join(',\n  ')}\n)`;
  return `EVALUATE\nTOPN(\n  ${topN},\n  ${inner}\n)`;
}

/** Run the read-view DAX against the bound model and return real columns/rows. */
export async function previewReadView(
  model: string,
  dax: string,
): Promise<AasXmlaTabularResult> {
  const server = resolveAasDataPlaneServer();
  return executeDax(server, model, dax);
}

export { envAasServerName, envAasServerRegion };
