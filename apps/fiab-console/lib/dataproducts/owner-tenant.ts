/**
 * Resolve the tenant that OWNS a data product — distinct from the tenant of the
 * caller who is acting on it.
 *
 * This distinction is load-bearing and was got wrong (#3499 review). Loom's
 * data-quality rules live in a per-tenant Cosmos document (`dq-rules:<tenantId>`),
 * so scoring a product's rules requires the OWNER's tenant. Every measure site
 * was passing `session.claims.oid` — the CALLER — because `loadOwnedItem` reads
 * like an ownership check. It is not: it gates on workspace WRITE access
 * (`app/api/items/_lib/item-crud.ts`, `!access.canWrite → null`), which a
 * shared-workspace collaborator satisfies.
 *
 * So a collaborator pressing "Rerun DQ check" loaded rules from THEIR tenant —
 * usually none — and, once the measurement became persisted state, wrote "No
 * data-quality rules apply to this data product" onto someone else's product,
 * across the marketplace detail, the gauge and the certification gate, until the
 * owner re-measured. Passing the caller's oid here is never right.
 *
 * NOT to be confused with the tenant passed to `loadOwnedItem`/`updateOwnedItem`:
 * those take the CALLER's tenant on purpose, because they are authorising the
 * caller. Only the rule-store lookup takes the owner's.
 */

import { workspacesContainer } from '@/lib/azure/cosmos-client';

/**
 * The `tenantId` of the workspace that owns an item, or null when it could not
 * be established (missing workspace, Cosmos error). Null is "unknown", never
 * "the caller" — callers that would execute rules MUST refuse rather than fall
 * back to their own tenant, which is the defect above (deploy-integrity R7).
 */
export async function resolveOwnerTenantId(workspaceId: string | undefined | null): Promise<string | null> {
  if (!workspaceId) return null;
  try {
    const ws = await workspacesContainer();
    const { resources } = await ws.items
      .query<{ tenantId: string }>({
        query: 'SELECT c.tenantId FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: workspaceId }],
      })
      .fetchAll();
    return resources[0]?.tenantId ?? null;
  } catch {
    // Best-effort by design: the consumer view still renders without it, and
    // every measuring caller treats null as "do not measure".
    return null;
  }
}
