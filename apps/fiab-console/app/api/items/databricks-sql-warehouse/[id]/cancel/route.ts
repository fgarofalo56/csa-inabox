/**
 * POST /api/items/databricks-sql-warehouse/[id]/cancel
 * body: { statementId } | { clientQueryId }
 *
 * Cancels a running Databricks SQL statement via
 *   POST /api/2.0/sql/statements/{statement_id}/cancel
 * Grounded in the SQL Statement Execution API "cancel" operation
 * (https://learn.microsoft.com/azure/databricks/api/workspace/statementexecution/cancelexecution).
 *
 * The client generates a clientQueryId before issuing /query; the query route
 * registers clientQueryId -> statement_id as soon as the statement is submitted,
 * so this route can resolve and cancel the statement while /query is still
 * polling. A direct statementId is also accepted.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { cancelStatement, cancelByClientId, databricksConfigGate } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: `Databricks not configured — set ${gate.missing}.`, code: 'not_configured' },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const statementId = (body?.statementId || '').toString().trim();
  const clientQueryId = (body?.clientQueryId || '').toString().trim();

  if (!statementId && !clientQueryId) {
    return NextResponse.json(
      { ok: false, error: 'statementId (or clientQueryId) is required' },
      { status: 400 },
    );
  }

  try {
    if (statementId) {
      await cancelStatement(statementId);
      return NextResponse.json({ ok: true, canceled: true, statementId, canceledBy: session.claims?.upn });
    }
    const r = await cancelByClientId(clientQueryId);
    // canceled:false simply means the statement is no longer in-flight on this
    // replica (already finished, or running on another instance). Still ok:true.
    return NextResponse.json({ ok: true, canceled: r.canceled, statementId: r.statementId, canceledBy: session.claims?.upn });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
