/**
 * Unit tests for the multi-sub resolver (lib/azure/loom-subscriptions).
 *
 * Locks the canonical per-(subscription, resource-group) pairing — the admin RG
 * with LOOM_SUBSCRIPTION_ID, the DLZ RG with LOOM_DLZ_SUBSCRIPTION_ID (falling
 * back to the admin sub for single-sub deploys) — and the full subscription
 * scope union. Mirrors the pairing first landed in
 * app/api/admin/azure-resources/route.ts (PR #1462).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  adminSubscriptionId,
  dlzSubscriptionId,
  loomSubscriptionScope,
  loomResourceGroupScopes,
} from '../loom-subscriptions';

const ADMIN_SUB = 'e093f4fd-5047-4ee4-968d-a56942c665f3';
const DLZ_SUB = '363ef5d1-0e77-4594-a530-f51af23dbf8c';

function clearEnv() {
  for (const k of [
    'LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_SUBSCRIPTION_ID', 'LOOM_DLZ_SUB',
    'LOOM_EXTRA_SUBSCRIPTIONS', 'LOOM_COST_SUBSCRIPTIONS',
    'LOOM_ASA_SUB', 'LOOM_EVENTHUB_SUB', 'LOOM_AI_SEARCH_SUB', 'LOOM_FOUNDRY_SUB', 'LOOM_KUSTO_SUB',
    'LOOM_ADMIN_RG', 'LOOM_ACA_RG', 'LOOM_DLZ_RG', 'LOOM_AI_SEARCH_RG',
    'LOOM_KUSTO_RG', 'LOOM_APIM_RG', 'LOOM_FOUNDRY_RG', 'LOOM_AOAI_RG',
  ]) delete process.env[k];
}

beforeEach(clearEnv);

describe('dlzSubscriptionId / adminSubscriptionId', () => {
  it('reads the canonical LOOM_DLZ_SUBSCRIPTION_ID', () => {
    process.env.LOOM_DLZ_SUBSCRIPTION_ID = DLZ_SUB;
    expect(dlzSubscriptionId()).toBe(DLZ_SUB);
  });
  it('falls back to the legacy LOOM_DLZ_SUB alias', () => {
    process.env.LOOM_DLZ_SUB = DLZ_SUB;
    expect(dlzSubscriptionId()).toBe(DLZ_SUB);
  });
  it('is null when neither is set (single-sub)', () => {
    expect(dlzSubscriptionId()).toBeNull();
  });
  it('reads the admin sub from LOOM_SUBSCRIPTION_ID', () => {
    process.env.LOOM_SUBSCRIPTION_ID = ADMIN_SUB;
    expect(adminSubscriptionId()).toBe(ADMIN_SUB);
  });
});

describe('loomResourceGroupScopes — per-(sub,rg) pairing', () => {
  it('pairs the DLZ RG with the DLZ sub and admin RGs with the admin sub (multi-sub)', () => {
    process.env.LOOM_SUBSCRIPTION_ID = ADMIN_SUB;
    process.env.LOOM_DLZ_SUBSCRIPTION_ID = DLZ_SUB;
    process.env.LOOM_ADMIN_RG = 'rg-csa-loom-admin-centralus';
    process.env.LOOM_DLZ_RG = 'rg-csa-loom-dlz-default-centralus';

    const scopes = loomResourceGroupScopes(ADMIN_SUB);
    const dlz = scopes.find((s) => s.rg === 'rg-csa-loom-dlz-default-centralus');
    const admin = scopes.find((s) => s.rg === 'rg-csa-loom-admin-centralus');
    // The DLZ RG must be queried under the DLZ sub — this is the fix for the
    // live "Resource group '…dlz…' could not be found" 404.
    expect(dlz?.sub).toBe(DLZ_SUB);
    expect(admin?.sub).toBe(ADMIN_SUB);
  });

  it('pairs the DLZ RG with the admin sub when no DLZ sub is set (single-sub)', () => {
    process.env.LOOM_SUBSCRIPTION_ID = ADMIN_SUB;
    process.env.LOOM_ADMIN_RG = 'rg-admin';
    process.env.LOOM_DLZ_RG = 'rg-dlz';
    const scopes = loomResourceGroupScopes(ADMIN_SUB);
    for (const s of scopes) expect(s.sub).toBe(ADMIN_SUB);
  });

  it('de-duplicates identical (sub, rg) pairs', () => {
    process.env.LOOM_SUBSCRIPTION_ID = ADMIN_SUB;
    process.env.LOOM_ADMIN_RG = 'rg-shared';
    process.env.LOOM_ACA_RG = 'rg-shared';
    const scopes = loomResourceGroupScopes(ADMIN_SUB);
    expect(scopes.filter((s) => s.rg === 'rg-shared')).toHaveLength(1);
  });
});

describe('loomSubscriptionScope — full union', () => {
  it('unions the admin + DLZ + extra subscriptions, admin first, de-duplicated', () => {
    process.env.LOOM_SUBSCRIPTION_ID = ADMIN_SUB;
    process.env.LOOM_DLZ_SUBSCRIPTION_ID = DLZ_SUB;
    process.env.LOOM_EXTRA_SUBSCRIPTIONS = `extra-1, ${ADMIN_SUB}`; // dup admin filtered
    const subs = loomSubscriptionScope();
    expect(subs[0]).toBe(ADMIN_SUB);
    expect(subs).toContain(DLZ_SUB);
    expect(subs).toContain('extra-1');
    expect(new Set(subs).size).toBe(subs.length); // de-duplicated
  });

  it('is just the admin sub for a single-sub deploy', () => {
    process.env.LOOM_SUBSCRIPTION_ID = ADMIN_SUB;
    expect(loomSubscriptionScope()).toEqual([ADMIN_SUB]);
  });
});
