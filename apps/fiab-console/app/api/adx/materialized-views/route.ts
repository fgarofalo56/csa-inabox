/**
 * Materialized views on the ADX/KQL database bound to a kql-database item.
 *
 *   GET    /api/adx/materialized-views?id=ITEM            → { ok, materializedViews: [{name, sourceTable}] }
 *   POST   /api/adx/materialized-views?id=ITEM            body { name, sourceTable, query, backfill? } → .create [async] materialized-view [with(backfill=true)]
 *   DELETE /api/adx/materialized-views?id=ITEM&name=NAME  → .drop materialized-view NAME ifexists
 *
 * Real Kusto control commands to /v1/rest/mgmt. Honest 503 gate. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listMaterializedViews, createMaterializedView, dropMaterializedView } from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  try {
    const materializedViews = await listMaterializedViews(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, materializedViews });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  const sourceTable: string = typeof body?.sourceTable === 'string' ? body.sourceTable.trim() : '';
  const query: string = typeof body?.query === 'string' ? body.query.trim() : '';
  const backfill: boolean = body?.backfill === true;
  if (!validName(name)) return NextResponse.json({ ok: false, error: 'name must start with a letter/underscore' }, { status: 400 });
  if (!sourceTable) return NextResponse.json({ ok: false, error: 'sourceTable is required' }, { status: 400 });
  if (!query) return NextResponse.json({ ok: false, error: 'query is required, e.g. "T | summarize count() by bin(ts,1d)"' }, { status: 400 });
  try {
    const r = await createMaterializedView(g.ctx.database, name, sourceTable, query, { backfill });
    return NextResponse.json({ ok: true, name, backfill, rowCount: r.rowCount });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function DELETE(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await dropMaterializedView(g.ctx.database, name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return adxError(e);
  }
}
