/**
 * B-N14b — policy-graph model + GraphRAG retrieval tests.
 *
 * Pure: no Cosmos, no AOAI. Asserts the retriever REUSES the N11 primitives over
 * a policy graph and produces citable, refusable results.
 */
import { describe, it, expect } from 'vitest';
import {
  PolicyGraphBuilder,
  buildAdjacency,
  indexNodes,
  policyNodeAsWeaveObject,
} from '@/lib/governance/policy-graph';
import { retrievePolicyContext, POLICY_CONTEXT_LABELS } from '@/lib/governance/policy-graphrag';
import { classificationsFor, regionsIn } from '@/lib/governance/policy-graph-load';
import { buildGovernanceSystemPrompt, REFUSAL_MARKER } from '@/lib/governance/nl-governance-copilot';

/** A small but REAL-SHAPED policy graph: Alice → Reader → Orders → email → PII, in EU. */
function sampleGraph() {
  const b = new PolicyGraphBuilder();
  b.node('principal:alice', 'principal', 'alice@contoso.com', { objectId: 'alice', principalType: 'User' });
  b.node('grant:g1', 'grant', 'Storage Blob Data Reader', { role: 'Storage Blob Data Reader', permission: 'read', state: 'active' });
  b.node('asset:orders', 'asset', 'Orders', { resourceRef: 'orders', resourceType: 'item' });
  b.node('field:orders.email', 'field', 'Orders.email', { column: 'email', classification: 'PII' });
  b.node('classification:MICROSOFT.PERSONAL.EMAIL', 'classification', 'Email', { qualifiedName: 'MICROSOFT.PERSONAL.EMAIL', family: 'pii' });
  b.node('region:eu', 'region', 'European Union (EU)', { code: 'eu' });
  b.edge('principal:alice', 'HOLDS', 'grant:g1');
  b.edge('grant:g1', 'GRANTS', 'asset:orders');
  b.edge('asset:orders', 'HAS_FIELD', 'field:orders.email');
  b.edge('field:orders.email', 'CLASSIFIED_AS', 'classification:MICROSOFT.PERSONAL.EMAIL');
  b.edge('asset:orders', 'LOCATED_IN', 'region:eu');
  return b.build();
}

describe('PolicyGraphBuilder', () => {
  it('de-duplicates nodes and edges and drops edges with a missing endpoint', () => {
    const b = new PolicyGraphBuilder();
    b.node('asset:a', 'asset', 'A', { x: 'one' });
    b.node('asset:a', 'asset', 'A', { y: 'two' });
    b.node('asset:b', 'asset', 'B');
    b.edge('asset:a', 'DERIVED_FROM', 'asset:b');
    b.edge('asset:a', 'DERIVED_FROM', 'asset:b');
    b.edge('asset:a', 'DERIVED_FROM', 'asset:missing');
    const g = b.build();
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === 'asset:a')!.properties).toMatchObject({ x: 'one', y: 'two' });
  });

  it('drops empty property values so the seed scorer never matches on noise', () => {
    const b = new PolicyGraphBuilder();
    b.node('asset:a', 'asset', 'A', { keep: 'yes', drop: '', nope: null });
    const props = b.build().nodes[0].properties;
    expect(props).toHaveProperty('keep');
    expect(props).not.toHaveProperty('drop');
    expect(props).not.toHaveProperty('nope');
  });

  it('indexes adjacency in BOTH directions with the real edge direction kept', () => {
    const adj = buildAdjacency(sampleGraph());
    expect(adj.get('principal:alice')).toEqual([{ to: 'grant:g1', type: 'HOLDS', direction: 'out' }]);
    expect(adj.get('grant:g1')).toEqual(
      expect.arrayContaining([{ to: 'principal:alice', type: 'HOLDS', direction: 'in' }]),
    );
    expect(indexNodes(sampleGraph()).get('asset:orders')!.title).toBe('Orders');
  });

  it('adapts a node to the WeaveObject shape the reused N11 scorer consumes', () => {
    const g = sampleGraph();
    const wo = policyNodeAsWeaveObject(g.nodes.find((n) => n.id === 'asset:orders')!);
    expect(wo).toEqual({ id: 'asset:orders', objectType: 'asset', properties: { resourceRef: 'orders', resourceType: 'item', title: 'Orders' } });
  });
});

describe('retrievePolicyContext', () => {
  it('walks principal → grant → asset → field → classification and cites the path', () => {
    const r = retrievePolicyContext({ question: 'who can read PII in EU?', graph: sampleGraph() });
    expect(r.ok).toBe(true);
    expect(r.paths.length).toBeGreaterThan(0);
    const joined = r.paths.map((p) => p.text).join(' | ');
    // A citation must name real nodes AND the real edge label.
    expect(joined).toContain('alice@contoso.com (principal)');
    expect(joined).toMatch(/HOLDS|GRANTS|CLASSIFIED_AS|LOCATED_IN|HAS_FIELD/);
    expect(r.kindsTouched).toEqual(expect.arrayContaining(['principal', 'grant', 'asset']));
  });

  it('renders the grounding block with the GOVERNANCE labels (reused N11 renderer)', () => {
    const r = retrievePolicyContext({ question: 'who can read PII in EU?', graph: sampleGraph() });
    expect(r.contextText).toContain(POLICY_CONTEXT_LABELS.heading);
    expect(r.contextText).toContain('REFUSE to guess');
    r.paths.forEach((p, i) => expect(r.contextText).toContain(`${i + 1}. ${p.text}`));
  });

  it('refuses (not ok) when nothing in the graph matches the question', () => {
    const r = retrievePolicyContext({ question: 'quarterly widget revenue forecast', graph: sampleGraph() });
    expect(r.ok).toBe(false);
    expect(r.paths).toHaveLength(0);
    expect(r.note).toMatch(/matched|no entity|named no/i);
  });

  it('refuses on an empty graph rather than answering from nothing', () => {
    const r = retrievePolicyContext({ question: 'who can read PII?', graph: { nodes: [], edges: [], sources: { assignments: 0, workspaceRoles: 0, policies: 0, contracts: 0, items: 0, classifications: 0 } } });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/empty/i);
  });

  it('reports zero paths when matched entities are not connected', () => {
    const b = new PolicyGraphBuilder();
    b.node('classification:X', 'classification', 'Email', { qualifiedName: 'MICROSOFT.PERSONAL.EMAIL', family: 'pii' });
    b.node('region:eu', 'region', 'European Union (EU)', { code: 'eu' });
    const r = retrievePolicyContext({ question: 'is Email data held in the European Union?', graph: b.build() });
    expect(r.paths).toHaveLength(0);
    expect(r.note).toMatch(/no edge connects/i);
  });

  it('honours the hop bound', () => {
    const r = retrievePolicyContext({ question: 'who can read PII in EU?', graph: sampleGraph(), maxHops: 1 });
    expect(r.hops).toBe(1);
    for (const p of r.paths) expect(p.hops).toBeLessThanOrEqual(1);
  });
});

describe('classification + region derivation', () => {
  it('maps an exact Purview qualified name', () => {
    expect(classificationsFor('MICROSOFT.PERSONAL.EMAIL').map((c) => c.name)).toEqual(['MICROSOFT.PERSONAL.EMAIL']);
  });

  it('expands an operator-typed family alias to the built-in group', () => {
    const pii = classificationsFor('PII');
    expect(pii.length).toBeGreaterThan(1);
    expect(pii.every((c) => c.group === 'pii')).toBe(true);
    expect(classificationsFor('phi').every((c) => c.group === 'health')).toBe(true);
  });

  it('returns nothing for an unmapped label rather than guessing', () => {
    expect(classificationsFor('internal-use-only')).toEqual([]);
    expect(classificationsFor('')).toEqual([]);
  });

  it('derives regions only from text that actually names them', () => {
    expect(regionsIn(['EU customer data']).map((r) => r.id)).toEqual(['eu']);
    expect(regionsIn(['unlabelled dataset'])).toEqual([]);
    expect(regionsIn([undefined, ''])).toEqual([]);
  });
});

describe('buildGovernanceSystemPrompt', () => {
  it('puts refuse-not-guess first and carries the refusal marker + context', () => {
    const p = buildGovernanceSystemPrompt('## CONTEXT\n1. a -> b', false);
    expect(p).toContain(REFUSAL_MARKER);
    expect(p.indexOf('NEVER guess')).toBeLessThan(p.indexOf('Cite the numbered path'));
    expect(p).toContain('## CONTEXT');
  });

  it('discloses a partial read when a silo could not be loaded', () => {
    expect(buildGovernanceSystemPrompt('ctx', true)).toMatch(/could not be read/i);
    expect(buildGovernanceSystemPrompt('ctx', false)).not.toMatch(/could not be read/i);
  });
});
