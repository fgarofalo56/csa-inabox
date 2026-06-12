/**
 * topology.test — domain-aware item-create routing resolver.
 *
 * Verifies the PURE resolution + gate logic (no Cosmos / ARM I/O):
 *   - shared/tenant items  → DMLZ (admin sub + LOOM_ADMIN_RG)
 *   - domain-scoped items  → domain.subscriptionIds[0] + derived/explicit DLZ RG
 *   - empty registry       → single-sub fallback (LOOM_SUBSCRIPTION_ID + LOOM_DLZ_RG)
 *   - 403 gate             → names the exact Contributor grant + az fix
 *
 * resolveTargetFromRecords / isSharedTenantItem / deriveDlzResourceGroup /
 * buildItemCreateGate are pure, so they are unit-testable without a live Cosmos
 * or ARM endpoint (per no-vaporware: real logic, deterministic assertions).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isSharedTenantItem,
  deriveDlzResourceGroup,
  resolveTargetFromRecords,
  dmlzTarget,
  buildItemCreateGate,
  type DeployTarget,
} from '../topology';

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_ARM_ENDPOINT;
  process.env.LOOM_SUBSCRIPTION_ID = 'admin-sub-0000';
  process.env.LOOM_ADMIN_RG = 'rg-csa-loom-admin-eastus2';
  process.env.LOOM_DLZ_RG = 'rg-csa-loom-dlz-default-eastus2';
  process.env.LOOM_LOCATION = 'eastus2';
});
afterEach(() => {
  process.env = { ...SAVED };
});

const FINANCE = { id: 'finance', name: 'Finance', subscriptionIds: ['fin-sub-1111'] };

describe('isSharedTenantItem', () => {
  it('classifies tenant/shared surfaces as shared (→ DMLZ)', () => {
    for (const t of ['catalog', 'marketplace', 'governance-domain', 'domain', 'glossary-term', 'data-product', 'metastore']) {
      expect(isSharedTenantItem(t)).toBe(true);
    }
  });
  it('classifies domain-scoped item types as NOT shared', () => {
    for (const t of ['lakehouse', 'warehouse', 'eventhouse', 'kql-database', 'notebook', 'mirrored-database']) {
      expect(isSharedTenantItem(t)).toBe(false);
    }
  });
  it('is case-insensitive and ignores empties', () => {
    expect(isSharedTenantItem('Catalog')).toBe(true);
    expect(isSharedTenantItem('')).toBe(false);
  });
});

describe('deriveDlzResourceGroup — the bicep/bootstrap contract string', () => {
  it('matches rg-csa-loom-dlz-{domain}-{location}', () => {
    expect(deriveDlzResourceGroup('finance', 'eastus2')).toBe('rg-csa-loom-dlz-finance-eastus2');
  });
  it('slugs spaces/casing the same way bicep receives the domain name', () => {
    expect(deriveDlzResourceGroup('Supply Chain', 'westus3')).toBe('rg-csa-loom-dlz-supply-chain-westus3');
  });
  it('uses LOOM_LOCATION when no location passed', () => {
    expect(deriveDlzResourceGroup('finance')).toBe('rg-csa-loom-dlz-finance-eastus2');
  });
});

describe('resolveTargetFromRecords — routing', () => {
  it('shared/tenant item → DMLZ (admin sub + admin RG)', () => {
    const t = resolveTargetFromRecords('catalog', { id: 'ws1', domain: 'finance' }, [FINANCE]);
    expect(t.tier).toBe('dmlz');
    expect(t.subscriptionId).toBe('admin-sub-0000');
    expect(t.resourceGroup).toBe('rg-csa-loom-admin-eastus2');
  });

  it('domain-scoped item in a registered domain → subscriptionIds[0] + derived DLZ RG', () => {
    const t = resolveTargetFromRecords('lakehouse', { id: 'ws1', domain: 'finance' }, [FINANCE]);
    expect(t.tier).toBe('dlz');
    expect(t.subscriptionId).toBe('fin-sub-1111');
    expect(t.resourceGroup).toBe('rg-csa-loom-dlz-finance-eastus2');
    expect(t.domainId).toBe('finance');
  });

  it('honors an explicit dlzResourceGroup override on the domain record', () => {
    const t = resolveTargetFromRecords(
      'eventhouse',
      { id: 'ws1', domain: 'finance' },
      [{ ...FINANCE, dlzResourceGroup: 'rg-finance-custom' }],
    );
    expect(t.subscriptionId).toBe('fin-sub-1111');
    expect(t.resourceGroup).toBe('rg-finance-custom');
  });

  it('workspace with no domain → single-sub fallback (no behaviour change)', () => {
    const t = resolveTargetFromRecords('warehouse', { id: 'ws1' }, [FINANCE]);
    expect(t.tier).toBe('dlz');
    expect(t.subscriptionId).toBe('admin-sub-0000');
    expect(t.resourceGroup).toBe('rg-csa-loom-dlz-default-eastus2');
  });

  it('domain with EMPTY subscriptionIds (single-sub registry) → single-sub fallback', () => {
    const t = resolveTargetFromRecords('lakehouse', { id: 'ws1', domain: 'finance' }, [
      { id: 'finance', name: 'Finance', subscriptionIds: [] },
    ]);
    expect(t.subscriptionId).toBe('admin-sub-0000');
    expect(t.resourceGroup).toBe('rg-csa-loom-dlz-default-eastus2');
  });

  it('domain id not found in registry → single-sub fallback', () => {
    const t = resolveTargetFromRecords('notebook', { id: 'ws1', domain: 'ghost' }, [FINANCE]);
    expect(t.subscriptionId).toBe('admin-sub-0000');
  });
});

describe('dmlzTarget', () => {
  it('always targets the admin plane', () => {
    const t = dmlzTarget();
    expect(t.tier).toBe('dmlz');
    expect(t.subscriptionId).toBe('admin-sub-0000');
    expect(t.resourceGroup).toBe('rg-csa-loom-admin-eastus2');
  });
});

describe('buildItemCreateGate — honest 403 remediation', () => {
  it('names the exact Contributor role + scope + az fix script', () => {
    const target: DeployTarget = {
      ok: true,
      subscriptionId: 'fin-sub-1111',
      resourceGroup: 'rg-csa-loom-dlz-finance-eastus2',
      tier: 'dlz',
      domainId: 'finance',
      domainName: 'Finance',
      armBase: 'https://management.azure.com',
    };
    const gate = buildItemCreateGate(target);
    expect(gate.ok).toBe(false);
    expect(gate.redeploy).toBe(true);
    expect(gate.missingGrant).toContain('Contributor');
    expect(gate.missingGrant).toContain('b24988ac-6180-42a0-ab88-20f7382dd24c');
    expect(gate.missingGrant).toContain('fin-sub-1111');
    expect(gate.missingGrant).toContain('dlz-attach-itemcreate-rbac.bicep');
    expect(gate.fixScript).toContain('az role assignment create');
    expect(gate.fixScript).toContain('/subscriptions/fin-sub-1111/resourceGroups/rg-csa-loom-dlz-finance-eastus2');
  });
});
