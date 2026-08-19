/**
 * BIND-ROUTE `seedIncomplete` — the honest-failure channel behind #3549.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The #3549 fix introduced `seedIncomplete` in this route: when auto-bind
 * created the backing pipeline but could NOT author the item's activity graph
 * into it, the route must KEEP the authored `preview` instead of suppressing it
 * the moment the item is bound. Suppressing it is what made an empty-but-bound
 * pipeline indistinguishable from a healthy one.
 *
 * On the PR head that logic had ZERO tests — in this route, in its Synapse
 * twin, and in the editor. It was also inert, because the only consumer of
 * `preview` sat in the editor's UNBOUND branch and a `seedError` item is bound.
 * The editor half is pinned by `lib/editors/__tests__/pipeline-seed-incomplete.test.tsx`;
 * this file pins the wire contract the editor depends on.
 *
 * CONTROL PAIR — both directions, so the behaviour cannot collapse into either
 * "always send the preview" (which would re-render a stale bundle over a
 * pipeline the user has since edited) or "never send it".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const TENANT = 'oid-1';

const state = {
  itemDoc: null as any,
  workspaceDoc: null as any,
  /** What the mocked auto-bind engine reports for this open. */
  wire: {} as Record<string, unknown>,
};

const getSessionMock = vi.fn(() => ({ claims: { oid: TENANT } } as any));
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@/lib/azure/adf-client', () => ({
  listPipelines: vi.fn(async () => [{ name: 'Daily-Batch-Processing-Pipeline' }]),
  upsertPipeline: vi.fn(async () => ({ name: 'created' })),
}));

// The engine itself is exercised by lib/azure/__tests__/auto-bind-seed*.test.ts.
// Here we only need it to REPORT a given outcome, so the route's own branch is
// the thing under test.
vi.mock('@/lib/azure/auto-bind', () => ({
  autoBindOnOpen: vi.fn(async () => ({ bound: 'Daily-Batch-Processing-Pipeline', outcome: {}, persisted: false })),
  autoBindWireStatus: vi.fn(() => state.wire),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const doc = state.itemDoc;
          if (!doc) return { resources: [] };
          const params: Array<{ name: string; value: any }> = spec?.parameters || [];
          const idParam = params.find((p) => p.name === '@id');
          const typeValues = params.filter((p) => p.name.startsWith('@t')).map((p) => p.value);
          const idOk = idParam ? doc.id === idParam.value : true;
          const typeOk = typeValues.length ? typeValues.includes(doc.itemType) : true;
          return { resources: idOk && typeOk ? [doc] : [] };
        },
      }),
    },
    item: () => ({ replace: async (doc: any) => ({ resource: doc }) }),
  }),
  workspacesContainer: async () => ({
    item: () => ({ read: async () => ({ resource: state.workspaceDoc }) }),
  }),
}));

import { GET } from '../route';

const PARAMS = { params: Promise.resolve({ id: 'guid-1' }) };
const get = () => new NextRequest('http://localhost/api/items/adf-pipeline/guid-1/bind');

/** The bundle content a gated install stamps onto the item. */
const BUNDLE_CONTENT = {
  kind: 'adf-pipeline',
  activities: [
    { name: 'BronzeToSilverDQ', type: 'DatabricksNotebook', config: { notebookPath: '/Shared/02_stream' } },
    { name: 'GoldAggregation', type: 'DatabricksNotebook', dependsOn: ['BronzeToSilverDQ'], config: { notebookPath: '/Shared/03_gold' } },
  ],
};

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: TENANT } } as any);
  state.itemDoc = {
    id: 'guid-1',
    workspaceId: 'ws-1',
    itemType: 'data-pipeline',
    displayName: 'Daily Batch Processing Pipeline',
    // BOUND — auto-bind created a real pipeline — and still carrying the
    // authored graph, which is the exact #3549 state.
    state: { pipelineName: 'Daily-Batch-Processing-Pipeline', content: BUNDLE_CONTENT },
    createdBy: 'u', createdAt: 't', updatedAt: 't',
  };
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
  state.wire = { status: 'bound', via: 'created', backingName: 'Daily-Batch-Processing-Pipeline', seeded: true };
});

describe('adf-pipeline bind GET — seedIncomplete keeps the authored preview', () => {
  it('KEEPS the preview when the seed failed, even though the item is bound', async () => {
    state.wire = {
      status: 'bound',
      via: 'created',
      backingName: 'Daily-Batch-Processing-Pipeline',
      seedError: 'ADF 403: the Console managed identity needs Data Factory Contributor.',
    };

    const res = await GET(get(), PARAMS);
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.bound).toBe('Daily-Batch-Processing-Pipeline');
    // The channel the editor's gate reads.
    expect(j.autoBind.seedError).toMatch(/Data Factory Contributor/);
    // …and the authored graph is STILL sent, so the editor can show the gap.
    expect(j.preview).not.toBeNull();
    expect(j.preview.properties.activities.map((a: any) => a.name)).toEqual([
      'BronzeToSilverDQ', 'GoldAggregation',
    ]);
  });

  it('CONTROL — SUPPRESSES the preview for a healthy seeded pipeline', async () => {
    // No seedError: the live pipeline holds the content, so re-sending the
    // bundle would let the editor render a stale graph over the real one.
    const res = await GET(get(), PARAMS);
    const j = await res.json();

    expect(j.bound).toBe('Daily-Batch-Processing-Pipeline');
    expect(j.autoBind.seedError).toBeUndefined();
    expect(j.preview).toBeNull();
  });

  it('CONTROL — an UNBOUND item still gets its preview (the pre-existing path)', async () => {
    state.itemDoc.state = { content: BUNDLE_CONTENT };
    state.wire = { status: 'unavailable', reason: 'No factory visible.' };

    const res = await GET(get(), PARAMS);
    const j = await res.json();

    expect(j.bound).toBeNull();
    expect(j.preview).not.toBeNull();
  });

  it('a seedError on an item with NO authored content yields a null preview, not a crash', async () => {
    state.itemDoc.state = { pipelineName: 'Daily-Batch-Processing-Pipeline' };
    state.wire = { status: 'bound', via: 'created', seedError: 'ADF 403.' };

    const res = await GET(get(), PARAMS);
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.preview).toBeNull();
  });
});
