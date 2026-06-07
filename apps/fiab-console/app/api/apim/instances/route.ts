/**
 * GET /api/apim/instances — lists APIM service instances visible to the
 * Loom UAMI across the admin RG (and DLZ RG if APIM lives there).
 *
 * Returns shape: { ok, instances:[{name, location, sku, gatewayUrl, state}] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ChainedTokenCredential, ManagedIdentityCredential, DefaultAzureCredential } from '@azure/identity';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credential = new ChainedTokenCredential(
  ...(process.env.LOOM_UAMI_CLIENT_ID
    ? [new ManagedIdentityCredential({ clientId: process.env.LOOM_UAMI_CLIENT_ID })]
    : []),
  new DefaultAzureCredential(),
);

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) return NextResponse.json({
    ok: false, error: 'LOOM_SUBSCRIPTION_ID not set',
  }, { status: 503 });

  const rgs = [
    process.env.LOOM_ADMIN_RG || 'rg-csa-loom-admin-eastus2',
    process.env.LOOM_DLZ_RG || 'rg-csa-loom-dlz-single-eastus2',
  ];

  let token: string;
  try {
    const t = await credential.getToken(armScope());
    token = t!.token;
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `auth failed: ${e?.message}` }, { status: 502 });
  }

  const instances: any[] = [];
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
        instances.push({
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

  return NextResponse.json({ ok: true, instances, errors });
}
