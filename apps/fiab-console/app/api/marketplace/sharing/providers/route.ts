/**
 * GET  /api/marketplace/sharing/providers           → inbound providers (orgs / Databricks
 *                                                       Marketplace listings sharing data WITH us)
 *      ?withShares=true                              → also attach each provider's shares (bounded)
 * POST /api/marketplace/sharing/providers            → add an inbound provider from a recipient
 *                                                       activation profile { name, recipient_profile_str, comment? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listProviders, listProviderShares, createProvider } from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const providers = await listProviders(host);
    if (req.nextUrl.searchParams.get('withShares') === 'true') {
      // Bounded enrichment — each provider's shares, best-effort, in parallel.
      const enriched = await Promise.all(
        providers.map(async (p) => ({
          ...p,
          shares: await listProviderShares(host, p.name).catch(() => []),
        })),
      );
      return NextResponse.json({ ok: true, host, providers: enriched });
    }
    return NextResponse.json({ ok: true, host, providers });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || '').trim();
    const profile = String(body?.recipient_profile_str || '').trim();
    if (!name || !profile) {
      return NextResponse.json(
        { ok: false, error: 'name and recipient_profile_str are required' },
        { status: 400 },
      );
    }
    const host = await resolveShareHost(body?.host);
    const provider = await createProvider(host, { name, recipient_profile_str: profile, comment: body?.comment });
    return NextResponse.json({ ok: true, host, provider });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}
