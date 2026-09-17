/**
 * GET /api/data-products/[id]/policies — permitted access purposes for a
 * data product, resolved across tenants for the consumer "Request access" flow.
 *
 * READ THE #3580 BLOCK BELOW BEFORE QUOTING THAT SENTENCE. "Resolved across
 * tenants" is kept because it is the INTENT, but it was also, literally, the
 * whole implementation until #3580's second pass.
 *
 * The owner defined these as `Access`-kind governance policies scoped to
 * `data-product:<id>`, stored in the `tenant-settings` container under
 * `policies:<ownerOid>`. A consumer (different oid) cannot see them via
 * GET /api/governance/policies (which scopes to the caller's own oid), so this
 * BFF route resolves the owning workspace's tenantId and returns the owner's
 * Access policies scoped to THIS product. The dialog populates its "Permitted
 * purpose" dropdown from this (no freeform input).
 *
 * Cosmos-only — no Fabric/Purview dependency.
 *
 * ── #3580 — "RESOLVED ACROSS TENANTS" WAS LITERALLY TRUE ────────────────────
 *
 * The paragraph above describes a CONSUMER flow, and the consumer it means is a
 * catalog reader looking at a product they can actually see. What the code did
 * was resolve across tenants full stop: step 1 was an unscoped cross-partition
 * `SELECT c.workspaceId FROM c WHERE c.id = @id AND c.itemType = @t` with no
 * workspace, no tid and no lifecycle predicate, and every later step keyed off
 * the OWNER's tenant. So any signed-in caller holding any product GUID received
 * the owner's `Access` policy `name` AND `rule` for a DRAFT product in ANOTHER
 * Entra tenant — a governance rule string, authored by that owner, describing
 * the conditions under which their data may be used.
 *
 * That is the GHSA-hf73-rp4q-66pf shape one route over from where it was fixed:
 * `[id]` and `[id]/ports` both got the decision, this sibling ran the identical
 * query and inherited none of it (`lib/dataproducts/discoverability.ts` names
 * the family).
 *
 * `resolveDiscoveryAccess` now decides, and the ANSWER SHAPE IS UNCHANGED for
 * everyone who was ever supposed to have one: a member of the owning workspace,
 * or a caller in the product's own tenant looking at a published/deprecated
 * product, gets exactly the list they got before. Everyone else gets the 404
 * that "no such product" returns, so refusing does not confirm the id exists.
 *
 * WHY 404 AND NOT AN EMPTY LIST. `{ok:true, policies:[]}` is already a real
 * answer here — it is what a product with no Access policies returns (:65 and
 * the 404-from-tenant-settings branch below) — so reusing it for "you may not
 * see this" would make the two indistinguishable to the dialog AND would leave
 * the existence oracle open. The refusal has to be the not-found one.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  itemsContainer,
  workspacesContainer,
  tenantSettingsContainer,
} from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { resolveDiscoveryAccess, NOT_FOUND } from '@/lib/dataproducts/discoverability';
import { apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface PermittedPurpose {
  id: string;
  name: string;
  rule?: string;
}

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { session: s, params }) => {
  const { id } = params;

  try {
    // 1. Load the data product. `state` and `workspaceId` are BOTH required —
    //    `resolveDiscoveryAccess` reads the workspace for the membership + tid
    //    test and `state` for the DP-1 lifecycle resolution, so narrowing this
    //    projection back to `c.workspaceId` silently makes every product read as
    //    Draft and denies every catalog reader.
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT c.id, c.workspaceId, c.state FROM c WHERE c.id = @id AND c.itemType = @t',
        parameters: [
          { name: '@id', value: id },
          { name: '@t', value: 'data-product' },
        ],
      })
      .fetchAll();
    if (!resources[0]) return NextResponse.json({ ok: false, error: NOT_FOUND }, { status: 404 });

    // 2. #3580 — may this caller see this product at all? Same decision as
    //    GET /api/data-products/[id]; 'denied' is worded as the miss above.
    if ((await resolveDiscoveryAccess(s, resources[0])) === 'denied') {
      return NextResponse.json({ ok: false, error: NOT_FOUND }, { status: 404 });
    }

    // 3. Resolve the owning workspace's tenantId (cross-partition by id; PK = /tenantId).
    const ws = await workspacesContainer();
    const { resources: wsRes } = await ws.items
      .query<{ tenantId: string }>({
        query: 'SELECT c.tenantId FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: resources[0].workspaceId }],
      })
      .fetchAll();
    const ownerTenantId = wsRes[0]?.tenantId;
    if (!ownerTenantId) return NextResponse.json({ ok: true, policies: [] });

    // 4. Load the owner's policies doc from tenant-settings.
    const ts = await tenantSettingsContainer();
    let policiesDoc: any;
    try {
      const { resource } = await ts.item(`policies:${ownerTenantId}`, ownerTenantId).read();
      policiesDoc = resource;
    } catch (e: any) {
      if (e?.code === 404) return NextResponse.json({ ok: true, policies: [] });
      throw e;
    }

    const all: any[] = Array.isArray(policiesDoc?.items) ? policiesDoc.items : [];
    const scopeKey = `data-product:${id}`;
    const policies: PermittedPurpose[] = all
      .filter((p: any) => p?.kind === 'Access' && p?.scope === scopeKey && p?.enabled !== false)
      .map((p: any) => ({ id: String(p.id), name: String(p.name), rule: p.rule }));

    return NextResponse.json({ ok: true, policies });
  } catch (e: any) {
    return apiServerError(e);
  }
});
