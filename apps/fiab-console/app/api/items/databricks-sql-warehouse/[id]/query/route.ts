/**
 * POST /api/items/databricks-sql-warehouse/[id]/query
 * body { sql, warehouseId, catalog?, schema?, parameters?, clientQueryId? }
 *
 * `sql` may contain `:name` named parameter markers; `parameters[]` supplies
 * their values. The values are bound by the Databricks Statement Execution API,
 * never concatenated into the SQL — injection-safe.
 *
 * If warehouse isn't RUNNING, returns 409 { state } so UI can call /start.
 * When clientQueryId is supplied, the server-assigned statement_id is
 * registered against it so a parallel /cancel request can abort the run.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { executeStatement, getWarehouse, registerPendingStatement, clearPendingStatement, type DbxQueryParam } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  const sql = (body?.sql || '').toString().trim();
  const warehouseId = (body?.warehouseId || '').toString().trim();
  const catalog = body?.catalog ? String(body.catalog) : undefined;
  const schema = body?.schema ? String(body.schema) : undefined;
  const clientQueryId = (body?.clientQueryId || '').toString().trim();
  // Named parameters — bound by Databricks, NOT string-concatenated.
  const parameters: DbxQueryParam[] = (Array.isArray(body?.parameters) ? body.parameters : [])
    .filter((p: any) => p && typeof p.name === 'string')
    .map((p: any) => ({
      name: String(p.name),
      value: p.value == null ? null : String(p.value),
      type: p.type ? String(p.type) : undefined,
    }));

  if (!sql) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (!warehouseId) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });
  if (sql.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  // State pre-check — bail fast with 409 so UI can prompt Start.
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (w && w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, error: `Warehouse is ${w.state}. Call /start first.`, state: w.state },
      { status: 409 },
    );
  }

  try {
    const result = await executeStatement(
      warehouseId, sql, catalog, schema, parameters,
      clientQueryId ? (sid) => registerPendingStatement(clientQueryId, sid) : undefined,
    );
    return NextResponse.json({
      ok: true,
      ...result,
      warehouseId,
      // Receipt: the parameterized statement actually sent + the bound params,
      // proving values travelled out-of-band (not concatenated into the SQL).
      statement: sql,
      parameters: parameters.map((p) => ({ name: p.name, value: p.value, type: p.type })),
      parametersCount: parameters.length,
      executedBy: session.claims?.upn,
    });
  } catch (e: any) {
    // A user Cancel surfaces as a terminal CANCELED state from the poll loop.
    const canceled = /CANCELED/i.test(e?.message || '') || e?.code === 'STATEMENT_CANCELED';
    return NextResponse.json(
      {
        ok: false,
        canceled,
        error: canceled ? 'Query canceled by user.' : (e?.message || String(e)),
        code: e?.code,
      },
      { status: canceled ? 200 : 502 },
    );
  } finally {
    if (clientQueryId) clearPendingStatement(clientQueryId);
  }
}
