/**
 * Analysis Board (Foundry-parity row 3.1 — Contour) run route.
 *
 * POST /api/items/analysis-board/[id]/run
 *   body: { board? }   (falls back to the item's persisted state.board)
 *   → { ok, kql, columns, columnTypes, rows, rowCount, executionMs }
 *
 * Compiles the typed transform board to KQL (compileBoardToKql) and executes it
 * against Azure Data Explorer (kusto-client). Honest 503 gate when ADX is not
 * configured. Owner-scoped via loadOwnedItem. Azure-native — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { compileBoardToKql, normalizeBoard } from '@/lib/editors/analysis-board-model';
import { kustoConfigGate, defaultDatabase, executeQuery } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'analysis-board';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: false, error: 'save the board first' }, { status: 400 });
  const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'analysis board not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { board?: unknown };
  const rawBoard = body.board ?? (item.state as Record<string, unknown> | undefined)?.board;
  const board = normalizeBoard(rawBoard);

  const compiled = compileBoardToKql(board);
  if (!compiled.ok) return NextResponse.json({ ok: false, error: compiled.error, code: 'compile_failed' }, { status: 400 });

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false, code: 'adx_not_configured', kql: compiled.kql,
      error: `Azure Data Explorer not configured: set ${gate.missing}.`,
      gate: { reason: 'Analysis boards execute against Azure Data Explorer (the Loom Azure-native analytics backend).', remediation: `Set ${gate.missing}. No Microsoft Fabric required.` },
    }, { status: 503 });
  }

  try {
    const db = defaultDatabase();
    const res = await executeQuery(db, compiled.kql);
    return NextResponse.json({
      ok: true, kql: compiled.kql,
      columns: res.columns, columnTypes: res.columnTypes, rows: res.rows,
      rowCount: res.rowCount, executionMs: res.executionMs, truncated: res.truncated,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e), code: 'run_failed', kql: compiled.kql }, { status: 502 });
  }
}
