/**
 * POST /api/items/synapse-serverless-sql-pool/[id]/query
 * Executes T-SQL on Synapse Serverless SQL endpoint via TDS + AAD.
 * Body: { sql: string, database?: string }
 * Auth: session-required.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { serverlessTarget, executeQuery } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  const database = (body?.database || 'master').toString();
  if (!sqlText) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ error: 'sql too large (>64KB)' }, { status: 413 });

  try {
    const result = await executeQuery(serverlessTarget(database), sqlText);
    return NextResponse.json({
      ok: true,
      ...result,
      endpoint: `${process.env.LOOM_SYNAPSE_WORKSPACE}-ondemand.sql.azuresynapse.net`,
      database,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: e?.message || String(e),
        code: e?.code,
        sqlState: e?.originalError?.info?.state,
        sqlNumber: e?.number,
      },
      { status: 502 },
    );
  }
}
