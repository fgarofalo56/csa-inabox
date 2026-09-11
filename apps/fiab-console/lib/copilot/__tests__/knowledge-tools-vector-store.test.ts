/**
 * `vector_store_retrieve` — the Cosmos DB for MongoDB (vCore) RAG backend
 * registered by `registerKnowledgeTools` (#3351).
 *
 * WHY THIS FILE EXISTS. The review of #4396 measured that deleting the entire
 * `r.register({ name: 'vector_store_retrieve' … })` block left the `lib/copilot`
 * suite bit-identical — 46 files / 540 tests / rc=0 with the feature present and
 * with it deleted. So the suite was not a receipt for this tool at all: its name
 * appeared repo-wide only in the source and in three
 * `expect(msg).not.toMatch(/call vector_store_retrieve/i)` assertions in
 * knowledge-tools.test.ts, which assert its ABSENCE from a hint string and
 * nothing about the tool itself. NO branch of the handler had a test.
 *
 * Every branch of the handler is covered here, and each spec names the mutation
 * it kills:
 *   - registration + JSON-schema shape        (delete the register block)
 *   - cosmosVcoreGate() short-circuit         (drop the gate check)
 *   - required-argument validation            (drop the !coll || !q check)
 *   - embed throw reported as an EMBED failure (fall through to the search)
 *   - empty vector distinguished from an empty store (return grounded:true)
 *   - k clamped/floored/defaulted             (pass Number(k) straight through)
 *   - the embedded vector reaches vcoreVectorSearch (pass a fresh/empty vector)
 *   - CosmosVcoreDriverError reported as a DEPENDENCY gap with its .hint
 *                                             (fall into the generic catch-all)
 *   - a genuine cluster error still reported as a backend failure
 *
 * The AI Search module is mocked to "configured" so the vCore tool is exercised
 * in isolation; `cosmosVcoreGate` and `CosmosVcoreDriverError` are the REAL ones
 * (importOriginal), only `vcoreVectorSearch` and `aoaiEmbed` are doubled — the
 * two calls that would otherwise open a live cluster / AOAI connection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../azure/aisearch-knowledge', () => ({
  isSearchConfigured: () => true,
  knowledgeGovGate: () => null,
  listKnowledgeBases: async () => [],
  retrieveKnowledge: async () => ({
    answer: '', answerIsExtractive: true, partial: false, subqueries: [], citations: [],
  }),
}));

const embedMock = vi.fn();
vi.mock('../../azure/aoai-chat-client', () => ({
  aoaiEmbed: (...a: unknown[]) => embedMock(...a),
}));

const searchMock = vi.fn();
vi.mock('../../azure/cosmos-vcore-vector-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, vcoreVectorSearch: (...a: unknown[]) => searchMock(...a) };
});

import { registerKnowledgeTools } from '../knowledge-tools';
import { CosmosVcoreDriverError } from '../../azure/cosmos-vcore-vector-client';

const CONN = 'mongodb+srv://loom.invalid/?tls=true';

function collect() {
  const registered: any[] = [];
  registerKnowledgeTools({ register: (t: any) => registered.push(t) } as any);
  return registered;
}

function vectorTool() {
  const t = collect().find((x) => x.name === 'vector_store_retrieve');
  expect(t, 'vector_store_retrieve must be registered').toBeTruthy();
  return t;
}

let savedConn: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedConn = process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
  process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING = CONN;
  embedMock.mockResolvedValue({ vectors: [[0.1, 0.2, 0.3]] });
  searchMock.mockResolvedValue({ value: [] });
});

afterEach(() => {
  if (savedConn === undefined) delete process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
  else process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING = savedConn;
});

describe('vector_store_retrieve — registration', () => {
  it('is registered by registerKnowledgeTools with a valid JSON schema', () => {
    const tools = collect();
    expect(tools.map((t) => t.name)).toContain('vector_store_retrieve');

    const t = tools.find((x) => x.name === 'vector_store_retrieve');
    expect(t.service).toMatch(/Cosmos DB for MongoDB \(vCore\)/);
    expect(typeof t.handler).toBe('function');
    expect(t.parameters.type).toBe('object');
    expect(t.parameters.additionalProperties).toBe(false);
    expect(t.parameters.required).toEqual(['collection', 'query']);
    expect(Object.keys(t.parameters.properties).sort()).toEqual(['collection', 'k', 'query']);
    expect(t.parameters.properties.k).toEqual({ type: 'number' });
  });

  it('is registered UNCONDITIONALLY — present even with no connection string', () => {
    delete process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
    expect(collect().map((t) => t.name)).toContain('vector_store_retrieve');
  });
});

describe('vector_store_retrieve — honest gates before any backend call', () => {
  it('short-circuits on cosmosVcoreGate() and names the exact env var', async () => {
    delete process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
    const out: any = await vectorTool().handler({ collection: 'docs', query: 'why is X' });

    expect(out.grounded).toBe(false);
    expect(out.message).toContain('LOOM_COSMOS_VCORE_CONNECTION_STRING');
    expect(out.message).toMatch(/not configured in this deployment/i);
    // The gate's remediation hint is carried through, not swallowed.
    expect(out.message).toMatch(/Key Vault reference/i);
    // Nothing downstream may run once the gate fires.
    expect(embedMock).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['no collection', { query: 'q' }],
    ['no query', { collection: 'docs' }],
    ['blank collection', { collection: '   ', query: 'q' }],
    ['blank query', { collection: 'docs', query: '  ' }],
  ])('rejects %s without calling a backend', async (_label, args) => {
    const out: any = await vectorTool().handler(args as any);
    expect(out.grounded).toBe(false);
    expect(out.message).toBe('collection and query are both required.');
    expect(embedMock).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe('vector_store_retrieve — embedding branch', () => {
  it('reports an embed THROW as an embed failure and never runs a search', async () => {
    embedMock.mockRejectedValue(new Error('deployment "text-embedding-3-large" not found'));
    const out: any = await vectorTool().handler({ collection: 'docs', query: 'q' });

    expect(out.grounded).toBe(false);
    expect(out.message).toMatch(/Could not embed the query/i);
    expect(out.message).toContain('text-embedding-3-large');
    expect(out.message).toContain('LOOM_AOAI_EMBED_DEPLOYMENT');
    // An embed failure must NOT be dressed up as a search or backend failure.
    expect(out.message).not.toMatch(/vector search failed/i);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty vectors array', { vectors: [] }],
    ['a zero-length vector', { vectors: [[]] }],
    ['a null vector', { vectors: [null] }],
  ])('distinguishes %s from an empty knowledge store', async (_label, emb) => {
    embedMock.mockResolvedValue(emb as any);
    const out: any = await vectorTool().handler({ collection: 'docs', query: 'q' });

    expect(out.grounded).toBe(false);
    expect(out.message).toMatch(/embedding failure, not an empty knowledge store/i);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('passes the embedded vector — not the query text — to vcoreVectorSearch', async () => {
    embedMock.mockResolvedValue({ vectors: [[0.42, -0.7, 9]] });
    await vectorTool().handler({ collection: 'docs', query: 'why is X' });

    expect(embedMock).toHaveBeenCalledWith({ input: 'why is X' });
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock.mock.calls[0][0]).toMatchObject({
      collection: 'docs',
      vector: [0.42, -0.7, 9],
    });
  });
});

describe('vector_store_retrieve — k handling', () => {
  it.each([
    ['defaults to 5 when k is absent', undefined, 5],
    ['defaults to 5 when k is not a number', 'lots', 5],
    ['defaults to 5 when k is zero', 0, 5],
    ['defaults to 5 when k is negative', -3, 5],
    ['floors a fractional k', 7.9, 7],
    ['clamps k to 50', 5000, 50],
  ])('%s', async (_label, k, expected) => {
    await vectorTool().handler({ collection: 'docs', query: 'q', k } as any);
    expect(searchMock.mock.calls[0][0].k).toBe(expected);
  });
});

describe('vector_store_retrieve — the ready path returns real rows', () => {
  it('returns grounded rows from the live aggregation, trimming the arguments', async () => {
    searchMock.mockResolvedValue({
      value: [
        { id: 'doc-1', '@search.score': 0.91, content: 'alpha' },
        { id: 'doc-2', '@search.score': 0.77, content: 'beta' },
      ],
    });
    const out: any = await vectorTool().handler({ collection: '  docs  ', query: '  q  ', k: 2 });

    expect(searchMock).toHaveBeenCalledWith({ collection: 'docs', vector: [0.1, 0.2, 0.3], k: 2 });
    expect(out).toMatchObject({
      grounded: true,
      backend: 'cosmos-vcore',
      collection: 'docs',
      matches: 2,
    });
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ id: 'doc-1', content: 'alpha' });
  });

  it('an EMPTY result set is grounded with matches: 0, never a failure message', async () => {
    searchMock.mockResolvedValue({ value: [] });
    const out: any = await vectorTool().handler({ collection: 'docs', query: 'q' });

    expect(out.grounded).toBe(true);
    expect(out.matches).toBe(0);
    expect(out.results).toEqual([]);
    expect(out.message).toBeUndefined();
  });

  it('tolerates a result envelope with no value array', async () => {
    searchMock.mockResolvedValue({} as any);
    const out: any = await vectorTool().handler({ collection: 'docs', query: 'q' });
    expect(out.grounded).toBe(true);
    expect(out.matches).toBe(0);
  });
});

/**
 * R7 — the blocker this file's source change fixes.
 *
 * CosmosVcoreDriverError is the ONLY outcome reachable in the image that ships
 * today (`mongodb` is not a dependency of this app), so this branch IS the live
 * behaviour of the tool in every boundary. It previously fell into the generic
 * catch-all, which told the model "This is a backend failure, not an empty
 * result" — a cause the code had not established — and discarded the error's
 * `.hint`, the one-time remediation that makes this an honest gate.
 */
describe('vector_store_retrieve — failure classification (R7)', () => {
  it('reports the missing driver as a DEPENDENCY gap, not a backend failure', async () => {
    searchMock.mockRejectedValue(new CosmosVcoreDriverError());
    const out: any = await vectorTool().handler({ collection: 'docs', query: 'q' });

    expect(out.grounded).toBe(false);
    expect(out.driverMissing).toBe(true);
    // The false cause must be gone.
    expect(out.message).not.toMatch(/This is a backend failure/i);
    expect(out.message).not.toMatch(/vector search failed against/i);
    // …and the true one named.
    expect(out.message).toMatch(/No Cosmos DB vector search ran/i);
    expect(out.message).toMatch(/missing dependency, not a backend failure and not an empty result/i);
    expect(out.message).toContain('driver not available');
  });

  it('surfaces the driver error\'s remediation hint verbatim', async () => {
    const err = new CosmosVcoreDriverError();
    searchMock.mockRejectedValue(err);
    const out: any = await vectorTool().handler({ collection: 'docs', query: 'q' });

    expect(err.hint.length).toBeGreaterThan(0);
    expect(out.message).toContain(err.hint);
    // The specific things the hint carries — the one-time step and the live
    // alternative backends (ux-baseline G2: a gate must be actionable).
    expect(out.message).toContain('serverExternalPackages');
    expect(out.message).toContain('package.json');
    expect(out.message).toMatch(/ai-search \/ pgvector backend/i);
  });

  it('classifies by NAME too, so a second module instance cannot break instanceof', async () => {
    // What a bundler-duplicated copy of cosmos-vcore-vector-client throws: the
    // same shape, a different class identity. `instanceof` alone returns false.
    const foreign: any = Object.assign(new Error('Cosmos DB for MongoDB (vCore) driver not available'), {
      name: 'CosmosVcoreDriverError',
      status: 503,
      hint: 'add "mongodb" to package.json dependencies and redeploy',
    });
    expect(foreign instanceof CosmosVcoreDriverError).toBe(false);
    searchMock.mockRejectedValue(foreign);

    const out: any = await vectorTool().handler({ collection: 'docs', query: 'q' });
    expect(out.driverMissing).toBe(true);
    expect(out.message).not.toMatch(/This is a backend failure/i);
    expect(out.message).toContain('add "mongodb" to package.json dependencies and redeploy');
  });

  it('still reports a genuine CLUSTER error as a backend failure', async () => {
    searchMock.mockRejectedValue(new Error('server selection timed out after 15000 ms'));
    const out: any = await vectorTool().handler({ collection: 'docs', query: 'q' });

    expect(out.grounded).toBe(false);
    expect(out.driverMissing).toBeUndefined();
    expect(out.message).toContain('The Cosmos DB vector search failed against collection "docs"');
    expect(out.message).toContain('server selection timed out after 15000 ms');
    expect(out.message).toMatch(/This is a backend failure, not an empty result/);
  });

  it('a driver error and a cluster error do not read the same', async () => {
    searchMock.mockRejectedValue(new CosmosVcoreDriverError());
    const driverMsg = String((await vectorTool().handler({ collection: 'docs', query: 'q' })).message);
    searchMock.mockRejectedValue(new Error('connection refused'));
    const clusterMsg = String((await vectorTool().handler({ collection: 'docs', query: 'q' })).message);

    expect(driverMsg).not.toBe(clusterMsg);
    expect(/backend failure, not an empty result/.test(driverMsg)).toBe(false);
    expect(/backend failure, not an empty result/.test(clusterMsg)).toBe(true);
  });
});
