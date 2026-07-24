/**
 * POST /api/sql/trino — the N7e **Federated SQL (Trino)** execution edge.
 *
 * Runs a statement on the OPT-IN Trino cluster (Apache-2.0, private AKS in the
 * deployment's VNet) registered against the N1 Iceberg REST Catalog + external
 * connectors — so ONE statement can join a Loom Iceberg table with an external
 * Postgres/MySQL/Kafka source. Trino is the single opt-in engine in the program:
 * when `LOOM_TRINO_URL` is unset this route returns the honest **opt-in gate
 * envelope** (with a Fix-it wizard that discloses the AKS cost) — never a
 * fabricated result. SQL Lab stays fully functional meanwhile because DuckDB
 * (N2b) is the default engine; Trino only ADDS the "Federated SQL" choice.
 *
 * AUDIT: every execution — success or failure — writes an `_auditLog`
 * data-access row (principal, statement scope, catalogs, rows, outcome, ts) and
 * fans out through the audit stream BEFORE the response is sent. There is no
 * unaudited path to the cluster.
 *
 * 200 → { ok:true, engine:'trino', columns, rows, rowCount, totalMs, catalogs, … }
 * 400 → bad request / statement error from the coordinator
 * 401 → unauthenticated
 * 503 → opt-in gate envelope (LOOM_TRINO_URL unset) — Fix-it discloses AKS cost
 * 502 → cluster unreachable
 */
import { apiError, apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { backendGateResponse } from '@/lib/api/gate-envelope';
import {
  TRINO_GATE_ID,
  TrinoError,
  buildFederatedJoinSql,
  logTrinoAccess,
  runTrinoQuery,
  trinoIcebergCatalog,
  type TrinoTableRef,
} from '@/lib/azure/trino-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface JoinBody {
  left?: Partial<TrinoTableRef>;
  right?: Partial<TrinoTableRef>;
  on?: Array<[string, string]>;
  columns?: string[];
  limit?: number;
}

interface Body {
  sql?: unknown;
  /** Instead of raw SQL, a structured cross-source join the BFF assembles safely. */
  join?: JoinBody;
  maxRows?: unknown;
  catalog?: unknown;
  schema?: unknown;
  itemId?: unknown;
  workspaceId?: unknown;
}

export const POST = withSession(async (req, { session }) => {
  // Trino is the OPT-IN carve-out: when unset, return the normalized 503 gate
  // envelope so the surface renders the honest Fix-it (which discloses the AKS
  // cost). This is the DEFAULT state — SQL Lab still works on DuckDB.
  const gated = backendGateResponse(TRINO_GATE_ID);
  if (gated) return gated;

  const body = (await req.json().catch(() => ({}))) as Body;
  let sql = typeof body.sql === 'string' ? body.sql.trim() : '';

  // A caller may hand a STRUCTURED cross-source join; the BFF builds the SQL
  // through the quoting helpers so a browser never assembles the statement.
  if (!sql && body.join && typeof body.join === 'object') {
    try {
      const j = body.join;
      sql = buildFederatedJoinSql({
        left: {
          catalog: String(j.left?.catalog ?? trinoIcebergCatalog()),
          schema: String(j.left?.schema ?? ''),
          table: String(j.left?.table ?? ''),
        },
        right: {
          catalog: String(j.right?.catalog ?? ''),
          schema: String(j.right?.schema ?? ''),
          table: String(j.right?.table ?? ''),
        },
        on: Array.isArray(j.on) ? j.on : [],
        columns: Array.isArray(j.columns) ? j.columns.map(String) : undefined,
        limit: typeof j.limit === 'number' ? j.limit : undefined,
      });
    } catch (e) {
      if (e instanceof TrinoError) return apiError(e.message, e.status, { code: e.code });
      return apiError('That federated join could not be assembled.', 400, { code: 'invalid_join' });
    }
  }

  if (!sql) {
    return apiError(
      'A SQL statement is required. Federated SQL runs read-only cross-source queries — try '
      + 'SELECT * FROM iceberg.gold.orders o JOIN postgres.public.customers c ON o.customer_id = c.id LIMIT 100.',
      400,
    );
  }

  const maxRows = typeof body.maxRows === 'number' && Number.isFinite(body.maxRows)
    ? Math.floor(body.maxRows)
    : undefined;
  const catalog = typeof body.catalog === 'string' ? body.catalog : undefined;
  const schema = typeof body.schema === 'string' ? body.schema : undefined;
  const itemId = typeof body.itemId === 'string' ? body.itemId : undefined;
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;

  const tenantId = session.claims.tid || session.claims.oid;
  const audit = {
    actorOid: session.claims.oid,
    actorUpn: session.claims.upn,
    tenantId,
    sql,
    itemId,
    workspaceId,
  };

  try {
    const result = await runTrinoQuery(sql, {
      maxRows,
      actorUpn: session.claims.upn,
      catalog,
      schema,
    });
    await logTrinoAccess({
      ...audit,
      catalogs: result.catalogs,
      outcome: 'success',
      rowCount: result.rowCount,
      elapsedMs: result.totalMs,
    });
    return apiOk({
      engine: result.engine,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      totalMs: result.totalMs,
      truncated: result.truncated,
      maxRows: result.maxRows,
      catalogs: result.catalogs,
      note: result.note,
    });
  } catch (e) {
    await logTrinoAccess({
      ...audit,
      outcome: 'failure',
      detail: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof TrinoError) return apiError(e.message, e.status, { code: e.code });
    // A refused statement / SQL error from the coordinator is user-actionable —
    // surface it verbatim (it is the query the user typed, not internals).
    const message = e instanceof Error ? e.message : String(e);
    return apiError(message.slice(0, 600), 400, { code: 'query_failed' });
  }
});
