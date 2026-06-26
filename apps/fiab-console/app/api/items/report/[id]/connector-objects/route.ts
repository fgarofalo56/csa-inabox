/**
 * POST /api/items/report/[id]/connector-objects
 *
 * Navigator OBJECT INTROSPECTION for the report designer's Power BI-style
 * "Get Data" experience (REPORT-BUILDER PARITY · WAVE 2). The W1 Navigator gave
 * a row PREVIEW (POST .../connector-preview → executor.preview(N)); this route
 * gives the TREE: the real catalog → schema → tables/views structure the user
 * expands and multi-selects in the Fluent `Tree`, BEFORE a source is persisted.
 *
 * It is the structural twin of /connector-preview — same owner-load, same
 * thin-dispatch shape — but where preview hands the bound object to the resolver's
 * `ConnectionExecutor`, this route enumerates the OBJECTS available inside a
 * Get-Data source by dispatching to the EXISTING introspection clients:
 *
 *   provider │ client(s)                                            │ tree
 *   ─────────┼──────────────────────────────────────────────────────┼──────────────────────
 *   sql      │ sql-objects-client listSchemas / listTables /         │ catalog→schema→tables
 *            │ listViews (entra-mi UAMI) OR listTablesWithAuth        │ (+views)
 *            │ (credential connections — secret resolved from KV)     │
 *   databricks│ databricks-client executeStatement SHOW CATALOGS /    │ catalog→schema→tables
 *            │ SHOW SCHEMAS / SHOW TABLES                              │
 *   postgres │ postgres-flex-client executePostgresQuery over         │ catalog→schema→tables
 *            │ information_schema                                      │
 *   cosmos   │ cosmos-account-client listContainers(db)               │ database→containers
 *   adx      │ kusto-client listTables(db)                            │ database→tables
 *   adls     │ adls-client listContainers / listPaths                 │ container→path→file
 *   lakehouse│ synapse-catalog-client scanLakehouseTables             │ container→Delta table
 *
 * Provider is DERIVED from the resolved source (connection type / file kind);
 * the client may pass an explicit `provider:'lakehouse'` to switch the ADLS /
 * Synapse-serverless tree from raw paths to the managed Delta-table catalog.
 *
 * Rules compliance:
 *  - no-fabric-dependency: every provider is an Azure-native data-plane / ARM
 *    client. NO Fabric / Power BI / OneLake host is reached on ANY branch — the
 *    Navigator tree is built entirely from Azure SQL TDS catalogs, Databricks
 *    SQL, PostgreSQL information_schema, Cosmos ARM, ADX `.show tables`, and ADLS
 *    Gen2 / Synapse-serverless over Delta.
 *  - no-vaporware: every node is a REAL introspected object — no mock arrays, no
 *    `return []` placeholders. A backend that isn't configured returns an honest
 *    412 gate naming the exact env var / role (verbatim from each client's own
 *    gate: cosmosConfigGate, kustoConfigGate, databricksConfigGate,
 *    warehouseConfigGate, postgresQueryGate, hasConfiguredContainers, or the KV
 *    secret error). An honest EMPTY catalog (a real source with no tables yet) is
 *    a `200 { nodes: [] }`, never a fabricated row.
 *  - no-freeform-config: the route validates a structured tree position — either
 *    an opaque `parent` childToken (the dialog echoes back the token the route
 *    minted for a branch) or the explicit `level` enum + parent coordinates
 *    (schema / catalog / container / path). The Navigator is a tree, not a JSON
 *    blob. Each returned leaf carries the exact `ReportObjectRef` the picker
 *    splices onto the source on select (the same shape /connector-preview accepts
 *    as `objectRef`), so no free text is round-tripped.
 *
 * ── Wire contract (adapter for lib/editors/report/navigator-dialog.tsx) ──────────
 * The dialog is connector-agnostic: it POSTs `{ source, parent }` (parent = the
 * opaque `childToken` of the branch being expanded, or null for the root) and
 * renders whatever `nodes` come back, expanding a branch by echoing that node's
 * `childToken`. THIS route is the adapter that bridges its per-provider
 * introspection (which thinks in `level` + parent coords) to the dialog's
 * `NavNode` shape: it decodes `parent` → { level, schema, catalog, container,
 * path, provider }, introspects, then maps each `NavigatorObject` → a `NavNode`
 * carrying a stable `id` (TreeItem open key), `expandable` (= hasChildren),
 * `selectable`, `objectRef`, `schema`, `tableKey`, optional `meta`, and a
 * `childToken` that encodes the NEXT level + this node's coords. The dialog never
 * reconstructs backend knowledge — it just opens `id`s and echoes `childToken`s.
 *  - no new credential code: the route never opens a data-plane client itself for
 *    auth — for credential-backed SQL it resolves the KV secret via
 *    `getKeyVaultSecretValue` (the SAME helper the resolver uses) and hands a
 *    `SqlExplicitAuth` to `listTablesWithAuth`; entra-mi uses the Console UAMI
 *    path unchanged.
 *
 * 200 → { ok:true, provider, level, capabilities:{ directQueryCapable },
 *         nodes: NavNode[] }                          (dialog reads `nodes`)
 *   capabilities.directQueryCapable (per provider) + each selectable node's
 *   `deltaBacked` are the TWO signals the dialog feeds to `allowedStorageModes`
 *   — so the connectivity radio / Direct-Lake offer reflect the REAL introspected
 *   source, not a duplicated client-side connType table.
 * 412 → { ok:false, code:'gate', error, missing? }   (honest, actionable)
 * 400 → { ok:false, error }                           (bad body / non-Get-Data source)
 * 4xx/5xx → { ok:false, error, status? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadModelItem } from '@/lib/azure/model-binding';
import {
  parseDataSource,
  fromLegacyState,
  type ReportDataSource,
  type ReportObjectRef,
  type ConnectionDataSource,
  type FileUploadDataSource,
  type AdlsFileDataSource,
} from '@/lib/editors/report/report-data-source';
import {
  loadConnection,
  authNeedsSecret,
  type LoomConnection,
} from '@/lib/azure/connections-store';
import { getKeyVaultSecretValue } from '@/lib/azure/kv-secrets-client';
import type { SqlExplicitAuth } from '@/lib/azure/azure-sql-client';
import {
  listSchemas,
  listTables,
  listViews,
  listTablesWithAuth,
  type SqlObjectRow,
} from '@/lib/azure/sql-objects-client';
import { scanLakehouseTables, type CatalogTable } from '@/lib/azure/synapse-catalog-client';
import {
  listTables as listKustoTables,
  kustoConfigGate,
  defaultDatabase as kustoDefaultDatabase,
} from '@/lib/azure/kusto-client';
import {
  listContainers as listCosmosContainers,
  cosmosConfigGate,
} from '@/lib/azure/cosmos-account-client';
import {
  listContainers as listAdlsContainers,
  listPaths,
  hasConfiguredContainers,
  pathToHttpsUrl,
} from '@/lib/azure/adls-client';
import {
  executeStatement,
  databricksConfigGate,
  warehouseConfigGate,
} from '@/lib/azure/databricks-client';
import { executePostgresQuery, postgresQueryGate } from '@/lib/azure/postgres-flex-client';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Contract ────────────────────────────────────────────────────────────────

/** Backend family the Navigator tree introspects against (derived from source). */
type NavProvider = 'sql' | 'databricks' | 'postgres' | 'cosmos' | 'adx' | 'adls' | 'lakehouse';

/** Tree depth being expanded. PBI Navigator: catalog → schema → tables. */
type NavLevel = 'catalog' | 'schema' | 'tables';
const NAV_LEVELS: readonly NavLevel[] = ['catalog', 'schema', 'tables'];

/** Node kind — drives the Fluent Tree icon + whether the leaf is pickable. */
type NavKind =
  | 'catalog' | 'schema' | 'table' | 'view'
  | 'container' | 'folder' | 'file' | 'delta-table';

interface NavigatorObject {
  /** Display + selection name (leaf name). */
  name: string;
  kind: NavKind;
  /** Parent schema (SQL/Databricks/Postgres tables + views). */
  schema?: string;
  /** Two-part `schema.name` for display, when applicable. */
  fullName?: string;
  /** Container-relative path (ADLS folder/file) — feeds the next `listPaths`. */
  path?: string;
  /** Full https URL for a file/Delta-table leaf (→ objectRef.containerPath). */
  containerPath?: string;
  /** Tabular format for a file / Delta-table leaf (delta|parquet|csv|json). */
  format?: string;
  /** True when the object is Delta-backed → Direct-Lake is offered for it. */
  deltaBacked?: boolean;
  /** Approximate row count when the client cheaply knows it (SQL/lakehouse). */
  rowCount?: number | null;
  /** The node can be expanded one level deeper. */
  hasChildren: boolean;
  /** The node is a terminal object the author can bind as the report source. */
  selectable: boolean;
  /**
   * The exact `ReportObjectRef` to splice onto the Get-Data source when this
   * node is picked — identical to the `objectRef` /connector-preview accepts, so
   * a select → preview round-trip needs no client-side shape-building.
   */
  objectRef?: ReportObjectRef;
}

interface ObjectsRequest {
  /** Live Get-Data source to introspect (else the report's persisted source). */
  source?: unknown;
  /**
   * Opaque childToken of the branch being expanded — the `childToken` THIS route
   * minted on the parent node, echoed back verbatim by the dialog. Decodes to
   * { level, schema, catalog, container, path, provider }. `null`/absent = root.
   * Takes precedence over the explicit `level`/coordinate fields below (which are
   * kept as a back-compat fallback for any non-dialog caller).
   */
  parent?: string | null;
  /** Tree level to expand (default 'catalog'). Fallback when no `parent` token. */
  level?: NavLevel;
  /** Parent schema (SQL/Databricks/Postgres `tables` level). */
  schema?: string;
  /** Parent catalog (Databricks `schema`/`tables` level; default conn namespace). */
  catalog?: string;
  /** Parent container (ADLS/lakehouse navigation). */
  container?: string;
  /** Parent path/prefix within a container (ADLS folder drill-down). */
  path?: string;
  /**
   * Explicit provider override — the only honoured value is 'lakehouse', which
   * switches an ADLS / Synapse-serverless source's tree from raw file paths to
   * the managed Delta-table catalog (synapse-catalog-client scan). Any other
   * value is ignored and the provider is derived from the source.
   */
  provider?: string;
}

/**
 * One node as the dialog's Fluent Tree consumes it (the wire shape of
 * `NavNode` in lib/editors/report/navigator-dialog.tsx). The route maps each
 * per-provider `NavigatorObject` into this shape via `toNavNode`.
 */
interface NavNode {
  /** Stable unique id within this tree (TreeItem value / open key). */
  id: string;
  /** Human label shown on the row. */
  name: string;
  /** Node role — drives the icon + whether it can be selected. */
  kind: 'catalog' | 'database' | 'schema' | 'folder' | 'table' | 'view' | 'container' | 'file';
  /** True when the node has children to load lazily (rendered as a branch). */
  expandable: boolean;
  /** Opaque token echoed back as `parent` to fetch this node's children. */
  childToken?: string;
  /** True when the node is a bindable object (table / view / container / file). */
  selectable: boolean;
  /** The W1 ReportObjectRef to read this object (present iff selectable). */
  objectRef?: ReportObjectRef;
  /** Canonical key for state.tableStorage (schema.name / name). */
  tableKey?: string;
  /** Owning schema, when applicable. */
  schema?: string;
  /**
   * True when the introspected object is Delta-backed. The dialog reads THIS
   * (with the response's `capabilities.directQueryCapable`) to drive
   * `allowedStorageModes` — so the Direct-Lake offer reflects the REAL source,
   * not a duplicated client-side connType table. Omitted (⇒ falsy) when the
   * object is not Delta (SQL tables, parquet/csv/json files, Cosmos, ADX).
   */
  deltaBacked?: boolean;
  /** Light metadata for the row badge (format, row estimate, object type). */
  meta?: { format?: string; rowEstimate?: number; type?: string };
}

/**
 * Decoded tree position: the `level` to introspect + the parent coordinates the
 * provider needs. Produced by decoding a `parent` childToken (or the explicit
 * body fields), and re-encoded into each branch node's `childToken`.
 */
interface NavCoords {
  level: NavLevel;
  schema?: string;
  catalog?: string;
  container?: string;
  path?: string;
  /** 'lakehouse' carried through descent so a lakehouse drill stays lakehouse. */
  provider?: string;
}

// ── Gate + small pure helpers ─────────────────────────────────────────────────

function gate(error: string, missing?: string) {
  return NextResponse.json(
    { ok: false, code: 'gate', ...(missing ? { missing } : {}), error },
    { status: 412 },
  );
}

function bad(error: string) {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

function fail(e: unknown) {
  const msg = (e as { message?: string })?.message || String(e);
  return NextResponse.json({ ok: false, error: msg, status: 502 }, { status: 502 });
}

/** Validate the requested tree level (default 'catalog'). */
function coerceLevel(v: unknown): NavLevel {
  return typeof v === 'string' && (NAV_LEVELS as readonly string[]).includes(v)
    ? (v as NavLevel)
    : 'catalog';
}

/** Whether a connType runs live SQL (DirectQuery-capable per PBI convention). */
function directQueryCapable(provider: NavProvider): boolean {
  // SQL-family / Databricks / ADX / Postgres = live source. Cosmos / ADLS files
  // are Import-only (+ Direct-Lake for Delta, decided per-object via deltaBacked).
  switch (provider) {
    case 'sql':
    case 'databricks':
    case 'postgres':
    case 'adx':
    case 'lakehouse':
      return true;
    case 'cosmos':
    case 'adls':
      return false;
    default:
      return false;
  }
}

/** Inferred tabular format from a file leaf name (Synapse-serverless readable). */
function formatFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.parquet')) return 'parquet';
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv';
  if (lower.endsWith('.json') || lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'json';
  if (lower.endsWith('.delta')) return 'delta';
  return '';
}

/** Leaf segment of an ADLS path (`a/b/c` → `c`). */
function leafName(p: string): string {
  const t = String(p).replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}

/** Backtick-quote a Databricks identifier (doubles embedded backticks). */
function bq(name: string): string {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

/** Single-quoted SQL string literal (doubles embedded quotes) — Postgres filter. */
function pgLiteral(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Pick a column's value from a columns/rows matrix by candidate names, else index. */
function colVal(columns: string[], row: unknown[], candidates: string[], fallbackIdx: number): string {
  for (const c of candidates) {
    const i = columns.findIndex((k) => k.toLowerCase() === c.toLowerCase());
    if (i >= 0) return String(row[i] ?? '');
  }
  const v = row[fallbackIdx];
  return v == null ? '' : String(v);
}

// ── SQL credential resolution (entra-mi → UAMI; else KV secret → SqlExplicitAuth) ──

/**
 * Resolve a SQL-family connection's explicit auth from its KV secret, or
 * `undefined` for the Console-UAMI (entra-mi) path. Mirrors the resolver's
 * `resolveConnectionSecret` + `azureSqlRunner` auth branches — no new credential
 * logic. Throws an honest, gate-ready error when a secret-backed method has no
 * stored secret, or an unsupported method is used for SQL navigation.
 */
async function resolveSqlAuth(conn: LoomConnection): Promise<SqlExplicitAuth | undefined> {
  if (conn.authMethod === 'entra-mi') return undefined;
  if (!authNeedsSecret(conn.authMethod)) return undefined;
  if (conn.authMethod !== 'connection-string' && conn.authMethod !== 'sql-password') {
    throw new Error(
      `SQL Navigator supports Entra managed identity, SQL login, or connection-string auth; ` +
        `the connection "${conn.name}" uses "${conn.authMethod}". Re-bind it with one of those, ` +
        `or pick a table via a custom query.`,
    );
  }
  if (!conn.secretRef) {
    throw new Error(
      `Connection "${conn.name}" uses ${conn.authMethod} auth but has no stored secret in Key Vault. ` +
        `Re-create it via "Add existing connection" so its secret lands in Key Vault.`,
    );
  }
  const secret = await getKeyVaultSecretValue(conn.secretRef);
  if (conn.authMethod === 'connection-string') return { connectionString: secret };
  return { user: conn.username || '', password: secret };
}

// ── Per-provider introspection (REAL backends only — never a mock) ────────────

/** Map a sql-objects-client row → a Navigator table/view leaf. */
function sqlObjectToNode(r: SqlObjectRow, kind: 'table' | 'view'): NavigatorObject {
  const schema = r.schema || undefined;
  return {
    name: r.name,
    kind,
    schema,
    fullName: r.fullName || (schema ? `${schema}.${r.name}` : r.name),
    rowCount: typeof r.rowCount === 'number' ? r.rowCount : undefined,
    hasChildren: false,
    selectable: true,
    objectRef: { mode: 'table', table: r.name, ...(schema ? { schema } : {}) },
  };
}

/**
 * SQL family (azure-sql | generic-sql | synapse-dedicated | synapse-serverless).
 * entra-mi connections enumerate via the UAMI catalog readers; credential
 * connections read the catalog with their resolved KV secret via
 * `listTablesWithAuth` (tables only — schemas/views are derived from that set,
 * since the catalog readers' AAD path doesn't apply under SQL-login auth).
 */
async function introspectSql(
  conn: LoomConnection,
  level: NavLevel,
  schemaFilter: string | undefined,
): Promise<NavigatorObject[]> {
  const server = conn.host || '';
  const database = conn.database || '';
  if (!server) {
    throw Object.assign(new Error(
      `The SQL connection "${conn.name}" has no server set. Re-bind it with a server (host) so the Navigator can read its catalog.`,
    ), { gateMissing: 'host' });
  }
  const auth = await resolveSqlAuth(conn);

  if (level === 'catalog') {
    // A SQL connection is bound to one database — that is its catalog node.
    return [{
      name: database || '(default database)',
      kind: 'catalog',
      hasChildren: true,
      selectable: false,
    }];
  }

  if (level === 'schema') {
    if (!auth) {
      const schemas = await listSchemas(server, database);
      return schemas.map((s) => ({
        name: s.name, kind: 'schema' as const, hasChildren: true, selectable: false,
      }));
    }
    // Credential path: derive distinct schemas from the (auth-aware) table list.
    const tables = await listTablesWithAuth(server, database, auth);
    const names = Array.from(new Set(tables.map((t) => t.schema).filter(Boolean))).sort();
    return names.map((n) => ({
      name: n, kind: 'schema' as const, hasChildren: true, selectable: false,
    }));
  }

  // level === 'tables'
  if (!auth) {
    const [tables, views] = await Promise.all([
      listTables(server, database),
      listViews(server, database).catch(() => [] as SqlObjectRow[]),
    ]);
    const out = [
      ...tables.map((t) => sqlObjectToNode(t, 'table')),
      ...views.map((v) => sqlObjectToNode(v, 'view')),
    ];
    return schemaFilter ? out.filter((n) => n.schema === schemaFilter) : out;
  }
  const tables = await listTablesWithAuth(server, database, auth);
  const out = tables.map((t) => sqlObjectToNode(t, 'table'));
  return schemaFilter ? out.filter((n) => n.schema === schemaFilter) : out;
}

/**
 * Databricks SQL — `SHOW CATALOGS` / `SHOW SCHEMAS IN <catalog>` /
 * `SHOW TABLES IN <catalog>.<schema>` via the SQL warehouse. Identifiers are
 * backtick-quoted (injection-safe); catalog/schema default from the connection's
 * `database` (`catalog` or `catalog.schema`).
 */
async function introspectDatabricks(
  conn: LoomConnection,
  level: NavLevel,
  reqCatalog: string | undefined,
  reqSchema: string | undefined,
): Promise<NavigatorObject[] | NextResponse> {
  const cfg = databricksConfigGate();
  if (cfg) return gate(`Databricks SQL is not configured for this deployment. Set ${cfg.missing} on the Loom Console.`, cfg.missing);
  const wh = warehouseConfigGate();
  if (wh) return gate(`No Databricks SQL warehouse is configured. Set ${wh.missing} on the Loom Console.`, wh.missing);
  const warehouseId = (process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '').trim();
  const [defCatalog, defSchema] = (conn.database || '').split('.');
  const catalog = (reqCatalog || defCatalog || '').trim();
  const schema = (reqSchema || defSchema || '').trim();

  if (level === 'catalog') {
    const r = await executeStatement(warehouseId, 'SHOW CATALOGS');
    return r.rows.map((row) => {
      const name = colVal(r.columns, row, ['catalog', 'catalogName'], 0);
      return { name, kind: 'catalog' as const, hasChildren: true, selectable: false };
    }).filter((n) => n.name);
  }

  if (level === 'schema') {
    const sql = catalog ? `SHOW SCHEMAS IN ${bq(catalog)}` : 'SHOW SCHEMAS';
    const r = await executeStatement(warehouseId, sql);
    return r.rows.map((row) => {
      const name = colVal(r.columns, row, ['databaseName', 'namespace', 'schemaName'], 0);
      return { name, kind: 'schema' as const, hasChildren: true, selectable: false };
    }).filter((n) => n.name);
  }

  // level === 'tables'
  if (!catalog || !schema) {
    return gate(
      'Pick a catalog and schema first — Databricks lists tables within a `catalog.schema` namespace. ' +
        'Set the connection\'s default namespace (catalog or catalog.schema), or expand the tree to a schema.',
      'catalog',
    );
  }
  const r = await executeStatement(warehouseId, `SHOW TABLES IN ${bq(catalog)}.${bq(schema)}`);
  return r.rows.map((row) => {
    const name = colVal(r.columns, row, ['tableName'], 1);
    return {
      name,
      kind: 'table' as const,
      schema,
      fullName: `${catalog}.${schema}.${name}`,
      hasChildren: false,
      selectable: true,
      objectRef: { mode: 'table', table: name, schema },
    } satisfies NavigatorObject;
  }).filter((n) => n.name);
}

/** PostgreSQL — information_schema over the connection's database (live SQL). */
async function introspectPostgres(
  conn: LoomConnection,
  level: NavLevel,
  schemaFilter: string | undefined,
): Promise<NavigatorObject[] | NextResponse> {
  const g = postgresQueryGate();
  if (g) return gate(g.detail, g.missing);
  const fqdn = conn.host || '';
  const db = conn.database || 'postgres';
  if (!fqdn) return gate(`The PostgreSQL connection "${conn.name}" has no host set. Re-bind it with a server FQDN.`, 'host');

  if (level === 'catalog') {
    return [{ name: db, kind: 'catalog', hasChildren: true, selectable: false }];
  }
  if (level === 'schema') {
    const r = await executePostgresQuery(
      fqdn, db,
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema')
         AND schema_name NOT LIKE 'pg_%'
       ORDER BY schema_name`,
    );
    return r.rows.map((row) => ({
      name: String(row[0] ?? ''), kind: 'schema' as const, hasChildren: true, selectable: false,
    })).filter((n) => n.name);
  }
  // tables (+ views)
  const where = schemaFilter
    ? `table_schema = ${pgLiteral(schemaFilter)}`
    : `table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_%'`;
  const r = await executePostgresQuery(
    fqdn, db,
    `SELECT table_schema, table_name, table_type FROM information_schema.tables
     WHERE ${where}
     ORDER BY table_schema, table_name`,
  );
  return r.rows.map((row) => {
    const schema = String(row[0] ?? '');
    const name = String(row[1] ?? '');
    const isView = String(row[2] ?? '').toUpperCase().includes('VIEW');
    return {
      name,
      kind: (isView ? 'view' : 'table') as NavKind,
      schema,
      fullName: `${schema}.${name}`,
      hasChildren: false,
      selectable: true,
      objectRef: { mode: 'table', table: name, schema },
    } satisfies NavigatorObject;
  }).filter((n) => n.name);
}

/** Cosmos DB — the connection's database (catalog) → containers (collections). */
async function introspectCosmos(
  conn: LoomConnection,
  level: NavLevel,
): Promise<NavigatorObject[] | NextResponse> {
  const cfg = cosmosConfigGate();
  if (cfg) return gate(cfg.hint, cfg.missing);
  const db = conn.database || '';
  if (!db) {
    return gate(
      `The Cosmos connection "${conn.name}" has no database set. Re-pick it with a database so the Navigator can list its containers.`,
      'database',
    );
  }
  if (level === 'catalog') {
    return [{ name: db, kind: 'catalog', hasChildren: true, selectable: false }];
  }
  // schema/tables → containers (a Cosmos collection is the bindable "table").
  const containers = await listCosmosContainers(db);
  return containers.map((c) => ({
    name: c.name,
    kind: 'table' as const,
    hasChildren: false,
    selectable: true,
    objectRef: { mode: 'table', table: c.name } as ReportObjectRef,
  }));
}

/** ADX (Kusto) — the connection/default database → tables (`.show tables`). */
async function introspectAdx(
  conn: LoomConnection | null,
  level: NavLevel,
): Promise<NavigatorObject[] | NextResponse> {
  const cfg = kustoConfigGate();
  if (cfg) {
    return gate(
      `Azure Data Explorer is not configured for this deployment. Set ${cfg.missing} on the Loom Console ` +
        `(the ADX cluster URI the report source reads from).`,
      cfg.missing,
    );
  }
  const db = (conn?.database || '').trim() || kustoDefaultDatabase();
  if (!db) {
    return gate('No ADX database is set. Bind the connection to a database, or set the cluster default database.', 'database');
  }
  if (level === 'catalog') {
    return [{ name: db, kind: 'catalog', hasChildren: true, selectable: false }];
  }
  const tables = await listKustoTables(db);
  return tables.map((t) => ({
    name: t.name,
    kind: 'table' as const,
    hasChildren: false,
    selectable: true,
    objectRef: { mode: 'table', table: t.name } as ReportObjectRef,
  }));
}

/**
 * ADLS Gen2 raw navigation — containers → folders → files. Directories are
 * expandable (a Delta/Parquet table folder is a directory) AND selectable as a
 * folder-format object; files are selectable leaves with an inferred format.
 * Every node is read live via the Console MI (adls-client) — no mocks.
 */
async function introspectAdls(
  level: NavLevel,
  container: string | undefined,
  path: string | undefined,
): Promise<NavigatorObject[] | NextResponse> {
  if (!hasConfiguredContainers()) {
    return gate(
      'No data-lake containers are configured for this deployment. Set LOOM_BRONZE_URL / LOOM_SILVER_URL / ' +
        'LOOM_GOLD_URL / LOOM_LANDING_URL on the Console (the ADLS Gen2 container URLs) and grant the Console ' +
        'UAMI "Storage Blob Data Reader" on the storage account.',
      'LOOM_BRONZE_URL',
    );
  }
  if (level === 'catalog' || !container) {
    const containers = await listAdlsContainers();
    return containers.map((c) => ({
      name: c.name,
      kind: 'container' as const,
      path: '',
      hasChildren: true,
      selectable: false,
    }));
  }
  // schema/tables → list paths under the (container, prefix).
  const entries = await listPaths(container, path || '', 500);
  return entries.map((e) => {
    const name = leafName(e.name);
    const rel = e.name; // container-relative path from the SDK
    const httpsUrl = pathToHttpsUrl(container, rel);
    if (e.isDirectory) {
      // A directory is a navigable folder AND a candidate Delta/Parquet table
      // folder. Default-suggest Delta (the lakehouse convention); the storage
      // pane lets the author override the format before binding.
      return {
        name,
        kind: 'folder' as const,
        path: rel,
        containerPath: httpsUrl,
        format: 'delta',
        deltaBacked: true,
        hasChildren: true,
        selectable: true,
        objectRef: { mode: 'file', containerPath: httpsUrl, format: 'delta' },
      } satisfies NavigatorObject;
    }
    const format = formatFromName(name);
    return {
      name,
      kind: 'file' as const,
      path: rel,
      containerPath: httpsUrl,
      format,
      deltaBacked: format === 'delta',
      rowCount: null,
      hasChildren: false,
      selectable: !!format,
      ...(format ? { objectRef: { mode: 'file', containerPath: httpsUrl, format } } : {}),
    } as NavigatorObject;
  });
}

/**
 * Managed Delta-table catalog over the data lake (Synapse-serverless / lakehouse
 * provider). `catalog` level → the configured containers; `tables` level →
 * scanLakehouseTables for the chosen container (or all), emitting one Delta-table
 * leaf per `Tables/<name>` directory with a serverless-readable BULK url.
 */
async function introspectLakehouse(
  level: NavLevel,
  container: string | undefined,
): Promise<NavigatorObject[] | NextResponse> {
  if (!hasConfiguredContainers()) {
    return gate(
      'No data-lake containers are configured for this deployment. Set LOOM_BRONZE_URL / LOOM_SILVER_URL / ' +
        'LOOM_GOLD_URL on the Console (the ADLS Gen2 container URLs) and grant the Console UAMI ' +
        '"Storage Blob Data Reader" on the storage account.',
      'LOOM_BRONZE_URL',
    );
  }
  if (level === 'catalog') {
    const containers = await listAdlsContainers();
    return containers.map((c) => ({
      name: c.name, kind: 'container' as const, hasChildren: true, selectable: false,
    }));
  }
  const tables: CatalogTable[] = await scanLakehouseTables(
    container ? { containers: [container] } : {},
  );
  return tables.map((t) => ({
    name: t.name,
    kind: 'delta-table' as const,
    schema: t.schema,
    fullName: `${t.schema}.${t.name}`,
    path: t.adlsPath,
    containerPath: t.bulkUrl,
    format: t.format === 'unknown' ? 'delta' : t.format,
    deltaBacked: t.format === 'delta',
    rowCount: t.rowCount,
    hasChildren: false,
    selectable: t.status !== 'broken',
    objectRef: {
      mode: 'file',
      containerPath: t.bulkUrl,
      format: t.format === 'unknown' ? 'delta' : t.format,
    } satisfies ReportObjectRef,
  }));
}

// ── Provider derivation ───────────────────────────────────────────────────────

/** Derive the Navigator provider from the resolved source's connection type. */
function providerForConnType(t: string): NavProvider {
  switch (t) {
    case 'azure-sql':
    case 'generic-sql':
    case 'synapse-dedicated':
    case 'synapse-serverless':
      return 'sql';
    case 'databricks-sql':
      return 'databricks';
    case 'postgres':
      return 'postgres';
    case 'cosmos':
      return 'cosmos';
    case 'storage-adls':
      return 'adls';
    case 'adx':
      // Forward-compat: no bindable ADX ConnectionType lands until the ADX
      // report-source task, but the dispatch is ready the moment one does.
      return 'adx';
    default:
      // event-hub / service-bus / key-vault aren't tabular sources — caller gates.
      return 'sql';
  }
}

// ── Navigator wire adapter (NavigatorObject → NavNode; childToken codec) ───────

/** Encode tree coordinates into an opaque, URL-safe childToken (undefined dropped). */
function encodeToken(c: NavCoords): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Decode a childToken back to coordinates; null on any tampering / bad shape. */
function decodeToken(token: string): NavCoords | null {
  try {
    const j = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    return {
      level: coerceLevel(j.level),
      schema: typeof j.schema === 'string' ? j.schema : undefined,
      catalog: typeof j.catalog === 'string' ? j.catalog : undefined,
      container: typeof j.container === 'string' ? j.container : undefined,
      path: typeof j.path === 'string' ? j.path : undefined,
      provider: typeof j.provider === 'string' ? j.provider : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the tree position to introspect. The dialog always echoes the branch's
 * opaque `parent` childToken (null at the root); a non-dialog caller may instead
 * pass the explicit `level` + coordinate fields. `parent` wins when present.
 */
function resolveCoords(body: ObjectsRequest): NavCoords {
  if (typeof body.parent === 'string' && body.parent.trim()) {
    const decoded = decodeToken(body.parent.trim());
    if (decoded) return decoded;
  }
  return {
    level: coerceLevel(body.level),
    schema: typeof body.schema === 'string' ? body.schema : undefined,
    catalog: typeof body.catalog === 'string' ? body.catalog : undefined,
    container: typeof body.container === 'string' ? body.container : undefined,
    path: typeof body.path === 'string' ? body.path : undefined,
    provider: typeof body.provider === 'string' ? body.provider : undefined,
  };
}

/**
 * The childToken for a branch node: the NEXT level to fetch + the coordinates the
 * provider needs to enumerate this node's children. Returns undefined for leaves.
 * Mirrors each provider's hierarchy (catalog→schema→tables, db→containers/tables,
 * container→paths→files). 'lakehouse' is carried so a lakehouse drill stays one.
 */
function childTokenFor(provider: NavProvider, coords: NavCoords, obj: NavigatorObject): string | undefined {
  if (!obj.hasChildren) return undefined;
  const carry = coords.provider === 'lakehouse' || provider === 'lakehouse' ? 'lakehouse' : undefined;
  switch (obj.kind) {
    case 'catalog':
      if (provider === 'databricks') return encodeToken({ level: 'schema', catalog: obj.name, provider: carry });
      if (provider === 'sql' || provider === 'postgres') return encodeToken({ level: 'schema', provider: carry });
      // cosmos / adx: a catalog expands straight to its bindable tables/containers.
      return encodeToken({ level: 'tables', provider: carry });
    case 'schema':
      // carry the owning catalog (databricks) through to the tables level.
      return encodeToken({ level: 'tables', catalog: coords.catalog, schema: obj.name, provider: carry });
    case 'container':
      return encodeToken({ level: 'tables', container: obj.name, path: '', provider: carry });
    case 'folder':
      // ADLS folder drill-down: keep the container, descend by the folder's path.
      return encodeToken({ level: 'tables', container: coords.container, path: obj.path || '', provider: carry });
    default:
      // table / view / delta-table / file → terminal leaf.
      return undefined;
  }
}

/** state.tableStorage key for a selectable node (schema.name / fullName / name). */
function navTableKey(obj: NavigatorObject): string | undefined {
  if (!obj.selectable) return undefined;
  if (obj.fullName) return obj.fullName;
  return obj.schema ? `${obj.schema}.${obj.name}` : obj.name;
}

/** Row-badge metadata (only defined keys; undefined when there's nothing to show). */
function navMeta(obj: NavigatorObject): NavNode['meta'] | undefined {
  const meta: { format?: string; rowEstimate?: number; type?: string } = {};
  if (obj.format) meta.format = obj.format;
  if (typeof obj.rowCount === 'number') meta.rowEstimate = obj.rowCount;
  if (obj.kind === 'view') meta.type = 'view';
  else if (obj.deltaBacked && !obj.format) meta.type = 'delta';
  return Object.keys(meta).length ? meta : undefined;
}

/** The dialog's kind union has no 'delta-table' — render those as a table. */
function dialogKind(kind: NavKind): NavNode['kind'] {
  return kind === 'delta-table' ? 'table' : kind;
}

/** Stable, tree-unique id from the parent coords + the node's own identity. */
function stableId(provider: NavProvider, coords: NavCoords, obj: NavigatorObject): string {
  const ctx = [provider, coords.level, coords.catalog || '', coords.schema || '', coords.container || '', coords.path || ''].join('|');
  const self = [obj.kind, obj.schema || '', obj.path || obj.fullName || obj.name].join('|');
  return `${ctx}##${self}`;
}

/** Map a per-provider NavigatorObject to the dialog's NavNode wire shape. */
function toNavNode(obj: NavigatorObject, provider: NavProvider, coords: NavCoords): NavNode {
  const childToken = childTokenFor(provider, coords, obj);
  const tableKey = navTableKey(obj);
  const meta = navMeta(obj);
  return {
    id: stableId(provider, coords, obj),
    name: obj.name,
    kind: dialogKind(obj.kind),
    expandable: !!obj.hasChildren,
    ...(childToken ? { childToken } : {}),
    selectable: !!obj.selectable,
    ...(obj.objectRef ? { objectRef: obj.objectRef } : {}),
    ...(tableKey ? { tableKey } : {}),
    ...(obj.schema ? { schema: obj.schema } : {}),
    ...(obj.deltaBacked ? { deltaBacked: true } : {}),
    ...(meta ? { meta } : {}),
  };
}

/** Build the 200 success body — maps objects → `nodes` (the dialog's wire key). */
function respond(provider: NavProvider, coords: NavCoords, objects: NavigatorObject[]) {
  return NextResponse.json({
    ok: true,
    provider,
    level: coords.level,
    capabilities: { directQueryCapable: directQueryCapable(provider) },
    nodes: objects.map((o) => toNavNode(o, provider, coords)),
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as ObjectsRequest;
  // Decode the tree position: the dialog echoes a branch's opaque `parent`
  // childToken (null at root); a non-dialog caller may pass explicit coords.
  const coords = resolveCoords(body);
  const level = coords.level;

  // Load the report item (loom: content id OR plain Cosmos id), owner-checked —
  // identical pattern to /connector-preview + /fields + /query.
  const id = (await ctx.params).id;
  let item: WorkspaceItem | null;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
  } else {
    item = await loadModelItem(id, 'report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
  }

  // Resolve the source to introspect: the live `body.source` (Navigator before
  // persist, incl. the W1 get-data bind step) wins; else the persisted source.
  let source: ReportDataSource | null;
  if (body.source !== undefined && body.source !== null) {
    source = parseDataSource(body.source);
    if (!source) return bad('Invalid "source" in request body.');
  } else {
    source = fromLegacyState((item.state || {}) as Record<string, unknown>);
  }
  if (!source) {
    return gate(
      'This report has no data source yet. Open "Data source" → Get data and pick a connection, an ' +
        'uploaded file, or an ADLS path to browse its objects.',
      'dataSource',
    );
  }

  // The Navigator applies ONLY to Get-Data sources (a connection or a file). A
  // semantic-model / direct-query / aas source has no connector tree to browse.
  if (source.kind !== 'connection' && source.kind !== 'file-upload' && source.kind !== 'adls-file') {
    return bad(
      'Object navigation applies only to Get Data sources (a connection, an uploaded file, or an ADLS ' +
        'path). A semantic model, direct query, or Analysis Services binding has no connector tree.',
    );
  }

  // An explicit `provider:'lakehouse'` (in the body or carried in the childToken)
  // switches an ADLS / serverless source to the managed Delta-table catalog.
  const wantLakehouse = coords.provider === 'lakehouse' || body.provider === 'lakehouse';

  try {
    // ── File sources (no connection) ──────────────────────────────────────────
    if (source.kind === 'file-upload') {
      // A staged upload IS the object — surface it as a single selectable leaf so
      // the Navigator shows the bound file (never a blank tree).
      const f = source as FileUploadDataSource;
      const objects: NavigatorObject[] = f.containerPath
        ? [{
            name: f.fileName || leafName(f.containerPath),
            kind: 'file',
            containerPath: f.containerPath,
            format: f.format,
            deltaBacked: (f.format || '').toLowerCase() === 'delta',
            hasChildren: false,
            selectable: true,
            objectRef: { mode: 'file', containerPath: f.containerPath, format: f.format },
          }]
        : [];
      return respond('adls', coords, objects);
    }

    if (source.kind === 'adls-file') {
      const a = source as AdlsFileDataSource;
      const provider: NavProvider = wantLakehouse ? 'lakehouse' : 'adls';
      const result = wantLakehouse
        ? await introspectLakehouse(level, coords.container || a.container)
        : await introspectAdls(level, coords.container || a.container, coords.path ?? a.path);
      if (result instanceof NextResponse) return result;
      return respond(provider, coords, result);
    }

    // ── Connection sources ────────────────────────────────────────────────────
    const conn0 = source as ConnectionDataSource;
    if (!conn0.connectionId) {
      return gate(
        'This report\'s Get Data source has no connection bound yet. Open "Data source" and pick (or add) a connection.',
        'connection',
      );
    }
    const conn = await loadConnection(session.claims.oid, conn0.connectionId);
    if (!conn) {
      return gate(
        `The bound connection (${conn0.connectionId}) was not found in this tenant. Re-pick a connection in the report's Data source panel.`,
        'connection',
      );
    }

    // Storage / serverless connections can browse either raw ADLS paths or the
    // managed Delta-table catalog (provider:'lakehouse').
    if (conn.type === 'storage-adls' || (wantLakehouse && conn.type === 'synapse-serverless')) {
      const provider: NavProvider = wantLakehouse ? 'lakehouse' : 'adls';
      const result = wantLakehouse
        ? await introspectLakehouse(level, coords.container)
        : await introspectAdls(level, coords.container, coords.path);
      if (result instanceof NextResponse) return result;
      return respond(provider, coords, result);
    }

    const provider = providerForConnType(conn.type);
    let objects: NavigatorObject[] | NextResponse;
    switch (provider) {
      case 'sql':
        try {
          objects = await introspectSql(conn, level, coords.schema);
        } catch (e: any) {
          if (e?.gateMissing) return gate(e.message, e.gateMissing);
          throw e;
        }
        break;
      case 'databricks':
        objects = await introspectDatabricks(conn, level, coords.catalog, coords.schema);
        break;
      case 'postgres':
        objects = await introspectPostgres(conn, level, coords.schema);
        break;
      case 'cosmos':
        objects = await introspectCosmos(conn, level);
        break;
      case 'adx':
        objects = await introspectAdx(conn, level);
        break;
      default:
        // event-hub / service-bus / key-vault — not a tabular report source.
        return gate(
          `A "${conn.type}" connection isn't browsable as a report source. Pick an Azure SQL, Synapse, ` +
            'Databricks SQL, PostgreSQL, Cosmos DB, or ADLS/Blob connection.',
          'connType',
        );
    }
    if (objects instanceof NextResponse) return objects;
    return respond(provider, coords, objects);
  } catch (e: any) {
    return fail(e);
  }
}
