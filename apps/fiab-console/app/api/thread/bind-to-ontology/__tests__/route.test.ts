/**
 * BFF route test for POST /api/thread/bind-to-ontology (WS-6 / BTB-1).
 * Mocks the session, item loads/writes, and the Thread-edge recorder.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn();
const updateOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
  updateOwnedItem: (...a: any[]) => updateOwnedItemMock(...a),
}));

const recordThreadEdgeMock = vi.fn(async () => {});
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: (...a: any[]) => recordThreadEdgeMock(...a) }));

import { POST } from '../route';

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/thread/bind-to-ontology', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

const LAKEHOUSE = { id: 'lh-1', itemType: 'lakehouse', workspaceId: 'ws-1', displayName: 'Sales Lake', state: {} };
const ONTOLOGY = {
  id: 'onto-1', itemType: 'ontology', workspaceId: 'ws-1', displayName: 'Sales Ontology',
  state: { objectTypes: [{ apiName: 'Customer', properties: [{ apiName: 'customerId', baseType: 'string' }] }] },
};

beforeEach(() => {
  vi.resetAllMocks();
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
});

describe('POST /api/thread/bind-to-ontology', () => {
  it('401s without a session', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ from: { id: 'lh-1', type: 'lakehouse' }, values: { ontologyId: 'onto-1', objectType: 'Customer', sourceRef: 'dbo.Customer' } }));
    expect(res.status).toBe(401);
  });

  it('400s for a source type that cannot be bound', async () => {
    const res = await POST(post({ from: { id: 'x', type: 'report' }, values: { ontologyId: 'o', objectType: 'C', sourceRef: 't' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unbindable_type');
  });

  it('409s when the object type is not declared on the ontology', async () => {
    loadOwnedItemMock.mockImplementation(async (id: string, type: string) => (type === 'ontology' ? ONTOLOGY : LAKEHOUSE));
    const res = await POST(post({ from: { id: 'lh-1', type: 'lakehouse' }, values: { ontologyId: 'onto-1', objectType: 'Ghost', sourceRef: 'dbo.X' } }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('undeclared_type');
  });

  it('persists the binding on the source item state and records a Thread edge', async () => {
    loadOwnedItemMock.mockImplementation(async (id: string, type: string) => (type === 'ontology' ? ONTOLOGY : LAKEHOUSE));
    updateOwnedItemMock.mockResolvedValue({ ...LAKEHOUSE, updatedAt: 'now' });

    const res = await POST(post({
      from: { id: 'lh-1', type: 'lakehouse', name: 'Sales Lake' },
      values: { ontologyId: 'onto-1', objectType: 'Customer', sourceRef: 'dbo.Customer', keyColumn: 'CustomerId' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.objectType).toBe('Customer');
    expect(body.sourceKind).toBe('lakehouse-table');

    // The persisted binding is canonical (normalized) and lives on state.ontologyBinding.
    const [, , , patch] = updateOwnedItemMock.mock.calls[0];
    expect(patch.state.ontologyBinding).toMatchObject({
      ontologyId: 'onto-1', objectType: 'Customer', keyColumn: 'CustomerId',
      source: { kind: 'lakehouse-table', ref: 'dbo.Customer', sourceItemId: 'lh-1', lakehouseId: 'lh-1' },
    });
    expect(recordThreadEdgeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      fromItemId: 'lh-1', fromType: 'lakehouse', toItemId: 'onto-1', toType: 'ontology', action: 'bind-to-ontology',
    }));
  });

  it('maps a semantic-model source to the semantic-measure kind', async () => {
    const model = { id: 'sm-1', itemType: 'semantic-model', workspaceId: 'ws-1', displayName: 'Model', state: {} };
    loadOwnedItemMock.mockImplementation(async (id: string, type: string) => (type === 'ontology' ? ONTOLOGY : model));
    updateOwnedItemMock.mockResolvedValue({ ...model, updatedAt: 'now' });
    const res = await POST(post({ from: { id: 'sm-1', type: 'semantic-model' }, values: { ontologyId: 'onto-1', objectType: 'Customer', sourceRef: 'CustomerTable' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).sourceKind).toBe('semantic-measure');
  });
});
