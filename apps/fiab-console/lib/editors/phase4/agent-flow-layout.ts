/**
 * agent-flow-layout — pure layout + node-model helpers for the multi-agent
 * workflow canvas (AIF-6). Kept framework-free so the layout math is unit
 * tested without React Flow / the Fluent bundle
 * (see __tests__/agent-flow-layout.test.ts).
 */

export interface XY { x: number; y: number }
export type LayoutMap = Record<string, XY>;

/** A logical node on the agent-flow canvas. */
export interface FlowNodeModel {
  id: string;
  kind: 'agent' | 'source' | 'tool' | 'subagent';
  /** Ordering group for auto-layout (sources, then tools, then sub-agents). */
  group: number;
  /** Position within its group column (0-based). */
  indexInGroup: number;
}

const AGENT_X = 40;
const COL_X = [400, 400, 720];   // sources+tools share the middle column, sub-agents right
const ROW_H = 130;
const TOP = 40;
const AGENT_Y = 220;

/**
 * Compute the position for a node: the saved layout wins; otherwise a tidy
 * auto-layout (agent on the left, data sources + capability tools stacked in the
 * middle column, connected sub-agents in the right column).
 */
export function nodePosition(node: FlowNodeModel, saved: LayoutMap): XY {
  const s = saved[node.id];
  if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return { x: s.x, y: s.y };
  if (node.kind === 'agent') return { x: AGENT_X, y: AGENT_Y };
  const colX = node.kind === 'subagent' ? COL_X[2] : COL_X[0];
  return { x: colX, y: TOP + node.indexInGroup * ROW_H };
}

/**
 * Build the ordered logical node list from the agent's parts. The orchestrator
 * agent is always first; sources, tools, and sub-agents follow in stable order.
 */
export function buildFlowNodes(parts: {
  sourceIds: string[];
  toolIds: string[];
  subAgentIds: string[];
}): FlowNodeModel[] {
  const nodes: FlowNodeModel[] = [{ id: 'agent', kind: 'agent', group: 0, indexInGroup: 0 }];
  let mid = 0;
  parts.sourceIds.forEach((id) => nodes.push({ id: `source:${id}`, kind: 'source', group: 1, indexInGroup: mid++ }));
  parts.toolIds.forEach((id) => nodes.push({ id: `tool:${id}`, kind: 'tool', group: 1, indexInGroup: mid++ }));
  parts.subAgentIds.forEach((id, i) => nodes.push({ id: `subagent:${id}`, kind: 'subagent', group: 2, indexInGroup: i }));
  return nodes;
}

/** Every non-agent node is wired from the orchestrator agent. */
export function buildFlowEdges(nodeIds: string[]): { id: string; source: string; target: string }[] {
  return nodeIds
    .filter((id) => id !== 'agent')
    .map((id) => ({ id: `e-agent-${id}`, source: 'agent', target: id }));
}

/** Parse a canvas node id back into its kind + underlying ref id. */
export function parseNodeId(nodeId: string): { kind: FlowNodeModel['kind']; refId: string } {
  if (nodeId === 'agent') return { kind: 'agent', refId: '' };
  const idx = nodeId.indexOf(':');
  const prefix = nodeId.slice(0, idx);
  const refId = nodeId.slice(idx + 1);
  const kind = prefix === 'source' ? 'source' : prefix === 'tool' ? 'tool' : 'subagent';
  return { kind, refId };
}
