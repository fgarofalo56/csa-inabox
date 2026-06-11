/**
 * GET /api/setup/existing-dlzs
 *   Discovers already-deployed CSA Loom Data Landing Zones across every
 *   subscription the Console identity can see, via Azure Resource Graph:
 *
 *     POST {arm}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01
 *       query: ResourceContainers
 *              | where type == 'microsoft.resources/subscriptions/resourcegroups'
 *              | where name startswith 'rg-csa-loom-dlz-'
 *
 *   Resource Graph honours RBAC — only RGs in scopes where the principal has at
 *   least Reader come back. Each DLZ resource-group name encodes its coordinates
 *   (`rg-csa-loom-dlz-<domain>-<region>`), which we parse into the shape the
 *   Setup Wizard's multi-sub "wire existing" path needs.
 *
 *   This powers Route B of multi-sub mode: the operator picks one or more
 *   existing DLZs to wire into the Admin Plane (POST /api/setup/wire-existing)
 *   WITHOUT re-deploying. No mock data — when the principal can see no DLZ RGs,
 *   the list is genuinely empty and the wizard says so (per no-vaporware.md).
 *
 * Response shape:
 *   { ok: true,  dlzs: [{ subscriptionId, subscriptionName, domainName, region, rg }] }
 *   { ok: false, error, hint? }
 */
import { NextResponse } from 'next/server';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
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

interface ExistingDlz {
  subscriptionId: string;
  subscriptionName: string;
  domainName: string;
  region: string;
  rg: string;
}

/** Parse `rg-csa-loom-dlz-<domain>-<region>` → { domainName, region }. */
function parseDlzRg(rg: string): { domainName: string; region: string } | null {
  const m = /^rg-csa-loom-dlz-(.+)-([a-z0-9]+)$/i.exec(rg);
  if (!m) return null;
  return { domainName: m[1], region: m[2] };
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
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI Reader on the subscriptions whose DLZs you want to discover.',
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
            "ResourceContainers | where type == 'microsoft.resources/subscriptions/resourcegroups' " +
            "| where name startswith 'rg-csa-loom-dlz-' " +
            '| project name, subscriptionId, location ' +
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
    const dlzs: ExistingDlz[] = [];
    for (const row of rows) {
      const parsed = parseDlzRg(row.name);
      if (!parsed) continue;
      dlzs.push({
        subscriptionId: row.subscriptionId,
        subscriptionName: row.subscriptionId, // RG rows carry no sub displayName; id is the stable key
        domainName: parsed.domainName,
        region: parsed.region || row.location || '',
        rg: row.name,
      });
    }
    return NextResponse.json({ ok: true, dlzs });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Resource Graph request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }
}
