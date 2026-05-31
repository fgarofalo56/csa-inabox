/**
 * Shared APIM provisioning gate for the API Marketplace BFF routes.
 *
 * The marketplace is a consumer/catalog view over the tenant's Azure API
 * Management instance. If APIM isn't configured for this deployment we return
 * a structured 503 the UI renders as a Fluent MessageBar (intent="warning")
 * naming the exact env vars / resource to provision — per no-vaporware.md.
 * The full UI surface still renders behind the gate.
 */
import { NextResponse } from 'next/server';

export interface ApimGate {
  configured: boolean;
  apimName?: string;
  resourceGroup?: string;
  subscriptionId?: string;
  /** Human-readable reason + the precise remediation when not configured. */
  reason?: string;
  hint?: string;
  bicepModule?: string;
}

export function apimGate(): ApimGate {
  const apimName = process.env.LOOM_APIM_NAME;
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  const resourceGroup = process.env.LOOM_APIM_RG || 'rg-csa-loom-admin-eastus2';
  if (!apimName || !subscriptionId) {
    const missing = [
      !apimName ? 'LOOM_APIM_NAME' : null,
      !subscriptionId ? 'LOOM_SUBSCRIPTION_ID' : null,
    ].filter(Boolean).join(', ');
    return {
      configured: false,
      apimName,
      resourceGroup,
      subscriptionId,
      reason: 'Azure API Management is not provisioned for this deployment.',
      hint: `Provision APIM and set ${missing} on loom-console (the APIM service name + the subscription it lives in). The Loom Console UAMI also needs the "API Management Service Contributor" role at the APIM scope (scripts/csa-loom/grant-apim-rbac.sh).`,
      bicepModule: 'platform/fiab/bicep/modules/admin-plane/apim.bicep',
    };
  }
  return { configured: true, apimName, resourceGroup, subscriptionId };
}

/** Returns a 503 gate response when APIM isn't configured, else null. */
export function gateResponse(gate: ApimGate): NextResponse | null {
  if (gate.configured) return null;
  return NextResponse.json(
    {
      ok: false,
      gated: true,
      error: gate.reason,
      hint: gate.hint,
      bicepModule: gate.bicepModule,
    },
    { status: 503 },
  );
}
