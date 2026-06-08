import { describe, it, expect } from 'vitest';
import {
  buildCatalogFilter,
  docForGovernanceItem,
  isCatalogDataType,
} from '../governance-catalog-shapes';

describe('isCatalogDataType', () => {
  it('accepts data-catalog item types', () => {
    expect(isCatalogDataType('lakehouse')).toBe(true);
    expect(isCatalogDataType('warehouse')).toBe(true);
    expect(isCatalogDataType('semantic-model')).toBe(true);
  });
  it('rejects non-data item types', () => {
    expect(isCatalogDataType('notebook')).toBe(false);
    expect(isCatalogDataType('report')).toBe(false);
  });
});

describe('buildCatalogFilter', () => {
  const base = { q: '', tenantId: 'tenant-1', callerWorkspaceIds: ['ws-a', 'ws-b'] };

  it('always scopes to the tenant', () => {
    const f = buildCatalogFilter(base);
    expect(f).toContain("tenantId eq 'tenant-1'");
  });

  it('adds the workspace OR isDiscoverable clause for non-admin callers', () => {
    const f = buildCatalogFilter(base);
    expect(f).toContain("workspaceId eq 'ws-a'");
    expect(f).toContain("workspaceId eq 'ws-b'");
    expect(f).toContain('isDiscoverable eq true');
  });

  it('skips the discoverability clause for all-access callers', () => {
    const f = buildCatalogFilter({ ...base, callerHasAllAccess: true });
    expect(f).not.toContain('isDiscoverable');
    expect(f).not.toContain('workspaceId eq');
  });

  it('appends domain / type / endorsement / sensitivity filters', () => {
    const f = buildCatalogFilter({
      ...base, domainId: 'finance', itemType: 'lakehouse',
      endorsement: 'Certified', sensitivity: 'Confidential',
    });
    expect(f).toContain("domainId eq 'finance'");
    expect(f).toContain("itemType eq 'lakehouse'");
    expect(f).toContain("endorsement eq 'Certified'");
    expect(f).toContain("sensitivity eq 'Confidential'");
  });

  it('escapes single quotes to prevent OData injection', () => {
    const f = buildCatalogFilter({ ...base, tenantId: "t'1", domainId: "a'b" });
    expect(f).toContain("tenantId eq 't''1'");
    expect(f).toContain("domainId eq 'a''b'");
  });
});

describe('docForGovernanceItem', () => {
  const ctx = { tenantId: 'tenant-1', workspaceName: 'Finance WS', workspaceDomain: 'finance' };

  it('projects core fields and inherits workspace domain', () => {
    const doc = docForGovernanceItem(
      { id: 'i1', workspaceId: 'ws-a', itemType: 'lakehouse', displayName: 'Bronze', createdBy: 'alice@x', updatedAt: '2026-01-01T00:00:00Z', state: {} },
      ctx,
    );
    expect(doc.id).toBe('i1');
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.workspaceName).toBe('Finance WS');
    expect(doc.domainId).toBe('finance');
    expect(doc.owner).toBe('alice@x');
    expect(doc.isDiscoverable).toBe(false);
  });

  it('prefers item state.domainId over the workspace domain', () => {
    const doc = docForGovernanceItem(
      { id: 'i2', workspaceId: 'ws-a', itemType: 'warehouse', displayName: 'DW', state: { domainId: 'ops' } },
      ctx,
    );
    expect(doc.domainId).toBe('ops');
  });

  it('marks endorsed items discoverable and derives Certified from certified flag', () => {
    const doc = docForGovernanceItem(
      { id: 'i3', workspaceId: 'ws-a', itemType: 'semantic-model', displayName: 'Sales', state: { certified: true } },
      ctx,
    );
    expect(doc.endorsement).toBe('Certified');
    expect(doc.isDiscoverable).toBe(true);
  });

  it('honors an explicit discoverable flag without endorsement', () => {
    const doc = docForGovernanceItem(
      { id: 'i4', workspaceId: 'ws-a', itemType: 'dataset', displayName: 'Ref', state: { discoverable: true } },
      ctx,
    );
    expect(doc.endorsement).toBeUndefined();
    expect(doc.isDiscoverable).toBe(true);
  });
});
