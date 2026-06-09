/**
 * OneLake / ADLS Gen2 storage-tier (Hot / Cool / Cold) management.
 *
 * GET  /api/onelake/tier?container=&path=
 *   Returns the current access tier of a single file.
 *
 * PUT  /api/onelake/tier
 *   Body: { container, path, tier: 'Hot' | 'Cool' | 'Cold' }
 *   Changes the access tier. Direction is auto-detected against the live tier:
 *     - cooler  (Hot→Cool/Cold, Cool→Cold) → Set Blob Tier
 *     - warmer  (Cool/Cold→Hot)            → Copy Blob (avoids the
 *                                            early-deletion penalty on the
 *                                            source Cool/Cold blob)
 *
 * Real Azure blob data-plane only — no mock, no Fabric dependency. GA in all
 * four sovereign clouds via the .blob endpoint resolved by getBlobSuffix().
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  KNOWN_CONTAINERS,
  getBlobTier,
  setBlobTier,
  copyBlobToTier,
  type KnownContainer,
  type BlobAccessTier,
} from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TIERS: BlobAccessTier[] = ['Hot', 'Cool', 'Cold'];

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const container = req.nextUrl.searchParams.get('container') || '';
  const path = req.nextUrl.searchParams.get('path') || '';
  if (!container || !path) {
    return NextResponse.json({ ok: false, error: 'container and path are required' }, { status: 400 });
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }

  try {
    const result = await getBlobTier(container as KnownContainer, path);
    return NextResponse.json({ ok: true, ...result, container, path });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status },
    );
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const container = body?.container || '';
  const path = body?.path || '';
  const tier: BlobAccessTier = body?.tier;

  if (!container || !path) {
    return NextResponse.json({ ok: false, error: 'container and path are required' }, { status: 400 });
  }
  if (!(KNOWN_CONTAINERS as readonly string[]).includes(container)) {
    return NextResponse.json({ ok: false, error: `unknown container: ${container}` }, { status: 404 });
  }
  if (!VALID_TIERS.includes(tier)) {
    return NextResponse.json({ ok: false, error: `tier must be one of: ${VALID_TIERS.join(', ')}` }, { status: 400 });
  }

  try {
    // Read the current tier to pick the safe direction.
    const current = await getBlobTier(container as KnownContainer, path);
    const currentTier = current.tier;

    // Archive requires multi-hour rehydration; not changeable from this dialog.
    if (currentTier === 'Archive') {
      return NextResponse.json(
        { ok: false, error: 'Source blob is in the Archive tier; rehydration is required before re-tiering and is not supported from this dialog.' },
        { status: 409 },
      );
    }

    // Upgrade (cooler → Hot): use Copy Blob to avoid the early-deletion penalty.
    if (tier === 'Hot' && currentTier && currentTier !== 'Hot') {
      const result = await copyBlobToTier(container as KnownContainer, path, 'Hot');
      return NextResponse.json({ ok: true, ...result, container, path });
    }

    // Downgrade / same-or-cooler: Set Blob Tier (Hot→Cool/Cold, Cool→Cold).
    const result = await setBlobTier(container as KnownContainer, path, tier as 'Cool' | 'Cold');
    return NextResponse.json({ ok: true, ...result, container, path });
  } catch (e: any) {
    const status = e?.statusCode === 404 ? 404 : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status },
    );
  }
}
