/**
 * Inbound protection (private endpoint) for the workspace Advanced networking pane.
 *
 *   GET  /api/admin/workspaces/[id]/networking/inbound
 *          → { ok, enabled, pe: PeStatus|null, peConfigured }
 *   POST /api/admin/workspaces/[id]/networking/inbound
 *          body { enable: true, privateLinkServiceId, groupIds[], location, dnsZoneId? }
 *            → creates a REAL private endpoint (+ optional DNS zone group)
 *          body { enable: false }
 *            → deletes the workspace inbound private endpoint
 *
 * Backend: Microsoft.Network/privateEndpoints over ARM (real PUT/GET/DELETE).
 * Azure-native — NO Fabric dependency. Honest gates per _gate.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getPrivateEndpoint, createPrivateEndpoint, deletePrivateEndpoint,
  createPrivateDnsZoneGroup, inboundPeName, readNetworkingConfig,
} from '@/lib/clients/networking-client';
import { networkingErrorResponse, authorizeNetworking } from '../_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await authorizeNetworking(ctx);
  if (g.resp) return g.resp;
  const { id } = g;
  try {
    const cfg = readNetworkingConfig();
    const pe = await getPrivateEndpoint(inboundPeName(id));
    return NextResponse.json({
      ok: true,
      enabled: !!pe,
      pe,
      peConfigured: !!cfg.peSubnetId,
    });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await authorizeNetworking(ctx);
  if (g.resp) return g.resp;
  const { id } = g;
  const body = await req.json().catch(() => ({}));
  const enable = body?.enable !== false;
  const peName = inboundPeName(id);

  try {
    if (!enable) {
      await deletePrivateEndpoint(peName);
      return NextResponse.json({ ok: true, enabled: false });
    }
    const privateLinkServiceId = String(body?.privateLinkServiceId || '').trim();
    if (!privateLinkServiceId) {
      return NextResponse.json({ ok: false, error: 'privateLinkServiceId required' }, { status: 400 });
    }
    const groupIds = Array.isArray(body?.groupIds) ? body.groupIds.map(String).filter(Boolean) : [];
    if (groupIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'at least one groupId required' }, { status: 400 });
    }
    const location = String(body?.location || process.env.LOOM_LOCATION || '').trim();
    if (!location) {
      return NextResponse.json({ ok: false, error: 'location required (set body.location or LOOM_LOCATION)' }, { status: 400 });
    }
    const pe = await createPrivateEndpoint({
      name: peName, location, privateLinkServiceId, groupIds,
      requestMessage: `Loom workspace ${id} inbound protection`,
    });
    // Optional: register the FQDN in a hub private DNS zone so it resolves to
    // the PE private IP. Best-effort — surface the error but keep the PE.
    let dnsRegistered = false;
    const dnsZoneId = typeof body?.dnsZoneId === 'string' ? body.dnsZoneId.trim() : '';
    if (dnsZoneId) {
      try { await createPrivateDnsZoneGroup(peName, dnsZoneId); dnsRegistered = true; }
      catch { dnsRegistered = false; }
    }
    return NextResponse.json({ ok: true, enabled: true, pe, dnsRegistered });
  } catch (e) {
    return networkingErrorResponse(e);
  }
}
