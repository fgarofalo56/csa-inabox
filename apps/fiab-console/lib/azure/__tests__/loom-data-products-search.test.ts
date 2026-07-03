/**
 * Unit tests for the pure projection / filter helpers in
 * loom-data-products-search.ts. No network — these cover the logic the
 * marketplace acceptance criteria depend on:
 *
 *  - docForDataProduct: publishStatus defaults to Draft (so a new product is
 *    NOT consumer-visible), arrays normalize from CSV or array, domainName
 *    resolves from the override.
 *  - buildFacetFilter: single-value fields use eq; collection fields
 *    (glossaryTerms, CDEs) use the OData any() lambda; multi-value ORs within
 *    a field and ANDs across fields; quotes are escaped.
 */
import { describe, it, expect, vi } from 'vitest';

// The source module constructs an Azure credential at import time; mock the
// identity SDK so these pure-function tests load without the real package
// (and never touch the network).
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class { getToken() { return Promise.resolve({ token: 'x' }); } },
  ManagedIdentityCredential: class { getToken() { return Promise.resolve({ token: 'x' }); } },
  ChainedTokenCredential: class { getToken() { return Promise.resolve({ token: 'x' }); } },
}));

import { docForDataProduct, buildFacetFilter } from '../loom-data-products-search';
import type { WorkspaceItem } from '@/lib/types/workspace';

function item(overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    id: 'abc-123',
    workspaceId: 'ws-1',
    itemType: 'data-product',
    displayName: 'Sales 360',
    description: 'Curated sales view',
    createdBy: 'maker@contoso.com',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('docForDataProduct', () => {
  it('defaults publishStatus to Draft so a new product is not consumer-visible', () => {
    const doc = docForDataProduct(item({ state: {} }), 'tenant-1');
    expect(doc.publishStatus).toBe('Draft');
    // AI Search doc keys can't contain a colon, so the id uses the `dp_` prefix
    // (the legacy `dp:` form 400'd every upsert).
    expect(doc.id).toBe('dp_abc-123');
    expect(doc.tenantId).toBe('tenant-1');
    expect(doc.url).toBe('/items/data-product/abc-123');
  });

  it('carries Published status and normalizes CSV + array fields', () => {
    const doc = docForDataProduct(
      item({
        state: {
          publishStatus: 'Published',
          domain: 'finance',
          productType: 'Lakehouse',
          owner: 'owner@contoso.com',
          glossaryTerms: 'Revenue, Customer',
          CDEs: ['CustomerId', 'SSN'],
          sla: '99.9%',
        },
      }),
      'tenant-1',
      'Finance',
    );
    expect(doc.publishStatus).toBe('Published');
    expect(doc.domain).toBe('finance');
    expect(doc.domainName).toBe('Finance');
    expect(doc.glossaryTerms).toEqual(['Revenue', 'Customer']);
    expect(doc.CDEs).toEqual(['CustomerId', 'SSN']);
    expect(doc.owner).toBe('owner@contoso.com');
    expect(doc.touchedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('falls back owner to createdBy and domainName to the raw domain id', () => {
    const doc = docForDataProduct(item({ state: { domain: 'ops' } }), 'tenant-1');
    expect(doc.owner).toBe('maker@contoso.com');
    expect(doc.domainName).toBe('ops');
  });

  it('coerces an unknown publishStatus to Draft', () => {
    const doc = docForDataProduct(item({ state: { publishStatus: 'Bogus' } }), 'tenant-1');
    expect(doc.publishStatus).toBe('Draft');
  });
});

describe('buildFacetFilter', () => {
  it('returns empty string when nothing selected', () => {
    expect(buildFacetFilter({})).toBe('');
    expect(buildFacetFilter({ productType: [] })).toBe('');
  });

  it('uses eq for single-value scalar facets', () => {
    expect(buildFacetFilter({ productType: ['Lakehouse'] })).toBe("productType eq 'Lakehouse'");
  });

  it('ORs multiple values within one scalar field', () => {
    expect(buildFacetFilter({ domainName: ['Finance', 'Operations'] }))
      .toBe("(domainName eq 'Finance' or domainName eq 'Operations')");
  });

  it('uses the any() lambda for collection fields', () => {
    expect(buildFacetFilter({ glossaryTerms: ['Revenue'] }))
      .toBe("glossaryTerms/any(t: t eq 'Revenue')");
    expect(buildFacetFilter({ CDEs: ['SSN', 'CustomerId'] }))
      .toBe("(CDEs/any(t: t eq 'SSN') or CDEs/any(t: t eq 'CustomerId'))");
  });

  it('ANDs across different fields', () => {
    expect(buildFacetFilter({ productType: ['Lakehouse'], glossaryTerms: ['Revenue'] }))
      .toBe("productType eq 'Lakehouse' and glossaryTerms/any(t: t eq 'Revenue')");
  });

  it('escapes single quotes to prevent OData injection', () => {
    expect(buildFacetFilter({ owner: ["o'brien@contoso.com"] }))
      .toBe("owner eq 'o''brien@contoso.com'");
  });
});
