/**
 * GET /api/data-products/[id]/ports  (DP-8)
 *
 * The structured input/output/management ports for a data product, with each
 * INPUT port that references another data product (kind 'data-product' /
 * 'output-port') RESOLVED to that upstream's contract summary (version + column
 * count) so the designer can show the dependency's shape and DP-9 can propagate
 * breaking changes. Azure-native Cosmos; no Fabric dependency.
 *
 * ── AUTHORIZATION (GHSA-hf73-rp4q-66pf addendum) ─────────────────────────────
 * This route USED to say "not ownership-gated (ports are part of the
 * discoverable product surface)" and then perform two unscoped cross-partition
 * `findItem` lookups — `SELECT * FROM c WHERE c.id = @id AND c.itemType = @t`
 * with no workspaceId, no tid, no createdBy and no lifecycle filter. Two
 * separate disclosures came out of that, and NEITHER matched the sentence:
 *
 *   1. The PORTS MODEL of any product id, in any tenant. A port's `ref` is an
 *      infrastructure ADDRESS — an `abfss://` path, a Synapse `schema.table`, an
 *      ADX database. That is cross-tenant infrastructure-address disclosure, and
 *      it is a good deal more than the "contract summaries" the allowlist
 *      claimed.
 *   2. A RESOLVE ECHO on the upstream id. `resolveInput` returned the upstream
 *      product's `displayName` + contract version for any id the caller put in a
 *      `ref`, and distinguished "not found" from "found" in the response — an
 *      item-existence + display-name oracle across tenants.
 *
 * The DEFECT WAS NOT THE POSTURE, IT WAS THAT THE POSTURE WAS NEVER IMPLEMENTED.
 * Purview-Unified-Catalog-style discovery says a PUBLISHED product is visible to
 * any catalog reader. Nothing here established that a product was published — or
 * that it was even in the caller's tenant. `callerMayDiscover` below is that
 * sentence, written as code.
 *
 * WHY THIS IS P2 AND NOT P1: the discovery posture is deliberate and documented
 * (`data-products/[id]` GET carries the same one), and `id` is a Cosmos GUID, so
 * this route is not an enumeration surface on its own.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { authorizeWorkspace } from '@/lib/auth/workspace-guard';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { readPorts, portsSummary, type Port } from '@/lib/dataproducts/ports';
import { resolveLifecycleState, type LifecycleState } from '@/lib/dataproducts/lifecycle';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

/** The ONE not-found wording, used for "no such product" AND for "you may not
 *  discover this one". Distinguishing them is what made this an existence
 *  oracle; 404-not-403 is the same choice `authorizeItemWorkspace` makes. */
const NOT_FOUND = 'Data product not found';

/**
 * Lifecycle states a NON-MEMBER may discover.
 *
 * `deprecated` is in the set deliberately, not by omission: DP-9 propagates
 * breaking changes to DOWNSTREAM consumers, and a consumer resolving a
 * dependency they no longer own must still see that it was deprecated — dropping
 * it here would break the deprecation notice that is the whole point of that
 * feature. `retired` and the pre-publish rungs (`draft` / `validated` /
 * `certified`) are not discoverable.
 *
 * Resolved through `resolveLifecycleState`, NOT through raw `state.publishStatus`
 * — DP-1 exists because that is one of three never-synced legacy fields, and a
 * gate reading it directly would call a ribbon-published product Draft.
 */
const DISCOVERABLE: ReadonlySet<LifecycleState> = new Set<LifecycleState>(['published', 'deprecated']);

async function findItem(itemId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [{ name: '@id', value: itemId }, { name: '@t', value: ITEM_TYPE }],
    })
    .fetchAll();
  return resources[0] ?? null;
}

/**
 * The Entra tenant (`tid` claim) a workspace belongs to, or null when the doc
 * does not record one. Distinct from `Workspace.tenantId`, which stores the
 * CREATOR's Entra `oid` (see lib/types/workspace.ts) — comparing THAT to a
 * caller's `tid` would compare two different things and always deny.
 */
async function workspaceTid(workspaceId: string | undefined): Promise<string | null> {
  if (!workspaceId) return null;
  try {
    const ws = await workspacesContainer();
    const { resources } = await ws.items
      .query<{ tid?: string }>({
        query: 'SELECT c.tid FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: workspaceId }],
      })
      .fetchAll();
    return resources[0]?.tid ?? null;
  } catch {
    return null;
  }
}

/**
 * May this caller discover this product's ports?
 *
 *   1. Authorized on the OWNING WORKSPACE at any role — owner, shared-ACL
 *      member, or tenant admin. `authorizeWorkspace` → `resolveWorkspaceAccessByOid`
 *      runs the #2703 tid boundary from `session.claims.tid` inside this path,
 *      so it needs no separate tenant test. Draft products are visible here, to
 *      the people building them.
 *   2. Otherwise the product must ACTUALLY BE discoverable (published or
 *      deprecated) AND belong to the caller's own Entra tenant.
 *
 * KNOWN RESIDUAL, stated rather than implied away: step 2's tenant test can only
 * run on workspace docs that RECORD a `tid`. That field is written on create and
 * backfilled by scripts/csa-loom/backfill-workspace-tid.mjs; on a legacy doc that
 * predates it the tenant is UNKNOWN, and this returns true rather than denying —
 * because failing closed there would hide every legacy in-tenant product from
 * ordinary catalog readers, which is a regression, not a fix. Run the backfill to
 * close it. What is NOT residual: an unpublished product is now invisible to
 * non-members regardless of tid, and that was the bulk of the exposure.
 */
async function callerMayDiscover(session: SessionPayload, item: WorkspaceItem): Promise<boolean> {
  const denied = await authorizeWorkspace(session, item.workspaceId, { allowReadRoles: true });
  if (!denied) return true;
  if (!DISCOVERABLE.has(resolveLifecycleState(item.state as Record<string, unknown>))) return false;
  const ownerTid = await workspaceTid(item.workspaceId);
  if (ownerTid && session.claims.tid && ownerTid !== session.claims.tid) return false;
  return true;
}

interface ResolvedInput extends Port {
  resolved?: { productName: string; contractVersion?: string; columnCount: number } | { error: string };
}

/** ONE message for "no such upstream" AND "you may not discover that upstream".
 *  Two messages would rebuild the existence oracle this change closes. */
const UPSTREAM_OPAQUE = 'Upstream product not found or not discoverable.';

/** Resolve an input port that points at another data product to its contract.
 *  The upstream is subject to the SAME discoverability test as the product being
 *  read — otherwise a caller authorized on their OWN product could name any id in
 *  a `ref` and read back another tenant's product name + contract version. */
async function resolveInput(session: SessionPayload, port: Port): Promise<ResolvedInput> {
  if ((port.kind !== 'data-product' && port.kind !== 'output-port') || !port.ref) return { ...port };
  try {
    // The ref for an output-port is `<productId>:<portId>`; take the product id.
    const productId = port.ref.split(':')[0];
    const upstream = await findItem(productId);
    if (!upstream || !(await callerMayDiscover(session, upstream))) {
      return { ...port, resolved: { error: UPSTREAM_OPAQUE } };
    }
    const st = (upstream.state || {}) as Record<string, unknown>;
    const contract = (st.contract && typeof st.contract === 'object' ? st.contract : {}) as Record<string, unknown>;
    const schema = Array.isArray(contract.schema) ? contract.schema : [];
    return {
      ...port,
      resolved: {
        productName: upstream.displayName,
        contractVersion: typeof contract.version === 'string' ? contract.version : undefined,
        columnCount: schema.length,
      },
    };
  } catch (e: any) {
    return { ...port, resolved: { error: e?.message || String(e) } };
  }
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiError('Unauthorized', 401, { code: 'unauthorized' });
  try {
    const item = await findItem(id);
    if (!item) return apiError(NOT_FOUND, 404, { code: 'not_found' });
    if (!(await callerMayDiscover(session, item))) {
      return apiError(NOT_FOUND, 404, { code: 'not_found' });
    }
    const model = readPorts(item.state as Record<string, unknown>);
    const input = await Promise.all(model.input.map((p) => resolveInput(session, p)));
    return NextResponse.json({
      ok: true,
      ports: { input, output: model.output, management: model.management },
      summary: portsSummary(model),
    });
  } catch (e: any) {
    return apiError(e?.message || 'Failed to read ports', 500, { code: 'cosmos_error' });
  }
}
