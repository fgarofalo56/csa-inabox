import { describe, it, expect } from 'vitest';
import {
  flowStateToConfig, flowGroundedSources, flowFoundryTools, flowCapabilityToolCount,
  flowTools, flowSubAgents, appendFlowRun, type AgentFlowState, type AgentFlowRun,
} from '../agent-flow-run';
import type { AgentTool } from '@/lib/copilot/agent-tool-catalog';

/** A flow with two item-bound data tools, one MCP tool, and one sub-agent. */
function sampleState(): AgentFlowState {
  const tools: AgentTool[] = [
    { id: 't1', kind: 'warehouse', itemId: 'wh-1', itemName: 'Sales WH' },
    { id: 't2', kind: 'kql', itemId: 'kql-1', itemName: 'Telemetry' },
    { id: 't3', kind: 'mcp', serverId: 'github', serverLabel: 'GitHub', serverUrl: 'https://mcp.example/github', allowedTools: ['search'] },
  ];
  return {
    instructions: 'You are an analyst.',
    tools,
    subAgents: [{ id: 's1', itemId: 'da-1', itemType: 'data-agent', name: 'Pricing agent', role: 'pricing' }],
    flowLayout: {},
  };
}

describe('agent-flow-run — FlowDag serialization', () => {
  it('flowTools / flowSubAgents normalize the persisted blobs', () => {
    const st = sampleState();
    expect(flowTools(st)).toHaveLength(3);
    expect(flowSubAgents(st)).toHaveLength(1);
    expect(flowTools(undefined)).toEqual([]);
    expect(flowSubAgents(undefined)).toEqual([]);
  });

  it('maps item-bound data-tool nodes to grounded DataAgentSources (the run grounding)', () => {
    const sources = flowGroundedSources(flowTools(sampleState()));
    expect(sources.map((s) => s.type).sort()).toEqual(['kql', 'warehouse']);
    const wh = sources.find((s) => s.id === 'wh-1');
    expect(wh).toMatchObject({ id: 'wh-1', type: 'warehouse', name: 'Sales WH' });
    // The MCP capability tool is NOT a grounding source.
    expect(sources.some((s) => s.id === undefined)).toBe(false);
    expect(sources).toHaveLength(2);
  });

  it('maps an ontology-object node to a grounded `ontology` source (WS-6)', () => {
    const tools: AgentTool[] = [
      { id: 'o1', kind: 'ontology-object', itemId: 'onto-1', itemName: 'Enterprise', objectType: 'Customer' },
      { id: 'o2', kind: 'ontology-object', itemId: 'onto-1', itemName: 'Enterprise', objectType: 'Order' },
      // an ontology-object without an object type is NOT grounded (needs both).
      { id: 'o3', kind: 'ontology-object', itemId: 'onto-1', itemName: 'Enterprise' },
    ];
    const sources = flowGroundedSources(tools);
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.type === 'ontology' && s.id === 'onto-1')).toBe(true);
    expect(sources.map((s) => s.tables).sort()).toEqual(['Customer', 'Order']);
  });

  it('flowStateToConfig carries instructions + grounded sources', () => {
    const cfg = flowStateToConfig(sampleState());
    expect(cfg.instructions).toBe('You are an analyst.');
    expect(cfg.sources).toHaveLength(2);
  });

  it('dedups repeated item-bound tools by itemId', () => {
    const tools: AgentTool[] = [
      { id: 'a', kind: 'lakehouse', itemId: 'lh-1', itemName: 'Lake' },
      { id: 'b', kind: 'lakehouse', itemId: 'lh-1', itemName: 'Lake dup' },
    ];
    expect(flowGroundedSources(tools)).toHaveLength(1);
  });

  it('serializes capability tools + connected sub-agents into Foundry tool defs', () => {
    const defs = flowFoundryTools(sampleState());
    // 1 MCP capability tool + 1 connected-agent def (data tools excluded).
    expect(defs.some((d) => d.type === 'mcp')).toBe(true);
    expect(defs.some((d) => d.type === 'connected_agent')).toBe(true);
    expect(flowCapabilityToolCount(sampleState())).toBe(1);
  });

  it('appendFlowRun keeps newest-first and caps at 50', () => {
    const mk = (i: number): AgentFlowRun => ({
      id: `r${i}`, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      question: `q${i}`, answer: 'a', status: 'succeeded', groundedSources: 0, capabilityTools: 0,
      subAgents: 0, delegated: false, durationMs: 1, startedBy: 'me',
    });
    let runs: AgentFlowRun[] = [];
    for (let i = 0; i < 55; i++) runs = appendFlowRun(runs, mk(i));
    expect(runs).toHaveLength(50);
    expect(runs[0].id).toBe('r54'); // newest first
  });
});
