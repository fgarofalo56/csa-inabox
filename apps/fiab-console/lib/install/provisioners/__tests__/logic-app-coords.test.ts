/**
 * Logic Apps ARM coordinate resolution — tested against the REAL module, not a
 * re-implementation.
 *
 * This file exists because of a specific failure class: the auto-bind suite
 * mocks `@/lib/install/provisioners/logic-app`, and its mock re-implements
 * `logicAppArmMissing`. A mock that models the CODE rather than reality cannot
 * catch a bug in the thing it is standing in for — which is exactly how the
 * original defect survived. These tests import the real functions and assert
 * against the variable names the platform bicep actually sets.
 *
 * The defect being locked down (#2954): the provisioner resolved its region from
 * `LOOM_LOGIC_LOCATION || LOOM_AZURE_LOCATION`. Neither is set by ANY bicep
 * module in this repo. The canonical variable the admin-plane stamps on the
 * Console container app is `LOOM_LOCATION`
 * (platform/fiab/bicep/modules/admin-plane/main.bicep). The result was a gate
 * that could never be satisfied: Loom never created a Logic App workflow in any
 * deployment, and the remediation text told operators to set variables that
 * nothing consumes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logicAppArmMissing, readLogicAppArmConfig, logicFallbackResourceGroup } from '../logic-app';

const ENV = { ...process.env };

const LOGIC_VARS = [
  'LOOM_LOGIC_SUB',
  'LOOM_LOGIC_RG',
  'LOOM_LOGIC_LOCATION',
  'LOOM_AZURE_LOCATION',
  'LOOM_LOCATION',
  'LOOM_SUBSCRIPTION_ID',
  'LOOM_DLZ_RG',
  'LOOM_ADMIN_RG',
];

beforeEach(() => {
  for (const v of LOGIC_VARS) delete process.env[v];
});

afterEach(() => {
  process.env = { ...ENV };
});

describe('logicAppArmMissing', () => {
  it('reports all three coordinates missing on a bare environment', () => {
    expect(logicAppArmMissing()).toHaveLength(3);
  });

  it('is SATISFIED by the variables the platform bicep actually sets', () => {
    // These three are the exact names admin-plane/main.bicep stamps on the
    // Console container app. If this test fails, the Logic Apps feature is
    // dead in every real deployment.
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_DLZ_RG = 'rg-loom';
    process.env.LOOM_LOCATION = 'eastus2';
    expect(logicAppArmMissing()).toEqual([]);
  });

  it('resolves the region from LOOM_LOCATION', () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_DLZ_RG = 'rg-loom';
    process.env.LOOM_LOCATION = 'centralus';
    expect(readLogicAppArmConfig().location).toBe('centralus');
  });

  it('still honours an explicit LOOM_LOGIC_LOCATION override', () => {
    process.env.LOOM_LOCATION = 'eastus2';
    process.env.LOOM_LOGIC_LOCATION = 'westus3';
    expect(readLogicAppArmConfig().location).toBe('westus3');
  });

  it('still honours the legacy LOOM_AZURE_LOCATION ahead of LOOM_LOCATION', () => {
    process.env.LOOM_LOCATION = 'eastus2';
    process.env.LOOM_AZURE_LOCATION = 'westeurope';
    expect(readLogicAppArmConfig().location).toBe('westeurope');
  });

  it('honours LOOM_LOGIC_SUB / LOOM_LOGIC_RG overrides', () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'shared-sub';
    process.env.LOOM_DLZ_RG = 'shared-rg';
    process.env.LOOM_LOCATION = 'eastus2';
    process.env.LOOM_LOGIC_SUB = 'logic-sub';
    process.env.LOOM_LOGIC_RG = 'logic-rg';
    const cfg = readLogicAppArmConfig();
    expect(cfg.subscriptionId).toBe('logic-sub');
    expect(cfg.resourceGroup).toBe('logic-rg');
  });

  it('names LOOM_LOCATION in the remediation, not the never-set LOOM_AZURE_LOCATION', () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_DLZ_RG = 'rg-loom';
    const missing = logicAppArmMissing();
    expect(missing).toHaveLength(1);
    // Telling an operator to set a variable nothing reads is worse than no
    // message at all — it sends them down a path that cannot work.
    expect(missing[0]).toContain('LOOM_LOCATION');
    expect(missing[0]).not.toContain('LOOM_AZURE_LOCATION');
  });

  it('reports only the subscription when RG + region are present', () => {
    process.env.LOOM_DLZ_RG = 'rg-loom';
    process.env.LOOM_LOCATION = 'eastus2';
    const missing = logicAppArmMissing();
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('LOOM_LOGIC_SUB');
  });

  it('readLogicAppArmConfig agrees with logicAppArmMissing', () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_DLZ_RG = 'rg-loom';
    process.env.LOOM_LOCATION = 'eastus2';
    const cfg = readLogicAppArmConfig();
    expect(logicAppArmMissing()).toEqual([]);
    expect(cfg.subscriptionId).toBe('sub-1');
    expect(cfg.resourceGroup).toBe('rg-loom');
    expect(cfg.location).toBe('eastus2');
  });
});

describe('resource-group fallback (the ghost-RG self-heal)', () => {
  it('falls back to LOOM_ADMIN_RG when no DLZ RG is configured at all', () => {
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_LOCATION = 'eastus2';
    process.env.LOOM_ADMIN_RG = 'rg-admin';
    expect(logicAppArmMissing()).toEqual([]);
    expect(readLogicAppArmConfig().resourceGroup).toBe('rg-admin');
  });

  it('offers the admin RG as the retry target when it differs from the primary', () => {
    process.env.LOOM_DLZ_RG = 'rg-ghost';
    process.env.LOOM_ADMIN_RG = 'rg-admin';
    expect(logicFallbackResourceGroup()).toBe('rg-admin');
    expect(readLogicAppArmConfig().fallbackResourceGroup).toBe('rg-admin');
  });

  it('offers NO retry target when the admin RG IS the primary (never retry the same RG)', () => {
    process.env.LOOM_DLZ_RG = 'rg-admin';
    process.env.LOOM_ADMIN_RG = 'rg-admin';
    expect(logicFallbackResourceGroup()).toBe('');
  });

  it('offers no retry target when LOOM_ADMIN_RG is unset', () => {
    process.env.LOOM_DLZ_RG = 'rg-ghost';
    expect(logicFallbackResourceGroup()).toBe('');
  });

  it('an explicit LOOM_LOGIC_RG still wins over both', () => {
    process.env.LOOM_LOGIC_RG = 'rg-logic';
    process.env.LOOM_DLZ_RG = 'rg-ghost';
    process.env.LOOM_ADMIN_RG = 'rg-admin';
    expect(readLogicAppArmConfig().resourceGroup).toBe('rg-logic');
    expect(logicFallbackResourceGroup()).toBe('rg-admin');
  });
});
