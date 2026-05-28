/**
 * GET  /api/admin/scaling/apim — current APIM service SKU + capacity.
 * POST /api/admin/scaling/apim — { sku, capacity? }
 *
 * Real ARM PATCH against Microsoft.ApiManagement/service/{name}.
 *
 * Note: SKU transitions Developer → Premium are blocked by Azure;
 * the BFF surfaces the precise APIM error verbatim when that happens.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getApimService, updateApimSku, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_SKUS = new Set([
  'Developer', 'Basic', 'Standard', 'Premium',
  'BasicV2', 'StandardV2', 'PremiumV2',
  'Consumption',
]);

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!process.env.LOOM_APIM_NAME) {
    return NextResponse.json({
      ok: false, error: 'APIM service not configured',
      hint: 'Set LOOM_APIM_NAME on loom-console.',
    }, { status: 503 });
  }
  try {
    const service = await getApimService();
    if (!service) return NextResponse.json({ ok: false, error: 'APIM service not found' }, { status: 404 });
    return NextResponse.json({ ok: true, service });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { sku?: string; capacity?: number };
  if (!body?.sku) return NextResponse.json({ ok: false, error: 'sku required' }, { status: 400 });
  if (!VALID_SKUS.has(body.sku)) {
    return NextResponse.json({ ok: false, error: `sku must be one of ${[...VALID_SKUS].join(', ')}` }, { status: 400 });
  }
  const capacity = typeof body.capacity === 'number' && body.capacity > 0 ? body.capacity : 1;
  try {
    const service = await updateApimSku(body.sku, capacity);
    return NextResponse.json({ ok: true, service });
  } catch (e: any) {
    if (e instanceof ApimError) {
      return NextResponse.json({ ok: false, error: e.message, body: e.body }, { status: e.status || 502 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
