/**
 * POST /api/items/eventhouse/[id]/database
 * Body: { name: string, hotCacheDays?: number, softDeleteDays?: number }
 * Creates a new KQL database on the shared Loom Kusto cluster via ARM.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createDatabase, KustoError } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = (body?.name || '').toString().trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_\-]{0,62}$/.test(name)) {
    return NextResponse.json({ ok: false, error: 'invalid database name' }, { status: 400 });
  }

  try {
    const result = await createDatabase(name, {
      hotCacheDays: Number(body?.hotCacheDays) || undefined,
      softDeleteDays: Number(body?.softDeleteDays) || undefined,
    });
    return NextResponse.json({ ok: true, database: name, ...result });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
