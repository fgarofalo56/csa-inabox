import { describe, it, expect } from 'vitest';
import {
  buildProduct, slugify, productId, PRODUCT_KINDS, PRODUCT_KIND_META,
} from '@/lib/marketplace/product-types';

describe('WS-10.4 unified product schema', () => {
  it('has all five kinds with metadata', () => {
    expect(PRODUCT_KINDS).toEqual(['data', 'agent', 'mcp', 'app', 'ontology']);
    for (const k of PRODUCT_KINDS) {
      const m = PRODUCT_KIND_META[k];
      expect(m.grantResourceType).toMatch(/^marketplace-/);
      expect(m.defaultRole.length).toBeGreaterThan(0);
      expect(m.defaultLcuPerSubscription).toBeGreaterThan(0);
    }
  });

  it('slugify + productId are deterministic and safe', () => {
    expect(slugify('Customer 360 Agent!')).toBe('customer-360-agent');
    expect(productId('agent', 'Customer 360 Agent!')).toBe('mp-agent-customer-360-agent');
    expect(slugify('')).toBe('product');
  });

  it('buildProduct produces one shape for every kind, pre-cert draft', () => {
    for (const kind of PRODUCT_KINDS) {
      const p = buildProduct({ tenantId: 't1', productKind: kind, displayName: `My ${kind}` }, '2026-07-20T00:00:00Z');
      expect(p.docType).toBe('marketplace-product');
      expect(p.tenantId).toBe('t1');
      expect(p.productKind).toBe(kind);
      expect(p.certification).toBe('draft');       // never certified until a gate run
      expect(p.publishStatus).toBe('draft');
      expect(p.subscriberCount).toBe(0);
      expect(p.grantResourceType).toBe(PRODUCT_KIND_META[kind].grantResourceType);
      expect(p.lcuPerSubscription).toBe(PRODUCT_KIND_META[kind].defaultLcuPerSubscription);
      expect(p.accessModel).toBe('open');
    }
  });

  it('buildProduct honours explicit access model + LCU override', () => {
    const p = buildProduct({
      tenantId: 't1', productKind: 'data', displayName: 'Sales DP',
      accessModel: 'request', lcuPerSubscription: 12, grantRole: 'Custom Reader',
      owner: 'a@b.com', ownerOid: 'oid-1', domain: 'Sales', tags: ['gold'],
    });
    expect(p.accessModel).toBe('request');
    expect(p.lcuPerSubscription).toBe(12);
    expect(p.grantRole).toBe('Custom Reader');
    expect(p.ownerOid).toBe('oid-1');
    expect(p.domain).toBe('Sales');
    expect(p.tags).toEqual(['gold']);
  });
});
