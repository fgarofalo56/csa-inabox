/**
 * BFF route test for /api/items/paginated-report/[id]/rdl (task #17).
 * Verifies raw-RDL persistence onto state.rdlXml (the slot /render reads).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn(async (..._a: any[]) => ({
  id: 'pr-1', workspaceId: 'ws-1', itemType: 'paginated-report', displayName: 'Invoice', state: { keep: 1 },
} as any));
const updateOwnedItemMock = vi.fn(async (_id: string, _t: string, _oid: string, patch: any) => ({
  id: 'pr-1', workspaceId: 'ws-1', itemType: 'paginated-report', displayName: 'Invoice', state: patch.state,
} as any));
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
  updateOwnedItem: (...a: any[]) => updateOwnedItemMock(...a),
}));

import { GET, PUT } from '../route';

const ctx = (id = 'pr-1') => ({ params: Promise.resolve({ id }) });
const put = (body: unknown) =>
  new NextRequest('http://localhost/api/items/paginated-report/pr-1/rdl', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });

const RDL = '<?xml version="1.0"?><Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition"><Body><ReportItems/></Body></Report>';

describe('paginated-report rdl route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
    loadOwnedItemMock.mockResolvedValue({
      id: 'pr-1', workspaceId: 'ws-1', itemType: 'paginated-report', displayName: 'Invoice', state: { keep: 1 },
    } as any);
  });

  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await PUT(put({ rdl: RDL }), ctx());
    expect(res.status).toBe(401);
  });

  it('persists a valid RDL onto state.rdlXml (merged)', async () => {
    const res = await PUT(put({ rdl: RDL }), ctx());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.bytes).toBeGreaterThan(0);
    const patch = updateOwnedItemMock.mock.calls[0][3];
    expect(patch.state.rdlXml).toBe(RDL);
    expect(patch.state.keep).toBe(1); // sibling key preserved
  });

  it('rejects empty rdl (400)', async () => {
    const res = await PUT(put({ rdl: '   ' }), ctx());
    expect(res.status).toBe(400);
    expect(updateOwnedItemMock).not.toHaveBeenCalled();
  });

  it('rejects non-RDL payload (400)', async () => {
    const res = await PUT(put({ rdl: '{"not":"xml"}' }), ctx());
    expect(res.status).toBe(400);
  });

  it('404 when item not found', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const res = await PUT(put({ rdl: RDL }), ctx());
    expect(res.status).toBe(404);
  });

  it('GET returns the stored rdl', async () => {
    loadOwnedItemMock.mockResolvedValue({
      id: 'pr-1', workspaceId: 'ws-1', itemType: 'paginated-report', displayName: 'Invoice', state: { rdlXml: RDL },
    } as any);
    const res = await GET(new NextRequest('http://localhost/api/items/paginated-report/pr-1/rdl'), ctx());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.rdl).toBe(RDL);
  });
});
