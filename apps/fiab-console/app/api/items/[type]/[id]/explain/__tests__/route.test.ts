/**
 * BFF route tests for /api/items/[type]/[id]/explain (cross-item "Explain this",
 * Wave-2 W19).
 *
 * Asserts the family/definition validation gates, the honest 503 no_aoai gate,
 * and the happy path for each family (pipeline / notebook / warehouse) with a
 * mocked AOAI chat-completions call (real fetch shape, no network) returning a
 * STRUCTURED JSON explanation. No Azure calls leave the test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

let resolveShouldThrow = false;
// Spread the real orchestrator so the unified aoai-chat-client keeps its
// aoaiToken / isUnsupportedSamplingParam helpers; only resolveAoaiTarget is
// overridden to avoid real Foundry discovery.
vi.mock('@/lib/azure/copilot-orchestrator', async (importOriginal) => ({
  ...(await importOriginal() as any),
  resolveAoaiTarget: async () => {
    if (resolveShouldThrow) throw new Error('aoai endpoint unset');
    return { endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' };
  },
}));

vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal() as any),
  cogScope: () => 'https://cognitiveservices.azure.com/.default',
}));

// Loom Thread lineage neighbors (real Cosmos read in prod) — mocked so tests
// are hermetic. `threadEdges` is mutated per-test to exercise the grounding;
// `threadEdgesShouldThrow` proves the grounding is best-effort (non-fatal).
let threadEdges: any[] = [];
let threadEdgesShouldThrow = false;
vi.mock('@/lib/thread/thread-edges', () => ({
  listThreadEdges: async () => {
    if (threadEdgesShouldThrow) throw new Error('cosmos down');
    return threadEdges;
  },
}));

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() {
      return { token: 'fake-bearer', expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  }
  return {
    ChainedTokenCredential: Cred,
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
  };
});

const ctx = (type: string, id: string) => ({ params: Promise.resolve({ type, id }) });
const req = (b: any) => ({ json: async () => b }) as any;

const fetchMock = vi.fn();

/** A well-formed structured explanation, as the model would return it. */
const EXPLANATION = {
  summary: 'Copies orders from Azure SQL into the lakehouse every night.',
  steps: ['Lookup GetWatermark', 'Copy activity CopyOrders'],
  inputs: ['AzureSqlOrders dataset', 'windowStart parameter'],
  outputs: ['lakehouse Delta table bronze.orders'],
  risks: ['No retry policy on the Copy activity', 'Full reload each run — cost'],
};

beforeEach(() => {
  resolveShouldThrow = false;
  threadEdges = [];
  threadEdgesShouldThrow = false;
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-1', upn: 'u@t.com', name: 'U' }, exp: Date.now() / 1000 + 3600 } as any);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(EXPLANATION) } }] }),
    text: async () => '',
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('POST /api/items/[type]/[id]/explain', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('../route');
    const r = await POST(req({ definition: { properties: {} } }), ctx('data-pipeline', 'i1'));
    expect(r.status).toBe(401);
  });

  it('400 for an unsupported item type', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({ definition: { x: 1 } }), ctx('lakehouse', 'i1'));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/not available/i);
  });

  it('422 when the definition is missing', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({}), ctx('data-pipeline', 'i1'));
    expect(r.status).toBe(422);
  });

  it('422 when the definition object is empty', async () => {
    const { POST } = await import('../route');
    const r = await POST(req({ definition: {} }), ctx('notebook', 'i1'));
    expect(r.status).toBe(422);
  });

  it('503 no_aoai honest gate when AOAI is unresolved', async () => {
    resolveShouldThrow = true;
    const { POST } = await import('../route');
    const r = await POST(req({ definition: { properties: { activities: [] } } }), ctx('data-pipeline', 'i1'));
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.code).toBe('no_aoai');
    expect(j.hint).toMatch(/LOOM_AOAI_ENDPOINT/);
  });

  it('pipeline → returns a structured explanation grounded in the definition', async () => {
    const { POST } = await import('../route');
    const definition = {
      properties: {
        activities: [
          { name: 'CopyOrders', type: 'Copy' },
          { name: 'GetWatermark', type: 'Lookup', dependsOn: [] },
        ],
      },
    };
    const r = await POST(req({ definition }), ctx('data-pipeline', 'i1'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.family).toBe('pipeline');
    expect(j.explanation.summary).toContain('orders');
    expect(j.explanation.risks.length).toBeGreaterThan(0);
    // The artifact JSON reached the model, and JSON response_format was requested.
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userMsg = sentBody.messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('CopyOrders');
    expect(sentBody.response_format).toEqual({ type: 'json_object' });
  });

  it('notebook → supported family, returns explanation', async () => {
    const { POST } = await import('../route');
    const r = await POST(
      req({ definition: { cells: [{ cellType: 'code', source: 'df = spark.read.parquet(...)' }], defaultLang: 'pyspark' } }),
      ctx('notebook', 'i1'),
    );
    expect(r.status).toBe(200);
    expect((await r.json()).family).toBe('notebook');
  });

  it('warehouse → supported family, returns explanation', async () => {
    const { POST } = await import('../route');
    const r = await POST(
      req({ definition: { schemas: { dbo: [{ table: 'Orders', rows: 100 }] }, views: [], procedures: [], functions: [] } }),
      ctx('warehouse', 'i1'),
    );
    expect(r.status).toBe(200);
    expect((await r.json()).family).toBe('warehouse');
  });

  it('502 when the model returns no usable summary', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"summary":"","steps":[]}' } }] }),
      text: async () => '',
    });
    const { POST } = await import('../route');
    const r = await POST(req({ definition: { properties: { activities: [{ name: 'A' }] } } }), ctx('data-pipeline', 'i1'));
    expect(r.status).toBe(502);
  });

  it('grounds the prompt with the item lineage neighbors from the Thread graph', async () => {
    // Two edges touching item i1: one feeding IN (upstream), one flowing OUT.
    threadEdges = [
      { fromItemId: 'src1', fromType: 'lakehouse', fromName: 'Bronze Lake', toItemId: 'i1', toType: 'data-pipeline' },
      { fromItemId: 'i1', fromType: 'data-pipeline', toItemId: 'dst1', toType: 'warehouse', toName: 'Sales WH' },
    ];
    const { POST } = await import('../route');
    const r = await POST(req({ definition: { properties: { activities: [{ name: 'CopyOrders', type: 'Copy' }] } } }), ctx('data-pipeline', 'i1'));
    expect(r.status).toBe(200);
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userMsg = sentBody.messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('Lineage context');
    expect(userMsg).toContain('Bronze Lake');   // upstream feeder
    expect(userMsg).toContain('Sales WH');       // downstream consumer
  });

  it('omits the lineage block when there are no edges', async () => {
    threadEdges = [];
    const { POST } = await import('../route');
    const r = await POST(req({ definition: { properties: { activities: [{ name: 'A', type: 'Copy' }] } } }), ctx('data-pipeline', 'i1'));
    expect(r.status).toBe(200);
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const userMsg = sentBody.messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).not.toContain('Lineage context');
  });

  it('node scope → focuses on a single step with its canvas neighbors', async () => {
    const { POST } = await import('../route');
    const r = await POST(
      req({
        definition: { name: 'CopyOrders', type: 'Copy' },
        scope: 'node',
        focus: { name: 'CopyOrders', upstream: ['GetWatermark'], downstream: ['NotifyDone'] },
      }),
      ctx('data-pipeline', 'i1'),
    );
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.scope).toBe('node');
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const sysMsg = sentBody.messages.find((m: any) => m.role === 'system').content;
    const userMsg = sentBody.messages.find((m: any) => m.role === 'user').content;
    expect(sysMsg).toContain('SINGLE step');
    expect(userMsg).toContain('Canvas neighbors');
    expect(userMsg).toContain('GetWatermark');   // upstream neighbor
    expect(userMsg).toContain('NotifyDone');      // downstream neighbor
  });

  it('lineage read failure is non-fatal (best-effort grounding)', async () => {
    // A thrown listThreadEdges must NOT fail the explanation.
    threadEdgesShouldThrow = true;
    const { POST } = await import('../route');
    const r = await POST(req({ definition: { properties: { activities: [{ name: 'A', type: 'Copy' }] } } }), ctx('data-pipeline', 'i1'));
    expect(r.status).toBe(200);
  });

  it('retries without temperature on a reasoning-model 400', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'unsupported_value: temperature does not support 0.2; only the default (1) value is supported',
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(EXPLANATION) } }] }),
        text: async () => '',
      });
    const { POST } = await import('../route');
    const r = await POST(req({ definition: { properties: { activities: [{ name: 'A' }] } } }), ctx('synapse-pipeline', 'i1'));
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as any).body);
    expect(retryBody.temperature).toBeUndefined();
  });
});
