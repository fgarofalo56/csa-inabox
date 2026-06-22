/**
 * GET    /api/marketplace/sharing/recipients/[name]   → recipient + activation token(s)
 * DELETE /api/marketplace/sharing/recipients/[name]   → delete the recipient
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getRecipient, deleteRecipient } from '@/lib/azure/unity-catalog-client';
import { resolveShareHost, sharingErrorResponse } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const name = decodeURIComponent((await ctx.params).name);
    const host = await resolveShareHost(req.nextUrl.searchParams.get('host'));
    const recipient = await getRecipient(host, name);
    return NextResponse.json({ ok: true, host, recipient });
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
    await deleteRecipient(host, name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return sharingErrorResponse(e);
  }
}
