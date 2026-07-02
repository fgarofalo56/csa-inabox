/**
 * PDP (Policy Decision Point) — PURE type spine for the EH Phase-1 authorize()
 * composition engine.
 *
 * ZERO Azure / Cosmos imports. This module mirrors the same discipline as
 * `lib/azure/onelake-security-rules.ts`: every string-union it needs from a
 * silo (DomainTier, WorkspaceRoleName, ItemPermissionType, OneLakePermission)
 * is RE-DECLARED here structurally rather than imported, so the file (and
 * `evaluate.ts`, which only depends on this one) import-cleanly under the
 * vitest node env without pulling in `@azure/identity` / `@azure/cosmos`.
 *
 * The redeclared aliases are STRUCTURALLY IDENTICAL to the silo originals, so a
 * value typed as the silo type is assignable to the alias and vice-versa — the
 * impure `context-loader.ts` (which imports the real silo functions) maps silo
 * rows onto these shapes with no casts beyond defensive `as any` reads of
 * not-yet-persisted fields (RLS/CLS predicates).
 *
 * Decision algebra encoded by `evaluate.ts` (see that file) follows the fixed
 * precedence in appendix-multi-domain-acl §1.2 — OneLake effective-role
 * semantics plus an explicit-deny layer.
 */

// ---------------------------------------------------------------------------
// Caller identity
// ---------------------------------------------------------------------------

/** The authenticated caller. `groups` carries the Entra group object-ids the
 *  session cookie holds at sign-in (the same `claims.groups` the silos use). */
export interface Principal {
  oid: string;
  upn: string;
  groups: string[];
  tenantId: string;
}

// ---------------------------------------------------------------------------
// Resource hierarchy (inheritance walk)
// ---------------------------------------------------------------------------

/** Levels of the Loom resource tree, top → bottom. A workspace role INHERITS
 *  down to every item/table/column/row beneath it unless overridden. */
export type ResourceLevel = 'domain' | 'workspace' | 'item' | 'table' | 'column' | 'row';

/**
 * A reference to a single resource, carrying a `parent` link so `evaluate()`
 * can walk the ancestor chain (row → column → table → item → workspace →
 * domain) for inheritance + ancestor-scoped grant/deny/policy matching.
 */
export interface ResourceRef {
  level: ResourceLevel;
  /** Stable id at this level (domainId / workspaceId / itemId / table id …). */
  id: string;
  /** Parent in the inheritance hierarchy. Absent at the root (domain). */
  parent?: ResourceRef;
  /** Item-level only: the Loom item type (lakehouse / warehouse / …). */
  itemType?: string;
  /** table/column/row: the table name the OLS/RLS/CLS obligations key on. When
   *  absent on a `table` level, `id` is used as the table name. */
  table?: string;
  /** column level: the column name. */
  column?: string;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action = 'read' | 'write' | 'admin' | 'share' | 'build' | 'execute';

// ---------------------------------------------------------------------------
// Obligations carried by a CONSTRAINED ALLOW
// ---------------------------------------------------------------------------

/**
 * An obligation the caller (route / data-plane) MUST enforce on top of an
 * allow. RLS narrows rows (a SQL predicate), CLS narrows columns (the allowed
 * set), export-block forbids carrying the data out (CSV/TXT export etc.).
 */
export type Obligation =
  | { kind: 'rls'; table: string; predicate: string }
  | { kind: 'cls'; table: string; allowedColumns: string[] }
  | { kind: 'export-block' };

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** The PDP verdict. `effect:'allow'` MAY still carry obligations[] (a
 *  constrained allow); `effect:'deny'` always carries empty obligations. */
export interface Decision {
  effect: 'allow' | 'deny';
  /** Human-readable rationale (surfaced in a 403 body / audit log). */
  reason: string;
  /** Which precedence layer was decisive. One of: 'tenant-admin',
   *  'explicit-deny', 'domain-admin', 'domain-contributor',
   *  'workspace-role:<Role>', 'item-share', 'onelake-role',
   *  'protection-policy', 'default-deny'. */
  source: string;
  obligations: Obligation[];
}

// ---------------------------------------------------------------------------
// Silo-mirrored string unions (re-declared, NOT imported — keeps this file
// free of any Azure/Cosmos module in its import graph).
// ---------------------------------------------------------------------------

/** Mirrors `lib/auth/domain-role.ts` DomainTier. */
export type DomainTier = 'tenant-admin' | 'domain-admin' | 'domain-contributor' | null;

/** Mirrors `lib/azure/workspace-role-model.ts` WorkspaceRoleName. */
export type WorkspaceRoleName = 'Admin' | 'Member' | 'Contributor' | 'Viewer';

/** Mirrors `lib/azure/item-permissions-model.ts` ItemPermissionType. */
export type ItemPermissionType =
  | 'Read'
  | 'Edit'
  | 'Reshare'
  | 'ReadData'
  | 'ReadAllSQL'
  | 'ReadAllSpark'
  | 'SubscribeOneLakeEvents'
  | 'Execute'
  | 'Build';

/** Mirrors `lib/azure/onelake-security-rules.ts` OneLakePermission. */
export type OneLakePermission = 'Read' | 'ReadWrite';

// ---------------------------------------------------------------------------
// PolicyBundle — the already-fetched inputs evaluate() needs. Produced by
// context-loader.ts, consumed by evaluate.ts. Action-independent: the same
// bundle answers any action for a (principal, resource).
// ---------------------------------------------------------------------------

/**
 * One additive per-item permission grant. Mirrors a row of the REAL
 * `item-permissions` container (`ItemPermission` in
 * lib/azure/item-permissions-client.ts) — NOT the `shares` link-token
 * container. `permissionTypes` is the additive set (Read/Edit/Reshare/
 * ReadData/…) the principal holds on `itemId`.
 */
export interface ShareGrant {
  principalId: string;
  principalType?: 'user' | 'group';
  itemId: string;
  permissionTypes: ItemPermissionType[];
}

/**
 * One OneLake security role binding the principal is a MEMBER of. Mirrors a
 * `OneLakeSecurityRole` row (lib/azure/onelake-security-client.ts) for OLS
 * (paths + permissions + members) and additionally carries the per-table RLS
 * predicates / CLS allowed-column sets the role narrows by. `rls`/`cls` are
 * read defensively from the role doc (the current OLS store persists OLS today;
 * RLS/CLS predicates flow through here when present).
 */
export interface OneLakeRoleBinding {
  roleName: string;
  itemId: string;
  /** OLS scope: '*' (all) or paths like '/Tables/sales', '/Files/raw'. */
  paths: string[];
  permissions: OneLakePermission[];
  /** Entra object-ids (users/groups) that are members of this role. */
  memberOids: string[];
  /** RLS: per-table row predicate. Absent table entry = all rows (unrestricted). */
  rls?: Array<{ table: string; predicate: string }>;
  /** CLS: per-table allowed columns. Absent table entry = all columns. */
  cls?: Array<{ table: string; allowedColumns: string[] }>;
  /** True when this role forbids export of the data it governs. */
  exportBlocked?: boolean;
}

/**
 * An explicit ACL grant row (the `_aclGrants` container). `effect:'deny'` is a
 * HARD deny that overrides every allow below tenant-admin. `effect:'allow'` is
 * an additive positive grant. `resourceId` may match the resource OR any
 * ancestor (a deny on the workspace denies its items). Optional `action`
 * scopes the grant to a single action (absent = all actions).
 */
export interface AclGrant {
  principalId: string;
  resourceId: string;
  effect: 'allow' | 'deny';
  action?: Action;
  reason?: string;
}

/**
 * A label-driven protection policy (the `_protectionPolicies` container).
 * Restrict-ONLY (Fabric "retain-or-block"): a labeled resource with a policy
 * DENIES any principal not in `allowPrincipals`. `exportBlock` additionally
 * forbids export for allow-listed principals.
 */
export interface ProtectionPolicy {
  resourceId: string;
  label: string;
  allowPrincipals: string[];
  exportBlock?: boolean;
  reason?: string;
}

/** The minimal already-fetched input set `evaluate()` composes a Decision from. */
export interface PolicyBundle {
  /** Caller is a tenant admin (isTenantAdminTier). Short-circuits to allow admin. */
  tenantAdmin: boolean;
  /** Caller's tier on the resource's domain (resolveDomainTier). */
  domainTier: DomainTier;
  /** Caller's highest effective role on the resource's workspace (resolveEffectiveRole). */
  workspaceRole: WorkspaceRoleName | null;
  /** Additive per-item permission grants for this principal (item-permissions container). */
  shares: ShareGrant[];
  /** OneLake security roles this principal is a member of, with OLS + RLS/CLS. */
  onelakeRoles: OneLakeRoleBinding[];
  /** Explicit allow/deny ACL grants (_aclGrants). Empty = none. */
  aclGrants: AclGrant[];
  /** Label-driven protection policies (_protectionPolicies). Empty = none. */
  protectionPolicies: ProtectionPolicy[];
}
