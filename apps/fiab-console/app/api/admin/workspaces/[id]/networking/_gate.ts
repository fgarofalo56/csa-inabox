/**
 * Shared honest-gate error mapper for the Advanced networking BFF routes.
 *
 * Maps the networking-client error classes to structured `{ ok:false, ... }`
 * responses per no-vaporware.md:
 *   - NetworkingNotConfiguredError → 503 + the exact env var(s) to set
 *   - NetworkingArmError 401/403   → 403 + the exact Network Contributor role to
 *                                    grant the Console UAMI (honest infra gate;
 *                                    HTTP 403 so the UI renders a MessageBar)
 *   - NetworkingArmError 400/404/409 → pass through the ARM status
 *   - anything else → 502
 */
import { NextResponse } from 'next/server';
import { NetworkingNotConfiguredError, NetworkingArmError } from '@/lib/clients/networking-client';

/** Network Contributor built-in role definition id. */
export const NETWORK_CONTRIBUTOR_ROLE_ID = '4d97b98b-1d4f-4787-a291-c67834d212e7';

export function networkingErrorResponse(e: unknown): NextResponse {
  if (e instanceof NetworkingNotConfiguredError) {
    return NextResponse.json({
      ok: false,
      error: `Advanced networking not configured: set ${e.missing.join(' / ')}.`,
      gate: {
        reason: 'The Azure-native networking pane writes NSG rules + private endpoints over Azure Resource Manager.',
        remediation: `Set ${e.missing.join(' + ')} on the Console (network.bicep wires these from the hub VNet). No Microsoft Fabric required.`,
        missing: e.missing,
      },
    }, { status: 503 });
  }
  if (e instanceof NetworkingArmError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Resource Manager ${e.status}: not authorized to manage networking.`,
      gate: {
        reason: 'The Console UAMI needs rights to write NSG security rules + create private endpoints on the networking resource group.',
        remediation: 'Grant the Console UAMI "Network Contributor" on LOOM_NETWORKING_RG (network.bicep does this when consolePrincipalId is wired).',
        roleId: NETWORK_CONTRIBUTOR_ROLE_ID,
      },
    }, { status: 403 });
  }
  if (e instanceof NetworkingArmError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json({ ok: false, error: e.message }, { status });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ ok: false, error: msg }, { status: 502 });
}
