import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the real access-governance ledger + LCU cost-attribution writers so the
// test asserts subscribe wires BOTH (entitlement + billing) with correct args.
const recordAssignment = vi.fn(async () => true);
const recordCostAttribution = vi.fn(async (ctx: any) => ({ lcu: (ctx.quantity ?? 1) * 1, estCostUsd: (ctx.quantity ?? 1) * 0.1 }));

vi.mock('@/lib/access/assignment-ledger', () => ({ recordAssignment: (...a: any[]) => recordAssignment(...a) }));
vi.mock('@/lib/azure/cost-attribution', () => ({ recordCostAttribution: (...a: any[]) => recordCostAttribution(...a) }));

import { subscribeToProduct } from '@/lib/marketplace/subscribe';
import { buildProduct } from '@/lib/marketplace/product-types';

const subscriber = { oid: 'sub-oid', upn: 'sub@contoso.com', name: 'Sub User', tenantId: 'tid-9' };

beforeEach(() => { recordAssignment.mockClear(); recordCostAttribution.mockClear(); });

describe('WS-10.4 subscribe = real entitlement + real LCU billing', () => {
  it('open product → active grant + metered LCU to the subscriber tenant', async () => {
    const p = buildProduct({ tenantId: 't-owner', productKind: 'agent', displayName: 'C360 Agent', lcuPerSubscription: 5 });
    p.certification = 'certified';

    const res = await subscribeToProduct(p, subscriber);

    // Entitlement — real access-governance ledger row (source 'marketplace').
    expect(recordAssignment).toHaveBeenCalledTimes(1);
    const grant = recordAssignment.mock.calls[0][0] as any;
    expect(grant).toMatchObject({
      principalId: 'sub-oid',
      tenantId: 'tid-9',
      resourceType: 'marketplace-agent',
      resourceRef: p.id,
      source: 'marketplace',
      state: 'active',
      permission: 'read',
    });

    // Billing — real LCU meter (engine 'marketplace', quantity = lcuPerSubscription).
    expect(recordCostAttribution).toHaveBeenCalledTimes(1);
    const meter = recordCostAttribution.mock.calls[0][0] as any;
    expect(meter).toMatchObject({ tenantId: 'tid-9', userOid: 'sub-oid', engine: 'marketplace', quantity: 5, itemId: p.id });

    expect(res.ok).toBe(true);
    expect(res.entitlementState).toBe('active');
    expect(res.metered).toBe(true);
    expect(res.lcu).toBe(5);
  });

  it('request product → eligible grant (owner still approves)', async () => {
    const p = buildProduct({ tenantId: 't-owner', productKind: 'data', displayName: 'Sales DP', accessModel: 'request' });
    p.certification = 'certified';

    const res = await subscribeToProduct(p, subscriber);
    const grant = recordAssignment.mock.calls[0][0] as any;
    expect(grant.state).toBe('eligible');
    expect(res.entitlementState).toBe('eligible');
  });

  it('skips metering when lcuPerSubscription is 0', async () => {
    const p = buildProduct({ tenantId: 't-owner', productKind: 'app', displayName: 'Free App', lcuPerSubscription: 0 });
    p.certification = 'certified';

    const res = await subscribeToProduct(p, subscriber);
    expect(recordCostAttribution).not.toHaveBeenCalled();
    expect(res.metered).toBe(false);
    expect(res.lcu).toBe(0);
  });
});
