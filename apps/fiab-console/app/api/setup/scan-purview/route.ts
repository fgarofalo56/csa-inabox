/**
 * GET /api/setup/scan-purview
 *
 * Governance deploy-readiness (#229): discovers existing Microsoft Purview
 * (classic Data Map) accounts across every subscription the Console identity can
 * see, via Azure Resource Graph, and returns a RECOMMENDATION so the Setup Wizard
 * can offer use-existing / provision-new / disable for governance — mirroring the
 * CLI scan-and-deploy.sh / byo-wizard purview row.
 *
 * Resource Graph honours RBAC — only accounts in scopes where the principal has
 * at least Reader come back. No mock data: an empty list is a genuine "none
 * found" (per no-vaporware.md).
 *
 * Recommendation:
 *   • 0 existing  → provision-new (Azure-native governance ON by default)
 *   • 1 existing  → use-existing (reuse the single account; avoids a 2nd one)
 *   • N existing  → use-existing (pick one; classic accounts can coexist)
 *
 * Response:
 *   { ok: true, existing: [{ account, rg, sub, location }], recommendation }
 *   { ok: false, error, hint? }
 */
import { NextResponse } from 'next/server';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

interface ExistingPurview {
  account: string;
  rg: string;
  sub: string;
  location: string;
}

type PurviewRecommendation = 'provision-new' | 'use-existing';

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
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI Reader on the subscriptions whose Purview accounts you want to discover.',
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
            "Resources | where type =~ 'Microsoft.Purview/accounts' " +
            '| project name, resourceGroup, subscriptionId, location ' +
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
    const existing: ExistingPurview[] = rows.map((row) => ({
      account: row.name,
      rg: row.resourceGroup,
      sub: row.subscriptionId,
      location: row.location || '',
    }));
    const recommendation: PurviewRecommendation =
      existing.length === 0 ? 'provision-new' : 'use-existing';
    return NextResponse.json({ ok: true, existing, recommendation });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Resource Graph request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }
}
