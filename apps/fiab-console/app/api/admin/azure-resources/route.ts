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
 *   LOOM_SUBSCRIPTION_ID       (admin-plane subscription)
 *   LOOM_DLZ_SUBSCRIPTION_ID   (DLZ subscription; falls back to LOOM_SUBSCRIPTION_ID for single-sub)
 *   LOOM_ADMIN_RG              (default: rg-csa-loom-admin-eastus2)
 *   LOOM_DLZ_RG               (default: rg-csa-loom-dlz-single-eastus2)
 *
 * In a multi-sub topology the DLZ RG lives in a DIFFERENT subscription than the
 * admin RG, so each RG must be paired with its OWN subscription when building the
 * ARM URL — otherwise the DLZ RG returns 404 ResourceGroupNotFound.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credential = uamiArmCredential();

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

  // The DLZ RG may live in a different subscription than the admin RG in a
  // multi-sub topology. Pair each RG with its correct subscription; fall back to
  // the admin sub when LOOM_DLZ_SUBSCRIPTION_ID is unset (single-sub deploy).
  const dlzSub = process.env.LOOM_DLZ_SUBSCRIPTION_ID || sub;
  const rgPairs: Array<{ rg: string; sub: string }> = [
    { rg: process.env.LOOM_ADMIN_RG || 'rg-csa-loom-admin-eastus2', sub },
    { rg: process.env.LOOM_DLZ_RG || 'rg-csa-loom-dlz-single-eastus2', sub: dlzSub },
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

  for (const { rg, sub: rgSub } of rgPairs) {
    try {
      const url = `${armBase()}/subscriptions/${rgSub}/resourceGroups/${rg}/resources?api-version=2024-03-01&$expand=provisioningState`;
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
    resourceGroups: rgPairs.map(p => p.rg),
    subscriptions: rgPairs.map(p => ({ resourceGroup: p.rg, subscription: p.sub })),
    totalResources: resources.length,
    byProvider,
    resources,
    errors,
  });
}
