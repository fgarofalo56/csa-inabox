/**
 * GET /api/apim/instances — lists APIM service instances visible to the
 * Loom UAMI across the admin RG (and DLZ RG if APIM lives there).
 *
 * Returns shape: { ok, instances:[{name, location, sku, gatewayUrl, state}] }
 */
import { NextResponse } from 'next/server';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credential = uamiArmCredential();

// WS-D1: session-only route adopted onto `withSession`. WS-D2: the bespoke
// LOOM_SUBSCRIPTION_ID 503 normalized onto the shared svc-apim gate envelope
// (same check, same 503, back-compat error mirror preserved).
export const GET = withSession(async () => {
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) return apiHonestGateError('svc-apim', {
    missing: ['LOOM_SUBSCRIPTION_ID'],
    message: 'LOOM_SUBSCRIPTION_ID not set',
  });

  // Dedupe the RGs: in single-RG deployments LOOM_ADMIN_RG === LOOM_DLZ_RG, which
  // previously enumerated the same APIM twice (audit B7). Compare case-insensitively
  // (ARM RG names are case-insensitive) while preserving the original casing.
  const rgs = Array.from(
    new Map(
      [
        process.env.LOOM_ADMIN_RG || 'rg-csa-loom-admin-eastus2',
        process.env.LOOM_DLZ_RG || 'rg-csa-loom-dlz-single-eastus2',
      ].map((rg) => [rg.toLowerCase(), rg]),
    ).values(),
  );

  let token: string;
  try {
    const t = await credential.getToken(armScope());
    token = t!.token;
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `auth failed: ${e?.message}` }, { status: 502 });
  }

  // Dedupe instances by ARM resourceId — guards against the same APIM surfacing
  // from overlapping RGs even if the RG list were not already deduped (audit B7).
  const byId = new Map<string, any>();
  const errors: string[] = [];

  for (const rg of rgs) {
    try {
      const url = `${armBase()}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.ApiManagement/service?api-version=2024-05-01`;
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const t = await r.text();
        errors.push(`${rg}: ${r.status} ${t.slice(0, 100)}`);
        continue;
      }
      const j: any = await r.json();
      for (const apim of (j.value || []) as any[]) {
        const id = String(apim.id || `${rg}/${apim.name}`).toLowerCase();
        if (byId.has(id)) continue;
        byId.set(id, {
          id: apim.id,
          name: apim.name,
          location: apim.location,
          resourceGroup: rg,
          sku: apim.sku?.name,
          gatewayUrl: apim.properties?.gatewayUrl,
          state: apim.properties?.provisioningState,
        });
      }
    } catch (e: any) {
      errors.push(`${rg}: ${e?.message}`);
    }
  }

  return NextResponse.json({ ok: true, instances: Array.from(byId.values()), errors });
});
