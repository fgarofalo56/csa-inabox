/**
 * GET /api/items/[type]/[id]/impact — cross-catalog impact analysis (Wave-2 W8).
 *
 * "What breaks downstream if I delete / rename / schema-edit this item?" — the
 * pre-destructive-change confirmation surface (Palantir Foundry impact analysis
 * / dbt exposures parity). It walks the SAME unified lineage graph the catalog
 * Lineage tab draws (Purview/Atlas + Unity Catalog + Weave/Thread edges) FORWARD
 * from the focus asset and returns every downstream dependent, grouped by kind
 * and badged direct (1 hop) vs transitive (>1 hop).
 *
 * Backend = the existing lineage store (getUnifiedLineage) — Azure-native by
 * default, no hard Microsoft Fabric dependency (per no-fabric-dependency.md):
 *   • Commercial / GCC → Unity Catalog lineage + Weave/Thread edges (+ Purview)
 *   • GCC-High         → Purview Atlas lineage + Weave/Thread edges
 *   • DoD / IL5        → Weave/Thread edges (Cosmos, always-on); Purview is
 *                        absent, so the honest `degraded`/`sources` flags below
 *                        disclose that only the Loom-native mesh was consulted.
 *
 * Response shape ({ ok, dependents[], groups[], counts, degraded, partial,
 * sources }) matches the repo BFF envelope. `degraded` is TRUE when NO lineage
 * source was reachable — an empty dependents list then means "couldn't verify",
 * NOT "safe to delete" (per no-vaporware.md), and the UI warns + still requires
 * an explicit typed confirmation.
 *
 * Query params (all optional):
 *   depth — lineage walk depth (1-10, default 3)
 *   host  — Databricks workspace hostname override (UC)
 *   key   — explicit lineage key override (UC full_name or Atlas/Purview GUID)
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { detectLoomCloud, type LoomCloud } from '@/lib/azure/cloud-endpoints';
import { getUnifiedLineage } from '@/lib/azure/unified-lineage';
import { buildImpactResult } from '@/lib/azure/impact-analysis';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { apiOk, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * #3941 review - A ROUTE CEILING ABOVE THE GROUP WALK.
 *
 * This route's authorization moved from an owner-only point read to
 * `authorizeItemWorkspace`. The owner fast path short-circuits, so a caller who
 * created the workspace pays nothing new - but the population this migration
 * newly ADMITS (non-owner ACL members and tenant admins) is exactly the one
 * that falls through to `resolveEffectiveRole`, which walks group assignments
 * SEQUENTIALLY with no walk-wide ceiling (#3834). 71 other console routes
 * declare a bound; not one of these ten did, so the widening landed on the
 * routes with no ceiling at all.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH (deploy-integrity.md R7): it DECLARES a
 * bound - it does not, on this deployment, enforce one, and the earlier wording
 * here ("it bounds the REQUEST") asserted an effect that was not established
 * (#4357 review item 3). `maxDuration` is a build-time segment config: measured
 * in next@15.5.21, every reference under `node_modules/next/dist` sits in
 * `build/` (segment-config collection, the build manifest, the types plugin) or
 * in typegen - nothing under `next/dist/server` reads it on the request path, so
 * the standalone server this console ships as does not cut the request off at
 * 60s. Enforcement belongs to the hosting platform, and that the console's
 * Container Apps runtime performs it was NOT established. What the line does buy
 * is the declared bound the house convention expects - 71 other console routes
 * carry one and not one of these ten did - so any platform that does read it
 * bounds these routes like the rest. It does not bound the group walk either
 * way: #3834 is still open.
 */
export const maxDuration = 60;

/**
 * Find an item by id (cross-partition) + AUTHORIZE the caller against its parent
 * workspace through the canonical ladder (#3941). Read-scoped for GET, write-
 * scoped for every mutating verb. This REPLACES an owner-only partition point
 * read that admitted only the workspace CREATOR, so for any item row carrying a
 * workspaceId the admitted set GROWS: tenant admins and shared-ACL members with
 * the right role now pass.
 *
 * ONE DIRECTION IS NOT MONOTONE, named because "strictly GROWS" was the wrong
 * word for it (#4357 review item 2). When an item row's `workspaceId` is FALSY,
 * `authorizeItemWorkspace` resolves no workspace and returns null — an ALLOW the
 * role resolver never sees (workspace-guard.ts, the `if (!workspaceId) return
 * null` prologue). The owner-only point read this replaced did
 * `ws.item(item.workspaceId, tenantId).read()`, which on a falsy id 404s or
 * throws, so the helper REFUSED. That one row shape therefore moves from refuse
 * to proceed. `items` is partitioned on `/workspaceId` (cosmos-client.ts), so a
 * row with a falsy one is close to unreachable, and the ALLOW is the shared
 * helper's own pre-existing, cross-cutting behaviour — not introduced here. It
 * is disclosed rather than smoothed over (deploy-integrity.md R7).
 */
async function loadItem(
  itemId: string,
  type: string,
  session: SessionPayload,
  // #3941 review - NAMED, not a bare positional boolean. This argument
  // selects the AUTHORIZATION scope: `true` admits read-only workspace
  // roles, `false` restricts to the write-capable ones. As a positional
  // `boolean` a transposed argument would silently widen a mutation with no
  // compiler complaint, and every call site read `..., session, { allowReadRoles: false })` with
  // nothing on screen saying which way `false` pointed.
  { allowReadRoles }: { allowReadRoles: boolean },
): Promise<{ item: WorkspaceItem | null; denied: NextResponse | null }> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: type },
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return { item: null, denied: null };
  // #3941 - the canonical ladder, replacing the owner-only partition point read
  // this helper used to do. `workspaces` is partitioned on `/tenantId`, which
  // holds the workspace CREATOR's oid, so `ws.item(workspaceId, callerOid)`
  // could only answer "did YOU create this workspace?" - it refused tenant
  // admins and shared-ACL members on every item type with no dedicated route
  // (the #2941/#2942 defect). `authorizeItemWorkspace` answers "may you ACCESS
  // it?", scoped: read roles for GET, write-capable only for the mutations.
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: item.workspaceId,
    itemId,
    itemType: type,
    allowReadRoles,
    notFound: 'Item not found',
  });
  // An ORDINARY refusal (404) collapses to `null` so the route keeps its own
  // not-found wording, which is what its clients already render. The 409
  // `tenant_unconfirmed` refusal does NOT: flattening it into "item not found"
  // would state that the item does not exist, which the code did not establish
  // - the workspace document WAS read and the admin rights ARE real
  // (deploy-integrity.md R7). It is handed back for the route to return.
  if (denied) return { item: null, denied: denied.status === 404 ? null : denied };
  return { item, denied: null };
}

/** Resolve the Unity Catalog `catalog.schema.table` lineage key from item state. */
function ucKeyFromItem(item: WorkspaceItem | null): string | undefined {
  const s: any = item?.state || {};
  const direct = s.ucFullName || s.fullName || s.full_name || s.tableFullName || s.qualifiedName;
  if (typeof direct === 'string' && direct) return direct;
  const cat = s.catalog || s.catalogName;
  const sch = s.schema || s.schemaName;
  const tbl = s.table || s.tableName;
  if (cat && sch && tbl) return `${cat}.${sch}.${tbl}`;
  return undefined;
}

/** Resolve the Atlas/Purview entity GUID lineage key from item state. */
function guidFromItem(item: WorkspaceItem | null): string | undefined {
  const s: any = item?.state || {};
  const c = s.purviewGuid || s.atlasGuid || s.entityGuid || s.guid;
  return typeof c === 'string' && c ? c : undefined;
}

/** Does the path segment look like a UC `catalog.schema.table` full name? */
function looksLikeUcFullName(s: string): boolean {
  return /^[\w$]+\.[\w$]+\.[\w$]+$/.test(s);
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ type: string; id: string }> },
) {
  const { type, id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized('Unauthorized');

  const depth = Math.max(
    1,
    Math.min(10, parseInt(req.nextUrl.searchParams.get('depth') || '3', 10) || 3),
  );
  const hostOverride = req.nextUrl.searchParams.get('host') || '';
  const keyOverride = req.nextUrl.searchParams.get('key') || '';
  const cloud: LoomCloud = detectLoomCloud();

  // Best-effort item lookup: powers lineage-key resolution from state + the
  // focus deep-link. Never fatal — a raw lineage key ([id] = UC full_name /
  // Atlas GUID) has no Cosmos row.
  let item: WorkspaceItem | null = null;
  try {
    // Best-effort, and DELIBERATELY dropping the authorization refusal: this
    // lookup only enriches the lineage key from item state, and the lineage
    // answer below is tenant-scoped inside `getUnifiedLineage` regardless. A
    // refusal here is the same outcome as "no Cosmos row" — no item state.
    item = (await loadItem(id, type, session, { allowReadRoles: true })).item;
  } catch {
    item = null;
  }
  // Note: an unresolved id (no Cosmos row and not a raw UC full_name / GUID) is
  // NOT fatal — the Weave/Thread-edge source is tenant-scoped inside
  // getUnifiedLineage, so a freshly-created item with no lineage-key state still
  // gets an honest answer (its downstream Loom-item consumers, if any).

  const ucFromState = ucKeyFromItem(item);
  const guidFromState = guidFromItem(item);

  let ucFullName: string | undefined;
  let purviewGuid: string | undefined;
  if (cloud === 'Commercial' || cloud === 'GCC') {
    ucFullName = keyOverride || ucFromState || (looksLikeUcFullName(id) ? id : undefined);
    purviewGuid = guidFromState;
  } else {
    // GCC-High + DoD/IL5 — Purview/Atlas is the Atlas-family primary; UC overlay
    // when its key resolves. (IL5 Atlas-on-AKS is not injected here — the
    // Weave/Thread-edge source still answers, and `sources`/`degraded` disclose
    // that Purview gated.)
    purviewGuid = keyOverride || guidFromState || (looksLikeUcFullName(id) ? undefined : id);
    ucFullName = ucFromState;
  }

  try {
    const result = await getUnifiedLineage({
      session,
      itemId: id,
      itemType: type,
      depth,
      weaveDepth: depth,
      ucFullName,
      ucHost: hostOverride || undefined,
      purviewGuid,
    });
    const impact = buildImpactResult({
      nodes: result.nodes,
      edges: result.edges,
      focusId: result.focusId,
      sources: result.sources,
    });
    return apiOk({
      focusId: impact.focusId,
      itemName: item?.displayName,
      dependents: impact.dependents,
      groups: impact.groups,
      counts: impact.counts,
      degraded: impact.degraded,
      partial: impact.partial,
      sources: impact.sources,
      cloud,
    });
  } catch (e: any) {
    // getUnifiedLineage catches per-source gates internally; a throw here is an
    // unexpected (Cosmos/identity) failure — genericize + log, never leak.
    return apiServerError(e, 'Failed to compute impact analysis', 'impact_error');
  }
}
