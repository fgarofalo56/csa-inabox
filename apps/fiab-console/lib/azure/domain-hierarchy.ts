/**
 * domain-hierarchy — invariants shared by BOTH domain move endpoints so they
 * enforce exactly the same tree rules:
 *
 *   • PATCH /api/admin/domains?id=...        (tenant-settings `items[]` store, `parentId`)
 *   • PATCH /api/governance/domains/[id]     (governance-domains Cosmos store, `parentDomainId`)
 *       → via cosmosDomainStore.moveDomain in domains-client.ts
 *
 * Loom domains form an at-most-two-level tree (domain → subdomain), matching
 * Fabric "subdomains only", Purview collection→child-collection, and Unity
 * Catalog catalog→schema. A move that violates the tree would corrupt the
 * unified mapper's root-vs-subdomain (catalog-vs-schema) determination, which
 * keys off `parentId` presence — so both paths MUST reject the same cases.
 *
 * Pure functions only (no Cosmos / Azure imports) so either store can call them.
 */

/** Minimal node shape for hierarchy validation (works for either store). */
export interface DomainHierarchyNode {
  id: string;
  /** Parent id, or undefined when the node is a root domain. */
  parentId?: string;
}

export interface DomainMoveError {
  /** HTTP status to surface (always a client error here). */
  status: number;
  message: string;
}

/**
 * Validate a domain reparent ("move"). Returns a {status,message} to reject, or
 * `null` when the move is allowed. Rejects, in order of specificity:
 *   1. self-parent — a domain cannot be its own parent (400)
 *   2. missing target — the new parent does not exist (400)
 *   3. cycle — the target is the domain itself or one of its descendants (400)
 *   4. two-level cap (a): nesting under a domain that is already a subdomain (400)
 *   5. two-level cap (b): moving a domain that itself has subdomains (400)
 * Moving to root (`newParentId` undefined/empty) is always allowed.
 */
export function validateDomainMove(
  domains: DomainHierarchyNode[],
  id: string,
  newParentId: string | undefined,
): DomainMoveError | null {
  if (!newParentId) return null; // move to root is always valid

  if (newParentId === id) {
    return { status: 400, message: 'A domain cannot be its own parent.' };
  }

  const byId = new Map(domains.map((d) => [d.id, d]));
  const target = byId.get(newParentId);
  if (!target) {
    return { status: 400, message: `Target parent '${newParentId}' not found.` };
  }

  // Cycle: walking up the ancestor chain from the target must never reach `id`
  // (e.g. moving root A under its child B yields A.parent=B, B.parent=A). The
  // `seen` set bounds the walk against any pre-existing corruption.
  const seen = new Set<string>();
  let cur: DomainHierarchyNode | undefined = target;
  while (cur) {
    if (cur.id === id) {
      return { status: 400, message: 'Cannot move a domain under one of its own subdomains.' };
    }
    if (!cur.parentId || seen.has(cur.parentId)) break;
    seen.add(cur.parentId);
    cur = byId.get(cur.parentId);
  }

  // Two-level cap (a): the target is itself a subdomain → would create level 3.
  if (target.parentId) {
    return {
      status: 400,
      message: 'Cannot nest under a subdomain — domains are at most two levels (domain → subdomain).',
    };
  }

  // Two-level cap (b): the domain being moved already has subdomains → moving it
  // under another domain would push those subdomains to level 3.
  if (domains.some((d) => d.parentId === id)) {
    return {
      status: 400,
      message: 'Move this domain’s subdomains out first — a subdomain can’t have its own subdomains.',
    };
  }

  return null;
}

/**
 * Tenant/Fabric-admin check shared by the domain routes — mirrors Fabric role
 * rules where only a tenant admin may rename, change the admin list, or MOVE a
 * domain. Reads LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID.
 *
 * NOTE the deliberate default: when NEITHER env var is configured, the whole
 * console is already admin-gated, so every authenticated session is treated as
 * a tenant admin (so admins can configure access out of an empty state). This
 * matches the admin route's long-standing behavior — do NOT swap in
 * feature-gate's isTenantAdmin(), which defaults to `false` and would lock out
 * the default deployment.
 */
export function isDomainTenantAdmin(oid: string): boolean {
  const adminOids = (process.env.LOOM_TENANT_ADMIN_OID || '')
    .split(/[,;\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const adminGroup = (process.env.LOOM_TENANT_ADMIN_GROUP_ID || '').trim();
  if (adminOids.length === 0 && !adminGroup) return true;
  return adminOids.includes((oid || '').toLowerCase());
}
