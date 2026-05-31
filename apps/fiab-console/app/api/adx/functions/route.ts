/**
 * Stored KQL functions on the ADX/KQL database bound to a kql-database item.
 *
 *   GET    /api/adx/functions?id=ITEM            → { ok, functions: [{name, parameters, folder}] }
 *   POST   /api/adx/functions?id=ITEM            body { name, args?, body } → .create-or-alter function
 *   DELETE /api/adx/functions?id=ITEM&name=NAME  → .drop function NAME ifexists
 *
 * Real Kusto control commands to /v1/rest/mgmt. Honest 503 gate. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listFunctions, createFunction, dropFunction } from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  try {
    const functions = await listFunctions(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, functions });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  const args: string = typeof body?.args === 'string' ? body.args : '';
  const fnBody: string = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!validName(name)) return NextResponse.json({ ok: false, error: 'name must start with a letter/underscore' }, { status: 400 });
  if (!fnBody) return NextResponse.json({ ok: false, error: 'body is required, e.g. "MyTable | take 10"' }, { status: 400 });
  try {
    const r = await createFunction(g.ctx.database, name, args, fnBody);
    return NextResponse.json({ ok: true, name, rowCount: r.rowCount });
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
    await dropFunction(g.ctx.database, name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return adxError(e);
  }
}
