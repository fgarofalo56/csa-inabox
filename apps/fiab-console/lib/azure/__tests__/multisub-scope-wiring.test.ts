/**
 * Multi-sub scope wiring — proves the DLZ subscription is now included by the
 * Cost aggregator and the Network-topology scope (the two surfaces whose live
 * symptom was "DLZ spend missing" / "topology canvas empty" in multi-sub).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// cost-client / network-topology-graph construct an @azure/identity credential
// at module load; stub it so the dynamic import resolves in the test env (the
// same stub the monitor-client contract tests use). The functions under test
// (loomSubscriptions / topologySubscriptionScope) are pure env readers.
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { AcaManagedIdentityCredential: Cred, loomServerCredential: new Cred() };
});

const ADMIN_SUB = 'e093f4fd-5047-4ee4-968d-a56942c665f3';
const DLZ_SUB = '363ef5d1-0e77-4594-a530-f51af23dbf8c';

beforeEach(() => {
  for (const k of [
    'LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_SUBSCRIPTION_ID', 'LOOM_DLZ_SUB',
    'LOOM_EXTRA_SUBSCRIPTIONS', 'LOOM_COST_SUBSCRIPTIONS',
  ]) delete process.env[k];
});
afterEach(() => { /* env reset in beforeEach */ });

describe('cost-client.loomSubscriptions — DLZ sub included', () => {
  it('includes LOOM_DLZ_SUBSCRIPTION_ID so DLZ spend rolls into the Loom total', async () => {
    process.env.LOOM_SUBSCRIPTION_ID = ADMIN_SUB;
    process.env.LOOM_DLZ_SUBSCRIPTION_ID = DLZ_SUB;
    const { loomSubscriptions } = await import('../cost-client');
    const subs = loomSubscriptions();
    expect(subs).toContain(ADMIN_SUB);
    expect(subs).toContain(DLZ_SUB);
  });
});

describe('network-topology-graph.topologySubscriptionScope — DLZ sub included', () => {
  it('unions the admin + DLZ subscription so the topology canvas is not empty', async () => {
    process.env.LOOM_SUBSCRIPTION_ID = ADMIN_SUB;
    process.env.LOOM_DLZ_SUBSCRIPTION_ID = DLZ_SUB;
    const { topologySubscriptionScope } = await import('../network-topology-graph');
    const subs = topologySubscriptionScope();
    expect(subs).toEqual(expect.arrayContaining([ADMIN_SUB, DLZ_SUB]));
  });

  it('also folds in LOOM_EXTRA_SUBSCRIPTIONS, de-duplicated', async () => {
    process.env.LOOM_SUBSCRIPTION_ID = ADMIN_SUB;
    process.env.LOOM_DLZ_SUBSCRIPTION_ID = DLZ_SUB;
    process.env.LOOM_EXTRA_SUBSCRIPTIONS = `extra-1, ${ADMIN_SUB}`;
    const { topologySubscriptionScope } = await import('../network-topology-graph');
    const subs = topologySubscriptionScope();
    expect(subs).toContain('extra-1');
    expect(new Set(subs).size).toBe(subs.length);
  });
});
