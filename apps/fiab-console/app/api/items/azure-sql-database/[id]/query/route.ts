/**
 * POST /api/items/azure-sql-database/[id]/query
 *   body { server, database, sql } — runs T-SQL on the target Azure SQL
 *   database via TDS + AAD MI. id is the cosmos item id; server/database
 *   come from the editor state.
 *
 * Returns the full multi-result-set shape so the editor's results pane can
 * offer SSMS / Azure Data Studio parity: every batch result set
 * (`recordsets[]`), every in-band message (`messages[]` — PRINT / RAISERROR /
 * row counts), and the per-statement `rowsAffected[]`. The first result set is
 * also promoted to the legacy top-level `columns/rows/rowCount/truncated`
 * fields so the schema browser + INFORMATION_SCHEMA grid keep working.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { executeQueryBatch, AzureSqlError } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;
  const body = await req.json().catch(() => ({}));
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  const sqlText = String(body?.sql || '').trim();
  // Optional cancel token: registered in liveRequests so /query/cancel can send
  // a TDS ATTENTION packet to this exact in-flight request.
  const requestId = String(body?.requestId || '').trim() || undefined;
  if (!server) return NextResponse.json({ ok: false, error: 'server is required' }, { status: 400 });
  if (!database) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });
  if (!sqlText) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ ok: false, error: 'sql too large (>64KB)' }, { status: 413 });

  try {
    const result = await executeQueryBatch(server, database, sqlText, requestId ? { requestId } : undefined);
    // Backward-compat single-recordset fields = first result set (or empty).
    const first = result.recordsets[0] ?? { columns: [], rows: [], rowCount: 0, truncated: false };
    return NextResponse.json({
      ok: true,
      // ── Multi-recordset shape (new) ──
      recordsets: result.recordsets,
      messages: result.messages,
      rowsAffected: result.rowsAffected,
      executionMs: result.executionMs,
      // ── Backward-compat single-recordset fields ──
      columns: first.columns,
      rows: first.rows,
      rowCount: first.rowCount,
      truncated: first.truncated,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
      code: e?.code,
      sqlNumber: e?.number,
    }, { status });
  }
}
