/**
 * GET /api/network/pbi-gateway
 *
 * Real read-only status of the Power BI VM-based ON-PREMISES data gateway that
 * CSA Loom deploys by default (admin-plane/pbi-vm-data-gateway.bicep) so Power BI
 * reaches Loom's private-endpoint data sources with NO public route (Weave→Power
 * BI D2). Reports (Reader-only ARM):
 *   - whether the gateway VM is deployed + its live power state (running/stopped),
 *   - the active gateway mode (LOOM_PBI_GATEWAY_MODE) + whether a Fabric/Premium
 *     capacity is bound (LOOM_PBI_CAPACITY_ID) → the recommended gateway
 *     (VM now, managed VNet gateway once a capacity binds — the auto-upgrade),
 *   - the ONE genuinely-manual step (register-to-tenant needs a Power BI admin
 *     sign-in) as an honest note — never faked (no-vaporware.md).
 *
 * Honest gate: when the Console identity can't enumerate subscriptions, returns
 * ok:false with the exact Reader role to grant.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getPbiVmGatewayStatus, NetworkDiscoveryError,
} from '@/lib/azure/network-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const status = await getPbiVmGatewayStatus();
    return NextResponse.json({ ok: true, status });
  } catch (e: any) {
    const code = e instanceof NetworkDiscoveryError ? e.status : 502;
    const remediation =
      'The Console identity must read the subscription to detect the Power BI data-gateway VM. ' +
      'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Reader role on the subscription ' +
      '(Microsoft.Compute/virtualMachines/read + .../instanceView/read), then reload.';
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
      gate: {
        reason: 'CSA Loom reads the Power BI on-prem data-gateway VM status over ARM (read-only).',
        remediation,
      },
    }, { status: code === 401 || code === 403 ? 200 : code });
  }
}
