/**
 * POST /api/items/lakehouse/[id]/query
 *
 * Runs T-SQL for a Lakehouse SQL analytics endpoint. In this deployment a
 * Lakehouse is an ADLS Gen2 medallion container (bronze/silver/gold/landing)
 * whose tabular SQL surface is Synapse Serverless (OPENROWSET over the lake
 * files + Delta tables) — the same backend the Files/Preview tab uses.
 *
 * Previously the editor POSTed to
 *   /api/items/synapse-serverless-sql-pool/<lakehouseId>/query
 * which is the wrong item type. Even though that route ignores the id, the
 * mismatch was fragile and meant the lakehouse had no SQL route of its own.
 * This route is the lakehouse's own SQL analytics endpoint, calling the real
 * Synapse Serverless TDS client (no mock data).
 *
 * Body: { sql: string, database?: string }
 * Auth: session-required.
 *
 * Background:
 *  - Fabric lakehouse SQL analytics endpoint: a read-only T-SQL endpoint over
 *    the lakehouse Delta tables (https://learn.microsoft.com/fabric/data-engineering/lakehouse-sql-analytics-endpoint).
 *  - OPENROWSET serverless over raw CSV/Parquet:
 *    https://learn.microsoft.com/azure/synapse-analytics/sql/develop-openrowset
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { serverlessTarget, executeQuery } from '@/lib/azure/synapse-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sqlText = (body?.sql || '').toString().trim();
  const database = (body?.database || 'master').toString();
  if (!sqlText) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ ok: false, error: 'sql too large (>64KB)' }, { status: 413 });

  // Honest infra-gate: the lakehouse SQL endpoint requires a configured
  // Synapse Serverless workspace. Name the exact env var if it's missing,
  // rather than letting executeQuery throw an opaque "Missing env var".
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Lakehouse SQL analytics endpoint not provisioned in this deployment. ' +
          'Set LOOM_SYNAPSE_WORKSPACE (the Synapse workspace whose -ondemand serverless ' +
          'endpoint serves OPENROWSET over the medallion lake) and grant the Console UAMI ' +
          'the Synapse SQL admin / Storage Blob Data Reader roles.',
        code: 'synapse_not_configured',
      },
      { status: 503 },
    );
  }

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
