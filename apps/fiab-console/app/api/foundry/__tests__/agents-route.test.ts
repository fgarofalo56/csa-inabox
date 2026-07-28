/**
 * BFF route tests for the AI Foundry Agents surface:
 *   GET  /api/foundry/agents        → listAgents
 *   POST /api/foundry/agents        → createOrUpdateAgent (right args)
 *   POST /api/foundry/agents/run    → runAgentInspectTiered → runAgentAndInspect
 *                                     (Foundry tier is the default; the MAF Gov
 *                                     tier is exercised in agent-runtime-tier.test)
 *
 * Asserts: (1) unauthed → 401, (2) happy paths call the real client with the
 * expected arguments, (3) the honest gate — FoundryAgentNotConfiguredError —
 * yields HTTP 501 with code:'not_configured' + missing env var. No no-ops:
 * every assertion checks a concrete value or a spy call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- session mock (toggle authed/unauthed per test) ----
const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  // B-N14d added `tenantScopeId` to this route's imports; without it in the mock
  // the module resolves to undefined and EVERY request 502s (which is how this
  // surfaced - 501/429 cases all returned 502 too).
  tenantScopeId: () => 'tenant-test',
}));

// ---- agent-memory service mock (B-N14d) - the real one talks to Cosmos ----
const recallAgentMemories = vi.fn(async () => ({ block: '', rows: [] }) as any);
const writeAgentMemory = vi.fn(async () => undefined as any);
vi.mock('@/lib/azure/agent-memory-service', () => ({
  recallAgentMemories: (...a: any[]) => recallAgentMemories(...(a as [])),
  writeAgentMemory: (...a: any[]) => writeAgentMemory(...(a as [])),
}));

// ---- agent-memory CLIENT mock (AIF-14) ----
// The real module is Cosmos + AOAI backed. Left un-mocked, the run route's
// post-response `extractAndStoreMemory` reached live AOAI target resolution
// (ARM `/connections` paging) and took ~23-30s to fail, which is what pushed
// the happy-path run test to the 30s timeout. Mocked here for the same reason
// agent-memory-service is: a BFF route test must not do real Azure I/O.
const saveThread = vi.fn(async () => null as any);
const extractAndStoreMemory = vi.fn(async () => [] as any[]);
const retrieveMemories = vi.fn(async () => [] as any[]);
vi.mock('@/lib/azure/agent-memory-client', () => ({
  saveThread: (...a: any[]) => saveThread(...(a as [])),
  extractAndStoreMemory: (...a: any[]) => extractAndStoreMemory(...(a as [])),
  retrieveMemories: (...a: any[]) => retrieveMemories(...(a as [])),
  memoryPreamble: (rows: any[]) => (rows?.length ? `mem:${rows.length}` : ''),
}));

// ---- foundry-agent-client mock (the real client is unit-tested elsewhere) ----
// Honest gate is a REAL error subclass so `instanceof` works in the route.
class FoundryAgentNotConfiguredError extends Error {
  hint: string;
  constructor(missingVar: string, hint: string) {
    super(`Azure AI Foundry Agent Service is not configured: missing ${missingVar}`);
    this.name = 'FoundryAgentNotConfiguredError';
    this.hint = hint;
  }
}
class FoundryAgentError extends Error {
  status: number; body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Foundry Agent Service call failed (${status})`);
    this.name = 'FoundryAgentError'; this.status = status; this.body = body;
  }
}

const listAgents = vi.fn();
const createOrUpdateAgent = vi.fn();
const runAgentAndInspect = vi.fn();
const getProjectId = vi.fn(() => 'proj-guid-123');

vi.mock('@/lib/azure/foundry-agent-client', () => ({
  listAgents: (...a: any[]) => listAgents(...a),
  createOrUpdateAgent: (...a: any[]) => createOrUpdateAgent(...a),
  runAgentAndInspect: (...a: any[]) => runAgentAndInspect(...a),
  getProjectId: () => getProjectId(),
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
}));

function jsonReq(body: unknown): any {
  return { json: async () => body } as any;
}

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  listAgents.mockReset();
  createOrUpdateAgent.mockReset();
  runAgentAndInspect.mockReset();
  getProjectId.mockReset().mockReturnValue('proj-guid-123');
  recallAgentMemories.mockReset().mockResolvedValue({ block: '', rows: [] } as any);
  writeAgentMemory.mockReset().mockResolvedValue(undefined as any);
  saveThread.mockReset().mockResolvedValue(null as any);
  extractAndStoreMemory.mockReset().mockResolvedValue([] as any[]);
  retrieveMemories.mockReset().mockResolvedValue([] as any[]);
});

afterEach(() => { vi.resetModules(); });

describe('GET /api/foundry/agents', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/foundry/agents/route');
    const r = await GET();
    expect(r.status).toBe(401);
  });

  it('lists agents via listAgents(projectId) and returns them', async () => {
    listAgents.mockResolvedValue([{ name: 'finance', definition: { model: 'gpt-4o' } }]);
    const { GET } = await import('@/app/api/foundry/agents/route');
    const r = await GET();
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.agents).toEqual([{ name: 'finance', definition: { model: 'gpt-4o' } }]);
    expect(j.projectId).toBe('proj-guid-123');
    // The client was called with the resolved projectId.
    expect(listAgents).toHaveBeenCalledWith('proj-guid-123');
  });

  it('honest gate → 501 code:not_configured when LOOM_FOUNDRY_PROJECT_ENDPOINT unset', async () => {
    getProjectId.mockImplementation(() => {
      throw new FoundryAgentNotConfiguredError('LOOM_FOUNDRY_PROJECT_ENDPOINT', 'Set the project endpoint.');
    });
    const { GET } = await import('@/app/api/foundry/agents/route');
    const r = await GET();
    const j = await r.json();
    expect(r.status).toBe(501);
    expect(j.ok).toBe(false);
    expect(j.code).toBe('not_configured');
    expect(j.missing).toBe('LOOM_FOUNDRY_PROJECT_ENDPOINT');
    expect(j.hint).toBe('Set the project endpoint.');
    expect(listAgents).not.toHaveBeenCalled();
  });
});

describe('POST /api/foundry/agents', () => {
  it('creates an agent: createOrUpdateAgent(projectId, name, {name, model, instructions, tools})', async () => {
    createOrUpdateAgent.mockResolvedValue({ name: 'finance', projectId: 'proj-guid-123' });
    const { POST } = await import('@/app/api/foundry/agents/route');
    const r = await POST(jsonReq({
      name: 'finance',
      model: 'gpt-4o',
      instructions: 'You answer finance questions.',
      tools: [{ type: 'code_interpreter' }],
      description: 'Finance helper',
    }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.agent).toMatchObject({ name: 'finance' });
    // Exact-arg assertion against the real client signature.
    expect(createOrUpdateAgent).toHaveBeenCalledTimes(1);
    const [pid, name, body] = createOrUpdateAgent.mock.calls[0];
    expect(pid).toBe('proj-guid-123');
    expect(name).toBe('finance');
    expect(body).toMatchObject({
      name: 'finance',
      model: 'gpt-4o',
      instructions: 'You answer finance questions.',
      tools: [{ type: 'code_interpreter' }],
      description: 'Finance helper',
    });
  });

  it('400 when required fields are missing (no client call)', async () => {
    const { POST } = await import('@/app/api/foundry/agents/route');
    const r = await POST(jsonReq({ name: 'x' })); // missing model + instructions
    expect(r.status).toBe(400);
    expect(createOrUpdateAgent).not.toHaveBeenCalled();
  });

  it('honest gate → 501 code:not_configured on create when unconfigured', async () => {
    getProjectId.mockImplementation(() => {
      throw new FoundryAgentNotConfiguredError('LOOM_FOUNDRY_PROJECT_ENDPOINT', 'Provision the project.');
    });
    const { POST } = await import('@/app/api/foundry/agents/route');
    const r = await POST(jsonReq({ name: 'finance', model: 'gpt-4o', instructions: 'hi' }));
    const j = await r.json();
    expect(r.status).toBe(501);
    expect(j.code).toBe('not_configured');
    expect(j.missing).toBe('LOOM_FOUNDRY_PROJECT_ENDPOINT');
    expect(createOrUpdateAgent).not.toHaveBeenCalled();
  });
});

describe('POST /api/foundry/agents/run', () => {
  it('runs the agent via the Foundry tier (default) and returns the inspection', async () => {
    runAgentAndInspect.mockResolvedValue({
      threadId: 't1', runId: 'r1', status: 'completed', answer: '42',
      steps: [{ id: 's1', type: 'tool_calls', status: 'completed', toolCalls: [] }],
    });
    const { POST } = await import('@/app/api/foundry/agents/run/route');
    const r = await POST(jsonReq({ agent: 'finance', question: 'meaning of life?' }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.tier).toBe('foundry-agent-service');
    expect(j.data.answer).toBe('42');
    expect(j.data.steps).toHaveLength(1);
    // The tier wrapper calls the real client with (agentName, question, opts).
    const [agentArg, questionArg] = runAgentAndInspect.mock.calls[0];
    expect(agentArg).toBe('finance');
    expect(questionArg).toBe('meaning of life?');
  });

  it('honest gate → 501 code:not_configured when the run route is unconfigured', async () => {
    runAgentAndInspect.mockImplementation(() => {
      throw new FoundryAgentNotConfiguredError('LOOM_FOUNDRY_PROJECT_ENDPOINT', 'Set the endpoint.');
    });
    const { POST } = await import('@/app/api/foundry/agents/run/route');
    const r = await POST(jsonReq({ agent: 'finance', question: 'hi' }));
    const j = await r.json();
    expect(r.status).toBe(501);
    expect(j.code).toBe('not_configured');
    expect(j.missing).toBe('LOOM_FOUNDRY_PROJECT_ENDPOINT');
  });

  it('FoundryAgentError → its own status code', async () => {
    runAgentAndInspect.mockImplementation(() => { throw new FoundryAgentError(429, { rate: 'limited' }, 'too many'); });
    const { POST } = await import('@/app/api/foundry/agents/run/route');
    const r = await POST(jsonReq({ agent: 'finance', question: 'hi' }));
    const j = await r.json();
    expect(r.status).toBe(429);
    expect(j.ok).toBe(false);
    expect(j.error).toBe('too many');
  });

  // ── Memory is enrichment, never a dependency (B-N14d regression guard) ────
  // A hanging memory backend previously stalled this route for ~23-30s because
  // the post-response persist/learn block was awaited unbounded. Every memory
  // await on the request path is now bounded; these pin that contract so the
  // stall cannot come back.
  describe('agent memory never delays or fails the run', () => {
    const never = () => new Promise<any>(() => { /* deliberately never settles */ });

    afterEach(() => {
      delete process.env.LOOM_AGENT_MEMORY_RECALL_BUDGET_MS;
      delete process.env.LOOM_AGENT_MEMORY_LEARN_BUDGET_MS;
    });

    it('a HANGING post-run memory write does not delay or fail the run', async () => {
      process.env.LOOM_AGENT_MEMORY_LEARN_BUDGET_MS = '150';
      runAgentAndInspect.mockResolvedValue({
        threadId: 't1', runId: 'r1', status: 'completed', answer: '42', steps: [],
      });
      // The exact seam that regressed: the distillation hangs forever (it
      // reaches AOAI target resolution in prod). The run must still return.
      extractAndStoreMemory.mockImplementation(never);

      const { POST } = await import('@/app/api/foundry/agents/run/route');
      const started = Date.now();
      const r = await POST(jsonReq({ agent: 'finance', question: 'meaning of life?' }));
      const elapsed = Date.now() - started;
      const j = await r.json();

      expect(r.status).toBe(200);
      expect(j.ok).toBe(true);
      expect(j.data.answer).toBe('42');       // the answer survives the hang
      expect(elapsed).toBeLessThan(5_000);    // bounded, not the ~30s stall
      expect(extractAndStoreMemory).toHaveBeenCalled(); // still attempted
    }, 20_000);

    it('a HANGING thread save does not delay or fail the run', async () => {
      process.env.LOOM_AGENT_MEMORY_LEARN_BUDGET_MS = '150';
      runAgentAndInspect.mockResolvedValue({
        threadId: 't1', runId: 'r1', status: 'completed', answer: '42', steps: [],
      });
      saveThread.mockImplementation(never);   // first await in the post-run block

      const { POST } = await import('@/app/api/foundry/agents/run/route');
      const started = Date.now();
      const r = await POST(jsonReq({ agent: 'finance', question: 'meaning of life?' }));
      const elapsed = Date.now() - started;
      const j = await r.json();

      expect(r.status).toBe(200);
      expect(j.data.answer).toBe('42');
      expect(elapsed).toBeLessThan(5_000);
    }, 20_000);

    it('a HANGING recall does not delay or fail the run', async () => {      process.env.LOOM_AGENT_MEMORY_RECALL_BUDGET_MS = '150';
      runAgentAndInspect.mockResolvedValue({
        threadId: 't1', runId: 'r1', status: 'completed', answer: '42', steps: [],
      });
      recallAgentMemories.mockImplementation(never);
      retrieveMemories.mockImplementation(never);

      const { POST } = await import('@/app/api/foundry/agents/run/route');
      const started = Date.now();
      const r = await POST(jsonReq({ agent: 'finance', question: 'meaning of life?' }));
      const elapsed = Date.now() - started;
      const j = await r.json();

      expect(r.status).toBe(200);
      expect(j.data.answer).toBe('42');
      expect(elapsed).toBeLessThan(5_000);
      // Recall timed out, so the question went to the agent UNaugmented.
      expect(runAgentAndInspect.mock.calls[0][1]).toBe('meaning of life?');
    }, 20_000);

    it('a THROWING memory backend does not fail the run', async () => {
      runAgentAndInspect.mockResolvedValue({
        threadId: 't1', runId: 'r1', status: 'completed', answer: '42', steps: [],
      });
      const boom = async () => { throw new Error('cosmos down'); };
      recallAgentMemories.mockImplementation(boom);
      retrieveMemories.mockImplementation(boom);
      saveThread.mockImplementation(boom);
      extractAndStoreMemory.mockImplementation(boom);

      const { POST } = await import('@/app/api/foundry/agents/run/route');
      const r = await POST(jsonReq({ agent: 'finance', question: 'meaning of life?' }));
      const j = await r.json();
      expect(r.status).toBe(200);   // NOT the 502 an unguarded await produced
      expect(j.ok).toBe(true);
      expect(j.data.answer).toBe('42');
    });

    it('a THROWING mirror write does not fail an otherwise good run', async () => {
      runAgentAndInspect.mockResolvedValue({
        threadId: 't1', runId: 'r1', status: 'completed', answer: '42', steps: [],
      });
      extractAndStoreMemory.mockResolvedValue([{ fact: 'user prefers SQL' }] as any[]);
      writeAgentMemory.mockImplementation(async () => { throw new Error('write rejected'); });

      const { POST } = await import('@/app/api/foundry/agents/run/route');
      const r = await POST(jsonReq({ agent: 'finance', question: 'meaning of life?' }));
      const j = await r.json();
      expect(r.status).toBe(200);
      expect(j.data.answer).toBe('42');
      expect(writeAgentMemory).toHaveBeenCalled();
    });
  });
});
