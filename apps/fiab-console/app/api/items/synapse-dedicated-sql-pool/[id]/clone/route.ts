/**
 * POST /api/items/synapse-dedicated-sql-pool/[id]/clone
 * body { sourceSchema, sourceTable, targetSchema, targetTable }
 *
 * "Clone" on Synapse Dedicated SQL pool via SELECT INTO:
 *
 *   SELECT * INTO [targetSchema].[targetTable]
 *   FROM   [sourceSchema].[sourceTable];
 *
 * HONEST NOTE — Synapse Dedicated SQL pool has NO zero-copy clone. SELECT INTO
 * is a full physical data copy that always uses ROUND_ROBIN distribution and a
 * Clustered Columnstore Index (neither configurable). To control distribution
 * or index type, use Save as table (CTAS) instead.
 *
 * Executed over TDS (synapse-sql-client.executeQuery) against the env-bound
 * Dedicated pool. recordsAffected reports the rows materialized.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ZERO_COPY_NOTE =
  'Synapse Dedicated SQL pool has no zero-copy clone equivalent. ' +
  'SELECT INTO is a full physical data copy that uses ROUND_ROBIN distribution ' +
  'and a Clustered Columnstore Index (non-configurable). ' +
  'To control distribution or index type, use Save as table (CTAS) instead.';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const sourceSchema = (body?.sourceSchema || 'dbo').toString().trim();
  const sourceTable = (body?.sourceTable || '').toString().trim();
  const targetSchema = (body?.targetSchema || sourceSchema).toString().trim();
  const targetTable = (body?.targetTable || '').toString().trim();

  if (!sourceTable) return NextResponse.json({ error: 'sourceTable is required' }, { status: 400 });
  if (!targetTable) return NextResponse.json({ error: 'targetTable is required' }, { status: 400 });

  // Bail fast with 409 if the pool isn't Online so the UI can prompt Resume.
  const state = await getPoolState().catch(() => null);
  if (state && state.state !== 'Online') {
    return NextResponse.json(
      { ok: false, error: `Pool is ${state.state}. Resume it first.`, state: state.state },
      { status: 409 },
    );
  }

  const esc = (x: string) => x.replace(/]/g, ']]');
  const sql =
    `SELECT *\nINTO   [${esc(targetSchema)}].[${esc(targetTable)}]\n` +
    `FROM   [${esc(sourceSchema)}].[${esc(sourceTable)}];`;

  try {
    const result = await executeQuery(dedicatedTarget(), sql);
    return NextResponse.json({
      ok: true,
      source: `${sourceSchema}.${sourceTable}`,
      target: `${targetSchema}.${targetTable}`,
      note: ZERO_COPY_NOTE,
      recordsAffected: result.recordsAffected,
      executionMs: result.executionMs,
      executedBy: session.claims?.upn,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code, sqlNumber: e?.number },
      { status: 502 },
    );
  }
}
