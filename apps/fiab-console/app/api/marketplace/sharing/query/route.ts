/**
 * POST /api/marketplace/sharing/query
 *   Run a read-only SQL statement against the Databricks SQL warehouse — the
 *   in-Loom "Explore / Query" path for a SUBSCRIBED Delta Share's mounted
 *   read-only Unity Catalog catalog (and any other read against the warehouse).
 *
 *   Body: { catalog, schema?, sql? }
 *     - When `sql` is provided, it is run verbatim (after a SELECT-only guard).
 *     - When `sql` is omitted, a safe default preview is run:
 *         SHOW SCHEMAS IN `catalog`        (when no schema given)
 *         SHOW TABLES IN `catalog`.`schema`(when a schema is given)
 *       The richer "SELECT * FROM … LIMIT 100" table preview is built CLIENT-side
 *       (share-explorer) and posted back as an explicit `sql`.
 *
 *   The `catalog` / `schema` are also passed to the warehouse as the statement's
 *   default namespace so an unqualified table name resolves inside the
 *   subscribed catalog.
 *
 * Session-guarded (getSession). Returns the structured { ok, data, error }
 * shape. When the warehouse isn't configured (LOOM_DATABRICKS_SQL_WAREHOUSE_ID
 * unset) it returns 503 { ok:false, gate:true, missing } so the UI renders an
 * honest MessageBar — mirroring the other sharing routes' gate contract.
 *
 * No-fabric-dependency: the Databricks SQL warehouse is an Azure Databricks /
 * Unity Catalog resource, not a Microsoft Fabric one — gating on it is a
 * legitimate Azure infra gate, not a Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  runWarehouseStatement,
  warehouseConfigGate,
  WarehouseNotConfiguredError,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SELECT-only guard. A subscribed Delta Share catalog is read-only at the
 * Unity Catalog level (DDL/DML would be rejected by Databricks anyway), but we
 * reject obvious mutating statements up front so a typo can't even be attempted
 * and the error is a clear, friendly one. SELECT / WITH / SHOW / DESCRIBE /
 * DESC / EXPLAIN / VALUES / TABLE are allowed.
 */
const READ_ONLY_LEADING = /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|VALUES|TABLE)\b/i;
const MUTATING = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|REPLACE|REFRESH|COPY|OPTIMIZE|VACUUM|ANALYZE|MSCK|SET|RESET|USE|CALL)\b/i;

/** Strip leading line (`--`) and block (`/* *\/`) comments so the guard reads
 *  the first real keyword rather than a comment. */
function stripLeadingComments(sql: string): string {
  let s = sql;
  let prev: string;
  do {
    prev = s;
    s = s.trimStart();
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2);
    }
  } while (s !== prev);
  return s.trimStart();
}

function isReadOnly(sql: string): boolean {
  const body = stripLeadingComments(sql);
  if (!READ_ONLY_LEADING.test(body)) return false;
  // A leading SELECT/WITH/SHOW is necessary but not sufficient — also reject a
  // statement that smuggles a mutating verb (e.g. a multi-statement batch).
  if (MUTATING.test(body)) return false;
  return true;
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Honest gate FIRST — before we touch the body — so a deployment with no
  // warehouse pinned gets a precise 503 the UI renders as a MessageBar.
  const gate = warehouseConfigGate(req.nextUrl.searchParams.get('warehouseId'));
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        gate: true,
        missing: gate.missing,
        error:
          `Databricks SQL warehouse not configured. Set ${gate.missing} on the Loom ` +
          `Console (the SQL warehouse used to query subscribed Delta Share catalogs). ` +
          `The push-button day-one bootstrap wires this automatically once a warehouse exists.`,
      },
      { status: 503 },
    );
  }

  let body: { catalog?: string; schema?: string; sql?: string; warehouseId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const catalog = String(body?.catalog || '').trim();
  const schema = String(body?.schema || '').trim();
  const rawSql = typeof body?.sql === 'string' ? body.sql.trim() : '';
  const warehouseId = (body?.warehouseId || req.nextUrl.searchParams.get('warehouseId') || '').trim() || undefined;

  if (!catalog) {
    return NextResponse.json({ ok: false, error: 'catalog is required' }, { status: 400 });
  }

  // Resolve the statement: explicit SQL (read-only-guarded) OR a safe default
  // catalog/schema browse. Identifiers are backtick-escaped (doubled internal
  // backticks) so a catalog/schema name with special characters can't break out.
  const bt = (id: string) => `\`${id.replace(/`/g, '``')}\``;
  let sql: string;
  if (rawSql) {
    if (!isReadOnly(rawSql)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Only read-only statements are allowed here (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN). ' +
            'A subscribed Delta Share catalog is read-only.',
        },
        { status: 400 },
      );
    }
    sql = rawSql;
  } else if (schema) {
    sql = `SHOW TABLES IN ${bt(catalog)}.${bt(schema)}`;
  } else {
    sql = `SHOW SCHEMAS IN ${bt(catalog)}`;
  }

  try {
    const result = await runWarehouseStatement(sql, {
      warehouseId,
      // Default namespace so an unqualified `SELECT * FROM tbl` resolves inside
      // the subscribed catalog/schema. Only set when this is a user SELECT —
      // SHOW … IN already fully-qualifies.
      ...(rawSql && catalog ? { catalog } : {}),
      ...(rawSql && schema ? { schema } : {}),
    });
    return NextResponse.json({
      ok: true,
      data: {
        sql,
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
        executionMs: result.executionMs,
      },
    });
  } catch (e: any) {
    if (e instanceof WarehouseNotConfiguredError) {
      return NextResponse.json(
        { ok: false, gate: true, missing: e.missing, error: e.message },
        { status: 503 },
      );
    }
    // A Databricks statement error (FAILED / syntax / permission) — surface its
    // message + error_code verbatim so the analyst can fix the query.
    return NextResponse.json(
      { ok: false, error: String(e?.message || e), code: e?.code },
      { status: typeof e?.status === 'number' ? e.status : 400 },
    );
  }
}
