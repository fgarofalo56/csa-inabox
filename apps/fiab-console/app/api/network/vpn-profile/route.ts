/**
 * GET  /api/network/vpn-profile  → P2S VPN gateway status (ready/provisioning,
 *                                   client pool, auth, reachable VNet ranges).
 * POST /api/network/vpn-profile  → generate + return the VPN client profile
 *                                   download URL (the Azure VPN Client config zip).
 *
 * Powers the admin Network & DNS "VPN access" card. Honest gate (no-vaporware):
 * if no VPN gateway exists yet (or it's still provisioning), the GET says so and
 * POST returns a clear message rather than failing opaquely.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { findVpnGateway, generateVpnProfile, NetworkDiscoveryError } from '@/lib/azure/network-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const gw = await findVpnGateway();
    return NextResponse.json({ ok: true, gateway: gw });
  } catch (e: any) {
    if (e instanceof NetworkDiscoveryError && e.status === 403) {
      return NextResponse.json(
        { ok: false, error: e.message, hint: 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Reader role on the subscription holding the VPN gateway.' },
        { status: 403 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 500 });
  }
}

export async function POST() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const gw = await findVpnGateway();
    if (!gw.found) {
      return NextResponse.json(
        { ok: false, gated: true, error: 'No point-to-site VPN gateway is provisioned for this deployment.', hint: 'Deploy the VPN gateway (platform/fiab/bicep/modules/admin-plane/vpn-gateway.bicep) — it is part of day-one config.' },
        { status: 501 },
      );
    }
    if (!gw.ready) {
      return NextResponse.json(
        { ok: false, gated: true, error: `VPN gateway is still provisioning (${gw.provisioningState}). This takes ~30–45 minutes on first deploy.`, gateway: gw },
        { status: 409 },
      );
    }
    const profileUrl = await generateVpnProfile(gw.id!);
    return NextResponse.json({ ok: true, profileUrl, gateway: gw });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 500 });
  }
}
