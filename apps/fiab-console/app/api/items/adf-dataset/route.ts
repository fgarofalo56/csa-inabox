/**
 * GET  /api/items/adf-dataset  — list datasets in factory
 * POST /api/items/adf-dataset  — create dataset; body: { name, properties }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDatasets, upsertDataset, type AdfDataset } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const datasets = await listDatasets();
    return NextResponse.json({ ok: true, datasets });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as AdfDataset | null;
  if (!body || !body.name || !body.properties) {
    return NextResponse.json({ error: 'body must be { name, properties: {...} }' }, { status: 400 });
  }
  try {
    const dataset = await upsertDataset(body.name, body);
    return NextResponse.json({ ok: true, dataset });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
