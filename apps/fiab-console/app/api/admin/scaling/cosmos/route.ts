/**
 * GET  /api/admin/scaling/cosmos — list Loom containers + current throughput.
 * POST /api/admin/scaling/cosmos — { container, ru?, maxRu? }
 *
 * Real Cosmos data-plane: container.readOffer / database.client.offer(id).replace.
 * Serverless accounts return mode='serverless' on GET (no dial), and POST returns
 * a 409 with a clear message.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listContainerThroughput, updateContainerThroughput } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!process.env.LOOM_COSMOS_ENDPOINT) {
    return NextResponse.json({
      ok: false, error: 'Cosmos not configured',
      hint: 'Set LOOM_COSMOS_ENDPOINT on loom-console.',
    }, { status: 503 });
  }
  try {
    const containers = await listContainerThroughput();
    return NextResponse.json({ ok: true, containers });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { container?: string; ru?: number; maxRu?: number };
  if (!body?.container) return NextResponse.json({ ok: false, error: 'container required' }, { status: 400 });
  if (!body?.ru && !body?.maxRu) return NextResponse.json({ ok: false, error: 'ru (manual) or maxRu (autoscale) required' }, { status: 400 });
  if (body.ru && body.ru < 400) return NextResponse.json({ ok: false, error: 'manual RU/s minimum is 400' }, { status: 400 });
  if (body.maxRu && body.maxRu < 1000) return NextResponse.json({ ok: false, error: 'autoscale max RU/s minimum is 1000' }, { status: 400 });
  try {
    const result = await updateContainerThroughput(body.container, { ru: body.ru, maxRu: body.maxRu });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/serverless/i.test(msg)) {
      return NextResponse.json({ ok: false, error: msg }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
