import { describe, it, expect } from 'vitest';
import {
  deriveEdges,
  topoOrderNodes,
  validatePlan,
  planDiff,
  compilePlanFromCanvas,
  type EstatePlan,
  type EstatePlanNode,
} from '../estate-plan-model';

/** A realistic acceptance-chain plan: lakehouse/warehouse → promote → report → API → agent. */
function chainPlan(): EstatePlan {
  const nodes: EstatePlanNode[] = [
    { id: 'a', op: 'create', itemType: 'lakehouse', title: 'Sales Lakehouse' },
    { id: 'w', op: 'create', itemType: 'warehouse', title: 'Sales Warehouse' },
    { id: 'b', op: 'weave', itemType: 'notebook', title: 'Silver promotion', action: 'promote-medallion', fromNodeId: 'a', values: { targetLayer: 'silver' } },
    { id: 'c', op: 'weave', itemType: 'report', title: 'Sales report', action: 'build-loom-report', fromNodeId: 'a', values: { sourceMode: 'table' } },
    { id: 'd', op: 'weave', itemType: 'data-api-builder', title: 'Sales API', action: 'publish-as-api', fromNodeId: 'w', values: { sourceMode: 'table' } },
    { id: 'e', op: 'weave', itemType: 'data-agent', title: 'Sales agent', action: 'add-data-agent-source', fromNodeId: 'a', values: {} },
  ];
  return { id: 'p1', nodes, edges: deriveEdges(nodes), title: 'Sales estate' };
}

describe('deriveEdges', () => {
  it('builds one edge per weave node whose fromNodeId resolves', () => {
    const edges = deriveEdges(chainPlan().nodes);
    expect(edges).toHaveLength(4);
    // The API weaves from the warehouse; the rest from the lakehouse.
    expect(edges.filter((e) => e.from === 'a')).toHaveLength(3);
    expect(edges.filter((e) => e.from === 'w')).toHaveLength(1);
    expect(edges.map((e) => e.action)).toContain('promote-medallion');
  });
  it('drops edges to a missing source node', () => {
    const edges = deriveEdges([
      { id: 'x', op: 'weave', itemType: 'report', title: 'r', action: 'build-loom-report', fromNodeId: 'ghost' },
    ]);
    expect(edges).toHaveLength(0);
  });
});

describe('topoOrderNodes', () => {
  it('orders every source before the nodes that weave from it', () => {
    const { order, cycle } = topoOrderNodes(chainPlan());
    expect(cycle).toBe(false);
    expect(order[0]).toBe('a');
    for (const dep of ['b', 'c', 'd', 'e']) {
      expect(order.indexOf('a')).toBeLessThan(order.indexOf(dep));
    }
  });
  it('flags a dependency cycle without throwing', () => {
    const nodes: EstatePlanNode[] = [
      { id: 'x', op: 'weave', itemType: 'report', title: 'x', action: 'build-loom-report', fromNodeId: 'y' },
      { id: 'y', op: 'weave', itemType: 'report', title: 'y', action: 'build-loom-report', fromNodeId: 'x' },
    ];
    const { cycle, order } = topoOrderNodes({ id: 'p', nodes, edges: [] });
    expect(cycle).toBe(true);
    expect(order).toHaveLength(2);
  });
});

describe('validatePlan', () => {
  it('accepts a well-formed chain', () => {
    const v = validatePlan(chainPlan());
    expect(v.ok).toBe(true);
    expect(v.issues.filter((i) => i.level === 'error')).toHaveLength(0);
  });
  it('rejects an unknown Weave action', () => {
    const p = chainPlan();
    p.nodes.find((n) => n.id === 'b')!.action = 'not-a-real-bridge';
    const v = validatePlan(p);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => /Unknown Weave action/.test(i.message))).toBe(true);
  });
  it('rejects a bridge run from an incompatible source type', () => {
    // promote-medallion only runs from a lakehouse; point it at a report source.
    const nodes: EstatePlanNode[] = [
      { id: 'a', op: 'create', itemType: 'report', title: 'r' },
      { id: 'b', op: 'weave', itemType: 'notebook', title: 'n', action: 'promote-medallion', fromNodeId: 'a' },
    ];
    const v = validatePlan({ id: 'p', nodes, edges: [] });
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => /cannot run from/.test(i.message))).toBe(true);
  });
  it('rejects an empty plan', () => {
    expect(validatePlan({ id: 'p', nodes: [], edges: [] }).ok).toBe(false);
  });
});

describe('planDiff', () => {
  it('produces an ordered create-then-weave dry-run diff', () => {
    const diff = planDiff(chainPlan());
    expect(diff.createCount).toBe(2);
    expect(diff.weaveCount).toBe(4);
    expect(diff.ops[0].op).toBe('create');
    expect(diff.ops[0].title).toBe('Sales Lakehouse');
    // weave ops carry the bridge label + upstream title.
    const promote = diff.ops.find((o) => o.action === 'promote-medallion')!;
    expect(promote.actionLabel).toBeTruthy();
    expect(promote.fromTitle).toBe('Sales Lakehouse');
    expect(diff.summary).toMatch(/Creates 2 items/);
  });
});

describe('compilePlanFromCanvas', () => {
  it('roots become create nodes; nodes with an incoming edge become weave nodes', () => {
    const plan = compilePlanFromCanvas(
      [
        { id: 'n1', itemType: 'lakehouse', title: 'LH' },
        { id: 'n2', itemType: 'report', title: 'Rpt', values: { sourceMode: 'table' } },
      ],
      [{ from: 'n1', to: 'n2', action: 'build-loom-report' }],
      { title: 'Canvas estate' },
    );
    const n1 = plan.nodes.find((n) => n.id === 'n1')!;
    const n2 = plan.nodes.find((n) => n.id === 'n2')!;
    expect(n1.op).toBe('create');
    expect(n2.op).toBe('weave');
    expect(n2.action).toBe('build-loom-report');
    expect(n2.fromNodeId).toBe('n1');
    expect(n2.values).toEqual({ sourceMode: 'table' });
    // The compiled plan validates + diffs like any planner-emitted plan.
    expect(validatePlan(plan).ok).toBe(true);
    expect(planDiff(plan).weaveCount).toBe(1);
  });
});
