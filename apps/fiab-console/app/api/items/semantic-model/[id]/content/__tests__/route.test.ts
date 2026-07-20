/**
 * BFF route test for /api/items/semantic-model/[id]/content (task #17).
 * Verifies in-place authoring of state.content + backing-source descriptor.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-1' } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn(async (..._a: any[]) => ({
  id: 'sm-1', workspaceId: 'ws-1', itemType: 'semantic-model', displayName: 'Sales Model',
  state: { existingKey: 'keep-me' },
} as any));
const updateOwnedItemMock = vi.fn(async (_id: string, _t: string, _oid: string, patch: any) => ({
  id: 'sm-1', workspaceId: 'ws-1', itemType: 'semantic-model', displayName: 'Sales Model',
  state: patch.state,
} as any));
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
  updateOwnedItem: (...a: any[]) => updateOwnedItemMock(...a),
}));

import { GET, PUT } from '../route';

const ctx = (id = 'sm-1') => ({ params: Promise.resolve({ id }) });
const put = (body: unknown) =>
  new NextRequest('http://localhost/api/items/semantic-model/sm-1/content', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });

const goodContent = {
  kind: 'semantic-model',
  tables: [{ name: 'loom_sales_wide', columns: [{ name: 'category', dataType: 'String' }, { name: 'extended_amount', dataType: 'Double' }] }],
  measures: [{ table: 'loom_sales_wide', name: 'Total Sales', expression: "CALCULATE(SUM('loom_sales_wide'[extended_amount]))", formatString: '$#,0' }],
};

describe('semantic-model content route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({ claims: { oid: 'oid-1' } } as any);
    loadOwnedItemMock.mockResolvedValue({
      id: 'sm-1', workspaceId: 'ws-1', itemType: 'semantic-model', displayName: 'Sales Model',
      state: { existingKey: 'keep-me' },
    } as any);
  });

  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const res = await PUT(put({ content: goodContent }), ctx());
    expect(res.status).toBe(401);
  });

  it('persists valid content + merges onto existing state', async () => {
    const res = await PUT(put({ content: goodContent, sourceTarget: 'lakehouse', sourceDatabase: 'loom_lakehouse' }), ctx());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.tableCount).toBe(1);
    expect(j.measureCount).toBe(1);
    expect(j.sourceTarget).toBe('lakehouse');
    expect(j.sourceDatabase).toBe('loom_lakehouse');
    // merged: existing sibling key preserved, content + source written
    const patch = updateOwnedItemMock.mock.calls[0][3];
    expect(patch.state.existingKey).toBe('keep-me');
    expect(patch.state.content.kind).toBe('semantic-model');
    expect(patch.state.sourceSchema).toBe('dbo');
  });

  it('rejects content with no tables (400)', async () => {
    const res = await PUT(put({ content: { kind: 'semantic-model', tables: [], measures: [] } }), ctx());
    expect(res.status).toBe(400);
    expect(updateOwnedItemMock).not.toHaveBeenCalled();
  });

  it('rejects a garbage table name (400, no freeform passthrough)', async () => {
    const bad = { kind: 'semantic-model', tables: [{ name: 'x; DROP TABLE y', columns: [{ name: 'c', dataType: 'String' }] }], measures: [] };
    const res = await PUT(put({ content: bad }), ctx());
    expect(res.status).toBe(400);
  });

  it('rejects a measure referencing an unknown table (400)', async () => {
    const bad = { kind: 'semantic-model', tables: [{ name: 't1', columns: [{ name: 'c', dataType: 'String' }] }], measures: [{ table: 'nope', name: 'M', expression: 'SUM(t1[c])' }] };
    const res = await PUT(put({ content: bad }), ctx());
    expect(res.status).toBe(400);
  });

  it('404 when the item is not found', async () => {
    loadOwnedItemMock.mockResolvedValue(null as any);
    const res = await PUT(put({ content: goodContent }), ctx());
    expect(res.status).toBe(404);
  });

  it('GET returns the persisted content shape', async () => {
    loadOwnedItemMock.mockResolvedValue({
      id: 'sm-1', workspaceId: 'ws-1', itemType: 'semantic-model', displayName: 'Sales Model',
      state: { content: goodContent, sourceTarget: 'lakehouse', sourceSchema: 'dbo', sourceDatabase: 'loom_lakehouse' },
    } as any);
    const res = await GET(new NextRequest('http://localhost/api/items/semantic-model/sm-1/content'), ctx());
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.content.tables[0].name).toBe('loom_sales_wide');
    expect(j.sourceDatabase).toBe('loom_lakehouse');
  });
});
