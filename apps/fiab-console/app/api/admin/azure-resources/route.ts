/**
 * GET /api/admin/azure-resources — lists every Azure resource in the
 * configured Loom resource groups via Azure Resource Manager.
 *
 * Replaces the previous hardcoded /admin/capacity table per .claude/rules/
 * no-vaporware.md. Names, types, regions, and provisioning states are
 * real ARM-returned values. Cost/utilization are NOT shown — that needs
 * Cost Management + Azure Monitor + Sustainability, which is a separate
 * piece of work; the page surfaces a MessageBar saying so honestly.
 *
 * Env vars consumed:
 *   LOOM_SUBSCRIPTION_ID   (default: pulled from MSAL tenant if not set)
 *   LOOM_ADMIN_RG          (default: rg-csa-loom-admin-eastus2)
 *   LOOM_DLZ_RG            (default: rg-csa-loom-dlz-single-eastus2)
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

interface ArmResource {
  id: string;
  name: string;
  type: string;
  location: string;
  kind?: string;
  sku?: { name?: string; tier?: string };
  properties?: any;
}

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) {
    return NextResponse.json({
      ok: false, error: 'LOOM_SUBSCRIPTION_ID not configured',
      hint: 'Set LOOM_SUBSCRIPTION_ID on the loom-console container app.',
    }, { status: 503 });
  }

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

  const all: Array<ArmResource & { resourceGroup: string }> = [];
  const errors: string[] = [];

  for (const rg of rgs) {
    try {
      const url = `${armBase()}/subscriptions/${sub}/resourceGroups/${rg}/resources?api-version=2024-03-01&$expand=provisioningState`;
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const t = await r.text();
        errors.push(`${rg}: ${r.status} ${t.slice(0, 120)}`);
        continue;
      }
      const j: any = await r.json();
      for (const item of (j.value || []) as ArmResource[]) {
        all.push({ ...item, resourceGroup: rg });
      }
    } catch (e: any) {
      errors.push(`${rg}: ${e?.message}`);
    }
  }

  // Shape for the UI: trim to fields we actually render.
  const resources = all.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type,
    location: r.location,
    resourceGroup: r.resourceGroup,
    sku: r.sku?.name || r.sku?.tier,
    kind: r.kind,
    provisioningState: r.properties?.provisioningState,
  })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  // Group counts by Azure provider for the summary cards.
  const byProvider: Record<string, number> = {};
  for (const r of resources) {
    const provider = r.type.split('/')[0].replace('Microsoft.', '');
    byProvider[provider] = (byProvider[provider] || 0) + 1;
  }

  return NextResponse.json({
    ok: true,
    subscription: sub,
    resourceGroups: rgs,
    totalResources: resources.length,
    byProvider,
    resources,
    errors,
  });
}
