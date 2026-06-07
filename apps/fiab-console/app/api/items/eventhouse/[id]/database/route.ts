/**
 * POST   /api/items/eventhouse/[id]/database
 *   Body: { name: string, hotCacheDays?: number, softDeleteDays?: number }
 *   Creates a new KQL database on the shared Loom Kusto cluster via ARM.
 *
 * DELETE /api/items/eventhouse/[id]/database?name=<db>
 *   Deletes a KQL database via ARM (Microsoft.Kusto/clusters/databases).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createDatabase, KustoError } from '@/lib/azure/kusto-client';
import {
  deleteKustoDatabase,
  KustoArmError,
  KustoNotConfiguredError,
} from '@/lib/azure/kusto-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DB_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_\-]{0,62}$/;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = (body?.name || '').toString().trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!DB_NAME_RE.test(name)) {
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

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // DELETE bodies are non-standard; take the database name from the query string.
  const name = (new URL(req.url).searchParams.get('name') || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  if (!DB_NAME_RE.test(name)) {
    return NextResponse.json({ ok: false, error: 'invalid database name' }, { status: 400 });
  }

  try {
    const result = await deleteKustoDatabase(name);
    return NextResponse.json({ ok: true, database: name, ...result });
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, missing: e.missing }, { status: 503 });
    }
    const status = e instanceof KustoArmError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
