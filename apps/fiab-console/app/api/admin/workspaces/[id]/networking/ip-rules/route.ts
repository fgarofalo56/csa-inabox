/**
 * IP firewall (NSG security rules) for the workspace Advanced networking pane.
 *
 *   GET    /api/admin/workspaces/[id]/networking/ip-rules
 *            → { ok, rules: NsgRule[] }
 *   POST   /api/admin/workspaces/[id]/networking/ip-rules
 *            body { cidr, direction, access, protocol?, description? }
 *            → { ok, rule }  (writes a REAL NSG security rule via ARM)
 *   DELETE /api/admin/workspaces/[id]/networking/ip-rules?ruleName=...
 *            → { ok }
 *
 * Backend: Microsoft.Network/networkSecurityGroups/securityRules over ARM
 * (real PUT/DELETE). Azure-native — NO Fabric dependency. Honest gates:
 *   - env unset → 503 (NetworkingNotConfiguredError)
 *   - UAMI lacks Network Contributor → ARM 403 surfaced with the exact role
 *   - invalid CIDR → 400 (no ARM call made)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listNsgRules, addIpFirewallRule, deleteNsgRule } from '@/lib/clients/networking-client';
import { networkingErrorResponse } from '../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  await ctx.params; // workspace id reserved for future per-workspace scoping
  try {
    const rules = await listNsgRules();
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
  const cidr = String(body?.cidr || '').trim();
  const direction = body?.direction === 'Outbound' ? 'Outbound' : 'Inbound';
  const access = body?.access === 'Deny' ? 'Deny' : 'Allow';
  const protocol = ['*', 'Tcp', 'Udp', 'Icmp'].includes(body?.protocol) ? body.protocol : '*';
  if (!cidr) return NextResponse.json({ ok: false, error: 'cidr required' }, { status: 400 });
  try {
    const rule = await addIpFirewallRule(id, {
      cidr, direction, access, protocol,
      description: typeof body?.description === 'string' ? body.description : undefined,
    });
    return NextResponse.json({ ok: true, rule });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  await ctx.params;
  const ruleName = req.nextUrl.searchParams.get('ruleName')
    || (await req.json().catch(() => ({})))?.ruleName;
  if (!ruleName) return NextResponse.json({ ok: false, error: 'ruleName required' }, { status: 400 });
  try {
    await deleteNsgRule(String(ruleName));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}
