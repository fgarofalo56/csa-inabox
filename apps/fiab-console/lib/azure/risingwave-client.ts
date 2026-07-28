/**
 * N7a — loom-risingwave streaming-SQL tier client. SERVER-ONLY (imports the
 * Cosmos audit trail + the `pg` wire driver).
 *
 * ## The tier
 *
 * `apps/loom-risingwave` is an internal-ingress Container App running a single-
 * node **RisingWave** (Apache-2.0) — the STATEFUL streaming engine ABOVE Azure
 * Stream Analytics. It authors streaming **materialized views** in SQL over
 * **Azure Event Hubs** (consumed through the namespace's Kafka-protocol endpoint
 * on port 9093 — the host is resolved per-cloud, never hardcoded) and sinks the continuously-
 * maintained results to **Delta / Iceberg** on the deployment's own ADLS Gen2
 * (the N1 lake) or serves them over the **Postgres wire**.
 *
 * RisingWave speaks the PostgreSQL wire protocol on its frontend port (4566), so
 * this client talks to it with the same `pg` driver the Lakebase / Weave paths
 * use — NOT an HTTP API. `LOOM_RISINGWAVE_URL` is the internal FQDN (optionally
 * `host:port`). The container has INTERNAL ingress; the Console BFF is the sole
 * door and every statement flows through the audited /api/streaming-sql/* routes.
 *
 * ## Honest gate (no-vaporware)
 *
 * When `LOOM_RISINGWAVE_URL` is unset {@link risingwaveConfigGate} returns the
 * missing var and every route 503s with the normalized gate envelope. The
 * `streaming-sql` EDITOR still renders fully (guided empty state) — the stateful
 * tier is an opt-in ACCELERATOR (~$150-300/mo/cloud), never a blocker. Azure
 * Stream Analytics remains the light default for simple jobs; this is the
 * stateful tier for windowed joins / incremental aggregations ASA can't express.
 *
 * ## Audited data plane (ATO)
 *
 * A streaming DDL (CREATE MATERIALIZED VIEW / SOURCE / SINK, DROP) is a
 * privileged mutation and a query is a data-access event, so
 * {@link logStreamingSqlAccess} writes an `_auditLog` row and fans out through
 * `emitAuditEvent`. Mutations emit the event FIRST, synchronously, before the
 * awaited Cosmos write (AUDIT convention).
 *
 * IL5 / SOVEREIGN MOAT: RisingWave is a self-contained Rust binary with no
 * external control plane; it reaches ONLY the in-VNet Event Hubs Kafka endpoint
 * and the in-boundary ADLS Gen2. No Microsoft Fabric / OneLake / Power BI, no
 * SaaS streaming service is in the path (.claude/rules/no-fabric-dependency.md),
 * so the whole tier runs disconnected in an air-gapped enclave.
 */

import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { dfsSuffix, serviceBusSuffix } from '@/lib/azure/cloud-endpoints';
import { quoteIdent, quoteLiteral } from '@/lib/sql/quoting';

/** Registry gate id — mirrors the ENV_CHECKS spec in env-checks/data-plane.ts. */
export const RISINGWAVE_GATE_ID = 'svc-loom-risingwave';

/** RisingWave's default frontend Postgres-wire port. */
export const RISINGWAVE_DEFAULT_PORT = 4566;

/** Honest config signal — the missing env var, or null when the tier is wired. */
export function risingwaveConfigGate(): { missing: string } | null {
  return (process.env.LOOM_RISINGWAVE_URL || '').trim() ? null : { missing: 'LOOM_RISINGWAVE_URL' };
}

/** True when the RisingWave streaming tier is deployed + wired. */
export function isRisingWaveConfigured(): boolean {
  return risingwaveConfigGate() === null;
}

export class RisingWaveError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'RisingWaveError';
    this.status = status;
    this.code = code;
  }
}

/** Parsed connection coordinates for the RisingWave frontend. */
export interface RisingWaveTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Optional password (KV secret). RisingWave single-node default has none. */
  password?: string;
}

/**
 * Resolve the RisingWave connection from env. `LOOM_RISINGWAVE_URL` accepts a
 * bare host, `host:port`, or a `postgres://user@host:port/db` URL. Database /
 * user default to RisingWave's single-node defaults (`dev` / `root`); a password
 * is used only when `LOOM_RISINGWAVE_PASSWORD` is set (in-VNet trust otherwise).
 * Throws the honest 503 when the URL is unset.
 */
export function resolveRisingWaveTarget(): RisingWaveTarget {
  const raw = (process.env.LOOM_RISINGWAVE_URL || '').trim();
  if (!raw) {
    throw new RisingWaveError(
      'The RisingWave streaming tier is not deployed in this environment. Set LOOM_RISINGWAVE_URL to the '
      + 'internal-ingress FQDN of the loom-risingwave Container App (deploy '
      + 'platform/fiab/bicep/modules/data-plane/loom-risingwave-aca.bicep).',
      503,
      'not_configured',
    );
  }

  let host = raw;
  let port = RISINGWAVE_DEFAULT_PORT;
  let database = (process.env.LOOM_RISINGWAVE_DATABASE || 'dev').trim() || 'dev';
  let user = (process.env.LOOM_RISINGWAVE_USER || 'root').trim() || 'root';

  if (/^[a-z]+:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      host = u.hostname;
      if (u.port) port = Number(u.port);
      if (u.username) user = decodeURIComponent(u.username);
      const db = u.pathname.replace(/^\/+/, '').trim();
      if (db) database = db;
    } catch {
      throw new RisingWaveError(`LOOM_RISINGWAVE_URL is not a valid URL: ${raw}`, 503, 'not_configured');
    }
  } else {
    const stripped = raw.replace(/^\/+|\/+$/g, '');
    const lastColon = stripped.lastIndexOf(':');
    if (lastColon > 0 && /^\d+$/.test(stripped.slice(lastColon + 1))) {
      host = stripped.slice(0, lastColon);
      port = Number(stripped.slice(lastColon + 1));
    } else {
      host = stripped;
    }
  }

  if (!host) throw new RisingWaveError(`LOOM_RISINGWAVE_URL resolved to an empty host: ${raw}`, 503, 'not_configured');
  const password = (process.env.LOOM_RISINGWAVE_PASSWORD || '').trim() || undefined;
  return { host, port: Number.isFinite(port) && port > 0 ? port : RISINGWAVE_DEFAULT_PORT, database, user, password };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only guard (mirrors the DuckDB tier's posture on the query path)
// ─────────────────────────────────────────────────────────────────────────────

/** Statement verbs allowed on the read-only /query path. */
const READ_ONLY_LEADING = /^(WITH|SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|VALUES)\b/i;

/**
 * Assert a statement is read-only (the query path never mutates). Strips leading
 * line comments, rejects multi-statement scripts, and admits only the read verbs
 * above. Returns the trimmed statement. Throws {@link RisingWaveError} (400).
 */
export function assertReadOnlyStreamingSql(sql: string): string {
  const trimmed = String(sql || '')
    .replace(/^\s*(--[^\n]*\n\s*)+/, '')
    .trim()
    .replace(/;\s*$/, '');
  if (!trimmed) throw new RisingWaveError('A SQL statement is required.', 400, 'empty');
  if (/;/.test(trimmed)) {
    throw new RisingWaveError('Only a single statement may be run on the query path.', 400, 'multi_statement');
  }
  if (!READ_ONLY_LEADING.test(trimmed)) {
    throw new RisingWaveError(
      'The query path is read-only — use SELECT / SHOW / DESCRIBE / EXPLAIN. Author a materialized view, '
      + 'source or sink through the Materialize action instead.',
      400,
      'read_only',
    );
  }
  return trimmed;
}

/** DDL the Materialize path accepts (streaming objects only, no arbitrary DDL). */
const STREAMING_DDL_LEADING =
  /^(CREATE\s+(MATERIALIZED\s+VIEW|SOURCE|TABLE|SINK|VIEW)|DROP\s+(MATERIALIZED\s+VIEW|SOURCE|TABLE|SINK|VIEW))\b/i;

/**
 * Assert a statement is a streaming-DDL the tier authors (CREATE/DROP of a
 * materialized view / source / table / sink / view). Rejects anything else so a
 * mutation route cannot become an arbitrary SQL escape hatch.
 */
export function assertStreamingDdl(sql: string): string {
  const trimmed = String(sql || '')
    .replace(/^\s*(--[^\n]*\n\s*)+/, '')
    .trim()
    .replace(/;\s*$/, '');
  if (!trimmed) throw new RisingWaveError('A DDL statement is required.', 400, 'empty');
  if (!STREAMING_DDL_LEADING.test(trimmed)) {
    throw new RisingWaveError(
      'The Materialize path accepts only CREATE/DROP of a MATERIALIZED VIEW, SOURCE, TABLE or SINK.',
      400,
      'not_streaming_ddl',
    );
  }
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution over the `pg` wire protocol
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamingSqlColumn {
  name: string;
  type?: string;
}

export interface StreamingSqlResult {
  columns: StreamingSqlColumn[];
  rows: unknown[][];
  rowCount: number;
  command?: string;
  elapsedMs: number;
}

async function connect(target: RisingWaveTarget, statementTimeoutMs: number) {
  // Lazy import so the driver only loads on this path (Node runtime only). The
  // internal-ingress hop is raw TCP inside the VNet (ACA TCP ingress does not
  // terminate TLS), so ssl is off — the VNet is the perimeter, identical posture
  // to the sibling internal-ingress OSS services.
  const { Client } = await import('pg');
  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    ...(target.password ? { password: target.password } : {}),
    ssl: false,
    statement_timeout: statementTimeoutMs,
    connectionTimeoutMillis: 20_000,
    application_name: 'csa-loom-console',
  });
  await client.connect();
  return client;
}

function shape(res: any, startedMs: number): StreamingSqlResult {
  const fields = (res as any)?.fields || [];
  const columns: StreamingSqlColumn[] = fields.map((f: any) => ({ name: f.name }));
  const rows: unknown[][] = ((res as any)?.rows || []).map((r: any) => columns.map((c) => r[c.name]));
  return {
    columns,
    rows,
    rowCount: typeof res?.rowCount === 'number' ? res.rowCount : rows.length,
    command: res?.command,
    elapsedMs: Date.now() - startedMs,
  };
}

/**
 * Run a read-only statement on the RisingWave frontend and return the REAL
 * result. Applies an outer LIMIT so a caller LIMIT larger than the cap is still
 * capped (a smaller one still wins). Throws {@link RisingWaveError}.
 */
export async function runStreamingQuery(sql: string, opts: { maxRows?: number } = {}): Promise<StreamingSqlResult> {
  const statement = assertReadOnlyStreamingSql(sql);
  const cap = Math.max(1, Math.min(Math.floor(opts.maxRows ?? 5_000), 200_000));
  const target = resolveRisingWaveTarget();
  const started = Date.now();
  let client: Awaited<ReturnType<typeof connect>> | null = null;
  try {
    client = await connect(target, 60_000);
    // SHOW/DESCRIBE/EXPLAIN cannot be wrapped in a subquery; run those directly.
    const wrappable = /^(WITH|SELECT|VALUES)\b/i.test(statement);
    const text = wrappable ? `SELECT * FROM (${statement}) AS loom_q LIMIT ${cap}` : statement;
    const res: any = await client.query(text);
    return shape(res, started);
  } catch (e: any) {
    throw new RisingWaveError(
      e?.message || String(e),
      e?.code === '28000' || e?.code === '28P01' ? 401 : 502,
      e?.code,
    );
  } finally {
    if (client) await client.end().catch(() => { /* already closed */ });
  }
}

/**
 * Execute one streaming-DDL statement (CREATE/DROP materialized view / source /
 * sink) on the RisingWave frontend. Throws {@link RisingWaveError}.
 */
export async function executeStreamingDdl(sql: string): Promise<StreamingSqlResult> {
  const statement = assertStreamingDdl(sql);
  const target = resolveRisingWaveTarget();
  const started = Date.now();
  let client: Awaited<ReturnType<typeof connect>> | null = null;
  try {
    client = await connect(target, 120_000);
    const res: any = await client.query(statement);
    return shape(res, started);
  } catch (e: any) {
    throw new RisingWaveError(
      e?.message || String(e),
      e?.code === '28000' || e?.code === '28P01' ? 401 : 502,
      e?.code,
    );
  } finally {
    if (client) await client.end().catch(() => { /* already closed */ });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Materialized-view status (real rw_catalog reads)
// ─────────────────────────────────────────────────────────────────────────────

/** One streaming materialized view + its live status. */
export interface StreamingMvStatus {
  name: string;
  schema: string;
  /** The MV's SQL definition (from rw_catalog.rw_materialized_views). */
  definition?: string;
  /** Backfill / creation progress (from rw_catalog.rw_ddl_progress) while building. */
  progress?: string;
  /** Current materialized row count (best-effort real COUNT, capped). */
  rowCount?: number;
}

export interface StreamingStatus {
  engine: 'risingwave';
  /** RisingWave version reported by `SELECT version()`. */
  version?: string;
  materializedViews: StreamingMvStatus[];
  sourceCount: number;
  sinkCount: number;
}

/**
 * Read the live streaming status off RisingWave's own catalog. Every field is a
 * REAL query against the `rw_catalog` system schema — no fabricated metrics:
 *   - rw_materialized_views → the MV list + definitions
 *   - rw_ddl_progress       → in-flight backfill progress per creating object
 *   - rw_sources / rw_sinks → connected source / sink counts
 * Per-MV row counts are a best-effort `SELECT count(*)` (capped), skipped on error.
 */
export async function readStreamingStatus(): Promise<StreamingStatus> {
  const target = resolveRisingWaveTarget();
  let client: Awaited<ReturnType<typeof connect>> | null = null;
  try {
    client = await connect(target, 30_000);

    let version: string | undefined;
    try {
      const v: any = await client.query('SELECT version() AS v');
      version = v?.rows?.[0]?.v;
    } catch { /* version is decorative */ }

    const mvRes: any = await client.query(
      'SELECT name, schema_name, definition FROM rw_catalog.rw_materialized_views ORDER BY name',
    );
    const progressRes: any = await client.query(
      'SELECT ddl_desc, progress FROM rw_catalog.rw_ddl_progress',
    ).catch(() => ({ rows: [] }));
    const progressByName = new Map<string, string>();
    for (const r of progressRes.rows || []) {
      const desc = String(r.ddl_desc || '');
      const m = /MATERIALIZED VIEW\s+(?:[\w."]+\.)?"?(\w+)"?/i.exec(desc);
      if (m) progressByName.set(m[1], String(r.progress ?? ''));
    }

    const materializedViews: StreamingMvStatus[] = [];
    for (const r of mvRes.rows || []) {
      const name = String(r.name);
      const schema = String(r.schema_name || 'public');
      let rowCount: number | undefined;
      try {
        const c: any = await client.query(
          `SELECT count(*)::bigint AS n FROM (SELECT 1 FROM ${quoteIdent(schema, 'postgres')}.${quoteIdent(name, 'postgres')} LIMIT 1000000) AS loom_c`,
        );
        rowCount = Number(c?.rows?.[0]?.n ?? 0);
      } catch { /* a still-building MV may not be queryable yet */ }
      materializedViews.push({
        name,
        schema,
        definition: r.definition ? String(r.definition) : undefined,
        progress: progressByName.get(name),
        rowCount,
      });
    }

    const countOf = async (rel: string): Promise<number> => {
      try {
        const res: any = await client!.query(`SELECT count(*)::int AS n FROM rw_catalog.${rel}`);
        return Number(res?.rows?.[0]?.n ?? 0);
      } catch { return 0; }
    };
    const [sourceCount, sinkCount] = await Promise.all([countOf('rw_sources'), countOf('rw_sinks')]);

    return { engine: 'risingwave', version, materializedViews, sourceCount, sinkCount };
  } catch (e: any) {
    throw new RisingWaveError(e?.message || String(e), e?.code === '28000' ? 401 : 502, e?.code);
  } finally {
    if (client) await client.end().catch(() => { /* already closed */ });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure DDL builders (unit-testable, no backend) — the no-freeform-config path:
// the editor's pickers hand these structured specs, never a raw connection blob.
// ─────────────────────────────────────────────────────────────────────────────

/** A valid RisingWave / SQL identifier (letters, digits, underscore; ≤ 63). */
export function assertStreamingIdent(name: string, what = 'identifier'): string {
  const n = String(name ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(n)) {
    throw new RisingWaveError(`"${n}" is not a valid ${what}.`, 400, 'invalid_identifier');
  }
  return n;
}

/** Auth mode for the Event Hubs Kafka source. */
export type EventHubKafkaAuth =
  | { mode: 'sasl'; connectionString: string }
  | { mode: 'none' };

export interface EventHubSourceSpec {
  /** Source object name to CREATE. */
  name: string;
  /** Event Hubs namespace (short name — the `.servicebus…` suffix is appended). */
  namespace: string;
  /** Event Hub (Kafka topic) to consume. */
  eventHub: string;
  /** Column definitions, e.g. [{ name:'id', type:'varchar' }]. */
  columns: Array<{ name: string; type: string }>;
  /** Payload format (default JSON). */
  format?: 'JSON' | 'AVRO' | 'CSV';
  /** SASL connection string (Key-Vault-resolved) or in-VNet trust. */
  auth?: EventHubKafkaAuth;
  /** Consumer group (default $Default). */
  consumerGroup?: string;
}

const SQL_TYPE = /^[A-Za-z][A-Za-z0-9_ ()]*$/;

function assertColumns(columns: Array<{ name: string; type: string }>): string {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new RisingWaveError('At least one column is required.', 400, 'no_columns');
  }
  return columns
    .map((c) => {
      const name = assertStreamingIdent(c.name, 'column name');
      const type = String(c.type ?? '').trim();
      if (!SQL_TYPE.test(type)) throw new RisingWaveError(`"${type}" is not a valid column type.`, 400, 'invalid_type');
      return `  ${quoteIdent(name, 'postgres')} ${type}`;
    })
    .join(',\n');
}

/**
 * Build a `CREATE SOURCE` over an Azure Event Hubs Kafka endpoint. The bootstrap
 * server is `<namespace>.<serviceBusSuffix>:9093`; auth is SASL_SSL + PLAIN with
 * the Event Hubs `$ConnectionString` convention when a connection string is
 * given, else in-VNet trust (a namespace that permits it). Every literal is
 * quoted via the shared sql-quoting helpers — never string-concatenated raw.
 */
export function buildEventHubKafkaSourceSql(spec: EventHubSourceSpec, kafkaSuffix = serviceBusSuffix()): string {
  const name = assertStreamingIdent(spec.name, 'source name');
  const namespace = assertStreamingIdent(spec.namespace, 'namespace');
  const topic = String(spec.eventHub ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(topic)) {
    throw new RisingWaveError(`"${topic}" is not a valid Event Hub name.`, 400, 'invalid_event_hub');
  }
  const cols = assertColumns(spec.columns);
  const bootstrap = `${namespace}.${kafkaSuffix}:9093`;
  const group = (spec.consumerGroup || '$Default').trim() || '$Default';
  const format = spec.format || 'JSON';

  const props: string[] = [
    `  connector = 'kafka'`,
    `  topic = ${quoteLiteral(topic)}`,
    `  properties.bootstrap.server = ${quoteLiteral(bootstrap)}`,
    `  scan.startup.mode = 'latest'`,
    `  group.id.prefix = ${quoteLiteral(group)}`,
  ];
  if (spec.auth && spec.auth.mode === 'sasl') {
    props.push(`  properties.security.protocol = 'SASL_SSL'`);
    props.push(`  properties.sasl.mechanism = 'PLAIN'`);
    props.push(`  properties.sasl.username = '$ConnectionString'`);
    props.push(`  properties.sasl.password = ${quoteLiteral(spec.auth.connectionString)}`);
  }
  return (
    `CREATE SOURCE ${quoteIdent(name, 'postgres')} (\n${cols}\n)\n`
    + `WITH (\n${props.join(',\n')}\n)\n`
    + `FORMAT PLAIN ENCODE ${format};`
  );
}

export interface MaterializedViewSpec {
  /** MV name to CREATE. */
  name: string;
  /** The SELECT body (already-authored SQL over sources / other MVs). */
  selectSql: string;
}

/**
 * Build a `CREATE MATERIALIZED VIEW <name> AS <select>`. The SELECT body is
 * validated to be a single read-only statement (no trailing DDL / injection).
 */
export function buildMaterializedViewSql(spec: MaterializedViewSpec): string {
  const name = assertStreamingIdent(spec.name, 'materialized view name');
  const select = assertReadOnlyStreamingSql(spec.selectSql);
  if (!/^(WITH|SELECT)\b/i.test(select)) {
    throw new RisingWaveError('A materialized view body must be a SELECT (or WITH … SELECT).', 400, 'invalid_mv_body');
  }
  return `CREATE MATERIALIZED VIEW ${quoteIdent(name, 'postgres')} AS\n${select};`;
}

/**
 * Convenience builder for the common case the test exercises: a MV that JOINs
 * two streams. Produces a well-formed `CREATE MATERIALIZED VIEW … AS SELECT …
 * FROM <left> JOIN <right> ON <left>.<lk> = <right>.<rk>`.
 */
export interface TwoStreamJoinSpec {
  name: string;
  left: string;
  right: string;
  leftKey: string;
  rightKey: string;
  /** Selected columns (identifiers, qualified allowed); default `*`. */
  selectColumns?: string[];
}

export function buildTwoStreamJoinMvSql(spec: TwoStreamJoinSpec): string {
  const left = assertStreamingIdent(spec.left, 'left stream');
  const right = assertStreamingIdent(spec.right, 'right stream');
  const lk = assertStreamingIdent(spec.leftKey, 'left key');
  const rk = assertStreamingIdent(spec.rightKey, 'right key');
  const cols = (spec.selectColumns && spec.selectColumns.length)
    ? spec.selectColumns.map((c) => {
        // Allow `stream.col` qualified refs; validate each segment.
        const parts = String(c).split('.').map((p) => assertStreamingIdent(p, 'column'));
        return parts.map((p) => quoteIdent(p, 'postgres')).join('.');
      }).join(', ')
    : '*';
  const select =
    `SELECT ${cols}\n`
    + `FROM ${quoteIdent(left, 'postgres')}\n`
    + `JOIN ${quoteIdent(right, 'postgres')}\n`
    + `  ON ${quoteIdent(left, 'postgres')}.${quoteIdent(lk, 'postgres')} = ${quoteIdent(right, 'postgres')}.${quoteIdent(rk, 'postgres')}`;
  return buildMaterializedViewSql({ name: spec.name, selectSql: select });
}

/** Sink format to the lake. */
export type LakeSinkFormat = 'delta' | 'iceberg';

export interface LakeSinkSpec {
  /** Sink object name to CREATE. */
  name: string;
  /** The MV / source the sink reads FROM. */
  from: string;
  /** delta | iceberg. */
  format: LakeSinkFormat;
  /** Lake container (filesystem) the sink writes into. */
  container: string;
  /** Path within the container. */
  path: string;
  /** ADLS Gen2 account (defaults to LOOM_LAKE_ACCOUNT on the container). */
  account?: string;
}

/**
 * Build a `CREATE SINK` that writes the maintained MV out to Delta / Iceberg on
 * the deployment's own ADLS Gen2. Uses the abfss path shape and the sovereign
 * dfs suffix; storage credentials are supplied at deploy time to the RisingWave
 * container's managed identity, not embedded here.
 */
export function buildLakeSinkSql(spec: LakeSinkSpec, dfs = dfsSuffix()): string {
  const name = assertStreamingIdent(spec.name, 'sink name');
  const from = assertStreamingIdent(spec.from, 'source object');
  const account = assertStreamingIdent(spec.account || process.env.LOOM_LAKE_ACCOUNT || '', 'storage account');
  const container = String(spec.container ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(container)) {
    throw new RisingWaveError(`"${container}" is not a valid storage container name.`, 400, 'invalid_container');
  }
  const path = String(spec.path ?? '').trim().replace(/^\/+/, '');
  if (!path || !/^[A-Za-z0-9._\-/=]+$/.test(path)) {
    throw new RisingWaveError(`"${path}" is not a valid lake path.`, 400, 'invalid_path');
  }
  const location = `abfss://${container}@${account}.${dfs}/${path}`;
  const connector = spec.format === 'iceberg' ? 'iceberg' : 'deltalake';
  const props: string[] = [
    `  connector = ${quoteLiteral(connector)}`,
    `  type = 'append-only'`,
    `  force_append_only = 'true'`,
    `  location = ${quoteLiteral(location)}`,
  ];
  return `CREATE SINK ${quoteIdent(name, 'postgres')}\nFROM ${quoteIdent(from, 'postgres')}\nWITH (\n${props.join(',\n')}\n);`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Hubs Kafka bootstrap resolver (impure — reads the pinned namespace env)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Kafka bootstrap server for the deployment-pinned Event Hubs namespace, or
 * null when no namespace is configured (the source picker then honest-gates the
 * Event Hubs prerequisite instead of fabricating a host).
 */
export function eventHubKafkaBootstrap(): string | null {
  const ns = (process.env.LOOM_EVENTHUB_NAMESPACE || '').trim();
  if (!ns) return null;
  return `${ns}.${serviceBusSuffix()}:9093`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audited data-plane access log
// ─────────────────────────────────────────────────────────────────────────────

export type StreamingSqlOperation = 'streaming.query' | 'streaming.ddl' | 'streaming.status';

export interface StreamingSqlAccessEvent {
  actorOid: string;
  actorUpn: string;
  tenantId: string;
  operation: StreamingSqlOperation;
  /** The statement (truncated in the row) — the "scope" of the access. */
  sql: string;
  /** Loom workspace scope when the caller supplied one. */
  workspaceId?: string;
  /** streaming-sql item id the action was launched from. */
  itemId?: string;
  outcome: 'success' | 'failure';
  rowCount?: number;
  elapsedMs?: number;
  detail?: string;
}

/**
 * Write ONE `_auditLog` row for a streaming-SQL operation and fan it out through
 * the SIEM / webhook audit stream. Per the AUDIT convention a mutation emits the
 * stream event FIRST (synchronously), before the awaited Cosmos write.
 * Best-effort by design: an audit-store failure never turns a successful
 * operation into a 500, but it IS logged.
 */
export async function logStreamingSqlAccess(ev: StreamingSqlAccessEvent): Promise<void> {
  const at = new Date().toISOString();
  const statement = (ev.sql || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const summary =
    `Streaming SQL ${ev.operation} on RisingWave by ${ev.actorUpn}`
    + (ev.rowCount === undefined ? '' : ` (${ev.rowCount} row(s))`)
    + (ev.outcome === 'failure' ? ` — FAILED: ${(ev.detail || '').slice(0, 200)}` : '');

  // AUDIT: emit the stream event FIRST, synchronously, for the mutating op.
  try {
    emitAuditEvent({
      actorOid: ev.actorOid,
      actorUpn: ev.actorUpn,
      action: `risingwave.${ev.operation}`,
      targetType: 'streaming-sql',
      targetId: ev.itemId || 'streaming-sql',
      outcome: ev.outcome,
      tenantId: ev.tenantId,
      timestamp: at,
      detail: {
        statement,
        workspaceId: ev.workspaceId || '',
        rowCount: ev.rowCount ?? null,
        elapsedMs: ev.elapsedMs ?? null,
        ...(ev.detail ? { detail: ev.detail.slice(0, 400) } : {}),
      },
    });
  } catch {
    /* audit-stream fan-out is best-effort by contract */
  }

  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId: ev.tenantId,
      itemId: ev.itemId || 'streaming-sql',
      itemType: 'streaming-sql',
      action: `risingwave.${ev.operation}`,
      summary,
      engine: 'risingwave',
      statement,
      workspaceId: ev.workspaceId || '',
      outcome: ev.outcome,
      rowCount: ev.rowCount ?? null,
      elapsedMs: ev.elapsedMs ?? null,
      upn: ev.actorUpn,
      actorOid: ev.actorOid,
      at,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[loom-risingwave] audit row write failed:', (e as Error)?.message || e);
  }
}
