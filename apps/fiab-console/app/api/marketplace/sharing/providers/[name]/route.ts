/**
 * GET    /api/marketplace/sharing/providers/[name]   → provider + the shares it exposes to us
 * POST   /api/marketplace/sharing/providers/[name]   → mount a share as a read-only catalog
 *          body { action:'mount', share_name, catalog_name }
 * DELETE /api/marketplace/sharing/providers/[name]   → remove the inbound provider
 *
 * Mounting calls UC createCatalog({ provider_name, share_name }) — the inbound
 * consumer side of Delta Sharing: the recipient subscribes to a provider's
 * share and it appears as a live, read-only catalog (no data copy).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getProvider, listProviderShares, deleteProvider, createCatalog,
} from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = decodeURIComponent((await ctx.params).name);
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const [provider, shares] = await Promise.all([
      getProvider(host, name),
      listProviderShares(host, name).catch(() => []),
    ]);
    return NextResponse.json({ ok: true, host, provider, shares });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const providerName = decodeURIComponent((await ctx.params).name);
    const body = await req.json().catch(() => ({}));
    const host = await resolveShareHost(body?.host);
    if (body?.action !== 'mount') {
      return NextResponse.json({ ok: false, error: "unsupported action (expected 'mount')" }, { status: 400 });
    }
    const shareName = String(body?.share_name || '').trim();
    const catalogName = String(body?.catalog_name || '').trim();
    if (!shareName || !catalogName) {
      return NextResponse.json({ ok: false, error: 'share_name and catalog_name are required' }, { status: 400 });
    }
    const catalog = await createCatalog(host, {
      name: catalogName,
      provider_name: providerName,
      share_name: shareName,
      comment: `Subscribed via Loom Marketplace from share ${providerName}.${shareName}`,
    });
    return NextResponse.json({ ok: true, host, catalog });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = decodeURIComponent((await ctx.params).name);
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    await deleteProvider(host, name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}
