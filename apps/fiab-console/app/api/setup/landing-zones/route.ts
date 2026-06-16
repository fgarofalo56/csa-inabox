/**
 * GET /api/setup/landing-zones  (item-3 — DLZ overview backend)
 *
 * One call that powers the Data Landing Zone overview (/admin/landing-zones):
 * the deployed hub's coordinates + every attached DLZ, with a real attach state.
 *
 * Sources (both real Azure, no mocks per no-vaporware.md):
 *   - hub        ← getTenantTopologySafe (Cosmos tenant-topology doc, or the
 *                  Console's own wired env when the doc is absent)
 *   - DLZ RGs    ← Azure Resource Graph (`rg-csa-loom-dlz-*`), RBAC-trimmed
 *   - attach     ← deploy pre-flight permission check per cross-sub: a DLZ in a
 *                  sub the Console can only READ (not deploy into) is surfaced
 *                  as 'detached' (needs RBAC repair) vs 'attached'.
 *
 * Response:
 *   { ok: true, hub, hubExists, landingZones: [...] }
 *   { ok: false, error, hint? }
 *
 * No Fabric handles anywhere (no-fabric-dependency) — coordinates are Azure ids.
 */
import { NextResponse } from 'next/server';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { getSession } from '@/lib/auth/session';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { getTenantTopologySafe } from '@/lib/setup/tenant-topology';
import { checkSubscriptionDeployPermission } from '@/lib/setup/deploy-preflight';
import {
  buildLandingZonesOverview,
  type DlzRgRow,
  type HubCoords,
} from '@/lib/setup/landing-zones-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function armToken(): Promise<string> {
  const t = await credential.getToken(armScope());
  if (!t?.token) throw new Error('Failed to acquire ARM token');
  return t.token;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // ── Hub coordinates ───────────────────────────────────────────────────────
  const topo = await getTenantTopologySafe();
  if (topo.error) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not read tenant topology: ${topo.error}`,
        hint: 'Confirm LOOM_COSMOS_ENDPOINT is set and the Console UAMI has Cosmos DB Built-in Data Reader.',
      },
      { status: 502 },
    );
  }
  const hub: HubCoords | null = topo.topology
    ? {
        hubSubscriptionId: topo.topology.hubSubscriptionId,
        location: topo.topology.location,
        boundary: topo.topology.boundary,
        hubAdxClusterRgName: topo.topology.hubAdxClusterRgName,
        hubCatalogEndpoint: topo.topology.hubCatalogEndpoint,
      }
    : null;

  // ── DLZ resource groups (Azure Resource Graph) ────────────────────────────
  let token: string;
  try {
    token = await armToken();
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `auth failed: ${e?.message ?? String(e)}`,
        hint: 'Grant the Console UAMI Reader on the subscriptions whose DLZs you want to see.',
      },
      { status: 502 },
    );
  }

  let dlzRows: DlzRgRow[] = [];
  try {
    const res = await fetch(
      `${armBase()}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            "ResourceContainers | where type == 'microsoft.resources/subscriptions/resourcegroups' " +
            "| where name startswith 'rg-csa-loom-dlz-' " +
            '| project name, subscriptionId, location | order by name asc',
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
    dlzRows = ((j?.data || []) as any[]).map((r) => ({
      name: r.name,
      subscriptionId: r.subscriptionId,
      location: r.location,
    }));
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Resource Graph request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }

  // ── Attach state: probe write permission on each DISTINCT cross-sub ─────────
  // A DLZ in a sub the Console can only READ is 'detached' (needs RBAC repair
  // before navigators can manage it). Same-sub DLZs are always manageable.
  // We probe once per distinct cross-sub (not per DLZ) to bound ARM calls.
  const hubSub = hub?.hubSubscriptionId;
  const crossSubs = Array.from(
    new Set(dlzRows.map((r) => r.subscriptionId).filter((s) => !!hubSub && s !== hubSub)),
  );
  const writableSubs = new Set<string>();
  if (hubSub) writableSubs.add(hubSub); // the hub sub is writable by definition
  for (const sub of crossSubs) {
    try {
      const perm = await checkSubscriptionDeployPermission(sub, armToken);
      // Only mark writable on a definitive yes; a check error leaves it out, so
      // the model reports 'detached' conservatively (honest — better to flag a
      // possibly-fine DLZ for repair than to claim a broken one is attached).
      if (!perm.error && perm.canDeploy) writableSubs.add(sub);
    } catch {
      /* leave out of writable set */
    }
  }

  const overview = buildLandingZonesOverview(hub, topo.exists, dlzRows, writableSubs);
  return NextResponse.json({ ok: true, ...overview });
}
