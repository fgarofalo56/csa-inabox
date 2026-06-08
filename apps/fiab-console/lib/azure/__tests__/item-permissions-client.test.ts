import { describe, it, expect, afterEach } from 'vitest';
import {
  ALL_PERMISSION_TYPES,
  PERMISSION_TYPE_ACL_BITS,
  rbacRoleFor,
  unionAclBits,
  fabricPermissionsEnabled,
  type ItemPermissionType,
} from '../item-permissions-model';

const ORIG_FABRIC = process.env.LOOM_FABRIC_PERMISSIONS_ENABLED;
const ORIG_CLOUD = process.env.AZURE_CLOUD;

afterEach(() => {
  if (ORIG_FABRIC === undefined) delete process.env.LOOM_FABRIC_PERMISSIONS_ENABLED;
  else process.env.LOOM_FABRIC_PERMISSIONS_ENABLED = ORIG_FABRIC;
  if (ORIG_CLOUD === undefined) delete process.env.AZURE_CLOUD;
  else process.env.AZURE_CLOUD = ORIG_CLOUD;
});

describe('item-permissions-client — Fabric permission-type model', () => {
  it('exposes the 9 Fabric one-for-one permission types', () => {
    expect(ALL_PERMISSION_TYPES).toEqual([
      'Read', 'Edit', 'Reshare', 'ReadData', 'ReadAllSQL', 'ReadAllSpark',
      'SubscribeOneLakeEvents', 'Execute', 'Build',
    ]);
  });

  it('maps Read → r-x and Edit → rwx POSIX ACL bits', () => {
    expect(PERMISSION_TYPE_ACL_BITS.Read).toEqual({ read: true, write: false, execute: true });
    expect(PERMISSION_TYPE_ACL_BITS.Edit).toEqual({ read: true, write: true, execute: true });
  });

  it('does NOT map metadata-only types to ACL bits', () => {
    expect(PERMISSION_TYPE_ACL_BITS.Reshare).toBeUndefined();
    expect(PERMISSION_TYPE_ACL_BITS.Execute).toBeUndefined();
    expect(PERMISSION_TYPE_ACL_BITS.Build).toBeUndefined();
    expect(PERMISSION_TYPE_ACL_BITS.SubscribeOneLakeEvents).toBeUndefined();
  });
});

describe('rbacRoleFor — Storage data-plane role selection', () => {
  it('Edit → Storage Blob Data Contributor', () => {
    expect(rbacRoleFor(['Read', 'Edit'])).toBe('Storage Blob Data Contributor');
  });
  it('read-family → Storage Blob Data Reader', () => {
    expect(rbacRoleFor(['Read'])).toBe('Storage Blob Data Reader');
    expect(rbacRoleFor(['ReadData'])).toBe('Storage Blob Data Reader');
    expect(rbacRoleFor(['ReadAllSpark'])).toBe('Storage Blob Data Reader');
  });
  it('metadata-only set → no RBAC role', () => {
    expect(rbacRoleFor(['Reshare'] as ItemPermissionType[])).toBeNull();
    expect(rbacRoleFor(['Execute', 'Build'] as ItemPermissionType[])).toBeNull();
  });
});

describe('unionAclBits — most-permissive wins', () => {
  it('unions Read + Edit to rwx', () => {
    expect(unionAclBits(['Read', 'Edit'])).toEqual({ read: true, write: true, execute: true });
  });
  it('Read alone is r-x', () => {
    expect(unionAclBits(['Read'])).toEqual({ read: true, write: false, execute: true });
  });
  it('returns null when no data-plane types are present', () => {
    expect(unionAclBits(['Reshare', 'Build'] as ItemPermissionType[])).toBeNull();
  });
});

describe('fabricPermissionsEnabled — opt-in + Gov gate', () => {
  it('false by default (no env)', () => {
    delete process.env.LOOM_FABRIC_PERMISSIONS_ENABLED;
    expect(fabricPermissionsEnabled()).toBe(false);
  });
  it('true only when flag set in a non-Gov cloud', () => {
    process.env.LOOM_FABRIC_PERMISSIONS_ENABLED = 'true';
    process.env.AZURE_CLOUD = 'AzureCloud';
    expect(fabricPermissionsEnabled()).toBe(true);
  });
  it('ignored in GCC-High / IL5 (AzureUSGovernment) even when flag set', () => {
    process.env.LOOM_FABRIC_PERMISSIONS_ENABLED = 'true';
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(fabricPermissionsEnabled()).toBe(false);
  });
});
