/**
 * Contract tests for the pipeline resource-binding model — the fix for the
 * 404 PipelineNotFound bug (Loom GUID was sent as the Azure pipeline name).
 *
 * These assert that:
 *   - resolveBinding() returns state.pipelineName, NOT the route id
 *   - an unbound item throws UnboundPipelineError (→ 412)
 *   - a missing item throws ItemNotFoundError (→ 404)
 *   - persistBinding() writes pipelineName into item.state via Cosmos replace
 *   - bindingErrorResponse() maps the errors to the right HTTP status + body
 *
 * The Cosmos container is mocked so the test runs offline (no Azure).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Cosmos mock ----------------------------------------------------------
const state = {
  itemDoc: null as any,
  workspaceDoc: null as any,
  replaced: null as any,
};

vi.mock('@/lib/azure/cosmos-client', () => {
  return {
    itemsContainer: async () => ({
      items: {
        // Honor the real query's parameterized filter: match c.id = @id AND
        // c.itemType IN (@t0, @t1, ...). This lets tests prove the alias fix —
        // a 'data-pipeline'-typed doc resolves when the route asks for
        // ['adf-pipeline','data-pipeline'], and a foreign type does NOT.
        query: (spec: any) => ({
          fetchAll: async () => {
            const doc = state.itemDoc;
            if (!doc) return { resources: [] };
            const params: Array<{ name: string; value: any }> = spec?.parameters || [];
            const idParam = params.find((p) => p.name === '@id');
            const typeValues = params.filter((p) => p.name.startsWith('@t')).map((p) => p.value);
            const idOk = idParam ? doc.id === idParam.value : true;
            const typeOk = typeValues.length ? typeValues.includes(doc.itemType) : true;
            return { resources: idOk && typeOk ? [doc] : [] };
          },
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
    id: 'guid-aaaa-bbbb',
    workspaceId: 'ws-1',
    itemType: 'adf-pipeline',
    displayName: 'My Pipeline',
    state: { pipelineName: 'ingest_orders' },
    createdBy: 'u', createdAt: 't', updatedAt: 't',
    ...over,
  };
}

beforeEach(() => {
  state.itemDoc = makeItem();
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
  state.replaced = null;
});

describe('resolveBinding', () => {
  it('returns the Azure pipeline name from item.state, NOT the route id', async () => {
    const { resolveBinding } = await import('../pipeline-binding');
    const b = await resolveBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT);
    expect(b.pipelineName).toBe('ingest_orders');
    expect(b.pipelineName).not.toBe('guid-aaaa-bbbb');
  });

  it('throws UnboundPipelineError when state.pipelineName is missing', async () => {
    state.itemDoc = makeItem({ state: {} });
    const { resolveBinding, UnboundPipelineError } = await import('../pipeline-binding');
    await expect(resolveBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT)).rejects.toBeInstanceOf(UnboundPipelineError);
  });

  it('throws ItemNotFoundError when the item is absent', async () => {
    state.itemDoc = null;
    const { resolveBinding, ItemNotFoundError } = await import('../pipeline-binding');
    await expect(resolveBinding('nope', 'adf-pipeline', TENANT)).rejects.toBeInstanceOf(ItemNotFoundError);
  });

  it('throws ItemNotFoundError when the workspace belongs to another tenant', async () => {
    state.workspaceDoc = { id: 'ws-1', tenantId: 'someone-else' };
    const { resolveBinding, ItemNotFoundError } = await import('../pipeline-binding');
    await expect(resolveBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT)).rejects.toBeInstanceOf(ItemNotFoundError);
  });

  it('carries optional factory/workspace overrides from state', async () => {
    state.itemDoc = makeItem({ state: { pipelineName: 'p1', factory: 'adf-other', workspace: 'syn-other' } });
    const { resolveBinding } = await import('../pipeline-binding');
    const b = await resolveBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT);
    expect(b.factory).toBe('adf-other');
    expect(b.workspace).toBe('syn-other');
  });
});

describe('itemType aliasing — adf/synapse routes accept data-pipeline-typed items', () => {
  // The real 'Bind failed' 404: interactively-created pipeline tiles persist as
  // itemType:'data-pipeline' (catalog aliasOf), but the ADF/Synapse routes used
  // to filter on their own type only → zero rows → ItemNotFoundError. The routes
  // now pass ['adf-pipeline','data-pipeline'] (or synapse variant) and BOTH must
  // resolve. Bundle-installed items may genuinely carry the native type.
  it('resolves a data-pipeline-typed item when the route asks for adf-pipeline+data-pipeline', async () => {
    state.itemDoc = makeItem({ itemType: 'data-pipeline' });
    const { loadPipelineItem, resolveBinding } = await import('../pipeline-binding');
    const loaded = await loadPipelineItem('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT);
    expect(loaded?.itemType).toBe('data-pipeline');
    const b = await resolveBinding('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT);
    expect(b.pipelineName).toBe('ingest_orders');
  });

  it('still resolves a natively adf-pipeline-typed (bundle-installed) item', async () => {
    state.itemDoc = makeItem({ itemType: 'adf-pipeline' });
    const { loadPipelineItem } = await import('../pipeline-binding');
    const loaded = await loadPipelineItem('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT);
    expect(loaded?.itemType).toBe('adf-pipeline');
  });

  it('resolves a data-pipeline-typed item for the synapse-pipeline route list too', async () => {
    state.itemDoc = makeItem({ itemType: 'data-pipeline' });
    const { loadPipelineItem } = await import('../pipeline-binding');
    const loaded = await loadPipelineItem('guid-aaaa-bbbb', ['synapse-pipeline', 'data-pipeline'], TENANT);
    expect(loaded?.itemType).toBe('data-pipeline');
  });

  it('does NOT resolve a foreign itemType (still tenant/type scoped)', async () => {
    state.itemDoc = makeItem({ itemType: 'lakehouse' });
    const { loadPipelineItem } = await import('../pipeline-binding');
    const loaded = await loadPipelineItem('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT);
    expect(loaded).toBeNull();
  });

  it('still rejects a data-pipeline-typed item from a foreign tenant', async () => {
    state.itemDoc = makeItem({ itemType: 'data-pipeline' });
    state.workspaceDoc = { id: 'ws-1', tenantId: 'someone-else' };
    const { resolveBinding, ItemNotFoundError } = await import('../pipeline-binding');
    await expect(
      resolveBinding('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT),
    ).rejects.toBeInstanceOf(ItemNotFoundError);
  });

  it('UnboundPipelineError reports the item ACTUAL type (data-pipeline) when found unbound', async () => {
    state.itemDoc = makeItem({ itemType: 'data-pipeline', state: {} });
    const { resolveBinding, UnboundPipelineError } = await import('../pipeline-binding');
    await expect(
      resolveBinding('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT),
    ).rejects.toMatchObject({ itemType: 'data-pipeline' });
    // sanity: it is the right error class
    await expect(
      resolveBinding('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT),
    ).rejects.toBeInstanceOf(UnboundPipelineError);
  });

  it('ItemNotFoundError keeps the primary requested type (adf-pipeline) when absent', async () => {
    state.itemDoc = null;
    const { resolveBinding } = await import('../pipeline-binding');
    await expect(
      resolveBinding('nope', ['adf-pipeline', 'data-pipeline'], TENANT),
    ).rejects.toMatchObject({ itemType: 'adf-pipeline' });
  });

  it('persistBinding preserves the stored itemType (does not rewrite it to adf-pipeline)', async () => {
    state.itemDoc = makeItem({ itemType: 'data-pipeline', state: { existing: 'keep' } });
    const { persistBinding } = await import('../pipeline-binding');
    const updated = await persistBinding('guid-aaaa-bbbb', ['adf-pipeline', 'data-pipeline'], TENANT, { pipelineName: 'p2' });
    expect(updated.itemType).toBe('data-pipeline');
    expect(state.replaced.doc.itemType).toBe('data-pipeline');
    expect(updated.state?.pipelineName).toBe('p2');
  });
});

describe('persistBinding', () => {
  it('writes pipelineName into item.state and replaces the Cosmos doc', async () => {
    state.itemDoc = makeItem({ state: { existing: 'keep' } });
    const { persistBinding } = await import('../pipeline-binding');
    const updated = await persistBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT, { pipelineName: 'new_pipe' });
    expect(updated.state?.pipelineName).toBe('new_pipe');
    expect(updated.state?.existing).toBe('keep'); // preserves other state
    expect(state.replaced.doc.state.pipelineName).toBe('new_pipe');
    expect(state.replaced.pk).toBe('ws-1'); // partition key = workspaceId
  });

  it('rejects an empty pipelineName', async () => {
    const { persistBinding } = await import('../pipeline-binding');
    await expect(persistBinding('guid-aaaa-bbbb', 'adf-pipeline', TENANT, { pipelineName: '  ' })).rejects.toThrow();
  });
});

describe('bindingErrorResponse', () => {
  it('maps UnboundPipelineError → 412 with code "unbound"', async () => {
    const { bindingErrorResponse, UnboundPipelineError } = await import('../pipeline-binding');
    const r = bindingErrorResponse(new UnboundPipelineError('adf-pipeline', 'guid'));
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('unbound');
    expect(r.body.ok).toBe(false);
  });

  it('maps ItemNotFoundError → 404 with code "not_found"', async () => {
    const { bindingErrorResponse, ItemNotFoundError } = await import('../pipeline-binding');
    const r = bindingErrorResponse(new ItemNotFoundError('adf-pipeline', 'guid'));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
  });

  it('maps any other error → 502', async () => {
    const { bindingErrorResponse } = await import('../pipeline-binding');
    const r = bindingErrorResponse(new Error('ARM 500'));
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('ARM 500');
  });
});
