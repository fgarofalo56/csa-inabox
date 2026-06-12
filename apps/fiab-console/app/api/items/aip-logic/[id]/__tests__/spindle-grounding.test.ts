/**
 * resolveSpindleGrounding — pure transform unit test.
 *
 * Asserts that a bound Weave ontology surface (classes + Lakehouse/Warehouse
 * data bindings) is turned into the typed DataAgentSource[] that grounds Spindle
 * logic/agents: one queryable source per data binding + one ontology source
 * describing the entity surface. loadOntologySurface (Cosmos) is mocked so the
 * test stays pure (no Azure dependency).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../_lib/palantir-crud', () => ({
  loadOntologySurface: vi.fn(),
}));

import { resolveSpindleGrounding } from '../_spindle-grounding';
import { loadOntologySurface } from '../../_lib/palantir-crud';

const mockSurface = loadOntologySurface as unknown as ReturnType<typeof vi.fn>;

describe('resolveSpindleGrounding', () => {
  beforeEach(() => { mockSurface.mockReset(); });

  it('returns empty grounding when no ontology is bound', async () => {
    const g = await resolveSpindleGrounding(undefined, 'tenant-1');
    expect(g.sources).toEqual([]);
    expect(g.surface).toBeNull();
    expect(g.entityTypes).toEqual([]);
    expect(mockSurface).not.toHaveBeenCalled();
  });

  it('returns empty grounding when the ontology cannot be loaded', async () => {
    mockSurface.mockResolvedValue(null);
    const g = await resolveSpindleGrounding('onto-x', 'tenant-1');
    expect(g.sources).toEqual([]);
    expect(g.surface).toBeNull();
  });

  it('builds a queryable source per data binding + an ontology source', async () => {
    mockSurface.mockResolvedValue({
      id: 'onto-1',
      displayName: 'Risk Ontology',
      workspaceId: 'ws-1',
      classes: [
        { name: 'Customer', description: 'A banking customer' },
        { name: 'Account' },
      ],
      links: [{ from: 'Account', to: 'Customer', kind: 'IS_A' }],
      bindings: [
        { sourceKind: 'warehouse', sourceItemId: 'wh-1', sourceDisplayName: 'RiskWarehouse', entityTypes: ['Customer', 'Account'] },
      ],
    });

    const g = await resolveSpindleGrounding('onto-1', 'tenant-1');
    expect(g.entityTypes).toEqual(['Customer', 'Account']);

    // Binding source (queryable via Synapse).
    const wh = g.sources.find((x) => x.type === 'warehouse');
    expect(wh).toBeDefined();
    expect(wh?.name).toBe('RiskWarehouse');
    expect(wh?.tables).toBe('Customer, Account');
    expect(wh?.instructions).toContain('Customer');

    // Ontology semantic-layer source.
    const onto = g.sources.find((x) => x.type === 'ontology');
    expect(onto).toBeDefined();
    expect(onto?.name).toBe('Risk Ontology');
    expect(onto?.instructions).toContain('IS_A');
  });

  it('still attaches an ontology source when no data is bound yet', async () => {
    mockSurface.mockResolvedValue({
      id: 'onto-2', displayName: 'Empty Onto', workspaceId: 'ws-1',
      classes: [{ name: 'Widget' }], links: [], bindings: [],
    });
    const g = await resolveSpindleGrounding('onto-2', 'tenant-1');
    expect(g.sources).toHaveLength(1);
    expect(g.sources[0].type).toBe('ontology');
  });
});
