/**
 * GET /api/setup/existing-storage
 *   Discovers existing HNS-enabled (Data Lake / ADLS Gen2) storage accounts the
 *   Console identity can see, via Azure Resource Graph:
 *
 *     POST {arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01
 *       query: resources
 *              | where type =~ 'microsoft.storage/storageaccounts'
 *              | where properties.isHnsEnabled == true
 *
 *   These are the accounts that could back the CSA Loom medallion lakehouse +
 *   the org-visuals container (Embed codes F22 + Organizational visuals F23).
 *   Powers the Setup Wizard's Storage scan-and-choose card (use-existing /
 *   provision-new / disable) — the SAME three-way choice the CLI
 *   scripts/csa-loom/scan/storage.sh offers.
 *
 *   RECOMMENDATION = provision-new: Loom needs the exact container layout
 *   (bronze/silver/gold/landing/checkpoints/csv-imports/org-visuals); an
 *   arbitrary existing account rarely matches, so a fresh account is the safe
 *   default. The wizard surfaces existing accounts only so an operator who
 *   already has a Loom-shaped lake can reuse it (existingLoomStorageAccount).
 *
 *   Resource Graph honours RBAC — only accounts in scopes where the principal
 *   has at least Reader come back. No mock data — when none are visible the list
 *   is genuinely empty and the wizard recommends provision-new (no-vaporware.md).
 *
 * Response shape:
 *   { ok: true,  accounts: [{ name, subscriptionId, rg, location, isLoomNamed }], recommendation: 'provision-new' }
 *   { ok: false, error, hint? }
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';
import { uamiArmCredential } from '@/lib/azure/arm-credential';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const credential = uamiArmCredential();

interface ExistingStorageAccount {
  name: string;
  subscriptionId: string;
  rg: string;
  location: string;
  /** A `saloom*` account is almost certainly a Loom-shaped lake (safe to reuse). */
  isLoomNamed: boolean;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const arm = armBase();
  let token: string;
  try {
    const t = await credential.getToken(`${arm}/.default`);
    if (!t?.token) throw new Error('empty token');
    token = t.token;
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `auth failed: ${e?.message ?? String(e)}`,
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI Reader on the subscriptions whose storage accounts you want to discover.',
      },
      { status: 502 },
    );
  }

  try {
    const res = await fetch(
      `${arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            "resources | where type =~ 'microsoft.storage/storageaccounts' " +
            '| where properties.isHnsEnabled == true ' +
            '| project name, subscriptionId, resourceGroup, location ' +
            '| order by name asc',
        }),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return NextResponse.json(
        { ok: false, error: `Resource Graph ${res.status}: ${t.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const j: any = await res.json();
    const rows = (j?.data || []) as any[];
    const accounts: ExistingStorageAccount[] = rows.map((row) => ({
      name: row.name,
      subscriptionId: row.subscriptionId,
      rg: row.resourceGroup,
      location: row.location || '',
      isLoomNamed: typeof row.name === 'string' && row.name.startsWith('saloom'),
    }));
    // provision-new is always the recommendation: Loom needs its exact container
    // layout, so a fresh account is safest even when existing lakes are present.
    return NextResponse.json({ ok: true, accounts, recommendation: 'provision-new' });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Resource Graph request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }
}
