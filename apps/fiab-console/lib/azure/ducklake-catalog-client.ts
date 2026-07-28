/**
 * N8 lab 1 — DuckLake catalog client (Preview). SERVER-ONLY.
 *
 * ## The lab
 *
 * DuckLake (https://ducklake.select, Apache-2.0) is a catalog format that keeps
 * lakehouse table metadata in a **SQL database** (Postgres here) instead of a
 * metadata-file tree. It is a forward bet on the DuckDB ecosystem, offered
 * ALONGSIDE N1's Iceberg REST Catalog — not a replacement. The N2 DuckDB
 * serving tier is the query engine: it `ATTACH`es the DuckLake catalog and reads
 * the Delta/Parquet data IN PLACE on the deployment's own ADLS Gen2.
 *
 * ## Honest gate (no-vaporware, Preview)
 *
 * The catalog needs TWO things to list tables: the DuckLake Postgres store
 * (`LOOM_DUCKLAKE_CATALOG_URL`) AND the N2 DuckDB tier (`LOOM_DUCKDB_URL`, the
 * engine that runs the ATTACH). When either is unset {@link listDucklakeTables}
 * throws a typed 503 naming the exact missing var — the editor renders a guided
 * empty state with a Fix-it, never a fabricated table list. N1's Iceberg REST
 * Catalog and every other surface are unaffected either way.
 *
 * IL5 / SOVEREIGN MOAT: the metadata store is an in-boundary Azure Database for
 * PostgreSQL and the engine is the in-boundary DuckDB tier — no SaaS catalog is
 * in the path, so the lab runs disconnected in an air-gapped enclave. No
 * Microsoft Fabric / OneLake / Power BI (.claude/rules/no-fabric-dependency.md).
 */

import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { escapeSqlLiteral, quoteIdent } from '@/lib/sql/quoting';
import { duckdbQueryJson, isDuckDbConfigured } from '@/lib/azure/duckdb-client';

/** Registry gate id — mirrors the ENV_CHECKS spec in env-checks/data-plane.ts. */
export const DUCKLAKE_GATE_ID = 'svc-ducklake-catalog';

/** Honest config gate — the missing env var, or null when the store is wired. */
export function ducklakeConfigGate(): { missing: string } | null {
  return (process.env.LOOM_DUCKLAKE_CATALOG_URL || '').trim() ? null : { missing: 'LOOM_DUCKLAKE_CATALOG_URL' };
}

/** True when the DuckLake Postgres metadata store is configured. */
export function isDucklakeConfigured(): boolean {
  return ducklakeConfigGate() === null;
}

/** The DuckLake catalog (schema) name the engine ATTACHes as — fixed alias. */
export function ducklakeCatalogName(): string {
  return 'ducklake';
}

export class DucklakeError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'DucklakeError';
    this.status = status;
    this.code = code;
  }
}

/** The raw Postgres connection string for the DuckLake metadata store. */
function ducklakeConnectionString(): string {
  const raw = (process.env.LOOM_DUCKLAKE_CATALOG_URL || '').trim();
  if (!raw) {
    throw new DucklakeError(
      'The DuckLake catalog is not configured. Set LOOM_DUCKLAKE_CATALOG_URL to the Postgres connection string that '
      + 'backs the DuckLake metadata (postgresql://…/ducklake) on the Console app. This is a Preview lab alongside the '
      + 'N1 Iceberg REST Catalog; N1 is unaffected. No Microsoft Fabric required.',
      503,
      'ducklake_not_configured',
    );
  }
  if (!/^postgres(ql)?:\/\//i.test(raw)) {
    throw new DucklakeError(
      'LOOM_DUCKLAKE_CATALOG_URL must be a postgresql:// connection string (DuckLake stores its metadata in Postgres).',
      400,
      'invalid_connection_string',
    );
  }
  return raw;
}

/** The `ducklake:postgres:` DSN DuckDB's ATTACH expects, from the pg URL. */
export function ducklakeAttachTarget(connectionString: string): string {
  // DuckDB's DuckLake extension attaches a Postgres-backed catalog with a
  // `ducklake:postgres:<dsn>` target. Pass the operator's pg URL through as the
  // dsn; DuckDB parses standard postgres URLs.
  return `ducklake:postgres:${connectionString}`;
}

/** One catalog table row (real DuckDB metadata columns, never fabricated). */
export interface DucklakeTable {
  schema: string;
  name: string;
}

/** The result of a catalog listing — engine-reported, with an honest note. */
export interface DucklakeCatalogListing {
  catalog: string;
  tables: DucklakeTable[];
  note: string;
}

/**
 * List the tables the DuckLake catalog exposes, by ATTACHing it on the N2
 * DuckDB serving tier and reading `information_schema.tables`. REAL engine call
 * — the tier reads the Postgres metadata and the lake data in place. Throws
 * {@link DucklakeError} (503 when unwired, upstream status otherwise); never
 * returns a fabricated list.
 */
export async function listDucklakeTables(): Promise<DucklakeCatalogListing> {
  const conn = ducklakeConnectionString();
  if (!isDuckDbConfigured()) {
    throw new DucklakeError(
      'DuckLake needs the N2 DuckDB serving tier to run the ATTACH. Set LOOM_DUCKDB_URL (deploy '
      + 'platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep) in addition to LOOM_DUCKLAKE_CATALOG_URL. Until then '
      + 'the DuckLake catalog cannot be browsed, but nothing else is affected.',
      503,
      'duckdb_tier_required',
    );
  }
  const alias = ducklakeCatalogName();
  // Server-built statement: the connection string is escaped as a SQL literal
  // and the alias is a validated identifier — a client never supplies either.
  const attachTarget = escapeSqlLiteral(ducklakeAttachTarget(conn));
  const aliasIdent = quoteIdent(alias);
  const aliasLiteral = escapeSqlLiteral(alias);
  const sql =
    `ATTACH '${attachTarget}' AS ${aliasIdent} (READ_ONLY); `
    + `SELECT table_schema AS schema, table_name AS name FROM information_schema.tables `
    + `WHERE table_catalog = '${aliasLiteral}' ORDER BY table_schema, table_name;`;

  const body = await duckdbQueryJson(sql, 5000).catch((e) => {
    throw new DucklakeError(
      `The DuckLake catalog could not be read through the DuckDB tier: ${(e as Error)?.message || String(e)}. `
      + 'Confirm the DuckDB image includes the ducklake extension and the Postgres store is reachable from the tier.',
      502,
      'ducklake_read_failed',
    );
  });

  const tables: DucklakeTable[] = (body.rows || []).map((r) => ({
    schema: String((r as unknown[])[0] ?? ''),
    name: String((r as unknown[])[1] ?? ''),
  }));
  return {
    catalog: alias,
    tables,
    note: `Read live from the DuckLake Postgres catalog via the N2 DuckDB tier (${tables.length} table(s)).`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audited data-plane access log
// ─────────────────────────────────────────────────────────────────────────────

export interface DucklakeAccessEvent {
  actorOid: string;
  actorUpn: string;
  tenantId: string;
  operation: 'catalog.list';
  itemId?: string;
  outcome: 'success' | 'failure';
  resultCount?: number;
  detail?: string;
}

/** Write ONE `_auditLog` row for a DuckLake catalog access + fan out. Best-effort. */
export async function logDucklakeAccess(ev: DucklakeAccessEvent): Promise<void> {
  const at = new Date().toISOString();
  const summary =
    `DuckLake catalog ${ev.operation} by ${ev.actorUpn}`
    + (ev.resultCount === undefined ? '' : ` (${ev.resultCount} table(s))`)
    + (ev.outcome === 'failure' ? ` — FAILED: ${(ev.detail || '').slice(0, 200)}` : '');
  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId: ev.tenantId,
      itemId: ev.itemId || 'ducklake-catalog',
      itemType: 'ducklake-catalog',
      action: `ducklake.${ev.operation}`,
      summary,
      outcome: ev.outcome,
      resultCount: ev.resultCount ?? null,
      upn: ev.actorUpn,
      actorOid: ev.actorOid,
      at,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[ducklake-catalog] audit row write failed:', (e as Error)?.message || e);
  }
  try {
    emitAuditEvent({
      actorOid: ev.actorOid,
      actorUpn: ev.actorUpn,
      action: `ducklake.${ev.operation}`,
      targetType: 'ducklake-catalog',
      targetId: ev.itemId || 'ducklake-catalog',
      outcome: ev.outcome,
      tenantId: ev.tenantId,
      timestamp: at,
      detail: {
        resultCount: ev.resultCount ?? null,
        ...(ev.detail ? { detail: ev.detail.slice(0, 400) } : {}),
      },
    });
  } catch {
    /* audit-stream fan-out is best-effort by contract */
  }
}
