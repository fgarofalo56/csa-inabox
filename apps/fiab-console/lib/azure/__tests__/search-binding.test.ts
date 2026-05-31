/**
 * Contract tests for the AI Search index resource-binding model — the fix for
 * the "Error: not found" 404 (the Loom item GUID was being sent as the Azure
 * AI Search index NAME, same class of bug as pipeline #476).
 *
 * These assert that:
 *   - resolveSearchBinding() returns state.indexName, NOT the route id
 *   - an unbound item throws UnboundSearchIndexError (→ 412, code 'unbound')
 *   - a missing item throws SearchItemNotFoundError (→ 404, code 'not_found')
 *   - persistSearchBinding() writes indexName into item.state via Cosmos replace
 *   - searchBindingErrorResponse() maps errors to the right HTTP status + body
 *
 * Cosmos is mocked so the test runs offline (no Azure).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = {
  itemDoc: null as any,
  workspaceDoc: null as any,
  replaced: null as any,
};

vi.mock('@/lib/azure/cosmos-client', () => {
  return {
    itemsContainer: async () => ({
      items: {
        query: () => ({
          fetchAll: async () => ({ resources: state.itemDoc ? [state.itemDoc] : [] }),
        }),
      },
      item: (id: string, pk: string) => ({
        replace: async (doc: any) => {
          state.replaced = { id, pk, doc };
          return { resource: doc };
        },
      }),
    }),
    workspacesContainer: async () => ({
      item: (_wsId: string, _tenant: string) => ({
        read: async () => ({ resource: state.workspaceDoc }),
      }),
    }),
  };
});

const TENANT = 'tenant-oid-1';

function makeItem(over: Partial<any> = {}) {
  return {
    id: 'guid-search-1',
    workspaceId: 'ws-1',
    itemType: 'ai-search-index',
    displayName: 'My Index',
    state: { indexName: 'hotels-sample' },
    createdBy: 'u', createdAt: 't', updatedAt: 't',
    ...over,
  };
}

beforeEach(() => {
  state.itemDoc = makeItem();
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
  state.replaced = null;
});

describe('resolveSearchBinding', () => {
  it('returns the Azure index name from item.state, NOT the route id', async () => {
    const { resolveSearchBinding } = await import('../search-binding');
    const b = await resolveSearchBinding('guid-search-1', 'ai-search-index', TENANT);
    expect(b.indexName).toBe('hotels-sample');
    expect(b.indexName).not.toBe('guid-search-1');
  });

  it('throws UnboundSearchIndexError when state.indexName is missing', async () => {
    state.itemDoc = makeItem({ state: {} });
    const { resolveSearchBinding, UnboundSearchIndexError } = await import('../search-binding');
    await expect(resolveSearchBinding('guid-search-1', 'ai-search-index', TENANT)).rejects.toBeInstanceOf(UnboundSearchIndexError);
  });

  it('throws SearchItemNotFoundError when the item is absent', async () => {
    state.itemDoc = null;
    const { resolveSearchBinding, SearchItemNotFoundError } = await import('../search-binding');
    await expect(resolveSearchBinding('nope', 'ai-search-index', TENANT)).rejects.toBeInstanceOf(SearchItemNotFoundError);
  });

  it('throws SearchItemNotFoundError when the workspace belongs to another tenant', async () => {
    state.workspaceDoc = { id: 'ws-1', tenantId: 'someone-else' };
    const { resolveSearchBinding, SearchItemNotFoundError } = await import('../search-binding');
    await expect(resolveSearchBinding('guid-search-1', 'ai-search-index', TENANT)).rejects.toBeInstanceOf(SearchItemNotFoundError);
  });

  it('carries the optional service override from state', async () => {
    state.itemDoc = makeItem({ state: { indexName: 'idx', service: 'svc-east' } });
    const { resolveSearchBinding } = await import('../search-binding');
    const b = await resolveSearchBinding('guid-search-1', 'ai-search-index', TENANT);
    expect(b.service).toBe('svc-east');
  });
});

describe('persistSearchBinding', () => {
  it('writes indexName into item.state and replaces the Cosmos doc (preserving other state)', async () => {
    state.itemDoc = makeItem({ state: { existing: 'keep' } });
    const { persistSearchBinding } = await import('../search-binding');
    const updated = await persistSearchBinding('guid-search-1', 'ai-search-index', TENANT, { indexName: 'new-idx' });
    expect(updated.state?.indexName).toBe('new-idx');
    expect(updated.state?.existing).toBe('keep');
    expect(state.replaced.doc.state.indexName).toBe('new-idx');
    expect(state.replaced.pk).toBe('ws-1'); // partition key = workspaceId
  });

  it('rejects an empty indexName', async () => {
    const { persistSearchBinding } = await import('../search-binding');
    await expect(persistSearchBinding('guid-search-1', 'ai-search-index', TENANT, { indexName: '  ' })).rejects.toThrow();
  });
});

describe('searchBindingErrorResponse', () => {
  it('maps UnboundSearchIndexError → 412 with code "unbound"', async () => {
    const { searchBindingErrorResponse, UnboundSearchIndexError } = await import('../search-binding');
    const r = searchBindingErrorResponse(new UnboundSearchIndexError('ai-search-index', 'guid'));
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('unbound');
    expect(r.body.ok).toBe(false);
  });

  it('maps SearchItemNotFoundError → 404 with code "not_found"', async () => {
    const { searchBindingErrorResponse, SearchItemNotFoundError } = await import('../search-binding');
    const r = searchBindingErrorResponse(new SearchItemNotFoundError('ai-search-index', 'guid'));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
  });

  it('maps any other error → 502', async () => {
    const { searchBindingErrorResponse } = await import('../search-binding');
    const r = searchBindingErrorResponse(new Error('data-plane 500'));
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('data-plane 500');
  });
});
