/**
 * N11 — the offline GraphRAG community-summary builder + its pure layer.
 *
 * The pure community detection / title resolution / extractive fallback are
 * exercised directly. The builder is exercised with the REAL AGE store reads
 * mocked (no PG), the AOAI client mocked (no model), and Cosmos mocked — so we
 * assert the REAL wiring: what it reads, what it persists, the honest extractive
 * fallback when no model answers, the stale-build prune, and the audit row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  detectCommunities,
  extractiveCommunitySummary,
  vertexTitle,
} from '../graphrag-index-model';

const aoaiChat = vi.fn();
vi.mock('@/lib/azure/aoai-chat-client', () => ({ aoaiChat: (...a: any[]) => aoaiChat(...a) }));

const listObjects = vi.fn();
const listLinks = vi.fn();
const weaveGate = vi.fn(() => null as any);
vi.mock('@/lib/azure/weave-ontology-store', async () => {
  const actual = await vi.importActual<any>('@/lib/azure/weave-ontology-store');
  return {
    ...actual,
    listObjects: (...a: any[]) => listObjects(...a),
    listLinks: (...a: any[]) => listLinks(...a),
    weaveGate: () => weaveGate(),
  };
});

const upsert = vi.fn().mockResolvedValue({});
const fetchAll = vi.fn().mockResolvedValue({ resources: [] });
const del = vi.fn().mockResolvedValue({});
const auditCreate = vi.fn().mockResolvedValue({});
vi.mock('@/lib/azure/cosmos-client', () => ({
  graphRagIndexContainer: async () => ({
    items: { upsert: (...a: any[]) => upsert(...a), query: () => ({ fetchAll: () => fetchAll() }) },
    item: () => ({ delete: () => del() }),
  }),
  auditLogContainer: async () => ({ items: { create: (...a: any[]) => auditCreate(...a) } }),
}));
const emitAuditEvent = vi.fn();
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (...a: any[]) => emitAuditEvent(...a) }));

import { buildGraphRagIndex, summarizeCommunity, readOntologyGraph } from '../graphrag-index';

const NODES = [
  { id: '1', objectType: 'Customer', title: 'Contoso Ltd' },
  { id: '10', objectType: 'Order', title: 'SO-9001' },
  { id: '20', objectType: 'Product', title: 'Widget Pro' },
  // A second, disconnected cluster.
  { id: '2', objectType: 'Customer', title: 'Fabrikam Inc' },
  { id: '11', objectType: 'Order', title: 'SO-9002' },
  // An isolated instance (no edges).
  { id: '99', objectType: 'Product', title: 'Orphan Gadget' },
];
const EDGES = [
  { fromId: '1', toId: '10', linkType: 'PLACED' },
  { fromId: '10', toId: '20', linkType: 'CONTAINS' },
  { fromId: '2', toId: '11', linkType: 'PLACED' },
];

beforeEach(() => {
  aoaiChat.mockReset();
  listObjects.mockReset();
  listLinks.mockReset();
  weaveGate.mockReset().mockReturnValue(null);
  upsert.mockClear();
  fetchAll.mockReset().mockResolvedValue({ resources: [] });
  del.mockClear();
  auditCreate.mockClear();
  emitAuditEvent.mockClear();
});

describe('vertexTitle (pure)', () => {
  it('prefers the authored titleKey, then a conventional name-ish property', () => {
    const v = { id: '1', objectType: 'Customer', properties: { legalName: 'Contoso Ltd', name: 'Contoso' } };
    expect(vertexTitle(v, 'legalName')).toBe('Contoso Ltd');
    expect(vertexTitle(v)).toBe('Contoso');
  });
  it('falls back to <ObjectType>#<id> — never an empty label', () => {
    expect(vertexTitle({ id: '7', objectType: 'Order', properties: { total: 5 } })).toBe('Order#7');
  });
});

describe('detectCommunities (pure label propagation)', () => {
  it('finds the connected clusters and drops isolated instances', () => {
    const communities = detectCommunities(NODES, EDGES);
    expect(communities).toHaveLength(2);
    // Largest first; ids are deterministic (smallest member).
    expect(communities[0].communityId).toBe('c:1');
    expect(communities[0].memberIds).toEqual(['1', '10', '20']);
    expect(communities[0].objectTypes).toEqual(['Customer', 'Order', 'Product']);
    expect(communities[0].linkTypes).toEqual(['CONTAINS', 'PLACED']);
    expect(communities[1].memberIds).toEqual(['2', '11']);
    // The orphan has no relational story — it is not a community.
    expect(communities.flatMap((c) => c.memberIds)).not.toContain('99');
  });

  it('is deterministic (order-independent) across shuffled input', () => {
    const a = detectCommunities(NODES, EDGES);
    const b = detectCommunities([...NODES].reverse(), [...EDGES].reverse());
    expect(b.map((c) => c.communityId)).toEqual(a.map((c) => c.communityId));
    expect(b.map((c) => c.memberIds)).toEqual(a.map((c) => c.memberIds));
  });

  it('drops edges whose endpoints are not known vertices', () => {
    const communities = detectCommunities(NODES, [...EDGES, { fromId: '1', toId: '404', linkType: 'GHOST' }]);
    expect(communities[0].memberIds).not.toContain('404');
  });

  it('respects the community cap', () => {
    expect(detectCommunities(NODES, EDGES, { maxCommunities: 1 })).toHaveLength(1);
  });
});

describe('extractiveCommunitySummary (pure, honest fallback)', () => {
  it('is composed only from the real member/link data', () => {
    const [c] = detectCommunities(NODES, EDGES);
    const titles = new Map(NODES.map((n) => [n.id, n.title]));
    const s = extractiveCommunitySummary(c, titles);
    expect(s).toContain('3 instances');
    expect(s).toContain('Customer, Order, Product');
    expect(s).toContain('CONTAINS, PLACED');
    expect(s).toContain('Contoso Ltd');
  });
});

describe('summarizeCommunity — STANDARD tier, honest fallback', () => {
  it('summarizes on the STANDARD deployment (Gov-safe: no reasoning tier)', async () => {
    aoaiChat.mockResolvedValue('Contoso places orders that contain Widget Pro.');
    const [c] = detectCommunities(NODES, EDGES);
    const titles = new Map(NODES.map((n) => [n.id, n.title]));
    const out = await summarizeCommunity(c, titles, EDGES);
    expect(out).toMatchObject({ summary: 'Contoso places orders that contain Widget Pro.', modelGenerated: true });
    expect(aoaiChat.mock.calls[0][0]).toMatchObject({ tier: 'standard' });
  });

  it('falls back to the deterministic extractive summary when no model answers', async () => {
    aoaiChat.mockRejectedValue(new Error('no AOAI deployment'));
    const [c] = detectCommunities(NODES, EDGES);
    const titles = new Map(NODES.map((n) => [n.id, n.title]));
    const out = await summarizeCommunity(c, titles, EDGES);
    expect(out.modelGenerated).toBe(false);
    expect(out.summary).toContain('3 instances');
    expect(out.error).toMatch(/no AOAI deployment/);
  });
});

describe('readOntologyGraph', () => {
  it('reads every declared type off AGE and skips a never-instantiated label', async () => {
    listObjects.mockImplementation(async (t: string) => {
      if (t === 'Customer') return [{ id: '1', objectType: 'Customer', properties: { name: 'Contoso Ltd' } }];
      throw new Error('label does not exist');
    });
    listLinks.mockResolvedValue([{ fromId: '1', toId: '10', linkType: 'PLACED' }]);
    const { nodes, edges } = await readOntologyGraph(['Customer', 'Ghost']);
    expect(nodes).toEqual([{ id: '1', objectType: 'Customer', title: 'Contoso Ltd' }]);
    expect(edges).toEqual([{ fromId: '1', toId: '10', linkType: 'PLACED' }]);
  });
});

describe('buildGraphRagIndex', () => {
  it('surfaces the honest Weave gate instead of persisting anything', async () => {
    weaveGate.mockReturnValue({ missing: 'LOOM_WEAVE_PG_FQDN', detail: 'not set', remediation: 'deploy postgres-weave.bicep' });
    const res = await buildGraphRagIndex({ ontologyId: 'onto-1', objectTypes: ['Customer'] });
    expect(res.ok).toBe(false);
    expect(res.gate?.missing).toBe('LOOM_WEAVE_PG_FQDN');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('persists a summary per community, prunes stale builds, and writes the audit row', async () => {
    listObjects.mockImplementation(async (t: string) =>
      NODES.filter((n) => n.objectType === t).map((n) => ({ id: n.id, objectType: n.objectType, properties: { name: n.title } })),
    );
    listLinks.mockResolvedValue(EDGES);
    aoaiChat.mockResolvedValue('A cluster of buying activity.');
    fetchAll.mockResolvedValue({ resources: [{ id: 'community:c:old', ontologyId: 'onto-1' }] });

    const res = await buildGraphRagIndex({
      ontologyId: 'onto-1',
      objectTypes: ['Customer', 'Order', 'Product'],
      titleKeys: { Customer: 'name', Order: 'name', Product: 'name' },
      actor: { oid: 'oid-1', who: 'a@b.c', tenantId: 'tid' },
    });

    expect(res.ok).toBe(true);
    expect(res.nodesRead).toBe(NODES.length);
    expect(res.edgesRead).toBe(EDGES.length);
    expect(res.communities).toBe(2);
    expect(res.modelGenerated).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    const doc = upsert.mock.calls[0][0];
    expect(doc).toMatchObject({
      ontologyId: 'onto-1', docType: 'graphrag-community', schemaVersion: 1,
      communityId: 'c:1', summary: 'A cluster of buying activity.', modelGenerated: true, builtBy: 'oid-1',
    });
    expect(doc.id).toBe('community:c:1');
    // Stale docs from an older buildId are pruned.
    expect(res.pruned).toBe(1);
    expect(del).toHaveBeenCalledTimes(1);
    // AUDIT: privileged mutation writes _auditLog AND fans out.
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ kind: 'graphrag.index.build', target: 'onto-1', actorOid: 'oid-1' });
    expect(emitAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'graphrag.index.build' }));
  });

  it('records the honest note when no model answered (every summary extractive)', async () => {
    listObjects.mockImplementation(async (t: string) =>
      NODES.filter((n) => n.objectType === t).map((n) => ({ id: n.id, objectType: n.objectType, properties: { name: n.title } })),
    );
    listLinks.mockResolvedValue(EDGES);
    aoaiChat.mockRejectedValue(new Error('no AOAI deployment'));
    const res = await buildGraphRagIndex({ ontologyId: 'onto-1', objectTypes: ['Customer', 'Order', 'Product'] });
    expect(res.ok).toBe(true);
    expect(res.modelGenerated).toBe(0);
    expect(res.modelNote).toMatch(/extractive summary built from the real member\/link data/);
    expect(upsert.mock.calls[0][0].modelGenerated).toBe(false);
  });
});
