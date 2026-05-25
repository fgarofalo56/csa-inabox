/**
 * GET  /api/items/adf-trigger  — list triggers in factory
 * POST /api/items/adf-trigger  — create trigger; body: { name, properties }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listTriggers, upsertTrigger, type AdfTrigger } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const triggers = await listTriggers();
    return NextResponse.json({ ok: true, triggers });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as AdfTrigger | null;
  if (!body || !body.name || !body.properties) {
    return NextResponse.json({ error: 'body must be { name, properties: {...} }' }, { status: 400 });
  }
  try {
    const trigger = await upsertTrigger(body.name, body);
    return NextResponse.json({ ok: true, trigger });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
