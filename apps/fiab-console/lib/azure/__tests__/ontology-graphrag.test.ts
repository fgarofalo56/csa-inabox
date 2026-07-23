/**
 * N11 — GraphRAG retriever over the authored Weave/AGE ontology.
 *
 * `runCypher` is mocked (no PG I/O) so we exercise the REAL retrieval logic
 * against a small REAL-SHAPED ontology fixture (Customer -PLACED-> Order
 * -CONTAINS-> Product, agtype vertices exactly as Apache AGE returns them):
 * seed extraction, the JS-side predicate filter (the AGE gotcha), multi-hop
 * Cypher assembly, path citations, and the community-summary join.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runCypher = vi.fn();
vi.mock('@/lib/azure/weave-ontology-store', async () => {
  const actual = await vi.importActual<any>('@/lib/azure/weave-ontology-store');
  return {
    ...actual,
    runCypher: (...a: any[]) => runCypher(...a),
    // The AGE backend is wired in these tests; runCypher is what we control.
    weaveGate: () => null,
  };
});
const summariesForVertices = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/azure/graphrag-index', () => ({
  summariesForVertices: (...a: any[]) => summariesForVertices(...a),
}));

import {
  extractSeedTerms,
  scoreSeedObject,
  filterSeedObjects,
  assembleHopCypher,
  parseHopRows,
  renderPathText,
  isMultiHopQuestion,
  retrieveGraphContext,
  graphRagMaxHops,
} from '../ontology-graphrag';

// ── A small REAL ontology fixture (agtype exactly as AGE emits it) ───────────
const DECLARED = ['Customer', 'Order', 'Product'];

const CUSTOMERS = [
  '{"id":1,"label":"Customer","properties":{"name":"Contoso Ltd","segment":"Enterprise"}}::vertex',
  '{"id":2,"label":"Customer","properties":{"name":"Fabrikam Inc","segment":"SMB"}}::vertex',
];
const ORDERS = [
  '{"id":10,"label":"Order","properties":{"orderNumber":"SO-9001","total":4200}}::vertex',
];
const PRODUCTS = [
  '{"id":20,"label":"Product","properties":{"name":"Widget Pro","sku":"WGT-1"}}::vertex',
];

/** Route the mocked runCypher by the statement AGE would receive. */
function wireGraph(opts: { failHop2?: boolean } = {}) {
  runCypher.mockImplementation(async (stmt: string) => {
    if (/MATCH \(n:Customer\)/.test(stmt)) return { rows: CUSTOMERS.map((c) => [c]) };
    if (/MATCH \(n:Order\)/.test(stmt)) return { rows: ORDERS.map((c) => [c]) };
    if (/MATCH \(n:Product\)/.test(stmt)) return { rows: PRODUCTS.map((c) => [c]) };
    // Hop expansion — keyed on which frontier id it asks for.
    if (/id\(a\) = 1\b/.test(stmt)) {
      return { rows: [['1', '"PLACED"', 'true', '10', '"Order"', ORDERS[0]]] };
    }
    if (/id\(a\) = 10\b/.test(stmt)) {
      if (opts.failHop2) throw new Error('AGE unreachable');
      return { rows: [['10', '"CONTAINS"', 'true', '20', '"Product"', PRODUCTS[0]]] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  runCypher.mockReset();
  summariesForVertices.mockReset();
  summariesForVertices.mockResolvedValue([]);
  delete process.env.LOOM_GRAPHRAG_MAX_HOPS;
});

describe('seed extraction (pure)', () => {
  it('names the declared object types the question references (singular/plural)', () => {
    const { typeHints } = extractSeedTerms('Which products did Contoso order?', DECLARED);
    expect(typeHints).toContain('Product');
  });

  it('drops schema words from the entity terms so they cannot match every instance', () => {
    const { terms } = extractSeedTerms('Which products relate to Contoso?', DECLARED);
    expect(terms).toContain('contoso');
    expect(terms).not.toContain('products');
    expect(terms).not.toContain('product');
  });

  it('captures quoted literal entity names as high-signal phrases', () => {
    const { phrases } = extractSeedTerms('How is "Contoso Ltd" connected to Fabrikam?', DECLARED);
    expect(phrases).toEqual(['Contoso Ltd']);
  });

  it('splits CamelCase / snake_case api names into words for matching', () => {
    const { typeHints } = extractSeedTerms('list the purchase orders', ['PurchaseOrder']);
    expect(typeHints).toEqual(['PurchaseOrder']);
  });
});

describe('JS-side predicate filter (AGE gotcha)', () => {
  const contoso = { properties: { name: 'Contoso Ltd', segment: 'Enterprise', _internal: 'contoso-secret' } };

  it('matches a term against any non-internal string property, case-insensitively', () => {
    const { score, matchedOn } = scoreSeedObject(contoso, ['contoso'], []);
    expect(score).toBeGreaterThan(0);
    expect(matchedOn).toEqual(['contoso']);
  });

  it('ignores internal (_-prefixed) properties', () => {
    const { score } = scoreSeedObject(contoso, ['secret'], []);
    expect(score).toBe(0);
  });

  it('treats a quoted phrase hit as decisive', () => {
    const { score, matchedOn } = scoreSeedObject(contoso, ['unrelated'], ['Contoso Ltd']);
    expect(score).toBe(1);
    expect(matchedOn).toEqual(['Contoso Ltd']);
  });

  it('ranks + caps real instances into seeds, using the authored titleKey', () => {
    const objs = [
      { id: '1', objectType: 'Customer', properties: { name: 'Contoso Ltd' } },
      { id: '2', objectType: 'Customer', properties: { name: 'Fabrikam Inc' } },
    ];
    const seeds = filterSeedObjects(objs as any, ['contoso'], [], { Customer: 'name' }, 5);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ id: '1', objectType: 'Customer', title: 'Contoso Ltd' });
  });
});

describe('multi-hop Cypher assembly (pure)', () => {
  it('expands a whole frontier in ONE statement with id() equality only', () => {
    const stmt = assembleHopCypher(['1', '10'], 200);
    expect(stmt).toContain('id(a) = 1 OR id(a) = 10');
    expect(stmt).toContain('RETURN id(a) AS aid');
    expect(stmt).toContain('LIMIT 200');
    // The AGE gotcha: NO variable-length paths, NO IN [...], NO property WHERE.
    expect(stmt).not.toMatch(/\[\*/);
    expect(stmt).not.toContain(' IN [');
    expect(stmt).not.toMatch(/WHERE\s+\w+\.\w+/);
  });

  it('drops non-numeric ids (cypher-injection guard) and returns "" for none', () => {
    expect(assembleHopCypher(['1; DROP GRAPH'], 50)).toBe('');
    expect(assembleHopCypher([], 50)).toBe('');
    expect(assembleHopCypher(['7', 'x'], 50)).toContain('id(a) = 7');
    expect(assembleHopCypher(['7', 'x'], 50)).not.toContain('x');
  });

  it('parses agtype hop rows into typed edges + titled neighbours', () => {
    const edges = parseHopRows(
      [['1', '"PLACED"', 'true', '10', '"Order"', ORDERS[0]]],
      { Order: 'orderNumber' },
    );
    expect(edges).toEqual([
      {
        fromId: '1', toId: '10', linkType: 'PLACED', direction: 'out',
        neighbor: { id: '10', objectType: 'Order', title: 'SO-9001' },
      },
    ]);
  });

  it('renders directional path text', () => {
    const text = renderPathText(
      [
        { id: '1', objectType: 'Customer', title: 'Contoso Ltd' },
        { id: '10', objectType: 'Order', title: 'SO-9001' },
      ],
      ['PLACED'],
      ['out'],
    );
    expect(text).toBe('Contoso Ltd (Customer) —[PLACED]→ SO-9001 (Order)');
  });
});

describe('isMultiHopQuestion', () => {
  it('flags relational questions and passes on simple lookups', () => {
    expect(isMultiHopQuestion('Which products are related to Contoso through its orders?')).toBe(true);
    expect(isMultiHopQuestion('What is the total revenue?')).toBe(false);
  });
});

describe('graphRagMaxHops (code default, clamped)', () => {
  it('defaults to 2 and clamps a wild value', () => {
    expect(graphRagMaxHops()).toBe(2);
    process.env.LOOM_GRAPHRAG_MAX_HOPS = '99';
    expect(graphRagMaxHops()).toBe(4);
    process.env.LOOM_GRAPHRAG_MAX_HOPS = 'nonsense';
    expect(graphRagMaxHops()).toBe(2);
  });
});

describe('retrieveGraphContext — end-to-end over the fixture graph', () => {
  it('seeds, traverses 2 hops, and returns typed graph-path citations', async () => {
    wireGraph();
    const ctx = await retrieveGraphContext({
      question: 'Which products are related to customer "Contoso Ltd" through its orders?',
      objectTypes: DECLARED,
      titleKeys: { Customer: 'name', Order: 'orderNumber', Product: 'name' },
      maxHops: 2,
    });

    expect(ctx.ok).toBe(true);
    expect(ctx.seeds.map((s) => s.title)).toEqual(['Contoso Ltd']);
    // Both hops discovered: Customer → Order → Product.
    expect(ctx.paths.map((p) => p.text)).toEqual([
      'Contoso Ltd (Customer) —[PLACED]→ SO-9001 (Order)',
      'Contoso Ltd (Customer) —[PLACED]→ SO-9001 (Order) —[CONTAINS]→ Widget Pro (Product)',
    ]);
    expect(ctx.paths[1].hops).toBe(2);
    expect(ctx.paths[1].links).toEqual(['PLACED', 'CONTAINS']);
    expect(ctx.vertexIds).toEqual(expect.arrayContaining(['1', '10', '20']));
    // The unmatched customer is never carried into the traversal.
    expect(ctx.vertexIds).not.toContain('2');
    // Grounded context names the real entities + paths (never invented).
    expect(ctx.contextText).toContain('GRAPH GROUNDING');
    expect(ctx.contextText).toContain('Contoso Ltd (Customer, id 1)');
    expect(ctx.contextText).toContain('—[CONTAINS]→ Widget Pro (Product)');
  });

  it('attaches precomputed community summaries and tags the terminal node', async () => {
    wireGraph();
    summariesForVertices.mockResolvedValue([
      {
        communityId: 'c:1', summary: 'Contoso orders Widget Pro repeatedly.', size: 3,
        objectTypes: ['Customer', 'Order', 'Product'], memberIds: ['1', '10', '20'], modelGenerated: true,
      },
    ]);
    const ctx = await retrieveGraphContext({
      question: 'How is "Contoso Ltd" connected to products through orders?',
      objectTypes: DECLARED,
      ontologyId: 'onto-1',
      maxHops: 2,
    });
    expect(summariesForVertices).toHaveBeenCalledWith('onto-1', expect.arrayContaining(['1', '10', '20']), 4);
    expect(ctx.communities[0]).toMatchObject({ communityId: 'c:1', overlap: 3 });
    expect(ctx.paths.every((p) => p.communityId === 'c:1')).toBe(true);
    expect(ctx.contextText).toContain('Contoso orders Widget Pro repeatedly.');
  });

  it('degrades to the depth already reached when a hop is unreachable', async () => {
    wireGraph({ failHop2: true });
    const ctx = await retrieveGraphContext({
      question: 'Which products are related to "Contoso Ltd" through its orders?',
      objectTypes: DECLARED,
      maxHops: 2,
    });
    expect(ctx.ok).toBe(true);
    expect(ctx.paths).toHaveLength(1);
    expect(ctx.paths[0].hops).toBe(1);
  });

  it('returns an honest note (never a mock) when nothing matches', async () => {
    wireGraph();
    const ctx = await retrieveGraphContext({
      question: 'How is "Northwind Traders" connected to products?',
      objectTypes: DECLARED,
      maxHops: 2,
    });
    expect(ctx.ok).toBe(false);
    expect(ctx.paths).toEqual([]);
    expect(ctx.note).toMatch(/matched the question's entity terms/);
    expect(ctx.contextText).toBe('');
  });

  it('widens past the named types when the entity was named without its type', async () => {
    wireGraph();
    const ctx = await retrieveGraphContext({
      // Names no object type at all — the retriever must still find Contoso.
      question: 'How is "Contoso Ltd" connected downstream?',
      objectTypes: DECLARED,
      maxHops: 1,
    });
    expect(ctx.ok).toBe(true);
    expect(ctx.seeds[0].title).toBe('Contoso Ltd');
  });
});
