/**
 * Contract tests for /api/items/warehouse/[id]/settings — the GPU-accelerated
 * query-acceleration honest-gate (Fabric Build 2026 #7). Per no-vaporware.md +
 * no-fabric-dependency.md these pin the load-bearing behavior:
 *   - resolveWarehouseBackend(): Azure-native Synapse is the DEFAULT; Fabric is
 *     opt-in and needs BOTH LOOM_WAREHOUSE_BACKEND=fabric AND a bound workspace.
 *   - warehouseCapabilityMatrix(): Synapse → acceleration UNAVAILABLE + honest
 *     gate text naming the exact env vars; Fabric → available.
 *   - GET 401 unauthenticated; GET 'new' returns defaults + matrix.
 *   - GET never reports acceleration "effective" against a no-GPU backend.
 *   - PUT persists the requested setting and reports honest effective state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'tenant-1', upn: 'a@b.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItem = vi.fn(async (..._a: any[]) => null as any);
const updateOwnedItem = vi.fn(async (..._a: any[]) => null as any);
vi.mock('../../../../_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItem(...a),
  updateOwnedItem: (...a: any[]) => updateOwnedItem(...a),
  jerr: (error: string, status = 500) =>
    new Response(JSON.stringify({ ok: false, error }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
}));

import {
  GET,
  PUT,
  resolveWarehouseBackend,
  warehouseCapabilityMatrix,
} from '../route';

const ENV = { ...process.env };
beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'tenant-1', upn: 'a@b.com' }, exp: Date.now() / 1000 + 3600 } as any);
  loadOwnedItem.mockReset();
  updateOwnedItem.mockReset();
  delete process.env.LOOM_WAREHOUSE_BACKEND;
  delete process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
});
afterEach(() => {
  process.env = { ...ENV };
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('resolveWarehouseBackend', () => {
  it('defaults to synapse with no env (Fabric workspace UNSET)', () => {
    expect(resolveWarehouseBackend()).toBe('synapse');
  });
  it('stays synapse when backend=fabric but NO bound workspace', () => {
    process.env.LOOM_WAREHOUSE_BACKEND = 'fabric';
    expect(resolveWarehouseBackend()).toBe('synapse');
  });
  it('stays synapse when workspace bound but backend not fabric', () => {
    process.env.LOOM_DEFAULT_FABRIC_WORKSPACE = 'ws-1';
    process.env.LOOM_WAREHOUSE_BACKEND = 'synapse-dedicated';
    expect(resolveWarehouseBackend()).toBe('synapse');
  });
  it('resolves fabric only with BOTH backend=fabric AND bound workspace', () => {
    process.env.LOOM_WAREHOUSE_BACKEND = 'fabric';
    process.env.LOOM_DEFAULT_FABRIC_WORKSPACE = 'ws-1';
    expect(resolveWarehouseBackend()).toBe('fabric');
  });
});

describe('warehouseCapabilityMatrix', () => {
  it('synapse default → acceleration unavailable + honest gate naming env vars', () => {
    const m = warehouseCapabilityMatrix();
    expect(m.backend).toBe('synapse');
    expect(m.queryAccelerationAvailable).toBe(false);
    expect(m.queryAccelerationGate).toMatch(/LOOM_WAREHOUSE_BACKEND=fabric/);
    expect(m.queryAccelerationGate).toMatch(/LOOM_DEFAULT_FABRIC_WORKSPACE/);
  });
  it('fabric opt-in → acceleration available, no gate', () => {
    process.env.LOOM_WAREHOUSE_BACKEND = 'fabric';
    process.env.LOOM_DEFAULT_FABRIC_WORKSPACE = 'ws-1';
    const m = warehouseCapabilityMatrix();
    expect(m.backend).toBe('fabric');
    expect(m.queryAccelerationAvailable).toBe(true);
    expect(m.queryAccelerationGate).toBeUndefined();
  });
});

describe('GET /settings', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const r = await GET(new NextRequest('http://x/api/items/warehouse/w1/settings'), ctx('w1'));
    expect(r.status).toBe(401);
  });

  it("'new' returns defaults + the capability matrix without touching cosmos", async () => {
    const r = await GET(new NextRequest('http://x/api/items/warehouse/new/settings'), ctx('new'));
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.settings.queryAcceleration).toBe(false);
    expect(j.capabilities.backend).toBe('synapse');
    expect(loadOwnedItem).not.toHaveBeenCalled();
  });

  it('never reports acceleration effective on the no-GPU Synapse backend', async () => {
    // Persisted intent is ON, but the Synapse backend can't honor it.
    loadOwnedItem.mockResolvedValueOnce({
      id: 'w1', workspaceId: 'ws', itemType: 'warehouse', displayName: 'W',
      state: { settings: { queryAcceleration: true } },
    } as any);
    const r = await GET(new NextRequest('http://x/api/items/warehouse/w1/settings'), ctx('w1'));
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.settings.queryAcceleration).toBe(true); // intent preserved
    expect(j.effective.queryAcceleration).toBe(false); // honestly off — no GPU
    expect(j.capabilities.queryAccelerationAvailable).toBe(false);
  });

  it('reports effective ON when intent ON and Fabric backend bound', async () => {
    process.env.LOOM_WAREHOUSE_BACKEND = 'fabric';
    process.env.LOOM_DEFAULT_FABRIC_WORKSPACE = 'ws-1';
    loadOwnedItem.mockResolvedValueOnce({
      id: 'w1', workspaceId: 'ws', itemType: 'warehouse', displayName: 'W',
      state: { settings: { queryAcceleration: true } },
    } as any);
    const r = await GET(new NextRequest('http://x/api/items/warehouse/w1/settings'), ctx('w1'));
    const j = await r.json();
    expect(j.effective.queryAcceleration).toBe(true);
  });

  it('404 when the item is not owned', async () => {
    loadOwnedItem.mockResolvedValueOnce(null);
    const r = await GET(new NextRequest('http://x/api/items/warehouse/w1/settings'), ctx('w1'));
    expect(r.status).toBe(404);
  });
});

describe('PUT /settings', () => {
  const put = (id: string, body: any) =>
    PUT(
      new NextRequest(`http://x/api/items/warehouse/${id}/settings`, {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
      ctx(id),
    );

  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const r = await put('w1', { queryAcceleration: true });
    expect(r.status).toBe(401);
  });

  it('409 for an unsaved (new) warehouse', async () => {
    const r = await put('new', { queryAcceleration: true });
    expect(r.status).toBe(409);
  });

  it('400 when queryAcceleration is not a boolean', async () => {
    const r = await put('w1', { queryAcceleration: 'yes' });
    expect(r.status).toBe(400);
  });

  it('persists the requested setting and reports honest effective state (Synapse)', async () => {
    loadOwnedItem.mockResolvedValueOnce({
      id: 'w1', workspaceId: 'ws', itemType: 'warehouse', displayName: 'W',
      state: { other: 'keep' },
    } as any);
    updateOwnedItem.mockResolvedValueOnce({ id: 'w1' } as any);
    const r = await put('w1', { queryAcceleration: true });
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.settings.queryAcceleration).toBe(true);
    expect(j.effective.queryAcceleration).toBe(false); // Synapse → no GPU
    // The existing state is preserved; settings nested.
    const patch = updateOwnedItem.mock.calls[0][3];
    expect(patch.state.other).toBe('keep');
    expect(patch.state.settings.queryAcceleration).toBe(true);
  });
});
