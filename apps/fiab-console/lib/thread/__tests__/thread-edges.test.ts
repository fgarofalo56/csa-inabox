/**
 * L1 column-facet schema tests for thread-edges — `columnMappings` round-trip.
 *
 * Asserts the new optional column-grain facet on ThreadEdge / RecordEdgeInput:
 *   1. recordThreadEdge persists `columnMappings` verbatim into the Cosmos doc.
 *   2. An input WITHOUT columnMappings writes the exact pre-L1 doc shape (no
 *      `columnMappings` key at all — fully backward compatible).
 *   3. listThreadEdges returns the stored mappings unchanged (round-trip).
 *
 * Cosmos is mocked (same pattern as thread-edges-reconcile.test.ts);
 * LOOM_PURVIEW_ACCOUNT is unset so the best-effort Purview mirror is a no-op.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  threadEdgesContainer: vi.fn(async () => ({
    items: {
      query: (spec: any) => ({ fetchAll: () => h.query(spec) }),
      upsert: (doc: any) => h.upsert(doc),
    },
  })),
}));

import {
  recordThreadEdge, listThreadEdges,
  type ThreadEdge, type ThreadColumnMapping,
} from '../thread-edges';

const TENANT = 'tenant-1';
const session = { claims: { oid: TENANT, upn: 'a@contoso.com' } } as any;

const MAPPINGS: ThreadColumnMapping[] = [
  { fromColumn: 'id', toColumn: 'customer_id', transform: 'CAST(id AS BIGINT)', confidence: 'declared' },
  { fromColumn: 'name', toColumn: 'customer_name', confidence: 'derived' },
];

const input = (over: Record<string, any> = {}) => ({
  fromItemId: 'lh-1', fromType: 'lakehouse', fromName: 'Sales LH',
  toItemId: 'nb-1', toType: 'notebook', toName: 'Explore',
  action: 'analyze-in-notebook',
  ...over,
});

const savedPurview = process.env.LOOM_PURVIEW_ACCOUNT;

beforeEach(() => {
  Object.values(h).forEach((fn) => fn.mockReset());
  delete process.env.LOOM_PURVIEW_ACCOUNT; // Purview mirror stays no-op
});

afterEach(() => {
  if (savedPurview !== undefined) process.env.LOOM_PURVIEW_ACCOUNT = savedPurview;
});

describe('recordThreadEdge — columnMappings persistence (L1)', () => {
  it('persists columnMappings verbatim into the upserted doc', async () => {
    h.upsert.mockResolvedValue(undefined);
    await recordThreadEdge(session, input({ columnMappings: MAPPINGS }));
    expect(h.upsert).toHaveBeenCalledTimes(1);
    const doc = h.upsert.mock.calls[0][0] as ThreadEdge;
    expect(doc.tenantId).toBe(TENANT);
    expect(doc.fromItemId).toBe('lh-1');
    expect(doc.columnMappings).toEqual(MAPPINGS);
  });

  it('omits the columnMappings key entirely when the input has none (pre-L1 shape)', async () => {
    h.upsert.mockResolvedValue(undefined);
    await recordThreadEdge(session, input());
    const doc = h.upsert.mock.calls[0][0] as ThreadEdge;
    expect('columnMappings' in doc).toBe(false);
  });

  it('omits the columnMappings key when the input carries an EMPTY array', async () => {
    h.upsert.mockResolvedValue(undefined);
    await recordThreadEdge(session, input({ columnMappings: [] }));
    const doc = h.upsert.mock.calls[0][0] as ThreadEdge;
    expect('columnMappings' in doc).toBe(false);
  });

  it('stays best-effort — a Cosmos failure never throws', async () => {
    h.upsert.mockRejectedValue(new Error('cosmos down'));
    await expect(
      recordThreadEdge(session, input({ columnMappings: MAPPINGS })),
    ).resolves.toBeUndefined();
  });
});

describe('listThreadEdges — columnMappings round-trip (L1)', () => {
  it('returns stored columnMappings unchanged', async () => {
    h.upsert.mockResolvedValue(undefined);
    await recordThreadEdge(session, input({ columnMappings: MAPPINGS }));
    const stored = h.upsert.mock.calls[0][0] as ThreadEdge;

    h.query.mockResolvedValue({ resources: [stored] });
    const edges = await listThreadEdges(session);
    expect(edges).toHaveLength(1);
    expect(edges[0].columnMappings).toEqual(MAPPINGS);
    // Table-grain fields intact alongside the column facet.
    expect(edges[0].fromItemId).toBe('lh-1');
    expect(edges[0].toItemId).toBe('nb-1');
  });
});
