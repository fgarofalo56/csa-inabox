/**
 * Outbound access rules for the workspace Advanced networking pane.
 *
 *   GET    /api/admin/workspaces/[id]/networking/outbound
 *            → { ok, rules: OutboundRule[] }
 *   POST   /api/admin/workspaces/[id]/networking/outbound
 *            body { targetResourceId, groupIds[], location? }
 *            → creates a REAL outbound private endpoint to the target resource
 *   DELETE /api/admin/workspaces/[id]/networking/outbound?ruleId=...
 *            → deletes the private endpoint + removes the rule
 *
 * Backend: Microsoft.Network/privateEndpoints over ARM + Cosmos registry.
 * Azure-native — NO Fabric dependency. Honest gates per _gate.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listOutboundRules, addOutboundPeRule, removeOutboundRule } from '@/lib/clients/networking-client';
import { networkingErrorResponse } from '../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const rules = await listOutboundRules(id);
    return NextResponse.json({ ok: true, rules });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const targetResourceId = String(body?.targetResourceId || '').trim();
  if (!targetResourceId) return NextResponse.json({ ok: false, error: 'targetResourceId required' }, { status: 400 });
  const groupIds = Array.isArray(body?.groupIds) ? body.groupIds.map(String).filter(Boolean) : [];
  if (groupIds.length === 0) return NextResponse.json({ ok: false, error: 'at least one groupId required' }, { status: 400 });
  const location = String(body?.location || process.env.LOOM_LOCATION || '').trim();
  if (!location) return NextResponse.json({ ok: false, error: 'location required (set body.location or LOOM_LOCATION)' }, { status: 400 });
  try {
    const rule = await addOutboundPeRule(id, { targetResourceId, groupIds, location });
    return NextResponse.json({ ok: true, rule });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const ruleId = req.nextUrl.searchParams.get('ruleId')
    || (await req.json().catch(() => ({})))?.ruleId;
  if (!ruleId) return NextResponse.json({ ok: false, error: 'ruleId required' }, { status: 400 });
  try {
    await removeOutboundRule(id, String(ruleId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}
