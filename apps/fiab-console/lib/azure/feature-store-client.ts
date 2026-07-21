/**
 * feature-store-client — the Feature Store backend for the `feature-table` item
 * (WS-2.1, Databricks Feature Store parity: grade D → A−).
 *
 * ONE facade over two REAL, sovereign backends (no Fabric, per
 * .claude/rules/no-fabric-dependency.md):
 *
 *   OFFLINE feature store (author + point-in-time joins)
 *     • DEFAULT 'databricks'  — Unity Catalog feature tables (Delta), created +
 *       queried via the Databricks SQL warehouse Statement Execution API. UC-
 *       governed (catalog.schema.table three-part names).
 *     • Gov 'postgres'        — OSS-UC + Azure Database for PostgreSQL Flexible
 *       Server (sovereign, no Databricks endpoint in Gov). Feature tables are
 *       real Postgres tables; PIT joins run over the pg wire protocol.
 *     Selected by {@link resolveFeatureStoreBackend} — explicit
 *     LOOM_FEATURE_STORE_BACKEND wins; otherwise auto = postgres when OSS-UC is
 *     active OR no Databricks workspace is bound, else databricks.
 *
 *   ONLINE feature store (feature-lookup-at-serving)
 *     • Lakebase / pgvector — Azure Database for PostgreSQL Flexible Server
 *       (the same server the vector-store + lakebase editors use). A published
 *       online table is a real Postgres table keyed by the entity keys; a lookup
 *       at inference is a real indexed SELECT. Wired into the model-serving
 *       invoke path (WS-1.2) via {@link mergeFeaturesIntoPayload}.
 *
 * No mocks, no `return []` placeholders — every op is real REST / TDS / pg wire
 * protocol, or an honest structured gate ({@link featureStoreConfigGate}) naming
 * the exact env var + inline Fix-it target (no-vaporware.md, ux-baseline G2).
 *
 * The pure builders (buildPitJoinSql / buildOnlineTableDdl / buildOnlineLookupSql
 * / buildLatestOfflineSql / mergeFeaturesIntoPayload / validateFeatureTableSpec)
 * are exported for unit tests — they are injection-safe (every identifier is
 * validated + quoted, every value is bound as a parameter).
 *
 * Grounding (Microsoft Learn / Databricks):
 *   Databricks Feature Store   https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/
 *   Point-in-time lookups      https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/time-series
 *   Online tables (Lakebase)   https://learn.microsoft.com/azure/databricks/machine-learning/feature-store/publish-features
 */
import { isOssUc } from '@/lib/azure/uc-backend';
import {
  databricksConfigGate,
  listWarehouses,
  executeStatement,
} from '@/lib/azure/databricks-client';
import {
  executePostgresQuery,
  executePostgresBatch,
  postgresQueryGate,
  PostgresError,
} from '@/lib/azure/postgres-flex-client';

export type FeatureStoreBackend = 'databricks' | 'postgres';

// ── item state shapes ────────────────────────────────────────────────────────

export interface FeatureColumn {
  /** Feature column name (simple identifier). */
  name: string;
  /** Logical type — DOUBLE | FLOAT | BIGINT | INT | STRING | BOOLEAN | TIMESTAMP. */
  dataType: string;
}

export interface FeatureTableSpec {
  /** Offline feature table full name: catalog.schema.table (databricks) or
   *  schema.table / table (postgres). */
  fullName: string;
  /** Entity key columns (the join keys). At least one. */
  primaryKeys: string[];
  /** The event-time column used for point-in-time correctness. */
  timestampKey: string;
  /** Feature columns (excludes the primary keys + timestamp). */
  features: FeatureColumn[];
  /** Offline engine that owns this table. Defaults to the resolved backend. */
  offlineBackend?: FeatureStoreBackend;
  /** Online (Postgres) serving table name — defaults to a sanitised fullName. */
  onlineTable?: string;
  description?: string;
}

/** A spine / label / training set the feature table is PIT-joined onto. */
export interface PitSpineSpec {
  /** Spine table full name (label rows: entity keys + event timestamp + label). */
  fullName: string;
  /** Spine entity-key columns, aligned 1:1 (by position) with the feature PKs. */
  entityKeys: string[];
  /** The spine event-time column (the "as of" time each label was observed). */
  timestampKey: string;
  /** Optional label / passthrough columns to carry into the training set. */
  carryColumns?: string[];
  /** Cap on returned rows (default 1000). */
  limit?: number;
}

// ── backend selection + gates ────────────────────────────────────────────────

function hasDatabricks(): boolean {
  return !!(process.env.LOOM_DATABRICKS_HOSTNAMES || process.env.LOOM_DATABRICKS_HOSTNAME);
}

/**
 * Resolve the active OFFLINE feature-store backend. Explicit
 * LOOM_FEATURE_STORE_BACKEND wins; otherwise auto-select Postgres (sovereign)
 * when OSS-UC is active OR no Databricks workspace is bound, else Databricks.
 */
export function resolveFeatureStoreBackend(): FeatureStoreBackend {
  const explicit = (process.env.LOOM_FEATURE_STORE_BACKEND || '').trim().toLowerCase();
  if (explicit === 'postgres') return 'postgres';
  if (explicit === 'databricks') return 'databricks';
  if (isOssUc() || !hasDatabricks()) return 'postgres';
  return 'databricks';
}

export interface FeatureStoreGate {
  backend: FeatureStoreBackend;
  /** The exact env var(s) missing. */
  missing: string;
  /** One-line operator remediation. */
  hint: string;
  /** The single env var the inline Fix-it wizard writes (G2). */
  fixEnvVar: string;
  /** The gate-registry id (G2) so Copilot / the Admin gate page can resolve it. */
  gateId: string;
}

const GATE_ID = 'svc-feature-store';

/** Online (Lakebase/pgvector) host — the Postgres server that serves features. */
function onlineHost(): string {
  return process.env.LOOM_PGVECTOR_HOST || process.env.LOOM_POSTGRES_HOST || '';
}
function onlineDatabase(): string {
  return process.env.LOOM_PGVECTOR_DATABASE || 'postgres';
}

/**
 * Honest config gate for the OFFLINE (author + PIT) path. Returns null when the
 * offline backend is addressable, or a structured gate (backend + missing var +
 * Fix-it target) when it isn't. The editor renders this as a Fluent MessageBar
 * with an inline "Fix it" button (svc-feature-store).
 */
export function featureStoreConfigGate(): FeatureStoreGate | null {
  const backend = resolveFeatureStoreBackend();
  if (backend === 'databricks') {
    const g = databricksConfigGate();
    if (!g) return null;
    return {
      backend,
      missing: g.missing,
      hint:
        'Feature Store is using the Databricks (Unity Catalog) offline backend but the workspace is ' +
        'not configured. Set LOOM_DATABRICKS_HOSTNAME (the workspace hostname, no scheme), or set ' +
        'LOOM_FEATURE_STORE_BACKEND=postgres to author feature tables on Azure Database for PostgreSQL ' +
        '(the sovereign / Gov path). No Microsoft Fabric required.',
      fixEnvVar: 'LOOM_DATABRICKS_HOSTNAME',
      gateId: GATE_ID,
    };
  }
  // postgres offline
  if (!onlineHost()) {
    return {
      backend,
      missing: 'LOOM_PGVECTOR_HOST (or LOOM_POSTGRES_HOST)',
      hint:
        'Feature Store is using the Azure Database for PostgreSQL (sovereign / OSS-UC) backend but no ' +
        'server is set. Set LOOM_PGVECTOR_HOST (or LOOM_POSTGRES_HOST) to the flexible-server FQDN and ' +
        'LOOM_POSTGRES_AAD_USER to the Entra principal the Console UAMI is registered under. No Fabric.',
      fixEnvVar: 'LOOM_PGVECTOR_HOST',
      gateId: GATE_ID,
    };
  }
  const aad = postgresQueryGate();
  if (aad) return { backend, missing: aad.missing, hint: aad.detail, fixEnvVar: aad.missing, gateId: GATE_ID };
  return null;
}

/**
 * Honest config gate for the ONLINE (Lakebase/pgvector) serving path — required
 * to publish an online table and to look up features at inference, regardless of
 * the offline backend. Returns null when Postgres is addressable.
 */
export function onlineStoreGate(): FeatureStoreGate | null {
  if (!onlineHost()) {
    return {
      backend: 'postgres',
      missing: 'LOOM_PGVECTOR_HOST',
      hint:
        'Online feature serving uses Lakebase / Azure Database for PostgreSQL. Set LOOM_PGVECTOR_HOST ' +
        '(or LOOM_POSTGRES_HOST) to the flexible-server FQDN, optionally LOOM_PGVECTOR_DATABASE (default ' +
        '"postgres"), and LOOM_POSTGRES_AAD_USER to the Console UAMI PG principal. AAD token auth — no password.',
      fixEnvVar: 'LOOM_PGVECTOR_HOST',
      gateId: GATE_ID,
    };
  }
  const aad = postgresQueryGate();
  if (aad) return { backend: 'postgres', missing: aad.missing, hint: aad.detail, fixEnvVar: aad.missing, gateId: GATE_ID };
  return null;
}

// ── identifier + type safety (injection-safe builders) ───────────────────────

export class FeatureStoreError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FeatureStoreError';
    this.status = status;
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a single identifier (column / unqualified table). */
function assertIdent(name: string, what = 'identifier'): string {
  const n = (name || '').trim();
  if (!IDENT_RE.test(n)) {
    throw new FeatureStoreError(`Invalid ${what} "${name}". Use letters, digits and underscores; must start with a letter or underscore.`);
  }
  return n;
}

/** Validate a 1–3 part table full name (catalog.schema.table). */
function assertFullName(name: string): string[] {
  const parts = (name || '').trim().split('.');
  if (parts.length < 1 || parts.length > 3) {
    throw new FeatureStoreError(`Invalid table name "${name}". Use table, schema.table, or catalog.schema.table.`);
  }
  return parts.map((p) => assertIdent(p, 'table-name part'));
}

/** Engine-aware quote of a full name's parts. */
function quoteFull(name: string, engine: FeatureStoreBackend): string {
  const q = engine === 'postgres' ? '"' : '`';
  return assertFullName(name).map((p) => `${q}${p}${q}`).join('.');
}

/** Engine-aware quote of a single identifier. */
function quoteIdent(name: string, engine: FeatureStoreBackend): string {
  const q = engine === 'postgres' ? '"' : '`';
  return `${q}${assertIdent(name)}${q}`;
}

/** Map a logical feature type to a Postgres column type (online store). */
export function pgTypeFor(dataType: string): string {
  switch ((dataType || '').trim().toUpperCase()) {
    case 'DOUBLE':
    case 'FLOAT':
    case 'REAL':
      return 'double precision';
    case 'BIGINT':
    case 'LONG':
      return 'bigint';
    case 'INT':
    case 'INTEGER':
      return 'integer';
    case 'BOOLEAN':
    case 'BOOL':
      return 'boolean';
    case 'TIMESTAMP':
      return 'timestamptz';
    case 'DATE':
      return 'date';
    default:
      return 'text';
  }
}

/** Map a logical feature type to a Spark/Delta column type (offline databricks). */
export function sparkTypeFor(dataType: string): string {
  const t = (dataType || '').trim().toUpperCase();
  const allow = new Set(['DOUBLE', 'FLOAT', 'BIGINT', 'LONG', 'INT', 'INTEGER', 'BOOLEAN', 'STRING', 'TIMESTAMP', 'DATE']);
  if (t === 'LONG') return 'BIGINT';
  if (t === 'INTEGER') return 'INT';
  return allow.has(t) ? t : 'STRING';
}

// ── spec validation ──────────────────────────────────────────────────────────

/** Validate a feature-table spec end-to-end. Returns the first problem, or null. */
export function validateFeatureTableSpec(spec: Partial<FeatureTableSpec>): string | null {
  if (!spec.fullName || !String(spec.fullName).trim()) return 'A feature table name (catalog.schema.table) is required.';
  try { assertFullName(spec.fullName); } catch (e: any) { return e?.message || 'Invalid table name.'; }
  if (!Array.isArray(spec.primaryKeys) || spec.primaryKeys.length === 0) return 'At least one entity (primary) key column is required.';
  for (const k of spec.primaryKeys) { try { assertIdent(k, 'primary key'); } catch (e: any) { return e?.message; } }
  if (!spec.timestampKey || !String(spec.timestampKey).trim()) return 'A timestamp (event-time) key column is required for point-in-time joins.';
  try { assertIdent(spec.timestampKey, 'timestamp key'); } catch (e: any) { return e?.message; }
  if (!Array.isArray(spec.features) || spec.features.length === 0) return 'At least one feature column is required.';
  const seen = new Set<string>([...spec.primaryKeys.map((s) => s.toLowerCase()), spec.timestampKey.toLowerCase()]);
  for (const f of spec.features) {
    if (!f?.name) return 'Every feature needs a name.';
    try { assertIdent(f.name, 'feature'); } catch (e: any) { return e?.message; }
    if (seen.has(f.name.toLowerCase())) return `Column "${f.name}" is used more than once (a feature cannot also be a key/timestamp).`;
    seen.add(f.name.toLowerCase());
  }
  return null;
}

/** Default online-table name from an offline full name (last part, sanitised). */
export function defaultOnlineTable(fullName: string): string {
  const parts = assertFullName(fullName);
  return `loom_online_${parts.join('_')}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 120);
}

// ── pure SQL builders ────────────────────────────────────────────────────────

/**
 * Build the offline feature-table CREATE DDL (idempotent). Real Spark/Delta DDL
 * (databricks) or Postgres DDL (postgres). Columns = primary keys (STRING/text) +
 * timestamp (TIMESTAMP) + feature columns (typed).
 */
export function buildFeatureTableDdl(spec: FeatureTableSpec, engine: FeatureStoreBackend): string {
  const v = validateFeatureTableSpec(spec);
  if (v) throw new FeatureStoreError(v);
  const cols: string[] = [];
  const tsType = engine === 'postgres' ? 'timestamptz' : 'TIMESTAMP';
  const keyType = engine === 'postgres' ? 'text' : 'STRING';
  for (const k of spec.primaryKeys) cols.push(`${quoteIdent(k, engine)} ${keyType}`);
  cols.push(`${quoteIdent(spec.timestampKey, engine)} ${tsType}`);
  for (const f of spec.features) {
    const t = engine === 'postgres' ? pgTypeFor(f.dataType) : sparkTypeFor(f.dataType);
    cols.push(`${quoteIdent(f.name, engine)} ${t}`);
  }
  const using = engine === 'databricks' ? ' USING DELTA' : '';
  return `CREATE TABLE IF NOT EXISTS ${quoteFull(spec.fullName, engine)} (\n  ${cols.join(',\n  ')}\n)${using}`;
}

/**
 * Build the point-in-time (AS-OF) join SQL: for each spine (label) row, attach
 * the LATEST feature row whose feature timestamp <= the spine timestamp, matched
 * on the entity keys. A LEFT JOIN LATERAL correlated subquery — supported on both
 * Databricks SQL and PostgreSQL. Injection-safe: every identifier is validated +
 * quoted; no user value is spliced.
 */
export function buildPitJoinSql(spine: PitSpineSpec, feature: FeatureTableSpec, engine: FeatureStoreBackend): string {
  const fv = validateFeatureTableSpec(feature);
  if (fv) throw new FeatureStoreError(fv);
  if (!spine?.fullName) throw new FeatureStoreError('A spine (training-set) table is required.');
  if (!Array.isArray(spine.entityKeys) || spine.entityKeys.length !== feature.primaryKeys.length) {
    throw new FeatureStoreError(`The spine must map exactly ${feature.primaryKeys.length} entity key column(s) to the feature table's primary keys.`);
  }
  if (!spine.timestampKey) throw new FeatureStoreError('The spine event-time (timestamp) column is required.');

  const S = 's';
  const F = 'f';
  const spineFull = quoteFull(spine.fullName, engine);
  const featFull = quoteFull(feature.fullName, engine);

  const featureSelect = feature.features
    .map((f) => `${F}.${quoteIdent(f.name, engine)}`)
    .join(', ');

  const keyPredicates = feature.primaryKeys
    .map((pk, i) => `${F}.${quoteIdent(pk, engine)} = ${S}.${quoteIdent(spine.entityKeys[i], engine)}`)
    .join(' AND ');

  const carry = (spine.carryColumns || []).map((c) => `${S}.${quoteIdent(c, engine)}`);
  const spineCols = [
    ...spine.entityKeys.map((k) => `${S}.${quoteIdent(k, engine)}`),
    `${S}.${quoteIdent(spine.timestampKey, engine)}`,
    ...carry,
  ].join(', ');

  const limit = Math.max(1, Math.min(Math.floor(spine.limit || 1000), 10000));

  return (
    `SELECT ${spineCols}, ${featureSelect}\n` +
    `FROM ${spineFull} ${S}\n` +
    `LEFT JOIN LATERAL (\n` +
    `  SELECT ${feature.features.map((f) => quoteIdent(f.name, engine)).join(', ')}\n` +
    `  FROM ${featFull} ${F}\n` +
    `  WHERE ${keyPredicates}\n` +
    `    AND ${F}.${quoteIdent(feature.timestampKey, engine)} <= ${S}.${quoteIdent(spine.timestampKey, engine)}\n` +
    `  ORDER BY ${F}.${quoteIdent(feature.timestampKey, engine)} DESC\n` +
    `  LIMIT 1\n` +
    `) ${F} ON TRUE\n` +
    `LIMIT ${limit}`
  );
}

/** Build the online (Postgres) serving-table CREATE DDL (idempotent). */
export function buildOnlineTableDdl(spec: FeatureTableSpec): string {
  const v = validateFeatureTableSpec(spec);
  if (v) throw new FeatureStoreError(v);
  const online = spec.onlineTable || defaultOnlineTable(spec.fullName);
  const cols: string[] = [];
  for (const k of spec.primaryKeys) cols.push(`${quoteIdent(k, 'postgres')} text NOT NULL`);
  for (const f of spec.features) cols.push(`${quoteIdent(f.name, 'postgres')} ${pgTypeFor(f.dataType)}`);
  cols.push(`"_feature_ts" timestamptz`);
  const pk = spec.primaryKeys.map((k) => quoteIdent(k, 'postgres')).join(', ');
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(online, 'postgres')} (\n  ${cols.join(',\n  ')},\n  PRIMARY KEY (${pk})\n)`;
}

/**
 * Build the "collapse to latest feature row per entity" SQL over the offline
 * table — the source for materialising the online store. Window + ROW_NUMBER,
 * supported on both engines.
 */
export function buildLatestOfflineSql(spec: FeatureTableSpec, engine: FeatureStoreBackend, limit = 100000): string {
  const v = validateFeatureTableSpec(spec);
  if (v) throw new FeatureStoreError(v);
  const proj = [
    ...spec.primaryKeys.map((k) => quoteIdent(k, engine)),
    ...spec.features.map((f) => quoteIdent(f.name, engine)),
    `${quoteIdent(spec.timestampKey, engine)} AS ${quoteIdent('_feature_ts', engine)}`,
  ].join(', ');
  const part = spec.primaryKeys.map((k) => quoteIdent(k, engine)).join(', ');
  const n = Math.max(1, Math.min(Math.floor(limit), 500000));
  return (
    `SELECT ${proj} FROM (\n` +
    `  SELECT *, ROW_NUMBER() OVER (PARTITION BY ${part} ORDER BY ${quoteIdent(spec.timestampKey, engine)} DESC) AS ${quoteIdent('_loom_rn', engine)}\n` +
    `  FROM ${quoteFull(spec.fullName, engine)}\n` +
    `) t WHERE ${quoteIdent('_loom_rn', engine)} = 1\n` +
    `LIMIT ${n}`
  );
}

/**
 * Build the online feature-lookup SELECT for a single entity — the read at
 * inference. Returns { sql, params } with the entity key values bound as $1..$n
 * (never spliced).
 */
export function buildOnlineLookupSql(spec: FeatureTableSpec, pkValues: Record<string, unknown>): { sql: string; params: unknown[] } {
  const v = validateFeatureTableSpec(spec);
  if (v) throw new FeatureStoreError(v);
  const online = spec.onlineTable || defaultOnlineTable(spec.fullName);
  const featCols = spec.features.map((f) => quoteIdent(f.name, 'postgres')).join(', ');
  const params: unknown[] = [];
  const where = spec.primaryKeys.map((k, i) => {
    const val = pkValues[k];
    if (val === undefined || val === null || String(val).trim() === '') {
      throw new FeatureStoreError(`Missing value for entity key "${k}".`);
    }
    params.push(String(val));
    return `${quoteIdent(k, 'postgres')} = $${i + 1}`;
  }).join(' AND ');
  return { sql: `SELECT ${featCols} FROM ${quoteIdent(online, 'postgres')} WHERE ${where} LIMIT 1`, params };
}

/**
 * Merge a resolved feature map into a scoring payload before it is sent to a
 * model-serving endpoint (the feature-lookup-at-serving wire-in to WS-1.2).
 * Handles the three common serving payload shapes:
 *   - { dataframe_records: [ {...} ] }             → merge into each record
 *   - { input_data: { columns:[], data:[[...]] } } → append feature columns/values
 *   - a plain object                                → shallow-merge at top level
 * Pure + deterministic (unit-tested); never mutates the input.
 */
export function mergeFeaturesIntoPayload(payload: unknown, features: Record<string, unknown>): unknown {
  const feats = features || {};
  const keys = Object.keys(feats);
  if (keys.length === 0) return payload;

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    // Databricks Mosaic tabular convention.
    if (Array.isArray(obj.dataframe_records)) {
      return { ...obj, dataframe_records: (obj.dataframe_records as any[]).map((r) => ({ ...feats, ...r })) };
    }
    // AML / MLflow split-orient convention.
    const inp = obj.input_data as any;
    if (inp && Array.isArray(inp.columns) && Array.isArray(inp.data)) {
      const columns = [...inp.columns, ...keys];
      const data = (inp.data as any[]).map((row: any[]) => [...row, ...keys.map((k) => feats[k])]);
      return { ...obj, input_data: { ...inp, columns, data } };
    }
    // Bare object → shallow-merge (features do not override caller-supplied keys).
    return { ...feats, ...obj };
  }
  return payload;
}

// ── real offline execution ───────────────────────────────────────────────────

export interface OfflineQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  /** The backend that ran the query. */
  backend: FeatureStoreBackend;
}

/** Resolve a usable Databricks SQL warehouse id (RUNNING preferred). */
async function resolveWarehouseId(): Promise<string> {
  const whs = await listWarehouses();
  const wh = whs.find((w: any) => w.state === 'RUNNING') || whs[0];
  if (!wh?.id) {
    throw new FeatureStoreError(
      'Databricks is configured but the workspace has no SQL Warehouse to run the feature-store SQL. ' +
      'Create a SQL Warehouse (Compute → SQL Warehouses) and retry.',
      503,
    );
  }
  return wh.id;
}

/** Run read/DDL SQL against the active OFFLINE engine and normalise the result. */
export async function runOfflineSql(sql: string, backend = resolveFeatureStoreBackend()): Promise<OfflineQueryResult> {
  if (backend === 'databricks') {
    const whId = await resolveWarehouseId();
    const r = await executeStatement(whId, sql);
    return { columns: r.columns, rows: r.rows, rowCount: r.rowCount, executionMs: r.executionMs, backend };
  }
  const r = await executePostgresQuery(onlineHost(), onlineDatabase(), sql);
  return { columns: r.columns, rows: r.rows, rowCount: r.rowCount, executionMs: r.executionMs, backend };
}

// ── real ops ─────────────────────────────────────────────────────────────────

/**
 * Create (idempotently) the offline feature table AND the online serving table.
 * Real DDL on both engines. Returns the normalised spec (with resolved
 * onlineTable + offlineBackend).
 */
export async function createFeatureTable(spec: FeatureTableSpec): Promise<FeatureTableSpec> {
  const v = validateFeatureTableSpec(spec);
  if (v) throw new FeatureStoreError(v);
  const backend = spec.offlineBackend || resolveFeatureStoreBackend();
  const resolved: FeatureTableSpec = {
    ...spec,
    offlineBackend: backend,
    onlineTable: spec.onlineTable || defaultOnlineTable(spec.fullName),
  };
  // 1) offline table (Delta or Postgres).
  await runOfflineSql(buildFeatureTableDdl(resolved, backend), backend);
  // 2) online serving table (always Postgres) — best-effort; surfaces gate if unset.
  const og = onlineStoreGate();
  if (!og) {
    await executePostgresBatch(onlineHost(), onlineDatabase(), [{ sql: buildOnlineTableDdl(resolved) }]);
  }
  return resolved;
}

/** Run a point-in-time join of a spine onto a feature table; returns real rows. */
export async function runPitJoin(
  spine: PitSpineSpec,
  feature: FeatureTableSpec,
): Promise<OfflineQueryResult & { sql: string }> {
  const backend = feature.offlineBackend || resolveFeatureStoreBackend();
  const sql = buildPitJoinSql(spine, feature, backend);
  const res = await runOfflineSql(sql, backend);
  return { ...res, sql };
}

export interface PublishResult {
  published: number;
  onlineTable: string;
  executionMs: number;
}

/**
 * Materialise the latest features per entity from the offline table into the
 * online (Postgres) serving table — real read (offline engine) + real upsert
 * (pg wire protocol, INSERT … ON CONFLICT). Idempotent.
 */
export async function publishOnline(spec: FeatureTableSpec): Promise<PublishResult> {
  const og = onlineStoreGate();
  if (og) throw new FeatureStoreError(og.hint, 503);
  const backend = spec.offlineBackend || resolveFeatureStoreBackend();
  const online = spec.onlineTable || defaultOnlineTable(spec.fullName);
  const started = Date.now();

  // 1) ensure the online table exists.
  await executePostgresBatch(onlineHost(), onlineDatabase(), [{ sql: buildOnlineTableDdl(spec) }]);

  // 2) read the latest feature row per entity from the offline store.
  const latest = await runOfflineSql(buildLatestOfflineSql(spec, backend), backend);
  if (latest.rows.length === 0) return { published: 0, onlineTable: online, executionMs: Date.now() - started };

  // 3) upsert each row (extended protocol — values bound, never spliced).
  const targetCols = [...spec.primaryKeys, ...spec.features.map((f) => f.name), '_feature_ts'];
  const colIndex = (name: string) => latest.columns.indexOf(name);
  const insertCols = targetCols.map((c) => quoteIdent(c, 'postgres')).join(', ');
  const conflictSet = [...spec.features.map((f) => f.name), '_feature_ts']
    .map((c) => `${quoteIdent(c, 'postgres')} = EXCLUDED.${quoteIdent(c, 'postgres')}`)
    .join(', ');
  const pk = spec.primaryKeys.map((k) => quoteIdent(k, 'postgres')).join(', ');

  const stmts = latest.rows.map((row) => {
    const params = targetCols.map((c) => {
      const idx = colIndex(c);
      const val = idx >= 0 ? row[idx] : null;
      // Entity keys are stored as text for a stable lookup key.
      if (spec.primaryKeys.includes(c)) return val == null ? '' : String(val);
      return val ?? null;
    });
    const placeholders = targetCols.map((_c, i) => `$${i + 1}`).join(', ');
    return {
      sql: `INSERT INTO ${quoteIdent(online, 'postgres')} (${insertCols}) VALUES (${placeholders}) ON CONFLICT (${pk}) DO UPDATE SET ${conflictSet}`,
      params,
    };
  });
  await executePostgresBatch(onlineHost(), onlineDatabase(), stmts);
  return { published: stmts.length, onlineTable: online, executionMs: Date.now() - started };
}

export interface OnlineLookupResult {
  found: boolean;
  features: Record<string, unknown>;
  onlineTable: string;
  executionMs: number;
}

/** Look up the online feature values for a single entity (the read at inference). */
export async function lookupOnlineFeatures(
  spec: FeatureTableSpec,
  pkValues: Record<string, unknown>,
): Promise<OnlineLookupResult> {
  const og = onlineStoreGate();
  if (og) throw new FeatureStoreError(og.hint, 503);
  const online = spec.onlineTable || defaultOnlineTable(spec.fullName);
  const { sql, params } = buildOnlineLookupSql(spec, pkValues);
  const started = Date.now();
  const res = await executePostgresBatch(onlineHost(), onlineDatabase(), [{ sql, params }]);
  const r0 = res[0];
  const cols = r0?.columns || [];
  const row = (r0?.rows || [])[0];
  const features: Record<string, unknown> = {};
  if (row) cols.forEach((c, i) => { features[c] = row[i]; });
  return { found: !!row, features, onlineTable: online, executionMs: Date.now() - started };
}

/** Drop the offline + online tables for a feature table (best-effort cleanup). */
export async function dropFeatureTable(spec: FeatureTableSpec): Promise<void> {
  const backend = spec.offlineBackend || resolveFeatureStoreBackend();
  const online = spec.onlineTable || defaultOnlineTable(spec.fullName);
  try { await runOfflineSql(`DROP TABLE IF EXISTS ${quoteFull(spec.fullName, backend)}`, backend); } catch { /* best-effort */ }
  if (!onlineStoreGate()) {
    try { await executePostgresBatch(onlineHost(), onlineDatabase(), [{ sql: `DROP TABLE IF EXISTS ${quoteIdent(online, 'postgres')}` }]); } catch { /* best-effort */ }
  }
}

/** Re-export so routes can branch on the driver error without importing pg. */
export { PostgresError };
