import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory audit container stand-in.
const upserts: any[] = [];
let queryRows: any[] = [];
const fakeContainer = {
  items: {
    upsert: vi.fn(async (doc: any) => { upserts.push(doc); return { resource: doc }; }),
    query: vi.fn((_spec: any) => ({ fetchAll: async () => ({ resources: queryRows }) })),
  },
};

vi.mock('../cosmos-client', () => ({
  auditLogContainer: async () => fakeContainer,
}));

import {
  recordActionJustification, listActionJustifications, isValidReason,
  MIN_JUSTIFICATION_LEN, ACTION_JUSTIFICATION_KIND,
} from '../action-justification-store';

const session = { claims: { oid: 'oid-1', name: 'Ada L', upn: 'ada@x.io', tid: 'tid-9' }, exp: 0 } as any;

beforeEach(() => { upserts.length = 0; queryRows = []; vi.clearAllMocks(); });

describe('isValidReason', () => {
  it('rejects empty / too-short / non-string reasons', () => {
    expect(isValidReason('')).toBe(false);
    expect(isValidReason('  a  ')).toBe(false);      // 1 char trimmed
    expect(isValidReason(undefined)).toBe(false);
    expect(isValidReason(42)).toBe(false);
  });
  it('accepts a reason at/over the minimum length (after trim)', () => {
    expect(MIN_JUSTIFICATION_LEN).toBe(4);
    expect(isValidReason('fix ')).toBe(false);       // trim("fix")=3 < 4
    expect(isValidReason('typo')).toBe(true);        // exactly 4
    expect(isValidReason('typo fix')).toBe(true);
  });
});

describe('recordActionJustification', () => {
  it('writes a well-formed, actor-stamped, trimmed record and returns it', async () => {
    const rec = await recordActionJustification(session, {
      ontologyId: 'onto-7', ontologyName: 'Enterprise', action: 'deleteCustomer',
      objectType: 'Customer', actionKind: 'delete', targetId: '42',
      reason: '  duplicate record  ', outcome: 'succeeded', detail: 'deleted 1',
      nowIso: '2026-07-19T00:00:00.000Z',
    });
    expect(upserts).toHaveLength(1);
    const doc = upserts[0];
    expect(doc.itemId).toBe('onto-7');                 // partition key = ontology id
    expect(doc.kind).toBe(ACTION_JUSTIFICATION_KIND);
    expect(doc.reason).toBe('duplicate record');       // trimmed
    expect(doc.actorOid).toBe('oid-1');
    expect(doc.actorName).toBe('Ada L');
    expect(doc.actionKind).toBe('delete');
    expect(doc.targetId).toBe('42');
    expect(doc.outcome).toBe('succeeded');
    expect(doc.id).toContain('action-justification:onto-7:deleteCustomer:');
    expect(rec.id).toBe(doc.id);
  });

  it('omits optional fields cleanly when absent', async () => {
    await recordActionJustification(session, {
      ontologyId: 'o', action: 'a', objectType: 'T', actionKind: 'create',
      reason: 'seed data', outcome: 'succeeded', nowIso: '2026-07-19T00:00:00.000Z',
    });
    const doc = upserts[0];
    expect(doc.targetId).toBeUndefined();
    expect(doc.detail).toBeUndefined();
    expect(doc.ontologyName).toBeUndefined();
  });
});

describe('listActionJustifications', () => {
  it('filters by itemId + kind, clamps top, returns rows', async () => {
    queryRows = [{ id: 'x', reason: 'r', outcome: 'succeeded' }];
    const out = await listActionJustifications('onto-7', 9999);
    const spec = (fakeContainer.items.query as any).mock.calls[0][0];
    const params = Object.fromEntries(spec.parameters.map((p: any) => [p.name, p.value]));
    expect(params['@i']).toBe('onto-7');
    expect(params['@k']).toBe(ACTION_JUSTIFICATION_KIND);
    expect(params['@n']).toBe(200);                    // clamped to the 200 ceiling
    expect(out).toHaveLength(1);
  });
});
