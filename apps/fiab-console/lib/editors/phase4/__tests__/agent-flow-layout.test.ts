import { describe, it, expect } from 'vitest';
import {
  buildFlowNodes, buildFlowEdges, nodePosition, parseNodeId, type LayoutMap,
} from '../agent-flow-layout';

describe('buildFlowNodes', () => {
  it('always leads with the orchestrator agent then sources, tools, sub-agents', () => {
    const nodes = buildFlowNodes({ sourceIds: ['s1'], toolIds: ['t1', 't2'], subAgentIds: ['a1'] });
    expect(nodes.map((n) => n.id)).toEqual(['agent', 'source:s1', 'tool:t1', 'tool:t2', 'subagent:a1']);
    expect(nodes[0].kind).toBe('agent');
    // sources + tools share the middle column and get sequential indices
    expect(nodes[1].indexInGroup).toBe(0);
    expect(nodes[2].indexInGroup).toBe(1);
    expect(nodes[3].indexInGroup).toBe(2);
    // sub-agents start their own index
    expect(nodes[4].indexInGroup).toBe(0);
  });
});

describe('buildFlowEdges', () => {
  it('wires every non-agent node from the agent', () => {
    const edges = buildFlowEdges(['agent', 'source:s1', 'tool:t1']);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.source === 'agent')).toBe(true);
    expect(edges.map((e) => e.target)).toEqual(['source:s1', 'tool:t1']);
  });
});

describe('nodePosition', () => {
  const saved: LayoutMap = { 'tool:t1': { x: 111, y: 222 } };
  it('prefers a saved position', () => {
    expect(nodePosition({ id: 'tool:t1', kind: 'tool', group: 1, indexInGroup: 0 }, saved)).toEqual({ x: 111, y: 222 });
  });
  it('auto-lays-out the agent on the left', () => {
    const p = nodePosition({ id: 'agent', kind: 'agent', group: 0, indexInGroup: 0 }, {});
    expect(p.x).toBeLessThan(100);
  });
  it('stacks middle-column nodes by index', () => {
    const a = nodePosition({ id: 'tool:x', kind: 'tool', group: 1, indexInGroup: 0 }, {});
    const b = nodePosition({ id: 'tool:y', kind: 'tool', group: 1, indexInGroup: 1 }, {});
    expect(b.y).toBeGreaterThan(a.y);
    expect(a.x).toBe(b.x);
  });
  it('places sub-agents in a column to the right of the middle', () => {
    const mid = nodePosition({ id: 'tool:x', kind: 'tool', group: 1, indexInGroup: 0 }, {});
    const sub = nodePosition({ id: 'subagent:a', kind: 'subagent', group: 2, indexInGroup: 0 }, {});
    expect(sub.x).toBeGreaterThan(mid.x);
  });
  it('ignores a non-finite saved position', () => {
    const p = nodePosition({ id: 'agent', kind: 'agent', group: 0, indexInGroup: 0 }, { agent: { x: NaN, y: 5 } });
    expect(Number.isFinite(p.x)).toBe(true);
  });
});

describe('parseNodeId', () => {
  it('round-trips node ids', () => {
    expect(parseNodeId('agent')).toEqual({ kind: 'agent', refId: '' });
    expect(parseNodeId('source:s1')).toEqual({ kind: 'source', refId: 's1' });
    expect(parseNodeId('tool:t-9')).toEqual({ kind: 'tool', refId: 't-9' });
    expect(parseNodeId('subagent:a1')).toEqual({ kind: 'subagent', refId: 'a1' });
  });
  it('preserves colons in the ref id', () => {
    expect(parseNodeId('tool:mcp:ms-learn:123')).toEqual({ kind: 'tool', refId: 'mcp:ms-learn:123' });
  });
});
