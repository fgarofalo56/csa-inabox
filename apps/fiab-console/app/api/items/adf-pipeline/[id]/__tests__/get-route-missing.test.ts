/**
 * BFF route test for GET /api/items/adf-pipeline/[id] — NotFound is an
 * EXPECTED state, not a backend failure (#2895).
 *
 * A bound item whose Azure pipeline has not been published (or was deleted)
 * used to come back as a bare 502 carrying `e.message`, which for the ADF
 * client is the VERBATIM ARM body — `{"code":"NotFound",…,"target":
 * "/subscriptions/…"}`. The editor rendered that blob in a red card.
 *
 * The route now classifies on the status the client attaches: 404 → a
 * structured `code:'pipeline-missing'` the editor turns into a guided
 * "publish it or rebind" surface. CONTROL: every OTHER status is still a
 * genuine 502 error, so this is a classification, not a suppression.
 *
 * Cosmos + auth + adf-client are mocked so the test runs offline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const TENANT = 'oid-1';

const state = {
  itemDoc: null as any,
  workspaceDoc: null as any,
  getPipelineImpl: (async () => ({ name: 'ingest_orders', properties: { activities: [] } })) as () => Promise<any>,
};

vi.mock('@/lib/auth/session', () => ({ getSession: () => ({ claims: { oid: TENANT } }) }));

vi.mock('@/lib/azure/adf-client', () => ({
  getPipeline: vi.fn(async () => state.getPipelineImpl()),
  upsertPipeline: vi.fn(async () => ({ name: 'x' })),
  deletePipeline: vi.fn(async () => undefined),
}));

vi.mock('@/lib/azure/adf-factory-context', () => ({
  withFactoryOverride: async (_o: unknown, fn: () => Promise<any>) => fn(),
  resolveFactoryOverride: () => undefined,
  factoryOverrideFromSearchParams: () => undefined,
  currentFactoryOverride: () => undefined,
  withFactoryFromRequest: async (_r: unknown, fn: () => Promise<any>) => fn(),
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
const req = () => new NextRequest('http://localhost/api/items/adf-pipeline/guid-1');

/** The exact error shape `adf-client.jsonOrThrow` throws on an ARM 404 —
 *  placeholder ids only, this repo is public. */
function armError(status: number) {
  const e = new Error(
    `getPipeline(ingest_orders) failed ${status}: {"code":"NotFound","message":"The Pipeline ` +
    `'ingest_orders' does not exist.","target":"/subscriptions/00000000-0000-0000-0000-000000000000` +
    `/resourceGroups/rg-example/providers/Microsoft.DataFactory/factories/adf-example"}`,
  ) as Error & { status?: number };
  e.status = status;
  return e;
}

beforeEach(() => {
  // Bound item with NO stamped state.content, so the content fallback can't
  // mask the classification we're testing.
  state.itemDoc = {
    id: 'guid-1', workspaceId: 'ws-1', itemType: 'adf-pipeline',
    displayName: 'My Pipeline', state: { pipelineName: 'ingest_orders' },
    createdBy: 'u', createdAt: 't', updatedAt: 't',
  };
  state.workspaceDoc = { id: 'ws-1', tenantId: TENANT };
});

describe('GET /api/items/adf-pipeline/[id] — NotFound classification (#2895)', () => {
  it('a 404 from ARM becomes a structured pipeline-missing state', async () => {
    state.getPipelineImpl = async () => { throw armError(404); };
    const res = await GET(req(), PARAMS);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.code).toBe('pipeline-missing');
    expect(body.pipelineName).toBe('ingest_orders');
    // The verbatim ARM body never crosses the wire on this path.
    expect(JSON.stringify(body)).not.toContain('/subscriptions/');
    expect(JSON.stringify(body)).not.toContain('adf-example');
  });

  it('CONTROL — any other failure is still a genuine 502 error', async () => {
    state.getPipelineImpl = async () => { throw armError(403); };
    const res = await GET(req(), PARAMS);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.code).toBeUndefined();
    expect(String(body.error)).toContain('failed 403');
  });

  it('CONTROL — the happy path is untouched', async () => {
    state.getPipelineImpl = async () => ({ name: 'ingest_orders', properties: { activities: [{ name: 'Copy1' }] } });
    const res = await GET(req(), PARAMS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.boundTo).toBe('ingest_orders');
    expect(body.pipeline.properties.activities).toHaveLength(1);
  });
});
