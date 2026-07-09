/**
 * BFF route test for /api/items/adf-pipeline/[id]/bind — the real 'Bind failed'
 * 404 fix.
 *
 * An interactively-created ADF pipeline tile is PERSISTED with
 * itemType:'data-pipeline' (catalog aliasOf). The ADF bind route filters Cosmos
 * by itemType; before the fix it asked for 'adf-pipeline' only → zero rows →
 * 404 ItemNotFoundError → the editor's bind dropdown showed "No pipelines
 * found" and every action failed. This test proves the GET bind route now
 * resolves a data-pipeline-typed doc (and still 404s a foreign type).
 *
 * Cosmos + auth + adf-client are mocked so the test runs offline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const TENANT = 'oid-1';

const state = {
  itemDoc: null as any,
  workspaceDoc: null as any,
};

const getSessionMock = vi.fn(() => ({ claims: { oid: TENANT } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@/lib/azure/adf-client', () => ({
  listPipelines: vi.fn(async () => [{ name: 'ingest_orders' }, { name: 'ship_events' }]),
  upsertPipeline: vi.fn(async () => ({ name: 'created' })),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
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
    item: () => ({ replace: async (doc: any) => ({ resource: doc }) }),
  }),
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: state.workspaceDoc }) }),
  }),
}));

import { GET } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'guid-1' }) };
function get(): NextRequest {
  return new NextRequest('http://localhost/api/items/adf-pipeline/guid-1/bind');
}

function makeItem(over: Partial<any> = {}) {
  return {
    id: 'guid-1',
    workspaceId: 'ws-1',
    itemType: 'data-pipeline',
    displayName: 'My Pipeline',
    state: { pipelineName: 'ingest_orders' },
    createdBy: 'u', createdAt: 't', updatedAt: 't',
    ...over,
  };
}

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: TENANT } } as any);
  state.itemDoc = makeItem();
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
});

describe('adf-pipeline bind route — accepts data-pipeline-typed items', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await GET(get(), PARAMS);
    expect(res.status).toBe(401);
  });

  it('resolves a data-pipeline-typed item (the alias fix) — ok:true, returns its binding + picker', async () => {
    const res = await GET(get(), PARAMS);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.bound).toBe('ingest_orders');
    expect(j.pipelines.map((p: any) => p.name)).toContain('ingest_orders');
  });

  it('still resolves a natively adf-pipeline-typed (bundle-installed) item', async () => {
    state.itemDoc = makeItem({ itemType: 'adf-pipeline' });
    const res = await GET(get(), PARAMS);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.bound).toBe('ingest_orders');
  });

  it('404s a foreign itemType (still scoped)', async () => {
    state.itemDoc = makeItem({ itemType: 'lakehouse' });
    const res = await GET(get(), PARAMS);
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('not_found');
  });
});
