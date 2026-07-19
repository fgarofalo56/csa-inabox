import { describe, it, expect, vi, beforeEach } from 'vitest';

let queryRows: any[] = [];
const deleted: string[] = [];
const fakeContainer = {
  items: { query: vi.fn(() => ({ fetchAll: async () => ({ resources: queryRows }) })) },
  item: (id: string, _pk: string) => ({ delete: async () => { deleted.push(id); } }),
};
vi.mock('../cosmos-client', () => ({ auditLogContainer: async () => fakeContainer }));
vi.mock('../action-justification-store', () => ({ ACTION_JUSTIFICATION_KIND: 'action-justification' }));
vi.mock('../action-approval-store', () => ({ ACTION_APPROVAL_KIND: 'action-approval' }));

import { reapOntologyAudit } from '../audit-retention';

beforeEach(() => { queryRows = []; deleted.length = 0; vi.clearAllMocks(); });

describe('reapOntologyAudit', () => {
  it('queries by itemId + reapable kinds + cutoff, deletes each, returns count', async () => {
    queryRows = [{ id: 'r1', itemId: 'o1' }, { id: 'r2', itemId: 'o1' }];
    const n = await reapOntologyAudit('o1', 30, '2026-07-19T00:00:00.000Z');
    expect(n).toBe(2);
    expect(deleted).toEqual(['r1', 'r2']);
    const spec = (fakeContainer.items.query as any).mock.calls[0][0];
    const p = Object.fromEntries(spec.parameters.map((x: any) => [x.name, x.value]));
    expect(p['@i']).toBe('o1');
    expect(p['@kinds']).toEqual(['action-justification', 'action-approval']);
    // cutoff = now - 30 days
    expect(p['@cutoff']).toBe('2026-06-19T00:00:00.000Z');
  });

  it('returns 0 when nothing matches', async () => {
    queryRows = [];
    expect(await reapOntologyAudit('o1', 365, '2026-07-19T00:00:00.000Z')).toBe(0);
  });
});
