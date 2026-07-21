import { describe, it, expect, vi } from 'vitest';
import { runMeshTask, type MeshDeps, type MeshToolCall } from '../agent-mesh';
import { classifyMeshEgress, type MeshAgentDef } from '@/lib/copilot/agent-registry';

const T = 'tenant-1';
function agent(id: string, kind: MeshAgentDef['kind'], over: Partial<MeshAgentDef> = {}): MeshAgentDef {
  return {
    id,
    tenantId: T,
    name: id,
    kind,
    instructions: `you are ${id}`,
    toolScope: ['knowledge-base'],
    mcpServerIds: [],
    egressProfile: 'commercial',
    publishA2A: true,
    ...over,
  };
}

/** A deps builder with an allow-all authorize, a canned runAgent, and a spy audit. */
function makeDeps(over: Partial<MeshDeps> = {}): { deps: MeshDeps; audit: ReturnType<typeof vi.fn> } {
  const audit = vi.fn(async () => {});
  const deps: MeshDeps = {
    authorize: async () => ({ effect: 'allow', reason: 'ok', source: 'test' }),
    runAgent: async (a) => ({ answer: `${a.name} answered`, toolCalls: [] }),
    audit,
    now: () => '2026-07-20T00:00:00.000Z',
    ...over,
  };
  return { deps, audit };
}

describe('agent-mesh — runMeshTask (governed multi-agent)', () => {
  it('3-agent task completes: governance + pipeline + BI all participate and the lead synthesizes', async () => {
    const agents = [
      agent('orchestrator', 'orchestrator'),
      agent('governance', 'governance'),
      agent('pipeline', 'pipeline'),
      agent('bi', 'bi'),
    ];
    const { deps, audit } = makeDeps();
    const r = await runMeshTask(agents, 'produce a governed dataset summary', deps);

    expect(r.completed).toBe(true);
    expect(r.finalAnswer).toContain('orchestrator answered');
    // 3 members delegated + the lead's own synthesis step = 4 steps.
    const delegated = r.steps.filter((s) => s.status === 'delegated');
    expect(delegated.map((s) => s.agentName).sort()).toEqual(['bi', 'governance', 'orchestrator', 'pipeline']);
    // one policy check per member hop (3), all allowed.
    expect(r.policyChecks).toHaveLength(3);
    expect(r.policyDenied).toBe(0);
    // audited: 3 delegation hops + 1 synthesize row.
    expect(audit).toHaveBeenCalledTimes(4);
  });

  it('blocks an UNAUTHORIZED inter-agent call: the denied member never runs and is recorded', async () => {
    const agents = [agent('orchestrator', 'orchestrator'), agent('governance', 'governance'), agent('pipeline', 'pipeline')];
    const runAgent = vi.fn(async (a: MeshAgentDef) => ({ answer: `${a.name} ran`, toolCalls: [] as MeshToolCall[] }));
    const { deps } = makeDeps({
      // Deny the hop to the pipeline agent only.
      authorize: async (_caller, callee) =>
        callee.id === 'pipeline'
          ? { effect: 'deny' as const, reason: 'policy: pipeline not permitted', source: 'pdp' }
          : { effect: 'allow' as const, reason: 'ok' },
      runAgent,
    });
    const r = await runMeshTask(agents, 'task', deps);

    expect(r.policyDenied).toBe(1);
    const blocked = r.steps.find((s) => s.agentId === 'pipeline')!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.gate).toMatch(/policy: pipeline not permitted/);
    // the pipeline agent's runAgent was NEVER invoked (governance + lead only).
    const ranIds = runAgent.mock.calls.map((c) => c[0].id);
    expect(ranIds).not.toContain('pipeline');
    expect(ranIds).toContain('governance');
  });

  it('fails CLOSED when the policy check throws (unavailable PDP denies the hop)', async () => {
    const agents = [agent('orchestrator', 'orchestrator'), agent('governance', 'governance')];
    const { deps } = makeDeps({
      authorize: async () => {
        throw new Error('pdp down');
      },
    });
    const r = await runMeshTask(agents, 'task', deps);
    expect(r.policyDenied).toBe(1);
    expect(r.steps.find((s) => s.agentId === 'governance')!.status).toBe('blocked');
  });

  it('air-gap profile blocks egress: an external tool call is refused (nothing leaves the boundary)', async () => {
    const agents = [
      agent('orchestrator', 'orchestrator', { egressProfile: 'air-gap' }),
      agent('bi', 'bi', { egressProfile: 'air-gap' }),
    ];
    // runAgent enforces egress with the REAL classifier — an air-gap agent trying
    // to reach an external host is refused (fail-closed), recorded as egressBlocked.
    const runAgent = async (a: MeshAgentDef) => {
      const decision = classifyMeshEgress(a.egressProfile, 'api.external-saas.com', []);
      const toolCalls: MeshToolCall[] = [
        {
          agentId: a.id,
          kind: 'mcp:external-saas',
          executed: decision.allowed,
          egressBlocked: decision.allowed ? undefined : true,
          egressReason: decision.allowed ? undefined : decision.reason,
        },
      ];
      return { answer: `${a.name} answered in-VNet`, toolCalls };
    };
    const { deps } = makeDeps({ runAgent });
    const r = await runMeshTask(agents, 'task', deps);

    expect(r.completed).toBe(true); // still answers, in-VNet
    expect(r.egressBlocked).toBeGreaterThanOrEqual(1);
    const biStep = r.steps.find((s) => s.agentId === 'bi')!;
    expect(biStep.toolCalls[0].egressBlocked).toBe(true);
    expect(biStep.toolCalls[0].egressReason).toMatch(/air-gap/i);
    expect(biStep.toolCalls[0].executed).toBe(false);
  });

  it('runs the lead alone (still governed) when there are no members', async () => {
    const { deps } = makeDeps();
    const r = await runMeshTask([agent('solo', 'governance')], 'task', deps);
    expect(r.completed).toBe(true);
    expect(r.policyChecks).toHaveLength(0);
    expect(r.finalAnswer).toContain('solo answered');
  });
});
