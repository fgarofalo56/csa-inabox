import { describe, it, expect } from 'vitest';
import {
  pickHighestRole,
  isWorkspaceRoleName,
  ROLE_PRIORITY,
  ROLE_TO_RBAC,
  WORKSPACE_ROLE_NAMES,
  type WorkspaceRoleName,
} from '../workspace-role-model';

describe('ROLE_PRIORITY', () => {
  it('orders Admin > Member > Contributor > Viewer', () => {
    expect(ROLE_PRIORITY.Admin).toBeGreaterThan(ROLE_PRIORITY.Member);
    expect(ROLE_PRIORITY.Member).toBeGreaterThan(ROLE_PRIORITY.Contributor);
    expect(ROLE_PRIORITY.Contributor).toBeGreaterThan(ROLE_PRIORITY.Viewer);
  });
});

describe('ROLE_TO_RBAC', () => {
  it('maps Admin + Member to Contributor and Contributor + Viewer to Reader', () => {
    const contributor = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
    const reader = 'acdd72a7-3385-48ef-bd42-f606fba81ae7';
    expect(ROLE_TO_RBAC.Admin.roleDefGuid).toBe(contributor);
    expect(ROLE_TO_RBAC.Member.roleDefGuid).toBe(contributor);
    expect(ROLE_TO_RBAC.Contributor.roleDefGuid).toBe(reader);
    expect(ROLE_TO_RBAC.Viewer.roleDefGuid).toBe(reader);
  });
});

describe('pickHighestRole (nested-group resolution)', () => {
  it('returns null for no inherited roles', () => {
    expect(pickHighestRole([])).toBeNull();
  });

  it('returns the single inherited role', () => {
    expect(pickHighestRole(['Viewer'])).toBe('Viewer');
  });

  it('returns the HIGHEST when a user inherits via multiple (nested) groups', () => {
    // e.g. member of Group-A (Member) and Group-B (Contributor) → Member wins.
    expect(pickHighestRole(['Contributor', 'Member'])).toBe('Member');
    expect(pickHighestRole(['Viewer', 'Admin', 'Contributor'])).toBe('Admin');
    expect(pickHighestRole(['Viewer', 'Contributor'])).toBe('Contributor');
  });

  it('is order-independent', () => {
    const roles: WorkspaceRoleName[] = ['Viewer', 'Member', 'Contributor', 'Admin'];
    expect(pickHighestRole(roles)).toBe('Admin');
    expect(pickHighestRole([...roles].reverse())).toBe('Admin');
  });
});

describe('isWorkspaceRoleName', () => {
  it('accepts the four canonical role names', () => {
    for (const r of WORKSPACE_ROLE_NAMES) expect(isWorkspaceRoleName(r)).toBe(true);
  });
  it('rejects unknown / lowercase / non-string values', () => {
    expect(isWorkspaceRoleName('admin')).toBe(false); // case-sensitive (Fabric casing)
    expect(isWorkspaceRoleName('Owner')).toBe(false);
    expect(isWorkspaceRoleName(undefined)).toBe(false);
    expect(isWorkspaceRoleName(3)).toBe(false);
  });
});
