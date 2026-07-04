/**
 * GET  /api/tenant-theme — returns the calling tenant's brand overrides
 *                          (accent color, brand name, logo URL).
 * PUT  /api/tenant-theme — admin-only; persists overrides to Cosmos.
 *
 * Shape: { accent: '#3d2e80', brandName: 'CSA Loom', logoUrl?: '...' }
 *
 * Used by <TenantThemeBridge /> in app/layout.tsx — fetches once on first
 * render, injects CSS vars on :root so the rest of the UI re-paints with
 * the tenant's accent without a code change.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantThemesContainer } from '@/lib/azure/cosmos-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Theme {
  id: string;
  tenantId: string;
  accent?: string;
  brandName?: string;
  logoUrl?: string;
  updatedAt: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const c = await tenantThemesContainer();
    const { resource } = await c.item(tenantId, tenantId).read<Theme>();
    return NextResponse.json({ ok: true, theme: resource || null });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true, theme: null });
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));

  const accent = body?.accent ? String(body.accent) : undefined;
  if (accent && !HEX.test(accent)) {
    return NextResponse.json({ ok: false, error: 'accent must be #RRGGBB' }, { status: 400 });
  }
  const brandName = body?.brandName ? String(body.brandName).slice(0, 60) : undefined;
  const logoUrl = body?.logoUrl ? String(body.logoUrl).slice(0, 500) : undefined;

  const theme: Theme = {
    id: tenantId, tenantId,
    accent, brandName, logoUrl,
    updatedAt: new Date().toISOString(),
  };
  try {
    const c = await tenantThemesContainer();
    await c.items.upsert(theme);
    return NextResponse.json({ ok: true, theme });
  } catch (e: any) {
    return apiServerError(e);
  }
}
