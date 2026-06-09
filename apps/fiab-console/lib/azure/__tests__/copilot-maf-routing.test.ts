/**
 * MAF orchestration-tier routing test.
 *
 * Acceptance: with the cloud forced to Gov-High AND LOOM_MAF_ENDPOINT set,
 * orchestrate() routes to the MAF Container App and re-yields its SSE
 * OrchestratorStep stream verbatim — same transcript shape as the Foundry tier —
 * WITHOUT touching the Foundry-hub AOAI discovery path.
 *
 * Mocks: cosmos-client (persistStep no-op), foundry-client (discovery must NOT
 * be reached), and global fetch (stands in for the MAF Container App).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The orchestrator constructs a managed-identity credential at module load.
// Stub @azure/identity so the import doesn't pull the real SDK (the credential
// is never exercised on the MAF path — tool dispatch + AOAI live in the MAF app).
vi.mock('@azure/identity', () => ({
  ChainedTokenCredential: class {},
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));

// copilot-orchestrator imports the full fleet of Azure service clients at module
// load (several pull native deps like mssql/tedious). None are reached on the
// MAF path, so stub them so the import graph stays light + hermetic.
vi.mock('@/lib/azure/synapse-sql-client', () => ({ executeQuery: vi.fn(), dedicatedTarget: vi.fn(), serverlessTarget: vi.fn() }));
vi.mock('@/lib/azure/synapse-dev-client', () => ({}));
vi.mock('@/lib/azure/synapse-pool-arm', () => ({}));
vi.mock('@/lib/azure/databricks-client', () => ({}));
vi.mock('@/lib/azure/apim-client', () => ({}));
vi.mock('@/lib/azure/adf-client', () => ({}));
vi.mock('@/lib/azure/kusto-client', () => ({}));
vi.mock('@/lib/azure/adls-client', () => ({}));
vi.mock('@/lib/azure/powerbi-client', () => ({}));
vi.mock('@/lib/azure/fabric-client', () => ({}));
vi.mock('@/lib/azure/activator-client', () => ({}));
vi.mock('@/lib/admin/self-audit', () => ({ runSelfAudit: vi.fn(), applyFix: vi.fn() }));

// persistStep writes to Cosmos; stub the container so it's a no-op.
vi.mock('@/lib/azure/cosmos-client', () => ({
  copilotSessionsContainer: vi.fn(async () => ({
    item: () => ({ read: async () => ({ resource: null }), replace: async () => ({}) }),
    items: { create: async () => ({}) },
  })),
}));

// If MAF routing works, discovery is never called. Throw if it is, so a
// regression that falls through to the Foundry path fails loudly.
const listConnections = vi.fn(async () => {
  throw new Error('Foundry hub discovery must NOT run on the MAF tier');
});
vi.mock('@/lib/azure/foundry-client', () => ({ listConnections: () => listConnections() }));

function sseStream(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

const ORIG = {
  cloud: process.env.LOOM_CLOUD,
  maf: process.env.LOOM_MAF_ENDPOINT,
  azureCloud: process.env.AZURE_CLOUD,
};

describe('orchestrate() MAF tier routing (GCC-High / IL5)', () => {
  beforeEach(() => {
    vi.resetModules();
    listConnections.mockClear();
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_MAF_ENDPOINT = 'http://loom-copilot-maf';
    delete process.env.AZURE_CLOUD;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries({
      LOOM_CLOUD: ORIG.cloud,
      LOOM_MAF_ENDPOINT: ORIG.maf,
      AZURE_CLOUD: ORIG.azureCloud,
    })) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = v;
    }
  });

  it('routes to the MAF app and re-yields its step stream in order', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        { event: 'session', data: { sessionId: 's-maf-1' } },
        { event: 'step', data: { kind: 'thought', content: 'Planning…' } },
        { event: 'step', data: { kind: 'tool_call', name: 'item_list', args: {}, callId: 'c1' } },
        { event: 'step', data: { kind: 'tool_result', name: 'item_list', callId: 'c1', durationMs: 5, result: [] } },
        { event: 'step', data: { kind: 'final', content: 'All done.', model: 'gpt-4o' } },
        { event: 'done', data: { sessionId: 's-maf-1' } },
      ]),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { orchestrate } = await import('@/lib/azure/copilot-orchestrator');
    const steps: any[] = [];
    for await (const step of orchestrate({ prompt: 'list my items', sessionId: 's-maf-1', userOid: 'user-oid-1' })) {
      steps.push(step);
    }

    // Same transcript shape the Foundry tier emits.
    expect(steps.map((s) => s.kind)).toEqual(['thought', 'tool_call', 'tool_result', 'final']);
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'final', content: 'All done.', model: 'gpt-4o' });

    // It hit the MAF Container App with the trusted user-oid header.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe('http://loom-copilot-maf/orchestrate');
    expect(init.method).toBe('POST');
    expect(init.headers['x-user-oid']).toBe('user-oid-1');

    // Foundry-hub discovery was never reached.
    expect(listConnections).not.toHaveBeenCalled();
  });

  it('surfaces an error step (not a throw) when the MAF app is unreachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { orchestrate } = await import('@/lib/azure/copilot-orchestrator');
    const steps: any[] = [];
    for await (const step of orchestrate({ prompt: 'hi', sessionId: 's2', userOid: 'u2' })) {
      steps.push(step);
    }
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('error');
    expect(steps[0].error).toMatch(/MAF orchestration tier unreachable/);
  });

  it('does NOT route to MAF when LOOM_MAF_ENDPOINT is unset (falls back to Foundry path)', async () => {
    delete process.env.LOOM_MAF_ENDPOINT;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { orchestrate } = await import('@/lib/azure/copilot-orchestrator');
    const steps: any[] = [];
    for await (const step of orchestrate({ prompt: 'hi', sessionId: 's3', userOid: 'u3' })) {
      steps.push(step);
    }
    // No MAF proxy call; the Foundry discovery path runs instead (and errors
    // here because listConnections is stubbed to throw → NoAoaiDeploymentError).
    expect(fetchMock).not.toHaveBeenCalled();
    expect(steps[0].kind).toBe('error');
  });
});
