/**
 * Notepad (Foundry-parity row 3.3) — live-data document. POST runs one embedded
 * KQL query block against ADX and returns the result for inline rendering.
 *
 * POST /api/items/notepad/[id]/run-block   body: { kql }
 *   → { ok, columns, rows, rowCount, executionMs }
 *
 * Owner-scoped via loadOwnedItem; honest 503 gate when ADX unset. Azure-native
 * (Azure Data Explorer) — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { kustoConfigGate, defaultDatabase, executeQuery } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: false, error: 'save the notepad first' }, { status: 400 });
  const item = await loadOwnedItem(id, 'notepad', s.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'notepad not found' }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { kql?: string };
  const kql = String(body.kql || '').trim();
  if (!kql) return NextResponse.json({ ok: false, error: 'kql is required' }, { status: 400 });
  if (/^\s*\./.test(kql)) return NextResponse.json({ ok: false, error: 'management commands are not allowed in notepad blocks' }, { status: 400 });

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({ ok: false, code: 'adx_not_configured', error: `Azure Data Explorer not configured: set ${gate.missing}.`, gate: { remediation: `Set ${gate.missing}. No Microsoft Fabric required.` } }, { status: 503 });
  }
  try {
    const res = await executeQuery(defaultDatabase(), kql);
    return NextResponse.json({ ok: true, columns: res.columns, rows: res.rows, rowCount: res.rowCount, executionMs: res.executionMs });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e), code: 'run_failed' }, { status: 502 });
  }
}
