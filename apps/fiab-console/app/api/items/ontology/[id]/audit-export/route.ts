/**
 * Foundry-parity "retention / export controls" (row 6.10) — over an ontology's
 * own governance audit chain (justifications + approvals).
 *
 * GET  /api/items/ontology/[id]/audit-export?format=csv|json
 *   → a downloadable file (Content-Disposition attachment) of the justification
 *     + approval records for this ontology. The EXPORT control.
 *
 * POST /api/items/ontology/[id]/audit-export   body: { olderThanDays }
 *   → deletes justification + approval records older than the window (min 1 day)
 *     and returns the count reaped. The RETENTION control (real deletion).
 *
 * Owner-scoped via loadOwnedItem. Azure-native (Cosmos audit-log) — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { listActionJustifications } from '@/lib/azure/action-justification-store';
import { listApprovals } from '@/lib/azure/action-approval-store';
import { reapOntologyAudit } from '@/lib/azure/audit-retention';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: false, error: 'save the ontology first' }, { status: 400 });
  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return NextResponse.json({ ok: false, error: 'ontology not found' }, { status: 404 });
  const format = req.nextUrl.searchParams.get('format') === 'json' ? 'json' : 'csv';
  try {
    const [justs, apprs] = await Promise.all([listActionJustifications(id, 1000), listApprovals(id, 1000)]);
    const rows = [
      ...justs.map((j) => ({ type: 'justification', at: j.at, action: j.action, objectType: j.objectType, actionKind: j.actionKind, outcome: j.outcome, detail: j.reason, actor: j.actorName || j.actorUpn || '', status: '' })),
      ...apprs.map((a) => ({ type: 'approval', at: a.at, action: a.action, objectType: a.objectType, actionKind: a.actionKind, outcome: a.status, detail: a.paramsPreview || '', actor: a.requesterName || '', status: a.status })),
    ].sort((x, y) => (x.at < y.at ? 1 : -1));
    const stamp = onto.displayName ? onto.displayName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() : id;
    if (format === 'json') {
      return new NextResponse(JSON.stringify({ ontology: onto.displayName, exportedAt: new Date().toISOString(), records: rows }, null, 2), {
        headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${stamp}-audit.json"` },
      });
    }
    const cols = ['type', 'at', 'action', 'objectType', 'actionKind', 'outcome', 'status', 'detail', 'actor'];
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell((r as Record<string, unknown>)[c])).join(','))].join('\n');
    return new NextResponse(csv, {
      headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${stamp}-audit.csv"` },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: false, error: 'save the ontology first' }, { status: 400 });
  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return NextResponse.json({ ok: false, error: 'ontology not found' }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { olderThanDays?: number };
  const days = Math.max(1, Math.floor(Number(body.olderThanDays) || 0));
  if (!days) return NextResponse.json({ ok: false, error: 'olderThanDays must be a positive integer (days)' }, { status: 400 });
  try {
    const reaped = await reapOntologyAudit(id, days, new Date().toISOString());
    return NextResponse.json({ ok: true, reaped, olderThanDays: days });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
