import { describe, it, expect, vi, beforeEach } from 'vitest';

const upserts: any[] = [];
let queryRows: any[] = [];
const store = new Map<string, any>();
const fakeContainer = {
  items: {
    upsert: vi.fn(async (doc: any) => { upserts.push(doc); store.set(doc.id, doc); return { resource: doc }; }),
    query: vi.fn(() => ({ fetchAll: async () => ({ resources: queryRows }) })),
  },
  item: (id: string, _pk: string) => ({ read: async () => ({ resource: store.get(id) }) }),
};
vi.mock('../cosmos-client', () => ({ auditLogContainer: async () => fakeContainer }));

import {
  paramsHash, requestApproval, findUsableApproval, consumeApproval, decideApproval, listApprovals, ACTION_APPROVAL_KIND,
} from '../action-approval-store';

const session = { claims: { oid: 'req-1', name: 'Requester' }, exp: 0 } as any;
const approver = { claims: { oid: 'appr-1', name: 'Approver' }, exp: 0 } as any;

beforeEach(() => { upserts.length = 0; queryRows = []; store.clear(); vi.clearAllMocks(); });

describe('paramsHash', () => {
  it('is order-independent and stable', () => {
    expect(paramsHash({ a: 1, b: 2 })).toBe(paramsHash({ b: 2, a: 1 }));
    expect(paramsHash({ a: 1 })).not.toBe(paramsHash({ a: 2 }));
  });
});

describe('requestApproval', () => {
  it('writes a pending, requester-stamped record with the params hash + preview', async () => {
    const rec = await requestApproval(session, {
      ontologyId: 'o1', action: 'deleteOrder', objectType: 'Order', actionKind: 'delete',
      params: { id: '42', reason: 'x' }, nowIso: '2026-07-19T00:00:00.000Z',
    });
    expect(rec.status).toBe('pending');
    expect(rec.itemId).toBe('o1');
    expect(rec.kind).toBe(ACTION_APPROVAL_KIND);
    expect(rec.requesterOid).toBe('req-1');
    expect(rec.paramsHash).toBe(paramsHash({ id: '42', reason: 'x' }));
    expect(rec.paramsPreview).toContain('id=42');
  });
});

describe('findUsableApproval', () => {
  it('passes item/kind/action/hash/status filters and returns the first row', async () => {
    queryRows = [{ id: 'a1', status: 'approved' }];
    const out = await findUsableApproval('o1', 'deleteOrder', 'deadbeef');
    const spec = (fakeContainer.items.query as any).mock.calls[0][0];
    const p = Object.fromEntries(spec.parameters.map((x: any) => [x.name, x.value]));
    expect(p['@i']).toBe('o1'); expect(p['@a']).toBe('deleteOrder'); expect(p['@h']).toBe('deadbeef'); expect(p['@s']).toBe('approved');
    expect(out?.id).toBe('a1');
  });
  it('returns null when none', async () => { queryRows = []; expect(await findUsableApproval('o1', 'x', 'h')).toBeNull(); });
});

describe('decideApproval + consumeApproval', () => {
  it('approve stamps approver + status; consume marks consumed', async () => {
    const req = await requestApproval(session, { ontologyId: 'o1', action: 'a', objectType: 'T', actionKind: 'create', params: { x: 1 }, nowIso: '2026-07-19T00:00:00.000Z' });
    const decided = await decideApproval(req.id, 'o1', approver, 'approve', 'looks fine', '2026-07-19T01:00:00.000Z');
    expect(decided?.status).toBe('approved');
    expect(decided?.decidedByOid).toBe('appr-1');
    expect(decided?.note).toBe('looks fine');
    await consumeApproval(req.id, 'o1');
    expect(store.get(req.id).consumed).toBe(true);
  });
  it('reject sets rejected; missing id returns null', async () => {
    const req = await requestApproval(session, { ontologyId: 'o1', action: 'a', objectType: 'T', actionKind: 'create', params: {}, nowIso: '2026-07-19T00:00:00.000Z' });
    expect((await decideApproval(req.id, 'o1', approver, 'reject', '', '2026-07-19T02:00:00.000Z'))?.status).toBe('rejected');
    expect(await decideApproval('nope', 'o1', approver, 'approve', '', '2026-07-19T02:00:00.000Z')).toBeNull();
  });
});

describe('listApprovals', () => {
  it('filters by item + kind, clamps top', async () => {
    queryRows = [{ id: 'a1' }];
    await listApprovals('o1', 5000);
    const spec = (fakeContainer.items.query as any).mock.calls[0][0];
    const p = Object.fromEntries(spec.parameters.map((x: any) => [x.name, x.value]));
    expect(p['@i']).toBe('o1'); expect(p['@k']).toBe(ACTION_APPROVAL_KIND); expect(p['@n']).toBe(200);
  });
});
