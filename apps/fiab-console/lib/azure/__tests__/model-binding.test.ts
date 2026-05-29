/**
 * Contract tests for the ml-model resource-binding model — the fix for the
 * confirmed 404 (Loom GUID was sent as the AML registered-model name).
 *
 * Assert that:
 *   - resolveModelBinding() returns state.modelName, NOT the route id
 *   - it carries the optional workspaceName / version overrides from state
 *   - an unbound item throws UnboundModelError (→ 412)
 *   - a missing item throws ModelItemNotFoundError (→ 404)
 *   - a cross-tenant workspace throws ModelItemNotFoundError (→ 404)
 *   - persistModelBinding() writes modelName/workspaceName/version into state
 *     via Cosmos replace and preserves other state
 *   - modelBindingErrorResponse() maps the errors to the right HTTP status/body
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
    id: 'guid-aaaa-bbbb',
    workspaceId: 'ws-1',
    itemType: 'ml-model',
    displayName: 'My Model',
    state: { modelName: 'fraud-classifier' },
    createdBy: 'u', createdAt: 't', updatedAt: 't',
    ...over,
  };
}

beforeEach(() => {
  state.itemDoc = makeItem();
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
  state.replaced = null;
});

describe('resolveModelBinding', () => {
  it('returns the AML model name from item.state, NOT the route id', async () => {
    const { resolveModelBinding } = await import('../model-binding');
    const b = await resolveModelBinding('guid-aaaa-bbbb', 'ml-model', TENANT);
    expect(b.modelName).toBe('fraud-classifier');
    expect(b.modelName).not.toBe('guid-aaaa-bbbb');
  });

  it('carries optional workspaceName + version from state', async () => {
    state.itemDoc = makeItem({ state: { modelName: 'm1', workspaceName: 'aml-prod', version: '3' } });
    const { resolveModelBinding } = await import('../model-binding');
    const b = await resolveModelBinding('guid-aaaa-bbbb', 'ml-model', TENANT);
    expect(b.workspaceName).toBe('aml-prod');
    expect(b.version).toBe('3');
  });

  it('throws UnboundModelError when state.modelName is missing', async () => {
    state.itemDoc = makeItem({ state: {} });
    const { resolveModelBinding, UnboundModelError } = await import('../model-binding');
    await expect(resolveModelBinding('guid-aaaa-bbbb', 'ml-model', TENANT)).rejects.toBeInstanceOf(UnboundModelError);
  });

  it('throws ModelItemNotFoundError when the item is absent', async () => {
    state.itemDoc = null;
    const { resolveModelBinding, ModelItemNotFoundError } = await import('../model-binding');
    await expect(resolveModelBinding('nope', 'ml-model', TENANT)).rejects.toBeInstanceOf(ModelItemNotFoundError);
  });

  it('throws ModelItemNotFoundError when the workspace belongs to another tenant', async () => {
    state.workspaceDoc = { id: 'ws-1', tenantId: 'someone-else' };
    const { resolveModelBinding, ModelItemNotFoundError } = await import('../model-binding');
    await expect(resolveModelBinding('guid-aaaa-bbbb', 'ml-model', TENANT)).rejects.toBeInstanceOf(ModelItemNotFoundError);
  });
});

describe('persistModelBinding', () => {
  it('writes modelName/workspaceName/version into state and replaces the Cosmos doc', async () => {
    state.itemDoc = makeItem({ state: { existing: 'keep' } });
    const { persistModelBinding } = await import('../model-binding');
    const updated = await persistModelBinding('guid-aaaa-bbbb', 'ml-model', TENANT, {
      modelName: 'new-model', workspaceName: 'aml-prod', version: '2',
    });
    expect(updated.state?.modelName).toBe('new-model');
    expect(updated.state?.workspaceName).toBe('aml-prod');
    expect(updated.state?.version).toBe('2');
    expect(updated.state?.existing).toBe('keep'); // preserves other state
    expect(state.replaced.doc.state.modelName).toBe('new-model');
    expect(state.replaced.pk).toBe('ws-1'); // partition key = workspaceId
  });

  it('clears workspaceName/version when omitted (hub default)', async () => {
    state.itemDoc = makeItem({ state: { modelName: 'old', workspaceName: 'aml-prod', version: '9' } });
    const { persistModelBinding } = await import('../model-binding');
    const updated = await persistModelBinding('guid-aaaa-bbbb', 'ml-model', TENANT, { modelName: 'old' });
    expect(updated.state?.workspaceName).toBeUndefined();
    expect(updated.state?.version).toBeUndefined();
  });

  it('rejects an empty modelName', async () => {
    const { persistModelBinding } = await import('../model-binding');
    await expect(persistModelBinding('guid-aaaa-bbbb', 'ml-model', TENANT, { modelName: '  ' })).rejects.toThrow();
  });
});

describe('modelBindingErrorResponse', () => {
  it('maps UnboundModelError → 412 with code "unbound"', async () => {
    const { modelBindingErrorResponse, UnboundModelError } = await import('../model-binding');
    const r = modelBindingErrorResponse(new UnboundModelError('ml-model', 'guid'));
    expect(r.status).toBe(412);
    expect(r.body.code).toBe('unbound');
    expect(r.body.ok).toBe(false);
  });

  it('maps ModelItemNotFoundError → 404 with code "not_found"', async () => {
    const { modelBindingErrorResponse, ModelItemNotFoundError } = await import('../model-binding');
    const r = modelBindingErrorResponse(new ModelItemNotFoundError('ml-model', 'guid'));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
  });

  it('maps any other error → 502', async () => {
    const { modelBindingErrorResponse } = await import('../model-binding');
    const r = modelBindingErrorResponse(new Error('ARM 500'));
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('ARM 500');
  });
});
