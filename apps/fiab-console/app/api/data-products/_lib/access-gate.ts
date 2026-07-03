/**
 * rel-T18 — data-product DATA-access gate.
 *
 * A data product's METADATA (name, description, schema, policies) is
 * intentionally discoverable to any authenticated catalog reader — that's how
 * consumers find products to request. But the ACTUAL DATA (real sample rows via
 * the "Try it" preview, and any full-data read) must be gated to the same set of
 * principals that hold full data access: the product OWNER (or a shared-workspace
 * ACL member per rel-T11) and consumers whose ACCESS REQUEST has been APPROVED.
 *
 * BEFORE this gate, POST /api/data-products/[id]/preview returned 25 real rows of
 * ANY product to ANY signed-in user. This resolver is the single check those
 * data-returning routes call.
 *
 * Approved-access is recorded by two real, complementary flows (both consulted):
 *   1. F15 simple grant — the `access-requests` container (PK /dataProductId):
 *      the owner approves a purpose-bound request → status 'approved'/'completed',
 *      requesterId = the consumer's oid.
 *   2. F16 multi-tier workflow — the `access-request-workflow` container
 *      (PK /tenantId = requester oid): the final approval provisions a REAL
 *      Azure RBAC grant and marks the request status 'completed'.
 *
 * Draft products: only their OWNER passes (ownership check), so previewing a
 * Draft's data is scoped to the owner — consumers can't reach it.
 */
import type { SessionPayload } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { accessRequestsContainer, accessRequestWorkflowContainer } from '@/lib/azure/cosmos-client';

export type DataAccessDecision =
  | { allowed: true; via: 'owner' | 'access-request' }
  | { allowed: false };

/**
 * Resolve whether `session`'s caller may read the ACTUAL DATA of data product
 * `productId`. Grants for the owner / shared ACL member, or a consumer holding an
 * approved/completed access record. Never throws — a missing/unprovisioned
 * access container is treated as "no grant there", not an error.
 */
export async function resolveDataProductDataAccess(
  session: SessionPayload,
  productId: string,
): Promise<DataAccessDecision> {
  const oid = session.claims.oid;

  // 1) OWNER / shared-workspace ACL member (rel-T11). Read role is enough — this
  //    gates a read-only preview. Also covers Draft products (owner-only).
  const owned = await loadOwnedItem(productId, 'data-product', oid, { allowReadRoles: true });
  if (owned) return { allowed: true, via: 'owner' };

  // 2) F15 approved access-request (access-requests container, PK /dataProductId).
  try {
    const ar = await accessRequestsContainer();
    const { resources } = await ar.items
      .query<{ id: string }>({
        query:
          "SELECT TOP 1 c.id FROM c WHERE c.dataProductId = @id AND c.requesterId = @oid " +
          "AND (c.status = 'approved' OR c.status = 'completed')",
        parameters: [
          { name: '@id', value: productId },
          { name: '@oid', value: oid },
        ],
      })
      .fetchAll();
    if (resources.length > 0) return { allowed: true, via: 'access-request' };
  } catch {
    /* container absent/unprovisioned → no grant here, fall through */
  }

  // 3) F16 completed workflow request (access-request-workflow, PK /tenantId=oid).
  try {
    const wf = await accessRequestWorkflowContainer();
    const { resources } = await wf.items
      .query<{ id: string }>(
        {
          query:
            "SELECT TOP 1 c.id FROM c WHERE c.assetId = @id AND c.requesterId = @oid AND c.status = 'completed'",
          parameters: [
            { name: '@id', value: productId },
            { name: '@oid', value: oid },
          ],
        },
        { partitionKey: oid },
      )
      .fetchAll();
    if (resources.length > 0) return { allowed: true, via: 'access-request' };
  } catch {
    /* fall through */
  }

  return { allowed: false };
}
