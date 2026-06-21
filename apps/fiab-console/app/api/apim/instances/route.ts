/**
 * GET /api/apim/instances — lists APIM service instances visible to the
 * Loom UAMI across the admin RG (and DLZ RG if APIM lives there).
 *
 * Returns shape: { ok, instances:[{name, location, sku, gatewayUrl, state}] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credential = uamiArmCredential();

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) return NextResponse.json({
    ok: false, error: 'LOOM_SUBSCRIPTION_ID not set',
  }, { status: 503 });

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
}
