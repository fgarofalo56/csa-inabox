/**
 * GET  /api/items/adf-pipeline      — list pipelines in the loom factory
 * POST /api/items/adf-pipeline      — create a new pipeline; body: { name, properties }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listPipelines, upsertPipeline, type AdfPipeline } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const pipelines = await listPipelines();
    return NextResponse.json({ ok: true, pipelines });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await req.json().catch(() => null)) as AdfPipeline | null;
  if (!body || !body.name || !body.properties) {
    return NextResponse.json({ error: 'body must be { name, properties: {...} }' }, { status: 400 });
  }
  try {
    const pipeline = await upsertPipeline(body.name, body);
    return NextResponse.json({ ok: true, pipeline });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
