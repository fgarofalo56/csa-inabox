/**
 * BFF route test for POST /api/thread/promote-medallion — the Weave "Promote
 * (medallion)" edge. Mocks the session, item load/create, lakehouse abfss
 * resolver, and lineage write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn();
const createOwnedItemMock = vi.fn();
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
  createOwnedItem: (...a: any[]) => createOwnedItemMock(...a),
}));

const recordThreadEdgeMock = vi.fn(async () => {});
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: (...a: any[]) => recordThreadEdgeMock(...a) }));

const resolveLakehouseAbfssMock = vi.fn();
vi.mock('@/lib/azure/lakehouse-abfss', () => ({ resolveLakehouseAbfss: (...a: any[]) => resolveLakehouseAbfssMock(...a) }));

import { POST } from '../route';

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/thread/promote-medallion', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
const FROM = { id: 'lh-1', type: 'lakehouse', name: 'Sales LH' };
const VALUES = { table: 'orders|bronze/Tables/orders', targetLayer: 'silver', transform: 'clean-dedup', targetLakehouseId: 'lh-2' };

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  loadOwnedItemMock.mockImplementation(async (id: string) => {
    if (id === 'lh-1') return { id: 'lh-1', displayName: 'Sales LH', workspaceId: 'ws-1' };
    if (id === 'lh-2') return { id: 'lh-2', displayName: 'Silver LH', workspaceId: 'ws-1' };
    return null;
  });
  createOwnedItemMock.mockResolvedValue({ ok: true, item: { id: 'nb-9', displayName: 'Promote orders → silver' } });
  resolveLakehouseAbfssMock.mockImplementation(async (id: string) => ({
    abfss: `abfss://bronze@acct.dfs.core.windows.net/lakehouses/${id}`, container: 'bronze', root: `lakehouses/${id}`,
  }));
  [createOwnedItemMock, recordThreadEdgeMock, resolveLakehouseAbfssMock].forEach((m) => m.mockClear());
});

describe('promote-medallion route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(401);
  });

  it('400 on a bad target layer', async () => {
    const res = await POST(post({ from: FROM, values: { ...VALUES, targetLayer: 'platinum' } }));
    expect(res.status).toBe(400);
  });

  it('scaffolds a promotion notebook with real code + both lakehouses attached', async () => {
    const res = await POST(post({ from: FROM, values: VALUES }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.link).toBe('/items/notebook/nb-9');
    // Real PySpark generated (reads source Delta, writes target Delta).
    expect(j.code).toContain('spark.read.format("delta").load(SRC_PATH)');
    expect(j.code).toContain('.write.format("delta")');
    // Notebook created with both lakehouses attached.
    const nbCall = createOwnedItemMock.mock.calls.find((c) => c[1] === 'notebook');
    expect(nbCall).toBeTruthy();
    expect(nbCall![2].state.attachedSources).toHaveLength(2);
    // Promotion lineage recorded (source → target lakehouse).
    expect(recordThreadEdgeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'promote-medallion', toItemId: 'lh-2' }));
  });

  it('generates aggregate code for the aggregate transform', async () => {
    const res = await POST(post({ from: FROM, values: { ...VALUES, transform: 'aggregate' } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.code).toContain('groupBy(*dims)');
  });

  it('creates a new target lakehouse when targetLakehouseId is __new__', async () => {
    createOwnedItemMock.mockImplementation(async (_s: any, type: string) => {
      if (type === 'lakehouse') return { ok: true, item: { id: 'lh-new', displayName: 'Sales LH silver', workspaceId: 'ws-1' } };
      return { ok: true, item: { id: 'nb-9', displayName: 'Promote orders → silver' } };
    });
    const res = await POST(post({ from: FROM, values: { ...VALUES, targetLakehouseId: '__new__' } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(createOwnedItemMock.mock.calls.some((c) => c[1] === 'lakehouse')).toBe(true);
    expect(recordThreadEdgeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toItemId: 'lh-new' }));
  });

  it('503 honest gate when the source lakehouse has no storage', async () => {
    resolveLakehouseAbfssMock.mockResolvedValueOnce(null);
    const res = await POST(post({ from: FROM, values: VALUES }));
    expect(res.status).toBe(503);
  });
});
