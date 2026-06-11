/**
 * GET /api/network/vnet-data-gateway
 *
 * Honest read-only status of the Virtual Network (VNet) data gateway TENANT
 * gate. A VNet data gateway is a Microsoft Fabric / Power Platform tenant
 * capability — NOT an Azure resource CSA Loom provisions (per
 * no-fabric-dependency.md). This route reports ONLY what Loom can truthfully
 * detect from Azure (Reader-only): the `Microsoft.PowerPlatform` resource-
 * provider registration + any subnet delegated to
 * `Microsoft.PowerPlatform/vnetaccesslinks`. The remaining prerequisites
 * (Premium/Fabric capacity, the "Manage gateway installers" tenant switch, the
 * gateway create in the Fabric/Power BI portal) are surfaced as honest
 * "tenant-managed" steps — never faked as enabled, and Loom exposes NO create
 * control. The Azure-native default (private endpoints) is the supported path.
 *
 * Honest gate (no-vaporware): when the Console identity can't enumerate
 * subscriptions, returns ok:false with the exact Reader role to grant.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getVnetDataGatewayReadiness, NetworkDiscoveryError,
} from '@/lib/azure/network-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const readiness = await getVnetDataGatewayReadiness();
    return NextResponse.json({ ok: true, readiness });
  } catch (e: any) {
    const status = e instanceof NetworkDiscoveryError ? e.status : 502;
    const reader =
      'The Console identity must read the subscription to detect VNet-gateway prerequisites. ' +
      'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Reader role on the subscription ' +
      '(Microsoft.PowerPlatform/register/action visibility + Microsoft.Network/virtualNetworks/read), then reload.';
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
      gate: {
        reason: 'CSA Loom reads the Azure-side VNet data gateway prerequisites over ARM (read-only).',
        remediation: reader,
      },
    }, { status: status === 401 || status === 403 ? 200 : status });
  }
}
