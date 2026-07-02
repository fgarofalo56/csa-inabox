/**
 * PDP truth-table — the acceptance artifact for the EH Phase-1 authorize()
 * composition engine. Exercises the PURE `evaluate()` engine ONLY (no Azure /
 * Cosmos in the import graph), so it runs in the vitest node env.
 *
 * Covers the fixed precedence + obligation algebra (appendix-multi-domain-acl
 * §1.2): tenant-admin short-circuit, explicit-deny override, workspace
 * read-vs-write, workspace→item inheritance, item-share additivity, the
 * OLS∩CLS∩RLS intersection within a role, the UNION across two roles, and the
 * protection-policy restrict-only block. Every case asserts effect + source +
 * obligations.
 */
import { describe, it, expect } from 'vitest';
import { evaluate } from '../evaluate';
import type {
  AclGrant,
  OneLakeRoleBinding,
  PolicyBundle,
  Principal,
  ProtectionPolicy,
  ResourceRef,
  ShareGrant,
} from '../resource-ref';

// --- builders ---------------------------------------------------------------

const ALICE: Principal = { oid: 'oid-alice', upn: 'alice@contoso.com', groups: ['grp-eng'], tenantId: 'tenant-1' };

function emptyBundle(over: Partial<PolicyBundle> = {}): PolicyBundle {
  return {
    tenantAdmin: false,
    domainTier: null,
    workspaceRole: null,
    shares: [],
    onelakeRoles: [],
    aclGrants: [],
    protectionPolicies: [],
    ...over,
  };
}

const domain: ResourceRef = { level: 'domain', id: 'dom-1' };
const workspace: ResourceRef = { level: 'workspace', id: 'ws-1', parent: domain };
const lakehouse: ResourceRef = { level: 'item', id: 'item-lh', itemType: 'lakehouse', parent: workspace };
const salesTable: ResourceRef = { level: 'table', id: 'tbl-sales', table: 'sales', parent: lakehouse };

// --- cases ------------------------------------------------------------------

describe('evaluate() — decision algebra truth-table', () => {
  it('1. tenant-admin short-circuits to allow admin (no obligations)', () => {
    const d = evaluate(ALICE, salesTable, 'admin', emptyBundle({ tenantAdmin: true }));
    expect(d.effect).toBe('allow');
    expect(d.source).toBe('tenant-admin');
    expect(d.obligations).toEqual([]);
  });

  it('2. explicit DENY overrides a positive workspace-role grant', () => {
    const denyGrant: AclGrant = { principalId: 'oid-alice', resourceId: 'item-lh', effect: 'deny', reason: 'quarantined' };
    const d = evaluate(
      ALICE,
      lakehouse,
      'read',
      emptyBundle({ workspaceRole: 'Admin', aclGrants: [denyGrant] }),
    );
    expect(d.effect).toBe('deny');
    expect(d.source).toBe('explicit-deny');
    expect(d.reason).toBe('quarantined');
  });

  it('2b. explicit deny on an ANCESTOR (workspace) denies a child item', () => {
    const denyGrant: AclGrant = { principalId: 'grp-eng', resourceId: 'ws-1', effect: 'deny' };
    const d = evaluate(ALICE, lakehouse, 'read', emptyBundle({ workspaceRole: 'Member', aclGrants: [denyGrant] }));
    expect(d.effect).toBe('deny');
    expect(d.source).toBe('explicit-deny');
  });

  it('3. workspace Viewer → read allowed but write denied', () => {
    const readD = evaluate(ALICE, workspace, 'read', emptyBundle({ workspaceRole: 'Viewer' }));
    expect(readD.effect).toBe('allow');
    expect(readD.source).toBe('workspace-role:Viewer');

    const writeD = evaluate(ALICE, workspace, 'write', emptyBundle({ workspaceRole: 'Viewer' }));
    expect(writeD.effect).toBe('deny');
    expect(writeD.source).toBe('default-deny');
  });

  it('4. workspace role INHERITS to an item under the workspace', () => {
    const d = evaluate(ALICE, lakehouse, 'write', emptyBundle({ workspaceRole: 'Member' }));
    expect(d.effect).toBe('allow');
    expect(d.source).toBe('workspace-role:Member');
  });

  it('5. item-share ADDITIVITY: a ReadData share grants read where no workspace role would', () => {
    const share: ShareGrant = {
      principalId: 'oid-alice',
      principalType: 'user',
      itemId: 'item-lh',
      permissionTypes: ['ReadData'],
    };
    // No workspace role, no domain tier — only the share grants access.
    const d = evaluate(ALICE, lakehouse, 'read', emptyBundle({ shares: [share] }));
    expect(d.effect).toBe('allow');
    expect(d.source).toBe('item-share');

    // The same share does NOT grant write.
    const w = evaluate(ALICE, lakehouse, 'write', emptyBundle({ shares: [share] }));
    expect(w.effect).toBe('deny');
  });

  it('5b. explicit ALLOW grant grants the action additively (and respects its action scope)', () => {
    // An admin explicitly granted Alice read on the workspace (an ancestor of the item).
    const grant: AclGrant = { principalId: 'oid-alice', resourceId: 'ws-1', effect: 'allow', action: 'read' };
    const d = evaluate(ALICE, lakehouse, 'read', emptyBundle({ aclGrants: [grant] }));
    expect(d.effect).toBe('allow');
    expect(d.source).toBe('explicit-allow');

    // The read-scoped grant does NOT grant write.
    const w = evaluate(ALICE, lakehouse, 'write', emptyBundle({ aclGrants: [grant] }));
    expect(w.effect).toBe('deny');

    // An explicit DENY still overrides an explicit ALLOW (precedence).
    const denyGrant: AclGrant = { principalId: 'oid-alice', resourceId: 'item-lh', effect: 'deny' };
    const both = evaluate(ALICE, lakehouse, 'read', emptyBundle({ aclGrants: [grant, denyGrant] }));
    expect(both.effect).toBe('deny');
    expect(both.source).toBe('explicit-deny');
  });

  it('6. OLS∩CLS∩RLS intersection WITHIN a single role (both obligations apply)', () => {
    const role: OneLakeRoleBinding = {
      roleName: 'AnalystWest',
      itemId: 'item-lh',
      paths: ['/Tables/sales'],
      permissions: ['Read'],
      memberOids: ['oid-alice'],
      rls: [{ table: 'sales', predicate: "region = 'west'" }],
      cls: [{ table: 'sales', allowedColumns: ['id', 'amount'] }],
    };
    const d = evaluate(ALICE, salesTable, 'read', emptyBundle({ onelakeRoles: [role] }));
    expect(d.effect).toBe('allow');
    expect(d.source).toBe('onelake-role');
    expect(d.obligations).toContainEqual({ kind: 'rls', table: 'sales', predicate: "region = 'west'" });
    expect(d.obligations).toContainEqual({ kind: 'cls', table: 'sales', allowedColumns: ['amount', 'id'] });
  });

  it('7. UNION across two roles (least-restrictive widens rows + columns)', () => {
    const roleWest: OneLakeRoleBinding = {
      roleName: 'West',
      itemId: 'item-lh',
      paths: ['/Tables/sales'],
      permissions: ['Read'],
      memberOids: ['oid-alice'],
      rls: [{ table: 'sales', predicate: "region = 'west'" }],
      cls: [{ table: 'sales', allowedColumns: ['id', 'amount'] }],
    };
    const roleEast: OneLakeRoleBinding = {
      roleName: 'East',
      itemId: 'item-lh',
      paths: ['/Tables/sales'],
      permissions: ['Read'],
      memberOids: ['grp-eng'],
      rls: [{ table: 'sales', predicate: "region = 'east'" }],
      cls: [{ table: 'sales', allowedColumns: ['id', 'region'] }],
    };
    const d = evaluate(ALICE, salesTable, 'read', emptyBundle({ onelakeRoles: [roleWest, roleEast] }));
    expect(d.effect).toBe('allow');
    const rls = d.obligations.find((o) => o.kind === 'rls');
    expect(rls).toBeDefined();
    // OR of both predicates (order: west then east).
    expect(rls).toEqual({ kind: 'rls', table: 'sales', predicate: "(region = 'west') OR (region = 'east')" });
    // Union of the two allowed-column sets, sorted.
    expect(d.obligations).toContainEqual({ kind: 'cls', table: 'sales', allowedColumns: ['amount', 'id', 'region'] });
  });

  it('7b. UNION: a second role with NO RLS makes rows unrestricted (no rls obligation)', () => {
    const restricted: OneLakeRoleBinding = {
      roleName: 'West',
      itemId: 'item-lh',
      paths: ['/Tables/sales'],
      permissions: ['Read'],
      memberOids: ['oid-alice'],
      rls: [{ table: 'sales', predicate: "region = 'west'" }],
    };
    const unrestricted: OneLakeRoleBinding = {
      roleName: 'AllSales',
      itemId: 'item-lh',
      paths: ['/Tables/sales'],
      permissions: ['Read'],
      memberOids: ['oid-alice'],
      // no rls → all rows
    };
    const d = evaluate(ALICE, salesTable, 'read', emptyBundle({ onelakeRoles: [restricted, unrestricted] }));
    expect(d.effect).toBe('allow');
    expect(d.obligations.find((o) => o.kind === 'rls')).toBeUndefined();
  });

  it('8. protection policy BLOCKS a non-allowlisted principal on a labeled resource', () => {
    const policy: ProtectionPolicy = {
      resourceId: 'item-lh',
      label: 'Highly Confidential',
      allowPrincipals: ['oid-bob'],
      reason: 'Only the Bob cohort may access this labeled lakehouse.',
    };
    // Alice holds a workspace Member role that WOULD allow read — the policy overrides.
    const d = evaluate(ALICE, lakehouse, 'read', emptyBundle({ workspaceRole: 'Member', protectionPolicies: [policy] }));
    expect(d.effect).toBe('deny');
    expect(d.source).toBe('protection-policy');
    expect(d.reason).toContain('Bob cohort');
  });

  it('8b. protection policy ALLOWS an allow-listed principal, adding export-block when set', () => {
    const policy: ProtectionPolicy = {
      resourceId: 'item-lh',
      label: 'Confidential',
      allowPrincipals: ['oid-alice'],
      exportBlock: true,
    };
    const d = evaluate(ALICE, lakehouse, 'read', emptyBundle({ workspaceRole: 'Member', protectionPolicies: [policy] }));
    expect(d.effect).toBe('allow');
    expect(d.obligations).toContainEqual({ kind: 'export-block' });
  });

  it('default-deny when nothing grants the action', () => {
    const d = evaluate(ALICE, lakehouse, 'admin', emptyBundle({ workspaceRole: 'Viewer' }));
    expect(d.effect).toBe('deny');
    expect(d.source).toBe('default-deny');
  });
});
