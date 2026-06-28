/**
 * PDP — `evaluate()`: the PURE composition engine for EH Phase-1 authorize().
 *
 * ZERO Azure / Cosmos imports — operates ONLY on the passed-in PolicyBundle, so
 * it is fully deterministic + unit-testable in the vitest node env (see
 * __tests__/evaluate.test.ts).
 *
 * DECISION ALGEBRA (appendix-multi-domain-acl §1.2) — fixed precedence, first
 * decisive layer wins:
 *   1. Tenant admin            → allow admin (short-circuit; above explicit deny).
 *   2. Explicit DENY           → hard deny, overrides every allow below.
 *   3. Domain tier             → domain-admin = allow admin within the domain
 *                                subtree; domain-contributor = allow write.
 *   4. Workspace role          → Admin/Member/Contributor/Viewer → admin/write/
 *                                write/read; INHERITED by every item/table/…
 *                                under the workspace.
 *   5. Item share grants       → ADDITIVE per-item permissions.
 *   5b. Explicit ALLOW grant   → ADDITIVE positive _aclGrants grant (effect:'allow')
 *                                on the resource/ancestor for this action.
 *   6. OneLake security role    → grants read/data (+write if ReadWrite) AND
 *                                contributes OLS/RLS/CLS OBLIGATIONS.
 *   7. Protection policy       → restrict-ONLY: a labeled resource DENIES anyone
 *                                not in allowPrincipals (applied as a final gate
 *                                over any non-tenant-admin allow).
 *   else                        → default deny.
 *
 * OBLIGATION ALGEBRA: within ONE role, OLS ∩ CLS ∩ RLS (a role narrows — its
 * rls AND cls obligations both apply). Across MULTIPLE roles the principal
 * holds, UNION (least-restrictive — more roles widen): RLS predicates OR
 * together, CLS allowed-columns union; a role with no RLS/CLS on a table makes
 * that dimension unrestricted (no obligation); export-block only when EVERY
 * applicable role/policy blocks it.
 */

import type {
  Action,
  AclGrant,
  Decision,
  Obligation,
  OneLakeRoleBinding,
  PolicyBundle,
  Principal,
  ProtectionPolicy,
  ResourceRef,
  WorkspaceRoleName,
} from './resource-ref';

// ---------------------------------------------------------------------------
// Capability tiers
// ---------------------------------------------------------------------------

type Tier = 'read' | 'write' | 'admin';

/** Actions each capability tier grants. write ⊃ read; admin ⊃ write + share. */
const TIER_ACTIONS: Record<Tier, Action[]> = {
  read: ['read'],
  write: ['read', 'write', 'build', 'execute'],
  admin: ['read', 'write', 'build', 'execute', 'share', 'admin'],
};

function tierGrants(tier: Tier, action: Action): boolean {
  return TIER_ACTIONS[tier].includes(action);
}

/** Workspace role → capability tier (Admin=admin, Member/Contributor=write,
 *  Viewer=read), per "mapped to admin/write/read". */
const WS_ROLE_TIER: Record<WorkspaceRoleName, Tier> = {
  Admin: 'admin',
  Member: 'write',
  Contributor: 'write',
  Viewer: 'read',
};

// ---------------------------------------------------------------------------
// Resource-chain helpers
// ---------------------------------------------------------------------------

function ancestorIds(resource: ResourceRef): Set<string> {
  const ids = new Set<string>();
  let r: ResourceRef | undefined = resource;
  while (r) {
    ids.add(r.id);
    r = r.parent;
  }
  return ids;
}

/** The item-level id in the resource chain (resource itself when it's an item,
 *  else the nearest item ancestor). */
function itemIdOf(resource: ResourceRef): string | undefined {
  let r: ResourceRef | undefined = resource;
  while (r) {
    if (r.level === 'item') return r.id;
    r = r.parent;
  }
  return undefined;
}

/** The table name the OLS/RLS/CLS obligations key on: the first `.table` in the
 *  chain, or the id of the `table`-level ref. */
function resourceTable(resource: ResourceRef): string | undefined {
  let r: ResourceRef | undefined = resource;
  while (r) {
    if (r.table) return r.table;
    if (r.level === 'table') return r.id;
    r = r.parent;
  }
  return undefined;
}

/** True when `id` is the caller's oid or one of their group object-ids. */
function principalMatches(principal: Principal, id: string): boolean {
  return id === principal.oid || principal.groups.includes(id);
}

// ---------------------------------------------------------------------------
// Layer matchers
// ---------------------------------------------------------------------------

/** An item-share permission set satisfies `action` when any of its types maps
 *  to (or above) the requested action. Read/ReadData/ReadAll* → read; Edit →
 *  read+write; Reshare → share; Execute → execute; Build → build. */
function shareGrantsAction(perms: PolicyBundle['shares'][number]['permissionTypes'], action: Action): boolean {
  for (const p of perms) {
    switch (p) {
      case 'Read':
      case 'ReadData':
      case 'ReadAllSQL':
      case 'ReadAllSpark':
        if (action === 'read') return true;
        break;
      case 'Edit':
        if (action === 'read' || action === 'write') return true;
        break;
      case 'Reshare':
        if (action === 'share') return true;
        break;
      case 'Execute':
        if (action === 'execute') return true;
        break;
      case 'Build':
        if (action === 'build') return true;
        break;
      // SubscribeOneLakeEvents → no base action in this algebra (event opt-in).
      default:
        break;
    }
  }
  return false;
}

/** Whether a OneLake role's OLS paths cover the resource's table (or the item
 *  itself when there is no table in the chain). */
function roleCoversResource(role: OneLakeRoleBinding, table: string | undefined): boolean {
  if (role.paths.includes('*')) return true;
  if (!table) return role.paths.length > 0;
  return role.paths.some((p) => {
    const norm = p.replace(/^\/+|\/+$/g, ''); // '/Tables/sales' → 'Tables/sales'
    return norm === 'Tables' || norm === `Tables/${table}` || norm.startsWith(`Tables/${table}/`);
  });
}

/** A OneLake role membership grants read/execute (traversal); write only when
 *  the role carries ReadWrite. */
function onelakeGrantsAction(role: OneLakeRoleBinding, action: Action): boolean {
  if (action === 'read' || action === 'execute') return true;
  if (action === 'write') return role.permissions.includes('ReadWrite');
  return false;
}

/** First protection policy on the resource (or an ancestor) that the principal
 *  is NOT allow-listed on — that policy blocks. null when none blocks. */
function findBlockingProtectionPolicy(
  principal: Principal,
  ancestors: Set<string>,
  policies: ProtectionPolicy[],
): ProtectionPolicy | null {
  for (const pp of policies) {
    if (!ancestors.has(pp.resourceId)) continue;
    const allowed = pp.allowPrincipals.some((id) => principalMatches(principal, id));
    if (!allowed) return pp;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Obligation algebra
// ---------------------------------------------------------------------------

/**
 * Merge obligations across the applicable OneLake roles for one table:
 *   - RLS: if ANY role has no predicate for the table → unrestricted (no
 *     obligation). Else OR the distinct predicates (union widens).
 *   - CLS: if ANY role has no column restriction for the table → unrestricted.
 *     Else union the allowed columns.
 *   - export-block: only when EVERY applicable role blocks export.
 */
function computeRoleObligations(roles: OneLakeRoleBinding[], table: string | undefined): Obligation[] {
  const obligations: Obligation[] = [];
  if (!roles.length) return obligations;

  if (table) {
    // RLS union (least-restrictive).
    const predicates: string[] = [];
    let anyUnrestrictedRows = false;
    for (const role of roles) {
      const entry = (role.rls || []).find((x) => x.table === table);
      if (entry && entry.predicate) predicates.push(entry.predicate);
      else anyUnrestrictedRows = true;
    }
    if (!anyUnrestrictedRows && predicates.length) {
      const unique = Array.from(new Set(predicates));
      const predicate = unique.length === 1 ? unique[0] : unique.map((p) => `(${p})`).join(' OR ');
      obligations.push({ kind: 'rls', table, predicate });
    }

    // CLS union (least-restrictive).
    let anyUnrestrictedCols = false;
    const cols = new Set<string>();
    for (const role of roles) {
      const entry = (role.cls || []).find((x) => x.table === table);
      if (entry && entry.allowedColumns.length) entry.allowedColumns.forEach((c) => cols.add(c));
      else anyUnrestrictedCols = true;
    }
    if (!anyUnrestrictedCols && cols.size) {
      obligations.push({ kind: 'cls', table, allowedColumns: Array.from(cols).sort() });
    }
  }

  // export-block restricts → only when every applicable role blocks export.
  if (roles.every((r) => r.exportBlocked)) {
    obligations.push({ kind: 'export-block' });
  }
  return obligations;
}

// ---------------------------------------------------------------------------
// Decision constructors
// ---------------------------------------------------------------------------

function allow(reason: string, source: string, obligations: Obligation[]): Decision {
  return { effect: 'allow', reason, source, obligations };
}

function deny(reason: string, source: string): Decision {
  return { effect: 'deny', reason, source, obligations: [] };
}

// ---------------------------------------------------------------------------
// evaluate()
// ---------------------------------------------------------------------------

/**
 * Compose a Decision for (`principal`, `resource`, `action`) from `bundle`,
 * encoding the fixed precedence + obligation algebra above EXACTLY. Pure +
 * deterministic.
 */
export function evaluate(
  principal: Principal,
  resource: ResourceRef,
  action: Action,
  bundle: PolicyBundle,
): Decision {
  const ancestors = ancestorIds(resource);
  const itemId = itemIdOf(resource);
  const table = resourceTable(resource);

  // OneLake roles the principal is a member of AND that cover this resource —
  // used both as an allow layer (6) and for the obligations on any lower-tier
  // (non-admin) allow.
  const applicableRoles = bundle.onelakeRoles.filter(
    (r) =>
      r.memberOids.some((id) => principalMatches(principal, id)) &&
      (!itemId || r.itemId === itemId) &&
      roleCoversResource(r, table),
  );

  /** Finalize an allow: apply the protection-policy restrict-only gate (layer
   *  7) and attach obligations for non-admin tiers (admin sees everything). */
  const finalizeAllow = (reason: string, source: string, withObligations: boolean): Decision => {
    const blocking = findBlockingProtectionPolicy(principal, ancestors, bundle.protectionPolicies);
    if (blocking) {
      return deny(
        blocking.reason ||
          `Protection policy for label "${blocking.label}" on ${blocking.resourceId} blocks principals not in the allow-list.`,
        'protection-policy',
      );
    }
    if (!withObligations) return allow(reason, source, []);

    const obligations = computeRoleObligations(applicableRoles, table);
    // export-block can also come from a protection policy the principal IS
    // allow-listed on (restrict-only, additive to role obligations).
    const policyExportBlock = bundle.protectionPolicies.some(
      (pp) =>
        ancestors.has(pp.resourceId) &&
        pp.exportBlock &&
        pp.allowPrincipals.some((id) => principalMatches(principal, id)),
    );
    if (policyExportBlock && !obligations.some((o) => o.kind === 'export-block')) {
      obligations.push({ kind: 'export-block' });
    }
    return allow(reason, source, obligations);
  };

  // 1. Tenant admin — short-circuit ABOVE explicit deny (a tenant admin cannot
  //    be denied). No obligations: admin sees everything.
  if (bundle.tenantAdmin || bundle.domainTier === 'tenant-admin') {
    return allow('Tenant administrator — full control.', 'tenant-admin', []);
  }

  // 2. Explicit DENY — hard deny, overrides everything below. Matches the
  //    principal (direct or via group) on the resource OR any ancestor.
  for (const g of bundle.aclGrants) {
    if (g.effect !== 'deny') continue;
    if (!principalMatches(principal, g.principalId)) continue;
    if (!ancestors.has(g.resourceId)) continue;
    if (g.action && g.action !== action) continue;
    return deny(g.reason || `Explicit deny on ${g.resourceId} for ${principal.upn}.`, 'explicit-deny');
  }

  // 3. Domain tier.
  if (bundle.domainTier === 'domain-admin' && tierGrants('admin', action)) {
    return finalizeAllow('Domain admin — full control within the domain subtree.', 'domain-admin', false);
  }
  if (bundle.domainTier === 'domain-contributor' && tierGrants('write', action)) {
    return finalizeAllow('Domain contributor — create/assign within the domain.', 'domain-contributor', true);
  }

  // 4. Workspace role (inherited down to every item/table/… in the workspace).
  if (bundle.workspaceRole) {
    const tier = WS_ROLE_TIER[bundle.workspaceRole];
    if (tierGrants(tier, action)) {
      return finalizeAllow(
        `Workspace ${bundle.workspaceRole} role grants ${action}.`,
        `workspace-role:${bundle.workspaceRole}`,
        tier !== 'admin',
      );
    }
  }

  // 5. Item share grants — additive per-item permissions.
  if (itemId) {
    for (const s of bundle.shares) {
      if (s.itemId !== itemId) continue;
      if (!principalMatches(principal, s.principalId)) continue;
      if (shareGrantsAction(s.permissionTypes, action)) {
        return finalizeAllow(`Item share grants ${action} (additive).`, 'item-share', true);
      }
    }
  }

  // 5b. Explicit ALLOW grant (_aclGrants effect:'allow') — an additive positive
  //     grant an admin made directly on this resource or an ancestor, for this
  //     action. Peer of an item share; obligations still apply (admin sees all).
  for (const g of bundle.aclGrants) {
    if (g.effect !== 'allow') continue;
    if (!principalMatches(principal, g.principalId)) continue;
    if (!ancestors.has(g.resourceId)) continue;
    if (g.action && g.action !== action) continue;
    return finalizeAllow(
      g.reason || `Explicit grant of ${action} on ${g.resourceId}.`,
      'explicit-allow',
      action !== 'admin',
    );
  }

  // 6. OneLake security role — grants read/data (+write if ReadWrite) and
  //    carries OLS/RLS/CLS obligations.
  for (const r of applicableRoles) {
    if (onelakeGrantsAction(r, action)) {
      return finalizeAllow(`OneLake security role "${r.roleName}" grants ${action}.`, 'onelake-role', true);
    }
  }

  // else — default deny.
  return deny(`No grant for action "${action}" on ${resource.level} ${resource.id}.`, 'default-deny');
}

// Test-only: expose the pure sub-helpers so the truth-table can assert the
// obligation algebra in isolation without re-deriving it.
export const __testing = {
  computeRoleObligations,
  shareGrantsAction,
  roleCoversResource,
  tierGrants,
};
