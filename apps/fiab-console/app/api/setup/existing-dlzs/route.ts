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
import { getSession } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';
import { getArmTokenPreferUser } from '@/lib/auth/obo';
import { swrAwait } from '@/lib/azure/cross-sub-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

/**
 * Run the Resource Graph DLZ-RG scan under `token`, PAGING via `$skipToken` so a
 * tenant with more than one Resource Graph page (100+ matching RGs) lists fully
 * instead of silently truncating. Throws on any Resource Graph error.
 */
async function scanExistingDlzs(token: string): Promise<ExistingDlz[]> {
  const arm = armBase();
  const dlzs: ExistingDlz[] = [];
  let skipToken: string | undefined;
  do {
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
          options: { $top: 1000, ...(skipToken ? { $skipToken: skipToken } : {}) },
        }),
        cache: 'no-store',
      },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Resource Graph ${res.status}: ${t.slice(0, 200)}`);
    }
    const j: any = await res.json();
    for (const row of (j?.data || []) as any[]) {
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
    skipToken = j?.$skipToken || undefined;
  } while (skipToken);
  return dlzs;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // USER-PASSTHROUGH: discover DLZs the SIGNED-IN USER can see (Resource Graph
  // honours their RBAC), falling back to the Console UAMI when the user's ARM
  // scope wasn't consented at login.
  let token: string;
  let identity: 'user' | 'uami';
  try {
    const arm = await getArmTokenPreferUser(session);
    token = arm.token;
    identity = arm.identity;
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `auth failed: ${e?.message ?? String(e)}`,
        hint: 'Could not acquire an ARM token. Grant the Console UAMI (or your signed-in account) Reader on the subscriptions whose DLZs you want to discover.',
      },
      { status: 502 },
    );
  }

  // SWR-cached per (user, identity): the cross-sub Resource Graph scan can be
  // slow, so the collision-hint retries the wizard fires are served instantly.
  try {
    const { value: dlzs } = await swrAwait(
      session.claims.oid,
      `existing-dlzs:${identity}`,
      { ttlMs: 60_000 },
      () => scanExistingDlzs(token),
    );
    return NextResponse.json({ ok: true, dlzs, identity });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Resource Graph request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }
}
