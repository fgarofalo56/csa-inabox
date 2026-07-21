import { describe, it, expect } from 'vitest';
import {
  normalizeMeshAgent,
  builtinMeshAgents,
  defaultToolScope,
  tier0ToolCatalog,
  isTier0NativeKind,
  scopeMcpServersForAgent,
  classifyMeshEgress,
  meshInterAgentPolicy,
  buildA2AAgentCard,
  isMeshAgentRunnable,
  TIER0_NATIVE_TOOL_KINDS,
  type MeshAgentDef,
} from '../agent-registry';

const T = 'tenant-1';

function agent(over: Partial<MeshAgentDef>): MeshAgentDef {
  return {
    id: 'a1',
    tenantId: T,
    name: 'A',
    kind: 'custom',
    instructions: 'x',
    toolScope: ['knowledge-base'],
    mcpServerIds: [],
    egressProfile: 'commercial',
    publishA2A: false,
    ...over,
  };
}

describe('agent-registry — normalize', () => {
  it('rejects a nameless agent; fills defaults for a named one', () => {
    expect(normalizeMeshAgent({}, T)).toBeNull();
    const a = normalizeMeshAgent({ name: 'Gov', kind: 'governance' }, T)!;
    expect(a).not.toBeNull();
    expect(a.tenantId).toBe(T);
    expect(a.kind).toBe('governance');
    expect(a.toolScope.length).toBeGreaterThan(0); // default tool scope filled
    expect(a.egressProfile).toBe('commercial'); // default profile
    expect(a.instructions).toMatch(/governance/i);
  });

  it('drops unknown tool kinds + coerces bad profile/kind', () => {
    const a = normalizeMeshAgent(
      { name: 'X', kind: 'nope', egressProfile: 'weird', toolScope: ['warehouse', 'bogus', 'mcp'] },
      T,
    )!;
    expect(a.kind).toBe('custom');
    expect(a.egressProfile).toBe('commercial');
    expect(a.toolScope).toEqual(['warehouse', 'mcp']);
  });

  it('only binds itemType when an itemId is present', () => {
    expect(normalizeMeshAgent({ name: 'X', itemType: 'data-agent' }, T)!.itemType).toBeUndefined();
    const b = normalizeMeshAgent({ name: 'X', itemId: 'i1', itemType: 'data-agent' }, T)!;
    expect(b.itemType).toBe('data-agent');
  });
});

describe('agent-registry — seeds + catalog', () => {
  it('seeds the governance / pipeline / BI / orchestrator trio', () => {
    const seeded = builtinMeshAgents(T, 'gov');
    const kinds = seeded.map((a) => a.kind).sort();
    expect(kinds).toEqual(['bi', 'governance', 'orchestrator', 'pipeline']);
    expect(seeded.every((a) => a.egressProfile === 'gov')).toBe(true);
    expect(seeded.every((a) => a.builtin)).toBe(true);
    // governance/pipeline/bi publish to the A2A hub; orchestrator does not.
    expect(seeded.find((a) => a.kind === 'governance')!.publishA2A).toBe(true);
    expect(seeded.find((a) => a.kind === 'orchestrator')!.publishA2A).toBe(false);
  });

  it('tier0 catalog exposes only air-gap-safe native kinds + air-gap MCP servers', () => {
    const cat = tier0ToolCatalog(true);
    expect(cat.govAoaiDirect).toBe(true);
    expect(cat.nativeKinds).toEqual([...TIER0_NATIVE_TOOL_KINDS]);
    expect(cat.nativeKinds).not.toContain('bing-grounding');
    expect(cat.nativeKinds).not.toContain('openapi');
    expect(cat.mcpServers.every((s) => s.airGapSafe)).toBe(true);
    expect(cat.mcpServers.length).toBeGreaterThan(0);
    expect(isTier0NativeKind('warehouse')).toBe(true);
    expect(isTier0NativeKind('bing-grounding')).toBe(false);
  });

  it('default tool scopes are least-privilege per kind', () => {
    expect(defaultToolScope('governance')).toContain('ontology-object');
    expect(defaultToolScope('pipeline')).toContain('lakehouse');
    expect(defaultToolScope('bi')).toContain('warehouse');
  });
});

describe('agent-registry — per-agent MCP scoping', () => {
  const servers = [
    { name: 'Filesystem', catalogId: 'filesystem', endpoint: 'https://fs.internal' }, // air-gap-safe
    { name: 'Brave', catalogId: 'brave-search', endpoint: 'https://brave.example' }, // external
    { name: 'Ad-hoc', endpoint: 'https://x.example' }, // no catalogId
  ];

  it('intersects with the agent grant; empty grant → nothing', () => {
    const r = scopeMcpServersForAgent({ mcpServerIds: [], egressProfile: 'commercial' }, servers);
    expect(r.allowed).toHaveLength(0);
    const r2 = scopeMcpServersForAgent(
      { mcpServerIds: ['filesystem', 'brave-search'], egressProfile: 'commercial' },
      servers,
    );
    expect(r2.allowed.map((s) => s.catalogId)).toEqual(['filesystem', 'brave-search']);
  });

  it('air-gap agent drops non-air-gap-safe servers as blockedByProfile (honest gate)', () => {
    const r = scopeMcpServersForAgent(
      { mcpServerIds: ['filesystem', 'brave-search'], egressProfile: 'air-gap' },
      servers,
    );
    expect(r.allowed.map((s) => s.catalogId)).toEqual(['filesystem']);
    expect(r.blockedByProfile).toHaveLength(1);
    expect(r.blockedByProfile[0].server.catalogId).toBe('brave-search');
    expect(r.blockedByProfile[0].reason).toMatch(/air-gap-safe/i);
  });
});

describe('agent-registry — egress classification (fail-closed)', () => {
  it('commercial allows any host; air-gap fails closed unless allow-listed', () => {
    expect(classifyMeshEgress('commercial', 'api.example.com', []).allowed).toBe(true);
    // air-gap: nothing external unless allow-listed
    expect(classifyMeshEgress('air-gap', 'api.example.com', []).allowed).toBe(false);
    expect(classifyMeshEgress('air-gap', 'api.example.com', ['example.com']).allowed).toBe(true);
  });

  it('gov permits Azure Government hosts, refuses commercial-cloud hosts', () => {
    expect(classifyMeshEgress('gov', 'my.openai.azure.us', []).allowed).toBe(true);
    expect(classifyMeshEgress('gov', 'my.openai.azure.com', []).allowed).toBe(false);
    expect(classifyMeshEgress('gov', 'api.powerbi.com', []).allowed).toBe(false);
    // a non-gov external is refused unless allow-listed
    expect(classifyMeshEgress('gov', 'random.example.io', []).allowed).toBe(false);
    expect(classifyMeshEgress('gov', 'random.example.io', ['example.io']).allowed).toBe(true);
  });

  it('accepts a full URL and normalizes the host', () => {
    expect(classifyMeshEgress('air-gap', 'https://leak.example.com/path', []).allowed).toBe(false);
  });
});

describe('agent-registry — inter-agent structural policy', () => {
  const gov = agent({ id: 'g', kind: 'governance', publishA2A: true, egressProfile: 'air-gap' });
  const orch = agent({ id: 'o', kind: 'orchestrator', egressProfile: 'air-gap' });
  const commercialBi = agent({ id: 'b', kind: 'bi', egressProfile: 'commercial', publishA2A: true });

  it('allows a normal internal hop', () => {
    expect(meshInterAgentPolicy(orch, gov).effect).toBe('allow');
  });

  it('blocks external delegation to a non-published agent', () => {
    const priv = agent({ id: 'p', publishA2A: false });
    expect(meshInterAgentPolicy(orch, priv, { external: true }).effect).toBe('deny');
    expect(meshInterAgentPolicy(orch, gov, { external: true }).effect).toBe('allow');
  });

  it('blocks a boundary downgrade (air-gap → commercial)', () => {
    const d = meshInterAgentPolicy(orch, commercialBi);
    expect(d.effect).toBe('deny');
    expect(d.reason).toMatch(/downgrade/i);
  });
});

describe('agent-registry — A2A card', () => {
  it('builds a card with the agent url + a delegate skill', () => {
    const card = buildA2AAgentCard(agent({ id: 'g', name: 'Gov', kind: 'governance', egressProfile: 'gov' }), 'https://loom.example/');
    expect(card.name).toBe('Gov');
    expect(card.url).toBe('https://loom.example/api/mesh/a2a/g');
    expect(card.skills[0].id).toBe('delegate-governance');
    expect(card.loomEgressProfile).toBe('gov');
  });
  it('isMeshAgentRunnable true for governance/orchestrator even with no tools', () => {
    expect(isMeshAgentRunnable(agent({ kind: 'governance', toolScope: [] }))).toBe(true);
    expect(isMeshAgentRunnable(agent({ kind: 'custom', toolScope: [], itemId: undefined }))).toBe(false);
  });
});
