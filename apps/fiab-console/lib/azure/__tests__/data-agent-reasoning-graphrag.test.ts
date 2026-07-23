/**
 * N11 — the reasoning loop routes a MULTI-HOP question through the GraphRAG
 * retriever and returns typed graph-path citations.
 *
 * Only the edges of the system are mocked: the grounded-chat backend, the raw
 * AOAI turn, the AGE `runCypher` wire, the Cosmos community index, and the
 * FLAG0 substrate. The REAL retriever (`ontology-graphrag`) runs, over a real
 * agtype fixture — so this proves the wiring end-to-end, not a stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../data-agent-client', () => ({ chatGrounded: vi.fn(), aoaiChatTurn: vi.fn() }));
vi.mock('../copilot-orchestrator', () => ({
  resolveAoaiTarget: vi.fn().mockResolvedValue({
    endpoint: 'https://acct.openai.azure.com', deployment: 'gpt-4o', apiVersion: '2024-10-21',
  }),
}));
vi.mock('../semantic-contract', () => ({
  evaluateContract: vi.fn().mockResolvedValue({ mode: 'none' }),
  matchMetric: vi.fn().mockResolvedValue(null),
}));

const runCypher = vi.fn();
vi.mock('@/lib/azure/weave-ontology-store', async () => {
  const actual = await vi.importActual<any>('@/lib/azure/weave-ontology-store');
  return { ...actual, runCypher: (...a: any[]) => runCypher(...a), weaveGate: () => null };
});
const summariesForVertices = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/azure/graphrag-index', () => ({
  summariesForVertices: (...a: any[]) => summariesForVertices(...a),
}));
const runtimeFlag = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/admin/runtime-flags', () => ({ runtimeFlag: (...a: any[]) => runtimeFlag(...a) }));

import { runReasoningAgent, reasoningReceiptExtras } from '../data-agent-reasoning';
import { chatGrounded, aoaiChatTurn } from '../data-agent-client';

const groundedMock = chatGrounded as unknown as ReturnType<typeof vi.fn>;
const aoaiMock = aoaiChatTurn as unknown as ReturnType<typeof vi.fn>;

const DECLARED = ['Customer', 'Order', 'Product'];
const CUSTOMERS = [
  '{"id":1,"label":"Customer","properties":{"name":"Contoso Ltd"}}::vertex',
  '{"id":2,"label":"Customer","properties":{"name":"Fabrikam Inc"}}::vertex',
];
const ORDERS = ['{"id":10,"label":"Order","properties":{"orderNumber":"SO-9001"}}::vertex'];
const PRODUCTS = ['{"id":20,"label":"Product","properties":{"name":"Widget Pro"}}::vertex'];

const cfg = {
  instructions: 'Route relational questions to the ontology.',
  sources: [
    { id: 'onto-1', type: 'ontology' as const, name: 'Enterprise Ontology' },
    { id: 's1', type: 'warehouse' as const, name: 'Sales WH' },
  ],
};

const PLAN_JSON = '```json\n{"plan":[{"step":1,"source":"Sales WH","subQuery":"revenue for Widget Pro"}]}\n```';
const VERIFY_JSON = '```json\n{"verdict":"pass","reason":"rows answer it","finalAnswer":"Widget Pro sold 4200."}\n```';

function wireAoai() {
  aoaiMock.mockImplementation(async (_t: any, messages: any[]) => {
    const sys = String(messages?.[0]?.content || '');
    if (/PLANNER/.test(sys)) return { content: PLAN_JSON, usage: {} };
    if (/VERIFIER/.test(sys)) return { content: VERIFY_JSON, usage: {} };
    return { content: '', usage: {} };
  });
}

function wireGraph() {
  runCypher.mockImplementation(async (stmt: string) => {
    if (/MATCH \(n:Customer\)/.test(stmt)) return { rows: CUSTOMERS.map((c) => [c]) };
    if (/MATCH \(n:Order\)/.test(stmt)) return { rows: ORDERS.map((c) => [c]) };
    if (/MATCH \(n:Product\)/.test(stmt)) return { rows: PRODUCTS.map((c) => [c]) };
    if (/id\(a\) = 1\b/.test(stmt)) return { rows: [['1', '"PLACED"', 'true', '10', '"Order"', ORDERS[0]]] };
    if (/id\(a\) = 10\b/.test(stmt)) return { rows: [['10', '"CONTAINS"', 'true', '20', '"Product"', PRODUCTS[0]]] };
    return { rows: [] };
  });
}

beforeEach(() => {
  groundedMock.mockReset();
  aoaiMock.mockReset();
  runCypher.mockReset();
  summariesForVertices.mockReset().mockResolvedValue([]);
  runtimeFlag.mockReset().mockResolvedValue(true);
  groundedMock.mockResolvedValue({
    answer: 'Widget Pro sold 4200.',
    raw: '',
    tools: [{ source: 'Sales WH', action: 'query', query: 'select 1', executed: true, rowCount: 1, columns: ['sku', 'rev'], rows: [['WGT-1', 4200]] }],
  });
});

const MULTI_HOP = 'Which products are related to customer "Contoso Ltd" through its orders?';
const graphCtx = {
  ontologyId: 'onto-1',
  objectTypes: DECLARED,
  titleKeys: { Customer: 'name', Order: 'orderNumber', Product: 'name' },
  enabled: true,
};

describe('runReasoningAgent — N11 GraphRAG grounding', () => {
  it('a multi-hop question yields typed GRAPH-PATH CITATIONS from the real graph', async () => {
    wireAoai();
    wireGraph();

    const out = await runReasoningAgent(cfg, [], MULTI_HOP, { tenantId: 'oid-1', graph: graphCtx });

    expect(out.graph?.used).toBe(true);
    expect(out.graph?.seeds.map((s) => s.title)).toEqual(['Contoso Ltd']);
    expect(out.graph?.paths.map((p) => p.text)).toEqual([
      'Contoso Ltd (Customer) —[PLACED]→ SO-9001 (Order)',
      'Contoso Ltd (Customer) —[PLACED]→ SO-9001 (Order) —[CONTAINS]→ Widget Pro (Product)',
    ]);
    expect(out.graph?.paths[1].hops).toBe(2);

    // The REAL graph facts were layered onto BOTH the planner and every
    // grounded execute step (not just recorded on the answer).
    const planSystem = String(aoaiMock.mock.calls[0][1][0].content);
    expect(planSystem).toContain('GRAPH GROUNDING');
    expect(planSystem).toContain('—[CONTAINS]→ Widget Pro (Product)');
    expect(String(groundedMock.mock.calls[0][0].instructions)).toContain('GRAPH GROUNDING');
  });

  it('feeds the graph-path citations into N10’s receipt assembler input', async () => {
    wireAoai();
    wireGraph();
    const out = await runReasoningAgent(cfg, [], MULTI_HOP, { tenantId: 'oid-1', graph: graphCtx });
    const extras = reasoningReceiptExtras(out);
    expect(extras.graphPathCitations).toHaveLength(2);
    expect(extras.graphPathCitations![1]).toMatchObject({
      hops: 2,
      links: ['PLACED', 'CONTAINS'],
      nodes: ['Contoso Ltd (Customer)', 'SO-9001 (Order)', 'Widget Pro (Product)'],
    });
    expect(extras.plausibility?.plausible).toBe(true);
  });

  it('attaches the precomputed community summary to the grounded context', async () => {
    wireAoai();
    wireGraph();
    summariesForVertices.mockResolvedValue([
      { communityId: 'c:1', summary: 'Contoso buys Widget Pro.', size: 3, memberIds: ['1', '10', '20'], objectTypes: [], modelGenerated: true },
    ]);
    const out = await runReasoningAgent(cfg, [], MULTI_HOP, { tenantId: 'oid-1', graph: graphCtx });
    expect(out.graph?.communities).toEqual([{ communityId: 'c:1', summary: 'Contoso buys Widget Pro.', size: 3 }]);
    expect(String(groundedMock.mock.calls[0][0].instructions)).toContain('Contoso buys Widget Pro.');
  });

  it('FLAG0: the n11 kill switch reverts the turn to pre-N11 grounding', async () => {
    wireAoai();
    wireGraph();
    runtimeFlag.mockResolvedValue(false);
    const out = await runReasoningAgent(cfg, [], MULTI_HOP, { tenantId: 'oid-1', graph: graphCtx });
    expect(out.graph).toBeUndefined();
    expect(runCypher).not.toHaveBeenCalled();
    expect(String(groundedMock.mock.calls[0][0].instructions)).not.toContain('GRAPH GROUNDING');
  });

  it('the per-agent toggle OFF skips retrieval entirely', async () => {
    wireAoai();
    wireGraph();
    const out = await runReasoningAgent(cfg, [], MULTI_HOP, {
      tenantId: 'oid-1', graph: { ...graphCtx, enabled: false },
    });
    expect(out.graph).toBeUndefined();
    expect(runCypher).not.toHaveBeenCalled();
  });

  it('a simple (non-relational) question does not spend a graph round-trip', async () => {
    wireAoai();
    wireGraph();
    const out = await runReasoningAgent(cfg, [], 'What was total revenue last quarter?', {
      tenantId: 'oid-1', graph: graphCtx,
    });
    expect(out.graph).toBeUndefined();
    expect(runCypher).not.toHaveBeenCalled();
  });

  it('an agent with no ontology binding is byte-identical to pre-N11', async () => {
    wireAoai();
    wireGraph();
    const out = await runReasoningAgent(
      { instructions: 'x', sources: [{ id: 's1', type: 'warehouse' as const, name: 'Sales WH' }] },
      [], MULTI_HOP, { tenantId: 'oid-1' },
    );
    expect(out.graph).toBeUndefined();
    expect(runCypher).not.toHaveBeenCalled();
  });
});
