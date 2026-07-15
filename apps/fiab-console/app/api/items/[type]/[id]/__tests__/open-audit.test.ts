/**
 * Regression: GET /api/items/[type]/[id] records an `open` audit event.
 *
 * The /browse "Recent" section reads /api/items/recent, which joins audit-log
 * events (`c.userId = caller`) onto items. Before this fix NOTHING in the
 * product wrote those events on item open (the only audit POST was a smoke-test
 * surface), so Recent was permanently empty. These tests lock in the writer:
 *   - a successful item GET creates ONE audit doc {action:'open', userId, itemId}
 *   - repeat opens inside the throttle window do NOT spam the log
 *   - an audit failure never breaks the item read (best-effort)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
  auditLogContainer: vi.fn(),
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer, auditLogContainer } from '@/lib/azure/cosmos-client';

const OID = 'user-1';

function ctx(type: string, id: string) {
  return { params: Promise.resolve({ type, id }) };
}

const auditCreate = vi.fn(async (doc: any) => ({ resource: doc }));

function wire(itemId: string, itemType: string) {
  (getSession as any).mockReturnValue({ claims: { oid: OID, upn: 'op@x.y' } });
  (itemsContainer as any).mockResolvedValue({
    items: {
      query: () => ({
        fetchAll: async () => ({
          resources: [{ id: itemId, itemType, workspaceId: 'ws-1', displayName: 'It' }],
        }),
      }),
    },
    item: vi.fn(),
  });
  (workspacesContainer as any).mockResolvedValue({
    item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: OID } }) }),
  });
  (auditLogContainer as any).mockResolvedValue({ items: { create: auditCreate } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/items/[type]/[id] — open-event recording', () => {
  it('writes ONE audit doc with action open / the caller oid / the item identity', async () => {
    wire('item-open-1', 'lakehouse');
    const res = await GET({} as any, ctx('lakehouse', 'item-open-1'));
    expect(res.status).toBe(200);
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const doc = auditCreate.mock.calls[0][0];
    expect(doc).toMatchObject({
      action: 'open',
      userId: OID,
      itemId: 'item-open-1',
      itemType: 'lakehouse',
      workspaceId: 'ws-1',
    });
  });

  it('throttles: a second open of the SAME item within the window writes nothing', async () => {
    wire('item-open-2', 'notebook');
    await GET({} as any, ctx('notebook', 'item-open-2'));
    await GET({} as any, ctx('notebook', 'item-open-2'));
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('a different item is NOT throttled by the first one', async () => {
    wire('item-open-3', 'warehouse');
    await GET({} as any, ctx('warehouse', 'item-open-3'));
    wire('item-open-4', 'warehouse');
    await GET({} as any, ctx('warehouse', 'item-open-4'));
    expect(auditCreate).toHaveBeenCalledTimes(2);
  });

  it('an audit write failure never breaks the item read', async () => {
    wire('item-open-5', 'report');
    auditCreate.mockRejectedValueOnce(new Error('cosmos down'));
    const res = await GET({} as any, ctx('report', 'item-open-5'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('item-open-5');
  });
});
