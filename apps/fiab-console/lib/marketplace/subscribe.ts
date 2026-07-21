/**
 * WS-10.4 Living Marketplace — SUBSCRIBE = real entitlement + real LCU billing.
 *
 * Subscribing to a unified product does two REAL things (no-vaporware / G1):
 *
 *  1. Entitlement via access-governance — writes an entitlement-ledger row
 *     (`recordAssignment`, source `'marketplace'`) so the grant shows up in the
 *     unified "who has access" report exactly like a data-product subscribe.
 *     `open` products grant immediately (self-serve); `request` products file
 *     the grant as `eligible` (owner still approves through the normal inbox).
 *
 *  2. Billing via LCU chargeback — meters the product's `lcuPerSubscription`
 *     to the subscriber's tenant through the SAME cost-attribution ledger the
 *     chargeback page rolls up (`recordCostAttribution`, engine `'marketplace'`),
 *     so a subscription's cost lands in the tenant's real chargeback share.
 *
 * Both underlying writes are best-effort (never throw), so a ledger/meter hiccup
 * cannot fail the subscribe; the result reports what actually happened.
 */
import { recordAssignment } from '@/lib/access/assignment-ledger';
import { recordCostAttribution } from '@/lib/azure/cost-attribution';
import type { CostAttributionRow } from '@/lib/azure/cost-attribution';
import type { MarketplaceProduct } from './product-types';

export interface Subscriber {
  oid: string;
  upn?: string;
  name?: string;
  /** Subscriber's tenant (Entra tid) — the chargeback + entitlement scope. */
  tenantId: string;
}

export interface SubscribeResult {
  ok: boolean;
  /** 'active' for open products, 'eligible' for request/governed products. */
  entitlementState: 'active' | 'eligible';
  /** True when the entitlement ledger row was written. */
  entitled: boolean;
  /** True when LCU was metered to the tenant chargeback. */
  metered: boolean;
  /** LCU actually recorded (0 if metering was skipped/failed). */
  lcu: number;
  /** Transparent USD estimate for the metered LCU. */
  estCostUsd: number;
}

/**
 * Execute a subscription: create the real entitlement grant + meter LCU.
 * PURE-of-HTTP — the BFF route calls this after loading the product and session.
 */
export async function subscribeToProduct(
  product: MarketplaceProduct,
  subscriber: Subscriber,
): Promise<SubscribeResult> {
  // 1) Entitlement — real access-governance ledger row. `open` → active grant;
  //    `request` → eligible (the owner still approves via the access inbox).
  const entitlementState: 'active' | 'eligible' = product.accessModel === 'request' ? 'eligible' : 'active';
  const entitled = await recordAssignment({
    principalId: subscriber.oid,
    principalUpn: subscriber.upn,
    principalType: 'User',
    tenantId: subscriber.tenantId,
    resourceType: product.grantResourceType,
    resourceRef: product.id,
    resourceName: product.displayName,
    role: product.grantRole,
    permission: 'read',
    source: 'marketplace',
    sourceRef: product.id,
    grantedBy: subscriber.oid,
    state: entitlementState,
  });

  // 2) Billing — meter LCU to the subscriber's tenant chargeback. Engine
  //    'marketplace' rate is 1 LCU/unit, so quantity = lcuPerSubscription.
  let row: CostAttributionRow | null = null;
  if (product.lcuPerSubscription > 0) {
    row = await recordCostAttribution({
      tenantId: subscriber.tenantId,
      userOid: subscriber.oid,
      userName: subscriber.name,
      engine: 'marketplace',
      quantity: product.lcuPerSubscription,
      itemId: product.id,
      itemType: `marketplace-${product.productKind}`,
      domainId: product.domain,
      resourceId: product.grantResourceType,
    });
  }

  return {
    ok: entitled,
    entitlementState,
    entitled,
    metered: !!row,
    lcu: row?.lcu ?? 0,
    estCostUsd: row?.estCostUsd ?? 0,
  };
}
