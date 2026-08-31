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
import { getArmTokenPreferUser } from '@/lib/auth/obo';
import { scanDeployedDlzsCached, type DiscoveredDlz } from '@/lib/setup/wire-existing';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ExistingDlz {
  subscriptionId: string;
  subscriptionName: string;
  domainName: string;
  region: string;
  rg: string;
}

/**
 * The scan itself lives in `lib/setup/wire-existing.ts` (#3609). This route
 * carried a byte-for-byte copy of the Resource Graph query, its `$skipToken`
 * paging and the `rg-csa-loom-dlz-<domain>-<region>` regex; the sibling
 * `POST /api/setup/wire-existing` uses the same scan as its L2 existence
 * control, and two copies of a security-relevant resolver that must agree is a
 * drift hazard. Only the response projection is route-specific, and that is
 * what this function is.
 *
 * `subscriptionName` is the subscription ID: Resource Graph's
 * `ResourceContainers` rows for a resource group carry no subscription display
 * name, and the id is the stable key. This field has always been the id — it is
 * not a regression of this refactor.
 */
function toExistingDlz(d: DiscoveredDlz): ExistingDlz {
  return {
    subscriptionId: d.subscriptionId,
    subscriptionName: d.subscriptionId,
    domainName: d.domainName,
    region: d.region,
    rg: d.rg,
  };
}

export const GET = withSession(async (_req, { session }) => {

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
  // The memo now lives with the scan, so the POST that follows this GET reads
  // the entry this GET warmed instead of re-running the fan-out (#3609).
  try {
    const discovered = await scanDeployedDlzsCached(session.claims.oid, identity, token);
    return NextResponse.json({ ok: true, dlzs: discovered.map(toExistingDlz), identity });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Resource Graph request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }
});
