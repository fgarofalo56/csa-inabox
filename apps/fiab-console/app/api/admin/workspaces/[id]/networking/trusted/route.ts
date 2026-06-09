/**
 * Trusted instances (IP allowlist) for the workspace Advanced networking pane.
 *
 *   GET    /api/admin/workspaces/[id]/networking/trusted
 *            → { ok, instances: TrustedInstance[] }
 *   POST   /api/admin/workspaces/[id]/networking/trusted
 *            body { label, ipCidr, direction }
 *            → writes a REAL NSG allow-rule + records the allowlist entry
 *   DELETE /api/admin/workspaces/[id]/networking/trusted?instanceId=...
 *            → deletes the NSG rule + removes the allowlist entry
 *
 * Backend: Microsoft.Network NSG security rules over ARM + Cosmos registry.
 * Azure-native — NO Fabric dependency. Honest gates per _gate.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listTrustedInstances, addTrustedInstance, removeTrustedInstance } from '@/lib/clients/networking-client';
import { networkingErrorResponse } from '../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const instances = await listTrustedInstances(id);
    return NextResponse.json({ ok: true, instances });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const label = String(body?.label || '').trim();
  const ipCidr = String(body?.ipCidr || '').trim();
  const direction = body?.direction === 'Outbound' ? 'Outbound' : 'Inbound';
  if (!label) return NextResponse.json({ ok: false, error: 'label required' }, { status: 400 });
  if (!ipCidr) return NextResponse.json({ ok: false, error: 'ipCidr required' }, { status: 400 });
  try {
    const instance = await addTrustedInstance(id, { label, ipCidr, direction });
    return NextResponse.json({ ok: true, instance });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const instanceId = req.nextUrl.searchParams.get('instanceId')
    || (await req.json().catch(() => ({})))?.instanceId;
  if (!instanceId) return NextResponse.json({ ok: false, error: 'instanceId required' }, { status: 400 });
  try {
    await removeTrustedInstance(id, String(instanceId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}
