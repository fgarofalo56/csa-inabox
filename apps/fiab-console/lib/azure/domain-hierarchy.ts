/**
 * domain-hierarchy — invariants shared by BOTH domain move endpoints so they
 * enforce exactly the same tree rules:
 *
 *   • PATCH /api/admin/domains?id=...        (tenant-settings `items[]` store, `parentId`)
 *   • PATCH /api/governance/domains/[id]     (governance-domains Cosmos store, `parentDomainId`)
 *       → via cosmosDomainStore.moveDomain in domains-client.ts
 *
 * Loom domains form a DEEP, ARBITRARY-DEPTH tree (department → agency →
 * sub-agency → office → program …) — issue #1483 Wave 2. This models real org
 * structure (e.g. USDA → REE mission area → ARS/ERS/NIFA/NASS) rather than the
 * old two-level (domain → subdomain) cap. Cosmos stays AUTHORITATIVE; the tree
 * is bounded only by MAX_DOMAIN_DEPTH (cycle-safe) so a runaway/corrupt chain
 * can't blow the mirrors up.
 *
 * The unified mapper reconciles this deep tree onto governance back-ends that
 * nest differently: Purview collections nest to ANY depth (1:1), while Unity
 * Catalog is physically two-level (catalog → schema). So the mapper maps a
 * domain's ROOT ANCESTOR → UC catalog and EVERY descendant → a schema under
 * that catalog (see `rootAncestorId`), flattening depth honestly for UC while
 * preserving it in Cosmos + Purview. Both paths MUST agree on the tree rules,
 * so both call these shared validators.
 *
 * Pure functions only (no Cosmos / Azure imports) so either store can call them.
 */

/**
 * Maximum domain nesting depth (root = depth 1). Deep enough for the richest
 * real taxonomies (department → mission-area → agency → office → program →
 * branch → team → workstream ≈ 8) while still bounding the tree so a corrupt
 * `parentId` chain can never make the mirrors recurse without end.
 */
export const MAX_DOMAIN_DEPTH = 8;

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
 * Depth of a domain in the tree (root = 1). Walks the ancestor chain with a
 * `seen` guard so a pre-existing cycle can't loop; a broken chain stops at the
 * first missing/duplicate ancestor.
 */
export function domainDepth(domains: DomainHierarchyNode[], id: string): number {
  const byId = new Map(domains.map((d) => [d.id, d]));
  const seen = new Set<string>();
  let depth = 1;
  let cur = byId.get(id);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = byId.get(cur.parentId);
    if (!cur) break;
    depth += 1;
  }
  return depth;
}

/**
 * The id of the top-level (root) ancestor of a domain — the domain itself when
 * it is already a root. This is the domain whose id backs the UC catalog for
 * the whole subtree (the mapper flattens deeper levels into schemas under it).
 * Cycle- and orphan-safe.
 */
export function rootAncestorId(domains: DomainHierarchyNode[], id: string): string {
  const byId = new Map(domains.map((d) => [d.id, d]));
  const seen = new Set<string>();
  let cur = byId.get(id);
  if (!cur) return id;
  while (cur.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    cur = parent;
  }
  return cur.id;
}

/** Height of the subtree rooted at `id` (a leaf = 1). Cycle-guarded. */
function subtreeHeight(childrenOf: Map<string, string[]>, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 1;
  seen.add(id);
  const kids = childrenOf.get(id) || [];
  if (kids.length === 0) return 1;
  let max = 0;
  for (const k of kids) max = Math.max(max, subtreeHeight(childrenOf, k, seen));
  return 1 + max;
}

/**
 * Validate a domain reparent ("move"). Returns a {status,message} to reject, or
 * `null` when the move is allowed. Rejects, in order of specificity:
 *   1. self-parent — a domain cannot be its own parent (400)
 *   2. missing target — the new parent does not exist (400)
 *   3. cycle — the target is the domain itself or one of its descendants (400)
 *   4. depth cap — the move would push the deepest leaf of the moved subtree
 *      past MAX_DOMAIN_DEPTH (400)
 * Moving to root (`newParentId` undefined/empty) is always allowed. Unlike the
 * old two-level model, a domain that itself has subdomains CAN be moved — its
 * whole subtree travels with it (arbitrary depth, #1483 Wave 2).
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
  // (moving a domain under one of its own descendants). The `seen` set bounds
  // the walk against any pre-existing corruption.
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

  // Depth cap: the moved node lands at depth(target)+1, and its own subtree adds
  // (height-1) more levels below it. Reject if the deepest leaf would exceed the
  // bound. Keeps the tree — and therefore the Purview/UC mirror recursion —
  // finite without capping it at two levels.
  const childrenOf = new Map<string, string[]>();
  for (const d of domains) {
    if (d.parentId) {
      const arr = childrenOf.get(d.parentId) || [];
      arr.push(d.id);
      childrenOf.set(d.parentId, arr);
    }
  }
  const landingDepth = domainDepth(domains, newParentId) + 1;
  const movedHeight = subtreeHeight(childrenOf, id);
  if (landingDepth + movedHeight - 1 > MAX_DOMAIN_DEPTH) {
    return {
      status: 400,
      message: `That move would nest domains more than ${MAX_DOMAIN_DEPTH} levels deep. Flatten the subtree or choose a shallower parent.`,
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
