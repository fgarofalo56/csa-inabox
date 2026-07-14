/**
 * BFF route test for POST /api/thread/analyze-with-dax — the Weave "Analyze with
 * DAX" edge. Mocks the session, item load, evalDax executor, and lineage write.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn(async () => ({ id: 'model-1', displayName: 'Sales model', workspaceId: 'ws-1' }));
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

const recordThreadEdgeMock = vi.fn(async () => {});
vi.mock('@/lib/thread/thread-edges', () => ({ recordThreadEdge: (...a: any[]) => recordThreadEdgeMock(...a) }));

const evalDaxMock = vi.fn(async () => ({ columns: ['Amount'], rows: [{ Amount: 10 }, { Amount: 20 }], backend: 'loom-native', sql: 'SELECT ...' }));
vi.mock('@/lib/azure/tabular-eval-client', () => {
  class TabularError extends Error {
    status?: number; backend?: string; hint?: string;
    constructor(m: string, status?: number, backend?: string, hint?: string) {
      super(m); this.name = 'TabularError'; this.status = status; this.backend = backend; this.hint = hint;
    }
  }
  return { evalDax: (...a: any[]) => evalDaxMock(...a), TabularError };
});
import { TabularError } from '@/lib/azure/tabular-eval-client';
import { POST } from '../route';

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/thread/analyze-with-dax', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
const FROM = { id: 'model-1', type: 'semantic-model', name: 'Sales model' };

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
  loadOwnedItemMock.mockResolvedValue({ id: 'model-1', displayName: 'Sales model', workspaceId: 'ws-1' } as any);
  evalDaxMock.mockResolvedValue({ columns: ['Amount'], rows: [{ Amount: 10 }, { Amount: 20 }], backend: 'loom-native', sql: 'SELECT ...' } as any);
  recordThreadEdgeMock.mockClear();
  evalDaxMock.mockClear();
});

describe('analyze-with-dax route', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await POST(post({ from: FROM, values: { table: 'Sales', queryKind: 'table-preview' } }));
    expect(res.status).toBe(401);
  });

  it('400 when the source is not a semantic-model', async () => {
    const res = await POST(post({ from: { id: 'x', type: 'lakehouse' }, values: { table: 'Sales' } }));
    expect(res.status).toBe(400);
  });

  it('400 when no table is picked', async () => {
    const res = await POST(post({ from: FROM, values: { queryKind: 'table-preview' } }));
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported query kind', async () => {
    const res = await POST(post({ from: FROM, values: { table: 'Sales', queryKind: 'column-distinct' } }));
    expect(res.status).toBe(400);
  });

  it('generates DAX, executes via evalDax, returns a receipt + records lineage', async () => {
    const res = await POST(post({ from: FROM, values: { table: 'Sales', queryKind: 'top-n' } }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.dax).toMatch(/^EVALUATE/);
    expect(j.receipt.rowCount).toBe(2);
    expect(j.receipt.backend).toBe('loom-native');
    expect(j.link).toContain('/items/semantic-model/model-1');
    // evalDax called with (modelId, dax, oid).
    expect(evalDaxMock).toHaveBeenCalledWith('model-1', expect.stringMatching(/EVALUATE/), 'oid-1');
    // lineage edge recorded with the edge's action.
    expect(recordThreadEdgeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'analyze-with-dax', fromType: 'semantic-model' }));
  });

  it('surfaces a TabularError status verbatim (honest gate, no mock rows)', async () => {
    evalDaxMock.mockRejectedValueOnce(new TabularError('model backing table not found', 502, 'loom-native', 'map the table'));
    const res = await POST(post({ from: FROM, values: { table: 'Sales', queryKind: 'row-count' } }));
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.hint).toBe('map the table');
  });

  it('404 when the model is not in the tenant', async () => {
    loadOwnedItemMock.mockResolvedValueOnce(null as any);
    const res = await POST(post({ from: FROM, values: { table: 'Sales' } }));
    expect(res.status).toBe(404);
  });
});
