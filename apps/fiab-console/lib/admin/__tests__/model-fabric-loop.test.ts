import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above the module body, so everything they
// reference must be created inside vi.hoisted (also hoisted, runs first).
const h = vi.hoisted(() => {
  const evalRows = [
    { model: 'gpt-b', avgScore: 4.8, passRate: 0.9, results: Array.from({ length: 8 }, () => ({ score: 5 })), createdAt: '2026-07-20T02:00:00Z' },
    { model: 'gpt-a', avgScore: 3.0, passRate: 0.5, results: Array.from({ length: 8 }, () => ({ score: 3 })), createdAt: '2026-07-20T01:00:00Z' },
  ];
  const endpoint = {
    name: 'ep1', backend: 'aml', traffic: { blue: 60, green: 40 },
    deployments: [{ name: 'blue', model: 'gpt-a' }, { name: 'green', model: 'gpt-b' }],
  };
  return {
    evalRows,
    endpoint,
    setTrafficMock: vi.fn(async () => ({ name: 'ep1', backend: 'aml', traffic: {} })),
    applyEnvMock: vi.fn(async () => ({ ok: true, status: 200, changedCount: 1, changed: ['LOOM_AOAI_STRONG_DEPLOYMENT'], secretsChanged: [], rejected: [], platform: 'aca' })),
    auditCreate: vi.fn(async () => ({})),
    upsertMock: vi.fn(async (d: any) => ({ resource: d })),
  };
});

vi.mock('@/lib/azure/cosmos-client', () => ({
  modelFabricContainer: async () => ({
    item: () => ({ read: async () => ({ resource: null }) }),
    items: { upsert: h.upsertMock },
  }),
  auditLogContainer: async () => ({ items: { create: h.auditCreate } }),
  agentMemoryContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: h.evalRows }) }) } }),
  itemsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));
vi.mock('@/lib/azure/model-serving-client', () => ({
  servingConfigGate: () => null,
  listServingEndpoints: async () => [h.endpoint],
  getServingMetrics: async () => ({ available: false }),
  setServingTraffic: h.setTrafficMock,
}));
vi.mock('@/lib/admin/env-apply', () => ({ applyEnvChanges: h.applyEnvMock }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));
vi.mock('@/lib/foundry/model-tier-router', () => ({
  tierPolicyFromConfig: () => ({ enabled: true, tiers: {}, taskMap: {} }),
  reasoningTierConfigured: () => false,
}));
vi.mock('@/lib/perf/copilot-latency-tracker', () => ({ recentCopilotSloEvaluations: () => [] }));
vi.mock('@/lib/foundry/red-team', () => ({ summarizeRedTeam: () => ({ total: 0, refusalRate: 0, attackSuccessRate: 0 }) }));

import { runModelFabricLoop } from '@/lib/admin/model-fabric-loop';

const base = { tenantId: 't1', who: 'admin@x', actorOid: 'oid1', persist: false as const };

describe('WS-7 model-fabric-loop — actuator', () => {
  beforeEach(() => { h.setTrafficMock.mockClear(); h.applyEnvMock.mockClear(); h.auditCreate.mockClear(); });

  it('AUTO mode ACTUATES: applies the traffic-split for the eval winner', async () => {
    const res = await runModelFabricLoop({ ...base, mode: 'auto' });
    expect(res.ok).toBe(true);
    expect(res.endpoints).toHaveLength(1);
    const ep = res.endpoints[0];
    expect(ep.decision.changed).toBe(true);
    expect(ep.actuated).toBe(true);
    expect(h.setTrafficMock).toHaveBeenCalledTimes(1);
    const [name, traffic] = h.setTrafficMock.mock.calls[0] as [string, Record<string, number>];
    expect(name).toBe('ep1');
    expect(traffic.green).toBeGreaterThan(40);
    expect(Object.values(traffic).reduce((a, b) => a + b, 0)).toBe(100);
    expect(h.auditCreate).toHaveBeenCalled();
    expect(h.applyEnvMock).toHaveBeenCalled(); // reasoning-tier promotion also actuated
  });

  it('PROPOSE mode does NOT actuate: computes the change but calls no backend write', async () => {
    const res = await runModelFabricLoop({ ...base, mode: 'propose' });
    expect(res.ok).toBe(true);
    const ep = res.endpoints[0];
    expect(ep.decision.changed).toBe(true);
    expect(ep.actuated).toBe(false);
    expect(h.setTrafficMock).not.toHaveBeenCalled();
    expect(h.applyEnvMock).not.toHaveBeenCalled();
  });
});
