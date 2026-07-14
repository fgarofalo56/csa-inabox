/**
 * entity-diagram-sources — REAL schema readers for the shared <EntityDiagram>.
 *
 * SC-10 reads the item's ACTUAL Azure backend schema — never a mock, never a
 * Fabric/Power BI dependency on the default path (per
 * .claude/rules/no-fabric-dependency.md). One normalized shape (`EntityGraph`)
 * feeds the shared canvas from three sources:
 *
 *   • semantic-model — TMSL tables + relationships via the existing Azure-native
 *     model route `GET /api/items/semantic-model/{id}/model` (Loom-native tabular
 *     layer; renders with NO Power BI / Fabric workspace bound).
 *   • lakehouse      — Delta tables via `GET /api/lakehouse/tables` (ADLS Gen2 +
 *     `_delta_log` scan), columns best-effort via the lakehouse SQL analytics
 *     endpoint (`POST /api/items/lakehouse/{id}/query`, Synapse Serverless).
 *   • kql-database   — ADX `.show database schema as json` via the existing
 *     `GET /api/adx/overview?id={id}` route (real Kusto control command).
 *
 * Each reader NEVER throws for an unreachable/unconfigured backend: it returns a
 * `gate` string (surfaced by the component as an honest Fluent MessageBar naming
 * the exact env var / role to set) so a missing backend is a disclosed state,
 * not a crash or an empty canvas.
 *
 * This module imports NOTHING from the editor registry (avoids the shared ⇄
 * registry circular dep the CI guard flags) — it talks to the BFF by URL only.
 */

// ── Normalized graph shape (the single contract the canvas consumes) ─────────

/** Coarse column category → drives the per-column type badge glyph. */
export type EntityColumnKind =
  | 'text' | 'number' | 'datetime' | 'bool' | 'geo' | 'json' | 'binary' | 'guid' | 'key' | 'unknown';

export interface EntityColumn {
  name: string;
  /** Backend-native type string, e.g. 'int64', 'nvarchar', 'datetime', 'dynamic'. */
  type?: string;
  /** Resolved coarse kind for the type badge. */
  kind: EntityColumnKind;
  /** Primary / business key — rendered with a key glyph. */
  isKey?: boolean;
}

export interface EntityTable {
  /** Stable node id. Relationship endpoints reference this id. */
  id: string;
  name: string;
  /** Schema / container / namespace, e.g. 'dbo', 'gold'. */
  schema?: string;
  columns: EntityColumn[];
  /** Row count when known, null when unknown, undefined when N/A. */
  rowCount?: number | null;
}

export type EntityCardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

export interface EntityRelationship {
  id: string;
  /** References {@link EntityTable.id}. */
  fromTable: string;
  fromColumn?: string;
  /** References {@link EntityTable.id}. */
  toTable: string;
  toColumn?: string;
  cardinality: EntityCardinality;
  /** Inactive relationships render dashed / dimmed. Default true. */
  active?: boolean;
  crossFilter?: 'single' | 'both';
  name?: string;
}

export interface EntityGraph {
  tables: EntityTable[];
  relationships: EntityRelationship[];
  /**
   * Honest infra-gate — set when the backing store is unreachable / not
   * provisioned. The component renders this verbatim in a warning MessageBar.
   */
  gate?: string;
  /** Non-fatal note (e.g. columns unavailable but tables listed). */
  notice?: string;
  /** Display name for the model / database. */
  modelName?: string;
}

export type EntitySourceKind = 'semantic-model' | 'lakehouse' | 'kql-database';

export interface EntitySource {
  kind: EntitySourceKind;
  /** The item id (semantic-model dataset id / lakehouse id / kql-database id). */
  itemId: string;
  /** Semantic-model: the Power BI workspace id (optional; Loom-native works without). */
  workspaceId?: string;
  /** Lakehouse: comma list of containers to scan (defaults to all configured). */
  containers?: string;
}

// A minimal fetch signature so tests can inject a stub and hosts pass clientFetch.
export type EntityFetch = (input: string, init?: RequestInit) => Promise<Response>;

// ── Type classification (shared across all three readers) ────────────────────

/**
 * Map a backend-native column type string to a coarse {@link EntityColumnKind}.
 * Covers TDS/T-SQL (nvarchar, int, datetime2, uniqueidentifier, geography),
 * KQL/ADX (string, long, real, datetime, bool, dynamic, guid, decimal), and
 * TMSL/PBI (string, int64, double, dateTime, boolean) type vocabularies.
 */
export function classifyColumnType(raw?: string): EntityColumnKind {
  if (!raw) return 'unknown';
  const t = raw.toLowerCase();
  if (/uniqueidentifier|guid|uuid/.test(t)) return 'guid';
  if (/geo|geography|geometry|latlong|point|polygon|linestring/.test(t)) return 'geo';
  if (/json|dynamic/.test(t)) return 'json';
  if (/binary|blob|image|byte\[\]/.test(t)) return 'binary';
  if (/bool/.test(t)) return 'bool';
  if (/date|time|timestamp/.test(t)) return 'datetime';
  if (/int|long|short|byte|decimal|numeric|float|real|double|money|number|bigint|smallint|tinyint/.test(t)) return 'number';
  if (/char|text|string|nchar|clob/.test(t)) return 'text';
  return 'unknown';
}

async function readJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return null; }
}

// ── semantic-model reader ────────────────────────────────────────────────────

/**
 * TMSL tables + relationships from the Azure-native semantic-model route.
 * Relationships reference tables by NAME in the route payload, so we key each
 * EntityTable by its table name (unique within a model) for edge resolution.
 */
export async function readSemanticModelGraph(source: EntitySource, doFetch: EntityFetch): Promise<EntityGraph> {
  if (!source.itemId) {
    return { tables: [], relationships: [], gate: 'Select a dataset to load its tables and relationships.' };
  }
  const qs = source.workspaceId ? `?workspaceId=${encodeURIComponent(source.workspaceId)}` : '';
  let res: Response;
  try {
    res = await doFetch(`/api/items/semantic-model/${encodeURIComponent(source.itemId)}/model${qs}`);
  } catch (e: any) {
    return { tables: [], relationships: [], gate: `Could not reach the semantic model service: ${e?.message || String(e)}` };
  }
  const j = await readJson(res);
  if (!j || j.ok === false) {
    return { tables: [], relationships: [], gate: (j && j.error) || `Model read failed (HTTP ${res.status}).` };
  }
  const tables: EntityTable[] = (Array.isArray(j.tables) ? j.tables : []).map((t: any) => ({
    id: String(t.name ?? t.id),
    name: String(t.name ?? t.id ?? 'Table'),
    schema: t.schema ? String(t.schema) : undefined,
    columns: (Array.isArray(t.columns) ? t.columns : []).map((c: any) => ({
      name: String(c.name ?? ''),
      type: c.type ? String(c.type) : undefined,
      kind: c.isPk ? ('key' as const) : classifyColumnType(c.type),
      isKey: !!c.isPk,
    })),
  }));
  const relationships: EntityRelationship[] = (Array.isArray(j.relationships) ? j.relationships : [])
    .filter((r: any) => r.fromTable && r.toTable)
    .map((r: any, i: number) => ({
      id: String(r.id ?? r.name ?? `rel-${i}`),
      fromTable: String(r.fromTable),
      fromColumn: r.fromColumn ? String(r.fromColumn) : undefined,
      toTable: String(r.toTable),
      toColumn: r.toColumn ? String(r.toColumn) : undefined,
      cardinality: normalizeCardinality(r.cardinality),
      active: r.active === undefined ? true : !!r.active,
      crossFilter: r.crossFilter === 'both' ? 'both' : 'single',
      name: r.name ? String(r.name) : undefined,
    }));
  return {
    tables,
    relationships,
    modelName: j.modelName ? String(j.modelName) : undefined,
    notice: j.notice ? String(j.notice) : undefined,
  };
}

function normalizeCardinality(c: unknown): EntityCardinality {
  const v = String(c || '').toLowerCase();
  if (v === 'one-to-many' || v === 'many-to-one' || v === 'one-to-one' || v === 'many-to-many') return v;
  // TMSL / PBI end tokens fallback.
  if (v.includes('many') && v.includes('one')) return v.startsWith('one') ? 'one-to-many' : 'many-to-one';
  return 'many-to-one';
}

// ── lakehouse reader ─────────────────────────────────────────────────────────

/**
 * Delta tables via the ADLS Gen2 scan, with a best-effort column enrichment
 * over the lakehouse SQL analytics endpoint (Synapse Serverless). Delta has no
 * declared foreign keys, so `relationships` is empty by design (honest — an ER
 * diagram over a lakehouse shows the table topology, not FK joins). Column
 * enrichment never blocks the table topology: if the serverless endpoint is
 * unconfigured the tables still render with a `notice`.
 */
export async function readLakehouseGraph(source: EntitySource, doFetch: EntityFetch): Promise<EntityGraph> {
  // Scope the scan to THIS lakehouse item (+ its workspace) so the diagram only
  // ever shows the opened lakehouse's own tables — never a sibling lakehouse's
  // or another workspace's. Both are required by the scoped tables route.
  if (!source.itemId || !source.workspaceId) {
    return { tables: [], relationships: [], gate: 'Lakehouse table scan needs the lakehouse id and its workspace.' };
  }
  const tablesQs = `?lakehouseId=${encodeURIComponent(source.itemId)}&workspaceId=${encodeURIComponent(source.workspaceId)}`;
  let res: Response;
  try {
    res = await doFetch(`/api/lakehouse/tables${tablesQs}`);
  } catch (e: any) {
    return { tables: [], relationships: [], gate: `Could not reach the lakehouse catalog: ${e?.message || String(e)}` };
  }
  const j = await readJson(res);
  if (!j || j.ok === false) {
    return { tables: [], relationships: [], gate: (j && j.error) || `Lakehouse table scan failed (HTTP ${res.status}).` };
  }
  if (j.gate && (!Array.isArray(j.tables) || j.tables.length === 0)) {
    return { tables: [], relationships: [], gate: String(j.gate) };
  }
  const rawTables: any[] = Array.isArray(j.tables) ? j.tables : [];
  const tables: EntityTable[] = rawTables.map((t: any) => ({
    id: `${t.schema ?? ''}.${t.name}`,
    name: String(t.name),
    schema: t.schema ? String(t.schema) : undefined,
    columns: [],
    rowCount: typeof t.rowCount === 'number' ? t.rowCount : (t.rowCount === null ? null : undefined),
  }));

  // Best-effort column enrichment. INFORMATION_SCHEMA.COLUMNS over the serverless
  // endpoint; failures (endpoint not provisioned / cold-start) degrade to a
  // notice, never a gate — the table topology is still valuable.
  let notice: string | undefined = j.gate ? String(j.gate) : undefined;
  if (tables.length > 0 && source.itemId && source.itemId !== 'new') {
    try {
      const q = await doFetch(`/api/items/lakehouse/${encodeURIComponent(source.itemId)}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sql: 'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION '
            + 'FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION',
        }),
      });
      const qj = await readJson(q);
      if (qj && qj.ok !== false && Array.isArray(qj.columns) && Array.isArray(qj.rows)) {
        applyInfoSchemaColumns(tables, qj.columns, qj.rows);
      } else if (qj && qj.ok === false) {
        notice = notice || `Column details unavailable: ${qj.error || 'SQL analytics endpoint not reachable'}`;
      }
    } catch {
      notice = notice || 'Column details unavailable — the lakehouse SQL analytics endpoint (Synapse Serverless) was not reachable. Table topology shown from the Delta catalog.';
    }
  }

  return { tables, relationships: [], notice };
}

/** Fold INFORMATION_SCHEMA.COLUMNS rows into the already-listed tables. */
function applyInfoSchemaColumns(tables: EntityTable[], columns: unknown[], rows: unknown[][]): void {
  const cols = columns.map((c) => String((c as any)?.name ?? c).toUpperCase());
  const iSchema = cols.indexOf('TABLE_SCHEMA');
  const iTable = cols.indexOf('TABLE_NAME');
  const iCol = cols.indexOf('COLUMN_NAME');
  const iType = cols.indexOf('DATA_TYPE');
  if (iTable < 0 || iCol < 0) return;
  const byName = new Map<string, EntityTable>();
  for (const t of tables) byName.set(t.name.toLowerCase(), t);
  for (const row of rows) {
    const tName = String(row[iTable] ?? '').toLowerCase();
    const t = byName.get(tName);
    if (!t) continue;
    const type = iType >= 0 ? String(row[iType] ?? '') : undefined;
    t.columns.push({ name: String(row[iCol] ?? ''), type, kind: classifyColumnType(type) });
  }
  // touch iSchema so a stricter tsconfig doesn't flag it unused (schema disambiguation
  // is a future refinement; table-name match is sufficient for the current scan).
  void iSchema;
}

// ── kql-database reader ──────────────────────────────────────────────────────

/**
 * ADX tables + columns from `.show database schema as json`, surfaced by the
 * existing `/api/adx/overview` route. KQL has no foreign keys, so relationships
 * is empty by design (the diagram is a table/column schema view).
 */
export async function readKqlDatabaseGraph(source: EntitySource, doFetch: EntityFetch): Promise<EntityGraph> {
  const qs = source.itemId ? `?id=${encodeURIComponent(source.itemId)}` : '';
  let res: Response;
  try {
    res = await doFetch(`/api/adx/overview${qs}`);
  } catch (e: any) {
    return { tables: [], relationships: [], gate: `Could not reach the ADX cluster: ${e?.message || String(e)}` };
  }
  const j = await readJson(res);
  if (!j || j.ok === false) {
    return { tables: [], relationships: [], gate: (j && j.error) || `ADX schema read failed (HTTP ${res.status}).` };
  }
  const tables = parseKqlSchema(j.schema, j.database);
  if (tables.length === 0) {
    return { tables: [], relationships: [], modelName: j.database ? String(j.database) : undefined, notice: 'This database has no tables yet. Get data to populate the entity diagram.' };
  }
  return { tables, relationships: [], modelName: j.database ? String(j.database) : undefined };
}

/**
 * Parse the `.show database schema as json` payload. Shape:
 *   { Databases: { <db>: { Tables: { <name>: { Name, OrderedColumns: [{Name, Type|CslType}] } } } } }
 * Falls back to a direct `{ Tables: {...} }` object when the payload is already
 * scoped to one database.
 */
export function parseKqlSchema(schema: unknown, dbName?: string): EntityTable[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as any;
  let tablesMap: any = null;
  if (s.Databases && typeof s.Databases === 'object') {
    const dbs = s.Databases;
    const chosen = (dbName && dbs[dbName]) || dbs[Object.keys(dbs)[0]];
    tablesMap = chosen?.Tables;
  } else if (s.Tables && typeof s.Tables === 'object') {
    tablesMap = s.Tables;
  }
  if (!tablesMap || typeof tablesMap !== 'object') return [];
  const out: EntityTable[] = [];
  for (const key of Object.keys(tablesMap)) {
    const t = tablesMap[key];
    const name = String(t?.Name ?? key);
    const orderedCols: any[] = Array.isArray(t?.OrderedColumns) ? t.OrderedColumns : [];
    out.push({
      id: name,
      name,
      columns: orderedCols.map((c: any) => {
        const type = String(c?.CslType ?? c?.Type ?? '');
        return { name: String(c?.Name ?? ''), type: type || undefined, kind: classifyColumnType(type) };
      }),
    });
  }
  return out;
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/** Read the normalized entity graph for any supported source. */
export async function readEntityGraph(source: EntitySource, doFetch: EntityFetch): Promise<EntityGraph> {
  switch (source.kind) {
    case 'semantic-model': return readSemanticModelGraph(source, doFetch);
    case 'lakehouse': return readLakehouseGraph(source, doFetch);
    case 'kql-database': return readKqlDatabaseGraph(source, doFetch);
    default: return { tables: [], relationships: [], gate: `Unsupported entity source: ${(source as EntitySource).kind}` };
  }
}

/** Cardinality → the two end markers Fabric draws (1 / *). */
export function cardinalityMarkers(c: EntityCardinality): { from: '1' | '*'; to: '1' | '*' } {
  switch (c) {
    case 'one-to-one': return { from: '1', to: '1' };
    case 'one-to-many': return { from: '1', to: '*' };
    case 'many-to-many': return { from: '*', to: '*' };
    case 'many-to-one':
    default: return { from: '*', to: '1' };
  }
}
