/**
 * lib/report/navigator/introspect.ts
 *
 * Navigator OBJECT INTROSPECTION for the report designer's Power BI-style
 * "Get Data" experience, extracted verbatim from
 * app/api/items/report/[id]/connector-objects/route.ts (rel-T64) —
 * behaviour-preserving. This is the backend-facing half: the contract types, the
 * gate/response helpers, and the per-provider introspection that enumerates the
 * OBJECTS available inside a Get-Data source by dispatching to the EXISTING
 * introspection clients. The route stays a thin dispatcher and the NavNode wire
 * adapter lives in ./wire.
 *
 * Rules compliance (unchanged):
 *  - no-fabric-dependency: every provider is an Azure-native data-plane / ARM
 *    client. NO Fabric / Power BI / OneLake host is reached on ANY branch.
 *  - no-vaporware: every node is a REAL introspected object — no mock arrays. A
 *    backend that isn't configured returns an honest 412 gate naming the exact
 *    env var / role. An honest EMPTY catalog is `200 { nodes: [] }`.
 *  - no new credential code: credential-backed SQL resolves its KV secret via
 *    `getKeyVaultSecretValue` (the SAME helper the resolver uses); entra-mi uses
 *    the Console UAMI path unchanged.
 */

import { NextResponse } from 'next/server';
import {
  type ReportObjectRef,
} from '@/lib/editors/report/report-data-source';
import {
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
import { escapeSqlLiteral } from '@/lib/sql/quoting';

// ── Contract ────────────────────────────────────────────────────────────────

/** Backend family the Navigator tree introspects against (derived from source). */
export type NavProvider = 'sql' | 'databricks' | 'postgres' | 'cosmos' | 'adx' | 'adls' | 'lakehouse';

/** Tree depth being expanded. PBI Navigator: catalog → schema → tables. */
export type NavLevel = 'catalog' | 'schema' | 'tables';
const NAV_LEVELS: readonly NavLevel[] = ['catalog', 'schema', 'tables'];

/** Node kind — drives the Fluent Tree icon + whether the leaf is pickable. */
export type NavKind =
  | 'catalog' | 'schema' | 'table' | 'view'
  | 'container' | 'folder' | 'file' | 'delta-table';

export interface NavigatorObject {
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

export interface ObjectsRequest {
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
 * `NavNode` in lib/editors/report/navigator-dialog.tsx). The wire adapter maps
 * each per-provider `NavigatorObject` into this shape via `toNavNode`.
 */
export interface NavNode {
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
export interface NavCoords {
  level: NavLevel;
  schema?: string;
  catalog?: string;
  container?: string;
  path?: string;
  /** 'lakehouse' carried through descent so a lakehouse drill stays lakehouse. */
  provider?: string;
}

// ── Gate + small pure helpers ─────────────────────────────────────────────────

export function gate(error: string, missing?: string) {
  return NextResponse.json(
    { ok: false, code: 'gate', ...(missing ? { missing } : {}), error },
    { status: 412 },
  );
}

export function bad(error: string) {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

export function fail(e: unknown) {
  const msg = (e as { message?: string })?.message || String(e);
  return NextResponse.json({ ok: false, error: msg, status: 502 }, { status: 502 });
}

/** Validate the requested tree level (default 'catalog'). */
export function coerceLevel(v: unknown): NavLevel {
  return typeof v === 'string' && (NAV_LEVELS as readonly string[]).includes(v)
    ? (v as NavLevel)
    : 'catalog';
}

/** Whether a connType runs live SQL (DirectQuery-capable per PBI convention). */
export function directQueryCapable(provider: NavProvider): boolean {
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
export function leafName(p: string): string {
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
  return `'${escapeSqlLiteral(String(v))}'`;
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
export async function introspectSql(
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
export async function introspectDatabricks(
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
export async function introspectPostgres(
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
export async function introspectCosmos(
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
export async function introspectAdx(
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
export async function introspectAdls(
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
export async function introspectLakehouse(
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
export function providerForConnType(t: string): NavProvider {
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
      // Real-time analytics: the ADX report source binds a Kusto cluster and
      // lists databases→tables via kusto-client (Console UAMI). Azure-native.
      return 'adx';
    default:
      // event-hub / service-bus / key-vault aren't tabular sources — caller gates.
      return 'sql';
  }
}
